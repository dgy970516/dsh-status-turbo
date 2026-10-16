/**
 * A1 支柱验收：纯折叠逻辑（lib/state.js）。
 * 对应任务书 §6 第 1 行（1 秒内看见阶段与耗时）与第 8 行（无进展变黄）的可测部分。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG,
  PHASES,
  TURBO_STATE_VERSION,
  applyEvent,
  clearSessionRuntime,
  firstLines,
  initState,
  pushActivity,
  pushEnhancement,
  pushHookFault,
  pushSpill,
  redactArgs,
  summarizeArgs,
  toView,
  toolKindOf,
} from '../lib/state.js'
import { DEFAULT_MOJIBAKE_MIN_RUNS, EVIDENCE_DEFAULT_PATTERNS } from '../lib/notes.js'

const T0 = 1800000000000
const ev = (type, data, time) => ({ type, data, time })
const fold = (events) => events.reduce((state, event) => applyEvent(state, event), initState())

test('忽略的事件必须返回同一引用（投影下游零成本的契约，不是优化）', () => {
  const state = initState()
  assert.equal(applyEvent(state, ev('todo/write', { todos: [] }, T0)), state)
  assert.equal(applyEvent(state, ev('team/task', {}, T0)), state)
  assert.equal(applyEvent(state, ev('workspace/changes', {}, T0)), state)
  assert.equal(applyEvent(state, ev('unknown/type', {}, T0)), state)
  assert.equal(applyEvent(state, null), state)
  assert.equal(applyEvent(state, undefined), state)
})

test('§6#1 长 bash 期间：阶段 = 执行工具(bash)，且"本阶段已耗时"只由本地时钟推进', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev('step/start', { turn: 1, step: 1 }, T0 + 20),
    ev('request/header', { header: {} }, T0 + 40),
    ev(
      'assistant/message',
      { turn: 1, step: 1, message: {}, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 710, cacheWriteTokens: 0 } },
      T0 + 900,
    ),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, T0 + 950),
  ])

  const view = toView(state, {})
  assert.equal(view.phase, PHASES.TOOL)
  assert.equal(view.tool, 'bash')
  assert.equal(view.busy, true)
  assert.equal(view.toolStartedAt, T0 + 950, 'tool/call 的时间戳必须原样带上——客户端靠它算耗时')
  assert.equal(view.phaseStartedAt, T0 + 950)

  // 之后日志一动不动：3 分钟没有任何新事件，状态条照样能显示 180.0s。
  const now = view.phaseStartedAt + 180000
  assert.equal(((now - view.phaseStartedAt) / 1000).toFixed(1), '180.0')
})

test('§6#8 无进展判定：工具在跑时 lastProgressAt 不推进 ⇒ 超过阈值即"卡住"', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev('assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 10 } }, T0 + 900),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, T0 + 950),
  ])
  const view = toView(state, {})
  assert.equal(view.lastProgressAt, T0 + 900)

  // 以"上一次真正有进展的时刻"为基准：阈值两侧各差 1ms。
  const justUnder = view.lastProgressAt + view.noProgressMs
  const justOver = view.lastProgressAt + view.noProgressMs + 1
  assert.equal(justUnder - view.lastProgressAt > view.noProgressMs, false)
  assert.equal(justOver - view.lastProgressAt > view.noProgressMs, true)

  // 配置可覆盖阈值
  assert.equal(toView(state, { noProgressMs: 5000 }).noProgressMs, 5000)
})

test('token 与缓存命中率：本步/本轮累加，命中率 = cacheRead /(input+cacheRead+cacheWrite)', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev(
      'assistant/message',
      { turn: 1, step: 1, message: {}, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 710, cacheWriteTokens: 190 } },
      T0 + 10,
    ),
    ev(
      'assistant/message',
      { turn: 1, step: 2, message: {}, usage: { inputTokens: 200, outputTokens: 50, cacheReadTokens: 1800, cacheWriteTokens: 0 } },
      T0 + 20,
    ),
  ])
  const view = toView(state, {})
  assert.equal(view.stepTokens, 250, '本步 token 只算最近一步')
  assert.equal(view.turnTokens, 1350, '本轮 token 累加 input+output')
  assert.equal(view.hitRate, 1800 / 2000, '命中率只取最近一步')
})

test('阶段迁移全表：审批 / 压缩 / 重试 / 收尾都能回到正确阶段', () => {
  let state = fold([ev('turn/start', { turn: 1 }, T0), ev('step/start', { turn: 1, step: 1 }, T0 + 1)])
  assert.equal(state.phase, PHASES.ASSEMBLING)

  state = applyEvent(state, ev('request/header', { header: {} }, T0 + 2))
  assert.equal(state.phase, PHASES.REQUESTING)

  state = applyEvent(state, ev('approval/asked', { requestId: 'r1' }, T0 + 3))
  assert.equal(state.phase, PHASES.APPROVAL)
  assert.equal(toView(state, {}).approvals, 1)

  state = applyEvent(state, ev('approval/decided', { requestId: 'r1' }, T0 + 4))
  assert.equal(state.phase, PHASES.REQUESTING)

  state = applyEvent(state, ev('compaction/start', {}, T0 + 5))
  assert.equal(state.phase, PHASES.COMPACTING)
  state = applyEvent(state, ev('compaction/end', {}, T0 + 6))
  assert.equal(state.phase, PHASES.REQUESTING)

  state = applyEvent(state, ev('llm/retry-started', { attempt: 2 }, T0 + 7))
  assert.equal(toView(state, {}).retries, 1)

  state = applyEvent(state, ev('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{}' }, T0 + 8))
  assert.equal(state.phase, PHASES.TOOL)
  state = applyEvent(state, ev('approval/asked', { requestId: 'r2' }, T0 + 9))
  state = applyEvent(state, ev('approval/decided', { requestId: 'r2' }, T0 + 10))
  assert.equal(state.phase, PHASES.TOOL, '工具没结算，审批完必须回到 tool 而不是 requesting')

  state = applyEvent(state, ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 11))
  assert.equal(state.phase, PHASES.REQUESTING)

  state = applyEvent(state, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 12))
  assert.equal(state.phase, PHASES.IDLE)
  assert.equal(toView(state, {}).busy, false)
})

test('instrument 防御：半个脏事件不能把状态条打成 NaN', () => {
  const state = fold([
    ev('turn/start', { turn: 'x' }, undefined),
    ev('tool/call', { turn: 1, step: 1, name: 42 }, null),
    ev('assistant/message', { usage: { inputTokens: 'lots' } }, 5),
  ])
  const view = toView(state, null)
  assert.equal(view.turn, 1, 'tool/call 能自愈被脏 turn/start 丢掉的信息')
  assert.equal(view.tool, null, '非字符串工具名不写进 tool')
  assert.equal(view.phase, PHASES.REQUESTING)
  assert.equal(Number.isFinite(view.turnTokens), true)
  assert.doesNotThrow(() => JSON.stringify(view))
  assert.deepEqual(Object.values(view).filter((value) => value === undefined), [], 'wire 视图不许有 undefined 字段')
})

test('wire 视图自描述版本号与宿主 stateVersion 一致', () => {
  assert.equal(TURBO_STATE_VERSION, 13)
  assert.equal(toView(initState(), {}).v, TURBO_STATE_VERSION)
})

test('B1 证据：request/header 里实际发出的推理档位进入视图（这是"真的降档了"的权威来源）', () => {
  const header = (effort) => ({
    type: 'request/header',
    time: 1000,
    data: { header: { config: { provider: 'deepseek', model: 'v4-flash', reasoningEffort: effort } } },
  })

  let state = applyEvent(initState(), header('high'))
  assert.equal(toView(state, {}).effort, 'high', '必须如实反映日志里那个值')

  // B1 降档后下一次请求头会带上更低的档位 —— 视图要跟着变，否则界面上看不见换挡。
  const lowered = applyEvent(state, header('low'))
  assert.notEqual(lowered, state, '档位变了必须产生新状态（否则下游不会重绘）')
  assert.equal(toView(lowered, {}).effort, 'low')

  // 同一个档位的重复请求头（重试/续跑）不该产生无谓的新状态。
  assert.equal(applyEvent(lowered, header('low')), lowered, '档位没变时保持同一引用')

  // 该路由没有档位概念时显示为空，而不是残留上一个模型的档位。
  state = applyEvent(lowered, { type: 'request/header', time: 2000, data: { header: { config: { provider: 'x', model: 'y' } } } })
  assert.equal(toView(state, {}).effort, null)

  // 脏事件不能把档位搞成非字符串。
  state = applyEvent(state, { type: 'request/header', time: 3000, data: { header: { config: { reasoningEffort: 42 } } } })
  assert.equal(toView(state, {}).effort, null)
  assert.doesNotThrow(() => JSON.stringify(toView(state, {})))
})

test('B1 之外的字段没被顺带改动：新增 effort 后 wire 视图仍无 undefined、仍可 JSON 序列化', () => {
  const view = toView(initState(), {})
  assert.equal(view.effort, null, '初始态该是 null 而不是 undefined')
  assert.deepEqual(Object.values(view).filter((value) => value === undefined), [])
  assert.doesNotThrow(() => JSON.stringify(view))
})

// ──────────────────────── v2/v3/v4/v5/v6/v7 契约（TURBO_STATE_VERSION = 7） ────────────────────────

/** v1 的 19 个键：v2 必须逐字不变，且仍排在前面。 */
const V1_VIEW_KEYS = [
  'v',
  'phase',
  'phaseStartedAt',
  'turnStartedAt',
  'stepStartedAt',
  'lastProgressAt',
  'turn',
  'step',
  'tool',
  'toolStartedAt',
  'stepTokens',
  'turnTokens',
  'effort',
  'hitRate',
  'toolCalls',
  'retries',
  'approvals',
  'busy',
  'noProgressMs',
]

