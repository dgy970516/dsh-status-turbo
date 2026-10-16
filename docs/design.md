# dsh-status-turbo 设计说明

## 0. 一句话

把「现在到底卡在哪」变成 composer 上方**一行会跳的字**：阶段 · 工具名 · 本阶段已耗时 · 本步 token · 无进展告警（0.19.2 起档位不再重复；缓存命中率自始不进状态条）。
数据全部来自**已 commit 的会话日志**，不读宿主内存、不轮询、不注入 DOM、不爬 React fiber。

本文件记录支柱 **A1（状态条）** 的设计与**实测依据**。文中每个 ★ 标记的接口都来自本机实读，不是推断。

---

## 1. 为什么是这个数据通道（A1 的关键决策）

### 1.1 候选方案与淘汰理由

| 方案 | 结论 | 依据 |
| --- | --- | --- |
| 自建 `webServer` 路由 + SSE 推给前端 | **淘汰** | 需要自己写传输、自己管理连接生命周期；而 DSH 已经有一条官方通道把宿主状态送到客户端组件，见 1.2 |
| `host.call(...)` 轮询 | **淘汰** | 轮询间隔必然带来延迟，§6#1 要求 1 秒内可见；且空转浪费 |
| 客户端 `ctx.get('sessions')` 直接读事件 | **部分可行但不必要** | 官方推荐的读法是投影（见下），投影会做增量折叠与缓存，比自己扫事件更省 |
| **宿主 wire 投影 + 客户端 slot 组件** | **采用** | 见 1.2 / 1.3 |

### 1.2 读侧：`useProjection` 是官方读法

★ `D:\deepseek-harness\profiles\desktop\.core-rc2-shim\node_modules\@deepseek-ai\dsh-client-ui-conversation\lib\client.js` 里真实调用点：

```
:15376  useProjection("inbox")
:16998  useProjection("contextPressure")
:16999  useProjection("contextBreakdown")
:17240  useProjection("plan", (plan) => plan !== void 0 && (plan.pending ? !plan.active : plan.active))
:17241  useProjection("goal", (goal) => goal != null)
:17261  useProjection("imageLimits")
:17343  useProjection("todos") ?? []
```

⇒ 签名是 `useProjection(key, selector?)`；**key 未注册时返回 `undefined` 而不抛错**，所以组件可以拿 `undefined` 做降级分支。
⇒ 客户端**不需要**写任何传输代码：`@Remote('projections')` 已经在 `dsh-api-session-controller` 上（★ `lib\typert.host.js:1562`，请求体 `{ sessionId }`，返回值 `SessionProjectionBaseline | null`，客户端由 `dsh-api-remotes\lib\client.js:11560/11567` 对接）。

### 1.3 写侧：投影注册的权威模板

★ `D:\deepseek-harness\profiles\desktop\node_modules\dsh-cache-billing\lib\index.js`

```
:14523  var inject = ["sessionProjections"];
:14608  function apply(ctx, _config) { ctx.inject(["sessionProjections"], (projectionCtx) => { ... }) }
:14610  projectionCtx.sessionProjections.register({
          key: "cacheBilling", stateVersion: 6,
          stateSchema: <zod>, init: () => ({...}), apply: (state, event) => ({...}),
          wire: { viewSchema: <zod>, view: (state) => ({...}) },
        })
```

⇒ `wire` 与 `init`/`apply` 平级；`view` 必须返回纯 JSON。

### 1.4 「正在执行 bash」为什么能秒级看见

★ `D:\deepseek-harness\profiles\desktop\.core-rc2-shim\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`

```
:682  return session.append("tool/call", { turn, step, callId: block.id, name: block.name, arguments: block.arguments }).seq;   // appendToolCall
:697  session.append("tool/result", { turn, step, message, ...meta }, { surfaceOp: "append", sourceEventSeqs: [callSeq] });    // appendToolResult
:943  this.session.append("turn/start", { turn });
:968  this.session.append("step/start", { turn, step });
:992  this.session.append("step/end", { turn, step });   // 在 finally 里
```

`tool/call` 在**工具真正执行之前**就 commit，`tool/result` 在结算时 commit。两者之间的窗口**就是**"工具在跑"。
因此状态条不需要任何实时推送 —— 长 bash 期间日志一动不动，状态条照样每秒跳。

### 1.5 耗时为什么不需要推送

`event.time`（宿主写的 commit 时间戳）随事件落到投影里；客户端用**自己的本地时钟** `Date.now() - phaseStartedAt` 算耗时。
宿主 → 客户端在这条路径上**零推送**，也就没有"推送断了状态条就冻住"的失效模式。

---

## 2. 宿主半：`lib/index.js` + `lib/state.js`

### 2.1 分层

- `lib/state.js` —— **纯函数**折叠：不碰 `Date.now()`、不碰任何服务、不引第三方依赖；仅一处 Node 内建 import（`node:crypto`，算 A2 的工具参数指纹）。可在 Node / 宿主 / 测试里以完全相同方式运行。
- `lib/index.js` —— 只做一件事：把 `state.js` 注册成 wire 投影 `turbo`。

### 2.2 「同一引用」是契约的一部分

`applyEvent(state, event)` 对不关心的事件**返回同一个 state 引用**。
★ `dsh-session-projection\lib\index.js:422` 的 `drive()` 只在 `!Object.is(next, previousState)` 且 `listeners.size > 0` 时才计算 `wire.view(next)`。
⇒ 返回同引用 = 下游零成本；这不是优化，是必须遵守的语义。

### 2.3 为什么不用 zod

★ `dsh-session-projection\lib\index.js` 运行时对 schema **只调 `.parse()`**：
`:255` / `:259`（viewCheckpoint）、`:297` / `:305`（持久化还原）、`:422`（drive）、`:433`（viewCell）。从不读 `.shape` / `.safeParse`。
且 `stateSchema.parse` 只出现在**冷启动/持久化还原**路径。

⇒ 纯 JS 插件传一个直通 stub 即可：

```js
const passthroughSchema = { parse: (value) => value, safeParse: (value) => ({ success: true, data: value }) }
```

不必引入 zod，也不必加一层 esbuild 构建（`dsh-cache-billing` 把 zod 4.4.3 整包内联进 `lib/index.js` 才能用，那是它自己的选择）。

### 2.4 阶段映射表

| 日志事件 | 阶段 | 备注 |
| --- | --- | --- |
| `turn/start` | `assembling` | 重置本轮计数 |
| `step/start` | `assembling` | 重置本步 token |
| `request/header` | `requesting` | 提示词组装完毕 |
| `assistant/attempt` | `streaming` | 一次尝试的流已落盘 |
| `assistant/message` | `requesting` | 累加 TokenUsage，算命中率，刷新 `lastProgressAt` |
| `tool/call` | `tool`(name) | ★ 执行前 commit ⇒ 秒级可见 |
| `tool/result` | `requesting` | 刷新 `lastProgressAt` |
| `approval/asked` | `approval` | `approvals++` |
| `approval/decided` | `tool` 或 `requesting` | 工具没结算就回 `tool` |
| `compaction/start` / `end` | `compacting` / `requesting` | |
| `llm/retry-started` | `requesting` | `retries++` |
| `user/message` | `assembling` | 刷新 `lastProgressAt`，`retries` 归零 |
| `turn/end` | `idle` | `busy=false` |

其余 40 余种事件（`todo/write`、`team/*`、`tool-workflow/*`…）对 A1 无信息量，**返回同一引用**。

### 2.5 缓存命中率

`hitRate = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`。
依据同源：`dsh-cache-billing` 的"会话累计输入 = 命中 + 未命中 + 写入"，即 `inputTokens` 与 cache 字段**互斥不重叠**。

### 2.6 无进展（A3 的判据，A1 先只做显示）

`lastProgressAt` **只在真的有新产出时**推进（`assistant/message`、`tool/result`、`compaction/end`、`user/message`）。
`tool/call` **不**推进它 —— 于是"bash 跑了 3 分钟一个字节没吐"会被判成无进展，正是我们想让人看见的。

### 2.7 wire 视图 v2：恰好 28 键

`TURBO_STATE_VERSION = 2`（`lib/state.js`），v1 的 19 键**逐字不变且仍在前面**，其后追加 9 个新键：

| # | 键 | 语义 |
| --- | --- | --- |
| 1–19 | `v` `phase` `phaseStartedAt` `turnStartedAt` `stepStartedAt` `lastProgressAt` `turn` `step` `tool` `toolStartedAt` `stepTokens` `turnTokens` `effort` `hitRate` `toolCalls` `retries` `approvals` `busy` `noProgressMs` | v1 原样，一字节没动 |
| 20 | `mountStatus` | `'enabled'` / `'disabled'`（见 §2.8 的开关口径） |
| 21 | `prefixEpoch` | 缓存前缀被作废的**累计次数** |
| 22 | `prefixCause` | 最近一次作废的原因：`'compaction-start'` / `'compaction-end'` / `'bulk-injection'` / `null` |
| 23 | `prefixAt` | 最近一次作废的时刻（毫秒时间戳，`null` 表示从未） |
| 24 | `lastTurnMs` | **上**一个回合的总耗时（`turn/end` 结算，`null` 表示还没有完整回合） |
| 25 | `topTools` | 最慢的工具 Top-5，元素 `{name, count, maxMs, sumMs}`（元素一律新建） |
| 26 | `hookFaults` | 钩子故障 FIFO，≤ 8 条、**最新在前**，元素 `{at, hook, message}` |
| 27 | `idleLine` | 宿主给的空闲态文案；缺席为 `null`，由客户端自行合成 |
| 28 | `lastSpill` | 最近一次瘦身落盘 `{bytes, locator, at}` 或 `null` |

**版本门是双向的**：宿主半写 `v: TURBO_STATE_VERSION`（= 2），客户端半声明 `EXPECTED_V = 2`
（`lib/client.js`），两者不等时客户端**不渲染半成品**，直接出红字格"投影版本错配（宿主 vN ≠ 客户端 vM）"。
`EXPECTED_V` 必须恒等于 `TURBO_STATE_VERSION` —— 这条等式在 `test/ui-contract.test.mjs` 里被逐字守住。

**`sessionId` 故意不进 wire**：它是宿主半的内部身份（见 §2.8），进 wire 会把 28 键变成 29 键，
而客户端本来就能从槽位 props 拿到会话 id。所以这 28 个键就是全部。

> **0.6.0 起本节已过期一处**：`TURBO_STATE_VERSION` 升到 `3`、视图变 **29 键**（新增 `activity`），
> `EXPECTED_V` 同步为 `3`。本节保留 0.5.0 的历史口径不动，v3 的完整说明见 **§10**。

### 2.8 非日志派生字段的送达机制（本版最微妙的一处）

`hookFaults` 与 `lastSpill` 是**钩子层**（`tools/post-execute` 监听器、落盘逻辑）产生的，
但它们要出现在**投影视图**里，而投影视图的读写两侧都很窄：

- 读侧：`dsh-session-projection/lib/index.js:77` 是 `view: (state) => wire.view(state)` —— **只传 state**。
- 写侧：同文件 `:58` 是 `def.init(session.header, session.inheritedEventCount)` —— **只有这里能拿到会话头**。
- JSDoc（同文件 `:122`）逐字写着：`The returned value is live; callers must not mutate it.`

于是**不能**用"把字段直接写进投影 state"这个最自然的做法：
钩子层拿不到当前会话的 state 对象（`init` 之外无处可得），而即便绕过它去就地改写 state，
也违反了上面那句 JSDoc 的契约 —— 视图是宿主在 `!Object.is(next, previousState)` 时才重算的产物，
**就地改写**既让宿主的变更检测失真，也把"视图 = 日志的纯函数"这条底线砸了。

唯一可行的路径是**模块级 per-session 表**，五步冻结如下：

1. **表**：`lib/state.js` 里的模块级 `runtimeBySession`（`Map`），每条 `{ hookFaults, lastSpill }`，有界
   （`MAX_RUNTIME_SESSIONS`，按插入序 FIFO 淘汰；这个上限是**实现细节**，不进 wire、不加 Config）。
2. **身份**：`initState(header)` 把 `header.id` 存进 `state.sessionId`（`lib/state.js:105`）。这个值**永不变化**，
   它就是查表的键；`sessionId` 本身不进 wire。
3. **写入**：钩子层只经 `pushHookFault(sessionId, fault)` 与 `pushSpill(sessionId, spill)` 两个函数写表
   （`lib/index.js` 的 `onPostExecute` 与 `spillOnce` 的回调是唯一两个调用点）。
4. **读表**：`toView(state)` 用 `state.sessionId` 查表；**查不到条目必须给 `[]` / `null`，绝不给 `undefined`**
   （wire 要求"纯 JSON、字段齐全、无 undefined"）。
5. **接线**：宿主半的 `definition.init` 就是 `(header) => initState(header)`。

