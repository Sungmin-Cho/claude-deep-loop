import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
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

function nativeDirectoryIdentity(left, right, deps) {
  try {
    const leftReal = deps.realpath(left);
    const rightReal = deps.realpath(right);
    const leftStat = deps.stat(leftReal);
    const rightStat = deps.stat(rightReal);
    if (deps.platform !== 'win32' && leftReal !== rightReal) return null;
    if (!leftStat || !rightStat || !deps.sameFile(leftStat, rightStat)) return null;
    return { leftReal, rightReal };
  } catch {
    return null;
  }
}

export function sameNativeDirectory(left, right, deps) {
  return nativeDirectoryIdentity(left, right, deps) !== null;
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
  let nativeCwd = null;
  if (!manualSurface) {
    if (!CWD_SOURCES[kind].includes(input.host_task_cwd_source)) fail('cwd source correlation');
    if (!validHostPath(input.host_task_cwd)) fail('cwd identity');
    nativeCwd = nativeDirectoryIdentity(input.host_task_cwd, deps.kernelCwd, deps);
    if (nativeCwd === null) fail('cwd identity');
  }
  return {
    kind, source: input.source, capabilities: sorted,
    structured_stdin_mode: hasStructured ? input.structured_stdin_mode : null,
    host_task_cwd: nativeCwd?.leftReal ?? null,
    host_task_cwd_source: manualSurface ? null : input.host_task_cwd_source,
    kernel_cwd_at_observation: nativeCwd?.rightReal ?? deps.realpath(deps.kernelCwd),
    observed_at: input.observed_at ?? null,
  };
}

const manualRoute = (reason, targetCwd = null) => ({
  kind: 'manual', reason, targetCwd, projectId: null, workstreamId: null, contextMode: null,
});

export function classifyProjectTaskDirectory(root, cwd, deps) {
  try {
    const canonicalRoot = deps.realpath(root);
    const canonicalCwd = deps.realpath(cwd);
    const sameCanonicalPath = deps.platform === 'win32'
      ? canonicalRoot.toLowerCase() === canonicalCwd.toLowerCase()
      : canonicalRoot === canonicalCwd;
    if (sameCanonicalPath && sameNativeDirectory(canonicalRoot, canonicalCwd, deps)) {
      return { kind: 'root', cwd: canonicalRoot };
    }
    const pathApi = deps.platform === 'win32' ? win32 : posix;
    const relative = pathApi.relative(canonicalRoot, canonicalCwd).replace(/\\/g, '/');
    const comparable = deps.platform === 'win32' ? relative.toLowerCase() : relative;
    if (!/^(?:\.claude\/worktrees|\.worktrees)\/[^/]+$/.test(comparable)) return null;
    const rebuilt = pathApi.resolve(canonicalRoot, ...relative.split('/'));
    if (!sameNativeDirectory(rebuilt, canonicalCwd, deps)) return null;
    return { kind: 'worktree', cwd: canonicalCwd };
  } catch {
    return null;
  }
}

export function normalizeProjectList(input, { maxEntries = 256 } = {}) {
  if (!Array.isArray(input) || !Number.isSafeInteger(maxEntries) || maxEntries < 1
      || input.length > maxEntries) throw new Error('PROJECT_LIST_INVALID');
  return input.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('PROJECT_LIST_INVALID');
    if (typeof row.path !== 'string' || row.path.length === 0
        || Buffer.byteLength(row.path, 'utf8') > 4096
        || /[\u0000-\u001f\u007f-\u009f]/u.test(row.path)) throw new Error('PROJECT_LIST_INVALID');
    return { projectId: validateOpaqueId(row.projectId, { label: 'project-id' }),
      projectKind: row.projectKind, path: row.path };
  });
}

export function selectAppContinuationRoute(input, deps) {
  let target;
  try { target = deps.realpath(input.currentHostTaskCwd); }
  catch { return manualRoute('cwd-identity-mismatch'); }
  if (!sameNativeDirectory(input.recordedHostTaskCwd, target, deps)
      || !sameNativeDirectory(input.kernelCwd, target, deps)) return manualRoute('cwd-identity-mismatch', target);
  const classifiedTarget = classifyProjectTaskDirectory(input.root, target, deps);
  if (classifiedTarget?.kind === 'root') {
    const required = ['list-projects', 'create-thread-local', 'structured-process-stdin'];
    if (!required.every(value => input.capabilities.includes(value))) return manualRoute('create-capability-incomplete', target);
    let projects;
    try { projects = normalizeProjectList(input.projects); }
    catch { return manualRoute('project-list-invalid', target); }
    let matches;
    try {
      matches = projects.filter(project => project.projectKind === 'local'
        && deps.exists(project.path) && sameNativeDirectory(project.path, classifiedTarget.cwd, deps));
    } catch { return manualRoute('project-query-failed', target); }
    if (matches.length !== 1) return manualRoute(matches.length === 0 ? 'project-match-missing' : 'project-match-ambiguous', target);
    return { kind: 'create', reason: 'exact-project-root', targetCwd: classifiedTarget.cwd,
      projectId: matches[0].projectId, workstreamId: null, contextMode: 'fresh' };
  }
  const required = ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin'];
  if (!required.every(value => input.capabilities.includes(value))) return manualRoute('fork-capability-incomplete', target);
  const pathApi = deps.platform === 'win32' ? win32 : posix;
  const active = new Set(input.activeWorkstreams ?? []);
  let canonicalRoot;
  try { canonicalRoot = deps.realpath(input.root); }
  catch { return manualRoute('workstream-query-failed', target); }
  const matches = (input.workstreams ?? []).flatMap(workstream => {
    if (!active.has(workstream.id) || !['in_progress', 'in_review'].includes(workstream.status)
        || typeof workstream.worktree !== 'string') return [];
    const normalized = workstream.worktree.replace(/\\/g, '/');
    const comparable = deps.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (!/^(?:\.claude\/worktrees|\.worktrees)\/[^/]+$/.test(comparable)) return [];
    const absolute = pathApi.resolve(input.root, ...normalized.split('/'));
    try { if (!deps.exists(absolute)) return []; }
    catch { return []; }
    let canonicalWorktree;
    try { canonicalWorktree = deps.realpath(absolute); } catch { return []; }
    const canonicalRelative = pathApi.relative(canonicalRoot, canonicalWorktree).replace(/\\/g, '/');
    const sameRelative = deps.platform === 'win32'
      ? canonicalRelative.toLowerCase() === normalized.toLowerCase()
      : canonicalRelative === normalized;
    if (!sameRelative || !sameNativeDirectory(canonicalWorktree, target, deps)) return [];
    return [{ workstream, canonicalWorktree }];
  });
  if (matches.length !== 1) return manualRoute(matches.length === 0 ? 'workstream-match-missing' : 'workstream-match-ambiguous', target);
  return { kind: 'fork', reason: 'exact-active-worktree', targetCwd: matches[0].canonicalWorktree,
    projectId: null, workstreamId: matches[0].workstream.id, contextMode: 'inherited-completed-history' };
}
