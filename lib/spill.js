/**
 * B3 结果瘦身层（纯模块，零 import）
 *
 * 1. 只做决策与编排：导出 `shouldSpill` / `spillOnce`，由 `lib/index.js`（T05）注册到
 *    `tools/post-execute`；本模块不注册钩子、不读全局配置，宿主能力一律由参数注入。
 * 2. dsh-status-turbo 自己绝不写盘：落盘只调用注入的 `spillStore.saveText`。正文瘦身优先调用注入的
 *    `toolResultPruner.pruneContent`（与宿主语义一致）；**拿不到该服务时回落到本模块的 `localTrim`**
 *    —— 0.6.5：宿主 preset 把 `toolResultPruner` 隔离在 `cordis:group` 内，组外插件按设计读不到。
 * 3. 阈值由调用方传入（Config · `spillThresholdBytes`，T01 校验、T05 读出）；本模块不定义
 *    默认值常量（DSH 约定：部署可变取值不得是 `DEFAULT_*` 常量）。
 * 4. 失败必须可见：每次降级都产出 `{ at, hook, message }` 故障对象并交给注入的上报通道；
 *    一个上报通道都没有时以抛出结束——静默 return 是禁止的。
 */

/** 故障对象上的钩子名（PLAN.md · §4.2 `pushHookFault`）。 */
export const SPILL_HOOK = 'spill'

/** 落盘来源标签（TASKS.json · T03 `contract.saveTextInput`）。 */
const RESULT_LABEL = 'result'

/** 模型上下文通知行模板（PLAN.md · §3.4 「B3 通知行逐字」）。 */
const NOTICE_TEMPLATE = '（已省略 {bytes} bytes；完整结果落盘于：{locator}。用 read 配 offset/limit，或 grep 这个路径继续。）'

const encoder = new TextEncoder()

/**
 * 「可选能力缺席」的原因串（唯一幸存的一条：落盘后端）。
 *
 * 它在界面上**不是故障**：`spillStore` 是可选能力，缺席时的官方口径是警告一次 + 保持 inline
 * （`packages/spill/spill-policy/src/index.ts:142-144`、`packages/fs/tool-fs-search/src/search-core.ts:386-388`）。
 * `toolResultPruner` 缺席**不再**是缺席：0.6.5 起回落到本模块的 {@link localTrim}。
 */
const ABSENT_STORE = 'no ctx.spillStore backend loaded'

/** 已警告过的缺席原因（按消息文本去重）：同一进程内每种缺席原因只 warn 一次。 */
const warnedAbsent = new Set()

/**
 * 读取调用方传入的瘦身意愿阈值。
 *
 * 非法值（非安全整数或负数）返回 `null` = 未配置；回落默认是 `lib/state.js` 的职责，
 * 本模块不定义也不猜测默认值。
 * @param {{ spillThresholdBytes?: number } | null | undefined} config - T05 读出的 Config。
 * @returns {number | null} 有效阈值，或 `null` 表示未配置。
 */
export function readThreshold(config) {
  const value = config === null || config === undefined ? undefined : config.spillThresholdBytes
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * 把工具结果内容拼成落盘用的完整文本。
 *
 * 文本块原样拼接；非文本块（图片/文件/推理等）以一行占位符代替——解析附件真实路径需要
 * 宿主 `attachments`/`fs` 能力，本纯模块不做这件事，占位符保证文本不静默丢失。
 * @param {readonly object[] | null | undefined} content - 工具结果内容块序列。
 * @returns {string} 拼接后的文本。
 */
export function fullText(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
      continue
    }
    text += `\n[${String(block.type)} block not inlined in spill text]\n`
  }
  return text
}

/**
 * 结果正文的 UTF-8 字节数（PLAN.md · §3.5 `spillThresholdBytes` = 字节）。
 * @param {readonly object[] | null | undefined} content - 工具结果内容块序列。
 * @returns {number} UTF-8 字节数。
 */
