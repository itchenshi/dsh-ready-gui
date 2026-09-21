# DSH GUI v0.4.0 更新说明

**发布日：2026-09-21** · 从 v0.3.0 累积的所有改动。

> 一句话：**两个 OpenCode 插件合并为「OpenCode Go 增强」并自动维护 DeepSeek V4.1 模型；用量插件新增选中模型的每月额度上限、并会自己从官方文档更新额度表；设置窗口的插件区更紧凑、描述更短。**

---

## 🔧 插件合并：`dsh-opencode-go`（「OpenCode Go 增强」）

原 `dsh-opencode-go-session`（会话头）与 `dsh-opencode-go-api`（路由协议 + V4.1 模型）**合并为一个插件**。
两个包名解决的是同一个 provider 的三件相关的事，拆成两个包既让用户困惑，也让「禁用/启用」要操作两次。

新插件一次做完三件事：

1. **声明路由协议**（`cordis.patch.yml` 的配置层）
   给引擎装配层的 `llm-pi-ai` row 补 `providers.opencode-go.api: openai-completions`。
   修的是这类报错：

   ```
   llm-pi-ai: provider "opencode-go" model "deepseek-v4.1-flash" needs an api;
   the installed catalog does not describe it, so set the route's api to
   the wire protocol its endpoint speaks
   ```

   根因：引擎按 `route.api ?? 目录里该模型的 api ?? 目录内全部模型共有的 api` 解析协议，
   而 `opencode-go` 目录里的模型横跨三种协议（anthropic-messages / openai-completions /
   openai-responses），第三项无法推断；目录外模型又没有第二项，于是必须由路由显式声明。
   补上之后，模型页「添加模型」的严格校验（保存路径）也能通过。

2. **自动补 DeepSeek V4.1 模型**（新增的运行时逻辑）
   引擎启动后等 `llm-pi-ai` 设置命名空间就绪，检查模型列表：
   **存在 `opencode-go` 路由且 `models` 里还没有 `deepseek-v4.1-*` 时自动追加**
   （走与模型页相同的 `settings.update` 写入路径，落在 `settings.yaml`，幂等）；
   路由不存在则完全不动，已有 v4.1 模型也不重复添加。

3. **附加会话头**（原 `dsh-opencode-go-session`）
   为发往 OpenCode / OpenCode Go 的请求附按会话 `x-opencode-session` 头，修复 400 MissingSessionID，
   让同轮对话的 prompt 缓存保持命中。**默认用不透明 UUID，绝不把内部会话 ID 发给第三方**
   （`mode: 'session-id'` 需显式开启）；头值校验、debugFile 白名单 + 哈希脱敏等加固逻辑原样保留。

**补掉一个致命缺陷**：原 `dsh-opencode-go-api` 的 `cordis.patch.yml` 只 patch 了 `llm-pi-ai` row，
**没有 insert 自己的 row** —— 插件的 `lib/index.js` 从未被引擎加载（等于死代码），设置窗口也拿不到它的 row id
（启用/禁用会失效）。新插件的 patch 同时 `insert` 自己的 row 与 patch `llm-pi-ai`，
且两条分开：**启用/禁用只会写 insert 的那一行**，永远不会连带打掉协议声明（有专门的测试守着）。

**迁移是自动的**：`LEGACY_PLUGIN_PKGS` 里登记两个旧包名 → `dsh-opencode-go`。装过任一旧插件的用户，
首次启动会摘掉旧包登记与 node_modules 拷贝、清掉旧补丁层的遗留禁用行（保留无关行）、装上新插件，
并把「原本禁用」的选择一并搬过去——改名/合并不改变用户的选择。

---

## 📊 用量插件：选中模型的每月上限 + 额度表自动更新

「模型用量与余量」（`dsh-model-usage` → 0.3.0）在原有能力之上新增：

### 1. 显示选中模型的每月额度上限

会话标题右侧在账户级「滚动 / 周 / 月」百分比之后加一个 `上限 $60` 标签，悬停给出该模型的
**5 小时 / 周 / 每月**三段额度（按官方「5 小时 = 月额度 20%、每周 = 50%、每月 = 100%」换算）。

