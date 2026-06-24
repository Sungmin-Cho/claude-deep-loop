import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, patch, runDir } from '../scripts/lib/state.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const runId = 'R1';
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
  const data = {
    schema_version: '0.2.0', run_id: runId, goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'deep-work' }, review: { points: ['design'] },
    autonomy: { tier: 'recommend', spawn_style: 'interactive' }, budget: { unit: 'turns', spent: 5 },
    comprehension: {}, circuit_breaker: { tripped: false }, session_chain: { lease: { state: 'active', handoff_phase: 'idle' }, sessions: [] },
    workstreams: [{ id: 'ws-1', status: 'in_progress', depends_on: [] }], active_workstreams: ['ws-1'],
    triage: { actionable: [] }, episodes: [{ id: 'e1', status: 'pending' }], termination: {},
  };
  writeState(root, runId, data);
  return { root, runId };
}

test('read after write roundtrips', () => {
  const { root, runId } = seed();
  assert.equal(readState(root, runId).data.goal, 'g');
});

test('patch allowed field succeeds', () => {
  const { root, runId } = seed();
  patch(root, runId, 'triage.actionable', [{ id: 'x' }]);
  assert.equal(readState(root, runId).data.triage.actionable.length, 1);
});

test('patch forbidden field (budget.spent) throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'budget.spent', 0), /FIELD_FORBIDDEN/);
});

test('patch forbidden review.* throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'review.points', []), /FIELD_FORBIDDEN/);
});

test('tampered hash detected on read', () => {
  const { root, runId } = seed();
  writeFileSync(join(runDir(root, runId), 'loop.json'), '{"goal":"hacked"}'); // direct write, hash unchanged
  assert.throws(() => readState(root, runId), /STATE_TAMPERED/);
});

test('whole-object array patch bypass is forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0', { status: 'done' }), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.0', { status: 'merged' }), /FIELD_FORBIDDEN/);
});

test('terminal status value via dotted path is forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.status', 'done'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.0.status', 'merged'), /FIELD_FORBIDDEN/);
});

test('non-terminal status + depends_on allowed', () => {
  const { root, runId } = seed();
  patch(root, runId, 'episodes.0.status', 'in_progress');
  patch(root, runId, 'workstreams.0.depends_on', ['ws-2']);
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
  assert.deepEqual(readState(root, runId).data.workstreams[0].depends_on, ['ws-2']);
});

test('non-status workstream field (title) forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'workstreams.0.title', 'x'), /FIELD_FORBIDDEN/);
});

test('episode result sub-path / lookalike forbidden, only result_* allowed', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.result.status', 'x'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'episodes.0.resultEvil', 'x'), /FIELD_FORBIDDEN/);
  patch(root, runId, 'episodes.0.result_summary', 'ok'); // allowed
  assert.equal(readState(root, runId).data.episodes[0].result_summary, 'ok');
});
