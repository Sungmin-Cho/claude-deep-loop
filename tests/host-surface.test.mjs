import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exactRawHostObservation,
  appHostTaskCwdDigest,
  classifyProjectTaskDirectory,
  hostSurfaceFactsDigest,
  isManualEnumHostProfile,
  normalizeHostObservation,
  normalizeProjectList,
  sameNativeDirectory,
  selectAppContinuationRoute,
  validateOpaqueId,
} from '../scripts/lib/host-surface.mjs';

test('positive Codex App observation requires exact native cwd identity', () => {
  const identities = new Map([
    ['/repo', { dev: 7, ino: 11 }],
    ['/other', { dev: 7, ino: 12 }],
  ]);
  const deps = {
    platform: 'linux', kernelCwd: '/repo',
    realpath: value => value,
    stat: value => identities.get(value),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino,
  };
  const observation = normalizeHostObservation({
    runtime: 'codex', kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['structured-process-stdin', 'create-thread-local', 'list-projects'],
    structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: '/repo',
    host_task_cwd_source: 'app-task-context', observed_at: '2026-07-13T00:00:00.000Z',
  }, deps);
  assert.deepEqual(observation.capabilities, [
    'create-thread-local', 'list-projects', 'structured-process-stdin',
  ]);
  assert.equal(observation.kernel_cwd_at_observation, '/repo');
  assert.equal(sameNativeDirectory('/repo', '/repo', deps), true);
  assert.equal(sameNativeDirectory('/repo', '/other', deps), false);
});

test('observation returns the exact canonical paths used for native identity', () => {
  const calls = new Map();
  const deps = {
    platform: 'linux', kernelCwd: '/kernel',
    realpath: value => {
      const count = (calls.get(value) ?? 0) + 1;
      calls.set(value, count);
      return count === 1 ? '/canonical/repo' : `/retargeted${value}`;
    },
    stat: value => {
      assert.equal(value, '/canonical/repo');
      return { dev: 7, ino: 11 };
    },
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino,
  };
  const observation = normalizeHostObservation({
    runtime: 'codex', kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['structured-process-stdin'], structured_stdin_mode: 'pty-raw-noecho',
    host_task_cwd: '/task', host_task_cwd_source: 'app-task-context', observed_at: null,
  }, deps);
  assert.equal(observation.host_task_cwd, '/canonical/repo');
  assert.equal(observation.kernel_cwd_at_observation, '/canonical/repo');
  assert.deepEqual([...calls], [['/task', 1], ['/kernel', 1]]);
});

test('raw host observation is exactly six own data keys with one dense plain capability array', () => {
  const raw = { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['structured-process-stdin'], structured_stdin_mode: 'pty-raw-noecho',
    host_task_cwd: '/repo', host_task_cwd_source: 'app-task-context' };
  assert.deepEqual(exactRawHostObservation(raw), raw);
  for (const extra of ['runtime', 'kernel_cwd_at_observation', 'observed_generation', 'observed_at',
    'projectId', 'threadId', 'clientThreadId']) {
    assert.throws(() => exactRawHostObservation({ ...raw, [extra]: 'forbidden' }),
      /HOST_OBSERVATION_INPUT_INVALID/);
  }
  const accessor = { ...raw };
  Object.defineProperty(accessor, 'kind', { enumerable: true, get: () => 'codex-app' });
  const symbol = { ...raw, [Symbol('threadId')]: 'forbidden' };
  const custom = Object.assign(Object.create({ inherited: true }), raw);
  const sparse = { ...raw, capabilities: new Array(1) };
  const keyed = { ...raw, capabilities: ['structured-process-stdin'] };
  keyed.capabilities.clientThreadId = 'forbidden';
  for (const value of [accessor, symbol, custom, sparse, keyed]) {
    assert.throws(() => exactRawHostObservation(value), /HOST_OBSERVATION_INPUT_INVALID/);
  }
});

test('opaque IDs preserve bytes and reject control characters', () => {
  assert.equal(validateOpaqueId(' trim-is-data '), ' trim-is-data ');
  assert.throws(() => validateOpaqueId('bad\u0000id'), /OPAQUE_ID_INVALID/);
  assert.throws(() => validateOpaqueId('\ud800'), /OPAQUE_ID_INVALID/);
  assert.throws(() => validateOpaqueId('\udc00'), /OPAQUE_ID_INVALID/);
  assert.throws(() => validateOpaqueId('x'.repeat(513)), /OPAQUE_ID_INVALID/);
});

