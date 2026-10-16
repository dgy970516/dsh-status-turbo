/**
 * A1 支柱验收：两个半片的**装载契约**与**失败可见性**（任务书 §6 第 11 行 / §9 第 2、3 条）。
 * 客户端半用最小 React 替身跑，不需要 DOM，也不需要浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
const readSource = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
/** 从源码里取那个唯一常量，而不是在测试里再抄一遍数字（避免三处版本号各说各话）。 */
const sourceVersion = (source, pattern) => {
  const match = pattern.exec(source)
  assert.ok(match, '版本常量必须能在源码里找到（R1/R2 的落点）')
  return Number(match[1])
}

/* ─────────────────────────── 宿主半 ─────────────────────────── */

test('宿主半：投影服务缺失时必须大声抛错（§9#3 不许静默 return）', async () => {
  const { apply } = await import('../lib/index.js')
  assert.throws(
    () => apply({ inject: (_deps, callback) => callback({}), logger: { info() {}, error() {} } }, {}),
    /sessionProjections\.register is unavailable/,
  )
})

test('宿主半：注册 wire 投影 turbo，key / stateVersion / 直通 schema 全部到位', async () => {
  const { apply } = await import('../lib/index.js')
  const seen = []
  const deps = []
  apply(
    {
      inject: (requested, callback) => {
        deps.push(...requested)
        callback({ sessionProjections: { register: (definition) => seen.push(definition) } })
      },
      logger: { info() {}, warn() {}, error() {} },
    },
    { noProgressMs: 1234 },
  )

  // sessionProjections = A1 的投影服务；llm = B1 读"该模型公布的有序档位表"的唯一入口。
  // tools 那条边来自 `tools/post-execute` 单监听器（lib/index.js 的 ctx.inject(['tools'], …)）。
  // sessions = 轮换建新会话要用它，而且**服务只在声明它的那个 inject 回调的 ctx 上可取**
  // —— 老实现写成 `run.ctx.sessions`（模块级 ctx 属性访问），本宿主上取不到就抛错、
  // 被"可选服务"守卫吞掉，轮换于是永远停在 no-service（0.17.1 修，见 docs/design-rotation.md 补记）。
  // settings = 0.18.0 起只剩它用来 `configure({ auto: false })` 抑制自动配置表单。
  // 0.18.0 删掉房间/编队的四条边（tools 的第二次 inject、commands、systemPrompt）；
  // agents 在 0.19.0 回到接线里：轮换要开出**落盘、可见**的新会话，就得走代理生命周期
  // （`ctx.agents.create`）—— 只有生命周期里发布的会话会拿到持久化写句柄。
  // workspaceRegistry 在 0.19.1 进来：落盘还不够，子会话得挂进工作区才会出现在左侧列表里。
  // agentDefaultModel / agentPresets 在 0.19.3 进来：子会话必须带着模型选择（否则系统提示里的
  // `{{model}}` 渲染即抛错 ⇒ 新会话一跑就是「本轮运行失败」）与旧会话那套 preset 组合。
  // 顺序即 apply 的执行顺序，故仍逐字锁死，不得放宽为 includes。
  // sessionTitle 在 0.20.0 进来：空白子会话的标题只有「首条 user 消息」这一条回退路，
  // 一代一个样认不出谁开的 —— 宿主按旧会话标题 (N) 递增补个名字（`ctx.sessionTitle.rename`）。
  assert.deepEqual(deps, ['sessionProjections', 'sessions', 'agents', 'workspaceRegistry', 'agentDefaultModel', 'sessionTitle', 'agentPresets', 'tools', 'llm', 'settings'])
  assert.equal(seen.length, 1, '只注册一次')
  const definition = seen[0]
  assert.equal(definition.key, 'turbo')
  /*
   * R1/R2：版本号是**半片之间的握手**，两边必须逐字一致。
   * 这里不去硬编码"当前是几"，而是把两条源码事实对起来 —— 谁把其中一边单独改了，这条就红，
   * 界面上的红格「投影版本错配（宿主 vN ≠ 客户端 vM）」也才不会变成哑炮。
   */
  const hostVersion = sourceVersion(readSource('../lib/state.js'), /TURBO_STATE_VERSION\s*=\s*(\d+)/)
  const clientVersion = sourceVersion(readSource('../lib/client.js'), /EXPECTED_V\s*=\s*(\d+)/)
  assert.equal(definition.stateVersion, hostVersion, '宿主的 stateVersion 必须取自 TURBO_STATE_VERSION')
  assert.equal(clientVersion, hostVersion, 'R2：客户端 EXPECTED_V 必须等于宿主 TURBO_STATE_VERSION')
  assert.equal(Number.isSafeInteger(definition.stateVersion) && definition.stateVersion >= 0, true, '投影注册会强制校验非负整数')
  // P0-2：stateSchema 不再是恒等 passthrough —— 真快照放行（校验不改写），形状不对的抛，
  // 宿主据此把该会话当成"没有快照"退回 init()。
  const bare = definition.init()
  assert.equal(definition.stateSchema.parse(bare), bare, 'P0-2：真实快照原样放行')
  assert.throws(() => definition.stateSchema.parse({ anything: 1 }), /dsh-status-turbo/, 'P0-2：形状不对必须抛')
  assert.equal(definition.wire.viewSchema.parse('x'), 'x')

  const initial = definition.init()
  const view = definition.wire.view(initial)
  assert.equal(view.busy, false)
  assert.equal(view.phase, 'idle')
  assert.equal(view.noProgressMs, 1234, '宿主 config 必须流进 wire 视图（客户端要靠它判黄）')
  assert.doesNotThrow(() => JSON.stringify(view), 'wire 视图必须可 JSON 序列化')

  const folded = definition.apply(initial, { type: 'tool/call', data: { turn: 1, step: 1, name: 'bash' }, time: 5 })
  assert.equal(definition.wire.view(folded).phase, 'tool')
  assert.equal(definition.apply(initial, { type: 'todo/write', data: {}, time: 6 }), initial, '不关心的事件返回同一引用')
})

/* ─────────────────────────── 客户端半 ─────────────────────────── */

const ReactMock = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity) }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef(initial) {
    return { current: typeof initial === 'function' ? initial() : initial }
  },
  useEffect() {},
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

let cachedModule = null
async function loadClientModule() {
  if (cachedModule) return cachedModule
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (mod) => loaded.push(mod) } }
  await import('../lib/client.js')
  assert.equal(loaded.length, 1, 'client.js 必须向 __ModuleLoader__ 注册恰好一个模块')
  cachedModule = loaded[0]
  return cachedModule
}

/** 槽位替身：本插件现在注册**两个**条目（摘要行 + 详情面板），所以要按序收齐。 */
function makeCtx(captured) {
  captured.slotKeys = []
  captured.registrations = []
  return {
    slots: {
      inject(key, callback) {
        captured.slotKeys.push(key)
        captured.dispose = callback()
      },
      register(options, component) {
        captured.registrations.push({ options, component })
        // 摘要行是第一个条目：老测例（以及下面绝大多数断言）说的都是它。
        if (captured.registrations.length === 1) {
          captured.options = options
          captured.component = component
        }
        return () => {}
      },
    },
    get(name) {
      if (name === 'timer') return { timeout: () => () => {} }
      if (name === 'locale') {
        return {
          register(ns, dict) {
            captured.locale = { ns, dict }
            return () => {}
          },
        }
      }
      return undefined
    },
  }
}

