## 软件架构师
已完成只读审计（仅 grep/read；未修改 `D:\project\dsh-turbo` 任何文件，未写任何新文件）。

先给结论：**两条被点名的纪律目前都成立，但让它们成立的机制是"人工+局部"的**——`cordis.patch.yml` 44 键与 `DEFAULT_CONFIG` 我逐字节核过（双向零差异、5 个数组逐项相等），`TURBO_STATE_VERSION=10 = EXPECTED_V=10`、wire 36 键、`lib/state.js` 全文零 `Date.now()` 也都成立。问题不在"现在错了"，而在**下一次改动会静默错掉**：真正吃紧的是把"日志不可重建的账"塞进了投影 state，以及配置/契约常量散成 5 份副本而没有漂移闸。

---

## P0：会把行为改错的架构问题

### 1. 投影 state 里混入了"日志不可重建"的账 ⇒ 缓存行 ≠ 重折结果（严重度最高）
`lib/state.js:393`（`runtimeBySession`）、`lib/state.js:1428`（`syncLedger`）、`lib/state.js:1448`（`rehydrateRuntime`）、`lib/index.js:147`/`:170`、`lib/rotation-host.js:126`
- **机制**（按已读代码的链条）：`state.ledger = {payloadBytes, headerBytes, payloadSeq, laneWatermarks, handoff, rotation}`（`state.js:1357`）只活在投影 state 里；宿主 `restoreFloor` 在行的 `ver` 不匹配时把 floor 归 **0**，于是 state 从 `initState` 重折 —— 新 state 的 ledger 是空的，`rehydrateRuntime` 无账可种，`laneWatermarks`/`handoff`/`rotation` 三条**永久丢失**（只有 `payloadBytes`/`payloadSeq` 随重折自愈）。
- **影响**：每次改 wire 形状（v8/v9/v10 各一次）都作废全部缓存行 ⇒ **正在跑且仍在阈值之上的会话会再轮换一次**（"每个会话最多做一次"的守卫 `record.childId` 读的正是这张易失表），交接文档水位归零 ⇒ 重复导出。`isFreshEvent` 只能挡住"重放旧事件"，挡不住"活会话的下一条新事件"。
- **建议**：把账从"视图投影"里搬出来 —— 再注册**第二个投影 key**（如 `turbo-ledger`，`stateVersion` 保持稳定，只有形状变更才动），视图 key 随便升版；或让账本身可从日志派生（`at` 之外的字段都能从事件算）。顺带把这条不变量写进 `state.js` 文件头：*同一份日志两次折叠必须得到同一份 state*。

### 2. `stateSchema` 直通 ⇒ 宿主唯一的状态校验点空转
`lib/index.js:96-99`（passthroughSchema）、`:141`（`stateVersion`）、`:173`（`viewSchema`）
- **取证**：宿主在还原缓存行时调 `def.stateSchema.parse(row.val)` 之后才把它当视图用（`D:\deepseek-harness\packages\session\session-projection\src\index.ts:380-389`）；而这份 schema 的 `parse` 是恒等函数。
- **影响**：`stateVersion` 因此**只**承担"缓存失效"职责，形状合法性零校验。state 里加字段却忘了升版 ⇒ 旧形状 state 被原样恢复并继续折叠；插件自己的闸只钉了 **视图顶层键集**（`test/state.test.mjs:258-267`），钉不到 state。
- **建议**：写一个窄 `parse`（零依赖，只校验 ledger 的数值字段与 `status` 枚举，脏值抛错），或在文件头把"state 形状变更 = 必须升 stateVersion"写成硬纪律并加一条源码级闸（同 `test/halves.test.mjs:55-58` 的写法）。注：`viewSchema.parse` 是否被宿主调用我**未取证**，只证了 `stateSchema.parse`。

---

## P1：结构性代价（现在不出事，是因为只挂载一次、只装一个人）

### 3. 投影折叠热路径上有同步文件 I/O
`lib/index.js:239-257`（`readHandoffEntries`/`ensureHandoffDir`：`readdirSync`/`mkdirSync`/`writeFileSync`）、调用点 `:497`/`:501`；`apply` 每事件都进 `noteHandoff`/`noteRotation`（`:157`/`:164`）
- **影响**：`apply` 是每个会话每条事件的必经路径；阈值闸只降低了频率，没改变"事件循环里做阻塞 IO"的性质（`.gitignore` 每次触发都重写）。
- **建议**：`.gitignore` 移到挂载时写一次；目录/清单读取改 `node:fs/promises` 或在挂载期缓存。这也是 roadmap 第 1 条（B2 后台化）真正该解决的部分 —— **先修同步 IO，再考虑引后台任务插件**；spawn 本身有 `onSettle` 回调，不阻塞折叠。

### 4. 配置有两条解析路径 + 一份隐藏键 + 4 组默认值副本
`lib/index.js:127`（`{...DEFAULT_CONFIG, ...config}` → effective）vs `lib/index.js:209`（`registerGears(ctx, readGearConfig(config))` **传原始 config**）；`lib/gears.js:16-31`（10 个工具名 + `'low'` + `2` + `STEP_WINDOW=8` 四个副本）、`:143`（`src.readOnlyTools` —— **不在 `DEFAULT_CONFIG`、不在 cordis.patch.yml、不在 roadmap** 的只读键）；`lib/handoff.js:442`（`DEFAULT_EXPORT_TIMEOUT_MS=120000`，不可配）；`lib/client.js:731`（`90000`）、`:1060`/`:1083`（`slice(0,5)` = `TOP_TOOLS_LIMIT`）
- **影响**：gears 之所以要自带 `'low'`/`2`，正是因为拿到的是未合并的 config；将来 `ctx.settings` 注入第三来源时，**降档会静默失效**（它读不到 settings 的值）。客户端那两个数字（`90000`、`5`）是唯一"零漂移闸"的副本（`notes.js` 那一组有 `test/state.test.mjs:790-796` 专门盯）。
- **建议**：`apply` 里只做一次 `resolveConfig(raw)`，此后处处传 `effective`（含 `:209`）；删掉 gears/handoff 的默认值副本；`readOnlyTools` 要么进 `DEFAULT_CONFIG`+yml，要么删掉；客户端兜底数字收进一个带版本注释的 `FALLBACKS` 并纳入现有源码级漂移闸。

### 5. 模块级单例让两个半片不可重入、不可多实例
`lib/index.js:117`（`ctx0`）、`:123`（`effective0`）、`:236`（`handoffSpawns`）、`:302`（`lastRotationArmedAt`）、`:651`/`:742`（`warned*`）、`:892`（`stuckRuns`）、`lib/state.js:393`（`runtimeBySession`）
- **影响**：第二次 `apply(ctx, config)` 会覆盖 `ctx0`/`effective0`，两个挂载共享同一张运行时表与 stuck 计数。`cordis.patch.yml` 头注释自己就在警告"同时列进 `dsh.profile.bundles` 会加载两次"——而宿主只能拦住"同 key 不同 stateVersion"这一种（`session-projection/src/index.ts:249-250`），同版本双挂载是静默的。测试里也**无法**并行跑两个实例。
- **建议**：把每个 `apply` 的状态收进闭包（hook 监听器已经能闭包 `ctx`），`state.js` 的运行时表改成 `createRuntime()` 工厂 + 显式传表（这是本次最大的一次结构性改动，但它同时消掉 6/7 两个问题的一半）。

### 6. `lib/index.js` 的自述职责与实现不符
自述 `:49-50`/`:53-54`「只做接线与顺序，不自己实现任何一条判据」，实际住了 5 处行为：`accountEventPayload`(`:274-293` 字节口径)、`noteStuckRun`(`:895-908` D 的重复判据 + 128 上限)、`sessionIdOf`(`:652-675`) 与 `hookSessionIdOf`(`:743-769`) **两套近重复的 id 解析**、`lastRotationArmedAt`/`handoffSpawns`(跨会话节流状态)、`stampOf`/`profileDirOf`/`ensureHandoffDir`/`readHandoffEntries`/`stderrTail`(IO helpers)
- **影响**：964 行里混着 4 个特性的宿主侧策略，"纯判据模块可单测、index.js 只接线"这条边界是假的；`:922-923` 自认 `stuckRounds` 无消费者，就是这个错位的结果。
- **建议**：拆 `lib/session-bytes.js`（体量账）、`lib/stuck.js`（D 的宿主侧，注入计数器表 + 时钟）、`lib/session-id.js`、`lib/handoff-io.js`；`index.js` 只留 `apply` + 一个监听器。

### 7. `lib/state.js` 一文件四职责，且两个特性交错、淘汰策略不是 LRU
`lib/state.js:43-242`（配置默认值）、`:839-1050`（折叠核心）、`:1586-1662`（wire 视图 + 版本史）、`:393-1470`（进程级可变运行时表，约占全文 1/3）；**孤儿 JSDoc 实证交错**：`:1161-1166` 那段 JSDoc 逐字是 `handoffStateOf` 的（返回类型都对得上），下面紧跟的却是另一个特性的 `ROTATION_STATUSES` JSDoc `:1167-1171` + 常量 `:1172`，真身 `handoffStateOf`(`:1230-1235`) 反而**完全没有 JSDoc**；淘汰在 `:1057-1060` 按**插入序**踢最旧，而 `clearSessionRuntime`(`:1341`) **宿主半从不调用**（grep 证实只用测试）
- **影响**：活跃最久的会话恰恰是"最早插入"的那条 ⇒ 超过 200 会话时被踢掉的是最可能正在被看的那条（wire 上 `hookFaults`/`lastSpill`/`handoff`/`rotation` 当场消失，并叠加问题 1 的重复轮换风险）；"纯函数核心"旁边住着一张全局可变表，`Date.now` 禁令因此只能靠人守。
- **建议**：`state.js`（纯折叠 + 视图 + 默认值）与 `runtime.js`（表 + 淘汰 + 账镜像）拆开；淘汰改按"最后访问"并显式豁免当前会话；`clearSessionRuntime` 要么给宿主用（会话结束/归档时清），要么降为测试专用命名（`__clearRuntimeForTest`）。

