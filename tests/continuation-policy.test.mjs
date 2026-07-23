import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildInitialLoop, initRun } from '../scripts/lib/initrun.mjs';
import { parseHashVerifiedStateBytes, readState, writeState } from '../scripts/lib/state.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { newWorkstream, recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { verifyHead, verifyLog } from '../scripts/lib/integrity.mjs';

const NOW = new Date('2026-07-20T00:00:00.000Z');
const noRun = () => ({ code: 1, stdout: '', stderr: '' });
const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));
function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'dl-cpol-'));
}
function initClaude(root, extra = {}) {
  return initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1, ...extra });
}
function runCli(args, { env = {} } = {}) {
  const childEnv = { ...process.env };
  delete childEnv.DEEP_LOOP_UNATTENDED;
  delete childEnv.DEEP_LOOP_HEADLESS;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...childEnv, ...env } });
}
function cappedLegacyClaude(root, { spawnStyle = 'interactive' } = {}) {
  const { runId } = initClaude(root);
  persistLegacyFixture(root, runId, { version: '0.3.0', phase: 'acquired', withEpisode: false });
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = spawnStyle;
  data.session_chain.sessions[0].turns = data.budget.per_session_turn_cap;
  writeState(root, runId, data);
  return runId;
}

function downgradeRunToLegacy(root, runId) {
  const dir = join(root, '.deep-loop', 'runs', runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = '0.2.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  for (const session of legacy.session_chain.sessions) delete session.scope;
  delete legacy.autonomy.continuation_policy;
  delete legacy.session_chain.consumed_milestones;
  delete legacy.session_chain.lease.handoff_trigger;
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  return { dir, loopPath, raw, hash: contentHash(raw) };
}

function persistLegacyFixture(root, runId, { version = '0.3.0', phase = 'idle', status = 'running', withEpisode = true } = {}) {
  const dir = join(root, '.deep-loop', 'runs', runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = version;
  legacy.status = status;
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  legacy.autonomy.continuation_policy = 'compact-in-place';
  legacy.autonomy.milestone_predicate = ['workstream_status_change'];
  legacy.episodes = withEpisode ? [{
    id: '001-maker', plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream_id: null, status: 'pending',
    request_path: join(legacy.project.root, '.deep-loop', 'runs', runId, 'episodes', '001-maker', 'request.md'),
    expected_artifacts: [], verification: {},
  }] : [];
  const parent = legacy.session_chain.sessions[0];
  delete parent.scope;
  delete parent.handoff_path;
  delete parent.handoff_rel;
  const lease = legacy.session_chain.lease;
  lease.handoff_phase = phase;
  lease.state = ['emitted', 'spawned'].includes(phase) ? 'releasing' : 'active';
  if (phase === 'reserved') {
    lease.handoff_child_run_id = 'RESERVED-CHILD';
    lease.handoff_idempotency_key = 'reserved-key';
    lease.handoff_trigger = 'milestone';
  } else if (['emitted', 'spawned'].includes(phase)) {
    const childId = `${phase.toUpperCase()}-CHILD`;
    const handoffRel = `handoffs/${childId}-next-session.md`;
    lease.handoff_child_run_id = childId;
    lease.handoff_idempotency_key = `${phase}-key`;
    lease.handoff_trigger = 'milestone';
    legacy.session_chain.sessions.push({
      run_id: childId, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null,
      handoff_rel: handoffRel,
      handoff_path: join(legacy.project.root, '.deep-loop', 'runs', runId, ...handoffRel.split('/')),
      handoff_md: `${childId}-next-session.md`, handoff_cs: `${childId}-compaction-state.json`,
    });
  }
  for (const session of legacy.session_chain.sessions) delete session.scope;
  if (status !== 'running') parent.ended_at = NOW.toISOString();
  if (version === '0.2.0') {
    delete legacy.autonomy.continuation_policy;
    delete legacy.session_chain.consumed_milestones;
    delete legacy.session_chain.lease.handoff_trigger;
  }
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  return { dir, loopPath, raw, hash: contentHash(raw), legacy };
}

test('schema: validate hard-pins 0.4.0 and requires continuation_policy', () => {
  const { runId } = initClaude(freshRoot());
  assert.ok(runId);
  const r = validate({ ...minimalValidLoop(), schema_version: '0.2.0' });
  assert.ok(r.errors.some(e => e.includes('schema_version must be 0.4.0')));
  const missing = minimalValidLoop();
  delete missing.autonomy.continuation_policy;
  const r2 = validate(missing);
  assert.ok(r2.errors.some(e => e.includes('missing required field: autonomy.continuation_policy')));
});

test('schema: all three policies remain readable and enum validation stays fail-closed', () => {
  const loop = minimalValidLoop();
  loop.autonomy.session_runtime = 'codex';
  loop.autonomy.continuation_policy = 'compact-in-place';
  const r = validate(loop);
  assert.equal(r.ok, true, r.errors.join('; '));
  loop.autonomy.continuation_policy = 'not-a-policy';
  const r2 = validate(loop);
  assert.ok(r2.errors.some(e => e.includes('invalid enum at autonomy.continuation_policy')));
});

test('migration: legacy 0.2.0 run chains through 0.3.0 to 0.4.0 in memory; disk untouched until first write', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const { loopPath: p, raw } = downgradeRunToLegacy(root, runId);

  const { data, hash } = readState(root, runId);
  assert.equal(data.schema_version, '0.4.0');
  assert.equal(data.autonomy.continuation_policy, 'rotate-per-unit');
  assert.deepEqual(data.session_chain.consumed_milestones, []);
  assert.equal(data.session_chain.lease.handoff_trigger, null);
  assert.equal(data.project.binding_generation, 1);
  assert.equal(data.autonomy.attended_launch_approval, null);
  assert.equal(data.session_chain.lease.takeover_kind, null);
  assert.equal(data.session_chain.sessions[0].scope.kind, 'legacy');
  assert.equal(hash, contentHash(raw));
  assert.equal(readFileSync(p, 'utf8'), raw);
  writeState(root, runId, data);
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).schema_version, '0.4.0');
});

