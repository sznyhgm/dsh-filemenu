/**
 * dsh-filemenu — Host half (DSH profile plugin).
 *
 * Loaded as a composition row from `cordis.patch.yml` (`name: dsh-filemenu`
 * resolves to this package's `main`). This half registers one HTTP RPC endpoint
 * on the `webServer` service; the browser half calls it with `fetch()`.
 *
 *   POST /dsh-filemenu/rpc   body: { "action": string, "args": object }
 *   returns                  JSON: { "ok": boolean, ... }
 *
 * Actions: hello | open | reveal | openWith | editors | url
 *
 * Two host capabilities do the real work:
 *
 *   sessionController.openPath / revealPath / canOpenWorkspacePath
 *     The official native-opener seam. `canOpenWorkspacePath()` is the only
 *     honest answer to "may this deployment hand a path to a desktop?", so the
 *     client asks for it instead of guessing from the page URL.
 *
 *   subprocess.spawn({ argv, cwd, stdio, graceMs })
 *     The official managed-process seam (the same one `dsh-host-open-in-app`
 *     uses). `cwd` is REQUIRED by SubprocessSpawnSpec — omitting it makes the
 *     provider throw before any process starts, which reads as "ok:true but
 *     nothing happened" to a caller that swallows the error.
 */

import { pathToFileURL } from 'node:url'

export const name = 'dsh-filemenu'

// The RPC endpoint lives on webServer. Declaring the injection parks this
// plugin until that service exists; without it the row applies at boot before
// the web server is up and silently registers nothing.
export const inject = ['webServer']

const IS_WINDOWS = process.platform === 'win32'
const SPAWN_GRACE_MS = 5000

function dirnameOf(abs) {
  const at = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
  return at <= 0 ? '' : abs.slice(0, at)
}

/** Editors we are willing to detect and launch, in menu order. */
const EDITOR_SPECS = [
  { id: 'vscode', name: 'Visual Studio Code', commands: ['code'], exeNames: ['Code.exe'], installs: ['C:\\Program Files\\Microsoft VS Code\\Code.exe', 'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe'] },
  { id: 'cursor', name: 'Cursor', commands: ['cursor'], exeNames: ['Cursor.exe'], installs: [] },
  { id: 'windsurf', name: 'Windsurf', commands: ['windsurf'], exeNames: ['Windsurf.exe'], installs: [] },
  { id: 'vscodium', name: 'VSCodium', commands: ['codium'], exeNames: ['codium.exe', 'VSCodium.exe'], installs: [] },
  { id: 'sublime', name: 'Sublime Text', commands: ['subl'], exeNames: ['sublime_text.exe'], installs: ['C:\\Program Files\\Sublime Text\\sublime_text.exe'] },
  { id: 'notepadpp', name: 'Notepad++', commands: [], exeNames: [], installs: ['C:\\Program Files\\Notepad++\\notepad++.exe', 'C:\\Program Files (x86)\\Notepad++\\notepad++.exe'] },
  { id: 'typora', name: 'Typora', commands: ['typora'], exeNames: ['Typora.exe'], installs: ['C:\\Program Files\\Typora\\Typora.exe', 'C:\\Program Files (x86)\\Typora\\Typora.exe'] },
  { id: 'zed', name: 'Zed', commands: ['zed'], exeNames: ['Zed.exe', 'zed.exe'], installs: ['C:\\Program Files\\Zed\\Zed.exe'] },
  { id: 'neovim', name: 'Neovim', commands: ['nvim'], exeNames: [], installs: [] },
  { id: 'vim', name: 'Vim', commands: ['vim'], exeNames: [], installs: [] },
  { id: 'gedit', name: 'gedit', commands: ['gedit'], exeNames: [], installs: [] }
]

/**
 * Resolve one editor to a launchable executable.
 *
 * A PATH hit is often a shell shim (`code.CMD` on Windows), which a shell-free
 * spawn cannot run; in that case the shim's install directory is probed for the
 * real GUI executable. Returns undefined when nothing usable was found.
 */
async function resolveEditor(fs, subprocess, spec) {
  for (const cmd of spec.commands) {
    let resolved
    try {
      resolved = await subprocess.resolveExecutable(cmd)
    } catch {
      continue
    }
    if (typeof resolved !== 'string' || resolved === '') continue
    if (/\.exe$/i.test(resolved)) return resolved
    if (/\.(cmd|bat)$/i.test(resolved)) {
      const installDir = resolved.replace(/[\\/]bin[\\/][^\\/]+$/, '')
      if (installDir !== resolved) {
        for (const exe of spec.exeNames) {
          const candidate = installDir + '\\' + exe
          try {
            if ((await fs.lstat(candidate)) !== undefined) return candidate
          } catch { /* try the next candidate */ }
        }
      }
    }
  }
  for (const abs of spec.installs) {
    try {
      if ((await fs.lstat(abs)) !== undefined) return abs
    } catch { /* try the next candidate */ }
  }
  return undefined
}

