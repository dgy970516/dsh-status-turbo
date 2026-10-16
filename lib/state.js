/**
 * dsh-status-turbo — 支柱 A1 的纯函数核心：把会话日志折叠成"现在卡在哪"。
 *
 * 设计纪律（见 docs/design.md）：
 *  - 本文件**不 import 任何运行时依赖**（只用 `node:crypto` 算 A2 的参数指纹），不碰时间（除事件自带的
 *    `event.time`）；**全文禁止 `Date.now()`** —— `hookFaults` / `lastSpill` 的时间戳一律由钩子层给出
 *    （PLAN.md §3.8）。它可以在 Node、在宿主、在测试里以完全相同的方式运行。
 *  - `applyEvent` 对不关心的事件**返回同一个 state 引用**（`Object.is` 不变 ⇒ 投影下游零成本，
 *    见 @deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:26）。
 *  - 只读已 commit 的日志事件；不读宿主内部状态、不爬 DOM。
 *
 * **单挂载假设（P1-5，记录在案）**：本文件有一个模块级的 per-session 运行时表 `runtimeBySession`
 * （见下面 `MAX_RUNTIME_SESSIONS` 附近），按 `state.sessionId` 键存 `hookFaults` / `lastSpill` /
 * `enhancement` / `handoff` / `rotation`。折叠本身是无状态的（`applyEvent` 只吃 `state` + `event`），
 * 唯独这张表必须活在某处：写它的 `pushHookFault` / `pushSpill` / `pushEnhancement` 是本模块导出、
 * 由 `lib/index.js` 在折叠路径与工具返回钩子里**以自由函数**调用的，没有承载 per-mount 句柄的对象
 * （`view` 只拿得到 `state`）。所以这里按「**一个进程里本插件只挂载一次**」设计：同一进程挂第二次
 * 会让两个 mount 共用这张表。宿主 profile 实际只挂一次；真要多挂载，得先把这张表改成 `ctx` 上
 * 的 per-mount 实例 —— 那是一次破坏性的 API 重构（本模块全部导出签名都要带句柄），不在 0.9.3 做。
 * `lib/index.js` 侧所有能安全收进 `apply` 闭包的模块级状态（`ctx0` / `effective0` / 交接进程账 /
 * `lastRotationArmedAt` / `warned*` / `stuckRuns`）已经收进 per-mount 的 `run` 对象。
 *
 * 事件来源均为实读确认（`@deepseek-ai/dsh-agent-loop/lib/index.js`）：
 *  `turn/start` :943、`step/start` :968、`step/end` :992、
 *  `tool/call` :682（**工具执行前** commit）、`tool/result` :697（结算时 commit）。
 */

import { createHash } from 'node:crypto'

/** 投影 key：宿主注册它，客户端用 `props.useProjection('turbo')` 读它。 */
export const TURBO_KEY = 'turbo'

/** 折叠输出形状变更时递增；旧持久化行会因 ver 不匹配被丢弃并整日志重折。 */
export const TURBO_STATE_VERSION = 13

/**
 * A1 的阶段枚举。文案由客户端按语言渲染，这里只存稳定的机器名。
 * 组装提示词 / 请求模型 / 等首字 / 流式输出 / 执行工具 / 等审批 / 空闲。
 */
export const PHASES = Object.freeze({
  IDLE: 'idle',
  ASSEMBLING: 'assembling',
  REQUESTING: 'requesting',
  STREAMING: 'streaming',
  TOOL: 'tool',
  APPROVAL: 'approval',
  COMPACTING: 'compacting',
})

