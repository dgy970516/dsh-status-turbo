/**
 * dsh-status-turbo — 「交接文档自动导出」的纯逻辑与可注入 I/O。
 *
 * 背景：bili 的 preflight 护栏按**单次请求核心文本**判死（`payload core text alone is ~… bytes
 * vs the model window …`），会话太长时连转发机会都没有。bili 官方给的迁移路径是
 * `bili export` 出 Markdown 交接文档（`billion-context/CONFIGURATION.zh-CN.md:1791`、`:2123-2132`）。
 *
 * 纪律（与 `lib/state.js` 一致，见 docs/design.md）：
 *  - 不 import 任何外部依赖；只用 `node:path` 的纯函数。
 *  - **不碰时间**：时间戳（`stamp`）一律由调用方 `lib/index.js` 传入。
 *  - **不直接做 I/O**：`spawn` / `requireResolve` / `profileDir` / `execPath` / `exists` / `entries`
 *    全部以参数注入，因此测试可以完全替换它们 —— 不会真的起进程、不会真的写盘。
 *  - 默认值唯一来源是 `lib/state.js · DEFAULT_CONFIG`（PLAN.md §7），这里只读它，不另立默认值。
 *  - 拿不到 bili 可执行文件是**缺席**，不是故障：返回 `null`，由宿主记一条 warn。
 */

import { dirname, join, sep } from 'node:path'
import { DEFAULT_CONFIG } from './state.js'

/** 运行时表里 `handoff` 字段的状态机（wire 契约的一部分，客户端按它渲染）。 */
export const HANDOFF_STATUS = Object.freeze({
  DISABLED: 'disabled',
  IDLE: 'idle',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  UNAVAILABLE: 'unavailable',
})

/** 正整数配置；非法（非数 / 非正 / 非安全整数）一律回落 `DEFAULT_CONFIG` 同名项。 */
export function positiveInt(raw, key) {
  if (Number.isSafeInteger(raw) && raw > 0) return raw
  return DEFAULT_CONFIG[key]
}

/** 非负整数配置（**`0` 是合法值**）；非法回落 `DEFAULT_CONFIG` 同名项。 */
export function nonNegativeInt(raw, key) {
  if (Number.isSafeInteger(raw) && raw >= 0) return raw
  return DEFAULT_CONFIG[key]
}

/**
 * 实际阈值（P1-4）：模型窗口已知时取 `min(handoffExportTokens, percent% × 窗口)`。
 *
 * 为什么需要它：`handoffExportTokens` 是**绝对** token 数，换到窗口更小的模型上，模型早就到极限了、
 * 这个阈值却永远够不着。窗口来自会话日志里的 `request/context` 事件（DSH 在路由或容量变化时记一次，
 * 见 `packages/core/session/src/types.ts:219` / `agent-loop/src/agent.ts:491`），所以它是**日志派生的**、
 * 纯函数可测的，不需要去问 `ctx.llm`。
 *
 * @param {{config: object, contextWindow?: number}} input
 * @returns {number}
 */
export function effectiveThreshold({ config, contextWindow }) {
  const absolute = positiveInt(config && config.handoffExportTokens, 'handoffExportTokens')
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return absolute
  const percent = positiveInt(config && config.handoffExportWindowPercent, 'handoffExportWindowPercent')
  const scaled = Math.ceil((contextWindow * percent) / 100)
  return Math.min(absolute, scaled)
}

/**
 * bili 自己那条护栏的换算常数：`~7.5 bytes/token`（`#2122`，见
 * `billion-context/CONFIGURATION.zh-CN.md`）。字节阈值按窗口比例缩放时用它把窗口换算成字节。
 */
export const BYTES_PER_TOKEN = 7.5

/**
 * 字节口径的实际阈值（0.7.4）：`min(handoffExportBytes, percent% × 窗口 × 7.5)`。
 *
 * 与 `effectiveThreshold` 共用同一个比例旋钮（`handoffExportWindowPercent`），所以
 * 「阈值 = 窗口的百分之多少」这件事只有一个真相来源。
 *
 * @param {{config: object, contextWindow?: number}} input
 * @returns {number}
 */
