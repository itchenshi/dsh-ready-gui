# dsh-gui-last-session

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

重启 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之后，
自动回到你上一次所在的会话。

本插件取代了 DSH GUI 早先为同一功能使用的 **引擎文件补丁**。

## 为什么做成插件

早先的实现并没有扩展 DSH —— 它*直接改写了 DSH 自己的文件*：重写了
`node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`，
靠匹配引擎源码文本来定位插入点，并用一个精确的引擎版本字符串做门禁。

于是这个功能在**几乎每次引擎更新**时都会失效：

| 失效方式 | 原因 |
|---|---|
| 版本门禁 | 只要引擎版本不是*正好*它编写时所针对的那一个，补丁就拒绝应用。 |
| 锚点漂移 | 插入点是靠匹配字面源码行找到的；任何重新构建、改名或重新格式化都会让它失效。 |
| 静默降级 | 失败时它返回 `{ ok: false }` 并只记一行日志 —— 功能就这么没了，没有任何可见的错误。 |
| 重装即丢失 | 重装引擎会把补丁整个抹掉。 |

插件住在自己的包里，通过引擎公开的服务契约（`ctx.sessions`）与引擎对话，
因此引擎更新不再会删掉这个功能。契约真的变了的时候，引擎会**大声报错**，
而不是悄悄把这个功能关掉。

## 安装

> **npm 上暂时没有这个包 —— 现在只能从源码安装。**
>
> 原计划是把四个随附插件发布到 npm，那样在任何 DSH 宿主里 `dsh plugin add dsh-gui-last-session` 就能装。
> 但 npm 账号注册目前走不通：`www.npmjs.com` 的注册/登录页返回 Cloudflare 托管挑战
> （`registry.npmjs.org` 本身是通的，卡在注册这一环），账号建不出来，包自然发不出去。
> 所以：
>
> - **用 DSH Ready GUI**：这四个插件随 GUI 内置，打开「设置窗口 → 第三方插件」勾选即可，
>   不需要命令行（在 GUI 里手动装自己的 checkout 会被启动维护换回随包那一份，这是有意设计）；
> - **其它 DSH 宿主**（`dsh web`、CLI 等）：按下文从源码装。
>
> 等注册能走通了，会按原计划发布到 npm，那时 `dsh plugin --profile web add dsh-gui-last-session` 即可。

**方式一：DSH Ready GUI（推荐）** —— 这四个插件随 GUI 内置。打开 GUI → 设置窗口 → 第三方插件
→ 勾选 **会话续接（dsh-gui-last-session）**。安装、卸载、启用/禁用都在同一个窗口里，装完按提示重启引擎。

**方式二：其它 DSH 宿主** —— 先把本仓库 clone 到本地，再按**目录**安装：

```sh
git clone https://github.com/itchenshi/dsh-gui-last-session.git
dsh plugin --profile web add file:<clone 出来的绝对路径>
```

装的是磁盘上的真实目录，所以之后 `git pull` 更新的就是同一份代码；反过来，**换机或移动目录会
让这条依赖失效**（那时重新 add 一次即可）。

