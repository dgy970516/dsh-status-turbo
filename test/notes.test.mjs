// dsh-status-turbo · 文案层（C2 / C3 / C1 + A2 指纹）的单元测试
//
// 这里要证明的不是"提示能打出来"，而是**它只在判定表说该打的时候打**：
//   - O3  截断风险：read + limit + 文件更长 ⇒ 报"你只看了 N / M 行"+ 绝对路径；
//   - O5  乱码：真实 GBK 样本的特征（散落的替换字符）必须命中；
//   - O6  噪声：真实事故的特征（npm 缓存 JSON 倒进 pwsh 输出）必须命中；
//   - O7  证据校正：命令本该拿得出证据而输出里没有 ⇒ 校正一句；
//   - O8  负例：输出里**有**证据 ⇒ 一个字节都不加（逐字相等）；
//   - O10 指纹：稳定、短、区分不同参数；
//   - U7  面向模型的文案里不得出现实现术语；
//   - G3  任何异常都变成可上报的 fault，绝不 throw、绝不静默吞掉。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  C1_NOTE,
  C2_NOTE,
  C3_MOJIBAKE_NOTE,
  C3_NOISE_NOTE,
  DEFAULT_MOJIBAKE_MIN_RUNS,
  DEFAULT_NOISE_MIN_BYTES,
  DEFAULT_NOISE_RATIO,
  EVIDENCE_DEFAULT_PATTERNS,
  EVIDENCE_REQUIRING_RE,
  NOISE_LINE_RE,
  UNKNOWN_FINGERPRINT,
  aggregateKey,
  analyzeMojibake,
  argumentsOf,
  collectNotes,
  commandOf,
  fingerprint,
  hasEvidence,
  hookFault,
  isHookFault,
  isNoiseLine,
  noiseStats,
  noteTexts,
  readNotesConfig,
  stableJson,
  textOf,
  utf8Bytes,
} from '../lib/notes.js'

const REPLACEMENT = '\uFFFD'
const CONFIG = {} // 显式"什么都不传"：一切走契约冻结值

/** 造一个工具返回（形状同 `{isError, content:[{type:'text',text}]}`）。 */
function resultOf(text, isError = false) {
  return { isError, content: [{ type: 'text', text }] }
}

/** 造一次工具调用（`arguments` 是 JSON 字符串 —— 与日志事件里的形状一致）。 */
function execOf(name, args) {
  return { name, arguments: JSON.stringify(args) }
}

// 真实样本（本机 read 工具实读输出，逐字）：相对路径进、绝对路径 + 总行数出。
const READ_DESIGN_MD = [
  '<path>D:\\project\\dsh-turbo\\docs\\design.md</path>',
  '<content>',
  '1: # dsh-status-turbo 设计说明',
  '2:',
  '3: ## 0. 一句话',
  '4:',
  '5: 把「现在到底卡在哪」变成 composer 上方一行会跳的字。',
  '',
  '(Showing lines 1-5 of 556. Use offset=6 to continue.)',
  '</content>',
].join('\n')

// 真实样本（SPEC O5，逐字）：GBK/CP936 中文被读坏后的典型长相。
// 注意它是**三个孤立的**替换字符（longest === 1、runs === 3），不是连成一片的。
const MOJIBAKE_PATH_SAMPLE = `D:\\project\\huihuoke\\team\\team-鎶${REPLACEMENT}鑳藉疄璺${REPLACEMENT}-鍦ㄦ暟鏅${REPLACEMENT}-102526\\`

test('C2 / O3：read + limit + 文件更长 ⇒ 报"你只看了 N / M 行"+ 绝对路径（真实样本）', () => {
  const exec = execOf('read', { path: 'dsh-turbo/docs/design.md', limit: 5 })
  const result = resultOf(READ_DESIGN_MD)
  const texts = noteTexts(exec, result, CONFIG)

  assert.deepEqual(texts, [
    '你只看了 5 / 556 行（D:\\project\\dsh-turbo\\docs\\design.md）；后面还有内容没读，别基于这个片段下结论。',
  ])
  assert.equal(texts[0], C2_NOTE(5, 556, 'D:\\project\\dsh-turbo\\docs\\design.md'))
  assert.match(texts[0], /你只看了 5 \/ 556 行/)
  assert.match(texts[0], /D:\\project\\dsh-turbo\\docs\\design\.md/, '必须带真实绝对路径')
  assert.doesNotMatch(texts[0], /设计说明/, '文案里不得回抄被判文件的内容')
})

