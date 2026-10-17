/**
 * dsh-status-turbo / 客户端半 —— 两个槽位条目，共用同一份 `turbo` 投影。
 *
 *  1. **摘要行**（本文件主职）：`conversation.composer.dock`（list / session，"Ambient entries
 *     below the composer card"）—— 就是 DSH 自带 `6轮 283步 · 266 tok/s / 27.9M tok · 缓存命中 96%`
 *     那一行（由 `stats`、order 0 占据）。本插件以 `order: 1` 排在它右侧，并逐条复刻它的排版常量，
 *     使两格看起来是同一套东西。忙碌时回答"现在卡在哪"，**空闲时常驻一行上回合摘要**（U1）。
 *  2. **详情面板**：`conversation.input.dock`（list / session；children 声明实读
 *     `D:\deepseek-harness\packages\client\ui-conversation\lib\client.js:9977-9980` 的
 *     `{kind:"list",scope:"session"}`，渲染点 `renderSlot("conversation.input.dock", zone)` @ :7254，
 *     第一方先例 `TodoPanel`/`TodoDock` @ :6597/:6652 与注册 @ :6670）。点击摘要行那一格开/关；
 *     收起时组件**必须 `return null`**，否则会在 composer 上方留一条空的 `:empty` 带。
 *
 * 两者**不能合并进同一个 entry**：`conversation.composer.dock` 的容器是
 * `justify-content:center;align-items:center;gap:12px;display:flex`，里面已并排原生 `ContextMeter`；
 * 一个高面板塞进去会把那一行撑坏（PLAN.md §2.3）。
 *
 * 数据来源：`props.useProjection('turbo')` —— 与 `dsh-client-ui-conversation/lib/client.js` 里
 * `useProjection("plan" | "goal" | "todos" | ...)` 完全相同的官方读法，不碰宿主内存、不轮询。
 * 两个条目的 props 都由槽位标准包补齐（实读
 * `D:\deepseek-harness\packages\client\ui-renderer\lib\types\client\scoped-slots.js:319-321`：
 * `sessionId` 与 `useProjection` 恒在，另有条目自带的 `t`、`locale`）。
 *
 * `slots.register(options, component)` 契约（实读 dsh-client-ui-slots/lib/index.js:163-221）：
 *  - `options.name` 必须已被父条目的 children 表声明，否则 throw `slot "<name>" is not declared`；
 *  - kind 为 `list` 时 **`options.id` 必填**（:182），且同 (id, priority) 重复注册会 throw（:184）；
 *  - `order` / `locale` / `registrant` 均为合法字段。
 */

