/**
 * dsh-status-turbo —— 0.9.0「到量轮换」（方案 B）的单元测试。
 *
 * 判据是纯函数（`./rotation.js`），动作是**注入了假 I/O** 的宿主函数（`./rotation-host.js`）：
 * 一次真的 fork、真的建会话、真的归档都不会发生；这里测的是
 * 「什么时候该做」「宿主动作按什么形状调服务」「任何 I/O 失败都只落成记录、绝不外抛」，
 * 以及「记录怎么合并 / 怎么进 wire」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROTATION_MESSAGE, ROTATION_STATUS, increasedRotationTitle, rotationIncreaseTitleEnabled, rotationMode, rotationPlan, rotationSeedText, shouldRotate } from '../lib/rotation.js'
import { newChildId, runRotationAction } from '../lib/rotation-host.js'
import {
  DEFAULT_CONFIG,
  accountPayload,
  clearSessionRuntime,
  handoffStateOf,
  initState,
  laneWatermarkOf,
  payloadBytesOf,
  pushRotation,
  rehydrateRuntime,
  rotationOf,
  rotationStateOf,
  syncLedger,
  toView,
} from '../lib/state.js'

const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over })

/** 过阈值的判定输入（token 口径，默认阈值 40 万 token 级别，50 万足够）。 */
const HIT = { phase: 'idle', inputTokens: 500_000, payloadBytes: 0 }

/**
 * 假 `ctx.sessions`：只记录调用形状，不做任何真 I/O。
 *
 * @param {{create?: Function, append?: Function}} [over] 覆盖某个方法（用于注入抛错）。
 * @returns {{calls: {create: object[], append: object[]}, sessions: object}}
 */
function fakeSessions(over = {}) {
  const calls = { create: [], append: [] }
  const session = {
    append(type, data, options) {
      calls.append.push({ type, data, options })
      if (typeof over.append === 'function') over.append(type, data, options)
    },
  }
  return {
    calls,
    session,
    sessions: {
      create(id, options) {
        calls.create.push({ id, options })
        if (typeof over.create === 'function') return over.create(id, options)
        return session
      },
    },
  }
}

test('rotationMode：三值放行，其余回落默认 manual', () => {
  assert.equal(rotationMode(cfg({ rotation: 'off' })), 'off')
  assert.equal(rotationMode(cfg({ rotation: 'auto' })), 'auto')
  assert.equal(rotationMode(cfg({ rotation: 'manual' })), 'manual')
  assert.equal(rotationMode(cfg({ rotation: 'nope' })), 'auto', '非法值回落默认（0.9.1 起为 auto）')
  assert.equal(rotationMode(undefined), 'auto')
  assert.equal(rotationMode(null), 'auto')
  assert.equal(DEFAULT_CONFIG.rotation, 'auto', '0.9.1 默认 auto（用户拍板）')
})

test('shouldRotate：阈值 + 轮次边界 + 冷却，缺一不可', () => {
  const now = 10_000_000
  const base = { config: cfg({ handoffExport: true }), ...HIT, now }
  assert.equal(shouldRotate(base), true, 'token 越阈值 + idle + 从未 armed ⇒ true')

  assert.equal(shouldRotate({ ...base, config: cfg({ rotation: 'off' }) }), false, 'off 一律不做')
  // 0.9.2：默认 `rotationRequireIdle=false` ⇒ 不在轮次边界也做（建空白会话不打断正在跑的回合）。
  assert.equal(shouldRotate({ ...base, phase: 'tool' }), true, '默认不要求空闲：请求中到量也轮到它')
  assert.equal(shouldRotate({ ...base, phase: 'requesting' }), true)
  // 拧回老行为（`rotationRequireIdle: true`）时才要求轮次边界。
  const idleCfg = cfg({ handoffExport: true, rotationRequireIdle: true })
  assert.equal(shouldRotate({ ...base, config: idleCfg, phase: 'tool' }), false, '要求空闲时非轮次边界不做')
  assert.equal(shouldRotate({ ...base, config: idleCfg, phase: 'requesting' }), false)
  assert.equal(shouldRotate({ ...base, config: idleCfg }), true, '要求空闲时 HIT 的 idle 仍然过')
  assert.equal(shouldRotate({ ...base, inputTokens: 1, payloadBytes: 1 }), false, '两个口径都没到')
  assert.equal(shouldRotate({ ...base, lastArmedAt: now - 1000 }), false, '冷却期内不做')
  assert.equal(shouldRotate({ ...base, lastArmedAt: now - 700_000 }), true, '冷却过了才做')

  // 字节口径也能单独触发（token 很小）—— 0.7.4 那个口径在这里同样生效
  assert.equal(shouldRotate({ ...base, inputTokens: 1, payloadBytes: 1_800_000 }), true)
  // 窗口收紧后小窗口照样成立：128k 窗口 ⇒ token 阈值 32000（0.8.1 起 25%）
  assert.equal(shouldRotate({ ...base, inputTokens: 32_000, payloadBytes: 0, contextWindow: 128_000 }), true)
  assert.equal(shouldRotate({ ...base, inputTokens: 31_999, payloadBytes: 0, contextWindow: 128_000 }), false)
  // 脏 cooldown 回落默认值，不抛
  assert.equal(shouldRotate({ ...base, config: cfg({ rotationCooldownMs: 'x' }), lastArmedAt: now - 1000 }), false)
  assert.equal(shouldRotate({ ...base, config: cfg({ rotationCooldownMs: 0 }), lastArmedAt: now - 1 }), true, '0 是合法冷却')
  assert.equal(ROTATION_STATUS.ARMED, 'armed')
  assert.equal(ROTATION_STATUS.OFF, 'off')
  assert.equal(ROTATION_STATUS.UNAVAILABLE, 'unavailable', '0.9.0：判据过了但建不了会话 —— 缺席不是故障')
})