test('migration matrix: direct v0.3 and chained v0.2 preserve phase/policy/child and scope only existing sessions', () => {
  for (const version of ['0.3.0', '0.2.0']) {
    for (const [phase, status] of [
      ['idle', 'running'], ['acquired', 'running'], ['reserved', 'running'],
      ['emitted', 'running'], ['spawned', 'running'], ['idle', 'completed'],
    ]) {
      const root = freshRoot();
      const { runId } = initClaude(root);
      const fixture = persistLegacyFixture(root, runId, { version, phase, status });
      const { data, hash } = readState(root, runId);
      assert.equal(data.schema_version, '0.4.0', `${version}/${phase}/${status}`);
      assert.equal(data.autonomy.continuation_policy, version === '0.2.0' ? 'rotate-per-unit' : 'compact-in-place');
      assert.deepEqual(data.autonomy.milestone_predicate, ['workstream_status_change']);
      assert.equal(data.session_chain.lease.handoff_phase, phase);
      assert.equal(data.project.binding_generation, 1);
      assert.equal(data.session_chain.lease.takeover_kind, null);
      assert.equal(data.autonomy.attended_launch_approval, null);
      assert.equal(data.episodes[0].request_rel, 'episodes/001-maker/request.md');
      assert.equal(Object.hasOwn(data.episodes[0], 'request_path'), false);
      assert.equal(data.session_chain.sessions.length, fixture.legacy.session_chain.sessions.length,
        `${version}/${phase} must not synthesize a reserved child`);
      for (const session of data.session_chain.sessions) {
        assert.deepEqual(session.scope, {
          kind: 'legacy', workstream_id: null, bound_at_seq: null, terminal_event: null,
          closed_at: session.ended_at ?? null,
        });
        assert.equal(Object.hasOwn(session, 'handoff_path'), false);
      }
      assert.equal(hash, fixture.hash);
      assert.equal(readFileSync(fixture.loopPath, 'utf8'), fixture.raw);
    }
  }
});

