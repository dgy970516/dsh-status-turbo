# dsh-status-turbo 0.9.2 审计报告（汇总）

**审计对象**：`D:\project\dsh-turbo`（包名 `dsh-status-turbo`，版本 0.9.2）
**方式**：四位专家并行**只读**审计（软件架构师 / 后端架构师 / 前端开发者 / 开发者工具工程师），
结论全部基于实读代码，并与 DSH 源码树 `D:\deepseek-harness` 交叉核对槽位与宿主契约。
**完整原始报告**（512 行 / 71 KB，含每条的文件:行、复现条件与建议）见
[audit-0.9.2-experts-raw.md](audit-0.9.2-experts-raw.md)；本文件是汇总、判断与修复计划。

## 一句话结论

功能是通的，当下纪律也都成立（`cordis.patch.yml` 44 键与 `DEFAULT_CONFIG` **双向零差异**、
`TURBO_STATE_VERSION = EXPECTED_V = 10`、wire 36 键、`lib/state.js` 全文零 `Date.now()`、
locale zh/en 各 110 键零差异）。但审计出三类**真缺陷**，其中第一条直接解释了"轮换看起来没生效"：

## P0-A 客户端 `auto` 轮换在默认界面下**从不执行**（用户可见，最要紧）

- 链路：`rotationSection`（`lib/client.js:1264` 的自动触发在它内部）只被 `detailBody:1517` 调用；
  `detailBody` 只被 `TurboDetailPanel:1599` 调用；而 `:1598` 在 `collapsed` 时已 `return null`，
  `collapsed` 初值 = `!isDetailOpen(sessionId)`，**默认为 `true`**。
- 结论：**不手动展开详情面板，`mode:'auto'` 的客户端执行体一次都不会跑**。0.9.0 起宿主会自己建空白会话，
  所以"会话建了、但没人切过去、面板上也没有那一行" —— 用户看到的就是"什么都没发生"。
- 修法：触发点搬进常驻的 `TurboStatusBar` 的 `React.useEffect`（`useEffect` 在返回 `null` 时照样执行），
  依赖 `[status, mode, idle, childId]`，保留在飞标志防重入。

## P0-B 0.9.2 新引入的"水位账持久化"把**临态**也写进了账 ⇒ 会话永久停摆

- `lib/state.js:1385 ledgerOf` 把 `entry.handoff` / `entry.rotation` **整条**入账，`:1470 rehydrateRuntime` 原样还原，
  `lib/index.js:448` 对 `RUNNING || UNAVAILABLE` 直接 return。
- 于是 `unavailable`（当时没 cwd / 探测不到 bili）与 `running`（进程被杀在 120 s 导出窗口内）**跨进程永久化**：
  之后哪怕 bili 装好、配置改对、重启，该会话也再不会导出/轮换，面板永远显示假状态，且**没有任何日志**。
- 这是 0.9.2 引入的**回归**（0.9.2 之前运行表是进程内的，`unavailable` 会随进程消失）。
- 修法：账只承载**只增不减的水位与终态事实**（`payloadBytes` / `headerBytes` / `payloadSeq` / `laneWatermarks` /
  `rotationChildId`），状态一律不进账；再水化时绝不还原 `running` / `unavailable`。
- 关联 S3：`sessions.create` 之前不查宿主是否已有子会话，"每会话一次"全押在账上 ⇒ 账一丢就可能二次轮换。
  本轮先以"持久化 `rotationChildId`"把主风险收掉，反查宿主列为后续项。

## P0-C 两条主链**零测试覆盖**（"测试全绿但线上跑不通"，同类事故第三次）

- 交接导出执行编排 `lib/index.js:494-574`（`exportLane` / `planAndRun` / `onSettle` / `stampOf` /
  `readHandoffEntries` / `ensureHandoffDir` / `stderrTail`）在新版测试里 **V8 计数全 0**；
  `listLanes` 同样 0 次。测试只跑到"探测不到 bili → unavailable"就 return。
