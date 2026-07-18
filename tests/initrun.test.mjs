import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun, buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { DEFAULT_APP_TASK_CONTINUATION } from '../scripts/lib/app-task-continuation.mjs';

// Inject a no-signal env + no-op probe so detect-terminal deterministically yields launcher:'none'
// regardless of the developer's ambient terminal environment.
const noSignalEnv = {};
const noSignalPlatform = 'linux';
const noOpRun = () => ({ code: 1 });

const validCreateObservation = (overrides = {}) => ({
  kind: 'codex-app', source: 'codex-app-host-context',
  host_task_cwd_source: 'app-task-context', host_task_cwd: '/project',
  kernel_cwd_at_observation: '/project', observed_generation: 1,
  structured_stdin_mode: 'pipe-open-noecho',
  capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
  ...overrides,
});

const validAutoConsent = () => ({
  mode: 'auto', authority: 'human-confirmed',
  confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null,
});

const buildAppGenesis = (overrides = {}) => buildInitialLoop({
  runtime: 'codex', goal: 'g', protocol: 'standalone', recipe: {},
  runId: '01JAPPBOUNDARY0000000000000',
  now: new Date('2026-07-13T00:00:00.000Z'), sessionSpawn: null,
  ...overrides,
});

test('buildInitialLoop autonomy defaults — spawn_style visible, new fields', () => {
  const loop = buildInitialLoop({ runtime: 'claude', runId: 'r2', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun });
  assert.equal(loop.autonomy.spawn_style, 'visible');
  assert.ok(!loop.autonomy.unattended_detect.includes('non-tty'), `unattended_detect must not include 'non-tty': ${JSON.stringify(loop.autonomy.unattended_detect)}`);
  assert.ok(loop.autonomy.unattended_detect.includes('headless-invocation'), `unattended_detect must include 'headless-invocation': ${JSON.stringify(loop.autonomy.unattended_detect)}`);
  assert.equal(loop.autonomy.child_ready_timeout_sec, 75);
  assert.ok(!('allow_powershell_visible' in loop.autonomy), 'allow_powershell_visible gate removed (PowerShell auto-detects)');
  assert.ok(loop.session_spawn !== undefined && loop.session_spawn !== null, 'session_spawn must be a valid descriptor');
  assert.equal(loop.session_spawn.launcher, 'none');
  assert.equal(loop.session_spawn.reason, 'no-host-signal');  // detectTerminal result for linux/no-signals
  assert.equal(loop.session_spawn.detected_at, '2026-06-27T00:00:00.000Z');
});

test('buildInitialLoop records explicit claude and codex runtime', () => {
  for (const runtime of ['claude', 'codex']) {
    const loop = buildInitialLoop({ runtime, runId: `runtime-${runtime}`, goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun });
    assert.equal(loop.autonomy.session_runtime, runtime);
    assert.equal(loop.autonomy.runtime_source, 'skill-asserted');
  }
});

test('native win32 WT initialization stays manual until a launcher is durably approved', () => {
  let processCalls = 0;
  const loop = buildInitialLoop({
    runtime: 'claude', runId: 'win32-unapproved', goal: 'g', recipe: {},
    now: new Date('2026-07-12T00:00:00Z'), env: { WT_SESSION: 'session-1' }, platform: 'win32',
    run: () => { processCalls++; return { code: 0 }; },
  });

  assert.deepEqual(loop.autonomy.launcher_executable_approvals, { wt: null, powershell: null });
  assert.equal(loop.session_spawn.launcher, 'none');
  assert.equal(loop.session_spawn.reason, 'windows-terminal-unverified');
  assert.equal(loop.session_spawn.reachable, false);
  assert.equal(loop.session_spawn.fallback, 'launch-command-file');
  assert.equal(processCalls, 0, 'unapproved launcher code and PATH probes must remain unreachable');
});

test('explicit codex runtime wins when both Claude and Codex markers exist', () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-py', CODEX_THREAD_ID: 'thread-1' };
  const loop = buildInitialLoop({ runtime: 'codex', runId: 'runtime-codex', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z'), env, platform: noSignalPlatform, run: noOpRun });
  assert.equal(loop.autonomy.session_runtime, 'codex');
  assert.equal(loop.autonomy.runtime_source, 'skill-asserted');
});

test('initRun creates state, current pointer, valid schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T15:42:00Z') });
  assert.ok(existsSync(join(runDir(root, runId), 'loop.json')));
  assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), runId);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.routing.protocol, 'deep-work');
  assert.equal(data.recipe.id, 'robust-implementation');
  assert.deepEqual(data.review.points, ['design', 'plan', 'implementation']);
  assert.equal(data.autonomy.tier, 'recommend'); // 기본
  assert.equal(data.session_chain.lease.owner_run_id, runId);
});

