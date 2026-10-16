# 到量自动轮换（0.8.0）设计 —— 开新会话 + 引用旧会话 + 归档旧的

> **已被 0.9.0 取代（方案 B）**：本文的 `sessions.fork` 路线已废 —— fork 把**整份旧事件日志**当种子复制进新会话，
> 解决不了上下文积压。现行为「宿主建空白会话 + 把旧会话 id 写进新会话首条 `user/message`」，
> 落地清单见 `CHANGELOG.md · ## [0.9.0]` 与 `README.zh.md · 到量轮换`；本文保留为 0.8.0 的取证记录。
> 下面「结论：做得到」只对 0.8.0 的 fork 路线成立。

> **0.9.3 补注：待定项已定案，本文的旧配置表不要再照抄。**
> - **待定项 1（`rotation` 默认给 `manual` 还是 `auto`）→ 定案 `'auto'`**（0.9.1 起，见 `CHANGELOG.md · ## [0.9.1]`）。
>   理由：方案 B 的全部后果只是**多出一个空白会话**，忽略它没有任何损失；而漏掉轮换的代价是继续背着全部历史直到 bili preflight 拒发。
>   需要人工确认的场合显式设 `'manual'`。
> - **待定项 2（`rotationArchiveOld` 默认 `true` 吗）→ 定案 `false`**（0.8.1 定案，理由见 `CHANGELOG.md · ## [0.8.1]`：
>   归档后侧边栏与 `@` 引用读**同一份列表投影**，`rotationSeedMessage` 里那句 `@<旧会话id>` 会永远解析不到）。
> - **路线 → 定案方案 B**：宿主建**空白**会话（`ctx.sessions.create('session-' + randomUUID(), { meta: { cwd, parentSession: 旧 id } })`）
>   + 把旧会话 id 写进新会话首条 `user/message`（`session.append('user/message', …, { surfaceOp: 'append' })`，模板 `rotationSeedMessage`）
>   + **客户端只做 `sessions.open(childId)`**（有界重试 10 次 × 300 ms）。本文正文那条 `fork → open → archive` 的顺序断言**已作废**。
> - 本文旧配置表与现状相反的至少两处：`rotation` = `'manual'`、`rotationArchiveOld` = `true`；另 `rotationIncreaseTitle`（旧表写默认 `true`）
>   当年被判**已无意义**（没有任何消费者）；**0.20.0 起宿主自己成了消费者，键已复活**（语义就是旧表那句「子会话标题按源标题 `(N)` 递增，便于认亲」，见文末 0.20.0 补记）。现行默认值唯一来源是 `lib/state.js · DEFAULT_CONFIG`
>   （`rotation: 'auto'`、`rotationArchiveOld: false`、`rotationOpenChild: true`、`rotationCooldownMs: 600000`、`rotationRequireIdle: false`、`rotationIncreaseTitle: true`），配置表见 `README.zh.md`。
> - 0.9.3 另修一件事：客户端 `auto` 的触发点此前挂在一棵**默认收起**的子树里（详情面板 `collapsed` 初值 `true`）
>   ⇒ 0.9.0–0.9.2 **实际一次都没自动切过**；现在挂在常驻状态条上，结果落地会广播重渲染，`ready` / `failed` 那一行可点「重试」。
>   见 `CHANGELOG.md · ## [0.9.3]`。