test('C2 / O3：调用方注入的 totalLines 也能用（宿主半取好之后传进来）', () => {
  const exec = execOf('read', { path: 'D:\\x\\a.txt', limit: 1 })
  const result = resultOf('<path>D:\\x\\a.txt</path>\n<content>\n1: a\n</content>')
  const texts = noteTexts(exec, result, { totalLines: 40 })
  assert.deepEqual(texts, ['你只看了 1 / 40 行（D:\\x\\a.txt）；后面还有内容没读，别基于这个片段下结论。'])
})

test('C2 / O3：取不到真实总行数 ⇒ 一个数字都不编（宁可少报）', () => {
  const exec = execOf('read', { path: 'D:\\x\\a.txt', limit: 5 })
  const result = resultOf('<path>D:\\x\\a.txt</path>\n<content>\n1: a\n2: b\n</content>')
  assert.deepEqual(noteTexts(exec, result, CONFIG), [], '没有总行数就不追加，不许猜')
})

test('C2 / O3：offset 已经读到文件末尾（M <= offset + limit）⇒ 不追加', () => {
  const exec = execOf('read', { path: 'D:\\x\\a.txt', limit: 5, offset: 551 })
  const texts = noteTexts(exec, resultOf(READ_DESIGN_MD), CONFIG)
  assert.deepEqual(texts, [], '551 + 5 >= 556 ⇒ 已经是最后一页')
})

test('C2：不是 read / 没有 limit / 是 read 但报错 ⇒ 都不追加', () => {
  assert.deepEqual(noteTexts(execOf('grep', { pattern: 'x' }), resultOf(READ_DESIGN_MD), CONFIG), [])
  assert.deepEqual(noteTexts(execOf('read', { path: 'D:\\x\\a.txt' }), resultOf(READ_DESIGN_MD), CONFIG), [], '没有 limit')
  assert.deepEqual(
    noteTexts(execOf('read', { path: 'D:\\x\\a.txt', limit: 5 }), resultOf(READ_DESIGN_MD, true), CONFIG),
    [],
    'isError === true 的一律不碰',
  )
})

test('C3-a / O5：真实乱码样本（三个散落的替换字符）必须命中，且文案逐字', () => {
  const stats = analyzeMojibake(MOJIBAKE_PATH_SAMPLE)
  assert.deepEqual(stats, { total: 3, runs: 3, longest: 1 }, '真实样本是散落的坏点，不是连成一段')

  const exec = execOf('pwsh', { command: 'Get-ChildItem D:\\project\\huihuoke\\team' })
  const texts = noteTexts(exec, resultOf(`PS D:\\project> Get-ChildItem\n${MOJIBAKE_PATH_SAMPLE}\n`), CONFIG)

  assert.deepEqual(texts, [
    `这段输出里的中文已经损坏（出现 3 处替换字符 ${REPLACEMENT}），路径很可能不可用，别按它继续。`,
  ])
  assert.equal(texts[0], C3_MOJIBAKE_NOTE(3))
})

test('C3-a：连成一片的替换字符命中（PLAN §3.4 的"最长连段"判据）', () => {
  const stats = analyzeMojibake(`bad ${REPLACEMENT}${REPLACEMENT} bytes`)
  assert.deepEqual(stats, { total: 2, runs: 1, longest: 2 })
  assert.deepEqual(noteTexts(execOf('pwsh', { command: 'cat x' }), resultOf(`bad ${REPLACEMENT}${REPLACEMENT} bytes`), CONFIG), [
    C3_MOJIBAKE_NOTE(2),
  ])
})

