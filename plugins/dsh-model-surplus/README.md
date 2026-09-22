# dsh-model-surplus

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的会话标题栏里显示
**模型用量 / 账户余额**，显示与否取决于会话的**当前模型选择**：

| 当前模型路由 | 小组件显示 | 数据来源 |
|---|---|---|
| `opencode-go` / `opencode` | OpenCode Go 套餐用量 —— 滚动 / 周 / 月**百分比** + 重置时间，外加**所选模型的月度上限**（`上限 $60`） | `GET https://opencode.ai/zen/go/v1/usage` + 单模型上限表（见下文） |
| `deepseek-official` | DeepSeek 账户**余额** —— 总余额 / 赠送 / 充值 | `GET https://api.deepseek.com/user/balance` |

```
┌─ session header ─────────────────────────────────────────────────────────┐
│  My conversation title  [OpenCode Go 滚动 18% 周 82% 月 42% 上限 $60] 打开功能 ▾ │
│  Another conversation   [DeepSeek ¥110.00]                           打开功能 ▾ │
└──────────────────────────────────────────────────────────────────────────┘
        slot: conversation.session.header.actions
```

## 显示位置

小组件注册在 `conversation.session.header.actions`，引擎对它的描述是「紧邻标题的会话操作，
按升序排列」—— 已在引擎自身的标题栏源码中核实为：

```
titleRow
  ├─ titleCluster
  │    ├─ crumbs         ← 会话标题
  │    └─ headerActions  ← 本小组件（标题右侧）
  ├─ headerUtilities     ← 「打开功能」按钮
  └─ headerCorner        ← 右侧栏的 ExpandButton
```

## 门控规则

只有当会话当前模型路由到**受跟踪**的 provider 时，小组件才会渲染。这个选择读自
`ctx.modelDirectories.directoryFor(sessionId).store` —— 与模型选择器和输入区座位
（composer seat）使用的是同一份共享状态，所以切换模型会立刻显示/隐藏小组件。

哪条路由属于哪个分区是**配置，由宿主端掌握**：宿主在每次轮询时返回它实时的
provider→分区映射（`sections`），客户端据此门控。因此在 `cordis.patch.yml` 里改
`providers`，无需改动客户端代码即可生效。

## 两个部分

| 部分 | 文件 | 运行于 | 职责 |
|---|---|---|---|
| 宿主端 | `lib/index.js` | Node | 从各分区对应的上游抓取数据，并通过一条同源 JSON 路由提供出去。 |
| 页面端 | `client/client.js` | 浏览器 | 注册标题栏小组件，轮询宿主路由，并按当前模型门控。 |

API 密钥永远不会到达浏览器：宿主端通过 `ctx.credentials` 按引用解析它们
（`OPENCODE_GO_API_KEY`、`DEEPSEEK_API_KEY`），并由宿主端调用上游。

## 宿主端路由

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

各分区条目以**分区键**为键 —— 与 `sections` 用的是同一批键，页面端就是按它索引的
（camelCase 的 `opencodeGo` / `deepseek` 是 `cordis.patch.yml` 里的*配置*键，不是传输用的键）。

每个分区各自上报**自己的**结果，所以只配了其中一个密钥的用户仍能拿到对应那一半；另一半会降级
为一条诊断标签（`{"ok":false,"reason":"no-key|unauthorized|network|timeout|bad-payload"}`），
而不是把小组件整个隐藏。

## 上游 API（已实测验证）

**OpenCode Go 用量**

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
200 {"usage":{"rolling":{"status":"ok","percent":18,"resetsAt":"..."},
              "weekly":{...},"monthly":{...}}}
```

**DeepSeek 账户余额**（[官方文档](https://api-docs.deepseek.com/api/get-user-balance/)）

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <DEEPSEEK_API_KEY>
200 {"is_available":true,
     "balance_infos":[{"currency":"CNY","total_balance":"110.00",
                       "granted_balance":"10.00","topped_up_balance":"100.00"}]}
```

宿主会对用量负载做归一化并钳制（百分比 0–100），也会归一化余额金额（上游发来的是十进制
**字符串**；有限数值同样接受）。每个分区缓存 60s，失败后最快 30s 才会重新轮询。

## 单模型月度上限（opencode-go）

