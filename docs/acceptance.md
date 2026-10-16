# dsh-status-turbo 验收记录（SPEC · G / U / O 逐条）

本文件是 `SPEC.md`「验收标准」的**逐条核对记录**：每一条给出判据、**可复跑的用例（文件 + 行号）**与结果。
它记录的是**本轮实跑**的事实，不是意向。

**基线**：`dsh-status-turbo` v0.4.1 工作树 + 本版（wire v2 / 0.5.0）改动，`D:\project\dsh-turbo`。
**重要**：本文件的结论只覆盖**能自动判定**的部分。**U3 未验证**，另有 4 项缺口 —— 都在 §7 汇总。

> **截至 0.9.3 的状态（后补，不改下文历史结论）**：本文件是 0.5.0 那一轮（wire v2）的**实跑记录**，下文的条数、键数与版本号 —— §1.1 的 `tests 149`、§5 的 M1 行（`=== 2` / 「v2 恰好 28 键」）、§8 的「本版目标 `0.5.0`」—— 都是**那一轮的历史数字**，不是当前判据。当前状态：wire `v: 10`（`TURBO_STATE_VERSION` = `客户端 EXPECTED_V` = 10，`lib/state.js:23` / `lib/client.js:73`）、wire 顶层 36 键、`DEFAULT_CONFIG` 46 键、测试条数以现场 `node --test "test/*.test.mjs"` 为准（0.9.4 期间实测 293 条）。

---

## 0. 怎么复跑

```bash
# 全量自动验收（唯一判定命令）
cd D:\project\dsh-turbo
D:\environment\nodejs_link\node.exe --test "test/*.test.mjs"

# M2 行为重放（真实会话日志）
cd D:\project\dsh-turbo
D:\environment\nodejs_link\node.exe tools/replay-log.mjs "D:\deepseek-harness\sessions\--D-project--\session-78d93391-4f05-45d3-92a4-d5f92d362764\session.v4.jsonl.zstd"
# 加 --peek 打印每种事件的载荷键；加 --stall-ms N 改无进展阈值
```

环境：Windows + Node（`D:\environment\nodejs_link\node.exe`，`engines: node ^22.19.0 || >=24.0.0`）。
**行号口径**：本文件的行号全部来自 DSH 的 grep/read 工具。**不要**用本机 PowerShell 5.1 的
`Get-Content` / `Select-String` 去核对 —— 它们会吞掉空行，行号会偏小。

---

## 1. 本轮实测结果（原始输出摘要）

### 1.1 全量测试

```
$ cd D:\project\dsh-turbo && D:\environment\nodejs_link\node.exe --test "test/*.test.mjs"
ℹ tests 149
ℹ suites 0
ℹ pass 149
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 431.809
[exit code: 0]
```

**149 / 149 / fail 0 / skipped 0**，退出码 0。逐文件计数（`test/*.test.mjs` 里 `test(` 的行数，grep 实测）：

| 文件 | 用例数 |
| --- | --- |
| `test/halves.test.mjs` | 28 |
| `test/state.test.mjs` | 28 |
| `test/notes.test.mjs` | 28 |
| `test/spill.test.mjs` | 17 |
| `test/hooks.test.mjs` | 17 |
| `test/b1-wiring.test.mjs` | 13 |
| `test/gears.test.mjs` | 11 |
| `test/ui-contract.test.mjs` | 7 |
| **合计** | **149** |

### 1.2 M2 行为重放（真实会话日志）

```
$ cd D:\project\dsh-turbo
$ D:\environment\nodejs_link\node.exe tools/replay-log.mjs "D:\deepseek-harness\sessions\--D-project--\session-78d93391-4f05-45d3-92a4-d5f92d362764\session.v4.jsonl.zstd"
# 解压方式 multi-frame（帧数 2364，解压失败帧 0）
# jsonl 行数 3916 ／ 可解析事件 3916（跳过坏行 0）
#   tool/result 659 ／ tool/call 620 ／ step/start 566 ／ turn/start 18 ／ turn/end 18
#   compaction/start 4 ／ compaction/end 4 ／ compaction/prune 39
# B4 前缀作废: 17 次
#   按原因拆分: bulk-injection×9 / compaction-start×4 / compaction-end×4
#   bulk-injection 时刻: +34m15s / +35m45s / +36m07s / +37m11s / +37m45s / +40m13s / +50m12s / +1h29m / +1h35m
# O4 往返计数: step/start 566 次
# 最长工具窗口: pwsh 静默 50.4s（会话 +52m34s）
# 非日志派生（已排除，不作结论）: hookFaults 非空 0 次 / lastSpill 非 null 0 次
[exit code: 0]
```

