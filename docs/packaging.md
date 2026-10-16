# dsh-status-turbo 打包与装机（可复跑）

> 本文只写**已实测或已在仓库内有据可查**的步骤。命令按**本机路径**书写，可直接复制执行。
>
> **当前版本：`0.21.1`**（当前版本的唯一权威是 `package.json · version`；文中 `0.6.x` / `0.9.2` 等更早的版本号都是历史沿革或历史判据的引用，不是现值）。
>
> 两条硬约束先说在前面：
> 1. **零构建**：`lib/` 即源码即产物，打包动作只有 `npm pack`，没有编译/转译/打包器（`package.json · scripts @ :45-47` 仍然只有 `test`）。
> 2. **`install_bundle` 与「重启」必须由人执行**，agent 只准备产物与指令。依据：`docs/acceptance.md · §8 人工复验清单 @ :239` 逐字「**禁止**让 agent 代执行 `plugin_manager install_bundle`」；`plugin_manager` 需要 `danger-full-access` 或审批，而当前会话的审批是关闭的（`AI提速插件-开发任务书.md · §9 第 10 条 @ :520`）。

---

## 0. 装机顺序（总览）

```
① 升 package.json · version  →  ② npm pack 到 dist/  →  ③ 人：tgz 放进 profile 的 .plugin-specs\
→  ④ 人：插件管理器 install_bundle  →  ⑤ 人：完全重启（不是保存）→  ⑥ 核对（§5）
```

`TASKS.json · T11 · contract.installOrder` 与本节一致（①升版 ②pack ③用户手动 install_bundle ④完全重启 ⑤验证）。

---

## 1. 前置：每次装机前都要升版本号

- 唯一权威：`package.json · version @ :3`（`CHANGELOG.md · @ :13` 逐字「版本号口径：`package.json · version` 是版本的唯一权威」）。
- **同版本号重复 `install_bundle` 会被拒**：`docs/design.md · §5.1 @ :503` 实测逐字「用**同一个版本号**再次 `install_bundle` 会被 pnpm 判为无需重解析，DSH 侧返回
  `{"application":"failed","error":{"code":"ambiguous-install"},"changed":false}`，已装副本会停在旧内容上」；提到新版本号后返回 `{"changed":true,"application":"restart-required"}`。
- 本版目标版本号 **`0.21.1`**（已对齐：`package.json · version` = `0.21.1`）。0.21.1 是**删行为**（不改线格式、不动配置面）：新会话不再被自动填进开场话术 —— 0.20.0 之前宿主建完空白子会话还会再 `append` 一条 `user/message`（`rotationSeedMessage` 模板渲染），加上 `rotationOpenChild: true` 自动切过去，于是「每次开一个新会话都冒出同一段」。用户要求「把这个开启新会话 自动填充这个的去掉」，改为手动复制：现在 `rotationCreate: true` 建出来的也只是**空白**会话，那段话术只从状态条「复制话术」按钮或设置页话术卡手动取。逐条见 `CHANGELOG.md · ## [0.21.1]`。
- **0.21.1 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **48** 个键、`lib/` 仍 **10** 个文件；测试 **326**（条数不变 —— 改动落在既有用例的断言上：原来断言「子会话里写进了开场话术」的用例，现在断言「子会话里没有任何消息」）。轮换记录不再带 `seedOk`（`armed` 少一个字段，`seedText` 保留）。
- 本版目标版本号 **`0.21.0`**（已对齐：`package.json · version` = `0.21.0`）。0.21.0 是**修体验 + 补缺口**（不改线格式、不动配置面）：①设置页「全部设置项」里的字段名与分组名全部中文化 —— 原先漏出的是原始键名（`handoffExportWindowPercent`、`rotationRequireIdle`，分组头写成 `other`），真因是 `makeText` 的兜底在调用点、等于永不查词典，且词典里两条用了旧名、16 条真键没有条目；②状态条新增**复制**按钮，复制「会话名称 + 会话 ID + 会话日志目录 + 继续处理未完成的任务」四行（值为空整行省掉），其中名称与日志目录是本版**新进 wire** 的两个字段（`newSession.title` / `newSession.logDir`）。逐条见 `CHANGELOG.md · ## [0.21.0]`。
- **0.21.0 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键（`newSession` 内部 +2 字段不计顶层）、`DEFAULT_CONFIG` 仍 **48** 个键、`lib/` 仍 **10** 个文件；测试 **326**（新增设置项中文化与状态条复制话术各 1 条）。
- 本版目标版本号 **`0.20.0`**（已对齐：`package.json · version` = `0.20.0`）。0.20.0 是**加能力 + 修缺陷**：①轮换子会话不再「一代一个样、认不出是谁开的」—— 宿主在建会话 + 写种子消息之后，读旧会话的持久化标题并按官方 `(N)` 约定递增，用 `ctx.sessionTitle.rename` 写回（新增配置键 `rotationIncreaseTitle`，默认 `true`，与 0.8.0 同名同义；服务缺席 / 无标题 / 改名失败只降级，进 `rotation-trace.jsonl`）；②客户端在 `auto` 且「等当前回合结束」时那一行**改为可点**（点击 = 立刻切过去），并多一行「切过去并归档当前会话」。逐条见 `CHANGELOG.md · ## [0.20.0]`。
- **0.20.0 没动线格式，配置面 +1 键**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`lib/` 仍 **10** 个文件；`DEFAULT_CONFIG` **46 → 48** 个键（新增布尔键 `rotationIncreaseTitle`、`rotationCreate`），测试 **324**（新增轮换改名 2 条、等待态出口 3 条、只提醒 1 条）。

