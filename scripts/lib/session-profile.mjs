import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { readState, withLock } from './state.mjs';
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
// The no-op decision + fence are done IN-LOCK (fresh read) so a stale caller gets LEASE_FENCED (exit 3) even
// when its values happen to match — never a silent exit-0 no-op. withLock is non-reentrant (CLAUDE.md inv #7),
// so we only DECIDE inside the lock and, if a write is needed, appendAnchored AFTER releasing it; appendAnchored's
// own in-lock preCheck re-fences the write, so a concurrent lease change between the two locks can never cause
// an unfenced write — the worst case is one harmless redundant event.
export function setSessionProfile(root, runId, { model, effort, expect, now = Date.now() } = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isInteger(expect.generation)) throw new Error('FENCE_REQUIRED: setSessionProfile');
  if (model == null && effort == null) throw new Error('NOTHING_TO_SET: setSessionProfile');
  if (model != null) validateModel(model);
  if (effort != null) validateEffort(effort);

  let needsWrite = false;
  withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lc = leaseCheck(data, { owner: expect.owner, generation: expect.generation, intent: 'lease' });
    if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);   // in-lock authoritative fence (even for no-op)
    validateRuntimeProfile(sessionRuntime(data), {
      model: model ?? data.autonomy?.session_model ?? null,
      effort: effort ?? data.autonomy?.session_effort ?? null,
    });
    const sameModel = model == null || data.autonomy?.session_model === model;
    const sameEffort = effort == null || data.autonomy?.session_effort === effort;
    needsWrite = !(sameModel && sameEffort);
  });
  if (!needsWrite) return { ok: true, changed: false };

  // Event data records ONLY the fields actually being set (a partial update must not log an omitted
  // field as null — replay/audit consumers would misread that as a clear).
  appendAnchored(root, runId, { type: 'session-profile-set', data: { ...(model != null ? { model } : {}), ...(effort != null ? { effort } : {}) } },
    (l) => {
      if (model != null) l.autonomy.session_model = model;
      if (effort != null) l.autonomy.session_effort = effort;
    },
    (l) => {
      const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation, intent: 'lease' });
      if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);
      validateRuntimeProfile(sessionRuntime(l), {
        model: model ?? l.autonomy?.session_model ?? null,
        effort: effort ?? l.autonomy?.session_effort ?? null,
      });
    });
  return { ok: true, changed: true };
}