之后需要重启 `dsh web`（或重新打开 DSH GUI）。[插件市场](https://github.com/dsh-market/dsh-market)
里的一键安装依赖 npm 上的包，而这个包还没发布，所以**现在市场里装不到它** —— 请用上面的两种
方式之一；等发布到 npm 之后会照常可装。

引擎的 `plugin` 命令是一个很薄的 pnpm 转发器：包是按**真实包名**安装的，
而且因为清单里声明了 `dsh.bundle.patch`，它会自动加入该 profile 的 bundle 层栈。
bundle 层是在启动时读取的，所以装完**要重启引擎**。

## 权限、依赖与失败边界

会锁定到具体 commit 的市场（DSH STORE 之类）会静态审查运行时源码，并报告它们检测到的权限。
事实如下：

- **运行时依赖：**无 —— 只用 Node 内置模块（`node:fs/promises`、`node:crypto`、`node:path`、
  `node:os`）。
- **文件：有，且恰好一个。** 宿主那一半在 `<DSH_HOME>/last-session.json` 维护一份很小的指针文档，
  采用原子写入（唯一临时名 + rename），所以崩溃不会留下写了一半的文件。它只记录一个 session id，
  别的什么都不记；不读写任何其它文件，也不碰用户的文件。
- **本地路由：有，一条。** 宿主注册唯一一条面向页面的路由，让页面那一半能读取和更新这个指针；
  它走引擎的信任围栏（Host 白名单加上浏览器会话 cookie），围栏不可用时**失败即关闭**。
- **对外网络：没有。** 唯一的 `fetch` 调用是发往上面那条本地路由的同源请求。
- **凭据 / 命令 / 原生产物 / 生命周期脚本：**都没有。
- **失败边界：** 指针缺失、读不出来或损坏，都按「没有可续接的东西」处理 —— 插件记一条日志，
  启动就照常落在普通界面上。它绝不会阻断引擎启动；卸载插件即恢复原生行为，除了那一个文件之外
  不留任何残留状态。

## 两部分构成

| 部分 | 文件 | 运行在 | 职责 |
|---|---|---|---|
| 宿主 | `lib/index.js` | Node | 把指针持久化到 `$DSH_HOME/last-session.json`；提供一条很小的 JSON 路由。 |
| 客户端 | `client/client.js` | 浏览器 | 记录当前会话；加载时重新打开已存下的那一个。 |

客户端那一半是**手写的、无依赖的 bundle** —— 没有构建步骤，也没有打包器。

### Bundle 格式（重要）

引擎的客户端模块系统**不**接受普通 ESM。客户端 bundle 必须注册一个惰性的 CJS 工厂：

```js
window.__ModuleLoader__.load({
  id: 'dsh-gui-last-session',            // 必须等于包名
  factory: (require) => ({ name, inject, apply, ... }),
})
```

执行这个 bundle 只是*注册*工厂；所有副作用都必须放在工厂闭包里，在物化（第一次 import）时才运行。
因为本插件除了 `ctx.sessions` 什么都不需要，所以一个手写文件就能满足契约，不必 `require()`
任何其它模块。

**两套 inject 机制 —— 别搞混：**

| 位置 | 值是什么 | 作用 |
|---|---|---|
| `package.json` 里的 `dsh.client.inject` | 包名（例如 `@deepseek-ai/dsh-api-session-controller`） | 决定浏览器模块图的**加载顺序** |
| bundle 工厂导出的 `inject` | **服务名**（例如 `['sessions']`） | 决定 cordis fiber 对 `apply(ctx)` 的 inject |

两者都必需。漏掉导出的 `inject`，页面一加载 `apply()` 里的 `ctx.sessions` 就会抛
`cannot get property "sessions" without inject` —— 这正是本插件最初踩到的失败。引擎自己的
`dsh-client-ui-session` bundle 写的是 `exports.inject = ["sessions", "slots"]`，同一个套路。

`tests/test.mjs` 正是按这个契约加载 bundle 的，所以无论是退回普通 ESM 的回归，还是漏了导出的
`inject`，都会让测试套件失败，而不是留到浏览器运行时才炸。

## HTTP 接口

宿主那一半在引擎自己的 web 服务器上只注册一条路由：

```
GET  /gui-last-session   -> { sessionId: string | null, updatedAt?: number }
POST /gui-last-session   -> { ok: true, sessionId, updatedAt }
     body: { "sessionId": "session-..." }
```

两个方向都会用 `/^session-[A-Za-z0-9_-]{4,200}$/` 校验 id。`POST` 带了别的内容会被 `400` 拒绝，
文件保持原样。指针是原子写入的（临时文件 + rename），所以写到一半崩溃也不会留下半个文件。

## 配置

插件那一行配置在 `cordis.patch.yml` 里；两个键都是可选的：

```yaml
- insert:
    - id: gui-last-session
      name: dsh-gui-last-session
      config:
        enabled: true   # 总开关
        quiet: false    # true = 激活时不记任何日志
```

想在不改包的前提下覆盖某个 profile 里的配置，就在该 profile 自己的 `cordis.patch.yml` 里加一条
id 相同的行（它会整体替换 `config`，所以每个键都要重新写全）。

## 正确性说明

有两处行为很关键，且都有测试覆盖：

1. **引擎启动时的空白会话永远不会被记录。** 页面加载时，引擎自己会导航到一个工作区，并可能
   创建/选中一个*空*会话。如果把它记下来，存下的指针就会变成「引擎刚建的那个空会话」，下次
   启动就续接不到任何有用的东西。这是旧补丁真实出现过的失败。两道彼此独立的防线避免它：
   - 记录在续接尝试落定（或 4s 兜底定时器触发）之前一直保持**未启用**，这样引擎的启动导航
     发生时，插件还没开始监听变化。
   - 即便已经启用，被标记 `blank: true` 的行也永远不会被记录。

2. **续接会等目标变成可寻址的。** 会话列表是页面挂载之后才从网络上到的。契约规定对未知 id
   调用 `open()` 会失败报错，所以插件轮询列表快照（150ms 一次，上限约 30s），直到那一行出现，
   再选中它。

快照抛异常（服务正在拆除、还没就绪）不会中断等待 —— 轮询照常继续。

## 兼容性

本插件依赖的是**公开的服务契约**，而不是引擎版本号，所以它有意**不**做版本门禁。

已在 **dsh 0.1.5-rc.1** 上验证可用（该契约在 0.1.2-rc.1 上同样一致）：

| 依赖 | 用到的契约 |
|---|---|
| `ctx.sessions`（客户端） | `list` (ObservableSnapshot), `open(id)`, `binding(id)` |
| `SessionListState` | `current`, `byId`, `byId[id].blank` |
| `ctx.webServer`（宿主） | `register({ kind, path, handler })` |
| 注入包 | `@deepseek-ai/dsh-api-session-controller` |

0.1.5-rc.1 上的端到端检查：装上插件后引擎能启动，`GET /gui-last-session` 返回已存下的指针，
并且 `dsh-gui-last-session/client.js` 被包含在启动载荷的插件 bundle 里一起下发（HTTP 200）。

如果将来的引擎打破了其中某个契约，激活会**大声失败**（引擎会报插件加载失败），而不是悄悄
把这个功能关掉 —— 那时相应更新 `dsh.client.inject` 和宿主路由即可。

> 说明：本插件有意**没有**在 DSH GUI 目录里写 `engineRange`。版本范围在这里并不合适：除非
> 范围在精确的 `[major,minor,patch]` 上点名某个预发布版，npm semver 会把预发布版排除在范围
> 之外，所以像 `>=0.1.2-0 <0.2.0` 这样的范围会错误地卡住 `0.1.5-rc.1`。何况这个插件风险
> 很低：最坏情况是「会话没被续接」，绝不会导致引擎启动失败。

## 从 DSH GUI 的指针迁移

DSH GUI 自己的指针放在 `<userData>/last-session.json`。本插件有意使用**另一个**文件，以便保持
自包含，并对任何安装它的人都有效，而不只是 DSH GUI 用户。DSH GUI 会在启动时自动完成这次交接
（单向：它绝不会覆盖插件已经记录下的指针）。要手动做，把 `sessionId` 拷过去即可 —— 注意这条
路由在引擎的信任围栏之后，所以裸 `curl` 现在会得到 **401**（要带上引擎的会话 cookie：先用
`dsh web` 打印出的引擎 URL 打开一次，然后复用它的 cookie）：

```sh
curl -X POST http://127.0.0.1:<port>/gui-last-session \
     -H 'content-type: application/json' \
     -H 'cookie: <engine session cookie>' \
     -d '{"sessionId":"session-..."}'
```

## 开发

```sh
node --check lib/index.js
npm test        # 本地行为测试（不联网、不需要引擎）
```

`npm test` 还会断言客户端 bundle 按引擎的 `__ModuleLoader__` 契约、以正确的包 id 完成注册。

这个包是零依赖的普通 JavaScript。

## 说明 / 限制

- 插件依赖 `ctx.sessions`（客户端）和 `ctx.webServer`（宿主）。如果将来的 DSH 版本改了其中任一
  服务的名字，激活会报出失败，而不是悄悄关掉这个功能 —— 那时相应更新 `package.json` 的
  `dsh.client.inject`。
- 续接是尽力而为的：如果记住的会话已被删除，插件会安静放弃，把引擎自己的启动行为留在原地。

## License

MIT
