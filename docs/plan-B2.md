# 支柱 B2（长工具后台化）本轮为什么做不了 · 取证报告

> 对应任务书 `D:\project\AI提速插件-开发任务书.md` §3 支柱 B2（:211）。
> 本文只做取证：**本轮不实现 B2**，并留下三条可核验的接续排查点。
> 全文区分 **已验证**（本机实跑命令/实读文件，附原始输出）与 **未验证**（无）。
> 取证时间：2026-10-06（本机）。

## §0 一句话结论

任务书 §3 要求 B2 **集成现成插件 `dsh-plugin-background-tasks`（v0.0.2）而不是重写**；但该插件在本机与 npm 上都**不存在**，
而唯一能在"工具还没跑之前就把结果换掉"的两个扩展点（`tools/pre-execute` 拦截层、`tools/execute` around 层）**都不允许替换结果**。
三条路同时封死 ⇒ **本轮 B2 不实现**，任务书 §5 验收表第 2 行（:441）本轮**不满足**。

---

## §1 任务书原话要求（锚点为主证据）

### 1.1 要求是"集成现成插件"，不是重写

- `AI提速插件-开发任务书.md` · 支柱 B2 标题 @ :211 —— `**B2. 长工具自动后台化**`
- `AI提速插件-开发任务书.md` · 支柱 B2 第一条 @ :215 —— 原文（逐字）：

  > **先读现成实现**：`D:\deepseek-harness\profiles\desktop\node_modules\dsh-plugin-background-tasks\`（v0.0.2，参数对齐 Antigravity `run_command`：`CommandLine`/`Cwd`/`WaitMsBeforeAsync`，**同步等 10 秒后自动提升为后台**）。这套语义是对的，**建议直接把它启用并集成，而不是重写**。

  这一行就是"**集成**而非重写"这条硬要求的唯一出处，且点名了**具体版本 v0.0.2** 与**具体路径**。

- `AI提速插件-开发任务书.md` · §10 开工顺序第 5 条 @ :534 —— 原文：
  > 5. 最后接 B2（后台化）——**优先复用 `dsh-plugin-background-tasks`**，别重写。

### 1.2 任务书把该插件当前"完全没生效"列为要解决的现象

- `AI提速插件-开发任务书.md` · §0 现象表 @ :17 —— 原文：
  > | 长命令把对话卡死 | `dsh-plugin-background-tasks` 插件 README 的定位就是「让长命令不再卡死对话」，但它 **v0.0.2 只在 `dependencies` 里、不在 `dsh.profile.bundles` 里 → 当前完全没生效** |

- `AI提速插件-开发任务书.md` · §1 清单 @ :50 —— 原文：
  > `D:\deepseek-harness\profiles\desktop\node_modules\dsh-plugin-background-tasks\   ← 长命令自动后台化（未启用，价值最高）`

### 1.3 任务书自己指定的落地机制与验收

- `AI提速插件-开发任务书.md` · B2 正文 @ :213 —— 要求走 `tools/pre-execute` 预判 + `ctx.jobs.start({kind:'bash', …})`，把 job id 立刻还给模型。
- `AI提速插件-开发任务书.md` · §4.4 骨架 @ :383-397 —— 骨架里返回 `{ kind: 'replace-result', result: {…} }`（见 §2.2，**该形状不存在**）。
- `AI提速插件-开发任务书.md` · §5 验收表第 2 行 @ :441 —— 原文：
  > | 2 | 长命令不再阻塞对话 | 跑 `pnpm install`，10 s 内返回后台 job id，对话可继续 |

**§1 小结（已验证）**：B2 的验收目标（:441）在形态上要求"工具同步返回一个**代替结果**（job id 文案）"，
这就把 B2 的实现**锁死在"必须在工具真正执行之前/之时替换掉工具结果"**这一类扩展点上。§2 逐一证明这类扩展点全不可用。

---

## §2 三条路都不通的证据

诊断顺序：先找可集成的现成物（①）→ 不行就在**拦截层**换结果（②）→ 不行就在 **around 层**换结果（③）。

### 2.1 路径①：集成对象根本不存在 —— **不通**

**(a) 任务书点名的三个路径全部不存在（本机实跑，False/False/False）**

命令：

```powershell
$paths = @(
  'D:\deepseek-harness\profiles\desktop\node_modules\dsh-plugin-background-tasks',
  'D:\deepseek-harness\profiles\desktop\.core-rc2-shim\node_modules\dsh-plugin-background-tasks',
  'D:\deepseek-harness\profiles\desktop\node_modules\@deepseek-ai\dsh-plugin-background-tasks'
)
foreach ($p in $paths) { "{0} => {1}" -f $p, (Test-Path $p) }
```

原始输出（逐字）：

```
D:\deepseek-harness\profiles\desktop\node_modules\dsh-plugin-background-tasks => False
D:\deepseek-harness\profiles\desktop\.core-rc2-shim\node_modules\dsh-plugin-background-tasks => False
D:\deepseek-harness\profiles\desktop\node_modules\@deepseek-ai\dsh-plugin-background-tasks => False
```

附带：对 `node_modules` 与 `node_modules\@deepseek-ai` 做 `*background*` 通配列举 —— **两个列举均为空**。

**(b) 更宽的整树搜索也没有（排除"只是路径记错"）**

命令：

```powershell
Get-ChildItem -Path 'D:\deepseek-harness' -Recurse -Directory -Filter 'dsh-plugin-background-tasks' -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty FullName
```

原始输出：**空**（无任何命中）。

**(c) npm 上也没有（排除"本地没装、但能现装"）**

命令：`npm view dsh-plugin-background-tasks version`

原始输出（逐字，退出码 1）：

```
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/dsh-plugin-background-tasks - Not found
npm error 404
npm error 404  The requested resource 'dsh-plugin-background-tasks@*' could not be found or you do not have permission to access it.
```

**路径①结论（已验证）**：`dsh-plugin-background-tasks` **在任务书点名的三处、整棵 `D:\deepseek-harness`、以及 npm registry 上均不存在**。
于是 "**集成现成插件而不是重写**"（:215）这条路在本机**没有集成对象**，直接封死；而"重写"被 :215 与 :534 明确劝阻，本轮不擅自改为重写。

### 2.2 路径②：拦截层不能改结果 —— **不通**（任务书 §4.4 骨架子是错的）

**(a) `PreToolDecision` 的 declaration 原文（实读，逐字）**

文件：`D:\deepseek-harness\profiles\desktop\.core-rc2-shim\node_modules\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js` @ :5955-5956

```
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
    info?: ToolErrorInfo;
} | {
    kind: 'cancel';
} | {
    kind: 'ask';
    reason?: string;
    displayReason?: {
        readonly en: string;
        readonly [locale: string]: string;
    };
};
```

**只有 `allow | deny | cancel | ask` 四个取值，没有 `replace-result`。**

**(b) 全文件 grep 也没有 `replace-result`**

命令（对同一文件）：

```powershell
Select-String -Path '<上述 api-catalog.js>' -Pattern 'replace-result'
```

原始输出：**0 命中**。即"用 pre-execute 返回一个代替结果"这个写法**在这个宿主版本里根本没有对应的类型/取值**。

**(c) 官方 description 与 signature 同时佐证"pre 阶段的能力边界"**

- `api-catalog.js` · `tools/pre-execute` signature @ :4238 —— 原文：
  `'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>`