export function effectiveByteThreshold({ config, contextWindow }) {
  const absolute = positiveInt(config && config.handoffExportBytes, 'handoffExportBytes')
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return absolute
  const percent = positiveInt(config && config.handoffExportWindowPercent, 'handoffExportWindowPercent')
  const scaled = Math.ceil((contextWindow * percent * BYTES_PER_TOKEN) / 100)
  return Math.min(absolute, scaled)
}

/**
 * 事件是否「新鲜」到值得触发（0.7.7）。
 *
 * 为什么需要：投影 `apply` 在**冷启动重放**里也会逐事件跑，而重放把整份历史一次性折进来 ——
 * 按"累计体量"判断的话，几秒内就能把进程上限用光，并替**早已不动的旧会话**生成一堆文档。
 * 只认新鲜事件 ⇒ 只有**正在跑**的会话会触发；历史的体量照样进账（判断"这个会话很重"仍然准），
 * 只是不会因为历史而动手。
 *
 * @param {object} input
 * @param {unknown} input.at 事件的 `time`（epoch 毫秒）。
 * @param {number} input.now 当前时间（由调用方传入 —— 本模块不碰时间）。
 * @param {unknown} input.freshMs 允许的最大滞后（非法值回落 `DEFAULT_CONFIG.handoffExportFreshMs`）。
 * @returns {boolean} 新鲜 ⇒ `true`；时间戳缺失 / 未来时间 / 超窗 ⇒ `false`。
 */
export function isFreshEvent({ at, now, freshMs }) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return false
  const window = positiveInt(freshMs, 'handoffExportFreshMs')
  const age = now - at
  if (age < 0) return false // 时钟回拨或未来时间戳：宁可不动
  return age <= window
}

/**
 * 阈值判据（纯函数）：**两个口径取或**。
 *
 *  - **token 口径**（用户原本选定的）：`usage.inputTokens ≥ effectiveThreshold`。
 *    它的已知代价（docs/review-0.7.0-handoff.md · P0-3）是它量的是 bili **压缩之后**的上行计费输入，
 *    而 bili 那次 fail-fast 的请求没有上游响应、也就没有 usage 事件 ⇒ 最坏那条路径上它不触发。
 *  - **字节口径**（0.7.4 加上，用户授权按建议改）：`payloadBytes ≥ effectiveByteThreshold`。
 *    它直接量**日志本身的体量**，与 bili 那条护栏（`~7.5 bytes/token`）同族，所以能在
 *    "还没炸但快了"的时候先响 —— 正是 token 口径漏掉的那一格。
 *
 * 两个口径各用**各自的** delta 节流（单位不同，不能互相顶替）；任一满足即触发。
 *
 * ⚠️ **P1-10 · 共用阈值（有意为之）**：这里读的 `handoffExportTokens` / `handoffExportBytes` /
 * `handoffExportWindowPercent` 同时是 `./rotation.js · shouldRotate` 的判据 —— 同一个「上下文快满了」
 * 信号，两条响应（写一份交接文档 / 开一个新会话）。改名会破坏用户既有配置，所以保留原名，
 * 只在这里与 `DEFAULT_CONFIG` 的键注释里写明这层耦合。
 *
 * @param {object} input
 * @param {object} input.config 宿主合并后的配置。
 * @param {number} [input.inputTokens] 本步的 `usage.inputTokens`。
 * @param {number|undefined} [input.lastInputTokens] 该车道上次导出时的输入 token。
 * @param {number} [input.payloadBytes] 该会话当前「模型可见体量」的估计字节数。
 * @param {number|undefined} [input.lastPayloadBytes] 该车道上次导出时的字节数。
 * @param {number|undefined} [input.contextWindow] 会话当前路由的上下文窗口（日志派生，可缺）。
 * @returns {boolean}
 */
