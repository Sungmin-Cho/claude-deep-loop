import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';

function exactApproval(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('style') || !keys.includes('approved_at')) return false;
  if (!['visible', 'desktop'].includes(value.style) || typeof value.approved_at !== 'string') return false;
  const parsed = new Date(value.approved_at);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.approved_at;
}

function approvedAtFromNow(now) {
  if (!Number.isFinite(now)) return null;
  try {
    const approvedAt = new Date(now).toISOString();
    return new Date(approvedAt).toISOString() === approvedAt ? approvedAt : null;
  } catch {
    return null;
  }
}

function assertFence(fence, operation) {
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isInteger(fence.generation)) {
    throw new Error(`FENCE_REQUIRED: ${operation}`);
  }
}

// Pure style-bound human authorization. Executable identity revalidation and
// trusted command construction remain mandatory respawn stages after this gate.
export function attendedLaunchAuthorized(loop, style) {
  if (!['visible', 'desktop'].includes(style)) return false;
  if (loop?.autonomy?.spawn_style !== style) return false;
  const approval = loop?.autonomy?.attended_launch_approval;
  return exactApproval(approval) && approval.style === style;
}

export function approveAttendedLaunch(root, runId, {
  style, confirm, fence, now = Date.now(),
} = {}) {
  assertFence(fence, 'approveAttendedLaunch');
  if (confirm !== true) return { ok: false, reason: 'CONFIRM_REQUIRED' };
  if (style === 'desktop') return { ok: false, reason: 'DESKTOP_FLOW_REQUIRED' };
  if (style !== 'visible') return { ok: false, reason: 'STYLE_INVALID' };
  const approvedAt = approvedAtFromNow(now);
  if (approvedAt == null) return { ok: false, reason: 'INVALID_NOW' };

  appendAnchored(
    root,
    runId,
    { type: 'attended-launch-approved', data: { style }, now },
    (loop) => {
      loop.autonomy.spawn_style = style;
      loop.autonomy.attended_launch_approval = { style, approved_at: approvedAt };
    },
    (loop) => {
      const checked = leaseCheck(loop, {
        owner: fence.owner, generation: fence.generation,
      });
      if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    },
  );
  return { ok: true };
}

export function revokeAttendedLaunch(root, runId, {
  confirm, fence, now = Date.now(),
} = {}) {
  assertFence(fence, 'revokeAttendedLaunch');
  if (confirm !== true) return { ok: false, reason: 'CONFIRM_REQUIRED' };
  const revokedAt = approvedAtFromNow(now);
  if (revokedAt == null) return { ok: false, reason: 'INVALID_NOW' };

  try {
    appendAnchored(
      root,
      runId,
      { type: 'attended-launch-revoked', data: { revoked_at: revokedAt }, now },
      (loop) => {
        loop.autonomy.spawn_style = 'interactive';
        loop.autonomy.attended_launch_approval = null;
        delete loop.autonomy.spawn_style_optin_pending;
      },
      (loop) => {
        const lease = loop.session_chain?.lease;
        if (!lease
          || lease.owner_run_id !== fence.owner
          || lease.generation !== fence.generation) {
          throw new Error('LEASE_FENCED: attendedLaunchRevoke');
        }
        if (loop.status === 'completed' || loop.status === 'stopped') {
          throw new Error('RUN_TERMINAL: attendedLaunchRevoke');
        }
        if (lease.state !== 'active'
          || !['idle', 'acquired'].includes(lease.handoff_phase)) {
          throw new Error('HANDOFF_IN_FLIGHT: attendedLaunchRevoke');
        }
      },
    );
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('RUN_TERMINAL:')) return { ok: false, reason: 'RUN_TERMINAL' };
    if (message.startsWith('HANDOFF_IN_FLIGHT:')) return { ok: false, reason: 'HANDOFF_IN_FLIGHT' };
    throw error;
  }
  return { ok: true };
}
