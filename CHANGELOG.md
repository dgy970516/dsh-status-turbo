# Changelog（本文件自 0.5.0 起维护）

本文件记录 `dsh-status-turbo` 的所有**已如实落地**的变化。格式沿用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

两条自我约束（先说清楚，避免下游把本文件当证据用错）：

1. **0.5.0 之前的条目是回溯补齐的**：本文件自 0.5.0 起才被维护，0.1.0–0.4.1 的条目依据仓库内既有的历史记录
   （`docs/design.md` 的版本表与测试计数、`dist/` 里的打包产物）回溯重写。**`docs/design.md` 没有记录的内容，这里一律不写**
   —— 宁可条目少，不猜。
2. **不写日期**：本机没有可靠的发布日期记录，宁缺勿造。**不写未实现的东西**：未落地的一律只留一行指针（见
   `## [Unreleased] · 未实现`）。

版本号口径：`package.json · version` 是版本的唯一权威。本文件在发布时把 `[Unreleased]` 改名为那一版的版本号。

---

## [0.21.2] —— 空闲态也有「复制话术」按钮（不改线格式，配置面 +0 键）

**症状**（用户 2026-10-17 原话）：「空闲状态，没有复制会话的 复制按钮，请你给我看看」。截图里状态条那一行只剩「空闲 · 上回合 7分17秒 / ⚠ 前缀已失效 / 详情」，行尾那个复制按钮在空闲态整个消失。

**根因**。`lib/client.js` 的 `statusBody()` 把 `CopyBriefButton` 的 push 写在 `if (!snapshot.busy) return clickableRow(...)` **之后**（改动前 L1340-1342）—— 空闲分支提前返回，那一格就永远走不到。而这段话术的用处恰恰是「这一轮完了，拿它去开新会话」，等于在最该用的时候把按钮藏起来。

**修法**：把该 push 提到空闲分支之前，与详情开关同一层；忙碌与空闲两条路径共用同一份 `extras`，不再各推一次。

**验证**：`node --test "test/*.test.mjs"` → **327 pass / 0 fail**（新增 1 条：空闲态行尾仍是复制话术按钮）。影响面：wire 顶层仍 37 键、`EXPECTED_V` 仍 13、配置面 +0 键、`lib/` 仍 10 个文件。

---

## [0.21.1] —— 新会话不再被自动填进开场话术（不改线格式，配置面 +0 键）

**症状**（用户 2026-10-16 原话）：「还有就是，为什么每次开启一个新会话，都会出现这个？这个应该改成手动复制，请你把这个开启新会话 自动填充这个的去掉。」截图里那个会话的标题与首条消息都是「继续旧会话 session-7b3a0f8d-…（工作目录 D:\project）…」，用户认不出它是自己开的还是插件开的。

**根因**。这不是输入框草稿预填，是**旧版本真的把话术写成了新会话的第一条 `user/message`**：0.20.0 之前 `rotationCreate` 默认为真，宿主建完空白子会话就调 `seedQuietly` 往它 `append` 一条 `user/message`（文字来自 `rotationSeedMessage` 模板），`rotationOpenChild: true` 又自动切过去 ⇒「每次开新会话都会出现这段」。证据：`rotation-trace.jsonl` 里 `outcome: 'armed'` 的 `childId` 去重后 **32** 个（最后一条 `armed` 是 10-15 19:57:53），磁盘上还剩 **26** 个会话目录；10-16 00:51 装上 0.20.0 重启后，轨迹里只有 `idle` / `remind`（每小时数十条），**再也没有建过会话**。另：插件的客户端半从不碰输入框（`lib/client.js` 里 `setDraft` / `prefill` / `autofill` 零命中），所以这与「草稿自动填充」无关。

**修法**（用户同轮拍板：「顺手也去掉：create 模式建出来的会话也是空白」＋「挪走：移到回收目录，可恢复」）。
- 宿主半（`lib/rotation-host.js`）：删掉两处 `seedQuietly` 调用（异步分支、同步退路）与 `seedQuietly` / `seedMessage` 两个函数 —— 建出来的会话**一个字都不写**。`rotationSeedText` / `rotationSeedMessage` / 设置页话术卡 / 状态条「复制话术」都留着：那段文字现在的唯一角色是**给人手动复制**。
- 轮换记录与 wire：`armed` 不再带 `seedOk`（`lib/state.js` 的 `rotationRecord` 去掉该字段、`lib/index.js` 去掉三处管道），`seedText` 保留 —— 它是 wire 里 `newSession.text` 的来源。
- 客户端半（`lib/client.js`）：删掉 `seedNote` 与 `rotation.seed-ok` / `rotation.seed-failed` / `rotation.reason.seed-failed` 三条文案；`lib/rotation.js` 删掉 `ROTATION_MESSAGE.SEED_FAILED`。

**验证**：`node --test "test/*.test.mjs"` → **326 pass / 0 fail**（改动落在既有用例的断言上：原来断言「子会话里有一条开场话术」的用例，现在断言「子会话里**没有**任何消息」）；`node tools/audit-gate.mjs` → **53 条，未过 0**。行为上：`rotationCreate: true` 建出来的也只是**空白**会话。

**影响面**：wire 顶层仍 **37** 键、`TURBO_STATE_VERSION` 仍 **13**、配置面 **+0** 键、`lib/` 仍 10 个文件；10-14 / 10-15 建出的 26 个旧子会话已按用户选择**移进回收目录**（可恢复，未删除）。

---

## [0.21.0] —— 设置页说人话、状态条给出「复制这一段」按钮（不改线格式，配置面 +0 键）

**症状**（用户 2026-10-16 同屏两问，原话）：「能不能换成中文描述的？还有就是这个状态信息 添加一个复制的按钮…复制的话术可以如下：当前会话的会话名称+会话id+会话日志目录+继续处理未完成的任务」。截图里的「全部设置项」页字段名全是原始键名（`handoffExportWindowPercent`、`rotationRequireIdle`、分组头写成 `other`），而状态条那一行没有任何把当前会话交接出去的手段。

**根因**。①字段名走的是 `ConfigSection` 里的 `text(\`settings.field.${key}\`, key)` —— 兜底值就是**键名本身**，而 `makeText` 只在词典命中且值非空时才采用词典值，所以「词典里没有」与「词典里的名字写错了」都会原样吐键名。词典本身还欠账：有两条用的是旧名（`rotationMode` 对不上真键 `rotation`、`archiveOld` 对不上 `rotationArchiveOld`），另有 16 条真键一条都没有。分组头同理（`settings.group.other` 缺条目 ⇒ 屏幕上是英文 `other`）。②复制话术的三个数据源里，会话名称与会话日志目录**根本没进 wire** —— 客户端拿不到，只能显示会话 id。

**修法**。
- 客户端半（`lib/client.js`）：新增 `textOf(text, key, hard)` —— **先查 `DICT.zh` 再退硬编码兜底**（`makeText` 的兜底在调用点，等于永远不查词典，这正是键名漏出来的机制）；`ConfigSection` 的组头与字段标签全部改走它。补全词典：48 个配置键、7 个分组头一条不落，并把 `rotationMode` / `archiveOld` 订正为 `rotation` / `rotationArchiveOld`。
- 宿主半（`lib/index.js`）：wire 的 `newSession` 增补 `title`（`ctx.sessionTitle.get`，缺席 / 无标题给空串）与 `logDir`（用 `dsh-session-persistence-jsonl` 同一套 `projectKey` + `encodeSegment` 规则拼出 `<DSH_HOME>/sessions/<projectKey>/<encodeSegment(id)>`；没有工作目录给空串，绝不猜路径）。**wire 顶层仍是 37 键**（只动了 `newSession` 的内部字段）。
- 客户端半新增纯函数 `sessionCopyTextOf(view, text)` 与 `CopyBriefButton`：话术固定四行 —— `会话名称：…` / `会话 ID：…` / `会话日志目录：…` / `继续处理未完成的任务`；**值为空就整行省掉**（不留空占位）。按钮**始终渲染** —— 最差情况（宿主没发 `newSession`）也能复制到最后那句「继续处理未完成的任务」，而这正是交接要的那一句。按钮落在状态条折叠开关左边（状态条原本就是那一行的最后一个 `children`）。

**验证**：`node --test` **326 pass / 0 fail**（新增两条回归：宿主 `wire.view` 的 `newSession.title` / `logDir` 取值与「没有 cwd 不许编路径」；客户端 `sessionCopyTextOf` 的四行齐全 / 缺项省行 / 连投影都没有三态）；`node tools/audit-gate.mjs` 全 53 条未过 0。线格式没动：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键；`DEFAULT_CONFIG` 仍 **48** 键、`lib/` 仍 **10** 个文件。证据与推导见 `docs/design.md · 15.6`。

## [0.20.0] —— 默认只提醒、状态条搬到输入框上方、子会话认得出是谁开的 + 等待态有出口（不改线格式，配置面 +2 键）

**症状**（用户 2026-10-15 三问之一、之二，原话）：「新的会话名称是否可以和旧会话的描述名称一致？现在导致很乱 不知道这个会话是哪个会话新开的」、「开启新的会话，是否可以等待当前会话执行完？或者关闭当前会话？」。落到界面上是两件事：①每一代轮换子会话的名字都是同一条被截断的开场话术（`继续旧会话 session-xxxx…`），分不出谁是谁新开的；②`auto` 模式下若当前回合一直不空闲，面板那一行永远停在「新会话已就绪 · 等当前回合结束再切」，而它**不可点** —— 既不能立刻切过去，也没有「关掉当前会话」的出口。

**根因**。①0.9.0 起轮换是**空白新建**（不是 `fork`），子会话没有任何标题事件，`session-title` 的回退只能拿**首条 `user/message`** 截断成标题 —— 而那条恰恰是每一代一模一样的种子模板。0.8.0 的 `rotationIncreaseTitle` 曾按源标题做 `(N)` 递增，0.9.0 废掉 fork 后失去载具，键被删。②`lib/client.js · rotationSection` 的可点判据是 `shown === 'armed' && mode !== 'auto'`，恰好把「auto 且正在等空闲」这个唯一需要人工出口的状态排除在外。

**修法**。①宿主半（`lib/rotation-host.js · retitleQuietly`）：建好子会话、写完种子消息后，读旧会话的持久化标题（`ctx.sessionTitle.get(sessions.get(旧 id))`），按官方 `sessions.fork({ increaseTitle: true })` 的同一套约定递增（尾部 `(N)` / `（N）` 保留括号样式递增，其余追加 ` (1)`），再 `ctx.sessionTitle.rename(子会话, 名字)` —— 写进去的是 `source: { kind: 'user' }` 的 `session/title` 事件，会把标题钉住，回退生成不再覆盖它。新配置键 `rotationIncreaseTitle`（默认 `true`，与 0.8.0 同名同义）；服务缺席 / 没有标题 / 改名失败一律只降级，结果写 `rotation-trace.jsonl` 的 `titleOk` / `title` / `titleReason`（不改 wire）。②客户端半（`lib/client.js`）：等待态那一行**改为可点**（点击 = 立刻切过去，不必等这一轮跑完），并多一行「切过去并归档当前会话」（`performRotation(snapshot, { force: true, archiveOld: true })`，`archiveOld` 现在可被调用方显式覆盖）。

**同日追加**（用户原话）：「1. 去掉你的 新会话生成；更改为提醒，目前点一个会话 生成一个新的会话 麻烦又乱 2. 目前底部状态栏 都拥挤在一起了。是否可以调整到输入框的上面？」：

**① 默认只提醒，不再自动建会话**：新配置键 `rotationCreate`（默认 `false`）。`lib/index.js · noteRotation` 在原来调用 `runRotationAction` 之前加一道闸：`shouldRotate` 判据照旧（「到量」仍被认出来，阈值与新鲜度门和 `armed` 同源），但 `rotationCreate !== true` 时只 `pushRotation({ status: ROTATION_STATUS.REMIND, … })`、写一行 `rotation-trace.jsonl`（`outcome: 'remind'`）后返回 —— 不建会话、不挂工作区、不切界面。客户端把这一行显示成「已到轮换阈值 · 建议开新会话（开场话术在设置页可复制）」，状态条那一格同步显示「建议开新会话」。想恢复 0.19.x 的自动建会话，把它设成 `true`（键另起而不是改 `rotation` 的默认值：profile 的用户层已经显式写了 `rotation: 'auto'`，改默认值不生效）。坑一处：`status` 的白名单在 `lib/state.js · ROTATION_STATUSES`（不是 `lib/rotation.js`），不在表里的值会被 `rotationRecord` 静默改写成 `idle` —— 第一版闸门确实进了、`remind` 也确实 push 了，落盘却是 `idle`。

**② 状态条搬到输入框上方**：`lib/client.js` 的 `SLOT` 从 `conversation.composer.dock`（原生底部状态行那一格，与自动继续 / 完全权限 / 专家团 / 模型与推理档挤在一行）改成 `conversation.input.dock`（目录描述 "Full-width entries above the composer card"，即输入框上方那条全宽带）—— 详情面板本来就在这一格，两条各自占一行。

**验证**：`node --test` **324 pass / 0 fail**（0.19.4 的 318 + 轮换改名 2 条 + 等待态出口 3 条 + 只提醒 1 条）；`node tools/audit-gate.mjs` 共 53 条未过 0。线格式没动：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键；`DEFAULT_CONFIG` **46 → 48** 键（`rotationIncreaseTitle`、`rotationCreate`）。

## [0.19.4] —— 修缺陷：切会话改用客户端正门 `uiWorkspace.openSession`（不改线格式、不动配置面）

**症状**（用户截图）：详情面板「会话轮换」一行长期写着「轮换失败 · 宿主拿不到 sessions 服务（缺席，不是故障）· 点这里重试」；新会话已经在左侧列表里了，却仍需用户自己点一下才切过去。

**根因**：客户端半一直在调 `sessions.open(childId)`。本机客户端运行时（0.2.0-rc.2）的 `sessions` 服务面只有 `retain` / `using` / `retainInfo` / `refreshProjections` / `search` / `fork` / `scope` / `binding` —— **没有 `open`**（活体目录：`cordis_inspect_query(platform=client, provider=Service, method=listService, input={service:'sessions'})`）。于是 `performRotation` 的守卫每次都判失败、落一条 `failed` / `reason: 'no-service'` 就返回，一次也不切。切会话的**正门**是 `uiWorkspace.openSession(target)`（同一份活体目录；`dsh-client-ui-workspace/lib/client.js:821` 的实现是 `replaceMain(target, …)`）。

**修法**（只在客户端半 `lib/client.js`）：
- `performRotation` 先取 `uiWorkspace`：有 `openSession` 就用它，否则回落旧的 `sessions.open`；两个都没有才记 `no-service`（缺席，不是故障）。
- `openWithRetry` 收的口子改成「一个函数，或一个带 `open` 的服务」；重试节奏不变（500ms × 40）。
- `rotation.reason.no-service` 的文案改成客户端口径（原来写「宿主拿不到 sessions 服务」，指的其实是客户端）。

**验证**：`node --test` 318 pass / 0 fail（`test/rotation-client.test.mjs` 新增一条：有 `uiWorkspace.openSession` 时用它、且不再碰 `sessions.open`）；`node tools/audit-gate.mjs` 共 53 条未过 0。证据与推导见 `docs/design-rotation.md · 附：0.19.4 补记`。

## [0.19.3] —— 修缺陷：新会话带着模型与 preset 建出来，并自动切过去（不改线格式、不动配置面）

**症状**（用户截图）：轮换建出的新会话确实出现在左侧列表里了（0.19.1 的工作区挂载生效），但两件事不对 —— ①它一跑就是「本轮运行失败 `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`」；②还得用户自己点一下那一行才会切过去。

**根因**：①`agents.create` 没带 `agentOptions`，子代理没有 `provider` / `model` —— 系统提示的部署级 persona 段（含 `{{model}}`）取值时是 `undefined`，渲染直接抛错；旧会话那套 preset 组合也没挂。②`lib/client.js` 的打开重试只等 `ROTATION_OPEN_RETRY_MS` 300ms × `ROTATION_OPEN_RETRY_LIMIT` 10 ≈ 3 秒，而子会话要过「代理生命周期建会话 → 挂进工作区 → 客户端列表收到」两跳。

**修法**：
- 宿主半 `lib/index.js`：`noteRotation` 现在取旧会话正在用的模型（`agents.get(id).options`，回落 `agentDefaultModel.currentSelection()`）与旧会话的 `agentPreset`，一并传下去；新增两条依赖边 `ctx.inject(['agentDefaultModel'], …)` / `ctx.inject(['agentPresets'], …)`（取不到只降级，不阻断插件）。
- `lib/rotation-host.js`：`createChildQuietly` 在 `agents.create` 入参上补 `agentOptions`，有 preset 时挂 `setup: async (agentCtx) => agentPresets.mount(agentCtx, preset)`（和宿主自己建会话同形）。
- 客户端半 `lib/client.js`：打开新会话的重试放宽到 500ms × 40（约 20 秒），让它挺过那两跳。

**验证**：`node --test` 317 pass / 0 fail；`node tools/audit-gate.mjs` 共 53 条未过 0。逐条见 `docs/design-rotation.md · 附：0.19.3 补记`。

## [0.19.2] —— 观感：状态条改紧凑写法（不改线格式、不动配置面）

**症状**：用户截图点名「你优化修复一下把。这个太丑了」—— 状态条那一格和邻居挤在一起：`执行 sh_exec · 2 分 49 秒 · 本步 4.2K tok · 档位 low`，中文又长又碎，右侧还与原生那行的内容叠字。

**修法**（全在客户端半 `lib/client.js`，宿主投影一个字没动）：
- 耗时改紧凑写法：新增纯函数 `fmtElapsedCompact(ms)`（`123ms` / `5s` / `2:49` / `1:02:03`）；阶段 pill 与告警 pill 都改用它，完整中文写法退到 `title`。
- 本步 token 只留数量：`本步 3.1K tok` → `3.1K tok`（悬停仍是「本步 token 3.1K」）。
- **档位 pill 从状态条撤掉**：原生那行的推理档选择器已经写着同一个值（`LOW`），重复最占地方；档位仍留在详情面板的档位行。
- 无进展告警只留四个字：`工具仍在运行，只是还没有新输出` → `无新输出`，`已长时间没有新进展` → `无新进展`；判据全文与阈值退到 `title`。
- 字典相应增删：新增 `stall.toolShort` / `stall.otherShort` / `label.phaseElapsed`（zh + en），删掉不再引用的 `unit.step` / `unit.gear`。

**验证**：`node --test` = **317 pass / 0 fail**（`test/halves.test.mjs` 的状态条断言改到紧凑口径）；`node tools/audit-gate.mjs` = **共 53 条，未过 0 条**。

**没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键、`lib/` 仍 **10** 个文件。

## [0.19.1] —— 修：轮换建出的子会话现在会挂进工作区，左侧列表里看得见（不改线格式、不动配置面）

