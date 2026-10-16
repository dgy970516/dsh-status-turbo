#!/usr/bin/env node
/**
 * 校验「装进 profile 的那一份」与仓库同源 —— `node tools/verify-install.mjs [--profile <目录>]`
 *
 * 默认 profile：`D:\deepseek-harness\profiles\desktop`（装好的副本在 `<profile>/node_modules/dsh-status-turbo`）。
 * 断言（全过 exit 0）：
 *   ① 装好的 `package.json` 版本 === 仓库 `package.json` 版本；
 *   ② 装好的 `TURBO_STATE_VERSION` === 客户端 `EXPECTED_V`（两半不会错配）；
 *   ③ 装好的 `DEFAULT_CONFIG` 标量 与 装好的 `cordis.patch.yml` **同值**（镜像纪律，防"改了仓库忘了打包/装了旧包"）；
 *   ④ 装好的 `lib/` 文件清单 === 仓库 `lib/` 文件清单；
 *   ⑤ 装好的 wire 视图是 37 键（0.18.0 删顶层 `room`/`fleet`、加 `newSession`）、不含 `ledger`（水位账不进 wire）；
 *   ⑥ 对着装好的副本跑一遍 `tools/audit-gate.mjs` 须 exit 0。
 *
 * 为什么要有它：安装流程是「npm pack → 拷进 .plugin-specs → 临时放开 pnpm 供应链门 → install → 还原」，
 * 每一步都可能留下"装的是上一版"或"装了没镜像的配置"。这条命令把这些收成一次可重复的核对。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const pi = argv.indexOf('--profile')
const profile = pi >= 0 ? argv[pi + 1] : String.raw`D:\deepseek-harness\profiles\desktop`
const installed = join(profile, 'node_modules', 'dsh-status-turbo')

const fails = []
const ok = (name) => console.log(`✔ ${name}`)
const bad = (name, detail) => {
  fails.push(name)
  console.log(`✘ ${name}${detail ? ` —— ${detail}` : ''}`)
}

if (!existsSync(installed)) {
  console.error(`装好的副本不存在：${installed}`)
  process.exit(2)
}

// ① 版本一致
const repoPkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const instPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
if (repoPkg.version === instPkg.version) ok(`版本一致 ${instPkg.version}`)
else bad('版本一致', `仓库 ${repoPkg.version} ≠ 装好 ${instPkg.version}`)

// ② 两半 wire 版本一致
const state = await import(pathToFileURL(join(installed, 'lib', 'state.js')).href)
const clientSrc = readFileSync(join(installed, 'lib', 'client.js'), 'utf8')
const expected = /EXPECTED_V\s*=\s*(\d+)/.exec(clientSrc)
const hostV = state.TURBO_STATE_VERSION
if (expected && Number(expected[1]) === hostV) ok(`wire 版本两半一致 v${hostV}`)
else bad('wire 版本两半一致', `宿主 v${hostV} vs 客户端 ${expected ? expected[1] : '?'}`)

// ③ DEFAULT_CONFIG 的标量 与 包内 cordis.patch.yml 同值
const yml = readFileSync(join(installed, 'cordis.patch.yml'), 'utf8')
const ymlScalars = new Map()
for (const line of yml.split('\n')) {
  const m = /^\s{6,8}([A-Za-z][A-Za-z0-9_]*):\s*(.+?)\s*$/.exec(line)
  if (m) ymlScalars.set(m[1], m[2])
}
const scalar = (v) =>
  typeof v === 'string' ? `'${v}'` : typeof v === 'boolean' || typeof v === 'number' ? String(v) : null
let checked = 0
for (const [key, value] of Object.entries(state.DEFAULT_CONFIG)) {
  const want = scalar(value)
  if (want === null) continue // 复合值（数组/对象）只查存在
  const got = ymlScalars.get(key)
  checked += 1
  if (got === undefined) bad(`镜像 ${key}`, '包内 cordis.patch.yml 里没有这个键')
  else if (got !== want && got !== String(value)) bad(`镜像 ${key}`, `yml ${got} ≠ 默认 ${want}`)
}
if (!fails.some((f) => f.startsWith('镜像'))) ok(`镜像纪律：${checked} 个标量键与包内 cordis.patch.yml 同值`)

// ④ lib/ 文件清单一致
const list = (dir) => readdirSync(join(dir, 'lib')).sort().join(',')
if (list(repo) === list(installed)) ok(`lib/ 清单一致（${readdirSync(join(installed, 'lib')).length} 个文件）`)
else bad('lib/ 清单一致', `仓库 [${list(repo)}] ≠ 装好 [${list(installed)}]`)

// ⑤ wire 键数与 ledger 不外泄
try {
  const view = state.toView(state.initState({ id: 'session-verify', cwd: repo }), state.DEFAULT_CONFIG)
  const keys = Object.keys(view)
  if (keys.length === 37 && !('ledger' in view)) ok(`wire 视图 ${keys.length} 键、不含 ledger`)
  else bad('wire 视图', `${keys.length} 键${'ledger' in view ? '、且含 ledger' : ''}`)
} catch (error) {
  bad('wire 视图', `toView 调用失败：${error.message}`)
}

// ⑥ 装出去的那份也要过审计闸门（闸门支持 --root，指到装好的副本）
{
  const gate = join(repo, 'tools', 'audit-gate.mjs')
  if (!existsSync(gate)) bad('审计闸门（对着装好的副本跑）', '仓库里没有 tools/audit-gate.mjs')
  else {
    const r = spawnSync(process.execPath, [gate, '--root', installed], { encoding: 'utf8' })
    const lines = String(r.stdout || '').trim().split('\n')
    const failed = lines.filter((l) => l.startsWith('✘'))
    const summary = lines[lines.length - 1] || `exit ${r.status}`
    if (r.status === 0) ok(`审计闸门（对着装好的副本跑）：${summary}`)
    else bad('审计闸门（对着装好的副本跑）', `${summary}${failed.length ? ` —— ${failed.map((l) => l.slice(2)).join('；')}` : ''}`)
  }
}

console.log(`\n${fails.length === 0 ? '全部通过' : `未过 ${fails.length} 条`}`)
process.exit(fails.length === 0 ? 0 : 1)
