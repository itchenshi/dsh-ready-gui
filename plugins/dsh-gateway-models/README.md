# dsh-gateway-models

只有宿主半边的插件：给网关路由（OpenCode Go + Command Code）补齐引擎拿不到的协议、地址与模型清单，并给发往 OpenCode 的请求附加会话头。

## 它做什么

- 给 `opencode-go` 路由声明 wire 协议（`api: openai-completions`），目录外的模型不再报 `needs an api`。
- 启动时读引擎自己的模型目录，把 DeepSeek V4.1 模型补进 `opencode-go` 清单并排到**第一位**（你自己配过的条目原样保留、顺序不变）。
- 路由没有 `baseURL` 时补上 `https://opencode.ai/zen/go/v1`；你已经配过的地址一个字节都不动。
- 给 `commandcode` 路由声明 `api` 与 `baseURL`（你只填密钥，不用填地址），并从它**公开的目录接口**补齐模型清单（只增不改、幂等）。
- 给发往 OpenCode / OpenCode Go 路由的请求附加 `x-opencode-session`：默认每个会话一个随机 UUID，**绝不把内部会话 ID 发给第三方**（`mode: 'session-id'` 是显式可选）。

## 安装

- **用 DSH Ready GUI（推荐）**：插件随 GUI 内置，打开 GUI → 设置窗口 →「第三方插件」勾选**网关路由**，装完按提示**重启引擎**（它没有页面半边）。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 任选一条：

  ```sh
  # 推荐：直接从 GitHub 装
  dsh plugin --profile web add github:itchenshi/dsh-gateway-models

  # 备选：从本仓库 Release 的 tarball 装
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gateway-models/releases/download/v0.2.6/dsh-gateway-models-0.2.6.tgz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> 本包还不在 npm 上（`registry.npmjs.org` 查无此包），只能用上面两种方式装。

## 使用

没有页面半边，也不需要打开任何界面 —— 重启引擎后它在装配层改配置。你可以在模型选择器里确认：**第一项是 `DeepSeek V4.1 Flash`**，`llm-pi-ai.providers.opencode-go` 里它排在第一位。

Command Code 那一半只对**你自己配置过的路由**（用户层里有它，比如填过密钥）动手，并按**接口地址**（`api.commandcode.ai`）识别路由 —— 路由名叫 `commandcode`、`commandcode-goat` 还是别的都行。

## 配置

`cordis.patch.yml` 里 `id: opencode-go` 这一行的 `config`，全部可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `providers` | `[opencode, opencode-go]` | 附加会话头的路由名；自定义路由名时加进来 |
| `commandcodeProviders` | 无 | 额外的 Command Code 路由 id；仅当某条路由的地址在配置里看不到时才要填 |
| `mode` | `uuid` | `uuid` = 每会话随机 UUID（安全默认）；`session-id` = 发送内部会话 ID |
| `debug` | `false` | `true` 时记录每个收到会话头的流式调用 |
| `debugFile` | 无 | 追加 JSON 日志的路径；**仅** `$DSH_HOME/logs` 或系统临时目录下的路径生效，超过 8 MiB 停止追加 |

## 兼容性

- 需要 **DSH >= 0.2.0-rc.2**（引擎 0.2.0 更换了设置服务 API，0.1.x 上无法写入路由配置）。
- Node >= 20。
- 依赖的是引擎装配层、`settings` 服务与 `llm` 事件的公开契约；契约变了引擎会在启动时显式报插件加载失败，而不是静默失效。

## 常见问题

**V4.1 模型没出现？** 看宿主启动日志有没有 `[gateway-models] active for providers [opencode, opencode-go] with mode uuid (debug=off)`。如果打的是 `llm.discoverModels() is unavailable` 或 `could not detect the "opencode-go" model catalog`，说明引擎目录读不到 —— 这时插件**跳过**自动补模型，而不是猜。

**Command Code 的模型列表没补齐？** 正常会打 `[gateway-models] "commandcode": N model(s) from the provider catalog (list X -> Y)`；如果打的是 `could not read the Command Code model catalog (...)`，说明那次公开目录请求失败了，插件保持原列表不动。

**它会读我的 API key 吗？** 不会。插件只写路由配置，密钥始终由引擎按 `apiKeyEnv` 自己解析。唯一出站请求是 `GET https://api.commandcode.ai/provider/v1/models`（公开、不需要 key、请求里不发 Authorization）。它也不注册任何本机 HTTP 路由。

**写配置失败会留下半份吗？** 不会。写入走 `settings` 服务，会重跑引擎的严格校验，校验不过整笔拒绝（日志给出原因）。

## 开发

```sh
node --check lib/index.js
npm test        # node tests/test.mjs：本地行为测试（不联网、不需要引擎）
```

新增 V4.1 型号只需往 `V4_1_MODELS` 里加一条；`planRouteUpdate()` / `withV41ModelsFirst()` / `withV41Defaults()` / `isV41()` 分别负责「写什么」「怎么置顶」「怎么补字段」「是不是 v4.1」，都有单测。

## 许可

MIT
