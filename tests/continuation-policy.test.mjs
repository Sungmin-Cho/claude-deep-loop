import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildInitialLoop, initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { newWorkstream, recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';

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
function cappedClaude(root, { spawnStyle = 'visible' } = {}) {
  const { runId } = initClaude(root);
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = spawnStyle;
  data.session_chain.sessions[0].turns = data.budget.per_session_turn_cap;
  writeState(root, runId, data);
  return runId;
}

test('schema: validate hard-pins 0.3.0 and requires continuation_policy', () => {
  const { runId } = initClaude(freshRoot());
  assert.ok(runId);
  const r = validate({ ...minimalValidLoop(), schema_version: '0.2.0' });
  assert.ok(r.errors.some(e => e.includes('schema_version must be 0.3.0')));
  const missing = minimalValidLoop();
  delete missing.autonomy.continuation_policy;
  const r2 = validate(missing);
  assert.ok(r2.errors.some(e => e.includes('missing required field: autonomy.continuation_policy')));
});

test('schema: cross-field — codex cannot be compact-in-place (enum first, then cross-field)', () => {
  const loop = minimalValidLoop();
  loop.autonomy.session_runtime = 'codex';
  loop.autonomy.continuation_policy = 'compact-in-place';
  const r = validate(loop);
  assert.ok(r.errors.some(e => e.includes('continuation_policy compact-in-place requires session_runtime claude')));
  loop.autonomy.continuation_policy = 'not-a-policy';
  const r2 = validate(loop);
  assert.ok(r2.errors.some(e => e.includes('invalid enum at autonomy.continuation_policy')));
});

test('migration: legacy 0.2.0 run reads as 0.3.0 rotate-per-unit in memory; disk untouched until first write', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const p = join(root, '.deep-loop', 'runs', runId, 'loop.json');
  const legacy = JSON.parse(readFileSync(p, 'utf8'));
  legacy.schema_version = '0.2.0';
  delete legacy.autonomy.continuation_policy;
  delete legacy.session_chain.consumed_milestones;
  delete legacy.session_chain.lease.handoff_trigger;
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(p, raw);
  writeFileSync(join(root, '.deep-loop', 'runs', runId, '.loop.hash'), contentHash(raw));

  const { data, hash } = readState(root, runId);
  assert.equal(data.schema_version, '0.3.0');
  assert.equal(data.autonomy.continuation_policy, 'rotate-per-unit');
  assert.deepEqual(data.session_chain.consumed_milestones, []);
  assert.equal(data.session_chain.lease.handoff_trigger, null);
  assert.equal(hash, contentHash(raw));
  assert.equal(readFileSync(p, 'utf8'), raw);
  writeState(root, runId, data);
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).schema_version, '0.3.0');
});

test('migration: invalid 0.3.0 state is not healed and cannot be persisted', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const p = join(root, '.deep-loop', 'runs', runId, 'loop.json');
  const invalid = JSON.parse(readFileSync(p, 'utf8'));
  invalid.schema_version = '0.3.0';
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

test('buildInitialLoop derives per-runtime continuation policy + predicate', () => {
  const cl = buildInitialLoop({ runtime: 'claude', runId: 'c', goal: 'g', recipe: {}, now: NOW, env: {}, platform: 'linux', run: noRun });
  assert.equal(cl.autonomy.continuation_policy, 'compact-in-place');
  assert.deepEqual(cl.autonomy.milestone_predicate, ['workstream_status_change']);
  const cx = buildInitialLoop({ runtime: 'codex', runId: 'x', goal: 'g', recipe: {}, now: NOW, env: {}, platform: 'linux', run: noRun });
  assert.equal(cx.autonomy.continuation_policy, 'rotate-per-unit');
  assert.deepEqual(cx.autonomy.milestone_predicate, ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached']);
  const ov = buildInitialLoop({ runtime: 'claude', continuationPolicy: 'rotate-per-unit', runId: 'o', goal: 'g', recipe: {}, now: NOW, env: {}, platform: 'linux', run: noRun });
  assert.equal(ov.autonomy.continuation_policy, 'rotate-per-unit');
});

test('initRun: claude defaults to compact-in-place with single milestone predicate', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.continuation_policy, 'compact-in-place');
  assert.deepEqual(data.autonomy.milestone_predicate, ['workstream_status_change']);
  assert.deepEqual(data.session_chain.consumed_milestones, []);
  assert.equal(data.session_chain.lease.handoff_trigger, null);
});