> ⚠️ **口径提醒**：这份日志在会话进行中还在追加，所以它是**随时间变化的读数**。
> 早先一次复算读到 `step/start 548`，本次读到 **566**（行数 3916）。引用时必须写清是**哪一次**读的，
> 不要把 548 与 566 混用。`50.4s < noProgressMs 默认 90000`，所以那个窗口**不该**带无进展告警。

### 1.3 反向对照（证明 1.2 的"0/0"不是检测器空转）

```
$ D:\environment\nodejs_link\node.exe --input-type=module -e "<initState('polluted-session') → toView 干净 → pushHookFault(...) → pushSpill(...) → 套用 tools/replay-log.mjs 的污染检测规则>"
干净:  hookFaults=[] lastSpill=null
造脏后: hookFaults=1 lastSpill=set
# ✗ 重放被污染，不再是纯日志派生：hookFaults 有 1 次非空；lastSpill 非 null
[exit code: 1]
```

⇒ 检测规则是**活的**：干净会话给 0/0，脏会话给退出码 1。

### 1.4 BLOCKING-INSPECT 取证（`--peek`）

```
#   tool/call    : turn, step, callId, name, arguments      ⇒ INSPECT-3 通过（日志携带参数 ⇒ 指纹维度可做）
#   tool/result  : turn, step, message, meta                ⇒ INSPECT-1 通过（载荷在场 ⇒ B4 大块注入可判）
#   compaction/*: start=compactionId, turn / end=compactionId, turn, error
```

---

## 2. G · 通用护栏（6 条）

| # | 判据 | 用例（文件:行） | 结果 |
| --- | --- | --- | --- |
| G1 | 零构建：`lib/` 无 `*.css/*.scss/*.ts/*.tsx`；`scripts` 只有 `test` | `test/ui-contract.test.mjs:84`、`:106`；`test/halves.test.mjs:919` | ✅ PASS |
| G2 | 图标零依赖：`lib/client.js` 不出现图标包 / `Icon[A-Z]` 标识符 | `test/ui-contract.test.mjs:106`；`test/halves.test.mjs:919` | ✅ PASS |
| G3 | 失败必须可见（5 条通道） | 见下表 | ✅ PASS |
| G4 | 红线未碰（不写 compaction / `agent-default-model`；无 `auto:` 键；无 `saveSelection`/`currentSelection`） | `test/ui-contract.test.mjs:84`、`:106` + 见下（grep 复核） | ✅ PASS |
| G5 | 测试不许隐式跳过（`skip` 调用 0 处） | `test/ui-contract.test.mjs:301`；`test/spill.test.mjs:382` | ✅ PASS |
| G6 | 基线不倒退（exit 0 ∧ `tests >= 45` ∧ `fail == 0`） | §1.1 全量跑：149 / 0 fail / exit 0 | ✅ PASS |

**G3 的五条通道逐一对应**：

| 通道 | 用例 |
| --- | --- |
| ① 投影服务缺失 ⇒ 宿主半大声 `throw`（插件被标 FAILED） | `test/halves.test.mjs:20` |
| ② `ctx.slots` 不可用 ⇒ `console.error` | `test/halves.test.mjs:436` |
| ③ `slots.register` 抛错 ⇒ 点名槽位与条目 | `test/halves.test.mjs:475`（E-A01，R7 不重试） |
| ④ 槽位 3 秒内没挂上 ⇒ `console.error` 点名挂载点 | `test/halves.test.mjs:451` |
| ⑤ 渲染期异常 ⇒ 红字格（`useProjection` 缺失 / 面板渲染抛错） | `test/halves.test.mjs:205`、`:734` |
| 附加：B3 落盘链路 5 条降级都必须上报，且**没有上报通道时必须抛**（禁止静默） | `test/spill.test.mjs:169`、`:187`、`:202`、`:219`、`:233`、`:246`、`:261` |
| 附加：钩子层某段抛错 ⇒ 不 throw、收成 fault | `test/hooks.test.mjs:310`；`test/notes.test.mjs:413` |

