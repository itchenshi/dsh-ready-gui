# dsh-gateway-models

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

> 这是 **DSH Ready GUI** 的组成部分之一 —— GUI 开箱内置四个插件，勾选即用。
> 也可单独装到任何 DSH 宿主里（见下方「装上就能用」）。
> GUI：https://github.com/itchenshi/dsh-ready-gui
>
> **2026-09-25 改名**：原名 `dsh-opencode-go-path`。它现在不只管 OpenCode Go —— 还给 Command Code
> 声明协议和地址、并从上游目录同步模型清单 —— 所以换成了不带厂商的名字。
> 补丁层的**行 id 仍是 `opencode-go`**（与包名解耦），**你的启用/禁用选择不会丢**；
> 旧仓库名由 GitHub 自动重定向，老安装照常可用。

网关路由的**一站式**插件（OpenCode Go + Command Code）：装上、勾上、就能用 —— 不用手改配置，
不用命令行，**也不用每次填 API 地址**。

## 它替你解决什么

| 你会遇到的问题 | 插件做的事 |
|---|---|
| 模型列表里没有 `deepseek-v4.1-flash`，想加还报 `needs an api` | 给 `opencode-go` 路由声明 wire 协议，目录外的模型也能用 |
| 模型目录里翻不到厂商新发的模型 | 引擎启动时**自动读目录**，把 DeepSeek V4.1 模型补进去并排到**第一位** |
| 加了模型却发不出请求、保存还被拒 | 自动补上路由的 `baseURL`（目录里没有的模型必须靠它才有地址） |
| 多轮对话报 **400 `MissingSessionID`** | 给发往 OpenCode 的请求附加按会话的 `x-opencode-session` 头 |
| 多轮对话报 **400 `reasoning_content` must be passed back** | 给目录外的 V4.1 模型补上 DeepSeek 的思考协议声明 |
| **Command Code 的模型一个都不在 DSH 里**，每加一个都要填 API 地址 | 补丁层直接声明 `commandcode` 路由的协议**和地址**，你只填密钥；启动时从它**公开的目录接口**把全部模型一次性补齐 |

### Command Code 那一半是怎么工作的

Command Code 不在引擎自带的 pi-ai 目录里（随包 40 个 provider，没有它），所以它的一切都推不出来：
每个模型都要路由级的 `api` 和 `baseURL`，模型 id 本身也得有来源 —— 这正是「每加一个模型都要填一遍
地址」的原因。插件把两头都补上：

1. **协议与地址**：`cordis.patch.yml` 为 `commandcode` 声明 `api` + `baseURL`。引擎解析模型地址是
   `route.baseURL ?? catalogModel.baseUrl ?? providerBaseUrl`，模型页探测也是
   `draft.baseURL ?? fallback.baseURL` —— 所以**路由有地址，你就永远不用填**。
2. **模型**：启动时读它自己**公开的目录接口**（`GET .../provider/v1/models`，**不需要密钥**，81 个
   模型，字段里就带 `context_length`），把列表补齐。

补的规则是**只增不改**：你已经有的条目（包括你自己改过的名字、容量）原样保留，缺的**追加在后面**，
所以你自己的排序不会被打乱。跑第二遍不会再写（幂等）。

> 这个路由的**目录归上游所有**，所以这里做的是「保证完整」，而不是像 OpenCode Go 那一半那样把某个
> 模型提到第一位。

### 一个路由名覆盖所有套餐：`commandcode`

**套餐是跟着账号和密钥走的，不跟着路由名、也不跟着地址走。** 同一个主机 `api.commandcode.ai` 服务
所有档位；key 在 `/alpha/billing/subscriptions` 里报 `planId`（`individual-go` / `individual-goat` /
`individual-pro` / `individual-max-10x` / `individual-max-20x` …），额度上限也由接口按档位返回。

所以默认路由名就叫 **`commandcode`**，**不带档位后缀** —— 档位不是路由决定的，叫 `commandcode-goat`
反而误导。**升级套餐只需要换 key，路由名和配置都不用动。**

老名字照常能用：插件按**接口地址**识别 Command Code 路由（host 是 `api.commandcode.ai`），
**不按名字**。所以原来那条 `commandcode-goat`、或者 `commandcode-pro` / `commandcode-max` /
社区插件的 `commandcode`，都会被自动补齐。对补丁没覆盖的名字，插件还会把它缺的 `api` 和 `baseURL`
一起写上 —— 引擎拒绝给「协议解析不出来」的路由存模型，而 Command Code 没有目录条目可解析。

如果某个路由的地址在配置里根本看不到（比如你把它代理到了自己的网关），用行配置
  `commandcodeProviders` 明确列出它的 id。

## 装上就能用

