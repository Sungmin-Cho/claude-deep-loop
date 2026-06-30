import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { resolveReviewer, dispatchReview, parseVerdict, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { releaseLease, acquireLease } from '../scripts/lib/lease.mjs';

function seed(detected = { 'deep-review': true }) {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', detected, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

function fence(runId) { return { owner: runId, generation: 1, intent: 'business' }; }

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
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.reviewer, 'deep-review-loop');
  assert.equal(r.descriptor.kind, 'invoke_skill');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(ep.role, 'checker');
  assert.equal(ep.kind, 'implementation-review');
});

test('recordReviewOutcome derives checker terminal + drives breaker/comprehension/points', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  // Create a done maker for 'plan' so dispatchReview binds the checker (target_maker required for review_points_done).
  writeFileSync(join(root, 'plan.txt'), 'plan artifact');
  const { id: planMakerId } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: ws, expectedArtifacts: ['plan.txt'], fence: f });
  recordEpisode(root, runId, planMakerId, { status: 'done', artifacts: ['plan.txt'], proof: {}, fence: f });
  // REQUEST_CHANGES → checker rejected + breaker++ (Codex r1 🔴5: checker 터미널 파생)
  const r1 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  recordReviewOutcome(root, runId, { episodeId: r1.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES', fence: f });
  let d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r1.checkerEpisodeId).status, 'rejected');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 1);
  // Fix maker done (second round) and APPROVE → checker approved + point done + breaker reset + comprehension.
  writeFileSync(join(root, 'plan2.txt'), 'plan artifact v2');
  const { id: planMakerId2 } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: ws, expectedArtifacts: ['plan2.txt'], fence: f });
  recordEpisode(root, runId, planMakerId2, { status: 'done', artifacts: ['plan2.txt'], proof: {}, fence: f });
  const r2 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  recordReviewOutcome(root, runId, { episodeId: r2.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE', fence: f });
  d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r2.checkerEpisodeId).status, 'approved');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 0);
  assert.ok(d.workstreams.find(w => w.id === ws).review_points_done.includes('plan'));
});

// (RC → nextAction=fix_episode 종단 테스트는 Task 6 next-action.test.mjs 로 이동 — Task 4 는 next-action.mjs 미존재. Codex r5 🟡1)

// Fix 1: recordReviewOutcome on a maker episode id throws REVIEW_TARGET_NOT_CHECKER
test('recordReviewOutcome throws REVIEW_TARGET_NOT_CHECKER when target is a maker episode', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  // Create a maker episode
  const { id: makerId } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream: ws, fence: f });
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: makerId, workstreamId: ws, point: 'implementation', verdict: 'APPROVE', fence: f }),
    /REVIEW_TARGET_NOT_CHECKER/
  );
});

// Codex r2 🔴: checker episode 에서 workstream/point 파생 — 호출자 제공 값 무시.
test('recordReviewOutcome derives workstream/point from checker episode, ignores caller-supplied mismatched values', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const wsA = newWorkstream(root, runId, { title: 'ws-A', branch: 'ba', worktree: 'wa', fence: f }).id;
  const wsBogus = newWorkstream(root, runId, { title: 'ws-bogus', branch: 'bb', worktree: 'wb', fence: f }).id;
  // Create a done maker for ws-A/plan so dispatchReview binds the checker (required for review_points_done update).
  writeFileSync(join(root, 'plan-a.txt'), 'plan artifact');
  const { id: planMakerId } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: wsA, expectedArtifacts: ['plan-a.txt'], fence: f });
  recordEpisode(root, runId, planMakerId, { status: 'done', artifacts: ['plan-a.txt'], proof: {}, fence: f });
  // dispatch checker for ws-A / plan — checker is bound to planMakerId
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: wsA, detected: { 'deep-review': true }, fence: f });
  // call with MISMATCHED caller workstreamId + point — derives from checker episode, not caller
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: wsBogus, point: 'implementation', verdict: 'APPROVE', fence: f });
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
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE', fence: f });
  const breakerBefore = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES', fence: f }),
    /REVIEW_ALREADY_RECORDED/
  );
  // breaker counter must be unchanged by second call
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerBefore);
});

// Codex r2 🔴6: invalid verdict 는 어떤 변경(breaker) 전에 거부.
test('recordReviewOutcome rejects invalid verdict before mutating breaker', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const before = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROV', fence: f }), /REVIEW_VERDICT_INVALID/);
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, before);
});

// Codex r3 FIX 2: concurrent callers — second recordReviewOutcome on same checker throws, no extra breaker mutation
test('recordReviewOutcome twice → second throws EPISODE_ALREADY_TERMINAL, breaker unchanged', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE', fence: f });
  const breakerAfterFirst = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  // Second call with different verdict — must throw and not mutate breaker
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES', fence: f }),
    /EPISODE_ALREADY_TERMINAL|REVIEW_ALREADY_RECORDED/
  );
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, breakerAfterFirst);
});