/**
 * 默认配置。`lib/index.js` 用宿主 config 覆盖它（浅合并）——**默认值的唯一来源**，
 * `cordis.patch.yml` 的 config 段只逐字镜像这里，不得另立默认值（PLAN.md §7）。
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 是否挂载状态条（客户端读 view.mountStatus，宿主侧保留开关）。 */
  statusBar: true,
  /** A3 无进展阈值：`now - lastProgressAt` 超过它就把状态条变黄。 */
  noProgressMs: 90000,
  /** B1 按步降推理档总开关（`false` ⇒ 一个 llm 处理器都不注册）。 */
  downgrade: true,
  /** B1 最多降到哪一档（按该模型公布的有序档位表取下标）。这里是**唯一**默认值来源。 */
  downgradeFloor: 'low',
  /** B1 连续多少个"干净只读步"才降档（同上，唯一来源）。 */
  minQuietSteps: 2,
  /**
   * B1 只读工具白名单（0.9.2 · P1-4）：只有**明确只读**的工具才算"纯读取/列举/检索"。
   * 不在表里的工具（bash / edit / write / sql_exec / univer_execute…）一律视为"可能写"，
   * 任何一次这类调用都会打断连续段 —— 这是刻意的保守方向。
   * 消费方 `lib/gears.js · readGearConfig`：元素必须是非空字符串，非法元素被过滤，
   * 过滤后为空则回落本表（`readOnlyTools: []` 的语义是"未配置"，不是"没有只读工具"）。
   */
  readOnlyTools: Object.freeze([
    'read',
    'read_image',
    'glob',
    'grep',
    'list_dir',
    'search_context',
    'web_search',
    'web_fetch',
    'cordis_inspect_list',
    'cordis_inspect_query',
  ]),
  /** B3 结果瘦身意愿门槛：结果正文 UTF-8 字节数达到它才考虑落盘。 */
  spillThresholdBytes: 32768,
  /**
   * 0.6.5 本地兜底瘦身：拿不到宿主 `toolResultPruner` 时，正文保留头多少字符。
   * `lib/spill.js · localTrim` 消费；三项都非法时该函数返回 `null`（视为未配置，不裁）。
   */
  localTrimHeadChars: 4096,
  /** 0.6.5 本地兜底瘦身：保留尾多少字符。 */
  localTrimTailChars: 1024,
  /** 0.6.5 本地兜底瘦身：最长文本块短于它就不裁（本地裁剪的门槛，与外层字节门槛 `spillThresholdBytes` 无关）。 */
  localTrimMinChars: 8192,
  /**
   * C1 证据白名单：3 条完整正则字面量（含定界斜杠与 flag）的字符串形式，
   * 消费方 `new RegExp(body, flags)` 还原；命中任一条即视为有可核对证据。
   */
  evidenceWhitelist: Object.freeze([
    '/exit code:?\\s*0\\b/mi',
    '/(^|\\n)\\s*(#\\s*(pass|tests|suites)\\s+\\d+|\\d+\\s+passing|Tests:\\s+\\d+\\s+passed|Test Suites:\\s+\\d+\\s+passed|ok\\s+\\d+\\s+-)/m',
    '/(^|\\n)\\s*(Successfully compiled|Compiled successfully|Found 0 errors|\\d+\\s+files?\\s+checked,?\\s*0\\s+errors|Build succeeded|Done in \\d)/mi',
  ]),
  /** D 卡住时的动作：`'warn'` 零副作用（默认）｜`'nudge'`｜`'stop'`。 */
  stuckAction: 'warn',
  /** D 触发判据：连续多少个 `turn/end` 没有出现过新的工具名。 */
  stuckRounds: 3,
  /** D 触发判据：同一聚合键重复多少次。 */
  stuckRepeats: 3,
  /** C3-a 判据：连续 U+FFFD 的最长连段达到它才提醒编码损坏。 */
  mojibakeMinRuns: 2,
  /** B4 触发源 T3 判据：`tool/result` 载荷字节数达到它即记一次前缀作废（PLAN.md §3.2）。 */
  bulkInjectionBytes: 32768,
  /** 0.6.0 内容层：活动环缓冲最多保留几条（超过从头部丢）。 */
  activityLimit: 24,
  /** 0.6.0 内容层：活动环缓冲总字节上限（UTF-8，超过从头部丢）。 */
  activityBytes: 8192,
  /** 0.6.0 内容层：单条模型思考截断到的字符数。 */
  reasoningChars: 400,
  /** 0.6.0 内容层：工具结果 / 报错保留的首行数。 */
  resultHeadLines: 6,
  /** 0.6.0 内容层：工具参数脱敏键（大小写不敏感、子串匹配）。 */
  redactKeys: Object.freeze([
    'key',
    'token',
    'secret',
    'password',
    'passwd',
    'pwd',
    'authorization',
    'cookie',
    'dsn',
    'apikey',
    'credential',
  ]),
  /**
   * 0.6.1：等待类工具名（等子代理）。命中者不参与 `topTools`（那不是"真执行的慢"），
   * 而是单列进 `waitTools` / 状态条的等待态。数组可配置，脏值（非数组 / 非字符串元素）一律忽略。
   */
  subagentWaitTools: Object.freeze(['wait_agent']),
  /** 0.6.1：等待类工具名（等用户回答）。语义同 `subagentWaitTools`，归类为 'human'。 */
  humanWaitTools: Object.freeze(['ask_user_question']),
  /**
   * 0.6.3：等待类工具名（等后台任务）——**第 4 类**。命中且 `args.wait === true`（真的在阻塞等待）
   * 才归 `'job'`：`job_output` / `job_wait` 不带 `wait` 时通常是一次普通快照，那属于真执行。
   */
  jobWaitTools: Object.freeze(['job_output', 'job_wait']),
  /** 0.6.3：慢调用阈值（毫秒）。`maxMs >= slowMs` 的 wire 元素带 `slow: true`，客户端加 ⚠ 并把超时命令指向后台任务插件。 */
  slowMs: 60000,
  /**
   * 0.7.0 交接文档自动导出总开关。**默认 `true`**（用户明确要求：装上就工作）。
   * 代价是这一层默认带副作用 —— 会话变长时会替你落一份交接文档并起一个 `bili export` 子进程；
   * 想关掉就显式写 `handoffExport: false`，那时它**真的什么都不做**（不探测命令、不起进程、不建目录）。
   */
  handoffExport: true,
  /**
   * 0.7.0 触发阈值：本步要发出去的输入 token（`usage.inputTokens`）达到它才考虑导出。
   * 口径与 bili preflight 那条 `payload core text` 一致。
   *
   * **0.8.1 从 400000 降到 240000**：本机实测的"体感卡点"是 **341421**（那条 `ctx~341421` 的主车道），
   * 而 bili 自己的提醒线是**有效窗口的 75%**（实测 967232 × 75% ≈ **654K**）—— 它**根本不会提醒你**，
   * 所以插件必须早于体感：取 0.7 × 341421 ≈ 240000。
   *
   * ⚠️ **共用阈值（P1-10）**：它、`handoffExportBytes`、`handoffExportWindowPercent` 这**三个**
   * 同时驱动两件不同的事 —— `lib/handoff.js · shouldExport`（导一份交接文档）与
   * `lib/rotation.js · shouldRotate`（到量开一个新会话）。改名会破坏既有配置与文档，故保留此名，
   * 在此写明共用关系：调小它们会**同时**提前这两件事，调大则同时压后。
   */
  handoffExportTokens: 240000,
  /**
   * 0.7.0 节流：距上次导出**又长了这么多**输入 token 才再导一次，
   * 否则长会话会在每一轮里反复导出同一件事。**0.8.1 从 100000 降到 60000**
   * （相对新阈值 240000 才不至于"要再涨 42% 才允许第二份"）。
   */
  handoffExportMinDeltaTokens: 60000,
  /** 0.7.0 导出目录（相对会话 cwd）。 */
  handoffExportDir: 'handoff',
  /** 0.7.0 是否带 `--full`（附每个块的原始消息；文档会大很多）。 */
  handoffExportFull: false,
  /**
   * 0.7.0 bili 可执行文件路径；空串表示自动探测（配置绝对路径 → 包内入口 → profile 的
   * `node_modules/.bin/bili[.CMD]`）。三条都失败是**缺席**，不是故障。
   */
  handoffExportBiliBin: '',
  /**
   * 0.9.2 单次 `bili export` / 车道列表读取的硬超时（毫秒，P1-4）。
   * 超时路径先 kill，两个管道 destroy 之后宽限期到了再升级 `SIGKILL`（`lib/handoff.js · runBili`）。
   * 两个调用点（`runExport` / `listLanes`）共用这一个键；非法值回落 120000。
   */
  handoffExportTimeoutMs: 120000,
  /**
   * 0.7.3 阈值的窗口比例上限（P1-4）：模型窗口已知时，实际阈值取
   * `min(handoffExportTokens, 该比例 × 窗口)` —— 换到小窗口模型时不会再"永远够不着"。
   *
   * **0.8.1 从 40 降到 25**：旧值 40% × 1M = 400000 **恰好等于**旧的 token 旋钮
   * ⇒ 它从来没起过作用，是个**不 binding 的假保险**。25% × 1M = 250000 才对 240000 有约束力。
   */
  handoffExportWindowPercent: 25,
  /**
   * 0.7.3 本进程最多起多少次导出（原为硬编码常量 8，P1-1）—— **0.7.5 默认从 8 抬到 64**：
   * 字节口径下每长 `handoffExportMinDeltaBytes` 就够一次触发，大会话会瞬间用光 8 次。
   */
  handoffExportMaxPerProcess: 64,
  /**
   * 0.7.3 是否连该会话的子车道（`|<sub:…>`）一起导出（P2-1）。
   * **0.7.8 默认改为 `false`** —— 一次越桶会按车道数乘一份（实测本会话 1 主 + 8 子 = 9 份），
   * 而交接只需要主车道那 1 份；要让子车道也各留一份，显式打开。
   */
  handoffExportSubLanes: false,
  /**
   * 0.7.4 字节口径阈值（P0-3 按用户授权"按建议来"）：模型可见体量的估计字节数达到它就触发，
   * 与 token 口径**取或**。**0.8.1 从 3000000 降到 1800000** = 240000 × 7.5（bili 自己的换算）。
   * 为什么必须有这个口径：token 口径量的是 bili **压缩之后**的上行计费输入，而 bili fail-fast
   * 那次根本没有上游响应、也就不产生 usage 事件 —— 字节口径才是能看见那个失败的口径。
   */
  handoffExportBytes: 1800000,
  /**
   * 0.7.4 字节口径的节流。历史：0.7.7 曾从 750000 抬到 8000000（当时为了压住"每 3 分钟补一份"）。
   *
   * **0.8.1 降到 450000** = 60000 × 7.5，理由是专家查出的**真 bug**：现网
   * `handoffExportMinDeltaBytes: 8000000` **大于** `handoffExportBytes: 3000000`
   * ⇒ 字节口径要再涨 8 MB 才允许第二次 ⇒ **这条路径是死的**（永远只导第一份）。
   * 节流本来就该小于阈值一个量级，取 token 侧同样的 4:1 关系。
   */
  handoffExportMinDeltaBytes: 450000,
  /**
   * 0.7.7 只对「新鲜事件」触发：折到的事件距现在超过这个毫秒数就**不动作**。
   *
   * 为什么需要：投影 `apply` 在**冷启动重放**里也会逐事件跑，而重放把整份历史一次性折进来 ——
   * 那时按累计体量判断会在几秒内耗尽上限，并替**早已不动的旧会话**生成一堆文档
   * （同一次实测：4 个工作区共 64 份）。
   */
  handoffExportFreshMs: 300000,
  /**
   * 0.7.8 同一车道**是否允许重复导出**：`0`（默认）= 该车道已有任何一份文档就不再导。
   *
   * 为什么改默认：字节账是**累计**量、只增不减 ⇒ 任何被长时间使用的会话都会反复越桶，
   * 而每越一次桶就按车道数乘一份（0.7.6 上线当天实测写掉 64 份、正好用光进程上限）。
   * 想恢复"随水位桶刷新"，把它设成字节增量（例如 32000000）。
   */
  handoffExportRefreshBytes: 0,
  // ── 0.8.0 到量轮换（开新会话 + 引用旧会话 + 归档旧的）──
  /**
   * 0.8.0 轮换模式：`off`（不做）/ `manual`（面板出现一行 + 按钮，由用户点）/ `auto`（到量自动跑）。
   *
   * **0.9.1 默认改成 `auto`（用户拍板）**：0.8.1 曾把默认压成 manual，理由是"轮换不可逆"
   * （当年 fork 完会归档旧会话，而 DSH 界面里没有取消归档入口）。0.9.0 换成方案 B 之后这条
   * 理由已不成立：既不 fork、也不归档（`rotationArchiveOld: false`），轮换的全部后果只是
   * **多出一个空白会话** —— 忽略它没有任何损失；而漏掉轮换的代价是继续背着全部历史，直到
   * bili preflight 拒发。所以默认全自动；需要人工确认的场合再显式设成 `manual`。
   * 注意非法值也回落到这个默认值（`lib/rotation.js · rotationMode`）：模式名写错会得到 `auto`。
   */
  rotation: 'auto',
  /**
   * 0.20.0：到量时**只提醒、不建会话**（用户 m07554 原话「去掉你的 新会话生成；更改为提醒」）。
   * 只有字面量 `true` 才恢复 0.9~0.19 的行为（建空白会话 + 把旧会话 id 写进它的第一条消息）。
   *
   * 为什么另起一个键、而不改 `rotation` 的默认值：profile 用户层里已经显式写着 `rotation: 'auto'`，
   * 改默认值对既有装机不生效；这个键在用户层里不存在，默认值直接落地。设置页可热改。
   */
  rotationCreate: false,
  /**
   * 0.8.1 只对「新鲜事件」触发轮换判据 —— 与 `handoffExportFreshMs` 同一把闸、同一个理由：
   * 投影 `apply` 在**冷启动重放**里也会逐事件跑，那时按累计体量判断会**立刻 armed**。
   */
  rotationFreshMs: 300000,
  /** 0.8.0 两次轮换的最小间隔（毫秒），防连环轮换。 */
  rotationCooldownMs: 600000,
  /**
   * 0.9.2 是否要求「会话当前空闲」（`phase === 'idle'`）才建新会话。**默认 false**。
   *
   * 为什么改默认：建一个**空白**新会话不会打断正在跑的回合 —— 0.9.0 之后既不 fork、也不搬
   * 上下文（只是 `create` 一个新会话；0.21.1 起连那一条开场话术也不写了），切换时机是客户端的事
   * （客户端自己等会话空闲再 `sessions.open`）。而硬要求空闲的实测后果是**该轮换时永远不空闲**：
   * 一条累计 4.32 MB 的会话自 20:46 起一直在同一个回合里（turn 13、181 步），唯一空闲窗口出现时
   * 水位还没攒够 ⇒ 全史 523 个会话的轮换产物是 0 个。
   * 要恢复 0.8.0~0.9.1 的老行为（只在轮次边界上建），把它显式设成 `true`。
   */
  rotationRequireIdle: false,
  /** 0.9.0 宿主建好新会话后，客户端是否自动切过去（默认 true）。 */
  rotationOpenChild: true,
  /** 0.9.0 是否归档旧会话（**默认 false**：0.8.0 那一版默认 true，但归档后 `@` 引用与侧边栏都读不到它，
   *  与「让新会话能继续查到旧会话」直接冲突 ⇒ 改成"不藏起来，只是不再继续用"）。 */
  rotationArchiveOld: false,
  /**
   * 0.20.0：给轮换出的空白子会话按旧会话标题 `(N)` 递增改个名（0.8.0 的老键，随 fork 一起被删过）。
   *
   * 为什么回来：0.9.0 不再 fork ⇒ 子会话是**空白新建**，标题只能由「首条 user/message」回退截断而来，
   * 每代都长成同一句种子话术，面板上分不清哪个是哪个开的（Q1）。名字由宿主写
   * （`ctx.sessionTitle.rename`），客户端不改 wire、不参与。
   */
  rotationIncreaseTitle: true,
  /**
   * 开场话术模板（`{old}` = 旧会话 id，`{cwd}` = 工作目录）——**0.21.1 起只用于手动复制**
   * （状态条「复制话术」按钮与设置页话术卡），不再自动写进任何新会话。
   */
  rotationSeedMessage:
    '继续旧会话 {old}（工作目录 {cwd}）。需要它的上下文时用 @{old} 查阅，不要假设我记得；先跟我确认要接着做的那件事。',
})

/** 只接受有限数字，其余一律回落，避免半个脏事件把整条状态条打成 NaN。 */
function num(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 事件载荷防御式取值：投影是全库共享的热路径，任何 throw 都会打断所有单元的 drive。 */
function dataOf(event) {
  const data = event === null || event === undefined ? undefined : event.data
  return data !== null && typeof data === 'object' ? data : {}
}

function zeroTurnUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0 }
}

/**
 * 全新会话（或全量重折）的初始状态。必须是 structured-clone 安全的纯 JSON。
 *
 * @param {{ id?: string } | null} [header] harness 传来的 `session.header`（由注册边的 `init` 原样转交）。
 *   只有它的 `id` 被存进 `state.sessionId` —— 非日志派生字段的查表键（PLAN.md §3.8 步骤 2）。
 */
