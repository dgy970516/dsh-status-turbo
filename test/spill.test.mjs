/**
 * lib/spill.js（B3 结果瘦身层）的行为测试。
 *
 * 纪律：每条测例都是真断言；缺宿主能力的场景断言**降级路径**（故障对象或抛出），
 * 不使用任何隐式跳过。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  SPILL_HOOK,
  enhancementOf,
  fullText,
  localTrim,
  measureBytes,
  readThreshold,
  shouldSpill,
  spillFault,
  spillOnce,
} from '../lib/spill.js'

const THRESHOLD = 32768 // 由调用方传入；lib/spill.js 自身不定义默认值
// 0.6.5 的三个本地裁剪预算（与 lib/state.js · DEFAULT_CONFIG 逐字同值）。
const LOCAL_HEAD_CHARS = 4096
const LOCAL_TAIL_CHARS = 1024
const LOCAL_MIN_CHARS = 8192
const CONFIG = Object.freeze({
  spillThresholdBytes: THRESHOLD,
  localTrimHeadChars: LOCAL_HEAD_CHARS,
  localTrimTailChars: LOCAL_TAIL_CHARS,
  localTrimMinChars: LOCAL_MIN_CHARS,
})
const POSIX_LOCATOR = '/tmp/dsh-spill/sess-1/bash-1.txt'
const WINDOWS_LOCATOR = 'C:\\Users\\tester\\AppData\\Local\\Temp\\dsh-spill\\sess-1\\bash-2.txt'
const READ_HINT = 'Use read with offset/limit, or grep this path to search within it.'

// 宿主的真实 pruner 预算（dsh-compaction-tool-result-pruner: 8192/4096/1024）。
const HOST_PRUNE_THRESHOLD_CHARS = 8192
const HOST_HEAD_CHARS = 4096
const HOST_TAIL_CHARS = 1024

const SOURCE = readFileSync(new URL('../lib/spill.js', import.meta.url), 'utf8')
const TEST_SOURCE = readFileSync(new URL(import.meta.url), 'utf8')

/** 造一个远超 5 MiB 的工具结果正文。 */
function bigContent() {
  const line =
    '2026-10-06T22:53:41.000Z INFO  turbo 处理中 pipeline-stage=verify detail=abcdefghijklmnopqrstuvwxyz0123456789\n'
  const repeats = Math.ceil((5 * 1024 * 1024) / Buffer.byteLength(line, 'utf8'))
  return [{ type: 'text', text: line.repeat(repeats) }]
}

function makeExec(overrides = {}) {
  return {
    name: 'bash',
    callId: 'call-1',
    arguments: {},
    agent: { session: { header: { id: 'sess-1' } } },
    ...overrides,
  }
}

/** 宿主瘦身器的替身：真实实现是 head/middle/tail 替换，超出预算才返回内容。 */
function makeFakePruner() {
  const pruner = {
    calls: 0,
    pruneContent(blocks) {
      pruner.calls += 1
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
      if (text.length <= HOST_PRUNE_THRESHOLD_CHARS) return null
      const head = text.slice(0, HOST_HEAD_CHARS)
      const tail = text.slice(-HOST_TAIL_CHARS)
      const omitted = text.length - head.length - tail.length
      return [{ type: 'text', text: `${head}\n[... ${omitted} chars omitted by the host pruner ...]\n${tail}` }]
    },
  }
  return pruner
}

/** 宿主 spill 后端的替身：真实实现把正文写进会话私有目录并返回绝对 locator。 */
function makeFakeStore(saves, locator = POSIX_LOCATOR) {
  return {
    calls: 0,
    async saveText(request) {
      this.calls += 1
      saves.push(request)
      return { locator, bytes: Buffer.byteLength(request.content, 'utf8'), retrievalHint: READ_HINT }
    },
  }
}

function makeCtx({ pruner = makeFakePruner(), store } = {}) {
  return {
    get: (name) => (name === 'spillStore' ? store : undefined),
    toolResultPruner: pruner,
  }
}

/**
 * 真实 Cordis 上下文的最小替身（0.6.1 线上回归用）。
 *
 * 与上面 `makeCtx` 的关键差别：读**未声明进 `inject` 的服务属性**是**抛错**，不是返回
 * `undefined` —— 逐字 `cannot get property "X" without inject`。这正是线上「工具增强失败」
 * 红字的来源；`makeCtx` 那样的普通对象永远复现不出来。`get(name)` 只认已注册的服务。
 */
