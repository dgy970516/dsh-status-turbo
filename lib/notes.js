// dsh-status-turbo · 文案层（C2 截断风险 / C3 乱码与噪声 / C1 证据校正）+ A2 参数指纹
//
// 设计原则（PLAN.md §3.4 判定表、§3.6 A2）：
//   1. **纯函数、零 import、零第三方依赖** —— 与 ./gears.js 同风格，可直接单测；
//      宿主能力（阈值 / 白名单 / 文件总行数）一律**当参数注入**，本层不碰任何服务。
//   2. 本层只**产出"要追加的文本"**（一个 `{type:'text', text}` 块），
//      由调用方放回**同一次**工具返回里 —— 结构上不可能新增往返（O4）。
//   3. 触发条件逐字对齐 PLAN.md §3.4 的判定表，**不新增分支**；
//      不触发就是 `null`（而不是空串），调用方据此原样放过（O8 逐字相等）。
//   4. 任何不确定一律"不追加"：宁可少报，**不可编造数字**（§3.4 的 M 取值纪律）。
//   5. 核心判据（noteTexts）**不吞异常**：它抛出的异常由 collectNotes 转成可上报的
//      `{at, hook, message}`，既不静默也不 throw（G3）。

/** C2 / C3-a / C3-b / C1 四条追加文案（PLAN.md §3.4 @ 341-346，逐字）。 */
const NOTE_C2 = (n, m, absolutePath) => `你只看了 ${n} / ${m} 行（${absolutePath}）；后面还有内容没读，别基于这个片段下结论。`
const NOTE_C3A = (runs) => `这段输出里的中文已经损坏（出现 ${runs} 处替换字符 \uFFFD），路径很可能不可用，别按它继续。`
const NOTE_C3B = (noisyLines, totalLines) => `这次输出被噪声淹没（${noisyLines} / ${totalLines} 行不是目标输出），换更精确的过滤再跑。`
const NOTE_C1 = () => `上一条没有可核对的证据（输出里既没有 exit code: 0，也没有测试/类型检查的成功行），别据此下结论。`

/**
 * 要求"拿得出证据"的命令判据（PLAN.md §3.4 @ 332，逐字）。
 * 只匹配**命令文本**：`pwsh` / `bash` / `sql_exec` 之类的命令参数里出现 test / build / tsc…
 * 才值得校正；一次纯 `read` 没有"通过/成功"的说法，不该被纠正。
 */
export const EVIDENCE_REQUIRING_RE = /\b(test|vitest|pytest|tsc|build|typecheck|--test)\b/i

/**
 * C3-b 的"噪声行"判据（PLAN.md §3.4 @ 333）。
 *
 * 前三条是 PLAN.md 冻结的三条（逐字保留）：
 *   1. 只剩空白 / 括号 / 引号 / 逗号 / 冒号的行（空行、`{`、`}`,、`",`…）；
 *   2. `npm WARN ` / `npm notice ` 前缀行；
 *   3. pnpm 的 `+ 12 packages` / `+ 3 dependencies` 行。
 *
 * 后三条是 §3.4 明确允许的**细化**，为的是让真实样本能被判成噪声：
 *   4. npm 的进度噪音（`npm http ` / `npm timing ` / `npm sill ` / `npm verb `）；
 *   5. `1234 http fetch GET …` 这类带序号的进度行；
 *   6. JSON 键值行（`  "resolved": "https://…"`）—— 真实事故就是一次 `pwsh` 输出被
 *      npm 缓存/registry 的 JSON 倒了 14 KB 进来（O6）。
 * 导出它，是为了让测例能直接断言这一条判据本身（AUTHORITY.md · NOISE_LINE_RE）。
 */
