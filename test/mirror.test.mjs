import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_CONFIG, TURBO_STATE_VERSION, initState, toView } from '../lib/state.js'

/**
 * 「三处同值」纪律的机检（审计 P1-9）。
 *
 * 默认值只能有一个来源（`lib/state.js · DEFAULT_CONFIG`），包内 `cordis.patch.yml`
 * 是**生效值**来源、必须逐字镜像它。此前这条纪律全靠人工比对 —— 而它在本项目的
 * 历史上已经漂移过多次（0.7.4/0.8.1 的阈值、0.9.2 的新键），所以钉成测试。
 *
 * 不引入 YAML 依赖（本插件零依赖）：只取**非注释行**，标量逐键比字符串，
 * 复合值（数组/对象）只要求键存在。
 */
const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const live = yml
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

/** 取 `key: value` 的那一行（跳过注释行），返回原始值文本（去掉一层引号）。 */
function rawValueOf(key) {
  const match = live.match(new RegExp('^\\s*' + key + ':\\s*(.*?)\\s*$', 'm'))
  if (match === null) return null
  return match[1].replace(/^['"]|['"]$/g, '')
}

/** 复合值（数组/对象）只查键存在，标量值逐字比对。 */
function isCompound(value) {
  return typeof value === 'object' && value !== null
}

test('cordis.patch.yml 逐键镜像 DEFAULT_CONFIG（标量同值、复合键存在）', () => {
  const missing = []
  const mismatch = []
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const raw = rawValueOf(key)
    if (raw === null) {
      missing.push(key)
      continue
    }
    if (isCompound(DEFAULT_CONFIG[key])) continue
    const expected = String(DEFAULT_CONFIG[key])
    if (expected !== raw) mismatch.push(`${key}: DEFAULT_CONFIG=${expected} cordis.patch.yml=${raw}`)
  }
  assert.deepEqual(missing, [], '这些键没有在 cordis.patch.yml 里镜像')
  assert.deepEqual(mismatch, [], '这些键在 cordis.patch.yml 里与默认值不一致')
})

test('cordis.patch.yml 没有 DEFAULT_CONFIG 之外的标量配置键（防手写残留）', () => {
  const extra = []
  for (const line of live.split('\n')) {
    const match = line.match(/^\s{8}([A-Za-z][A-Za-z0-9]*):\s*(.+?)\s*$/)
    if (match === null) continue
    if (!(match[1] in DEFAULT_CONFIG)) extra.push(match[1])
  }
  assert.deepEqual(extra, [], '这些键在 cordis.patch.yml 里但不属于 DEFAULT_CONFIG')
})

test('wire 视图已是 v13 / 37 键，且不含 ledger（持久化账不进 wire）', () => {
  const state = initState({ id: 'session-mirror-test', cwd: 'D:/project' })
  const view = toView(state, DEFAULT_CONFIG)
  assert.equal(view.v, TURBO_STATE_VERSION)
  assert.equal(TURBO_STATE_VERSION, 13)
  assert.equal(Object.keys(view).length, 37)
  assert.equal('ledger' in view, false)
  assert.equal('ledger' in state, true)
  // 0.18.0：群聊（room）与编队（fleet）整块删除，顶层由 newSession 顶上。
  assert.equal('room' in view, false)
  assert.equal('fleet' in view, false)
  assert.equal(typeof view.newSession, 'object')
})
