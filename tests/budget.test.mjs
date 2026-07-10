import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBudget, recordCost, reconcileBudget, MUTATION_TURN_FLOOR } from '../scripts/lib/budget.mjs';
import { appendAnchored, verifyLog, verifyHead } from '../scripts/lib/integrity.mjs';
import { writeState, readState, runDir, patch } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { newWorkstream, setWorkstreamStatus } from '../scripts/lib/workspace.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { releaseLease, acquireLease } from '../scripts/lib/lease.mjs';

function floorRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-floor-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}
function ownerSessionTurns(root, runId) {
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  return (data.session_chain.sessions.find(s => s.run_id === owner) || {}).turns || 0;
}
function mk(root, runId, fence, n) {   // n distinct maker episodes (each a business mutation → floor)
  for (let i = 0; i < n; i++) newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'k', point: 'implementation', fence });
}

// 자기완결 minimal valid loop (cross-task import 없음)
function minimalLoop(root, runId) {
  return {
    schema_version: '0.2.0', run_id: runId, goal: 'g', status: 'running',
    project: { root }, routing: { protocol: 'standalone' }, review: {}, autonomy: { tier: 'act-gated', spawn_style: 'interactive' },
    budget: { unit: 'turns', total: 100, spent: 0, tokens_total: 1000, tokens_spent: 0, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0, max_wallclock_sec: 3600, enforcement: 'best-effort-interactive', on_unmeasurable_usage: 'fail-closed' },
    comprehension: {}, circuit_breaker: {}, session_chain: { lease: { state: 'active', handoff_phase: 'idle' }, sessions: [] },
    workstreams: [], active_workstreams: [], triage: {}, episodes: [], termination: {},
  };
}
function seedRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(runDir(root, 'R'), { recursive: true });
  writeState(root, 'R', minimalLoop(root, 'R'));
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

test('recordCost rejects negative / non-finite values', () => {
  const root = seedRun();
  assert.throws(() => recordCost(root, 'R', { turns: -1, tokens: 0 }), /INVALID_COST/);
  assert.throws(() => recordCost(root, 'R', { turns: 1, tokens: Infinity }), /INVALID_COST/);
});

test('reconcileBudget detects event-log suffix truncation', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 2, tokens: 0 });
  recordCost(root, 'R', { turns: 3, tokens: 0 });
  const p = join(runDir(root, 'R'), 'event-log.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  writeFileSync(p, lines.slice(0, -1).join('\n') + '\n'); // drop last event
  assert.throws(() => reconcileBudget(root, 'R'), /BUDGET_TAMPERED/);
});

test('checkBudget derives wallclock from created_at when sessionStart omitted', () => {
  const l = base();
  l.created_at = new Date(Date.now() - 4000 * 1000).toISOString(); // 4000s ago > 3600 cap
  assert.equal(checkBudget(l, {}).ok, false);
});

test('non-cost anchored append keeps reconcile consistent; its truncation is caught', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 2, tokens: 0 });
  appendAnchored(root, 'R', { type: 'decision', data: { note: 'x' } }); // non-cost advances anchor (no floor opt)
  reconcileBudget(root, 'R'); // must NOT throw (anchor tracks tail, spent still 2)
  const p = join(runDir(root, 'R'), 'event-log.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  writeFileSync(p, lines.slice(0, -1).join('\n') + '\n'); // truncate the non-cost event
  assert.throws(() => reconcileBudget(root, 'R'), /BUDGET_TAMPERED/);
});

// ── #3: kernel-boundary per-mutation cost floor ──

// #3(a): each business mutation is charged MUTATION_TURN_FLOOR even without any `budget record` — spent AND the
// owner's session.turns both grow with the NUMBER of mutations (per-mutation, not per-generation).
test('#3(a): N business mutations charge N×floor to spent AND session.turns (no budget record)', () => {
  const { root, runId, fence } = floorRun();
  mk(root, runId, fence, 3);
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR);
  assert.equal(ownerSessionTurns(root, runId), 3 * MUTATION_TURN_FLOOR);
  assert.doesNotThrow(() => reconcileBudget(root, runId));   // floor is anchored → reconcile stays consistent
});

// #3(b): an explicit `budget record` ABSORBS the tick's floor (max-rule), not stacks on it —
// tick contribution = max(reported, floor-sum), never reported + floor-sum.
test('#3(b): explicit budget record absorbs the tick floor (max-rule, no double count)', () => {
  const { root, runId, fence } = floorRun();
  mk(root, runId, fence, 2);   // 2 floors → spent 2, session.turns 2
  recordCost(root, runId, { turns: 5, tokens: 0, fence });   // reported 5 > floor-sum 2
  // tick contribution = max(5, 2) = 5, so total spent = 5 (NOT 2 + 5 = 7)
  assert.equal(readState(root, runId).data.budget.spent, 5);
  assert.equal(ownerSessionTurns(root, runId), 5);
  assert.doesNotThrow(() => reconcileBudget(root, runId));
});

