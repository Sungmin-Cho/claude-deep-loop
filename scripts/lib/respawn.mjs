import { readState, writeState, withLock } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { checkBudget, reconcileBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { advanceHandoffPhase, releaseLease, rollbackHandoff } from './lease.mjs';
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
  // 멱등/펜싱 사전조건 (Codex r1 🔴2): 잘못된 owner/key 거부, 이미 spawned 면 재spawn 금지(이중 spawn 차단).
  if (lease.owner_run_id !== runId) return { ok: false, outcome: 'fenced', reason: 'owner-mismatch', childRunId };
  if (lease.handoff_idempotency_key !== key) return { ok: false, outcome: 'key-mismatch', reason: 'key-mismatch', childRunId };
  if (lease.handoff_phase === 'spawned') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
  if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {
    return { ok: false, outcome: 'not-emitted', reason: `phase=${lease.handoff_phase} state=${lease.state}`, childRunId };
  }
  const gate = respawnGate(loop, { now });
  if (!gate.ok) {
    // 실패모드 (A): spawn 시도 안 함 → handoff(emitted) 유지 + paused, 사람 수동 resume.
    withLock(root, runId, () => { const { data } = readState(root, runId); data.status = 'paused'; writeState(root, runId, data); });
    return { ok: false, outcome: 'gate-blocked', reason: gate.reason, childRunId };
  }
  // Codex r2 🔴3: 외부 spawn **이전에** emitted→spawned 를 원자적(withLock CAS)으로 클레임.
  // 동시 호출 둘이 emitted/releasing 을 읽어도 advanceHandoffPhase 가 직렬화되어 1명만 'advanced',
  // 나머지는 'idempotent-noop' → spawn 안 함 (이중 외부 spawn 차단).
  const claim = advanceHandoffPhase(root, runId, { key, toPhase: 'spawned', now });
  if (!claim.ok) return { ok: false, outcome: 'phase-error', reason: claim.reason, childRunId };
  if (claim.reason === 'idempotent-noop') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
  const cmds = buildLaunchCommand({ root, parentRunId: runId, childRunId, handoffRel, headless });
  const cmd = headless ? cmds.headless : cmds.interactive;
  try {
    const res = spawnFn(cmd);
    if (res && res.ok === false) throw new Error(res.reason || 'spawn-returned-false');
  } catch (e) {
    // 실패모드 (B): spawned→active/idle 롤백 + chain 정정 (인수한 적 없는 세션을 기술하지 않게 superseded_by 해제)
    appendAnchored(root, runId, { type: 'respawn-failed', data: { child_run_id: childRunId, error: String(e.message || e) } }, (l) => {
      const child = l.session_chain.sessions.find(s => s.run_id === childRunId);
      if (child) child.outcome = 'failed_launch';
      const parent = l.session_chain.sessions.find(s => s.superseded_by === childRunId);
      if (parent) parent.superseded_by = null;
    });
    rollbackHandoff(root, runId, { owner: runId, generation });
    return { ok: false, outcome: 'failed_launch', reason: String(e.message || e), childRunId };
  }
  // spawn 성공 → 부모 lease release(자식이 acquire 가능). 전이 반환값 검증(silent 실패 금지).
  appendAnchored(root, runId, { type: 'respawn-spawned', data: { child_run_id: childRunId, headless } });
  const rel = releaseLease(root, runId, { owner: runId, generation });
  if (!rel.ok) return { ok: false, outcome: 'release-error', reason: rel.reason, childRunId };
  return { ok: true, outcome: 'spawned', reason: 'spawned', childRunId };
}
