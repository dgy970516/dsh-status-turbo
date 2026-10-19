#!/usr/bin/env node
/**
 * 审计项机检闸门 —— `node tools/audit-gate.mjs [--json]`
 *
 * 来源：`docs/audit-0.9.2.md` 与 `docs/audit-0.9.2-experts-raw.md`（四位专家只读审计）；
 * 0.18.0 起把原 `docs/design-room.md` 的两条换成「群聊/编队已整块删除」的回归闸门。
 * 本文件把其中**可以机械判定**的条目写成断言：每条要么"代码里必须出现"，要么"必须已经消失"。
 * 全过 exit 0；有未过的列出条目名并 exit 1。
 *
 * 故意不检查需要语义判断的条目（性能、竞态、可访问性的"够不够"）—— 那些留在审计报告里人工看。
 * 零依赖、纯读源码，不改任何东西。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `--root <dir>` 可以把闸门指向**别的副本**（例如装进 profile 的那份
 * `node_modules/dsh-status-turbo`），用来证明"装出去的产物同样满足审计项"。
 * 省略时指向本仓库根。
 */
const argv = process.argv.slice(2)
const rootAt = argv.indexOf('--root')
const root = rootAt >= 0 && argv[rootAt + 1]
  ? resolve(argv[rootAt + 1])
  : join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const SRC = {
  client: read('lib/client.js'),
  index: read('lib/index.js'),
  state: read('lib/state.js'),
  handoff: read('lib/handoff.js'),
  rotationHost: read('lib/rotation-host.js'),
  readme: read('README.md'),
  design: read('docs/design.md'),
  packaging: read('docs/packaging.md'),
  docHandoff: read('docs/design-handoff-export.md'),
}

const checks = []
/** 代码里必须出现（条目已落地）。 */
const must = (name, ok) => checks.push({ name, ok: !!ok })
/** 代码里必须已经消失（旧写法被替换掉）。 */
const gone = (name, stillThere) => checks.push({ name, ok: !stillThere })