test('initRun: codex defaults to rotate-per-unit with legacy 3 predicates', () => {
  const root = freshRoot();
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1 });
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.continuation_policy, 'rotate-per-unit');
  assert.deepEqual(data.autonomy.milestone_predicate,
    ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached']);
});

test('initRun: claude + rotate-per-unit override restores legacy predicates', () => {
  const root = freshRoot();
  const { runId } = initClaude(root, { continuation: 'rotate-per-unit' });
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.continuation_policy, 'rotate-per-unit');
  assert.deepEqual(data.autonomy.milestone_predicate,
    ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached']);
});

test('initRun: codex + compact-in-place rejected with UNSUPPORTED_RUNTIME_POLICY', () => {
  assert.throws(
    () => initRun(freshRoot(), { runtime: 'codex', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1, continuation: 'compact-in-place' }),
    /UNSUPPORTED_RUNTIME_POLICY/,
  );
});

test('initRun: unknown continuation policy is rejected', () => {
  assert.throws(
    () => initClaude(freshRoot(), { continuation: 'unknown-policy' }),
    /UNSUPPORTED_RUNTIME_POLICY: unknown continuation policy unknown-policy/,
  );
});

test('CLI init-run: continuation override persists and invalid combinations exit 1', () => {
  const validRoot = freshRoot();
  const valid = runCli(['init-run', '--runtime', 'claude', '--goal', 'g', '--continuation', 'rotate-per-unit', '--project-root', validRoot]);
  assert.equal(valid.status, 0, valid.stderr);
  const { run_id: runId } = JSON.parse(valid.stdout);
  assert.equal(readState(validRoot, runId).data.autonomy.continuation_policy, 'rotate-per-unit');

  const invalidRoot = freshRoot();
  const invalid = runCli(['init-run', '--runtime', 'codex', '--goal', 'g', '--continuation', 'compact-in-place', '--project-root', invalidRoot]);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /UNSUPPORTED_RUNTIME_POLICY/);
});

test('CLI init-run: value-less --continuation is usage exit 2', () => {
  const root = freshRoot();
  const result = runCli(['init-run', '--runtime', 'claude', '--goal', 'g', '--project-root', root, '--continuation']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /USAGE: --continuation <compact-in-place\|rotate-per-unit>/);
});

test('CLI next-action: --unattended derives handoff at the cap', () => {
  const root = freshRoot();
  const runId = cappedClaude(root);
  const result = runCli(['next-action', '--project-root', root, '--run-id', runId, '--now', NOW.toISOString(), '--unattended']);
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).action;
  assert.equal(action.type, 'handoff');
  assert.equal(action.reason, 'per_session_turn_cap');
});

test('CLI next-action: durable headless spawn style derives handoff without env markers', () => {
  const root = freshRoot();
  const runId = cappedClaude(root, { spawnStyle: 'headless' });
  const result = runCli(['next-action', '--project-root', root, '--run-id', runId, '--now', NOW.toISOString()]);
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).action;
  assert.equal(action.type, 'handoff');
  assert.equal(action.reason, 'per_session_turn_cap');
});

test('CLI next-action: DEEP_LOOP_UNATTENDED env marker derives handoff', () => {
  const root = freshRoot();
  const runId = cappedClaude(root);
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
  const runId = cappedClaude(root);
  const result = runCli(['next-action', '--project-root', root, '--run-id', runId, '--now', NOW.toISOString()]);
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout).action;
  assert.equal(action.type, 'discover');
  assert.equal(action.advice, 'compact');
  assert.equal(action.advice_reason, 'per_session_turn_cap');
});

test('milestone cursor: terminal transition records identity; emit consumes it; child does not re-emit', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
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

test('milestone cursor: pre-compact handoff consumes terminal transition before milestone trigger', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
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

test('milestone cursor: ready then merged preserves and consumes both terminal identities', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
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

test('CLI handoff emit without milestone flag consumes derived terminal identities', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
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
