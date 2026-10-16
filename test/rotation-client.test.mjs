/**
 * 客户端半的轮换执行体与 A/B 两条业务链（`lib/client.js`）。
 *
 * 为何单独一个文件：0.9.2 时 `openWithRetry` / `performRotation` 在测试里是 **0 次执行**，
 * 于是「auto 挂在一个默认收起的子树里⇒一句都不跑」与「结果不广播⇒永远显示正在轮换」两个
 * P0 都没被任何测试挡住。这里用假 React + 假 `sessions` / `workspaces` / `timer` 驱动真分支。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, initState, pushRotation, toView } from '../lib/state.js'

// ── 装载客户端半（与 `test/halves.test.mjs` 同一装载约定） ───────────────────────────────
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (mod) => loaded.push(mod) } }
await import('../lib/client.js')

/** 0.9.3 起 effect 里挂的就是 auto 触发点，假件必须**真的执行** effect（`useState` 的 setter 可以是空函数）。 */
const reactMock = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props !== null && typeof props === 'object' ? props : {},
      children: children.flat(Infinity),
    }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect(effect) {
    return effect()
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  Fragment: 'Fragment',
}

/** 每次调用都造一个独立实例：factory 闭包里的结果表/在飞标志本就该是新的。 */
function clientApi() {
  return loaded[0].factory((id) => {
    if (id === 'react') return reactMock
    throw new Error(`未预期的 require：${id}`)
  })
}

