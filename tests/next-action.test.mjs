import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialLoop, initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { computeDebt } from '../scripts/lib/comprehension.mjs';

function loop(over = {}) {
  const l = buildInitialLoop({ goal: 'g', protocol: 'deep-work', recipe: { id: 'r', name: 'r', reason: '' }, runId: 'R', now: new Date('2026-06-24T00:00:00Z') });
  return Object.assign(l, over);
}

test('fresh run with no episodes → discover', () => {
  const r = nextAction(loop(), { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.gate.allowed, true);
  assert.equal(r.action.type, 'discover');
});

test('budget hard stop → gate blocked, handoff', () => {
  const l = loop(); l.budget.spent = l.budget.total;
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.gate.allowed, false);
  assert.ok(r.gate.blocked_by.includes('budget'));
  assert.equal(r.action.type, 'handoff');
});

test('breaker tripped → gate blocked, await_human', () => {
  const l = loop(); l.circuit_breaker.tripped = true;
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.gate.allowed, false);
  assert.ok(r.gate.blocked_by.includes('breaker'));
  assert.equal(r.action.type, 'await_human');
});

test('pending maker episode → dispatch_maker', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'pending', point: 'implementation', workstream_id: 'ws-01' }];
  l.current_episode = '001-deep-work';
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.action.type, 'dispatch_maker');
  assert.equal(r.action.episode_id, '001-deep-work');
});

test('done maker at review point → dispatch_checker', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'done', point: 'implementation', workstream_id: 'ws-01' }];
  l.current_episode = '001-deep-work';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'dispatch_checker');
});

test('per_session_turn_cap reached → handoff', () => {
  const l = loop();
  l.budget.per_session_turn_cap = 5;
  l.session_chain.sessions = [{ run_id: 'R', started_at: l.created_at, ended_at: null, turns: 5, outcome: null, superseded_by: null }];
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'pending', point: 'implementation' }];
  l.current_episode = '001-deep-work';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'handoff');
});

// Codex r1 🔴5: 리뷰 outcome 이 checker 터미널을 세팅한 뒤 nextAction 이 fix flow 로 진입해야 (finish 오폴백 금지).
test('checker rejected → fix_episode; checker approved → finish (no fall-through)', () => {
  const l = loop();
  l.episodes = [{ id: '002-deep-review', role: 'checker', status: 'rejected', point: 'plan', workstream_id: 'ws-01' }];
  l.current_episode = '002-deep-review';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'fix_episode');
  l.episodes[0].status = 'approved';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'finish');
});

// Codex r2 🔴7: in_progress/blocked 는 finish/재dispatch 가 아니라 await.
test('in-progress→await_result, blocked→await_human, checker in_progress not re-dispatched', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'in_progress', point: 'implementation' }];
  l.current_episode = '001-deep-work';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_result');
  l.episodes[0].status = 'blocked';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_human');
  l.episodes = [{ id: '002-deep-review', role: 'checker', status: 'in_progress', point: 'plan' }];
  l.current_episode = '002-deep-review';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_result');
});

// Codex r2 🔴7 / r3 🔴4: finish 는 active workstream 0 + done maker 가 리뷰 통과일 때만.
test('finish gated on review of done makers AND zero active workstreams', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'done', point: 'implementation', workstream_id: 'ws-01' }];
  l.current_episode = null;
  l.workstreams = [{ id: 'ws-01', review_points_done: [] }];
  l.active_workstreams = [];
  // 리뷰 안 된 done maker → finish 가 아니라 checker dispatch (리뷰 게이트)
  assert.equal(nextAction(l, { now: 0 }).action.type, 'dispatch_checker');
  // 리뷰 통과 처리: add a bound approved checker (target_maker binds to the maker id)
  l.episodes.push({ id: '002-deep-review', role: 'checker', status: 'approved', point: 'implementation', workstream_id: 'ws-01', target_maker: '001-deep-work' });
  l.workstreams[0].review_points_done = ['implementation'];
  l.active_workstreams = ['ws-01'];                            // 그러나 active workstream 잔존 → finish 금지
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_human');
  l.active_workstreams = [];                                   // active 0 + 리뷰 통과 → finish
  assert.equal(nextAction(l, { now: 0 }).action.type, 'finish');
});

// Codex r2 🔴4: comprehension-debt 는 discover(새 fan-out)만 막고 fix flow 는 막지 않는다.
test('comprehension-debt blocks discover but not the fix flow', () => {
  const l = loop();
  l.comprehension = { episodes_total: 4, episodes_human_reviewed: 0, debt_threshold: 0.5 };  // debt=1.0 blocked
  l.episodes = []; l.current_episode = null;
  const r0 = nextAction(l, { now: 0 });
  assert.equal(r0.action.type, 'await_human');
  assert.ok(r0.gate.blocked_by.includes('comprehension-debt'));
  l.episodes = [{ id: '002-deep-review', role: 'checker', status: 'rejected', point: 'plan', workstream_id: 'ws-01' }];
  l.current_episode = '002-deep-review';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'fix_episode');  // debt 무관
});