/** v2 追加的 9 个键，顺序即契约。 */
const V2_VIEW_KEYS = [
  'mountStatus',
  'prefixEpoch',
  'prefixCause',
  'prefixAt',
  'lastTurnMs',
  'topTools',
  'hookFaults',
  'idleLine',
  'lastSpill',
]

/** v3（0.6.0 内容层）追加的 1 个键。 */
const V3_VIEW_KEYS = ['activity']

/** v4（0.6.1 等待态）追加的 3 个键。 */
const V4_VIEW_KEYS = ['waitTools', 'waitKind', 'subagents']

/** v5（0.6.3 诊断层）追加的 1 个键。 */
const V5_VIEW_KEYS = ['slowMs']

/** v6（0.6.4「缺席 ≠ 故障」）追加的 1 个键：可选增强层是否在位。v7 只在该对象内追加 `mode`，键数不变。 */
const V6_VIEW_KEYS = ['enhancement']
/** v8（0.7.0 交接文档自动导出）追加的 `handoff` + v9（0.8.0 到量轮换）追加的 `rotation`。v10 只在 `rotation` 对象内加字段，顶层键数不变。 */
const V9_VIEW_KEYS = ['handoff', 'rotation']
/** v11（0.10.0 房间与任务板）追加 `room`、v12（0.13.0 编队）追加 `fleet`；v13（0.18.0）把这两个键整块删除。 */
const V11_V12_REMOVED_KEYS = ['room', 'fleet']
/** v13（0.18.0 新会话）追加 `newSession`：可直接复制粘贴的开场话术。与删掉 `room`/`fleet` 同版。 */
const V13_VIEW_KEYS = ['newSession']

test('P0-1 死开关：statusBar 投影成 wire 的 mountStatus，非法值一律 enabled', () => {
  assert.equal(toView(initState(), {}).mountStatus, 'enabled')
  assert.equal(toView(initState(), { statusBar: true }).mountStatus, 'enabled')
  assert.equal(toView(initState(), { statusBar: false }).mountStatus, 'disabled', '只有显式 false 才关掉')
  assert.equal(toView(initState(), { statusBar: 'no' }).mountStatus, 'enabled', '非法值回落 enabled，不抛错')
  assert.equal(toView(initState(), { statusBar: 0 }).mountStatus, 'enabled')
  assert.equal(toView(initState(), null).mountStatus, 'enabled')
})

test('wire v13：恰好 37 键，v1 的 19 键 / v2 的 9 键 / v3 的 1 键 / v4 的 3 键 / v5 的 1 键逐字不变且仍排在前面', () => {
  const view = toView(initState(), {})
  assert.deepEqual(Object.keys(view), [
    ...V1_VIEW_KEYS,
    ...V2_VIEW_KEYS,
    ...V3_VIEW_KEYS,
    ...V4_VIEW_KEYS,
    ...V5_VIEW_KEYS,
    ...V6_VIEW_KEYS,
    ...V9_VIEW_KEYS,
    ...V13_VIEW_KEYS,
  ])
  for (const key of V11_V12_REMOVED_KEYS) {
    assert.equal(key in view, false, `v13 必须删掉 v11/v12 的 ${key}`)
  }
  assert.equal(Object.keys(view).length, 37, 'v13 删掉 room 与 fleet、加上 newSession')
  assert.equal(view.v, 13)
})

test('wire v13 新会话话术：{old} / {cwd} 被填成本会话，模板可配，缺配置回落默认', () => {
  const state = initState({ id: 'session-abc', cwd: 'D:\\project\\x' })
  const view = toView(state, {})
  assert.equal(view.newSession.oldId, 'session-abc')
  assert.equal(view.newSession.cwd, 'D:\\project\\x')
  assert.ok(view.newSession.text.includes('session-abc'), '话术里带旧会话 id')
  assert.ok(view.newSession.text.includes('D:\\project\\x'), '话术里带工作目录')
  const custom = toView(state, { rotationSeedMessage: '读 {old}（{cwd}）{unknown}' })
  assert.equal(custom.newSession.text, '读 session-abc（D:\\project\\x）{unknown}', '未知占位符原样保留')
  assert.equal(toView(state, { rotationSeedMessage: '   ' }).newSession.text.includes('继续旧会话'), true, '空白模板回落默认')
})