test('rotationPlan：0.9.0 只剩 openChild / archiveOld 两个动作，缺省取 DEFAULT_CONFIG', () => {
  assert.deepEqual(rotationPlan({}, 's1'), { sessionId: 's1', openChild: true, archiveOld: false })
  assert.deepEqual(rotationPlan(undefined, 's2'), { sessionId: 's2', openChild: true, archiveOld: false })
  assert.deepEqual(
    rotationPlan({ rotationOpenChild: false, rotationArchiveOld: true }, 's3'),
    { sessionId: 's3', openChild: false, archiveOld: true },
  )
  assert.equal(rotationPlan({ rotationArchiveOld: true }, 's4').openChild, true, '只开归档不影响切换')
  assert.equal(
    DEFAULT_CONFIG.rotationArchiveOld,
    false,
    '0.9.0 默认不归档：归档后侧边栏与 @ 引用都读不到旧会话，与「让新会话能查到它」冲突',
  )
  assert.equal(
    DEFAULT_CONFIG.rotationIncreaseTitle,
    true,
    '0.20.0：键复活 —— 空白子会话由宿主按旧会话标题 (N) 递增补名字，不 fork 也能认亲',
  )
  assert.equal(rotationIncreaseTitleEnabled({}), true, '缺省就是启用')
  assert.equal(rotationIncreaseTitleEnabled({ rotationIncreaseTitle: false }), false, '显式关掉才不改名')
  assert.equal(
    rotationIncreaseTitleEnabled({ rotationIncreaseTitle: 'yes' }),
    true,
    '非布尔值一律回落缺省（同 rotationRequireIdle 的纪律）',
  )
  assert.equal(rotationPlan({ rotationIncreaseTitle: true }, 's5').increaseTitle, undefined, '改名不是动作单上的开关，plan 仍只有两个动作')
})

test('rotationSeedText：把旧会话 id 与 cwd 塞进首条消息（0.9.0 的落点）', () => {
  const config = cfg({ rotation: 'manual' })
  const text = rotationSeedText({ config, oldId: 'session-abc', cwd: 'D:\\w' })
  assert.match(text, /session-abc/, '旧会话 id 必须出现在消息里')
  assert.match(text, /D:\\w/, '工作目录也要在')
  assert.match(text, /@session-abc/, '要告诉模型怎么去查它')
  assert.ok(!text.includes('{old}') && !text.includes('{cwd}'), '占位符必须被替换干净')

  // 自定义模板
  assert.equal(
    rotationSeedText({ config: cfg({ rotationSeedMessage: '接着 {old} 干' }), oldId: 's1', cwd: '/x' }),
    '接着 s1 干',
  )
  // 脏模板回落默认，不抛
  assert.match(rotationSeedText({ config: cfg({ rotationSeedMessage: '   ' }), oldId: 's1', cwd: '/x' }), /s1/)
  assert.match(rotationSeedText({ config: undefined, oldId: 's1' }), /s1/)
})

test('newChildId：`session-` 前缀 + UUID（零依赖，node:crypto）', () => {
  const id = newChildId()
  assert.match(id, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.notEqual(newChildId(), newChildId(), '两次生成必须不同')
})

test('宿主动作：宿主里已有本会话的子会话 ⇒ 复用最近那个，不再建第二个（S3）', () => {
  const { calls, sessions } = fakeSessions()
  const unrelated = { id: 'session-other-child', header: { parentSession: 'session-unrelated' } }
  const older = { id: 'session-forked', header: { parentSession: 'session-old' } }
  const newer = { id: 'session-newer', header: { parentSession: 'session-old' } }
  const result = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    payloadBytes: 0,
    now: 10_000_000,
    // 宿主没有「按 parentSession 查子会话」的原语；只能扫 list()（`packages/core/session/src/index.ts`）。
    sessions: { ...sessions, list: () => [unrelated, older, newer] },
  })

  assert.equal(result.status, ROTATION_STATUS.ARMED)
  assert.equal(result.childId, 'session-newer', 'list() 按创建序返回 ⇒ 取最后一个匹配（最近建的那个）')
  assert.equal(result.reused, true)
  assert.equal(calls.create.length, 0, '宿主里已经有子会话，绝不再建第二个')
  assert.equal(calls.append.length, 0, '也不往已有子会话里塞种子消息（0.21.1 起连首条也不写）')
  assert.deepEqual(result.plan, { sessionId: 'session-old', openChild: true, archiveOld: false })
})

