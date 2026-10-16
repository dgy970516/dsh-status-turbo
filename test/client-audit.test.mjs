/**
 * 审计剩余项在客户端半的回归点（H4 / H5 / M1 / M2 / M4 / M6 / M7 / M9 / M10 / L4 / L6 / L7 / L8 / L10 / L11）。
 *
 * 为什么单独成文件：这些断言分三类，既不属于 `test/ui-contract.test.mjs` 的视觉契约（那边只喂手写快照、
 * 只查样式字面量），也不该去动已冻结的 `test/halves.test.mjs`：
 *
 *   1. 纯函数级 —— 分区构造、memo 缓存、字典。不需要 DOM，也不需要真投影；
 *   2. 组件级 —— 两个入口组件在最小 React 替身下可以当普通函数调用（effect 真的执行），
 *      于是「有没有键盘入口」「忙碌才挂心跳」「切会话重置开合态」都能直接断言；
 *   3. 源码级 —— 时间格式只剩一个出口、告警时长不再写死秒数。
 *
 * 假 React 的语义与 `test/halves.test.mjs` / `test/ui-contract.test.mjs` 一致（不 import 它们），
 * 只多两样：`useEffect` 真的执行、`useState` 的 setter 可被观察 —— 这正是 M1/M2 要看的东西。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DEFAULT_CONFIG } from '../lib/state.js'

// ── 装载客户端半（与 `test/rotation-client.test.mjs` 同一装载约定） ─────────────────────────
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (mod) => loaded.push(mod) } }
await import('../lib/client.js')

/**
 * 记录 setter 调用 + 收集 effect 清理函数；effect 真的执行，所以 M1/M2 的断言有东西可看。
 *
 * 清理函数必须能被手动跑一次：这个替身不会卸载组件，而「旧组件解绑订阅」正是真实 React 的行为，
 * 不模拟它，上一个会话留下的监听器会继续往新组件写状态，把 M2 的断言搅浑。
 */
function spyReact(stateCalls, cleanups) {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, (next) => stateCalls.push(next)]
    },
    useRef(initial) {
      return { current: initial }
    },
    useEffect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function' && Array.isArray(cleanups)) cleanups.push(cleanup)
      return cleanup
    },
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    Fragment: 'Fragment',
  }
}

function apiWith(react) {
  return loaded[0].factory((id) => {
    if (id === 'react') return react
    throw new Error(`未预期的 require：${id}`)
  })
}

/** 渲染期不许真的挂定时器，否则测试进程要陪着心跳多跑一秒。 */
function withoutRealTimers(record, body) {
  const real = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => {
    if (Array.isArray(record)) record.push(ms)
    return 0
  }
  try {
    return body()
  } finally {
    globalThis.setTimeout = real
  }
}

/**
 * 装载并拿到 locale 注册结果（L10/M5/M7/L11 的双语判定靠它，不必去读源码文本）。
 * `timer` 服务必须给：缺了会退回真 `setTimeout`，挂载自检的 3 秒会让测试进程陪着等。
 */
function localeOf() {
  const captured = { locale: null }
  const ctx = {
    slots: {
      inject(key, callback) {
        return callback()
      },
      register() {
        return () => {}
      },
    },
    get(name) {
      if (name === 'locale') {
        return {
          register(ns, dict) {
            captured.locale = { ns, dict }
            return () => {}
          },
        }
      }
      if (name === 'timer') return { timeout: () => () => {} }
      return undefined
    },
  }
  apiWith(spyReact([])).apply(ctx)
  return captured.locale
}

/** 只填占位符的假 text：断言关心的是"画出来是什么"，语言一律走中文兜底。 */
const text = (key, fallback, values) =>
  String(fallback).replace(/\{(\w+)\}/g, (whole, name) =>
    values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  )