export function initState(header = null) {
  return {
    /**
     * 会话身份：`header.id`，缺省 / 无 `id` ⇒ `null`。**永不变化**（`init` 每会话只调一次，
     * `applyEvent` 不碰它）⇒ 不破坏"不关心的事件返回同一引用"的契约。
     * 它不是 wire 字段（28 键冻结，PLAN.md §3.8 末段）。
     */
    sessionId: header && header.id ? header.id : null,
    /**
     * 0.7.0：会话工作目录（`header.cwd`）。`SessionHeader` 的字段之一是 `cwd?` —— 见
     * `@deepseek-ai/dsh-session`（session-persistence README `:63`：`version, id, createdAt, cwd?,
     * parentSession?, seedLength?, origin?, delegationDepth?`）。`init` 是**唯一**能拿到会话头的点
     * （docs/design.md §2.8），所以只在这里存一次，`applyEvent` 不碰它。
     * 它不是 wire 字段：只给宿主侧的交接导出解析目标路径用。
     */
    cwd: header && typeof header.cwd === 'string' && header.cwd !== '' ? header.cwd : null,
    /**
     * 0.7.3（P1-4）：会话当前路由的模型与上下文窗口，取自 `request/context`
     * （`packages/core/session/src/types.ts:219`；agent-loop 只在路由或容量变化时记一次）。
     * 只用来把阈值按窗口比例收紧 —— 两者都不是 wire 字段。
     */
    model: null,
    contextWindow: null,
    turn: null,
    step: null,
    phase: PHASES.IDLE,
    /** 当前阶段是什么时候开始的（事件时间戳，ms）。客户端用它算"本阶段已耗时"。 */
    phaseStartedAt: null,
    turnStartedAt: null,
    stepStartedAt: null,
    /** 最近一次"有进展"的时间戳：新 assistant 文本或新工具结果。A3 的判据。 */
    lastProgressAt: null,
    tool: null,
    toolStartedAt: null,
    /**
     * 0.6.1：当前工具调用是否属于"等待类"，`'subagent' | 'human' | null`。
     * `tool/call` 时按工具名归类写入（非等待类写 `null`），`tool/result` / `turn/end` 清回 `null`。
     * 状态条据此把阶段文字改成 `⏳ 等子代理` / `⏸ 等你回答`。
     */
    waitKind: null,
    /** 0.6.1：本回合内已派生的子代理数（`subagent/catalog` 每出现一次 +1，`turn/start` 归零）。 */
    subagents: 0,
    toolCalls: 0,
    retries: 0,
    approvals: 0,
    stepUsage: null,
    turnUsage: zeroTurnUsage(),
    /** 最近一步的缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)。 */
    hitRate: null,
    /**
     * 本次请求实际使用的推理档位，取自已 commit 的 `request/header` 的 `header.config.reasoningEffort`。
     * 这既是"B1 是否真的降档了"的权威证据（日志里记的就是实际发出去的那个值），
     * 也让状态条能把它显示出来。为空表示该路由没有档位概念。
     */
    effort: null,
    /**
     * B4 前缀作废（prompt-cache 前缀失效）计数与最近一次原因/时间。
     * 只增不减：`turn/start` 不清零（前缀是会话级事实，不是回合级）。时间取事件时间戳。
     */
    prefixEpoch: 0,
    prefixCause: null,
    prefixAt: null,
    /** 上一个已结束回合的耗时（整数毫秒），`turn/end` 结算。 */
    lastTurnMs: null,
    /** A2 工具耗时聚合表：`key → { name, count, sumMs, maxMs }`。纯 JSON，随 state 一起 checkpoint。 */
    toolAgg: {},
    /** 尚未结算的那次工具调用 `{ key, name, at }`；由下次 `tool/call`、`tool/result` 或 `turn/end` 收尾。 */
    pendingTool: null,
    /** 空闲态常驻摘要：由客户端用视图里的 `phase` + `lastTurnMs` 合成（UI 文案属客户端）。 */
    idleLine: null,
    /**
     * 0.6.0 内容层：最近若干条「模型想了什么 / 调了什么工具 / 结果如何」的内存环缓冲。
     * 只进内存、不落盘；元素一律由本文件新建的纯 JSON。**只在真的追加时才换新数组引用**，
     * 其余事件走 `{ ...state }` 原样带走同一个引用（客户端据此省重渲染）。
     */
    activity: [],
    /**
     * 0.9.2 跨重启水位账：字节账（`payloadBytes` / `headerBytes` / `payloadSeq`）、每车道水位、
     * 以及最后一次 `handoff` / `rotation` 记录。由 `syncLedger` 在每次折叠后写回，由
     * `rehydrateRuntime` 在下一次进程启动的第一次折叠前重新种进运行时表。
     *
     * 它是**投影 state 的一部分**（宿主持久化 `record.rows.turbo.val` 时一并落盘），但
     * **不进 wire 视图** —— `toView` 不暴露它，键数仍是 36。
     */
    ledger: null,
  }
}

/** 把 `TokenUsage` 累加进本轮，并算出本步命中率。 */
function withUsage(state, usage) {
  if (usage === null || typeof usage !== 'object') return state
  const input = num(usage.inputTokens, 0) ?? 0
  const output = num(usage.outputTokens, 0) ?? 0
  const cacheRead = num(usage.cacheReadTokens, 0) ?? 0
  const cacheWrite = num(usage.cacheWriteTokens, 0) ?? 0
  const billedInput = input + cacheRead + cacheWrite
  const previous = state.turnUsage
  return {
    ...state,
    stepUsage: { input, output, cacheRead, cacheWrite },
    hitRate: billedInput > 0 ? cacheRead / billedInput : null,
    turnUsage: {
      input: previous.input + input,
      output: previous.output + output,
      cacheRead: previous.cacheRead + cacheRead,
      cacheWrite: previous.cacheWrite + cacheWrite,
      steps: previous.steps + 1,
    },
  }
}

/** B4 前缀作废原因的封闭枚举；非法值在视图里一律回落 `null`。 */
const PREFIX_CAUSES = Object.freeze(['compaction-start', 'compaction-end', 'bulk-injection'])

/** A2 聚合表上限：超出按 maxMs 淘汰最小项（实现细节，不进 wire 契约）。 */
const MAX_AGG_KEYS = 200

/** wire `hookFaults` 的 FIFO 上限。 */
const MAX_HOOK_FAULTS = 8

/**
 * 本版唯一的非日志派生通道（PLAN.md §3.8）：`state.sessionId → { hookFaults, lastSpill }`。
 *
 * 为什么必须有这张表：`view` 只拿得到 state（`dsh-session-projection/lib/index.js @ :77`
 * 逐字 `view: (state) => wire.view(state)`），而宿主钩子层拿不到 per-session 的投影 state
 * 对象 ⇒ `hookFaults` / `lastSpill` 只许经 `pushHookFault` / `pushSpill` 写在这里，
 * 不许塞进 `state`、事件或日志。
 */
const runtimeBySession = new Map()


/** 运行时表的会话条目上限（实现细节，不进 wire 契约）：超出按插入序淘汰最旧的一条。 */
const MAX_RUNTIME_SESSIONS = 200

/** wire `topTools` 的条数上限。 */
const TOP_TOOLS_LIMIT = 5

/** 0.6.3（C）参数摘要的字符上限（实现细节，不进 wire 契约）：超出截断并加 `…`。 */
const ARG_PREVIEW_MAX = 140

/** 0.6.3（C）优先展示的参数键（按序取**第一个**命中的主键）；都命中不到就退回整体稳定 JSON。 */
const ARG_PREVIEW_KEYS = Object.freeze([
  'command',
  'cmd',
  'CommandLine',
  'file_path',
  'path',
  'pattern',
  'sql',
  'url',
  'query',
  'job_id',
  'ids',
  'name',
])

/** 稳定 JSON 序列化：对象键排序，保证同一份参数在不同键序下产出同一指纹。 */
function stableJson(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? String(value) : encoded
}

/** A2 参数指纹：稳定 JSON + SHA-256 前 12 位十六进制；参数缺失 ⇒ `'unknown'`。 */
function fingerprint(value) {
  if (value === undefined || value === null) return 'unknown'
  try {
    return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 12)
  } catch {
    // 吞的只可能是非 JSON 值（循环引用 / 函数）——退化为 unknown，绝不打断投影 drive。
    return 'unknown'
  }
}

/** A2 聚合键：工具名 × 参数指纹。 */
function toolKey(name, args) {
  return `${name}\u0000${fingerprint(args)}`
}

/** 空活动环缓冲：`state.activity` 缺席（旧持久化行）时给同一个冻结引用，不制造新数组。 */
const EMPTY_ACTIVITY = Object.freeze([])

/** 活动条目里字符串值的截断长度（实现细节，不进 wire 契约）。 */
const ACTIVITY_STRING_MAX = 200

/** `firstLines` 的字节上限（实现细节）：只留首几行，且不让单条结果把环缓冲撑爆。 */
const RESULT_HEAD_MAX_BYTES = 2000

/** 循环引用 / 超深嵌套 / 非 JSON 值的占位文案。 */
const CIRCULAR = '[Circular]'

/** 活动/结果的值可能是对象（`{ content: [...] }`）或裸字符串，统一取成文本；取不到 ⇒ `''`。 */
function blockText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined || typeof value !== 'object') return ''
  const content = value.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string' && block.text !== '') {
        parts.push(block.text)
      }
    }
    return parts.join('\n')
  }
  return typeof value.message === 'string' ? value.message : ''
}

/**
 * 工具参数脱敏：递归拷贝一份纯 JSON，命中 `redactKeys`（大小写不敏感、子串匹配）的键值换成 `'***'`。
 * 深度上限 3；字符串值超 200 字符截断；循环引用与函数 / symbol / bigint 各自降级，**绝不抛错**
 * ——投影是全库共享的热路径，一个脏参数不能打断 drive。
 *
 * @param {unknown} value 待脱敏的参数（通常是 `tool/call` 的 `data.arguments`）。
 * @param {string[]} [keys] 脱敏键；缺省用 `DEFAULT_CONFIG.redactKeys`。
 * @returns {unknown} 纯 JSON 副本。
 */
export function redactArgs(value, keys = DEFAULT_CONFIG.redactKeys) {
  const needles = []
  if (Array.isArray(keys)) {
    for (const key of keys) if (typeof key === 'string' && key !== '') needles.push(key.toLowerCase())
  }
  const seen = new WeakSet()
  const walk = (node, depth) => {
    if (typeof node === 'string') return node.length > ACTIVITY_STRING_MAX ? node.slice(0, ACTIVITY_STRING_MAX) : node
    if (node === undefined) return null
    if (typeof node === 'function') return '[Function]'
    if (typeof node === 'symbol' || typeof node === 'bigint') return String(node)
    if (node === null || typeof node !== 'object') return node
    if (depth >= 3) return CIRCULAR
    if (seen.has(node)) return CIRCULAR
    seen.add(node)
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1))
    const out = {}
    for (const key of Object.keys(node)) {
      const lower = key.toLowerCase()
      out[key] = needles.some((needle) => lower.includes(needle)) ? '***' : walk(node[key], depth + 1)
    }
    return out
  }
  return walk(value, 0)
}

/**
 * 取文本的前 n 行；超出总字节上限时按 UTF-8 字节截断并丢掉尾部半个字符。非字符串 ⇒ `''`。
 *
 * @param {unknown} text 结果 / 报错正文（裸字符串，或 `{ content: [...] }` 这类消息对象）。
 * @param {number} [n] 保留行数；缺省用 `DEFAULT_CONFIG.resultHeadLines`。
 * @returns {string}
 */
export function firstLines(text, n) {
  const source = blockText(text)
  if (source === '') return ''
  const limit = Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_CONFIG.resultHeadLines
  const joined = source.split('\n').slice(0, limit).join('\n')
  if (Buffer.byteLength(joined, 'utf8') <= RESULT_HEAD_MAX_BYTES) return joined
  return Buffer.from(joined, 'utf8').subarray(0, RESULT_HEAD_MAX_BYTES).toString('utf8').replace(/\uFFFD$/, '')
}

/** 配置里的正整数（条数 / 字节数 / 行数）；非法值一律回落 `DEFAULT_CONFIG` 同名项。 */
function configInt(config, key) {
  const raw = config !== null && typeof config === 'object' ? config[key] : undefined
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_CONFIG[key]
}

/** 配置里的脱敏键表：非空字符串数组才认，否则回落默认（非法配置不抛错）。 */
function redactKeysOf(config) {
  const raw = config !== null && typeof config === 'object' ? config.redactKeys : undefined
  return Array.isArray(raw) && raw.length > 0 ? raw : DEFAULT_CONFIG.redactKeys
}

/**
 * 配置里的等待类工具名集合（0.6.1）。**只要 `config[key]` 是数组就采信**（空数组 = 该类别不拦），
 * 非数组一律回落 `DEFAULT_CONFIG`；数组里非字符串 / 空串元素一律忽略 —— 脏配置绝不让判定抛错。
 */
