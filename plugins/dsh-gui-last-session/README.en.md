# dsh-gui-last-session

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

> One of the plugins bundled with **DSH Ready GUI** — the GUI ships all four, ready to tick.
> Each one also installs standalone into any DSH host (see "Install and go" below).
> GUI: https://github.com/itchenshi/dsh-ready-gui

Reopen the conversation you were last in after restarting
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — no digging through history.

## Install and go

- **Using DSH Ready GUI (recommended)**: the plugin **ships inside the GUI** and is **on by default** —
  installing the GUI already gives you the feature. To turn it off, untick it in Settings →
  Third-party plugins.
- **Any other DSH host** (`dsh web`, the CLI) — either route works:

  ```sh
  # Recommended: install straight from GitHub (recorded in your profile, updatable)
  dsh plugin --profile web add github:itchenshi/dsh-gui-last-session

  # Fallback: install the release tarball (use this if github.com is unreachable for you)
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gui-last-session/releases/download/v0.1.2/dsh-gui-last-session-0.1.2.tar.gz
  ```

  Both land the full repository contents (including `cordis.patch.yml`); no extra configuration
  is needed afterwards.

> Not on npm yet: sign-up is unreachable (`www.npmjs.com` answers with a Cloudflare challenge), so
> nothing can be published. Use one of the two routes above; publishing resumes once sign-up works.

## What it fixes

The original implementation **rewrote an engine file**: it patched
`node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`, located the insertion point by
matching engine source text, and gated on an exact engine version string. So the feature broke on
**almost every engine update**:

| How it broke | Why |
|---|---|
| Version gate | Any engine version other than the one it was written against refuses to apply |
| Anchor drift | The insertion point was found by matching literal source lines; a rebuild, rename or reformat invalidates it |
| Silent degradation | On failure it logged one line and returned — the feature was simply gone, with no visible error |
| Lost on reinstall | Reinstalling the engine wiped the patch |

It is now a **plugin**: it lives in its own package and talks to the engine through the published
service contract (`ctx.sessions`), so engine updates no longer delete the feature. If that contract ever
changes, the engine **fails loudly** instead of quietly turning the feature off.

## Behaviour details

Two behaviours are critical, and both are covered by tests:

1. **The blank session the engine boots into is never recorded.** While the page loads, the engine
   navigates to a workspace and may create or select an *empty* session; recording it would make the
   next launch resume an empty conversation. Two independent defences:
   - recording stays **disabled** until the resume attempt settles (or a 4s fallback timer fires), so
     the engine's startup navigation happens before the plugin starts listening;
   - even once enabled, a row flagged `blank: true` is never recorded.

2. **Resuming waits for the target to become addressable.** The session list arrives from the network
   after the page mounts, and calling `open()` on an unknown id fails, so the plugin polls the list
   snapshot (every 150ms, for up to ~30s) until the row appears, then selects it.

**Best effort**: if the remembered session has been deleted, the plugin gives up quietly and leaves the
engine's own startup behaviour in place.

## Configuration (the `cordis.patch.yml` row config, all optional)

```yaml
- insert:
    - id: gui-last-session
      name: dsh-gui-last-session
      config:
        enabled: true   # master switch
        quiet: false    # true = log nothing on activation
```

To override it for one profile without touching the package, add a row with the same id to **that
profile's own** `cordis.patch.yml` (it replaces `config` wholesale, so spell out every key).

## Permissions and boundaries (for marketplaces that scan statically)

- **Runtime dependencies: none.** Node built-ins only (`node:fs/promises`, `node:crypto`, `node:path`,
  `node:os`).
- **Files: exactly one.** The host half keeps a tiny pointer document at `<DSH_HOME>/last-session.json`,
  written **atomically** (unique temp name + rename), so a crash cannot leave half a file. It records a
  session id and nothing else.
- **Local routes: one.** The host registers a single page-facing route the page half uses to read and
  update that pointer; it goes through the engine's trust fence (Host allow-list + browser session
  cookie) and **fails closed** when the fence is unavailable.
- **Outbound network: none.** The only `fetch` is the same-origin request to that local route.
- **Credentials / commands / native artifacts / lifecycle scripts: none.**
- **Failure boundary:** a missing, unreadable or corrupt pointer is treated as "nothing to resume" — one
  log line, and startup proceeds normally. It never blocks engine startup, and uninstalling it restores
  native behaviour with no leftover state beyond that one file.

## HTTP interface

```
GET  /gui-last-session   -> { sessionId: string | null, updatedAt?: number }
POST /gui-last-session   -> { ok: true, sessionId, updatedAt }
     body: { "sessionId": "session-..." }
```

Both directions validate the id against `/^session-[A-Za-z0-9_-]{4,200}$/`; a `POST` carrying anything
else is rejected with `400` and the file is left as it was. The route sits behind the trust fence, so a
bare `curl` gets **401** — to call it by hand, open the URL `dsh web` prints to obtain the session
cookie and pass it along:

```sh
curl -X POST http://127.0.0.1:<port>/gui-last-session \
     -H 'content-type: application/json' \
     -H 'cookie: <engine session cookie>' \
     -d '{"sessionId":"session-..."}'
```

## Two halves

| Half | File | Runs in | Responsibility |
|---|---|---|---|
| Host | `lib/index.js` | Node | Atomically persists the pointer to `$DSH_HOME/last-session.json`; serves one tiny JSON route |
| Page | `client/client.js` | Browser | Records the current session; reopens the stored one on load |

The page half is a **hand-written, dependency-free bundle** — no build step, no bundler. The engine's
client module system does **not** accept plain ESM: the bundle must register a lazy CJS factory
(`window.__ModuleLoader__.load({ id, factory })`, where `id` must equal the package name) and every side
effect must live in the factory closure, running only at materialisation. **Do not confuse the two
inject mechanisms**: `dsh.client.inject` in `package.json` lists **package names** (it sets the browser
module graph's load order), while the `inject` exported by the bundle factory lists **service names**
(such as `['sessions']`). Both are required — drop the exported one and the page throws
`cannot get property "sessions" without inject` the moment `apply()` runs.

`tests/test.mjs` loads the bundle against exactly that contract, so a regression to plain ESM or a
missing exported `inject` fails the suite instead of blowing up in the browser.

## Development

```sh
node --check lib/index.js
npm test        # local behaviour tests (no network, no engine)
```

**Compatibility**: the plugin depends on **published service contracts**, not an engine version, so it
deliberately declares **no version range** (a range is also the wrong tool here: npm semver excludes
prereleases from ranges like `>=0.1.2-0 <0.2.0`, which would wrongly reject `0.1.5-rc.1`). Verified
end-to-end on dsh 0.1.5-rc.1: the engine starts with the plugin installed, `GET /gui-last-session`
returns the stored pointer, and `dsh-gui-last-session/client.js` ships inside the startup payload
(HTTP 200).

This package is plain JavaScript with zero dependencies.

## License

MIT
