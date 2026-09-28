# DSH Ready GUI v0.7.0 更新说明

**发布日：2026-09-26** · 从 v0.6.1 累积的所有改动。

> 一句话：**把「装上壳就能用」从一句宣传语变成真的** —— 四个内置插件此前默认一个都不装（勾选框
> 全关，而设置窗口在托盘菜单里），现在首次启动壳自己检测、自己打开设置窗口问一句；点一次装齐并
> 自动重启一次引擎，不装也留得下（「不用了我自己选」，一个插件都不会动）。

## 🚀 新：首次启动检测 + 一键开启内置插件

**问题**：四个内置插件随包发布，但插件目录的勾选框**默认全部关闭**（`plugin-manager.js`：
「未勾选一律不装」），而设置窗口在托盘菜单里 —— 第一次用的人没有理由去找它。于是「下载解压打开」
之后，模型余量、网关路由、会话续接、按键设置**一个都没生效**，而它们正是这个壳能提供的全部增量。

**现在**：引擎就绪后检测「还有该装没装的内置插件」→ 主动打开设置窗口 → 插件区最上方一张卡片：

- **只列实际缺的那些**（名字来自插件目录，按钮写实际数量，不写死「4 个」）；
- **一键开启** = 走与勾选框**完全相同**的安装路径（`syncEnabledPlugins`、`mode=install`：只增不删，
  不动你手动装的别的东西）+ **自动重启一次引擎** —— bundle 列表只在引擎启动时组装，装完不重启
  等于什么都没生效；
- 本次新装的插件并入启动期的崩溃兜底集合：万一把引擎搞崩，走既有的「诊断 → 剔除可疑插件 → 重拉」，
  而不是把你丢在一个起不来的壳里；
- **不装也行**：「不用了我自己选」只记「问过了」，**一个插件都不动**，下面照样能逐个勾选。

**只问一次，且问得诚实**：用户做过决定后不再主动弹（`settings.json` 的 `firstRunOfferDone`）；
渲染层不自己判断该不该显示 —— 卡片完全跟随主进程 payload（`offer` / `missing`），避免两侧各有一套
规则而悄悄漂移（装完 `missing` 为空，卡片自动消失）。

## 🔍 代码审计（缺陷 / 逻辑 / 性能 / 内存）

对 GUI 与工具链做了一轮逐文件审计（每个结论都先验证再动手，能复现的写成了用例）。修掉的：

- **引擎兜底补丁会删掉引擎自己的代码**（`engine-patch.js` 的 `stripInjectedBlocks`）：它用
  「注入块之后的第一行 `const slots = ctx.slots;`」当结束边界，于是**注入块与那一行之间的任何
  引擎代码都会被一起删掉**，而且删完仍是合法 JS —— 语法检查发现不了。今天这份引擎恰好是安全的
  （两行紧邻），所以这是**潜伏**的破坏性缺陷，下一次引擎升级就可能踩到。改为按**块自身的花括号
  配平**定位结束行；配平解不出就放弃（绝不猜）。已加回归用例：块与 `slots` 之间插入引擎代码后，
  那几行必须原样保留（旧实现会删掉它们）。
- **`settings.yaml` 静默丢配置**（`settings-ui.js`）：顶层不是映射（标量 / 序列）时会回退到一份
  全新文档，但 `degraded` 只在「解析报错」时置位 —— 于是**既不报错也不记日志**，用户其余配置被
  整份换成「只有主题」。三种回退情形现在都算降级写入。
- **`runNpm` 超时后永不 settle**（`plugin-manager.js`）：超时只 `kill("SIGKILL")`，而 Windows 上
  杀不掉进程树，npm 的孙进程继续持有 stderr 管道 → `close` 不触发 → Promise 永远挂着（调用方
  `ensurePnpm` 跟着挂死、子进程与管道常驻）。与 `runDshPlugin` 一致地自己 reject。
- **`ensurePnpm` 会删掉正在被别的调用使用的目录**：它先 `rm -rf` 再装，而 `pnpm-tools` 是所有
  调用点共用的同一路径，且**启动维护那条路径不受 `pluginOpInFlight` 互斥保护** —— 并发时会把
  对方正在用的目录删掉。改为装到**进程唯一**的临时目录再原子换入（换入失败还会把旧目录挪回来）。
  同时早退分支现在要求 `.bin` 里真的有 `pnpm`/`pnpm.cmd`：只看 `package.json` 会在上次安装被
  中断时返回一个不含 pnpm 的 PATH 目录。
- **`removePatchRows` 在并发重试时重复计数**：`removed` 声明在变换之外、却在变换里 push，而
  `mutatePatchFile` 遇到并发改写会重跑同一个变换 —— 实测返回 `["a","a"]`。改为在变换内累积。
- **`setPluginEnabled` 把「什么都没写」报成 `changed: true`**：client-only 包（无 row id）时
  补丁层一个字节都不会变，市场状态也可能本就是目标值，界面却提示「需重启引擎」并走一遍无意义
  的重启路径。现在如实反映是否真的落地（`mutatePatchFile` 把「文本没变」也报出来）。
- **`healProfileBundles` 会用过期快照覆盖别人的写入**：重读清单失败（`null`）时它退回写那份
  **await 之前**的旧快照，正好会覆盖掉另一个写者刚落地的 bundles/dependencies。改为重读失败就
  跳过这次摘除并记一条错误。
- **`removePlugin` 未做 spec 校验**：`isRestorableSpec` 早就拒绝以 `-` 开头 / 带 `:` 前缀的
  spec（argv 注入），但只用在恢复路径；卸载路径的 `pkg` 来自可被改写的 `dsh.profile.bundles`。
  现在两条路径守同一条规则。
- **watcher 的重试定时器无法取消**（`main.js`）：`startEngineSettingsWatcher` /
  `startProfileWatcher` / `startMarketWatcher` 的「目录还没建出来 → 稍后重试」用的是**没有句柄**
  的 `setTimeout`，于是退出或切换数据目录时在途的一次重试会重新挂上**再也没人关**的 `fs.watch`
  （句柄泄漏），而且它盯着的还是切换前那个 home。
- **`killProcessTree` 可能回调两次**：`taskkill` 的 `close` 与 `error` 在某些情况下都会触发，
  而调用方用这个回调启动下一次引擎 —— 调两次就会拉起两个引擎进程，其中一个再也不受 GUI 管理。
- **托盘菜单切换数据目录会留下未处理的 rejection**：那条 `.then()` 没有 `.catch`，失败时用户
  只看到单选框跳回去、没有任何提示。
- **设置窗口两处状态 bug**：①「修复 / 重试」按钮先自己 `disabled = true` 再交给 `setPluginBusy`
  快照，于是快照到的是 `true`，还原后按钮**永远点不动**；②「刷新页面」按钮刷新成功后被永久
  `hidden`，而只有启用成功那条路径会重新显示它 —— 刷过一次之后，提示还在让用户点一个不存在的按钮。
- **`catalogStatus` 重复读同一个 `package.json`**（热路径：每次设置 payload / 广播都跑全部条目）：
  版本号读一次、`pluginHasClientHalf` 再读一次。改为读一次复用；判定逻辑仍只有一处（读文件那层
  保留给测试）。另外把循环里的 `installedBundles` / `readUserPatchState` 提到循环外（原先按
  「目录条目数」「legacy 条目数 × rowId 数」重复 `readFileSync` + 解析）。