function makeCordisLikeCtx({ registered = {} } = {}) {
  return new Proxy(
    { get: (name) => registered[name] },
    {
      get(target, prop, receiver) {
        if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop, receiver)
        if (Object.hasOwn(registered, prop)) return registered[prop]
        throw new Error(`cannot get property "${prop}" without inject`)
      },
    },
  )
}

// ---------------------------------------------------------------------------
// O9：超大结果瘦身
// ---------------------------------------------------------------------------

test('O9：5 MiB 结果瘦身后体积 < 阈值，且通知行含可读绝对路径', async () => {
  const original = bigContent()
  const result = { isError: false, content: original }
  const saves = []
  const faults = []
  const pruner = makeFakePruner()
  const ctx = makeCtx({ pruner, store: makeFakeStore(saves) })

  const r = await spillOnce(ctx, makeExec(), result, CONFIG, (fault) => faults.push(fault))

  assert.ok(measureBytes(original) >= 5 * 1024 * 1024, `原始正文只有 ${measureBytes(original)} bytes`)
  assert.deepEqual(faults, [])
  assert.notEqual(r, null)
  assert.equal(r.locator, POSIX_LOCATOR)
  assert.equal(r.notice.type, 'text')

  // 体积达标：替换后的正文（pruned + notice）必须低于阈值。
  const after = measureBytes([...r.pruned, r.notice])
  assert.ok(after < THRESHOLD, `瘦身后 ${after} bytes 未低于阈值 ${THRESHOLD}`)
  assert.ok(after < measureBytes(original) / 100)

  // 瘦身确实来自注入的宿主 pruner，而不是本模块自己截断。
  assert.equal(pruner.calls, 1)
  assert.notEqual(r.pruned, original)
  assert.ok(r.pruned.some((b) => b.type === 'text' && b.text.includes('omitted by the host pruner')))
  assert.ok(r.pruned.every((b) => !(b.type === 'text' && b.text.includes('完整结果落盘于'))))

  // O9 硬判据：可读的绝对路径，逐字出现在模型上下文里。
  assert.match(r.locator, /^(?:\/|[A-Za-z]:[\\/]|\\\\)/)
  assert.ok(r.notice.text.includes(`完整结果落盘于：${r.locator}。`))
  assert.ok(r.notice.text.includes('已省略'))

  // {bytes} = 原始正文 UTF-8 字节数 − 瘦身后字节数（PLAN.md §3.4）。
  assert.equal(r.bytes, measureBytes(original) - measureBytes(r.pruned))
  assert.ok(r.bytes > THRESHOLD)
})

test('O9：saveText 收到契约输入 owner/source/suggestedName/content', async () => {
  const original = bigContent()
  const saves = []
  const ctx = makeCtx({ store: makeFakeStore(saves) })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: original }, CONFIG, () => {})

  assert.notEqual(r, null)
  assert.equal(saves.length, 1)
  assert.deepEqual(saves[0].owner, { sessionId: 'sess-1' })
  assert.deepEqual(saves[0].source, {
    kind: 'tool',
    toolName: 'bash',
    callId: 'call-1',
    label: 'result',
  })
  assert.equal(saves[0].suggestedName, 'bash.txt')
  assert.equal(saves[0].content, fullText(original))
})

test('O9：locator 原样进入通知行（相对化/缩写/加引号都不允许），Windows 绝对路径同样通过', async () => {
  const original = bigContent()
  const saves = []
  const ctx = makeCtx({ store: makeFakeStore(saves, WINDOWS_LOCATOR) })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: original }, CONFIG, () => {})

  assert.notEqual(r, null)
  assert.equal(r.locator, WINDOWS_LOCATOR)
  assert.ok(r.notice.text.includes(`完整结果落盘于：${WINDOWS_LOCATOR}。`))
  assert.ok(!r.notice.text.includes(JSON.stringify(WINDOWS_LOCATOR)))
  assert.ok(!r.notice.text.includes(`“${WINDOWS_LOCATOR}”`))
})

