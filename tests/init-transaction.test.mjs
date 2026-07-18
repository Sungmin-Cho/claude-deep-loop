import {
  existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRealpath, createDirectoryJunction, createFileSymlinkOrSkip,
  fixtureDir as rawFixtureDir } from './helpers/fs-fixtures.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { buildInitialLoop, resolveInitialReview } from '../scripts/lib/initrun.mjs';
import { hostSurfaceFactsDigest } from '../scripts/lib/host-surface.mjs';
import {
  buildCanonicalGenesis,
  genesisClockFromAttempt,
  hostObservationDigest,
  initializationRequestDigest,
  INIT_LOCK_CANDIDATE_TTL_MS,
  INIT_LOCK_CHAIN_MAX,
  normalizeInitializationRequest,
  preflightInitialization,
  prepareInitialization,
  statusInitialization,
  withInitLock,
} from '../scripts/lib/init-transaction.mjs';
import { verifyHeadLines, verifyLines } from '../scripts/lib/integrity.mjs';

const fixtureDir = (prefix = 'dl-init-') => canonicalRealpath(rawFixtureDir(prefix));

function queryTree(root) {
  if (!existsSync(root)) return [];
  const visit = (path, relative = '') => readdirSync(path).sort().flatMap(name => {
    const absolute = join(path, name);
    const rel = relative ? relative + '/' + name : name;
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) return [{ path: rel, kind: 'dir' }, ...visit(absolute, rel)];
    return [{ path: rel, kind: stat.isFile() ? 'file' : 'other',
      bytes: stat.isFile() ? readFileSync(absolute).toString('base64') : null }];
  });
  return visit(root);
}

function put(root, relative, bytes) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function initOptions() {
  return { runtime: 'codex', goal: 'g', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: 'test' }, review: null,
    detected: {}, git: {}, sessionSpawn: {},
    consent: { mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null },
    observationDigest: 'NONE',
    enumProfile: { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] } };
}

function initDeps(root, overrides = {}) {
  return { canonicalRoot: () => root,
    resolveRouting: value => ({ protocol: value.protocol, recipe: value.recipe }),
    resolveReview: value => resolveInitialReview(value.review, value.detected),
    normalizePlugins: value => value,
    normalizeGit: value => ({ git: !!value.head, head: value.head ?? null,
      branch: value.branch ?? null, dirty: !!value.dirty }),
    normalizeSessionSpawn: value => value, kernelCwd: () => root,
    normalizeEnumProfile: value => ({ ...value, capabilities: [...value.capabilities].sort() }),
    normalizeObservation: value => ({ ...value, kernel_cwd_at_observation: root }),
    eligible: value => ({ eligible: value.kind === 'codex-app'
      && value.capabilities.includes('structured-process-stdin'),
      reason: value.kind === 'codex-app' ? 'capability-incomplete' : 'surface-ineligible',
      route: value.capabilities.includes('create-thread-local') ? { kind: 'create' } : null }),
    assertRoot: () => ({ ok: true }),
    buildLoop: buildInitialLoop, ulid: () => '01JAPPGEN00000000000000001', ...overrides };
}

function validGenesis(root, attempt, requestDigest, previousDigest) {
  const options = initOptions();
  const prepared = { ok: true, outcome: 'prepared', attempt_id: attempt,
    previous_current_digest: previousDigest, expected_request_digest: requestDigest,
    expected_observation_digest: 'NONE' };
  const { loop, genesisEvents } = buildCanonicalGenesis(root, {
    prepared, request: options, observation: null,
  }, initDeps(root));
  return { raw: JSON.stringify(loop),
    events: `${genesisEvents.map(event => JSON.stringify(event)).join('\n')}\n` };
}

const observation = { kind: 'codex-app', source: 'codex-app-tool-provenance',
  capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
  structured_stdin_mode: 'pty-raw-noecho',
  host_task_cwd: '/repo', host_task_cwd_source: 'app-task-context',
  kernel_cwd_at_observation: '/repo', observed_at: '2026-07-13T00:00:00.000Z' };
const options = { runtime: 'codex', goal: 'g', protocol: 'standalone',
  recipe: { id: 'r', name: 'r', reason: 'test' }, review: { reviewer: 'deep-review-loop' },
  model: null, effort: null, detected: { 'deep-review': true },
  git: { head: 'abc', branch: 'b', dirty: false }, sessionSpawn: { launcher: 'none', detected_at: 'clock' },
  consent: { mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null },
  observationDigest: hostObservationDigest(observation), enumProfile: null };
const deps = { canonicalRoot: () => '/repo', resolveRouting: value => ({ protocol: value.protocol, recipe: value.recipe }),
  resolveReview: value => resolveInitialReview(value.review, value.detected),
  normalizePlugins: value => value,
  normalizeGit: value => ({ git: !!value.head, head: value.head ?? null,
    branch: value.branch ?? null, dirty: !!value.dirty }),
  normalizeSessionSpawn: value => value, kernelCwd: () => '/repo',
  classifyObservationRoute: () => 'create',
  normalizeEnumProfile: value => ({ ...value, capabilities: [...value.capabilities].sort() }) };

test('request digest binds every stored fact and excludes clock-only facts', () => {
  const projection = normalizeInitializationRequest('/repo', options, deps);
  const digest = initializationRequestDigest(projection);
  for (const [name, changed] of [
    ['runtime', { ...options, runtime: 'claude' }], ['goal', { ...options, goal: 'different' }],
    ['protocol', { ...options, protocol: 'deep-work' }], ['recipe', { ...options, recipe: { ...options.recipe, id: 'x' } }],
    ['review', { ...options, review: { reviewer: 'subagent-checker' } }], ['model', { ...options, model: 'gpt-5' }],
    ['plugins', { ...options, detected: {} }], ['git', { ...options, git: { ...options.git, head: 'def' } }],
    ['spawn', { ...options, sessionSpawn: { launcher: 'cmux', detected_at: 'clock' } }],
    ['consent', { ...options, consent: { mode: 'auto', authority: 'human-confirmed', confirmed_at: 'clock', revoked_at: null } }],
    ['observation', { ...options, observationDigest: hostObservationDigest({
      ...observation, source: 'codex-app-host-context' }) }],
  ]) assert.notEqual(initializationRequestDigest(normalizeInitializationRequest('/repo', changed, deps)), digest, name);
  const clockOnly = { ...options, sessionSpawn: { ...options.sessionSpawn, detected_at: 'later' } };
  assert.equal(initializationRequestDigest(normalizeInitializationRequest('/repo', clockOnly, deps)), digest);
  assert.equal(hostObservationDigest(observation), hostObservationDigest({ ...observation, observed_at: 'later' }));
  assert.equal(hostObservationDigest(observation),
    hostObservationDigest({ ...observation, observed_generation: 99 }),
    'kernel generation is not an Execution-plane observation fact');
  assert.equal(Object.hasOwn(projection, 'host_observation'), false);
  assert.equal(projection.host_observation_digest, hostObservationDigest(observation));
  assert.doesNotMatch(JSON.stringify(projection), /host_task_cwd|observed_generation|observed_at/);
  assert.throws(() => normalizeInitializationRequest('/repo', { ...options, observation }, deps),
    /INIT_REQUEST_RAW_OBSERVATION/);
});

