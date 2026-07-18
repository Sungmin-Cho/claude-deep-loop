import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exactRawHostObservation,
  appHostTaskCwdDigest,
  hostSurfaceFactsDigest,
  normalizeHostObservation,
  sameNativeDirectory,
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
