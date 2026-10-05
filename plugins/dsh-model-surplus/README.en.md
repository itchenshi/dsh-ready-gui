# dsh-model-surplus

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

Shows the **active model's usage / plan quota / account balance** right of the session title — whichever model the conversation is on, that is the number you see.

## What it does

- A widget right of the session title; the **active model selection** decides which figure is shown, and switching models shows or hides it immediately.
- OpenCode Go: rolling / weekly / monthly percentages, plus the selected model's monthly cap (`cap $60`).
- DeepSeek: account balance (total / granted / topped up); shows "insufficient" when it is unavailable.
- Command Code: the 5-hour and weekly windows' used / cap, plus the account's remaining credits.
- The three sections report independently: with one key configured the other halves still work, and a missing half shows a reason (`no key` / `usage n/a`).

## Install

- **Using DSH Ready GUI (recommended)**: the plugin ships inside the GUI. Open the GUI → Settings → "Third-party plugins" and tick **Model surplus**, then refresh the page as prompted (it has a page half).
- **Any other DSH host** (`dsh web`, the CLI) — either route works:

  ```sh
  # Recommended: install straight from GitHub
  dsh plugin --profile web add github:itchenshi/dsh-model-surplus

  # Fallback: install this release's tarball
  dsh plugin --profile web add https://github.com/itchenshi/dsh-model-surplus/releases/download/v0.4.6/dsh-model-surplus-0.4.6.tgz
  ```

  Both land the full repository contents (including `cordis.patch.yml`); no extra configuration is needed afterwards.

> Not on npm yet (`registry.npmjs.org` has no such package), so use one of the two routes above.

## Usage

After installing, restarting the engine and refreshing the page, the widget appears **right of the session title** and polls the host route every 60 seconds.

Every upstream request is made on the host side, and the key is read by reference through the engine's credential service (first the route's own `apiKeyEnv`, then the section's default reference name); **keys never reach the browser**.

| Section | Default credential reference |
|---|---|
| OpenCode Go | `OPENCODE_GO_API_KEY` |
| Command Code | `COMMANDCODE_GOAT_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

## Configuration

The `config` of the row `id: model-usage` in `cordis.patch.yml`, all optional:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the whole plugin return immediately |
| `opencodeGo.baseUrl` | `https://opencode.ai/zen/go/v1` | upstream root |
| `opencodeGo.apiKeyRef` | `OPENCODE_GO_API_KEY` | credential reference |
| `opencodeGo.providers` | `[opencode-go, opencode]` | routes treated as OpenCode Go |
| `deepseek.baseUrl` | `https://api.deepseek.com` | upstream root |
| `deepseek.apiKeyRef` | `DEEPSEEK_API_KEY` | credential reference |
| `deepseek.providers` | `[deepseek-official]` | routes treated as DeepSeek |
| `commandcode.baseUrl` | `https://api.commandcode.ai` | quota API root; the chat URL `.../provider/v1` is accepted too |
| `commandcode.apiKeyRef` | `COMMANDCODE_GOAT_API_KEY` | credential reference |
| `commandcode.providers` | `[commandcode-goat, commandcode]` | routes treated as Command Code |

A top-level `baseUrl` / `apiKeyRef` / `providers` is still read as the `opencodeGo` section (the plugin used to be OpenCode-Go-only).

## Compatibility

- Requires **DSH >= 0.1.5-rc.2** (the manifest marks 0.1.5-rc.2 and 0.2.0-rc.2 compatible); Node >= 20.
- Earlier engine versions are untested; each of the three sections degrades on its own.

## FAQ

**No widget?** It only appears while the active model belongs to a tracked route; add a custom route name to that section's `providers`.

**It says `no key`?** That section found no credential. At startup the host logs `[model-usage] active (opencode-go: providers=opencode-go|opencode key=OPENCODE_GO_API_KEY; ...)` — if that line is missing, the plugin did not load.

**How fresh is the data?** Each section is cached for 120 seconds (a failure is not retried for 30 seconds). The per-model monthly caps come from the public docs page `https://opencode.ai/docs/zh-cn/go/` (no key needed) and are cached at `<DSH_HOME>/logs/model-surplus-limits.json`; they refresh every 24 hours and fall back to the cache, then to a built-in table (logs: `[model-usage] limits refreshed from docs (...)` or `limits refresh failed (...)`).

**Why do the percentages not match the cap?** The usage percentages are **account-wide** (the upstream endpoint ignores per-model parameters); the monthly cap is for the **selected model**.

## Development

```sh
node --check lib/index.js
npm test        # node tests/test.mjs: local behaviour tests (no network, no engine)
```

`tests/e2e.cjs` is the integration check against a real engine and browser; it needs a running profile, so it is not part of `npm test`.

## License

MIT
