/**
 * 「新会话」话术卡与设置页的回归点（0.18.2：左侧栏入口已撤，卡片并进设置页）。四层：
 *
 *   1. 取数选择器（`selectCurrentSession` / `makeProjectionSelector`）—— 从 `SessionListState`
 *      的第 `projectionValues.turbo` 上读当前会话的 wire 视图，缺一步就 `undefined`；
 *   2. 话术卡纯函数（`newSessionCardOf`）—— wire 的 `newSession` 折成 `{text, oldId, cwd}`，
 *      缺字段/脏值一律空串，页面据此显示提示行而不是编造文本；
 *   3. 页面与图标（`TurboNewSessionPage` / `NewSessionPanelIcon`）—— 没有会话 / 投影没到 /
 *      有投影三态，话术卡与"复制"按钮，以及点完的状态文案；
 *   4. 注册（`registerSettingsSection`）—— 只断言这一页里配置表单与话术卡同时在，
 *      否则按钮派发不到面板；设置页在 0.18.0 只剩「全部设置项」一页。
 *
 * 0.18.0 整块删掉了群聊（room / roster / 角色位）与编队（fleet）——`lib/room.js`、`lib/room-host.js`、
 * `lib/roster.js`、`lib/fleet.js`、`lib/fleet-host.js` 已不存在，插件现在只做状态条/详情面板与
 * 「新会话」话术卡。本文件原先测群聊分区、成员行、编队模板与名册页的用例随之删除。
 *
 * 客户端半按 `test/client-audit.test.mjs` 的同一装载约定（`window.__ModuleLoader__` + 假 React），
 * 这里不 import 那个文件，避免它的模块级副产物影响本文件的断言。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

// ── 装载客户端半 ─────────────────────────────────────────────────────────────────
const loaded = []
globalThis.window = { __ModuleLoader__: { load: (mod) => loaded.push(mod) } }
await import('../lib/client.js')

/**
 * 最小 React 替身：`createElement` / `Fragment` + 一组"一个实例一条 hook 槽位"的
 * `useState` / `useEffect`。
 *
 * 页面（`TurboNewSessionPage`）与设置页（`ConfigSection`）都是普通函数，替身按真 hook 的调用顺序
 * 记账：每次渲染前 `__begin()` 把槽位游标归零，于是"点一下复制 → 状态文案变了"这种两帧行为
 * 可以在没有 DOM 的情况下断言。`useEffect` 就地执行（effect 体只读 scope 并订阅）。
 */
function fakeReact() {
  const hooks = { slots: [], cursor: 0, cleanups: [] }
  return {
    __hooks: hooks,
    __begin() {
      hooks.cursor = 0
    },
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
    Fragment: 'Fragment',
    useState(initial) {
      const at = hooks.cursor
      hooks.cursor += 1
      if (!(at in hooks.slots)) hooks.slots[at] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        hooks.slots[at] = typeof next === 'function' ? next(hooks.slots[at]) : next
      }
      return [hooks.slots[at], set]
    },
    useEffect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') hooks.cleanups.push(cleanup)
    },
  }
}

/** 客户端半只 require 得到 react，其余 require 一律视为装载错误。 */
const REACT = fakeReact()
function clientApi() {
  return loaded[0].factory((id) => {
    if (id === 'react') return REACT
    throw new Error(`未预期的 require：${id}`)
  })
}

/**
 * 中文字典替身（只登记本文件断言到的词条，其余落回组件内建的中文兜底）。
 *
 * 生产代码里的 `DICT.zh` 活在 factory 闭包里、`__test` 不暴露它；这里补一份最小的，
 * 目的是断言"文案确实过 `text()` 这一道"（设置页导航名尤其：它是注册期就定好的 thunk）。
 */
