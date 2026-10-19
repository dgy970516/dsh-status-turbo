# dsh-status-turbo

[中文](README.md) · **English**

> Turns "what is it stuck on right now?" into **one line of ticking text** above the composer.

`dsh-status-turbo` is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai). It keeps a single thin status bar above the message composer:

```
● Running tool(bash)   2:14   3.1K tok
```

For those moments three minutes into a long command — page frozen, no log output, is it dead or not — this line is the answer.

---

## What it shows

**It sits inside DSH's own composer footer stats row** (the `6 turns · 283 steps / 27.9M tok · cache hit 96% / 10%` line),
on the right of the shipped entries — so it never adds an extra row or floats above the composer.
It only fills in what that row does not already show:

| Field | Meaning | Example |
| --- | --- | --- |
| **Phase** | `assembling` / `requesting` / `streaming` / `tool(<name>)` / `approval` / `compacting` | `● Running tool bash · 2:14` |
| **Phase elapsed** | Refreshed every second. **Needs no push** — the client computes it from its own clock, so it keeps ticking while the log is silent | ditto |
| **Step tokens** | Input + output accumulated for the current step (since 0.19.2 only the number) | `3.1K tok` |
| **Gear** | **Not on the status bar since 0.19.2** — the app's own effort selector already shows the same value, so it stays in the detail panel. The value is the reasoning effort this step **actually sent** (read from the logged `request/header`, not guessed locally) | — |
| **No progress** | No new output for more than `noProgressMs` (default 90s) → that cell turns amber and shows how long it has been stuck (since 0.19.2 four words only; the full sentence moves to `title`) | `2:49 no new output` |

The host projects this as the `turbo` wire view, **version `v: 13` with 37 keys** — v1's 19 keys, the 9 keys added in v2
(`mountStatus`, `prefixEpoch`, `prefixCause`, `prefixAt`, `lastTurnMs`, `topTools`, `hookFaults`, `idleLine`, `lastSpill`),
then one key per later version: v3 `activity`, v4 `waitTools` / `waitKind` / `subagents`, v5 `slowMs`, v6 `enhancement`,
v8 `handoff`, v9 `rotation`, **v13 `newSession`** (v7 added `enhancement.mode` inside an existing key, and v10 added the
`rotation.childId` / `seedOk` / `message` fields inside `rotation` — neither raised the top-level key count). `newSession`
carries the New session page's copy-ready opening text (`{ text, oldId, cwd }`). The client pins `EXPECTED_V = 13`: on a
version mismatch it renders red text `投影版本错配（宿主 vN ≠ 客户端 vM）` in place of the bar rather than disappearing.

**Deliberately not repeated** from the shipped row: session turns/steps, tok/s, total tokens, session-level cache hit rate,
context usage. The per-step cache hit rate stays in the projection data (`hitRate`) but no longer occupies a cell —
two different "cache hit" numbers on one line only confuse.

**While idle the cell does not disappear** — it keeps a one-line summary of the last turn: the phase name plus how
long that turn took (`● requesting · last turn 42.3s`). The host sends that as `idleLine` / `lastTurnMs`, so the
summary survives even with no new events.

**Clicking the cell opens a detail panel** below the composer (slot `conversation.input.dock`, id `dsh-status-turbo.detail`,
order 0); clicking again collapses it. While collapsed — or before the first snapshot arrives — the panel renders
nothing at all. The panel has 11 always-present sections, top to bottom: **Now** (what this step is doing — phase name ·
elapsed · tool name), **Activity** (the last few 'what the model thought / which tool it called / how it turned out',
newest first), this turn / last turn / cache and usage / prefix / slowest tools (top 5 by `maxMs`) / waits / rotation /
enhancement / handoff. Two more are conditional and simply do not appear when empty: the last oversized-result spill
with its absolute path (`lastSpill`) and recent faults (`hookFaults`).