OpenCode Go 的用量端点**按账户统计** —— 它忽略单模型参数，而[「使用限制」](https://opencode.ai/docs/zh-cn/go/#%E4%BD%BF%E7%94%A8%E9%99%90%E5%88%B6)
里记载的单模型月度上限**没有 API**（例如 DeepSeek V4.1 Flash $60/月、DeepSeek V4 Pro
$15/月）。所以本插件：

1. **内置一张表**（`BUILTIN_MODEL_LIMITS`，最后同步于 2026-09-20），
2. **自动刷新**：抓取公开文档页（`https://opencode.ai/docs/zh-cn/go/` —— 服务端渲染、
   无需 JS、**不需要 API 密钥**），把其中的限制表与模型 id 表解析成 `model id → 月度 $`，
3. 把解析结果**缓存**在 `$DSH_HOME/logs/model-surplus-limits.json`，
4. 任何抓取/解析失败时**回退**：缓存 → 内置表。

刷新时机：插件启动时（后台）一次，之后每 24h 一次。小组件会在账户级百分比条旁边显示
**所选模型**的月度上限（`上限 $60`），它的 tooltip 会列出推导出的各档上限
（5h = 20% · 周 = 50% · 月 = 100%）、数据来源（`OpenCode Go 文档（9/20）` / `本地缓存` /
`内置表`），以及一条说明：百分比是账户级的，而上限是单模型的。`rate-limited` 桶会用红色显示，
并带上它的重置时间。

推导出的各档上限在宿主端计算（`deriveLimitTiers`）；客户端只做 `limits[modelId]` 查表。

## 安装

> **npm 上暂时没有这个包 —— 现在只能从源码安装。**
>
> 原计划是把四个随附插件发布到 npm，那样在任何 DSH 宿主里 `dsh plugin add dsh-model-surplus` 就能装。
> 但 npm 账号注册目前走不通：`www.npmjs.com` 的注册/登录页返回 Cloudflare 托管挑战
> （`registry.npmjs.org` 本身是通的，卡在注册这一环），账号建不出来，包自然发不出去。
> 所以：
>
> - **用 DSH Ready GUI**：这四个插件随 GUI 内置，打开「设置窗口 → 第三方插件」勾选即可，
>   不需要命令行（在 GUI 里手动装自己的 checkout 会被启动维护换回随包那一份，这是有意设计）；
> - **其它 DSH 宿主**（`dsh web`、CLI 等）：按下文从源码装。
>
> 等注册能走通了，会按原计划发布到 npm，那时 `dsh plugin --profile web add dsh-model-surplus` 即可。

**方式一：DSH Ready GUI（推荐）** —— 这四个插件随 GUI 内置。打开 GUI → 设置窗口 → 第三方插件
→ 勾选 **模型余量（dsh-model-surplus）**。安装、卸载、启用/禁用都在同一个窗口里，装完按提示重启引擎。

**方式二：其它 DSH 宿主** —— 先把本仓库 clone 到本地，再按**目录**安装：

```sh
git clone https://github.com/itchenshi/dsh-model-surplus.git
dsh plugin --profile web add file:<clone 出来的绝对路径>
```

装的是磁盘上的真实目录，所以之后 `git pull` 更新的就是同一份代码；反过来，**换机或移动目录会
让这条依赖失效**（那时重新 add 一次即可）。

之后需要重启 `dsh web`（或重新打开 DSH GUI）。[插件市场](https://github.com/dsh-market/dsh-market)
里的一键安装依赖 npm 上的包，而这个包还没发布，所以**现在市场里装不到它** —— 请用上面的两种
方式之一；等发布到 npm 之后会照常可装。

> **由 `dsh-model-usage` 改名而来。** 另外三个 GitHub 仓库已经用了这个确切名字，所以包在首次
> 发布之前就改了名。补丁行的 `id` 仍保持 `model-usage`，因此已有的启用/禁用选择不会丢失。

## 权限、依赖与失败边界

会锁定到某个 commit 的市场（DSH STORE 之类）会静态审查运行时代码，并报告它们检测到的权限。
以下是事实，免得任何一条需要靠推测：

- **运行时依赖：** 无 —— 只用 Node 内置模块（`node:path`、`node:fs/promises`）。宿主端是纯
  ESM，自身不要求 `node_modules`。
- **对外网络：有，三个主机**，全部来自**宿主端**。页面端除了下面那条本地路由之外不与任何
  东西通信。
  - `GET https://opencode.ai/zen/go/v1/usage` —— OpenCode Go 套餐用量（`OPENCODE_GO_API_KEY`）。
  - `GET https://api.deepseek.com/user/balance` —— DeepSeek 账户余额（`DEEPSEEK_API_KEY`）。
  - `GET https://opencode.ai/docs/zh-cn/go/` —— 文档里写的单模型月度上限；之所以要抓页面，
    是因为网关自己的 `/models` 响应不带任何上限信息。
- **本地路由：有一条。** 宿主注册唯一一条面向页面的路由，页面端以同源方式调用它。它经过引擎
  的信任围栏（Host 白名单 + 浏览器会话 cookie），围栏不可用时**失败即关闭**（fail closed）。
- **文件：有一个缓存。** `<DSH_HOME>/logs/model-surplus-limits.json` 存放抓取到的上限表，这样
  重启就不必重新抓取。除此之外不读不写任何东西，也从不触碰用户文件。
- **凭据：** 仅在宿主端通过 `ctx.credentials` 读取。它们绝不会出现在任何返回给页面的响应里。
- **命令 / 原生产物 / 生命周期脚本：** 无。
- **失败边界：** 两个分区各自独立上报结果，所以缺密钥或上游不可达只会让那一半降级，并说明
  原因。本插件从不阻塞引擎启动 —— 加载失败由引擎上报，移除插件即可恢复原来的标题栏。

## 配置

插件的这一行配置位于 `cordis.patch.yml`；每个键都是可选的：

```yaml
- insert:
    - id: model-usage
      name: dsh-model-surplus
      config:
        enabled: true

        opencodeGo:
          baseUrl: https://opencode.ai/zen/go/v1   # 上游根地址
          apiKeyRef: OPENCODE_GO_API_KEY           # 凭据引用
          providers: [opencode-go, opencode]       # 视为 OpenCode Go 的路由

        deepseek:
          baseUrl: https://api.deepseek.com        # 上游根地址
          apiKeyRef: DEEPSEEK_API_KEY              # 凭据引用
          providers: [deepseek-official]           # 引擎的 DeepSeek 路由
```

顶层写 `baseUrl` / `apiKeyRef` / `providers` 仍会按 `opencodeGo` 分区读取（本插件以前只支持
OpenCode Go）。

## 开发

```sh
node --check lib/index.js
npm test        # 本地行为测试（不联网、不需要引擎）
```

`tests/e2e.cjs` 是针对真实引擎 + 浏览器的完整集成检查（它需要一个正在运行的 profile，
所以不属于 `npm test`）。

## 许可证

MIT