/** 详情面板组件（0.14.1 起按 id 找，不再按下标 —— 0.14.0 的左侧栏入口与设置页也进了同一个替身）。 */
function detailOf(captured) {
  return findRegistration(captured, 'dsh-status-turbo.detail').component
}

function findRegistration(captured, id) {
  const found = captured.registrations.find((entry) => entry.options.id === id)
  assert.ok(found, `必须有 id 为 ${id} 的条目`)
  return found
}

/** 只渲染详情面板的根节点，供结构断言用。 */
function detailNode(captured, snapshot) {
  return detailOf(captured)({
    useProjection: () => snapshot,
    sessionId: 's-1',
    t: (key) => key,
  })
}

test('客户端半：清单形状 + 挂到 conversation.input.dock（输入框上方那格通栏槽）', async () => {
  const mod = await loadClientModule()
  const exported = mod.factory((id) => {
    if (id === 'react') return ReactMock
    throw new Error(`客户端半 require 了未预期的模块：${id}`)
  })

  assert.equal(mod.id, 'dsh-status-turbo')
  assert.equal(exported.name, 'dsh-status-turbo')
  assert.deepEqual(exported.inject, ['slots'])
  assert.equal(typeof exported.apply, 'function')

  const captured = {}
  exported.apply(makeCtx(captured))

  /*
   * 两个独立条目（PLAN.md §2.3）：摘要行与详情面板**各自注册、各自自检**。
   * 0.20.0（用户 m07554）：摘要行从 `conversation.composer.dock`（原生底部状态行）搬到
   * `conversation.input.dock`（输入框上方的通栏槽）—— 底部那一行被原生 pill 与邻座插件的
   * pill 挤满，而这一格本来就是「输入框上方的整条通栏」，正好装状态。
   * 0.14.0/0.14.1 之后这里还多了设置页一格（0.18.0 删掉「群聊」页后只剩「全部设置项」；
   * 0.18.2 把左侧栏入口整条撤掉，话术卡并进这一页）——顺序就是 `apply` 里的接线顺序。
   */
  assert.deepEqual(captured.slotKeys, ['conversation.input.dock', 'conversation.input.dock', 'settings.section'])

  // 实读锚点：`dsh-client-ui-conversation/lib/client.js:10219-10224` 用 id "stats", order 0 占同一个槽。
  const status = findRegistration(captured, 'dsh-status-turbo.status')
  assert.equal(status.options.name, 'conversation.input.dock')
  assert.equal(status.options.order, 1, '必须排在原生 stats(order 0) 的右边，而不是插到它前面')
  assert.equal(typeof status.component, 'function')

  // 详情面板：独立 id，收起时组件自己 return null ⇒ 不占高度（PLAN §3.3.4）。
  const detail = findRegistration(captured, 'dsh-status-turbo.detail')
  assert.equal(detail.options.name, 'conversation.input.dock')
  assert.equal(detail.options.order, 0)
  assert.equal(typeof detail.component, 'function')
  assert.notEqual(detail.component, status.component, '摘要是摘要，面板是面板，不许一个组件顶两个条目')
  assert.equal(captured.options.id, 'dsh-status-turbo.status', '槽位替身按注册顺序记账，第一个必须是摘要行')

  assert.equal(typeof captured.dispose, 'function')
  assert.deepEqual(Object.keys(captured.locale.dict).sort(), ['en', 'zh'])
  assert.equal(captured.locale.ns, 'dsh-status-turbo')
})

test('客户端半 §6#11：挂载点缺 useProjection 时渲染红字，不静默消失', async () => {
  await loadClientModule()
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))

  const element = captured.component({ t: (key) => key })
  const text = textOf(element)
  assert.match(text, /挂载点未提供 useProjection/)
  assert.equal(element.type, 'div')
  assert.equal(element.props['data-dsh-status-turbo-row'], true, '错误态也留在那一行里')
  assert.equal(element.children[0].props.style.color, 'var(--dsw-alias-state-error-primary)')
})

test('客户端半：新会话无投影值 → 宽限期内不渲染（不等于错误）', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))

  assert.equal(captured.component({ useProjection: () => undefined, t: (key) => key }), null)
})

test('客户端半 U1：空闲态常驻「上回合摘要」，不再 return null', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))

  // 宿主给的 idleLine 原样用（PLAN §3.0 定义的字段）。
  const withLine = captured.component({
    useProjection: () => ({
      v: 13,
      busy: false,
      phase: 'idle',
      mountStatus: 'enabled',
      idleLine: '空闲 · 上回合 12.3s',
      lastTurnMs: 12300,
    }),
    t: (key) => key,
  })
  assert.notEqual(withLine, null, 'U1：空闲 ≠ 消失，这一格必须还在')
  assert.equal(withLine.props['data-dsh-status-turbo-row'], true)
  assert.match(textOf(withLine), /空闲 · 上回合 12\.3s/)

  // 宿主字段缺席（旧半片/投影还没补上）时，客户端用同一套规则就地拼 —— 依然不许空。
  const derived = captured.component({
    useProjection: () => ({ v: 13, busy: false, phase: 'idle', mountStatus: 'enabled', lastTurnMs: 12300 }),
    t: (key) => key,
  })
  assert.notEqual(derived, null)
  assert.match(textOf(derived), /空闲/)
  assert.match(textOf(derived), /上回合 12\.3秒/)

  // 连 lastTurnMs 都没有：降级成阶段名，但**仍然**是这一行，不能变成 null。
  const bare = captured.component({
    useProjection: () => ({ v: 13, busy: false, phase: 'idle', mountStatus: 'enabled' }),
    t: (key) => key,
  })
  assert.notEqual(bare, null)
  assert.match(textOf(bare), /空闲/)
  assert.doesNotMatch(textOf(bare), /undefined|null|NaN/)
})

test('客户端半 P0-1：mountStatus 三态 —— enabled 正常 / disabled return null / 缺失红格', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))
  const view = (extra) => captured.component({ useProjection: () => extra, t: (key) => key })

  // enabled：正常渲染（这里用空闲态，正好覆盖"开关开着 + 空闲"这一格）。
  const enabled = view({ v: 13, busy: false, phase: 'idle', mountStatus: 'enabled' })
  assert.notEqual(enabled, null)
  assert.equal(enabled.props['data-dsh-status-turbo-row'], true)

  // disabled：宿主明确关掉了状态条 ⇒ 界面上一格都不该有（旧版本这是"死开关"）。
  assert.equal(view({ v: 13, busy: false, phase: 'idle', mountStatus: 'disabled' }), null)
  assert.equal(view({ v: 13, busy: true, phase: 'tool', mountStatus: 'disabled' }), null)

  // 缺失/未知：读不到开关状态 = 半片装配不对。§9#3 不许静默 ⇒ 红格。
  for (const mountStatus of [undefined, null, 'nonsense']) {
    const element = view({ v: 13, busy: false, phase: 'idle', mountStatus })
    assert.notEqual(element, null, '开关状态读不到必须报出来，而不是悄悄不画')
    assert.equal(element.props['data-dsh-status-turbo-row'], true)
    assert.equal(element.children[0].props.style.color, 'var(--dsw-alias-state-error-primary)')
  }
})

