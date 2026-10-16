/**
 * dsh-status-turbo / 宿主半
 *
 *  A1（状态条）：把一个 wire 投影 `turbo` 注册到 `ctx.sessionProjections`。
 *  B1（按步降推理档）：折叠工具轨迹，在 `agent/request` 的 waterfall 里**只降不升**地改写
 *      `reasoningEffort`（纯判据在 ./gears.js）。
 *
 * 这个半片**不**注册路由、不发网络请求、不碰任何其他服务。三处副作用都能由 config 关掉，
 * 其中两处**默认开**：① 写交接文档 + 起 `bili export` 子进程（`config.handoffExport`，默认 `true`）；
 * ② 到量时由宿主建一个**空白新会话**并把旧会话 id 写进它的第一条消息（`config.rotation`，默认 `'auto'`）。
 * 显式写 `handoffExport: false` / `rotation: 'off'` 后，各自一行都不做。
 * A1 的数据全部来自已 commit 的会话日志（折叠逻辑在 ./state.js，纯函数）。
 *
 * 参考实现（实读，非猜测）：
 *   - 投影：dsh-cache-billing/lib/index.js:14523(`inject`)、:14608(`apply`)、
 *     :14610(`register({key,stateVersion,stateSchema,init,apply,wire})`)。
 *   - 换挡：`@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js` 的 `agent/request` 条目
 *     （waterfall，summary 原文 "Replace the frozen call configuration."），以及
 *     `@deepseek-ai/dsh-agent/lib/types/model-selection.js:60-74` 里官方插件逐字同形的写法。
 */

import {
  DEFAULT_CONFIG,
  PHASES,
  TURBO_KEY,
  TURBO_STATE_VERSION,
  accountPayload,
  applyEvent,
  handoffStateOf,
  initState,
  laneWatermarkOf,
  payloadBytesOf,
  pushEnhancement,
  pushHandoff,
  pushHookFault,
  pushRotation,
  pushSpill,
  rehydrateRuntime,
  rotationStateOf,
  setLaneWatermark,
  syncLedger,
  toView,
} from './state.js'
import {
  initSessionGears,
  judgeDowngrade,
  noteGearEvent,
  pickLowerEffort,
  readGearConfig,
} from './gears.js'
// 钩子层（T05）：判定表在 ./notes.js，瘦身在 ./spill.js，运行时表在 ./state.js。
// 本文件只做接线与顺序，不自己实现任何一条判据（PLAN.md §3.4 的合并契约）。
import { aggregateKey, argumentsOf, collectNotes, isHookFault } from './notes.js'
import { enhancementOf, spillOnce } from './spill.js'
// 0.7.0 交接导出：判据 / 探测 / 执行全在 ./handoff.js（可注入 I/O，纯逻辑可单测）。
// 这里只做接线与节流，不自己实现任何一条判据。
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HANDOFF_GITIGNORE,
  HANDOFF_MESSAGE,
  HANDOFF_STATUS,
  effectiveByteThreshold,
  effectiveThreshold,
  failureMessage,
  handoffDir,
  isFreshEvent,
  isModelVisibleEvent,
  lanesFor,
  listLanes,
  parseExportLanes,
  planHandoff,
  positiveInt,
  profileRootOf,
  resolveBili,
  runExport,
  shouldExport,
} from './handoff.js'
// 0.9.0 到量轮换：判据在 ./rotation.js（纯函数），宿主侧动作（建空白会话；0.21.1 起建完不写任何消息）在
// ./rotation-host.js（I/O 全部注入、可单测），客户端只负责 `open`（必要时再 archive 旧会话）。
import { ROTATION_MESSAGE, ROTATION_STATUS, rotationCreates, rotationMode, shouldRotate } from './rotation.js'
import { newChildId, runRotationAction } from './rotation-host.js'
// 0.18.0：本插件的条目 `Config` schema 与「用时现取」的配置视图 —— 0.15.0 起设置命名空间只能由
// 条目自己的 `Config` 产生（旧的 `settings.register(ns, schema)` 在本版 DSH 上是死路）。
import { liveConfig, turboConfigSchema } from './config.js'

export const name = 'dsh-status-turbo'

/** 挂载即要求投影服务在场；服务缺失时 cordis 会把它记为未激活的插件，而不是静默成功。 */
export const inject = ['sessionProjections']

/**
 * 直通 schema。
 *
 * 依据：`@deepseek-ai/dsh-session-projection/lib/index.js` 运行时**只调 `.parse()`**
 * （:255/:259 冷启动还原、:297/:305 持久化还原、:422 实时 drive 视图、:433 viewCell），
 * 从不读 `.shape`/`.safeParse`。纯 JS 插件不需要为此引入 zod 或加一层构建。
 */
/**
 * P0-2：宿主在从持久化行恢复这个投影时会调用 `definition.stateSchema.parse(row.val)`
 * （实读 `D:\deepseek-harness\packages\session\session-projection\src\index.ts:389` 与 `:442`），
 * 拒了就当这个会话没有快照、退回 `init()`。原先挂的是恒等 passthrough ⇒ 旧版本或被改坏的
 * 快照会**原样**进 `apply`，把水位、计数和 `armed` 守卫一起带歪。
 *
 * 零依赖手写（本插件不引 zod）：只做**边界守卫**，不做字段清理 —— 认不出的抛，认得出的原样放行。
 * 故意宽松：真实快照会跨版本带着旧键进来，拒绝它等于白丢水位。`stateVersion` 已在更前面
 * 拦过一次版本，所以这里只兜"形状根本不对"。
 */
const NUMERIC_OR_NULL_FIELDS = ['turn', 'step']
const COUNTER_FIELDS = ['subagents', 'toolCalls', 'retries', 'approvals', 'prefixEpoch']
export const turboStateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      throw new TypeError(`dsh-status-turbo: 投影快照必须是对象，收到 ${got}`)
    }
    // 注意两点真实形状：① `turn` / `step` 在新建会话时是 **null**（不是 0）；
    // ② 宿主在快照不可用时会调 `init()` **不带 header**（`session-projection/src/index.ts:442`
    //    `def.init()`），那种 state 的 `sessionId` / `phase` 允许是空值 ⇒ 只要求"有值就是字符串"。
    if (value.sessionId != null && typeof value.sessionId !== 'string') {
      throw new TypeError(`dsh-status-turbo: 投影快照的 sessionId 必须是字符串，收到 ${typeof value.sessionId}`)
    }
    if (value.phase != null && typeof value.phase !== 'string') {
      throw new TypeError(`dsh-status-turbo: 投影快照的 phase 必须是字符串，收到 ${typeof value.phase}`)
    }
    // 注意 `turn` / `step` 在新建会话时是 **null**（`initState` 的真实形状），不是 0。
    for (const key of NUMERIC_OR_NULL_FIELDS) {
      const field = value[key]
      if (field === null || field === undefined) continue
      if (typeof field !== 'number') {
        throw new TypeError(`dsh-status-turbo: 投影快照的 ${key} 必须是数字或 null，收到 ${typeof field}`)
      }
      if (field < 0) throw new RangeError(`dsh-status-turbo: 投影快照的 ${key} 不能为负`)
    }
    for (const key of COUNTER_FIELDS) {
      if (typeof value[key] !== 'number') {
        throw new TypeError(`dsh-status-turbo: 投影快照的 ${key} 必须是数字，收到 ${typeof value[key]}`)
      }
    }
    if (!Array.isArray(value.activity)) throw new TypeError('dsh-status-turbo: 投影快照的 activity 必须是数组')
    const usage = value.turnUsage
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
      throw new TypeError('dsh-status-turbo: 投影快照的 turnUsage 必须是对象')
    }
    return value
  },
}

const passthroughSchema = {
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
}

/** cordis 的 logger 是上下文自带属性；取不到就退回 console，绝不静默吞掉。 */
function logLine(run, level, message) {
  const fallback = level === 'error' ? console.error : console.warn
  try {
    const logger = run !== null && run !== undefined && run.ctx !== null && run.ctx !== undefined ? run.ctx.logger : undefined
    const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined
    if (fn) {
      fn(message)
      return
    }
  } catch {
    /* fall through to console */
  }
  fallback(`[dsh-status-turbo] ${message}`)
}

/**
 * 一次挂载的宿主侧状态（P1-5）。
 *
 * 为什么是一个对象而不是一组模块级变量：模块级状态在「同一进程挂第二次」时会被两个 mount
 * 共用 —— 交接进程账互相顶掉、`warned*` 只告一次警却告在错的会话上、S6 的 teardown 闸门
 * 指向最后一次 `apply`。`apply` 现在只建一个 `run`，宿主侧的判定与记账全从它身上取。
 *
 * `io` 指向模块级的 `hostIo`（那是可替换的 I/O 出口，不是 per-mount 状态）：测试整组替换
 * `__test.hostIo` 的成员即可驱动真分支，不需要真的起 bili。
 *
 * @param {object|null} ctx 宿主上下文（测试替身传 `null`：日志落 console）。
 * @param {object} effective `DEFAULT_CONFIG` 与宿主 config 的浅合并。
 * @returns {object} 本次挂载的宿主侧状态。
 */
function createRun(ctx, effective) {
  return {
    ctx,
    effective,
    io: hostIo,
    /**
     * 0.17.1：`sessions` / `agents` / `workspaces` 只在**声明它们的那个 `inject` 回调的 ctx** 上可取
     * （见 apply 里的接线注释）。放在 `run` 上按引用现用：解析晚到也有效；取不到就是 `null`
     * （能力降级，不是故障）。
     */
    sessions: null,
    agents: null,
    workspaces: null,
    agentPresets: null,
    agentDefaultModel: null,
  // 0.20.0：改名要用（下面 `ctx.inject(['sessionTitle'], …)` 填；取不到只降级）。
  sessionTitle: null,
    handoffSpawns: 0,
    laneReads: 0,
    /** P1-3：正在跑 `noteHandoff` 的会话 —— 同一会话同一时刻只跑一趟（见该函数）。 */
    handoffInFlight: new Set(),
    /** P1-3：本 mount 已建好目录（含 `.gitignore`）的集合，命中即不再落盘。 */
    preparedDirs: new Set(),
    /** S6：在跑的导出 / 车道读取子进程句柄，`dispose` 时逐个杀。 */
    liveChildren: new Set(),
    /** S6：`false` 之后绝不再起新进程，也不再往记录里写终态。 */
    active: true,
    /**
     * 上一次轮换的**进程级**时间戳。开场话术里写着「继续旧会话 …」（0.21.1 起由人粘贴进去），而旧会话里那些
     * 请求的 `inputTokens` 本来就已越桶 ⇒ 只按「每会话各自的节流」判断的话，新会话一开头就会
     * 立刻再轮换一次，形成雪崩；进程级时间戳让冷却期跨会话生效。
     */
    lastRotationArmedAt: 0,
    warnedNoSessionId: false,
    warnedNoHookSessionId: false,
    /** 同一工具 × 同一参数指纹的连续重复计数（只在内存，不持久化；PLAN.md §3.7）。 */
    stuckRuns: new Map(),
  }
}

/**
 * 最近一次 `apply` 建的那份宿主侧状态（P1-5）。
 *
 * **只在 `__test` 这条测试缝里读**：测试既要能驱动真挂载（S6 的 teardown 必须收到真挂载
 * 起过的子进程句柄），也要能在不挂载时用合成 run。生产路径一个字都不读它 —— 每个监听器
 * 都闭包捕获自己的 `run`，多次挂载互不影响。
 */