test('kernel digests bind immutable surface and route facts but exclude attestation clocks', () => {
  const surface = { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
    structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: '/repo',
    host_task_cwd_source: 'app-task-context', kernel_cwd_at_observation: '/repo',
    observed_generation: 1, observed_at: '2026-07-13T00:00:00.000Z' };
  const digest = hostSurfaceFactsDigest(surface);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(hostSurfaceFactsDigest({ ...surface, observed_generation: 99,
    observed_at: '2026-07-13T00:00:09.000Z' }), digest);
  assert.equal(hostSurfaceFactsDigest({ ...surface,
    capabilities: [...surface.capabilities].reverse() }), digest,
  'capability order is canonical rather than a second fact');
  for (const changed of [
    { ...surface, source: 'codex-app-host-context' },
    { ...surface, capabilities: ['structured-process-stdin'] },
    { ...surface, host_task_cwd: '/other' },
    { ...surface, kernel_cwd_at_observation: '/other' },
  ]) assert.notEqual(hostSurfaceFactsDigest(changed), digest);
  assert.equal(hostSurfaceFactsDigest(null), 'NONE');
  assert.notEqual(appHostTaskCwdDigest(surface, '/repo'),
    appHostTaskCwdDigest(surface, '/other'));
});

test('runtime and surface correlation fails closed', () => {
  const deps = { platform: 'linux', kernelCwd: '/repo', realpath: value => value,
    stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true };
  assert.throws(() => normalizeHostObservation({
    runtime: 'claude', kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: [], structured_stdin_mode: null, host_task_cwd: null,
    host_task_cwd_source: null, observed_at: '2026-07-13T00:00:00.000Z',
  }, deps), /HOST_SURFACE_INVALID/);
  assert.throws(() => normalizeHostObservation({ runtime: 'invalid', kind: null,
    source: null, capabilities: [], structured_stdin_mode: null, host_task_cwd: null,
    host_task_cwd_source: null, observed_at: null }, deps), /INVALID_RUNTIME/,
  'null surface does not bypass runtime validation');
});