**症状**：0.19.0 之后子会话确实落了盘（`sessions/` 下有日志目录、投影缓存里有它），但**左侧会话列表里还是找不到**：2026-10-14 20:36 建的 `session-20bb5825-…` 在 `storages/workspace.json` 里没有任何工作区把它列进 `sessionIds`。

**根因**：列表不是扫磁盘得到的，是各工作区的 `sessionIds` 列出来的（`dsh-workspace` 的 `get sessionIds()` 再按 `host.sessionPath(id) === record.path` 过滤）。宿主自己的新建 / 分叉路径都会在建完后 `workspace.attachSession(sessionId)`（`dsh-api-session-controller` 的新建与 fork 两支），轮换这条路只做了 `agents.create`。与 0.19.0 是两个独立缺陷：那一次是「没写句柄所以不落盘」，这一次是「落了盘但没挂工作区」。

**修法**：
- `lib/rotation-host.js` 新增 `attachChildQuietly(io, childId, cwd)`：在 `agents.create` 的 promise 落地后跑 `workspaceRegistry.resolveByPath(cwd)`（规范路径精确比对，找不到就不挂），命中则 `entity.attachSession(childId)`（它自己读会话 header 的 cwd 校验同一目录）。
- 结果字符串 `attached` / `no-registry` / `no-workspace` / `resolve-failed` / `attach-failed` 进 `rotation-trace.jsonl` 的 `attach` 字段；不是 `attached` 时另写一行 warn（这一步以前完全无声）。
- `lib/index.js` 新增 `ctx.inject(['workspaceRegistry'], …)` 接线，`run.workspaces` 取不到不阻断插件（只少一步挂载：会话照样落盘、照样播种）。
- 依赖表新增 `workspaceRegistry` 一条边（`test/halves.test.mjs` 逐字锁死顺序）。

**验证**：`node --test` = **317 pass / 0 fail**；`node tools/audit-gate.mjs` = **共 53 条，未过 0 条**。活体确认要靠用户重启后的下一轮到量轮换（新子会话应同时出现在 `sessions/` 与左侧列表）。

**没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键、`lib/` 仍 **10** 个文件。

## [0.19.0] —— 修：到量轮换建出来的子会话现在真的落盘、在会话列表里可见（不改线格式、不动配置面）

**症状**：0.17.1 把轮换的服务取法修好之后，落盘痕迹 `rotation-trace.jsonl` 证明它**确实在按字节阈值建会话**（2026-10-14 当天 6 次 `armed`，每次 `sessions:"present" / sessionsFrom:"inject" / outcome:"armed" / message:null`），但用户始终看不到「自动开的新会话」：那 6 个子会话 id 在 `sessions/` 全树都没有日志目录，只活在内存里，`storages/session_projcache/` 里那条缓存还是本插件投影写进去的。界面上自然什么都看不到。

**根因**：`ctx.sessions.create` 是在代理生命周期**之外**「发布」一个会话 —— `dsh-session` 原文：*a session published outside that lifecycle persists nothing*。持久化层（`dsh-session-persistence-jsonl`）只给生命周期里发布的会话挂写句柄（`writers.get(session.id)`），没有句柄的会话事件被静默丢弃；`ctx.agents.create` 才会「构造并发布代理」，写句柄随之挂上。

**修法**：
- `lib/rotation-host.js` 新增 `createChildQuietly()`：优先 `ctx.agents.create({ sessionId, meta })`（代理生命周期），拿不到 `agents`、或它抛错、或它没返回 thenable 时退回原来的 `ctx.sessions.create`。
- 这条路是**异步**的（会话对象要等 promise 落地），所以 `runRotationAction` 在异步分支返回 `via:'agents'` + 非空 `pending`，种子消息（配置项 `rotationSeedMessage`）排到那个 promise 后面再写；落地结果（成功 / 失败与原因）追加一条 `rotation-trace.jsonl`，失败还会记一行 warn。
- `lib/index.js` 把 `ctx.inject(['agents'], …)` 加回接线（0.18.0 删群聊时一并删掉了），`run.agents` 取不到不阻断插件（退回内存会话的老路）。
- 依赖表加回 `agents` 一条边（`test/halves.test.mjs` 逐字锁死顺序）。

**验证**：离线重放（`D:\deepseek-harness\profiles\desktop\_replay-rotation.mjs`，真实会话 `session-759e62dc-…` 的 4353 条事件、把 `Date.now` 钉在最后一个事件时间）现在打印 `agent creates = [{sessionId:"session-d2bdbd97-…", meta:{cwd, parentSession}}]`、`created sessions = []`（不再走 `sessions.create`），种子正文就是填好 `{old}` / `{cwd}` 的开场话术。

**没动线格式，也没动配置面**：`TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 仍 **10** 个文件；测试 **317**。

## [0.18.2] —— 改：左侧栏入口撤掉，开场话术卡并进设置页（不改线格式、不动配置面）

**症状**：0.18.0/0.18.1 把「新会话」页同时注册成**主面板页**（`main`）与**左侧栏入口**（`sidebar.panellist`），左侧栏因此多出一个常驻按钮；而且那一页得靠 `main` 槽位的 `useSessions` 才拿得到投影。用户点名要求去掉左侧栏那个按钮。

**修法**：
- `lib/client.js`：删掉 `registerPanel`（`sidebar.panellist` 图标注册 + `main` 主面板页注册）、`PANEL_SLOT` / `MAIN_SLOT` / `PANEL_ORDER` 三个常量与 `apply` 里对应的 `disposers.push(...)`，`__test` 不再导出 `registerPanel`；`registerSettingsSection` 那一格改成 `h('div', {key:'dsh-status-turbo.settings.page'}, [h(ConfigSection, …), h(TurboNewSessionPage, …)])` —— 配置表单在上、开场话术卡（轮换状态 + 工作目录 + 可复制的开场话术）在下，两件事同一页。
- 组件本身一个字没改：`TurboNewSessionPage` / `NewSessionPanelIcon` / `newSessionCardOf` / `copyText` / `fallbackCopy` 全部保留（图标仍导出，只是不再挂到左侧栏）。
- `README.md` / `README.zh.md` / `docs/design.md`：把「左侧栏那一页 / 主面板页」的措辞改成「插件设置页里的新会话话术卡」。

**线格式 / 配置面**：一个字都没动 —— `TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键、`lib/` 仍 **10** 个文件、`cordis.patch.yml` 仍 **46** 键。

**测试**：`node --test` = **317 pass / 0 fail**（0.18.1 是 319：三支「面板 / 侧栏注册」用例并成一支新的「设置页里同时挂配置表单与话术卡」）；`node tools/audit-gate.mjs` = **共 53 条，未过 0 条**。

## [0.18.1] —— 修：0.18.0 的注释与文档口径（不改行为、不动线格式）

**症状**：0.18.0 装上前复核发现两处口径不一致，且都不影响运行、只影响判据与文档可读性 —— ① `lib/state.js · :1684` 的 v13 说明写「键数 37 → 35」，与实测相反（**v12 = 38 键、v13 = 37 键**）；② 两份 README 与 `docs/design.md` 仍停在 0.14.0–0.17.0 的「房间与任务板 / 名册 / 编队 / 侧栏入口」口径，与 0.18.0 的整块删除不一致。

**修法**：
- `lib/state.js`：v13 说明改成「键数 38 → 37」（纯注释）。
- `README.md` / `README.zh.md`：「房间与任务板 / 名册 / 编队 / 侧栏入口」整段换成「新会话页（0.18.0）」（开场话术卡、复制按钮、工作目录、`NewSessionPanelIcon`）；wire 段改成 `v: 13` / 37 键并写明顶层 `newSession`；配置表删净 13 个 `room*` 行、键数改成 46，并补上原先缺的 `readOnlyTools` 与 `handoffExportTimeoutMs`；开发段与目录清单删掉已删文件条目。
- `docs/design.md`：§15.6「房间与任务板」+ §15.7「名册/编队/侧栏」合并成新的 §15.6「0.18.0：新会话页与开场话术（wire v13）」，§15.5 当前值表按实测重写，§8 的房间库落盘条目删除（落盘只剩交接文档一处）。
- `docs/design-rotation.md` / `docs/audit-0.9.2-experts-raw.md`：各一处已消失的「名册」措辞改成现状。

**线格式 / 配置面**：一个字都没动 —— `TURBO_STATE_VERSION` 仍 **13**、`EXPECTED_V` 仍 **13**、wire 顶层仍 **37** 键、`DEFAULT_CONFIG` 仍 **46** 个键、`lib/` 仍 **10** 个文件、`cordis.patch.yml` 仍 **46** 键。

**测试**：`node --test` = **319 pass / 0 fail**（与 0.18.0 同数）；`node tools/audit-gate.mjs` = **共 53 条，未过 0 条**（P1-10 的 20 处 0.7./0.8./0.9. 命中、P0-D 首行定案、两份 README 的 `rotationRequireIdle` / `handoffExportMaxPerProcess` 锚点全绿）。
## [0.18.0] —— 删：群聊与编队整块去掉；主线改成「新会话」页 + 可直接复制的开场话术

**诉求（用户原话）**：「如果插件做不到这个，是否可以只需要检测和提供新会话的话术 让我直接复制就可以了。另外就是你把 群聊相关的 去掉一下，我发现这个有点鸡肋了」；随后明确「专职于 新会话的开启和使用」。

**删除（整块，不留死代码）**：
- 群聊房间与任务板（0.10.0）：`lib/room.js`、`lib/room-host.js`、11 个 `room_*` 工具、`/room` 命令、13 个 `room*` 配置键、设置里的「群聊」页。
- 编队视图（0.13.0）：`lib/fleet.js`、`lib/fleet-host.js`、wire 顶层 `fleet`、左侧栏页里的编队分区。
- 名册（0.11.0）：`lib/roster.js`、`groups` 配置面、设置页的名册编辑区（`turboConfigSchema` / `liveConfig` / `unwrapVolatile` 迁到新的 `lib/config.js`，零 import）。
- 测试：`test/room.test.mjs` / `test/room-host.test.mjs` / `test/roster.test.mjs` / `test/fleet.test.mjs`，以及散在其它文件里的 10 条已删功能实例。

**新增**：wire 顶层 `newSession`（`lib/state.js · newSessionViewOf(state, config)` → `{ text, oldId, cwd }`；`text` 由既有配置项 `rotationSeedMessage` 填好 `{old}` / `{cwd}`，配置留空回落默认模板）；左侧栏那一页从「编队与群聊」改成「新会话」：当前会话的轮换状态（沿用既有 `rotation` 记录）+ 工作目录 + **开场话术卡**（一键复制：`navigator.clipboard.writeText` 优先，只读 `textarea` + `execCommand('copy')` 兜底；成功显示「已复制」，失败提示手动选中）。

**线格式 / 配置面**：`TURBO_STATE_VERSION` **12 → 13**、`EXPECTED_V` **12 → 13**、wire 顶层 38 → **37** 键（删 `room` / `fleet`，加 `newSession`）、`DEFAULT_CONFIG` 59 → **46** 个键（40 个标量 + 6 个字符串数组）、`lib/` 14 → **10** 个文件、`cordis.patch.yml` 59 → **46** 键；`docs/design-room.md` / `docs/design-fleet.md` 随功能删除。（`docs/design-room.md` / `docs/design-fleet.md` 随功能删除，历史条目与旧版打包文档里指向它们的引用随之失效）

**测试**：`node --test` = **319 pass / 0 fail**（总数按设计下降：0.17.1 的 428 里，四个测试文件与 10 条实例随功能删除，`test/panel.test.mjs` 重写为 24 条 —— 覆盖新页、话术卡与复制兜底、设置页单页注册）；`node tools/audit-gate.mjs` = **共 53 条，未过 0 条**（原房间/编队两条换成「已删除」的回归闸门）。
## [0.17.1] —— 修：到量轮换从 10-12 起就再没建过新会话（`sessions` 服务取错了上下文）

**症状**：会话累计到十几 MB（远超 `handoffExportBytes` 的 1.8 MB 字节阀），到量轮换却一次都没发生；盘上没有任何新会话，也没有任何可核对的失败痕迹（设置页、状态条、日志三处全静默）。

**根因**：服务**只在声明它的那个 `ctx.inject([...], cb)` 回调的 ctx 上可取**。`lib/index.js` 里轮换建会话、房间兜底投递、编队视图三处都写成 `run.ctx.sessions`（模块级 ctx 的属性访问）：本宿主上属性访问取不到会**抛错**，抛出来的错被"可选服务＝缺席不是故障"的守卫吞掉，于是 `runRotationAction` 一路走到 `sessions` 服务门就返回 `no-service` —— 只写一条内存里的 `unavailable` 记录与一行 `ctx.logger` warn，盘上什么都不留。

**修法**：`lib/index.js` 新增 `serviceOf(ctx, name)`（`ctx.get(name)` 优先、属性访问兜底并吞错）与两条**独立声明的依赖边** `ctx.inject(['sessions'], …)` / `ctx.inject(['agents'], …)`（模块级 `inject` 仍是 `['sessionProjections']`，两个服务都**不阻断**插件），解析到的服务挂到 `run.sessions` / `run.agents`；轮换、房间、编队三处改为读它们。同时新增**决策痕迹**：每次真正走到轮换判据都往 `<profile>/dsh-status-turbo/rotation-trace.jsonl` 追加一行 JSON（每会话 5 秒最多一条，fire-and-forget，失败不抛）—— 阈值、是否该轮换、记录状态、服务在不在、结果与消息，一条不缺。

**证据**：离线重放（`_replay-rotation.mjs`，把 `Date.now` 钉在会话末尾事件时刻以模拟活体折叠，用真实 `lib/` 折叠真实事件流）修前得 `rotation.message = "no-service"`、零建会话；修后得 `status:"armed"`、`payloadBytes 15,967,207`（字节阀 1,800,000 已满足）、`childId` 落地并真的调用了一次 `sessions.create`。

**线格式 / 配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动（痕迹文件写在 profile 根的 `dsh-status-turbo/` 目录，与房间存储同目录，不吃配置键）。

**测试**：`node --test` = **428 pass / 0 fail**（0.17.0 的 427 + `test/halves.test.mjs` 新增 1 例：`serviceOf` 的降级路径与注入依赖表逐字断言）；`node tools/audit-gate.mjs` = **46 条，未过 0 条**。

## [0.17.0] —— 修：11 个 `room_*` 工具与 `/room` 从来没注册过（`ctx.register(...)` 是静默死路）+ 角色位挂「专家角色」、群里发消息自动领活
**症状**：用户在会话里发 `/room list`，命令没被宿主拦下，而是当普通文本递给了模型；模型自己查了一圈工具，回答"当前会话里没有注册 dsh-status-turbo 的房间工具（`room_list` / `room_read` / `room_claim_task` / `room_complete_task` / `room_post` 都不可见）"。房间宿主、投递、名册、面板一直正常 —— 坏的只有"工具与命令挂没挂上去"这一步。
**根因**：cordis 只把 `events` / `fiber` / `registry` / `reflect` 混入插件上下文（`vendor/cordis/src/index.ts:736-745`），**服务自己的方法挂在服务对象上**：`ctx.tools.register(...)` / `ctx.commands.register(...)`。而 `lib/index.js` 一直写成 `ctx.register(...)`（先判 `typeof toolsCtx.register !== 'function'`，再静默 `return`）—— 从 0.10.0 起每一个版本，11 个 `room_*` 工具和 `/room` 都没有注册过；旧用例的假上下文只喂了 `sessionProjections` 一个键，反而把这条死路一路放行。
**修法**：`lib/index.js` 新增 `registeredService(ctx, name)`（`ctx.get(name)` 取不到时用 `<name>Ctx.<name>` 兜底），`tools` / `commands` 两个 `ctx.inject` 改成从**服务对象**上取 `register`；取不到只记一行 warn，房间其余能力照常。回归门：`test/halves.test.mjs` 新增一例 —— 假上下文按真实形态构造（服务对象上有方法、ctx 上没有），断言 11 个工具逐个调用 `tools.register`、每个工具都带 `execute` / `output.render` / object 参数，且 `/room` 恰好注册一次。
**同时**（m04729 的诉求，本轮先落地"立刻能用"的部分）：
- 名册角色位新增 `expert`（专家角色，专家团里的名字，可留空）：`lib/roster.js` 新增 `personaExpertFor` 与纯函数 `expertLine`；`lib/room-host.js · deliveryText` 投喂时多一行「你的专家角色：X —— 按这位专家的方式做事……用 `summon_expert` 以这个名字把它请进来」。**只投名字与用法，不复制专家人设正文**（专家人设属于专家插件，抄一份就会出现两个各自漂移的版本）。设置页「群聊」每个角色位多一个输入框；5 套编队模板里给能对上号的岗位预填了真实专家名（产品经理 / 软件架构师 / 验收测试工程师 / 前端开发者 / API 平台工程师 / 后端架构师）。
- 「群里发消息＝派活」：投喂正文与系统提示段都写明 —— 任务板上没人领、又落在你职责里的活，自己 `room_claim_task` 领走，不用等人点名。
**未做（下一轮，用户醒来再定）**：与「专家团」「编队」合并成一个插件、设置里给每个会话指定"程序 + 工作区 + 任务"、群聊界面本身（都只留 `## [Unreleased] · 未实现` 的指针，不假称已实现）。
**线格式 / 配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动（`expert` 是 `groups` 里的一员，跟着名册走）。
**测试**：`node --test` = **427 pass / 0 fail**（0.16.1 的 422 + `test/halves.test.mjs` 1 例 + `test/roster.test.mjs` 4 例）；`node tools/audit-gate.mjs` = **46 条，未过 0 条**。

## [0.16.1] —— 修：点「保存」其实写进去了，界面却不给任何回执
**症状**：0.16.0 装好后，设置 →「群聊」里点「保存」看起来毫无反应（按钮无变化、没有成功提示、也没有失败提示）；用户据此判断"保存没生效"，改完心里没底。
**根因**：写入路径本来就是好的，坏在**回执**上 —— `lib/client.js · RosterSection.save()`（`:3389-3402`）与第二页「全部设置项」的 `commit()`（`:3757-3771`）都只 `await scope.set(...)`，**把解析出来的布尔值丢掉**：底层 `ConfigForm.set()` 成功返回 `true`、被宿主拒绝返回 `false`，页面两者都不显示，成功分支里也没有任何状态更新。
**排查铁证**：用户那次点保存确实写进去了 —— `D:\deepseek-harness\profiles\desktop\cordis.patch.yml` 的 mtime 变成 `2026/10/14 0:24:18`（本次启动 0:20:13 之后），文件里出现本插件的用户层条目，含 `groups:` 与用户填的 `技术方案` / `调研与方案评审` / `调研` / `评审`、`cwd: D:\project\huihuoke\hermes-agent`、`preset: cordis`。
**修法**：`lib/client.js` 两处保存路径都改成看布尔值 —— 成功显示绿色「已保存」并清掉草稿；`false` 时显示「宿主拒绝了这次写入（多半是并发冲突），改动还留着，请再点一次保存。」并且**不再清草稿**；新增字典键 `settings.saveRejected`（zh/en）；「群聊」页与「全部设置项」页各自维护 `saved` 状态，「放弃改动」一并清掉它。
**线格式 / 配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动。
**测试**：`node --test "test/*.test.mjs"` = **422 pass / 0 fail**（与 0.16.0 同数，本轮没加用例）；`node tools/audit-gate.mjs` = **46 条，未过 0 条**。