test('migration rejects unexpected absolute locators without mutating disk bytes', () => {
  for (const mutate of [
    legacy => { legacy.episodes[0].request_path = join(legacy.project.root, 'elsewhere', 'request.md'); },
    legacy => {
      const child = legacy.session_chain.sessions.at(-1);
      child.handoff_path = join(legacy.project.root, 'elsewhere', 'handoff.md');
    },
    legacy => { legacy.session_chain.sessions.at(-1).handoff_rel = '../escape.md'; },
  ]) {
    const root = freshRoot();
    const { runId } = initClaude(root);
    const fixture = persistLegacyFixture(root, runId, { version: '0.3.0', phase: 'emitted' });
    const legacy = JSON.parse(fixture.raw);
    mutate(legacy);
    const raw = JSON.stringify(legacy, null, 2);
    writeFileSync(fixture.loopPath, raw);
    writeFileSync(join(fixture.dir, '.loop.hash'), contentHash(raw));
    assert.throws(() => readState(root, runId), /PROJECT_LOCATOR_UNSAFE/);
    assert.equal(readFileSync(fixture.loopPath, 'utf8'), raw);
    assert.equal(readFileSync(join(fixture.dir, '.loop.hash'), 'utf8').trim(), contentHash(raw));
  }
});

test('migration derives exact legacy locators with the stored Windows grammar on a POSIX host', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const fixture = persistLegacyFixture(root, runId, { version: '0.3.0', phase: 'emitted' });
  const legacy = JSON.parse(fixture.raw);
  legacy.project.root = String.raw`C:\Fixture Project`;
  legacy.episodes[0].request_path = win32.join(
    legacy.project.root, '.deep-loop', 'runs', runId, 'episodes', legacy.episodes[0].id, 'request.md',
  );
  const child = legacy.session_chain.sessions.at(-1);
  child.handoff_path = win32.join(legacy.project.root, '.deep-loop', 'runs', runId, ...child.handoff_rel.split('/'));
  const raw = JSON.stringify(legacy, null, 2);

  const { data } = parseHashVerifiedStateBytes(root, runId, raw, contentHash(raw), { requireProjectBinding: false });
  assert.equal(data.schema_version, '0.4.0');
  assert.equal(data.episodes[0].request_rel, `episodes/${legacy.episodes[0].id}/request.md`);
  assert.equal(Object.hasOwn(data.episodes[0], 'request_path'), false);
  assert.equal(Object.hasOwn(data.session_chain.sessions.at(-1), 'handoff_path'), false);
});