test('宿主动作：查谱系失败（list 缺 / 抛错 / 返回非数组）⇒ 照旧去建，不因为兜底而停摆', () => {
  const variants = [
    {},
    { list: () => { throw new Error('list boom') } },
    { list: () => null },
  ]
  for (const over of variants) {
    const { calls, sessions } = fakeSessions()
    const result = runRotationAction({
      config: cfg({}),
      record: null,
      sessionId: 'session-old',
      cwd: 'D:\\project',
      phase: 'idle',
      inputTokens: 500_000,
      payloadBytes: 0,
      now: 10_000_000,
      sessions: { ...sessions, ...over },
    })
    assert.equal(result.status, ROTATION_STATUS.ARMED)
    assert.equal(result.reused, false)
  assert.equal(calls.append.length, 0, '0.21.1 起新会话保持空白：不再写开场话术')
    assert.match(result.childId, /^session-/)
    assert.equal(calls.create.length, 1)
  }
})

test('宿主动作：到量 ⇒ 建一次空白会话，不写任何消息（形状逐字段）', () => {
  const { calls, sessions } = fakeSessions()
  const now = 10_000_000
  const result = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    payloadBytes: 0,
    now,
    sessions,
  })

  assert.equal(result.status, ROTATION_STATUS.ARMED)
  assert.equal(result.at, now)
  assert.match(result.childId, /^session-/, '新 id 由宿主自己生成')
  assert.equal(result.message, null, '成功时不带失败 code')
  assert.deepEqual(result.plan, { sessionId: 'session-old', openChild: true, archiveOld: false })

  // create：新 id + meta{cwd, parentSession=旧 id}
  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].id, result.childId)
  assert.deepEqual(calls.create[0].options, { meta: { cwd: 'D:\\project', parentSession: 'session-old' } })

  // 0.21.1（用户 m08927）：不再写首条 user/message —— 新会话保持空白，话术只靠状态条「复制话术」手动带走。
  assert.equal(calls.append.length, 0, '绝不往新会话里写开场话术')

})

test('宿主动作：每个会话最多做一次 —— 记录里已有 childId 就直接返回，不再建第二个', () => {
  const { calls, sessions } = fakeSessions()
  const result = runRotationAction({
    config: cfg({}),
    record: { childId: 'session-first', status: 'armed' },
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    now: 10_000_000,
    sessions,
  })
  assert.equal(result.status, ROTATION_STATUS.IDLE)
  assert.equal(result.childId, null)
  assert.equal(result.message, null, '幂等返回不是失败')
  assert.equal(calls.create.length, 0, '一次都不该再建')
  assert.equal(calls.append.length, 0)
})

test('宿主动作：投影里没有绝对路径 cwd ⇒ 记 no-cwd，不抛、不建会话', () => {
  for (const cwd of [undefined, null, '', 'relative/dir', 'tmp\\x']) {
    const { calls, sessions } = fakeSessions()
    const result = runRotationAction({
      config: cfg({}),
      record: null,
      sessionId: 'session-old',
      cwd,
      phase: 'idle',
      inputTokens: 500_000,
      now: 10_000_000,
      sessions,
    })
    assert.equal(result.status, ROTATION_STATUS.IDLE, `cwd=${String(cwd)} 必须判不可用`)
    assert.equal(result.message, ROTATION_MESSAGE.NO_CWD)
    assert.equal(calls.create.length, 0)
  }
  // Windows 盘符与 POSIX 绝对路径都放行
  for (const cwd of ['D:\\project', 'D:/project', '/home/u/w']) {
    const { calls, sessions } = fakeSessions()
    const result = runRotationAction({
      config: cfg({}),
      record: null,
      sessionId: 'session-old',
      cwd,
      phase: 'idle',
      inputTokens: 500_000,
      now: 10_000_000,
      sessions,
    })
    assert.equal(result.status, ROTATION_STATUS.ARMED, `cwd=${cwd} 应当放行`)
    assert.equal(calls.create.length, 1)
  }
})

test('宿主动作：sessions 服务缺席 ⇒ 记 no-service；rotation off ⇒ 记 disabled', () => {
  const base = {
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    now: 10_000_000,
  }
  for (const sessions of [undefined, null, {}, { create: 'not-a-function' }]) {
    const result = runRotationAction({ ...base, config: cfg({}), sessions })
    assert.equal(result.status, ROTATION_STATUS.IDLE)
    assert.equal(result.message, ROTATION_MESSAGE.NO_SERVICE)
  }

  const { calls, sessions } = fakeSessions()
  const off = runRotationAction({ ...base, config: cfg({ rotation: 'off' }), sessions })
  assert.equal(off.status, ROTATION_STATUS.IDLE)
  assert.equal(off.message, ROTATION_MESSAGE.DISABLED)
  assert.equal(calls.create.length, 0, 'off 下绝不建会话')
})