## [0.16.0] —— 加：把「配置」搬进面板（全部设置可读可热写）+ 编队模板
**症状**：设置侧栏里的「群聊」页只干一件事（名册）；其余 50 多个配置项只能改 `cordis.patch.yml` 再完全重启，名册也得一个位子一个位子手填——用户要的"预设更多、界面更美、**全部设置都能在这个面板里看和改**"都欠着。
**根因 / 机制**：`dsh-settings · SettingsForms.describe()` 只把含 `.volatile()` 的那棵子树投成设置页字段（`dsh-settings/lib/index.js:122 volatileForm`）——非 volatile 字段**既不显示也不能热写**；反过来，loader 对"只改了 volatile 字段"的变更会**原地更新引用**并广播 `loader/volatile-update`（`cordis-plugin-loader/lib/index.js:380-420`），不重挂插件。所以只要字段标了 volatile、且插件**用时现取**，改完就立刻生效。
**修法**：
- `lib/roster.js`：`turboConfigSchema` 把反射出来的**每个字段**都标 `.volatile()`（0.15.x 只有 `groups`）；新增纯函数 `liveConfig(config, defaults)`——按默认值表的键次序给出一组 getter，读的是 volatile 引用**此刻**的值，缺项回落到默认值。
- `lib/index.js`：`resolveConfig` 在浅合并之后过一层 `liveConfig`，于是 `effective.X` 每次现取。房间宿主、轮换、交接、装箱、卡住判定这些消费者本来就是"用时读字段"，因此**改完即生效**；少数在 `apply` 时就把值快照进自己的项要重启（编队的 `readOnlyTools` / `downgrade` / `downgradeFloor` / `minQuietSteps`，以及 `roomEnabled`）。
- `lib/client.js`：新增第二页「全部设置项」（`id: dsh-status-turbo.settings`、order 106）——按分组（状态条 / 提醒与收敛 / 输出与装箱 / 编队与交接 / 房间与群聊 / 其它）列出**全部**配置项：布尔点一下即写、字符串与数字就地编辑，顶部给「重启生效」提示；「群聊」页脚加「套用编队模板」下拉（需求与实现 / 前端改版 / 后端接口 / 运维排障 / 技术方案），选中即把整套人群 + 角色 + 人设 + 信息主体追加进名册草稿，工作区与 Agent 预设留空由使用者自己挑。
**线格式 / 配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键、`lib/` 仍 **14** 个文件、`cordis.patch.yml` 的 53 个标量键一字未动；变的是**每个**配置字段都成了 volatile（设置页这才看得见），`groups` 从"唯一 volatile"变成"之一"。
**测试**：`node --test "test/*.test.mjs"` = **422 pass / 0 fail**（+4：`test/roster.test.mjs` 的"全字段 volatile"与 `liveConfig` 两例、`test/panel.test.mjs` 的模板形状与深拷贝两例）；`node tools/audit-gate.mjs` = **46 条，未过 0 条**。

## [0.15.1] —— 修：0.15.0 的设置命名空间仍然缺席（取 schemastery 用 `require` 撞上 ERR_REQUIRE_ESM_RACE_CONDITION）

**症状**：0.15.0 装好并完全重启后，设置侧栏里「群聊」那一页仍在，页面仍是那句「设置服务不可用（本机 DSH 没有该设置命名空间），名册这次不可编辑。」

**根因**：0.15.0 让命名空间来自本条目自己的 `Config`，方向对，但那个 `Config` 根本没造出来。`lib/index.js` 在**模块求值**时用 `createRequire(...)('@deepseek-ai/schemastery')` 取 schemastery，而宿主是**并发 `import()`** 装载插件的：schemastery 的 CJS 入口（`lib/index.cjs`）内部去 `require` 仍然是 ESM 的 `@deepseek-ai/cosmokit`，Node 24 抛 `ERR_REQUIRE_ESM_RACE_CONDITION`（"Cannot require() ES Module … because it is not yet fully loaded"）。五条 require 取法全灭 ⇒ `runtimeZ = null` ⇒ `Config = undefined` ⇒ `dsh-tool-cordis` 的 `liveConfig()` 报 `status: "absent"`。装机实测日志：`D:\deepseek-harness\logs\turbo-config-probe.jsonl`。

**修法**：改成顶层 await 的**动态 `import('@deepseek-ai/schemastery')`** —— ESM 装载器自己排队，不存在那个竞态；宿主的解析拦截照常放行（同 profile 的 12 个第三方插件都走这条 ESM 路径取 schemastery）。仓库侧这条 import 必然 reject（工作树里没有 `node_modules`），吞掉即可：`Config` 退化成 `undefined`，测试与其余能力照常。

**线格式 / 配置面**：`TURBO_STATE_VERSION` 仍 **12**、`EXPECTED_V` 仍 **12**、wire 顶层仍 **38** 键、`DEFAULT_CONFIG` 仍 **59** 个键、`lib/` 仍 **14** 个文件；`Config` 的形状与 0.15.0 一致（只有 `groups` 是 volatile）。

**测试**：`node --test "test/*.test.mjs"` = **418 pass / 0 fail**；`node tools/audit-gate.mjs` = **46 条，未过 0 条**。

## [0.15.0] —— 修：「设置 → 群聊」页终于可编辑（命名空间改由本条目 `Config` 承载）

**症状**：0.14.1 之后设置侧栏里终于有了「群聊」那一页，但点进去只有一句「设置服务不可用（本机 DSH 没有该设置
命名空间），名册这次不可编辑。」——页面在了，数据面不在。

**根因**：本版 DSH 的设置服务（`settings` = `SettingsForms`，`dsh-settings/lib/index.js:322`）**没有** `register(ns, schema)`，
也没有 `get(ns)`（`:322 configure`、`:413 describe`、`:470 update`、`:479 replace`、`:488 mutate` 就是它的全部方法）。插件设置的
命名空间**只能**来自它自己条目上的 `Config`：`describe()` 只遍历有 `Config` 且带 `toJSON` 的条目（`:538 schema(entry)`），
并且**至少要有一个 `.volatile()` 字段**（`:122 volatileForm`）才产出命名空间 —— 两关都过才算数。0.11.0 起那条
`c.settings.register(name, rosterSchema(z), { applies: 'live' })`一直是 `TypeError`，被同一段的 `.catch` 吞成一行 warn：
状态条、房间、任务板全都正常，只有设置页永远拿不到数据面。第三方旁证：`@hyzyn/dsh-kit/lib/settings.d.ts` 把这个变更
写成了迁移说明（「0.1.7 线移除了旧 settings 服务的 `register(ns)` / `get(ns)`，改以每个 profile entry 自己的 `Config`
作为设置存储」）；`dsh-opencode-go` 则用 `configForms.get(entryId)` + `settingsScope.bind({namespace})` 双绑定同一页。

**修法**：

- 宿主半新增 `export const Config = turboConfigSchema(z, DEFAULT_CONFIG)`：`lib/roster.js` 里逐键反射 `DEFAULT_CONFIG`
  （布尔 → `z.boolean()`、数字 → `z.natural()`、字符串 → `z.string()`、全字符串数组 → `z.array(z.string())`，各自带上原默认值），
  末尾追加 `groups: z.array(rosterGroupSchema(z)).default([]).volatile()`。**只有 `groups` 标 volatile**：volatile 字段
  才能被设置页热写（loader 检出「只改了 volatile 字段」后原地更新引用并发 `loader/volatile-update`，不重挂插件），
  其余字段解析后仍是普通值，`resolveConfig` 的语义一字不变。schemastery 用 `createRequire` + try/catch 取：仓库工作树里
  解析不到它，静态 import 会弄挂仓库那 418 条测试；取不到就 `Config = undefined`（宿主按「该条目没有 Config」处理）。
- 名册读法改成闭包现取：`rosterSource = () => normalizeRoster({ groups: unwrapVolatile(config.groups) })` —— volatile 字段
  解析出来是冻结引用 `{ get() }`，必须先解引用（`unwrapVolatile` 对非数组且有 `get` 的对象取值，取不到时原样返回）。
- 客户端半的数据面换成 `ctx.get('configForms')`：`ConfigForms.get(id)` 对**任何** id 都返回控制器（不核对宿主是否真的在
  服务这个命名空间），而条目 id 由装法决定（由 bundle include 带出来的条目叫 `include:dsh-status-turbo`，本机实测），
  所以每次取用都先看 `describe()` 镜像里哪个候选真的在服务、镜像还没结论时先用首选候选顶着；订阅也挂在镜像上
  （表单与镜像同源，命名空间列表变化时页面重取）。旧的 `settingsScope.bind({ namespace })` 留作后备。
- `ctx.inject(['settings'], …)` 那一块只剩一件事：`settings.configure({ auto: false }, ctx.fiber)` 抑制 DSH 照 `Config`
  自动生成的原始配置表单（我们自带页面）。

- **线格式没动**：`TURBO_STATE_VERSION` 仍 12、客户端 `EXPECTED_V` 仍 12、wire 顶层仍 38 键、`lib/` 仍 14 个文件。
- **配置面动了**：条目多了 `Config`（`DEFAULT_CONFIG` 的 59 个键 = 53 个标量 + 6 个字符串数组，另加 `groups`），
  其中只有 `groups` 是 volatile。
- 测试 413 → **418**（`test/roster.test.mjs` 加 2 例：`turboConfigSchema` 的反射与「只有 groups 标 volatile」、
  `unwrapVolatile` 的四种输入与 get 抛错；`test/panel.test.mjs` 加 3 例：configForms 在场就绑并挂上镜像订阅、
  只服务短名时也不写错条目、镜像还没结论时先用首选候选顶着）。
## [0.14.1] —— 修：「设置 → 群聊」页从来没出现过（注册被一条多余的 `ctx.inject` 门挡掉）

**症状**：0.11.0–0.14.0 三版里，DSH 设置侧栏都找不到「群聊」那一页；而同一次 `apply` 里挂在
`conversation.composer.dock` / `conversation.input.dock` / `sidebar.panellist` + `main` 上的状态条、详情面板与
左侧栏入口全都正常。也就是说**名册本身能跑（宿主半边照常），只是没有配它的界面**。

**根因**：客户端半的 `registerRosterSection` 把整段注册包在 `ctx.inject(['settingsScope', 'slots'], …)` 里当门。
一旦这层门不满足（动态客户端上下文里 `settingsScope` 不在该作用域、或 `inject` 的形状与假设不同），整个注册体就
**静默跳过**——不报错、不留痕，页面上于是什么都没有。这条缺陷从 0.11.0 就在，三版都没被发现，因为谁也没真正点开过设置侧栏。

**修法**：直接挂在槽位上，不再拿 `ctx.inject` 当门（同仓既有做法：`dsh-plugin-subscriptions/lib/client/index.js:43`
就是 `ctx.slots.inject('settings.section', () => ctx.slots.register({…}))`）。`settingsScope` 改成**在槽位声明时
就地 `ctx.get` 取**：取不到也照常注册这一页，由页面自己显示「不可用」——宁可见到一页说清原因，也不要整页静默缺席。
顺带把 `registerPanel` 里同样多余的一条「ctx 必须有 `inject`」守卫去掉（它一个 `ctx.inject` 都没用）。

- **线格式、配置、宿主半全都没动**：仍是 v12 / 38 键、53 个标量键、`lib/` 14 个文件。
- 测试 410 → **413**（`test/panel.test.mjs` 加 3 例：没有 `ctx.inject` 也要挂上、`settingsScope` 在场就绑定且
  缺席也照常注册、`bind` 抛错只让这一页显示不可用），并把 `test/halves.test.mjs` / `test/ui-contract.test.mjs`
  里「注册条目恰好 2 个」的旧断言改成**按 id 取**（0.14.0 起同一次 `apply` 本来就多注册了 3 格）。

### 边界（如实申报）

- **只修界面可见性**：名册的读写、宿主侧 `settings.register` 与角色位的投喂行为本轮一行未改。
- **测试是替身层面的**：真机上「设置 → 群聊」能否出现，要靠装完之后的一次完全重启实际看一眼。


## [0.14.0] —— 左侧栏新增「编队与群聊」入口：一个只读页，把当前会话的家族与房间角色位摊开

左侧栏多了第五个入口（与内置的「容器 / 插件 / 自动化任务 / 上下文洞察」并列）。点开是一个只读页：**当前会话**是谁、
它的**编队**（父级 + 每个直接子智能体，逐行给上下文大小与构成）以及它的**群聊**（所在房间的角色位、未投递、成员、
未完成任务）。

- **动线格式：没动。** `TURBO_STATE_VERSION` 仍 **12**，wire 顶层仍 **38** 键，客户端 `EXPECTED_V` 仍 **12**，
  `cordis.patch.yml` 仍 **53** 个标量键。新页没有任何配置项，不新增会话事件，不发网络请求，也不注册宿主路由。
- **复用的是官方扩展点**：`sidebar.panellist`（全局面板图标列表，每个 `id` 指向主面板的一个 `key`）与 `main`
  （按 `key` 分片的主面板）。两个注册用**同一个 id**（`dsh-status-turbo.panel`）——侧边栏按钮靠它派发，写错就是
  点了没反应。`label` 是 thunk，随语言切换；图标只读 owner 给的 `size`，不去猜 `active`（选中态归 CSS）。
- **取数走标准钩子，没有新通道**：主面板页是 root 作用域、**没有会话绑定**，所以页面用
  `useSessions(state => state.current)` 拿当前会话，再用 `state.byId[id]?.projectionValues?.turbo` 读本插件自己的
  wire 视图——宿主已经把每个会话的投影值放进了会话列表（`SessionSummary.projectionValues`），因此**不需要新的订阅、
  HTTP 路由或宿主 RPC**。
- **宿主半一行未改**：`lib/index.js` / `lib/state.js` / `lib/fleet*.js` 原样；新页面只读 wire 里已经有的 `fleet`
  与 `room` 两个顶层键。客户端半新增 `TurboFleetPage` / `FleetPanelIcon` 与注册函数 `registerPanel`，以及可复用的
  `roomSection` / `memberLine`。
- **三态文案分得清**：没有当前会话说「先在左侧选一个会话」；投影还没到说「等待该会话的投影…」；投影到了但没有家族
  才说「这个会话没有家族」。**不把「还没到」说成「没有」**。
- 测试 395 → **410**（`test/panel.test.mjs` 新增 15 例：群聊分区与兜底、取数选择器、三态文案、图标与注册约束），
  `tools/audit-gate.mjs` 仍 46 条未过 0 条。

### 边界（如实申报）

- **只读**：页面上没有、也不会新增任何变更操作；改人设与席位仍走「设置 → 群聊」。
- **只显示当前会话**：没有跨会话总览，也不替别的会话取投影。
- **投影是宿主推过来的**：页面自己不建订阅，拿不到就是「等待」，等宿主把列表里的投影值补上。
- **槽位缺席只让入口缺席**：宿主没提供 `sidebar.panellist` / `main` 时，状态条与详情面板照常工作。
- **未跑过真机**：本版在写完之后跑的是单元测试与审计门；入口在真机上的渲染要靠一次完全重启后的实际点击。


## [0.13.0] —— 详情面板新增「编队」分区：本会话的智能体家族，每个成员带实时上下文大小与构成

「编队」是详情面板里的一段：**本会话**、它的**父会话**、以及挂在它下面的**每个子智能体**各一行。每行给出
标签与模式（DSH 自己的 `subagent/descriptor`）、活动状态（还有一轮在飞 / 已闲置）、所在房间的角色位，以及
它**上一步真正发出去的 prompt token 数与构成**（提示 / 缓存读 / 缓存写 / 输出四段，另有步数、工具与耗时）。
只有**确实有家族**的会话才显示这一段：只有自己的会话不加——自己的上下文占用在「缓存与用量」里已经有了。

- **动线格式**：`TURBO_STATE_VERSION` 11 → **12**，wire 顶层键 37 → **38**（新增顶层 `fleet`），客户端
  `EXPECTED_V` 同步 **12**。`cordis.patch.yml` 仍 **53** 个标量键（编队没有任何配置项）。
- `lib/fleet.js`（新，**纯模块零 import**）：`FLEET_VERSION = 1`、`FLEET_MAX_CHILDREN = 24` 与四项字段裁剪
  上限、`tokenBudgetOf`（`live` = input + cacheRead + cacheWrite，即那一步的 prompt 大小；`output` 不计入
  上下文）、`agentRowOf`（没有 id 的行直接丢）、`normalizeFleet`（有效行超上限只计数，并把 `truncated` 立起来）。
- `lib/fleet-host.js`（新，宿主半）：`createFleetSource({ sessions, projections, profile, now, log })` → `viewFor(sessionId)`。
  家族判据是 `header.parentSession === 本会话 && header.origin === 'subagent'`（与 DSH 自己的 `listChildren`
  同一条）；标签/模式读 `subagent` 投影单元的**状态**、时长与在跑读 `subagentTiming`、上下文读本插件 `turbo`
  单元的 `stepUsage`。用 `stateOf` 而不是 `snapshot`：wire 视图里现在有编队本身，`snapshot` 会自我递归。
- `lib/state.js`：新增 `setFleetViewProvider`（与 `room` 的 provider 同形态），`toView` 末尾多一个顶层 `fleet`。
- `lib/index.js`：接线 `createFleetSource`（`sessions` / `sessionProjections` / 房间角色位 / 时钟 / 日志）并注册
  provider，随插件卸载撤销。
- 客户端半：详情面板新增「编队」分区（`fleetSection` / `fleetVisible` / `fleetAgentRows` / `fleetCompositionBar`），
  构成条四段按占比分宽且都用 `tint()` 调淡；段名进 `title`，精确数字另有文字行——颜色不是唯一的信息载体。
- 测试 377 → **395**（`test/fleet.test.mjs` 新增 18 例：用量折算与规范化、宿主半的家族枚举与全部降级路径、
  客户端分区的可见性 / 文案 / 构成条分宽），`tools/audit-gate.mjs` 仍 46 条未过 0 条。

### 边界（如实申报）

- **"实时"是上一步的读数**：`stepUsage` 来自最近一次完成的请求，不是此刻正在拼的上下文；正在飞的那一步要等它结束。
- **不跨会话树**：只列本会话的父级与**直接**子级，孙会话不展开（子行会标出它自己还有下级）。
- **"在跑"取最近一轮**：`subagentTiming.active` 有值就是还有一轮在飞；否则显示闲置与已用时长。
- **上限 24 个子智能体**：超出的部分只显示「另有成员未显示」，不假装一共只有这些。
- **子会话刚建出来还没有 descriptor 是正常的**：那种窗口里标签为空、模式为空，客户端退回会话 id 前 8 位。


## [0.12.0] —— 名册角色位补「工作区」与「Agent 预设」：换身时把新会话开在对的目录、用对的预设