test('C3-a：只有一个孤立替换字符 ⇒ 不追加（不误报正常输出）', () => {
  const text = `path ${REPLACEMENT} 后面是正常中文`
  assert.deepEqual(analyzeMojibake(text), { total: 1, runs: 1, longest: 1 })
  assert.deepEqual(noteTexts(execOf('pwsh', { command: 'cat x' }), resultOf(text), CONFIG), [])
})

test('C3-a：阈值是参数 —— mojibakeMinRuns 抬高到 4 就不再触发', () => {
  const exec = execOf('pwsh', { command: 'cat x' })
  const result = resultOf(MOJIBAKE_PATH_SAMPLE)
  assert.equal(noteTexts(exec, result, { mojibakeMinRuns: 3 }).length, 1, 'runs === 3，阈值 3 仍然命中')
  assert.deepEqual(noteTexts(exec, result, { mojibakeMinRuns: 4 }), [], '阈值 4 ⇒ 3 个坏点不够')
  assert.equal(readNotesConfig({ mojibakeMinRuns: 0 }).mojibakeMinRuns, DEFAULT_MOJIBAKE_MIN_RUNS, '0 不是有效阈值')
})

// 真实事故的**特征**：一次 pwsh 的输出里混进 npm 缓存 / registry 的 JSON（14 KB 级别）。
// 这里按同样的形状构造，并**逐行记账**，期望值不依赖被测代码。
function npmCachePollution() {
  const target = [
    'PS D:\\project\\dsh-turbo> npm ci',
    '> dsh-turbo@0.4.1 test',
    '> node --test "test/*.test.mjs"',
    'TAP version 13',
    '# Subtest: B1：连续 2 步只读且无报错 → 降档',
    'ok 1 - B1 判据',
    '  ---',
    '  duration_ms: 3.14',
    '  ...',
    '# tests 45',
  ]
  const noisy = []
  for (let i = 0; i < 60; i += 1) {
    noisy.push(`  "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.${i}.tgz": {`)
    noisy.push(`    "integrity": "sha512-${'x'.repeat(40)}",`)
    noisy.push(`    "resolved": "https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.${i}.tgz"`)
    noisy.push('  },')
  }
  return { target, noisy, text: [...target, ...noisy].join('\n') }
}

test('C3-b / O6：真实噪声样本（npm 缓存 JSON 淹没 pwsh 输出）必须命中，且文案逐字', () => {
  const { target, noisy, text } = npmCachePollution()
  const bytes = utf8Bytes(text)
  assert.ok(bytes >= DEFAULT_NOISE_MIN_BYTES, `样本要够大（实际 ${bytes} bytes ≥ 8192）`)

  const stats = noiseStats(text)
  assert.equal(stats.totalLines, target.length + noisy.length)
  assert.equal(stats.noisyLines, noisy.length, '噪声行 = 构造时的 JSON/括号行')
  assert.ok(stats.noisyLines / stats.totalLines >= DEFAULT_NOISE_RATIO, '占比要达标')

  // 命令是 npm ci：不含 test/build/tsc ⇒ 只该有 C3-b 一条，不该顺带 C1。
  const texts = noteTexts(execOf('pwsh', { command: 'npm ci' }), resultOf(text), CONFIG)
  assert.deepEqual(texts, [`这次输出被噪声淹没（${noisy.length} / ${stats.totalLines} 行不是目标输出），换更精确的过滤再跑。`])
  assert.equal(texts[0], C3_NOISE_NOTE(noisy.length, stats.totalLines))
})

