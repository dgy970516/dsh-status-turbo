/**
 * dsh-status-turbo —— 到量轮换的**宿主动作**（0.9.0 · 方案 B）。
 *
 * 为什么从 `fork` 改成「建空白会话」：
 * `ctx.sessions.fork` 会把旧会话的整份历史复制成新会话的种子日志 —— 那既不减少上下文，
 * 也不改变"下一轮请求仍然背着全部历史"的事实，只是把同样的积压换了个会话 id。
 * 方案 B 反过来：新会话从**零历史**开始；0.21.1 起连开场话术都不自动写
 * （用户 m08927：「这个应该改成手动复制」），旧会话 id 由用户点状态条的「复制话术」手动带过去。
 *
 * 本模块**只做被注入的 I/O**，判据全在 `./rotation.js · shouldRotate`：
 *  - 不 import 任何外部依赖、**不碰时间**（`now` 由调用方传入）、不 import DSH 类型；
 *  - `sessions` 由调用方注入（宿主传 `ctx.sessions`，测试传真值/假值）；
 *  - **绝不抛**：所有失败都收敛成 `status='idle'` + 稳定 `message` code，或 `status='armed'` + 补名失败时的 `titleReason`。
 */

import { randomUUID } from 'node:crypto'
import {
  ROTATION_MESSAGE,
  ROTATION_STATUS, increasedRotationTitle, rotationIncreaseTitleEnabled,
  rotationMode,
  rotationPlan,
  rotationSeedText,
  shouldRotate,
} from './rotation.js'

/**
 * 生成新会话 id。零依赖：`node:crypto` 的 `randomUUID()`（宿主已在 `lib/index.js` 注入同一实现）。
 *
 * @returns {string}
 */
export function newChildId() {
  return `session-${randomUUID()}`
}

/**
 * 建新会话时写进 header 的元数据；`parentSession` 让谱系可查，`cwd` 让新会话落在同一个工作目录，
 * `agentPreset`（0.12.0：名册按角色配的预设）只在非空时写，空则让宿主用它自己的默认。
 *
 * @param {object} input
 * @param {string} input.cwd 旧会话的绝对工作目录（调用方已保证非空）。
 * @param {string} input.sessionId 旧会话 id。
 * @param {string} [input.preset] 该角色位配置的 Agent 预设 id（空串＝不指定）。
 * @returns {{cwd: string, parentSession: string, agentPreset?: string}}
 */
function childMeta({ cwd, sessionId, preset }) {
  return typeof preset === 'string' && preset !== '' ? { cwd, parentSession: sessionId, agentPreset: preset } : { cwd, parentSession: sessionId }
}

/**
 * 该值是不是可用的绝对路径 —— 直接照 DSH 自己的判据（`core/session/src/index.ts:113-115`：
 * `!isAbsolute(path)` 就抛）。这里不 import `node:path`，用一个等价的最小实现。
 *
 * @param {unknown} value 待判的值。
 * @returns {boolean}
 */
