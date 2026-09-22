# dsh-opencode-go-path

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

One plugin for the OpenCode / OpenCode Go routes: **install it, tick it, done** — no hand-editing
config, no command line.

## What it fixes for you

| The problem you hit | What the plugin does |
|---|---|
| `deepseek-v4.1-flash` is missing from the model list, and adding it fails with `needs an api` | Declares the route's wire protocol, so models the catalog doesn't describe work too |
| Newly released models never show up in the catalog | Detects the route's catalog at engine startup, adds the DeepSeek V4.1 models and puts them **first** |
| The model is there but requests fail and saving it is refused | Supplies the route `baseURL` (a model outside the catalog has nowhere to point without it) |
| Multi-turn calls fail with **400 `MissingSessionID`** | Attaches a per-conversation `x-opencode-session` header to OpenCode requests |
| Multi-turn calls fail with **400 `reasoning_content` must be passed back** | Supplies the DeepSeek thinking-protocol declaration a catalog-unknown model is missing |

## Install and go

- **Using DSH Ready GUI (recommended)**: the plugin **ships inside the GUI**. Open the GUI → Settings
  → Third-party plugins → tick **OpenCode Go routes**, then restart the engine as prompted.
- **Any other DSH host** (`dsh web`, the CLI):

  ```sh
  git clone https://github.com/itchenshi/dsh-opencode-go-path.git
  dsh plugin --profile web add file:<absolute path of the clone>
  ```

  That installs the real on-disk directory, so a later `git pull` updates the very code in use — but
  moving or deleting the directory breaks the dependency (just add it again).

> Not on npm yet: sign-up is unreachable (`www.npmjs.com` answers with a Cloudflare challenge), so
> nothing can be published. Use one of the two routes above; publishing resumes once sign-up works.

**How to confirm it worked**: the **first** entry in the session model selector is
`DeepSeek V4.1 Flash`, and `$DSH_HOME/settings.yaml` lists `deepseek-v4.1-flash` first under
`llm-pi-ai.providers.opencode-go` (the plugin also adds `baseURL: https://opencode.ai/zen/go/v1` if you
never set one).

## What it actually does

### 1. Declares the route protocol (config layer)

The engine resolves a model's `api` in this order:

```
route.api  ??  the model's api in the catalog  ??  the api shared by all models in the catalog
```

The `opencode-go` catalog spans three protocols (anthropic-messages / openai-completions /
openai-responses), so the third fallback cannot be inferred; a model outside the catalog (such as
`deepseek-v4.1-flash`) has no second fallback either. The engine then reports `needs an api`, and the
model page's strict validation refuses to save it.

Through `cordis.patch.yml` the plugin adds `providers.opencode-go.api: openai-completions` to the
`llm-pi-ai` row — the protocol OpenCode Go's OpenAI-compatible endpoint speaks.

### 2. Detects the catalog, adds the models, puts them first (runtime)

Once the `llm-pi-ai` settings namespace is ready, the plugin:

1. **Detects** the route's models through the engine's own `llm.discoverModels()`. For a route pi-ai
   ships a catalog for, that channel **answers the catalog with no network request**; the plugin
   passes no `baseURL` and no credential on purpose, so a route the catalog does not describe fails
   **before reaching the network**. Nothing detected means nothing is guessed.
2. **Completes and hoists**:
   - **you configured `models`** → the DeepSeek V4.1 models go to the **front**, your own entries stay
     in place and in order;
   - **you configured none** → the list is seeded from the detected catalog ("V4.1 first + every
     catalog model"). The engine treats a non-empty configured list as the provider's **complete** set,
     so writing only our models would replace the whole catalog — the seed has to come from the
     catalog, and nothing is lost;
   - "is the model already listed" is decided by **our own ids**, not the `deepseek-v4.1` prefix, so a
     future upstream sibling cannot displace the Flash we know.
3. **Supplies an endpoint when the route has none**: a catalog-unknown model resolves its endpoint as
   `route.baseURL ?? the model's baseUrl in the catalog ?? the provider-level baseUrl`, and opencode-go
   has no provider-level `baseUrl` — so without one the model can neither be sent nor **stored**
   (`needs a baseURL`). The plugin adds `https://opencode.ai/zen/go/v1` only when the route has none; a
   route you pointed somewhere else is left untouched. A hand-written config that already has the
   right order but no endpoint is repaired too.
4. **Is idempotent**: right shape, endpoint present → no write, no event, no loop.

### 3. Attaches the session header

OpenCode's relay pins requests carrying the same `x-opencode-session` to the same upstream backend,
keeping the prompt cache warm across one conversation (fixes 400 MissingSessionID).

**Safe by default**: every DSH session derives a random opaque UUID, and the **internal session ID is
never sent to a third party**. `mode: 'session-id'` is an explicit opt-in for people who fully trust
the upstream.

### 4. Supplies the thinking protocol a catalog-unknown model is missing (fixes 400 reasoning_content)

`deepseek-v4.1-flash` is not in the installed catalog, so the engine treats it as a plain model: it
neither asks for thinking nor replays `reasoning_content`. pi-ai detects its DeepSeek compatibility
from the **provider name or host**, and the OpenCode Go relay matches neither — so replayed history
omits `reasoning_content` and the upstream answers 400
(`The reasoning_content in the thinking mode must be passed back to the API`). Every multi-turn
conversation on that model fails.

The plugin supplies the declaration the catalog would have provided (byte-for-byte what the same
route's `deepseek-v4-flash` / `-pro` entries declare): `compat.requiresReasoningContentOnAssistantMessages`,
`thinkingFormat: deepseek`, and `reasoningEfforts`. It **fills gaps rather than overwriting**: a name,
limits or compat switch you changed is kept, so an entry you already added is upgraded in place instead
of needing to be deleted and re-added.

## Configuration (the `cordis.patch.yml` row config, all optional)

| Key | Description |
|---|---|
| `providers` | Route names to attach the session header to; default `['opencode', 'opencode-go']` |
| `mode` | `'uuid'` (default, safe) or `'session-id'` (explicit opt-in; sends the internal session ID) |
| `debug` | `true` logs every streaming call that received the header |
| `debugFile` | Path to append JSON lines to; **only** paths under `$DSH_HOME/logs` or the system temp directory take effect; the logged `session` is a one-way SHA-256 hash |

## Permissions and boundaries (for marketplaces that scan statically)

- **Runtime dependencies: none.** Node built-ins only. **Outbound network: none.** The plugin makes no
  requests of its own; it wraps `globalThis.fetch` to add the header and calls the engine's own
  `llm.discoverModels()` (which answers the shipped catalog without touching the network).
- **Files: none by default.** Only an explicitly configured `debugFile` is ever written, and only under
  `$DSH_HOME/logs` or the system temp directory.
- **Local routes: none.** No page half, no HTTP route.
- **Credentials / commands / native artifacts / lifecycle scripts: none.**
- **Failure boundary**: it depends on the public contracts of the engine's assembly layer, the
  `settings` service and the `llm` events — not on an engine version. If those change, the engine
  **reports the plugin as failed to load** instead of failing silently. Writes go through the `settings`
  service and re-run the engine's strict validation; a rejected write is refused as a whole (with the
  reason logged) rather than leaving half a config.

## Development

```sh
node --check lib/index.js
npm test        # local behaviour tests (no network, no engine)
```

Add an entry to `V4_1_MODELS` to support another V4.1 model. `planRouteUpdate()` /
`withV41ModelsFirst()` / `withV41Defaults()` / `isV41()` decide "what to write", "how to hoist", "how to
fill gaps" and "is it a v4.1 model", and all four are unit-tested.

## License

MIT
