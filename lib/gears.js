// dsh-status-turbo · 支柱 B1「按步降推理档」的纯判据层
//
// 设计原则（任务书 §3 支柱 B + §9#3）：
//   1. 判据只来自**工具轨迹**，绝不猜用户自然语言；
//   2. **只降不升**——结构上保证（pickLowerEffort 返回 null 或严格更低的档）；
//   3. **保守**：不认识的工具一律当成"非只读"，因此不会降档；
//   4. 任何不确定（取不到档位列表 / 当前档不在列表里 / 达不到降档）→ 返回 null，原样放过；
//   5. 零外部依赖、纯函数，可以直接单测；默认值**只**从 ./state.js 的 DEFAULT_CONFIG 取
//      （0.9.2 · P1-4：本文件不再自带第二套默认值副本）。

import { DEFAULT_CONFIG } from './state.js'

/**
 * 默认"只读工具"白名单 —— `DEFAULT_CONFIG.readOnlyTools` 的**别名**（P1-4：唯一来源在 state.js）。
 * 只有**明确只读**的工具才算"纯读取/列举/检索"（任务书 §3 支柱 B 的降档判据）。
 * 不在这个表里的工具（含 bash / edit / write / sql_exec / univer_execute…）一律视为"可能写"，
 * 于是任何一次这类调用都会打断连续段 —— 这是刻意的保守方向。
 */
export const DEFAULT_READ_ONLY_TOOLS = DEFAULT_CONFIG.readOnlyTools

/**
 * 判据环缓冲的**下界**：`noteGearEvent` 最多保留最近这么多个已结束的步骤。
 *
 * 这是判据的算力上界（每步一个对象，不随会话长度增长），不是部署可调项；
 * 但它**必须 ≥ `minQuietSteps`**，否则"连续 N 个干净只读步"永远数不满 ⇒ B1 静默失效。
 * 所以有效窗口由 `readGearConfig` 取成 `max(STEP_WINDOW, minQuietSteps)`（再被 MAX_STEP_WINDOW 截断），
 * 由 `noteGearEvent` 的第三个参数传进来。
 */
export const STEP_WINDOW = 8

/** 有效窗口的**硬上限**：`minQuietSteps` 配得再大也不会让判据环缓冲无限增长。 */
export const MAX_STEP_WINDOW = 64

/** 每个会话一份的换挡记录。 */
export function initSessionGears() {
  return { cur: null, steps: [] }
}

function blankStep() {
  return { calls: 0, readOnly: true, error: false, tools: [] }
}

/**
 * 折叠一个会话事件。
 * 只关心四类：step/start（开一个新步）、tool/call、tool/result、step/end；以及 turn/start（新回合清零）。
 * `readOnlyTools` 决定某个工具名算不算"纯读取"；不在表里的工具一律视为"可能写"（保守方向）。
 * `stepWindow` 是环缓冲长度（缺省 `STEP_WINDOW`；`readGearConfig` 会按 `minQuietSteps` 抬高它）。
 * 返回同一个 rec（就地更新，热路径上不做多余分配）。
 */
export function noteGearEvent(rec, event, readOnlyTools, stepWindow = STEP_WINDOW) {
  const type = event && event.type
  const data = (event && event.data) || {}
  switch (type) {
    case 'turn/start':
      // 新回合 = 新的用户任务，上一回合的"只读连击"不能用来给新任务降档。
      rec.cur = null
      rec.steps.length = 0
      return rec
    case 'step/start':
      rec.cur = blankStep()
      return rec
    case 'tool/call': {
      if (!rec.cur) rec.cur = blankStep()
      const name = typeof data.name === 'string' ? data.name : ''
      rec.cur.calls += 1
      if (name) {
        rec.cur.tools.push(name)
        if (!isReadOnlyTool(name, readOnlyTools)) rec.cur.readOnly = false
      }
      return rec
    }
    case 'tool/result': {
      if (!rec.cur) rec.cur = blankStep()
      // 事件 envelope 里的 error 就是"这一步失败了"的权威信号。
      if (data.error) rec.cur.error = true
      return rec
    }
    case 'step/end': {
      if (rec.cur) {
        rec.steps.push(rec.cur)
        const window = toPositiveInt(stepWindow, STEP_WINDOW)
        if (rec.steps.length > window) rec.steps.splice(0, rec.steps.length - window)
      }
      rec.cur = null
      return rec
    }
    default:
      return rec
  }
}

