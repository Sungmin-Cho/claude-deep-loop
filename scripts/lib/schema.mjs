import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { types } from 'node:util';
import {
  appHostTaskCwdDigest,
  hostSurfaceFactsDigest,
  isManualEnumHostProfile,
} from './host-surface.mjs';

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

export const APP_PREPARE_TIMEOUT_MS = 300_000;
export const APP_CONFIRMATION_TIMEOUT_MS = 120_000;
const APP_PHASES = new Set(['emitted', 'prepared', 'confirmed', 'acquired', 'failed', 'abandoned']);
const SHA_OR_NONE = /^(?:NONE|[0-9a-f]{64})$/;
const SHA = /^[0-9a-f]{64}$/;
const APP_ATTEMPT_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OBSERVATION_KEYS = [
  'kind', 'source', 'capabilities', 'structured_stdin_mode', 'host_task_cwd',
  'host_task_cwd_source', 'kernel_cwd_at_observation', 'observed_generation', 'observed_at',
];
const CONTINUATION_KEYS = [
  'transport', 'attempt_id', 'route', 'context_mode', 'phase', 'expected_runtime',
  'expected_host_surface', 'target_cwd', 'host_task_cwd_digest', 'workstream_id',
  'project_id', 'descriptor_digest', 'emitted_at', 'prepare_deadline', 'prepared_at',
  'confirmation_deadline', 'confirmed_at', 'acquired_at', 'acquired_generation',
  'thread_id', 'unconfirmed_thread_id', 'failure_code', 'failure_binding',
];
const CAPABILITIES = new Set([
  'list-projects', 'create-thread-local', 'fork-thread-same-directory',
  'send-message-to-thread', 'structured-process-stdin',
]);
const APP_FAILURE_CODES = new Set([
  'host-call-timeout', 'host-call-no-return', 'host-call-failed',
  'invalid-host-receipt', 'message-unconfirmed', 'app-prepare-unattended',
  'app-launch-unconfirmed', 'consent-revoked', 'gate-budget', 'gate-breaker',
  'gate-max-sessions', 'gate-wallclock', 'gate-auto-handoff',
  'human-recovered', 'run-finished',
]);
const APP_FAILED_CODES = new Set([
  'host-call-timeout', 'host-call-no-return', 'host-call-failed',
  'invalid-host-receipt', 'message-unconfirmed',
  'app-prepare-unattended', 'app-launch-unconfirmed',
]);
const APP_ABANDONED_CODES = new Set([
  'consent-revoked', 'gate-budget', 'gate-breaker', 'gate-max-sessions',
  'gate-wallclock', 'gate-auto-handoff', 'human-recovered', 'run-finished',
]);
const SURFACE_RUNTIME = {
  'claude-code': 'claude', 'claude-desktop': 'claude',
  'codex-cli': 'codex', 'codex-app': 'codex',
};
const SURFACE_SOURCE = {
  'claude-code': new Set(['claude-cli-entrypoint']),
  'claude-desktop': new Set(['claude-desktop-local-agent']),
  'codex-cli': new Set(['codex-cli-host']),
  'codex-app': new Set(['codex-app-host-context', 'codex-app-tool-provenance']),
};
const CWD_SOURCE = {
  'claude-code': 'direct-cli-cwd', 'claude-desktop': 'desktop-code-context',
  'codex-cli': 'direct-cli-cwd', 'codex-app': 'app-task-context',
};

const objectWithExactKeys = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
};

const densePlainDataArray = (value, maxLength) => {
  if (types.isProxy(value) || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > maxLength || Object.getOwnPropertySymbols(value).length !== 0) return null;
  const expected = [...Array(value.length).keys()].map(String);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== expected.length + 1 || names.at(-1) !== 'length'
      || !expected.every((key, index) => names[index] === key)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || length.enumerable || !Object.hasOwn(length, 'value')
      || length.value !== value.length) return null;
  const values = [];
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      return null;
    }
    values.push(descriptor.value);
  }
  return values;
};

const strictMs = value => {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try { return new Date(milliseconds).toISOString() === value ? milliseconds : null; }
  catch { return null; }
};

const opaque = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= 512
  && Buffer.from(value, 'utf8').toString('utf8') === value
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const boundedPath = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= 4096
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const boundedFailure = value => APP_FAILURE_CODES.has(value);

