/**
 * dsh-status-turbo — 0.7.0 交接文档自动导出的单元测试。
 *
 * 全部走**注入替身**：没有一次真的起进程、真的写盘、真的碰时间。
 * 覆盖三层：阈值判据（纯）、探测链（注入 requireResolve/execPath/exists）、执行器（注入 spawn）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  DEFAULT_CONFIG,
  accountPayload,
  clearSessionRuntime,
  handoffStateOf,
  initState,
  laneWatermarkOf,
  payloadBytesOf,
  pushHandoff,
  setLaneWatermark,
  toView,
} from '../lib/state.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_EXPORT_TIMEOUT_MS,
  HANDOFF_GITIGNORE,
  HANDOFF_MESSAGE,
  HANDOFF_STATUS,
  KILL_GRACE_MS,
  MODEL_VISIBLE_EVENT_TYPES,
  effectiveByteThreshold,
  effectiveThreshold,
  exportArgs,
  failureMessage,
  findAnyHandoff,
  findExistingHandoff,
  handoffDir,
  handoffPrefix,
  handoffTarget,
  isFreshEvent,
  isModelVisibleEvent,
  lanesFor,
  listArgs,
  listLanes,
  needsShell,
  nonNegativeInt,
  packageRootOf,
  parseExportLanes,
  planHandoff,
  positiveInt,
  profileRootOf,
  quoteForShell,
  resolveBili,
  runBili,
  runExport,
  safeSegment,
  shouldExport,
  watermarkBucket,
} from '../lib/handoff.js'

/** 默认配置的一份可变副本。 */
const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over })

test('positiveInt：非法值一律回落 DEFAULT_CONFIG 的同名项', () => {
  assert.equal(positiveInt(1234, 'handoffExportTokens'), 1234)
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '400000', null, undefined, {}]) {
    assert.equal(positiveInt(bad, 'handoffExportTokens'), DEFAULT_CONFIG.handoffExportTokens)
  }
})

test('shouldExport：默认值是「开」，而显式 false 必须真的不导', () => {
  assert.equal(DEFAULT_CONFIG.handoffExport, true, '用户要求：装上就工作')
  // 显式关掉 ⇒ 无论多长都不导
  assert.equal(shouldExport({ config: cfg({ handoffExport: false }), inputTokens: 10_000_000 }), false)
  // 不传覆盖（走默认）⇒ 越阈值就导
  assert.equal(shouldExport({ config: cfg(), inputTokens: DEFAULT_CONFIG.handoffExportTokens }), true)
})

test('shouldExport：阈值与节流', () => {
  const on = cfg({ handoffExport: true })

  // 未达阈值
  assert.equal(shouldExport({ config: on, inputTokens: DEFAULT_CONFIG.handoffExportTokens - 1 }), false)
  // 恰好达到阈值
  assert.equal(shouldExport({ config: on, inputTokens: DEFAULT_CONFIG.handoffExportTokens }), true)
  // 首次（没有 lastInputTokens）
  assert.equal(shouldExport({ config: on, inputTokens: 500_000 }), true)
  // 距上次增长不足 minDelta ⇒ 不再导（防每轮重复导）
  const near = DEFAULT_CONFIG.handoffExportTokens + DEFAULT_CONFIG.handoffExportMinDeltaTokens - 1
  assert.equal(shouldExport({ config: on, inputTokens: near, lastInputTokens: DEFAULT_CONFIG.handoffExportTokens }), false)
  // 增长够了 ⇒ 再导
  const far = DEFAULT_CONFIG.handoffExportTokens + DEFAULT_CONFIG.handoffExportMinDeltaTokens
  assert.equal(shouldExport({ config: on, inputTokens: far, lastInputTokens: DEFAULT_CONFIG.handoffExportTokens }), true)
  // 非法 inputTokens 不导
  assert.equal(shouldExport({ config: on, inputTokens: Number.NaN }), false)
  assert.equal(shouldExport({ config: on, inputTokens: undefined }), false)
  // 脏配置回落默认阈值
  assert.equal(shouldExport({ config: cfg({ handoffExport: true, handoffExportTokens: 'x' }), inputTokens: 500_000 }), true)
})

test('shouldExport：配置 enabled 但阈值被调低到 1 也照判', () => {
  const on = cfg({ handoffExport: true, handoffExportTokens: 1 })
  assert.equal(shouldExport({ config: on, inputTokens: 1 }), true)
  assert.equal(shouldExport({ config: on, inputTokens: 0 }), false)
})

test('safeSegment / handoffDir / handoffTarget：文件名净化、默认目录与水位桶', () => {
  assert.equal(safeSegment('session-20e4cec2-ee9a-45d8-b976-298b2489aa80'), 'session-20e4cec2-ee9a-45d8-b976-298b2489aa80')
  assert.equal(safeSegment('sub:f0550134'), 'sub_f0550134')
  assert.equal(safeSegment('C:\\x/y'), 'C__x_y')

  assert.equal(handoffDir({ cwd: 'D:\\project', dir: '' }), join('D:\\project', DEFAULT_CONFIG.handoffExportDir))
  assert.equal(handoffDir({ cwd: 'D:\\project', dir: ' handoffs ' }), join('D:\\project', 'handoffs'))

  const p = handoffTarget({ cwd: 'D:\\project', dir: '', sessionId: 's:1', bucket: 14, stamp: '20261011-0230' })
  assert.equal(p, join('D:\\project', DEFAULT_CONFIG.handoffExportDir, 'handoff-s_1-14-20261011-0230.md'))

  const q = handoffTarget({ cwd: '/w', dir: ' handoffs ', sessionId: 'abc', bucket: 3, stamp: 't' })
  assert.equal(q, join('/w', 'handoffs', 'handoff-abc-3-t.md'))
})

