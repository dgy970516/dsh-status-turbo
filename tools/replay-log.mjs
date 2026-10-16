/**
 * dsh-status-turbo dev tool — replay a real session log through lib/state.js.
 *
 * 用途：在没有界面的情况下，用**真实已落盘的会话日志**验证状态条的折叠与文案，
 * 拿到可引用的数字（阶段、本阶段耗时、token、命中率、无进展告警）。
 *
 * 用法：
 *   node tools/replay-log.mjs <session.v4.jsonl.zstd> [--peek] [--max N] [--stall-ms N]
 *
 * 日志是**多帧** zstd 拼接（每帧一段 jsonl）。先按 zstd magic 切帧，再逐帧解压。
 *
 * 两类输出，别混着读（PLAN.md §5.3 / T07 的 M2）：
 *   ① **日志派生**（可当重放结论）：状态条那一行字、B4 前缀作废的每一次触发（`compaction/start` /
 *      `compaction/end` / 大块 `tool/result`）、A2 最长工具窗口、O4 的 `step/start` 计数。
 *   ② **非日志派生**（不许当重放结论）：wire 视图里的 `hookFaults` / `lastSpill` —— 这两项只由钩子层
 *      写进 `lib/state.js` 的会话运行时表（lib/state.js:181-185、:630-632），本工具从不注册会话，
 *      所以重放里必然恒为 `[]` / `null`。本节只做"排除 + 断言"，一旦非空就说明折叠被污染了，直接非零退出。
 * `--max N`：只截断**打印**行数；上面①②的统计永远按全量日志折叠 —— 引用数字时必须与 `--max` 无关。
 * `--peek` 还会打印 `tool/call` 与 `tool/result` 的 data **键名**（供 BLOCKING-INSPECT-1/3 取证）。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { applyEvent, initState, toView, DEFAULT_CONFIG } from '../lib/state.js'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 按 magic 切帧（magic 出现在压缩载荷内部时会被误切，故每帧解压失败仅告警跳过）。 */
function splitFrames(buf) {
  const starts = []
  let i = 0
  for (;;) {
    const j = buf.indexOf(ZSTD_MAGIC, i)
    if (j === -1) break
    starts.push(j)
    i = j + 1
  }
  const frames = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    frames.push(buf.subarray(starts[k], end))
  }
  return frames
}

function decode(path) {
  const raw = readFileSync(path)
  const frames = splitFrames(raw)

  // 先试整块单帧解压（快路径）。
  let single = null
  try {
    single = zstdDecompressSync(raw)
  } catch {
    single = null
  }

  const chunks = []
  let failed = 0
  for (const f of frames) {
    try {
      chunks.push(zstdDecompressSync(f))
    } catch {
      failed += 1
    }
  }
  const multi = failed === 0 && chunks.length > 1 ? Buffer.concat(chunks) : null

  const picked = multi && (!single || multi.length > single.length) ? 'multi-frame' : 'single-frame'
  const text = (picked === 'multi-frame' ? multi : single).toString('utf8')
  return { text, picked, frameCount: frames.length, failed }
}

// —— 与 lib/client.js 同一套文案与格式化，保证这里打出来的就是状态条上的字 ——

const ZH = {
  'phase.idle': '空闲',
  'phase.assembling': '组装提示词',
  'phase.requesting': '请求模型',
  'phase.streaming': '接收流',
  'phase.tool': '执行工具',
  'phase.approval': '等待批准',
  'phase.compacting': '压缩上下文',
  'stall.tool': '工具可能卡死',
  'stall.other': '模型可能卡死',
}

function fmtElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function fmtTokens(n) {
  if (n === null || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 1e6) return n < 1e4 ? `${(n / 1000).toFixed(1)}K` : `${Math.round(n / 1000)}K`
  return `${(n / 1e6).toFixed(1)}M`
}

/** 渲染成状态条上的那一行字（busy 时才有内容）。 */
function render(view, now) {
  if (!view.busy) return null
  const phase = view.phase === 'tool' && view.tool ? `${ZH['phase.tool']}(${view.tool})` : ZH[`phase.${view.phase}`] ?? view.phase
  const parts = [phase, fmtElapsed(now - (view.phaseStartedAt ?? now))]
  if (view.stepTokens !== null) parts.push(`本步 ${fmtTokens(view.stepTokens)}`)
  if (view.hitRate !== null) parts.push(`命中 ${Math.round(view.hitRate * 100)}%`)
  if (view.retries > 0) parts.push(`重试 ${view.retries}`)
  const sinceProgress = view.lastProgressAt === null ? 0 : now - view.lastProgressAt
  if (sinceProgress > view.noProgressMs) {
    parts.push(`⚠ ${fmtElapsed(sinceProgress)} ${view.tool ? ZH['stall.tool'] : ZH['stall.other']}`)
  }
  return parts.join('   ')
}