名册的每个角色位多了两个字段：**工作区**（绝对路径）与 **Agent 预设**（预设 id）。它们只在**轮换新建会话**那一刻
生效——写进新会话 header 的 `meta`（`cwd` 与 `agentPreset`）。已有的角色位会话不受影响：工作区与预设都是会话的
创建期字段，插件没有改已有会话这两个字段的原语。

- **不动线格式**：`TURBO_STATE_VERSION` 仍 **11**、wire 顶层键仍 **37**、`cordis.patch.yml` 仍 **53** 个标量键
  （这两个字段进的是 DSH 设置存储与 `sessions.create` 的 meta，不是插件配置、也不是投影）。
- `lib/roster.js` 升 `ROSTER_VERSION = 2`：角色位新增 `cwd`（只收绝对路径，相对路径丢成空串）与 `preset`
  （只收 `[A-Za-z0-9][A-Za-z0-9._-]*` 形态，非法丢成空串）；新增 `personaWorkspaceFor` / `personaPresetFor`。
- 宿主半：`lib/room-host.js` 句柄新增 `cwdFor(sessionId)` / `presetFor(sessionId)`（按会话→角色位→名册取值）；
  `lib/index.js` 轮换时按角色位覆盖投影里的 `cwd`、并把 `preset` 传给 `lib/rotation-host.js`，后者写进
  `sessions.create(childId, { meta: { cwd, parentSession, agentPreset } })`。
- 客户端半：设置页每个角色位多两个下拉——**工作区**（候选来自 DSH 的 workspaces 服务，另有「沿用会话当前工作区」）
  与 **Agent 预设**（「默认（跟随 DSH）」与「创造模式」，已存的自定义 id 保留）。
- 测试 373 → **377**（`test/roster.test.mjs` 新增 4 例：工作区/预设的规范化、两个取值函数、`cwdFor`/`presetFor` 接线），
  `tools/audit-gate.mjs` 仍 46 条未过 0 条。

### 边界（如实申报）

- **只对新会话生效**：工作区/预设写在轮换建出来的会话 header 里；已经开着的角色位会话不会被搬目录、也不会换预设。
- **完全权限不在名册里**：审批策略是每会话的运行时策略，不是 header 字段。要用完全权限，请在 DSH
  `设置 → 权限` 把默认预设设为完全权限（或在会话里用 `/permission`），插件不会替你改审批策略。

## [0.11.0] —— 群聊名册：在 DSH「设置 → 群聊」里配人群与角色人设

本轮给房间补上**名册**（roster）：人群（通常就写成房间名）→ 角色位 → `{ 人设, 信息主体 }`。名册由用户在 DSH **原生设置页**
里维护，落盘走 DSH 自己的设置存储；宿主半把它读成运行时值，三处生效：空 `charter` 的兜底、投喂正文里的
「你的信息主体」一行、系统提示与 `room_list` 里的名册概览。设计与判据见 `docs/design-room.md`。

- **不新增会话事件类型，也不动 `TURBO_STATE_VERSION`**（仍 11、wire 顶层键仍 37）：名册不进投影，只影响宿主投喂与工具文案。
- 新增 **`lib/roster.js`**（纯模块、零 import）与 **`test/roster.test.mjs`**（16 例：规范化/查找/文案/schema 声明形态 + 三处接线的宿主行为）；
  测试 357 → **373**，`tools/audit-gate.mjs` 仍 46 条未过 0 条。
- `settings` 是**新增的注入点**：`inject` 仍只列 `sessionProjections`，房间段自己 `ctx.inject(['settings'])`；
  schemastery 走**动态 `import()`**（装好的 profile 里解析得到，仓库工作树里没有），拿不到就只记一行日志、名册退化为空。

### 设置页（新增）

- 宿主半：`ctx.settings.register('dsh-status-turbo', rosterSchema(z), { applies: 'live' })`，数据形态
  `{ groups: [{ name, topic, members: [{ role, persona, subject }] }] }`；读取走返回的 scope（拿不到 scope 时退化为 `settings.get(name)`）。
- 客户端半：新增一条 `settings.section` 注册（id `dsh-status-turbo.room`、order 105、label「群聊」），用
  `settingsScope.bind({ namespace })` 读快照与写回；`package.json` 的 `dsh.client.inject` 增加
  `@deepseek-ai/dsh-client-modules` 与 `@deepseek-ai/dsh-client-ui-settings`。
- 设置页支持增删人群、增删角色位，编辑人设与信息主体；保存按顶层字段整段替换（`groups` 一个字段），未保存的编辑在页面内保留。

### 名册的三处生效点

- **空 `charter` 的兜底**（`room_create` / `room_join`）：没写职责时，按「人群名 + 角色名」取名册里的人设作为职责说明；
  显式传入的 `charter` 永远优先，名册只是默认值，不会被写回名册。
- **投喂正文**：命中名册时多一行 `你的信息主体（人群「X」）：…`（信息主体为空则不产生该行）。
- **系统提示与 `room_list`**：系统提示新增一行指路（名册在 设置 →「群聊」里配）；`room_list` 末尾补一行名册概览（空名册不留空行）。

### 边界（如实申报）

- **脏数据只丢不抛**：无名人群、空角色名、同人群内重名角色都被丢掉；人群名/人设/信息主体按上限截断（人群名 120 字、
  人设与信息主体各 2000 字、24 人群 × 16 角色位），超限不报错。
- **改动名册不追改已有角色位**：人设只在建/加入房间那一刻落进角色位；要让新的人设生效，重新 `room_join` 即可。
- **设置页那条链路只在装好的 DSH 里可测**：仓库 `node --test` 覆盖到的是 `rosterSchema(z)` 的声明形态（注入假 z）
  与名册容错；`settings.register` 与客户端 setter 的真实链路由装机后的人工验收覆盖。

## [0.10.0] —— 房间与任务板：把多会话协作（聊天室 + 任务板）合进本插件

本轮加的是**多会话协作的横向面**：一个房间里有若干**角色位**（member slot），每个角色位长期指着某个会话 id；
会话到量轮换时角色位**跟着换身**，而不是换人。消息、任务、投递游标都走同一条单写链。设计与判据见 `docs/design-room.md`。

- **不新增会话事件类型**：复用现有 `turbo` 投影，只加一个顶层 `room` 字段 —— 新事件类型在旧宿主上 fail-closed，
  所以本轮一个都不加。代价是 **`TURBO_STATE_VERSION` 10 → 11、wire 顶层键 36 → 37**。
- 新增 **13 个配置键**（`roomEnabled` … `roomInjectBrief`），标量键 40 → 53，逐字镜像进 `cordis.patch.yml`。
- 房间默认开（`roomEnabled: true`），但**只在会话真的进了房间之后**才在投影里留痕；非成员恒 `null`，旧版客户端读不到该字段就不显示。
- `/room` 命令与 11 个 `room_*` 工具**排同一条写链**：并发 `claim` 靠链内同步 CAS 分胜负，不为租约起定时器、不加锁。
- 测试 293 → **357**（`test/room.test.mjs` 37 例纯语义 + `test/room-host.test.mjs` 27 例宿主行为）；
  `tools/audit-gate.mjs` 44 → 46 条（新增 README 配置表含 `roomEnabled`、`room.js` 零 import 两条）。

### 纯语义层 `lib/room.js`（新增，零 import）

- 只做状态变换：`emptyRoomStore` / `createRoom` / `joinMember` / `leaveMember` / `bindSession` / `followRotation` /
  `markStale` / `postMessage` / `recordDelivery` / `pendingFor` / `advanceCursor` / `createTask` / `claimTask` /
  `completeTask` / `releaseExpired` / `transferTask` / `tasksOf` / `roomViewOf`；`ROOM_STATE_VERSION = 1`。
- 全文禁止 `Date.now()` / `new Date()` / `Math.random()` / `fs` / 网络：时间与 id 都由调用方递进来，
  每条判据都能在测试里用常量 `now` 复现。
- 投递游标是**至少一次**：失败那条及其之后的整体重投，已成功的不重复；`skipped` 不推进游标。
- 租约到期**不主动回收** —— 由下一次 `claimTask` 顺手 `releaseExpired`，不为它起定时器。

### 宿主层 `lib/room-host.js`（新增）

- 只做四件事：读写 store（单写链 + 同目录临时文件 + `rename` 原子写）、把未投递消息投给会话（至少一次、失败即停）、
  轮换换身时挪角色位指针、把房间的工具与命令接进同一条写链。
- 全部 I/O 走注入的 `io`（`readFile` / `writeFile` / `rename` / `mkdir` / `profileDir`），`agents` / `sessions` 也是注入的取值函数，
  不 import 宿主内部包 —— 测试能整组换掉，不碰真磁盘。
- 投递顺序：`agent.followup` → `agent.inject` → 退回把正文 append 进会话日志；都成不了记 `skipped(no-agent)` / `skipped(no-session)`，
  同一原因只记一次，且不推进游标。
- 发出去的消息先深冻结（`structuredClone` + 深层 `Object.freeze`）：宿主会把同一个对象写进会话日志，就地改动会让日志与内存不一致。
- 换身两条路：显式（`lib/index.js` 的轮换回调 `onRotation({from,to,at})`）与兜底（宿主 `agent/created` 钩子）。
  兜底那条**必须同步返回**、只判来源，I/O 与投递丢进 `queueMicrotask` —— 它是 SERIAL 瀑布，阻塞它会卡住所有 agent 创建。
- 读盘只发生一次（挂载后第一次进链）；坏 JSON 改名 `.corrupt-<时间戳>` 留档，然后用空库继续。
- 句柄：`start` / `dispose` / `viewFor` / `storePath` / `tools` / `command` / `systemPromptText` / `notifyAgentCreated` /
  `onRotation` / `limits` / `fault`。`viewFor` 在链外，只看内存 `store`。

### 客户端半（前端）

- 详情面板新增**「房间」分区**：只读渲染房间名、角色位、未读数与名下任务，并给一条可复制的命令提示；
  仍然只用 `createElement` / `useState` / `useRef` / `useEffect`，沿用 `memoSection` 缓存与既有 ARIA 纪律。
- 版本门 `EXPECTED_V` 10 → 11；`v` 不匹配时照旧把「客户端与宿主版本不一致」摆在明面上，不猜。
- 任务视图不下发 `claimToken`（租约凭据只留在宿主侧），也不下发 `sessionId`。

### 文档、测试与工具

- 新增 `test/room.test.mjs`（纯语义，37 例）与 `test/room-host.test.mjs`（宿主行为，27 例：投递三条路与失败不推进游标、
  `agent/created` 换身跟随、轮换钩子、8 个并发 claim 的 CAS、原子写与损坏恢复、接线）。
- 两份 README 补上「房间与任务板」一章与 13 个配置键；`docs/design-room.md` 是设计与判据的权威。
- `tools/verify-install.mjs` 的 wire 键数断言 36 → 37。

### 已知偏差与未验证

- **只读操作也会落盘**：任何 `ok` 的 op（含 `room_list` / `room_read` / `room_tasks`）都会重写一次 `rooms.json`。
  字节相同、幂等，但白花一次磁盘写。现有判据是「落盘字节必须一模一样」（`test/room-host.test.mjs`），
  所以将来改成「只读不落盘」不会有测试变红。要修就在 `lib/room-host.js:332` 的 `run` 里让只读 op 不走 `persistSoon()`。
- **隔离失败后的坏字节会被盖掉**：坏 JSON 且改名也失败时（`lib/room-host.js:235` 的 `quarantine`）只记 `fault('quarantine')`，
  随后第一次成功落盘会把原文件覆盖成空库，坏字节永久丢失。`docs/design-room.md` §7.1 只规定了改名成功那条路。
- **单进程写链**：同一 profile 起两个进程同写 = 后写覆盖；不跨机器、不派生子代理。
- **兜底换身依赖宿主钩子**：宿主不提供 `agent/created` 时只剩显式路。
- 未覆盖：`lib/index.js:703` 的 `noteRotation` 接线与 `agent/created` 的真实注册（需要真 cordis ctx）；
  `roomLeaseMs` 到期的时间流逝路径只由纯语义测试覆盖（宿主侧一律注入常量 `now`）。

---

## [0.9.4] —— 审计 0.9.2 的剩余 P1/P2：前端可达性与性能、配置单一路径、热路径 I/O、teardown 与句柄、文档一致性

本轮把两份专家审计（`docs/audit-0.9.2.md`、`docs/audit-0.9.2-experts-raw.md`）里剩下的 P1/P2 逐条落地，
并把其中**可机械判定**的条目固化成 `tools/audit-gate.mjs`（44 条断言，`--root <dir>` 可指向装好的那份跑）。
**不改任何默认语义、不升 wire**（仍 v10 / 36 键，`ledger` 依旧不进 wire），`lib/state.js` 保持纯（无 `Date.now()`）。
测试 268 → **293**。

### 客户端半（前端）

- **活动流限长**：宿主新增 `activityLimit`（24）/ `activityBytes`（8192），环缓冲超限或超字节就从头部丢；
  客户端只渲染最近 24 条，并给出「更早的 N 条已省略」提示行。条目 key 改用元素在**原数组**里的下标
  （倒序渲染不再让整段 key 平移），工具行 key 改用工具身份。
- **展开态秒级心跳**：详情面板只在「展开 + busy」时挂整秒对齐的递归 `setTimeout`（节拍 `CLOCK_TICK_MS`），
  收起或空闲**不留任何定时器**；「现在」那行的秒数不再冻在打开面板的那一刻。
- **分区渲染缓存**：模块级 `memoSection(name, deps, build)` 缓存 10 个分区的渲染结果
  （读渲染时钟或模块级可变状态的 3 个分区故意不缓存）。**没有用 `React.memo` / `useMemo`**：
  `test/halves.test.mjs` 的 React 替身只实现 `createElement/useState/useRef/useEffect` 且按元素树断言，
  插子组件会破坏它的 `children` 断言。同一原因，审计要求的「折叠时不订阅投影」**未做到**
  （`useProjection` 仍无条件调用）—— 记为已知偏差。
- **可达性与一致性**：两个交互入口补 `role=button` / `tabIndex` / `aria-expanded` / `onKeyDown`（Enter 与 Space）；
  分区标题 `role=heading` + `aria-level=3`、分区与面板根 `role=region` + `aria-label`；相位 pill 与空闲 pill 挂 `aria-live="polite"`；
  面板 `maxHeight:60vh` + `overflowY:auto`，值行补 `title`。
- **其余**：状态条改整秒对齐递归 `setTimeout`，脉动周期 4000 ms = 4 节拍（消除 2 Hz 混叠）；
  `error.versionMismatch`（`{host}`/`{client}`）与 `error.missingProjectionAge`；两处 `toLocaleTimeString` 改 `fmtClock`；
  `labelSeparator`（读 `label.colon`）替掉硬编码全角冒号；挂载自检定时器经 disposer / `ctx.effect` 清理；
  `openWithRetry` 可取消（会话切走即停）；增强缺席走 `enhancement.unknown`；Top N/总数提示；删掉死键 `rotation.armed`；
  等待提示参数化 `{grace}`（不再写死「8 秒」）；兜底数字集中到 `CLIENT_FALLBACK` 并注明来源。

### 宿主半

- **`stateSchema` 不再是恒等直通**：改为窄校验 `turboStateSchema`（非对象、必填字段类型错 ⇒ `TypeError`；
  `step`/`turn` 负数 ⇒ `RangeError`），`viewSchema` 仍留恒等。注意真快照里 `turn`/`step` 可以是 `null`，
  且宿主 `init()` 可能**不带 header** —— 第一版写严了会把每个真快照都拒掉（等于每次重启丢水位）。
- **折叠热路径无同步 I/O**：`readdir`/`mkdir`/`writeFile` 全走 `node:fs/promises`；`.gitignore` 改为每个目录只写一次；
  `noteHandoff` 成异步出口（永不 reject，折叠里 `void` 调用）；同一会话同水位用显式单飞闸。
- **配置单一路径**：`apply` 只解析一次 `effective`（唯一一处 `...DEFAULT_CONFIG`），并喂给所有消费者；
  `gears.js` 的 4 组默认值副本删除；隐藏键 `readOnlyTools` 升为 `DEFAULT_CONFIG` 键；
  导出超时升为一等键 `handoffExportTimeoutMs`（120000）。
- **per-mount 状态**：`ctx0`/`effective0`/`handoffSpawns`/`laneReads`/`liveChildren`/`active`/`lastRotationArmedAt`/
  `warned*`/`stuckRuns` 全部收进 `apply` 建的 `run`，以首参贯穿各函数。`state.js · runtimeBySession` 无法搬迁
  （写者是导出的自由函数），已在该文件头写明**单挂载假设**与理由。
- **teardown 与句柄**：`ctx.effect` 的 teardown 置 `run.active = false` 并逐个 kill 在册子进程，`onSettle` 首行早返回；
  超时先 `SIGTERM` + 销毁两个管道，宽限期后 `SIGKILL`；无捕获时 `unref()`。
- **预算与淘汰**：车道列表读取计入进程预算（到量落聚合 `LIMIT_REACHED` + warn）；运行表改 LRU
  （`touchRuntime` 只在折叠路径 touch，淘汰不再意外解除 armed 守卫）；建子会话前用 `sessions.list()` 查有无可复用的子会话
  （只能看见**存活**会话，旧进程建的查不到，已在代码注释写明）。
- `DEFAULT_CONFIG` 新增 `readOnlyTools`、`handoffExportTimeoutMs`（现共 **46 键**），包内 `cordis.patch.yml` 值已同步。

### 文档与工具

- 新增 `tools/audit-gate.mjs`：44 条「必须出现 / 必须消失」断言（`--json`、`--root <dir>`），全过 exit 0；
  新增 `tools/verify-install.mjs`：版本一致 / `TURBO_STATE_VERSION` 与 `EXPECTED_V` 相等 / 装好的 `DEFAULT_CONFIG` 标量与装好的
  `cordis.patch.yml` 同值 / `lib/` 清单一致 / wire 36 键且不含 `ledger` / 对装好的产物跑一遍闸门。
- `docs/design.md` 补 §15「0.7–0.9 的演进」；`docs/packaging.md` 更到当前版本；`docs/design-handoff-export.md` 正文改到现状；
  `docs/acceptance.md` / `docs/plan-B.md` / `docs/roadmap.md` / `docs/review-0.7.0-handoff.md` 补状态行；
  两份 README 的配置表首列与 `DEFAULT_CONFIG` 逐一对齐（46 键，missing/多余皆空）。

### 已知偏差与未验证

- **「折叠时不订阅投影」未做到**（见上）；`React.memo` 改用 `memoSection`（见上）。
- 导出链路全程用假 `spawn` 驱动，没有起过真 `bili export`；真浏览器/DOM 行为（焦点环、屏幕阅读器播报、滚动条）
  只做了元素树层面的结构断言。

## [0.9.3] —— 修 0.9.2 的两条回归 + 给两条主链补上真实覆盖

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.9.3**。
> 本轮**不改任何默认值**、不改包内 `cordis.patch.yml`（`lib/state.js · DEFAULT_CONFIG` 与它仍逐字镜像）、
> **不升 wire 版本**（仍是 v10 / 36 键；`ledger` 依旧不进 wire）。测试 254 → **268**。

