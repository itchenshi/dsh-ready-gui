# DSH Ready GUI

DeepSeek Harness（`@deepseek-ai/dsh`）的桌面外壳：它自己安装、自己更新引擎，并把引擎的网页界面嵌进一个原生窗口。当前版本 **0.8.0**。

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)
[![license](https://img.shields.io/github/license/itchenshi/dsh-ready-gui)](LICENSE)
[![release](https://img.shields.io/github/v/release/itchenshi/dsh-ready-gui)](https://github.com/itchenshi/dsh-ready-gui/releases)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()
[![GitHub](https://img.shields.io/badge/GitHub-host-blue)](https://github.com/itchenshi/dsh-ready-gui)
[![Gitee](https://img.shields.io/badge/Gitee-mirror-red)](https://gitee.com/itchenshi/dsh-ready-gui)
[![GitCode](https://img.shields.io/badge/GitCode-mirror-green)](https://gitcode.com/itchenshi/dsh-ready-gui)

## 它做什么

- **打开就是界面**：不用命令行，也不打开系统浏览器；外壳启动引擎，把它的页面直接嵌在窗口里。
- **引擎自动更新**：启动时和运行中每 30 分钟检查一次，按你选的策略静默更新 / 询问（默认）/ 仅提示；DSH Ready GUI 自己有新版也会提示。
- **数据目录可选**：默认跟随系统 `~/.dsh`，也可以改成随应用携带；切换时问你要不要把数据一起搬走。
- **四个内置插件**：随包携带，设置窗口里勾选即装；首次启动会主动弹出「一键开启」卡片。
- **托盘与关窗行为**：关闭窗口默认隐藏到托盘（托盘里可以打开窗口 / 设置 / 退出），也可以设为直接退出。
- **可以多开**：每个实例一个窗口和一份自己的引擎进程，互不干扰。

## 安装

**Windows（实际用过的就是它）** —— 到 [GitHub Releases](https://github.com/itchenshi/dsh-ready-gui/releases) 下载：

- `DSH.Ready.GUI.Setup.<版本>.exe` —— 安装包，安装时可以自己选目录；
- `DSH.Ready.GUI-<版本>-win.zip` —— 便携版，解压即用。

**macOS / Linux（CI 产出，没有在真机验证过）** —— 同一个页面有 `DSH.Ready.GUI-<版本>.dmg`（arm64 / x64）和 `DSH.Ready.GUI-<版本>.AppImage`。这些产物由 GitHub Actions 打包，我们没有在真机上跑过，**不保证能用**；macOS 包没有签名，Gatekeeper 可能会直接拦下。

**安装包只在 GitHub 发**：[Gitee](https://gitee.com/itchenshi/dsh-ready-gui) 和 [GitCode](https://gitcode.com/itchenshi/dsh-ready-gui) 是代码镜像，它们的 Release 里只有源码包。

**从源码跑**（只有开发需要）：装 [Node.js](https://nodejs.org/) ≥ 23，然后

```sh
npm install
npm start
```

打包产物自带便携 Node，终端用户不需要装任何运行时。

## 首次启动

1. 启动时先读引擎里的语言 / 主题，再打开窗口；装引擎期间状态页显示进度。
2. 第一次运行要把引擎装下来：外壳用随包的便携 Node，从 npm registry 下载 `@deepseek-ai/dsh`，装进应用数据目录的 `dsh-engine/`（Windows 上是 `%APPDATA%\DSH Ready GUI\dsh-engine`），装完自动加载界面。
3. 引擎的数据默认放在系统 `~/.dsh`（`$DSH_HOME`），也可以在设置里改成「应用目录」（Windows 上是 `%APPDATA%\DSH Ready GUI\dsh-home`）。切换时如果源目录里有数据，会问「迁移并切换 / 只切换，不迁移 / 取消」。
4. 内置插件默认**不装**。引擎起来后如果发现该装的没装，外壳会自己打开设置窗口，最上方是「一键开启」卡片：点一次装齐，并自动重启一次引擎；点「不用了，我自己选」则一个都不装，之后不再主动弹。
5. 外壳自己的偏好（关窗行为、数据目录、更新策略）存在 `%APPDATA%\DSH Ready GUI\settings.json`。

## 内置插件

| 插件 | 做什么 | 随包版本 |
|---|---|---|
| `dsh-model-surplus` | 会话标题右侧显示当前模型的用量 / 余额：OpenCode Go 套餐用量与选中模型的月上限、DeepSeek 账户余额 | 0.4.6 |
| `dsh-gui-last-session` | 重启后回到上次那个对话 | 0.1.9 |
| `dsh-gateway-models` | 声明 opencode-go / Command Code 的路由协议和接口地址，并补齐它们的模型清单 | 0.2.6 |
| `dsh-keys-setting` | 在 DSH 设置「通用」页配置 Enter / Shift+Enter / Ctrl+Enter 是发送还是换行 | 0.2.6 |

每个插件同时也是独立仓库（[model-surplus](https://github.com/itchenshi/dsh-model-surplus)、[gui-last-session](https://github.com/itchenshi/dsh-gui-last-session)、[gateway-models](https://github.com/itchenshi/dsh-gateway-models)、[keys-setting](https://github.com/itchenshi/dsh-keys-setting)）；本仓库的 `plugins/` 是它们的随包副本，安装时用的是这份本地副本，不经过 npm。

## 设置

设置窗口（托盘菜单或应用菜单打开）里的真实选项：

| 选项 | 值 / 默认 |
|---|---|
| 关闭窗口 | 隐藏到托盘（默认）/ 直接退出 |
| 数据目录 | 跟随系统 `~/.dsh`（默认）/ 应用目录；切换时询问是否迁移 |
| 引擎更新策略 | 静默更新 / **询问后再更新**（默认）/ 仅提示，不自动更新 |
| 版本通道 | 跟随 npm latest 标签（默认）/ 跳过 alpha / 含 alpha、beta、rc 预发布 |
| 自动检查引擎更新 | 开（默认；启动时和运行中每 30 分钟一次）/ 关 |
| 立即检查引擎更新 | 按钮 |
| 第三方插件 | 每个插件的「安装」勾选框、「启用」开关，随包有新版本时的「更新」，状态不一致时的「修复 / 重试」 |
| 重启引擎 / 刷新页面 | 安装、卸载后要点「重启引擎」（旁边会显示「待重启引擎」标注）；带页面部分的插件还要点「刷新页面」 |
| 语言 / 主题 | 不在这里改 —— 在 Harness 页面的设置里改，外壳实时跟随，不用重启 |

## 常见问题

- **我的数据在哪？** 引擎的会话、配置、插件都在 `$DSH_HOME`（默认 `~/.dsh`，或在设置里改成应用目录）；引擎本体在应用数据目录的 `dsh-engine/`；外壳自己的偏好在应用数据目录的 `settings.json`。
- **怎么回到上次那个对话？** 靠内置的「会话续接」插件，默认开着（设置 → 会话 → 启动后自动回到最近一次对话）。关掉后每次启动都是空白会话；会话记录本身一直在 `$DSH_HOME` 里，不会因此消失。
- **为什么说插件要重启才生效？** 引擎只在启动时组装插件清单，所以安装 / 卸载必须重启引擎（设置窗口会显示「待重启引擎」标注，点旁边的按钮即可）。「启用 / 禁用」是热重载，立即生效；带页面部分的插件还要刷新一下 Harness 页面。
- **引擎起不来怎么办？** 会弹出「DeepSeek Harness 启动失败」对话框，显示引擎最后的输出，并把日志写到应用数据目录的 `logs/dsh-start-fail-<时间>.log`。如果输出里出现了某个插件的包名，对话框会问你要不要「禁用并重启」。
- **关掉窗口以后应用还在跑吗？** 默认在，只是隐藏到托盘（右键托盘图标可以打开窗口、进设置或退出）。把「关闭窗口」改成「直接退出」就关窗即退出。

## 开发

```sh
npm start                 # 直接运行（Electron）
npm test                  # 单测 + 设置页内联脚本、文档图片、PowerShell 编码等检查
npm run test:e2e          # Windows 端到端冒烟（会真的启动应用，用隔离的 userData）
npm run test:e2e:ui       # 关窗 / 托盘 / 模态框的界面冒烟（Windows）
npm run verify:builtin    # 内置插件自愈验证（临时 DSH_HOME + 真引擎 + 真 pnpm）
npm run sync:plugins      # 插件仓库 → plugins/（全量镜像）
npm run dist:win          # Windows：安装包 + 便携 zip
npm run dist:mac          # macOS dmg（要在 macOS 上跑）
npm run dist:linux        # Linux AppImage
```

- 冒烟测试跑的是真实的应用和真实的引擎，不是 mock；跑之前先关掉正在运行的实例。
- 改插件请改插件仓库（`plugin-repos/<名字>/`），再 `npm run sync:plugins`；`plugins/` 是生成物，手改会被下次同步覆盖。只查漂移用 `node scripts/sync-bundled-plugins.mjs --check`。
- CI 见 [`.github/workflows/build-all.yml`](.github/workflows/build-all.yml)：先跑 `npm test`，再在 Windows / macOS / Linux 的 runner 上分别打包并挂到 Release。

## 许可

[MIT](LICENSE) · 独立开源外壳，与 DeepSeek Harness 官方项目无隶属关系；
DeepSeek Harness 本身是 [MIT](https://github.com/deepseek-ai/deepseek-harness) 许可。
