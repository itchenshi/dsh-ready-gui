# dsh-opencode-go-path

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

A one-stop plugin for the OpenCode / OpenCode Go route: **declares the protocol +
puts the DeepSeek V4.1 models first + attaches a session header**. Install and go,
no hand-editing of config.

(Merged from the former `dsh-opencode-go-session` and `dsh-opencode-go-api` plugins; the
package name went `dsh-opencode-go` → `dsh-opencode-go-path` because the old name was already
taken by another author on npm.)

## What it does

### 1. Declares the wire protocol for the `opencode-go` route

For every model of every route the engine `dsh-llm-pi-ai` resolves `api` in this order:

```
route.api  ??  the model's api in the catalog  ??  the api shared by all models in the catalog
```

- Models in the `opencode-go` catalog span three protocols (anthropic-messages /
  openai-completions / openai-responses), so the third fallback cannot be inferred;
- Models outside the catalog (such as `deepseek-v4.1-flash`, offered upstream but not yet
  listed in the pi-ai catalog) have no second fallback either;
- The route declares no `api` → no first fallback either → "needs an api" is raised, and the
  strict validation of the GUI model page also refuses to save that model.

Through `cordis.patch.yml` the plugin adds
`providers.opencode-go.api: openai-completions` to the `llm-pi-ai` row (that is exactly the
protocol the OpenCode Go OpenAI-compatible endpoint speaks).

### 2. Puts the DeepSeek V4.1 models at the front of the model list

After the engine starts, the runtime (`lib/index.js`) waits for the `llm-pi-ai` settings
namespace to be ready, then:

- **The user already configured** the `opencode-go` `models` list in `settings.yaml` → the
  DeepSeek V4.1 models are put at the **front of the list** (through the same `settings.update`
  write path the GUI model page uses, landing in `settings.yaml`; strict validation passes
  because api is present); the user's other models keep their relative order;
- **Already first** → nothing is written (idempotent). **Behind** (early versions appended at the
  end) → moved to the front: list order is the model selector's order and the first entry is the
  default selection, so "install and go" means V4.1 Flash is selected by default;
- **The user's own entry with the same id is kept as is** (it may have a different name or context
  length) and is not overwritten by our defaults;
- **The user configured no `models`** → nothing is done. The engine treats a **non-empty
  configured list** as the **complete** model set of that provider
  (`entries = configured.length > 0 ? configured : defaults`), so writing into an empty list would
  replace the whole built-in catalog with the few models we write — in that case the engine's own
  catalog is authoritative;
- "Is a given model in the list" is decided by **our own ids** (`V4_1_MODELS`) rather than by the
  `deepseek-v4.1` prefix: if upstream gains other v4.1 variants later, the already-listed Flash
  should not be displaced.

> The check reads the **user layer** (`settings.section(NS)`), not the merged `resolved`: this
> plugin's own patch injects `providers.opencode-go.api`, so the merged layer always has that
> route, and using "does the route exist" as a guard would never take effect.

Route-existence checking, hoisting the model list and "is it already the shape we want" are
`nextV41Models()` / `withV41ModelsFirst()` / `isV41()`, all covered by unit tests.

### 3. Attaches the `x-opencode-session` header

The OpenCode relay pins requests carrying the same `x-opencode-session` to the same upstream
backend, keeping the prompt cache hitting for one conversation (fixes 400 MissingSessionID).

**Safe mode is the default**: every DSH session derives a random opaque UUID, and the **internal
session ID is never sent to a third party**; `mode: 'session-id'` is an explicit opt-in (use it
only when you fully trust the upstream).

## Configuration (the `cordis.patch.yml` row config, all optional)

| Key | Description |
|---|---|
| `providers` | Route names to attach the session header to, default `['opencode', 'opencode-go']`; add your own route names here |
| `mode` | `'uuid'` (default, safe) or `'session-id'` (explicit opt-in, sends the internal session ID) |
| `debug` | when `true`, logs every streaming call that received the header |
| `debugFile` | path to append one line of JSON to; **only** paths under `$DSH_HOME/logs` or the system temp directory take effect; the `session` field in the log is a one-way SHA-256 hash |

