# DSH Ready GUI v0.5.0 更新说明

**发布日：2026-09-22** · 从 v0.4.1 累积的所有改动。

> 一句话：**改名为 DSH Ready GUI，并把四个随附插件拆成独立仓库** —— 应用身份、产物名
> 与三平台仓库名同步更新；壳不再打包插件，改为从 registry 安装；已有安装的数据目录会
> 自动迁移，不会看起来像全新安装。

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
- **`<home>\.dsh-gui\bundled-plugins`** —— v0.4.1 的插件 staging 目录，是磁盘上真实存在
  的路径（迁移逻辑按它匹配）；
- **`dsh-gui-last-session`** —— 那是另一个项目的名字（四个随附插件之一）；
- **`DSH_SHELL_*` 环境变量**（13 个，README 里公开的接口）与 **`dsh-gui:*` IPC 通道**
  —— 内部/接口标识，用户看不到，改名只会制造破坏。

所以 `grep dsh-gui` 在新代码里仍会命中这些地方，那是有意保留的。

### 对已有安装的影响

`appId` 变了，操作系统会视为**另一个应用**：新版不会覆盖旧安装，装完后需要卸载旧的
「DSH GUI」。数据目录会自动迁移（见上），所以卸载旧的不会丢配置 —— 但**先启动一次新版
完成迁移，再卸载旧的**更稳妥。

---

## 📦 四个插件拆成独立仓库并发布到 npm

### 改了什么

`plugins/` 目录从本仓库移除。四个插件的源码、测试与发布流程各自独立：

| 插件 | npm 包名 | 仓库 |
|---|---|---|
| 模型余量 | `dsh-model-surplus` | https://github.com/itchenshi/dsh-model-surplus |
| 会话续接 | `dsh-gui-last-session` | https://github.com/itchenshi/dsh-gui-last-session |
| OpenCode Go 路由 | `dsh-opencode-go-path` | https://github.com/itchenshi/dsh-opencode-go-path |
| 按键设置 | `dsh-keys-setting` | https://github.com/itchenshi/dsh-keys-setting |

### 为什么

- **插件更新不必再等壳发版**：以前插件代码打进 app.asar，只有装新版 GUI 才会更新；
  现在是一条普通的 registry 条目，`dsh plugin update` / 插件市场即可升级。