> 结论：**做得到，而且官方 API 齐**。本文所有 API 都是实读 `D:\deepseek-harness\packages\` 得来（行号可查）。
> 用户诉求原文（m00940）：「到了对应的量就应该开一个新的会话 并引用旧会话的会话id，并且归档就会话」。

## 一、机制与证据

| 需要的能力 | API | 证据位置 |
|---|---|---|
| 服务端 fork（带谱系） | `ctx.sessions.fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session` | `packages/core/session/src/index.ts:1081`；README `packages/core/session/README.md:17` |
| 子会话如何"引用旧会话" | header 写 `parentSession: liveSource.id` + `seedLength: seed.length` | `packages/core/session/src/index.ts:1091-1092`；字段定义 `packages/core/session/src/types.ts:74-80` |
| 客户端一条龙 fork | `ISessions.fork({ sessionId, atSeq?, increaseTitle? })` → `Promise<SessionId>` | `packages/client/runtime/README.zh.md:79`；RPC `session.fork` 在 `packages/host/apiproxy/src/fetch/handler.ts:98` |
| 切到新会话 | `ctx.sessions.open(id)` | `packages/client/ui-workspace/src/client/index.ts:77`；`packages/client/ui-workbench-run`… 见 `packages/client/ui-workflow-run/src/client/index.ts:29` |
| 归档旧会话 | `ctx.workspaces.archiveSession(id)`（客户端）/ `ctx.workspaceRegistry.archiveSession(id)`（宿主） | `packages/client/runtime/src/client/workspaces/service.ts:290`；`packages/workspace/workspace/src/index.ts:244`；README `packages/workspace/workspace/README.zh.md:17` |

**现成先例就是侧边栏的「在新对话中分支」**（`packages/client/ui-workspace/src/client/index.ts:88-90`）：

```ts
forkSession: (sessionId) => {
  ctx.sessions.fork({ sessionId, increaseTitle: true })
    .then((childId) => { ctx.sessions.open(childId) })
}
```

以及会话内那条 `forkAt`（`packages/client/ui-conversation/src/client/apply.ts:419-421`）。

**fork 的语义（决定了这个功能为什么干净）**：`fork` 取截至 `boundary`（缺省=最后一个事件）的**事件日志作种子** ⇒ **新会话天然继承完整可见历史**，不需要"把旧会话内容搬过去"。所谓"引用旧会话 id"就是 header 里的 `parentSession`。

## 二、四条硬约束（都是读代码得来，不是猜）

1. **只能在轮次边界 fork**：服务端要求所选前缀**结束在开放轮次之外**，否则拒绝（`packages/core/session/src/index.ts:1132` `fork boundary … ends inside open turn …`）。
   ⇒ 触发判据里必须带「本会话当前无开放轮次」。本插件已有 `PHASES.IDLE`，正好是这个信号。
2. **顺序必须是「先 open 新的，再 archive 旧的」**：客户端在**当前会话被归档**时会把视图清回 New Session 状态（`packages/client/runtime/src/client/workspaces/service.ts:337-347`）。反过来做会闪一下空视图。
3. **归档目前 UI 层不可逆**：`packages/client/ui-workspace/README.zh.md:34`「**没有 Session 删除与取消归档控件**：会话可以归档，但已归档会话没有查看或取消归档入口」。
   ⇒ 归档 = 从侧边栏消失且**界面里捞不回来**（日志仍在盘上、`sessionIds` 席位保留）。所以这个开关必须显眼、可关。
4. **本插件的客户端半能拿到服务**：`lib/client.js:2256` `exports.inject = ['slots']`（本节写于 0.8.0，当时是 `:1470`），并且已经用 `ctx.get('slots')` / `ctx.get('locale')` 取服务 ⇒ 同一形状取 `ctx.get('sessions')` / `ctx.get('workspaces')`。拿不到就**只在面板提示、不动作**（沿用本插件"缺席不是故障"的纪律）。

## 三、建议的实现

### 配置面（`DEFAULT_CONFIG` 唯一来源 + `cordis.patch.yml` 逐字镜像）

| 键 | 建议默认 | 含义 |
|---|---|---|
| `rotation` | `'manual'` | `off` / `manual`（面板多一行 + 按钮）/ `auto`（到量自动跑） |
| `rotationCooldownMs` | `600000` | 两次轮换最小间隔，防连环 fork |
| `rotationOpenChild` | `true` | fork 后是否自动切过去 |
| `rotationArchiveOld` | `true` | 是否归档旧会话（见约束 3） |
| `rotationIncreaseTitle` | `true` | 子会话标题按源标题 `(N)` 递增，便于认亲 |

**建议默认 `manual`，不要一上来就 `auto`** —— 依据是 0.7.x 的实测教训：我原以为 `handoffExportMinDeltaBytes: 8000000` 够稀疏，结果一天写掉 64 份文档。轮换比写文档更不可逆（约束 3），所以先用 `manual` 跑一天看它在什么量级触发，再切 `auto`。

### 判据（宿主半，纯函数）
新增 `shouldRotate({ config, phase, inputTokens, payloadBytes, lastRotationAt, now })`：
阈值（复用 0.7.x 的 token 口径**或**字节口径，先到先得）**且** `phase === 'idle'` **且** `now - lastRotationAt >= rotationCooldownMs`。
放 `lib/handoff.js` 旁边新建 `lib/rotation.js`（同样的纪律：纯逻辑 + 注入 I/O，不碰时间、不直接做 I/O）。

### 状态与传输
`state.js` 的运行时表加 `rotation` 字段（`off|idle|armed|running|done|skipped|failed`），`toView` 加 `rotation` 键 ⇒ **wire v8 → v9**：`TURBO_STATE_VERSION = 9`、`client.js EXPECTED_V = 9`，并同步 `test/state.test.mjs`（「wire v9 恰好 36 键」）、`test/ui-contract.test.mjs` / `test/halves.test.mjs` 里写死的 `v: 8`，以及面板分区计数。
（0.7.0 那次的教训：**升 wire 版本必须先把这些 fixture 同步**，否则一次红 21 条。）

### 动作（客户端半）
```js
const childId = await sessions.fork({
  sessionId: current.sessionId,
  increaseTitle: config.rotationIncreaseTitle === true,
})
if (config.rotationOpenChild === true) sessions.open(childId)      // 先 open
if (config.rotationArchiveOld === true) await workspaces.archiveSession(sessionId)  // 后 archive
```
护栏：一个 `inFlight` 标志（同一会话同一时刻只跑一次）+ 冷却（由宿主状态带过来）。

### 面板
「会话轮换」分区一行，五态与 `handoff` 同款（`off`/`等待达到阈值`/`已达阈值 · 开新会话并归档`/`正在轮换…`/`已轮换 → <新会话 id>`），`manual` 时该行是一个可点按钮。

## 四、明确不做（以及为什么）

- **不替用户在新会话里发第一条消息**（比如 `@handoff.md`）：那等于代替用户开口，且是模型可见输入、必须先进日志。**上下文已经通过 fork 种子继承**，交接文档只是"给人看的"。
- **不自动删旧会话**：DSH **没有会话删除 API**（`packages/client/ui-workspace/README.zh.md:34`），而直接删盘上的 `sessions/` 会砸掉 `bili` 的车道状态与 `dsh-bridge` 的投影缓存。
- **不在非轮次边界硬 fork**：服务端会拒（约束 1）。

## 五、测试计划

- **纯判据**：`shouldRotate` 边界（未到阈值 / 非 idle / 冷却中 / 冷却过 / 脏配置回落 / 两个口径先到先得）。
- **状态机**：`pushRotation` 合并语义、幂等、`failed` 与"服务缺席"不漏进 `hookFaults`。
- **客户端执行体**：注入假 `sessions`/`workspaces`（`fork` 返回 childId、`open`/`archive` 记录调用），**断言调用顺序是 `fork → open → archive`**，并断言拿不到服务时**一次都不调用**。
- **wire v9 fixture 同步** + 面板分区多一行。
- **手工验收清单**：一个真会话越过阈值 → 面板出现按钮 → 点它 → 侧边栏出现 `(1)` 子会话且已切过去、旧的那个从列表消失。

## 六、待你定的两件事

1. `rotation` 默认给 **`manual`**（我建议）还是直接 **`auto`**？
2. `rotationArchiveOld` 默认 **`true`** 吗 —— 考虑到"归档后界面里没有取消归档入口"（约束 3）？
## 附：0.17.1 补记 —— 轮换为什么一度停摆

- **服务取法**：`sessions` / `agents` 只在声明它们的 `ctx.inject([...], cb)` 回调的 ctx 上可取；在模块级 ctx 上写 `run.ctx.sessions` 会**抛错**（不是返回 undefined），被"缺席不是故障"的守卫吞掉后症状是"完全静默"。轮换一处已改为读 `run.sessions` / `run.agents`（`lib/index.js · serviceOf`），并补了 `ctx.inject(['sessions'], …)` / `ctx.inject(['agents'], …)` 两条独立依赖边。
- **判据痕迹**：每次真正走到轮换判据都往 `<profile>/dsh-status-turbo/rotation-trace.jsonl` 追加一行（阈值、是否该轮换、记录状态、服务在不在、结果与消息），每会话 5 秒最多一条。
- **复现与验证**：`_replay-rotation.mjs` 把 `Date.now` 钉在会话末尾事件时刻，用真实 `lib/` 折叠真实事件流；修前 `message:"no-service"`、零建会话，修后 `armed` + `childId` + 一次 `sessions.create`。

## 附：0.19.0 补记 —— 子会话为什么建了却看不见

0.17.1 修好服务取法后，`rotation-trace.jsonl` 显示轮换确实在按字节阈值建会话（2026-10-14 当天 6 次 `armed`），但那些子会话**只活在内存里**：`sessions/` 全树没有它们的日志目录，会话列表里也看不到。

根因不在本插件：`ctx.sessions.create` 是在代理生命周期**之外**发布会话，而持久化层只给生命周期里发布的会话挂写句柄（`dsh-session` 原文：*a session published outside that lifecycle persists nothing*；`dsh-session-persistence-jsonl` 只在 `registerCreated` / adopt 到写句柄后才 `enqueueLive`）。

0.19.0 起改走 `ctx.agents.create({ sessionId, meta })`：宿主在生命周期里构造并发布代理，写句柄随之挂上，会话因此**落盘、可续、界面可见**。这条路径是异步的，于是 `runRotationAction` 的异步分支返回 `via:'agents'` + 非空 `pending`，种子消息排到 promise 落地后再写，落地结果追加一条 `rotation-trace.jsonl`；取不到 `agents` 时退回 `ctx.sessions.create`（老行为）。

## 附：0.19.1 补记 —— 落盘之后还差一步：挂进工作区

0.19.0 让子会话真的落了盘（`sessions/<lane>/session-<id>/session.v4.jsonl.zstd` 出现、`storages/session_projcache` 里有它），但 2026-10-14 20:36 建出来的 `session-20bb5825-…` 在左侧列表里仍然找不到：`storages/workspace.json`（mtime 17:20:42，此后从未被写过）里工作区 `56a6f2ca`（`D:\project`）的 `sessionIds` 只列了父会话。

根因：**列表不是扫磁盘得到的，是各工作区的 `sessionIds` 列出来的**（`dsh-workspace/lib/index.js:102 get sessionIds()` 再按 `host.sessionPath(id) === record.path` 过滤）。宿主自己的新建与分叉路径都会补这一步（`dsh-api-session-controller/lib/index.js:702` 与 `:829-836`），轮换这条路之前没有做。

0.19.1 起 `runRotationAction` 的异步分支在 `agents.create` 落地后再调 `attachChildQuietly`：`workspaceRegistry.resolveByPath(cwd)` 按规范路径精确比对找工作区（找不到就不挂），命中则 `entity.attachSession(childId)`（它自己会读会话 header 的 cwd 做同一目录校验）。返回值 `attached` / `no-registry` / `no-workspace` / `resolve-failed` / `attach-failed` 进 `rotation-trace.jsonl` 的 `attach` 字段，不是 `attached` 时另写一行 warn。挂载失败不影响落盘与播种。

## 附：0.19.3 补记 —— 新会话为什么一跑就红，又为什么要你自己点

0.19.1 之后子会话已经落盘、也已经挂进工作区（左侧列表里能看到它），但用户截图报了两件事：新会话**一跑就是「本轮运行失败」**，而且**要自己点一下那一行**才会切过去。

**为什么一跑就红。** 系统提示里有一段部署级 persona，文本含 `{{model}}`；变量由 `dsh-agent-loop/lib/index.js:1564-1566` 从 `context.agent?.options.provider` / `.model` / `.cwd` 现取，取到 `undefined` 时 `dsh-system-prompt/lib/index.js:172` 直接抛 —— 报错文案就是「`prompt variable "{{model}}" has no value for this assembly`」。我们的 `ctx.agents.create` 只传了 `{ sessionId, meta }`，子代理因此没有模型（也没有旧会话那套 preset 组合）。宿主自己建会话／分叉时是这么写的（`dsh-api-session-controller/lib/index.js:449-466`、`dsh-webhook/lib/types/session.js:140-199`）：`agentOptions: { provider, model }`（未指定时取 `ctx.agentDefaultModel.currentSelection()`）+ `setup: async (agentCtx) => ctx.agentPresets.mount(agentCtx, presetId)`。

**0.19.3 的做法。** `lib/index.js · noteRotation` 取旧会话正在用的模型（`run.agents.get(sessionId).options`；取不到回落 `run.agentDefaultModel.currentSelection()`）与旧会话 header 的 `agentPreset`，随 `runRotationAction` 传给 `createChildQuietly`；后者把 `agentOptions` 放进 `agents.create` 入参，有 preset 时再挂 `setup` 去 `agentPresets.mount`。两条服务各走一条独立依赖边（`ctx.inject(['agentDefaultModel'], …)` / `ctx.inject(['agentPresets'], …)`），取不到只降级 —— 模型缺失时仍按旧行为建会话（那种会话跑起来还是会红，但轮换本身不拦）。

**为什么还要点一下。** 客户端半拿到 `armed` 记录后调 `sessions.open(childId)`，失败就按 `ROTATION_OPEN_RETRY_MS` 退避重试；0.19.2 时是 300ms × 10（约 3 秒），而 0.19.0 起子会话要经过「`agents.create` 异步落地 → `attachChildQuietly` 挂工作区 → 客户端会话列表收到它」两跳才可切。超时后 `executeRotation` 返回 `ready`，界面留一句「新会话已就绪，但客户端列表里还没有它 —— 请点该行重试」—— 这就是用户看到的"要自己点"。0.19.3 把重试放到 500ms × 40（约 20 秒）。

**验收口径**：触发一次到量轮换后，子会话应当 ①左侧列表里出现、②首条消息是我们的开场话术（**0.21.1 起这条作废** —— 子会话不再有任何首条消息）、③**无需手动点击**就自动切过去、④第一条回复不再报 `{{model}}`。

## 附：0.19.4 补记 —— 切会话为什么一直失败（`sessions.open` 不存在了）

0.19.3 把「为什么还要点一下」归因成重试太短，只对了一半：真因是**调的方法根本不存在**。

活体目录（`cordis_inspect_query(platform=client, provider=Service, method=listService)`）给出的客户端服务只有
`layout` / `locale` / `sessions` / `slots` / `theme` / `timer` / `uiWorkspace` / `workspaces`；其中 `sessions` 的面是
`retain` / `using` / `retainInfo` / `refreshProjections` / `search` / `fork` / `scope` / `binding` —— **没有 `open`**
（也没有 `list` / `create`）。`uiWorkspace` 才有 `openSession(target: SessionTarget): void`（实现
`dsh-client-ui-workspace/lib/client.js:821` → `replaceMain(target, this.lifetime.signal, 'reveal')`）；宿主自己的界面
也走这条（同一文件 `:4164 uiWorkspace.openSession(sessionId)`）。

所以 `performRotation` 里那句 `typeof sessions.open !== 'function'` 是**恒真**的失败判据：每次轮换都落
`failed` / `reason: 'no-service'`，面板于是长期显示「轮换失败 · 宿主拿不到 sessions 服务」。0.19.4 起优先取
`uiWorkspace.openSession`，`sessions.open` 只作旧版回落；`no-service` 的文案也改成客户端口径
（「客户端没有可用的切会话接口」）。`ctx.get(name)` 这种可选取法在动态客户端包里是合法的 —— 核心自己就这么写
（`dsh-client-ui-workspace/lib/client.js:4125 const sessions = ctx.get("sessions")`），`ctx.inject` 只是硬依赖的写法。

## 附：0.20.0 补记 —— 子会话的名字（`rotationIncreaseTitle` 为什么回来）

0.9.0 废掉 `fork` 之后，「子会话标题按源标题 `(N)` 递增，便于认亲」这条诉求**失去了载具**：方案 B 建的是**空白**会话，
它没有任何可继承的标题事件，而 `session-title` 的回退规则只认**首条 `user/message`** —— 那条消息恰恰是每一代都一模一样的
`rotationSeedMessage` 模板。于是每一代子会话的标题都是同一串被截断的开场话术，用户认不出「这个会话是哪个会话新开的」。

0.20.0 让**宿主**成为这个键的消费者：`lib/rotation-host.js · retitleQuietly` 在「建会话 → **0.21.1 之前还要写种子消息**」之后，读旧会话的
持久化标题（`ctx.sessionTitle.get(sessions.get(旧 id))`），按官方 `sessions.fork({ increaseTitle: true })` 的同一套约定
递增（实现见 `packages/client/runtime/src/client/sessions/service.ts · increasedForkTitle`：尾部 `(N)` / `（N）` 保留括号样式
递增，其余追加 ` (1)`；源会话没有持久化标题时跳过），再 `ctx.sessionTitle.rename(子会话, 名字)` 写回。

`rename` 的关键性质（`packages/session/session-title/src/index.ts`）：它 append 一条 `source: { kind: 'user' }` 的
`session/title` 事件，而**用户来源的最新标题会钉住该会话** —— 此后 `session-title` 的回退与自动修订都不再改动它。
`rename` 还要求传入的 session 是「本 store 里活着的那个」（`this.ctx.sessions.get(session.id) !== session` 即抛
`session "<id>" is not live in this store`），所以改名目标优先用 `sessionOf(sessions, childId)` 取的**真身**，拿不到才退回
`agents.create` 交回的 session 对象。

依赖边：`ctx.inject(['sessionTitle'], …)`（与 `sessions` / `agents` / `workspaceRegistry` / `agentDefaultModel` / `agentPresets`
同款，取不到只降级 —— 服务缺席时轮换照做，只是子会话没有名字）。所有失败路径（no-service / 键关掉 / 无标题 / 拿不到子会话 /
rename 抛错）都收敛成 `{ ok: false, title: null, reason }`，绝不外抛，结果落在 `rotation-trace.jsonl` 的
`titleOk` / `title` / `titleReason` 三个字段上（wire 不动）。

客户端同批修的另一半（见 `CHANGELOG.md · ## [0.20.0]`）：`auto` 正在「等当前回合结束再切」时，那一行**改为可点**
（点击 = 立刻切过去），并多一行「切过去并归档当前会话」—— 后者正是用户问的「或者关闭当前会话」。

