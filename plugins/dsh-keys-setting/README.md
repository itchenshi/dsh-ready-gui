# dsh-keys-setting

[![English](https://img.shields.io/badge/README-English-green)](README.en.md)
[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)

在 DSH 的**设置窗口 →「通用」**里决定：**Enter / Shift+Enter / Ctrl+Enter（macOS 为 ⌘）各自是「发送消息」还是「换行」**。

## 它做什么

- 在「设置 → 通用」加一行「按键设置」，三个手势各有一个下拉选择器（发送消息 / 换行）。
- 捕获阶段监听输入框的 `keydown`：只有你的选择与引擎原生行为不同时才拦截，并重新派发引擎自己的另一种手势。
- 只重映射手势，不碰输入内容 —— 发送与换行的语义仍由引擎决定。
- 输入法（`isComposing` / keyCode 229）与 `Alt+Enter` 一律放行。
- 默认值等于引擎原生行为，不改设置时干预次数为 0。

## 安装

- **用 DSH Ready GUI（推荐）**：插件随 GUI 内置。打开 GUI → 设置窗口 →「第三方插件」勾选**按键设置**，
  装完按提示刷新页面（它带页面半边）。
- **其它 DSH 宿主**（`dsh web` / CLI）—— 任选一条：

  ```sh
  # 推荐：直接从 GitHub 装
  dsh plugin --profile web add github:itchenshi/dsh-keys-setting

  # 备选：从本仓库 Release 的 tarball 装
  dsh plugin --profile web add https://github.com/itchenshi/dsh-keys-setting/releases/download/v0.2.6/dsh-keys-setting-0.2.6.tgz
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。

> 本包还不在 npm 上（`registry.npmjs.org` 查无此包），只能用上面两种方式装。

## 使用

设置窗口 →「通用」里新增的那一行就是「按键设置」，改完立即生效。

也可以手改 profile 的 `cordis.patch.yml` 里 `id: composer-keys` 这一行的配置：宿主半边在页面窗口
**重新获得焦点时重读**，所以切回 Harness 窗口即生效，不用刷新页面。

## 配置

`cordis.patch.yml` 里 `id: composer-keys` 这一行的 `config`（三个字段由插件的 `Config` schema 声明）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enter` | `send` | `send` = 发送消息，`newline` = 换行 |
| `shiftEnter` | `newline` | Shift+Enter 同上 |
| `ctrlEnter` | `send` | Ctrl+Enter（macOS ⌘）同上 |

该行的 `config` 块不能省：没有它这一行就没有设置条目，宿主无法读写偏好。`config.enabled === false`
时宿主直接返回，既不注册路由也不加设置行。

## 兼容性

- 需要 **DSH >= 0.2.0-rc.2**（引擎 0.2.0 更换了设置服务 API，0.1.x 上无法保存偏好）。
- Node >= 20。
- 运行时依赖：无；schema 库用的是引擎自带的 `@deepseek-ai/schemastery`。

## 常见问题

**改完没生效？** 设置窗口里改立即生效；手改文件后要切回 Harness 窗口触发重读。宿主启动时会打
`[composer-keys] route ready at /composer-keys (entry composer-keys)`，日志里没有它说明插件没加载。

**引擎版本太旧会怎样？** 清单只声明 `>=0.2.0-rc.2`；更旧的引擎用的是已被移除的旧设置服务
（`register` / `get` / `section`），插件无法保存偏好。

**它存了什么、存在哪？** 只有那三个值，落在插件自己的行 config（引擎的设置文档）里；插件不直接读写
任何文件。

**别人能读改这份偏好吗？** 宿主只开放一条 `GET/POST /composer-keys`，走引擎自己的信任围栏
（Host 白名单 + 浏览器会话 cookie），拿不到围栏时**失败即关闭** —— 不带 cookie 的裸 `curl` 得到 401。
插件没有任何对外网络请求。

## 开发

```sh
node --check lib/index.js
node --check client/client.js
npm test        # node tests/test.mjs：手势识别、干预判定、输入法放行、默认值不干预
```

## 许可

MIT
