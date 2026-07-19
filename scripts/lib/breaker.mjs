import { contentHash } from './envelope.mjs';
import { authenticateVerifiedMutationCaller, readLines,
  withVerifiedMutationLock } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { runtimeFence } from './runtime.mjs';

const THRESHOLD = 3;

export function checkBreaker(loop) {
  const cb = loop.circuit_breaker || {};
  if (cb.tripped) return { tripped: true, reason: cb.trip_reason || 'tripped' };
  if ((cb.consecutive_request_changes || 0) >= THRESHOLD) return { tripped: true, reason: 'consecutive-request-changes' };
  return { tripped: false, reason: null };
}
function breakerLeaseFence(owner, generation) {
  return loop => {
    const lease = loop.session_chain?.lease;
    if (lease?.owner_run_id !== owner || lease?.generation !== generation) {
      throw new Error('LEASE_FENCED: breaker-mutation');
    }
  };
}

function breakerPendingFence(fence) {
  const identity = breakerLeaseFence(fence.owner, fence.generation);
  return loop => {
    identity(loop);
    if (fence.runtime !== undefined) {
      const runtime = runtimeFence(loop, fence.runtime);
      if (!runtime.ok) throw new Error(`LEASE_FENCED: ${runtime.reason}`);
    }
  };
}

function breakerMutation(root, runId, fence, operation, intent, body) {
  if (typeof fence?.owner !== 'string' || !Number.isSafeInteger(fence?.generation)) {
    throw new Error(`FENCE_REQUIRED: ${operation}`);
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = contentHash(JSON.stringify({ operation, ...callerBinding, ...intent }));
  authenticateVerifiedMutationCaller(root, runId, {
    callerBinding, fenceCheck: breakerPendingFence(fence),
    fenceError: `LEASE_FENCED: ${operation}`,
  });
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: `LEASE_FENCED: ${operation}` }, context => {
    const { data } = context.readVerifiedState(
      { fenceCheck: breakerPendingFence(fence) });
    return body(context, data);
  });
}

const BREAKER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function breakerRequestIdentity(operation, requestId, projection = {}) {
  if (!BREAKER_REQUEST_ID.test(requestId || '')) {
    throw new Error('BREAKER_REQUEST_ID_REQUIRED');
  }
  const requestIdDigest = contentHash(`breaker-${operation}-id\0${requestId}`);
  const requestDigest = contentHash(JSON.stringify({
    contract: 'breaker-request-v1', operation, request_id_digest: requestIdDigest,
    ...projection,
  }));
  return Object.freeze({ requestIdDigest, requestDigest });
}

function recoveredBreakerRequest(root, runId, context, {
  eventType, identity, fence, projectionCheck, response,
}) {
  const lines = readLines(root, runId);
  const matches = lines.filter(event => event.type === eventType
    && event.data?.request_id_digest === identity.requestIdDigest);
  if (matches.length > 1) throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
  if (matches.length === 0) {
    if (context.recovered !== null) {
      throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
    }
    return null;
  }
  const event = matches[0];
  if (event.data?.request_digest !== identity.requestDigest
      || event.data?.owner_run_id !== fence.owner
      || event.data?.generation !== fence.generation
      || !projectionCheck(event.data)) {
    throw new Error('BREAKER_REQUEST_CONFLICT');
  }
  if (context.recovered !== null
      && !context.recovered.events.some(recovered => recovered.seq === event.seq
        && recovered.checksum === event.checksum)) {
    throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
  }
  return { result: response(event.data), lines };
}