## 附：0.20.0 只提醒（`rotationCreate` 为什么默认 `false`）

用户同日又拍板：「去掉你的 新会话生成；更改为提醒，目前点一个会话 生成一个新的会话 麻烦又乱」。
`lib/index.js · noteRotation` 因此在调用 `runRotationAction` **之前**多了一道闸：`shouldRotate` 判据照旧
（`remind` 与 `armed` 共用同一套阈值与新鲜度门，所以「到量」这件事只有一个真相），但 `rotationCreate !== true`
时只 `pushRotation({ status: ROTATION_STATUS.REMIND, … })`、写一行 trace（`outcome: 'remind'`）后返回 ——
不建会话、不挂工作区、不切界面。客户端据此把那一行显示成「已到轮换阈值 · 建议开新会话（开场话术在设置页可复制）」，
状态条那一格同步显示「建议开新会话」。

两个实现细节值得记住：

1. `status` 的白名单在 `lib/state.js · ROTATION_STATUSES`，不在 `lib/rotation.js` —— `rotationRecord` 拿它归一化，
   不在表里的值会被**静默改写回 `idle`**。第一版就踩了这个坑：闸门确实进了、`remind` 也确实 push 了，落盘却是 `idle`
   （`inputTokens` / `payloadBytes` 这类不在归一化列表里的字段照常写进去，所以记录看起来「有值但没状态」）。