test('wire v7 初始态：所有新字段全是契约默认值，没有一个是 undefined', () => {
  const view = toView(initState(), {})
  assert.equal(view.mountStatus, 'enabled')
  assert.equal(view.prefixEpoch, 0)
  assert.equal(view.prefixCause, null)
  assert.equal(view.prefixAt, null)
  assert.equal(view.lastTurnMs, null)
  assert.deepEqual(view.topTools, [])
  assert.deepEqual(view.hookFaults, [])
  assert.equal(view.idleLine, null)
  assert.equal(view.lastSpill, null)
  assert.deepEqual(view.activity, [])
  assert.deepEqual(view.waitTools, [], 'v4：等待类初始为空')
  assert.equal(view.waitKind, null, 'v4：等待态初始为 null')
  assert.equal(view.subagents, 0, 'v4：本回合派生数初始为 0')
  assert.equal(view.slowMs, 60000, 'v5：慢调用阈值默认 60000ms')
  assert.deepEqual(view.enhancement, { active: true, mode: 'host-pruner', reason: null }, 'v6：增强层缺省视为宿主 pruner 在位')
  assert.deepEqual(Object.values(view).filter((value) => value === undefined), [])
  assert.doesNotThrow(() => JSON.stringify(view))
})

test('B4 前缀作废：压缩开始/结束各记一次，原因取最近一次，turn/start 不清零', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev('compaction/start', {}, T0 + 10),
    ev('compaction/end', {}, T0 + 20),
    ev('turn/start', { turn: 2 }, T0 + 30),
  ])
  const view = toView(state, {})
  assert.equal(view.prefixEpoch, 2)
  assert.equal(view.prefixCause, 'compaction-end')
  assert.equal(view.prefixAt, T0 + 20)
})

test('B4 T3 大块注入：按 UTF-8 字节数判阈值，小结果不动前缀', () => {
  const result = (text) => ev('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } }, T0 + 5)

  assert.equal(toView(applyEvent(initState(), result('x'.repeat(32767))), {}).prefixEpoch, 0, '32767 < 32768 不触发')

  const exact = applyEvent(initState(), result('x'.repeat(32768)))
  assert.equal(toView(exact, {}).prefixEpoch, 1, '恰好等于阈值即触发')
  assert.equal(toView(exact, {}).prefixCause, 'bulk-injection')
  assert.equal(toView(exact, {}).prefixAt, T0 + 5)

  // 多字节字符按字节算：11000 个中文 = 33000 字节 > 32768；按字符数算只有 11000 就会漏判。
  assert.equal(toView(applyEvent(initState(), result('中'.repeat(11000))), {}).prefixEpoch, 1)

  // 载荷取不到（脏事件 / 无 message）时不触发，也不抛错。
  assert.equal(applyEvent(initState(), ev('tool/result', {}, T0)).prefixEpoch, 0)
  assert.equal(applyEvent(initState(), ev('tool/result', { message: { content: 'nope' } }, T0)).prefixEpoch, 0)
})

test('B4 阈值可配（applyEvent 第三参），非法值回落默认且不抛错', () => {
  const result = ev('tool/result', { message: { content: [{ type: 'text', text: 'x'.repeat(16) }] } }, T0)
  assert.equal(toView(applyEvent(initState(), result, { bulkInjectionBytes: 8 }), {}).prefixEpoch, 1)
  assert.equal(toView(applyEvent(initState(), result, { bulkInjectionBytes: 0 }), {}).prefixEpoch, 1)
  assert.equal(toView(applyEvent(initState(), result, { bulkInjectionBytes: 4096 }), {}).prefixEpoch, 0)
  assert.equal(toView(applyEvent(initState(), result, { bulkInjectionBytes: -1 }), {}).prefixEpoch, 0, '负数回落默认')
  assert.equal(toView(applyEvent(initState(), result, { bulkInjectionBytes: 'tiny' }), {}).prefixEpoch, 0)
  assert.equal(toView(applyEvent(initState(), result, null), {}).prefixEpoch, 0)
})

test('B4 脏时间戳不产 NaN：缺 time 时 prefixAt 是 null，计数照记', () => {
  const view = toView(applyEvent(initState(), { type: 'compaction/start', data: {} }), {})
  assert.equal(view.prefixEpoch, 1)
  assert.equal(view.prefixAt, null)
  assert.equal(Number.isInteger(view.prefixEpoch), true)
})

test('上回合耗时：turn/end 结算整数毫秒，孤立 turn/end 记 0，脏时间戳记 null', () => {
  const done = fold([ev('turn/start', { turn: 1 }, T0), ev('turn/end', { turn: 1 }, T0 + 12345)])
  assert.equal(toView(done, {}).lastTurnMs, 12345)
  assert.equal(Number.isInteger(toView(done, {}).lastTurnMs), true)

  assert.equal(toView(applyEvent(initState(), ev('turn/end', {}, T0)), {}).lastTurnMs, 0, '没有 turn/start 时是 0 而不是 NaN')
  assert.equal(toView(applyEvent(initState(), { type: 'turn/end', data: {} }), {}).lastTurnMs, null)
})

test('A2 topTools：按 maxMs 降序取前 5，耗时取相邻事件时间戳差，元素是新建的纯 JSON', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev('tool/call', { turn: 1, step: 1, name: 'read', arguments: '{"a":1}' }, T0 + 1000),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 1300),
    ev('tool/call', { turn: 1, step: 1, name: 'bash', arguments: '{}' }, T0 + 2000),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 2100),
    ev('tool/call', { turn: 1, step: 1, name: 'bash', arguments: '{}' }, T0 + 3000),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 3200),
    ev('tool/call', { turn: 1, step: 1, name: 'read', arguments: '{"a":2}' }, T0 + 4000),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 4010),
  ])

  const view = toView(state, {})
  assert.deepEqual(
    view.topTools.map((tool) => [tool.name, tool.count, tool.maxMs, tool.avgMs]),
    [
      ['read', 1, 300, 300],
      ['bash', 2, 200, 150],
      ['read', 1, 10, 10],
    ],
  )
  assert.equal(view.topTools[0].key.startsWith('read\u0000'), true, 'key = 工具名 + 参数指纹')
  assert.notEqual(view.topTools[0].key, view.topTools[2].key, '同名但参数不同必须是两个键')
  assert.equal(view.topTools[1].count, 2, '同参数的两次 bash 聚成一个键')

  // 视图里的对象是新建的：客户端改视图不能污染折叠状态。
  view.topTools[0].maxMs = -1
  assert.equal(toView(state, {}).topTools[0].maxMs, 300)
})

test('A2 Top-5 硬截断：第 6 慢的工具进不了视图', () => {
  const events = []
  for (let i = 0; i < 6; i += 1) {
    events.push(ev('tool/call', { turn: 1, step: 1, name: `tool${i}`, arguments: `{"i":${i}}` }, T0 + i * 1000))
    events.push(ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + i * 1000 + (i + 1) * 100))
  }
  const view = toView(fold(events), {})
  assert.equal(view.topTools.length, 5)
  assert.deepEqual(view.topTools.map((tool) => tool.name), ['tool5', 'tool4', 'tool3', 'tool2', 'tool1'])
})