test('C3-b：同等体量但都是目标输出 ⇒ 不追加；阈值是参数', () => {
  const exec = execOf('pwsh', { command: 'npm ci' })
  const targetHeavy = Array.from({ length: 250 }, (_, i) => `line ${i}: 处理结果 ${'x'.repeat(20)} 完成`)
  const text = targetHeavy.join('\n')
  assert.ok(utf8Bytes(text) >= DEFAULT_NOISE_MIN_BYTES, '体量仍然超过字节阈值')

  assert.deepEqual(noteTexts(exec, resultOf(text), CONFIG), [], '非目标行占比低 ⇒ 不算被淹没')

  const { text: polluted } = npmCachePollution()
  assert.deepEqual(noteTexts(exec, resultOf(polluted), { noiseRatio: 0.99 }), [], '占比阈值抬到 0.99 ⇒ 不触发')
  assert.deepEqual(noteTexts(exec, resultOf(polluted), { noiseMinBytes: 100000 }), [], '字节阈值抬到 100000 ⇒ 不触发')
})

test('C3-b：B3 已经瘦身过这次返回 ⇒ 跳过噪声统计（PLAN §3.4）', () => {
  const { text } = npmCachePollution()
  const exec = execOf('pwsh', { command: 'npm ci' })
  assert.equal(noteTexts(exec, resultOf(text), { spilled: true }).length, 0)
  assert.equal(readNotesConfig({ spilled: 'yes' }).spilled, false, '只有显式 true 才算')
})

test('NOISE_LINE_RE / isNoiseLine：三条冻结判据 + 真实 JSON 行', () => {
  assert.ok(NOISE_LINE_RE instanceof RegExp, '必须导出，便于直接断言')
  for (const line of ['', '   ', '{', '}', ']', '",', ':  ', 'npm WARN deprecated x@1.0.0', 'npm notice created a lockfile', '+ 12 packages', '+ 3 dependencies']) {
    assert.equal(isNoiseLine(line), true, `应判为噪声：${JSON.stringify(line)}`)
  }
  for (const line of [
    '  "integrity": "sha512-abc",',
    '  "resolved": "https://registry.npmjs.org/x/-/x-1.0.0.tgz"',
    '  "dependencies": {',
    'npm http fetch GET 200 https://registry.npmjs.org/x',
    '1234 timing build:run Completed in 20ms',
  ]) {
    assert.equal(isNoiseLine(line), true, `应判为噪声（真实形态）：${line}`)
  }
  for (const line of ['511 passing', 'ok 1 - B1 判据', '# tests 45', '测试通过：45 项', 'line 0: 处理结果 xx 完成']) {
    assert.equal(isNoiseLine(line), false, `不得判为噪声（那是目标输出）：${line}`)
  }
  // 无状态：连续调用同一条判据结果必须一致（g 标志会带 lastIndex 的坑）。
  assert.equal(isNoiseLine(''), isNoiseLine(''))
})

test('C1 / O7：命令本该拿得出证据而输出里没有 ⇒ 校正一句，且不催任何动作', () => {
  const exec = execOf('pwsh', { command: 'node --test "test/*.test.mjs"' })
  const output = 'Error: Cannot find module \'./missing.js\'\n    at Module._resolveFilename (node:internal/modules)\n'
  const texts = noteTexts(exec, resultOf(output), CONFIG)

  assert.deepEqual(texts, [
    '上一条没有可核对的证据（输出里既没有 exit code: 0，也没有测试/类型检查的成功行），别据此下结论。',
  ])
  assert.equal(texts[0], C1_NOTE())
  assert.doesNotMatch(texts[0], /重试|再来一轮|再跑一次|重新运行/, '不许指示模型再跑一次（O4）')
})

test('C1：命令与证据无关（读文件）⇒ 绝不校正', () => {
  for (const command of ['ls -la', 'cat package.json', 'Get-ChildItem D:\\project', '']) {
    const texts = noteTexts(execOf('pwsh', { command }), resultOf('随便什么输出\n'), CONFIG)
    assert.deepEqual(texts, [], `命令 ${JSON.stringify(command)} 不含 test/build/tsc ⇒ 不该校正`)
  }
})

