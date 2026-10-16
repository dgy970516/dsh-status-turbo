/**
 * T05 · 宿主半钩子层（`lib/index.js`）契约测试
 *
 * 这一层的职责只有两件：**接线**（一个 `tools/post-execute` 监听器，四段在里面按序跑完）与
 * **失败隔离**（任何一段抛错都不许污染工具调用，只记 fault）。判据本体在 `./notes.js`
 * 与 `./spill.js`，各自的测试已覆盖；这里**不重测判据**，只测本层的契约：
 *
 *   - 注册边：模块级 `inject` 不变，新增依赖走嵌套 `ctx.inject(['tools'], …)`，只有一个监听器；
 *   - handler 形状：`(exec, result, next)` → `PostToolDecision`；非 accept / 带 `value` 原样返回；
 *   - 追加一律走 `content`；不构造 `additionalContexts`；不新增往返（O4）；
 *   - 全不触发 ⇒ 返回**同一个对象引用**；
 *   - 失败可见（G3）：抛错的段写 `hookFaults`，返回值仍可用；
 *   - 默认配置零副作用（O12）：`workspace/session-stop` 不可达，连活动查询都不发。
 *
 * 假宿主按「cordis 的 `inject(requested, callback)` + `on(event, handler, options)`」的最小形状搭；
 * `downgrade: false` 关掉 B1 的 llm 依赖，把断言面收敛在钩子层自己身上（SPEC:149 同一条）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { apply } from '../lib/index.js'

const SOURCE = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** 事件名只在测试里写字面量；源码里必须**恰好一处**（T05 verify 第 2 条）。 */
const HOOK_EVENT = 'tools/post-execute'
const STOP_EVENT = 'workspace/session-stop'
const ACTIVITY_EVENT = 'workspace/session-activity'

const LOCATOR = '/tmp/dsh-spill/sess-hook/bash-1.txt'
const PRUNED_TEXT = 'HEAD\n[... N chars omitted by the host pruner ...]\nTAIL'

/** 一次工具调用的最小形状：声明里就有的 `agent.id` + 运行时同时存在的 `agent.session.header.id`。 */
function makeExec(sessionId, overrides = {}) {
  return {
    callId: 'call-1',
    name: 'bash',
    arguments: { command: 'ls' },
    agent: { id: sessionId, session: { header: { id: sessionId } } },
    ...overrides,
  }
}

function okResult(content) {
  return { isError: false, content }
}

/** 内容读取即抛错的 result —— 用来把某一段逼进它自己的 catch（G3）。 */
function explodingResult(message) {
  const result = { isError: false }
  Object.defineProperty(result, 'content', {
    get() {
      throw new Error(message)
    },
  })
  return result
}

/** 起一个假宿主并跑 `apply`，把注册面（listeners / registers / logs / emitted…）摊出来。 */
function startHost(config = { downgrade: false }, options = {}) {
  const host = {
    deps: [],
    listeners: [],
    registers: [],
    logs: [],
    emitted: [],
    waterfalls: [],
    saves: [],
    prunings: [],
    faults: [],
    jobStarts: 0,
  }

  const store =
    options.store === undefined
      ? {
          async saveText(request) {
            host.saves.push(request)
            return { locator: options.locator ?? LOCATOR, bytes: 4096, retrievalHint: 'read with offset/limit' }
          },
        }
      : options.store

  const pruner =
    options.pruner === undefined
      ? {
          pruneContent(content) {
            host.prunings.push(content)
            return [{ type: 'text', text: PRUNED_TEXT }]
          },
        }
      : options.pruner

  const ctx = {
    logger: {
      info: (message) => host.logs.push(['info', message]),
      warn: (message) => host.logs.push(['warn', message]),
      error: (message) => host.logs.push(['error', message]),
    },
    inject(requested, callback) {
      host.deps.push(...requested)
      const services = {}
      if (requested.includes('sessionProjections')) {
        services.sessionProjections = { register: (definition) => host.registers.push(definition) }
      }
      if (requested.includes('tools')) {
        services.on = (event, handler, opts) => {
          host.listeners.push({ event, handler, options: opts })
        }
      }
      if (requested.includes('llm')) {
        services.llm = options.llm ?? { resolveModelInfo: async () => null }
      }
      callback(services)
    },
    get(name) {
      if (name !== 'spillStore') return undefined
      return options.noStore === true ? undefined : store
    },
    toolResultPruner: options.noPruner === true ? undefined : pruner,
    reportFault(fault) {
      host.faults.push(fault)
    },
    waterfall(name, request, fallback) {
      host.waterfalls.push({ name, request })
      if (options.activity !== undefined) return options.activity
      return typeof fallback === 'function' ? fallback() : []
    },
    emit(name, request) {
      host.emitted.push({ name, request })
    },
    jobs: {
      start() {
        host.jobStarts += 1
      },
    },
  }

  apply(ctx, config)

  const definition = host.registers[0]
  const listener = host.listeners.find((entry) => entry.event === HOOK_EVENT)
  return { host, ctx, definition, listener, handler: listener === undefined ? undefined : listener.handler }
}