test('watermarkBucket / handoffPrefix / findExistingHandoff：水位桶幂等（P1-2 / P1-3 / P1-6）', () => {
  const config = cfg({ handoffExport: true })
  // 桶宽 = handoffExportMinDeltaTokens（0.8.1 起默认 60000）
  assert.equal(watermarkBucket(config, { inputTokens: 0 }), 0)
  assert.equal(watermarkBucket(config, { inputTokens: 59_999 }), 0)
  assert.equal(watermarkBucket(config, { inputTokens: 60_000 }), 1)
  assert.equal(watermarkBucket(config, { inputTokens: 410_000 }), 6)
  assert.equal(watermarkBucket(config, { inputTokens: Number.NaN }), null)
  assert.equal(watermarkBucket(config, { inputTokens: -5 }), 0, '负数夹到 0，不抛')
  assert.equal(watermarkBucket(config, {}), null, '两个口径都没有 ⇒ null')
  assert.equal(watermarkBucket(config, undefined), null)
  // 字节桶：0.8.1 起默认宽度 450000 ⇒ 3 MB 落在桶 6
  assert.equal(watermarkBucket(config, { payloadBytes: 3_000_000 }), 6)
  assert.equal(watermarkBucket(config, { payloadBytes: 8_000_000 }), 17)
  assert.equal(watermarkBucket(config, { payloadBytes: 48_000_000 }), 106)
  // 取大者：否则字节驱动的那次增长会落回旧桶被幂等吃掉
  assert.equal(watermarkBucket(config, { inputTokens: 410_000, payloadBytes: 6_000_000 }), 13)
  assert.equal(watermarkBucket(config, { inputTokens: 900_000, payloadBytes: 100 }), 15)
  // 脏配置回落默认桶宽，绝不抛
  assert.equal(watermarkBucket(cfg({ handoffExportMinDeltaTokens: 'x' }), { inputTokens: 250_000 }), 4)

  assert.equal(handoffPrefix('s:1', 4), 'handoff-s_1-4-')
  assert.equal(handoffPrefix('s:1', 5), 'handoff-s_1-5-')

  const entries = ['handoff-s_1-4-20261011-0230.md', 'handoff-s_1-5-20261011-0240.md', '.gitignore', 'other.txt']
  assert.equal(findExistingHandoff(entries, 's:1', 4), 'handoff-s_1-4-20261011-0230.md')
  assert.equal(findExistingHandoff(entries, 's:1', 5), 'handoff-s_1-5-20261011-0240.md')
  assert.equal(findExistingHandoff(entries, 's:1', 6), null, '新桶 ⇒ 该刷新就刷新')
  assert.equal(findExistingHandoff(entries, 's:2', 4), null, '别的会话不算')
  assert.equal(findExistingHandoff(['handoff-s_1-4-x.txt'], 's:1', 4), null, '只认 .md')
  assert.equal(findExistingHandoff(null, 's:1', 4), null)
  assert.equal(findExistingHandoff([7, null], 's:1', 4), null)
  assert.equal(HANDOFF_GITIGNORE, '*\n')
})

test('resolveBili：配置 → 包目录（解析结果切包根）→ profile 兜底拼法；永不返回 .cmd', () => {
  // 一级：显式路径优先，且不再探测别的
  const explicit = resolveBili({ config: { handoffExportBiliBin: ' D:\\tools\\bili.exe ' }, execPath: 'node', profileDir: '/p' })
  assert.deepEqual(explicit, { command: 'D:\\tools\\bili.exe', prefix: [], source: 'config' })

  // 二级：解析结果指向 dist/agent/dsh-native.js（该包 `.` export 的真实指向）⇒ 切出包根再拼 dist/index.js
  const realShape = resolveBili({
    config: cfg(),
    execPath: '/usr/bin/node',
    requireResolve: () => join('/nm', 'billion-context', 'dist', 'agent', 'dsh-native.js'),
    profileDir: '/p',
  })
  assert.deepEqual(realShape, {
    command: '/usr/bin/node',
    prefix: [join('/nm/billion-context', 'dist', 'index.js')],
    source: 'package',
  })
  assert.equal(/\.(cmd|bat)$/i.test(realShape.prefix[0]), false, 'P0-2：绝不把 .cmd/.bat 当可执行文件')

  // 二级解析器抛错（实测 ERR_PACKAGE_PATH_NOT_EXPORTED）⇒ 回落 profile 兜底拼法
  const viaProfile = resolveBili({
    config: cfg(),
    execPath: 'node.exe',
    requireResolve: () => {
      const error = new Error('not exported')
      error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      throw error
    },
    profileDir: '/p',
  })
  assert.deepEqual(viaProfile, {
    command: 'node.exe',
    prefix: [join('/p', 'node_modules', 'billion-context', 'dist', 'index.js')],
    source: 'package',
  })

  // 解析结果切不出包根 ⇒ 只走兜底拼法
  const unparsable = resolveBili({ config: cfg(), execPath: 'node', requireResolve: () => '/weird/place.js', profileDir: '/p' })
  assert.deepEqual(unparsable.prefix, [join('/p', 'node_modules', 'billion-context', 'dist', 'index.js')])

  // exists 过滤：候选都不在场 ⇒ null（缺席，不是故障）
  assert.equal(resolveBili({ config: cfg(), execPath: 'node', profileDir: '/p', exists: () => false }), null)
  // 没有解释器 ⇒ null（不能拿 .js 当可执行文件）
  assert.equal(resolveBili({ config: cfg(), profileDir: '/p' }), null)
  // 什么都没给 ⇒ null
  assert.equal(resolveBili({ config: cfg() }), null)
})

test('packageRootOf：只在 <sep>billion-context<sep> 处切，切不出来给 null', () => {
  const entry = join('/nm', 'billion-context', 'dist', 'agent', 'dsh-native.js')
  assert.equal(packageRootOf(entry), join('/nm', 'billion-context'))
  assert.equal(packageRootOf('/totally/elsewhere.js'), null)
  assert.equal(packageRootOf(''), null)
  assert.equal(packageRootOf(null), null)
  assert.equal(packageRootOf(7), null)
})

