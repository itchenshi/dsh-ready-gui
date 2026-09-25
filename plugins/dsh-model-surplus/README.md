# dsh-model-surplus

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

> 这是 **DSH Ready GUI** 的组成部分之一 —— GUI 开箱内置四个插件，勾选即用。
> 也可单独装到任何 DSH 宿主里（见下方「装上就能用」）。
> GUI：https://github.com/itchenshi/dsh-ready-gui

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**会话标题右侧**显示
**当前模型的用量 / 账户余额** —— 用到哪个模型，就显示哪一份，不用切页面去查。

```
┌─ 会话标题栏 ───────────────────────────────────────────────────────────────┐
│  我的对话     [OpenCode Go 滚动 18% 周 82% 月 42% 上限 $60]        打开功能 ▾ │
│  另一个对话   [Command Code 5 小时 17.9% 周 17.1% 剩余 $13.50]     打开功能 ▾ │
│  还有一个     [DeepSeek ¥110.00]                                   打开功能 ▾ │
└────────────────────────────────────────────────────────────────────────────┘
```

| 当前模型路由 | 显示什么 | 数据从哪来 |
|---|---|---|
| `opencode-go` / `opencode` | 套餐用量：滚动 / 周 / 月**百分比** + 重置时间，外加**所选模型**的月度上限（`上限 $60`） | `GET https://opencode.ai/zen/go/v1/usage` + 单模型上限表 |
| `commandcode-goat` / `commandcode` | **5 小时 / 周**两个窗口的百分比（含已用 / 上限）+ **剩余额度** | `GET https://api.commandcode.ai/alpha/billing/credits` |
| `deepseek-official` | 账户**余额**：总 / 赠送 / 充值（余额不足时显示「余额不足」） | `GET https://api.deepseek.com/user/balance` |

只有当会话选中的模型属于受跟踪的 provider 时它才出现 —— 切模型就立刻显示/隐藏，不用刷新。

## 装上就能用

- **用 DSH Ready GUI（推荐）**：插件**随 GUI 内置**。打开 GUI → 设置窗口 → 第三方插件 → 勾选
  **模型余量**，装完按提示重启引擎、按提示刷新页面（它带页面部分）。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 两条路都行，任选一条：

  ```sh
  # 推荐：直接从 GitHub 装（记进 profile，之后可跟着更新）
  dsh plugin --profile web add github:itchenshi/dsh-model-surplus

  # 备选：本 Release 的 tarball（git 协议走不通、但 HTTPS 能通时用这条）
  dsh plugin --profile web add https://github.com/itchenshi/dsh-model-surplus/releases/download/v0.4.1/dsh-model-surplus-0.4.1.tar.gz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> npm 上暂时没有这个包：注册账号那一环走不通（`www.npmjs.com` 返回 Cloudflare 托管挑战），包发不
> 出去。所以现在只能按上面两种方式装。等注册通了会照常发布。

**要配的只有密钥**，插件通过引擎的凭据服务按引用读取，**密钥不会下发到浏览器**：

| 路由 | 凭据名 |
|---|---|
| OpenCode Go | `OPENCODE_GO_API_KEY` |
| Command Code | `COMMANDCODE_GOAT_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

三个分区**各自独立**上报结果：只配了其中一个密钥，另外两半照样能用，缺的那半显示一条原因
（`no-key` / `unauthorized` / `network` / `timeout` / `bad-payload`），而不是把整个小组件藏起来。

## Command Code 分区的两个细节

**一、它查的是额度接口，不是聊天接口。** DSH 路由上配的是聊天地址
`https://api.commandcode.ai/provider/v1`，而额度接口在**上一层**的根路径
（`/alpha/billing/credits`）。插件会自动把 `/provider/v1` 去掉，所以你在配置里写哪个都行。

**二、它不显示「月度百分比」。** 接口给的是它实际执行的两个窗口（5 小时、周）的
已用 / 上限，以及**剩余额度**；但**没有**给出套餐的月度总额度。所以这里只显示两个窗口的百分比
和剩余额度 —— 要有月度百分比就得内置一张套餐表（按 Go / GOAT / Max 档位），那属于猜测，不如不显示。

## 单模型月度上限是怎么来的

