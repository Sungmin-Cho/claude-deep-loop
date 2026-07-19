import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import { types } from 'node:util';
import { contentHash } from './envelope.mjs';
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
  if (value === null || typeof value !== 'object' || types.isProxy(value)
      || Array.isArray(value)) return false;
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
  if (value !== null && typeof value === 'object') {
    if (types.isProxy(value)) throw new Error('projection object Proxy invalid');
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalProjectionValue(value[key])]),
    );
  }
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
    if (typeof item !== 'object' || item === undefined || types.isProxy(item)
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
    if (initialObservation !== null && initialObservation.observed_generation === 1
        && initialObservation.observed_at !== loop.created_at) {
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
    const emittedManualPreserve = continuation.phase === 'emitted'
      && loop.status === 'paused' && loop.pause_reason === 'app-launch-unconfirmed'
      && lease.resume_policy === 'human' && lease.expires_at === null
      && continuation.prepared_at === null && continuation.failure_code === null;
    const confirmedAwaitPreserve = continuation.phase === 'confirmed'
      && loop.status === 'paused' && loop.pause_reason === 'app-child-timeout-awaiting'
      && lease.resume_policy === 'human' && lease.expires_at === null
      && strictMs(continuation.prepared_at) !== null
      && strictMs(continuation.confirmed_at) !== null
      && continuation.failure_code === null;
    const primaryHumanPreserve = emittedManualPreserve || confirmedAwaitPreserve;
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
    if (isPrimaryLive || isLeaseBound) {
      bound.push({ session, continuation, isPrimaryLive, primaryHumanPreserve });
    }
  }
  if (bound.length > 1) errors.push('multiple live App continuations');
  if (bound.length === 1) {
    const requiredPolicy = bound[0].isPrimaryLive && !bound[0].primaryHumanPreserve
      ? 'app' : 'human';
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

const APP_EVENT_CLOCK = Object.freeze([
  ['emitted_at', 'handoff-emitted'],
  ['prepared_at', 'app-task-prepared'],
  ['confirmed_at', 'app-task-confirmed'],
  ['acquired_at', 'app-task-acquired'],
]);
const APP_CONTROL_TYPES = new Set([
  'app-task-consent-revoked', 'app-task-failed', 'app-task-swept',
  'app-task-preserved', 'app-task-abandoned', 'app-task-await-timeout',
  'run-recovered', 'finish',
]);
const APP_FAILURE_EVENT = new Map([
  ['host-call-timeout', 'app-task-failed'],
  ['host-call-no-return', 'app-task-failed'],
  ['host-call-failed', 'app-task-failed'],
  ['invalid-host-receipt', 'app-task-failed'],
  ['message-unconfirmed', 'app-task-failed'],
  ['app-prepare-unattended', 'app-task-swept'],
  ['app-launch-unconfirmed', 'app-task-swept'],
  ['consent-revoked', 'app-task-consent-revoked'],
  ['gate-budget', 'app-task-abandoned'],
  ['gate-breaker', 'app-task-abandoned'],
  ['gate-max-sessions', 'app-task-abandoned'],
  ['gate-wallclock', 'app-task-abandoned'],
  ['gate-auto-handoff', 'app-task-abandoned'],
  ['human-recovered', 'run-recovered'],
  ['run-finished', 'finish'],
]);
const APP_CONTROL_EXACT_KEYS = Object.freeze({
  'app-task-consent-revoked': [['attempt_id', 'child_run_id', 'failure_code',
    'generation', 'owner_run_id']],
  'app-task-failed': [
    ['attempt_id', 'child_run_id', 'failure_code', 'generation', 'owner_run_id'],
    ['attempt_id', 'child_run_id', 'failure_code', 'generation', 'owner_run_id',
      'unconfirmed_receipt_digest'],
  ],
  'app-task-swept': [['attempt_id', 'child_run_id', 'failure_code',
    'generation', 'owner_run_id']],
  'app-task-abandoned': [['attempt_id', 'child_run_id', 'failure_code',
    'generation', 'owner_run_id']],
  'app-task-preserved': [['attempt_id', 'child_run_id', 'failure_code']],
  'app-task-await-timeout': [['attempt_id', 'child_run_id', 'failure_code']],
  finish: [
    ['reportRel', 'status'],
    ['attempt_id', 'child_run_id', 'failure_code', 'reportRel', 'status'],
  ],
});

function hostObservationSeed(loop, session, index, events) {
  const surface = session?.host_surface;
  if (surface == null) return null;
  let surfaceDigest = 'INVALID';
  try { surfaceDigest = hostSurfaceFactsDigest(surface); } catch {}
  const continuation = session.continuation;
  const acquiredEvent = events.find(event => event?.type === 'app-task-acquired'
    && event?.data?.attempt_id === continuation?.attempt_id
    && event?.data?.child_run_id === session.run_id);
  const acquiredSeeded = continuation?.transport === 'codex-app'
    && continuation.phase === 'acquired'
    && Number.isSafeInteger(continuation.acquired_generation)
    && strictMs(continuation.acquired_at) !== null
    && session.started_at === continuation.acquired_at
    && acquiredEvent?.ts === continuation.acquired_at
    && acquiredEvent?.data?.observation_digest === surfaceDigest;
  if (acquiredSeeded) return { generation: continuation.acquired_generation,
    observedAt: continuation.acquired_at, digest: acquiredEvent.data.observation_digest,
    kind: 'acquired', index: events.indexOf(acquiredEvent) };
  const genesisEvent = events.find(event => event?.type === 'run-initialized');
  const requiresGenesisEvent = loop?.initialization?.request_digest !== undefined;
  const genesisSeeded = index === 0 && loop?.initialization !== undefined
    && loop.initialization.host_surface_digest !== 'NONE'
    && loop.initialization.host_surface_digest === surfaceDigest
    && (!requiresGenesisEvent || genesisEvent?.data?.host_surface_digest === surfaceDigest)
    && session.run_id === loop.run_id
    && strictMs(loop.created_at) !== null
    && session.started_at === loop.created_at;
  if (genesisSeeded) return { generation: 1, observedAt: loop.created_at,
    digest: loop.initialization.host_surface_digest, kind: 'genesis',
    index: events.indexOf(genesisEvent) };
  return null;
}

// Finish/review authority is narrower than mutable comprehension bookkeeping. Keep the complete
// episode proof record but deliberately exclude the two acknowledgement markers: changing either
// marker is already authenticated by comprehension counters/events and must remain possible after
// a legacy checkpoint without inventing review proof. Workstream proof is the exact subset consumed
// by finish/review routing; its episode inventory and integration metadata are not terminal proof.
export function episodeProofProjection(episode) {
  const projection = structuredClone(episode);
  delete projection.human_reviewed;
  delete projection.agent_reviewed;
  return projection;
}

const EPISODE_TASK_MAX_BYTES = 16 * 1024;

export function assertEpisodeTask(task) {
  if (typeof task !== 'string' || task.trim().length === 0
      || Buffer.byteLength(task, 'utf8') > EPISODE_TASK_MAX_BYTES
      || task.includes('\0') || task.includes('\r')
      || /[\uD800-\uDFFF]/u.test(task)) {
    throw new Error('EPISODE_TASK_INVALID');
  }
}

export function episodeRequestMarkdown({ id, plugin, role, kind, point, task, contract,
  workstream = null, expectedArtifacts = [], evidence } = {}) {
  assertEpisodeTask(task);
  if (typeof id !== 'string' || id.length === 0 || typeof plugin !== 'string'
      || typeof role !== 'string' || typeof kind !== 'string' || typeof point !== 'string'
      || !Array.isArray(expectedArtifacts)
      || !expectedArtifacts.every(artifact => typeof artifact === 'string')) {
    throw new Error('EPISODE_REQUEST_MARKDOWN_INPUT_INVALID');
  }
  return [
    `# Episode ${id} — request`, '',
    `- plugin: ${plugin}`, `- role: ${role}`, `- kind: ${kind}`,
    `- review point: ${point}`, `- workstream: ${workstream || '(none)'}`, '',
    '## Task', '', task, '',
    '## Contract', '', '```json', JSON.stringify(contract ?? null, null, 2), '```', '',
    '## Expected artifacts', '',
    ...(expectedArtifacts.length
      ? expectedArtifacts.map(artifact => `- ${artifact}`)
      : ['- <!-- list proof artifacts -->']), '',
    ...(evidence !== undefined ? ['## Evidence (kernel-verified insights)', '',
      '<!-- copy; anchored episodes[].evidence is authoritative -->', '',
      '```json', JSON.stringify(evidence, null, 2), '```', ''] : []),
    '## Constraints', '',
    '- Do not assume prior conversation context. The verified run plus this request are authoritative.',
    '',
  ].join('\n');
}

export function workstreamProofProjection(loop, workstream) {
  return {
    id: workstream.id,
    status: workstream.status,
    review_points_done: structuredClone(workstream.review_points_done ?? []),
    active: (loop?.active_workstreams ?? []).includes(workstream.id),
    active_workstreams: structuredClone(loop?.active_workstreams ?? []),
  };
}

// Input compatibility exists only for the first verified mutation of an initialization-absent,
// checkpoint-free run. Preserve the first occurrence of each existing string ID in source order;
// old duplicates, unknown IDs, and non-strings are discarded deterministically in memory and the
// normalized candidate is published only together with the checkpoint/business event.
export function normalizeLegacyActiveWorkstreams(loop) {
  const existing = new Set((Array.isArray(loop?.workstreams) ? loop.workstreams : [])
    .map(workstream => workstream?.id)
    .filter(id => typeof id === 'string'));
  const seen = new Set();
  const normalized = [];
  for (const id of (Array.isArray(loop?.active_workstreams) ? loop.active_workstreams : [])) {
    if (typeof id !== 'string' || !existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

function legacyOriginDigest(kind, projection) {
  return contentHash(`proof-entity-${kind}-v1\0${JSON.stringify({
    kind: 'object', value: projection,
  })}`);
}

export function legacyProofOrigins(loop, episodeCount, workstreamCount) {
  const episodes = Array.isArray(loop?.episodes) ? loop.episodes : [];
  const workstreams = Array.isArray(loop?.workstreams) ? loop.workstreams : [];
  if (!Number.isSafeInteger(episodeCount) || episodeCount < 0
      || episodeCount > episodes.length
      || !Number.isSafeInteger(workstreamCount) || workstreamCount < 0
      || workstreamCount > workstreams.length) {
    throw new Error('LEGACY_PROOF_BASELINE_COUNT_INVALID');
  }
  return [
    ...episodes.slice(0, episodeCount).map(episode => ({
      kind: 'episode', id: episode.id,
      digest: legacyOriginDigest('episode', episodeProofProjection(episode)),
    })),
    ...workstreams.slice(0, workstreamCount).map(workstream => ({
      kind: 'workstream', id: workstream.id,
      digest: legacyOriginDigest('workstream', workstreamProofProjection(loop, workstream)),
    })),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
}

export function legacyAuthorityDigest(loop) {
  const projection = {
    review_contract: loop.review == null ? null : {
      points: structuredClone(loop.review.points ?? []),
      reviewer: loop.review.reviewer ?? null,
      mode: loop.review.mode ?? null,
      flags: structuredClone(loop.review.flags ?? []),
      converge: loop.review.converge ?? null,
      require_human_ack: loop.review.require_human_ack ?? null,
    },
    recipe: { id: loop.recipe?.id ?? null },
  };
  const encoded = JSON.stringify({ kind: 'object', value: projection });
  return contentHash(`legacy-proof-authority-v1\0${encoded}`);
}

export function verifyAppEventCorrelation(loop, lines) {
  const errors = [];
  const events = Array.isArray(lines) ? lines : [];
  const lineageCheckpoints = events.filter(event => event?.type === 'lease-lineage-baselined');
  const legacyLineage = loop?.legacy_lineage;
  const preCheckpointLegacy = loop?.initialization === undefined
    && lineageCheckpoints.length === 0;
  const workstreamIds = (loop?.workstreams ?? []).map(workstream => workstream?.id);
  const activeWorkstreams = loop?.active_workstreams;
  if (!preCheckpointLegacy && activeWorkstreams !== undefined
      && (!Array.isArray(activeWorkstreams)
      || new Set(activeWorkstreams).size !== activeWorkstreams.length
      || activeWorkstreams.some(id => typeof id !== 'string' || !workstreamIds.includes(id)))) {
    errors.push('active_workstreams must be unique existing workstream IDs');
  }
  const identities = new Set();
  const sessions = loop?.session_chain?.sessions ?? [];
  const currentLease = loop?.session_chain?.lease ?? {};
  const initializationEvents = events.filter(event => event?.type === 'run-initialized');
  const hasInitializationGenesis = loop?.initialization?.request_digest !== undefined;
  if (loop?.initialization === undefined) {
    if (initializationEvents.length !== 0) errors.push('legacy run-initialized event forbidden');
  } else if (hasInitializationGenesis) {
    const event = initializationEvents[0];
    const exactKeys = ['host_surface_digest', 'request_digest', 'run_id'];
    if (initializationEvents.length !== 1 || event !== events[0] || event?.seq !== 1
        || event?.ts !== loop.created_at
        || JSON.stringify(Object.keys(event?.data ?? {}).sort()) !== JSON.stringify(exactKeys)
        || event?.data?.run_id !== loop.run_id
        || event?.data?.request_digest !== loop.initialization.request_digest
        || event?.data?.host_surface_digest !== loop.initialization.host_surface_digest) {
      errors.push('run-initialized genesis binding invalid');
    }
  }
  let checkpointFloor = null;
  if (loop?.initialization !== undefined) {
    if (lineageCheckpoints.length !== 0) {
      errors.push('initialized run cannot declare a legacy lineage checkpoint');
    }
    if (legacyLineage !== undefined) {
      errors.push('initialized run cannot declare legacy lineage state');
    }
  } else if (lineageCheckpoints.length > 1) {
    errors.push('legacy run has duplicate lineage checkpoints');
  } else if (lineageCheckpoints.length === 0 && legacyLineage !== undefined) {
    errors.push('pre-checkpoint legacy run cannot declare lineage state');
  } else if (lineageCheckpoints.length === 1) {
    const checkpoint = lineageCheckpoints[0];
    const checkpointIndex = events.indexOf(checkpoint);
    const data = checkpoint.data ?? {};
    const exactKeys = ['acquired_at', 'generation', 'lease_state',
      'legacy_active_workstreams',
      'legacy_authority_digest', 'legacy_episode_count', 'legacy_proof_origins',
      'legacy_workstream_count', 'owner_run_id'].sort();
    const legacyEpisodes = Array.isArray(loop?.episodes) ? loop.episodes : [];
    const legacyWorkstreams = Array.isArray(loop?.workstreams) ? loop.workstreams : [];
    const legacyCount = data.legacy_episode_count;
    const legacyWorkstreamCount = data.legacy_workstream_count;
    const prefix = Number.isSafeInteger(legacyCount) && legacyCount >= 0
      ? legacyEpisodes.slice(0, legacyCount) : [];
    const workstreamPrefix = Number.isSafeInteger(legacyWorkstreamCount)
      && legacyWorkstreamCount >= 0
      ? legacyWorkstreams.slice(0, legacyWorkstreamCount) : [];
    const prefixIsUnversioned = prefix.every(episode => episode?.creation_contract == null)
      && workstreamPrefix.every(workstream => workstream?.creation_contract == null);
    const origins = data.legacy_proof_origins;
    let canonicalOrigins = null;
    try {
      const firstBeforeDigest = new Map();
      for (const event of lines.slice(lines.indexOf(checkpoint) + 1)) {
        for (const transition of (event?.data?.proof_transitions ?? [])) {
          const key = `${transition?.kind}:${transition?.id}`;
          if (!firstBeforeDigest.has(key)) {
            firstBeforeDigest.set(key, transition?.before_digest);
          }
        }
      }
      canonicalOrigins = legacyProofOrigins(loop, legacyCount, legacyWorkstreamCount)
        .map(origin => ({ ...origin,
          digest: firstBeforeDigest.get(`${origin.kind}:${origin.id}`) ?? origin.digest }));
    } catch {}
    const originKeys = Array.isArray(origins)
      ? origins.map(origin => `${origin?.kind}:${origin?.id}`) : [];
    const expectedOriginKeys = [
      ...prefix.map(episode => `episode:${episode?.id}`),
      ...workstreamPrefix.map(workstream => `workstream:${workstream?.id}`),
    ].sort();
    const originsValid = Array.isArray(origins)
      && canonicalOrigins !== null
      && JSON.stringify(origins) === JSON.stringify(canonicalOrigins)
      && origins.length === legacyCount + legacyWorkstreamCount
      && JSON.stringify(originKeys) === JSON.stringify(expectedOriginKeys)
      && new Set(originKeys).size === originKeys.length
      && origins.every(origin => origin != null
        && JSON.stringify(Object.keys(origin).sort())
          === JSON.stringify(['digest', 'id', 'kind'])
        && ['episode', 'workstream'].includes(origin.kind)
        && typeof origin.id === 'string' && origin.id.length > 0
        && /^[0-9a-f]{64}$/.test(origin.digest || ''));
    const checkpointValid = checkpointIndex >= 0 && strictMs(checkpoint.ts) !== null
      && strictMs(data.acquired_at) !== null
      && strictMs(data.acquired_at) <= strictMs(checkpoint.ts)
      && JSON.stringify(Object.keys(data).sort()) === JSON.stringify(exactKeys)
      && typeof data.owner_run_id === 'string' && data.owner_run_id.length > 0
      && sessions.some(session => session.run_id === data.owner_run_id)
      && Number.isSafeInteger(data.generation) && data.generation >= 1
      && ['active', 'releasing', 'released'].includes(data.lease_state)
      && Number.isSafeInteger(legacyCount) && legacyCount >= 0
      && legacyCount <= legacyEpisodes.length
      && Number.isSafeInteger(legacyWorkstreamCount) && legacyWorkstreamCount >= 0
      && legacyWorkstreamCount <= legacyWorkstreams.length
      && Array.isArray(data.legacy_active_workstreams)
      && data.legacy_active_workstreams.every((id, index, values) =>
        typeof id === 'string'
          && workstreamPrefix.some(workstream => workstream?.id === id)
          && values.indexOf(id) === index)
      && legacyLineage != null && !Array.isArray(legacyLineage)
      && JSON.stringify(Object.keys(legacyLineage).sort())
        === JSON.stringify(['active_workstreams'])
      && Array.isArray(legacyLineage.active_workstreams)
      && JSON.stringify(data.legacy_active_workstreams)
        === JSON.stringify(legacyLineage.active_workstreams)
      && prefixIsUnversioned
      && originsValid
      && /^[0-9a-f]{64}$/.test(data.legacy_authority_digest || '')
      && data.legacy_authority_digest === legacyAuthorityDigest(loop);
    if (!checkpointValid) {
      errors.push('legacy lineage checkpoint binding invalid');
    } else {
      checkpointFloor = { generation: data.generation, owner: data.owner_run_id,
        leaseState: data.lease_state, acquiredAt: data.acquired_at,
        index: checkpointIndex };
    }
  }
  const genericAcquireEvents = events.filter(event => event?.type === 'lease-acquired');
  for (const event of genericAcquireEvents) {
    const data = event.data ?? {};
    const keys = Object.keys(data).sort();
    const exactKeys = ['generation', 'owner_run_id',
      'previous_generation', 'previous_owner_run_id'];
    const stalePostCheckpoint = checkpointFloor !== null
      && events.indexOf(event) > checkpointFloor.index
      && data.generation <= checkpointFloor.generation;
    if (JSON.stringify(keys) !== JSON.stringify(exactKeys)
        || strictMs(event.ts) === null
        || typeof data.owner_run_id !== 'string' || data.owner_run_id.length === 0
        || typeof data.previous_owner_run_id !== 'string'
        || data.previous_owner_run_id.length === 0
        || !Number.isSafeInteger(data.previous_generation)
        || data.previous_generation < 1
        || data.generation !== data.previous_generation + 1
        || data.generation > (currentLease.generation ?? 0)
        || stalePostCheckpoint) {
      errors.push('lease-acquired causal binding invalid');
    }
  }
  const genericEdges = genericAcquireEvents.map(event => ({ kind: 'generic', event,
    index: events.indexOf(event), previousOwner: event.data?.previous_owner_run_id,
    previousGeneration: event.data?.previous_generation,
    owner: event.data?.owner_run_id, generation: event.data?.generation }));
  const appEdges = sessions
    .filter(session => session?.continuation?.transport === 'codex-app'
      && session.continuation.phase === 'acquired'
      && Number.isSafeInteger(session.continuation.acquired_generation))
    .map(session => {
      const continuation = session.continuation;
      const parents = sessions.filter(parent => parent.superseded_by === session.run_id);
      const event = events.find(item => item?.type === 'app-task-acquired'
        && item?.data?.attempt_id === continuation.attempt_id
        && item?.data?.child_run_id === session.run_id);
      return { kind: 'app', event, index: events.indexOf(event),
        previousOwner: parents.length === 1 ? parents[0].run_id : undefined,
        previousGeneration: continuation.acquired_generation - 1,
        owner: session.run_id, generation: continuation.acquired_generation };
    });
  const acquisitionEdges = [...genericEdges, ...appEdges];
  const ownerAtGeneration = new Map();
  const edgeIndexByGeneration = new Map();
  const lineageFloor = loop?.initialization !== undefined
    ? { generation: 1, owner: loop.run_id, index: events.indexOf(initializationEvents[0]),
      kind: 'genesis' }
    : checkpointFloor === null ? null : { ...checkpointFloor, kind: 'checkpoint' };
  let lineageComplete = lineageFloor !== null
    && Number.isSafeInteger(currentLease.generation)
    && currentLease.generation >= lineageFloor.generation
    && typeof currentLease.owner_run_id === 'string';
  if (lineageComplete) {
    ownerAtGeneration.set(currentLease.generation, currentLease.owner_run_id);
    let laterIndex = events.length;
    for (let generation = currentLease.generation;
      generation > lineageFloor.generation; generation -= 1) {
      const candidates = acquisitionEdges.filter(edge => edge.generation === generation
        && edge.index > lineageFloor.index);
      const edge = candidates.length === 1 ? candidates[0] : null;
      const exact = edge !== null && edge.previousGeneration === generation - 1
        && edge.owner === ownerAtGeneration.get(generation)
        && edge.index > lineageFloor.index && edge.index < laterIndex
        && strictMs(edge.event?.ts) !== null
        && (generation !== currentLease.generation
          || edge.event.ts === currentLease.acquired_at);
      if (!exact) {
        lineageComplete = false;
        errors.push(`lease generation ${generation} acquisition lineage invalid`);
        break;
      }
      ownerAtGeneration.set(generation - 1, edge.previousOwner);
      edgeIndexByGeneration.set(generation, edge.index);
      laterIndex = edge.index;
    }
    if (lineageComplete
        && ownerAtGeneration.get(lineageFloor.generation) !== lineageFloor.owner) {
      lineageComplete = false;
      errors.push(`${lineageFloor.kind} lineage owner mismatch`);
    }
    if (lineageComplete && lineageFloor.kind === 'checkpoint'
        && currentLease.generation === lineageFloor.generation
        && currentLease.acquired_at !== lineageFloor.acquiredAt) {
      lineageComplete = false;
      errors.push('legacy lineage checkpoint acquired-at mismatch');
    }
  }
  const isProvenHistorical = (ownerRunId, generation, proofIndex) => lineageComplete
    && Number.isSafeInteger(generation) && currentLease.generation > generation
    && ownerAtGeneration.get(generation) === ownerRunId
    && edgeIndexByGeneration.get(generation + 1) > proofIndex;
  for (const session of sessions) {
    const continuation = session?.continuation;
    if (continuation?.transport !== 'codex-app') continue;
    const identity = `${continuation.attempt_id}\u0000${session.run_id}`;
    identities.add(identity);
    const lifecycleIndexes = new Map();
    let previousLifecycleIndex = -1;
    for (const [clockField, eventType] of APP_EVENT_CLOCK) {
      const timestamp = continuation[clockField];
      const matches = events.filter(event => event?.type === eventType
        && event?.data?.attempt_id === continuation.attempt_id
        && event?.data?.child_run_id === session.run_id);
      if (timestamp == null && matches.length !== 0) {
        errors.push(`${eventType} ${continuation.attempt_id}/${session.run_id} premature count=${matches.length}`);
      } else if (timestamp != null && matches.length !== 1) {
        errors.push(`${eventType} ${continuation.attempt_id}/${session.run_id} count=${matches.length}`);
      } else if (timestamp != null && (strictMs(matches[0].ts) === null
          || matches[0].ts !== timestamp)) {
        errors.push(`${eventType} ${continuation.attempt_id}/${session.run_id} timestamp mismatch`);
      }
      if (timestamp != null && matches.length === 1) {
        const lifecycleIndex = events.indexOf(matches[0]);
        lifecycleIndexes.set(eventType, lifecycleIndex);
        if (lifecycleIndex <= previousLifecycleIndex) {
          errors.push(`${eventType} ${continuation.attempt_id}/${session.run_id} lifecycle order invalid`);
        }
        previousLifecycleIndex = Math.max(previousLifecycleIndex, lifecycleIndex);
      }
      if (eventType === 'app-task-prepared' && timestamp != null && matches.length === 1) {
        const keys = Object.keys(matches[0].data ?? {}).sort();
        if (JSON.stringify(keys) !== JSON.stringify(
          ['attempt_id', 'child_run_id', 'descriptor_digest'])
            || matches[0].data.descriptor_digest !== continuation.descriptor_digest) {
          errors.push(`${eventType} ${continuation.attempt_id}/${session.run_id} descriptor digest mismatch`);
        }
      } else if (eventType === 'app-task-confirmed' && timestamp != null
          && matches.length === 1) {
        const expectedDigest = typeof continuation.thread_id === 'string'
          ? contentHash('confirmed-thread\0' + continuation.thread_id) : 'INVALID';
        const keys = Object.keys(matches[0].data ?? {}).sort();
        if (JSON.stringify(keys) !== JSON.stringify(
          ['attempt_id', 'child_run_id', 'receipt_digest'])
            || matches[0].data.receipt_digest !== expectedDigest) {
          errors.push(`${eventType} ${continuation.attempt_id}/${session.run_id} receipt digest mismatch`);
        }
      } else if (eventType === 'app-task-acquired' && timestamp != null
          && matches.length === 1) {
        let digest = 'INVALID';
        try { digest = hostSurfaceFactsDigest(session.host_surface); } catch {}
        if (matches[0].data?.observation_digest !== digest) {
          errors.push(`${eventType} ${continuation.attempt_id}/${session.run_id} observation digest mismatch`);
        }
      }
    }
    const controls = events.filter(event => APP_CONTROL_TYPES.has(event?.type)
      && event?.data?.attempt_id === continuation.attempt_id
      && event?.data?.child_run_id === session.run_id);
    const terminalControlTypes = new Set([
      'app-task-failed', 'app-task-swept', 'app-task-abandoned',
    ]);
    for (const type of APP_CONTROL_TYPES) {
      const matches = controls.filter(event => event.type === type);
      if (matches.length > 1) {
        errors.push(`${type} ${continuation.attempt_id}/${session.run_id} count=${matches.length}`);
      }
      if (matches.some(event => strictMs(event.ts) === null)) {
        errors.push(`${type} ${continuation.attempt_id}/${session.run_id} timestamp invalid`);
      }
    }
    const awaitTimeout = controls.find(event => event.type === 'app-task-await-timeout');
    if (awaitTimeout !== undefined) {
      const timeoutIndex = events.indexOf(awaitTimeout);
      const confirmedIndex = lifecycleIndexes.get('app-task-confirmed');
      const acquiredIndex = lifecycleIndexes.get('app-task-acquired');
      if (confirmedIndex === undefined || timeoutIndex <= confirmedIndex
          || (acquiredIndex !== undefined && timeoutIndex >= acquiredIndex)) {
        errors.push(`app-task-await-timeout ${continuation.attempt_id}/${session.run_id} lifecycle order invalid`);
      }
    }
    const lastLifecycleIndex = Math.max(-1, ...lifecycleIndexes.values());
    for (const control of controls) {
      if (control.type !== 'app-task-await-timeout'
          && events.indexOf(control) <= lastLifecycleIndex) {
        errors.push(`${control.type} ${continuation.attempt_id}/${session.run_id} lifecycle order invalid`);
      }
    }
    for (const event of controls) {
      const failureCode = event.data?.failure_code;
      const allowedKeySets = APP_CONTROL_EXACT_KEYS[event.type];
      if (allowedKeySets !== undefined) {
        const actualKeys = Object.keys(event.data ?? {}).sort();
        const exact = allowedKeySets.some(keys =>
          JSON.stringify(actualKeys) === JSON.stringify([...keys].sort()));
        const failedReceiptShape = event.type === 'app-task-failed'
          && ((failureCode === 'message-unconfirmed')
            !== Object.hasOwn(event.data ?? {}, 'unconfirmed_receipt_digest'));
        if (!exact || failedReceiptShape) {
          errors.push(`${event.type} ${continuation.attempt_id}/${session.run_id} exact keys invalid`);
        }
      }
      if (['app-task-failed', 'app-task-swept', 'app-task-abandoned',
        'run-recovered', 'finish'].includes(event.type)
          && failureCode !== continuation.failure_code) {
        errors.push(`${event.type} ${continuation.attempt_id}/${session.run_id} failure code mismatch`);
      }
      if (event.type === 'app-task-preserved'
          && (typeof failureCode !== 'string' || failureCode.length === 0)) {
        errors.push(`app-task-preserved ${continuation.attempt_id}/${session.run_id} failure code invalid`);
      }
      if (event.type === 'app-task-await-timeout'
          && failureCode !== 'app-child-timeout-awaiting') {
        errors.push(`app-task-await-timeout ${continuation.attempt_id}/${session.run_id} failure code invalid`);
      }
    }
    if (['failed', 'abandoned'].includes(continuation.phase)) {
      const expectedType = APP_FAILURE_EVENT.get(continuation.failure_code);
      const proof = controls.filter(event => event.type === expectedType
        && event.data?.failure_code === continuation.failure_code);
      const terminalControls = controls.filter(event => terminalControlTypes.has(event.type));
      const expectedTerminalCount = terminalControlTypes.has(expectedType) ? 1 : 0;
      if (terminalControls.length !== expectedTerminalCount) {
        errors.push(`App terminal ${continuation.attempt_id}/${session.run_id} control family mismatch`);
      }
      if (expectedType === undefined || proof.length !== 1) {
        errors.push(`App terminal ${continuation.attempt_id}/${session.run_id} proof mismatch`);
      }
      if (continuation.phase === 'failed') {
        const binding = continuation.failure_binding;
        const eventData = proof[0]?.data;
        const baseFailureKeys = [
          'attempt_id', 'child_run_id', 'failure_code', 'generation', 'owner_run_id',
        ];
        const expectedFailureKeys = continuation.failure_code === 'message-unconfirmed'
          ? [...baseFailureKeys, 'unconfirmed_receipt_digest'].sort()
          : baseFailureKeys.sort();
        if (typeof binding?.owner_run_id !== 'string'
            || !Number.isSafeInteger(binding?.generation)
            || eventData?.owner_run_id !== binding.owner_run_id
            || eventData?.generation !== binding.generation
            || JSON.stringify(Object.keys(eventData ?? {}).sort())
              !== JSON.stringify(expectedFailureKeys)) {
          errors.push(`App failure ${continuation.attempt_id}/${session.run_id} binding mismatch`);
        }
        if (continuation.failure_code === 'message-unconfirmed') {
          const expectedDigest = typeof continuation.unconfirmed_thread_id === 'string'
            ? contentHash('unconfirmed-thread\0' + continuation.unconfirmed_thread_id)
            : 'INVALID';
          if (eventData?.unconfirmed_receipt_digest !== expectedDigest) {
            errors.push(`App failure ${continuation.attempt_id}/${session.run_id} receipt digest mismatch`);
          }
        } else if (Object.hasOwn(eventData ?? {}, 'unconfirmed_receipt_digest')) {
          errors.push(`App failure ${continuation.attempt_id}/${session.run_id} unexpected receipt digest`);
        }
      }
      const proofEvent = proof[0];
      const proofData = proofEvent?.data ?? {};
      const lease = loop?.session_chain?.lease ?? {};
      const ownerBoundProof = ['app-task-failed', 'app-task-swept',
        'app-task-abandoned', 'app-task-consent-revoked', 'run-recovered']
        .includes(expectedType);
      if (ownerBoundProof
          && (typeof proofData.owner_run_id !== 'string'
            || !Number.isSafeInteger(proofData.generation)
            || proofData.generation < 1 || proofData.generation > lease.generation
            || !sessions.some(item => item.run_id === proofData.owner_run_id
              && item.run_id !== session.run_id))) {
        errors.push(`App terminal ${continuation.attempt_id}/${session.run_id} owner binding invalid`);
      }
      const isLeaseBound = lease.handoff_transport === 'codex-app'
        && lease.handoff_attempt_id === continuation.attempt_id
        && lease.handoff_child_run_id === session.run_id;
      if (isLeaseBound && ownerBoundProof
          && (proofData.owner_run_id !== lease.owner_run_id
            || proofData.generation !== lease.generation)) {
        errors.push(`App terminal ${continuation.attempt_id}/${session.run_id} live binding mismatch`);
      }
      const proofIndex = events.indexOf(proofEvent);
      const historicalProof = isProvenHistorical(
        proofData.owner_run_id, proofData.generation, proofIndex);
      const currentProof = ownerBoundProof && !historicalProof;
      if (currentProof && (proofData.owner_run_id !== lease.owner_run_id
          || proofData.generation !== lease.generation)) {
        errors.push(`App terminal ${continuation.attempt_id}/${session.run_id} unsuperseded binding mismatch`);
      }
      if (currentProof && !isLeaseBound) {
        const laterFinishes = events.slice(proofIndex + 1)
          .filter(event => event?.type === 'finish');
        const terminalProjection = ['completed', 'stopped'].includes(loop?.status)
          && laterFinishes.length === 1
          && laterFinishes[0].data?.status === loop.status
          && laterFinishes[0].data?.reportRel === (loop.termination?.final_report ?? null)
          && laterFinishes[0].ts === loop.termination?.finished_at;
        const laterRecovery = expectedType === 'run-recovered' ? proofEvent
          : events.slice(proofIndex + 1).find(event => {
            if (event?.type !== 'run-recovered') return false;
            const data = event.data ?? {};
            const noChild = data.child_run_id === undefined
              && (Object.keys(data).length === 0
                || data.owner_run_id === proofData.owner_run_id
                  && data.generation === proofData.generation);
            const sameChild = data.attempt_id === continuation.attempt_id
              && data.child_run_id === session.run_id
              && data.owner_run_id === proofData.owner_run_id
              && data.generation === proofData.generation;
            return noChild || sameChild;
          });
        const incoming = sessions.filter(parent => parent.superseded_by === session.run_id);
        const ownerSession = sessions.find(item => item.run_id === proofData.owner_run_id);
        const clearedLifecycle = incoming.length === 0 && ownerSession?.outcome == null
          && session.started_at == null && session.ended_at == null
          && session.host_surface == null && session.superseded_by == null;
        const immediateOutcome = ['app-task-failed', 'app-task-swept', 'app-task-abandoned']
          .includes(expectedType)
          && session.outcome === 'failed_launch' && session.recovery_binding == null;
        const recoveryData = laterRecovery?.data ?? {};
        const recoveredSameChild = recoveryData.child_run_id === session.run_id;
        const recoveredOutcome = recoveredSameChild
          ? session.outcome === 'abandoned_recover'
            && session.recovery_binding?.owner_run_id === proofData.owner_run_id
            && session.recovery_binding?.generation === proofData.generation
          : recoveryData.child_run_id === undefined
            && session.outcome === 'failed_launch' && session.recovery_binding == null;
        const cleared = ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
          'handoff_idempotency_key', 'resume_policy', 'expires_at']
          .every(key => lease[key] == null);
        const immediate = laterRecovery === undefined && loop?.status === 'paused'
          && loop?.pause_reason === continuation.failure_code
          && lease.state === 'active' && lease.handoff_phase === 'idle' && cleared
          && clearedLifecycle && immediateOutcome;
        const recoveredProjection = laterRecovery !== undefined && loop?.status === 'paused'
          && loop?.pause_reason === 'recovered:awaiting-resume'
          && lease.state === 'released' && lease.handoff_phase === 'idle' && cleared
          && clearedLifecycle && recoveredOutcome;
        const exactTerminal = terminalProjection && clearedLifecycle
          && [null, 'failed_launch', 'abandoned_recover'].includes(session.outcome);
        if (!immediate && !recoveredProjection && !exactTerminal) {
          errors.push(`App terminal ${continuation.attempt_id}/${session.run_id} current projection invalid`);
        }
      }
    } else if (controls.some(event => [
      'app-task-consent-revoked', 'app-task-failed', 'app-task-swept',
      'app-task-abandoned', 'run-recovered', 'finish',
    ].includes(event.type))) {
      errors.push(`App live ${continuation.attempt_id}/${session.run_id} has terminal control proof`);
    }
    const latestControl = controls.at(-1);
    const latestAttemptTransition = events.filter(event =>
      event?.data?.attempt_id === continuation.attempt_id
      && event?.data?.child_run_id === session.run_id
      && (APP_CONTROL_TYPES.has(event.type) || event.type === 'app-task-acquired')).at(-1);
    if (latestControl?.type === 'app-task-preserved') {
      if (loop?.status !== 'paused' || loop?.pause_reason !== latestControl.data?.failure_code
          || loop?.session_chain?.lease?.resume_policy !== 'human') {
        errors.push(`app-task-preserved ${continuation.attempt_id}/${session.run_id} projection mismatch`);
      }
    }
    if (latestAttemptTransition?.type === 'app-task-await-timeout') {
      if (loop?.status !== 'paused' || loop?.pause_reason !== 'app-child-timeout-awaiting'
          || loop?.session_chain?.lease?.resume_policy !== 'human') {
        errors.push(`app-task-await-timeout ${continuation.attempt_id}/${session.run_id} projection mismatch`);
      }
    }
    const recovery = controls.find(event => event.type === 'run-recovered');
    if (recovery && (!['abandoned_recover', 'took_over'].includes(session.outcome)
        || typeof session.recovery_binding?.owner_run_id !== 'string'
        || !Number.isSafeInteger(session.recovery_binding?.generation)
        || (continuation.phase === 'failed'
          && (session.recovery_binding.owner_run_id
              !== continuation.failure_binding?.owner_run_id
            || session.recovery_binding.generation
              !== continuation.failure_binding?.generation)))) {
      errors.push(`run-recovered ${continuation.attempt_id}/${session.run_id} projection mismatch`);
    }
    const finished = controls.find(event => event.type === 'finish');
    if (finished && (!['completed', 'stopped'].includes(loop?.status)
        || loop?.session_chain?.lease?.handoff_attempt_id === continuation.attempt_id
        || sessions.some(parent => parent.superseded_by === session.run_id))) {
      errors.push(`finish ${continuation.attempt_id}/${session.run_id} projection mismatch`);
    }
  }
  const recoveryEvents = events.filter(item => item?.type === 'run-recovered');
  for (const event of recoveryEvents) {
    const data = event.data ?? {};
    const keys = Object.keys(data).sort();
    if (strictMs(event.ts) === null) errors.push('run-recovered timestamp invalid');
    if (data.child_run_id === undefined) {
      const legacy = keys.length === 0 && loop?.initialization === undefined;
      const newFormat = JSON.stringify(keys) === JSON.stringify(['generation', 'owner_run_id'])
        && typeof data.owner_run_id === 'string'
        && sessions.some(session => session.run_id === data.owner_run_id)
        && Number.isSafeInteger(data.generation) && data.generation >= 1
        && data.generation <= (loop?.session_chain?.lease?.generation ?? 0);
      if (!legacy && !newFormat) {
        errors.push('no-child run-recovered causal binding invalid');
      }
      continue;
    }
    const session = sessions.find(item => item.run_id === data.child_run_id);
    const binding = session?.recovery_binding;
    const app = session?.continuation?.transport === 'codex-app';
    const expectedKeys = app
      ? ['attempt_id', 'child_run_id', 'failure_code', 'generation', 'owner_run_id']
      : ['child_run_id', 'generation', 'owner_run_id'];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys.sort())
        || !session || !['abandoned_recover', 'took_over'].includes(session.outcome)
        || data.owner_run_id !== binding?.owner_run_id
        || data.generation !== binding?.generation
        || !Number.isSafeInteger(data.generation) || data.generation < 1
        || (app && (data.attempt_id !== session.continuation.attempt_id
          || data.failure_code !== session.continuation.failure_code))) {
      errors.push(`run-recovered ${String(data.child_run_id)} causal binding mismatch`);
    }
  }
  if (loop?.initialization !== undefined) {
    for (const session of sessions.filter(item => item?.recovery_binding != null)) {
      const binding = session.recovery_binding;
      const app = session?.continuation?.transport === 'codex-app';
      const matches = events.filter(event => event?.type === 'run-recovered'
        && event?.data?.child_run_id === session.run_id
        && event?.data?.owner_run_id === binding.owner_run_id
        && event?.data?.generation === binding.generation
        && (!app || (event.data?.attempt_id === session.continuation.attempt_id
          && event.data?.failure_code === session.continuation.failure_code)));
      if (matches.length !== 1) {
        errors.push(`session ${String(session.run_id)} recovery proof count=${matches.length}`);
      }
    }
  }
  if (loop?.status === 'paused' && loop?.pause_reason === 'recovered:awaiting-resume') {
    const lease = loop?.session_chain?.lease ?? {};
    const latest = recoveryEvents.at(-1);
    const data = latest?.data ?? {};
    const exactLegacy = loop?.initialization === undefined
      && Object.keys(data).length === 0;
    const exactCurrent = data.owner_run_id === lease.owner_run_id
      && data.generation === lease.generation;
    const cleared = ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
      'handoff_idempotency_key', 'resume_policy', 'expires_at']
      .every(key => lease[key] == null);
    if (!latest || (!exactLegacy && !exactCurrent)
        || lease.state !== 'released' || lease.handoff_phase !== 'idle' || !cleared) {
      errors.push('current recovered projection lacks exact latest recovery proof');
    }
  }
  const finishEvents = events.filter(event => event?.type === 'finish');
  const terminalStatus = ['completed', 'stopped'].includes(loop?.status);
  if (finishEvents.length !== (terminalStatus ? 1 : 0)) {
    errors.push(`finish global count=${finishEvents.length}`);
  } else if (terminalStatus) {
    const finish = finishEvents[0];
    const finishKeys = Object.keys(finish.data ?? {}).sort();
    const exactFinishKeys = APP_CONTROL_EXACT_KEYS.finish.some(keys =>
      JSON.stringify(finishKeys) === JSON.stringify([...keys].sort()));
    if (!exactFinishKeys) errors.push('finish global exact keys invalid');
    if (strictMs(finish.ts) === null
        || finish.data?.status !== loop.status
        || finish.data?.reportRel !== (loop?.termination?.final_report ?? null)
        || finish.ts !== loop?.termination?.finished_at) {
      errors.push('finish global terminal projection mismatch');
    }
  }
  if (finishEvents.length === 1) {
    const finishIndex = events.indexOf(finishEvents[0]);
    if (recoveryEvents.some(event => events.indexOf(event) > finishIndex)) {
      errors.push('run-recovered occurs after finish');
    }
    if (acquisitionEdges.some(edge => edge.index > finishIndex)) {
      errors.push('lease acquisition occurs after finish');
    }
  }
  const lease = currentLease;
  for (const recovery of recoveryEvents) {
    const data = recovery.data ?? {};
    if (!Number.isSafeInteger(data.generation)) continue;
    const recoveryIndex = events.indexOf(recovery);
    if (isProvenHistorical(data.owner_run_id, data.generation, recoveryIndex)) continue;
    if (data.owner_run_id !== lease.owner_run_id
        || data.generation !== lease.generation) {
      errors.push('unsuperseded recovery binding mismatch');
      continue;
    }
    const laterFinish = finishEvents.length === 1
      && events.indexOf(finishEvents[0]) > recoveryIndex;
    const cleared = ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
      'handoff_idempotency_key', 'resume_policy', 'expires_at']
      .every(key => lease[key] == null);
    const exactRecovered = loop?.status === 'paused'
      && loop?.pause_reason === 'recovered:awaiting-resume'
      && lease.state === 'released' && lease.handoff_phase === 'idle' && cleared;
    const exactTerminal = terminalStatus && laterFinish;
    if (!exactRecovered && !exactTerminal) {
      errors.push('unsuperseded recovery projection mismatch');
    }
  }
  const revokeEvents = events.filter(event => event?.type === 'app-task-consent-revoked');
  const consent = loop?.autonomy?.app_task_continuation;
  if (consent?.revoked_at == null) {
    if (revokeEvents.length !== 0) errors.push('App consent revoke event without durable revoke');
  } else if (revokeEvents.length !== 1) {
    errors.push(`App consent revoke count=${revokeEvents.length}`);
  } else {
    const revoke = revokeEvents[0];
    const data = revoke.data ?? {};
    const actualKeys = Object.keys(data).sort();
    const exactKeys = APP_CONTROL_EXACT_KEYS['app-task-consent-revoked'].some(keys =>
      JSON.stringify(actualKeys) === JSON.stringify([...keys].sort()));
    const nullableIdentity = data.attempt_id === null && data.child_run_id === null;
    const exactIdentity = typeof data.attempt_id === 'string'
      && typeof data.child_run_id === 'string'
      && identities.has(`${data.attempt_id}\u0000${data.child_run_id}`);
    const owner = sessions.find(session => session.run_id === data.owner_run_id);
    const revokeIndex = events.indexOf(revoke);
    const currentBinding = data.owner_run_id === currentLease.owner_run_id
      && data.generation === currentLease.generation;
    const historicalBinding = isProvenHistorical(
      data.owner_run_id, data.generation, revokeIndex);
    if (strictMs(revoke.ts) === null || revoke.ts !== consent.revoked_at
        || consent.mode !== 'manual' || consent.authority !== 'human-confirmed'
        || !exactKeys
        || typeof data.owner_run_id !== 'string' || data.owner_run_id.length === 0
        || !Number.isSafeInteger(data.generation) || data.generation < 1
        || data.generation > (loop?.session_chain?.lease?.generation ?? 0)
        || !owner || !(currentBinding || historicalBinding)
        || (exactIdentity && owner.run_id === data.child_run_id)
        || !(nullableIdentity || exactIdentity)
        || ![null, 'consent-revoked'].includes(data.failure_code)) {
      errors.push('App consent revoke projection mismatch');
    }
  }
  const sessionByOwner = new Map(sessions.map((session, index) =>
    [session.run_id, { session, index }]));
  const hostEvents = new Map();
  for (const event of events) {
    if (event?.type !== 'host-surface-observed') continue;
    const data = event.data ?? {};
    const found = sessionByOwner.get(data.owner_run_id);
    if (data.run_id !== loop?.run_id || !found) {
      errors.push(`host-surface-observed orphan run/owner ${String(data.run_id)}/${String(data.owner_run_id)}`);
      continue;
    }
    const surface = found.session.host_surface;
    let digest = 'INVALID';
    try { digest = hostSurfaceFactsDigest(surface); } catch {}
    if (surface == null || data.kind !== surface.kind
        || !Number.isSafeInteger(data.observed_generation) || data.observed_generation < 1
        || strictMs(event.ts) === null || data.observation_digest !== digest
        || !['observed', 'reattested'].includes(data.outcome)) {
      errors.push(`host-surface-observed ${data.owner_run_id} fields invalid`);
      continue;
    }
    const rows = hostEvents.get(data.owner_run_id) ?? [];
    rows.push(event);
    hostEvents.set(data.owner_run_id, rows);
  }
  for (const [index, session] of sessions.entries()) {
    const surface = session?.host_surface;
    const rows = hostEvents.get(session.run_id) ?? [];
    const seed = hostObservationSeed(loop, session, index, events);
    if (surface == null) {
      if (rows.length !== 0) errors.push(`host-surface-observed ${session.run_id} has null surface`);
      continue;
    }
    let previousGeneration = seed?.generation ?? 0;
    for (const [rowIndex, event] of rows.entries()) {
      const generation = event.data.observed_generation;
      const expectedOutcome = seed !== null || rowIndex > 0 ? 'reattested' : 'observed';
      if (seed !== null && events.indexOf(event) <= seed.index) {
        errors.push(`host-surface-observed ${session.run_id}/${generation} baseline order invalid`);
      }
      if (generation <= previousGeneration) {
        errors.push(`host-surface-observed ${session.run_id} generation duplicate/regression`);
      }
      if (event.data.outcome !== expectedOutcome) {
        errors.push(`host-surface-observed ${session.run_id}/${generation} outcome mismatch`);
      }
      previousGeneration = Math.max(previousGeneration, generation);
    }
    if (rows.length === 0) {
      const exactSeed = seed !== null
        && surface.observed_generation === seed.generation
        && surface.observed_at === seed.observedAt;
      if (!exactSeed) errors.push(`host-surface-observed ${session.run_id} current proof missing`);
      continue;
    }
    const latest = rows.at(-1);
    let digest = 'INVALID';
    try { digest = hostSurfaceFactsDigest(surface); } catch {}
    if (latest.data.observed_generation !== surface.observed_generation
        || latest.data.kind !== surface.kind
        || latest.data.observation_digest !== digest
        || latest.ts !== surface.observed_at) {
      errors.push(`host-surface-observed ${session.run_id} latest attestation mismatch`);
    }
  }
  const appTypes = new Set([...APP_EVENT_CLOCK.map(([, type]) => type), ...APP_CONTROL_TYPES]);
  for (const event of events) {
    if (!appTypes.has(event?.type)) continue;
    const attempt = event?.data?.attempt_id;
    const child = event?.data?.child_run_id;
    if (event.type === 'handoff-emitted' && attempt === undefined) continue;
    if (event.type === 'run-recovered' && attempt === undefined) continue;
    if (event.type === 'finish' && attempt === undefined && child === undefined) continue;
    if (event.type === 'app-task-consent-revoked'
        && attempt === null && child === null) continue;
    if (typeof attempt !== 'string' || typeof child !== 'string'
        || !identities.has(`${attempt}\u0000${child}`)) {
      errors.push(`${event.type} orphan App identity`);
    }
  }
  return { ok: errors.length === 0, errors };
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