test('客户端半 §9#3：投影缺席超过宽限期 → 黄色告警，不静默消失', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))

  // 组件靠 useRef(挂载时刻) 计时；把 Date.now 推到宽限期之后，模拟"等了 30 秒还没来"。
  const realNow = Date.now
  const base = realNow()
  Date.now = () => base
  try {
    // 第一次渲染把挂载时刻钉在 base
    assert.equal(captured.component({ useProjection: () => undefined, t: (key) => key }), null)
    Date.now = () => base + 30_000
    const element = captured.component({ useProjection: () => undefined, t: (key) => key })
    assert.notEqual(element, null, '超过宽限期后必须渲染出提示，而不是继续返回 null')
    assert.match(textOf(element), /宿主半/)
    // 着色挂在 pill 自己身上（外层是居中 flex 容器，本身不带颜色）。
    assert.equal(element.children[0].props.style.color, 'var(--dsw-alias-state-warn-primary)')
  } finally {
    Date.now = realNow
  }
})

test('客户端半：busy 时一行显示阶段 / 工具名 / 紧凑耗时 / 本步 token（0.19.2 起不再重复档位）', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))

  const now = Date.now()
  const snapshot = {
    v: 13,
    mountStatus: 'enabled',
    busy: true,
    phase: 'tool',
    tool: 'bash',
    turn: 1,
    phaseStartedAt: now - 5000,
    turnStartedAt: now - 9000,
    lastProgressAt: now - 1000,
    stepTokens: 3100,
    turnTokens: 12000,
    hitRate: 0.71,
    effort: 'low',
    noProgressMs: 90000,
  }
  const view = captured.component({ useProjection: () => snapshot, t: (key) => key })
  const text = textOf(view)
  assert.match(text, /执行工具/)
  assert.doesNotMatch(text, /档位/, '0.19.2：档位不再进状态条（原生选择器已经写着同一个值），只在详情面板里')
  assert.match(text, /\bbash\b/, '工具名要能一眼认出"在等什么"')
  assert.match(text, /\b5s\b/, '必须带上本阶段已耗时（0.19.2 起紧凑写法：5000ms → 5s）')
  assert.match(text, /3\.1K tok/, '0.19.2：本步 token 只留数量，不再重复“本步”两字')
  assert.doesNotMatch(text, /仍在运行|没有新进展/, '未超阈值时不该报警')
  // D6(b)/S6：本步缓存命中率**不进**这一行，只在详情面板里。
  assert.doesNotMatch(text, /71%|命中率/, '底栏不许出现缓存命中率')

  /*
   * 外观契约（0.4.0 起换成"并进原生 composer 底部状态行"）：
   * 逐条对应 `@deepseek-ai/dsh-client-ui-chat/lib/client.js:6893` 里 StatsPills 的
   * `.iq1doa_root/.iq1doa_pill` —— 行是居中 flex + 12px 间距，pill 是 999px 圆角的透明 inline-flex。
   * 这些数字写错一个，我这一格就会和旁边那格明显不是一套东西。
   */
  assert.equal(view.props.style.display, 'flex')
  assert.equal(view.props.style.justifyContent, 'center')
  assert.equal(view.props.style.gap, '12px')
  assert.equal(view.props['data-dsh-status-turbo-row'], true)
  const pills = view.children
  assert.ok(pills.length >= 3, '阶段 / 本步 token / 详情开关 各占一个 pill（档位 0.19.2 起不再占位）')
  /*
   * 0.21.0：行尾多了一个「复制话术」按钮（用户 m08351）。它是 `<button>`（键盘可点）而不是 pill，
   * 但样式复用 `PILL_STYLE`，所以视觉上仍是同一行；这里把它单列，pill 契约照旧逐条卡死。
   */
  const copyBrief = pills[pills.length - 1]
  assert.equal(typeof copyBrief.type, 'function', '0.21.0：行尾是「复制话术」按钮组件')
  for (const p of pills.slice(0, -1)) {
    assert.equal(p.props.style.display, 'inline-flex')
    assert.equal(p.props.style.borderRadius, '999px')
    assert.equal(p.props.style.background, 'transparent')
    assert.equal(p.props.style.color, 'var(--dsw-alias-label-tertiary)')
    assert.equal(p.props.style.font, 'inherit', '字体必须继承原生那一行，不能自带字号')
  }
})

test('客户端半：档位不再进状态条，且不显示 empty/undefined（0.19.2）', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))
  const now = Date.now()
  const text = textOf(
    captured.component({
      useProjection: () => ({
        v: 13,
        mountStatus: 'enabled',
        busy: true,
        phase: 'streaming',
        phaseStartedAt: now - 1000,
        lastProgressAt: now - 500,
        stepTokens: 0,
        effort: null,
        noProgressMs: 90000,
      }),
      t: (key) => key,
    }),
  )
  assert.doesNotMatch(text, /档位/, '0.19.2：状态条不再有档位 pill')
  assert.doesNotMatch(text, /本步/, '0.19.2：token pill 不再写“本步”两字')
  assert.doesNotMatch(text, /undefined|null|NaN/)
})

test('客户端半 §6#8：超过 noProgressMs 未推进 → 告警 pill 出现并着色', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))

  const now = Date.now()
  const stalled = {
    v: 13,
    mountStatus: 'enabled',
    busy: true,
    phase: 'tool',
    tool: 'bash',
    turn: 1,
    phaseStartedAt: now - 200000,
    turnStartedAt: now - 201000,
    lastProgressAt: now - 200000,
    stepTokens: 3100,
    turnTokens: 12000,
    hitRate: 0.71,
    noProgressMs: 90000,
  }
  // ⚠ 现在是一个 14×14 的行内 SVG（不是字符），所以不能断言字面量；断言"那一格被着成了告警色 + 文案在场"。
  // 告警 pill 不再固定在行尾（后面还跟着"点开看详情"的开关格），所以按文案定位它自己。
  const view = captured.component({ useProjection: () => stalled, t: (key) => key })
  assert.match(textOf(view), /无新输出/)
  const stallPill = view.children.find((child) => /无新输出/.test(textOf(child)))
  assert.ok(stallPill, '告警必须真的成为一个 pill 出现在这一行里')
  assert.equal(stallPill.props.style.color, 'var(--dsw-alias-state-warn-primary)')
  assert.equal(stallPill.props.style.background, 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)')
  assert.match(String(stallPill.props.title), /工具仍在运行，只是还没有新输出/, '0.19.2：判据全文退到 title，视觉只留四个字')

  const stalledWhileAssembling = { ...stalled, phase: 'assembling', tool: null }
  const view2 = captured.component({ useProjection: () => stalledWhileAssembling, t: (key) => key })
  assert.match(textOf(view2), /组装提示词/)
  assert.match(textOf(view2), /无新进展/)
  assert.equal(
    view2.children.find((child) => /无新进展/.test(textOf(child))).props.style.color,
    'var(--dsw-alias-state-warn-primary)',
  )
})

test('客户端半：投影版本错配 → 红字报错，而不是画出错误数据', async () => {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))

  // 客户端现在认 v7；宿主报旧 v6 ⇒ 必须红格报错，而不是拿新字段硬画。
  const view = captured.component({ useProjection: () => ({ v: 6, busy: true, phase: 'tool' }), t: (key) => key })
  assert.match(textOf(view), /投影版本错配（宿主 v6 ≠ 客户端 v13）/)
  assert.equal(view.props['data-dsh-status-turbo-row'], true, '错误态也必须留在同一行里可见（§9 第 3 条）')
})