- 本版目标版本号 **`0.19.4`**（已对齐：`package.json · version` = `0.19.4`）。0.19.4 是**修缺陷**（不改线格式、不动配置面）：0.19.3 让子会话带着模型建出来、也把客户端重试放宽到约 20 秒，但界面上仍是「轮换失败 · 宿主拿不到 sessions 服务（缺席，不是故障）· 点这里重试」。真因是客户端半一直在调 `sessions.open(childId)`，而本机客户端运行时（0.2.0-rc.2）的 `sessions` 服务面里**没有 `open`**（只有 `retain` / `using` / `retainInfo` / `refreshProjections` / `search` / `fork` / `scope` / `binding`）；切会话的正门是 `uiWorkspace.openSession(target)`。修法只在客户端半：先取 `uiWorkspace`，有 `openSession` 用它，否则回落 `sessions.open`，两个都没有才记 `no-service`。逐条见 `CHANGELOG.md · ## [0.19.4]`。
- **0.19.4 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 **318**（新增 `test/rotation-client.test.mjs` 一条：有 `uiWorkspace.openSession` 时用它、且不再碰 `sessions.open`）。
- 上一版目标版本号 **`0.19.3`**（已对齐：`package.json · version` = `0.19.3`）。0.19.3 是**修缺陷**（不改线格式、不动配置面）：0.19.1 让轮换子会话"看得见"了，但它一跑就红 —— `agents.create` 没带模型选择，系统提示的部署级 persona 段（含 `{{model}}`）取值是 `undefined`、渲染即抛 `prompt variable "{{model}}" has no value for this assembly`；而且用户还得自己点一下才切过去（客户端只等约 3 秒，子会话要过"建代理 → 挂工作区 → 进列表"两跳）。修法：建会话时带上**旧会话正在用的模型**（回落宿主默认选择）与旧会话的 `agentPreset`（`setup` 里挂同一套组合，和宿主自己建会话同形），客户端重试放宽到约 20 秒。逐条见 `CHANGELOG.md · ## [0.19.3]`。
- **0.19.3 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 **317**（新增 `agentDefaultModel` / `agentPresets` 两条依赖边，用例数不变）。
- 更早版本目标版本号 **`0.19.2`**（已对齐：`package.json · version` = `0.19.2`）：`package.json · version` = `0.19.2`）。0.19.2 是**改观感**（不改线格式、不动配置面）：用户点名「你优化修复一下把。这个太丑了」—— 状态条与原生那行挤在一起、字还叠着。改法全在客户端半 `lib/client.js`：①耗时改紧凑写法（`2 分 49 秒` → `2:49`、`5.0 秒` → `5s`、亚秒保留 `123ms`），新增纯函数 `fmtElapsedCompact()`；②本步 token 只留数量（`本步 3.1K tok` → `3.1K tok`，悬停 `title` 仍是完整说明）；③**档位 pill 从状态条撤掉** —— 原生推理档选择器已经写着同一个值，它只留在详情面板；④无进展告警只留四个字（`工具仍在运行，只是还没有新输出` → `无新输出`、`已长时间没有新进展` → `无新进展`），判据全文退到悬停 `title`。逐条见 `CHANGELOG.md · ## [0.19.2]`。
- **0.19.2 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 **317**（口径改了，用例数不变）。
- 更早版本目标版本号 **`0.19.1`**（已对齐：`package.json · version` = `0.19.1`）。0.19.1 是**修缺陷**（不改线格式、不动配置面）：0.19.0 让轮换建出的子会话落了盘，但**左侧会话列表里仍然看不到** —— 列表是按各工作区的 `sessionIds` 列的，不挂进工作区就不显示。修法：`lib/rotation-host.js` 新增 `attachChildQuietly()`，在 `ctx.agents.create` 落地后 `workspaceRegistry.resolveByPath(cwd)` 找工作区并 `entity.attachSession(childId)`（`dsh-api-session-controller` 的新建与 fork 两条路都这么做）；结果（`attached` / `no-registry` / `no-workspace` / `resolve-failed` / `attach-failed`）进 `rotation-trace.jsonl` 的 `attach` 字段，不是 `attached` 另写一条 warn。逐条见 `CHANGELOG.md · ## [0.19.1]`。
- **0.19.1 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 **317**（新增 `workspaceRegistry` 一条依赖边，`test/halves.test.mjs` 逐字锁死顺序）。
- 更早版本目标版本号 **`0.19.0`**（已对齐：`package.json · version` = `0.19.0`）。0.19.0 是**修缺陷**（不改线格式、不动配置面）：到量轮换建出来的子会话只活在内存 —— 磁盘上没有日志目录、会话列表里也看不到。根因是 `ctx.sessions.create` 属于「代理生命周期之外发布」，持久化层不为它挂写句柄（`dsh-session` 原文 *a session published outside that lifecycle persists nothing*）；现在改走 `ctx.agents.create`（生命周期里构造并发布代理 ⇒ 写句柄挂上 ⇒ 落盘、可续、界面可见），取不到 `agents` 时退回原路。逐条见 `CHANGELOG.md · ## [0.19.0]`。
- **0.19.0 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 **317**（依赖表加回 `agents` 边，用例数不变）。
- 更早版本目标版本号 **`0.18.2`**（已对齐：`package.json · version` = `0.18.2`）。0.18.2 是**改落点**（不改行为、不动线格式、不动配置面）：左侧栏那个常驻「新会话」按钮由用户点名要求去掉，现在 `sidebar.panellist` 与 `main` 两处注册整条撤掉、`registerPanel` 与三个槽位常量一并删除，开场话术卡并进插件设置页那一格（配置表单在上、话术卡在下）。逐条见 `CHANGELOG.md · ## [0.18.2]`。
- **0.18.2 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 319 → **317**（三支注册用例并成一支）。
- 更早版本目标版本号 **`0.18.1`**（已对齐：`package.json · version` = `0.18.1`）。0.18.1 是**修注释与文档口径**（不改行为、不动线格式、不动配置面）：`lib/state.js · :1684` 的 v13 说明写「键数 37 → 35」与实测相反（v12 = 38、v13 = 37），两份 README 与 `docs/design.md` 仍停在 0.14.0–0.17.0 的房间/名册/编队口径。逐条见 `CHANGELOG.md · ## [0.18.1]`。
- **0.18.1 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 **319**（与 0.18.0 同数）。
- 上一版目标版本号 **`0.18.0`**（已对齐：`package.json · version` = `0.18.0`）。0.18.0 是**删功能 + 换主线**：用户要求「把群聊相关的去掉…只需要检测和提供新会话的话术 让我直接复制」。①**删**：群聊房间与任务板（0.10.0，`lib/room.js` / `lib/room-host.js`）、编队视图（0.13.0，`lib/fleet.js` / `lib/fleet-host.js`）、名册（0.11.0，`lib/roster.js`）、13 个 `room*` 配置键、11 个 `room_*` 工具与 `/room` 命令、设置里的「群聊」页、wire 顶层 `room` / `fleet` 两个键。（`docs/design-room.md` / `docs/design-fleet.md` 随功能删除，历史条目与旧版打包文档里指向它们的引用随之失效）②**加**：wire 顶层 `newSession`（开场话术卡 `{ text, oldId, cwd }`，由配置项 `rotationSeedMessage` 填好 `{old}` / `{cwd}`），左侧栏那一页改成「新会话」：轮换状态 + 工作目录 + **可直接复制的开场话术**（`navigator.clipboard` 优先，只读 `textarea` + `execCommand` 兜底）。逐条见 `CHANGELOG.md · ## [0.18.0]`。
- **0.18.0 动了线格式**：`TURBO_STATE_VERSION` **12 → 13**、`EXPECTED_V` **12 → 13**、wire 顶层 38 → **37** 键（删 `room` / `fleet`，加 `newSession`）、`DEFAULT_CONFIG` 59 → **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 14 → **10** 个文件、`cordis.patch.yml` 59 → **46** 键；测试 428 → **319**（`test/room.test.mjs` / `room-host.test.mjs` / `roster.test.mjs` / `fleet.test.mjs` 与 10 条已删功能的实例随功能删除，`test/panel.test.mjs` 重写为 24 条）。
- 更早版本目标版本号 **`0.17.1`**（已对齐：`package.json · version` = `0.17.1`）。0.17.1 是**修缺陷**：到量轮换从 2026-10-12 起再没建过新会话 —— `sessions` / `agents` 这类服务**只在声明它们的 `ctx.inject([...], cb)` 回调的 ctx 上可取**，而 `lib/index.js` 三处写成 `run.ctx.sessions`（模块级 ctx 属性访问），本宿主上取不到会抛错、被"可选服务＝缺席不是故障"的守卫吞掉，轮换一路走到服务门返回 `no-service`，只留一条内存记录与一行 warn。现在新增 `serviceOf()` 与两条独立依赖边 `ctx.inject(['sessions'], …)` / `ctx.inject(['agents'], …)`（模块级 `inject` 仍是 `['sessionProjections']`，两服务都不阻断插件），轮换/房间/编队改读 `run.sessions` / `run.agents`；并新增落盘决策痕迹 `<profile>/dsh-status-turbo/rotation-trace.jsonl`（每会话 5 秒最多一条）。逐条见 `CHANGELOG.md · ## [0.17.1]`。
- **0.17.1 没动线格式**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动；测试 427 → **428**（`test/halves.test.mjs` 新增 1 例）。
- 更早版本目标版本号 **`0.17.0`**（已对齐：`package.json · version` = `0.17.0`）。0.17.0 是**修缺陷 + 加功能**：①**修**：11 个 `room_*` 工具与 `/room` 命令从 0.10.0 起就没注册过 —— `lib/index.js` 把服务方法写成 `ctx.register(...)`，而 cordis 只把 events/fiber/registry/reflect 混入上下文，`ctx` 上根本没有 `register`，于是被判成"工具服务不可用"后静默 return；现在 `registeredService()` 从 `ctx.tools` / `ctx.commands` 取 `register`，并补齐按真实上下文形态构造的回归用例。②**加**：名册角色位新增 `expert`（专家角色，专家团里的名字），投喂正文与系统提示段都带上它（只投名字与用法，不复制专家正文）；"群里发消息＝派活" —— 任务板上没人领、又落在你职责里的活，自己 `room_claim_task` 领走。逐条见 `CHANGELOG.md · ## [0.17.0]`。
- **0.17.0 没动线格式**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键（53 个标量 + 6 个字符串数组，另加 `groups`）、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动；测试 422 → **427**（`test/halves.test.mjs` 加 1 例、`test/roster.test.mjs` 加 4 例）。
- 上一版目标版本号 **`0.16.1`**（已对齐：`package.json · version` = `0.16.1`）。0.16.1 是**修体验**（不是缺陷修复，写入本来就是对的）：设置页的「保存」点在界面上没有任何回执 ⇒ 用户以为没保存。`ConfigForm.set()` 成功返回 `true`、被宿主拒绝返回 `false`，而 0.16.0 的两处保存路径（`lib/client.js · RosterSection.save()` 与第二页的 `commit()`）都丢掉了这个布尔值。现在成功显示绿色「已保存」并清草稿，`false` 显示「宿主拒绝…请再点一次保存」且**保留改动**。逐条见 `CHANGELOG.md · ## [0.16.1]`。
- **0.16.1 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键（53 个标量 + 6 个字符串数组，另加 `groups`）、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动；测试 **422**（与 0.16.0 同数，本轮没加用例）。
- 上一版目标版本号 **`0.16.0`**（已对齐：`package.json · version` = `0.16.0`）。0.16.0 是**加功能**：把**全部配置项**搬进设置面板。`lib/roster.js · turboConfigSchema` 把反射出来的每个字段都标 `.volatile()`（0.15.x 只有 `groups`）—— 设置页只投 volatile 子树，非 volatile 字段既不显示也不能热写；新增纯函数 `liveConfig(config, defaults)` 给出按默认值表排列的 getter，`lib/index.js · resolveConfig` 过它一层，于是 `effective.X` 用时现取（loader 对"只改 volatile 字段"的变更原地更新引用 + `loader/volatile-update`，不重挂插件）⇒ 房间宿主 / 轮换 / 交接 / 装箱这些消费者**改完即生效**，只有 apply 时快照自己的项（编队的 `readOnlyTools` / `downgrade` / `downgradeFloor` / `minQuietSteps` 与 `roomEnabled`）要重启。客户端加第二页「全部设置项」（`id: dsh-status-turbo.settings`、order 106，按结果分组列出全部配置项、布尔点一下即写）与「套用编队模板」下拉（5 套人群 + 角色 + 人设 + 信息主体）。逐条见 `CHANGELOG.md · ## [0.16.0]`。
- **0.16.0 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键（53 个标量 + 6 个字符串数组，另加 `groups`）、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动。测试 418 → **422**（`test/roster.test.mjs` 加 2 例、`test/panel.test.mjs` 加 2 例）。
- 更早版本目标版本号 **`0.15.1`**（已对齐：`package.json · version` = `0.15.1`）。0.15.1 是**修缺陷（第三次）**：0.15.0 让设置命名空间来自本条目自己的 `Config`，方向对，但那个 `Config` 没造出来 —— 模块求值时用 `createRequire(...)('@deepseek-ai/schemastery')` 取 schemastery，而宿主是**并发 `import()`** 装载插件：schemastery 的 CJS 入口内部去 `require` 仍是 ESM 的 `@deepseek-ai/cosmokit`，Node 24 抛 `ERR_REQUIRE_ESM_RACE_CONDITION`（五条 require 取法全灭）⇒ `runtimeZ = null` ⇒ `Config = undefined` ⇒ 条目的设置命名空间仍是 `status: "absent"`。修法：顶层 await 的**动态 `import('@deepseek-ai/schemastery')`**；仓库里这条 import 必然 reject（工作树没有 `node_modules`）并被吞掉，`Config` 退化成 `undefined`。逐条见 `CHANGELOG.md · ## [0.15.1]`。
- **0.15.1 没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键（53 个标量 + 6 个字符串数组，另加 `groups`）、`lib/` 仍 **14** 个文件；测试 **418**（与 0.15.0 同数，本轮没加用例）。
- 更早版本目标版本号 **`0.15.0`**（已对齐：`package.json · version` = `0.15.0`）。0.15.0 是**修缺陷（第二次）**：0.14.1 让「群聊」页出现在设置侧栏之后，页面仍只有一句「设置服务不可用（本机 DSH 没有该设置命名空间）」。根因是本版 DSH 的设置服务没有 `register(ns, schema)` / `get(ns)`（`dsh-settings/lib/index.js` 的 `SettingsForms` 只有 `configure` / `prepareDocument` / `describe` / `update` / `replace` / `mutate`）：插件设置的命名空间**只能**来自该条目自己的 `Config`，且那个 `Config` 至少要有**一个 `.volatile()` 字段**才会被 `describe()` 产出（volatile 也是热写的前提 —— loader 只对 volatile 字段原地更新引用）。修法：宿主半 `export const Config = turboConfigSchema(z, DEFAULT_CONFIG)`（`lib/roster.js` 反射 `DEFAULT_CONFIG` 逐键生成，只有 `groups` 标 volatile）、名册改成闭包现取 `unwrapVolatile(config.groups)`、客户端半换成 `ctx.get('configForms').get(entryId)` 并按 `describe()` 镜像认领命名空间（旧 `settingsScope.bind` 留作后备）、`ctx.inject(['settings'], …)` 缩减成 `settings.configure({ auto: false }, ctx.fiber)` 抑制自动表单。逐条见 `CHANGELOG.md · ## [0.15.0]`。
- **0.15.0 没动线格式，但动了配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`lib/` 仍 **14** 个文件；条目新增 `Config`（`DEFAULT_CONFIG` 的 **59** 个键 = 53 个标量 + 6 个字符串数组，另加 `groups`），其中只有 `groups` 是 volatile（所以「53 个标量键镜像」这条核对值不变）。测试 413 → **418**（`test/roster.test.mjs` 加 2 例、`test/panel.test.mjs` 加 3 例）。
- **`0.14.1`**（已对齐：`package.json · version` = `0.14.1`）。0.14.1 是**修缺陷**：客户端半的 `registerRosterSection` 把整段注册包在 `ctx.inject(['settingsScope','slots'], …)` 里当门，门不满足就静默跳过 ⇒ 0.11.0–0.14.0 三版的「设置 → 群聊」页在设置侧栏里从未出现过。现在改成一事不做地直接 `slots.inject('settings.section', …)`，`settingsScope` 就地 `ctx.get` 取（取不到也注册、页面自己显示不可用）；顺带去掉 `registerPanel` 里同样多余的 `inject` 守卫。逐条见 `CHANGELOG.md · ## [0.14.1]`。
- **0.14.1 什么都没动，只改了注册体的写法**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **53** 个标量键、`lib/` 仍 **14** 个文件。测试 410 → **413**（`test/panel.test.mjs` 加 3 例），并把 `test/halves.test.mjs` / `test/ui-contract.test.mjs` 里「注册条目恰好 2 个」的旧断言改成按 id 取。
- **`0.14.0`**：加的是**左侧栏的一个入口与它的只读页**：点开显示**当前会话**的编队（父级 + 每个直接子智能体，逐行给上下文大小与构成）与群聊（房间角色位、未投递、成员、未完成任务），逐条见 `CHANGELOG.md · ## [0.14.0]` 与 `docs/design-fleet.md · §8`。
- **0.14.0 没动线格式**（核对值与 0.13.0 **完全相同**）：新页只读 wire 里已有的 `fleet` 与 `room` 两个顶层键，`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` `lib/client.js · :86` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **53** 个标量键。测试新增 15 例（`test/panel.test.mjs`），总数 395 → **410**。
- **0.13.0 动了线格式**（这是与 0.10.0/0.11.0/0.12.0 三版不同的地方，核对值必须换新）：`TURBO_STATE_VERSION` `lib/state.js · :34` **11 → 12**，客户端 `EXPECTED_V` `lib/client.js · :86` **11 → 12**，wire 顶层键 **37 → 38**（新增 `fleet`；`ledger` 仍不进 wire）；`lib/state.js · DEFAULT_CONFIG` 仍 **53** 个标量键（编队没有配置项，`cordis.patch.yml` 不动）。测试新增 18 例（`test/fleet.test.mjs`），总数 377 → **395**。
- **0.12.0 没动线格式**（核对值在 0.10.0/0.11.0/0.12.0 三版相同、到 0.13.0 才换）：那一版加的是名册角色位的「工作区」与「Agent 预设」，走的是 DSH 设置存储与会话 header 的 `meta`，wire 顶层键仍是 37、还是 11。
- **0.11.0 改了 `package.json · dsh.client`**：新增 `inject: ["@deepseek-ai/dsh-client-modules", "@deepseek-ai/dsh-client-ui-settings"]`（设置页要用 `settingsScope` 与 `settings.section`）。`dsh.bundle.patch` 与 `dsh.client.platform` 保持原样（0.12.0 未再动这两个）。
- 版本沿革以 `CHANGELOG.md` 为准（`CHANGELOG.md · 首行 @ :1` 逐字「# Changelog（本文件自 0.5.0 起维护）」）；本文只登记**装机口径**，不复制沿革。
- **包名已从 `dsh-turbo` 改为 `dsh-status-turbo`**（`CHANGELOG.md · @ :46-52`：npm 上已存在同名的另一个插件）。装机侧据此换键：profile `package.json` 的 `dependencies["dsh-status-turbo"]`，旧键 `dsh-turbo` 必须同时移除，否则会出现两个状态条。
- **`files` 必须含 `CHANGELOG.md`**（`package.json · files @ :22-33`）。漏了它，发布包里就没有变更记录。
- 其余字段一律不动：`scripts` 仍只允许 `test`（G1 零构建护栏）。
- **0.11.0 没动 `cordis.patch.yml`**（名册不是 cordis 配置项，是设置存储里的用户数据）：`lib/state.js · DEFAULT_CONFIG` 仍 53 个标量键，镜像纪律断言不变。0.10.0 动过它（加了 13 个 `room*` 扁平键，40 → 53），别把两版结论混起来。**0.12.0 同样没动它**（工作区与预设进的是 DSH 设置存储与会话 header 的 meta），**0.13.0 也没动它**（编队没有配置项），**0.14.0 同样没动它**（新页面一个配置项都没有）：四版都是 53 个标量键。