三点连带约束：

- **不假装折叠**：`applyEvent` 不许产出这两个键，`initState` 不许初始化它们 —— 它们只属于表，不属于日志折叠。
- **时钟纪律**：`lib/state.js` 全文禁 `Date.now()`（否则重放就不确定了），`at` 只由钩子层与 `lib/spill.js · spillFault` 给出。
- **重放里必须被忽略**：`tools/replay-log.mjs` 对这两个字段**只做断言、不做结论** —— 正常重放必然 0 次非空 / 0 次非 null。

这也是本版**唯一**一处"视图不再是日志的纯函数"的破例，代价与缓解写在 §4.3。

### 2.9 四个新能力的落点与判据

| 能力 | 触发源 / 落点 | 判据 |
| --- | --- | --- |
| **B4** 缓存前缀失效可见 | 时间线与轨迹折叠（`lib/state.js`） | 只有三个**日志真名**事件：`compaction/start`、`compaction/end`、以及单条 `tool/result` 的载荷 UTF-8 字节数 ≥ `bulkInjectionBytes`（默认 32768）。**不读自然语言**。命中即 `prefixEpoch += 1`，`prefixCause` / `prefixAt` 取最近一次；`turn/start` **不**清零。 |
| **A2** 最慢的 5 件事 | 轨迹折叠（`lib/state.js`），**不读宿主内存、不用 around 计时** | 聚合键 = 工具名 × 参数指纹（`name + '\u0000' + fingerprint(arguments)`，`lib/notes.js`）；耗时为相邻 `tool/call` 的 `event.time` 之差，末尾由 `tool/result` 或 `turn/end` 收尾。排序 `maxMs`↓ → `count`↓ → `name` localeCompare↑，取前 5。 |
| **B3** 超大结果瘦身 | 新钩子层（`lib/spill.js`） | **AND 关系**：可行性看宿主的 `toolResultPruner.pruneContent` 能不能剪（拿不到就放弃），意愿看 `spillThresholdBytes`（默认 32768，**UTF-8 字节**口径，自测不借宿主的 `measureContent`）。先 `pruneContent`，再 `spillStore.saveText` 落盘，通知行里**必留绝对路径**；非绝对路径的 locator 一律降级不改内容。**自己不写任何截断**（`lib/spill.js` 里没有正文 `slice`，这条由测例静态守住）。 |
| **C1 / C2 / C3** 模型上下文提示 | 钩子层（`lib/notes.js` 判据 + `lib/index.js` 拼装） | 四段（C2 只读了一部分 / C3-a 乱码 / C3-b 噪声 / C1 缺证据）与 B3 **共用同一个监听器、同一次返回**：顺序 B3 → C2 → C3-a → C3-b → C1（B3 命中时跳过 C3-b），最多 4 个追加块，**一次 `accept`、零新增往返**。判据：C2 = `read` + 正整数 `limit` + 真实总行数 > `offset+limit`；C3-a = 最长连续 `U+FFFD` 连段 ≥ `mojibakeMinRuns`；C3-b = ≥ 8192 字节且噪声行占比 ≥ 0.5；C1 = 命令命中"该拿证据"的词表而输出不命中 `evidenceWhitelist`。四条文案与 B3 通知行都在 `lib/notes.js` 里逐字固化。 |

三条钩子纪律一并记在这里（它们决定了上面的形态）：**不新增往返**（永不返回 `block`、不构造新的 `additionalContexts`）、
**不抛**（监听器抛错会被宿主当成工具执行失败，把一次成功调用污染成 `isError`）、**一次 `accept`**（四段共用一个 `content` 数组）。
任何一段自己出错，就把它收成一条 `hookFaults`，其余照常 —— 宁可少提示，不可污染。

### 2.10 Config 12 键（0.5.0）

> **0.6.0 起追加 5 个活动相关键**（共 17 键），见 **§10.6**；本节其余口径不变。

默认值的**唯一源**是 `lib/state.js · DEFAULT_CONFIG`；`cordis.patch.yml` 逐字镜像它（两边不许各说各话）。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `statusBar` | `true` | `false` ⇒ wire `mountStatus = 'disabled'`，客户端两个 entry 都 `return null` 并跳过 3 秒自检（只有严格 `=== false` 才算关；`mountStatus` 的取值口径见 §2.7） |
| `noProgressMs` | `90000` | 多久没产出算"无进展" |
| `downgrade` | `true` | B1 总开关；`false` 时连 `llm` 都不 inject |
| `downgradeFloor` | `'low'` | B1 只降不升的地板档 |
| `minQuietSteps` | `2` | B1：连续几步只读才降档 |
| `spillThresholdBytes` | `32768` | B3 意愿门槛（UTF-8 字节） |
| `bulkInjectionBytes` | `32768` | B4：单条工具结果多大算"大块注入" |
| `evidenceWhitelist` | 3 条正则 | C1：命中任一条即认为输出里有证据 |
| `stuckAction` | `'warn'` | D：`'warn'` / `'nudge'` / `'stop'`，后两者必须显式配置 |
| `stuckRounds` | `3` | D 的判据参数 —— **本版尚无消费者**，见 §4.3 |
| `stuckRepeats` | `3` | D：同一聚合键重复几次算卡住 |
| `mojibakeMinRuns` | `2` | C3-a：连续几个替换字符算乱码 |

非法值一律**回落默认、永不抛错**（R12）。

---

## 3. 客户端半：`lib/client.js`

### 3.1 挂载点

**`conversation.composer.dock`**（kind `list`，scope `session`，目录描述 "Ambient entries below the composer card"）——
就是 DSH **自带**的 composer 底部状态行那一格。

★ 实读锚点：`@deepseek-ai/dsh-client-ui-chat/lib/client.js:12497-12503`
```js
ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
    name: "conversation.composer.dock", id: "stats", order: 0, locale: NS,
    inject: () => ({ hooks: { performanceUsage } })
}, StatsPills));
```
`cordis_inspect_query(client / Slots / listSubTree, root="conversation.composer.dock")` 实测确认：
`kind: list`、`scope: session`、`occupants: [{registrant:"mf", id:"stats", order:0, active:true}]`、
`standardProps` 含 `useProjection: UseProjection` 与 `sessionId: SessionId`。

> **0.4.0 的搬迁（用户实测反馈驱动）**：0.1.x–0.3.x 挂在 `conversation.input.dock`（composer 卡片**上方**那条通栏）。
> 用户截图反馈它"悬在输入框上方很突兀"，要求并进图二那行原生统计里。
> 于是改成 `conversation.composer.dock` + `id: 'dsh-status-turbo.status'` + `order: 1`（排在原生 `stats` 右侧）。
>
> **0.20.0 又搬回 `conversation.input.dock`**（用户原话：「目前底部状态栏 都拥挤在一起了。是否可以调整到输入框的上面？」）：
> 插件生态长大了，`conversation.composer.dock` 那一行挤进了自动继续 / 完全权限 / 专家团 / 订阅用量 / 模型与推理档，
> 摘要格与它们叠字；搬回输入框上方那条通栏后，摘要格与详情面板各占一行。

### 3.2 挂载契约（★ 实读 `dsh-client-ui-slots\lib\index.js:163-221`）

```
register(options, component)
:165  slot "<name>" is not declared  → 未声明的槽位直接 throw
:182  list 槽 options.id 必填        → 缺 id 直接 throw
:184  同 (id, priority) 重复注册 throw
:209  order 参与 list 排序；:217 locale 合法
```

本项目实际调用（与 ★ `dsh-cache-billing\lib\client.js` 末尾的真实调用逐字同形）：

```js
ctx.slots.inject('conversation.composer.dock', () => {
  return ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'dsh-status-turbo.status', order: 1, locale: 'dsh-status-turbo' },
    TurboStatusBar,
  )
})
```

### 3.3 装载约定

与 ★ `dsh-cache-billing\lib\client.js:1-4` 逐字相同：`window.__ModuleLoader__.load({ id, factory(require) {...} })`，
工厂内声明局部 `module = { exports: {} }`，最后 `return module.exports` —— **既写又返回**，无论 loader 取哪一边都不会拿到空模块。

`factory` 里只 `require('react')`，没有别的依赖。

### 3.4 渲染纪律（§9 第 3 条）

- 渲染体包在 `try/catch` 里，异常 → 红字药丸，**不白屏、不静默消失**。
- 脉动效果用本地时钟算不透明度（`0.4 + 0.6*(0.5+0.5*sin(now/320))`），**不带样式表**，因此不需要构建步骤。
- 颜色只用实读存在的主题变量：`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-brand-primary`、`--dsw-alias-state-warn-primary`、`--dsw-alias-state-error-primary`、`--dsw-alias-separator-primary`（0.4.0 新增，抄自原生 `.iq1doa_sep`）。
- 字号/行高**继承原生那一行**（`font: inherit` + 根容器的 `calc(var(--dsh-content-font-size-secondary,13px) - 1px)`），避免底行里出现两种字号。
- 计时器是组件本地 `setInterval(…, 500)`（只在 busy 时开），随卸载清理。

### 3.5 两个挂载点：一行摘要 + 一个详情面板

0.4.0 之后客户端半有**两个** entry，分工不同，不能合并（`conversation.composer.dock` 是横排的 pill 行，
放不下 7 个分区）：

| entry | 槽位 | `id` | `order` | 内容 |
| --- | --- | --- | --- | --- |
| 摘要行 | `conversation.input.dock`（0.20.0 起） | `dsh-status-turbo.status` | `1` | 一行的活态摘要：阶段 / 工具名与耗时 / 本步 token / 告警 pill / 折叠开关（0.19.2 起档位不再占位；命中率自始不进状态条） |
| 详情面板 | `conversation.input.dock` | `dsh-status-turbo.detail` | `0` | 默认收起、点击开合；展开后固定 7 个分区 |

详情面板的 7 个分区**顺序固定**：本回合 / 上回合 / 缓存与用量 / 前缀 / 最慢的工具 / 最近瘦身（条件）/
最近的故障（条件）。后两个是**条件分区** —— 没有内容就不出现（`lastSpill` 为 `null`、`hookFaults` 为空时）。
折叠指示符逐字 `▸ 详情` / `▾ 收起`。

**空闲态：从"消失"改成"常驻"。** 0.1.x–0.4.x 在 `busy === false` 时 `return null`（状态条整个不见了）。
本版改成**常驻上回合摘要**：宿主给了 `idleLine` 就用它，否则客户端用视图里的 `phase` + `lastTurnMs` 自行合成
`{阶段中文名} · 上回合 {耗时}`。理由是"消失"意味着用户没有任何入口去看上一回合发生了什么，
详情面板也就永远无法被发现。

**间距对齐宿主**：`sep()` 里的分隔点由 `margin: '0 1px'` 改成 `margin: '0 6px'` —— 抄的是原生统计行
（`--dsw-alias-separator-primary` 那一格）的实际值，否则并进同一行后分隔点的疏密和邻居不一致。

> ⚠️ 诚实说明（与 §4.2.4 同一口径）：上面这些断言只能证明"结构、槽位、`id`、`order`、字面量与实现一致"，
> **不能证明"并排看起来好看"**。真正的并排观感需要用户实机截图，见 §4.3 与 `docs/acceptance.md · U3`。

---

## 4. 失败可见性的边界（诚实声明）

| 失败 | 是否可见 | 通道 |
| --- | --- | --- |
| 投影服务缺失 | ✅ 大声 | 宿主半 `throw new Error('dsh-status-turbo: ctx.sessionProjections.register is unavailable — …')` ⇒ 插件被标成 FAILED |
| 槽位未声明 / 缺 `id` / 重复注册 | ✅ 大声 | `slots.register` 自身 throw，客户端半 catch 后 `console.error` |
| 挂载点缺少 `useProjection` | ✅ 界面 | 红字格"挂载点未提供 useProjection" |
| 宿主/客户端半版本错配 | ✅ 界面 | 红字格"投影版本错配（宿主 vN ≠ 客户端 vM）" |
| 渲染期异常 | ✅ 界面 | 红字格"状态条渲染失败：<message>" |
| **挂载点本身不存在** | ⚠️ 仅 console | 客户端插件此时**无处可画**：`inject` 的回调永远不会执行。本插件在 3 秒后 `console.error('[dsh-status-turbo] 状态条 3 秒内未能挂载到 conversation.composer.dock …')` 点名挂载点。这是客户端半唯一还能报错的通道，已在测试里覆盖。 |
| **投影「turbo」始终不到**（宿主半被禁用 / 装载失败 / 版本不兼容） | ⚠️ 界面 + console | 黄字格"宿主半似乎没起来：等待投影超过 8 秒仍未到达"；同时只打一条 `console.error`。**这一行为在 0.1.3 修正过一次**：先前把"投影缺席"当成"新会话尚无值"的静默正常态，是错的 —— 见下。 |

