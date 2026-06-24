import { contentHash, ulid } from './envelope.mjs';
import { readState, writeState, withLock } from './state.mjs';

const PHASE_ORDER = { idle: 0, reserved: 1, emitted: 2, spawned: 3, acquired: 4 };

export function deriveIdempotencyKey(ownerRunId, ownerGeneration, triggerReason) {
  return contentHash(`${ownerRunId}|${ownerGeneration}|${triggerReason}`).slice(0, 16);
}

// 펜싱 가드 — 읽기를 제외한 모든 커널 mutating 경로가 진입 전에 호출 (spec §9.1).
export function leaseCheck(loop, { owner, generation, intent = 'business' } = {}) {
  const lease = loop?.session_chain?.lease;
  if (!lease) return { ok: false, reason: 'no-lease' };
  if (lease.owner_run_id !== owner) return { ok: false, reason: 'owner-mismatch' };
  if (lease.generation !== generation) return { ok: false, reason: 'generation-mismatch' };
  if (lease.state === 'released') return { ok: false, reason: 'lease-released' };
  // 부모 carve-out: releasing 중 업무 write 거부, 자기 lease 관리(intent='lease')만 허용
  if (lease.state === 'releasing' && intent === 'business') return { ok: false, reason: 'lease-releasing-carveout' };
  // Codex r2 🔴2: expires_at 로 active 소유자를 fence 하지 않는다 — 살아있는 소유자가 TTL(15분) 후 자기 write 에서
  // 죽으면 안 됨. stale 소유자(자식이 인수해 generation 이 올라간 경우)는 generation-mismatch 로 이미 펜싱된다.
  // expires_at 는 오직 acquireLease 의 takeover 판단(releasing 크래시)에만 쓰인다.
  return { ok: true, reason: 'ok' };
}

// CAS 인수: released 또는 stale(expired)만, generation === expectGeneration 펜싱. 성공 시 generation+1.
export function acquireLease(root, runId, { owner, expectGeneration, now = Date.now() }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    // 같은 owner 가 이미 active 면 멱등 (active 는 만료 deadline 이 없다 — Codex r2 🔴2)
    if (lease.owner_run_id === owner && lease.state === 'active') {
      return { ok: true, generation: lease.generation, reason: 'already-owned' };
    }
    if (lease.generation !== expectGeneration) {
      return { ok: false, generation: lease.generation, reason: 'generation-mismatch' };
    }
    // takeover 가능: released(정상 인수) 또는 releasing+expired(부모가 handoff 중 크래시). active 는 절대 탈취 안 됨.
    const expired = lease.expires_at && now > Date.parse(lease.expires_at);
    const takeable = lease.state === 'released' || (lease.state === 'releasing' && expired);
    if (!takeable) return { ok: false, generation: lease.generation, reason: 'lease-not-takeable' };
    const iso = new Date(now).toISOString();
    data.session_chain.lease = {
      ...lease, owner_run_id: owner, generation: expectGeneration + 1,
      acquired_at: iso, expires_at: null,   // active 소유자는 deadline 없음 → 무기한 write (renewal 불필요)
      state: 'active', handoff_phase: 'acquired', handoff_idempotency_key: null, handoff_child_run_id: null,
    };
    const childEntry = data.session_chain.sessions.find(s => s.run_id === owner);
    if (childEntry && !childEntry.started_at) childEntry.started_at = iso;
    const parentEntry = data.session_chain.sessions.find(s => s.superseded_by === owner);
    if (parentEntry) parentEntry.outcome = 'took_over';
    writeState(root, runId, data);
    return { ok: true, generation: expectGeneration + 1, reason: 'acquired' };
  });
}

export function releaseLease(root, runId, { owner, generation }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    if (lease.owner_run_id !== owner || lease.generation !== generation) return { ok: false, reason: 'fenced' };
    data.session_chain.lease = { ...lease, state: 'released' };
    writeState(root, runId, data);
    return { ok: true, reason: 'released' };
  });
}

// 멱등키 선예약 CAS — phase∈{idle,acquired}에서만 신규 예약. 이중 트리거를 phase로 봉인 (spec §9.1).
export function reserveHandoff(root, runId, { trigger, now = Date.now() }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    const key = deriveIdempotencyKey(lease.owner_run_id, lease.generation, trigger);
    if (lease.handoff_phase === 'idle' || lease.handoff_phase === 'acquired') {
      // Codex r3 🔴1: childRunId 를 **예약 시점에 결정·영속**한다. 동시/재진입 emit 이 같은 child 를 보게 되어
      // (reserved:false fall-through 가 fresh child 를 만들지 않음) 중복 child 를 봉인한다.
      const childRunId = ulid(now);
      data.session_chain.lease = { ...lease, handoff_phase: 'reserved', handoff_idempotency_key: key, handoff_child_run_id: childRunId };
      writeState(root, runId, data);
      return { ok: true, reserved: true, key, childRunId, reason: 'reserved' };
    }
    if (lease.handoff_idempotency_key === key) return { ok: true, reserved: false, key, childRunId: lease.handoff_child_run_id, reason: 'already-reserved-same-trigger' };
    return { ok: false, reserved: false, key: lease.handoff_idempotency_key, childRunId: lease.handoff_child_run_id, reason: 'handoff-in-flight' };
  });
}

export function advanceHandoffPhase(root, runId, { key, toPhase, now = Date.now() }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };
    const cur = PHASE_ORDER[lease.handoff_phase];
    const next = PHASE_ORDER[toPhase];
    if (next === undefined) return { ok: false, reason: `unknown-phase ${toPhase}` };
    if (next === cur) return { ok: true, reason: 'idempotent-noop' };
    if (next !== cur + 1) return { ok: false, reason: `illegal-transition ${lease.handoff_phase}->${toPhase}` };
    const patch = { handoff_phase: toPhase };
    if (toPhase === 'emitted') {
      // 부모 carve-out 시작 + stale TTL 설정. 부모가 emitted 후 죽어 releaseLease 를 못 해도
      // expires_at 경과 시 자식이 인수 가능 (Codex r1 🔴4: null expires_at 은 영원히 안 만료 → 데드락).
      patch.state = 'releasing';
      const ttlMs = (data.session_chain.stale_lease_ttl_sec || 900) * 1000;
      patch.expires_at = new Date(now + ttlMs).toISOString();
    }
    data.session_chain.lease = { ...lease, ...patch };
    writeState(root, runId, data);
    return { ok: true, reason: 'advanced' };
  });
}

export function rollbackHandoff(root, runId, { owner, generation }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    if (lease.owner_run_id !== owner || lease.generation !== generation) return { ok: false, reason: 'fenced' };
    // active 복귀 시 expires_at=null — 롤백된 부모가 emit 때 설정된 stale TTL 로 나중에 인수당하지 않게 (Codex r2 🔴2)
    data.session_chain.lease = { ...lease, state: 'active', handoff_phase: 'idle', handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null };
    writeState(root, runId, data);
    return { ok: true, reason: 'rolled-back' };
  });
}
