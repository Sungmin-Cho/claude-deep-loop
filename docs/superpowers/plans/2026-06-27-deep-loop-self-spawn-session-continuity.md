# deep-loop Self-Spawning Session Continuity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the previous deep-loop session automatically open a new **visible** (user-watchable, interruptible) Claude session via the detected terminal/multiplexer launcher, OS/terminal-agnostic, falling back to needs-human when no launcher is verifiable — never silently headless.

**Architecture:** Approach A — a kernel `visibleSpawn(entry)` spawnFn symmetric to the existing `headlessSpawn`, wired through the canonical `respawn` (gate→CAS→handshake). A new pure `detect-terminal.mjs` identifies the launcher (fail-closed, positive-host-signal tiers); `buildLaunchCommand` produces per-launcher `{bin,argv,display,cwd?}` entries (argv form — no shell re-parse); `pause`(preserve/rollback)+`recover`(human escape) + `detect-terminal` are new lease-fenced CLI subcommands; `driveHeadless`/`precompact`/`acquireLease` are reconciled with the new rules.

**Tech Stack:** Node ≥ 20, `type: module`, **zero external dependencies**, `node --test`. Durable state is JSON (no YAML parser). Hooks are Bash 3.2.

**Source spec:** `docs/superpowers/specs/2026-06-26-self-spawn-session-continuity-design.md` (decisions §0 1-49). **Research:** `docs/research/2026-06-25-self-spawn-terminal-spawn-mechanisms.md`.

## Global Constraints

- **Zero external dependencies.** Node ≥ 20, `type: module`. Durable state = JSON.
- **Determinism:** every time/env/exec-dependent function takes injectable `now` (ms/ISO), `env` (default `process.env`), `platform` (default `process.platform`), `run`/`spawnFn` (default real). Tests pass fixed values — never rely on `Date.now()` with a fixed `created_at`.
- **2-plane boundary:** SKILL.md files only **read** state; every mutation goes through a kernel CLI subcommand. A SKILL.md must never instruct a direct write to `loop.json`/`event-log.jsonl`/`.loop.hash`. `tests/skills.test.mjs` enforces this.
- **Every mutating CLI is lease-fenced** (`--owner <run_id> --generation <n>`) checked **inside** the same lock/preCheck that mutates. Exit codes: **3 = fence** (`LEASE_FENCED`/`FENCE_REQUIRED`), 2 = usage/unknown, 1 = invalid value.
- **Event + state change = one `integrity.appendAnchored(...)` transaction.** Never call `appendEvent` raw.
- **No writes outside project root** (`<root>/.deep-loop/`). `runId` is a single safe path segment.
- **`withLock` is non-reentrant** — never lock inside a locked callback.
- **`state.classifyPatch` is the patch whitelist (default-deny).** New fields written by dedicated fenced subcommands (not generic `state patch`) need no classifyPatch entry.
- **Baseline:** `npm test` = 327 tests green before starting; keep green; each task adds tests and ends green. One focused commit per task. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **KK (user-decided): visible is the DEFAULT.** `--attended` is a best-effort declaration, NOT a security boundary. The real hard bound for all paths = kernel `max_sessions`+`wallclock`+`per_session_turn_cap`+headless-invocation detection (matches existing spec §9).

---

## File Structure

```
NEW   scripts/lib/detect-terminal.mjs        detectTerminal({env,platform,run,now,allowPowershellVisible}) → descriptor (pure + injected probe)
MOD   scripts/lib/handoff.mjs                buildLaunchCommand → per-launcher {bin,argv,display,cwd?} entries (argv form, q/escApple/psq)
MOD   scripts/lib/spawn-driver.mjs           + visibleSpawn(entry,{launcher,run}); defaultRun → (bin,argv,{timeout,cwd}); headlessSpawn → entry shape
MOD   scripts/lib/state.mjs                  pauseRun → fenced + preserve/rollback + expires_at/resume_policy; + recoverRun; mutation gate rejects status==='paused'
MOD   scripts/lib/lease.mjs                  acquireLease → preserve-resume unpause (status=running + clear pause_reason/resume_policy) when reserved child takes a paused run
MOD   scripts/lib/respawn.mjs                mode selection (spawn_style/attended/launcher gate) + bounded child-readiness + entry from session_spawn.launcher
MOD   scripts/lib/initrun.mjs               autonomy.spawn_style='visible' default; unattended_detect drops 'non-tty'; + child_ready_timeout_sec, allow_powershell_visible; + session_spawn initial block
MOD   schemas/loop-run.schema.json           session_spawn block; spawn_style enum +'visible'; autonomy fields; pause_reason/resume_policy (additive)
MOD   scripts/deep-loop.mjs                  CLI: detect-terminal, pause, recover subcommands; respawn handler injects visibleSpawn (fenced)
MOD   scripts/hooks-impl/drive-headless.mjs  skip resume_policy==='human' handoffs; headless-invocation always headless
MOD   scripts/hooks-impl/precompact-handoff.mjs  drop `|| input.tty === false` from headless calc
MOD   skills/deep-loop-{continue,handoff,resume}/SKILL.md + skills/deep-loop-workflow/references/handoff-respawn.md  visible decision flow (read-only/CLI)
NEW   tests/detect-terminal.test.mjs · MOD tests/{spawn-driver,respawn,state,lease,initrun,schema,handoff,precompact-hook,skills,fencing}.test.mjs
```

Implementation order = dependency order (Task 1 → 13). Each task is independently testable.

---

### Task 1: Schema + initrun — session_spawn block, spawn_style enum, autonomy fields

**Files:**
- Modify: `schemas/loop-run.schema.json` (enums + session_spawn)
- Modify: `scripts/lib/initrun.mjs:19-20` (autonomy/budget defaults + session_spawn)
- Test: `tests/schema.test.mjs`, `tests/initrun.test.mjs`

**Interfaces:**
- Produces: `loop.autonomy.spawn_style ∈ {visible,interactive,headless}` (default `'visible'`); `loop.autonomy.unattended_detect` without `'non-tty'`; `loop.autonomy.child_ready_timeout_sec:number` (default 75); `loop.autonomy.allow_powershell_visible:boolean` (default false); `loop.session_spawn` object (optional/additive); `loop.pause_reason`, `loop.session_chain.lease.resume_policy` (additive, written later).

- [ ] **Step 1: Write failing schema test** — `tests/schema.test.mjs`: a loop with `autonomy.spawn_style:'visible'` + a `session_spawn` block validates; `spawn_style:'bogus'` fails.

```js
test('spawn_style enum accepts visible; session_spawn additive validates', () => {
  const loop = buildInitialLoop({ runId: 'r1', goal: 'g', recipe: {}, routing: {}, project: {} , now: new Date('2026-06-27T00:00:00Z')}); // buildInitialLoop calls now.toISOString()
  loop.autonomy.spawn_style = 'visible';   // exercise the NEW enum value (default may already be 'visible' post-Task1, but assert it explicitly)
  loop.session_spawn = { platform:'darwin', launcher:'cmux', launcher_bin:'/x/cmux', surface:'workspace', reachable:true, visible:true, signals:{}, probe:{cmd:'x ping',code:0}, reason:null, fallback:'launch-command-file', detected_at:'2026-06-27T00:00:00Z' };
  assert.equal(validateLoop(loop).ok, true);   // FAILS before schema change: 'visible' not in enum
  loop.autonomy.spawn_style = 'bogus';
  assert.equal(validateLoop(loop).ok, false);
});
```

