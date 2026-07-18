import { createHash } from 'node:crypto';
import { validateRuntimeSurface } from './runtime.mjs';

export const HOST_SURFACES = Object.freeze(['claude-code', 'claude-desktop', 'codex-cli', 'codex-app']);
export const APP_CAPABILITIES = Object.freeze([
  'list-projects', 'create-thread-local', 'fork-thread-same-directory',
  'send-message-to-thread', 'structured-process-stdin',
]);
export const STRUCTURED_STDIN_MODES = Object.freeze(['pipe-open-noecho', 'pty-raw-noecho']);
const SOURCES = Object.freeze({
  'claude-code': ['claude-cli-entrypoint'],
  'claude-desktop': ['claude-desktop-local-agent'],
  'codex-cli': ['codex-cli-host'],
  'codex-app': ['codex-app-host-context', 'codex-app-tool-provenance'],
});
const CWD_SOURCES = Object.freeze({
  'claude-code': ['direct-cli-cwd'], 'claude-desktop': ['desktop-code-context'],
  'codex-cli': ['direct-cli-cwd'], 'codex-app': ['app-task-context'],
});

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');

export function hostSurfaceFactsDigest(observation) {
  if (observation === null) return 'NONE';
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new Error('HOST_SURFACE_DIGEST_INVALID');
  }
  return sha256(JSON.stringify({
    kind: observation.kind,
    source: observation.source,
    capabilities: [...observation.capabilities].sort(),
    structured_stdin_mode: observation.structured_stdin_mode,
    host_task_cwd: observation.host_task_cwd,
    host_task_cwd_source: observation.host_task_cwd_source,
    kernel_cwd_at_observation: observation.kernel_cwd_at_observation,
  }));
}

export function appHostTaskCwdDigest(observation, targetCwd) {
  if (!observation || typeof targetCwd !== 'string') {
    throw new Error('APP_ROUTE_DIGEST_INVALID');
  }
  return sha256(JSON.stringify({ kind: observation.kind, source: observation.source,
    host_task_cwd_source: observation.host_task_cwd_source,
    canonical_cwd: targetCwd }));
}

export function validateOpaqueId(value, { label = 'opaque-id', maxBytes = 512 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes
      || Buffer.from(value, 'utf8').toString('utf8') !== value
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`OPAQUE_ID_INVALID: ${label}`);
  }
  return value;
}

const validHostPath = value => typeof value === 'string' && value.length > 0
  && Buffer.byteLength(value, 'utf8') <= 4096
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

const RAW_HOST_OBSERVATION_KEYS = Object.freeze([
  'kind', 'source', 'capabilities', 'structured_stdin_mode', 'host_task_cwd',
  'host_task_cwd_source',
]);

const rawObservationFailure = () => {
  throw new Error('HOST_OBSERVATION_INPUT_INVALID');
};

function exactCapabilityArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > APP_CAPABILITIES.length
      || Object.getOwnPropertySymbols(value).length !== 0) rawObservationFailure();
  const names = Object.getOwnPropertyNames(value);
  const expected = [...Array(value.length).keys()].map(String);
  if (names.length !== expected.length + 1 || names.at(-1) !== 'length'
      || !expected.every((key, index) => names[index] === key)) rawObservationFailure();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || length.enumerable || !Object.hasOwn(length, 'value')
      || length.value !== value.length) rawObservationFailure();
  return expected.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')
        || typeof descriptor.value !== 'string') rawObservationFailure();
    return descriptor.value;
  });
}

export function exactRawHostObservation(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
        || Object.getOwnPropertySymbols(input).length !== 0
        || Object.getOwnPropertyNames(input).join('\0') !== RAW_HOST_OBSERVATION_KEYS.join('\0')) {
      rawObservationFailure();
    }
    const descriptors = Object.fromEntries(RAW_HOST_OBSERVATION_KEYS.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        rawObservationFailure();
      }
      return [key, descriptor];
    }));
    return {
      kind: descriptors.kind.value,
      source: descriptors.source.value,
      capabilities: exactCapabilityArray(descriptors.capabilities.value),
      structured_stdin_mode: descriptors.structured_stdin_mode.value,
      host_task_cwd: descriptors.host_task_cwd.value,
      host_task_cwd_source: descriptors.host_task_cwd_source.value,
    };
  } catch (error) {
    if (error?.message === 'HOST_OBSERVATION_INPUT_INVALID') throw error;
    return rawObservationFailure();
  }
}

export function sameNativeDirectory(left, right, deps) {
  try {
    const leftReal = deps.realpath(left);
    const rightReal = deps.realpath(right);
    const leftStat = deps.stat(leftReal);
    const rightStat = deps.stat(rightReal);
    if (deps.platform !== 'win32' && leftReal !== rightReal) return false;
    return Boolean(leftStat && rightStat && deps.sameFile(leftStat, rightStat));
  } catch {
    return false;
  }
}

export function normalizeHostObservation(input, deps) {
  const fail = detail => { throw new Error(`HOST_SURFACE_INVALID: ${detail}`); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('object required');
  const kind = input.kind ?? null;
  const capabilities = input.capabilities ?? [];
  if (!validHostPath(deps.kernelCwd)) fail('kernel cwd');
  validateRuntimeSurface(input.runtime, kind);
  if (kind === null) {
    if (input.source != null || input.host_task_cwd != null || input.host_task_cwd_source != null
        || input.structured_stdin_mode != null || capabilities.length !== 0) fail('null surface must be empty');
    return { kind: null, source: null, capabilities: [], structured_stdin_mode: null,
      host_task_cwd: null, host_task_cwd_source: null,
      kernel_cwd_at_observation: deps.realpath(deps.kernelCwd), observed_at: input.observed_at ?? null };
  }
  if (!HOST_SURFACES.includes(kind)) fail('surface');
  if (!SOURCES[kind].includes(input.source)) fail('source correlation');
  if (!Array.isArray(capabilities) || new Set(capabilities).size !== capabilities.length
      || capabilities.some(value => !APP_CAPABILITIES.includes(value))) fail('capabilities');
  const sorted = [...capabilities].sort();
  const hasStructured = sorted.includes('structured-process-stdin');
  if (hasStructured
    ? !STRUCTURED_STDIN_MODES.includes(input.structured_stdin_mode)
    : input.structured_stdin_mode !== null) fail('stdin mode correlation');
  const manualSurface = !hasStructured
    && input.host_task_cwd == null && input.host_task_cwd_source == null;
  if (!manualSurface) {
    if (!CWD_SOURCES[kind].includes(input.host_task_cwd_source)) fail('cwd source correlation');
    if (!validHostPath(input.host_task_cwd)
        || !sameNativeDirectory(input.host_task_cwd, deps.kernelCwd, deps)) fail('cwd identity');
  }
  return {
    kind, source: input.source, capabilities: sorted,
    structured_stdin_mode: hasStructured ? input.structured_stdin_mode : null,
    host_task_cwd: manualSurface ? null : deps.realpath(input.host_task_cwd),
    host_task_cwd_source: manualSurface ? null : input.host_task_cwd_source,
    kernel_cwd_at_observation: deps.realpath(deps.kernelCwd), observed_at: input.observed_at ?? null,
  };
}