let lastRun = null

/**
 * 单一配置入口（P1-4；0.16.0 起返回**用时现取**的视图）：`DEFAULT_CONFIG` 与宿主 patch 的合并
 * 只在这里发生，但合并结果不再是一份快照 —— `liveConfig` 造出的对象属性是 getter，每次读取都去问
 * 宿主配置上那个 volatile 引用此刻的值，缺失才回落默认值。
 *
 * 为什么不能抄快照：0.16.0 起每个配置字段都是 volatile，用户在设置页改一项，loader 的
 * `_commitVolatile()` 只**就地**更新引用并发 `loader/volatile-update`（不重挂插件）。快照会永远停在
 * 挂载那一刻 —— 页面显示新值、插件却还用旧值，这正是"配置要重启才生效"的根因。视图对象身份稳定，
 * 所有分支（房间宿主、轮换阈值、上下文裁剪、溢出落盘、状态栏）照旧读它，只是"每次读都新鲜"。
 *
 * @param {object} [config] 宿主传给插件的原始 config（可能缺失，也可能不是对象）。
 * @returns {object} 有效配置视图（属性为 getter）；此后所有分支只传它。
 */
function resolveConfig(config) {
  // 浅合并仍然只在这里发生（P1-4 的门就查这一处展开）。它抄的是**引用**而不是值：
  // volatile 字段在宿主 config 上是稳定的冻结引用对象，展开后仍是同一个引用，所以 `liveConfig`
  // 造出的 getter 读到的始终是"此刻"的值 —— 快照语义没了，合并入口的唯一性还在。
  const merged = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }
  return liveConfig(merged, DEFAULT_CONFIG)
}

/**
 * 从注入回调收到的上下文上取一个服务实例。
 *
 * 为什么需要它：cordis 只把 `events` / `fiber` / `registry` / `reflect` 混入 `ctx`（见
 * `cordis/lib/index.js` 的 `this.mixin(...)` 清单），**服务自己的方法挂在服务对象上** ——
 * 正确写法是 `ctx.tools.register(...)`、`ctx.commands.register(...)`。0.10.0–0.16.1 这里写成
 * `ctx.register(...)` 并先判 `typeof !== 'function'`，于是注册整段被静默降级（当时的症状：钩子
 * 与投影照常，但任何会话都拿不到插件注册的工具与命令）。
 *
 * @param {object} ctx 注入回调收到的上下文（服务挂在属性上）。
 * @param {string} key 服务名（`'tools'` / `'commands'`）。
 * @returns {object|null} 带 `register` 的服务对象；取不到时 null（调用方只降级，不抛）。
 */
function registeredService(ctx, key) {
  if (ctx === null || ctx === undefined) return null
  const viaKey = ctx[key]
  if (viaKey !== null && viaKey !== undefined && typeof viaKey.register === 'function') return viaKey
  // 干跑替身（测试里的假上下文）直接把服务当上下文传进来，认它；真实宿主永远走上面那条。
  if (typeof ctx.register === 'function') return ctx
  return null
}

/**
 * 取一个**没有写进 `inject`** 的可选服务。
 *
 * 依据 `cordis/lib/index.js:673-698`（`ReflectService.handler.get`）：属性访问 `ctx.sessions`
 * 在 fiber 链上找不到实现时**抛错**（`cannot get property "sessions" without inject`），
 * 而 `ctx.get(name)`（`reflect.get`，非严格）取不到只返回 undefined。0.9.0–0.17.0 的轮换一直用
 * 属性访问，且把它包在 `try` 里当成"服务缺席"降级 —— 一旦这个宿主里 `sessions` 不在可取到的
 * fiber 上，"建会话"这一步就整段失败，而盘上不留任何痕迹。
 *
 * @param {object} ctx 宿主上下文。
 * @param {string} key 服务名。
 * @returns {object|null} 服务实例；取不到或抛错时 null（调用方只降级，不抛）。
 */
function serviceOf(ctx, key) {
  if (ctx === null || ctx === undefined) return null
  if (typeof ctx.get === 'function') {
    try {
      const viaGet = ctx.get(key)
      if (viaGet !== null && viaGet !== undefined) return viaGet
    } catch {
      // 只吞"取服务"这一件事：非严格 `get` 在个别宿主上仍会抛（inactive context / isolate 不匹配），
      // 下面再用属性访问兜一次；两条都不行才返回 null。
    }
  }
  try {
    const viaProp = ctx[key]
    return viaProp === undefined ? null : viaProp
  } catch {
    // 同上：属性访问抛错等价于"拿不到这个服务"。
    return null
  }
}

/**
 * 收敛一份模型选择：`provider` 与 `model` 都是非空字符串才算数（`reasoningEffort` 有就带上）。
 *
 * @param {object|null} value 任何带 `provider` / `model` 的对象（代理 `options` 或默认选择）。
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null} 不全就返回 null。
 */
function modelSelectionOf(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' && value.provider !== '' ? value.provider : null
  const model = typeof value.model === 'string' && value.model !== '' ? value.model : null
  if (provider === null || model === null) return null
  const selection = { provider, model }
  const effort = typeof value.reasoningEffort === 'string' && value.reasoningEffort !== '' ? value.reasoningEffort : null
  if (effort !== null) selection.reasoningEffort = effort
  return selection
}

/**
 * 轮换子会话要用的模型选择：优先继承旧会话正在用的那份，回落宿主的默认选择。
 *
 * 0.19.3 的现场根因：`dsh-agent-loop/lib/index.js:1564-1566` 用 `context.agent?.options.provider`
 * / `...model` / `...cwd` 填系统提示变量，子代理没有 `agentOptions` 时它们是 `undefined`，
 * `dsh-system-prompt/lib/index.js:172` 直接抛 `prompt variable "{{model}}" has no value for this
 * assembly` ⇒ 新会话一跑就是「本轮运行失败」。
 *
 * @param {object} run 插件运行记录（`agents` / `agentDefaultModel` 都可缺席）。
 * @param {string} sessionId 旧会话 id。
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null} 取不到就 null（调用方不传，等同旧行为）。
 */
function childAgentOptions(run, sessionId) {
  const agents = run === null || run === undefined ? null : run.agents
  if (agents !== null && agents !== undefined && typeof agents.get === 'function') {
    try {
      const parent = agents.get(sessionId)
      const inherited = modelSelectionOf(parent !== null && parent !== undefined ? parent.options : null)
      if (inherited !== null) return inherited
    } catch {
      // 旧会话刚好被销毁 / 服务形态变了：退到宿主默认选择，不拦轮换。
    }
  }
  const defaults = run === null || run === undefined ? null : run.agentDefaultModel
  if (defaults !== null && defaults !== undefined && typeof defaults.currentSelection === 'function') {
    try {
      return modelSelectionOf(defaults.currentSelection())
    } catch {
      return null
    }
  }
  return null
}

/**
 * 旧会话的 Agent preset id（写进子会话 header 并挂同一套组合）。
 *
 * @param {object} run 插件运行记录（`sessions` 可缺席）。
 * @param {string} sessionId 旧会话 id。
 * @returns {string|null} 非空 preset id，或 null（缺席即按"没有 preset"建会话）。
 */
function parentPresetOf(run, sessionId) {
  const sessions = run === null || run === undefined ? null : run.sessions
  if (sessions === null || sessions === undefined || typeof sessions.get !== 'function') return null
  try {
    const parent = sessions.get(sessionId)
    const preset = parent !== null && parent !== undefined && parent.header !== null && typeof parent.header === 'object' ? parent.header.agentPreset : null
    return typeof preset === 'string' && preset !== '' ? preset : null
  } catch {
    return null
  }
}

/** 轮换决策痕迹文件：活体症状（"到量了却没开新会话"）在盘上原本没有任何出口，这里补一条 JSONL。 */
const ROTATION_TRACE_DIR = 'dsh-status-turbo'
const ROTATION_TRACE_FILE = 'rotation-trace.jsonl'
const ROTATION_TRACE_MIN_GAP_MS = 5000
const rotationTraceAt = new Map()
let rotationTraceChain = Promise.resolve()

/**
 * 追加一条轮换决策痕迹（fire-and-forget，绝不外抛）。
 *
 * 为什么在热路径上也要写盘：这个判据的每个静默出口（未达阈值、拿不到服务、建会话被拒）都只写
 * `ctx.logger`，而桌面宿主没有把插件日志落到文件，事后无法复盘。每个会话最多每 5 秒一条，
 * 体积可忽略。目录与房间 store 同级（`<profile>/dsh-status-turbo/`）。
 *
 * @param {object} run 宿主侧状态。
 * @param {string} sessionId 会话 id。
 * @param {object} detail 决策细节（阈值、水位、闸门结果）。
 * @returns {void}
 */
function traceRotation(run, sessionId, detail) {
  const nowMs = Date.now()
  const last = rotationTraceAt.get(sessionId)
  if (typeof last === 'number' && nowMs - last < ROTATION_TRACE_MIN_GAP_MS) return
  rotationTraceAt.set(sessionId, nowMs)
  let root = '.'
  try {
    const dir = run !== null && run !== undefined && run.io !== undefined && typeof run.io.profileDir === 'function' ? run.io.profileDir() : null
    if (typeof dir === 'string' && dir !== '') root = dir
  } catch {
    // 拿不到 profile 根就用当前目录：痕迹宁可有，不要因为路径解析失败而丢。
  }
  const line = `${JSON.stringify({ t: nowMs, sessionId, ...detail })}\n`
  const file = join(root, ROTATION_TRACE_DIR, ROTATION_TRACE_FILE)
  rotationTraceChain = rotationTraceChain
    .then(() => mkdir(join(root, ROTATION_TRACE_DIR), { recursive: true }))
    .then(() => appendFile(file, line, 'utf8'))
    .catch(() => {
      // 痕迹写不进去不能影响轮换本身：这条路是诊断用的旁支。
    })
}

