import { readState, writeState, withLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';

const THRESHOLD = 3;

export function checkBreaker(loop) {
  const cb = loop.circuit_breaker || {};
  if (cb.tripped) return { tripped: true, reason: cb.trip_reason || 'tripped' };
  if ((cb.consecutive_request_changes || 0) >= THRESHOLD) return { tripped: true, reason: 'consecutive-request-changes' };
  return { tripped: false, reason: null };
}

export function tripBreaker(root, runId, reason) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    data.circuit_breaker = { ...data.circuit_breaker, tripped: true, trip_reason: reason };
    data.status = 'paused';
    writeState(root, runId, data);
  });
}

export function recordReviewVerdict(root, runId, verdict, fence) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (fence) {
      const r = leaseCheck(data, fence);
      if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
    }
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
