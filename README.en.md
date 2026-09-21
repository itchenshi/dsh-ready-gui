# DSH GUI

> A desktop shell for DeepSeek Harness — embedded Web UI, always-latest engine, portable data directory, and a system tray.

[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)
[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![license](https://img.shields.io/github/license/itchenshi/DeepSeekHarnessGUI)](LICENSE)
[![release](https://img.shields.io/github/v/release/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/releases)
[![stars](https://img.shields.io/github/stars/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/stargazers)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![GitHub](https://img.shields.io/badge/GitHub-host-blue)](https://github.com/itchenshi/DeepSeekHarnessGUI)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-red)](https://gitee.com/itchenshi/DeepSeekHarnessGUI)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-green)](https://gitcode.com/itchenshi/DeepSeekHarnessGUI)

DSH GUI is an **unofficial** desktop shell for [DeepSeek Harness](https://www.deepseek.com/harness/) (DeepSeek's open-source agent framework, `@deepseek-ai/dsh`, currently a technical preview). It wraps Harness's Web UI in a native window: out-of-the-box, tray-resident, self-updating — while keeping 100% of Harness's capabilities because the shell runs the official engine untouched.

```
┌────────────────────────────────────────────┐
│  DSH GUI (Electron App Shell)             │
│  ├─ Embedded window (Harness UI via dsh web)│
│  ├─ System tray (Open window / Settings / Exit) │
│  ├─ Engine updater (startup + periodic checks) │
│  └─ Data directory (default ~/.dsh, switchable & migratable) │
└────────────────────────────────────────────┘
```

## 🔗 Repositories

The three repositories are mirrors of each other; installers are published on [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases).

| Platform | URL | Clone |
|---|---|---|
| GitHub (primary) | https://github.com/itchenshi/DeepSeekHarnessGUI | `git clone https://github.com/itchenshi/DeepSeekHarnessGUI.git` |
| Gitee (mirror) | https://gitee.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitee.com/itchenshi/DeepSeekHarnessGUI.git` |
| GitCode (mirror) | https://gitcode.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitcode.com/itchenshi/DeepSeekHarnessGUI.git` |

## 🆕 What's new in v0.4.1

- **🔐 Security fixes (everyone should upgrade)**: the three plugins' **browser routes had no authentication at all** — a request with no credentials returned your **account usage and DeepSeek balance**, and even wrote settings (a forged `Host` worked too, the DNS-rebinding shape). This release also adds the **navigation fence** (the engine page could previously walk the window — preload bridge included — onto a remote origin), a **permission fence** (microphone/camera/geolocation/notifications were auto-granted), **sender checks on every privileged IPC channel**, and closes "any third-party plugin can disable the engine's own rows".
- **🛠 Reliability**: patch-layer writes now use a **cross-process lock + atomic write + post-write verify** (3 concurrent processes × 40 rows used to **silently lose 17–28 rows while reporting success**; now 120/120 survive). A failed write no longer flips the market state, a plugin that is registered but missing on disk is actually reinstalled, and a bundled plugin only replaces an installed one when it is genuinely newer (no more unattended downgrades).
- **🔄 DSH GUI now checks for its own updates**: after launch, automatically, notifying when a newer version exists and staying silent when offline — **nothing to configure**. The check **handles mainland and international networks automatically**: Gitee → GitCode → GitHub on a mainland network and the reverse elsewhere, per-source timeout with fallback and the last working source remembered (measured here: Gitee answered on the first try in 251 ms).
- **⌨️ New plugin "Composer shortcuts"** (`dsh-composer-keys`): configure whether Enter / Shift+Enter / Ctrl+Enter **send** or **insert a line break**, from the settings window's General page. Defaults match the engine, so nothing about your habits changes.

Full details: [CHANGELOG.md](CHANGELOG.md) and [RELEASE-NOTES-v0.4.1.md](RELEASE-NOTES-v0.4.1.md).

## 📸 Screenshots

| Main window | Settings window |
|---|---|
| ![Main window](screenshots/主窗口-english.png) | ![Settings window](screenshots/设置-english.png) |

**Model usage & balance** (right of the session title, switched by the active model): OpenCode Go models show plan usage, DeepSeek models show the account balance.

| OpenCode Go usage | DeepSeek balance |
|---|---|
| ![OpenCode Go usage](screenshots/模型OpenCodeGo余量.png) | ![DeepSeek balance](screenshots/模型DeepSeek余量.png) |

| DSH settings dialog |
|---|
| ![DSH settings dialog](screenshots/DSH设置-english.png) |

---

## ✨ Feature overview (by category)

### 🪟 Desktop window & system tray

- **Embedded window**: the shell spawns `dsh web --no-open --port 0`, parses the authenticated loopback URL from stdout, and loads it into the embedded Electron window. No external browser needed.
- **Main window starts maximized**, with no size flicker while hidden.
- **System tray**: right-click menu "Open window / Check DSH GUI update… / Settings / Exit"; closing the window hides to tray by default, or can be set to "quit directly" (which removes the tray icon too).
- **Window title shows the app version** (`DSH GUI v<version>`); the tray tooltip shows both the GUI and engine versions.

### ⚡ Engine lifecycle management

- **Always the latest Harness**: checks the npm registry version table at startup and every **fixed 30 minutes** while running (frequency is not adjustable). On a new version it follows the policy: **ask before updating (default) / silent update / notify only**; updates install into the app's private directory and a **persistent badge** pops up bottom-right when done.
- **GUI update vs engine update are separate**: the engine update is handled in the background by the GUI per the configured policy; **DSH GUI itself checks for a newer version after launch**, notifying through the notice window when one exists (never interrupting), silent when up to date or offline, and never notifying twice for the same version. **A launch-time check alone is not enough** — this GUI is often left running for days, so it also re-checks in the background every 6 hours, while the startup check itself is throttled to once an hour (so repeated restarts do not hammer the network). The check **covers mainland and international networks automatically**: it uses the GitHub / Gitee / GitCode releases, trying Gitee → GitCode → GitHub on a mainland network (`zh-CN` or an Asia/Shanghai-style time zone) and the reverse elsewhere, with a per-source timeout, source-by-source fallback, and the source that last worked remembered and preferred — so a mainland user never burns a timeout on GitHub first. **There is nothing to configure**; the tray item "Check DSH GUI update…" is the manual entry point and opens the download page of whichever platform actually answered. Measured here (Asia/Shanghai): Gitee answered on the first try in 251 ms (both GitHub and Gitee allow 60 unauthenticated API requests per hour per IP, so one check an hour uses 1/60 — and a rate-limited source is treated as a failure and skipped).
- **GUI-hosted engine restart**: dsh runs as a child process of DSH GUI, so an in-page "restart" cannot restart it. To make plugins (or the engine itself) take effect, use "Restart engine to apply" in the settings window, the page bridge `window.__dshGui.restartEngine()`, or simply relaunch DSH GUI. After the engine is ready, unexpected exits are auto-respawned (auto-restart stops after 3 consecutive failures and notifies).
- **Auto-recovery from plugin-caused startup failures**: a plugin auto-installed this launch that breaks dsh startup is removed and unchecked automatically; suspected plugin failures pop a diagnostic dialog where you can disable them and restart with one click.

### 🔌 Third-party plugin management

A plugin has **two orthogonal states**. The settings window gives each its own control, and both stay in sync with the Harness plugin market in real time:

- **① The "install" checkbox mirrors the real install state.** Installed → checked, not installed → unchecked; checking installs immediately, unchecking uninstalls (same `dsh plugin` mechanism the market uses — removed from the profile, local files kept). No checkbox state is persisted anymore.
- **② The "Enabled" toggle mirrors the loaded/disabled state** (new in v0.3.0). Turning it off does **not** uninstall — the engine simply stops loading the plugin (files and registration kept); turning it back on restores loading.
  It goes through **the plugin market's own switch endpoint** (`POST <engine>/dsh-market/toggle` — the exact same path the market page's switch uses), so live timing, protection rules and the `restart` / `refresh` signals all match the market:
  - the engine side applies **immediately** (the market drives the loader handle live — no restart);
  - for plugins with a **client half** (e.g. model usage & balance) the already-loaded page half does not disappear on its own — the market returns `refresh: true` and shows a "refresh to apply" hint for exactly that reason, and the settings window offers the same **"Reload page"** action to line the page up with the engine;
  - market refusals are surfaced verbatim (host infrastructure is protected, the market cannot disable itself, plugin not installed) — we never bypass its protections by writing files;
  - when the market is unavailable (not installed / engine not running / older version without the route) it falls back to writing the profile patch layer `cordis.patch.yml` (`- id: <rowId>` + `disabled: true|false` rows) plus the market's `.dsh-market/state.json`. On a `patchReload: live` web profile the engine still recomposes that live (measured ~0.7s), just without the `restart`/`refresh` signals.
- **Live sync with the plugin market**: the settings window watches `profiles/web/package.json`, `cordis.patch.yml` and `.dsh-market/state.json` (exactly the three files the market's switch touches). Any change recomputes the state fingerprint and rebroadcasts it, and both controls are repainted from the real state — disabling/enabling in the market shows up here immediately as "Disabled (plugin market)" / "Enabled".
- **Disagreements self-heal**: if the market disabled a plugin but the disable row never made it into the profile patch layer (in which case the engine is in fact still loading it), boot maintenance and "Repair / retry" write the real disable, and the settings window says why in the meantime.
- **Boot maintenance** (installed catalog entries only): bundled plugins are reinstalled when their bundled code was updated; installed entries whose `engineRange` is incompatible with the current engine (these can crash the profile) are removed before spawn; user-installed extra bundles are never touched. Renamed/merged catalog entries are also migrated here: the old package is unregistered and its replacement installed, carrying the enabled/disabled choice over.
- **"Repair / retry" button**: reconciles against the currently installed set (pulls bundled-plugin updates), additive only — safe to use as a retry after a failed install; it also aligns the enabled/disabled state and runs the same rename migration.
- **Curated catalog (verified community plugins)**: Plugin marketplace (dsh-market) · Reopen last session (dsh-gui-last-session) · **Model usage & balance (dsh-model-usage)** · OpenCode Go toolkit (dsh-opencode-go) · Composer shortcuts (dsh-composer-keys). The settings order is exactly this order.
- **How each change takes effect is stated per plugin**: install/uninstall edits the profile's bundle list, which the engine assembles only at boot, so it **needs an engine restart**; enable/disable writes the patch layer, which the engine **hot-reloads live**; a plugin with a page half (`dsh.client`) additionally needs a **Harness page reload** for that half. The two general rules live in the section note (repeating them on every row only made the window taller); the **per-plugin difference — “page half · reload page” — is a small tag on that row**. The GUI detects the page half from the plugin's package.json (an uninstalled npm entry cannot be inspected, so nothing is tagged).
- **`dsh-opencode-go`** handles the OpenCode / OpenCode Go routes end to end: (1) it declares the route wire protocol (`api: openai-completions`), fixing the `needs an api` error and the refused save for models the installed catalog does not describe (e.g. `deepseek-v4.1-flash`); (2) after boot it appends the DeepSeek V4.1 models to the route's model list whenever the route exists and they are missing (idempotent, written to `settings.yaml`); (3) it attaches a stable per-conversation `x-opencode-session` header to OpenCode requests (fixes 400 MissingSessionID; defaults to an opaque UUID and never sends the internal session id). **It merges the former `dsh-opencode-go-session` and `dsh-opencode-go-api`** — on upgrade the GUI unregisters the old packages and installs this one (carrying the disabled choice across), so old and new never load side by side.
- **`dsh-model-usage`** shows **the active model's** usage / balance right of the session title, split by the session's current model route (each half appears only for its own models):
  - OpenCode Go models (`opencode-go` / `opencode`) → plan usage (rolling / weekly / monthly percentages + reset time). The host resolves `OPENCODE_GO_API_KEY` through `ctx.credentials` and calls `GET https://opencode.ai/zen/go/v1/usage`.
  - DeepSeek models (route `deepseek-official`) → **account balance** (total / granted / topped-up; `is_available:false` renders as "insufficient"). The host resolves `DEEPSEEK_API_KEY` and calls `GET https://api.deepseek.com/user/balance`.
  Both upstreams run in the host half, so no key ever reaches the browser; the page half only decides *which* section to show from `ctx.modelDirectories`' `current.provider`. **This plugin used to be `dsh-opencode-go-usage` (OpenCode Go only) and was renamed when DeepSeek balance was added** — on upgrade the GUI unregisters the old package and installs the new one (carrying the disabled choice across), so the two never load side by side.
- **Uninstall**: uncheck in Settings, or use dsh-market / `dsh plugin remove` (all the same mechanism).
- **Security note (from the settings page)**: third-party plugins run third-party code with your permissions — off by default; review their source before enabling.

### 🔐 Data, credentials & privacy

- **Controllable data directory**: defaults to the system `~/.dsh`; switchable to the app directory (`<userData>/dsh-home`). On switch, existing data is detected and you're asked whether to **move** it (stop engine → migrate → restart with the new directory).
- **Fresh session every launch**: the embedded window uses an in-memory session (cookies/login state never touch disk); a new `dsh` child process is spawned each launch and the whole process tree is cleaned up on exit.
- **Session history is kept**: sessions under `<DSH_HOME>/sessions/` and workspace records under `storages/` live inside the user data directory and follow the data-directory migration.

### 🌐 Language & appearance

- **Language is chosen on the Harness page; the shell follows**: there is **no** separate language/appearance section in the settings window (removed in v0.3.0 — it lives on the engine side). Change the language (follow system / 中文 / English) or theme (light / dark / system) in Harness's own settings and the DSH GUI shell — settings window, tray menu, dialogs, window theme — **follows immediately**, no restart.
- **How "follow system" resolves**: with `locale: system` (the default), the engine's `locale.preference` in `$DSH_HOME/settings.yaml` (the one the Harness page uses) wins; only then does it fall back to Electron's OS language.
- **Hot-published**: the main process watches `settings.yaml`, so a change on the page applies at once; values the GUI itself writes are skipped when equal, so there is no loop.
- **One consistent skin**: with `appearance: engine` (the default) the window theme matches Harness's `ui-theme.preference` — never a dark page in a light shell.

### 💬 Session experience

- **Reopen last conversation on launch**: the last-used session is remembered and reopened after restarting DeepSeek Harness (implemented by the bundled `dsh-gui-last-session` plugin, on by default).

### 🎛 Settings & persistence

- **Modal settings window**: while open, the main window cannot be operated or closed; reachable from menu `Settings → Open settings window…` (modal) or the tray "Settings" item.
- **Settings persist** to `<userData>/settings.json` and save on change.

---

## ⚙️ Settings (grouped by function)

### Engine update

| Setting | Default | Description |
|---|---|---|
| Engine update policy | **ask before updating** | silent update / ask before updating / notify only (no auto-update) |
| Version channel | **npm latest** | follow the npm `latest` tag; also "skip alpha" and "all prereleases" |
| Auto-check | on | when off, the registry isn't queried; the local engine is used directly (first launch without an engine still installs once) |
| Check interval | **fixed 30 min** | not adjustable; "Check Engine Update Now" in the settings window gives an immediate check |

### Third-party plugins

| Setting | Default | Description |
|---|---|---|
| Install checkbox | **mirrors reality** | no persisted "desired" set: installed → checked, not installed → unchecked; checking installs immediately, unchecking uninstalls |
| Enabled toggle | **mirrors reality** | shown for installed plugins only; turning it off does NOT uninstall — the engine just stops loading it; two-way live sync with the Harness plugin market |

> The legacy `autoPlugins` field in `settings.json` is **retired** as of v0.3.0 (any leftover value no longer affects anything).

### Data & desktop

| Setting | Default | Description |
|---|---|---|
| Data directory | **system ~/.dsh** | if the source directory has data, you'll be asked whether to move it |
| Close window | **hide to tray** | the other option is "quit directly" (close to quit, tray removed) |
| Reopen last conversation | **on** | the last used session is reopened after restarting DeepSeek Harness |

### Language & appearance

> **Not in the DSH GUI settings window**: the "Language" and "Appearance" rows were removed in v0.3.0 and now live in **Harness's own settings page**; the shell follows (see "Language & appearance" above). The settings window keeps: close behaviour, data directory, engine updates, third-party plugins.

> Settings persist to `<userData>/settings.json` and save on change; also reachable via menu `Settings → Open settings window…` (modal) or the tray "Settings" item.

---

## 🚀 Quick Start

Prerequisite (only for development / running from source): [Node.js](https://nodejs.org/) **≥ 23** (DeepSeek Harness engine relies on Node 23+'s zstd API; includes npm). Packaged builds ship a portable Node — end users don't need any runtime installed.

```sh
npm install        # install electron / build dependencies
npm start          # start DSH GUI
```

On first launch, the DeepSeek Harness engine is installed automatically (about 1–2 minutes, progress shown on the status page); after that it's only re-installed when Harness ships a new version.

---

## 📦 Architecture & Data

```
startup
 └─ single-instance lock → read settings.json → read Harness theme (ui-theme.preference)
     → create window (maximized, in-memory session)
         └─ boot()
             ├─ resolve Node: bundled portable → $DSH_SHELL_NODE → system PATH
             ├─ check for updates when needed (npm registry) → install/prompt per policy
             ├─ before launch: reconcile installed catalog plugins (pull bundled updates; never touch user-installed bundles)
             ├─ clean up renamed legacy plugins (drop from bundles + dependencies so two versions never load at once)
             ├─ spawn node <engine>/lib/bin.js web --no-open --port 0
             ├─ parse `dsh web: <url>` from stdout → load embedded
             └─ exit: kill process tree + destroy tray
```

All DeepSeek Harness user data lives under `$DSH_HOME` (default `~/.dsh`):

| Content | Path |
|---|---|
| Model / system / plugin settings | `<DSH_HOME>/settings.yaml` (incl. `ui-theme.preference`) |
| Session history | `<DSH_HOME>/sessions/<encoded-project-path>/<session-id>/session.jsonl.zstd` |
| Workspace records | `<DSH_HOME>/storages/` (workspace business files stay in the real directory) |
| Profile config & overlays | `<DSH_HOME>/profiles/web/...` |
| Credentials / attachments / anonymous ID | `<DSH_HOME>/credentials…` etc. |

### Directory structure

```
├─ src/                   # app source (main process / pages / utility modules)
│  ├─ main.js             # main process: engine updates, window, tray, settings, data migration
│  ├─ plugin-manager.js   # third-party plugin management (catalog + dsh plugin install reconciliation)
│  ├─ engine-patch.js     # small idempotent patches to the engine client
│  ├─ preload.js          # settings-window IPC bridge
│  ├─ workspace-preload.js# main-window narrow bridge (remember/read last session)
│  ├─ settings.html       # settings window (modal)
│  ├─ status.html         # startup/update status page (follows Harness theme)
│  ├─ notice.html         # persistent update badge
│  └─ home-migrate.js     # data-dir detection & migration (pure Node, unit-testable)
├─ plugins/               # repo-bundled local plugins (shipped inside app.asar)
│  ├─ dsh-model-usage/           # model usage & balance (OpenCode Go usage + DeepSeek balance)
│  ├─ dsh-gui-last-session/      # reopen the last conversation on launch
│  ├─ dsh-opencode-go/           # OpenCode Go toolkit (protocol + V4.1 models + session header)
│  └─ dsh-composer-keys/         # composer shortcuts (Enter / Shift+Enter / Ctrl+Enter)
├─ scripts/               # build & test scripts
│  ├─ make-icons.mjs      # official favicon → icons at all sizes + win hybrid icon.ico
│  ├─ ico-info.cjs        # inspect any .ico's frames and length consistency
│  ├─ exe-icon-info.cjs   # inspect an exe's embedded icon resources (RT_ICON / RT_GROUP_ICON)
│  ├─ bundle-node.mjs     # portable Node download/unpack (idempotent + archive cache)
│  ├─ ensure-electron.mjs # local Electron release zip cache (SHA-256 verified)
│  ├─ fix-unpacked.mjs    # rename + generate zip
│  ├─ after-pack.js       # electron-builder hook: ship the bundled Node in full
│  ├─ push-all.ps1        # push branch + tags to the three platforms
│  ├─ publish-all.ps1     # build + publish releases on the three platforms
│  └─ smoke-*.ps1         # Windows E2E smoke tests
├─ marketing/            # marketing assets (versioned dirs: v0.1.0 / v0.2.0 / v0.3.0 / …)
│  └─ v0.3.0/            # CSDN/Zhihu/Juejin/Sspai articles, promo copy pack, Bilibili script
├─ resources/icons/       # official favicon sources (svg/ico)
├─ electron-builder.yml   # packaging config (win/mac/linux)
└─ dist/                  # build output (gitignored)
```

---

## 🔧 Environment variables (optional)

| Variable | Purpose |
|---|---|
| `DSH_SHELL_NODE` | Node executable used to run the engine (bundled Node preferred by default) |
| `DSH_SHELL_HOME` | Override `DSH_HOME` for this launch (test isolation) |
| `DSH_SHELL_USERDATA` | Redirect the whole userData (engine/settings/npm cache) |
| `DSH_SHELL_REGISTRY_URL` | Version check source (full packument URL, e.g. `https://registry.npmmirror.com/@deepseek-ai/dsh`) |
| `DSH_SHELL_AUTOQUIT_MS` | Gracefully quit N ms after the UI loads (CI / smoke tests) |
| `DSH_SHELL_TEST_LATEST` / `DSH_SHELL_TEST_NOTICE` / `DSH_SHELL_TEST_OPEN_SETTINGS` | Test hooks |
| `DSH_SHELL_TEST_AUTODISABLE` | =1 skips the "auto-disable plugin after startup failure" hook (testing) |
| `DSH_SHELL_TEST_BREAK_PLUGIN` | Force a plugin startup failure to exercise the auto-remove/diagnostic flow (testing) |
| `DSH_SHELL_PAGE_DEBUG` | =1 forwards the embedded page console to the main-process log and prints a page-bridge probe (debugging) |
| `DSH_NODE_VERSION` / `DSH_NODE_MIRROR` | Bundled Node version and download mirror used when packaging |
| `DSH_NODE_ARCH` / `DSH_NODE_PLATFORM` | Override the target platform/arch of the bundled Node (e.g. CI cross-builds the x64 macOS app on an Apple Silicon runner with `DSH_NODE_ARCH=x64`) |

---

## 🛠 Packaging

### Packaging

```sh
npm run make-icons    # render icons at all sizes (build/, src/; also emits
                      #   build/icon.ico — white bg + brand-blue glyph,
                      #   multi-size mixed frames)
npm run bundle:node   # ensure portable Node is unpacked (idempotent: skips when
                      #   version/platform already match; archives cached in
                      #   resources/.node-cache/, so removing the dir still
                      #   re-extracts without downloading; --force re-downloads)
npm run ensure:electron # cache the Electron release zip locally (downloaded once
                      #   and SHA-256 verified; dist:win then feeds it to
                      #   electron-builder with zero network)
npm run dist:win      # Windows → dist/DSH-GUI-WIN/ + .zip + NSIS installer + portable zip
                      #   (Electron comes from the local cached zip — no "Downloading…" each run)
npm run dist          # combined win + linux build (platform limits apply — see below)
npm run dist:mac      # macOS   → dist/DSH-GUI-MAC/ + .zip + .dmg (requires macOS)
npm run dist:linux    # Linux   → dist/DSH-GUI-LINUX/ + .zip + .AppImage
```

> After changing the icon, **reinstall/replace the build output**: Explorer caches
> old icons — if a stale one still shows, restart Explorer (or delete
> `%LocalAppData%\IconCache.db`). `node scripts/ico-info.cjs build/icon.ico` prints
> the .ico's frames.

- **Directory naming**: electron-builder's `*-unpacked` dirs are renamed to `DSH-GUI-WIN` / `DSH-GUI-MAC` / `DSH-GUI-LINUX` by `scripts/fix-unpacked.mjs`, which also produces same-named **`.zip`** files (unzip = ready-to-run directory).
- **Bundled Node**: downloaded per platform by `scripts/bundle-node.mjs` (default v26; the engine's session persistence needs Node ≥ 23's zstd API). `scripts/after-pack.js` copies it into the app in full before packaging (`extraResources` can't be used — it drops `node_modules`, leaving bundled Node without npm). If the bundled Node has no npm, `npm` falls back to the host Node's npm-cli automatically.
- **Platform limits**: AppImage's `mksquashfs` only runs on Linux/macOS, so the linux step of `npm run dist` on Windows fails with `ENOENT`; build each platform on its own OS or in CI/Docker (e.g. `electronuserland/builder`).
- **Cross-arch macOS**: CI builds the x64 macOS package on an Apple Silicon runner by setting `DSH_NODE_ARCH=x64` (see `.github/workflows/build-all.yml`), so each dmg bundles a Node matching its architecture.

---

## 🧪 Testing

```sh
npm start                                   # run the app
# Pure-function unit tests for the engine patch utility:
node src/test/engine-patch.test.cjs
# Plugin-state drift unit tests (settings window <-> plugin market sync):
node src/test/plugin-state.test.cjs
# Windows E2E (real WM_CLOSE validating close/tray/modal behavior):
powershell -File scripts/smoke-close.ps1 -Mode quit   # "quit directly" mode
powershell -File scripts/smoke-close.ps1 -Mode tray   # "hide to tray" mode
powershell -File scripts/smoke-modal.ps1              # modal settings window
powershell -File scripts/smoke-profile-watch.ps1      # market disable -> live settings sync
```

---

## ❓ FAQ

- **First launch is slow / the status page shows "Downloading and installing…"**: the DeepSeek Harness engine is being installed automatically; this only happens once.
- **`npm run dist` fails on Windows with `mksquashfs ENOENT`**: AppImage can only be built on Linux/macOS (or Docker/CI) — see Packaging → Platform limits.
- **Sessions disappear after switching the data directory**: when switching, you're asked whether to move existing data; choosing "switch only" keeps the data in place.
- **Language changes don't fully apply**: the language is chosen on the **Harness settings page** (the settings window no longer offers a language row as of v0.3.0). The choice is written to `locale.preference` in the engine's `settings.yaml`; the shell (settings window / tray menu / dialogs) follows via a file watch, and the embedded Harness page hot-switches with it. If the page doesn't refresh immediately, wait a moment or restart the app.
- **Want config/sessions to live entirely with the app directory**: switch the data directory to "app directory" in settings and confirm the migration; then backup/migrate/delete the whole package at once.
- **Relation to the official CLI**: this shell is only a launcher/wrapper — it runs the official `@deepseek-ai/dsh`; any Harness capability question should go to the [DeepSeek Harness docs](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart).

---

## 🏷 Recommended Topics (repo metadata, already set in GitHub → Settings → Topics)

`deepseek` · `deepseek-harness` · `electron` · `ai-agent` · `agent-framework` · `desktop-app` · `cross-platform` · `automation`

## 📄 License

[MIT](LICENSE) · This is an independent open-source shell with no affiliation to the DeepSeek Harness team; DeepSeek Harness itself is [MIT](https://github.com/deepseek-ai/deepseek-harness).