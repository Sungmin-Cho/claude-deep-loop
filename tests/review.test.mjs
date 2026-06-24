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