function waitToolSet(config, key) {
  const raw = config !== null && typeof config === 'object' ? config[key] : undefined
  const source = Array.isArray(raw) ? raw : DEFAULT_CONFIG[key]
  const names = new Set()
  for (const item of source) {
    if (typeof item === 'string' && item !== '') names.add(item)
  }
  return names
}

/**
 * 0.6.3（C）：`data.arguments` 是 JSON 字符串；解析成功且是对象才认，其余（解析失败 / 裸标量 / null）
 * 一律 `null` —— 归类判定与摘要共用它，脏参数绝不让热路径抛错。
 */
function parseArgsObject(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed !== null && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  return value !== null && typeof value === 'object' ? value : null
}

/** 主键值的可读形式：字符串 / 数字 / 布尔原样，纯标量数组用逗号连接；其余 ⇒ `''`（换下一个键）。 */
function scalarText(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) {
      if (typeof item === 'string') parts.push(item)
      else if (typeof item === 'number' || typeof item === 'boolean') parts.push(String(item))
    }
    return parts.join(',')
  }
  return ''
}

/** 摘要统一收尾：空白折叠、去空、超 `ARG_PREVIEW_MAX` 截断并加 `…`；空 ⇒ `null`。 */
function previewText(text) {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  if (flat === '') return null
  return flat.length > ARG_PREVIEW_MAX ? `${flat.slice(0, ARG_PREVIEW_MAX)}…` : flat
}

/**
 * 0.6.3（C）：给最慢调用配一句人话参数摘要（客户端明细行末尾展示）。
 * 字符串先按 JSON 试解析，非对象 ⇒ `null`；命中 `ARG_PREVIEW_KEYS` 的第一个主键优先，
 * 都命中不到就退回整体稳定 JSON；**复用 `redactArgs` 脱敏**；最后截断到 `ARG_PREVIEW_MAX`。
 * 纯函数、**永不抛**（投影是全库共享的热路径）。
 *
 * @param {unknown} args `tool/call` 的 `data.arguments`（JSON 字符串，或已解析对象）。
 * @param {object} [config] 宿主合并后的配置；缺省回落 `DEFAULT_CONFIG`。
 * @returns {string|null}
 */
export function summarizeArgs(args, config) {
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object') return null
  const redacted = redactArgs(value, redactKeysOf(config))
  if (redacted === null || typeof redacted !== 'object') return null
  for (const key of ARG_PREVIEW_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(redacted, key)) continue
    const text = previewText(scalarText(redacted[key]))
    if (text !== null) return text
  }
  try {
    return previewText(stableJson(redacted))
  } catch {
    return null
  }
}

/**
 * 0.6.1 + 0.6.3：按工具名 + 参数把一次工具调用分四类。
 *
 * @param {unknown} name 工具名（非字符串 ⇒ 一律 `'exec'`）。
 * @param {unknown} [args] 已解析的参数对象；只有 `jobWaitTools` 命中且 `args.wait === true` 才归 `'job'`。
 * @param {object} [config] 宿主合并后的配置；缺省回落 `DEFAULT_CONFIG`。
 * @returns {'exec' | 'subagent' | 'human' | 'job'} `humanWaitTools` 命中 ⇒ `'human'`；
 *   `subagentWaitTools` 命中 ⇒ `'subagent'`；`jobWaitTools` 命中且 `args.wait === true` ⇒ `'job'`；否则 `'exec'`。
 */
export function toolKindOf(name, args, config) {
  if (typeof name !== 'string') return 'exec'
  if (waitToolSet(config, 'humanWaitTools').has(name)) return 'human'
  if (waitToolSet(config, 'subagentWaitTools').has(name)) return 'subagent'
  if (args !== null && typeof args === 'object' && args.wait === true && waitToolSet(config, 'jobWaitTools').has(name)) {
    return 'job'
  }
  return 'exec'
}

/** 一条活动条目的 UTF-8 字节数（序列化后计；取不到 ⇒ 0，绝不抛）。 */
function activityBytesOf(entry) {
  try {
    const encoded = JSON.stringify(entry)
    return encoded === undefined ? 0 : Buffer.byteLength(encoded, 'utf8')
  } catch {
    // 吞的只可能是非 JSON 值；此时按 0 计，宁可少淘汰也不打断投影 drive。
    return 0
  }
}

/**
 * 往活动环缓冲追加一条：超过 `activityLimit` 条 **或** 超过 `activityBytes` 字节就从头部丢。
 * **只有真的追加了才换新数组引用**——不关心的事件由调用方保持同一个 state 引用。
 * 单条自身就超字节上限时至少保留这最新一条（否则用户永远看不到刚发生的事）。
 *
 * @param {object} state 当前折叠状态。
 * @param {object} entry 新活动条目（纯 JSON）。
 * @param {object} [config] 宿主合并后的配置；缺省回落 `DEFAULT_CONFIG`。
 * @returns {object} 新状态（新 `activity` 数组）。
 */
export function pushActivity(state, entry, config) {
  const limit = configInt(config, 'activityLimit')
  const maxBytes = configInt(config, 'activityBytes')
  const previous = Array.isArray(state.activity) ? state.activity : EMPTY_ACTIVITY
  const next = [...previous, entry]
  let bytes = 0
  for (const item of next) bytes += activityBytesOf(item)
  while (next.length > limit || (bytes > maxBytes && next.length > 1)) {
    bytes -= activityBytesOf(next.shift())
  }
  return { ...state, activity: next }
}

/** 从 `assistant/message` 的 `data.message.content[]` 里取第一条 `type === 'reasoning'` 的原文。 */
function reasoningText(data) {
  const message = data.message
  const content = message !== null && typeof message === 'object' ? message.content : null
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'reasoning' && typeof block.text === 'string' && block.text !== '') return block.text
  }
  return ''
}

/** `turn/end` 的结束原因：`data.reason` 是对象就取 `.kind`，是字符串就用它，否则 `null`。 */
function turnEndReason(data) {
  const reason = data.reason
  if (typeof reason === 'string' && reason !== '') return reason
  if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string' && reason.kind !== '') {
    return reason.kind
  }
  return null
}

/** A2 淘汰判据：maxMs 小者先淘汰，再 count 小者、name 升序、key 升序，保证确定性。 */
function isWorseEntry(candidate, candidateKey, incumbent, incumbentKey) {
  if (candidate.maxMs !== incumbent.maxMs) return candidate.maxMs < incumbent.maxMs
  if (candidate.count !== incumbent.count) return candidate.count < incumbent.count
  const byName = candidate.name.localeCompare(incumbent.name)
  return byName !== 0 ? byName < 0 : candidateKey.localeCompare(incumbentKey) < 0
}

/**
 * 把一次已结算的工具耗时并入聚合表，超过上限时淘汰最差的一项。
 * `kind`（0.6.1）在 `tool/call` 时已按工具名定好，原样带进条目；**它不参与淘汰判据**。
 * `argPreview`（0.6.3（C））是**首次结算时**的参数摘要，**首次非 null 即固定**，同样不参与淘汰判据。
 */
function aggregateTool(agg, key, name, ms, kind, argPreview) {
  const previous = agg[key] !== null && typeof agg[key] === 'object' ? agg[key] : null
  const count = (previous === null ? 0 : num(previous.count, 0) ?? 0) + 1
  const sumMs = (previous === null ? 0 : num(previous.sumMs, 0) ?? 0) + ms
  const maxMs = Math.max(previous === null ? 0 : num(previous.maxMs, 0) ?? 0, ms)
  const kept =
    previous !== null && typeof previous.argPreview === 'string' && previous.argPreview !== ''
      ? previous.argPreview
      : null
  const fresh = typeof argPreview === 'string' && argPreview !== '' ? argPreview : null
  const next = { ...agg, [key]: { name, count, sumMs, maxMs, kind, argPreview: kept === null ? fresh : kept } }
  const keys = Object.keys(next)
  if (keys.length <= MAX_AGG_KEYS) return next
  let victim = keys[0]
  for (const candidate of keys) {
    if (isWorseEntry(next[candidate], candidate, next[victim], victim)) victim = candidate
  }
  delete next[victim]
  return next
}

/**
 * A2 收尾：把"上一次工具调用"的耗时（相邻事件时间戳之差）记入聚合表。
 * 日志缺 `tool/result` 时由下一次 `tool/call` 兜底，最后一次由 `tool/result` 或 `turn/end` 收尾。
 * 时间戳缺失或回退（负数）时只清空 pending，绝不把 NaN / 负值写进聚合表。
 */
function settlePendingTool(state, time) {
  const pending = state.pendingTool
  const cleared = { ...state, pendingTool: null }
  if (pending === null || typeof pending !== 'object') return cleared
  const at = num(pending.at)
  const ms = at === null || time === null ? null : Math.round(time - at)
  if (ms === null || ms < 0 || typeof pending.key !== 'string' || typeof pending.name !== 'string') {
    return cleared
  }
  const kind = pending.kind === 'subagent' || pending.kind === 'human' || pending.kind === 'job' ? pending.kind : 'exec'
  const agg = state.toolAgg !== null && typeof state.toolAgg === 'object' ? state.toolAgg : {}
  return { ...cleared, toolAgg: aggregateTool(agg, pending.key, pending.name, ms, kind, pending.argPreview) }
}

/**
 * `tool/result` 载荷的 UTF-8 正文总字节数（正文在 `data.message.content[].text`）。
 * 取不到载荷 ⇒ 0：判据静默不触发，绝不为了凑数去读宿主内存。
 */
function resultBytes(data) {
  const message = data.message
  const content = message !== null && typeof message === 'object' ? message.content : null
  if (!Array.isArray(content)) return 0
  let bytes = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = block.text
    if (typeof text === 'string' && text !== '') bytes += Buffer.byteLength(text, 'utf8')
  }
  return bytes
}

/** B4 T3 的意愿门槛：只接受非负安全整数，其余回落默认（非法配置不抛错）。 */
function bulkInjectionBytes(config) {
  const raw = config !== null && typeof config === 'object' ? config.bulkInjectionBytes : undefined
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : DEFAULT_CONFIG.bulkInjectionBytes
}

/** B4：记一次前缀作废（计数只增、原因取最近一次、时间取事件时间戳）。 */
function withPrefixInvalidation(state, cause, time) {
  return {
    ...state,
    prefixEpoch: (num(state.prefixEpoch, 0) ?? 0) + 1,
    prefixCause: cause,
    prefixAt: time,
  }
}

/**
 * 规范化一条钩子故障：只留纯 JSON 三字段（`Fault = { at, hook, message }`，PLAN.md §3.8 步骤 1），
 * 元素一律**新建**，外部对象绝不原样挂进运行时表。
 * `at` 由调用方给（钩子层的挂钟）；缺失时回落 `0` —— 本文件全文禁用 `Date.now()`。
 */
function normalizeFault(fault) {
  const source = fault !== null && typeof fault === 'object' ? fault : {}
  const raw = source.message ?? source.error
  const message = raw !== null && typeof raw === 'object' ? String(raw.message ?? raw) : String(raw ?? '')
  return {
    at: num(source.at, 0) ?? 0,
    hook: typeof source.hook === 'string' && source.hook !== '' ? source.hook : 'unknown',
    message,
  }
}

/** 规范化一条落盘摘要：`Spill = { bytes, locator, at }` 或 `null`；元素一律新建。 */
function normalizeSpill(spill) {
  if (spill === null || typeof spill !== 'object') return null
  return {
    bytes: num(spill.bytes, 0) ?? 0,
    locator: typeof spill.locator === 'string' ? spill.locator : '',
    at: num(spill.at, 0) ?? 0,
  }
}