const DICT_ZH = {
  'panel.title': '新会话',
  'panel.heading': '新会话',
  'panel.session': '当前会话',
  'panel.none': '当前没有会话 —— 先在左侧选一个会话。',
  'panel.loading': '等待该会话的投影…',
  'panel.script': '开场话术',
  'panel.noScript': '拿不到开场话术：宿主没有报出这段文本。',
  'panel.copy': '复制',
  'panel.copied': '已复制',
  'panel.copyFailed': '复制失败，请手动选中',
  'panel.cwd': '工作目录',
  'panel.usage': '在新会话里粘贴这段文本：新会话会知道该去查哪条旧会话。',
  'section.rotation': '会话轮换',
  'settings.items': '全部设置项',
}

/** 只填占位符的假 text：命中替身字典就用它，否则落回 fallback。 */
const text = (key, fallback, values) => {
  const found = Object.prototype.hasOwnProperty.call(DICT_ZH, key) ? DICT_ZH[key] : fallback
  return String(found).replace(/\{(\w+)\}/g, (whole, name) =>
    values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  )
}

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

/**
 * 面向**组件 props** 的假翻译函数（`t`），与 `text` 的区别是单参调用：
 * `makeText(t)` 只传 key、靠返回值判定"这个词条有没有"，所以这里单参一律返回 `undefined`，
 * 让组件的内建中文兜底生效；两参调用（侧栏标签 / 设置页导航 thunk）才回填占位符。
 */
const t = (key, fallback) => (fallback === undefined ? undefined : text(key, fallback))

/** 深度收集元素树（假 React 的节点都带 `children` 数组）。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const kid of Array.isArray(node.children) ? node.children : []) collect(kid, out)
  return out
}

// ── 夹具 ─────────────────────────────────────────────────────────────────────────
const PANEL_ID = 'dsh-status-turbo'
const SETTINGS_ID = 'dsh-status-turbo.settings'

/**
 * wire 顶层视图（0.18.0：共 37 键，**没有 `room`、没有 `fleet`**，多了 `newSession`）。
 * 这里只摆本文件断言得到的那几项。
 */
function viewWith(overrides) {
  return {
    v: 13,
    at: 1,
    phase: 'active',
    rotation: { status: 'ready', mode: 'manual', sessionId: 'S0-old', childId: '', at: 1000, message: '' },
    newSession: { text: '接着上一次：先读旧会话 S0-old 的记录。', oldId: 'S0-old', cwd: 'D:\\project' },
    ...overrides,
  }
}

/** 会话列表状态：`current` + 每行的 `projectionValues`（客户端运行时的真实形状）。 */
function sessionState(current, turbo) {
  const byId = {}
  if (turbo !== undefined) byId[current] = { id: current, projectionValues: { turbo } }
  else if (current !== undefined) byId[current] = { id: current }
  return { ids: current === undefined ? [] : [current], byId, current, phase: 'ready' }
}

// ── 1. 取数选择器 ────────────────────────────────────────────────────────────────
test('0.18.0 取数：当前会话 id 来自 SessionListState.current，缺席不编造', () => {
  const { __test: api } = clientApi()
  assert.equal(api.selectCurrentSession({ current: 'S1' }), 'S1')
  assert.equal(api.selectCurrentSession({ current: '' }) /* 空串不算会话，下游当"没有" */, '')
  assert.equal(api.selectCurrentSession({}), undefined)
  assert.equal(api.selectCurrentSession(null), undefined)
  assert.equal(api.selectCurrentSession(undefined), undefined)
})

test('0.18.0 取数：投影选择器读投影值映射的 turbo 键，缺哪一步都 undefined', () => {
  const { __test: api } = clientApi()
  const view = viewWith({})
  const pick = api.makeProjectionSelector('S1')
  assert.equal(pick(sessionState('S1', view)), view)
  assert.equal(pick(sessionState('S1')), undefined, '本行还没带投影值')
  assert.equal(pick(sessionState('S2', view)), undefined, '当前行不是这一行')
  assert.equal(pick({ byId: { S1: { projectionValues: {} } }, current: 'S1' }), undefined)
  assert.equal(pick({ byId: {}, current: 'S1' }), undefined)
  assert.equal(pick({ current: 'S1' }), undefined)
  assert.equal(pick(null), undefined)
  assert.equal(api.makeProjectionSelector(undefined)(sessionState('S1', view)), undefined)
})

