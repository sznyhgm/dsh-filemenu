# dsh-filemenu

Right-click context menus for **file paths, links, and sidebar rows** in the
DeepSeek Harness (DSH) web UI.

对话里的文件路径、链接、侧栏会话/工作区行 —— 右键即可操作。

> This is a ground-up rewrite of [`ltsone9/dsh-filemenu`](https://github.com/ltsone9/dsh-filemenu).
> The upstream 1.1.x host half launched nothing on current DSH builds: it called
> `subprocess.spawn()` without the required `cwd`, so the provider threw before a
> process ever started while the RPC still answered `{ ok: true }`. See
> [What changed](#what-changed-in-12x).

## Features

Right-click a file path anywhere in the conversation (produced-file chips, code
block chips, tool rows, or plain text) to get:

| Item | What it does |
| --- | --- |
| Open | Hand the path to the OS default application |
| Open containing folder | Reveal the file in Explorer / Finder |
| Open in editor ▸ | Launch a detected editor (VS Code, Cursor, Sublime Text, …) |
| Copy path | Copy the absolute path |
| Copy relative path | Copy the path relative to the session working directory |

Right-click a link (`<a href="http(s)://…">`):

| Item | What it does |
| --- | --- |
| Open in default browser | Opens in a new tab |
| Copy link | Copy the URL |

Right-click a sidebar session or workspace row: open, reveal, rename, fork,
archive, copy path.

## Requirements

- DSH Desktop **0.9.0** with `@deepseek-ai/dsh` **0.1.5-rc.2** (tested).
- The host half needs the `webServer`, `fs`, `subprocess`, and
  `sessionController` services. No `@deepseek-ai/*` import is used, so the
  package resolves cleanly from a profile `node_modules` directory.

## Install

Copy the package into the profile and declare it as a bundle:

```powershell
$prof = "$env:APPDATA\dsh-desktop\harness\profiles\web"
Copy-Item . "$prof\node_modules\dsh-filemenu" -Recurse -Force
# then add "dsh-filemenu" to dsh.profile.bundles in the profile package.json
```

The package ships its own `cordis.patch.yml`, which the profile loader applies
as a composition `insert` row. A DSH restart (or a live patch reload) is needed
for the host half to mount.

## How it works

Both halves are plain JavaScript; the browser half talks to the host over one
HTTP RPC endpoint.

```
POST /dsh-filemenu/rpc   { "action": "open", "args": { "path": "…", "cwd": "…" } }
```

Host actions: `hello`, `open`, `reveal`, `openWith`, `editors`, `url`.

Two official DSH seams do the actual work:

- **`sessionController.openPath` / `revealPath` / `canOpenWorkspacePath`** — the
  native-opener seam. `canOpenWorkspacePath()` is the deployment's own answer to
  "may a path be handed to a desktop?", and the menu asks for it in the `hello`
  handshake instead of guessing from the page origin.
- **`subprocess.spawn({ argv, cwd, stdio, graceMs })`** — the managed-process
  seam that `dsh-host-open-in-app` itself uses. `cwd` is a required field of
  `SubprocessSpawnSpec`.

## Known limitations

- **Windows reveal uses `explorer.exe /select,<file-url>`.** If the host runs
  without a reachable desktop shell, the window cannot be shown; the action
  still returns `ok`, because "Explorer exited 1" is a delegated handoff, not a
  failure signal.
- **Editor detection is best effort.** A PATH hit that is a shell shim
  (`code.CMD`) is mapped to the real GUI executable (`Code.exe`); if neither the
  shim's install directory nor the well-known install paths contain it, that
  editor is simply not listed.
- The RPC endpoint is served by the loopback-bound web server. Keep
  non-loopback deployments behind a firewall.
- Linux/macOS code paths are written but untested on this build.

## What changed in 1.2.x

| Area | Upstream 1.1.8 | Here |
| --- | --- | --- |
| Host process launch | `subprocess.spawn({ argv, stdio, graceMs })` — no `cwd` ⇒ provider throws, RPC answers `ok:true` anyway | `spawn({ argv, cwd, stdio, graceMs })`, with the failure surfaced as `ok:false` |
| Path open | bespoke spawn / WMI fallback | `sessionController.openPath` first |
| Reveal | WMI `cmd /c start` | `explorer.exe /select,` via `subprocess.spawn` |
| Menu enablement | read `connection.hostDescription.canOpenPath`, a field no DSH build ever writes ⇒ every native item permanently greyed out | `hello` RPC → `sessionController.canOpenWorkspacePath()` |
| Path detection | any string containing `/` or `\` counted as a path ⇒ `cmd /c start` became `…\cmd \c start` | shell verbs and option-only tokens are rejected before the path test |
| Diagnostics | debug logging into absolute `D:\…` paths, service probing at request time | removed |
| Open URL | host spawned an opener | the menu uses `window.open` |

## License

MIT. Original `dsh-filemenu` © ltsone9.