test('A2 聚合表上限 200：超出后淘汰最小项，视图仍只报 Top-5', () => {
  const events = []
  for (let i = 0; i <= 200; i += 1) {
    events.push(ev('tool/call', { turn: 1, step: 1, name: `t${i}`, arguments: `{"i":${i}}` }, T0 + i * 1000))
    events.push(ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + i * 1000 + (i + 1)))
  }
  const view = toView(fold(events), {})
  assert.equal(view.topTools.length, 5)
  assert.deepEqual(view.topTools.map((tool) => tool.name), ['t200', 't199', 't198', 't197', 't196'])
})

test('A2 收尾兜底：日志缺 tool/result 时由下一次 tool/call 结算，最后一次由 turn/end 收尾', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev('tool/call', { turn: 1, step: 1, name: 'bash', arguments: '{}' }, T0 + 100),
    ev('tool/call', { turn: 1, step: 1, name: 'read', arguments: '{}' }, T0 + 400),
  ])
  const bash = toView(state, {}).topTools.find((tool) => tool.name === 'bash')
  assert.equal(bash.count, 1)
  assert.equal(bash.maxMs, 300, '300ms 来自两次 tool/call 的时间戳差')

  const ended = applyEvent(state, ev('turn/end', { turn: 1 }, T0 + 500))
  assert.equal(toView(ended, {}).topTools.find((tool) => tool.name === 'read').maxMs, 100)
})

// ─────────────────────────── 0.6.1：工具三分类 / 等待态 ───────────────────────────

test('0.6.1 分类判定纯函数：只看工具名（0.6.3 起还要看 args.wait），脏配置一律忽略、不抛错', () => {
  assert.equal(toolKindOf('bash', null, {}), 'exec')
  assert.equal(toolKindOf('wait_agent', null, {}), 'subagent', '默认 subagentWaitTools 命中')
  assert.equal(toolKindOf('ask_user_question', null, {}), 'human', '默认 humanWaitTools 命中')
  // 非字符串工具名 ⇒ exec（哪怕配置里拿它当键）。
  assert.equal(toolKindOf(null, null, {}), 'exec')
  assert.equal(toolKindOf(42, null, {}), 'exec')
  assert.equal(toolKindOf(undefined, null, {}), 'exec')
  // 自定义：human 优先于 subagent（同名同时命中两个表时）。
  assert.equal(toolKindOf('x', null, { humanWaitTools: ['x'], subagentWaitTools: ['x'] }), 'human')
  // 空数组 = 该类别不拦（不是回落默认）。
  assert.equal(toolKindOf('wait_agent', null, { subagentWaitTools: [] }), 'exec')
  // 非数组 ⇒ 回落默认。
  assert.equal(toolKindOf('wait_agent', null, { subagentWaitTools: 'wait_agent' }), 'subagent')
  // 数组里的脏元素一律忽略，不抛错。
  assert.equal(toolKindOf('wait_agent', null, { subagentWaitTools: ['wait_agent', 3, null, '', {}] }), 'subagent')
  assert.equal(toolKindOf('bash', null, { humanWaitTools: [42, null] }), 'exec')
  assert.equal(toolKindOf('bash', null, null), 'exec', 'config 为 null 时回落默认')
})

test('0.6.3 第 4 类 job：jobWaitTools 命中且 args.wait === true 才算等待', () => {
  // 默认配置：job_output / job_wait 命中。
  assert.equal(toolKindOf('job_output', { wait: true }, {}), 'job')
  assert.equal(toolKindOf('job_wait', { wait: true }, {}), 'job')
  // 同一工具名不带 wait / wait 非 true ⇒ 仍是真执行。
  assert.equal(toolKindOf('job_output', {}, {}), 'exec', '不带 wait 的快照是普通执行')
  assert.equal(toolKindOf('job_output', { wait: false }, {}), 'exec')
  assert.equal(toolKindOf('job_output', { wait: 'true' }, {}), 'exec', '只认布尔 true')
  // args 脏值（null / 非对象）⇒ exec，绝不抛错。
  assert.equal(toolKindOf('job_output', null, {}), 'exec')
  assert.equal(toolKindOf('job_output', undefined, {}), 'exec')
  assert.equal(toolKindOf('job_output', 42, {}), 'exec')
  assert.equal(toolKindOf('job_output', { wait: true }, null), 'job', 'config 为 null 时回落默认')
  // 空数组 = 该类别不拦；非数组 ⇒ 回落默认。
  assert.equal(toolKindOf('job_output', { wait: true }, { jobWaitTools: [] }), 'exec')
  assert.equal(toolKindOf('job_output', { wait: true }, { jobWaitTools: 'job_output' }), 'job')
})

test('0.6.1 分桶：topTools 只含 exec，waitTools 只含等待类且带 kind / sumMs', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    // 一个真执行的慢工具（500ms）。
    ev('tool/call', { turn: 1, step: 1, name: 'bash', arguments: '{"command":"ls -la"}' }, T0 + 100),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 600),
    // 一次等子代理（900ms，比 bash 慢），一次等人（2000ms，最慢）。
    ev('tool/call', { turn: 1, step: 1, name: 'wait_agent', arguments: '{}' }, T0 + 1000),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 1900),
    ev('tool/call', { turn: 1, step: 1, name: 'ask_user_question', arguments: '{}' }, T0 + 2000),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 4000),
  ])

  const view = toView(state, {})
  assert.deepEqual(view.topTools.map((tool) => tool.name), ['bash'], 'topTools 不许再被等待类霸榜')
  assert.equal(view.topTools[0].maxMs, 500)
  assert.deepEqual(view.topTools[0], {
    name: 'bash',
    key: view.topTools[0].key,
    count: 1,
    maxMs: 500,
    avgMs: 500,
    argPreview: 'ls -la',
    slow: false,
  }, '0.6.3：topTools 元素在既有 5 键上追加 argPreview / slow')

  assert.deepEqual(view.waitTools.map((tool) => [tool.name, tool.kind]), [
    ['ask_user_question', 'human'],
    ['wait_agent', 'subagent'],
  ], 'waitTools 按 maxMs 降序，且带 kind')
  assert.equal(view.waitTools[0].maxMs, 2000)
  assert.equal(view.waitTools[0].sumMs, 2000, 'sumMs 是总时长（客户端算「累计」）')
  assert.equal(view.waitTools[1].sumMs, 900)
  assert.equal(view.waitTools[0].avgMs, 2000)
  // 0.6.3：等待类元素同样带 argPreview / slow。
  assert.equal(view.waitTools[1].argPreview, '{}', 'arguments 是 "{}" ⇒ 摘要回落稳定 JSON')
  assert.equal(view.waitTools[0].slow, false)

  // 元素一律新建：改视图不能污染折叠状态。
  view.waitTools[0].maxMs = -1
  assert.equal(toView(state, {}).waitTools[0].maxMs, 2000)
  view.topTools[0].maxMs = -1
  assert.equal(toView(state, {}).topTools[0].maxMs, 500)
})