test('needsShell / quoteForShell：只对 .cmd/.bat 要 shell，只给带空格或引号的参数加引号', () => {
  const win = process.platform === 'win32'
  assert.equal(needsShell('C:\\x\\bili.CMD'), win)
  assert.equal(needsShell('C:\\x\\bili.bat'), win)
  assert.equal(needsShell('bili'), false)
  assert.equal(needsShell('bili.exe'), false)
  assert.equal(quoteForShell('plain'), 'plain')
  assert.equal(quoteForShell('has space'), '"has space"')
  // cmd.exe / CommandLineToArgvW 的口径：引号在引号内部**双写**，不是反斜杠转义（反斜杠转义是
  // C 运行库的约定，cmd 不处理）。Windows 路径本来也放不下 `"`，这里钉的是实现口径。
  assert.equal(quoteForShell('has"quote'), '"has""quote"')
  assert.equal(quoteForShell('has "both"'), '"has ""both"""')
})

test('runExport：.cmd 目标必须带 shell，且带空格的路径自己加引号（P0-2 回归）', async () => {
  const calls = []
  const result = await new Promise((resolve) => {
    runExport({
      spawn: (command, args, opts) => {
        calls.push({ command, args, opts })
        const child = { on(ev, fn) { if (ev === 'close') queueMicrotask(() => fn(0)); return child }, kill() {} }
        return child
      },
      bili: { command: 'C:\\x\\bili.CMD', prefix: [] },
      sessionId: 's',
      full: false,
      output: 'D:\\my work\\handoff\\a.md',
      onSettle: resolve,
    })
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  if (process.platform === 'win32') {
    assert.equal(calls[0].opts.shell, true, 'P0-2：.cmd 不经 shell 会 EINVAL')
    assert.ok(calls[0].args.includes('"D:\\my work\\handoff\\a.md"'), '带空格的路径必须自己加引号')
  } else {
    assert.equal(calls[0].opts.shell, false)
  }
})

test('exportArgs：前缀、--full 与 --output 的位置', () => {
  const bili = { command: 'node', prefix: ['/nm/billion-context/dist/index.js'] }
  assert.deepEqual(exportArgs(bili, { sessionId: 's1', full: false, output: '/o/a.md' }), [
    '/nm/billion-context/dist/index.js', 'export', 's1', '--output', '/o/a.md',
  ])
  assert.deepEqual(exportArgs({ command: 'bili', prefix: [] }, { sessionId: 's2', full: true, output: '/o/b.md' }), [
    'export', 's2', '--full', '--output', '/o/b.md',
  ])
})

test('runExport：成功 / 退出码非零 / 起不来 / spawn 不是函数', async () => {
  const calls = []
  const settleOf = (run) => new Promise((resolve) => { run(resolve) })

  const ok = await new Promise((resolve) => {
    runExport({
      spawn: (command, args, opts) => {
        calls.push({ command, args, opts })
        const child = { on(ev, fn) { if (ev === 'close') queueMicrotask(() => fn(0)); return child }, kill() {} }
        return child
      },
      bili: { command: 'bili', prefix: [] },
      sessionId: 's', full: false, output: '/o/x.md', cwd: '/w',
      onSettle: resolve,
    })
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.code, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'bili')
  assert.deepEqual(calls[0].args, ['export', 's', '--output', '/o/x.md'])
  assert.equal(calls[0].opts.cwd, '/w')
  assert.equal(calls[0].opts.windowsHide, true)

  const bad = await new Promise((resolve) => {
    runExport({
      spawn: () => { const c = { on(ev, fn) { if (ev === 'close') queueMicrotask(() => fn(2)); return c }, kill() {} }; return c },
      bili: { command: 'bili', prefix: [] }, sessionId: 's', full: false, output: '/o/x.md', onSettle: resolve,
    })
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 2)

  const errored = await new Promise((resolve) => {
    runExport({
      spawn: () => { const c = { on(ev, fn) { if (ev === 'error') queueMicrotask(() => fn(new Error('ENOENT'))); return c }, kill() {} }; return c },
      bili: { command: 'bili', prefix: [] }, sessionId: 's', full: false, output: '/o/x.md', onSettle: resolve,
    })
  })
  assert.equal(errored.ok, false)
  assert.equal(errored.error.message, 'ENOENT')

  const threw = await new Promise((resolve) => {
    runExport({
      spawn: () => { throw new Error('spawn failed') },
      bili: { command: 'bili', prefix: [] }, sessionId: 's', full: false, output: '/o/x.md', onSettle: resolve,
    })
  })
  assert.equal(threw.ok, false)
  assert.equal(threw.error.message, 'spawn failed')

  // bili 缺席 / spawn 缺席：返回 null 且不调 onSettle
  let called = false
  assert.equal(runExport({ spawn: () => {}, bili: null, sessionId: 's', output: '/o/x.md', onSettle: () => { called = true } }), null)
  assert.equal(runExport({ spawn: null, bili: { command: 'bili', prefix: [] }, sessionId: 's', output: '/o/x.md' }), null)
  assert.equal(called, false)
})

test('runExport：超时会 kill 并只结算一次', async () => {
  let killed = false
  const result = await new Promise((resolve) => {
    runExport({
      spawn: () => {
        const child = { on() { return child }, kill() { killed = true } }
        return child
      },
      bili: { command: 'bili', prefix: [] },
      sessionId: 's', full: false, output: '/o/x.md', timeoutMs: 5,
      onSettle: resolve,
    })
  })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(killed, true)
  assert.equal(DEFAULT_EXPORT_TIMEOUT_MS, 120000)
})

test('runBili：超时先 SIGTERM + 销毁管道，宽限期满升级 SIGKILL（S7）', async () => {
  const signals = []
  const destroyed = []
  let settles = 0
  const result = await new Promise((resolve) => {
    runBili({
      spawn: () => {
        const stream = (name) => ({ on() {}, destroy() { destroyed.push(name) } })
        const child = {
          on() { return child },
          kill(signal) { signals.push(signal) },
          stdout: stream('stdout'),
          stderr: stream('stderr'),
          stdin: stream('stdin'),
        }
        return child
      },
      bili: { command: 'bili', prefix: [] },
      args: ['list'],
      timeoutMs: 5,
      killGraceMs: 5,
      captureStdout: true,
      captureStderr: true,
      onSettle: (value) => { settles += 1; resolve(value) },
    })
  })
  // 宽限期满之前就已经按超时结算（SIGKILL 只是兜底，不改变结果）。
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.deepEqual(signals.slice(0, 1), [undefined], '第一次 kill 不带信号 = 默认 SIGTERM')
  // 等宽限定时器（unref 的，不会自己拖住进程）跑完，确认升级到 SIGKILL 且管道被显式销毁。
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(signals.slice(1), ['SIGKILL'])
  assert.deepEqual(destroyed.slice(0, 3), ['stdout', 'stderr', 'stdin'])
  assert.equal(settles, 1, '结算只有一次')
  assert.equal(KILL_GRACE_MS, 3000)
})

test('HANDOFF_STATUS 是一组稳定的机器名（wire 契约）', () => {
  assert.deepEqual(Object.values(HANDOFF_STATUS).sort(), ['disabled', 'done', 'failed', 'idle', 'running', 'unavailable'])
})

// ────────────────────────── state 层：wire 的 handoff 键与运行时表 ──────────────────────────

test('state 层：wire 的 handoff 键恒在，默认是 idle 而不是 undefined', () => {
  const id = 's-handoff-a'
  clearSessionRuntime(id)
  const view = toView(initState({ id }), {})
  assert.equal(Object.hasOwn(view, 'handoff'), true)
  assert.deepEqual(view.handoff, { status: 'idle', at: null, path: null, inputTokens: null, message: null })
  assert.deepEqual(Object.values(view.handoff).filter((value) => value === undefined), [])
  clearSessionRuntime(id)
})

test('state 层：pushHandoff 是合并而不是整条替换（节流记忆不被覆盖）', () => {
  const id = 's-handoff-b'
  clearSessionRuntime(id)
  assert.equal(handoffStateOf(id), null, '没有条目就是 null，不是幻影默认值')
  pushHandoff(id, { status: 'running', at: 1000, inputTokens: 410000 })
  assert.deepEqual(handoffStateOf(id), { status: 'running', at: 1000, path: null, inputTokens: 410000, message: null })
  // 第二次只写 status / at / path —— inputTokens 必须还在（否则节流就失效了）
  pushHandoff(id, { status: 'done', at: 2000, path: 'D:/w/handoff/x.md' })
  assert.deepEqual(handoffStateOf(id), { status: 'done', at: 2000, path: 'D:/w/handoff/x.md', inputTokens: 410000, message: null })
  assert.equal(toView(initState({ id }), {}).handoff.path, 'D:/w/handoff/x.md')
  clearSessionRuntime(id)
})

test('state 层：脏 patch 一律回落（状态机不认识回 idle、数字非法回 null），绝不抛', () => {
  const id = 's-handoff-c'
  clearSessionRuntime(id)
  pushHandoff(id, { status: 'nonsense', at: 'x', path: 7, inputTokens: Number.NaN, message: '' })
  assert.deepEqual(handoffStateOf(id), { status: 'idle', at: null, path: null, inputTokens: null, message: null })
  pushHandoff(null, { status: 'done' })
  pushHandoff(undefined, { status: 'done' })
  assert.equal(handoffStateOf(null), null)
  assert.equal(handoffStateOf(undefined), null)
  clearSessionRuntime(id)
})

test('state 层：disabled 与 unavailable 都不进 hookFaults（未开启/缺席都不是故障）', () => {
  const id = 's-handoff-d'
  clearSessionRuntime(id)
  pushHandoff(id, { status: 'disabled' })
  assert.equal(toView(initState({ id }), {}).handoff.status, 'disabled')
  pushHandoff(id, { status: 'unavailable' })
  const view = toView(initState({ id }), {})
  assert.equal(view.handoff.status, 'unavailable')
  assert.deepEqual(view.hookFaults, [], '缺席绝不伪装成故障')
  clearSessionRuntime(id)
  assert.equal(toView(initState({ id }), {}).handoff.status, 'idle', '清表后回到 idle 缺省')
})

test('state 层：initState 记下 header.cwd（交接导出的目标根），脏值记 null', () => {
  assert.equal(initState({ id: 'a', cwd: 'D:/w' }).cwd, 'D:/w')
  assert.equal(initState({ id: 'a' }).cwd, null)
  assert.equal(initState({ id: 'a', cwd: '' }).cwd, null)
  assert.equal(initState({ id: 'a', cwd: 7 }).cwd, null)
  assert.equal(initState(null).cwd, null)
})

// ───────────────── 0.7.3：窗口比例阈值 / 决策纯函数 / 车道列表 / stderr（P1-1 P1-4 P1-5 P2-1 P2-3） ─────────────────

test('effectiveThreshold：窗口未知用绝对值；已知则按比例收紧，绝不放大（P1-4）', () => {
  const config = cfg({ handoffExport: true })
  assert.equal(effectiveThreshold({ config }), 240000, '没有窗口 ⇒ 绝对阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 0 }), 240000)
  assert.equal(effectiveThreshold({ config, contextWindow: Number.NaN }), 240000)
  assert.equal(effectiveThreshold({ config, contextWindow: 1_000_000 }), 240000, '1M 的 25% = 250000 高于绝对阈值 ⇒ 取绝对阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 8_000_000 }), 240000, '大窗口不放大阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 128_000 }), 32000, '小窗口 ⇒ 25% = 32000')
  assert.equal(
    effectiveThreshold({ config: cfg({ handoffExport: true, handoffExportWindowPercent: 10 }), contextWindow: 128_000 }),
    12800,
    '比例可配',
  )
  assert.equal(
    effectiveThreshold({ config: cfg({ handoffExport: true, handoffExportWindowPercent: 'x' }), contextWindow: 128_000 }),
    32000,
    '脏比例回落默认 25',
  )
})

test('shouldExport：小窗口模型不会再"永远够不着"（P1-4 回归）', () => {
  const config = cfg({ handoffExport: true })
  assert.equal(shouldExport({ config, inputTokens: 31_999, contextWindow: 128_000 }), false)
  assert.equal(shouldExport({ config, inputTokens: 32_000, contextWindow: 128_000 }), true)
  assert.equal(shouldExport({ config, inputTokens: 51_200 }), false, '没有窗口时仍按绝对阈值 240000')
})

test('planHandoff：三种动作与理由（P1-5 —— 判定可单测，宿主只剩 I/O）', () => {
  const config = cfg({ handoffExport: true })
  const base = { config, inputTokens: 410_000, contextWindow: 1_000_000, entries: [], sessionId: 's:1', cwd: 'D:\\w', stamp: '20261011-0300' }

  assert.deepEqual(planHandoff({ ...base, config: cfg({ handoffExport: false }) }), {
    action: 'none',
    reason: 'below-threshold',
    bucket: 6,
    existing: null,
    output: null,
  })
  assert.equal(planHandoff({ ...base, inputTokens: Number.NaN }).reason, 'no-watermark')
  assert.equal(planHandoff({ ...base, inputTokens: 239_999 }).action, 'none')

  const fresh = planHandoff(base)
  assert.equal(fresh.action, 'export')
  assert.equal(fresh.bucket, 6)
  assert.equal(fresh.output, join('D:\\w', 'handoff', 'handoff-s_1-6-20261011-0300.md'))

  const already = planHandoff({ ...base, entries: ['handoff-s_1-6-20261011-0000.md'] })
  assert.equal(already.action, 'skip')
  assert.equal(already.reason, 'already-exported')
  assert.equal(already.output, join('D:\\w', 'handoff', 'handoff-s_1-6-20261011-0000.md'))

  // 距上次水位不足 delta ⇒ 不动作（MIN_DELTA 节流）
  assert.equal(planHandoff({ ...base, inputTokens: 450_000, lastInputTokens: 410_000 }).action, 'none')
  // 差够了 ⇒ 进新桶并导出
  const next = planHandoff({ ...base, inputTokens: 510_000, lastInputTokens: 410_000 })
  assert.equal(next.action, 'export')
  assert.equal(next.bucket, 8)
})

test('parseExportLanes / lanesFor：子车道与主车道同 label，按 label 归族（P2-1）', () => {
  const stdout = [
    'Persisted sessions:',
    '',
    '  session-a  label=session-a  [openai]  blocks=650  ctx~337540  看看现在的五力分析…',
    '  session-a|sub:af70c2f22f3c256d  label=session-a  [openai]  blocks=7  ctx~19359479  This is an automatically…',
    '  session-b  label=session-b  [anthropic]  blocks=32  ctx~15034253  未经员工明确确认…',
    'bad line without the shape',
  ].join('\n')
  const lanes = parseExportLanes(stdout)
  assert.equal(lanes.length, 3, '只认列表里那三行，噪声行不算')
  assert.deepEqual(lanes[0], { key: 'session-a', label: 'session-a', protocol: 'openai', blocks: 650, ctx: 337540 })
  assert.equal(lanes[1].key, 'session-a|sub:af70c2f22f3c256d')
  assert.deepEqual(lanesFor(lanes, 'session-a'), ['session-a', 'session-a|sub:af70c2f22f3c256d'], '主车道排第一')
  assert.deepEqual(lanesFor(lanes, 'session-b'), ['session-b'])
  assert.deepEqual(lanesFor(lanes, 'session-c'), ['session-c'], '列表里没有 ⇒ 退化成只导主车道')
  assert.deepEqual(lanesFor([], 'session-c'), ['session-c'])
  assert.deepEqual(lanesFor(null, 'session-c'), ['session-c'], '解析失败绝不抛')
  assert.deepEqual(parseExportLanes(null), [])
  assert.deepEqual(parseExportLanes(''), [])
  assert.deepEqual(parseExportLanes('随便一段不是车道列表的文本'), [])
})

test('listArgs：列出车道的 argv', () => {
  assert.deepEqual(listArgs({ command: 'node', prefix: ['/nm/billion-context/dist/index.js'] }), [
    '/nm/billion-context/dist/index.js',
    'export',
  ])
  assert.deepEqual(listArgs({ command: 'bili', prefix: [] }), ['export'])
})

test('runExport：stderr 尾部被采集并回传（P2-3）', async () => {
  const result = await new Promise((resolve) => {
    runExport({
      spawn: () => {
        const child = {
          stderr: {
            on(ev, fn) {
              if (ev === 'data') queueMicrotask(() => fn('line one\nboom: not found\n'))
              return child
            },
          },
          on(ev, fn) {
            if (ev === 'close') queueMicrotask(() => fn(2))
            return child
          },
          kill() {},
        }
        return child
      },
      bili: { command: 'node', prefix: ['/x/bili.js'] },
      sessionId: 's',
      full: false,
      output: '/o/x.md',
      onSettle: resolve,
    })
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /boom: not found/)
})

test('listLanes：stderr 尾部也被采集并回传（0.9.3；此前宿主那条 warn 永远打印空 stderr）', async () => {
  const result = await new Promise((resolve) => {
    listLanes({
      spawn: () => {
        const child = {
          stdout: {
            on(ev, fn) {
              if (ev === 'data') queueMicrotask(() => fn('session-old\t42\n'))
              return child
            },
          },
          stderr: {
            on(ev, fn) {
              if (ev === 'data') queueMicrotask(() => fn('bili: profile "desktop" not found\n'))
              return child
            },
          },
          on(ev, fn) {
            if (ev === 'close') queueMicrotask(() => fn(1))
            return child
          },
          kill() {},
        }
        return child
      },
      bili: { command: 'node', prefix: ['/x/bili.js'] },
      cwd: 'D:/w',
      onSettle: resolve,
    })
  })

  assert.equal(result.ok, false)
  assert.match(result.stdout, /session-old/, '车道列表仍要拿到 stdout')
  assert.match(result.stderr, /not found/, 'stderr 必须进结果，否则「车道列表探测失败」的 warn 没有可读原因')
})

test('0.7.3 新键的默认值与脏值回落（P1-1）', () => {
  assert.equal(DEFAULT_CONFIG.handoffExportMaxPerProcess, 64, '0.7.5 从 8 抬到 64')
  assert.equal(positiveInt(undefined, 'handoffExportMaxPerProcess'), 64)
  assert.equal(positiveInt(3, 'handoffExportMaxPerProcess'), 3)
  assert.equal(positiveInt(0, 'handoffExportMaxPerProcess'), 64, '0 非法 ⇒ 回落默认')
  assert.equal(DEFAULT_CONFIG.handoffExportWindowPercent, 25, '0.8.1 从 40 降到 25')
  assert.equal(DEFAULT_CONFIG.handoffExportSubLanes, false, '0.7.8 起默认不导子车道')
})

// ─────────────── 0.7.4：字节口径（P0-3 按建议改）+ 每车道水位（残余修复） ───────────────

test('effectiveByteThreshold：与 token 口径共用同一个比例旋钮（P0-3）', () => {
  const config = cfg({ handoffExport: true })
  assert.equal(BYTES_PER_TOKEN, 7.5, 'bili 自己那条护栏的换算常数')
  assert.equal(effectiveByteThreshold({ config }), 1_800_000)
  assert.equal(effectiveByteThreshold({ config, contextWindow: 1_000_000 }), 1_800_000, '1M × 25% × 7.5 = 1875000 高于绝对阈值 ⇒ 取绝对阈值')
  assert.equal(effectiveByteThreshold({ config, contextWindow: 8_000_000 }), 1_800_000, '大窗口不放大')
  assert.equal(effectiveByteThreshold({ config, contextWindow: 128_000 }), 240_000, '小窗口按比例收紧')
  assert.equal(effectiveByteThreshold({ config, contextWindow: -1 }), 1_800_000, '脏窗口回落绝对阈值')
  assert.equal(
    effectiveByteThreshold({ config: cfg({ handoffExport: true, handoffExportWindowPercent: 'x' }), contextWindow: 128_000 }),
    240_000,
    '脏比例回落默认 25',
  )
})

test('shouldExport：token 与字节取或，且各用各自的 delta（P0-3）', () => {
  const config = cfg({ handoffExport: true })
  // 只有字节口径越线（token 很小）—— 这正是 token 口径漏掉的那一格
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 3_000_000 }), true)
  // 字节越线但没涨够 delta ⇒ 不导
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 3_400_000, lastPayloadBytes: 3_000_000 }), false)
  // 0.8.1 起 delta 默认 450000（旧值 8000000 **大于**字节阈值 3000000 ⇒ 第二次导出是死路）
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 3_449_999, lastPayloadBytes: 3_000_000 }), false)
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 3_450_000, lastPayloadBytes: 3_000_000 }), true)
  // 只有 token 口径越线（字节很小）
  assert.equal(shouldExport({ config, inputTokens: 400_000, payloadBytes: 10 }), true)
  // 两个都没越线
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 1000 }), false)
  // 窗口收紧后的字节阈值同样生效：128k 窗口 ⇒ 240000
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 400_000, contextWindow: 128_000 }), true)
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 239_999, contextWindow: 128_000 }), false)
})