export function shouldExport({ config, inputTokens, lastInputTokens, payloadBytes, lastPayloadBytes, contextWindow }) {
  if (!config || config.handoffExport !== true) return false

  const threshold = effectiveThreshold({ config, contextWindow })
  if (Number.isFinite(inputTokens) && inputTokens >= threshold) {
    const delta = positiveInt(config.handoffExportMinDeltaTokens, 'handoffExportMinDeltaTokens')
    if (!Number.isFinite(lastInputTokens) || inputTokens - lastInputTokens >= delta) return true
  }

  const byteThreshold = effectiveByteThreshold({ config, contextWindow })
  if (Number.isFinite(payloadBytes) && payloadBytes >= byteThreshold) {
    const delta = positiveInt(config.handoffExportMinDeltaBytes, 'handoffExportMinDeltaBytes')
    if (!Number.isFinite(lastPayloadBytes) || payloadBytes - lastPayloadBytes >= delta) return true
  }

  return false
}

/** 进文件名前的净化：只留 `[A-Za-z0-9._-]`，其余（含路径分隔符与 `|sub:` 里那些）换成 `_`。 */
export function safeSegment(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * 水位分桶（P1-2 / P1-3 / P1-6 的落点）：**token 桶与字节桶取大者** ——
 * 两个口径的节流宽度不同（`handoffExportMinDeltaTokens` / `handoffExportMinDeltaBytes`），
 * 所以桶号必须同时覆盖两者，否则字节驱动的那次增长会落回旧桶、被幂等判据吃掉。
 *
 * 文件名里带上桶号 ⇒ 同一车道同一水位只可能有一份文档：重启丢了节流记忆不会重复导、
 * 冷启动重放撞同一桶会跳过、同一秒连导两次也不会互相覆盖；水位继续增长进新桶，该刷新照常刷新。
 *
 * @param {object} config 宿主配置。
 * @param {{inputTokens?: number, payloadBytes?: number}} [watermark] 当前水位（两个口径）。
 * @returns {number|null} 桶号；两个口径都不是有限数 ⇒ `null`。
 */
export function watermarkBucket(config, { inputTokens, payloadBytes } = {}) {
  const tokenWidth = positiveInt(config && config.handoffExportMinDeltaTokens, 'handoffExportMinDeltaTokens')
  const byteWidth = positiveInt(config && config.handoffExportMinDeltaBytes, 'handoffExportMinDeltaBytes')
  const tokenBucket = Number.isFinite(inputTokens) ? Math.floor(Math.max(0, inputTokens) / tokenWidth) : null
  const byteBucket = Number.isFinite(payloadBytes) ? Math.floor(Math.max(0, payloadBytes) / byteWidth) : null
  if (tokenBucket === null) return byteBucket
  if (byteBucket === null) return tokenBucket
  return Math.max(tokenBucket, byteBucket)
}

/** 同一车道 + 同一水位桶的文档名前缀。 */
export function handoffPrefix(laneKey, bucket) {
  return `handoff-${safeSegment(laneKey)}-${String(bucket)}-`
}

/** 导出目录的绝对路径。 */
export function handoffDir({ cwd, dir }) {
  const sub = typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : DEFAULT_CONFIG.handoffExportDir
  return join(cwd, sub)
}

/** 导出目标的绝对路径（纯字符串拼接，**不建目录** —— 建目录是调用方的事）。 */
export function handoffTarget({ cwd, dir, sessionId, bucket, stamp }) {
  return join(handoffDir({ cwd, dir }), `${handoffPrefix(sessionId, bucket)}${safeSegment(stamp)}.md`)
}

/**
 * 在目录条目里找**同一车道 + 同一水位桶**的既有文档（幂等判据）。
 *
 * @param {readonly string[]} entries `readdirSync` 的结果（可注入，测试不碰盘）。
 * @returns {string|null}
 */
export function findExistingHandoff(entries, laneKey, bucket) {
  if (!Array.isArray(entries)) return null
  const prefix = handoffPrefix(laneKey, bucket)
  for (const name of entries) {
    if (typeof name === 'string' && name.startsWith(prefix) && name.endsWith('.md')) return name
  }
  return null
}

/**
 * 在目录条目里找**该车道的任何一份**既有文档（不看水位桶）—— 0.7.8「每车道只导一份」的判据。
 *
 * @param {readonly string[]} entries `readdirSync` 的结果（可注入，测试不碰盘）。
 * @param {string} laneKey 车道键。
 * @returns {string|null}
 */
export function findAnyHandoff(entries, laneKey) {
  if (!Array.isArray(entries)) return null
  const prefix = `handoff-${safeSegment(laneKey)}-`
  for (const name of entries) {
    if (typeof name === 'string' && name.startsWith(prefix) && name.endsWith('.md')) return name
  }
  return null
}

/**
 * 进请求体的会话事件类型 —— 0.7.5 起「模型可见体量」只对这些计价。
 *
 * 为什么白名单：`compaction/start` 与 `compaction/end` 是**成对**事件（那份失败的日志里各 4027 条），
 * 两者都带块内容就会把同一段文本算两遍；`subagent/*` 的目录快照、审批、重试也不进请求体。
 * 多算的后果是**触发比设计更早**（并更快耗尽进程上限），少算只是晚一点 —— 所以宁可只算确定的。
 */
export const MODEL_VISIBLE_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

const MODEL_VISIBLE_SET = new Set(MODEL_VISIBLE_EVENT_TYPES)

/**
 * 该事件类型是否计入「模型可见体量」。
 *
 * @param {unknown} type 会话事件的 `type`。
 * @returns {boolean}
 */
export function isModelVisibleEvent(type) {
  return typeof type === 'string' && MODEL_VISIBLE_SET.has(type)
}

/** 导出目录里放的 `.gitignore` 内容：别让 `git add .` 把交接文档收进版本库（P1-7）。 */
export const HANDOFF_GITIGNORE = '*\n'

/**
 * `handoff.message` 用的**稳定 code**（0.7.6）：面板按 locale 渲染（`lib/client.js · handoffSection`），
 * 所以这里不能塞英文句子 —— 原来 `'mkdir failed'` / `'per-process limit reached'` 直接漏进了中文面板。
 *
 * 客户端对**未知** code 一律原样显示 ⇒ 宿主与客户端可以各自演进，也不会把原因吞掉。
 */
export const HANDOFF_MESSAGE = Object.freeze({
  LIMIT_REACHED: 'limit-reached',
  NO_CWD: 'no-cwd',
  MKDIR_FAILED: 'mkdir-failed',
  TIMEOUT: 'timeout',
})

/**
 * 导出失败的 code：超时，或 `exit:<n|unknown>`（退出码当参数，客户端只做一次 `{code}` 替换）。
 *
 * @param {{timedOut?: boolean, code?: unknown}} result `runExport` 结算出的结果。
 * @returns {string}
 */
export function failureMessage(result) {
  const source = result !== null && typeof result === 'object' ? result : {}
  if (source.timedOut === true) return HANDOFF_MESSAGE.TIMEOUT
  const value = Number.isSafeInteger(source.code) ? String(source.code) : 'unknown'
  return `exit:${value}`
}

/**
 * 一次触发的**完整决策**（P1-5：把判据抽成可注入的纯函数，宿主只剩 I/O）。
 *
 * 返回 `action`：
 *  - `'none'`  —— 不动作（未开 / 未达阈值 / 水位桶算不出来）；
 *  - `'skip'`  —— 该桶已有文档，直接把 `existing` 记为 `done`（重启/重放/同秒重复都在这里被挡）；
 *  - `'export'` —— 起一次导出，目标路径是 `output`。
 *
 * @param {object} input
 * @param {object} input.config 宿主配置。
 * @param {number} input.inputTokens 本步 `usage.inputTokens`。
 * @param {number|undefined} input.lastInputTokens 上次该车道的导出水位。
 * @param {number|undefined} input.contextWindow 会话当前窗口（可缺）。
 * @param {readonly string[]} input.entries 导出目录的条目快照。
 * @param {string} input.sessionId 车道键（主车道就是会话 id）。
 * @param {string} input.cwd 会话工作目录。
 * @param {string} input.stamp 时间戳片段。
 * @returns {{action: 'none'|'skip'|'export', reason: string|null, bucket: number|null, existing: string|null, output: string|null}}
 */
export function planHandoff({ config, inputTokens, payloadBytes, lastInputTokens, lastPayloadBytes, contextWindow, entries, sessionId, cwd, stamp }) {
  const bucket = watermarkBucket(config, { inputTokens, payloadBytes })
  if (bucket === null) return { action: 'none', reason: 'no-watermark', bucket: null, existing: null, output: null }
  if (!shouldExport({ config, inputTokens, lastInputTokens, payloadBytes, lastPayloadBytes, contextWindow })) {
    return { action: 'none', reason: 'below-threshold', bucket, existing: null, output: null }
  }
  const dir = config && config.handoffExportDir
  // 0.7.8：`handoffExportRefreshBytes` 为 0（默认）⇒ 同一车道已有**任何**一份就跳过（每车道最多 1 份）；
  // 设成字节增量才恢复"按水位桶刷新"的旧行为。
  const refresh = nonNegativeInt(config && config.handoffExportRefreshBytes, 'handoffExportRefreshBytes')
  const existing = refresh <= 0 ? findAnyHandoff(entries, sessionId) : findExistingHandoff(entries, sessionId, bucket)
  if (existing !== null) {
    return { action: 'skip', reason: 'already-exported', bucket, existing, output: join(handoffDir({ cwd, dir }), existing) }
  }
  return {
    action: 'export',
    reason: null,
    bucket,
    existing: null,
    output: handoffTarget({ cwd, dir, sessionId, bucket, stamp }),
  }
}

/**
 * 求出 `billion-context` 包根目录：把解析结果在 `…<sep>billion-context<sep>` 处切开。
 *
 * 为什么切而不是直接用解析结果：`require.resolve('billion-context')` 走的是该包的 `.` export，
 * 拿到的是 **`dist/agent/dsh-native.js`**（DSH 插件入口），**不是 CLI `dist/index.js`**。
 */
export function packageRootOf(entry) {
  if (typeof entry !== 'string' || entry === '') return null
  const marker = `${sep}billion-context${sep}`
  const at = entry.indexOf(marker)
  if (at === -1) return null
  return entry.slice(0, at + marker.length - 1)
}

/**
 * 由**插件入口文件**的路径求出 profile 根目录（0.7.5 修正）。
 *
 * 装好的副本长这样：`…\profiles\desktop\node_modules\dsh-status-turbo\lib\index.js`
 * ⇒ 从它往上 **4** 层才是 `…\profiles\desktop`。
 *
 * 为什么要有这个纯函数：0.7.0–0.7.4 里这段是**内联的三层 dirname**，落在
 * `…\desktop\node_modules`，于是三级探测拼出 `…\node_modules\node_modules\billion-context\…`，
 * **永远命不中**（被二级遮住，223 条测试也没抓到 —— 因为它们喂的是假的 `profileDir`）。
 * 抽成纯函数之后，测试可以直接对着**真实布局**断言。
 *
 * @param {string} entryPath 插件入口的绝对路径（通常是 `fileURLToPath(import.meta.url)`）。
 * @returns {string|null} profile 根目录；入参不是非空字符串 ⇒ `null`。
 */
export function profileRootOf(entryPath) {
  if (typeof entryPath !== 'string' || entryPath === '') return null
  let current = entryPath
  for (let level = 0; level < 4; level += 1) current = dirname(current)
  return current
}

/**
 * 探测 `bili` 可执行文件；全部失败返回 `null`（缺席，不是故障）。
 *
 * 两级（外加显式配置一级）——**都是 0.7.0 的教训换来的**（docs/review-0.7.0-handoff.md P0-1/P0-2）：
 * `require.resolve('billion-context/dist/index.js')` 实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
 * profile 的 `.bin/bili.CMD` 实测 `spawn` 抛 `EINVAL`（CVE-2024-27980 之后 Node 拒绝无 shell 启 `.cmd`）。
 * 所以两条路都指向同一件事：**用 `node` 跑包内的 `dist/index.js`**。
 *
 * @returns {{ command: string, prefix: string[], source: 'config'|'package' }|null}
 */
export function resolveBili({ config, execPath, requireResolve, profileDir, exists }) {
  const explicit = config && typeof config.handoffExportBiliBin === 'string' ? config.handoffExportBiliBin.trim() : ''
  if (explicit !== '') return { command: explicit, prefix: [], source: 'config' }

  const node = typeof execPath === 'string' && execPath !== '' ? execPath : null
  if (node === null) return null

  /** @type {string[]} */
  const candidates = []
  if (typeof requireResolve === 'function') {
    try {
      const root = packageRootOf(requireResolve('billion-context'))
      if (root !== null) candidates.push(join(root, 'dist', 'index.js'))
    } catch {
      /* 包不在场：试兜底拼法，不记 fault（缺席不是故障） */
    }
  }
  if (typeof profileDir === 'string' && profileDir !== '') {
    candidates.push(join(profileDir, 'node_modules', 'billion-context', 'dist', 'index.js'))
  }

  for (const cli of candidates) {
    if (typeof exists === 'function' && exists(cli) === false) continue
    return { command: node, prefix: [cli], source: 'package' }
  }
  return null
}

/** 拼「列出持久化车道」的 argv。 */
export function listArgs(bili) {
  return [...(bili && Array.isArray(bili.prefix) ? bili.prefix : []), 'export']
}

/** 拼「导出一个车道」的 argv。 */
export function exportArgs(bili, { sessionId, full, output }) {
  const args = [...(bili && Array.isArray(bili.prefix) ? bili.prefix : []), 'export', String(sessionId)]
  if (full === true) args.push('--full')
  args.push('--output', String(output))
  return args
}

/**
 * 解析 `bili export`（无参数）那份人类可读的车道列表（P2-1）。
 *
 * 样本（实读 `node_modules\.bin\bili.CMD export`）：
 * `  session-9e44e9a9-…|sub:f0550134c86a9494  label=session-9e44e9a9-…  [anthropic]  blocks=32  ctx~15034253  标题…`
 *
 * **为什么靠解析而不是靠 API**：CLI 没有机器可读模式（`--help` 被忽略、也没有 `--json`）。
 * 解析失败一律返回 `[]`（**绝不抛**）—— 宁可退化成"只导主车道"，也不能打断回合。
 *
 * @param {string} text CLI 的 stdout。
 * @returns {{key: string, label: string, protocol: string, blocks: number, ctx: number}[]}
 */
export function parseExportLanes(text) {
  if (typeof text !== 'string' || text === '') return []
  const lanes = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2}(\S+)\s+label=(\S+)\s+\[([^\]]+)\]\s+blocks=(\d+)\s+ctx~([\d.]+)/.exec(line)
    if (m === null) continue
    lanes.push({ key: m[1], label: m[2], protocol: m[3], blocks: Number(m[4]), ctx: Number(m[5]) })
  }
  return lanes
}

