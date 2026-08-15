export const SESSION_RUNTIMES = Object.freeze(['claude', 'codex']);

// 각 필드 주석은 소비자 목록이다(유일 소비자 선언이 아니다).
// 값은 전부 현행 동작에서 읽어온 것이며, 이 커밋은 어떤 값도 새로 정하지 않는다.
export const RUNTIME_CAPABILITIES = Object.freeze({
  claude: Object.freeze({
    skill_token_style: 'slash',                      // runtime-descriptor:123 · checkpoint:846 · sessionstart-restore:199,202,213
    provider_label: 'claude-code',                   // checkpoint:1007 · deep-loop:919 · precompact-handoff:40
    usage_output_kind: 'claude-json',                // runtime-descriptor:129 · headless-host 계상 술어
    entrypoint_heuristic: 'claude-code',             // respawn:197 · checkpoint:1172
    desktop_transport: true,                         // handoff:30,232,532 · respawn:499,584
    unattended_checker: false,                       // headless-host:412
    requires_process_preflight: false,               // headless-host:1187,1319
    requires_process_receipt_settlement: false,      // headless-host:1062
    requires_posix_visible_executable_trust: false,  // respawn:490 (플랫폼·모드 조건은 호출부에 남는다)
    max_effort_supported: true,                      // session-profile:27
    executable_name: 'claude',                       // runtime-executable:577
    version_probe: 'claude',                         // runtime-executable:375
  }),
  codex: Object.freeze({
    skill_token_style: 'dollar',
    provider_label: 'codex',
    usage_output_kind: 'codex-jsonl',
    entrypoint_heuristic: null,
    desktop_transport: false,
    unattended_checker: true,
    requires_process_preflight: true,
    requires_process_receipt_settlement: true,
    requires_posix_visible_executable_trust: true,
    max_effort_supported: false,
    executable_name: 'codex',
    version_probe: 'codex',
  }),
});

export function runtimeCapability(runtime, field) {
  const selected = validateSessionRuntime(runtime);
  const row = RUNTIME_CAPABILITIES[selected];
  if (row === undefined) {
    throw new Error(`UNKNOWN_RUNTIME_CAPABILITY: ${selected} has no capability row`);
  }
  if (!Object.hasOwn(row, field)) {
    throw new Error(`UNKNOWN_RUNTIME_CAPABILITY: ${selected}.${field}`);
  }
  return row[field];
}

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