export function apply(ctx) {
  const fsService = () => ctx.get('fs')
  const subprocessService = () => ctx.get('subprocess')
  const controllerService = () => ctx.get('sessionController')
  let editorsCache

  const readPathArg = (args) => {
    if (args === null || typeof args !== 'object') return '.'
    return typeof args.path === 'string' && args.path.trim() !== '' ? args.path : '.'
  }

  const readCwdArg = (args, sessionId) => {
    if (args !== null && typeof args === 'object' && typeof args.cwd === 'string' && args.cwd !== '') return args.cwd
    if (typeof sessionId === 'string' && sessionId !== '') {
      const sessions = ctx.get('sessions')
      const session = sessions === undefined ? undefined : sessions.get(sessionId)
      const header = session === undefined ? undefined : session.header
      if (header !== undefined && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
    }
    return undefined
  }

  /** Resolve a (possibly relative) user path to an absolute host path. */
  const resolveAbs = async (path, cwd) => {
    const fs = fsService()
    if (fs === undefined) throw new Error('fs service unavailable')
    const target = await fs.resolve(path, cwd === undefined ? {} : { cwd })
    return { abs: fs.processPath(target), target }
  }

  /**
   * Start one managed child process and forget about it.
   *
   * `cwd` is part of the spec, not an option: the provider validates it before
   * creating a handle, so passing a path that does not exist — or omitting it —
   * fails synchronously. Ignored stdio keeps the child independent of this
   * request's lifetime.
   */
  const spawnDetached = (argv, cwd) => {
    const subprocess = subprocessService()
    if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
      return { ok: false, error: 'subprocess service unavailable' }
    }
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: cwd === undefined || cwd === '' ? process.cwd() : cwd,
        stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
        graceMs: SPAWN_GRACE_MS
      })
      if (handle !== undefined && handle.done !== undefined && typeof handle.done.catch === 'function') handle.done.catch(() => {})
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const getEditors = async () => {
    if (editorsCache !== undefined) return editorsCache
    const fs = fsService()
    const subprocess = subprocessService()
    if (fs === undefined || subprocess === undefined || typeof subprocess.resolveExecutable !== 'function') {
      return []
    }
    const found = []
    for (const spec of EDITOR_SPECS) {
      let command
      try {
        command = await resolveEditor(fs, subprocess, spec)
      } catch {
        command = undefined
      }
      if (command !== undefined) found.push({ id: spec.id, name: spec.name, command })
    }
    editorsCache = found
    return found
  }

  const actions = {
    /**
     * Capability handshake. The client uses `canOpen` to decide whether the
     * native-action items are enabled at all — the deployment, not the page
     * origin, owns that answer.
     */
    hello: async () => {
      const controller = controllerService()
      const subprocess = subprocessService()
      // The spawn seam alone can already open a path, so it is the floor; the
      // controller's own answer overrides it when the service is present.
      let canOpen = subprocess !== undefined && typeof subprocess.spawn === 'function'
      let desktop
      if (controller !== undefined) {
        if (typeof controller.canOpenWorkspacePath === 'function') {
          try { canOpen = controller.canOpenWorkspacePath() === true } catch { /* keep the spawn floor */ }
        } else if (typeof controller.canOpenPath === 'function') {
          try { canOpen = controller.canOpenPath() === true } catch { /* keep the spawn floor */ }
        }
        if (typeof controller.workspaceDesktop === 'function') {
          try {
            const value = controller.workspaceDesktop()
            if (value !== undefined && value !== null) {
              desktop = { name: value.name, available: value.available, fileManager: value.fileManager }
            }
          } catch { desktop = undefined }
        }
      }
      return { ok: true, canOpen, desktop, platform: process.platform }
    },

    /** Open a path with the OS default application. */
    open: async (args) => {
      const raw = readPathArg(args)
      const cwd = readCwdArg(args, args === null || typeof args !== 'object' ? undefined : args.sessionId)
      const { abs } = await resolveAbs(raw, cwd)
      const controller = controllerService()
      if (controller !== undefined && typeof controller.openPath === 'function') {
        await controller.openPath(abs, new AbortController().signal)
        return { ok: true, path: abs }
      }
      // Degrade to the OS shell's open verb (explorer resolves the association).
      const launched = spawnDetached(IS_WINDOWS ? ['explorer.exe', abs] : ['xdg-open', abs], dirnameOf(abs))
      return launched.ok ? { ok: true, path: abs } : { ok: false, error: launched.error }
    },

    /**
     * Reveal a file in the OS file manager, or open the containing directory
     * when the path itself no longer exists.
     */
    reveal: async (args) => {
      const fs = fsService()
      if (fs === undefined) throw new Error('fs service unavailable')
      const raw = readPathArg(args)
      const cwd = readCwdArg(args, args === null || typeof args !== 'object' ? undefined : args.sessionId)
      const { abs, target } = await resolveAbs(raw, cwd)

      let revealAbs = abs
      let isDirectory = false
      try {
        const info = await fs.stat(target)
        if (info === undefined) {
          const parent = dirnameOf(abs)
          if (parent === '') return { ok: false, error: 'cannot reveal "' + abs + '"' }
          revealAbs = parent
          isDirectory = true
        } else {
          try {
            await fs.listDir(target)
            isDirectory = true
          } catch {
            isDirectory = false
          }
        }
      } catch {
        // An unreadable target is treated as a file inside a revealable directory.
      }

      if (IS_WINDOWS) {
        const argv = isDirectory
          ? ['explorer.exe', revealAbs]
          : ['explorer.exe', '/select,', pathToFileURL(revealAbs, { windows: true }).href.replaceAll(',', '%2C')]
        const launched = spawnDetached(argv, isDirectory ? revealAbs : dirnameOf(revealAbs))
        if (launched.ok) return { ok: true, path: revealAbs }
        return { ok: false, error: launched.error }
      }

      const controller = controllerService()
      if (controller !== undefined && typeof controller.revealPath === 'function') {
        await controller.revealPath(revealAbs, new AbortController().signal)
        return { ok: true, path: revealAbs }
      }
      const argv = process.platform === 'darwin'
        ? (isDirectory ? ['open', revealAbs] : ['open', '-R', revealAbs])
        : ['xdg-open', isDirectory ? revealAbs : dirnameOf(revealAbs)]
      const launched = spawnDetached(argv, isDirectory ? revealAbs : dirnameOf(revealAbs))
      return launched.ok ? { ok: true, path: revealAbs } : { ok: false, error: launched.error }
    },

    /** Editors that can be launched directly, for the submenu. */
    editors: async () => ({ ok: true, platform: IS_WINDOWS ? 'windows' : process.platform, editors: await getEditors() }),

    /** Open a path in one detected editor. */
    openWith: async (args) => {
      if (args === null || typeof args !== 'object' || typeof args.editorId !== 'string' || args.editorId === '') {
        return { ok: false, error: 'editorId is required' }
      }
      const raw = readPathArg(args)
      const cwd = readCwdArg(args, args.sessionId)
      const { abs } = await resolveAbs(raw, cwd)
      const editor = (await getEditors()).find((entry) => entry.id === args.editorId)
      if (editor === undefined) return { ok: false, error: 'editor not found: ' + args.editorId }
      const launched = spawnDetached([editor.command, abs], dirnameOf(abs))
      return launched.ok ? { ok: true, path: abs, editor: editor.id } : { ok: false, error: launched.error }
    },

    /** Open an http(s) URL in the default browser. */
    url: async (args) => {
      const url = args !== null && typeof args === 'object' && typeof args.url === 'string' ? args.url.trim() : ''
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) urls are allowed' }
      if (IS_WINDOWS) {
        const launched = spawnDetached(['rundll32.exe', 'url.dll,FileProtocolHandler', url], undefined)
        return launched.ok ? { ok: true, url } : { ok: false, error: launched.error }
      }
      const argv = process.platform === 'darwin' ? ['open', url] : ['xdg-open', url]
      const launched = spawnDetached(argv, undefined)
      return launched.ok ? { ok: true, url } : { ok: false, error: launched.error }
    }
  }

  const dispatch = async (action, args) => {
    const fn = actions[action]
    if (typeof fn !== 'function') return { ok: false, error: 'unknown action: ' + String(action) }
    try {
      return await fn(args === undefined || args === null ? {} : args)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    console.error('[dsh-filemenu] webServer service unavailable; RPC endpoint not registered')
    return
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-filemenu/rpc',
    handler: async (req, res) => {
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(value))
      }
      if (req.method !== 'POST') {
        send(405, { ok: false, error: 'use POST' })
        return
      }
      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw === '' ? {} : JSON.parse(raw)
        const action = typeof body.action === 'string' ? body.action : ''
        send(200, await dispatch(action, body.args))
      } catch (error) {
        send(400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }), 'dsh-filemenu: rpc route')
}