OpenCode Go 的用量接口**按账户统计**，忽略单模型参数；而[官方「使用限制」](https://opencode.ai/docs/zh-cn/go/#%E4%BD%BF%E7%94%A8%E9%99%90%E5%88%B6)
里写的单模型月度上限**没有 API**（例如 DeepSeek V4.1 Flash $60/月、DeepSeek V4 Pro $15/月）。所以：

1. **内置一张表**（`BUILTIN_MODEL_LIMITS`），
2. **自动刷新**：抓公开文档页（服务端渲染、不需要 JS、**不需要密钥**），把限制表和模型 id 表解析成
   `模型 id → 月度 $`，
3. 结果**缓存**在 `$DSH_HOME/logs/model-surplus-limits.json`，重启不必重抓，
4. 任何抓取/解析失败都**回退**：缓存 → 内置表。

刷新时机：插件启动时一次，之后每 24 小时一次。tooltip 会列出推导出的各档上限（5h = 20% · 周 = 50% ·
月 = 100%）、数据来源（文档 / 本地缓存 / 内置表），并说明百分比是账户级的、上限是单模型的。

## 配置（`cordis.patch.yml` 的行 config，全部可选）

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

        commandcode:
          # 额度接口的根地址；写聊天地址 .../provider/v1 也认（会自动去掉那一层）
          baseUrl: https://api.commandcode.ai
          apiKeyRef: COMMANDCODE_GOAT_API_KEY      # 凭据引用
          providers: [commandcode-goat, commandcode]  # 视为 Command Code 的路由
```

改 `providers` 就能把别的路由划进某个分区，**不用改页面代码**——供应商到分区的映射由宿主端每次
轮询时下发。顶层直接写 `baseUrl` / `apiKeyRef` / `providers` 仍按 `opencodeGo` 分区读（本插件早期
只有 OpenCode Go）。

## 权限与边界（给会静态扫描的商城看的）

会锁定 commit 审查的商城会静态扫描运行时代码，这里把事实一次写清：

- **运行依赖：无。** 只用 Node 内建模块（`node:path`、`node:fs/promises`）；宿主半边是纯 ESM，
  自身不要求 `node_modules`。
- **对外网络：有，四个主机**，全部来自**宿主端**（页面端只调下面那条本地路由）：
  - `GET https://opencode.ai/zen/go/v1/usage` —— OpenCode Go 套餐用量（`OPENCODE_GO_API_KEY`）
  - `GET https://api.commandcode.ai/alpha/billing/credits` —— Command Code 窗口用量与剩余额度
    （`COMMANDCODE_GOAT_API_KEY`）
  - `GET https://api.deepseek.com/user/balance` —— DeepSeek 账户余额（`DEEPSEEK_API_KEY`）
  - `GET https://opencode.ai/docs/zh-cn/go/` —— 文档里的单模型月度上限；之所以要抓页面，是因为网关
    自己的 `/models` 响应不带任何上限信息
- **本机路由：一条。** 宿主注册唯一一条面向页面的路由，页面以同源方式调用；它走引擎自己的信任围栏
  （Host 白名单 + 浏览器会话 cookie），围栏拿不到时**失败即关闭**。**不带 cookie 的裸 `curl` 会得到
  401**（修复前返回 200 —— 任何本机进程、被 DNS rebinding 的页面都能读到你的用量和余额）。
- **文件：一个缓存。** `<DSH_HOME>/logs/model-surplus-limits.json` 存抓到的上限表，其余不读不写，
  也从不碰你的文件。
- **凭据：** 只在宿主端经 `ctx.credentials` 读取，绝不出现在任何返回给页面的响应里。
- **命令 / 原生制品 / 生命周期脚本：无。**
- **失败边界：** 两个分区各自独立上报，缺密钥或上游不可达只会让那一半降级并说明原因；插件从不阻塞
  引擎启动，卸载即恢复原来的标题栏。

## 两部分构成

| 部分 | 文件 | 运行于 | 职责 |
|---|---|---|---|
| 宿主端 | `lib/index.js` | Node | 按分区抓上游数据，经一条同源 JSON 路由提供出去 |
| 页面端 | `client/client.js` | 浏览器 | 注册标题栏小组件；轮询宿主路由；按当前模型门控 |

宿主路由的返回形状（手工调试用；记得带引擎的会话 cookie）：

```
GET /model-usage
{
  "ok": true,
  "sections": { "opencode-go": { "providers": ["opencode-go","opencode"], "keyRef": "OPENCODE_GO_API_KEY" },
                "deepseek":    { "providers": ["deepseek-official"],    "keyRef": "DEEPSEEK_API_KEY" } },
  "opencode-go": { "ok": true, "usage":   { "rolling": {…}, "weekly": {…}, "monthly": {…} } },
  "deepseek":    { "ok": true, "balance": { "isAvailable": true, "infos": [ { "currency":"CNY", "total":"110.00", … } ] } },
  "limits": { "deepseek-v4.1-flash": { "hours5": 12, "weekly": 30, "monthly": 60 } }
}
```

宿主会归一化并钳制用量百分比（0–100），也接受上游发来的十进制**字符串**金额；每个分区缓存 60 秒，
失败后最快 30 秒才重试。

## 开发

```sh
node --check lib/index.js
npm test        # 本地行为测试（不联网、不需要引擎）
```

`tests/e2e.cjs` 是针对真实引擎 + 浏览器的完整集成检查（需要跑着的 profile，所以不在 `npm test` 里）。

## 许可

MIT