export function measureBytes(content) {
  return encoder.encode(fullText(content)).length
}

/**
 * 读一个 `localTrim*` 配置项；非法值（非安全整数 / 负数）返回 `null` = 未配置。
 *
 * 与 {@link readThreshold} 同一条纪律：本模块不定义、也不猜默认值——默认值只住在
 * `lib/state.js · DEFAULT_CONFIG`，由 `lib/index.js` 合并后整份传入。
 */
function localTrimInt(config, key) {
  const value = config === null || config === undefined ? undefined : config[key]
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * B3 的**本地**兜底瘦身（0.6.5）：宿主 `toolResultPruner` 读不到时，用本模块自己的保头保尾裁剪
 * 代替「原地放弃」。纯函数：不改入参、不碰时间、不抛。
 *
 * 规则（逐条即契约）：
 *  - 只处理 `{ type: 'text', text }` 块，其余类型（图片 / 附件 / 推理……）**原样保留引用**；
 *  - 只裁**最长**的那个文本块（一次工具结果通常只有一个正文块）；
 *  - 该块短于 `localTrimMinChars` 不裁；
 *  - 保留头 `localTrimHeadChars` + 尾 `localTrimTailChars`，中间插一行
 *    `\n…（此处省略 {n} 个字符）…\n`（`n` = 被省略的正文字符数）；
 *  - **结果不短于原文就返回 `null`**（配置畸形 / 正文太短时绝不凭空把正文变长）；
 *  - 三个配置项任一非法 ⇒ 返回 `null`（视为未配置，宁可不裁）。
 *
 * 返回新数组（最长块是新对象，其余块沿用原引用），入参一个字符都不动。
 * @param {readonly object[] | null | undefined} content - 工具结果内容块序列。
 * @param {{ localTrimHeadChars?: number, localTrimTailChars?: number, localTrimMinChars?: number } | null | undefined} config - 合并后的 Config。
 * @returns {object[] | null} 裁剪后的新内容块序列；`null` = 不裁、保持 inline。
 */
export function localTrim(content, config) {
  if (!Array.isArray(content)) return null
  const headChars = localTrimInt(config, 'localTrimHeadChars')
  const tailChars = localTrimInt(config, 'localTrimTailChars')
  const minChars = localTrimInt(config, 'localTrimMinChars')
  if (headChars === null || tailChars === null || minChars === null) return null

  let longestIndex = -1
  let longestLength = -1
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text.length > longestLength) {
      longestLength = block.text.length
      longestIndex = index
    }
  }
  if (longestIndex === -1) return null

  const text = content[longestIndex].text
  if (text.length < minChars) return null

  const head = text.slice(0, headChars)
  const tail = tailChars === 0 ? '' : text.slice(text.length - tailChars)
  const omitted = text.length - head.length - tail.length
  if (omitted <= 0) return null

  const trimmed = `${head}\n…（此处省略 ${String(omitted)} 个字符）…\n${tail}`
  if (trimmed.length >= text.length) return null

  return content.map((block, index) => (index === longestIndex ? { ...block, text: trimmed } : block))
}

/**
 * 构造可上报的钩子故障对象（PLAN.md · §4.2 `pushHookFault` 的元素形状）。
 * @param {unknown} error - 触发降级的错误或原因。
 * @param {number} [at] - 故障时刻，默认当前时间；注入以便测试断言。
 * @returns {{ at: number, hook: string, message: string }} 故障对象。
 */
export function spillFault(error, at = Date.now()) {
  return { at, hook: SPILL_HOOK, message: faultMessage(error) }
}