test('canonical genesis derives every clock from the attempt and materializes consent after digest validation', () => {
  const attempt = '01JAPPGEN00000000000000000';
  const projection = normalizeInitializationRequest('/repo', { ...options,
    consent: { mode: 'auto', authority: 'human-confirmed' } }, deps);
  const prepared = { ok: true, outcome: 'prepared', attempt_id: attempt,
    previous_current_digest: 'NONE', expected_request_digest: initializationRequestDigest(projection),
    expected_observation_digest: hostObservationDigest(observation) };
  const buildDeps = { ...deps, buildLoop: buildInitialLoop, nowMs: () => 1 };
  const first = buildCanonicalGenesis('/repo', { prepared,
    request: { ...options, consent: { mode: 'auto', authority: 'human-confirmed' } },
    observation }, buildDeps);
  const second = buildCanonicalGenesis('/repo', { prepared,
    request: { ...options, consent: { mode: 'auto', authority: 'human-confirmed' } },
    observation }, { ...buildDeps, nowMs: () => Date.now() });
  assert.deepEqual(second.loop, first.loop);
  assert.equal(first.loop.created_at, genesisClockFromAttempt(attempt).iso);
  assert.equal(first.loop.session_spawn.detected_at, first.loop.created_at);
  assert.equal(first.loop.session_chain.sessions[0].host_surface.observed_at,
    first.loop.created_at);
  assert.equal(first.loop.session_chain.sessions[0].host_surface.observed_generation, 1);
  assert.equal(first.loop.initialization.host_surface_digest,
    hostSurfaceFactsDigest(first.loop.session_chain.sessions[0].host_surface));
  assert.deepEqual(first.loop.initialization.request_projection, projection);
  assert.equal(first.loop.initialization.request_digest,
    initializationRequestDigest(first.loop.initialization.request_projection));
  assert.equal(first.genesisEvents.length, 1);
  assert.deepEqual(first.genesisEvents[0].data, { run_id: attempt,
    request_digest: first.loop.initialization.request_digest,
    host_surface_digest: first.loop.initialization.host_surface_digest });
  assert.equal(first.genesisEvents[0].type, 'run-initialized');
  assert.equal(first.genesisEvents[0].ts, first.loop.created_at);
  assert.deepEqual(verifyLines(first.genesisEvents), { ok: true, errors: [] });
  assert.deepEqual(verifyHeadLines(first.genesisEvents, first.loop.event_log_head),
    { ok: true, errors: [] });
  assert.equal(first.loop.autonomy.app_task_continuation.confirmed_at,
    first.loop.created_at);
  assert.throws(() => buildCanonicalGenesis('/repo', { prepared,
    request: { ...options, goal: 'drifted', consent: { mode: 'auto', authority: 'human-confirmed' } },
    observation }, buildDeps), /INIT_REQUEST_MISMATCH/);
});

test('enum-only genesis accepts empty capabilities and owns the stored observation timestamp', () => {
  const request = { ...options, observationDigest: 'NONE',
    enumProfile: { kind: 'codex-app', source: 'codex-app-tool-provenance', capabilities: [] } };
  const projection = normalizeInitializationRequest('/repo', request, deps);
  const prepared = { ok: true, outcome: 'prepared',
    attempt_id: '01JAPPGEN00000000000000001', previous_current_digest: 'NONE',
    expected_request_digest: initializationRequestDigest(projection),
    expected_observation_digest: 'NONE' };
  const { loop, clock } = buildCanonicalGenesis('/repo', { prepared, request, observation: null },
    { ...deps, kernelCwd: () => '/actual-caller-cwd', buildLoop: buildInitialLoop });
  assert.deepEqual(loop.session_chain.sessions[0].host_surface.capabilities, []);
  assert.equal(loop.session_chain.sessions[0].host_surface.observed_generation, 1);
  assert.equal(loop.session_chain.sessions[0].host_surface.observed_at, clock.iso);
  assert.equal(loop.session_chain.sessions[0].host_surface.kernel_cwd_at_observation,
    '/actual-caller-cwd');
  assert.equal(loop.initialization.host_surface_digest,
    hostSurfaceFactsDigest(loop.session_chain.sessions[0].host_surface));
  assert.equal(loop.autonomy.app_task_continuation.mode, 'manual');
});

test('null-surface enum genesis stores null while preserving its request profile', () => {
  const request = { ...options, review: null, observationDigest: 'NONE',
    enumProfile: { kind: null, source: null, capabilities: [] } };
  const projection = normalizeInitializationRequest('/repo', request, deps);
  const prepared = { ok: true, outcome: 'prepared',
    attempt_id: '01JAPPGEN00000000000000002', previous_current_digest: 'NONE',
    expected_request_digest: initializationRequestDigest(projection),
    expected_observation_digest: 'NONE' };
  const { loop } = buildCanonicalGenesis('/repo', { prepared, request, observation: null },
    { ...deps, buildLoop: buildInitialLoop });
  assert.equal(loop.session_chain.sessions[0].host_surface, null);
  assert.equal(loop.initialization.host_surface_digest, 'NONE');
  assert.equal(loop.autonomy.app_task_continuation.mode, 'manual');
});

test('canonicalization rejects JSON collisions unsupported values cycles and reflection traps', () => {
  assert.doesNotThrow(() => initializationRequestDigest({ value: null }));
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY, -0, 1n, Symbol('x'), () => {}, new Date(0)]) {
    assert.throws(() => initializationRequestDigest({ value }),
      /INIT_CANONICAL_VALUE_INVALID/);
  }
  assert.throws(() => initializationRequestDigest([,]), /INIT_CANONICAL_VALUE_INVALID/);
  assert.throws(() => initializationRequestDigest([undefined]), /INIT_CANONICAL_VALUE_INVALID/);
  assert.doesNotThrow(() => initializationRequestDigest([null]));
  const protoKey = {};
  Object.defineProperty(protoKey, '__proto__', {
    value: { stored: true }, enumerable: true, configurable: true, writable: true,
  });
  assert.throws(() => initializationRequestDigest(protoKey), /INIT_CANONICAL_VALUE_INVALID/);

  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => initializationRequestDigest(cycle), /INIT_CANONICAL_VALUE_INVALID/);

  let proxyTraps = 0;
  const proxy = new Proxy({ value: 'safe' }, {
    get() { proxyTraps += 1; throw new Error('PROXY_TRAP'); },
    ownKeys() { proxyTraps += 1; throw new Error('PROXY_TRAP'); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('PROXY_TRAP'); },
    getPrototypeOf() { proxyTraps += 1; throw new Error('PROXY_TRAP'); },
  });
  assert.throws(() => initializationRequestDigest(proxy), /INIT_CANONICAL_VALUE_INVALID/);
  assert.equal(proxyTraps, 0, 'proxy rejection must precede every reflective operation');

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get() {
    getterCalls += 1;
    throw new Error('GETTER_TRAP');
  } });
  assert.throws(() => initializationRequestDigest(accessor), /INIT_CANONICAL_VALUE_INVALID/);
  assert.equal(getterCalls, 0, 'accessor rejection must inspect descriptors without evaluating');

  const clockAccessor = { ...observation };
  Object.defineProperty(clockAccessor, 'observed_at', { enumerable: true, get() {
    getterCalls += 1;
    throw new Error('CLOCK_GETTER_TRAP');
  } });
  assert.equal(hostObservationDigest(clockAccessor),
    hostObservationDigest(Object.fromEntries(Object.entries(observation)
      .filter(([key]) => key !== 'observed_at'))));
  assert.equal(getterCalls, 0, 'excluded clock accessors are filtered without evaluation');
});

test('canonicalization enforces the exact Task 3 projection bounds', () => {
  const nested = depth => {
    let value = null;
    for (let index = 0; index < depth; index += 1) value = { value };
    return value;
  };
  assert.doesNotThrow(() => initializationRequestDigest(nested(8)));
  assert.throws(() => initializationRequestDigest(nested(9)), /INIT_CANONICAL_VALUE_INVALID/);

  const nodes = count => ({ left: Array(126).fill(null),
    right: Array(count - 129).fill(null) });
  assert.doesNotThrow(() => initializationRequestDigest(nodes(256)));
  assert.throws(() => initializationRequestDigest(nodes(257)),
    /INIT_CANONICAL_VALUE_INVALID/);
  assert.doesNotThrow(() => initializationRequestDigest(Array(128).fill(null)));
  assert.throws(() => initializationRequestDigest(Array(129).fill(null)),
    /INIT_CANONICAL_VALUE_INVALID/);

  assert.doesNotThrow(() => initializationRequestDigest('x'.repeat(4096)));
  assert.throws(() => initializationRequestDigest('x'.repeat(4097)),
    /INIT_CANONICAL_VALUE_INVALID/);
  assert.doesNotThrow(() => initializationRequestDigest({ ['k'.repeat(4096)]: true }));
  assert.throws(() => initializationRequestDigest({ ['k'.repeat(4097)]: true }),
    /INIT_CANONICAL_VALUE_INVALID/);

  const canonicalBytes = extra => [
    ...Array(15).fill('x'.repeat(4096)), 'x'.repeat(4047 + extra),
  ];
  assert.equal(Buffer.byteLength(JSON.stringify(canonicalBytes(0)), 'utf8'), 65_536);
  assert.doesNotThrow(() => initializationRequestDigest(canonicalBytes(0)));
  assert.equal(Buffer.byteLength(JSON.stringify(canonicalBytes(1)), 'utf8'), 65_537);
  assert.throws(() => initializationRequestDigest(canonicalBytes(1)),
    /INIT_CANONICAL_VALUE_INVALID/);

  for (const forbidden of ['__proto__', 'prototype', 'constructor']) {
    const value = JSON.parse(`{"${forbidden}":true}`);
    assert.throws(() => initializationRequestDigest(value),
      /INIT_CANONICAL_VALUE_INVALID/, forbidden);
  }
});

