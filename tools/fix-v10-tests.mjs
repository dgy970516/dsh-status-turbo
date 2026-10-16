/**
 * tools/fix-v10-tests.mjs —— 把 wire fixture 从 v9 同步到 v10。
 *
 * 0.9.0 把轮换从 `fork` 改成「宿主建空白会话 + 种子消息」⇒ 轮换记录里多了
 * `childId` / `seedOk` / `message`（仍挂在同一个 `rotation` 键下，**顶层键数不变，还是 36**），
 * `TURBO_STATE_VERSION` 9 → 10、客户端 `EXPECTED_V` 9 → 10。
 *
 * 两个测试文件里写死了 `v: 9` 的 wire fixture（会被客户端的版本闸拦下）、一个文件里写死了
 * 宿主版本常量与键数断言的文案 ⇒ 这里逐条字面替换并打印命中数；**任何一条没命中就非零退出**
 * （0.7.0 那次 v7→v8 漏同步一次红了 21 条，0.8.0 起这一步单独脚本化）。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const edits = [
  ['test/halves.test.mjs', [
    ['v: 9', 'v: 10'],
    ['客户端 v9', '客户端 v10'],
  ]],
  ['test/ui-contract.test.mjs', [
    ['v: 9', 'v: 10'],
  ]],
  ['test/state.test.mjs', [
    ['TURBO_STATE_VERSION, 9', 'TURBO_STATE_VERSION, 10'],
    ['view.v, 9', 'view.v, 10'],
    ['wire v9：恰好 36 键', 'wire v10：恰好 36 键'],
    [
      "'v9 追加 rotation（0.8.0 到量轮换），键数 36'",
      "'v9 追加 rotation（0.8.0 到量轮换）；v10 只在该键内加字段，键数仍 36'",
    ],
    [
      '/** v8（0.7.0 交接文档自动导出）追加的 1 个键：导出状态 + 节流记忆。 */',
      '/** v8（0.7.0 交接文档自动导出）追加的 `handoff` + v9（0.8.0 到量轮换）追加的 `rotation`。v10 只在 `rotation` 对象内加字段，顶层键数不变。 */',
    ],
  ]],
]

let missing = 0
for (const [file, pairs] of edits) {
  const original = readFileSync(file, 'utf8')
  let text = original
  console.log(`=== ${file}`)
  for (const [from, to] of pairs) {
    const hits = text.split(from).length - 1
    if (hits > 0) text = text.split(from).join(to)
    else missing += 1
    console.log(`   ${hits} 处  ${JSON.stringify(from)}`)
  }
  if (text !== original) writeFileSync(file, text)
}

if (missing > 0) {
  console.error(`\n有 ${missing} 条替换没命中 —— fixture 可能已经同步过，或代码形状变了：请人工核对，别当成完成。`)
  process.exit(1)
}
console.log('\n完成。')
