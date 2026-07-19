import { contentHash, ulid } from './envelope.mjs';
import { runtimeFence } from './runtime.mjs';
import { readState } from './state.mjs';
import { assertVerifiedRunSnapshot, commitVerifiedEventsUnderLock, readLines,
  withVerifiedMutationLock } from './integrity.mjs';

const PHASE_ORDER = { idle: 0, reserved: 1, emitted: 2, spawned: 3, acquired: 4 };

export function deriveIdempotencyKey(ownerRunId, ownerGeneration, triggerReason) {
  return contentHash(`${ownerRunId}|${ownerGeneration}|${triggerReason}`).slice(0, 16);
}
// 펜싱 가드 — 읽기를 제외한 모든 커널 mutating 경로가 진입 전에 호출 (spec §9.1).
// RUN_PAUSED gate: paused 상태에서 업무 write 거부. 예외 intent: 'recover', 'resume', 'breaker-reset'.
export function leaseCheck(loop, { owner, generation, runtime, intent = 'business' } = {}) {
  if (runtime !== undefined) {
    const fence = runtimeFence(loop, runtime);
    if (!fence.ok) return fence;
  }
  const lease = loop?.session_chain?.lease;
  if (!lease) return { ok: false, reason: 'no-lease' };
  if (lease.owner_run_id !== owner) return { ok: false, reason: 'owner-mismatch' };
  if (lease.generation !== generation) return { ok: false, reason: 'generation-mismatch' };
  // v1.6 terminal guard (spec §2.1): terminal은 one-way — 전 intent 거부(예외 없음, 사람 확정 2026-07-09).
  // lease.state 체크보다 앞이어야 terminal+released/terminal+releasing에서도 reason이 안정적으로
  // RUN_TERMINAL이다(r3 🟡3). fence(owner/generation) 불일치는 위에서 선착(fence-first, pauseRun 전례).
  if (loop.status === 'completed' || loop.status === 'stopped') return { ok: false, reason: 'RUN_TERMINAL' };
  if (lease.state === 'released') return { ok: false, reason: 'lease-released' };
  // 부모 carve-out: releasing 중 업무 write 거부; 자기 lease 관리(intent='lease')와 비용 회계(intent='accounting')만 허용.
  if (lease.state === 'releasing' && intent !== 'lease' && intent !== 'accounting'
      && intent !== 'app-revoke') return { ok: false, reason: 'lease-releasing-carveout' };
  // Codex r2 🔴2: expires_at 로 active 소유자를 fence 하지 않는다 — 살아있는 소유자가 TTL(15분) 후 자기 write 에서
  // 죽으면 안 됨. stale 소유자(자식이 인수해 generation 이 올라간 경우)는 generation-mismatch 로 이미 펜싱된다.
  // expires_at 는 오직 acquireLease 의 takeover 판단(releasing 크래시)에만 쓰인다.
  // RUN_PAUSED: paused 상태 → 업무/lease write 차단. 인간 전용 경로 외에, 이미 소비된
  // checker turn을 최종 import 후 기록하는 matching accounting만 허용한다. 상단 owner/generation,
  // terminal, released/releasing 가드를 모두 통과해야 하므로 소유권이나 업무 권한은 넓어지지 않는다.
  if (loop.status === 'paused' && intent !== 'accounting'
    && intent !== 'recover' && intent !== 'resume' && intent !== 'breaker-reset'
    && intent !== 'app-revoke') {
    return { ok: false, reason: 'RUN_PAUSED' };
  }
  return { ok: true, reason: 'ok' };
}