test('canonical serialization ignores inherited toJSON without collisions or traps', () => {
  const originalObject = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const originalArray = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let inheritedCalls = 0;
  let alpha;
  let beta;
  let array;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() {
      inheritedCalls += 1;
      throw new Error('OBJECT_TOJSON_TRAP');
    } });
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, get() {
      inheritedCalls += 1;
      throw new Error('ARRAY_TOJSON_TRAP');
    } });
    alpha = initializationRequestDigest({ alpha: 1 });
    beta = initializationRequestDigest({ beta: 2 });
    array = initializationRequestDigest(['safe']);
  } finally {
    if (originalObject) Object.defineProperty(Object.prototype, 'toJSON', originalObject);
    else delete Object.prototype.toJSON;
    if (originalArray) Object.defineProperty(Array.prototype, 'toJSON', originalArray);
    else delete Array.prototype.toJSON;
  }
  assert.notEqual(alpha, beta);
  assert.match(array, /^[0-9a-f]{64}$/);
  assert.equal(inheritedCalls, 0);
});

test('genesis event build ignores inherited toJSON and preserves its ordinary public shape', () => {
  const request = { ...options, review: null, observationDigest: 'NONE',
    enumProfile: { kind: null, source: null, capabilities: [] } };
  const projection = normalizeInitializationRequest('/repo', request, deps);
  const prepared = { ok: true, outcome: 'prepared',
    attempt_id: '01JAPPGEN00000000000000004', previous_current_digest: 'NONE',
    expected_request_digest: initializationRequestDigest(projection),
    expected_observation_digest: 'NONE' };
  const original = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let inheritedCalls = 0;
  let built;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, get() {
      inheritedCalls += 1;
      throw new Error('GENESIS_TOJSON_TRAP');
    } });
    built = buildCanonicalGenesis('/repo', { prepared, request, observation: null },
      { ...deps, buildLoop: buildInitialLoop });
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'toJSON', original);
    else delete Object.prototype.toJSON;
  }
  assert.equal(inheritedCalls, 0);
  assert.equal(Object.getPrototypeOf(built.genesisEvents[0].data), Object.prototype);
  assert.deepEqual(built.genesisEvents[0].data, {
    run_id: prepared.attempt_id,
    request_digest: prepared.expected_request_digest,
    host_surface_digest: 'NONE',
  });
  assert.deepEqual(verifyLines(built.genesisEvents), { ok: true, errors: [] });
  assert.deepEqual(verifyHeadLines(built.genesisEvents, built.loop.event_log_head),
    { ok: true, errors: [] });
});

test('genesis ULID clock accepts the last canonical four-digit UTC instant and rejects extended years', () => {
  assert.deepEqual(genesisClockFromAttempt('76EZ91ZPZZ0000000000000000'), {
    ms: 253402300799999, iso: '9999-12-31T23:59:59.999Z',
  });
  assert.throws(() => genesisClockFromAttempt('7ZZZZZZZZZ0000000000000000'),
    /INIT_ATTEMPT_CLOCK_INVALID/);
});

test('canonical genesis isolates returned projection stored projection and loop object graphs', () => {
  const attempt = '01JAPPGEN00000000000000003';
  const projection = normalizeInitializationRequest('/repo', options, deps);
  const prepared = { ok: true, outcome: 'prepared', attempt_id: attempt,
    previous_current_digest: 'NONE', expected_request_digest: initializationRequestDigest(projection),
    expected_observation_digest: hostObservationDigest(observation) };
  const built = buildCanonicalGenesis('/repo', { prepared, request: options, observation },
    { ...deps, buildLoop: buildInitialLoop });

  built.projection.routing.recipe.name = 'projection-mutated';
  built.projection.plugins_detected['projection-only'] = true;
  assert.equal(built.loop.recipe.name, 'r');
  assert.equal(Object.hasOwn(built.loop.plugins_detected, 'projection-only'), false);
  assert.equal(built.loop.initialization.request_projection.routing.recipe.name, 'r');
  assert.equal(Object.hasOwn(
    built.loop.initialization.request_projection.plugins_detected, 'projection-only'), false);

  built.loop.recipe.name = 'loop-mutated';
  built.loop.plugins_detected['loop-only'] = true;
  assert.equal(built.projection.routing.recipe.name, 'projection-mutated');
  assert.equal(Object.hasOwn(built.projection.plugins_detected, 'loop-only'), false);
  assert.equal(built.loop.initialization.request_projection.routing.recipe.name, 'r');
  assert.equal(Object.hasOwn(
    built.loop.initialization.request_projection.plugins_detected, 'loop-only'), false);

  built.loop.initialization.request_projection.routing.recipe.name = 'stored-mutated';
  assert.equal(built.loop.recipe.name, 'loop-mutated');
  assert.equal(built.projection.routing.recipe.name, 'projection-mutated');
});

test('preflight and prepare are byte-identical no-write queries with exact reader binding', () => {
  const root = fixtureDir();
  const options = initOptions();
  const deps = initDeps(root);
  const before = queryTree(root);
  const preflight = preflightInitialization(root, {
    ...options, nonce: '00000000000000000000000000000001', readerMode: 'pty-raw-noecho',
    observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context' },
  }, deps);
  assert.deepEqual(preflight, { eligible: true, reason: 'eligible',
    observation_digest: preflight.observation_digest });
  assert.throws(() => preflightInitialization(root, {
    ...options, nonce: '../bad', readerMode: 'pipe-open-noecho',
    observation: { structured_stdin_mode: 'pty-raw-noecho' },
  }, deps), /INIT_PREFLIGHT_BINDING_INVALID/);
  const partial = preflightInitialization(root, {
    runtime: 'codex', nonce: '00000000000000000000000000000002', readerMode: 'pty-raw-noecho',
    observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context' },
  }, initDeps(root, {
    eligible: () => ({ eligible: false, reason: 'capability-incomplete', route: null }) }));
  assert.deepEqual(partial, { eligible: false, reason: 'capability-incomplete',
    observation_digest: partial.observation_digest });
  const wrongRoot = preflightInitialization(root, {
    runtime: 'codex', nonce: '00000000000000000000000000000003', readerMode: 'pty-raw-noecho',
    observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context' },
  }, initDeps(root, { assertInitializationAuthority: () => {
    throw new Error('INIT_CWD_MISMATCH');
  } }));
  assert.equal(wrongRoot.eligible, false);
  assert.equal(wrongRoot.reason, 'cwd-mismatch');
  const exactRaw = { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
    structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
    host_task_cwd_source: 'app-task-context' };
  for (const extra of ['runtime', 'kernel_cwd_at_observation', 'observed_generation', 'observed_at',
    'projectId', 'threadId', 'clientThreadId']) {
    assert.throws(() => preflightInitialization(root, { runtime: 'codex',
      nonce: 'ffffffffffffffffffffffffffffffff', readerMode: 'pty-raw-noecho',
      observation: { ...exactRaw, [extra]: `RAW-${extra}` } }, deps),
    /HOST_OBSERVATION_INPUT_INVALID/);
    assert.deepEqual(queryTree(root), before, extra);
  }
  const prepared = prepareInitialization(root, options, deps);
  assert.deepEqual(prepared, { ok: true, outcome: 'prepared',
    attempt_id: '01JAPPGEN00000000000000001', previous_current_digest: 'NONE',
    expected_request_digest: prepared.expected_request_digest,
    expected_observation_digest: 'NONE' });
  assert.throws(() => prepareInitialization(root, { ...options,
    observation: { host_task_cwd: '/raw/forbidden' } }, deps),
  /INIT_REQUEST_RAW_OBSERVATION/);
  assert.deepEqual(queryTree(root), before);
});