// ---------------------------------------------------------------------------
// G3：失败必须可见（降级路径真断言）
// ---------------------------------------------------------------------------

test('G3：pruneContent 返回 null 但已超阈值 → 返回 null + 上报 ' + SPILL_HOOK + ' 故障，不改 content', async () => {
  const result = { isError: false, content: bigContent() }
  const faults = []
  const saves = []
  const pruner = { calls: 0, pruneContent: () => null }
  const ctx = makeCtx({ pruner, store: makeFakeStore(saves) })

  const r = await spillOnce(ctx, makeExec(), result, CONFIG, (fault) => faults.push(fault))

  assert.equal(r, null)
  assert.equal(saves.length, 0)
  assert.equal(faults.length, 1)
  assert.equal(faults[0].hook, 'spill')
  assert.equal(faults[0].message, 'over spillThresholdBytes but the host result pruner declined')
  assert.equal(typeof faults[0].at, 'number')
  assert.ok(faults[0].at > 0)
})

test('0.6.5 B（重写 0.6.4 B）：pruner 缺席不再是「缺席」——只有落盘后端那种 warn 一次', async () => {
  const warns = []
  const result = { isError: false, content: bigContent() }
  const exec = makeExec()

  // ① 落盘后端缺席 —— 本文件里第一次遇到这个原因，必须恰好 warn 一次。
  const noStore = makeCtx({ pruner: makeFakePruner() })
  noStore.logger = { warn: (message) => warns.push(message) }
  assert.equal(await spillOnce(noStore, exec, result, CONFIG, () => {}), null)
  assert.equal(await spillOnce(noStore, exec, result, CONFIG, () => {}), null)
  assert.equal(warns.length, 1, '同一缺席原因连续两次只许 warn 一次')
  assert.match(warns[0], /spill: no ctx\.spillStore backend loaded/)

  // ② pruner 缺席 ⇒ 本地裁剪，**一次 warn 都不该有**（0.6.4 的 ABSENT_PRUNER 已删除）。
  const noPruner = {
    get: (name) => (name === 'spillStore' ? makeFakeStore([]) : undefined),
    logger: { warn: (message) => warns.push(message) },
  }
  assert.notEqual(await spillOnce(noPruner, exec, result, CONFIG, () => {}), null)
  assert.notEqual(await spillOnce(noPruner, exec, result, CONFIG, () => {}), null)
  assert.equal(warns.length, 1, 'pruner 缺席不再是缺席：不许 warn')
})

test('0.6.4 A（新增）：spillStore 缺席 ⇒ spillOnce 返回 null，且 onFault 一次都没被调用', async () => {
  const result = { isError: false, content: bigContent() }
  const faults = []
  const pruner = makeFakePruner()

  const r = await spillOnce(makeCtx({ pruner }), makeExec(), result, CONFIG, (fault) => faults.push(fault))

  assert.equal(r, null)
  assert.equal(pruner.calls, 0)
  assert.deepEqual(faults, [], '可选能力缺席不是故障：一次都不许上报')
})

test('G3：spillStore 缺席 → 返回 null 保持 inline（先判后端、不空跑 pruneContent）', async () => {
  const result = { isError: false, content: bigContent() }
  const faults = []
  const pruner = makeFakePruner()
  const ctx = makeCtx({ pruner }) // get('spillStore') 返回 undefined

  const r = await spillOnce(ctx, makeExec(), result, CONFIG, (fault) => faults.push(fault))

  assert.equal(r, null)
  assert.equal(pruner.calls, 0)
  assert.deepEqual(faults, [])
})

test('G3：saveText 拒绝 → 返回 null + 上报原始错误信息，内容保持原样', async () => {
  const original = bigContent()
  const result = { isError: false, content: original }
  const faults = []
  const store = makeFakeStore([], POSIX_LOCATOR)
  store.saveText = async () => {
    throw new Error('ENOSPC: no space left on device')
  }

  const r = await spillOnce(makeCtx({ store }), makeExec(), result, CONFIG, (fault) => faults.push(fault))

  assert.equal(r, null)
  assert.equal(result.content, original)
  assert.equal(faults.length, 1)
  assert.equal(faults[0].message, 'ENOSPC: no space left on device')
})