/**
 * 取某会话的**全部车道键**（P2-1）：主车道 + 它的每个 `|sub:` 子车道。
 *
 * 判据是 `label`：实读发现子车道的 `label` 与主车道**同为会话 id**（例如
 * `session-9e44e9a9-…|sub:f0550134c86a9494  label=session-9e44e9a9-…`），
 * 所以按 `label === sessionId` 过滤即可拿到整族，不需要去猜 bili 的命名空间哈希。
 * 主车道若在列表里，永远排第一位。
 *
 * @param {{key: string, label: string}[]} lanes `parseExportLanes` 的结果。
 * @param {string} sessionId 会话 id。
 * @returns {string[]} 车道键；一个都没有 ⇒ `[sessionId]`（退化成只导主车道）。
 */
export function lanesFor(lanes, sessionId) {
  if (!Array.isArray(lanes) || typeof sessionId !== 'string' || sessionId === '') return [sessionId]
  const keys = lanes.filter((lane) => lane && lane.label === sessionId).map((lane) => lane.key)
  const unique = [...new Set(keys)]
  if (unique.length === 0) return [sessionId]
  return unique.sort((a, b) => (a === sessionId ? -1 : b === sessionId ? 1 : 0))
}

/**
 * 导出子进程的默认超时（毫秒）：`--full` 在大会话上可能跑几十秒。
 *
 * P1-4：单一来源是 `DEFAULT_CONFIG.handoffExportTimeoutMs`（这里不再自带一份字面量）。
 * 真正可配的是配置键本身 —— 宿主侧接线把它算进 `runExport` / `listLanes` 的 `timeoutMs`；
 * 本常量只剩两个用途：调用方没给超时值时 `runBili` 的兜底、以及 `__test` 与既有测试的对照值。
 */
