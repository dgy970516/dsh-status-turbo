# dsh-status-turbo 0.7.0「交接文档自动导出」复查

> 依据：`lib/handoff.js` / `lib/state.js` / `lib/index.js` / `lib/client.js` 的实读 + 两个可复现探针
> （`D:\project\.tmp-sess\probe-handoff-risks.mjs`）。**带「实证」的条目是跑出来的，不是推的。**
>
> **状态（截至 0.7.4）：本文件列出的 P0 / P1 / P2 全部已修复** ——
> `[0.7.1]` 探测链换代 · `[0.7.2]` 水位桶幂等 + `.gitignore` + idle 守卫 + `unavailable` 语义 ·
> `[0.7.3]` 上限可配 + 窗口比例阈值 + `planHandoff` 可测 + 子车道一起导 + 保留 stderr ·
> `[0.7.4]` **P0-3 补齐字节口径**（token 与字节**取或**；字节账按 `seq` 幂等 ⇒ 可重放）+ **每车道各自的水位**（残余）。
> 两条关键修法的依据都来自实读：子车道的 `label` 与主车道**同为会话 id**（所以不必猜 bili 的命名空间哈希）；
> `require.resolve('billion-context')` 给的是 `dist/agent/dsh-native.js`，而 `dist/index.js` 不在该包 `exports` 里。
> **仍在的口径性质**：token 口径本身量的是 bili **压缩之后**的计费输入，单靠它看不见 fail-fast 那条路径 ——
> 这正是 0.7.4 加字节口径的原因；两个口径**取或**之后，那条路径由字节口径兜住。
>
> **补记（0.9.3）**：上面那句「全部已修复」**有一条例外** —— **P1-5**（`noteHandoff` / `profileDirOf` / `stampOf` 零测试覆盖）在 0.7.4 时**仍然成立**，直到 **0.9.3 才补齐**（交接导出的执行编排现在有真跑的用例：`test/handoff-orchestration.test.mjs`）。本条只作补记，下面的历史结论与 P1 表原文不改。

## P0 —— 不修就等于没装

### P0-1 二级探测的 spec 写错，必然抛错（实证）

```
resolve OK     billion-context                    -> …\node_modules\billion-context\dist\agent\dsh-native.js
resolve FAIL   billion-context/dist/index.js      -> ERR_PACKAGE_PATH_NOT_EXPORTED
resolve FAIL   billion-context/package.json       -> ERR_PACKAGE_PATH_NOT_EXPORTED
```

`billion-context` 的 `exports` 只有 `.` / `./server` / `./dsh` / `./dsh/package.json` / `./client` ——
**没有 `./dist/index.js`**。而 `bin: {"bili": "./dist/index.js"}` 是 bin 路径，不受 `exports` 管辖。
⇒ `lib/handoff.js · resolveBili` 的二级分支每次都抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，被 catch 掉，
等于**这一级不存在**。

**顺带一个更隐蔽的坑**：`require.resolve('billion-context')` 解析到的是 **`dist/agent/dsh-native.js`**（DSH 插件入口），
**不是 CLI `dist/index.js`**。所以"用包名解析"这条路即使不抛错也会拿到错的文件。

**修法**：二级/三级都改成**按包目录拼**——
`join(profileDir, 'node_modules', 'billion-context', 'dist', 'index.js')` + `process.execPath`（用 `exists` 探测）。

### P0-2 三级探测的目标是 `.CMD`，Node 不许直接 spawn（实证）

```
spawn 目标是否存在: true
spawn .CMD（无 shell）THREW  EINVAL
```

Node 在 CVE-2024-27980 之后**拒绝在没有 `shell: true` 时启动 `.bat` / `.cmd`**。
`.bin\bili.CMD` 恰恰是这种文件 ⇒ `runExport` 会走 `spawn` 抛错分支，结算成 `failed`。

**两个 P0 叠加的后果**：默认配置（`handoffExportBiliBin: ''`）+ 一级没配 ⇒ 一级空、二级抛错、三级抛 EINVAL
⇒ **装上后一个交接文档也产不出来**，面板会显示「导出失败 · exit unknown」。

**修法**：三级也改成「包目录 + `process.execPath`」；`.CMD` shim 若保留，只作为**最后**兜底并显式
`shell: true`（注意：`shell: true` 下 Node 只是把 argv 用空格拼起来，**路径带空格就会碎**）。

### P0-3（设计层）阈值信号量错了东西：它看不见要防的那个失败

判据用的是 `usage.inputTokens`。但在 bili 这条链路上：

- 这个数是 **bili 压缩之后**发往上游的计费输入 —— 本会话实测 `~10.7 万 token`，而它的原始日志是 **18.6 MB**；
  bili 自己的 `ctx~75485` 也说明它把上行压得很小。