test('客户端半：ctx.slots 不可用时 console.error，绝不静默', async () => {
  const mod = await loadClientModule()
  const exported = mod.factory((id) => (id === 'react' ? ReactMock : undefined))
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    exported.apply({ get: () => undefined })
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /ctx\.slots 不可用/)
})

test('客户端半：3 秒内没挂上 → console.error 点名挂载点（失败可见性的边界）', async () => {
  const mod = await loadClientModule()
  const exported = mod.factory((id) => (id === 'react' ? ReactMock : undefined))
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const scheduled = []
    exported.apply({
      slots: { inject: () => {}, register: () => () => {} },
      get: (name) => (name === 'timer' ? { timeout: (fn) => scheduled.push(fn) } : undefined),
    })
    // 两个条目**各自独立自检**：面板挂不上不能连坐摘要行，反之亦然（PLAN §3.3.5）。
    assert.equal(scheduled.length, 2, '摘要行与详情面板必须各安排一次挂载自检')
    scheduled[0]()
    scheduled[1]()
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 2)
  assert.match(errors[0], /状态条 3 秒内未能挂载到 conversation\.input\.dock/)
  assert.match(errors[1], /详情面板 3 秒内未能挂载到 conversation\.input\.dock/)
})

test('客户端半 E-A01：注册抛错时点名槽位与条目，绝不静默（R7 不重试）', async () => {
  const mod = await loadClientModule()
  const exported = mod.factory((id) => (id === 'react' ? ReactMock : undefined))
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  let injectCalls = 0
  try {
    exported.apply({
      slots: {
        inject: (_key, callback) => {
          injectCalls += 1
          callback()
        },
        register: () => {
          throw new Error('slot "conversation.input.dock" is not declared')
        },
      },
      get: (name) => (name === 'timer' ? { timeout: () => () => {} } : undefined),
    })
  } finally {
    console.error = original
  }
  assert.equal(injectCalls, 3, '一个条目失败不能阻止另一个条目尝试注册；三个注入点各自尝试一次')
  assert.equal(errors.length, 3, '0.18.2 起左侧栏入口整条撤掉（话术卡并进设置页），失败体是 3 个')
  const all = errors.join('\n')
  assert.match(all, /状态条注册到 conversation\.input\.dock 失败/)
  assert.match(all, /详情面板注册到 conversation\.input\.dock 失败/)
  assert.match(all, /设置页挂载失败/)
})

/* ──────────────────── UI 重做深度验收（U1–U7 / D5 / D6 / R2 / S6 / S12） ──────────────────── */

const WARN = 'var(--dsw-alias-state-warn-primary)'
const ERROR = 'var(--dsw-alias-state-error-primary)'
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

/** wire v7 的一整份快照（0.6.5 起客户端认 v7：33 键 + enhancement（含 mode），客户端真正读的那些）。 */
function wireSnapshot(overrides) {
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
    hookFaults: [],
    idleLine: null,
    lastSpill: null,
    waitTools: [],
    waitKind: null,
    subagents: 0,
    slowMs: 60000,
    enhancement: { active: true, mode: 'host-pruner', reason: null },
    ...overrides,
  }
}

async function freshCapture() {
  const captured = {}
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply(makeCtx(captured))
  return captured
}

/** 分区（标题节点在前，值行在后）。 */
function sectionOf(panel, title) {
  const section = panel.children.find(
    (child) => Array.isArray(child.children) && child.children.some((node) => textOf(node) === title),
  )
  assert.ok(section, `面板必须有序标题为「${title}」的分区`)
  return section
}

/** 只看有没有该标题的分区，不抛（给「缺席时不该出现某分区」用）。 */
function findSection(panel, title) {
  return panel.children.find(
    (child) => Array.isArray(child.children) && child.children.some((node) => textOf(node) === title),
  )
}

function openPanel(captured, sessionId, snapshot) {
  const status = captured.component({ useProjection: () => snapshot, sessionId, t: (key) => key })
  // 进入面板的唯一入口就是点摘要行那一格。
  status.props.onClick()
  return detailOf(captured)({ useProjection: () => snapshot, sessionId, t: (key) => key })
}

test('客户端半 U2：层级色 —— 标题/数值/告警/错误四种颜色各自归位', async () => {
  const captured = await freshCapture()
  const snapshot = wireSnapshot({
    prefixEpoch: 2,
    prefixCause: 'compaction-start',
    prefixAt: Date.now() - 60_000,
    hookFaults: [{ at: Date.now() - 30_000, hook: 'tool/enhance', message: '语法树解析失败' }],
  })
  const view = captured.component({ useProjection: () => snapshot, sessionId: 'u2', t: (key) => key })

  const phasePill = view.children[0]
  const phaseLabel = phasePill.children.find((child) => textOf(child) === '执行工具')
  assert.equal(phaseLabel.props.style.color, 'var(--dsw-alias-label-secondary)', '阶段名/工具名用 secondary')

  const stepPill = view.children.find((child) => /本步 token/.test(String(child.props && child.props.title)))
  assert.equal(stepPill.props.style.color, 'var(--dsw-alias-label-tertiary)', '纯数值 pill 继承父级 tertiary')

  const prefixPill = view.children.find((child) => /前缀已失效/.test(textOf(child)))
  assert.equal(prefixPill.props.style.color, WARN)
  assert.equal(prefixPill.props.style.background, `color-mix(in srgb, ${WARN} 10%, transparent)`)

  const faultRow = view.children.find((child) => /工具增强失败/.test(textOf(child)))
  assert.equal(faultRow.type, 'div', '故障指路必须自成一条红格')
  assert.equal(faultRow.children[0].props.style.color, ERROR)

  // 面板里：值行是 bullet 型（secondary），等宽值行不额外着色（继承 tertiary）。
  const panel = openPanel(captured, 'u2', snapshot)
  const turnSection = sectionOf(panel, '本回合')
  const phaseRow = turnSection.children.find((child) => /阶段/.test(textOf(child)))
  assert.equal(phaseRow.children[1].props.style.color, 'var(--dsw-alias-label-secondary)')
  const stepRow = turnSection.children.find((child) => /步数/.test(textOf(child)))
  assert.equal(stepRow.children[1].props.style.fontFamily, MONO, '等宽数字行')
  assert.equal(stepRow.children[1].props.style.color, undefined, '等宽行不额外着色，继承父级 tertiary')

  const faultSection = sectionOf(panel, '最近的故障')
  const faultLine = faultSection.children[1]
  assert.equal(faultLine.props.style.color, ERROR, '故障诊断文案用错误色')
  assert.match(textOf(faultLine), /tool\/enhance：语法树解析失败/)
})

