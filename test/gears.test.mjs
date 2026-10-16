// dsh-status-turbo · 支柱 B1 判据的单元测试
//
// 这里要证明的不是"降档能跑通"，而是**它绝不会越界**：
//   - 只降不升（结构保证）；
//   - 不认识的工具不降档；
//   - 报错 / 写入类工具立刻打断连续段；
//   - 新回合清零；
//   - 任何不确定（空列表、当前档不在列表里）一律返回 null（= 原样放过）。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_READ_ONLY_TOOLS,
  judgeDowngrade,
  noteGearEvent,
  pickLowerEffort,
  readGearConfig,
  initSessionGears,
} from '../lib/gears.js'

const RO = new Set(DEFAULT_READ_ONLY_TOOLS)

const stepStart = (turn = 1, step = 1) => ({ type: 'step/start', data: { turn, step } })
const stepEnd = (turn = 1, step = 1) => ({ type: 'step/end', data: { turn, step } })
const call = (name) => ({ type: 'tool/call', data: { name } })
const result = (error) => ({ type: 'tool/result', data: error ? { error: { name: 'X' } } : {} })

/** 折叠一串事件。 */
function fold(events) {
  const rec = initSessionGears()
  for (const e of events) noteGearEvent(rec, e, RO)
  return rec
}

/** 一个"只跑只读工具、无报错"的完整步骤。 */
function readOnlyStep(turn, step) {
  return [stepStart(turn, step), call('read'), result(false), call('grep'), result(false), stepEnd(turn, step)]
}

test('B1：连续 2 步只读且无报错 → 降档；只有 1 步 → 不降档', () => {
  const one = fold(readOnlyStep(1, 1))
  assert.equal(judgeDowngrade(one, { minQuietSteps: 2 }), false, '只有 1 步时不该降档')

  const two = fold([...readOnlyStep(1, 1), ...readOnlyStep(1, 2)])
  assert.equal(judgeDowngrade(two, { minQuietSteps: 2 }), true, '连续 2 步只读无报错应当降档')
})

test('B1：出现写入类工具 → 连续段立刻中断（哪怕之前连着 3 步只读）', () => {
  const rec = fold([
    ...readOnlyStep(1, 1),
    ...readOnlyStep(1, 2),
    ...readOnlyStep(1, 3),
    stepStart(1, 4), call('write'), result(false), stepEnd(1, 4),
  ])
  assert.equal(judgeDowngrade(rec, { minQuietSteps: 2 }), false, '最后一步是写入 ⇒ 必须回原档')
})

test('B1：出现报错 → 连续段立刻中断（上一步报错、本步在纠错，保持原档）', () => {
  const rec = fold([
    ...readOnlyStep(1, 1),
    ...readOnlyStep(1, 2),
    stepStart(1, 3), call('read'), result(true), stepEnd(1, 3),
  ])
  assert.equal(judgeDowngrade(rec, { minQuietSteps: 2 }), false, '最后一步有报错 ⇒ 必须回原档')
})

test('B1：不认识的工具按"可能写"处理，绝不据此降档', () => {
  const rec = fold([
    ...readOnlyStep(1, 1),
    ...readOnlyStep(1, 2),
    stepStart(1, 3), call('some_brand_new_tool'), result(false), stepEnd(1, 3),
  ])
  assert.equal(judgeDowngrade(rec, { minQuietSteps: 2 }), false, '白名单外的工具必须打断连续段（保守方向）')
})

test('B1：没有工具调用的空步是中性的 —— 不计数，也不打断', () => {
  const rec = fold([
    ...readOnlyStep(1, 1),
    stepStart(1, 2), stepEnd(1, 2), // 纯思考步，没调工具
    ...readOnlyStep(1, 3),
  ])
  assert.equal(judgeDowngrade(rec, { minQuietSteps: 2 }), true, '空步不该把两段只读步隔开')
})

test('B1：新回合清零 —— 上一回合的只读连击不能给新任务降档', () => {
  const rec = fold([
    ...readOnlyStep(1, 1),
    ...readOnlyStep(1, 2),
    { type: 'turn/start', data: { turn: 2 } },
    stepStart(2, 1), call('read'), result(false), stepEnd(2, 1),
  ])
  assert.equal(judgeDowngrade(rec, { minQuietSteps: 2 }), false, '新回合必须从原档起步')
})