/** `enhancement` 的合法 `mode` 三态（0.6.5）。其它值一律回落缺省，wire 上不出现未知态。 */
const ENHANCEMENT_MODES = Object.freeze(['host-pruner', 'local-trim', 'off'])

/**
 * 规范化一次「工具增强层」探测结果（0.6.4 起 `{ active, reason }`，0.6.5 加 `mode`）：
 * `{ active, mode, reason }`，缺省 `{ active: true, mode: 'host-pruner', reason: null }`
 * —— 「还没探测过」= 乐观地当作宿主 pruner 在位，与 `active` 的缺省语义同向。
 * 只接受布尔 / 三态字面量 / 字符串，别的类型一律回落缺省——wire 上不允许出现 `undefined`。
 */
function normalizeEnhancement(enhancement) {
  const source = enhancement !== null && typeof enhancement === 'object' ? enhancement : {}
  return {
    active: source.active !== false,
    mode: ENHANCEMENT_MODES.includes(source.mode) ? source.mode : 'host-pruner',
    reason: typeof source.reason === 'string' && source.reason !== '' ? source.reason : null,
  }
}

/**
 * 折叠一个已 commit 的会话事件。
 * 不关心的事件返回**同一个引用** —— 这是投影契约的一部分，不是优化。
 *
 * @param {object} state 当前折叠状态。
 * @param {object} event 已 commit 的会话事件。
 * @param {object} [config] 宿主合并后的配置；缺省回落 `DEFAULT_CONFIG`（只影响 B4 T3 的意愿门槛）。
 */
export function applyEvent(state, event, config) {
  if (event === null || typeof event !== 'object') return state
  const type = event.type
  const data = dataOf(event)
  const time = num(event.time)

  switch (type) {
    case 'turn/start':
      return {
        ...state,
        turn: num(data.turn) ?? state.turn,
        step: null,
        phase: PHASES.ASSEMBLING,
        phaseStartedAt: time,
        turnStartedAt: time,
        stepStartedAt: null,
        lastProgressAt: time,
        tool: null,
        toolStartedAt: null,
        toolCalls: 0,
        retries: 0,
        approvals: 0,
        stepUsage: null,
        turnUsage: zeroTurnUsage(),
        hitRate: null,
        // 0.6.1：等待态与本回合派生的子代理数都按回合重置。
        waitKind: null,
        subagents: 0,
      }

    case 'step/start':
      return {
        ...state,
        turn: num(data.turn) ?? state.turn,
        step: num(data.step),
        phase: PHASES.ASSEMBLING,
        phaseStartedAt: time,
        stepStartedAt: time,
        stepUsage: null,
      }

    // 请求头 commit ⇒ 提示词已经组装完毕，进入"请求模型 / 等首字"这一段。
    // 同时记下这一步**实际发出去**的推理档位（B1 降档的权威证据，也是状态条上那个"档位"的来源）。
    case 'request/header': {
      const headerConfig = data.header && typeof data.header === 'object' ? data.header.config : undefined
      const raw = headerConfig && typeof headerConfig === 'object' ? headerConfig.reasoningEffort : undefined
      const effort = typeof raw === 'string' && raw !== '' ? raw : null
      if (state.phase === PHASES.REQUESTING && state.effort === effort) return state
      const phaseStartedAt = state.phase === PHASES.REQUESTING ? state.phaseStartedAt : time
      return { ...state, phase: PHASES.REQUESTING, phaseStartedAt, effort }
    }

    // 0.7.3（P1-4）：路由容量。DSH 只在**路由或容量变化**时记一次，所以「没有该事件」要当成
    // 「不知道窗口」，而不是当成窗口为 0 —— 后者会把阈值压到 0、把导出变成每轮一次。
    case 'request/context': {
      const model = typeof data.model === 'string' && data.model !== '' ? data.model : null
      const window = Number.isSafeInteger(data.contextWindow) && data.contextWindow > 0 ? data.contextWindow : null
      if (state.model === model && state.contextWindow === window) return state
      return { ...state, model, contextWindow: window }
    }

    // 一次模型尝试的流已落盘。正常流式期间会先到它、再到 assistant/message。
    case 'assistant/attempt':
      if (state.phase === PHASES.STREAMING) return state
      return { ...state, phase: PHASES.STREAMING, phaseStartedAt: time }

    case 'assistant/message': {
      const progressed = withUsage(state, data.usage)
      const base = {
        ...progressed,
        phase: PHASES.REQUESTING,
        phaseStartedAt: time,
        lastProgressAt: time,
        tool: null,
        toolStartedAt: null,
      }
      // 0.6.0 内容层：把模型这一轮的思考摘要记进活动流；没思考就保持同一个 state 引用。
      const reasoning = reasoningText(data)
      if (reasoning === '') return base
      const maxChars = configInt(config, 'reasoningChars')
      const excerpt = reasoning.length > maxChars ? reasoning.slice(0, maxChars) : reasoning
      return pushActivity(base, { t: time, kind: 'reason', text: excerpt }, config)
    }

    // ★ A1 能秒级看到"正在执行 bash"的原因：这一步在工具**执行前** commit。
    case 'tool/call': {
      // A2：先给"上一次调用"收尾（日志若缺 tool/result，这里就是它的结算点）。
      const settled = settlePendingTool(state, time)
      const name = typeof data.name === 'string' && data.name !== '' ? data.name : null
      // 0.6.1 + 0.6.3：按工具名 + 参数归类（等待类单列；`job` 还要 `args.wait === true`），kind 顺着 pendingTool 带进聚合表。
      const args = parseArgsObject(data.arguments)
      const kind = toolKindOf(name, args, config)
      const tracked =
        name === null
          ? settled
          : {
              ...settled,
              pendingTool: {
                key: toolKey(name, data.arguments),
                name,
                at: time,
                kind,
                // 0.6.3（C）：参数摘要在调用时算好并固定，结算时随耗时一起进聚合表。
                argPreview: summarizeArgs(args, config),
              },
            }
      const base = {
        ...tracked,
        turn: num(data.turn) ?? state.turn,
        step: num(data.step) ?? state.step,
        phase: PHASES.TOOL,
        phaseStartedAt: time,
        tool: name ?? state.tool,
        toolStartedAt: time,
        toolCalls: state.toolCalls + 1,
        waitKind: kind === 'exec' ? null : kind,
      }
      // 0.6.0 内容层：参数先脱敏再上屏（密钥 / DSN / 口令命中 redactKeys 一律换成 `***`）。
      return pushActivity(
        base,
        { t: time, kind: 'call', name, args: redactArgs(data.arguments, redactKeysOf(config)) },
        config,
      )
    }

    case 'tool/result': {
      // A2：这次调用到此结算，耗时 = 本事件时间戳 - 上次 `tool/call` 时间戳。
      const settled = settlePendingTool(state, time)
      const progressed = {
        ...settled,
        phase: PHASES.REQUESTING,
        phaseStartedAt: time,
        lastProgressAt: time,
        tool: null,
        toolStartedAt: null,
        // 0.6.1：等待结束。
        waitKind: null,
      }
      // B4 T3：大块结果注入会重写上下文 ⇒ 提示词前缀作废（小结果不动它，避免噪声）。
      const failed = data.error !== undefined && data.error !== null
      const head = firstLines(failed ? data.error : data.message, configInt(config, 'resultHeadLines'))
      const tracked = pushActivity(progressed, { t: time, kind: 'result', ok: !failed, head }, config)
      if (resultBytes(data) < bulkInjectionBytes(config)) return tracked
      return withPrefixInvalidation(tracked, 'bulk-injection', time)
    }

    case 'approval/asked':
      return { ...state, phase: PHASES.APPROVAL, phaseStartedAt: time, approvals: state.approvals + 1 }

    case 'approval/decided':
      return {
        ...state,
        phase: state.tool === null ? PHASES.REQUESTING : PHASES.TOOL,
        phaseStartedAt: time,
        lastProgressAt: time,
      }

    // B4 T1/T2：压缩会重写历史 ⇒ 提示词前缀作废（恒真触发，只认日志事件真名）。
    case 'compaction/start':
      return withPrefixInvalidation(
        { ...state, phase: PHASES.COMPACTING, phaseStartedAt: time },
        'compaction-start',
        time,
      )

    case 'compaction/end':
      return withPrefixInvalidation(
        { ...state, phase: PHASES.REQUESTING, phaseStartedAt: time, lastProgressAt: time },
        'compaction-end',
        time,
      )

    case 'llm/retry-started':
      return { ...state, retries: state.retries + 1, phase: PHASES.REQUESTING, phaseStartedAt: time }

    case 'user/message':
      return { ...state, phase: PHASES.ASSEMBLING, phaseStartedAt: time, lastProgressAt: time, retries: 0 }

    case 'turn/end': {
      const started = num(state.turnStartedAt, time)
      const elapsed = time === null || started === null ? null : Math.round(time - started)
      const ended = {
        ...state,
        turn: num(data.turn) ?? state.turn,
        phase: PHASES.IDLE,
        phaseStartedAt: time,
        lastProgressAt: state.lastProgressAt ?? time,
        tool: null,
        toolStartedAt: null,
        lastTurnMs: elapsed,
        // 0.6.1：回合结束，等待态清回 `null`。
        waitKind: null,
      }
      // A2：回合结束时最后一次工具调用可能没有 tool/result，就在这里收尾。
      // 0.6.0 内容层：同时记一条「回合结束」活动条目。
      return pushActivity(settlePendingTool(ended, time), { t: time, kind: 'turnEnd', reason: turnEndReason(data) }, config)
    }

    /**
     * 0.6.1：父 Session 在本地派生子代理时追加的会话事件。**只累计本回合的派生数**，
     * 供状态条显示 `⏳ 等子代理 · 本轮 N 个`。
     *
     * 载荷结构未在插件内取证，**故只做 `+1`**（一次事件 = 一个子代理），不去猜任何字段；
     * 该事件可能压根不出现 ⇒ 字段一直是 0，界面按缺失降级。计数是纯加法，不会抛错。
     */
    case 'subagent/catalog':
      return { ...state, subagents: (num(state.subagents, 0) ?? 0) + 1 }

    // 其余 50 余种事件（todo/write、team/*、tool-workflow/*…）对 A1 无信息量。
    default:
      return state
  }
}

/**
 * 把一条运行时条目挪到队尾 = 「刚刚被用过」（S11）。
 *
 * `Map` 的迭代序就是插入序，所以「先 delete 再 set」就是 LRU 的 touch。
 * 之前按插入序淘汰：一个一直在干活的老会话会在新会话不断到来时被挤掉，
 * 它的 `armed`/`role` 守卫随之消失 ⇒ 同一个会话可能被二次轮换或二次导出。
 *
 * 只在**折叠路径**（`runtimeEntry`）上 touch：面板读一眼不算"用过"。
 */
function touchRuntime(sessionId) {
  const entry = runtimeBySession.get(sessionId)
  if (entry === undefined) return undefined
  runtimeBySession.delete(sessionId)
  runtimeBySession.set(sessionId, entry)
  return entry
}

