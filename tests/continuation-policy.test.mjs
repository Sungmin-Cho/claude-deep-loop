import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';

const NOW = new Date('2026-07-20T00:00:00.000Z');
const noRun = () => ({ code: 1, stdout: '', stderr: '' });
function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'dl-cpol-'));
}
function initClaude(root, extra = {}) {
  return initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1, ...extra });
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

function minimalValidLoop() {
  const root = freshRoot();
  const { runId } = initClaude(root);
  return readState(root, runId).data;
}