- **用 DSH Ready GUI（推荐）**：插件**随 GUI 内置**。打开 GUI → 设置窗口 → 第三方插件 → 勾选
  **网关路由**，装完按提示重启引擎。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 两条路都行，任选一条：

  ```sh
  # 推荐：直接从 GitHub 装（记进 profile，之后可跟着更新）
  dsh plugin --profile web add github:itchenshi/dsh-gateway-models

  # 备选：本 Release 的 tarball（git 协议走不通、但 HTTPS 能通时用这条）
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gateway-models/releases/download/v0.2.0/dsh-gateway-models-0.2.0.tar.gz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> npm 上暂时没有这个包：注册账号那一环走不通（`www.npmjs.com` 返回 Cloudflare 托管挑战），包发不
> 出去。所以现在只能按上面两种方式装。等注册通了会照常发布。

**怎么确认生效**：会话模型选择器的**第一项**是 `DeepSeek V4.1 Flash`；
`$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.opencode-go` 里有 `deepseek-v4.1-flash` 且排在
第一位（你自己没配 `baseURL` 时，插件会补一条 `https://opencode.ai/zen/go/v1`）。

## 它具体做了什么

### 1. 声明路由协议（配置层）

引擎给每个模型解析 `api` 的顺序是：

```
route.api  ??  目录里该模型的 api  ??  目录内所有模型共有的 api
```

`opencode-go` 目录里的模型横跨三种协议（anthropic-messages / openai-completions /
openai-responses），第三项推不出来；目录外的新模型（如 `deepseek-v4.1-flash`）连第二项都没有。
于是引擎报 `needs an api`，模型页的严格校验也拒绝保存。

插件通过 `cordis.patch.yml` 给 `llm-pi-ai` 行补 `providers.opencode-go.api: openai-completions`
（OpenCode Go 的 OpenAI 兼容端点说的就是这个协议）。

同一个补丁行也给 `commandcode` 补了 `api` **和 `baseURL`** —— Command Code 完全不在自带目录里，
没有目录可推，所以地址必须由补丁层提供；写在补丁层（基础层）意味着**你一次都不用填**，只需要给密钥。
（这个补丁只覆盖默认名字；别的名字由运行时按接口地址识别后自己补上 `api` 和 `baseURL`。）

### 2. 自动检测目录、补齐模型、放到最前（运行时）

引擎启动后，插件等 `llm-pi-ai` 命名空间就绪，然后：

1. **检测**：用引擎自己的 `llm.discoverModels()` 读出该路由的模型清单。对 pi-ai 自带目录的路由，
   这条通道**直接返回目录、不发网络请求**；插件刻意不传 `baseURL` 和凭据，所以「目录里没这个路由」
   时它会在**触网之前**失败退出 —— 检测不到就**不猜**。
2. **补齐并置顶**：
   - **你已经配了 `models`** → DeepSeek V4.1 放到**最前**，你自己的条目原样保留、顺序不变；
   - **你没配 `models`** → 用检测到的目录做种子，写出「V4.1 在最前 + 目录里全部模型」。引擎把
     「非空的已配置列表」当作该 provider 的**完整**模型集，只写我们那几个会把整个目录换掉，所以
     种子必须来自目录，一个都不能丢；
   - 判断「在不在列表里」按**我们自己的 id**，不是 `deepseek-v4.1` 前缀 —— 上游将来多出别的 v4.1
     型号，不该把已收录的 Flash 顶掉。
3. **没有 endpoint 就补上**：目录外的模型按
   `route.baseURL ?? 目录里该模型的 baseUrl ?? provider 级 baseUrl` 找地址，而 `opencode-go` 目录
   provider 级 `baseUrl` 是空的 —— 于是它**既发不出去也存不下来**（`needs a baseURL`）。插件在路由
   没有 `baseURL` 时补 `https://opencode.ai/zen/go/v1`；路由已经有（比如你指向了别的网关）就一个
   字节都不动。手写的配置里「已经排第一但缺 endpoint」也会被修好。
4. **幂等**：形状对、endpoint 在 → 不写、不发事件，不会和设置变更事件打转。

### 4. Command Code：从公开目录补齐模型（运行时）

同一个「等命名空间就绪」的时机里还有第二遍。它处理的是**所有** Command Code 路由：

1. **找路由**：按**接口地址**识别（host 是 `api.commandcode.ai`），**不按名字** —— 因为套餐跟着
   密钥走、路由名只是标签，Pro/MAX 用户可能把它叫做 `commandcode-pro` / `commandcode-max`。
   行配置 `commandcodeProviders` 可以额外指定 id（地址在配置里看不到时用）。
2. **门槛**：只在**你自己配过这些路由**（用户层里有它，比如填了密钥）时才动手。补丁层为所有人声明
   默认路由只是为了给地址，不代表你在用它 —— 往没在用的人的设置里塞 81 个模型是不能接受的。
3. **读目录**：`GET https://api.commandcode.ai/provider/v1/models`，
   **公开、不需要密钥**（请求里不发 Authorization）。这是本插件**唯一**的出站请求。
4. **只增不改**：你已经有的条目原样保留（包括你改过的名字、容量、顺序），缺的**追加在后面**。
   没有列表时（刚填完密钥）就按目录顺序**整份写入**。
   为什么必须带 `contextWindow`：这个路由没有自带目录可回退，不写就会让每个模型拿到路由默认的
   262144，而不是真实的 1M。