/** 走一次工具返回；`next()` 默认返回一个不含 content 的 accept 裁决。 */
async function run(handler, exec, result, decision) {
  return handler(exec, result, async () => decision ?? { kind: 'accept' })
}

// ---------------------------------------------------------------------------
// 注册边与静态契约
// ---------------------------------------------------------------------------

test('T05-01 恰好注册一个 tools/post-execute 监听器，且 options.prepend === true', () => {
  const { host } = startHost()

  const hooks = host.listeners.filter((entry) => entry.event === HOOK_EVENT)
  assert.equal(hooks.length, 1, '四段共用一个监听器：多了会反复改写同一份 content，少了有支柱悬空')
  assert.equal(hooks[0].options.prepend, true, '必须是 waterfall 最外层，否则内层插件先改掉返回')
  assert.equal(typeof hooks[0].handler, 'function')

  // 新增依赖只能走嵌套注入；A1 的投影注册照旧发生（一条注册边都没被挤掉）。
  assert.equal(host.deps.includes('tools'), true, '工具钩子的依赖边必须在场')
  assert.equal(host.registers.length, 1, '投影 "turbo" 仍恰好注册一次')
})

test('T05-02 模块级 inject 仍是 [\'sessionProjections\']（没被 tools 污染）', () => {
  assert.match(SOURCE, /export const inject = \['sessionProjections'\]/)
  assert.equal(/export const inject = \[[^\]]*'tools'/.test(SOURCE), false, "把 'tools' 加进模块级数组会让服务缺席时整个插件不激活")

  // T05 verify 第 2 条的源码级事实（注释里多写一处也会被这条抓住）。
  assert.equal((SOURCE.match(/tools\/post-execute/g) || []).length, 1, '源码里这个事件名恰一处')
  assert.equal(SOURCE.includes('jobs.start'), false, 'O11：B2 默认关，钩子层不得起后台任务')
  assert.match(SOURCE, /init:\s*\(\s*header\s*\)\s*=>/, '§3.8：init 必须原样收下 session.header')
  assert.equal(SOURCE.includes('spillOnce'), true)
  assert.equal(SOURCE.includes('pushHookFault'), true)
  assert.equal(SOURCE.includes('pushSpill'), true)

  // 运行时表的**唯一**写入路径是本层调 ./state.js 的这两个函数（PLAN.md §3.8）：
  // 本文件里不许出现对 hookFaults / lastSpill 的直接赋值（也就没绕过表去写事件/日志/state）。
  assert.equal(/hookFaults\s*=/.test(SOURCE), false)
  assert.equal(/lastSpill\s*=/.test(SOURCE), false)
})

test('T05-03 kind !== accept 的裁决原样返回（从不改写 block）', async () => {
  const { handler } = startHost()
  const decision = { kind: 'block', feedback: [{ type: 'text', text: '不许执行' }] }

  const returned = await run(handler, makeExec('sess-block'), okResult([{ type: 'text', text: 'ls 的输出' }]), decision)
  assert.equal(returned, decision, 'block 不是我们的领域：必须同一个引用返回')
})

test('T05-04 带 value 的 accept 裁决原样返回（不碰非内容通道）', async () => {
  const { handler } = startHost()
  const decision = { kind: 'accept', value: { any: 'json' } }

  const returned = await run(handler, makeExec('sess-value'), okResult([{ type: 'text', text: 'ls 的输出' }]), decision)
  assert.equal(returned, decision, 'value 变体没有 content 通道，改写它会丢数据')
})

// ---------------------------------------------------------------------------
// B3：瘦身与落盘（content 组装 + pushSpill 写表）
// ---------------------------------------------------------------------------