function textOf(node) {
  if (node === null || node === undefined || node === true || node === false) return ''
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

/** 深度收集所有带 props 的元素节点（M9 的 title 可能落在任意一层）。 */
function collectNodes(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out)
    return out
  }
  if (node.props) out.push(node)
  if (Array.isArray(node.children)) for (const child of node.children) collectNodes(child, out)
  return out
}

/** 一份够画完整面板的快照（字段与 wire 一致；缺席字段走各分区自己的兜底）。 */
function busySnapshot(overrides) {
  const now = Date.now()
  return {
    v: 13,
    mountStatus: 'enabled',
    busy: true,
    phase: 'tool',
    tool: 'bash',
    turn: 1,
    step: 3,
    phaseStartedAt: now - 5000,
    turnStartedAt: now - 9000,
    lastProgressAt: now - 1000,
    stepTokens: 3100,
    turnTokens: 12000,
    hitRate: 0.71,
    effort: 'low',
    noProgressMs: 90000,
    prefixEpoch: 0,
    prefixCause: null,
    prefixAt: null,
    lastTurnMs: 12300,
    topTools: [],
    waitTools: [],
    waitKind: null,
    hookFaults: [],
    idleLine: null,
    lastSpill: null,
    activity: [],
    subagents: 0,
    slowMs: 60000,
    enhancement: null,
    rotation: null,
    ...overrides,
  }
}

/* ─────────────────────────────── 字典与文案（L10/M5/M7/L11） ─────────────────────────────── */

test('L10/L11/M5/M7：中英字典键集双向零差异，没有死键，时限不写死秒数', () => {
  const locale = localeOf()
  assert.notEqual(locale, null, 'apply() 必须把字典注册给 locale 服务')
  const zh = Object.keys(locale.dict.zh).sort()
  const en = Object.keys(locale.dict.en).sort()
  assert.deepEqual(zh, en, 'zh/en 键集必须完全相等（双向零差异）')
  assert.ok(zh.length >= 110, `键数不该少于审计基线的 110，实际 ${zh.length}`)

  // L10：三元链永远落在 armed.manual / armed.auto / armed.waiting 上，裸的那个键两个语言都必须删掉。
  assert.equal(locale.dict.zh['rotation.armed'], undefined, 'L10：zh 死键必须删掉')
  assert.equal(locale.dict.en['rotation.armed'], undefined, 'L10：en 死键必须删掉')
  assert.equal(typeof locale.dict.zh['rotation.armed.auto'], 'string', '真分支留下的三个后缀键必须在')

  // M7：分隔符由 locale 决定 —— 英文界面不能出现全角冒号。
  assert.equal(locale.dict.zh['label.colon'], '：')
  assert.equal(locale.dict.en['label.colon'], ': ')

  // L11：秒数由 {grace} 给，而不是写死在句子里。
  assert.match(locale.dict.zh['error.missingProjection'], /\{grace\}/)
  assert.match(locale.dict.en['error.missingProjection'], /\{grace\}/)
  for (const key of zh) assert.doesNotMatch(locale.dict.zh[key], /8\s*秒/, `${key} 里不许出现写死的秒数`)

  // 占位符也要双语一致：zh 有 {grace} 而 en 漏了，英文界面就会把 {grace} 原样画出来。
  const holders = (value) => (String(value).match(/\{(\w+)\}/g) || []).sort().join(',')
  for (const key of zh) assert.equal(holders(locale.dict.zh[key]), holders(locale.dict.en[key]), `占位符不一致：${key}`)
  for (const key of zh) assert.notEqual(String(locale.dict.zh[key]).trim(), '', `${key} 的空译文等于没翻译`)
})

test('M7：分隔符跟着 locale 走；字典缺席时退回中文全角', () => {
  const api = apiWith(spyReact([]))
  assert.equal(api.__test.labelSeparator((key, fallback) => (key === 'label.colon' ? ': ' : fallback)), ': ')
  assert.equal(api.__test.labelSeparator((key, fallback) => fallback), '：')
  assert.equal(api.__test.labelSeparator(() => undefined), '：')
})