- **设置窗口自适应高度会与主进程互相触发**：`ResizeObserver` 观察 `document.body` → 通知主进程
  `setContentSize` → 布局变化 → 再次观察。加一个「高度没变就不发」的去重。
- **死代码 / 失效代码**：`plugin-manager.js` 的 `catalogByPkg`（零引用）、导出的 `CATALOG_IDS`
  （main.js 只解构未使用）、`engineBin` / `installPlugin`（仅文件内使用）；`engine-patch.js` 的
  `ensureLastSessionPatches`（零引用，且是 `ensureEnginePatches` 的重复实现）。
- **i18n**：`settings.html` 里 16 个 `settings.plugins.*` 文案键**定义了却从没被 `t()` 用过**，
  同时界面上散着 52 处 `uiLang === "en" ? "…" : "…"` 手写三元 —— 其中「启用/禁用/安装/卸载」
  等提示是**两套语言各写一遍**、且漏改一处就只剩英文。现在这些键真正接上（并清掉 3 个确认无人
  使用的键）；另修 `settings.currentEngine` / `settings.engineNotInstalled` **用了却没定义**
  （`t()` 找不到键会把键名当文案显示给用户）。
- **静态检查补强**：`check-settings-html.cjs` 新增「每个 `t()` 用到的键在两种语言里都有定义」——
  原检查只验「某些键被定义过」，不验「是否真的被使用」，所以上面那个「用了却没定义」的 bug 能
  一路通过。
- **`update-plugin-readmes.ps1` 写出的安装块 URL 是坏的**：调用处传 `$p.Version`，而那张哈希表
  根本没有 `Version` 键（真值在局部变量 `$version` 里），于是模板渲染成
  `releases/download/v//<name>-.tgz`。改为传 `$version`。
- **`bundle-node.mjs` 的解包临时目录是固定名**：每一步都先 `rm -rf` 再重建，两个构建并行
  （CI 矩阵 / 本地同时开两条 `dist:*`）会互相删掉对方正在用的目录，甚至复制到一棵被删了一半的
  运行时 —— 而 `version.txt` 照样写下去，下次构建的「已是最新」判断还会接受这份坏产物。改为
  带 pid + 随机段（与 `ensure-electron.mjs` 同一条规则）。

**顺带纠正一个审计误报**：`sync-bundled-plugins.mjs` 顶部 `require("<repo>/src/plugin-manager.js")`
被怀疑在干净检出里会抛 `MODULE_NOT_FOUND` —— 实测该文件存在且被 git 跟踪、require 正常
（`CATALOG` 5 项、4 个 `localSource`），不需要改。

## 🔧 工具链与测试基建（同一轮审计的第二批）

- **「装插件成功」其实没装上去**（`plugin-manager.js` 的 `installPlugin`）：它只看
  `dsh plugin add` 的退出码，而这个子命令**会打印 "Lockfile is up to date, resolution step is
  skipped" 并 exit 0、却什么都没改**（同一个文件里 remove→prune→add 那段注释早已记录了这条
  实测）。界面于是勾上、profile 里却没有 —— 用户看到的是「重启后插件又没了」。现在以**落地
  结果**为准：bundles 里有登记 **且** `node_modules` 里确有那份 `package.json`，否则如实报失败
  （调用方随后会把原来那份装回去）。`smoke-profile-watch` 的 STEP4b 正是抓这个的用例，修复前
  它以「after reinstall the profile should list the plugin as installed」失败。

- **打包产物可能被自己的失败吃掉**（`fix-unpacked.mjs`）：归档前先 `rm` 掉上一份 zip，且归档
  一失败就删掉 `.old` 目录（那是唯一副本）—— 打包失败 = 上一次的好产物也没了。现在先写进程唯一
  的临时名、**校验**它是一份完整 zip（读中央目录结束记录，不看体积猜）、再原子换入；归档失败就把
  旧目录挪回来并保留旧 zip。已用 fixture 验证：成功路径产物完整、失败路径**旧 zip 与旧目录都还在**
  且不留 `.tmp`。
- **两个 smoke 直接写用户的真实数据目录**（`smoke-close.ps1` / `smoke-modal.ps1`）：它们把
  `settings.json` 写进 `%APPDATA%\DSH Ready GUI`，跑一次就覆盖用户自己的设置（`closeAction`
  被永久改成测试值），而 `smoke-modal` 还会 `taskkill /T /F`。现在两个都复制一份**临时**
  userData（引擎 + pnpm 工具）再跑，退出时清理。
- **`verify:builtin` 失败时会漏一个常驻引擎**：引擎子进程只在成功路径 `child.kill()`，而
  Windows 上 `kill()` 杀不掉进程树；之后的任何一步抛错都会走 `.catch` 直接 `exit(2)`。现在
  统一走 `killEngineChild()`（win 用 `taskkill /T /F`、POSIX 杀进程组），并挂在 `exit` /
  `SIGINT` / `SIGTERM` 上。
- **发布脚本**：
  - `publish-all.ps1` 在**推送之后**才建 tag，且只 `push origin` —— Gitee / GitCode 的 Release
    因此在等一个它们没有的 tag。改为推送前建 tag（`push-all` 的 `--tags` 会带到三个远端）。
  - `push-all.ps1` 的 `-Skip` 只认 remote 名（`origin`），而 `publish-all` 与文档用的是平台名
    （`GitHub`）—— `-Skip GitHub` 转发过来后**静默不生效**，恰恰是它最该生效的场景。现在两种
    写法都认。
  - 两个脚本都会把 git / curl 的**原始输出**打印出来，而 git 的错误信息里带着 token 化 URL
    （`https://user:TOKEN@…`）、Gitee 接口把凭据放在 query string 里 —— 补 `Redact-Token`，
    逐行过滤后再打印（保留实时进度）。
  - `release-plugin-tarballs.ps1` 的「工作区是否干净」没看 `$LASTEXITCODE`：git 失败时
    `$dirty` 是空，「干净」与「根本没查成功」看起来一模一样。
  - `update-release-notes.ps1` 只看 `HTTP:%{http_code}`，不看 `curl.exe` 自己的退出码 ——
    curl 根本没起来时错误信息没有信息量。
  - 发布说明的临时正文文件写在 `%TEMP%` 且失败路径直接 `exit`，会一直留着 → 改成 `finally` 清理。
- **`check-ps1-encoding.cjs` 只扫 `scripts/` 一层**：放到子目录里的 `.ps1` 会绕过这条护栏。
  改为递归扫描整个仓库（跳过 `node_modules` / `dist` / `resources`）。这一改立刻抓到 7 个非 ASCII
  脚本（原先只看到 5 个）。
- **smoke 脚本的重复样板**：三个 CDP 驱动的脚本各自内联了一份几乎相同的 ~60 行「找 target →
  连 WebSocket → 关联 id → evaluate → waitFor」，`Copy-Tree` / `Stop-App` / `Wait-Log` / `Dump-Log`
  在 5 个脚本里各写一遍 —— 修一处（比如 RPC 超时）另外两处照旧漂移。新增
  `scripts/lib/cdp.cjs`（`connectToPage` / `evaluate` / `waitFor` / `runDriver`），三个驱动改为
  复用它；`Wait-Log` 的超时信息现在会带上最后一次观察到的值，而不只是「超时」。