// Runtime-fenced CAS 인수: released 또는 stale(expired)만, generation === expectGeneration. 성공 시 generation+1.
export function acquireLease(root, runId, { owner, expectGeneration, runtime,
  now = Date.now() } = {}) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('INVALID_OWNER');
  const callerBinding = { owner, generation: expectGeneration };
  const intentDigest = contentHash(JSON.stringify({ operation: 'lease-acquire',
    owner, expectGeneration, runtime }));
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: acquireLease' }, () => {
    const { data, hash: baseStateHash } = readState(root, runId);
    const runtimeResult = runtimeFence(data, runtime);
    if (!runtimeResult.ok) return runtimeResult;
    const lease = data.session_chain.lease;
    // 같은 owner 가 이미 active 면 멱등 (active 는 만료 deadline 이 없다 — Codex r2 🔴2)
    if (lease.owner_run_id === owner && lease.state === 'active') {
      assertVerifiedRunSnapshot(root, runId, data);
      // v1.6 (spec §2.3-6, r5 P2-b): terminal+active(정상 finish 상태)에서 멱등 성공(already-owned)으로
      // 위장 금지 — resume이 소유권 경계에서 명확히 거부되어야 한다.
      if (data.status === 'stopped' || data.status === 'completed') {
        return { ok: false, generation: lease.generation, reason: 'run-terminal' };
      }
      if (lease.handoff_phase === 'reserved') {
        return { ok: false, generation: lease.generation, reason: 'handoff-reserved' };
      }
      return { ok: true, generation: lease.generation, reason: 'already-owned' };
    }
    if (lease.generation !== expectGeneration) {
      return { ok: false, generation: lease.generation, reason: 'generation-mismatch' };
    }
    const lines = readLines(root, runId);
    assertVerifiedRunSnapshot(root, runId, data, { lines });
    // v1.6 (spec §2.3-6): generation CAS 직후·takeable 체크 앞 — stale expectGeneration은 위에서
    // generation-mismatch(fence-first), generation이 맞는 terminal acquire는 여기서 안정적으로 run-terminal
    // (기존 위치는 takeable 뒤라 terminal+released가 lease-not-takeable/child-not-reserved로 새었다).
    // A recovered run is 'paused' (not terminal) so it remains acquireable.
    if (data.status === 'stopped' || data.status === 'completed') {
      return { ok: false, generation: lease.generation, reason: 'run-terminal' };
    }
    if (lease.state === 'active' && lease.handoff_phase === 'reserved') {
      return { ok: false, generation: lease.generation, reason: 'handoff-reserved' };
    }
    // takeover 가능: released(정상 인수), releasing+expired(부모 크래시 복구), releasing+예약된child(handshake). active 절대 탈취 안 됨.
    const expired = lease.expires_at && now > Date.parse(lease.expires_at);
    const takeable = lease.state === 'released' || (lease.state === 'releasing' && expired) || (lease.state === 'releasing' && owner === lease.handoff_child_run_id);
    if (!takeable) return { ok: false, generation: lease.generation, reason: 'lease-not-takeable' };
    // Codex impl r9 🔴: a RELEASED handoff lease reserved a specific child — only that child may acquire it
    // (binds reserve→emit→claim→release→acquire). After stale TTL (expired), allow recovery by any owner.
    if (lease.state === 'released' && lease.handoff_child_run_id && owner !== lease.handoff_child_run_id && !expired) {
      return { ok: false, generation: lease.generation, reason: 'child-not-reserved' };
    }
    const waspaused = data.status === 'paused';
    const generation = expectGeneration + 1;
    const eventData = { previous_owner_run_id: lease.owner_run_id,
      previous_generation: expectGeneration, owner_run_id: owner, generation };
    commitVerifiedEventsUnderLock(root, runId, data,
      [{ type: 'lease-acquired', data: eventData, now }],
      (candidate, _spent, committed) => {
        const iso = committed[0].ts;
        candidate.session_chain.lease = {
          ...candidate.session_chain.lease, owner_run_id: owner, generation,
          acquired_at: iso, expires_at: null, state: 'active', handoff_phase: 'acquired',
          handoff_idempotency_key: null, handoff_child_run_id: null,
        };
        if (waspaused) {
          candidate.status = 'running';
          candidate.pause_reason = null;
          candidate.session_chain.lease.resume_policy = null;
        }
        const childEntry = candidate.session_chain.sessions
          .find(session => session.run_id === owner);
        if (childEntry && !childEntry.started_at) childEntry.started_at = iso;
        const parentEntry = candidate.session_chain.sessions
          .find(session => session.superseded_by === owner);
        if (parentEntry) parentEntry.outcome = 'took_over';
      }, { baseLines: lines, baseStateHash, callerBinding, intentDigest });
    return { ok: true, generation, reason: 'acquired' };
  });
}

function runLeaseJournal(root, runId,
  { owner, generation, operation, intent = {}, mutation = null }, body) {
  const callerBinding = { owner, generation };
  const intentDigest = contentHash(JSON.stringify({ operation, owner, generation, ...intent }));
  const execute = context => body(context);
  return mutation ? execute(mutation)
    : withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
      fenceError: `LEASE_FENCED: ${operation}` }, execute);
}

function exactLeaseFence(owner, generation) {
  return loop => {
    const lease = loop.session_chain?.lease;
    if (lease?.owner_run_id !== owner || lease?.generation !== generation) {
      throw new Error('LEASE_FENCED: lease-mutation');
    }
  };
}