### 4.1 为什么"投影缺席"必须报警（0.1.3 的行为修正）

先前版本的判断是：`useProjection('turbo')` 返回 `undefined` 等于"新会话还没事件，属正常态，不渲染"。
**这条判断和宿主实现相反**，实读证据：

- `dsh-session-projection\lib\index.js:378` `cellFor()` **对任意会话总会惰性物化 cell**：
  `this.buildCell(registration.def, session.header, session.inheritedEventCount, session.snapshotEvents())`；
  `:368` `buildCell` 在**零事件**时也照样给出 `state = def.init(...)`、`observedSeq: -1`。
- `dsh-client-ui-conversation\lib\client.js:14225`/`:14226`/`:14244` 走 `session.projections.faceOf("<key>").getSnapshot()` 取投影。

⇒ 只要宿主半注册成功并且**已激活**，任何会话（包括刚开、事件为零的）都能取到值。
取不到值只可能是：宿主半没注册、被禁用、装载失败或版本不兼容。
所以正确行为是**宽限 8 秒**（给会话切换/首次下发留余量），到点仍缺席就画黄字药丸，而不是继续静默 `null`。

宽限计时**按 `sessionId`** 记账（槽位 `standardProps` 里确实提供 `sessionId`），不用 `useRef`：
组件实例可能被跨会话复用，用实例态会把旧会话的计时带给新会话。

### 4.2 视觉规范（0.4.0：并进原生状态行）

两轮用户实测反馈驱动了两次重做：
1. **0.1.x → 0.2.0**：原版是"整行白底方块"，根因是**布局层级不足** —— 只有一层 block 级 `div`，
   而槽位是整行的 list entry，父容器把它拉成横贯全屏的白块。0.2.0 改成靠左的胶囊。
2. **0.2.0 → 0.4.0**：胶囊虽不再拉伸，但**位置不对** —— 用户截图指出它"悬在输入框上方很突兀"，
   要求并进图二那行 DSH 自带的底部统计（`6轮 283步 · 266 tok/s` / `27.9M tok · 缓存命中 96%` / `10%`）。

#### 4.2.1 抄过来的排版（而不是"另设计一套"）

`@deepseek-ai/dsh-client-ui-chat/lib/client.js:6893` 里 `StatsPills` 注入的 CSS 模块逐字如下：

```
.iq1doa_root{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}
.iq1doa_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.iq1doa_pill svg{flex:none;width:14px;height:14px}
.iq1doa_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
```

本插件把它抄成 `ROW_STYLE` / `PILL_STYLE` 两个常量（见 `lib/client.js`），**一个数值都不改**：
不改字号、不改行高、不改间距、不改圆角、连 `font:inherit` 都保留（否则字号会比旁边那格大一号）。

依据 `references/practices.md:35`：**不要 import 别人的 client 包**（它们随时会变、纯 JS 没有类型检查、
import 一抛就把整个格子打空）。正确做法是把标记与样式抄过来、改名成本插件自己的结构。

#### 4.2.2 只补原生没有的信息（不重复）

原生那一行已经在**同一行里**给了：会话轮/步、tok/s、总 token、会话缓存命中、上下文占比。
所以本插件只保留四格，且都只在忙碌时出现：

| 格子 | 内容 | 例子 |
| --- | --- | --- |
| 阶段 | 呼吸点 + 阶段名 +（工具名等宽）+ `·` + 本阶段已耗时 | `● 执行工具 bash · 2m14s` |
| 本步 | token 图标 + 本步 token（0.19.2 起只留数量，完整说明进 `title`） | `3.1K tok` |
| 档位 | **0.19.2 起不再占状态条**（原生选择器已写着同一个值），只留详情面板 | —— |
| 告警 | 仅在超过 `noProgressMs` 未推进时出现，着色；0.19.2 起只留四个字，判据全文进 `title` | `2:49 无新输出` |

**刻意删掉的两格**：
- **每步缓存命中率** —— 原生那行已经有（会话级）。同一行里放两个"缓存命中"只会让人分不清哪个是哪个。
  数值仍保留在 wire 视图的 `hitRate` 里，供 B4（缓存前缀失效告警）以后使用。
- **本轮耗时** —— 原生的 `TimePill` 已经给了整段会话时间，再加一个同量级的数字是噪音。

#### 4.2.3 图标

**本插件自己画 14×14 的行内 SVG**（`viewBox="0 0 16 16"`、`stroke: currentColor`、`fill: none`、尺寸与原生 `.iq1doa_pill svg{width:14px;height:14px}` 一致）。
不引用任何图标组件：按 §9 第 2 条，**没有图标名可以写错，就没有把整个界面拖崩的可能**。
四个字形：`GLYPH_TOKENS`（三横线）、`GLYPH_GEAR`（速度表）、`GLYPH_WARN`（三角叹号）、`GLYPH_STOP`（圆圈叉）。

#### 4.2.4 测试固化的外观契约

不是"看起来还行"，是可断言的结构（`test/halves.test.mjs`）：

```js
view.props.style.display === 'flex' && view.props.style.justifyContent === 'center'
view.props.style.gap === '12px' && view.props['data-dsh-status-turbo-row'] === true
// 每个 pill：
p.props.style.display === 'inline-flex' && p.props.style.borderRadius === '999px'
p.props.style.background === 'transparent' && p.props.style.font === 'inherit'
// 告警格：
last.props.style.color === 'var(--dsw-alias-state-warn-primary)'
last.props.style.background === 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)'
// 注册参数：
captured.slotKey === 'conversation.composer.dock' && captured.options.order === 1
```

> ⚠️ 诚实说明：这些断言只能证明"结构和数值与原生那格一致"，**不能证明"并排看起来好看"**。
> 本机没有任意 HTML 的渲染/截图能力（`web_fetch` 拒绝 loopback，GUI 根返回 401），
> 0.4.0 的观感是**未经实机视觉验证**的；最终以用户界面上的实际效果为准。

### 4.3 0.5.0（wire v2）的诚实缺口

这一节**不许省略**。以下每一条都是"本版没有做到"或"本版只能证明一半"，写在设计文档里，
以免下游把它们当成已完成。

1. **B2 长工具后台化：未实现。** 取证结论是"在本插件内没有可用的落点"（`PreToolDecision` 不能替换结果、
   `tools/execute` 只允许改 `exec.signal`、`ctx.jobs.start` 的那条唯一路径会新增往返），登记为 BLOCKED。
   完整取证与备选方案见 `docs/plan-B2.md`。**本版没有把它写进 wire、没有加配置键、没有调用 `ctx.jobs.start`。**
2. **D 只做到 `warn` 层。** 默认 `stuckAction: 'warn'` 下零副作用（连"有没有活动"都不查、`session-stop` 从不 emit）；
   `nudge` / `stop` 必须**显式配置**才可达，`stop` 在活动为空时 fail-closed。
   **`stuckRounds` 目前没有任何消费者** —— 它的判据窗口是 `turn/end`，而实现所在的那一层（`tools/post-execute`）
   看不见这个窗口，实现者刻意**没有自造第二套判据**（"看不见就是不判，宁可少提醒"）。
   因此**在消费者落地之前，`stuckRounds` 的配置值对行为没有任何影响**，它是 backlog 而不是本版能力。
   **不得**把本版表述成"D 已完整实现"；正确表述是"D 仅 `warn` 层已交付，`nudge` / `stop` 显式可达，
   `stuckRounds` 消费者为 backlog"。
3. **U3「是否与原生并排同一行」未经实机验证。** 本机**没有**任意 HTML 的渲染/截图能力
   （`web_fetch` 拒绝 loopback，GUI 根返回 401），本版能拿出的只有**源码实读**（`dsh-client-ui-conversation`
   声明了 `conversation.composer.dock` 这个 list 槽位、原生那一格渲染在 `:16309`）与**结构断言**
   （槽位名、`id`、`order`、颜色字面量逐字对得上）。
   这些**不能**证明"并排看起来对"：`order: 1` 只是排序意图，父容器的实际布局（是否真的同一行、会不会被挤到下一行）
   **只有用户实机截图能证明**。在拿到截图之前，任何地方都不许写"已并排"。
4. **`hookFaults` / `lastSpill` 让视图不再是日志的纯函数 —— 本版唯一的破例。**
   §2.8 的表是模块级运行时状态，重放同一份日志不必然得到同一份视图。缓解有三条，缺一不可：
   (a) wire 契约里把这两个字段**明确标注为非日志派生**；
   (b) `tools/replay-log.mjs` 对它们**只做排除与断言，不作结论**（正常重放必然 0 次非空 / 0 次非 null）；
   (c) 它们只在**真的出过错 / 真的落过盘**时才非空、非 null —— 干净会话上视图与日志仍然一一对应。
   反向对照也做过：往表里强制造脏后，重放工具会报"重放被污染，不再是纯日志派生"并**退出码 1**，
   证明上面那个"0/0"不是检测器失效导致的假绿。
5. **A2 的"聚合键"在代码里有两份实现，算法不同 —— 契约（PLAN §3.6）只写了一份。**
   - 宿主半 `lib/state.js:463-466` 自己算了一份：稳定 JSON + **SHA-256 前 12 位十六进制**（0.5.0–0.6.x 那一轮它在 `:209-221`；行号漂移过，算法与结论不变）
     —— 这一份**与契约一致**，wire `topTools` 用的就是它。
   - `lib/notes.js:409-431` 又导出了一份 `fingerprint` / `aggregateKey`，用的是**自实现的 FNV-1a-64**
     （取前 12 位十六进制；注释里也写着"哈希算法按派工指令自实现 FNV-1a-64（不引依赖、不 import 加密库）"），
     它被钩子层（`lib/index.js`，D 的卡住判据）使用。
   于是**同一个工具调用在两处会得到不同的指纹字符串**。功能上不致命（每处都自洽：算与比用的是同一个函数），
   但它是一处**重复实现 + 口径分叉**；而 `test/notes.test.mjs:368` 的用例名又把 notes.js 的指纹称作"A2 / O10 指纹"，
   更容易让人误以为 A2 用的是 FNV。**本版不改代码**（`lib/**` 不在本任务的写权限内），如实记在这里备查。

---

## 5. 已通过的自动验收

```
D:\environment\nodejs_link\node.exe --test "test/*.test.mjs"

ℹ tests 45   ℹ pass 45   ℹ fail 0   ℹ duration_ms ≈ 108        （0.4.0，B1 + 会话 id 修正 + 并进原生状态行）
ℹ tests 44   ℹ pass 44   ℹ fail 0   ℹ duration_ms ≈ 104        （0.3.1，含 B1 + 会话 id 修正）
ℹ tests 40   ℹ pass 40   ℹ fail 0   ℹ duration_ms ≈ 110        （0.3.0，仅 B1）
ℹ tests 18   ℹ pass 18   ℹ fail 0   ℹ duration_ms ≈  86        （0.2.0，仅 A1）
```

对应任务书 §6：

| §6 行 | 测例 | 结果 |
| --- | --- | --- |
| #1（1 秒内看见阶段与耗时） | `§6#1 长 bash 期间：阶段 = 执行工具(bash)，且"本阶段已耗时"只由本地时钟推进` | 通过。断言 `phase='tool'`、`tool='bash'`、`phaseStartedAt=toolStartedAt`，且在零新事件下 180000ms 后仍能算出 `180.0s` |
| #8（无进展变黄） | `§6#8 无进展判定…` + `客户端半 §6#8：超过 noProgressMs 未推进 → 出现 ⚠` | 通过。阈值两侧各差 1ms 判定正确；渲染文本出现 `⚠` |
| #11（失败必须可见） | `宿主半：投影服务缺失时必须大声抛错`、`客户端半 §6#11：挂载点缺 useProjection 时渲染红字`、`ctx.slots 不可用时 console.error`、`3 秒内没挂上 → console.error 点名挂载点` | 通过（4 例） |
| #10（删掉一个依赖插件不崩） | 见 README「手工验收」 | 需在运行中的界面上做 |

另有 22 例覆盖：忽略事件同引用契约、阶段迁移全表、TokenUsage 累加与命中率、脏事件不产生 NaN、wire 视图无 `undefined` 字段、清单形状与槽位参数、以及 §4.3 的 B1 判据与接线。

### 5.5 §6 之外、B1 自己的数字

```
# 判据层（纯函数，12 例）
✔ 连续 2 个干净只读步 → 降档          ✔ 只有 1 个 → 不降
✔ 写入类工具打断                      ✔ 报错打断
✔ 陌生工具（不在白名单）打断           ✔ 纯思考步中性（不计数也不打断）
✔ 新回合清零                          ✔ 没有 floor 档 → 只降一档
✔ 一切不确定 → null                   ✔ 配置读取非法值回落默认
✔ 遍历所有 current×floor 组合：要么 null、要么下标严格更小
✔ 默认白名单里没有任何会写盘或改状态的工具

# 接线层（假宿主，9 例）
✔ agent/request 只注册一次，且 options.prepend === true
✔ high → low，其余字段一个不丢、不凭空加字段
✔ 降档留 info 日志；判据异常留 warn 并原样返回
✔ 轨迹按会话隔离；downgrade:false 时连 llm 都不 inject
```

