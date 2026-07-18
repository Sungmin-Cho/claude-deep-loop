import { withVerifiedMutationLock } from './integrity.mjs';
import { contentHash } from './envelope.mjs';
import { leaseCheck } from './lease.mjs';
import { sessionRuntime, validateSessionRuntime } from './runtime.mjs';

// Session model/effort continuity (WS1). Validation is the write-boundary defense (init-run + this setter);
// buildLaunchCommand later threads already-validated strings into child --model/--effort argv.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Anchored first char rejects a leading '-' so a "model" can never be parsed as a CLI option
// (e.g. `--model -p`). Fixed-length anchored pattern → no ReDoS. Brackets allow ids like `claude-opus-4-8[1m]`.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,127}$/;

export function validateEffort(effort) {
  if (!EFFORT_LEVELS.includes(effort)) throw Object.assign(new Error(`INVALID_EFFORT: ${effort}`), { code: 'INVALID_EFFORT' });
  return effort;
}
export function validateModel(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw Object.assign(new Error(`INVALID_MODEL: ${model}`), { code: 'INVALID_MODEL' });
  return model;
}

export function validateRuntimeProfile(runtime, { model = null, effort = null } = {}) {
  const selectedRuntime = validateSessionRuntime(runtime);
  if (model != null) validateModel(model);
  if (effort != null) validateEffort(effort);
  if (selectedRuntime === 'codex' && effort === 'max') {
    throw Object.assign(new Error('UNSUPPORTED_RUNTIME_EFFORT: codex max'), { code: 'UNSUPPORTED_RUNTIME_EFFORT' });
  }
  return { model, effort };
}

// Refresh the durable session profile. Fenced with intent:'lease' so it works while a handoff is in-flight
// (lease.state==='releasing') — the exact PreCompact-emitted state self-heal must survive — while still
// rejecting released/paused (leaseCheck). Single appendAnchored (event + state) on the write path. Idempotent
// no-op when the provided fields already match (avoids per-tick event spam). Partial update: only provided
// fields are validated/compared/written.
//
// The no-op decision uses a lock-owned verified snapshot. Owner/generation identity is fenced before proof;
// full lease/runtime policy and idempotency follow proof. If a write is needed, appendAnchored re-checks the
// same identity before proof and its full preCheck after proof, so a lease change between locks cannot write.
// The worst case is one harmless redundant event when another caller wrote the same profile first.
// No success-class result is derived from a merely hash-valid snapshot.
export function setSessionProfile(root, runId, { model, effort, expect, now = Date.now() } = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isInteger(expect.generation)) throw new Error('FENCE_REQUIRED: setSessionProfile');
  if (model == null && effort == null) throw new Error('NOTHING_TO_SET: setSessionProfile');
  if (model != null) validateModel(model);
  if (effort != null) validateEffort(effort);

  const identityOnly = loop => {
    const lease = loop.session_chain?.lease;
    if (lease?.owner_run_id !== expect.owner) {
      throw new Error('LEASE_FENCED: owner-mismatch');
    }
    if (lease?.generation !== expect.generation) {
      throw new Error('LEASE_FENCED: generation-mismatch');
    }
  };
  const callerBinding = { owner: expect.owner, generation: expect.generation };
  const intentDigest = contentHash(JSON.stringify({ operation: 'session-profile-set',
    ...callerBinding, model: model ?? null, effort: effort ?? null }));
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: setSessionProfile' }, mutation => {
  const { data } = mutation.readVerifiedState({ fenceCheck: identityOnly });
  const authorized = leaseCheck(data,
    { owner: expect.owner, generation: expect.generation, intent: 'lease' });
  if (!authorized.ok) throw new Error('LEASE_FENCED: ' + authorized.reason);
  validateRuntimeProfile(sessionRuntime(data), {
    model: model ?? data.autonomy?.session_model ?? null,
    effort: effort ?? data.autonomy?.session_effort ?? null,
  });
  const sameModel = model == null || data.autonomy?.session_model === model;
  const sameEffort = effort == null || data.autonomy?.session_effort === effort;
  if (sameModel && sameEffort) return { ok: true, changed: false };

  // Event data records ONLY the fields actually being set (a partial update must not log an omitted
  // field as null — replay/audit consumers would misread that as a clear).
  mutation.appendAnchored(
    { type: 'session-profile-set', data: {
      ...(model != null ? { model } : {}), ...(effort != null ? { effort } : {}),
    } },
    loop => {
      if (model != null) loop.autonomy.session_model = model;
      if (effort != null) loop.autonomy.session_effort = effort;
    },
    loop => {
      const checked = leaseCheck(loop,
        { owner: expect.owner, generation: expect.generation, intent: 'lease' });
      if (!checked.ok) throw new Error('LEASE_FENCED: ' + checked.reason);
      validateRuntimeProfile(sessionRuntime(loop), {
        model: model ?? loop.autonomy?.session_model ?? null,
        effort: effort ?? loop.autonomy?.session_effort ?? null,
      });
    },
    { fenceCheck: identityOnly });
  return { ok: true, changed: true };
  });
}
