import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { resolveReviewer, dispatchReview, parseVerdict, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { releaseLease, acquireLease } from '../scripts/lib/lease.mjs';

function seed(detected = { 'deep-review': true }) {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', detected, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('resolveReviewer falls back when deep-review absent', () => {
  const { root, runId } = seed({ 'deep-review': false, codex: true });
  const { data } = readState(root, runId);
  assert.equal(resolveReviewer(data, { 'deep-review': false, codex: true }).reviewer, 'codex-cross');
  assert.equal(resolveReviewer(data, { 'deep-review': false, codex: false }).reviewer, 'subagent-checker');
});

test('parseVerdict reads JSON verdict then keywords', () => {
  assert.equal(parseVerdict('{"verdict":"APPROVE","summary":"ok"}'), 'APPROVE');
  assert.equal(parseVerdict('Overall: REQUEST_CHANGES on 2 findings'), 'REQUEST_CHANGES');
  assert.equal(parseVerdict('looks good, APPROVE'), 'APPROVE');
  assert.equal(parseVerdict('no verdict here'), null);
  assert.equal(parseVerdict('do not APPROVE this'), null);   // 부정문 (Codex r4 ℹ️2)
});

test('dispatchReview creates checker episode + returns descriptor (no call)', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true } });
  assert.equal(r.reviewer, 'deep-review-loop');
  assert.equal(r.descriptor.kind, 'invoke_skill');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(ep.role, 'checker');
  assert.equal(ep.kind, 'implementation-review');
});

test('recordReviewOutcome derives checker terminal + drives breaker/comprehension/points', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  // REQUEST_CHANGES → checker rejected + breaker++ (Codex r1 🔴5: checker 터미널 파생)
  const r1 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  recordReviewOutcome(root, runId, { episodeId: r1.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES' });
  let d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r1.checkerEpisodeId).status, 'rejected');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 1);
  // APPROVE (new round) → checker approved + point done + breaker reset + comprehension
  const r2 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  recordReviewOutcome(root, runId, { episodeId: r2.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE' });
  d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r2.checkerEpisodeId).status, 'approved');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 0);
  assert.ok(d.workstreams.find(w => w.id === ws).review_points_done.includes('plan'));
});

// (RC → nextAction=fix_episode 종단 테스트는 Task 6 next-action.test.mjs 로 이동 — Task 4 는 next-action.mjs 미존재. Codex r5 🟡1)

// Fix 1: recordReviewOutcome on a maker episode id throws REVIEW_TARGET_NOT_CHECKER
test('recordReviewOutcome throws REVIEW_TARGET_NOT_CHECKER when target is a maker episode', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  // Create a maker episode
  const { id: makerId } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream: ws });
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: makerId, workstreamId: ws, point: 'implementation', verdict: 'APPROVE' }),
    /REVIEW_TARGET_NOT_CHECKER/
  );
});

// Codex r2 🔴: checker episode 에서 workstream/point 파생 — 호출자 제공 값 무시.
test('recordReviewOutcome derives workstream/point from checker episode, ignores caller-supplied mismatched values', () => {
  const { root, runId } = seed();
  const wsA = newWorkstream(root, runId, { title: 'ws-A', branch: 'ba', worktree: 'wa' }).id;
  const wsBogus = newWorkstream(root, runId, { title: 'ws-bogus', branch: 'bb', worktree: 'wb' }).id;
  // dispatch checker for ws-A / plan
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: wsA, detected: { 'deep-review': true } });
  // call with MISMATCHED caller workstreamId + point
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: wsBogus, point: 'implementation', verdict: 'APPROVE' });
  const d = readState(root, runId).data;
  // Real workstream (ws-A) gets 'plan' in review_points_done
  assert.ok(d.workstreams.find(w => w.id === wsA).review_points_done.includes('plan'), 'ws-A should have plan done');
  // Bogus workstream must be untouched
  assert.deepEqual(d.workstreams.find(w => w.id === wsBogus).review_points_done, [], 'ws-bogus must be untouched');
  // Also 'implementation' must NOT appear in ws-A (bogus point)
  assert.ok(!d.workstreams.find(w => w.id === wsA).review_points_done.includes('implementation'), 'ws-A must not have implementation');
});

// Codex r2 🔴: 같은 checker episode 에 두 번 recordReviewOutcome 호출 → 두 번째 throw REVIEW_ALREADY_RECORDED.
test('recordReviewOutcome throws REVIEW_ALREADY_RECORDED on second call to same checker episode', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE' });
  const breakerBefore = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES' }),
    /REVIEW_ALREADY_RECORDED/
  );
  // breaker counter must be unchanged by second call
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerBefore);
});

// Codex r2 🔴6: invalid verdict 는 어떤 변경(breaker) 전에 거부.
test('recordReviewOutcome rejects invalid verdict before mutating breaker', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  const before = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROV' }), /REVIEW_VERDICT_INVALID/);
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, before);
});

// Codex r3 FIX 2: concurrent callers — second recordReviewOutcome on same checker throws, no extra breaker mutation
test('recordReviewOutcome twice → second throws EPISODE_ALREADY_TERMINAL, breaker unchanged', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE' });
  const breakerAfterFirst = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  // Second call with different verdict — must throw and not mutate breaker
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES' }),
    /EPISODE_ALREADY_TERMINAL|REVIEW_ALREADY_RECORDED/
  );
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerAfterFirst);
});

// Fix 1 (round 4): stale fence → LEASE_FENCED thrown, no partial mutation (breaker / review_points_done unchanged)
test('recordReviewOutcome: stale fence throws LEASE_FENCED; breaker and review_points_done not mutated', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T00:00:00Z');
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  // Capture fence with current owner+generation (gen=1)
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const breakerBefore = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  // Now advance the lease generation: release + child acquires (gen bumps to 2)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: 'CHILD-ACTOR', expectGeneration: 1, now });
  // recordReviewOutcome with stale fence must throw LEASE_FENCED somewhere in the chain
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE', fence }),
    /LEASE_FENCED/
  );
  // Codex impl r10 🔴: ATOMIC — the checker must NOT be terminalized (no half-commit) when the fenced
  // transaction is rejected. With the old multi-lock version the checker was approved before the later
  // fenced writes threw; the single-transaction version leaves it fully unmutated.
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId).status, 'pending');
  // Breaker counter must not have been mutated
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerBefore);
  // review_points_done must not contain 'plan'
  const wsData = readState(root, runId).data.workstreams.find(w => w.id === ws);
  assert.ok(!wsData.review_points_done.includes('plan'), 'review_points_done must not include plan after fenced call');
});