export const DEFAULT_EXPORT_TIMEOUT_MS = DEFAULT_CONFIG.handoffExportTimeoutMs

/**
 * 超时后从 SIGTERM 升级到 SIGKILL 的宽限期（毫秒）。SIGTERM 会被忽略（子进程卡在管道读写上时
 * 尤其如此），到期就用 SIGKILL 强杀。宽限定时器 `unref()`：导出早已结算，不该为了「等着强杀」
 * 而拖住进程退出。
 */
export const KILL_GRACE_MS = 3000

/** 捕获的 stdout / stderr 各自的上限（字节折算成字符），防止被上游灌爆（P2-3）。 */
export const MAX_CAPTURED_OUTPUT = 64 * 1024
const MAX_STDERR_TAIL = 2048

/** Windows 上 `.cmd` / `.bat` 不能直接 spawn（CVE-2024-27980 之后 Node 抛 `EINVAL`），必须经 shell。 */
export function needsShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command))
}

/**
 * `shell: true` 时 Node 只是把 argv 用空格拼起来 ⇒ 带空格或引号的参数必须自己加引号。
 *
 * S7：转义按 **cmd.exe** 的口径 —— 双引号内的 `"` 写成两个双引号（`""`）。此前的 `\"`
 * 是 C 运行时的口径，cmd 不认：`cmd /c "bili"" export` 里的 `\"` 会让 cmd 提前收尾，
 * 参数被截断成两段（导出路径含引号时尤其致命）。
 *
 * 未转义的残留风险（记录在案，不在本函数职责内）：cmd 仍会对值里的 `%VAR%` / `!VAR!`
 * 做展开。本插件的值都是自己拼出来的路径与会话 id，不含 `%` / `!`；外部传入的 `handoffExportBiliBin`
 * 由用户自己保证。
 */
