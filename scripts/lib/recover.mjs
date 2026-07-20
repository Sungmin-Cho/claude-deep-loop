import { readState } from './state.mjs';
import { appendAnchored } from './integrity.mjs';

// Human-approved escape hatch (mirrors breaker reset --confirm) — unstick-for-resume, NOT terminate.
// Clears the stale handoff state so a fresh acquireLease (Task 8) can take over and unpause.
// status stays 'paused'; Task 8's acquireLease will transition it back to 'running'.
export function recoverRun(root, runId, { expect, confirm, now = Date.now() } = {}) {
  if (confirm !== true) throw new Error('CONFIRM_REQUIRED: pass --confirm (human-only)');

  // Early status check (outside lock) — fast path rejection before taking a lock.
  const { data: snap } = readState(root, runId);
  if (snap.status !== 'paused') {
    throw new Error(`NOT_RECOVERABLE: status is ${snap.status}, expected paused`);
  }

  const preCheck = (loop) => {
    // defense-in-depth inside the lock: re-assert status + fence
    const lease = loop.session_chain?.lease;
    if (!lease) throw new Error('LEASE_FENCED: no-lease');
    if (expect) {
      if (lease.owner_run_id !== expect.owner) throw new Error('LEASE_FENCED: owner-mismatch');
      if (lease.generation !== expect.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    }
    if (loop.status !== 'paused') throw new Error(`NOT_RECOVERABLE: status is ${loop.status}, expected paused`);
  };

  const mutate = (loop) => {
    const lease = loop.session_chain.lease;
    const childId = lease.handoff_child_run_id;
    if (childId) {
      const child = loop.session_chain.sessions.find(s => s.run_id === childId);
      if (child && !child.outcome) child.outcome = 'abandoned_recover';
      const parent = loop.session_chain.sessions.find(s => s.superseded_by === childId);
      if (parent) parent.superseded_by = null;
    }
    lease.handoff_child_run_id = null;
    lease.handoff_idempotency_key = null;
    lease.handoff_trigger = null;
    lease.handoff_phase = 'idle';
    lease.state = 'released';
    lease.expires_at = null;
    lease.resume_policy = null;
    loop.pause_reason = 'recovered:awaiting-resume';
    // status stays 'paused' — Task 8's acquireLease will unpause on fresh owner acquisition
  };

  return appendAnchored(root, runId, { type: 'run-recovered', data: {} }, mutate, preCheck);
}
