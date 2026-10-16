# dsh-status-turbo 0.7.4 复查

> 探针：`D:\project\.tmp-sess\probe-074-risks.mjs`（可复现）。**带「实证」的是跑出来的。**
>
> **状态（0.7.6）：本文件 7 条全部有结论** —— `-1 / -2 / -3 / -6` 在 **0.7.5** 修掉
> （`profileRootOf` 四层 + 真实布局回归测试、`MODEL_VISIBLE_EVENT_TYPES` 白名单、
> `handoffExportMaxPerProcess` 8 → 64、reason 改名 `no-watermark`）；
> `-5` 在 **0.7.6** 修掉（`HANDOFF_MESSAGE` + `failureMessage` + 客户端 `reasonText` 按 locale 渲染 ——
> **`message` 类型未变（仍是字符串）⇒ 不动 wire 形状、不升版本号**，比我原先估计的省）；
> `-4` **以"刻意不回落"结案**：本部署里 compaction 压不下 payload（那条车道压缩了 4027 次仍到 ~17 MB），
> 清零会让它从"多导"变成"漏导"，所以保留累计口径，只补文档 + 一条"只增不减"的测试。
> 测试 **232 / 232 绿**。

## P0 —— 修它（一行 + 一条测试）

### 0.7.4-1 `profileDirOf()` 少了一层，第三级探测是**死代码**（实证）

```
① profileDirOf() 返回  : D:\deepseek-harness\profiles\desktop\node_modules   ← 少了一层
   真 profile 根目录    : D:\deepseek-harness\profiles\desktop
   三级拼出来的路径     : …\profiles\desktop\node_modules\node_modules\billion-context\dist\index.js → exists = false
   本该拼出来的路径     : …\profiles\desktop\node_modules\billion-context\dist\index.js               → exists = true
```

`lib/index.js` 里是 `dirname(dirname(dirname(fileURLToPath(import.meta.url))))`，而装好的副本是
`…\profiles\desktop\node_modules\dsh-status-turbo\lib\index.js` ⇒ 三层 dirname 落在 **`…\desktop\node_modules`**，
拼出来自然多一段 `node_modules`。

**为什么现在还"能用"**：二级（`requireHere.resolve('billion-context')` + `packageRootOf` 切包根）是好的，
把这条死掉的第三级**遮住**了。**这与 P0-1 / P0-2 是同一类错**：一个探测级悄悄失效、靠下一级兜住，
于是永远没人发现。

**为什么 215/223 条测试没抓到**：现测试喂的是**假的** `profileDir: '/p'`，它只验证"拼法"，不验证
"这个值在真实布局下指向哪里"。⇒ 缺的是一条**对着真实 `import.meta.url` 断言**的测试。

**修法（两条都做）**：
1. `dirname` 用**四层**（到 `…\profiles\desktop`）；或者干脆**删掉 profileDir 这一级** ——
   二级已经覆盖，而"一个永远命不中的候选"比"没有候选"更糟（它是下次误诊的温床）。
2. 补一条断言：对注入的 `exists` 校验「三级路径 == 真 profile 下的 billion-context CLI」。

## P1 —— 会咬人（都是 0.7.4 的字节口径带出来的）

### 0.7.4-2 字节口径让「本进程 8 次上限」变成**紧约束**

`handoffExportMinDeltaBytes = 750000` ⇒ 每长 750 KB 就够一次触发。实测本机 sessions 日志共 **429 份 / 548.3 MB**，
单份最大 **48.0 MB**（`session-5b4cb15d-…`）。一个 48 MB 的会话**会越过 40+ 次**，而
`handoffExportMaxPerProcess` 默认是 **8** ⇒ 很快进入 `failed · per-process limit reached`
（只在第一次记 `failed` + 一条 warn，之后静默），然后**本进程内不再导出**，直到重启。

token 口径时代这个上限基本碰不到（400 K token 很少越）；**字节口径把它变成了日常约束**。
**建议**：默认抬到 64（或按"每车道 × 每桶最多一次"来计，而不是按进程计数）。

### 0.7.4-3 字节账**偏大**：把所有事件类型都算了进去

`accountEventPayload` 对**每一条**事件做 `JSON.stringify(event.data)` 累加，包括
`compaction/start` 与 `compaction/end` 这对**成对出现**的事件（那份失败的日志里各 **4027** 条）。
如果两者都带块内容，同一段文本会被算**两遍**；`subagent/*` 的目录快照同理。

**后果**：触发**比设计更早**（再叠加上 P1-1，上限更快耗尽）。
**建议**：只对**模型可见**的类型计价 —— `user/message` / `assistant/message` / `tool/result` + 最新 `request/header`，
其余类型不计。既更接近 bili 真正量的东西，也顺手省掉一半以上的序列化。

### 0.7.4-4 字节账**只增不减**，压缩之后不会回落

`compaction` 之后**真实**要发出去的 payload 是缩小的，而这个账只累加 ⇒ 一个被压缩过的长会话会**持续**满足字节条件。
和 P1-2 一样，方向是"多导"，不是"漏导"，所以不致命，但要知道它不是"当前 payload 大小"的估计。

### 0.7.4-5 `failed` 的 `message` 是英文，直接显示在中文面板上

`mkdir failed` / `per-process limit reached` / `timeout` / `exit N` 全部是英文，而面板其余部分是
zh/en 双语（`lib/client.js` 的 locale 表）。这几条是**运行时拼出来的**，没走 locale。
**建议**：把它们变成**稳定 code**（`mkdir-failed` / `limit-reached` / `timeout` / `exit:<n>`），
由客户端按 locale 渲染。

## P2 —— 记账 / 措辞

- **0.7.4-6** `planHandoff` 的 `reason: 'no-tokens'` 现在可能只因字节缺失而返回 —— 名字已经不准（改成
  `no-watermark` 更诚实）。
- **0.7.4-7** `resolveBili` 里 `source: 'package'` 同时覆盖"解析出来的包根"与"profileDir 拼的路径"，
  修完 P0-1 之后建议把两级分开标（诊断时能一眼看出走的是哪级）。

## 已排除（实测不是问题，写下来免得下次又怀疑）

- **重放要序列化 548 MB 日志会不会拖慢启动？不会。** 实测 `JSON.stringify` 吞吐 **≈ 2120 MB/s**
  （4000 条 × 40 KB = 153.1 MB，用时 **72 ms**）⇒ 整份语料 ≈ 0.26 s，单份最大（48 MB）≈ 23 ms。
  即便真实数据比合成样本慢 10 倍，也仍在噪声量级。**这条不修。**

## 建议的打包方式

`0.7.4-1`（一行 + 一条测试）没有争议，可以直接修。`0.7.4-2` / `0.7.4-3` 是**默认值/口径**的判断，
`0.7.4-5` 动的是 wire 上的 `message` 字段（**会碰 v8 契约**，需要连 fixture 一起改）。
建议按 `0.7.4-1 + 0.7.4-3 + 0.7.4-2`（0.7.5，纯逻辑 + 默认值，不动 wire）先出，
`0.7.4-5` 单独一版（要动 wire 与 locale）。