test('客户端半 U4：摘要行 flexWrap + 长告警文本截断（窄屏不溢出）', async () => {
  const clientSource = readSource('../lib/client.js')
  assert.match(clientSource, /flexWrap: 'wrap'/, 'ROW_STYLE 必须 flexWrap:wrap')

  const captured = await freshCapture()
  // 投影缺席超过宽限期 → 黄格；这条文案最长，正是窄屏溢出的元凶。
  const realNow = Date.now
  const base = realNow()
  Date.now = () => base
  try {
    assert.equal(captured.component({ useProjection: () => undefined, sessionId: 'u4', t: (key) => key }), null)
    Date.now = () => base + 30_000
    const element = captured.component({ useProjection: () => undefined, sessionId: 'u4', t: (key) => key })
    const message = element.children[0].children.find((child) => /超过 8 秒/.test(textOf(child)))
    assert.equal(message.props.style.maxWidth, '100%')
    assert.equal(message.props.style.overflow, 'hidden')
    assert.equal(message.props.style.textOverflow, 'ellipsis')
    assert.equal(message.props.style.whiteSpace, 'nowrap')
  } finally {
    Date.now = realNow
  }

  // 面板根节点也必须收得住（U4 的另一半）。
  const panel = openPanel(await freshCapture(), 'u4b', wireSnapshot())
  assert.equal(panel.props.style.maxWidth, '100%')
  assert.equal(panel.props.style.boxSizing, 'border-box')
  assert.equal(panel.props.style.overflow, 'hidden')
  for (const rowNode of panel.children.slice(1)) {
    for (const line of rowNode.children.slice(1)) {
      assert.equal(line.props.style.whiteSpace, 'nowrap')
      assert.equal(line.props.style.overflow, 'hidden')
    }
  }
})

test('客户端半：分隔点间距对齐宿主（0 6px，不是 0 1px）', async () => {
  const clientSource = readSource('../lib/client.js')
  assert.match(clientSource, /margin: '0 6px'/, 'sep() 必须用宿主的 0 6px')
  assert.doesNotMatch(clientSource, /margin: '0 1px'/, '旧的 0 1px 是肉眼可见的排版偏差')

  const captured = await freshCapture()
  const view = captured.component({ useProjection: () => wireSnapshot(), sessionId: 'sep', t: (key) => key })
  const sepNode = view.children[0].children.find((child) => textOf(child) === '·')
  assert.equal(sepNode.props.style.margin, '0 6px')
  assert.equal(sepNode.props.style.color, 'var(--dsw-alias-separator-primary)')
})

test('客户端半 U1/D6/S6：底栏一行摘要与详情面板的分工', async () => {
  const captured = await freshCapture()
  const snapshot = wireSnapshot()
  const sessionId = 'split'
  const status = captured.component({ useProjection: () => snapshot, sessionId, t: (key) => key })
  const line = textOf(status)

  // 空闲态是常驻的一行上回合摘要（U1）—— 这里换成空闲再确认一次这一格没有消失。
  const idle = wireSnapshot({ busy: false, phase: 'idle', idleLine: '空闲 · 上回合 3m20s' })
  const idleView = captured.component({ useProjection: () => idle, sessionId: 'split-idle', t: (key) => key })
  assert.notEqual(idleView, null)
  assert.match(textOf(idleView), /空闲 · 上回合 3m20s/)

  assert.doesNotMatch(line, /命中率|71%/, 'S6/D6(b)：本步缓存命中率不许加回状态条')
  assert.doesNotMatch(line, /bytes|locator|最慢/, 'S12：底栏不显示瘦身与最慢工具明细')

  // 点开 → 详情面板；命中率、瘦身路径、最慢工具都在面板里。
  const rich = wireSnapshot({
    lastSpill: { bytes: 184320, locator: '/tmp/dsh-spill/turn-7.txt', at: Date.now() },
    topTools: [
      { name: 'bash', key: 'bash', count: 12, maxMs: 42000, avgMs: 9100 },
      { name: 'read', key: 'read', count: 30, maxMs: 1200, avgMs: 140 },
    ],
  })
  const panel = openPanel(captured, sessionId, rich)
  const panelText = textOf(panel)
  assert.match(panelText, /本步缓存命中率/)
  assert.match(panelText, /71%/)
  assert.match(panelText, /184320 bytes → \/tmp\/dsh-spill\/turn-7\.txt/)
  assert.match(panelText, /bash · 12 次 · 最慢 42秒 · 平均 9\.1秒/)
  assert.match(panelText, /read · 30 次 · 最慢 1\.2秒 · 平均 140毫秒/)

  const spillLine = sectionOf(panel, '最近瘦身').children[1]
  assert.equal(spillLine.props.style.fontFamily, MONO, '落盘路径必须等宽')
  assert.equal(spillLine.props.style.userSelect, undefined, 'locator 必须能被选中复制')
})

test('客户端半：详情面板分区顺序固定（0.6.4 起 11 个分区、0.7.0 起 12 个，条件分区在末尾）', async () => {
  const captured = await freshCapture()
  const snapshot = wireSnapshot({
    lastSpill: { bytes: 1024, locator: '/tmp/x', at: Date.now() },
    hookFaults: [{ at: Date.now(), hook: 'tool/enhance', message: 'boom' }],
  })
  const panel = openPanel(captured, 'order', snapshot)
  const titles = panel.children.slice(1).map((section) => textOf(section.children[0]))
  assert.deepEqual(titles, [
    '现在',
    '活动流',
    '本回合',
    '上回合',
    '缓存与用量',
    '前缀',
    '最慢的工具',
    '等待占用',
    '会话轮换',
    '最近瘦身',
    '工具增强',
    '交接文档',
    '最近的故障',
  ])

  // 没有瘦身 / 没有故障时不出现那两个分区（条件分区）；「工具增强」恒在。
  const bare = openPanel(captured, 'order-bare', wireSnapshot())
  assert.deepEqual(
    bare.children.slice(1).map((section) => textOf(section.children[0])),
    ['现在', '活动流', '本回合', '上回合', '缓存与用量', '前缀', '最慢的工具', '等待占用', '会话轮换', '工具增强', '交接文档'],
  )

  // 上回合没有数据时给一句人话，不是空白。
  assert.match(textOf(sectionOf(openPanel(captured, 'no-turn', wireSnapshot({ lastTurnMs: null })), '上回合')), /没有已结束的上回合/)
})

