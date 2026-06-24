import { readState, writeState, withLock } from './state.mjs';

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

export function recordReviewVerdict(root, runId, verdict) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const cb = data.circuit_breaker || { consecutive_request_changes: 0 };
    cb.consecutive_request_changes = verdict === 'REQUEST_CHANGES' ? (cb.consecutive_request_changes || 0) + 1 : 0;
    data.circuit_breaker = cb;
    writeState(root, runId, data);
  });
}