test('B1：只降不升 —— 目标档位永远严格低于当前档', () => {
  const ladder = [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }]
  const idx = (id) => ladder.findIndex((e) => e.id === id)

  assert.equal(pickLowerEffort(ladder, 'high', 'low'), 'low')
  assert.equal(pickLowerEffort(ladder, 'max', 'low'), 'low')
  assert.equal(pickLowerEffort(ladder, 'low', 'low'), null, '已经在 floor 上 → 不动')
  assert.equal(pickLowerEffort(ladder, 'off', 'low'), null, '已经在最低档 → 绝不升高')
  // 遍历所有组合，验证"要么 null，要么下标严格更小"这个不变量。
  for (const cur of ladder) {
    for (const floor of ['off', 'low', 'high', 'max', 'nonsense']) {
      const target = pickLowerEffort(ladder, cur.id, floor)
      if (target !== null) {
        assert.ok(idx(target) < idx(cur.id), `${cur.id} + floor=${floor} → ${target} 必须严格更低`)
      }
    }
  }
})

test('B1：该模型没公布 floor 这一档 → 退化为"只降一档"，而不是硬塞不认识的值', () => {
  const ladder = [{ id: 'off' }, { id: 'high' }] // 没有 low
  assert.equal(pickLowerEffort(ladder, 'high', 'low'), 'off')
})

test('B1：一切不确定都返回 null（原样放过）', () => {
  assert.equal(pickLowerEffort(undefined, 'high', 'low'), null, '取不到档位表')
  assert.equal(pickLowerEffort([], 'high', 'low'), null, '空档位表')
  assert.equal(pickLowerEffort([{ id: '' }], 'high', 'low'), null, '档位 id 全是空串')
  // 当前档不在列表里 ⇒ 我对这个路由的理解不完整 ⇒ 绝不动它
  assert.equal(pickLowerEffort([{ id: 'low' }, { id: 'max' }], 'high', 'low'), null)
  assert.equal(pickLowerEffort([{ id: 'low' }], 'low', 'low'), null)
})

test('B1：配置读取 —— 非法值一律回落默认，downgrade === false 才关闭', () => {
  const d = readGearConfig(undefined)
  assert.equal(d.enabled, true)
  assert.equal(d.floor, 'low')
  assert.equal(d.minQuietSteps, 2)
  assert.ok(d.readOnlyTools.has('read'))

  assert.equal(readGearConfig({ downgrade: false }).enabled, false)
  assert.equal(readGearConfig({ downgrade: 0 }).enabled, true, '只有显式 false 才关（0 不算）')
  assert.equal(readGearConfig({ downgradeFloor: '' }).floor, 'low')
  assert.equal(readGearConfig({ minQuietSteps: 0 }).minQuietSteps, 2, '0 不是有效的步数')
  assert.equal(readGearConfig({ minQuietSteps: -3 }).minQuietSteps, 2)
  assert.equal(readGearConfig({ minQuietSteps: 1.5 }).minQuietSteps, 2)
  assert.equal(readGearConfig({ minQuietSteps: 4 }).minQuietSteps, 4)
  // 自定义白名单会**替换**默认表，而不是合并
  const custom = readGearConfig({ readOnlyTools: ['peek'] })
  assert.deepEqual([...custom.readOnlyTools], ['peek'])
  // 空数组属于"没填"，回落默认
  assert.ok(readGearConfig({ readOnlyTools: [] }).readOnlyTools.has('read'))
  assert.ok(readGearConfig({ readOnlyTools: [42, ''] }).readOnlyTools.has('read'), '非法元素被过滤后视为未填')
})

test('B1：默认白名单里没有任何会写盘或改状态的工具', () => {
  for (const forbidden of ['bash', 'pwsh', 'edit', 'write', 'sql_exec', 'sql_query', 'docker_ps']) {
    assert.ok(!DEFAULT_READ_ONLY_TOOLS.includes(forbidden), `${forbidden} 绝不能出现在只读白名单里`)
  }
})