- **插件与宿主解耦**：官方桌面端、Tauri 客户端、`dsh web`、CLI 都能装，不再只服务
  于本壳。生态里 4000+ 插件都是这个形态，独立仓库才能被
  [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
  与插件市场收录。
- **一个仓库一个条目**：注册表按 `owner/repo` 收录，插件埋在 monorepo 里无法上架。

### 三个包名换掉了（重要）

**npm 上的 `dsh-opencode-go` 与 `dsh-composer-keys` 已被其他作者占用**，无法使用：

- `dsh-opencode-go` → **[Duskriver/dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)**
- `dsh-opencode-go-plus` → **[yumusb/dsh-opencode-go-plus](https://github.com/yumusb/dsh-opencode-go-plus)**
- `dsh-composer-keys` → **[zlqd123/dsh-composer-keys](https://github.com/zlqd123/dsh-composer-keys)**

而 `dsh-model-usage` 虽然 npm 上还是空的，但 **GitHub 上已经有三个别人的同名仓库**
（`ZSN12/DSH-model-usage` 10★、`Timmononon/dsh-model-usage`、`niushuanan/dsh-model-usage`），
其中前两个的 `package.json` 里 `name` 也写着 `dsh-model-usage`——也就是说谁先 `npm publish`
谁拿到这个名字。与其竞速，拆仓时直接换掉了。

因此本项目的包名为 **`dsh-opencode-go-path`**、**`dsh-keys-setting`**、
**`dsh-model-surplus`**。（输入框快捷键曾短暂用过 `dsh-composer-keys-setting` 这个中间名，
后改为更短的 `dsh-keys-setting`；该中间名从未发布到 npm，v0.5.0 也没随壳发过，但迁移表里
仍留着一条兜底清理。）

**补丁层的行 id 与设置命名空间保持原样**（`composer-keys` / `model-usage`），这是刻意的：
禁用行、市场 `state.json` 的开关、`settings.yaml` 里保存的键位都记在那些名字下。包名只是
安装标识，改它不该让用户的键位设置或启用/禁用选择失效。
**这不影响功能**，只影响 `dsh plugin add` 里写的包名。

### 老用户迁移（自动，无需手动操作）

GUI 启动维护会把两个旧包名一次性清理掉，逻辑与既有的改名迁移完全一致：

1. 摘掉 profile 的 bundles 登记与 `package.json` 里的 `file:` 依赖（只摘 bundles 不够——
   引擎的 reconcile 会依据残留依赖把旧插件重新登记回来，实测会导致新旧同时加载）；
2. 清掉补丁层里指向旧行 id 的残留 `disabled:` 行（`opencode-go` / `composer-keys`）；
3. 把「已禁用」的选择搬到新包上——**改名不该改变用户的选择**；
4. 随后由启动流程从 npm 安装新包（新旧补丁层行 id 保持一致，因此选择能对上）。

失败自动恢复、插件市场双向同步等既有能力不受影响。

### `file:` 安装也要迁移（名字没变的那个插件）

`dsh-gui-last-session` 的**包名没变**，所以不在改名迁移表里——但
v0.4.1 及更早是把随附插件 staging 到 `<home>\.dsh-gui\bundled-plugins` 之后用 `file:` 装进
profile 的（profile 的 `dependencies` 里能看到 `file:C:/…/.dsh-gui/bundled-plugins/…`）。
那份拷贝冻结在随旧版发布的版本上，而 v0.5.0 起 staging 目录不再被任何代码写入，于是：

- 留着它 = 这个插件**永远拿不到 npm 上的更新**（GUI 只按 `dsh.profile.bundles` 判断「已装」）；
- 一旦 staging 目录被清掉（用户清理、换机拷贝、家目录迁移），profile 会因为解析不到
  这个依赖而**启动失败**。

（另外三个插件的包名都变了，由上面那条改名迁移处理，走不到这条路径。）

现在启动维护会识别这种「装是装了、但来源是 v0.4.1 的 staging 目录」的条目
（`isLegacyStagedInstall`：读 profile `dependencies` 里那条 spec，必须是 `file:` 且路径落在
`.dsh-gui/bundled-plugins` 里）并换成 registry 版本。

**为什么只认那一个目录、不认任意 `file:`**：从自己的 checkout 安装（开发时，或 registry 上
还没发布时的本地安装）是有意为之。把任意 `file:` 都当成旧版残留去 remove+add，而 registry 上
又还没有这个包时，插件会被删掉且装不回来——在引擎 0.1.5-rc.2 上实测过：`remove` + `prune`
成功、`add` 404，插件直接从 `dsh.profile.bundles` 里消失。所以判定收窄到 staging 目录。

**实现上有个实测得出的坑**：不能指望 `dsh plugin add <name>` 原地改写那条 spec。在引擎
0.1.5-rc.2 / pnpm 12 上实测——对一个已登记进 bundles 的包执行 `dsh plugin add <name>` 会
exit 0、pnpm 也确实跑了一遍，但它打印的是 *Lockfile is up to date, resolution step is
skipped*，`package.json` 里的 `file:` spec **原样保留**，等于什么都没做。所以走的是与改名
迁移完全相同的已验证路径：**remove → prune 残留登记 → 从 registry 装回来**。prune 不能省：
只 remove 的话，残留的 `dependencies` 会被引擎的 reconcile 重新登记回 bundles。

**换不成时会把原来那份装回去。** 走到这一步最常见的原因是 registry 上还没有这个包（npm 发布
尚未完成、或本机连不上 registry）——那时旧副本虽然陈旧，但比「插件凭空消失」好得多。实测：
`remove` + `prune` 之后 `add` 404，随即以原来的 `file:` spec 重装，插件仍在
`dsh.profile.bundles` 里、spec 原样、文件重新落地。

## 🧹 顺带：删掉不再需要的 app.asar staging 机制

原先「捆绑插件」不能按 app.asar 内路径安装（子进程 pnpm 会把 app.asar 当普通文件，
报 *as it does not exist*），所以主进程要先把插件复制成磁盘上的真实目录再装。插件走
registry 之后**没有任何目录条目需要 `file:` 安装**，这套机制整体删除：

- `src/plugin-manager.js`：`bundledPluginsRoot` / `bundledSourceDir` / `copyDirRecursive` /
  `stageBundledPlugin` / `readPackageVersion` / `installedBundleVersion`，以及
  `syncEnabledPlugins` 里「随包版本更新则强制重装」的分支；
- `src/main.js`：`pluginBundledPluginsDir()` 与 `shortPathIfSpaced()`（后者只为 staging
  路径的 8.3 短化而存在）；
- `electron-builder.yml`：`plugins/**/*` 不再打进 app.asar。

`pluginHasClientHalf` 改为「已装读真实 manifest、未装用目录条目的 `client` 声明」——
拆仓后本地没有源码可读，而「是否含页面半边」决定启用/禁用后要不要刷新页面，必须
在安装前就能显示。目录条目因此新增 `client: true|false` 字段。

> 注：`<home>\.dsh-gui\bundled-plugins` 目录本身**不会被自动删除**。它与旧版 profile 的
> `file:` 依赖一一对应，而同一台机器上可能存在多个 DSH_HOME（本 GUI 的 `dsh-home` 与
> 系统 `~/.dsh`），删掉它可能让某个还没迁移过的 profile 直接启动失败。迁移完成后它只是
> 占几 MB 空间，可以自行清理。


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