5. **补上缺的声明**：如果这条路由解析不出 `api`（或 `baseURL`）—— 补丁只覆盖默认名字，别的名字就是
   这种情况 —— 一并写上。引擎**拒绝**给协议解析不出来的路由存模型，不补的话整笔写入会被拒，
   表现就是「什么都没发生」。
6. **幂等**：列表完整、声明齐全 → 不写、不发事件。

### 5. 附加会话头

OpenCode 的中继会把携带相同 `x-opencode-session` 的请求固定到同一个上游后端，让一轮对话的 prompt
缓存保持命中（修复 400 MissingSessionID）。

**默认是安全模式**：每个 DSH 会话派生一个随机不透明 UUID，**绝不把内部会话 ID 发给第三方**。
`mode: 'session-id'` 是显式可选，仅在你完全信任上游时才用。

### 4. 补上目录外的思考协议（修 400 reasoning_content）

`deepseek-v4.1-flash` 不在已装目录里，所以引擎把它当成普通模型：不请求思考、也不回传
`reasoning_content`。而 pi-ai 的 DeepSeek 兼容是**按厂商名/域名自动探测**的，OpenCode Go 中继两样
都不匹配 —— 结果回放历史时缺少 `reasoning_content`，上游直接 400
（`The reasoning_content in the thinking mode must be passed back to the API`），该模型**每一轮多轮
对话都会失败**。

插件给这条条目补上目录本该提供的声明（取值与同路由的 `deepseek-v4-flash` / `-pro` 逐字一致）：
`compat.requiresReasoningContentOnAssistantMessages` / `thinkingFormat: deepseek` 与
`reasoningEfforts`。**只补不覆盖**：你改过的名字、容量、自己写过的 compat 开关都原样保留，所以你
已经加过的条目会被就地升级，不需要删了重加。

## 配置（`cordis.patch.yml` 的行 config，全部可选）

| 键 | 说明 |
|---|---|
| `providers` | 附加会话头的路由名，默认 `['opencode', 'opencode-go']`；自定义路由名时加进来 |
| `commandcodeProviders` | 额外的 Command Code 路由 id（默认不需要填：插件按接口地址自动识别 `api.commandcode.ai` 上的路由）。仅当某条路由的地址在配置里看不到时才用它明确指定 |
| `mode` | `'uuid'`（默认，安全）或 `'session-id'`（显式可选，会发送内部会话 ID） |
| `debug` | `true` 时记录每个收到头的流式调用 |
| `debugFile` | 追加 JSON 日志的路径；**仅** `$DSH_HOME/logs` 或系统临时目录下的路径生效；日志里的 `session` 是 SHA-256 单向散列 |

## 权限与边界（给会静态扫描的商城看的）

- **运行依赖：无。** 只用 Node 内建模块。
- **出站网络：一个公开 GET，不带任何凭据。** 插件只请求
  `GET https://api.commandcode.ai/provider/v1/models`，用来补齐 Command Code 的模型列表 —— 这个接口
  **公开、不需要 key**，请求里**不发 Authorization**。除此之外不发起任何请求：OpenCode Go 那一半调用
  引擎自己的 `llm.discoverModels()`（对自带目录的路由直接返回目录，不触网），加头走的是包装
  `globalThis.fetch`。
- **文件：默认没有。** 只有你显式配了 `debugFile` 才会写，且只接受 `$DSH_HOME/logs` 或系统临时目录。
- **本机路由：无。** 没有页面半边，不注册任何 HTTP 路由。
- **凭据 / 命令 / 原生制品 / 生命周期脚本：无。** 插件**从不读取任何 API key** —— 它只写路由配置，
  密钥始终由引擎按 `apiKeyEnv` 自己解析。
- **失败边界**：依赖的是引擎装配层、`settings` 服务与 `llm` 事件的公开契约，不是引擎版本号。契约
  变了，引擎会在启动时**显式报插件加载失败**，而不是静默失效。写入走 `settings` 服务，会重跑引擎
  的严格校验，校验不过整笔拒绝（日志给出原因），不会留下半份配置。
- **写入门槛**：Command Code 那一半只为**你自己配置过的路由**（用户层里有它，例如填了密钥）写模型
  列表 —— 补丁层为所有人声明默认路由只是为了提供地址，不代表你在用它，所以不会往没在用的人的设置里
  塞 81 个模型。哪条路由算数由它的**接口地址**（`api.commandcode.ai`）决定，与名字无关。

## 开发

```sh
node --check lib/index.js
npm test        # 本地行为测试（不联网、不需要引擎）
```

`V4_1_MODELS` 里加一个模型即可支持新的 V4.1 型号；`planRouteUpdate()` / `withV41ModelsFirst()` /
`withV41Defaults()` / `isV41()` 分别负责「写什么」「怎么置顶」「怎么补字段」「是不是 v4.1」，都有
单测覆盖。

## 许可

MIT
