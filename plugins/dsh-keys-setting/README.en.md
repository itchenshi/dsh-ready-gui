# dsh-keys-setting

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

Configure the composer's shortcut keys in **DSH Settings → General**: **Enter / Shift+Enter /
Ctrl+Enter (⌘ on macOS) each set to "send message" or "newline"**.

```
设置 → 通用
  ┌──────────────────────────────────────────────────────────┐
  │ 按键设置                                                  │
  │ 设置 Enter / Shift+Enter / Ctrl+Enter 是发送消息还是换行   │
  │                                    Enter       [发送消息 ▾] │
  │                                    Shift+Enter [换行     ▾] │
  │                                    Ctrl+Enter  [发送消息 ▾] │
  └──────────────────────────────────────────────────────────┘
```

## Defaults = the engine's native behaviour

Left untouched the plugin intervenes **0** times — behaviour is exactly the same as without it:

| Gesture | Engine native | Plugin default |
|---|---|---|
| `Enter` | Send | Send |
| `Shift+Enter` | Newline | Newline |
| `Ctrl/Cmd+Enter` | Send | Send |

`Ctrl+Shift+Enter` counts as the Shift gesture (in the engine's key table the Shift rule matches first).

## How it works (the essentials)

- **It only intercepts when "your choice ≠ the engine's native behaviour"**: it listens to the
  composer's `keydown` in the capture phase and, on a hit, calls `preventDefault` + re-dispatches
  **the engine's own other gesture** (a synthetic `Shift+Enter`, or a synthetic `Enter`).
  What newline/send mean is still decided by the engine; the plugin never touches the editor contents.
- **The composer is identified by the engine's semantic attribute** `data-composer-input="true"`
  (not a hashed class name, and not "any contenteditable"), so it never hits the sidebar plugins'
  own editors.
- **It never interferes with the IME**: events with `isComposing` or `keyCode === 229` are let through.
- **Alt+Enter is let through completely** (that is the engine's own accelerator gesture).

> Synthetic (`isTrusted: false`) keyboard events **do drive the engine's composer** — this was
> verified on the real page with a CDP side-by-side comparison: a trusted Shift+Enter and a synthetic
> Shift+Enter produced **exactly the same DOM change** (inserting
> `<br data-lexical-managed-linebreak="true">`), and a synthetic Enter really did submit the message.

## The two halves

| Half | File | Runs in | Responsibility |
|---|---|---|---|
| Host | `lib/index.js` | Node | Registers the `composer-keys` namespace with the engine settings service (values land in `settings.yaml`, which travels with the data directory) and exposes `GET/POST /composer-keys` |
| Page | `client/client.js` | Browser | Registers that "Settings → General" row + remaps keys in the capture phase |

> **The route is protected by the engine's trust fence** (Host allowlist + browser session cookie):
> it both reads and **writes** this preference, so a bare `curl` without a cookie gets
> `401 unauthorized`. Same-origin page requests carry the cookie automatically; calling it by hand
> needs a session cookie exchanged first (example in `dsh-gui-last-session/README.md`). The fence
> lives in the dependency-free `lib/shared.js` (`rejectUntrusted`) and has unit tests covering
> fail-closed and the 401/403 mapping.

**Why the host half is needed**: the page comes from a random port that changes on every start (the
shell uses `dsh web --port 0`), so browser storage effectively changes origin every time and cannot
persist; the engine's **settings document**, by contrast, is persistent and migrates with the data
directory. The page half cannot reach the plugin's own namespace (the settings RPC domain only
serves fixed namespaces to configuration clients), so the host route relays it — the same approach
third-party sidebar plugins use for their own preferences.

## Configuration

Preferences live in the `composer-keys` section of `$DSH_HOME/settings.yaml` and can be edited by hand:

```yaml
composer-keys:
  enter: newline       # Enter inserts a newline
  shiftEnter: newline  # Shift+Enter inserts a newline (default)
  ctrlEnter: send      # Ctrl+Enter sends (default)
```

After editing the file by hand, **switching back to the Harness window applies it** (the plugin
re-reads when the window regains focus) — no page refresh needed; changing it in the settings window
takes effect immediately.

The plugin row's switch (optional, written in the row config of `cordis.patch.yml`):

```yaml
- insert:
    - id: composer-keys        # row id decoupled from the package name, deliberately kept (see below)
      name: dsh-keys-setting
      config:
        enabled: true    # when false the plugin is not loaded at all (no route, no settings row)
```

## Install

> **Not on npm yet — the only install path today is from source.**
>
> The plan was to publish the four bundled plugins to npm, so that `dsh plugin add dsh-keys-setting` would
> work in any DSH host. npm account sign-up is currently unreachable: `www.npmjs.com` answers its
> sign-up/sign-in pages with a Cloudflare managed challenge (`registry.npmjs.org` itself is
> reachable — sign-up is what is blocked), so no account can be created and nothing can be
> published. Therefore:
>
> - **Using DSH Ready GUI**: these four plugins ship inside the GUI — open Settings → Third-party
>   plugins and tick the row, no command line needed. (Installing your own checkout by hand in the
>   GUI is deliberately reverted by boot maintenance.)
> - **Other DSH hosts** (`dsh web`, the CLI, …): install from source as described below.
>
> Publishing to npm will resume once sign-up works; `dsh plugin --profile web add dsh-keys-setting` will work
> then.

**Option 1 — DSH Ready GUI (recommended)**: these four plugins ship inside the GUI. Open the GUI →
Settings → Third-party plugins → tick **按键设置（dsh-keys-setting）**. Install, uninstall and
enable/disable all live in that window; restart the engine when it says so.

**Option 2 — any other DSH host**: clone this repository, then install it by **directory**:

```sh
git clone https://github.com/itchenshi/dsh-keys-setting.git
dsh plugin --profile web add file:<absolute path of the clone>
```

That installs the real on-disk directory, so a later `git pull` updates the very code in use — but
moving or deleting the directory breaks the dependency (just add it again).

Restart **`dsh web`** after installing (or reopen the DSH GUI); the row **按键设置** then shows at the
bottom of the General page in the settings window.

> **About the package name**: this plugin was originally called `dsh-composer-keys`, but that name is
> already taken by another author on npm, so the package name is now `dsh-keys-setting`.
>
> **The row id and the settings namespace are still `composer-keys`, deliberately**: the patch
> layer's disabled row, the marketplace `state.json` switch, and the key bindings you saved in
> `settings.yaml` are all recorded under that name. The package name is only the identifier used at
> install time; changing it must not invalidate your existing key bindings or your enable/disable
> choice.
>
> Upgrades are handled automatically by DSH GUI boot maintenance (the old package name is removed
> and the disabled choice is carried over to the new package).

## Permissions, dependencies and failure boundaries

Marketplaces that pin the repository to a commit before reviewing it (DSH STORE and the like)
statically scan the runtime code and derive permission conclusions from the signals they detect.
The facts are stated here once, so they do not have to be inferred:

- **Runtime dependency: `schemastery`** (a pure-JS schema validation library, no native artifacts,
  no install scripts). The host half uses it to register this plugin namespace's schema with the
  engine's settings service. It is this plugin's only `dependencies` entry.
- **Files: this plugin reads and writes no file directly.** Preference values land in
  `$DSH_HOME/settings.yaml` through the engine's own settings service — there is no `node:fs` in the
  source. The "files signal" a scanner reports comes from that indirect write via the settings
  service (plus the references to `settings.yaml` in code comments), not from direct disk access.
- **Local routes: yes, one.** The host half registers `GET/POST /composer-keys` so the page half can
  read and write the preference — the page cannot reach the plugin's private settings namespace
  (the settings RPC domain only serves fixed namespaces), so this is the only channel. That route
  goes through the engine's own trust fence (Host allowlist + browser session cookie) and is
  **fail-closed** when the fence is unavailable.
- **Outbound network: none.** The page half's `fetch` only hits that same-origin route above.
- **Credentials / commands / native artifacts / lifecycle scripts: none.**
- **Failure boundary**: when the route or the settings service is unavailable, the keyboard engine
  **still works** (only persistence or the settings entry point is lost) — that is a degradation,
  not a crash. After uninstalling, the `composer-keys` namespace stays behind in `settings.yaml`;
  rebuilding the plugin restores the previous settings.

## Settings row styling (following the General page)

Font, colours, spacing and the **selector** all follow the declarations of the General page's other
rows item by item:

- The row shell and typography come from the engine's `settings.general.item` row (`.row/.rowText/.title/.desc/.selector`);
- The **selector** is identical to the control on the **对话显示** row — likewise a **`<button>` pill
  + arrow SVG + popover**, rather than a native `<select>` (a native control draws its own arrow and
  padding and could never be matched, so the first version was replaced);
- The popover comes from the engine's Menu component (`._list_/._portal_/._item_/._itemLabel_/._check_`): radius 20px, inset 4px,
  min width 218px, `position:fixed`, `z-index:1100`, items 40px high / `8px 10px` padding / 10px radius,
  with the selected item marked by a check icon.

| Element | Declaration |
|---|---|
| Title | `14px / 400 / var(--dsw-alias-label-primary)`, line-height 22px |
| Description | `12px / var(--dsw-alias-label-tertiary)`, line-height 18px |
| Row container | `padding:16px 0`, bottom `0.5px solid var(--dsw-alias-border-l2)` |
| Pill selector | `height:36px`, `border-radius:18px`, `padding:0 14px`, `gap:12px`, `background:var(--dsw-alias-bg-module-platform)`, hover `--dsw-alias-interactive-bg-hover` |
| Popover panel | `var(--dsw-alias-bg-base)`, radius 20px, inset 4px, min width 218px |

All colours go through engine theme variables, so light and dark themes follow automatically.

**Measured** (computed styles read inside the real settings dialog): the pill's height / radius /
background / padding / font size / line height / gap / colour are **equal to the 对话显示 control on
all 8 items**; the popover's radius, inset, min width, positioning, stacking level and item size all
match too; and after clicking, the configuration really is written back (the `composer-keys` section
of `settings.yaml`).

> The bottom separator measurably does not show, and that is the engine's own rule:
> `._WvWnq_section > [data-slot="settings.general.item"] > :last-child { border-bottom: medium }`
> removes the separator from the **last row** of that list; this row has order=21 and sits after the engine's composer-Enter row (order=20), so it is treated the same way.

We deliberately do not `import` the engine's UI primitives (which would let us use the very same Menu
component): declaring the engine client package in `dsh.client.inject` makes the whole bundle
register twice (this pitfall is already recorded in the repository), and the module loader also
refuses external modules requested before it has started. So an equivalent control was rewritten
here from the engine's CSS declarations.

## Development

```sh
node --check lib/index.js
node --check client/client.js
npm test        # local behaviour tests (no network, no engine, no DOM)
```

`tests/test.mjs` covers: gesture recognition (including `Ctrl+Shift` folding and the Alt
pass-through), the intervention decision for the three gestures × two actions, the IME
pass-through, invalid preference values not intervening, and the key property that
"the defaults do not intervene".

## License

MIT
