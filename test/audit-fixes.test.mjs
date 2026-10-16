// 审计整改的钉子（P0-2 / P1-4 / S11）。
//
// P0-2：宿主在从持久化行恢复时会调用 `stateSchema.parse(row.val)`（`session-projection/src/index.ts:389`/`:442`），
// 拒了就当没有快照、退回 `init()`。这里钉住"真快照放行 / 形状不对一律拒"。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { turboStateSchema } from '../lib/index.js'
import { initState } from '../lib/state.js'

test('P0-2：真实投影快照原样放行（校验不改写）', () => {
  const state = initState({ id: 'session-schema-probe', cwd: 'D:\\project' })
  assert.equal(turboStateSchema.parse(state), state, '认得出的快照必须原样返回（不做字段清理）')
  assert.equal(typeof state.sessionId, 'string')
  // `turn` / `step` 在新建会话时是 null，不是 0 —— 这条断言是踩过坑留下的。
  assert.ok(state.step === null || typeof state.step === 'number', 'step 必须是 null 或数字')
})

test('P0-2：形状不对的快照一律拒绝（宿主退到 init()）', () => {
  const bad = [
    null,
    undefined,
    0,
    1,
    'x',
    [],
    () => {},
    { sessionId: 's' }, // 缺 phase/step/turn
    { sessionId: 1, phase: 'idle', step: 0, turn: 0 }, // sessionId 不是字符串
    { sessionId: 's', phase: 7, step: 0, turn: 0 },
  ]
  for (const value of bad) {
    assert.throws(
      () => turboStateSchema.parse(value),
      (error) => error instanceof TypeError && /dsh-status-turbo/.test(error.message),
      `应当拒绝：${JSON.stringify(value)}`,
    )
  }
})

test('P0-2：负的 step/turn 拒绝（RangeError）', () => {
  assert.throws(
    () => turboStateSchema.parse({ sessionId: 's', phase: 'idle', step: -1, turn: 0 }),
    (error) => error instanceof RangeError,
  )
  assert.throws(
    () => turboStateSchema.parse({ sessionId: 's', phase: 'idle', step: 0, turn: -2 }),
    (error) => error instanceof RangeError,
  )
})
