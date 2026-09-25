# dsh-keys-setting

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

> 这是 **DSH Ready GUI** 的组成部分之一 —— GUI 开箱内置四个插件，勾选即用。
> 也可单独装到任何 DSH 宿主里（见下方「装上就能用」）。
> GUI：https://github.com/itchenshi/dsh-ready-gui

在 **DSH 设置窗口 → 通用** 里配置输入框的快捷键：**Enter / Shift+Enter / Ctrl+Enter（macOS 为 ⌘）
各自设成「发送消息」还是「换行」**。

```
设置 → 通用
  ┌────────────────────────────────────────────────────────────┐
  │ 按键设置                                                    │
  │ 设置 Enter / Shift+Enter / Ctrl+Enter 是发送消息还是换行     │
  │                                  Enter        [发送消息 ▾]  │
  │                                  Shift+Enter  [换行     ▾]  │
  │                                  Ctrl+Enter   [发送消息 ▾]  │
  └────────────────────────────────────────────────────────────┘
```

## 装上就能用

- **用 DSH Ready GUI（推荐）**：插件**随 GUI 内置**。打开 GUI → 设置窗口 → 第三方插件 → 勾选
  **按键设置**，装完按提示重启引擎、按提示刷新页面（它带页面部分），设置窗口「通用」页最下方就会出现
  那一行。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 两条路都行，任选一条：

  ```sh
  # 推荐：直接从 GitHub 装（记进 profile，之后可跟着更新）
  dsh plugin --profile web add github:itchenshi/dsh-keys-setting

  # 备选：从本仓库 Release 的 tarball 装（网络受限连不上 github.com 时用这条）
  dsh plugin --profile web add https://github.com/itchenshi/dsh-keys-setting/releases/download/v0.2.0/dsh-keys-setting-0.2.0.tgz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> npm 上暂时没有这个包：注册账号那一环走不通（`www.npmjs.com` 返回 Cloudflare 托管挑战），包发不
> 出去。所以现在只能按上面两种方式装。等注册通了会照常发布。

**不配就是引擎原生行为**，装着它不会改变你现有习惯：

| 手势 | 引擎原生 | 本插件默认 |
|---|---|---|
| `Enter` | 发送 | 发送 |
| `Shift+Enter` | 换行 | 换行 |
| `Ctrl/Cmd+Enter` | 发送 | 发送 |

只在「你的选择 ≠ 引擎原生」时才拦截，所以未改动时干预次数为 **0**。
（`Ctrl+Shift+Enter` 归入 Shift 手势 —— 引擎的键位表里 Shift 规则先匹配。）

## 它是怎么做的（要点）

- **只重映射，不碰内容**：捕获阶段监听 composer 的 `keydown`，命中时 `preventDefault` 并重新派发
  **引擎自己的另一种手势**（合成 `Shift+Enter` 或合成 `Enter`），换行/发送的语义仍由引擎决定。
- **识别 composer 用引擎的语义属性** `data-composer-input="true"`（不是哈希类名，也不是「任意
  contenteditable」），所以不会误伤侧边栏插件自己的编辑器。
- **绝不干扰输入法**：`isComposing` 或 `keyCode === 229` 的事件直接放行。
- **Alt+Enter 完全放行**（那是引擎自己的加速手势）。

> 合成的（`isTrusted: false`）键盘事件**确实能驱动引擎的 composer** —— 在真实页面上用 CDP 对照验证过：
> 可信的 Shift+Enter 与合成的 Shift+Enter 产生了完全相同的 DOM 变化
> （插入 `<br data-lexical-managed-linebreak="true">`），合成的 Enter 也真实提交了消息。

## 配置

偏好存在 `$DSH_HOME/settings.yaml` 的 `composer-keys` 段，**可以直接手改**：

```yaml
composer-keys:
  enter: newline       # Enter 换行
  shiftEnter: newline  # Shift+Enter 换行（默认）
  ctrlEnter: send      # Ctrl+Enter 发送（默认）