test('宿主动作：create 抛错 ⇒ 记 create-failed，绝不外抛', () => {
  const { sessions } = fakeSessions({
    create() {
      throw new Error('session "session-x" already exists')
    },
  })
  const result = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    now: 10_000_000,
    sessions,
  })
  assert.equal(result.status, ROTATION_STATUS.IDLE)
  assert.equal(result.childId, null)
  assert.equal(result.message, ROTATION_MESSAGE.CREATE_FAILED)
})

test('宿主动作：会话对象的 append 抛错也与轮换无关（0.21.1 起根本不调 append）', () => {
  const { calls, sessions } = fakeSessions({
    append() {
      throw new Error('session event "user/message" carries non-JSON-serializable data')
    },
  })
  const result = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    now: 10_000_000,
    sessions,
  })
  assert.equal(result.status, ROTATION_STATUS.ARMED, '会话确实建出来了，不能谎报没做')
  assert.match(result.childId, /^session-/)
  assert.equal(result.message, null, '不再有「种子写入失败」这条路')
  assert.equal(calls.create.length, 1)
  assert.equal(calls.append.length, 0, 'append 一次都不该被调用')
})


test('宿主动作：create 返回的不是 Session ⇒ 照样 armed，只把补名降级，不抛', () => {
  const { calls, sessions } = fakeSessions({ create: () => ({ notASession: true }) })
  const result = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    now: 10_000_000,
    sessions,
  })
  assert.equal(result.status, ROTATION_STATUS.ARMED)
  assert.equal(result.titleOk, false, '拿不到会话对象 ⇒ 补名降级')
  assert.equal(result.message, null, '建会话本身成功了，没有失败 code')
  assert.equal(calls.append.length, 0)
})


test('宿主动作：判据未到 ⇒ idle 且不带 code（这不是失败）；id 生成器抛错 ⇒ create-failed', () => {
  const { calls, sessions } = fakeSessions()
  const quiet = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 1,
    payloadBytes: 1,
    now: 10_000_000,
    sessions,
  })
  assert.equal(quiet.status, ROTATION_STATUS.IDLE)
  assert.equal(quiet.message, null, '没到量不是失败，不该写 code')
  assert.equal(calls.create.length, 0)

  const noId = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-old',
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    now: 10_000_000,
    sessions,
    randomId: () => {
      throw new Error('no entropy')
    },
  })
  assert.equal(noId.status, ROTATION_STATUS.IDLE)
  assert.equal(noId.message, ROTATION_MESSAGE.CREATE_FAILED)
  assert.equal(calls.create.length, 0)
})

test('state 层：rotation 记录合并写入 + 进 wire（v13 恰好 37 键）', () => {
  const id = 's-rot'
  clearSessionRuntime(id)
  assert.equal(rotationStateOf(id), null)
  assert.equal(rotationOf(undefined), null)
  assert.equal(rotationOf({}), null)

  pushRotation(id, { status: 'idle', mode: 'manual', sessionId: id })
  assert.deepEqual(rotationStateOf(id), {
    status: 'idle',
    mode: 'manual',
    at: null,
    inputTokens: null,
    payloadBytes: null,
    sessionId: id,
    openChild: true,
    archiveOld: false,
    childId: null,
    message: null,
  })

  // 合并语义：只写 status/at/inputTokens/childId，mode 与 sessionId 沿用上一版
  pushRotation(id, { status: 'armed', at: 1234, inputTokens: 500_000, childId: 'session-new' })
  const armed = rotationStateOf(id)
  assert.equal(armed.status, 'armed')
  assert.equal(armed.mode, 'manual', '没写的键沿用')
  assert.equal(armed.at, 1234)
  assert.equal(armed.sessionId, id)
  assert.equal(armed.childId, 'session-new')
  assert.equal('seedOk' in armed, false, '0.21.1 起记录里不再有 seedOk 字段')
  assert.equal(armed.message, null)

  // 脏值一律回落，不抛
  pushRotation(id, { status: 'bogus', mode: 'nope', sessionId: 7, childId: '', message: 42 })
  assert.equal(rotationStateOf(id).status, 'idle', '非法 status 回落 idle')
  assert.equal(rotationStateOf(id).mode, 'manual', '非法 mode 回落 manual')
  assert.equal(rotationStateOf(id).sessionId, id, '非法 sessionId 沿用')
  assert.equal(rotationStateOf(id).childId, null, '空 childId 回落 null')
  assert.equal(rotationStateOf(id).message, null, '非法 message 回落 null')

  // 失败 code 也要能进 wire（客户端按 locale 渲染），且 `unavailable` 必须能活过归一化 ——
  // 漏在 ROTATION_STATUSES 里的那次（宿主写了、wire 里被折回 idle）面板会把原因吞掉。
  pushRotation(id, { status: ROTATION_STATUS.UNAVAILABLE, message: ROTATION_MESSAGE.NO_CWD })
  assert.equal(rotationStateOf(id).status, 'unavailable', 'unavailable 是合法状态，不许回落 idle')
  assert.equal(rotationStateOf(id).message, 'no-cwd')
  assert.equal(rotationStateOf(id).childId, null, '不可用时没有 childId')

  const view = toView(initState({ id, cwd: 'D:/w' }), {})
  assert.equal(view.v, 13, '0.18.0 把 wire 升到 v13（删掉顶层 room 与 fleet）')
  assert.equal(Object.keys(view).length, 37, 'v13：v9 起的顶层键 + 0.18.0 的 newSession（轮换字段都在同一个 rotation 键下）')
  assert.ok('rotation' in view, 'v9 起追加 rotation')
  assert.equal(view.rotation.status, 'unavailable')
  assert.equal(view.rotation.message, 'no-cwd')
  clearSessionRuntime(id)
})

