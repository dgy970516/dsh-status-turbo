# 支柱 B「省算力 / 省掉没必要操作」实施方案

> 对应用户诉求（m00985 第 2 条）与任务书 `D:\project\AI提速插件-开发任务书.md` §3 支柱 B（:194）。
> 本文区分 **已验证**（本机会话实读代码/契约）与 **推测**（待实现时确认）。
>
> **截至 0.9.3 的状态（后补）**：本文是方案稿，四条子能力的落地现状 —— **B1**（按步降档：`downgrade` / `downgradeFloor` / `minQuietSteps`）已实现并有测试；**B3**（结果瘦身：`spillThresholdBytes` 等）已实现；**B4**（缓存前缀失效可见：`bulkInjectionBytes`，wire `prefixEpoch` / `prefixCause`）已实现；**B2**（长工具后台化）**未实现、登记 BLOCKED**（取证见 `docs/plan-B2.md`，缺口见 `docs/acceptance.md · §7`）。§1 表的「建议默认」里只有 B2 一行仍是待办。

## 0. 一句话

支柱 B 是"做得快"，四条子能力按收益排序：**B1 按步降推理档 → B3 结果瘦身 → B2 长工具后台化 → B4 缓存前缀失效告警**。
其中 B1 是任务书点名的"最高优先级、收益最大"，且本机已找到**可照抄的树内实现范式**（见 §2）。

## 1. 四条子能力的收益 / 风险 / 默认值

| 编号 | 做什么 | 省什么 | 风险 | 建议默认 |
| --- | --- | --- | --- | --- |
| **B1** | 按"这一步在干什么"自动调低推理档，**只降不升** | 真金白银的算力：纯读取/机械执行的步骤不再按 high 跑 thinking | 中：判据错了会让实现/调试变笨 | **开**（但必须有"一次报错立刻回原档"+ 全局开关） |
| **B3** | 超大工具结果先落盘，只回「摘要 + 头尾各 N 行 + 落盘绝对路径」 | 每步 input token，间接提速 | 中：截断掉了关键信息 | 开（阈值保守，如 >32KB 才动，且**必留路径**） |
| **B2** | 长跑命令不再同步等，转后台 job 立刻把 id 还给模型 | 墙钟时间，不省 token | 中高：改的是工具语义，可能打乱模型节奏 | 先只观测 + 白名单，后开 |
| **B4** | 检测并显示"刚才那次注入/压缩让缓存前缀失效" | 不省，**只是把不可见成本变可见** | 无（不改任何行为） | 开 |

## 2. ★ B1 已验证可行性（决定性证据）

**(a) `agent/request` 是 waterfall，且官方定位就是"替换冻结的调用配置"** —— 实读 `@deepseek-ai/dsh-tool-cordis\lib\types\api-catalog.js`：

```
'agent/request'(this: Scoped<Agent>,
  payload: { agent: Agent; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
```
> summary: **"Replace the frozen call configuration."**
> description: "`await next()` yields the config the machine would use (agent options on the first request, the logged header afterwards); **return a replacement to switch**." … "this waterfall **cannot mutate messages**."

⇒ "`await next()` 拿到原配置 → 返回改过的配置"就是官方设计的用法。**不改 messages** 也正合 B1 的需要（换挡不碰对话内容）。

**(b) 树内有逐字同形的先例** —— 实读 `@deepseek-ai/dsh-agent\lib\types\model-selection.js:60-74`（该包自己的模型选择插件）：

```js
const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
    return { ...withoutInheritedEffort, provider: selected.provider, model: selected.model,
             ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort } };
});
```

⇒ **改写 `reasoningEffort` 是被官方插件自己使用的受支持路径**（连"先摘掉继承值再放新值"的写法都能照抄）。**已验证，非推测。**

**(c) 档位不能硬编码，必须问模型目录** —— 实读 `dsh-llm` 报错文案：

```
provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"     // UNSUPPORTED_REASONING_EFFORT
if (!reasoning.efforts.some((effort) => effort.id === effective)) throw …
```
> `README.zh.md:102`：「当部署策略允许 thinking 时，确切模型元数据会**按顺序**公开 `off`、`low`、`high` 与 `max` 强度及选择指引。」
> `index.js:452`：`const OFF_REASONING_EFFORT = ReasoningEffortId("off")`

⇒ 每个模型自带一个**有序** `reasoning.efforts: [{id, …}]` 列表，且传不受支持的值会**抛 LlmError**。
**结论：目标档位只能从该模型自己公布的列表里挑**（按下标比较），绝不能写死 `'low'`/`'high'`。
这样"只降不升"就是**结构上成立**的：`target = list[min(currentIndex, capIndex)]`。

