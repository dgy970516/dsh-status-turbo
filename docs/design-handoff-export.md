# dsh-status-turbo · 交接文档自动导出（handoff export）设计稿

> **状态：已被取代 —— 本稿只作历史取证用，不要照它实现（0.9.3 标注）。**
>
> 四处已经与现状不符。改动都已在后续版本落地，**本文正文一律保持原样（不改写历史）**，此处只逐条挂出对照：
>
> 1. **配置键的默认值变了，表也从 6 个键长到 13 个。** 本稿提议的六个键里，`handoffExport`（`false` → **`true`**）、
>    `handoffExportTokens`（`400000` → **`240000`**）、`handoffExportMinDeltaTokens`（`100000` → **`60000`**）三个默认值已改；
>    `handoffExportDir`（`'handoff'`）、`handoffExportFull`（`false`）、`handoffExportBiliBin`（`''`）三个没变。
>    0.7.3/0.7.4/0.7.8 又加了七个键：`handoffExportWindowPercent`（`25`）、`handoffExportMaxPerProcess`（`64`）、
>    `handoffExportSubLanes`（`false`）、`handoffExportBytes`（`1800000`）、`handoffExportMinDeltaBytes`（`450000`）、
>    `handoffExportFreshMs`（`300000`）、`handoffExportRefreshBytes`（`0`）。**现行默认值的唯一来源是
>    `lib/state.js · DEFAULT_CONFIG`**；口径与理由见 `README.zh.md` 配置表与 `CHANGELOG.md · ## [0.7.3]`、`## [0.7.4]`、`## [0.7.8]`、`## [0.8.1]`。
> 2. **本稿那条「三级探测链」的论证已被推翻。** 二级探测 `requireResolve('billion-context/dist/index.js')` 实测必然抛
>    `ERR_PACKAGE_PATH_NOT_EXPORTED`（该包 `exports` 里没有 `./dist/index.js` —— `bin` 路径不受 `exports` 管辖），
>    改按包名解析拿到的又是 `dist/agent/dsh-native.js`（DSH 插件入口，不是 CLI）；三级探测的 `.bin/bili.CMD`
>    在 CVE-2024-27980 之后被 Node 拒绝启动（无 `shell: true` 时实测 `EINVAL`）⇒ **整条 shim 分支连同 `source: 'shim'` 已删除**，
>    两条探测路都改成「`process.execPath` + 包内 `dist/index.js`」，另加 `needsShell` / `quoteForShell` 让用户显式配的 `.cmd` 也能跑。
>    依据：`CHANGELOG.md · ## [0.7.1]` 的 P0-1/P0-2；现行实现见 `lib/handoff.js · packageRootOf` / `resolveBili`。
> 3. **本稿「明确不做：不自动切新会话」的结论已被 0.9.0 的方案 B 推翻。** 它给的理由（「界面上打开哪条会话是客户端状态，
>    宿主侧插件改不了」）本身成立，但绕法成立：**宿主建空白新会话并把旧会话 id 写进它首条 `user/message`，
>    再由客户端半调 `sessions.open(childId)`** ⇒ 自动切换在 0.9.0 落地，`rotation: 'auto'` 自 0.9.1 起是默认值。
>    边界仍然是「客户端只负责 `open`」，但「不切会话」已不再是设计边界。见 `docs/design-rotation.md` 与 `CHANGELOG.md · ## [0.9.0]`、`## [0.9.1]`。
> 4. **阈值口径已从「只看 token」扩成「token 与字节取或」**（`shouldExport`：字节口径才是能看见 bili fail-fast 那次的口径 ——
>    那次请求没有上游响应、也就不产生 usage 事件），另有跨重启的水位账 `ledger`（**不进 wire**，wire 仍是 v10 / 36 键）。
> 背景：bili 的 preflight 护栏按「单次请求核心文本」判死（`payload core text alone is ~17009319 bytes … vs the model window 1000000`），会话太长时连转发机会都没有。bili 官方给的迁移路径是 `bili export` 出 Markdown 交接文档（`billion-context\CONFIGURATION.zh-CN.md:1791`、`:2123-2132`）。本设计把这个动作自动化到本机插件里。