test('0.6.3 慢调用：slow 由 maxMs >= slowMs 判定，argPreview 首次结算后固定、不参与淘汰', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev('tool/call', { turn: 1, step: 1, name: 'bash', arguments: '{"command":"npm test"}' }, T0 + 100),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 70000),
    ev('tool/call', { turn: 1, step: 1, name: 'read', arguments: '{"file_path":"/tmp/a.txt"}' }, T0 + 71000),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 71100),
  ])
  const view = toView(state, {})
  const bash = view.topTools.find((tool) => tool.name === 'bash')
  const read = view.topTools.find((tool) => tool.name === 'read')
  assert.equal(bash.argPreview, 'npm test')
  assert.equal(bash.slow, true, '70000ms >= 默认 slowMs 60000 ⇒ slow')
  assert.equal(read.argPreview, '/tmp/a.txt')
  assert.equal(read.slow, false)
  assert.equal(view.slowMs, 60000)
  // 自定义阈值生效；`slow` 只是展示判据，不改变排序与淘汰判据。
  assert.equal(toView(state, { slowMs: 100 }).topTools.find((tool) => tool.name === 'read').slow, true)
  assert.deepEqual(view.topTools.map((tool) => tool.name), ['bash', 'read'])
})

test('0.6.3（C）summarizeArgs：主键优先、复用 redactArgs 脱敏、超长截断、脏输入不抛', () => {
  // 主键优先：command 先于 file_path。
  assert.equal(summarizeArgs({ file_path: '/tmp/a', command: 'ls -la' }, {}), 'ls -la')
  // 主键可以来自 JSON 字符串。
  assert.equal(summarizeArgs('{"file_path":"/tmp/b.txt"}', {}), '/tmp/b.txt')
  // 主键全不命中 ⇒ 稳定 JSON（键排序）。
  assert.equal(summarizeArgs({ foo: 1 }, {}), '{"foo":1}')
  // 脱敏：命中 redactKeys 的键值一律 `***`（含子串匹配）。
  assert.equal(summarizeArgs({ token: 'abc123' }, {}), '{"token":"***"}')
  assert.equal(summarizeArgs({ my_apiKey: 'v' }, {}), '{"my_apiKey":"***"}')
  // 正文超长截断到 140 + `…`。
  const long = summarizeArgs({ command: 'x'.repeat(200) }, {})
  assert.equal(long.length, 141)
  assert.equal(long.endsWith('…'), true)
  // 非对象 / 坏 JSON / null / undefined ⇒ null；脏值不抛。
  assert.equal(summarizeArgs('not json', {}), null)
  assert.equal(summarizeArgs('42', {}), null)
  assert.equal(summarizeArgs(null, {}), null)
  assert.equal(summarizeArgs(undefined, {}), null)
  assert.doesNotThrow(() => summarizeArgs({ a: undefined, f: () => {} }, {}))
})

test('0.6.3（C）argPreview 走完整管线：命中 token 的键在 wire 上就是 ***', () => {
  const state = fold([
    ev('turn/start', { turn: 1 }, T0),
    ev('tool/call', { turn: 1, step: 1, name: 'bash', arguments: '{"token":"abc123"}' }, T0 + 10),
    ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 20),
  ])
  assert.equal(toView(state, {}).topTools[0].argPreview, '{"token":"***"}')
})

test('0.6.1 waitTools 各自独立 Top-5（等待类内部排序取前 5）', () => {
  const events = []
  for (let i = 0; i < 7; i += 1) {
    events.push(ev('tool/call', { turn: 1, step: 1, name: 'wait_agent', arguments: `{"i":${i}}` }, T0 + i * 10000))
    events.push(ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + i * 10000 + (i + 1) * 100))
  }
  const view = toView(fold(events), {})
  assert.equal(view.waitTools.length, 5)
  assert.deepEqual(view.waitTools.map((tool) => tool.count), [1, 1, 1, 1, 1])
  assert.deepEqual(view.waitTools.map((tool) => tool.maxMs), [700, 600, 500, 400, 300])
  assert.deepEqual(view.topTools, [], '全是等待类 ⇒ topTools 为空')
})

test('0.6.1 waitKind：tool/call 进入、tool/result / turn/end 清除，exec 恒为 null', () => {
  let state = initState()
  assert.equal(toView(state, {}).waitKind, null, '初始为 null')

  state = applyEvent(state, ev('turn/start', { turn: 1 }, T0))
  state = applyEvent(state, ev('tool/call', { turn: 1, step: 1, name: 'wait_agent', arguments: '{}' }, T0 + 10))
  assert.equal(toView(state, {}).waitKind, 'subagent')
  state = applyEvent(state, ev('tool/result', { turn: 1, step: 1, message: {} }, T0 + 20))
  assert.equal(toView(state, {}).waitKind, null, 'tool/result 清除等待态')

  state = applyEvent(state, ev('tool/call', { turn: 1, step: 1, name: 'ask_user_question', arguments: '{}' }, T0 + 30))
  assert.equal(toView(state, {}).waitKind, 'human')
  state = applyEvent(state, ev('turn/end', { turn: 1 }, T0 + 40))
  assert.equal(toView(state, {}).waitKind, null, 'turn/end 清除等待态')

  state = applyEvent(state, ev('tool/call', { turn: 1, step: 1, name: 'bash', arguments: '{}' }, T0 + 50))
  assert.equal(toView(state, {}).waitKind, null, 'exec 工具不进入等待态')
  // 非字符串工具名也必须是 null。
  state = applyEvent(state, ev('tool/call', { turn: 1, step: 1, name: 42 }, T0 + 60))
  assert.equal(toView(state, {}).waitKind, null)
})

test('0.6.1 subagents：subagent/catalog 每次 +1，turn/start 归零；事件缺席时一直是 0', () => {
  let state = initState()
  assert.equal(toView(state, {}).subagents, 0)

  state = applyEvent(state, ev('turn/start', { turn: 1 }, T0))
  assert.equal(toView(state, {}).subagents, 0, '事件不出现 ⇒ 一直是 0（优雅降级）')

  state = applyEvent(state, ev('subagent/catalog', {}, T0 + 10))
  state = applyEvent(state, ev('subagent/catalog', {}, T0 + 20))
  assert.equal(toView(state, {}).subagents, 2)
  assert.doesNotThrow(() => JSON.stringify(toView(state, {})))

  // 脏载荷不改变计数：只做 +1，不去猜字段。
  state = applyEvent(state, ev('subagent/catalog', { count: 999, items: ['a', 'b'] }, T0 + 30))
  assert.equal(toView(state, {}).subagents, 3)

  state = applyEvent(state, ev('turn/start', { turn: 2 }, T0 + 40))
  assert.equal(toView(state, {}).subagents, 0, '新回合归零')
  assert.equal(state.waitKind, null, '新回合也重置等待态')
})

// ────────────── §3.8 非日志派生字段的送达机制（模块级 per-session 运行时表） ──────────────