// ── C2: object-shape initial reviewer selection — routes on present (installed‖initialized) ───
test('C2: initRun review.reviewer routes on present (object shape)', () => {
  const r1 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { runtime: 'claude', goal: 'g', detected: { 'deep-review': { present: false } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r1.loop.review.reviewer, 'subagent-checker');
  const r2 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { runtime: 'claude', goal: 'g', detected: { 'deep-review': { present: true } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r2.loop.review.reviewer, 'deep-review-loop');
  // installed-but-uninitialized (original Problem C) → present:true → deep-review-loop
  const r3 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { runtime: 'claude', goal: 'g', detected: { 'deep-review': { installed: true, initialized: false, present: true } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r3.loop.review.reviewer, 'deep-review-loop');
});

test('initRun seeds autonomy.session_model/effort when provided (WS1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ir-'));
  const { loop } = initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }), model: 'claude-opus-4-8[1m]', effort: 'xhigh' });
  assert.equal(loop.autonomy.session_model, 'claude-opus-4-8[1m]');
  assert.equal(loop.autonomy.session_effort, 'xhigh');
});

test('initRun omits session_model/effort when not provided (backward compat)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ir-'));
  const { loop } = initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }) });
  assert.equal(loop.autonomy.session_model, undefined);
  assert.equal(loop.autonomy.session_effort, undefined);
});

test('initRun rejects invalid effort (WS1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ir-'));
  assert.throws(() => initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }), effort: 'ultra' }), /INVALID_EFFORT/);
});

test('initRun rejects missing and invalid runtime before creating files', () => {
  for (const [label, options] of [
    ['missing', {}],
    ['invalid', { runtime: 'other' }],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `dl-runtime-${label}-`));
    assert.throws(() => initRun(root, { goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), ...options }), /INVALID_RUNTIME/);
    assert.equal(existsSync(join(root, '.deep-loop')), false, `${label} runtime must not create .deep-loop`);
  }
});