## 目标

在 `dsh-status-turbo` 里增加一个能力：**当会话的模型可见体量越过阈值时，自动调用 `bili export` 把当前会话导成一份 Markdown 交接文档，落到会话工作区**，并在状态面板里显示路径（可复制）。阈值有 **token 与字节两个口径，取或** —— 见下节与 `lib/handoff.js · shouldExport`。

**切换会话**：本稿 0.7.0 写的"不自动切新会话"已被 0.9.0 的方案 B 取代 —— 宿主建空白新会话、把旧会话 id 写进它首条 `user/message`，客户端半再 `sessions.open(childId)`；`rotation: 'auto'` 自 0.9.1 起是默认值。**交接导出这条线仍然只负责"把文档准备好"**，切换是轮换那条线的事（见 `docs/design-rotation.md`）。

## 为什么放在这个插件里

- 宿主半边**已经在消费 `usage`**：`lib/state.js:210` `const input = num(usage.inputTokens, 0) ?? 0`。⇒ 阈值信号已经在手上，**不需要新增数据源**。
- **`DEFAULT_CONFIG` 是默认值唯一真源**：`lib/state.js:43` `export const DEFAULT_CONFIG = Object.freeze({ ... })`；`lib/index.js:81-85` 负责与宿主 config 合并并整份下传。新配置键有既定归属。
- 面板 `lib/client.js` 已有「本回合 / 缓存与用量」分区，加一行「交接文档」是最小 UI 改动。

## 阈值口径（最关键的选择）

两个口径，**取或**（`lib/handoff.js · shouldExport`）：

- **token 口径**：`usage.inputTokens`（本回合要发出去的核心文本量）——不是消息条数，也不是日志文件大小。⚠️ 它量的是 **bili 压缩之后**的上行计费输入：bili 那次 fail-fast **根本没有上游响应、也就不产生 `usage` 事件**，所以这个口径**看不见**它。
- **字节口径**（0.7.4 起，P0-3）：按事件白名单（`user/message` / `assistant/message` / `tool/call` / `tool/result` + 最新 `request/header`）累加 `JSON.stringify(data)` 的 UTF-8 字节，用 bili 自己的换算常数 `7.5 bytes/token` 对齐 —— **这才是能看见 fail-fast 的口径**。

两者同时受 `handoffExportWindowPercent`（窗口百分比封顶，窗口取自会话日志的 `request/context`）约束。所有取值以 `lib/state.js · DEFAULT_CONFIG` 为准。

## 新增配置键

全部进 `lib/state.js` 的 `DEFAULT_CONFIG`，并**逐字镜像**到 `cordis.patch.yml`（插件的既有纪律）。

| 键 | 默认 | 含义 |
|---|---|---|
| `handoffExport` | `true` | 总开关（装上就工作；置 `false` 时真的什么都不做） |
| `handoffExportTokens` | `240000` | token 口径阈值（0.8.1 由 400000 下调） |
| `handoffExportMinDeltaTokens` | `60000` | 距上次导出又增长这么多才**再**导 |
| `handoffExportBytes` | `1800000` | 字节口径阈值（0.8.1 由 3000000 下调） |
| `handoffExportMinDeltaBytes` | `450000` | 字节口径的节流（0.8.1 由 8000000 下调 —— 旧值大于阈值，等于第二次导出永不可能） |
| `handoffExportWindowPercent` | `25` | 阈值的窗口百分比封顶 |
| `handoffExportDir` | `'handoff'` | 相对会话 cwd 的目录 |
| `handoffExportFull` | `false` | 是否带 `--full`（附每个块的原始消息；文档大很多） |
| `handoffExportBiliBin` | `''` | bili 可执行路径；空则走下面的探测链 |
| `handoffExportMaxPerProcess` | `64` | 本进程最多起多少次导出 |
| `handoffExportSubLanes` | `false` | 是否连该会话的子车道一起导出 |
| `handoffExportFreshMs` | `300000` | 只对新鲜事件触发（挡冷启动重放） |
| `handoffExportRefreshBytes` | `0` | 同一车道是否允许重复导出（`0` = 每车道最多 1 份） |
| `handoffExportTimeoutMs` | `120000` | 单次 `bili export` 的超时 |