```

手改文件后**切回 Harness 窗口即生效**（插件在窗口重新获焦时重读），不用刷新页面；在设置窗口里改则
立即生效。

插件行的开关（写在 `cordis.patch.yml` 的行 config 里）：

```yaml
- insert:
    - id: composer-keys        # 行 id 与包名解耦，刻意保持不变
      name: dsh-keys-setting
      config:
        enabled: true          # false 时完全不加载（既不注册路由也不加设置行）
```

> **包名换过**（`dsh-composer-keys` → `dsh-keys-setting`，因为原名在 npm 上被别人占用），但
> **行 id 与设置命名空间仍是 `composer-keys`**，这是刻意的：补丁层的禁用行、市场 `state.json` 的开关、
> `settings.yaml` 里你保存的键位都记在那个名字下，改包名不该让你已有的设置失效。

## 权限与边界（给会静态扫描的商城看的）

- **运行依赖：`schemastery`**（纯 JS 的 schema 校验库，无原生制品、无安装脚本）—— 宿主半边用它向
  引擎的设置服务注册本插件命名空间的 schema。这是唯一的 `dependencies`。
- **文件：本插件不直接读写任何文件。** 偏好值通过引擎自己的设置服务落进 `$DSH_HOME/settings.yaml`，
  源码里没有 `node:fs`。扫描器报的「files 信号」来自这个**间接**写入（以及注释里对 `settings.yaml`
  的说明），不是直接的磁盘操作。
- **本机路由：一条。** 宿主注册 `GET/POST /composer-keys` 供页面读写偏好 —— 页面拿不到插件私有的设置
  命名空间（设置 RPC 域只服务固定命名空间），这是唯一通道。路由走引擎自己的信任围栏（Host 白名单 +
  浏览器会话 cookie），拿不到围栏时**失败即关闭**；不带 cookie 的裸 `curl` 会得到 `401`。
- **出站网络：无。** 页面半边的 `fetch` 只打上面那条同源路由。
- **凭据 / 命令 / 原生制品 / 生命周期脚本：无。**
- **失败边界：** 路由或 settings 服务不可用时，键盘引擎**仍然工作**（只是失去持久化或设置入口）——
  属于降级而不是崩溃。卸载后 `settings.yaml` 里的 `composer-keys` 段会留下，重建插件即恢复原设置。

## 两部分构成

| 半边 | 文件 | 运行在 | 职责 |
|---|---|---|---|
| 宿主 | `lib/index.js` | Node | 用引擎设置服务注册 `composer-keys` 命名空间（值落在 `settings.yaml`，随数据目录走），并开放 `GET/POST /composer-keys` |
| 页面 | `client/client.js` | 浏览器 | 注册「设置 → 通用」那一行 + 捕获阶段做键位重映射 |

**为什么需要宿主半边**：页面来自每次启动都变化的随机端口（外壳用 `dsh web --port 0`），浏览器存储
等于每次换源、存不住；而引擎的**设置文档**才是持久且随数据目录迁移的地方。页面半边拿不到插件自有
命名空间，所以由宿主路由转交 —— 与第三方侧边栏插件为自身偏好所用的方式一致。

设置行的样式逐条沿用通用页其它行：字体、颜色、间距，以及**选择框**（同样是 `<button>` 胶囊 + 箭头
SVG + 弹层，而不是原生 `<select>`），颜色全部走引擎主题变量，深浅色主题自动跟随。实测在真实设置弹窗
里取计算样式，胶囊的高度 / 圆角 / 背景 / 内边距 / 字号 / 行高 / 间距 / 颜色 **8 项与「对话显示」的
控件逐项相等**。

## 开发

```sh
node --check lib/index.js
node --check client/client.js
npm test        # 本地行为测试（无网络、无引擎、无 DOM）
```

`tests/test.mjs` 覆盖：手势识别（含 `Ctrl+Shift` 折叠、Alt 放行）、三种手势 × 两种动作的干预判定、
输入法放行、非法偏好值不干预，以及「默认值不干预」这一关键性质。

## 许可

MIT
