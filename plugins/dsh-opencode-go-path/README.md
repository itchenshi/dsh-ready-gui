# dsh-opencode-go-path

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

OpenCode / OpenCode Go 路由的一站式插件：**声明协议 + 把 DeepSeek V4.1
模型放到最前 + 附加会话头**。装上即用，不需要手改配置。

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

### 2. 把 DeepSeek V4.1 模型放到模型列表最前

引擎启动后，运行时（`lib/index.js`）等 `llm-pi-ai` 设置命名空间就绪，然后：

- **用户在 `settings.yaml` 里已配置** `opencode-go` 的 `models` 列表 → 把 DeepSeek V4.1
  模型放到**列表最前**（走与 GUI 模型页相同的 `settings.update` 写入路径，落在
  `settings.yaml`，严格校验因为有 api 而通过）；用户自己配的其它模型保持原有相对顺序；
- **已经在最前** → 不写（幂等）。**排在后面**（早期版本是追加到末尾的）→ 移到最前：列表顺序
  就是模型选择器的顺序、第一项是默认选中项，所以「装上即用」意味着 V4.1 Flash 默认就被选中；
- **用户自己那条同 id 的条目原样保留**（可能改过名字或上下文长度），不会被我们的默认值覆盖；
- **用户没有配置 `models`** → 什么都不做。引擎把「非空的已配置列表」当作该 provider 的
  **完整**模型集（`entries = configured.length > 0 ? configured : defaults`），所以往一个
  空列表里写入会把整个内置目录替换成我们写的那几个模型 —— 此时引擎自带的目录才是权威；
- 「某个模型在不在列表里」按**我们自己的 id**（`V4_1_MODELS`）判断，而不是 `deepseek-v4.1`
  前缀：上游将来多出别的 v4.1 型号，不该让已收录的 Flash 被顶掉。

> 判定读的是**用户层**（`settings.section(NS)`）而不是合并后的 `resolved`：本插件自己的
> 补丁会注入 `providers.opencode-go.api`，合并层永远有这个路由，用「路由是否存在」当守卫
> 是永远不会生效的。

路由存在性检查、模型列表置顶与「是否已经是我们要的形状」分别是
`nextV41Models()` / `withV41ModelsFirst()` / `isV41()`，都有单测覆盖。

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

> **npm 上暂时没有这个包 —— 现在只能从源码安装。**
>
> 原计划是把四个随附插件发布到 npm，那样在任何 DSH 宿主里 `dsh plugin add dsh-opencode-go-path` 就能装。
> 但 npm 账号注册目前走不通：`www.npmjs.com` 的注册/登录页返回 Cloudflare 托管挑战
> （`registry.npmjs.org` 本身是通的，卡在注册这一环），账号建不出来，包自然发不出去。
> 所以：
>
> - **用 DSH Ready GUI**：这四个插件随 GUI 内置，打开「设置窗口 → 第三方插件」勾选即可，
>   不需要命令行（在 GUI 里手动装自己的 checkout 会被启动维护换回随包那一份，这是有意设计）；
> - **其它 DSH 宿主**（`dsh web`、CLI 等）：按下文从源码装。
>
> 等注册能走通了，会按原计划发布到 npm，那时 `dsh plugin --profile web add dsh-opencode-go-path` 即可。

**方式一：DSH Ready GUI（推荐）** —— 这四个插件随 GUI 内置。打开 GUI → 设置窗口 → 第三方插件
→ 勾选 **OpenCode Go 路由（dsh-opencode-go-path）**。安装、卸载、启用/禁用都在同一个窗口里，装完按提示重启引擎。

**方式二：其它 DSH 宿主** —— 先把本仓库 clone 到本地，再按**目录**安装：

```sh
git clone https://github.com/itchenshi/dsh-opencode-go-path.git
dsh plugin --profile web add file:<clone 出来的绝对路径>
```

