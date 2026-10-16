# dsh-status-turbo 升级路线（0.9.2 之后）

按「现在就能落地 × 投入产出比」排。每条给出证据落点；没有落点的想法标「待验证」。

## 1. B2：长命令后台化 —— 集成目标现在存在了
- `README.zh.md:243` 当时写「集成目标在本机不存在（没有 `dsh-plugin-background-tasks`）」。
- **现已安装**：`D:\deepseek-harness\profiles\desktop\node_modules\dsh-plugin-background-tasks`
  （描述：*Seam-aligned background command execution … `run_command` via `ctx.shell` under the session*）。
- 三条接续排查点见 `docs/plan-B2.md`。README 的告诫仍然成立：`PreToolDecision` 没有「替换结果」的分支
  ⇒ 后台化要靠那个插件自己的工具面，而不是拦住原调用。

## 2. 设置卡片（产品化的第一步）
- 现状：改配置只能改**包内** `cordis.patch.yml` 再重启（`README.zh.md:271`）—— 对使用者是悬崖。
- 路子（专家已给，含 API 形状）：`ctx.settings.register(ns, schema, { base })`；**只注册宿主 namespace 不会自动生成表单**，
  必须自己写 keyed `settings.plugin.item` 卡片（key = namespace，缺 key 会 throw）。
- 暴露面：`profile: relaxed|standard|aggressive` + `rotation` + `handoffExport` + `stuckAction` +
  `handoffExportDir` + `downgrade`；11 个数字键藏起来。
- 不变量：`redactKeys` **不可**做成可编辑项；配置**绝不进 wire**（投影读冻结快照、决策读活值）。
- **状态（截至 0.9.3）**：未做 —— 仍是待办；配置目前只能改**包内** `cordis.patch.yml` 再完全重启。

## 3. 把交接文档正文喂进新会话（现在只给了 `@旧id`）
- 现状（**0.21.1 起要重新判断载具**）：新会话**不再有任何首条消息** —— 那句 `rotationSeedMessage` 模板已不再自动写入，开场话术改由人从状态条 / 设置页复制粘贴。所以「自动把文档路径塞进种子」现在**没有落点**了，要么渲染进话术卡那段可复制文本，要么让宿主可配置地重新长出一条「写首条消息」的路径
  ⇒ 模型还得自己发起一次昂贵的读取。
- 插件已经在写 `<cwd>\handoff\handoff-<会话id>-<桶号>-<时间戳>.md`。升级方向：种子带**文档路径**（低成本）
  或**前 N KB 摘要**（高价值；注意别让新会话一开局就顶到 bili 的熔断线）。
- **状态（截至 0.21.1）**：未做，且 0.21.1 删掉了「自动写首条消息」这一步（见上），这条升级方向要先重做载具判断。

## 4. 早于 bili 的熔断预警
- 插件已持有模型可见字节账（`payloadBytes`）与会话窗口（日志里的 `request/context`）。
- bili 的 preflight 是 **fail-fast**：`payload core text` 装不下任何窗口就 502、**不转发** —— 用户侧表现为「突然不能干了」。
- 升级方向：把「距拒发线还有多少」做成状态条一格（同一口径：bili 自己的 7.5 bytes/token），越线前变色。

## 5. 补完 D（卡死自愈）
- `README.zh.md:236` 自认的缺口：`stuckRounds` **没有消费者**，D 只做到 warn 层。
- 要么接上判据，要么删掉这个键 —— 留一个不生效的旋钮比没有更坏。

## 6. 子会话体量进父判据
- 实测现场：`session-529bd4c9-…|sub:af70c2f22f3c256d` 已被 bili 催（`usage=77% (742055/967232)`）却 `blocks=0`，
  而父车道的轮换/导出判据看不见子会话的体量。
- 升级方向：把子会话的 `usage` / 字节计入**父会话**的判据（`handoffExportSubLanes` 只管导出，不管判据）。
- 处置纪律：**不要清子车道状态**（丢 blocks + 前缀缓存 ⇒ 全额冷 prefill）。

## 7. 按工具的超时守卫（把「显示」升级成「动作」）
- 官方参考实现：`D:\deepseek-harness\packages\guard\timeout-policy`（`@deepseek-ai/dsh-tool-call-timeout-policy`）——
  单个 `tools/execute` 环绕分发监听器，在 `exec.signal` 上设单次调用截止时间，超时返回结构化 `TOOL_TIMEOUT`；
  **零配置**（读工具自己声明的 `ToolDefinition.timeoutMs`）。
- 插件已经在记每个工具的耗时分布（「最慢的工具」/「等待占用」两格）⇒ 同一份数据可以反过来给慢工具挂 deadline；
  更轻的做法是只给建议、不改行为。

## 8. 上架
- 需要公开 GitHub 仓库 + topic `dsh-plugin` + 至少 1 天，然后往 `awesome-dsh-plugin` 的
  `data/plugins/<owner>__dsh-status-turbo.yml` 加一条。

## 9. 文档债
- `docs/design-rotation.md` 的刷新：**0.9.3 已做**（顶部已有定案横幅与旧表勘误，不再是 0.8.0 `fork` 时代的旧稿）。
- 0.9.0 方案 B 的设计文档：**0.9.3 已补** —— `docs/design.md · §15.2`（宿主 `create` + 种子 + 客户端只 `open`，含废 `fork` 的理由）。
- `docs/design.md` 同步到 0.9.x：**已做** —— `docs/design.md · §15`（0.7–0.9 的演进）与 §15.5 当前版本表（wire v10 / 36 键 / `DEFAULT_CONFIG` 44 键）。

## 明确不做 / 不做更好
- 不拆包（专家结论）。
- 不把 `redactKeys` 做成可编辑项。
- 不把配置塞进 wire 视图。