升版后自检（不依赖 PowerShell 的 `Get-Content`，见文末环境陷阱）：

```bat
cd /d D:\project\dsh-turbo
node -e "const fs=require('node:fs');const j=JSON.parse(fs.readFileSync('package.json','utf8'));console.log('version',j.version,'files',j.files.join(','),'scripts',Object.keys(j.scripts).join(','))"
```

---

## 2. 打包（可复跑）

```bat
cd /d D:\project\dsh-turbo
npm pack --pack-destination dist
```

- 产物：`D:\project\dsh-turbo\dist\dsh-status-turbo-0.21.1.tgz`（文件名 = `<package.json · name>-<version>.tgz`。注意包名已改为 `dsh-status-turbo`，`§1` 有换名原因）。
- **干跑预览**（不落盘，只列将进包的文件清单，最适合核对 `CHANGELOG.md` 是否进包）：

```bat
cd /d D:\project\dsh-turbo
npm pack --dry-run
```

- 记录产物指纹（装机后要用它核对，§5）：

```bat
cd /d D:\project\dsh-turbo
node -e "const fs=require('node:fs'),c=require('node:crypto');const b=fs.readFileSync('dist/dsh-status-turbo-0.21.1.tgz');console.log('bytes',b.length,'sha256',c.createHash('sha256').update(b).digest('hex'))"
```

