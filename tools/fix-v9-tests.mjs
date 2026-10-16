/**
 * tools/fix-v9-tests.mjs —— 把 wire fixture 从 v8 同步到 v9。
 *
 * 0.8.0 给 wire 视图加了 `rotation` 键（到量轮换）⇒ `TURBO_STATE_VERSION` 8 → 9，
 * 而三个测试文件里写死了 v8 的键数、键名与 `v:` 字面量。
 * （0.7.0 那次 v7→v8 漏同步，一次红了 21 条 —— 所以这一步单独脚本化、逐条打印命中数。）
 */

import { readFileSync, writeFileSync } from 'node:fs'

const edits = [
  ['test/state.test.mjs', [
    ["const V8_VIEW_KEYS = ['handoff']", "const V9_VIEW_KEYS = ['handoff', 'rotation']"],
    ['V8_VIEW_KEYS', 'V9_VIEW_KEYS'],
    ['wire v8：恰好 35 键', 'wire v9：恰好 36 键'],
    [
      "assert.equal(Object.keys(view).length, 35, 'v8 追加 handoff（0.7.0 交接文档自动导出），键数 35')",
      "assert.equal(Object.keys(view).length, 36, 'v9 追加 rotation（0.8.0 到量轮换），键数 36')",
    ],
    ['TURBO_STATE_VERSION, 8', 'TURBO_STATE_VERSION, 9'],
    ['view.v, 8', 'view.v, 9'],
  ]],
  ['test/halves.test.mjs', [
    ['v: 8', 'v: 9'],
    ['客户端 v8', '客户端 v9'],
  ]],
  ['test/ui-contract.test.mjs', [
    ['v: 8', 'v: 9'],
  ]],
]

for (const [file, pairs] of edits) {
  let text = readFileSync(file, 'utf8')
  console.log(`=== ${file}`)
  for (const [from, to] of pairs) {
    const hits = text.split(from).length - 1
    if (hits > 0) text = text.split(from).join(to)
    console.log(`   ${hits} 处  ${JSON.stringify(from)}`)
  }
  writeFileSync(file, text)
}
console.log('\n完成。')
