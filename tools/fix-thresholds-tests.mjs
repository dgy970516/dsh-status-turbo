// tools/fix-thresholds-tests.mjs
//
// 0.8.1 把五个阈值改成专家推导的那一组（240000 / 1800000 / 25% / 60000 / 450000），
// 测试里所有写死旧值的断言必须同步 —— 本脚本做**字面替换**并逐条报告命中数，
// 任何一条没命中都会让退出码非 0（宁可吵，不可静默漏改）。
//
// 为什么要脚本：这些断言分散在 785 行的 `test/handoff.test.mjs` 与 132 行的
// `test/rotation.test.mjs` 里，手改容易漏；字面替换 + 命中计数是唯一能自证"改全了"的做法。
import { readFileSync, writeFileSync } from 'node:fs'

const edits = [
  [
    'test/handoff.test.mjs',
    [
      // ── watermarkBucket：桶宽 100000 → 60000、字节桶宽 8000000 → 450000 ──
      [
        '  // 桶宽 = handoffExportMinDeltaTokens（默认 100000）',
        '  // 桶宽 = handoffExportMinDeltaTokens（0.8.1 起默认 60000）',
      ],
      [
        '  assert.equal(watermarkBucket(config, { inputTokens: 99_999 }), 0)',
        '  assert.equal(watermarkBucket(config, { inputTokens: 59_999 }), 0)',
      ],
      [
        '  assert.equal(watermarkBucket(config, { inputTokens: 100_000 }), 1)',
        '  assert.equal(watermarkBucket(config, { inputTokens: 60_000 }), 1)',
      ],
      [
        '  assert.equal(watermarkBucket(config, { inputTokens: 410_000 }), 4)',
        '  assert.equal(watermarkBucket(config, { inputTokens: 410_000 }), 6)',
      ],
      [
        '  // 字节桶：0.7.7 起默认宽度 8000000 ⇒ 3 MB 落在桶 0',
        '  // 字节桶：0.8.1 起默认宽度 450000 ⇒ 3 MB 落在桶 6',
      ],
      [
        '  assert.equal(watermarkBucket(config, { payloadBytes: 3_000_000 }), 0)',
        '  assert.equal(watermarkBucket(config, { payloadBytes: 3_000_000 }), 6)',
      ],
      [
        '  assert.equal(watermarkBucket(config, { payloadBytes: 8_000_000 }), 1)',
        '  assert.equal(watermarkBucket(config, { payloadBytes: 8_000_000 }), 17)',
      ],
      [
        '  assert.equal(watermarkBucket(config, { payloadBytes: 48_000_000 }), 6)',
        '  assert.equal(watermarkBucket(config, { payloadBytes: 48_000_000 }), 106)',
      ],
      [
        '  assert.equal(watermarkBucket(config, { inputTokens: 410_000, payloadBytes: 6_000_000 }), 4)',
        '  assert.equal(watermarkBucket(config, { inputTokens: 410_000, payloadBytes: 6_000_000 }), 13)',
      ],
      [
        '  assert.equal(watermarkBucket(config, { inputTokens: 900_000, payloadBytes: 100 }), 9)',
        '  assert.equal(watermarkBucket(config, { inputTokens: 900_000, payloadBytes: 100 }), 15)',
      ],
      [
        "  assert.equal(watermarkBucket(cfg({ handoffExportMinDeltaTokens: 'x' }), { inputTokens: 250_000 }), 2)",
        "  assert.equal(watermarkBucket(cfg({ handoffExportMinDeltaTokens: 'x' }), { inputTokens: 250_000 }), 4)",
      ],
      // ── effectiveThreshold：400000 → 240000、40% → 25% ──
      [
        `  assert.equal(effectiveThreshold({ config }), 400000, '没有窗口 ⇒ 绝对阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 0 }), 400000)
  assert.equal(effectiveThreshold({ config, contextWindow: Number.NaN }), 400000)
  assert.equal(effectiveThreshold({ config, contextWindow: 1_000_000 }), 400000, '1M 的 40% 正好等于绝对阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 8_000_000 }), 400000, '大窗口不放大阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 128_000 }), 51200, '小窗口 ⇒ 40% = 51200')`,
        `  assert.equal(effectiveThreshold({ config }), 240000, '没有窗口 ⇒ 绝对阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 0 }), 240000)
  assert.equal(effectiveThreshold({ config, contextWindow: Number.NaN }), 240000)
  assert.equal(effectiveThreshold({ config, contextWindow: 1_000_000 }), 240000, '1M 的 25% = 250000 高于绝对阈值 ⇒ 取绝对阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 8_000_000 }), 240000, '大窗口不放大阈值')
  assert.equal(effectiveThreshold({ config, contextWindow: 128_000 }), 32000, '小窗口 ⇒ 25% = 32000')`,
      ],
      ["    51200,\n    '脏比例回落默认 40',", "    32000,\n    '脏比例回落默认 25',"],
      // ── shouldExport：小窗口回归 ──
      [
        `  assert.equal(shouldExport({ config, inputTokens: 40_000, contextWindow: 128_000 }), false)
  assert.equal(shouldExport({ config, inputTokens: 51_200, contextWindow: 128_000 }), true)
  assert.equal(shouldExport({ config, inputTokens: 51_200 }), false, '没有窗口时仍按绝对阈值 400000')`,
        `  assert.equal(shouldExport({ config, inputTokens: 31_999, contextWindow: 128_000 }), false)
  assert.equal(shouldExport({ config, inputTokens: 32_000, contextWindow: 128_000 }), true)
  assert.equal(shouldExport({ config, inputTokens: 51_200 }), false, '没有窗口时仍按绝对阈值 240000')`,
      ],
      // ── planHandoff：桶号 4 → 6（410000 / 60000） ──
      ['    bucket: 4,', '    bucket: 6,'],
      [
        "  assert.equal(planHandoff({ ...base, inputTokens: 399_999 }).action, 'none')",
        "  assert.equal(planHandoff({ ...base, inputTokens: 239_999 }).action, 'none')",
      ],
      ['  assert.equal(fresh.bucket, 4)', '  assert.equal(fresh.bucket, 6)'],
      ["handoff-s_1-4-20261011-0300.md", "handoff-s_1-6-20261011-0300.md"],
      ["handoff-s_1-4-20261011-0000.md", "handoff-s_1-6-20261011-0000.md"],
      // ── 0.7.3 默认值 ──
      [
        '  assert.equal(DEFAULT_CONFIG.handoffExportWindowPercent, 40)',
        "  assert.equal(DEFAULT_CONFIG.handoffExportWindowPercent, 25, '0.8.1 从 40 降到 25')",
      ],
      // ── effectiveByteThreshold ──
      [
        `  assert.equal(effectiveByteThreshold({ config }), 3_000_000)
  assert.equal(effectiveByteThreshold({ config, contextWindow: 1_000_000 }), 3_000_000, '1M × 40% × 7.5 正好等于绝对阈值')
  assert.equal(effectiveByteThreshold({ config, contextWindow: 8_000_000 }), 3_000_000, '大窗口不放大')
  assert.equal(effectiveByteThreshold({ config, contextWindow: 128_000 }), 384_000, '小窗口按比例收紧')
  assert.equal(effectiveByteThreshold({ config, contextWindow: -1 }), 3_000_000, '脏窗口回落绝对阈值')`,
        `  assert.equal(effectiveByteThreshold({ config }), 1_800_000)
  assert.equal(effectiveByteThreshold({ config, contextWindow: 1_000_000 }), 1_800_000, '1M × 25% × 7.5 = 1875000 高于绝对阈值 ⇒ 取绝对阈值')
  assert.equal(effectiveByteThreshold({ config, contextWindow: 8_000_000 }), 1_800_000, '大窗口不放大')
  assert.equal(effectiveByteThreshold({ config, contextWindow: 128_000 }), 240_000, '小窗口按比例收紧')
  assert.equal(effectiveByteThreshold({ config, contextWindow: -1 }), 1_800_000, '脏窗口回落绝对阈值')`,
      ],
      ["    384_000,\n    '脏比例回落默认 40',", "    240_000,\n    '脏比例回落默认 25',"],
      // ── shouldExport：两口径取或（字节 delta 8 MB → 死路，改 450000） ──
      [
        `  // 0.7.7 起 delta 默认 8 MB ⇒ 涨 11 MB 才再导一次
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 8_000_000, lastPayloadBytes: 3_000_000 }), false)
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 11_000_000, lastPayloadBytes: 3_000_000 }), true)`,
        `  // 0.8.1 起 delta 默认 450000（旧值 8000000 **大于**字节阈值 3000000 ⇒ 第二次导出是死路）
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 3_449_999, lastPayloadBytes: 3_000_000 }), false)
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 3_450_000, lastPayloadBytes: 3_000_000 }), true)`,
      ],
      [
        `  // 窗口收紧后的字节阈值同样生效：128k 窗口 ⇒ 384000
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 400_000, contextWindow: 128_000 }), true)
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 383_999, contextWindow: 128_000 }), false)`,
        `  // 窗口收紧后的字节阈值同样生效：128k 窗口 ⇒ 240000
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 400_000, contextWindow: 128_000 }), true)
  assert.equal(shouldExport({ config, inputTokens: 1000, payloadBytes: 239_999, contextWindow: 128_000 }), false)`,
      ],
      // ── 0.7.4 默认值 + 0.8.1 新键 ──
      [
        "  assert.equal(DEFAULT_CONFIG.handoffExportBytes, 3_000_000)\n  assert.equal(DEFAULT_CONFIG.handoffExportMinDeltaBytes, 8_000_000, '0.7.7 从 750000 抬到 8000000')",
        "  assert.equal(DEFAULT_CONFIG.handoffExportBytes, 1_800_000, '0.8.1 从 3000000 降到 1800000')\n  assert.equal(DEFAULT_CONFIG.handoffExportMinDeltaBytes, 450_000, '0.8.1 从 8000000 降到 450000（旧值大于阈值 ⇒ 死路）')",
      ],
      [
        "  assert.equal(positiveInt(undefined, 'handoffExportBytes'), 3_000_000)\n  assert.equal(positiveInt(0, 'handoffExportMinDeltaBytes'), 8_000_000, '0 非法 ⇒ 回落默认')",
        "  assert.equal(positiveInt(undefined, 'handoffExportBytes'), 1_800_000)\n  assert.equal(positiveInt(0, 'handoffExportMinDeltaBytes'), 450_000, '0 非法 ⇒ 回落默认')",
      ],
      [
        "test('0.7.4 新键的默认值', () => {",
        `test('0.7.4 / 0.8.1 新键的默认值', () => {
  assert.equal(DEFAULT_CONFIG.handoffExportTokens, 240_000, '0.8.1 从 400000 降到 240000')
  assert.equal(DEFAULT_CONFIG.handoffExportMinDeltaTokens, 60_000, '0.8.1 从 100000 降到 60000')
  assert.equal(DEFAULT_CONFIG.rotationFreshMs, 300_000, '0.8.1 轮换也吃同一把冷启动闸')`,
      ],
    ],
  ],
  [
    'test/rotation.test.mjs',
    [
      [
        '  // 窗口收紧后小窗口照样成立：128k 窗口 ⇒ token 阈值 51200',
        '  // 窗口收紧后小窗口照样成立：128k 窗口 ⇒ token 阈值 32000（0.8.1 起 25%）',
      ],
      [
        '  assert.equal(shouldRotate({ ...base, inputTokens: 60_000, payloadBytes: 0, contextWindow: 128_000 }), true)',
        '  assert.equal(shouldRotate({ ...base, inputTokens: 32_000, payloadBytes: 0, contextWindow: 128_000 }), true)',
      ],
      [
        '  assert.equal(shouldRotate({ ...base, inputTokens: 50_000, payloadBytes: 0, contextWindow: 128_000 }), false)',
        '  assert.equal(shouldRotate({ ...base, inputTokens: 31_999, payloadBytes: 0, contextWindow: 128_000 }), false)',
      ],
      [
        '  assert.equal(shouldRotate({ ...base, inputTokens: 1, payloadBytes: 3_000_000 }), true)',
        '  assert.equal(shouldRotate({ ...base, inputTokens: 1, payloadBytes: 1_800_000 }), true)',
      ],
    ],
  ],
]

let allFound = true
for (const [file, pairs] of edits) {
  let text = readFileSync(file, 'utf8')
  console.log(`=== ${file}`)
  for (const [from, to] of pairs) {
    const hits = text.split(from).length - 1
    if (hits === 0) {
      allFound = false
      console.log(`  ✗ 没命中：${JSON.stringify(from.slice(0, 64))}`)
      continue
    }
    text = text.split(from).join(to)
    console.log(`  ✓ ${hits} 处：${JSON.stringify(from.slice(0, 48))}`)
  }
  writeFileSync(file, text)
}
if (!allFound) {
  console.error('\n有断言没命中 —— 先修脚本，别信这次结果。')
  process.exitCode = 1
}