/** 取（或新建）该会话的运行时条目；超过会话上限时按**最近最少使用**淘汰一条。 */
function runtimeEntry(sessionId) {
  const existing = touchRuntime(sessionId)
  if (existing !== undefined) return existing
  if (runtimeBySession.size >= MAX_RUNTIME_SESSIONS) {
    const oldest = runtimeBySession.keys().next()
    if (oldest.done !== true) runtimeBySession.delete(oldest.value)
  }
  const created = {
    hookFaults: [],
    lastSpill: null,
    enhancement: null,
    handoff: null,
    // 0.8.0：到量轮换（开新会话 + 引用旧会话 + 归档旧的）的状态与节流记忆。
    rotation: null,
    // 0.7.4：模型可见体量的字节账（P0-3 的字节口径）与每车道水位（残余修复）。
    // `payloadSeq` 只服务于「重放不重复计」：同一个 seq 只累加一次。
    payloadBytes: 0,
    headerBytes: 0,
    payloadSeq: -1,
    laneWatermarks: {},
  }
  runtimeBySession.set(sessionId, created)
  return created
}

/**
 * 把一条钩子故障写进**模块级 per-session 运行时表**（PLAN.md §3.8 步骤 3）。
 * FIFO 上限 8、最新在前；只写规范化后的新对象，绝不把外部对象原样挂进表或视图。
 * **不写 state、不写事件、不写日志** —— 宿主钩子层拿不到 per-session 的投影 state 对象。
 *
 * @param {string} sessionId 会话 id（＝ `state.sessionId` ＝ `exec.agent.session.header.id`）。
 *   `null` / `undefined` 直接忽略：无名会话没有可查表的条目。
 * @param {{ hook?: string, message?: unknown, error?: unknown, at?: number }} fault 钩子层捕获到的故障。
 * @returns {void}
 */
export function pushHookFault(sessionId, fault) {
  if (sessionId === null || sessionId === undefined) return
  const entry = runtimeEntry(sessionId)
  entry.hookFaults = [normalizeFault(fault), ...entry.hookFaults].slice(0, MAX_HOOK_FAULTS)
}

/**
 * 整条替换该会话的 `lastSpill`（PLAN.md §3.8 步骤 3 / §3.5）：只在落盘成功后才调用。
 *
 * @param {string} sessionId 会话 id；`null` / `undefined` 直接忽略。
 * @param {{ bytes?: unknown, locator?: unknown, at?: unknown } | null} spill 落盘摘要；非法值 ⇒ `null`。
 * @returns {void}
 */
export function pushSpill(sessionId, spill) {
  if (sessionId === null || sessionId === undefined) return
  runtimeEntry(sessionId).lastSpill = normalizeSpill(spill)
}

/**
 * 整条替换该会话的「工具增强层状态」（0.6.4）：**这不是故障**，只是可选能力的在位与否。
 *
 * 缺席（`spillStore` 读不到；0.6.5 起 `toolResultPruner` 缺席改为本地裁剪，不再算缺席）由
 * `lib/spill.js · enhancementOf()` 判出，
 * 这里只做规范化与存表；它绝不进 `hookFaults`（缺席是设计，不是坏了）。
 *
 * @param {string} sessionId 会话 id；`null` / `undefined` 直接忽略。
 * @param {{ active?: unknown, mode?: unknown, reason?: unknown } | null} enhancement 探测结果；非法值 ⇒ 缺省 `{ active: true, mode: 'host-pruner', reason: null }`。
 * @returns {void}
 */
export function pushEnhancement(sessionId, enhancement) {
  if (sessionId === null || sessionId === undefined) return
  runtimeEntry(sessionId).enhancement = normalizeEnhancement(enhancement)
}

/**
 * 0.7.0「交接文档自动导出」的运行时条目（PLAN.md §3.8 步骤 3）。它同时承担两件事：
 *
 *  - **节流记忆**：上次导出时的输入 token（`inputTokens`），宿主据此判断"又长了多少"，
 *    避免长会话在每一轮里反复导出同一件事；
 *  - **面板可见性**：`status` / `at` / `path` / `message` 供 wire 的 `handoff` 键渲染一行 info。
 *
 * 与 `enhancement` 同理：**`unavailable`（探测不到 bili）与 `disabled`（默认关）都不是故障**，
 * 绝不进 `hookFaults`。
 */

/** wire `handoff.status` 的封闭枚举；非法值一律回落 `'idle'`。 */
const HANDOFF_STATUSES = Object.freeze(['disabled', 'idle', 'running', 'done', 'failed', 'unavailable'])

/** 取一个字段的候选值：补丁里有就用补丁的，否则留在旧值上（**合并**语义，节流记忆不会被覆盖掉）。 */
function handoffField(previous, patch, key) {
  return Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : previous[key]
}

/**
 * 规范化 `handoff` 记录：**合并**而不是整条替换（否则每次写状态都会丢掉节流记忆）。
 * 脏值一律回落，绝不抛。
 */
function normalizeHandoff(previous, patch) {
  const base = previous !== null && typeof previous === 'object' ? previous : {}
  const source = patch !== null && typeof patch === 'object' ? patch : {}
  const status = handoffField(base, source, 'status')
  const path = handoffField(base, source, 'path')
  const message = handoffField(base, source, 'message')
  return {
    status: HANDOFF_STATUSES.includes(status) ? status : 'idle',
    at: num(handoffField(base, source, 'at')),
    path: typeof path === 'string' && path !== '' ? path : null,
    inputTokens: num(handoffField(base, source, 'inputTokens')),
    message: typeof message === 'string' && message !== '' ? message : null,
  }
}

/**
 * 读该会话的 `handoff` 记录（宿主判节流用）。无条目 ⇒ `null`。
 *
 * @param {string} sessionId 会话 id；`null` / `undefined` 直接回落 `null`。
 * @returns {{ status: string, at: number|null, path: string|null, inputTokens: number|null, message: string|null }|null}
 */
/**
 * `rotation` 状态的合法取值（wire 契约的一部分）。
 *
 * `unavailable`（0.9.0）与 handoff 同名状态一个意思：判据通过但宿主建不了新会话，面板显示原因、不进 `hookFaults`。
 * `remind`（0.20.0）：判据通过但本插件不建会话（`rotationCreate: false` 时只提醒）—— 与 `idle` 的区别是
 * 「已经到量、只是我们不动手」，客户端据此把那一行显示成建议而不是等待。
 */
const ROTATION_STATUSES = Object.freeze(['off', 'idle', 'armed', 'unavailable', 'remind'])

/**
 * 归一化一条轮换记录（合并语义：`patch` 里缺的键沿用上一个值，脏值回落）。
 *
 * @param {object|null} previous 上一条记录。
 * @param {object|null} patch 本次要写入的字段。
 * @returns {{status: string, at: number|null, inputTokens: number|null, payloadBytes: number|null, sessionId: string|null, openChild: boolean, archiveOld: boolean, childId: string|null, message: string|null}}
 */
function rotationRecord(previous, patch) {
  const base = previous === null || typeof previous !== 'object' ? {} : previous
  const source = patch === null || typeof patch !== 'object' ? {} : patch
  const pick = (key) => (source[key] === undefined ? base[key] : source[key])
  const status = pick('status')
  const rawSessionId = pick('sessionId')
  const mode = pick('mode')
  const childId = pick('childId')
  const message = pick('message')
  return {
    status: ROTATION_STATUSES.includes(status) ? status : 'idle',
    // `mode` 必须一起进 wire：manual 与 auto 下宿主写下的记录**状态相同**，客户端要靠它决定
    // "渲染按钮"还是"自己动手"。
    mode: mode === 'off' || mode === 'manual' || mode === 'auto' ? mode : 'manual',
    at: num(pick('at')),
    inputTokens: num(pick('inputTokens')),
    payloadBytes: num(pick('payloadBytes')),
    sessionId: typeof rawSessionId === 'string' && rawSessionId !== '' ? rawSessionId : (typeof base.sessionId === 'string' ? base.sessionId : null),
    // 0.8.0：两个动作开关也要进 wire —— 客户端据此决定切不切、归档不归档。
    openChild: pick('openChild') !== false,
    archiveOld: pick('archiveOld') === true,
    // 0.9.0（wire v10）：宿主建好的新会话 id，以及失败时的稳定 code（0.21.1 前还有「种子消息是否落进日志」）。
    childId: typeof childId === 'string' && childId !== '' ? childId : null,
    message: typeof message === 'string' && message !== '' ? message : null,
  }
}

/** 取该会话的轮换记录；没有则 `null`。 */
export function rotationStateOf(sessionId) {
  if (sessionId === null || sessionId === undefined) return null
  const entry = runtimeBySession.get(sessionId)
  if (entry === undefined) return null
  return entry.rotation === undefined ? null : entry.rotation
}

/** 从运行时条目取轮换记录（wire 用）；无条目 ⇒ `null`。 */
export function rotationOf(runtime) {
  if (runtime === null || runtime === undefined) return null
  return runtime.rotation === undefined ? null : runtime.rotation
}

/** 写该会话的轮换记录（合并写入；`sessionId` 由宿主带上，客户端据此认领 `childId` 属于哪个会话）。 */
export function pushRotation(sessionId, patch) {
  if (sessionId === null || sessionId === undefined) return
  const entry = runtimeEntry(sessionId)
  entry.rotation = rotationRecord(entry.rotation === undefined ? null : entry.rotation, patch)
}

export function handoffStateOf(sessionId) {
  if (sessionId === null || sessionId === undefined) return null
  const entry = runtimeBySession.get(sessionId)
  if (entry === undefined) return null
  return entry.handoff === null || entry.handoff === undefined ? null : entry.handoff
}

/**
 * 合并写入该会话的 `handoff` 记录（`running` / `done` / `failed` / `unavailable` / `disabled` 各写一次）。
 *
 * @param {string} sessionId 会话 id；`null` / `undefined` 直接忽略。
 * @param {{ status?: unknown, at?: unknown, path?: unknown, inputTokens?: unknown, message?: unknown }} patch
 * @returns {void}
 */
export function pushHandoff(sessionId, patch) {
  if (sessionId === null || sessionId === undefined) return
  const entry = runtimeEntry(sessionId)
  entry.handoff = normalizeHandoff(entry.handoff, patch)
}

/** wire 的 `handoff` 键；表里没有该会话 ⇒ 全空的 `'idle'` 记录（禁 `undefined`）。 */
function handoffOf(runtime) {
  const record = runtime !== null && typeof runtime === 'object' ? runtime.handoff : null
  return normalizeHandoff(null, record)
}

/**
 * 累积「模型可见体量」的字节账（0.7.4 · P0-3 的字节口径）。
 *
 * 为什么需要它：token 口径（`usage.inputTokens`）是 **bili 压缩之后**的上行计费输入，而且
 * bili 那次 fail-fast 的请求没有上游响应、也就不产生 usage 事件 ⇒ 最坏那条路径上它不触发。
 * 字节口径直接量**日志本身的体量**，与 bili 那条护栏（`~7.5 bytes/token`）同族，因此能在
 * "还没炸但快了"的时候先响。
 *
 * 重放幂等：只对**新 seq** 累加，所以冷启动重放不会把同一批事件算两遍。
 *
 * @param {string} sessionId 会话 id。
 * @param {{seq?: unknown, bytes?: unknown, header?: boolean}} sample
 *   `header: true` ⇒ 这是 `request/header`（只记**最新**一次，不累加：它每一步都会重建）。
 * @returns {void}
 */
