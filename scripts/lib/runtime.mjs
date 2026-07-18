export const SESSION_RUNTIMES = Object.freeze(['claude', 'codex']);

export function validateSessionRuntime(value) {
  if (!SESSION_RUNTIMES.includes(value)) {
    throw new Error(`INVALID_RUNTIME: expected claude or codex, got ${String(value)}`);
  }
  return value;
}

export function sessionRuntime(loop) {
  const autonomy = loop?.autonomy;
  if (autonomy === null || typeof autonomy !== 'object' || Array.isArray(autonomy)) {
    throw new Error('INVALID_RUNTIME_STATE: autonomy must be object');
  }
  const stored = autonomy.session_runtime;
  const source = autonomy.runtime_source;
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

export const RUNTIME_SURFACES = Object.freeze({
  claude: Object.freeze(['claude-code', 'claude-desktop']),
  codex: Object.freeze(['codex-cli', 'codex-app']),
});

export function validateRuntimeSurface(runtime, surface) {
  const value = validateSessionRuntime(runtime);
  if (surface !== null && !RUNTIME_SURFACES[value].includes(surface)) {
    throw new Error(`HOST_SURFACE_INVALID: ${runtime}/${String(surface)}`);
  }
  return surface;
}