test('§3.8 无条目：hookFaults 恰好 []、lastSpill 恰好 null、enhancement 恰好 {active:true,mode:host-pruner,reason:null}（不是 undefined）', () => {
  const id = 'sess-rt-empty'
  clearSessionRuntime(id)
  const view = toView(initState({ id }), {})
  assert.deepEqual(view.hookFaults, [])
  assert.equal(view.lastSpill, null)
  assert.deepEqual(view.enhancement, { active: true, mode: 'host-pruner', reason: null })
  assert.equal(Object.hasOwn(view, 'hookFaults'), true)
  assert.equal(Object.hasOwn(view, 'lastSpill'), true)
  assert.equal(Object.hasOwn(view, 'enhancement'), true)
  assert.deepEqual(Object.values(view).filter((value) => value === undefined), [])
})

test('§3.8 pushEnhancement：写入强化态、跨会话隔离、脏入参归一、缺席不是故障', () => {
  const a = 'sess-enh-a'
  const b = 'sess-enh-b'
  clearSessionRuntime(a)
  clearSessionRuntime(b)
  const stateA = initState({ id: a })
  const stateB = initState({ id: b })

  // 落盘后端缺席：只说明"未启用"，理由是 store，mode 为 off，供面板映射文案。
  pushEnhancement(a, { active: false, mode: 'off', reason: 'no ctx.spillStore backend loaded' })
  assert.deepEqual(toView(stateA, {}).enhancement, {
    active: false,
    mode: 'off',
    reason: 'no ctx.spillStore backend loaded',
  })
  assert.deepEqual(toView(stateA, {}).hookFaults, [], '缺席绝不许进 hookFaults')

  // pruner 缺席（0.6.5）：不再是"未启用"，而是在位 + 本地裁剪。
  pushEnhancement(a, { active: true, mode: 'local-trim', reason: null })
  assert.deepEqual(toView(stateA, {}).enhancement, { active: true, mode: 'local-trim', reason: null })

  // 恢复宿主 pruner 在位：整条替换，不留上一条 reason / mode。
  pushEnhancement(a, { active: true, mode: 'host-pruner', reason: null })
  assert.deepEqual(toView(stateA, {}).enhancement, { active: true, mode: 'host-pruner', reason: null })

  // 跨会话隔离。
  assert.deepEqual(toView(stateB, {}).enhancement, { active: true, mode: 'host-pruner', reason: null })

  // 快照是副本：改 wire 不改表。
  const snapshot = toView(stateA, {})
  snapshot.enhancement.active = false
  assert.equal(toView(stateA, {}).enhancement.active, true)

  // 脏入参不抛，且归一成确定形状（未知 mode 回落 host-pruner）。
  assert.doesNotThrow(() => pushEnhancement(a, null))
  assert.deepEqual(toView(stateA, {}).enhancement, { active: true, mode: 'host-pruner', reason: null })
  pushEnhancement(a, { active: 'no', mode: 'nonsense', reason: 42 })
  assert.deepEqual(toView(stateA, {}).enhancement, { active: true, mode: 'host-pruner', reason: null })
  pushEnhancement(a, { active: false, mode: 'off', reason: '' })
  assert.deepEqual(toView(stateA, {}).enhancement, { active: false, mode: 'off', reason: null })
  assert.doesNotThrow(() => pushEnhancement(null, { active: false }))
  clearSessionRuntime(a)
  assert.deepEqual(toView(stateA, {}).enhancement, { active: true, mode: 'host-pruner', reason: null })
})

test('§3.8 身份：initState(header) 存 header.id，缺省 ⇒ null；applyEvent 永不改它', () => {
  assert.equal(initState().sessionId, null, '不传 header 必须仍然可调用（tools/replay-log.mjs 也用）')
  assert.equal(initState(null).sessionId, null)
  assert.equal(initState({}).sessionId, null)
  assert.equal(initState({ id: '' }).sessionId, null)
  assert.equal(initState({ id: 'sess-1' }).sessionId, 'sess-1')

  const state = initState({ id: 'sess-1' })
  const after = applyEvent(state, ev('turn/start', { turn: 1 }, T0))
  assert.equal(after.sessionId, 'sess-1', 'applyEvent 不碰 sessionId')
  assert.equal(applyEvent(state, ev('todo/write', {}, T0)), state, '不关心的事件仍返回同一引用')

  // 无名会话（旧调用点）也必须字段确定、不抛。
  assert.deepEqual(toView(initState(), {}).hookFaults, [])
  assert.equal(toView(initState(), {}).lastSpill, null)
})

test('§3.8 pushHookFault：FIFO 上限 8、最新在前、元素一律新建副本', () => {
  const id = 'sess-rt-fifo'
  clearSessionRuntime(id)
  const state = initState({ id })
  for (let i = 0; i < 10; i += 1) pushHookFault(id, { at: T0 + i, hook: 'spill', message: `f${i}` })

  const view = toView(state, {})
  assert.equal(view.hookFaults.length, 8)
  assert.deepEqual(view.hookFaults[0], { at: T0 + 9, hook: 'spill', message: 'f9' })
  assert.deepEqual(view.hookFaults[7], { at: T0 + 2, hook: 'spill', message: 'f2' })

  // wire 是副本：客户端改视图不污染表。
  view.hookFaults[0].message = 'tampered'
  assert.equal(toView(state, {}).hookFaults[0].message, 'f9')

  // 表里的元素也是副本：调用方 push 后再改自己的对象，不影响已入表的那条。
  const fault = { at: T0 + 100, hook: 'notes', message: 'orig' }
  pushHookFault(id, fault)
  fault.message = 'mutated-after-push'
  assert.equal(toView(state, {}).hookFaults[0].message, 'orig')
})

test('§3.8 pushHookFault 防御：Error 取 message、缺 hook 名回落 unknown、脏入参不抛', () => {
  const id = 'sess-rt-dirty'
  clearSessionRuntime(id)
  const state = initState({ id })

  pushHookFault(id, { hook: 'notes', error: new Error('boom') })
  assert.equal(toView(state, {}).hookFaults[0].message, 'boom')
  assert.equal(Number.isFinite(toView(state, {}).hookFaults[0].at), true, 'at 缺失时回落确定数字')

  pushHookFault(id, { message: 'no hook name' })
  assert.equal(toView(state, {}).hookFaults[0].hook, 'unknown')

  assert.doesNotThrow(() => pushHookFault(id, null))
  assert.doesNotThrow(() => pushHookFault(null, { hook: 'x' }))
  assert.doesNotThrow(() => pushHookFault(undefined, { hook: 'x' }))
  assert.doesNotThrow(() => clearSessionRuntime(id))
  assert.doesNotThrow(() => JSON.stringify(toView(state, {})))
  assert.deepEqual(Object.values(toView(state, {})).filter((value) => value === undefined), [])
})