function recoveredReviewVerdict(root, runId, context, data,
  { fence, verdict, identity }) {
  const recovered = recoveredBreakerRequest(root, runId, context, {
    eventType: 'breaker-review-verdict', identity, fence,
    projectionCheck: event => event.verdict === verdict,
    response: event => ({ ok: true, changed: event.changed }),
  });
  if (recovered === null) return null;
  const { result, lines } = recovered;
  let count = null;
  for (const item of lines) {
    if (item.type === 'breaker-reset') {
      if (item.data?.next_count !== 0) {
        throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
      }
      count = 0;
      continue;
    }
    if (item.type === 'review-outcome') {
      if (count !== null) {
        if (item.data?.verdict === 'REQUEST_CHANGES') count += 1;
        else if (item.data?.verdict === 'APPROVE'
            || item.data?.verdict === 'CONCERN') count = 0;
        else throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
      }
      continue;
    }
    if (item.type !== 'breaker-review-verdict') continue;
    const baseline = item.data?.baseline_count;
    if (count === null) {
      if (!Number.isSafeInteger(baseline) || baseline < 0) {
        throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
      }
      count = baseline;
    } else if (baseline !== null) {
      throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
    }
    const previous = item.data?.previous_count;
    const next = item.data?.next_count;
    const expected = item.data?.verdict === 'REQUEST_CHANGES' ? count + 1 : 0;
    const expectedChanged = item.data?.verdict === 'REQUEST_CHANGES' || count !== 0;
    if (!Number.isSafeInteger(previous) || previous !== count
        || !Number.isSafeInteger(next) || next !== expected
        || item.data?.changed !== expectedChanged
        || typeof item.data?.breaker_tripped !== 'boolean') {
      throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
    }
    count = next;
  }
  if ((count ?? 0) !== (data.circuit_breaker?.consecutive_request_changes || 0)) {
    throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
  }
  return result;
}

export function tripBreaker(root, runId, reason,
  { fence, requestId } = {}) {
  if (typeof fence?.owner !== 'string' || !Number.isSafeInteger(fence?.generation)) {
    throw new Error('FENCE_REQUIRED: breaker-trip');
  }
  const identity = breakerRequestIdentity('trip', requestId, { reason });
  return breakerMutation(root, runId, fence, 'breaker-trip',
    { request_digest: identity.requestDigest }, (context, data) => {
      if (['completed', 'stopped'].includes(data.status)) {
        throw new Error('RUN_TERMINAL: tripBreaker');
      }
      const recovered = recoveredBreakerRequest(root, runId, context, {
        eventType: 'breaker-tripped', identity, fence,
        projectionCheck: event => event.reason === reason,
        response: event => ({ ok: true, changed: event.changed }),
      });
      if (recovered !== null) return recovered.result;
      const authorized = leaseCheck(data, { ...fence, intent: fence.intent ?? 'business' });
      if (!authorized.ok) throw new Error(`LEASE_FENCED: ${authorized.reason}`);
      const changed = !(data.circuit_breaker?.tripped
        && data.circuit_breaker?.trip_reason === reason && data.status === 'paused');
      context.appendAnchored({ type: 'breaker-tripped', data: {
        owner_run_id: fence.owner, generation: fence.generation, reason,
        request_id_digest: identity.requestIdDigest,
        request_digest: identity.requestDigest, changed,
      } }, candidate => {
        if (!changed) return;
        candidate.circuit_breaker = { ...candidate.circuit_breaker,
          tripped: true, trip_reason: reason };
        candidate.status = 'paused';
      });
      return { ok: true, changed };
    });
}