test('C1：EVIDENCE_REQUIRING_RE 逐字命中 test / vitest / pytest / tsc / build / typecheck / --test', () => {
  for (const command of ['npm test', 'npx vitest run', 'pytest -q', 'tsc --noEmit', 'npm run build', 'npm run typecheck', 'node --test "test/*.test.mjs"']) {
    assert.equal(EVIDENCE_REQUIRING_RE.test(command), true, `应命中：${command}`)
  }
  for (const command of ['npm ci', 'ls -la', 'git status', 'node script.js']) {
    assert.equal(EVIDENCE_REQUIRING_RE.test(command), false, `不该命中：${command}`)
  }
})

test('D9：证据白名单恰好三类，且单参数调用可用（T04 verify 的硬验收）', () => {
  assert.equal(EVIDENCE_DEFAULT_PATTERNS.length, 3, '默认恰 3 条正则源')
  assert.equal(hasEvidence('exit code: 0'), true, '① 退出码成功（单参数调用必须可用）')
  assert.equal(hasEvidence('Command failed'), false, '不能把失败当成证据')

  const samples = [
    ['exit code: 0', true],
    ['exit code 0', true],
    ['# tests 45', true],
    ['# pass 45', true],
    ['45 passing', true],
    ['Tests: 45 passed', true],
    ['Test Suites: 3 passed', true],
    ['ok 1 - B1 判据', true],
    ['Tests: 3 failed', false],
    ['1 failing', false],
    ['Found 0 errors', true],
    ['Build succeeded', true],
    ['Compiled successfully', true],
    ['12 files checked, 0 errors', true],
    ['Done in 1.24s', true],
    ['error TS2322: Type is not assignable', false],
  ]
  for (const [text, expected] of samples) {
    assert.equal(hasEvidence(text), expected, `hasEvidence(${JSON.stringify(text)}) 应为 ${expected}`)
  }
})

test('C1：白名单是参数 —— 传入自定义白名单就按它判（默认三条不再兜底）', () => {
  const exec = execOf('pwsh', { command: 'npm run build' })
  const output = 'BUILD OK\n'
  assert.equal(hasEvidence(output, ['/BUILD OK/']), true)
  assert.deepEqual(noteTexts(exec, resultOf(output), { evidenceWhitelist: ['/BUILD OK/'] }), [], '自定义白名单命中 ⇒ 不校正')
  // 换回默认白名单：同一份输出就不再算"有证据"。
  assert.deepEqual(noteTexts(exec, resultOf(output), CONFIG), [C1_NOTE()])
  // 正则源写成字面量时，标志位被逐字尊重。
  assert.equal(hasEvidence('EXIT CODE: 0', ['/exit code: 0/i']), true)
  assert.equal(hasEvidence('EXIT CODE: 0', ['exit code: 0']), false, '裸源按 /m 编译，不擅自补 i')
  assert.equal(hasEvidence('x', []), false, '空数组 = 没填（回落默认），但不是"命中"')
  assert.equal(readNotesConfig({ evidenceWhitelist: [] }).evidenceWhitelist.length, 3, '空数组回落默认三条')
  assert.equal(readNotesConfig({ evidenceWhitelist: [42, null] }).evidenceWhitelist.length, 3, '全非法也回落')
})

test('O8 负例：输出里有可核对证据 ⇒ 一个字节都不加，输入与输出逐字相等', () => {
  const exec = execOf('pwsh', { command: 'node --test "test/*.test.mjs"' })
  const output = [
    'TAP version 13',
    '# Subtest: B1 判据',
    'ok 1 - B1 判据',
    '# tests 45',
    '# pass 45',
    '# fail 0',
    '',
  ].join('\n')
  const result = resultOf(output)
  const base = [{ type: 'text', text: output }]
  const decision = { kind: 'accept', content: base }

  // 模拟宿主半的追加骨架（PLAN §3.4 @ 297）：null ⇒ 原样放过。
  const note = collectNotes(exec, result, CONFIG)
  const out = note === null ? decision : { kind: 'accept', content: [...decision.content, note] }

  assert.equal(note, null, '有证据 ⇒ 不追加')
  assert.equal(out, decision, '必须返回同一个对象（引用相等）')
  assert.deepEqual(out.content, base, 'content 数组不得被换掉')
  assert.equal(out.content[0].text, result.content[0].text, '逐字相等')
  assert.equal(textOf(out.content), output, '整段文本逐字相等')
})

