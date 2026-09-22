# dsh-model-surplus

Shows **model usage / account balance** in the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
session header, gated on the session's **active model selection**:

| Active model route | Widget shows | Source |
|---|---|---|
| `opencode-go` / `opencode` | OpenCode Go plan usage — rolling / weekly / monthly **percentages** + reset time, plus the **selected model's monthly cap** (`上限 $60`) | `GET https://opencode.ai/zen/go/v1/usage` + per-model limits table (see below) |
| `deepseek-official` | DeepSeek account **balance** — total / granted / topped-up | `GET https://api.deepseek.com/user/balance` |

```
┌─ session header ─────────────────────────────────────────────────────────┐
│  My conversation title  [OpenCode Go 滚动 18% 周 82% 月 42% 上限 $60] 打开功能 ▾ │
│  Another conversation   [DeepSeek ¥110.00]                           打开功能 ▾ │
└──────────────────────────────────────────────────────────────────────────┘
        slot: conversation.session.header.actions
```

## Placement

The widget registers at `conversation.session.header.actions`, which the engine
documents as "Title-adjacent Session actions in ascending order" — verified in
the engine's own header source as:

```
titleRow
  ├─ titleCluster
  │    ├─ crumbs         ← the session title
  │    └─ headerActions  ← THIS widget (right of title)
  ├─ headerUtilities     ← "open feature" buttons
  └─ headerCorner        ← right-sidebar ExpandButton
```

## Gating rule

The widget renders only when the session's current model routes to a **tracked**
provider. The selection is read from
`ctx.modelDirectories.directoryFor(sessionId).store` — the same shared state the
model selector and composer seat use, so a model switch shows/hides the widget
immediately.

Which route belongs to which section is **configuration, owned by the host
half**: the host returns its live provider→section map (`sections`) on every
poll, and the client gates on that. Changing `providers` in `cordis.patch.yml`
therefore takes effect without touching client code.

## Two halves

| Half | File | Runs in | Job |
|---|---|---|---|
| Host | `lib/index.js` | Node | Fetches each section from its upstream and serves it over one same-origin JSON route. |
| Client | `client/client.js` | Browser | Registers the header widget, polls the host route, gates on the active model. |

API keys never reach the browser: the host half resolves them through
`ctx.credentials` by reference (`OPENCODE_GO_API_KEY`, `DEEPSEEK_API_KEY`) and
calls the upstream.

## Host route

> **这条路由受引擎的信任围栏保护**（Host 白名单 + 浏览器会话 cookie）。它返回账户用量与余额，
> 因此**不带 cookie 的裸 `curl` 会得到 `401 unauthorized`**（修复前返回 200 —— 任何本机进程、
> 以及被 DNS rebinding 的页面都能读到）。同源的页面请求会自动带上 cookie；手工调用需先用
> `dsh web` 打印的 URL 换一次会话 cookie，再以 `-H 'cookie: …'` 传入（示例见
> `dsh-gui-last-session/README.md`）。

```
GET /model-usage
{
  "ok": true,
  "sections": {
    "opencode-go": { "providers": ["opencode-go","opencode"], "keyRef": "OPENCODE_GO_API_KEY" },
    "deepseek":    { "providers": ["deepseek-official"],    "keyRef": "DEEPSEEK_API_KEY" }
  },
  "opencode-go": { "ok": true, "usage":   { "rolling": {…}, "weekly": {…}, "monthly": {…} }, "fetchedAt": 1700000000000 },
  "deepseek":    { "ok": true, "balance": { "isAvailable": true, "infos": [ { "currency":"CNY", "total":"110.00", "granted":"10.00", "toppedUp":"100.00" } ] }, "fetchedAt": 1700000000000 },
  "limits": { "deepseek-v4.1-flash": { "hours5": 12, "weekly": 30, "monthly": 60 }, … },
  "limitsMeta": { "source": "docs|cache|builtin", "updatedAt": "2026-09-20T…" }
}
```

The per-section entries are keyed by **section key** — the same keys as `sections`, which is what the page half indexes with (the camelCase `opencodeGo` / `deepseek` names are the *config* keys in `cordis.patch.yml`, not the wire keys).

Each section reports **its own** outcome, so a user with only one of the two keys
still gets that half; the other half degrades to a diagnostic label
(`{"ok":false,"reason":"no-key|unauthorized|network|timeout|bad-payload"}`)
instead of hiding the widget.

## Upstream APIs (verified)

**OpenCode Go usage**

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
200 {"usage":{"rolling":{"status":"ok","percent":18,"resetsAt":"..."},
              "weekly":{...},"monthly":{...}}}
```

**DeepSeek account balance** ([official docs](https://api-docs.deepseek.com/api/get-user-balance/))

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
200 {"is_available":true,
     "balance_infos":[{"currency":"CNY","total_balance":"110.00",
                       "granted_balance":"10.00","topped_up_balance":"100.00"}]}
```