export function resetBreaker(root, runId, { fence, requestId } = {}) {
  if (typeof fence?.owner !== 'string' || !Number.isSafeInteger(fence?.generation)) {
    throw new Error('FENCE_REQUIRED: breaker-reset');
  }
  const identity = breakerRequestIdentity('reset', requestId);
  return breakerMutation(root, runId, fence, 'breaker-reset',
    { request_digest: identity.requestDigest }, (context, data) => {
      const authorized = leaseCheck(data, { ...fence, intent: 'breaker-reset' });
      if (!authorized.ok) throw new Error(`LEASE_FENCED: ${authorized.reason}`);
      const recovered = recoveredBreakerRequest(root, runId, context, {
        eventType: 'breaker-reset', identity, fence,
        projectionCheck: event => event.operation === 'reset',
        response: event => ({ ok: true, changed: event.changed,
          status: event.next_status }),
      });
      if (recovered !== null) return recovered.result;
      const wasBreaker = data.status === 'paused'
        && /request-changes|consecutive/.test(data.circuit_breaker?.trip_reason || '');
      const alreadyReset = data.circuit_breaker?.consecutive_request_changes === 0
        && data.circuit_breaker?.tripped === false
        && data.circuit_breaker?.trip_reason == null;
      const changed = !alreadyReset || wasBreaker;
      const nextStatus = wasBreaker ? 'running' : data.status;
      context.appendAnchored({ type: 'breaker-reset', data: {
        owner_run_id: fence.owner, generation: fence.generation, operation: 'reset',
        request_id_digest: identity.requestIdDigest,
        request_digest: identity.requestDigest, was_breaker: wasBreaker,
        previous_count: data.circuit_breaker?.consecutive_request_changes || 0,
        next_count: 0, changed, next_status: nextStatus,
      } }, candidate => {
        if (!changed) return;
        candidate.circuit_breaker = {
          consecutive_request_changes: 0, tripped: false, trip_reason: null };
        if (wasBreaker) candidate.status = 'running';
      }, undefined, { allowTerminal: false });
      return { ok: true, changed, status: nextStatus };
    });
}

export function recordReviewVerdict(root, runId, verdict, fence,
  { requestId } = {}) {
  if (typeof fence?.owner !== 'string' || !Number.isSafeInteger(fence?.generation)) {
    throw new Error('FENCE_REQUIRED: breaker-review-verdict');
  }
  if (typeof fence.runtime !== 'string') {
    throw new Error('RUNTIME_REQUIRED: breaker-review-verdict');
  }
  const identity = breakerRequestIdentity('review-verdict', requestId, { verdict });
  return breakerMutation(root, runId, fence, 'breaker-review-verdict',
    { verdict, request_digest: identity.requestDigest },
    (context, data) => {
      if (context.recoverySource === 'pending') {
        const pending = recoveredReviewVerdict(root, runId, context, data,
          { fence, verdict, identity });
        if (pending === null) throw new Error('BREAKER_RECOVERY_PROJECTION_MISMATCH');
        return pending;
      }
      const authorized = leaseCheck(data, { ...fence, intent: fence.intent ?? 'business' });
      if (!authorized.ok) {
        if (authorized.reason === 'RUN_TERMINAL') {
          throw new Error('RUN_TERMINAL: recordReviewVerdict');
        }
        throw new Error(`LEASE_FENCED: ${authorized.reason}`);
      }
      const recovered = recoveredReviewVerdict(root, runId, context, data,
        { fence, verdict, identity });
      if (recovered !== null) return recovered;
      const current = data.circuit_breaker?.consecutive_request_changes || 0;
      const lineage = readLines(root, runId).some(event =>
        event.type === 'breaker-reset' || event.type === 'breaker-review-verdict');
      const baselineCount = lineage ? null : current;
      const changed = verdict === 'REQUEST_CHANGES' || current !== 0;
      const next = verdict === 'REQUEST_CHANGES' ? current + 1 : 0;
      const breakerTripped = data.circuit_breaker?.tripped === true
        || (verdict === 'REQUEST_CHANGES' && next >= THRESHOLD);
      context.appendAnchored({ type: 'breaker-review-verdict', data: {
        owner_run_id: fence.owner, generation: fence.generation, verdict,
        request_id_digest: identity.requestIdDigest,
        request_digest: identity.requestDigest,
        previous_count: current, next_count: next,
        baseline_count: baselineCount, breaker_tripped: breakerTripped, changed,
      } }, candidate => {
        if (!changed) return;
        const breaker = { ...candidate.circuit_breaker };
        if (verdict === 'REQUEST_CHANGES') {
          breaker.consecutive_request_changes = next;
          if (breaker.consecutive_request_changes >= THRESHOLD && !breaker.tripped) {
            breaker.tripped = true; breaker.trip_reason = 'consecutive-request-changes';
            candidate.status = 'paused';
          }
        } else {
          breaker.consecutive_request_changes = 0;
        }
        candidate.circuit_breaker = breaker;
      });
      return { ok: true, changed };
    });
}