### 8. wire 契约没有单一产物：只钉了顶层键，嵌套字段与客户端副本无闸
`lib/client.js:672-673`（唯一版本闸，且 `snapshot.v === undefined` 时**放行**）；闸的位置 `test/halves.test.mjs:55-58`（**比源码常量**）、`test/state.test.mjs:258-267`（顶层 36 键 `deepEqual`）、`test/rotation.test.mjs:417`/`:533`；客户端兜底 `lib/client.js:600`/`:620`/`:698`/`:1118`/`:1219`/`:1249`/`:1366`/`:1440`
- **影响**：v10 就是在 `rotation` **键内**加了 `childId`/`seedOk`/`message`（历史注释 `state.js:1586-1601` 自己写着"键数仍 34/36"）—— 顶层键集闸**结构上看不见**这类变更，只能靠客户端的逐字段 `typeof` 兜底。加上客户端半是 factory/注入 `require` 形态、无法 import 宿主半的常量，`90000`、`5` 就只能手抄。
- **建议**：顶层键集 + 每个对象的字段集都钉（`deepEqual(Object.keys(view.rotation), [...])` 并注明对应版本）；`v` 严格等值（宿主恒写 `v`，`undefined` 放行没有存在理由）；把 wire 常量抽成一份 JSON/模块，由打包步骤注入客户端半，测试改比对这份产物（沿用 `halves.test.mjs` 的源码级写法即可）。

### 9. 状态纯性：零 `Date.now()` 是"文字纪律"，而 `at` 会进 wire ⇒ `toView` 不是纯函数
`lib/state.js:6`/`:790`（禁令注释，全文零调用，已 grep 证实）；缺口 `lib/spill.js:151`（`spillFault(error, at = Date.now())` **默认参数自带挂钟**）、`lib/notes.js:560`（同类回落）；`at` 落 wire：`lib/index.js:788`（hookFaults）、`:852`（lastSpill）、`:468`/`:477`/`:490`/`:516`/`:548`/`:562`（handoff）、`:366`/`:393`（rotation）
- **影响**：同一份日志折叠两次会得到**不同**的 `at`（重折后面板的"几分钟前"整体跳变），这既是纯性缺口，也是问题 1 的同一个根因（非日志派生数据进了 state）。
- **建议**：(a) 删掉 `spill.js:151`/`notes.js:560` 的默认挂钟，`at` 一律由钩子层显式传入；(b) 账里不再持久化 `at`（冷却用的是进程级 `lastRotationArmedAt`，本来就不需要持久 `at`），wire 上的 `at` 允许重启后为空、由客户端退到"最后一条事件时间"；(c) 加一条源码级闸（`test/` 里已有 3 处读源码的先例）：`lib/state.js` 出现 `Date.now` 即失败。

### 10. 轮换的阈值住在交接导出的键名下
`lib/rotation.js:20`（从 `./handoff.js` import `effectiveThreshold`/`effectiveByteThreshold`）、`:97-98`（`shouldRotate` 用 `handoffExportTokens`/`handoffExportBytes`/`handoffExportWindowPercent` 判轮换）；`lib/handoff.js:53`/`:76`
- **影响**：想把导出文档调大的人，顺手改变了**会话何时被轮换**；`handoffExport:false` 也拦不住轮换阈值生效。命名与语义不符，是配置分层的实质缺陷，不是文档问题。
- **建议**：给轮换自己的键（`rotationTokens`/`rotationBytes`/`rotationWindowPercent`，默认值从现有 handoff 值抄一次），`handoff.js` 只留导出语义；两处共用同一段阈值数学（`min(x, ceil(window*percent/100))`）而不是同一组键。

---

## P2：公共面与取证死角