**The activity stream is memory-only** (a ring buffer — never written to disk, no new dependencies, no change to the
requests sent): `assistant/message` records a reasoning excerpt (truncated to `reasoningChars` characters),
`tool/call` records the tool name and its **redacted** arguments, `tool/result` records the first `resultHeadLines`
lines of the result / error, and `turn/end` records the stop reason. Argument values whose key matches `redactKeys`
(case-insensitive substring match) become `'***'` before they ever reach the UI, circular references degrade to
`[Circular]`, and a dirty argument never throws.

---

## Install

Manual (profile assembly): drop the package into the profile's `node_modules`, then in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-status-turbo
      name: 'dsh-status-turbo'
      config:
        statusBar: true
        noProgressMs: 90000
        downgrade: true
        downgradeFloor: low
        minQuietSteps: 2
        spillThresholdBytes: 32768
        bulkInjectionBytes: 32768
        evidenceWhitelist:
          - '/exit code:?\s*0\b/mi'
          - '/(^|\n)\s*(#\s*(pass|tests|suites)\s+\d+|\d+\s+passing|Tests:\s+\d+\s+passed|Test Suites:\s+\d+\s+passed|ok\s+\d+\s+-)/m'
          - '/(^|\n)\s*(Successfully compiled|Compiled successfully|Found 0 errors|\d+\s+files?\s+checked,?\s*0\s+errors|Build succeeded|Done in \d)/mi'
        stuckAction: warn
        stuckRounds: 3
        stuckRepeats: 3
        mojibakeMinRuns: 2