export function releaseLease(root, runId,
  { owner, generation, mutation = null } = {}) {
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('INVALID_OWNER');
  return runLeaseJournal(root, runId,
    { owner, generation, operation: 'lease-release', mutation }, context => {
      const { data } = context.readVerifiedState({ fenceCheck: exactLeaseFence(owner, generation) });
      const lease = data.session_chain.lease;
      const terminal = ['completed', 'stopped'].includes(data.status);
      const liveAppBinding = lease.handoff_transport === 'codex-app'
        || lease.handoff_attempt_id != null
        || data.session_chain.sessions.some(session => session.run_id === lease.handoff_child_run_id
          && session.continuation?.transport === 'codex-app'
          && ['emitted', 'prepared', 'confirmed'].includes(session.continuation.phase));
      if (data.status === 'paused') return { ok: false, reason: 'RUN_PAUSED' };
      if (lease.handoff_phase === 'reserved') return { ok: false, reason: 'handoff-reserved' };
      if (terminal && liveAppBinding) return { ok: false, reason: 'app-binding-live-terminal' };
      if (lease.state === 'released') return { ok: true, reason: 'already-released' };
      context.appendAnchored({ type: 'lease-released',
        data: { owner_run_id: owner, generation } }, candidate => {
        candidate.session_chain.lease = { ...candidate.session_chain.lease, state: 'released' };
      }, undefined, { allowTerminal: terminal && !liveAppBinding,
        fenceCheck: exactLeaseFence(owner, generation) });
      return { ok: true, reason: 'released' };
    });
}

export function reserveHandoff(root, runId,
  { trigger, now = Date.now(), expect, mutation = null } = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isSafeInteger(expect.generation)) {
    throw new Error('FENCE_REQUIRED: reserveHandoff');
  }
  const key = deriveIdempotencyKey(expect.owner, expect.generation, trigger);
  return runLeaseJournal(root, runId, { owner: expect.owner, generation: expect.generation,
    operation: 'handoff-reserve', intent: { key_digest: contentHash(key) }, mutation }, context => {
    const { data } = context.readVerifiedState(
      { fenceCheck: exactLeaseFence(expect.owner, expect.generation) });
    const lease = data.session_chain.lease;
    if (['completed', 'stopped'].includes(data.status)) {
      return { ok: false, reserved: false, reason: 'RUN_TERMINAL', key: null, childRunId: null };
    }
    if (data.status === 'paused') {
      return { ok: false, reserved: false, reason: 'RUN_PAUSED', key: null, childRunId: null };
    }
    const exactRetry = lease.handoff_idempotency_key === key
      && typeof lease.handoff_child_run_id === 'string'
      && ((lease.state === 'active' && lease.handoff_phase === 'reserved')
        || (['releasing', 'released'].includes(lease.state)
          && ['emitted', 'spawned'].includes(lease.handoff_phase)));
    if (exactRetry) return { ok: true, reserved: false, key,
      childRunId: lease.handoff_child_run_id, reason: 'already-reserved-same-trigger' };
    if (lease.state !== 'active') {
      return { ok: false, reserved: false, key: null,
        childRunId: null, reason: 'lease-not-active' };
    }
    if (!['idle', 'acquired'].includes(lease.handoff_phase)) {
      return { ok: false, reserved: false, key: lease.handoff_idempotency_key,
        childRunId: lease.handoff_child_run_id, reason: 'handoff-in-flight' };
    }
    const childRunId = ulid(now);
    context.appendAnchored({ type: 'handoff-reserved', data: {
      owner_run_id: expect.owner, generation: expect.generation,
      key_digest: contentHash(key), child_run_id: childRunId,
    } }, candidate => {
      candidate.session_chain.lease = { ...candidate.session_chain.lease,
        handoff_phase: 'reserved', handoff_idempotency_key: key,
        handoff_child_run_id: childRunId };
    }, undefined, { nowFn: () => now,
      fenceCheck: exactLeaseFence(expect.owner, expect.generation) });
    return { ok: true, reserved: true, key, childRunId, reason: 'reserved' };
  });
}