- **两个 smoke 断言的是「开发机当时恰好有的东西」**（这才是它们长期失败的真因，与本次改动无关）：
  - `smoke-plugin-enable.ps1` 期望 boot 打印 `legacy plugin removed (renamed)`，但那条日志只在
    「第二步 prune 才是真正摘掉登记的人」时出现；先走的 `dsh plugin remove` 成功时它不会打印，
    于是断言恒假。改为断言迁移本身（`legacy plugin replaced by: … -> dsh-model-surplus`），
    并显式装好它需要的前置插件（新增 `scripts/ensure-plugin-installed.cjs`，走应用自己的安装
    路径、从本仓库 `plugins/` staging，不需要网络）—— 原先它继承自开发机的 live profile，
    那份 profile 一被清干净，测试就报一个与真实原因无关的错。
  - `smoke-profile-watch.ps1` 断言 `dsh-opencode-go-path` 存在，而那个包在 v0.6.0 已改名
    `dsh-gateway-models` —— 只有当开发机 profile 还留着旧名字时才成立。改为从仓库自己的
    `CATALOG` 推导要检查的包（下一次改名不会再弄坏它），并修掉它 `finally` 里引用**从未赋值**
    的 `$seedFile`（PS 5.1 下 null 路径会抛终止错误，把真正的结果 —— 无论成功还是失败 —— 一起
    盖掉）。
- **顺手去掉写死的用户名**：5 个 smoke 里的 `C:\Users\<name>\AppData\...` 改成
  `Join-Path $env:APPDATA`（换台机器 / 换个账号就不再是坏的）。
- **界面渲染的重复劳动**：`paint()` 每次都会重跑 `applyTexts()`（整文档 `querySelectorAll`）并
  整段重建插件列表，而一次插件操作会调用它两次 —— 语言没变就不重跑文本、列表按指纹跳过重建
  （`setPluginBusy` 用显式失效位保证 busy 锁的还原不会被跳过）。
- **设置窗口的死 CSS 与无作用类**：`.first-run .fr-msg` 从没有任何元素用过（删掉）；
  `.plg-state` / `.plg-enable-label` / `.plg-enable-state` 只有模板上的类名、没有任何 CSS 规则
  命中（样式全内联）—— 把其中静态部分收进 CSS，内联只留随状态变化的颜色 / cursor。
- **`notice.html`**：悬停时若指针**一开始就在**提示上（提示弹在鼠标底下）收不到 `mouseenter`，
  计时器会照常把用户正在看的提示关掉 → 改为显式记住悬停状态；`<button>` 缺 `type="button"`；
  静态 `<title>` 与 `title=` 是写死的中文，会在英文界面（或脚本没跑起来时）露出来。
- **模块细节**：`engine-patch.js` 写回时会用 `\n` 覆盖整份 16000+ 行文件的 CRLF → 保留原行尾风格；
  `engine-url.js` 接受 `localhost.`（FQDN 写法，浏览器视为同一台机器）；`plugin-manager.js`
  去掉一个没人用的捕获组、删掉 `healProfileBundles` 里**永不可能执行**的 try/catch（改为区分
  「读不出来」与「还不存在」并如实记 error）、`rowIdOwners` 把「row id → 占用它的包」算一次
  （原先按 rowId 循环逐次重扫文件，O(rowIds × packages)）。

## 🧪 测试

- 新增 `src/test/first-run.test.cjs`（11 项）：已决定 / 引擎未装 / 部分已装 / 全部不兼容 /
  目录缺条目 / 半残状态 / `dsh-market` 不进推荐集合。
- `src/test/engine-patch.test.cjs` 新增 4 项：块体不闭合时放弃且**一行都不删**；块后仍有引擎
  代码时必须保留（旧实现会删掉）；删除行数恰好等于块体行数。
- `src/test/update-sources.test.cjs` 新增 1 项：`DEFAULT_ORDER` / `MAINLAND_ORDER` 与
  `SOURCE_IDS` 必须互为同一集合（新增源却忘了进顺序表 → 那个源永远不会被尝试）。
- 新增端到端 `scripts/smoke-first-run.ps1`（真实引擎 + 真实 pnpm + CDP 驱动**真实设置窗口**）：
  ① 全新 profile：自动弹出 + 卡片可见（文案列出缺的四个）② 点「一键开启」：四个全部装上、卡片消失
  ③ 引擎被重启一次、`firstRunOfferDone=true` ④ 第二次启动不再弹、也不再自动开设置窗口
  ⑤ 换一条路（「不用了我自己选」）：只记录决定 —— 缺的那个不会因此被装上，已装的三个也不会被卸掉。
- 四个既有 smoke 场景预置 `firstRunOfferDone=true`：它们各自断言精确的插件集合与窗口行为，
  首次启动卡片不该插进它们的场景（`smoke-close` 还会因为多一个模态窗口而找不到主窗口句柄）。
- `settings.html` 结构检查新增 2 条：卡片默认隐藏 / 显示完全跟随 payload / 结果写进
  `#pluginMsg`（卡片在装成功后必然消失，写在卡片里等于消息丢失）；以及上面那条 `t()` 键完整性。

## ⬆️ 升级说明

- **无配置迁移、无需手动操作**：数据目录、模型配置、会话历史原样保留；插件版本未变，不会触发重装。
- **老用户**：如果你此前还没装那几个内置插件，升级后第一次启动会看到这张卡片 —— **只问一次**，
  点过「不用了我自己选」之后就不再主动出现（设置窗口里照样能逐个勾选）。

---

# DSH Ready GUI v0.6.1 更新说明

**发布日：2026-09-25** · 从 v0.6.0 累积的所有改动。

> 一句话：修掉一个**会让人以为插件没装好**的问题 —— Command Code 余量在换过数据目录后报
> 「未配置密钥」（原因是插件用写死的凭据名，而引擎按路由声明的 `apiKeyEnv` 取密钥）；
> 顺带给**内置插件的自动更新**补上提示，并做了一轮安全 / 逻辑审计。

## 🔑 修：Command Code 余量报「未配置密钥」

- **换个数据目录后即使卸载重装也不显示余量**，而同一个密钥对话完全正常。原因：插件按写死的
  `COMMANDCODE_GOAT_API_KEY` 找密钥，引擎按路由的 `apiKeyEnv` 取 —— 路由改名成 `commandcode`
  后密钥名变成 `COMMANDCODE_API_KEY`，于是「对话能用、余量说没密钥」。
- 修法：插件**跟着路由走**（先读路由的 `apiKeyEnv`，再回退到默认名）、诊断列出所有找过的名字。
  随包 `dsh-model-surplus 0.4.0 → 0.4.1`。

## 🔔 新：内置插件更新提示

启动维护自动换掉随包插件时，此前只进日志。现在弹右下角角标「内置插件已更新：…（本次启动已生效）」：

- **只报真正变了的**（首次安装不误报「已更新」）；
- 挂在引擎**成功就绪之后**（此时已生效，不需重启；坏插件走「启动失败」那条更重要的提示）；
- 与「引擎已更新」共用角标时不抢占；**切换数据目录后重新允许提示**。

## 🛠 审计修复（无重大安全漏洞，均为具体缺陷）

- 应用更新缓存的**临时名只带 pid** → 同进程两个写者会互相覆盖字节 → 加随机段。
- Command Code 目录接口**每次设置变更都请求**（主题/语言也是设置）→ 加 TTL（成功 10 分钟 / 失败 60 秒）。
- `settings:autosize` 的**发送者校验写法**与其它 12 个 handler 不一致 → 统一。
- Electron 下载的**临时名固定**（并行构建会互相覆盖）→ 加随机段。
- `preload.js` 注释与事实不符（主窗口其实有更窄的 preload）→ 改正。
- `plugin-manager` **10 个内部函数被导出却无人使用** → 移除。