export function quoteForShell(value) {
  const text = String(value)
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 采集子进程输出（可选）。两个开关分别对应两处需求：`captureStdout` 给车道列表（P2-1），
 * `captureStderr` 给失败诊断（P2-3）。`child` 上没有对应流时静默跳过（测试替身常是极简对象）。
 *
 * `isDone` 是结算闸：超时结算之后到达的 `data` 不再写进结果（S7），否则「结算后仍在长」的
 * 缓冲区既没意义、又让结果看起来像子进程还活着。
 */
function attachCapture(child, { captureStdout, captureStderr, state, isDone }) {
  const done = () => typeof isDone === 'function' && isDone() === true
  try {
    if (captureStdout === true && child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        if (done()) return
        if (state.stdout.length < MAX_CAPTURED_OUTPUT) state.stdout += String(chunk)
      })
    }
    if (captureStderr === true && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        if (done()) return
        const text = String(chunk)
        state.stderr = (state.stderr + text).slice(-MAX_STDERR_TAIL)
      })
    }
  } catch {
    /* 采集失败不影响导出本身 */
  }
}

/** 给子进程发终止信号；失败只说明它已经退出或平台不认这个信号，调用方无可补救。 */
function killChild(child, signal) {
  try {
    if (child && typeof child.kill === 'function') child.kill(signal)
  } catch {
    /* 已退出或平台不支持该信号：超时本身已经记进结果 */
  }
}