```

Every key is optional; the block above is a short example (12 of the 46 default keys). The single source of truth for all
46 defaults is `lib/state.js · DEFAULT_CONFIG`, which the package's own `cordis.patch.yml` mirrors verbatim; every key with
its default and meaning is tabulated under [Configuration](#configuration) below.

> ⚠️ **Do not** list the same package in both `dsh.profile.bundles` and the profile's `cordis.patch.yml` — it would be loaded twice.

---

## Saving compute: per-step reasoning gear (B1)

The plugin watches the tool trajectory and drops the reasoning effort **for that step** when the step plainly
does not need deep thinking:

- **≥2 consecutive finished steps** that ran only read-only tools (`read`/`glob`/`grep`/`web_search` …)
  **with zero errors** → drop one gear;
- a **write-capable tool** (`bash`/`edit`/`write`/`sql_exec` …) or **any error** → back to the original gear
  **immediately**;
- the original gear is whatever you selected for the session. The plugin **only lowers, never raises**, and
  never touches your default model or provider.

Every downgrade leaves two independent traces: a `B1 降档: …` line in the DSH log, and an extra gear row
in the detail panel (0.19.2 moved it off the status bar).

| Key | Default | Description |
| --- | --- | --- |
| `downgrade` | `true` | Master switch. Only an explicit `false` disables it (then `llm` is not even injected) |
| `downgradeFloor` | `low` | Lowest gear allowed. Compared **by index** in the model's own ordered effort list; if the model does not publish it, drops one gear at a time |
| `minQuietSteps` | `2` | How many clean read-only steps are required. `1` is more aggressive, and easier to get wrong |

No gear name is hard-coded — everything is asked from `ctx.llm.resolveModelInfo()`. Whenever it is unsure
(no effort list, current gear not published, service missing, judgment threw), it runs the step **at the
original gear** and never lets the plugin fail a request.

---

## Saving context: oversized tool results (B3)

When a single tool result is huge, the host half shrinks it before it reaches the model:

- it first asks the host's own `toolResultPruner.pruneContent` to trim the body;
- if the result is still at or above `spillThresholdBytes` (default 32768), it is handed to the **host's existing
  spill backend** (`spillStore.saveText`), and the shrunken body carries a notice with the **absolute path** of the
  saved file — a path you can `read` with `offset`/`limit` or `grep` directly.

The notice is rendered verbatim by `lib/spill.js`:
`（已省略 {bytes} bytes；完整结果落盘于：{locator}。用 read 配 offset/limit，或 grep 这个路径继续。）`
If the backend hands back a locator that is not an absolute path, the plugin **degrades instead of guessing** (no
fake path is ever printed). See the "Writes only its own data" note under *Design constraints*: for B3 the write is the
host's, and the plugin itself never opens a file for writing in that path.

---

## Seeing a dead cache prefix (B4)

Cache-prefix invalidation is visible as a `前缀已失效` pill on the status bar (only while the invalidation is fresh,
i.e. within the last 5 minutes). The host counts three triggers:

| Trigger | Condition |
| --- | --- |
| `compaction-start` / `compaction-end` | a `compaction/start` or `compaction/end` event |
| `bulk-injection` | one `tool/result` payload ≥ `bulkInjectionBytes` (default 32768) |

The wire view exposes it as `prefixEpoch` / `prefixCause` / `prefixAt`. On a real recorded session this counter read
**17 invalidations** (`bulk-injection ×9`, `compaction-start ×4`, `compaction-end ×4`) — see `tools/replay-log.mjs`.

---

## Notes appended inside the same tool return (C1 / C2 / C3)

Three cheap corrections are appended to the **current** tool result — they never add a round trip, and the session's
step count does not change:

- **C1 — no verifiable evidence**: a result that shows no evidence line at all (nothing matching `evidenceWhitelist`,
  exactly 3 regex sources, e.g. `exit code: 0`, `N passing`, `Found 0 errors`) gets
  「上一条没有可核对的证据……别据此下结论。」
- **C2 — truncated read**: a `read` that used `offset`/`limit` while the file has more lines gets
  「你只看了 N / M 行（绝对路径）；后面还有内容没读，别基于这个片段下结论。」
- **C3 — mojibake / noise**: broken text (≥ `mojibakeMinRuns` runs of U+FFFD) or output swamped by noise gets
  「这段输出里的中文已经损坏……」 / 「这次输出被噪声淹没（x / y 行不是目标输出）……」

---

## Stuck detection (D) — **warn level only**

`stuckAction` defaults to `warn`, which is **zero side effect** (it records a fault, nothing more). `nudge` and
`stop` only happen if you configure them explicitly — and `stop` additionally requires the host's
`workspace/session-activity` to report a live session, because it would otherwise kill long-running work such as an
overnight build. **Known gap:** `stuckRounds` currently has **no consumer** — the host half only sees one half of the
signal (`stuckRepeats` over consecutive identical aggregate keys), so D is not a complete implementation.

---

## The New session page (0.18.0)

When a session has grown enough to be handed over (see the `rotation*` keys under *Configuration* below), the rotation creates a **blank**
child session: since 0.21.1 nothing is written into it (before that the opening script was appended as its first `user/message`, so every new
session opened with the same paragraph). The **New session** page shows that opening text so you can copy it with one click and paste it into
the new session — no more making the new session guess what it was supposed to do.

- **The text is built from the template**: `{old}` becomes the old session id and `{cwd}` the working directory. The
  default template is `继续旧会话 {old}（工作目录 {cwd}）。需要它的上下文时用 @{old} 查阅，不要假设我记得；先跟我确认要接着做的那件事。`
- **What the page shows**: a rotation section, the opening text inside a selectable `<pre>`, a **Copy** button (it reports
  '已复制' once the clipboard write succeeds, and '复制失败，请手动选中' when the clipboard is unavailable or refuses),
  one line with the working directory, and a hint to paste the text into the new session.
- **Where it lives**: the bottom of this plugin's **settings page** (`dsh-status-turbo.settings`, right under the config
  form). 0.18.2 removes the 0.18.0 left-rail entry — one page instead of two, and no sidebar button to keep in sync.
- **Data comes through the shipped hook**: the settings page is root-scoped with no session binding, so the card reads
  `useSessions(state => state.current)` and then `state.byId[id]?.projectionValues?.turbo` — the host already publishes
  every session's projection values inside the session list. No new subscription, HTTP route, or host RPC.
- **The child session is created through the agent lifecycle (0.19.0)**: the host half now calls
  `ctx.agents.create({ sessionId, meta })` instead of `ctx.sessions.create(...)`. A session published outside the agent
  lifecycle never gets a session-log writer, so it persists nothing — it lives in memory only and never appears in the
  session list. That call is asynchronous: its outcome (and the title pass) is appended to `rotation-trace.jsonl` once it
  settles. Without an `agents` service the host falls back to the old in-memory path.
- **…and attached to its workspace (0.19.1)**: persisting is not enough. The left-hand session list is built from
  each workspace's `sessionIds`, not from disk, so once the create promise settles the host half resolves the
  workspace by normalized path (`workspaceRegistry.resolveByPath(cwd)`) and calls `attachSession(childId)` — the same
  step the host's own new-session and fork paths take. The outcome (`attached` / `no-registry` / `no-workspace` /
  `resolve-failed` / `attach-failed`) lands in `rotation-trace.jsonl`; anything but `attached` also logs a warning.
- **…carrying a model and a preset, and switching by itself (0.19.3)**: the child agent is created with the parent's
  model (`agentOptions`, falling back to `agentDefaultModel.currentSelection()`) and the parent's `agentPreset` (mounted
  through `setup`), because the deployment persona section renders `{{model}}` and a child without one fails its first
  run.
- **…and switched through the client's real entry point (0.19.4)**: the client `sessions` service face (0.2.0-rc.2) is
  `retain` / `using` / `retainInfo` / `refreshProjections` / `search` / `fork` / `scope` / `binding` — there is no `open`,
  so every attempt fell through to `failed` / `no-service`. The page now prefers `uiWorkspace.openSession(childId)` and
  keeps `sessions.open` only as a legacy fallback, still retrying for ~20s so the switch survives the
  create → workspace-attach → session-list trip.
- **…named after the session it came from, and with a way out of "waiting" (0.20.0)**: a rotation child is a *blank* session
  (0.9.0 dropped `fork`), so it carries no title events — before 0.21.1 the fallback named it from its first `user/message` (the seed
  template, identical in every generation), and since 0.21.1 there is no first message at all. The host now reads the parent's persisted title (`ctx.sessionTitle.get`) and renames
  the child with the same convention `sessions.fork({ increaseTitle: true })` uses (a trailing `(N)` / `（N）` is incremented
  keeping its brackets; anything else gets ` (1)`); that write is a `user`-source `session/title` event, which pins the title
  against the fallback. Key: `rotationIncreaseTitle` (default `true`). On the client side the `armed` row is clickable again
  while `auto` is waiting — one click switches immediately — and a second row switches **and** archives the current session
  (`performRotation(snapshot, { force: true, archiveOld: true })`). **As of 0.20.0 the host only reminds by default** (`rotationCreate: false`): a threshold crossing is still recognised and still traced, but nothing is created — the panel suggests starting a new session and the opening script is copyable on the settings page; set `rotationCreate: true` to restore the automatic child session.
- **…plain-spoken and copyable (0.21.0)**: every config field and group label now has a Chinese description (raw keys such as `rotationCreate` no longer appear as labels) — a missing dictionary entry used to fall straight through to the key name because `makeText`'s fallback is supplied at the call site, so the settings page consults `DICT.zh` first and only then the hard-coded fallback. The status bar gained a **Copy** button (left of the collapse toggle) that copies four lines — `会话名称：…` / `会话 ID：…` / `会话日志目录：…` / `继续处理未完成的任务`; a value that is unavailable drops its whole line instead of leaving a placeholder, and the button itself is always rendered — even against a host that sends no `newSession` at all it still copies the closing hand-off sentence. The name comes from the host's `session-title`, the directory is built as `<DSH_HOME>/sessions/<project key>/<session id>` (an empty string when there is no working directory — the path is never guessed); both are fields 0.21.0 added to the wire.
- **…and nothing is auto-filled into the child (0.21.1)**: the step that appended the opening script as the child's first `user/message`
  is gone (`seedQuietly` / `seedMessage` deleted), so a rotation child — even with `rotationCreate: true` — is created **empty**, and the
  script is taken by hand from the status bar's **Copy** button or the settings page. The rotation record no longer carries `seedOk`, and
  the client no longer renders the "seed written / failed" note.
- **Three states, stated apart**: no current session ('pick one on the left'), projection not arrived yet ('waiting for
  this session's projection'), and no opening text reported by the host (a hint line only — no `<pre>`, no Copy button).
  It never reports 'none' for 'not yet'.
- **It never rotates anything**: the host half still creates the blank session (since 0.21.1 with nothing written into it); this page
  only puts the same text in front of you.
- **On the wire it is the top-level `newSession` key** (`{ text, oldId, cwd }`, v13 / 37 keys).

---

## Not implemented this round: B2

Backgrounding long commands (returning a job id within 10s instead of blocking) is **not implemented**. The
integration target does not exist on this machine (no `dsh-plugin-background-tasks`, and `PreToolDecision` has no
result-replacing branch), and there is no supported hook for it. Evidence and the three follow-up leads are in
[`docs/plan-B2.md`](docs/plan-B2.md). Please do not expect a B2 usage that is not there.

---

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `statusBar` | `true` | Mount switch for the status bar. The host projects it into the wire field `mountStatus` (`'enabled'` / `'disabled'`); the client has **three** states: `enabled` → normal bar; `disabled` → renders nothing; **field absent** (an older host that does not send it) → a red cell `状态条开关缺失：配置未送达` instead of a silent no-op. Off means "no bar", not "silently dead switch" |
| `noProgressMs` | `90000` | No-progress threshold in milliseconds |
| `downgrade` | `true` | See the section above |
| `downgradeFloor` | `low` | See the section above |
| `minQuietSteps` | `2` | See the section above |
| `readOnlyTools` | 10 tool names | 0.9.2 (P1-4): the B1 read-only allowlist — only **explicitly read-only** tools count as "pure read / list / search"; anything not listed (`bash` / `edit` / `write` / `sql_exec` / `univer_execute`…) counts as "may write", and one such call breaks the consecutive run (deliberately conservative). Elements must be non-empty strings and invalid ones are filtered; an empty result falls back to this table (`[]` means "not configured", not "no read-only tools"). Defaults: `read` / `read_image` / `glob` / `grep` / `list_dir` / `search_context` / `web_search` / `web_fetch` / `cordis_inspect_list` / `cordis_inspect_query` |
| `spillThresholdBytes` | `32768` | B3: a result body this many UTF-8 bytes or larger may be spilled (AND-ed with the harness tool-result pruner) |
| `localTrimHeadChars` | `4096` | 0.6.5: characters of the **head** kept by the local trimmer used when the host pruner is unavailable (`spillThresholdBytes` decides *whether* to spill; these three keys decide how much the model sees) |
| `localTrimTailChars` | `1024` | 0.6.5: characters of the **tail** kept; the elided middle becomes one line saying how many characters were dropped |
| `localTrimMinChars` | `8192` | 0.6.5: a longest-text block shorter than this is **not** trimmed (characters, unrelated to `spillThresholdBytes`); a trim no shorter than the original is skipped too |
| `bulkInjectionBytes` | `32768` | B4: one `tool/result` payload at or above this counts as a "bulk injection" that invalidates the cache prefix |
| `evidenceWhitelist` | 3 regex sources | C1: 3 complete regex literals as strings (delimiters + flags included); matching any one counts as verifiable evidence |
| `stuckAction` | `warn` | D: `warn` (default, zero side effect) / `nudge` / `stop` |
| `stuckRounds` | `3` | D: consecutive `turn/end` without a new tool name. **Currently has no consumer** (known gap) |
| `stuckRepeats` | `3` | D: how many repeats of the same aggregate key count as stuck |
| `mojibakeMinRuns` | `2` | C3-a: longest run of consecutive U+FFFD before the encoding warning fires |
| `activityLimit` | `24` | 0.6.0: how many activity entries the ring buffer keeps (drops from the head past this) |
| `activityBytes` | `8192` | 0.6.0: total UTF-8 byte cap for the activity ring buffer (drops from the head past this) |
| `reasoningChars` | `400` | 0.6.0: characters a single reasoning excerpt is truncated to |
| `resultHeadLines` | `6` | 0.6.0: head lines kept from a tool result / error |
| `redactKeys` | 11 keys | 0.6.0: argument-redaction keys (case-insensitive substring match): `key` / `token` / `secret` / `password` / `passwd` / `pwd` / `authorization` / `cookie` / `dsn` / `apikey` / `credential` |
| `subagentWaitTools` | `['wait_agent']` | 0.6.1: waiting tool names (waiting on a subagent); they skip "slowest tools" and are listed as their own wait kind |
| `humanWaitTools` | `['ask_user_question']` | 0.6.1: waiting tool names (waiting on the user), classified `human` |
| `jobWaitTools` | `['job_output','job_wait']` | 0.6.3: waiting tool names (waiting on a background job) — the fourth kind. Only a call whose arguments carry `wait: true` counts as `job`; a snapshot without `wait` counts as real execution |
| `slowMs` | `60000` | 0.6.3: slow-call threshold in milliseconds; a tool whose `maxMs` reaches it carries `slow: true` on the wire, and the client adds ⚠ plus a pointer to the background-tasks plugin |
| `handoffExport` | `true` | Master switch for the 0.7.0 handoff export. **On by default**; an explicit `false` really does nothing (no probing, no process, no directory) |
| `handoffExportTokens` | `240000` | Export is considered once the step's input tokens reach this (**lowered from 400000 in 0.8.1** — the measured hard stop on this machine was 341421) |
| `handoffExportMinDeltaTokens` | `60000` | Re-export only after the session grew by this much (**lowered from 100000 in 0.8.1**) |
| `handoffExportDir` | `'handoff'` | Export directory, relative to the session cwd |
| `handoffExportFull` | `false` | Whether to pass `--full` (attaches every block's raw messages; a much larger document) |
| `handoffExportBiliBin` | `''` | Path to the bili executable; the empty string selects the probing chain described below |
| `handoffExportTimeoutMs` | `120000` | **0.9.2 (P1-4)**: hard timeout for one `bili export` (and for the lane-list read), in milliseconds. On timeout it kills first, destroys both pipes and only then escalates to `SIGKILL` (`lib/handoff.js · runBili`). One key shared by both call sites (`runExport` / `listLanes`); an invalid value falls back to 120000 |
| `handoffExportWindowPercent` | `25` | Threshold as a percentage of the model window when the window is known. **One knob shared by the token and byte criteria** (lowered from 40 in 0.8.1: the old 40% × 1M equalled the old token knob, so it never bound) |
| `handoffExportMaxPerProcess` | `64` | Most exports started per process; exhausting it records `failed` plus one warning (**raised from a hardcoded 8 in 0.7.5**) |
| `handoffExportSubLanes` | `false` | Whether to export the session's sub-lanes (`\|<sub:…>`) as well. **Off by default since 0.7.8** (one over-threshold lane used to cost one export per lane) |
| `handoffExportBytes` | `1800000` | **Byte criterion**: fires when the model-visible volume reaches it (OR-ed with the token criterion); **lowered from 3000000 in 0.8.1** = 240000 × 7.5 |
| `handoffExportMinDeltaBytes` | `450000` | Throttle for the byte criterion (**lowered from 8000000 in 0.8.1** — the old value was *above* the threshold, making a second byte-triggered export a dead end) |
| `handoffExportFreshMs` | `300000` | Only **fresh** events trigger: an event folded from further back than this many milliseconds does nothing (blocks the cold-start replay burst) |
| `handoffExportRefreshBytes` | `0` | Whether one lane may be exported repeatedly. **`0` = at most one document per lane** (default since 0.7.8); setting a byte delta restores "refresh per watermark bucket" |
| `rotation` | `'auto'` | Rotation mode: `off` / `manual` (one clickable panel row) / `auto`. **`auto` by default since 0.9.1** |
| `rotationCooldownMs` | `600000` | Minimum interval between two rotations (**process-wide**, to break rotation chains) |
| `rotationOpenChild` | `true` | 0.9.0: whether the client switches to the child session the host created (in `auto` mode it switches automatically) |
| `rotationFreshMs` | `300000` | 0.8.1: rotation is judged only on fresh events (same purpose as `handoffExportFreshMs`) |
| `rotationRequireIdle` | `false` | **0.9.2**: whether rotation requires the session to have no open round. Default `false` — creating a blank session does not interrupt a running turn; `true` restores the 0.8.0 behaviour (measured: a session that is never idle never rotates) |
| `rotationArchiveOld` | `false` | Whether to archive the old session after switching (**`false` since 0.8.1**: archiving drops it from the same list projection the `@` picker reads, so the `@{old}` lead would break, and the UI has no un-archive entry) |
| `rotationIncreaseTitle` | `true` | **0.20.0**: whether a rotation child is renamed after the parent's persisted title with the official `(N)` convention (the parent's title is read through `ctx.sessionTitle.get`, the child written through `rename`; an absent service, a missing title or a failed rename only downgrade) |
| `rotationCreate` | `false` | **0.20.0**: whether a threshold crossing actually creates a new session. `false` (the default) only records `remind` — `shouldRotate` still recognises "at threshold", but nothing is created and the client shows a suggestion; set `true` to restore the 0.19.x automatic child session |
| `rotationSeedMessage` | `'继续旧会话 {old}（工作目录 {cwd}）。…'` | 0.9.0: the opening-script template (`{old}` = old session id, `{cwd}` = working directory). **Since 0.21.1 it is no longer written into the new session** — it only renders the text you copy from the status bar button or the settings page; that copy is now the only route that puts the old session id into the context |

Restart DSH after changing configuration.

Note: the per-key behaviour of the `handoffExport*` and `rotation*` families (0.7.0 handoff export, 0.8.0+ rotation) is
described in Chinese in [`README.md`](README.md) §「交接文档自动导出」/§「到量轮换」; the defaults above are the
same values.

---

## Manual acceptance

| # | Steps | Expected |
| --- | --- | --- |
| 1 | Have the model run `ping -n 120 127.0.0.1` (~2 min) | Within 1s the bar appears, phase = `Running tool(bash)`, elapsed ticks from 0 |
| 2 | Do nothing for 2 minutes | Elapsed keeps advancing; a silent log never freezes it |
| 3 | Wait for the command to finish | Phase returns to `requesting`, then the cell flips to the idle summary `last turn …` — it does **not** vanish |
| 4 | Set `statusBar: false` and restart | No bar at all (the host still folds state, very cheap). If the **field `mountStatus` is missing** — i.e. an older host half — the cell instead shows the red `状态条开关缺失：配置未送达`; that red cell is a failure signal, not a working "off" |
| 5 | Produce more than `spillThresholdBytes` (32 KiB) of tool output in one result | The body is pruned and carries a notice with a **readable absolute path** (the spill locator) |
| 6 | Have the model claim "tests passed" without running them; or make it `read` a file with `offset`/`limit` | A correction note appears inside the **same** tool return — no extra round trip, session step count unchanged |
| 7 | Run a command that emits GBK mojibake, or one buried in noise | An "encoding broken" / "noise" note appears in the same tool return |
| 8 | Leave one step silent for 2 minutes | At 90s (`noProgressMs`) the no-progress cell turns amber and counts up |
| 9 | Inject memory / trigger compaction mid-session | A `前缀已失效` pill appears within 5 minutes, cause = `压缩开始` / `压缩结束` / `大块结果注入` |
| 10 | Remove the `conversation.composer.dock` declaration (or use a non-existent slot name) and restart | UI **does not crash**; console shows `[dsh-status-turbo] 状态条 3 秒内未能挂载到 conversation.composer.dock…` |
| 11 | Tamper with the projection version `v` | Red text "投影版本错配" appears in place of the bar instead of silently vanishing |

The original §6 row 2 ("long commands stop blocking; a background job id within 10s") **does not apply this round** —
B2 is not implemented, see [`docs/plan-B2.md`](docs/plan-B2.md). It is deliberately dropped and explained rather than
left as a gap, so the rows above are renumbered into a continuous 1–11.

---

## Development

```bash
node --test "test/*.test.mjs"      # pure fold + host/client contracts + UI contract + hooks
```

- **No build step**: `lib/` is source and artifact at once.
- **No zod**: projection schemas use a passthrough stub (see `docs/design.md` §2.3).
- **Verify without opening the GUI** — replay a real committed session log:

  ```bash
  node tools/replay-log.mjs <session.v4.jsonl.zstd> [--peek] [--max N] [--stall-ms N]
  ```

  It runs the exact same fold and labels over the log, printing which event changed the strip to what, and finally **the longest tool-silence window** — i.e. what the strip was showing during it. Measured on this session:

  ```
  # jsonl lines 1182      # parseable events 1182 (bad lines skipped 0)
  # longest tool window: pwsh silent 50.4s (at session +52m34s,
  #   strip should read "执行工具(pwsh)  50.4s")
  ```

  (Session logs live in `D:\deepseek-harness\sessions\<workspace-slug>\session-<id>\session.v4.jsonl.zstd` and are **multi-frame** zstd; the tool splits on the `28 B5 2F FD` magic and inflates frame by frame.)
- Layout: `lib/state.js` (pure fold: no services, no `Date.now()`, no third-party dependency; one Node builtin import — `node:crypto` for the A2 tool-argument fingerprint), `lib/index.js` (host half: the `turbo` wire projection plus B1 gear switching and the B3/C/D post-execute hooks), `lib/config.js` (the config schema built from `DEFAULT_CONFIG`, the live-config reader, and volatile-value unwrapping), `lib/gears.js` (B1 judgment, zero imports, tool-trajectory only), `lib/spill.js` (B3 — hands oversized results to the host's spill backend and renders the locator notice), `lib/notes.js` (C1/C2/C3 note texts and judgments, plus tool aggregation for the detail panel), `lib/handoff.js` (0.7.0 handoff export: threshold/throttle/freshness judgments, bili command probing, export argv), `lib/rotation.js` (pure rotation judgment `shouldRotate`, fed by the same `handoffExport*` thresholds), `lib/rotation-host.js` (0.9.0 plan B host action: creates the blank child session and writes the seed message — never throws), `lib/client.js` (client half: the summary cell at `conversation.composer.dock`, the detail panel at `conversation.input.dock`, and the New session card at the bottom of the plugin's settings page), `tools/replay-log.mjs` (offline replay), `test/hooks.test.mjs` + `test/ui-contract.test.mjs` (host-hook and UI-contract guards), `test/panel.test.mjs` (0.18.0 New session page guard: text card, copy button and its two messages, three-state fallback, icon and registration), `test/mirror.test.mjs` + `test/client-audit.test.mjs` (config-mirror / wire-version and client-audit guards), plus the per-pillar test files for the fold, gears, notes, spill, handoff, rotation and the two halves.

---

## Design constraints (non-negotiable)

- Reads **only committed session-log events** (via a projection). No host memory, no polling, no DOM injection, no React-fiber walking.
- No network requests, no routes. **Writes only its own data:** *dsh-status-turbo itself* does import write APIs (`existsSync` from `node:fs` and `mkdir` / `readFile` / `readdir` / `rename` / `writeFile` from `node:fs/promises`, `lib/index.js:58-59`), and it touches writes in exactly two places, both of them its own data: ① the oversized result body for B3 is **delegated to the host's existing spill backend** (`spillStore.saveText`) and the plugin only prints back the absolute path it was handed — it opens no file for that path itself; ② since 0.7.0 the handoff export creates its directory and drops a `.gitignore` into it (`lib/index.js:538`, content in `lib/handoff.js:246`). Both of those calls goes through the plugin's own `hostIo` seam (`lib/index.js:436`) — it writes to disk no other way, and it never writes user settings.
- Never touches `agent-default-model`, compaction config, or any user setting.
- Never rewrites tool arguments or intercepts tools.
- Every failure must **surface** (in the UI, or at minimum a `console.error` naming the cause). Silent `return` is not allowed.

---

## License

MIT — see `LICENSE`. Third-party notes in `THIRD_PARTY_NOTICES.md`.