test('0.6.5 面板契约（新增）：「工具增强」三态 mode —— 宿主裁剪 / 本地裁剪 / 未启用，都是灰色 info 行', async () => {
  const captured = await freshCapture()

  // ① 宿主 pruner 在位：灰色 info 行，文案明说是宿主裁的。
  const onPanel = openPanel(captured, 'enh-on', wireSnapshot({ enhancement: { active: true, mode: 'host-pruner', reason: null } }))
  const onSection = sectionOf(onPanel, '工具增强')
  assert.notEqual(onSection, null, '「工具增强」分区必须存在')
  const onLine = onSection.children[1]
  assert.equal(onLine.props.style.color, 'var(--dsw-alias-label-secondary)', '必须是灰色 info，不是红字故障')
  assert.match(textOf(onLine), /已启用（宿主裁剪）/)
  assert.equal(textOf(onLine).includes('ctx'), false, '面板文案不得泄漏 ctx（U7 黑名单）')
  assert.equal(findSection(onPanel, '最近的故障'), undefined, '在位时不该有故障分区')

  // ② 0.6.5 本地裁剪（拿不到宿主 pruner）：仍然启用，但明说是本地裁的。
  const localPanel = openPanel(
    captured,
    'enh-local',
    wireSnapshot({ enhancement: { active: true, mode: 'local-trim', reason: null } }),
  )
  const localSection = sectionOf(localPanel, '工具增强')
  assert.notEqual(localSection, null)
  const localLine = localSection.children[1]
  assert.equal(localLine.props.style.color, 'var(--dsw-alias-label-secondary)', '本地裁剪是正常路径，必须仍是灰 info')
  assert.match(textOf(localLine), /已启用（本地裁剪）/)
  assert.equal(textOf(localLine).includes('ctx'), false, '机器串不得原样进面板')
  assert.equal(textOf(localLine).includes('toolResultPruner'), false, '机器串不得原样进面板')
  assert.equal(findSection(localPanel, '最近的故障'), undefined, '本地裁剪不是故障：recentFaults 必须为空')

  // ③ 真的没有落盘后端：未启用 + 人话理由，仍是灰 info、零故障。
  const offPanel = openPanel(
    captured,
    'enh-off',
    wireSnapshot({ enhancement: { active: false, mode: 'off', reason: 'no ctx.spillStore backend loaded' } }),
  )
  const offSection = sectionOf(offPanel, '工具增强')
  assert.notEqual(offSection, null)
  const offLine = offSection.children[1]
  assert.equal(offLine.props.style.color, 'var(--dsw-alias-label-secondary)')
  assert.match(textOf(offLine), /未启用/)
  assert.match(textOf(offLine), /没有落盘后端/)
  assert.equal(textOf(offLine).includes('ctx'), false, '机器串不得原样进面板')
  assert.equal(textOf(offLine).includes('spillStore'), false, '机器串不得原样进面板')
  assert.equal(findSection(offPanel, '最近的故障'), undefined, '缺席不是故障：recentFaults 必须为空')
})

test('客户端半 0.6.1：「等待占用」分区按 kind 分文案、带累计时长，空态另说', async () => {
  const captured = await freshCapture()
  const rich = wireSnapshot({
    waitTools: [
      { name: 'ask_user_question', key: 'ask_user_question', count: 1, maxMs: 900014, avgMs: 900014, sumMs: 900014, kind: 'human' },
      { name: 'wait_agent', key: 'wait_agent', count: 26, maxMs: 900014, avgMs: 238619, sumMs: 6204094, kind: 'subagent' },
    ],
  })
  const panel = openPanel(captured, 'waits', rich)
  const panelText = textOf(panel)
  // 900014ms = 15分0秒；6204094ms = 1小时43分24秒（秒用 floor，见 0.6.3 任务书的硬断言）
  assert.match(panelText, /等你回答 · ask_user_question · 1 次 · 累计 15分0秒 · 最慢 15分0秒/)
  assert.match(panelText, /等子代理 · wait_agent · 26 次 · 累计 1小时43分24秒 · 最慢 15分0秒/)

  // 「最慢的工具」空态改口径，且与等待占用空态互不混淆。
  const empty = openPanel(captured, 'waits-empty', wireSnapshot())
  assert.match(textOf(sectionOf(empty, '最慢的工具')), /本会话还没有真执行的工具调用/)
  assert.match(textOf(sectionOf(empty, '等待占用')), /本会话还没有等待类的工具调用/)
})

test('客户端半 0.6.3：慢行加 ⚠ 与参数摘要，分区末尾才给后台任务提示', async () => {
  const captured = await freshCapture()
  const panel = openPanel(
    captured,
    'slow',
    wireSnapshot({
      topTools: [
        { name: 'bash', key: 'bash', count: 3, maxMs: 18726648, avgMs: 6242216, argPreview: 'npm test -- --slow', slow: true },
        { name: 'read', key: 'read', count: 2, maxMs: 140, avgMs: 140, argPreview: '/tmp/a.txt', slow: false },
      ],
    }),
  )
  const text = textOf(panel)
  // 18726648ms = 5小时12分6秒；6242216ms = 1小时44分2秒（floor 秒）。
  assert.match(text, /⚠ bash · 3 次 · 最慢 5小时12分6秒 · 平均 1小时44分2秒 · npm test -- --slow/)
  assert.match(text, /read · 2 次 · 最慢 140毫秒 · 平均 140毫秒 · \/tmp\/a\.txt/)
  // 提示只在真出现慢行时出现，且阈值用中文单位；只有慢行才加 ⚠（read 行没有）。
  assert.match(text, /超过 1分0秒 的调用可交给后台任务插件 run_command/)
  assert.doesNotMatch(text, /⚠ read/)

  // 没有慢行 ⇒ 不给提示（不制造噪音）。
  const quiet = openPanel(
    captured,
    'slow-none',
    wireSnapshot({ topTools: [{ name: 'read', key: 'read', count: 1, maxMs: 140, avgMs: 140, argPreview: null, slow: false }] }),
  )
  assert.doesNotMatch(textOf(quiet), /可交给后台任务插件/)
})

test('客户端半 0.6.1：状态条在等待态把阶段文字换成「等子代理 / 等你回答」', async () => {
  const captured = await freshCapture()

  const human = captured.component({
    useProjection: () => wireSnapshot({ waitKind: 'human', tool: 'ask_user_question' }),
    sessionId: 'wait-human',
    t: (key) => key,
  })
  assert.match(textOf(human), /⏸ 等你回答/)
  assert.doesNotMatch(textOf(human), /执行工具/, '等待态不再显示阶段名')

  const subagent = captured.component({
    useProjection: () => wireSnapshot({ waitKind: 'subagent', tool: 'wait_agent', subagents: 3 }),
    sessionId: 'wait-subagent',
    t: (key) => key,
  })
  assert.match(textOf(subagent), /⏳ 等子代理/)
  assert.match(textOf(subagent), /本轮 3 个/, 'subagents > 0 时显示本轮派生数')

  // subagents 为 0 时不显示那一段（优雅降级）。
  const zero = captured.component({
    useProjection: () => wireSnapshot({ waitKind: 'subagent', tool: 'wait_agent', subagents: 0 }),
    sessionId: 'wait-subagent-zero',
    t: (key) => key,
  })
  assert.match(textOf(zero), /⏳ 等子代理/)
  assert.doesNotMatch(textOf(zero), /本轮/)

  // 0.6.3：第 4 类「等后台任务」同样走等待态文案。
  const job = captured.component({
    useProjection: () => wireSnapshot({ waitKind: 'job', tool: 'job_output' }),
    sessionId: 'wait-job',
    t: (key) => key,
  })
  assert.match(textOf(job), /⏳ 等后台任务/)
  assert.doesNotMatch(textOf(job), /执行工具/, '等后台任务也是等待态，不显示阶段名')

  // 非等待态维持原阶段名（不回归）。
  const exec = captured.component({
    useProjection: () => wireSnapshot({ waitKind: null }),
    sessionId: 'wait-none',
    t: (key) => key,
  })
  assert.match(textOf(exec), /执行工具/)
  assert.doesNotMatch(textOf(exec), /等子代理|等你回答/)
})

