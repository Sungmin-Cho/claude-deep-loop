import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialLoop, resolveInitialReview } from '../scripts/lib/initrun.mjs';
import { hostSurfaceFactsDigest } from '../scripts/lib/host-surface.mjs';
import {
  buildCanonicalGenesis,
  genesisClockFromAttempt,
  hostObservationDigest,
  initializationRequestDigest,
  normalizeInitializationRequest,
} from '../scripts/lib/init-transaction.mjs';
import { verifyHeadLines, verifyLines } from '../scripts/lib/integrity.mjs';

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
  assert.deepEqual({ ...first.genesisEvents[0].data }, { run_id: attempt,
    request_digest: first.loop.initialization.request_digest,
    host_surface_digest: first.loop.initialization.host_surface_digest });
  assert.equal(Object.getPrototypeOf(first.genesisEvents[0].data), null);
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

test('genesis event and head remain verifiable under inherited toJSON pollution', () => {
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
    assert.deepEqual(verifyLines(built.genesisEvents), { ok: true, errors: [] });
    assert.deepEqual(verifyHeadLines(built.genesisEvents, built.loop.event_log_head),
      { ok: true, errors: [] });
  } finally {
    if (original) Object.defineProperty(Object.prototype, 'toJSON', original);
    else delete Object.prototype.toJSON;
  }
  assert.equal(Object.getPrototypeOf(built.genesisEvents[0].data), null);
  assert.equal(inheritedCalls, 0);
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
