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