- 客户端轮换执行体 `lib/client.js:1365 performRotation` / `:1338 openWithRetry` / `:1316 rotationReasonText` /
  `:1299` 的点击入口同样 **0 次**；`docs/design-rotation.md:88` 要求的"注入假 `sessions`，断言调用顺序"
  这条验收从未落地。
- 同一个文件早就在 `docs/review-0.7.0-handoff.md:77`（P1-5）点过这件事，**当时没修**。

## P0-D 文档（操作性 runbook 会把人带沟里）

- `docs/packaging.md` 仍停在 **0.6.2**（拷贝命令写死 `dsh-status-turbo-0.6.2.tgz`、验收判据 `tests 175`）——
  照抄会装上一个 7 个版本前的产物。
- `docs/design-handoff-export.md` 六个键默认值全错、两处核心论证已被自己推翻，却**没有弃用横幅**。
- `docs/design-rotation.md` 仍是 fork 时代旧稿（0.9.0 已改方案 B）。

## P1 / P2 摘要（细节见原始报告）

| 组 | 条目 |
| --- | --- |
| 架构 | 投影 state 混入"日志不可重建"的账；`stateSchema` 直通导致 `stateVersion` 只承担缓存失效、零形状校验；折叠热路径上同步文件 I/O（`readdirSync`/`mkdirSync`/`writeFileSync`）；配置两条解析路径 + `readOnlyTools` 隐藏键 + 4 组默认值副本；模块级单例不可重入；`lib/index.js` 自述职责与实现不符；阈值住在交接导出的键名下 |
| 后端 | `createQuietly` 只挡同步抛错（thenable 会被当成建好、rejection 无人 catch）；异步终态进不了账而临态进了；无 teardown 守卫（dispose 后仍在起进程）；超时只 SIGTERM、管道不销毁；死分支 + `childId:null` 却让客户端去切；`listLanes` 失败没 stderr；每进程上限漏计车道读取；运行表按插入序淘汰会解除 `armed` 守卫；文件头声明与实际默认值互相打脸 |
| 前端 | 轮换结果写模块级变量、无重渲染订阅；失败后永久死锁且 `ready` 行不可点；活动流全量渲染 + 反转列表用 index 作 key；两处唯一交互入口无键盘/ARIA；面板耗时冻结；开合态串会话；状态条 2 Hz 整行重绘；12 个分区零 memo；版本错配文案不走 i18n；全角冒号硬编码；面板不可滚动、截断文本无 `title` |
| 工程化 | README 轮换小节与交接小节多处与代码矛盾；UI 测试全用手写快照（无一条用真实 `toView()`）；「三处同值」纪律无机检；`docs/design.md` 停在 0.6.5 |

## 未验证（审计方自述的边界）

- 未起真实 DSH 宿主、未跑真实 `bili export` ⇒ "生产会错"属于**代码路径零执行 + 本项目已发生两次同类事故**的推断，
  不是复现出来的失败。
- `stateSchema.parse` 被宿主调用已取证（`session-projection/src/index.ts:380-389`）；`viewSchema.parse` 是否被调用未取证。
- `docs/plan-B.md`、`docs/acceptance.md` 只做了版本级抽查；`dist/` 下 20 个 tgz 未逐个与源码比对。

## 修复计划（0.9.3）

**本轮做**：P0-A（触发点搬进状态条 effect）+ P0-A 伴生（H2/H3：结果落地要有渲染通知、失败后可重试、`ready` 行可点）
+ P0-B（账只留水位与 `rotationChildId`，状态不进账；再水化不还原 `running`/`unavailable`）
+ `createQuietly` 的 thenable 闸 + `childId:null ⇒ openChild:false` + `listLanes` 补 stderr + 文件头声明改对
+ P0-C（给两条主链补最小但真实的覆盖：宿主编排用注入替身驱动，客户端执行体抽成可注入函数后断言调用）
+ P0-D（重写 `docs/packaging.md`、给 `design-handoff-export.md` 挂弃用横幅、`design-rotation.md` 补"已定案"两行）。