// ── 2. 话术卡纯函数 ──────────────────────────────────────────────────────────────
test('0.18.0 话术卡：wire 的 newSession 原样取出 text / oldId / cwd', () => {
  const { __test: api } = clientApi()
  assert.deepEqual(api.newSessionCardOf(viewWith({})), {
    text: '接着上一次：先读旧会话 S0-old 的记录。',
    oldId: 'S0-old',
    cwd: 'D:\\project',
  })
})

test('0.18.0 话术卡：view 缺失、非对象、缺 newSession 一律三空串（页面据此给提示行）', () => {
  const { __test: api } = clientApi()
  const empty = { text: '', oldId: '', cwd: '' }
  assert.deepEqual(api.newSessionCardOf(null), empty)
  assert.deepEqual(api.newSessionCardOf(undefined), empty)
  assert.deepEqual(api.newSessionCardOf('S1'), empty)
  assert.deepEqual(api.newSessionCardOf(42), empty)
  assert.deepEqual(api.newSessionCardOf({}), empty)
  assert.deepEqual(api.newSessionCardOf({ newSession: null }), empty)
  assert.deepEqual(api.newSessionCardOf({ newSession: 'nope' }), empty)
  assert.deepEqual(api.newSessionCardOf({ newSession: 7 }), empty)
})

test('0.18.0 话术卡：字段不是字符串就按空串兜底，不把数字/对象当文本', () => {
  const { __test: api } = clientApi()
  assert.deepEqual(api.newSessionCardOf({ newSession: { text: 42, oldId: {}, cwd: [] } }), {
    text: '',
    oldId: '',
    cwd: '',
  })
  // 只给了一半也不能把另一半编造出来。
  assert.deepEqual(api.newSessionCardOf({ newSession: { text: '接着干' } }), { text: '接着干', oldId: '', cwd: '' })
  // 空串是合法的"没有"，不等于脏值。
  assert.deepEqual(api.newSessionCardOf({ newSession: { text: '', oldId: '', cwd: '' } }), {
    text: '',
    oldId: '',
    cwd: '',
  })
})

// ── 3. 主面板页 ──────────────────────────────────────────────────────────────────
/** 按真 hook 的选择器协议调页面：`useSessions(selector)` 直接求值。 */
function pageNode(state, translate = t) {
  const { __test: api } = clientApi()
  REACT.__begin()
  return api.TurboNewSessionPage({ useSessions: (selector) => selector(state), t: translate })
}

function renderPage(state, translate = t) {
  return textOf(pageNode(state, translate))
}

test('0.18.0 页面：没有当前会话 ⇒ 明说，不显示投影等待与话术卡', () => {
  const flat = renderPage(sessionState(undefined))
  assert.match(flat, /新会话/)
  assert.match(flat, /当前没有会话/)
  assert.ok(!flat.includes('等待该会话的投影'), '没有会话不是"投影还没到"')
  assert.ok(!flat.includes('开场话术'))
  assert.ok(!flat.includes('已复制'))
})

test('0.18.0 页面：投影还没到 ⇒ 说"等待"，不谎报"拿不到开场话术"', () => {
  const flat = renderPage(sessionState('S1'))
  assert.match(flat, /当前会话：S1/)
  assert.match(flat, /等待该会话的投影/)
  assert.ok(!flat.includes('拿不到开场话术'), '投影缺席不等于宿主没报话术')
  assert.ok(!flat.includes('开场话术'))
})