/**
 * 显式销毁三个管道（S7）。子进程卡在管道写入上时 `close` 可能永远不来，光发信号不足以收回
 * 句柄；替身上没有真流时逐个跳过。
 */
function destroyPipes(child) {
  if (child === null || typeof child !== 'object') return
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    try {
      if (stream && typeof stream.destroy === 'function') stream.destroy()
    } catch {
      /* 管道已经关掉：销毁的意义只是回收句柄，失败无需上报 */
    }
  }
}

/**
 * 跑一次 bili 命令。`spawn` 注入 ⇒ 测试里传一个假实现即可，不会真的起进程。
 *
 * 任何异常都只经 `onSettle` 上报，**绝不抛出**（插件纪律：钩子里的异常不许打断回合）。
 *
 * @param {object} input
 * @param {Function} input.spawn 形如 `node:child_process`.spawn 的函数。
 * @param {{command: string, prefix: string[]}} input.bili `resolveBili` 的结果。
 * @param {string[]} input.args 完整 argv（`runExport` / `listLanes` 各自拼）。
 * @param {string} [input.cwd]
 * @param {number} [input.timeoutMs]
 * @param {number} [input.killGraceMs] 超时后 SIGTERM → SIGKILL 的宽限期；缺省 `KILL_GRACE_MS`。
 * @param {boolean} [input.captureStdout] 采集 stdout（车道列表用）。
 * @param {boolean} [input.captureStderr] 采集 stderr 尾部（失败诊断用）。
 * @param {(result: {ok: boolean, code?: number|null, error?: unknown, timedOut?: boolean, stdout?: string, stderr?: string}) => void} [input.onSettle]
 * @returns {object|null} 子进程句柄；未起进程时返回 `null`。
 */
