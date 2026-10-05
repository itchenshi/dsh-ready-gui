# dsh-gui-last-session

After restarting [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), it **reopens the conversation you were last in** — no digging through history.

## What it does

- The page half records the conversation you are viewing and reopens it after a restart.
- The **blank session the engine boots into is never recorded** (two independent defences), so the next launch never resumes an empty conversation.
- Resuming waits until the target shows up in the session list (polling every 150ms for ~30s), so `open()` is never called on an unknown id.
- If the remembered session has been deleted it **gives up quietly** and leaves the engine's own startup behaviour in place.
- Subagent sessions are never recorded.

## Install

- **Using DSH Ready GUI (recommended)**: the plugin ships inside the GUI; tick or untick it in Settings → "Third-party plugins". It has a page half, so refresh the page as prompted after installing.
- **Any other DSH host** (`dsh web`, the CLI) — either route works:

  ```sh
  # Recommended: install straight from GitHub
  dsh plugin --profile web add github:itchenshi/dsh-gui-last-session

  # Fallback: install this release's tarball
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gui-last-session/releases/download/v0.1.9/dsh-gui-last-session-0.1.9.tgz
  ```

  Both land the full repository contents (including `cordis.patch.yml`); no extra configuration is needed afterwards.

> Not on npm yet (`registry.npmjs.org` has no such package), so use one of the two routes above.

## Usage

After installing, restarting the engine and refreshing the page there is nothing to do: the page tries to return to the stored conversation on load, and every session you switch to updates the pointer.

Moving over from DSH Ready GUI, the GUI hands its own pointer to the plugin (an existing plugin pointer is not overwritten), so your previous "last session" is not lost.

## Configuration

The `config` of the row `id: gui-last-session` in `cordis.patch.yml`, all optional:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the plugin return immediately and register no route |
| `quiet` | `false` | `true` logs nothing on activation |

To override it for one profile without touching the package, add a row with the same id to **that profile's own** `cordis.patch.yml` (it replaces `config` wholesale, so spell out every key).

## Compatibility

- The manifest declares **DSH >= 0.1.5-rc.2** and marks 0.1.5-rc.2 and 0.2.0-rc.2 compatible.
- Node >= 20.
- The plugin itself applies **no version gate**: it relies on published service contracts (`ctx.sessions`). If that contract changes, the engine fails loudly instead of quietly turning the feature off.
- The tests in this repository do not start an engine; end-to-end behaviour against a real engine is not automated here.

## FAQ

**It did not reopen my conversation?** Check the app log: a successful record logs `[gui-last-session] pointer -> session-...`, and startup logs `[gui-last-session] active (pointer: <DSH_HOME>/last-session.json)`. The reopen path's diagnostics land in the same log (`[gui-last-session] reopen: no usable pointer`, `reopen: FAILED — ...`, `reopen: giving up ...`), which tells "no pointer" apart from "the target never appeared" and "this engine has no way to open a session".

**What does it store, and where?** One session id and a timestamp in `<DSH_HOME>/last-session.json`, written **atomically** (unique temp name + rename) so a crash cannot leave half a file. Nothing else is left behind.

**Why did it record a session I was not just looking at?** Blank (unused) sessions are never recorded; the plugin takes the one the engine's main view is showing (`retainedBy.mainView`), otherwise the most recently prompted one. Subagent sessions are skipped.

**Can another local program read the pointer?** The host exposes `GET/POST/PUT /gui-last-session` plus a log-only `POST /gui-last-session/report`; both go through the engine's own trust fence (Host allow-list + browser session cookie) and **fail closed** — a bare `curl` without the cookie gets 401. The plugin makes no outbound network requests.

## Development

```sh
node --check lib/index.js
npm test        # manifest-contract.cjs + test.mjs + handoff.cjs
```

`node tests/test.mjs` is the local behaviour test (no network, no engine); it loads the page bundle against the engine's `__ModuleLoader__` contract. `tests/served-bundle-check.cjs` needs a running profile, so it is not part of `npm test`.

## License

MIT