test('0.18.0 页面：有投影 ⇒ 轮换分区 + 开场话术 pre + 复制按钮 + 工作目录 + 粘贴提示', () => {
  const node = pageNode(sessionState('S1', viewWith({})))
  assert.equal(node.props.role, 'region')
  assert.equal(node.props['aria-label'], '新会话', '根节点是 region，给读屏一个面板名')
  const flat = textOf(node)
  assert.match(flat, /当前会话：S1/)

  // 轮换分区在话术卡前面，且是带 aria-label 的 region。
  const rotation = collect(node).find((it) => it.props && it.props['aria-label'] === '会话轮换')
  assert.ok(rotation !== undefined, '有投影就要嵌轮换分区')
  assert.match(textOf(rotation), /新会话已就绪 · 点这里重试/)

  const script = collect(node).find((it) => it.props && it.props['aria-label'] === '开场话术')
  assert.ok(script !== undefined, '开场话术是独立分区')
  const pre = collect(script).find((it) => it.type === 'pre')
  assert.equal(textOf(pre), '接着上一次：先读旧会话 S0-old 的记录。')
  assert.match(flat, /工作目录：D:\\project/)
  assert.match(flat, /在新会话里粘贴这段文本/)

  const top = node.children.map((kid) => (kid && kid.props ? kid.props['aria-label'] : undefined))
  assert.ok(
    top.indexOf('会话轮换') < top.indexOf('开场话术'),
    '轮换状态在话术卡之前（先看轮换结果，再复制）',
  )
})

test('0.18.0 页面：cwd 为空就不出工作目录那一行（话术卡与提示仍在）', () => {
  const flat = renderPage(
    sessionState('S1', viewWith({ newSession: { text: '接着干', oldId: 'S0-old', cwd: '' } })),
  )
  assert.match(flat, /开场话术/)
  assert.match(flat, /接着干/)
  assert.match(flat, /在新会话里粘贴这段文本/)
  assert.ok(!flat.includes('工作目录'), 'cwd 缺席不摆一行空值')
})

test('0.18.0 页面：宿主没报出话术文本 ⇒ 给提示行，不给 pre 与复制按钮', () => {
  const node = pageNode(
    sessionState('S1', viewWith({ newSession: { text: '', oldId: 'S0-old', cwd: 'D:\\project' } })),
  )
  const flat = textOf(node)
  assert.match(flat, /拿不到开场话术/)
  const items = collect(node)
  assert.equal(
    items.find((it) => it.props && it.props['aria-label'] === '开场话术'),
    undefined,
    '没有话术就别摆一个空的分区标题',
  )
  assert.equal(items.find((it) => it.type === 'pre'), undefined, '空话术不摆 pre')
  assert.equal(items.find((it) => it.type === 'button'), undefined, '没有可复制的东西就不给复制按钮')
  assert.ok(!flat.includes('工作目录'), '这一段整体不渲染')
})

test('0.18.0 页面：标准工具包缺席（老宿主 / 测试桩）时用空状态，不抛', () => {
  const { __test: api } = clientApi()
  REACT.__begin()
  const element = api.TurboNewSessionPage({ t })
  assert.equal(element.props.role, 'region')
  assert.match(textOf(element), /当前没有会话/)
  // 选择器协议一致：不传 t 也不抛。
  REACT.__begin()
  assert.doesNotThrow(() => api.TurboNewSessionPage({}))
  // 文案确实过 `props.t` 这一道：换一个把 heading 改名的取词函数，面板名就换了。
  const renamed = renderPage(sessionState(undefined), (key) =>
    key === 'panel.heading' ? '新会话（自定义）' : undefined,
  )
  const renamedNode = pageNode(sessionState(undefined), (key) =>
    key === 'panel.heading' ? '新会话（自定义）' : undefined,
  )
  assert.equal(renamedNode.props['aria-label'], '新会话（自定义）')
  assert.match(renamed, /新会话（自定义）/)
})

