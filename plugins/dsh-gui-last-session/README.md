# dsh-gui-last-session

重启 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）之后，**自动回到你上一次
待着的那个会话** —— 不用再一层层翻历史。

## 它做什么

- 页面半边记录你正在看的会话，重启后自动把它重新打开。
- 引擎启动时那个**空白会话永远不会被记录**（两道防线），所以不会续接一个空对话。
- 续接会等目标在会话列表里出现（每 150ms 轮询、约 30 秒），这样对未知 id 的 `open()` 不会失败。
- 记住的会话已被删除时**安静放弃**，把引擎自己的启动行为留在原地。
- 记录时不会写入子代理（subagent）会话。

## 安装

- **用 DSH Ready GUI（推荐）**：插件随 GUI 内置，安装后在设置窗口 →「第三方插件」里勾选/取消即可。
  它是带页面半边的插件，装完按提示刷新页面。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 任选一条：

  ```sh
  # 推荐：直接从 GitHub 装
  dsh plugin --profile web add github:itchenshi/dsh-gui-last-session

  # 备选：从本仓库 Release 的 tarball 装
  dsh plugin --profile web add https://github.com/itchenshi/dsh-gui-last-session/releases/download/v0.1.9/dsh-gui-last-session-0.1.9.tgz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> 本包还不在 npm 上（`registry.npmjs.org` 查无此包），只能用上面两种方式装。

## 使用

装好、重启引擎、刷新页面后什么都不用做：页面加载时会尝试回到存下的那个会话，之后你每次切换会话都会
更新指针。

从 DSH Ready GUI 迁移过来时，GUI 会把自己记的指针交给插件（插件已有指针时不覆盖），
所以原来的「上一个会话」不会丢。

## 配置

`cordis.patch.yml` 里 `id: gui-last-session` 这一行的 `config`，全部可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时插件直接返回，不注册任何路由 |
| `quiet` | `false` | `true` 时激活不记日志 |

想在不改包的前提下覆盖某个 profile 的配置，就在**该 profile 自己的** `cordis.patch.yml` 里加一条 id
相同的行（它会整体替换 `config`，所以每个键都要写全）。

## 兼容性

- 清单声明 **DSH >= 0.1.5-rc.2**，并把 0.1.5-rc.2 与 0.2.0-rc.2 标为 compatible。
- Node >= 20。
- 插件本身**不做版本号门禁**，依赖的是公开服务契约（`ctx.sessions`）；契约变了引擎会大声报错，而不是
  悄悄关掉功能。
- 本仓库的测试不启动引擎；与真实引擎的端到端行为没有在这里自动化。

## 常见问题

**重启后没回到原会话？** 看应用日志：记录成功会打 `[gui-last-session] pointer -> session-...`，启动时
会打 `[gui-last-session] active (pointer: <DSH_HOME>/last-session.json)`。恢复路径的诊断也写进同一份
日志（`[gui-last-session] reopen: no usable pointer`、`reopen: FAILED — ...`、`reopen: giving up ...`），
所以「没有指针 / 目标一直没出现 / 这个引擎没有打开会话的接口」是可以区分开的。

**它存了什么、存在哪？** 只有一个 session id 和时间戳，写在 `<DSH_HOME>/last-session.json`，**原子写入**
（唯一临时名 + rename），崩溃不会留下半个文件。除此之外不留状态。

**为什么记下的不是我刚看的那个会话？** 空白（未使用）会话永不记录；插件取的是引擎主视图正在显示的
那个（`retainedBy.mainView`），否则是最近提问过的那个。子代理会话会被跳过。

**别人能读到这个指针吗？** 宿主只开 `GET/POST/PUT /gui-last-session` 与一条只写日志的
`POST /gui-last-session/report`，两者都走引擎自己的信任围栏（Host 白名单 + 浏览器会话 cookie），拿不到
围栏时**失败即关闭** —— 不带 cookie 的裸 `curl` 得到 401。插件没有任何对外网络请求。

## 开发

```sh
node --check lib/index.js
npm test        # manifest-contract.cjs + test.mjs + handoff.cjs
```

`node tests/test.mjs` 就是本地行为测试（不联网、不需要引擎），它按引擎的 `__ModuleLoader__` 契约加载
页面 bundle；`tests/served-bundle-check.cjs` 需要跑着的 profile，不在 `npm test` 里。

## 许可

MIT