test('T05-05 B3 命中且裁决无 content：content = [...pruned, notice]，lastSpill 写进运行时表', async () => {
  const { host, definition, handler } = startHost()
  const sessionId = 'sess-spill'
  const state = definition.init({ id: sessionId })
  const big = 'x'.repeat(40000)

  const returned = await run(handler, makeExec(sessionId), okResult([{ type: 'text', text: big }]), { kind: 'accept' })

  assert.equal(returned.kind, 'accept')
  assert.equal(Array.isArray(returned.content), true)
  assert.deepEqual(returned.content[0], { type: 'text', text: PRUNED_TEXT }, '宿主 pruner 的产物必须原样保留在头部')
  const notice = returned.content[returned.content.length - 1]
  assert.equal(notice.type, 'text')
  assert.match(notice.text, /^（已省略 \d+ bytes；完整结果落盘于：\/tmp\/dsh-spill\/sess-hook\/bash-1\.txt。用 read 配 offset\/limit，或 grep 这个路径继续。）$/)

  assert.equal(host.prunings.length, 1, '必须走宿主 pruner，不许自己切片')
  assert.equal(host.saves.length, 1, '完整正文只落一次盘')
  assert.equal(host.saves[0].owner.sessionId, sessionId)
  assert.equal(host.saves[0].source.toolName, 'bash')
  assert.equal(host.faults.length, 0, '一切正常时不许产出任何 fault')

  const view = definition.wire.view(state)
  assert.notEqual(view.lastSpill, null, 'lastSpill 必须经运行时表送达 wire 视图')
  assert.equal(view.lastSpill.locator, LOCATOR)
  assert.equal(Number.isSafeInteger(view.lastSpill.bytes), true)
  assert.equal(view.hookFaults.length, 0)
})

test('T05-06 B3 命中且裁决已有 content：通知块追加到末尾，已有内容不被替换', async () => {
  const { host, definition, handler } = startHost()
  const sessionId = 'sess-spill-append'
  const state = definition.init({ id: sessionId })
  const hostBlock = { type: 'text', text: '宿主已替换过的正文' }
  const big = 'y'.repeat(40000)

  const returned = await run(handler, makeExec(sessionId), okResult([{ type: 'text', text: big }]), {
    kind: 'accept',
    content: [hostBlock],
  })

  assert.deepEqual(returned.content[0], hostBlock, '别把上游已经替换好的 content 再覆盖一次')
  assert.equal(returned.content.length, 2)
  assert.match(returned.content[1].text, /已省略 \d+ bytes/)
  assert.equal(definition.wire.view(state).lastSpill.locator, LOCATOR)
})

test('0.6.5 端到端：宿主 pruner 读不到 ⇒ 本地裁剪接管、完整原文仍落盘、wire 报 local-trim', async () => {
  const { host, definition, handler } = startHost({ downgrade: false }, { noPruner: true })
  const sessionId = 'sess-local-trim'
  const state = definition.init({ id: sessionId })
  const big = 'z'.repeat(40000)

  const returned = await run(handler, makeExec(sessionId), okResult([{ type: 'text', text: big }]), { kind: 'accept' })

  assert.equal(returned.kind, 'accept')
  assert.equal(Array.isArray(returned.content), true)
  const trimmed = returned.content[0]
  assert.equal(trimmed.type, 'text')
  assert.equal(trimmed.text.startsWith(big.slice(0, 4096)), true, '保头 4096 字符')
  assert.equal(trimmed.text.endsWith(big.slice(-1024)), true, '保尾 1024 字符')
  assert.match(trimmed.text, /…（此处省略 \d+ 个字符）…/)

  assert.equal(host.prunings.length, 0, '宿主 pruner 读不到：一次都不该被调用')
  assert.equal(host.saves.length, 1, '完整原文仍然落盘')
  assert.equal(host.saves[0].content, big, '落盘的必须是完整原文，裁剪只影响给模型看的正文')
  assert.equal(host.faults.length, 0, '本地裁剪是正常路径，不是故障')

  const view = definition.wire.view(state)
  assert.equal(view.hookFaults.length, 0, '本地裁剪绝不许进「最近的故障」')
  assert.notEqual(view.lastSpill, null)
  assert.equal(view.enhancement.active, true)
  assert.equal(view.enhancement.mode, 'local-trim', '面板据此渲染「已启用（本地裁剪）」')
})

// ---------------------------------------------------------------------------
// C 段：C1 负例（O8）与正例（O7/O4）
// ---------------------------------------------------------------------------