上表的权威来源是 `lib/state.js · DEFAULT_CONFIG`（本表只是当时的快照）。

## 执行路径（实现里最需要小心的一点）

`bili` 是 `billion-context` 的 bin：`package.json` `"bin": {"bili": "./dist/index.js"}`，shim 在 `D:\deepseek-harness\profiles\desktop\node_modules\.bin\bili.CMD`（`bili` / `bili.CMD` / `bili.ps1` 都在）。

**不要依赖 PATH** —— 插件进程的 PATH 通常不含 profile 的 `.bin`。**0.7.1 起只剩两条**（`.bin/bili.CMD` 那条已弃用：Node 在 CVE-2024-27980 之后拒绝无 `shell: true` 启 `.cmd`/`.bat`，`spawn` 直接抛 `EINVAL`）：

1. `config.handoffExportBiliBin`（显式绝对路径，最稳）；指向 `.cmd`/`.bat` 时由 `needsShell` / `quoteForShell` 兜住；
2. `createRequire(import.meta.url).resolve('billion-context/dist/index.js')` —— 该包的 `exports` 不含这个子路径时会 `ERR_PACKAGE_PATH_NOT_EXPORTED`，于是用 `packageRootOf` 从包根拼 `dist/index.js`，一律用 `process.execPath` 跑它。

两条都失败 ⇒ **只 `logger.warn` 一次**、状态里记 `unavailable`，**不报故障** —— 沿用插件既有的"缺席不是故障"纪律（同 `lib/handoff.js` 的 `absent()` 分支）。

## 调用与产出

```bash
bili export <sessionId> [--full] --output <cwd>/<handoffExportDir>/handoff-<yyyyMMdd-HHmmss>.md
```

- `child_process.spawn`（**非阻塞**）+ 超时（建议 120 s）；`--full` 在大会话上可能跑几十秒。
- 成功：绝对路径写进插件状态 + `logger.info` 一次；面板显示「交接文档：<path>」+「复制路径」动作。
- 失败：`logger.warn` 一次 + 状态记 `failed`，**绝不影响回合**。
- 节流状态：`lastHandoffExportInputTokens` / `lastHandoffExportAt` / `lastHandoffExportPath` 存在既有状态对象里 —— 若 `TURBO_STATE_VERSION` 需要 +1（左右半片由 `EXPECTED_V === TURBO_STATE_VERSION` 版本门控），按既有做法同步。

## 三个可选增强（默认关）

1. **手动导出按钮**：面板加一个「立即导出交接文档」，走宿主的一个小命令。
2. **通知**：导出完成时发一条 —— 你装了 `@wingsky-1/dsh-notifier`，复用它的通知通道即可（不要自己再造一套）。
3. **路径入草稿**：导出后把 `@handoff/handoff-<ts>.md` 塞进输入框草稿，新会话里直接回车就能引用（纯客户端行为，不产生会话事件）。

## 测试与发布（按既有纪律）

- `test/state.test.mjs`：阈值判定、节流（不满足 delta 不再导）、脏配置回落 `DEFAULT_CONFIG`。
- `test/hooks.test.mjs`：探测失败只 warn 一次、状态记 `unavailable`。
- 另加一条：`handoffExport: false` 时**完全不 spawn**（默认关必须真的不做事）。
- `npm test` 全绿 → `npm pack` → 拷进 `D:\deepseek-harness\profiles\desktop\.plugin-specs\` → `plugin_manager install_bundle`（回执 `restart-required` 才算宿主半真的换掉）。
- 版本 `0.6.5 → 0.7.0`；`CHANGELOG.md` / `README.zh.md` / `cordis.patch.yml` 同步。

## 需要你定的三件事

1. 阈值默认 **400000**（窗口 1M 的 40%）行不行？
2. 默认 `--full` **关**（只导块摘要）—— 同意吗？
3. 导出目录默认 **`handoff/`**（相对会话工作区）—— 可以吗？