2. `remind` 只在「记录还不是 `remind`」时写一次，避免每个后续事件都推一条把客户端那一行反复刷。


## 附：0.21.0 把交接话术搬到状态条

用户原话（m08351）：「这个状态信息 添加一个复制的按钮…复制的话术可以如下：当前会话的会话名称+会话id+会话日志目录+继续处理未完成的任务」。

- **话术由纯函数拼**：`lib/client.js` · `sessionCopyTextOf(view, text)` —— 四行固定顺序（会话名称 / 会话 ID / 会话日志目录 / 继续处理未完成的任务），**值为空就整行省掉**；名称与旧会话 id 都为空时返回的只有最后那句任务说明 —— 按钮**照样渲染**（那句就是交接要的），不存在「什么都不复制的按钮」。纯函数（不碰剪贴板、不碰 React）才有回归测试可写。
- **两个字段是新进 wire 的**：`newSession.title`（宿主 `ctx.sessionTitle.get`，服务缺席 / 无标题给空串，走已有的 `readTitleQuietly` 口径）与 `newSession.logDir`（`<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>`，`projectKey` / `encodeSegment` 与 `dsh-session-persistence-jsonl` 同一套规则；没有 cwd 给空串 —— **不许猜路径**）。旧宿主不发这两个字段时客户端只是少两行，不报错。
- **落在哪**：状态条那一行的最后一个 `children` 之前（即折叠开关左边），样式沿用状态条的 pill 语言，只多一个 `cursor: 'pointer'`。