test('migration E2E: read-only CLI views stay non-persistent until the first business mutation, then restart and tamper detection work', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const legacy = downgradeRunToLegacy(root, runId);
  const common = ['--project-root', root, '--run-id', runId];

  const state = runCli(['state', 'get', ...common]);
  assert.equal(state.status, 0, state.stderr);
  assert.equal(JSON.parse(state.stdout).schema_version, '0.4.0');
  assert.equal(JSON.parse(state.stdout).autonomy.continuation_policy, 'rotate-per-unit');

  const next = runCli(['next-action', ...common, '--now', NOW.toISOString()]);
  assert.equal(next.status, 0, next.stderr);
  assert.ok(JSON.parse(next.stdout).action);

  const status = runCli(['comprehension', 'status', ...common]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(typeof JSON.parse(status.stdout).debt_ratio, 'number');

  assert.equal(readFileSync(legacy.loopPath, 'utf8'), legacy.raw, 'read-only CLI commands must not persist migration');
  assert.equal(readFileSync(join(legacy.dir, '.loop.hash'), 'utf8').trim(), legacy.hash);

  const mutation = runCli([
    'budget', 'record', ...common,
    '--owner', runId, '--generation', '1', '--turns', '2', '--tokens', '3',
  ]);
  assert.equal(mutation.status, 0, mutation.stderr);

  const persisted = JSON.parse(readFileSync(legacy.loopPath, 'utf8'));
  assert.equal(persisted.schema_version, '0.4.0');
  assert.equal(persisted.autonomy.continuation_policy, 'rotate-per-unit');
  assert.deepEqual(persisted.session_chain.consumed_milestones, []);
  assert.equal(persisted.session_chain.lease.handoff_trigger, null);
  assert.equal(persisted.project.binding_generation, 1);
  assert.equal(persisted.autonomy.attended_launch_approval, null);
  assert.equal(persisted.session_chain.lease.takeover_kind, null);
  assert.equal(persisted.session_chain.sessions[0].scope.kind, 'legacy');
  assert.equal(verifyLog(root, runId).ok, true);
  assert.equal(verifyHead(root, runId, persisted.event_log_head).ok, true);

  const restarted = readState(root, runId).data;
  assert.equal(restarted.schema_version, '0.4.0');
  assert.equal(restarted.budget.spent, 2);
  assert.equal(restarted.budget.tokens_spent, 3);

  const persistedRaw = readFileSync(legacy.loopPath, 'utf8');
  const tamperedRaw = persistedRaw.replace('"goal": "g"', '"goal": "h"');
  assert.equal(tamperedRaw.length, persistedRaw.length, 'fixture tamper must replace exactly one byte');
  assert.notEqual(tamperedRaw, persistedRaw);
  writeFileSync(legacy.loopPath, tamperedRaw);
  const tampered = runCli(['state', 'get', ...common]);
  assert.equal(tampered.status, 1, tampered.stderr);
  assert.match(tampered.stderr, /STATE_TAMPERED/);
});

test('migration: invalid 0.3.0 state is not healed and cannot be persisted', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const p = join(root, '.deep-loop', 'runs', runId, 'loop.json');
  const invalid = JSON.parse(readFileSync(p, 'utf8'));
  invalid.schema_version = '0.3.0';
  delete invalid.project.binding_generation;
  delete invalid.autonomy.attended_launch_approval;
  delete invalid.session_chain.lease.takeover_kind;
  for (const session of invalid.session_chain.sessions) delete session.scope;
  invalid.session_chain.consumed_milestones = [];
  invalid.session_chain.lease.handoff_trigger = null;
  delete invalid.autonomy.continuation_policy;
  const raw = JSON.stringify(invalid, null, 2);
  writeFileSync(p, raw);
  writeFileSync(join(root, '.deep-loop', 'runs', runId, '.loop.hash'), contentHash(raw));

  const { data } = readState(root, runId);
  assert.equal(data.autonomy.continuation_policy, undefined);
  assert.throws(
    () => writeState(root, runId, data),
    /SCHEMA_INVALID: .*missing required field: autonomy\.continuation_policy/,
  );
  assert.equal(readFileSync(p, 'utf8'), raw);
});