function validateObservation(observation, runtime, errors, label) {
  if (observation === null) return false;
  const fail = detail => errors.push(label + ' ' + detail);
  if (!objectWithExactKeys(observation, OBSERVATION_KEYS)) {
    fail('fields invalid'); return false;
  }
  if (SURFACE_RUNTIME[observation.kind] !== runtime) fail('runtime correlation invalid');
  if (!SURFACE_SOURCE[observation.kind]?.has(observation.source)) fail('source correlation invalid');
  const capabilities = densePlainDataArray(observation.capabilities, CAPABILITIES.size);
  if (capabilities === null
      || new Set(capabilities).size !== capabilities.length
      || capabilities.some(value => !CAPABILITIES.has(value))
      || JSON.stringify(capabilities) !== JSON.stringify([...capabilities].sort())) {
    fail('capabilities invalid');
  }
  const hasStructured = Array.isArray(capabilities)
    && capabilities.includes('structured-process-stdin');
  if (hasStructured
    ? !['pipe-open-noecho', 'pty-raw-noecho'].includes(observation.structured_stdin_mode)
    : observation.structured_stdin_mode !== null) {
    fail('structured stdin correlation invalid');
  }
  const manualSurface = !hasStructured;
  if (manualSurface) {
    if (observation.host_task_cwd !== null || observation.host_task_cwd_source !== null) {
      fail('manual surface cwd must be null');
    }
  } else if (!boundedPath(observation.host_task_cwd)
      || observation.host_task_cwd_source !== CWD_SOURCE[observation.kind]
      || !boundedPath(observation.kernel_cwd_at_observation)
      || observation.host_task_cwd !== observation.kernel_cwd_at_observation) {
    fail('cwd correlation invalid');
  }
  if (manualSurface && !boundedPath(observation.kernel_cwd_at_observation)) fail('kernel cwd invalid');
  if (!Number.isSafeInteger(observation.observed_generation)
      || observation.observed_generation < 1) fail('observed_generation invalid');
  if (strictMs(observation.observed_at) === null) fail('observed_at invalid');
  return true;
}

function storedPathApi(root) {
  if (typeof root !== 'string') return null;
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(root)) return win32;
  return root.startsWith('/') ? posix : null;
}