test('prepare reuses exact incomplete pending and rejects foreign or malformed pending', () => {
  const root = fixtureDir();
  const options = initOptions();
  const deps = initDeps(root);
  const request = initializationRequestDigest(normalizeInitializationRequest(root, options, deps));
  const attempt = '01JAPPGEN00000000000000000';
  const pending = { version: 1, attempt_id: attempt, request_digest: request,
    previous_current_digest: 'NONE' };
  put(root, '.deep-loop/init-pending.json', JSON.stringify(pending));
  assert.equal(prepareInitialization(root, options, deps).attempt_id, attempt);
  put(root, '.deep-loop/init-pending.json', JSON.stringify({ ...pending, request_digest: 'f'.repeat(64) }));
  assert.throws(() => prepareInitialization(root, options, deps), /INIT_PENDING_CONFLICT/);
  put(root, '.deep-loop/init-pending.json', '{bad');
  assert.throws(() => prepareInitialization(root, options, deps), /INIT_PENDING_CONFLICT/);

  const eventOnly = fixtureDir();
  const eventDeps = initDeps(eventOnly);
  const eventRequest = initializationRequestDigest(
    normalizeInitializationRequest(eventOnly, options, eventDeps));
  put(eventOnly, '.deep-loop/init-pending.json', JSON.stringify({ ...pending,
    request_digest: eventRequest }));
  put(eventOnly, '.deep-loop/runs/' + attempt + '/event-log.jsonl', '');
  assert.throws(() => prepareInitialization(eventOnly, options, eventDeps),
    /INIT_PENDING_CONFLICT/, 'event-only is not a recoverable no-loop staging shape');
});

test('completed pending is logically absent and a proposed target collision never succeeds', () => {
  const root = fixtureDir();
  const options = initOptions();
  const deps = initDeps(root);
  const request = initializationRequestDigest(normalizeInitializationRequest(root, options, deps));
  const completed = '01JAPPGEN00000000000000000';
  const pending = { version: 1, attempt_id: completed, request_digest: request,
    previous_current_digest: 'NONE' };
  const { raw, events } = validGenesis(root, completed, request, 'NONE');
  put(root, '.deep-loop/init-pending.json', JSON.stringify(pending));
  put(root, '.deep-loop/runs/' + completed + '/.loop.hash', contentHash(raw));
  put(root, '.deep-loop/runs/' + completed + '/event-log.jsonl', events);
  put(root, '.deep-loop/runs/' + completed + '/loop.json', raw);
  put(root, '.deep-loop/current', completed + '\n');
  const before = queryTree(root);
  const prepared = prepareInitialization(root, options, deps);
  assert.equal(prepared.attempt_id, '01JAPPGEN00000000000000001');
  assert.equal(prepared.previous_current_digest, contentHash(completed));
  assert.deepEqual(queryTree(root), before);

  const collisionRoot = fixtureDir();
  put(collisionRoot, '.deep-loop/runs/01JAPPGEN00000000000000001/foreign.tmp', 'x');
  assert.throws(() => prepareInitialization(collisionRoot, options, initDeps(collisionRoot)),
    /INIT_ATTEMPT_COLLISION/);
  const emptyCollision = fixtureDir();
  mkdirSync(join(emptyCollision, '.deep-loop', 'runs', '01JAPPGEN00000000000000001'),
    { recursive: true });
  assert.throws(() => prepareInitialization(emptyCollision, options, initDeps(emptyCollision)),
    /INIT_ATTEMPT_COLLISION/, 'even an existing empty proposed directory is a collision');
});

test('prepare validates exact current bytes and strict legacy current state before upgrade', () => {
  const root = fixtureDir();
  const options = initOptions();
  const deps = initDeps(root);
  const legacy = '01JAPPGEN00000000000000000';
  const loop = buildInitialLoop({ runtime: 'codex', goal: 'legacy', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: 'test' }, runId: legacy,
    now: new Date('2026-07-13T00:00:00.000Z') });
  loop.project.root = root;
  const raw = JSON.stringify(loop);
  put(root, '.deep-loop/runs/' + legacy + '/.loop.hash', contentHash(raw));
  put(root, '.deep-loop/runs/' + legacy + '/loop.json', raw);
  put(root, '.deep-loop/current', legacy + '\n');
  assert.equal(prepareInitialization(root, options, deps).previous_current_digest, contentHash(legacy));
  put(root, '.deep-loop/runs/' + legacy + '/event-log.jsonl',
    JSON.stringify({ seq: 1, ts: '2026-07-13T00:00:01.000Z', type: 'tampered',
      data: {}, checksum: 'f'.repeat(64) }) + '\n');
  assert.throws(() => prepareInitialization(root, options, deps), /INIT_CURRENT_INVALID/,
    'state hash without matching event-log chain/head is not a strict current');
  unlinkSync(join(root, '.deep-loop', 'runs', legacy, 'event-log.jsonl'));
  put(root, '.deep-loop/current', legacy + ' \n');
  assert.throws(() => prepareInitialization(root, options, deps), /INIT_CURRENT_INVALID/);
  put(root, '.deep-loop/current', '01JAPPGEN00000000000000002\n');
  assert.throws(() => prepareInitialization(root, options, deps), /INIT_CURRENT_INVALID/);
});

test('prepare rejects a dangling current symlink', t => {
  const root = fixtureDir();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  if (!createFileSymlinkOrSkip(t, join(root, 'missing-current'),
    join(root, '.deep-loop', 'current'))) return;
  assert.throws(() => prepareInitialization(root, initOptions(), initDeps(root)),
    /INIT_QUERY_INDETERMINATE/);
});

test('prepare rejects a dangling pending marker symlink', t => {
  const root = fixtureDir();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  if (!createFileSymlinkOrSkip(t, join(root, 'missing-pending'),
    join(root, '.deep-loop', 'init-pending.json'))) return;
  assert.throws(() => prepareInitialization(root, initOptions(), initDeps(root)),
    /INIT_QUERY_INDETERMINATE/);
});

test('prepare rejects a dangling pending run directory', () => {
  const attempt = '01JAPPGEN00000000000000000';
  const root = fixtureDir();
  const pendingOptions = initOptions();
  const pendingDeps = initDeps(root);
  const pendingRequest = initializationRequestDigest(
    normalizeInitializationRequest(root, pendingOptions, pendingDeps));
  put(root, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: attempt, request_digest: pendingRequest, previous_current_digest: 'NONE' }));
  const outside = fixtureDir('dl-init-outside-');
  const run = join(root, '.deep-loop', 'runs', attempt);
  mkdirSync(dirname(run), { recursive: true });
  createDirectoryJunction(outside, run);
  rmSync(outside, { recursive: true });
  assert.throws(() => prepareInitialization(root, pendingOptions, pendingDeps),
    /INIT_QUERY_INDETERMINATE/);
});

test('prepare rejects a dangling proposed run directory', () => {
  const root = fixtureDir();
  const proposed = '01JAPPGEN00000000000000001';
  const outside = fixtureDir('dl-init-outside-');
  const run = join(root, '.deep-loop', 'runs', proposed);
  mkdirSync(dirname(run), { recursive: true });
  createDirectoryJunction(outside, run);
  rmSync(outside, { recursive: true });
  assert.throws(() => prepareInitialization(root, initOptions(),
    initDeps(root, { ulid: () => proposed })), /INIT_QUERY_INDETERMINATE/);
});