// ── 前端开发者 ────────────────────────────────────────────────────────────────
must('H4 活动流限长（只取最近 N 条）', /ACTIVITY_LIMIT|slice\(\s*-/.test(SRC.client))
must('H4 活动流条目的 key 用原数组下标（不是倒序渲染下标）', /offset\s*\+\s*index/.test(SRC.client))
must('H5 摘要行补角色/键盘（role=button + tabIndex + onKeyDown）',
  /role:\s*'button'/.test(SRC.client) && /tabIndex/.test(SRC.client) && /onKeyDown/.test(SRC.client))
must('H5 摘要行补 aria-expanded', /aria-expanded/.test(SRC.client))
must('M1 展开态秒级心跳（整秒对齐递归 setTimeout；收起/空闲不挂）', /setTimeout\(tick,\s*CLOCK_TICK_MS/.test(SRC.client) && /collapsed === true \|\| busy !== true/.test(SRC.client))
must('M2 effect 体内先同步开合态再订阅', /setCollapsed\(!isDetailOpen/.test(SRC.client))
must('M4 分区渲染按依赖缓存（memoSection，且真的用在多个分区上）', /function memoSection\(/.test(SRC.client) && (SRC.client.match(/memoSection\(/g) ?? []).length >= 8)
must('M5 版本错配文案走 i18n', /error\.versionMismatch/.test(SRC.client))
gone('M6 时间格式统一到 fmtClock（不再直接 toLocaleTimeString）', /toLocaleTimeString/.test(SRC.client))
must('M9 面板可滚动', /overflowY:\s*'auto'|overflow:\s*'auto'/.test(SRC.client))
must('M9 截断文本补 title', /title:\s*/.test(SRC.client))
must('L7 分区标题有 heading 语义', /role:\s*'heading'|h3/.test(SRC.client))
must('L8 相位标签有 aria-live', /aria-live/.test(SRC.client))
gone('L10 删掉永不命中的死键 rotation.armed', /'rotation\.armed'\s*:/.test(SRC.client))
gone('L11 文案不再写死"8 秒"', /超过\s*8\s*秒|waited > 8s/.test(SRC.client))
must('L11 等待宽限秒数走参数（{grace}）', /\{grace\}/.test(SRC.client))

// ── D2：0.7.0 期设计稿的**正文**不能停在被推翻的旧结论上（勘误横幅不算修好正文）──
must('D2 设计稿开关默认值已更新为 true', /\|\s*`handoffExport`\s*\|\s*`true`\s*\|/.test(SRC.docHandoff))
must('D2 设计稿阈值默认值已更新（240000 / 1800000）',
  /`240000`/.test(SRC.docHandoff) && /`1800000`/.test(SRC.docHandoff))
gone('D2 设计稿不再写 handoffExport: false', /\|\s*`handoffExport`\s*\|\s*`false`\s*\|/.test(SRC.docHandoff))
gone('D2 设计稿不再写旧阈值 400000 / 100000',
  /\|\s*`handoffExportTokens`\s*\|\s*`400000`\s*\|/.test(SRC.docHandoff)
  || /\|\s*`handoffExportMinDeltaTokens`\s*\|\s*`100000`\s*\|/.test(SRC.docHandoff))
gone('D2 设计稿探测链不再是"三条全失败"', /三条全失败|三条都失败/.test(SRC.docHandoff))

// ── 目标硬约束：lib/state.js 必须保持纯（只看代码，注释里提到 Date.now() 不算）────
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
gone('lib/state.js 保持纯（无 Date.now()）', /Date\.now\(/.test(codeOnly(SRC.state)))
gone('lib/state.js 保持纯（无 new Date()）', /new Date\(/.test(codeOnly(SRC.state)))

// ── 后端审计里能机检的另两条（S4 / D1）──────────────────────────────────────
must('S4 createQuietly 防 create 返回 Promise（不留未处理拒绝）',
  /createQuietly[\s\S]{0,1500}?(Promise\.resolve|instanceof Promise|await )/.test(read('lib/rotation-host.js')))
gone('D1 文件头不再谎称「两处副作用都默认关」', /两处副作用都默认关/.test(read('lib/index.js')))

// ── 软件架构师 ────────────────────────────────────────────────────────────────
gone('P0-2 stateSchema 不再是恒等 passthrough', /stateSchema:\s*passthroughSchema/.test(SRC.index))
gone('P1-3 投影折叠热路径不再同步文件 I/O', /readdirSync|mkdirSync|writeFileSync/.test(codeOnly(SRC.index)))
gone('P1-4 gears 不再拿到未合并的原始 config', /registerGears\(ctx,\s*readGearConfig\(config\)\)/.test(SRC.index))
must('P1-4 只有一处合并 DEFAULT_CONFIG 的入口', (SRC.index.match(/\.\.\.DEFAULT_CONFIG/g) ?? []).length === 1)

// ── 后端架构师 ────────────────────────────────────────────────────────────────
must('S6 有 teardown 守卫（dispose 后不再起进程）', /dispose|ctx\.effect\(/.test(SRC.index))
must('S7 超时路径升级 SIGKILL', /SIGKILL/.test(SRC.index) || /SIGKILL/.test(SRC.handoff))
must('S7 管道显式销毁', /destroy\(\)/.test(SRC.index) || /destroy\(\)/.test(SRC.handoff))
must('S10 车道列表读取计入进程上限', /MAX_LANES|laneReads|listLanesCount/.test(SRC.index))
must('S11 运行表按访问序淘汰（LRU）', /touchRuntime|lastUsed|lastAccess/.test(SRC.state))
must('S3 建子会话前查宿主已有子会话', /existingChild|findChild|listChildren/.test(SRC.rotationHost))

// ── 开发者工具工程师 ──────────────────────────────────────────────────────────
must('P1-7 UI 用例至少喂一次真实 toView() 产物', /toView\(/.test(read('test/ui-contract.test.mjs')))
must('P1-10 design.md 补了 0.7 以后的演进', /0\.9\.|0\.8\.|0\.7\./.test(SRC.design))
must('P0-3 packaging.md 的"当前版本"已到 0.9.x', /0\.9\./.test(SRC.packaging))
must('README 配置表含 rotationRequireIdle', /rotationRequireIdle/.test(SRC.readme))
must('README 配置表含 handoffExportMaxPerProcess', /handoffExportMaxPerProcess/.test(SRC.readme))

// ── 0.18.0 群聊与编队整块删除（保留为回归闸门）────────────────────────────────
gone('0.18.0 room.js 已删除（群聊整块移除）', existsSync(join(root, 'lib/room.js')))
gone('0.18.0 room-host.js 已删除（群聊整块移除）', existsSync(join(root, 'lib/room-host.js')))
gone('0.18.0 roster.js 已删除（角色位随群聊移除）', existsSync(join(root, 'lib/roster.js')))
gone('0.18.0 fleet.js 已删除（编队随群聊移除）', existsSync(join(root, 'lib/fleet.js')))
gone('0.18.0 fleet-host.js 已删除（编队随群聊移除）', existsSync(join(root, 'lib/fleet-host.js')))
gone('0.18.0 配置里不再有房间键', /roomEnabled|roomPath|roomLeaseMs|roomTimelineRetention/.test(SRC.state))
gone('0.18.0 wire 不再有 room / fleet 键', /room: roomViewOfSession|fleet: fleetViewOfSession/.test(SRC.state))
must('0.18.0 wire 有开场话术键 newSession', /newSession: newSessionViewOf/.test(SRC.state))
gone('0.18.0 客户端不再引用已删的编队/群聊分区', /fleetSection\(|roomSection\(|ROSTER_TEMPLATES/.test(SRC.client))

// ── 0.9.3 已修的三个 P0（保留为回归闸门）──────────────────────────────────────
must('P0-A 自动轮换的触发点在常驻状态条组件里',
  /TurboStatusBar[\s\S]{0,6000}?executeRotation|executeRotation[\s\S]{0,6000}?TurboStatusBar/.test(SRC.client))
gone('P0-B 水位账不再把 handoff/rotation 整条塞进去', /handoff:\s*entry\.handoff|rotation:\s*entry\.rotation/.test(SRC.state))
must('P0-C 两条主链的测试文件在位',
  existsSync(join(root, 'test/rotation-client.test.mjs')) && existsSync(join(root, 'test/handoff-orchestration.test.mjs')))
must('P0-D design-rotation.md 已按方案 B 定案', /方案 B|0\.9\./.test(read('docs/design-rotation.md')))

const failed = checks.filter((c) => !c.ok)
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total: checks.length, failed: failed.length, checks }, null, 2))
} else {
  for (const c of checks) console.log(`${c.ok ? '✔' : '✘'} ${c.name}`)
  console.log(`\n共 ${checks.length} 条，未过 ${failed.length} 条`)
}
process.exit(failed.length === 0 ? 0 : 1)