function canonicalStoredAbsolute(pathApi, value) {
  if (!pathApi || !boundedPath(value) || !pathApi.isAbsolute(value)) return null;
  let normalized = pathApi.normalize(value);
  const volumeRoot = pathApi.parse(normalized).root;
  while (normalized.length > volumeRoot.length && normalized.endsWith(pathApi.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function conventionalWorktreeRelative(pathApi, value) {
  if (!pathApi || !boundedPath(value) || pathApi.isAbsolute(value)) return null;
  const normalized = pathApi.normalize(value);
  const parts = normalized.split(pathApi.sep);
  const conventional = (parts.length === 2 && parts[0] === '.worktrees')
    || (parts.length === 3 && parts[0] === '.claude' && parts[1] === 'worktrees');
  const leaf = parts.at(-1);
  return conventional && leaf !== '' && leaf !== '.' && leaf !== '..' ? normalized : null;
}

function appObservationRoute(root, observation) {
  const pathApi = storedPathApi(root);
  const canonicalRoot = canonicalStoredAbsolute(pathApi, root);
  const canonicalCwd = canonicalStoredAbsolute(pathApi, observation?.host_task_cwd);
  if (canonicalRoot === null || canonicalCwd === null) return null;
  if (canonicalCwd === canonicalRoot) return 'create';
  const relative = pathApi.relative(canonicalRoot, canonicalCwd);
  return conventionalWorktreeRelative(pathApi, relative) === relative ? 'fork' : null;
}

function hasCompleteAppRoute(root, observation) {
  const capabilities = new Set(observation?.capabilities ?? []);
  const route = appObservationRoute(root, observation);
  const required = route === 'create'
    ? ['list-projects', 'create-thread-local', 'structured-process-stdin']
    : route === 'fork'
      ? ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin']
      : [];
  return required.length > 0 && required.every(value => capabilities.has(value));
}

function validateLiveAppRoute(loop, parent, child, continuation, errors) {
  const observation = parent?.host_surface;
  const pathApi = storedPathApi(loop.project?.root);
  const canonicalRoot = canonicalStoredAbsolute(pathApi, loop.project?.root);
  const canonicalHostCwd = canonicalStoredAbsolute(pathApi, observation?.host_task_cwd);
  const canonicalKernelCwd = canonicalStoredAbsolute(
    pathApi, observation?.kernel_cwd_at_observation);
  const canonicalTarget = canonicalStoredAbsolute(pathApi, continuation.target_cwd);
  const capabilities = new Set(observation?.capabilities ?? []);
  const completeCreate = ['list-projects', 'create-thread-local', 'structured-process-stdin']
    .every(value => capabilities.has(value));
  const completeFork = ['fork-thread-same-directory', 'send-message-to-thread',
    'structured-process-stdin'].every(value => capabilities.has(value));
  let digest = null;
  try { digest = appHostTaskCwdDigest(observation, continuation.target_cwd); } catch {}
  if (digest !== continuation.host_task_cwd_digest) {
    errors.push('live App continuation host cwd digest invalid');
  }
  if (continuation.route === 'create') {
    if (!completeCreate || appObservationRoute(loop.project?.root, observation) !== 'create'
        || canonicalRoot === null || canonicalHostCwd !== canonicalRoot
        || canonicalKernelCwd !== canonicalRoot || canonicalTarget !== canonicalRoot
        || continuation.context_mode !== 'fresh' || continuation.workstream_id !== null) {
      errors.push('live App create parent route correlation invalid');
    }
    return;
  }
  const activeMatches = (loop.active_workstreams ?? [])
    .filter(id => id === continuation.workstream_id);
  const matches = (loop.workstreams ?? []).filter(workstream =>
    pathApi !== null && canonicalRoot !== null
    && workstream?.id === continuation.workstream_id
    && ['in_progress', 'in_review'].includes(workstream.status)
    && conventionalWorktreeRelative(pathApi, workstream.worktree) !== null
    && canonicalStoredAbsolute(pathApi,
      pathApi.join(canonicalRoot, conventionalWorktreeRelative(pathApi, workstream.worktree)))
      === canonicalTarget);
  if (continuation.route !== 'fork' || !completeFork
      || appObservationRoute(loop.project?.root, observation) !== 'fork'
      || canonicalTarget === null || canonicalHostCwd !== canonicalTarget
      || canonicalKernelCwd !== canonicalTarget
      || continuation.context_mode !== 'inherited-completed-history'
      || activeMatches.length !== 1 || matches.length !== 1
      || child?.run_id === parent?.run_id) {
    errors.push('live App fork parent route correlation invalid');
  }
}

const INIT_PROJECTION_KEYS = [
  'runtime', 'goal', 'routing', 'review', 'model', 'effort', 'project',
  'plugins_detected', 'session_spawn', 'consent', 'host_observation_digest', 'enum_profile',
];
const INIT_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const INIT_MAX_DEPTH = 8;
const INIT_MAX_NODES = 256;
const INIT_MAX_ENTRIES = 128;
const INIT_MAX_STRING_BYTES = 4096;
const INIT_MAX_CANONICAL_BYTES = 65_536;

function canonicalProjectionValue(value) {
  if (Array.isArray(value)) {
    if (types.isProxy(value)) throw new Error('projection Array proxy invalid');
    const limit = Math.min(value.length, INIT_MAX_ENTRIES + 1);
    return Array.from({ length: limit }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return canonicalProjectionValue(
        descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null,
      );
    });
  }
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalProjectionValue(value[key])]),
  );
  return value;
}

function validateBoundedProjectionTree(value, errors) {
  let nodes = 0;
  const visit = (item, depth, label) => {
    nodes += 1;
    if (nodes > INIT_MAX_NODES || depth > INIT_MAX_DEPTH) {
      errors.push('initialization.request_projection bounds invalid'); return;
    }
    if (typeof item === 'string') {
      if (Buffer.byteLength(item, 'utf8') > INIT_MAX_STRING_BYTES) {
        errors.push(label + ' string too large');
      }
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) errors.push(label + ' number invalid');
      return;
    }
    if (Array.isArray(item)) {
      const values = densePlainDataArray(item, INIT_MAX_ENTRIES);
      if (values === null) {
        errors.push(label + ' array invalid'); return;
      }
      for (let index = 0; index < values.length; index += 1) {
        visit(values[index], depth + 1, label + '[' + index + ']');
      }
      return;
    }
    if (typeof item !== 'object' || item === undefined
        || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      errors.push(label + ' value invalid'); return;
    }
    const keys = Object.keys(item);
    if (keys.length > INIT_MAX_ENTRIES
        || keys.some(key => INIT_FORBIDDEN_KEYS.has(key)
          || Buffer.byteLength(key, 'utf8') > INIT_MAX_STRING_BYTES)) {
      errors.push(label + ' keys invalid'); return;
    }
    keys.forEach(key => visit(item[key], depth + 1, label + '.' + key));
  };
  visit(value, 0, 'initialization.request_projection');
  try {
    if (Buffer.byteLength(JSON.stringify(canonicalProjectionValue(value)), 'utf8')
        > INIT_MAX_CANONICAL_BYTES) {
      errors.push('initialization.request_projection bytes invalid');
    }
  } catch {
    errors.push('initialization.request_projection bytes invalid');
  }
}