**G4 的复核**（在 `lib/` 上 grep `saveSelection|currentSelection|agent-default-model|auto:|slots.register`，4 处命中）：
命中的全部是 `lib/client.js` 的**挂载用法**与注释（`:24`、`:46` 注释；`:1016` `slots.register({...})`；
`:1052` 对 `slots.register` 的能力探测）。**没有** `saveSelection` / `currentSelection` / `agent-default-model` / `auto:` 键。

---

## 3. U · UI 重做（7 条）

| # | 判据 | 用例（文件:行） | 结果 |
| --- | --- | --- | --- |
| U1 | 空闲态**常驻**（`busy === false` 时节点非 null） | `test/halves.test.mjs:225`、`:650` | ✅ PASS |
| U2 | 信息层级四色归位（标题 / 纯数值 / 告警 / 错误 + `color-mix` 淡底色） | `test/halves.test.mjs:563`；`test/ui-contract.test.mjs:145` | ✅ PASS |
| U3 | **并排证据**（用户截图 / 父容器布局读数） | — | ❌ **未验证**（详见下） |
| U4 | 窄屏不溢出（`ROW_STYLE.flexWrap === 'wrap'` + 长告警截断） | `test/halves.test.mjs:603` | ✅ PASS |
| U5 | 会话隔离：按 `sessionId` 记账，`> 128` 整体重置 | `test/halves.test.mjs:795` | ✅ PASS |
| U6 | 挂载失败可观测：`console.error` 具名文案 + `document.body.dataset.dshTurboMountFailed` 写入/清除 | `test/halves.test.mjs:833`；`test/ui-contract.test.mjs:163` | ✅ PASS |
| U7 | 用户可见文案无实现术语（三处故障诊断按**整串**白名单） | `test/halves.test.mjs:883`；`test/notes.test.mjs:490`；`test/ui-contract.test.mjs:230` | ✅ PASS |

### U3 · 未验证（本文件唯一一条不能写 PASS 的验收项）

> **结论：未验证。需要用户实机截图。**

- **要证明什么**：`dsh-status-turbo` 的摘要行与 DSH 原生的底部统计行**真的并排在同一行**（而不是被挤到下一行、
  或被原生那一格挡住），且视觉上不突兀。
- **现有依据只有两类，都不够**：
  1. **源码实读**：`dsh-client-ui-conversation` 声明了 `conversation.composer.dock` 这个 list 槽位
     （`{kind:"list", scope:"session"}`），原生统计行渲染在其中。⇒ 只能说明"挂得进去"。
  2. **结构断言**：`test/halves.test.mjs:165`（`id` / `order` / 槽位名逐字正确）、
     `test/halves.test.mjs:638`（分隔点间距 `0 6px`，抄的是原生值）。⇒ 只能说明"意图对得上"。
- **为什么不够**：本机**没有**任意 HTML 的渲染/截图能力（`web_fetch` 拒绝 loopback，GUI 根返回 401）。
  `order: 1` 只是排序意图；父容器的实际布局（宽度不够时是否换行、`flexWrap` 会不会把摘要行推下去）
  **只有真实渲染能回答**。`SPEC.md` 对 U3 的要求是二者之一：用户实机截图 / 父 entry 容器布局读数。
  **缺一即 FAIL** —— 所以这里记 **未验证**，不是通过。
- **怎么补**：按 §8 的人工复验清单第 ③ 步截图。

---

## 4. O · 优化方向（12 条）