test('migration: every partial v0.4 marker on v0.3 is rejected without changing source bytes', () => {
  const markers = [
    ['project.binding_generation', loop => { loop.project.binding_generation = 9; }],
    ['autonomy.attended_launch_approval', loop => { loop.autonomy.attended_launch_approval = null; }],
    ['session_chain.lease.takeover_kind', loop => { loop.session_chain.lease.takeover_kind = null; }],
    ['episodes[].request_rel', loop => {
      delete loop.episodes[0].request_path;
      loop.episodes[0].request_rel = 'episodes/001-maker/request.md';
    }],
    ['episodes[].invalidated_review_claims', loop => { loop.episodes[0].invalidated_review_claims = []; }],
    ['sessions[].scope', loop => {
      loop.session_chain.sessions[0].scope = {
        kind: 'workstream', workstream_id: null, bound_at_seq: null, terminal_event: null,
        closed_at: null, superseded_at: null,
      };
    }],
    ['sessions[].handoff_rel without its authentic v0.3 handoff_path', loop => {
      delete loop.session_chain.sessions.at(-1).handoff_path;
    }],
    ['sessions[].recovered_from', loop => { loop.session_chain.sessions[0].recovered_from = 'OLD'; }],
    ['sessions[].recovery_kind', loop => { loop.session_chain.sessions[0].recovery_kind = 'boundary-recovery'; }],
    ['sessions[].recovery_rel', loop => { loop.session_chain.sessions[0].recovery_rel = 'recoveries/r.json'; }],
    ['sessions[].recovery_sha256', loop => { loop.session_chain.sessions[0].recovery_sha256 = 'a'.repeat(64); }],
    ['scope.supersede_reason', loop => {
      loop.session_chain.sessions[0].scope = {
        kind: 'workstream', workstream_id: 'ws', bound_at_seq: 1, terminal_event: null,
        closed_at: null, superseded_at: NOW.toISOString(), supersede_reason: 'boundary-recovery',
      };
    }],
    ['scope.superseded_by', loop => {
      loop.session_chain.sessions[0].scope = {
        kind: 'workstream', workstream_id: 'ws', bound_at_seq: 1, terminal_event: null,
        closed_at: null, superseded_at: NOW.toISOString(), superseded_by: 'NEXT',
      };
    }],
  ];

  for (const [label, mutate] of markers) {
    const root = freshRoot();
    const { runId } = initClaude(root);
    const fixture = persistLegacyFixture(root, runId, { version: '0.3.0', phase: 'emitted' });
    const partial = JSON.parse(fixture.raw);
    mutate(partial);
    const raw = JSON.stringify(partial, null, 2);
    const hash = contentHash(raw);
    const hashPath = join(fixture.dir, '.loop.hash');
    writeFileSync(fixture.loopPath, raw);
    writeFileSync(hashPath, hash);

    const { data } = readState(root, runId);
    assert.equal(data.schema_version, '0.3.0', label);
    assert.throws(() => writeState(root, runId, data), /SCHEMA_INVALID/, label);
    assert.equal(readFileSync(fixture.loopPath, 'utf8'), raw, `${label}: loop bytes`);
    assert.equal(readFileSync(hashPath, 'utf8'), hash, `${label}: hash bytes`);
  }
});

test('schema: continuation state fields enforce their exact types', () => {
  const consumedNotArray = minimalValidLoop();
  consumedNotArray.session_chain.consumed_milestones = 'bad';
  assert.ok(validate(consumedNotArray).errors.some(e => e.includes('consumed_milestones must be an array of strings')));

  const consumedNonString = minimalValidLoop();
  consumedNonString.session_chain.consumed_milestones = [1];
  assert.ok(validate(consumedNonString).errors.some(e => e.includes('consumed_milestones must be an array of strings')));

  const triggerNotString = minimalValidLoop();
  triggerNotString.session_chain.lease.handoff_trigger = 7;
  assert.ok(validate(triggerNotString).errors.some(e => e.includes('handoff_trigger must be string or null')));
});

test('schema: continuation state fields remain validated when autonomy is absent', () => {
  const loop = minimalValidLoop();
  delete loop.autonomy;
  loop.session_chain.consumed_milestones = 'bad';
  loop.session_chain.lease.handoff_trigger = 7;

  const result = validate(loop);

  assert.ok(result.errors.some(error => error.includes('missing required field: autonomy')));
  assert.ok(result.errors.some(error => error.includes('consumed_milestones must be an array of strings')));
  assert.ok(result.errors.some(error => error.includes('handoff_trigger must be string or null')));
});