**后续（按代价/收益排序）**：同步 I/O 移出折叠热路径 → `stateSchema` 窄校验或"状态形状变更必须升版"的源码级闸 →
配置单一路径（`resolveConfig`）+ 删默认值副本 → 前端 H4/M1–M9（活动流限长与稳定 key、面板定时器与滚动、
交互入口补键盘/ARIA、i18n 缺口）→ 模块级单例收进闭包（可重入/可多实例）→ S3 反查宿主已有子会话 →
teardown 守卫与句柄收尸 → 后台化 B2。

---

## 修复状态（截至 0.9.4）

**结论**：本报告的 P0-A/B/C/D 与 P1/P2 表内条目**已逐条落地** —— 0.9.3 修掉两条真回归并给两条主链补上真实覆盖，
0.9.4 收完剩余 P1/P2；其中可机械判定的部分固化为 `tools/audit-gate.mjs`（44 条「必须出现 / 必须消失」断言，
全过 exit 0，`--root <dir>` 可指向装好的那份跑）与 `tools/verify-install.mjs`。
版本口径：`package.json · version = 0.9.4`，`TURBO_STATE_VERSION = 10`，`DEFAULT_CONFIG` **46 键**，
wire 仍 v10 / 36 键（`ledger` 不进 wire），`lib/state.js` 无 `Date.now()`。
现场复核（本报告更新时实跑）：`node --test "test/*.test.mjs"` → **293 / 293 pass、0 fail**；
`node tools/audit-gate.mjs` → 共 44 条、未过 0 条；`node tools/verify-install.mjs` → 全部通过（版本一致、
两半 wire v10、40 个标量键与包内 `cordis.patch.yml` 同值、`lib/` 清单一致、wire 36 键不含 `ledger`、
对装好的副本跑闸门 44/0）。