test('0.6.5 A（重写 0.6.4 A）：toolResultPruner 缺席 ⇒ 本地裁剪接管，onFault 零调用', async () => {
  const faults = []
  const saves = []
  const ctx = { get: (name) => (name === 'spillStore' ? makeFakeStore(saves) : undefined) }

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, (f) => faults.push(f))

  assert.notEqual(r, null, '拿不到宿主 pruner 不再是放弃：0.6.5 起本地裁剪接管')
  assert.equal(saves.length, 1, '本地裁剪路径同样必须落盘完整原文')
  assert.deepEqual(faults, [], '本地裁剪是正常路径，不是故障')
})

test('0.6.5 G3（重写 G3）：toolResultPruner 缺席不再保持 inline —— 本地裁剪 + 落盘', async () => {
  const faults = []
  const saves = []
  const ctx = {
    get: (name) => (name === 'spillStore' ? makeFakeStore(saves) : undefined),
  }

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, (f) => faults.push(f))

  assert.notEqual(r, null)
  assert.equal(saves.length, 1)
  assert.equal(r.pruned.some((b) => b.type === 'text' && b.text.includes('此处省略')), true)
  assert.deepEqual(faults, [])
})

test('0.6.4 A（新增）：pruner 在位但 pruneContent 抛 Error(boom) ⇒ 真故障，onFault 收到含 boom 的 message', async () => {
  const faults = []
  const pruner = {
    pruneContent() {
      throw new Error('boom')
    },
  }
  const ctx = makeCtx({ store: makeFakeStore([]), pruner })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, (f) => faults.push(f))

  assert.equal(r, null)
  assert.equal(faults.length, 1)
  assert.equal(faults[0].hook, SPILL_HOOK)
  assert.match(faults[0].message, /boom/)
})

test('0.6.4 A（新增）：pruner 在位但返回非数组 ⇒ 真故障，onFault 被调用', async () => {
  const faults = []
  const pruner = { pruneContent: () => ({ not: 'an array' }) }
  const ctx = makeCtx({ store: makeFakeStore([]), pruner })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, (f) => faults.push(f))

  assert.equal(r, null)
  assert.equal(faults.length, 1)
  assert.equal(faults[0].hook, SPILL_HOOK)
  assert.match(faults[0].message, /declined/)
})

test('G3：非绝对 locator → 降级并上报（不把相对路径交给模型）', async () => {
  const faults = []
  const saves = []
  const ctx = makeCtx({ store: makeFakeStore(saves, 'spill/sess-1/bash-1.txt') })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, (f) => faults.push(f))

  assert.equal(r, null)
  assert.equal(faults.length, 1)
  assert.match(faults[0].message, /not an absolute path/)
  assert.equal(saves.length, 1) // 落盘已发生，但正文不被替换
})

test('G3：没有注入任何上报通道时，真降级仍然必须抛出（禁止静默 return）', async () => {
  // 可选能力缺席在 0.6.4 已不是降级：没有上报通道也不抛，只返回 null 保持 inline。
  const absentCtx = { get: () => undefined }
  assert.equal(await spillOnce(absentCtx, makeExec(), { isError: false, content: bigContent() }, CONFIG), null)

  const ctx2 = makeCtx({ store: makeFakeStore([]) })
  ctx2.toolResultPruner = { pruneContent: () => null }
  await assert.rejects(
    () => spillOnce(ctx2, makeExec(), { isError: false, content: bigContent() }, CONFIG),
    /the host result pruner declined/,
  )
})

test('G3：ctx.reportFault 可以作为 onFault 的替代通道', async () => {
  const seen = []
  const ctx = makeCtx({ store: makeFakeStore([]), pruner: { pruneContent: () => null } })
  ctx.reportFault = (fault) => seen.push(fault)

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG)

  assert.equal(r, null)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].hook, SPILL_HOOK)
  assert.equal(seen[0].message, 'over spillThresholdBytes but the host result pruner declined')
})

// ---------------------------------------------------------------------------
// 0.6.1 线上回归：未声明进 inject 的服务只能经 ctx.get 读取
//
// 线上实测（详情面板「最近的故障」逐字）：
//   15:08:36 spill: cannot get property "toolResultPruner" without inject
// 起因是 `ctx.toolResultPruner` 的属性直读在真实 Cordis 上下文里抛异常，
// 而被触发的场景恰好是「一次超过 spillThresholdBytes 的工具结果」。
// ---------------------------------------------------------------------------