## Install

> **Not on npm yet — the only install path today is from source.**
>
> The plan was to publish the four bundled plugins to npm, so that `dsh plugin add dsh-opencode-go-path` would
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
> Publishing to npm will resume once sign-up works; `dsh plugin --profile web add dsh-opencode-go-path` will work
> then.

**Option 1 — DSH Ready GUI (recommended)**: these four plugins ship inside the GUI. Open the GUI →
Settings → Third-party plugins → tick **OpenCode Go 路由（dsh-opencode-go-path）**. Install, uninstall and
enable/disable all live in that window; restart the engine when it says so.

**Option 2 — any other DSH host**: clone this repository, then install it by **directory**:

```sh
git clone https://github.com/itchenshi/dsh-opencode-go-path.git
dsh plugin --profile web add file:<absolute path of the clone>
```

That installs the real on-disk directory, so a later `git pull` updates the very code in use — but
moving or deleting the directory breaks the dependency (just add it again).

Restart **`dsh web`** after installing (or reopen the DSH GUI).

Verify:

- the **first** entry in the session model selector is `DeepSeek V4.1 Flash`;
- `dsh --profile web --dump-config` shows the `llm-pi-ai` row with
  `config.providers.opencode-go.api: openai-completions`.

Uninstall: `dsh plugin --profile web remove dsh-opencode-go-path`
(the automatically added model entries stay in `settings.yaml` and can be removed by hand).

> The `-path` suffix in the package name is **required**: `dsh-opencode-go` and
> `dsh-opencode-go-plus` are both already taken by other authors on npm. The suffix only affects
> the package name written at install time and has nothing to do with functionality.

## Permissions, dependencies and failure boundaries

Marketplaces that pin the repository to a commit before reviewing it (DSH STORE and the like)
statically scan the runtime code and derive permission conclusions from the signals they detect.
The facts are stated here once, so they do not have to be inferred:

- **Runtime dependencies: none.** Only Node built-ins are used (`node:async_hooks`, `node:crypto`,
  `node:fs/promises`, `node:path`, `node:timers/promises`).
- **Outbound network: none.** This plugin **makes no requests at all**. It wraps
  `globalThis.fetch` to attach the `x-opencode-session` header to requests bound for OpenCode
  routes (fixes 400 MissingSessionID). The "network signal" comes from that wrapping behaviour,
  not from it connecting anywhere itself.
- **Files: none by default.** The only case where it writes a file is when you **explicitly
  configure `debugFile`** in the patch-layer row config — then it appends JSON debug lines to that
  path, and only paths under `$DSH_HOME/logs` or the system temp directory are accepted, any other
  path being ignored. The session identifier in the log is a one-way SHA-256 hash, not the raw
  session ID.
- **Local routes: none.** This plugin has no page half and registers no HTTP route.
- **Credentials / commands / native artifacts / lifecycle scripts: none.**
- **Automatic model completion is idempotent**: it does nothing when the route does not exist, and
  writes nothing when the route exists and already has the models we need.
- **Failure boundary**: the plugin depends on the public contracts of the engine's assembly layer
  and of the settings service, not on an engine version number. If those contracts change, the
  engine **explicitly reports the plugin as failed to load** at startup instead of failing
  silently; the patch-layer row id is `opencode-go`, and after uninstalling, the model entries
  auto-added to `settings.yaml` remain and can be removed by hand.

## Upgrading from the old plugins

The former `dsh-opencode-go-session` and `dsh-opencode-go-api` have been merged into this plugin;
since v0.5.0 the package name changed again from `dsh-opencode-go` to `dsh-opencode-go-path`. Both
renames are carried out automatically by DSH GUI boot maintenance: uninstall the old package, clean
up leftover patch-layer rows, install this plugin, and **keep your previous enable/disable
choice**. The patch-layer row id is still `opencode-go`, so disabled rows do not go out of sync.

