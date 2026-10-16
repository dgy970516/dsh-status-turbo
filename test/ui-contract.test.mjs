/**
 * T07 —— UI 契约层里**尚未被 test/halves.test.mjs 锁住**的那些面：
 *
 *   1. 源码级护栏（M1）：G1 零构建（目录级 + package.json）、G2 零图标依赖（整个 lib/ 而不只是 client.js）、
 *      三方版本等式（wire `v` ↔ `TURBO_STATE_VERSION` ↔ `EXPECTED_V`）、U2 四色**字面量**。
 *   2. 行为面里 halves 没走到的分支：U6「只有一条挂上」的两个方向、U7 第 3/第 4 处诊断文案、
 *      G5 全目录零跳过扫描。
 *
 * 为什么单独成文件：T07 的 inScope 只给了本文件与 tools/replay-log.mjs；halves.test.mjs 在本任务内
 * 只许动 :44-46 那一处。本文件刻意**不重复**已有的断言 —— 每条 test 上面都写清"哪条已在 halves 覆盖、指向它"。
 *
 * 纪律（SPEC G5）：本目录一律不许出现跳过型用例（skip 调用 0 处）—— 缺宿主环境必须 FAIL 或显式抛错，
 * 所以本文件里没有任何条件分支会绕过断言（见最后一条 test 把这条规矩也钉死）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
// P1-7：本文件前面每条用例喂的都是手写快照；文件末尾那一条用宿主半自己的入口造**真投影**。
import {
  DEFAULT_CONFIG,
  initState,
  pushActivity,
  pushEnhancement,
  pushHookFault,
  pushRotation,
  pushSpill,
  toView,
} from '../lib/state.js'

const readText = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')

/* ─────────────────────── 最小 React 替身（与 halves.test.mjs:77-96 同一套语义，不 import 它） ─────────────────────── */

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

/** 全新的模块实例：模块级的挂载记账表跨 apply 复用，验 dataset 生命周期时必须拿干净的。 */
async function loadFreshClient(tag) {
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: (mod) => loaded.push(mod) } }
  await import(`../lib/client.js?fresh=${tag}`)
  assert.equal(loaded.length, 1, `client.js 必须向 __ModuleLoader__ 注册恰好一个模块（${tag}）`)
  return loaded[0].factory((id) => (id === 'react' ? ReactMock : undefined))
}

/** 挂一次（两个条目都收），返回第一个条目（摘要行）的组件 —— U7 文案断言只读它。 */
async function captureOnce() {
  const captured = { registrations: [] }
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply({
    slots: {
      inject: (_key, callback) => callback(),
      register(options, component) {
        captured.registrations.push({ options, component })
        if (captured.registrations.length === 1) captured.component = component
        return () => {}
      },
    },
    get: (name) => (name === 'timer' ? { timeout: () => () => {} } : undefined),
  })
  // 0.14.0/0.14.1 之后同一次 apply 还会注册设置页与左侧栏入口两格；本文件只关心摘要行与详情面板，
  // 所以按 id 取，而不是数总数。
  assert.ok(captured.registrations.some((entry) => entry.options.id === 'dsh-status-turbo.status'))
  assert.ok(captured.registrations.some((entry) => entry.options.id === 'dsh-status-turbo.detail'))
  return captured
}

/* ─────────────────────────────── G1：零构建（目录级，halves 没有这一面） ─────────────────────────────── */