test('0.6.5 A（线上回归）：真实 Cordis 上下文读未声明的 toolResultPruner 会抛 without-inject → 本地裁剪接手、不报故障', async () => {
  const faults = []
  const saves = []
  const ctx = makeCordisLikeCtx({ registered: { spillStore: makeFakeStore(saves) } })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, (f) => faults.push(f))

  assert.notEqual(r, null, '属性直读抛 without-inject 只意味着「拿不到」，0.6.5 起由本地裁剪接手')
  assert.equal(saves.length, 1)
  assert.deepEqual(faults, [], '组隔离读不到是设计：不得进「最近的故障」，状态条不许变红')
})

test('G3（线上回归）：真降级且 onFault 与 reportFault 都缺席时，仍走契约的"抛出"通道', async () => {
  const ctx = makeCordisLikeCtx({
    registered: { spillStore: makeFakeStore([]), toolResultPruner: { pruneContent: () => null } },
  })

  await assert.rejects(
    () => spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG),
    /the host result pruner declined/,
  )
})

test('G3（线上回归）：pruner 在服务表里时经 ctx.get 正常取到，瘦身照常完成', async () => {
  const saves = []
  const pruner = makeFakePruner()
  const ctx = makeCordisLikeCtx({
    registered: { spillStore: makeFakeStore(saves), toolResultPruner: pruner },
  })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, () => {})

  assert.notEqual(r, null)
  assert.equal(pruner.calls, 1)
  assert.equal(saves.length, 1)
  assert.ok(r.notice.text.includes('完整结果落盘于：'))
})

test('G3（线上回归）：reportFault 在服务表里时，onFault 缺席也能收真降级故障', async () => {
  const seen = []
  const ctx = makeCordisLikeCtx({
    registered: {
      reportFault: (fault) => seen.push(fault),
      spillStore: makeFakeStore([]),
      toolResultPruner: { pruneContent: () => null },
    },
  })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG)

  assert.equal(r, null)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].hook, SPILL_HOOK)
  assert.equal(seen[0].message, 'over spillThresholdBytes but the host result pruner declined')
})

test('spillFault：形状为 { at, hook, message }（PLAN.md §4.2）', () => {
  assert.deepEqual(spillFault(new Error('boom'), 42), { at: 42, hook: 'spill', message: 'boom' })
  assert.deepEqual(spillFault('raw reason', 7), { at: 7, hook: 'spill', message: 'raw reason' })
  assert.deepEqual(spillFault(undefined, 1), { at: 1, hook: 'spill', message: 'unknown spill failure' })
  assert.equal(spillFault(new Error('x')).at > 0, true)
})

// ---------------------------------------------------------------------------
// 判定表负例与阈值语义
// ---------------------------------------------------------------------------

test('B3 负例：isError / read 工具 / 未达阈值 → 返回 null，且不调 pruneContent、不落盘、无故障', async () => {
  const pruner = makeFakePruner()
  const saves = []
  const faults = []
  const ctx = makeCtx({ pruner, store: makeFakeStore(saves) })
  const big = bigContent()
  const small = [{ type: 'text', text: 'tiny output' }]

  const cases = [
    { label: 'isError', exec: makeExec(), result: { isError: true, content: big } },
    { label: 'read', exec: makeExec({ name: 'read' }), result: { isError: false, content: big } },
    { label: 'below-threshold', exec: makeExec(), result: { isError: false, content: small } },
  ]

  for (const c of cases) {
    const r = await spillOnce(ctx, c.exec, c.result, CONFIG, (fault) => faults.push(fault))
    assert.equal(r, null, `${c.label} 不应产出瘦身决策`)
  }
  assert.equal(pruner.calls, 0)
  assert.equal(saves.length, 0)
  assert.deepEqual(faults, [])
})