// —— main ——

const args = process.argv.slice(2)
const path = args.find((a) => !a.startsWith('--'))
if (!path) {
  console.error('用法: node tools/replay-log.mjs <session.v4.jsonl.zstd> [--peek] [--max N] [--stall-ms N]')
  process.exit(2)
}
const getNum = (flag, fallback) => {
  const i = args.indexOf(flag)
  if (i === -1) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}
const peekOnly = args.includes('--peek')
const maxLines = getNum('--max', Infinity)
const stallMs = getNum('--stall-ms', DEFAULT_CONFIG.noProgressMs)

const { text, picked, frameCount, failed } = decode(path)
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.log(`# 文件      ${path}`)
console.log(`# 解压方式  ${picked}（帧数 ${frameCount}，解压失败帧 ${failed}）`)
console.log(`# jsonl 行数 ${lines.length}`)

const events = []
let badJson = 0
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    badJson += 1
  }
}
console.log(`# 可解析事件 ${events.length}（跳过坏行 ${badJson}）`)

const counts = new Map()
for (const e of events) {
  const t = typeof e?.type === 'string' ? e.type : '<no type>'
  counts.set(t, (counts.get(t) ?? 0) + 1)
}
const top = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log('# 事件类型计数:')
for (const [t, n] of top) console.log(`#   ${String(n).padStart(6)}  ${t}`)

/** `data` 的键名（BLOCKING-INSPECT-1/3 要的就是它：写断言前先看日志到底给了哪些字段）。 */
function dataKeys(event) {
  if (!event) return '(日志里没有这类事件)'
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return `(data 不是对象：${typeof data})`
  const keys = Object.keys(data)
  return keys.length === 0 ? '(data 是空对象)' : keys.join(', ')
}

if (peekOnly) {
  console.log('# --- 前 3 行原文 ---')
  for (const l of lines.slice(0, 3)) console.log(l.slice(0, 900))
  const withUsage = events.find((e) => e?.type === 'assistant/message' && e?.data?.usage)
  if (withUsage) {
    console.log('# --- 一条 assistant/message 的 data 形状 ---')
    console.log(JSON.stringify(withUsage.data).slice(0, 900))
  }
  const withTool = events.find((e) => e?.type === 'tool/call')
  if (withTool) {
    console.log('# --- 一条 tool/call 的 data 形状 ---')
    console.log(JSON.stringify(withTool.data).slice(0, 400))
  }
  const withResult = events.find((e) => e?.type === 'tool/result')
  if (withResult) {
    console.log('# --- 一条 tool/result 的 data 形状 ---')
    console.log(JSON.stringify(withResult.data).slice(0, 400))
  }
  console.log('# --- data 键名（BLOCKING-INSPECT-1/3 取证用） ---')
  console.log(`#   tool/call    : ${dataKeys(withTool)}`)
  console.log(`#   tool/result  : ${dataKeys(withResult)}`)
  console.log(`#   step/start   : ${dataKeys(events.find((e) => e?.type === 'step/start'))}`)
  console.log(`#   compaction/*: start=${dataKeys(events.find((e) => e?.type === 'compaction/start'))} / end=${dataKeys(events.find((e) => e?.type === 'compaction/end'))}`)
  // O4：往返计数就是 step/start 的条数（重放只折叠日志，不新增任何往返）。
  console.log(`# O4 step/start 计数: ${counts.get('step/start') ?? 0}`)
  process.exit(0)
}