装的是磁盘上的真实目录，所以之后 `git pull` 更新的就是同一份代码；反过来，**换机或移动目录会
让这条依赖失效**（那时重新 add 一次即可）。

装完**重启 `dsh web`**（或重开 DSH GUI）。

验证：

- 会话模型选择器里 **第一项**是 `DeepSeek V4.1 Flash`；
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

## 与上游 pi-ai 0.86 / 0.87 的关系

上游 `@earendil-works/pi-ai` 在 0.86.0（09-19）、0.86.1（09-20）、0.87.0（09-21）里，把本插件
正在做的两件事都做进了自己：0.87.0 的 `dist/providers/data/opencode-go.json` 收录了
`deepseek-v4.1-flash`（归在 `openai-completions`），并且 `dist/providers/opencode-go.js` 用
`withOpenCodeSessionHeader` 包了三个 API 入口 —— 目录路由因此能按会话发出 `x-opencode-session`。

**但它到不了本插件覆盖的场景**，原因有两层，都是实测过的：

1. **版本范围**：`@deepseek-ai/dsh-llm-pi-ai@0.1.6-alpha.2` 声明
   `@earendil-works/pi-ai: ^0.85.1`，而 0.x 语义下 `^0.85.1` = `>=0.85.1 <0.86.0` ——
   `semver.satisfies("0.87.0", "^0.85.1") === false`（0.86.0 同样 false）。已发布的
   `@deepseek-ai/dsh` 仍是 **0.1.5-rc.2**（`latest` 那条线声明的还是 `^0.82.1`），实装的
   pi-ai 就是 0.85.1：它的 dist 里 `x-opencode-session`、`withOpenCodeSessionHeader`、
   `deepseek-v4.1-flash` **各 0 处**。所以**任何已发布版本都拿不到那个修复**。
2. **路由形态**：本插件给 `llm-pi-ai` 行补了 `providers.opencode-go.api: openai-completions`，
   即「声明了 `api:` 的路由」。按引擎自己的注释（`dsh-llm-pi-ai`：*catalog route pointed at a
   different protocol — is built by `createProvider`*），这类路由由 `dsh-llm-pi-ai` 的
   `PROTOCOLS` 表 + **未包装**的工厂构建 —— 即使将来 pi-ai 0.87 被放行，上游那层包装
   **也覆盖不到它**。

所以本插件的两半现在都还有意义，而且分工明确：

| 本插件的一半 | 为什么现在仍然需要 | 什么时候可以退休 |
|---|---|---|
| `x-opencode-session` 头（`globalThis.fetch` 补丁 + `llm/stream` 瀑布） | 与 pi-ai 版本无关，是当前**唯一真正发出该头**的实现；默认每会话随机 UUID（**不是静态头**，不承担静态头的缓存代价），并带 `hasSessionHeader` 守卫，将来上游也发头时不会重复加 | 只有当某天不再给路由补 `api:`、且范围已放开，目录路由才会接管 |
| 自动补 / 置顶 `deepseek-v4.1-flash` | 引擎把**非空的用户 `models` 列表**当作该 provider 的完整集合（`entries = configured.length > 0 ? configured : defaults`）——目录新增不会出现在已配置列表的用户的选择器里；目录不认识的模型也仍然需要路由级 `api` | 目录覆盖了用户实际在用的模型、且用户没有显式 `models` 列表时 |

**范围放开之后该怎么选**（需要引擎侧实测，别照抄）：要么继续保留这条 `api:` 补丁（最稳，本插件的
头半边照旧工作），要么只在「目录不认识的模型」场景保留它、其余交给目录路由 —— 后者要重新设计
补丁，因为这条声明现在**故意**放在 `insert` 之外，好让设置窗口的启用/禁用只写 insert 行 id、
不会把协议声明一起关掉。

相关上游讨论：[earendil-works/pi#9737](https://github.com/earendil-works/pi/issues/9737)
（`opencode-go` 目录缺 `deepseek-v4.1-flash`）。

## License

MIT