# dsh-model-surplus

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

在会话标题右侧显示**当前模型的用量 / 套餐额度 / 账户余额** —— 用到哪个模型，就显示哪一份。

## 它做什么

- 会话标题右侧的小组件，按**当前选中的模型**决定显示哪一份，切模型立即显示或隐藏。
- OpenCode Go：滚动 / 周 / 月三个窗口的百分比，外加所选模型的月度上限（如 `上限 $60`）。
- DeepSeek：账户余额（总 / 赠送 / 充值）；余额不可用时显示「余额不足」。
- Command Code：5 小时 / 周两个窗口的已用与上限，以及账户剩余额度。
- 三个分区各自独立上报：只配一个密钥时另外两半照常工作，缺的那半显示原因（`no key` / `usage n/a`）。

## 安装

- **用 DSH Ready GUI（推荐）**：插件随 GUI 内置，打开 GUI → 设置窗口 →「第三方插件」勾选**模型余量**，装完按提示刷新页面（它带页面半边）。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 任选一条：

  ```sh
  # 推荐：直接从 GitHub 装
  dsh plugin --profile web add github:itchenshi/dsh-model-surplus

  # 备选：从本仓库 Release 的 tarball 装
  dsh plugin --profile web add https://github.com/itchenshi/dsh-model-surplus/releases/download/v0.4.6/dsh-model-surplus-0.4.6.tgz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> 本包还不在 npm 上（`registry.npmjs.org` 查无此包），只能用上面两种方式装。

## 使用

装好、重启引擎、刷新页面后，小组件出现在**会话标题右侧**，每 60 秒向宿主路由取一次数据。

上游请求都在宿主端发出，密钥按引用从引擎的凭据服务读取（先看路由自己声明的 `apiKeyEnv`，再看分区的默认引用名）；**密钥不会下发到浏览器**。

| 分区 | 默认凭据引用 |
|---|---|
| OpenCode Go | `OPENCODE_GO_API_KEY` |
| Command Code | `COMMANDCODE_GOAT_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

## 配置

`cordis.patch.yml` 里 `id: model-usage` 这一行的 `config`，全部可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时整个插件直接返回 |
| `opencodeGo.baseUrl` | `https://opencode.ai/zen/go/v1` | 上游根地址 |
| `opencodeGo.apiKeyRef` | `OPENCODE_GO_API_KEY` | 凭据引用名 |
| `opencodeGo.providers` | `[opencode-go, opencode]` | 视为 OpenCode Go 的路由 |
| `deepseek.baseUrl` | `https://api.deepseek.com` | 上游根地址 |
| `deepseek.apiKeyRef` | `DEEPSEEK_API_KEY` | 凭据引用名 |
| `deepseek.providers` | `[deepseek-official]` | 视为 DeepSeek 的路由 |
| `commandcode.baseUrl` | `https://api.commandcode.ai` | 额度接口根地址；写聊天地址 `.../provider/v1` 也认 |
| `commandcode.apiKeyRef` | `COMMANDCODE_GOAT_API_KEY` | 凭据引用名 |
| `commandcode.providers` | `[commandcode-goat, commandcode]` | 视为 Command Code 的路由 |

顶层直接写 `baseUrl` / `apiKeyRef` / `providers` 仍按 `opencodeGo` 分区读（插件早期只有 OpenCode Go）。

## 兼容性

- 需要 **DSH >= 0.1.5-rc.2**；清单里 0.1.5-rc.2 与 0.2.0-rc.2 标为 compatible。
- Node >= 20。
- 更早的引擎版本没有测试过；三个分区各自独立降级。

## 常见问题

**看不到小组件？** 只有当前选中的模型属于受跟踪路由时才出现；自定义路由名要加进对应分区的 `providers`。

**显示 `no key`？** 那个分区没取到密钥。宿主启动时会打 `[model-usage] active (opencode-go: providers=opencode-go|opencode key=OPENCODE_GO_API_KEY; ...)`，日志里没有它说明插件没加载。

**数据多久更新一次？** 每个分区缓存 120 秒（失败后 30 秒内不重试）。单模型月度上限取自公开文档页 `https://opencode.ai/docs/zh-cn/go/`（不需要密钥），缓存在 `<DSH_HOME>/logs/model-surplus-limits.json`，每 24 小时刷新一次，抓取失败时回退到缓存、再回退到内置表（日志：`[model-usage] limits refreshed from docs (...)` 或 `limits refresh failed (...)`）。

**百分比和上限为什么对不上？** 用量百分比是**账户级**的（上游接口忽略单模型参数），月度上限是**所选模型**的。

## 开发

```sh
node --check lib/index.js
npm test        # node tests/test.mjs：本地行为测试（不联网、不需要引擎）
```

`tests/e2e.cjs` 是针对真实引擎 + 浏览器的集成检查，需要跑着的 profile，所以不在 `npm test` 里。

## 许可

MIT
