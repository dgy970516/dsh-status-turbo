/**
 * dsh-status-turbo —— 到量自动轮换（0.9.0）的纯逻辑。
 *
 * 用户诉求（m00940）：「到了对应的量就应该开一个新的会话 并引用旧会话的会话 id，并且归档旧会话」。
 *
 * 0.9.0 起**废掉 `fork`**：`ctx.sessions.fork` 会把整份旧历史当种子复制进新会话，恰恰不解决上下文积压。
 * 新形态（方案 B）是「宿主建**空白**会话 + 把旧会话 id 写进它的第一条消息」，见 `./rotation-host.js`。
 *
 * 官方 API（实读 `D:\deepseek-harness\packages\`，行号可查）：
 *  - `ctx.sessions.create(id, { meta: { cwd, parentSession } })` —— 建空白会话，返回 Session
 *    （`core/session/src/index.ts:830`；`meta` 字段 `core/session/src/types.ts:113-121`）。
 *  - `session.append('user/message', msg, { surfaceOp: 'append' })`（`core/session/src/index.ts:604-608`）。
 *  - `ctx.sessions.open(childId)`（`client/ui-workspace/src/client/index.ts:77`）。
 *  - `ctx.workspaces.archiveSession(id)`（`client/runtime/src/client/workspaces/service.ts:290`）。
 *
 * 纪律同 `lib/handoff.js`：不 import 外部依赖、**不碰时间**（`now` 由调用方传入）、不直接做 I/O。
 */

import { DEFAULT_CONFIG } from './state.js'
import { effectiveByteThreshold, effectiveThreshold, nonNegativeInt } from './handoff.js'

/**
 * 运行时表里 `rotation` 字段的状态机（wire 契约的一部分，客户端按它渲染）。
 *
 * `unavailable` 与 `HANDOFF_STATUS.UNAVAILABLE` 同一个意思：**缺席不是故障** ——
 * 判据已经通过、但宿主建不了新会话（没有绝对路径 `cwd` / 没有 `sessions` 服务 / `create` 被拒），
 * 面板据此显示原因，绝不进 `hookFaults`。它也不是终态：`cwd` 后补上或服务恢复后，
 * 下一次折叠会重新尝试（只有落下 `childId` 才算做过一次）。
 */
export const ROTATION_STATUS = Object.freeze({
  OFF: 'off',
  IDLE: 'idle',
  /** 0.20.0：判据已通过，但按配置**只提醒不建会话**（`rotationCreate: false`，出厂默认）。 */
  REMIND: 'remind',
  ARMED: 'armed',
  UNAVAILABLE: 'unavailable',
})

/** 轮换模式；不是 `off`/`manual`/`auto` 就回落 `DEFAULT_CONFIG.rotation`。 */
export function rotationMode(config) {
  const raw = config === null || typeof config !== 'object' ? undefined : config.rotation
  if (raw === 'off' || raw === 'manual' || raw === 'auto') return raw
  return DEFAULT_CONFIG.rotation
}

/**
 * 0.9.2：是否要求会话空闲（`phase === 'idle'`）才建新会话。**只有字面量 `true` 才算打开**，
 * 其余（含脏值）一律按默认 `false` 处理 —— `DEFAULT_CONFIG.rotationRequireIdle` 的理由见那里。
 */
function requiresIdle(config) {
  return config !== null && typeof config === 'object' && config.rotationRequireIdle === true
}

/**
 * 0.20.0：到量时是否**真的建新会话**。只有字面量 `true` 才算开 —— 与 `requiresIdle` 同理：
 * 建会话是有副作用的动作，读不懂的值一律按"只提醒"处理，绝不因为脏值把它打开。
 */
export function rotationCreates(config) {
  return config !== null && typeof config === 'object' && config.rotationCreate === true
}

/**
 * `rotation.message` 用的**稳定 code**（0.9.0）：面板按 locale 渲染（`lib/client.js · rotationSection`），
 * 所以这里不能塞中文句子 —— 与 `HANDOFF_MESSAGE`（`lib/handoff.js:250`）同一套路。
 *
 * 客户端对**未知** code 一律原样显示 ⇒ 宿主与客户端可以各自演进，也不会把原因吞掉。
 */