export function runBili({ spawn, bili, args, cwd, timeoutMs, killGraceMs, captureStdout, captureStderr, onSettle }) {
  if (bili === null || bili === undefined || typeof spawn !== 'function') return null
  const shell = needsShell(bili.command)
  const argv = shell ? args.map(quoteForShell) : args
  const state = { stdout: '', stderr: '' }
  let child
  try {
    child = spawn(bili.command, argv, {
      cwd: cwd ?? undefined,
      windowsHide: true,
      stdio: [captureStdout === true ? 'pipe' : 'ignore', captureStdout === true ? 'pipe' : 'ignore', captureStderr === true ? 'pipe' : 'ignore'],
      shell,
    })
  } catch (error) {
    if (typeof onSettle === 'function') onSettle({ ok: false, error, stdout: '', stderr: '' })
    return null
  }
  attachCapture(child, { captureStdout, captureStderr, state, isDone: () => settled })

  let settled = false
  let timer = null
  let graceTimer = null
  const settle = (result) => {
    if (settled) return
    settled = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (typeof onSettle === 'function') onSettle({ ...result, stdout: state.stdout, stderr: state.stderr })
  }
  const limit = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_EXPORT_TIMEOUT_MS
  const grace = Number.isSafeInteger(killGraceMs) && killGraceMs > 0 ? killGraceMs : KILL_GRACE_MS
  if (typeof setTimeout === 'function') {
    timer = setTimeout(() => {
      timer = null
      // 先 SIGTERM，再显式销毁管道：子进程卡在管道读写上时，光发信号可能永远等不到 close。
      killChild(child)
      destroyPipes(child)
      settle({ ok: false, timedOut: true })
      // 宽限期（S7）：SIGTERM 被忽略就在宽限期满后 SIGKILL。它在结算之后才可能触发，所以
      // 不受 settle 的 clearTimeout 约束，靠 unref 不拖住进程退出。
      graceTimer = setTimeout(() => {
        graceTimer = null
        killChild(child, 'SIGKILL')
        destroyPipes(child)
      }, grace)
      if (typeof graceTimer.unref === 'function') graceTimer.unref()
    }, limit)
  }

  try {
    if (child && typeof child.on === 'function') {
      child.on('error', (error) => settle({ ok: false, error }))
      child.on('close', (code) => settle({ ok: code === 0, code: code ?? null }))
    }
  } catch (error) {
    settle({ ok: false, error })
  }
  // 两个流都不采集时没人读子进程的输出；unref 让它不把一次导出变成"必须等它退出"。
  if (captureStdout !== true && captureStderr !== true && child && typeof child.unref === 'function') {
    try {
      child.unref()
    } catch {
      /* unref 只影响进程存活策略，失败不影响导出结果 */
    }
  }
  return child
}

/** 导出一个车道（`runBili` 的薄包装，保留旧签名）。 */
export function runExport({ spawn, bili, sessionId, full, output, cwd, timeoutMs, onSettle }) {
  return runBili({
    spawn,
    bili,
    args: exportArgs(bili, { sessionId, full, output }),
    cwd,
    timeoutMs,
    captureStderr: true,
    onSettle,
  })
}

/** 列出持久化车道（`runBili` 的薄包装）。 */
export function listLanes({ spawn, bili, cwd, timeoutMs, onSettle }) {
  return runBili({
    spawn,
    bili,
    args: listArgs(bili),
    cwd,
    timeoutMs,
    captureStdout: true,
    captureStderr: true,
    onSettle,
  })
}
