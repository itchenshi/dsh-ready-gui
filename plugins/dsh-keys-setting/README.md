# dsh-keys-setting

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

在 **DSH 设置窗口 → 通用** 里配置输入框的快捷键：**Enter / Shift+Enter / Ctrl+Enter（macOS 为 ⌘）
各自设为「发送消息」或「换行」**。

```
设置 → 通用
  ┌──────────────────────────────────────────────────────────┐
  │ 按键设置                                                  │
  │ 设置 Enter / Shift+Enter / Ctrl+Enter 是发送消息还是换行   │
  │                                    Enter       [发送消息 ▾] │
  │                                    Shift+Enter [换行     ▾] │
  │                                    Ctrl+Enter  [发送消息 ▾] │
  └──────────────────────────────────────────────────────────┘
```

## 默认值 = 引擎原生行为

未改动时插件的干预次数为 **0**，行为与不装插件完全一致：

| 手势 | 引擎原生 | 本插件默认 |
|---|---|---|
| `Enter` | 发送 | 发送 |
| `Shift+Enter` | 换行 | 换行 |
| `Ctrl/Cmd+Enter` | 发送 | 发送 |

`Ctrl+Shift+Enter` 归入 Shift 手势（引擎键位表里 Shift 规则先匹配）。

## 实现方式（要点）

- **只在「你的选择 ≠ 引擎原生」时才拦截**：捕获阶段监听 composer 的 `keydown`，
  命中时 `preventDefault` + 重新派发**引擎自己的另一种手势**（合成 `Shift+Enter` 或合成 `Enter`）。
  换行/发送的语义仍由引擎决定，插件不碰编辑器内容。
- **识别 composer 用引擎的语义属性** `data-composer-input="true"`（不是哈希类名，也不是「任意 contenteditable」），
  所以不会误伤侧边栏插件自己的编辑器。
- **绝不干扰输入法**：`isComposing` 或 `keyCode === 229` 的事件直接放行。
- **Alt+Enter 完全放行**（那是引擎自己的加速手势）。

> 合成的（`isTrusted: false`）键盘事件**确实能驱动引擎的 composer** —— 这一点在真实页面上
> 用 CDP 对照验证过：可信的 Shift+Enter 与合成的 Shift+Enter 产生了**完全相同的 DOM 变化**
> （插入 `<br data-lexical-managed-linebreak="true">`），合成的 Enter 也真实提交了消息。

## 两半

| 半边 | 文件 | 运行在 | 职责 |
|---|---|---|---|
| 宿主 | `lib/index.js` | Node | 用引擎设置服务注册 `composer-keys` 命名空间（值落在 `settings.yaml`，随数据目录走），并对外开放 `GET/POST /composer-keys` |
| 页面 | `client/client.js` | 浏览器 | 注册「设置 → 通用」那一行 + 捕获阶段做键位重映射 |

> **路由受引擎的信任围栏保护**（Host 白名单 + 浏览器会话 cookie）：它既读也**写**这份偏好，
> 所以不带 cookie 的裸 `curl` 会得到 `401 unauthorized`。同源页面请求自动带 cookie；手工调用
> 需先换一次会话 cookie（示例见 `dsh-gui-last-session/README.md`）。围栏实现在无依赖的
> `lib/shared.js`（`rejectUntrusted`），有单测覆盖 fail-closed 与 401/403 映射。

**为什么要宿主半边**：页面来自每次启动都变化的随机端口（外壳用 `dsh web --port 0`），
浏览器存储等于每次换源、存不住；而引擎的**设置文档**才是持久且随数据目录迁移的地方。
页面半边拿不到插件自有命名空间（设置 RPC 域只对配置客户端提供固定命名空间），
所以由宿主路由转交——与第三方侧边栏插件为自身偏好所用的方式一致。

## 配置

偏好存在 `$DSH_HOME/settings.yaml` 的 `composer-keys` 段，可以直接手改：