test('0.18.0 图标：边长来自 owner 的 size，缺席或非数字给 16', () => {
  const { __test: api } = clientApi()
  const dflt = api.NewSessionPanelIcon(undefined)
  assert.equal(dflt.props.width, 16)
  assert.equal(dflt.props.height, 16)
  const sized = api.NewSessionPanelIcon({ size: 20, active: true })
  assert.equal(sized.props.width, 20)
  assert.equal(sized.props.height, 20)
  assert.equal(api.NewSessionPanelIcon({ size: '20' }).props.width, 16, '非数字不算边长')
  assert.equal(dflt.props['aria-hidden'], 'true')
  assert.equal(dflt.type, 'svg')
})

// ── 4. 复制（clipboard → textarea 兜底） ─────────────────────────────────────────
/**
 * 临时替 globalThis 上的 `navigator` / `document`。
 *
 * `navigator` 在 Node 22 里是**只读访问器**（赋值会抛），所以只能 `defineProperty`；替身必须在
 * 回调 `await` 结束之后才撤，否则 `writeText` 被拒后走到兜底那一步时 `document` 已经没了。
 */
async function withGlobals(defs, fn) {
  const saved = []
  for (const name of Object.keys(defs)) {
    saved.push([name, Object.getOwnPropertyDescriptor(globalThis, name)])
    Object.defineProperty(globalThis, name, { value: defs[name], configurable: true, writable: true })
  }
  try {
    return await fn()
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 假 document：够 `fallbackCopy` 用（appendChild / createElement / execCommand / removeChild）。 */
function fakeDocument(execOk) {
  const area = {
    tag: null,
    value: null,
    style: {},
    attrs: {},
    selected: false,
    setAttribute(name, value) {
      this.attrs[name] = value
    },
    select() {
      this.selected = true
    },
  }
  const appended = []
  const removed = []
  return {
    area,
    appended,
    removed,
    document: {
      body: {
        appendChild: (el) => appended.push(el),
        removeChild: (el) => removed.push(el),
      },
      createElement: (tag) => {
        area.tag = tag
        return area
      },
      execCommand: (cmd) => cmd === 'copy' && execOk,
    },
  }
}

test('0.18.0 复制：优先 navigator.clipboard.writeText，成功即 true', async () => {
  const { __test: api } = clientApi()
  const calls = []
  const ok = await withGlobals(
    { navigator: { clipboard: { writeText: (value) => (calls.push(value), Promise.resolve()) } } },
    () => api.copyText('接着干'),
  )
  assert.equal(ok, true)
  assert.deepEqual(calls, ['接着干'], '文本原样交给 clipboard')
})

test('0.18.0 复制：clipboard 缺失或被拒时走 textarea 兜底，两条路都不抛', async () => {
  const { __test: api } = clientApi()
  // ① 没有 clipboard：直接兜底。
  const first = fakeDocument(true)
  const okBare = await withGlobals({ navigator: {}, document: first.document }, () => api.copyText('X'))
  assert.equal(okBare, true)
  assert.equal(first.area.tag, 'textarea')
  assert.equal(first.area.value, 'X')
  assert.equal(first.area.attrs.readonly, 'readonly')
  assert.equal(first.area.selected, true, '要 select() 才能让 execCommand 复制到东西')
  assert.deepEqual(first.appended, [first.area])
  assert.deepEqual(first.removed, [first.area], '临时节点必须摘掉')

  // ② clipboard 抛错：不把异常抛给渲染，仍走兜底。
  const second = fakeDocument(true)
  const okThrow = await withGlobals(
    {
      navigator: {
        get clipboard() {
          throw new Error('沙箱里读不到 clipboard')
        },
      },
      document: second.document,
    },
    () => api.copyText('Y'),
  )
  assert.equal(okThrow, true)

  // ③ writeText 被拒：退回兜底（而不是直接报失败）。
  const third = fakeDocument(true)
  const okReject = await withGlobals(
    { navigator: { clipboard: { writeText: () => Promise.reject(new Error('没有剪贴板权限')) } }, document: third.document },
    () => api.copyText('Z'),
  )
  assert.equal(okReject, true)

  // ④ execCommand 说没成功 / 没有 DOM：一律 false，绝不抛。
  const fourth = fakeDocument(false)
  assert.equal(await withGlobals({ navigator: {}, document: fourth.document }, () => api.copyText('W')), false)
  assert.equal(await withGlobals({ navigator: {}, document: undefined }, () => api.copyText('W')), false)
  assert.equal(api.fallbackCopy('W'), false, '本进程没有 document，兜底只能认栽')
})

test('0.18.0 复制按钮：点一下把状态文案写上「已复制」/「复制失败」，再渲染一次就看得见', async () => {
  const { __test: api } = clientApi()
  const state = sessionState('S1', viewWith({}))

  REACT.__begin()
  const first = api.TurboNewSessionPage({ useSessions: (selector) => selector(state), t })
  const before = collect(first).find((it) => it.type === 'button')
  assert.equal(textOf(before), '复制')
  assert.ok(!textOf(first).includes('已复制'), '点之前不给状态文案')
  assert.equal(collect(first).find((it) => it.props && it.props.key === 'copy-note'), undefined)

  await withGlobals({ navigator: { clipboard: { writeText: () => Promise.resolve() } } }, async () => {
    before.props.onClick()
    await tick()
  })
  REACT.__begin()
  const afterOk = textOf(api.TurboNewSessionPage({ useSessions: (selector) => selector(state), t }))
  assert.match(afterOk, /已复制/)
  assert.ok(!afterOk.includes('复制失败'))

  // 第二帧再失败一次：文案换成"请手动选中"（用户至少还能用鼠标复制）。
  REACT.__begin()
  const second = api.TurboNewSessionPage({ useSessions: (selector) => selector(state), t })
  const button = collect(second).find((it) => it.type === 'button')
  await withGlobals({ navigator: {} }, async () => {
    button.props.onClick()
    await tick()
  })
  REACT.__begin()
  const afterFailed = textOf(api.TurboNewSessionPage({ useSessions: (selector) => selector(state), t }))
  assert.match(afterFailed, /复制失败，请手动选中/)
  assert.ok(!afterFailed.includes('已复制'))
})

// ── 5. 注册体 ────────────────────────────────────────────────────────────────────
/** 假槽位：只记 `register` 的元数据，`inject` 立即求值（真槽位也是槽位在就地/之后出现都生效）。 */
function fakeSlots() {
  const registered = []
  const injected = []
  return {
    registered,
    injected,
    slots: {
      inject(name, fn) {
        injected.push(name)
        fn()
        return () => {
          injected.push(`dispose:${name}`)
        }
      },
      register(meta, component) {
        registered.push({ meta, component })
        return () => {}
      },
    },
  }
}

test('0.18.2 注册：设置页里同时挂配置表单与「新会话」话术卡（侧栏入口已撤）', () => {
  const { __test: api } = clientApi()
  const env = fakeSlots()
  const ctx = {
    get() {
      return undefined
    },
  }
  const undo = api.registerSettingsSection(ctx, env.slots, t)

  assert.deepEqual(env.injected, ['settings.section'])
  assert.equal(env.registered.length, 1)
  const settings = env.registered[0]
  assert.equal(settings.meta.name, 'settings.section')
  assert.equal(settings.meta.id, 'dsh-status-turbo.settings')
  const state = sessionState('S1', viewWith({}))
  REACT.__begin()
  const wrapper = settings.component({ useSessions: (selector) => selector(state), t })
  assert.equal(wrapper.type, 'div', '一页里放两件东西')
  const kids = wrapper.children
  assert.equal(kids.length, 2)
  assert.equal(typeof kids[0].type, 'function', '第一件是配置表单组件')
  assert.equal(kids[1].type, api.TurboNewSessionPage, '第二件是话术卡页面')
  assert.equal(typeof undo, 'function')
  assert.doesNotThrow(() => undo())
})

// ── 6. 设置页（0.18.0 只剩「全部设置项」一页） ────────────────────────────────────
/**
 * 假 `configForms`：`describe()` 只报被宿主服务的命名空间，而 `get(id)` 对**任何** id 都给控制器
 * —— 这两条都是实测到的真实语义（见 lib/client.js 的 formScope 注释），后面的断言正是钉住它。
 */
function fakeConfigForms(served, value) {
  const writes = []
  const gets = []
  let subscribes = 0
  return {
    writes,
    gets,
    subscribes: () => subscribes,
    service: {
      describe: () => ({
        getSnapshot: () => (served === null ? {} : { view: { namespaces: served.map((ns) => ({ ns })) } }),
        subscribe: () => {
          subscribes += 1
          return () => {}
        },
      }),
      get: (id) => {
        gets.push(id)
        const hot = served !== null && served.includes(id)
        return {
          getSnapshot: () =>
            hot ? { status: 'ready', value, writable: true } : { status: 'unavailable', value: undefined, writable: false },
          set: (field, next) => {
            writes.push([id, field, next])
            return Promise.resolve(true)
          },
          unset: (field) => {
            writes.push([id, field, undefined])
            return Promise.resolve(true)
          },
        }
      },
    },
  }
}

test('0.18.0 设置页：只挂一页 —— id / order / label 各自独立，旧的「群聊」页不再注册', () => {
  const { __test: api } = clientApi()
  const env = fakeSlots()
  const undo = api.registerSettingsSection({ get: () => undefined }, env.slots, t)

  assert.deepEqual(env.injected, ['settings.section'], '只注入一次（一个注册体）')
  assert.equal(env.registered.length, 1, '0.18.0 删掉名册页后只剩「全部设置项」')
  const [items] = env.registered
  assert.equal(items.meta.name, 'settings.section')
  assert.equal(items.meta.id, SETTINGS_ID)
  assert.equal(items.meta.order, 106)
  assert.equal(typeof items.meta.label, 'function')
  assert.equal(items.meta.label(), '全部设置项')
  assert.equal(items.meta.registrant, PANEL_ID)
  assert.equal(
    env.registered.filter((row) => row.meta.id === 'dsh-status-turbo.room').length,
    0,
    '名册页的 id 不该再出现',
  )
  assert.equal(typeof undo, 'function')
  assert.doesNotThrow(() => undo())

  // 拿不到任何数据面：仍然注册，scope 传 null，页面自己说"不可用"。
  const scope = items.component({}).children[0].props.scope
  assert.equal(scope, null)
  assert.deepEqual(api.readScope(scope), { status: 'unavailable', value: undefined, writable: false })
  const element = items.component({}).children[0]
  REACT.__begin()
  assert.match(textOf(element.type(element.props)), /设置服务不可用/)
})

test('0.18.0 设置页：configForms 在场就绑本条目 Config，并按 describe 镜像认领真正在服务的命名空间', async () => {
  const { __test: api } = clientApi()
  const env = fakeSlots()
  const value = { statusBar: true, noProgressMs: 90000, groups: [] }
  const forms = fakeConfigForms(['include:dsh-status-turbo'], value)
  const asked = []
  const ctx = {
    get(name) {
      asked.push(name)
      if (name === 'configForms') return forms.service
      throw new Error(`configForms 在场时不该问 ${name}`)
    },
  }

  api.registerSettingsSection(ctx, env.slots, t)

  assert.deepEqual(asked, ['configForms'], '先问 configForms，拿到就不再退回 settingsScope')
  const scope = env.registered[0].component({}).children[0].props.scope
  assert.deepEqual(api.readScope(scope), { status: 'ready', value, writable: true })
  // 订阅必须挂在 describe 镜像上：表单与镜像同源，命名空间列表变化时页面要能重取。
  const off = scope.subscribe(() => {})
  assert.equal(typeof off, 'function')
  assert.equal(forms.subscribes(), 1)
  await scope.set('noProgressMs', 120000)
  assert.deepEqual(forms.writes, [['include:dsh-status-turbo', 'noProgressMs', 120000]], '写落在认领到的条目上')
})

test('0.18.0 设置页：只服务短名时认领短名，不把写落到错条目', async () => {
  const { __test: api } = clientApi()
  const env = fakeSlots()
  const forms = fakeConfigForms(['dsh-status-turbo'], { statusBar: true })
  api.registerSettingsSection({ get: (name) => (name === 'configForms' ? forms.service : undefined) }, env.slots, t)
  const scope = env.registered[0].component({}).children[0].props.scope
  await scope.set('statusBar', false)
  assert.deepEqual(forms.writes, [['dsh-status-turbo', 'statusBar', false]])
})

test('0.18.0 设置页：configForms 缺席时退回 settingsScope.bind({namespace})', () => {
  const { __test: api } = clientApi()
  const env = fakeSlots()
  const bound = []
  const scopeHandle = { getSnapshot: () => ({ status: 'ready', value: { noProgressMs: 1 }, writable: true }) }
  const asked = []
  const ctx = {
    get(name) {
      asked.push(name)
      if (name === 'settingsScope') {
        return {
          bind: (input) => {
            bound.push(input)
            return scopeHandle
          },
        }
      }
      return undefined
    },
  }

  api.registerSettingsSection(ctx, env.slots, t)

  assert.deepEqual(asked, ['configForms', 'settingsScope'], 'configForms 不在场才问旧命名空间')
  assert.deepEqual(bound, [{ namespace: PANEL_ID }], '绑的是本插件的命名空间')
  assert.equal(env.registered[0].component({}).children[0].props.scope, scopeHandle)
})

test('0.18.0 设置页：bind 抛错只让这一页显示不可用，不抛到 apply', () => {
  const { __test: api } = clientApi()
  const env = fakeSlots()
  const warned = []
  const original = console.warn
  console.warn = (...args) => warned.push(args.join(' '))
  let undo
  try {
    undo = api.registerSettingsSection(
      {
        get: () => ({
          bind() {
            throw new Error('命名空间未注册')
          },
        }),
      },
      env.slots,
      t,
    )
  } finally {
    console.warn = original
  }
  assert.equal(typeof undo, 'function')
  assert.doesNotThrow(() => undo())
  assert.equal(env.registered.length, 1, '绑不上也照常注册（页面自己说不可用）')
  const element = env.registered[0].component({}).children[0]
  assert.equal(element.props.scope, null)
  assert.equal(warned.length, 1)
  assert.match(warned[0], /命名空间未注册/)
  REACT.__begin()
  assert.match(textOf(element.type(element.props)), /设置服务不可用/)
})

test('0.18.0 设置页：ctx 没有 inject 也要挂上；注入抛错只报一行错、不抛', () => {
  const { __test: api } = clientApi()
  // 只有 get、没有 inject 的 ctx —— 动态客户端上下文的一种真实形状（0.14.1 缺陷的回归点）。
  const env = fakeSlots()
  assert.equal(typeof api.registerSettingsSection({ get: () => undefined }, env.slots, t), 'function')
  assert.equal(env.registered.length, 1)

  // 槽位注册抛错：只 console.error，返回空句柄。
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  let undo
  try {
    undo = api.registerSettingsSection(
      { get: () => undefined },
      {
        inject() {
          throw new Error('slot 未声明')
        },
        register() {},
      },
      t,
    )
  } finally {
    console.error = original
  }
  assert.equal(typeof undo, 'function')
  assert.doesNotThrow(() => undo())
  assert.equal(errors.length, 1)
  assert.match(errors[0], /设置页挂载失败/)

  // ctx 缺席时也不抛（老宿主 / 测试桩）。
  assert.equal(typeof api.registerSettingsSection(undefined, fakeSlots().slots, t), 'function')
})