## 🧪 测试

- `verify:builtin` 新增两幕：旧包名环境整体换新；四个随包插件**全部降级后一次性更新** +
  不降级 + 非随包的市场插件不受外壳版本管理。
- `engine-patch` 补 `injectedState` 6 条断言（含「strip 后计数归零」这一不变量）。
- `plugin-enable` 18 项；`plugin-manager` +2；`dsh-model-surplus` 33 项。

## 📦 下载

见 GitHub Release 页：https://github.com/itchenshi/dsh-ready-gui/releases/tag/v0.6.1

---

# DSH Ready GUI v0.6.0 更新说明

**发布日：2026-09-25** · 从 v0.5.0 累积的所有改动。

> 一句话：**随包插件从「OpenCode Go 专用」扩展成「OpenCode Go + Command Code」** —— 其中一个插件
> 因此改名（`dsh-opencode-go-path` → `dsh-gateway-models`），GUI 负责把老用户的旧插件**自动换成新的**
> 并保住他的启用/禁用选择；顺带修好发布工具链（含中文的 `.ps1` 缺 BOM 导致根本跑不起来）。

## 🔌 随包插件

- **`dsh-gateway-models` 0.2.0**（原 `dsh-opencode-go-path`）：新增 Command Code —— 补丁层声明
  `commandcode` 路由的协议**和地址**（用户不必再手填 API 地址），启动时从上游**公开目录**补全模型
  清单（81 个，不需要密钥），只增不改、幂等；路由按**接口地址**识别而非名字。默认路由名改为
  `commandcode`（不带档位后缀），**一个名字覆盖 Go / GOAT / Pro / MAX**。
- **`dsh-model-surplus` 0.4.0**：会话标题右侧新增 Command Code 的 5 小时 / 周窗口百分比与剩余额度。
  响应体形状按**实测**校正（`credits` 与 `windowLimits` 是平级，原先按第三方实现的包装结构写成嵌套，
  会让解析返回 null、界面静默显示「用量不可用」）。
- 两个插件都**不显示月度百分比**：接口不给套餐月度总额度，凭空算就是猜。

## 🔄 旧插件自动替换

启动维护检测到 profile 里还有旧包名时：走引擎卸载 → **bundles 与 `dependencies` 都摘干净**
（只摘 bundles 会被引擎 reconcile 装回来）→ 清残留补丁行与市场禁用项 → 装上替代条目 →
**共用同一行 id `opencode-go`，用户的启用/禁用选择不变**。

本版修掉一个「清理不完整」的缺陷：旧包的 staging 拷贝原先只在「后面恰好有东西要 staging」时才清，
于是「替代条目早就装着」的那次启动会永远留着它（而它正是让残留 `file:` 依赖保持可解析、进而让引擎
把旧包重新登记回去的东西）。现在这一步由旧插件清理自己完成，不再依赖执行顺序。

## 🛠 工具链与测试

- `scripts/release-plugin-tarballs.ps1`：**去掉写死的插件清单**（改为从磁盘推导），版本从各插件
  `package.json` 读 —— 原先写死的名字在改名后静默失效、写死的版本会把 README 的 tarball 链接改回旧版
  （实测踩过 404）。四个插件 README 的链接现已全部 200。
- **含中文的 `.ps1` 补 UTF-8 BOM**：本机只有 Windows PowerShell 5.1，按 ANSI 读无 BOM 脚本会把中文
  解成乱码，`release-plugin-tarballs.ps1` 直接 **14 个语法错误、一行都跑不了**；另加
  `scripts/check-ps1-encoding.cjs` 接进 `npm test` 防回归。
- `npm run verify:builtin` 增加第 5 幕：真实引擎下完成「装着旧包名 → 换成新包」的端到端验证。
- `plugin-enable` 用例 17 → 18；新增「改名记录覆盖 `dsh-opencode-go-path` → `dsh-gateway-models`」。

## 📦 下载

见 GitHub Release 页：https://github.com/itchenshi/dsh-ready-gui/releases/tag/v0.6.0

---

# DSH Ready GUI v0.5.0 更新说明

**发布日：2026-09-22** · 从 v0.4.1 累积的所有改动。

> 一句话：**改名为 DSH Ready GUI，四个随附插件换了包名、也各自建立了独立仓库** —— 应用
> 身份、产物名与三平台仓库名同步更新；插件仍随壳内置（改从 npm 安装这条路暂时走不通，
> 见下）；已有安装的数据目录会自动迁移，不会看起来像全新安装。

> **后续变更（2026-09-25）**：随附插件 `dsh-opencode-go-path` 改名为
> **`dsh-gateway-models`** —— 它已经不只管 OpenCode Go（还给 Command Code 声明协议和地址、
> 并从上游目录同步模型清单），所以换了个不带厂商的名字。补丁层的**行 id 仍是 `opencode-go`**，
> 所以启用/禁用选择不变；旧包名在 `LEGACY_PLUGIN_PKGS` 里做一次性清理，旧仓库名由 GitHub
> 自动重定向。**下文表格里出现的旧名是 v0.5.0 当时的真实状态，保留不改**（本文件是那一版的
> 发布记录）。

---

## 🏷 改名为 DSH Ready GUI

应用从 **DSH GUI** 改名为 **DSH Ready GUI**，仓库从 `DeepSeekHarnessGUI` 改为
`dsh-ready-gui`（GitHub / Gitee / GitCode 三处同步）。

### 为什么改

旧名字既不唯一、也不说明自己是什么：

- `dsh-gui` 在 GitHub 上已被**四个别人的仓库**占用（8★ / 4★ / 4★ / 3★），另有
  `LAN-TINA-WS/dsh-gui-customization`（18★）；
- 更要紧的是 `ScannerVpn/DeepSeekHarnessGui`（6★）与旧仓库名**只差大小写**，GitHub
  搜索视为同一个名字，而它星数是旧仓库的两倍——搜这个关键词的人先看到的是别人；
- npm 上 `dsh-gui`、`deepseek-harness-gui`、`dsh-desktop` 也全被占。

新名字 `dsh-ready-gui` 实测三项全零：npm 空闲、GitHub 无同名仓库、DSH 生态注册表
（4000+ 条目）里也没有占用。「ready」对应这个项目的定位——**打开就用**；「gui」说明它
是图形界面而不是命令行。

### 改了什么

| 项 | 旧 | 新 |
|---|---|---|
| 应用显示名 | `DSH GUI` | `DSH Ready GUI` |
| 应用身份 `appId` | `com.dsh.guishell` | `com.dshready.gui` |
| 仓库名（三平台） | `DeepSeekHarnessGUI` | `dsh-ready-gui` |
| 包名 | `dsh-gui-shell` | `dsh-ready-gui` |
| 构建产物 | `DSH-GUI-WIN/MAC/LINUX` | `DSH-READY-GUI-WIN/MAC/LINUX` |
| 窗口标题 / 托盘提示 | `DSH GUI v0.5.0` | `DSH Ready GUI v0.5.0` |

### ⚠️ 数据目录会自动迁移

Electron 的 `userData` 目录由 `productName` 推导，所以改名会把目录从
`<appData>\DSH GUI` 变成 `<appData>\DSH Ready GUI` —— 而**引擎、`dsh-home`、
`settings.json`、`pnpm-tools` 全在旧目录里**。不处理的话，已有安装会看起来像全新安装：
重新下载引擎（数百 MB）、丢掉模型配置与会话历史。