export const NOISE_LINE_RE =
  /^[\s{}[\]",:]*$|^npm (WARN|notice) |^\+ \d+ (packages?|dependencies)|^npm (http|timing|sill|verb) |^[\d:]+ (http|timing) |^\s*"[^"\\]*"\s*:\s*(".*"|\S*)\s*,?$/

/**
 * `evidenceWhitelist` 的默认 3 条正则源（PLAN.md §3.4 @ 326-328，D9，逐字）。
 *
 * ① 退出码成功 ② 测试框架成功行 ③ 类型检查 / 构建成功行。
 *
 * 为什么要在这里放一份：T04 的验收命令要求 `hasEvidence(text)` **单参数**可用
 * （见 TASKS.json · T04 的 verify 第 2 条）。运行期仍然以调用方传入的
 * `config.evidenceWhitelist` 为准 —— `DEFAULT_CONFIG`（lib/state.js）才是默认值的唯一来源
 * （PLAN.md §1.2），这一份只是"没传白名单"时的兜底，与 PLAN.md 逐字相等。
 */
export const EVIDENCE_DEFAULT_PATTERNS = Object.freeze([
  /exit code:?\s*0\b/mi,
  /(^|\n)\s*(#\s*(pass|tests|suites)\s+\d+|\d+\s+passing|Tests:\s+\d+\s+passed|Test Suites:\s+\d+\s+passed|ok\s+\d+\s+-)/m,
  /(^|\n)\s*(Successfully compiled|Compiled successfully|Found 0 errors|\d+\s+files?\s+checked,?\s*0\s+errors|Build succeeded|Done in \d)/mi,
])

/** C3-a 的默认阈值（PLAN.md §7 注册表：`mojibakeMinRuns` 默认 2）。非法值按 R12 回落它。 */
export const DEFAULT_MOJIBAKE_MIN_RUNS = 2
/** C3-b 的默认字节阈值（PLAN.md §3.4 @ 316 逐字 8192）。 */
export const DEFAULT_NOISE_MIN_BYTES = 8192
/** C3-b 的默认噪声占比（PLAN.md §3.4 @ 316 逐字 0.5）。 */
export const DEFAULT_NOISE_RATIO = 0.5
/** 参数缺失 / 无法序列化时的指纹（PLAN.md §3.6 @ 393）。 */
export const UNKNOWN_FINGERPRINT = 'unknown'

// ---------------------------------------------------------------------------
// 一、工具返回值 → 纯文本
// ---------------------------------------------------------------------------

/**
 * 把 `result.content` 摊平成纯文本。
 *
 * 形状：`[{type:'text', text:'…'}]`（PLAN.md §3.4 @ 291 的 `content ?? result.content`）。
 * 防御式：任何奇怪的节点都只是"贡献空串"，绝不抛。
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((node) => textOf(node)).join('\n')
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (content.content !== undefined) return textOf(content.content)
  }
  return ''
}

/** UTF-8 字节数。优先用 Buffer，其次 TextEncoder，最后手算 —— 都不 import。 */
export function utf8Bytes(text) {
  const s = typeof text === 'string' ? text : ''
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(s, 'utf8')
  }
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length
  let bytes = 0
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

// ---------------------------------------------------------------------------
// 二、C2：截断风险（SPEC O3）
// ---------------------------------------------------------------------------

/**
 * C2 的追加文案（PLAN.md §3.4 @ 342，逐字）。
 * `n` = 本次 `limit`，`m` = 文件真实总行数，`absolutePath` = 绝对路径。
 */
export function C2_NOTE(n, m, absolutePath) {
  return NOTE_C2(n, m, absolutePath)
}

/**
 * C3-a 的追加文案（PLAN.md §3.4 @ 343，逐字）。
 * `runs` = 这次输出里损坏字符的**处数**（即 `\uFFFD` 的个数，见 analyzeMojibake().total）。
 */
export function C3_MOJIBAKE_NOTE(runs) {
  return NOTE_C3A(runs)
}

/** C3-b 的追加文案（PLAN.md §3.4 @ 344，逐字）。 */
export function C3_NOISE_NOTE(noisyLines, totalLines) {
  return NOTE_C3B(noisyLines, totalLines)
}

/** C1 的追加文案（PLAN.md §3.4 @ 345，逐字）。只陈述"这次没有可核对的证据"，不催任何动作。 */
export function C1_NOTE() {
  return NOTE_C1()
}

// ---------------------------------------------------------------------------
// 三、C3-a：编码损坏（SPEC O5）
// ---------------------------------------------------------------------------

/**
 * 统计 `\uFFFD`（U+FFFD REPLACEMENT CHARACTER）的分布。
 *
 * 真实样本（SPEC O5，GBK/CP936 里中文被当成别的编码读出来的典型长相）：
 *   `D:\project\huihuoke\team\team-鎶�鑳藉疄璺�-鍦ㄦ暟鏅�-102526\`
 * 它里面是**三个孤立的** `\uFFFD`（`longest === 1`、`runs === 3`）——
 * 高位字节被截断后，每个坏字节各留一个替换字符，**并不连成一段**。
 *
 * ⇒ 这就是 `mojibakeMinRuns` 这个名字的来由：阈值卡的是**坏点段数**。
 *   判定按 PLAN.md §3.4 @ 315 的"最长连段长度 >= 阈值"**或**"坏点段数 >= 阈值"
 *   两者取或：连成一片的 `\uFFFD\uFFFD` 与散落的 `\uFFFD`…`\uFFFD` 都是损坏，
 *   而 PLAN.md 自己的 O5 真实样本只有后者。两条都保留，不新增第三种判据。
 */
export function analyzeMojibake(text) {
  const s = typeof text === 'string' ? text : ''
  let total = 0
  let runs = 0
  let longest = 0
  let current = 0
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 0xfffd) {
      total += 1
      current += 1
      if (current === 1) runs += 1
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return { total, runs, longest }
}

// ---------------------------------------------------------------------------
// 四、C3-b：噪声淹没（SPEC O6）
// ---------------------------------------------------------------------------

/** 单独一行是不是"噪声行"（判据就是导出的 NOISE_LINE_RE，无状态）。 */
export function isNoiseLine(line) {
  const s = typeof line === 'string' ? line : ''
  NOISE_LINE_RE.lastIndex = 0
  return NOISE_LINE_RE.test(s)
}

/**
 * 逐行统计噪声占比。
 * 总行数按 `\n` 切；CRLF 视作一个换行；结尾那个换行不算成"多出来的一行"
 * （否则 `A / B` 里的 B 会比实际行数大 1，把比例算低，漏报）。
 */
export function noiseStats(text) {
  const s = typeof text === 'string' ? text : ''
  const lines = s.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  let noisyLines = 0
  for (const line of lines) if (isNoiseLine(line)) noisyLines += 1
  return { noisyLines, totalLines: lines.length }
}

// ---------------------------------------------------------------------------
// 五、C1：证据台账（SPEC O7 / O8）
// ---------------------------------------------------------------------------

/**
 * 把一条"正则源"变成 RegExp。
 *  - 已是 RegExp → 原样用（标志位被尊重）；
 *  - 字符串写成字面量 `/…/mi` → 逐字解析出源与标志；
 *  - 只给裸源 → 按 `/m` 编译（PLAN.md §3.4 @ 327 第 2 条就是这个形态；
 *    刻意不擅自补 `i`，避免比契约更宽松）。
 * 解析不了的条目返回 null（被过滤掉），绝不抛。
 */
export function toPattern(pattern) {
  if (pattern instanceof RegExp) return pattern
  if (typeof pattern !== 'string' || pattern === '') return null
  const literal = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(pattern)
  if (literal) {
    try {
      return new RegExp(literal[1], literal[2])
    } catch {
      return null
    }
  }
  try {
    return new RegExp(pattern, 'm')
  } catch {
    return null
  }
}

/** 白名单归一化：非数组 / 全非法 → null（调用方据此回落默认三条）。 */
export function toPatternList(patterns) {
  if (!Array.isArray(patterns)) return null
  const list = []
  for (const p of patterns) {
    const re = toPattern(p)
    if (re !== null) list.push(re)
  }
  return list.length > 0 ? list : null
}

/** 无状态判定（g/y 标志会带 lastIndex，先归零，绝不因调用次序改变结果）。 */
function matches(re, text) {
  if (!(re instanceof RegExp)) return false
  if (re.global || re.sticky) re.lastIndex = 0
  return re.test(text)
}

/**
 * 输出里能不能找到**可核对**的成功证据（SPEC O7 / O8）。
 *
 * `patterns` 省略时回落 `EVIDENCE_DEFAULT_PATTERNS`（T04 verify 命令要求单参数可用）；
 * 运行期请传 `config.evidenceWhitelist`（默认值唯一来源是 lib/state.js 的 DEFAULT_CONFIG）。
 */
export function hasEvidence(text, patterns) {
  const list = toPatternList(patterns)
  const t = typeof text === 'string' ? text : ''
  for (const re of list !== null ? list : EVIDENCE_DEFAULT_PATTERNS) {
    if (matches(re, t)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 六、工具调用参数（exec.arguments）
// ---------------------------------------------------------------------------

/**
 * 取 `exec.arguments` 并归一化成对象。
 *
 * 取证（lead 已确认）：`tool/call.data = {turn, step, callId, name, arguments}`，
 * 其中 `arguments` 是 **JSON 字符串** ⇒ 这里必须先解析，不能当成对象直接用。
 * 解析失败就给一个空对象（判据退化为"这条不触发"，绝不猜）。
 */
export function argumentsOf(exec) {
  const raw = exec === null || exec === undefined ? undefined : exec.arguments
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof raw === 'object' ? raw : {}
}

/**
 * "这条命令该不该拿得出证据"用的命令文本（PLAN.md §3.4 @ 317 的 `commandOf(exec)`）。
 *
 * 判据只可能来自命令类工具，所以按 `command` → `cmd` → `script` → `sql` → `query`
 * 依次取第一个非空字符串；都取不到就是空串（`EVIDENCE_REQUIRING_RE` 于是不命中 ⇒ 不校正）。
 */
export function commandOf(exec) {
  const args = argumentsOf(exec)
  for (const key of ['command', 'cmd', 'script', 'sql', 'query']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** 看起来像绝对路径吗（Windows 盘符 / UNC / POSIX）。只用来**挑选**已有取值，绝不拼造。 */
function isAbsoluteLike(value) {
  if (typeof value !== 'string' || value === '') return false
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/** 从 read 的返回文本里取真实绝对路径：优先结果自带的 `<path>…</path>`，其次调用参数里的 path。 */
function readPathOf(text, args) {
  const wrapped = typeof text === 'string' ? /<path>([^<]*)<\/path>/.exec(text) : null
  const fromResult = wrapped !== null ? wrapped[1] : null
  const fromArgs = typeof args.path === 'string' ? args.path : null
  for (const candidate of [fromResult, fromArgs]) if (isAbsoluteLike(candidate)) return candidate
  for (const candidate of [fromResult, fromArgs]) if (typeof candidate === 'string' && candidate !== '') return candidate
  return null
}

/**
 * 真实总行数 M（PLAN.md §3.4 @ 335-337 的取值纪律）。
 *
 *  - `config.totalLines` 是调用方（宿主半）取好之后**注入**的事实，优先用它；
 *  - 否则只认 `read` 工具自己返回里**已经写着**的总行数，绝不为了显示一个数字去读整个文件；
 *  - 取不到 → null ⇒ C2 不追加（宁可少报，不可编数字）。
 *
 * 真实样本（本机 read 工具实读输出，逐字）：
 *   `<path>D:\project\dsh-turbo\docs\design.md</path>` +
 *   `(Showing lines 1-5 of 556. Use offset=6 to continue.)`
 *   ⇒ offset=0、limit=5、M=556，满足 `M > offset + limit`。
 */
function totalLinesOf(text, config) {
  if (config !== null && config !== undefined && Number.isSafeInteger(config.totalLines) && config.totalLines > 0) {
    return config.totalLines
  }
  const s = typeof text === 'string' ? text : ''
  const patterns = [
    /\(Showing lines\s+\d+\s*-\s*\d+\s+of\s+(\d+)/i,
    /\(End of file\s*-\s*total\s+(\d+)\s+lines?\)/i,
    /\bof\s+(\d+)\s*(?:lines?\b|行)/i,
    /(?:total|共|总共)\s*(\d+)\s*(?:lines?\b|行)/i,
  ]
  for (const re of patterns) {
    const hit = re.exec(s)
    if (hit !== null) {
      const value = Number(hit[1])
      if (Number.isSafeInteger(value) && value > 0) return value
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 七、A2 参数指纹（SPEC O10）
// ---------------------------------------------------------------------------

/**
 * 确定性 FNV-1a 64 位（自实现，零依赖；派工指令明确"不要引入依赖"）。
 * 逐 UTF-16 码元喂入 —— 同一字符串在任何平台上得到同一个值（稳定、无副作用）。
 */
export function fnv1a64(text) {
  const s = typeof text === 'string' ? text : ''
  const OFFSET = 0xcbf29ce484222325n
  const PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  let hash = OFFSET
  for (let i = 0; i < s.length; i += 1) {
    hash ^= BigInt(s.charCodeAt(i))
    hash = (hash * PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * 稳定 JSON（对象键按码元序排序；数组保序）—— 同一份参数不同书写顺序得到同一串。
 * 序列化不了的值按 JSON 语义退化（undefined/函数/符号被略过）；抛错由调用方兜底。
 */
export function stableJson(value) {
  const kind = typeof value
  if (value === null) return 'null'
  if (kind === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'bigint') return `${value.toString()}n`
  if (kind === 'string') return JSON.stringify(value)
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (kind === 'object') {
    const parts = []
    for (const key of Object.keys(value).sort()) {
      const item = value[key]
      const itemKind = typeof item
      if (item === undefined || itemKind === 'function' || itemKind === 'symbol') continue
      parts.push(`${JSON.stringify(key)}:${stableJson(item)}`)
    }
    return `{${parts.join(',')}}`
  }
  return 'null'
}

/**
 * 参数指纹（PLAN.md §3.6 @ 393 的 `fingerprint(exec.arguments)`）。
 *
 *  - 稳定 JSON 序列化（键排序）后哈希，长度对齐契约的"前 12 位十六进制"；
 *    哈希算法按派工指令自实现 FNV-1a-64（不引依赖、不 import 加密库）。
 *  - 入参可以是**对象**，也可以是 `tool/call.data.arguments` 那样的 **JSON 字符串**。
 *  - null / undefined / 空串 / 任何序列化不了的值 → `'unknown'`（= "没有可用的指纹维度"），
 *    绝不退化成 `name` 本身。
 */
export function fingerprint(argumentValue) {
  let value = argumentValue
  if (value === null || value === undefined) return UNKNOWN_FINGERPRINT
  if (typeof value === 'string') {
    if (value === '') return UNKNOWN_FINGERPRINT
    try {
      value = JSON.parse(value)
    } catch {
      /* 不是 JSON 就按原字符串算指纹（依然是稳定的维度） */
    }
  }
  try {
    return fnv1a64(stableJson(value)).slice(0, 12)
  } catch {
    return UNKNOWN_FINGERPRINT
  }
}

/**
 * A2 的聚合键（PLAN.md §3.6 @ 393，逐字）：`name + '\u0000' + fingerprint(arguments)`。
 * 提供它是为了让"工具名 × 参数指纹"这个拼法只有一处，聚合两侧不会拼歪。
 */
export function aggregateKey(name, argumentValue) {
  const toolName = typeof name === 'string' ? name : ''
  return `${toolName}\u0000${fingerprint(argumentValue)}`
}

// ---------------------------------------------------------------------------
// 八、配置读取（R12：非法值一律回落，绝不抛）
// ---------------------------------------------------------------------------

/** 正整数才有效，否则回落。 */
function toPositiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 0~1 的有限数才有效，否则回落。 */
function toRatio(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback
}

/**
 * 读出本层的有效配置。
 * 运行期传进来的就是宿主合并过的 config；缺键 / 非法值一律回落契约冻结值（R12），绝不抛。
 */
export function readNotesConfig(config) {
  const src = config !== null && typeof config === 'object' ? config : {}
  const whitelist = toPatternList(src.evidenceWhitelist)
  return {
    mojibakeMinRuns: toPositiveInt(src.mojibakeMinRuns, DEFAULT_MOJIBAKE_MIN_RUNS),
    evidenceWhitelist: whitelist !== null ? whitelist : EVIDENCE_DEFAULT_PATTERNS,
    noiseMinBytes: toPositiveInt(src.noiseMinBytes, DEFAULT_NOISE_MIN_BYTES),
    noiseRatio: toRatio(src.noiseRatio, DEFAULT_NOISE_RATIO),
    /** 调用方（宿主半）已经取好的总行数与绝对路径；取不到就 null，本层绝不自己读文件。 */
    totalLines: toPositiveInt(src.totalLines, null),
    absolutePath: typeof src.absolutePath === 'string' && src.absolutePath !== '' ? src.absolutePath : null,
    /** B3 已经瘦身过这次返回 ⇒ 噪声统计不再有意义（PLAN.md §3.4 @ 319）。 */
    spilled: src.spilled === true,
  }
}

// ---------------------------------------------------------------------------
// 九、判据主入口
// ---------------------------------------------------------------------------

/**
 * 按 PLAN.md §3.4 判定表算出**要追加的文案**（C2 → C3-a → C3-b → C1）。
 *
 * @returns {string[]} 触发的文案，顺序即判定表顺序；一个都不触发就是空数组。
 *   本函数是核心判据：它**不吞异常**，异常由 collectNotes 转成可上报的 fault。
 */
export function noteTexts(exec, result, config) {
  const texts = []
  // 判定表的每一行都以 `result.isError === false` 开头：不是"明确成功"就不校正（含 result 缺失）。
  if (result === null || result === undefined || result.isError !== false) return texts

  const cfg = readNotesConfig(config)
  const args = argumentsOf(exec)
  const name = exec !== null && exec !== undefined && typeof exec.name === 'string' ? exec.name : ''
  const text = textOf(result.content)

  // C2：read + 正整数 limit + offset（默认 0）+ 真实总行数 M > offset + limit。
  if (name === 'read') {
    const limit = args.limit
    const offset = Number.isSafeInteger(args.offset) ? args.offset : 0
    if (Number.isSafeInteger(limit) && limit > 0 && offset >= 0) {
      const total = totalLinesOf(text, cfg)
      const path = cfg.absolutePath !== null ? cfg.absolutePath : readPathOf(text, args)
      if (total !== null && path !== null && total > offset + limit) texts.push(C2_NOTE(limit, total, path))
    }
  }

  // C3-a：坏点段数或最长连段达到阈值。
  const mojibake = analyzeMojibake(text)
  if (mojibake.runs >= cfg.mojibakeMinRuns || mojibake.longest >= cfg.mojibakeMinRuns) {
    texts.push(C3_MOJIBAKE_NOTE(mojibake.total))
  }

  // C3-b：够大 + 噪声行占比达标。B3 已瘦身过这次返回时跳过（再统计没有意义）。
  if (!cfg.spilled) {
    const stats = noiseStats(text)
    if (
      stats.totalLines > 0 &&
      utf8Bytes(text) >= cfg.noiseMinBytes &&
      stats.noisyLines / stats.totalLines >= cfg.noiseRatio
    ) {
      texts.push(C3_NOISE_NOTE(stats.noisyLines, stats.totalLines))
    }
  }

  // C1：这条命令本该拿得出证据，而输出里一条都对不上 ⇒ 校正一句。命中白名单则一个字都不加（O8）。
  if (EVIDENCE_REQUIRING_RE.test(commandOf(exec)) && !hasEvidence(text, cfg.evidenceWhitelist)) {
    texts.push(C1_NOTE())
  }

  return texts
}

/**
 * 把触发的文案并成**一个** `{type:'text', text}` 块（PLAN.md §3.4 @ 297 的调用骨架一次只追加一个块）。
 * 不触发时返回 `null` —— 调用方据此原样放过，输出与输入逐字相等（O8）。
 */
export function collectNotes(exec, result, config, faults) {
  try {
    const texts = noteTexts(exec, result, config)
    if (texts.length === 0) return null
    return { type: 'text', text: texts.join('\n') }
  } catch (error) {
    const fault = hookFault('notes', error)
    // 传了 fault 收纳数组就交给调用方上报；没传也不能静默吞掉 —— 把 fault 交回去。
    if (Array.isArray(faults)) {
      faults.push(fault)
      return null
    }
    return fault
  }
}

// ---------------------------------------------------------------------------
// 十、失败可见（G3）
// ---------------------------------------------------------------------------

/**
 * 造一条可上报的 fault，形状与 PLAN.md §4.2 的 `hookFaults` 元素逐字一致：`{at, hook, message}`。
 * 本层只负责"造出来"，上不上界面由调用方决定。
 */
export function hookFault(hook, error, at) {
  const message = error !== null && error !== undefined && typeof error.message === 'string' && error.message !== ''
    ? error.message
    : String(error)
  return {
    at: typeof at === 'number' ? at : Date.now(),
    hook: typeof hook === 'string' && hook !== '' ? hook : 'notes',
    message: `dsh-status-turbo 文案层内部异常：${message}`,
  }
}

/** 是不是 hookFault 造出来的那条 fault（调用方据此走上报通道，而不是塞进工具返回）。 */
export function isHookFault(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.at === 'number' &&
    typeof value.hook === 'string' &&
    typeof value.message === 'string'
  )
}