## 附：0.21.1 补记 —— create 模式也不再自动写开场话术

用户 2026-10-16：「还有就是，为什么每次开启一个新会话，都会出现这个？这个应该改成手动复制，请你把这个开启新会话 自动填充这个的去掉。」

「每次开新会话都出现」不是草稿预填，是方案 B 的第二步真的写了一条消息：`lib/rotation-host.js · seedQuietly` 在建完空白子会话后
`session.append('user/message', seedMessage({ id, text }), { surfaceOp: 'append' })`，文字由 `rotationSeedText()` 渲染
（`lib/rotation.js:163-168`，缺省取自 `lib/state.js` 的 `rotationSeedMessage`）；`rotationCreate` 0.20.0 之前默认为真、`rotationOpenChild` 默认为真，
于是「到量 → 建会话 → 写话术 → 自动切过去」连成一条，用户看到的就是每开一个新会话都带着同一段文字。

证据在插件数据目录 `D:\deepseek-harness\profiles\desktop\dsh-status-turbo\rotation-trace.jsonl`：`outcome: 'armed'` 的 `childId` 去重 **32** 个
（末条 `armed` 是 10-15 19:57:53，对应 `session-c70cc147-…`），磁盘上 `D:\deepseek-harness\sessions` 里还剩 **26** 个这样的会话目录；
10-16 00:51 装上 0.20.0 重启后，轨迹里只有 `idle` / `remind`（每小时数十条，`payloadBytes` ≈ 50 MB）——**没有再建过会话**。
插件客户端半与这件事无关：`lib/client.js` 里 `setDraft` / `prefill` / `autofill` 零命中，它只往
`conversation.input.dock` / `conversation.composer.dock` / `settings.section` 三个槽位注册。