test('阈值非法（缺失/负数/非整数/非数字）→ 视为未配置：shouldSpill=false，spillOnce=null，无故障', async () => {
  const pruner = makeFakePruner()
  const saves = []
  const faults = []
  const ctx = makeCtx({ pruner, store: makeFakeStore(saves) })
  const exec = makeExec()
  const result = { isError: false, content: bigContent() }

  const configs = [
    undefined,
    null,
    {},
    { spillThresholdBytes: -1 },
    { spillThresholdBytes: 1.5 },
    { spillThresholdBytes: Number.MAX_SAFE_INTEGER + 2 },
    { spillThresholdBytes: '32768' },
  ]

  for (const config of configs) {
    assert.equal(readThreshold(config), null)
    assert.equal(shouldSpill(exec, result, config), false)
    assert.equal(await spillOnce(ctx, exec, result, config, (fault) => faults.push(fault)), null)
  }
  assert.equal(pruner.calls, 0)
  assert.equal(saves.length, 0)
  assert.deepEqual(faults, [])
  assert.equal(readThreshold({ spillThresholdBytes: 0 }), 0)
})

test('shouldSpill：静态判据与 >= 边界', () => {
  const exec = makeExec()
  const atThreshold = [{ type: 'text', text: 'a'.repeat(THRESHOLD) }]
  const below = [{ type: 'text', text: 'a'.repeat(THRESHOLD - 1) }]

  assert.equal(measureBytes(atThreshold), THRESHOLD)
  assert.equal(shouldSpill(exec, { isError: false, content: atThreshold }, CONFIG), true)
  assert.equal(shouldSpill(exec, { isError: false, content: below }, CONFIG), false)
  assert.equal(shouldSpill(makeExec({ name: 'read' }), { isError: false, content: atThreshold }, CONFIG), false)
  assert.equal(shouldSpill(exec, { isError: true, content: atThreshold }, CONFIG), false)
  assert.equal(shouldSpill(exec, null, CONFIG), false)
  assert.equal(shouldSpill(null, { isError: false, content: atThreshold }, CONFIG), false)
})

test('fullText / measureBytes：文本拼接、非文本块占位、UTF-8 字节数', () => {
  assert.equal(fullText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(measureBytes([{ type: 'text', text: '中' }]), 3)
  assert.equal(measureBytes([{ type: 'text', text: 'ab' }]), 2)

  const mixed = [{ type: 'text', text: 'x' }, { type: 'image', attachment: { mediaType: 'image/png' } }]
  assert.ok(fullText(mixed).startsWith('x'))
  assert.ok(fullText(mixed).includes('[image block not inlined in spill text]'))
  assert.equal(measureBytes(mixed) > 1, true)

  assert.equal(fullText(undefined), '')
  assert.equal(fullText(null), '')
  assert.equal(measureBytes(undefined), 0)
  assert.deepEqual(fullText([null, 7, { type: 'text', text: 'ok' }]).endsWith('ok'), true)
})

// ---------------------------------------------------------------------------
// 0.6.5：拿不到宿主 pruner ⇒ 本地裁剪（真跑 spillOnce / 真调 localTrim）
// ---------------------------------------------------------------------------

test('0.6.5 ② 本地裁剪：保头 4096 / 保尾 1024 / 中间一条省略标记，且入参一个字符都没动', async () => {
  const original = bigContent()
  const text = original[0].text
  const saves = []
  const ctx = { get: (name) => (name === 'spillStore' ? makeFakeStore(saves) : undefined) }

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: original }, CONFIG, () => {})

  assert.notEqual(r, null)
  const prunedText = r.pruned[0].text
  assert.equal(prunedText.startsWith(text.slice(0, LOCAL_HEAD_CHARS)), true, '头 LOCAL_HEAD_CHARS 字符逐字保留')
  assert.equal(prunedText.endsWith(text.slice(-LOCAL_TAIL_CHARS)), true, '尾 LOCAL_TAIL_CHARS 字符逐字保留')
  assert.match(prunedText, /…（此处省略 \d+ 个字符）…/)
  assert.equal(prunedText.length < text.length, true, '裁完必须真的更短')

  // 纯函数契约：返回新数组、新对象，入参一字不动。
  assert.equal(original[0].text, text, '入参被改动 = 丢原文')
  assert.notEqual(r.pruned, original)
  assert.notEqual(r.pruned[0], original[0])
})