function isAbsolutePath(value) {
  if (typeof value !== 'string' || value === '') return false
  if (value.startsWith('/') || value.startsWith('\\')) return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * 在宿主里找这个会话**已经存在**的子会话（S3）。
 *
 * 宿主**没有**「按 parentSession 查子会话」的专用原语 —— `packages/core/session/src/index.ts` 只公开
 * `get(id)` / `list()` / `fork()`；但 `list()` 返回的每个 Session 都带 `header.parentSession`
 * （`create(id, { meta: { parentSession } })` 把父 id 写进 header），所以用公开面扫一遍即可。
 *
 * 为什么需要这层兜底：「每会话最多轮换一次」原先只押在投影账 `record.childId` 上，而账是进程内存，
 * 重启就没 —— 旧会话被重放时宿主里会留下第二个子会话。发现已有子会话就复用它，不再建第二个。
 *
 * 取**最后一个**匹配项：`list()` 按创建序返回，最后一个就是最近建的那个（用户手工 fork 出的子会话
 * 也带 `parentSession`，无法与轮换建的区分，按"最近"取一边）。
 *
 * @param {object|null} sessions 宿主 `ctx.sessions`。
 * @param {string} sessionId 旧会话 id。
 * @returns {string|null} 已有子会话的 id；没有、或 `list()` 不可用/抛错 ⇒ `null`。
 */
function existingChildOf(sessions, sessionId) {
  if (sessions === null || typeof sessions !== 'object' || typeof sessions.list !== 'function') return null
  let all = null
  try {
    all = sessions.list()
  } catch {
    return null // 查谱系失败等同于"查不到"：宁可照旧去建，也不因为查谱系中断轮换
  }
  if (!Array.isArray(all)) return null
  let found = null
  for (const session of all) {
    if (session === null || typeof session !== 'object') continue
    const header = session.header
    if (header === null || typeof header !== 'object') continue
    if (header.parentSession !== sessionId) continue
    if (typeof session.id === 'string' && session.id !== '') found = session.id
  }
  return found
}

/**
 * 走一遍到量轮换的宿主动作。**任何 I/O 失败都不抛**，全部落成返回值。
 *
 * 返回契约：
 *  - `status='armed'` + 非空 `childId`：新会话已建好（`reused=true` 表示复用了宿主里已有的子会话）；
 *  - `status='idle'` + `message`：没做（未触发 / 模式 off / 已完成过一次 / 建不了），`message` 是稳定 code；
 *  - `status='idle'` + `message=null`：本轮判据未通过（写入 `idle` 即可）。
 *  - `via='agents'` + 非空 `pending`：新会话由代理生命周期**异步**建出，调用方要等 `pending` 落地才有会话对象与补名/挂载结果。
 *
 * @param {object} input
 * @param {object} input.config 宿主合并后的配置。
 * @param {object|null} [input.record] 该会话当前的轮换记录（有 `childId` 就说明已做过一次）。
 * @param {string} input.sessionId 旧会话 id。
 * @param {string} [input.cwd] 旧会话的绝对工作目录（投影 `state.cwd`）；名册给角色位配了工作区时
 *   由调用方替换成那一个（0.12.0）。
 * @param {string} [input.preset] 名册给角色位配的 Agent 预设 id（0.12.0；空则用宿主默认）。
 * @param {string} input.phase 当前阶段。
 * @param {number} [input.inputTokens] 本步 `usage.inputTokens`。
 * @param {number} [input.payloadBytes] 该会话累计的模型可见体量（字节）。
 * @param {number} [input.contextWindow] 会话当前路由的上下文窗口。
 * @param {number} [input.lastArmedAt] 上次轮换的时间戳。
 * @param {number} input.now 当前时间（调用方传入 —— 本模块不碰时间）。
 * @param {object|null} [input.sessions] 宿主 `ctx.sessions`（同步建会话的退路）。
 * @param {object|null} [input.agents] 宿主 `ctx.agents`（0.19.0）：有它就走代理生命周期建会话 —— 只有生命周期里的会话会拿到持久化写句柄，才落盘、才在会话列表里可见。
 * @param {object|null} [input.workspaces] 宿主 `ctx.workspaceRegistry`（0.19.1）：建完会话后把子会话挂进旧会话所在的工作区 —— 工作区列表只列 `sessionIds` 里的会话，不挂就只在磁盘上、不在左侧列表里。
 * @param {object|null} [input.presets] 宿主 `ctx.agentPresets`（0.19.3）：有它就给子代理挂上和旧会话同一套 preset 组合。
 * @param {object|null} [input.agentOptions] 子代理的模型选择 `{provider, model}`（0.19.3）：缺席时子代理没有 model，系统提示段里的 `{{model}}` 渲染即抛错。
 * @param {object|null} [input.titles] 宿主 `ctx.sessionTitle`（0.20.0）：有它就给子会话补一个按旧会话标题 (N) 递增的名字。
 * @param {() => string} [input.randomId] 新会话 id 生成器（默认 `newChildId`）。
 * @returns {{status: string, at: number|null, childId: string|null, seedText: string, message: string|null, reused: boolean, via: string|null, pending: Promise<object|null>|null, titleOk: boolean|null, title: string|null, titleReason: string|null, plan: {sessionId: string, openChild: boolean, archiveOld: boolean}}}
 */
export function runRotationAction({
  config,
  record,
  sessionId,
  cwd,
  preset,
  phase,
  inputTokens,
  payloadBytes,
  contextWindow,
  lastArmedAt,
  now,
  agents,
  workspaces,
  presets,
  agentOptions,
  sessions,
  titles,
  randomId,
} = {}) {
  const source = config === null || typeof config !== 'object' ? {} : config
  const plan = rotationPlan(source, sessionId)

  if (rotationMode(source) === 'off') return idleResult({ sessionId, plan, message: ROTATION_MESSAGE.DISABLED })
  // 已经建过新会话（`childId` 在记录里）就不再建第二个 —— "每个会话最多做一次"。
  if (record !== null && typeof record === 'object' && typeof record.childId === 'string' && record.childId !== '') {
    return idleResult({ sessionId, plan, message: null })
  }
  // 没有绝对路径 cwd：`sessions.create` 会直接抛（`index.ts:113-115`），所以在这里就拦住并记原因。
  if (!isAbsolutePath(cwd)) return idleResult({ sessionId, plan, message: ROTATION_MESSAGE.NO_CWD })
  if (sessions === null || typeof sessions !== 'object' || typeof sessions.create !== 'function') {
    return idleResult({ sessionId, plan, message: ROTATION_MESSAGE.NO_SERVICE })
  }
  if (
    !shouldRotate({
      config: source,
      phase,
      inputTokens,
      payloadBytes,
      contextWindow,
      lastArmedAt,
      now,
    })
  ) {
    return idleResult({ sessionId, plan, message: null })
  }

  // S3：宿主里已经有这个会话的子会话（上次轮换留下的，而账已随进程消失）就复用它，不再建第二个。
  const existing = existingChildOf(sessions, sessionId)
  if (existing !== null) {
    return {
      status: ROTATION_STATUS.ARMED,
      at: Number.isFinite(now) ? now : null,
      childId: existing,
      titleOk: null,
      title: null,
      titleReason: null,
      seedText: '',
      message: null,
      reused: true,
      plan,
    }
  }

  const generate = typeof randomId === 'function' ? randomId : newChildId
  let childId = null
  try {
    childId = generate()
  } catch {
    // 生成器抛错（测试注入或平台的 randomUUID 不可用）：等同于建会话失败。
    childId = null
  }
  if (typeof childId !== 'string' || childId === '') {
    return idleResult({ sessionId, plan, message: ROTATION_MESSAGE.CREATE_FAILED })
  }

  const seedText = rotationSeedText({ config: source, oldId: sessionId, cwd })

  const created = createChildQuietly({ agents, sessions, workspaces, presets }, childId, { cwd, sessionId, preset, agentOptions })
  if (!created.ok) return idleResult({ sessionId, plan, message: ROTATION_MESSAGE.CREATE_FAILED })

  // 0.19.0：走代理生命周期建会话是**异步**的，会话对象要等它落地才拿得到；同步的 `sessions.create`
  // 退路当场就有会话对象。
  if (created.pending !== null) {
    return {
      status: ROTATION_STATUS.ARMED,
      at: Number.isFinite(now) ? now : null,
      childId,
      seedText,
      message: null,
      reused: false,
      via: 'agents',
      pending: created.pending.then(
        (session) => {
          // 0.20.0：建好顺手补名字 —— 空白子会话的标题本来只会是话术模板的回退截断，一代一个样。
          const titled = retitleQuietly({ titles, sessions }, session, sessionId, source)
          // 0.19.1：会话落盘还不够 —— 左侧列表按工作区的 `sessionIds` 列，不挂就看不见。
          return attachChildQuietly({ workspaces }, childId, cwd).then((attach) => ({
            ok: true,
            titleOk: titled.ok,
            title: titled.title,
            titleReason: titled.reason,
            attach,
            error: null,
          }))
        },
        (error) => {
          const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
          return { ok: false, attach: 'skipped', error: message }
        },
      ),
      plan,
    }
  }


  const titled = retitleQuietly({ titles, sessions }, created.session, sessionId, source)
  return {
    status: ROTATION_STATUS.ARMED,
    at: Number.isFinite(now) ? now : null,
    childId,
    titleOk: titled.ok,
    title: titled.title,
    titleReason: titled.reason,
    seedText,
    message: null,
    reused: false,
    plan,
  }
}

/**
 * 建空白会话；把 `sessions.create` 的抛错收敛成 `{ok:false}`。
 *
 * 调用形状（实读 `core/session/src/index.ts:830`）：`create(id, { meta })` 返回 Session 对象；
 * `meta` 支持 `cwd` / `parentSession` / `agentPreset`，未知键静默丢弃（`core/session/src/types.ts:113-121`）；
 * 重复 id 抛 `Error('session "..." already exists')`。
 *
 * @param {object} sessions 宿主 `ctx.sessions`。
 * @param {string} childId 新会话 id。
 * @param {{cwd: string, sessionId: string, preset?: string}} input 元数据来源。
 * @returns {{ok: boolean, session: object|null}}
 */
function createQuietly(sessions, childId, { cwd, sessionId, preset }) {
  try {
    const session = sessions.create(childId, { meta: childMeta({ cwd, sessionId, preset }) })
    // 把 thenable（内部会 `await sessions.create(...)` 的实现）判成失败：它此刻还没建好，
    // 而宿主调用方是同步的、不会 await，留下的 rejection 无人 catch（unhandled rejection）。
    if (session !== null && (typeof session === 'object' || typeof session === 'function') && typeof session.then === 'function') {
      try {
        session.then(undefined, () => {})
      } catch {
        // thenable 自身的 then 抛错同样意味着"没有建好的会话"，吞掉即可
      }
      return { ok: false, session: null }
    }
    return { ok: true, session: session !== null && typeof session === 'object' ? session : null }
  } catch {
    return { ok: false, session: null }
  }
}

/**
 * 建轮换子会话：优先走**代理生命周期**（`ctx.agents.create`），退回同步的 `ctx.sessions.create`。
 *
 * 0.19.0 的根因：`ctx.sessions.create` 是在代理生命周期之外“发布”一个会话，持久化层只给生命周期
 * 里的会话挂写句柄（`dsh-session` 原文：a session published outside that lifecycle persists
 * nothing），于是 0.17.x/0.18.x 建出来的子会话只活在内存 —— 磁盘上没有日志目录、会话列表里也
 * 看不到。`ctx.agents.create` 会构造并发布代理，写句柄随之挂上 ⇒ 会话落盘、可续、界面可见。
 *
 * @param {{agents?: object|null, sessions?: object|null, presets?: object|null}} io 宿主服务（都可缺席）。
 * @param {string} childId 新会话 id。
 * @param {{cwd: string, sessionId: string, preset?: string, agentOptions?: object|null}} input 元数据、preset 组合与模型选择的来源。
 * @returns {{ok: boolean, session: object|null, pending: Promise<object|null>|null}} `pending` 非空
 *   表示会话由代理生命周期异步建出，调用方要在它落地后再播种；`session` 仍可能是 `null`。
 */
function createChildQuietly(io, childId, { cwd, sessionId, preset, agentOptions }) {
  const safe = io !== null && io !== undefined && typeof io === 'object' ? io : {}
  const agents = safe.agents
  if (agents !== null && agents !== undefined && typeof agents.create === 'function') {
    try {
      const request = { sessionId: childId, meta: childMeta({ cwd, sessionId, preset }) }
      // 0.19.3：不给模型选择，子代理就没有 provider/model —— 系统提示的 `{{model}}` 段渲染即抛错
      // （`dsh-agent-loop/lib/index.js:1565` 从 `agent.options` 取这两个值）。
      if (agentOptions !== null && agentOptions !== undefined && typeof agentOptions === 'object') {
        request.agentOptions = agentOptions
      }
      const presets = safe.presets
      if (
        typeof preset === 'string' &&
        preset !== '' &&
        presets !== null &&
        presets !== undefined &&
        typeof presets.mount === 'function'
      ) {
        // 和宿主自己建会话一样把 preset 组合挂进子代理（`dsh-webhook/lib/types/session.js:157-160`）。
        request.setup = async (agentCtx) => {
          try {
            await presets.mount(agentCtx, preset)
          } catch {
            // 组合挂不上只让子会话少一套 preset，不拦轮换：会话本身已经建出来了。
          }
        }
      }
      const created = agents.create(request)
      const thenable = created !== null && (typeof created === 'object' || typeof created === 'function') && typeof created.then === 'function'
      if (thenable) {
        return {
          ok: true,
          session: null,
          pending: created.then(
            (result) => {
              const agent = result !== null && typeof result === 'object' ? result.agent : null
              const fromStore = sessionOf(safe.sessions, childId)
              if (fromStore !== null) return fromStore
              return agent !== null && agent !== undefined && typeof agent === 'object' && agent.session !== undefined ? agent.session : null
            },
            () => null,
          ),
        }
      }
    } catch {
      // 代理生命周期这条路走不通（服务形态变了 / id 撞车）：落到同步的 `sessions.create`。
    }
  }
  const fallback = createQuietly(safe.sessions === undefined ? null : safe.sessions, childId, { cwd, sessionId, preset })
  return { ok: fallback.ok, session: fallback.session, pending: null }
}

/**
 * 把新子会话挂进它工作目录对应的那个工作区；**绝不抛**，结果收敛成稳定的状态串。
 *
 * 为什么要挂（0.19.1 的现场根因）：左侧会话列表按工作区记录里的 `sessionIds` 列，落盘只是"磁盘上有"，
 * 不在 `sessionIds` 里就**不进列表**。宿主自己的 fork 就是这么做的（实读
 * `dsh-api-session-controller/lib/index.js:829-836`：`await workspace.attachSession(childId)`）。
 * `attachSession` 自己会核对该会话 header 的 `cwd` 是否解析到工作区路径
 * （`dsh-workspace/lib/index.js:111-129`），不合就抛 —— 我们只报状态、不拦轮换。
 *
 * @param {{workspaces?: object|null}} io 宿主 `ctx.workspaceRegistry`（可缺席）。
 * @param {string} childId 新会话 id。
 * @param {string} cwd 新会话的工作目录（旧会话的 cwd）。
 * @returns {Promise<string>} `'attached'` / `'no-registry'` / `'no-workspace'` / `'resolve-failed'` / `'attach-failed'`。
 */
function attachChildQuietly(io, childId, cwd) {
  const safe = io !== null && io !== undefined && typeof io === 'object' ? io : {}
  const registry = safe.workspaces
  if (registry === null || registry === undefined || typeof registry.resolveByPath !== 'function') {
    return Promise.resolve('no-registry')
  }
  return Promise.resolve()
    .then(() => registry.resolveByPath(cwd))
    .then((workspace) => {
      if (workspace === null || workspace === undefined || typeof workspace.attachSession !== 'function') return 'no-workspace'
      return Promise.resolve(workspace.attachSession(childId)).then(
        () => 'attached',
        () => 'attach-failed',
      )
    })
    .catch(() => 'resolve-failed')
}

/**
 * 读一个会话的持久化标题；服务缺席 / 抛错 / 没标题都返回 null。
 *
 * @param {object|null} titles sessionTitle 服务（可为 null）。
 * @param {object|null} session 会话对象。
 * @returns {string|null} 标题。
 */
function readTitleQuietly(titles, session) {
  if (titles === null || titles === undefined || typeof titles.get !== 'function') return null
  try {
    const snapshot = titles.get(session)
    if (snapshot === null || snapshot === undefined) return null
    return typeof snapshot.title === 'string' ? snapshot.title : null
  } catch {
    return null
  }
}

/**
 * 挑一个能交给 `sessionTitle.rename` 的会话对象。
 *
 * rename 会核对「传进来的会话是不是本 store 里活着的那个」（服务内部断言），所以能用
 * `sessions.get(id)` 拿真身就拿真身，拿不到才退回传入对象（并确认它至少像会话）。
 *
 * @param {object|null} sessions ctx.sessions（可为 null）。
 * @param {object|null} session 候选会话对象。
 * @returns {object|null} 可用于改名的会话对象。
 */
function resolveTitleTarget(sessions, session) {
  if (session === null || session === undefined) return null
  const id = typeof session.id === 'string' ? session.id : null
  if (id !== null) {
    const live = sessionOf(sessions, id)
    if (live !== null) return live
  }
  return typeof session.append === 'function' ? session : null
}

/**
 * 给刚建好的子会话改名：按旧会话标题 `(N)` 递增（0.20.0，`rotationIncreaseTitle` 为真时）。
 *
 * 只做尽力而为 —— 没注入 `sessionTitle`、旧会话没标题、拿不到会话对象、服务拒绝，
 * 一律收敛成 `{ ok: false, reason }`，绝不抛，也绝不影响建会话与写种子。
 *
 * @param {{titles?: object|null, sessions?: object|null}} io 注入的服务。
 * @param {object|null} session 子会话对象。
 * @param {string} parentId 旧（父）会话 id。
 * @param {object|null} config 生效配置。
 * @returns {{ok: boolean, title: string|null, reason: string|null}} 结果。
 */
function retitleQuietly(io, session, parentId, config) {
  const titles = io === null || io === undefined || io.titles === undefined ? null : io.titles
  if (titles === null || titles === undefined || typeof titles.rename !== 'function') {
    return { ok: false, title: null, reason: 'no-service' }
  }
  if (!rotationIncreaseTitleEnabled(config)) return { ok: false, title: null, reason: 'disabled' }
  const sessions = io.sessions === undefined ? null : io.sessions
  const parent = sessionOf(sessions, parentId)
  const next = increasedRotationTitle(readTitleQuietly(titles, parent))
  if (next === null) return { ok: false, title: null, reason: 'no-title' }
  const target = resolveTitleTarget(sessions, session)
  if (target === null) return { ok: false, title: null, reason: 'no-child' }
  try {
    titles.rename(target, next)
    return { ok: true, title: next, reason: null }
  } catch (error) {
    const reason = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
    return { ok: false, title: null, reason }
  }
}
/**
 * 从 `ctx.sessions` 里按 id 取会话对象；服务缺席、方法缺失或抛错都返回 null。
 *
 * @param {object|null|undefined} sessions 宿主 `ctx.sessions`。
 * @param {string} childId 会话 id。
 * @returns {object|null} 会话对象或 null。
 */
function sessionOf(sessions, childId) {
  if (sessions === null || sessions === undefined || typeof sessions !== 'object' || typeof sessions.get !== 'function') return null
  try {
    const found = sessions.get(childId)
    return found === undefined || found === null ? null : found
  } catch {
    return null
  }
}

/**
 * 统一的"没做"返回值。
 *
 * @param {{sessionId: string, plan: object, message: string|null}} input
 * @returns {object}
 */
function idleResult({ sessionId, plan, message }) {
  return { status: ROTATION_STATUS.IDLE, at: null, childId: null, seedText: '', message, reused: false, plan }
}