test('surface correlation matrix rejects every unsafe combination', () => {
  const deps = { platform: 'linux', kernelCwd: '/repo', realpath: value => value,
    stat: value => ({ dev: 1, ino: value === '/repo' ? 1 : 2 }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  const base = { runtime: 'codex', kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['structured-process-stdin'], structured_stdin_mode: 'pty-raw-noecho',
    host_task_cwd: '/repo', host_task_cwd_source: 'app-task-context', observed_at: null };
  const invalid = [
    { ...base, runtime: 'claude' },
    { ...base, source: 'codex-cli-host' },
    { ...base, host_task_cwd_source: 'direct-cli-cwd' },
    { ...base, capabilities: ['unknown'] },
    { ...base, capabilities: ['structured-process-stdin', 'structured-process-stdin'] },
    { ...base, structured_stdin_mode: null },
    { ...base, capabilities: [], structured_stdin_mode: 'pty-raw-noecho' },
    { ...base, capabilities: [], structured_stdin_mode: 'arbitrary-non-null' },
    { ...base, host_task_cwd: '/other' },
    { ...base, host_task_cwd: '/' + 'x'.repeat(4097) },
    { ...base, host_task_cwd: '/repo\u0000evil' },
  ];
  for (const value of invalid) assert.throws(() => normalizeHostObservation(value, deps), /HOST_SURFACE_INVALID/);
  assert.deepEqual(normalizeHostObservation({ runtime: 'codex', kind: 'codex-app',
    source: 'codex-app-tool-provenance', capabilities: [], structured_stdin_mode: null,
    host_task_cwd: null, host_task_cwd_source: null, observed_at: null }, deps), {
    kind: 'codex-app', source: 'codex-app-tool-provenance', capabilities: [],
    structured_stdin_mode: null, host_task_cwd: null, host_task_cwd_source: null,
    kernel_cwd_at_observation: '/repo', observed_at: null,
  });
});

test('normalized host capability arrays are dense plain data arrays', () => {
  const deps = { platform: 'linux', kernelCwd: '/repo', realpath: value => value,
    stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true };
  const input = { runtime: 'codex', kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: new Array(1), structured_stdin_mode: null,
    host_task_cwd: '/repo', host_task_cwd_source: 'app-task-context', observed_at: null };
  assert.throws(() => normalizeHostObservation(input, deps), /HOST_SURFACE_INVALID/);
});

test('identity is stat-backed on Windows candidates and fails closed for UNC uncertainty', () => {
  const windows = { platform: 'win32', realpath: value => value.toLowerCase(),
    stat: value => ({ volume: 'v', file: value === 'c:\\repo' ? 1 : 2 }),
    sameFile: (left, right) => left.volume === right.volume && left.file === right.file };
  assert.equal(sameNativeDirectory('C:\\Repo', 'c:\\repo', windows), true);
  const uncertainUnc = { ...windows, realpath: () => { throw new Error('unavailable'); } };
  assert.equal(sameNativeDirectory('\\\\server\\share', '\\\\server\\share', uncertainUnc), false);
});

test('POSIX identity requires canonical-byte equality as well as same filesystem identity', () => {
  const sameInode = { dev: 9, ino: 42 };
  const posix = { platform: 'linux', realpath: value => value,
    stat: () => sameInode, sameFile: () => true };
  assert.equal(sameNativeDirectory('/repo', '/repo', posix), true);
  assert.equal(sameNativeDirectory('/repo', '/hard-link-alias', posix), false);
});

test('native identity retains adjacent filesystem identifiers above Number safe range', () => {
  const identities = new Map([
    ['/repo', { dev: 9n, ino: 9_007_199_254_740_992n }],
    ['/other', { dev: 9n, ino: 9_007_199_254_740_993n }],
  ]);
  const exact = { platform: 'win32', realpath: value => value,
    stat: value => identities.get(value),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  assert.equal(sameNativeDirectory('/repo', '/repo', exact), true);
  assert.equal(sameNativeDirectory('/repo', '/other', exact), false,
    'adjacent BigInt identities must not collapse through Number rounding');
});

test('manual surface correlation permits only the raw-free enum-only profile', () => {
  const deps = { platform: 'linux', kernelCwd: '/repo', realpath: value => value,
    stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true };
  const profiles = [
    ['claude', 'claude-code', 'claude-cli-entrypoint'],
    ['claude', 'claude-desktop', 'claude-desktop-local-agent'],
    ['codex', 'codex-cli', 'codex-cli-host'],
    ['codex', 'codex-app', 'codex-app-tool-provenance'],
  ];
  for (const [runtime, kind, source] of profiles) {
    const observation = normalizeHostObservation({ runtime, kind, source, capabilities: [],
      structured_stdin_mode: null, host_task_cwd: null, host_task_cwd_source: null,
      observed_at: null }, deps);
    assert.equal(observation.kind, kind);
    assert.equal(observation.host_task_cwd, null);
  }
  assert.throws(() => normalizeHostObservation({ runtime: 'claude', kind: 'claude-code',
    source: 'claude-cli-entrypoint', capabilities: [], structured_stdin_mode: null,
    host_task_cwd: '/repo', host_task_cwd_source: null, observed_at: null }, deps),
  /HOST_SURFACE_INVALID/);
});

test('project task directory classifier distinguishes root worktree and escape', () => {
  const root = '/repo';
  const worktree = '/repo/.worktrees/feature';
  const deps = { platform: 'linux', realpath: value => value,
    stat: value => ({ dev: 1, ino: value === root ? 1 : value === worktree ? 2 : 3 }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  assert.deepEqual(classifyProjectTaskDirectory(root, root, deps),
    { kind: 'root', cwd: root });
  assert.deepEqual(classifyProjectTaskDirectory(root, worktree, deps),
    { kind: 'worktree', cwd: worktree });
  assert.equal(classifyProjectTaskDirectory(root, '/repo/.worktrees/feature/child', deps), null);
  assert.equal(classifyProjectTaskDirectory(root, '/outside', deps), null);
});

test('root create is exact and duplicate local projects fail closed', () => {
  const deps = { platform: 'linux', exists: () => true, realpath: value => value,
    stat: value => ({ dev: 1, ino: value === '/repo' ? 1 : 2 }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  const base = {
    root: '/repo', recordedHostTaskCwd: '/repo', currentHostTaskCwd: '/repo', kernelCwd: '/repo',
    capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
    workstreams: [], activeWorkstreams: [],
  };
  const one = selectAppContinuationRoute({ ...base,
    projects: [{ projectId: ' p$`\\id ', projectKind: 'local', path: '/repo', ignored: 'drop' }] }, deps);
  assert.deepEqual(one, { kind: 'create', reason: 'exact-project-root', targetCwd: '/repo',
    projectId: ' p$`\\id ', workstreamId: null, contextMode: 'fresh' });
  const two = selectAppContinuationRoute({ ...base, projects: [
    { projectId: 'one', projectKind: 'local', path: '/repo' },
    { projectId: 'two', projectKind: 'local', path: '/repo' },
  ] }, deps);
  assert.deepEqual(two, { kind: 'manual', reason: 'project-match-ambiguous', targetCwd: '/repo',
    projectId: null, workstreamId: null, contextMode: null });
});

test('root project and capability matrix fails closed', () => {
  const deps = { platform: 'linux', exists: value => value === '/repo', realpath: value => value,
    stat: value => ({ dev: 1, ino: value === '/repo' ? 1 : 9 }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  const base = { root: '/repo', recordedHostTaskCwd: '/repo', currentHostTaskCwd: '/repo', kernelCwd: '/repo',
    capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
    workstreams: [], activeWorkstreams: [] };
  for (const [projects, reason] of [
    [[], 'project-match-missing'],
    [[{ projectId: 'remote', projectKind: 'remote', path: '/repo' }], 'project-match-missing'],
    [[{ projectId: 'worktree', projectKind: 'worktree', path: '/repo' }], 'project-match-missing'],
    [[{ projectId: 'missing-path', projectKind: 'local' }], 'project-list-invalid'],
    [[{ projectId: 'large', projectKind: 'local', path: '/' + 'x'.repeat(4097) }], 'project-list-invalid'],
    [[{ projectId: 'nul', projectKind: 'local', path: '/repo\u0000evil' }], 'project-list-invalid'],
  ]) assert.equal(selectAppContinuationRoute({ ...base, projects }, deps).reason, reason);
  assert.equal(selectAppContinuationRoute({ ...base, projects: [{ projectId: 'p', projectKind: 'local', path: '/repo' }],
    capabilities: ['list-projects', 'create-thread-local'] }, deps).reason, 'create-capability-incomplete');
  assert.equal(selectAppContinuationRoute({ ...base,
    projects: [{ projectId: 'p', projectKind: 'local', path: '/repo' }] },
  { ...deps, exists: () => { throw new Error('host failure'); } }).reason, 'project-query-failed');
});

test('fork accepts one canonical conventional active worktree and rejects escape or multiplicity', () => {
  const target = '/repo/.worktrees/feature';
  const identities = new Map([['/repo', 1], [target, 2], ['/outside', 3]]);
  const deps = { platform: 'linux', exists: value => identities.has(value)
      || value === '/repo/.worktrees/escape',
    realpath: value => value === '/repo/.worktrees/escape' ? '/outside' : value,
    stat: value => ({ dev: 1, ino: identities.get(value) }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  const workstream = { id: 'WS1', status: 'in_progress', worktree: '.worktrees/feature' };
  const base = { root: '/repo', recordedHostTaskCwd: target, currentHostTaskCwd: target, kernelCwd: target,
    capabilities: ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin'],
    projects: [], workstreams: [workstream], activeWorkstreams: ['WS1'] };
  assert.deepEqual(selectAppContinuationRoute(base, deps), { kind: 'fork', reason: 'exact-active-worktree',
    targetCwd: target, projectId: null, workstreamId: 'WS1', contextMode: 'inherited-completed-history' });
  assert.equal(selectAppContinuationRoute({ ...base, activeWorkstreams: [] }, deps).reason, 'workstream-match-missing');
  assert.equal(selectAppContinuationRoute({ ...base, workstreams: [workstream, { ...workstream, id: 'WS2' }],
    activeWorkstreams: ['WS1', 'WS2'] }, deps).reason, 'workstream-match-ambiguous');
  const escapeTarget = '/outside';
  assert.equal(selectAppContinuationRoute({ ...base, recordedHostTaskCwd: escapeTarget,
    currentHostTaskCwd: escapeTarget, kernelCwd: escapeTarget,
    workstreams: [{ ...workstream, worktree: '.worktrees/escape' }] }, deps).reason, 'workstream-match-missing');
  assert.equal(selectAppContinuationRoute({ ...base,
    capabilities: ['fork-thread-same-directory', 'structured-process-stdin'] }, deps).reason, 'fork-capability-incomplete');
});

test('active workstream authority input is dense plain unique and opaque', () => {
  const target = '/repo/.worktrees/feature';
  const deps = { platform: 'linux', exists: () => true, realpath: value => value,
    stat: value => ({ dev: 1, ino: value === target ? 2 : 1 }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  const base = { root: '/repo', recordedHostTaskCwd: target,
    currentHostTaskCwd: target, kernelCwd: target,
    capabilities: ['fork-thread-same-directory', 'send-message-to-thread',
      'structured-process-stdin'], projects: [],
    workstreams: [{ id: 'WS1', status: 'in_progress', worktree: '.worktrees/feature' }] };
  const sparse = new Array(1);
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => 'WS1' });
  accessor.length = 1;
  const symbol = ['WS1'];
  symbol[Symbol('authority')] = true;
  const extra = ['WS1'];
  extra.authority = true;
  const exotic = new (class ActiveWorkstreams extends Array {})('WS1');
  for (const [label, activeWorkstreams] of [
    ['duplicate', ['WS1', 'WS1']],
    ['nonarray', { 0: 'WS1', length: 1 }],
    ['sparse', sparse],
    ['empty ID', ['']],
    ['control ID', ['WS1\u0000forged']],
    ['oversized ID', ['x'.repeat(513)]],
    ['accessor', accessor],
    ['symbol', symbol],
    ['extra key', extra],
    ['exotic prototype', exotic],
  ]) {
    const result = selectAppContinuationRoute({ ...base, activeWorkstreams }, deps);
    assert.deepEqual(result, { kind: 'manual', reason: 'workstream-query-failed',
      targetCwd: target, projectId: null, workstreamId: null, contextMode: null }, label);
  }
});

test('active workstream authority rejects an Array proxy before executing traps', () => {
  const target = '/repo/.worktrees/feature';
  const deps = { platform: 'linux', exists: () => true, realpath: value => value,
    stat: value => ({ dev: 1, ino: value === target ? 2 : 1 }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  let trapCount = 0;
  const activeWorkstreams = new Proxy(['WS1', 'WS1'], {
    get(backing, property, receiver) {
      trapCount += 1;
      return property === 'length' ? 1 : Reflect.get(backing, property, receiver);
    },
  });
  const result = selectAppContinuationRoute({ root: '/repo', recordedHostTaskCwd: target,
    currentHostTaskCwd: target, kernelCwd: target,
    capabilities: ['fork-thread-same-directory', 'send-message-to-thread',
      'structured-process-stdin'], projects: [], activeWorkstreams,
    workstreams: [{ id: 'WS1', status: 'in_progress', worktree: '.worktrees/feature' }] }, deps);
  assert.equal(result.kind, 'manual');
  assert.equal(result.reason, 'workstream-query-failed');
  assert.equal(trapCount, 0, 'proxy rejection must precede every reflective trap');
});

test('manual enum profile reads only exact own data descriptors', () => {
  const values = { kind: 'codex-app', source: 'codex-app-tool-provenance', capabilities: [] };
  for (const key of Object.keys(values)) {
    let getterCount = 0;
    const profile = { ...values };
    Object.defineProperty(profile, key, { enumerable: true, get() {
      getterCount += 1; return values[key];
    } });
    assert.equal(isManualEnumHostProfile(profile, 'codex'), false, key);
    assert.equal(getterCount, 0, `${key} accessor must not execute`);
  }
  assert.equal(isManualEnumHostProfile({ ...values, extra: true }, 'codex'), false);
  const symbol = { ...values };
  symbol[Symbol('authority')] = true;
  assert.equal(isManualEnumHostProfile(symbol, 'codex'), false);
});

test('Windows worktree containment tolerates path case drift but still requires file identity', () => {
  const target = 'c:\\repo\\.worktrees\\feature';
  const deps = { platform: 'win32', exists: () => true,
    realpath: value => value.toLowerCase(),
    stat: value => ({ volume: 'v', file: value.toLowerCase() === target ? 2 : 1 }),
    sameFile: (left, right) => left.volume === right.volume && left.file === right.file };
  const input = { root: 'C:\\Repo', recordedHostTaskCwd: target,
    currentHostTaskCwd: target, kernelCwd: target,
    capabilities: ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin'],
    projects: [], activeWorkstreams: ['WS1'],
    workstreams: [{ id: 'WS1', status: 'in_review', worktree: '.worktrees/Feature' }] };
  assert.deepEqual(selectAppContinuationRoute(input, deps), {
    kind: 'fork', reason: 'exact-active-worktree', targetCwd: target,
    projectId: null, workstreamId: 'WS1', contextMode: 'inherited-completed-history',
  });
  assert.equal(selectAppContinuationRoute({ ...input,
    currentHostTaskCwd: 'c:\\repo\\.worktrees\\other',
    recordedHostTaskCwd: 'c:\\repo\\.worktrees\\other',
    kernelCwd: 'c:\\repo\\.worktrees\\other' }, deps).reason, 'workstream-match-missing');
});

test('Windows conventional directory casing is accepted for fork routes', () => {
  for (const [worktree, target] of [
    ['.WORKTREES/Feature', 'c:\\repo\\.worktrees\\feature'],
    ['.CLAUDE/WORKTREES/Feature', 'c:\\repo\\.claude\\worktrees\\feature'],
  ]) {
    const deps = { platform: 'win32', exists: () => true,
      realpath: value => value.toLowerCase(),
      stat: value => ({ volume: 'v', file: value.toLowerCase() === target ? 2 : 1 }),
      sameFile: (left, right) => left.volume === right.volume && left.file === right.file };
    const input = { root: 'C:\\Repo', recordedHostTaskCwd: target,
      currentHostTaskCwd: target, kernelCwd: target,
      capabilities: ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin'],
      projects: [], activeWorkstreams: ['WS1'],
      workstreams: [{ id: 'WS1', status: 'in_progress', worktree }] };
    assert.deepEqual(selectAppContinuationRoute(input, deps), {
      kind: 'fork', reason: 'exact-active-worktree', targetCwd: target,
      projectId: null, workstreamId: 'WS1', contextMode: 'inherited-completed-history',
    });
  }
});

test('canonical create route reuses the classified root without resolving the input root again', () => {
  let rootResolutions = 0;
  const deps = { platform: 'linux', exists: () => true,
    realpath: value => {
      if (value !== '/repo-link') return value;
      rootResolutions += 1;
      if (rootResolutions > 1) throw new Error('root retargeted');
      return '/repo';
    },
    stat: () => ({ dev: 1, ino: 1 }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
  const route = selectAppContinuationRoute({
    root: '/repo-link', recordedHostTaskCwd: '/repo', currentHostTaskCwd: '/repo', kernelCwd: '/repo',
    capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
    projects: [{ projectId: 'project', projectKind: 'local', path: '/repo' }],
    workstreams: [], activeWorkstreams: [],
  }, deps);
  assert.deepEqual(route, { kind: 'create', reason: 'exact-project-root', targetCwd: '/repo',
    projectId: 'project', workstreamId: null, contextMode: 'fresh' });
  assert.equal(rootResolutions, 1);
});

test('project list normalization bounds entries and strips fields', () => {
  const normalized = normalizeProjectList([
    { projectId: ' opaque ', projectKind: 'local', path: '/repo', ignored: 'drop' },
  ]);
  assert.deepEqual(normalized, [
    { projectId: ' opaque ', projectKind: 'local', path: '/repo' },
  ]);
  assert.deepEqual(Object.keys(normalized[0]), ['projectId', 'projectKind', 'path']);
  assert.throws(() => normalizeProjectList(Array.from({ length: 257 }, (_, index) => ({
    projectId: `p${index}`, projectKind: 'local', path: `/repo/${index}`,
  }))), /PROJECT_LIST_INVALID/);
  for (const maxEntries of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeProjectList([], { maxEntries }), /PROJECT_LIST_INVALID/);
  }
});
