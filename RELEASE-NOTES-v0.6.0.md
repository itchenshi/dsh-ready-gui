# 🚀 DSH Ready GUI v0.6.0

> DeepSeek Harness 桌面壳 —— 内嵌 Web UI、自动保持最新引擎、自带数据目录管理与系统托盘。

**发布说明：** 这一版把「**网关路由**」这件事做完整了：随包插件从 **OpenCode Go 专用**扩展成
**OpenCode Go + Command Code**，其中一个插件因此改了名；GUI 负责把老用户的旧插件**自动换成新的**。

---

## 🔌 随包插件：从 1 家网关变成 2 家

### `dsh-opencode-go-path` → **`dsh-gateway-models`**（0.2.0）

它已经不只管 OpenCode Go，还给 [Command Code](https://commandcode.ai) 声明协议和地址、并从上游
目录同步模型清单，所以换了个不带厂商的名字（顺手丢掉了当年只为绕开 npm 重名而加的 `-path` 后缀）。

**新增 Command Code 支持：**

- **不用再手填 API 地址**：补丁层直接声明 `commandcode` 路由的协议**和地址**，你只填密钥。
- **模型自动补齐**：启动时读上游**公开目录**（`GET …/provider/v1/models`，81 个模型，**不需要密钥**）
  把清单补全。**只增不改**：你已有的条目（含改过的名字、容量）原样保留，缺的追加在后面，你自己的
  排序不乱；跑第二遍不再写（幂等）。
- **按接口地址识别路由，不按名字**：`commandcode-pro` / `commandcode-max` / 社区插件的
  `commandcode` 一样会被补齐。

**一个路由名覆盖所有套餐**：默认路由名由 `opencode-go` 改为 **`commandcode`**，不带档位后缀 ——
套餐是跟着账号和密钥走的（`planId` 在 `/alpha/billing/subscriptions` 里报
`individual-go` / `individual-goat` / `individual-pro` / `individual-max-10x` / `individual-max-20x` …），
不是路由或地址决定的。**升级套餐只换 key，配置一个字都不用动**。

### `dsh-model-surplus`（0.4.0）

会话标题右侧现在也支持 Command Code：显示 **5 小时 / 周窗口百分比 + 剩余额度**。

一个诚实的说明：这个响应体形状**一开始写错了**。我按第三方实现的内部包装结构推断成嵌套，
用真实 key 打接口才发现 `credits` 与 `windowLimits` 在返回体上是**平级**的 —— 那个错误不会报错，
只会让界面**静默显示「用量不可用」**。现在按实测形状解析，并保留对嵌套形式的兼容。

它同样**不显示「月度百分比」**：接口给的是它实际执行的两个窗口（5 小时、周）的已用 / 上限和剩余额度，
**没有**给出套餐的月度总额度；要有月度百分比就得内置一张档位表去猜，所以不做。

---

## 🔄 GUI：老用户的旧插件会被自动换掉

改名不能让老用户的新旧两版同时加载（会出现两个控件、路由冲突），所以启动维护里有一步专门处理：

1. **检测**：profile 里还存在 `dsh-opencode-go-path`（登记或残留依赖）→
2. **清除**：走引擎自己的卸载，并把 **bundles 与 `dependencies` 都摘干净**（只摘 bundles 会被引擎的
   reconcile 依据残留依赖装回来 —— 这是实测踩过的回归），同时清掉只剩旧包名的补丁行与市场禁用项；
3. **替换**：把 `dsh-gateway-models` 交给随后的安装对账装上；
4. **保住你的选择**：补丁层的**行 id 仍是 `opencode-go`**（与包名解耦），所以你对这个插件的启用/禁用
   选择不变。

**本版顺带修掉一个「清理不完整」的缺陷**：旧包的 staging 拷贝原先只在「后面恰好有东西要 staging」时
才被清，于是「替代条目早就装着」的那次启动会永远留着它 —— 而它正是让指向它的 `file:` 依赖保持可解析、
进而让引擎把旧包重新登记回去的东西。现在这一步在旧插件清理里自己做，不再依赖执行顺序。

---

## 🛠 工具链与测试

- **`scripts/release-plugin-tarballs.ps1` 修好并去掉了写死的插件清单**：清单改为从磁盘推导
  （有 `package.json` + `cordis.patch.yml` 即收录），版本从各插件 `package.json` 读 —— 原先写死的
  名字在改名后会静默失效，写死的版本会让 README 的 tarball 链接被改回旧版（实测踩过：README 写着
  0.4.0、release 上只有 0.3.2，链接 404）。四个插件的 README 链接现已全部 **HTTP 200**。
- **含中文的 `.ps1` 补上 UTF-8 BOM**：本机只有 Windows PowerShell 5.1（没有 `pwsh`），它按 ANSI 读取
  无 BOM 的脚本，中文被解成乱码后 `release-plugin-tarballs.ps1` **直接解析失败（14 个语法错误）**、
  一行都跑不了。同时新增 `scripts/check-ps1-encoding.cjs` 并接进 `npm test`，让「编辑一次就把 BOM
  弄没」这种回归当场被抓到。
- **`npm run verify:builtin` 增加第 5 幕**：真实引擎下把「装着旧包名的环境」换成新包
  （摘 bundles + dependencies → 交接替代条目 → 安装 → 清 staging 拷贝 → 不重复登记），
  并断言共用的现役补丁行没被动。`ALL CHECKS PASSED`。
- **随包插件副本一致性**由 `sync:plugins --check` 把关；`plugin-enable` 用例从 17 增到 18。

---

## ⬆️ 升级说明

- **无配置迁移、无需手动操作**：数据目录、模型配置、会话历史原样保留。
- 旧插件会被自动清理并换成新插件，**不会新旧两份同时加载**；你对它的启用/禁用选择会跟过去。
- Command Code 用户：模型列表会在下次启动时自动补齐；**升级套餐只换密钥**，不用改配置。

## 📦 下载

- **GitHub（安装包在这里）**：https://github.com/itchenshi/dsh-ready-gui/releases/tag/v0.6.0
- **Gitee**：https://gitee.com/itchenshi/dsh-ready-gui/releases/tag/v0.6.0
- **GitCode**：https://gitcode.com/itchenshi/dsh-ready-gui/releases/tag/v0.6.0

三个平台都有 v0.6.0 的 Release 页与更新说明；**安装包只在 GitHub**（Gitee / GitCode 的 Release 提供
源码包）。原因有两条：

- 本项目要同时产出 Windows 安装包、macOS（x64 + arm64）的 .dmg 和 Linux 的 AppImage，只有 GitHub
  Actions 能一次提供 Windows / macOS / Linux 三种 runner 做矩阵构建（Gitee Go 的云端构建只有 Linux
  容器，Node 版本也只到 15，够不上本项目要求的 Node ≥ 23）。
- Gitee 免费版限制**附件单文件 100MB、单仓库附件共 1GB**，而我们的产物是 133–194MB、合计约 1.6GB
  —— 一个都传不上去。

国内网络下载慢的话，可以用镜像加速或代理，安装包本身与源码是同一份。

## ⚠️ 平台验证范围（如实说明）

- **Windows**：我在用，实测过。
- **macOS / Linux**：每次发版都会由 CI 的四平台矩阵构建出 `.dmg`、`.AppImage` 等产物，
  但**我手上没有这两台机器，未做实机验证** —— 所以这里只敢说「已构建」，不敢说「支持」。
  你在 macOS 或 Linux 上跑过的话，欢迎开 issue 告诉我结果。