0.21.1 的删法（用户拍板「顺手也去掉：create 模式建出来的会话也是空白」）：
- `lib/rotation-host.js` 删掉异步分支与同步退路两处 `seedQuietly` 调用，以及 `seedQuietly` / `seedMessage` 两个函数 ——
  建出来的会话**没有任何消息**，`rotationCreate: true` 也一样。
- 轮换记录去掉 `seedOk`（`lib/state.js · rotationRecord`、`lib/index.js` 三处管道），`seedText` 保留 —— 它是 wire 里
  `newSession.text` 的来源；`lib/rotation.js` 去掉 `ROTATION_MESSAGE.SEED_FAILED`。
- 客户端去掉 `seedNote` 与 `rotation.seed-ok` / `rotation.seed-failed` / `rotation.reason.seed-failed` 三条文案。

`rotationSeedText` / `rotationSeedMessage` / 设置页话术卡 / 状态条「复制话术」按钮**全部保留**：那段文字的角色从
「自动写进新会话」变成「给人复制」。测试 326 pass / 0 fail（条数不变：原来断言「子会话里写进了开场话术」的用例改成断言「子会话里没有任何消息」）；
wire 顶层仍 37 键、`TURBO_STATE_VERSION` 仍 13。10-14 / 10-15 建出的 26 个旧子会话按用户选择移进回收目录（可恢复，未删除）。