function makeCtx(services = {}) {
  const captured = { slotKeys: [], registrations: [], timeouts: [], locale: null }
  const ctx = {
    slots: {
      inject(key, callback) {
        captured.slotKeys.push(key)
        return callback()
      },
      register(options, component) {
        captured.registrations.push({ options, component })
        return () => {}
      },
    },
    get(name) {
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      if (name === 'locale') {
        return {
          register(ns, dict) {
            captured.locale = { ns, dict }
            return () => {}
          },
        }
      }
      if (name === 'timer') {
        return {
          timeout(fn, ms) {
            captured.timeouts.push(ms)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
  return { ctx, captured }
}

/** 用真实的投影入口造 wire 快照（不走组件替身，字段与线上一致）。 */
function wireSnapshot({ sessionId, phase = 'idle', rotation = null }) {
  const state = initState()
  state.sessionId = sessionId
  state.phase = phase
  // 宿主写记录时会把 `sessionId` 一起放进 patch（`lib/state.js:1198`），客户端靠它认领 childId 属于哪个会话。
  if (rotation !== null) pushRotation(sessionId, { ...rotation, sessionId })
  return toView(state, DEFAULT_CONFIG)
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const kids =
    Array.isArray(node.children) && node.children.length > 0
      ? node.children
      : node.props && node.props.children !== undefined
        ? [node.props.children]
        : []
  return kids.map(textOf).join('')
}

function findClickable(node) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findClickable(item)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.props && typeof node.props.onClick === 'function') return node
  return findClickable(node.children)
}

/**
 * 只驱动「切不过去」的退避重试（300ms）：其余定时器（`registerEntry` 那条 3s 挂载自检）照旧不执行，
 * 免得在一次都没有渲染的测试里刷出「条目没挂上」的假警报。
 */
const retryTimer = () => ({
  timeout(fn, ms) {
    if (ms < 1000) fn()
    return () => {}
  },
})

const armedAuto = (over = {}) => ({
  status: 'armed',
  mode: 'auto',
  at: 1700000000000,
  childId: 'session-child-1',
  openChild: true,
  archiveOld: false,
  ...over,
})

test('A：auto 的触发点在常驻状态条上 —— 收起的详情面板不再牵动它', async () => {
  const api = clientApi()
  const opened = []
  const { ctx, captured } = makeCtx({ sessions: { open: (id) => opened.push(id) } })
  api.apply(ctx)
  const statusBar = captured.registrations[0].component
  const snapshot = wireSnapshot({ sessionId: 'session-client-a', rotation: armedAuto() })

  const node = statusBar({ useProjection: () => snapshot, sessionId: 'session-client-a', t: (key) => key })
  await tick()

  assert.equal(opened.length, 1, '状态条挂上就该自动切一次')
  assert.equal(opened[0], 'session-child-1')
  assert.ok(!textOf(node).includes('状态条渲染失败'), '状态条应该真渲染出来，而不是走进 catch')

  // 反向断言：轮换那一行**自己**不再触发（0.9.2 的触发点就在这里，正是它一句都没跑）。
  api.__test.rotationSection(snapshot, (key, fallback) => fallback)
  await tick()
  assert.equal(opened.length, 1, '渲染轮换行本身不许再触发一次 auto')
})

test('E②：openWithRetry —— 同步 throw 按 500ms 退避重试，成功后 resolve(true)', async () => {
  const api = clientApi()
  const delays = []
  let calls = 0
  const sessions = {
    open() {
      calls += 1
      if (calls <= 3) throw new Error('sessions.select: unknown session')
    },
  }
  const schedule = (fn, ms) => {
    delays.push(ms)
    fn()
  }

  const opened = await api.__test.openWithRetry(sessions, 'session-child-2', { schedule })

  assert.equal(opened, true)
  assert.equal(calls, 4, '第 4 次才成功')
  assert.deepEqual(delays, [500, 500, 500], '每次退避都是 500ms（0.19.3 起默认放宽，等代理生命周期建会话 + 挂工作区）')
})

test('E②：openWithRetry —— 到重试上限就放弃（有界，不会无限重试）', async () => {
  const api = clientApi()
  let calls = 0
  let scheduled = 0
  const sessions = {
    open() {
      calls += 1
      throw new Error('一直失败')
    },
  }
  const opened = await api.__test.openWithRetry(sessions, 'session-child-3', {
    limit: 3,
    schedule: (fn) => {
      scheduled += 1
      fn()
    },
  })

  assert.equal(opened, false)
  assert.equal(calls, 3, 'limit=3 ⇒ 最多试 3 次')
  assert.equal(scheduled, 2, '第 3 次到达上限后不再排下一次')
})

test('E②：executeRotation —— 拿到服务时 open 恰好一次；失败判 ready，归档只在要求时发生', async () => {
  const api = clientApi()
  const calls = []
  const sessions = { open: (id) => calls.push(id) }
  const workspaces = { archiveSession: (id) => calls.push(`archive:${id}`) }
  const base = { sessions, workspaces, sessionId: 'session-old', childId: 'session-child-4', openChild: true }

  const done = await api.__test.executeRotation({ ...base, archiveOld: false, open: (s, id) => { s.open(id); return true } })
  assert.equal(done.status, 'done')
  assert.deepEqual(calls, ['session-child-4'], 'archiveOld=false 时不该归档')

  calls.length = 0
  const archived = await api.__test.executeRotation({ ...base, archiveOld: true, open: (s, id) => { s.open(id); return true } })
  assert.equal(archived.status, 'done')
  assert.deepEqual(calls, ['session-child-4', 'archive:session-old'], '先切过去，再归档旧的')

  const ready = await api.__test.executeRotation({ ...base, archiveOld: true, open: () => false })
  assert.equal(ready.status, 'ready')
})

test('E②：performRotation —— 拿不到 sessions 服务时一次都不调用，只记 failed/no-service', async () => {
  const api = clientApi()
  const { ctx } = makeCtx()
  api.apply(ctx)
  const snapshot = wireSnapshot({ sessionId: 'session-client-b', rotation: armedAuto({ childId: 'session-child-5' }) })

  api.__test.performRotation(snapshot)
  await tick()

  const outcome = api.__test.rotationOutcomeOf('session-client-b')
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.reason, 'no-service')
  assert.equal(outcome.childId, 'session-child-5')
})

test('E②（0.19.4）：切会话走 uiWorkspace.openSession；有它就不再碰 sessions.open', async () => {
  const api = clientApi()
  const opened = []
  const legacy = []
  const { ctx } = makeCtx({
    uiWorkspace: { openSession: (id) => opened.push(id) },
    sessions: { open: (id) => legacy.push(id) },
  })
  api.apply(ctx)
  const snapshot = wireSnapshot({ sessionId: 'session-client-d', rotation: armedAuto({ childId: 'session-child-7' }) })

  api.__test.performRotation(snapshot)
  await tick()
  await tick()

  assert.deepEqual(opened, ['session-child-7'], 'uiWorkspace.openSession 收到新会话 id')
  assert.deepEqual(legacy, [], '有正门就不该再走 sessions.open')
  const outcome = api.__test.rotationOutcomeOf('session-client-d')
  assert.equal(outcome.status, 'done', '切成功就落 done，不再是 failed/no-service')
})

test('B：结果落地会广播（状态条才有机会重渲染），force 能绕过「已有结果」的早退', async () => {
  const api = clientApi()
  let opens = 0
  const { ctx } = makeCtx({
    timer: retryTimer(),
    sessions: {
      open() {
        opens += 1
        throw new Error('sessions.select: unknown session')
      },
    },
  })
  api.apply(ctx)
  const seen = []
  api.__test.subscribeRotation(() => seen.push(opens))
  const snapshot = wireSnapshot({ sessionId: 'session-client-c', rotation: armedAuto({ childId: 'session-child-6' }) })

  api.__test.performRotation(snapshot)
  await tick()

  assert.ok(seen.length >= 2, `running → ready 至少各广播一次，实际 ${seen.length}`)
  const outcome = api.__test.rotationOutcomeOf('session-client-c')
  assert.equal(outcome.status, 'ready', 'open 一直失败 ⇒ ready（可点重试），不是死锁')

  // 不带 force：已有结果 ⇒ 早退，一次都不再调。
  const afterFirst = opens
  api.__test.performRotation(snapshot)
  await tick()
  assert.equal(opens, afterFirst, 'auto 每帧都来，不能每帧都切一次')

  // 带 force：用户点「重试」。
  await api.__test.performRotation(snapshot, { force: true })
  assert.ok(opens > afterFirst, 'force 必须绕过早退（会重走一遍整条重试链）')
})

test('B：wire 换了目标（childId / at 变了）就作废本地结果', async () => {
  const api = clientApi()
  const { ctx } = makeCtx()
  api.apply(ctx)
  const snapshot = wireSnapshot({ sessionId: 'session-client-d', rotation: armedAuto({ childId: 'session-child-7' }) })
  api.__test.performRotation(snapshot)
  await tick()
  assert.equal(api.__test.rotationOutcomeOf('session-client-d').status, 'failed')

  // 同 childId + 同 at：不许清（那是「本地结果还生效、用户还能点重试」的正常情形）。
  api.__test.syncRotationOutcome('session-client-d', 'armed', 'session-child-7', 1700000000000)
  assert.ok(api.__test.rotationOutcomeOf('session-client-d') !== null, '同一目标不许作废')

  // 宿主建了新一代新会话（at 变了）：作废，否则该会话被永久挡住。
  api.__test.syncRotationOutcome('session-client-d', 'armed', 'session-child-8', 1700000009999)
  assert.equal(api.__test.rotationOutcomeOf('session-client-d'), null)
})

test('B③：ready / failed 行可点且文案是「重试」', async () => {
  const api = clientApi()
  const { ctx } = makeCtx({
    timer: retryTimer(),
    sessions: {
      open() {
        throw new Error('sessions.select: unknown session')
      },
    },
  })
  api.apply(ctx)
  const snapshot = wireSnapshot({ sessionId: 'session-client-e', rotation: armedAuto({ childId: 'session-child-9' }) })

  api.__test.performRotation(snapshot)
  await tick()

  const node = api.__test.rotationSection(snapshot, (key, fallback) => fallback)
  const row = findClickable(node)
  assert.ok(row !== null, 'ready 那一行必须可点（0.9.2 里点不动 ⇒ 失败后永久死锁）')
  assert.match(textOf(node), /重试/)
})

/** 按 key 找那一行（`findClickable` 只给第一个可点节点，归档行是第二行）。 */
function findByKey(node, key) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findByKey(item, key)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.props && node.props.key === key) return node
  return findByKey(node.children, key)
}

