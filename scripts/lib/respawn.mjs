import { readState, writeState, withLock } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { checkBudget, reconcileBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { advanceHandoffPhase } from './lease.mjs';
import { buildLaunchCommand } from './handoff.mjs';

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
  if ((loop.session_chain?.sessions?.length || 0) > (loop.autonomy?.max_sessions ?? 8)) blocked_by.push('max_sessions');
  const start = loop.created_at ? Date.parse(loop.created_at) : now;
  if (loop.budget?.max_wallclock_sec && (now - start) / 1000 >= loop.budget.max_wallclock_sec) blocked_by.push('wallclock');
  if (!loop.autonomy?.auto_handoff) blocked_by.push('auto_handoff');
  return { ok: blocked_by.length === 0, blocked_by, reason: blocked_by.join(',') || 'ok' };
}

function defaultSpawn(cmd) {
  // 실제 spawn은 Plan 3/드라이버 경로에서 child_process로 구현. 단위 테스트는 spawnFn 주입.
  throw new Error('SPAWN_NOT_WIRED: provide spawnFn (interactive=manual launch, headless=Plan3 driver)');
}

export function respawn(root, runId, { childRunId, key, handoffRel = '', headless = false, now = Date.now(), spawnFn = defaultSpawn }) {
  reconcileBudget(root, runId);                       // 무결성 fail-stop (탐지 시 throw)
  const { data: loop } = readState(root, runId);
  const lease = loop.session_chain.lease;
  const generation = lease.generation;
  const parentOwner = loop.session_chain.lease.owner_run_id;
  // 멱등/펜싱 사전조건 (Codex r1 🔴2): 잘못된 key 거부, 이미 spawned 면 재spawn 금지(이중 spawn 차단).
  if (lease.handoff_idempotency_key !== key) return { ok: false, outcome: 'key-mismatch', reason: 'key-mismatch', childRunId };
  // Codex impl r8 🟡: bind the spawn to the RESERVED handoff child — a valid key must not spawn an arbitrary child.
  if (childRunId !== lease.handoff_child_run_id) return { ok: false, outcome: 'child-mismatch', reason: `childRunId ${childRunId} != reserved ${lease.handoff_child_run_id}`, childRunId };
  if (lease.handoff_phase === 'spawned') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
  if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {
    return { ok: false, outcome: 'not-emitted', reason: `phase=${lease.handoff_phase} state=${lease.state}`, childRunId };
  }
  const gate = respawnGate(loop, { now });
  if (!gate.ok) {
    // 실패모드 (A): spawn 시도 안 함 → handoff(emitted) 유지 + paused, 사람 수동 resume.
    // Codex r5 🔴1: lease 가 releasing 중이라 recovery/child 가 사이에 인수 가능 → withLock 내에서
    // 신선한 상태를 읽어 owner/generation 이 아직 일치할 때만 paused 로 기록 (fence-before-write).
    let fenced = false;
    withLock(root, runId, () => {
      const { data } = readState(root, runId);
      const l = data.session_chain.lease;
      if (l.owner_run_id !== parentOwner || l.generation !== generation) { fenced = true; return; }
      data.status = 'paused';
      writeState(root, runId, data);
    });
    if (fenced) return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-pause', childRunId };
    return { ok: false, outcome: 'gate-blocked', reason: gate.reason, childRunId };
  }
  // Codex r2 🔴3: 외부 spawn **이전에** emitted→spawned 를 원자적(withLock CAS)으로 클레임.
  // 동시 호출 둘이 emitted/releasing 을 읽어도 advanceHandoffPhase 가 직렬화되어 1명만 'advanced',
  // 나머지는 'idempotent-noop' → spawn 안 함 (이중 외부 spawn 차단).
  const claim = advanceHandoffPhase(root, runId, { key, toPhase: 'spawned', now, expect: { owner: parentOwner, generation } });
  if (!claim.ok) {
    if (claim.reason === 'fenced') return { ok: false, outcome: 'fenced', reason: 'lease-changed-during-claim', childRunId };
    return { ok: false, outcome: 'phase-error', reason: claim.reason, childRunId };
  }
  if (claim.reason === 'idempotent-noop') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
  // Codex impl r8 🟡: derive handoffRel from the reserved child session (don't trust caller); fall back to arg.
  const childSession = loop.session_chain.sessions.find(s => s.run_id === childRunId);
  const effHandoffRel = (childSession && childSession.handoff_rel) || handoffRel;
  const cmds = buildLaunchCommand({ root, parentRunId: runId, childRunId, handoffRel: effHandoffRel, headless });
  const cmd = headless ? cmds.headless : cmds.interactive;
  try {
    const res = spawnFn(cmd);
    if (res && res.ok === false) throw new Error(res.reason || 'spawn-returned-false');
  } catch (e) {
    // 실패모드 (B): respawn-failed 기록 + chain 정정 + lease 롤백(active/idle)을 ONE 트랜잭션으로
    // (Codex impl r11 🔴: 이벤트 기록과 lease 롤백을 분리하면 half-commit 가능 → 단일 appendAnchored).
    try {
      appendAnchored(root, runId, { type: 'respawn-failed', data: { child_run_id: childRunId, error: String(e.message || e) } }, (l) => {
        const child = l.session_chain.sessions.find(s => s.run_id === childRunId);
        if (child) child.outcome = 'failed_launch';
        const parent = l.session_chain.sessions.find(s => s.superseded_by === childRunId);
        if (parent) parent.superseded_by = null;
        // 부모로 lease 롤백 (releasing/spawned → active/idle, stale TTL 해제)
        l.session_chain.lease = { ...l.session_chain.lease, state: 'active', handoff_phase: 'idle', handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null };
      }, (loop) => {
        if (loop.session_chain.lease.owner_run_id !== parentOwner || loop.session_chain.lease.generation !== generation) {
          throw new Error('RESPAWN_FENCED: failure-append');
        }
      });
    } catch (appendErr) {
      if (String(appendErr.message).startsWith('RESPAWN_FENCED')) {
        // Child already took over the lease — do NOT rollback or mark failed_launch
        return { ok: false, outcome: 'fenced', reason: 'lease-changed-before-failure-record', childRunId };
      }
      throw appendErr;
    }
    return { ok: false, outcome: 'failed_launch', reason: String(e.message || e), childRunId };
  }
  // spawn 성공 → respawn-spawned 기록. lease 는 releasing 유지 — 자식이 releasing 상태를 handshake acquire.
  // (Codex impl r11 🔴: 이벤트 기록과 lease 전이를 분리하면 사이 크래시로 half-commit 가능 → 단일 appendAnchored).
  // Fix 2: state 를 'released' 로 바꾸지 않는다 — 자식이 죽으면 stale TTL 이 복구한다.
  try {
    appendAnchored(root, runId, { type: 'respawn-spawned', data: { child_run_id: childRunId, headless } }, (_l) => {
      // 자식이 releasing 상태의 lease 를 handshake acquire (acquireLease: releasing && owner===handoff_child_run_id).
    }, (loop) => {
      if (loop.session_chain.lease.owner_run_id !== parentOwner || loop.session_chain.lease.generation !== generation) {
        throw new Error('RESPAWN_FENCED: spawned-append');
      }
    });
  } catch (appendErr) {
    if (String(appendErr.message).startsWith('RESPAWN_FENCED')) {
      // Child already owns the lease — do not release or mutate
      return { ok: false, outcome: 'fenced', reason: 'lease-changed-after-spawn', childRunId };
    }
    throw appendErr;
  }
  return { ok: true, outcome: 'spawned', reason: 'spawned', childRunId };
}