```yaml
composer-keys:
  enter: newline       # Enter 换行
  shiftEnter: newline  # Shift+Enter 换行（默认）
  ctrlEnter: send      # Ctrl+Enter 发送（默认）
```

手改文件后**切回 Harness 窗口即生效**（插件在窗口重新获焦时重读），无需刷新页面；
在设置窗口里改则立即生效。

插件行的开关（可选，写在 `cordis.patch.yml` 的行 config 里）：

```yaml
- insert:
    - id: composer-keys        # 行 id 与包名解耦，刻意保持不变（见下）
      name: dsh-keys-setting
      config:
        enabled: true    # false 时完全不加载（既不注册路由也不加设置行）
```

## 安装

> **npm 上暂时没有这个包 —— 现在只能从源码安装。**
>
> 原计划是把四个随附插件发布到 npm，那样在任何 DSH 宿主里 `dsh plugin add dsh-keys-setting` 就能装。
> 但 npm 账号注册目前走不通：`www.npmjs.com` 的注册/登录页返回 Cloudflare 托管挑战
> （`registry.npmjs.org` 本身是通的，卡在注册这一环），账号建不出来，包自然发不出去。
> 所以：
>
> - **用 DSH Ready GUI**：这四个插件随 GUI 内置，打开「设置窗口 → 第三方插件」勾选即可，
>   不需要命令行（在 GUI 里手动装自己的 checkout 会被启动维护换回随包那一份，这是有意设计）；
> - **其它 DSH 宿主**（`dsh web`、CLI 等）：按下文从源码装。
>
> 等注册能走通了，会按原计划发布到 npm，那时 `dsh plugin --profile web add dsh-keys-setting` 即可。

**方式一：DSH Ready GUI（推荐）** —— 这四个插件随 GUI 内置。打开 GUI → 设置窗口 → 第三方插件
→ 勾选 **按键设置（dsh-keys-setting）**。安装、卸载、启用/禁用都在同一个窗口里，装完按提示重启引擎。

**方式二：其它 DSH 宿主** —— 先把本仓库 clone 到本地，再按**目录**安装：

```sh
git clone https://github.com/itchenshi/dsh-keys-setting.git
dsh plugin --profile web add file:<clone 出来的绝对路径>
```

装的是磁盘上的真实目录，所以之后 `git pull` 更新的就是同一份代码；反过来，**换机或移动目录会
让这条依赖失效**（那时重新 add 一次即可）。

装完**重启 `dsh web`**（或重开 DSH GUI），设置窗口「通用」页最下方即可看到「按键设置」。

> **关于包名**：本插件最初叫 `dsh-composer-keys`，但那个名字在 npm 上已被其他作者
> 占用，现在的包名是 `dsh-keys-setting`。
>
> **行 id 与设置命名空间仍是 `composer-keys`，这是刻意的**：补丁层的禁用行、市场
> `state.json` 里的开关，以及 `settings.yaml` 里你保存的键位都记在这个名字下。
> 包名只是安装时用的标识，改它不该让你已有的键位设置或启用/禁用选择失效。
>
> 升级由 DSH GUI 的启动维护自动完成（旧包名会被摘掉、禁用选择会被搬到新包上）。

## 权限、依赖与失败边界

会把仓库固定到某个 commit 再审查的商城（DSH STORE 之类）会对运行时代码做静态扫描，
并按检测到的信号给出权限结论。这里把事实一次写清，免得被推断：

- **运行依赖：`schemastery`**（纯 JS 的 schema 校验库，无原生制品、无安装脚本）。
  宿主半边用它向引擎的设置服务注册本插件命名空间的 schema。这是本插件唯一的
  `dependencies`。
- **文件：本插件不直接读写任何文件。** 偏好值通过引擎自己的设置服务落到
  `$DSH_HOME/settings.yaml` —— 源码里没有 `node:fs`。扫描器报的「files 信号」
  来自这个经由 settings 服务的间接写入（以及代码注释里对 `settings.yaml` 的说明），
  不是直接的磁盘操作。
