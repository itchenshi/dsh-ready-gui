# DSH GUI

> DeepSeek Harness 桌面壳 —— 内嵌 Web UI、自动保持最新引擎、自带数据目录管理与系统托盘。

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)
[![license](https://img.shields.io/github/license/itchenshi/DeepSeekHarnessGUI)](LICENSE)
[![release](https://img.shields.io/github/v/release/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/releases)
[![stars](https://img.shields.io/github/stars/itchenshi/DeepSeekHarnessGUI)](https://github.com/itchenshi/DeepSeekHarnessGUI/stargazers)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![GitHub](https://img.shields.io/badge/GitHub-host-blue)](https://github.com/itchenshi/DeepSeekHarnessGUI)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-red)](https://gitee.com/itchenshi/DeepSeekHarnessGUI)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-green)](https://gitcode.com/itchenshi/DeepSeekHarnessGUI)

DSH GUI 是 [DeepSeek Harness](https://www.deepseek.com/harness/)（开源 Agent 框架，
`@deepseek-ai/dsh`）的非官方桌面外壳。它把 Harness 的 Web UI 装进原生窗口中，
开箱即用、常驻托盘、自动更新，而你依然拥有完整的 Harness 能力。

```
┌────────────────────────────────────────────┐
│  DSH GUI (Electron App Shell)             │
│  ├─ 内嵌窗口 (嵌入 dsh web 的 Harness UI)   │
│  ├─ 系统托盘 (打开窗口 / GUI 更新 / 设置)    │
│  ├─ 引擎更新 (每 30 分钟 + 三档策略)        │
│  └─ 数据目录 (默认 ~/.dsh，可切换并迁移)     │
└────────────────────────────────────────────┘
```

## 🔗 多平台仓库

| 平台 | 地址 | 克隆 |
|---|---|---|
| GitHub（主仓库） | https://github.com/itchenshi/DeepSeekHarnessGUI | `git clone https://github.com/itchenshi/DeepSeekHarnessGUI.git` |
| Gitee（镜像） | https://gitee.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitee.com/itchenshi/DeepSeekHarnessGUI.git` |
| GitCode（镜像） | https://gitcode.com/itchenshi/DeepSeekHarnessGUI | `git clone https://gitcode.com/itchenshi/DeepSeekHarnessGUI.git` |

三平台仓库互为镜像；安装包以 [GitHub Releases](https://github.com/itchenshi/DeepSeekHarnessGUI/releases) 为准。

## 🆕 v0.4.0 亮点

- **🔧 两个 OpenCode 插件合并为「OpenCode Go 增强」**（`dsh-opencode-go`）：一个插件同时**声明 `opencode-go` 路由协议**
  （修掉目录外模型的 `needs an api` 报错）、**自动补 DeepSeek V4.1 模型**（如 `deepseek-v4.1-flash`）、
  并**附加按会话 `x-opencode-session` 头**（修复 400 MissingSessionID）。装过旧插件的用户首次启动自动迁移。
- **📊 用量插件显示选中模型的每月额度上限**：会话标题右侧在「滚动 / 周 / 月」后显示 `上限 $60` 一类的标签，
  悬停可看该模型的 5 小时 / 周 / 每月三段额度。官方没有额度接口，插件会**自动抓取官方文档页更新额度表**
  （公开页、无需密钥），失败回退缓存 → 内建表。
- **⚠️ 达到每月上限会标红提示**（上游返回 `rate-limited` 时），并给出重置时间。
- **🎛 设置窗口的插件区更清爽**：标题成行、描述最多两行省略，全部插件描述精简为一句。

完整改动见 [CHANGELOG.md](CHANGELOG.md) 与 [RELEASE-NOTES-v0.4.0.md](RELEASE-NOTES-v0.4.0.md)。

## 📸 界面预览

| 主窗口 | 设置窗口 |
|---|---|
| ![主窗口](screenshots/主窗口.png) | ![设置窗口](screenshots/设置.png) |

**模型用量与余量**（会话标题右侧，按当前模型自动切换）：用 OpenCode Go 模型时显示套餐用量，用 DeepSeek 模型时显示账户余额。

| OpenCode Go 用量 | DeepSeek 余额 |
|---|---|
| ![OpenCode Go 用量](screenshots/模型OpenCodeGo余量.png) | ![DeepSeek 余额](screenshots/模型DeepSeek余量.png) |

| DSH 设置弹窗 |
|---|
| ![DSH 设置弹窗](screenshots/DSH设置.png) |

---

## ✨ 功能总览（按分类）

### 🪟 桌面窗口与系统托盘

- **内嵌窗口**：壳进程启动 `dsh web --no-open --port 0`，解析 stdout 中的带认证
  loopback URL，加载到内嵌 Electron 窗口。不依赖外部浏览器。
- **主窗口启动即最大化**，隐藏时无普通尺寸闪烁。
- **系统托盘**：右键菜单「打开窗口 / 检查 DSH GUI 更新… / 设置 / 退出」；
  关闭窗口默认**隐藏到托盘**，也可设「直接退出」（退出时托盘一并移除）。
- **窗口标题显示应用版本**：标题为 `DSH GUI v<应用版本>`；托盘提示同时给出
  GUI 版本与引擎版本。

### ⚡ 引擎生命周期管理

- **每次都用最新版 Harness**：启动时与运行中按**固定间隔 30 分钟**检查 npm
  registry 的版本表（更新频率不可调），发现新版按策略处理：**询问后再更新
  （默认）/ 静默更新 / 仅提示**；更新安装到应用私有目录，完成后右下角弹出
  **持久角标**。
- **GUI 与引擎更新分家**：托盘「检查 DSH GUI 更新…」查 GitHub Releases，
  有新版本时打开下载页；引擎更新由 GUI 后台按设置策略自动处理。
- **GUI 托管的引擎重启**：dsh 由 DSH GUI 作为子进程托管，页面/插件内建的
  “重启”无法重启它。需要重启使插件（或引擎自身）生效时，用设置窗口「重启
  引擎使生效」、页面桥 `window.__dshGui.restartEngine()`，或直接重启 DSH GUI；
  引擎就绪后意外退出时 GUI 会自动重拉（连续 3 次仍失败则停止并提示）。
- **第三方插件引起的启动失败自动恢复**：刚自动安装的插件若导致 dsh 无法启动，
  会自动剔除并取消勾选；疑似插件导致的失败会弹出诊断对话框，可一键禁用并重启。

### 🔌 第三方插件管理

插件有**两个正交状态**，设置窗口两个控件各管一个，且都与 Harness 页面的插件市场实时互相同步：

- **①「安装」勾选框 = 安装/卸载状态实时镜像**。装了即勾、没装即不勾，
  勾选**立即安装**、取消**立即卸载**（与插件市场同一套 `dsh plugin` 机制，从
  profile 移除、保留本地文件），不再持久化勾选状态。
- **②「启用」开关 = 加载/禁用状态实时镜像**（v0.3.0 新增）。关掉**不卸载**，
  只是让引擎不加载它（文件与登记都保留）；开启即恢复加载。
  **走的是插件市场自己的开关接口**（`POST <引擎>/dsh-market/toggle`，与市场页面上
  那个开关完全同一条路径），所以在线生效时机、保护规则、`restart` / `refresh`
  信号都与市场一致：
  - 引擎侧**立即生效**（市场用 loader 句柄在线切换，不需要重启）；
  - 带**客户端半体**的插件（如模型用量与余量）禁用后，页面里已加载的那半不会
    自己消失——市场为此返回 `refresh: true` 并提示「刷新后生效」，设置窗口同样会
    出现「**刷新页面**」按钮，点它就与引擎实际组合对齐；
  - 市场拒绝的情况原样上报（宿主基础设施禁止开关、市场自身不可关、未安装），
    不会绕过它的保护去写文件；
  - 市场不可用时（未安装 / 引擎没跑 / 老版本没有该路由）自动回退到直接写 profile
    补丁层 `cordis.patch.yml` 的 `- id: <rowId>` + `disabled: true|false` 行并同步
    市场 `.dsh-market/state.json`——在 `patchReload: live` 的 web profile 上同样由
    引擎在线重组合（实测 ~0.7s 生效），只是缺少 `restart`/`refresh` 信号。
- **与插件市场实时联动**：设置窗口同时 watch `profiles/web/package.json`、
  `cordis.patch.yml` 与 `.dsh-market/state.json`（市场开关改的就是这三处）。
  任一变化都会重算状态指纹并广播给设置窗口，两个控件按真实状态重绘；市场里
  禁用/启用后设置窗口立即显示为「已禁用（插件市场）／已启用」。
- **状态不一致会自动对账**：若市场已禁用某插件、但禁用行还没写进 profile 补丁层
  （此时引擎其实仍会加载它），启动维护与「修复 / 重试」会把它补写成真正的禁用，
  设置窗口同时显示一行提示说明原因。
- **启动维护对账**：只针对已安装的目录插件——捆绑插件随包更新时重装；已装但对
  当前引擎不兼容的目录插件（会让 profile 启动崩溃）先移除；不动用户手动装的
  额外 bundle。
- **「修复 / 重试」按钮**：以当前已安装集合为目标再对账（补拉捆绑插件更新），
  只增不删，可作安装失败后的重试；同时对齐启用/禁用状态。
- **内置候选目录（经核实的社区插件）**：插件市场（dsh-market）、最近会话恢复
  （dsh-gui-last-session）、模型用量与余量（dsh-model-usage）、OpenCode Go 增强
  （dsh-opencode-go）。设置窗口展示顺序即此顺序。
- **`dsh-opencode-go`（OpenCode Go 增强）**：一站解决 OpenCode / OpenCode Go 路由的三件事——
  ① 给 `opencode-go` 路由声明 wire 协议（`api: openai-completions`），修掉目录外模型
  （如 `deepseek-v4.1-flash`）的 `needs an api` 报错与模型页保存被拒；② 引擎启动后若该路由存在
  且缺 `deepseek-v4.1-*`，自动补上 DeepSeek V4.1 模型（幂等，写在 `settings.yaml`）；③ 为发往
  OpenCode 的请求附加稳定的按会话 `x-opencode-session` 头（修复 400 MissingSessionID，默认不透明
  UUID，绝不发内部会话 ID）。**该插件合并自原 `dsh-opencode-go-session` 与 `dsh-opencode-go-api`**——
  升级时 GUI 会自动摘除旧包并装上新版（连"已禁用"的选择一起搬过去），不会新旧两版同时加载。
- **`dsh-model-usage`（模型用量与余量）**：在会话标题右侧显示**当前模型**的用量/余量，
  按会话当前选中的模型路由分流（仅在使用对应模型时出现）：
  - OpenCode Go 模型（`opencode-go` / `opencode`）→ 套餐用量（滚动 / 周 / 月 百分比 + 重置时间），
    宿主侧经 `ctx.credentials` 取 `OPENCODE_GO_API_KEY` 调 `GET https://opencode.ai/zen/go/v1/usage`；
  - DeepSeek 模型（路由 `deepseek-official`）→ **账户余额**（总 / 赠送 / 充值，`is_available:false` 显示
    「余额不足」），取 `DEEPSEEK_API_KEY` 调 `GET https://api.deepseek.com/user/balance`。
  两条上游都在宿主侧完成，密钥绝不下发浏览器；页内按 `ctx.modelDirectories` 的 `current.provider`
  决定显示哪一段。**该插件原为 `dsh-opencode-go-usage`（只管 OpenCode Go），加入 DeepSeek 余额后更名**——
  升级时 GUI 会自动摘除旧包并装上新版（连"已禁用"的选择一起搬过去），不会新旧两版同时加载。
- **卸载**：设置窗口取消勾选、dsh-market 或 `dsh plugin remove` 均可（同一机制）。
- **安全提示（设置页原文）**：第三方插件等于以你的权限运行第三方代码——
  默认关闭，勾选前请自行审阅源码。

### 🔐 数据、凭证与隐私

- **数据目录可控**：默认跟随系统 `~/.dsh`，可切换为应用目录（`<userData>/dsh-home`）；
  切换时自动检测源目录数据并询问是否**移动**（停引擎 → 迁移 → 按新目录重启）。
- **每次启动都是新的**：内嵌窗口使用内存会话（cookies/登录态不落盘），每次
  启动全新 spawn dsh 子进程，退出时连进程树一起清理。
- **会话历史保留**：`<DSH_HOME>/sessions/` 下的会话数据、`storages/` 工作区
  记录均在用户数据目录内，随数据目录迁移。

### 🌐 多语言与外观

- **语言在 Harness 页面里选，外壳跟着走**：设置窗口**没有**独立的语言/外观栏（v0.3.0 起移除，
  统一到引擎侧）——在 Harness 页面的设置里改语言（跟随系统 / 中文 / English）或主题
  （light / dark / system），DSH GUI 外壳（设置窗口、托盘菜单、对话框、窗口主题）**实时跟随**，无需重启。
- **跟随系统时的解析顺序**：`locale: system`（默认）时优先跟随引擎设置文件
  `$DSH_HOME/settings.yaml` 里的 `locale.preference`（即 Harness 页面用的那个），其次才按 Electron 系统语言解析。
- **热发布**：主进程 watch `settings.yaml`，页面上改完立刻生效；GUI 自己写回的值因相等自动跳过，不会循环。
- **主题一张皮**：`appearance: engine`（默认）时窗口主题跟 Harness 的 `ui-theme.preference` 一致，
  不会出现页面深色、外壳浅色。

### 💬 会话体验

- **启动后自动回到最近一次对话**：记录最后使用的会话，重启 DeepSeek Harness
  后自动切回（由内置插件 `dsh-gui-last-session` 实现，默认开启）。

### 🎛 设置与持久化

- **模态设置窗口**：设置窗打开期间主窗口不可操作、不可关闭；可从菜单
  `设置 → 打开设置窗口…`（模态）或托盘「设置」进入。
- **设置持久化**：`<userData>/settings.json`，修改即保存。

---

## ⚙️ 设置项（按功能分类）

### 引擎更新

| 设置项 | 默认 | 说明 |
|---|---|---|
| 引擎更新策略 | **询问后再更新** | 静默更新 / 询问后再更新 / 仅提示不自动更新 |
| 版本通道 | **npm latest** | 跟随 npm `latest` 标签；另有“跳过 alpha”“含全部预发布” |
| 自动检查 | 开 | 关闭后不查询 registry，直接用本地引擎（首次无引擎仍做一次性安装） |
| 检查间隔 | **固定 30 分钟** | 不可调整；可随时点「立即检查引擎更新」 |

### 第三方插件

| 设置项 | 默认 | 说明 |
|---|---|---|
| 安装勾选框 | **跟随实际状态** | 不持久化「期望」集合：装了即勾、没装即不勾；勾选立即安装、取消立即卸载 |
| 启用开关 | **跟随实际状态** | 仅对已安装插件显示；关掉不卸载，只是引擎不加载它；与 Harness 插件市场双向实时同步 |

> 旧版 `settings.json` 里的 `autoPlugins` 字段自 v0.3.0 起**废弃**（残留值不再参与任何逻辑）。

### 数据与桌面

| 设置项 | 默认 | 说明 |
|---|---|---|
| 数据目录 | **跟随系统 ~/.dsh** | 切换时若源目录有数据会询问是否移动 |
| 关闭窗口 | **隐藏到托盘** | 另一选项为“直接退出”（关窗即退出，移除托盘） |
| 自动回到最近对话 | **开** | 重启后自动切回上次使用的会话 |

### 语言与外观

> **不在 DSH GUI 设置窗口里改**：v0.3.0 起已移除「语言」「外观」两栏，统一在
> **Harness 页面（引擎设置）** 修改，外壳实时跟随（见上文「多语言与外观」）。
> 设置窗口只保留：关闭窗口行为、数据目录、引擎更新、第三方插件。

> 设置持久化于 `<userData>/settings.json`，修改即保存；GUI 设置窗口可从菜单
> `设置 → 打开设置窗口…`（模态）或托盘「设置」进入。

---

## 🚀 快速开始

前置（**仅开发/源码运行需要**）：已安装 [Node.js](https://nodejs.org/) **≥ 23**
（DeepSeek Harness 引擎依赖 Node 23+ 的 zstd API；含 npm）。打包产物自带便携
Node，终端用户无需安装任何运行时。

```sh
npm install        # 安装 electron / 构建依赖
npm start          # 启动 DSH GUI
```

首次启动会自动联网安装 DeepSeek Harness 引擎（约 1–2 分钟，状态页有进度）；
之后只有 Harness 发布新版本时才需要再次安装。

---

## 📦 架构与数据

```
启动
 └─ 单实例锁 → 读 settings.json → 读 Harness 外观(ui-theme.preference)
     → 建窗口(最大化,内存会话)
         └─ boot()
             ├─ 解析 Node：捆绑便携版 → $DSH_SHELL_NODE → 系统 PATH
             ├─ 需要时检查更新(npm registry) → 按策略安装/提示
             ├─ 启动前：对账已安装的目录插件（补拉捆绑插件更新；不改用户手动装的）
             ├─ 清理已改名的旧插件（摘 bundle + dependencies，避免新旧两版同时加载）
             ├─ spawn node <engine>/lib/bin.js web --no-open --port 0
             ├─ 解析 stdout 的 `dsh web: <url>` → 内嵌加载
             └─ 退出：kill 进程树 + 销毁托盘
```

DeepSeek Harness 的全部用户数据都在 `$DSH_HOME`（默认 `~/.dsh`）下：

| 内容 | 路径 |
|---|---|
| 模型 / 系统 / 插件设置 | `<DSH_HOME>/settings.yaml`（含 `ui-theme.preference`） |
| 会话历史 | `<DSH_HOME>/sessions/<编码项目路径>/<会话id>/session.jsonl.zstd` |
| 工作区记录 | `<DSH_HOME>/storages/`（工作区业务文件仍在真实目录） |
| profile 配置与覆盖层 | `<DSH_HOME>/profiles/web/...` |
| 凭证 / 附件 / 匿名 ID | `<DSH_HOME>/credentials…` 等 |

### 目录结构

```
├─ src/                   # 应用源码（main 进程 / 页面 / 工具模块）
│  ├─ main.js             # 主进程：更新引擎、窗口、托盘、设置、数据迁移
│  ├─ plugin-manager.js   # 第三方插件管理（catalog + dsh plugin 安装对账）
│  ├─ engine-patch.js     # 对引擎客户端的小补丁（幂等；“重启回最近会话”页内逻辑）
│  ├─ preload.js          # 设置窗口 IPC 桥
│  ├─ workspace-preload.js# 主窗口窄桥（记录/读取最近一次会话）
│  ├─ settings.html       # 设置窗口（模态）
│  ├─ status.html         # 启动/更新状态页（跟随 Harness 主题）
│  ├─ notice.html         # 持久更新角标
│  └─ home-migrate.js     # 数据目录检测与迁移（纯 Node，可单测）
├─ plugins/               # 仓库内置的本地插件（打包进 app.asar）
│  ├─ dsh-model-usage/           # 模型用量与余量（OpenCode Go 用量 + DeepSeek 余额）
│  ├─ dsh-gui-last-session/      # 启动后回到最近一次对话
│  └─ dsh-opencode-go/           # OpenCode Go 增强（协议声明 + V4.1 模型 + 会话头）
├─ scripts/               # 构建与测试脚本
│  ├─ make-icons.mjs      # 官网 favicon → 各尺寸图标 + win 用的混合帧 icon.ico
│  ├─ ico-info.cjs        # 检查任意 .ico 的帧构成与长度自洽性
│  ├─ exe-icon-info.cjs   # 检查 exe 内嵌图标资源（RT_ICON / RT_GROUP_ICON）
│  ├─ bundle-node.mjs     # 便携 Node 下载/解包（幂等 + 归档缓存）
│  ├─ ensure-electron.mjs # electron 发行 zip 本地缓存（SHA-256 校验）
│  ├─ fix-unpacked.mjs    # 改名 + 生成 zip
│  ├─ after-pack.js       # electron-builder 钩子：完整拷贝捆绑 Node
│  ├─ push-all.ps1        # 推送分支+tags 到三平台
│  ├─ publish-all.ps1     # 构建 + 三平台 Releases 发布
│  └─ smoke-*.ps1         # Windows E2E 冒烟
├─ marketing/            # 营销物料（按版本分目录 v0.1.0 / v0.2.0 / v0.3.0 / …）
│  └─ v0.3.0/            # CSDN/知乎/掘金/少数派文章、推广文案包、B 站视频脚本
├─ resources/icons/       # 官网 favicon 源文件（svg/ico）
├─ electron-builder.yml   # 打包配置（win/mac/linux）
└─ dist/                  # 构建产物（已 gitignore）
```

---

## 🔧 环境变量（可选）

| 变量 | 作用 |
|---|---|
| `DSH_SHELL_NODE` | 指定运行引擎的 node 可执行文件（默认优先捆绑 Node） |
| `DSH_SHELL_HOME` | 覆盖本次启动的 `DSH_HOME`（测试隔离用） |
| `DSH_SHELL_USERDATA` | 重定向整个 userData（引擎/设置/npm 缓存） |
| `DSH_SHELL_REGISTRY_URL` | 版本检查源（完整 packument 地址，如 `https://registry.npmmirror.com/@deepseek-ai/dsh`） |
| `DSH_SHELL_AUTOQUIT_MS` | UI 加载成功后 N 毫秒优雅退出（CI / 冒烟测试） |
| `DSH_SHELL_TEST_LATEST` / `DSH_SHELL_TEST_NOTICE` / `DSH_SHELL_TEST_OPEN_SETTINGS` | 测试钩子 |
| `DSH_SHELL_TEST_AUTODISABLE` | =1 时跳过「启动失败自动禁用插件」钩子（测试用） |
| `DSH_SHELL_TEST_BREAK_PLUGIN` | 设置后强制制造插件启动失败，用于验证失败自动剔除/诊断流程（测试用） |
| `DSH_SHELL_PAGE_DEBUG` | =1 时把内嵌页面 console 转发到主进程日志，并输出页面桥探针结果（调试用） |
| `DSH_NODE_VERSION` / `DSH_NODE_MIRROR` | 打包时捆绑的 Node 版本与下载镜像 |
| `DSH_NODE_ARCH` / `DSH_NODE_PLATFORM` | 覆盖捆绑 Node 的目标平台/架构（如 CI 在 Apple Silicon 上交叉打包 x64 macOS 应用时设 `DSH_NODE_ARCH=x64`） |

---

## 🛠 打包

### 打包

```sh
npm run make-icons    # 渲染各尺寸图标（build/、src/；生成 win 用的 build/icon.ico：
                      #   白底 + 品牌蓝字形，多尺寸混合帧）
npm run bundle:node   # 便携 Node 就位检查（幂等：版本/平台一致直接跳过；
                      #   压缩包缓存于 resources/.node-cache/，删了 node 目录也零下载；
                      #   加 --force 强制重新下载）
npm run ensure:electron # electron 发行 zip 本地缓存（首次下载并 SHA-256 校验，
                      #   之后 dist:win 直接喂给 electron-builder，零网络）
npm run dist:win      # Windows → dist/DSH-GUI-WIN/ + .zip + NSIS 安装包 + 便携 zip
                      #   （electron 走本地缓存 zip，不再每轮 Downloading）
npm run dist          # 合并构建 win + linux（注意平台限制，见下）
npm run dist:mac      # macOS   → dist/DSH-GUI-MAC/ + .zip + .dmg（需 macOS）
npm run dist:linux    # Linux   → dist/DSH-GUI-LINUX/ + .zip + .AppImage
```

> 改完图标记得**重新安装/复制构建产物**：Windows 资源管理器会缓存旧图标，
> 重装或新建快捷方式后若仍显示旧的，重启资源管理器（或删
> `%LocalAppData%\IconCache.db`）即可。可用 `node scripts/ico-info.cjs build/icon.ico`
> 检查 .ico 的帧构成。

- **程序目录命名**：electron-builder 的 `*-unpacked` 目录由
  `scripts/fix-unpacked.mjs` 改名为 `DSH-GUI-WIN` / `DSH-GUI-MAC` /
  `DSH-GUI-LINUX`，并同步生成同名 **`.zip`**（解压即程序目录）。
- **捆绑 Node**：由 `scripts/bundle-node.mjs` 按平台下载（默认 v26；引擎的会话
  持久化需要 Node ≥ 23 的 zstd API），`scripts/after-pack.js` 在封包前完整拷入
  应用（不能用 `extraResources`——它会丢弃 `node_modules`，导致捆绑 Node 缺 npm）。
  npm 安装引擎时若捆绑 Node 无 npm，会自动回退到宿主 Node 的 npm-cli。
- **平台限制**：AppImage 的 `mksquashfs` 仅 Linux/macOS 可执行，所以在 Windows 上
  运行 `npm run dist` 时 linux 步骤会报 `ENOENT`；请在对应平台或 CI/Docker
  （如 `electronuserland/builder`）中构建各平台产物。

---

## 🧪 测试

```sh
npm start                                   # 运行应用
npm test                                    # 全部单测（含设置窗口内联 JS 语法/结构校验）
npm run test:e2e                            # Windows 端到端（需先关闭正在运行的实例）
# 分开跑：
node src/test/engine-patch.test.cjs         # 引擎补丁工具纯函数单测
node src/test/plugin-state.test.cjs         # 插件状态指纹（含启用/禁用维度）
node src/test/plugin-enable.test.cjs        # 启用/禁用：补丁层读写、市场同步、BOM、占位符
node src/test/settings-ui.test.cjs          # 设置项/主题映射
node src/test/plugin-manager.test.cjs       # profile 自愈/清理
node scripts/check-settings-html.cjs        # 设置窗口内联 JS 语法 + 插件行结构约束
# Windows 端到端：
powershell -File scripts/smoke-close.ps1 -Mode quit   # “直接退出”模式
powershell -File scripts/smoke-close.ps1 -Mode tray   # “隐藏到托盘”模式
powershell -File scripts/smoke-modal.ps1              # 模态设置窗
powershell -File scripts/smoke-profile-watch.ps1      # 插件市场禁用 → 设置窗口实时联动
powershell -File scripts/smoke-plugin-enable.ps1      # 启用/禁用 ↔ 补丁层 + 市场 state.json 双向同步
```

---

## ❓ 常见问题

- **首次启动较慢 / 状态页显示“正在下载并安装…”**：正在自动安装 DeepSeek Harness
  引擎，仅首次发生。
- **`npm run dist` 在 Windows 上报 `mksquashfs ENOENT`**：AppImage 只能在
  Linux/macOS（或 Docker/CI）构建，见「打包 → 平台限制」。
- **数据目录切换后看不到原来的会话**：切换时若源目录有数据会询问是否移动；
  选“仅切换”时数据保留在原位置。
- **切换语言后部分界面没变**：语言是在 **Harness 页面（引擎设置）** 里改的（v0.3.0 起
  设置窗口不再提供语言栏）；改完写入引擎 `settings.yaml` 的 `locale.preference`，
  外壳（设置窗口 / 托盘菜单 / 对话框）经文件 watch 实时跟随，内嵌 Harness 页面也会
  热发布即时切换。若页面未立即刷新，稍等片刻或重启应用即可。
- **想让配置/会话完全随应用目录走**：在设置中把数据目录切到“应用目录”，
  并确认迁移完成；备份/迁移/删除整包即可。
- **与官方 CLI 的关系**：本壳只是启动器/外壳，运行的仍是官方
  `@deepseek-ai/dsh`；任何 Harness 能力问题请参考 [DeepSeek Harness 文档](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)。

---

## 🏷 推荐 Topics（仓库元数据，已同步勾选于 GitHub「Settings → Topics」）

`deepseek` · `deepseek-harness` · `electron` · `ai-agent` · `agent-framework` · `desktop-app` · `cross-platform` · `automation`

## 📄 许可

[MIT](LICENSE) · 本项目为独立开源外壳，与 DeepSeek Harness 官方项目无隶属关系；
DeepSeek Harness 本身为 [MIT](https://github.com/deepseek-ai/deepseek-harness) 许可。