### 5.1 装进本机 profile 的实机结果（已验证）

```
plugin_manager install_bundle file:D:/deepseek-harness/profiles/desktop/.plugin-specs/dsh-turbo-0.1.0.tgz
→ {"stage":"enable","target":"dsh-status-turbo","enabled":true,"application":"applied","bundle":"dsh-status-turbo",
   "packageResult":{"exitCode":0}, "warnings":[]}
```

**版本沿革**：`0.1.0` 是首个装进 profile 的版本。`0.1.1` / `0.1.2` **只动文档与开发工具**（`docs/design.md` 补上 §5.1–§5.4、两份 README 补上离线复算工具、把 `tools/replay-log.mjs` 纳入发布包），`lib/` 逐字节未动。
**`0.1.3` 是第一次改动 `lib/`**：修正 §4.1 描述的"投影缺席被当成正常态"的静默缺陷（`lib/client.js` 新增 `PROJECTION_GRACE_MS` / `warnPill` / `sessionSeenAt`），并把该行为固化成第 18 个测试。
之所以每次都要提版本号：用**同一个版本号**再次 `install_bundle` 会被 pnpm 判为无需重解析，DSH 侧返回 `{"application":"failed","error":{"code":"ambiguous-install"},"changed":false}`，已装副本会停在旧内容上（实测）。提到新版本号后返回 `{"changed":true,"application":"restart-required"}`，重装成功。

**每次重装后的完整性复核（0.1.3 时实测）**：`dsh.profile.bundles` 仍为 34 且含 `dsh-status-turbo`；`dependencies["dsh-status-turbo"]` 指向最新 tgz；profile `cordis.patch.yml` 仍为 4916 B（安装动作没有碰它）；**声明的 21 个 `dsh-*` 依赖与磁盘上的 21 个 `dsh-*` 目录完全一致（差集为空）**；`dsh.profile.bundles` 全部 34 项都能解析（29 项在 `node_modules`，5 项 `@deepseek-ai/*` 核心包在 `.core-rc2-shim/node_modules`）；宿主半仍是单条 `include:dsh-status-turbo` / `fiberPhase: active`。

| 检查项 | 实测 | 结论 |
| --- | --- | --- |
| `dsh.profile.bundles` | 33 → **34**，含 `dsh-status-turbo` | profile 结构完整 |
| profile 自身 `cordis.patch.yml` | 首次安装前后同为 **4880 B** | 未被**安装动作**改动（§9 第 4/5 条的崩溃面没有被碰到） |
| 关键插件目录 | `dsh-cache-billing` / `dsh-opencode-go` / `dsh-mindmap` / `dsh-better-sidebar` / `dsh-dream-skin` / `dshmarket` / `billion-context` 全部仍在 | pnpm 的 `-45` 只是去重回填，没删东西 |
| **宿主半** | `{"entryId":"include:dsh-status-turbo","moduleName":"dsh-status-turbo","enabled":true,"fiberPhase":"active","patchId":"dsh-status-turbo"}` | `apply` 未抛错 ⇒ `sessionProjections` 服务找得到、`turbo` 投影注册成功 |
| **客户端半** | 0.3.x 时 `conversation.input.dock` 的 occupant：`{"registrant":"dsh-status-turbo","id":"dsh-status-turbo.status","order":50,"active":true}`；**0.4.0 起**搬去 `conversation.composer.dock`，`order: 1`，与原生 `stats`(order 0) 并排 | 挂载成功，**界面没有崩**（§9 第 2 条的最坏情况未发生）；0.4.0 的位置待重启后在界面上确认 |

> 独立交叉验证（0.4.0）：`cordis_inspect_query(client / Slots / listSubTree, root="conversation.composer.dock")` 返回 `occupants: [{"registrant":"mf","id":"stats","order":0,"active":true}]`，`standardProps` 含 `useProjection: UseProjection` —— 与组件从 `props.useProjection` 取值的写法一致，也证实该槽位是"与原生统计同行"的那一格。

> **一处未能解释的变化（如实记录）**：首次安装后测得 profile 的 `cordis.patch.yml` 为 4880 B；约 40 分钟后再测为 **4916 B**（+36 B，mtime `2026-10-06 21:57:05`）。**这不是 dsh-status-turbo 造成的**——全文 0 处出现 `turbo`，且该文件里没有任何 dsh-status-turbo 条目（它是 bundle，走 `dsh.profile.bundles`，不写 patch）。
> 内容完整性已逐项核对：136 行、**14 个顶层条目、无重复 id**，关键条目（`agent-default-model` / `llm-pi-ai` / `opencode-go` / `sql` / `mindmap` / `better-sidebar` / `agent-preset-registry` / `ui-theme`）全部健在，`compaction-basic` 仍显式 `disabled: true`。
> 该文件**没有 4880 B 时期的备份**（现存最近的备份是 16:32 的 661 B 精简版，来自那次崩溃对话框事故），因此无法做逐行 diff 定位这 36 字节。最可能的解释是宿主在 21:57:05 那次落盘时做了 YAML 重新序列化（引号/缩进归一化），而非新增配置项。**结论：内容无害，成因未证实。**

### 5.2 §6#1 的真实数字（用本会话自己的日志复算）

`tools/replay-log.mjs` 会对**真实已落盘的会话日志**做同样的折叠，并打印最长的一次工具静默窗口。对本次会话的日志：

```
# 解压方式  multi-frame（帧数 694，解压失败帧 0）
# jsonl 行数 1182      # 可解析事件 1182（跳过坏行 0）

# 最长工具窗口: pwsh 静默 50.4s（发生在会话 +52m34s，
#   状态条此时应显示「执行工具(pwsh)  50.4s」）
```

那 50.4 秒正是实测时跑的一条前台阻塞命令（`Start-Sleep -Seconds 50`，实测阻塞 **50.0s**）。
⇒ **§6#1 成立**：`tool/call` 在执行前 commit，所以这 50 秒里状态条一直在，且耗时由本地时钟每秒推进（日志在这 50 秒内**一行都没动**）。

### 5.3 §6#8 的真实数字（同一份日志，阈值调小到 20s）

```
[+   7m46s] … → 组装提示词   39.7s   命中 100%   ⚠ 39.8s 模型可能卡死
[+   9m59s] … → 组装提示词   23.7s   命中 99%    ⚠ 23.8s 模型可能卡死
```

`⚠` 分支在真实数据上渲染正确；阈值为默认 90s 时本会话不触发（最长静默 50.4s < 90s），符合预期。

### 5.4 复算工具

```
node tools/replay-log.mjs <session.v4.jsonl.zstd> [--peek] [--max N] [--stall-ms N]
```

会话日志落在 `D:\deepseek-harness\sessions\<workspace-slug>\session-<id>\session.v4.jsonl.zstd`，
是**多帧** zstd 拼接 —— `zlib.zstdDecompressSync` 只解第一帧，必须按 magic `28 B5 2F FD` 切帧后逐帧解压（本工具两者都试，取解压长度更大的那个）。

### 5.6 v2（0.5.0）的验收数字

自动验收：`D:\environment\nodejs_link\node.exe --test "test/*.test.mjs"` ⇒ **149 tests / 149 pass / 0 fail / 0 skipped**，退出码 0
（0.4.0 的基线是 45；`SPEC.md` 里写的 45 pass 是那时的旧值，G6 的下限按本版是 ≥ 45，实际 149）。

**M2 行为重放**（真实会话，`tools/replay-log.mjs`）：

```
D:\deepseek-harness\sessions\--D-project--\session-78d93391-4f05-45d3-92a4-d5f92d362764\session.v4.jsonl.zstd
# 解压方式 multi-frame（帧数 2364，解压失败帧 0） / jsonl 行数 3916 / 可解析事件 3916（跳过坏行 0）
# B4 前缀作废: 17 次   →   bulk-injection×9 / compaction-start×4 / compaction-end×4
# O4 往返计数: step/start 566 次
# 最长工具窗口: pwsh 静默 50.4s（会话 +52m34s）
# 非日志派生（已排除，不作结论）: hookFaults 非空 0 次 / lastSpill 非 null 0 次
```

> ⚠️ 口径提醒：这条会话日志在会话进行中还在追加，所以"往返计数"是**随时间变化的读数** ——
> 早先一次复算读到 548，本次读到 566（行数 3916）。**引用时必须写清是哪一次读的**，不要把两个数字混用。
> 50.4s 小于默认 `noProgressMs`（90000ms），所以那个窗口**不该**带无进展告警，状态条只显示"执行工具(pwsh) 50.4s"。

**反向对照**（证明上面那个"0/0"不是检测器失效）：往运行时表里强制造脏后重跑，工具报
`# ✗ 重放被污染，不再是纯日志派生：hookFaults 有 1 次非空；lastSpill 非 null`，**退出码 1**。

G / U / O 逐条的映射（哪一条对应哪个用例、哪一条**未**验证）见 `docs/acceptance.md`。
**U3 至今未验证** —— 需要用户实机截图，见 §4.3 第 3 条。

---

## 7. 支柱 B1：按步降推理档（省算力）

### 7.1 一句话

**在"这一步明显不需要深想"的时候，把这一步的推理档降一档；一旦有写入或报错，立刻回到原来的档。**

它不是"把模型调笨"：原档从当前会话选定的模型配置里读，插件**只降不升**，也不碰 `agent-default-model`。

### 7.2 为什么必须做在 `agent/request` 而不是改配置

`cordis.patch.yml` 里调低 `agent-default-model.reasoningEffort` 是**全局一刀切** —— 实现和调试也会一起变笨，
而按步换挡才有意义。这正是任务书 §3 支柱 B1 说的"这是它存在的核心理由"。

### 7.3 ★ 唯一的落点（实读，非推测）

```ts
'agent/request'(this: Scoped<Agent>,
  payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
```

官方 summary 原文：**"Replace the frozen call configuration."** —— `await next()` 拿到本机本来要用的配置，
**返回一个替换品即换挡**。同一个 waterfall 里 **不能改消息**（那是 `agent/pre-step` 的事）。

树内先例 `dsh-agent\lib\types\model-selection.js:60-74` 显示官方插件自己也在改写 `reasoningEffort`。

> ⚠️ **必须 `{ prepend: true }` 注册。** 那个先例会把它自己选定的档位**重新写回** `reasoningEffort`。
> 如果本插件注册在它内层，降档就会被它覆盖掉 —— 表现为"代码跑了、日志没打、档位没变"。
> `test/b1-wiring.test.mjs` 把"只注册一次 + `prepend === true`"钉成了断言，防止以后有人手滑改成内层。

### 7.4 档位从哪来（不硬编码任何一个档位名）

```ts
ctx.llm.resolveModelInfo(provider, model, signal?) → LlmResolvedModelInfo
  .reasoning?: { efforts: readonly { id, name, description? }[]; defaultEffort? }
```

`efforts` 是**有序**数组。所有比较走 `indexOf`：

```
currentIdx < 0                      → 不动（连当前档都不在该模型公布的列表里，说明理解不完整）
floorIdx ≥ 0 → min(currentIdx, floorIdx)
floorIdx < 0 → max(0, currentIdx - 1)      // 该模型没公布 floor，就退化成"一档一档降"
targetIdx ≥ currentIdx              → 不动
```

**"只降不升"因此是结构保证，不是口头承诺** —— `test/gears.test.mjs` 里有一条
遍历所有 `current × floor` 组合的性质测试。

档位不能猜：`dsh-llm` 对不受支持的档位会抛 `UNSUPPORTED_REASONING_EFFORT`
（文案 `provider "…" model "…" does not support reasoning effort "…"`）。
`README.zh.md:102` 说元数据**按顺序**公开 `off`/`low`/`high`/`max` —— 那是描述、不是契约，
所以一个档位名都没写进代码。

### 7.5 判据，以及为什么它只认工具轨迹

自建一个按会话隔离的折叠器（`lib/gears.js`，纯函数、零 import），只吃 `session/event`：

| 事件 | 记什么 |
| --- | --- |
| `turn/start` | 清零本回合轨迹 |
| `step/start` | 开一个空步 |
| `tool/call` | `calls += 1`；工具名**不在只读白名单**里 → 该步 `readOnly = false` |
| `tool/result` | 带 `error` → 该步 `error = true` |
| `step/end` | 收进步窗口（最多 8 步） |

判据：从最近**已结束**的步往回数，连续的 `calls>0 && readOnly && !error`；
`calls===0` 的纯思考步**中性**（不计数也不打断）；碰到写入或报错立刻 `break`。
连续 `≥ minQuietSteps`（默认 2）才降档。