**`dist/` 只放当前版本的产物。** 历史 tgz 不要在这里堆（回滚靠 profile `.plugin-specs\` 里的历史包，§3 第 1 步，它们不会被安装动作改写）。
注意 `dist/` **未被 git 跟踪**（本仓库整个工作树都未纳入版本控制），删任何文件前先打印解析后的绝对路径确认。

---

## 3. 装机两步（**都由人执行**）

profile 根目录：`D:\deepseek-harness\profiles\desktop`；插件包投放目录：`D:\deepseek-harness\profiles\desktop\.plugin-specs`。

**第 1 步 —— 把 tgz 放进 profile 的 `.plugin-specs\`：**

```bat
copy /y D:\project\dsh-turbo\dist\dsh-status-turbo-0.21.1.tgz D:\deepseek-harness\profiles\desktop\.plugin-specs\
```

该目录与历史包并列存放（0.6.x 时代实测清单：旧名 `dsh-turbo-0.1.0` … `0.4.1`，换名后 `dsh-status-turbo-0.6.0` / `0.6.1` / `0.6.2`；其后版本依次并列）。

**第 2 步 —— 在插件管理器里安装（本机 profile = `desktop`）：**

```
plugin_manager install_bundle file:D:/deepseek-harness/profiles/desktop/.plugin-specs/dsh-status-turbo-0.21.1.tgz
```

- 成功回执形如 `docs/design.md · §5.1 @ :496-498`：
  `{"stage":"enable","target":"dsh-status-turbo","enabled":true,"application":"applied","bundle":"dsh-status-turbo","packageResult":{"exitCode":0},"warnings":[]}`。
- **升级版后预期 `{"changed":true,"application":"restart-required"}`**；若拿到 `ambiguous-install`，说明版本号没升（回到 §1）。
- 该动作会改写 profile 的 `package.json`：`dependencies["dsh-status-turbo"]` 指向最新 tgz（`docs/design.md · §5.1 @ :505`）。**这是安装动作的正常结果，不是故障。**

---

## 4. 完全重启（不是保存）

1. 改完 `cordis.patch.yml`（仓库的或 profile 的）后，**完全重启** DSH。
   **严禁**依赖"保存即热重载"：`docs/acceptance.md · §8 @ :241-243` 逐字「`cordis.patch.yml` 的热重载会确定性地崩宿主，报
   `agent "<uuid>" cannot read inbox state: its projection registration is not active`」。
2. `install_bundle` 返回 `restart-required` 之后同样要**完全重启**，新版本才在界面上生效。
3. 重启后若要归档证据，按 `docs/acceptance.md · §8 @ :247-254` 的人工清单走（截图 / 故障诊断文案 / `statusBar:false` 复验）。

---

## 5. 装机后核对（四条）

**① 装好的 `node_modules\dsh-status-turbo` 与仓库逐文件同哈希（双向：缺文件与内容不符都算失败）：**

```bat
node -e "const fs=require('node:fs'),cr=require('node:crypto'),p=require('node:path');const A='D:/project/dsh-turbo',B='D:/deepseek-harness/profiles/desktop/node_modules/dsh-status-turbo';const j=JSON.parse(fs.readFileSync(A+'/package.json','utf8'));const walk=(d,r='')=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p.join(d,e.name),r+'/'+e.name):[r+'/'+e.name]);const pub=j.files.flatMap(f=>fs.statSync(A+'/'+f).isDirectory()?walk(A+'/'+f,'/'+f):['/'+f]).concat(['/package.json']);const h=f=>cr.createHash('sha256').update(fs.readFileSync(f)).digest('hex');const inst=walk(B).sort();const bad=pub.filter(f=>!inst.includes(f)||h(A+f)!==h(B+f)).concat(inst.filter(f=>!pub.includes(f)));console.log('published',pub.length,'installed',inst.length,'mismatch',bad.length);console.log(bad.join(' ')||'-');if(bad.length)throw new Error('NOT identical')"
```

判定：`mismatch 0`，且 `published` 应等于 `npm pack --dry-run` 报的 `total files`（**该数字随 `files` 白名单下的文件数变化，一律以本次干跑现场打印的为准，本文不写死**）。
列表里出现路径即表示「装好的副本与仓库不一致（缺文件或内容不同）」——**这是升版失败或 tgz 没换的典型症状**（反向对照：profile 里现装 `0.4.1` 时本命令报 `mismatch 21` 并抛错，说明这个检查是活的）。

**② `dsh.profile.bundles` 数量不变：** 装机前后 `D:\deepseek-harness\profiles\desktop\package.json · dsh.profile.bundles` 应保持同一批次的同一数量（`docs/design.md · §5.1 @ :505`、`:509` 实测 0.6.x 时代为 **34** 项且含 `dsh-status-turbo`；以现场为准）。装机**只**应改写 `dependencies["dsh-status-turbo"]`，不应增删 bundle 列表。

**③ profile 自己的 `cordis.patch.yml` 不应被安装动作改写：** 装机前先记下它的大小，装机后比对。
`docs/design.md · §5.1 @ :510` 实测「首次安装前后同为 **4880 B**」⇒ 安装动作没有碰它；`:517-519` 如实记录了后来出现的一次 **+36 B** 变化（`4880 → 4916 B`），并给出结论「**这不是 dsh-status-turbo 造成的**——全文 0 处出现 `turbo`……最可能的解释是宿主做了 YAML 重新序列化，成因未证实」。因此核对口径是
**「安装动作本身不写它」**，而不是「这个文件永远不变」。

**④ 一条命令跑完上面几条的机器版核对：**

```bat
cd /d D:\project\dsh-turbo
node tools/verify-install.mjs
```

`tools/verify-install.mjs` 默认 profile `D:\deepseek-harness\profiles\desktop`（可用 `--profile <目录>` 换），全过 exit 0，未过 exit 1。它断言六条（条目即脚本 `:39-100`）：① 装好的 `package.json` 版本 === 仓库版本（`:42-43`）；② 装好的 `TURBO_STATE_VERSION` === 装好的客户端 `EXPECTED_V`（`:45-51`，0.18.0 起两半都应是 **13**）；③ 装好的 `DEFAULT_CONFIG` 标量与装好的 `cordis.patch.yml` 同值（`:53-71`，0.18.0 起为 **40** 个标量键，输出行形如「镜像纪律：40 个标量键与包内 cordis.patch.yml 同值」）；④ 装好的 `lib/` 文件清单 === 仓库 `lib/` 清单（`:73-76`，0.18.0 起共 **10** 个文件：群聊与编队四支随功能删除）；⑤ wire 视图 **37** 键且不含 `ledger`（`:78-86`）；⑥ 对着**装好的那份**再跑一遍 `tools/audit-gate.mjs --root <装好的副本>`（`:88-100`）。

**注意：装机之前跑它必然红——这是预期，不是故障。** profile 里装着的是上一版，① 会按上一版判（版本对不上）；其余五条的核对值（② 两半版本、③ 标量键数、④ `lib/` 文件数、⑤ wire 键数、⑥ 审计条目数）都可能与本文的现值不同，以现场输出为准。⇒ 装机口径是：**先按 §3 把本版装进 profile、按 §4 完全重启，再跑它**；此时六条应全过并打印「全部通过」。

---

## 6. 复跑测试（改动后必跑）

```bat
cd /d D:\project\dsh-turbo
node --test "test/*.test.mjs"
```

判据：**`fail 0`**，且 `ℹ tests` 总数不得低于上一版（**例外：整块删功能时总数必然下降，以现场 `node --test` 的输出为准并在此登记**）：0.5.0 = 149、0.6.1 = 171、0.6.2 = 175、0.9.2 = 254、0.9.3 = 271、0.9.4 = 293、0.10.0 = 357、0.11.0 = 373、0.12.0 = 377、0.13.0 = 395、**0.14.0 = 410**、**0.14.1 = 413**、**0.15.0 = 418**、**0.15.1 = 418**、**0.16.0 = 422**、**0.16.1 = 422**、**0.17.0 = 427**、**0.17.1 = 428**、**0.18.0 = 319**、**0.18.1 = 319**、**0.18.2 = 317**、**0.19.0 = 317**、**0.19.1 = 317**、**0.19.2 = 317**、**0.19.3 = 317**、**0.19.4 = 318**（0.19.4 新增客户端切会话正门一条用例；0.19.3 与 0.19.2 同数，本轮只改建会话入参与客户端重试；0.19.2 与 0.19.1 同数，本轮只改状态条口径与文档；0.18.2 把三支「面板 / 侧栏注册」用例并成一支新的，故 −2；0.18.1 与 0.18.0 同数，本轮只改注释与文档；0.18.0 删群聊/编队：四个测试文件与 10 条实例随功能删除、`test/panel.test.mjs` 重写为 24 条，故总数按设计下降；0.16.1 与 0.16.0 同数，本轮只修保存回执；0.16.0 加 4 例：`test/roster.test.mjs` 的"每个反射字段都标 volatile"与 `liveConfig` 两例、`test/panel.test.mjs` 的模板形状与套用深拷贝两例；0.15.0 加 5 例：`test/roster.test.mjs` 的 `turboConfigSchema` 与 `unwrapVolatile`、`test/panel.test.mjs` 的 `configForms` 绑定三例；0.9.3 新增 `test/handoff-orchestration.test.mjs`（3 条，交接导出的执行编排）与 `test/rotation-client.test.mjs`（8 条，客户端轮换执行体与 `auto` 触发点）；0.10.0 新增 `test/room.test.mjs`（纯语义：角色位 / 消息 / 游标 / 任务板 / 租约）与 `test/room-host.test.mjs`（宿主半：单写链、原子写、投递、换身、工具与命令接线）；0.11.0 新增 `test/roster.test.mjs`（16 条：名册规范化与查找、空 charter 兜底、投喂的信息主体行、`room_list` 名册概览、系统提示行——`rosterSchema` 用假 `z` 验形状，真实 schema 只在装好的 DSH 里可解析）；0.12.0 在同文件加 4 条：工作区/预设的规范化（相对路径与非法 id 丢成空串）、`personaWorkspaceFor` / `personaPresetFor`、`cwdFor` / `presetFor` 按角色位取值、无名册或非成员时为空串；0.13.0 新增 `test/fleet.test.mjs` 18 条：编队纯层（用量折算、裁剪上限、脏行丢弃、空视图）、宿主半（家族判据与排序、上限截断、服务缺席/会话不存在/单个投影抛错/父级不在表里四条降级路径）、客户端分区（可见性、文案、构成条分宽））；0.14.0 新增 `test/panel.test.mjs` 15 条：群聊分区与兜底（脏房间、脏任务、缺字段各就各位）、取数选择器（`selectCurrentSession` 的四种输入、`makeProjectionSelector` 的「有 / 没有 / 坏值」）、三态文案（没会话 / 投影未到 / 确实没家族）、页面渲染（`TurboFleetPage` 吃到 `projectionValues.turbo`）、图标与注册约束（同一 id、槽位抛错只让入口缺席））。**0.20.0 = 324**、**0.21.0 = 326**（0.21.0 新增设置页字段中文化与状态条复制话术各 1 条；本轮只补标签与话术，不改判据）、**0.21.1 = 326**（0.21.1 删掉自动写开场话术：改动落在既有用例的断言上，条数不变）（0.20.0 新增轮换子会话改名 2 条、等待态「立刻切」与「切过去并归档」3 条、只提醒 1 条）。**总数会随新增用例变化 —— 一律以本次现场 `node --test` 打印的 `ℹ tests` 为准，本文不写死将来值。** 打包与升版本不影响该命令，但**任何一次改动后都要复跑**。

---

## 7. 环境陷阱（本机实测）

- 本机 PowerShell 5.1 的 `Get-Content` / `Select-String` **会吞空行、行号偏小**，且默认编码读取 UTF-8 中文文件会乱码（`ConvertFrom-Json` 直接报 `传入的对象无效`）。⇒ 行号与 JSON 一律用 `read`/`grep` 工具或 `node` 来读（本节命令全部用 node，不用 `Get-Content`）。
- 上文的 `node` 一律指 PATH 上的 node（`node --version` 应满足 `package.json · engines` 的 `^22.19.0 || >=24.0.0`）。若 PATH 里没有，可回退到本机既有链接 `D:\environment\nodejs_link\node.exe`。
- 本仓库**未被 git 跟踪**，没有版本回退兜底；`dist/` 的删除动作前必须打印解析后的绝对路径并确认。
- 除本打包任务外**不跑任何 `git` 命令**。