- **本机路由：有，一条。** 宿主半边注册 `GET/POST /composer-keys`，供页面半边读写偏好
  —— 页面拿不到插件私有的设置命名空间（设置 RPC 域只服务固定命名空间），这是唯一的
  通道。该路由走引擎自己的信任围栏（Host 白名单 + 浏览器会话 cookie），拿不到围栏时
  **fail-closed**。
- **出站网络：无。** 页面半边的 `fetch` 只打上面那条同源路由。
- **凭据 / 命令 / 原生制品 / 生命周期脚本：无。**
- **失败边界**：路由或 settings 服务不可用时，键盘引擎**仍然工作**（只是失去持久化或
  设置入口）——属于降级而不是崩溃。卸载后 `settings.yaml` 里的 `composer-keys`
  命名空间会留下，重建插件即恢复原设置。

## 设置行样式（沿用通用页）

字体、颜色、间距与**选择框**都逐条沿用通用页其它行的声明：

- 行外壳与排版取自引擎的 `settings.general.item` 行（`.row/.rowText/.title/.desc/.selector`）；
- **选择框**与「对话显示」那一行的控件完全一致——同样是 **`<button>` 胶囊 + 箭头 SVG + 弹层**，
  而不是原生 `<select>`（原生控件会画自己的箭头与内边距，怎么调都对不上，所以第一版被替换掉了）；
- 弹层取自引擎 Menu 组件（`._list_/._portal_/._item_/._itemLabel_/._check_`）：圆角 20px、内缩 4px、
  最小宽 218px、`position:fixed`、`z-index:1100`，条目 40px 高 / `8px 10px` 内边距 / 圆角 10px，
  选中项用对勾图标标记。

| 元素 | 声明 |
|---|---|
| 标题 | `14px / 400 / var(--dsw-alias-label-primary)`，行高 22px |
| 描述 | `12px / var(--dsw-alias-label-tertiary)`，行高 18px |
| 行容器 | `padding:16px 0`，底部 `0.5px solid var(--dsw-alias-border-l2)` |
| 胶囊选择框 | `height:36px`、`border-radius:18px`、`padding:0 14px`、`gap:12px`、`background:var(--dsw-alias-bg-module-platform)`、悬停 `--dsw-alias-interactive-bg-hover` |
| 弹层面板 | `var(--dsw-alias-bg-base)`、圆角 20px、内缩 4px、最小宽 218px |

全部颜色走引擎主题变量，深浅色主题自动跟随。

**实测**（真实设置弹窗内取计算样式）：胶囊的高度 / 圆角 / 背景 / 内边距 / 字号 / 行高 / 间距 / 颜色
**8 项与「对话显示」的控件逐项相等**；弹层的圆角、内缩、最小宽、定位、层级与条目尺寸也全部一致；
点选后配置确实写回（`settings.yaml` 的 `composer-keys` 段）。

> 底部分隔线实测不显示，这是引擎自己的规则：
> `._WvWnq_section > [data-slot="settings.general.item"] > :last-child { border-bottom: medium }`
> 会去掉该列表**最后一行**的分隔线；本行 order=21 排在引擎 composer-Enter 行（order=20）之后，因此被同等对待。

刻意不 `import` 引擎的 UI primitives（那样能直接用同一个 Menu 组件）：在 `dsh.client.inject` 里声明
引擎客户端包会让整批 bundle 重复注册（仓库里已记录过这个坑），模块加载器也会拒绝在它启动前请求的外部模块。
因此这里按引擎的 CSS 声明重写了一份等价控件。

## 开发

```sh
node --check lib/index.js
node --check client/client.js
npm test        # 本地行为测试（无网络、无引擎、无 DOM）
```

`tests/test.mjs` 覆盖：手势识别（含 `Ctrl+Shift` 折叠、Alt 放行）、
三种手势 × 两种动作的干预判定、输入法放行、非法偏好值不干预、
以及「默认值不干预」这一关键性质。

## License

MIT