test('prepare rejects a symlinked runs ancestor even when the proposed target is absent', () => {
  const root = fixtureDir();
  const outside = fixtureDir('dl-init-outside-');
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  createDirectoryJunction(outside, join(root, '.deep-loop', 'runs'));
  assert.throws(() => prepareInitialization(root, initOptions(), initDeps(root)),
    /INIT_QUERY_INDETERMINATE/);
});

test('status proves committed state before interpreting a later foreign pending', () => {
  const root = fixtureDir();
  const options = initOptions();
  const deps = initDeps(root);
  const request = initializationRequestDigest(normalizeInitializationRequest(root, options, deps));
  const attempt = '01JAPPGEN00000000000000000';
  const { raw, events } = validGenesis(root, attempt, request, 'NONE');
  put(root, '.deep-loop/runs/' + attempt + '/.loop.hash', contentHash(raw));
  put(root, '.deep-loop/runs/' + attempt + '/event-log.jsonl', events);
  put(root, '.deep-loop/runs/' + attempt + '/loop.json', raw);
  put(root, '.deep-loop/current', attempt + '\n');
  put(root, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: '01JAPPGEN00000000000000002', request_digest: 'f'.repeat(64),
    previous_current_digest: contentHash(attempt) }));
  const result = statusInitialization(root, { attempt_id: attempt,
    expected_current_digest: 'NONE', expected_request_digest: request }, deps);
  assert.equal(result.outcome, 'committed');
  assert.equal(result.request_match, true);
  assert.equal(result.previous_current_match, true);
  assert.equal(result.lock_state, 'free');
  assert.equal(Object.hasOwn(result, 'expected_request_digest'), false);
});

test('status returns pending, conflict, and raced without an unnamed success shortcut', () => {
  const root = fixtureDir();
  const options = initOptions();
  const deps = initDeps(root);
  const request = initializationRequestDigest(normalizeInitializationRequest(root, options, deps));
  const attempt = '01JAPPGEN00000000000000000';
  put(root, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: attempt, request_digest: request, previous_current_digest: 'NONE' }));
  const binding = { attempt_id: attempt, expected_current_digest: 'NONE',
    expected_request_digest: request };
  assert.deepEqual(statusInitialization(root, binding, deps), {
    ok: true, outcome: 'pending', request_match: true, previous_current_match: true,
    consent_mode: null, host_surface: null, structured_stdin_mode: null, lock_state: 'free' });
  assert.equal(statusInitialization(root, { ...binding,
    expected_request_digest: 'f'.repeat(64) }, deps).outcome, 'conflict');
  put(root, '.deep-loop/init-pending.json', '{bad');
  assert.equal(statusInitialization(root, binding, deps).outcome, 'conflict');

  let currentRead = 0;
  const virtual = new Map([
    [join(root, '.deep-loop', 'current'), Buffer.from(attempt + '\n')],
  ]);
  const virtualControl = join(root, '.deep-loop');
  const raced = statusInitialization(root, binding, initDeps(root, {
    lstat: path => {
      if (path === virtualControl) return { isDirectory: () => true,
        isFile: () => false, isSymbolicLink: () => false,
        dev: 1, ino: 1, mode: 16877, size: 64, mtimeMs: 1 };
      if (virtual.has(path)) return { isDirectory: () => false,
        isFile: () => true, isSymbolicLink: () => false,
        dev: 1, ino: 2, mode: 33188, size: 27, mtimeMs: 1 };
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    readFile: path => path.endsWith('current') && ++currentRead > 1
      ? Buffer.from('01JAPPGEN00000000000000002\n') : virtual.get(path),
  }));
  assert.equal(raced.outcome, 'raced');
  assert.equal(raced.request_match, false);
  assert.equal(raced.previous_current_match, false);

  const controlRaceRoot = fixtureDir();
  const control = join(controlRaceRoot, '.deep-loop');
  mkdirSync(control, { recursive: true });
  let controlReads = 0;
  const controlRaced = statusInitialization(controlRaceRoot, binding,
    initDeps(controlRaceRoot, { lstat: path => path === control ? {
      isDirectory: () => true, isSymbolicLink: () => false,
      dev: 1, ino: ++controlReads, mode: 16877, size: 64, mtimeMs: 1,
    } : lstatSync(path) }));
  assert.equal(controlRaced.outcome, 'raced',
    'replacement of an otherwise empty control directory is not a stable absent result');
});

test('exact pending never masks mismatched complete target initialization', () => {
  const root = fixtureDir();
  const attempt = '01JAPPGEN00000000000000000';
  const actualRequest = initializationRequestDigest(
    normalizeInitializationRequest(root, initOptions(), initDeps(root)));
  const binding = { attempt_id: attempt, expected_current_digest: 'NONE',
    expected_request_digest: 'a'.repeat(64) };
  put(root, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: attempt, request_digest: binding.expected_request_digest,
    previous_current_digest: binding.expected_current_digest }));
  const { raw, events } = validGenesis(root, attempt, actualRequest, 'NONE');
  put(root, '.deep-loop/runs/' + attempt + '/.loop.hash', contentHash(raw));
  put(root, '.deep-loop/runs/' + attempt + '/event-log.jsonl', events);
  put(root, '.deep-loop/runs/' + attempt + '/loop.json', raw);
  const result = statusInitialization(root, binding, initDeps(root));
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.request_match, false);
  assert.equal(result.previous_current_match, true);
});

test('status distinguishes exact-pending state-only, clean absent, and pendingless state corruption', () => {
  const attempt = '01JAPPGEN00000000000000000';
  const stateRoot = fixtureDir();
  const request = initializationRequestDigest(
    normalizeInitializationRequest(stateRoot, initOptions(), initDeps(stateRoot)));
  const binding = { attempt_id: attempt, expected_current_digest: 'NONE',
    expected_request_digest: request };
  const { raw, events } = validGenesis(stateRoot, attempt, request, 'NONE');
  put(stateRoot, '.deep-loop/runs/' + attempt + '/.loop.hash', contentHash(raw));
  put(stateRoot, '.deep-loop/runs/' + attempt + '/event-log.jsonl', events);
  put(stateRoot, '.deep-loop/runs/' + attempt + '/loop.json', raw);
  const pendinglessState = statusInitialization(stateRoot, binding, initDeps(stateRoot));
  assert.equal(pendinglessState.outcome, 'indeterminate');
  assert.equal(pendinglessState.request_match && pendinglessState.previous_current_match, true,
    'matching state facts remain diagnostic but are not retry authority without exact pending');
  put(stateRoot, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: attempt, request_digest: request, previous_current_digest: 'NONE' }));
  const stateOnly = statusInitialization(stateRoot, binding, initDeps(stateRoot));
  assert.equal(stateOnly.outcome, 'state-only');
  assert.equal(stateOnly.request_match && stateOnly.previous_current_match, true);
  put(stateRoot, '.deep-loop/runs/' + attempt + '/event-log.jsonl',
    JSON.stringify({ seq: 1, ts: '2026-07-13T00:00:01.000Z', type: 'tampered',
      data: {}, checksum: 'f'.repeat(64) }) + '\n');
  assert.equal(statusInitialization(stateRoot, binding, initDeps(stateRoot)).outcome,
    'indeterminate', 'status requires matching event-log chain and stored head');

  const absentRoot = fixtureDir();
  assert.deepEqual(statusInitialization(absentRoot, binding, initDeps(absentRoot)), {
    ok: true, outcome: 'absent', request_match: true, previous_current_match: true,
    consent_mode: null, host_surface: null, structured_stdin_mode: null, lock_state: 'free' });
  put(absentRoot, '.deep-loop/current', '01JAPPGEN00000000000000002\n');
  assert.equal(statusInitialization(absentRoot, binding, initDeps(absentRoot)).outcome, 'conflict',
    'previous-current drift is not a clean absent');

  const partialRoot = fixtureDir();
  put(partialRoot, '.deep-loop/runs/' + attempt + '/.loop.hash', 'f'.repeat(64));
  assert.equal(statusInitialization(partialRoot, binding, initDeps(partialRoot)).outcome, 'indeterminate');
});