test('客户端半：详情面板默认收起、点击开合，收起时必须 return null', async () => {
  const captured = await freshCapture()
  const snapshot = wireSnapshot()
  const sessionId = 'toggle'
  const panel = detailOf(captured)

  assert.equal(panel({ useProjection: () => snapshot, sessionId, t: (key) => key }), null, '默认收起：不许留一条空带')
  assert.match(textOf(captured.component({ useProjection: () => snapshot, sessionId, t: (key) => key })), /▸ 详情/)

  const status = captured.component({ useProjection: () => snapshot, sessionId, t: (key) => key })
  status.props.onClick()
  assert.notEqual(panel({ useProjection: () => snapshot, sessionId, t: (key) => key }), null)
  assert.match(textOf(captured.component({ useProjection: () => snapshot, sessionId, t: (key) => key })), /▾ 收起/)

  // 再点一次关回去；摘要是"点开那个开关"，所以它自己始终还在。
  status.props.onClick()
  assert.equal(panel({ useProjection: () => snapshot, sessionId, t: (key) => key }), null)
  assert.notEqual(captured.component({ useProjection: () => snapshot, sessionId, t: (key) => key }), null)

  // 会话隔离：开合状态按 sessionId 记账（与宽限计时同一手法，不许用 useRef）。
  const opened = captured.component({ useProjection: () => snapshot, sessionId: 'toggle-other', t: (key) => key })
  opened.props.onClick()
  assert.notEqual(panel({ useProjection: () => snapshot, sessionId: 'toggle-other', t: (key) => key }), null)
  assert.equal(panel({ useProjection: () => snapshot, sessionId, t: (key) => key }), null, '别的会话点开不该打开这个会话的面板')
})

test('客户端半：面板的失败表现 —— 快照缺席 / 宿主关掉 / 渲染抛错', async () => {
  const captured = await freshCapture()
  const sessionId = 'faults'
  const panel = detailOf(captured)
  const snapshot = wireSnapshot()

  captured.component({ useProjection: () => snapshot, sessionId, t: (key) => key }).props.onClick()

  assert.equal(panel({ useProjection: () => undefined, sessionId, t: (key) => key }), null, '快照缺席 ⇒ 不画')
  assert.equal(panel({ useProjection: undefined, sessionId, t: (key) => key }), null, '连挂载契约都没有 ⇒ 不画')
  assert.equal(
    panel({ useProjection: () => wireSnapshot({ mountStatus: 'disabled' }), sessionId, t: (key) => key }),
    null,
    '宿主关掉状态条时详情面板也不该出现',
  )

  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  let bombed
  try {
    bombed = panel({
      useProjection: () => ({
        ...snapshot,
        get phase() {
          throw new Error('boom')
        },
      }),
      sessionId,
      t: (key) => key,
    })
  } finally {
    console.error = original
  }
  assert.match(textOf(bombed), /dsh-status-turbo: 详情面板渲染失败：boom/)
  assert.equal(bombed.children[0].props.style.color, ERROR)
  assert.equal(errors.length, 1, '渲染期异常必须在 console 侧也留一条')
})

test('客户端半 B4：前缀失效 —— 5 分钟内告警，过期只在面板里留档', async () => {
  const captured = await freshCapture()
  const sessionId = 'prefix'
  const now = Date.now()
  const fresh = wireSnapshot({ prefixEpoch: 1, prefixCause: 'bulk-injection', prefixAt: now - 60_000 })
  const freshView = captured.component({ useProjection: () => fresh, sessionId, t: (key) => key })
  assert.match(textOf(freshView), /前缀已失效/)
  assert.doesNotMatch(textOf(freshView), /1 次|100%/, '状态条只说失效，不给次数/百分比')

  const stale = wireSnapshot({ prefixEpoch: 1, prefixCause: 'compaction-end', prefixAt: now - 600_000 })
  assert.doesNotMatch(textOf(captured.component({ useProjection: () => stale, sessionId, t: (key) => key })), /前缀已失效/)

  // 从未失效：面板照样把话说清楚，不留空白。
  const never = openPanel(captured, 'prefix-none', wireSnapshot({ prefixEpoch: 0 }))
  assert.match(textOf(sectionOf(never, '前缀')), /本会话前缀未失效/)

  const panelText = textOf(openPanel(captured, 'prefix-panel', fresh))
  assert.match(panelText, /失效次数/)
  assert.match(panelText, /大块结果注入/)
  assert.match(panelText, /说明：压缩会重写历史，提示词缓存前缀随之作废；命中率会在接下来几步里下降，这不是故障。/)
})

test('客户端半 U5：宽限计时按 sessionId 记账，且表有界（>128 整体重置）', async () => {
  const captured = await freshCapture()
  const realNow = Date.now
  const base = realNow()
  const projection = () => undefined
  Date.now = () => base
  try {
    // a 在 base 被记下；b 等到 base+30s 才第一次出现。
    assert.equal(captured.component({ useProjection: projection, sessionId: 'a', t: (key) => key }), null)

    Date.now = () => base + 30_000
    // a 已经等过一轮 ⇒ 黄格；b 是同一时刻新记的 ⇒ 仍在宽限期内。两边共用一份计时就做不到这点。
    assert.match(textOf(captured.component({ useProjection: projection, sessionId: 'a', t: (key) => key })), /宿主半/)
    assert.equal(captured.component({ useProjection: projection, sessionId: 'b', t: (key) => key }), null)

    // 灌满并越过上限：表被整体清空，a 的计时重新开始 ⇒ 又回到宽限期内。
    for (let index = 0; index < 200; index += 1) {
      captured.component({ useProjection: projection, sessionId: `bulk-${index}`, t: (key) => key })
    }
    assert.equal(
      captured.component({ useProjection: projection, sessionId: 'a', t: (key) => key }),
      null,
      '超过 128 条必须整体重置，不允许无界增长',
    )
  } finally {
    Date.now = realNow
  }
})

/** 全新的模块实例：模块级的挂载记账/计时表跨 apply 复用，验边界时必须拿一份干净的。 */
async function loadFreshClient(tag) {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (mod) => loaded.push(mod) } }
  await import(`../lib/client.js?fresh=${tag}`)
  assert.equal(loaded.length, 1, `client.js 必须向 __ModuleLoader__ 注册恰好一个模块（${tag}）`)
  return loaded[0].factory((id) => (id === 'react' ? ReactMock : undefined))
}

test('客户端半 U6/D5：挂载失败标志写 document.body.dataset，两个条目都挂上后清除', async () => {
  const makeDataset = (writes) =>
    new Proxy(
      {},
      {
        set: (target, key, value) => {
          writes.push([key, value])
          target[key] = value
          return true
        },
      },
    )

  const originalDocument = globalThis.document
  const originalError = console.error
  console.error = () => {}
  try {
    // ① 一次都没挂上：自检到点后必须把"挂载失败"写在 body 上（D5 唯一允许的宿主 DOM 写入）。
    const failures = []
    globalThis.document = { body: { dataset: makeDataset(failures) } }
    ;(await loadFreshClient('u6a')).apply({
      slots: { inject: () => {}, register: () => () => {} },
      get: (name) => (name === 'timer' ? { timeout: (fn) => fn() } : undefined),
    })
    assert.deepEqual(failures, [['dshTurboMountFailed', '1']], '两个条目都没挂上 ⇒ 写 1，且同一状态不重复写')

    // ② 两个条目都挂上：先 1（面板还没挂）再 0（清除），每次状态变化写一次。
    const mounted = []
    globalThis.document = { body: { dataset: makeDataset(mounted) } }
    ;(await loadFreshClient('u6b')).apply({
      slots: {
        inject: (_key, callback) => callback(),
        register: () => () => {},
      },
      get: (name) => (name === 'timer' ? { timeout: () => () => {} } : undefined),
    })
    assert.deepEqual(
      mounted,
      [
        ['dshTurboMountFailed', '1'],
        ['dshTurboMountFailed', '0'],
      ],
      '两个条目都挂上 ⇒ 清成 0',
    )
  } finally {
    console.error = originalError
    globalThis.document = originalDocument
  }
})