### 回归 1（P0，0.9.2 引入）：把「临态」写进跨进程 ledger ⇒ 会话永久停摆

0.9.2 的 `ledgerOf` 把 `entry.handoff` / `entry.rotation` **整条**入账，`rehydrateRuntime` 又原样还原；
而 `noteHandoff` 对 `status === RUNNING || UNAVAILABLE` 直接 `return` ⇒ 一次 `unavailable`（没 cwd / 探测不到 bili）
或 `running`（120 s 导出窗口内进程被杀）会被**跨进程永久化**，之后该会话再也不导出、也不轮换，而且没有任何日志。

修法：账里只留**只增不减的水位与终态事实** —— `payloadBytes` / `headerBytes` / `payloadSeq` / `laneWatermarks`，
外加一个**终态事实 `rotationChildId`**（已轮换过就不再建第二次）；**任何 status 都不进账**。再水化时：

- `running` / `unavailable` 一律**不还原** —— 该会话恢复成「没导出过 / 没轮换过」的正常可判定态；
- 若有 `rotationChildId`，把 `rotation` 重建为「已就绪、可通过客户端切换」的形态（`childId` 有值、`status: 'armed'`、
  `mode: 'manual'`），`at` 与 `seedOk` 留 `null` —— **绝不编假时间戳、不编「种子写入成功」**；
  `lib/index.js` 那条「已有 `childId` 就 return」的守卫因此继续有效；
- 对**旧的持久化 ledger（含 `handoff`/`rotation` 整条）保持容忍**：只读新字段，旧字段直接忽略。

配套：客户端的种子提示改成三态 —— 只有 `seedOk === true` / `false` 才出话，再水化记录的 `seedOk: null` 时**不再谎报**
「新会话已建好，但种子消息没写进去」。

### 回归 2（P0，0.9.0 起就有）：客户端 `auto` 轮换在默认 UI 下一句都没执行过

自动触发原先写在 `rotationSection` 里，而 `rotationSection` 只被 `detailBody` 调用、`detailBody` 只被 `TurboDetailPanel` 调用，
且 `TurboDetailPanel` 在 `collapsed` 时 `return null`，`collapsed` 的初值又是 `true` ⇒ **`auto` 在默认 UI 下从不触发**
（0.9.2 记的「轮换全史 0 次」里，宿主侧那条原因只解释了一半，客户端这一半从来没跑过）。现在触发点搬到**常驻的
`TurboStatusBar` 的 `React.useEffect`**（依赖 `[status, mode, idle, childId, at]`，`useEffect` 在 render 返回 `null` 时照样执行），
保留在飞标志防重入；手动那一行仍留在面板里。

同一根因的第二半：轮换结果原是**模块级单槽位**（`rotationOutcome`），settle 后 `done`/`ready`/`failed` 落地**不会触发重渲染**
（面板会一直显示「正在轮换…」）；一旦失败，早退条件还让该会话**永久**不再尝试，而当时的 `ready` 行又点不动
（`clickable` 只认 `armed && mode !== 'auto'`）⇒ 失败即永久死锁。现在：

1. 结果改成 `Map<sessionId, outcome>`（仍是 **128 条上限**，满时淘汰最旧一条）；
2. 每次结果落地都**广播一次**（新增 `subscribeRotation`，照 `detailListeners` / `subscribeDetail` 那条路），状态条订阅它重渲染；
3. wire 的 `childId` / `at` 变化就**作废该会话的本地结果**（`syncRotationOutcome`）—— 旧会话不再永久死锁；
4. `ready` / `failed` 行**可点**，文案带「重试」，点击走 `performRotation(snapshot, { force: true })` 绕过早退
   （`sessions.open` 是同步的，重试成本极低）。

### 加固（便宜但要紧）

- `lib/rotation-host.js · createQuietly`：此前只挡同步抛错，`typeof session === 'object'` 会把 **thenable** 判成「建好了」
  并留下**无人 catch 的 rejection**。现在判 `typeof session.then === 'function'` 即算失败（`create-failed`），
  并对疑似 thenable 补 `.catch(() => {})`。
- `lib/index.js · rotationOpenChild`：`childId === null` 时把 `openChild` **强制为 `false`**（此前会下发 `openChild: true`，
  等于给客户端「切到某个不存在的会话」的指令复刻成 `sessions.open(null)`）。
- `lib/handoff.js · listLanes` 补 `captureStderr: true` —— 宿主那条 warn 此前**永远打印空 stderr**。
- `lib/index.js` 文件头声明改正：实际是**三处**副作用、其中两处默认开（`handoffExport` 默认 `true`、`rotation` 默认 `'auto'`），
  并把「到量轮换」写进副作用清单（此前漏列，且把两个默认值写反）。

### 覆盖（同类事故第三次：判据与两半接线都测过，真正的执行编排 0 覆盖）

- 新增 `test/handoff-orchestration.test.mjs`（3 条）：用**注入的假 bili / 假 spawn** 驱动 `lib/index.js · noteHandoff`
  走到真分支 —— 断言真的起了进程（`bili.exe`）、建了目录、写了 `.gitignore`、记了终态 `done` 与**文档路径**；
  退出码非零 → `failed · exit:1`；`handoffExportMaxPerProcess` 用满后换新会话**不再起进程**、只记 `failed · limit-reached`。
  为此把宿主半的 I/O 收进一个 `hostIo` 注入点（默认真实现），并在 `lib/index.js` 末尾导出 `__test`（宿主运行时不读它）。
- 新增 `test/rotation-client.test.mjs`（8 条）：把客户端轮换执行体抽成**依赖可注入**的函数 ——
  `openWithRetry(sessions, childId, { retryMs, limit, schedule })`、`executeRotation(deps)`
  （`deps = { sessions, workspaces, sessionId, childId, openChild, archiveOld, open }`）、`performRotation(snapshot, options)`。
  断言：拿到服务时 `open` **恰好一次**；同步 throw 时按 **300 ms 退避重试**、到上限有界放弃；拿不到服务时**一次都不调用**；
  `auto` 的触发点在常驻状态条上（渲染状态条即自动切一次，收起的详情面板不再牵动它）；结果落地会广播；wire 换目标即作废旧结果；
  `ready` / `failed` 行可点且文案含「重试」。**React 组件本体仍不可测**（没有渲染环境），但 A/B 的业务逻辑已全部抽到可测函数里。
- `test/rotation.test.mjs` 补：旧快照容忍（`handoff` / `rotation` 整条忽略、`running` / `unavailable` 不还原）、
  `childId === null` 时 `openChild` 为 `false`、thenable 判失败且**不留无人处理的 rejection**。
  `test/handoff.test.mjs` 补 `listLanes` 的 stderr 采集。

### 文档

- `docs/packaging.md` 重写到 0.9.3：产物 `dist\dsh-status-turbo-0.9.3.tgz`，验收判据 = **当前测试条数 268**，
  并去掉写死的「27 个文件」（published 数量以现场 `npm pack --dry-run` 为准）。
- `docs/design-handoff-export.md` 顶部挂**弃用横幅**：六个键的默认值表已过时（三个变了、七个是新增）、
  三级探测链的论证已被 0.7.1/0.7.4 推翻、「不自动切新会话」已被 0.9.0 方案 B 推翻。
- `docs/design-rotation.md` 顶部补 0.9.3 说明：待定项已定案 —— `rotation: 'auto'`、`rotationArchiveOld: false`、
  方案 B（宿主建空白会话 + `parentSession` + 种子消息 + 客户端只 `open`）。
- `README.zh.md` 同步轮换小节（「自动会切」的前提与失效区间）与客户端行为说明。

## [0.9.2] —— 水位账跨重启 + 不再要求空闲才轮换

0.9.0/0.9.1 上线后实测：轮换在全史 523 个会话里**一次都没触发过**（`parentSession` 指向目标会话的 40 个会话全部 `origin: "subagent"`）。两条独立原因，都已修：

1. **水位账不持久化**。字节/水位账原先只活在模块级 `runtimeBySession` 里，而宿主持久化的是**投影 state**
   （`session_projcache/sessions/session-<id>.json` 的 `record.rows.turbo.val`）—— 那份快照里从来没有它，
   于是每次重启累计体量都从 0 重算。实测 `session-71d12e1f-…` 重启以来吃了 **1.66 MB**，阈值 **1.80 MB**
   —— 差一点，于是这一轮什么都没发生。现在账里必须跨进程保留的那部分（累计 `payloadBytes` / `headerBytes` /
   已计到的事件 `payloadSeq` / 每车道 `laneWatermarks` / 最后一次 `handoff` 与 `rotation` 记录）写进投影
   state 的 `ledger`，下一次进程启动时在第一次折叠前由 `rehydrateRuntime()` 种回运行时表。
   `ledger` **不进 wire 视图**（`toView` 不暴露它，wire 仍是 v10 / 36 键）。
2. **要求"空闲"才轮换**。判据里那条 `phase === 'idle'` 是 0.8.0 `fork` 时代的产物（种子要落在开放轮次之外）；
   0.9.0 改成方案 B 之后既不 fork 也不搬上下文，**建一个空白新会话不会打断正在跑的回合**。实测另一条
   `session-529bd4c9-…` 重启以来已有 **4.32 MB**（远超阈值），却因为从 20:46 起一直在同一个回合里
   （181 步）而一次都没触发。新增配置 `rotationRequireIdle`（**默认 `false`**）：要老行为就设成 `true`。
3. 客户端的 `auto` 模式改为**等会话空闲再 `sessions.open`**（未空闲时那一行显示「新会话已就绪 · 等当前回合结束再切」）
   —— 建会话与切会话分开：前者随时可做，后者挑时机。

`rotationRequireIdle` 与 `ledger` 都不改 wire 形状，客户端 `EXPECTED_V` 仍是 10。

## [0.9.1] —— 轮换默认全自动（`rotation: 'auto'`）

0.8.1 把轮换默认压成 `manual` 的理由是"轮换不可逆"（fork 完会归档旧会话，而界面里没有取消归档入口）。
0.9.0 换成方案 B 之后既不 fork 也不归档，轮换的全部后果只是**多出一个空白会话** —— 忽略它没有任何损失；
而漏掉轮换的代价是继续背着全部历史直到 bili preflight 拒发。所以**默认改成 `auto`**：到量即自动开新会话，
并把旧会话 id 写进新会话的首条 `user/message`。需要人工确认的场合显式设 `rotation: 'manual'`。

三处同值：`lib/state.js · DEFAULT_CONFIG`、包内 `cordis.patch.yml`、`README.zh.md` 配置表。
`lib/rotation.js · rotationMode` 对非法模式名回落的正是这个默认值（模式名写错会得到 `auto`）。
## [0.9.0]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.9.0**。

### 改动：轮换从 `fork` 改成「宿主建空白会话 + 把旧会话 id 送进上下文」（方案 B）

**为什么废掉 `fork`（0.8.0 的设计错误）**：`sessions.fork` 把**整份旧事件日志当种子复制进新会话**——
而轮换要解决的正是上下文积压，fork 等于把积压原样搬过去，新会话的 `inputTokens` 一上来就顶到阈值
（0.8.0 那条「进程级冷却」护栏正是在替这个错误擦屁股）。方案 B 只把一个**旧会话 id** 送过去。

- **宿主半（`lib/index.js · noteRotation` + 新文件 `lib/rotation-host.js`）**：判据通过后**宿主直接做完轮换**，
  不再只写 `armed` 让客户端动手。动作全在 `lib/rotation-host.js · runRotationAction`（I/O 全部注入，可单测）：
  `ctx.sessions.create('session-' + randomUUID(), { meta: { cwd, parentSession: 旧 id } })` 建**空白**会话
  （`core/session/src/index.ts:830`、`types.ts:113-121`），再 `session.append('user/message', …,
  { surfaceOp: 'append' })` 写入 `rotationSeedMessage` 渲染出的首条消息（`index.ts:604-608`）——
  **这是把旧会话 id 送进模型上下文的唯一落点**（光有 `parentSession` 元数据不保证进上下文）。
  零依赖手写的 payload：`{ id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }],
  source: { kind: 'user' } }`（照 `llm/llm/src/message.ts:129-143` 的 `UserMessage`；`id` 的 brand 只存在于类型层）。
- **每个会话最多做一次**：记录里已有 `childId` 就直接返回，不再建第二个。
- **失败只落记录、绝不外抛**：没有绝对路径 `cwd` ⇒ `no-cwd`；拿不到 `sessions` 服务 ⇒ `no-service`；
  `create` 抛错 ⇒ `create-failed`；`append` 抛错 ⇒ 仍然 `armed` 但 `seedOk: false` + `seed-failed`。
  状态新增 `unavailable`（**缺席不是故障** —— `cwd` 或服务恢复后下一次折叠会重试，不进 `hookFaults`）。
- **客户端半（`lib/client.js`）**：`performRotation` 里那套 `sessions.fork` → `open` → 可能 `archive` 只剩
  `sessions.open(childId)`。客户端 `open` 要求该 id **已在客户端会话列表里**（`client/runtime/…/manager.ts:185-189`），
  而 `host/session-added` 帧与投影更新之间有竞态 ⇒ **有界重试**（10 次 × 300 ms）；仍失败就在面板写明
  「新会话已就绪，请手动切换」（客户端没有 toast API，提示只能落在面板那一行）。
  `manual`（默认）= 面板一行 + 按钮，点了才切；`auto` = 看到 `childId` 自动切（每个 `childId` 只做一次）；
  `off` = 什么都不做。
- **删除配置键 `rotationIncreaseTitle`**：它只是 `sessions.fork` 的入参，0.9.0 不再 fork ⇒ **失去作用**
  （`DEFAULT_CONFIG`、包内 `cordis.patch.yml`、`README.zh.md` 配置表、`lib/rotation.js · rotationPlan`
  与对应测试断言一并删）。同时把 `rotationPlan` 里 0.8.0 遗留的 `archiveOld` **自身缺省改成 `false`**，
  与 `DEFAULT_CONFIG.rotationArchiveOld` 一致（此前缺省 `true` 是三处不同步里的最后一处）。
- **wire 升 `v10`**（`TURBO_STATE_VERSION` 与客户端 `EXPECTED_V` 同时升）：`rotation` 记录内新增
  `childId` / `seedOk` / `message` 三个字段，**顶层键数仍是 36**。`tools/fix-v10-tests.mjs` 做字面同步
  （18 处命中，0 命中即非零退出）。
- **镜像**：`lib/state.js · DEFAULT_CONFIG`、包内 `cordis.patch.yml`、`README.zh.md` 配置表与小节三处同步改。
  （顺带修掉 `cordis.patch.yml` 里 `rotationSeedMessage` 的占位符写成 `{oldId}` 的老分歧 —— 生效值是
  `DEFAULT_CONFIG` 的 `{old}` / `{cwd}`。）
- **测试**：`test/rotation.test.mjs` 重写（14 条）；新增「宿主接线」两条 —— 走真的 `lib/index.js · apply`
  注入假 `ctx`（含假 `sessions`），证明**建会话只做一次**、**create/append 抛错不外抛**。
  这两条测试抓出并修掉了两个真 bug：`noteRotation` 引用未 import 的 `rotationStateOf` / `pushRotation`
  （异常被外层 `catch` 静默吞掉），以及把裸 `randomUUID` 当 id 生成器用（生成的 id 少了 `session-` 前缀）。
  全套 `node --test test/*.test.mjs` ⇒ **251 pass / 0 fail**。

## [0.8.1]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.8.1**。

### 修正：阈值组与一条从未生效的死路

来自两位专家（软件架构师 / 后端架构师）对本机实测日志的复查，**全是数值/语义修正，不含新功能**：

- **`handoffExportMinDeltaBytes` 8000000 → 450000（真 bug）**：它**大于** `handoffExportBytes`（3000000）
  ⇒ 字节口径要再涨 8 MB 才允许第二次触发，而每会话最多 1 份（`handoffExportRefreshBytes: 0`）
  ⇒ **这条路径从来没有生效过**。现在取 `60000 × 7.5`，与 token 侧同样的 4:1 关系。
- **`handoffExportTokens` 400000 → 240000**：本机实测的体感卡点是 **341421**，而 bili 自己的提醒线是
  **有效窗口的 75%**（实测 967232 × 75% ≈ 654K）⇒ 它**根本不会提醒你**，插件必须早于体感（0.7 × 341421）。
- **`handoffExportBytes` 3000000 → 1800000**：= 240000 × 7.5，跟随 token 侧。
- **`handoffExportWindowPercent` 40 → 25**：旧值 40% × 1M = 400000 **恰好等于**旧 token 旋钮
  ⇒ 它从未起过约束作用，是个**不 binding 的假保险**；25% × 1M = 250000 才对 240000 有约束力。
- **`handoffExportMinDeltaTokens` 100000 → 60000**：相对新阈值，旧值要求"再涨 42%"才允许第二份，太钝。
- **`rotationArchiveOld` 默认定为 `false`**：包内 `cordis.patch.yml` 此前是 `true`，与 `lib/state.js` 默认**分歧**。
  归档后该会话从各分组视图消失，而它与 `@` 引用读的是**同一份列表投影** ⇒
  `rotationSeedMessage` 里那句「用 `@<旧会话id>` 查阅」会**永远解析不到**（0.8.0 的设计冲突，此处定案）。
- **`noteRotation` 补上冷启动闸**：`isFreshEvent`（与交接文档同一把闸）—— 投影 `apply` 在冷启动重放里
  也会逐事件跑，那时按累计体量判断会立刻 `armed`。新增键 `rotationFreshMs`（默认 300000）。
- **镜像**：`lib/state.js · DEFAULT_CONFIG`、包内 `cordis.patch.yml`、`README.zh.md` 配置表三处同步改。

## [0.8.0]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.8.0**。

### 新增：到量轮换（开新会话 + 引用旧会话 + 归档旧的）

用户诉求：「到了对应的量就应该开一个新的会话 并引用旧会话的会话 id，并且归档旧会话」。
设计稿与全部 API 证据见 `docs/design-rotation.md`。

- **判据（宿主半，纯函数）**：新增 `lib/rotation.js · shouldRotate({config, phase, inputTokens, payloadBytes,
  contextWindow, lastArmedAt, now})` —— 阈值满足（复用 0.7.x 的 token / 字节两个口径，先到先得）
  **且本会话当前没有开放轮次**（服务端 `fork` 要求种子前缀结束在开放轮次之外，
  `core/session/src/index.ts:1132`）**且**过了冷却期。命中后只写 `armed`，**不自己动手**。
- **动作（客户端半）**：`lib/client.js · performRotation` 依次
  `sessions.fork({sessionId, increaseTitle})` → `sessions.open(childId)` → `workspaces.archiveSession(旧 id)`。
  **顺序即契约**：反过来先归档会把客户端视图清回 New Session 状态
  （`client/runtime/…/workspaces/service.ts:337-347`）。拿不到这两个服务时**一次都不调用**，只在面板说明。
