/**
 * 交接导出的执行编排（宿主半 `lib/index.js` 的 `noteHandoff`）：真起进程、真写 `.gitignore`、
 * 真记终态、进程上限真生效。
 *
 * 为何单独一个文件：0.9.2 时这段编排在测试里是 **0 次执行**（同类事故第三次），
 * 原因就是 `spawn` / `existsSync` / `mkdirSync` 全是模块级静态 I/O，测试够不到。
 * `lib/index.js` 现在把这些集中到 `__test.hostIo`，这里整组替换成假的即可驱动真分支。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, handoffStateOf } from '../lib/state.js'
import { HANDOFF_MESSAGE, HANDOFF_STATUS } from '../lib/handoff.js'
import { __test, apply } from '../lib/index.js'

const { hostIo, noteHandoff } = __test

/** 默认值来源唯一：这里只覆盖本次要断言的那几个键。 */
const cfg = (over = {}) => ({ ...DEFAULT_CONFIG, ...over })

/** 显式 bili 路径 + 固定导出目录：探测链与真实文件系统都不参与。 */
const okDir = (over = {}) => ({
  handoffExportBiliBin: 'D:\\fake\\bili.exe',
  handoffExportDir: 'D:\\fake\\handoff',
  ...over,
})

/** 过 isFreshEvent 与 phase 闸的最小 state。 */
function stateFor(sessionId, over = {}) {
  return {
    sessionId,
    phase: 'tool',
    cwd: 'D:\\project\\dsh-turbo',
    stepUsage: { input: 500_000 },
    ...over,
  }
}

const freshEvent = () => ({ time: Date.now() })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 假 bili 进程。`close` 由微任务派发：`runBili` 是 spawn 返回**之后**才注册处理器的，
 * 同步派发会丢事件；微任务正好在注册之后、断言之前。
 */
function fakeSpawn({ code = 0, stdout = '', stderr = '' } = {}) {
  const calls = []
  const spawn = (command, argv, options) => {
    calls.push({ command, argv, options })
    const handlers = {}
    const child = {
      stdout: { on: (event, cb) => { if (event === 'data' && stdout !== '') cb(stdout) } },
      stderr: { on: (event, cb) => { if (event === 'data' && stderr !== '') cb(stderr) } },
      on(event, cb) {
        handlers[event] = cb
        return child
      },
      kill() {},
    }
    queueMicrotask(() => {
      if (typeof handlers.close === 'function') handlers.close(code)
    })
    return child
  }
  spawn.calls = calls
  return spawn
}

/** 整组替换宿主 I/O，返回还原函数与调用流水。 */
function installIo(spawn) {
  const previous = { ...hostIo }
  const seen = { mkdir: [], writeFile: [], readdir: [] }
  hostIo.spawn = spawn
  hostIo.exists = () => true
  hostIo.readdir = (dir) => {
    seen.readdir.push(dir)
    return []
  }
  hostIo.mkdir = (dir) => {
    seen.mkdir.push(dir)
  }
  hostIo.writeFile = (file, text) => {
    seen.writeFile.push({ file, text })
  }
  hostIo.resolveModule = () => {
    throw new Error('显式配了 handoffExportBiliBin，不该走 require 解析')
  }
  hostIo.profileDir = () => 'D:\\fake\\profile'
  hostIo.execPath = 'node'
  return {
    seen,
    restore: () => {
      Object.assign(hostIo, previous)
    },
  }
}

test('宿主：交接导出真跑一次 —— 起进程、建目录写 .gitignore、记终态 DONE 与文档路径', async () => {
  const spawn = fakeSpawn()
  const io = installIo(spawn)
  try {
    const sessionId = 'session-orch-ok'
    noteHandoff(stateFor(sessionId), cfg(okDir()), freshEvent())
    await tick()

    assert.equal(spawn.calls.length, 1, '应该恰好起一次 bili 进程')
    assert.match(spawn.calls[0].command, /bili\.exe$/, 'bili 命令取自配置里的显式路径')
    assert.equal(io.seen.mkdir.length, 1, '导出前必须建目录')
    assert.equal(io.seen.writeFile.length, 1, '目录里必须放一份 .gitignore（P1-7）')
    assert.match(io.seen.writeFile[0].file, /\.gitignore$/)

    const record = handoffStateOf(sessionId)
    assert.equal(record.status, HANDOFF_STATUS.DONE)
    // handoffDir 始终把导出目录挂在 cwd 下（显式 dir 也一样），所以这里只断言"目录 + 会话名 + 扩展名"。
    assert.match(record.path, /[/\\]handoff-session-orch-ok-.*\.md$/, '终态里必须有文档路径')
  } finally {
    io.restore()
  }
})

