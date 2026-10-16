/**
 * 一次性脚本（0.9.1）：把到量轮换的默认模式从 `manual` 改成 `auto`。
 *
 * 为什么用脚本而不是逐个编辑：同一处语义要在四处（默认值 / 包内 patch / README 表 / 测试断言）
 * 逐字一致，字面替换能逐条报告命中数，未命中即非零退出，不会"改了一半还继续打包"。
 *
 * 用法：`node tools/set-rotation-auto.mjs`（幂等：已改过就会报"未命中"并退出 1，属预期）。
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 逐文件、逐条字面替换。每条必须是**恰好一处**命中，否则整轮失败。 */
const jobs = [
  [
    'lib/state.js',
    [
      [
        `   * 0.8.0 轮换模式：\`off\`（不做）/ \`manual\`（默认：面板出现一行 + 按钮，由用户点）/ \`auto\`（到量自动跑）。
   *
   * 为什么默认 \`manual\`：0.7.x 的实测教训 —— 我原以为 8 MB 的节流够稀疏，结果一天写掉 64 份文档；
   * 而轮换比写文档更不可逆（DSH 界面里**没有取消归档入口**，见 docs/design-rotation.md 约束 3）。
   * 先用 manual 跑一天看它在什么量级触发，再切 \`auto\`。
   */
  rotation: 'manual',`,
        `   * 0.8.0 轮换模式：\`off\`（不做）/ \`manual\`（面板出现一行 + 按钮，由用户点）/ \`auto\`（到量自动跑）。
   *
   * **0.9.1 默认改成 \`auto\`（用户拍板）**：0.8.1 曾把默认压成 manual，理由是"轮换不可逆"
   * （当年 fork 完会归档旧会话，而 DSH 界面里没有取消归档入口）。0.9.0 换成方案 B 之后这条
   * 理由已不成立：既不 fork、也不归档（\`rotationArchiveOld: false\`），轮换的全部后果只是
   * **多出一个空白会话** —— 忽略它没有任何损失；而漏掉轮换的代价是继续背着全部历史，直到
   * bili preflight 拒发。所以默认全自动；需要人工确认的场合再显式设成 \`manual\`。
   * 注意非法值也回落到这个默认值（\`lib/rotation.js · rotationMode\`）：模式名写错会得到 \`auto\`。
   */
  rotation: 'auto',`,
      ],
    ],
  ],
  [
    'cordis.patch.yml',
    [
      [
        `        # off / manual（默认：面板一行 + 按钮）/ auto（到量自动跑）。
        # 默认 manual 是刻意的：归档在界面里不可逆（没有取消归档入口），先用 manual 观察触发量级。
        rotation: 'manual'`,
        `        # off / manual（面板一行 + 按钮，点了才切）/ auto（到量自动跑）。
        # 0.9.1 默认改成 auto（用户拍板）：方案 B 既不 fork 也不归档（rotationArchiveOld: false），
        # 轮换的后果只是多出一个空白会话；漏掉轮换却会继续背全部历史到 bili preflight 拒发。
        rotation: 'auto'`,
      ],
    ],
  ],
  [
    'README.zh.md',
    [
      [
        "| `rotation` | `'manual'` | 到量轮换模式：`off` / `manual`（面板一行 · 可点）/ `auto`。**默认 manual** |",
        "| `rotation` | `'auto'` | 到量轮换模式：`off` / `manual`（面板一行 · 可点）/ `auto`。**默认 auto（0.9.1 起）** |",
      ],
      [
        "想要全自动就把 `rotation` 设成 `'auto'`。",
        "**0.9.1 起默认就是全自动（`rotation: 'auto'`）**；想改成「先给我看一行、点了才切」就把 `rotation` 设成 `'manual'`。",
      ],
    ],
  ],
  [
    'test/rotation.test.mjs',
    [
      [
        "  assert.equal(rotationMode(cfg({ rotation: 'nope' })), 'manual')",
        "  assert.equal(rotationMode(cfg({ rotation: 'nope' })), 'auto', '非法值回落默认（0.9.1 起为 auto）')",
      ],
      [
        `  assert.equal(rotationMode(undefined), 'manual')
  assert.equal(rotationMode(null), 'manual')
  assert.equal(DEFAULT_CONFIG.rotation, 'manual', '0.8.0 默认 manual（用户拍板）')`,
        `  assert.equal(rotationMode(undefined), 'auto')
  assert.equal(rotationMode(null), 'auto')
  assert.equal(DEFAULT_CONFIG.rotation, 'auto', '0.9.1 默认 auto（用户拍板）')`,
      ],
      [
        "  assert.equal(rotationStateOf(id).mode, 'manual', '非法 mode 回落 manual')",
        "  assert.equal(rotationStateOf(id).mode, 'auto', '非法 mode 回落默认（0.9.1 起为 auto）')",
      ],
    ],
  ],
]

let misses = 0
for (const [file, pairs] of jobs) {
  let text = readFileSync(file, 'utf8')
  for (const [from, to] of pairs) {
    const hits = text.split(from).length - 1
    const label = JSON.stringify(from.replace(/\s+/g, ' ').slice(0, 52))
    console.log(`${hits === 1 ? '✓' : '✗'} ${file} ← ${label} 命中 ${hits}`)
    if (hits !== 1) {
      misses += 1
      continue
    }
    text = text.replace(from, to)
  }
  writeFileSync(file, text)
}

// CHANGELOG 新小节插在最上面那个 `## [` 之前。
const changelog = readFileSync('CHANGELOG.md', 'utf8')
if (!changelog.includes('## [0.9.1]')) {
  const at = changelog.indexOf('\n## [')
  const section = `
## [0.9.1] —— 轮换默认全自动（\`rotation: 'auto'\`）

0.8.1 把轮换默认压成 \`manual\` 的理由是"轮换不可逆"（fork 完会归档旧会话，而界面里没有取消归档入口）。
0.9.0 换成方案 B 之后既不 fork 也不归档，轮换的全部后果只是**多出一个空白会话** —— 忽略它没有任何损失；
而漏掉轮换的代价是继续背着全部历史直到 bili preflight 拒发。所以**默认改成 \`auto\`**：到量即自动开新会话，
并把旧会话 id 写进新会话的首条 \`user/message\`。需要人工确认的场合显式设 \`rotation: 'manual'\`。

三处同值：\`lib/state.js · DEFAULT_CONFIG\`、包内 \`cordis.patch.yml\`、\`README.zh.md\` 配置表。
\`lib/rotation.js · rotationMode\` 对非法模式名回落的正是这个默认值（模式名写错会得到 \`auto\`）。
`
  readFileSync('CHANGELOG.md')
  writeFileSync('CHANGELOG.md', changelog.slice(0, at + 1) + section + changelog.slice(at + 1))
  console.log('✓ CHANGELOG.md 插入 [0.9.1] 小节')
} else {
  console.log('· CHANGELOG.md 已有 [0.9.1]，跳过')
}

console.log(misses === 0 ? '全部替换成功' : `有 ${misses} 处未命中`)
process.exit(misses === 0 ? 0 : 1)