// Fix 4: after APPROVE, maker episodes for that point are human_reviewed and not blocking debt
test('recordReviewOutcome(APPROVE) marks maker episodes human_reviewed, computeDebt not blocked', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', detected: { 'deep-review': true }, now: new Date('2026-06-24T00:00:00Z') });
  const f = { owner: runId, generation: 1, intent: 'business' };
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  // Create a maker episode for point 'implementation'
  newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream: ws, fence: f });
  // Dispatch and approve the review
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'implementation', verdict: 'APPROVE', fence: f });
  const { data } = readState(root, runId);
  // Maker episode should be marked human_reviewed
  const maker = data.episodes.find(e => e.role === 'maker' && e.point === 'implementation');
  assert.ok(maker.human_reviewed, 'maker episode should be human_reviewed after APPROVE');
  // computeDebt should not be blocked (episodes_human_reviewed == episodes_total)
  assert.equal(computeDebt(data).blocked, false);
});

// Codex r2 🔴4 / r5 🟡1: review.mjs+next-action.mjs 종단 — RC 후 debt(=1.0)에도 fix_episode 진입.
// (Task 4 가 아니라 여기 둠 — 이 시점에 review.mjs·next-action.mjs 둘 다 존재.)
test('dispatchReview → recordReviewOutcome(RC) → nextAction returns fix_episode (end-to-end)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', detected: { 'deep-review': true }, now: new Date('2026-06-24T00:00:00Z') });
  const f = { owner: runId, generation: 1, intent: 'business' };
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES', fence: f });
  const { data } = readState(root, runId);
  assert.equal(nextAction(data, { now: Date.parse('2026-06-24T00:00:00Z') }).action.type, 'fix_episode');
});

// Codex r3 FIX 3: superseded rejected checker must not block convergence
// A loop with an OLD rejected checker for ws-01/plan AND review_points_done containing 'plan'
// (a later approval happened) AND no current actionable episode → nextAction does NOT return fix_episode
test('superseded rejected checker (review_points_done satisfied) does not block convergence', () => {
  // Build a loop with:
  // - ws-01 with review_points_done=['plan'] (i.e. a later approval happened)
  // - An OLD rejected checker episode for ws-01/plan
  // - No current actionable episode (current_episode=null, no pending/in_progress)
  const l = loop({
    workstreams: [{ id: 'ws-01', status: 'in_progress', review_points_done: ['plan'], episodes: [], depends_on: [] }],
    active_workstreams: ['ws-01'],
    episodes: [
      { id: '001-deep-review', role: 'checker', status: 'rejected', point: 'plan', workstream_id: 'ws-01' },
    ],
    current_episode: null,
  });
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  // Must NOT be fix_episode (the old rejected checker is review-satisfied)
  assert.notEqual(r.action.type, 'fix_episode', 'stale rejected checker must not trigger fix_episode');
});

// Plan-3 r3 fix (Codex finding 2): two done makers same point, one with bound approved checker, one without
// → nextAction must dispatch_checker for the unreviewed maker (NOT finish).
test('two done makers same point: one reviewed, one unreviewed → dispatch_checker not finish', () => {
  const l = loop({
    workstreams: [{ id: 'ws-01', status: 'in_progress', review_points_done: ['plan'], episodes: [], depends_on: [] }],
    active_workstreams: [],
    episodes: [
      { id: '001-deep-work', role: 'maker', status: 'done', point: 'plan', workstream_id: 'ws-01' },
      { id: '002-deep-review', role: 'checker', status: 'approved', point: 'plan', workstream_id: 'ws-01', target_maker: '001-deep-work' },
      { id: '003-deep-work-fix', role: 'maker', status: 'done', point: 'plan', workstream_id: 'ws-01' },
      // 003-deep-work-fix has NO bound checker → must trigger dispatch_checker
    ],
    current_episode: null,
  });
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.action.type, 'dispatch_checker', `expected dispatch_checker but got ${r.action.type}`);
});

// Codex r5 🟡2: superseded rejected checker must not block finish
// A loop with: OLD rejected checker (ws-01/plan) bound to maker, a later approved checker also bound to maker,
// review_points_done=['plan'], no active workstreams, current_episode=null → finish (not await_human, not fix_episode).
test('superseded rejected checker + done reviewed maker + no active ws → finish (not await_human)', () => {
  const l = loop({
    workstreams: [{ id: 'ws-01', status: 'in_progress', review_points_done: ['plan'], episodes: [], depends_on: [] }],
    active_workstreams: [],
    episodes: [
      { id: '001-deep-work', role: 'maker', status: 'done', point: 'plan', workstream_id: 'ws-01' },
      { id: '002-deep-review-old', role: 'checker', status: 'rejected', point: 'plan', workstream_id: 'ws-01', target_maker: '001-deep-work' },
      { id: '003-deep-review-new', role: 'checker', status: 'approved', point: 'plan', workstream_id: 'ws-01', target_maker: '001-deep-work' },
    ],
    current_episode: null,
  });
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.action.type, 'finish', `expected finish but got ${r.action.type} (reason: ${r.action.reason})`);
});