/* ────────────────────── 宿主接线（lib/index.js · noteRotation） ────────────────────── */

/**
 * 把 `apply` 挂起来：`sessionProjections` 注入回调里抓住注册定义，`sessions` 用假替身。
 *
 * @param {object} sessions 假 `ctx.sessions`。
 * @param {object} [overrides] 追加/覆盖配置（例如把 `rotationRequireIdle` 拧回 `true`）。
 * @returns {Promise<object>} 注册定义。
 */
async function mountHost(sessions, overrides = {}) {
  const { apply } = await import('../lib/index.js')
  const seen = []
  apply(
    {
      inject: (requested, callback) => {
        if (requested.includes('sessionProjections')) {
          callback({ sessionProjections: { register: (definition) => seen.push(definition) } })
        }
      },
      logger: { info() {}, warn() {}, error() {} },
      sessions,
    },
    // 冷却归零：这条链路测的是「折叠里到底做了什么」，不是冷却本身。
    // 0.20.0：默认只提醒（`rotationCreate: false`），这些用例考的是**建会话**那条路，所以显式打开。
    { rotation: 'manual', rotationCreate: true, rotationCooldownMs: 0, ...overrides },
  )
  return seen[0]
}

/** 折一次「模型用了 50 万 token」（阈值 24 万）—— 此时还在请求中，边界未到。 */
const usageEvent = (time) => ({ type: 'assistant/message', data: { usage: { inputTokens: 500_000 } }, time })

test('宿主接线：折叠里真的建一次空白会话，把 childId 落进旧会话记录，且只做一次', async () => {
  const { calls, sessions } = fakeSessions()
  const definition = await mountHost(sessions)
  const id = 's-wire'
  clearSessionRuntime(id)
  const now = Date.now()
  let state = definition.init({ id, cwd: 'D:/w' })

  // ① 0.9.2 起默认不再要求"空闲"（`rotationRequireIdle: false`）：请求中到量也建 ——
  //    建一个空白会话不搬上下文、也不打断正在跑的回合，切换时机是客户端的事。
  state = definition.apply(state, usageEvent(now))
  assert.equal(calls.create.length, 1, 'rotationRequireIdle=false ⇒ 请求中到量也建会话')
  assert.deepEqual(calls.create[0].options, { meta: { cwd: 'D:/w', parentSession: id } })
  assert.equal(calls.append.length, 0, '0.21.1 起新会话保持空白：不再写第一条 user/message')

  const record = rotationStateOf(id)
  assert.equal(record.status, 'armed')
  assert.equal(record.childId, calls.create[0].id, '新会话 id 必须落进**旧**会话的记录（客户端靠它 open）')
  assert.match(record.childId, /^session-/)
  assert.equal('seedOk' in record, false, '0.21.1 起记录不再带 seedOk')
  assert.equal(record.message, null)

  // ② 再折一次：记录里已有 childId ⇒ 每个会话最多做一次。
  state = definition.apply(state, { type: 'turn/end', data: {}, time: now })
  assert.equal(calls.create.length, 1, '已有 childId ⇒ 不再建第二个')
  clearSessionRuntime(id)
})

test('宿主接线（0.20.0）：默认只提醒 —— 到量折过去只落 remind，一次会话都不建', async () => {
  const { calls, sessions } = fakeSessions()
  // 默认 `rotationCreate: false`（用户 m07554 拍板）：这一条考的就是「只提醒」那条路。
  const definition = await mountHost(sessions, { rotationCreate: false })
  const id = 's-wire-remind'
  clearSessionRuntime(id)
  const now = Date.now()
  let state = definition.init({ id, cwd: 'D:/w' })

  state = definition.apply(state, usageEvent(now))
  assert.equal(calls.create.length, 0, '只提醒 ⇒ 一次会话都不许建')
  assert.equal(calls.append.length, 0, '只提醒 ⇒ 不建会话，也不写消息')
  const record = rotationStateOf(id)
  assert.equal(record.status, 'remind', '到量要如实落成 remind，供客户端那一行显示')
  assert.equal(record.childId, null)
  assert.equal(record.mode, 'manual', 'mode 进 wire：客户端据此决定渲染按钮还是自己动手')

  // 再折一次：已经是 remind ⇒ 不重复推记录（客户端那一行不该被反复刷）。
  const again = definition.apply(state, { type: 'turn/end', data: {}, time: now })
  assert.equal(rotationStateOf(again.sessionId).status, 'remind')
  assert.equal(calls.create.length, 0)
  clearSessionRuntime(id)
})