test('state 层：字节账按 seq 幂等累加、request/header 只记最新（P0-3 的可重放性）', () => {
  const id = 's-bytes'
  clearSessionRuntime(id)
  assert.equal(payloadBytesOf(id), 0)
  assert.equal(payloadBytesOf(null), 0)
  accountPayload(id, { seq: 1, bytes: 1000 })
  accountPayload(id, { seq: 2, bytes: 2000 })
  assert.equal(payloadBytesOf(id), 3000, '消息体累加')
  accountPayload(id, { seq: 2, bytes: 2000 })
  assert.equal(payloadBytesOf(id), 3000, '同一 seq 重放不重复计')
  accountPayload(id, { seq: 1, bytes: 999 })
  assert.equal(payloadBytesOf(id), 3000, '更旧的 seq 一律忽略')
  accountPayload(id, { header: true, bytes: 127_000 })
  accountPayload(id, { header: true, bytes: 130_000 })
  assert.equal(payloadBytesOf(id), 133_000, 'request/header 只记最新那一次')
  // 脏输入不抛、不计
  accountPayload(id, { seq: 'x', bytes: 5000 })
  accountPayload(id, { seq: 9, bytes: -1 })
  accountPayload(id, { seq: 9 })
  accountPayload(null, { seq: 10, bytes: 5000 })
  accountPayload(id, null)
  assert.equal(payloadBytesOf(id), 133_000)
  clearSessionRuntime(id)
  assert.equal(payloadBytesOf(id), 0, '清表后归零')
})