test('status treats exact pending hash and strict temp debris as pending but unknown entries as indeterminate', () => {
  const attempt = '01JAPPGEN00000000000000000';
  const request = 'a'.repeat(64);
  const binding = { attempt_id: attempt, expected_current_digest: 'NONE',
    expected_request_digest: request };
  const root = fixtureDir();
  put(root, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: attempt, request_digest: request, previous_current_digest: 'NONE' }));
  put(root, '.deep-loop/runs/' + attempt + '/.loop.hash', 'f'.repeat(64));
  put(root, '.deep-loop/runs/' + attempt + '/.tmp-7-1783900800000-1234567890abcdef',
    'partial');
  put(root, '.deep-loop/.tmp-7-1783900800000-fedcba0987654321', 'partial-current');
  assert.equal(statusInitialization(root, binding, initDeps(root)).outcome, 'pending');
  put(root, '.deep-loop/runs/' + attempt + '/unknown', 'foreign');
  assert.equal(statusInitialization(root, binding, initDeps(root)).outcome, 'indeterminate');
  const symlinkRoot = fixtureDir();
  put(symlinkRoot, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: attempt, request_digest: request, previous_current_digest: 'NONE' }));
  mkdirSync(join(symlinkRoot, '.deep-loop', 'runs', attempt), { recursive: true });
  const foreignTarget = fixtureDir('dl-init-foreign-target-');
  createDirectoryJunction(foreignTarget,
    join(symlinkRoot, '.deep-loop', 'runs', attempt, 'foreign-link'));
  assert.equal(statusInitialization(symlinkRoot, binding, initDeps(symlinkRoot)).outcome,
    'indeterminate');
  const eventOnly = fixtureDir();
  put(eventOnly, '.deep-loop/init-pending.json', JSON.stringify({ version: 1,
    attempt_id: attempt, request_digest: request, previous_current_digest: 'NONE' }));
  put(eventOnly, '.deep-loop/runs/' + attempt + '/event-log.jsonl', '');
  assert.equal(statusInitialization(eventOnly, binding, initDeps(eventOnly)).outcome,
    'indeterminate', 'event-only never masquerades as pending staging');
  const pendinglessRun = fixtureDir();
  put(pendinglessRun, '.deep-loop/runs/' + attempt + '/foreign.tmp', 'x');
  assert.equal(statusInitialization(pendinglessRun, binding, initDeps(pendinglessRun)).outcome,
    'indeterminate', 'a pendingless foreign run directory is not absent');
  const emptyRun = fixtureDir();
  mkdirSync(join(emptyRun, '.deep-loop', 'runs', attempt), { recursive: true });
  assert.equal(statusInitialization(emptyRun, binding, initDeps(emptyRun)).outcome,
    'indeterminate', 'a pendingless empty run directory is not absent');
  const pendingless = fixtureDir();
  put(pendingless, '.deep-loop/.tmp-7-1783900800000-1234567890abcdef', 'partial-pending');
  assert.equal(statusInitialization(pendingless, binding, initDeps(pendingless)).outcome,
    'indeterminate', 'pendingless control-directory staging is never a clean absent');
});

test('status classifies a stable fixed-lock holder without deleting it', () => {
  const root = fixtureDir();
  const attempt = '01JAPPGEN00000000000000000';
  const binding = { attempt_id: attempt, expected_current_digest: 'NONE',
    expected_request_digest: 'a'.repeat(64) };
  put(root, '.deep-loop/.init.lock', JSON.stringify({
    pid: 42, nonce: '1234567890abcdef', acquired_at: '2026-07-13T00:00:00.000Z' }));
  assert.equal(statusInitialization(root, binding,
    initDeps(root, { probePidIdentity: () => 'alive' })).lock_state, 'busy');
  assert.equal(statusInitialization(root, binding,
    initDeps(root, { probePidIdentity: () => 'unknown' })).lock_state, 'busy');
  assert.equal(statusInitialization(root, binding,
    initDeps(root, { probePidIdentity: () => 'definitely-dead' })).lock_state, 'stale-manual');
  put(root, '.deep-loop/.init.lock', '{bad');
  assert.equal(statusInitialization(root, binding, initDeps(root)).lock_state, 'invalid');
  assert.equal(existsSync(join(root, '.deep-loop', '.init.lock')), true);
});

test('status follows released init authorities to the bounded terminal successor', () => {
  const root = fixtureDir();
  const binding = { attempt_id: '01JAPPGEN00000000000000000',
    expected_current_digest: 'NONE', expected_request_digest: 'a'.repeat(64) };
  const control = join(root, '.deep-loop');
  const first = { pid: 41, nonce: 'firstauthority01',
    acquired_at: '2026-07-13T00:00:00.000Z' };
  const second = { pid: 42, nonce: 'secondauthority1',
    acquired_at: '2026-07-13T00:00:01.000Z' };
  put(root, '.deep-loop/.init.lock', JSON.stringify(first));
  linkSync(join(control, '.init.lock'), join(control, '.init-lock-release-' + first.nonce));
  put(root, '.deep-loop/.init-lock-successor-' + first.nonce, JSON.stringify(second));
  assert.equal(statusInitialization(root, binding,
    initDeps(root, { probePidIdentity: () => 'alive' })).lock_state, 'busy');
  linkSync(join(control, '.init-lock-successor-' + first.nonce),
    join(control, '.init-lock-release-' + second.nonce));
  assert.equal(statusInitialization(root, binding, initDeps(root)).lock_state, 'free');
});

test('status returns raced when a held writer completes between state and lock snapshots', () => {
  const root = fixtureDir();
  const control = join(root, '.deep-loop');
  mkdirSync(control);
  const binding = { attempt_id: '01JAPPGEN00000000000000000',
    expected_current_digest: 'NONE', expected_request_digest: 'a'.repeat(64) };
  const holder = { pid: 42, nonce: 'snapshotwriter01',
    acquired_at: '2026-07-13T00:00:00.000Z' };
  let controlReads = 0;
  const result = statusInitialization(root, binding, initDeps(root, {
    readdir: path => {
      if (path === control && ++controlReads === 3) {
        put(root, '.deep-loop/.init.lock', JSON.stringify(holder));
        linkSync(join(control, '.init.lock'),
          join(control, '.init-lock-release-' + holder.nonce));
      }
      return readdirSync(path);
    },
  }));
  assert.equal(result.outcome, 'raced');
  assert.equal(result.lock_state, 'invalid');
});

test('dead fixed init authority is stale-manual and never unlinked', () => {
  const root = fixtureDir();
  const lock = join(root, '.deep-loop', '.init.lock');
  put(root, '.deep-loop/.init.lock', JSON.stringify({
    pid: 42, nonce: '1234567890abcdef', acquired_at: '2026-07-13T00:00:00.000Z' }));
  const before = readFileSync(lock);
  assert.throws(() => withInitLock(root, () => assert.fail('writer entered'), {
    pid: 7, nonce: () => 'fedcba0987654321', now: () => Date.parse('2026-07-13T00:10:00.001Z'),
    probePidIdentity: () => 'definitely-dead',
  }), /LOCK_STALE_MANUAL/);
  assert.deepEqual(readFileSync(lock), before);
});

