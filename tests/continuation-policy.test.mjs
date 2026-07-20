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

const NOW = new Date('2026-07-20T00:00:00.000Z');
const noRun = () => ({ code: 1, stdout: '', stderr: '' });
const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));
function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'dl-cpol-'));
}
function initClaude(root, extra = {}) {
  return initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1, ...extra });
}
function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
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
  assert.match(result.stderr, /usage: --continuation <compact-in-place\|rotate-per-unit>/);
});

function minimalValidLoop() {
  const root = freshRoot();
  const { runId } = initClaude(root);
  return readState(root, runId).data;
}