test('宿主：导出进程退非零 —— 记 FAILED 且 message 带 exit 码', async () => {
  const spawn = fakeSpawn({ code: 1, stderr: 'bili: boom\n' })
  const io = installIo(spawn)
  try {
    const sessionId = 'session-orch-fail'
    noteHandoff(stateFor(sessionId), cfg(okDir()), freshEvent())
    await tick()

    assert.equal(spawn.calls.length, 1)
    const record = handoffStateOf(sessionId)
    assert.equal(record.status, HANDOFF_STATUS.FAILED)
    assert.match(String(record.message), /exit:1/)
  } finally {
    io.restore()
  }
})

test('宿主：handoffExportMaxPerProcess 到量后不再起进程，改记 limit-reached', async () => {
  const spawn = fakeSpawn()
  const io = installIo(spawn)
  try {
    const max = __test.handoffSpawns() + 1
    noteHandoff(stateFor('session-orch-limit-a'), cfg(okDir({ handoffExportMaxPerProcess: max })), freshEvent())
    await tick()
    assert.equal(spawn.calls.length, 1, '第一次刚好用满上限')
    assert.equal(__test.handoffSpawns(), max)

    const before = spawn.calls.length
    noteHandoff(stateFor('session-orch-limit-b'), cfg(okDir({ handoffExportMaxPerProcess: max })), freshEvent())
    await tick()
    assert.equal(spawn.calls.length, before, '到量后不许再起进程')

    const record = handoffStateOf('session-orch-limit-b')
    assert.equal(record.status, HANDOFF_STATUS.FAILED)
    assert.equal(record.message, HANDOFF_MESSAGE.LIMIT_REACHED)
  } finally {
    io.restore()
  }
})

/**
 * `apply` 需要的最小 ctx：`effect` 收集 disposer（S6 走的就是这条路），`on` 落表，
 * 服务一概不给 —— 钩子层与 B1 各自 warn 后不挂载，A1 的投影照常注册。
 */
function fakeHostCtx() {
  const disposers = []
  const handlers = new Map()
  const api = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    inject(requested, callback) {
      const scoped = { ...api }
      if (requested.includes('sessionProjections')) scoped.sessionProjections = { register: () => {} }
      callback(scoped)
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    effect(execute) {
      const stop = execute()
      if (typeof stop === 'function') disposers.push(stop)
    },
  }
  return { api, disposers, handlers }
}

test('宿主 S6：apply 挂且只挂一条 teardown 守卫；跑过之后不再起进程', async () => {
  const { api, disposers } = fakeHostCtx()
  apply(api, cfg(okDir()))
  // 0.18.0：房间/编队两条撤销 effect 随两块功能一起删除，apply 只挂 S6 这一条守卫。
  assert.equal(disposers.length, 1, '必须经 ctx.effect 挂上 teardown 守卫')

  for (const dispose of disposers) dispose() // 模拟插件卸载

  const spawn = fakeSpawn()
  const io = installIo(spawn)
  try {
    await noteHandoff(stateFor('session-orch-disposed'), cfg(okDir()), freshEvent())
    await tick()
    assert.equal(spawn.calls.length, 0, '卸载之后不许再起进程（迟到的回调也算）')
  } finally {
    io.restore()
  }
})

test('宿主 S6：卸载时把在跑的导出进程杀掉', async () => {
  const { api, disposers } = fakeHostCtx()
  apply(api, cfg(okDir()))

  const killed = []
  // 永不自己 close 的假进程：它会一直挂在"在跑"集合里，只有 teardown 能收它。
  // `kill()` 之后才派发 close —— 真进程被杀也是这个顺序（杀掉 ⇒ close 事件 ⇒ 超时定时器被清）。
  const spawn = (command, argv) => {
    const handlers = {}
    const child = {
      stdout: { on() {} },
      stderr: { on() {} },
      on(event, cb) {
        handlers[event] = cb
        return child
      },
      kill() {
        killed.push(argv.join(' '))
        queueMicrotask(() => {
          if (typeof handlers.close === 'function') handlers.close(1)
        })
      },
    }
    return child
  }
  const io = installIo(spawn)
  try {
    const pending = noteHandoff(stateFor('session-orch-kill'), cfg(okDir()), freshEvent())
    await pending
    await tick()
    assert.equal(killed.length, 0, '还没卸载，不该有人被杀')
    disposers[0]()
    assert.equal(killed.length, 1, '卸载必须杀掉在跑的导出进程')
  } finally {
    io.restore()
  }
})