启动时会在**任何代码读取 userData 之前**做一次性迁移（`src/userdata-migrate.js`）：把旧
目录里「新目录还没有」的条目搬过去；只 rename、绝不删除；幂等；迁移失败绝不让应用起不来
（最坏情况是当作全新安装）。新目录会留下 `legacy-userdata-migrated.txt` 作为记录。该模块
有 7 项单测，其中一条专门守住「旧目录名必须是 `DSH GUI`」——一次批量改名曾把它也替换成
新名，使迁移静默失效（`legacy` 与 `current` 变成同一个目录）。

### 刻意**没有**改的东西

这些字符串里的 `dsh-gui` 是内部标识符或历史契约，改了会坏事：

- **`// dsh-gui:`** —— 引擎补丁写进引擎自身文件的标记，必须与旧版写下的内容一致，否则
  识别不出、也清理不掉旧补丁；
- **`<home>\.dsh-gui\bundled-plugins`** —— 插件 staging 目录，磁盘上真实存在、且 profile 的
  `file:` 依赖直接指向的路径（v0.4.1 引入，v0.5.0 改回内置后继续沿用）；
- **`dsh-gui-last-session`** —— 那是另一个项目的名字（四个随附插件之一）；
- **`DSH_SHELL_*` 环境变量**（13 个，README 里公开的接口）与 **`dsh-gui:*` IPC 通道**
  —— 内部/接口标识，用户看不到，改名只会制造破坏。

所以 `grep dsh-gui` 在新代码里仍会命中这些地方，那是有意保留的。

### 对已有安装的影响

`appId` 变了，操作系统会视为**另一个应用**：新版不会覆盖旧安装，装完后需要卸载旧的
「DSH GUI」。数据目录会自动迁移（见上），所以卸载旧的不会丢配置 —— 但**先启动一次新版
完成迁移，再卸载旧的**更稳妥。

---

## 📦 四个随附插件：包名与仓库名统一了，但**仍然随壳内置**

四个插件（模型余量、会话续接、OpenCode Go 路由、按键设置）**继续随应用打包**，
`plugins/` 仍在仓库里，安装方式与 v0.4.1 相同（先 staging 成磁盘上的真实目录、再以
`file:` 装进 profile，见本文末尾）。同时它们各自有了独立仓库，包名与仓库名一一对应：

| 插件 | 包名 | 仓库 |
|---|---|---|
| 模型余量 | `dsh-model-surplus` | https://github.com/itchenshi/dsh-model-surplus |
| 会话续接 | `dsh-gui-last-session` | https://github.com/itchenshi/dsh-gui-last-session |
| OpenCode Go 路由 | `dsh-opencode-go-path` | https://github.com/itchenshi/dsh-opencode-go-path |
| 按键设置 | `dsh-keys-setting` | https://github.com/itchenshi/dsh-keys-setting |

### 为什么最后没有改成从 npm 安装

原计划是把四个插件拆出去发布到 npm、壳改成像 `dsh-market` 那样从 registry 安装。好处是
明确的：插件更新不必再等壳发版（以前插件代码打进 app.asar，只有装新版 GUI 才会更新），
而且官方桌面端、Tauri 客户端、`dsh web`、CLI 都能装——生态里 4000+ 插件都是这个形态，
独立仓库也是 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
与插件市场收录的前提（注册表按 `owner/repo` 收录，插件埋在 monorepo 里无法上架）。

**但这条路卡在发布渠道上**：npm 账号注册目前走不通，包发布不出去。而「装了、却装不回来」
的插件比「随壳发布的旧版」糟得多——本轮实测就是这样：profile 里登记着 npm 版本、registry
上却没有，于是插件从 `dsh.profile.bundles` 里消失、引擎少一个功能，而且那条解析不了的
依赖会让这个 profile 里**每一次**安装操作一起失败（包括在修别的插件的时候）。

所以本轮**保持内置**：壳必须能自给自足。四个独立仓库先留着，等发布渠道通了再切。

### 三个包名换掉了（重要）

**npm 上的 `dsh-opencode-go` 与 `dsh-composer-keys` 已被其他作者占用**，无法使用：

