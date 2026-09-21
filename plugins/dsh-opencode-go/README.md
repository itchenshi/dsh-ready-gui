# dsh-opencode-go

OpenCode / OpenCode Go 路由的一站式插件：**声明协议 + 自动补 DeepSeek V4.1
模型 + 附加会话头**。装上即用，不需要手改配置。

（合并自原 `dsh-opencode-go-session` 与 `dsh-opencode-go-api` 两个插件。）

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

随 DSH GUI 的「设置窗口 → 第三方插件」勾选安装。手动安装：

```sh
dsh plugin --profile web add file:./plugins/dsh-opencode-go
```

装完重开 DSH GUI（或等引擎重启）。验证：

- 会话模型选择器里出现 `DeepSeek V4.1 Flash`；
- `dsh --profile web --dump-config` 里 `llm-pi-ai` row 带
  `config.providers.opencode-go.api: openai-completions`。

卸载：`dsh plugin --profile web remove dsh-opencode-go`
（自动添加的模型条目会留在 `settings.yaml`，可手动删）。

## 从旧插件升级

原 `dsh-opencode-go-session` 与 `dsh-opencode-go-api` 已合并进本插件。GUI 启动
时会自动卸掉旧包并装上本插件，并保留你原来的启用/禁用选择；旧补丁层的遗留行
也会被清理。

## 机制

- 引擎把 profile 的 bundle patch 层与用户设置合并：
  `resolve(schema, base, section)` = `mergeLayers(base, section)`，base 在下、
  用户 `settings.yaml` 在上；插件 patch 给 base 层补 `api`。
- 运行时通过 `ctx.settings` 等命名空间注册后读/写模型列表（同 GUI 模型页路径）。
- 会话头走 `globalThis.fetch` 补丁 + `llm/stream` 瀑布事件，仅在对应路由的流式
  调用期间生效（AsyncLocalStorage 作用域），不污染其它请求。

## License

MIT