test('state 层：每车道各自的水位（残余修复）', () => {
  const id = 's-lanes'
  clearSessionRuntime(id)
  assert.equal(laneWatermarkOf(id, id), null)
  setLaneWatermark(id, id, { inputTokens: 410_000, payloadBytes: 3_000_000 })
  setLaneWatermark(id, `${id}|sub:abc`, { inputTokens: 5000, payloadBytes: 15_000_000 })
  assert.deepEqual(laneWatermarkOf(id, id), { inputTokens: 410_000, payloadBytes: 3_000_000 })
  assert.deepEqual(
    laneWatermarkOf(id, `${id}|sub:abc`),
    { inputTokens: 5000, payloadBytes: 15_000_000 },
    '子车道各记各的，不再共用父会话那一份',
  )
  assert.equal(laneWatermarkOf(id, 'nope'), null)
  // 脏值一律回落 null，不抛
  setLaneWatermark(id, 'dirty', { inputTokens: 'x', payloadBytes: Number.NaN })
  assert.deepEqual(laneWatermarkOf(id, 'dirty'), { inputTokens: null, payloadBytes: null })
  setLaneWatermark(id, '', { inputTokens: 1 })
  assert.equal(laneWatermarkOf(id, ''), null, '空车道键忽略')
  setLaneWatermark(null, 'x', { inputTokens: 1 })
  assert.equal(laneWatermarkOf(null, 'x'), null)
  clearSessionRuntime(id)
  assert.equal(laneWatermarkOf(id, id), null)
})

