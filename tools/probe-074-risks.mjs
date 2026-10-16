import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

// ── ① profileDirOf() 的落点（复刻 lib/index.js 里的写法）──
const selfUrl = 'file:///D:/deepseek-harness/profiles/desktop/node_modules/dsh-status-turbo/lib/index.js'
const selfPath = 'D:\\deepseek-harness\\profiles\\desktop\\node_modules\\dsh-status-turbo\\lib\\index.js'
const profileDir = dirname(dirname(dirname(selfPath)))
console.log('① profileDirOf() 返回  :', profileDir)
console.log('   真 profile 根目录    : D:\\deepseek-harness\\profiles\\desktop')
const tier3 = join(profileDir, 'node_modules', 'billion-context', 'dist', 'index.js')
const tier3correct = join('D:\\deepseek-harness\\profiles\\desktop', 'node_modules', 'billion-context', 'dist', 'index.js')
console.log('   三级拼出来的路径     :', tier3, '→ exists =', existsSync(tier3))
console.log('   本该拼出来的路径     :', tier3correct, '→ exists =', existsSync(tier3correct))
void selfUrl

// ── ② 字节账 JSON.stringify 的代价（重放路径上每事件一次）──
const blob = 'x'.repeat(2000)
const sample = { type: 'tool/result', seq: 1, time: 1, data: { callId: 'c', result: Array.from({ length: 20 }, () => blob) } }
const perEvent = JSON.stringify(sample).length
const N = 4000 // ≈ 4000 个大事件
const t0 = performance.now()
let total = 0
for (let i = 0; i < N; i += 1) total += JSON.stringify(sample).length
const ms = performance.now() - t0
console.log('\n② 单事件 ≈', perEvent, 'B；序列化', N, '条 =', (total / 1048576).toFixed(1), 'MB 用时', ms.toFixed(0), 'ms')
console.log('   吞吐 ≈', (total / 1048576 / (ms / 1000)).toFixed(0), 'MB/s ⇒ 100 MB 日志 ≈', (100 / (total / 1048576 / (ms / 1000))).toFixed(1), 's')

// ── ③ 本机 sessions 目录的体量（重放要走多少字节）──
const root = 'D:\\deepseek-harness\\sessions'
let sum = 0
const rows = []
for (const group of readdirSync(root)) {
  const gp = join(root, group)
  let st
  try {
    st = statSync(gp)
  } catch {
    continue
  }
  if (!st.isDirectory()) continue
  for (const sess of readdirSync(gp)) {
    const log = join(gp, sess, 'session.v4.jsonl.zstd')
    try {
      const size = statSync(log).size
      sum += size
      rows.push([size, sess.slice(0, 46)])
    } catch {
      /* 没日志的会话跳过 */
    }
  }
}
rows.sort((a, b) => b[0] - a[0])
console.log('\n③ sessions 日志总数 =', rows.length, '份，合计', (sum / 1048576).toFixed(1), 'MB')
for (const [size, name] of rows.slice(0, 6)) console.log('   ', (size / 1048576).toFixed(1).padStart(7), 'MB  ', name)