test('T05-07 C1 负例（输出里已有可核对证据）：输出与输入逐字相等（O8）', async () => {
  const { host, handler } = startHost()
  const text = '# tests 125\n# pass 125\n# fail 0'
  const content = [{ type: 'text', text }]
  const decision = { kind: 'accept', content }

  const returned = await run(handler, makeExec('sess-evidence', { arguments: { command: 'npm test' } }), okResult(content), decision)

  assert.equal(returned, decision, '有证据就必须原样返回同一个引用，一个字都不能变')
  assert.deepEqual(returned.content, [{ type: 'text', text }])
  assert.equal(host.prunings.length, 0, '这么小的返回不该进 B3')
})

test('T05-08 C1 正例：同一条命令没证据 ⇒ 追加文案块，且只追加到本次返回（O7）', async () => {
  const { handler } = startHost()
  const text = '跑完了，但什么都没说'
  const decision = { kind: 'accept', content: [{ type: 'text', text }] }

  const returned = await run(handler, makeExec('sess-c1', { arguments: { command: 'npm test' } }), okResult(decision.content), decision)

  assert.notEqual(returned, decision)
  assert.equal(returned.content.length, 2)
  assert.equal(returned.content[0].text, text)
  assert.match(returned.content[1].text, /没有可核对的证据/, 'C1 文案逐字来自 ./notes.js')
  assert.equal(returned.content[1].type, 'text')
})

test('T05-09 O4：钩子不新增往返 —— step/turn 计数不变、不起任务、不 emit', async () => {
  const { host, definition, handler } = startHost()
  const sessionId = 'sess-o4'
  const state = definition.init({ id: sessionId })
  const afterCall = definition.apply(state, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' },
    time: 1,
  })
  const before = definition.wire.view(afterCall)

  const decision = { kind: 'accept', content: [{ type: 'text', text: '没有证据的输出' }] }
  const returned = await run(handler, makeExec(sessionId, { arguments: { command: 'npm test' } }), okResult(decision.content), decision)

  const after = definition.wire.view(afterCall)
  assert.equal(after.step, before.step, '文案是搭在**这次**工具返回上的，不得让模型再走一步')
  assert.equal(after.turn, before.turn)
  assert.equal(host.jobStarts, 0)
  assert.deepEqual(host.emitted, [])
  assert.equal(Object.hasOwn(returned, 'additionalContexts'), false, '追加文本一律走 content')
})

// ---------------------------------------------------------------------------
// 失败隔离（G3）与会话 id 解析
// ---------------------------------------------------------------------------

test('T05-10 某段抛错：不 throw、返回可用 decision、两条 fault 都写进运行时表（G3）', async () => {
  const { host, definition, handler } = startHost()
  const sessionId = 'sess-fault'
  const state = definition.init({ id: sessionId })
  const decision = { kind: 'accept', content: [{ type: 'text', text: 'ok' }] }

  const returned = await run(handler, makeExec(sessionId), explodingResult('boom: 正文读不出来'), decision)

  assert.equal(returned, decision, '钩子绝不能把一次成功的工具调用变成 isError')
  const view = definition.wire.view(state)
  const hooks = view.hookFaults.map((fault) => fault.hook).sort()
  assert.deepEqual(hooks, ['notes', 'spill'], 'B3 与 C 段各自独立 try/catch，各记一条')
  for (const fault of view.hookFaults) {
    assert.equal(Number.isSafeInteger(fault.at), true)
    assert.match(fault.message, /boom/)
  }
  assert.equal(host.logs.some(([level, message]) => level === 'warn' && message.includes('boom')), true, '同一个故障还要留一条 warn 日志')
})

test('T05-11 exec.agent 只有声明里的 id（无 .session）：fault 仍落到正确会话', async () => {
  const { definition, handler } = startHost()
  const sessionId = 'sess-agent-id-only'
  const state = definition.init({ id: sessionId })
  const exec = { callId: 'call-1', name: 'bash', arguments: { command: 'ls' }, agent: { id: sessionId } }
  const decision = { kind: 'accept', content: [] }

  const returned = await run(handler, exec, explodingResult('boom'), decision)

  assert.equal(returned, decision)
  assert.equal(definition.wire.view(state).hookFaults.length, 2, 'agent.id 优先：表键必须等于 state.sessionId')
})