test('0.7.4 / 0.8.1 新键的默认值', () => {
  assert.equal(DEFAULT_CONFIG.handoffExportTokens, 240_000, '0.8.1 从 400000 降到 240000')
  assert.equal(DEFAULT_CONFIG.handoffExportMinDeltaTokens, 60_000, '0.8.1 从 100000 降到 60000')
  assert.equal(DEFAULT_CONFIG.rotationFreshMs, 300_000, '0.8.1 轮换也吃同一把冷启动闸')
  assert.equal(DEFAULT_CONFIG.handoffExportBytes, 1_800_000, '0.8.1 从 3000000 降到 1800000')
  assert.equal(DEFAULT_CONFIG.handoffExportMinDeltaBytes, 450_000, '0.8.1 从 8000000 降到 450000（旧值大于阈值 ⇒ 死路）')
  assert.equal(DEFAULT_CONFIG.handoffExportFreshMs, 300_000, '0.7.7 新增：只对新鲜事件触发')
  assert.equal(positiveInt(undefined, 'handoffExportBytes'), 1_800_000)
  assert.equal(positiveInt(0, 'handoffExportMinDeltaBytes'), 450_000, '0 非法 ⇒ 回落默认')
})

test('isFreshEvent：只认新鲜事件（0.7.7 —— 挡冷启动重放的批量触发）', () => {
  const now = 1_800_000_000_000
  assert.equal(isFreshEvent({ at: now, now, freshMs: 300_000 }), true)
  assert.equal(isFreshEvent({ at: now - 299_999, now, freshMs: 300_000 }), true)
  assert.equal(isFreshEvent({ at: now - 300_001, now, freshMs: 300_000 }), false, '超窗 ⇒ 不动作')
  assert.equal(isFreshEvent({ at: now - 86_400_000, now, freshMs: 300_000 }), false, '一天前的事件（重放）⇒ 不动作')
  assert.equal(isFreshEvent({ at: now + 5000, now, freshMs: 300_000 }), false, '未来时间戳 ⇒ 宁可不动')
  assert.equal(isFreshEvent({ at: undefined, now, freshMs: 300_000 }), false)
  assert.equal(isFreshEvent({ at: '2026-10-11', now, freshMs: 300_000 }), false)
  assert.equal(isFreshEvent({ at: now, now: Number.NaN, freshMs: 300_000 }), false)
  // 脏 freshMs 回落默认 5 分钟，不抛
  assert.equal(isFreshEvent({ at: now - 299_999, now, freshMs: 'x' }), true)
  assert.equal(isFreshEvent({ at: now - 300_001, now, freshMs: 0 }), false)
})