| # | 位置 | 影响 | 建议 |
|---|---|---|---|
| 11 | `lib/state.js:1218`（`rotationOf` 导出，只被 `:1660` 与测试用）、`:1341`（`clearSessionRuntime` 宿主不用）、`:1251`（`handoffOf` 私有） | 导出面与真实消费面（`index.js` 只用 `payloadBytesOf`:338/:451、`laneWatermarkOf`:455/:532、`pushEnhancement`:816）未收敛 | 要么给宿主用，要么收进测试专用命名；`rotationOf` 与 `handoffOf` 对称化 |
| 12 | `lib/rotation-host.js:78`（手写 `isAbsolutePath`：`/`、`\`、`^[A-Za-z]:[\\/]`） | `\foo` 在 POSIX 上被当成绝对路径（`node:path.isAbsolute` 返 false）；"零依赖不 import node:path"的理由不成立（`handoff.js` 已 import） | 直接用 `node:path.isAbsolute` |
| 13 | `lib/handoff.js:357`/`:340`（`resolveBili` + `profileRootOf` **向上 dirname 4 层**）、`:410`（正则解析 bili **人类可读** stdout）、`lib/index.js:219`（`createRequire`） | 部署布局知识（数目录层数）与不稳定文本接口都焊进了插件 | 配置键 `handoffExportBiliBin` 作为唯一正道，探测降级为便利；解析改等机器可读模式，或先不调用 |
| 14 | `test/state.test.mjs:195`（注释仍写 `TURBO_STATE_VERSION = 7`）、`docs/acceptance.md:197`（M1 行仍写 `=== 2`、"v2 恰好 28 键"）、`docs/design.md:135-160` §2.7（以 v2/28 键为正题，`:159` 才补一句"已过期"）、`:770`/`:886`/`:1052`/`:1132` | 版本史有了**两个家**（权威注释在 `state.js:1586-1601`），验收表里的数字是错的 | 版本史只留 `state.js:1586-1601` 一处，design.md 改成指针 + 当前 36 键表，验收表数字改正 |

---

## `docs/roadmap.md` 9 条取舍

| 条 | 判断 | 理由（含证据） |
|---|---|---|
| 1 B2 后台化 | **改小做**：先消灭折叠里的同步 IO | `index.js:239-257` → `:497`/`:501` 的 `readdirSync`/`mkdirSync`/`writeFileSync`；spawn 本身不阻塞折叠（`onSettle` 回调）。引后台任务插件解决的是"长任务不占面板"，不是这里的真问题 |
| 2 `ctx.settings` + 自写 keyed 卡片 | **该上，而且是本次最划算的一条** | 宿主 API 与 roadmap 描述一致：`register(ns, schema, {base, applies})` → `get/watch/update/replace`，解析序 **schema 默认值 → base → 用户层**，namespace 必须 kebab-case，重复注册响亮抛错，写入是 revision CAS（`packages/settings/settings/src/index.ts:104-128/:437/:23-28/:178`）。**关键收获：卡片是必需的**——设置页按「Host 服务的 namespace ∩ 注册进 `settings.plugin.item` 的卡片」派发，*a served namespace no card claims renders nothing*（`ui-settings-plugins/src/client/tab-store.ts:1-11`），没有自动表单（与你的猜测相反）。收益：`base: DEFAULT_CONFIG` 让"yml 逐字镜像"这套手工纪律**整条退休**（44 键镜像可以缩成 `{}`），配置只有一个来源、有类型、有校验。代价与注意：(a) schema 需要 schemastery（零依赖是自设规矩；它是 peer，不是构建负担）；(b) 数字键要 live（`applies`），用 `watch` 灌进 `effective0`，否则改了不生效——而 `toView(state, effective)` 读活值意味着**配置变更会改 wire 但 state 不变**，面板要等下一次事件；客户端已有 500/1000ms 重渲染定时器（`client.js:838`），够用但要知道这件事；(c) roadmap 的不变量要改口径：**配置对象不进 wire，但配置派生的显示阈值现在就在 wire 上**（`noProgressMs` `state.js:1604`、`slowMs` `:1606`、`mountStatus` `:1630`）；(d) 隐藏 11 个数字键、`redactKeys` 不可编辑 —— 同意，但要保证 yml 仍能设（否则是"不可配"而非"藏起来"） |
| 3 交接正文喂新会话 | **值得做，但选"低成本版"** | `rotationSeedMessage` 已支持 `{old}`/`{cwd}` 占位（`rotation.js:145` split/join），加 `{doc}` 把文档绝对路径与"先读它"写进种子是一行改动；真把正文塞进种子则让新会话第一步就贵。注意种子消息是手写 `UserMessage`（`rotation-host.js:62`），加附件类型要回到"零依赖能否构造合法消息"这个问题 |
| 4 早于 bili 的熔断预警 | **缓做，除非阈值来自宿主** | 7.5 bytes/token 已硬编码一份（`handoff.js:65`），再写一份就是第三个副本；宿主 compaction 的真实阈值插件读不到，硬猜会漂移。要么暴露成配置键并注明"与宿主无关"，要么等宿主给常量 |
| 5 补完 D / 删 `stuckRounds` | **删键，别补** | `index.js:922-923` 的理由是硬的：post-execute 看不到 turn 窗口，自造第二套判据违反"看不见就是不判"。D 的宿主侧判据（`noteStuckRun:895-908`）本就该按问题 6 抽成 `stuck.js`，届时顺手删键（1.0 前允许） |
| 6 子会话体量进父判据 | **该做，且和 10 一起做** | 现场 `usage 77% / blocks 0` 说明"体量账按车道记、判据按会话判"。不要去加第二本账，改成 `payloadBytesOf(sessionId)` 对同会话车道做**聚合**（车道键 `<id>\|sub:xxx` 已在 `handoff.js:410`/`:433` 解析）；这样导出与轮换阈值同时看见子车道。把 77%/0 那个现场做成测试 |
| 7 按工具超时守卫 | **从本插件移除** | 它与 DSH 自带的 `packages/guard/timeout-policy` 职责重叠，且属于"新能力"而非状态条；要做应独立成插件 |
| 8 上架 | **先修 P0/P1 再上** | 客户端半依的是 DSH 内部 slot 契约（`client.js:21-50` 逐字引 `dsh-client-ui-slots`/`ui-renderer` 行号），公开即等于承诺一个 DSH 版本区间；它的降级姿态（`v` 闸 + 逐字段兜底 + `ctx.slots` 缺失只 `console.error`）是对的，但"profile 只挂载一次""最多 200 会话"这类隐含前提在公开后不再成立，正对应问题 5/7 |
| 9 文档债 | **接受，但先修两个会被人当真的数字** | `docs/acceptance.md:197`（`=== 2`/28 键）与 `docs/design.md:135-160`（§2.7 以 v2 为正题）是读者最可能信任的两处；权威版本史应唯一留在 `state.js:1586-1601` |

---

## 本次未取证 / 需你或后续验证的点

1. **问题 1 的重复轮换链条是我从代码推的**，没有跑起来复现；验证方式很小：把 `TURBO_STATE_VERSION` 临时 +1 起一次宿主，观察一个已轮换过的活会话是否再建空白会话（或直接写一个"缓存行作废后重折"的单测）。
2. `viewSchema.parse` 是否被宿主调用未取证（只证了 `stateSchema.parse`，`session-projection/src/index.ts:380-389`）。
3. `lib/client.js`（83 KB）我只做了结构化抽查（版本闸、兜底数字、slot 注册、时钟分布），渲染层的 36 键消费细节没有逐行审。
4. `docs/design.md`（79 KB）走的 grep 抽查，可能还有别的过期数字。

## 后端架构师
# dsh-turbo 宿主半 · 只读审计清单

审计对象：`D:\project\dsh-turbo\lib\{index.js, rotation-host.js, handoff.js, state.js, rotation.js}`（未改动任何文件）。按严重度排序。

| # | 严重度 | 一句话 | 位置 |
|---|---|---|---|
| S1 | 高 | `unavailable` 被写进水位账并再水化 ⇒ 每会话**永久**不再导出，与注释「本进程内不再试」相反 | index.js:424 / 448，state.js:1385 / 1470 |
| S2 | 高 | `running` 被持久化 ⇒ 导出中途进程被杀 → 该会话永久卡在 running | index.js:562，state.js:1357-1385 / 1448+ |
| S3 | 高 | 「每会话一次」只靠 ledger；ledger 丢失（stateVersion 变更/清缓存）即可重复轮换、重复导出 | state.js:349 / 1448，index.js:335 / 455 |
| S4 | 中高 | `createQuietly` 把任何对象当成 Session：`create` 若返回 Promise ⇒ 无 await/catch，rejected promise 变 unhandledRejection | rotation-host.js:192-195 / 211 |
| S5 | 中 | 异步 onSettle 的终态**进不了** ledger，而临态进得去 —— 持久化的恰好是错的那一半 | index.js:514-524 / 568-573 / 170 |
| S6 | 中 | 无 teardown 守卫：dispose/HMR 后仍会起新进程、操作已死上下文 | index.js:506 / 563 |
| S7 | 低中 | 超时只 `kill()`（SIGTERM）、不 destroy 管道、不 unref；settle 后仍累积捕获 | handoff.js:514 / 525-534 / 461-474 |
| S8 | 低中 | index.js:407 是死分支，日志还谎称「已记 fault」；create 失败时面板拿到 `openChild:true, childId:null` | index.js:370-391 / 407-410 |
| S9 | 低 | `listLanes` 不捕获 stderr，却打印 stderr 尾巴（永远为空） | handoff.js:561-570 vs index.js:570 |
| S10 | 低 | 每进程上限只数 `runExport`，不数车道列表进程；被 break 跳过的车道无任何记录 | index.js:465 / 505 / 530 |
| S11 | 低 | 运行表插入序淘汰（非 LRU）⇒ 热会话被淘汰后 `armed` 守卫消失，可二次轮换 | state.js:393-396 / 1054 |
| D1 | 低中 | 文件头「两处副作用都默认关」是假的：`handoffExport: true`、`rotation: 'auto'`，且轮换根本没被列为副作用 | index.js:8-9 vs state.js:125 / 212 |

---

## S1（高）持久化的 `unavailable` = 每会话永久停摆

**位置**：`state.js:1385`（`ledgerOf` 把 `entry.handoff` 原样入账）、`state.js:1470`（`rehydrateRuntime` 原样还原）、`index.js:447-448`（`RUNNING || UNAVAILABLE` 直接 return）、`index.js:477 / 490`（写 `unavailable`）。

**机制**：0.9.2 之前运行表是进程内的，所以 `unavailable` 随进程消失而失效 —— `index.js:424` 的注释就是这么写的：「`unavailable`（探测不到 bili，**本进程内**不再试）」。0.9.2 把 handoff 记录整条塞进 ledger 并再水化后，这条语义变成**永久**：任何一次 `unavailable`（探测不到 bili / 当时拿不到绝对路径 `cwd`）都会跟着 `session_projcache/sessions/session-<id>.json` 一起落盘，之后哪怕 bili 装好了、`handoffExportBiliBin` 配上了、cwd 回来了，`index.js:448` 一律 return —— 不看配置、不看时间、不看磁盘、不看进程代次。`handoff.running` 同理（见 S2）。

**复现**：① 在不装 bili（或未配 `handoffExportBiliBin`）的机器上正常跑一个会话越过阈值（默认 240K token / 1.8 MB）→ 落 `unavailable`；② 装上 bili（或改配置）；③ 重启 DSH → ledger 还原 `unavailable`；④ 该会话此后再也不导出，面板永远显示 unavailable，且**没有任何日志**。

**建议**：ledger 只承载**水位/计数**（`payloadBytes` / `headerBytes` / `payloadSeq` / `laneWatermarks`），把 `handoff.status` 从持久化里剥出来；若确实要带状态，则只允许终态（`done` / `failed`）过闸，并在再水化时把 `running` / `unavailable` 一律降级为 `idle`（`running` 最多映射成 `failed + message:'interrupted'`）。另外给记录加 `statusAt`，再水化时按 `Date.now() - at > handoffExportFreshMs` 判定过期。

## S2（高）`running` 落盘 ⇒ 进程被杀即永久卡死

**位置**：`index.js:562` 推 `RUNNING`，`state.js:1357-1385` 入账，`index.js:448` 阻断。

**机制**：`RUNNING` 的设计语义是「正在跑/正在读车道列表」（index.js:424），进程内一定被 resolved —— `runBili` 的 settle 是四路完备的（`timer` / `close` / `error` / 同步 throw，handoff.js:518-543），我逐路核对过 `settle` 幂等且有 `clearTimeout`。它唯一不能自愈的情形就是**进程在 120 s 窗口内死掉**（Ctrl-C、宿主重启、崩溃）——而这恰恰是最常见的人为动作。重启后 ledger 把 `running` 还原，`index.js:448` 永久阻断该会话的所有导出，面板显示一个假的「进行中」。

**复现**：`handoffExportSubLanes: true` + 一次导出进行中（`bili export --full` 期间最容易，默认超时 120 s）按 Ctrl-C → 重启 → 该会话 handoff 永远停在 running。

**建议**：同 S1（`running` 属进程内临态，绝不跨进程还原）。这是 0.9.2 引入的**回归**，不是既有权衡。

## S3（高）「每会话一次」全部押在 ledger 上，ledger 一丢就重做副作用

**位置**：`state.js:349`（`initState` 的 `ledger: null`）、`state.js:1448-1451`（`if (runtimeBySession.has(sessionId)) return`）、`index.js:335`（`armed` 守卫）、`index.js:455-463 / 546`（车道水位闸）。

**机制**：两道「只做一次」的守卫都只存在于**内存表 + 持久化账**里，没有任何一个从日志/宿主存储反推的权威证据：`sessions.create` 之前不查会话库（不查 `meta.parentSession === sessionId` 的既有子会话）。只要 ledger 不在（`stateVersion` 变更导致宿主丢弃旧投影 state 并整份重放 → `initState` 给 `ledger: null` → 再水化 no-op；或手工清 `session_projcache`），且该会话**此刻是活的**（最新事件在 `rotationFreshMs`/`handoffExportFreshMs` = 300 s 内），`shouldRotate`（rotation.js:93-104，默认 240K token 或 25% 窗口口径）就能再次通过 → **同一个父会话被轮换第二次**，宿主侧无任何去重。handoff 侧因磁盘上已有 `handoff-<lane>-*.md`（`findAnyHandoff`）而大多能挡住，但反向也有问题：车道水位丢失后 delta 闸当成「从未导出」，会多导一份。

**复现**：会话 A 越过阈值 → `armed` + childId 落账 → 提高 `TURBO_STATE_VERSION`（该插件历史上从 v9 提到 v10 是常规操作）→ 重启并立刻在该会话里继续对话 → 若 `sessions` 服务里没有「已有子会话」的检查，就会再建一个空白会话并写种子消息。

**建议**：把「已轮换」做成**日志/存储派生**的事实而非账本事实：建子会话前先查宿主（`meta.parentSession === sessionId` 已存在 → 直接落 `armed` 并复用那个 childId）；或把标记写进会话 header 元数据。同理，`laneWatermarks` 若能从日志重算（`payloadBytes` 本来就能），就不要只信 ledger。

## S4（中高）`createQuietly` 只挡同步抛错，挡不住 Promise / 非 Session 返回值

**位置**：`rotation-host.js:190-196`、`rotation-host.js:210-222`。

```js
const session = sessions.create(childId, { meta: childMeta({ cwd, sessionId }) })   // :192 无 await
return { ok: true, session: session !== null && typeof session === 'object' ? session : null }  // :193 Promise 也满足
...
if (session === null || typeof session.append !== 'function') return { ok: false, bytes: 0 }    // :211
```

**机制**：`typeof Promise === 'object'`，所以一个**异步**的 `create` 会被判成「建好了」：状态推 `armed`（连带把该会话的轮换守卫永久锁死）、childId 是一个可能永不存在的会话；随后 `session.append` 不存在 → `seedOk:false`。更严重的是**被丢掉的 promise 无人 catch**：若 `create` reject，宿主里就是一次 `unhandledRejection`（`try/catch` 只覆盖同步 throw）。`settle` 的完备性在 handoff 侧做得很好，这里同等重要的路径却只有同步保险。

**复现**：依赖 DSH 侧 `sessions.create` 的同步性。**本次审计无法证实这一点**（见「未能验证」），所以按条件性缺陷报：即使当前是同步的，`typeof session === 'object'` 这层校验也拦不住将来变成 async。

**建议**（一行成本）：`if (session === null || typeof session.then === 'function' || typeof session.append !== 'function')` → 判失败；并对疑似 thenable 补 `.catch(() => {})`，保证任何情况下都不会产生未处理拒绝。

## S5（中）异步终态进不了账，持久化的恰好是错的那一半

**位置**：`index.js:514-524`（onSettle 推 `DONE`/`FAILED`）、`index.js:568-573`、`syncLedger` 只在 `index.js:170`（折叠末尾）被调用。

**机制**：`syncLedger` 只随 `apply` 走。导出是在几秒后才 settle 的，那时没有任何折叠发生 ⇒ `DONE` 永远写不进 ledger；而 `RUNNING`（同一路径的临态，`index.js:562`）却写进去了。结果是一个**反向的持久化策略**：真正该跨进程保留的终态丢失，真正不该保留的临态留下 —— S1/S2 的直接成因。附带效应：重启后状态与磁盘现实不一致（面板说 idle/无记录，磁盘上文档已经在）。

**建议**：二选一 —— 要么 ledger 不收状态（首选，顺带抹掉 S1/S2）；要么让异步路径也能重同步（settle 后经宿主 API 落一次投影 state），并给状态配 `at` 以便过期判定。

## S6（中）没有 teardown 守卫，dispose 后还在起进程

**位置**：`index.js:506`（`runExport(...onSettle)`）、`index.js:563-573`（`listLanes` 的 onSettle 直接调 `planAndRun`）。全文件没有 `ctx.on('dispose')` 或 `active` 标志。

**机制**：插件被卸载/HMR 重载后，投影不再折叠，但：① 在跑的 120 s 导出继续持有子进程；② 更糟的是 `listLanes` 的 settle 会**在 teardown 之后**新起一批 `bili export` 进程，并在已死的 `ctx0`（模块级）上继续 `pushHandoff`。`runBili` 把 child 交还给调用方（handoff.js:544）但没人保存，所以谁也没法在 dispose 时收尸。

**建议**：用 `ctx.effect(() => () => {...})` 注册清理：置 `active=false`（`onSettle` 首行判空返回）+ 对在册 child 逐个 `kill`。这也符合仓库「registrations are effects」的约定。

## S7（低中）句柄：只 SIGTERM、管道不销毁、不 unref

**位置**：`handoff.js:525-533`（只有 `child.kill()`）、`handoff.js:514` + `461-474`（`attachCapture` 的 data 监听在 settle 后仍写入）、`handoff.js:544`（child 无人持有）。

**机制**：若 `bili export --full` 卡住且忽略 SIGTERM，`settle` 已经报超时，但子进程的 stdio 管道仍被引用 → Node 事件循环不空，DSH 进程无法正常退出；每次 spawn 的 data 监听也不回收。捕获本身是有界的（`state.stdout` ≤ 64 KiB + 一个 chunk，`stderr` 是 2048 字符切片，:467/:473 —— 这两点做得对）。

**另**：`quoteForShell`（:454）只在 win32 的 `.cmd/.bat` 上启用（:449、:499-500），它产生 `"..."` + `\"` 转义，而 cmd.exe 不认 `\"`（cmd 用 `""` 或 `^"`）。只有当 `handoffExportBiliBin` 指向 .cmd/.bat 且路径/`--output` 路径内含 `"` 时才可能越出引号 —— 很窄，但属真缺陷。

