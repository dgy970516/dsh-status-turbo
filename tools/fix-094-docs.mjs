/**
 * 0.9.4 收尾：版本号、CHANGELOG 小节、以及各文档里写死的「测试条数 / 键数」。
 *
 * 为什么用脚本而不是逐处手改：0.9.3→0.9.4 期间有三个子代理并发写过文档，条数与键数散落在 6 个文件里，
 * 逐条字面替换 + 命中数报告一次跑完，且**任何一处没命中就非零退出**，避免"以为改了其实没改"。
 *
 * 用法：node tools/fix-094-docs.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const write = (rel, text) => writeFileSync(join(root, rel), text)

const CHANGELOG_094 = `## [0.9.4] —— 审计 0.9.2 的剩余 P1/P2：前端可达性与性能、配置单一路径、热路径 I/O、teardown 与句柄、文档一致性

本轮把两份专家审计（\`docs/audit-0.9.2.md\`、\`docs/audit-0.9.2-experts-raw.md\`）里剩下的 P1/P2 逐条落地，
并把其中**可机械判定**的条目固化成 \`tools/audit-gate.mjs\`（44 条断言，\`--root <dir>\` 可指向装好的那份跑）。
**不改任何默认语义、不升 wire**（仍 v10 / 36 键，\`ledger\` 依旧不进 wire），\`lib/state.js\` 保持纯（无 \`Date.now()\`）。
测试 268 → **293**。

### 客户端半（前端）

- **活动流限长**：宿主新增 \`activityLimit\`（24）/ \`activityBytes\`（8192），环缓冲超限或超字节就从头部丢；
  客户端只渲染最近 24 条，并给出「更早的 N 条已省略」提示行。条目 key 改用元素在**原数组**里的下标
  （倒序渲染不再让整段 key 平移），工具行 key 改用工具身份。
- **展开态秒级心跳**：详情面板只在「展开 + busy」时挂整秒对齐的递归 \`setTimeout\`（节拍 \`CLOCK_TICK_MS\`），
  收起或空闲**不留任何定时器**；「现在」那行的秒数不再冻在打开面板的那一刻。
- **分区渲染缓存**：模块级 \`memoSection(name, deps, build)\` 缓存 10 个分区的渲染结果
  （读渲染时钟或模块级可变状态的 3 个分区故意不缓存）。**没有用 \`React.memo\` / \`useMemo\`**：
  \`test/halves.test.mjs\` 的 React 替身只实现 \`createElement/useState/useRef/useEffect\` 且按元素树断言，
  插子组件会破坏它的 \`children\` 断言。同一原因，审计要求的「折叠时不订阅投影」**未做到**
  （\`useProjection\` 仍无条件调用）—— 记为已知偏差。
- **可达性与一致性**：两个交互入口补 \`role=button\` / \`tabIndex\` / \`aria-expanded\` / \`onKeyDown\`（Enter 与 Space）；
  分区标题 \`role=heading\` + \`aria-level=3\`、分区与面板根 \`role=region\` + \`aria-label\`；相位 pill 与空闲 pill 挂 \`aria-live="polite"\`；
  面板 \`maxHeight:60vh\` + \`overflowY:auto\`，值行补 \`title\`。
- **其余**：状态条改整秒对齐递归 \`setTimeout\`，脉动周期 4000 ms = 4 节拍（消除 2 Hz 混叠）；
  \`error.versionMismatch\`（\`{host}\`/\`{client}\`）与 \`error.missingProjectionAge\`；两处 \`toLocaleTimeString\` 改 \`fmtClock\`；
  \`labelSeparator\`（读 \`label.colon\`）替掉硬编码全角冒号；挂载自检定时器经 disposer / \`ctx.effect\` 清理；
  \`openWithRetry\` 可取消（会话切走即停）；增强缺席走 \`enhancement.unknown\`；Top N/总数提示；删掉死键 \`rotation.armed\`；
  等待提示参数化 \`{grace}\`（不再写死「8 秒」）；兜底数字集中到 \`CLIENT_FALLBACK\` 并注明来源。

### 宿主半

- **\`stateSchema\` 不再是恒等直通**：改为窄校验 \`turboStateSchema\`（非对象、必填字段类型错 ⇒ \`TypeError\`；
  \`step\`/\`turn\` 负数 ⇒ \`RangeError\`），\`viewSchema\` 仍留恒等。注意真快照里 \`turn\`/\`step\` 可以是 \`null\`，
  且宿主 \`init()\` 可能**不带 header** —— 第一版写严了会把每个真快照都拒掉（等于每次重启丢水位）。
- **折叠热路径无同步 I/O**：\`readdir\`/\`mkdir\`/\`writeFile\` 全走 \`node:fs/promises\`；\`.gitignore\` 改为每个目录只写一次；
  \`noteHandoff\` 成异步出口（永不 reject，折叠里 \`void\` 调用）；同一会话同水位用显式单飞闸。
- **配置单一路径**：\`apply\` 只解析一次 \`effective\`（唯一一处 \`...DEFAULT_CONFIG\`），并喂给所有消费者；
  \`gears.js\` 的 4 组默认值副本删除；隐藏键 \`readOnlyTools\` 升为 \`DEFAULT_CONFIG\` 键；
  导出超时升为一等键 \`handoffExportTimeoutMs\`（120000）。
- **per-mount 状态**：\`ctx0\`/\`effective0\`/\`handoffSpawns\`/\`laneReads\`/\`liveChildren\`/\`active\`/\`lastRotationArmedAt\`/
  \`warned*\`/\`stuckRuns\` 全部收进 \`apply\` 建的 \`run\`，以首参贯穿各函数。\`state.js · runtimeBySession\` 无法搬迁
  （写者是导出的自由函数），已在该文件头写明**单挂载假设**与理由。
- **teardown 与句柄**：\`ctx.effect\` 的 teardown 置 \`run.active = false\` 并逐个 kill 在册子进程，\`onSettle\` 首行早返回；
  超时先 \`SIGTERM\` + 销毁两个管道，宽限期后 \`SIGKILL\`；无捕获时 \`unref()\`。
- **预算与淘汰**：车道列表读取计入进程预算（到量落聚合 \`LIMIT_REACHED\` + warn）；运行表改 LRU
  （\`touchRuntime\` 只在折叠路径 touch，淘汰不再意外解除 armed 守卫）；建子会话前用 \`sessions.list()\` 查有无可复用的子会话
  （只能看见**存活**会话，旧进程建的查不到，已在代码注释写明）。
- \`DEFAULT_CONFIG\` 新增 \`readOnlyTools\`、\`handoffExportTimeoutMs\`（现共 **46 键**），包内 \`cordis.patch.yml\` 值已同步。

### 文档与工具

- 新增 \`tools/audit-gate.mjs\`：44 条「必须出现 / 必须消失」断言（\`--json\`、\`--root <dir>\`），全过 exit 0；
  新增 \`tools/verify-install.mjs\`：版本一致 / \`TURBO_STATE_VERSION\` 与 \`EXPECTED_V\` 相等 / 装好的 \`DEFAULT_CONFIG\` 标量与装好的
  \`cordis.patch.yml\` 同值 / \`lib/\` 清单一致 / wire 36 键且不含 \`ledger\` / 对装好的产物跑一遍闸门。
- \`docs/design.md\` 补 §15「0.7–0.9 的演进」；\`docs/packaging.md\` 更到当前版本；\`docs/design-handoff-export.md\` 正文改到现状；
  \`docs/acceptance.md\` / \`docs/plan-B.md\` / \`docs/roadmap.md\` / \`docs/review-0.7.0-handoff.md\` 补状态行；
  两份 README 的配置表首列与 \`DEFAULT_CONFIG\` 逐一对齐（46 键，missing/多余皆空）。

### 已知偏差与未验证

- **「折叠时不订阅投影」未做到**（见上）；\`React.memo\` 改用 \`memoSection\`（见上）。
- 导出链路全程用假 \`spawn\` 驱动，没有起过真 \`bili export\`；真浏览器/DOM 行为（焦点环、屏幕阅读器播报、滚动条）
  只做了元素树层面的结构断言。

`

const edits = [
  ['package.json', '"version": "0.9.3"', '"version": "0.9.4"'],
  ['CHANGELOG.md', '## [0.9.3] —— 修 0.9.2 的两条回归 + 给两条主链补上真实覆盖', CHANGELOG_094 + '## [0.9.3] —— 修 0.9.2 的两条回归 + 给两条主链补上真实覆盖'],
  ['README.md', '# 271 例', '# 293 例'],
  ['README.en.md', '# 271 cases', '# 293 cases'],
  ['docs/acceptance.md', '`DEFAULT_CONFIG` 44 键、测试条数以现场', '`DEFAULT_CONFIG` 46 键、测试条数以现场'],
  ['docs/acceptance.md', '（0.9.3 期间实测 271 条）', '（0.9.4 期间实测 293 条）'],
  ['docs/design.md', '0.9.3 期间实测 271 条', '0.9.4 期间实测 293 条'],
  ['docs/packaging.md', '当前版本：`0.9.3`', '当前版本：`0.9.4`'],
  ['docs/packaging.md', '0.9.3 = **271**', '0.9.3 = 271、**0.9.4 = 293**'],
]

let misses = 0
const byFile = new Map()
for (const [file, from, to] of edits) {
  const text = byFile.get(file) ?? read(file)
  const hits = text.split(from).length - 1
  if (hits === 0) {
    misses += 1
    console.log(`✘ ${file}: 未命中 「${from.slice(0, 48)}…」`)
    continue
  }
  byFile.set(file, text.split(from).join(to))
  console.log(`✔ ${file}: ${hits} 处 「${from.slice(0, 40)}…」`)
}
for (const [file, text] of byFile) write(file, text)

// 44 键 → 46 键（只改"当前状态"口径的散文，历史表不动）
for (const file of ['docs/design.md', 'docs/acceptance.md']) {
  const text = read(file)
  const next = text.replace(/(DEFAULT_CONFIG[^\n]{0,40}?)44 键/g, '$146 键').replace(/(配置[^\n]{0,20}?)44 键/g, '$146 键')
  if (next !== text) {
    write(file, next)
    console.log(`✔ ${file}: 44 键 → 46 键`)
  }
}

console.log(misses === 0 ? '\n全部命中 ✓' : `\n有 ${misses} 处未命中 ✗`)
process.exit(misses === 0 ? 0 : 1)