export const ROTATION_MESSAGE = Object.freeze({
  /** `rotation: 'off'`：什么都没做。 */
  DISABLED: 'disabled',
  /** 投影里没有绝对路径 `cwd` —— 建不了会话（`create` 只收绝对路径）。 */
  NO_CWD: 'no-cwd',
  /** 宿主上下文里没有 `sessions` 服务。 */
  NO_SERVICE: 'no-service',
  /** `ctx.sessions.create` 抛错（id 撞车或 cwd 被拒）。 */
  CREATE_FAILED: 'create-failed',
  /** 会话建好了，但首条 `user/message` 没写进去。 */
})

/**
 * 到量判据（纯函数）。四个条件**同时**成立才 `true`：
 *
 *  1. 模式不是 `off`；
 *  2. 阈值满足 —— token 口径**或**字节口径先到先得（复用 0.7.x 那两个口径与同一套旋钮）。
 *     ⚠️ **P1-10 · 共用阈值（有意为之，改名会破坏兼容）**：这里读的
 *     `handoffExportTokens` / `handoffExportBytes` / `handoffExportWindowPercent`
 *     同时驱动**交接文档导出**（`./handoff.js · shouldExport`：把上下文写进一份 markdown）
 *     和**到量轮换**（本函数：新开一个会话继续干）。两个动作的触发点相同是有意的 ——
 *     它们是同一件事（上下文到量）的两种应对，用户调一个旋钮就该同时移动两条线。
 *     代价：想只调其中一条得改代码；不提供第二套键是为了不让"到量"出现两个互相矛盾的真相。
 *  3. 若 `rotationRequireIdle` 为 `true`：**本会话当前没有开放轮次**（`phase === 'idle'`）——
 *     0.8.0 的理由是 `fork` 要求种子前缀结束在开放轮次之外。**0.9.2 起默认 `false`（不再要求）**：
 *     0.9.0 就不 fork 了，而建一个空白新会话也不会打断正在跑的回合（不搬上下文，切换时机是
 *     客户端的事 —— 客户端自己等会话空闲再 `sessions.open`）；硬要求空闲的实测后果是永远不空闲
 *     的会话一个也轮换不了（4.32 MB、181 步那条）。要老行为就把它设成 `true`；
 *  4. 距上次轮换已过 `rotationCooldownMs`（防连环轮换）。
 *
 * @param {object} input
 * @param {object} input.config 宿主合并后的配置。
 * @param {string} input.phase 当前阶段（本插件的 `PHASES.IDLE` 值是 `'idle'`）。
 * @param {number} [input.inputTokens] 本步 `usage.inputTokens`。
 * @param {number} [input.payloadBytes] 该会话累计的模型可见体量（字节）。
 * @param {number} [input.contextWindow] 会话当前路由的上下文窗口（日志派生，可缺）。
 * @param {number} [input.lastArmedAt] 上次轮换的时间戳（无则视为从未）。
 * @param {number} input.now 当前时间（调用方传入 —— 本模块不碰时间）。
 * @returns {boolean}
 */
export function shouldRotate({ config, phase, inputTokens, payloadBytes, contextWindow, lastArmedAt, now }) {
  if (rotationMode(config) === 'off') return false
  if (requiresIdle(config) && phase !== 'idle') return false

  const tokenHit = Number.isFinite(inputTokens) && inputTokens >= effectiveThreshold({ config, contextWindow })
  const byteHit = Number.isFinite(payloadBytes) && payloadBytes >= effectiveByteThreshold({ config, contextWindow })
  if (!tokenHit && !byteHit) return false

  const cooldown = nonNegativeInt(config && config.rotationCooldownMs, 'rotationCooldownMs')
  if (Number.isFinite(lastArmedAt) && Number.isFinite(now) && now - lastArmedAt < cooldown) return false
  return true
}