test('G1 零构建（目录级）：lib/ 下没有样式表/TS 文件，package.json 只有 test 一个脚本', () => {
  // halves.test.mjs:919-935 扫的是 **lib/client.js 的文件内容**（有没有 createElement/@media 一类字面量）；
  // 这里补的是**文件系统**这一面：lib/ 目录里到底放了哪些文件、以及零构建在 package.json 上的落点。
  const names = readdirSync(new URL('../lib/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  assert.ok(names.length > 0, 'lib/ 必须真的扫到文件（路径写错时不许静默通过）')

  const buildArtifacts = names.filter((name) => /\.(css|scss|sass|less|ts|tsx)$/i.test(name))
  assert.deepEqual(buildArtifacts, [], `G1：lib/ 下不得出现构建期文件：${buildArtifacts.join('、')}`)

  // 任务书的硬约束：不许往 lib/ 放非 .js。这条比 SPEC G1 的四类后缀更严，故单独断言。
  const nonJs = names.filter((name) => !name.endsWith('.js'))
  assert.deepEqual(nonJs, [], `lib/ 下只许有纯 .js：${nonJs.join('、')}`)

  const pkg = JSON.parse(readText('../package.json'))
  assert.deepEqual(Object.keys(pkg.scripts), ['test'], 'G1：package.json 只许有 test 一个脚本（没有构建步骤）')
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"', '唯一那条脚本必须就是全量测试命令本身')
})

/* ─────────────────── G1/G2：源码级护栏（整个 lib/，比 halves 的单文件扫描更强） ─────────────────── */

test('G1/G2 源码级护栏：整个 lib/*.js 不出现图标包 / Icon 标识符 / 样式与构建痕迹', () => {
  // halves.test.mjs:919-923 只读了 lib/client.js 一份；这里对**每一个 lib/*.js** 逐份断言同一组禁忌。
  // 这不是把同一条事实抄两遍：新增的 lib/ 文件一旦违规，只有这条会红。
  const files = readdirSync(new URL('../lib/', import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .sort()
  assert.ok(files.includes('client.js') && files.includes('state.js'), `lib/ 扫描清单不完整：${files.join('、')}`)

  for (const name of files) {
    const source = readText(`../lib/${name}`)
    assert.doesNotMatch(source, /dsh-client-ui-primitives/, `${name}：G2 不许 import 原生图标包`)
    assert.doesNotMatch(source, /\bIcon[A-Z]\w*/, `${name}：G2 不许出现 Icon 组件标识符（图标一律自绘）`)
    assert.doesNotMatch(
      source,
      /document\.createElement|insertRule|@media|:hover|transition:/,
      `${name}：G1 没有样式表，也没有构建步骤`,
    )
  }

  // 只写"不许出现"等于把"图标整个消失"也当成通过，所以正面证据也要在。
  assert.match(readText('../lib/client.js'), /viewBox: '0 0 16 16'/, 'G2：图标是自绘的行内 SVG')
})

/* ──────────────────────── M1：三方版本等式（halves 只对了两条源码常量） ──────────────────────── */

test('M1 版本等式（三方）：wire 视图的 v === TURBO_STATE_VERSION === 客户端 EXPECTED_V', async () => {
  // halves.test.mjs:55-58 把两个**源码常量**对起来（经注册定义 stateVersion）。
  // 这里补第三条腿：运行期真正发出去的那份 wire `v` —— 客户端就是拿它和自己那份常量比的。
  const { initState, toView, TURBO_STATE_VERSION } = await import('../lib/state.js')
  const hostVersion = Number(/TURBO_STATE_VERSION\s*=\s*(\d+)/.exec(readText('../lib/state.js'))[1])
  const clientVersion = Number(/EXPECTED_V\s*=\s*(\d+)/.exec(readText('../lib/client.js'))[1])

  assert.equal(TURBO_STATE_VERSION, hostVersion)
  assert.equal(toView(initState(), {}).v, hostVersion, 'wire 视图的 v 必须真的等于 TURBO_STATE_VERSION')
  assert.equal(clientVersion, hostVersion, 'R2：客户端 EXPECTED_V 必须等于宿主 TURBO_STATE_VERSION')
})

/* ────────────────────────── M1/U2：四色字面量 + 10% 淡底色（源码级） ────────────────────────── */

test('M1/U2 四色字面量在客户端源码里逐个到位（层级色 / 告警 / 错误 / color-mix 淡底色）', () => {
  // halves.test.mjs:563-601 断言的是**渲染出来的** style 值（选色逻辑）；这里锁的是色号**字面量**。
  // 两处各锁一半：逻辑改错由 halves 红，色号被换成别的变量名由这条红。
  const client = readText('../lib/client.js')
  assert.match(client, /var\(--dsw-alias-label-secondary\)/, 'U2：阶段/标题目录用次级标签色')
  assert.match(client, /var\(--dsw-alias-label-tertiary\)/, 'U2：纯数值用三级标签色')
  assert.match(client, /var\(--dsw-alias-state-warn-primary\)/, 'U2：告警色')
  assert.match(client, /var\(--dsw-alias-state-error-primary\)/, 'U2：错误色')
  assert.match(
    client,
    /color-mix\(in srgb, \$\{color\} \$\{percent\}%, transparent\)/,
    'U2：淡底色必须走 color-mix，不许引入样式表',
  )
  assert.match(client, /tint\('var\(--dsw-alias-state-warn-primary\)', 10\)/, 'U2：告警 pill 的底色是 10% 告警色')
})

/* ─────────────────── U6：dataset 生命周期里"只有一条挂上"的那两个方向 ─────────────────── */

test('U6 dataset 生命周期：只有一条挂上时不许写 "0"（成功的那条不许替失败的那条背书）', async () => {
  // halves.test.mjs:833-881 覆盖了「两条都不挂 ⇒ 恰好写一次 '1'」与「两条都挂 ⇒ '1' 再 '0'」；
  // 缺的那一格是**只有一条挂上**：此时标志必须停在 '1'，而且不许被写成 '0'。两个方向都要成立。
  const datasetWrites = () => {
    const writes = []
    const dataset = new Proxy(
      {},
      {
        set: (target, key, value) => {
          writes.push([key, value])
          target[key] = value
          return true
        },
      },
    )
    return { writes, dataset }
  }

  const originalDocument = globalThis.document
  const originalError = console.error
  console.error = () => {}
  try {
    // ① 摘要行与详情面板现在**同槽**（0.20.0 起都在 conversation.input.dock）：槽位回调不来 ⇒
    //    两个自检条目都没挂上，标志必须停在 '1'（设置页那一格成功也不许把它清成 0）。
    const onlyStatus = datasetWrites()
    globalThis.document = { body: { dataset: onlyStatus.dataset } }
    ;(await loadFreshClient('u6-only-status')).apply({
      slots: {
        inject: (key, callback) => {
          if (key === 'conversation.input.dock') return
          callback()
        },
        register: () => () => {},
      },
      get: (name) => (name === 'timer' ? { timeout: (fn) => fn() } : undefined),
    })
    assert.deepEqual(
      onlyStatus.writes,
      [['dshTurboMountFailed', '1']],
      '同槽回调不来 ⇒ 写 1，且此后同一状态不许再写（尤其不许写 0）',
    )

    // ② 摘要行注册抛错、详情面板照常挂上 —— 反过来也必须成立，注册顺序不许成为漏网的理由。
    const onlyDetail = datasetWrites()
    globalThis.document = { body: { dataset: onlyDetail.dataset } }
    ;(await loadFreshClient('u6-only-detail')).apply({
      slots: {
        inject: (_key, callback) => callback(),
        register: (options) => {
          if (options && options.id === 'dsh-status-turbo.status') {
            throw new Error('slot "conversation.input.dock" is not declared')
          }
          return () => {}
        },
      },
      get: (name) => (name === 'timer' ? { timeout: (fn) => fn() } : undefined),
    })
    assert.deepEqual(
      onlyDetail.writes,
      [['dshTurboMountFailed', '1']],
      '只有详情面板挂上 ⇒ 同样停在 1，不许因为有条目成功就清成 0',
    )
  } finally {
    console.error = originalError
    globalThis.document = originalDocument
  }
})

/* ───────────────── U7：第 3 处诊断文案 + 第 4 处诊断态（halves 只断言了两处） ───────────────── */

test('U7 三处故障诊断：整串白名单放行、仍在且非空；另补一格尚未被扫过的诊断态', async () => {
  // halves.test.mjs:883-917 扫的是 normalStates 五个正常态 + 面板，并断言了前两处诊断（:915-916）。
  // 没扫到的是：① 第 3 处诊断（投影缺席超宽限期）② mountStatus 读不到时的红格（:891-897 的列表里没有这格）。
  const captured = await captureOnce()
  const BLACKLIST = /投影|projection|fiber|host|ctx|slot/i

  /*
   * SPEC U7 放行三处诊断文案。M5 之后第 3 处也走 i18n 了：字典里是
   * `error.missingProjection = '宿主半似乎没起来：等待投影超过 {grace} 仍未到达（已等 {waited}）'`，
   * 屏幕上那串由占位符填成（宽限期 8s、已等 30s，两处时长都由本用例控制）。白名单因此按**渲染后的
   * 整串**放行 —— `scrub` 是精确串删除，占位符填过之后字典原文已不可能出现在输出里。
   */
  const DIAGNOSTIC = {
    'error.notReady': '挂载点未提供 useProjection',
    'version-mismatch': '投影版本错配',
    'error.missingProjection': '宿主半似乎没起来：等待投影超过 8 秒 仍未到达（已等 30 秒）',
  }
  assert.ok(DIAGNOSTIC['error.missingProjection'].startsWith('宿主半似乎没起来'), '白名单至少要覆盖 SPEC 列出的那句前缀')
  const scrub = (value) => Object.values(DIAGNOSTIC).reduce((acc, allowed) => acc.split(allowed).join(''), value)

  // ① 缺 useProjection（挂载契约没送到）。
  const notReady = textOf(captured.component({ t: (key) => key }))
  // ② 版本错配（宿主 v ≠ 客户端 v）。
  const version = textOf(
    captured.component({ useProjection: () => ({ v: 8 }), sessionId: 'u7-version', t: (key) => key }),
  )
  // ③ 投影缺席超过宽限期：组件按 sessionId 记第一个挂载时刻 ⇒ 用受控 Date.now 推到 8s 之后。
  const realNow = Date.now
  const base = realNow()
  let missing
  Date.now = () => base
  try {
    assert.equal(
      captured.component({ useProjection: () => undefined, sessionId: 'u7-missing', t: (key) => key }),
      null,
      '宽限期内不渲染（缺投影 ≠ 立刻报错），这是 ③ 能成立的前提',
    )
    Date.now = () => base + 30_000
    missing = textOf(captured.component({ useProjection: () => undefined, sessionId: 'u7-missing', t: (key) => key }))
  } finally {
    Date.now = realNow
  }

  const diagnose = [
    ['error.notReady', notReady],
    ['version-mismatch', version],
    ['error.missingProjection', missing],
  ]
  for (const [name, line] of diagnose) {
    assert.ok(line.trim().length > 0, `${name}：诊断文案不许被黑名单逼成空串`)
    assert.doesNotMatch(scrub(line), BLACKLIST, `${name}：白名单之外仍泄漏了实现词汇：${line}`)
  }
  assert.match(notReady, /挂载点未提供 useProjection/)
  assert.match(version, /投影版本错配/)
  assert.match(missing, /宿主半似乎没起来/)
  assert.match(missing, /等待投影超过 8 秒 仍未到达/, '第 3 处的后半段必须还在（不许为了过黑名单把它删掉）')
  assert.match(missing, /已等 30 秒/, 'M5：{waited} 必须被真实等待时长填上，不是留着占位符')

  // ④ halves.test.mjs:883-897 的 normalStates 里没有这一格：开关状态读不到 ⇒ 红格，且本就不该命中黑名单。
  const missingSwitch = textOf(
    captured.component({
      useProjection: () => ({ v: 13, busy: false, phase: 'idle' }),
      sessionId: 'u7-switch',
      t: (key) => key,
    }),
  )
  assert.match(missingSwitch, /状态条开关缺失/, '开关读不到必须报出来（P0-1 三态里的第三态）')
  assert.doesNotMatch(scrub(missingSwitch), BLACKLIST, `第 4 处诊断不该命中黑名单：${missingSwitch}`)
})

/* ─────────────── 0.6.0 内容层：「现在」与「活动流」两个新分区（halves 未覆盖的 DOM 面） ─────────────── */

/** 摘要行与详情面板两个组件都收下来（只要 DOM，不需要 halves 那套 dataset 记账）。 */
async function capturePair() {
  const registrations = []
  ;(await loadClientModule()).factory((id) => (id === 'react' ? ReactMock : undefined)).apply({
    slots: {
      inject: (_key, callback) => callback(),
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get: (name) => (name === 'timer' ? { timeout: () => () => {} } : undefined),
  })
  const status = registrations.find((entry) => entry.options.id === 'dsh-status-turbo.status')
  const detail = registrations.find((entry) => entry.options.id === 'dsh-status-turbo.detail')
  assert.ok(status !== undefined && detail !== undefined, '摘要行与详情面板必须各自注册一个条目')
  return { status: status.component, detail: detail.component }
}

/** wire v7 的一整份快照（0.6.5 起客户端认 v7：0.6.1 的 activity / waitTools / waitKind / subagents + slowMs + enhancement（含 mode））。 */
function wireV6(overrides) {
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
    activity: [],
    waitTools: [],
    waitKind: null,
    subagents: 0,
    slowMs: 60000,
    enhancement: { active: true, mode: 'host-pruner', reason: null },
    ...overrides,
  }
}

function withPanelOpen(pair, snapshot, sessionId) {
  const props = { useProjection: () => snapshot, sessionId, t: (key) => key }
  const status = pair.status(props)
  assert.notEqual(status, null, '有快照时摘要行必须画出来')
  status.props.onClick()
  return pair.detail(props)
}

function assertRowClipped(row, label) {
  assert.equal(row.props.style.whiteSpace, 'nowrap', `${label}：值行不许换行`)
  assert.equal(row.props.style.overflow, 'hidden', `${label}：值行不许溢出`)
}

test('0.6.0 详情面板：最上面依次是「现在」「活动流」，每个值行都受截断保护', async () => {
  const pair = await capturePair()
  const panel = withPanelOpen(
    pair,
    wireV6({ activity: [{ t: Date.now() - 3000, kind: 'reason', text: '先看看目录' }] }),
    'u8-now',
  )
  assert.equal(textOf(panel.children[1].children[0]), '现在', '0.6.0：第一个分区是「现在」')
  assert.equal(textOf(panel.children[2].children[0]), '活动流', '紧接着是「活动流」')
  const nowRow = panel.children[1].children[1]
  assertRowClipped(nowRow, '现在')
  assert.match(textOf(nowRow), /执行工具/, '现在分区说清在哪个阶段')
  assert.match(textOf(nowRow), /bash/, '有工具时带上工具名')

  // U4 的同一条规矩对新分区照样成立：所有值行不许换行、不许溢出。
  for (const section of panel.children.slice(1)) {
    for (const row of section.children.slice(1)) assertRowClipped(row, textOf(section.children[0]))
  }
})

test('0.6.0 活动流：倒序（最新在上），四类条目各有标签、配色与可复制内容', async () => {
  const base = Date.now() - 10_000
  const activity = [
    { t: base, kind: 'reason', text: '先想一想' },
    { t: base + 1000, kind: 'call', name: 'bash', args: { cmd: 'ls' } },
    { t: base + 2000, kind: 'result', ok: true, head: 'a\nb' },
    { t: base + 3000, kind: 'result', ok: false, head: 'boom' },
    { t: base + 4000, kind: 'turnEnd', reason: 'stop' },
  ]
  const pair = await capturePair()
  const panel = withPanelOpen(pair, wireV6({ activity }), 'u8-activity')
  const rows = panel.children[2].children.slice(1)
  assert.equal(rows.length, 5)
  assert.match(textOf(rows[0]), /回合结束/, '最新的 turnEnd 排最上面')

  const failRow = rows.find((row) => /失败/.test(textOf(row)))
  assert.equal(failRow.props.style.color, 'var(--dsw-alias-state-error-primary)', '失败条目用错误色')
  const okRow = rows.find((row) => /完成/.test(textOf(row)))
  assert.equal(okRow.props.style.color, undefined, '成功条目不额外着色')
  const thinkRow = rows.find((row) => /思考/.test(textOf(row)))
  assert.equal(thinkRow.props.style.fontStyle, 'italic')
  assert.equal(thinkRow.props.style.color, 'var(--dsw-alias-label-secondary)')
  const callRow = rows.find((row) => /调用/.test(textOf(row)))
  assert.equal(
    callRow.props.style.fontFamily,
    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    '调用条目等宽',
  )
  assert.equal(callRow.props.style.userSelect, 'text', '内容必须可以被选中复制')
  assert.match(textOf(callRow), /bash/)
  assert.match(textOf(callRow), /"cmd":"ls"/, '参数原样上屏（脱敏在投影层已经做过）')
})

test('0.6.0 活动流：空活动给一句人话，不是空白', async () => {
  const pair = await capturePair()
  const panel = withPanelOpen(pair, wireV6(), 'u8-empty')
  const rows = panel.children[2].children.slice(1)
  assert.equal(rows.length, 1)
  assert.match(textOf(rows[0]), /还没有活动记录/)
})

test('0.6.5「工具增强」分区：灰色 info 行 + 截断保护；本地裁剪是启用态、缺席才不是故障、不泄漏机器串', async () => {
  const findSection = (panel, title) =>
    panel.children.find(
      (child) => Array.isArray(child.children) && child.children.some((node) => textOf(node) === title),
    )

  // ① 宿主 pruner 在位：灰色 info（不是错误红），受 U4 那条截断规矩约束。
  const onPanel = withPanelOpen(await capturePair(), wireV6(), 'u8-enh-on')
  const onSection = findSection(onPanel, '工具增强')
  assert.notEqual(onSection, undefined, '「工具增强」分区必须存在（0.6.4 起恒在）')
  const onRow = onSection.children[1]
  assertRowClipped(onRow, '工具增强')
  assert.equal(onRow.props.style.color, 'var(--dsw-alias-label-secondary)', '必须是灰色 info，不是故障红字')
  assert.match(textOf(onRow), /已启用（宿主裁剪）/)
  assert.equal(findSection(onPanel, '最近的故障'), undefined, '在位时不该有故障分区')

  // ② 0.6.5 本地裁剪：拿不到宿主 pruner 也是「启用」，但文案必须说清是本地裁的。
  const localPanel = withPanelOpen(
    await capturePair(),
    wireV6({ enhancement: { active: true, mode: 'local-trim', reason: null } }),
    'u8-enh-local',
  )
  const localSection = findSection(localPanel, '工具增强')
  assert.notEqual(localSection, undefined)
  const localRow = localSection.children[1]
  assertRowClipped(localRow, '工具增强')
  assert.equal(localRow.props.style.color, 'var(--dsw-alias-label-secondary)', '本地裁剪是启用态：不许变红')
  assert.match(textOf(localRow), /已启用（本地裁剪）/)
  assert.equal(textOf(localRow).includes('ctx'), false, '机器串不得进面板')
  assert.equal(textOf(localRow).includes('toolResultPruner'), false, '机器串不得进面板')
  assert.equal(findSection(localPanel, '最近的故障'), undefined, '本地裁剪不是故障：recentFaults 必须为空')

  // ③ 真的没有落盘后端：依然灰 info；理由本地化，机器串一个都不许上屏；recentFaults 仍为空。
  const offPanel = withPanelOpen(
    await capturePair(),
    wireV6({ enhancement: { active: false, mode: 'off', reason: 'no ctx.spillStore backend loaded' } }),
    'u8-enh-off',
  )
  const offSection = findSection(offPanel, '工具增强')
  assert.notEqual(offSection, undefined)
  const offRow = offSection.children[1]
  assertRowClipped(offRow, '工具增强')
  assert.equal(offRow.props.style.color, 'var(--dsw-alias-label-secondary)', '缺席不是故障：不许变红')
  assert.match(textOf(offRow), /未启用/)
  assert.match(textOf(offRow), /没有落盘后端/)
  assert.equal(textOf(offRow).includes('ctx'), false, '机器串不得进面板')
  assert.equal(textOf(offRow).includes('spillStore'), false, '机器串不得进面板')
  assert.equal(findSection(offPanel, '最近的故障'), undefined, '缺席不是故障：recentFaults 必须为空')
})

/* ────────────────────────── G5：全目录零跳过（连本文件一起扫） ────────────────────────── */

test('G5 不许静默跳过：test/ 下所有用例文件里 skip 调用 0 处（含本文件）', () => {
  // SPEC G5 / T07 的 forbidden：新增测例里跳过型用例出现 0 次；缺宿主环境必须 FAIL 或显式抛错。
  // 扫描清单必须包含本文件 —— 否则"零跳过"是自证不了的。
  const names = readdirSync(new URL('.', import.meta.url)).filter((name) => name.endsWith('.test.mjs'))
  assert.ok(names.includes('ui-contract.test.mjs'), `扫描必须包含本文件：${names.join('、')}`)
  assert.ok(names.length >= 8, `必须扫到全部用例文件（当前 ${names.length} 个）：${names.join('、')}`)

  // 故意不写成"某两个词的拼接字面量"：这样本文件自己不会被自己扫中（自扫中会让这条永远假红）。
  const SKIP_CALL = /t(?:est)?\.skip/
  const hits = names.filter((name) => SKIP_CALL.test(readText(`./${name}`)))
  assert.deepEqual(hits, [], `G5：缺宿主环境必须 FAIL/抛错，不许静默跳过；命中文件：${hits.join('、')}`)
})

/* ───────── P1-7：面板必须吃**真投影**，不是只有手写快照才画得出来 ───────── */

/**
 * 真投影下必须出现的分区标题，顺序即面板顺序。
 *
 * 审计当时数到 12 个分区：`最近瘦身` 与 `最近的故障` 是**条件分区**，只有投影里真有数据才出现。
 * 下面这条用例把两者都喂了数据，所以 13 个都必须在；顺序由 `detailBody` 里 `sections` 的拼接顺序决定。
 */
const REAL_PROJECTION_SECTIONS = [
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
]

test('P1-7 真投影：面板直接吃 toView() 的产物，分区一个不少', async () => {
  // 上面每条用例喂的都是手写字面量：它证明得了"排版"，证明不了"宿主那套字段真的对得上"。
  // 这里一个手写字段都不用 —— 全走宿主半自己的入口：initState → push* → toView。
  const state = initState()
  state.sessionId = 'p1-7-real'
  state.phase = 'tool'
  state.tool = 'bash'
  state.turn = 4
  state.step = 7
  state.phaseStartedAt = Date.now() - 4200
  state.turnStartedAt = Date.now() - 9000
  state.lastProgressAt = Date.now() - 900
  state.lastTurnMs = 15000
  // `pushActivity` 是纯函数：它返回**新状态**（新 activity 数组），不就地改传入的那个。
  const withActivity = pushActivity(state, { t: Date.now() - 1500, kind: 'reason', text: '先看看目录' }, DEFAULT_CONFIG)
  pushHookFault('p1-7-real', { at: Date.now() - 800, hook: 'tool/enhance', message: '语法树解析失败' })
  pushSpill('p1-7-real', { bytes: 4096, locator: 'D:/tmp/spill.json', at: Date.now() - 400 })
  pushEnhancement('p1-7-real', { active: true, mode: 'host-pruner', reason: null })
  pushRotation('p1-7-real', { status: 'armed', at: Date.now() - 300, sessionId: 'p1-7-real' })
  const snapshot = toView(withActivity, DEFAULT_CONFIG)

  // 真投影先自证不是空壳：版本、忙碌态、以及 push* 写进去的东西都得真的在投影里。
  assert.equal(snapshot.v, 13, '真投影必须就是 wire 版本 13')
  assert.equal(snapshot.busy, true)
  assert.equal(snapshot.activity.length, 1, 'pushActivity 写进去的条目必须出现在投影里')
  assert.equal(snapshot.hookFaults.length, 1, 'pushHookFault 写进去的故障必须出现在投影里')
  assert.notEqual(snapshot.lastSpill, null, 'pushSpill 写进去的落盘摘要必须出现在投影里')

  const pair = await capturePair()
  const panel = withPanelOpen(pair, snapshot, 'p1-7-real')
  assert.notEqual(panel, null, '真投影必须能被摘要行与面板吃下去')

  const titles = panel.children.slice(1).map((section) => textOf(section.children[0]))
  assert.deepEqual(titles, REAL_PROJECTION_SECTIONS, `真投影下分区必须一个不少：${titles.join('、')}`)
  for (const section of panel.children.slice(1)) {
    const label = textOf(section.children[0])
    assert.equal(section.props.role, 'region', `${label}：分区必须是具名 region`)
    assert.equal(section.children[0].props.role, 'heading', `${label}：分区标题必须有语义`)
  }
  assert.match(textOf(panel), /先看看目录/, '真活动流条目必须真的画到屏幕上')
  assert.match(textOf(panel), /4096/, '真落盘摘要必须真的画到屏幕上')
})