/**
 * B3 的静态意愿判据：只回答"这次结果值不值得瘦身"，不触碰任何宿主能力。
 *
 * 覆盖 `result.isError === false`、`exec.name !== 'read'`、正文 UTF-8 字节数达标三项；
 * 瘦身可行性（宿主 pruner 是否愿意）与落盘后端是否存在由 {@link spillOnce} 判定。
 * @param {object} exec - `tools/post-execute` 的 `ToolExecution`。
 * @param {object} result - `tools/post-execute` 的 `ToolExecutionResult`。
 * @param {{ spillThresholdBytes?: number } | null | undefined} config - T05 读出的 Config。
 * @returns {boolean} 是否值得尝试瘦身。
 */
export function shouldSpill(exec, result, config) {
  const threshold = readThreshold(config)
  if (threshold === null) return false
  if (!isSpillableResult(exec, result)) return false
  return measureBytes(result.content) >= threshold
}

/**
 * B3 瘦身编排：判定 → 瘦身（宿主 `toolResultPruner` 优先，读不到则本地 `localTrim`）→ 落盘 → 组装替换内容与通知行。
 *
 * 不抛（宿主能力失败时降级为 `null`，正文保持不变），但降级绝不静默：故障对象交给
 * `onFault`，其次 `ctx.reportFault`；两者都缺席时抛出，由调用方的 catch 走
 * `pushHookFault('spill', error)`（TASKS.json · T03 `contract.degrade`）。
 * @param {object} ctx - 宿主能力注入：`get(name)` 服务查找（`'spillStore'`）、
 *   `toolResultPruner.pruneContent`、可选的 `logger.warn` 与 `reportFault`。
 * @param {object} exec - `tools/post-execute` 的 `ToolExecution`（读 `name`/`callId`/`agent.session.header.id`）。
 * @param {object} result - `tools/post-execute` 的 `ToolExecutionResult`（读 `isError`/`content`）。
 * @param {{ spillThresholdBytes?: number, localTrimHeadChars?: number, localTrimTailChars?: number, localTrimMinChars?: number } | null | undefined} config - T05 读出的 Config。
 * @param {(fault: { at: number, hook: string, message: string }) => void} [onFault] - 故障上报通道。
 * @returns {Promise<{ pruned: object[], notice: { type: 'text', text: string }, bytes: number, locator: string } | null>}
 *   瘦身决策；`null` = 不改 content（未触发，或已降级并上报）。
 */
export async function spillOnce(ctx, exec, result, config, onFault) {
  const report = faultReporter(ctx, onFault)

  const threshold = readThreshold(config)
  if (threshold === null || !isSpillableResult(exec, result)) return null
  const content = result.content
  if (measureBytes(content) < threshold) return null

  let store
  try {
    store = resolveStore(ctx)
  } catch (error) {
    return degrade(report, ctx, error)
  }
  if (store === null) return absent(ctx, ABSENT_STORE)

  const pruner = resolvePruner(ctx)
  let pruned
  if (pruner === null) {
    // 0.6.5：宿主 pruner 按设计读不到 ⇒ 用本模块的本地裁剪，而不是原地放弃（0.6.4 的缺陷）。
    pruned = localTrim(content, config)
    if (pruned === null) return null
  } else {
    try {
      pruned = pruner.pruneContent(content)
    } catch (error) {
      return degrade(report, ctx, error)
    }
    if (!Array.isArray(pruned)) {
      return degrade(report, ctx, 'over spillThresholdBytes but the host result pruner declined')
    }
  }

  const sessionId = exec?.agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return degrade(report, ctx, `no session owner for ${String(exec?.name)} ${RESULT_LABEL}`)
  }

  let saved
  try {
    saved = await store.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: RESULT_LABEL },
      suggestedName: `${exec.name}.txt`,
      content: fullText(content),
    })
  } catch (error) {
    return degrade(report, ctx, error)
  }

  const locator = saved === null || saved === undefined ? '' : saved.locator
  if (!isAbsolutePath(locator)) {
    return degrade(report, ctx, `spillStore returned a locator that is not an absolute path: ${JSON.stringify(locator)}`)
  }

  return {
    pruned,
    notice: { type: 'text', text: renderNotice(measureBytes(content) - measureBytes(pruned), locator) },
    bytes: measureBytes(content) - measureBytes(pruned),
    locator,
  }
}