// —— 重放：一次**全量**折叠；`--max` 只截断打印，下面所有统计都不被它截断 ——
let state = initState()
const config = { noProgressMs: stallMs }
let lastText = null
let emitted = 0
let t0 = null
const b4 = [] // ① 日志派生：每一次前缀作废
let lastEpoch = 0
let stepStarts = 0
let nonLogHookFaults = 0 // ② 非日志派生：重放里必须恒为空
let nonLogLastSpill = 0
for (const e of events) {
  const before = state
  state = applyEvent(state, e)
  if (e?.time && t0 === null) t0 = e.time
  const now = typeof e?.time === 'number' ? e.time : t0
  const view = toView(state, config)

  /*
   * B4 只看 wire 视图的 `prefixEpoch` 涨没涨 —— 大块注入的**字节阈值**由 lib/state.js 自己判
   * （lib/state.js:431 `resultBytes(data) < bulkInjectionBytes(config)`），这里绝不重算一遍，
   * 否则同一个门槛就会有两套实现、两套数字。
   */
  if (view.prefixEpoch > lastEpoch) {
    lastEpoch = view.prefixEpoch
    b4.push({ epoch: view.prefixEpoch, cause: view.prefixCause, type: e?.type ?? '?', at: now - t0 })
  }
  // ② 非日志派生字段：只做排除与断言；任何一次非空都说明折叠被宿主内存污染了。
  if (view.hookFaults.length > 0) nonLogHookFaults += 1
  if (view.lastSpill !== null) nonLogLastSpill += 1
  if (e?.type === 'step/start') stepStarts += 1

  const nowText = render(view, now)
  const changed = nowText !== lastText || (before === state && nowText !== lastText)
  if (changed) {
    if (emitted < maxLines) {
      const mark = nowText === null ? '（空闲 — 不渲染）' : nowText
      console.log(`[+${fmtElapsed(now - t0).padStart(8)}] ${e?.type ?? '?'} → ${mark}`)
      emitted += 1
    }
    lastText = nowText
  }
}
if (Number.isFinite(maxLines) && emitted >= maxLines) {
  console.log(`# (达到 --max ${maxLines}：只截断了打印；B4 / 非日志派生 / 最长窗口仍按全量日志折叠)`)
}

// —— B4：真实日志里到底触发了哪几次前缀作废（① 日志派生，可当重放结论） ——
const B4_CAUSE_SOURCE = {
  'compaction-start': 'compaction/start',
  'compaction-end': 'compaction/end',
  'bulk-injection': 'tool/result（结果 ≥ bulkInjectionBytes）',
}
const byCause = new Map()
for (const hit of b4) byCause.set(hit.cause, (byCause.get(hit.cause) ?? 0) + 1)
console.log(`# B4 前缀作废: ${b4.length} 次（epoch → 原因 ← 触发事件）`)
for (const hit of b4) {
  const source = B4_CAUSE_SOURCE[hit.cause] ?? hit.cause
  console.log(`#   #${hit.epoch} ${hit.cause} ← ${hit.type}（会话 +${fmtElapsed(hit.at)}；来源：${source}）`)
}
const breakdown = [...byCause.entries()].map(([cause, n]) => `${cause}×${n}`).join(' / ')
console.log(`#   按原因拆分: ${breakdown === '' ? '（一次都没有）' : breakdown}`)

// —— 非日志派生字段：重放里必然为空，只做排除与断言（② 不许当重放结论） ——
const polluted = []
if (nonLogHookFaults !== 0) polluted.push(`hookFaults 有 ${nonLogHookFaults} 次非空`)
if (nonLogLastSpill !== 0) polluted.push(`lastSpill 有 ${nonLogLastSpill} 次非 null`)
console.log(
  `# 非日志派生（已排除，不作结论）: hookFaults 非空 ${nonLogHookFaults} 次 / lastSpill 非 null ${nonLogLastSpill} 次`,
)
console.log('#   为何必然为空：这两项只由钩子层写进 lib/state.js 的会话运行时表（:181-185）；')
console.log('#   wire 视图在表里查不到该会话时回落 [] / null（:630-632），而本工具从不注册会话。')
console.log('#   要验故障/落盘文案，请走 lib/index.js 的钩子路径与 test/hooks.test.mjs，别拿这里的空值当证据。')
if (polluted.length > 0) {
  console.error(`# ✗ 重放被污染，不再是纯日志派生：${polluted.join('；')}`)
  process.exitCode = 1
}

// —— O4：重放不新增往返 ——
console.log(`# O4 往返计数: step/start ${stepStarts} 次（本工具只折叠日志，不调宿主、不产生新往返）`)

// —— 最长的"工具窗口"：tool/call → 下一个事件的时间差 ——
let best = { ms: -1 }
for (let i = 0; i < events.length; i++) {
  if (events[i]?.type !== 'tool/call') continue
  const start = events[i]?.time
  let nextAt = null
  for (let j = i + 1; j < events.length; j++) {
    if (typeof events[j]?.time === 'number') {
      nextAt = events[j].time
      break
    }
  }
  if (typeof start === 'number' && typeof nextAt === 'number' && nextAt - start > best.ms) {
    best = { ms: nextAt - start, name: events[i]?.data?.name, at: start - t0 }
  }
}
if (best.ms >= 0) {
  console.log(
    `# 最长工具窗口: ${best.name ?? '?'} 静默 ${fmtElapsed(best.ms)}（发生在会话 +${fmtElapsed(best.at)}，` +
      `状态条此时应显示「执行工具(${best.name ?? '?'})  ${fmtElapsed(best.ms)}」` +
      (best.ms > stallMs ? ` + ⚠ 无进展告警` : '') +
      `）`,
  )
}
