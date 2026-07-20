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
const LAUNCHER_APPROVAL_KEYS = Object.freeze([
  'kind', 'canonical_path', 'sha256', 'version', 'platform', 'arch', 'source',
  'authenticode', 'approved_by', 'approved_at',
]);
const AUTHENTICODE_KEYS = Object.freeze(['status', 'signer', 'thumbprint']);

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

function validateLauncherExecutableApprovals(approvals, errors) {
  const prefix = 'autonomy.launcher_executable_approvals';
  const fail = detail => errors.push(`${prefix} ${detail}`);
  if (approvals === undefined) return;
  if (approvals === null || typeof approvals !== 'object' || Array.isArray(approvals)) {
    fail('must be an object when present');
    return;
  }
  const mapKeys = Object.keys(approvals);
  const unknown = mapKeys.filter(key => !['wt', 'powershell'].includes(key));
  if (unknown.length > 0) fail(`contains unknown keys: ${unknown.join(',')}`);

  for (const kind of ['wt', 'powershell']) {
    if (!Object.hasOwn(approvals, kind) || approvals[kind] === null) continue;
    const approval = approvals[kind];
    const slotFail = detail => fail(`${kind} ${detail}`);
    if (typeof approval !== 'object' || Array.isArray(approval)) {
      slotFail('must be an object or null');
      continue;
    }
    const keys = Object.keys(approval).sort();
    if (keys.length !== LAUNCHER_APPROVAL_KEYS.length
      || !LAUNCHER_APPROVAL_KEYS.every(key => keys.includes(key))) {
      slotFail('fields are incomplete or unknown');
    }
    if (approval.kind !== kind) slotFail('kind must match its map key');
    const path = approval.canonical_path;
    if (!portableAbsolute(path) || /[\0\r\n]/.test(path || '')
      || /^[\\/]{2}/.test(path || '') || /^[\\/](?:\?\?|device)[\\/]/i.test(path || '')
      || /\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(path || '')) {
      slotFail('canonical_path must be a safe absolute native path');
    } else {
      const name = win32.basename(path).toLowerCase();
      if ((kind === 'wt' && name !== 'wt.exe')
        || (kind === 'powershell' && name !== 'pwsh.exe' && name !== 'powershell.exe')) {
        slotFail('canonical_path filename does not match kind');
      }
    }
    if (!/^[0-9a-f]{64}$/.test(approval.sha256 || '')) slotFail('sha256 must be lowercase 64-hex');
    if (typeof approval.version !== 'string' || approval.version.length === 0
      || approval.version.length > 256 || /[\0\r\n]/.test(approval.version)) {
      slotFail('version must be a non-empty safe string');
    }
    if (approval.platform !== 'win32') slotFail('platform must be win32');
    if (typeof approval.arch !== 'string' || !/^[A-Za-z0-9_-]+$/.test(approval.arch)) {
      slotFail('arch must be a non-empty safe string');
    }
    if (approval.source !== 'human-explicit') slotFail('source must be human-explicit');
    if (approval.approved_by !== 'human') slotFail('approved_by must be human');
    if (typeof approval.approved_at !== 'string') slotFail('approved_at must be canonical ISO-8601');
    else {
      const timestamp = new Date(approval.approved_at);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== approval.approved_at) {
        slotFail('approved_at must be canonical ISO-8601');
      }
    }

    const authenticode = approval.authenticode;
    if (authenticode !== null) {
      if (typeof authenticode !== 'object' || Array.isArray(authenticode)) {
        slotFail('authenticode must be an exact object or null');
      } else {
        const authKeys = Object.keys(authenticode).sort();
        if (authKeys.length !== AUTHENTICODE_KEYS.length
          || !AUTHENTICODE_KEYS.every(key => authKeys.includes(key))) {
          slotFail('authenticode fields are incomplete or unknown');
        }
        if (authenticode.status !== 'valid') slotFail('authenticode.status must be valid');
        if (typeof authenticode.signer !== 'string' || authenticode.signer.length === 0
          || authenticode.signer.length > 512 || /[\0\r\n]/.test(authenticode.signer)) {
          slotFail('authenticode.signer must be a non-empty safe string');
        }
        if (typeof authenticode.thumbprint !== 'string'
          || !/^[0-9a-f]+$/.test(authenticode.thumbprint) || authenticode.thumbprint.length > 256) {
          slotFail('authenticode.thumbprint must be lowercase hex');
        }
      }
    }
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
  // schema_version 정확 일치 (0.2.0 레거시는 readHashVerifiedState가 in-memory 마이그레이션 — validate에 0.2.0이
  // 도달하면 마이그레이션 누락 경로이므로 실패가 옳다)
  if (loopJson.schema_version !== undefined && loopJson.schema_version !== '0.3.0') {
    errors.push(`schema_version must be 0.3.0, got ${loopJson.schema_version}`);
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
    // v1.10: continuation_policy 교차 필드 — enum 멤버십은 위 enums 루프가 이미 검사(선행). 여기는 조합만.
    if (autonomy.continuation_policy === 'compact-in-place' && autonomy.session_runtime === 'codex') {
      errors.push('autonomy.continuation_policy compact-in-place requires session_runtime claude');
    }
    // v1.10 신규 필드 타입 — properties는 미소비이므로 커스텀 검증 (음성 테스트 필수)
    const sc = loopJson.session_chain;
    if (sc && typeof sc === 'object') {
      const cm = sc.consumed_milestones;
      if (cm !== undefined && (!Array.isArray(cm) || cm.some(x => typeof x !== 'string'))) {
        errors.push('session_chain.consumed_milestones must be an array of strings');
      }
      const ht = sc.lease?.handoff_trigger;
      if (ht !== undefined && ht !== null && typeof ht !== 'string') {
        errors.push('session_chain.lease.handoff_trigger must be string or null');
      }
    }
    validateRuntimeExecutableApproval(autonomy.runtime_executable_approval, autonomy, errors);
    validateLauncherExecutableApprovals(autonomy.launcher_executable_approvals, errors);
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