/**
 * 探测工具增强层是否在位（供状态投影显示一行 info，不参与瘦身判定）。
 *
 * 与 {@link spillOnce} 共用同一条读取顺序和同一组原因串，所以面板说的原因与日志、故障列表
 * 三者永远一致。任何探测异常都在这里吞掉并当作「在位」——这只是一行状态，不能因为探测本身
 * 让钩子变红；真正的问题留给 `spillOnce` 的 `degrade()` 上报。
 * @param {object} ctx - 插件上下文或能力替身。
 * @returns {{ active: boolean, mode: 'host-pruner' | 'local-trim' | 'off', reason: string | null }}
 *   增强层状态；`mode` 三态：宿主 pruner 在位 / 只有本地裁剪 / 连落盘后端都没有。缺席时给出机器原因串。
 */
export function enhancementOf(ctx) {
  try {
    if (resolveStore(ctx) === null) return { active: false, mode: 'off', reason: ABSENT_STORE }
    if (resolvePruner(ctx) !== null) return { active: true, mode: 'host-pruner', reason: null }
    return { active: true, mode: 'local-trim', reason: null }
  } catch {
    return { active: true, mode: 'host-pruner', reason: null }
  }
}

/** 是否满足 B3 的两条静态前置判据。 */
function isSpillableResult(exec, result) {
  if (result === null || typeof result !== 'object' || result.isError !== false) return false
  return exec !== null && typeof exec === 'object' && exec.name !== 'read'
}

/** 取注入的能力对象；Cordis 上下文与最小能力包（测试）都按同一读取顺序支持。 */
function resolveStore(ctx) {
  if (ctx === null || ctx === undefined) return null
  if (typeof ctx.get === 'function') {
    const store = ctx.get('spillStore')
    return store === null || store === undefined || typeof store.saveText !== 'function' ? null : store
  }
  const store = ctx.spillStore
  return store === null || store === undefined || typeof store.saveText !== 'function' ? null : store
}

/**
 * 读一个**没有声明进模块级 `inject`** 的可选能力。
 *
 * 为什么不能直接 `ctx.someService`（0.5.0 起就埋着、0.6.1 线上实测才炸的缺陷）：
 * Cordis 上下文对未声明服务的属性读取是**抛错**，不是返回 `undefined` ——
 *   `spill: cannot get property "toolResultPruner" without inject`
 * 这条异常在本模块内没有任何 catch（本模块的所有宿主能力调用都假定"返回 null 即不可用"），
 * 会一路冒到 `lib/index.js` 的 `tools/post-execute` 监听器，被记成 `hook='spill'` 故障，
 * 界面上就是「工具增强失败」红字 + 「最近的故障」。
 *
 * 宿主自己的读法就是安全通道 `ctx.get(name)` ——
 * `packages/compaction/compaction-basic/src/index.ts:281` 逐字 `this.ctx.get('toolResultPruner')`，
 * 且该包 README 明写 "reads it through optional `ctx.get('toolResultPruner')`"：
 * `get` 对未注册的可选服务返回 `undefined`，不抛。
 *
 * 读取顺序：`get`（真实上下文的安全通道）→ 属性直读（兜底给只有部分 `get` 的替身）。
 * 两条都包 try/catch：真实上下文走到兜底那一步仍然会抛，那种情况等同"该能力不存在"。
 * @param {object} ctx - 插件上下文或能力替身。
 * @param {string} name - 能力/服务名。
 * @returns {*} 能力对象；不存在或不可读时为 `undefined`。
 */
function readOptionalCapability(ctx, name) {
  if (ctx === null || ctx === undefined) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch {
      /* 上下文自身的 get 不可用：继续走属性直读 */
    }
  }
  try {
    return ctx[name]
  } catch {
    // 未声明的服务在真实 Cordis 上下文里会抛；此处等同"没有这个能力"。
    return undefined
  }
}