test('0.7.7 回归：48 MB 的会话只产个位数文档（原来 750 KB 一份 ⇒ 一天写掉 64 份）', () => {
  const config = cfg({ handoffExport: true })
  const files = []
  let lastPayloadBytes
  let exports = 0
  // 按 750 KB 的粒度模拟「账一直在长」，一直走到 48 MB
  for (let kb = 0; kb <= 48 * 1024; kb += 750) {
    const payloadBytes = kb * 1024
    const plan = planHandoff({
      config,
      inputTokens: 1000,
      payloadBytes,
      lastPayloadBytes,
      contextWindow: 1_000_000,
      entries: files,
      sessionId: 's1',
      cwd: 'D:\\w',
      stamp: '20261011-1200',
    })
    if (plan.action === 'none') continue
    // 宿主在 skip 与 export 两种情况下都会写回水位
    lastPayloadBytes = payloadBytes
    if (plan.action !== 'export') continue
    exports += 1
    files.push(plan.output.split(/[\\/]/).pop())
  }
  assert.equal(exports, 1, '0.7.8 起默认「每车道只导一份」（0.7.7 是 6 份、750 KB 时代是 64 份）')

  // 想恢复"随水位桶刷新"：把 handoffExportRefreshBytes 设成字节增量
  const refreshing = cfg({ handoffExport: true, handoffExportRefreshBytes: 8_000_000 })
  const files2 = []
  let last2
  let exports2 = 0
  for (let kb = 0; kb <= 48 * 1024; kb += 750) {
    const payloadBytes = kb * 1024
    const plan = planHandoff({
      config: refreshing,
      inputTokens: 1000,
      payloadBytes,
      lastPayloadBytes: last2,
      contextWindow: 1_000_000,
      entries: files2,
      sessionId: 's1',
      cwd: 'D:\\w',
      stamp: '20261011-1200',
    })
    if (plan.action === 'none') continue
    last2 = payloadBytes
    if (plan.action !== 'export') continue
    exports2 += 1
    files2.push(plan.output.split(/[\\/]/).pop())
  }
  assert.ok(exports2 > 1, `开了刷新就该出多份，实得 ${exports2}`)
})