test('§3.8 pushSpill：整条替换 lastSpill、元素是副本、跨会话不串味', () => {
  const a = 'sess-spill-a'
  const b = 'sess-spill-b'
  clearSessionRuntime(a)
  clearSessionRuntime(b)
  const stateA = initState({ id: a })
  const stateB = initState({ id: b })

  assert.equal(toView(stateA, {}).lastSpill, null)
  pushSpill(a, { bytes: 10, locator: 'D:/t/x.txt', at: T0 })
  assert.deepEqual(toView(stateA, {}).lastSpill, { bytes: 10, locator: 'D:/t/x.txt', at: T0 })

  // 整条替换：第二次调用不带上一条的残留。
  pushSpill(a, { bytes: 20, locator: 'D:/t/y.txt', at: T0 + 1 })
  assert.deepEqual(toView(stateA, {}).lastSpill, { bytes: 20, locator: 'D:/t/y.txt', at: T0 + 1 })

  // 副本：改 wire 不改表。
  const snapshot = toView(stateA, {})
  snapshot.lastSpill.bytes = -1
  assert.equal(toView(stateA, {}).lastSpill.bytes, 20)

  // 跨会话隔离：b 没有条目，字段仍是确定值。
  assert.equal(toView(stateB, {}).lastSpill, null)
  assert.deepEqual(toView(stateB, {}).hookFaults, [])
  assert.doesNotThrow(() => pushSpill('sess-spill-c', null))

  // clearSessionRuntime 之后回到"无条目"的确定值。
  clearSessionRuntime(a)
  assert.deepEqual(toView(stateA, {}).hookFaults, [])
  assert.equal(toView(stateA, {}).lastSpill, null)
})

test('§3.8 不假装折叠：initState / applyEvent 都不产出 hookFaults / lastSpill / enhancement 键', () => {
  assert.equal(Object.hasOwn(initState({ id: 'sess-no-fold' }), 'hookFaults'), false)
  assert.equal(Object.hasOwn(initState({ id: 'sess-no-fold' }), 'lastSpill'), false)
  assert.equal(Object.hasOwn(initState({ id: 'sess-no-fold' }), 'enhancement'), false)

  const cases = [
    ev('turn/start', { turn: 1 }, T0),
    ev('step/start', { turn: 1, step: 1 }, T0 + 1),
    ev('request/header', { header: { config: { reasoningEffort: 'low' } } }, T0 + 2),
    ev('assistant/attempt', {}, T0 + 3),
    ev('assistant/message', { usage: { inputTokens: 1, outputTokens: 1 } }, T0 + 4),
    ev('tool/call', { name: 'bash', arguments: '{}' }, T0 + 5),
    ev('tool/result', { message: { content: [{ type: 'text', text: 'x' }] } }, T0 + 6),
    ev('approval/asked', {}, T0 + 7),
    ev('approval/decided', {}, T0 + 8),
    ev('compaction/start', {}, T0 + 9),
    ev('compaction/end', {}, T0 + 10),
    ev('llm/retry-started', {}, T0 + 11),
    ev('user/message', {}, T0 + 12),
    ev('turn/end', { turn: 1 }, T0 + 13),
    ev('todo/write', { todos: [] }, T0 + 14),
  ]
  for (const event of cases) {
    const next = applyEvent(initState({ id: 'sess-no-fold' }), event)
    assert.equal(Object.hasOwn(next, 'hookFaults'), false, `${event.type} 不得写出 hookFaults`)
    assert.equal(Object.hasOwn(next, 'lastSpill'), false, `${event.type} 不得写出 lastSpill`)
    assert.equal(Object.hasOwn(next, 'enhancement'), false, `${event.type} 不得写出 enhancement`)
  }
})

test('§34/§35 漂移机检：lib/notes.js 的兜底常量与 DEFAULT_CONFIG 同名默认值逐字相等', () => {
  assert.equal(DEFAULT_MOJIBAKE_MIN_RUNS, DEFAULT_CONFIG.mojibakeMinRuns)
  assert.equal(EVIDENCE_DEFAULT_PATTERNS.length, DEFAULT_CONFIG.evidenceWhitelist.length)
  // RegExp 会把标志位按字母序归一（'mi' → 'im'），所以比标志位集合。
  const flagSet = (flags) => [...flags].sort().join('')
  for (let i = 0; i < DEFAULT_CONFIG.evidenceWhitelist.length; i += 1) {
    const literal = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(DEFAULT_CONFIG.evidenceWhitelist[i])
    assert.notEqual(literal, null, `evidenceWhitelist[${i}] 必须是正则字面量字符串`)
    assert.equal(EVIDENCE_DEFAULT_PATTERNS[i].source, literal[1], `evidenceWhitelist[${i}] source 漂移`)
    assert.equal(flagSet(EVIDENCE_DEFAULT_PATTERNS[i].flags), flagSet(literal[2]), `evidenceWhitelist[${i}] flags 漂移`)
  }
})

// ─────────────────────────── 0.6.0 内容层：活动流（wire v3） ───────────────────────────

/** `assistant/message` 的形状：content[] 里第一条 `type === 'reasoning'` 才是思考。 */
const reasonMsg = (text) => ({ message: { content: [{ type: 'reasoning', text }] }, usage: {} })

test('0.6.0 活动流：assistant/message 的 reasoning 进活动流，reasoningChars 截断', () => {
  const long = 'x'.repeat(1000)
  const state = fold([ev('assistant/message', reasonMsg(long), T0 + 10)])
  const entry = toView(state, {}).activity[0]
  assert.equal(toView(state, {}).activity.length, 1)
  assert.equal(entry.kind, 'reason')
  assert.equal(entry.t, T0 + 10, '时间戳原样带上，客户端靠它排倒序')
  assert.equal(entry.text.length, DEFAULT_CONFIG.reasoningChars, '默认截到 reasoningChars')

  // 配置可覆盖；字符数是上限而不是补齐。
  const custom = applyEvent(initState(), ev('assistant/message', reasonMsg(long), T0), { reasoningChars: 5 })
  assert.equal(toView(custom, {}).activity[0].text, 'xxxxx')
})

