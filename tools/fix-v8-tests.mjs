import fs from 'node:fs'

/** 逐条字面量替换；找不到就报出来，绝不静默。 */
function fix(file, pairs) {
  let text = fs.readFileSync(file, 'utf8')
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.log('MISS ' + file + ' :: ' + JSON.stringify(from.slice(0, 70)))
      continue
    }
    text = text.split(from).join(to)
  }
  fs.writeFileSync(file, text, 'utf8')
  console.log('fixed ' + file)
}

// 客户端半的 fixture：wire 版本号 7 → 8，以及那条错配文案里的字面量
fix('test/halves.test.mjs', [
  ['v: 7', 'v: 8'],
  ['客户端 v7', '客户端 v8'],
])
fix('test/ui-contract.test.mjs', [['v: 7', 'v: 8']])

// 宿主半的契约：v8 恰好 35 键（v6 的 enhancement 不动，v8 尾部追加 handoff）
fix('test/state.test.mjs', [
  ['assert.equal(TURBO_STATE_VERSION, 7)', 'assert.equal(TURBO_STATE_VERSION, 8)'],
  ['wire v7：恰好 34 键', 'wire v8：恰好 35 键'],
  ['    ...V6_VIEW_KEYS,\n  ])', '    ...V6_VIEW_KEYS,\n    ...V8_VIEW_KEYS,\n  ])'],
  [
    "assert.equal(Object.keys(view).length, 34, 'v7 只在 enhancement 对象内部加 mode，键数仍 34')",
    "assert.equal(Object.keys(view).length, 35, 'v8 追加 handoff（0.7.0 交接文档自动导出），键数 35')",
  ],
  ['assert.equal(view.v, 7)', 'assert.equal(view.v, 8)'],
  [
    "const V6_VIEW_KEYS = ['enhancement']",
    "const V6_VIEW_KEYS = ['enhancement']\n/** v8（0.7.0 交接文档自动导出）追加的 1 个键：导出状态 + 节流记忆。 */\nconst V8_VIEW_KEYS = ['handoff']",
  ],
])
