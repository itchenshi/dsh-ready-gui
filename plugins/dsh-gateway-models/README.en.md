# dsh-gateway-models

A host-only plugin: it supplies the protocol, endpoint and model lists the engine cannot derive for gateway routes (OpenCode Go + Command Code), and attaches a session header to OpenCode requests.

## What it does

- Declares the `opencode-go` route's wire protocol (`api: openai-completions`), so a catalog-unknown model no longer fails with `needs an api`.
- At startup it reads the engine's own model catalog, adds the DeepSeek V4.1 models to the `opencode-go` list and puts them **first** (entries you configured are kept, in their own order).
- Supplies `https://opencode.ai/zen/go/v1` when the route has no `baseURL`; an address you set yourself is left untouched.
- Declares `api` + `baseURL` for the `commandcode` route (you supply only the key), and completes its model list from the provider's **public catalog** (add-only, idempotent).
- Attaches `x-opencode-session` to requests routed to OpenCode / OpenCode Go: a random UUID per session by default, and the **internal session ID is never sent to a third party** (`mode: 'session-id'` is an explicit opt-in).

## Install

- **Using DSH Ready GUI (recommended)**: the plugin ships inside the GUI. Open the GUI → Settings → "Third-party plugins" and tick **Gateway routes**, then **restart the engine** as prompted (it has no page half).
- **Any other DSH host** (`dsh web`, the CLI) — either route works:

  ```sh
  # Recommended: install straight from GitHub
  dsh plugin --profile web add github:itchenshi/dsh-gateway-models

  # Fallback: install this release's tarball
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gateway-models/releases/download/v0.2.6/dsh-gateway-models-0.2.6.tgz
  ```

  Both land the full repository contents (including `cordis.patch.yml`); no extra configuration is needed afterwards.

> Not on npm yet (`registry.npmjs.org` has no such package), so use one of the two routes above.

## Usage

There is no page half and no window to open — after the engine restarts the plugin edits the route configuration for you. Confirm it worked in the session model selector: the **first** entry is `DeepSeek V4.1 Flash`, and it comes first under `llm-pi-ai.providers.opencode-go`.

The Command Code half touches settings only for routes **you configured yourself** (a user-layer entry, e.g. after adding the key), and recognises them by **endpoint** (`api.commandcode.ai`) — the route may be named `commandcode`, `commandcode-goat` or anything else.

## Configuration

The `config` of the row `id: opencode-go` in `cordis.patch.yml`, all optional:

| Key | Default | Meaning |
|---|---|---|
| `providers` | `[opencode, opencode-go]` | route names to attach the session header to; add your own route key |
| `commandcodeProviders` | none | extra Command Code route ids; only needed when a route's endpoint is not visible in the config |
| `mode` | `uuid` | `uuid` = random UUID per session (safe default); `session-id` = send the internal session ID |
| `debug` | `false` | `true` logs every streaming call that received the header |
| `debugFile` | none | path to append JSON lines to; **only** paths under `$DSH_HOME/logs` or the system temp dir take effect, and appending stops at 8 MiB |

## Compatibility

- Requires **DSH >= 0.2.0-rc.2** (engine 0.2.0 replaced the settings service API; on 0.1.x the route configuration cannot be written).
- Node >= 20.
- It depends on the public contracts of the assembly layer, the `settings` service and the `llm` events; if those change, the engine explicitly reports a plugin load failure instead of failing silently.

## FAQ

**The V4.1 model is missing?** Look for `[gateway-models] active for providers [opencode, opencode-go] with mode uuid (debug=off)` in the host log. If you instead see `llm.discoverModels() is unavailable` or `could not detect the "opencode-go" model catalog`, the engine's catalog is unreadable — the plugin then **skips** the auto-add rather than guessing.

**The Command Code model list was not completed?** The normal line is `[gateway-models] "commandcode": N model(s) from the provider catalog (list X -> Y)`; if you see `could not read the Command Code model catalog (...)`, that public catalog request failed and the existing list is left alone.

**Does it read my API key?** No. It only writes route configuration; the engine resolves the key itself from `apiKeyEnv`. Its single outbound request is `GET https://api.commandcode.ai/provider/v1/models` — public, no key required, no `Authorization` header. It registers no local HTTP route either.

**Can a failed write leave half a config?** No. Writes go through the `settings` service and re-run the engine's strict validation; a rejected write is refused as a whole, with the reason logged.

## Development

```sh
node --check lib/index.js
npm test        # node tests/test.mjs: local behaviour tests (no network, no engine)
```

Add an entry to `V4_1_MODELS` to support another V4.1 model. `planRouteUpdate()` / `withV41ModelsFirst()` / `withV41Defaults()` / `isV41()` decide "what to write", "how to hoist", "how to fill gaps" and "is it a v4.1 model", and all four are unit-tested.

## License

MIT