test('O8 负例（第二条）：exit code: 0 也算证据 —— 泛化到任意命令', () => {
  const exec = execOf('pwsh', { command: 'npm run build' })
  const output = 'vite v5.0.0 building for production...\n✓ built in 1.24s\nDone in 1.24s\n【exit code: 0】\n'
  const result = resultOf(output)
  assert.equal(collectNotes(exec, result, CONFIG), null)
  assert.equal(textOf(result.content), output)
})

test('O4：产物只能是"一个纯 text 块" ⇒ 追加它不可能改变步数', () => {
  const exec = execOf('read', { path: 'D:\\x\\a.txt', limit: 1 })
  const note = collectNotes(exec, resultOf('<path>D:\\x\\a.txt</path>\n<content>\n1: a\n(Showing lines 1-1 of 40. Use offset=2 to continue.)\n</content>'), CONFIG)
  assert.deepEqual(Object.keys(note).sort(), ['text', 'type'], '只许有 type/text 两个键')
  assert.equal(note.type, 'text')
  assert.equal(typeof note.text, 'string')
  assert.equal(note.text, '你只看了 1 / 40 行（D:\\x\\a.txt）；后面还有内容没读，别基于这个片段下结论。')
  assert.doesNotMatch(note.text, /重试|再来一轮|再跑一次|重新运行/)
})

test('多段同时命中：按判定表顺序 C2 → C3-a → C3-b → C1 并进同一个块', () => {
  const { text: polluted } = npmCachePollution()
  const exec = execOf('read', { path: 'D:\\x\\a.txt', limit: 5 })
  const text = `${READ_DESIGN_MD}\n${MOJIBAKE_PATH_SAMPLE}\n${polluted}`
  const texts = noteTexts(exec, resultOf(text), CONFIG)

  assert.equal(texts.length, 3, 'C2 + C3-a + C3-b（read 不触发 C1）')
  assert.match(texts[0], /^你只看了 5 \/ 556 行/)
  assert.match(texts[1], /^这段输出里的中文已经损坏/)
  assert.match(texts[2], /^这次输出被噪声淹没/)

  const note = collectNotes(exec, resultOf(text), CONFIG)
  assert.equal(note.text, texts.join('\n'), '一个块里按顺序分行带上全部触发项')
})

test('A2 / O10：指纹稳定、短、区分不同参数（含 JSON 字符串入参）', () => {
  const args = { path: 'D:\\x\\a.txt', limit: 5 }
  const fp = fingerprint(args)
  assert.match(fp, /^[0-9a-f]{12}$/, '前 12 位十六进制')
  assert.equal(fingerprint(args), fp, '同一份参数 ⇒ 同一个指纹')
  assert.equal(fingerprint(JSON.stringify(args)), fp, 'JSON 字符串入参要解析后再算')
  assert.equal(fingerprint(JSON.stringify({ limit: 5, path: 'D:\\x\\a.txt' })), fp, '键序不影响指纹')
  assert.notEqual(fingerprint({ path: 'D:\\x\\a.txt', limit: 6 }), fp, '参数不同 ⇒ 指纹不同')
  assert.notEqual(fingerprint({ path: 'D:\\x\\b.txt', limit: 5 }), fp)

  assert.equal(fingerprint(null), UNKNOWN_FINGERPRINT)
  assert.equal(fingerprint(undefined), UNKNOWN_FINGERPRINT)
  assert.equal(fingerprint(''), UNKNOWN_FINGERPRINT)
  assert.equal(fingerprint(...[]), UNKNOWN_FINGERPRINT, '缺参等价于 undefined')
  const circular = {}
  circular.self = circular
  assert.equal(fingerprint(circular), UNKNOWN_FINGERPRINT, '序列化不了 ⇒ unknown，绝不 throw')

  assert.equal(aggregateKey('read', args), `read\u0000${fp}`, '聚合键逐字 = name + \\u0000 + fingerprint')
  assert.notEqual(aggregateKey('read', args), aggregateKey('grep', args), '同名参数、不同工具 ⇒ 不同键')
  assert.equal(aggregateKey(undefined, args), `\u0000${fp}`)
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }))
  assert.equal(stableJson({ a: undefined, b: 1 }), '{"b":1}')
})

