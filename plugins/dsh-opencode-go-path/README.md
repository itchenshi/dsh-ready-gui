# dsh-opencode-go-path

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

OpenCode / OpenCode Go 路由的**一站式**插件：装上、勾上、就能用 —— 不用手改配置，不用命令行。

## 它替你解决什么

| 你会遇到的问题 | 插件做的事 |
|---|---|
| 模型列表里没有 `deepseek-v4.1-flash`，想加还报 `needs an api` | 给 `opencode-go` 路由声明 wire 协议，目录外的模型也能用 |
| 模型目录里翻不到厂商新发的模型 | 引擎启动时**自动读目录**，把 DeepSeek V4.1 模型补进去并排到**第一位** |
| 加了模型却发不出请求、保存还被拒 | 自动补上路由的 `baseURL`（目录里没有的模型必须靠它才有地址） |
| 多轮对话报 **400 `MissingSessionID`** | 给发往 OpenCode 的请求附加按会话的 `x-opencode-session` 头 |
| 多轮对话报 **400 `reasoning_content` must be passed back** | 给目录外的 V4.1 模型补上 DeepSeek 的思考协议声明 |

## 装上就能用

- **用 DSH Ready GUI（推荐）**：插件**随 GUI 内置**。打开 GUI → 设置窗口 → 第三方插件 → 勾选
  **OpenCode Go 路由**，装完按提示重启引擎。
- **其它 DSH 宿主**（`dsh web` / CLI）：

  ```sh
  git clone https://github.com/itchenshi/dsh-opencode-go-path.git
  dsh plugin --profile web add file:<clone 出来的绝对路径>
  ```

  装到的是磁盘上的真实目录，所以以后 `git pull` 更新的就是同一份代码；反过来，**目录被移动或删掉
  会让这条依赖失效**（重新 add 一次即可）。

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

### 3. 附加会话头

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
| `mode` | `'uuid'`（默认，安全）或 `'session-id'`（显式可选，会发送内部会话 ID） |
| `debug` | `true` 时记录每个收到头的流式调用 |
| `debugFile` | 追加 JSON 日志的路径；**仅** `$DSH_HOME/logs` 或系统临时目录下的路径生效；日志里的 `session` 是 SHA-256 单向散列 |

## 权限与边界（给会静态扫描的商城看的）

- **运行依赖：无。** 只用 Node 内建模块。**出站网络：无。** 插件自己不发起任何请求；它包装
  `globalThis.fetch` 加头，并调用引擎自己的 `llm.discoverModels()`（对自带目录的路由直接返回目录，
  不触网）。
- **文件：默认没有。** 只有你显式配了 `debugFile` 才会写，且只接受 `$DSH_HOME/logs` 或系统临时目录。
- **本机路由：无。** 没有页面半边，不注册任何 HTTP 路由。
- **凭据 / 命令 / 原生制品 / 生命周期脚本：无。**
- **失败边界**：依赖的是引擎装配层、`settings` 服务与 `llm` 事件的公开契约，不是引擎版本号。契约
  变了，引擎会在启动时**显式报插件加载失败**，而不是静默失效。写入走 `settings` 服务，会重跑引擎
  的严格校验，校验不过整笔拒绝（日志给出原因），不会留下半份配置。

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