The host normalizes and clamps the usage payload (percent 0–100) and normalizes
the balance amounts (the upstream sends decimal **strings**; finite numbers are
accepted too). Each section is cached for 60s and re-polled after failures no
sooner than 30s.

## Per-model monthly limits (opencode-go)

OpenCode Go's usage endpoint is **account-wide** — it ignores per-model params,
and there is **no API** for the per-model monthly caps documented under
["使用限制"](https://opencode.ai/docs/zh-cn/go/#%E4%BD%BF%E7%94%A8%E9%99%90%E5%88%B6)
(e.g. DeepSeek V4.1 Flash $60/mo, DeepSeek V4 Pro $15/mo). So the plugin:

1. **ships a built-in table** (`BUILTIN_MODEL_LIMITS`, last synced 2026-09-20),
2. **auto-refreshes** by fetching the public docs page
   (`https://opencode.ai/docs/zh-cn/go/` — server-rendered, no JS, **no API
   key**) and parsing the limits + model-id tables into `model id → monthly $`,
3. **caches** the parsed result at `$DSH_HOME/logs/model-surplus-limits.json`,
4. **falls back** cache → built-in on any fetch/parse failure.

Refresh schedule: at plugin start (background), then every 24h. The widget shows
the **selected model's** monthly cap (`上限 $60`) next to the account-level
percent bars, and its tooltip lists the derived caps (5h = 20% · week = 50% ·
month = 100%), the data source (`OpenCode Go 文档（9/20）` / `本地缓存` /
`内置表`), and a note that the percentages are account-wide while the cap is
per model. A `rate-limited` bucket is shown in red with its reset time.

The derived tiers are computed host-side (`deriveLimitTiers`); the client just
looks up `limits[modelId]`.

## Install

```sh
dsh plugin --profile web add dsh-model-surplus
```

Restart `dsh web` (or reopen DSH GUI) afterwards. The same package can be installed
from DSH GUI's Settings → Third-party plugins (listed as **模型余量**), or one-click
from the [plugin marketplace](https://github.com/dsh-market/dsh-market).

> **Renamed from `dsh-model-usage`.** Three other GitHub repositories already used
> that exact name, so the package was renamed before its first publish. The patch
> row `id` stays `model-usage`, so an existing enable/disable choice is not lost.

## Permissions, dependencies and failure bounds

Marketplaces that pin a commit (DSH STORE and similar) statically review the runtime
source and report the permissions they detect. The facts, so none of it has to be
inferred:

- **Runtime dependencies:** none — Node built-ins only (`node:path`, `node:fs/promises`).
  The host half is plain ESM with no `node_modules` requirement of its own.
- **Outbound network: yes, three hosts**, all from the **host half**. The page half
  never talks to anything but the local route below.
  - `GET https://opencode.ai/zen/go/v1/usage` — OpenCode Go plan usage (`OPENCODE_GO_API_KEY`).
  - `GET https://api.deepseek.com/user/balance` — DeepSeek account balance (`DEEPSEEK_API_KEY`).
  - `GET https://opencode.ai/docs/zh-cn/go/` — the documented per-model monthly cap,
    scraped because the gateway's own `/models` response carries no limits.
- **Local route: yes, one.** The host registers a single page-facing route and the page
  half calls it same-origin. It goes through the engine's trust fence (Host allow-list
  plus browser session cookie) and **fails closed** when the fence is unavailable.
- **Files: yes, one cache.** `<DSH_HOME>/logs/model-surplus-limits.json` holds the
  scraped limits table so a restart does not re-scrape. Nothing else is read or written,
  and no user file is ever touched.
- **Credentials:** read through `ctx.credentials` in the host half only. They are never
  included in any response to the page.
- **Commands / native artifacts / lifecycle scripts:** none.
- **Failure bounds:** the two sections report their own outcomes independently, so a
  missing key or an unreachable upstream degrades that half alone and shows why. The
  plugin never blocks engine startup — a load failure is reported by the engine, and
  removing it restores the plain header.

## Configuration

The plugin row lives in `cordis.patch.yml`; every key is optional:

```yaml
- insert:
    - id: model-usage
      name: dsh-model-surplus
      config:
        enabled: true

        opencodeGo:
          baseUrl: https://opencode.ai/zen/go/v1   # upstream root
          apiKeyRef: OPENCODE_GO_API_KEY           # credential reference
          providers: [opencode-go, opencode]       # routes treated as OpenCode Go

        deepseek:
          baseUrl: https://api.deepseek.com        # upstream root
          apiKeyRef: DEEPSEEK_API_KEY              # credential reference
          providers: [deepseek-official]           # the engine's DeepSeek route
```

A top-level `baseUrl` / `apiKeyRef` / `providers` is still read as the
`opencodeGo` section (this plugin used to be OpenCode-Go-only).

## Development

```sh
node --check lib/index.js
npm test        # local behaviour tests (no network, no engine)
```

`tests/e2e.cjs` is a full integration check against a real engine + browser
(it needs a running profile, so it is not part of `npm test`).

## License

MIT