| # | 判据 | 用例（文件:行） | 结果 |
| --- | --- | --- | --- |
| O1 | B4 可见化且**零行为变更**（新字段 + 版本号 +1 + 请求数/token 数与改动前逐字相等） | `test/state.test.mjs:236`、`:243`、`:258`、`:271`；`test/ui-contract.test.mjs:131`；`test/halves.test.mjs:773` | ⚠️ **部分**（见下） |
| O2 | B4 触发源**只来自日志**（`compaction/start`、`compaction/end`、大块注入；禁读自然语言） | `test/state.test.mjs:258`、`:271`、`:289`、`:299` + §1.2 重放（17 次拆分与事件计数吻合） | ✅ PASS |
| O3 | C2：报"你只看了 N / M 行" + 绝对路径 | `test/notes.test.mjs:78`、`:92`、`:99`、`:105`、`:111` | ✅ PASS |
| O4 | C2 / C3 / C1 **一律不新增往返** | `test/hooks.test.mjs:284`（T05-09：计数不变、不起任务、不 emit）；`test/notes.test.mjs:343`（产物只是一个纯 text 块） | ✅ PASS |
| O5 | C3 乱码提示（真实乱码样本，文案逐字） | `test/notes.test.mjs:121`、`:134`、`:142`、`:148` | ✅ PASS |
| O6 | C3 噪声提示（真实噪声样本：npm 缓存 JSON 淹没 pwsh 输出） | `test/notes.test.mjs:181`、`:197`、`:210`、`:217` | ✅ PASS |
| O7 | C1 证据校正：追加在**下一次** `tools/post-execute` 返回里，不"再逼一步" | `test/notes.test.mjs:238`；`test/hooks.test.mjs:270` | ✅ PASS |
| O8 | C1 不许误报：有证据时**逐字相等** | `test/notes.test.mjs:309`、`:335`；`test/hooks.test.mjs:257` | ✅ PASS |
| O9 | B3 必留落盘路径（5 MiB 样本；先 `pruneContent`，不自写截断） | `test/spill.test.mjs:94`、`:131`、`:151`、`:371`（静态检查：零 import / 无 fs 写 API / 无 slice 截断）；`test/hooks.test.mjs:207`、`:235` | ✅ PASS |
| O10 | A2 面板：工具名 × 参数指纹 → 最慢 Top-5 | `test/state.test.mjs:315`、`:346`、`:357`、`:368`；`test/notes.test.mjs:368`；`test/halves.test.mjs:687` | ✅ PASS |
| O11 | B2 **只观测**（默认不开；默认配置下 `ctx.jobs.start` 调用次数 = 0） | — | ❌ **未实现**（见下） |
| O12 | D 默认 `warn` | `test/hooks.test.mjs:362`、`:377`、`:390`、`:405` | ✅ PASS（仅 warn 层） |

**O1 的"部分"**：字段、版本门、客户端呈现都有用例（见上表）。但 O1 还要求一次**对照跑**——
"请求数与 token 数与改动前逐字相等"。**这次对照跑没有做**（本任务没有可对照的改动前运行环境）。
间接支持是 `test/hooks.test.mjs:284`（钩子不新增往返、不起任务、不 emit）与 `test/notes.test.mjs:343`；
但"逐字相等"这句话本身**没有实测证据**，故不写 PASS。

**O11 的"未实现"**：B2 长工具后台化**一行代码都没写**（取证判定本插件内没有落点，登记 BLOCKED，见 `docs/plan-B2.md`）。
所以"默认配置下 `ctx.jobs.start` 调用次数 = 0"成立，但**这个 0 是"没有调用点"的必然结果**，
不是"实现了但默认关掉"。**不许**把它当作 O11 通过。正确表述：`B2 未实现（BLOCKED），见 docs/plan-B2.md`。

---

## 5. 里程碑 M1 / M2 / M3

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| **M1** | **版本等式**：wire 视图的 `v === TURBO_STATE_VERSION === 客户端 EXPECTED_V === 2`，且 v2 恰好 28 键 | ✅ 通过（`test/ui-contract.test.mjs:131`；`test/state.test.mjs:149`、`:236`、`:243`） |
| **M2** | **行为重放**：用真实会话日志复算 B4 / 往返 / 最长工具窗口，并断言两个非日志派生字段在干净日志上是 0/0 | ✅ 通过（§1.2、§1.3） |
| **M3** | **人工验收清单**（必须由人在实机上执行，agent 不得代跑装机） | ⬜ 待用户执行（§8） |

---

## 6. R · 业务规则（12 条）

| # | 规则 | 用例（文件:行） |
| --- | --- | --- |
| R1 | 版本门（版本变了就整日志重折，不做兼容） | `test/ui-contract.test.mjs:131` |
| R2 | `EXPECTED_V === TURBO_STATE_VERSION` | 同上；`test/state.test.mjs:149` |
| R3 | 「同一引用」契约（不关心的事件返回同一引用） | `test/state.test.mjs:24`；`test/hooks.test.mjs:422` |
| R4 | 跳秒（忙碌 500ms / 缺席 1s） | `test/halves.test.mjs:309` |
| R5 | `noProgressMs` 客户端兜底 | `test/halves.test.mjs:387` |
| R6 | 只降不升（B1） | `test/gears.test.mjs:96`；`test/b1-wiring.test.mjs:125` |
| R7 | 注册失败不重试 | `test/halves.test.mjs:475` |
| R8 | 语言包降级只 warn | `test/halves.test.mjs:937` |
| R9 | 忽略事件同引用 | `test/state.test.mjs:24` |
| R10 | 脏事件不产 NaN | `test/state.test.mjs:134`；`test/state.test.mjs:299` |
| R11 | 轨迹不持久化 | `test/state.test.mjs:486`（`initState`/`applyEvent` 不产出非日志字段） |
| R12 | 配置非法回落、永不抛错 | `test/notes.test.mjs:465`；`test/state.test.mjs:289`；`test/spill.test.mjs:308`；`test/hooks.test.mjs:405`；`test/gears.test.mjs:129` |