export function apply(ctx, config) {
  const effective = resolveConfig(config)
  // P1-5：原先散在模块级的那些状态（上下文引用、有效配置、交接进程账、轮换时间戳、告警旗标、
  // 卡住计数表）全部收进这次挂载的 `run` —— 同进程挂第二次不再互相踩，
  // S6 的 teardown 闸门也随每次挂载各自持有一份。
  const run = createRun(ctx, effective)
  lastRun = run

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const service = projectionCtx.sessionProjections
    if (!service || typeof service.register !== 'function') {
      // §9 第 3 条：不静默 return。抛出去让宿主把插件标成失败，而不是"看起来装上了但什么都不动"。
      throw new Error(
        'dsh-status-turbo: ctx.sessionProjections.register is unavailable — the session projection service is missing or too old',
      )
    }

    const definition = {
      key: TURBO_KEY,
      stateVersion: TURBO_STATE_VERSION,
      stateSchema: turboStateSchema,
      init: (header) => initState(header),
      apply: (state, event) => {
        // 0.9.2：先再水化水位账 —— 冷启动（宿主持久化快照 + 新进程的空运行时表）时，
        // 本次折叠的判据必须看到上一次进程留下的水位，而不是从 0 重算。
        rehydrateRuntime(state)
        const next = applyEvent(state, event, effective)
        // 0.7.0：交接导出判定（默认关时只落一次 `disabled`）。任何异常都只记 fault，
        // 绝不打断折叠 —— 折叠是状态条的地基。
        try {
          accountEventPayload(next && next.sessionId, event)
        } catch {
          /* 度量失败绝不影响折叠（它只是个触发器） */
        }
        // 0.9.3（P1-3）：noteHandoff 是异步的（文件 I/O 走 `fs/promises`），返回的是**永不 reject**
        // 的 promise —— 故意不 await：折叠不等磁盘，导出那条路自己的失败只落记录。
        try {
          void noteHandoff(run, next, effective, event)
        } catch (error) {
          if (isHookFault(error)) recordHookFault(run, next && next.sessionId, 'handoff', error)
        }
        // 0.9.0（方案 B）：到量轮换由宿主在这里**直接做完**（建空白会话；0.21.1 起不再写开场话术），
        // 客户端只负责把新会话切到前台。0.8.0 的 `fork` 路径已废。
        try {
          void noteRotation(run, next, effective, event)
        } catch (error) {
          if (isHookFault(error)) recordHookFault(run, next && next.sessionId, 'rotation', error)
        }
        // 0.9.2：折叠之后再把水位账写回 state（它就是要被宿主持久化的那份快照）。
        // 账没变时返回同一个引用 ⇒ 宿主不会为无关事件白写一次盘。
        return syncLedger(next)
      },
      wire: {
        viewSchema: passthroughSchema,
        view: (state) => withCopyCard(toView(state, effective), state),
      },
    }

    try {
      service.register(definition)
    } catch (error) {
      logLine(run, 'error', `投影 "${TURBO_KEY}" 注册失败：${error && error.message ? error.message : String(error)}`)
      throw error
    }

    logLine(run, 'info', `投影 "${TURBO_KEY}" 已注册（stateVersion ${TURBO_STATE_VERSION}）`)
  })

  // 0.17.1：轮换换身（`sessions.create`）、房间的"新会话兜底投递"与编队视图都要 `sessions` / `agents`。
  //
  // 关键：**服务只在声明它的那个 `inject` 回调的 ctx 上可取**。0.9.0–0.17.0 这三处写的是
  // `run.ctx.sessions`（模块级 ctx 的属性访问），本宿主上取不到 —— 而 cordis 的属性访问在取不到时
  // **抛错**，被"可选服务"的守卫吞掉，于是轮换永远停在 `no-service` 且盘上不留痕迹。
  // 老实现里 `sessionProjections` 之所以一直正常，正是因为它是在 `inject(['sessionProjections'], …)`
  // 的回调 ctx 上取的（见上一段）。
  //
  // 依赖边按仓库约定单独声明，模块级数组仍是 `['sessionProjections']`；服务**不阻断**插件：
  // 取不到只让对应的那一条能力降级（`sessions` 取不到 = 轮换停在 no-service）。
  ctx.inject(['sessions'], (sessionsCtx) => {
    const resolved = serviceOf(sessionsCtx, 'sessions')
    if (resolved !== null) run.sessions = resolved
  })

  // 0.19.0：轮换要开出**落盘、可见**的新会话，就得走代理生命周期（`ctx.agents.create`）——
  // 只有生命周期里发布的会话会拿到持久化写句柄（见 `createChildQuietly` 的契约）。取不到只降级回内存会话。
  ctx.inject(['agents'], (agentsCtx) => {
    const resolved = serviceOf(agentsCtx, 'agents')
    if (resolved !== null) run.agents = resolved
  })

  // 0.19.1：落盘还不够 —— 左侧会话列表按工作区的 `sessionIds` 列，不挂进工作区就看不见。
  // 宿主 fork 也是这么挂的（`dsh-api-session-controller/lib/index.js:829-836`）。取不到只少一步挂载。
  ctx.inject(['workspaceRegistry'], (workspaceCtx) => {
    const resolved = serviceOf(workspaceCtx, 'workspaceRegistry')
    if (resolved !== null) run.workspaces = resolved
  })

  // 0.19.3：0.19.1 让子会话"看得见"，但一跑就红 —— 它没有模型选择，系统提示里的 `{{model}}` 渲染即抛错。
  // 模型优先继承旧会话（`agents.get(id).options`），回落宿主的默认选择（`agentDefaultModel`）。
  ctx.inject(['agentDefaultModel'], (modelCtx) => {
    const resolved = serviceOf(modelCtx, 'agentDefaultModel')
    if (resolved !== null) run.agentDefaultModel = resolved
  })

  // 0.19.3：子会话跟着旧会话的 preset 走（header 的 `agentPreset` + `presets.mount` 挂同一套组合）。
  // 0.20.0：改名要用 `ctx.sessionTitle`（客户端半不碰它 —— 名字只由宿主写）。
  ctx.inject(['sessionTitle'], (titleCtx) => {
    const resolved = serviceOf(titleCtx, 'sessionTitle')
    if (resolved !== null) run.sessionTitle = resolved
  })

  ctx.inject(['agentPresets'], (presetCtx) => {
    const resolved = serviceOf(presetCtx, 'agentPresets')
    if (resolved !== null) run.agentPresets = resolved
  })

  // 支柱 B3 / C2 / C3 / C1 的宿主侧接线（T05）。
  //
  // 依赖边只有这一条：`ctx.inject(['tools'], …)`。**模块级 `inject` 数组保持
  // `['sessionProjections']` 不变** —— 往里面加 'tools' 会让"投影服务在场"这个前提
  // 变成"tools 也在场"，一侧缺席就整个插件不激活（PLAN.md §2.2）。
  //
  // 只注册**一个**监听器（AUTHORITY.md · 合并契约）：四段判断在同一次返回里按
  // B3 → C2 → C3-a → C3-b → C1 顺序跑完，而不是拆成四个监听器互相看不见。
  // prepend 与 B1 换挡同理：必须是 waterfall 最外层，否则内层插件先改掉返回我们就看不到了。
  ctx.inject(['tools'], (toolsCtx) => {
    // 能力边到场 ≠ 注入进来的上下文一定带事件总线（老宿主 / 干跑替身都可能在只声明服务的
    // 情况下同步回调）。这里只把**新钩子层**降级，不让它把 A1/B1 一起拖下水：
    // 抛在这一行会中止 apply 的后半段，连 registerGears 都跑不到。降级要出声，不静默。
    if (toolsCtx === null || toolsCtx === undefined || typeof toolsCtx.on !== 'function') {
      logLine(run, 'warn', 'dsh-status-turbo: tools 上下文没有事件总线（on 不是函数），B3/C2/C3/C1 钩子层本次不挂载；A1 状态条与 B1 换挡不受影响')
      return
    }
    toolsCtx.on('tools/post-execute', (exec, result, next) => onPostExecute(run, exec, result, next), { prepend: true })
    logLine(run, 'info', 'B3/C2/C3/C1 钩子层已挂上（每个工具返回最多追加 4 个文本块；任何一段异常只记 fault，绝不抛）')
  })

  // P1-4：必须喂**合并后**的配置（`effective` = DEFAULT_CONFIG ← 本插件 patch），
  // 而不是 apply 收到的原始 config —— 否则用户 patch 里没写的档位参数会被 gears 的
  // 内部回落当成"默认"，出现两条默认值路径。
  registerGears(run, readGearConfig(effective))

  /**
   * 0.21.0：给 wire 的 `newSession` 补上「会话名称」与「会话日志目录」。
   *
   * 这两项都不是纯状态能算出来的：名字要问 `ctx.sessionTitle`，目录由 profile 目录推 `DSH_HOME`
   * 再按本机的会话目录约定拼出来（`state.js` 零依赖、不碰环境）。任何一项拿不到就留空串，
   * 客户端会省掉那一行，绝不用空值占位。
   *
   * @param {object} view `toView` 的产物（每次都是新对象）。
   * @param {object} state 投影状态（提供 `sessionId` 与 `cwd`）。
   * @returns {object} 补好两个字段的新视图。
   */
  function withCopyCard(view, state) {
    const sessionId = typeof (state && state.sessionId) === 'string' ? state.sessionId : ''
    const card = view !== null && view !== undefined && typeof view === 'object' ? view.newSession : null
    if (card === null || card === undefined || typeof card !== 'object') return view
    return {
      ...view,
      newSession: { ...card, title: sessionTitleOf(run, sessionId), logDir: sessionLogDirOf(state) },
    }
  }

  /**
   * 读本会话的持久化标题；服务缺席、会话对象拿不到、服务抛错都返回空串。
   *
   * @param {object} target 本次运行的 per-run 记录（`sessionTitle` / `sessions` 由 inject 填）。
   * @param {string} sessionId 会话 id。
   * @returns {string} 标题；取不到为空串。
   */
  function sessionTitleOf(target, sessionId) {
    const titles = target === null || target === undefined ? null : target.sessionTitle
    if (sessionId === '' || titles === null || titles === undefined || typeof titles.get !== 'function') return ''
    const sessions = target.sessions
    const session = sessions !== null && sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    try {
      const snapshot = titles.get(session === undefined ? null : session)
      return snapshot !== null && snapshot !== undefined && typeof snapshot.title === 'string' ? snapshot.title : ''
    } catch {
      return ''
    }
  }

  /**
   * 本会话的日志目录：`<DSH_HOME>/sessions/<projectKey>/<encodedId>`。
   *
   * 目录约定抄自 `dsh-session-persistence-jsonl/lib/index.js` 的 `projectKey()`（:875-894）与
   * `sessionDir()`（:914-916）—— 那里没有对外可调的路径接口，自己拼是唯一办法；两份规则要一起改。
   *
   * @param {object} state 投影状态。
   * @returns {string} 绝对路径；推不出来时为空串。
   */
  function sessionLogDirOf(state) {
    const cwd = typeof (state && state.cwd) === 'string' ? state.cwd : ''
    const id = typeof (state && state.sessionId) === 'string' ? state.sessionId : ''
    if (cwd === '' || id === '') return ''
    const profileDir = profileDirOf()
    if (typeof profileDir !== 'string' || profileDir === '') return ''
    return join(dirname(dirname(profileDir)), 'sessions', projectKeyOf(cwd), encodeSegmentOf(id))
  }

  /**
   * 会话目录名：把工作目录编码成一个安全目录段（与上游 `projectKey` 同规则）。
   *
   * @param {string} cwd 工作目录。
   * @returns {string} 形如 `--D-project--` 的目录名。
   */
  function projectKeyOf(cwd) {
    let readable = ''
    let separatorRun = false
    for (let i = 0; i < cwd.length; i += 1) {
      const code = cwd.charCodeAt(i)
      const ch = String.fromCharCode(code)
      if (ch === '/' || ch === '\\' || ch === ':') {
        if (!separatorRun) readable += '-'
        separatorRun = true
      } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
        readable += ch
        separatorRun = false
      } else {
        readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
        separatorRun = false
      }
    }
    return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
  }

  /**
   * 会话 id 的目录段编码（与上游 `encodeSegment` 同规则）。
   *
   * @param {string} raw 会话 id。
   * @returns {string} 安全目录段。
   */
  function encodeSegmentOf(raw) {
    let out = ''
    for (let i = 0; i < raw.length; i += 1) {
      const code = raw.charCodeAt(i)
      const ch = String.fromCharCode(code)
      if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
      else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
    }
    return out
  }

  // S6：`dispose` 之后绝不再起新进程 —— 已经在跑的（导出 / 车道列表）逐个杀掉，句柄集清空。
  // 0.9.2 之前全文件没有任何 teardown 路径：插件卸载后一条迟到的 listLanes 回调还能再起一批
  // 导出，并往已经卸载的 ctx 上记状态；在跑的 bili 进程也永远没人收。
  armTeardownGuard(ctx, run)

  // 本条目有了 `Config` 之后，DSH 会照它自动生成一张原始配置表单；本插件自带「全部设置项」页
  // （客户端半），所以关掉自动表单。关不掉只是多一张多余的表单 —— 失败只记一行，绝不影响功能。
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx === null || settingsCtx === undefined ? null : settingsCtx.settings
    const fiber = ctx.fiber
    if (
      settings === null ||
      settings === undefined ||
      typeof settings.configure !== 'function' ||
      fiber === null ||
      fiber === undefined
    ) {
      logLine(run, 'info', '设置服务缺席或不可配置：自动配置表单未抑制（插件功能照常）')
      return
    }
    try {
      // 第一个参数是这个条目自己的展示策略（`auto: false` = 不要自动生成的表单）。
      settings.configure({ auto: false }, fiber)
      logLine(run, 'info', '自动配置表单已抑制（设置 →「全部设置项」由本插件自带）')
    } catch (error) {
      logLine(run, 'warn', `自动配置表单抑制失败（只会多一张原始表单）：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * 支柱 B1 的宿主侧接线。
 *
 * 判据完全来自工具轨迹：本插件自己折叠 `session/event`，不扫日志、不读宿主内存。
 * 取不到 `ctx.llm`（读不到该模型公布的有序档位表）时**不静默**：记一条 warn 并让 A1 照常工作。
 */
/** ESM 里的 `require.resolve` 替身（探测 billion-context 的包内入口用）。 */
const requireHere = createRequire(import.meta.url)

/**
 * 运行时 `Config`：本插件条目的设置存储（0.15.0）。
 *
 * DSH ≥0.1.7 的设置服务里已经没有 `register(ns, schema)` / `get(ns)` —— 一个插件的设置命名空间
 * **只能**由它条目自己的 `Config` 产生，且宿主侧只认「有 `toJSON` 的 schemastery 实例」。所以
 * 「设置 → 群聊」的数据面从这里来，客户端用 `ctx.configForms.get(条目 id)` 读同一份。
 *
 * schemastery 只能**运行时**取，而且必须走 ESM 的 `import()`：
 *
 * - 静态 `import z from '@deepseek-ai/schemastery'` 不行：仓库工作树里没有 `node_modules`（插件零依赖，
 *   测试直接从仓库跑），静态 import 会让 `node --test` 整组解析失败。
 * - `createRequire(...)('@deepseek-ai/schemastery')` 也不行：宿主并发 `import()` 装载插件时，
 *   schemastery 的 CJS 入口会去 `require` 还是 ESM 的 `cosmokit`，Node 24 抛
 *   `ERR_REQUIRE_ESM_RACE_CONDITION`（0.15.0 装机实测，五条 require 取法全灭，条目因此没有设置命名空间）。
 * - ESM 的 `import()` 由装载器自己排队，不存在那个竞态；宿主的解析拦截也照常放行。
 *
 * 顶层 await 让本模块的求值变成异步：装载器与本仓库测试都是 `import`，都等它。仓库里这条 import 必然
 * reject（没有 node_modules），吞掉即可 —— `Config` 退化成 `undefined`，设置页不可用，其余能力照常。
 */
const runtimeZ = await (async () => {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const candidate = mod !== null && typeof mod === 'object' && mod.default !== undefined ? mod.default : mod
    if (candidate !== null && candidate !== undefined && typeof candidate.object === 'function') return candidate
  } catch (error) {
    // 仓库工作树里没有 node_modules（预期）；装了 schemastery 的宿主里这条不会走到。
  }
  return null
})()

export const Config =
  runtimeZ !== null && runtimeZ !== undefined && typeof runtimeZ.object === 'function'
    ? turboConfigSchema(runtimeZ, DEFAULT_CONFIG)
    : undefined

/** 本文件所在包 → profile 根：`<profile>/node_modules/dsh-status-turbo/lib/index.js` ⇒ 上三层。 */
function profileDirOf() {
  return profileRootOf(fileURLToPath(import.meta.url))
}

/**
 * 宿主侧 I/O 出口：起进程、目录读写、bili 探测全从这里取。
 *
 * 集中在一处是为了可测：交接导出的执行编排（起进程、写 `.gitignore`、记终态、进程上限）此前在测试里
 * 是 0 次执行 —— 同类事故（两半主链零覆盖）已经出过两次。测试整组替换 `exports.__test.hostIo` 即可。
 *
 * 0.9.3（P1-3）：`readdir` / `mkdir` / `writeFile` 是**异步**的（`node:fs/promises`）；替身返回
 * promise 或普通值都行（调用方一律 `await`）。`exists` 仍是同步的 —— `resolveBili` 的契约是同步判据。
 */
const hostIo = {
  spawn,
  exists: existsSync,
  readdir: (dir) => readdir(dir),
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  readFile: (file) => readFile(file, 'utf8'),
  writeFile: (file, text) => writeFile(file, text, 'utf8'),
  rename: (from, to) => rename(from, to),
  resolveModule: (id) => requireHere.resolve(id),
  profileDir: () => profileDirOf(),
  execPath: process.execPath,
}

/** 导出文件名里的本地时间戳片段 `yyyyMMdd-HHmmss`。 */
function stampOf(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/**
 * 本次挂载已起的交接进程总数（导出 + 车道列表读取，S10 的口径）。两者都是「起了一个进程」，
 * 共用同一份 `handoffExportMaxPerProcess` 预算 —— 否则子车道模式下一次折叠能起 1 + N 个进程
 * 而账上只记 N。上限之所以必要：`apply` 在**冷启动重放**里也会被逐事件调用，多会话重放可能
 * 同时越阈值。
 *
 * @param {object} run 本次挂载的状态。
 * @returns {number} 本 mount 起过的交接进程数。
 */
function handoffProcessCount(run) {
  return run.handoffSpawns + run.laneReads
}

/** 尽力杀一个子进程句柄。杀不掉的场景只剩「进程已经自己退出了」。 */
function killQuietly(child) {
  try {
    if (child !== null && typeof child === 'object' && typeof child.kill === 'function') child.kill()
  } catch {
    /* 进程已经没了：给一个不存在的 pid 发 SIGTERM 不值得记一次故障 */
  }
}

/**
 * S6：把 teardown 守卫挂到 ctx 的生命周期上 —— 插件卸载后置 `active = false`（不再起新进程、
 * 不再往记录里写终态），并把在跑的导出/车道读取子进程逐个杀掉。
 *
 * 优先 `ctx.effect`：它是 Cordis 的作用域化清理，卸载时保证跑到。老版本或测试假体没有 `effect`
 * 时退到 `ctx.on('dispose')`；两者都没有就**大声告警** —— 守卫没挂上这件事本身要可见。
 *
 * @param {object} ctx 宿主上下文（`apply` 收到的那一个）。
 * @returns {void}
 */
function armTeardownGuard(ctx, run) {
  const stop = () => {
    run.active = false
    for (const child of run.liveChildren) killQuietly(child)
    run.liveChildren.clear()
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => stop)
    return
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', stop)
    return
  }
  logLine(run, 'warn', 'dsh-status-turbo：ctx 既没有 effect 也没有 on，S6 的 dispose 守卫没挂上 —— 卸载后可能有子进程没人收')
}

/**
 * 导出目录的条目快照；目录还不存在 ⇒ `[]`（没有既有文档，不是故障）。
 *
 * 0.9.3（P1-3）：由 `node:fs` 里那版同步的 `readdir` 换成 `node:fs/promises` 的 `await` 版。它是
 * **折叠热路径上唯一一次文件 I/O**（判据没过时每次折叠都会重读一遍），同步读等于把宿主的
 * 事件循环按在磁盘上。
 *
 * @param {string} dir 交接文档目录。
 * @returns {Promise<string[]>} 目录条目；读不到 ⇒ `[]`。
 */
async function readHandoffEntries(run, dir) {
  try {
    return await run.io.readdir(dir)
  } catch {
    return [] // 目录还不存在（= 没有既有文档），不是故障
  }
}

/**
 * 建目录并放一份 `.gitignore`（P1-7：别让 `git add .` 收走交接文档）。失败只 warn。
 *
 * 0.9.3（P1-3）：同样走 `node:fs/promises`，且只在**真的要起导出**时才发生（不在折叠热路径上）。
 *
 * @param {string} dir 交接文档目录。
 * @returns {Promise<boolean>} 目录可用 ⇒ `true`。
 */
async function ensureHandoffDir(run, dir) {
  // P1-3：`mkdir` 与那份 `.gitignore` 在**本 mount 内每目录只做一次**。0.9.2 之前每个事件都
  // `mkdirSync` + `writeFileSync` 一遍（在折叠热路径上同步落盘）；现在命中缓存直接返回。
  // 挂载期写不了：要等第一条真正越阈值的折叠才知道 cwd / 目录，所以缓存粒度是「本 mount 内已备好
  // 的目录集合」——效果与「挂载期写一次」相同：每目录至多一次 I/O。
  if (run.preparedDirs.has(dir)) return true
  try {
    await run.io.mkdir(dir)
    await run.io.writeFile(join(dir, '.gitignore'), HANDOFF_GITIGNORE)
    run.preparedDirs.add(dir)
    return true
  } catch (error) {
    logLine(run, 'warn', `交接导出：建目录失败（${error && error.message ? error.message : String(error)}）`)
    return false
  }
}

/** 失败时把 stderr 尾行附进 warn（P2-3：原来只有退出码，排查得手工重跑）。 */
function stderrTail(stdoutOrStderr) {
  if (typeof stdoutOrStderr !== 'string') return ''
  const lines = stdoutOrStderr.trim().split(/\r?\n/).filter((line) => line !== '')
  if (lines.length === 0) return ''
  return ` · ${lines[lines.length - 1].slice(0, 200)}`
}

/**
 * 把一条事件的体量记进「模型可见体量」字节账（0.7.4 · P0-3 的字节口径）。
 *
 * 口径：`JSON.stringify(event.data)` 的 UTF-8 字节数 —— 它就是日志里那条事件的体量，
 * 也正是 bili 那条护栏（`~7.5 bytes/token`）在量的东西的量级。
 * `request/header` **只记最新一次**（它每一步都重建，累加会把账吹爆）；其余按 `seq` 幂等累加。
 */
function accountEventPayload(sessionId, event) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (event === null || typeof event !== 'object') return
  let encoded
  try {
    encoded = JSON.stringify(event.data === undefined ? null : event.data)
  } catch {
    return // 循环引用等：只放弃这一次度量
  }
  if (typeof encoded !== 'string') return
  const bytes = Buffer.byteLength(encoded, 'utf8')
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'request/header') {
    accountPayload(sessionId, { header: true, bytes })
    return
  }
  // 0.7.5：只计价**模型可见**的类型（compaction 成对事件会把同一段文本算两遍）。
  if (!isModelVisibleEvent(type)) return
  accountPayload(sessionId, { seq: event.seq, bytes })
}

/**
 * 进 wire 的 `openChild`：`childId` 为 `null` 时**强制 `false`**。
 *
 * 没有 `childId` 就意味着没有可切的目标；再带上 `openChild: true` 等于给客户端一条
 * 「切到某个不存在的会话」的指令（`sessions.open(null)`）。
 */
function rotationOpenChild(outcome) {
  return outcome.childId === null ? false : outcome.plan.openChild
}

/**
 * 到量轮换（0.9.0 · 方案 B）的接线入口：每次折叠后跑一次。
 *
 * 判据全在 `./rotation.js · shouldRotate`；判定通过后**由宿主直接完成轮换** ——
 * 建一个**空白**新会话（`ctx.agents.create`，0.21.1 起退路为 `ctx.sessions.create`）并给它补一个按旧会话
 * 递增的名字，随后客户端只需要 `uiWorkspace.openSession(childId)`。
 * 0.21.1 起不再写开场话术（用户 m08927）——新会话是空白的，旧会话 id 由用户在状态条点
 * 「复制话术」手动带过去。
 * 0.8.0 那条「宿主只写 armed、客户端 fork」的路径已废：fork 会把整份旧历史复制成种子，不解决上下文积压。
 *
 * 本函数**绝不外抛**：`runRotationAction` 自身把所有 I/O 失败收敛成状态 + `message` code；
 * 这里再包一层 try/catch，任何意外只记一条 fault。
 */
function noteRotation(run, state, config, event) {
  const sessionId = state && typeof state.sessionId === 'string' ? state.sessionId : null
  if (sessionId === null) return

  // 0.8.1：与交接文档同一把闸 —— 冷启动重放会把整份历史一次性折进来，不挡它的话
  // 重放到越桶那一刻就直接轮换（哪怕这个会话早就没人动了）。
  const at = event !== null && typeof event === 'object' ? event.time : undefined
  if (!isFreshEvent({ at, now: Date.now(), freshMs: config.rotationFreshMs })) return

  const mode = rotationMode(config)
  const current = rotationStateOf(sessionId)

  if (mode === 'off') {
    if (current === null || current.status !== ROTATION_STATUS.OFF) {
      pushRotation(sessionId, { status: ROTATION_STATUS.OFF, mode, sessionId })
    }
    return
  }

  // 已 armed（含「已建好新会话」）就不再重复做：`childId` 一旦落下，这个会话的轮换就结束了。
  if (current !== null && current.status === ROTATION_STATUS.ARMED) return

  const inputTokens = state.stepUsage && typeof state.stepUsage.input === 'number' ? state.stepUsage.input : null
  const payloadBytes = payloadBytesOf(sessionId)
  const contextWindow = Number.isSafeInteger(state.contextWindow) && state.contextWindow > 0 ? state.contextWindow : undefined
  // 新会话沿用旧会话的工作目录：工作目录是创建期字段（DSH 没有改它的原语），设置只能影响下一身。
  const cwd = typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : undefined
  // 0.19.3：子会话必须带着模型选择与旧会话的 preset 建出来，否则一跑就是「本轮运行失败」。
  const agentOptions = childAgentOptions(run, sessionId)
  const presetId = parentPresetOf(run, sessionId)
  // 0.17.1：`sessions` 优先用 mount 时由 `ctx.inject(['sessions'], …)` 回调解析出来的那份
  // （服务只在声明它的那个回调 ctx 上可取）；再兜一次属性访问，两条都不行才降级成 no-service。
  const sessionsService = run.sessions !== null && run.sessions !== undefined ? run.sessions : serviceOf(run.ctx, 'sessions')
  const now = Date.now()
  const own = current === null || typeof current.at !== 'number' ? 0 : current.at
  const lastArmedAt = Math.max(own, run.lastRotationArmedAt)
  // 0.20.0：默认只提醒（`rotationCreate: false`）。判据仍走同一个 `shouldRotate` ——「到量」照旧
  // 被认出来，只是后果从「建会话 + 切界面」降级成一条 `remind` 记录：不建会话、不挂工作区。
  if (
    !rotationCreates(config) &&
    shouldRotate({
      config,
      phase: state.phase,
      inputTokens,
      payloadBytes,
      contextWindow,
      lastArmedAt: lastArmedAt === 0 ? undefined : lastArmedAt,
      now,
    })
  ) {
    if (current === null || current.status !== ROTATION_STATUS.REMIND) {
      pushRotation(sessionId, {
        status: ROTATION_STATUS.REMIND,
        mode,
        at: now,
        inputTokens,
        payloadBytes,
        sessionId,
      })
    }
    traceRotation(run, sessionId, {
      phase: state.phase,
      mode,
      at: now,
      payloadBytes,
      inputTokens,
      byteLimit: effectiveByteThreshold({ config, contextWindow }),
      tokenLimit: effectiveThreshold({ config, contextWindow }),
      wouldRotate: true,
      recordStatus: current === null ? null : current.status,
      sessions: sessionsService === null ? 'missing' : 'present',
      sessionsFrom: run.sessions !== null && run.sessions !== undefined ? 'inject' : 'ctx',
      cwd,
      outcome: 'remind',
      message: null,
      childId: null,
    })
    logLine(run, 'info', '到量轮换：已到阈值，只提醒不建会话（rotationCreate: false）')
    return
  }
  let outcome = null
  let error = null
  try {
    outcome = runRotationAction({
      config,
      record: current,
      sessionId,
      cwd,
      preset: presetId,
      phase: state.phase,
      inputTokens,
      payloadBytes,
      contextWindow,
      lastArmedAt: lastArmedAt === 0 ? undefined : lastArmedAt,
      now,
      agents: run.agents === undefined ? null : run.agents,
      workspaces: run.workspaces === undefined ? null : run.workspaces,
      presets: run.agentPresets === undefined ? null : run.agentPresets,
      agentOptions,
      sessions: sessionsService,
      titles: run.sessionTitle === undefined ? null : run.sessionTitle,
      randomId: newChildId,
    })
    // 0.19.0：代理生命周期建会话是异步的，成功/失败都要留痕 —— 失败时界面上看不出任何东西。
    if (outcome !== null && outcome !== undefined && outcome.pending !== null && outcome.pending !== undefined) {
      const viaAgents = run.agents !== null && run.agents !== undefined
      void outcome.pending.then((settled) => {
        const ok = settled !== null && settled !== undefined && settled.ok === true
        const attach = settled === null || settled === undefined ? null : settled.attach
        if (ok && settled.titleOk === true) logLine(run, 'info', `到量轮换：新会话已改名「${String(settled.title)}」（按旧会话标题 (N) 递增）—— 列表里一眼能认出它是谁开的`)
        else if (ok) logLine(run, 'info', `到量轮换：新会话没改名（${String(settled.titleReason)}）—— 名字是尽力而为，不改名只影响列表里好不好认`)
        if (!ok) logLine(run, 'warn', `到量轮换：代理生命周期建会话失败 —— ${settled === null || settled === undefined ? '拿不到子会话' : String(settled.error)}`)
        // 0.19.1：没挂进工作区 = 会话在磁盘上但不在左侧列表里 —— 这一条以前完全无声。
        if (ok && attach !== 'attached') logLine(run, 'warn', `到量轮换：新会话没能挂进工作区（${String(attach)}）—— 它已落盘，但左侧列表里看不到`)
        traceRotation(run, sessionId, {
          outcome: ok ? 'via-agents' : 'via-agents-failed',
          childId: outcome.childId,
          attach,
          message: settled === null || settled === undefined ? null : settled.error,
          sessions: sessionsService === null ? 'missing' : 'present',
          titleOk: settled === null || settled === undefined ? null : settled.titleOk,

          title: settled === null || settled === undefined ? null : settled.title,

          titleReason: settled === null || settled === undefined ? null : settled.titleReason,

          sessionsFrom: viaAgents ? 'agents-inject' : 'ctx',
        })
      })
    }
  } catch (thrown) {
    error = thrown
  }
  if (error !== null) {
    if (!isHookFault(error)) throw error
    pushHookFault(sessionId, { at: now, hook: 'rotation', message: `轮换失败：${String(error.message ?? error)}` })
    logLine(run, 'warn', `到量轮换：建会话时抛错（已记 fault，不外抛）—— ${String(error.message ?? error)}`)
    traceRotation(run, sessionId, {
      phase: state.phase,
      mode,
      at,
      payloadBytes,
      inputTokens,
      cwd,
      preset: presetId,
      sessions: sessionsService === null ? 'missing' : 'present',
      outcome: 'error',
      message: String(error.message ?? error),
    })
    return
  }
  traceRotation(run, sessionId, {
    phase: state.phase,
    mode,
    at,
    payloadBytes,
    inputTokens,
    byteLimit: effectiveByteThreshold({ config, contextWindow }),
    tokenLimit: effectiveThreshold({ config, contextWindow }),
    wouldRotate: shouldRotate({ config, phase: state.phase, inputTokens, payloadBytes, contextWindow, lastArmedAt, now }),
    recordStatus: current === null ? null : current.status,
    sessions: sessionsService === null ? 'missing' : 'present',
    sessionsFrom: run.sessions !== null && run.sessions !== undefined ? 'inject' : 'ctx',
    cwd,
    outcome: outcome === null ? null : outcome.status,
    message: outcome === null ? null : outcome.message,
    childId: outcome === null ? null : outcome.childId,
    titleOk: outcome === null || outcome.titleOk === undefined ? null : outcome.titleOk,
    title: outcome === null || outcome.title === undefined ? null : outcome.title,
    titleReason: outcome === null || outcome.titleReason === undefined ? null : outcome.titleReason,
  })
  if (outcome === null || outcome.status === ROTATION_STATUS.IDLE) {
    // 前置闸没过（没有绝对路径 cwd / 没有 sessions 服务 / 判据未通过）：那条 `unavailable` 记录仍要落地。
    if (outcome !== null && outcome.message !== null) {
      pushRotation(sessionId, {
        status: ROTATION_STATUS.UNAVAILABLE,
        mode,
        at: now,
        inputTokens,
        payloadBytes,
        sessionId,
        childId: outcome.childId,
        message: outcome.message,
        openChild: rotationOpenChild(outcome),
        archiveOld: outcome.plan.archiveOld,
      })
      logLine(run, 'warn', `到量轮换：新会话不可用（${String(outcome.message)}）—— 不抛，面板显示原因`)
    } else if (current === null) {
      pushRotation(sessionId, { status: ROTATION_STATUS.IDLE, mode, sessionId })
    }
    return
  }

  run.lastRotationArmedAt = now

  if (outcome.titleOk === true) logLine(run, 'info', `到量轮换：新会话已改名「${String(outcome.title)}」（按旧会话标题 (N) 递增）`)
  pushRotation(sessionId, {
    status: ROTATION_STATUS.ARMED,
    mode,
    at: outcome.at === null ? now : outcome.at,
    inputTokens,
    payloadBytes,
    sessionId,
    childId: outcome.childId,
    message: outcome.message,
    openChild: rotationOpenChild(outcome),
    archiveOld: outcome.plan.archiveOld,
  })
  if (outcome.message === ROTATION_MESSAGE.CREATE_FAILED) {
    logLine(run, 'warn', '到量轮换：建会话被拒（可能 id 撞车）—— 已记 fault，不抛')
    return
  }
  // 0.18.0：房间整块移除后，轮换只负责「建空白新会话」（0.21.1 起不再写开场话术），不再有跟随换身的角色位。
  logLine(run, 
    'info',
    outcome.reused === true
      ? `到量轮换：复用宿主里已存在的子会话 ${String(outcome.childId)}（账里没有它的记录 —— 上次轮换那个进程的账没留下，所以不再建第二个；那次建出来的会话里当时写了什么这里查不到）—— ${mode === 'auto' ? '客户端将自动切过去' : '等你在面板上点'}`
      : `到量轮换：已建空白新会话 ${String(outcome.childId)}（开场话术请在状态条点「复制话术」，本步 ${String(inputTokens === null ? '?' : inputTokens)} token / 累计 ${String(payloadBytes)} B）—— ${mode === 'auto' ? '客户端将自动切过去' : '等你在面板上点'}`,
  )
}

/**
 * 交接文档自动导出的接线入口：每次折叠后跑一次。
 *
 * **判据全在 ./handoff.js · planHandoff**（纯函数、可单测，P1-5）；这里只剩 I/O 与节流：
 * 关着时 = 一次表查 +（首次）一次写表；开着时 = 一次表查 + 一次数值比较，
 * **真的越阈值**才去读车道列表、建目录、起进程。
 *
 * 不重触发的状态：`running`（正在跑/正在读车道列表）、`unavailable`（探测不到 bili，本进程内不再试）。
 * `done` / `failed` 之间由 `handoffExportMinDeltaTokens` + 水位桶幂等共同节流。
 *
 * 0.9.3（P1-3/S6）：本入口**异步**且**自己吞掉全部异常**（判据、I/O、续跑的车道列表都算），
 * 永远不 reject —— 折叠是状态条的地基，导出这条路不许把宿主的事件流带崩。`dispose` 之后
 * `active` 落地为 `false`：不再起新进程，在跑的由 `apply` 里的 effect 逐个杀掉。
 *
 * @param {object} state 折叠后的投影 state。
 * @param {object} config 宿主合并后的有效配置（`effective`）。
 * @param {object|null} event 触发这次折叠的事件。
 * @returns {Promise<void>} 永远 resolve。
 */
async function noteHandoff(run, state, config, event) {
  const sessionId = state && typeof state.sessionId === 'string' ? state.sessionId : null
  if (sessionId === null) return
  // P1-3：同一会话同一时刻只跑一趟。本函数现在是异步的，而折叠回调**不等**它 —— 两次折叠可以
  // 在第一次的 `await`（读目录 / 起进程）期间依次进来，都通过那串同步判据，于是同一水位被导出
  // 两次。闸门必须在第一个 `await` 之前落下，并用 `finally` 保证任何出口都释放。
  if (run.handoffInFlight.has(sessionId)) return
  run.handoffInFlight.add(sessionId)
  try {
    await handoffPass(run, state, config, event, sessionId)
  } catch (error) {
    if (isHookFault(error)) recordHookFault(run, sessionId, 'handoff', error)
  } finally {
    run.handoffInFlight.delete(sessionId)
  }
}

/** `noteHandoff` 的实际判定与 I/O（判据细节见各步注释）。 */
async function handoffPass(run, state, config, event, sessionId) {
  if (config.handoffExport !== true) {
    const current = handoffStateOf(sessionId)
    if (current === null || current.status !== HANDOFF_STATUS.DISABLED) {
      pushHandoff(sessionId, { status: HANDOFF_STATUS.DISABLED })
    }
    return
  }

  // P1-3：冷启动重放也会走这条路径，而重放的最后一帧通常是 idle ⇒ 不替历史会话生成文档。
  if (state.phase === PHASES.IDLE) return

  // 0.7.7：再挡一道「只对新鲜事件触发」。重放里中间那些事件并不是 idle，上面那一句挡不住
  // 累计体量在几秒内连续越桶（实测 0.7.6 上线当天因两处叠加写掉了 64 份文档）。
  const at = event !== null && typeof event === 'object' ? event.time : undefined
  if (!isFreshEvent({ at, now: Date.now(), freshMs: config.handoffExportFreshMs })) return

  const record = handoffStateOf(sessionId)
  if (record !== null && (record.status === HANDOFF_STATUS.RUNNING || record.status === HANDOFF_STATUS.UNAVAILABLE)) return

  const inputTokens = state.stepUsage && typeof state.stepUsage.input === 'number' ? state.stepUsage.input : null
  const payloadBytes = payloadBytesOf(sessionId)
  const contextWindow = Number.isSafeInteger(state.contextWindow) && state.contextWindow > 0 ? state.contextWindow : undefined
  // 触发预检：车道与桶的逐条判定在拿到车道列表之后交给 planHandoff；这里按**主车道**的水位先挡一下，
  // 免得每一步都去读一次车道列表（读列表要起进程）。
  const mainWatermark = laneWatermarkOf(sessionId, sessionId)
  if (!shouldExport({
    config,
    inputTokens,
    payloadBytes,
    contextWindow,
    lastInputTokens: mainWatermark === null ? undefined : mainWatermark.inputTokens,
    lastPayloadBytes: mainWatermark === null ? undefined : mainWatermark.payloadBytes,
  })) return

  const limit = positiveInt(config.handoffExportMaxPerProcess, 'handoffExportMaxPerProcess')
  // S10：上限算的是**本进程起过的交接进程总数**（导出 + 车道列表读取），不是只有导出。
  if (handoffProcessCount(run) >= limit) {
    if (record === null || record.status !== HANDOFF_STATUS.FAILED) {
      pushHandoff(sessionId, { status: HANDOFF_STATUS.FAILED, at: Date.now(), inputTokens, message: HANDOFF_MESSAGE.LIMIT_REACHED })
      logLine(run, 'warn', `交接导出：本进程已达上限（${String(limit)} 次）—— 重启，或调高 config.handoffExportMaxPerProcess`)
    }
    return
  }

  const cwd = typeof state.cwd === 'string' && state.cwd !== '' ? state.cwd : null
  if (cwd === null) {
    // 先决条件不满足，不是「导出失败」：语义归 unavailable（P2-2）。
    pushHandoff(sessionId, { status: HANDOFF_STATUS.UNAVAILABLE, at: Date.now(), inputTokens, message: HANDOFF_MESSAGE.NO_CWD })
    return
  }

  const bili = resolveBili({
    config,
    execPath: run.io.execPath,
    requireResolve: (id) => run.io.resolveModule(id),
    profileDir: run.io.profileDir(),
    exists: run.io.exists,
  })
  if (bili === null) {
    // 缺席，不是故障：不进 hookFaults，只记一次状态 + 一条 warn。
    pushHandoff(sessionId, { status: HANDOFF_STATUS.UNAVAILABLE, at: Date.now(), inputTokens })
    logLine(run, 'warn', '交接导出：找不到 bili 可执行文件（缺席，不是故障）—— 设 config.handoffExportBiliBin 指向它即可')
    return
  }

  const dir = handoffDir({ cwd, dir: config.handoffExportDir })
  const stamp = stampOf(new Date())
  const entries = await readHandoffEntries(run, dir)
  // P1-4：超时是一等配置键。0.9.2 之前是 ./handoff.js 里的 `DEFAULT_EXPORT_TIMEOUT_MS` 硬编码，
  // 用户改不了（那个常量现在只是 `DEFAULT_CONFIG` 的别名）。非法值由 `positiveInt` 回落。
  const timeoutMs = positiveInt(config.handoffExportTimeoutMs, 'handoffExportTimeoutMs')

  /**
   * 对一条车道起导出（每条车道一次进程）。
   *
   * @param {string} laneKey 车道键。
   * @param {string} output 导出文件路径。
   * @returns {Promise<void>} 建目录失败/已卸载时只落记录，不抛。
   */
  const exportLane = async (laneKey, output) => {
    if (!run.active) return // S6：插件已卸载 ⇒ 不再起新进程
    if (!(await ensureHandoffDir(run, dir))) {
      pushHandoff(sessionId, { status: HANDOFF_STATUS.FAILED, at: Date.now(), inputTokens, message: HANDOFF_MESSAGE.MKDIR_FAILED })
      return
    }
    run.handoffSpawns += 1
    // 句柄要在 onSettle 里删，又可能被同步回调：用先声明的可变引用，别踩 TDZ。
    let child = null
    let settled = false
    child = runExport({
      spawn: run.io.spawn,
      bili,
      sessionId: laneKey,
      full: config.handoffExportFull === true,
      output,
      cwd,
      timeoutMs,
      onSettle: (result) => {
        settled = true
        if (child !== null) run.liveChildren.delete(child)
        if (!run.active) return // S6：卸载之后不再往记录里写终态（记录随进程一起走）
        if (result.ok) {
          pushHandoff(sessionId, { status: HANDOFF_STATUS.DONE, at: Date.now(), inputTokens, path: output })
          logLine(run, 'info', `交接导出：完成 → ${output}`)
          return
        }
        const reason = failureMessage(result)
        pushHandoff(sessionId, { status: HANDOFF_STATUS.FAILED, at: Date.now(), path: output, message: reason })
        logLine(run, 'warn', `交接导出：失败（${reason}）${stderrTail(result.stderr)}`)
      },
    })
    if (!settled && child !== null && typeof child === 'object' && typeof child.kill === 'function') run.liveChildren.add(child)
  }

  /**
   * 车道键已就绪 ⇒ 逐条跑纯判据并动手。
   *
   * S10：撞进程上限时**落一条聚合记录 + 一条 warn**，不再静默 `break` —— 之前剩下的车道
   * 一声不响地没了，面板上什么都看不到。已经导出去的车道照旧记自己的完成态。
   *
   * @param {string[]} laneKeys 车道键（主车道在前）。
   * @returns {Promise<void>} 永不 reject。
   */
  const planAndRun = async (laneKeys) => {
    let exported = 0
    for (let i = 0; i < laneKeys.length; i += 1) {
      if (handoffProcessCount(run) >= limit) {
        const rest = laneKeys.length - i
        if (exported === 0) {
          pushHandoff(sessionId, { status: HANDOFF_STATUS.FAILED, at: Date.now(), inputTokens, message: HANDOFF_MESSAGE.LIMIT_REACHED })
        }
        logLine(run, 'warn', `交接导出：本进程已达上限（${String(limit)} 次）—— 本次还有 ${String(rest)} 条车道没导；重启，或调高 config.handoffExportMaxPerProcess`)
        break
      }
      const laneKey = laneKeys[i]
      // 残余修复：**每条车道各记各的水位**（0.7.3 之前子车道共用父会话那一份）。
      const lane = laneWatermarkOf(sessionId, laneKey)
      const plan = planHandoff({
        config,
        inputTokens,
        payloadBytes,
        contextWindow,
        entries,
        cwd,
        stamp,
        sessionId: laneKey,
        lastInputTokens: lane === null ? undefined : lane.inputTokens,
        lastPayloadBytes: lane === null ? undefined : lane.payloadBytes,
      })
      if (plan.action === 'none') continue
      setLaneWatermark(sessionId, laneKey, { inputTokens, payloadBytes })
      if (plan.action === 'skip') {
        pushHandoff(sessionId, { status: HANDOFF_STATUS.DONE, at: Date.now(), inputTokens, path: plan.output })
        exported += 1
        continue
      }
      await exportLane(laneKey, plan.output)
      exported += 1
    }
  }

  if (config.handoffExportSubLanes !== true) {
    await planAndRun([sessionId])
    return
  }

  // P2-1：主车道 + 它的 `|sub:` 子车道一起导。车道列表只能从 CLI 拿（没有机器可读模式，
  // 解析失败一律退化成"只导主车道"，绝不打断）。
  pushHandoff(sessionId, { status: HANDOFF_STATUS.RUNNING, at: Date.now(), inputTokens })
  // S10：读列表也是起进程，先记进同一份上限预算（真撞上限的话上面那次检查已经拦住了）。
  run.laneReads += 1
  let onLanesSettled = null
  const lanesSettled = new Promise((resolve) => { onLanesSettled = resolve })
  const lanesChild = listLanes({
    spawn: run.io.spawn,
    bili,
    cwd,
    timeoutMs,
    onSettle: (result) => { onLanesSettled(result) },
  })
  if (lanesChild !== null && typeof lanesChild === 'object' && typeof lanesChild.kill === 'function') run.liveChildren.add(lanesChild)
  // 等它读完再决定导哪些车道：这条续跑必须留在 noteHandoff 的 try/catch 里，
  // 否则（像 0.9.2 那样丢在回调里）异常会变成 unhandledRejection。
  const lanesResult = await lanesSettled
  if (lanesChild !== null) run.liveChildren.delete(lanesChild)
  if (!run.active) return // S6：卸载之后不许按这份车道列表再起一批导出
  if (!lanesResult.ok) {
    logLine(run, 'warn', `交接导出：车道列表读取失败（exit ${String(lanesResult.code === null || lanesResult.code === undefined ? 'unknown' : lanesResult.code)}）${stderrTail(lanesResult.stderr)}，退化为只导主车道`)
  }
  await planAndRun(lanesFor(parseExportLanes(lanesResult.stdout), sessionId))
}

function registerGears(run, gears) {
  if (!gears.enabled) {
    logLine(run, 'info', 'B1 按步降档已关闭（config.downgrade === false）')
    return
  }

  run.ctx.inject(['llm'], (llmCtx) => {
    const llm = llmCtx.llm
    if (!llm || typeof llm.resolveModelInfo !== 'function') {
      logLine(run, 
        'warn',
        'dsh-status-turbo: ctx.llm.resolveModelInfo 不可用，B1 按步降档未启用（读不到模型公布的档位表就不敢改；状态条不受影响）',
      )
      return
    }

    /** sessionId -> 换挡记录。只在本进程内存里，不持久化（换挡是逐步的，跨重启没有意义）。 */
    const tracker = new Map()

    llmCtx.on('session/event', (session, event) => {
      try {
        const id = session && session.id
        if (!id) return
        let rec = tracker.get(id)
        if (!rec) {
          rec = initSessionGears()
          tracker.set(id, rec)
        }
        noteGearEvent(rec, event, gears.readOnlyTools)
      } catch (error) {
        // 折叠失败绝不能让会话挂掉：轨迹只是"省算力"的判据，不是正确性依赖。
        logLine(run, 'warn', `B1 轨迹折叠异常（本会话放弃降档，不影响执行）：${error && error.message ? error.message : error}`)
        tracker.delete(session && session.id)
      }
    })

    // ⚠️ prepend 是必需的：必须是 waterfall 的**最外层**。
    // `@deepseek-ai/dsh-agent` 自带的 model-selection 插件也监听 `agent/request`，并在它自己那层
    // 把 `reasoningEffort` 重新写成用户选定的档位；若我们排在内层，改动会被它覆盖掉。
    llmCtx.on(
      'agent/request',
      async (payload, next) => {
        const resolved = await next()
        try {
          return await decideGear(run, { llm, tracker, gears, payload, resolved })
        } catch (error) {
          // §9 第 3 条：失败必须可见。这里退回原配置，但留下一条日志。
          logLine(run, 'warn', `dsh-status-turbo: B1 换挡判据异常，本步按原档执行：${error && error.message ? error.message : error}`)
          return resolved
        }
      },
      { prepend: true },
    )

    logLine(run, 
      'info',
      `B1 按步降档已启用（只降不升；floor=${gears.floor}；连续 ${gears.minQuietSteps} 步"只跑只读工具且无报错"才降档）`,
    )
  })
}

/**
 * 从 `agent/request` 的 payload 里取出会话 id。
 *
 * 为什么要这么绕（实读，非推测）：
 *   - 声明的接口是 `export interface Agent { readonly id: SessionId }` —— **只有 `id`**，
 *     没有任何 `session` 字段；
 *   - 但真实实现里 `@deepseek-ai/dsh-agent/lib/index.js:198` 用了 `agent.session.requestHeader()`，
 *     `:512` 还会校验 `if (id !== agent.session.id) throw new Error('agent id "…" does not match session id "…"')`
 *     —— 即运行时的确挂着 `.session`，且 `agent.id === agent.session.id`。
 *
 * 所以：**优先用声明里就有的 `agent.id`**，拿不到才退到运行时的 `.session.id`。
 * 两者都拿不到就只告一次警（否则 B1 会静默失效，正踩 §9 第 3 条）。
 */
function sessionIdOf(run, payload, tracker) {
  try {
    const agent = payload ? payload.agent : undefined
    if (agent) {
      if (typeof agent.id === 'string' && agent.id !== '') return agent.id
      const session = agent.session
      if (session && typeof session.id === 'string' && session.id !== '') return session.id
    }
  } catch (error) {
    if (!run.warnedNoSessionId) {
      run.warnedNoSessionId = true
      logLine(run, 'warn', `dsh-status-turbo: 读取会话 id 抛错，B1 按步降档失效（状态条不受影响）：${error && error.message ? error.message : error}`)
    }
    return null
  }
  if (!run.warnedNoSessionId) {
    run.warnedNoSessionId = true
    logLine(run, 
      'warn',
      `dsh-status-turbo: agent/request 的 payload.agent 上取不到会话 id（tracker 有 ${tracker ? tracker.size : 0} 条轨迹），B1 按步降档失效 —— 状态条不受影响`,
    )
  }
  return null
}

/**
 * 一个请求的换挡决策。**任何不确定都返回原配置**。
 *
 * 已实现的不变量：
 *   - 只降不升：由 `pickLowerEffort` 结构保证（返回 null 或严格更低的档）；
 *   - 绝不产生该模型不支持的档位：目标档位只会从它自己公布的列表里取下标；
 *   - 新回合清零、写入类工具或任何报错立刻打断连续段（见 gears.js）。
 */
async function decideGear(run, { llm, tracker, gears, payload, resolved }) {
  if (!resolved || typeof resolved !== 'object') return resolved

  const id = sessionIdOf(run, payload, tracker)
  if (id === null) return resolved

  const rec = tracker.get(id)
  if (!rec) return resolved
  if (!judgeDowngrade(rec, { minQuietSteps: gears.minQuietSteps })) return resolved

  const info = await llm.resolveModelInfo(resolved.provider, resolved.model, payload && payload.signal)
  const reasoning = info ? info.reasoning : undefined
  const efforts = reasoning ? reasoning.efforts : undefined

  // 当前档：优先用本次请求显式带上的档位；没有就退到该模型公布的默认档。
  // 两者都拿不到 → 不知道该往哪降，原样放过。
  let current = typeof resolved.reasoningEffort === 'string' && resolved.reasoningEffort !== '' ? resolved.reasoningEffort : null
  if (current === null && reasoning && typeof reasoning.defaultEffort === 'string') current = reasoning.defaultEffort
  if (current === null) return resolved

  const target = pickLowerEffort(efforts, current, gears.floor)
  if (target === null) return resolved

  logLine(run, 
    'info',
    `B1 降档：${resolved.provider}/${resolved.model} ${current} → ${target}（连续 ≥${gears.minQuietSteps} 步只读且无报错；出现写入或报错会立刻回原档）`,
  )
  return { ...resolved, reasoningEffort: target }
}

// ---------------------------------------------------------------------------
// 支柱 B3 / C2 / C3 / C1：工具返回钩子（PLAN.md §3.4 合并契约）
// ---------------------------------------------------------------------------

/** PLAN.md §3.4：B3 的通知块 + C 段的一个文案块，一共最多 4 个追加块。 */
const MAX_APPEND_BLOCKS = 4

/** D 段"同一件事重复了这么多次"的提醒文案（PLAN.md §3.7 · nudge，显式配置才可能到达）。 */
const STUCK_NUDGE_NOTE = (count) =>
  `（dsh-status-turbo：同一个工具、同一组参数已经连续跑了 ${count} 次，看起来是卡住了。` +
  '先换条路：收窄过滤条件、换工具，或者把已经确认的结论先写下来再继续。）'

/**
 * 取会话 id —— 运行时表（hookFaults / lastSpill）的键必须与 `state.sessionId` 相等
 * （PLAN.md §3.8；lib/state.js @ :508 的注释）。
 *
 * 为什么按这个顺序、而不是照抄 `exec.agent.session.header.id`：
 *   - 声明的 `ToolExecutionInput.agent?: Agent` 里 **只有 `readonly id: SessionId`**，
 *     `.session` 并未声明；照抄会在声明层面就站不住（T05 派工书已实证纠正）；
 *   - 但真实实现里 `Session.id` 就是 `this.header.id`（实读
 *     `packages/core/session/src/index.ts:446-448`：`get id(): SessionId { return this.header.id }`），
 *     且 `@deepseek-ai/dsh-agent` 校验 `agent.id === agent.session.id`（lib/index.js @ :182-183）。
 *     三条路径取值相同，所以优先声明的 `agent.id`、再退运行时路径，最后才碰 header。
 *
 * 三条都拿不到：只告一次警（否则 hookFaults 会静默写到一个 wire 视图永远读不到的键上），
 * 返回 null ⇒ 调用方跳过这条 fault 的写表（pushHookFault(null, …) 本身是 no-op）。
 */
function hookSessionIdOf(run, exec) {
  try {
    const agent = exec === null || exec === undefined ? undefined : exec.agent
    if (agent) {
      if (typeof agent.id === 'string' && agent.id !== '') return agent.id
      const session = agent.session
      if (session && typeof session.id === 'string' && session.id !== '') return session.id
      if (session && session.header && typeof session.header.id === 'string' && session.header.id !== '') {
        return session.header.id
      }
    }
  } catch (error) {
    if (!run.warnedNoHookSessionId) {
      run.warnedNoHookSessionId = true
      logLine(run, 'warn', `dsh-status-turbo: 读取会话 id 抛错，hookFaults 与 lastSpill 本次不上报（状态条不受影响）：${messageOf(error)}`)
    }
    return null
  }
  if (!run.warnedNoHookSessionId) {
    run.warnedNoHookSessionId = true
    logLine(run, 
      'warn',
      'dsh-status-turbo: 工具返回钩子的 exec.agent 上取不到会话 id，本次起 hookFaults 与 lastSpill 不上报（状态条不受影响）',
    )
  }
  return null
}

/** 统一取错误文案；绝不因为"异常本身长得怪"而二次抛错。 */
function messageOf(error) {
  if (error !== null && error !== undefined && typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * 某一段抛错时的唯一出口（PLAN.md §4.2 的双通道，G3）：
 *   ① 写进模块级 per-session 运行时表 ⇒ wire `hookFaults` ⇒ 错误 pill；
 *   ② 同时留一条具名 warn 日志。
 *
 * **绝不往上抛**：`dsh-tools` 把监听器抛出的异常记成这次工具调用 `isError`
 * （`dsh-tools/lib/index.js:3497-3506` 逐字 "a throwing listener → isError"），
 * 会把一次成功的工具调用污染成失败。
 */
function recordHookFault(run, sessionId, hook, error) {
  const message = messageOf(error)
  pushHookFault(sessionId, { at: Date.now(), hook, message })
  logLine(run, 'warn', `dsh-status-turbo: ${hook} 段异常，本次返回按原样通过（已记入 hookFaults）：${message}`)
  return message
}

/**
 * 工具返回钩子：`async (exec, result, next) => PostToolDecision`（PLAN.md §3.4）。
 *
 * 三条铁律：
 *   ① 只返回 `accept`，从不 `block`，从不构造新的 `additionalContexts`（只在透传链上已有值时原样带走）；
 *   ② 追加文本一律走 `content`；
 *   ③ 什么都没触发时返回 `decision` **原对象**（引用相等，R3 的同引用契约）。
 */
async function onPostExecute(run, exec, result, next) {
  const decision = await next()

  // 非 accept（block / replace…）或带 `value` 的裁决不是我们的领域：原样返回，一个字都不碰。
  if (decision === null || typeof decision !== 'object') return decision
  if (decision.kind !== 'accept') return decision
  if (Object.hasOwn(decision, 'value')) return decision

  const sessionId = hookSessionIdOf(run, exec)

  // ---- 0.6.4：工具增强层在位与否（**不是故障**） ------------------------------
  // 探测本身吞掉一切异常：它只喂给面板一行灰色 info，绝不能因为探测让这次工具调用变红。
  // 缺席（preset 把 toolResultPruner 隔离在组内）是设计，不进 hookFaults。
  if (sessionId !== null) {
    try {
      pushEnhancement(sessionId, enhancementOf(run.ctx))
    } catch {
      /* 探测失败 ⇒ 保持缺省「在位」，不给用户看无意义的黄/红。 */
    }
  }

  // content 的来处：decision 自己给了就用它，否则用宿主规范化之后的 result.content。
  let content = Object.hasOwn(decision, 'content') ? decision.content : result ? result.content : undefined
  let replaced = Object.hasOwn(decision, 'content')
  let changed = false
  let added = 0
  let spilled = false

  /** 追加一个块。超过 MAX_APPEND_BLOCKS 就到此为止（不是静默失败：这是契约给的额度）。 */
  const appendBlock = (block) => {
    if (added >= MAX_APPEND_BLOCKS) return false
    const base = Array.isArray(content) ? content : []
    content = [...base, block]
    replaced = true
    changed = true
    added += 1
    return true
  }

  // ---- B3：结果瘦身（先做，它的通知块要占住 content 的尾部） -------------------
  // 裁决 A：`spillOnce` 返回 null 时 content **一字不改**（降级路径已由它自己产出 fault）。
  try {
    const r = await spillOnce(run.ctx, exec, result, run.effective, (fault) => pushHookFault(sessionId, fault))
    if (r !== null) {
      const base = Array.isArray(content) ? content : []
      content = replaced ? [...base, r.notice] : [...r.pruned, r.notice]
      replaced = true
      changed = true
      added += 1
      // B3 命中 ⇒ 这次返回已经被瘦身，C3-b 的噪声统计不再有意义（PLAN.md §3.4 @ 319）。
      spilled = true
      pushSpill(sessionId, { bytes: r.bytes, locator: r.locator, at: Date.now() })
    }
  } catch (error) {
    recordHookFault(run, sessionId, 'spill', error)
  }

  // ---- C2 → C3-a → C3-b → C1：文案层（判定表在 ./notes.js，本层只负责接线） -----
  // 必须把 faults 收集器传进去：传了数组时 collectNotes 会 push 并返回 null，
  // **不会**把 fault 当成内容块交回来（否则模型的工具返回里会多出一条内部异常文本）。
  try {
    const faults = []
    const note = collectNotes(exec, result, spilled ? { ...run.effective, spilled: true } : run.effective, faults)
    for (const fault of faults) pushHookFault(sessionId, fault)
    if (note !== null && !isHookFault(note)) appendBlock(note)
  } catch (error) {
    recordHookFault(run, sessionId, 'notes', error)
  }

  // ---- D：卡住分级（默认 'warn' ⇒ 本段零副作用，O12） --------------------------
  try {
    const nudge = await planStuckAction(run, sessionId, exec)
    if (nudge !== null) appendBlock(nudge)
  } catch (error) {
    recordHookFault(run, sessionId, 'stuck', error)
  }

  // 全不触发 ⇒ 返回同一个对象引用（这是契约，不是优化）。
  if (!changed) return decision
  return {
    kind: 'accept',
    content: content === undefined ? [] : content,
    ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
  }
}

// ---------------------------------------------------------------------------
// 支柱 D：卡住分级（PLAN.md §3.7）
// ---------------------------------------------------------------------------

/** 卡住计数表的会话上限（表本身挂在 `run.stuckRuns`；超上限按插入序淘汰最旧的一条）。 */
const MAX_STUCK_SESSIONS = 128

function noteStuckRun(run, sessionId, key) {
  if (sessionId === null || sessionId === undefined) return 0
  const rec = run.stuckRuns.get(sessionId)
  if (rec !== undefined && rec.key === key) {
    rec.count += 1
    return rec.count
  }
  if (run.stuckRuns.size >= MAX_STUCK_SESSIONS && !run.stuckRuns.has(sessionId)) {
    const oldest = run.stuckRuns.keys().next()
    if (oldest.done !== true) run.stuckRuns.delete(oldest.value)
  }
  run.stuckRuns.set(sessionId, { key, count: 1 })
  return 1
}

/**
 * D 的 action 分级。**默认 'warn' 时本函数读完配置就返回，零副作用**（O12）。
 *
 * 分级表（PLAN.md §3.7 @ :441-443）：
 *   - `'warn'`（默认）：只写状态 —— 告警 pill 与「无进展」判据由 A3 通道承担，
 *     本层一个字都不加、不 emit、不调 waterfall；
 *   - `'nudge'`：**显式配置**才可能触发；往本次返回的 content 末尾追加一条系统提醒
 *     （不新增往返，O4）；
 *   - `'stop'`：**显式配置** + `workspace/session-activity` 返回**非空**才
 *     `emit('workspace/session-stop')`。会杀掉用户可能正在等的长任务（如整夜构建）。
 *
 * 触发判据只取本层看得见的那一半：连续同一 `aggregateKey` 达到 `stuckRepeats`。
 * `stuckRounds` 的 turn/end 窗口本层看不到（post-execute 只见单次调用），
 * 这里**不自造第二套判据** —— 看不见就是不判，宁可少提醒。
 *
 * @returns {Promise<{type:'text',text:string}|null>} nudge 要追加的块；其余一律 null。
 */
async function planStuckAction(run, sessionId, exec) {
  const action = run.effective.stuckAction
  if (action !== 'nudge' && action !== 'stop') return null

  const repeats = Number.isSafeInteger(run.effective.stuckRepeats) && run.effective.stuckRepeats > 0 ? run.effective.stuckRepeats : 3
  const name = exec !== null && exec !== undefined && typeof exec.name === 'string' ? exec.name : ''
  const count = noteStuckRun(run, sessionId, aggregateKey(name, argumentsOf(exec)))
  if (count < repeats) return null

  const request = { sessionId }

  if (action === 'nudge') {
    logLine(run, 'info', `D 提醒（stuckAction=nudge）：会话 ${sessionId} 连续 ${count} 次同一件事（${name}）`)
    return { type: 'text', text: STUCK_NUDGE_NOTE(count) }
  }

  // stop：先确认"还有活动"再动手。cordis 的 waterfall(name, …, next) 里最后一个参数是
  // **兜底实现**（实读 `packages/session/session-telemetry/src/coordinator.ts:214`
  // 的 `this.ctx.waterfall('session-telemetry/record', record, () => record)`），
  // 这里给 `() => []`：没有监听者 ⇒ 没有已知活动 ⇒ **不** emit（fail-closed）。
  if (typeof run.ctx.waterfall !== 'function') {
    logLine(run, 'warn', 'dsh-status-turbo: ctx.waterfall 不可用，stuckAction=stop 本次不执行（不静默：这里是显式 warn）')
    return null
  }
  const activity = await run.ctx.waterfall('workspace/session-activity', request, () => [])
  if (!Array.isArray(activity) || activity.length === 0) {
    logLine(run, 'info', `D 不打断（stuckAction=stop）：会话 ${sessionId} 连续 ${count} 次同一件事，但没有查到还在跑的活动`)
    return null
  }
  if (typeof run.ctx.emit !== 'function') {
    logLine(run, 'warn', 'dsh-status-turbo: ctx.emit 不可用，stuckAction=stop 本次不执行（不静默：这里是显式 warn）')
    return null
  }
  logLine(run, 'warn', `D 停止（stuckAction=stop）：会话 ${sessionId} 连续 ${count} 次同一件事且仍有 ${activity.length} 项活动，发出 workspace/session-stop`)
  run.ctx.emit('workspace/session-stop', request)
  return null
}

/**
 * 只为可测：两半主链的接线函数与宿主 I/O 出口都在模块作用域里，测试取不到就只能测替身。
 *
 * 交接导出的执行编排（起进程、写 `.gitignore`、记终态、进程上限）此前在测试里是 0 次执行 ——
 * 本次事故是同类第三次。测试整组替换 `hostIo` 的成员即可驱动真分支，不需要真的起 bili。
 * 宿主不认识这个导出（`inject` 里没有它），插件接线也不读它。
 */
/**
 * 测试用的一次挂载状态：`ctx = null`（日志落 console），`io` 仍是**同一个** `hostIo` ——
 * 测试整组替换它的成员即可驱动真分支。它是本模块唯一的模块级可变状态，只在测试缝里用
 * （宿主路径全靠 `apply` 建的那个 `run`），所以同样是「每进程一个」。
 */
const testRun = createRun(null, DEFAULT_CONFIG)

/**
 * 测试缝要用的宿主侧状态：挂过载就用**最近一次挂载**的那份（S6 的 teardown 必须收到真挂载
 * 起过的子进程句柄、P1-3 的目录缓存必须随每次挂载各一份），没挂过就用合成 run。
 *
 * @returns {object} `createRun` 造出来的宿主侧状态。
 */
function runFor() {
  return lastRun === null ? testRun : lastRun
}

export const __test = {
  run: testRun,
  noteHandoff: (state, config, event) => noteHandoff(runFor(), state, config, event),
  noteRotation: (state, config, event) => noteRotation(runFor(), state, config, event),
  /** 可选服务的取法（`ctx.get` 优先、属性访问兜底）：0.17.1 起轮换靠它拿 `sessions`。 */
  serviceOf,
  hostIo,
  /** 本次挂载已起的导出进程数（只读）：核对进程上限时不用猜基准。 */
  handoffSpawns: () => runFor().handoffSpawns,
  /** 本次挂载为读车道列表起的进程数（只读，S10）。 */
  laneReads: () => runFor().laneReads,
  /** 本次挂载起过的交接进程总数（导出 + 车道列表读取，S10 的上限口径）。 */
  handoffProcessCount: () => handoffProcessCount(runFor()),
}

