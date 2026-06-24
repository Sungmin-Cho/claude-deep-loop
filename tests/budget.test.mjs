import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBudget, recordCost, reconcileBudget } from '../scripts/lib/budget.mjs';
import { writeState, readState, runDir } from '../scripts/lib/state.mjs';

// 자기완결 minimal valid loop (cross-task import 없음)
function minimalLoop(runId) {
  return {
    schema_version: '0.2.0', run_id: runId, goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'standalone' }, review: {}, autonomy: { tier: 'act-gated', spawn_style: 'interactive' },
    budget: { unit: 'turns', total: 100, spent: 0, tokens_total: 1000, tokens_spent: 0, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0, max_wallclock_sec: 3600, enforcement: 'best-effort-interactive', on_unmeasurable_usage: 'fail-closed' },
    comprehension: {}, circuit_breaker: {}, session_chain: { lease: { state: 'active', handoff_phase: 'idle' }, sessions: [] },
    workstreams: [], active_workstreams: [], triage: {}, episodes: [], termination: {},
  };
}
function seedRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(runDir(root, 'R'), { recursive: true });
  writeState(root, 'R', minimalLoop('R'));
  return root;
}

const base = () => ({
  budget: { unit: 'turns', total: 100, spent: 0, tokens_total: 1000, tokens_spent: 0,
    max_wallclock_sec: 3600, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0,
    enforcement: 'best-effort-interactive', on_unmeasurable_usage: 'fail-closed' },
  autonomy: { tier: 'act-gated' },
});

test('under budget → ok', () => {
  const l = base(); l.budget.spent = 10;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).ok, true);
});
test('hard stop on turns → not ok', () => {
  const l = base(); l.budget.spent = 100;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).ok, false);
});
test('hard stop on wallclock → not ok', () => {
  const l = base(); l.budget.spent = 1;
  assert.equal(checkBudget(l, { now: 3601_000, sessionStart: 0 }).ok, false);
});
test('soft stop demotes tier', () => {
  const l = base(); l.budget.spent = 85;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).tier_after, 'recommend');
});
test('headless unmeasurable → fail-closed', () => {
  const l = base(); l.budget.enforcement = 'hard'; l.budget.spent = 1;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0, measurable: false }).ok, false);
});

test('recordCost syncs kernel-derived spent from event-log', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 5, tokens: 100 });
  recordCost(root, 'R', { turns: 3, tokens: 50 });
  const { data } = readState(root, 'R');
  assert.equal(data.budget.spent, 8);
  assert.equal(data.budget.tokens_spent, 150);
});

test('reconcileBudget throws on stored/log mismatch', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 5, tokens: 0 });
  const { data } = readState(root, 'R'); data.budget.spent = 0; writeState(root, 'R', data); // tamper low
  assert.throws(() => reconcileBudget(root, 'R'), /BUDGET_TAMPERED/);
});