test('new runs reject the legacy standalone reviewer before creating durable state', () => {
  assert.throws(
    () => buildInitialLoop({ runtime: 'claude', runId: 'legacy-reviewer', goal: 'g', recipe: {}, review: { reviewer: 'standalone' }, now: new Date('2026-07-11T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun }),
    /REVIEWER_STANDALONE_INVALID/
  );
  const root = mkdtempSync(join(tmpdir(), 'dl-legacy-reviewer-'));
  assert.throws(
    () => initRun(root, { runtime: 'claude', goal: 'g', review: { reviewer: 'standalone' }, now: new Date('2026-07-11T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun }),
    /REVIEWER_STANDALONE_INVALID/
  );
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('new production genesis records manual consent and caller-fixed initialization', () => {
  const loop = buildInitialLoop({
    runtime: 'codex', goal: 'g', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: 'test' },
    runId: '01JAPPGEN00000000000000000', now: new Date('2026-07-13T00:00:00.000Z'),
    initialization: {
      attempt_id: '01JAPPGEN00000000000000000', request_digest: 'a'.repeat(64),
      request_projection: {},
      previous_current_digest: 'NONE', host_observation_digest: 'NONE',
      host_surface_digest: 'NONE',
    },
  });
  assert.deepEqual(loop.autonomy.app_task_continuation, {
    mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
  });
  assert.deepEqual(loop.initialization, {
    attempt_id: '01JAPPGEN00000000000000000', request_digest: 'a'.repeat(64),
    request_projection: {},
    previous_current_digest: 'NONE', host_observation_digest: 'NONE',
    host_surface_digest: 'NONE',
  });
  assert.equal(loop.session_chain.sessions[0].host_surface, null);
  assert.equal(loop.session_chain.lease.handoff_transport, null);
  assert.equal(loop.session_chain.lease.handoff_attempt_id, null);
  const next = buildInitialLoop({ runtime: 'codex', goal: 'next', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: 'test' }, runId: '01JAPPGEN00000000000000001',
    now: new Date('2026-07-13T00:00:01.000Z') });
  assert.deepEqual(next.autonomy.app_task_continuation, {
    mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
  });
});

test('direct legacy builder call may omit initialization', () => {
  const loop = buildInitialLoop({ runtime: 'claude', goal: 'legacy', protocol: 'standalone',
    recipe: { id: 'r', name: 'r', reason: 'test' }, runId: '01JAPPGEN00000000000000003',
    now: new Date('2026-07-13T00:00:00.000Z') });
  assert.equal(Object.hasOwn(loop, 'initialization'), false);
  assert.equal(loop.session_chain.sessions[0].host_surface, null);
});

test('App genesis rejects an invalid explicit auto consent without route or observation', () => {
  assert.throws(
    () => buildAppGenesis({ appContinuationConsent: {
      mode: 'auto', authority: 'human-confirmed', confirmed_at: '', revoked_at: null,
    } }),
    /APP_CONSENT_INVALID/
  );
});

test('App genesis stores valid create auto consent by value', () => {
  const consent = validAutoConsent();
  const loop = buildAppGenesis({
    appContinuationRoute: 'create', hostObservation: validCreateObservation(),
    appContinuationConsent: consent,
  });
  assert.deepEqual(loop.autonomy.app_task_continuation, consent);
  assert.notStrictEqual(loop.autonomy.app_task_continuation, consent);
});

test('App genesis rejects every incomplete or mismatched auto consent boundary', () => {
  const base = {
    appContinuationRoute: 'create', hostObservation: validCreateObservation(),
    appContinuationConsent: validAutoConsent(),
  };
  const cases = [
    ['missing route', { appContinuationRoute: null }],
    ['unknown route', { appContinuationRoute: 'resume' }],
    ['route capability mismatch', { hostObservation: validCreateObservation({
      capabilities: ['list-projects', 'create-thread-local'],
    }) }],
    ['later generation', { hostObservation: validCreateObservation({ observed_generation: 2 }) }],
    ['malformed confirmation', { appContinuationConsent: {
      ...validAutoConsent(), confirmed_at: 'not-a-timestamp',
    } }],
    ['wrong runtime', { runtime: 'claude' }],
    ['wrong source', { hostObservation: validCreateObservation({ source: 'codex-cli' }) }],
    ['cwd mismatch', { hostObservation: validCreateObservation({ host_task_cwd: '/other' }) }],
    ['stdin mode mismatch', { hostObservation: validCreateObservation({
      structured_stdin_mode: 'pipe-open',
    }) }],
  ];
  for (const [label, override] of cases) {
    assert.throws(() => buildAppGenesis({ ...base, ...override }), /APP_CONSENT_INVALID/, label);
  }
});

test('App genesis manual default is fresh and never aliases the frozen constant', () => {
  const first = buildAppGenesis();
  assert.notStrictEqual(first.autonomy.app_task_continuation, DEFAULT_APP_TASK_CONTINUATION);
  first.autonomy.app_task_continuation.mode = 'auto';
  const second = buildAppGenesis({ runId: '01JAPPBOUNDARY0000000000001' });
  assert.deepEqual(second.autonomy.app_task_continuation, DEFAULT_APP_TASK_CONTINUATION);
  assert.equal(DEFAULT_APP_TASK_CONTINUATION.mode, 'manual');
  assert.notStrictEqual(second.autonomy.app_task_continuation,
    first.autonomy.app_task_continuation);
});

test('App genesis preserves generation-one host observation with clone isolation', () => {
  const observation = validCreateObservation();
  const loop = buildAppGenesis({
    appContinuationRoute: 'create', hostObservation: observation,
    appContinuationConsent: validAutoConsent(),
  });
  const stored = loop.session_chain.sessions[0].host_surface;
  assert.equal(stored.observed_generation, 1);
  assert.notStrictEqual(stored, observation);
  assert.notStrictEqual(stored.capabilities, observation.capabilities);
  observation.capabilities.push('caller-mutation');
  assert.equal(stored.capabilities.includes('caller-mutation'), false);
});

test('App genesis stores precomputed project and session surfaces without probing', () => {
  let probeCalls = 0;
  const sessionSpawn = { launcher: 'precomputed', nested: { fixed: true } };
  const loop = buildAppGenesis({
    projectRoot: '/project', sessionSpawn,
    run: () => { probeCalls++; throw new Error('terminal probe must not run'); },
  });
  assert.equal(loop.project.root, '/project');
  assert.deepEqual(loop.session_spawn, sessionSpawn);
  assert.notStrictEqual(loop.session_spawn, sessionSpawn);
  assert.notStrictEqual(loop.session_spawn.nested, sessionSpawn.nested);
  assert.equal(probeCalls, 0);
});

test('App genesis clones caller-owned initialization review consent and session spawn', () => {
  const initialization = { request_projection: { fixed: true } };
  const review = { reviewer: 'subagent-checker', points: ['implementation'],
    flags: ['--contract'] };
  const consent = { ...DEFAULT_APP_TASK_CONTINUATION };
  const sessionSpawn = { launcher: 'precomputed', nested: { fixed: true } };
  const loop = buildAppGenesis({ initialization, review,
    appContinuationConsent: consent, sessionSpawn });
  for (const [stored, input] of [
    [loop.initialization, initialization], [loop.review, review],
    [loop.autonomy.app_task_continuation, consent], [loop.session_spawn, sessionSpawn],
  ]) assert.notStrictEqual(stored, input);
  assert.notStrictEqual(loop.initialization.request_projection,
    initialization.request_projection);
  assert.notStrictEqual(loop.review.points, review.points);
  assert.notStrictEqual(loop.session_spawn.nested, sessionSpawn.nested);
  initialization.request_projection.fixed = false;
  review.points.push('caller-mutation');
  sessionSpawn.nested.fixed = false;
  assert.equal(loop.initialization.request_projection.fixed, true);
  assert.deepEqual(loop.review.points, ['implementation']);
  assert.equal(loop.session_spawn.nested.fixed, true);
});

test('App genesis fails loudly for unsupported structured-clone input', () => {
  assert.throws(
    () => buildAppGenesis({ initialization: { unsupported() {} } }),
    error => error?.name === 'DataCloneError'
  );
});
