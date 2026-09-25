# dsh-gui-last-session

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

> 这是 **DSH Ready GUI** 的组成部分之一 —— GUI 开箱内置四个插件，勾选即用。
> 也可单独装到任何 DSH 宿主里（见下方「装上就能用」）。
> GUI：https://github.com/itchenshi/dsh-ready-gui

重启 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之后，**自动回到你
上一次待着的那个会话** —— 不用再一层层翻历史。

## 装上就能用

- **用 DSH Ready GUI（推荐）**：插件**随 GUI 内置**，而且是默认开启的 —— 装好 GUI 就已经在用了。
  要关掉就在设置窗口 → 第三方插件里取消勾选。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 两条路都行，任选一条：

  ```sh
  # 推荐：直接从 GitHub 装（记进 profile，之后可跟着更新）
  dsh plugin --profile web add github:itchenshi/dsh-gui-last-session

  # 备选：从本仓库 Release 的 tarball 装（网络受限连不上 github.com 时用这条）
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gui-last-session/releases/download/v0.1.2/dsh-gui-last-session-0.1.2.tgz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> npm 上暂时没有这个包：注册账号那一环走不通（`www.npmjs.com` 返回 Cloudflare 托管挑战），包发不
> 出去。所以现在只能按上面两种方式装。等注册通了会照常发布。

## 它替你解决什么

原来的实现**直接改引擎文件**：重写 `node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`，
靠匹配引擎源码文本找插入点，并用一个精确的引擎版本号做门禁。于是：

| 失效方式 | 原因 |
|---|---|
| 版本门禁 | 引擎版本不是它编写时针对的那一个，补丁就拒绝应用 |
| 锚点漂移 | 插入点靠匹配字面源码行找到，重新构建 / 改名 / 重新格式化都会让它失效 |
| 静默降级 | 失败时只记一行日志，功能就这么没了，界面上没有任何错误 |
| 重装即丢失 | 重装引擎会把补丁整个抹掉 |

现在它是一个**插件**：住在自己的包里，通过引擎公开的服务契约（`ctx.sessions`）对话，所以引擎更新
不再会删掉这个功能；契约真的变了，引擎会**大声报错**，而不是悄悄关掉它。

## 行为细节

有两处很关键，都有测试覆盖：

1. **引擎启动时的空白会话永远不会被记录。** 页面加载时引擎自己会导航到一个工作区，并可能创建/选中
   一个**空**会话；要是记下它，下次启动就会去续接一个空对话。两道防线：
   - 记录在「续接尝试落定（或 4 秒兜底定时器触发）」之前一直**未启用**，所以引擎启动导航发生时
     插件还没开始监听；
   - 即便已启用，标记 `blank: true` 的行也永远不记。

2. **续接会等目标变成可寻址的。** 会话列表是页面挂载之后才从网络到的；对未知 id 调 `open()` 会失败，
   所以插件每 150ms 轮询一次列表快照（上限约 30 秒），等那一行出现再选中它。

**尽力而为**：如果记住的会话已被删除，插件安静放弃，把引擎自己的启动行为留在原地。

## 配置（`cordis.patch.yml` 的行 config，全部可选）

```yaml
- insert:
    - id: gui-last-session
      name: dsh-gui-last-session
      config:
        enabled: true   # 总开关
        quiet: false    # true = 激活时不记任何日志
```

想在不改包的前提下覆盖某个 profile 的配置，就在**该 profile 自己的** `cordis.patch.yml` 里加一条 id
相同的行（它会整体替换 `config`，所以每个键都要写全）。

## 权限与边界（给会静态扫描的商城看的）

- **运行依赖：无。** 只用 Node 内建模块（`node:fs/promises`、`node:crypto`、`node:path`、`node:os`）。
- **文件：恰好一个。** 宿主半边在 `<DSH_HOME>/last-session.json` 维护一份很小的指针文档，**原子写入**
  （唯一临时名 + rename），所以崩溃不会留下半个文件。它只记一个 session id，别的什么都不记。
- **本机路由：一条。** 宿主注册唯一一条面向页面的路由，页面半边用它读写指针；它走引擎的信任围栏
  （Host 白名单 + 浏览器会话 cookie），围栏拿不到时**失败即关闭**。
- **对外网络：没有。** 唯一的 `fetch` 是发往上面那条本地路由的同源请求。
- **凭据 / 命令 / 原生制品 / 生命周期脚本：无。**
- **失败边界：** 指针缺失、读不出来或损坏，都按「没有可续接的东西」处理 —— 记一条日志，启动照常落在
  普通界面上。绝不阻断引擎启动；卸载即恢复原生行为，除了那一个文件之外不留残留状态。

## HTTP 接口

```
GET  /gui-last-session   -> { sessionId: string | null, updatedAt?: number }
POST /gui-last-session   -> { ok: true, sessionId, updatedAt }
     body: { "sessionId": "session-..." }
```

两个方向都用 `/^session-[A-Za-z0-9_-]{4,200}$/` 校验 id；`POST` 带了别的内容会被 `400` 拒绝，文件保持
原样。这条路由受信任围栏保护，所以裸 `curl` 会得到 **401** —— 要手工调用，先用 `dsh web` 打印的 URL
打开一次拿到会话 cookie，再带上：

```sh
curl -X POST http://127.0.0.1:<port>/gui-last-session \
     -H 'content-type: application/json' \
     -H 'cookie: <引擎会话 cookie>' \
     -d '{"sessionId":"session-..."}'
```

## 两部分构成

| 部分 | 文件 | 运行在 | 职责 |
|---|---|---|---|
| 宿主 | `lib/index.js` | Node | 把指针原子写进 `$DSH_HOME/last-session.json`，并提供一条很小的 JSON 路由 |
| 页面 | `client/client.js` | 浏览器 | 记录当前会话；加载时重新打开已存下的那一个 |

页面半边是**手写的、无依赖的 bundle**，没有构建步骤也没有打包器。引擎的客户端模块系统**不接受普通
ESM**：bundle 必须注册一个惰性的 CJS 工厂（`window.__ModuleLoader__.load({ id, factory })`，`id` 必须
等于包名），所有副作用都放在工厂闭包里、物化时才运行。**两套 inject 别搞混**：`package.json` 的
`dsh.client.inject` 写的是**包名**（决定浏览器模块图的加载顺序），bundle 工厂导出的 `inject` 写的是
**服务名**（如 `['sessions']`）。两者都必需 —— 漏掉导出的 `inject`，页面一加载 `apply()` 里取
`ctx.sessions` 就会抛 `cannot get property "sessions" without inject`。

`tests/test.mjs` 正是按这个契约加载 bundle 的，所以「退回普通 ESM」或「漏了导出的 inject」都会让测试
失败，而不是留到浏览器里才炸。

## 开发

```sh
node --check lib/index.js
npm test        # 本地行为测试（不联网、不需要引擎）
```

**兼容性**：插件依赖的是**公开服务契约**，不是引擎版本号，所以有意**不做版本门禁**（版本区间在这里
也不合适：npm semver 会把预发布版排除在 `>=0.1.2-0 <0.2.0` 这类区间之外，反而误杀 `0.1.5-rc.1`）。
已在 dsh 0.1.5-rc.1 上端到端验证：装上后引擎能启动、`GET /gui-last-session` 返回已存下的指针、
`dsh-gui-last-session/client.js` 随启动载荷下发（HTTP 200）。

本包是零依赖的普通 JavaScript。

## 许可

MIT