/* ─────────────────────────────── 分区构造（H4/M4/M10/L6） ─────────────────────────────── */

test('H4：活动流只渲染最近 N 条，更早的折成一句提示，key 不随渲染位置漂移', () => {
  const api = apiWith(spyReact([]))
  const limit = DEFAULT_CONFIG.activityLimit
  const entries = (count) =>
    Array.from({ length: count }, (unused, index) => ({ t: 1000 + index, kind: 'reason', text: `条目${index}` }))

  const section = api.__test.activitySection({ activity: entries(limit + 16) }, text)
  // 未截断时提示行是 `null`（照旧留在 children 里），所以先滤掉空位再数。
  const rows = section.children.slice(1).filter(Boolean)
  assert.equal(rows.length, limit + 1, `只画最近 ${limit} 条 + 一句省略提示`)
  const keys = rows.map((row) => row.props.key)
  assert.equal(keys[0], `activity-${limit + 15}`, '最新的那条排在最上面（原数组索引即 key）')
  assert.equal(keys[limit - 1], 'activity-16', '窗口下沿是原数组第 16 条，再早的已经不在树上')
  assert.equal(keys.includes('activity-15'), false, '更早的那条必须已经不在树上')
  assert.match(textOf(rows[rows.length - 1]), /16 条已省略/)

  // key 的稳定性：条目多了一条之后，同一个条目的 key 必须一模一样 —— 它认的是数组索引，不是渲染位置。
  const next = api.__test.activitySection({ activity: entries(limit + 17) }, text)
  const keyOf = (target, label) => target.children.slice(1).find((row) => textOf(row).includes(label)).props.key
  assert.equal(keyOf(next, '条目17'), keyOf(section, '条目17'))

  // 没截断时不留提示行（提示行的空位会被滤掉）。
  assert.equal(api.__test.activitySection({ activity: entries(3) }, text).children.slice(1).filter(Boolean).length, 3)
})

test('M10/L6：工具行 key 认工具身份（不是渲染下标），截断了就说清 Top N / 总数', () => {
  const api = apiWith(spyReact([]))
  const tools = Array.from({ length: 7 }, (unused, index) => ({
    name: `工具${index}`,
    key: `工具${index}`,
    count: 3,
    maxMs: 1000 - index,
    slow: false,
    argPreview: null,
    kind: 'exec',
  }))

  const top = api.__test.topToolsSection({ topTools: tools }, text)
  const topKeys = top.children.slice(1).map((row) => row.props.key)
  assert.equal(topKeys.includes('tool-0'), false, 'M10：key 不能还是渲染下标')
  assert.ok(topKeys.some((key) => key.includes('工具0')), `key 必须认得出是哪个工具：${topKeys.join('、')}`)
  assert.match(textOf(top), /共 7 条/, 'L6：截断必须说明总共几条')
  assert.match(textOf(top), /5 条/)

  const waits = api.__test.waitToolsSection({ waitTools: tools, waitKind: 'tool' }, text)
  const waitKeys = waits.children.slice(1).map((row) => row.props.key)
  assert.equal(waitKeys.includes('wait-0'), false, 'M10：等待占用那一列同样不许用下标')
  assert.ok(waitKeys.some((key) => key.includes('工具0')), `key 必须认得出是哪个工具：${waitKeys.join('、')}`)
})

test('M4：分区缓存在依赖没变时复用同一个元素，依赖一变就重建', () => {
  const api = apiWith(spyReact([]))
  let built = 0
  const build = () => {
    built += 1
    return { built }
  }
  const snapshot = { v: 13}
  const deps = [snapshot, text]
  const first = api.__test.memoSection('client-audit-m4', deps, build)
  assert.equal(api.__test.memoSection('client-audit-m4', deps, build), first, '依赖没变必须复用')
  assert.equal(built, 1)
  assert.notEqual(api.__test.memoSection('client-audit-m4', [snapshot, () => {}], build), first, '换了 t 就要重建')
  assert.equal(built, 2)
})