**建议**：超时路径 `kill` 后 `destroy()` 两个管道，宽限期后升级 `SIGKILL`；不需要捕获时 `unref()`；`attachCapture` 的写入也过 `settled` 闸；`.cmd` 引号改用 cmd 口径或用 `spawnSync` 的数组形式避免手工拼接。

## S8（低中）死分支 + 误导性日志 + 面板拿到 `childId:null`

**位置**：`index.js:370-391` 与 `index.js:407-410`。

`outcome.status === IDLE`（含 `message: 'create-failed'`）在 :370-391 已被处理并 `return`；:407 只可能以 `status === ARMED` 到达，而 ARMED 的 message 只可能是 `null` 或 `seed-failed`（`rotation-host.js:166`）。所以「建会话被拒」这行**永远不会打印**，它还声称「已记 fault」——实际既没打印也没记 fault。附带：create 失败时走的是 :372-386，推的 `unavailable` 带着 `childId: null` 却保留 `openChild: plan.openChild`（默认 true，rotation.js:129），客户端会收到「切到某个不存在的会话」的指令。

**建议**：删掉死分支（或把 CREATE_FAILED 判断移到 IDLE 分支之前）；`childId === null` 时把 `openChild` 强制为 false。

## S9（低）车道列表失败没有 stderr

`handoff.js:561-570` 的 `listLanes` 只 `captureStdout: true`，而 `index.js:570` 的 warn 打印 `stderrTail(result.stderr)` —— 永远是空串。「车道列表读失败」这条最需要诊断信息的路径恰好没有信息。建议加 `captureStderr: true`。

## S10（低）每进程上限的计账边界

`index.js:505` 只给 `runExport` 计数；`index.js:563` 的 `listLanes` 进程**不计入** `handoffExportMaxPerProcess`（默认 64，state.js:162），所以 `handoffExportSubLanes: true` 时实际进程数是「64 次导出 + 若干次车道读取」。`index.js:530` 的 `break` 会静默跳过剩余车道（好处：水位没被推进，下次折叠会重试；坏处：无任何记录说明为什么没导）。建议把车道读取也计数，并在 break 时落一条聚合记录。

## S11（低）运行表按插入序淘汰（非 LRU），会意外解除 `armed` 守卫

`state.js:393` + `:396`（`MAX_RUNTIME_SESSIONS = 200`，`:1054` 淘汰最早插入的键）。淘汰会顺带丢掉 `rotation` 记录 ⇒ `index.js:335` 的 `armed` 守卫消失；此时若进程全局 `lastRotationArmedAt`（index.js:343）已超过 `rotationCooldownMs`（默认 600 s，state.js:219），同一会话**在一个进程内**可被二次轮换。另外淘汰按插入序而非访问序，热会话反而可能被淘汰（冷会话占着名额）。触发条件较重（单进程折叠过 200 个会话），列作边界项。

## D1（低中）文件头与默认值互相打脸（安全评审会看错）

`index.js:8-9` 写「0.7.0 起唯一的两处副作用都**默认关**（`config.handoffExport`）：写交接文档 + 起 `bili export` 子进程」。实际：`state.js:125` `handoffExport: true`（注释明写「装上就工作」，要关得显式 `false`）；`state.js:212` `rotation: 'auto'`（0.9.1 起默认自动）；而且**轮换（`sessions.create` + `session.append`）根本没被列进「两处副作用」**。默认配置下这个插件会自己建会话、起子进程、写文件 —— 与头部声明不符。建议改头部（或改默认值），并把第三处副作用写进去。

---

## 未能验证（不是结论，是边界）