function validateInitializationProjection(projection, errors) {
  if (!objectWithExactKeys(projection, INIT_PROJECTION_KEYS)
      || !objectWithExactKeys(projection?.routing, ['protocol', 'recipe'])
      || !objectWithExactKeys(projection?.project, ['root', 'git'])
      || !objectWithExactKeys(projection?.project?.git, ['git', 'head', 'branch', 'dirty'])
      || projection.consent !== null
        && !objectWithExactKeys(projection.consent, ['mode', 'authority'])
      || projection.enum_profile !== null
        && !objectWithExactKeys(projection.enum_profile, ['kind', 'source', 'capabilities'])) {
    errors.push('initialization.request_projection exact shape invalid'); return;
  }
  const validConsent = projection.consent === null
    || projection.consent.mode === 'manual'
      && projection.consent.authority === 'default-manual'
    || projection.consent.mode === 'auto'
      && projection.consent.authority === 'human-confirmed';
  if (typeof projection.runtime !== 'string' || typeof projection.goal !== 'string'
      || typeof projection.routing.protocol !== 'string'
      || typeof projection.project.root !== 'string'
      || typeof projection.project.git.git !== 'boolean'
      || ![null, 'string'].includes(projection.project.git.head === null
        ? null : typeof projection.project.git.head)
      || ![null, 'string'].includes(projection.project.git.branch === null
        ? null : typeof projection.project.git.branch)
      || typeof projection.project.git.dirty !== 'boolean'
      || !SHA_OR_NONE.test(projection.host_observation_digest || '')
      || !validConsent
      || projection.enum_profile !== null
        && !isManualEnumHostProfile(projection.enum_profile, projection.runtime)) {
    errors.push('initialization.request_projection semantics invalid');
  }
  validateBoundedProjectionTree(projection, errors);
}