test('宿主接线：rotationRequireIdle=true 把老行为拧回来 —— 不在轮次边界就不建', async () => {
  const { calls, sessions } = fakeSessions()
  const definition = await mountHost(sessions, { rotationRequireIdle: true })
  const id = 's-wire-idle'
  clearSessionRuntime(id)
  const now = Date.now()
  let state = definition.init({ id, cwd: 'D:/w' })

  // 请求中到量：要求空闲 ⇒ 判据不过，连记录都不写。
  state = definition.apply(state, usageEvent(now))
  assert.equal(calls.create.length, 0, 'rotationRequireIdle=true ⇒ 请求中不许建会话')
  assert.equal(rotationStateOf(id).status, 'idle')

  // turn/end ⇒ idle ⇒ 这一次才建。
  state = definition.apply(state, { type: 'turn/end', data: {}, time: now })
  assert.equal(calls.create.length, 1, '回合结束（空闲）才建')
  clearSessionRuntime(id)
})

test('state 层：水位账跨重启 —— state.ledger 再水化 + syncLedger 写回（且不进 wire）', () => {
  const id = 's-ledger'
  clearSessionRuntime(id)

  // 上一进程留下的快照（宿主持久化的是投影 state，`ledger` 就在里面）。
  const restored = {
    payloadBytes: 1_700_000,
    headerBytes: 124_000,
    payloadSeq: 42,
    laneWatermarks: { [`${id}|sub:abc`]: { inputTokens: 900_000, payloadBytes: 4_000_000 } },
    rotationChildId: 'session-old',
  }
  const state = { ...initState({ id, cwd: 'D:/w' }), ledger: restored }

  // 新进程里运行时表是空的：第一次折叠前必须再水化，否则判据看到的是 0。
  rehydrateRuntime(state)
  assert.equal(payloadBytesOf(id), 1_824_000, '恢复后的字节水位不是 0（正文累计 1.70 MB + 最新 header 124 KB）')
  assert.equal(laneWatermarkOf(id, `${id}|sub:abc`).payloadBytes, 4_000_000, '每车道水位一并恢复')
  assert.equal(rotationStateOf(id).childId, 'session-old', '终态事实恢复 ⇒「每会话一次」跨重启仍成立')
  assert.equal(rotationStateOf(id).status, 'armed', '重建的是"等客户端切过去"的 armed 形态')
  assert.equal(rotationStateOf(id).at, null, '不许编一个假的轮换时间戳')
  assert.equal('seedOk' in rotationStateOf(id), false, '0.21.1 起记录里不再有 seedOk 字段')

  // 折叠里又长了一点：账要跟着涨。若再水化没生效，这里会从 0 重新开始（只剩新加的那 1000）。
  accountPayload(id, { bytes: 1000, seq: 43 })
  const next = syncLedger(state)
  assert.equal(next.ledger.payloadBytes, 1_701_000, 'syncLedger 把折叠后的增量写回快照（正文那笔 1_700_000 + 1000）')
  assert.equal(next.ledger.rotationChildId, 'session-old', '终态事实跟着写回')
  assert.ok(!('handoff' in next.ledger) && !('rotation' in next.ledger), '整条状态记录绝不进账')
  assert.notEqual(next, state, '账变了 ⇒ 换引用（宿主据此落盘）')
  assert.equal(syncLedger(next), next, '账没变 ⇒ 同一个引用（不白写一次盘）')

  const view = toView(next, {})
  assert.equal(view.v, 13)
  assert.equal(Object.keys(view).length, 37, 'wire 仍是 37 键')
  assert.ok(!('ledger' in view), 'ledger 只进持久化 state，绝不进 wire')
  clearSessionRuntime(id)
})

test('state 层：0.9.2 旧快照里的 running / unavailable 一律不还原（否则会话跨进程永久停摆）', () => {
  const id = 's-legacy-ledger'
  clearSessionRuntime(id)

  // 0.9.2 真的会写下这两条整记录 —— 两个都不是终态，必须被当成"没导出过 / 没轮换过"。
  const restored = {
    payloadBytes: 900_000,
    headerBytes: 0,
    payloadSeq: 7,
    laneWatermarks: {},
    handoff: { status: 'unavailable', at: 1, path: null, inputTokens: null, message: 'no-cwd' },
    rotation: { status: 'armed', mode: 'auto', at: 2, childId: 'session-stale', message: null },
  }
  const state = { ...initState({ id, cwd: 'D:/w' }), ledger: restored }

  rehydrateRuntime(state)
  assert.equal(handoffStateOf(id), null, 'unavailable 不是终态 ⇒ 不还原，该会话此后仍可正常导出')
  assert.equal(rotationStateOf(id), null, '旧快照没有 rotationChildId ⇒ 不重建轮换记录')
  assert.equal(payloadBytesOf(id), 900_000, '只读新字段：水位照旧恢复，旧字段直接忽略')

  // 再折一次，本次账里不再有那两个整字段（旧字段被读一次就彻底换掉了）。
  const next = syncLedger(state)
  assert.ok(!('handoff' in next.ledger) && !('rotation' in next.ledger), 'syncLedger 写回的账只剩水位 + 终态事实')
  clearSessionRuntime(id)
})