/**
 * 客户端要执行的动作单（0.9.0：建会话已归宿主，客户端只剩 `open`）。
 *
 *  1. 宿主建好空白新会话（0.21.1 起建完不写任何消息）并把 `childId` 写进轮换记录；
 *  2. 若 `openChild` ⇒ 客户端 `sessions.open(childId)` 切过去；
 *  3. 若 `archiveOld` ⇒ 切换成功后 `workspaces.archiveSession(sessionId)` 归档旧的。
 *
 * 两个开关的缺省都取自 `DEFAULT_CONFIG`（**唯一来源**）：`openChild` 默认 true，
 * `archiveOld` 默认 false —— 0.8.1 定下的理由不变：开场话术里让模型用 `@<旧id>` 去查旧会话
 * （0.21.1 起那段话术由人粘贴，道理一样），
 * 而 `@` 引用与侧边栏读同一份列表投影，归档即失效。
 *
 * 0.9.0 不再 fork ⇒ 0.8.0 的 `increaseTitle` 失去载具，键已删。
 * 0.20.0：键复活 —— 0.9.0 的结论是「没有 fork 就没有消费者」，现在宿主自己就是消费者：
 * 空白子会话建好后按旧会话标题 `(N)` 递增补一个名字（`./rotation-host.js · retitleQuietly`）。
 *
 * @param {object} config 宿主合并后的配置。
 * @param {string} sessionId 当前会话 id（要归档的对象）。
 * @returns {{sessionId: string, openChild: boolean, archiveOld: boolean}}
 */
export function rotationPlan(config, sessionId) {
  const source = config === null || typeof config !== 'object' ? {} : config
  const openChildDefault = DEFAULT_CONFIG.rotationOpenChild !== false
  const archiveOldDefault = DEFAULT_CONFIG.rotationArchiveOld === true
  return {
    sessionId,
    openChild: typeof source.rotationOpenChild === 'boolean' ? source.rotationOpenChild : openChildDefault,
    archiveOld: typeof source.rotationArchiveOld === 'boolean' ? source.rotationArchiveOld : archiveOldDefault,
  }
}

/**
 * 新会话首条消息的正文（0.9.0）—— **这是"把旧会话 id 放过去"的落点**。
 *
 * 为什么要有一条消息而不是只靠 header 元数据：`parentSession` 只是持久化谱系，
 * 不保证进模型上下文；要让模型真知道"该去查哪个会话"，最可靠的是把它写进第一条 `user/message`。
 *
 * 模板里的占位符：`{old}` = 旧会话 id，`{cwd}` = 工作目录（两者都会被替换，未知占位符原样保留）。
 *
 * @param {{config?: object, oldId: string, cwd?: string}} input
 * @returns {string}
 */
export function rotationSeedText({ config, oldId, cwd }) {
  const source = config === null || typeof config !== 'object' ? {} : config
  const template =
    typeof source.rotationSeedMessage === 'string' && source.rotationSeedMessage.trim() !== ''
      ? source.rotationSeedMessage
      : DEFAULT_CONFIG.rotationSeedMessage
  const id = typeof oldId === 'string' ? oldId : ''
  const dir = typeof cwd === 'string' && cwd !== '' ? cwd : ''
  return template.split('{old}').join(id).split('{cwd}').join(dir)
}

/**
 * 是否给轮换出的空白子会话改名（0.20.0 复活 0.8.0 的 `rotationIncreaseTitle`）。
 *
 * 只认字面量 true，其余（含 undefined / 非布尔）一律走缺省 —— 与 `rotationRequireIdle` 同一套纪律。
 *
 * @param {object|null} config 生效配置。
 * @returns {boolean} true 表示改名。
 */
export function rotationIncreaseTitleEnabled(config) {
  const source = config === null || typeof config !== 'object' ? {} : config
  const value = typeof source.rotationIncreaseTitle === 'boolean' ? source.rotationIncreaseTitle : DEFAULT_CONFIG.rotationIncreaseTitle
  return value === true
}

/**
 * 按官方 fork 的命名约定加一级：行尾 `(N)` / `（N）` 递增并保留括号样式，
 * 没有编号的标题追加 ` (1)`（逐字镜像 `packages/client/runtime/src/client/sessions/service.ts · increasedForkTitle`）。
 *
 * 空白新建的子会话拿不到这个待遇（0.9.0 起不再 fork）—— 宿主不补名字，面板上它就只剩
 * 「首条 user/message 的回退截断」，一代一个样，认不出是谁开的（Q1）。
 *
 * @param {unknown} title 源会话的持久化标题。
 * @returns {string|null} 新标题；标题不可用（非字符串 / 空白）时返回 null，调用方只降级。
 */
export function increasedRotationTitle(title) {
  if (typeof title !== 'string') return null
  if (title.trim() === '') return null
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii !== null && ascii[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth !== null && fullWidth[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}
