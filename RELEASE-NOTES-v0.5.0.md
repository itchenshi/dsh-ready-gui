# 🚀 DSH Ready GUI v0.5.0

> DeepSeek Harness 桌面壳 —— 内嵌 Web UI、自动保持最新引擎、自带数据目录管理与系统托盘。

**发布说明：** 这一版做两件事：**应用改名为 DSH Ready GUI**，以及**四个随附插件回到内置**。

改名是为了能被找到。旧名字 `DeepSeekHarnessGUI` 与别人的 `ScannerVpn/DeepSeekHarnessGui` 只差一个
大小写，GitHub 搜索视为同一个名字，而对方的星数是旧仓库的两倍——搜这个关键词的人先看到的是别人；
`dsh-gui` 也已被四个别人的仓库占用。新名字 `dsh-ready-gui` 三项实测全零：npm 空闲、GitHub 无同名
仓库、DSH 生态注册表（4000+ 条目）里没有占用。「ready」对应这个项目的定位——**打开就用**。

插件回到内置，是因为「从 npm 安装」这条路暂时走不通：四个插件原计划拆出去发布到 npm、壳改成像
`dsh-market` 那样从 registry 安装（好处是插件更新不必等壳发版，任何 DSH 宿主都能装）。但 npm 账号
注册目前拿不到，包发布不出去；而 profile 里登记着一个 registry 上不存在的包，会让插件直接从引擎的
加载列表里消失，并且让这个 profile 里**每一次**安装操作一起失败——两条都在本机实测到了。所以这一版
保持内置，四个独立仓库先留着，等发布渠道通了再切。

---

## 🏷 改名：DSH GUI → DSH Ready GUI

| 项 | 旧 | 新 |
|---|---|---|
| 应用显示名 | `DSH GUI` | `DSH Ready GUI` |
| 应用身份 `appId` | `com.dsh.guishell` | `com.dshready.gui` |
| 仓库名（三平台） | `DeepSeekHarnessGUI` | `dsh-ready-gui` |
| 包名 | `dsh-gui-shell` | `dsh-ready-gui` |
| 构建产物 | `DSH-GUI-WIN/MAC/LINUX` | `DSH-READY-GUI-WIN/MAC/LINUX` |

### ⚠️ 装新版前请先做一件事

`appId` 变了，操作系统会把它当成**另一个应用**：新版不会覆盖旧安装。而 Electron 的数据目录由应用名
推导（`<appData>\DSH GUI` → `<appData>\DSH Ready GUI`），引擎、`dsh-home`、设置、会话记录全在里面。

启动新版时会在**任何代码读取数据目录之前**做一次性迁移：把旧目录里「新目录还没有」的条目搬过去，
只 rename、绝不删除，迁移失败也不会让应用起不来（最坏情况是当作全新安装）。**建议：先启动一次新版
完成迁移、确认一切正常，再卸载旧版「DSH GUI」。**

## 📦 四个随附插件仍然内置

模型余量、会话续接、OpenCode Go 路由、按键设置**继续随应用打包**（源码在 `plugins/`），装上 GUI
就有，安装/卸载/启用都在设置窗口里完成，不需要自己 `dsh plugin add`。它们各自也有独立仓库，包名与
仓库名一一对应：

| 插件 | 包名 | 仓库 |
|---|---|---|
| 模型余量 | `dsh-model-surplus` | https://github.com/itchenshi/dsh-model-surplus |
| 会话续接 | `dsh-gui-last-session` | https://github.com/itchenshi/dsh-gui-last-session |
| OpenCode Go 路由 | `dsh-opencode-go-path` | https://github.com/itchenshi/dsh-opencode-go-path |
| 按键设置 | `dsh-keys-setting` | https://github.com/itchenshi/dsh-keys-setting |

### 三个包名变了（功能不变）

`dsh-opencode-go` → **`dsh-opencode-go-path`**、`dsh-composer-keys` → **`dsh-keys-setting`**（这两个
原名在 npm 上已被其他作者占用）、`dsh-model-usage` → **`dsh-model-surplus`**（名字虽然空着，但
GitHub 上已有三个别人的同名仓库，其中两个的 `package.json` 也写着它）。

**老用户不需要手动做任何事**：启动维护会摘掉旧包名的登记、清掉补丁层残留行，并把「已禁用」的选择
搬到新包上，不会新旧两份同时加载。**补丁层行 id 与设置命名空间保持原样**（`composer-keys` /
`model-usage`），所以你保存的键位和启用/禁用选择都不会因为改包名而失效。

### 安装来源不对的插件会自动修好

内置条目的「正版」只有一份：随壳打包、启动时 staging 出来的
`<home>\.dsh-gui\bundled-plugins\<包名>`。profile 里的依赖只要指向别处（开发用的 checkout、npm 或
git 安装、旧 staging 目录），启动维护就换回随包那一份；换不回来时把原来那份装回去，**不会把插件
弄丢**。这里有个实测得出的顺序要求：**先把所有来源不对的登记一起摘掉，再统一安装**——否则只要
profile 里留着一条解析不了的 `file:` 依赖，接下来每次 pnpm 调用都会整体失败，连累的正是我们想修的
那个插件。同理，摘登记之前会先确认随包那份能 staging 出来，staging 失败就什么都不动。

## 🧪 这一版是怎么验证的

`npm run verify:builtin` 会真的装插件、真的启动引擎：在一个临时数据目录里伪造出「三个插件登记在
某个已消失的 checkout 上、第四个缺失」，然后检查它们全部被换回随包那一份、缺失的那个能装上、
第二次启动不再重复安装、引擎带着四个插件正常起来（共 17 项检查）。它还守住「staging 失败时不许
动 profile」这条底线。

---

## ⬆️ 升级说明

- **先启动一次新版完成数据目录迁移，再卸载旧版**（见上）。
- 无配置迁移、无需手动操作；数据目录、模型配置、会话历史原样保留。
- 旧包名的插件会被自动清理并换成新包名，不会新旧两份同时加载。

## 📦 下载

- GitHub（安装包在这里）：https://github.com/itchenshi/dsh-ready-gui/releases/latest
- Gitee（国内推荐）：https://gitee.com/itchenshi/dsh-ready-gui/releases
- GitCode（国内备用）：https://gitcode.com/itchenshi/dsh-ready-gui/releases
