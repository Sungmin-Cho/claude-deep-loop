import { writeState, withReconciledMutationLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';
import { recoveryReservationKind } from './budget.mjs';

const THRESHOLD = 3;

function rearmedActivationDeadline(loop, clock) {
  const safetyNow = new Date(typeof clock === 'function' ? clock() : Number.NaN).getTime();
  if (!Number.isSafeInteger(safetyNow) || safetyNow < 0) {
    throw new Error('INVALID_NOW: breaker reset activation rearm');
  }
  const seconds = loop.session_chain?.activation_deadline_sec ?? 900;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400) {
    throw new Error('INVALID_ACTIVATION_DEADLINE_CONFIG');
  }
  return new Date(safetyNow + seconds * 1_000).toISOString();
}

export function checkBreaker(loop) {
  const cb = loop.circuit_breaker || {};
  if (cb.tripped) return { tripped: true, reason: cb.trip_reason || 'tripped' };
  if ((cb.consecutive_request_changes || 0) >= THRESHOLD) return { tripped: true, reason: 'consecutive-request-changes' };
  return { tripped: false, reason: null };
}

export function tripBreaker(root, runId, reason) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    // v1.6 (spec §2.3-7): fence 파라미터가 없는 legacy export — terminal run을 paused로 강등 금지.
    if (data.status === 'completed' || data.status === 'stopped') throw new Error('RUN_TERMINAL: tripBreaker');
    data.circuit_breaker = { ...data.circuit_breaker, tripped: true, trip_reason: reason };
    data.status = 'paused';
    writeState(root, runId, data);
  });
}

function assertResetBreakerFence(data, fence) {
  const recoveryKind = recoveryReservationKind(data);
  if (recoveryKind !== null) {
    const lease = data.session_chain.lease;
    if (!fence || lease.owner_run_id !== fence.owner || lease.generation !== fence.generation) {
      throw new Error('LEASE_FENCED: recovery-parent-mismatch');
    }
  } else if (fence) {
    const r = leaseCheck(data, fence);
    if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
  }
  return recoveryKind;
}

export function resetBreaker(root, runId, { fence, clock = Date.now } = {}) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    const recoveryKind = recoveryReservationKind(data);
    // v1.6 (spec §2.3-7): fence가 있으면 gateway authorizer의 leaseCheck가
    // LEASE_FENCED: RUN_TERMINAL로 선착한다(채널 보존).
    // fence-less 직접 호출만 이 자체 가드가 잡는다 — 순서가 계약이다.
    if (data.status === 'completed' || data.status === 'stopped') throw new Error('RUN_TERMINAL: resetBreaker');
    const wasBreaker = data.status === 'paused' && /request-changes|consecutive/.test(data.circuit_breaker?.trip_reason || '');
    data.circuit_breaker = { consecutive_request_changes: 0, tripped: false, trip_reason: null };
    if (wasBreaker && recoveryKind === null) {
      data.status = 'running';
      const lease = data.session_chain?.lease;
      if (lease?.activation_deadline_at !== null
        && lease?.activation_deadline_at !== undefined) {
        lease.activation_deadline_at = rearmedActivationDeadline(data, clock);
      }
    }
    writeState(root, runId, data);
    return { ok: true, status: data.status };
  }, { authorize: (_guard, { data }) => assertResetBreakerFence(data, fence) });
}

export function recordReviewVerdict(root, runId, verdict, fence) {
  return withReconciledMutationLock(root, runId, (_guard, { data }) => {
    if (fence) {
      const r = leaseCheck(data, fence);
      if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    } else if (data.session_chain.lease.activation_deadline_at != null) {
      throw new Error('ACTIVATION_PENDING: recordReviewVerdict');
    }
    // v1.6 (spec §2.3-7): legacy export — terminal run에 카운터/paused 강등 write 금지 (fence-less 커버).
    if (data.status === 'completed' || data.status === 'stopped') throw new Error('RUN_TERMINAL: recordReviewVerdict');
    const cb = data.circuit_breaker || { consecutive_request_changes: 0 };
    if (verdict === 'REQUEST_CHANGES') {
      cb.consecutive_request_changes = (cb.consecutive_request_changes || 0) + 1;
      if (cb.consecutive_request_changes >= THRESHOLD && !cb.tripped) {
        cb.tripped = true;
        cb.trip_reason = 'consecutive-request-changes';
        data.status = 'paused';
      }
    } else {
      cb.consecutive_request_changes = 0;   // counter resets; tripped stays latched (human-reset only)
    }
    data.circuit_breaker = cb;
    writeState(root, runId, data);
  });
}