test('findAnyHandoff / nonNegativeInt：每车道只导一份的判据（0.7.8）', () => {
  assert.equal(findAnyHandoff(['handoff-s_1-4-20261011-0230.md'], 's:1'), 'handoff-s_1-4-20261011-0230.md')
  assert.equal(findAnyHandoff(['handoff-s_1-9-20261011-0300.md'], 's:1'), 'handoff-s_1-9-20261011-0300.md', '任何桶都算')
  assert.equal(findAnyHandoff(['handoff-s_2-1-x.md'], 's:1'), null, '别的车道不算')
  assert.equal(findAnyHandoff(['handoff-s_1-1-x.txt'], 's:1'), null, '只认 .md')
  assert.equal(findAnyHandoff(null, 's:1'), null)
  assert.equal(findAnyHandoff([], 's:1'), null)

  assert.equal(nonNegativeInt(0, 'handoffExportRefreshBytes'), 0, '0 是合法值')
  assert.equal(nonNegativeInt(undefined, 'handoffExportRefreshBytes'), 0, '默认 0 = 不重复导出')
  assert.equal(nonNegativeInt(8_000_000, 'handoffExportRefreshBytes'), 8_000_000)
  assert.equal(nonNegativeInt(-1, 'handoffExportRefreshBytes'), 0, '负数非法 ⇒ 回落默认')
  assert.equal(nonNegativeInt('x', 'handoffExportRefreshBytes'), 0)
  assert.equal(DEFAULT_CONFIG.handoffExportRefreshBytes, 0)
  assert.equal(DEFAULT_CONFIG.handoffExportSubLanes, false)
})

test('profileRootOf：对着真实布局断言（0.7.4-1 回归 —— 原来少一层 ⇒ 那张牌是死的）', async () => {
  // 装好的副本就是这个形状：…/profiles/desktop/node_modules/dsh-status-turbo/lib/index.js
  const fake = join('C:\\x', 'profiles', 'desktop', 'node_modules', 'dsh-status-turbo', 'lib', 'index.js')
  assert.equal(profileRootOf(fake), join('C:\\x', 'profiles', 'desktop'), '必须落在 profile 根')
  assert.notEqual(profileRootOf(fake), join('C:\\x', 'profiles', 'desktop', 'node_modules'), '不能停在 node_modules')
  assert.equal(profileRootOf(''), null)
  assert.equal(profileRootOf(null), null)
  assert.equal(profileRootOf(7), null)

  // 真机（只在这台装了 harness 的机器上跑）：profileDir 那一级必须真的命中，否则又是一层死代码
  const { existsSync } = await import('node:fs')
  const real = join('D:\\deepseek-harness', 'profiles', 'desktop', 'node_modules', 'dsh-status-turbo', 'lib', 'index.js')
  if (existsSync(real)) {
    const root = profileRootOf(real)
    assert.equal(root, join('D:\\deepseek-harness', 'profiles', 'desktop'))
    const cli = join(root, 'node_modules', 'billion-context', 'dist', 'index.js')
    assert.equal(existsSync(cli), true, `profileDir 级应该命中：${cli}`)
  }
})

test('isModelVisibleEvent：只认进请求体的类型（0.7.4-3）', () => {
  for (const type of ['user/message', 'assistant/message', 'tool/call', 'tool/result']) {
    assert.equal(isModelVisibleEvent(type), true, type)
  }
  // 成对出现的 compaction 会把同一段文本算两遍 ⇒ 不计
  assert.equal(isModelVisibleEvent('compaction/start'), false)
  assert.equal(isModelVisibleEvent('compaction/end'), false)
  assert.equal(isModelVisibleEvent('request/header'), false, 'request/header 单独按「只记最新」处理')
  assert.equal(isModelVisibleEvent('subagent/catalog'), false)
  assert.equal(isModelVisibleEvent('approval/asked'), false)
  assert.equal(isModelVisibleEvent(''), false)
  assert.equal(isModelVisibleEvent(null), false)
  assert.equal(isModelVisibleEvent(7), false)
  assert.deepEqual([...MODEL_VISIBLE_EVENT_TYPES], ['user/message', 'assistant/message', 'tool/call', 'tool/result'])
})

test('failureMessage / HANDOFF_MESSAGE：失败原因是稳定 code，不是句子（0.7.4-5）', () => {
  assert.deepEqual({ ...HANDOFF_MESSAGE }, {
    LIMIT_REACHED: 'limit-reached',
    NO_CWD: 'no-cwd',
    MKDIR_FAILED: 'mkdir-failed',
    TIMEOUT: 'timeout',
  })
  assert.equal(failureMessage({ timedOut: true }), 'timeout')
  assert.equal(failureMessage({ code: 2 }), 'exit:2')
  assert.equal(failureMessage({ code: 0 }), 'exit:0')
  assert.equal(failureMessage({ code: null }), 'exit:unknown')
  assert.equal(failureMessage({ code: 'x' }), 'exit:unknown')
  assert.equal(failureMessage(null), 'exit:unknown')
  assert.equal(failureMessage({ timedOut: true, code: 2 }), 'timeout', '超时优先')
  // 词汇表必须是"kebab-case 词"，不能是英文句子（句子会漏进中文面板）
  for (const code of Object.values(HANDOFF_MESSAGE)) {
    assert.match(code, /^[a-z][a-z0-9-]*$/)
  }
})

test('字节账刻意不回落：compaction 既不计价也不可能清零（0.7.4-4 的决定）', () => {
  // 宿主只对模型可见事件调 accountPayload ⇒ compaction 根本进不了账，也没有任何清零路径
  assert.equal(isModelVisibleEvent('compaction/start'), false)
  assert.equal(isModelVisibleEvent('compaction/end'), false)

  const id = 's-nondecay'
  clearSessionRuntime(id)
  accountPayload(id, { seq: 1, bytes: 4_000_000 })
  assert.equal(payloadBytesOf(id), 4_000_000)
  // 任何"更小"的样本都不能让它降：旧 seq、零/负字节、脏 seq
  accountPayload(id, { seq: 0, bytes: 10 })
  accountPayload(id, { seq: 2, bytes: 0 })
  accountPayload(id, { seq: 2, bytes: -5 })
  accountPayload(id, { seq: 'x', bytes: 1 })
  assert.equal(payloadBytesOf(id), 4_000_000, '只增不减')
  // header 也只影响叠加项，不会把它清掉
  accountPayload(id, { header: true, bytes: 100 })
  assert.equal(payloadBytesOf(id), 4_000_100)
  clearSessionRuntime(id)
})