test('Q2①（0.20.0）：auto 正在「等当前回合结束」时，那一行也必须可点', async () => {
  const api = clientApi()
  const opened = []
  const { ctx } = makeCtx({ sessions: { open: (id) => opened.push(id) } })
  api.apply(ctx)
  // phase 不是 idle ⇒ 落在「等当前回合结束再切」那一态（用户现场：会话永不空闲）。
  const snapshot = wireSnapshot({
    sessionId: 'session-client-q2a',
    phase: 'working',
    rotation: armedAuto({ childId: 'session-child-q2a' }),
  })

  const node = api.__test.rotationSection(snapshot, (key, fallback) => fallback)
  assert.match(textOf(node), /等当前回合结束再切/, '等待态文案还在')
  assert.match(textOf(node), /立刻切过去/, '等待态要给出路（0.20.0 起可点）')
  const row = findClickable(node)
  assert.ok(row !== null, '等待态那一行必须可点 —— 否则永不到 idle 的会话是死结')

  row.props.onClick()
  await tick()
  assert.deepEqual(opened, ['session-child-q2a'], '点它就该立刻切过去，不等这一轮跑完')
})

test('Q2①（0.20.0）：等待态多一行「切过去并归档当前会话」—— 先切后归档', async () => {
  const api = clientApi()
  const calls = []
  const { ctx } = makeCtx({
    sessions: { open: (id) => calls.push(id) },
    workspaces: { archiveSession: (id) => calls.push(`archive:${id}`) },
  })
  api.apply(ctx)
  const snapshot = wireSnapshot({
    sessionId: 'session-client-q2b',
    phase: 'working',
    rotation: armedAuto({ childId: 'session-child-q2b' }),
  })

  const node = api.__test.rotationSection(snapshot, (key, fallback) => fallback)
  const archiveRow = findByKey(node, 'rotation-archive')
  assert.ok(archiveRow !== null, 'armed 且真建出了子会话时，「切过去并归档」那一行必须在')
  assert.match(textOf(archiveRow), /归档/)

  archiveRow.props.onClick()
  await tick()
  await tick()
  assert.deepEqual(calls, ['session-child-q2b', 'archive:session-client-q2b'], '顺序契约：先切过去，再归档旧的')

  // 宿主没建出子会话（childId 空）时不该出现这一行 —— 归档不可逆，没有目标就别给按钮。
  const bare = api.__test.rotationSection(
    wireSnapshot({ sessionId: 'session-client-q2b2', phase: 'working', rotation: armedAuto({ childId: null }) }),
    (key, fallback) => fallback,
  )
  assert.equal(findByKey(bare, 'rotation-archive'), null)
})

test('Q2②（0.20.0）：performRotation 认 options.archiveOld 覆盖 wire 上的 false', async () => {
  const api = clientApi()
  const calls = []
  const { ctx } = makeCtx({
    sessions: { open: (id) => calls.push(id) },
    workspaces: { archiveSession: (id) => calls.push(`archive:${id}`) },
  })
  api.apply(ctx)
  const snapshot = wireSnapshot({
    sessionId: 'session-client-q2c',
    rotation: armedAuto({ childId: 'session-child-q2c', archiveOld: false }),
  })

  await api.__test.performRotation(snapshot, { force: true, archiveOld: true })
  await tick()
  assert.deepEqual(calls, ['session-child-q2c', 'archive:session-client-q2c'], '面板那一行点下去 = 显式要求归档')

  calls.length = 0
  await api.__test.performRotation(
    wireSnapshot({ sessionId: 'session-client-q2d', rotation: armedAuto({ childId: 'session-child-q2d', archiveOld: false }) }),
    { force: true },
  )
  await tick()
  assert.deepEqual(calls, ['session-child-q2d'], '没有显式要求就不归档（wire 上 archiveOld=false）')
})