test('客户端半 U7：所有用户可见文案都不得泄漏实现词汇（故障诊断文案走白名单）', async () => {
  const captured = await freshCapture()
  const BLACKLIST = /投影|projection|fiber|host|ctx|slot/i
  // SPEC U7 明确放行的三处故障诊断文案：它们的职责恰恰是把"哪里坏了"指给运维看。
  const WHITELIST = ['挂载点未提供 useProjection', '投影版本错配', '宿主半似乎没起来']

  const scrub = (value) => WHITELIST.reduce((text, allowed) => text.split(allowed).join(''), value)

  const normalStates = [
    wireSnapshot(),
    wireSnapshot({ busy: false, phase: 'idle', idleLine: '空闲 · 上回合 12.3s' }),
    wireSnapshot({ phase: 'assembling', tool: null, effort: null, stepTokens: 0 }),
    wireSnapshot({ prefixEpoch: 3, prefixCause: 'compaction-start', prefixAt: Date.now() - 1000 }),
    wireSnapshot({ hookFaults: [{ at: Date.now(), hook: 'tool/enhance', message: '解析失败' }] }),
  ]
  for (const snapshot of normalStates) {
    const line = scrub(textOf(captured.component({ useProjection: () => snapshot, sessionId: 'u7', t: (key) => key })))
    assert.doesNotMatch(line, BLACKLIST, `底栏文案泄漏了实现词汇：${line}`)
  }

  const panel = openPanel(
    captured,
    'u7-panel',
    wireSnapshot({ lastSpill: { bytes: 1024, locator: '/tmp/x', at: Date.now() }, topTools: [{ name: 'bash', count: 1, maxMs: 5, avgMs: 5 }] }),
  )
  assert.doesNotMatch(scrub(textOf(panel)), BLACKLIST, `面板文案泄漏了实现词汇：${textOf(panel)}`)

  // 故障诊断那三处本身必须是"看得见的中文"，而不是被黑名单逼成空字符串。
  const diagnose = [
    textOf(captured.component({ t: (key) => key })),
    textOf(captured.component({ useProjection: () => ({ v: 8 }), sessionId: 'u7-diagnose', t: (key) => key })),
  ]
  assert.match(diagnose[0], /挂载点未提供 useProjection/)
  assert.match(diagnose[1], /投影版本错配/)
})

test('客户端半 G1/G2：零构建、零图标依赖（源码扫描，替代渲染走查）', async () => {
  const clientSource = readSource('../lib/client.js')
  assert.doesNotMatch(clientSource, /dsh-client-ui-primitives/, 'G2：不许 import 原生图标包')
  assert.doesNotMatch(clientSource, /\bIcon[A-Z]\w*/, 'G2：不许出现 Icon 组件标识符')
  assert.doesNotMatch(clientSource, /document\.createElement|insertRule|@media|:hover|transition:/, 'G1：没有样式表也没有构建步骤')
  assert.doesNotMatch(clientSource, /host\.call|__reactFiber|fiber/, '边界：不探未文档化服务、不爬 React fiber')
  // R5：noProgressMs 缺席时客户端兜底 90000。
  assert.match(clientSource, /90000/, 'R5：客户端兜底阈值必须在')
  // 图标继续自绘：14×14 行内 SVG。
  assert.match(clientSource, /GLYPH_WARN/)
  assert.match(clientSource, /viewBox: '0 0 16 16'/)
  // 契约（PLAN §3.3.4）：收起状态是 useState，指示符逐字固定，不是图标。
  assert.match(clientSource, /React\.useState\(/)
  assert.match(clientSource, /collapsed \?/)
  assert.match(clientSource, /'▸ 详情'/)
  assert.match(clientSource, /'▾ 收起'/)
})

test('客户端半：任务书要求的英文兜底与 locale 覆盖同时成立', async () => {
  const captured = await freshCapture()
  const view = captured.component({ useProjection: () => wireSnapshot(), sessionId: 'locale', t: (key) => key })
  assert.match(textOf(view), /执行工具/, '拿不到 t 的译文时用中文兜底')
  const panel = openPanel(captured, 'locale-panel', wireSnapshot())
  assert.match(textOf(panel), /本回合/)
  assert.equal(typeof captured.locale.dict.zh['section.turn'], 'string')
  assert.equal(typeof captured.locale.dict.en['section.turn'], 'string')
})

/*
 * 0.17.1：可选服务的取法。cordis 的属性访问（`ctx.sessions`）在 fiber 链上找不到实现时会**抛错**
 * （`cannot get property "sessions" without inject`），非严格的只有 `ctx.get(name)`；轮换建会话走的就是
 * 这条路，所以两条路都要有回归门，且任何一条抛错都必须降级成 null，不许把异常丢进事件折叠的热路径。
 */
test('宿主半：serviceOf 先走 ctx.get，属性访问抛错时安全降级为 null', async () => {
  const { __test } = await import('../lib/index.js')
  const service = { create: () => ({}) }

  assert.equal(__test.serviceOf({ get: (key) => (key === 'sessions' ? service : undefined) }, 'sessions'), service, 'ctx.get 命中就用它')
  assert.equal(__test.serviceOf({ get: () => undefined, sessions: service }, 'sessions'), service, 'ctx.get 取不到时回退属性访问')
  assert.equal(
    __test.serviceOf(
      {
        get: () => undefined,
        get sessions() {
          throw new Error('cannot get property "sessions" without inject')
        },
      },
      'sessions',
    ),
    null,
    '属性访问抛错（cordis 的真实行为）必须降级为 null',
  )
  assert.equal(__test.serviceOf({ get: () => { throw new Error('inactive context') }, sessions: service }, 'sessions'), service, 'ctx.get 抛错时仍回退属性访问')
  assert.equal(__test.serviceOf(null, 'sessions'), null, '没有上下文时返回 null')
  assert.equal(__test.serviceOf({}, 'sessions'), null, '两条路都取不到时返回 null')
})

export { ROOT }
test('客户端半（0.21.0）：复制话术 = 会话名称 + 会话 ID + 会话日志目录 + 继续处理未完成的任务', async () => {
  const mod = await loadClientModule()
  const exported = mod.factory((id) => (id === 'react' ? ReactMock : undefined))
  const { sessionCopyTextOf } = exported.__test
  const text = (key, fallback) => fallback

  assert.equal(
    sessionCopyTextOf(
      { newSession: { title: '老会话', oldId: 'session-1', logDir: 'D:\\x\\sessions\\--D-p--\\session-1', text: '与复制无关' } },
      text,
    ),
    '会话名称：老会话\n会话 ID：session-1\n会话日志目录：D:\\x\\sessions\\--D-p--\\session-1\n继续处理未完成的任务',
    '四行齐全，顺序固定（用户 m08351 指定的内容）',
  )
  assert.equal(
    sessionCopyTextOf({ newSession: { oldId: 'session-1' } }, text),
    '会话 ID：session-1\n继续处理未完成的任务',
    '缺名称/日志目录 ⇒ 省掉那一行，绝不留空值占位',
  )
  assert.equal(sessionCopyTextOf(undefined, text), '继续处理未完成的任务', '连投影都没有时只剩那句任务说明')
})
