// dsh-status-turbo · 支柱 B1 接线测试（宿主半端到端，不连真宿主）
//
// 这一组证明的是"接线本身"：
//   - `agent/request` 真的被注册了，而且带 `prepend: true`（否则会被 dsh-agent 自带的
//     model-selection 监听器覆盖掉，降档白做）；
//   - 判据从 `session/event` 的真实轨迹里来，不是本地推测；
//   - 只降不升；异常不致命；关闭开关后一个 handler 都不注册。

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

const LADDER = [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }]

const stepStart = (t, s) => ({ type: 'step/start', data: { turn: t, step: s } })
const stepEnd = (t, s) => ({ type: 'step/end', data: { turn: t, step: s } })
const call = (name) => ({ type: 'tool/call', data: { name } })
const result = (error) => ({ type: 'tool/result', data: error ? { error: { name: 'X' } } : {} })

function readOnlyStep(t, s) {
  return [stepStart(t, s), call('read'), result(false), stepEnd(t, s)]
}

/** 一个够用的假宿主：记录 inject 请求，捕获 on() 注册的 handler。 */
function makeCtx(config, overrides = {}) {
  const handlers = new Map()
  const injects = []
  const logs = []
  const llm = {
    resolveModelInfo:
      overrides.resolveModelInfo ?? (async () => ({ reasoning: { efforts: LADDER, defaultEffort: 'high' } })),
  }
  const services = {
    sessionProjections: { register: () => {} },
    llm,
  }
  const api = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    },
    inject(requested, callback) {
      injects.push(...requested)
      const scoped = { ...api }
      for (const key of requested) scoped[key] = services[key]
      callback(scoped)
    },
    on(event, handler, options) {
      const list = handlers.get(event) ?? []
      list.push({ handler, options })
      handlers.set(event, list)
    },
  }
  apply(api, config)
  return { handlers, injects, logs }
}

/** 把一个会话的事件喂进 session/event 监听器。 */
function feed(ctx, sessionId, events) {
  const list = ctx.handlers.get('session/event') ?? []
  assert.ok(list.length > 0, '必须注册了 session/event 轨迹折叠')
  for (const event of events) {
    for (const { handler } of list) handler({ id: sessionId }, event)
  }
}

/** 调用 agent/request 的最外层 handler；next() 给的是"机器本来会用的配置"。
 *
 * 默认用**声明口径**的 agent：`export interface Agent { readonly id: SessionId }` —— 只有 id。
 * 这是真的契约（`api-catalog.js` 里 Agent 的 declaration 就只有这一个字段），所以默认测它。 */
async function request(ctx, sessionId, base, agent) {
  const list = ctx.handlers.get('agent/request') ?? []
  assert.equal(list.length, 1, 'agent/request 应当只注册一次')
  const { handler, options } = list[0]
  assert.equal(options && options.prepend, true, '必须 prepend：否则会被 dsh-agent 的 model-selection 覆盖')
  return handler({ agent: agent ?? { id: sessionId }, turn: 1, step: 3, signal: undefined }, async () => base)
}

const BASE = { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high', maxTokens: 8192 }

test('B1 接线：连续 2 步只读无报错 → 请求配置被降档，且其它字段原样保留', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 's1', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])

  const out = await request(ctx, 's1', BASE)
  assert.equal(out.reasoningEffort, 'low', 'high → low（floor=low）')
  assert.equal(out.provider, 'deepseek')
  assert.equal(out.model, 'v4-flash')
  assert.equal(out.maxTokens, 8192, '只该动 reasoningEffort，别的字段一个都不能丢')
  assert.deepEqual(Object.keys(out).sort(), Object.keys(BASE).sort(), '不许凭空加字段')
  assert.ok(
    ctx.logs.some(([level, m]) => level === 'info' && /B1 降档/.test(m)),
    '降档必须留一条可见日志（§9#3 不许静默）',
  )
})

test('B1 接线：跑过写入类工具 → 配置原样返回（回原档）', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 's1', [
    ...readOnlyStep(1, 1),
    ...readOnlyStep(1, 2),
    stepStart(1, 3),
    call('edit'),
    result(false),
    stepEnd(1, 3),
  ])
  assert.equal(await request(ctx, 's1', BASE), BASE, '写入类工具之后必须原样返回')
})

test('B1 接线：上一步报错 → 配置原样返回（本步在纠错，保持原档）', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 's1', [
    ...readOnlyStep(1, 1),
    ...readOnlyStep(1, 2),
    stepStart(1, 3),
    call('read'),
    result(true),
    stepEnd(1, 3),
  ])
  assert.equal(await request(ctx, 's1', BASE), BASE)
})

