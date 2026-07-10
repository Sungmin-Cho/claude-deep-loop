export const SESSION_RUNTIMES = Object.freeze(['claude', 'codex']);

export function validateSessionRuntime(value) {
  if (!SESSION_RUNTIMES.includes(value)) {
    throw new Error(`INVALID_RUNTIME: expected claude or codex, got ${String(value)}`);
  }
  return value;
}

export function sessionRuntime(loop) {
  const stored = loop?.autonomy?.session_runtime;
  const source = loop?.autonomy?.runtime_source;
  if (stored === undefined && source === undefined) return 'claude';
  if (stored === undefined) {
    throw new Error('INVALID_RUNTIME_STATE: runtime_source requires session_runtime');
  }
  if (source !== 'skill-asserted') {
    throw new Error('INVALID_RUNTIME_STATE: session_runtime requires runtime_source skill-asserted');
  }
  return validateSessionRuntime(stored);
}

export function runtimeFence(loop, assertedRuntime) {
  const actual = validateSessionRuntime(assertedRuntime);
  const expected = sessionRuntime(loop);
  return expected === actual
    ? { ok: true, runtime: expected }
    : { ok: false, reason: 'RUNTIME_FENCED', expected, actual };
}
