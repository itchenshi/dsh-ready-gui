# dsh-keys-setting

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

Decide in **DSH Settings → General** whether **Enter / Shift+Enter / Ctrl+Enter (⌘ on macOS) sends the message or inserts a line break**.

## What it does

- Adds a "Key bindings" row to Settings → General, with one picker per gesture (Send / Line break).
- Listens for `keydown` on the composer in the capture phase: it intercepts only when your choice differs from the engine's native behaviour, then re-dispatches the engine's other gesture.
- Remaps the gesture only — it never touches the content; what "send" and "newline" mean stays the engine's decision.
- Always passes IME events (`isComposing` / keyCode 229) and `Alt+Enter` through.
- Defaults equal the engine's native behaviour, so with untouched settings it intervenes zero times.

## Install

- **Using DSH Ready GUI (recommended)**: the plugin ships inside the GUI. Open the GUI → Settings → "Third-party plugins" and tick **Key bindings**, then refresh the page as prompted (it has a page half).
- **Any other DSH host** (`dsh web`, the CLI) — either route works:

  ```sh
  # Recommended: install straight from GitHub
  dsh plugin --profile web add github:itchenshi/dsh-keys-setting

  # Fallback: install this release's tarball
  dsh plugin --profile web add https://github.com/itchenshi/dsh-keys-setting/releases/download/v0.2.6/dsh-keys-setting-0.2.6.tgz
  ```

  Both land the full repository contents (including `cordis.patch.yml`); no extra configuration is needed afterwards.

> Not on npm yet (`registry.npmjs.org` has no such package), so use one of the two routes above.

## Usage

In Settings → General, the new "Key bindings" row is where you set them; changes apply immediately.

You can also hand-edit the row `id: composer-keys` in the profile's `cordis.patch.yml`: the host half **re-reads when the page window regains focus**, so switching back to the Harness window applies it without a page reload.

## Configuration

The `config` of the row `id: composer-keys` in `cordis.patch.yml` (all three fields are declared by the plugin's `Config` schema):

| Key | Default | Meaning |
|---|---|---|
| `enter` | `send` | `send` = send the message, `newline` = insert a line break |
| `shiftEnter` | `newline` | Same, for Shift+Enter |
| `ctrlEnter` | `send` | Same, for Ctrl+Enter (⌘ on macOS) |

The row's `config` block is required: without it the row has no settings entry and the host can neither read nor write the preference. When `config.enabled === false` the host returns immediately — no route, no settings row.

## Compatibility

- Requires **DSH >= 0.2.0-rc.2** (engine 0.2.0 replaced the settings service API; on 0.1.x the preference cannot be saved).
- Node >= 20.
- Runtime dependencies: none; the schema library is the engine's own `@deepseek-ai/schemastery`.

## FAQ

**A change had no effect?** Changes made in the settings window apply immediately; after a hand edit, switch back to the Harness window to trigger the re-read. At startup the host logs `[composer-keys] route ready at /composer-keys (entry composer-keys)` — if that line is missing, the plugin did not load.

**What if the engine is too old?** The manifest declares `>=0.2.0-rc.2` only; older engines expose the retired settings service (`register` / `get` / `section`), so the plugin cannot save the preference.

**What does it store, and where?** Only those three values, in the plugin's own row config (the engine's settings document). The plugin reads and writes no files itself.

**Can another local program read or change the preference?** The host exposes exactly one route, `GET/POST /composer-keys`, behind the engine's own trust fence (Host allow-list + browser session cookie) and it **fails closed** — a bare `curl` without the cookie gets 401. The plugin makes no outbound network requests.

## Development

```sh
node --check lib/index.js
node --check client/client.js
npm test        # node tests/test.mjs: gesture recognition, intervention, IME pass-through, defaults never intervene
```

## License

MIT
