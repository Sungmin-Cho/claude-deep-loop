import { readLines, withVerifiedMutationLock } from './integrity.mjs';
import { contentHash } from './envelope.mjs';
import { validate } from './schema.mjs';

// Human-approved escape hatch (mirrors breaker reset --confirm) — unstick-for-resume, NOT terminate.
// Clears the stale handoff state so a fresh acquireLease (Task 8) can take over and unpause.
// status stays 'paused'; Task 8's acquireLease will transition it back to 'running'.
function recoveryIdentityFence(expect) {
  return loop => {
    const lease = loop.session_chain?.lease;
    if (lease?.owner_run_id !== expect.owner || lease?.generation !== expect.generation) {
      throw new Error('LEASE_FENCED: recover');
    }
  };
}

function inspectRecoveryBinding(loop) {
  const lease = loop.session_chain.lease;
  const childId = lease.handoff_child_run_id;
  const child = childId
    ? loop.session_chain.sessions.find(session => session.run_id === childId) : null;
  const continuation = child?.continuation;
  if (childId == null) {
    return loop.initialization === undefined ? null : Object.freeze({ kind: 'no-child',
      ownerRunId: lease.owner_run_id, generation: lease.generation });
  }
  const exactReservationOnly = child == null && lease.handoff_transport == null
    && lease.state === 'active' && lease.handoff_phase === 'reserved'
    && lease.handoff_attempt_id == null && lease.resume_policy === 'human'
    && lease.expires_at == null && typeof lease.handoff_idempotency_key === 'string'
    && !loop.session_chain.sessions.some(session => session.superseded_by === childId);
  if (exactReservationOnly) return Object.freeze({ kind: 'reservation-only', childRunId: childId,
    ownerRunId: lease.owner_run_id, generation: lease.generation });
  if (!child) throw new Error('RECOVERY_CHILD_BINDING_INVALID');
  const common = { childRunId: child.run_id, ownerRunId: lease.owner_run_id,
    generation: lease.generation };
  if (loop.initialization === undefined) {
    return Object.freeze({ ...common, kind: 'legacy-child', attemptId: null,
      failureCode: null });
  }
  if (lease.handoff_transport !== 'codex-app') {
    if (continuation != null || child.outcome != null) {
      throw new Error('RECOVERY_TRANSPORT_BINDING_INVALID');
    }
    return Object.freeze({ ...common, kind: 'bound-child', attemptId: null,
      failureCode: null });
  }
  if (continuation?.transport !== 'codex-app'
      || continuation.attempt_id !== lease.handoff_attempt_id
      || continuation.phase === 'acquired') {
    throw new Error('APP_RECOVERY_BINDING_INVALID');
  }
  if (continuation.phase === 'failed'
      && (continuation.failure_binding?.owner_run_id !== lease.owner_run_id
        || continuation.failure_binding?.generation !== lease.generation)) {
    throw new Error('APP_RECOVERY_FAILURE_BINDING_INVALID');
  }
  const live = ['emitted', 'prepared', 'confirmed'].includes(continuation.phase);
  return Object.freeze({ ...common, kind: 'bound-child', attemptId: continuation.attempt_id,
    failureCode: live ? 'human-recovered' : continuation.failure_code });
}