| 条目 | 状态 | 版本 | 取证锚点 |
| --- | --- | --- | --- |
| P0-A 客户端 `auto` 轮换默认 UI 下从不执行 | 已修 | 0.9.3 | 触发点搬进常驻 `TurboStatusBar` 的 `useEffect`（`lib/client.js:1066` 订阅结果、`:1072` 判定 `armed + auto + idle` 后 `performRotation`）；结果改 `Map<sessionId, outcome>`（`lib/client.js:2260`）+ `subscribeRotation` 广播（`:2285`）；`ready`/`failed` 行可点重试（`:1638`、`:1761 performRotation(snapshot,{force:true})`） |
| P0-B 临态进账 ⇒ 会话永久停摆 | 已修 | 0.9.3 | 账只留只增不减的水位与终态事实（`payloadBytes`/`headerBytes`/`payloadSeq`/`laneWatermarks`/`rotationChildId`），**任何 status 不进账**；再水化不还原 `running`/`unavailable`；旧 ledger 只读新字段、旧字段忽略 |
| P0-C 两条主链零测试覆盖 | 已修 | 0.9.3 + 0.9.4 | 新增 `test/handoff-orchestration.test.mjs`（注入假 bili / 假 spawn 走真编排：起进程、建目录、写 `.gitignore`、记终态）、`test/rotation-client.test.mjs`（8 条，执行体抽成依赖可注入的函数）、`test/handoff.test.mjs`（S7 信号序列 + 管道销毁）、`test/rotation.test.mjs`（S3 复用与 `list` 缺失/抛错兜底） |
| P0-D 操作性 runbook 会把人带沟里 | 已修 | 0.9.3 + 0.9.4 | `docs/packaging.md` 重写到当前版本（去掉写死的文件数）；`docs/design-handoff-export.md` 顶部挂弃用横幅；`docs/design-rotation.md` 补「待定项已定案」；`docs/design.md` 补 §15「0.7–0.9 的演进」 |
| 架构 · 投影 state 混入「日志不可重建」的账 | 已修 | 0.9.3 | 同 P0-B |
| 架构 · `stateSchema` 恒等直通、零形状校验 | 已修 | 0.9.4 | `lib/index.js:110 export const turboStateSchema`（非对象、必填字段类型错 ⇒ `TypeError`；`step`/`turn` 负数 ⇒ `RangeError`）+ `:251` 注册；`viewSchema` 仍留恒等 |
| 架构 · 折叠热路径上的同步文件 I/O | 已修 | 0.9.4 | `readdir`/`mkdir`/`writeFile` 走 `node:fs/promises`；每 mount `preparedDirs` 缓存（`.gitignore` 每目录只写一次）；`noteHandoff` 成异步出口（永不 reject，折叠里 `void` 调用） |
| 架构 · 配置两条解析路径 + 4 组默认值副本 + 隐藏键 | 已修 | 0.9.4 | `lib/index.js:227 resolveConfig(config)`、`:232` 唯一一处解析并喂给所有消费者；`gears.js` 的 4 组副本删除；`readOnlyTools` 升为一等键（`lib/state.js:72`）、`handoffExportTimeoutMs` 一等键（`lib/state.js:190`，120000） |
| 架构 · 模块级单例不可重入 | 部分 | 0.9.4 | per-mount 状态（`ctx0`/`handoffSpawns`/`laneReads`/`liveChildren`/`active`/`stuckRuns`…）收进 `apply` 建的 `run`（`lib/index.js:189`）；`state.js · runtimeBySession` **无法搬迁**（写者是导出的自由函数），已在文件头写明单挂载假设 |
| 后端 · `createQuietly` 只挡同步抛错 | 已修 | 0.9.3 | thenable 判 `create-failed` 并补 `.catch(() => {})`，不留无人处理的 rejection |
| 后端 · `childId: null` 却让客户端去切 | 已修 | 0.9.3 | `rotationOpenChild`：`childId === null` ⇒ `openChild` 强制 `false` |
| 后端 · 无 teardown 守卫 | 已修 | 0.9.4 | `lib/index.js:403 armTeardownGuard(ctx, run)`（`:328` 挂载）：`active = false` + `run.liveChildren` 逐个 kill；优先 `ctx.effect`、退 `ctx.on('dispose')` |
| 后端 · 超时只 SIGTERM、管道不销毁 | 已修 | 0.9.4 | `lib/handoff.js:460 KILL_GRACE_MS = 3000`、`:516 killChild`、`:528 destroyPipes`（SIGTERM → 销毁 stdio 管道 → 宽限期满 SIGKILL；graceTimer `unref`） |
| 后端 · `listLanes` 失败没 stderr | 已修 | 0.9.3 | `listLanes` 补 `captureStderr: true` |
| 后端 · 每进程上限漏计车道读取 | 已修 | 0.9.4 | `lib/index.js:380 handoffProcessCount(run) = handoffSpawns + laneReads`，`:832` 计入；撞上限落聚合 `LIMIT_REACHED` + warn，不再静默 break |
| 后端 · 运行表按插入序淘汰会解除 `armed` 守卫 | 已修 | 0.9.4 | `lib/state.js:1103 touchRuntime`（先 delete 再 set = LRU touch，只在折叠路径 touch） |
| 前端 · 活动流全量渲染 + 反转列表用 index 作 key | 已修 | 0.9.4 | `lib/state.js:115 activityLimit: 24` / `:117 activityBytes: 8192`；客户端只渲染最近 N 条 + 「更早的 N 条已省略」；条目 key 取元素在**原数组**里的下标（`lib/client.js:1508 offset + index`） |
| 前端 · 状态条 2 Hz 整行重绘 + 面板耗时冻结 | 已修 | 0.9.4 | 整秒对齐的递归 `setTimeout`（`lib/client.js:1021` / `:1023`，节拍 `CLOCK_TICK_MS`），只在「展开 + busy」时挂；脉动周期 4000 ms = 4 节拍 |
| 前端 · 12 个分区零 memo | 已修（换机制） | 0.9.4 | 模块级 `memoSection(name, deps, build)` 缓存 10 个分区（`lib/client.js` 内 11 处调用）；**未用 `React.memo`/`React.useMemo`**，原因见下 |
| 前端 · 两处唯一交互入口无键盘/ARIA | 已修 | 0.9.4 | `role=button` / `tabIndex` / `aria-expanded` / `onKeyDown`（Enter 与 Space）；分区 `role=heading` + `aria-level=3`；pill `aria-live="polite"`；面板 `maxHeight:60vh` + `overflowY:auto`；值行补 `title` |
| 前端 · 三处 i18n 缺口 + 硬编码全角冒号 | 已修 | 0.9.4 | 新增 `error.versionMismatch`（`{host}`/`{client}`）、`error.missingProjectionAge`、`labelSeparator`（读 `label.colon`） |
| 工程化 · README 轮换/交接小节与代码矛盾 | 已修 | 0.9.4 | 两份 README 配置表首列与 `DEFAULT_CONFIG` 逐一对齐（46 键，missing / 多余皆空） |
| 工程化 · UI 测试全用手写快照 | 已修 | 0.9.4 | `test/ui-contract.test.mjs` 导入**真实** `toView`（`test/ui-contract.test.mjs:145`、`:150`），12 条全绿 |
| 工程化 · `docs/design.md` 停在 0.6.5 | 已修 | 0.9.4 | `docs/design.md` §15「0.7–0.9 的演进」 |
| 工程化 ·「三处同值」纪律无机检 | 已修 | 0.9.4 | `tools/audit-gate.mjs`（44 条）+ `tools/verify-install.mjs`（镜像纪律 40 个标量键、wire 36 键、`lib/` 清单） |