白名单默认值（**刻意保守**）：`read` `read_image` `glob` `grep` `list_dir` `search_context`
`web_search` `web_fetch` `cordis_inspect_list` `cordis_inspect_query`。
**不在表里 = 当作"可能写" = 打断降档**；`bash`/`pwsh`/`edit`/`write`/`sql_exec` 全部不在表里。
有一条测试专门断言这一点，防止以后有人"顺手"把 `bash` 加进去。

> 死路记录：`Session.toolHistory()` 返回的是 `ToolHistory = { tools: ToolSchema[], updates }`，
> 即**工具 schema 历史**而不是调用轨迹 —— 拿它判"这一步跑了什么工具"是错的，所以改为自己折叠事件。
> 轨迹**只在内存**（`Map<sessionId, rec>`），不持久化：它只是省算力的判据，不是正确性依赖，
> 折叠抛错时删掉该会话的轨迹并 warn 即可。

### 7.6 怎么看见它真的降了

两个独立证据，互为校验：

1. **日志**：每次降档打一条 info `B1 降档：<provider>/<model> <原档> → <新档>（连续 ≥N 步只读且无报错；出现写入或报错会立刻回原档）`。
2. **界面**：`request/header` 事件的 `header.config.reasoningEffort` 是**实际发出去**的档位。
   `lib/state.js` 把它记进投影，详情面板因此多出一行档位（0.19.2 起状态条不再重复它）。

第 2 条尤其重要：它是"真的降档了"的**权威来源**，而不是"我们以为我们降了"。
`test/state.test.mjs` 里有一条专门验证"档位变了必须产生新状态"（否则下游不会重绘，界面上就看不见换挡），
以及"同档位的重复请求头保持同一引用"。

### 7.7 故障方向

| 失败 | 行为 |
| --- | --- |
| `ctx.llm` 不在场 / 没有 `resolveModelInfo` | warn 一条，**A1 状态条不受影响**，B1 静默不启用 |
| `resolveModelInfo` 抛错（网络/未知模型） | 本步按**原档**执行 + warn，绝不因为插件而让请求失败 |
| 拿不到有序档位列表 / 拿不到当前档 | 原样返回 `resolved` |
| 判据层抛错 | 原样返回 + warn |
| 取不到会话 id（轨迹对不上） | 原样返回 + **只告一次** warn（`tracker 有 N 条轨迹`） |
| `downgrade: false` | **连 `llm` 都不 inject**（不依赖用不到的服务），0 个 handler |

### 7.7.1 ★ 会话 id 从哪里取（0.3.1 修掉的一个真缺陷）

第一版写的是 `payload.agent.session.id`。这在本机**运行时确实能跑**，但它是**未声明**的字段 ——
声明的接口是：

```ts
export interface Agent { readonly id: SessionId; }     // 只有 id
```

而 `@deepseek-ai/dsh-agent/lib/index.js:198` 用了 `agent.session.requestHeader()`、
`:512` 还有 `if (id !== agent.session.id) throw new Error('agent id "…" does not match session id "…"')`。

⇒ 运行时 `.session` 存在，且 **`agent.id === agent.session.id`**。
现在的取法：**优先用声明里的 `agent.id`**，拿不到才退到运行时的 `agent.session.id`，
两者都没有就放弃降档并告警一次。

为什么值得单独写一节：这个 bug 的表现形式是 **B1 全程安静地什么都不做** ——
没有异常、没有日志、状态条照常跳，只是档位永远不降。这正好是 §9 第 3 条要防的那类失败，
所以 `test/b1-wiring.test.mjs` 里有 4 条测试专门钉住"两种 agent 形状都能认 / 不一致时以 `agent.id` 为准 /
取不到必须告警 / 告警只出一次"。

### 7.8 配置

```yaml
config:
  downgrade: true          # 总开关。只有显式 false 才关；缺省/非法值都算开
  downgradeFloor: low      # 最多降到哪一档（按下标比较；模型没公布就退化为一档一档降）
  minQuietSteps: 2         # 连续几个"干净只读步"才降档
```

非法的 `floor`/`minQuietSteps`（空串、非数字、负数）一律回落默认值，绝不抛错。

---

## 8. 以后**不做**的事

- 不注册任何路由、不做反向代理、不发网络请求。
- **落盘只写自己的一处数据（B3 的唯一限定）**：dsh-status-turbo 自己**确实** import 了写 API ——
  `lib/index.js:58` `import { existsSync } from 'node:fs'`、`lib/index.js:59`
  `import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'`。
  但它只写一处**它自己的**数据：① 交接导出目录里的 `.gitignore`
  （`lib/index.js:538` `await run.io.writeFile(join(dir, '.gitignore'), HANDOFF_GITIGNORE)`，内容在 `lib/handoff.js:246`；
  0.9.2 起本 mount 内每目录只做一次，见 `lib/index.js:531` 的 P1-3）。
  这条路径只经插件自己的 `hostIo` 出口（`lib/index.js:436`）—— 不写配置文件、不写用户设置。
  B3 把"持久化超大工具结果"委派给宿主自带的 `spillStore` 服务（`ctx.get('spillStore').saveText(...)`），
  插件只把返回的 locator **原样呈现**（不相对化、不缩写、不加引号）—— 那条路径上插件不自己开文件。
  另外宿主默认把落盘根放在系统临时目录下（会随系统清理），所以**路径只在其有效期内可读**。
- 不改 `agent-default-model`、不改 compaction 配置、不改任何用户设置。
- 不改写 `exec.arguments`、不拦截工具、不做"没证据就再逼一步"。
- 不爬 DOM / React fiber。
- 不带样式表、不带构建步骤（`lib/` 即源码即产物）。
- **B1 只降不升**：绝不在任何情况下把档位调高，也绝不改用户选定的模型/提供方。

---

## 9. 支柱进度（0.5.0 结算）

**已交付**（细节见 §2.7–§2.10 与 §3.5）：

- **B4 缓存友好**：把"这次注入让前缀失效"变成状态条上的一行告警 + 详情面板的"前缀"分区。不改任何行为。
- **B3 结果瘦身**：`tools/post-execute` + 复用宿主的 `toolResultPruner.pruneContent`，**保留落盘绝对路径**；
  与 `spillThresholdBytes` 是 AND 关系，且**不自写截断**。
- **A2「最慢的 5 件事」**：数据源是**会话日志折叠**，不是宿主的 around 计时 —— 原建议的 `tools/execute` 计时被否决，
  那会读宿主内存、破坏"视图 = 日志的纯函数"这条底线。
- **C1 / C2 / C3**：四类模型上下文提示（少读一段 / 中文损坏 / 噪声淹没 / 缺证据），
  与 B3 共用**同一次** `tools/post-execute` 返回，**零新增往返**。
- **D（仅 `warn` 层）**：`onPostExecute` 里读完配置即返回；`nudge` / `stop` **必须显式配置**才可达。

**未开始 / 未完成**（不许当成已交付）：

- **B2 长工具后台化：BLOCKED**。不是"还没排上"，而是取证后判定**在本插件内没有落点**
  （`PreToolDecision` 不能替换结果、`tools/execute` 只许改 `exec.signal`、`ctx.jobs.start` 的唯一路径会新增往返）。
  完整取证见 `docs/plan-B2.md`；**本版没有为它写一行代码，也没有加任何配置键**。
- **D 的 `stuckRounds` 消费者**：backlog（`turn/end` 窗口在实现所在的那一层看不见，见 §4.3 第 2 条）。
- **A3 的自动干预**：未开始 —— `noProgressMs` 目前只用于**显示与告警**，不触发任何动作。

---

## 10. 0.6.0 内容层：wire v3 与「现在 / 活动流」

**一句话**：状态条还在原地，点开后**第一屏**就能回答「现在在干嘛 / 思考了什么 / 执行了什么」。
口径与 §0 完全一致：数据只来自**已折叠的会话事件**，不写盘、不轮询、不爬 DOM、不新增工具、不改发出去的请求。

### 10.1 wire 视图 v3：恰好 29 键

`TURBO_STATE_VERSION = 3`（`lib/state.js:23`），v1 的 19 键与 v2 的 9 键**逐字不变且仍在前面**，仅追加第 29 键：

| # | 键 | 语义 |
| --- | --- | --- |
| 29 | `activity` | 最近若干条活动的原始序列（**新的在尾部**，客户端自己 `slice().reverse()`）。元素是四种纯 JSON 之一：`{t, kind:'reason', text}` / `{t, kind:'call', name, args}` / `{t, kind:'result', ok, head}` / `{t, kind:'turnEnd', reason}` |

`toView` 的落点是 `lib/state.js:827`：`activity: Array.isArray(state.activity) ? state.activity : EMPTY_ACTIVITY`
—— **直出同一个数组引用**，满足 §2.2「视图未变时不重建」的契约（那条契约被下游的 `Object.is` 判定依赖）。

版本门同步升级：宿主 `v: 3`、客户端 `EXPECTED_V = 3`（`lib/client.js:73`；本节写于 0.6.0，当时是 `:70` —— `EXPECTED_V` 的常量位置随 0.9.x 改动下移，等式本身不变），
等式仍由 `test/ui-contract.test.mjs` 从源码正则取数两两比对（**不硬编码数字**）。

### 10.2 活动从哪来：只加在现有 4 个 case 里

**没有新增 `case`**（这是约束，不是巧合）：活动条目全部追加在 `applyEvent` 已有的四个分支里，
用的是与其它字段**同一个 `time`**：

| 事件 | 落点 | 条目 |
| --- | --- | --- |
| `assistant/message` | `lib/state.js:564` | 取 `data.message.content[]` 里第一条 `type === 'reasoning'` 的 `text`，截到 `reasoningChars` ⇒ `{t, kind:'reason', text}`（取文本的 `reasoningText` 在 `:379`，截断在 `:577`） |
| `tool/call` | `lib/state.js:583` | `{t, kind:'call', name, args: redactArgs(data.arguments, redactKeysOf(config))}`（条目在 `:602`） |
| `tool/result` | `lib/state.js:607` | `{t, kind:'result', ok: !data.error, head: firstLines(...)}`（条目在 `:620`），**仍然**照旧走 B4 的大块注入判定 |
| `turn/end` | `lib/state.js:658` | `{t, kind:'turnEnd', reason}`（`reason` 是对象就取 `.kind`，见 `turnEndReason` `:391`） |

**一个真缺陷（本版修掉）**：`lib/index.js:101` 原来是 `apply: (state, event) => applyEvent(state, event)`，
**没把合并后的配置传下去** —— 于是任何新活动 Config 在真实运行时都只会读到 `DEFAULT_CONFIG`。
现在改为 `applyEvent(state, event, effective)`。

### 10.3 环缓冲：双上限 + 「不关心即同引用」

`pushActivity(state, entry, config)`（`lib/state.js:365`）先追加再从头部淘汰，两个上限取**或**：
条数 `activityLimit`（`:76`，默认 24）与 UTF-8 总字节 `activityBytes`（`:78`，默认 8192，
逐条 `JSON.stringify` 后计长，见 `activityBytesOf` `:345`）。
**单条自身就超字节上限时至少保留最新一条** —— 否则用户永远看不到「刚刚发生了什么」。

硬约束在代码里的体现：

- **没追加就不换引用**：`assistant/message` 里如果没有 `type === 'reasoning'` 的块，就**直接 `return base`**，不调 `pushActivity`；
- 其余事件（`step/start`、`todo/write`、`approval/*`…）走原有的 `return state`**同一引用**分支。

### 10.4 脱敏：先脱敏，再上屏

`redactArgs(value, keys = DEFAULT_CONFIG.redactKeys)`（`lib/state.js:290`）递归拷贝一份纯 JSON：

- 命中 `redactKeys` 的键值换成 `'***'` —— **大小写不敏感 + 子串匹配**（`Authorization`、`user_apiKey`、`dsn_url` 都会中）；
- 深度上限 3（超过 ⇒ `'[Circular]'`）；字符串值截到 200 字符；
- 循环引用 ⇒ `'[Circular]'`；`undefined` / 函数 / symbol / bigint 各自降级；
- **绝不抛错** —— 投影是全库共享的热路径，一个脏参数不能打断 `drive`。

默认键表 11 个（`lib/state.js:84`，`Object.freeze`）：
`key` `token` `secret` `password` `passwd` `pwd` `authorization` `cookie` `dsn` `apikey` `credential`。
`redactKeys` 本身也进配置（§10.6），非法值一律回落默认（`redactKeysOf` `:339`）。

### 10.5 客户端：面板最上面两个新分区

`lib/client.js` 的 `detailBody`（`:958`）在 `sections` 数组**最前面**插入两个分区（即**在「本回合」之前**）：