test('0.6.5 ③ 本地裁剪只碰最长文本块：非文本块原样保留（同一引用、不丢）', async () => {
  const image = { type: 'image', attachment: { mediaType: 'image/png', path: '/tmp/shot.png' } }
  const original = [...bigContent(), image]
  const ctx = { get: (name) => (name === 'spillStore' ? makeFakeStore([]) : undefined) }

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: original }, CONFIG, () => {})

  assert.notEqual(r, null)
  assert.equal(r.pruned.length, 2)
  assert.equal(r.pruned[1], image, '非文本块必须原样保留（连引用都不换）')
  assert.equal(r.pruned[0].type, 'text')
  assert.ok(r.pruned[0].text.includes('此处省略'))

  // 一个文本块都没有时无可裁 —— 返回 null 而不是凭空造出内容。
  assert.equal(localTrim([image], CONFIG), null)
})

test('0.6.5 ④ 短文不裁：最长文本块短于 localTrimMinChars 时返回 null、不落盘、不上报', async () => {
  assert.equal(localTrim([{ type: 'text', text: '很短的一行' }], CONFIG), null, '纯函数：远短于门槛 ⇒ null')

  // 真跑：10 个 4000 字符块 —— 总量超过字节门槛，但没有一块达到 localTrimMinChars。
  const chunk = 'x'.repeat(4000)
  const content = Array.from({ length: 10 }, () => ({ type: 'text', text: chunk }))
  assert.equal(measureBytes(content) >= THRESHOLD, true, '构造必须真的越过 spillThresholdBytes')
  const saves = []
  const faults = []
  const ctx = { get: (name) => (name === 'spillStore' ? makeFakeStore(saves) : undefined) }

  const r = await spillOnce(ctx, makeExec(), { isError: false, content }, CONFIG, (f) => faults.push(f))

  assert.equal(r, null, '没有够长的块可裁 ⇒ 保持 inline')
  assert.equal(saves.length, 0)
  assert.deepEqual(faults, [], '裁不动不是故障')
})

test('0.6.5 ⑤ 本地裁剪绝不变长：结果不短于原文就返回 null', () => {
  const text = 'a'.repeat(9000)
  // 只剩 1 个字符可省，省略标记行却更长 ⇒ 拒绝（返回 null）。
  assert.equal(localTrim([{ type: 'text', text }], { localTrimHeadChars: 8999, localTrimTailChars: 0, localTrimMinChars: 0 }), null)
  // 头尾已覆盖全文 ⇒ 无可省。
  assert.equal(localTrim([{ type: 'text', text }], { localTrimHeadChars: 5000, localTrimTailChars: 4000, localTrimMinChars: 0 }), null)
  // 反证：同一份入参，省得够多就一定裁得短。
  const trimmed = localTrim([{ type: 'text', text }], { localTrimHeadChars: 10, localTrimTailChars: 10, localTrimMinChars: 0 })
  assert.notEqual(trimmed, null)
  assert.ok(trimmed[0].text.length < text.length)
  // 三个配置项任一非法 ⇒ 视为未配置，宁可不裁。
  assert.equal(localTrim([{ type: 'text', text }], { localTrimHeadChars: 10, localTrimTailChars: 10 }), null)
  assert.equal(localTrim([{ type: 'text', text }], null), null)
  assert.equal(localTrim(null, { localTrimHeadChars: 10, localTrimTailChars: 10, localTrimMinChars: 0 }), null)
})

test('0.6.5 ⑥ 宿主 pruner 优先：能拿到就绝不触发本地裁剪', async () => {
  const pruner = makeFakePruner()
  const ctx = makeCtx({ pruner, store: makeFakeStore([]) })

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: bigContent() }, CONFIG, () => {})

  assert.equal(pruner.calls, 1, '宿主 pruner 必须被调用')
  const text = r.pruned[0].text
  assert.ok(text.includes('omitted by the host pruner'), '产物必须来自宿主 pruner')
  assert.equal(text.includes('此处省略'), false, '宿主在位时本地裁剪一次都不许触发')
})