function validateAppState(loop, errors) {
  const initialization = loop.initialization;
  if (initialization !== undefined) {
    if (!objectWithExactKeys(initialization, [
      'attempt_id', 'request_digest', 'request_projection', 'previous_current_digest',
      'host_observation_digest', 'host_surface_digest',
    ])) errors.push('initialization fields invalid');
    if (initialization?.attempt_id !== loop.run_id) errors.push('initialization.attempt_id must equal run_id');
    if (!SHA.test(initialization?.request_digest || '')) errors.push('initialization.request_digest invalid');
    validateInitializationProjection(initialization?.request_projection, errors);
    if (!SHA_OR_NONE.test(initialization?.previous_current_digest || '')) errors.push('initialization.previous_current_digest invalid');
    if (!SHA_OR_NONE.test(initialization?.host_observation_digest || '')) errors.push('initialization.host_observation_digest invalid');
    if (!SHA_OR_NONE.test(initialization?.host_surface_digest || '')) {
      errors.push('initialization.host_surface_digest invalid');
    }
  }
  const sessions = Array.isArray(loop.session_chain?.sessions) ? loop.session_chain.sessions : [];
  if (initialization !== undefined) {
    if (sessions[0]?.run_id !== loop.run_id || sessions[0]?.started_at !== loop.created_at) {
      errors.push('initialized genesis session identity invalid');
    }
    if (new Set(sessions.map(session => session?.run_id)).size !== sessions.length) {
      errors.push('session run_id values must be unique');
    }
    if (!Object.hasOwn(loop.autonomy ?? {}, 'app_task_continuation')) {
      errors.push('initialized run requires own consent state');
    }
    if (!Object.hasOwn(sessions[0] ?? {}, 'host_surface')) {
      errors.push('initialized run requires own initial host_surface');
    }
  }
  for (const session of sessions) {
    if (session?.host_surface !== undefined) {
      validateObservation(session.host_surface, loop.autonomy?.session_runtime, errors,
        'session ' + String(session.run_id) + ' host_surface');
      if (session.host_surface !== null
          && session.host_surface.observed_generation
            > (loop.session_chain?.lease?.generation ?? 0)) {
        errors.push('session ' + String(session.run_id)
          + ' host_surface observed_generation is in the future');
      }
    }
    if (session?.recovery_binding !== undefined) {
      const binding = session.recovery_binding;
      if (!objectWithExactKeys(binding, ['owner_run_id', 'generation'])
          || (initialization !== undefined
            && !APP_ATTEMPT_ID.test(binding?.owner_run_id || ''))
          || typeof binding?.owner_run_id !== 'string'
          || !Number.isSafeInteger(binding?.generation) || binding.generation < 1
          || binding.generation > (loop.session_chain?.lease?.generation ?? 0)
          || !sessions.some(item => item.run_id === binding.owner_run_id)
          || binding.owner_run_id === session.run_id
          || !['abandoned_recover', 'took_over'].includes(session.outcome)) {
        errors.push('session ' + String(session.run_id) + ' recovery_binding invalid');
      }
    }
    if (initialization !== undefined && session?.outcome === 'abandoned_recover'
        && session.recovery_binding === undefined) {
      errors.push('session ' + String(session.run_id)
        + ' new-format abandoned_recover requires recovery_binding');
    }
  }
  const initialObservation = sessions[0]?.host_surface ?? null;
  if (initialization !== undefined) {
    const rawObservationDigest = initialization.host_observation_digest !== 'NONE';
    if (rawObservationDigest && initialObservation === null) {
      errors.push('initialization.host_observation_digest presence correlation invalid');
    }
    let actualSurfaceDigest = 'INVALID';
    try { actualSurfaceDigest = hostSurfaceFactsDigest(initialObservation); } catch {}
    if (initialization.host_surface_digest !== actualSurfaceDigest) {
      errors.push('initialization.host_surface_digest facts correlation invalid');
    }
    if (initialObservation !== null && (initialObservation.observed_generation !== 1
        || initialObservation.observed_at !== loop.created_at)) {
      errors.push('initialized genesis observation clock invalid');
    }
  }
  const consent = loop.autonomy?.app_task_continuation;
  if (consent !== undefined) {
    if (!objectWithExactKeys(consent, ['mode', 'authority', 'confirmed_at', 'revoked_at'])) {
      errors.push('autonomy.app_task_continuation fields invalid');
    }
    const manualDefault = consent?.mode === 'manual' && consent?.authority === 'default-manual'
      && consent.confirmed_at === null && consent.revoked_at === null;
    const confirmed = strictMs(consent?.confirmed_at);
    const revoked = strictMs(consent?.revoked_at);
    const manualRevoked = consent?.mode === 'manual' && consent?.authority === 'human-confirmed'
      && confirmed !== null && revoked !== null && revoked >= confirmed;
    const auto = consent?.mode === 'auto' && consent?.authority === 'human-confirmed'
      && confirmed !== null && consent.revoked_at === null;
    if (!manualDefault && !manualRevoked && !auto) {
      errors.push('autonomy.app_task_continuation correlation invalid');
    }
    const humanAuthorized = auto || manualRevoked;
    const consentProjectRoot = loop.project?.root
      || initialization?.request_projection?.project?.root;
    if (humanAuthorized && (loop.autonomy?.session_runtime !== 'codex'
        || initialObservation?.kind !== 'codex-app'
        || !SURFACE_SOURCE['codex-app'].has(initialObservation.source)
        || initialObservation.host_task_cwd_source !== 'app-task-context'
        || initialObservation.host_task_cwd !== initialObservation.kernel_cwd_at_observation
        || !['pipe-open-noecho', 'pty-raw-noecho'].includes(initialObservation.structured_stdin_mode)
        || strictMs(initialObservation.observed_at) === null
        || !hasCompleteAppRoute(consentProjectRoot, initialObservation))) {
      errors.push('human-authorized consent requires historical complete Codex App observation');
    }
  }
  const lease = loop.session_chain?.lease ?? {};
  const bound = [];
  const attempts = new Set();
  for (const session of sessions) {
    const continuation = session?.continuation;
    if (continuation === undefined) continue;
    const label = 'session ' + String(session.run_id);
    const incomingParents = sessions.filter(parent =>
      parent.superseded_by === session.run_id);
    if (!objectWithExactKeys(continuation, CONTINUATION_KEYS)
        || continuation.transport !== 'codex-app' || !APP_PHASES.has(continuation.phase)) {
      errors.push(label + ' continuation invalid'); continue;
    }
    if (attempts.has(continuation.attempt_id)) errors.push('duplicate App continuation attempt_id');
    attempts.add(continuation.attempt_id);
    if (!APP_ATTEMPT_ID.test(continuation.attempt_id) || !boundedPath(continuation.target_cwd)
        || !SHA.test(continuation.host_task_cwd_digest || '')
        || continuation.expected_runtime !== 'codex'
        || continuation.expected_host_surface !== 'codex-app') {
      errors.push(label + ' continuation authority invalid');
    }
    if (continuation.route === 'create') {
      if (continuation.context_mode !== 'fresh' || continuation.workstream_id !== null) {
        errors.push(label + ' create route correlation invalid');
      }
    } else if (continuation.route === 'fork') {
      if (continuation.context_mode !== 'inherited-completed-history'
          || !opaque(continuation.workstream_id) || continuation.project_id !== null) {
        errors.push(label + ' fork route correlation invalid');
      }
    } else {
      errors.push(label + ' route invalid');
    }
    const emitted = strictMs(continuation.emitted_at);
    const prepareDeadline = strictMs(continuation.prepare_deadline);
    if (emitted === null || prepareDeadline !== emitted + APP_PREPARE_TIMEOUT_MS) {
      errors.push(label + ' prepare deadline invalid');
    }
    const prepared = strictMs(continuation.prepared_at);
    const confirmationDeadline = strictMs(continuation.confirmation_deadline);
    const preparedPair = prepared !== null
      && confirmationDeadline === prepared + APP_CONFIRMATION_TIMEOUT_MS
      && prepared >= emitted && prepared <= prepareDeadline;
    const preparedAbsent = continuation.prepared_at === null
      && continuation.confirmation_deadline === null;
    const requiresPrepared = ['prepared', 'confirmed', 'acquired'].includes(continuation.phase);
    const terminalPhase = ['failed', 'abandoned'].includes(continuation.phase);
    if ((requiresPrepared && !preparedPair)
        || (!requiresPrepared && !terminalPhase && !preparedAbsent)
        || (terminalPhase && !preparedPair && !preparedAbsent)) {
      errors.push(label + ' confirmation deadline invalid');
    }
    if (preparedPair) {
      if (!SHA.test(continuation.descriptor_digest || '')) {
        errors.push(label + ' descriptor digest required after prepare');
      }
      if (continuation.route === 'create' && !opaque(continuation.project_id)) {
        errors.push(label + ' prepared create project_id invalid');
      }
    } else if (continuation.descriptor_digest !== null
        || (continuation.route === 'create' && continuation.project_id !== null)) {
      errors.push(label + ' pre-prepare receipt fields invalid');
    }
    const confirmed = strictMs(continuation.confirmed_at);
    const confirmedPair = confirmed !== null && opaque(continuation.thread_id)
      && preparedPair && confirmed >= prepared && confirmed <= confirmationDeadline;
    const confirmedAbsent = continuation.confirmed_at === null && continuation.thread_id === null;
    const requiresConfirmed = ['confirmed', 'acquired'].includes(continuation.phase);
    if ((requiresConfirmed && !confirmedPair)
        || (!requiresConfirmed && !terminalPhase && !confirmedAbsent)
        || (terminalPhase && !confirmedPair && !confirmedAbsent)) {
      errors.push(label + ' confirmation invalid');
    }
    const acquired = strictMs(continuation.acquired_at);
    if (continuation.phase === 'acquired') {
      if (!confirmedPair || acquired === null || acquired < confirmed
          || !Number.isSafeInteger(continuation.acquired_generation)
          || continuation.acquired_generation < 1
          || !Number.isSafeInteger(lease.generation)
          || continuation.acquired_generation > lease.generation
          || session.started_at !== continuation.acquired_at) {
        errors.push(label + ' acquisition invalid');
      }
      if (session.host_surface?.kind !== 'codex-app'
          || session.host_surface.host_task_cwd !== continuation.target_cwd
          || !Number.isSafeInteger(session.host_surface.observed_generation)
          || session.host_surface.observed_generation < continuation.acquired_generation) {
        errors.push(label + ' acquired host surface invalid');
      }
      if (continuation.acquired_generation === lease.generation
          && (lease.owner_run_id !== session.run_id
            || lease.acquired_at !== continuation.acquired_at
            || session.host_surface?.observed_generation !== lease.generation
            || session.outcome !== null || session.ended_at !== null)) {
        errors.push(label + ' current-generation acquisition provenance invalid');
      }
      if (incomingParents.length !== 1 || incomingParents[0]?.outcome !== 'took_over') {
        errors.push(label + ' acquired continuation requires one took-over historical parent');
      }
      const currentAcquiredPhase = continuation.acquired_generation === lease.generation
        && lease.state === 'active' && lease.handoff_phase === 'acquired';
      if (currentAcquiredPhase) {
        const parent = incomingParents[0];
        const transportCleared = ['handoff_transport', 'handoff_attempt_id',
          'handoff_child_run_id', 'handoff_idempotency_key', 'expires_at']
          .every(key => lease[key] == null);
        const running = loop.status === 'running' && loop.pause_reason == null
          && lease.resume_policy == null;
        const paused = loop.status === 'paused'
          && typeof loop.pause_reason === 'string' && loop.pause_reason.length > 0
          && lease.resume_policy === 'human';
        const terminal = ['completed', 'stopped'].includes(loop.status)
          && loop.pause_reason == null && lease.resume_policy == null;
        if (!transportCleared || (!running && !paused && !terminal)
            || lease.owner_run_id !== session.run_id
            || lease.acquired_at !== continuation.acquired_at
            || parent?.outcome !== 'took_over' || session.outcome !== null
            || session.started_at !== continuation.acquired_at || session.ended_at !== null
            || session.superseded_by !== null) {
          errors.push(label + ' current active/acquired projection invalid');
        }
      }
    } else if (continuation.acquired_at !== null || continuation.acquired_generation !== null) {
      errors.push(label + ' non-acquired receipt invalid');
    }
    if (continuation.phase !== 'acquired' && session.host_surface !== null) {
      errors.push(label + ' pre-acquire host surface must be null');
    }
    if (['failed', 'abandoned'].includes(continuation.phase)) {
      if (!boundedFailure(continuation.failure_code)) errors.push(label + ' failure_code invalid');
      const phaseCodes = continuation.phase === 'failed' ? APP_FAILED_CODES : APP_ABANDONED_CODES;
      if (!phaseCodes.has(continuation.failure_code)) {
        errors.push(label + ' failure_code phase provenance invalid');
      }
    } else if (continuation.failure_code !== null) {
      errors.push(label + ' unexpected failure_code');
    }
    const failureBinding = continuation.failure_binding;
    if (continuation.phase === 'failed') {
      if (!objectWithExactKeys(failureBinding, ['owner_run_id', 'generation'])
          || !APP_ATTEMPT_ID.test(failureBinding?.owner_run_id || '')
          || failureBinding.owner_run_id === session.run_id
          || !sessions.some(item => item.run_id === failureBinding.owner_run_id)
          || !Number.isSafeInteger(failureBinding.generation)
          || failureBinding.generation < 1 || failureBinding.generation > lease.generation) {
        errors.push(label + ' failure_binding invalid');
      }
    } else if (failureBinding !== null) {
      errors.push(label + ' non-failed failure_binding must be null');
    }
    if (continuation.phase === 'failed'
        && ['abandoned_recover', 'took_over'].includes(session.outcome)
        && (session.recovery_binding?.owner_run_id !== failureBinding?.owner_run_id
          || session.recovery_binding?.generation !== failureBinding?.generation)) {
      errors.push(label + ' recovered failure binding mismatch');
    }
    if (continuation.unconfirmed_thread_id !== null
        && (continuation.phase !== 'failed' || continuation.route !== 'fork'
          || continuation.failure_code !== 'message-unconfirmed'
          || !opaque(continuation.unconfirmed_thread_id)
          || !confirmedAbsent)) {
      errors.push(label + ' unconfirmed_thread_id invalid');
    }
    if (continuation.failure_code === 'message-unconfirmed'
        && (!preparedPair || continuation.route !== 'fork' || !confirmedAbsent
          || !opaque(continuation.unconfirmed_thread_id))) {
      errors.push(label + ' message-unconfirmed receipt required');
    }
    const isPrimaryLive = ['emitted', 'prepared', 'confirmed'].includes(continuation.phase);
    const isLeaseBound = lease.handoff_transport === 'codex-app'
      && lease.handoff_attempt_id === continuation.attempt_id
      && lease.handoff_child_run_id === session.run_id;
    const liveFailedBinding = continuation.phase === 'failed' && isLeaseBound;
    if (liveFailedBinding
        && (continuation.failure_binding?.owner_run_id !== lease.owner_run_id
          || continuation.failure_binding?.generation !== lease.generation)) {
      errors.push(label + ' live failure binding must equal current lease');
    }
    const currentFailureGeneration = continuation.phase === 'failed'
      && continuation.failure_binding?.generation === lease.generation;
    if (currentFailureGeneration
        && continuation.failure_binding?.owner_run_id !== lease.owner_run_id) {
      errors.push(label + ' current-generation failure owner mismatch');
    }
    const currentClearedFailure = currentFailureGeneration && !isLeaseBound;
    if (currentClearedFailure) {
      const cleared = ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
        'handoff_idempotency_key', 'resume_policy', 'expires_at']
        .every(key => lease[key] == null);
      const immediate = loop.status === 'paused'
        && loop.pause_reason === continuation.failure_code
        && lease.state === 'active' && lease.handoff_phase === 'idle' && cleared
        && sessions.find(item => item.run_id === lease.owner_run_id)?.outcome === null
        && session.started_at === null && session.ended_at === null
        && session.host_surface === null && session.superseded_by === null
        && session.outcome === 'failed_launch'
        && session.recovery_binding === undefined;
      const recoveredLifecycle = session.started_at === null && session.ended_at === null
        && session.host_surface === null && session.superseded_by === null
        && sessions.find(item => item.run_id === lease.owner_run_id)?.outcome === null
        && (session.outcome === 'failed_launch' && session.recovery_binding === undefined
          || session.outcome === 'abandoned_recover'
            && session.recovery_binding?.owner_run_id === failureBinding?.owner_run_id
            && session.recovery_binding?.generation === failureBinding?.generation);
      const recovered = loop.status === 'paused'
        && loop.pause_reason === 'recovered:awaiting-resume'
        && lease.state === 'released' && lease.handoff_phase === 'idle' && cleared
        && recoveredLifecycle;
      const terminal = ['completed', 'stopped'].includes(loop.status);
      if (!immediate && !recovered && !terminal) {
        errors.push(label + ' current cleared failure projection invalid');
      }
    }
    if (isPrimaryLive && !isLeaseBound) errors.push(label + ' live lease binding missing');
    if ((isPrimaryLive || isLeaseBound)
        && (incomingParents.length !== 1
          || incomingParents[0].run_id !== lease.owner_run_id
          || incomingParents[0].outcome !== null
          || session.started_at !== null || session.ended_at !== null
          || session.outcome !== null || session.superseded_by !== null)) {
      errors.push(label + ' live App parent/session lifecycle invalid');
    }
    if (terminalPhase && !isLeaseBound && incomingParents.length !== 0) {
      errors.push(label + ' cleared terminal continuation has incoming parent');
    }
    if (isPrimaryLive && !(consent?.mode === 'auto'
        && consent?.authority === 'human-confirmed' && consent.revoked_at === null)) {
      errors.push(label + ' live continuation requires current auto consent');
    }
    if (isPrimaryLive) {
      const emittedLease = continuation.phase === 'emitted'
        && lease.state === 'releasing' && lease.handoff_phase === 'emitted';
      const spawnedLease = ['prepared', 'confirmed'].includes(continuation.phase)
        && lease.state === 'releasing' && lease.handoff_phase === 'spawned';
      if (!emittedLease && !spawnedLease) errors.push(label + ' live lease phase invalid');
    }
    if (isLeaseBound && terminalPhase) {
      const expectedPhase = preparedPair ? 'spawned' : 'emitted';
      if (loop.status !== 'paused' || loop.pause_reason == null
          || (continuation.phase === 'failed'
            && loop.pause_reason !== continuation.failure_code)
          || lease.resume_policy !== 'human' || lease.expires_at !== null
          || lease.state !== 'releasing' || lease.handoff_phase !== expectedPhase) {
        errors.push(label + ' human-preserve lease phase invalid');
      }
    }
    if (isPrimaryLive || isLeaseBound) bound.push({ session, continuation, isPrimaryLive });
  }
  if (bound.length > 1) errors.push('multiple live App continuations');
  if (bound.length === 1) {
    const requiredPolicy = bound[0].isPrimaryLive ? 'app' : 'human';
    if (lease.resume_policy !== requiredPolicy) errors.push('live App continuation resume policy invalid');
    const parent = sessions.find(session => session.run_id === lease.owner_run_id);
    if (!parent || parent.run_id === bound[0].session.run_id
        || parent.superseded_by !== bound[0].session.run_id) {
      errors.push('live App continuation parent link invalid');
    } else if (parent.host_surface?.kind !== 'codex-app'
        || parent.host_surface.observed_generation !== lease.generation) {
      errors.push('live App continuation parent attestation is stale');
    } else {
      validateLiveAppRoute(loop, parent, bound[0].session,
        bound[0].continuation, errors);
    }
  } else if (lease.handoff_transport === 'codex-app') {
    errors.push('orphan App lease binding');
  }
  if (lease.handoff_transport === null && lease.handoff_attempt_id !== null) {
    errors.push('orphan App attempt binding');
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
  validateAppState(loopJson, errors);
  return { ok: errors.length === 0, errors };
}