**已定论（0.3.0 实现并测过，非推测）**：服务入口是 `ctx.llm.resolveModelInfo(provider, model, signal?)`
（`dsh-tool-cordis\lib\types\api-catalog.js:1369`，`key: 'llm'` 在 `:1297`），返回 `LlmResolvedModelInfo`，
其 `.reasoning: { efforts: readonly {id,name,description?}[], defaultEffort? }` **就是那个有序列表**。
`efforts[].id` 的顺序即强度顺序；所有比较一律走 `indexOf`，一个档位名都没写死。
当前档取 `resolved.reasoningEffort`，缺失时退到 `reasoning.defaultEffort`；两个都拿不到就原样返回。
`test/gears.test.mjs` 里有一条**遍历所有 current×floor 组合**的性质测试，断言结果
"要么 `null`、要么下标严格更小"，把"只降不升"钉成了结构保证而不是口头约定。

## 3. B1 的换挡判据（任务书 §3 原文的落地）

| 这一步在干什么 | 怎么判（**只用会话日志/工具轨迹，绝不猜用户的话**） | 目标档 |
| --- | --- | --- |
| 纯读取 / 列举 / 检索 | 上一步及本步只出现 `read`/`glob`/`grep` 类只读工具，且无报错 | 列表最低档（`off` 若有） |
| 机械执行 | `bash` 跑命令、跑测试、格式化、搬文件 | 低档（`low`） |
| 首次实现 / 调试失败 / 设计取舍 / 代码评审 / 写规格 | 出现写入类工具、或上一步是错误、或用户消息带"设计/评审/规格"语境 | **保持原档** |
| 上一步报错且本步在纠错 | 上一步 `tool/result` 带 `error` | **保持原档** |

**起步规则（保守，先证明有效再放宽）**：
1. **连续 ≥2 步**满足「只有只读工具 + 没有报错」→ 才降档；
2. 一旦出现**报错**或**写入类工具** → **立刻回原档**（下一请求就回，不等回合结束）；
3. 原档从 `agentDefaultModel.currentSelection()` 读，**只降不升**；
4. 取不到有序档位列表 / 取不到原档 → **原样返回 `resolved`**（绝不让插件成为故障源）。

## 4. 为什么不在 `cordis.patch.yml` 里直接调低 `reasoningEffort`

任务书原文（§3 支柱 B）：那是**全局一刀切**——实现和调试会一起变笨。插件要的是**按步换挡**，"这是它存在的核心理由"。
且 §7 红线里已明确不做"没证据就再逼一步"，也不动 `compaction-basic.auto`；本方案同样不碰它们。

## 5. 必须有的"失败可见性"（§9#3 不许静默 return）

- 判据函数任何异常 → 记一条日志（`[dsh-status-turbo] 换挡判据异常，本步按原档执行：<err>`）并返回原配置；
- **每次换挡都在状态条上留痕**：阶段名旁追加一个档位 chip，如 `执行工具(bash) · 档位 low↓`，让人一眼看出"现在被降档了"；
- 提供 `downgrade: true|false` 全局开关（默认开）与 `downgradeFloor: 'off'|'low'`（默认 `low`，即**默认不关 thinking**，更保守）。

## 6. 验收（对齐任务书 §6，逐条要能跑出数字）

1. **纯读步骤降档**：构造连续 3 步只读工具轨迹 → 第 3 步的 `LlmCallConfig.reasoningEffort` 下标 **严格小于** 原档；把数字打出来。
2. **写入/报错立刻回原档**：紧接一个写入工具或一个报错结果 → 下一步 effort **等于**原档。
3. **只降不升**：把原档设为最低档，跑任意轨迹 → effort **永远等于**最低档（绝不升高）。
4. **不支持时原样返回**：对没有 `reasoning.efforts` 的 provider/model → 返回对象与原对象**深度相等**。
5. **异常不致命**：注入一个抛错的判据 → 仍返回原配置，且日志里能找到那一行。
6. **可见性**：状态条在降档期间显示档位 chip；关闭 `downgrade` 后 chip 消失且 effort 不再变。

## 7. 交付顺序建议

**B1 → B4 → B3 → B2**。
B1 收益最大且已证明可做；B4 零行为变更、最容易做对；B3/B2 改的是工具返回语义，放后面并配更保守的默认值。

## 8. 明确不做

- 不在 `cordis.patch.yml` 里静态调低 `agent-default-model.reasoningEffort`；
- 不猜用户自然语言（判据只来自工具轨迹与会话日志）；
- 不做"没证据就再逼一步"（那是 `dsh-plugin-stalegreen` 的做法，任务书 §7 明确禁止）；
- 不动 `compaction-basic.auto`（task book §7 红线）；
- 不引入构建步骤（保持零构建：无样式表、无 esbuild）。