- `nowSection`（`:883`）——「现在」：`pickLabel(phase)` · `已 {fmtElapsed}` · 有工具时 `· {工具名}`，单行；
- `activitySection`（`:942`）——「活动流」：`slice().reverse()` 后按 `HH:MM:SS  {标签}  {内容}` 成行；
  标签复用 DICT 的 `label.think` / `label.call` / `label.ok` / `label.fail` / `label.turnEnd`（`:913-924`），
  空列表时渲染一行 `empty.activity`（`:946`）。八条新文案键在 `lib/client.js:155-162`（zh）与 `:219-226`（en）。

配色**复用既有四色护栏**（§4.2，`test/ui-contract.test.mjs` 逐字守住）：思考行
`--dsw-alias-label-secondary` + 斜体；调用行 `MONO` 等宽；失败行（`ok === false`）`--dsw-alias-state-error-primary`。
所有值行都继承 `VALUE_ROW_STYLE`（带 `whiteSpace:'nowrap'` + `overflow:'hidden'`），内容 `userSelect:'text'` 可选中复制。

**明确不做**：活动流只读 `props.useProjection('turbo')`，不发起任何请求、不爬 DOM / fiber；因此
「活动流里有什么」永远等于「日志折叠出了什么」—— 与 §0 的底线一致。

### 10.6 Config 17 键（0.5.0 的 12 键 + 本版 5 键）

在 §2.10 的 12 键之上追加（默认值仍以 `lib/state.js · DEFAULT_CONFIG` 为唯一源，`cordis.patch.yml` 逐字镜像）：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `activityLimit` | `24` | 活动环缓冲最多几条 |
| `activityBytes` | `8192` | 活动环缓冲总字节上限（UTF-8） |
| `reasoningChars` | `400` | 单条思考截断到的字符数 |
| `resultHeadLines` | `6` | 工具结果 / 报错保留的首行数 |
| `redactKeys` | 11 键（见 §10.4） | 参数脱敏键；大小写不敏感 + 子串匹配 |

### 10.7 判据

`test/state.test.mjs` 增 12 例（环缓冲条数 / 字节各触发、单条超限保最新、脱敏命中 / 大小写 / 子串 / 嵌套 /
循环引用不炸、配置覆盖、reasoning 截断、`turn/end` 三种 reason、`activity` 引用稳定）；
`test/ui-contract.test.mjs` 增 3 例（两个新分区的位置与截断保护、活动流倒序与四类配色、空态文案）。
当前 **164 tests / 164 pass / 0 fail / 0 skipped**（0.5.0 基线 149）。

---

## 11. 0.6.1 口径修正：工具三分类 / 等待态

**一句话**：0.6.0 之前「最慢的工具」把**等子代理**和**等用户回答**也算成了「工具耗时」，
于是 `wait_agent`（超时 900s）与 `ask_user_question`（真实样本一次 18726648ms = 5.2h）长期霸榜，
把真正慢的命令挤了出去。0.6.1 不改任何计时口径（`ms` 仍然是相邻事件时间戳差，§3.4/§2.7），
只在**分类与呈现**上把等待类摘出去。

### 11.1 工具三分类：`toolKindOf(name, config)`

`lib/state.js` 新增导出纯函数 `toolKindOf(name, config)`，**只按工具名**判定：

- `humanWaitTools` 命中 ⇒ `'human'`；`subagentWaitTools` 命中 ⇒ `'subagent'`；否则 `'exec'`；
- 两者同时命中时 **human 优先**；`name` 不是字符串 ⇒ 一律 `'exec'`。

`DEFAULT_CONFIG`（§10.6 的 17 键之上）新增 2 键，`cordis.patch.yml` 逐字镜像：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `subagentWaitTools` | `['wait_agent']` | 判为「等子代理」的工具名 |
| `humanWaitTools` | `['ask_user_question']` | 判为「等用户」的工具名 |

**脏值容忍**（热路径，绝不抛错）：非数组 ⇒ 回落默认；数组里的非字符串/空串元素一律忽略；
**显式空数组 = 该类别不拦**（不回落默认）。判定结果随 `aggregateTool` 存进聚合条目的 `kind`。

### 11.2 wire v4：恰好 32 键，`topTools` 拆成两个数组

`TURBO_STATE_VERSION = 4`（`lib/state.js:23`），宿主 `v: 4` ↔ 客户端 `EXPECTED_V = 4`（`lib/client.js:73`；本节写于 0.6.1，当时是 `:70`），
v1/v2/v3 的 29 键**逐字不变且仍排在前面**，仅追加 3 键：

| # | 键 | 语义 |
| --- | --- | --- |
| 30 | `waitTools` | 只含 `kind !== 'exec'` 的前 5 条，元素 `{name,key,count,maxMs,avgMs,sumMs,kind}`（比 `topTools` 多 `sumMs` 与 `kind`） |
| 31 | `waitKind` | 当前是否卡在等待：`'subagent' \| 'human' \| null` |
| 32 | `subagents` | 本回合内派生的子代理数（`subagent/catalog` 计数，见 §11.4） |

**`topTools` 语义收窄**（0.6.1 的唯一破坏性变更）：只含 `kind === 'exec'`，排序与字段
（`maxMs` 降序 → `count` 降序 → `name` 升序取前 5，元素 `{name,key,count,maxMs,avgMs}`）完全不变。
`waitTools` 用**同一条排序**在 `kind !== 'exec'` 上独立取前 5。两者都沿用「元素一律新建」的契约
（客户端改视图绝不污染折叠状态）。`isWorseEntry` 与 `MAX_AGG_KEYS`（200）不变，`kind` 不参与淘汰。

### 11.3 `waitKind`：状态条上的等待态

`initState` 新增派生字段 `waitKind`（初始 `null`）：

- `case 'tool/call'` 用 `toolKindOf` 算出当次 `kind`，非 `exec` 写进 `waitKind`，`exec` 或 `name` 为空 ⇒ `null`；
- `case 'tool/result'`、`case 'turn/end'`、`case 'turn/start'` 一律置回 `null`；

客户端两处渲染点（状态条 `statusBody` 与详情面板 `nowSection`）都改：
`waitKind === 'human'` ⇒ 阶段文字换成 `⏸ 等你回答`，`'subagent'` ⇒ `⏳ 等子代理`，否则维持阶段名；
已耗时逻辑（`phaseStartedAt`）**保持不变**，只是等待态下补一个 `已` 前缀。

### 11.4 `subagents`：本回合派生了几个

新增 `case 'subagent/catalog'`：`subagents += 1`（**只做 +1，不猜载荷字段**），
`case 'turn/start'` 归零。该事件**可能压根不出现** —— 缺席时恒为 `0`，界面照常（优雅降级）。
`waitKind === 'subagent'` 且 `subagents > 0` 时，状态条追加 `· 本轮 N 个`。

### 11.5 客户端：「等待占用」分区

`lib/client.js` 新增 `waitToolsSection`，插在「最慢的工具」**之后**（`detailBody` 的基础分区
从 7 个变 8 个；带「最近瘦身」+「最近的故障」时共 10 个）：

- 每行：`{kind 文案} · {name} · {count} 次 · 累计 {fmtElapsed(sumMs)} · 最慢 {maxMs}ms`
  —— `kind === 'human'` 用「等你回答」，否则「等子代理」；行用 `MONO` 等宽；
- 空态：`empty.waitTools`（「本会话还没有等待类的工具调用」）；
- 同时把「最慢的工具」空态文案改为 `empty.noTools`（「本会话还没有真执行的工具调用」）；
- 全部走 `text()` / DICT（zh + en 各补齐 7 个新键），**不硬编码中文**。

### 11.6 Config 19 键与判据

`DEFAULT_CONFIG` 17 → **19 键**（+`subagentWaitTools`、+`humanWaitTools`），`cordis.patch.yml` 同步。
`test/state.test.mjs` 新增 5 例（分类判定纯函数 / 分桶与元素形状 / `waitTools` 独立 Top-5 /
`waitKind` 进入与清除 / `subagents` 计数与归零），并把 wire 契约断言从 29 键升到 32 键；
`test/halves.test.mjs` 的分区顺序断言升到 10 个分区，新增「等待占用」渲染与状态条等待态 2 例；
`test/ui-contract.test.mjs` 的快照升 v4（含 `waitTools` / `waitKind` / `subagents`）。
**已知偏离**：累计时长直接复用既有 `fmtElapsed`（`12s` 保留一位小数，未另造无小数格式）；`subagent/catalog` 只做 +1。

---

## 12. 0.6.3：时间中文化 / 第 4 类等待 / 最慢调用参数摘要

三件事在用户侧的诉求是同一条：**状态条与面板上的每一个数字都要能一眼读懂**。
0.6.2 之前 `fmtElapsed` 输出的是 `12s` / `15m00s` / `1h43m` 这类英文缩写，中文界面里
既不一致，也无法和旁边那条 5.2 小时的真实等待对上号。

### 12.1 `fmtElapsed`：全中文单位，秒一律向下取整

`lib/client.js · fmtElapsed` 重写为五档（输入 `ms`，非有限数或负数 ⇒ `null`，调用方自行兜底）：

- `ms < 1000` ⇒ `${Math.round(ms)}毫秒`（如 `820` ⇒ `820毫秒`）；
- `ms < 60000` ⇒ `${(ms / 1000).toFixed(1)}秒`，整数时去掉 `.0`（如 `1200` ⇒ `1.2秒`）；
- `ms < 3600000` ⇒ `${m}分${s}秒`（如 `900014` ⇒ `15分0秒`、`362351` ⇒ `6分2秒`）；
- `ms < 86400000` ⇒ `${h}小时${m}分${s}秒`（如 `18726648` ⇒ `5小时12分6秒`）；
- 否则 ⇒ `${d}天${h}小时${m}分`。

**已知偏离（必须记录）**：任务书写的是「秒四舍五入」，但同一份任务书的硬断言
`18726648 → 5小时12分6秒` 在四舍五入下会得到 `7秒`（18726648ms = 5h12m6.648s）。
**断言表优先**，分/时分支的秒**一律 `Math.floor(ms / 1000)`**，且先整除出 `totalSeconds`
再拆分，避免 `ms / 1000` 的小数误差漂进位。

同时把 `lib/client.js` 里**所有裸 `ms` 渲染点**清零（idle 行、投影缺席宽限期、宽限期
`console.error`、面板「最慢的工具」「等待占用」「上回合」各值行），一律走 `fmtElapsed`，
只有它返回 `null`（非法输入）时才回落到 `${Math.round(x)}毫秒`。

### 12.2 第 4 类等待：`job`（等后台任务）

`job_output` / `job_wait` 带 `{ wait: true }` 的调用是**等待**，不带 `wait` 的那次是
「取一次状态」的**真执行** —— 同一工具名两种语义，只能靠参数分辨。因此：

- `toolKindOf` 签名从 `(name, config)` 扩成 **`(name, args, config)`**（参数在第二位）；
  非字符串 `name` ⇒ `'exec'`；`args` 非对象 / `null` ⇒ 不可能命中 `job`（**绝不抛错**）；
  `jobWaitTools` 命中 **且** `args.wait === true`（严格布尔）⇒ `'job'`。
- `lib/state.js · tool/call` 调用点负责把线格式的 `data.arguments`（JSON **字符串**）解析成对象，
  解析放 `try/catch`；解析失败 ⇒ `args = null`。
- 分类结果自动流进 `waitTools`（`kind !== 'exec'` 的老口径没动），客户端补第 4 类文案
  `⏳ 等后台任务`，状态条等待态与 `nowSection` 同步。
- Config 新增 `jobWaitTools: Object.freeze(['job_output', 'job_wait'])`。

### 12.3 最慢调用的参数摘要（本次升级的核心）

「最慢的工具」过去只告诉你**哪个工具**慢，不告诉你**那次在跑什么** —— 而后者才是用户要的
诊断。新增纯函数 `summarizeArgs(args, config)`（`lib/state.js`，导出）：

1. 字符串先 `JSON.parse`（`try/catch`，失败 ⇒ `null`）；非对象 ⇒ `null`；
2. 复用既有 `redactArgs(value, config.redactKeys)` 整棵脱敏（**先脱敏，再上屏**）；
3. 按主键顺序 `command / cmd / CommandLine / file_path / path / pattern / sql / url / query / job_id / ids / name`
   取第一个命中，`previewText(scalarText(...))`（纯标量数组 `join(',')`）；
4. 都没有 ⇒ `previewText(stableJson(redacted))`（键排序，稳定）；
5. `previewText`：空白折叠、`trim` 后为空 ⇒ `null`，超过新常量 **`ARG_PREVIEW_MAX = 140`** 字符 ⇒
   截断并加 `…`。

`aggregateTool` 增加第 6 个参数 `argPreview`，条目变成
`{name, count, sumMs, maxMs, kind, argPreview}`；**首次非 null 即固定**（同一聚合键的
后来者不覆盖），且**不参与淘汰排序**（`isWorseEntry` / `MAX_AGG_KEYS` 一个字没改）。

