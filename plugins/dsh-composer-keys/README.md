# dsh-composer-keys

在 **DSH 设置窗口 → 通用** 里配置输入框的快捷键：**Enter / Shift+Enter / Ctrl+Enter（macOS 为 ⌘）
各自设为「发送消息」或「换行」**。

```
设置 → 通用
  ┌──────────────────────────────────────────────────────────┐
  │ 输入框快捷键                                              │
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
    - id: composer-keys
      name: dsh-composer-keys
      config:
        enabled: true    # false 时完全不加载（既不注册路由也不加设置行）
```

## 安装

随 DSH GUI 的「设置窗口 → 第三方插件」勾选安装。手动安装：

```sh
dsh plugin --profile web add file:./plugins/dsh-composer-keys
```

装完重开 DSH GUI（或重启引擎），设置窗口「通用」页最下方即可看到「输入框快捷键」。

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