export function advanceHandoffPhase(root, runId,
  { key, toPhase, now = Date.now(), expect, mutation = null } = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isSafeInteger(expect.generation)) {
    throw new Error('FENCE_REQUIRED: advanceHandoffPhase');
  }
  return runLeaseJournal(root, runId, { owner: expect.owner, generation: expect.generation,
    operation: 'handoff-phase-advance',
    intent: { key_digest: contentHash(key), to_phase: toPhase }, mutation }, context => {
    const { data } = context.readVerifiedState(
      { fenceCheck: exactLeaseFence(expect.owner, expect.generation) });
    const lease = data.session_chain.lease;
    if (['completed', 'stopped'].includes(data.status)) return { ok: false, reason: 'RUN_TERMINAL' };
    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };
    const current = PHASE_ORDER[lease.handoff_phase];
    const next = PHASE_ORDER[toPhase];
    if (next === undefined) return { ok: false, reason: `unknown-phase ${toPhase}` };
    if (next === current) return { ok: true, reason: 'idempotent-noop' };
    if (next !== current + 1) {
      return { ok: false, reason: `illegal-transition ${lease.handoff_phase}->${toPhase}` };
    }
    const patch = { handoff_phase: toPhase };
    if (toPhase === 'emitted') {
      patch.state = 'releasing';
      patch.expires_at = new Date(now
        + (data.session_chain.stale_lease_ttl_sec || 900) * 1_000).toISOString();
    }
    context.appendAnchored({ type: 'handoff-phase-advanced', data: {
      owner_run_id: expect.owner, generation: expect.generation,
      key_digest: contentHash(key), from_phase: lease.handoff_phase, to_phase: toPhase,
    } }, candidate => {
      candidate.session_chain.lease = { ...candidate.session_chain.lease, ...patch };
    }, undefined, { nowFn: () => now,
      fenceCheck: exactLeaseFence(expect.owner, expect.generation) });
    return { ok: true, reason: 'advanced' };
  });
}

export function rollbackHandoff(root, runId, { owner, generation, mutation = null }) {
  return runLeaseJournal(root, runId,
    { owner, generation, operation: 'handoff-rollback', mutation }, context => {
      const { data } = context.readVerifiedState({ fenceCheck: exactLeaseFence(owner, generation) });
      const lease = data.session_chain.lease;
      const terminal = ['completed', 'stopped'].includes(data.status);
      const empty = lease.handoff_phase === 'idle' && lease.handoff_idempotency_key == null
        && lease.handoff_child_run_id == null;
      if (empty) return { ok: true, reason: terminal ? 'noop-idle-terminal' : 'noop-idle' };
      context.appendAnchored({ type: 'handoff-rolled-back',
        data: { owner_run_id: owner, generation, terminal } }, candidate => {
        candidate.session_chain.lease = { ...candidate.session_chain.lease,
          state: terminal ? 'released' : 'active', handoff_phase: 'idle',
          handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null };
      }, undefined, { allowTerminal: terminal, fenceCheck: exactLeaseFence(owner, generation) });
      return { ok: true, reason: 'rolled-back' };
    });
}

export function rollbackReservedHandoff(root, runId,
  { owner, generation, key, childRunId, mutation = null }) {
  const callerBinding = { owner, generation };
  const intentDigest = contentHash(JSON.stringify({ operation: 'rollback-reserved-handoff',
    owner, generation, key_digest: contentHash(key), child_run_id: childRunId }));
  const execute = context => {
    let data;
    try {
      ({ data } = context.readVerifiedState({ fenceCheck: exactLeaseFence(owner, generation) }));
    } catch (error) {
      if (String(error?.message || error).startsWith('LEASE_FENCED:')) {
        return { ok: false, reason: 'fenced' };
      }
      throw error;
    }
    const lease = data.session_chain.lease;
    const exactReservation = lease.state === 'active' && lease.handoff_phase === 'reserved'
      && typeof key === 'string' && typeof childRunId === 'string'
      && lease.handoff_idempotency_key === key
      && lease.handoff_child_run_id === childRunId
      && !data.session_chain.sessions.some(session => session.run_id === childRunId);
    if (!exactReservation || ['completed', 'stopped'].includes(data.status)) {
      return { ok: false, reason: 'reservation-changed' };
    }
    context.appendAnchored({ type: 'handoff-rolled-back',
      data: { owner_run_id: owner, generation, terminal: false } }, candidate => {
      candidate.session_chain.lease = { ...candidate.session_chain.lease,
        state: 'active', handoff_phase: 'idle', handoff_idempotency_key: null,
        handoff_child_run_id: null, expires_at: null };
    });
    return { ok: true, reason: 'rolled-back-exact-reservation' };
  };
  return mutation ? execute(mutation)
    : withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
      fenceError: 'LEASE_FENCED: rollback-reserved-handoff' }, execute);
}