---

## 7. 诚实缺口汇总（**不许省略**）

**任何地方都不许声称"D 已完整实现"或"U3 已验证"。**

| # | 缺口 | 影响 | 依据 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | **B2 长工具后台化未实现** | 本版没有"长工具自动转后台"的能力 | 取证判定插件内无落点（`PreToolDecision` 不能替换结果、`tools/execute` 只许改 `exec.signal`、`ctx.jobs.start` 唯一路径会新增往返） | **BLOCKED**，方案与取证见 `docs/plan-B2.md`；**不是 O11 通过** |
| 2 | **D 只做到 `warn` 层；`stuckRounds` 无消费者** | 默认 `warn` 零副作用；`nudge`/`stop` 需显式配置；**`stuckRounds` 的配置值对行为无任何影响** | 判据窗口是 `turn/end`，而实现所在层（`tools/post-execute`）看不见它；实现者刻意不造第二套判据（"看不见就是不判"） | backlog；正确表述＝"D 仅 warn 层已交付，`nudge`/`stop` 显式可达，`stuckRounds` 消费者为 backlog" |
| 3 | **U3「是否与原生并排同一行」未经实机验证** | 并排观感未知；本机无渲染/截图能力 | 只有源码实读（slot 声明）与结构断言（`id`/`order`/间距字面量） | 需**用户截图**（§8 第 ③ 步）；`SPEC` 规定缺失即 FAIL |
| 4 | **O1 缺"请求数/token 逐字相等"的对照跑** | "零行为变更"缺直接实测 | 无改动前对照环境；间接支持见 `test/hooks.test.mjs:284` | backlog；文档里只写"字段与不新增往返有证据" |
| 5 | **`hookFaults` / `lastSpill` 让视图不再是日志的纯函数**（本版唯一破例） | 重放同一份日志不必然得到同一份视图 | 这两个字段来自模块级运行时表，不属于日志折叠 | 缓解三条：wire 契约标注"非日志派生" / 重放工具只排除不断言 / 干净会话必然 0/0（§1.3 反向对照证明检测器是活的） |
| 6 | **A2 的"聚合键"有两份实现，算法不同** | 同一个工具调用在两处得到不同的指纹字符串 | `lib/state.js:463-466` 用 **SHA-256** 前 12 位（与 PLAN §3.6 一致，wire `topTools` 用这份；0.5.0 那一轮它在 `:209-221`，行号已漂移）；`lib/notes.js:409-431` 用**自实现 FNV-1a-64**（钩子层 D 判据用） | 功能上不致命（每处自洽），但属重复实现 + 口径分叉；已记入 `docs/design.md · §4.3` 第 5 条；`lib/**` 不在本任务写权限内，未改代码 |

---

## 8. 人工复验清单（M3 —— **必须由人执行**）

> **禁止**让 agent 代执行 `plugin_manager install_bundle`。下面每一条都由人手工完成。

1. **改配置后必须完全重启**：修改 `D:\project\dsh-turbo\cordis.patch.yml` 后**完全重启** DSH。
   **严禁**依赖"保存即热重载" —— `cordis.patch.yml` 的热重载会确定性地崩宿主，
   报 `agent "<uuid>" cannot read inbox state: its projection registration is not active`。
2. **升版本号再装机**：先改 `package.json · version`（本版目标 `0.5.0`），再执行 `install_bundle`。
   **同版本号重复 `install_bundle` 会失败**，返回 `{"application":"failed","error":{"code":"ambiguous-install"},"changed":false}`。
   （这一步同时要确认 `files` 数组里已经包含 `CHANGELOG.md`。）
3. **重启后截图（U3 的唯一证据）**：截一张能看清**摘要行与原生统计行是否并排在同一行**的图。
   截图拿到之前，U3 记**未验证**。