test('textOf / argumentsOf / commandOf：形状都能防御式摊平', () => {
  assert.equal(textOf('直接字符串'), '直接字符串')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }] }), 'a')
  assert.equal(textOf(undefined), '')
  assert.equal(textOf(42), '')
  assert.equal(textOf([null, { type: 'image' }]), '\n')

  assert.deepEqual(argumentsOf(execOf('read', { limit: 5 })), { limit: 5 })
  assert.deepEqual(argumentsOf({ arguments: { limit: 5 } }), { limit: 5 })
  assert.deepEqual(argumentsOf({ arguments: '不是 JSON' }), {})
  assert.deepEqual(argumentsOf({ arguments: '"字符串"' }), {})
  assert.deepEqual(argumentsOf(undefined), {})

  assert.equal(commandOf(execOf('pwsh', { command: 'npm test' })), 'npm test')
  assert.equal(commandOf(execOf('pwsh', { cmd: 'npm test' })), 'npm test')
  assert.equal(commandOf(execOf('sql_exec', { sql: 'select 1' })), 'select 1')
  assert.equal(commandOf(execOf('read', { path: 'D:\\x' })), '')
})

test('G3：异常 ⇒ 变成可上报的 fault；绝不 throw、绝不静默吞掉', () => {
  const hostile = {}
  Object.defineProperty(hostile, 'arguments', {
    enumerable: true,
    get() {
      throw new Error('boom-arguments')
    },
  })
  const result = resultOf('输出')

  // ① 不传收纳数组：fault 直接交回来（不许静默 return null）
  let fault
  assert.doesNotThrow(() => {
    fault = collectNotes(hostile, result, CONFIG)
  })
  assert.equal(isHookFault(fault), true)
  assert.equal(fault.hook, 'notes')
  assert.equal(typeof fault.at, 'number')
  assert.match(fault.message, /boom-arguments/)

  // ② 传了收纳数组：调用方走上报通道，本层返回 null（不追加任何东西）
  const sink = []
  const before = Date.now()
  assert.equal(collectNotes(hostile, result, CONFIG, sink), null)
  const after = Date.now()
  assert.equal(sink.length, 1)
  // `at` 是 hookFault 内部取的 `Date.now()`（lib/notes.js:560），不是调用方传入的输入：
  // ① 与 ② 是两次独立调用，两次之间时钟必然推进，逐字深比 `at` 会随机差 1 ms。
  // 因此只断言它是数字、且落在本次调用的闭区间内；其余字段仍逐字严格比对。
  assert.equal(typeof sink[0].at, 'number')
  assert.ok(
    sink[0].at >= before && sink[0].at <= after,
    `at=${sink[0].at} 应落在 [${before}, ${after}] 内`,
  )
  assert.deepEqual(
    { ...sink[0], at: 0 },
    { ...fault, at: 0 },
    '除时钟抖动的 at 外，两个 fault 完全一致',
  )

  // fault 与"要追加的文案块"形状可区分
  assert.equal(isHookFault(null), false)
  assert.equal(isHookFault({ type: 'text', text: 'x' }), false)
  assert.equal(isHookFault('x'), false)
  assert.equal(isHookFault(hookFault('notes', new Error('x'), 123).at), false)
  assert.equal(hookFault('notes', new Error('x'), 123).at, 123)
  assert.equal(hookFault('', undefined, 123).hook, 'notes')

  // 正常路径不产生任何 fault
  assert.equal(collectNotes(execOf('pwsh', { command: 'npm ci' }), resultOf('ok\n'), CONFIG, []), null)
})