- **为什么 `fork` 就够了**：它取**事件日志作种子** ⇒ 子会话 header 带 `parentSession` + `seedLength`
  （`core/session/src/index.ts:1091-1092`、`types.ts:74-80`）—— **上下文天然继承**；
  "引用旧会话 id"就是 header 里那个 `parentSession`，不需要另搬内容。
- **fork 雪崩的护栏**：子会话继承种子 ⇒ 它下一个请求的 `inputTokens` 一上来就很高，
  只按"每会话各自的节流"判断会让它**立刻**再 armed。故加**进程级** `lastRotationArmedAt`
  （与每会话自己的 `at` 取大者）⇒ 冷却期跨会话生效。
- **wire v8 → v9**：视图追加 `rotation` 键（`off|idle|armed` + `mode` + `at`/`inputTokens`/`payloadBytes` +
  **要 fork 的 `sessionId`**）。`mode` 必须进 wire —— `armed` 在 manual 与 auto 下**状态相同**，
  客户端要靠它决定"渲染按钮"还是"自己动手"。键数 35 → 36。
- **面板**：新增「会话轮换」一行（五态 + 两种 armed 文案），`manual` 且 `armed` 时**整行可点**；
  `auto` 在渲染期触发（本插件的组件是纯函数、没有 `useEffect` 可用），靠 `rotationInFlight` 防重入。

### 配置（5 个新键，`cordis.patch.yml` 逐字镜像）

`rotation`（默认 **`manual`**）/ `rotationCooldownMs`(600000) / `rotationOpenChild`(true) /
`rotationArchiveOld`(true) / `rotationIncreaseTitle`(true)。
**默认 `manual` 是刻意的**：DSH 界面里**没有取消归档入口**（`client/ui-workspace/README.zh.md:34`），
先用 manual 观察它在什么量级触发，再切 `auto`。

### 教训（写下来免得下次再踩）

- **升 wire 版本时，fixture 里"用来制造版本错配"的那个旧值不能一起升**：脚本把 `v: 8` 全量改成 `v: 9` 后，
  两个 U7 测试的"人为错配"夹具恰好等于新版本 ⇒ 不再错配 ⇒ 掉进"配置未送达"分支（一次红 3 条）。
  造错配的夹具要**永远落后一版**（现在固定用 `v: 8`）。
- 测试 **239 项全绿**（新增 `test/rotation.test.mjs` 四组：模式回落 / 判据四条件 / 动作单的开关语义 /
  记录合并与 wire v9 键数与键序）。

---

## [0.7.8]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.8**。

### 修复（线上实测：0.7.7 在 00:01 / 00:06 仍各产出一批、共 18 份）

- **每车道只导一份**：新增配置键 `handoffExportRefreshBytes`（默认 **0** = 不重复导出）与纯函数
  `findAnyHandoff(entries, laneKey)` / `nonNegativeInt(raw, key)`。`planHandoff` 在 `refresh <= 0` 时改用
  「该车道**已有任何一份**就跳过」（`reason` 由 `bucket-exists` 改为 **`already-exported`**）；
  设成字节增量才恢复"按水位桶刷新"。
  **根因**：字节账是累计量、只增不减 ⇒ 任何被长时间使用的会话都会反复越桶，
  `handoffExportMinDeltaBytes` 只能把它调稀、不能让它停。
- **默认不导子车道**：`handoffExportSubLanes` 默认 `true` → **`false`**。一次越桶会按车道数乘一份
  （实测本会话 1 个主车道 + 8 个 `|sub:` ⇒ 一次 9 份文件），而交接只需要主车道那 1 份。
- 测试：新增 `findAnyHandoff` / `nonNegativeInt` / 新默认值断言；把 0.7.7 那条「48 MB 会话产个位数」
  的行为测试收紧成 **`exports === 1`**，并补一段开着 `handoffExportRefreshBytes` 时确实会出多份的对照。

### 仍未做

- 阈值口径仍是 `usage.inputTokens` + 累计字节两路（用户选定）；字节账"只增不减"是刻意的（见 `[0.7.6]`）。

---

## [0.7.7]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.7**。

### 修复（线上实测：0.7.6 上线当天写掉 64 份交接文档、把进程上限用尽）

- **触发太密**：`handoffExportMinDeltaBytes` 默认 750000（我原按"≈10 万 token"折算），但字节账量的是
  **所有模型可见字节**（含工具结果反复进出的量），一个在干活儿的会话每几分钟就长够 750 KB
  ⇒ **每 3 分钟补一份完整文档**。**默认抬到 8000000** ⇒ 策略变成「3 MB 出第一份，之后每多 8 MB 补一份」：
  48 MB 的会话约 **6 份**（原来 64 份）、15–19 MB 的子车道约 **2 份**。
- **冷启动重放也会触发**：投影 `apply` 在重放里也逐事件跑，而重放把整份历史一次性折进来 ⇒
  按累计体量判断会在几秒内连续越桶，并替**早已不动的旧会话**生成文档（实测文档分布在 4 个工作区）。
  新增纯函数 `isFreshEvent({at, now, freshMs})` + 配置键 `handoffExportFreshMs`（默认 300000）：
  **折到的事件距现在超过 5 分钟就不动作** ⇒ 只有**正在跑**的会话会触发；历史的体量照样进账
  （"这个会话很重"的判断仍然准），只是不会因为历史而动手。
- 新增回归测试：`isFreshEvent` 的边界（含未来时间戳与脏 `freshMs`）；以及一条**按 750 KB 粒度模拟
  48 MB 会话**、断言产出文档数为**个位数**的行为测试 —— 把"一天 64 份"钉成不可回归。

### 已知遗留

- 0.7.6 期间已经写出的那些文档**没有被本版清理**：`D:\project\handoff`（28）、
  `D:\project\huihuoke\handoff`（4）、`D:\project\huihuoke\hermes-agent\handoff`（30）、
  `D:\project\huihuoke\skb-uni\handoff`（2）。要清就手工删这几个目录里的 `handoff-*.md`
  （连同本插件写的那行 `.gitignore`）。

---

## [0.7.6]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.6**。

### 修复

- **`handoff.message` 改成稳定 code（0.7.4-5）**：原来写的是英文句子
  （`'mkdir failed'` / `'per-process limit reached'` / `'no session cwd'` / `` `exit ${n}` ``），
  直接漏进中文面板。现在 `lib/handoff.js` 导出 `HANDOFF_MESSAGE`
  （`limit-reached` / `no-cwd` / `mkdir-failed` / `timeout`）与 `failureMessage({timedOut, code})`
  （超时，或 `exit:<n|unknown>`），**客户端按 locale 渲染**：`lib/client.js · handoffSection` 里的
  `reasonText` + 新增 5 条中英 key。**未知 code 原样显示** ⇒ 宿主与客户端可以各自演进，不会把原因吞掉。
  `message` 的**类型没变**（还是字符串）⇒ **不动 wire 形状、不升版本号**，只是把它钉成"code 词汇表"。
- **字节账刻意不回落（0.7.4-4）—— 这是结论，不是遗漏**：本部署里 compaction 并没有把 payload 压下去
  （炸掉的那条车道有 4027 组 `compaction/start`+`compaction/end`，最终仍到 ~17 MB），
  所以「累计吃进去多少」才是能提前报警的信号；在 compaction 之后清零会让它从"多导"变成"漏导"，
  而漏导更糟。已写进 `lib/state.js · payloadBytesOf` 的 JSDoc、README.zh 与 `docs/review-0.7.4.md`，
  并加一条测试钉住"只增不减"。

---

## [0.7.5]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.5**。

### 修复（见 docs/review-0.7.4.md）

- **三级探测是死代码**：`profileDirOf()` 内联三层 `dirname`，从
  `…\profiles\desktop\node_modules\dsh-status-turbo\lib\index.js` 往上只到 `…\desktop\node_modules` ⇒
  拼出 `…\node_modules\node_modules\billion-context\…`，**永远命不中**（被二级遮住）。
  抽成纯函数 `profileRootOf(entryPath)`（**四层**），并补一条**对着真实布局**的回归测试 ——
  原来那条测试喂的是假的 `profileDir`，只验证拼法、验证不出"这个值在真实布局下指向哪"。
- **字节账只计模型可见事件**：新增 `MODEL_VISIBLE_EVENT_TYPES` / `isModelVisibleEvent(type)`。
  `compaction/start` 与 `compaction/end` 是**成对**事件（那份失败的日志里各 4027 条），都算会把同一段文本算两遍；
  `subagent/*` 目录快照、审批、重试也不进请求体。现在只计
  `user/message` / `assistant/message` / `tool/call` / `tool/result` + 最新 `request/header`。
- **`handoffExportMaxPerProcess` 默认 8 → 64**：字节口径下每长 750 KB 就够一次触发，
  8 次在大会话上会被瞬间用光（实测本机单份日志最大 **48.0 MB** ⇒ 会越过 40+ 次）。
- **`planHandoff` 的 reason `no-tokens` → `no-watermark`**：字节口径下它可能只因字节缺失而返回，旧名字会误导排查。

### 仍未做

- 字节账**只增不减**（compaction 之后真实 payload 缩小、这个账不回落）⇒ 可能比设计更早触发。
  方向是"多导"、不致命，留待下一版评估。
- `failed` 的 `message` 仍是英文（`mkdir failed` / `limit reached` / `exit N`）—— 改成稳定 code + locale
  **会动 wire 契约**，单独一版。

---

## [0.7.4]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.4**。

### 变更

- **P0-3 补齐字节口径**（用户授权"按建议来"）：`shouldExport` 改成**两个口径取或** ——
  token 口径（`usage.inputTokens ≥ effectiveThreshold`，原样保留）**或**字节口径
  （`payloadBytes ≥ effectiveByteThreshold`）。新增 `BYTES_PER_TOKEN = 7.5`（bili 自己那条护栏的换算常数）
  与 `effectiveByteThreshold({config, contextWindow})` = `min(handoffExportBytes, percent% × 窗口 × 7.5)`，
  **与 token 口径共用同一个 `handoffExportWindowPercent` 旋钮**（"阈值 = 窗口的百分之多少"只有一个真相来源）。
  两个口径各用各自的 delta（新键 `handoffExportBytes` 默认 3000000 / `handoffExportMinDeltaBytes` 默认 750000）。
  **为什么必须有它**：token 口径量的是 bili **压缩之后**的上行计费输入，而 bili fail-fast 那次没有上游响应、
  也就不产生 usage 事件 —— **字节口径才是能看见那个失败的口径**。
- **字节账是可重放的**：新增 `state.js · accountPayload(sessionId, {seq|header, bytes})` 与
  `payloadBytesOf(sessionId)`。`request/header` **只记最新一次**（它每一步都重建，累加会把账吹爆），
  其余按 `seq` **幂等累加** ⇒ 冷启动重放不会把同一批事件算两遍。宿主在投影 `apply` 里量
  `JSON.stringify(event.data)` 的体量，度量失败绝不影响折叠。
- **水位桶同时覆盖两个口径**：`watermarkBucket(config, {inputTokens, payloadBytes})` 取两个桶的**大者** ——
  否则字节驱动的那次增长会落回旧桶、被幂等判据吃掉。
- **残余修复：每车道各记各的水位**。新增 `laneWatermarkOf` / `setLaneWatermark`（存在运行时表的
  `laneWatermarks` 里，**不是 wire 字段** ⇒ 不必再升 wire 版本）。`planAndRun` 逐车道取自己的水位判据、
  判完写回自己的水位 ⇒ 子车道不再共用父会话那一份。

### 仍未做

- 无（P0-3 已按建议补上；"子车道共用水位"那条残余已修）。

---

## [0.7.3]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.3**。

### 变更（把 0.7.0 复查里剩下的 P1/P2 一次做完）

- **P1-1 上限可配**：硬编码常量 `MAX_HANDOFF_EXPORTS = 8` 改成配置键 `handoffExportMaxPerProcess`（默认 8）；
  达到上限时状态记 `failed · per-process limit reached` 并打一条可操作的 warn（原来只是**静默返回**）。
- **P1-4 阈值按窗口收紧**：新增 `effectiveThreshold({config, contextWindow})` —— 模型窗口已知时实际阈值取
  `min(handoffExportTokens, handoffExportWindowPercent% × 窗口)`（新键，默认 40）。窗口来自会话日志里的
  **`request/context`** 事件（`packages/core/session/src/types.ts:219`；agent-loop 只在路由或容量变化时记一次），
  因此是**日志派生 + 纯函数可测**的，不必去问 `ctx.llm`。`state` 新增 `model` / `contextWindow`（都不是 wire 字段）。
- **P1-5 判据可测**：新增纯函数 `planHandoff({config, inputTokens, lastInputTokens, contextWindow, entries,
  sessionId, cwd, stamp})` → `{action: 'none'|'skip'|'export', reason, bucket, existing, output}`；
  宿主 `noteHandoff` 只剩 I/O 与节流，判定全部可单测 —— 补上"测试全绿但跑不通"那个盲区。
- **P2-1 子车道一起导**：新增 `listArgs` / `parseExportLanes(text)` / `lanesFor(lanes, sessionId)` 与
  `listLanes(...)`。触发时先读一次车道列表，把**同一 `label`（= 会话 id）下的主车道与所有 `|sub:…` 子车道**
  逐条导出。判据来自实读：子车道的 `label` 与主车道**同为会话 id**（例
  `session-9e44e9a9-…|sub:f0550134c86a9494  label=session-9e44e9a9-…`），所以不必猜 bili 的命名空间哈希。
  **CLI 没有机器可读模式**（`--help` 被忽略、也没有 `--json`），所以这是解析人类可读输出；
  解析失败一律退化成「只导主车道」，绝不打断。新增配置键 `handoffExportSubLanes`（默认 true）。
- **P2-3 保留 stderr**：`runBili` 统一采集 stdout/stderr（stdout 上限 64 KiB 给车道列表，stderr 只留尾 2048 字符），
  `runExport` 失败时把 stderr 尾行附进 warn（原来只有退出码，排查得手工重跑）。

### 仍未做

- P0-3：阈值口径仍是 `usage.inputTokens`（用户选定）；最坏那条路径（bili fail-fast、没有 usage 事件）仍可能不触发。
- 子车道的水位节流**共用父会话那一份** —— 单条子车道自己的水位没有单独记。

---

## [0.7.2]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.2**。

### 变更

- **交接导出改「水位桶」幂等（P1-2 / P1-3 / P1-6）**：新增纯函数 `watermarkBucket(config, inputTokens)`
  （桶宽 = `handoffExportMinDeltaTokens`）、`handoffPrefix(sessionId, bucket)`、`handoffDir({cwd, dir})`、
  `findExistingHandoff(entries, sessionId, bucket)`；文档名变成 `handoff-<会话ID>-<桶号>-<时间戳>.md`。
  宿主在 `mkdir` **之前**先 `readdirSync` 查同桶文件，命中就跳过并记 `done` ⇒
  重启丢了节流记忆、冷启动重放、同一秒连导两次，都不会再产出重复文档；
  水位继续增长会进新桶，**该刷新的照常刷新**。
- **冷启动重放不再替历史会话生成文档（P1-3）**：`noteHandoff` 在 `state.phase === PHASES.IDLE` 时直接返回
  —— 重放的最后一帧通常是 idle，而活会话跨阈值的那一帧是 streaming / tool。
- **交接目录自带 `.gitignore`（P1-7）**：建目录时写入一行 `*`（`HANDOFF_GITIGNORE`），
  避免 `git add .` 把模型写的块摘要收进版本库。**只影响该目录自身**，不动你的仓库配置。
- **`cwd` 缺失改为记 `unavailable` 而不是 `failed`（P2-2）**：先决条件不满足 ≠ 导出失败。

### 仍未做

- P1-1：`MAX_HANDOFF_EXPORTS = 8` 仍是进程级上限（只增不减），未做成配置键。
- P2-1：子车道（`<sessionId>|<sub:…>`）不支持 —— 插件只传 `sessionId`，子车道炸掉时导出的是主车道文档。
- P2-3：`stdio: 'ignore'` 仍丢弃 bili 的 stderr，失败时只有退出码。

---

## [0.7.1]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.1**。

### 修复（都是 0.7.0 的实测缺陷，见 `docs/review-0.7.0-handoff.md`）