test('宿主接线：create 抛错不外抛 —— 只落记录（unavailable）', async () => {
  const now = Date.now()

  // create 抛错 ⇒ 状态是 unavailable（缺席不是故障）+ 稳定 code。
  const boom = fakeSessions({ create: () => { throw new Error('session "x" already exists') } })
  const definition = await mountHost(boom.sessions)
  const id = 's-wire-throw'
  clearSessionRuntime(id)
  let state = definition.init({ id, cwd: 'D:/w' })
  state = definition.apply(state, usageEvent(now))
  assert.doesNotThrow(() => { state = definition.apply(state, { type: 'turn/end', data: {}, time: now }) }, '建会话抛错绝不外抛')
  assert.equal(rotationStateOf(id).status, 'unavailable')
  assert.equal(rotationStateOf(id).message, 'create-failed')
  assert.equal(rotationStateOf(id).childId, null, '没建出来就不许写 childId（客户端会拿它 open）')
  assert.equal(rotationStateOf(id).openChild, false, '没有 childId 就不许下发 openChild:true（那是让客户端 open(null)）')
  clearSessionRuntime(id)

  // append 抛错：0.21.1 起根本不调 append —— 这里只留一条反向证据。
  const seedBoom = fakeSessions({ append: () => { throw new Error('non-JSON-serializable data') } })
  const definition2 = await mountHost(seedBoom.sessions)
  const id2 = 's-wire-seed-throw'
  clearSessionRuntime(id2)
  let state2 = definition2.init({ id: id2, cwd: 'D:/w' })
  state2 = definition2.apply(state2, usageEvent(now))
  assert.doesNotThrow(() => { state2 = definition2.apply(state2, { type: 'turn/end', data: {}, time: now }) }, '不写消息 ⇒ 没有任何可抛的点')
  assert.equal(rotationStateOf(id2).status, 'armed')
  assert.equal(seedBoom.calls.append.length, 0, 'append 没被调用，也谈不上失败')
  assert.equal(rotationStateOf(id2).message, null)
  assert.match(rotationStateOf(id2).childId, /^session-/, '会话建出来了，childId 仍要落地')
  clearSessionRuntime(id2)
})


test('宿主动作：create 交出 thenable ⇒ 判成没建好（create-failed），且不留无人处理的 rejection（0.9.3）', async () => {
  // 内部会 await 的实现，从同步调用方看就是一个 thenable：`typeof === 'object'` 会把旧代码骗过去，
  // 判成"建好了"，而它的 rejection 无人 catch —— 在 Node 默认策略下直接打挂宿主进程。
  let rejected = false
  const thenable = {
    then(_onOk, onFail) {
      queueMicrotask(() => {
        rejected = true
        if (typeof onFail === 'function') onFail(new Error('async create failed'))
      })
    },
  }
  const { calls, sessions } = fakeSessions({ create: () => thenable })
  const result = runRotationAction({
    config: cfg({}),
    record: null,
    sessionId: 'session-then',
    cwd: 'D:/w',
    phase: 'idle',
    inputTokens: 500_000,
    payloadBytes: 0,
    now: 1,
    sessions,
  })

  assert.equal(result.status, ROTATION_STATUS.IDLE)
  assert.equal(result.message, ROTATION_MESSAGE.CREATE_FAILED, 'thenable 不是"建好了"')
  assert.equal(result.childId, null)
  assert.equal(calls.create.length, 1, '试过一次就算数，不许再建第二个')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(rejected, true, 'rejection 确实发生过：没有兜底这里会直接把测试进程打挂')
})

test('宿主接线：没有绝对路径 cwd ⇒ 记 unavailable + no-cwd，不建会话、不外抛', async () => {
  const now = Date.now()
  const { calls, sessions } = fakeSessions()
  const definition = await mountHost(sessions)
  const id = 's-wire-nocwd'
  clearSessionRuntime(id)
  // header 不带 cwd —— 投影里就没有绝对路径可交给 `sessions.create`（它要求绝对路径）。
  let state = definition.init({ id })
  state = definition.apply(state, usageEvent(now))
  assert.doesNotThrow(() => { state = definition.apply(state, { type: 'turn/end', data: {}, time: now }) }, '没有 cwd 绝不外抛')
  assert.equal(calls.create.length, 0, '拿不到绝对路径就一次都不许建')
  const record = rotationStateOf(id)
  assert.equal(record.status, 'unavailable', '缺席不是故障，但要如实落成 unavailable')
  assert.equal(record.message, 'no-cwd')
  assert.equal(record.childId, null)
  clearSessionRuntime(id)
})