## How it works

- The engine merges the profile's bundle patch layer with user settings:
  `resolve(schema, base, section)` = `mergeLayers(base, section)`, base below and the user's
  `settings.yaml` above; the plugin patch adds `api` to the base layer.
- At runtime it reads/writes the model list once namespaces such as `ctx.settings` are registered
  (the same path as the GUI model page).
- The session header goes through a `globalThis.fetch` patch plus the `llm/stream` waterfall event
  and is only in effect during streaming calls on the matching route (AsyncLocalStorage scope), so
  it does not pollute other requests.

## Relationship to upstream pi-ai 0.86 / 0.87

Upstream `@earendil-works/pi-ai` shipped 0.86.0 (09-19), 0.86.1 (09-20) and 0.87.0 (09-21), and in
0.87.0 it has built both halves of what this plugin does into itself: `dist/providers/data/opencode-go.json`
lists `deepseek-v4.1-flash` (under `openai-completions`), and `dist/providers/opencode-go.js` wraps all
three API entries with `withOpenCodeSessionHeader` — so catalog routes can emit a per-conversation
`x-opencode-session` on their own.

**It does not reach the case this plugin covers**, for two independently verified reasons:

1. **The version range**: `@deepseek-ai/dsh-llm-pi-ai@0.1.6-alpha.2` declares
   `@earendil-works/pi-ai: ^0.85.1`, and under 0.x semantics `^0.85.1` is `>=0.85.1 <0.86.0` —
   `semver.satisfies("0.87.0", "^0.85.1") === false` (0.86.0 is false too). The published
   `@deepseek-ai/dsh` is still **0.1.5-rc.2** (its `latest` line declares `^0.82.1`), and the
   installed pi-ai really is 0.85.1: its dist contains **zero** occurrences of `x-opencode-session`,
   `withOpenCodeSessionHeader` and `deepseek-v4.1-flash`. So **no published version gets that fix**.
2. **The shape of the route**: this plugin adds `providers.opencode-go.api: openai-completions` to the
   `llm-pi-ai` row — i.e. it is a "route that sets `api:`". Per the engine's own comment
   (`dsh-llm-pi-ai`: *catalog route pointed at a different protocol — is built by `createProvider`*),
   such a route is built by `dsh-llm-pi-ai` from its own `PROTOCOLS` table over the **unwrapped**
   factories — so even once pi-ai 0.87 is admitted, the upstream wrapper **cannot cover it**.

Both halves of this plugin therefore still matter today, with a clear division of labour:

| Half of this plugin | Why it is still needed | When it can retire |
|---|---|---|
| The `x-opencode-session` header (`globalThis.fetch` patch + `llm/stream` waterfall) | Independent of the pi-ai version, it is currently the **only** thing that actually sends that header; it derives a random UUID per session (**not a static header**, so it pays no static-header cache cost) and guards with `hasSessionHeader`, so it will not double-set once upstream sends one too | Only when the route stops setting `api:` *and* the range admits the wrapper |
| Auto-adding / front-placing `deepseek-v4.1-flash` | The engine treats a **non-empty user `models` list** as that provider's complete set (`entries = configured.length > 0 ? configured : defaults`), so a catalog addition never surfaces for a user who configured a list; and catalog-unknown models still need the route-level `api` | When the catalog covers the models a user actually uses *and* they have no explicit `models` list |

**What to do once the range opens** (measure it on the engine; do not just copy this): either keep the
`api:` patch (safest — the header half keeps working), or keep it only for catalog-unknown models and
let the catalog route take over. The latter needs a redesign, because that declaration is deliberately
**not** under `insert`, so the settings window's enable/disable writes (which target inserted row ids
only) can never switch the protocol declaration off with it.

Upstream discussion: [earendil-works/pi#9737](https://github.com/earendil-works/pi/issues/9737)
(`opencode-go` catalog missing `deepseek-v4.1-flash`).

## License

MIT