// #3(c): the floor drives per_session_turn_cap (= handoff cadence = human checkpoints) proportionally to the
// number of mutations — reaching the cap through floors alone routes nextAction to handoff.
test('#3(c): per_session_turn_cap is reached through floors and routes to handoff', () => {
  const { root, runId, fence } = floorRun();
  const d = readState(root, runId).data; d.budget.per_session_turn_cap = 2; writeState(root, runId, d);
  mk(root, runId, fence, 2);   // 2 floors → session.turns 2 == cap
  const r = nextAction(readState(root, runId).data, { now: Date.parse('2026-06-24T00:00:01Z') });
  assert.equal(r.action.type, 'handoff');
  assert.equal(r.action.reason, 'per_session_turn_cap');
});

// #3(d): negatives still rejected; wallclock backstop + log integrity unaffected by floor events.
test('#3(d): floor keeps negatives rejected and the log verifiable', () => {
  const { root, runId, fence } = floorRun();
  mk(root, runId, fence, 2);
  assert.throws(() => recordCost(root, runId, { turns: -1, tokens: 0, fence }), /INVALID_COST/);
  const { data } = readState(root, runId);
  assert.equal(verifyLog(root, runId).ok, true);
  assert.equal(verifyHead(root, runId, data.event_log_head).ok, true);
});

// #3(e) (R1 Fix 2): the previously non-anchored setWorkstreamStatus + patch paths are now anchored AND floor-charged —
// they emit workstream-status / state-patch events and grow spent (closing the "drive finish/routing for free" gap).
test('#3(e): setWorkstreamStatus + patch are anchored and floor-charged (workstream-status / state-patch events)', () => {
  const { root, runId, fence } = floorRun();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence }).id;   // floor 1
  setWorkstreamStatus(root, runId, ws, 'in_progress', { fence });   // floor 2, active_workstreams push
  patch(root, runId, 'decisions', ['noted'], { fence });            // floor 3, whitelisted field
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR);
  const lines = readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(lines.some(e => e.type === 'workstream-status' && e.data.id === ws && e.data.status === 'in_progress'));
  assert.ok(lines.some(e => e.type === 'state-patch' && e.data.field === 'decisions'));
  assert.ok(readState(root, runId).data.active_workstreams.includes(ws), 'setWorkstreamStatus mutation still applied');
  assert.deepEqual(readState(root, runId).data.decisions, ['noted'], 'patch mutation still applied');
  assert.doesNotThrow(() => reconcileBudget(root, runId));
});

// #3 (impl-R1 Fix 1): an explicit budget record in a LATER session must NOT absorb an EARLIER session's floors —
// those are confirmed prior consumption. gen 1: 3 floors, no report → advance lease to gen 2 → record K=5:
// total = 3×floor + max(K, gen-2 floors=0) = 3 + 5 = 8, NOT max(3, 5) = 5 (the bug that swallowed the gen-1 floors).
test('#3(Fix1): a later session budget record does not absorb an earlier session floors (session-scoped absorption)', () => {
  const { root, runId, fence } = floorRun();
  const now = Date.parse('2026-06-24T00:00:00Z');
  mk(root, runId, fence, 3);   // gen 1: 3 floors → spent 3
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR);
  // advance the lease: release gen 1, a child acquires (gen 2)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: 'CHILD-ACTOR', expectGeneration: 1, runtime: 'claude', now });
  // gen 2 reports 5 turns — its own tick floor is 0, so it must NOT absorb the gen-1 floors
  recordCost(root, runId, { turns: 5, tokens: 0, fence: { owner: 'CHILD-ACTOR', generation: 2, intent: 'business' } });
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR + 5, 'gen-1 floors survive; gen-2 report adds max(5, 0)=5 on top');
  assert.doesNotThrow(() => reconcileBudget(root, runId));
});

// ── v1.6 recordCost terminal 가드 (spec §2.3-7 / §4-5g) ──────────────────────
import { initRun as initRunT } from '../scripts/lib/initrun.mjs';

test('recordCost: terminal run — fenced call LEASE_FENCED channel, fence-less own throw; no event written', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-bud-t-'));
  const { runId } = initRunT(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  const { data } = readState(root, runId);
  data.status = 'completed';
  writeState(root, runId, data);
  // fence 있는 호출 → leaseCheck 선행 → LEASE_FENCED: RUN_TERMINAL (drive-headless swallow 계약)
  assert.throws(() => recordCost(root, runId, { turns: 1, tokens: 0, fence: { owner: runId, generation: 1, intent: 'accounting' } }), /LEASE_FENCED: RUN_TERMINAL/);
  // fence-less 직접 호출 → 자체 가드
  assert.throws(() => recordCost(root, runId, { turns: 1, tokens: 0 }), /RUN_TERMINAL: recordCost/);
  assert.equal(readState(root, runId).data.budget.spent, 0);
});