/* ─────────────────────────────── 交互入口（H5） ─────────────────────────────── */

test('H5：唯一交互入口有完整键盘路径 —— role=button / tabIndex / aria-expanded / Enter 与 Space', () => {
  const api = apiWith(spyReact([]))
  const testApi = api.__test
  const props = { sessionId: 'h5-session' }

  const first = testApi.clickableRow(['切过去'], props)
  assert.equal(first.props.role, 'button', 'role=button')
  assert.equal(first.props.tabIndex, 0, '必须能被 Tab 到')
  assert.equal(first.props['aria-expanded'], false, '收起态要如实报出来')
  assert.equal(first.props.style.cursor, 'pointer', '唯一入口必须是手型')

  let prevented = 0
  first.props.onKeyDown({ key: ' ', preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1, 'Space 必须 preventDefault（否则空格会滚动页面）')
  assert.equal(testApi.isDetailOpen('h5-session'), true, 'Space 要能打开')

  const second = testApi.clickableRow(['切过去'], props)
  assert.equal(second.props['aria-expanded'], true, '展开态要同步给读屏')
  second.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented += 1 } })
  assert.equal(prevented, 1, 'Enter 没有默认行为可接管，不该调 preventDefault')
  assert.equal(testApi.isDetailOpen('h5-session'), false, 'Enter 要能收起')

  const third = testApi.clickableRow(['切过去'], props)
  third.props.onKeyDown({ key: 'Tab', preventDefault: () => { prevented += 1 } })
  assert.equal(testApi.isDetailOpen('h5-session'), false, '别的键不许动状态')
  assert.equal(prevented, 1)
})

/* ────────────────────── 展开态时钟、开合态归属、语义与排版（M1/M2/L4/L7/L8/M9） ────────────────────── */

test('M1：只有「展开 + 忙碌」才挂 1 秒心跳；空闲与收起都不留定时器', () => {
  const armed = []
  const api = apiWith(spyReact([]))
  const testApi = api.__test
  const busy = busySnapshot()
  const idle = busySnapshot({ busy: false, phase: 'idle' })

  withoutRealTimers(armed, () => {
    testApi.toggleDetail('m1-open-busy')
    const panel = testApi.TurboDetailPanel({ useProjection: () => busy, sessionId: 'm1-open-busy', t: (key) => key })
    assert.notEqual(panel, null, '展开 + 忙碌：面板必须画出来')
    assert.equal(armed.length, 1, '忙碌 + 展开：正好一个心跳（脉动与它同节拍）')
    assert.ok(armed[0] > 0 && armed[0] <= 1000, `心跳必须整秒对齐（实际 ${armed[0]}ms）`)
    armed.length = 0

    testApi.toggleDetail('m1-open-idle')
    assert.notEqual(
      testApi.TurboDetailPanel({ useProjection: () => idle, sessionId: 'm1-open-idle', t: (key) => key }),
      null,
    )
    assert.deepEqual(armed, [], '空闲：一个定时器都不许留')

    assert.equal(
      testApi.TurboDetailPanel({ useProjection: () => busy, sessionId: 'm1-closed-busy', t: (key) => key }),
      null,
      '收起：面板不画，也不挂心跳',
    )
    assert.deepEqual(armed, [])
  })
})