- 而炸掉的那次请求 **`bili` 直接 fail-fast 502**，**根本没有上游响应，也就没有 usage 事件**。

⇒ 两层都错位：**正常会话永远到不了 40 万**（信号被压缩掉了），**炸掉的会话根本产生不了这个信号**。
也就是说：**这条判据在它本该生效的场景里不会触发。**

**修法（三选一，建议第二条）**：
1. 阈值改「原始累积体量」：插件在折叠时累加每条 model-visible 事件的 UTF-8 字节数（它本来就逐事件过手）。
2. 阈值改**会话日志文件大小**（`statSync(sessionLog).size`）——最便宜，且与 bili 的字节口径同族
   （bili 那条护栏就是按字节判的：`~7.5 bytes/token`）。
3. 直接读 bili 的每车道 `ctx~`（`bili export` / 它的状态目录），最准，但引入对 bili 内部结构的依赖。

## P1 —— 会咬人但不是即时致命

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| P1-1 | `MAX_HANDOFF_EXPORTS = 8` 是**进程级、只增不减** | 跑满 8 次后本进程内永久静默（直到重启），且用户无从得知 | 改成配置键，或在面板显示"已达上限" |
| P1-2 | 节流记忆只在**内存**运行时表里 | 每次重启后第一条越阈值的事件都会**再导一次**（文件名带时间戳 ⇒ 同一会话多份文档） | 落盘一份节流水位，或导出前先看目录里有没有该会话的文档 |
| P1-3 | `noteHandoff` 挂在投影 `apply` 上，**冷启动重放也会跑** | 开机重放会把历史长会话也判一遍 → 可能**替旧会话**生成交接文档（被 8 次上限兜住） | 只在"活会话"上判：例如校验 `state.phase !== IDLE` 或要求该会话是当前活动会话 |
| P1-4 | 阈值是**绝对** token 数（400000） | 换到窗口更小的模型时，模型早就到极限了，该阈值却永远够不着 | 阈值用**窗口比例**：`ctx.llm.resolveModelInfo` 在 `registerGears` 里已经拿到了 |
| P1-5 | `noteHandoff` / `profileDirOf` / `stampOf` **零测试覆盖**（未导出） | 212 条绿**不能**证明触发链真的会跑 —— 而 P0-1/P0-2 正是"测试全绿但线上跑不通"的例子 | 把这三者抽成可注入的纯函数并补测 |
| P1-6 | 同一秒内两次导出 ⇒ **文件名相同、互相覆盖** | 极端情况下丢文档 | 文件名加序号或毫秒 |
| P1-7 | 交接文档落在**用户工作区**里 | 内容含模型写的块摘要（可能敏感），且会被 `git add .` 收走 | 默认写进 `.gitignore` 提示，或目录名带点（`.handoff/`） |

## P2 —— 记账 / 边界

- **P2-1 子车道不支持**（已记在 CHANGELOG）：bili 的导出具名是 `<sessionId>|<sub:…>`，插件只传 `sessionId`
  ⇒ 子车道炸掉时导出的是主车道文档。而实证显示**炸掉的恰恰全是子车道**（15–19 MB），父会话（~340 KB）都健康。
- **P2-2 `cwd` 缺失时记 `failed`**：`initState` 拿不到 `header.cwd` 时（某些恢复路径）会写
  `failed · no session cwd`。它其实是"先决条件不满足"，不是"导出失败"——语义上更该是 `unavailable` 一类。
- **P2-3 `runExport` 只报退出码**：`stdio: 'ignore'` 丢掉了 bili 的 stderr，失败时面板只有 `exit 1`，
  排查要靠手工重跑。建议保留 stderr 尾部若干字节（或至少写进 `logger.warn`）。
- **P2-4 `mkdirSync` 在折叠热路径上同步执行**：一次阻塞 IO，可接受，但可以挪到导出前的微任务里。
- **P2-5 `safeSegment` 会把 `|sub:…` 这类键里的冒号变成下划线**：文档名与实际车道名不再一一对应（可接受，但要知道）。

## 建议的修法顺序

1. **先修 P0-1 + P0-2**（约 20 行：`resolveBili` 换代 + `.CMD` 处理），并补两条能真跑通的测试
   （注入真实的 `requireResolve` 抛错、断言三级落在「包目录 + execPath」而不是 `.CMD`）。
2. **再定 P0-3 的信号口径**（建议用会话日志文件大小起步），因为它决定阈值这一整套语义。
3. 然后 P1-3 / P1-4（活会话 + 窗口比例）、P1-2（节流落盘）、P1-5（补测）、P1-7（目录改 `.handoff/`）。

**P0-1 / P0-2 建议在把 `handoffExport` 保持为 `true` 之前修完** —— 否则默认开等于默认"每次都失败并写一条 warn"。