window.__ModuleLoader__.load({
  id: 'dsh-status-turbo',
  factory(require) {
    // 与 dsh-cache-billing/lib/client.js:2-4 逐字相同的装载约定：
    // 既写 module.exports 又返回它 ⇒ 无论 loader 取返回值还是取 module，都不会拿到空模块。
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-status-turbo'
    /**
     * 挂载点：DSH **自带**的 composer 底部状态行。
     *
     * 实读依据（本机源码树 `D:\deepseek-harness\packages\client\ui-conversation\lib\client.js`）：
     *   `:9981` children 表里 `conversation.composer.dock: { kind: "list", scope: "session" }`；
     *   `:10219-10224` 原生统计行 `ctx.slots.register({ name: "conversation.composer.dock", id: "stats",
     *   order: 0, locale: NS }, StatsLine)`；
     *   `:7243` 渲染点 `renderSlot("conversation.composer.dock", zone)`。
     * scope `session` ⇒ props 由槽位标准包补齐（实读
     * `ui-renderer/lib/types/client/scoped-slots.js:319-321`：`sessionId` 与 `useProjection` 恒在）。
     *
     * 0.4.0 起从 `conversation.input.dock`（composer 上方那条通栏）搬到 `conversation.composer.dock`
     * （底部原生统计行）—— 用户实测反馈：悬在 composer 上方"很突兀"。
     *
     * **0.20.0 又搬回来**（用户 m07554 原话「目前底部状态栏 都拥挤在一起了。是否可以调整到输入框的
     * 上面？截图红框的地方？」）：底部那行挤了自动继续 / 完全权限 / 专家 / 详情 / 识图 / Go / 用量 /
     * 模型 / 麦克风…，摘要行被夹在中间。搬回 `conversation.input.dock`（口径原文 "Full-width entries
     * above the composer card"），与自家详情面板同一格。
     */
    const SLOT = 'conversation.input.dock'
    /** 排在自家详情面板（order 0）之后、其它插件之前。 */
    const ORDER = 1
    /**
     * 第二个槽位条目：详情面板。
     *
     * 它是**独立条目**，不是摘要行的一部分 —— 两个槽位的容器排版契约不同，塞在一起会互相破坏
     * （PLAN.md §2.3）。`order: 0` 与同槽第一方 TodoDock 同档，id 不同 ⇒ 不会撞注册。
     */
    const DETAIL_SLOT = 'conversation.input.dock'
    const DETAIL_ID = 'dsh-status-turbo.detail'
    const DETAIL_ORDER = 0
    const PROJECTION_KEY = 'turbo'
    const STATUS_ID = 'dsh-status-turbo.status'
    /**
     * 设置侧栏的挂载点与条目 id（0.16.0 起；0.18.0 删掉名册页后只剩「全部设置项」一页）。
     *
     * `settings.section` 是 DSH 设置面板的根槽位（list）：注册需要 `id`，显示名走 `label`。
     * 数据面**不是**这个 id：0.15.0 起设置存在本插件条目自己的 `Config` 里（见 `CONFIG_ENTRY_IDS`），
     * 条目 id 与这里的槽位 id 无关。旧设置服务里那套命名空间读写（`settingsScope`）只作后备。
     */
    const SETTINGS_SLOT = 'settings.section'
    const SETTINGS_ITEMS_ID = 'dsh-status-turbo.settings'
    const SETTINGS_ITEMS_ORDER = 106
    const SETTINGS_NAMESPACE = NS
    /**
     * 0.15.0：设置表单按**条目 id** 取（`ctx.configForms.get(entryId)`）。条目 id 由安装方式决定 ——
     * 由 bundle 的 include 带出来的条目叫 `include:<包名>`（本机实测就是这个），显式 `id:` 的条目
     * 就用那个 id。两个候选按可能性排序，用到第一个能给出表单的为止。
     */
    const CONFIG_ENTRY_IDS = [`include:${NS}`, NS]
    /**
     * 0.14.0：左侧栏入口 + 主面板页（0.18.0 起是「新会话」页：轮换状态 + 可复制的开场话术）。
     * 0.18.2：左侧栏入口与 `main` 主面板页整条撤掉（话术卡并进设置页），这里只剩插件 id ——
     * 设置页那一格由 `settings.section` 的契约描述，见 `registerSettingsSection`。
     */
    const PANEL_ID = 'dsh-status-turbo'
    /**
     * 宿主 state.js 的 TURBO_STATE_VERSION，用于识别半片版本错配。
     * v10 = 36 键 wire 视图（0.9.0 起轮换记录多了 `childId` / `message`，仍在这同一个 `rotation` 键下；
     * 0.21.1 起不再有 `seedOk`/`seedBytes`）。
     * v11 = 37 键（0.10.0 追加顶层 `room`）、v12 = 38 键（0.13.0 追加顶层 `fleet`）——
     * 0.18.0 把这两个键整个删掉（群聊与编队不再存在），同时新增 `newSession`（开场话术）。
     */
    const EXPECTED_V = 13

    /**
     * 客户端硬编码兜底数字。
     *
     * 为什么要有这张表：客户端是纯 UI 半片，只在**宿主字段缺席**时才用这些数字，但它们必须和
     * 宿主那一侧同源，否则出现「宿主按 A 判、界面按 B 说」的静默漂移。本文件不 import 宿主半
     * （两个半片各自独立打包），所以只能把来源写在这里，并让测试去核。
     *
     * - `noProgressMs`：与 `lib/state.js · DEFAULT_CONFIG.noProgressMs`（90000）一致。
     *   宿主在 wire 里恒下发 `noProgressMs`（`toView` 用 `num(config.noProgressMs, DEFAULT_CONFIG.noProgressMs)`），
     *   这里的值只在旧半片/脏快照缺席时兜底。
     * - `listLimit`：活动流最多渲染多少条。来源 `lib/state.js:85` 的 `activityLimit` 默认值 24。
     * - `toolLimit`：`topTools` / `waitTools` 两个列表的展示上限。来源 `lib/state.js:429` 的
     *   `TOP_TOOLS_LIMIT = 5`；宿主投影本来最多就 5 条，切片只防旧半片/脏快照给的超长数组。
     */
    const CLIENT_FALLBACK = {
      /** 来源：`lib/state.js · DEFAULT_CONFIG.noProgressMs = 90000`。 */
      noProgressMs: 90000,
      /** 活动流渲染上限（宿主 `activityLimit` 默认 24）。 */
      listLimit: 24,
      /** Top-N 工具列表展示上限（宿主 `TOP_TOOLS_LIMIT`）。 */
      toolLimit: 5,
    }

    /**
     * M1/M3：界面时钟的节拍（毫秒）。状态条的脉动与详情面板「现在」那一行的秒数都挂在**同一个**
     * 节拍上：只有一个时钟，才不会出现两个节奏互相拍频（脉动周期取它的整数倍，见 `statusBody`）。
     */
    const CLOCK_TICK_MS = 1000

    /**
     * 投影宽限期。
     *
     * 依据（实读 `dsh-session-projection/lib/index.js`）：`cellFor()` 对任意会话**总会物化一个 cell**
     * —— 即使该会话零事件，`buildCell` 也会用 `init()` 折叠出一个 `{state, observedSeq:-1}`。
     * 而客户端从会话打开时的 `projectionBaseline(sessions)` 就能拿到 `projections` map。
     * ⇒ **投影缺席不等于"空闲"，而是宿主半没注册/没激活**。
     * 给一点宽限（网络/装载/首帧），超过就把它显示出来，不再静默。
     *
     * 文案里**不写死秒数**（L11）：`error.missingProjection` 用 `{grace}` 占位，渲染时填
     * `fmtElapsed(PROJECTION_GRACE_MS)`，阈值改了文案跟着变，不会说谎。 */
    const PROJECTION_GRACE_MS = 8000

    /**
     * B4 缓存前缀失效告警的**新鲜期**：状态条只在最近 5 分钟内失效过时插那条告警。
     * 过期不再显示 —— 一次失效不该在半小时后还占着那一行（PLAN.md §3.2）。
     * 判定完全在客户端，宿主只给 `prefixEpoch` / `prefixCause` / `prefixAt` 三个事实。
     *
     * L5：过期判定用的是**渲染期**的 `now`，而空闲态刻意不挂定时器（U1 那一格是静态的）。
     * 取舍：到点后那条告警要等下一次投影更新或下一次交互才消失 —— 代价只是多显示一会儿，
     * 而空闲期常驻一个 1s 定时器是每个会话每秒一次的常驻开销（M3 的同一个理由）。
     * 结论：**接受延迟，不挂定时器**；忙碌期由 M3 的那个 1s 时钟自然收掉。
     */
    const PREFIX_FRESH_MS = 300000

    /**
     * `prefixCause` 的中文名（PLAN.md §3.2）。与 `PHASE_LABEL` 同一手法：locale 服务在时用它的译文，
     * 不在时用这张表 —— 宿主拿不到 t 也不能让界面出现 `bulk-injection` 这种内部词（SPEC U7）。
     */
    const PREFIX_CAUSE_LABEL = {
      'compaction-start': '压缩开始',
      'compaction-end': '压缩结束',
      'bulk-injection': '大块结果注入',
    }

    const PHASE_LABEL = {
      zh: {
        idle: '空闲',
        assembling: '组装提示词',
        requesting: '请求模型',
        streaming: '流式输出',
        tool: '执行工具',
        approval: '等审批',
        compacting: '压缩上下文',
      },
      en: {
        idle: 'idle',
        assembling: 'assembling prompt',
        requesting: 'requesting model',
        streaming: 'streaming',
        tool: 'running tool',
        approval: 'awaiting approval',
        compacting: 'compacting',
      },
    }

    const DICT = {
      zh: {
        'phase.idle': PHASE_LABEL.zh.idle,
        'phase.assembling': PHASE_LABEL.zh.assembling,
        'phase.requesting': PHASE_LABEL.zh.requesting,
        'phase.streaming': PHASE_LABEL.zh.streaming,
        'phase.tool': PHASE_LABEL.zh.tool,
        'phase.approval': PHASE_LABEL.zh.approval,
        'phase.compacting': PHASE_LABEL.zh.compacting,
        'settings.items': '全部设置项',
        'settings.itemsIntro':
          '本插件的全部配置项，按组分区；改完即写，不用重启。标「重启生效」的几项在启动时就被读走，要完全重启 DSH 才生效。',
        'settings.restartBadge': '重启生效',
        'settings.group.status': '状态条与展示',
        'settings.group.judge': '卡住判定',
        'settings.group.inject': '注入与裁剪',
        'settings.group.redact': '脱敏与证据',
        'settings.group.handoff': '交接与轮换',
        'settings.group.other': '其它',
        'settings.field.statusBar': '状态条',
        'settings.field.noProgressMs': '无进展判定毫秒',
        'settings.field.slowMs': '慢调用毫秒',
        'settings.field.downgrade': '降级提醒',
        'settings.field.downgradeFloor': '降级底线',
        'settings.field.minQuietSteps': '最少安静步数',
        'settings.field.stuckAction': '卡住动作',
        'settings.field.stuckRounds': '卡住轮数',
        'settings.field.stuckRepeats': '重复次数',
        'settings.field.mojibakeMinRuns': '乱码最少次数',
        'settings.field.spillThresholdBytes': '溢出阈值（字节）',
        'settings.field.localTrimHeadChars': '本地裁剪头部字符',
        'settings.field.localTrimTailChars': '本地裁剪尾部字符',
        'settings.field.localTrimMinChars': '本地裁剪最小字符',
        'settings.field.bulkInjectionBytes': '批量注入字节',
        'settings.field.activityLimit': '活动条数上限',
        'settings.field.activityBytes': '活动字节上限',
        'settings.field.reasoningChars': '推理展示字符',
        'settings.field.resultHeadLines': '结果头部行数',
        'settings.field.redactKeys': '脱敏键（一行一个）',
        'settings.field.evidenceWhitelist': '证据白名单（一行一条）',
        'settings.field.readOnlyTools': '只读工具白名单',
        'settings.field.subagentWaitTools': '子 Agent 等待工具',
        'settings.field.humanWaitTools': '人类等待工具',
        'settings.field.jobWaitTools': '后台任务等待工具',
        'settings.field.handoffExport': '导出交接包',
        'settings.field.handoffExportTokens': '交接包 token 阈值',
        'settings.field.handoffExportBytes': '交接包字节阈值',
        'settings.field.handoffExportWindowPercent': '交接包窗口占比（%）',
        'settings.field.rotation': '轮换模式（off / manual / auto）',
        'settings.field.rotationCreate': '自动建新会话（关＝只提醒）',
        'settings.field.rotationFreshMs': '轮换新鲜度窗口（毫秒）',
        'settings.field.rotationCooldownMs': '轮换冷却（毫秒）',
        'settings.field.rotationRequireIdle': '仅空闲时轮换',
        'settings.field.rotationOpenChild': '建好后自动切过去',
        'settings.field.rotationArchiveOld': '轮换后归档旧会话',
        'settings.field.rotationIncreaseTitle': '给新会话起递增标题',
        'settings.field.rotationSeedMessage': '开场话术模板（{old} / {cwd}）',
        'settings.field.handoffExportMinDeltaTokens': '交接包最小增量 token',
        'settings.field.handoffExportMinDeltaBytes': '交接包最小增量字节',
        'settings.field.handoffExportDir': '交接包导出目录',
        'settings.field.handoffExportFull': '导出完整交接包',
        'settings.field.handoffExportBiliBin': 'bili 可执行文件路径',
        'settings.field.handoffExportTimeoutMs': '交接包导出超时（毫秒）',
        'settings.field.handoffExportMaxPerProcess': '每进程导出次数上限',
        'settings.field.handoffExportSubLanes': '子代理也出交接包',
        'settings.field.handoffExportFreshMs': '交接包新鲜度窗口（毫秒）',
        'settings.field.handoffExportRefreshBytes': '交接包刷新字节',
        'copy.button': '复制话术',
        'copy.done': '已复制',
        'copy.failed': '复制失败，请手动选中',
        'copy.name': '会话名称',
        'copy.id': '会话 ID',
        'copy.logDir': '会话日志目录',
        'copy.task': '继续处理未完成的任务',
        'settings.intro':
          '配置人群（＝房间）与每个角色的人设、信息主体、工作区、Agent 预设。建/加入房间时按角色名自动成为它的职责，投喂消息时随正文一起发过去；保存后立即生效，不用重启。工作区与预设只在会话到量换新会话时生效（已有会话的工作目录改不了）。',
        'settings.loading': '读取中…',
        'settings.unavailable': '设置服务不可用（本机 DSH 没有该设置命名空间），这页改不了。',
        'settings.readonly': '当前设置只读（可能由管理员配置），这页改不了。',
        'settings.empty': '还没有人群。先「添加人群」，再往里加角色。',
        'settings.addGroup': '添加人群',
        'settings.removeGroup': '删除人群',
        'settings.groupTopic': '这伙人干什么',
        'settings.addMember': '添加角色',
        'settings.removeMember': '删除角色',
        'settings.role': '角色名',
        'settings.persona': '人设 / 职责分工',
        'settings.subject': '信息主体（是谁、从哪来、交付什么）',
        'settings.workspace': '工作区',
        'settings.workspaceDefault': '沿用会话当前工作区',
        'settings.preset': 'Agent 预设',
        'settings.presetDefault': '默认（跟随 DSH）',
        'settings.presetCordis': '创造模式',
        'settings.members': '角色',
        'settings.save': '保存',
        'settings.discard': '放弃改动',
        'settings.saved': '已保存',
        'settings.dirty': '有未保存的改动',
        'settings.saveFailed': '保存失败：',
        'settings.saveRejected': '宿主拒绝了这次写入（多半是并发冲突），改动还留着，请再点一次保存。',
        'settings.count': '共 {n} 个人群、{m} 个角色',
        'label.lastTurn': '上回合',
        'unit.bytes': 'bytes',
        'unit.seconds': '秒',
        'aria.panel': '会话状态详情',
        'label.phase': '阶段',
        'label.stepElapsed': '本步耗时',
        'label.gear': '档位',
        'label.step': '步数',
        'label.lastTurnMs': '上回合耗时',
        'label.hitRate': '本步缓存命中率',
        'label.stepTokens': '本步 token',
        'label.phaseElapsed': '已用 {elapsed}',
        'label.turnTokens': '本回合 token',
        'label.times': '次',
        'label.slowest': '最慢',
        'label.avg': '平均',
        'gear.default': '默认',
        'value.none': '—',
        'empty.noTurn': '没有已结束的上回合',
        'empty.noTools': '本会话还没有真执行的工具调用',
        'empty.waitTools': '本会话还没有等待类的工具调用',
        'section.turn': '本回合',
        'section.lastTurn': '上回合',
        'section.usage': '缓存与用量',
        'section.prefix': '前缀',
        'section.topTools': '最慢的工具',
        'section.waitTools': '等待占用',
        'section.spill': '最近瘦身',
        'section.hookFaults': '最近的故障',
        'section.enhancement': '工具增强',
        'enhancement.active': '已启用',
        'enhancement.absent': '未启用',
        'enhancement.mode.host': '已启用（宿主裁剪）',
        'enhancement.mode.local': '已启用（本地裁剪）',
        'enhancement.reason.pruner':
          '本机把结果瘦身服务隔离在插件组内（preset 的 isolate 设置），组外读不到属于设计',
        'enhancement.reason.store': '没有落盘后端',
        'enhancement.reason.other': '可选增强能力不可用',
        'section.handoff': '交接文档',
        'section.rotation': '会话轮换',
        // 0.13.0 编队（wire v12 的顶层 `fleet`）：本会话的智能体家族与各自的上下文占用。
        // 0.18.0 左侧栏入口与主面板页（同一 id 派发）：只读页，轮换状态 + 可复制的开场话术。
        'panel.title': '新会话',
        'panel.heading': '新会话',
        'panel.session': '当前会话',
        'panel.none': '当前没有会话 —— 先在左侧选一个会话。',
        'panel.loading': '等待该会话的投影…',
        'panel.script': '开场话术',
        'panel.noScript': '拿不到开场话术：宿主没有报出这段文本。',
        'panel.copy': '复制',
        'panel.copied': '已复制',
        'panel.copyFailed': '复制失败，请手动选中',
        'panel.cwd': '工作目录',
        'panel.usage': '在新会话里粘贴这段文本：新会话会知道该去查哪条旧会话。',
        'rotation.off': '未开启（config.rotation = off）',
        'rotation.idle': '等待达到阈值',
        'rotation.remind': '已到轮换阈值 · 建议开新会话（开场话术在设置页可复制）',
        'rotation.remindShort': '建议开新会话',
        'rotation.armed.manual': '新会话已就绪 · 点这里切过去',
        'rotation.armed.auto': '新会话已就绪 · 正在自动切换…',
        'rotation.armed.waiting': '新会话已就绪 · 等当前回合结束再切',
        'rotation.armed.wait-now': '点这里立刻切过去（不用等这一轮跑完）',
        'rotation.armed.archive': '切过去并归档当前会话',
        'rotation.running': '正在轮换…',
        'rotation.done': '已轮换',
        'rotation.ready': '新会话已就绪 · 点这里重试',
        'rotation.retry': '点这里重试',
        'rotation.failed': '轮换失败',
        'rotation.unavailable': '宿主没能建出新会话',
        'rotation.reason.disabled': '轮换已关闭（config.rotation = off）',
        'rotation.reason.no-cwd': '这个会话在投影里没有绝对路径工作目录',
        'rotation.reason.no-service': '客户端没有可用的切会话接口（uiWorkspace.openSession / sessions.open）',
        'rotation.reason.create-failed': '建会话被拒（id 撞车或工作目录不合格）',
        'rotation.reason.other': '未预期的错误',
        'handoff.disabled': '未开启（config.handoffExport = false）',
        'handoff.idle': '等待达到阈值',
        'handoff.running': '正在导出…',
        'handoff.done': '已导出',
        'handoff.failed': '导出失败',
        'handoff.unavailable': '未找到 bili（缺席，不是故障）',
        'handoff.msg.limit-reached': '本进程导出次数已达上限',
        'handoff.msg.no-cwd': '拿不到会话工作目录',
        'handoff.msg.mkdir-failed': '建导出目录失败',
        'handoff.msg.timeout': '超时',
        'handoff.msg.exit': '进程退出码 {code}',
        'section.now': '现在',
        'section.activity': '活动流',
        'empty.activity': '还没有活动记录',
        'label.think': '思考',
        'label.call': '调用',
        'label.ok': '完成',
        'label.fail': '失败',
        'label.turnEnd': '回合结束',
        'label.thisTurnSubagents': '本轮',
        'label.subagentUnit': '个',
        'label.totalElapsed': '累计',
        /** M7：标签与值之间的分隔符（CJK 全角）。渲染路径按它是否有尾随空格决定英文断行。 */
        'label.colon': '：',
        'wait.subagent': '等子代理',
        'wait.human': '等你回答',
        'wait.job': '等后台任务',
        'prefix.failed': '前缀已失效',
        'prefix.none': '本会话前缀未失效',
        'prefix.epoch': '失效次数',
        'prefix.last': '最近一次',
        'prefix.cause.compaction-start': '压缩开始',
        'prefix.cause.compaction-end': '压缩结束',
        'prefix.cause.bulk-injection': '大块结果注入',
        'prefix.cause.none': '—',
        'prefix.note':
          '说明：压缩会重写历史，提示词缓存前缀随之作废；命中率会在接下来几步里下降，这不是故障。',
        'detail.title': '详情',
        'detail.toggle.closed': '▸ 详情',
        'detail.toggle.open': '▾ 收起',
        'hook.fault': '工具增强失败，点开看详情',
        'stall.tool': '工具仍在运行，只是还没有新输出',
        'stall.other': '已长时间没有新进展，最可能在 bash 里',
        'stall.toolShort': '无新输出',
        'stall.otherShort': '无新进展',
        'error.notReady': '挂载点未提供 useProjection',
        'hint.slowTool': '超过 {n} 的调用可交给后台任务插件 run_command',
        'hint.topTools': '只列最慢的 {n} 条（共 {total} 条）',
        'hint.waitTools': '只列最长的 {n} 条（共 {total} 条）',
        'hint.activityTail': '只显示最近 {n} 条，更早的 {hidden} 条已省略',
        'error.render': '状态条渲染失败',
        'error.mountStatus': '状态条开关缺失：配置未送达',
        'error.detail': '详情面板渲染失败',
        'error.versionMismatch': '投影版本错配（宿主 v{host} ≠ 客户端 v{client}）',
        'error.missingProjection':
          '宿主半似乎没起来：等待投影超过 {grace} 仍未到达（已等 {waited}）',
        'error.missingProjectionAge': '已等 {waited}',
        /** L8：给读屏用的相位播报。整串是「阶段 {phase}」，中间的冒号同样是本地化分隔符。 */
        'aria.phase': '阶段 {phase}',
      },
      en: {
        'phase.idle': PHASE_LABEL.en.idle,
        'phase.assembling': PHASE_LABEL.en.assembling,
        'phase.requesting': PHASE_LABEL.en.requesting,
        'phase.streaming': PHASE_LABEL.en.streaming,
        'phase.tool': PHASE_LABEL.en.tool,
        'phase.approval': PHASE_LABEL.en.approval,
        'phase.compacting': PHASE_LABEL.en.compacting,
        'settings.items': 'All settings',
        'settings.itemsIntro':
          'Every configuration key of this plugin, grouped; edits are written immediately. Items marked "restart" are read at startup and need a full DSH restart. The roster (crowds and roles) is edited on the Group chat page.',
        'settings.restartBadge': 'restart',
        'settings.group.status': 'Status bar & display',
        'settings.group.judge': 'Stuck detection',
        'settings.group.inject': 'Injection & trimming',
        'settings.group.redact': 'Redaction & evidence',
        'settings.group.handoff': 'Handoff & rotation',
        'settings.group.other': 'Other',
        'settings.field.statusBar': 'Status bar',
        'settings.field.noProgressMs': 'No-progress threshold (ms)',
        'settings.field.slowMs': 'Slow call threshold (ms)',
        'settings.field.downgrade': 'Downgrade notice',
        'settings.field.downgradeFloor': 'Downgrade floor',
        'settings.field.minQuietSteps': 'Minimum quiet steps',
        'settings.field.stuckAction': 'Stuck action',
        'settings.field.stuckRounds': 'Stuck rounds',
        'settings.field.stuckRepeats': 'Repeat count',
        'settings.field.mojibakeMinRuns': 'Mojibake minimum runs',
        'settings.field.spillThresholdBytes': 'Spill threshold (bytes)',
        'settings.field.localTrimHeadChars': 'Local trim — head chars',
        'settings.field.localTrimTailChars': 'Local trim — tail chars',
        'settings.field.localTrimMinChars': 'Local trim — minimum chars',
        'settings.field.bulkInjectionBytes': 'Bulk injection bytes',
        'settings.field.activityLimit': 'Activity entries limit',
        'settings.field.activityBytes': 'Activity bytes limit',
        'settings.field.reasoningChars': 'Reasoning display chars',
        'settings.field.resultHeadLines': 'Result head lines',
        'settings.field.redactKeys': 'Redacted keys (one per line)',
        'settings.field.evidenceWhitelist': 'Evidence allowlist (one per line)',
        'settings.field.readOnlyTools': 'Read-only tool allowlist',
        'settings.field.subagentWaitTools': 'Subagent wait tools',
        'settings.field.humanWaitTools': 'Human wait tools',
        'settings.field.jobWaitTools': 'Background job wait tools',
        'settings.field.handoffExport': 'Export handoff bundle',
        'settings.field.handoffExportTokens': 'Handoff token threshold',
        'settings.field.handoffExportBytes': 'Handoff byte threshold',
        'settings.field.handoffExportWindowPercent': 'Handoff window percent (%)',
        'settings.field.rotation': 'Rotation mode (off / manual / auto)',
        'settings.field.rotationCreate': 'Create a new session automatically (off = remind only)',
        'settings.field.rotationFreshMs': 'Rotation freshness window (ms)',
        'settings.field.rotationCooldownMs': 'Rotation cooldown (ms)',
        'settings.field.rotationRequireIdle': 'Rotate only while idle',
        'settings.field.rotationOpenChild': 'Switch to the new session automatically',
        'settings.field.rotationArchiveOld': 'Archive the old session after rotating',
        'settings.field.rotationIncreaseTitle': 'Give the new session an incremented title',
        'settings.field.rotationSeedMessage': 'Opening brief template ({old} / {cwd})',
        'settings.field.handoffExportMinDeltaTokens': 'Handoff minimum delta tokens',
        'settings.field.handoffExportMinDeltaBytes': 'Handoff minimum delta bytes',
        'settings.field.handoffExportDir': 'Handoff export directory',
        'settings.field.handoffExportFull': 'Export the full handoff bundle',
        'settings.field.handoffExportBiliBin': 'bili executable path',
        'settings.field.handoffExportTimeoutMs': 'Handoff export timeout (ms)',
        'settings.field.handoffExportMaxPerProcess': 'Handoff exports per process',
        'settings.field.handoffExportSubLanes': 'Export handoffs for subagents too',
        'settings.field.handoffExportFreshMs': 'Handoff freshness window (ms)',
        'settings.field.handoffExportRefreshBytes': 'Handoff refresh bytes',
        'copy.button': 'Copy brief',
        'copy.done': 'Copied',
        'copy.failed': 'Copy failed — select it manually',
        'copy.name': 'Session name',
        'copy.id': 'Session ID',
        'copy.logDir': 'Session log directory',
        'copy.task': 'Continue the unfinished work',
        'settings.intro':
          'Every configuration key of this plugin, grouped. Edits apply immediately; entries marked as requiring a restart are read at startup, so a full DSH restart is needed for those. Group chat and the agent-family fleet view were removed in 0.18.0.',
        'settings.loading': 'loading…',
        'settings.unavailable': 'settings service unavailable (this DSH build has no such namespace) — this page cannot be edited.',
        'settings.readonly': 'these settings are read-only (likely managed centrally) — this page cannot be edited.',
        'settings.empty': 'no groups yet — add one, then add its roles.',
        'settings.addGroup': 'add group',
        'settings.removeGroup': 'remove group',
        'settings.groupTopic': 'what this group does',
        'settings.addMember': 'add role',
        'settings.removeMember': 'remove role',
        'settings.role': 'role name',
        'settings.persona': 'persona / duties',
        'settings.subject': 'subject (who it is, where it comes from, what it delivers)',
        'settings.workspace': 'workspace',
        'settings.workspaceDefault': 'keep the session’s current workspace',
        'settings.preset': 'agent preset',
        'settings.presetDefault': 'default (follow DSH)',
        'settings.presetCordis': 'creator mode',
        'settings.members': 'roles',
        'settings.save': 'save',
        'settings.discard': 'discard',
        'settings.saved': 'saved',
        'settings.dirty': 'unsaved changes',
        'settings.saveFailed': 'save failed: ',
        'settings.saveRejected': 'the host rejected this write (usually a concurrent change); your edits are kept — press save again.',
        'settings.count': '{n} groups, {m} roles',
        'label.lastTurn': 'last turn',
        'unit.bytes': 'bytes',
        'unit.seconds': 's',
        'aria.panel': 'session status details',
        'label.phase': 'phase',
        'label.stepElapsed': 'step elapsed',
        'label.gear': 'gear',
        'label.step': 'step',
        'label.lastTurnMs': 'last turn took',
        'label.hitRate': 'step cache hit rate',
        'label.stepTokens': 'step tokens',
        'label.phaseElapsed': 'elapsed {elapsed}',
        'label.turnTokens': 'turn tokens',
        'label.times': 'calls',
        'label.slowest': 'slowest',
        'label.avg': 'avg',
        'gear.default': 'default',
        'value.none': '—',
        'empty.noTurn': 'no finished turn yet',
        'empty.noTools': 'no actually-executed tool call in this session yet',
        'empty.waitTools': 'no waiting tool call in this session yet',
        'section.turn': 'This turn',
        'section.lastTurn': 'Last turn',
        'section.usage': 'Cache and usage',
        'section.prefix': 'Prefix',
        'section.topTools': 'Slowest tools',
        'section.waitTools': 'Waiting on',
        'section.spill': 'Latest spill',
        'section.hookFaults': 'Recent faults',
        'section.enhancement': 'Tool enhancement',
        'enhancement.active': 'enabled',
        'enhancement.absent': 'disabled',
        'enhancement.mode.host': 'enabled (host pruner)',
        'enhancement.mode.local': 'enabled (local trim)',
        'enhancement.reason.pruner':
          'this machine isolates the result-pruning service inside a plugin group (preset isolate), so outside plugins cannot read it — that is by design',
        'enhancement.reason.store': 'no result-spill backend',
        'enhancement.reason.other': 'optional enhancement capability unavailable',
        'section.handoff': 'Handoff export',
        'section.rotation': 'Session rotation',
        // 0.18.0 sidebar entry and main-panel page (same id dispatches the two): read-only,
        // the session's rotation state plus a copy-ready opening script.
        'panel.title': 'New session',
        'panel.heading': 'New session',
        'panel.session': 'Current session',
        'panel.none': 'No current session — pick one in the left sidebar first.',
        'panel.loading': 'waiting for this session’s projection…',
        'panel.script': 'Opening script',
        'panel.noScript': 'No opening script: the host did not report this text.',
        'panel.copy': 'Copy',
        'panel.copied': 'copied',
        'panel.copyFailed': 'copy failed — select it manually',
        'panel.cwd': 'Working directory',
        'panel.usage': 'Paste this into the new session: it will know which old session to look up.',
        'rotation.off': 'off (config.rotation = off)',
        'rotation.idle': 'waiting for threshold',
        'rotation.remind': 'rotation threshold reached · consider starting a new session (copy the opening line from the settings page)',
        'rotation.remindShort': 'consider a new session',
        'rotation.armed.manual': 'new session ready · click to switch to it',
        'rotation.armed.auto': 'new session ready · switching automatically…',
        'rotation.armed.waiting': 'new session ready · switching when the current turn ends',
        'rotation.armed.wait-now': 'click to switch now (no need to wait for this turn)',
        'rotation.armed.archive': 'switch and archive the current session',
        'rotation.running': 'rotating…',
        'rotation.done': 'rotated',
        'rotation.ready': 'new session ready · click to retry',
        'rotation.retry': 'click to retry',
        'rotation.failed': 'rotation failed',
        'rotation.unavailable': 'the host could not create a new session',
        'rotation.reason.disabled': 'rotation is off (config.rotation = off)',
        'rotation.reason.no-cwd': 'this session has no absolute working directory in the projection',
        'rotation.reason.no-service': 'the client has no way to switch sessions (uiWorkspace.openSession / sessions.open)',
        'rotation.reason.create-failed': 'session creation was rejected (id collision or an unusable working directory)',
        'rotation.reason.other': 'unexpected error',
        'handoff.disabled': 'off (config.handoffExport = false)',
        'handoff.idle': 'waiting for threshold',
        'handoff.running': 'exporting…',
        'handoff.done': 'exported',
        'handoff.failed': 'export failed',
        'handoff.unavailable': 'bili not found (absence, not failure)',
        'handoff.msg.limit-reached': 'per-process export limit reached',
        'handoff.msg.no-cwd': 'session working directory unavailable',
        'handoff.msg.mkdir-failed': 'could not create the export directory',
        'handoff.msg.timeout': 'timed out',
        'handoff.msg.exit': 'process exited with code {code}',
        'section.now': 'Now',
        'section.activity': 'Activity',
        'empty.activity': 'no activity recorded yet',
        'label.think': 'think',
        'label.call': 'call',
        'label.ok': 'done',
        'label.fail': 'failed',
        'label.turnEnd': 'turn end',
        'label.thisTurnSubagents': 'this turn',
        'label.subagentUnit': '',
        'label.totalElapsed': 'total',
        /** M7：英文用半角冒号 + 尾随空格（`phase: idle`，不是 `phase：idle`）。 */
        'label.colon': ': ',
        'wait.subagent': 'waiting on subagent',
        'wait.human': 'waiting for your answer',
        'wait.job': 'waiting on background job',
        'prefix.failed': 'prompt prefix invalidated',
        'prefix.none': 'no prefix invalidation in this session',
        'prefix.epoch': 'invalidations',
        'prefix.last': 'most recent',
        'prefix.cause.compaction-start': 'compaction started',
        'prefix.cause.compaction-end': 'compaction ended',
        'prefix.cause.bulk-injection': 'bulk result injected',
        'prefix.cause.none': '—',
        'prefix.note':
          'Why: compaction rewrites history, so the cached prompt prefix is discarded; the hit rate drops over the next few steps — this is not a fault.',
        'detail.title': 'Details',
        'detail.toggle.closed': '▸ details',
        'detail.toggle.open': '▾ collapse',
        'hook.fault': 'tool enhancement failed — open details',
        'stall.tool': 'tool still running, just no new output yet',
        'stall.other': 'no new progress for a while — most likely sitting in bash',
        'stall.toolShort': 'no new output',
        'stall.otherShort': 'no new progress',
        'error.notReady': 'mount point hook missing',
        'hint.slowTool': 'calls over {n} can be handed to the background-job plugin run_command',
        'hint.topTools': 'showing the top {n} of {total}',
        'hint.waitTools': 'showing the longest {n} of {total}',
        'hint.activityTail': 'showing the latest {n}; {hidden} earlier entries are hidden',
        'error.render': 'status bar failed to render',
        'error.mountStatus': 'status bar switch missing: config never arrived',
        'error.detail': 'detail panel failed to render',
        'error.versionMismatch': 'projection version mismatch (host v{host} ≠ client v{client})',
        'error.missingProjection':
          'host half looks absent: the projection never arrived (waited > {grace}, {waited} so far)',
        'error.missingProjectionAge': 'waited {waited}',
        'aria.phase': 'phase {phase}',
      },
    }

    /**
     * 占位符替换：`{host}` / `{client}` / `{grace}` / `{n}` / `{total}` / `{waited}` / `{phase}`。
     *
     * 为什么不用 `String.replace` 逐次调用：模板与参数都来自本文件，但 `t()` 可能返回**宿主**那份
     * 译文（键相同、占位符约定相同）。统一走一次全局替换，参数值里的 `$` 不会被当成替换模式
     * （`replace` 的函数形式没有这个问题，字符串形式有）。
     *
     * @param {string} template 含占位符的模板。
     * @param {object} [values] 占位符名 → 值。
     * @returns {string} 填好的文案；模板不是字符串时原样返回。
     */
    function fillPlaceholders(template, values) {
      if (typeof template !== 'string') return template
      if (values === undefined || values === null || typeof values !== 'object') return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
      )
    }

    /** 取文案：`props.t` 拿不到或原样返回 key 时退回内置字典，保证界面永不空转。 */
    function makeText(t) {
      return (key, fallback, values) => {
        let found = null
        if (typeof t === 'function') {
          try {
            const value = t(key)
            if (typeof value === 'string' && value !== '' && value !== key) found = value
          } catch {
            /* fall through to the built-in dictionary */
          }
        }
        return fillPlaceholders(found === null ? fallback : found, values)
      }
    }

    /**
     * 内置词典兜底。`makeText` 只在 locale 服务真的给出译文时才采用它的值，否则用调用点传的
     * fallback —— 调用点一旦把 fallback 写成内部键名，用户看到的就是 `rotationFreshMs` 这种生名字
     * （0.21.0，用户 m08351）。这里统一先查内置中文词典，再退到硬编码兜底。
     */
    function textOf(text, key, hard) {
      const builtin = DICT.zh[key]
      return text(key, typeof builtin === 'string' && builtin !== '' ? builtin : hard)
    }

    function pickLabel(key, text) {
      return text(`phase.${key}`, PHASE_LABEL.zh[key] || key)
    }

    /**
     * M7：标签与值的分隔符**由语言决定**，不再把全角冒号写死在渲染路径里。
     *
     * 判据是字典里 `label.colon` 的**首字符**：CJK 全角冒号（U+FF1A）后面不接空格，其余（`': '`）
     * 原样带着空格。用首字符而不是「有没有空格」是因为 `text()` 可能被宿主换掉，
     * 而全角/半角冒号这个事实不会变。
     *
     * @param {Function} text `makeText` 出来的取词函数。
     * @returns {string} 分隔符（可含尾随空格）。
     */
    function labelSeparator(text) {
      const sep = text('label.colon', '：')
      return typeof sep === 'string' && sep !== '' ? sep : '：'
    }

    /**
     * 0.6.3：耗时一律中文天/时/分/秒。
     * 分档：<1s 取整毫秒；<1min 保留一位小数（整秒丢 `.0`）；再上按分/时/天逐级拆分。
     * 分钟及以上分支的"秒"取 **floor**（不四舍五入）：18726648ms 必须是 `5小时12分6秒`
     * ——四舍五入会把它写成 `5小时12分7秒`，与任务书的硬断言矛盾（见交付申报的偏离项）。
     */
    function fmtElapsed(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
      if (ms < 1000) return `${Math.round(ms)}毫秒`
      if (ms < 60000) {
        const seconds = (ms / 1000).toFixed(1)
        return `${seconds.endsWith('.0') ? seconds.slice(0, -2) : seconds}秒`
      }
      const totalSeconds = Math.floor(ms / 1000)
      if (ms < 3600000) {
        const minutes = Math.floor(totalSeconds / 60)
        return `${minutes}分${totalSeconds - minutes * 60}秒`
      }
      const totalMinutes = Math.floor(totalSeconds / 60)
      if (ms < 86400000) {
        const hours = Math.floor(totalMinutes / 60)
        const minutes = totalMinutes - hours * 60
        return `${hours}小时${minutes}分${totalSeconds - totalMinutes * 60}秒`
      }
      const days = Math.floor(totalMinutes / 1440)
      const restMinutes = totalMinutes - days * 1440
      const hours = Math.floor(restMinutes / 60)
      return `${days}天${hours}小时${restMinutes - hours * 60}分`
    }

    /**
     * 0.19.2：状态条专用的紧凑耗时 —— 一分钟以内 `49s`、一小时以内 `2:49`、更久 `1:02:03`。
     *
     * 详情面板继续用 `fmtElapsed` 的中文长写法（`2分49秒`）；状态条那一行要和原生 pill
     * 挤在同一行里，长写法会把整行撑开并压到邻座（用户 0.19.1 反馈「太丑了」）。
     * `null` = 给不出数字，调用方据此整段不渲染。
     */
    function fmtElapsedCompact(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
      if (ms < 1000) return `${Math.round(ms)}ms`
      if (ms < 60000) {
        const seconds = (ms / 1000).toFixed(1)
        return `${seconds.endsWith('.0') ? seconds.slice(0, -2) : seconds}s`
      }
      const two = (value) => (value < 10 ? `0${value}` : String(value))
      const totalSeconds = Math.floor(ms / 1000)
      const totalMinutes = Math.floor(totalSeconds / 60)
      if (totalMinutes < 60) return `${totalMinutes}:${two(totalSeconds % 60)}`
      const hours = Math.floor(totalMinutes / 60)
      return `${hours}:${two(totalMinutes - hours * 60)}:${two(totalSeconds % 60)}`
    }

    function fmtTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
      if (value < 1000) return String(Math.round(value))
      if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}K`
      return `${(value / 1000000).toFixed(1)}M`
    }

    /** 等宽数字字体栈：跳秒时数字宽度不变，整行不会左右抖动。 */
    const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

    /**
     * 主题 token 都是纯色，颜色只用它们会得到"死白大色块"。
     * `color-mix` 调出淡淡的底色/描边，兼容 Electron 44（Chromium ≥111），且不引入样式表。
     * token 缺失时 `var()` 回落成合法颜色，声明仍然有效，不会把整条规则打废。
     */
    function tint(color, percent) {
      return `color-mix(in srgb, ${color} ${percent}%, transparent)`
    }

    /*
     * ── 原生 composer 状态行的排版常量 ────────────────────────────────────────────
     *
     * 逐条抄自 `@deepseek-ai/dsh-client-ui-chat/lib/client.js:6893` 里 `StatsPills` 注入的
     * CSS 模块（`.iq1doa_root` / `.iq1doa_pill` / `.iq1doa_sep` / `.iq1doa_label`）。
     *
     * 这是 `references/practices.md:35` 要求的写法：**不要 import 别人的 client 包**
     * （它们随时会变、纯 JS 没有类型检查、import 一抛就把整个格子打空），
     * 而是把标记与样式抄过来、改名成本插件自己的结构。
     *
     * 唯一目的：我这一格必须看起来和它旁边那格是**同一种东西**，而不是外挂上去的。
     */
    const ROW_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      minWidth: 0,
      maxWidth: '100%',
      /* U4：窄屏时宁可换行，也不要横向溢出把 composer 顶宽。 */
      flexWrap: 'wrap',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    }

    const PILL_STYLE = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      maxWidth: '100%',
      padding: '1px 8px',
      border: 'none',
      borderRadius: '999px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      fontVariantNumeric: 'tabular-nums',
      lineHeight: 'inherit',
      whiteSpace: 'nowrap',
      userSelect: 'none',
    }

    /** 原生那一行的根容器。`data-` 属性用本插件自己的名字，不去冒充别人的标记。 */
    function row(children, extra) {
      const props = { 'data-dsh-status-turbo-row': true, ...(extra || {}) }
      props.style = extra && extra.style ? { ...ROW_STYLE, ...extra.style } : ROW_STYLE
      return h('div', props, children)
    }

    /**
     * 状态条末尾「复制话术」按钮的样式：**复用 pill 那一套**，只多一个手型光标。
     *
     * 它和邻格共处一行，长得不像 pill 就会被看成「另一个插件塞进来的东西」（与 0.19.2 收窄状态条
     * 同一条理由）。用 `<button>` 而不是 `<div>` 是为了键盘可点。
     */
    const COPY_BUTTON_STYLE = { ...PILL_STYLE, cursor: 'pointer' }

    /**
     * 原生意义上的一个 pill，按内容收缩。
     *
     * 第 4 个参数是**元素属性**而不是样式：`aria-*` / `role` 这类可访问性属性必须落在 props 上，
     * 混进 `style` 会被浏览器当成未知 CSS 声明直接丢掉 —— 读屏软件一个字段也收不到。
     */
    function pill(key, children, style, attrs) {
      return h(
        'span',
        { key, ...(attrs || {}), style: style === undefined ? PILL_STYLE : { ...PILL_STYLE, ...style } },
        children,
      )
    }

    /**
     * 行内分隔点：颜色沿用原生统计行的 `--dsw-alias-separator-primary`。
     *
     * 间距 **`0 6px`**：这是宿主那一行的实际值（lead 复核）。本仓源码树里写成 `0 10px`，
     * 旧值 `0 1px` 是此前唯一肉眼可见的排版偏差 —— 分隔点几乎贴住两侧文字。
     */
    function sep(key) {
      return h('span', { key, style: { color: 'var(--dsw-alias-separator-primary)', margin: '0 6px' } }, '·')
    }

    /**
     * 14×14 行内图标，`currentColor` 描边，尺寸与原生 `.iq1doa_pill svg{width:14px;height:14px}` 一致。
     * **本插件自己画**，不引用任何图标组件 —— 按 §9 第 2 条，没有图标名可以写错，就没有崩界面的可能。
     */
    function icon(key, paths) {
      return h(
        'svg',
        {
          key,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { flex: 'none', width: '14px', height: '14px' },
        },
        paths,
      )
    }

    const GLYPH_TOKENS = [
      h('path', { key: 'a', d: 'M3 4.5h10' }),
      h('path', { key: 'b', d: 'M3 8h10' }),
      h('path', { key: 'c', d: 'M3 11.5h6' }),
    ]
    const GLYPH_WARN = [
      h('path', { key: 'a', d: 'M8 2.8 14 13H2z' }),
      h('path', { key: 'b', d: 'M8 6.6v3' }),
      h('path', { key: 'c', d: 'M8 11.4h.01' }),
    ]
    const GLYPH_STOP = [
      h('circle', { key: 'a', cx: 8, cy: 8, r: 5.5 }),
      h('path', { key: 'b', d: 'M6 6l4 4M10 6l-4 4' }),
    ]

    /** 相位点：与原生同量级、不额外占宽度；`opacity` 由本地时钟驱动。 */
    function dot(color, opacity) {
      return h('span', {
        key: 'dot',
        style: {
          flex: 'none',
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: color,
          opacity,
        },
      })
    }

    /**
     * 出问题时的药丸。**它必须一直在这一行里可见**（§9 第 3 条：不许静默 return）。
     * 只在出错时着色，正常态不占额外视觉重量。
     */
    function alertPill(kind, message) {
      const accent =
        kind === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)'
      return row([
        pill(
          'alert',
          [
            icon('icon', kind === 'error' ? GLYPH_STOP : GLYPH_WARN),
            h(
              'span',
              {
                key: 'msg',
                style: {
                  /* U4：长告警（例如带耗时的 E-A02）必须截断，不能给那一行加横向溢出。 */
                  minWidth: 0,
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              `${NS}: ${message}`,
            ),
          ],
          {
            color: accent,
            background: tint(accent, 10),
            borderRadius: '10px',
            padding: '1px 10px',
            whiteSpace: 'normal',
          },
        ),
      ])
    }

    function errorPill(message) {
      return alertPill('error', message)
    }

    /** 黄色告警：不是致命错误，但"本该有东西却没来"。 */
    function warnPill(message) {
      return alertPill('warn', message)
    }

    /**
     * 空闲态那一格 —— **常驻**，不是消失（SPEC U1 / PLAN.md D2(a)）。
     *
     * 优先用宿主给的 `idleLine`（PLAN §3.0 定义：`{阶段中文名} · 上回合 {耗时}`）；字段缺席时
     * 用同一套规则就地拼一行。无论怎样都返回一个 pill：空闲不等于"没东西可看"。
     */
    function idlePill(snapshot, text, attrs) {
      const phase = typeof snapshot.phase === 'string' ? snapshot.phase : 'idle'
      const lastTurnMs = snapshot.lastTurnMs
      const derived =
        typeof lastTurnMs === 'number' && Number.isFinite(lastTurnMs)
          ? `${pickLabel(phase, text)} · ${text('label.lastTurn', '上回合')} ${fmtElapsed(lastTurnMs) || `${Math.round(lastTurnMs)}毫秒`}`
          : pickLabel(phase, text)
      const line = typeof snapshot.idleLine === 'string' && snapshot.idleLine !== '' ? snapshot.idleLine : derived
      return pill('idle', [
        dot('var(--dsw-alias-label-caption)', 1),
        h('span', { key: 'v', style: { color: 'var(--dsw-alias-label-secondary)' } }, line),
      ], undefined, attrs)
    }

    /**
     * B4：最近 5 分钟内有缓存前缀失效 ⇒ 状态条插一条告警。
     *
     * 只说"失效了"，**不显示次数/百分比** —— 那些数字进详情面板，别把这一行撑满。
     */
    function prefixAlertPill(snapshot, now, text) {
      const epoch =
        typeof snapshot.prefixEpoch === 'number' && Number.isFinite(snapshot.prefixEpoch) ? snapshot.prefixEpoch : 0
      const at = typeof snapshot.prefixAt === 'number' && Number.isFinite(snapshot.prefixAt) ? snapshot.prefixAt : null
      if (epoch <= 0 || at === null) return null
      const age = now - at
      if (age < 0 || age > PREFIX_FRESH_MS) return null
      return pill(
        'prefix',
        [icon('i', GLYPH_WARN), h('span', { key: 'v' }, text('prefix.failed', '前缀已失效'))],
        {
          color: 'var(--dsw-alias-state-warn-primary)',
          background: tint('var(--dsw-alias-state-warn-primary)', 10),
        },
      )
    }

    /**
     * 详情面板的开/关指示。纯文字：本插件不 import 图标组件（SPEC G2）。
     */
    function detailTogglePill(text, sessionId) {
      return pill('toggle', [
        h(
          'span',
          { key: 'v' },
          isDetailOpen(sessionId) ? text('detail.toggle.open', '▾ 收起') : text('detail.toggle.closed', '▸ 详情'),
        ),
      ])
    }

    /**
     * H5：本插件"唯一的交互入口"（摘要行那一格）—— 鼠标与键盘都必须能用。
     *
     * 零构建（无样式表）⇒ 一个伪类态都写不出来，只能靠 `cursor` 常显"这里能点"；
     * 同理键盘可达性也只能靠 `tabIndex` + `onKeyDown` 手工补齐（WCAG 2.1 AA 的 2.1.1 / 4.1.2）：
     *  - `role="button"`：读屏把它当按钮，而不是一团文字；
     *  - `tabIndex: 0`：进 Tab 序；
     *  - `aria-expanded`：说清点击后展开还是收起；
     *  - Enter 与 Space 都触发，**Space 要 `preventDefault`** —— 否则页面会同时向下滚动。
     *
     * @param {Array} children 内容。
     * @param {object} props 槽位 props（取 `sessionId` 与展开态）。
     * @returns {object} 可点可聚焦的一行。
     */
    function clickableRow(children, props) {
      const sessionId = props && props.sessionId
      const activate = () => toggleDetail(sessionId)
      return row(children, {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': isDetailOpen(sessionId) === true,
        onClick: activate,
        onKeyDown: (event) => {
          if (event === null || typeof event !== 'object') return
          const key = event.key
          if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return
          // Space 的默认行为是滚动页面：接管它，行为才和原生按钮一致。
          if (key !== 'Enter' && typeof event.preventDefault === 'function') event.preventDefault()
          activate()
        },
        style: { cursor: 'pointer' },
      })
    }

    /**
     * 状态条复制按钮的正文（0.21.0）：会话名称 + 会话 ID + 会话日志目录 + 一句「继续处理未完成的任务」。
     *
     * 名称与日志目录都是宿主在 wire 的 `newSession` 里补的（`state.js` 零依赖、不碰环境，算不出
     * 会话标题与落盘路径），拿不到就省掉那一行 —— 绝不用空值占位。
     */
    function sessionCopyTextOf(view, text) {
      const card =
        view !== null && view !== undefined && typeof view === 'object' && view.newSession !== null && typeof view.newSession === 'object'
          ? view.newSession
          : null
      const lines = []
      if (card !== null && typeof card.title === 'string' && card.title !== '') {
        lines.push(`${text('copy.name', '会话名称')}：${card.title}`)
      }
      if (card !== null && typeof card.oldId === 'string' && card.oldId !== '') {
        lines.push(`${text('copy.id', '会话 ID')}：${card.oldId}`)
      }
      if (card !== null && typeof card.logDir === 'string' && card.logDir !== '') {
        lines.push(`${text('copy.logDir', '会话日志目录')}：${card.logDir}`)
      }
      lines.push(text('copy.task', '继续处理未完成的任务'))
      return lines.join('\n')
    }

    /**
     * 状态条末尾的「复制话术」按钮（0.21.0，用户 m08351）：点一下把上下文交接说明写进剪贴板。
     *
     * 状态条整行是可点的（展开详情），按钮必须 `stopPropagation`，否则点复制会顺带展开面板。
     * 反馈只活在本组件里，不写任何全局状态。
     */
    function CopyBriefButton(props) {
      const text = makeText(props && props.t)
      const [state, setState] = React.useState('')
      const label = state === 'done' ? text('copy.done', '已复制') : state === 'failed' ? text('copy.failed', '复制失败') : text('copy.button', '复制话术')
      return h(
        'button',
        {
          key: 'copy-brief',
          type: 'button',
          title: text('copy.button', '复制话术'),
          onClick: (event) => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            void copyText(props && props.block).then((ok) => setState(ok ? 'done' : 'failed'))
          },
          style: COPY_BUTTON_STYLE,
        },
        label,
      )
    }

    function statusBody(props, snapshot, now, mountedAt) {
      const text = makeText(props && props.t)

      if (typeof (props && props.useProjection) !== 'function') {
        // 挂载契约被破坏（槽位升级/换实现）—— 必须看见，不许静默什么都不渲染。
        return errorPill(text('error.notReady', '挂载点未提供 useProjection'))
      }
      if (snapshot === undefined || snapshot === null) {
        // 投影缺席 ≠ 空闲（宿主 cellFor 对零事件会话也会物化）。宽限期内静默，超过就报出来。
        // L11：秒数不写死在字典里 —— `{grace}` 由 `PROJECTION_GRACE_MS` 现场格式化，阈值改了文案
        // 跟着改；`{waited}` 是真实已等时长。两者都按「数字 + 单位（字典 `unit.seconds`）」成形，
        // 中文读作「8 秒」、英文读作「8 s」，不会留下中英混排的单位。
        const waited = typeof mountedAt === 'number' ? now - mountedAt : 0
        if (waited < PROJECTION_GRACE_MS) return null
        const unit = text('unit.seconds', '秒')
        const grace = `${Math.round(PROJECTION_GRACE_MS / 1000)} ${unit}`
        const waitedText = `${Math.round(waited / 1000)} ${unit}`
        return warnPill(
          text(
            'error.missingProjection',
            '宿主半似乎没起来：等待投影超过 {grace} 仍未到达（已等 {waited}）',
            { grace, waited: waitedText },
          ),
        )
      }
      if (snapshot.v !== undefined && snapshot.v !== EXPECTED_V) {
        // M5：这条是 EXPECTED_V 的核心保护，必须可本地化（两种语言各一份）。
        return errorPill(
          text('error.versionMismatch', '投影版本错配（宿主 v{host} ≠ 客户端 v{client}）', {
            host: String(snapshot.v),
            client: String(EXPECTED_V),
          }),
        )
      }
      /*
       * D3「死开关」（PLAN §3.1 三态）：
       *  - 'enabled'   → 正常渲染；
       *  - 'disabled'  → return null（宿主 statusBar:false，界面上这一格与详情面板都不该有）；
       *  - 缺失/其他值 → 红格。读不到开关状态 = 半片装配不对，不许静默什么都不画（§9#3）。
       */
      if (snapshot.mountStatus === 'disabled') return null
      if (snapshot.mountStatus !== 'enabled') {
        return errorPill(text('error.mountStatus', '状态条开关缺失：配置未送达'))
      }

      const extras = []
      const prefixPill = prefixAlertPill(snapshot, now, text)
      if (prefixPill !== null) extras.push(prefixPill)
      // §4.2：钩子故障只要发生过就留一条红字指路，逐条明细在详情面板里。
      if (Array.isArray(snapshot.hookFaults) && snapshot.hookFaults.length > 0) {
        extras.push(errorPill(text('hook.fault', '工具增强失败，点开看详情')))
      }
      extras.push(detailTogglePill(text, props && props.sessionId))
      /*
       * 0.21.2：复制话术按钮在空闲态也得在。它的用处就是「这一轮完了，拿这段去开新会话」，
       * 只在忙碌时给等于在最该用的时候把它藏起来（用户反馈：空闲时这一格没有复制按钮）。
       */
      extras.push(
        h(CopyBriefButton, { key: 'copy-brief', t: props && props.t, block: sessionCopyTextOf(snapshot, text) }),
      )

      // U1：空闲态常驻上回合摘要（旧行为是 `if (!snapshot.busy) return null`，那是"H2 空闲消失"）。
      if (!snapshot.busy) {
        return clickableRow(
          [
            // L8：空闲↔忙碌的切换也要播报，否则读屏用户不知道那一格活了。
            idlePill(snapshot, text, { 'aria-live': 'polite' }),
            ...extras,
          ],
          props,
        )
      }

      const phase = typeof snapshot.phase === 'string' ? snapshot.phase : 'idle'
      const toolName = typeof snapshot.tool === 'string' && snapshot.tool !== '' ? snapshot.tool : null
      const isTool = phase === 'tool' && toolName !== null

      /*
       * 0.6.1 + 0.6.3 等待态：`waitKind` 由宿主在 `tool/call` 时按工具名（0.6.3 起还要 `args.wait === true`）定好。
       * 此时阶段文字换成 `⏳ 等子代理` / `⏸ 等你回答` / `⏳ 等后台任务`；`subagents` 是本回合派生数（0 时不显示那一段）。
       * 已耗时仍走同一条 `phaseStartedAt` 路径，只是多一个「已」前缀，口径不变。
       */
      const waitKind =
        snapshot.waitKind === 'human' || snapshot.waitKind === 'subagent' || snapshot.waitKind === 'job'
          ? snapshot.waitKind
          : null
      const waitLabel =
        waitKind === 'human'
          ? `⏸ ${text('wait.human', '等你回答')}`
          : waitKind === 'subagent'
            ? `⏳ ${text('wait.subagent', '等子代理')}`
            : waitKind === 'job'
              ? `⏳ ${text('wait.job', '等后台任务')}`
              : null
      const subagentCount =
        typeof snapshot.subagents === 'number' && Number.isFinite(snapshot.subagents) && snapshot.subagents > 0
          ? Math.floor(snapshot.subagents)
          : 0
      // 量词只在需要的语言里带空格（en 的 `label.subagentUnit` 是空串）。
      const subagentUnit = text('label.subagentUnit', '个')
      const subagentPhrase = `${text('label.thisTurnSubagents', '本轮')} ${subagentCount}${subagentUnit === '' ? '' : ` ${subagentUnit}`}`

      const phaseElapsed = fmtElapsed(now - snapshot.phaseStartedAt)
      // 0.19.2：状态条那一行只留紧凑写法（`2:49`）；中文长写法退到 pill 的悬浮提示里。
      const phaseElapsedCompact = fmtElapsedCompact(now - snapshot.phaseStartedAt)
      const stepTokens = fmtTokens(snapshot.stepTokens)

      const sinceProgress = typeof snapshot.lastProgressAt === 'number' ? now - snapshot.lastProgressAt : null
      // 兜底数字收进 `CLIENT_FALLBACK`（来源见其定义处：与 `lib/state.js · DEFAULT_CONFIG.noProgressMs` 一致）。
      const threshold = typeof snapshot.noProgressMs === 'number' ? snapshot.noProgressMs : CLIENT_FALLBACK.noProgressMs
      const stalled = sinceProgress !== null && sinceProgress > threshold

      /*
       * M3：脉动**只保留给忙碌态**，且与 1s 的采样对齐。
       *
       * 旧写法 `Math.sin(now / 320)` 周期 ≈2.01s，被 500ms 采样成 4 点/周期，视觉上是跳变而不是
       * 脉动，还顺带把整行拖进 2Hz 重绘。现在把采样统一成**对齐整秒的 1s 一跳**（见本组件的
       * 心跳 effect），脉动周期取**采样周期的整数倍**：`sin(now·π/2000)` 周期恰为 4000ms，
       * 每个 1s 采样点落在 0、π/2、π、3π/2 上，得到 0.675 → 0.95 → 0.675 → 0.4 的稳定呼吸，
       * 不会因采样与波形不同步而忽快忽慢。
       * 空闲态本来就没有时钟（U1 那一格是静态的），给一个定值，别让首帧随机命中某个相位。
       */
      const pulse = snapshot.busy === true ? 0.4 + 0.55 * (0.5 + 0.5 * Math.sin((now * Math.PI) / 2000)) : 1
      const accent = stalled ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)'

      /*
       * 与原生那一行同构：几个 pill，行间距 12px，pill 内用 `·` 分段。
       *
       * 刻意**不重复**原生已经显示的东西 —— 它在同一行里已经给了「会话轮/步、tok/s、
       * 总 token、会话缓存命中、上下文占比」。本插件只补它没有的：**当下这一步是什么阶段、
       * 这一步已经耗了多久、这一步吐了多少 token、被降到什么档位、是不是卡住了**。
       * 「本轮耗时」也去掉了：原生那个 TimePill 已经给了整段会话时间，再加一个同一量级的数字是噪音。
       */
      const phaseText = waitLabel !== null ? waitLabel : pickLabel(phase, text)
      const phasePill = pill(
        'phase',
        [
          dot(accent, pulse),
          h(
            'span',
            { key: 'label', style: { color: 'var(--dsw-alias-label-secondary)' } },
            phaseText,
          ),
        isTool
          ? h(
              'span',
              { key: 'tool', style: { fontFamily: MONO, color: 'var(--dsw-alias-label-secondary)' } },
              toolName,
            )
          : null,
        waitKind === 'subagent' && subagentCount > 0 ? sep('sa') : null,
        waitKind === 'subagent' && subagentCount > 0
          ? h(
              'span',
              { key: 'subagents', style: { color: 'var(--dsw-alias-label-secondary)' } },
              subagentPhrase,
            )
          : null,
        phaseElapsed ? sep('t') : null,
        phaseElapsed ? h('span', { key: 'elapsed' }, waitKind === null ? phaseElapsedCompact : `已 ${phaseElapsedCompact}`) : null,
      ],
        undefined,
        // L8：播报的只有阶段名 —— pill 视觉上的秒数**不进** live 区（否则每秒朗读一次）。
        // 相位是离散字段，只在切换那一帧变，天然不需要额外节流。
        {
          'aria-label': text('aria.phase', '阶段 {phase}', { phase: phaseText }),
          'aria-live': 'polite',
          // 0.19.2：长写法只留在这里，视觉那一行不再写中文秒数。
          title: phaseElapsed === null ? undefined : text('label.phaseElapsed', '已用 {elapsed}', { elapsed: phaseElapsed }),
        },
      )

      const pills = [phasePill]
      /*
       * 0.19.2 紧凑化（用户反馈这一行「太丑了」）：它和原生 pill、邻座插件的 pill 共处一行，
       * 任何一段太长都会把整行撑破。于是——
       *  - 本步 token 只留数量（`3.1K tok`），不再重复「本步」两字；
       *  - **档位 pill 整块撤掉**：原生右侧的推理档选择器已经写着同一个值，这里再写一遍纯属重复；
       *    档位仍留在详情面板（`detailRow('gear', …)`），那里没有宽度压力；
       *  - 卡住告警只留「时长 + 四个字」，判据全文进 `title`。
       */
      if (stepTokens) {
        pills.push(
          pill(
            'step',
            [icon('i', GLYPH_TOKENS), h('span', { key: 'v' }, `${stepTokens} tok`)],
            undefined,
            { title: `${text('label.stepTokens', '本步 token')} ${stepTokens}` },
          ),
        )
      }
      // 0.20.0：到量只提醒、不建会话 —— 提醒要**不用展开面板也看得见**，所以这一行也占一格。
      // 整行点击本来就是开合详情面板，点下去正好落到 `rotationSection` 的那一行。
      const rotationRecord =
        snapshot.rotation !== null && typeof snapshot.rotation === 'object' ? snapshot.rotation : null
      if (rotationRecord !== null && rotationRecord.status === 'remind') {
        pills.push(
          pill(
            'remind',
            [icon('i', GLYPH_WARN), h('span', { key: 'v' }, text('rotation.remindShort', '建议开新会话'))],
            undefined,
            { title: text('rotation.remind', '已到轮换阈值 · 建议开新会话（开场话术在设置页可复制）') },
          ),
        )
      }
      if (stalled) {
        const stallLong = text(
          phase === 'tool' ? 'stall.tool' : 'stall.other',
          phase === 'tool' ? '工具仍在运行，只是还没有新输出' : '已长时间没有新进展，最可能在 bash 里',
        )
        pills.push(
          pill(
            'stall',
            [
              icon('i', GLYPH_WARN),
              h(
                'span',
                { key: 'v' },
                `${fmtElapsedCompact(sinceProgress)} ${text(phase === 'tool' ? 'stall.toolShort' : 'stall.otherShort', phase === 'tool' ? '无新输出' : '无新进展')}`,
              ),
            ],
            { color: 'var(--dsw-alias-state-warn-primary)', background: tint('var(--dsw-alias-state-warn-primary)', 10) },
            { title: `${fmtElapsed(sinceProgress)} ${stallLong}` },
          ),
        )
      }

      return clickableRow([...pills, ...extras], props)
    }

    /**
     * 每个会话"第一次被本组件渲染"的时刻。
     *
     * 不用 `useRef`：那只能记住"本组件实例"的挂载时刻，切换会话时组件实例可能被复用，
     * 新会话会继承旧会话的计时。而槽位提供了 `sessionId`（见 `standardProps`），
     * 按会话记账既准确，又不依赖任何组件实例状态。
     */
    const sessionSeenAt = new Map()

    function seenAtForSession(sessionId) {
      const key = sessionId === undefined || sessionId === null ? 'unknown' : String(sessionId)
      const seen = sessionSeenAt.get(key)
      if (seen !== undefined) return seen
      // 会话数量有界；保守起见超过 128 条就整体重置，避免无界增长。
      if (sessionSeenAt.size > 128) sessionSeenAt.clear()
      const now = Date.now()
      sessionSeenAt.set(key, now)
      return now
    }

    function TurboStatusBar(props) {
      const useProjection = props && props.useProjection
      const snapshot = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
      const missing = snapshot === undefined || snapshot === null
      const busy = !!(snapshot && snapshot.busy)
      const [now, setNow] = React.useState(() => Date.now())
      const mountedAt = seenAtForSession(props && props.sessionId)

      /*
       * M3：时钟只有**一个**节奏 —— 对齐整秒的 1s 一跳。
       *
       * 旧写法忙碌时 500ms 一轮，等于整行（各方 pill、脉动、耗时）2Hz 重绘；脉动波形又和采样
       * 不同相，看着像闪烁。现在用 `setTimeout` 递归调度并对齐到**下一个整秒边界**：
       *   - 秒级显示（阶段耗时）在秒位跳变的那一刻才更新，不会出现"数到 3 又跳回 2"的抖动；
       *   - 脉动的周期是 1s 的整数倍（见 `pulse` 处），采样点固定落在同一组相位上；
       *   - 订阅期（收到投影、空闲）里一个定时器都不留。
       */
      React.useEffect(() => {
        if (!busy && !missing) return undefined
        let handle = null
        const tick = () => {
          setNow(Date.now())
          handle = setTimeout(tick, CLOCK_TICK_MS - (Date.now() % CLOCK_TICK_MS))
        }
        handle = setTimeout(tick, CLOCK_TICK_MS - (Date.now() % CLOCK_TICK_MS))
        return () => {
          clearTimeout(handle)
        }
      }, [busy, missing])

      // L2：登记"用户正在看哪个会话"。状态条是常驻的，会话一换这里就更新，
      // 轮换重试链据此判断"该不该继续把用户往新会话上拽"。
      React.useEffect(() => {
        noteActiveSession(props && props.sessionId)
      }, [props && props.sessionId])

      // 宽限期内投影仍缺席 → console 侧也留一条，且只留一条。
      React.useEffect(() => {
        if (!missing) return undefined
        const handle = setTimeout(() => {
          console.error(
            `[${NS}] 投影「${PROJECTION_KEY}」超过 ${fmtElapsed(PROJECTION_GRACE_MS) || `${Math.round(PROJECTION_GRACE_MS)}毫秒`} 仍未到达：宿主半可能未注册或未激活（状态条位置已显示黄色提示）`,
          )
        }, PROJECTION_GRACE_MS)
        return () => {
          clearTimeout(handle)
        }
      }, [missing])

      // 0.9.3：auto 轮换的触发点在**常驻**的状态条上。useEffect 在 render 返回 null 时照样执行，
      // 而状态条永远挂着；详情面板收起时是整棵子树被卸掉，挂在里面的触发点一句都不会跑。
      // auto 只在会话空闲时切：宿主建新会话不打断正在跑的回合，但 `sessions.open` 会把用户从
      // 正在跑的回合里拽走。未空闲时只显示「等当前回合结束再切」，下一次投影更新（phase 变 idle）
      // 会重跑本 effect，**不需要定时器**。
      const rotation = snapshot !== null && typeof snapshot === 'object' ? snapshot.rotation : null
      const rotationSource = rotation !== null && typeof rotation === 'object' ? rotation : null
      const rotationSessionId =
        rotationSource !== null && typeof rotationSource.sessionId === 'string' && rotationSource.sessionId !== '' ? rotationSource.sessionId : null
      const rotationStatus = rotationSource !== null && typeof rotationSource.status === 'string' ? rotationSource.status : 'idle'
      const rotationMode = rotationSource !== null && typeof rotationSource.mode === 'string' ? rotationSource.mode : 'manual'
      const rotationChildId =
        rotationSource !== null && typeof rotationSource.childId === 'string' && rotationSource.childId !== '' ? rotationSource.childId : null
      const rotationAt = rotationSource !== null && typeof rotationSource.at === 'number' && Number.isFinite(rotationSource.at) ? rotationSource.at : null
      const rotationIdle = snapshot !== null && typeof snapshot === 'object' && snapshot.phase === 'idle'

      // 结果落地必须重渲染：状态条平时只在 busy / missing 时才有定时器，否则这份本地记录变了它也不知道。
      const [, setRotationTick] = React.useState(0)
      React.useEffect(() => subscribeRotation(() => setRotationTick((tick) => tick + 1)), [])

      React.useEffect(() => {
        // wire 换了新目标（或状态从别处**回到** armed）就作废本地结果，否则一次失败会让该会话
        // 因为「已经有 outcome」被早退条件永久挡住。
        syncRotationOutcome(rotationSessionId, rotationStatus, rotationChildId, rotationAt)
        if (rotationStatus === 'armed' && rotationMode === 'auto' && rotationIdle) performRotation(snapshot)
      }, [rotationSessionId, rotationStatus, rotationMode, rotationIdle, rotationChildId, rotationAt])

      try {
        return statusBody(props, snapshot, busy ? now : Date.now(), mountedAt)
      } catch (error) {
        // §9 第 3 条：渲染期异常必须变成界面上的红字，而不是白屏或悄悄消失。
        console.error(`[${NS}] 状态条渲染失败`, error)
        return errorPill(`${makeText(props && props.t)('error.render', '状态条渲染失败')}: ${error && error.message ? error.message : String(error)}`)
      }
    }

    /*
     * ── 详情面板 ────────────────────────────────────────────────────────────────
     *
     * 挂 `conversation.input.dock`（PLAN.md §2.3 的第二个 entry）。它与摘要行是**两个独立槽位
     * 条目**，不在一棵 React 树上 ⇒ 没有共同的父级 state 可以提升，只能按 sessionId 在模块级
     * 记账 + 一张订阅表（与下面 `sessionSeenAt` 同一手法；同样不能用 `useRef`：组件实例在切换
     * 会话时可能被复用，会把上一个会话的开合状态带过来）。
     */
    const detailOpen = new Map()
    const detailListeners = new Set()

    function detailKey(sessionId) {
      return sessionId === undefined || sessionId === null ? 'unknown' : String(sessionId)
    }

    function isDetailOpen(sessionId) {
      return detailOpen.get(detailKey(sessionId)) === true
    }

    function toggleDetail(sessionId) {
      const key = detailKey(sessionId)
      // 会话数量有界；超过 128 条整体重置，避免无界增长（与会话计时表同一策略）。
      if (detailOpen.size > 128 && !detailOpen.has(key)) detailOpen.clear()
      detailOpen.set(key, detailOpen.get(key) !== true)
      for (const listener of detailListeners) {
        try {
          listener()
        } catch {
          /* 一个订阅者抛错不能带走其他订阅者，更不能带走摘要行 */
        }
      }
    }

    function subscribeDetail(listener) {
      detailListeners.add(listener)
      return () => {
        detailListeners.delete(listener)
      }
    }

    /**
     * 面板排版常量。零构建 ⇒ 全是 inline style，没有样式表；
     * 伪类、过渡、媒体查询这些全靠样式表的东西统统用不了（SPEC G1）。
     * U4 要求根节点 `maxWidth:100%` + `boxSizing:border-box` + `overflow:hidden`，
     * 每个值行 `whiteSpace:nowrap` + `overflow:hidden` + `textOverflow:ellipsis`。
     */
    /**
     * M3 / M4：面板里的「重绘源」与「定时器」互不干扰。
     *
     * 面板自己不发 `setInterval`：秒数相关的只有 `now`，而 `now` 由**展开态**下 1s 一次的心跳
     * （见 `CLOCK_TICK_MS` 的调用点）驱动。分区组件因此可以在 `React.memo` 之下只在**各自的
     * 投影切片**变化时重绘。
     */
    const PANEL_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      width: '100%',
      maxWidth: '100%',
      // M9：展开后最多占视口 60%，超出就在面板内滚动 —— 12 个分区叠起来比 composer 还高时，
      // 旧写法会把输入框顶到屏幕外。`minHeight: 0` 是 flex 子项能收缩、进而能滚的前提。
      // U4 的 `overflow:'hidden'` 必须留着（它是横轴也是兜底），纵向由 `overflowY` 这一长hand覆盖。
      maxHeight: '60vh',
      minHeight: 0,
      overflow: 'hidden',
      overflowX: 'hidden',
      overflowY: 'auto',
      padding: '6px 12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '12px',
      background: 'var(--dsw-specific-tip)',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    }

    const PANEL_HEADER_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minWidth: 0,
      maxWidth: '100%',
      padding: 0,
      border: 'none',
      background: 'none',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
    }

    const PANEL_SECTION_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      minWidth: 0,
      maxWidth: '100%',
    }

    const VALUE_ROW_STYLE = {
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      minWidth: 0,
      maxWidth: '100%',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }

    const VALUE_TEXT_STYLE = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    /** `HH:MM:SS`（本地时区）—— 前缀失效与钩子故障都用它，避免同一份时间出现两种写法。 */
    function fmtClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
      const at = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    }

    /** 投影字段可能来自旧半片/脏事件；渲染层不做算术，只负责别把 `undefined` 写进界面。 */
    function safeText(value, fallback) {
      return value === undefined || value === null || value === '' ? fallback : String(value)
    }

    /**
     * M7：面板里的「标签：值」行。
     *
     * 分隔符不写死全角冒号 —— 英文界面里 `phase：idle` 这种中英混排是明显的排版事故。
     * 由 `labelSeparator(text)` 按语言给出（zh `：` / en `': '`）。
     *
     * M9：值行被省略号截断时，`title` 让用户悬停能看到全文（等宽行同样挂上）。
     */
    function detailRow(key, label, value, mono) {
      return h('div', { key, style: VALUE_ROW_STYLE }, [
        h(
          'span',
          { key: 'k', style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' } },
          `${label}${detailRowText === null ? '：' : labelSeparator(detailRowText)}`,
        ),
        h(
          'span',
          {
            key: 'v',
            title: value === undefined || value === null ? undefined : String(value),
            style: mono === true ? { ...VALUE_TEXT_STYLE, fontFamily: MONO } : { ...VALUE_TEXT_STYLE, color: 'var(--dsw-alias-label-secondary)' },
          },
          value,
        ),
      ])
    }

    /**
     * M7：`detailRow` 需要知道用哪个分隔符，但它有十几个调用点，逐个加参数只会让签名更难读。
     * 改为「渲染期绑定」：每个分区函数入口调一次 `bindDetailRowText(text)`，`detailRow` 读模块级
     * 当前值。面板的渲染是同步单线程的，不存在两次渲染交错，所以这个绑定不会串。
     * （不用 `WeakMap` 缓存：`text` 是 `makeText` 每次渲染现算的，缓存反而每次都是新键。）
     */
    let detailRowText = null

    /** 把当前 `text` 绑定给 `detailRow` 用；返回原值方便写成 `const text = bindDetailRowText(makeText(...))`。 */
    function bindDetailRowText(text) {
      if (typeof text === 'function') detailRowText = text
      return text
    }

    /**
     * L7：分区标题是**标题**，不是一行加粗文字 —— 读屏用户靠 `role="heading"` 才能按标题跳读。
     * 用 `aria-level` 就不用真的产出 `<h3>` 标签（分区在 `<div>` 树里，`<h3>` 会引入 UA 默认
     * 字号/外边距，本插件零样式表压不住），语义一样、样式可控。
     */
    function sectionHeading(title) {
      return { role: 'heading', 'aria-level': 3, style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 500 } }
    }

    /**
     * L7：分区 = 一个具名 `region` + 一个三级标题。
     *
     * `role="region"` 只在**有可访问名**时才有意义（无名的 region 等同于普通 div，还会污染
     * 读屏的区域列表），所以名字直接复用标题文案。
     */
    function detailSection(key, title, rows) {
      return h(
        'div',
        {
          key,
          role: 'region',
          'aria-label': title,
          style: PANEL_SECTION_STYLE,
        },
        [
          h('div', { key: 'h', ...sectionHeading(title) }, title),
          // 行必须**摊平**进 children：`halves.test.mjs` 是按 `children.slice(1)` 逐行读 style 的，
          // 塞成嵌套数组会让「每一行都受截断保护」这条契约变成对数组取 `.props`。
          ...rows,
        ],
      )
    }

    /** §3.2：前缀分区恒在。没失效过就说没失效过，而不是留一片空白让用户猜。 */
    function prefixRows(snapshot, text) {
      /*
       * L5：这里只把 `prefixAt` 用 `fmtClock` 打成绝对时刻，**不按渲染时刻**算「多久以前」。
       * 面板空闲时不挂任何时钟（见 M1 的心跳），任何渲染期的 `now` 都会冻在打开面板的那一刻；
       * 新鲜度这种相对时间交给宿主投影自己带过来，界面不做二次推断。
       */
      const epoch =
        typeof snapshot.prefixEpoch === 'number' && Number.isFinite(snapshot.prefixEpoch) ? snapshot.prefixEpoch : 0
      if (epoch <= 0) {
        return [h('div', { key: 'none', style: VALUE_ROW_STYLE }, text('prefix.none', '本会话前缀未失效'))]
      }
      const causeKey =
        snapshot.prefixCause === undefined || snapshot.prefixCause === null ? null : String(snapshot.prefixCause)
      const cause = causeKey === null ? '—' : text(`prefix.cause.${causeKey}`, PREFIX_CAUSE_LABEL[causeKey] || '—')
      return [
        detailRow('epoch', text('prefix.epoch', '失效次数'), String(epoch), true),
        detailRow('last', text('prefix.last', '最近一次'), `${cause} @ ${fmtClock(snapshot.prefixAt)}`),
        h('div', { key: 'note', style: VALUE_ROW_STYLE }, text('prefix.note', '说明：压缩会重写历史，提示词缓存前缀随之作废；命中率会在接下来几步里下降，这不是故障。')),
      ]
    }

    /**
     * 0.6.3（C）：参数摘要后缀。`argPreview` 已在宿主侧脱敏并截断，这里再过一道 `safeText`；
     * 没有摘要（`null` / 空串）就不加后缀，不给行尾留一个孤零零的 `·`。
     */
    function argSuffix(tool) {
      const preview = tool && typeof tool.argPreview === 'string' ? tool.argPreview.trim() : ''
      return preview === '' ? '' : ` · ${safeText(preview, '')}`
    }

    /** 0.6.3（C）：超过 `slowMs` 的调用加 ⚠ 前缀（`slow` 由宿主按 `maxMs >= slowMs` 算好）。 */
    function slowMark(tool) {
      return tool && tool.slow === true ? '⚠ ' : ''
    }

    /**
     * 0.6.3（C）：分区尾部的指路行 —— 只有真的出现慢行时才占版面，阈值用 `fmtElapsed(slowMs)` 说人话。
     * `slowMs` 缺席或非法时宁可不显示这句，也不写出 "超过 null"。
     */
    function slowHintRow(tools, snapshot, text) {
      if (!tools.some((tool) => tool && tool.slow === true)) return null
      const slowMs = snapshot && snapshot.slowMs
      const threshold =
        typeof slowMs === 'number' && Number.isFinite(slowMs) && slowMs >= 0
          ? fmtElapsed(slowMs) || `${Math.round(slowMs)}毫秒`
          : null
      if (threshold === null) return null
      return h(
        'div',
        { key: 'slow-hint', style: { ...VALUE_ROW_STYLE, color: 'var(--dsw-alias-label-tertiary)' } },
        text('hint.slowTool', '超过 {n} 的调用可交给后台任务插件 run_command').replace('{n}', threshold),
      )
    }

    /** §3.6：最慢的工具 Top-5（0.6.1 起只含真执行的工具），逐行 `{⚠}{name} · {count} 次 · 最慢 {可读} · 平均 {可读}{ · 参数摘要}`。 */
    function topToolsSection(snapshot, text) {
      const none = text('value.none', '—')
      const all = Array.isArray(snapshot.topTools) ? snapshot.topTools : []
      const tools = all.slice(0, CLIENT_FALLBACK.toolLimit)
      const rows =
        tools.length === 0
          ? [h('div', { key: 'none', style: VALUE_ROW_STYLE }, text('empty.noTools', '本会话还没有真执行的工具调用'))]
          : tools.map((tool, index) =>
              h(
                'div',
                { key: toolRowKey('tool', tool, index), style: { ...VALUE_ROW_STYLE, fontFamily: MONO } },
                `${slowMark(tool)}${safeText(tool && tool.name, none)} · ${safeText(tool && tool.count, none)} ${text('label.times', '次')} · ${text('label.slowest', '最慢')} ${fmtElapsed(tool && tool.maxMs) || none} · ${text('label.avg', '平均')} ${fmtElapsed(tool && tool.avgMs) || none}${argSuffix(tool)}`,
              ),
            )
      const limit = limitHintRow(
        'limit-hint',
        all.length,
        tools.length,
        text('hint.topTools', '只列最慢的 {n} 条（共 {total} 条）', { n: tools.length, total: all.length }),
      )
      if (limit !== null) rows.push(limit)
      const hint = slowHintRow(tools, snapshot, text)
      if (hint !== null) rows.push(hint)
      return detailSection('topTools', text('section.topTools', '最慢的工具'), rows)
    }

    /**
     * 0.6.1 + 0.6.3：等待占用 Top-5（等子代理 / 等你回答 / 等后台任务），逐行
     * `{⚠}{等…} · {name} · {count} 次 · 累计 {sumMs 可读} · 最慢 {maxMs 可读}{ · 参数摘要}`。
     * 空态与 `topTools` 分开，免得把「没有等待」说成「没有工具」。
     */
    function waitToolsSection(snapshot, text) {
      const none = text('value.none', '—')
      const all = Array.isArray(snapshot.waitTools) ? snapshot.waitTools : []
      const tools = all.slice(0, CLIENT_FALLBACK.toolLimit)
      const rows =
        tools.length === 0
          ? [
              h(
                'div',
                { key: 'none', style: VALUE_ROW_STYLE },
                text('empty.waitTools', '本会话还没有等待类的工具调用'),
              ),
            ]
          : tools.map((tool, index) => {
              const waitLabel =
                tool && tool.kind === 'human'
                  ? text('wait.human', '等你回答')
                  : tool && tool.kind === 'job'
                    ? text('wait.job', '等后台任务')
                    : text('wait.subagent', '等子代理')
              const sumMs = tool && tool.sumMs
              const total =
                typeof sumMs === 'number' && Number.isFinite(sumMs)
                  ? fmtElapsed(sumMs) || `${Math.round(sumMs)}毫秒`
                  : none
              return h(
                'div',
                { key: toolRowKey('wait', tool, index), style: { ...VALUE_ROW_STYLE, fontFamily: MONO } },
                `${slowMark(tool)}${waitLabel} · ${safeText(tool && tool.name, none)} · ${safeText(tool && tool.count, none)} ${text('label.times', '次')} · ${text('label.totalElapsed', '累计')} ${total} · ${text('label.slowest', '最慢')} ${fmtElapsed(tool && tool.maxMs) || none}${argSuffix(tool)}`,
              )
            })
      const limit = limitHintRow(
        'limit-hint',
        all.length,
        tools.length,
        text('hint.waitTools', '只列最长的 {n} 条（共 {total} 条）', { n: tools.length, total: all.length }),
      )
      if (limit !== null) rows.push(limit)
      const hint = slowHintRow(tools, snapshot, text)
      if (hint !== null) rows.push(hint)
      return detailSection('waitTools', text('section.waitTools', '等待占用'), rows)
    }

    /** 0.6.0 内容层：面板最上面一行「现在在干嘛」——阶段中文名 · 已耗时（有工具再加工具名）。 */
    function nowSection(snapshot, text, now) {
      const phase = typeof snapshot.phase === 'string' ? snapshot.phase : 'idle'
      const tool = typeof snapshot.tool === 'string' && snapshot.tool !== '' ? snapshot.tool : null
      const elapsed =
        typeof snapshot.phaseStartedAt === 'number' && Number.isFinite(snapshot.phaseStartedAt)
          ? fmtElapsed(now - snapshot.phaseStartedAt)
          : null
      // 0.6.1 + 0.6.3：等待态时「现在」也直接说清在等谁（与状态条同一口径）。
      const waitLabel =
        snapshot.waitKind === 'human'
          ? `⏸ ${text('wait.human', '等你回答')}`
          : snapshot.waitKind === 'subagent'
            ? `⏳ ${text('wait.subagent', '等子代理')}`
            : snapshot.waitKind === 'job'
              ? `⏳ ${text('wait.job', '等后台任务')}`
              : null
      const parts = [waitLabel !== null ? waitLabel : pickLabel(phase, text)]
      if (elapsed) parts.push(`已 ${elapsed}`)
      if (tool) parts.push(tool)
      return detailSection('now', text('section.now', '现在'), [
        h(
          'div',
          { key: 'now', style: VALUE_ROW_STYLE },
          h(
            'span',
            { key: 'v', style: { ...VALUE_TEXT_STYLE, color: 'var(--dsw-alias-label-primary)', fontWeight: 500 } },
            parts.join(' · '),
          ),
        ),
      ])
    }

    /** 0.6.0 内容层：一条活动 `HH:MM:SS  {标签}  {内容}`；内容可选中复制，行样式继承 `VALUE_ROW_STYLE`。 */
    function activityRow(entry, index, text) {
      const kind = typeof entry.kind === 'string' ? entry.kind : ''
      const ok = entry.ok !== false
      let label = kind
      let content = ''
      if (kind === 'reason') {
        label = text('label.think', '思考')
        content = safeText(entry.text, '')
      } else if (kind === 'call') {
        label = text('label.call', '调用')
        const args = entry.args
        const argsText = typeof args === 'string' ? args : args === undefined || args === null ? '' : JSON.stringify(args)
        content = `${safeText(entry.name, '')} ${safeText(argsText, '')}`.trim()
      } else if (kind === 'result') {
        label = ok ? text('label.ok', '完成') : text('label.fail', '失败')
        content = safeText(entry.head, text('value.none', '—'))
      } else if (kind === 'turnEnd') {
        label = text('label.turnEnd', '回合结束')
        content = safeText(entry.reason, text('value.none', '—'))
      }
      const style = { ...VALUE_ROW_STYLE, userSelect: 'text' }
      if (kind === 'reason') {
        style.fontStyle = 'italic'
        style.color = 'var(--dsw-alias-label-secondary)'
      }
      if (kind === 'call') style.fontFamily = MONO
      if (kind === 'result' && !ok) style.color = 'var(--dsw-alias-state-error-primary)'
      return h('div', { key: `activity-${index}`, style }, [
        h('span', { key: 't', style: { flex: 'none', color: 'var(--dsw-alias-label-tertiary)' } }, fmtClock(entry.t)),
        h('span', { key: 'l', style: { flex: 'none', color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('span', { key: 'v', style: VALUE_TEXT_STYLE }, content),
      ])
    }

    /**
     * 0.6.0 内容层：活动流分区，最新的一条排最上面（`state.activity` 本身是时间正序）。
     *
     * H4：只渲染最近 `CLIENT_FALLBACK.listLimit` 条 —— 这是界面不是审计日志，全量渲染等于每次投影
     * 都重建几百行。key 用元素在**原数组里的下标**，不是倒序后的渲染下标：原下标只在它前面有元素
     * 被淘汰时才变，倒序不会让所有 key 整体平移（旧写法一倒序就全错位，React 只能整段重建）。
     */
    function activitySection(snapshot, text) {
      const list = Array.isArray(snapshot.activity) ? snapshot.activity : []
      if (list.length === 0) {
        return detailSection('activity', text('section.activity', '活动流'), [
          h('div', { key: 'none', style: VALUE_ROW_STYLE }, text('empty.activity', '还没有活动记录')),
        ])
      }
      const shown = list.slice(-CLIENT_FALLBACK.listLimit)
      const offset = list.length - shown.length
      const rows = []
      for (let index = shown.length - 1; index >= 0; index -= 1) {
        const entry = shown[index]
        rows.push(activityRow(entry && typeof entry === 'object' ? entry : {}, offset + index, text))
      }
      const tail = limitHintRow(
        'tail-hint',
        list.length,
        shown.length,
        text('hint.activityTail', '只显示最近 {n} 条，更早的 {hidden} 条已省略', {
          n: shown.length,
          hidden: offset,
        }),
      )
      if (tail !== null) rows.push(tail)
      return detailSection('activity', text('section.activity', '活动流'), rows)
    }

    /**
     * 面板正文：PLAN.md §3.3 的分区，顺序固定（0.6.0 起「现在」「活动流」在最前）。
     * 只读同一份 `turbo` 投影 —— 不外呼、不直连宿主服务、不读第二个投影键。
     */
    /**
     * 0.6.4：可选增强层状态 —— **一行灰色 info，不是故障**。
     *
     * 机器原因串只在内部映射成文案，绝不原样渲染（那会把 `ctx.toolResultPruner` 这种实现词
     * 泄漏到界面上，SPEC U7 明令禁止；这也正好防住未知原因）。
     * 0.6.5：在位时再按 `mode` 细分「宿主裁剪 / 本地裁剪」——用户有权知道正文是被谁裁的。
     */
    function enhancementReason(reason, text) {
      if (reason === 'no ctx.toolResultPruner loaded') {
        return text('enhancement.reason.pruner', '本机把结果瘦身服务隔离在插件组内（preset 的 isolate 设置），组外读不到属于设计')
      }
      if (reason === 'no ctx.spillStore backend loaded') {
        return text('enhancement.reason.store', '没有落盘后端')
      }
      return text('enhancement.reason.other', '可选增强能力不可用')
    }

    /**
     * L4：`enhancement` **缺席**时不许渲染成"已启用"。
     *
     * 旧写法 `const active = source.active !== false` 把「字段没了」当成「启用」——那是替宿主
     * 断言一件它没说的事（同类问题在 state 层已按三态处理：`active` 只接受显式布尔）。这里改成
     * 三态：`true` → 启用（可按 mode 细分）、`false` → 未启用（带理由）、**其他/缺席 → 未知**。
     */
    function enhancementSection(snapshot, text) {
      const raw = snapshot === null || typeof snapshot !== 'object' ? null : snapshot.enhancement
      const source = raw !== null && typeof raw === 'object' ? raw : null
      const mode = source !== null && typeof source.mode === 'string' ? source.mode : null
      const reason =
        source !== null && typeof source.reason === 'string' && source.reason !== '' ? source.reason : null
      const state =
        source === null
          ? text('enhancement.unknown', '未启用')
          : source.active === true
            ? mode === 'local-trim'
              ? text('enhancement.mode.local', '已启用（本地裁剪）')
              : mode === 'host-pruner'
                ? text('enhancement.mode.host', '已启用（宿主裁剪）')
                : text('enhancement.active', '已启用')
            : text('enhancement.absent', '未启用')
      const detail = source !== null && source.active !== true && reason !== null ? ` · ${enhancementReason(reason, text)}` : ''
      return detailSection('enhancement', text('section.enhancement', '工具增强'), [
        h(
          'div',
          { key: 'enhancement', style: { ...VALUE_ROW_STYLE, color: 'var(--dsw-alias-label-secondary)' } },
          `${state}${detail}`,
        ),
      ])
    }

    /**
     * 0.9.0：到量轮换那一行 —— 与 `handoffSection` 同款灰色 info；`armed` 且非 `auto` 时**整行可点**。
     *
     * 0.9.0 起建会话已归宿主（方案 B：宿主建空白会话 + 把旧会话 id 写进它的第一条消息），
     * 客户端**只剩 `open(childId)` 一个动作**：Fork 会把整份旧历史复制成种子，恰恰不解决上下文积压。
     * 拿不到 `sessions` 服务时**一次都不调用**，只在面板上说明 —— 缺席不是故障。
     */
    function rotationSection(snapshot, text) {
      const raw = snapshot === null || typeof snapshot !== 'object' ? null : snapshot.rotation
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const status = typeof source.status === 'string' ? source.status : 'idle'
      const mode = typeof source.mode === 'string' ? source.mode : 'manual'
      const sessionId = typeof source.sessionId === 'string' && source.sessionId !== '' ? source.sessionId : null
      const childId = typeof source.childId === 'string' && source.childId !== '' ? source.childId : null
      const message = typeof source.message === 'string' && source.message !== '' ? source.message : null
      const at = typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : null
      /** 0.9.2：会话是否空闲（wire 的 `phase`）。auto 只在这个阶段动手。 */
      const idle = snapshot !== null && typeof snapshot === 'object' && snapshot.phase === 'idle'

      // 0.9.3：auto 的触发点**不在这里**。这一段挂在详情面板里，而面板收起时组件直接 return null
      // ⇒ 0.9.0~0.9.2 的自动轮换在默认 UI 下一句都没执行过。触发点已搬到常驻的 `TurboStatusBar`
      // （它的 effect 依赖 wire 的 status / mode / phase / childId / at）。这里只负责渲染。
      // 手动那一路（`armed` 且非 auto）仍留在本行：用户点了才轮换，与面板是否展开无关。

      const outcome = rotationOutcomeOf(sessionId)
      const shown = outcome === null ? status : outcome.status
      const stamp = at === null ? '' : ` · ${fmtClock(at)}`
      const label =
        shown === 'off'
          ? text('rotation.off', '未开启（config.rotation = off）')
          : shown === 'remind'
            ? `${text('rotation.remind', '已到轮换阈值 · 建议开新会话（开场话术在设置页可复制）')}${stamp}`
            : shown === 'armed'
            ? `${mode === 'auto'
                ? (idle
                    ? text('rotation.armed.auto', '新会话已就绪 · 正在自动切换…')
                    : `${text('rotation.armed.waiting', '新会话已就绪 · 等当前回合结束再切')} · ${text('rotation.armed.wait-now', '点这里立刻切过去（不用等这一轮跑完）')}`)
                : text('rotation.armed.manual', '新会话已就绪 · 点这里切过去')}${stamp}`
            : shown === 'running'
              ? text('rotation.running', '正在轮换…')
              : shown === 'done'
                ? `${text('rotation.done', '已轮换')}${outcome !== null && outcome.childId !== null ? ` → ${outcome.childId}` : ''}`
                : shown === 'ready'
                  ? `${text('rotation.ready', '新会话已就绪 · 点这里重试')}${stamp}`
                  : shown === 'failed'
                    ? `${text('rotation.failed', '轮换失败')}${outcome !== null && outcome.reason !== null ? ` · ${rotationReasonText(outcome.reason, text)}` : ''} · ${text('rotation.retry', '点这里重试')}`
                    : shown === 'unavailable'
                      ? `${text('rotation.unavailable', '宿主没能建出新会话')}${message === null ? '' : ` · ${rotationReasonText(message, text)}`}`
                      : text('rotation.idle', '等待达到阈值')
      // 0.9.3：`ready` / `failed` 也可点 = 「重试」——`sessions.open` 是同步的，重试成本极低。
      // 0.9.2 里这两行点不动，加上结果落地不重渲染，等于把该会话永久锁死。
      // 0.20.0（Q2）：`armed` 一律可点 —— `auto` 正在「等当前回合结束」时也一样。
      // 一个永不到 idle 的会话会让「等」变成死结（用户现场），等待态必须留一个「立刻切」的出口。
      const clickable = shown === 'ready' || shown === 'failed' || shown === 'armed'
      const rows = [
        h(
          'div',
          {
            key: 'rotation',
            onClick: clickable ? () => { performRotation(snapshot, { force: true }) } : undefined,
            style: {
              ...VALUE_ROW_STYLE,
              color: 'var(--dsw-alias-label-secondary)',
              cursor: clickable ? 'pointer' : 'default',
            },
          },
          label,
        ),
      ]
      // 0.20.0（Q2）：等待态再给一行「切过去并归档当前会话」—— 不想再等这一轮的人可以直接走，
      // 顺手把旧会话归档掉。归档在界面里不可逆，所以只在真的建出了子会话（childId 非空）时才出现。
      if (shown === 'armed' && childId !== null) {
        rows.push(
          h(
            'div',
            {
              key: 'rotation-archive',
              onClick: () => { performRotation(snapshot, { force: true, archiveOld: true }) },
              style: {
                ...VALUE_ROW_STYLE,
                color: 'var(--dsw-alias-label-secondary)',
                cursor: 'pointer',
              },
            },
            text('rotation.armed.archive', '切过去并归档当前会话'),
          ),
        )
      }
      return detailSection('rotation', text('section.rotation', '会话轮换'), rows)
    }

    /**
     * 轮换的**稳定 code** → 文案（同 `handoffSection · reasonText`，未知 code 原样显示）。
     *
     * 这些 code 全部来自宿主侧（`lib/rotation.js · ROTATION_MESSAGE`）；客户端只负责翻译。
     */
    function rotationReasonText(code, text) {
      if (typeof code !== 'string' || code === '') return ''
      if (code === 'disabled') return text('rotation.reason.disabled', '轮换已关闭（config.rotation = off）')
      if (code === 'no-cwd') return text('rotation.reason.no-cwd', '这个会话在投影里没有绝对路径工作目录')
      if (code === 'no-service') return text('rotation.reason.no-service', '客户端没有可用的切会话接口（uiWorkspace.openSession / sessions.open）')
      if (code === 'create-failed') return text('rotation.reason.create-failed', '建会话被拒（id 撞车或工作目录不合格）')
      return code === 'other' ? text('rotation.reason.other', '未预期的错误') : code
    }

    /** 切换失败时的重试节奏：10 次 × 300ms（`showToast` 不在这套客户端 API 里，提示只能落在面板上）。 */
    // 0.19.3：子会话要过「代理生命周期建会话 → 挂进工作区 → 客户端列表收到」两跳才切得动，
    // 0.19.2 的 300ms × 10（约 3 秒）常常不够 —— 用户看到的就成了「新会话要自己点一下」。
    const ROTATION_OPEN_RETRY_MS = 500
    const ROTATION_OPEN_RETRY_LIMIT = 40

    /**
     * 把 `sessions.open` 重试到有界次数：宿主建完会话会推 `host/session-added` 让客户端入列，
     * 但**帧到达与投影更新之间有竞态**，第一次 `open` 可能撞上 `sessions.select: unknown session <id>`。
     *
     * 0.9.3：节奏与调度器都可注入（`options.retryMs` / `options.limit` / `options.schedule`），
     * 好让这条执行体在测试里用假调度器驱动 —— 0.9.2 的这段代码在测试里是 0 次执行。
     *
     * L2：**可取消**。`options.isCancelled`（或 `options.signal`）为真时，退避链**立刻停止**，
     * 不会再调 `sessions.open`。没有这条，一次 10 次 ×300ms 的重试会在用户已经切走之后继续
     * 把 `sessions.open(childId)` 打出去 —— 等于隔几秒把用户从他正在看的会话里再拽走一次。
     * 取消时与「重试用尽」同样 resolve `false`（调用方据此落 `ready`：新会话确实在，只是没切）。
     *
     * @param {object|Function} sessions 切会话的口子：一个带 `open` 的客户端服务，或直接收 id 的函数。
     * @param {string} childId 新会话 id。
     * @param {{retryMs?: number, limit?: number, schedule?: Function, isCancelled?: Function, signal?: object}} [options] 节奏、调度器与取消标志。
     * @returns {Promise<boolean>} 是否切成功。
     */
    function openWithRetry(sessions, childId, options) {
      const opts = options !== null && typeof options === 'object' ? options : {}
      // 0.19.4：切会话的正门是 `uiWorkspace.openSession`（0.2.0 起客户端 `sessions` 服务的面里没有 `open`），
      // 所以这里两种口子都收：直接一个函数，或一个带 `open` 的服务对象（旧版回落）。
      const open =
        typeof sessions === 'function'
          ? sessions
          : sessions !== null && typeof sessions === 'object' && typeof sessions.open === 'function'
            ? (id) => { sessions.open(id) }
            : null
      if (open === null) return Promise.resolve(false)
      const retryMs = typeof opts.retryMs === 'number' && Number.isFinite(opts.retryMs) && opts.retryMs >= 0 ? opts.retryMs : ROTATION_OPEN_RETRY_MS
      const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 1 ? Math.floor(opts.limit) : ROTATION_OPEN_RETRY_LIMIT
      // 默认用真定时器；测试注入 schedule 后同步驱动，不需要等真实时间。
      const schedule = typeof opts.schedule === 'function' ? opts.schedule : (fn, ms) => { setTimeout(fn, ms) }
      const signal = opts.signal !== null && typeof opts.signal === 'object' ? opts.signal : null
      const isCancelledFn = typeof opts.isCancelled === 'function' ? opts.isCancelled : null
      const cancelled = () =>
        (signal !== null && signal.aborted === true) || (isCancelledFn !== null && isCancelledFn() === true)
      return new Promise((resolve) => {
        let attempt = 0
        let settled = false
        const finish = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        const tryOpen = () => {
          // 每次真正落地前都问一遍：退避等待期间用户可能已经切走了。
          if (cancelled()) {
            finish(false)
            return
          }
          try {
            open(childId)
            finish(true)
            return
          } catch {
            attempt += 1
            if (attempt >= limit) {
              finish(false)
              return
            }
            if (cancelled()) {
              finish(false)
              return
            }
            schedule(tryOpen, retryMs)
          }
        }
        tryOpen()
      })
    }

    /**
     * 轮换的执行体：先切过去、再按需归档旧的。依赖全部从入参来，**不碰组件也不碰模块状态**，可直接测。
     *
     * @param {{sessions: object, workspaces: object|undefined, sessionId: string, childId: string, openChild: boolean, archiveOld: boolean, open: Function}} deps 依赖。
     * @returns {Promise<{status: string}>} `ready`（新会话在客户端列表里还找不到）或 `done`。
     */
    async function executeRotation(deps) {
      if (deps.openChild) {
        const opened = await deps.open(deps.sessions, deps.childId)
        if (!opened) return { status: 'ready' }
      }
      // 顺序契约：**先切过去，再归档旧的**（`workspaces` 缺席不算故障，只是不归档）。
      const workspaces = deps.workspaces
      if (deps.archiveOld && workspaces !== undefined && workspaces !== null && typeof workspaces.archiveSession === 'function') {
        await workspaces.archiveSession(deps.sessionId)
      }
      return { status: 'done' }
    }

    /**
     * 切到宿主已经建好的新会话（客户端唯一的写动作）。**任何失败都只落进本地记录，绝不抛**。
     *
     * 0.9.0 的顺序变成：`open(childId)` →（`rotationArchiveOld`）archive 旧会话。
     * 新会话是空白会话，`childId` 由宿主写进旧会话的轮换记录，随 wire 下发。
     *
     * 0.9.3：`options.force` 让「重试」绕过「该会话已有结果」的早退（`ready` / `failed` 行可点）。
     *
     * @param {object} snapshot 当前投影快照。
     * @param {{force?: boolean, archiveOld?: boolean}} [options] 执行选项（0.20.0：`archiveOld: true` 表示用户明确要「切过去并归档当前会话」）。
     */
    function performRotation(snapshot, options) {
      const opts = options !== null && typeof options === 'object' ? options : {}
      const force = opts.force === true
      // 0.20.0（Q2）：面板上「切过去并归档当前会话」那一行用它显式覆盖 wire 上的 archiveOld。
      const archiveOverride = opts.archiveOld === true
      const raw = snapshot === null || typeof snapshot !== 'object' ? null : snapshot.rotation
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const sessionId = typeof source.sessionId === 'string' && source.sessionId !== '' ? source.sessionId : null
      const childId = typeof source.childId === 'string' && source.childId !== '' ? source.childId : null
      if (sessionId === null || rotationInFlight) return
      // 每个 childId 只做一次（`auto` 模式每帧都会走到这里）；`force` 是用户点「重试」。
      if (!force && rotationOutcomeOf(sessionId) !== null) return
      // 宿主没建出会话（没有 cwd / 没有 sessions 服务 / id 撞车）：没有可切的目标。
      if (childId === null) return

      const openChild = source.openChild !== false
      const archiveOld = archiveOverride || source.archiveOld === true
      // 这条 wire 的指纹：换新目标（或状态回到 armed）时由 `syncRotationOutcome` 作废本地结果。
      const wire = {
        wireStatus: typeof source.status === 'string' ? source.status : 'idle',
        wireChildId: childId,
        wireAt: typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : null,
      }

      // 0.19.4：切会话只能走 `uiWorkspace.openSession`（0.2.0 起客户端 `sessions` 服务的面里没有 `open`）；
      // 旧版保留 `sessions.open` 回落。两个都没有就记 `no-service`（缺席，不是故障），一次也不调用。
      const uiWorkspace = clientCtx !== null && typeof clientCtx.get === 'function' ? clientCtx.get('uiWorkspace') : undefined
      const sessions = clientCtx !== null && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : undefined
      const opener =
        uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.openSession === 'function'
          ? (id) => { uiWorkspace.openSession(id) }
          : sessions !== undefined && sessions !== null && typeof sessions.open === 'function'
            ? sessions
            : null
      if (openChild && opener === null) {
        setRotationOutcome(sessionId, { status: 'failed', reason: 'no-service', childId, ...wire })
        console.error(`[${NS}] 到量轮换：客户端没有可用的切会话接口（uiWorkspace.openSession / sessions.open）`)
        return
      }

      rotationInFlight = true
      setRotationOutcome(sessionId, { status: 'running', reason: null, childId, ...wire })
      const workspaces = clientCtx !== null && typeof clientCtx.get === 'function' ? clientCtx.get('workspaces') : undefined
      const timer = clientCtx !== null && typeof clientCtx.get === 'function' ? clientCtx.get('timer') : undefined
      // 宿主提供的 `timer.timeout` 一并注入 `openWithRetry`，好让整套重试在测试里同步跑完。
      const schedule =
        timer !== undefined && timer !== null && typeof timer.timeout === 'function'
          ? (fn, ms) => { timer.timeout(fn, ms) }
          : undefined
      // L2：链跑到一半用户切走（`activeSessionId` 不再等于本轮 `sessionId`）就停手。
      const rotationCancelled = () => activeSessionId !== null && activeSessionId !== sessionId
      Promise.resolve()
        .then(async () => {
          const result = await executeRotation({
            sessions: opener,
            workspaces,
            sessionId,
            childId,
            openChild,
            archiveOld,
            open: (target, id) => openWithRetry(target, id, { schedule, isCancelled: rotationCancelled }),
          })
          if (result.status === 'ready') {
            // 新会话已就绪，只是客户端列表还没收到它 —— 那一行点一下就重试。
            setRotationOutcome(sessionId, { status: 'ready', reason: null, childId, ...wire })
            console.error(`[${NS}] 到量轮换：新会话 ${childId} 已就绪，但客户端列表里还没有它 —— 请点该行重试`)
            return
          }
          setRotationOutcome(sessionId, { status: 'done', reason: null, childId, ...wire })
        })
        .catch((error) => {
          const detail = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : ''
          setRotationOutcome(sessionId, { status: 'failed', reason: detail === '' ? 'other' : detail, childId, ...wire })
          console.error(`[${NS}] 到量轮换失败：${detail}`)
        })
        .then(() => { rotationInFlight = false })
    }

    /**
     * 0.7.0：交接文档自动导出状态 —— 与 `enhancementSection` 同款**一行灰色 info，不是故障**。
     *
     * 四种非成功态都不是错误：`disabled` 是默认关，`idle` 是还没到阈值，`unavailable` 是
     * 探测不到 bili（缺席），`running` 是正在导。只有 `failed` 才是真失败，且只显示规范化后的
     * 短消息，绝不把实现串原样渲染（SPEC U7）。
     * `done` 那一行的路径必须能被选中复制 ⇒ 同 `lastSpill`，**不设** `userSelect:'none'`。
     */
    function handoffSection(snapshot, text) {
      /**
       * 把宿主给的**稳定 code** 翻成当前语言（0.7.6）。
       *
       * 为什么宿主不能直接给句子：`'mkdir failed'` / `'per-process limit reached'` 这类英文
       * 会原样漏进中文面板。`exit:<n>` 带参数 ⇒ 只做一次 `{code}` 替换。
       * **未知 code 原样返回** —— 宿主将来加新 code、或客户端比宿主旧，都不该把失败原因吞掉。
       */
      const reasonText = (code) => {
        if (typeof code !== 'string' || code === '') return ''
        const exit = /^exit:(.+)$/.exec(code)
        if (exit !== null) return text('handoff.msg.exit', '进程退出码 {code}').replace('{code}', exit[1])
        if (code === 'limit-reached') return text('handoff.msg.limit-reached', '本进程导出次数已达上限')
        if (code === 'no-cwd') return text('handoff.msg.no-cwd', '拿不到会话工作目录')
        if (code === 'mkdir-failed') return text('handoff.msg.mkdir-failed', '建导出目录失败')
        if (code === 'timeout') return text('handoff.msg.timeout', '超时')
        return code
      }
      const raw = snapshot === null || typeof snapshot !== 'object' ? null : snapshot.handoff
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const status = typeof source.status === 'string' ? source.status : 'idle'
      const path = typeof source.path === 'string' && source.path !== '' ? source.path : null
      const at = typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : null
      const reason = reasonText(source.message) || null
      const stamp = at === null ? '' : ` · ${fmtClock(at)}`
      const label =
        status === 'unavailable'
          ? text('handoff.unavailable', '未找到 bili（缺席，不是故障）')
          : status === 'running'
            ? text('handoff.running', '正在导出…')
            : status === 'failed'
              ? `${text('handoff.failed', '导出失败')}${reason === null ? '' : ` · ${reason}`}`
              : status === 'disabled'
                ? text('handoff.disabled', '未开启（config.handoffExport = false）')
                : status === 'done'
                  ? `${text('handoff.done', '已导出')}${stamp}`
                  : text('handoff.idle', '等待达到阈值')
      const showPath = status === 'done' && path !== null
      return detailSection('handoff', text('section.handoff', '交接文档'), [
        h(
          'div',
          {
            key: showPath ? 'handoff-path' : 'handoff',
            style: showPath
              ? { ...VALUE_ROW_STYLE, fontFamily: MONO, color: 'var(--dsw-alias-label-secondary)' }
              : { ...VALUE_ROW_STYLE, color: 'var(--dsw-alias-label-secondary)' },
          },
          showPath ? `${label} → ${path}` : label,
        ),
      ])
    }

    /**
     * M4：分区级缓存 —— 模块级实现，不用 `React.useMemo`。
     *
     * 两个入口组件必须能被最小 React 替身直接当函数调用（只实现 createElement/useState/useRef/
     * useEffect 的那种）：调用 `React.useMemo` 会直接抛错，把子树换成子组件又会让「拿 `children`
     * 逐行断言」的用例失效。所以缓存放模块级 —— 按固定分区名 + 依赖数组逐项 `===` 比较，
     * 命中就复用上一次造出来的那棵元素树。
     *
     * 依赖给多只是多几次未命中（重新构造，与旧版一致），给少才会把旧文案留在屏幕上。只缓存不读
     * 渲染时刻、不读模块级可变状态的分区 —— `now` / `turn`（秒数在走）与 `rotation`（模块级轮换
     * 结果加点击闭包）一律现算。分区名是固定的一小撮，缓存不会再涨。
     */
    const sectionCache = new Map()
    function memoSection(name, deps, build) {
      const cached = sectionCache.get(name)
      if (
        cached !== undefined &&
        cached.deps.length === deps.length &&
        deps.every((dep, index) => dep === cached.deps[index])
      ) {
        return cached.element
      }
      const element = build()
      sectionCache.set(name, { deps: deps.slice(), element })
      return element
    }

    /**
     * M10：列表行的 key 必须由内容决定。用渲染下标当 key，列表一变 React 就把整行重建（丢选中、
     * 闪一下）。宿主的聚合项自带 `key`（按名字聚出来的稳定 id），再退到 `name`，都没有才用下标。
     */
    function toolRowKey(prefix, tool, index) {
      const id =
        tool && typeof tool.key === 'string' && tool.key !== ''
          ? tool.key
          : tool && typeof tool.name === 'string' && tool.name !== ''
            ? tool.name
            : null
      return id === null ? `${prefix}-slot-${index}` : `${prefix}-${id}-${safeText(tool && tool.count, '0')}`
    }

    /**
     * L6：切片必须留话 —— 被截掉的部分没有这一行，面板看上去就像"一共只有 5 条"。
     * 没有截断（`total <= shown`）时返回 `null`，不占版面。
     */
    function limitHintRow(key, total, shown, message) {
      if (!(total > shown)) return null
      return h(
        'div',
        { key, style: { ...VALUE_ROW_STYLE, color: 'var(--dsw-alias-label-tertiary)' } },
        message,
      )
    }

    /** 页面里的一行提示（不是分区，统一用次要色）。 */
    function panelHint(key, message) {
      return h('div', { key, style: { ...VALUE_ROW_STYLE, color: 'var(--dsw-alias-label-tertiary)' } }, message)
    }

    const PANEL_PAGE_STYLE = Object.freeze({
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      height: '100%',
      overflowY: 'auto',
      padding: '14px 16px',
      fontSize: '12px',
      color: 'var(--dsw-alias-label-primary)',
    })
    const PANEL_HEADING_STYLE = Object.freeze({
      margin: '0 0 8px',
      fontSize: '14px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
    })
    /** 开场话术：等宽、可选中、整段换行 —— 复制失败时用户还能手动框选。 */
    const PANEL_SCRIPT_STYLE = Object.freeze({
      margin: '0',
      padding: '8px 10px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      userSelect: 'text',
      background: 'var(--dsw-alias-fill-tertiary, rgba(127,127,127,0.12))',
      borderRadius: '6px',
      fontFamily: 'var(--dsw-font-mono, monospace)',
      fontSize: '12px',
      lineHeight: '1.5',
    })
    const PANEL_COPY_STYLE = Object.freeze({ display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0 0' })
    const PANEL_BUTTON_STYLE = Object.freeze({
      padding: '2px 10px',
      fontSize: '12px',
      borderRadius: '4px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.4))',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    })

    /** 标准工具包缺席（老宿主 / 测试桩）时的占位：任何选择器都拿到一个空列表状态。 */
    const EMPTY_SESSION_STATE = Object.freeze({ ids: [], byId: {}, current: undefined, phase: 'pending' })
    /**
     * `useSessions` 缺席时的替代品。它是一个**普通函数**而不是 hook（这里没有订阅），
     * 与真 hook 的选择器协议一致；两支的引用都稳定，跨渲染不会改变调用顺序。
     */
    function noSessions(selector) {
      return typeof selector === 'function' ? selector(EMPTY_SESSION_STATE) : EMPTY_SESSION_STATE
    }

    /** `SessionListState` → 当前会话 id。 */
    function selectCurrentSession(state) {
      return state !== null && state !== undefined && typeof state.current === 'string' ? state.current : undefined
    }

    /**
     * 当前会话 id → 该行的 `turbo` 投影值。
     *
     * `SessionListState.byId[id].projectionValues` 是客户端运行时发布的**整份投影值映射**（引用稳定），
     * 目的正是让 root 作用域的列表消费者复用会话投影而不必自建 per-session 订阅。
     * 行还没到 / 投影还没加载 ⇒ `undefined`（页面据此显示"等待投影"而不是"没有家族"）。
     */
    function makeProjectionSelector(current) {
      return (state) => {
        if (state === null || state === undefined || typeof state !== 'object') return undefined
        if (typeof current !== 'string' || current === '') return undefined
        const byId = state.byId
        if (byId === null || typeof byId !== 'object') return undefined
        const summary = byId[current]
        if (summary === null || typeof summary !== 'object') return undefined
        const values = summary.projectionValues
        if (values === null || typeof values !== 'object') return undefined
        return values[PROJECTION_KEY]
      }
    }

    /** 会话 id 的短展示：只留前 12 位。 */
    function labelOfSessionId(sessionId) {
      return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId
    }

    /**
     * 「新会话」主面板页（0.18.0）：这条会话的轮换状态 + 可直接复制粘贴的开场话术。
     *
     * 只读 + 一个剪贴板按钮。数据全在客户端取：`main` 的标准工具包给了 `useSessions`，它读的
     * `SessionListState` 每行都带 `projectionValues` ⇒ 直接读当前会话的 `turbo` 视图，不需要自建
     * 订阅、不发 HTTP、不新增配置键。`main` 上的非 `conversation` 键**没有会话绑定**，所以拿不到
     * `useProjection`（那是会话作用域的标准工具）—— 这是槽位契约，不是疏漏。
     */
    function TurboNewSessionPage(props) {
      const text = makeText(props && props.t)
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : noSessions
      const current = useSessions(selectCurrentSession)
      const projected = useSessions(makeProjectionSelector(current))
      const [copyState, setCopyState] = React.useState('')
      const rows = []
      const currentId = typeof current === 'string' && current !== '' ? current : null
      if (currentId === null) {
        rows.push(panelHint('panel.none', text('panel.none', '当前没有会话 —— 先在左侧选一个会话。')))
      } else {
        rows.push(detailRow('panel.session', text('panel.session', '当前会话'), labelOfSessionId(currentId), true))
        const view = projected !== null && projected !== undefined && typeof projected === 'object' ? projected : null
        if (view === null) {
          rows.push(panelHint('panel.loading', text('panel.loading', '等待该会话的投影…')))
        } else {
          rows.push(rotationSection(view, text))
          const card = newSessionCardOf(view)
          if (card.text === '') {
            rows.push(panelHint('panel.noScript', text('panel.noScript', '拿不到开场话术：宿主没有报出这段文本。')))
          } else {
            rows.push(
              detailSection('script', text('panel.script', '开场话术'), [
                h('pre', { key: 'text', style: PANEL_SCRIPT_STYLE }, card.text),
                h('div', { key: 'copy', style: PANEL_COPY_STYLE }, [
                  h(
                    'button',
                    {
                      key: 'copy-button',
                      type: 'button',
                      onClick: () => {
                        void copyText(card.text).then((ok) => setCopyState(ok ? 'ok' : 'failed'))
                      },
                      style: PANEL_BUTTON_STYLE,
                    },
                    text('panel.copy', '复制'),
                  ),
                  copyState === ''
                    ? null
                    : h(
                        'span',
                        {
                          key: 'copy-note',
                          style: { color: copyState === 'ok' ? '#3fb950' : '#e5534b', fontSize: '0.9em' },
                        },
                        copyState === 'ok' ? text('panel.copied', '已复制') : text('panel.copyFailed', '复制失败，请手动选中'),
                      ),
                ]),
              ]),
            )
            if (card.cwd !== '') {
              rows.push(detailRow('panel.cwd', text('panel.cwd', '工作目录'), card.cwd, true))
            }
            rows.push(panelHint('panel.usage', text('panel.usage', '在新会话里粘贴这段文本：新会话会知道该去查哪条旧会话。')))
          }
        }
      }
      return h(
        'div',
        { key: 'panel', style: PANEL_PAGE_STYLE, role: 'region', 'aria-label': text('panel.heading', '新会话') },
        [h('div', { key: 'panel.heading', style: PANEL_HEADING_STYLE }, text('panel.heading', '新会话')), ...rows],
      )
    }

    /** wire 的 `newSession` → `{text, oldId, cwd}`；缺失/非法一律空串（页面据此显示提示行）。 */
    function newSessionCardOf(view) {
      const raw = view === null || view === undefined || typeof view !== 'object' ? null : view.newSession
      if (raw === null || raw === undefined || typeof raw !== 'object') return { text: '', oldId: '', cwd: '' }
      return {
        text: typeof raw.text === 'string' ? raw.text : '',
        oldId: typeof raw.oldId === 'string' ? raw.oldId : '',
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      }
    }

    /**
     * 把文本放进剪贴板：优先 `navigator.clipboard.writeText`，再退回临时 textarea + `document.execCommand`。
     *
     * 两条路都不许抛（宿主 WebView 可能既没有 clipboard 也拒绝 execCommand）：失败一律返回 false，
     * 由页面显示"请手动选中"，用户至少还能用鼠标复制。
     *
     * @param {string} value 要复制的文本。
     * @returns {Promise<boolean>} 是否成功。
     */
    function copyText(value) {
      try {
        const nav = typeof navigator === 'object' && navigator !== null ? navigator : null
        const clipboard = nav === null ? null : nav.clipboard
        if (clipboard !== null && clipboard !== undefined && typeof clipboard.writeText === 'function') {
          return clipboard.writeText(value).then(
            () => true,
            () => fallbackCopy(value),
          )
        }
      } catch (error) {
        // 取 `navigator.clipboard` 本身就抛（某些沙箱形态）：继续走兜底，不把异常抛给渲染。
      }
      return Promise.resolve(fallbackCopy(value))
    }

    /**
     * 兜底复制：临时 textarea + `document.execCommand('copy')`。
     *
     * @param {string} value 要复制的文本。
     * @returns {boolean} 是否成功。
     */
    function fallbackCopy(value) {
      try {
        const doc = typeof document === 'object' && document !== null ? document : null
        if (doc === null || doc.body === null || typeof doc.createElement !== 'function') return false
        const area = doc.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        doc.body.appendChild(area)
        area.select()
        const ok = typeof doc.execCommand === 'function' && doc.execCommand('copy') === true
        doc.body.removeChild(area)
        return ok
      } catch (error) {
        // DOM 不可用（非浏览器宿主）或 execCommand 被拒：只能让用户手动复制。
        return false
      }
    }

    /**
     * 左侧栏入口的图标：一张纸 + 一个加号（"开新会话"）。
     *
     * `size` 由 owner 给（正方形边长），`active` 由 CSS 承担（`currentColor`），所以这里不判断它。
     */
    function NewSessionPanelIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        [
          h('path', { key: 'sheet', d: 'M3.2 1.8h6.2l3.4 3.4v9H3.2z' }),
          h('path', { key: 'fold', d: 'M9.4 1.8v3.4h3.4' }),
          h('path', { key: 'plus-h', d: 'M6.4 9.4h3.2' }),
          h('path', { key: 'plus-v', d: 'M8 7.8v3.2' }),
        ],
      )
    }

    function detailBody(props, snapshot, collapsed, heartbeatNow) {
      const text = makeText(props && props.t)
      // M1：`now` 由展开态的心跳每秒推进（见 TurboDetailPanel）；直接调用的调用方拿不到心跳参数时
      // 退回渲染时刻，行为与旧版一致。
      const now =
        typeof heartbeatNow === 'number' && Number.isFinite(heartbeatNow) ? heartbeatNow : Date.now()
      // M4：分区缓存按「快照引用 + 文案函数」比较 —— 这两个是所有分区读到的全部外部输入。
      const sectionDeps = [snapshot, props && props.t]
      const none = text('value.none', '—')
      const phase = typeof snapshot.phase === 'string' ? snapshot.phase : 'idle'
      const effort = typeof snapshot.effort === 'string' && snapshot.effort !== '' ? snapshot.effort : null
      const stepElapsed = typeof snapshot.phaseStartedAt === 'number' ? fmtElapsed(now - snapshot.phaseStartedAt) : null
      const hitRate =
        typeof snapshot.hitRate === 'number' && Number.isFinite(snapshot.hitRate)
          ? `${Math.round(snapshot.hitRate * 100)}%`
          : none

      const sections = [
        nowSection(snapshot, text, now),
        memoSection('activity', sectionDeps, () => activitySection(snapshot, text)),
        detailSection('turn', text('section.turn', '本回合'), [
          detailRow('phase', text('label.phase', '阶段'), pickLabel(phase, text)),
          detailRow('elapsed', text('label.stepElapsed', '本步耗时'), stepElapsed || none, true),
          detailRow('gear', text('label.gear', '档位'), effort || text('gear.default', '默认')),
          detailRow('step', text('label.step', '步数'), safeText(snapshot.step, none), true),
        ]),
        memoSection('lastTurn', sectionDeps, () =>
          detailSection('lastTurn', text('section.lastTurn', '上回合'), [
            detailRow(
              'elapsed',
              text('label.lastTurnMs', '上回合耗时'),
              typeof snapshot.lastTurnMs === 'number' && Number.isFinite(snapshot.lastTurnMs)
                ? fmtElapsed(snapshot.lastTurnMs) || `${Math.round(snapshot.lastTurnMs)}毫秒`
                : text('empty.noTurn', '没有已结束的上回合'),
              true,
            ),
          ]),
        ),
        // D6(b)：本步缓存命中率**只在这里**，底栏不放（S6 明确禁止加回状态条）。
        memoSection('usage', sectionDeps, () =>
          detailSection('usage', text('section.usage', '缓存与用量'), [
            detailRow('hitRate', text('label.hitRate', '本步缓存命中率'), hitRate, true),
            detailRow('stepTokens', text('label.stepTokens', '本步 token'), fmtTokens(snapshot.stepTokens) || none, true),
            detailRow('turnTokens', text('label.turnTokens', '本回合 token'), fmtTokens(snapshot.turnTokens) || none, true),
          ]),
        ),
        memoSection('prefix', sectionDeps, () =>
          detailSection('prefix', text('section.prefix', '前缀'), prefixRows(snapshot, text)),
        ),
        memoSection('topTools', sectionDeps, () => topToolsSection(snapshot, text)),
        memoSection('waitTools', sectionDeps, () => waitToolsSection(snapshot, text)),
      ]

      // 0.8.0：到量轮换那一行（恒在，与「交接文档」同款 info 行）。
      sections.push(rotationSection(snapshot, text))

      if (snapshot.lastSpill !== undefined && snapshot.lastSpill !== null) {
        const spill = snapshot.lastSpill
        sections.push(
          memoSection('spill', sectionDeps, () =>
            detailSection('spill', text('section.spill', '最近瘦身'), [
              // locator 是落盘路径，必须能被选中复制 ⇒ 这一行**不设** `userSelect:'none'`。
              h(
                'div',
                { key: 'spill', style: { ...VALUE_ROW_STYLE, fontFamily: MONO, color: 'var(--dsw-alias-label-secondary)' } },
                `${safeText(spill.bytes, none)} ${text('unit.bytes', 'bytes')} → ${safeText(spill.locator, none)}`,
              ),
            ]),
          ),
        )
      }

      // 0.6.4：增强层状态恒在，且必须排在「最近的故障」**上方** —— 缺席是设计，不是故障，
      // 所以它不能混进 hookFaults 的红字里，用户得先看到"这层本来就没开"。
      sections.push(memoSection('enhancement', sectionDeps, () => enhancementSection(snapshot, text)))
      // 0.7.0：交接文档导出状态。同样恒在、同样必须排在「最近的故障」上方 —— 「未开启」与
      // 「探测不到 bili」都不是故障，不能混进下面的红字里。
      sections.push(memoSection('handoff', sectionDeps, () => handoffSection(snapshot, text)))

      // §4.2：钩子故障逐条列出（最近的在前）；发生过的故障是错误级，用错误色。
      if (Array.isArray(snapshot.hookFaults) && snapshot.hookFaults.length > 0) {
        sections.push(
          memoSection('hookFaults', sectionDeps, () =>
            detailSection(
              'hookFaults',
              text('section.hookFaults', '最近的故障'),
              snapshot.hookFaults.map((fault, index) =>
                h(
                  'div',
                  {
                    key: `fault-${safeText(fault && fault.at, '-')}-${index}`,
                    style: { ...VALUE_ROW_STYLE, color: 'var(--dsw-alias-state-error-primary)' },
                  },
                  // M7：分隔符跟着 locale 走，英文界面里不能出现全角冒号。
                  `${fmtClock(fault && fault.at)} ${safeText(fault && fault.hook, none)}${labelSeparator(text)}${safeText(fault && fault.message, none)}`,
                ),
              ),
            ),
          ),
        )
      }

      const header = h(
        'button',
        {
          key: 'header',
          type: 'button',
          onClick: () => toggleDetail(props && props.sessionId),
          style: PANEL_HEADER_STYLE,
        },
        [
          h('span', { key: 't', style: { fontWeight: 500 } }, text('detail.title', '详情')),
          h('span', { key: 'c' }, collapsed ? text('detail.toggle.closed', '▸ 详情') : text('detail.toggle.open', '▾ 收起')),
        ],
      )

      return h(
        'div',
        {
          // L7：面板本身也是一个具名区域 —— 读屏用户 Tab 进来时能一步跳到「会话状态详情」，
          // 而不是在一堆无名 div 里摸。
          role: 'region',
          'aria-label': text('aria.panel', '会话状态详情'),
          style: PANEL_STYLE,
          'data-dsh-status-turbo-detail': true,
        },
        [header, ...sections],
      )
    }

    /**
     * 详情面板组件（注册进 `conversation.input.dock`）。
     *
     * 收起 / 快照缺席 / 宿主关掉状态条 → 一律 `return null`：只要渲染出一个空容器，
     * composer 上方就会多一条空的 `:empty` 带（PLAN §3.3.4）。
     *
     * 展开状态是**本组件自己的 `useState`**（默认收起 ⇒ 首帧什么都不画），初值按会话从表里恢复；
     * 点击只发生在摘要行那一格上 —— 两个槽位条目不在同一棵 React 树上，没有共同父级可以提升 state，
     * 所以走 `subscribeDetail` 广播过来。也不用 `useRef`：组件实例切换会话时会被复用，会把上一个
     * 会话的开合状态带过来（与上面 `sessionSeenAt` 同一条理由）。
     */
    function TurboDetailPanel(props) {
      const useProjection = props && props.useProjection
      const sessionId = props && props.sessionId
      const snapshot = typeof useProjection === 'function' ? useProjection(PROJECTION_KEY) : undefined
      const [collapsed, setCollapsed] = React.useState(() => !isDetailOpen(sessionId))
      React.useEffect(() => {
        // M2：会话切换时组件实例被复用，`useState` 的初值不会重算 —— 必须先在 effect 体内把
        // 开合态复位成本会话记录的状态，再订阅广播（顺序反了，广播来的状态会被立刻冲掉）。
        setCollapsed(!isDetailOpen(sessionId))
        return subscribeDetail(() => setCollapsed(!isDetailOpen(sessionId)))
      }, [sessionId])

      /*
       * M1：展开态下「现在」那一行必须自己走字。快照只在下一次投影到达时才变，空闲的会话可以十几
       * 分钟不动 —— 没有心跳，秒数就冻在打开面板的那一刻。
       *
       * 口径与状态条完全一致：整秒对齐的递归 `setTimeout`（节拍 = `CLOCK_TICK_MS`），而且**收起或
       * 空闲时不挂任何定时器**。这也是 L5 里前缀分区唯一能有的时钟源：`now` 每秒往下传。
       */
      const busy = snapshot !== null && snapshot !== undefined && snapshot.busy === true
      const [heartbeat, setHeartbeat] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (collapsed === true || busy !== true) return undefined
        let handle = null
        const tick = () => {
          setHeartbeat(Date.now())
          handle = setTimeout(tick, CLOCK_TICK_MS - (Date.now() % CLOCK_TICK_MS))
        }
        handle = setTimeout(tick, CLOCK_TICK_MS - (Date.now() % CLOCK_TICK_MS))
        return () => {
          handle = cancelTimerHandle(handle)
        }
      }, [collapsed, busy])

      try {
        if (snapshot === undefined || snapshot === null) return null
        if (snapshot.mountStatus === 'disabled') return null
        if (collapsed) return null
        return detailBody(props, snapshot, collapsed, heartbeat)
      } catch (error) {
        // §9 第 3 条：渲染期异常必须变成界面上的红字，而不是白屏或悄悄消失。
        console.error(`[${NS}] 详情面板渲染失败`, error)
        return errorPill(
          `${makeText(props && props.t)('error.detail', '详情面板渲染失败')}：${error && error.message ? error.message : String(error)}`,
        )
      }
    }

    /*
     * ── 挂载 ────────────────────────────────────────────────────────────────────
     *
     * 摘要行与详情面板**各自注册、各自自检**：面板挂不上不能连坐摘要行，反之亦然。
     * 唯一的界面外副作用是 D5 允许的 `data-dsh-status-turbo-mount-failed`（`document.body.dataset`）。
     */
    const mountState = { status: false, detail: false }
    let mountFlag = null

    /** U6：两个条目都挂上写 `'0'`，否则写 `'1'`；只在状态真的变化时写，避免抖动。 */
    function syncMountFlag() {
      if (typeof document === 'undefined' || !document.body || !document.body.dataset) return
      const value = mountState.status && mountState.detail ? '0' : '1'
      if (mountFlag === value) return
      mountFlag = value
      document.body.dataset.dshTurboMountFailed = value
    }

    /**
     * L1：`timer.timeout` 在宿主/测试里可能返回三种东西 —— 一个函数、一个带 `dispose()`/`cancel()`
     * 的句柄、或者一个 Node 的 `Timeout` 对象。统一在这里收口，调用点不必猜。
     */
    function cancelTimerHandle(handle) {
      if (handle === null || handle === undefined) return
      if (typeof handle === 'function') {
        handle()
        return
      }
      if (typeof handle.dispose === 'function') {
        handle.dispose()
        return
      }
      if (typeof handle.cancel === 'function') {
        handle.cancel()
        return
      }
      clearTimeout(handle)
    }

    /**
     * 一个条目的注册 + 3 秒挂载自检（E-A01 / E-A05 的逐字文案由 label 与 slot 拼出）。
     *
     * L1：两条句柄都要**持有到卸载**，不能随手丢掉返回值：
     * - `timer.timeout(check, 3000)` 的返回值以前被丢掉，插件被卸载/热重载后自检仍会在 3 秒时
     *   打一条"未能挂载"的假告警（挂载点其实是被我们自己的退订摘掉的）；
     * - `slots.inject(...)` 的退订句柄以前也被丢掉，注入会留在槽上。
     *
     * 现在两者一起交给 `ctx.effect`，退订时先停自检、再摘注入，且**幂等**。
     *
     * @returns {Function} 退订函数（`ctx.effect` 不可用时由调用方兜底持有）。
     */
    function registerEntry(ctx, slots, slot, id, order, component, key, label) {
      let mounted = false
      let disposed = false
      let injected = null
      try {
        injected = slots.inject(slot, () => {
          // 卸载后即使宿主再触发一次注入回调，也不许把条目重新挂回槽上。
          if (disposed) return () => {}
          mounted = true
          const dispose = slots.register({ name: slot, id, order, locale: NS, registrant: NS }, component)
          mountState[key] = true
          syncMountFlag()
          return dispose
        })
      } catch (error) {
        console.error(`[${NS}] ${label}注册到 ${slot} 失败`, error)
        syncMountFlag()
        return () => {}
      }

      // 无挂载点时 `inject` 的回调永远不会执行 —— 客户端插件唯一还能报错的通道就是 console。
      let timerHandle = null
      const stopCheck = () => {
        if (timerHandle === null) return
        cancelTimerHandle(timerHandle)
        timerHandle = null
      }
      const check = () => {
        timerHandle = null
        if (mounted || disposed) return
        console.error(
          `[${NS}] ${label} 3 秒内未能挂载到 ${slot}：该挂载点不存在或未被声明（详见 docs/design.md「失败可见性的边界」）`,
        )
        syncMountFlag()
      }
      const timer = typeof ctx.get === 'function' ? ctx.get('timer') : undefined
      if (timer && typeof timer.timeout === 'function') {
        try {
          timerHandle = timer.timeout(check, 3000)
        } catch {
          timerHandle = setTimeout(check, 3000)
        }
      } else {
        timerHandle = setTimeout(check, 3000)
      }

      const dispose = () => {
        if (disposed) return
        disposed = true
        stopCheck()
        if (typeof injected === 'function') injected()
      }
      if (typeof ctx.effect === 'function') {
        try {
          ctx.effect(() => dispose)
        } catch (error) {
          console.warn(`[${NS}] ${label}退订句柄注册失败（卸载时自检定时器可能残留）`, error)
        }
      }
      return dispose
    }

    /**
     * 0.8.0 到量轮换：客户端执行动作所需的模块级状态。
     *
     * - `clientCtx`：在 `apply(ctx)` 里记下，供 `performRotation` 取 `sessions` / `workspaces` / `timer`；
     * - `rotationInFlight`：同一时刻只跑一次 —— auto 由 `TurboStatusBar` 的 effect 触发，重渲染可能重入；
     * - `rotationOutcomes`：**客户端本地**的结果（`running` / `ready` / `failed` / `done`），按 sessionId 记账。
     *   为什么放本地：wire 是**单向**的（宿主 → 客户端），客户端没有回写通道，而「到底轮换成功没有」
     *   只有客户端知道。宿主那侧停在 `armed`（只写一次），不会重复触发。
     *
     * 0.9.3 两个修正：① 它从单个槽位改成 Map —— 单槽位下切换会话会把别处的结果挤掉；② 每次落地都经
     * `notifyRotation()` 广播 —— 不广播的话结果变了没有任何组件会重渲染，面板会一直停在「正在轮换…」。
     * 条目里带 `wireStatus` / `wireChildId` / `wireAt`，wire 换新目标时由 `syncRotationOutcome` 作废，
     * 否则一次失败会让该会话**永久**不再尝试（早退条件看的就是「该会话有没有结果」）。
     */
    let clientCtx = null
    let rotationInFlight = false
    const rotationOutcomes = new Map()
    const rotationListeners = new Set()

    /**
     * L2：**用户当前正在看的会话 id**，由常驻的状态条在会话变化时登记。
     *
     * 轮换的重试链属于**旧**会话（`sessionId`），用户切走之后这条链就没有意义了 ——
     * `openWithRetry` 拿它当取消标志。`null` 表示"还没登记过"：此时**不取消**，
     * 免得测试或首帧（状态条还没跑 effect）里把本该执行的轮换掐掉。
     */
    let activeSessionId = null

    /** 登记当前会话；非字符串 id 一律归一化成字符串，比较用全等。 */
    function noteActiveSession(sessionId) {
      activeSessionId = sessionId === undefined || sessionId === null ? null : String(sessionId)
    }
    /** 本地结果条数上限；超了淘汰最旧一条（与 `sessionSeenAt` / `detailOpen` 同一手法）。 */
    const ROTATION_OUTCOME_LIMIT = 128

    /**
     * 订阅轮换结果的变化（状态条与详情面板都要据此重渲染）。
     *
     * @param {Function} listener 变化时调用。
     * @returns {Function} 退订。
     */
    function subscribeRotation(listener) {
      rotationListeners.add(listener)
      return () => {
        rotationListeners.delete(listener)
      }
    }

    function notifyRotation() {
      for (const listener of rotationListeners) {
        // 一个订阅者抛错不许带走其他订阅者（组件卸载后 setState 就会抛）。
        try {
          listener()
        } catch (error) {
          console.error(`[${NS}] 轮换状态订阅者抛错`, error)
        }
      }
    }

    /**
     * 读某会话的本地结果。
     *
     * @param {string|null} sessionId 旧会话 id。
     * @returns {object|null} 结果，没有则为 null。
     */
    function rotationOutcomeOf(sessionId) {
      return sessionId === null ? null : rotationOutcomes.get(sessionId) || null
    }

    /**
     * 落地一条本地结果并广播。
     *
     * @param {string} sessionId 旧会话 id。
     * @param {{status: string, reason: string|null, childId: string|null, wireStatus: string, wireChildId: string|null, wireAt: number|null}} patch 结果。
     */
    function setRotationOutcome(sessionId, patch) {
      if (rotationOutcomes.size >= ROTATION_OUTCOME_LIMIT && !rotationOutcomes.has(sessionId)) {
        const oldest = rotationOutcomes.keys().next()
        if (oldest.done !== true) rotationOutcomes.delete(oldest.value)
      }
      rotationOutcomes.set(sessionId, patch)
      notifyRotation()
    }

    /**
     * 作废某会话的本地结果。
     *
     * @param {string} sessionId 旧会话 id。
     * @returns {boolean} 是否真的清了（清了才广播）。
     */
    function clearRotationOutcome(sessionId) {
      const cleared = rotationOutcomes.delete(sessionId)
      if (cleared) notifyRotation()
      return cleared
    }

    /**
     * wire 换了新目标就作废本地结果：status / childId / at 任一变了都算。
     *
     * `armed → armed`（同一 childId、同一 at）不算 —— 那正是本地结果还生效、用户还能点「重试」的情形。
     *
     * @param {string|null} sessionId 旧会话 id。
     * @param {string} wireStatus wire 的轮换状态。
     * @param {string|null} wireChildId wire 里的新会话 id。
     * @param {number|null} wireAt wire 里的时间戳。
     */
    function syncRotationOutcome(sessionId, wireStatus, wireChildId, wireAt) {
      const outcome = rotationOutcomeOf(sessionId)
      if (outcome === null) return
      if (outcome.wireStatus === wireStatus && outcome.wireChildId === wireChildId && outcome.wireAt === wireAt) return
      clearRotationOutcome(sessionId)
    }

    /** 设置页的控件样式（客户端半不用 CSS 文件，样式一律 inline；深浅色都靠半透明描边）。 */
    const SETTING_INPUT = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      border: '1px solid rgba(128,128,128,0.4)',
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    }

    /** 把 `scope.getSnapshot()` 收敛成页面只认的三种状态：loading / ready / 其余（不可用）。 */
    function readScope(scope) {
      if (scope === null || scope === undefined || typeof scope.getSnapshot !== 'function') {
        return { status: 'unavailable', value: undefined, writable: false }
      }
      try {
        const snapshot = scope.getSnapshot()
        if (snapshot === null || typeof snapshot !== 'object') return { status: 'unavailable', value: undefined, writable: false }
        return {
          status: typeof snapshot.status === 'string' ? snapshot.status : 'ready',
          value: snapshot.value,
          writable: snapshot.writable === true,
        }
      } catch (error) {
        return { status: 'unavailable', value: undefined, writable: false }
      }
    }

    /**
     * 设置页的数据面：把本条目自己的 `ConfigForm` 适配成页面已经在用的 scope 形态
     * （`getSnapshot() → { status, value, writable }`、`subscribe`、`set`、`unset`）。
     *
     * 为什么不直接 `forms.get(entryId)` 绑死一个 id：`ConfigForms.get` 对**任何** id 都返回一个表单
     * 控制器（它不核对宿主是否真的服务了这个命名空间），而条目 id 由安装方式决定 —— 由 bundle 的
     * include 带出来的条目叫 `include:<包名>`，显式 `id:` 的条目才用那个 id。所以每次取用都先看
     * describe 镜像里哪个候选真的在服务；镜像还没给出结论时先用首选候选顶着，镜像到了自动换。
     * 订阅挂在镜像上：表单与镜像同源，命名空间变化与值变化都会经过它。
     *
     * `set(field, value)` 的 `field` 是命名空间里的**顶层字段名**（我们就是 `groups`）；底层实现
     * 是 `mutate([{ op:'set', path:[field], value }])`，所以整个数组可以一次写入。
     */
    function formScope(forms) {
      const face = typeof forms.describe === 'function' ? forms.describe() : null
      const pick = () => {
        const view = face !== null && typeof face.getSnapshot === 'function' ? face.getSnapshot().view : undefined
        const served =
          view !== null && view !== undefined && Array.isArray(view.namespaces)
            ? view.namespaces.map((item) => item.ns)
            : []
        const id = CONFIG_ENTRY_IDS.find((candidate) => served.includes(candidate)) ?? CONFIG_ENTRY_IDS[0]
        return forms.get(id)
      }
      return {
        getSnapshot() {
          const snapshot = pick().getSnapshot()
          if (snapshot === null || typeof snapshot !== 'object') {
            return { status: 'unavailable', value: undefined, writable: false }
          }
          return {
            status: typeof snapshot.status === 'string' ? snapshot.status : 'unavailable',
            value: snapshot.value,
            writable: snapshot.writable === true,
          }
        },
        subscribe(listener) {
          if (face !== null && typeof face.subscribe === 'function') return face.subscribe(listener)
          return pick().subscribe(listener)
        },
        set(field, value) {
          return pick().set(field, value)
        },
        unset(field) {
          return pick().unset(field)
        },
      }
    }

    /** 0.16.0 设置项分组：表里没有的键一律落进「其它」，以后加新配置键也不会漏显示。 */
    const CONFIG_GROUP_ORDER = ['status', 'judge', 'inject', 'redact', 'handoff', 'other']
    const CONFIG_GROUP_OF = {
      statusBar: 'status',
      mojibakeMinRuns: 'status',
      reasoningChars: 'status',
      resultHeadLines: 'status',
      activityLimit: 'status',
      activityBytes: 'status',
      noProgressMs: 'judge',
      slowMs: 'judge',
      downgrade: 'judge',
      downgradeFloor: 'judge',
      minQuietSteps: 'judge',
      stuckAction: 'judge',
      stuckRounds: 'judge',
      stuckRepeats: 'judge',
      bulkInjectionBytes: 'inject',
      spillThresholdBytes: 'inject',
      localTrimHeadChars: 'inject',
      localTrimTailChars: 'inject',
      localTrimMinChars: 'inject',
      readOnlyTools: 'inject',
      subagentWaitTools: 'inject',
      humanWaitTools: 'inject',
      jobWaitTools: 'inject',
      redactKeys: 'redact',
      evidenceWhitelist: 'redact',
      handoffExport: 'handoff',
      handoffExportTokens: 'handoff',
      handoffExportBytes: 'handoff',
      handoffExportWindowPercent: 'handoff',
      rotationMode: 'handoff',
      rotationRequireIdle: 'handoff',
      archiveOld: 'handoff',
    }

    /**
     * 这些键在 `apply` 阶段就被读走了（`readGearConfig(effective)` 快照进齿轮），
     * 所以改完要完全重启才见效；其余键都是用时现取（`effective` 上的 getter），写完立刻生效。
     */
    const CONFIG_RESTART_KEYS = ['downgrade', 'downgradeFloor', 'minQuietSteps', 'readOnlyTools']

    /** 数组值在界面上就是多行文本：一行一项（字符串数组/工具名/正则原样，非字符串按 JSON 写回）。 */
    function arrayTextOf(value) {
      if (!Array.isArray(value)) return ''
      return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
    }

    function arrayValueOf(raw) {
      return String(raw === undefined || raw === null ? '' : raw)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    }

    /**
     * 单个配置项的编辑控件。非受控：失焦或回车提交，成功后 scope 快照回流、控件按新值重画
     * （`key` 里带上当前值，值变了就重建，未变则保留用户正在输入的内容）。
     */
    /** 下拉框（0.12.0：工作区与 Agent 预设都从既有选项里挑，不给自由文本框）。 */
    function selectField(key, value, options, disabled, onChange, extra) {
      return h(
        'select',
        {
          key,
          value,
          disabled,
          style: SETTING_INPUT,
          onChange: (event) => onChange(event.target.value),
          ...(extra || {}),
        },
        options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function configField(key, value, disabled, commit) {
      const stamp = `${key}:${JSON.stringify(value)}`
      if (typeof value === 'boolean') {
        return selectField(
          key,
          value ? 'on' : 'off',
          [
            { value: 'on', label: '开' },
            { value: 'off', label: '关' },
          ],
          disabled,
          (next) => commit(next === 'on'),
        )
      }
      if (typeof value === 'number') {
        return h('input', {
          key: stamp,
          type: 'number',
          defaultValue: String(value),
          disabled,
          style: SETTING_INPUT,
          onBlur: (event) => commit(Number(event.target.value)),
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit(Number(event.target.value))
          },
        })
      }
      if (typeof value === 'string') {
        return h('input', {
          key: stamp,
          type: 'text',
          defaultValue: value,
          disabled,
          style: SETTING_INPUT,
          onBlur: (event) => commit(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit(event.target.value)
          },
        })
      }
      if (Array.isArray(value)) {
        return h('textarea', {
          key: stamp,
          defaultValue: arrayTextOf(value),
          disabled,
          rows: Math.min(6, Math.max(2, value.length)),
          style: { ...SETTING_INPUT, fontFamily: 'ui-monospace, monospace', resize: 'vertical' },
          onBlur: (event) => commit(arrayValueOf(event.target.value)),
        })
      }
      return h('code', { key: stamp, style: { opacity: 0.75 } }, JSON.stringify(value))
    }

    /**
     * 「全部设置项」页（0.16.0）。
     *
     * 数据面是插件条目那张 Config 表（`configForms`），这里按组把每个键都摆出来。
     * 写入一律走 `scope.set(key, value)`，
     * 也就是宿主 `settings.mutate` 的 `set` 操作；非法值会被宿主拒绝并显示在页尾。
     */
    function ConfigSection(props) {
      const text = makeText(props && props.t)
      const scope = props !== null && typeof props === 'object' && props.scope ? props.scope : null
      const [snapshot, setSnapshot] = React.useState(() => readScope(scope))
      const [failure, setFailure] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      /** 保存成功的回执（`''` = 没有回执）：这一页每改一个字段就写一次，没有回执就分不清"写了"和"没理我"。 */
      const [saved, setSaved] = React.useState('')

      React.useEffect(() => {
        if (scope === null || typeof scope.subscribe !== 'function') return undefined
        const pull = () => setSnapshot(readScope(scope))
        pull()
        return scope.subscribe(pull)
      }, [scope])

      if (snapshot.status !== 'ready') {
        const message =
          snapshot.status === 'loading'
            ? text('settings.loading', '读取中…')
            : text('settings.unavailable', '设置服务不可用（本机 DSH 没有该设置命名空间），这页改不了。')
        return h('div', { style: { opacity: 0.8 } }, message)
      }

      const writable = snapshot.writable === true
      const value = snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
      const keys = Object.keys(value)
        .filter((key) => key !== 'groups')
        .sort()
      const commit = (key, next) => {
        if (!writable || scope === null || typeof scope.set !== 'function') return
        setBusy(true)
        setFailure('')
        Promise.resolve(scope.set(key, next)).then(
          (ok) => {
            setBusy(false)
            if (ok === false) {
              setFailure(`${key}：${text('settings.saveRejected', '')}`)
              return
            }
            setSaved(`${text('settings.saved', '已保存')} · ${key}`)
          },
          (error) => {
            setBusy(false)
            setFailure(`${key}：${error instanceof Error ? error.message : String(error)}`)
          },
        )
      }
      const sections = CONFIG_GROUP_ORDER.map((groupId) => ({
        groupId,
        keys: keys.filter((key) => (CONFIG_GROUP_OF[key] === undefined ? 'other' : CONFIG_GROUP_OF[key]) === groupId),
      })).filter((section) => section.keys.length > 0)

      return h('div', { style: { display: 'grid', gap: '14px' } }, [
        h('div', { key: 'intro', style: { opacity: 0.75, fontSize: '0.9em', lineHeight: 1.5 } }, text('settings.itemsIntro', '本插件的全部配置项，按组分区；改完即写。')),
        sections.map((section) =>
          h('section', { key: section.groupId, style: { display: 'grid', gap: '6px' } }, [
            h(
              'div',
              { key: 'title', style: { fontWeight: 600, fontSize: '0.95em', opacity: 0.9 } },
              textOf(text, `settings.group.${section.groupId}`, section.groupId),
            ),
            ...section.keys.map((key) =>
              h(
                'div',
                {
                  key,
                  style: { display: 'grid', gridTemplateColumns: 'minmax(150px, 210px) 1fr', gap: '8px', alignItems: 'center' },
                },
                [
                  h('label', { key: 'label', style: { opacity: 0.85, fontSize: '0.9em' } }, [
                    textOf(text, `settings.field.${key}`, key),
                    CONFIG_RESTART_KEYS.includes(key)
                      ? h(
                          'span',
                          { key: 'restart', style: { marginLeft: '6px', opacity: 0.55, fontSize: '0.85em' } },
                          text('settings.restartBadge', '重启生效'),
                        )
                      : null,
                  ]),
                  configField(key, value[key], !writable || busy, (next) => commit(key, next)),
                ],
              ),
            ),
          ]),
        ),
        failure === ''
          ? null
          : h('div', { key: 'failure', style: { color: '#e5534b', fontSize: '0.9em' } }, `${text('settings.saveFailed', '保存失败：')}${failure}`),
        saved === ''
          ? null
          : h('div', { key: 'saved', style: { color: '#3fb950', fontSize: '0.9em' } }, saved),
        writable
          ? null
          : h('div', { key: 'readonly', style: { opacity: 0.75, fontSize: '0.9em' } }, text('settings.readonly', '当前设置只读。')),
      ])
    }

    /**
     * 0.16.0：把本插件自己的运行时 `Config` 表单挂成设置页；0.18.0 删掉名册页后只剩这一页。
     *
     * 数据面用 `ctx.get('configForms').get(entryId)`（0.15.0 起 DSH 的设置页就是"每个插件条目自己的
     * Config 表单"）；取不到就退回旧命名空间 `settingsScope`，再取不到页面只显示"不可用"，
     * 绝不抛错影响状态条与详情面板。
     */
    function registerSettingsSection(ctx, slots, translate) {
      let disposeItems = null
      const scopeOf = () => {
        const forms = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
        if (forms !== null && forms !== undefined && typeof forms.get === 'function') return formScope(forms)
        const settingsScope =
          ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('settingsScope') : undefined
        if (settingsScope === null || settingsScope === undefined || typeof settingsScope.bind !== 'function') return null
        try {
          return settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
        } catch (error) {
          console.warn(`[${NS}] 设置命名空间绑定失败（页面会显示不可用）`, error)
          return null
        }
      }
      try {
        disposeItems = slots.inject(SETTINGS_SLOT, () => {
          const scope = scopeOf()
          return slots.register(
            {
              name: SETTINGS_SLOT,
              id: SETTINGS_ITEMS_ID,
              order: SETTINGS_ITEMS_ORDER,
              locale: NS,
              registrant: NS,
              label: () => translate('settings.items', DICT.zh['settings.items']),
            },
            (props) =>
              h('div', { key: 'dsh-status-turbo-settings' }, [
                h(ConfigSection, { ...props, key: 'config', scope, t: translate }),
                h(TurboNewSessionPage, { ...props, key: 'new-session', t: translate }),
              ]),
          )
        })
      } catch (error) {
        console.error(`[${NS}] 设置页挂载失败（状态条与详情面板不受影响）`, error)
        return () => {}
      }
      return () => {
        if (typeof disposeItems === 'function') disposeItems()
      }
    }

    function apply(ctx) {
      clientCtx = ctx
      const slots =
        (ctx && ctx.slots) ||
        (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined)

      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        console.error(`[${NS}] 客户端激活失败：ctx.slots 不可用，状态条无法挂载`)
        return
      }

      // 语言包是可选增强；注册失败不影响本体（组件自带中文兜底，SPEC R8 只要求 warn）。
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.register === 'function') locale.register(NS, DICT)
      } catch (error) {
        console.warn(`[${NS}] 语言字典注册失败（状态条仍会以中文兜底显示）`, error)
      }

      // 摘要行（order 1，排在原生 stats(order 0) 右侧）—— lead 认定的既有槽位，不许搬家。
      const disposers = [
        registerEntry(ctx, slots, SLOT, STATUS_ID, ORDER, TurboStatusBar, 'status', '状态条'),
        // 详情面板：独立 entry，收起时组件自己 return null，所以这里不占任何高度。
        registerEntry(ctx, slots, DETAIL_SLOT, DETAIL_ID, DETAIL_ORDER, TurboDetailPanel, 'detail', '详情面板'),
      ]
      // 设置页导航项与页面文案要跟随当前语言：`props.t` 只在组件里拿得到，注册期的 `label` 拿不到，
      // 所以自己从 locale 服务取一个取词函数（取不到就退回内置中文）。
      let translate = (key, fallback) => fallback
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.bind === 'function') translate = makeText(locale.bind(NS))
      } catch (error) {
        console.warn(`[${NS}] 设置页导航文案取本地化失败（退回中文）`, error)
      }
      // 设置页（设置 →「全部设置项」）：宿主半没给出本条目自己的 Config 表单时这一页显示不可用。
      disposers.push(registerSettingsSection(ctx, slots, translate))

      // L1：正常情况下两条句柄已经交给 `ctx.effect`；`effect` 不可用时（老宿主 / 测试桩）退到
      // `ctx.on('dispose')`，保证自检定时器与注入在任何一条卸载路径上都被清掉。
      if (typeof ctx.effect !== 'function' && typeof ctx.on === 'function') {
        try {
          ctx.on('dispose', () => {
            for (const dispose of disposers) dispose()
          })
        } catch (error) {
          console.warn(`[${NS}] 卸载钩子注册失败（自检定时器可能残留）`, error)
        }
      }
    }

    exports.name = NS
    exports.inject = ['slots']
    exports.apply = apply
    // 内部函数无法从模块外 import（它们活在 factory 闭包里），而测试必须够到执行体与结果表。
    // 与 `lib/index.js` 的 `__test` 同一手法：只为可测，宿主不会读它。
    exports.__test = {
      performRotation,
      executeRotation,
      openWithRetry,
      rotationSection,
      rotationOutcomeOf,
      clearRotationOutcome,
      syncRotationOutcome,
      subscribeRotation,
      // 审计剩余项（H4/M4/M7/M10）的回归点：分区构造与缓存都是纯函数，够到它们就不必为了断言
      // 「只渲染最近 N 条」「key 不漂移」去搭一整套投影。
      activitySection,
      topToolsSection,
      waitToolsSection,
      memoSection,
      labelSeparator,
      fmtClock,
      // 0.18.0 新会话：分区分片与选择器都是纯函数（吃 `SessionListState` 与 wire 上的 `newSession`），
      // 于是「投影未到不谎报」「话术缺失给提示行」「复制走哪条路」都能无 DOM 断言。
      TurboNewSessionPage,
      NewSessionPanelIcon,
      newSessionCardOf,
      sessionCopyTextOf,
      copyText,
      fallbackCopy,
      selectCurrentSession,
      makeProjectionSelector,
      // 注册体本身也可测：它只碰 `slots.inject` / `slots.register`，用假槽位就能断言
      // 「侧栏 id === 主面板 key」这条派发契约（catalog 明说靠 id 派发，写错就是点了没反应）。
      // 0.14.1：设置页的注册体同样可测 —— 之前那条 `ctx.inject([…])` 的门把整页静默挡掉了，
      // 用假 ctx 断言「没有 inject 也要挂上」正是这次缺陷的回归点。
      registerSettingsSection,
      // H5/M1/M2/L7/L8/M9 的回归点：这两个组件在最小 React 替身下能当普通函数直接调用，
      // 于是「有没有键盘入口」「忙碌才挂心跳」「切会话要重置开合态」都能不求 DOM 地断言。
      TurboStatusBar,
      TurboDetailPanel,
      clickableRow,
      toggleDetail,
      isDetailOpen,
      detailSection,
      // 0.14.1：设置页在「拿不到 settingsScope」时那一格的收敛函数（三种状态），
      // 与注册体配套断言「缺席也照常挂上、页面自己说不可用」。
      readScope,
    }
    return module.exports
  },
})