test('buildInitialLoop gives both runtimes the identical workstream-session defaults', () => {
  const cl = buildInitialLoop({ runtime: 'claude', runId: 'c', goal: 'g', recipe: {}, now: NOW, env: {}, platform: 'linux', run: noRun });
  assert.equal(cl.autonomy.continuation_policy, 'workstream-session');
  assert.deepEqual(cl.autonomy.milestone_predicate, ['bound_workstream_first_terminal']);
  const cx = buildInitialLoop({ runtime: 'codex', runId: 'x', goal: 'g', recipe: {}, now: NOW, env: {}, platform: 'linux', run: noRun });
  assert.equal(cx.autonomy.continuation_policy, 'workstream-session');
  assert.deepEqual(cx.autonomy.milestone_predicate, ['bound_workstream_first_terminal']);
});

test('initRun: claude defaults to workstream-session with one unbound scope', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.continuation_policy, 'workstream-session');
  assert.deepEqual(data.autonomy.milestone_predicate, ['bound_workstream_first_terminal']);
  assert.equal(data.autonomy.spawn_style, 'interactive');
  assert.deepEqual(data.session_chain.sessions[0].scope, {
    kind: 'workstream', workstream_id: null, bound_at_seq: null, terminal_event: null,
    closed_at: null, superseded_at: null,
  });
  assert.deepEqual(data.session_chain.consumed_milestones, []);
  assert.equal(data.session_chain.lease.handoff_trigger, null);
});

test('initRun: codex defaults to the same workstream-session policy', () => {
  const root = freshRoot();
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1 });
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.continuation_policy, 'workstream-session');
  assert.deepEqual(data.autonomy.milestone_predicate, ['bound_workstream_first_terminal']);
});

test('initRun accepts only workstream-session and rejects legacy/unknown names before creating files', () => {
  for (const continuation of ['compact-in-place', 'rotate-per-unit', 'unknown-policy']) {
    const root = freshRoot();
    assert.throws(() => initClaude(root, { continuation }), /UNSUPPORTED_RUNTIME_POLICY/);
    assert.equal(existsSync(join(root, '.deep-loop')), false, continuation);
  }
  assert.equal(initClaude(freshRoot(), { continuation: 'workstream-session' }).loop.autonomy.continuation_policy, 'workstream-session');
});

test('CLI init-run: workstream-session persists and named legacy values exit 1', () => {
  const validRoot = freshRoot();
  const valid = runCli(['init-run', '--runtime', 'claude', '--goal', 'g', '--continuation', 'workstream-session', '--project-root', validRoot]);
  assert.equal(valid.status, 0, valid.stderr);
  const { run_id: runId } = JSON.parse(valid.stdout);
  assert.equal(readState(validRoot, runId).data.autonomy.continuation_policy, 'workstream-session');

  for (const continuation of ['compact-in-place', 'rotate-per-unit']) {
    const invalidRoot = freshRoot();
    const invalid = runCli(['init-run', '--runtime', 'codex', '--goal', 'g', '--continuation', continuation, '--project-root', invalidRoot]);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /UNSUPPORTED_RUNTIME_POLICY/);
    assert.equal(existsSync(join(invalidRoot, '.deep-loop')), false);
  }
});

test('CLI init-run: value-less --continuation is usage exit 2', () => {
  const root = freshRoot();
  const result = runCli(['init-run', '--runtime', 'claude', '--goal', 'g', '--project-root', root, '--continuation']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /USAGE: --continuation <workstream-session>/);
});

test('CLI next-action: migrated compact-in-place --unattended derives legacy handoff at the cap', () => {
  const root = freshRoot();
  const runId = cappedLegacyClaude(root);
  const result = runCli(['next-action', '--project-root', root, '--run-id', runId, '--now', NOW.toISOString(), '--unattended']);
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).action;
  assert.equal(action.type, 'handoff');
  assert.equal(action.reason, 'per_session_turn_cap');
});