wire 侧：`topTools` / `waitTools` 的每个元素各加 `argPreview: string | null` 与
`slow: boolean`（`= maxMs >= config.slowMs`，新配置键 **`slowMs: 60000`**）；`toView` 顶层
新增 `slowMs`（**这是唯一一处偏离任务书键清单的地方**：`v5 = 33 键`，任务书只列了 32 键 +
两个元素新字段；客户端的分区尾提示要把阈值用 `fmtElapsed` 打出来，wire 上没有别的字段带着它）。

客户端：值行末尾附 ` · {argPreview}`（`safeText`，空/null 不加后缀），`slow === true` 的行前加
`⚠ `；分区末尾**只有真出现慢行时**才 push 一句
`hint.slowTool`（zh：「超过 {n} 的调用可交给后台任务插件 run_command」，`{n} = fmtElapsed(slowMs)`），
把超时命令指向后台任务插件。

### 12.4 判据

- `test/state.test.mjs`：wire 契约 32 → **33 键**（`V5_VIEW_KEYS = ['slowMs']`，注释里的
  `v4 契约` 一并升 v5）；`toolKindOf` 既有 12 条用例全部改成 3 参形式，新增「第 4 类 job」
  两条反向用例与脏 `args` 用例；新增 `summarizeArgs` 纯函数例（主键优先 / 脱敏 / 截断 /
  脏输入不抛）与「`argPreview` 走完整管线 ⇒ `{"token":"***"}`」例；新增 `slow` 判定例。
- `test/halves.test.mjs`：`v: 4` → `v: 5`（12 处）；版本错配用例反向为「宿主 v4 ≠ 客户端 v5」；
  状态条耗时断言从 `/\d+\.\ds/` 改中文容错；面板格式断言改中文单位（`42000ms` ⇒ `42秒` 等）；
  新增「慢行 ⚠ + 摘要 + 提示」与「无慢行不给提示」2 例、状态条「等后台任务」1 例。
- `test/ui-contract.test.mjs`：快照构造 `wireV4` → **`wireV5`**（含 `slowMs`）。
- Config 19 → **21 键**（+`jobWaitTools`、+`slowMs`），`cordis.patch.yml` 逐字同步。

---

## 13. 0.6.4：可选能力缺席 ≠ 故障（wire v6）

### 13.1 问题：把「设计上的缺席」当成了故障

`lib/spill.js · spillOnce` 里 `store === null`（无 `spillStore` 后端）与 `pruner === null`
（无 `toolResultPruner`）两条，原先走的是 `degrade()`。`degrade()` 的语义是「降级并**如实上报一条故障**」，
于是这两条必然触发 `report(fault)` → 写进 `hookFaults` → 状态条与详情面板「最近的故障」**永久红字**。

但这两条读不到，恰恰是**设计**：preset（`presets/cordis.patch.yml:62-78`）用
`isolate: {toolResultPruner: true}` 把 `toolResultPruner` 关在 `cordis:group` 内，**组外永远读不到**。
DSH 官方先例（`packages/spill/spill-policy/src/index.ts:142-144`、
`packages/fs/tool-fs-search/src/search-core.ts:386-388`）的官方口径是
**`ctx.logger.warn` + 保持 inline，不报故障**。

### 13.2 判据：缺席 vs 真失败，两条路必须分开

- **缺席**（只有这两条）：`store === null` / `pruner === null` → 新增 `absent(ctx, message)`：
  只 `ctx.logger.warn`（整个包 `try/catch`）、不上报、不抛、返回 `null` 保持 inline。
- **真失败**（其余 6 条，仍走 `degrade()`）：`resolveStore` 抛错、`pruneContent` 抛错、
  `pruneContent` 返回非数组、`saveText` 抛错、locator 非绝对路径、无 session owner。
  这些是**真的没做成**，必须如实报故障。
- `absent()` 只 warn 一次：模块级 `const warnedAbsent = new Set()` 按消息文本去重，
  同进程内每种缺席原因只 warn 一次（不刷屏）。热路径异常一律吞。

### 13.3 wire v6：`enhancement` 描述增强层在位与否

- `lib/spill.js · enhancementOf(ctx)`：探测 `spillStore` / `toolResultPruner` 是否在位，
  返回 `{ active, reason }`；探测本身抛错时回落到「在位」（`{active:true, reason:null}`），绝不把探测失败当故障。
  `reason` 用与缺席一致的规范串（`no ctx.toolResultPruner loaded` / `no ctx.spillStore backend loaded`），
  只作为**机器可判别的键**，不上屏。
- `lib/state.js · pushEnhancement(sessionId, enhancement)`：写进模块级 per-session 运行时表
  （`runtimeEntry` 增 `enhancement: null` 槽），与 `pushHookFault` / `pushSpill` 同构。
  **不进 `initState` / `applyEvent`**（§3.8「不假装折叠」原样适用）。
- `toView` 末尾追加第 34 键 `enhancement`（v6），缺省 `{active:true, reason:null}`，纯 JSON、无 undefined。

### 13.4 客户端：灰色 info 行，不是红字

详情面板在「最近的故障」**上方**恒挂「工具增强」分区：`active` ⇒ 「已启用」；
缺席 ⇒ 「未启用 · <本地化理由>」。颜色用 `var(--dsw-alias-label-secondary)`（灰），
**不是** `--dsw-alias-state-error-primary`。`reason` 里的机器串一律经 `enhancementReason()` 映射成本地化文案，
**绝不原样上屏**——否则会命中 U7 黑名单 `/投影|projection|fiber|host|ctx|slot/i`。
**缺席绝不出现在 `recentFaults` / `hookFaults`。**

### 13.5 判据

- `test/spill.test.mjs`：新增 6 条中的 5 条（pruner 缺席 ⇒ null 且 onFault 未调 / 连续两次只 warn 一次 /
  `pruneContent` 抛 `boom` ⇒ onFault 且 message 含 boom / 返回非数组 ⇒ onFault / `spillStore` 缺席不报故障）；
  既有 5 条「缺席 ⇒ 上报故障 / 抛出」用例全部反向为「缺席 ⇒ 不报故障」。
- `test/state.test.mjs`：wire 契约 33 → **34 键**（`V6_VIEW_KEYS = ['enhancement']`，注释升 v6）；
  新增 `pushEnhancement` 用例（写入 / 跨会话隔离 / 脏入参归一 / 缺席不进 hookFaults / `clearSessionRuntime` 复位）；
  「不假装折叠」用例补 `enhancement` 键。
- `test/halves.test.mjs`：`v: 5` → `v: 6`（11 处）；版本错配反向为「宿主 v5 ≠ 客户端 v6」；
  分区顺序断言插入「工具增强」（有/无瘦身故障两套数组各一处）；新增面板契约用例（第 6 条）。
- `test/ui-contract.test.mjs`：快照构造 `wireV5` → **`wireV6`**（含 `enhancement`）；新增「工具增强」分区
  DOM 契约用例（灰 info / 截断保护 / 缺席不是故障 / 不泄漏机器串）。

---

## 14. 0.6.5：拿不到宿主 pruner 就用本地裁剪（wire v7）

### 14.1 问题：0.6.4 的「缺席」等于「永不工作」

0.6.4 判定 `toolResultPruner` 读不到 = 设计上的缺席，于是 `spillOnce` 直接 `return null`（保持 inline）。
这条判定**在线上永远为真**（`presets/cordis.patch.yml` 的 `isolate: {toolResultPruner: true}` 把服务关在
`cordis:group` 内，本插件不在那个组里，按设计读不到），于是「工具增强层」从 0.6.4 起**一次都没瘦身过**：
大结果既没落盘、也没给模型省下一个字节。缺的不是诊断，是**兜底**。

### 14.2 判据：宿主 pruner 优先，拿不到才本地裁剪

`lib/spill.js · spillOnce` 的瘦身一步改成两条路：

1. `resolvePruner(ctx) !== null` ⇒ 仍调 `pruner.pruneContent(content)`，与宿主的裁剪语义/预算保持一致
   （宿主预算 8192/4096/1024，随宿主版本演进，插件不猜）；
2. 拿不到 ⇒ 调本模块的纯函数 `localTrim(content, config)`。

`store === null`（没有落盘后端）**仍走 `absent(ctx, ABSENT_STORE)`**：本地裁剪也裁得出来，但**没地方落
完整原文**，那就宁可不裁（丢原文是唯一不可接受的结果）。删除 `ABSENT_PRUNER` 常量与那条分支，不留死代码。

### 14.3 `localTrim` 的五条契约

- **纯**：不改入参、返回新数组（最长块是新对象，其余块沿用原引用）；不碰时间；不抛。
- **只碰文本**：只处理 `{ type:'text', text }`，其它类型块原样保留同一引用（图片/附件**一个都不许丢**）。
- **只裁最长块**：`localTrimMinChars` 以下的正文原样返回 `null`（一次工具结果通常只有一个正文块）。
- **保头保尾**：头 `localTrimHeadChars` + 尾 `localTrimTailChars`，中间一行
  `\n…（此处省略 {n} 个字符）…\n`（`n` = 被省略的字符数）。
- **绝不凭空变长**：结果不短于原文 ⇒ 返回 `null`；三个配置项任一非法 ⇒ 返回 `null`（宁可不裁）。

三层配置联动：`spillThresholdBytes`（外层，UTF-8 字节，决定「要不要落盘」）→ 本地裁剪的
`localTrim*`（内层，字符，决定「给模型看多少」）。**完整原文永远走 `spillStore.saveText` 落盘**，
裁剪只影响给模型看的正文。Config 因此从 21 键增到 **24 键**（`DEFAULT_CONFIG` 与根 `cordis.patch.yml` 逐字镜像）。

### 14.4 wire v7：`enhancement` 加 `mode`（键数不变）

`lib/spill.js · enhancementOf(ctx)` 返回 `{ active, mode, reason }`，`mode` 三态：

- `'host-pruner'`：宿主 pruner 在位（`active: true`）；
- `'local-trim'`：只有本地裁剪（`active: true`）——**这是 0.6.5 的常态**；
- `'off'`：连落盘后端都没有（`active: false`，`reason = 'no ctx.spillStore backend loaded'`）。

wire 的 `enhancement` **只在该对象内加 `mode`，键名与键数（34）不动**，不删既有 `reason`——旧客户端读
`{active, reason}` 仍然工作（前向兼容地忽略 `mode`）。`lib/state.js · normalizeEnhancement` 把未知 `mode`
一律回落 `'host-pruner'`，wire 上不允许出现 `undefined`。

### 14.5 客户端：灰 info 行三态，仍未故障

详情面板「工具增强」一行（位置不变：最近瘦身之后、最近的故障之前）按 `mode` 显示
`已启用（宿主裁剪）` / `已启用（本地裁剪）` / `未启用 · 没有落盘后端`。三种都是
`--dsw-alias-label-secondary` 灰 info，**绝不变红、绝不进 `hookFaults`**；机器串
（`no ctx.spillStore backend loaded` 等）绝不原样上屏。`DICT` 中英各补 `enhancement.mode.host` /
`enhancement.mode.local` 两键。

### 14.6 版本与判据

`TURBO_STATE_VERSION` 6 → 7、`lib/client.js · EXPECTED_V` 6 → 7、`package.json · version` 0.6.4 → 0.6.5。
测试同步 `v:6` → `v:7`（halves 11 处 + ui-contract 快照构造 `wireV6`）、版本错配反向为
「宿主 v6 ≠ 客户端 v7」。**9 条新测例（真跑）**：① 无 pruner ⇒ 本地裁剪且 `onFault` 零调用；② 保头保尾 +
省略标记 + 入参不变；③ 非文本块不被丢；④ 短块不裁 ⇒ `null`；⑤ 不短于原文 ⇒ `null`；⑥ 宿主 pruner 优先；
⑦ `enhancement` 三态 `mode`；⑧ 面板「已启用（本地裁剪）」灰 info 行；⑨ 落盘仍走 `spillStore.saveText`
且 `locator` 是绝对路径。

---

## 15. 0.7.0 以后的演进

本节补 0.7.0 以后的设计意图与判据（0.6.5 及更早的逐版记录见 §10–§14，那些节里的键数是当时的实情，不是当前值）。当前值集中在 §15.5 与 §15.6。

### 15.1 0.7.0：交接文档自动导出

会话变长时把本会话导成 Markdown 交接文档（沿用 bili 的官方迁移路径）。判据是纯函数，进程与磁盘 I/O 全部由宿主注入，所以测试可以真跑判据而不真起进程、不写盘（`lib/handoff.js`）。

两条阈值取或：token 口径（`usage.inputTokens`，量的是 bili **压缩之后**要计费的上行输入）与字节口径（该会话模型可见的累计体量，`handoffExportBytes`）。两者**不是同一个口径**：bili preflight 拒发那一次没有上游响应、不产生 `usage` 事件，只有字节口径看得见它 —— 这也是 0.8.1 把字节口径降下来的原因（旧值 3000000 配旧节流 8000000，字节口径的第二次导出是死路）。