test('M2：切到别的会话时 effect 体内先把开合态改成新会话的（不能沿用上一个会话）', () => {
  const stateCalls = []
  const cleanups = []
  const testApi = apiWith(spyReact(stateCalls, cleanups)).__test
  const snapshot = busySnapshot()

  withoutRealTimers(null, () => {
    // 从未展开过的会话：切过去必须立刻收起 —— 真实 React 里 useState 的初值只在挂载那一次算。
    testApi.TurboDetailPanel({ useProjection: () => snapshot, sessionId: 'm2-other', t: (key) => key })
    assert.deepEqual(stateCalls, [true], 'setCollapsed(!isDetailOpen(sessionId)) 必须在 effect 体内先跑')

    // 模拟旧组件卸载：真实 React 会解绑订阅，这个替身不会。
    for (const cleanup of cleanups.splice(0)) cleanup()
    stateCalls.length = 0

    testApi.toggleDetail('m2-open')
    testApi.TurboDetailPanel({ useProjection: () => snapshot, sessionId: 'm2-open', t: (key) => key })
    assert.deepEqual(stateCalls, [false], '已展开的会话切回来要保持在展开态')
  })
})

test('L4：工具增强缺席时不画「已启用」（缺席是设计，不是正常）', () => {
  const testApi = apiWith(spyReact([])).__test
  const sessionId = 'l4-session'
  testApi.toggleDetail(sessionId)
  const rendered = withoutRealTimers(null, () =>
    textOf(testApi.TurboDetailPanel({ useProjection: () => busySnapshot({ enhancement: null }), sessionId, t: (key) => key })),
  )
  assert.equal(rendered.includes('已启用'), false, 'enhancement 缺席必须报未启用，不能默认成已启用')
  assert.match(rendered, /未启用/)
})

test('L7/L8/M9：面板与分区都是具名 region、标题有语义、值行带 title、相位 pill 是 polite 播报区', () => {
  const testApi = apiWith(spyReact([])).__test
  const snapshot = busySnapshot()
  const sessionId = 'aria-session'

  withoutRealTimers(null, () => {
    testApi.toggleDetail(sessionId)
    const panel = testApi.TurboDetailPanel({ useProjection: () => snapshot, sessionId, t: (key) => key })
    assert.notEqual(panel, null)

    // L7：面板根也是具名 region；分区是具名 region + 3 级标题。
    assert.equal(panel.props.role, 'region')
    assert.equal(panel.props['aria-label'], '会话状态详情')
    const first = panel.children[1]
    assert.equal(first.props.role, 'region')
    assert.equal(first.props['aria-label'], '现在')
    assert.equal(first.children[0].props.role, 'heading')
    assert.equal(first.children[0].props['aria-level'], 3)

    // M9：面板自己可滚（maxHeight + overflowY），被省略号截断的值都有 title 兜底。
    assert.equal(panel.props.style.maxHeight, '60vh')
    assert.equal(panel.props.style.overflowY, 'auto')
    const nodes = collectNodes(panel, [])
    assert.ok(
      nodes.some((node) => typeof node.props.title === 'string' && node.props.title !== ''),
      'M9：被截断的 span 必须带 title（值行靠它把全文交出来）',
    )

    // L8：播报区只念阶段名 —— 每秒都在跳的秒数不进 live 区。
    const status = testApi.TurboStatusBar({ useProjection: () => snapshot, sessionId, t: (key) => key })
    const phasePill = status.children[0]
    assert.equal(phasePill.props['aria-live'], 'polite')
    assert.match(String(phasePill.props['aria-label']), /^阶段 /)
    assert.equal(/秒|tok/.test(String(phasePill.props['aria-label'])), false, 'live 区不许带秒数或 token 数')
  })
})

/* ─────────────────────────────── 源码级护栏（M6/L11） ─────────────────────────────── */

test('M6/L11：时间格式只剩一个出口，告警时长不写死在文案里', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('toLocaleTimeString'), false, 'M6：轮换行/交接行的时间戳必须走 fmtClock')
  assert.equal(source.includes('超过 8 秒仍未到达'), false, 'L11：秒数必须由 {grace} 占位符给出')
  assert.ok(source.includes("text('unit.seconds'"), 'L11：单位要走字典，英文界面才是 s')
})