function sameRecoveryBinding(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyRecovery(loop, binding) {
  const lease = loop.session_chain.lease;
  const childId = lease.handoff_child_run_id;
  const child = childId
    ? loop.session_chain.sessions.find(session => session.run_id === childId) : null;
  const continuation = child?.continuation;
  if (binding?.kind === 'bound-child' && binding.attemptId != null
      && ['emitted', 'prepared', 'confirmed'].includes(continuation.phase)) {
    continuation.phase = 'abandoned';
    continuation.failure_code = 'human-recovered';
  }
  if (binding?.kind === 'legacy-child' && child && !child.outcome) {
    child.outcome = 'abandoned_recover';
  }
  if (binding?.kind === 'bound-child') {
    child.outcome = 'abandoned_recover';
    child.recovery_binding = {
      owner_run_id: lease.owner_run_id,
      generation: lease.generation,
    };
  }
  const parent = loop.session_chain.sessions.find(session => session.superseded_by === childId);
  if (parent) parent.superseded_by = null;
  Object.assign(lease, { handoff_transport: null, handoff_attempt_id: null,
    handoff_child_run_id: null, handoff_idempotency_key: null, handoff_phase: 'idle',
    state: 'released', expires_at: null, resume_policy: null });
  loop.pause_reason = 'recovered:awaiting-resume';
}

function alreadyRecoveredStateProjection(loop, expect) {
  const lease = loop.session_chain?.lease ?? {};
  const cleared = ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
    'handoff_idempotency_key', 'resume_policy', 'expires_at']
    .every(key => lease[key] == null);
  return loop.status === 'paused' && loop.pause_reason === 'recovered:awaiting-resume'
    && lease.owner_run_id === expect.owner && lease.generation === expect.generation
    && lease.state === 'released' && lease.handoff_phase === 'idle' && cleared;
}

function exactAlreadyRecoveredProjection(loop, expect, lines) {
  if (!alreadyRecoveredStateProjection(loop, expect)) return false;
  if (loop.initialization === undefined) return true;
  const tail = lines?.at(-1);
  return tail?.type === 'run-recovered'
    && tail.data?.owner_run_id === expect.owner
    && tail.data?.generation === expect.generation
    && tail.seq === loop.event_log_head?.seq
    && tail.checksum === loop.event_log_head?.checksum;
}

export function recoverRun(root, runId,
  { expect, confirm, now, nowFn = now === undefined ? Date.now : () => now } = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');
  if (!expect || typeof expect.owner !== 'string'
      || !Number.isInteger(expect.generation)) throw new Error('FENCE_REQUIRED: recoverRun');
  const fenceCheck = recoveryIdentityFence(expect);
  const callerBinding = { owner: expect.owner, generation: expect.generation };
  const intentDigest = contentHash(JSON.stringify({ operation: 'recover-run',
    owner: expect.owner, generation: expect.generation, confirm: true }));
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: recoverRun' }, mutation => {
    const snapshot = mutation.readVerifiedState({ fenceCheck }).data;
    const lines = readLines(root, runId);
    if (exactAlreadyRecoveredProjection(snapshot, expect, lines)) {
      return { ok: true, reason: 'already-recovered' };
    }
    if (alreadyRecoveredStateProjection(snapshot, expect)) {
      throw new Error('APP_RECOVERY_PROJECTION_CHANGED');
    }
    if (snapshot.status !== 'paused') {
      throw new Error(`NOT_RECOVERABLE: status is ${snapshot.status}, expected paused`);
    }
    const binding = inspectRecoveryBinding(snapshot);
    const eventData = binding == null || binding.kind === 'legacy-child' ? {}
      : binding.kind === 'bound-child' ? {
        ...(binding.attemptId == null ? {} : { attempt_id: binding.attemptId,
          failure_code: binding.failureCode }),
        child_run_id: binding.childRunId, owner_run_id: binding.ownerRunId,
        generation: binding.generation,
      } : { owner_run_id: binding.ownerRunId, generation: binding.generation };
    return mutation.appendAnchored({ type: 'run-recovered', data: eventData },
    loop => applyRecovery(loop, binding),
    loop => {
      if (loop.status !== 'paused') {
        throw new Error(`NOT_RECOVERABLE: status is ${loop.status}, expected paused`);
      }
      if (alreadyRecoveredStateProjection(loop, expect)) {
        throw new Error('APP_RECOVERY_PROJECTION_CHANGED');
      }
      const freshBinding = inspectRecoveryBinding(loop);
      if (!sameRecoveryBinding(freshBinding, binding)) {
        throw new Error('APP_RECOVERY_BINDING_CHANGED');
      }
      const candidate = structuredClone(loop);
      applyRecovery(candidate, binding);
      const checked = validate(candidate);
      if (!checked.ok) throw new Error(`STATE_INVALID: ${checked.errors.join('; ')}`);
    }, { nowFn, fenceCheck });
  });
}