- `dsh-opencode-go` → **[Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)**
- `dsh-opencode-go-plus` → **[yumusb/dsh-opencode-go-plus](https://github.com/yumusb/dsh-opencode-go-plus)**
- `dsh-composer-keys` → **[zlqd123/dsh-composer-keys](https://github.com/zlqd123/dsh-composer-keys)**

而 `dsh-model-usage` 虽然 npm 上还是空的，但 **GitHub 上已经有三个别人的同名仓库**
（`ZSN12/DSH-model-usage` 10★、`Timmononon/dsh-model-usage`、`niushuanan/dsh-model-usage`），
其中前两个的 `package.json` 里 `name` 也写着 `dsh-model-usage`——也就是说谁先 `npm publish`
谁拿到这个名字。与其将来竞速，这次一并换掉了（顺带让包名与仓库名一一对应）。

因此本项目的包名为 **`dsh-opencode-go-path`**、**`dsh-keys-setting`**、
**`dsh-model-surplus`**。（输入框快捷键曾短暂用过 `dsh-composer-keys-setting` 这个中间名，
后改为更短的 `dsh-keys-setting`；该中间名从未发布到 npm，v0.5.0 也没随壳发过，但迁移表里
仍留着一条兜底清理。）

**补丁层的行 id 与设置命名空间保持原样**（`composer-keys` / `model-usage`），这是刻意的：
禁用行、市场 `state.json` 的开关、`settings.yaml` 里保存的键位都记在那些名字下。包名只是
安装标识，改它不该让用户的键位设置或启用/禁用选择失效。
**这不影响功能**，只影响 `dsh plugin add` 里写的包名。

### 老用户迁移（自动，无需手动操作）

GUI 启动维护会把三个旧包名一次性清理掉，逻辑与既有的改名迁移完全一致：

1. 摘掉 profile 的 bundles 登记与 `package.json` 里的 `file:` 依赖（只摘 bundles 不够——
   引擎的 reconcile 会依据残留依赖把旧插件重新登记回来，实测会导致新旧同时加载）；
2. 清掉补丁层里指向旧行 id 的残留 `disabled:` 行（`opencode-go` / `composer-keys`）；
3. 把「已禁用」的选择搬到新包上——**改名不该改变用户的选择**；
4. 随后由启动流程从**随包副本**安装新包（新旧补丁层行 id 保持一致，因此选择能对上）。

失败自动恢复、插件市场双向同步等既有能力不受影响。

### 顺带：DeepSeek V4.1 模型现在排在模型选择器最前（`dsh-opencode-go-path` 0.1.2）

插件原来是把 `deepseek-v4.1-flash` **追加**到 `opencode-go` 的模型列表**末尾**，而且列表里一旦
出现 v4.1 就完全不动 —— 所以已经补过模型的用户，那条永远停在最后，想让它当默认模型只能手动拖。
现在改成**放在最前**：列表顺序就是模型选择器的顺序、第一项是默认选中项，所以「装上即用」意味着
V4.1 Flash 默认被选中。已经是这个形状就不写（幂等，也不会因为自己写的设置再触发一轮），并且
**你自己那条同 id 的条目原样保留**（改过名字或上下文长度不会被默认值覆盖）；「在不在列表里」
按插件自己的 id 判断，上游将来多出别的 v4.1 型号不会把已收录的 Flash 顶掉。

### 开发：插件源码 → 内置副本（`npm run sync:plugins`）

四个插件的源码在各自的独立仓库里，本仓库的 `plugins/` 是**生成**的内置副本 —— 手工维护两边
同步正是「应用里带着旧插件」这类问题的来源，所以副本由脚本生成：`npm run sync:plugins` 把插件
仓库（按 git 跟踪的文件 + 未被忽略的未跟踪文件，含未提交改动）全量镜像进 `plugins/`，删掉源里
已经没有的文件，保持副本原有的行尾约定，并校验 `name` / `version` / `dsh.bundle.patch` /
`cordis.patch.yml`。`--check` 只报告漂移（有漂移退出码 1，适合 CI），`npm run dist:*` 会**先跑
同步**，因此发布产物不可能带着旧插件。开发工作区是 `dsh-dev/{dsh-ready-gui,plugin-repos}`
（脚本自动找到插件仓库，也可以用 `--repos` / `DSH_PLUGIN_REPOS` 指定）。

### 内置插件的安装来源由应用自己管

内置条目的「正版」只有一份：随壳打包、由主进程 staging 出来的
`<home>\.dsh-gui\bundled-plugins\<包名>`。profile 里那条依赖只要不是它——指向开发用的
checkout、v0.4.1 的旧 staging 目录、npm 或 git 安装——启动维护就换回随包那一份。不管的话
应用就不再自给自足：实测过一条依赖指向某个 checkout，那个目录一没了插件就再也装不上。

**实现上有个实测得出的坑**：不能指望 `dsh plugin add <name>` 原地改写那条 spec。在引擎
0.1.5-rc.2 / pnpm 12 上实测——对一个已登记进 bundles 的包执行 `dsh plugin add <name>` 会
exit 0、pnpm 也确实跑了一遍，但它打印的是 *Lockfile is up to date, resolution step is
skipped*，`package.json` 里的 `file:` spec **原样保留**，等于什么都没做。所以走的是与改名
迁移完全相同的已验证路径：**remove → prune 残留登记 → add**。prune 不能省：只 remove
的话，残留的 `dependencies` 会被引擎的 reconcile 重新登记回 bundles。

**先摘登记，再跑 pnpm。** 摘登记是纯改文件；而只要 profile 里还留着一条解析不了的 `file:`
依赖，接下来每一次 pnpm 调用都会整体失败——连累的正是我们想修的那个插件。实测顺序颠倒时
的后果：第一个插件的 `remove` 就报 ENOENT，四个里只修好两个，剩下的要等下一次启动才补上。
摘登记之前还会先确认随包那份**能 staging 出来**（staging 只是复制文件、不跑 pnpm）：万一
staging 失败（磁盘满、权限、路径不可用），那就什么都不动，profile 里原来那份照旧——否则
一次 staging 失败就会把已经装好的插件摘没。

**换不成时会把原来那份装回去。** 走到这一步最常见的原因是随包副本 staging 失败或 pnpm 装
不上——那时旧副本虽然来路不对，也比「插件凭空消失」好得多。实测：`remove` + `prune` 之后
`add` 失败，随即以原来的 spec 重装，插件仍在 `dsh.profile.bundles` 里、文件重新落地。

## 📖 文档重写：README 按「打开就能用」重来

根 README 中英双版重写，篇幅砍掉约 70%：先回答「你想要什么 → 这里怎么做」，再讲设置窗口、数据位置、
常见问题；原先按版本堆叠的更新亮点、逐条罗列的内部实现细节、重复多遍的「为什么内置」都收敛掉了。
界面预览按场景重排，中英文各用本语言的截图。四个随附插件的 README 同样重写。

## 🔧 随附插件修复：opencode-go 路由（0.1.3 → 0.1.4）

三处都是 `deepseek-v4.1-flash` 在 `opencode-go` 上真实踩到的问题：

1. **没配模型列表时什么都不做** —— 原先只在用户已配 `models` 时才动手，所以「插件装了、模型却没进
   模型目录」。现在用引擎自己的 `llm.discoverModels()` 检测该路由的目录（自带目录的路由不触网），
   没配列表时用目录做种子，写出「V4.1 在最前 + 目录里全部模型」，一项都不丢。
2. **加了模型却发不出请求** —— 目录外的模型必须有路由级 `baseURL` 才有地址，而 `opencode-go` 没有
   provider 级 baseUrl，写 `settings.yaml` 的严格校验会整笔被拒。现在仅在路由没有时补上。
3. **多轮对话 400 `reasoning_content`** —— pi-ai 按厂商名/域名自动探测 DeepSeek 兼容，OpenCode Go
   中继两样都不匹配，于是回放历史缺 `reasoning_content`。现在补上与同路由目录条目逐字一致的
   `compat` 与 `reasoningEfforts`。

三处都**幂等且只补不覆盖**：你已经加过的那条会被就地升级，不用删了重加；你自己改过的名字、容量、
compat 开关都保留。单测 27 项全过，另在真实引擎 + 隔离数据目录上端到端验证过。

## 📦 内置插件为什么非 staging 不可

「捆绑插件」不能按 app.asar 内的路径安装——子进程 pnpm 会把 app.asar 当普通文件，报
*as it does not exist*。所以主进程每次都先把插件复制成磁盘上的真实目录
（`<home>\.dsh-gui\bundled-plugins\<包名>`），再用 `file:` 装进 profile。v0.5.0 一度删掉过
这套机制（插件改从 registry 装就不再需要它），确定改回内置后原样恢复：

- `src/plugin-manager.js`：`bundledPluginsRoot` / `bundledSourceDir` / `copyDirRecursive` /
  `stageBundledPlugin` / `readPackageVersion` / `installedBundleVersion`，以及
  `syncEnabledPlugins` 里「随包版本更新才重装」的分支；
- `src/main.js`：`pluginBundledPluginsDir()` 与 `shortPathIfSpaced()`——后者为 staging 路径
  的 8.3 短化而存在（`C:\Users\Some User\…` 这种带空格的路径会让 pnpm 的 `file:` 解析出错）；
- `electron-builder.yml`：`plugins/**/*` 重新打进 app.asar。

**staging 目录必须是稳定路径**：pnpm 会把 `file:` spec 原样写进 profile 的 `dependencies`，
之后在那个 profile 里再跑 pnpm 仍要解析到同一路径，所以它由 userData 推导、不带随机数。

`pluginHasClientHalf` 是「已装读 profile 里的真实 manifest、未装用目录条目的 `client`
声明」：前者权威；后者让「是否含页面半边」在**安装前**就能显示（它决定启用/禁用后要不要
刷新页面），所以目录条目里保留了 `client: true|false` 声明。

> 注：这个目录现在是**应用的工作目录**，不要手动删除。里面是随包插件的副本，profile 的
> `file:` 依赖直接指向它；删掉会让已装插件当场解析不到（下次启动会重新 staging 并换回，
> 但这一次启动是失败的）。同一台机器上可能有多个 DSH_HOME（本 GUI 的 `dsh-home` 与系统
> `~/.dsh`），各自独立、互不影响。


---

# DSH GUI v0.4.1 更新说明

**发布日：2026-09-21** · 从 v0.4.0 累积的所有改动。

> 一句话：**安全与可靠性修复版本** —— 修掉了「插件浏览器路由没有鉴权」（本机任何进程都能读到账户用量与余额）、「任意插件可禁用引擎自己的行」、「主窗口可被导航到外部页面」、「权限默认全放行」、「补丁层跨进程丢行」等问题；同时新增 **DSH GUI 自身自动检查新版本**（国内外网络自动择优）与 **输入框快捷键插件**。

---

## 🔐 安全修复（GUI）

### 导航围栏：主窗口不再能被导航走

引擎页面里运行的任何脚本（包括**第三方插件的页面半边**）此前都能执行
`location.href = 'https://…'` 把窗口导航到任意外部页面 —— 而 preload 桥是绑在 webContents 上的，
**桥会跟着过去**，远端页面因此拿到「重启引擎」「读写上次会话」的能力；`window.open` 还能开出一个
继承同样 webPreferences 的未受管窗口。

现在主窗口只允许停留在**已验证的引擎来源**，设置窗口/通知窗口只允许停留在自身文件，弹窗一律不托管
（http(s) 交给系统浏览器）。对抗测试（真实应用内发起）：`location.href` 被拦、`window.open` 返回
null、`about:blank` 弹窗被拒、注入的 iframe 读不到 `window.__dshGui`。

### 引擎 URL 只接受本机/私有地址

引擎把自己的访问 URL 打在 stdout（`dsh web: …`），而那段输出**不是可信通道**：引擎进程里跑着
第三方插件的宿主半边，它们能在服务真正监听之前打印自己的 URL。此前该 URL 被直接 `loadURL`，
且解析用的正则带 `\s*$` 锚尾 —— 引擎绑定非回环地址时会在同一行追加 `(LAN: …)`，整行失配会让健康
引擎被判为启动失败，90 秒后甚至自动卸载本次新装的插件。

现在只接受 `http:` + **回环/私有 IP 字面量**（域名一律拒绝，`userinfo` 夹带也算域名），并补上
`(LAN: …)` 后缀的兼容。

### 权限围栏：不再默认批准麦克风/摄像头/定位/通知

Electron 默认批准**所有**权限请求，而引擎页面里加载着第三方插件的页面半边。现在主窗口的 session
装了 `setPermissionRequestHandler` + `setPermissionCheckHandler`：默认拒绝，只放行与界面本身相关
且不采集隐私的三项（剪贴板写入、全屏、指针锁定）。实测：麦克风/摄像头 → `NotAllowedError`、
通知 → `denied`、定位 → `User denied Geolocation`。

### 特权 IPC 统一校验发送方

13 个 `ipcMain.handle` 此前只有 `settings:autosize` 校验发送方，其余（插件安装/卸载/启用、引擎更新
与重启、设置写入、last-session 写入）对任何渲染进程开放。现在统一收口：设置窗口的通道只接受设置
窗口，`dsh-gui:*` 只接受主窗口。

### 其他

- 启动失败日志与诊断对话框里的**引擎访问 token 脱敏**（此前会把带 `?token=` 的 stdout 尾部写入
  `<userData>/logs/dsh-start-*.log`）。
- 破坏性测试钩子（删插件补丁文件、自动确认危险对话框）**仅在未打包构建生效**。
- 启动链补上顶层 `catch`（此前同步抛出只会留下一条 unhandled rejection：进程活着、没有窗口、
  也没有提示），三处 `loadFile` 也补了 `.catch`。

## 🔐 安全修复（内置插件）

### 插件路由此前完全没有鉴权

`dsh-model-usage`、`dsh-composer-keys`、`dsh-gui-last-session` 都用 `ctx.webServer.register()` 注册
浏览器路由，而引擎的信任围栏（Host 白名单 + 会话 cookie）**只作用于 RPC 通道**，不会覆盖这些路由。
实测（无任何凭据）：

| 请求 | 修复前 | 修复后 |
|---|---|---|
| `GET /model-usage` | **200**，返回账户用量与 DeepSeek 余额 | 401 |
| `GET /composer-keys` | **200** | 401 |
| `POST /composer-keys` | **200，且真的写入 settings.yaml** | 401 |
| `GET /gui-last-session` | **200** | 401 |
| 以上带 `Host: evil.example`（DNS rebinding 形状） | 仍 **200** | 401/403 |
| 合法页面（同源，带会话 cookie） | 200 | **200（不受影响）** |

修复方式是调用引擎自己用的那套围栏（`connection.requestRejection`，引擎自带的 open-in-app 路由
就是这么做的），并 **fail-closed**：拿不到围栏服务时返回 403 而不是放行。围栏函数放在无依赖的
`lib/shared.js`，有单测覆盖 fail-closed 与 401/403 映射。

### 其他插件侧

- `dsh-opencode-go`：debug 落盘/日志**不再写入原始会话 id**（`session-id` 模式下那个值就是内部会话
  id，与 README/patch 里的承诺相矛盾）；fetch 补丁**按目标主机收窄**，不再给同一窗口内的跨主机
  请求也加会话头；自动补模型改为**只扩展用户自己配置过的 `models` 列表**（用户没有配置时，引擎自带
  目录才是权威 —— 往空列表写入会用我们那份列表整体替换目录）。
- `dsh-model-usage`：`parseLimitsTable` 的灾难性回溯修复（实测 745 字节的畸形表格即可让引擎事件循环
  卡死；解析发生在启动时的同步路径上），并给上游响应加 2 MiB 上限；额度缓存不再把未来时间戳当
  「很新鲜」（否则永远不再刷新）。
- `dsh-gui-last-session`：临时文件名加随机后缀（并发 POST 会互相覆盖）。

## 🛠 插件管理器修复

### 任意第三方插件可以禁用引擎自己的行

插件可以声明 `dsh.bundle.patch: "../../../….yml"` 越界指向别的补丁文件，或额外放一个
**引擎根本不会加载**的 `cordis.patch.yml`，从而把 `webserver` / `modules` / `session` 之类引擎行的
row id 认领成「自己的」，随后 GUI 会名正言顺地写出 `disabled: true` 并返回成功。
两条路径均已复现（`packageRowIds` 返回 `["webserver","modules"]` / `["evil-row","session"]`，
`setPluginEnabled` 返回 `{ok:true}`）。

现在：只读**引擎真正会加载的那一个**补丁文件（声明了什么读什么，未声明时才退回约定文件名 ——
那正是引擎自己的规则），且解析后的路径必须仍在包目录内；另有保护名单与跨包归属校验
（含 symlink/junction 形式的包）。

### 补丁层写入：跨进程锁 + 原子 + 校验

GUI 与插件市场（在引擎进程里）会写同一个 `cordis.patch.yml`。此前用固定 `<file>.tmp` 名、且没有
任何跨进程互斥：两边各自「读—改—写」，后写的一方用**旧快照**覆盖，先写的行就消失了 —— 而写后校验
也发现不了（对方那份文本同样是合法条目列表）。

实测 3 个进程 × 40 行并发写：**80 行报成功、磁盘上只剩 52 行（28 行静默丢失）**。
修复后：**120/120 全部保留、0 静默丢失**，做法是跨进程锁文件（`wx` 独占创建、`Atomics.wait` 等待、
10 秒陈旧锁接管）+ 唯一临时名 + 写后校验并重试；真被覆盖则如实报失败，绝不显示成「已禁用」。

### 写失败不再翻转市场状态

补丁层写失败时，此前仍会把「已禁用」写进 `.dsh-market/state.json`，于是界面与市场都显示已禁用、
而引擎照常加载 —— 正是这类漂移最容易让人以为插件坏了。现在写失败只报失败，durable state 保持原样。

### 其他

- **读错误不再被当成「文件不存在」**：EACCES/EISDIR/EBUSY 等此前会在空文本上做变换并把**整层补丁**
  （别的插件的行、引擎行覆盖）替换掉，而且形状检查还会通过并返回成功。
- **形状检查更严**：空占位 `[]` 之后还有内容、顶层条目后跟垃圾缩进，此前都被当作合法并继续追加。
- **同一 id 不再出现两行**：`patchTextState` 改为缩进无关；禁用时若已有 `disabled: false` 行则就地
  翻转而不是再追加一行（否则生效结果取决于引擎的合并顺序）。
- **安装器**：要求包**确实落地**才视为已装（登记在案但文件已丢时，此前点多少次安装都是
  `失败：?` 且不会自愈）；随包版本**比已装新**时才重装（此前 `!==` 会把更新的副本无人值守降级）；
  暂存复制改用 `lstat` 并跳过链接；暂存路径拒绝 cmd 元字符。
- **profile manifest**：写回前重读（此前在多次 `await` 前读快照，会覆盖并发写入的 bundles）。
- **插件状态指纹**：补上 `rowIds` 与 `client` —— 这两项变化此前不会触发设置窗口重绘。

## ✨ 新功能

### 自动检查 DSH GUI 新版本（国内外网络自动择优）

- 启动后自动检查（1 小时内不重复），长会话期间每 6 小时后台复查；**有新版才用通知窗口提醒**
  （不打断使用），无新版或离线时静默；同一个新版本只提醒一次。
- 同一个版本同时发布在三个开源平台，检查会**自动按网络地区择优**：国内（`zh-CN` 或
  Asia/Shanghai / Urumqi / Chongqing 时区）先试 Gitee → GitCode → GitHub，国外反之；每个源单独
  限时、逐个回退，并记住上次可用的源优先使用 —— 国内用户不会先在 GitHub 上白等一次超时。
- **无需任何配置**。手动入口是托盘「检查 DSH GUI 更新…」，会打开**实际答上来的那个平台**的下载页。
- 实测：本机（Asia/Shanghai）判定国内 → 顺序 Gitee → GitCode → GitHub → **Gitee 首次尝试 251ms
  命中**。（三家的未认证 API 均为每 IP 每小时 60 次，1 小时 1 次只占 1/60。）

### 输入框快捷键插件（`dsh-composer-keys` 0.2.0）

设置窗口「通用」页最下方新增一行，可分别配置 **Enter / Shift+Enter / Ctrl+Enter** 是「发送消息」
还是「换行」。

- 默认值即引擎默认（Enter 发送、Shift+Enter 换行），**不改变任何现有习惯**。
- 实现是**转派引擎自己的按键事件**，不修改编辑器内容，因此与引擎行为始终一致；识别到与默认相同
  的手势时完全不介入（零开销）。
- 宿主半边把偏好写进引擎设置文档（随数据目录迁移），页面半边只做捕获阶段的键位重映射。
- 设置行与「对话显示」那一行**完全一致**：同样的 `<button>` 胶囊 + 箭头 SVG + 弹层（不是原生
  `<select>` —— 原生控件会画自己的箭头与内边距，怎么调都对不上）。

## 🎛 设置窗口

- 第三方插件列表更紧凑：通用规则（安装/卸载需重启引擎、启用/禁用热重载）写在段落说明里，
  因插件而异的「含页面部分 · 需刷新页面」以小标签标在对应行上。
- 「待重启引擎」标注（按钮持续脉冲 + 旁边小标签）在重启失败时会保留，不再乐观清除。
- 相关修复：数据目录切换被取消时不再闪「已保存」；`api.autoSize` 的 Promise 拒绝不再变成
  未处理异常。

## 🧪 测试

- 新增 `src/test/engine-url.test.cjs`（7 项）与 `src/test/update-sources.test.cjs`（11 项）。
- 三个含路由的插件补上围栏单测（fail-closed、401/403 映射、请求对象透传）。
- `src/test/plugin-manager.test.cjs` 新增缩进无关扫描、归属拒绝、原子写、跨进程等用例。
- 修掉两条「名称与断言不符」的测试：`dsh-model-usage/tests/e2e.cjs` 的通过条件此前**恒真**
  （路由硬编码 `ok:true`），`dsh-gui-last-session` 的「write is atomic」此前没检查残留临时文件。
- 把**从未接入 `npm test`** 的 `dsh-gui-last-session` 套件接入（14 项）。
- `scripts/smoke-plugin-enable.ps1` 适配围栏：先换取会话 cookie 再读路由，并断言「不带 cookie
  绝不能拿到插件数据」；同时改为从引擎 stdout 的 `dsh web:` 行取 URL（GUI 日志出于脱敏只记 origin）。
- `check-settings-html.cjs` 里那条「启用开关不在安装 label 内」的断言此前**抓不到它要防的回归**
  （比较的是两个 `indexOf`，而第一个 `</label>` 恰好出现在 label 内部），已改为按 `return (…)`
  表达式作用域解析；并用合成样本验证它能区分正确/回归。

## 🐛 其他修复

- **「移动并切换」数据目录后引擎不会重启**的回归（`wasRunning` 在 kill 之后才判断，恒为 false）。
- `engineRestartInFlight` 在一次失败重启后永久卡住（手动与自动重启都返回「已经在重启」）；
  `pluginFailureRecoveryDone` 每次启动复位。
- 90 秒看门狗的死胡同：无本次新装插件时会走进「剔除重试」分支，而该函数先清掉定时器再直接返回 ——
  既不诊断也不重试，窗口无限转圈且无任何提示。
- 手动更新引擎前先停引擎（Windows 上运行中的进程会让目录 rename 失败；即便成功，旧进程也在执行
  已被改名、随后被删除的目录）；更新失败则把引擎拉回。
- app 更新检查：并发闸、缓存原子写、未来时间戳夹紧（此前一个未来时间戳会让自动检查**永久**不再执行）。
- `npmInstall` 加 10 分钟超时（卡住的 registry/TLS 此前会让安装与启动无限等待）。
- `cmd /c` 路径插值拒绝元字符；引擎就绪时主窗口可能已被关闭的未捕获异常。
- **引擎页「回到最近会话」的兜底补丁锚点适配当前引擎**：锚点写死 `function apply(ctx) {`，而当前
  引擎是 `function apply(ctx, config = Config({})) {` —— 补丁此前**从未生效**（只有插件在起作用）。
  现在锚点支持前缀匹配，并已在本机引擎上验证命中。
- 数据迁移：目标目录已有数据时改为**显式询问**（默认取消），不再静默覆盖后删除源目录。

## ⬆️ 升级说明

- **插件版本号已提升**：`dsh-model-usage` **0.3.1**、`dsh-gui-last-session` **0.1.1**、
  `dsh-opencode-go` **0.1.1**、`dsh-composer-keys` **0.2.0**。
  GUI 的「随包更新」只在**版本变化**时替换已装副本 —— 所以**必须使用 v0.4.1 及以后的新构建**，
  这些安全修复才会真正进入你的 profile（本轮 e2e 正是因此暴露过一次：暂存目录里仍是没有围栏的
  旧副本，路由依然无鉴权）。
- 装好新版本后首次启动会自动替换；也可以在新版设置窗口点「修复 / 重试」立即触发。
- 无配置迁移、无需手动操作；数据目录与既有设置原样保留。

## 📦 下载

- GitHub：https://github.com/itchenshi/DeepSeekHarnessGUI/releases/latest
- Gitee（国内推荐）：https://gitee.com/itchenshi/DeepSeekHarnessGUI/releases
- GitCode（国内备用）：https://gitcode.com/itchenshi/DeepSeekHarnessGUI/releases
