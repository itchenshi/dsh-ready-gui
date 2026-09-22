# dsh-gui-last-session

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

Reopen the conversation you were last in after restarting
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

This plugin replaces the DSH GUI's old **engine-file patch** for the same feature.

## Why this is a plugin

The previous implementation did not extend DSH — it *edited DSH's own files*. It
rewrote `node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`,
locating its insertion point by matching engine source text and gating on an
exact engine version string.

That made the feature fail on **almost every engine update**:

| Failure mode | Cause |
|---|---|
| Version gate | The patch refused to apply unless the engine version was *exactly* the one it was written against. |
| Anchor drift | The insertion point was found by matching literal source lines; any rebuild, rename, or reformat broke it. |
| Silent degradation | On failure it returned `{ ok: false }` and logged one line — so the feature just stopped working with no visible error. |
| Re-install loss | Reinstalling the engine wiped the patch entirely. |

A plugin lives in its own package and talks to the engine through its published
service contract (`ctx.sessions`), so an engine update no longer deletes the
feature. When the contract does change, the engine reports it loudly instead of
quietly disabling the feature.

## Install

> **Not on npm yet — the only install path today is from source.**
>
> The plan was to publish the four bundled plugins to npm, so that `dsh plugin add dsh-gui-last-session` would
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
> Publishing to npm will resume once sign-up works; `dsh plugin --profile web add dsh-gui-last-session` will work
> then.

**Option 1 — DSH Ready GUI (recommended)**: these four plugins ship inside the GUI. Open the GUI →
Settings → Third-party plugins → tick **会话续接（dsh-gui-last-session）**. Install, uninstall and enable/disable
all live in that window; restart the engine when it says so.

**Option 2 — any other DSH host**: clone this repository, then install it by **directory**:

```sh
git clone https://github.com/itchenshi/dsh-gui-last-session.git
dsh plugin --profile web add file:<absolute path of the clone>
```

That installs the real on-disk directory, so a later `git pull` updates the very code in use — but
moving or deleting the directory breaks the dependency (just add it again).

Restart `dsh web` (or reopen DSH GUI) afterwards. The
[plugin marketplace](https://github.com/dsh-market/dsh-market) installs from npm, and this package
is not published yet, so **it cannot be installed from the market today** — use one of the two
options above. It will work there too once published.

The engine's `plugin` command is a thin pnpm forwarder: the package is installed by
its **true package name** and, because the manifest declares `dsh.bundle.patch`, it
joins the profile's bundle layer stack automatically. Bundle layers are read at boot,
so **restart the engine** afterwards.

## Permissions, dependencies and failure bounds

Marketplaces that pin a commit (DSH STORE and similar) statically review the runtime
source and report the permissions they detect. The facts:

- **Runtime dependencies:** none — Node built-ins only (`node:fs/promises`,
  `node:crypto`, `node:path`, `node:os`).
- **Files: yes, exactly one.** The host half keeps a small pointer document at
  `<DSH_HOME>/last-session.json`, written atomically (unique temporary name + rename)
  so a crash cannot leave a half-written file. It records one session id and nothing
  else; no other file is read or written and no user file is touched.
- **Local route: yes, one.** The host registers a single page-facing route so the page
  half can read and update that pointer; it goes through the engine's trust fence (Host
  allow-list plus browser session cookie) and **fails closed** when the fence is
  unavailable.
- **Outbound network: none.** The only `fetch` calls are same-origin requests to the
  local route above.
- **Credentials / commands / native artifacts / lifecycle scripts:** none.
- **Failure bounds:** a missing, unreadable or corrupt pointer is treated as
  "nothing to hand over" — the plugin logs it and the launch simply starts on the
  normal screen. It never blocks engine startup, and removing the plugin restores the
  plain behaviour with no leftover state beyond that one file.

## Two halves

| Half | File | Runs in | Job |
|---|---|---|---|
| Host | `lib/index.js` | Node | Persists the pointer at `$DSH_HOME/last-session.json`; serves a tiny JSON route. |
| Client | `client/client.js` | Browser | Records the current session; on load, reopens the stored one. |

The client half is a **hand-written, dependency-free bundle** — there is no build
step and no bundler.

### Bundle format (important)

The engine's client module system does **not** consume plain ESM. A client bundle
must register a lazy CJS factory:

```js
window.__ModuleLoader__.load({
  id: 'dsh-gui-last-session',            // must equal the package name
  factory: (require) => ({ name, inject, apply, ... }),
})
```

Executing the bundle only *registers* the factory; every side effect must live
inside the factory closure and runs at materialization (first import). Because
this plugin needs nothing but `ctx.sessions`, a single hand-written file
satisfies the contract with no `require()` of other modules.

**Two inject mechanisms — don't confuse them:**

| Where | Values are | Purpose |
|---|---|---|
| `dsh.client.inject` in `package.json` | package names (e.g. `@deepseek-ai/dsh-api-session-controller`) | drive the browser module-graph **load order** |
| exported `inject` from the bundle factory | **service names** (e.g. `['sessions']`) | drive the cordis fiber's inject for `apply(ctx)` |