test('increasedRotationTitle：镜像官方 fork 的 (N) 约定（0.20.0 给空白子会话补名字）', () => {
  assert.equal(increasedRotationTitle('排查轮换'), '排查轮换 (1)', '没有编号就追加 (1)')
  assert.equal(increasedRotationTitle('排查轮换 (1)'), '排查轮换 (2)', '半角括号递增')
  assert.equal(increasedRotationTitle('排查轮换 (9)'), '排查轮换 (10)', '十进制递增，不是字符串拼接')
  assert.equal(increasedRotationTitle('排查轮换（9）'), '排查轮换（10）', '全角括号保留样式')
  assert.equal(increasedRotationTitle('A (3) 尾巴'), 'A (3) 尾巴 (1)', '只有行尾的编号才算数')
  assert.equal(increasedRotationTitle(''), null, '空标题不改名')
  assert.equal(increasedRotationTitle('   '), null, '只有空白也不改名')
  assert.equal(increasedRotationTitle(null), null, '拿不到标题就不改名')
  assert.equal(increasedRotationTitle(42), null, '非字符串同样只降级')
})

test('宿主动作：改名按旧会话标题 (N) 递增；没标题 / 没服务 / 关掉了都只降级，绝不影响建会话', () => {
  const built = new Map()
  const renamed = []
  const titles = {
    get: (session) => (session !== null && session !== undefined && session.id === 'session-old' ? { title: '排查轮换 (2)', eventSeq: 7 } : null),
    rename: (session, title) => {
      renamed.push({ id: session.id, title })
      return { title, eventSeq: 8 }
    },
  }
  const sessions = {
    create: (id, options) => {
      const created = { id, options, append: () => {} }
      built.set(id, created)
      return created
    },
    list: () => [],
    get: (id) => built.get(id) ?? (id === 'session-old' ? { id: 'session-old' } : null),
  }
  const base = {
    record: null,
    cwd: 'D:\\project',
    phase: 'idle',
    inputTokens: 500_000,
    payloadBytes: 0,
    sessions,
  }

  const hit = runRotationAction({ ...base, config: cfg({}), sessionId: 'session-old', now: 10_000_000, titles })
  assert.equal(hit.status, ROTATION_STATUS.ARMED)
  assert.equal(hit.titleOk, true, '旧会话有标题 ⇒ 改名')
  assert.equal(hit.title, '排查轮换 (3)', '(N) 递增后写回')
  assert.equal(renamed.length, 1)
  assert.equal(renamed[0].id, hit.childId, '改的是子会话，不是旧会话')
  assert.equal(renamed[0].title, '排查轮换 (3)')

  const withoutTitle = runRotationAction({ ...base, config: cfg({}), sessionId: 'session-nameless', now: 10_000_001, titles })
  assert.equal(withoutTitle.status, ROTATION_STATUS.ARMED)
  assert.equal(withoutTitle.titleOk, false, '旧会话没有标题 ⇒ 跳过改名')
  assert.equal(withoutTitle.title, null)
  assert.equal(withoutTitle.titleReason, 'no-title')
  assert.notEqual(withoutTitle.childId, null, '改名失败绝不影响建会话')

  const withoutService = runRotationAction({ ...base, config: cfg({}), sessionId: 'session-old', now: 10_000_002 })
  assert.equal(withoutService.status, ROTATION_STATUS.ARMED)
  assert.equal(withoutService.titleOk, false, '没注入 sessionTitle ⇒ 只降级')
  assert.equal(withoutService.titleReason, 'no-service')

  const disabled = runRotationAction({
    ...base,
    config: cfg({ rotationIncreaseTitle: false }),
    sessionId: 'session-old',
    now: 10_000_003,
    titles,
  })
  assert.equal(disabled.status, ROTATION_STATUS.ARMED)
  assert.equal(disabled.titleOk, false, '显式关掉就不改名')
  assert.equal(disabled.titleReason, 'disabled')
})
test('宿主接线（0.21.0）：wire 的 newSession 带上会话名称与日志目录（拿不到就空串，不猜）', async () => {
  const { sessions } = fakeSessions()
  const definition = await mountHost(sessions)
  // 有工作目录：日志目录按本机约定拼成 <DSH_HOME>/sessions/<projectKey>/<id>。
  const view = definition.wire.view(definition.init({ id: 'session-demo', cwd: 'D:\\project' }), {})
  assert.equal(view.newSession.title, '', '没有 sessionTitle 服务 ⇒ 空串（客户端会省掉那一行）')
  assert.match(
    view.newSession.logDir,
    /sessions[\\/]--D-project--[\\/]session-demo$/,
    'projectKey 与 encodeSegment 必须和 dsh-session-persistence-jsonl 同一套规则',
  )
  // 没有工作目录：不猜路径，留空串。
  const noCwd = definition.wire.view(definition.init({ id: 'session-demo' }), {})
  assert.equal(noCwd.newSession.logDir, '', '没有 cwd ⇒ 不许编一个路径出来')
})