/**
 * 取宿主结果瘦身服务；`pruneContent` 缺失即视为不可用。
 *
 * 根因（0.6.4 实读）：`toolResultPruner` 在官方 preset 里被隔离在 cordis 组内部 ——
 * `presets/cordis.patch.yml:62-78` 的 `isolate: { toolResultPruner: true }`。组的隔离是
 * 设计：组外插件（本插件不注册进那个组）**按设计就读不到**这个服务，这是布局，不是缺陷。
 * 0.6.5 起读不到的后果是「回落到 {@link localTrim}」，不是「放弃瘦身」。
 */
function resolvePruner(ctx) {
  const pruner = readOptionalCapability(ctx, 'toolResultPruner')
  return pruner === null || pruner === undefined || typeof pruner.pruneContent !== 'function' ? null : pruner
}

/**
 * 故障上报通道：显式 `onFault` 优先，其次注入的 `ctx.reportFault`。
 *
 * `reportFault` 与 `toolResultPruner` 同类（未声明进 `inject`），所以走同一条安全读取；
 * 这条尤其重要：它**正好在降级路径上**被求值，在这里抛错会把「一次可控降级」升级成故障。
 */
function faultReporter(ctx, onFault) {
  if (typeof onFault === 'function') return onFault
  const reported = readOptionalCapability(ctx, 'reportFault')
  return typeof reported === 'function' ? reported : null
}

/**
 * 可选能力缺席：只警告（且同一原因只警告一次），不上报、不抛，返回 `null`（正文保持 inline）。
 *
 * 与 {@link degrade} 的分工：`degrade` 处理**真的出了问题**（宿主调用抛错、返回值非法、
 * 落盘路径不可读……），必须让用户看见；这里处理**本来就可以没有的能力**——报成故障只会让
 * 状态条永久挂一条红字，而用户对此什么也做不了。
 * @returns {null} 始终为 `null`。
 */
function absent(ctx, message) {
  if (!warnedAbsent.has(message)) {
    warnedAbsent.add(message)
    try {
      ctx?.logger?.warn?.(`spill: ${message}; keeping the inline content`)
    } catch (loggerError) {
      // 日志通道自身失败不该改变"缺席 ⇒ 保持 inline"的判定。
      void loggerError
    }
  }
  return null
}

/**
 * 降级：记录 → 上报 → 返回 `null`（不改 content）。
 *
 * 没有上报通道时抛出，让调用方的 catch 走 `pushHookFault`——静默吞掉失败是禁止的。
 * @returns {null} 始终为 `null`，除非抛出。
 */
function degrade(report, ctx, error) {
  const failure = error instanceof Error ? error : new Error(faultMessage(error))
  try {
    ctx?.logger?.warn?.(`spill: ${failure.message}; keeping the inline content`)
  } catch (loggerError) {
    // 日志通道自身失败不影响降级判定：故障仍会走下面的上报通道或抛出。
    void loggerError
  }
  const fault = spillFault(failure)
  if (report !== null) {
    report(fault)
    return null
  }
  throw failure
}

/** 故障对象的 message：优先错误的 message，其次字符串本身。 */
function faultMessage(error) {
  if (error === null || error === undefined) return 'unknown spill failure'
  if (typeof error === 'string') return error
  const message = error.message
  return typeof message === 'string' && message.length > 0 ? message : String(error)
}

/** 落盘路径必须是可直接 `read` 的绝对路径（POSIX / Windows 盘符 / UNC）。 */
function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  return value.startsWith('\\\\')
}

/** 渲染通知行；locator 原样嵌入（不做相对化、不缩写、不加引号）。 */
function renderNotice(bytes, locator) {
  return NOTICE_TEMPLATE.replace('{bytes}', () => String(bytes)).replace('{locator}', () => locator)
}
