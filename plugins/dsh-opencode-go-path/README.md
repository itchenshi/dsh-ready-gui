# dsh-opencode-go-path

OpenCode / OpenCode Go 路由的一站式插件：**声明协议 + 自动补 DeepSeek V4.1
模型 + 附加会话头**。装上即用，不需要手改配置。

（合并自原 `dsh-opencode-go-session` 与 `dsh-opencode-go-api` 两个插件；包名
`dsh-opencode-go` → `dsh-opencode-go-path`，因为原名在 npm 上已被其他作者占用。）

## 它做三件事

### 1. 声明 `opencode-go` 路由的 wire 协议

引擎 `dsh-llm-pi-ai` 对每个路由的每个模型按如下顺序解析 `api`：

```
route.api  ??  目录里该模型的 api  ??  目录内全部模型共有的 api
```

- `opencode-go` 目录里的模型横跨三种协议（anthropic-messages /
  openai-completions / openai-responses），第三项无法推断；
- 目录外的模型（如 `deepseek-v4.1-flash`，上游已提供、pi-ai 目录尚未收录）
  第二项也没有；
- 路由没声明 `api` → 第一项也没有 → 报「needs an api」，GUI 模型页添加该模型
  时的严格校验也会拒绝保存。

插件通过 `cordis.patch.yml` 给 `llm-pi-ai` row 补
`providers.opencode-go.api: openai-completions`（OpenCode Go 的 OpenAI 兼容
端点就说的这个协议）。

### 2. 自动添加 DeepSeek V4.1 模型

引擎启动后，运行时（`lib/index.js`）等 `llm-pi-ai` 设置命名空间就绪，然后：

- **用户在 `settings.yaml` 里已配置** `opencode-go` 的 `models` 列表、且列表里没有
  `deepseek-v4.1-*` → 自动追加（走与 GUI 模型页相同的 `settings.update` 写入路径，
  落在 `settings.yaml`，严格校验因为有 api 而通过）；
- **用户没有配置 `models`** → 什么都不做。引擎把「非空的已配置列表」当作该 provider 的
  **完整**模型集（`entries = configured.length > 0 ? configured : defaults`），所以往一个
  空列表里写入会把整个内置目录替换成我们写的那几个模型 —— 此时引擎自带的目录才是权威；
- 已有 v4.1 模型 → 不动（幂等）。

> 判定读的是**用户层**（`settings.section(NS)`）而不是合并后的 `resolved`：本插件自己的
> 补丁会注入 `providers.opencode-go.api`，合并层永远有这个路由，用「路由是否存在」当守卫
> 是永远不会生效的。

路由存在性检查、模型列表拼接与「是否已含 v4.1」分别是
`nextV41Models()` / `appendV41Models()` / `isV41()`，都有单测覆盖。

### 3. 附加 `x-opencode-session` 头

OpenCode 的中继会把携带相同 `x-opencode-session` 的请求固定到同一个上游
后端，让一轮对话的 prompt 缓存保持命中（修复 400 MissingSessionID）。

**默认是安全模式**：每个 DSH 会话派生一个随机不透明 UUID，**绝不把内部会话
ID 发给第三方**；`mode: 'session-id'` 是显式可选（仅在你完全信任上游时才用）。

## 配置（`cordis.patch.yml` 的行 config，全部可选）

| 键 | 说明 |
|---|---|
| `providers` | 附加会话头的路由名，默认 `['opencode', 'opencode-go']`；自定义路由名时加进来 |
| `mode` | `'uuid'`（默认，安全）或 `'session-id'`（显式可选，会发送内部会话 ID） |
| `debug` | `true` 时记录每个收到头的流式调用 |
| `debugFile` | 追加一行 JSON 的路径；**仅** `$DSH_HOME/logs` 或系统临时目录下的路径生效，日志里的 `session` 字段是 SHA-256 单向散列 |

## 安装

```sh
dsh plugin --profile web add dsh-opencode-go-path
```

装完**重启 `dsh web`**（或重开 DSH GUI）。在 DSH GUI 里也可以在
「设置窗口 → 第三方插件」里勾选安装同一个包（显示为 **OpenCode Go 路由**）。

验证：

- 会话模型选择器里出现 `DeepSeek V4.1 Flash`；
- `dsh --profile web --dump-config` 里 `llm-pi-ai` row 带
  `config.providers.opencode-go.api: openai-completions`。

卸载：`dsh plugin --profile web remove dsh-opencode-go-path`
（自动添加的模型条目会留在 `settings.yaml`，可手动删）。

> 包名里的 `-path` 后缀是**必需的**：`dsh-opencode-go` 与 `dsh-opencode-go-plus`
> 在 npm 上都已被其他作者占用。后缀只影响安装时写的包名，与功能无关。

## 权限、依赖与失败边界

会把仓库固定到某个 commit 再审查的商城（DSH STORE 之类）会对运行时代码做静态扫描，
并按检测到的信号给出权限结论。这里把事实一次写清，免得被推断：

- **运行依赖：无。** 只用 Node 内建模块（`node:async_hooks`、`node:crypto`、
  `node:fs/promises`、`node:path`、`node:timers/promises`）。
- **出站网络：无。** 本插件**不发起任何请求**。它包装 `globalThis.fetch`，给发往
  OpenCode 路由的请求附加 `x-opencode-session` 头（修复 400 MissingSessionID）。
  「网络信号」来自这个包装行为，而不是它自己去连谁。
- **文件：默认没有。** 唯一会写文件的情况是你在补丁层的行 config 里**显式配置了
  `debugFile`** —— 那时它按行向该路径追加 JSON 调试日志，并且只接受
  `$DSH_HOME/logs` 或系统临时目录下的路径，其它路径直接忽略。日志里的会话标识是
  单向 SHA-256，不是原始会话 ID。
- **本机路由：无。** 这个插件没有页面半边，不注册任何 HTTP 路由。
- **凭据 / 命令 / 原生制品 / 生命周期脚本：无。**
- **模型自动补齐是幂等的**：路由不存在时什么都不做；存在且已有所需模型时也不写。
- **失败边界**：插件依赖的是引擎装配层与 settings 服务的公开契约，不是引擎版本号。
  契约若变，引擎会在启动时**显式报出插件加载失败**，而不是静默失效；补丁层的行 id
  是 `opencode-go`，卸载后 `settings.yaml` 里自动补的模型条目会留下，可手动删。

## 从旧插件升级

原 `dsh-opencode-go-session` 与 `dsh-opencode-go-api` 已合并进本插件；v0.5.0 起
包名又从 `dsh-opencode-go` 改为 `dsh-opencode-go-path`。两种改名都由 DSH GUI 的
启动维护自动完成：卸掉旧包、清理补丁层遗留行、装上本插件，并**保留你原来的
启用/禁用选择**。补丁层的行 id 仍是 `opencode-go`，所以禁用行不会失配。

## 机制

- 引擎把 profile 的 bundle patch 层与用户设置合并：
  `resolve(schema, base, section)` = `mergeLayers(base, section)`，base 在下、
  用户 `settings.yaml` 在上；插件 patch 给 base 层补 `api`。
- 运行时通过 `ctx.settings` 等命名空间注册后读/写模型列表（同 GUI 模型页路径）。
- 会话头走 `globalThis.fetch` 补丁 + `llm/stream` 瀑布事件，仅在对应路由的流式
  调用期间生效（AsyncLocalStorage 作用域），不污染其它请求。

## License

MIT