节流与新鲜度分工：`handoffExportMinDeltaTokens` / `handoffExportMinDeltaBytes` 管「涨够了才再导一次」；`handoffExportFreshMs` 只认新折叠进来的事件（挡冷启动重放）；`handoffExportRefreshBytes: 0` 表示一个车道最多一份文档；`handoffExportSubLanes` 默认 false，子车道不单独产文档。

命令探测只有两条兜底路径：`require.resolve('billion-context')` 的包根拼 `dist/index.js`，兜底拼 profile 下的 `node_modules/billion-context/dist/index.js`，两者都用 `process.execPath` 跑包内入口；显式 `handoffExportBiliBin` 是唯一正道（`lib/handoff.js:357` `resolveBili`）。`.bin/bili.CMD` 已弃用：CVE-2024-27980 之后 Node 拒绝无 shell 启动 `.cmd`，`spawn` 直接抛 `EINVAL`；两次事故与实证在 docs/review-0.7.0-handoff.md。

进程内上限 `handoffExportMaxPerProcess` 默认 64（0.7.5 从硬编码 8 抬高），用尽后记 `failed` 并只警告一次。

### 15.2 0.8.0 → 0.9.0：到量轮换与方案 B

0.8.0 先做成「宿主 armed、客户端 fork 旧会话」；0.8.1 补齐阈值判据与新鲜度，并确认「归档旧会话」与「`@` 引用」互斥（`rotationArchiveOld` 默认 false —— 归档后旧会话从同一份列表投影里消失，种子消息里的 `@<旧id>` 就失效）。

0.9.0 废掉 fork，改成方案 B：宿主建**空白**新会话并把旧会话 id 写进新会话的第一条 `user/message`，客户端只负责 `sessions.open` 切过去。理由（`lib/rotation-host.js:1-14`）：fork 把整份旧日志复制进新会话，既不减少上下文，也不改变「下一轮请求仍背着全部历史」，只是把积压换了个会话 id；方案 B 从零历史开始，唯一带过去的是旧会话 id（`rotationSeedMessage` 是唯一把 `{old}` 送进上下文的落点），需要细节时模型用 `@<旧id>` 回查。

宿主动作的契约（`lib/rotation-host.js:107` `runRotationAction`）：`armed` 必须带非空 `childId`（0.21.1 之前还带 `seedOk`，表示种子是否真的写入 —— 那一步已删）；其余情况收敛成 `idle` + 稳定 message code，**绝不抛**。本模块只做被注入的 I/O、不碰时间，判据全在 `lib/rotation.js:93` `shouldRotate`。

已知设计异味：轮换阈值与交接导出共用 `handoffExport*` 键名 —— `lib/rotation.js:20` 从 `./handoff.js` 引入 `effectiveThreshold` / `effectiveByteThreshold`（`lib/handoff.js:53` / `:76`），比例旋钮 `handoffExportWindowPercent` 也由两者共用；0.9.x 没有改名（审计 P1-10）。

### 15.3 0.9.1 / 0.9.2：默认自动、水位账跨重启

0.9.1 把 `rotation` 默认值从 `manual` 改成 `auto`，客户端在面板上给出可点的轮换行。

0.9.2 把 `rotationRequireIdle` 默认改成 false（建空白会话不打断正在跑的回合；旧行为的实测后果是从不空闲的会话一个也轮换不了）。

0.9.2 把水位账从进程内 Map 改成投影 state 里的 `ledger`（`lib/state.js:349` 槽位、`:1374` `ledgerOf`、`:1433` `writeLedger`、`:1450` 再水化）：只装只增不减的水位（`payloadBytes` / `headerBytes` / `payloadSeq` / `laneWatermarks`）与终态事实 `rotationChildId`，且**只进持久化 state、不进 wire 视图**（`lib/state.js:1364`）。归零的水位曾让重启后的会话重新越线（1.66 MB 对阈值 1.80 MB），而轮换与交接导出的节流都读这条账。

一条关键教训：账里**不能**放临态。0.9.2 曾把「正在导出（120 s 窗口）」这类进行中的状态写进账，而宿主对 `RUNNING` / `UNAVAILABLE` 的折叠直接 return ⇒ 一次异常会被跨进程永久化。

### 15.4 0.9.3：审计修复

客户端 auto 触发点：0.9.0–0.9.2 它写在详情面板某个分区的 effect 里，而详情面板默认收起（收起时整块 return null）⇒ 那三个版本里一次都没有自动切过。0.9.3 把触发点挂到常驻状态条上的 effect（`lib/client.js:1074-1079`，依赖含轮换状态与 `childId` / `at`），即使渲染返回 null 也照样执行。

轮换结果的本地记账 `rotationOutcomes`（`lib/client.js:2120`）落地后广播一次，`ready` / `failed` 行可点重试（`lib/client.js:1606` 走 `performRotation(snapshot, { force: true })`）；wire 里的 `childId` / `at` 一换就作废本地结果。

账收紧：只装单调水位与终态 `rotationChildId`，`handoff` / `rotation` 的 status 一律不进账（与 §15.3 末条呼应）。

文档侧：docs/packaging.md 与 docs/design-rotation.md 随 0.9.3 重写/刷新。

### 15.5 当前版本与判据

| 项 | 当前值 | 出处 |
| --- | --- | --- |
| wire 视图版本 | `v: 13` | `lib/state.js` `TURBO_STATE_VERSION`；`lib/client.js` `EXPECTED_V` 钉死同值，错配即红字拒读（顶层新增 `newSession`，见 §15.6） |
| wire 顶层键数 | 37 | 版本史：v1 19、v2 +9、v3 +1 `activity`、v4 +3、v5 +1、v6 +1、v8 +1 `handoff`、v9 +1 `rotation`、v13 +1 `newSession`；v7 与 v10 不在顶层加键（19+9+1+3+1+1+1+1+1 = 37） |
| 配置键数 | 48 | `lib/state.js` `DEFAULT_CONFIG`，与根目录 `cordis.patch.yml` 逐键同值（标量同值、复合键存在；`test/mirror.test.mjs` 守这条） |
| 测试条数 | 以现场 `node --test "test/*.test.mjs"` 的输出为准 | `test/` 与 `lib/` 同属实现面，本表不缓存数字 |

### 15.6 0.18.0：新会话话术卡与开场话术（wire v13；0.18.2 并入设置页）

会话到量换身时，新会话收到的第一条 `user/message` 来自 `rotationSeedMessage` 模板（§15.2）。0.18.0 把这段开场话术**摆到界面上**：给出可整段复制的开场话术（`<pre>`，可选中）、一个复制按钮（成功「已复制」，失败「复制失败，请手动选中」）、工作目录一行，以及「在新会话里粘贴这段文本」的提示。**0.18.2 改落点**：不再注册左侧栏 `sidebar.panellist` 入口，卡片直接追加在本插件设置页（`dsh-status-turbo.settings`）的配置表单下面 —— 宿主侧少了两次槽位注册，界面上也少一个要跟着页面 id 同步的按钮。

**为什么这么设计。** 方案 B 只把一个旧会话 id 送进新会话的上下文（§15.2），「接着做哪件事」必须由人讲清楚；把它做成一张可复制的卡片，既不用回去翻旧会话，也不必让新会话从零猜。

- **wire 侧**：顶层新增 `newSession`，值 `{ text, oldId, cwd }` —— `text` 由 `rotationSeedMessage` 模板拼出（`{old}` = 旧会话 id、`{cwd}` = 工作目录），`oldId` 与 `cwd` 是拼装时的两个输入。它是 v13 的最后一个顶层键，也是 37 键的最后一位；缺字段一律回落空串，wire 上不出现 `undefined`。
- **客户端侧**：`settings.section` 那一页的组件返回 `h('div', …, [h(ConfigSection, …), h(TurboNewSessionPage, …)])`；卡片是 root 作用域、没有会话绑定，用 `useSessions(state => state.current)` 取当前会话，再读 `state.byId[id]?.projectionValues?.turbo` —— 宿主已经把每个会话的投影值放进会话列表，**没有新订阅、没有 HTTP 路由、没有宿主 RPC**。`NewSessionPanelIcon` 仍导出（图标本身留着，只是不再往侧栏注册）。
- **复制**：优先 `navigator.clipboard.writeText`，拿不到或被拒时走 `<textarea>` 兜底，两条路都不抛；结果写成组件本地状态，再渲染一次就看得见。
- **三态分得清**：没有当前会话说「先在左侧选一个会话」；投影还没到说「等待该会话的投影」；宿主没报出话术文本时只给提示行，不给 `pre` 与复制按钮。**不把「还没到」说成「拿不到」。**
- **它不发起轮换**：自动轮换仍由宿主半完成（建一个空白新会话；0.21.1 起不再写任何消息，§15.2），这个页面只把话术摆出来给人复制。
- **0.21.0：给人看、给人复制，各补一刀。** ①设置页的组头与字段标签改走新函数 `textOf(text, key, hard)`（先 `DICT.zh[key]`、再硬编码兜底）。原来的 `text(\`settings.field.${key}\`, key)` 把兜底写成了**键名**，而 `makeText` 只在词典命中时采用词典值 ——「词典缺条目」于是直接漏成英文键名（截图里的 `handoffExportWindowPercent` / 分组头 `other`）。词典同期订正两条旧名（`rotationMode`→`rotation`、`archiveOld`→`rotationArchiveOld`）并补齐 16 条真键。②状态条折叠开关左边新增 `CopyBriefButton`，话术由纯函数 `sessionCopyTextOf(view, text)` 生成：`会话名称：…` / `会话 ID：…` / `会话日志目录：…` / `继续处理未完成的任务`，**空值整行省掉**。按钮始终渲染：最差（宿主不发 `newSession`）也只剩最后那句任务说明，而那正是交接要的一句。数据源：宿主在 `wire.view` 里补 `newSession.title`（`ctx.sessionTitle.get`，缺席给 `''`）与 `newSession.logDir`（`<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>`，与 `dsh-session-persistence-jsonl` 同一套规则；没有 cwd 给 `''`）。**wire 顶层键数不变（仍 37）** —— 只动了 `newSession` 的内部字段。
- **设置页仍只有一页**：插件的设置页按 `settingsScope` 绑自己的 Config（`configForms` 在场就绑条目，缺席就退回 `bind({ namespace })`），注入或绑定失败只让这一页显示不可用，不抛到 `apply`；0.18.2 起这一页同时承载配置表单与话术卡。

### 15.7 0.21.1：新会话不再被自动填进开场话术

用户原话：「还有就是，为什么每次开启一个新会话，都会出现这个？这个应该改成手动复制，请你把这个开启新会话 自动填充这个的去掉。」真因是 0.9.0 方案 B 的第二步：宿主建完空白子会话会再 `session.append('user/message', seedMessage({ id, text }), { surfaceOp: 'append' })`，把 `rotationSeedMessage` 渲染出的开场话术写成它的**第一条消息**（`lib/rotation-host.js · seedQuietly`），而 `rotationOpenChild: true` 又自动切过去 ⇒「每次开新会话都冒出同一段」。证据：插件数据目录 `rotation-trace.jsonl` 里 `outcome: 'armed'` 的 `childId` 去重 **32** 个（末条 10-15 19:57:53），装 0.20.0 重启后只剩 `idle` / `remind`。

0.21.1 删掉 `seedQuietly` 的两处调用与 `seedQuietly` / `seedMessage` 两个函数：建出来的会话**一个字都不写**。`rotationSeedText` / `rotationSeedMessage` 都还在，wire 的 `newSession.text` 也仍由它渲染 —— 那段文字的角色从「自动写进新会话」变成「给人复制」。连带收紧：轮换记录去掉 `seedOk`（`armed` 少一个字段，`seedText` 保留）、`lib/rotation.js` 去掉 `ROTATION_MESSAGE.SEED_FAILED`、客户端去掉 `seedNote` 与三条 `rotation.seed-*` 文案。wire 顶层仍 37 键、状态版本仍 13。

---

## 16. 0.6.0 之后仍不做（诚实声明）

- **B2 长工具后台化**：仍是 BLOCKED（§9），0.6.0 **没有为它写一行代码、没有加任何配置键**。
- **`stuckRounds` 的消费者**、**A3 的自动干预**：仍是 backlog（§9）。
- **活动流不落盘**：环缓冲只在内存里；会话重启后 `activity` 从空开始 —— 这是设计选择，不是缺口。
  它说的只是活动流。插件整体**确实**写盘，但只写它自己的一处数据（导出目录的 `.gitignore`），逐条见 §8 的限定（`lib/index.js:58-59` 就 import 了 `node:fs` / `node:fs/promises` 的读写 API）。