test('CLI next-action: migrated compact-in-place headless style derives legacy handoff without env markers', () => {
  const root = freshRoot();
  const runId = cappedLegacyClaude(root, { spawnStyle: 'headless' });
  const result = runCli(['next-action', '--project-root', root, '--run-id', runId, '--now', NOW.toISOString()]);
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).action;
  assert.equal(action.type, 'handoff');
  assert.equal(action.reason, 'per_session_turn_cap');
});

test('CLI next-action: migrated compact-in-place honors the DEEP_LOOP_UNATTENDED marker', () => {
  const root = freshRoot();
  const runId = cappedLegacyClaude(root);
  const result = runCli(
    ['next-action', '--project-root', root, '--run-id', runId, '--now', NOW.toISOString()],
    { env: { DEEP_LOOP_UNATTENDED: '1' } },
  );
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).action;
  assert.equal(action.type, 'handoff');
  assert.equal(action.reason, 'per_session_turn_cap');
});

test('CLI next-action: attended compact-in-place returns real action with cap advice', () => {
  const root = freshRoot();
  const runId = cappedLegacyClaude(root);
  const result = runCli(['next-action', '--project-root', root, '--run-id', runId, '--now', NOW.toISOString()]);
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).action;
  assert.equal(action.type, 'discover');
  assert.equal(action.advice, 'compact');
  assert.equal(action.advice_reason, 'per_session_turn_cap');
});

test('legacy milestone cursor: terminal transition records identity; emit consumes it; child does not re-emit', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  persistLegacyFixture(root, runId, { version: '0.3.0', withEpisode: false });
  const fence = { owner: runId, generation: 1 };
  const { id: wsId } = newWorkstream(root, runId, {
    title: 'cursor test', branch: 'test/cursor', worktree: '.claude/worktrees/cursor-test', fence,
  });
  recordWorkstreamTerminal(root, runId, wsId, {
    status: 'abandoned', proof: { reason: 'test' }, fence,
  });

  const { data: afterTerminal } = readState(root, runId);
  const ws = afterTerminal.workstreams.find(w => w.id === wsId);
  assert.equal(ws.terminal_events.length, 1);
  assert.match(ws.terminal_events[0], /^\d+:ws-/);
  assert.deepEqual(nextAction(afterTerminal, { now: NOW }).gate.unconsumed_milestones, [ws.terminal_events[0]]);

  const emitted = emitHandoff(root, runId, {
    reason: 'milestone', trigger: 'milestone', now: NOW.getTime(), headless: false,
    expect: fence, env: {},
  });
  assert.ok(emitted.ok);
  const { data: afterEmit } = readState(root, runId);
  assert.deepEqual(afterEmit.session_chain.consumed_milestones, [ws.terminal_events[0]]);
  assert.deepEqual(nextAction(afterEmit, { now: NOW }).gate.unconsumed_milestones, []);

  const acquired = acquireLease(root, runId, {
    owner: emitted.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW.getTime() + 1,
  });
  assert.ok(acquired.ok);
  const childFence = { owner: emitted.childRunId, generation: 2 };
  assert.deepEqual(nextAction(readState(root, runId).data, { now: NOW }).gate.unconsumed_milestones, []);

  const { id: nextWsId } = newWorkstream(root, runId, {
    title: 'next cursor', branch: 'test/next-cursor', worktree: '.claude/worktrees/next-cursor', fence: childFence,
  });
  recordWorkstreamTerminal(root, runId, nextWsId, {
    status: 'abandoned', proof: { reason: 'next test' }, fence: childFence,
  });
  const { data: afterNextTerminal } = readState(root, runId);
  const nextEvent = afterNextTerminal.workstreams.find(w => w.id === nextWsId).terminal_events[0];
  assert.deepEqual(nextAction(afterNextTerminal, { now: NOW }).gate.unconsumed_milestones, [nextEvent]);
});

