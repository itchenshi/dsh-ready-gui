# dsh-gateway-models

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

> One of the plugins bundled with **DSH Ready GUI** — the GUI ships all four, ready to tick.
> Each one also installs standalone into any DSH host (see "Install and go" below).
> GUI: https://github.com/itchenshi/dsh-ready-gui
>
> **Renamed on 2026-09-25**: this was `dsh-opencode-go-path`. It no longer covers only OpenCode Go —
> it also declares Command Code's protocol and endpoint and syncs its model list from the provider's
> catalog — so it now carries a vendor-neutral name. The patch layer's **row id stays `opencode-go`**
> (deliberately decoupled from the package name), so **your enable/disable choice is not lost**, and
> GitHub redirects the old repository name, so existing installs keep working.

One plugin for gateway routes (OpenCode Go + Command Code): **install it, tick it, done** — no
hand-editing config, no command line, and **no typing the API address every time**.

## What it fixes for you

| The problem you hit | What the plugin does |
|---|---|
| `deepseek-v4.1-flash` is missing from the model list, and adding it fails with `needs an api` | Declares the route's wire protocol, so models the catalog doesn't describe work too |
| Newly released models never show up in the catalog | Detects the route's catalog at engine startup, adds the DeepSeek V4.1 models and puts them **first** |
| The model is there but requests fail and saving it is refused | Supplies the route `baseURL` (a model outside the catalog has nowhere to point without it) |
| Multi-turn calls fail with **400 `MissingSessionID`** | Attaches a per-conversation `x-opencode-session` header to OpenCode requests |
| Multi-turn calls fail with **400 `reasoning_content` must be passed back** | Supplies the DeepSeek thinking-protocol declaration a catalog-unknown model is missing |
| **No Command Code model exists in DSH at all**, and each one you add asks for the API address | The patch layer declares the `commandcode` route's protocol **and its endpoint**, so you supply only the key; at startup the full model list is filled in from the provider's **public catalog** |

### How the Command Code half works

Command Code is not in the engine's shipped pi-ai catalog (40 providers, none of them Command Code), so
nothing about it can be inferred: every entry needs a route-level `api` and `baseURL`, and the model ids
need a source — which is exactly why adding one meant typing the API address again. The plugin supplies
both ends:

1. **The endpoint**: `cordis.patch.yml` declares `api` + `baseURL` for `commandcode`. The engine
   resolves an entry's endpoint as `route.baseURL ?? catalogModel.baseUrl ?? providerBaseUrl`, and the
   model page probes with `draft.baseURL ?? fallback.baseURL` — so **while the route carries the
   address, you never type it**.
2. **The models**: at startup it reads the provider's own **public catalog**
   (`GET .../provider/v1/models`, **no credential required**, 81 models, each carrying
   `context_length`) and completes the list.

Filling is **add-only**: entries you already have (including names and limits you edited) are kept
verbatim, and missing ones are **appended**, so your own ordering survives. A second pass writes nothing
(idempotent).

> This route's catalog belongs to the provider, so the job here is *completeness* — not hoisting one
> model to the front the way the OpenCode Go half does.

### One route name covers every plan: `commandcode`

**The plan lives on the account behind the API key — not in the route name, and not in the URL.** One
host, `api.commandcode.ai`, serves every tier; the key reports its own `planId` from
`/alpha/billing/subscriptions` (`individual-go` / `individual-goat` / `individual-pro` /
`individual-max-10x` / `individual-max-20x` …), and the credit windows come back sized for that tier.

So the default route is named **`commandcode`**, with **no tier suffix**: the tier is not what the route
decides, and calling it `commandcode-goat` would claim otherwise. **Upgrading the plan is a key swap —
the route name and the config never change.**

Older names keep working: the plugin recognises Command Code routes by their **endpoint**
(`api.commandcode.ai`), never by name. So an existing `commandcode-goat`, or `commandcode-pro` /
`commandcode-max` / the community provider's `commandcode`, is provisioned just the same. For names the
patch does not cover, the plugin also writes the `api` and `baseURL` such a route cannot resolve on its
own — the engine refuses to store models on a route whose protocol is unresolvable, and Command Code has
no catalog entry to resolve it from.

If a route's endpoint is nowhere in the config (say you proxy it through your own gateway), name its id
explicitly in the row's `commandcodeProviders`.

## Install and go

- **Using DSH Ready GUI (recommended)**: the plugin **ships inside the GUI**. Open the GUI → Settings
  → Third-party plugins → tick **OpenCode Go routes**, then restart the engine as prompted.
- **Any other DSH host** (`dsh web`, the CLI) — either route works:

  ```sh
  # Recommended: install straight from GitHub (recorded in your profile, updatable)
  dsh plugin --profile web add github:itchenshi/dsh-gateway-models

  # Fallback: install the release tarball (use this if github.com is unreachable for you)
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gateway-models/releases/download/v0.2.0/dsh-gateway-models-0.2.0.tar.gz
  ```

  Both land the full repository contents (including `cordis.patch.yml`); no extra configuration
  is needed afterwards.

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
| `commandcodeProviders` | Extra Command Code route ids. Normally unnecessary — routes on `api.commandcode.ai` are recognised by their endpoint. Use it only when a route's endpoint is not visible in the config |
| `mode` | `'uuid'` (default, safe) or `'session-id'` (explicit opt-in; sends the internal session ID) |
| `debug` | `true` logs every streaming call that received the header |
| `debugFile` | Path to append JSON lines to; **only** paths under `$DSH_HOME/logs` or the system temp directory take effect; the logged `session` is a one-way SHA-256 hash |

## Permissions and boundaries (for marketplaces that scan statically)

- **Runtime dependencies: none.** Node built-ins only.
- **Outbound network: one public GET, carrying no credential.** The only request the plugin makes is
  `GET https://api.commandcode.ai/provider/v1/models`, used to complete the Command Code model list.
  That endpoint is **public and needs no key**, and the request sends **no Authorization header**.
  Everything else is local: the OpenCode Go half calls the engine's own `llm.discoverModels()` (which
  answers the shipped catalog without touching the network), and the header is added by wrapping
  `globalThis.fetch`.
- **Files: none by default.** Only an explicitly configured `debugFile` is ever written, and only under
  `$DSH_HOME/logs` or the system temp directory.
- **Local routes: none.** No page half, no HTTP route.
- **Credentials / commands / native artifacts / lifecycle scripts: none.** The plugin **never reads an
  API key** — it only writes route configuration; the engine resolves the key itself from `apiKeyEnv`.
- **Write gate**: the Command Code half touches settings only for routes **you configured yourself** (a
  user-layer entry, e.g. after adding the key). The patch layer declares the default route for everyone
  purely to supply its endpoint, which says nothing about whether you use it, so 81 models are never
  pushed into the settings of someone who does not. Which routes count is decided by their endpoint
  (`api.commandcode.ai`), not by their name.
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