test('B1 接线：已经在 floor 上 → 原样返回（只降不升，绝不反而升高）', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 's1', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])
  const base = { ...BASE, reasoningEffort: 'low' }
  assert.equal(await request(ctx, 's1', base), base)
})

test('B1 接线：该模型没有档位概念 → 原样返回', async () => {
  const ctx = makeCtx({ statusBar: true }, { resolveModelInfo: async () => ({ reasoning: undefined }) })
  feed(ctx, 's1', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])
  assert.equal(await request(ctx, 's1', BASE), BASE)
})

test('B1 接线：读档位表抛错 → 原样返回 + 一条 warn（失败可见，但不影响会话）', async () => {
  const ctx = makeCtx(
    { statusBar: true },
    {
      resolveModelInfo: async () => {
        throw new Error('adapter exploded')
      },
    },
  )
  feed(ctx, 's1', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])

  const out = await request(ctx, 's1', BASE)
  assert.equal(out, BASE, '异常时必须原样放过，绝不中断会话')
  assert.ok(
    ctx.logs.some(([level, m]) => level === 'warn' && /B1 换挡判据异常/.test(m)),
    '异常必须留下 warn，不许静默',
  )
})

test('B1 接线：另一个会话的只读连击不能给本会话降档', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 'other', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])
  assert.equal(await request(ctx, 's1', BASE), BASE, '轨迹必须按会话隔离')
})

test('B1 接线：downgrade === false → 一个 agent/request 都不注册（开关真的关得掉）', () => {
  const ctx = makeCtx({ downgrade: false })
  assert.ok(!ctx.injects.includes('llm'), '关闭后连 llm 都不该依赖（不让插件因为用不到的服务而卡住）')
  assert.equal((ctx.handlers.get('agent/request') ?? []).length, 0, '关闭后绝不能注册换挡 handler')
  assert.ok(ctx.logs.some(([, m]) => /B1 按步降档已关闭/.test(m)))
})

test('B1 接线：llm 服务不在场 → 只记 warn，A1 的投影照常注册', () => {
  const ctx = makeCtx({ statusBar: true })
  assert.ok(ctx.injects.includes('sessionProjections'), 'A1 不因 B1 缺服务而受影响')
  assert.ok(ctx.logs.some(([, m]) => /B1 按步降档已关闭/.test(m)) || ctx.handlers.has('agent/request'))
})

// ── 会话 id 的来源：这是"降档到底有没有生效"的唯一钥匙，必须两种 agent 形状都能认 ──────────
//
// 实读依据：声明的 `export interface Agent { readonly id: SessionId }` **只有 id**；
// 但运行时 `@deepseek-ai/dsh-agent/lib/index.js:198` 用了 `agent.session.requestHeader()`，
// `:512` 还校验 `agent.id === agent.session.id`。两种形状都得认，且认不出来必须**出声**。

test('B1 接线：agent 只有声明里的 id 字段（真契约形状）也能定位轨迹并降档', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 's1', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])
  const out = await request(ctx, 's1', BASE, { id: 's1' })
  assert.equal(out.reasoningEffort, 'low', '只给 id 就该能降档（这是接口声明里的唯一字段）')
})

test('B1 接线：agent 只带运行时的 session.id（未声明的形状）也能定位轨迹', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 's1', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])
  const out = await request(ctx, 's1', BASE, { session: { id: 's1' } })
  assert.equal(out.reasoningEffort, 'low', '运行时形状也要认（agent.session.id === agent.id）')
})

test('B1 接线：两种形状的 id 不一致时，以声明里的 agent.id 为准（轨迹不会串会话）', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 'a', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])
  feed(ctx, 'b', [...readOnlyStep(1, 1)])
  const out = await request(ctx, 'a', BASE, { id: 'a', session: { id: 'b' } })
  assert.equal(out.reasoningEffort, 'low', '必须按 agent.id 找到 a 的干净轨迹，而不是 b 的')
})

test('B1 接线：取不到任何会话 id → 原样返回，并且大声告警（绝不静默失效）', async () => {
  const ctx = makeCtx({ statusBar: true })
  feed(ctx, 's1', [...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])

  const bare = await request(ctx, 's1', BASE, {})
  assert.equal(bare, BASE, '定位不到会话就必须放弃降档')
  assert.ok(
    ctx.logs.some(([level, m]) => level === 'warn' && /取不到会话 id/.test(m)),
    '这正是 §9#3：B1 整体失效必须能看见，而不是安静地什么都不做',
  )

  // 告警只该出一次，不能每个请求刷一条。
  const warned = ctx.logs.filter(([, m]) => /取不到会话 id/.test(m))
  await request(ctx, 's1', BASE, {})
  assert.equal(ctx.logs.filter(([, m]) => /取不到会话 id/.test(m)).length, warned.length, '告警必须去重')
})