export function accountPayload(sessionId, sample) {
  if (sessionId === null || sessionId === undefined) return
  const source = sample !== null && typeof sample === 'object' ? sample : {}
  const bytes = typeof source.bytes === 'number' && Number.isFinite(source.bytes) && source.bytes > 0 ? source.bytes : 0
  const entry = runtimeEntry(sessionId)
  if (source.header === true) {
    entry.headerBytes = bytes
    return
  }
  const seq = source.seq
  if (!Number.isSafeInteger(seq) || seq <= entry.payloadSeq) return
  entry.payloadSeq = seq
  entry.payloadBytes += bytes
}

/**
 * 该会话当前「模型可见体量」的估计字节数 = 累积的消息体 + **最近一次**请求头的大小。
 * 无条目 ⇒ `0`。
 *
 * **刻意不回落**（0.7.5 的决定，见 docs/review-0.7.4.md · 0.7.4-4）：本部署里 compaction
 * 并没有把 payload 压下去 —— 那条炸掉的车道有 4027 组 `compaction/start`+`compaction/end`，
 * 最终仍然到了 ~17 MB。所以「累计吃进去多少」才是能提前报警的信号；在 compaction 之后清零
 * 会让它在真正该响的时候不响（方向从"多导"变成"漏导"，后者更糟）。
 */
export function payloadBytesOf(sessionId) {
  if (sessionId === null || sessionId === undefined) return 0
  const entry = runtimeBySession.get(sessionId)
  if (entry === undefined) return 0
  return entry.payloadBytes + entry.headerBytes
}

/**
 * 读某条车道的导出水位（0.7.4 · 残余修复：每条车道各记各的，不再共用父会话那一份）。
 *
 * @param {string} sessionId 会话 id。
 * @param {string} laneKey 车道键（主车道就是 sessionId，子车道形如 `<id>|sub:<hash>`）。
 * @returns {{inputTokens: number|null, payloadBytes: number|null}|null}
 */
export function laneWatermarkOf(sessionId, laneKey) {
  if (sessionId === null || sessionId === undefined) return null
  const entry = runtimeBySession.get(sessionId)
  if (entry === undefined) return null
  const record = entry.laneWatermarks[laneKey]
  return record === undefined ? null : record
}

/**
 * 写某条车道的导出水位。两个口径各记各的（它们单位不同，不能互相顶替）。
 *
 * @param {string} sessionId 会话 id。
 * @param {string} laneKey 车道键。
 * @param {{inputTokens?: unknown, payloadBytes?: unknown}} watermark
 * @returns {void}
 */
export function setLaneWatermark(sessionId, laneKey, watermark) {
  if (sessionId === null || sessionId === undefined) return
  if (typeof laneKey !== 'string' || laneKey === '') return
  const source = watermark !== null && typeof watermark === 'object' ? watermark : {}
  runtimeEntry(sessionId).laneWatermarks[laneKey] = {
    inputTokens: num(source.inputTokens),
    payloadBytes: num(source.payloadBytes),
  }
}

/**
 * 删掉该会话的运行时条目（测试隔离 / 会话回收）。无条目时无事发生。
 *
 * @param {string} sessionId 会话 id。
 * @returns {void}
 */
export function clearSessionRuntime(sessionId) {
  runtimeBySession.delete(sessionId)
}

/**
 * 跨重启水位账：把运行时表里**必须跨重启保留**的那部分打成纯 JSON，挂进投影 state。
 *
 * 为什么需要它：水位原先只活在模块级 `runtimeBySession` 里，而宿主真正持久化的是**投影 state**
 * （`session_projcache/sessions/session-<id>.json` 的 `record.rows.turbo.val`）—— 那份快照里没有
 * 字节账，于是每次 DSH 重启累计体量都从 0 重算。实测两条后果：一条重启以来已经吃了
 * 1.66 MB 的会话差一点没碰到 1.80 MB 阈值；另一条 4.32 MB 的会话因为从没空闲过被空闲闸卡住。
 *
 * **只装只增不减的水位与终态事实**：字节账（`payloadBytes` / `headerBytes` / `payloadSeq`）、
 * 每车道水位，以及"这个会话已经轮换过"这一条终态事实 `rotationChildId`。
 *
 * 0.9.2 曾把 `handoff` / `rotation` **整条**入账、再水化时原样还原，那是回归：`running`（120 s 导出
 * 窗口内进程被杀）与 `unavailable`（没 cwd / 探测不到 bili）都**不是终态**，而宿主对这两种状态
 * 直接 return（`noteHandoff` 的停摆闸）—— 于是**一次失败会跨进程永久化**，该会话此后再也不导出、
 * 也不轮换，且一行日志都没有。任何 status 都不进账。
 *
 * `hookFaults` / `lastSpill` / `enhancement` 是**进程内诊断**（钩子故障、溢出产物、增强片段）：
 * 重启后重算即可，不该让 state 变胖。
 *
 * `ledger` 只进持久化 state，**不进 wire 视图**（`toView` 不暴露它）。**旧快照容忍**：0.9.2 写下的
 * `handoff` / `rotation` 字段一律不读；`rotationChildId` 缺省即"这个会话没轮换过"。
 */

/** 非负安全整数，其余回落 —— 脏快照绝不让水位变成 NaN。 */
function ledgerCount(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/** 从运行时条目打一份纯 JSON 快照（**深拷**：state 绝不与该表共享对象引用）。 */
function ledgerOf(entry) {
  const lanes = {}
  const source = entry.laneWatermarks
  if (source !== null && typeof source === 'object') {
    for (const key of Object.keys(source)) {
      const record = source[key]
      if (record === null || typeof record !== 'object') continue
      lanes[key] = { inputTokens: num(record.inputTokens), payloadBytes: num(record.payloadBytes) }
    }
  }
  const rotation = entry.rotation
  const childId =
    rotation !== null && rotation !== undefined && typeof rotation === 'object' && typeof rotation.childId === 'string' && rotation.childId !== ''
      ? rotation.childId
      : null
  return {
    payloadBytes: ledgerCount(entry.payloadBytes, 0),
    headerBytes: ledgerCount(entry.headerBytes, 0),
    payloadSeq: Number.isSafeInteger(entry.payloadSeq) ? entry.payloadSeq : -1,
    laneWatermarks: lanes,
    // 终态事实：这个会话已经轮换过 ⇒ 新进程里也不再建第二个（`noteRotation` 的守卫据此 return）。
    rotationChildId: childId,
  }
}

/** 两个标量字段表逐键相等（两条记录里的值全是标量）。 */
function sameRecord(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/** 每车道水位表逐车道逐字段相等。 */
function sameWatermarks(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!sameRecord(a[key], b[key])) return false
  }
  return true
}

/** 两份水位账逐字段相等（决定 `syncLedger` 要不要换 state 引用）。 */
function sameLedger(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (a.payloadBytes !== b.payloadBytes || a.headerBytes !== b.headerBytes || a.payloadSeq !== b.payloadSeq) return false
  if (a.rotationChildId !== b.rotationChildId) return false
  return sameWatermarks(a.laneWatermarks, b.laneWatermarks)
}

/**
 * 把当前水位账写回投影 state 的 `ledger`。宿主在**每一次折叠之后**调用（折叠里刚写下的
 * `handoff` / `rotation` 记录必须一起落盘）。
 *
 * @param {object} state 投影 state。
 * @returns {object} 带最新 `ledger` 的 state；账没变时**返回同一个引用**（宿主据此省一次持久化）。
 */
export function syncLedger(state) {
  if (state === null || typeof state !== 'object') return state
  const sessionId = state.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return state
  const entry = runtimeBySession.get(sessionId)
  if (entry === undefined) return state
  const ledger = ledgerOf(entry)
  return sameLedger(state.ledger, ledger) ? state : { ...state, ledger }
}

/**
 * 再水化：state 带着 `ledger`、而运行时表里**没有该会话的活条目**时（重启后的第一次折叠），
 * 用 `ledger` 把表条目种出来 —— 于是这一次折叠的判据（到量轮换 / 交接导出节流）看到的是
 * 恢复后的水位，而不是 0。
 *
 * 表里已有活条目时**什么都不做**（活条目更新，且它的 `payloadSeq` 已经前进过）。
 *
 * @param {object} state 投影 state（来自宿主持久化快照）。
 * @returns {void}
 */
export function rehydrateRuntime(state) {
  if (state === null || typeof state !== 'object') return
  const sessionId = state.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (runtimeBySession.has(sessionId)) return
  const ledger = state.ledger
  if (ledger === null || typeof ledger !== 'object') return
  const entry = runtimeEntry(sessionId)
  entry.payloadBytes = ledgerCount(ledger.payloadBytes, 0)
  entry.headerBytes = ledgerCount(ledger.headerBytes, 0)
  entry.payloadSeq = Number.isSafeInteger(ledger.payloadSeq) ? ledger.payloadSeq : -1
  const lanes = ledger.laneWatermarks
  if (lanes !== null && typeof lanes === 'object') {
    for (const key of Object.keys(lanes)) {
      const record = lanes[key]
      if (record === null || typeof record !== 'object') continue
      entry.laneWatermarks[key] = { inputTokens: num(record.inputTokens), payloadBytes: num(record.payloadBytes) }
    }
  }
  // 终态事实：已经轮换过 ⇒ 重建一条"新会话已就绪、等客户端切过去"的记录，`noteRotation` 的
  // 「已有 childId 就 return」守卫继续有效。
  //
  // 0.9.2 旧快照里那两整条 `handoff` / `rotation`（可能带着 running / unavailable）**一律不读**：
  // 那些不是终态，还原它们会让会话跨进程永久停摆（`noteHandoff` 对这两种状态直接 return）。
  const childId = ledger.rotationChildId
  if (typeof childId === 'string' && childId !== '') {
    const record = rotationRecord(null, { status: 'armed', mode: 'manual', childId })
    // `at` 此刻未知：留 null，绝不编一个假的时间戳。
    record.at = null
    entry.rotation = record
  }
}

/** 本步/本轮 token 只报"进模型 + 出模型"的可见总量，缓存在命中率里单列。 */
function totalTokens(usage) {
  if (usage === null || typeof usage !== 'object') return null
  return usage.input + usage.output
}

/**
 * 聚合表的全量条目（0.6.1 起带 `kind`），供 `topToolsOf` / `waitToolsOf` 分桶共用。
 * 排序：maxMs 降序 → count 降序 → name 升序。**kind 不参与排序**；元素一律新建。
 */
function toolEntriesOf(state) {
  const agg = state.toolAgg !== null && typeof state.toolAgg === 'object' ? state.toolAgg : {}
  const entries = []
  for (const key of Object.keys(agg)) {
    const entry = agg[key]
    if (entry === null || typeof entry !== 'object') continue
    const count = num(entry.count, 0) ?? 0
    if (count < 1) continue
    const sumMs = num(entry.sumMs, 0) ?? 0
    entries.push({
      name: typeof entry.name === 'string' ? entry.name : '',
      key,
      count,
      maxMs: num(entry.maxMs, 0) ?? 0,
      avgMs: Math.round(sumMs / count),
      sumMs,
      // 0.6.3（C）：参数摘要（可能 `null`）——"最慢调用"这一行的诊断正文。
      argPreview: typeof entry.argPreview === 'string' && entry.argPreview !== '' ? entry.argPreview : null,
      kind: entry.kind === 'subagent' || entry.kind === 'human' || entry.kind === 'job' ? entry.kind : 'exec',
    })
  }
  entries.sort((a, b) => b.maxMs - a.maxMs || b.count - a.count || a.name.localeCompare(b.name))
  return entries
}