Both are required. Omitting the exported `inject` makes `ctx.sessions` in
`apply()` throw `cannot get property "sessions" without inject` the moment the
page loads — the failure this plugin originally hit. The engine's own
`dsh-client-ui-session` bundle does `exports.inject = ["sessions", "slots"]`,
the same pattern.

`tests/test.mjs` loads the bundle through this exact contract, so either a
regression back to plain ESM or a missing exported `inject` fails the suite
rather than failing at runtime in the browser.

## HTTP surface

The host half registers exactly one route on the engine's own webserver:

```
GET  /gui-last-session   -> { sessionId: string | null, updatedAt?: number }
POST /gui-last-session   -> { ok: true, sessionId, updatedAt }
     body: { "sessionId": "session-..." }
```

Both directions validate the id against `/^session-[A-Za-z0-9_-]{4,200}$/`. A
`POST` with anything else is rejected with `400` and the file is left untouched.
The pointer is written atomically (temp file + rename), so a crash mid-write
cannot leave a half-written file behind.

## Configuration

The plugin row lives in `cordis.patch.yml`; both keys are optional:

```yaml
- insert:
    - id: gui-last-session
      name: dsh-gui-last-session
      config:
        enabled: true   # master switch
        quiet: false    # true = log nothing on activate
```

To override configuration in a profile without editing the package, add a row
with the same id in the profile's own `cordis.patch.yml` (it replaces the whole
`config`, so restate every key).

## Correctness notes

Two behaviours matter, and both are covered by tests:

1. **The blank bootstrap session is never recorded.** On page load the engine
   itself navigates to a workspace and may create/select an *empty* session. If
   that got recorded, the stored pointer would become "the empty session the
   engine just made" and the next start would reopen nothing useful. This was a
   real observed failure of the old patch. Two independent guards prevent it:
   - Recording stays **disarmed** until the reopen attempt has settled (or a 4s
     fallback timer fires), so the engine's bootstrap navigation happens while
     the plugin is not yet listening for changes.
   - Even once armed, a row flagged `blank: true` is never recorded.

2. **Reopening waits for the target to become addressable.** The session list
   arrives over the network after the page mounts. The contract says `open()`
   on an unknown id fails loud, so the plugin polls the list snapshot (150ms
   intervals, ~30s ceiling) until the row exists, then selects it.

A snapshot that throws (service tearing down, not ready yet) does not abort the
wait — the poll simply continues.

## Compatibility

This plugin depends on **published service contracts**, not on an engine version
number, so it is deliberately **not** version-gated.

Verified working on **dsh 0.1.5-rc.1** (and the contract is identical on
0.1.2-rc.1):

| Dependency | Contract used |
|---|---|
| `ctx.sessions` (client) | `list` (ObservableSnapshot), `open(id)`, `binding(id)` |
| `SessionListState` | `current`, `byId`, `byId[id].blank` |
| `ctx.webServer` (host) | `register({ kind, path, handler })` |
| Injection package | `@deepseek-ai/dsh-api-session-controller` |

End-to-end check on 0.1.5-rc.1: the engine boots with the plugin installed,
`GET /gui-last-session` returns the stored pointer, and
`dsh-gui-last-session/client.js` is served inside the boot payload's plugin
bundle (HTTP 200).

If a future engine breaks one of these contracts, activation **fails loudly**
(the engine reports a plugin load failure) rather than silently disabling the
feature — then update `dsh.client.inject` and the host route accordingly.

> Note: this plugin is intentionally **not** given an `engineRange` in the DSH GUI
> catalog. Version ranges are a poor fit here: npm semver excludes prereleases
> from ranges unless the range names a prerelease at the exact
> `[major,minor,patch]`, so a range like `>=0.1.2-0 <0.2.0` would wrongly block
> `0.1.5-rc.1`. The plugin is also low-risk: its worst case is "the conversation
> wasn't reopened", never a broken engine boot.

## Migrating from the DSH GUI pointer

DSH GUI keeps its own pointer at `<userData>/last-session.json`. This plugin
deliberately owns a **separate** file so it stays self-contained and works for
anyone who installs it, not just DSH GUI users. DSH GUI performs this hand-off
automatically at startup (one-way: it never overwrites a pointer the plugin
already recorded). To do it by hand, copy the `sessionId` across — note the route
is behind the engine's trust fence, so a bare `curl` now gets **401**
(pass the engine's session cookie: open the engine URL printed by `dsh web` once,
then reuse its cookie):

```sh
curl -X POST http://127.0.0.1:<port>/gui-last-session \
     -H 'content-type: application/json' \
     -H 'cookie: <engine session cookie>' \
     -d '{"sessionId":"session-..."}'
```

## Development

```sh
node --check lib/index.js
npm test        # local behaviour tests (no network, no engine)
```

`npm test` also asserts the client bundle registers under the engine's
`__ModuleLoader__` contract with the correct package id.

The package is plain JavaScript with zero dependencies.

## Notes / limitations

- The plugin relies on `ctx.sessions` (client) and `ctx.webServer` (host). If a
  future DSH version renames either service, activation reports the failure
  instead of silently disabling the feature — update `package.json`'s
  `dsh.client.inject` accordingly.
- Reopening is best-effort: if the remembered session was deleted, the plugin
  gives up quietly and leaves the engine's own startup behaviour in place.

## License

MIT
