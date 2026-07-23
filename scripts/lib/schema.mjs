import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { normalizePortableRelativePath } from './fs-safe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER_KINDS = Object.freeze(['wt', 'powershell', 'tmux']);

export function loadSchema() {
  return JSON.parse(readFileSync(join(here, '../../schemas/loop-run.schema.json'), 'utf8'));
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function portableAbsolute(path) {
  return typeof path === 'string' && path.length > 0 && (isAbsolute(path) || win32.isAbsolute(path));
}

function exactObject(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function canonicalIso(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function portableRel(value, prefix = null) {
  const normalized = normalizePortableRelativePath(value);
  return normalized !== null && normalized === value && (prefix === null || normalized.startsWith(prefix));
}

function validateAttendedLaunchApproval(value, errors) {
  const fail = detail => errors.push(`autonomy.attended_launch_approval ${detail}`);
  if (value === null) return;
  if (!exactObject(value, ['style', 'approved_at'])) { fail('must be null or an exact style/approved_at object'); return; }
  if (!['visible', 'desktop'].includes(value.style)) fail('style must be visible or desktop');
  if (!canonicalIso(value.approved_at)) fail('approved_at must be canonical ISO-8601');
}

const WORKSTREAM_SCOPE_KEYS = Object.freeze([
  'kind', 'workstream_id', 'bound_at_seq', 'terminal_event', 'closed_at', 'superseded_at',
]);
const LEGACY_SCOPE_KEYS = Object.freeze([
  'kind', 'workstream_id', 'bound_at_seq', 'terminal_event', 'closed_at',
]);

function validateSessionScope(scope, session, errors) {
  const fail = detail => errors.push(`session_chain.sessions[].scope ${detail}`);
  if (scope?.kind === 'workstream') {
    if (!exactObject(scope, WORKSTREAM_SCOPE_KEYS, ['supersede_reason', 'superseded_by'])) {
      fail('must have the exact Workstream scope shape');
      return;
    }
    if (scope.workstream_id !== null && (typeof scope.workstream_id !== 'string' || scope.workstream_id.length === 0)) {
      fail('workstream_id must be null or a non-empty string');
    }
    if (scope.bound_at_seq !== null && (!Number.isSafeInteger(scope.bound_at_seq) || scope.bound_at_seq < 1)) {
      fail('bound_at_seq must be null or a positive integer');
    }
    if (scope.terminal_event !== null) {
      if (!exactObject(scope.terminal_event, ['seq', 'checksum'])
        || !Number.isSafeInteger(scope.terminal_event.seq) || scope.terminal_event.seq < 1
        || !/^[0-9a-f]{64}$/.test(scope.terminal_event.checksum || '')) {
        fail('terminal_event must be null or exact positive seq/lowercase checksum');
      }
    }
    for (const field of ['closed_at', 'superseded_at']) {
      if (scope[field] !== null && !canonicalIso(scope[field])) fail(`${field} must be null or canonical ISO-8601`);
    }
    const recoveryKeys = ['supersede_reason', 'superseded_by'].filter(key => Object.hasOwn(scope, key));
    if (recoveryKeys.length !== 0 && recoveryKeys.length !== 2) fail('supersede_reason and superseded_by must appear together');
    if (recoveryKeys.length === 2
      && ((typeof scope.supersede_reason !== 'string' || scope.supersede_reason.length === 0)
        || (typeof scope.superseded_by !== 'string' || scope.superseded_by.length === 0))) {
      fail('supersede_reason and superseded_by must be non-empty strings');
    }
    return;
  }
  if (scope?.kind === 'legacy') {
    if (!exactObject(scope, LEGACY_SCOPE_KEYS)) { fail('must have the exact legacy scope shape'); return; }
    if (scope.workstream_id !== null || scope.bound_at_seq !== null || scope.terminal_event !== null) {
      fail('legacy identity fields must be null');
    }
    const expectedClosedAt = session.ended_at ?? null;
    if (scope.closed_at !== expectedClosedAt) fail('legacy closed_at must mirror session.ended_at');
    if (scope.closed_at !== null && !canonicalIso(scope.closed_at)) fail('legacy closed_at must be null or canonical ISO-8601');
    return;
  }
  fail('kind must be workstream or legacy');
}

function validateSessions(sc, errors) {
  if (!Array.isArray(sc?.sessions)) {
    errors.push('session_chain.sessions must be array');
    return;
  }
  for (const session of sc.sessions) {
    if (session === null || typeof session !== 'object' || Array.isArray(session)) {
      errors.push('session_chain.sessions[] must be object');
      continue;
    }
    validateSessionScope(session.scope, session, errors);
    if (Object.hasOwn(session, 'handoff_path')) errors.push('session_chain.sessions[].handoff_path is forbidden in v0.4');
    if (session.handoff_rel !== undefined && !portableRel(session.handoff_rel, 'handoffs/')) {
      errors.push('session_chain.sessions[].handoff_rel must be a safe handoffs/ relative path');
    }
    const recoveryFields = ['recovered_from', 'recovery_kind', 'recovery_rel', 'recovery_sha256'];
    const present = recoveryFields.filter(key => Object.hasOwn(session, key));
    if (present.length !== 0 && present.length !== recoveryFields.length) {
      errors.push('session_chain.sessions[] recovery fields must appear together');
    } else if (present.length === recoveryFields.length) {
      if (typeof session.recovered_from !== 'string' || session.recovered_from.length === 0) errors.push('session_chain.sessions[].recovered_from must be non-empty string');
      if (!['affinity-supersession', 'boundary-recovery'].includes(session.recovery_kind)) errors.push('session_chain.sessions[].recovery_kind is invalid');
      if (!portableRel(session.recovery_rel, 'recoveries/')) errors.push('session_chain.sessions[].recovery_rel must be a safe recoveries/ relative path');
      if (!/^[0-9a-f]{64}$/.test(session.recovery_sha256 || '')) errors.push('session_chain.sessions[].recovery_sha256 must be lowercase 64-hex');
    }
  }
}

function validateEpisodeV040(ep, errors) {
  if (Object.hasOwn(ep, 'request_path')) errors.push('episodes[].request_path is forbidden in v0.4');
  const expectedRequestRel = typeof ep.id === 'string' ? `episodes/${ep.id}/request.md` : null;
  if (!portableRel(ep.request_rel, 'episodes/') || ep.request_rel !== expectedRequestRel) {
    errors.push('episodes[].request_rel must exactly match episodes/<id>/request.md');
  }
  const invalidated = ep.invalidated_review_claims;
  if (invalidated === undefined) return;
  if (!Array.isArray(invalidated)) {
    errors.push('episodes[].invalidated_review_claims must be array');
    return;
  }
  for (const claim of invalidated) {
    if (claim === null || typeof claim !== 'object' || Array.isArray(claim)
      || claim.reason !== 'project-root-relocated' || !canonicalIso(claim.invalidated_at)
      || Object.keys(claim).filter(key => !['reason', 'invalidated_at'].includes(key)).length === 0) {
      errors.push('episodes[].invalidated_review_claims[] must contain a frozen claim, canonical invalidated_at, and project-root-relocated reason');
    }
  }
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
  const unknown = mapKeys.filter(key => !LAUNCHER_KINDS.includes(key));
  if (unknown.length > 0) fail(`contains unknown keys: ${unknown.join(',')}`);

  for (const kind of LAUNCHER_KINDS) {
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
    const windowsLauncher = kind !== 'tmux';
    if (!portableAbsolute(path) || /[\0\r\n]/.test(path || '')
      || (windowsLauncher && (/^[\\/]{2}/.test(path || '') || /^[\\/](?:\?\?|device)[\\/]/i.test(path || '')))
      || /\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(path || '')) {
      slotFail('canonical_path must be a safe absolute native path');
    } else {
      const name = windowsLauncher ? win32.basename(path).toLowerCase() : posix.basename(path);
      if ((kind === 'wt' && name !== 'wt.exe')
        || (kind === 'powershell' && name !== 'pwsh.exe' && name !== 'powershell.exe')
        || (kind === 'tmux' && name !== 'tmux')) {
        slotFail('canonical_path filename does not match kind');
      }
    }
    if (!/^[0-9a-f]{64}$/.test(approval.sha256 || '')) slotFail('sha256 must be lowercase 64-hex');
    if (typeof approval.version !== 'string' || approval.version.length === 0
      || approval.version.length > 256 || /[\0\r\n]/.test(approval.version)) {
      slotFail('version must be a non-empty safe string');
    }
    if (windowsLauncher && approval.platform !== 'win32') slotFail('platform must be win32');
    if (!windowsLauncher && !['linux', 'darwin'].includes(approval.platform)) {
      slotFail('platform must be linux or darwin');
    }
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
    if (!windowsLauncher && authenticode !== null) {
      slotFail('authenticode must be null for tmux');
      continue;
    }
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
  // schema_version 정확 일치 (legacy는 readHashVerifiedState가 in-memory 마이그레이션 — validate에 구버전이
  // 도달하면 마이그레이션 누락 경로이므로 실패가 옳다)
  if (loopJson.schema_version !== undefined && loopJson.schema_version !== '0.4.0') {
    errors.push(`schema_version must be 0.4.0, got ${loopJson.schema_version}`);
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
    if (!Object.hasOwn(autonomy, 'attended_launch_approval')) errors.push('missing required field: autonomy.attended_launch_approval');
    else validateAttendedLaunchApproval(autonomy.attended_launch_approval, errors);
    validateRuntimeExecutableApproval(autonomy.runtime_executable_approval, autonomy, errors);
    validateLauncherExecutableApprovals(autonomy.launcher_executable_approvals, errors);
  }
  // v1.10 continuation state belongs to session_chain and must remain validated even when autonomy is absent.
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
    const takeover = sc.lease?.takeover_kind;
    if (!sc.lease || !Object.hasOwn(sc.lease, 'takeover_kind')) {
      errors.push('missing required field: session_chain.lease.takeover_kind');
    } else if (takeover !== null && !['boundary-handoff', 'boundary-recovery', 'affinity-supersession'].includes(takeover)) {
      errors.push('session_chain.lease.takeover_kind is invalid');
    }
    validateSessions(sc, errors);
  }
  if (!Number.isSafeInteger(loopJson.project?.binding_generation) || loopJson.project.binding_generation < 1) {
    errors.push('project.binding_generation must be a positive integer');
  }
  // episode/workstream item status는 (skill ∪ kernel) 도메인 안에 있어야 함
  const epAllowed = [...(schema.episode_status?.skill || []), ...(schema.episode_status?.kernel || [])];
  for (const ep of (Array.isArray(loopJson.episodes) ? loopJson.episodes : [])) {
    if (ep?.status !== undefined && !epAllowed.includes(ep.status)) errors.push(`invalid episode status: ${ep.status}`);
    if (ep && typeof ep === 'object' && !Array.isArray(ep)) validateEpisodeV040(ep, errors);
  }
  const wsAllowed = [...(schema.workstream_status?.skill || []), ...(schema.workstream_status?.kernel || [])];
  for (const ws of (Array.isArray(loopJson.workstreams) ? loopJson.workstreams : [])) {
    if (ws?.status !== undefined && !wsAllowed.includes(ws.status)) errors.push(`invalid workstream status: ${ws.status}`);
    const terminalEvents = ws?.terminal_events;
    if (terminalEvents !== undefined
      && (!Array.isArray(terminalEvents) || terminalEvents.some(event => typeof event !== 'string'))) {
      errors.push('workstreams[].terminal_events must be an array of strings');
    }
  }
  return { ok: errors.length === 0, errors };
}