- [ ] **Step 2: Run → fail** — `node --test tests/schema.test.mjs` → FAIL (`visible` not in enum / session_spawn rejected).
- [ ] **Step 3: Edit schema** — in `schemas/loop-run.schema.json`: `enums."autonomy.spawn_style": ["visible","interactive","headless"]`; add `enums."session_spawn.launcher": ["cmux","iterm2","terminal-app","wt","powershell","none"]`; add optional `properties.session_spawn` (object, additive — no `required`), optional `properties.pause_reason` (string), and `session_chain.lease.resume_policy` (string). Keep `status` enum unchanged. **The dotted-path validator must SKIP the `session_spawn.launcher` enum check when `session_spawn` is absent/null (R5-plan)** — else a `session_spawn:null` run fails enum validation. (Belt-and-suspenders with Step 4's valid-descriptor init.) Mirror the builder self-test.
- [ ] **Step 4: Edit initrun** — `scripts/lib/initrun.mjs`: set `spawn_style: 'visible'`; change `unattended_detect: ['driver:cron|loop', '--unattended', 'headless-invocation']` (drop `'non-tty'`; **add `'headless-invocation'`** token, R1-plan finding A); add `child_ready_timeout_sec: 75`, `allow_powershell_visible: false`. **For `session_spawn`, initialize a VALID `none` descriptor (NOT `null`, R5-plan): `{ platform: process.platform, launcher:'none', launcher_bin:null, launcher_socket:null, surface:null, reachable:false, visible:false, signals:{}, probe:null, reason:'not-detected', fallback:'launch-command-file', detected_at: now.toISOString() }`** so new runs pass enum validation immediately. Task 3 replaces it with real `detectAndPersist` at init/first-tick.

> **No-regression ordering (R1-plan finding A):** removing `'non-tty'` does NOT open a visible-by-default hole because the visible decision is **only acted on by the respawn mode-gate (Task 9)**, which is **fail-closed**: visible requires `spawn_style==='visible'` AND `--attended` AND a positive launcher; otherwise → `pause --mode preserve` (needs-human). Task 9 (the gate) lands **before** Task 11 (precompact tty removal), so there is no window where non-tty is gone but the fail-closed gate is absent. The residual (automation that *mints* `--attended`) is the user-accepted KK=A risk, bounded by hard caps (`max_sessions`/`wallclock`/`per_session_turn_cap`). The `'headless-invocation'` token is the concrete strengthening: the kernel treats a positively-detected non-interactive Claude entrypoint as unattended (→ headless). Its exact signal is investigated in Task 9 (open-question §14-5); **fail-closed default** if undetermined = the precedence's pause branch.
- [ ] **Step 5: Update initrun test** — `tests/initrun.test.mjs`: assert `spawn_style==='visible'`, `unattended_detect` excludes `'non-tty'`, `child_ready_timeout_sec===75`, `allow_powershell_visible===false`.
- [ ] **Step 6: Run all → green** — `npm test`. Expected: PASS (327 + new).
- [ ] **Step 7: Commit** — `git add schemas/loop-run.schema.json scripts/lib/initrun.mjs tests/schema.test.mjs tests/initrun.test.mjs && git commit -m "feat(schema): session_spawn block + spawn_style 'visible' default + autonomy fields"`

---

### Task 2: `detect-terminal.mjs` — pure fail-closed launcher detection

**Files:**
- Create: `scripts/lib/detect-terminal.mjs`
- Test: `tests/detect-terminal.test.mjs`

**Interfaces:**
- Produces: `detectTerminal({ env=process.env, platform=process.platform, run=defaultProbeRun, now, allowPowershellVisible=false }) → descriptor` where descriptor = `{platform, launcher, launcher_bin, launcher_socket, surface, reachable, visible, signals, probe, reason, fallback:'launch-command-file', detected_at}`. **`launcher_socket` = the exact `CMUX_SOCKET_PATH` used by the probe (cmux), else `null` (R7-plan — persist so launch uses the SAME socket).** `run(bin, argv, {timeoutMs}) → {code:number}` is the injected non-invasive probe runner. `launcher ∈ {cmux,iterm2,terminal-app,wt,powershell,none}`.

**Ladder (spec §3, fail-closed, positive host signal):**
1. `env.CMUX_BUNDLED_CLI_PATH` (absolute) AND **`env.CMUX_SOCKET_PATH`** (explicit socket — R6-plan: the explicit-socket fail-closed premise; do NOT rely on cmux default/auto-discovery) AND (`env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID`) → probe `run(cmux_bin,['--socket', CMUX_SOCKET_PATH, 'ping'])` (pass the explicit socket): code 0 → `cmux` (persist `launcher_bin=CMUX_BUNDLED_CLI_PATH` AND the socket path in `session_spawn` so spawn uses the SAME socket); else `none` reason `'cmux-socket-denied'`. No bundled bin → `none` `'cmux-no-bundled-bin'`. No `CMUX_SOCKET_PATH` → `none` `'cmux-no-socket'`. No surface → `none` `'cmux-no-surface'`. (No bare `cmux` / default-socket fallback.) **Test: bundled bin + surface but NO `CMUX_SOCKET_PATH` → `none`.**
1.5. else `env.TMUX || env.STY` → `none` reason `'multiplexer-v1-unsupported'`.
2. else `platform==='darwin'`: `TERM_PROGRAM==='iTerm.app'` → probe `run('osascript',['-e','id of application "iTerm"'])` code 0 → `iterm2` else `none`; `TERM_PROGRAM==='Apple_Terminal'` → probe `id of application "Terminal"` code 0 → `terminal-app` else `none`; else `none` reason `'no-host-signal'`.
3. else `platform==='win32'`: `WT_SESSION` → probe `run('where',['wt.exe'])` code 0 → `wt`; else if `allowPowershellVisible` AND `run('where',['powershell'])` code 0 → `powershell`; else `none` reason `'powershell-needs-optin'|'no-host-signal'`.
4. else → `none` reason `'no-host-signal'`.

`launcher_bin`: cmux → `CMUX_BUNDLED_CLI_PATH`; else `null`. `surface`: cmux→`workspace`, darwin→`window`, wt→`tab`, powershell→`window`, none→`null`. `visible = launcher!=='none'`. `reachable = launcher!=='none'`. `signals` records `{term_program, cmux_socket:!!CMUX_BUNDLED_CLI_PATH, wt_session:!!WT_SESSION, tmux:!!TMUX, sty:!!STY}`.

- [ ] **Step 1: Write failing tests** — `tests/detect-terminal.test.mjs`:

```js
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { detectTerminal } from '../scripts/lib/detect-terminal.mjs';
const ok = () => ({ code: 0 }); const fail = () => ({ code: 1 });
const NOW = '2026-06-27T00:00:00Z';

test('cmux: bundled bin + surface + ping ok → cmux', () => {
  const d = detectTerminal({ env: { CMUX_BUNDLED_CLI_PATH:'/a/cmux', CMUX_WORKSPACE_ID:'w1', TERM_PROGRAM:'ghostty' }, platform:'darwin', run: ok, now: NOW });
  assert.equal(d.launcher, 'cmux'); assert.equal(d.launcher_bin, '/a/cmux'); assert.equal(d.reachable, true);
});
test('cmux: ping fail → none fail-closed, no downgrade', () => {
  const d = detectTerminal({ env: { CMUX_BUNDLED_CLI_PATH:'/a/cmux', CMUX_SURFACE_ID:'s1', TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: fail, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'cmux-socket-denied');
});
test('cmux: socket only, no surface → none', () => {
  const d = detectTerminal({ env: { CMUX_BUNDLED_CLI_PATH:'/a/cmux' }, platform:'darwin', run: ok, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'cmux-no-surface');
});
test('darwin tmux → none multiplexer-v1-unsupported (TERM_PROGRAM stale)', () => {
  const d = detectTerminal({ env: { TMUX:'/tmp/tmux-0/default,1,0', TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: ok, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'multiplexer-v1-unsupported');
});
test('darwin iTerm2 installed → iterm2; not installed → none', () => {
  assert.equal(detectTerminal({ env:{ TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: ok, now: NOW }).launcher, 'iterm2');
  assert.equal(detectTerminal({ env:{ TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: fail, now: NOW }).launcher, 'none');
});
test('darwin Apple_Terminal id ok → terminal-app', () => {
  assert.equal(detectTerminal({ env:{ TERM_PROGRAM:'Apple_Terminal' }, platform:'darwin', run: ok, now: NOW }).launcher, 'terminal-app');
});
test('win32 WT_SESSION → wt; powershell needs opt-in', () => {
  assert.equal(detectTerminal({ env:{ WT_SESSION:'x' }, platform:'win32', run: ok, now: NOW }).launcher, 'wt');
  assert.equal(detectTerminal({ env:{}, platform:'win32', run: ok, now: NOW, allowPowershellVisible:false }).launcher, 'none');
  assert.equal(detectTerminal({ env:{}, platform:'win32', run: ok, now: NOW, allowPowershellVisible:true }).launcher, 'powershell');
});
test('linux / no signal → none', () => {
  assert.equal(detectTerminal({ env:{}, platform:'linux', run: ok, now: NOW }).launcher, 'none');
});
```

- [ ] **Step 2: Run → fail** — `node --test tests/detect-terminal.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement** — `scripts/lib/detect-terminal.mjs` with the ladder above. `defaultProbeRun(bin,argv,{timeoutMs=5000})` = `spawnSync(bin, argv, {timeout: timeoutMs, stdio:'ignore'})` → `{code: r.status ?? 1}` (**`timeout: timeoutMs` — only `timeoutMs` is in scope, R5-plan**; non-invasive; never opens a window). Pure signal reads; only probe uses `run`.
- [ ] **Step 4: Run → pass** — `node --test tests/detect-terminal.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add scripts/lib/detect-terminal.mjs tests/detect-terminal.test.mjs && git commit -m "feat(detect-terminal): fail-closed positive-host-signal launcher detection"`

---

### Task 3: `detect-terminal` CLI subcommand (fenced, releasing-safe) + init-detect wiring

**Files:**
- Modify: `scripts/deep-loop.mjs` (new `detect-terminal` handler)
- Modify: `scripts/lib/initrun.mjs` (init-time detect for initial `session_spawn`)
- Test: `tests/cli-skillface.test.mjs` or `tests/fencing.test.mjs`

**Interfaces:**
- Produces CLI: `deep-loop detect-terminal --owner <id> --generation <n> [run-id]` → writes `loop.session_spawn` via `appendAnchored({type:'terminal-detected', data:{launcher}}, writer, preCheck)`; **releasing-safe** (preCheck checks owner/generation only, does NOT apply the releasing business-write carve-out — session_spawn is metadata). Prints descriptor JSON. Exit 3 on fence mismatch.

- [ ] **Step 1: Write failing test** — fence (no/wrong owner/generation → exit 3); success writes session_spawn + emits `terminal-detected` event in one transaction; re-detect is idempotent (overwrites); works when `lease.state==='releasing'` (no `lease-releasing-carveout`). Inject env/platform/run via a test seam (the handler reads `process.env`/`process.platform`; test sets them or the handler accepts injected values through a non-exported helper invoked by the test). Prefer testing the lib helper `detectAndPersist(root,runId,{owner,generation,env,platform,run,now})` directly + a thin CLI wrapper.
- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — add `detectAndPersist(root, runId, {owner, generation, env=process.env, platform=process.platform, run, now})` to `detect-terminal.mjs`: `reconcileBudget`; compute descriptor (passing `allowPowershellVisible` from `loop.autonomy.allow_powershell_visible`); `appendAnchored(root, runId, {type:'terminal-detected', data:{launcher: d.launcher}}, (l)=>{ l.session_spawn = d; }, (l)=>{ const lease=l.session_chain.lease; if (lease.owner_run_id!==owner || lease.generation!==generation) throw new Error('LEASE_FENCED: detect-terminal'); })`. Wire CLI handler in `deep-loop.mjs` mapping flags → `detectAndPersist`, exit codes per convention. In `initrun.mjs`, replace the Task-1 `session_spawn: null` with `detectTerminal({env,platform,run,now,allowPowershellVisible:false})`.
- [ ] **Step 4: Run → pass**.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): detect-terminal fenced releasing-safe subcommand + init detect"`

---

### Task 4: `buildLaunchCommand` → launcher-aware argv entries

**Files:**
- Modify: `scripts/lib/handoff.mjs:10-22` (`buildLaunchCommand`)
- Test: `tests/handoff.test.mjs`

**Interfaces:**
- Produces: `buildLaunchCommand({root,parentRunId,childRunId,handoffRel,launcher,launcherBin}) → { cmux:{bin,argv,display}, iterm2:{bin,argv,display}, 'terminal-app':{bin,argv,display}, wt:{bin,argv,display}, powershell:{bin,argv,display}, headless:{bin:'claude',argv,cwd:root,display}, interactive:{display} }`. Helpers: `q(s)` POSIX single-quote wrap (`'`→`'\''`), `escApple(s)` (`\`→`\\` then `"`→`\"`), `psq(s)` (`'`→`''`).

- [ ] **Step 1: Write failing tests** — `tests/handoff.test.mjs`:

```js
test('cmux entry: --command quotes only dynamic args, bin=launcherBin', () => {
  const c = buildLaunchCommand({ root:"/p a", parentRunId:'P', childRunId:'C', handoffRel:'handoffs/x.md', launcher:'cmux', launcherBin:'/a/cmux' });
  assert.equal(c.cmux.bin, '/a/cmux');
  assert.deepEqual(c.cmux.argv.slice(0,4), ['new-workspace','--cwd','/p a','--command']);
  // --command is shell text with only dynamic args quoted; whole string NOT wrapped in q()
  assert.match(c.cmux.argv[4], /^claude -n 'deep-loop-C' '.*deep-loop-resume'$/);
});
test('headless entry has no bash; uses cwd', () => {
  const c = buildLaunchCommand({ root:'/p', parentRunId:'P', childRunId:'C', handoffRel:'handoffs/x.md', launcher:'none' });
  assert.equal(c.headless.bin, 'claude'); assert.equal(c.headless.cwd, '/p');
  assert.ok(!c.headless.argv.includes('-c')); assert.ok(c.headless.bin !== 'bash');
});
test('osascript inner cd uses q(root) (apostrophe root safe)', () => {
  const c = buildLaunchCommand({ root:"/p's", parentRunId:'P', childRunId:'C', handoffRel:'handoffs/x.md', launcher:'terminal-app' });
  assert.equal(c['terminal-app'].bin, 'osascript');
  assert.match(c['terminal-app'].argv[1], /do script ".*cd '\/p'\\''s'/); // q() escapes the apostrophe
});
test('powershell uses -EncodedCommand of psq-escaped inner', () => {
  const c = buildLaunchCommand({ root:"/p", parentRunId:'P', childRunId:'C', handoffRel:'handoffs/x.md', launcher:'powershell' });
  // argv = ['-Command', "Start-Process powershell -ArgumentList '-NoExit','-EncodedCommand','<B64>'"]
  // → -EncodedCommand lives INSIDE the -Command string (not a top-level argv element); extract+decode from there
  assert.equal(c.powershell.argv[0], '-Command');
  const cmdStr = c.powershell.argv[1];
  const b64 = cmdStr.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  const decoded = Buffer.from(b64, 'base64').toString('utf16le');
  assert.match(decoded, /Set-Location -LiteralPath '\/p'/); // psq applied; root with ' would be doubled to ''
});
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — rewrite `buildLaunchCommand` to return the entry map. `resumePrompt = "Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume"`; `inner = deep-loop-${childRunId}`. cmux argv: `['--socket', launcherSocket, 'new-workspace','--cwd',root,'--command',`claude -n ${q(inner)} ${q(resumePrompt)}`,'--focus','true']` (**pass the persisted `launcher_socket` so the spawn targets the SAME socket the probe verified — R7-plan; `buildLaunchCommand` takes `launcherSocket` from `session_spawn.launcher_socket`, threaded by respawn/emitHandoff alongside `launcherBin`**). iterm2: `['-e',`tell application "iTerm" to create window with default profile command "${escApple(`cd ${q(root)} && claude -n ${inner} "${resumePrompt}"`)}"`]`. terminal-app: `['-e',`tell application "Terminal" to do script "${escApple(`cd ${q(root)} && claude -n ${inner} "${resumePrompt}"`)}"`]`. wt: `['-d',root,'claude','-n',inner,resumePrompt]`. powershell: build `innerPS = `Set-Location -LiteralPath ${"'"+psq(root)+"'"}; & claude -n ${"'"+psq(inner)+"'"} ${"'"+psq(resumePrompt)+"'"}``, `b64=Buffer.from(innerPS,'utf16le').toString('base64')`, argv `['-Command',`Start-Process powershell -ArgumentList '-NoExit','-EncodedCommand','${b64}'`]`. headless: `{bin:'claude', argv:['-p',resumePrompt,'--output-format','json','--permission-mode','acceptEdits'], cwd:root, display:`cd ${q(root)} && claude -p "${resumePrompt}" --output-format json --permission-mode acceptEdits`}`. interactive: `{display:`cd ${q(root)} && claude -n ${inner} "${resumePrompt}"`}`. (**`display` uses `q(root)` — the concrete snippet, not just the prose, R5-plan**; `launch-command.txt` is human-copied.) Each non-headless/interactive entry also carries a human `display` string. **`display` strings are also safely escaped (R2-plan finding): use `cd ${q(root)} && claude -n ${inner} "${resumePrompt}"` in headless/interactive `display` too** — `launch-command.txt` is copied by a human, so a root with a quote/semicolon/newline must not break/inject. Add display-escaping tests (quotes/semicolons/spaces/newlines in `root`). Validate **`childRunId` AND `parentRunId`** match `^[A-Za-z0-9_-]+$` (R6-plan: `parentRunId` is interpolated into `resumePrompt` which is double-quote-embedded in osascript/display — a run id with `$(...)`/`"` would shell-expand; validate it like childRunId) and `handoffRel` matches `^handoffs/[A-Za-z0-9._-]+$` else throw `UNSAFE_SPAWN_ARG`. (run ids are ULIDs so this always passes for real ids; the guard is defense-in-depth.) Keep `emitHandoff`'s `launch-command.txt` writing all `display` strings.
- [ ] **Step 3b: ATOMIC consumer migration (keep `npm test` green — R2-plan finding)** — the entry-shape change touches coupled spots; commit together: (1) `scripts/lib/spawn-driver.mjs` `headlessSpawn` accepts entry `{bin:'claude',argv,cwd}` + `defaultRun(bin,argv,{timeoutMs,cwd})` (keep usage-parse+fail-closed); (2) `scripts/lib/respawn.mjs` `const entry = headless ? cmds.headless : cmds.interactive; spawnFn(entry)` (behavior preserved; mode-gate in Task 9); (3) `scripts/hooks-impl/drive-headless.mjs` passes entry; (4) adapt existing `tests/respawn.test.mjs`/`tests/spawn-driver.test.mjs` fixtures string→entry. (`visibleSpawn` ADDED additively in Task 5.)
- [ ] **Step 4: Run → pass** (`npm test` — all consumers consistent).
- [ ] **Step 5: Commit** — `git add scripts/lib/handoff.mjs scripts/lib/spawn-driver.mjs scripts/lib/respawn.mjs scripts/hooks-impl/drive-headless.mjs tests/handoff.test.mjs tests/spawn-driver.test.mjs tests/respawn.test.mjs && git commit -m "feat(handoff): launcher-aware argv entries + atomic entry-shape consumer migration (q/escApple/psq)"`

---

### Task 5: `visibleSpawn` (spawn-driver.mjs) — additive

> **Note:** `defaultRun(bin,argv,{timeoutMs,cwd})` generalization + `headlessSpawn` entry-shape were already done in Task 4's atomic consumer migration (Step 3b). This task ADDS the new `visibleSpawn` function (additive → green).

**Files:**
- Modify: `scripts/lib/spawn-driver.mjs` (add `visibleSpawn`)
- Test: `tests/spawn-driver.test.mjs`

**Interfaces:**
- Produces: `visibleSpawn(entry, {launcher, timeoutMs=30000, run=defaultRun}) → {ok:true} | {ok:false, reason}` (exit 0 → ok = launch issued, no usage parse). Consumes the `defaultRun(bin,argv,{timeoutMs,cwd})` from Task 4.

- [ ] **Step 1: Write failing tests** — `tests/spawn-driver.test.mjs`:

```js
test('visibleSpawn: exit 0 → ok (launch issued, no usage)', () => {
  const r = visibleSpawn({ bin:'cmux', argv:['new-workspace'] }, { launcher:'cmux', run:()=>({code:0}) });
  assert.deepEqual(r, { ok:true });
});
test('visibleSpawn: nonzero/timeout/throw → fail', () => {
  assert.equal(visibleSpawn({bin:'x',argv:[]},{launcher:'wt',run:()=>({code:7})}).ok, false);
  assert.equal(visibleSpawn({bin:'x',argv:[]},{launcher:'wt',run:()=>({timedOut:true})}).reason, 'launch-timeout');
  assert.equal(visibleSpawn({bin:'x',argv:[]},{launcher:'wt',run:()=>{throw new Error('boom');}}).ok, false);
});
test('defaultRun passes cwd; headlessSpawn still parses usage / fail-closed', () => {
  const r = headlessSpawn({ bin:'claude', argv:['-p','x'], cwd:'/p' }, { run:()=>({code:0, stdout:'{"num_turns":3}'}) });
  assert.equal(r.ok, true); assert.equal(r.usage.num_turns, 3);
  assert.equal(headlessSpawn({bin:'claude',argv:[],cwd:'/p'},{run:()=>({code:0,stdout:'no metric'})}).reason, 'unmeasurable-fail-closed');
});
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — generalize `defaultRun` to `(bin, argv, {timeoutMs, cwd})` = `spawnSync(bin, argv, {encoding:'utf8', timeout:timeoutMs, cwd})`. `visibleSpawn`: `try { out = run(entry.bin, entry.argv, {timeoutMs, cwd: entry.cwd}); } catch(e){ return {ok:false, reason:`spawn-error: ${e.message||e}`}; }` then `if (out.timedOut) return {ok:false,reason:'launch-timeout'}; if ((out.code ?? null) !== 0) return {ok:false,reason:`launch-exit-${out.code}`}; return {ok:true};` (no usage parse). Refactor `headlessSpawn(cmd-or-entry)` to accept the entry shape `{bin,argv,cwd}` and call `run(bin,argv,{timeoutMs,cwd})`, keeping `parseUsage`+fail-closed. Update `drive-headless.mjs` call site to pass the entry (handled in Task 10).
- [ ] **Step 4: Run → pass**. Also run `npm test` to ensure existing spawn-driver tests still pass (adapt any that passed a string cmd).
- [ ] **Step 5: Commit** — `git commit -m "feat(spawn-driver): visibleSpawn + defaultRun(bin,argv,cwd) generalization (headlessSpawn entry shape)"`

---

### Task 6: `state.mjs` `pauseRun` (preserve/rollback) + `deep-loop pause` CLI + paused-rejects-mutation

**Files:**
- Modify: `scripts/lib/state.mjs` (`pauseRun`), `scripts/lib/lease.mjs` (`leaseCheck` paused-gate), `scripts/deep-loop.mjs` (**`pause` CLI handler** — R2-plan: skills call `deep-loop pause`, so the handler must exist)
- Test: `tests/state.test.mjs`, `tests/cli-skillface.test.mjs` (pause CLI), `tests/fencing.test.mjs`

**Interfaces:**
- Produces: `pauseRun(root, runId, {reason, mode:'preserve'|'rollback', expect:{owner,generation}, now}) → result`. Mutation gate: a helper `assertMutable(loop)` (or the existing fenced-write path) rejects when `loop.status==='paused'` with `RUN_PAUSED` except for recover/resume transitions.

**Behavior (spec §7/§8/§9):**
- `preserve`: `appendAnchored({type:'run-paused', data:{reason,mode:'preserve'}}, (l)=>{ l.status='paused'; l.pause_reason=reason; l.session_chain.lease.resume_policy='human'; l.session_chain.lease.expires_at=null; }, preCheck owner/generation)` — keeps `state:'releasing'` + `handoff_child_run_id` intact. **releasing-safe** (preCheck owner/generation only).
- `rollback`: same but `(l)=>{ l.status='paused'; l.pause_reason=reason; const lease=l.session_chain.lease; lease.state='active'; lease.handoff_phase='idle'; lease.handoff_child_run_id=null; lease.handoff_idempotency_key=null; lease.expires_at=null; }` (invalidate reserved child → no gate bypass; parent fence neutralized by paused-rejects-mutation).

- [ ] **Step 1: Write failing tests** — `tests/state.test.mjs`:

```js
test('pauseRun preserve: status=paused, lease releasing kept, resume_policy=human, expires_at=null', () => {
  // seed loop with lease {owner_run_id:'P',generation:1,state:'releasing',handoff_child_run_id:'C',expires_at:'...'}
  pauseRun(root, runId, { reason:'needs-human:no-launcher', mode:'preserve', expect:{owner:'P',generation:1}, now });
  const { data } = readState(root, runId);
  assert.equal(data.status,'paused'); assert.equal(data.pause_reason,'needs-human:no-launcher');
  assert.equal(data.session_chain.lease.state,'releasing');
  assert.equal(data.session_chain.lease.handoff_child_run_id,'C');
  assert.equal(data.session_chain.lease.resume_policy,'human');
  assert.equal(data.session_chain.lease.expires_at,null);
});
test('pauseRun rollback: lease back to parent, reserved child invalidated', () => {
  pauseRun(root, runId, { reason:'gate:budget', mode:'rollback', expect:{owner:'P',generation:1}, now });
  const { data } = readState(root, runId);
  assert.equal(data.session_chain.lease.state,'active');
  assert.equal(data.session_chain.lease.handoff_child_run_id,null);
});
test('pauseRun fenced: wrong generation → fence error, no write', () => {
  assert.throws(()=>pauseRun(root, runId, { reason:'x', mode:'preserve', expect:{owner:'P',generation:99}, now }), /LEASE_FENCED/);
});
test('paused run rejects representative fenced mutators (RUN_PAUSED) — common leaseCheck path', () => {
  pauseRun(root, runId, { reason:'gate:budget', mode:'rollback', expect:{owner:'P',generation:1}, now });
  // RUN_PAUSED lives in leaseCheck (the common fence) so ALL mutating paths reject — not just patch.
  const f = { owner:'P', generation:1 };
  assert.throws(()=>newEpisode(root, runId, { /*…*/ }, { fence:f }), /RUN_PAUSED/);
  assert.throws(()=>setWorkstreamStatus(root, runId, wsId, 'ready', { fence:f }), /RUN_PAUSED/);
  assert.throws(()=>recordReviewOutcome(root, runId, { /*…*/ }, { fence:f }), /RUN_PAUSED/);
  // exemptions: recover / resume-acquire / breaker reset are allowed (see Tasks 7,8 + breaker)
});
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — rewrite `pauseRun` to the fenced two-mode form above using `appendAnchored` (event `run-paused` + state, single transaction; preCheck owner/generation; releasing-safe). **Put the `status==='paused'` → `RUN_PAUSED` rejection in a SHARED state-transition guard that EVERY mutating path runs — not only `leaseCheck` (R4-plan finding).** Audit the mutating entry points: `patch`, `episode`, `workspace`, `review`, `finish` route through `leaseCheck`; but `emitHandoff`(via `reserveHandoff`), `respawn`, and `precompact`→`emitHandoff` have their OWN `appendAnchored` preChecks that may bypass `leaseCheck`. Add the `RUN_PAUSED` check to the common `appendAnchored` fence helper (or a `assertNotPausedForBusiness(loop, intent)` called by every mutating preCheck) so handoff-emit/respawn/precompact on a paused run are also rejected. **Exemptions** (via an `intent` flag): `recover` (Task 7), `resume-acquire` (Task 8), and **`breaker reset --confirm`** (existing human recovery — must not be rejected, R1-plan). **Negative tests (R4-plan):** assert `RUN_PAUSED` for representative business mutators (`newEpisode`/`setWorkstreamStatus`/`recordReviewOutcome`) AND for `emitHandoff`/`respawn`/`runPreCompactHandoff` on a paused run. Update `drive-headless`/`precompact` `pauseRun` callers (Tasks 10/11).
- [ ] **Step 3b: Add `deep-loop pause` CLI handler** — `scripts/deep-loop.mjs`: `pause --owner <id> --generation <n> --reason <r> [--mode preserve|rollback]` (default `preserve`) → `pauseRun(root, runId, {reason, mode, expect:{owner,generation}, now})`. Exit 3 on fence mismatch, 2 on usage. Test via `tests/cli-skillface.test.mjs`.
- [ ] **Step 4: Run → pass** + `npm test` (existing pauseRun callers — drive-headless/precompact — updated to new signature in Tasks 10/11; if they call the old `pauseRun(root,runId,reason)` keep a back-compat shim until then OR update them in this commit to stay green).
- [ ] **Step 5: Commit** — `git commit -m "feat(state+cli): fenced pauseRun preserve/rollback + deep-loop pause handler + paused-rejects-mutation in leaseCheck"`

---

### Task 7: `recover --confirm` (human escape) — recoverRun + CLI

**Files:**
- Modify: `scripts/lib/state.mjs` (`recoverRun`), `scripts/deep-loop.mjs` (CLI)
- Test: `tests/state.test.mjs`, `tests/fencing.test.mjs`

**Interfaces:**
- Produces: `recoverRun(root, runId, {expect:{owner,generation}, confirm:true, now}) → result`. CLI: `deep-loop recover --owner <id> --generation <n> --confirm`.

**Recover semantic (R1-plan finding — pick ONE, consistent):** `recover --confirm` is **unstick-for-resume** (the R9-BB purpose: escape a stuck preserve-paused run whose launch-command is lost). It does NOT terminate (no `stopped`). It **releases the reservation** so a fresh human session can take over via normal `/deep-loop-resume` (which unpauses — Task 8). It leaves `status='paused'` (`pause_reason='recovered:awaiting-resume'`) + `lease.state='released'` + reserved fields cleared, so a fresh acquire is possible and the paused-mutation gate still holds until that acquire unpauses. (No "stopped + acquireable" contradiction.) `--mode stop` could be a future terminal variant — NOT in v1.

- [ ] **Step 1: Write failing tests** — without `--confirm` → `CONFIRM_REQUIRED`; with `--confirm` on a preserve-paused run → clears reserved fields, lease `released`, run stays `paused(reason='recovered:awaiting-resume')`; a fresh owner can then `acquireLease` which **unpauses to running** (Task 8). Fence (wrong owner/generation → exit 3).

```js
test('recover --confirm releases reservation; fresh owner can resume (unpause)', () => {
  // preserve-paused with handoff_child_run_id:'C', lease.state='releasing', expires_at:null
  recoverRun(root, runId, { expect:{owner:'P',generation:1}, confirm:true, now });
  let d = readState(root, runId).data;
  assert.equal(d.session_chain.lease.handoff_child_run_id, null);
  assert.equal(d.session_chain.lease.state, 'released');
  assert.equal(d.status, 'paused');               // not terminal; awaiting human resume
  assert.equal(d.pause_reason, 'recovered:awaiting-resume');
  // fresh owner acquires the released lease → unpauses (Task 8 generalized)
  const a = acquireLease(root, runId, { owner:'NEW', expectGeneration: d.session_chain.lease.generation, now });
  assert.equal(a.ok, true);
  d = readState(root, runId).data;
  assert.equal(d.status, 'running'); assert.equal(d.pause_reason, null);
});
test('recover without confirm refused', () => { assert.throws(()=>recoverRun(root, runId, {expect:{owner:'P',generation:1}, confirm:false, now}), /CONFIRM_REQUIRED/); });
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — `recoverRun`: require `confirm===true` else throw `CONFIRM_REQUIRED`; **validate `status==='paused'` (reject `running`/`completed`/`stopped` with `NOT_RECOVERABLE` — R6-plan: don't release a running lease for a fresh owner via an accidental automated recover)**; `appendAnchored({type:'run-recovered', data:{}}, (l)=>{ const lease=l.session_chain.lease; const child=l.session_chain.sessions.find(s=>s.run_id===lease.handoff_child_run_id); if (child && !child.outcome) child.outcome='abandoned_recover'; const parent=l.session_chain.sessions.find(s=>s.superseded_by===lease.handoff_child_run_id); if (parent) parent.superseded_by=null; lease.handoff_child_run_id=null; lease.handoff_idempotency_key=null; lease.handoff_phase='idle'; lease.state='released'; lease.expires_at=null; lease.resume_policy=null; l.pause_reason='recovered:awaiting-resume'; /* status stays 'paused' until a fresh acquire unpauses */ }, preCheck owner/generation)` — **also cleans the abandoned reserved child outcome + parent `superseded_by` (R6-plan: no ghost child/stale lineage)**. recover is an exempt transition in the paused-gate (Task 6). CLI maps `--confirm`. Negative tests: recover on a `running` run → `NOT_RECOVERABLE`; assert session_chain cleanup. Comment: same human-approval convention as `breaker reset --confirm` (spec §0-49).
- [ ] **Step 4: Run → pass**.
- [ ] **Step 5: Commit** — `git commit -m "feat(state+cli): recover --confirm human escape for preserve/gate-blocked paused runs"`

---

### Task 8: `acquireLease` — preserve-resume unpause (lease.mjs)

**Files:**
- Modify: `scripts/lib/lease.mjs` (`acquireLease`)
- Test: `tests/lease.test.mjs`

**Interfaces:**
- Consumes: lease with `state:'releasing'`, `handoff_child_run_id=C`, `resume_policy:'human'`, run `status:'paused'`.
- Produces: when the reserved child `C` acquires a preserve-paused run, the same transaction sets `status='running'`, clears `pause_reason` and `resume_policy`.

- [ ] **Step 1: Write failing test** — `tests/lease.test.mjs`:

```js
test('reserved child acquiring a preserve-paused run unpauses it (R14-RR)', () => {
  // seed: status:'paused', lease{state:'releasing', generation:1, handoff_child_run_id:'C', expires_at:null, resume_policy:'human'}
  const r = acquireLease(root, runId, { owner:'C', expectGeneration:1, now });
  assert.equal(r.ok, true);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.pause_reason, null);
  assert.equal(data.session_chain.lease.resume_policy, null);
  assert.equal(data.session_chain.lease.generation, 2); // generation+1 on acquire
});
test('non-reserved owner still cannot acquire preserve-paused after stale TTL (expires_at=null)', () => {
  // advance now well past any TTL; expires_at=null → expired=false → only reserved child takeable
  assert.equal(acquireLease(root, runId, { owner:'OTHER', expectGeneration:1, now: '2099-01-01T00:00:00Z' }).ok, false);
});
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — in `acquireLease`, **whenever a takeover succeeds on a `status==='paused'` run** (covers BOTH the reserved-child preserve-resume branch `state==='releasing' && owner===handoff_child_run_id` AND the recover-released branch `state==='released'` with no reserved child), extend the same write to set `data.status='running'`, `data.pause_reason=null`, `lease.resume_policy=null` (in addition to the existing generation bump / lease activation). This acquire-unpause is the resume transition exempt from the `RUN_PAUSED` gate (Task 6). **Also: reject acquire when `status ∈ {stopped, completed}`** (terminal — defensive; a recovered run is `paused`, not terminal, so it stays acquireable). Keep all other acquire semantics (reserved-child / released / releasing-expired) unchanged.
- [ ] **Step 4: Run → pass** + `npm test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(lease): preserve-resume unpause when reserved child acquires a paused run"`

---

### Task 9: `respawn.mjs` — mode selection + bounded child-readiness + CLI fence

**Files:**
- Modify: `scripts/lib/respawn.mjs`, `scripts/deep-loop.mjs` (respawn handler)
- Test: `tests/respawn.test.mjs`

**Interfaces:**
- Consumes: `loop.session_spawn.launcher`, `loop.session_spawn.launcher_bin`, `loop.autonomy.spawn_style`, `opts.attended`, `child_ready_timeout_sec`.
- Produces: `respawn(root, runId, {childRunId, key, handoffRel, headless, attended, now, spawnFn, pollLease})`. CLI: `deep-loop respawn --owner <id> --generation <n> [--attended] [--headless]`.
- **launcherBin + launcherSocket threading (R3/R7-plan):** `respawn` and `emitHandoff` must pass `launcherBin: loop.session_spawn?.launcher_bin` AND `launcherSocket: loop.session_spawn?.launcher_socket` into `buildLaunchCommand(...)` (cmux requires the absolute bundled bin + the verified socket; no bare `cmux`/default-socket fallback). Add an emitted/respawned cmux integration test asserting the cmux entry `bin === session_spawn.launcher_bin`, `argv` includes `--socket <session_spawn.launcher_socket>`, and `launch-command.txt` shows both — not only the helper unit test.

**Mode selection (spec §7):**
```js
const mode = (headless || loop.autonomy?.spawn_style === 'headless') ? 'headless'
  : (loop.autonomy?.spawn_style === 'visible' && attended === true
     && loop.session_spawn?.launcher && loop.session_spawn.launcher !== 'none'
       ? loop.session_spawn.launcher : 'interactive');
```
`entry = cmds[mode]`. If `mode==='interactive'` (no auto-spawn) → return `{ok:false, outcome:'no-launcher'}` (caller pauses via `deep-loop pause --mode preserve`). Keep existing gate→CAS(emitted→spawned). After `spawnFn(entry)` ok for visible: **bounded child-readiness** — poll `pollLease()` until deadline (`child_ready_timeout_sec`) for `state==='active' && handoff_phase==='acquired' && owner_run_id===childRunId && generation===startGen+1` → success (**use `owner_run_id`, the real lease field — R4-plan; not `owner`**); also success if a generation change is the reserved child (fast-child race, R6-U/R10-DD). headless path keeps the existing synchronous measured behavior (no poll).

**Fail-closed paused — but distinguish launch FAILURE from readiness TIMEOUT (R6-plan finding, important):**
- **gate-blocked** (gate fails before spawn — no child started) AND **launch failure** (visibleSpawn `{ok:false}` — launcher exit≠0/error, child definitely didn't start) → **ROLLBACK**: extend the EXISTING failure-mode-B `appendAnchored` transaction (sets `child.outcome='failed_launch'`, `parent.superseded_by=null`, lease rollback) to ALSO set `status='paused'`+`pause_reason` (`gate:<which>`|`launch-failed`) — ONE transaction (consistent metadata; R3/R4-plan). reserved child invalidated (it never ran).
- **readiness TIMEOUT** (visibleSpawn ok, but child hasn't acquired within `child_ready_timeout_sec`) → **PRESERVE, do NOT rollback (R6-plan):** a visible child may still be starting (cold start / auth / workspace-trust / user prompt). Invalidating it would orphan a late `/deep-loop-resume`. So on timeout: keep the reserved child + `lease.resume_policy='human'` + `lease.expires_at=null` + `status='paused'` (`pause_reason='child-timeout-awaiting'`) so a **late child acquire still succeeds** (and `driveHeadless` skips it; human `recover` can abandon it). Add a regression test: child acquires AFTER the timeout window → succeeds.
- **Do NOT call the `pauseRun` CLI for these respawn-internal paths** (respawn owns its transaction incl. session metadata); `deep-loop pause` is only for the skill's no-launcher branch. Result: launch-fail/gate-blocked won't retry the same launcher (fail-closed needs-human); timeout stays late-acquire-safe.

**spawnFn selection by RESOLVED mode (R2-plan finding):** the CLI injects the spawnFn matching the *resolved* `mode`, not just the `--headless` flag: `mode==='headless'` (incl. `spawn_style==='headless'` without `--headless`) → `headlessSpawn` (measured, usage-parse, fail-closed); a visible launcher mode → `visibleSpawn`. Never run a headless entry through visibleSpawn (would skip measurement).

**max_sessions excludes phantom failed launches (R4-plan finding):** `respawnGate`'s `sessions.length > max_sessions` count must **exclude sessions with `outcome==='failed_launch'`** (never-acquired launch attempts). Otherwise repeated visible launch failures / gate-blocks permanently consume `max_sessions` slots with phantom sessions and pollute reports. Add a regression test: N consecutive failed visible launches do NOT exhaust `max_sessions` (live, non-failed session count stays correct).

**headless-invocation detection (concrete, R2-plan finding / KK=A strengthening):** implement `isHeadlessInvocation(env=process.env)` — returns true when the Claude entrypoint is non-interactive (investigate the concrete signal: `env.CLAUDE_CODE_ENTRYPOINT` / a `--print`/`-p` marker; the deep-loop driver path already passes `headless:true` explicitly). Wire it into the unattended decision (`unattended_detect` 'headless-invocation' token): detected → `mode='headless'` regardless of `--attended`. **Fail-closed default:** if the signal is indeterminate AND there is no positive launcher host signal, the precedence already routes to pause (not visible). Add a test for `isHeadlessInvocation` true→headless and a markerless (no launcher, no --attended) → pause case.

- [ ] **Step 1: Write failing tests** — `tests/respawn.test.mjs` (fake `spawnFn`, fake `pollLease`, fixed `now`):

```js
test('spawn_style!=visible → no visible even with launcher (mode interactive)', () => {
  // loop.autonomy.spawn_style='interactive', session_spawn.launcher='cmux'
  const r = respawn(root, runId, { childRunId:'C', key:K, attended:true, now, spawnFn: ()=>{throw new Error('should not spawn');} });
  assert.equal(r.outcome, 'no-launcher');
});
test('visible + attended + launcher: spawnFn called with cmds[launcher]; child acquires → success', () => {
  let got; const spawnFn = (e)=>{ got=e; return {ok:true}; };
  const pollLease = seq([{state:'releasing'}, {state:'active',handoff_phase:'acquired',owner_run_id:'C',generation:START+1}]);
  const r = respawn(root, runId, { childRunId:'C', key:K, attended:true, now, spawnFn, pollLease });
  assert.equal(got.bin !== undefined, true); assert.equal(r.ok, true); assert.equal(r.outcome, 'spawned');
});
test('child-readiness timeout → PRESERVE (reserved child kept, late acquire safe) — R6-plan', () => {
  const pollLease = ()=>({state:'releasing'}); // never acquires within deadline
  const r = respawn(root, runId, { childRunId:'C', key:K, attended:true, now, spawnFn:()=>({ok:true}), pollLease });
  assert.equal(r.ok, false); assert.equal(r.outcome, 'child-timeout-awaiting');
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.session_chain.lease.handoff_child_run_id, 'C');   // NOT invalidated
  assert.equal(d.session_chain.lease.resume_policy, 'human');
  assert.equal(d.session_chain.lease.expires_at, null);
});
test('child acquires AFTER the timeout window → still succeeds (R6-plan late acquire)', () => {
  // timeout preserved the reservation; a later acquireLease by reserved child C unpauses to running
  // (see Task 8) — assert ok + status running
});
test('visibleSpawn launch FAILURE (exit≠0) → rollback AND paused (child never started)', () => {
  const r = respawn(root, runId, { childRunId:'C', key:K, attended:true, now, spawnFn:()=>({ok:false,reason:'launch-exit-1'}), pollLease:()=>({state:'releasing'}) });
  assert.equal(r.ok, false);
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.session_chain.lease.handoff_child_run_id, null);  // invalidated (definitive failure)
});
test('spawn_style=headless without --headless flag → headlessSpawn (measured), not visibleSpawn', () => {
  // CLI-level: resolved mode headless selects headlessSpawn; assert measured path (usage-parse) used
});
test('isHeadlessInvocation true → headless even with launcher+attended', () => {
  // env with non-interactive entrypoint → mode headless regardless of attended
});
test('fast child already acquired before poll → success not fenced (R6-U)', () => {
  const pollLease = ()=>({state:'active',handoff_phase:'acquired',owner_run_id:'C',generation:START+1});
  assert.equal(respawn(root, runId, { childRunId:'C', key:K, attended:true, now, spawnFn:()=>({ok:true}), pollLease }).ok, true);
});
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — add mode selection (incl. `isHeadlessInvocation` → headless **regardless of launcher/attended**), `attended`/`pollLease` params, bounded readiness loop (deadline from `loop.autonomy.child_ready_timeout_sec`, injectable clock via `now`+`pollLease`). **Two DISTINCT failure handlers (R6/R7-plan — do NOT group them):** (a) **launch FAILURE (`visibleSpawn {ok:false}`) and gate-blocked** → extend the EXISTING failure-mode-B `appendAnchored` transaction (`child.outcome='failed_launch'`, `parent.superseded_by=null`, lease rollback) + `status='paused'`+`pause_reason` (`launch-failed`|`gate:<which>`) — ONE transaction, child invalidated. (b) **readiness TIMEOUT (visibleSpawn ok, child not acquired by deadline)** → **PRESERVE** transaction: keep `handoff_child_run_id` + `lease.resume_policy='human'` + `lease.expires_at=null` + `status='paused'`+`pause_reason='child-timeout-awaiting'` (child NOT invalidated → late `/deep-loop-resume` still acquires via Task 8). Do **not** call `pauseRun` separately (respawn owns its transaction incl. session metadata). CLI `respawn` handler: require `--owner/--generation` (exit 3); resolve `mode` first, then `spawnFn = (mode==='headless' ? headlessSpawn : visibleSpawn)` (by resolved mode — R2-plan); `attended` from `--attended`; `pollLease = () => readState(root,runId).data.session_chain.lease`.
- [ ] **Step 4: Run → pass** + `npm test` (existing respawn tests adapt to new params; defaults keep behavior).
- [ ] **Step 5: Commit** — `git commit -m "feat(respawn): spawn_style/attended/launcher mode gate + bounded child-readiness + CLI --owner/--generation fence"`

---

### Task 10: `drive-headless.mjs` — skip human resume_policy + headless-invocation

**Files:**
- Modify: `scripts/hooks-impl/drive-headless.mjs`
- Test: `tests/spawn-driver.test.mjs` or a new `tests/drive-headless.test.mjs`

- [ ] **Step 1: Write failing tests** — `driveHeadless` resumes a handoff ONLY when the run is **headless-intended**; it must SKIP both `resume_policy==='human'` (preserve/needs-human) AND **visible-intended emitted handoffs** (e.g. a visible session's PreCompact emits a pending handoff with no `resume_policy` — R5-plan: grabbing it would silently degrade visible→headless).

```js
test('driveHeadless skips resume_policy=human handoffs', () => {
  const spawnFn = ()=>{ throw new Error('should not spawn'); };
  const r = driveHeadless({ root, spawnFn, now });
  assert.equal(r.skipped, true); assert.equal(r.reason, 'human-resume-policy');
});
test('driveHeadless skips a VISIBLE-intended emitted handoff (no resume_policy) — R5-plan', () => {
  // seed: spawn_style='visible', pending emitted handoff, lease.resume_policy unset, not headless-intended
  const r = driveHeadless({ root, spawnFn:()=>{throw new Error('should not spawn');}, now });
  assert.equal(r.skipped, true); assert.equal(r.reason, 'not-headless-intended');
});
test('driveHeadless resumes a headless-intended handoff', () => {
  // seed: spawn_style='headless' (or unattended/isHeadlessInvocation) → resumed headless
});
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — change the pending-handoff scan to gate on the **PERSISTED `lease.resume_policy` (R5/R7-plan)**, not the driver's own env (the driver runs after the emitting hook exits, so intent must be on the handoff): resume ONLY if `lease.resume_policy==='headless'`. Skip `resume_policy==='human'` → `{skipped:true,reason:'human-resume-policy'}`; skip `'visible'`/null → `{skipped:true,reason:'not-headless-intended'}` (a visible session's emitted handoff — the next visible continue tick owns it; driver must not degrade it to headless). Requires emit paths to persist intent (Task 11 + emitHandoff): headless-intended (`spawn_style==='headless'` / `isHeadlessInvocation` / explicit unattended) → `resume_policy='headless'`; visible → `'visible'`; needs-human/preserve → `'human'`.
- [ ] **Step 4: Run → pass** + `npm test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(drive-headless): skip resume_policy=human handoffs (preserve/needs-human not auto-headless)"`

---

### Task 11: `precompact-handoff.mjs` — drop tty from headless calc

**Files:**
- Modify: `scripts/hooks-impl/precompact-handoff.mjs:30`
- Test: `tests/precompact-hook.test.mjs`

- [ ] **Step 1: Write failing test** — input with `tty:false` but no `unattended` marker and `spawn_style:'visible'` → `headless===false` (handoff emitted, not forced headless).

```js
test('precompact: input.tty===false alone does not force headless (R2-H)', async () => {
  const res = await runPreCompactHandoff({ tty:false, cwd:root }, { root });
  // emitted handoff, headless flag false (visible session preserved)
  assert.equal(res.headless, false);
});
test('precompact: explicit unattended still headless', async () => {
  const res = await runPreCompactHandoff({ unattended:true, cwd:root }, { root });
  assert.equal(res.headless, true);
});
test('precompact: headless claude -p resume stays headless via isHeadlessInvocation (R3-plan)', async () => {
  // spawn_style still 'visible', no input.unattended, but env indicates non-interactive claude -p
  const res = await runPreCompactHandoff({ tty:false, cwd:root }, { root, env: { CLAUDE_CODE_ENTRYPOINT:'<headless-marker>' } });
  assert.equal(res.headless, true); // must NOT emit a visible/preserve handoff for a measured headless session
});
```

- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Implement** — change the headless calc to `const headless = input.unattended === true || loop.autonomy?.spawn_style === 'headless' || isHeadlessInvocation(env);` (drop `|| input.tty === false`; **add `isHeadlessInvocation(env)`** from Task 9 — R3-plan). **Persist the resume intent on the emitted handoff (R7-plan): pass `resumePolicy = headless ? 'headless' : 'visible'` into `emitHandoff` so the emitted handoff's `lease.resume_policy` records it** — then `driveHeadless` (Task 10) resumes only `'headless'` and never degrades a visible session's compaction handoff. Return `headless` in the result for testability. (precompact stays emit-only.) `emitHandoff` gains a `resumePolicy` param written into the lease at emit (default `'visible'`; the no-launcher skill branch overrides to `'human'` via `pause --mode preserve`).
- [ ] **Step 4: Run → pass** + `npm test`.
- [ ] **Step 5: Commit** — `git commit -m "fix(precompact): drop input.tty===false from headless calc (non-tty != unattended)"`

---

### Task 12: Skills — continue/handoff/resume visible decision flow (read-only/CLI)

**Files:**
- Modify: `skills/deep-loop-continue/SKILL.md`, `skills/deep-loop-handoff/SKILL.md`, `skills/deep-loop-resume/SKILL.md`, `skills/deep-loop-workflow/references/handoff-respawn.md`
- Test: `tests/skills.test.mjs` (2-plane enforcement)

**Interfaces:** Skills only **read** state (`state get`) and call CLI subcommands. No direct writes to loop.json/event-log.

- [ ] **Step 1: Write/extend failing test** — `tests/skills.test.mjs`: assert the three SKILL.md files contain no direct-write instructions (no `>> event-log`, no writing `loop.json`/`.loop.hash`), and that the continue/handoff flow references the CLI subcommands `detect-terminal`, `respawn --owner ... --generation ... --attended`, `pause --mode preserve`, `recover --confirm` (string presence checks consistent with existing skills.test patterns).
- [ ] **Step 2: Run → fail**.
- [ ] **Step 3: Edit SKILL.md** — continue/handoff Decide step: (1) `deep-loop detect-terminal --owner --generation`; (2) read `session_spawn.launcher` + `autonomy.spawn_style`; (3) branch: visible (read lease → `deep-loop respawn --owner <o> --generation <g> --attended`), unattended (driver/headless), else (`deep-loop handoff …` then **`deep-loop pause --owner <o> --generation <g> --mode preserve --reason needs-human:<…>`** — **MUST include the `--owner/--generation` fence (R6-plan): handoff emit already put the lease in `releasing`, so an unfenced pause exits 3 and leaves the run un-paused → stale takeover** + present `launch-command.txt`); also detect an already-`emitted` handoff (PreCompact) and reuse it (no re-emit). resume: note that reserved-child acquire unpauses (handled in kernel, Task 8). Add `recover --confirm` as the documented human escape. Keep everything read/CLI only.
- [ ] **Step 4: Run → pass** + `npm test`.
- [ ] **Step 5: Commit** — `git commit -m "docs(skills): visible respawn decision flow (detect-terminal/respawn --attended/pause preserve/recover) — read+CLI only"`

---

### Task 13: Integration test + preflight + docs

**Files:**
- Test: `tests/respawn.test.mjs` or new `tests/self-spawn-integration.test.mjs`
- Modify: `README.md`/`README.ko.md` (visible spawn note), `CHANGELOG`

- [ ] **Step 1: Write end-to-end-ish integration tests (injected runners, no real terminals)** covering the spec §11 paths not yet covered: (a) no-launcher attended → handoff + `pause --mode preserve` → reserved-child `/deep-loop-resume` (acquireLease) unpauses + can mutate (R14-RR full round-trip); (b) gate-blocked (seed budget over hard cap) → `pause --mode rollback`, then a launch-command-style acquire by the old child is rejected (gate not bypassed, R12-LL); (c) markerless: `respawn` without `--attended` (or `spawn_style!=visible`) → no visible (paused); (d) cmux `--command` shell-parse contract: split the produced `--command` string with a POSIX tokenizer and assert `claude` is argv[0] (R5-R).
- [ ] **Step 2: Run → fail (for any not-yet-wired path); fix wiring**.
- [ ] **Step 3: Update docs** — README visible-spawn behavior + fallback; CHANGELOG entry. Do not edit auto-generated marker regions.
- [ ] **Step 4: Run preflight** — `npm run preflight` (validate + full `node --test`). Expected: all green (327 baseline + new).
- [ ] **Step 5: Commit** — `git commit -m "test(self-spawn): end-to-end visible/preserve/rollback/markerless + docs; preflight green"`

---

## Self-Review

**Spec coverage (§0 decisions 1-49 → tasks):**
- 1-5 (architecture/argv/re-detect/probe/precompact) → Tasks 2,3,4,5,11. ✔
- 6 (non-tty removed) → Task 1 (initrun). ✔ · 7 (child-readiness) → Task 9. ✔ · 8 (psq) → Task 4. ✔ · 9 (status enum / pause_reason) → Tasks 1,6. ✔
- 10-13 (fail-closed detect / cmux bin / precedence / precompact tty) → Tasks 2,4,9,11. ✔
- 14-18 (POSIX q / fenced pause / attended / spawn_style gate / cmux surface) → Tasks 4,6,9,2. ✔
- 19-22 (entry bash-free / cmux abs bin / headless opt-in / cmux --command escape) → Tasks 4,5,9. ✔
- 23-24 (cmux --command args-only / macOS multiplexer) → Tasks 4,2. ✔
- 25-28 (pause releasing-safe / child race / powershell tier / pause preserve-rollback) → Tasks 6,9,2. ✔
- 29-32 (preserve expires_at=null / darwin probe stdout / powershell select / module map) → Tasks 6,2. ✔
- 33-35 (recover / powershell opt-in / readiness lease fields) → Tasks 7,2,9. ✔
- 36-41 (gate-blocked rollback / detect releasing-safe / respawn fence / detectTerminal opt-in arg / driveHeadless skip) → Tasks 9,3,9,2/3,10. ✔
- 42-46 (attended best-effort / gate-blocked rollback / recover clears / repeated-fail pause / paused-rejects-mutation) → Tasks 9,6,7,9,6. ✔
- 47-49 (preserve-resume unpause / KK=A accepted / recover convention) → Tasks 8,(design),7. ✔

**Placeholder scan:** No "TBD/handle edge cases" — each task has concrete test + impl code. Open-questions (§14: headless-invocation signal, cmux contract-test, PowerShell Windows runtime, child_ready_timeout tuning, recover gate-override format) are explicitly deferred and flagged in-task (Tasks 10/11 comments, Task 13).

**Type consistency:** `detectTerminal` descriptor shape consistent across Tasks 1/2/3/9; `{bin,argv,display,cwd?}` entry consistent Tasks 4/5/9; `pauseRun({reason,mode,expect,now})` consistent Tasks 6/9/10/11; `acquireLease` unpause consistent Tasks 6/8/9.

**Out of scope (spec §13):** tmux/screen/wezterm/kitty/VS Code auto-spawn, `claude --bg`, PowerShell Windows runtime verification, PreCompact visible spawn — not in any task (intentional).