/**
 * 判定"现在该不该降档"。
 * 从最近的已结束步骤往回数，数出连续的"跑过工具、全是只读工具、且没有报错"的步数：
 *   - 完全没有工具调用的空步是**中性**的：不计数，也不打断（它是纯思考步，不构成降档证据，也不是反证）；
 *   - 一旦遇到"调用过非只读工具"或"有报错"的步骤，连续段立即中断。
 * 达到 minQuietSteps 才降档。
 */
export function judgeDowngrade(rec, options = {}) {
  if (!rec || !Array.isArray(rec.steps)) return false
  const minQuiet = toPositiveInt(options.minQuietSteps, DEFAULT_CONFIG.minQuietSteps)
  let quiet = 0
  for (let i = rec.steps.length - 1; i >= 0; i -= 1) {
    const step = rec.steps[i]
    if (!step) continue
    if (step.calls === 0) continue
    if (step.readOnly && !step.error) {
      quiet += 1
      if (quiet >= minQuiet) return true
      continue
    }
    break
  }
  return false
}

/**
 * 在"该模型自己公布的**有序**档位列表"里挑一个**严格更低**的档。
 *
 * 为什么必须从列表里挑：`dsh-llm` 对不受支持的档位会抛 `UNSUPPORTED_REASONING_EFFORT`，
 * 而且各 provider 的档位集合并不相同（README.zh.md:102 描述的是 `off`/`low`/`high`/`max`，
 * 但那是描述而不是契约）。按下标比较就不需要知道档位名字。
 *
 * @returns 目标档位 id；**不降档时返回 null**（含一切不确定情形）。
 */
export function pickLowerEffort(efforts, currentEffort, floor) {
  if (!Array.isArray(efforts) || efforts.length === 0) return null
  const ids = []
  for (const effort of efforts) {
    if (effort && typeof effort.id === 'string' && effort.id !== '') ids.push(effort.id)
  }
  if (ids.length === 0) return null
  const currentIdx = ids.indexOf(currentEffort)
  // 当前档不在该模型公布的列表里 —— 说明我对这个路由的理解不完整，绝不动它。
  if (currentIdx < 0) return null
  const floorIdx = typeof floor === 'string' ? ids.indexOf(floor) : -1
  // 该模型没公布 floor 这一档时，退化为"只降一档"，而不是硬塞一个它不认识的值。
  const targetIdx = floorIdx >= 0 ? Math.min(currentIdx, floorIdx) : Math.max(0, currentIdx - 1)
  if (targetIdx >= currentIdx) return null // 只降不升：达不到降档就不动
  return ids[targetIdx]
}

/**
 * 从 apply(ctx, config) 收到的任意 config 里读出 B1 的有效设置。
 *
 * 0.9.2 · P1-4：`lib/index.js` 现在把**合并过 DEFAULT_CONFIG 的** `effective` 传进来，
 * 所以这里的回落分支只是"直接单测/老宿主"的兜底；默认值本身一律从 `DEFAULT_CONFIG` 取，
 * 本文件不再自带副本。非法值（空串 / 0 / 非整数 / 非法元素）一律回落默认。
 *
 * `stepWindow` 把判据环缓冲抬到 `minQuietSteps` 那么大（下界 STEP_WINDOW，上界 MAX_STEP_WINDOW）——
 * 否则 `minQuietSteps` 配得比环缓冲还大时 B1 会静默失效。
 */
export function readGearConfig(config) {
  const src = config && typeof config === 'object' ? config : {}
  const list = Array.isArray(src.readOnlyTools)
    ? src.readOnlyTools.filter((n) => typeof n === 'string' && n !== '')
    : null
  const minQuietSteps = toPositiveInt(src.minQuietSteps, DEFAULT_CONFIG.minQuietSteps)
  return {
    enabled: src.downgrade !== false,
    floor: typeof src.downgradeFloor === 'string' && src.downgradeFloor !== '' ? src.downgradeFloor : DEFAULT_CONFIG.downgradeFloor,
    minQuietSteps,
    stepWindow: Math.min(MAX_STEP_WINDOW, Math.max(STEP_WINDOW, minQuietSteps)),
    readOnlyTools: new Set(list && list.length > 0 ? list : DEFAULT_READ_ONLY_TOOLS),
  }
}

/** 该工具算不算"纯读取/列举/检索"。不在白名单里 = 不算（保守）。 */
export function isReadOnlyTool(name, readOnlyTools) {
  return typeof name === 'string' && readOnlyTools instanceof Set && readOnlyTools.has(name)
}

function toPositiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