### 2. 语义分离，不误导

必须说清楚的一点：**OpenCode Go 的用量接口是账户级的**（实测 `/usage` 会忽略一切按模型的参数），
而**额度是按模型的**（官方文档「使用限制」表）。因此：

- 百分比 = **账户整体**消耗（实时，来自上游接口）
- `上限 $X` = **当前选中模型**的每月额度（来自文档表）

悬停里明确标注这两个口径，避免把「账户用了 100%」误读成「这个模型用了 100%」。

### 3. 额度表自动更新（没有接口，只能解析文档）

OpenCode Go **没有**提供每模型额度的 API（实测：`/models` 只有 `id/object/created/owned_by`；
`/usage` 无论怎么传参都只返回账户级数据；`/limits`、`/plan`、`/usage/per-model` 等一律 404）。
所以插件这样处理：

- **内建一份额度表**（28 个模型，来自官方文档快照）作为兜底；
- **启动时自动抓取官方文档页**（`https://opencode.ai/docs/zh-cn/go/`，服务端渲染的静态 HTML，
  **公开页面、不需要 API 密钥**），解析「使用限制」表与「模型 ID」表并 join 成 `模型 id → 每月额度`；
- 结果**缓存**到 `$DSH_HOME/logs/model-usage-limits.json`，24 小时内不重复抓取；
- 抓取或解析失败时**回退到上次缓存、再回退到内建表**，只打一条 warn 日志，不会报错也不会让控件空白。

解析器对文档的实际写法做了针对性处理：额度单元格里的促销划线价（`~~$15~~ $60 4x · 9 月 20 日结束`）
取**最后一个金额**作为当前生效值；行名带 `(Off-Peak)` / `(≤ 256K tokens)` 等后缀时剥离后再与模型 ID 表对齐；
两表对同一模型的写法差异（`MiMo V2.5` ↔ `MiMo-V2.5`）通过归一化 key 消化。

### 4. 限流提示

账户达到每月上限时上游会返回 `status: "rate-limited"`；此时上限标签标红，悬停补充
「已达每月上限 · 重置于 &lt;日期&gt;」——而不是像以前那样只显示一个 100% 数字。

---

## 🎛 设置窗口：第三方插件区更清爽

- **布局优化**：插件标题加粗成行，描述最多显示两行、超出自动省略（`-webkit-line-clamp`），行距收紧，
  设置窗口不再被大段说明撑长。
- **描述精简**：五个插件的中英文描述统一改为一句话。例如「OpenCode Go 增强」的中文描述由 151 字精简到 49 字。
- 同步更新了 CATALOG 里的机制注释，说明合并后的插件做哪三件事、以及为什么 patch 与 insert 必须分开。

---

## 🧪 测试

- `dsh-model-usage` 单测 16 → **27** 项：新增额度表完整性、文档两表解析（含促销划线价）、
  表 join、三段额度换算、缓存读写与损坏降级、文档抓取的四类失败分类、以及客户端
  `findLimit` / 来源标签 / 悬停文案组装。
- `dsh-opencode-go` 单测 **13** 项：会话头（uuid/会话 ID/控制字符/脱敏）、`patchFetch` 仅在作用域内注入且不覆盖调用方头、
  以及 V4.1 模型追加的幂等与作用域判断。
- 端到端（隔离 profile + 真实引擎）验证：合并插件的自动补模型、幂等性、作用域（无 `opencode-go` 路由时不动作）、
  旧插件迁移（两个旧包 → 新包，bundles/dependencies/补丁行都清理且保留无关行）、启用/禁用只写自己那一行、
  以及用量插件路由下发 28 个模型的额度表并成功抓取官方文档（`limitsMeta.source: "docs"`）与写入缓存。

---

## 📌 升级说明

- 直接覆盖安装，数据目录与会话记录不受影响。
- 装过 `dsh-opencode-go-session` 或 `dsh-opencode-go-api` 的用户：首次启动自动合并为 `dsh-opencode-go`，无需手动操作。
- 用量插件首次启动会联网抓一次官方文档页以更新额度表（失败不影响使用，会回退内建表）。
