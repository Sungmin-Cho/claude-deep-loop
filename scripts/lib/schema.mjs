import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, win32 } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export function loadSchema() {
  return JSON.parse(readFileSync(join(here, '../../schemas/loop-run.schema.json'), 'utf8'));
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function portableAbsolute(path) {
  return typeof path === 'string' && path.length > 0 && (isAbsolute(path) || win32.isAbsolute(path));
}

const APPROVAL_PACKAGE_KEYS = Object.freeze([
  'wrapper_path', 'wrapper_name', 'wrapper_version', 'optional_name', 'optional_spec',
  'native_name', 'native_version', 'target_triple', 'os', 'cpu',
]);

function validateRuntimeExecutableApproval(approval, autonomy, errors) {
  const fail = detail => errors.push(`autonomy.runtime_executable_approval ${detail}`);
  if (approval === undefined || approval === null) return;
  if (typeof approval !== 'object' || Array.isArray(approval)) { fail('must be object or null'); return; }

  const runtime = approval.runtime;
  const storedRuntime = autonomy.session_runtime ?? 'claude';
  if (!['claude', 'codex'].includes(runtime)) fail('runtime must be claude or codex');
  else if (runtime !== storedRuntime) fail('runtime must match immutable autonomy.session_runtime');
  if (!portableAbsolute(approval.canonical_path)) fail('canonical_path must be absolute');
  if (!/^[0-9a-f]{64}$/.test(approval.sha256 || '')) fail('sha256 must be lowercase 64-hex');
  for (const field of ['version', 'platform', 'arch', 'source']) {
    if (typeof approval[field] !== 'string' || approval[field].length === 0 || /[\0\r\n]/.test(approval[field])) {
      fail(`${field} must be a non-empty safe string`);
    }
  }
  if (!['official-npm-native', 'human-explicit'].includes(approval.source)) fail('source is invalid');
  if (approval.approved_by !== 'human') fail('approved_by must be human');
  if (typeof approval.approved_at !== 'string') fail('approved_at must be canonical ISO-8601');
  else {
    const timestamp = new Date(approval.approved_at);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== approval.approved_at) {
      fail('approved_at must be canonical ISO-8601');
    }
  }
  if (approval.authenticode !== null && (typeof approval.authenticode !== 'object' || Array.isArray(approval.authenticode))) {
    fail('authenticode must be object or null');
  }

  if (approval.source === 'human-explicit') {
    if (approval.package !== null) fail('human-explicit package must be null');
    return;
  }
  const pkg = approval.package;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) { fail('package must be an object'); return; }
  const keys = Object.keys(pkg).sort();
  if (keys.length !== APPROVAL_PACKAGE_KEYS.length
    || !APPROVAL_PACKAGE_KEYS.every(key => keys.includes(key))) {
    fail('package fields are incomplete or unknown');
    return;
  }
  for (const field of APPROVAL_PACKAGE_KEYS.filter(field => !['os', 'cpu'].includes(field))) {
    if (typeof pkg[field] !== 'string' || pkg[field].length === 0 || /[\0\r\n]/.test(pkg[field])) {
      fail(`package.${field} must be a non-empty safe string`);
    }
  }
  if (!portableAbsolute(pkg.wrapper_path)) fail('package.wrapper_path must be absolute');
  if (!Array.isArray(pkg.os) || pkg.os.length !== 1 || pkg.os[0] !== approval.platform) {
    fail('package.os must exactly match platform');
  }
  if (!Array.isArray(pkg.cpu) || pkg.cpu.length !== 1 || pkg.cpu[0] !== approval.arch) {
    fail('package.cpu must exactly match arch');
  }
}

export function validate(loopJson, schema = loadSchema()) {
  const errors = [];
  for (const f of schema.required) {
    if (get(loopJson, f) === undefined) errors.push(`missing required field: ${f}`);
  }
  for (const [path, allowed] of Object.entries(schema.enums)) {
    const v = get(loopJson, path);
    if (v !== undefined && !allowed.includes(v)) errors.push(`invalid enum at ${path}: ${v}`);
  }
  // schema_version 정확 일치
  if (loopJson.schema_version !== undefined && loopJson.schema_version !== '0.2.0') {
    errors.push(`schema_version must be 0.2.0, got ${loopJson.schema_version}`);
  }
  // 배열 타입
  for (const arr of ['workstreams', 'episodes', 'active_workstreams', 'discovered_items']) {
    const v = get(loopJson, arr);
    if (v !== undefined && !Array.isArray(v)) errors.push(`${arr} must be array`);
  }
  // budget 숫자 필드 (Task 9가 소비하는 모든 수치)
  if (loopJson.budget) for (const k of ['total', 'spent', 'tokens_total', 'tokens_spent', 'per_session_turn_cap', 'max_wallclock_sec', 'soft_stop_ratio', 'hard_stop_ratio']) {
    const v = loopJson.budget[k];
    if (v !== undefined && typeof v !== 'number') errors.push(`budget.${k} must be number`);
  }
  // schema.properties is not read by this validator, so custom optional-field contracts live here.
  // session_effort/session_runtime/runtime_source enum membership is enforced by the loop above.
  const autonomy = loopJson.autonomy;
  const autonomyIsObject = autonomy !== null && typeof autonomy === 'object' && !Array.isArray(autonomy);
  if (autonomy !== undefined && !autonomyIsObject) errors.push('autonomy must be object');
  if (autonomyIsObject) {
    const sm = autonomy.session_model;
    if (sm !== undefined && typeof sm !== 'string') errors.push('autonomy.session_model must be string');
    const runtime = autonomy.session_runtime;
    const source = autonomy.runtime_source;
    if (runtime === undefined && source !== undefined) {
      errors.push('autonomy.runtime_source requires autonomy.session_runtime');
    }
    if (runtime !== undefined && source !== 'skill-asserted') {
      errors.push('autonomy.session_runtime requires autonomy.runtime_source skill-asserted');
    }
    validateRuntimeExecutableApproval(autonomy.runtime_executable_approval, autonomy, errors);
  }
  // episode/workstream item status는 (skill ∪ kernel) 도메인 안에 있어야 함
  const epAllowed = [...(schema.episode_status?.skill || []), ...(schema.episode_status?.kernel || [])];
  for (const ep of (Array.isArray(loopJson.episodes) ? loopJson.episodes : [])) {
    if (ep?.status !== undefined && !epAllowed.includes(ep.status)) errors.push(`invalid episode status: ${ep.status}`);
  }
  const wsAllowed = [...(schema.workstream_status?.skill || []), ...(schema.workstream_status?.kernel || [])];
  for (const ws of (Array.isArray(loopJson.workstreams) ? loopJson.workstreams : [])) {
    if (ws?.status !== undefined && !wsAllowed.includes(ws.status)) errors.push(`invalid workstream status: ${ws.status}`);
  }
  return { ok: errors.length === 0, errors };
}