test('lock release never pathname-deletes a release-time copied-nonce ABA replacement', () => {
  const root = fixtureDir();
  const later = { pid: 99, nonce: 'firstowner000000', acquired_at: '2026-07-13T00:00:01.000Z' };
  const fixed = join(root, '.deep-loop', '.init.lock');
  withInitLock(root, () => {}, {
    pid: 7, nonce: () => 'firstowner000000',
    now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    probePidIdentity: () => 'alive',
    link: (source, destination) => {
      if (destination.endsWith('.init-lock-release-firstowner000000')) {
        unlinkSync(fixed);
        put(root, '.deep-loop/.init.lock', JSON.stringify(later));
      }
      return linkSync(source, destination);
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.deep-loop', '.init.lock'))), later);
  assert.deepEqual(readdirSync(join(root, '.deep-loop'))
    .filter(name => name.startsWith('.init-lock-candidate-')), []);
});

test('candidate sweep is strict, age greater-than TTL, lexical, capped, and candidate-only', () => {
  const root = fixtureDir();
  const acquired = '2026-07-13T00:00:00.000Z';
  for (let index = 64; index >= 0; index -= 1) {
    const nonce = String(index).padStart(16, '0');
    put(root, '.deep-loop/.init-lock-candidate-' + (100 + index) + '-' + nonce,
      JSON.stringify({ pid: 100 + index, nonce, acquired_at: acquired }));
  }
  const touched = [];
  withInitLock(root, () => {}, {
    pid: 7, nonce: () => 'writer0000000000',
    now: () => Date.parse('2026-07-13T00:05:00.001Z'),
    probePidIdentity: value => { touched.push(value.pid); return 'definitely-dead'; },
  });
  assert.equal(touched.length, 64);
  assert.equal(readdirSync(join(root, '.deep-loop'))
    .filter(name => name.startsWith('.init-lock-candidate-')).length, 1);

  const boundary = fixtureDir();
  put(boundary, '.deep-loop/.init-lock-candidate-42-1234567890abcdef',
    JSON.stringify({ pid: 42, nonce: '1234567890abcdef', acquired_at: acquired }));
  withInitLock(boundary, () => {}, { pid: 7, nonce: () => 'writer0000000000',
    now: () => Date.parse(acquired) + INIT_LOCK_CANDIDATE_TTL_MS,
    probePidIdentity: () => 'definitely-dead' });
  assert.equal(existsSync(join(boundary, '.deep-loop', '.init-lock-candidate-42-1234567890abcdef')), true);
});

test('unsupported hard link cleans only its candidate', () => {
  const root = fixtureDir();
  const error = Object.assign(new Error('unsupported'), { code: 'EXDEV' });
  assert.throws(() => withInitLock(root, () => {}, {
    pid: 7, nonce: () => 'writer0000000000', now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    link: () => { throw error; },
  }), /LOCK_UNSUPPORTED/);
  assert.deepEqual(readdirSync(join(root, '.deep-loop'))
    .filter(name => name.startsWith('.init-lock-candidate-')), []);
});

test('candidate write failure cleans a partially-created candidate under native defaults', () => {
  const root = fixtureDir();
  assert.throws(() => withInitLock(root, () => assert.fail('writer entered'), {
    pid: 7, nonce: () => 'writer0000000000',
    now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    writeFile: (path, bytes, options) => {
      writeFileSync(path, bytes, options);
      throw new Error('PARTIAL_CANDIDATE_WRITE');
    },
  }), /PARTIAL_CANDIDATE_WRITE/);
  assert.deepEqual(readdirSync(join(root, '.deep-loop'))
    .filter(name => name.startsWith('.init-lock-candidate-')), []);
});

test('candidate nonce collision preserves the pre-existing candidate', () => {
  const root = fixtureDir();
  const nonce = 'collisionowner01';
  const candidate = join(root, '.deep-loop', '.init-lock-candidate-7-' + nonce);
  const bytes = Buffer.from('pre-existing-candidate');
  put(root, '.deep-loop/.init-lock-candidate-7-' + nonce, bytes);
  assert.throws(() => withInitLock(root, () => assert.fail('writer entered'), {
    pid: 7, nonce: () => nonce,
    now: () => Date.parse('2026-07-13T00:00:00.000Z'),
  }), error => error?.code === 'EEXIST');
  assert.deepEqual(readFileSync(candidate), bytes);
});

test('stable exhausted chain permits 64 owners and rejects the 65th before any primitive', () => {
  const root = fixtureDir();
  const nonceFor = index => 'owner' + String(index).padStart(11, '0');
  let entered = 0;
  for (let index = 1; index <= INIT_LOCK_CHAIN_MAX; index += 1) {
    withInitLock(root, () => { entered += 1; }, {
      pid: 7, nonce: () => nonceFor(index),
      now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    });
  }
  assert.equal(entered, 64);
  const before = queryTree(root);
  assert.throws(() => withInitLock(root, () => { entered += 1; }, {
    pid: 7, nonce: () => nonceFor(65),
    now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    writeFile: () => assert.fail('cap failure must not write a candidate'),
    link: () => assert.fail('cap failure must not publish authority'),
    unlink: () => assert.fail('cap failure must not sweep or clean'),
  }), /LOCK_CHAIN_EXHAUSTED/);
  assert.equal(entered, 64);
  assert.deepEqual(queryTree(root), before);
  const binding = { attempt_id: '01JAPPGEN00000000000000000',
    expected_current_digest: 'NONE', expected_request_digest: 'a'.repeat(64) };
  assert.equal(statusInitialization(root, binding, initDeps(root)).lock_state, 'invalid');
});

test('last-slot overtaking cleans only the losing contender candidate without publishing authority', () => {
  const root = fixtureDir();
  const nonceFor = index => 'owner' + String(index).padStart(11, '0');
  for (let index = 1; index <= INIT_LOCK_CHAIN_MAX - 1; index += 1) {
    withInitLock(root, () => {}, { pid: 7, nonce: () => nonceFor(index),
      now: () => Date.parse('2026-07-13T00:00:00.000Z') });
  }
  let interleaved = false;
  const writes = [];
  const unlinks = [];
  assert.throws(() => withInitLock(root, () => assert.fail('loser entered'), {
    pid: 7, nonce: () => nonceFor(65),
    now: () => Date.parse('2026-07-13T00:00:00.000Z'),
    writeFile: (path, bytes, options) => {
      if (!interleaved) {
        interleaved = true;
        withInitLock(root, () => {}, { pid: 7, nonce: () => nonceFor(64),
          now: () => Date.parse('2026-07-13T00:00:00.000Z') });
      }
      writes.push(path);
      writeFileSync(path, bytes, options);
    },
    unlink: path => { unlinks.push(path); return unlinkSync(path); },
  }), /LOCK_CHAIN_EXHAUSTED/);
  assert.deepEqual(writes, [join(root, '.deep-loop',
    '.init-lock-candidate-7-' + nonceFor(65))]);
  assert.deepEqual(unlinks, writes, 'only the losing invocation own candidate is removed');
  const names = readdirSync(join(root, '.deep-loop'));
  assert.equal(names.includes('.init-lock-successor-' + nonceFor(64)), false);
  assert.equal(names.includes('.init-lock-release-' + nonceFor(65)), false);
});

test('EEXIST fixed-holder matrix preserves live unknown invalid dead and PID-reused authority', () => {
  for (const row of [
    { name: 'live', holder: { pid: 42, nonce: '1234567890abcdef',
      acquired_at: '2026-07-13T00:00:00.000Z' }, liveness: 'alive', code: /LOCK_BUSY/ },
    { name: 'unknown', holder: { pid: 42, nonce: '1234567890abcdef',
      acquired_at: '2026-07-13T00:00:00.000Z' }, liveness: 'unknown', code: /LOCK_BUSY/ },
    { name: 'dead', holder: { pid: 42, nonce: '1234567890abcdef',
      acquired_at: '2026-07-13T00:00:00.000Z' }, liveness: 'definitely-dead', code: /LOCK_STALE_MANUAL/ },
    { name: 'pid-reused', holder: { pid: 42, nonce: '1234567890abcdef',
      acquired_at: '2026-07-13T00:00:00.000Z' }, liveness: 'pid-reused', code: /LOCK_STALE_MANUAL/ },
    { name: 'invalid', holder: '{bad', liveness: 'unknown', code: /LOCK_BUSY/ },
  ]) {
    const root = fixtureDir();
    const bytes = typeof row.holder === 'string' ? row.holder : JSON.stringify(row.holder);
    put(root, '.deep-loop/.init.lock', bytes);
    const fixed = join(root, '.deep-loop', '.init.lock');
    for (const nonce of ['contender0000001', 'contender0000002']) {
      assert.throws(() => withInitLock(root, () => assert.fail(row.name), {
        pid: 7, nonce: () => nonce, now: () => Date.parse('2026-07-13T00:10:00.000Z'),
        probePidIdentity: () => row.liveness,
      }), row.code);
      assert.equal(readFileSync(fixed, 'utf8'), bytes, row.name);
    }
  }
});

test('quality owner nonce reuse in a released chain rejects before candidate primitives', () => {
  const root = fixtureDir();
  const nonce = 'reusedowner00001';
  const now = () => Date.parse('2026-07-13T00:00:00.000Z');
  withInitLock(root, () => {}, { pid: 7, nonce: () => nonce, now });
  const before = queryTree(root);
  const calls = [];
  let thrown = null;
  try {
    withInitLock(root, () => assert.fail('reused owner entered'), {
      pid: 7, nonce: () => nonce, now,
      writeFile: (...args) => { calls.push('write'); return writeFileSync(...args); },
      link: (...args) => { calls.push('link'); return linkSync(...args); },
      unlink: (...args) => { calls.push('unlink'); return unlinkSync(...args); },
    });
  } catch (error) { thrown = error; }
  assert.deepEqual(calls, []);
  assert.deepEqual(queryTree(root), before);
  assert.match(thrown?.message ?? '', /LOCK_OWNER_REUSED/);
});

test('quality authority namespace rejects orphan and malformed artifacts without mutation', () => {
  for (const row of [
    ['orphan-successor', '.deep-loop/.init-lock-successor-orphanowner00001'],
    ['orphan-release', '.deep-loop/.init-lock-release-orphanrelease001'],
    ['malformed-prefix', '.deep-loop/.init-lock-successor-bad'],
  ]) {
    const root = fixtureDir();
    put(root, row[1], JSON.stringify({ pid: 42, nonce: 'artifactowner001',
      acquired_at: '2026-07-13T00:00:00.000Z' }));
    const before = queryTree(root);
    const calls = [];
    let thrown = null;
    try {
      withInitLock(root, () => assert.fail(row[0]), {
        pid: 7, nonce: () => 'contender0000001',
        now: () => Date.parse('2026-07-13T00:00:01.000Z'),
        writeFile: (...args) => { calls.push('write'); return writeFileSync(...args); },
        link: (...args) => { calls.push('link'); return linkSync(...args); },
        unlink: (...args) => { calls.push('unlink'); return unlinkSync(...args); },
      });
    } catch (error) { thrown = error; }
    assert.deepEqual(calls, [], row[0]);
    assert.deepEqual(queryTree(root), before, row[0]);
    assert.match(thrown?.message ?? '', /LOCK_CHAIN_INVALID/, row[0]);
  }
});

test('quality authority namespace is revalidated after candidate write before publication', () => {
  const root = fixtureDir();
  mkdirSync(join(root, '.deep-loop'));
  const candidate = join(root, '.deep-loop', '.init-lock-candidate-7-contender0000001');
  const orphan = join(root, '.deep-loop', '.init-lock-release-raceorphan000001');
  let linkCalls = 0;
  assert.throws(() => withInitLock(root, () => assert.fail('writer entered'), {
    pid: 7, nonce: () => 'contender0000001',
    now: () => Date.parse('2026-07-13T00:00:01.000Z'),
    writeFile: (path, bytes, options) => {
      writeFileSync(path, bytes, options);
      writeFileSync(orphan, 'foreign-authority-artifact');
    },
    link: (...args) => { linkCalls += 1; return linkSync(...args); },
  }), /LOCK_CHAIN_INVALID/);
  assert.equal(linkCalls, 0);
  assert.equal(existsSync(candidate), false, 'the proven invocation candidate is cleaned');
  assert.equal(readFileSync(orphan, 'utf8'), 'foreign-authority-artifact');
});

test('quality sweep ABA replacement during liveness probe is preserved', () => {
  const root = fixtureDir();
  const candidate = join(root, '.deep-loop',
    '.init-lock-candidate-42-1234567890abcdef');
  put(root, '.deep-loop/.init-lock-candidate-42-1234567890abcdef', JSON.stringify({
    pid: 42, nonce: '1234567890abcdef', acquired_at: '2026-07-13T00:00:00.000Z' }));
  const replacement = Buffer.from('foreign-sweep-aba-replacement');
  withInitLock(root, () => {}, {
    pid: 7, nonce: () => 'contender0000001',
    now: () => Date.parse('2026-07-13T00:05:00.001Z'),
    probePidIdentity: () => {
      unlinkSync(candidate);
      writeFileSync(candidate, replacement, { flag: 'wx' });
      return 'definitely-dead';
    },
  });
  assert.deepEqual(readFileSync(candidate), replacement);
});

test('quality ambiguous candidate write failures preserve foreign bytes', () => {
  const now = () => Date.parse('2026-07-13T00:00:00.000Z');
  {
    const root = fixtureDir();
    const nonce = 'ambiguousowner01';
    const candidate = join(root, '.deep-loop', '.init-lock-candidate-7-' + nonce);
    const foreign = Buffer.from('foreign-pre-existing-candidate');
    put(root, '.deep-loop/.init-lock-candidate-7-' + nonce, foreign);
    const error = Object.assign(new Error('AMBIGUOUS_WRITE'), { code: 'EIO' });
    assert.throws(() => withInitLock(root, () => assert.fail('writer entered'), {
      pid: 7, nonce: () => nonce, now,
      writeFile: () => { throw error; },
    }), /AMBIGUOUS_WRITE/);
    assert.deepEqual(readFileSync(candidate), foreign);
  }
  {
    const root = fixtureDir();
    const nonce = 'replacementown01';
    const candidate = join(root, '.deep-loop', '.init-lock-candidate-7-' + nonce);
    const foreign = Buffer.from('foreign-write-replacement');
    const error = Object.assign(new Error('REPLACED_WRITE'), { code: 'EIO' });
    assert.throws(() => withInitLock(root, () => assert.fail('writer entered'), {
      pid: 7, nonce: () => nonce, now,
      writeFile: (path, bytes, options) => {
        writeFileSync(path, bytes, options);
        unlinkSync(path);
        writeFileSync(path, foreign, { flag: 'wx' });
        throw error;
      },
    }), /REPLACED_WRITE/);
    assert.deepEqual(readFileSync(candidate), foreign);
  }
});

test('quality candidate replacement is never deleted or linked as release authority', () => {
  const now = () => Date.parse('2026-07-13T00:00:00.000Z');
  {
    const root = fixtureDir();
    const nonce = 'cleanupowner0001';
    const control = join(root, '.deep-loop');
    const candidate = join(control, '.init-lock-candidate-7-' + nonce);
    const release = join(control, '.init-lock-release-' + nonce);
    const foreign = Buffer.from('foreign-after-valid-release');
    withInitLock(root, () => {}, {
      pid: 7, nonce: () => nonce, now,
      link: (source, destination) => {
        const result = linkSync(source, destination);
        if (destination === release) {
          unlinkSync(candidate);
          writeFileSync(candidate, foreign, { flag: 'wx' });
        }
        return result;
      },
    });
    assert.deepEqual(readFileSync(candidate), foreign);
    const fixedStat = lstatSync(join(control, '.init.lock'));
    const releaseStat = lstatSync(release);
    assert.equal(fixedStat.dev, releaseStat.dev);
    assert.equal(fixedStat.ino, releaseStat.ino);
  }
  {
    const root = fixtureDir();
    const nonce = 'releaseowner0001';
    const control = join(root, '.deep-loop');
    const candidate = join(control, '.init-lock-candidate-7-' + nonce);
    const release = join(control, '.init-lock-release-' + nonce);
    const foreign = Buffer.from('foreign-before-release');
    assert.throws(() => withInitLock(root, () => {
      unlinkSync(candidate);
      writeFileSync(candidate, foreign, { flag: 'wx' });
    }, { pid: 7, nonce: () => nonce, now }), /LOCK_RELEASE_INDETERMINATE/);
    assert.deepEqual(readFileSync(candidate), foreign);
    assert.equal(existsSync(release), false,
      'a replacement candidate is never linked into release authority');
  }
});