test('0.6.5 ⑦ enhancementOf 三态 mode：host-pruner / local-trim / off', () => {
  const store = makeFakeStore([])

  assert.deepEqual(enhancementOf(makeCtx({ store, pruner: makeFakePruner() })), {
    active: true,
    mode: 'host-pruner',
    reason: null,
  })

  const localOnly = { get: (name) => (name === 'spillStore' ? store : undefined) }
  assert.deepEqual(enhancementOf(localOnly), { active: true, mode: 'local-trim', reason: null })

  assert.deepEqual(enhancementOf(makeCtx({ pruner: makeFakePruner() })), {
    active: false,
    mode: 'off',
    reason: 'no ctx.spillStore backend loaded',
  })

  // 真实 Cordis 上下文读未声明的 pruner 会抛：等同「拿不到」⇒ local-trim，而不是 off。
  assert.deepEqual(enhancementOf(makeCordisLikeCtx({ registered: { spillStore: store } })), {
    active: true,
    mode: 'local-trim',
    reason: null,
  })
})

test('0.6.5 ⑨ 本地裁剪仍把**完整原文**走 spillStore.saveText，locator 必须是绝对路径', async () => {
  const original = bigContent()
  const saves = []
  const ctx = { get: (name) => (name === 'spillStore' ? makeFakeStore(saves, WINDOWS_LOCATOR) : undefined) }

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: original }, CONFIG, () => {})

  assert.notEqual(r, null)
  assert.equal(saves.length, 1)
  assert.equal(saves[0].content, fullText(original), '落盘的必须是完整原文，裁剪只影响给模型看的正文')
  assert.equal(r.locator, WINDOWS_LOCATOR, 'locator 是绝对路径，原样进通知行')
  assert.equal(r.locator.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(r.locator), true)
  assert.ok(r.notice.text.includes(`完整结果落盘于：${WINDOWS_LOCATOR}。`))
})

test('0.6.5 ⑩ 本地裁剪真的省字节：产物比原文短，且 notice / bytes 的差额与 measureBytes 逐字一致', async () => {
  const original = bigContent()
  const ctx = { get: (name) => (name === 'spillStore' ? makeFakeStore([]) : undefined) }

  const r = await spillOnce(ctx, makeExec(), { isError: false, content: original }, CONFIG, () => {})

  assert.notEqual(r, null)
  const before = measureBytes(original)
  const after = measureBytes(r.pruned)
  assert.ok(before >= THRESHOLD, `原始必须真的越过门槛（${before}）`)
  assert.ok(after < before, `本地裁剪必须真的省下字节（after=${after} 不小于 before=${before}）`)
  assert.equal(r.bytes, before - after)
  assert.match(r.notice.text, new RegExp(`已省略 ${before - after} bytes`))
})

// ---------------------------------------------------------------------------
// 静态约束（G1 / 硬约束 / G5）
// ---------------------------------------------------------------------------

test('静态检查：lib/spill.js 零 import、无 fs 写 API、含 pruneContent + saveText + localTrim / 无宿主外写盘', () => {
  assert.doesNotMatch(SOURCE, /node:fs|readFileSync|writeFileSync|createWriteStream/)
  assert.doesNotMatch(SOURCE, /^\s*import\s/m)
  assert.doesNotMatch(SOURCE, /require\s*\(/)
  assert.ok(SOURCE.includes('pruneContent'))
  assert.ok(SOURCE.includes('saveText'))
  // 0.6.5：本地裁剪是本模块**唯一**的正文切片点，而落盘仍然只经 saveText（正文完整原文）。
  assert.ok(!SOURCE.includes('writeFile') && !SOURCE.includes('createWriteStream'))
  assert.match(SOURCE, /export function localTrim\(/)
  assert.match(SOURCE, /export function shouldSpill\(/)
  assert.match(SOURCE, /export async function spillOnce\(/)
  // 0.6.4 的 ABSENT_PRUNER 必须已删除，不留死代码。
  assert.doesNotMatch(SOURCE, /ABSENT_PRUNER/)
  assert.doesNotMatch(SOURCE, /no ctx\.toolResultPruner loaded/)
})

test('G5：本测试文件不含隐式跳过（skip 标记出现次数为 0）', () => {
  const needles = [['t', 'skip'].join('.'), ['', 'skip('].join('.')]
  for (const needle of needles) {
    assert.equal(TEST_SOURCE.split(needle).length - 1, 0, `发现隐式跳过标记 ${needle}`)
  }
  assert.ok(TEST_SOURCE.includes("from 'node:test'"))
  assert.ok((TEST_SOURCE.match(/\ntest\(/g) ?? []).length >= 12)
})