/**
 * wire `topTools`（0.6.1 **语义收窄为只含 `kind === 'exec'`**）：maxMs 降序 → count 降序 → name 升序取前 5。
 * 0.6.3 在既有 5 键上追加 `argPreview`（参数摘要，可能 `null`）与 `slow`（`maxMs >= slowMs`）；一律新建。
 */
function topToolsOf(state, slowMs) {
  const out = []
  for (const entry of toolEntriesOf(state)) {
    if (entry.kind !== 'exec') continue
    out.push({
      name: entry.name,
      key: entry.key,
      count: entry.count,
      maxMs: entry.maxMs,
      avgMs: entry.avgMs,
      argPreview: entry.argPreview,
      slow: entry.maxMs >= slowMs,
    })
    if (out.length >= TOP_TOOLS_LIMIT) break
  }
  return out
}

/**
 * wire `waitTools`（0.6.1 新增）：只含等待类（`kind !== 'exec'`），同一排序取前 5。
 * 元素在 `topTools` 字段基础上多带 `sumMs` 与 `kind`（客户端据此算「累计」并选中「等子代理 / 等你回答 / 等后台任务」文案）；
 * 0.6.3 同样追加 `argPreview` 与 `slow`。
 */
function waitToolsOf(state, slowMs) {
  const out = []
  for (const entry of toolEntriesOf(state)) {
    if (entry.kind === 'exec') continue
    out.push({
      name: entry.name,
      key: entry.key,
      count: entry.count,
      maxMs: entry.maxMs,
      avgMs: entry.avgMs,
      sumMs: entry.sumMs,
      kind: entry.kind,
      argPreview: entry.argPreview,
      slow: entry.maxMs >= slowMs,
    })
    if (out.length >= TOP_TOOLS_LIMIT) break
  }
  return out
}

/** wire `hookFaults`：最多 8 条、最新在前；元素一律新建（表里的对象绝不外传）。 */
function hookFaultsOf(faults) {
  const list = Array.isArray(faults) ? faults : []
  const out = []
  for (const fault of list) {
    if (out.length >= MAX_HOOK_FAULTS) break
    if (fault === null || typeof fault !== 'object') continue
    out.push({
      at: num(fault.at, 0) ?? 0,
      hook: typeof fault.hook === 'string' ? fault.hook : 'unknown',
      message: typeof fault.message === 'string' ? fault.message : String(fault.message ?? ''),
    })
  }
  return out
}

/** wire `lastSpill`：`{ bytes, locator, at }` 或 `null`；对象新建（表里的对象绝不外传）。 */
function lastSpillOf(spill) {
  if (spill === null || spill === undefined || typeof spill !== 'object') return null
  return {
    bytes: num(spill.bytes, 0) ?? 0,
    locator: typeof spill.locator === 'string' ? spill.locator : '',
    at: num(spill.at, 0) ?? 0,
  }
}

/** wire `enhancement`：`{ active, mode, reason }`；表里没有条目或没探测过 ⇒ 缺省「宿主 pruner 在位」。对象新建。 */
function enhancementOfView(enhancement) {
  return normalizeEnhancement(enhancement)
}

/**
 * 给客户端看的 wire 视图：**纯 JSON、字段齐全、无 undefined**。
 * 客户端不做任何日志折叠，只做格式化（practices.md:38）。
 * v1 的 19 个键逐字不变，v2 追加 9 个键，v3 追加 1 个键（`activity`，顺序即契约），
 * v4 追加 3 个键（`waitTools` / `waitKind` / `subagents`）。
 * **v4 的一处语义收窄**：`topTools` 由「所有叫得出名字的工具」收窄为「只含 `kind === 'exec'`」（键名与字段不变）。
 * v5 追加 1 个键（`slowMs`，0.6.3 诊断层），并给 `topTools` / `waitTools` 的元素各追加 `argPreview` / `slow` 两个字段。
 * v6 追加 1 个键（`enhancement`，0.6.4「缺席 ≠ 故障」）：可选增强层是否在位，供面板显示一行 info。
 * **v7 的字段不可变**：`enhancement` 的键名与位置不动，只在对象内部追加 `mode`
 * （`'host-pruner' | 'local-trim' | 'off'`，0.6.5「拿不到宿主 pruner 就本地裁剪」），键数仍 34。
 * v8 追加 1 个键（`handoff`，0.7.0「交接文档自动导出」）：导出状态 + 节流记忆，
 * 供面板显示一行 info；`unavailable` 是缺席不是故障，绝不进 `hookFaults`。键数 35。
 * v9 追加 1 个键（`rotation`，0.8.0「到量轮换」）：`off|idle|armed|unavailable` + 触发时的时间/token/字节
 * + 轮换记录；v10（0.9.0 方案 B）在同一键内追加**宿主建好的新会话 id**（`childId`，客户端据此
 * `sessions.open`）与失败时的稳定 code（`message`）。
 * `off`/`idle`/`unavailable`/缺席都不是故障。键数 36（v10 未新增顶层键）。
 * v11 追加 1 个键（`room`，0.10.0「房间与任务板」）；v12 追加 1 个键（`fleet`，0.13.0「编队」）。
 * **v13 移除 `room` 与 `fleet` 两个键**（0.18.0：群聊与编队整块删除，插件只做「新会话的开启与
 * 使用」）：`setRoomViewProvider` / `setFleetViewProvider` 与 `lib/room*.js`、`lib/fleet*.js`
 * 一并删除。键数 38 → 37。
 */
/**
 * 0.18.0：新会话开场话术（"话术卡"）。
 *
 * 自动轮换之外的手动兜底：用户在新会话里直接粘贴这段文本，新会话就知道该去查哪条旧会话、
 * 工作目录在哪。模板取自 `rotationSeedMessage`（轮换建出的新会话 0.21.1 起是空白的，不再自动写这段文本），`{old}` / `{cwd}` 分别替换成当前会话 id 与工作目录；未知占位符原样保留。
 *
 * 纯函数、不碰时间；缺失一律空串（wire 上禁 `undefined`）。
 *
 * @param {object} state 会话投影状态。
 * @param {object} [config] 宿主合并后的配置。
 * @returns {{text: string, oldId: string, cwd: string}}
 */
function newSessionViewOf(state, config) {
  const source = config === null || typeof config !== 'object' ? {} : config
  const template =
    typeof source.rotationSeedMessage === 'string' && source.rotationSeedMessage.trim() !== ''
      ? source.rotationSeedMessage
      : DEFAULT_CONFIG.rotationSeedMessage
  const oldId = typeof state.sessionId === 'string' ? state.sessionId : ''
  const cwd = typeof state.cwd === 'string' ? state.cwd : ''
  return {
    text: template.split('{old}').join(oldId).split('{cwd}').join(cwd),
    oldId,
    cwd,
  }
}

export function toView(state, config) {
  const noProgressMs = num(config && config.noProgressMs, DEFAULT_CONFIG.noProgressMs)
  // 0.6.3：慢调用阈值（正整数，配置非法时回落默认 60000，绝不抛）。
  const slowMs = configInt(config, 'slowMs')
  // 非日志派生字段的唯一读点（PLAN.md §3.8 步骤 4）：表里没有该会话条目 ⇒ `[]` / `null`，禁 `undefined`。
  const runtime = runtimeBySession.get(state.sessionId)
  return {
    v: TURBO_STATE_VERSION,
    phase: state.phase,
    phaseStartedAt: state.phaseStartedAt,
    turnStartedAt: state.turnStartedAt,
    stepStartedAt: state.stepStartedAt,
    lastProgressAt: state.lastProgressAt,
    turn: state.turn,
    step: state.step,
    tool: state.tool,
    toolStartedAt: state.toolStartedAt,
    stepTokens: totalTokens(state.stepUsage),
    turnTokens: totalTokens(state.turnUsage),
    effort: state.effort,
    hitRate: state.hitRate,
    toolCalls: state.toolCalls,
    retries: state.retries,
    approvals: state.approvals,
    busy: state.phase !== PHASES.IDLE,
    noProgressMs,
    // ★ v2 追加（P0-1 死开关 + B4 前缀可见性 + A2 慢工具 + 故障可见化）
    mountStatus: config && config.statusBar === false ? 'disabled' : 'enabled',
    prefixEpoch: num(state.prefixEpoch, 0),
    prefixCause: PREFIX_CAUSES.includes(state.prefixCause) ? state.prefixCause : null,
    prefixAt: num(state.prefixAt),
    lastTurnMs: num(state.lastTurnMs),
    topTools: topToolsOf(state, slowMs),
    hookFaults: hookFaultsOf(runtime === undefined ? null : runtime.hookFaults),
    idleLine: typeof state.idleLine === 'string' && state.idleLine !== '' ? state.idleLine : null,
    lastSpill: lastSpillOf(runtime === undefined ? null : runtime.lastSpill),
    // ★ v3 追加（0.6.0 内容层）：活动流。**直出 state.activity 的同一个引用**——活动没变时
    //   客户端拿到同一个数组，`Object.is` 比对即可跳过重渲染（数组本身由 pushActivity 换新）。
    activity: Array.isArray(state.activity) ? state.activity : EMPTY_ACTIVITY,
    // ★ v4 追加（0.6.1 等待态）：等待类工具单列，`topTools` 不再被「等子代理 / 等人」霸榜。
    //   `waitTools` 与 `topTools` 一样是新建数组；`waitKind` 驱动状态条文案；`subagents` 是本回合派生数。
    waitTools: waitToolsOf(state, slowMs),
    waitKind:
      state.waitKind === 'subagent' || state.waitKind === 'human' || state.waitKind === 'job' ? state.waitKind : null,
    subagents: num(state.subagents, 0) ?? 0,
    // ★ v5 追加（0.6.3 诊断层）：慢调用阈值。客户端要用它把 `slow` 行的 ⚠ 提示写成"超过 <可读时长>"，
    //   而 wire 上没有别处带这个数。
    slowMs,
    // ★ v6 追加（0.6.4「缺席 ≠ 故障」）：可选增强层状态。**不是故障**——缺席时只显示一行灰色 info，
    //   绝不进 `hookFaults`（根因见 lib/spill.js · resolvePruner 上方注释）。
    enhancement: enhancementOfView(runtime === undefined ? null : runtime.enhancement),
    // ★ v8 追加（0.7.0「交接文档自动导出」）：导出状态与节流记忆。**`disabled` / `unavailable`
    //   都不是故障** —— 默认关、或探测不到 bili，只显示一行灰色 info，绝不进 `hookFaults`。
    handoff: handoffOf(runtime === undefined ? null : runtime),
    // ★ v9 追加（0.8.0「到量轮换」）：`off|idle|armed|unavailable` + 触发时间/token/字节 + 轮换记录。
    //   `off` / `idle` / `unavailable` / 缺席都不是故障。v10（0.9.0 方案 B）把**宿主建好的新会话 id**
    //   （`childId`）也放在这里：宿主建会话（0.21.1 起建完不写消息），客户端只 `sessions.open`。
    rotation: rotationOf(runtime === undefined ? null : runtime),
    // ★ v13 追加（0.18.0「新会话」）：可直接复制粘贴的开场话术（旧会话 id + 工作目录已填好）。
    //   与删掉 `room` / `fleet` 两个键同版，键数净 -1。空串与缺席都不是故障。
    newSession: newSessionViewOf(state, config),
  }
}