- **`ctx.sessions.create` 是否同步、返回什么**：本会话无法读取 DSH 实现 —— `D:\software\deepseek harness\resources\app.asar\dsh\` 是打包的 asar（递归列举只有 `app.asar` 本体与一个只含 `dsh-docker` 的 `app.asar.unpacked`），`core/session/src/index.ts:830` 读不到。S4 因此按**条件性**缺陷报（`typeof session === 'object'` 这层校验不足以自证）。
- **宿主在 `stateVersion` 变更时是丢弃旧投影 state 还是迁移**：同上（asar 侧契约），S3 的两个分支（丢弃 ⇒ 整份重放、ledger 为 null；迁移 ⇒ 旧账可能缺 `rotation` 键）**都**导致守卫丢失，结论不依赖这个分支。

## 已逐项核对、确认没问题的点

- `effectiveThreshold` / `effectiveByteThreshold`（handoff.js:53-59、76-82）在 `contextWindow` 未知时回落**绝对值**而非 0 —— state.js:891-893 的担忧已被正确处理，不会退化成「每轮一次」。
- `runBili` 的 `settle` 四路完备（timer/close/error/同步 throw，handoff.js:510-543）、幂等、且清 timer；`spawn` 同步抛错也走 onSettle 后返回 null。
- `attachCapture` 的捕获有界（stdout 64 KiB、stderr 2048 字符）。
- `applyEvent`（state.js:839-840）对无关事件返回**同一引用**，且不关心的事件不会新建对象；ledger 只在 `syncLedger` 时换引用。
- `ledger` 没有泄进 wire 视图（`toView` 里没有该键，state.js:1598 起的视图注释与 1660 的 rotation 键都不含它）。
- `rotationMode`（rotation.js:38-42）对脏值回落默认；`isFreshEvent`（handoff.js:98-104）对**未来时间戳**取「宁可不做」的保守侧；rotation 的 `unavailable` **不是**终态（`index.js:335` 只挡 `armed`），与 rotation.js:25-28 的契约一致 —— 也就是说 S1/S2 的持久化陷阱在 rotation 侧不存在，只在 handoff 侧。
- `pushHookFault` / `pushSpill` / `pushEnhancement` 都不入账（state.js:1354 注释明示「进程内」），这一点是对的。

**优先级建议**：S1 + S2 + S5 是同一个根因（ledger 该收什么），一处改动（ledger 只收水位与计数，状态过期化）即可消掉三条最高危项；S4 是两行防御性修补；S3 需要一次设计取舍（把「已轮换」做成存储派生事实）。

## 前端开发者
已完成只读审计。全部结论基于 `dsh-turbo/lib/client.js`（1707 行）实读，并在宿主源码树 `D:\deepseek-harness` 交叉核对了槽位与 `sessions` 服务的真实契约。

# dsh-turbo 客户端半 `lib/client.js` 审计清单

**审计对象**：[lib/client.js](dsh-turbo/lib/client.js)（1707 行，纯 JS，无构建，两个槽位条目）
**外部核对**（只读，未改动任何文件）：
- `D:\deepseek-harness\packages\client\runtime\lib\client.js:8967` `open(id){ this.manager.select(id) }` → `:7863 select()` 同步 `throw new Error('sessions.select: unknown session ' + sessionId)`（`:7865`）
- `D:\deepseek-harness\packages\client\ui-renderer\lib\types\client\scoped-slots.js:320-321`（`sessionId` / `useProjection` 恒在）、`:340-347`（`entry.locale` 有值才挂 `kit.t`）、`:464`（每条目独立 `SlotErrorBoundary`）
- `D:\deepseek-harness\packages\client\ui-slots\lib\index.js:66`（`is not declared` throw）、`:84`（同 priority 下 id 撞车）、`:122`（list 按 order 排序）

---

## 高

**H1 · `auto` 轮换在默认界面下永不触发**
`lib/client.js:1264`（触发点）、`:1258`、`:1517`（唯一调用点）、`:1598`、`:1592`
`performRotation` 只有两个调用点（`:1264` 自动、`:1299` 点击），两个都在 `rotationSection` 里；`rotationSection` 只被 `detailBody:1517` 调用；`detailBody` 只在 `TurboDetailPanel:1599` 调用，而 `:1598` 在 `collapsed` 时已 `return null`，且 `collapsed` 初值 `!isDetailOpen(sessionId)` 默认为 `true`。**结论：用户不手动展开详情面板，`mode:'auto'` 的到量轮换一次都不会执行。** `:1260-1263` 的注释（"每次投影更新都会重绘，下一次渲染 phase 变 idle 自己就会动手"）对折叠状态不成立 —— 组件根本没渲染。字典里那句"新会话已就绪 · 正在自动切换…"（`:1279`）因此永远等不到兑现。
**建议**：把触发搬到 `TurboStatusBar` 的 `React.useEffect`（`useEffect` 在 render 返回 `null` 时照样执行），依赖 `[status, mode, idle, childId]`，保留 `rotationInFlight` 防重入。状态条条目是常驻的，这才是"投影更新驱动"的正确落点。

**H2 · 轮换结果写在模块级变量、无任何通知 → 面板卡在"正在轮换…"**
`lib/client.js:1386-1411`（4 处赋值 `rotationOutcome`）、`:1266-1267`（读取）
`performRotation` 在渲染期同步把 `rotationOutcome` 置为 `running`，所以本次渲染立刻显示"正在轮换…"（这点是对的）；但随后 `.then` 里改成 `done`/`ready`/`failed`（`:1395`、`:1404`、`:1408`）**不会触发任何重渲染**（组件是纯函数，没有订阅）。成功路径靠 `sessions.open` 切走会话掩盖了问题；`ready`/`failed` 路径只能等下一次投影更新来"自愈"。会话空闲时（恰恰是 armed→失败后的典型场景）投影可能长时间不更新，面板会一直显示"正在轮换…"——一句假话。
**建议**：结果落地处复用 `detailListeners`（或在 `TurboStatusBar` 里用 `useState` 持有本会话结果并让 effect 负责写入），保证每次状态迁移都有一次 `setState`。

**H3 · 轮换失败后彻底死锁，且文案指向一个不存在的动作**
`lib/client.js:1372`（`rotationOutcome.sessionId === sessionId` 早退）、`:1287`、`:1293`
一旦失败（例如 2.7s 重试窗口内投影仍没报出新会话 → `ready`），该 sessionId 的 `rotationOutcome` 永不清除，`performRotation` 此后**永久早退**；同时 `clickable = shown === 'armed' && mode !== 'auto'`，`ready` 状态的行不可点。于是面板写着"新会话已就绪 · 请手动切换"，却没有任何可点的入口，插件内也再无重试路径 —— 一次瞬时竞态就把这个会话的轮换能力锁死。
**建议**：`childId`/`at` 变化或 wire `status` 回到 `armed` 时清空 `rotationOutcome`；把 `ready` 行做成可点并配"重试"文案（重试本身成本极低，`sessions.open` 是同步的）。

**H4 · 活动流全量渲染 + 反转列表用 index 作 key（性能 + 正确性）**
`lib/client.js:1185-1195`、`:1177`
`activitySection` 对 `snapshot.activity` **整段** `.slice().reverse().map(...)`，没有任何条数上限、没有 `useMemo`；每行 3 个 span。宿主环缓冲若为 100–200 条，则**每一次投影更新**（流式期间按事件频率，可到每 token 一次）都要重建数百个节点。
更重的是 key：`key: activity-${index}`。列表反转后，新增一条会让**所有** index→内容映射整体位移（旧 `activity-0` 变 `activity-1`…），React 按 key 复用 DOM 后把每一行的文本都改写一遍 —— 既失去增量更新的收益，又会打断用户正在做文本选择（该行特意设了 `userSelect:'text'`，`:1170`），内容与节点错配的窗口也真实存在。
**建议**：`list.slice(-N).reverse()`（N≈20–30，面板不是审计日志）；key 用稳定标识（宿主若不给 seq/id，可用 `t + kind + name` 组合，或至少用"距末尾的偏移"而非反转头部的 index）；分区级 `useMemo`。

**H5 · 两处唯一的交互入口都是鼠标专用（无键盘、无 ARIA）**
`lib/client.js:650-655`（`clickableRow` → `<div onClick>` + `cursor:pointer`）、`:1295-1308`（轮换行 `<div onClick>`）
摘要行那一格是本插件"唯一的交互入口"（`:647` 注释自述），却既没有 `role="button"`、没有 `tabIndex`、没有 Enter/Space 处理，也没有 `aria-expanded`。键盘用户与屏幕阅读器用户完全无法展开详情面板；轮换行同理。WCAG 2.1 AA 的 2.1.1 / 4.1.2 直接不达标。
**建议**：两处补 `role="button"`、`tabIndex={0}`、`aria-expanded={isDetailOpen(sessionId)}`、`onKeyDown`（Enter/Space 都触发，Space 记得 `preventDefault` 防滚动）；不可点的轮换行保留 `cursor:'default'` 现状即可。

---

## 中

**M1 · 展开的面板里耗时是冻结的**
`lib/client.js:1476`（`const now = Date.now()` 每次渲染只取一次）、`:1480`、`:1117-1134`
面板自身没有任何定时器，只在投影更新或开合变化时渲染。长工具调用（正是用户盯着面板看的时刻）投影长时间不动，"现在 · 已 X"和"本步耗时"就定格不动，与摘要行每 500ms 跳秒的口径自相矛盾。
**建议**：面板在 `!collapsed && snapshot.busy` 时挂一个 1s 间隔（与状态条同款 effect），空闲时不留定时器。

**M2 · 会话切换后详情面板的开合态串会话**
`lib/client.js:1592-1593`
`useState(() => !isDetailOpen(sessionId))` 的初值只在挂载时求值；`:1593` 的 effect 在 `sessionId` 变化时**只重新订阅、不回同步状态**。若宿主复用组件实例（`:1585-1586` 的注释明确承认这种可能，并说已用模块级 Map 规避）：在 A 会话展开面板后切到从未展开过的 B，面板仍是展开的，而 B 的摘要行显示"▸ 详情" —— 两个入口自相矛盾，正是注释声称已避免的那个 bug。
**建议**：effect 体内先 `setCollapsed(!isDetailOpen(sessionId))` 再订阅（一行）。

**M3 · 状态条整行 2Hz 重绘，且脉动是混叠的**
`lib/client.js:836-842`、`:735`
忙碌期 `setInterval(..., 500)` 驱动整个 `TurboStatusBar` 重渲染，而这一帧要重建的包括脉动点、相位 pill、token/档位 pill、卡顿判定、前缀告警 —— **全部只为了一个 6px 圆点的透明度**和一个秒级数字。且 `Math.sin(now / 320)` 的周期约 2.01s，被 500ms 采样成 ~4 点/周期，视觉上是跳变而不是脉动（周期与采样率无公倍数关系）。长时间工具调用期间这是持续 2Hz 的常驻开销。
**建议**：把时钟驱动的部分（点 + 已耗时文本）拆成子组件，或干脆去掉 JS 脉动改用静态点；间隔提到 1000ms 并把相位与 tick 对齐。

**M4 · 每次投影更新全量重建 12 个分区，零 memo**
`lib/client.js:1474-1575`
`detailBody` 是 `snapshot` 的纯函数，但每次调用都重跑 `nowSection`/`activitySection`/`topTools`/`waitTools`/`prefix`/`rotation`/`handoff`/`enhancement` 全部构造，即使只有一个字段变了（流式期一个 token 一次）。叠加 H4 后这是 composer 区最主要的渲染成本。面板折叠时虽已 `return null`（`:1598`），但 `useProjection`（`:1591`）仍无条件订阅，更新照样触发一次空渲染。
**建议**：各分区 `React.memo` + 以子对象（`snapshot.activity` / `topTools` / `handoff` …）为 `useMemo` 依赖；折叠时不订阅投影（把 `useProjection` 下沉到展开后才挂载的子组件）。

**M5 · 最关键的诊断文案不可本地化**
`lib/client.js:673`
`投影版本错配（宿主 v${snapshot.v} ≠ 客户端 v${EXPECTED_V}）` 是裸中文字符串，没走 `text()`，DICT 里也没有对应键。英文 locale 用户撞上宿主/客户端半片版本错配（EXPECTED_V=10 的核心保护）时，看到的是中文，且无法翻译。`:669` 的括号后缀同样硬拼接。
**建议**：加 `error.versionMismatch`（带 `{host}` / `{client}` 占位）与 `error.missingProjectionAge`，两种语言各一份。

**M6 · 时间格式有两套，违反本文件自述的"同一份时间不出现两种写法"**
`lib/client.js:972-978`（`fmtClock`，自述唯一口径）vs `:1268`（rotation）、`:1446`（handoff）用的 `new Date(at).toLocaleTimeString()`
同一块面板里，前缀与钩子故障显示 `22:23:45`，轮换/交接显示运行环境的 `toLocaleTimeString()`（en-US 会给出 `10:23:45 PM`，某些 locale 还带秒/时区差异），且跟随主机 locale 而非 UI locale。
**建议**：两处改用 `fmtClock(at)`。

**M7 · 全角冒号硬编码，英文界面每个标签行都中英混排**
`lib/client.js:988`（`detailRow`，约 30 行的公共路径）、`:1553`（hookFaults）
英文 locale 下面板渲染成 `phase：idle`、`tool：bash`。
**建议**：由解析后的 locale 决定分隔符（或加 `label.colon` 键），一处改动覆盖全部行。

**M8 · 两个模块级表的驱逐策略是"整体清空"**
`lib/client.js:820-821`（`sessionSeenAt`）、`:888`（`detailOpen`）
超过 128 条时 `clear()`，会把**其他仍然健在的会话**的记账一并抹掉：正在等 8 秒宽限期的会话宽限期重新计时（`:666`），展开着的详情面板被判定为收起。虽然触发条件罕见，但代价与收益不成比例。
**建议**：Map 保持插入序，`delete(map.keys().next().value)` 逐条驱逐最旧的一条。

**M9 · 面板不可滚动、无高度上限，且截断文本没有 `title`**
`lib/client.js:912-927`（`PANEL_STYLE` 有 `overflow:'hidden'`，无 `maxHeight`/`overflowY`）、`:965-970`（`VALUE_TEXT_STYLE` 省略号）
活动流全量渲染（H4）会把面板撑得很高；推到 dock 容器溢出处之后，被 `overflow:hidden` 裁掉的内容既滚不到也点不到。所有被省略号截断的值行（路径、参数摘要）都没有 `title`，鼠标用户拿不到全文。
**建议**：正文容器加 `maxHeight` + `overflowY:'auto'`；截断 span 补 `title`。

**M10 · 排序列表同样用 index 作 key**
`lib/client.js:1067`（`tool-${index}`）、`:1107`（`wait-${index}`）
`topTools`/`waitTools` 由宿主按耗时排序，两次更新之间名次会互换，index key 会让 React 把 A 的 DOM 节点复用给 B（本次渲染文本会被改写，所以不会显示错数据，但每行都退化为全量 diff）。
**建议**：`key = ${kind}-${name}`（同名工具可用 name+count 兜底）。

---

## 低

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| L1 | `:1652-1661` | 3 秒挂载自检的定时器句柄被丢弃（`timer.timeout` / `setTimeout` 两种分支都是），成功挂载后仍会触发一次（虽被 `mounted` 早退） | 保留句柄，在 `inject` 的 disposer 里清掉 |
| L2 | `:1338-1357` | 重试链无法取消（会话切走后仍会继续 `sessions.open`，最多 10 次 / ~2.7s）。**核对结论：重试模型本身与宿主 API 吻合**——`open` 同步 `void`、同步 throw（`runtime/lib/client.js:8967`→`:7865`），不存在异步 rejection 漏判 | 加一个 abort 标志；把 `active` 判定交给调用方 |
| L3 | `:1266`、`:1372`、`:1387` | `rotationOutcome` 是单槽位，B 会话轮换会覆盖 A 的记录，A 面板丢失"已轮换 → childId" | 改成 `Map<sessionId, outcome>` 并沿用 128 条上限 |
| L4 | `:1221` | `active = source.active !== false`：`enhancement` 整个缺席时渲染"已启用"，与本文件"缺席 ≠ 正常/不许静默"的一贯口径相反 | 缺席时走 `enhancement.reason.other` 或单独一档"未知" |
| L5 | `:618-624` | 前缀告警的新鲜期用渲染期 `now` 判定，而空闲态没有定时器 → 5 分钟到点后那条告警要等下次投影更新才消失 | 复用 M1 的间隔，或接受并在注释里写明 |
| L6 | `:1060`、`:1083` | `slice(0,5)` 静默截断，没有"共 N 条"提示 | 尾部补一行 `Top 5 / N` |
| L7 | `:1002`、`:1574` | 分区标题是普通 `div`，面板根节点无 `role`/`aria-label` → 12 个分区无法按标题导航 | 标题用 `<h3>` 或 `role="heading" aria-level`，根节点加 `role="region"` + 标签 |
| L8 | `:531-543`、`:748` | 相位点用颜色+透明度表达运行/卡顿（有文字 pill 兜底，尚不构成 1.4.1 违规）；整行无 `aria-live`，屏幕阅读器收不到阶段变化 | 给相位标签加 `aria-live="polite"`（节流后再定） |
| L9 | 头部 `:9-11`、`:24-27` | 注释引用的宿主行号已漂移：装好的 checkout 里 `slot "…" is not declared` 在 `ui-slots/lib/index.js:66`（非注释所述总在 `:163-221`），同 priority id 撞车在 `:84`（非 `:182/:184`） | 刷新引用行号；**被引用的契约事实本身仍然成立** |
| L10 | `:173`、`:287` | `rotation.armed` 在 zh/en 都是死键（`:1274-1292` 的三元链直达 `armed.auto/manual/waiting`，永不落到裸 `armed`） | 删除两键，或补一个真正的"已达阈值"兜底分支 |
| L11 | `:83` vs `:236`、`:350` | 文案把"8 秒"写死进字典，而阈值是 `PROJECTION_GRACE_MS`；改常量文案会说谎（`:669` 已用 `fmtElapsed(waited)` 拼了真实值，两处口径并存） | 文案去掉具体秒数，或做成 `{grace}` 参数 |

---

## locale 键完整性（脚本核验，结论可用）

- **zh / en 各 110 键，双向零差异**（`zh-only=[]`、`en-only=[]`）——**不存在缺键、错键或漏译**。
- 所有动态拼 key 的调用点（`phase.${key}` `:370`、`prefix.cause.${causeKey}` `:1016`）都带 fallback 表达式，未命中不会写出内部词。
- 全部 `text(...)` 调用点均提供了 fallback 字面量，`makeText`（`:355-367`）在 `t` 缺失、抛错、或原样返回 key 三种情况下都会退到内置字典 —— 这一点是必要的：`scoped-slots.js:340-347` 只保证 `entry.locale` 有值（本插件 `:1633` 传了 `NS`）时挂 `t`，注册失败时 `t(key)` 很可能返回 key 本身。
- 唯二真正未使用的键是 `rotation.armed`（L10）与 `prefix.cause.none`（后者属防御性兜底，宿主若下发 `prefixCause:'none'` 会用到，建议保留）。
- 缺口在**字典之外**：M5 的版本错配串、M7 的全角冒号、L11 的硬编码秒数，都不走 `text()`，因此不受这份 110×2 的完整性保护。

## 做得对的地方（避免误改）

- `openWithRetry`（`:1338-1357`）的"捕获同步 throw 后 300ms 退避"与宿主 `sessions.open` 的真实语义**完全吻合**（同步 void + 同步 throw），10 次上限计数也准确（首次 + 9 次退避，约 2.7s），不要改成 `catch` promise。
- 钩子调用顺序无条件、无规则违规；`:857` / `:1595` 的 `try` 都只包住渲染体，异常一律落成可见的红 pill，符合文件自述的 §9#3。
- 两个条目**各自注册、各自自检**（`:1628-1662`），一条挂不上不连坐另一条；`syncMountFlag`（`:1619-1625`）只在值真变时写 `dataset`，没有抖动。
- `icon()` 统一 `aria-hidden`（`:493-509`）；`GLYPH_*` 与 `ROW_STYLE`/`PILL_STYLE` 提到模块级，未在渲染路径里重复分配。
- `:464` 宿主为每个条目包了 `SlotErrorBoundary`，所以 `:829` / `:1591` 那两处 `useProjection`（在 `try` 之外）即使抛错也不会白屏——代价是走宿主兜底 UI 而不是本插件的红字，故列为低优先。

**最该先动的三件**：H1（自动轮换实际是死的）、H2+H3（轮换结果无重渲染 + 失败后死锁，三者是同一个"把动作塞进折叠组件"的根因）、H4（活动流全量渲染 + 反转 index key）。H1 的修法（触发点搬进 `TurboStatusBar` 的 effect）同时为 H2/H3 提供了天然的通知落点，建议一并重做。

## 开发者工具工程师
清理完成——仓库根目录恢复为原来的 7 个文件。以下是审计报告。

## 结论先行

**254 条测试是真绿**（`node --test "test/*.test.mjs"` → exit 0，tests 254 / pass 254 / fail 0 / skipped 0，956 ms），而且这套测试自带几条**真实有效**的机检护栏：`G5 零跳过`自扫、`M1 三方版本等式`、`§34/§35 notes.js 兜底常量 vs DEFAULT_CONFIG 漂移机检`、`G1 零构建`、`test/spill.test.mjs:685` 的源码级静态检查。

问题不在"假绿"，而在**覆盖落点**和**文档漂移**：两处 I/O 编排层**整层从未执行**，四份文档会把人导向错配置或装错包。我按严重度列如下。

> 方法说明：除读码外，我用 `NODE_V8_COVERAGE` 跑了全套测试并把 V8 函数级覆盖**按 pathname 聚合**，得到"该函数是否被这套测试执行过"的权威答案。**`node --experimental-test-coverage` 的按文件表对 [lib/client.js](dsh-turbo/lib/client.js) 不可信**（测试用 `import('.../client.js?fresh=tag')` 制造多个 script URL，报告器只算其中一个，于是显示 line 47% / funcs 9.62%）。我下文用的是聚合值。

---

## P0

### 1. 交接导出的全部执行编排在新版测试里从未跑过（未覆盖分支 + 测试绿但生产会错）

- [lib/index.js:494-574](dsh-turbo/lib/index.js#L494-L574) 整段是死的。两个独立方法互证：
  - V8 聚合：`227:stampOf`、`239:readHandoffEntries`、`248:ensureHandoffDir`、`260:stderrTail`、`500:exportLane`、`528:planAndRun`、`568:onSettle` 全部 **count === 0**；[lib/handoff.js:561](dsh-turbo/lib/handoff.js#L561) `listLanes` 同样 0。
  - grep：`test/` 下 `noteHandoff` / `listLanes` / `handoffSpawns` **零命中**；`handoffExportSubLanes` 仅有两处，且都只是 `assert.equal(DEFAULT_CONFIG.handoffExportSubLanes, false)`（[test/handoff.test.mjs:527](dsh-turbo/test/handoff.test.mjs#L527)、[:710](dsh-turbo/test/handoff.test.mjs#L710)）——**断言常量值，不驱动那条分支**。
- 精确边界：`noteHandoff` 是被调用的，但只跑到 [:485](dsh-turbo/lib/index.js#L485) `profileDir: profileDirOf()` 与 [:490](dsh-turbo/lib/index.js#L490) `bili === null` 就 return 了（测试环境里 `resolveBili` 必然返回 null）。⇒ **测试只验证了"缺席 → unavailable"这一条路径，真起进程/真写盘/记 DONE|FAILED/子车道枚举/进程上限 break 全部没有被执行过一次。**
- 同源线索：`lib/index.js:98 safeParse` 也是 0 调用，但那是**设计如此**（[:92-94](dsh-turbo/lib/index.js#L92) 注明运行时只调 `.parse()`），不算缺陷；[:951](dsh-turbo/lib/index.js#L951) 那个匿名函数是 `planStuckAction` 里 `ctx0.waterfall(..., () => [])` 的 fail-closed 兜底，默认 `stuckAction: 'warn'` 下**按设计不可达**（T05-13 专门断言了这点）。这两个是"解释得清的空位"，其余不是。
- **为什么是 P0**：这不是新问题，是**第二次同类事故**。[docs/review-0.7.0-handoff.md:77](dsh-turbo/docs/review-0.7.0-handoff.md#L77) 的 P1-5 原文就是「`noteHandoff` / `profileDirOf` / `stampOf` **零测试覆盖** —— 212 条绿**不能**证明触发链真的会跑 —— 而 P0-1/P0-2 正是"测试全绿但线上跑不通"的例子」。P0-1/P0-2 修掉了，**P1-5 没修**（见 P1-3）。

### 2. 客户端轮换执行体整条死（0.9.0 头号功能的客户端一半 + manual 点击行）

`lib/client.js` 69 个函数中 9 个从未执行，其中最关键三个连成一条链：

| 位置 | 符号 | 含义 |
|---|---|---|
| [lib/client.js:1365](dsh-turbo/lib/client.js#L1365) | `performRotation` | 客户端轮换执行体（拿 `sessions`/`workspaces`、记 outcome） |
| [lib/client.js:1338](dsh-turbo/lib/client.js#L1338) | `openWithRetry` | 0.9.0 新增的有界重试（10 次 × 300 ms） |
| [lib/client.js:1316](dsh-turbo/lib/client.js#L1316) | `rotationReasonText` | 失败原因按 locale 渲染 |
| [lib/client.js:1299](dsh-turbo/lib/client.js#L1299) | `h.onClick` | `manual` 模式那一行**点击入口** |

其余：`899:subscribeDetail`、`1565:onClick`、`1593`、`836`/`845`（状态条的 `setInterval`/`setTimeout` 回调）。

- 这正是 [docs/design-rotation.md:88-89](dsh-turbo/docs/design-rotation.md#L88) 测试计划里要求的「客户端执行体注入假 `sessions`/`workspaces`，断言调用顺序 `fork → open → archive`，并断言拿不到服务时一次都不调用」——**这条测试不存在**（0.9.0 已把顺序简化为只剩 `open`，但"注入假服务断言调用"这条验收从未落地）。
- 加剧因素：`test/halves.test.mjs` 的 `makeCtx` 替身 `get()` **只认 `'timer'`**，不提供 `sessions`/`workspaces`，所以"拿不到服务"这一路恰好可测，而"拿得到"那一路从未被测。

### 3. `docs/packaging.md` 停在 0.6.2，照着它做会装错包

[docs/packaging.md:27](dsh-turbo/docs/packaging.md#L27) 目标版本 `0.6.2`、[:75](dsh-turbo/docs/packaging.md#L75) 拷贝命令写死 `dist\dsh-status-turbo-0.6.2.tgz`、[:83](dsh-turbo/docs/packaging.md#L83) 装机命令 `plugin_manager install_bundle file:.../dsh-status-turbo-0.6.2.tgz`、[:129](dsh-turbo/docs/packaging.md#L129) 验收判据 `tests 175`。现网是 **0.9.2 / 254 条**，`dist/` 里已有 20 个 tgz（到 `dsh-status-turbo-0.9.2.tgz`）。

这是"操作性 runbook"，不是设计稿：**照抄命令会装上一个 7 个版本前的产物**，且判据 `tests 175` 已不可能满足。建议优先级高于纯设计文档。

### 4. `docs/design-handoff-export.md` 六个键默认值全错，且核心论证已被自己推翻 —— 却没有弃用横幅

[docs/design-handoff-export.md:3](dsh-turbo/docs/design-handoff-export.md#L3) 只写「状态：待确认（三个待定项见文末）」，**不是**弃用标记。逐条对照：

| 文档（:28-35） | 代码（`DEFAULT_CONFIG`） |
|---|---|
| `handoffExport` 默认 `false` | **`true`**（[lib/state.js:121-123](dsh-turbo/lib/state.js#L121)）|
| `handoffExportTokens` `400000` | **`240000`** |
| `handoffExportMinDeltaTokens` `100000` | **`60000`** |
| 表中不存在 | `WindowPercent` / `MaxPerProcess` / `SubLanes` / `Bytes` / `MinDeltaBytes` / `FreshMs` / `RefreshBytes` 七个后加键 |

更要紧的是两处**已被推翻的结论仍在文内**：

- [:20](dsh-turbo/docs/design-handoff-export.md#L20)「`usage.inputTokens` … 和 bili 那条护栏（`payload core text`）**完全一致**」——被 [lib/state.js:172-173](dsh-turbo/lib/state.js#L172) 直接否定（token 量的是 bili **压缩之后**的计费输入，而 fail-fast 那次根本没有 usage 事件）。
- [:41-45](dsh-turbo/docs/design-handoff-export.md#L41) 的探测链 ②③ 正是 review-0.7.0 的 P0-1/P0-2（`ERR_PACKAGE_PATH_NOT_EXPORTED`、`.CMD` 无 shell 抛 `EINVAL`）。
- [:10](dsh-turbo/docs/design-handoff-export.md#L10)「**不做**：不自动切新会话」被 0.9.0 方案 B 推翻。

反差点：同一作者的 [docs/design.md:159](dsh-turbo/docs/design.md#L159) 会老老实实挂「**本节已过期一处**」横幅 ⇒ 缺横幅是纪律不一致，不是风格。

---

## P1

### 5. README 轮换小节：标题与前提跟代码、甚至跟同页表格互相打脸

- [README.zh.md:209](dsh-turbo/README.zh.md#L209) 标题仍是「—— **默认 manual**」，而 [:187](dsh-turbo/README.zh.md#L187) 表格与 [:226](dsh-turbo/README.zh.md#L226) 正文都说 `'auto'`，代码是 [lib/state.js:212](dsh-turbo/lib/state.js#L212) `rotation: 'auto'`。
- [:211](dsh-turbo/README.zh.md#L211)「越过阈值**且本会话当前处于 `idle` 阶段**时」，而 0.9.2 默认 [lib/state.js:230](dsh-turbo/lib/state.js#L230) `rotationRequireIdle: false`、判据在 [lib/rotation-host.js:134-146](dsh-turbo/lib/rotation-host.js#L134)，同页 [:228](dsh-turbo/README.zh.md#L228) 也写明了不再要求空闲。
- **归因明确**：`tools/set-rotation-auto.mjs` 只改了表格行（job `README.zh.md` 第 1 组）与那句正文（第 2 组），**没有覆盖小节标题和 `idle` 前提**。0.9.2 没有对应的 sweep 脚本（`tools/` 里只有 0.8.1 与 v8/v9/v10 的），所以标题+前提漏改。这是"字面替换脚本"的典型漏网点，也是本次审计里最容易被用户直接撞上的一条。

### 6. README 交接小节另有 4 处与代码矛盾（含一处危险的"同一个口径"）

| 位置 | README 说 | 代码/测试 |
|---|---|---|
| [:163-164](dsh-turbo/README.zh.md#L163) | 命令探测**三级**，第三级 `node_modules/.bin/bili[.CMD]`，「**三条**都失败」 | [lib/handoff.js:350-383](dsh-turbo/lib/handoff.js#L350) 只有**两个**候选，且 JSDoc 明写 `.bin/bili.CMD` 抛 EINVAL **已被弃用**；[test/handoff.test.mjs:155](dsh-turbo/test/handoff.test.mjs#L155) 断言「**永不返回 .cmd**」 |
| [:179](dsh-turbo/README.zh.md#L179) | 「走上面的**两级**探测」 | 与同节 :163 的"三级"自相矛盾 |
| [:161](dsh-turbo/README.zh.md#L161) | 「与 bili 那条护栏**同一个口径**」 | 同 P0-4：已被 [lib/state.js:172-173](dsh-turbo/lib/state.js#L172) 推翻 |
| [:167](dsh-turbo/README.zh.md#L167) | 「本进程最多 **8** 次」 | 默认 **64**（[lib/state.js:162](dsh-turbo/lib/state.js#L162)，且同页 [:181](dsh-turbo/README.zh.md#L181) 表格就写着 64） |
| [:168](dsh-turbo/README.zh.md#L168) | 「**不做**：不自动切新会话」 | 0.9.0 起宿主建会话 + `rotationOpenChild: true` 自动切 |

**注意一个反转**：包内 [cordis.patch.yml:105-106](dsh-turbo/cordis.patch.yml#L105) 的注释**是准确的**（"一律用 node 跑它；不用 .bin 的 .cmd"），比 README 准。值得注意的是 [:95-96](dsh-turbo/cordis.patch.yml#L95) 那句「口径与 bili preflight 那条 payload core text 一致」同样带着被推翻的论证——**两处最可能被审阅者在调阈值前查看的地方，都留着错的理由**。

### 7. UI 测试全部喂手写快照，没有任何一条用真实 `toView()` 产物；fixture 名称/注释/取值三方漂移

- [test/halves.test.mjs:511](dsh-turbo/test/halves.test.mjs#L511) `wireSnapshot` 注释写「wire **v7** 的一整份快照（0.6.5 起客户端认 v7：**33 键**）」，代码是 **`v: 10`**，字面量实际 **28 键**，而且**根本没有 `rotation` / `handoff` 两个键**。
- [test/ui-contract.test.mjs:319](dsh-turbo/test/ui-contract.test.mjs#L319) 同一个 fixture 的第二份拷贝（按文件头说明是有意重复）：函数名 **`wireV6`**、注释 **v7**、值 **v10**。
- 该文件**不 import `initState` / `toView`**（grep 零命中）⇒ 客户端渲染从未对着真实宿主产物验过。宿主/客户端的"协议一致"目前只剩两道弱保证：版本号等式（`M1`）与一个**测试自维护的键名清单** + 魔数 36（[test/state.test.mjs:256-269](dsh-turbo/test/state.test.mjs#L256)）。
- 后果直接叠在 P0-2 上：**「会话轮换」与「交接文档」两个分区只在"字段缺席"这一态被渲染过**（[test/halves.test.mjs:707-721](dsh-turbo/test/halves.test.mjs#L707) 只断言分区标题在），`armed`/`manual 可点`/`已导出 → 路径` 等真实态从未上过屏。

### 8. `docs/review-0.7.0-handoff.md` 的状态横幅与实测矛盾

[:6](dsh-turbo/docs/review-0.7.0-handoff.md#L6)「**本文件列出的 P0 / P1 / P2 全部已修复**」，但同一文件 [:77](dsh-turbo/docs/review-0.7.0-handoff.md#L77) 的 P1-5（`noteHandoff`/`stampOf` 零覆盖）经本次实测**依然成立**。P1-1~P1-4、P1-6、P1-7 确实都能在代码里找到修复（`handoffExportMaxPerProcess` 可配、`isFreshEvent`、`windowPercent`、`HANDOFF_GITIGNORE`、文件名带桶号）。⇒ 横幅应改成"除 P1-5 外"。

### 9. 「三处同值」纪律**没有任何机检**

README[:170](dsh-turbo/README.zh.md#L170)、[docs/design.md:213](dsh-turbo/docs/design.md#L213)、[lib/state.js:41](dsh-turbo/lib/state.js#L41) 都声明 `DEFAULT_CONFIG` 是唯一真源、`cordis.patch.yml` 逐字镜像、README 表格同步——但 `cordis.patch.yml` 在 **`test/` 下零命中**（56 处全在 README/CHANGELOG/docs/tools）。历史上已分歧过两次（[CHANGELOG.md:83](dsh-turbo/CHANGELOG.md#L83) `{oldId}` vs `{old}`；[:108](dsh-turbo/CHANGELOG.md#L108) `rotationArchiveOld` true vs false），两次都是**人眼发现的**。我逐键比对过当前三方是**一致**的（44 个键），但这是一致性靠自觉，不是靠闸。仓库自己的 AGENTS.md 要求"机检不变量接入执行中的闸"，这条没接。

### 10. `docs/design.md` 停在 0.6.5，0.7–0.9 **完全没有设计文档**

最高只到 §14（0.6.5 / wire v7 / [:1015](dsh-turbo/docs/design.md#L1015)「Config 19 → **21 键**」），grep 全库 0 命中 `0.7.x`/`0.8.x`/`0.9.x` 于该文件。[docs/roadmap.md:54](dsh-turbo/docs/roadmap.md#L54) 自己写「`docs/design.md` 是否同步到 0.9.x 也待核」——**答案是没同步**。加上 P0-4 与 0.9.0 方案 B 无设计文档，等于 0.7 之后 30 个版本的行为只由 CHANGELOG + README + 代码注释承载。

---

## P2

11. **测试标题与断言不符**（同 P1-5 的漏网家族）：[test/rotation.test.mjs:62](dsh-turbo/test/rotation.test.mjs#L62) 标题写「其余回落默认 **manual**」，正文 [:66-69](dsh-turbo/test/rotation.test.mjs#L66) 断言 `'auto'`；[test/halves.test.mjs:699](dsh-turbo/test/halves.test.mjs#L699) 标题说「0.6.4 起 11 个、0.7.0 起 **12 个**分区」，实际断言 **13** 个标题 / 11 个 bare。
12. **阈值类测试本质是常量复述**：`assert.equal(DEFAULT_CONFIG.handoffExportTokens, 240_000)` 这类断言（[test/handoff.test.mjs:62](dsh-turbo/test/handoff.test.mjs#L62)/[:521](dsh-turbo/test/handoff.test.mjs#L521)/[:615](dsh-turbo/test/handoff.test.mjs#L615)）是**变更探测器**，不是行为测试——`tools/fix-thresholds-tests.mjs` 190 行就是为机械重写它们而存在的。工具本身也有洞：`fix-v8-tests.mjs` 未命中只打印 `MISS` 仍写盘且不设非零退出码，`fix-v9-tests.mjs` 连命中数都不检查，`fix-readme-thresholds.mjs` 记了失败仍在 [:45](dsh-turbo/tools/fix-readme-thresholds.mjs#L45) 无条件写盘。只有 `fix-v10-tests.mjs`（[:52-55](dsh-turbo/tools/fix-v10-tests.mjs#L52)）与 `fix-thresholds-tests.mjs` 有真正的失败闸。
13. **判据顺序**：[lib/rotation-host.js:130-133](dsh-turbo/lib/rotation-host.js#L130) 的 `no-cwd`/`no-service` 检查排在 [:134](dsh-turbo/lib/rotation-host.js#L134) 的 `shouldRotate` **之前** ⇒ 一个没有绝对路径 cwd 的会话，在**远未到阈值**时也会带上 `message: no-cwd`。显示后果我无法确证（渲染它的 `rotationReasonText` 属于 P0-2 的死函数），故只作设计异味记，不作 bug 断言。
14. **`rotationMode` 非法值静默回落 `auto`**：三处明文承认（[lib/state.js:210](dsh-turbo/lib/state.js#L210)、[CHANGELOG.md:46](dsh-turbo/CHANGELOG.md#L46)）——把 `'manul'` 打成别字会得到**最激进**的模式，与「误配要吵」相悖。
15. **覆盖率表口径不可引用**：见开头的 `?fresh=` 说明。任何以 `--experimental-test-coverage` 的 client.js 行数（47%/9.62%）为依据的门槛或被引用的结论都应换口径。

---

## 这套测试**没有**假绿的地方（免得只报坏消息）

- 纯逻辑层函数级覆盖是**真**的：`rotation.js` 6/6、`rotation-host.js` 9/9、`gears.js` 10/10、`spill.js` 23/23 全部被调用过；`state.js` 74 个只死 1 个匿名函数。
- `§34/§35` 那条机检是**真的跨模块不变量**（比较 notes.js 兜底常量与 `DEFAULT_CONFIG` 同名默认值逐字相等），不是自证。
- `handoff.test.mjs` 对 `resolveBili` 的断言（"永不返回 .cmd"）与 review-0.7.4 要求的"对着真实 `import.meta.url` 布局断言"（[test/handoff.test.mjs:713](dsh-turbo/test/handoff.test.mjs#L713)）都已落地——**说明这个项目有能力写出好测试，问题是把这条标准只用在被 review 打到过的地方**。
- CHANGELOG 的两条自我约束（[:7-11](dsh-turbo/CHANGELOG.md#L7) 不编日期、不写未实现的东西）执行得比多数项目严格。

---

## 建议的修复顺序

1. **补两条"真的会跑"的接线测试**（对着 P0-1/P0-2）：① `noteHandoff` 注入假 `spawn` + 真 tmp 目录，断言 `ensureHandoffDir → runExport → pushHandoff(DONE)` 与进程上限 break；② 客户端注入假 `sessions`，断言 `performRotation` 的 `open` 重试与 outcome。这两条能把 P0 的两层尸体变成活体。
2. **换成机检代替人眼**：一条断言 `DEFAULT_CONFIG` 与 `cordis.patch.yml` config 段逐键逐值相等的测试（P1-9），顺带把 README 表格也纳入（README 表格解析失败即 FAIL，而不是"待人发现"）。
3. **文档三档处置**：`docs/packaging.md` 直接重写到 0.9.2（操作性，最急）；`docs/design-handoff-export.md` 挂"已被 0.7.1/0.7.4/0.9.0 取代"横幅或删表；`docs/design-rotation.md` 补两行"待定项已定案：`rotation: 'auto'`、`rotationArchiveOld: false`"即可结案。
4. 把 `rotation.test.mjs:62`、`halves.test.mjs:699`、`README.zh.md:209/211` 四处标题与前提改对（一次机械 sweep），并把 `fix-*.mjs` 的"未命中即非零退出"补齐到全部脚本。

## 本次未做 / 无法确证的部分

- **没有做端到端实证**：没起真实 DSH 宿主、没跑真实 `bili export`，所以"生产会错"是依据「代码路径零执行 + 该项目已发生过两次同类事故」的推断，不是我在真实环境复现出来的失败。
- 只做了版本级抽查的文档：[docs/acceptance.md](dsh-turbo/docs/acceptance.md)、[docs/plan-B.md](dsh-turbo/docs/plan-B.md)（`docs/plan-B2.md` 已通读，结论是本轮不实现且有三条接续点，与代码一致）。
- `dist/` 下 20 个 tgz 未逐个与源码比对；`docs/design.md` 1146 行只做了结构级扫描（版本表/键数/测试计数）。
- `test/` 下 4 条未能被我的 `test(` 正则捕获的用例名未逐一核对（254 总数以 runner 输出为准）。
- 只读已恢复：我在 `D:\project\dsh-turbo` 下误建的两个抓取文件（`dsh-turbo-test-run.txt`、`dsh-turbo-coverage.txt`）与 `%TEMP%\dsh-cov` 已删除，仓库根目录已回到原 7 个文件；**未改动插件任何源码、测试或文档**。