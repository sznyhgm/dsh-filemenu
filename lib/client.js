/**
 * DshFileMenu — persistent Client half (web plugin bundle).
 *
 * Standard DSH web plugin bundle: `window.__ModuleLoader__.load({ id, factory })`.
 * The bundle is served at `/plugins/dsh-filemenu/client.js`, discovered through
 * the package's `exports["./client"]` and `dsh.client` declaration.
 *
 * Differences from the dynamic quick-install copy in `plugin/client.js`:
 *   - React is obtained via `require("react")` (module table), not a global;
 *   - the menu stylesheet is injected manually, not via the `styles` builtin;
 *   - Host RPC uses `fetch("/dsh-filemenu/rpc")` (see `lib/index.js`) instead
 *     of the dynamic-only `host.call`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-filemenu',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    function joinPath(cwd, path) {
      if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return path
      if (cwd === undefined || cwd === '') return path
      return String(cwd).replace(/[\\/]+$/, '') + '/' + String(path).replace(/^[\\/]+/, '')
    }

    function normalizeAbs(path) {
      const isWin = /^[A-Za-z]:[\\/]/.test(path)
      const rooted = path.startsWith('/') || isWin || path.startsWith('\\\\')
      const parts = path.split(/[\\/]+/)
      const out = []
      for (const part of parts) {
        if (part === '' || part === '.') continue
        if (part === '..') {
          if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
          else if (!rooted) out.push('..')
        } else out.push(part)
      }
      let joined = out.join(isWin ? '\\' : '/')
      if (isWin) {
        const drive = /^([A-Za-z]:)/.exec(path)
        joined = drive === null ? joined : drive[1] + '\\' + joined
      } else if (path.startsWith('\\\\')) joined = '\\\\' + joined
      else if (rooted) joined = '/' + joined
      return joined
    }

    function relativeTo(cwd, original, abs) {
      if (cwd === undefined || cwd === '') return original
      const base = normalizeAbs(cwd)
      if (base === '') return original
      if (abs.toLowerCase().startsWith(base.toLowerCase())) {
        const rel = abs.slice(base.length).replace(/^[\\/]+/, '')
        if (rel !== '') return rel
      }
      return original
    }

    function basename(path) {
      const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return at === -1 ? path : path.slice(at + 1)
    }

    // Shell verbs that start a command line. A tool row often prints
    // "cmd /c start …" or "npm run build", and every one of those contains a
    // slash or a backslash — treating them as paths produced nonsense targets
    // like "<cwd>\cmd \c start".
    const COMMAND_HEAD = /^(?:cmd|powershell|pwsh|bash|sh|zsh|fish|git|npm|npx|pnpm|yarn|bun|deno|node|python|python3|pip|pip3|curl|wget|docker|kubectl|gh|make|cmake|ninja|cargo|rustc|go|java|javac|dotnet|msbuild|taskkill|tasklist|robocopy|xcopy|move|copy|del|erase|dir|type|start|where|reg|sc|net|winget|choco|scoop)\b/i

    function looksLikePath(text) {
      const value = String(text === undefined || text === null ? '' : text).trim()
      if (value === '') return false
      if (COMMAND_HEAD.test(value)) return false
      if (/^-{1,2}[A-Za-z]/.test(value)) return false
      return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\') || value.includes('/') || value.includes('\\') || value.startsWith('.') || value.startsWith('~')
    }

    function textPathMatches(text) {
      const found = []
      const patterns = [
        /(?:[A-Za-z]:[\\/]|\\\\)(?:[^\\/:*?"<>|\s]+[\\/])*[^\\/:*?"<>|\s]+/g,
        /\/(?:[^/\s]+\/)+[^/\s]+/g
      ]
      for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
        const path = match[0].replace(/[.,;:!?，。；：！?）】〉》]+$/, '')
        if (path !== '' && !found.some((entry) => entry.path === path)) found.push({ path, start: match.index, end: match.index + match[0].length })
      }
      return found
    }

    function plainTextPathAtPoint(node, x, y) {
      if (node === null || typeof node !== 'object' || typeof node.closest !== 'function') return null
      const flow = node.closest('[data-chat-flow-kind="assistant-step"]')
      if (flow === null || typeof document === 'undefined') return null
      let textNode
      let offset
      if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(x, y)
        textNode = position?.offsetNode
        offset = position?.offset
      } else if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(x, y)
        textNode = range?.startContainer
        offset = range?.startOffset
      }
      if (textNode !== undefined && textNode !== null && textNode.nodeType === 3 && typeof offset === 'number') {
        const matches = textPathMatches(textNode.textContent || '')
        const hit = matches.find((entry) => offset >= entry.start && offset <= entry.end)
        if (hit !== undefined) return hit.path
      }
      const block = node.closest('p, li, pre') || flow
      const matches = textPathMatches(block.textContent || '')
      return matches.length === 1 ? matches[0].path : null
    }

    function detectFileTarget(node, x, y) {
      if (node === null || typeof node !== 'object' || typeof node.closest !== 'function') return null
      const chip = node.closest('[data-produced-files-row] button[title]')
      if (chip !== null) {
        const title = chip.getAttribute('title')
        if (typeof title === 'string' && title !== '') return { path: title }
      }
      const mention = node.closest('code button[title]')
      if (mention !== null) {
        const title = mention.getAttribute('title')
        if (typeof title === 'string' && title !== '' && looksLikePath(title)) return { path: title }
      }
      const row = node.closest('[data-tool]')
      if (row !== null) {
        const button = node.closest('button')
        if (button !== null) {
          const text = (button.textContent || '').trim()
          if (text !== '' && text !== 'Inspect' && looksLikePath(text)) return { path: text }
        }
      }
      const plainTextPath = plainTextPathAtPoint(node, x, y)
      if (plainTextPath !== null) return { path: plainTextPath }
      return null
    }

    function openInBrowser(url) {
      if (typeof window === 'undefined' || typeof window.open !== 'function') throw new Error('window.open is unavailable')
      const opened = window.open(url, '_blank', 'noopener,noreferrer')
      if (opened === null) throw new Error('the browser blocked the popup')
    }

    function copyText(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(text)
      }
      return new Promise((resolve, reject) => {
        try {
          if (typeof document === 'undefined') throw new Error('no document for clipboard fallback')
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(ta)
          if (ok) resolve()
          else reject(new Error('clipboard copy failed'))
        } catch (error) {
          reject(error)
        }
      })
    }

    function modeOf(snapshot) {
      if (snapshot === undefined || snapshot === null || snapshot.active === undefined) return 'light'
      return snapshot.active.colorScheme === 'dark' ? 'dark' : 'light'
    }

    let themeMode = 'light'
    const themeListeners = new Set()
    const setThemeMode = (mode) => {
      if (mode !== themeMode) {
        themeMode = mode
        for (const listener of themeListeners) listener()
      }
    }
    const subscribeTheme = (listener) => {
      themeListeners.add(listener)
      return () => themeListeners.delete(listener)
    }
    const getThemeMode = () => themeMode

    const NS = 'filemenu'
    const zh = {
      'menu.header': '文件操作',
      'menu.open': '打开',
      'menu.reveal': '打开所在目录',
      'menu.openEditor': '在编辑器中打开',
      'menu.openWith': '用其他程序打开',
      'menu.copyAbs': '复制路径',
      'menu.copyRel': '复制相对路径',
        'menu.openInBrowser': '在默认浏览器中打开',
        'menu.copyUrl': '复制链接',
      'menu.rename': '重命名会话',
      'menu.renamePrompt': '输入新的会话名称',
      'menu.fork': '分叉会话',
      'menu.archive': '归档会话',
      'menu.archiveConfirm': '确认归档“{name}”？归档后会话从项目列表隐藏，日志仍会保留。',
      'menu.cancel': '取消',
      'menu.confirm': '确认',
      'menu.scanning': '正在检测编辑器…',
      'menu.noEditor': '未检测到编辑器',
      'menu.error': '操作失败：{message}'
    }
    const en = {
      'menu.header': 'File actions',
      'menu.open': 'Open',
      'menu.reveal': 'Open containing folder',
      'menu.openEditor': 'Open in editor',
      'menu.openWith': 'Open with another program…',
      'menu.copyAbs': 'Copy path',
      'menu.copyRel': 'Copy relative path',
        'menu.openInBrowser': 'Open in default browser',
        'menu.copyUrl': 'Copy link',
      'menu.rename': 'Rename conversation',
      'menu.renamePrompt': 'Enter a new conversation title',
      'menu.fork': 'Fork conversation',
      'menu.archive': 'Archive conversation',
      'menu.archiveConfirm': 'Archive “{name}”? It will be hidden from the project list but its log is kept.',
      'menu.cancel': 'Cancel',
      'menu.confirm': 'Confirm',
      'menu.scanning': 'Scanning for editors…',
      'menu.noEditor': 'No editors found',
      'menu.error': 'Action failed: {message}'
    }

    const MENU_CSS = `
.fm-menu{position:fixed;z-index:100;display:flex;flex-direction:column;min-width:200px;max-width:280px;padding:4px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.3),0 2px 8px rgba(0,0,0,.18);font-family:inherit;font-size:13px;line-height:20px;pointer-events:auto;user-select:none}
.fm-header{padding:4px 10px 6px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:2px}
.fm-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:5px 10px;border:none;background:transparent;color:inherit;font:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:6px;cursor:pointer}
.fm-item-icon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center}
.fm-item-icon svg{width:15px;height:15px;display:block}
.fm-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.fm-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.fm-item:disabled{color:var(--dsw-alias-label-secondary);opacity:.5;cursor:default}
.fm-submenu-arrow{margin-left:auto;color:var(--dsw-alias-label-secondary)}
.fm-sep{height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1);flex:none}
.fm-error{padding:5px 10px 4px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px;white-space:normal;word-break:break-word}
.fm-dialog{display:flex;flex-direction:column;gap:8px;padding:6px}.fm-dialog-input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}.fm-dialog-copy{padding:0 4px;white-space:normal}.fm-dialog-actions{display:flex;justify-content:flex-end;gap:6px}.fm-dialog-actions .fm-item{width:auto}
.fm-menu[data-fm-theme="dark"]{background:#0d0d0d;color:#f4f4f5;border-color:rgba(255,255,255,.22)}
.fm-menu[data-fm-theme="dark"] .fm-header{color:#e4e4e7;border-bottom-color:rgba(255,255,255,.16)}
.fm-menu[data-fm-theme="dark"] .fm-item:hover:not(:disabled){background:rgba(255,255,255,.08)}
.fm-menu[data-fm-theme="dark"] .fm-item:disabled{color:rgba(255,255,255,.45)}
.fm-menu[data-fm-theme="dark"] .fm-submenu-arrow{color:#e4e4e7}
.fm-menu[data-fm-theme="dark"] .fm-sep{background:rgba(255,255,255,.18)}
`
    const CSS_TAG_ID = 'dsh-filemenu/menu.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-filemenu'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = MENU_CSS
      document.head.appendChild(tag)
    }

    // Host RPC over the webServer HTTP endpoint (see lib/index.js).
    const rpc = (action, args) =>
      fetch('/dsh-filemenu/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, args: args === undefined ? {} : args })
      }).then(async (res) => {
        if (!res.ok) throw new Error('dsh-filemenu RPC HTTP ' + res.status)
        const text = await res.text()
        if (text === '') throw new Error('dsh-filemenu RPC returned an empty response')
        try {
          return JSON.parse(text)
        } catch (err) {
          throw new Error('dsh-filemenu RPC returned invalid JSON: ' + text.slice(0, 80))
        }
      })

    let RUNTIME = { ctx: undefined, connection: undefined, sessions: undefined, workspaces: undefined, t: (key) => key }

    function runtimeService(name) {
      const current = RUNTIME.ctx === undefined ? undefined : RUNTIME.ctx.get(name)
      return current === undefined ? RUNTIME[name] : current
    }

    function rowTitleOf(row) {
      if (row === null) return ''
      const el = row.querySelector('span[class$="_title"]')
      if (el === null) return ''
      return (el.textContent || '').trim()
    }

    function newestSession(candidates) {
      if (candidates.length === 0) return undefined
      return candidates.reduce((best, current) => (current.updatedAt > best.updatedAt ? current : best))
    }

    function menuIcon(id) {
      const paths = {
        open: 'M6 3h9v9M15 3L8 10M13 13v5H3V8h5',
        openWs: 'M2 6h7l2 2h11v10H2z',
        openS: 'M4 4h16v12H4zM8 20h8M12 16v4',
        reveal: 'M2 6h7l2 2h11v10H2z',
        editor: 'M4 4h16v16H4zM8 9l3 3-3 3M13 15h3',
        openWith: 'M12 3l1.2 4.8L18 9l-4.8 1.2L12 15l-1.2-4.8L6 9l4.8-1.2z',
        copyPath: 'M8 8h10v12H8zM6 16H4V4h10v2',
        copyAbs: 'M8 8h10v12H8zM6 16H4V4h10v2',
        copyRel: 'M4 12h16M12 4l4 4-4 4M12 20l-4-4 4-4',
        rename: 'M4 20h4l10-10-4-4L4 16zM13 7l4 4',
        fork: 'M6 4v12a4 4 0 004 4h2M6 8h7a4 4 0 004-4M6 8h7a4 4 0 014 4v1',
        archive: 'M3 7h18v13H3zM2 4h20v3H2zM9 12h6'
      }
      const d = paths[id] || paths.open
      return React.createElement('span', { className: 'fm-item-icon', 'aria-hidden': true }, React.createElement('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }, React.createElement('path', { d })))
    }

    function FileContextMenuHost(props) {
      const useSessions = props.useSessions
      const useWorkspaces = props.useWorkspaces
      const t = RUNTIME.t
      const conn = RUNTIME.connection
      const useLayoutEffect = React.useLayoutEffect === undefined ? React.useEffect : React.useLayoutEffect
      const [menu, setMenu] = React.useState(null)
      const [pos, setPos] = React.useState(null)
      const [sub, setSub] = React.useState(null)
      const [editors, setEditors] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [dialog, setDialog] = React.useState(null)
      const [renameDraft, setRenameDraft] = React.useState('')
      const [hostDesc, setHostDesc] = React.useState(() => (conn === undefined || conn.hostDescription === undefined ? undefined : conn.hostDescription.getSnapshot()))
      const menuRef = React.useRef(null)
      const subRef = React.useRef(null)
      const renameInputRef = React.useRef(null)
      const busyRef = React.useRef(false)
      // A submenu opens a couple of pixels to the right of its parent item, and
      // the pointer crosses that gap on the way in. Closing on `mouseleave`
      // alone made the editor list unclickable, so the close is deferred and
      // cancelled as soon as the pointer lands on the submenu.
      const subCloseTimer = React.useRef(null)
      const cancelSubClose = () => {
        if (subCloseTimer.current !== null) {
          window.clearTimeout(subCloseTimer.current)
          subCloseTimer.current = null
        }
      }
      const scheduleSubClose = () => {
        cancelSubClose()
        subCloseTimer.current = window.setTimeout(() => {
          subCloseTimer.current = null
          setSub(null)
        }, 320)
      }
      React.useEffect(() => () => cancelSubClose(), [])
      const workspacesRef = React.useRef([])
      const sessionsRef = React.useRef({})

      React.useEffect(() => {
        if (conn === undefined || conn.hostDescription === undefined) return undefined
        return conn.hostDescription.subscribe(() => setHostDesc(conn.hostDescription.getSnapshot()))
      }, [conn])

      if (useWorkspaces !== undefined) {
        useWorkspaces((s) => {
          workspacesRef.current = s === undefined || s.items === undefined ? [] : s.items
          return s === undefined || s.items === undefined ? 0 : s.items.length
        })
      }
      if (useSessions !== undefined) {
        useSessions((s) => {
          sessionsRef.current = s === undefined || s.byId === undefined ? {} : s.byId
          return s === undefined || s.current === undefined ? '' : s.current
        })
      }

      const isLoopback = conn === undefined ? false : conn.isLoopback === true
      // The host owns this answer. `canOpenWorkspacePath()` is a live service
      // call; the connection's `hostDescription.canOpenPath` never was — it is
      // read here and written nowhere in any DSH build, so it stayed undefined
      // and greyed out every native action forever. Loopback is only the
      // pre-handshake guess while the capability request is in flight.
      const [canOpenPath, setCanOpenPath] = React.useState(isLoopback)
      React.useEffect(() => {
        let alive = true
        rpc('hello', {}).then((result) => {
          if (!alive || result === null || typeof result !== 'object') return
          if (typeof result.canOpen === 'boolean') setCanOpenPath(result.canOpen)
        }).catch(() => {})
        return () => { alive = false }
      }, [])
      const sessionId = useSessions === undefined ? undefined : useSessions((s) => (s === undefined ? undefined : s.current))
      const cwd = useSessions === undefined ? undefined : useSessions((s) => {
        if (s === undefined || s.current === undefined || s.byId === undefined) return undefined
        const current = s.byId[s.current]
        return current === undefined ? undefined : current.cwd
      })
      const dark = React.useSyncExternalStore === undefined ? false : React.useSyncExternalStore(subscribeTheme, getThemeMode) === 'dark'

      const resolveWorkspaceRow = (label) => {
        const items = workspacesRef.current
        for (const workspace of items) if (workspace.title === label) return workspace
        return undefined
      }

      const resolveSessionRow = (row) => {
        const label = rowTitleOf(row)
        if (label === '') return undefined
        const byId = sessionsRef.current
        let pool = Object.values(byId)
        let ownerWorkspaceId
        const group = row.parentElement
        if (group !== null) {
          const projectRowEl = group.querySelector('[role="treeitem"][aria-expanded]')
          if (projectRowEl !== null) {
            const workspace = resolveWorkspaceRow(rowTitleOf(projectRowEl))
            if (workspace !== undefined) {
              ownerWorkspaceId = workspace.workspaceId
              pool = pool.filter((s) => workspace.sessionIds.includes(s.id))
            }
          }
        }
        const exact = pool.filter((s) => s.blank !== true && s.title === label)
        if (exact.length > 0) {
          const session = newestSession(exact)
          return { session, label, workspaceId: ownerWorkspaceId ?? workspacesRef.current.find((workspace) => workspace.sessionIds.includes(session.id))?.workspaceId }
        }
        const blanks = pool.filter((s) => s.blank === true)
        if (blanks.length > 0) {
          const session = newestSession(blanks)
          return { session, label, workspaceId: ownerWorkspaceId ?? workspacesRef.current.find((workspace) => workspace.sessionIds.includes(session.id))?.workspaceId }
        }
        return undefined
      }

      const detectSidebarTarget = (node) => {
        if (node === null || typeof node !== 'object' || typeof node.closest !== 'function') return null
        const browser = node.closest('[data-dsh-workspace-drop-target]')
        if (browser === null) return null
        const row = node.closest('[role="treeitem"]')
        if (row === null) return null
        if (row.hasAttribute('aria-selected')) {
          const resolved = resolveSessionRow(row)
          if (resolved === undefined) return null
          return { kind: 'session', title: resolved.label, path: resolved.session.cwd, sessionId: resolved.session.id, workspaceId: resolved.workspaceId }
        }
        if (row.hasAttribute('aria-expanded')) {
          const label = rowTitleOf(row)
          if (label === '') return null
          const workspace = resolveWorkspaceRow(label)
          if (workspace === undefined) return null
          return { kind: 'workspace', title: label, path: workspace.path, workspaceId: workspace.workspaceId }
        }
        return null
      }

      const openWorkspace = (workspaceId) => {
        const byId = sessionsRef.current
        const workspacesList = workspacesRef.current
        const workspace = workspacesList.find((w) => w.workspaceId === workspaceId)
        if (workspace !== undefined) {
          const members = workspace.sessionIds.map((id) => byId[id]).filter((s) => s !== undefined)
          if (members.length > 0) {
            const best = members.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b))
            const sessions = runtimeService('sessions')
            if (sessions === undefined || typeof sessions.open !== 'function') throw new Error('sessions service unavailable')
            return sessions.open(best.id)
          }
        }
        const ws = runtimeService('workspaces')
        if (ws === undefined || typeof ws.startSession !== 'function') throw new Error('workspaces service unavailable')
        return ws.startSession(workspaceId)
      }

      const openSession = (sessionId) => {
        const sessions = runtimeService('sessions')
        if (sessions === undefined || typeof sessions.open !== 'function') throw new Error('sessions service unavailable')
        return sessions.open(sessionId)
      }

      const renameConversation = async (target, title) => {
        if (title === '' || title === target.title) return
        const sessions = runtimeService('sessions')
        const binding = sessions === undefined || typeof sessions.binding !== 'function' ? undefined : sessions.binding(target.sessionId)
        if (binding === undefined || binding.session === undefined) throw new Error('session binding unavailable')
        const result = await binding.session.rename(title)
        if (!result.ok) throw new Error(result.error.message)
      }

      const forkConversation = async (target) => {
        const sessions = runtimeService('sessions')
        if (sessions === undefined || typeof sessions.fork !== 'function' || typeof sessions.open !== 'function') throw new Error('sessions service unavailable')
        const childId = await sessions.fork({ sessionId: target.sessionId, increaseTitle: true })
        sessions.open(childId)
      }

      const archiveConversation = async (target) => {
        const workspaces = runtimeService('workspaces')
        if (workspaces === undefined || typeof workspaces.archiveSession !== 'function') throw new Error('workspace archive service unavailable')
        await workspaces.archiveSession(target.sessionId)
      }

      React.useEffect(() => {
        const onContextMenu = (event) => {
          const fileHit = detectFileTarget(event.target, event.clientX, event.clientY)
          let target = fileHit === null ? null : { kind: 'file', path: fileHit.path }
          if (target === null) target = detectSidebarTarget(event.target)
            if (target === null) {
              const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
              const href = anchor === null ? '' : (anchor.href || anchor.getAttribute('href') || '')
              if (/^https?:\/\//i.test(href)) target = { kind: 'url', url: href }
            }
          if (target === null) return
          event.preventDefault()
          event.stopPropagation()
          setSub(null)
          setError(null)
          setDialog(null)
          setMenu({ x: event.clientX, y: event.clientY, target })
          if (target.kind === 'file') {
            rpc('editors', {}).then((res) => {
              if (res !== null && typeof res === 'object' && Array.isArray(res.editors)) setEditors(res)
            }).catch(() => {})
          }
        }
        if (typeof document === 'undefined') return undefined
        document.addEventListener('contextmenu', onContextMenu, true)
        return () => document.removeEventListener('contextmenu', onContextMenu, true)
      }, [])

      React.useEffect(() => {
        if (menu === null) return undefined
        const close = () => {
          setMenu(null)
          setSub(null)
          setError(null)
        }
        const onPointerDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          if (subRef.current !== null && subRef.current.contains(event.target)) return
          close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        const onScroll = () => close()
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        if (typeof window !== 'undefined') {
          window.addEventListener('scroll', onScroll, true)
          window.addEventListener('resize', onScroll)
        }
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
          if (typeof window !== 'undefined') {
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', onScroll)
          }
        }
      }, [menu])

      useLayoutEffect(() => {
        if (menu === null) {
          setPos(null)
          return
        }
        const el = menuRef.current
        let left = menu.x
        let top = menu.y
        if (el !== null) {
          const w = el.offsetWidth
          const h = el.offsetHeight
          const vw = typeof window === 'undefined' ? 800 : window.innerWidth
          const vh = typeof window === 'undefined' ? 600 : window.innerHeight
          if (left + w > vw - 8) left = Math.max(8, vw - w - 8)
          if (top + h > vh - 8) top = Math.max(8, vh - h - 8)
        }
        setPos({ left, top })
      }, [menu])

      useLayoutEffect(() => {
        if (sub === null) return
        const el = subRef.current
        let left = sub.x
        let top = sub.y
        if (el !== null) {
          const w = el.offsetWidth
          const h = el.offsetHeight
          const vw = typeof window === 'undefined' ? 800 : window.innerWidth
          const vh = typeof window === 'undefined' ? 600 : window.innerHeight
          if (left + w > vw - 8) left = Math.max(8, vw - w - 8)
          if (top + h > vh - 8) top = Math.max(8, vh - h - 8)
        }
        if (left !== sub.x || top !== sub.y) setSub({ x: left, y: top })
      }, [sub])

      useLayoutEffect(() => {
        if (dialog?.kind !== 'rename' || renameInputRef.current === null) return
        renameInputRef.current.focus()
        renameInputRef.current.select()
      }, [dialog])

      if (menu === null) return null

      const target = menu.target
      const isFile = target.kind === 'file'
      const abs = isFile ? normalizeAbs(joinPath(cwd, target.path)) : target.path
      const rel = isFile ? relativeTo(cwd, target.path, abs) : target.path
      const headerName = isFile ? basename(target.path) : target.title
      const run = async (action) => {
        if (busyRef.current) return
        busyRef.current = true
        try {
          await action()
          setMenu(null)
          setSub(null)
          setError(null)
        } catch (err) {
          console.error('[dsh-filemenu] action failed:', err)
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          busyRef.current = false
        }
      }
      const openSubmenu = (event) => {
        cancelSubClose()
        const r = event.currentTarget.getBoundingClientRect()
        setSub({ x: r.right + 2, y: r.top })
      }
      const platformWindows = editors !== null && editors.platform === 'windows'
      let items
      if (target.kind === 'workspace') {
        items = [
          { id: 'reveal', label: t('menu.reveal'), disabled: !canOpenPath, action: () => rpc('reveal', { path: target.path }) },
          { id: 'openWs', label: t('menu.open'), action: () => openWorkspace(target.workspaceId) },
          null,
          { id: 'copyPath', label: t('menu.copyAbs'), action: () => copyText(target.path) }
        ]
      } else if (target.kind === 'session') {
        items = [
          { id: 'reveal', label: t('menu.reveal'), disabled: !canOpenPath, action: () => rpc('reveal', { path: target.path }) },
          { id: 'openS', label: t('menu.open'), action: () => openSession(target.sessionId) },
          { id: 'rename', label: t('menu.rename'), dialog: 'rename' },
          { id: 'fork', label: t('menu.fork'), action: () => forkConversation(target) },
          { id: 'archive', label: t('menu.archive'), dialog: 'archive' },
          null,
          { id: 'copyPath', label: t('menu.copyAbs'), action: () => copyText(target.path) }
        ]
      } else {
        items = [
          { id: 'open', label: t('menu.open'), disabled: !canOpenPath, visible: isFile, action: () => rpc('open', { path: target.path, cwd, sessionId }) },
          { id: 'reveal', label: t('menu.reveal'), disabled: !canOpenPath, visible: isFile, action: () => rpc('reveal', { path: target.path, cwd, sessionId }) },
          { id: 'editor', label: t('menu.openEditor'), submenu: true, disabled: !canOpenPath, visible: isFile },
          { id: 'openWith', label: t('menu.openWith'), disabled: !canOpenPath, visible: platformWindows && isFile, action: () => rpc('openWithDialog', { path: target.path, cwd, sessionId }) },
          null,
          { id: 'copyAbs', label: t('menu.copyAbs'), action: () => copyText(abs) },
          { id: 'copyRel', label: t('menu.copyRel'), action: () => copyText(rel) },
            null,
            { id: 'openUrl', label: t('menu.openInBrowser'), visible: !isFile, action: () => openInBrowser(target.url) },
            { id: 'copyUrl', label: t('menu.copyUrl'), visible: !isFile, action: () => copyText(target.url) }
        ]
      }
      const editorEntries = editors === null ? null : editors.editors
      const themeAttr = dark ? 'dark' : 'light'
      return React.createElement(React.Fragment, null, [
        React.createElement('div', {
          key: 'menu',
          className: 'fm-menu',
          ref: menuRef,
          role: 'menu',
          'data-fm-theme': themeAttr,
          style: { left: pos === null ? menu.x : pos.left, top: pos === null ? menu.y : pos.top },
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
          }
        }, [
          React.createElement('div', { key: 'header', className: 'fm-header', title: abs }, headerName),
          items.map((item) => {
            if (dialog !== null) return null
            if (item === null) return React.createElement('div', { key: 'sep', className: 'fm-sep', role: 'separator' })
            if (item.visible === false) return null
            if (item.dialog !== undefined) return React.createElement('button', {
              key: item.id,
              type: 'button',
              role: 'menuitem',
              className: 'fm-item',
              onClick: () => {
                setError(null)
                setRenameDraft(item.dialog === 'rename' ? target.title : '')
                setDialog({ kind: item.dialog, target })
              }
            }, [menuIcon(item.id), React.createElement('span', { key: 'label' }, item.label)])
            if (item.submenu === true) {
              return React.createElement('button', {
                key: item.id,
                type: 'button',
                role: 'menuitem',
                className: 'fm-item',
                disabled: item.disabled === true,
                onMouseEnter: openSubmenu,
                onMouseLeave: (event) => {
                  if (subRef.current !== null && subRef.current.contains(event.relatedTarget)) return
                  scheduleSubClose()
                },
                onClick: (event) => {
                  if (sub !== null) setSub(null)
                  else openSubmenu(event)
                }
              }, [menuIcon(item.id), React.createElement('span', { key: 'label' }, item.label), React.createElement('span', { key: 'arrow', className: 'fm-submenu-arrow' }, '\u203A')])
            }
            return React.createElement('button', {
              key: item.id,
              type: 'button',
              role: 'menuitem',
              className: 'fm-item',
              disabled: item.disabled === true,
              onClick: () => { run(item.action) }
            }, [menuIcon(item.id), React.createElement('span', { key: 'label' }, item.label)])
          }),
          dialog !== null && React.createElement('form', {
            key: 'dialog',
            className: 'fm-dialog',
            onSubmit: (event) => {
              event.preventDefault()
              if (dialog.kind === 'rename') run(() => renameConversation(dialog.target, renameDraft.trim()))
              else run(() => archiveConversation(dialog.target))
            }
          }, [
            dialog.kind === 'rename'
              ? React.createElement('input', { key: 'input', ref: renameInputRef, className: 'fm-dialog-input', value: renameDraft, onChange: (event) => setRenameDraft(event.target.value), 'aria-label': t('menu.renamePrompt') })
              : React.createElement('div', { key: 'copy', className: 'fm-dialog-copy' }, t('menu.archiveConfirm', { name: dialog.target.title })),
            React.createElement('div', { key: 'actions', className: 'fm-dialog-actions' }, [
              React.createElement('button', { key: 'cancel', type: 'button', className: 'fm-item', onClick: () => { setDialog(null); setError(null) } }, t('menu.cancel')),
              React.createElement('button', { key: 'confirm', type: 'submit', className: 'fm-item', disabled: dialog.kind === 'rename' && renameDraft.trim() === '' }, t('menu.confirm'))
            ])
          ]),
          error !== null && React.createElement('div', { key: 'error', className: 'fm-error', role: 'alert' }, t('menu.error', { message: error }))
        ]),
        sub !== null && React.createElement('div', {
          key: 'sub',
          ref: subRef,
          className: 'fm-menu fm-sub',
          role: 'menu',
          'data-fm-theme': themeAttr,
          style: { left: sub.x, top: sub.y },
          onMouseEnter: cancelSubClose,
          onMouseLeave: scheduleSubClose,
          onContextMenu: (event) => {
            event.preventDefault()
            event.stopPropagation()
          }
        }, editorEntries === null
          ? [React.createElement('button', { key: 'scan', type: 'button', className: 'fm-item', disabled: true }, [menuIcon('editor'), React.createElement('span', { key: 'label' }, t('menu.scanning'))])]
          : editorEntries.length === 0
            ? [React.createElement('button', { key: 'none', type: 'button', className: 'fm-item', disabled: true }, [menuIcon('editor'), React.createElement('span', { key: 'label' }, t('menu.noEditor'))])]
            : editorEntries.map((editor) => React.createElement('button', {
                key: editor.id,
                type: 'button',
                role: 'menuitem',
                className: 'fm-item',
                onClick: () => { run(() => rpc('openWith', { path: target.path, cwd, sessionId, editorId: editor.id })) }
              }, [menuIcon('editor'), React.createElement('span', { key: 'label' }, editor.name)])))
      ])
    }

    function apply(ctx) {
      RUNTIME.ctx = ctx
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const locale = ctx.get('locale')
      const connection = ctx.get('connection')
      const theme = ctx.get('theme')
      if (theme !== undefined && typeof theme.getTheme === 'function') {
        setThemeMode(modeOf(theme.getTheme()))
        ctx.on('theme/change', (snapshot) => setThemeMode(modeOf(snapshot)))
      }
      if (locale !== undefined) {
        ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-filemenu: dictionaries')
        RUNTIME.t = locale.bind(NS)
      }
      RUNTIME.connection = connection
      RUNTIME.sessions = ctx.get('sessions')
      RUNTIME.workspaces = ctx.get('workspaces')
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'file-context-menu',
        order: 100
      }, FileContextMenuHost))
    }

    exports.apply = apply
    return module.exports
  }
})