- `api-catalog.js` · `tools/pre-execute` description @ :4240 —— 原文（逐字）：
  > Allow, deny, cancel, or ask before dispatch. `next()` delegates to allow; `cancel` selects the canonical pre-dispatch cancellation result, and missing approval support turns `ask` into denial. Async gates must observe `exec.signal`; the registry rechecks cancellation after they settle but never abandons their promise. …

  它明确说 `cancel` 选的是 **"the canonical pre-dispatch cancellation result"** —— 即 pre 阶段**唯一的"代替结果"就是取消**，不是"换成后台任务成功文案"。

**路径②结论（已验证）**：任务书 §4.4 骨架（:394）里的 `{ kind: 'replace-result', … }` **是错的**——
任务书自己在紧随其后的 :409-410 **也承认了这一点**，原文：

> ⚠️ 上面 `tools/pre-execute` 的返回值形状（`{kind:'replace-result', ...}`）是**示意**，`PreToolDecision` 的具体取值必须在写代码前用
> `cordis_inspect_query(…)` 查 `referencedTypes` 确认。**别照抄本段。**

本报告用实读 declaration（:5955-5956）完成了任务书要求的这次确认，结论是：**pre-execute 做不到"把长工具换成后台任务并返回 job id"**。

### 2.3 路径③：around 层也不许改结果 —— **不通**

文件同上：`…\.core-rc2-shim\node_modules\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js`

- `tools/execute` description @ :4224 —— 原文（逐字，含关键禁令）：
  > Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns a normalized result; **wrappers may change only `exec.signal`, while call identity remains immutable**. The registry re-fuses the original caller signal before the body, so replacement cannot detach caller cancellation; wrappers must still restore their signal and reach quiescence. …

  关键禁令逐字：**"wrappers may change only `exec.signal`, while call identity remains immutable"**。
  即 `tools/execute` 这个 around 层**只能改 `exec.signal`**，**不许**改结果、也不许改调用身份。用它在 dispatch 外围"拦下长工具、换成 job id"**违反该契约**。

- 交叉佐证：任务书 §2.1 事件表 @ :81 对 `tools/execute` 的原始标注就是
  "原文标注用途：**'for timeout, retry, or metrics'**"——官方定位为**观测/计时**，不是结果改写。

**§2.4 边界说明（纯事实，非方案）**：在"工具结果"这条派发链上，契约允许**产出不同结果**的只有 **post** 层——
`api-catalog.js` · `tools/post-execute` summary @ :4231 与 description @ :4232 原文首句均为
"**Accept, replace, enrich, or block a normalized dispatch result**"；
其 decision 类型 `PostToolDecision` declaration @ :5911-5912 取值为 `accept | accept(value) | block`。
按该契约，`next()` 拿到的是**已归一化的 dispatch 结果**，即**工具体已经跑完**。
因此 post 层即使能改结果，也**无法缩短"工具同步阻塞对话"的那段窗口**——它改变不了 B2 要解决的 :441 验收目标。
（此段只陈述契约事实，不构成任何实现建议；全文件 `replace` 一词共 63 处，绝大多数与工具结果无关，故此处只认 :4231/:4232 这两条 description。）

