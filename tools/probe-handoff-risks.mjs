import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

// ① 二级探测真的能解析到吗？（用插件自己的位置当基准）
const req = createRequire('D:/deepseek-harness/profiles/desktop/node_modules/dsh-status-turbo/lib/index.js')
for (const spec of ['billion-context', 'billion-context/dist/index.js', 'billion-context/package.json']) {
  try {
    console.log('resolve OK    ', spec.padEnd(34), '->', req.resolve(spec))
  } catch (error) {
    console.log('resolve FAIL  ', spec.padEnd(34), '->', error.code || error.message)
  }
}

// ② 三级探测的目标（.bin 里的 .CMD）能不能被 spawn 直接起？
const cmd = 'D:/deepseek-harness/profiles/desktop/node_modules/.bin/bili.CMD'
console.log('\nspawn 目标是否存在:', (await import('node:fs')).existsSync(cmd))
await new Promise((resolve) => {
  let done = false
  const fin = (msg) => { if (!done) { done = true; console.log(msg); resolve() } }
  try {
    // 故意不跑 bili（怕启动代理）：拿一个无害的 .CMD 同型目标试 spawn 语义
    const child = spawn('D:/environment/nodejs_link/npm.cmd', ['--version'], { windowsHide: true, stdio: 'ignore' })
    child.on('error', (error) => fin('spawn .CMD（无 shell）ERROR  ' + (error.code || error.message)))
    child.on('close', (code) => fin('spawn .CMD（无 shell）OK, exit ' + String(code)))
  } catch (error) {
    fin('spawn .CMD（无 shell）THREW  ' + (error.code || error.message))
  }
  setTimeout(() => fin('spawn .CMD（无 shell）超时未结算'), 20000)
})