4. **确认故障可观测**：控制台里能看到 `console.error` 具名文案，且界面上三处故障诊断文案可读
   （`挂载点未提供 useProjection` / `投影版本错配（宿主 vN ≠ 客户端 vM）` / 以
   `宿主半似乎没起来：等待投影超过 8 秒仍未到达` 开头的那一条）；
   同时确认 `document.body.dataset.dshTurboMountFailed` 在挂载成功后被**清除**（控制台执行
   `document.body.dataset.dshTurboMountFailed` 应得到 `undefined`）。
5. **`statusBar: false` 复验**：把它设为 `false` 并**完全重启**，确认摘要行与详情面板**都不出现**（没有任何 pill）。
6. **M2 复算（可选，验证环境一致）**：重跑 §1.2 的重放命令，确认 `hookFaults 非空 0 次 / lastSpill 非 null 0 次`。

---

## 9. 一句话总结

自动可判定的部分：**149 / 149 通过**，G 全绿、U 除 U3 外全绿、O 除 O11（未实现）与 O1（对照跑缺失）外全绿。
**U3 未验证**（需要用户截图），**B2 未实现**，**D 只有 `warn` 层且 `stuckRounds` 无消费者** —— 三条缺口都在 §7 有据可查。

---

## 10. 引用的时效性（T12 独立复验追加）

> 本节在文件**末尾追加**（append-only），由 T12 复验于交付前写入；§0–§9 的内容**逐字未改**。

**行号是阅读辅助，不是契约。** 本仓库文档里的 `@ :NNN` 一律**捕获于本轮实现期**，会随文件继续增长而失效。复核时**以锚点文本为准**，用 DSH 的 `grep` / `read` 或 node **重新取号**；行号只用来缩小范围。

**已确认的一段偏移：**
- `lib/client.js` · 从 ≈500 行长到 **1076 行**（node 实测）。因此 `SPEC.md`（在 run 目录 `D:\project\team\讨论讨论-看看这个插件是否还有可-143315\SPEC.md`，**不在本仓库内**）与 §2 G4 引用的那两处落点（`slots.register({…})` 能力探测）在 1076 行版本里需要重新取号，旧行号不再可靠。

**本机 PowerShell 5.1 的 `Get-Content` / `Select-String` 会吞空行、行号偏小，禁止用它核对行号。** 本轮实测对照（同一批文件，`(Get-Content f).Count` vs node `readFileSync(…).split('\n')`）：

| 文件 | PowerShell 5.1 `Get-Content` | node 实测 | 差 |
|---|---|---|---|
| `lib/client.js` | 977 | **1076** | −99 |
| `lib/state.js` | 571 | **634** | −63 |
| `lib/notes.js` | 490 | **575** | −85 |
| `lib/gears.js` | 137 | **161** | −24 |
| `lib/index.js` | 449 | **524** | −75 |
| `lib/spill.js` | 197 | **241** | −44 |

（同一原因：PS 5.1 把长行内的多处命中合并显示，做正则核对必须**按片段不按整行**。注意 `README.md · :241` 一行同时描述 `lib/state.js` 与 `lib/gears.js`，按整行做正则必然误判。）

**日志派生的读数是活数，只对同一次运行比。** 本轮复验期间，同一条会话日志上 `step/start` 读到过四个值（548 → 566 → 584 → **590**），`multi-frame 帧数` 2364 → **2437**、`jsonl 行数` 3916 → **4042**：这不是矛盾，而是**该日志仍在追加**。稳定不变、可作结论的是：`B4 前缀作废 17 次`（`bulk-injection×9 / compaction-start×4 / compaction-end×4`）、`最长工具窗口 pwsh 静默 50.4s（会话 +52m34s）`、`hookFaults 非空 0 次`、`lastSpill 非 null 0 次`。

**一处引用陈旧保存在打包产物里（delivery 面）：** `dist/dsh-turbo-0.5.0.tgz` 内的 `docs/packaging.md` 与仓库当前版本**不一致**（包内 9047 B、仓库 9813 B；首个差异落在第 7 行的引文块，且其中引用的 `docs/acceptance.md` 行号也不同），原因是 tgz 生成于 `2026/10/6 23:37:30`，而 `docs/packaging.md` 在此之后被修改（mtime `23:38:28`；同批的 `docs/design.md` `23:36:47` 与 `docs/acceptance.md` `23:34:11` 均早于 tgz，未受影响）。tgz 其余内容与仓库**逐字节一致**（`lib/*.js` 6 个 + `test/*.test.mjs` 8 个 sha256 全同），仅此一份文档陈旧 —— 详见 T12 findings `FIND-1`。