### 已知偏差与未验证（0.9.4 现状，未被上面任何一条覆盖）

- **「折叠时不订阅投影」仍未做到**：`useProjection` 在 `lib/client.js` 里仍是无条件调用（4 处）。
  触发这个偏差的约束与 `React.memo` 同源 —— `test/halves.test.mjs` 的 React 替身只实现
  `createElement/useState/useRef/useEffect` 且按元素树断言，`useMemo`/`React.memo` 会直接抛错、
  插子组件会破坏 `children` 断言。这是**为了不动别人的冻结测试而接受的偏差**，不是遗漏。
- **闸门是源码文本断言工具，不是行为测试**：44 条里绝大多数是对 `lib/` 源码的「必须出现 / 必须消失」正则匹配。
  其中 H4（活动流 key）、M1（秒级心跳）、M4（分区缓存）三条在 01:02 的快照里曾报红，原因是**断言口径**与
  兄弟重构后的实现不一致（实现 00:44 已改完），修的是断言本身 —— 所以这三条转绿的证据是
  `test/rotation-client.test.mjs` / `test/ui-contract.test.mjs` 的行为断言，**不是闸门**。
  （闸门文本锚点：`tools/audit-gate.mjs:47`、`:48`、`:52`、`:54`。）
- **导出链路全程用假 `spawn` / 假 bili 驱动**：本轮没有起过真 DSH 宿主、没有跑过真 `bili export`，
  「生产会错」仍是「代码路径零执行 + 两次同类事故」的推断；真浏览器 / DOM 行为（焦点环、屏幕阅读器播报、
  滚动条）只做到元素树层面的结构断言。
- **S3 复用扫描**：`sessions.list()` 只能看见**存活**会话，旧进程建的子会话查不到（已在代码注释写明）；
  每轮换一次 O(会话数)，未压测大 session 数场景。
- **`state.js · runtimeBySession` 仍是模块级单例**：单挂载假设写在文件头，多实例挂载未验证。
- **实测口径**：以上所有数字取自本报告更新时的现场实跑（0.9.4 工作树，未打包副本另由
  `tools/verify-install.mjs` 覆盖）；`D:\project` 仓根**没有 dsh-turbo 的提交历史**（该目录未被 git 跟踪），
  所以没有任何 commit 可作为证据指针。
