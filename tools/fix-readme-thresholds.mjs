// tools/fix-readme-thresholds.mjs —— 0.8.1 的配置表镜像（README.md 与 DEFAULT_CONFIG 必须同值）。
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'README.md'
const pairs = [
  [
    '| `handoffExportTokens` | `400000` | 本步输入 token 达到它才考虑导出（1M 窗口的 40%） |',
    '| `handoffExportTokens` | `240000` | 本步输入 token 达到它才考虑导出（**0.8.1 从 400000 降** —— 本机实测体感卡点是 341421） |',
  ],
  [
    '| `handoffExportMinDeltaTokens` | `100000` | 距上次导出又长了这么多才再导 |',
    '| `handoffExportMinDeltaTokens` | `60000` | 距上次导出又长了这么多才再导（**0.8.1 从 100000 降**） |',
  ],
  [
    '| `handoffExportWindowPercent` | `40` | 阈值 = 窗口的百分之多少（窗口已知时）。**token 与字节两个口径共用这一个旋钮** |',
    '| `handoffExportWindowPercent` | `25` | 阈值 = 窗口的百分之多少（窗口已知时）。**token 与字节两个口径共用这一个旋钮**（0.8.1 从 40 降：旧值 40%×1M 恰好等于旧 token 旋钮 ⇒ 不 binding） |',
  ],
  [
    '| `handoffExportBytes` | `3000000` | **字节口径**：模型可见体量达到它就触发（与 token 口径**取或**） |',
    '| `handoffExportBytes` | `1800000` | **字节口径**：模型可见体量达到它就触发（与 token 口径**取或**）；**0.8.1 从 3000000 降** = 240000 × 7.5 |',
  ],
  [
    '| `handoffExportMinDeltaBytes` | `8000000` | 字节口径的节流：距上次导出又长了这么多字节才再导（**0.7.7 从 750000 抬高**） |',
    '| `handoffExportMinDeltaBytes` | `450000` | 字节口径的节流（**0.8.1 从 8000000 降** —— 旧值**大于**阈值，字节口径的第二次导出是条死路） |',
  ],
  [
    '| `rotationArchiveOld` | `true` | 是否归档旧会话（**界面里没有取消归档入口**，日志与席位保留） |',
    '| `rotationFreshMs` | `300000` | 0.8.1：只对新鲜事件触发轮换判据（挡冷启动重放，同 `handoffExportFreshMs`） |\n' +
      '| `rotationArchiveOld` | `false` | 是否归档旧会话（**0.8.1 定为 false**：归档后侧边栏与 `@` 引用读**同一份列表投影** ⇒ `@{old}` 指引会失效；界面里没有取消归档入口） |',
  ],
]

let text = readFileSync(file, 'utf8')
let ok = true
for (const [from, to] of pairs) {
  const hits = text.split(from).length - 1
  if (hits !== 1) {
    ok = false
    console.log(`  ✗ 命中 ${hits} 次（要 1 次）：${JSON.stringify(from.slice(0, 56))}`)
    continue
  }
  text = text.split(from).join(to)
  console.log(`  ✓ ${JSON.stringify(from.slice(0, 48))}`)
}
writeFileSync(file, text)
if (!ok) process.exitCode = 1