test('legacy milestone cursor: pre-compact handoff consumes terminal transition before milestone trigger', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  persistLegacyFixture(root, runId, { version: '0.3.0', withEpisode: false });
  const fence = { owner: runId, generation: 1 };
  const { id: wsId } = newWorkstream(root, runId, {
    title: 'precompact cursor', branch: 'test/precompact-cursor', worktree: '.claude/worktrees/precompact-cursor', fence,
  });
  recordWorkstreamTerminal(root, runId, wsId, {
    status: 'abandoned', proof: { reason: 'precompact test' }, fence,
  });
  const terminalEvent = readState(root, runId).data.workstreams.find(w => w.id === wsId).terminal_events[0];

  const emitted = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'precompact', now: NOW.getTime(), headless: false,
    expect: fence, env: {},
  });
  assert.ok(emitted.ok);
  const afterEmit = readState(root, runId).data;
  assert.deepEqual(afterEmit.session_chain.consumed_milestones, [terminalEvent]);

  const acquired = acquireLease(root, runId, {
    owner: emitted.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW.getTime() + 1,
  });
  assert.ok(acquired.ok);
  assert.deepEqual(nextAction(readState(root, runId).data, { now: NOW }).gate.unconsumed_milestones, []);
});

test('legacy milestone cursor: ready then merged preserves and consumes both terminal identities', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  persistLegacyFixture(root, runId, { version: '0.3.0', withEpisode: false });
  const fence = { owner: runId, generation: 1 };
  const { id: wsId } = newWorkstream(root, runId, {
    title: 'ready merged cursor', branch: 'test/ready-merged', worktree: '.claude/worktrees/ready-merged', fence,
  });
  const seeded = readState(root, runId).data;
  seeded.workstreams.find(w => w.id === wsId).review_points_done = [...seeded.review.points];
  writeState(root, runId, seeded);

  recordWorkstreamTerminal(root, runId, wsId, { status: 'ready', proof: {}, fence });
  recordWorkstreamTerminal(root, runId, wsId, {
    status: 'merged', proof: { merge_commit: 'abc123', human_approved: true }, fence,
  });
  const beforeEmit = readState(root, runId).data;
  const terminalEvents = beforeEmit.workstreams.find(w => w.id === wsId).terminal_events;
  assert.equal(terminalEvents.length, 2);
  assert.match(terminalEvents[0], /^\d+:ws-.*:ready$/);
  assert.match(terminalEvents[1], /^\d+:ws-.*:merged$/);
  assert.deepEqual(nextAction(beforeEmit, { now: NOW }).gate.unconsumed_milestones, terminalEvents);

  const emitted = emitHandoff(root, runId, {
    reason: 'milestone', trigger: 'milestone', now: NOW.getTime(), headless: false,
    expect: fence, env: {},
  });
  assert.ok(emitted.ok);
  assert.deepEqual(readState(root, runId).data.session_chain.consumed_milestones, terminalEvents);
});

test('legacy CLI handoff emit without milestone flag consumes derived terminal identities', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  persistLegacyFixture(root, runId, { version: '0.3.0', withEpisode: false });
  const fence = { owner: runId, generation: 1 };
  const { id: wsId } = newWorkstream(root, runId, {
    title: 'cli cursor', branch: 'test/cli-cursor', worktree: '.claude/worktrees/cli-cursor', fence,
  });
  recordWorkstreamTerminal(root, runId, wsId, {
    status: 'abandoned', proof: { reason: 'cli test' }, fence,
  });
  const terminalEvent = readState(root, runId).data.workstreams.find(w => w.id === wsId).terminal_events[0];

  const result = runCli([
    'handoff', 'emit', '--project-root', root, '--run-id', runId,
    '--owner', runId, '--generation', '1', '--reason', 'milestone',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).ok);
  assert.deepEqual(readState(root, runId).data.session_chain.consumed_milestones, [terminalEvent]);
});

function minimalValidLoop() {
  const root = freshRoot();
  const { runId } = initClaude(root);
  return readState(root, runId).data;
}