- **P0-1 `resolveBili` 的二级探测必然抛错**：原写法 `requireResolve('billion-context/dist/index.js')` ——
  该包 `exports` 只有 `.` / `./server` / `./dsh` / `./dsh/package.json` / `./client`，**没有 `./dist/index.js`**
  （`bin` 路径不受 `exports` 管辖），实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`。且改用包名解析拿到的是
  `dist/agent/dsh-native.js`（DSH 插件入口），**不是 CLI**。改为新增纯函数
  `packageRootOf(entry)`：在 `…<sep>billion-context<sep>` 处切出包根，再拼 `dist/index.js`。
- **P0-2 三级探测的目标 `.bin/bili.CMD` 起不来**：CVE-2024-27980 之后 Node 拒绝在无 `shell: true` 时
  启动 `.cmd` / `.bat`（实测 `EINVAL`）。**整条 shim 分支删除**（连同 `source: 'shim'`），
  两条探测路都改成「`process.execPath` + 包内 `dist/index.js`」；另新增
  `needsShell(command)` / `quoteForShell(value)`，让用户显式配的 `.cmd` 也能跑（`shell: true` 时
  Node 只是把 argv 用空格拼起来，所以带空格/引号的参数自己加引号）。
- **`resolveBili` 去掉不再需要的 `platform` 参数**（`needsShell` 自己读 `process.platform`）。
- 新增回归测试：`packageRootOf` 的切分与脏输入、`needsShell` / `quoteForShell`、
  `runExport` 对 `.cmd` 必带 `shell: true` 且引号到位、以及「探测结果永不指向 `.cmd`/`.bat`」。

### 说明（保留的口径，不是疏漏）

- **阈值继续按 token 判**（`usage.inputTokens`，用户明确选定）。已知代价见 `docs/review-0.7.0-handoff.md · P0-3`：
  这个数是 bili **压缩之后**的上行计费输入，而 bili 那次 fail-fast 的请求没有上游响应、也就不产生
  usage 事件 ⇒ 该判据在最坏的那条路径上可能不触发。改用字节口径（会话日志大小 / 折叠时累加字节）
  留在下一版评估。

---

## [0.7.0]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.7.0**。
> 上一版 0.6.5 的条目见下一节 `[0.6.5]`。

### 变更

- **新增「交接文档自动导出」（默认开，可显式关）**。背景：bili 的 preflight 护栏按**单次请求核心文本**判死
  （`payload core text alone is ~… bytes … vs the model window …`），会话太长时连转发机会都没有；
  bili 官方给的迁移路径就是 `bili export` 出 Markdown 交接文档（`CONFIGURATION.zh-CN.md:1791`、`:2123-2132`）。
  本版把那个动作做成可在阈值处自动化的一步。
- **新增模块 `lib/handoff.js`（纯逻辑 + 可注入 I/O）**：`shouldExport`（阈值 + delta 节流，口径
  `usage.inputTokens`，与 bili 那条护栏**同口径**）、`resolveBili`（**三级探测**：配置绝对路径 → 包内入口
  `billion-context/dist/index.js` + `process.execPath` → profile 的 `node_modules/.bin/bili[.CMD]`）、
  `safeSegment` / `handoffTarget` / `exportArgs` / `runExport`（注入 `spawn`、120 s 超时、只结算一次）。
  该模块**不真做 I/O、不碰时间**，因此全部用例走注入替身（不真起进程、不写盘）。
- **`DEFAULT_CONFIG` 新增 6 个键**（`lib/state.js`，`cordis.patch.yml` 逐字镜像）：`handoffExport`(true，
  用户要求装上就工作；**显式 `false` 必须真的不做事**：不探测命令、不起进程、不建目录) /
  `handoffExportTokens`(400000，1M 窗口的 40%) / `handoffExportMinDeltaTokens`(100000) /
  `handoffExportDir`('handoff') / `handoffExportFull`(false) / `handoffExportBiliBin`('')。
- **wire 升 v8（34 → 35 键）**：尾部追加 `handoff` 键（`{ status, at, path, inputTokens, message }`）；
  `lib/client.js · EXPECTED_V` 同步为 8；面板新增一行灰色 info「交接文档」，六态
  `disabled` / `idle` / `running` / `done` / `failed` / `unavailable`，**排在「最近的故障」上方**
  —— 未开启与探测不到都不是故障，不能混进红字。
- **`initState` 记下 `header.cwd`**（`SessionHeader` 字段，`@deepseek-ai/dsh-session`；session-persistence
  README `:63` 逐字列出 `cwd?`）：`init` 是**唯一**能拿到会话头的点（`docs/design.md` §2.8），只在这里存一次。
  它不是 wire 字段，只给宿主侧导出解析目标路径用。
- **宿主接线**：`lib/index.js` 包住投影 `apply` → `noteHandoff(state, effective)`。`unavailable`（探测不到 bili）
  与 `disabled`（默认关）都是**缺席，不是故障**，绝不进 `hookFaults`；`running` 不重触发；本进程最多起 8 次导出
  （冷启动重放可能多会话同时越阈值）。任何异常只记 fault，绝不打断折叠。

### 未实现（留给下一版）

- 交接导出**不自动切新会话**：界面上打开哪条会话是客户端状态，宿主侧插件改不了。
- 面板上还没有「立即导出」按钮（当前只能靠阈值触发）。
- 导出完成后没有通知（可复用 `@wingsky-1/dsh-notifier` 的通道）。

---

## [0.6.5]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.6.5**。
> 上一版 0.6.4 的条目见下一节 `[0.6.4]`。

### 变更

- **拿不到宿主 pruner 就用插件自己的本地裁剪（B3 真正开始工作）**：0.6.4 把 `pruner === null` 当成「缺席」
  返回 `null` 保持 inline，于是**线上一次都没瘦身过**——`lib/spill.js · spillOnce` 里那条
  `absent(ctx, ABSENT_PRUNER)` 分支与 `ABSENT_PRUNER` 常量就此**删除，不留死代码**；改为调用新增的纯函数
  `localTrim(content, config)`。`store === null` 仍走 `absent(ctx, ABSENT_STORE)`（一字未动）。
  **宿主 pruner 优先**：能拿到就仍用它（保持与宿主语义一致），只有拿不到才本地裁剪。
- **新增纯函数 `lib/spill.js · localTrim(content, config) -> ContentBlock[] | null`**：不改入参（返回新数组、
  新对象）；只处理 `{ type:'text', text }` 块、**其它类型块原样保留同一引用**；只取**最长**的那个文本块；
  该块短于 `localTrimMinChars` 不裁；保留头 `localTrimHeadChars` + 尾 `localTrimTailChars`，中间插一行
  `\n…（此处省略 {n} 个字符）…\n`（`n` = 被省略的字符数）；**结果不短于原文就返回 `null`**（绝不把正文变长）；
  三个配置项任一非法视为未配置、返回 `null`。
- **Config 新增 3 键（21 → 24 键）**：`localTrimHeadChars: 4096`、`localTrimTailChars: 1024`、
  `localTrimMinChars: 8192`，`DEFAULT_CONFIG` 与仓库根 `cordis.patch.yml` **逐字镜像**。
  `spillThresholdBytes: 32768` 仍是外层字节门槛（两把尺子各管一层：外层决定"要不要落盘"，本地裁剪决定"给模型看多少"）。
- **增强层状态加 `mode`（三态）**：`enhancementOf(ctx)` 现返回 `{ active, mode, reason }`，
  `mode ∈ {'host-pruner','local-trim','off'}`；wire `enhancement` **只在该对象内加 `mode`，不删既有字段**
  （键数仍 34）。面板灰 info 行三态：`已启用（宿主裁剪）` / `已启用（本地裁剪）` / `未启用 · 没有落盘后端`；
  `DICT` 中英各补 2 个键（`enhancement.mode.host` / `enhancement.mode.local`）。
- **版本配套（E）**：`TURBO_STATE_VERSION` 6 → 7、`lib/client.js · EXPECTED_V` 6 → 7、
  `package.json · version` 0.6.4 → 0.6.5。测试同步：`v:6` → `v:7`、三方版本等式继续相等、
  版本错配用例反向为「宿主 v6 ≠ 客户端 v7」。
- **9 条新测例（真跑 `spillOnce` / 真调 `localTrim` / 真渲染面板，不造假）**：① 无 pruner ⇒ 走本地裁剪且
  `onFault` 零调用；② 本地裁剪保头 4096 / 保尾 1024、含省略标记、入参一字未动；③ 非文本块不被丢（同一引用）；
  ④ 最长块短于 `localTrimMinChars` ⇒ 返回 `null`、不落盘、不上报；⑤ 结果不短于原文 ⇒ 返回 `null`（含边界与
  非法配置）；⑥ 宿主 pruner 优先（本地裁剪零触发）；⑦ `enhancementOf` 三态 `mode` 正确；⑧ 面板渲染
  「已启用（本地裁剪）」灰 info 行；⑨ 本地裁剪路径仍把**完整原文**走 `spillStore.saveText`、`locator` 是绝对路径。

### 偏离任务书（如实申报）

- 任务书把「本地裁剪」的配置读取交回宿主（`DEFAULT_CONFIG`），但**未说明 `lib/spill.js` 是否直接调
  `lib/state.js` 的默认值**：本模块一贯不定义默认值（`readThreshold` 同纪律），因此三个 `localTrim*` 项
  一律由调用方合并后传入；`localTrim` 对缺失 / 非法值**返回 `null`（宁可不裁）**，而不是自带兜底数字。
- 任务书写 `store === null` 仍走 `absent(ctx, ABSENT_STORE)`：**照做**。但该 message 的**本地化文案**同步
  调整为「没有落盘后端」（原文「本机没有加载结果落盘后端」），以便与任务书给定的面板串逐字一致。

## [0.6.4]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.6.4**。
> 上一版 0.6.3 的条目见下一节 `[0.6.3]`。

### 变更

- **「可选能力缺席」不再当故障（A/B/C）**：`lib/spill.js · spillOnce` 里 `store === null` 与 `pruner === null`
  两条不再走 `degrade()`（那会把 `faultReporter` 接上 → 详情面板「最近的故障」永久红字），改走新增的
  `absent(ctx, message)`：**只 `ctx.logger.warn`（整个包 `try/catch`）、不上报、不抛、返回 `null` 保持 inline**。
  其余 6 条失败路径（`resolveStore` 抛错、`pruneContent` 抛错、`pruneContent` 返回非数组、`saveText` 抛错、
  locator 非绝对路径、无 session owner）**仍走 `degrade()` 如实报故障**——「缺席」与「真失败」从此分道。
  去重靠模块级 `const warnedAbsent = new Set()`：同一进程内同一缺席原因只 `warn` 一次，不刷屏。
  根因写进 `resolvePruner` 上方注释：preset 的 `isolate: {toolResultPruner: true}`
  （`presets/cordis.patch.yml:62-78`）把 `toolResultPruner` 关在 `cordis:group` 内，**组外读不到是设计，不是缺陷**。
- **增强层状态进 wire（D）**：新增导出 `lib/spill.js · enhancementOf(ctx)`（探测 `spillStore` / `toolResultPruner`
  是否在位，异常一律吞、回落到「在位」），新增 `lib/state.js · pushEnhancement(sessionId, enhancement)` 写入
  模块级 per-session 运行时表，wire 快照新增 `enhancement: { active, reason }`（默认 `{active:true, reason:null}`）。
  详情面板在「最近的故障」**上方**（「最近瘦身」之后）恒挂一行**灰色 info**（`--dsw-alias-label-secondary`，
  不是错误红）：在位显示「已启用」，缺席显示「未启用 · <本地化理由>」。**缺席绝不出现在 `recentFaults` / `hookFaults`**；
  `reason` 里的机器串（`no ctx.toolResultPruner loaded` 等）**绝不原样上屏**，一律映射成本地化文案以避开
  U7 黑名单（`/投影|projection|fiber|host|ctx|slot/i`）。`DICT` 中英成对补齐 6 个键。
- **版本配套（E）**：`TURBO_STATE_VERSION` 5 → 6、`lib/client.js · EXPECTED_V` 5 → 6（wire 33 → 34 键）、
  `package.json · version` 0.6.3 → 0.6.4。测试同步：`v:5` → `v:6`、三方版本等式继续相等、版本错配用例反向为
  「宿主 v5 ≠ 客户端 v6」、分区顺序断言加「工具增强」。
- **新增 6 条测例（真跑 `spillOnce` / 真渲染面板，不造假）**：① pruner 缺席 ⇒ `spillOnce` 返回 null 且
  `onFault` 一次未调；② 同一缺席原因连续两次只 `logger.warn` 一次；③ `pruneContent` 抛 `Error('boom')` ⇒
  `onFault` 被调且 message 含 `boom`；④ `pruneContent` 返回非数组 ⇒ `onFault` 被调；⑤ `spillStore` 缺席同样不报故障；
  ⑥ 面板契约：`enhancement` 渲染为灰色 info 行、缺席时 `recentFaults` 为空。

### 偏离任务书（如实申报）

- 任务书说「增强层状态写进 `runtimeBySession`」但未点函数名：这里新增独立导出 `pushEnhancement`，与既有
  `pushHookFault` / `pushSpill` 同构（`runtimeEntry` 增一个 `enhancement: null` 槽，**不进 `initState` / `applyEvent`**，
  与 §3.8「不假装折叠」一致）。
- 任务书只要求**在「最近的故障」上方**：实测分区顺序为「…· 等待占用 · **最近瘦身** · **工具增强** · 最近的故障」。
  因「最近瘦身」是条件分区、而「工具增强」恒在，二者并列时增强行落在瘦身之后——仍在故障上方，未违反要求。

## [0.6.3]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.6.3**。
> 上一版 0.6.2 的条目见下一节 `[0.6.2]`。

### 变更

- **耗时全中文单位（A）**：`lib/client.js · fmtElapsed` 重写为五档 `毫秒 / 秒 / 分秒 / 小时分秒 / 天小时分`，
  并把 `lib/client.js` 里**所有裸 `ms` 渲染点**（空闲行、投影缺席宽限期、宽限期 `console.error`、
  面板「最慢的工具」「等待占用」「上回合」各值行）一律改走 `fmtElapsed`。四条硬断言逐条通过：
  `18726648 → 5小时12分6秒`、`900014 → 15分0秒`、`362351 → 6分2秒`、`820 → 820毫秒`。
  **已知偏离**：任务书注释写「秒四舍五入」，但 `18726648` 四舍五入会得到 `7秒`，与同一份任务书的
  硬断言冲突 —— **断言表优先**，分/时分支的秒一律 `Math.floor(ms / 1000)`（先整除出 `totalSeconds` 再拆分）。
- **新增第 4 类等待 `job`（B）**：`toolKindOf` 签名 `(name, config)` → **`(name, args, config)`**；
  `jobWaitTools`（默认 `['job_output','job_wait']`）命中 **且** `args.wait === true`（严格布尔）才归 `'job'`。
  `lib/state.js · tool/call` 负责把线格式的 `data.arguments`（JSON 字符串）解析成对象，解析包 `try/catch`；
  `args` 非对象 / `null` 一律判 `'exec'`，**绝不抛错**（0.6.2 的教训：热路径异常必须吞掉）。
  `topTools`（`kind === 'exec'`）/ `waitTools`（`kind !== 'exec'`）的老口径未动，`job` 自动落进等待类。
- **最慢调用的参数摘要（C）**：新增导出纯函数 `summarizeArgs(args, config)` —— 字符串先 `JSON.parse`
  （`try/catch`）→ 非对象 ⇒ `null` → 复用既有 `redactArgs` 整棵脱敏（**先脱敏，再上屏**）→
  按主键 `command / cmd / CommandLine / file_path / path / pattern / sql / url / query / job_id / ids / name`
  取第一个命中 → 否则 `stableJson` → `previewText` 折叠空白、空 ⇒ `null`、超 **`ARG_PREVIEW_MAX = 140`**
  截断加 `…`。`aggregateTool` 加第 6 参 `argPreview`（首次非 null 即固定，**不参与淘汰排序**，
  `isWorseEntry` / `MAX_AGG_KEYS` 不变）。wire 的 `topTools` / `waitTools` 元素各加
  `argPreview: string | null` 与 `slow: boolean`（`= maxMs >= slowMs`，新配置键 **`slowMs: 60000`**）；
  `toView` 顶层新增 `slowMs`。客户端：值行末尾附 ` · {argPreview}`（走 `safeText`），`slow` 行前加 `⚠ `，
  分区末尾**只在真出现慢行时**给 `hint.slowTool`（zh `超过 {n} 的调用可交给后台任务插件 run_command`）。

### 新增

- **wire 视图 v5（33 键，`TURBO_STATE_VERSION` 4 → 5，`EXPECTED_V` 4 → 5）**：在 v4 的 32 键之上
  只加 `slowMs`。**已知偏离**：任务书的键清单只列了 32 键 + 两个元素新字段，没有 `slowMs`；
  客户端分区尾提示需要把阈值用 `fmtElapsed` 打出来，wire 上没有别的字段带着它，故补此键并在此声明。
- **Config 19 → 21 键**：`DEFAULT_CONFIG` 与仓库根 `cordis.patch.yml` 同步新增
  `jobWaitTools`、`slowMs`（后者逐字镜像）。
- **测试**：`test/state.test.mjs` wire 契约 32 → 33 键（`V5_VIEW_KEYS = ['slowMs']`），
  `toolKindOf` 既有 12 条用例改 3 参形式 + 新增「第 4 类 job」正反例与脏 `args` 例，
  新增 `summarizeArgs` 纯函数例（主键优先 / 脱敏 / 截断 / 脏输入不抛）、
  `argPreview` 走完整管线 ⇒ `{"token":"***"}` 例、`slow` 判定例；
  `test/halves.test.mjs` `v: 4` → `v: 5`（12 处）、版本错配反向为「宿主 v4 ≠ 客户端 v5」、
  状态条耗时断言改中文容错、面板格式断言改中文单位，新增「慢行 ⚠ + 摘要 + 提示」2 例与
  状态条「等后台任务」1 例；`test/ui-contract.test.mjs` 快照 `wireV4` → `wireV5`。

---

## [0.6.2]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.6.2**。
> 上一版 0.6.1 的条目见下一节 `[0.6.1]`。

### 修复

- **未声明进 `inject` 的服务只能经 `ctx.get` 读取（线上「工具增强失败」红字）**：
  0.6.1 装到本机、宿主半首次真正加载后，详情面板的「最近的故障」记下逐字一行
  `15:08:36 spill: cannot get property "toolResultPruner" without inject`，状态条同时报红字
  「工具增强失败」。根因在 `lib/spill.js · resolvePruner`：它用**属性直读** `ctx.toolResultPruner`
  取宿主的结果瘦身服务，而该服务**没有声明进模块级 `inject`**（那里只有 `['sessionProjections']`）。
  Cordis 上下文对未声明服务的属性读取是**抛错**，不是返回 `undefined`；这条异常在本模块内没有
  catch（本模块所有宿主能力调用都假定"返回 null 即不可用"），会冒到 `lib/index.js` 的
  `tools/post-execute` 监听器，被记成 `hook='spill'` 故障 —— 即**一次可控降级被升级成一次故障**。
  触发条件：某个工具结果 ≥ `spillThresholdBytes`（默认 32768 字节）且 `isError === false`、`name !== 'read'`。
  **不是 0.6.1 引入的**：`dist/dsh-turbo-0.5.0.tgz` 里同一行为逐字相同。0.5.0–0.6.0 之所以没暴露，
  是因为那几次安装都是热应用、宿主半从未真正加载（或没出现过这么大的工具结果）。
  修法：新增 `readOptionalCapability(ctx, name)`，**先走 `ctx.get(name)`** —— 这是宿主自己的读法，
  见 `packages/compaction/compaction-basic/src/index.ts:281` 的 `this.ctx.get('toolResultPruner')`
  与 `compaction-tool-result-pruner/README` 的 "reads it through optional `ctx.get('toolResultPruner')`"；
  属性直读降为兜底通道，两条都包 `try/catch`。`resolvePruner` 与 `faultReporter`（`ctx.reportFault`，
  同类未声明能力，且**正好在降级路径上**被求值）一并改用该函数。

### 新增

- **回归测例**：`test/spill.test.mjs` 新增 `makeCordisLikeCtx` 替身（读未声明服务属性即抛
  `cannot get property "X" without inject`）与 4 条用例：「未声明 pruner → 降级成 fault」
  「`onFault` 与 `reportFault` 都缺席 → 走契约的抛出，而不是先抛 without-inject」
  「pruner 在服务表里 → 经 `get` 正常瘦身」「`reportFault` 在服务表里 → 降级故障仍可上报」。
  旧测例一律用普通对象替身（`makeCtx`），**永远复现不出这条限制** —— 这正是 171 条测试全绿却仍漏掉它的原因。

---

## [0.6.1]

> **发布待办（不由本文件执行）**：本节内容已随 `package.json · version` 升到 **0.6.1**。
> 上一版 0.6.0 的条目见下一节 `[0.6.0]`（原 `[Unreleased]`，按本文件口径在发布时改名）。

### 变更

- **`topTools` 语义收窄，等待类另立 `waitTools`（wire 视图 v4，`TURBO_STATE_VERSION` 3 → 4）**：
  0.6.0 之前「最慢的工具」把**等子代理**（`wait_agent`，超时 900s）与**等用户回答**
  （`ask_user_question`，真实样本一次 18726648ms = 5.2h）也算成「工具耗时」，长期霸榜、挤掉真正慢的命令。
  0.6.1 **不改计时口径**（`ms` 仍是相邻事件时间戳差），只把等待类从 `topTools` 里摘出去：
  `topTools` 现在只含 `kind === 'exec'`（排序与元素字段 `{name,key,count,maxMs,avgMs}` 逐字不变）；
  新增 `waitTools`，只含 `kind !== 'exec'`，同一排序取前 5，元素多带 `sumMs` 与 `kind`。
  依据：`lib/state.js · TURBO_STATE_VERSION`、`lib/client.js · EXPECTED_V`（同步为 `4`）。

### 新增

- **工具三分类纯函数 `toolKindOf(name, config)`**：`humanWaitTools` 命中 ⇒ `'human'`；
  `subagentWaitTools` 命中 ⇒ `'subagent'`；否则 `'exec'`（两者同时命中时 human 优先；`name` 非字符串 ⇒ `'exec'`）。
  分类结果随聚合条目存进 `kind`；`isWorseEntry` / `MAX_AGG_KEYS`(200) 不变，`kind` 不参与淘汰。
- **新 Config 键**：`subagentWaitTools`(`['wait_agent']`) / `humanWaitTools`(`['ask_user_question']`)。
  脏值容忍：非数组回落默认、数组里的非字符串元素忽略、**显式空数组 = 该类别不拦**。默认值唯一源仍是
  `lib/state.js · DEFAULT_CONFIG`，`cordis.patch.yml` 逐字镜像（17 → 19 键）。
- **wire 视图新增 2 个派生字段**：`waitKind`（`'subagent' | 'human' | null`；`tool/call` 进入，
  `tool/result` / `turn/end` / `turn/start` 清除）与 `subagents`（本回合派生子代理数）。
  `toView` 由 29 键扩到**恰好 32 键**，v1/v2/v3 的 29 键逐字不变、仅追加。
- **状态条等待态**：`waitKind === 'human'` 阶段文字变 `⏸ 等你回答`，`'subagent'` 变 `⏳ 等子代理`
  （已耗时逻辑不变，仅补 `已` 前缀）；`subagents > 0` 时追加 `· 本轮 N 个`。
  数据源是 `subagent/catalog` 事件，**只做 +1、不猜载荷字段**；事件缺席时恒为 0（优雅降级）。
- **详情面板新增「等待占用」分区**：插在「最慢的工具」之后 ⇒ 基础分区 7 → 8 个（带条件分区时共 10 个）。
  每行 `{等你回答 | 等子代理} · {name} · {count} 次 · 累计 {fmtElapsed(sumMs)} · 最慢 {maxMs}ms`；
  「最慢的工具」空态文案改为「本会话还没有真执行的工具调用」。新增文案键 7 个（zh + en），全部走 `text()`。

---

## [0.6.0]

> （原 `[Unreleased]`；0.6.0 已随 `package.json · version` 对齐后按本文件口径改名。）

### 新增

- **wire 视图 v3（`TURBO_STATE_VERSION` 2 → 3）**：`toView` 由 28 键扩到**恰好 29 键**，v1 的 19 键与 v2 的 9 键逐字不变、仅追加。
  新键只有 `activity`。客户端 `EXPECTED_V` 同步为 `3`，不等则红格报「投影版本错配」。
  依据：`lib/state.js · TURBO_STATE_VERSION`、`lib/client.js · EXPECTED_V`。
- **0.6.0 内容层「活动流」（内存环缓冲，不落盘、不新增依赖）**：在**现有**四个 case 里追加活动条目 ——
  `assistant/message` → `{t, kind:'reason', text}`（取 `message.content[]` 里第一条 `type === 'reasoning'`，截到 `reasoningChars`）、
  `tool/call` → `{t, kind:'call', name, args}`（`args = redactArgs(data.arguments)`）、
  `tool/result` → `{t, kind:'result', ok: !data.error, head}`（`head = firstLines(data.message ?? data.error, resultHeadLines)`）、
  `turn/end` → `{t, kind:'turnEnd', reason}`。环缓冲按 `activityLimit`（条数）与 `activityBytes`（UTF-8 字节）双上限从头部淘汰；
  单条自身就超字节上限时至少保留最新一条。新增纯函数 `redactArgs` / `firstLines` / `pushActivity`（`lib/state.js`）。
- **工具参数脱敏（上屏前）**：`redactArgs` 递归拷贝一份纯 JSON，命中 `redactKeys`（**大小写不敏感、子串匹配**）的键值换成 `'***'`；
  深度上限 3，字符串截断到 200 字符，循环引用换成 `'[Circular]'`，函数 / symbol / bigint 各自降级，**绝不抛错**。
- **详情面板新增两个分区**：`现在`（阶段中文名 · 已耗时 · 工具名，单行）与`活动流`（倒序 `HH:MM:SS  标签  内容`），
  插在「本回合」**之前** ⇒ 面板分区由 7 个变为 9 个（两个条件分区仍在末尾）。思考行斜体 + `--dsw-alias-label-secondary`；
  调用行等宽；失败行 `--dsw-alias-state-error-primary`；内容 `userSelect: 'text'` 可选中复制。
- **新 Config 键**：`activityLimit`(24) / `activityBytes`(8192) / `reasoningChars`(400) / `resultHeadLines`(6) /
  `redactKeys`(11 键：key / token / secret / password / passwd / pwd / authorization / cookie / dsn / apikey / credential)。
  默认值的唯一源是 `lib/state.js · DEFAULT_CONFIG`，`cordis.patch.yml` 逐字镜像。

### 变更

- `lib/index.js`：投影 `definition.apply` 开始把合并后的 `effective` 配置传给 `applyEvent(state, event, effective)`，
  否则新活动 Config（条数 / 字节 / 截断）在真实运行时不会生效（只会认 `DEFAULT_CONFIG`）。
- **包名 `dsh-turbo` → `dsh-status-turbo`**：npm 上已存在同名的**另一个**插件（另一作者、另一用途），继续用该名字会造成
  「同名不同物」，故更名后再发布。同步改动：`package.json · name`、`cordis.patch.yml` 的 `id` 与 `name`、
  `lib/index.js · export const name`、`lib/client.js` 的 `id` / 命名空间 `NS` / 槽位条目 id（`dsh-status-turbo.status`
  与 `dsh-status-turbo.detail`）以及相关测试断言。**仓库目录名仍为 `D:\project\dsh-turbo`**（文档与测试里的路径引用因此保持不变，
  属有意保留）。投影键仍为 `turbo`，wire 视图与 Config 键名不变。
- `lib/client.js`：详情面板渲染期异常的红字不再重复写插件前缀。`errorPill` 内部已经拼过一次 `${NS}: `，
  面板分支此前又自己拼了一次，界面上出现过 `dsh-status-turbo: dsh-status-turbo: 详情面板渲染失败…`；
  现已与状态条分支（`状态条渲染失败`）保持同一种写法。测试相应从子串匹配收紧为整串匹配。

## [0.5.0]

> **发布待办（不由本文件执行）**：本节内容对应 `package.json · version` 从 `0.4.1` 升上去的**下一个版本**。
> 目标版本号是 **0.5.0**（本文件头与本节均按此口径书写）⇒ **T11（打包/发布）必须把 `package.json · version` 对齐成 `0.5.0`**，
> 并把 `CHANGELOG.md` 加进 `package.json · files`（否则发布包里没有本文件）。
> 升版也是装机的前置条件：同版本号重复 `install_bundle` 会得到 `ambiguous-install`。

### 新增

- **wire 视图 v2（`TURBO_STATE_VERSION` 1 → 2）**：`toView` 由 19 键扩到**恰好 28 键**，v1 的 19 键逐字不变、仅追加。
  9 个新键：`mountStatus` / `prefixEpoch` / `prefixCause` / `prefixAt` / `lastTurnMs` / `topTools` / `hookFaults` / `idleLine` / `lastSpill`。
  客户端 `EXPECTED_V` 同步为 `2`，不等则红格报「投影版本错配」。依据：`lib/state.js · TURBO_STATE_VERSION @ :23`、
  `lib/client.js · EXPECTED_V @ :70`。
- **B4 缓存前缀失效可见（零行为变更）**：前缀被作废时 `prefixEpoch += 1`、`prefixCause`/`prefixAt` 取最近一次。
  触发源只有三个会话日志事件真名：`compaction/start`、`compaction/end`、单条 `tool/result` 载荷 UTF-8 字节数 ≥ `bulkInjectionBytes`（默认 32768）。
  状态条在**最近 5 分钟**内插一个「前缀已失效」告警 pill（不显示次数）；详情面板「前缀」分区恒显示失效次数、最近一次原因与时间。
- **A2 最慢的 5 件事**：按「工具名 × 参数指纹」聚合（`key = name + '\u0000' + fingerprint(arguments)`），
  数据来自**会话日志**（相邻 `tool/call` 的 `event.time` 之差），不读宿主内存；`topTools` 长度 ≤ 5，
  排序 `maxMs`↓ → `count`↓ → `name` localeCompare↑，`avgMs = Math.round(sumMs / count)`。详情面板第 5 分区逐行展示。
- **B3 超大结果瘦身**：单条工具结果正文 UTF-8 字节数 ≥ `spillThresholdBytes`（默认 32768）时，
  先调宿主的 `toolResultPruner.pruneContent`（**不自写截断**），再经宿主 `spillStore.saveText` 落盘，
  在原位置换成「通知行 + 落盘**绝对路径**」，并在同一份 `lastSpill` 里记账。详情面板「最近瘦身」分区显示 `{bytes} bytes → {locator}`（等宽、可选中）。
- **C1 / C2 / C3 四类模型上下文提示**：`C2` 只读了文件一部分（给出真实总行数与绝对路径）、
  `C3-a` 输出里的中文已损坏（连续替换字符 ≥ `mojibakeMinRuns`）、`C3-b` 输出被噪声淹没、
  `C1` 命令本该拿得出证据而输出里没有。四段与 B3 **共用同一个 `tools/post-execute` 监听器**，
  **一次 `accept`、零新增往返**（判定＝`step/start` 计数不变）。
- **详情面板（新 UI）**：挂在 `conversation.input.dock`（`id: dsh-status-turbo.detail`，`order: 0`），默认收起、点击开合，
  固定 7 个分区：本回合 / 上回合 / 缓存与用量 / 前缀 / 最慢的工具 / 最近瘦身（条件）/ 最近的故障（条件）。
- **D 的 `stuckAction` 配置**：`'warn' | 'nudge' | 'stop'`，默认 `'warn'`。`nudge` / `stop` **必须显式配置**才可达；
  `stop` 触发前必须先 `workspace/session-activity` 确认还有活动，为空则 fail-closed 不 emit。
- **新 Config 键**：`spillThresholdBytes`(32768) / `bulkInjectionBytes`(32768) / `evidenceWhitelist`(3 条正则) /
  `stuckAction`('warn') / `stuckRounds`(3) / `stuckRepeats`(3) / `mojibakeMinRuns`(2)。默认值的唯一源是
  `lib/state.js · DEFAULT_CONFIG`，`cordis.patch.yml` 逐字镜像。

### 变更

- **空闲态不再「消失」**：`busy === false` 时摘要行改为**常驻上回合摘要**（`{阶段中文名} · 上回合 {耗时}`，
  宿主给 `idleLine` 就用它，缺席时客户端自行合成），不再 `return null`。新增的详情面板是它的可发现入口。
- **一行摘要在窄屏下的排版**：`ROW_STYLE` 增加 `flexWrap: 'wrap'`，长告警文本带 `maxWidth` + `textOverflow: 'ellipsis'` + `overflow: 'hidden'`。
- **`sep()` 分隔点间距对齐宿主**：由 `margin: '0 1px'` 改为 `margin: '0 6px'`（抄原生统计行的实际值）。
- **`hookFaults` / `lastSpill` 使 wire 视图不再是日志的纯函数**：这是本版**唯一**的破例。
  缓解：字段名与语义在 wire 契约里标注为「非日志派生」；重放工具对它们只做排除与断言；
  它们只在**真的出错 / 真的落盘过**时才非空、非 null，正常重放必然为 `[]` / `null`。

### 修复

- **`no disk writes` 的措辞限定**：B3 把「持久化超大工具结果」委派给宿主自带的 `spillStore`，
  dsh-status-turbo 自己仍然**从不打开文件写入、从不 import `node:fs` 的写入 API**；落盘路径只是原样呈现。
  这条例外已写进 `docs/design.md` §8 与 README 的约束说明。
- **B1 会话 id 的取法**（0.3.1 起的历史修正，本版沿用并扩到钩子层）：优先用声明里的 `agent.id`，
  拿不到才退到运行时的 `agent.session.id`，两者都没有就放弃并告警一次（绝不静默失效）。

### 已知限制（本版）

本版**没有**声称以下任一项已完成 —— 详见 `docs/design.md` §4.3「0.5.0 的诚实缺口」与 `docs/acceptance.md`：

- **B2 长工具后台化：未实现**。取证结论是「本插件内不具备落点」，登记为 BLOCKED，**见 `docs/plan-B2.md`**。
- **D 只做到 `warn` 层**：默认 `warn` 零副作用；`nudge` / `stop` 显式可达。**`stuckRounds` 目前无任何消费者**
  （它的 `turn/end` 窗口在 `tools/post-execute` 这一层看不见，实现者刻意没有自造第二套判据），
  在消费者落地前它的配置值对行为**无影响**。
- **U3「是否与原生并排同一行」未经实机验证**：本机没有渲染/截图能力，只有结构断言与源码实读，
  **不能**当作「已并排」。需要用户实机截图（`docs/acceptance.md · U3`）。
- **A2 的"聚合键"在代码里有两份实现，算法不同**：wire `topTools` 由宿主半自己算（`lib/state.js · :209-221`，
  稳定 JSON + **SHA-256 前 12 位**，与 PLAN §3.6 一致）；`lib/notes.js · :409-431` 另有一份供钩子层（D 的卡住判据）使用，
  用**自实现的 FNV-1a-64**。同一个工具调用在两处会得到**不同的指纹字符串**。功能上不致命（每处自洽），
  但属重复实现 + 口径分叉，如实记录。

---

## [0.4.1]

### 修复

- **`statusBar` 是一个死开关（README 承诺为假）**：`statusBar` 唯一出处是 `DEFAULT_CONFIG`，
  `toView` 从不输出它、客户端从不读它 ⇒ README 里「可以关掉状态条」的承诺是假的。本版把它接上：
  投影成 wire 字段 `mountStatus`（`effective.statusBar === false` → `'disabled'`，其余一律 `'enabled'`，非法值不抛错），
  客户端三态处理 —— `'disabled'` 时摘要行与详情面板都 `return null` 且**跳过 3 秒自检**；
  `'enabled'` 或快照未到达时行为不变；宿主半真挂了时仍然报障（「失败必须可见」优先于「开关静默」）。

### 已知限制

- 上表第 3 行是**有意保留**的取舍，不是遗漏：`statusBar: false` 但宿主半真的没起来时，界面照样报障。

---

## [0.4.0]

### 变更

- **状态条搬迁**：从 `conversation.input.dock`（composer 卡片**上方**那条通栏）搬到
  **`conversation.composer.dock`**（DSH 自带的 composer 底部状态行那一格），
  `id` 保持 `dsh-status-turbo.status`、`order: 1`（排在原生 `stats` 右侧）。
  动因是用户截图反馈「悬在输入框上方很突兀」，要求并进原生统计那一行。
  ⇒ 0.4.0 起**两个 slot 分工**：摘要在 `conversation.composer.dock`，详情面板在 `conversation.input.dock`，
  两者**不能合并进同一个 entry**（`conversation.composer.dock` 是横排的 pill 行）。
- 分隔点颜色改用原生统计行的 `--dsw-alias-separator-primary`。

### 新增

- 视觉规范固化：四色层级（标题 `--dsw-alias-label-secondary` / 纯数值 `--dsw-alias-label-tertiary` /
  告警 `--dsw-alias-state-warn-primary` + `color-mix` 淡底色 / 错误 `--dsw-alias-state-error-primary`）。

### 已知限制

- 各项外观断言**只能证明「结构与数值和原生那一格一致」，不能证明「并排看起来好看」**：
  本机没有任意 HTML 的渲染/截图能力。0.4.0 的观感**未经实机视觉验证**。

---

## [0.3.1]

### 修复

- **B1 取不到会话 id 的真缺陷**：第一版写的是 `payload.agent.session.id` —— 运行期能跑，但它是**未声明**的字段
  （声明的 `Agent` 只有 `id`）。改成优先用 `agent.id`，退到运行时的 `agent.session.id`，
  两者都没有就放弃降档并**告警一次**。这个 bug 的表现形式是「B1 全程安静地什么都不做」，
  正是「不许静默失败」要防的那一类。

### 已知限制

- 会话 id 告警**只出一次**（不刷屏），因此后续同类失败不会再出现在日志里。

---

## [0.3.0]

### 新增

- **支柱 B1：按步降推理档（省算力）**。判据完全来自工具轨迹（自己折叠 `session/event`，
  不扫日志、不读宿主内存）：连续 `minQuietSteps`（默认 2）步「只跑只读工具且无报错」才降档。
- **只降不升**：目标档位永远严格低于当前档，绝不硬编码任何档位名、绝不改用户选定的模型/提供方。
- 接线在 `agent/request` 的 waterfall 里，且必须 `{ prepend: true }`（排在宿主自带 model-selection 的**外层**，
  否则改动会被它覆盖）。
- Config：`downgrade`(true) / `downgradeFloor`('low') / `minQuietSteps`(2)；非法值一律回落默认，绝不抛错。

### 已知限制

- `downgrade: false` 时**连 `llm` 都不 inject**（不依赖用不到的服务），此时 0 个 handler。

---

## [0.2.0]

### 新增

- **A1 状态条的第一个可用版本**：投影 + 挂载 + 三个阶段（组装提示词 / 请求模型 / 执行工具）+ 工具名 +
  本阶段已耗时 + 本步 token + 缓存命中率 + 无进展告警。

### 已知限制

- 只做「看得见」，不做任何行为改变（本版还没有 B1）。

---

## [0.1.3]

### 修复

- **「投影缺席」必须报警**（0.1.3 的行为修正）：宿主半没起来时，状态条**不许静默消失**，
  而要变成黄格 →（超过宽限期）红格，并点名原因。

### 已知限制

- 仅 `console.error` + 界面报障；**3 秒挂载自检**与 `dataset.dshTurboMountFailed` 是后续版本才加的。

---

## [0.1.0]

### 新增

- 首个版本：`turbo` 会话投影（宿主半）+ 状态条（客户端半），**零构建**（`lib/` 即源码即产物）、
  **零第三方依赖**（不引 zod、不引图标包，图标一律自绘）。
- 读侧用官方 `useProjection('turbo')`；写侧按 `sessionProjections.register` 注册；
  「不关心的事件返回同一引用」作为**契约**（不是优化）写进折叠器。
- 状态条挂 `conversation.input.dock`。

### 已知限制

- 无标题：本文件自 0.5.0 起维护，0.1.0 的细节以 `docs/design.md` §1–§5 为准；
  `0.1.1` / `0.1.2` 在 `docs/design.md` 里**没有留下可核对的记录**，因此本文件不为它们编条目
  （`dist/` 下留有 `dsh-turbo-0.1.2.tgz` / `dsh-turbo-0.1.3.tgz` 两个陈旧产物）。