test('R12：配置非法一律回落契约冻结值，且都能被参数覆盖', () => {
  const d = readNotesConfig(undefined)
  assert.equal(d.mojibakeMinRuns, DEFAULT_MOJIBAKE_MIN_RUNS)
  assert.equal(d.noiseMinBytes, DEFAULT_NOISE_MIN_BYTES)
  assert.equal(d.noiseRatio, DEFAULT_NOISE_RATIO)
  assert.equal(d.evidenceWhitelist.length, 3)
  assert.equal(d.totalLines, null)
  assert.equal(d.absolutePath, null)
  assert.equal(d.spilled, false)

  assert.equal(readNotesConfig('不是对象').mojibakeMinRuns, 2)
  assert.equal(readNotesConfig({ mojibakeMinRuns: -1 }).mojibakeMinRuns, 2)
  assert.equal(readNotesConfig({ mojibakeMinRuns: 1.5 }).mojibakeMinRuns, 2)
  assert.equal(readNotesConfig({ mojibakeMinRuns: 5 }).mojibakeMinRuns, 5)
  assert.equal(readNotesConfig({ noiseMinBytes: 0 }).noiseMinBytes, 8192)
  assert.equal(readNotesConfig({ noiseRatio: 0 }).noiseRatio, 0.5)
  assert.equal(readNotesConfig({ noiseRatio: 1 }).noiseRatio, 1)
  assert.equal(readNotesConfig({ noiseRatio: 1.5 }).noiseRatio, 0.5)
  assert.equal(readNotesConfig({ totalLines: 0 }).totalLines, null)
  assert.equal(readNotesConfig({ totalLines: 12 }).totalLines, 12)
  assert.equal(readNotesConfig({ absolutePath: '' }).absolutePath, null)
  assert.equal(readNotesConfig({ absolutePath: 'D:\\x' }).absolutePath, 'D:\\x')
  assert.equal(utf8Bytes('中文'), 6)
})

test('U7：面向模型的文案里没有实现术语，且本模块零 import、零第三方依赖', () => {
  // 拼出来，避免测试文件自身也留下这些词的字面量。
  const forbidden = new RegExp(['投' + '影', 'projection', 'fiber', 'host', 'ctx', 'slot'].join('|'))
  const visible = [
    C1_NOTE(),
    C2_NOTE(3, 40, 'D:/x/a.txt'),
    C3_MOJIBAKE_NOTE(3),
    C3_NOISE_NOTE(240, 250),
    hookFault('notes', new Error('boom')).message,
  ]
  for (const text of visible) assert.doesNotMatch(text, forbidden, `文案不得含实现术语：${text}`)

  const source = readFileSync(new URL('../lib/notes.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, forbidden, '整个模块都不该出现这些词')
  assert.ok(!/^\s*import\s/m.test(source), '零 import（G1：不加构建步骤、不引第三方包）')
  assert.ok(!/\brequire\s*\(/.test(source), '不得 require')
  assert.ok(!/\bnode:fs\b/.test(source), '不得读文件（T04 forbidden）')
  assert.ok(!source.includes('再跑') || source.includes('换更精确的过滤再跑'), 'C3-b 的措辞只许是 PLAN 冻结的那句')
})

test('C2_NOTE / C3 文案：逐字等于 PLAN 冻结的四条', () => {
  assert.equal(C2_NOTE(3, 40, 'D:/x/a.txt'), '你只看了 3 / 40 行（D:/x/a.txt）；后面还有内容没读，别基于这个片段下结论。')
  assert.equal(C3_MOJIBAKE_NOTE(2), `这段输出里的中文已经损坏（出现 2 处替换字符 ${REPLACEMENT}），路径很可能不可用，别按它继续。`)
  assert.equal(C3_NOISE_NOTE(9, 10), '这次输出被噪声淹没（9 / 10 行不是目标输出），换更精确的过滤再跑。')
  assert.equal(C1_NOTE(), '上一条没有可核对的证据（输出里既没有 exit code: 0，也没有测试/类型检查的成功行），别据此下结论。')
})