test('宿主 S10：读车道列表也算一次进程 —— 预算只够读列表时，剩下的车道落一条聚合记录', async () => {
  // `active` 是模块级的：上面那条用例卸载过一次，这里重新挂一份（未卸载的）宿主上下文。
  apply(fakeHostCtx().api, cfg(okDir()))
  // 两行都是本会话的车道：主车道 + 一条 `|sub:` 子车道（label 同为会话 id，判据见 lanesFor）。
  const stdout =
    '  session-orch-lanes label=session-orch-lanes [v10] blocks=3 ctx~1.50\n' +
    '  session-orch-lanes|sub:abc label=session-orch-lanes [v10] blocks=2 ctx~1.10\n'
  const spawn = fakeSpawn({ stdout })
  const io = installIo(spawn)
  try {
    const sessionId = 'session-orch-lanes'
    const limit = __test.handoffProcessCount() + 1 // 只够读一次车道列表
    await noteHandoff(
      stateFor(sessionId),
      cfg(okDir({ handoffExportSubLanes: true, handoffExportMaxPerProcess: limit })),
      freshEvent(),
    )
    await tick()

    assert.ok(__test.laneReads() >= 1, '车道列表读取必须计入进程预算')
    assert.equal(spawn.calls.length, 1, '预算只够读列表：一条导出都不许起')
    assert.equal(io.seen.mkdir.length, 0, '没起导出就不该建目录')

    const record = handoffStateOf(sessionId)
    assert.equal(record.status, HANDOFF_STATUS.FAILED)
    assert.equal(record.message, HANDOFF_MESSAGE.LIMIT_REACHED, '被上限挡掉的车道必须留下聚合记录，不许静默')
  } finally {
    io.restore()
  }
})

test('宿主 P1-3：noteHandoff 是异步入口，I/O 失败降级但不 reject、不外抛', async () => {
  apply(fakeHostCtx().api, cfg(okDir())) // 同上：`active` 是模块级的，这里要一份没卸载过的
  const spawn = fakeSpawn()
  const io = installIo(spawn)
  try {
    // 读目录失败 ⇒ 当成"没有既有文档"（不是故障），导出照跑。
    hostIo.readdir = () => Promise.reject(new Error('EACCES: fake'))
    const pending = noteHandoff(stateFor('session-orch-io-read'), cfg(okDir()), freshEvent())
    assert.equal(typeof pending.then, 'function', '折叠热路径上的文件 I/O 必须是异步的（S6/P1-3 的调用契约）')
    await pending // 不 reject 就是这条断言的全部要求
    await tick()
    assert.equal(spawn.calls.length, 1, '读目录失败只该降级成空条目，不该拦下导出')
    assert.equal(io.seen.mkdir.length, 1, '第一次导出必须建目录')

    // P1-3：`.gitignore` 每个目录、每次挂载只写一次 —— 同目录再来一次不再落盘。
    await noteHandoff(stateFor('session-orch-io-read-again'), cfg(okDir()), freshEvent())
    await tick()
    assert.equal(io.seen.mkdir.length, 1, '同一目录第二次导出不许再 mkdir')
    assert.equal(io.seen.writeFile.length, 1, '同一目录第二次导出不许再写 .gitignore')

    // 建目录失败 ⇒ 落 MKDIR_FAILED，仍不 reject、仍不外抛。
    // 换一个导出目录：上面那个已经在本 mount 的缓存里建好了（那正是 P1-3 要的行为）。
    hostIo.mkdir = () => Promise.reject(new Error('EACCES: fake'))
    const sessionId = 'session-orch-io-mkdir'
    await noteHandoff(stateFor(sessionId), cfg(okDir({ handoffExportDir: 'D:\\fake\\handoff-mkdir-fail' })), freshEvent())
    await tick()
    const record = handoffStateOf(sessionId)
    assert.equal(record.status, HANDOFF_STATUS.FAILED)
    assert.equal(record.message, HANDOFF_MESSAGE.MKDIR_FAILED)
  } finally {
    io.restore()
  }
})