test('T05-12 三条路径都拿不到会话 id：只告一次警，fault 不写表，返回仍可用', async () => {
  const { host, handler } = startHost()
  const exec = { callId: 'call-1', name: 'bash', arguments: { command: 'ls' } }
  const decision = { kind: 'accept', content: [] }
  const warnings = () => host.logs.filter(([level, message]) => level === 'warn' && message.includes('取不到会话 id')).length

  const first = await run(handler, exec, explodingResult('boom'), decision)
  const afterFirst = warnings()
  const second = await run(handler, exec, explodingResult('boom'), decision)

  assert.equal(first, decision)
  assert.equal(second, decision)
  assert.equal(warnings(), afterFirst, '同一个警只许告一次，别把日志刷满')
  assert.equal(host.logs.some(([level, message]) => level === 'warn' && message.includes('dsh-status-turbo')), true, '降级必须出声')
})

// ---------------------------------------------------------------------------
// D 段：默认零副作用（O12）与显式配置才可达的两条路
// ---------------------------------------------------------------------------

test('T05-13 默认配置（stuckAction=warn）：连活动查询都不发，workspace/session-stop 从不 emit（O12）', async () => {
  const { host, handler } = startHost()
  const exec = makeExec('sess-stuck-default')
  const result = okResult([{ type: 'text', text: 'ok' }])
  const decision = { kind: 'accept', content: result.content }

  for (let i = 0; i < 6; i += 1) {
    const returned = await run(handler, exec, result, decision)
    assert.equal(returned, decision, 'warn 是零副作用：连一次都不许改返回')
  }

  assert.deepEqual(host.emitted, [], '默认配置下不得存在任何 stop 调用路径')
  assert.deepEqual(host.waterfalls, [], 'warn 连 workspace/session-activity 都不该问')
})

test('T05-14 显式 stuckAction=nudge：才注入一条系统提醒（默认不可达）', async () => {
  const { host, handler } = startHost({ downgrade: false, stuckAction: 'nudge', stuckRepeats: 1 })
  const exec = makeExec('sess-nudge')
  const result = okResult([{ type: 'text', text: 'ok' }])
  const decision = { kind: 'accept', content: result.content }

  const returned = await run(handler, exec, result, decision)

  assert.equal(returned.content.length, 2)
  assert.match(returned.content[1].text, /同一个工具、同一组参数已经连续跑了 1 次/)
  assert.deepEqual(host.emitted, [], 'nudge 只提醒，不打断')
})

test('T05-15 显式 stuckAction=stop：活动为空时 fail-closed，非空才 emit', async () => {
  const exec = makeExec('sess-stop')
  const result = okResult([{ type: 'text', text: 'ok' }])
  const decision = { kind: 'accept', content: result.content }

  const idle = startHost({ downgrade: false, stuckAction: 'stop', stuckRepeats: 1 }, { activity: [] })
  assert.equal(await run(idle.handler, exec, result, decision), decision)
  assert.deepEqual(idle.host.waterfalls.map((entry) => entry.name), [ACTIVITY_EVENT])
  assert.deepEqual(idle.host.emitted, [], '查不到活动就不许打断用户的任务')

  const busy = startHost({ downgrade: false, stuckAction: 'stop', stuckRepeats: 1 }, { activity: [{ kind: 'tool' }] })
  assert.equal(await run(busy.handler, exec, result, decision), decision)
  assert.deepEqual(busy.host.emitted.map((entry) => entry.name), [STOP_EVENT])
})

test('T05-16 非法配置（R12）：不抛、按默认零副作用行为执行', async () => {
  const { host, handler } = startHost({ downgrade: false, stuckAction: 'nuke', stuckRepeats: -5, spillThresholdBytes: 'x' })
  const exec = makeExec('sess-r12')
  const result = okResult([{ type: 'text', text: 'ok' }])
  const decision = { kind: 'accept', content: result.content }

  const returned = await run(handler, exec, result, decision)

  assert.equal(returned, decision, '非法 stuckAction 不是 nudge/stop ⇒ 退回 warn 的零副作用')
  assert.deepEqual(host.waterfalls, [])
  assert.deepEqual(host.emitted, [])
})

// ---------------------------------------------------------------------------
// 同引用契约：什么都没触发
// ---------------------------------------------------------------------------

test('T05-17 一段都没触发：返回同一个对象引用，content 也是同一个数组（R3）', async () => {
  const { host, handler } = startHost()
  const sessionId = 'sess-quiet'
  const content = [{ type: 'text', text: 'ok' }]
  const decision = { kind: 'accept', content }

  const returned = await run(handler, makeExec(sessionId), okResult(content), decision)

  assert.equal(returned, decision, '这是契约，不是优化')
  assert.equal(returned.content, content)
  assert.equal(host.saves.length, 0)
  assert.equal(host.prunings.length, 0)
  assert.deepEqual(host.emitted, [])
})
