# DSH Ready GUI

A desktop shell for DeepSeek Harness (`@deepseek-ai/dsh`): it installs and updates the engine itself and embeds the engine's web UI in a native window. Current version **0.8.0**.

[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)
[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![license](https://img.shields.io/github/license/itchenshi/dsh-ready-gui)](LICENSE)
[![release](https://img.shields.io/github/v/release/itchenshi/dsh-ready-gui)](https://github.com/itchenshi/dsh-ready-gui/releases)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![GitHub](https://img.shields.io/badge/GitHub-host-blue)](https://github.com/itchenshi/dsh-ready-gui)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-red)](https://gitee.com/itchenshi/dsh-ready-gui)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-green)](https://gitcode.com/itchenshi/dsh-ready-gui)

## What it does

- **Open it and you have a UI**: no command line and no system browser; the shell starts the engine and loads its page inside the window.
- **Engine updates handled**: checked at launch and every 30 minutes, then installed silently / asked (default) / only notified, per your policy; it also tells you when DSH Ready GUI itself has a new version.
- **Data folder is your choice**: system `~/.dsh` by default, or the app folder; switching offers to move the data with it.
- **Four bundled plugins**: shipped inside the app, one tick in the settings window installs them; the first launch offers a one-click "Enable all" card.
- **Tray and close behaviour**: closing the window hides it to the tray (open window / settings / quit from there), or quits outright.
- **Multiple instances**: each one gets its own window and its own engine process.

## Install

**Windows (the one actually used in practice)** — download from [GitHub Releases](https://github.com/itchenshi/dsh-ready-gui/releases):

- `DSH.Ready.GUI.Setup.<version>.exe` — installer, you can choose the install directory;
- `DSH.Ready.GUI-<version>-win.zip` — portable build, unzip and run.

**macOS / Linux (built by CI, never verified on real hardware)** — the same page has `DSH.Ready.GUI-<version>.dmg` (arm64 / x64) and `DSH.Ready.GUI-<version>.AppImage`. GitHub Actions produces them, but they have not been run on real machines here, so they are **not guaranteed to work**; the macOS builds are unsigned, so Gatekeeper may block them.

**Installers live on GitHub only**: [Gitee](https://gitee.com/itchenshi/dsh-ready-gui) and [GitCode](https://gitcode.com/itchenshi/dsh-ready-gui) are code mirrors whose releases hold source archives only.

**From source** (development only): [Node.js](https://nodejs.org/) ≥ 23, then

```sh
npm install
npm start
```

Packaged builds ship their own portable Node, so end users install no runtime.

## First run

1. The shell reads the engine's language / theme first, then opens the window; the status page shows progress while the engine is being installed.
2. The first launch downloads the engine: using the bundled portable Node, it fetches `@deepseek-ai/dsh` from the npm registry into the app data folder's `dsh-engine/` (`%APPDATA%\DSH Ready GUI\dsh-engine` on Windows), then loads the UI.
3. Engine data goes under the system `~/.dsh` (`$DSH_HOME`) by default; Settings can switch it to the app folder (`%APPDATA%\DSH Ready GUI\dsh-home` on Windows). If the source folder holds data, the switch asks "move and switch / switch only / cancel".
4. Bundled plugins are **not** installed by default. Once the engine is up, if something is missing the shell opens the settings window by itself with an "Enable all" card on top: one click installs them and restarts the engine once. "No thanks — I'll pick below" installs nothing and it will not ask again.
5. The shell's own preferences (close behaviour, data folder, update policy) live in `%APPDATA%\DSH Ready GUI\settings.json`.

## Bundled plugins

| Plugin | What it does | Shipped version |
|---|---|---|
| `dsh-model-surplus` | Shows usage / balance for the active model right of the session title: OpenCode Go plan usage and the selected model's monthly cap, plus the DeepSeek account balance | 0.4.6 |
| `dsh-gui-last-session` | Reopens your last conversation after a restart | 0.1.9 |
| `dsh-gateway-models` | Declares the opencode-go / Command Code route protocol and endpoint, and completes their model lists | 0.2.6 |
| `dsh-keys-setting` | Sets, on the General page of DSH Settings, whether Enter / Shift+Enter / Ctrl+Enter sends or inserts a newline | 0.2.6 |

Each plugin is also its own repository ([model-surplus](https://github.com/itchenshi/dsh-model-surplus), [gui-last-session](https://github.com/itchenshi/dsh-gui-last-session), [gateway-models](https://github.com/itchenshi/dsh-gateway-models), [keys-setting](https://github.com/itchenshi/dsh-keys-setting)); `plugins/` here is the copy shipped inside the app — installing uses that local copy, not npm.

## Settings

The real options in the settings window (tray menu or app menu):

| Option | Values / default |
|---|---|
| Close window | Hide to tray (default) / quit |
| Data folder | Follow system `~/.dsh` (default) / app folder; switching asks about migrating |
| Engine update policy | Silently update / **ask before updating** (default) / notify only |
| Version channel | Follow the npm latest tag (default) / skip alpha / include alpha, beta and rc |
| Auto-check for engine updates | On (default; at launch and every 30 minutes) / off |
| Check engine update now | Button |
| Third-party plugins | Per plugin: the "install" checkbox, the "enabled" toggle, "Update" when the shipped copy is newer, "Repair / retry" when the state drifted |
| Restart engine / Reload page | After install or uninstall, press "Restart engine" (the "restart engine" badge sits next to it); a plugin with a page half also needs "Reload page" |
| Language / theme | Not here — set them in the Harness page's Settings; the shell follows live, no restart |

## FAQ

- **Where is my data?** Engine sessions, config and plugins live in `$DSH_HOME` (default `~/.dsh`, or the app folder if you switched); the engine itself is in the app data folder's `dsh-engine/`; the shell's own preferences are in the app data folder's `settings.json`.
- **How do I get my last conversation back?** The bundled "session resume" plugin does it and is on by default (Settings → Session → reopen the last conversation on launch). Turn it off and every launch starts blank; the conversation records themselves stay in `$DSH_HOME` either way.
- **Why does it say a plugin needs a restart?** The engine assembles its plugin list only at startup, so install / uninstall needs an engine restart (the settings window shows a "restart engine" badge — press the button next to it). Enable / disable is hot-reloaded and applies immediately; a plugin with a page half also needs a Harness page reload.
- **What if the engine fails to start?** A "DeepSeek Harness failed to start" dialog shows the engine's last output and the log path: `logs/dsh-start-fail-<time>.log` in the app data folder. If a plugin's package name appears in that output, the dialog offers to disable it and restart.
- **Does the app keep running after I close the window?** Yes by default — it only hides to the tray (right-click the tray icon to open the window, reach settings or quit). Switch "Close window" to "quit" to exit on close.

## Development

```sh
npm start                 # run it directly (Electron)
npm test                  # unit tests + settings-page inline JS, doc images, PowerShell encoding checks
npm run test:e2e          # Windows end-to-end smoke (launches the real app with an isolated userData)
npm run test:e2e:ui       # close / tray / modal UI smoke (Windows)
npm run verify:builtin    # bundled-plugin self-healing check (temp DSH_HOME + real engine + real pnpm)
npm run sync:plugins      # plugin repos -> plugins/ (full mirror)
npm run dist:win          # Windows: installer + portable zip
npm run dist:mac          # macOS dmg (must run on macOS)
npm run dist:linux        # Linux AppImage
```

- The smoke tests drive the real app and a real engine, not mocks; close a running instance first.
- Edit plugins in their own repositories (`plugin-repos/<name>/`), then `npm run sync:plugins`; `plugins/` is generated and hand edits get overwritten. For a drift check only: `node scripts/sync-bundled-plugins.mjs --check`.
- CI is [`.github/workflows/build-all.yml`](.github/workflows/build-all.yml): it runs `npm test` first, then builds on Windows / macOS / Linux runners and attaches the artifacts to the release.

## License

[MIT](LICENSE) · An independent open-source shell, not affiliated with the DeepSeek Harness project;
DeepSeek Harness itself is [MIT](https://github.com/deepseek-ai/deepseek-harness) licensed.
