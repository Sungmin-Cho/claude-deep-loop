import { readState } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { checkBudget, reconcileBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { advanceHandoffPhase } from './lease.mjs';
import { buildLaunchCommand } from './runtime-descriptor.mjs';
import { defaultDesktopProbe } from './desktop-target.mjs';
import { sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';

// 게이트 순서: budget → breaker → max_sessions → wallclock → auto_handoff (spec §9). 순수.
export function respawnGate(loop, { now = Date.now() } = {}) {
  const blocked_by = [];
  // Codex r1 🟡8: checkBudget 은 created_at 기반 wallclock 도 검사하므로, sessionStart=now 로 그 내부 검사를
  // 무력화(wall=0)하고 wallclock 은 아래 문서화된 순서(max_sessions 다음)에서 명시 검사 → 순서/라벨 일관.
  const b = checkBudget(loop, { now, sessionStart: now });
  if (!b.ok) blocked_by.push('budget');
  if (checkBreaker(loop).tripped) blocked_by.push('breaker');
  // Codex r3 🟡6: emitHandoff 가 child 세션을 미리 append 하므로 pending child 가 이미 카운트됨 → `>`(>= 아님)로 비교해
  // 총 세션이 max_sessions 까지는 허용하되 초과는 금지 (off-by-one 방지).
  // R4-plan: phantom failed_launch sessions (never acquired) MUST NOT consume max_sessions slots — otherwise
  // repeated visible launch failures / gate-blocks permanently exhaust max_sessions with dead phantom sessions.
  const liveSessions = (loop.session_chain?.sessions || []).filter(s => s.outcome !== 'failed_launch');
  if (liveSessions.length > (loop.autonomy?.max_sessions ?? 8)) blocked_by.push('max_sessions');
  const start = loop.created_at ? Date.parse(loop.created_at) : now;
  if (loop.budget?.max_wallclock_sec && (now - start) / 1000 >= loop.budget.max_wallclock_sec) blocked_by.push('wallclock');
  if (!loop.autonomy?.auto_handoff) blocked_by.push('auto_handoff');
  return { ok: blocked_by.length === 0, blocked_by, reason: blocked_by.join(',') || 'ok' };
}

// Headless (non-interactive) invocation detection — an ADDITIONAL safety net beyond the driver's explicit
// `headless:true`. PROVISIONAL signal (spec §14-5 open question): the exact `CLAUDE_CODE_ENTRYPOINT` value for
// `claude -p` print mode is not yet pinned, so we recognize the concrete markers we DO control —
// `DEEP_LOOP_UNATTENDED` (set by the headless driver on the child process) / `DEEP_LOOP_HEADLESS` — plus a
// conservative entrypoint heuristic (sdk*/print/headless/non-interactive). FAIL-OPEN to false when
// indeterminate: false + no positive launcher → mode 'interactive' → no-launcher → pause (fail-closed).
export function isHeadlessInvocation(env = process.env) {
  if (!env || typeof env !== 'object') return false;
  const truthy = (v) => v === '1' || v === 'true' || v === true;
  if (truthy(env.DEEP_LOOP_UNATTENDED) || truthy(env.DEEP_LOOP_HEADLESS)) return true;
  const ep = String(env.CLAUDE_CODE_ENTRYPOINT || '').toLowerCase();
  if (!ep || ep === 'cli') return false;   // interactive TUI (or unset) → not headless
  if (ep.startsWith('sdk') || ep.includes('print') || ep.includes('headless') || ep.includes('noninteractive') || ep.includes('non-interactive')) return true;
  return false;
}

// Resolve the spawn mode (spec §7). Returns 'headless' | 'desktop' | a launcher name (cmux|iterm2|terminal-app|wt|powershell)
// | 'interactive'. Headless wins over everything: explicit flag, autonomy.spawn_style==='headless', OR a
// detected headless invocation (regardless of launcher/attended). Then 'desktop' when spawn_style==='desktop' AND
// attended===true (Claude Desktop deeplink transport). A visible launcher mode requires spawn_style==='visible'
// AND attended===true AND a real (non-'none') detected launcher; otherwise 'interactive'.
export function resolveSpawnMode(loop, { headless = false, attended = false, env = process.env } = {}) {
  if (headless || loop?.autonomy?.spawn_style === 'headless' || isHeadlessInvocation(env)) return 'headless';
  if (loop?.autonomy?.spawn_style === 'desktop' && attended === true) return 'desktop';
  const launcher = loop?.session_spawn?.launcher;
  if (loop?.autonomy?.spawn_style === 'visible' && attended === true && launcher && launcher !== 'none') return launcher;
  return 'interactive';
}

function defaultSpawn() {
  // 실제 spawn은 spawn-driver 의 visibleSpawn/headlessSpawn. 단위 테스트는 spawnFn 주입.
  throw new Error('SPAWN_NOT_WIRED: provide spawnFn (visible=visibleSpawn, headless=headlessSpawn)');
}
function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Classify a polled lease for visible child-readiness (R10-DD exact schema; R6-U fast-child race):
//   'success' — the reserved child has acquired: state==='active' && handoff_phase==='acquired' && owner===child.
//   'fenced'  — a generation change to a NON-reserved owner (some other run/recover took over).
//   'pending' — still releasing / not yet acquired (missing generation counts as pending, not fence).
function classifyReadiness(l, { childRunId, startGeneration }) {
  if (!l) return 'pending';
  if (l.owner_run_id === childRunId && l.state === 'active' && l.handoff_phase === 'acquired') return 'success';
  if (l.generation != null && l.generation !== startGeneration && l.owner_run_id !== childRunId) return 'fenced';
  return 'pending';
}

// Failure handler (a): launch FAILURE (visibleSpawn {ok:false}/throw) AND gate-blocked → ROLLBACK + paused.
// ONE appendAnchored transaction: child.outcome='failed_launch' (excluded from max_sessions), parent.superseded_by
// cleared, lease rolled back to active/idle (stale TTL released), status='paused' + pause_reason. The reserved
// child is invalidated (it never ran). In-lock parent fence → if the lease changed (child took over), abort
// WITHOUT mutating (returns {fenced:true}). No half-commit: event + chain + lease + status are one transaction.
export function rollbackAndPause(root, runId, { childRunId, parentOwner, generation, eventData, pauseReason }) {
  try {
    appendAnchored(root, runId, { type: 'respawn-failed', data: { ...eventData, pause_reason: pauseReason } }, (l) => {
      const child = l.session_chain.sessions.find(s => s.run_id === childRunId);
      if (child) child.outcome = 'failed_launch';
      const parent = l.session_chain.sessions.find(s => s.superseded_by === childRunId);
      if (parent) parent.superseded_by = null;
      l.session_chain.lease = { ...l.session_chain.lease, state: 'active', handoff_phase: 'idle', handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null, resume_policy: null };
      l.status = 'paused';
      l.pause_reason = pauseReason;
    }, (l) => {
      const lease = l.session_chain.lease;
      if (lease.owner_run_id !== parentOwner || lease.generation !== generation) throw new Error('RESPAWN_FENCED: rollback-pause');
      // v1.6 (spec §2.3-5): completed run을 paused로 강등 금지 — 초입 read↔이 append 사이 TOCTOU를 in-lock에서 봉쇄.
      if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: respawn');
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) return { fenced: true };
    if (String(appendErr.message).startsWith('RUN_TERMINAL')) return { terminal: true };   // v1.6 — caller가 outcome:'terminal'로 전파
    throw appendErr;
  }
  return { ok: true };
}

// Failure handler (b): readiness TIMEOUT (visibleSpawn ok but child not acquired by deadline) → PRESERVE,
// do NOT rollback (R6-plan). A visible child may still be starting (cold start / auth / workspace-trust / user
// prompt). Keep handoff_child_run_id + lease.state (releasing) intact; set resume_policy='human', expires_at=null,
// status='paused', pause_reason='child-timeout-awaiting' so a LATE /deep-loop-resume by the reserved child still
// acquires (Task 8) and unpauses; the headless driver skips it; a human `recover` can abandon it. ONE transaction.
// If the child acquired right at the boundary (fence), distinguish success (reserved child) from a real fence.
function preservePause(root, runId, { childRunId, parentOwner, generation, pauseReason = 'child-timeout-awaiting' }) {
  try {
    appendAnchored(root, runId, { type: 'respawn-timeout', data: { child_run_id: childRunId, pause_reason: pauseReason } }, (l) => {
      l.session_chain.lease = { ...l.session_chain.lease, resume_policy: 'human', expires_at: null };
      l.status = 'paused';
      l.pause_reason = pauseReason;
    }, (l) => {
      const lease = l.session_chain.lease;
      if (lease.owner_run_id !== parentOwner || lease.generation !== generation) throw new Error('RESPAWN_FENCED: timeout-preserve');
      // v1.6 (spec §2.3-5): terminal run은 preserve-pause로도 강등 금지 (readiness-timeout TOCTOU).
      if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: respawn');
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RUN_TERMINAL')) return { terminal: true };   // v1.6
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) {
      const fresh = readState(root, runId).data.session_chain.lease;
      if (fresh.owner_run_id === childRunId && fresh.state === 'active' && fresh.handoff_phase === 'acquired') return { acquired: true };
      return { fenced: true };
    }
    throw appendErr;
  }
  return { ok: true };
}

// Bounded child-readiness handshake shared by the visible first-entry spawn-success path AND the
// already-spawned re-entry recovery (codex r5 finding A). launcher exit 0 (or a prior CAS) is NOT proof the
// reserved child acquired — poll the (releasing) lease until the child takes over (generation+1) or the
// deadline lapses. On deadline → preservePause (do NOT rollback / do NOT re-spawn): a slow child may still
// acquire (Task 8 late-acquire) and a human `recover` can abandon — autonomous-detectable, never silent.
// Count-based loop (maxPolls) with an injectable poll/sleep → deterministic under fixed clocks.
function awaitChildReadiness(root, runId, {
  childRunId, parentOwner, generation, loop, poll, sleep, pollIntervalMs,
  successOutcome, successReason, lateAcquireReason, pauseReason, timeoutOutcome,
}) {
  const timeoutMs = (loop.autonomy?.child_ready_timeout_sec ?? 75) * 1000;
  const interval = pollIntervalMs > 0 ? pollIntervalMs : 1500;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / interval));
  for (let i = 0; i < maxPolls; i++) {
    const verdict = classifyReadiness(poll(), { childRunId, startGeneration: generation });
    if (verdict === 'success') return { ok: true, outcome: successOutcome, reason: successReason, childRunId };
    if (verdict === 'fenced') return { ok: false, outcome: 'fenced', reason: 'lease-changed-during-readiness', childRunId };
    if (i < maxPolls - 1) sleep(interval);
  }
  // readiness TIMEOUT → PRESERVE (do NOT rollback) — 늦은 /deep-loop-resume 도 reserved child 면 인수 성공.
  const res = preservePause(root, runId, { childRunId, parentOwner, generation, pauseReason });
  if (res.acquired) return { ok: true, outcome: successOutcome, reason: lateAcquireReason, childRunId };
  if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6 (plan r2 high): timeout outcome으로 뭉개짐 금지
  if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-at-timeout', childRunId };
  return { ok: false, outcome: timeoutOutcome, reason: 'readiness-timeout-preserve', childRunId };
}

export function respawn(root, runId, {
  childRunId, key, handoffRel = '', headless = false, attended = false,
  now = Date.now(), spawnFn = defaultSpawn, pollLease, env = process.env,
  sleep = defaultSleep, pollIntervalMs = 1500,
  platform = process.platform, desktopProbe = defaultDesktopProbe,
} = {}) {
  reconcileBudget(root, runId);                       // 무결성 fail-stop (탐지 시 throw)
  const { data: loop } = readState(root, runId);
  const runtime = sessionRuntime(loop);
  const canonicalRoot = canonicalProjectRoot(loop.project.root);
  const lease = loop.session_chain.lease;
  const generation = lease.generation;
  const parentOwner = lease.owner_run_id;
  const poll = pollLease || (() => readState(root, runId).data.session_chain.lease);

  // v1.6 (spec §2.3-5, r5 P2-a): terminal fast-return — 모든 분기(특히 spawned 재진입 :Codex r5 A)보다 앞.
  // legacy terminal+spawned는 재진입 분기가 already-spawned 성공/preservePause(paused 강등)로 새고,
  // legacy terminal+releasing+emitted는 not-emitted 체크를 통과하므로 초입 차단이 필수.
  if (loop.status === 'completed' || loop.status === 'stopped') {
    return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
  }
  // 멱등/펜싱 사전조건 (Codex r1 🔴2): 잘못된 key 거부, 이미 spawned 면 재spawn 금지(이중 spawn 차단).
  if (lease.handoff_idempotency_key !== key) return { ok: false, outcome: 'key-mismatch', reason: 'key-mismatch', childRunId };
  // Codex impl r8 🟡: bind the spawn to the RESERVED handoff child — a valid key must not spawn an arbitrary child.
  if (childRunId !== lease.handoff_child_run_id) return { ok: false, outcome: 'child-mismatch', reason: `childRunId ${childRunId} != reserved ${lease.handoff_child_run_id}`, childRunId };
  // Codex r5 finding A (HIGH): 'spawned' is the CAS-before-spawn CLAIM, NOT proof the child launched + took
  // over. A prior call may have crashed AFTER the CAS, before/during the external spawn → a blind
  // already-spawned return would strand the handoff with no autonomous recovery. So VERIFY child acquisition;
  // when unconfirmed, recover via the SAME bounded readiness wait the first-entry uses, then preserve-pause.
  // Re-spawn is NEVER done here (that would risk the double spawn the CAS prevents) — recovery is verify+wait+preserve.
  if (lease.handoff_phase === 'spawned') {
    // (1) Reserved child already acquired → genuine already-spawned (a prior call spawned + the child took over).
    if (classifyReadiness(poll(), { childRunId, startGeneration: generation }) === 'success') {
      return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
    }
    // (2) Not yet acquired. headless first-entry measures synchronously (the child acquires DURING the
    //     measured subprocess) and interactive never auto-spawns, so a re-entry-before-acquire in those modes
    //     is the normal idempotent-retry / concurrent double-spawn-guard contract — keep the plain no-op (no
    //     spurious pause). An already-paused run was handled by a prior preserve → idempotent no-op too.
    const reMode = resolveSpawnMode(loop, { headless, attended, env });
    if (reMode === 'headless' || reMode === 'interactive' || loop.status === 'paused') {
      return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
    }
    // (3) Visible re-entry: launcher exit was never proof of acquisition + the CAS-doer may have crashed.
    //     Bounded-wait for the reserved child; if it never acquires, preserve-pause (late acquire still safe,
    //     human recover can abandon) — autonomous-detectable, NOT a false success.
    return awaitChildReadiness(root, runId, {
      childRunId, parentOwner, generation, loop, poll, sleep, pollIntervalMs,
      successOutcome: 'already-spawned', successReason: 'child-acquired-on-reentry',
      lateAcquireReason: 'child-acquired-on-reentry-at-timeout',
      pauseReason: 'spawn-unconfirmed-awaiting', timeoutOutcome: 'spawn-unconfirmed-awaiting',
    });
  }
  if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {
    return { ok: false, outcome: 'not-emitted', reason: `phase=${lease.handoff_phase} state=${lease.state}`, childRunId };
  }
  // RUN_PAUSED (Task 6): paused 상태에서는 respawn 금지. respawn 은 leaseCheck 를 경유하지 않으므로 명시 차단.
  if (loop.status === 'paused') return { ok: false, outcome: 'paused', reason: 'RUN_PAUSED', childRunId };

  // ── gate check (spec §9, R12-LL) ─────────────────────────────────────────
  // Gate MUST win regardless of launcher availability (R12-LL fix): a gate-blocked run must always
  // ROLLBACK + pause, even when there is no auto-launcher. Evaluating gate before mode selection ensures
  // that gate-blocked + no-launcher → rollback/invalidate (not preserve). Only after a passing gate does
  // mode selection run; gate-OK + no-launcher is a genuine needs-human → preserve is then correct.
  const gate = respawnGate(loop, { now });
  if (!gate.ok) {
    // 실패모드 (A) gate-blocked: ROLLBACK + paused — ONE 트랜잭션 (R12-LL; 자식 무효화, 결코 실행 안 됨).
    const res = rollbackAndPause(root, runId, { childRunId, parentOwner, generation, eventData: { child_run_id: childRunId, gate: gate.reason }, pauseReason: `gate:${gate.reason}` });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
    return { ok: false, outcome: 'gate-blocked', reason: gate.reason, childRunId };
  }

  // ── mode selection (spec §7) ────────────────────────────────────────────────
  const mode = resolveSpawnMode(loop, { headless, attended, env });
  if (mode === 'interactive') {
    // No auto-spawn possible; gate already passed → PRESERVE the emitted handoff (do NOT rollback) — the
    // skill pauses via `deep-loop pause --mode preserve`, keeping the reserved child for a human/visible-continue
    // to pick up. This is a genuine needs-human, NOT a gate bypass (gate check already passed above).
    return { ok: false, outcome: 'no-launcher', reason: 'no-auto-launcher', childRunId };
  }
  const isHeadless = mode === 'headless';
  // Codex r3 🔴3: derive effHandoffRel + construct/validate the launch entry BEFORE the spawned CAS.
  // buildLaunchCommand can throw UNSAFE_SPAWN_ARG (or cmds[mode] undefined for an unrecognised mode).
  // A throw here leaves the lease in 'emitted' (no CAS yet → not stranded). Only command CONSTRUCTION
  // moves above the CAS; spawnFn call and its try/catch remain below, unchanged.
  const childSession = loop.session_chain.sessions.find(s => s.run_id === childRunId);
  const effHandoffRel = (childSession && childSession.handoff_rel) || handoffRel;
  // Task 5b: only a Claude 'desktop' mode spawn probes the real (or injected) handler-verification target —
  // Codex and other modes never touch it. A verified target's argvTarget threads through as `desktopTarget`; an
  // unverified/failed probe (dt.ok===false) yields null → buildLaunchCommand's unavailable entry →
  // the generalized unavailable-entry guard below preserve-pauses (never a rollback/fenced-target spawn).
  const dt = runtime === 'claude' && mode === 'desktop' ? desktopProbe({ platform }) : null;
  let _cmds, _entry;
  try {
    // launcherBin + launcherSocket threading (R3/R7-plan): cmux requires the absolute bundled bin + verified socket.
    _cmds = buildLaunchCommand({
      runtime, root: canonicalRoot, parentRunId: runId, childRunId, handoffRel: effHandoffRel,
      launcher: loop.session_spawn?.launcher,
      launcherBin: loop.session_spawn?.launcher_bin,
      launcherSocket: loop.session_spawn?.launcher_socket,
      platform, desktopTarget: dt && dt.ok ? dt.argvTarget : null,
      model: loop.autonomy?.session_model ?? null, effort: loop.autonomy?.session_effort ?? null,
    });
    _entry = _cmds[mode];
  } catch (buildErr) {
    // Throw happened while lease is still 'emitted' — no CAS yet, not stranded. Return clear error.
    return { ok: false, outcome: 'build-error', reason: String(buildErr.message || buildErr), childRunId };
  }

  // Fail closed: ANY visible/desktop mode with an unavailable entry (no trusted launcher_bin — e.g. a
  // stale/migrated launcher='powershell' run — or an unverified desktop target, or (win32 only) a
  // verified win-exe target with no trusted PowerShell bin resolvable — see runtime-descriptor.mjs's win32
  // branch, which otherwise builds a runnable non-blocking `Start-Process` entry) — must NOT spawn.
  // `interactive` never reaches here (it returns above, before `_cmds` is
  // built); Claude `headless` carries `bin:'claude'`, while Slice 1 Codex headless is deliberately
  // unavailable and is caught here before CAS; a valid launcher entry
  // always has a `bin` (guard never fires). Unlike the interactive no-launcher path (which the else/none
  // skill branch preserve-pauses), this is reached via the VISIBLE/DESKTOP skill branch (launcher!=='none'
  // → `respawn --attended`), which does NOT inspect the outcome — so respawn must preserve-pause ITSELF here, or
  // the handoff is left emitted/releasing, unpaused, with no child spawned (stranded). Mirrors gate-blocked self-pause.
  if (!_entry || _entry.unavailable || !_entry.bin) {
    const unavailableReason = _entry?.reason || `${mode}-launcher-unavailable`;
    const res = preservePause(root, runId, { childRunId, parentOwner, generation, pauseReason: unavailableReason });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
    return { ok: false, outcome: 'no-launcher', reason: unavailableReason, childRunId };
  }

  // Codex r2 🔴3: 외부 spawn **이전에** emitted→spawned 를 원자적(withLock CAS)으로 클레임 (이중 외부 spawn 차단).
  // Command is already validated above; only the CAS + spawnFn call remain below.
  const claim = advanceHandoffPhase(root, runId, { key, toPhase: 'spawned', now, expect: { owner: parentOwner, generation } });
  if (!claim.ok) {
    // v1.6 (spec §2.3-5, plan r1): 초입 read↔클레임 사이 finish 경합 — phase-error로 뭉개짐 금지.
    if (claim.reason === 'RUN_TERMINAL') return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };
    if (claim.reason === 'fenced') return { ok: false, outcome: 'fenced', reason: 'lease-changed-during-claim', childRunId };
    return { ok: false, outcome: 'phase-error', reason: claim.reason, childRunId };
  }
  if (claim.reason === 'idempotent-noop') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };

  // Codex impl r8 🟡: entry is already built + validated before the CAS above.
  const entry = _entry;
  try {
    const res = spawnFn(entry);
    if (res && res.ok === false) throw new Error(res.reason || 'spawn-returned-false');
  } catch (e) {
    // 실패모드 (B) launch failure: ROLLBACK + paused — ONE 트랜잭션 (자식 무효화, 결코 시작 안 됨).
    const res = rollbackAndPause(root, runId, { childRunId, parentOwner, generation, eventData: { child_run_id: childRunId, error: String(e.message || e) }, pauseReason: 'launch-failed' });
    if (res.terminal) return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    if (res.fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-failure-record', childRunId };
    return { ok: false, outcome: 'failed_launch', reason: String(e.message || e), childRunId };
  }

  // spawn 성공 → respawn-spawned 기록 (parent fence). lease 는 releasing 유지 — 자식이 handshake acquire.
  // (Codex impl r11 🔴: 이벤트 기록과 lease 전이 분리 금지 → 단일 appendAnchored.)
  try {
    appendAnchored(root, runId, { type: 'respawn-spawned', data: { child_run_id: childRunId, headless: isHeadless } }, (_l) => {
      // 자식이 releasing 상태의 lease 를 handshake acquire (acquireLease: releasing && owner===handoff_child_run_id).
    }, (l) => {
      if (l.session_chain.lease.owner_run_id !== parentOwner || l.session_chain.lease.generation !== generation) {
        throw new Error('RESPAWN_FENCED: spawned-append');
      }
      // v1.6 (spec §2.3-5): terminal run에 respawn-spawned 이벤트 append 금지 (spawn↔기록 사이 TOCTOU).
      if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: respawn');
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RUN_TERMINAL')) {
      return { ok: false, outcome: 'terminal', reason: 'RUN_TERMINAL', childRunId };   // v1.6
    }
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) {
      // R6-U: a fast RESERVED child may have acquired before we recorded → that is SUCCESS, not a fence.
      const fresh = readState(root, runId).data.session_chain.lease;
      if (fresh.owner_run_id === childRunId && fresh.state === 'active' && fresh.handoff_phase === 'acquired') {
        return { ok: true, outcome: 'spawned', reason: 'fast-child-acquired', childRunId };
      }
      return { ok: false, outcome: 'fenced', reason: 'lease-changed-after-spawn', childRunId };
    }
    throw appendErr;
  }

  // headless 경로: 기존대로 동기 측정 (spawnFn 이 동기적으로 측정) — child-readiness poll 불필요.
  if (isHeadless) return { ok: true, outcome: 'spawned', reason: 'spawned', childRunId };

  // visible 경로: bounded child-readiness handshake (R1-B). launcher exit 0 != 자식 생성 증명 — 자식이 releasing
  // lease 를 acquire(generation+1)할 때까지 deadline 동안 poll. deadlock 없음(lease 가 releasing).
  // Same helper as the already-spawned re-entry recovery (codex r5 finding A) — single readiness contract.
  return awaitChildReadiness(root, runId, {
    childRunId, parentOwner, generation, loop, poll, sleep, pollIntervalMs,
    successOutcome: 'spawned', successReason: 'child-acquired',
    lateAcquireReason: 'child-acquired-at-timeout',
    pauseReason: 'child-timeout-awaiting', timeoutOutcome: 'child-timeout-awaiting',
  });
}