test('0.6.0 活动流：没有 reasoning 的 assistant/message 不产生条目', () => {
  const state = applyEvent(initState(), ev('assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } }, T0))
  assert.deepEqual(toView(state, {}).activity, [])
})

test('0.6.0 活动流：tool/call 的参数先脱敏再上屏（大小写不敏感 / 子串 / 嵌套 / 循环引用不炸）', () => {
  const circular = { name: 'x' }
  circular.self = circular
  const args = {
    Authorization: 'Bearer abc',
    user_apiKey: 'k',
    nested: { Password: 'p', safe: 'ok' },
    circular,
    long: 'y'.repeat(500),
  }
  const state = applyEvent(initState(), ev('tool/call', { name: 'http', arguments: args }, T0))
  const entry = toView(state, {}).activity[0]
  assert.equal(entry.kind, 'call')
  assert.equal(entry.name, 'http')
  assert.equal(entry.args.Authorization, '***', '大小写不敏感地命中 authorization')
  assert.equal(entry.args.user_apiKey, '***', '子串匹配 apikey / key')
  assert.equal(entry.args.nested.Password, '***', '递归进嵌套对象')
  assert.equal(entry.args.nested.safe, 'ok', '没命中的键原样保留')
  assert.equal(entry.args.circular.self, '[Circular]', '循环引用降级，不许抛错')
  assert.equal(entry.args.long.length, 200, '超长字符串截断')
  assert.doesNotThrow(() => JSON.stringify(toView(state, {})))
})

test('0.6.0 活动流：redactKeys 可配置，自定义键同样脱敏', () => {
  const state = applyEvent(initState(), ev('tool/call', { name: 'x', arguments: { myDSN: 'pg://', safe: 1 } }, T0), {
    redactKeys: ['myDsn'],
  })
  const entry = toView(state, {}).activity[0]
  assert.equal(entry.args.myDSN, '***')
  assert.equal(entry.args.safe, 1)
})

test('0.6.0 活动流：tool/result 记 ok / 首行数（resultHeadLines），报错走 error', () => {
  const ok = fold([
    ev('tool/call', { name: 'read', arguments: '{}' }, T0),
    ev('tool/result', { message: { content: [{ type: 'text', text: 'l1\nl2\nl3\nl4\nl5\nl6\nl7' }] } }, T0 + 1),
  ])
  const okEntry = toView(ok, {}).activity.at(-1)
  assert.equal(okEntry.kind, 'result')
  assert.equal(okEntry.ok, true)
  assert.equal(okEntry.head, 'l1\nl2\nl3\nl4\nl5\nl6')
  assert.equal(okEntry.head.split('\n').length, DEFAULT_CONFIG.resultHeadLines)

  const bad = fold([
    ev('tool/call', { name: 'read', arguments: '{}' }, T0),
    ev('tool/result', { error: 'boom\nline2' }, T0 + 2),
  ])
  const badEntry = toView(bad, {}).activity.at(-1)
  assert.equal(badEntry.ok, false)
  assert.equal(badEntry.head, 'boom\nline2')
})

test('0.6.0 活动流：turn/end 记 reason（裸字符串或 { kind } 都认）', () => {
  const s1 = fold([ev('turn/start', { turn: 1 }, T0), ev('turn/end', { turn: 1, reason: 'stop' }, T0 + 5)])
  assert.deepEqual(toView(s1, {}).activity.at(-1), { t: T0 + 5, kind: 'turnEnd', reason: 'stop' })

  const s2 = fold([ev('turn/start', { turn: 1 }, T0), ev('turn/end', { turn: 1, reason: { kind: 'max-steps' } }, T0 + 6)])
  assert.equal(toView(s2, {}).activity.at(-1).reason, 'max-steps')

  const s3 = fold([ev('turn/start', { turn: 1 }, T0), ev('turn/end', { turn: 1 }, T0 + 7)])
  assert.equal(toView(s3, {}).activity.at(-1).reason, null, '拿不到原因就是 null，不许 undefined')
})

test('0.6.0 活动流环缓冲：条数上限 activityLimit，超出从头部丢', () => {
  let state = initState()
  for (let i = 0; i < 30; i += 1) state = applyEvent(state, ev('tool/call', { name: 'bash', arguments: { i } }, T0 + i))
  const activity = toView(state, {}).activity
  assert.equal(activity.length, DEFAULT_CONFIG.activityLimit)
  assert.equal(activity[0].args.i, 30 - DEFAULT_CONFIG.activityLimit, '最老的被丢掉')
  assert.equal(activity.at(-1).args.i, 29, '最新的永远在尾部')

  // 配置可收紧条数。
  let tight = initState()
  const small = { activityLimit: 3, activityBytes: DEFAULT_CONFIG.activityBytes }
  for (let i = 0; i < 10; i += 1) tight = applyEvent(tight, ev('tool/call', { name: 'bash', arguments: { i } }, T0 + i), small)
  assert.deepEqual(toView(tight, {}).activity.map((entry) => entry.args.i), [7, 8, 9])
})

test('0.6.0 活动流环缓冲：字节上限 activityBytes，超了继续从头部丢', () => {
  let state = initState()
  for (let i = 0; i < 40; i += 1) {
    state = applyEvent(state, ev('assistant/message', reasonMsg(`${String(i).padStart(4, '0')}${'z'.repeat(300)}`), T0 + i))
  }
  const activity = toView(state, { reasoningChars: 300 }).activity
  const bytes = activity.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0)
  assert.equal(bytes <= DEFAULT_CONFIG.activityBytes, true, `总字节必须被压在 activityBytes 内（实际 ${bytes}）`)
  assert.equal(activity.length < 40, true, '40 条必须被淘汰掉一部分')
  assert.equal(activity.at(-1).text.startsWith('0039'), true, '最新一条仍在')
})

test('0.6.0 活动流：单条自身超字节上限时至少保留这最新一条', () => {
  const state = applyEvent(initState(), ev('assistant/message', reasonMsg('y'.repeat(400)), T0), {
    reasoningChars: 400,
    activityBytes: 10,
  })
  assert.equal(toView(state, {}).activity.length, 1)
})

test('0.6.0 活动流：活动没变时 toView 返回同一个 activity 数组引用（下游可 Object.is 跳过）', () => {
  let state = fold([ev('tool/call', { name: 'bash', arguments: {} }, T0)])
  const a = toView(state, {})
  const b = toView(state, {})
  assert.equal(a.activity, b.activity, '同一个 state ⇒ 同一个数组引用，不许每次复制')

  const ignored = applyEvent(state, ev('todo/write', { todos: [] }, T0 + 1))
  assert.equal(ignored, state, '不关心的事件必须保持同一个 state 引用')
  assert.equal(toView(ignored, {}).activity, a.activity)
})

test('0.6.0 活动流：pushActivity 只在真的追加时才换新数组（纯函数，不改入参）', () => {
  const state = initState()
  const next = pushActivity(state, { t: T0, kind: 'turnEnd', reason: null }, {})
  assert.notEqual(next, state)
  assert.notEqual(next.activity, state.activity)
  assert.deepEqual(state.activity, [], '入参 state 不被就地修改')
  assert.deepEqual(next.activity, [{ t: T0, kind: 'turnEnd', reason: null }])
})

test('0.6.0 活动流：redactArgs / firstLines 是纯函数，脏输入不抛错', () => {
  const keys = DEFAULT_CONFIG.redactKeys
  assert.equal(keys.length, 11, '默认脱敏键恰好 11 个')
  assert.equal(redactArgs(null, keys), null)
  assert.equal(redactArgs(undefined, keys), null)
  assert.equal(redactArgs(42, keys), 42)
  assert.equal(redactArgs('plain', keys), 'plain')
  assert.deepEqual(redactArgs([{ SECRET: 1 }, 'x'], keys), [{ SECRET: '***' }, 'x'])
  assert.deepEqual(redactArgs({ a: { b: { c: { d: { e: 1 } } } } }, keys), { a: { b: { c: '[Circular]' } } }, '深度上限 3')

  assert.equal(firstLines(undefined, 3), '')
  assert.equal(firstLines(null, 3), '')
  assert.equal(firstLines('a\nb\nc\nd', 2), 'a\nb')
  assert.equal(firstLines('a\nb\nc', 0), 'a\nb\nc', '非法行数回落默认 6 行')
  assert.equal(firstLines({ content: [{ text: 'x' }, { text: 'y' }] }, 6), 'x\ny', '对象形状走 content[]')
})