// Fix 1 (round 4): stale fence → LEASE_FENCED thrown, no partial mutation (breaker / review_points_done unchanged)
test('recordReviewOutcome: stale fence throws LEASE_FENCED; breaker and review_points_done not mutated', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T00:00:00Z');
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  // Capture fence with current owner+generation (gen=1)
  const staleFence = { owner: runId, generation: 1, intent: 'business' };
  const breakerBefore = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  // Now advance the lease generation: release + child acquires (gen bumps to 2)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: 'CHILD-ACTOR', expectGeneration: 1, now });
  // recordReviewOutcome with stale fence must throw LEASE_FENCED somewhere in the chain
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE', fence: staleFence }),
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

// Codex r13: FENCE_REQUIRED — mutators throw when fence is absent
test('dispatchReview throws FENCE_REQUIRED when called without fence', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  assert.throws(
    () => dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } }),
    /FENCE_REQUIRED/
  );
});

// Codex impl r14 🟡: dispatchReview must reject a missing/nonexistent workstream at dispatch time (no stranded checker).
test('dispatchReview rejects missing/nonexistent workstream and creates no checker episode', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  assert.throws(() => dispatchReview(root, runId, { point: 'plan', workstreamId: 'ws-nope', detected: { 'deep-review': true }, fence: f }), /WORKSTREAM_NOT_FOUND/);
  assert.throws(() => dispatchReview(root, runId, { point: 'plan', detected: { 'deep-review': true }, fence: f }), /WORKSTREAM_NOT_FOUND/);
  assert.equal(readState(root, runId).data.episodes.length, 0);   // no stranded checker
});

// FIX 3 regression (a): require_human_ack=true → approved review record does NOT change episodes_human_reviewed
// (even when source is 'deep-review-approve' or any other source). Only /deep-loop-ack may grant comprehension.
test('recordReviewOutcome: require_human_ack=true → episodes_human_reviewed unchanged after approve', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ack-'));
  const reviewCfg = { points: ['implementation'], reviewer: 'deep-review-loop', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: true };
  const { runId } = initRun(root, { goal: 'g', review: reviewCfg, detected: { 'deep-review': true }, now: new Date('2026-06-24T00:00:00Z') });
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws, fence: f });
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const beforeReviewed = readState(root, runId).data.comprehension?.episodes_human_reviewed || 0;
  // approve with any source — must NOT increment comprehension when require_human_ack=true
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'implementation', verdict: 'APPROVE', source: 'deep-review-approve', fence: f });
  const afterReviewed = readState(root, runId).data.comprehension?.episodes_human_reviewed || 0;
  assert.equal(afterReviewed, beforeReviewed, 'require_human_ack=true must not increment episodes_human_reviewed from review record');
});

// FIX 3 regression (b): two done makers same point, approving checker bound to maker2 (latest) increments
// episodes_human_reviewed by exactly 1 (only maker2), not 2.
test('recordReviewOutcome: bound approve increments episodes_human_reviewed by 1 (only the bound maker, not all makers on point)', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: f }).id;
  // Two done makers on the same point — both must be done for dispatchReview to bind to the latest.
  writeFileSync(join(root, 'impl1.txt'), 'artifact 1');
  writeFileSync(join(root, 'impl2.txt'), 'artifact 2');
  const { id: maker1Id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws, expectedArtifacts: ['impl1.txt'], fence: f });
  recordEpisode(root, runId, maker1Id, { status: 'done', artifacts: ['impl1.txt'], proof: {}, fence: f });
  const { id: maker2Id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws, expectedArtifacts: ['impl2.txt'], fence: f });
  recordEpisode(root, runId, maker2Id, { status: 'done', artifacts: ['impl2.txt'], proof: {}, fence: f });
  // dispatch review — binds to the latest unreviewed done maker (maker2)
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const beforeReviewed = readState(root, runId).data.comprehension?.episodes_human_reviewed || 0;
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'implementation', verdict: 'APPROVE', fence: f });
  const afterReviewed = readState(root, runId).data.comprehension?.episodes_human_reviewed || 0;
  assert.equal(afterReviewed - beforeReviewed, 1, 'only the bound maker (maker2) should be marked human_reviewed, not all makers on the point');
});

// ── C2: object-shape routing regression (resolveReviewer downgrade) ─────────────
test('C2: resolveReviewer downgrades a configured deep-review reviewer when present:false (object shape)', () => {
  const { root, runId } = seed({ 'deep-review': { present: true } });   // → review.reviewer = 'deep-review-loop'
  const { data } = readState(root, runId);
  assert.equal(resolveReviewer(data, { 'deep-review': { present: false }, codex: { present: true } }).reviewer, 'codex-cross');
  assert.equal(resolveReviewer(data, { 'deep-review': { present: false }, codex: { present: false } }).reviewer, 'subagent-checker');
  assert.equal(resolveReviewer(data, { 'deep-review': { present: true } }).reviewer, 'deep-review-loop');
});