---

## §3 结论：本轮不实现 B2，并留下三条接续点

### 3.1 本轮结论（已验证）

| 路 | 想用它在"工具跑之前"换掉结果 | 实读证据 | 判定 |
| --- | --- | --- | --- |
| ① 集成现成插件 | 直接用 `dsh-plugin-background-tasks`（任务书点名 v0.0.2）的语义 | 本机三处 + 整树 + npm 全无 | **不存在，不通** |
| ② `tools/pre-execute` 拦截 | 返回 `{kind:'replace-result', …}` | `PreToolDecision` @ :5955-5956 只有 allow/deny/cancel/ask；`replace-result` 0 命中 | **无此取值，不通** |
| ③ `tools/execute` around | 在 wrapper 里替换结果 | description @ :4224「wrappers may change only `exec.signal`」 | **契约禁止，不通** |

⇒ **本轮不实现 B2**。不改 `lib/` 任何文件、不新增 B2 相关代码、不动 `cordis.patch.yml`。
⇒ 任务书 §5 验收表第 2 行（:441「跑 `pnpm install`，10 s 内返回后台 job id」）**本轮由本报告判定为"因上游能力缺失而不满足"**，而不是"未做"。

### 3.2 将来若要接续 B2，从这里进（三条可核验的排查点，均不需要重新调研）

1. **接续点 A（对应路径①）**：上游某天真发布了 `dsh-plugin-background-tasks`（v0.0.2 或其后继）。
   复工前先重跑本报告 §2.1(a)(c) 三条命令；只要任一 `Test-Path` 为 `True` 或 `npm view` 返回版本，即回到任务书 :215 的"启用并集成"路线。
   若它真被启用，还要接的是任务书 :17 指出的那个坑：**v0.0.2 只在 `dependencies` 里、不在 `dsh.profile.bundles` 里**（即"装了但没生效"）。
2. **接续点 B（对应路径②）**：若上游给 `PreToolDecision` 增加"替换结果"取值。
   复核方式：对 §2.2 的同一文件重新取 `PreToolDecision` 的 declaration（@ :5955-5956），确认出现 `replace-result`（或等价取值）；
   在那之前，任何基于该形状的代码都是**照抄任务书 :409 已自证为错的骨架子**。
3. **接续点 C（对应路径③）**：若上游放开 `tools/execute` 的结果替换（即 :4224 的 "may change only `exec.signal`" 被放宽）。
   复核方式：重读 :4224 的 description 原文是否仍含该禁令。

**三条接续点都只是"复核哪一行/哪条命令"的入口，不是实现计划**；届时仍需按任务书的澄清流程重新过一遍方案门。

---

## §4 本文不包含实现计划（对齐任务书 :409）

- 本文**没有**任何 B2 的代码、伪代码、"建议这样实现"的片段。
- 本文**没有**提议绕过 :4224 / :5955-5956 契约的替代做法。
- 本文**没有**把"重写一个后台化插件"当作 Plan B —— 任务书 :215 / :534 明确要求"别重写"，
  本轮既无集成对象也无可改结果点，**正确的动作是不做**，而不是换个姿势硬做。

## §5 证据复现命令清单（全部为只读）

```text
# ①(a) 三个路径存在性
Test-Path 'D:\deepseek-harness\profiles\desktop\node_modules\dsh-plugin-background-tasks'                 # False
Test-Path 'D:\deepseek-harness\profiles\desktop\.core-rc2-shim\node_modules\dsh-plugin-background-tasks'  # False
Test-Path 'D:\deepseek-harness\profiles\desktop\node_modules\@deepseek-ai\dsh-plugin-background-tasks'    # False
# ①(b) 整树搜索（空）
Get-ChildItem -Path 'D:\deepseek-harness' -Recurse -Directory -Filter 'dsh-plugin-background-tasks'
# ①(c) registry（E404）
npm view dsh-plugin-background-tasks version
# ②③ 声明原文（该文件共 8188 行、609169 B）
#   D:\deepseek-harness\profiles\desktop\.core-rc2-shim\node_modules\@deepseek-ai\dsh-tool-cordis\lib\types\api-catalog.js
#   :4224  tools/execute description（"may change only `exec.signal`"）
#   :4232  tools/post-execute description
#   :4238  tools/pre-execute signature
#   :4240  tools/pre-execute description
#   :5911-5912  PostToolDecision declaration
#   :5955-5956  PreToolDecision declaration
```

> 说明：模块 id `@deepseek-ai/dsh-tool-cordis` 在本机**解析到 `.core-rc2-shim` 下**
> （`D:\deepseek-harness\profiles\desktop\node_modules\@deepseek-ai\dsh-tool-cordis` **不存在**，`Test-Path` 均为 `False`）。
> 以上行号均以该实读文件（609169 B / 8188 行）为准。
