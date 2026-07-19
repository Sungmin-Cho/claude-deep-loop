import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync,
  readdirSync as list10d, readFileSync as read10d, symlinkSync as symlink10d,
  rmdirSync as rmdir10d, writeFileSync as write10d } from 'node:fs';
import { spawnSync as spawn10d } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { newWorkstream, recordWorkstreamTerminal } from './helpers/workstream-request.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from './helpers/episode-request.mjs';
import { dispatchReview, recordReviewOutcome } from './helpers/review-request.mjs';
import { finishRun, finishProofState } from '../scripts/lib/finish.mjs';
import { recoverRun } from '../scripts/lib/recover.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireAppTask, awaitAppTask, confirmAppTask, failAppTask, prepareAppTask,
  revokeAppTaskContinuation, sweepUnconfirmedAppTask }
  from '../scripts/lib/app-task-continuation.mjs';
import { readLines, readVerifiedState as verified10d } from '../scripts/lib/integrity.mjs';
import { durableRunBytes as bytes10d,
  legacyInProgressProofFixture as legacyFinish10d,
  rawHashValidState as raw10d }
  from './fixtures/verified-app-run.mjs';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

// Codex r2 should-fix-2: review.points 를 ['implementation'] 한 개로 시드해야 recordWorkstreamTerminal('ready')
// 의 "전 review point done" 게이트(workspace.mjs:77-82, 기본 [design,plan,implementation])를 한 번의 approve 로 충족한다.
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-fin-'));
  const review = { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false };
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', review, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}

test('finish event and termination use the same injected anchored clock', () => {
  const { root, runId, fence } = seed();
  const now = Date.parse('2026-07-13T00:00:11.000Z');
  assert.equal(finishRun(root, runId, { status: 'stopped',
    proof: { human_reason: 'clock proof' }, confirm: true, fence, now }).ok, true);
  const loop = readState(root, runId).data;
  const finish = readLines(root, runId).find(event => event.type === 'finish');
  assert.equal(finish.ts, '2026-07-13T00:00:11.000Z');
  assert.equal(loop.termination.finished_at, finish.ts);
  assert.equal(finish.data.reportRel, loop.termination.final_report ?? null);
});

// 완전히 settled+reviewed+terminal 인 run 을 실제 lib 계약대로 조립 (completed proof 충족).
// Codex r2 sf-2: recordEpisode('done')는 expected_artifacts 가 비어있지 않고 실제 파일이 root 하위에 존재해야 한다
// (episode.mjs:89-112). recordWorkstreamTerminal('ready')는 전 review point coverage 필요(위 seed 가 1개로 축소).
function buildSettledRun(root, runId, fence) {
  writeFileSync(join(root, 'art.txt'), 'artifact');   // expected artifact 가 디스크에 존재해야 done 통과
  const ws = newWorkstream(root, runId, { title: 'W', branch: 'b', worktree: '.claude/worktrees/wt', fence });
  const ep = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws.id, expectedArtifacts: ['art.txt'], fence });
  recordEpisode(root, runId, ep.id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence });   // artifacts 가 expected 를 커버
  const dr = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws.id, detected: {}, fence });
  mkdirSync(join(root, '.claude/worktrees/wt'), { recursive: true });
  writeFileSync(join(root, '.claude/worktrees/wt/review.md'), '# review report');   // #2+Fix4: report under the reviewed ws worktree
  recordReviewOutcome(root, runId, { episodeId: dr.checkerEpisodeId, verdict: 'APPROVE', proof: { report: '.claude/worktrees/wt/review.md' }, fence });
  // 'ready' 는 review_points_done 커버리지만 검사(proof 는 객체이기만 하면 됨); recordWorkstreamTerminal 이 active 에서 제거.
  recordWorkstreamTerminal(root, runId, ws.id, { status: 'ready', proof: {}, fence });
  return ws.id;
}

// --- finishProofState 순수 단위 (디스크 없음) — Codex r1 critical-1 ---
test('finishProofState blocks an empty run (no proof of work)', () => {
  const ps = finishProofState({ episodes: [], workstreams: [], active_workstreams: [] });
  assert.ok(ps.missing.includes('no-proof-of-work'));
});

test('finishProofState blocks when there is no independent review proof', () => {
  const loop = { episodes: [{ id: 'm', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: [] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('no-independent-review'));
});

test('finishProofState passes only with settled + reviewed + terminal', () => {
  const loop = { episodes: [
      { id: 'm', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.deepEqual(finishProofState(loop).missing, []);
});

test('proof-capable checker identity: approved legacy standalone proof cannot satisfy finish', () => {
  const loop = { episodes: [
      { id: 'm', role: 'maker', plugin: 'deep-work', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c', role: 'checker', plugin: 'standalone', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  const ps = finishProofState(loop);
  assert.equal(ps.settled, true, 'legacy terminal checker may be settled');
  assert.equal(ps.allMakersReviewed, false);
  assert.equal(ps.reviewedProof, false);
  assert.ok(ps.missing.includes('unreviewed-maker'));
  assert.ok(ps.missing.includes('no-independent-review'));
});

test('proof-capable checker identity: rejected legacy standalone proof is neutral', () => {
  const loop = { episodes: [
      { id: 'm', role: 'maker', plugin: 'deep-work', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c', role: 'checker', plugin: 'standalone', point: 'implementation', workstream_id: 'w', status: 'rejected', target_maker: 'm' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: [] }], active_workstreams: [] };
  const ps = finishProofState(loop);
  assert.equal(ps.settled, true, 'invalid rejected proof must not strand settlement');
  assert.equal(ps.allMakersReviewed, false);
  assert.ok(ps.missing.includes('no-independent-review'));
  assert.equal(ps.missing.includes('unsettled-episodes'), false);
});

// Codex r6 critical-1: 한 maker 는 리뷰됐지만 다른 done maker 는 미리뷰면 completed 차단.
test('finishProofState blocks when any one done maker is unreviewed', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved' },
      { id: 'm2', role: 'maker', point: 'plan', workstream_id: 'w', status: 'done' }],   // 'plan' 리뷰 없음
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unreviewed-maker'));
});

// FIX 1 regression: 같은 ws+point 에 done maker 2명인데 approved checker 가 1명뿐 → unreviewed-maker
test('finishProofState blocks two done makers sharing one approved checker (anomaly: count-based)', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'm2', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unreviewed-maker'));
});

// Plan-3 r3 fix: two done makers same ws+point, TWO checkers both bound to maker1 (one approved), maker2 unbound → blocks.
// Validates per-maker binding: checkers for maker1 cannot satisfy maker2's review requirement.
test('finishProofState blocks when two checkers are both bound to maker1 but maker2 has no bound checker', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'm2', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'rejected', target_maker: 'm1' },
      { id: 'c2', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm1' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unreviewed-maker'));
});

// FIX 1 regression (a): maker1 (done) + checker bound to maker1 (rejected) + UNBOUND approved checker on same ws+point → blocks.
// An unbound approved checker has no target_maker, so it cannot satisfy the latest-done-maker convergence rule.
test('finishProofState blocks: bound-rejected checker on maker1 + unbound approved checker (no target_maker) on same point', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'rejected', target_maker: 'm1' },
      { id: 'c2', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved' }],   // no target_maker
    workstreams: [{ id: 'w', status: 'ready', review_points_done: [] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('no-independent-review'));
});

// FIX 1 regression (b): fix-loop 형태 — maker1 (done) + checker bound to maker1 (rejected) + maker2 (done) + checker bound to maker2 (approved) → 통과
test('finishProofState passes for a fix-loop (maker1+rejected-checker, maker2+approved-checker, same point)', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'm2', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'rejected', target_maker: 'm1' },
      { id: 'c2', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm2' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.deepEqual(finishProofState(loop).missing, []);
});

// final-fix-4 regression: a SINGLE done maker whose LATEST bound checker is REJECTED (older approve '002' then
// newer reject '003', both target '001') must NOT report complete — finishProofState must mirror next-action's
// order-aware supersededRejected (an older approve cannot mask a newer reject). Before the fix, boundApproved
// (any-approved) returned true → missing===[] (would COMPLETE), diverging from nextAction's fix_episode.
test('finishProofState blocks when a maker\'s LATEST bound checker is rejected (older approve, newer reject)', () => {
  const loop = { episodes: [
      { id: '001', role: 'maker', point: 'plan', workstream_id: 'w', status: 'done' },
      { id: '002', role: 'checker', plugin: 'subagent-checker', point: 'plan', workstream_id: 'w', status: 'approved', target_maker: '001' },
      { id: '003', role: 'checker', plugin: 'subagent-checker', point: 'plan', workstream_id: 'w', status: 'rejected', target_maker: '001' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['plan'] }], active_workstreams: [] };
  const ps = finishProofState(loop);
  assert.ok(ps.missing.includes('no-independent-review'), ps.missing.join(','));
});

// Codex adversarial: episode ids are zero-padded to only 3 digits, so string `>` mis-orders at the 999→1000
// boundary ('1000-x' < '999-x' lexicographically). The LATEST done maker for (w,implementation) is 1000-x, which
// is REJECTED — finishProofState MUST NOT report complete (the latest maker has no bound APPROVED checker).
test('finishProofState: 999 approved + 1000 rejected for same (ws,point) is NOT complete (999→1000 order)', () => {
  const loop = { episodes: [
      { id: '999-x', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: '0998-c', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: '999-x' },
      { id: '1000-x', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: '1001-c', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'rejected', target_maker: '1000-x' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  const ps = finishProofState(loop);
  assert.notEqual(ps.missing.length, 0, 'rejected newest maker (1000-x) must keep finishProofState NON-complete');
});

test('finishProofState: unmet review.points -> review-point-unsatisfied', () => {
  const loop = { review: { points: ['design', 'implementation'] },
    episodes: [
      { id: 'm', role: 'maker', point: 'design', workstream_id: 'w', status: 'done' },
      { id: 'c', role: 'checker', plugin: 'subagent-checker', point: 'design', workstream_id: 'w', status: 'approved', target_maker: 'm' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['design'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('review-point-unsatisfied'));
});

test('finishProofState: done maker not bound to existing workstream -> unbound-proof-episode', () => {
  const loop = { review: { points: [] },
    episodes: [
      { id: 'm', role: 'maker', point: 'implementation', workstream_id: null, status: 'done' },
      { id: 'c', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: null, status: 'approved', target_maker: 'm' }],
    workstreams: [], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unbound-proof-episode'));
});

test('finishProofState: abandoned episode counts as settled', () => {
  const loop = { review: { points: ['implementation'] },
    episodes: [
      { id: 'm', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c', role: 'checker', plugin: 'subagent-checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm' },
      { id: 'x', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'abandoned' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  const ps = finishProofState(loop);
  assert.ok(!ps.missing.includes('unsettled-episodes'), ps.missing.join(','));
});

// ROOT FIX (3) — a LEGACY unbound rejected checker is NEUTRAL. dispatchReview can no longer create an unbound checker
// (REVIEW_NO_ELIGIBLE_MAKER), so the only way an unbound rejected checker exists is in old loop.json. Such a checker
// "reviewed no maker" → rejectionResolved=true → NEUTRAL: it must NOT block finish (no strand) yet its neutrality is
// deliberate (the bound approval on the same point is the real proof). A hand-built loop with an approved point +
// a NEWER unbound rejected checker (003 > 002) is therefore FINISHABLE — missing has no unsettled/unbound entry.
test('finishProofState treats a legacy unbound rejected checker as neutral (no unsettled-episodes strand)', () => {
  const loop = { review: { points: ['plan'] },
    episodes: [
      { id: '001', role: 'maker', point: 'plan', workstream_id: 'w', status: 'done' },
      { id: '002', role: 'checker', plugin: 'subagent-checker', point: 'plan', workstream_id: 'w', status: 'approved', target_maker: '001' },
      { id: '003', role: 'checker', plugin: 'subagent-checker', point: 'plan', workstream_id: 'w', status: 'rejected' }],   // NEWER, unbound (legacy)
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['plan'] }], active_workstreams: [] };
  const ps = finishProofState(loop);
  assert.ok(!ps.missing.includes('unsettled-episodes'), ps.missing.join(','));
  assert.deepEqual(ps.missing, []);   // neutral → finishable, not stranded
});

// UNIFICATION — the RESOLVED unbound case (complement of [R4]): an UNBOUND rejected checker (002) addressed by a
// NEWER bound approval (003) for the same point is RESOLVED via rejectionResolved → settled → finishable (missing==[]).
test('finishProofState passes a RESOLVED unbound rejected checker (older reject, newer approval)', () => {
  const loop = { review: { points: ['plan'] },
    episodes: [
      { id: '001', role: 'maker', point: 'plan', workstream_id: 'w', status: 'done' },
      { id: '002', role: 'checker', plugin: 'subagent-checker', point: 'plan', workstream_id: 'w', status: 'rejected' },   // unbound, OLDER
      { id: '003', role: 'checker', plugin: 'subagent-checker', point: 'plan', workstream_id: 'w', status: 'approved', target_maker: '001' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['plan'] }], active_workstreams: [] };
  assert.deepEqual(finishProofState(loop).missing, []);
});

// --- finishRun 디스크 ---
test('finish completed is blocked on an empty run even with a report', () => {
  const { root, runId, fence } = seed();
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# report');
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }), /FINISH_PROOF_UNMET/);
});

test('finish completed is blocked without report (proof otherwise met)', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
});

test('finish completed succeeds with full proof + report', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# report');
  const r = finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence });
  assert.equal(r.status, 'completed');
});

// #4: stopped is a human-only bypass of completed-proof — it now carries the sibling --confirm gate (abandon/
// recover/breaker-reset) IN ADDITION to the human_reason string. completed is unaffected.
test('finish stopped requires --confirm AND human_reason', () => {
  const { root, runId, fence } = seed();
  // missing --confirm → CONFIRM_REQUIRED even with a human_reason (an autonomous driver can no longer self-supply it)
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'user asked' }, fence }), /CONFIRM_REQUIRED/);
  // confirm but no human_reason → FINISH_PROOF_UNMET
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: {}, confirm: true, fence }), /human_reason|FINISH_PROOF_UNMET/);
  // confirm + human_reason → stopped
  const r = finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'user asked' }, confirm: true, fence });
  assert.equal(r.status, 'stopped');
});

test('finish is fenced', () => {
  const { root, runId } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'x' }, fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);
});

// Codex r3 sf-3: fence 는 lib 레벨 필수 (CLI 우회 호출도 차단).
test('finishRun requires a fence object', () => {
  const { root, runId } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'x' } }), /FENCE_REQUIRED/);
});

// Codex r3 sf-3: report 경로는 runDir 하위로 격리 — 바깥 경로는 proof 미충족.
test('finish completed rejects a report path outside runDir', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: '../../escape.md', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
});

// Codex r4 critical-1: runDir 자체('.') 나 디렉터리('handoffs')는 final report 가 아니다 → 거부.
test('finish completed rejects runDir itself or a directory as the report', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  mkdirSync(join(runDir(root, runId), 'handoffs'), { recursive: true });
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: '.', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'handoffs', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
});

// impl-R1 Fix 2: a runDir-relative SYMLINK whose target is OUTSIDE the project must be refused — realpath deref
// containment (containedRealFile). resolve+startsWith+statSync(follow) would have accepted it.
test('finish completed rejects a runDir-relative symlink escaping the project (realpath containment)', (t) => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  const outside = mkdtempSync(join(tmpdir(), 'dl-fin-outside-'));
  writeFileSync(join(outside, 'report.md'), '# report outside the project');
  if (!createFileSymlinkOrSkip(t, join(outside, 'report.md'), join(runDir(root, runId), 'final-report.md'))) return;
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
});

// Regression: repro of real-world "009" stuck state — pending maker with zero expectedArtifacts
// blocks finish until abandonEpisode settles it.
test('repro: abandoning the orphan pending maker unblocks finish --status completed', () => {
  const { root, runId, fence } = seed();   // review.points=['implementation']
  const ws = newWorkstream(root, runId, { title: 'W', branch: 'b', worktree: '.claude/worktrees/wt', fence });
  // Normal sequence: done maker + approved checker (satisfies implementation review point).
  writeFileSync(join(root, 'art.txt'), 'x');
  const good = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws.id, expectedArtifacts: ['art.txt'], fence });
  recordEpisode(root, runId, good.id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence });
  const dr = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws.id, detected: {}, fence });
  mkdirSync(join(root, '.claude/worktrees/wt'), { recursive: true });
  writeFileSync(join(root, '.claude/worktrees/wt/review.md'), '# review report');
  recordReviewOutcome(root, runId, { episodeId: dr.checkerEpisodeId, verdict: 'APPROVE', proof: { report: '.claude/worktrees/wt/review.md' }, fence });
  // Orphan: stranded pending maker with zero expectedArtifacts — isomorphic to repro episode 009.
  const orphan = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws.id, expectedArtifacts: [], fence });
  recordWorkstreamTerminal(root, runId, ws.id, { status: 'ready', proof: {}, fence });
  // Mid-test assertion 1: orphan blocks finish.
  assert.ok(finishProofState(readState(root, runId).data).missing.includes('unsettled-episodes'));
  // Resolve via abandonEpisode (human-gated escape hatch).
  abandonEpisode(root, runId, orphan.id, { reason: 'orphan, no artifacts', confirm: true, fence });
  // Mid-test assertion 2: completed path succeeds after abandon.
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# done');
  const res = finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', fence });
  assert.equal(res.status, 'completed');
});

// ── Task 10D double-finish 회귀 ──────────────────────────────────────────────
test('a finish committed receipt keeps exact and different retries terminal', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# done');
  assert.equal(finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }).ok, true);
  const terminalBytes = bytes10d(root, runId);
  // 정상 완료 후 committed receipt는 crash-marker recovery authority가 아니다.
  assert.throws(() => finishRun(root, runId,
    { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }),
  /FINISH_ALREADY_TERMINAL/);
  assert.throws(() => finishRun(root, runId,
    { status: 'stopped', proof: { human_reason: 'x' }, confirm: true, fence }),
  /FINISH_ALREADY_TERMINAL/);
  assert.deepEqual(bytes10d(root, runId), terminalBytes);
  // finish 이벤트는 정확히 1개
  const log = readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8');
  assert.equal(log.split('\n').filter(l => l.includes('"type":"finish"')).length, 1);
});
function appFinishSeed10d(phase) {
  const root = mkdtempSync(join(tmpdir(), 'dl-app-finish-'));
  const observed = '2026-07-13T00:00:00.000Z';
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g',
    review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
      flags: [], converge: true, max_review_rounds: 5, require_human_ack: false },
    now: new Date(observed), hostObservation: { kind: 'codex-app',
      source: 'codex-app-tool-provenance',
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context',
      observed_at: observed }, cwdFn: () => root, appContinuationConsent: { mode: 'auto',
      authority: 'human-confirmed', confirmed_at: observed, revoked_at: null } });
  const parentFence = { owner: runId, generation: 1, runtime: 'codex', intent: 'business' };
  let fence = parentFence;
  buildSettledRun(root, runId, parentFence);
  writeFileSync(join(runDir(root, runId), 'final.md'), '# final');
  const attemptId = '01JAPPTASK0000000000000000';
  const descriptorBuilder = ({ runtime, root: projectRoot, parentRunId, childRunId }) => ({
    runtime, projectRoot, runId: parentRunId, usageOutputKind: 'json',
    resumeInvocation: childRunId, entries: Object.fromEntries(['interactive', 'headless', 'cmux',
      'iterm2', 'terminal-app', 'wt', 'powershell', 'desktop']
      .map(name => [name, { display: 'manual', unavailable: true }])) });
  const emitted = phase === 'before-emit' ? null
    : emitHandoff(root, runId, { trigger: phase, reason: `finish-${phase}`, appIntent: true,
      expect: { owner: runId, generation: 1 }, cwdFn: () => root, descriptorBuilder,
      attemptIdFactory: () => attemptId,
      nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  const request = { owner: runId, generation: 1, stdinMode: 'pty-raw-noecho',
    hostInput: { currentHostTaskCwd: root,
      projects: [{ projectId: 'p', projectKind: 'local', path: root }] } };
  const deps = { cwdFn: () => root, nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
    descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
      projectId: 'p', environment: { type: 'local' } }, prompt: 'prompt' }),
    reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }) };
  if (['prepared', 'confirmed', 'acquired'].includes(phase)) prepareAppTask(root, runId, request, deps);
  if (['confirmed', 'acquired'].includes(phase)) confirmAppTask(root, runId,
    { owner: runId, generation: 1, attemptId, stdinMode: 'pty-raw-noecho', threadId: 't' },
    { cwdFn: () => root,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const acquireInput = { attemptId, owner: emitted?.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho', observation: { kind: 'codex-app',
      source: 'codex-app-tool-provenance', capabilities: ['structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context' } };
  if (phase === 'acquired') {
    acquireAppTask(root, runId, acquireInput,
      { cwdFn: () => root, nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
    fence = { owner: emitted.childRunId, generation: 2,
      runtime: 'codex', intent: 'business' };
  }
  if (phase === 'failed') sweepUnconfirmedAppTask(root, runId,
    { owner: runId, generation: 1, attemptId },
    { cwdFn: () => root,
      nowFn: () => Date.parse('2026-07-13T00:05:01.001Z') });
  if (phase === 'abandoned') revokeAppTaskContinuation(root, runId,
    { owner: runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z') });
  return { root, runId, fence, parentFence, attemptId,
    childRunId: emitted?.childRunId ?? null, acquireInput, request, deps, descriptorBuilder };
}

function mutationCase10d(operation) {
  const phase = ({ emit: 'before-emit', prepare: 'emitted', confirm: 'prepared',
    fail: 'prepared', sweep: 'emitted', 'await-timeout': 'confirmed',
    acquire: 'confirmed', recover: 'abandoned', finish: 'emitted' })[operation];
  if (phase === undefined) throw new Error(`PUBLIC_MUTATION_CASE_UNKNOWN: ${operation}`);
  const fixture = appFinishSeed10d(phase);
  const parent = (different = false, foreign = false) => ({
    owner: foreign ? '01JAPPF0R00000000000000000' : fixture.runId,
    generation: 1, attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho',
  });
  const invoke = ({ different = false, foreign = false, wrongMode = false,
    wrongRuntime = false, equivalentObservation = false, pathDeps } = {}) => {
    const input = parent(different, foreign);
    if (operation === 'emit') return emitHandoff(fixture.root, fixture.runId, {
      trigger: 'crash-emit', reason: different ? 'different' : 'same', appIntent: true,
      expect: { owner: input.owner, generation: input.generation },
      cwdFn: () => fixture.root, descriptorBuilder: fixture.descriptorBuilder,
      attemptIdFactory: () => fixture.attemptId,
      nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
    if (operation === 'prepare') return prepareAppTask(fixture.root, fixture.runId,
      { ...fixture.request, owner: input.owner,
        hostInput: different ? { ...fixture.request.hostInput,
          currentHostTaskCwd: `${fixture.root}-different` } : fixture.request.hostInput }, fixture.deps);
    if (operation === 'confirm') return confirmAppTask(fixture.root, fixture.runId,
      { ...input, stdinMode: wrongMode ? 'pipe-open-noecho' : input.stdinMode,
        threadId: different ? 'different-thread' : 'confirmed-thread' },
      { cwdFn: () => fixture.root,
        nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
    if (operation === 'fail') return failAppTask(fixture.root, fixture.runId,
      { owner: input.owner, generation: input.generation, attemptId: input.attemptId,
        code: different ? 'message-unconfirmed' : 'host-call-failed',
        ...(different ? { stdinMode: wrongMode ? 'pipe-open-noecho' : input.stdinMode,
          unconfirmedThreadId: 'different-thread' } : {}) },
      { cwdFn: () => fixture.root,
        nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
    if (operation === 'sweep') return sweepUnconfirmedAppTask(fixture.root, fixture.runId,
      { ...input, deadline: different ? '2026-07-13T00:06:00.000Z'
        : '2026-07-13T00:05:00.000Z' },
      { cwdFn: () => fixture.root,
        nowFn: () => Date.parse('2026-07-13T00:05:01.001Z') });
    if (operation === 'await-timeout') {
      let pollClock = Date.parse('2026-07-13T00:00:03.000Z');
      return awaitAppTask(fixture.root, fixture.runId,
        { ...input, timeoutMs: different ? 2 : 1, intervalMs: 1 },
        { cwdFn: () => fixture.root, nowFn: () => pollClock + 1,
          pollNowFn: () => pollClock, pollIntervalMs: 1_000,
          sleepFn: ms => { pollClock += ms; } });
    }
    if (operation === 'acquire') return acquireAppTask(fixture.root, fixture.runId,
      { ...fixture.acquireInput, owner: foreign ? input.owner : fixture.childRunId,
        runtime: wrongRuntime ? 'claude' : fixture.acquireInput.runtime,
        observation: different ? { ...fixture.acquireInput.observation,
          structured_stdin_mode: 'pipe-open-noecho' }
          : equivalentObservation ? { ...fixture.acquireInput.observation,
            host_task_cwd: `${fixture.root}/.` } : fixture.acquireInput.observation },
      { cwdFn: pathDeps === undefined ? () => fixture.root
        : () => assert.fail('pending acquire identity fence must precede cwd callback'),
        ...(pathDeps === undefined ? {} : { pathDeps }),
        nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
    if (operation === 'recover') return recoverRun(fixture.root, fixture.runId,
      { expect: { owner: input.owner, generation: input.generation }, confirm: true });
    return finishRun(fixture.root, fixture.runId, { status: 'completed',
      reportRel: different ? 'different-final.md' : 'final.md',
      proof: { human_reason: different ? 'different' : 'same' },
      fence: { owner: input.owner, generation: input.generation,
        runtime: 'codex', intent: 'business' } });
  };
  return { fixture, invoke };
}

function journalBytes10d(root, runId) {
  const directory = runDir(root, runId);
  return Object.fromEntries(list10d(directory).sort()
    .filter(name => name.startsWith('.anchored-') || name === 'loop.json'
      || name === '.loop.hash' || name === 'event-log.jsonl'
      || name === 'loop.json.replace' || name === '.loop.hash.replace')
    .map(name => [name, read10d(join(directory, name))]));
}

function fixedJournalInventory10d(root, runId) {
  return list10d(runDir(root, runId)).sort().filter(name =>
    name.startsWith('.anchored-') && name !== '.anchored-committed.json'
      || name === 'loop.json.replace'
      || name === '.loop.hash.replace');
}

function expectedJournalInventory10d(point) {
  if (point === 'state-stage-after-rename') return ['.anchored-state.stage'];
  if (point === 'event-stage-after-rename') {
    return ['.anchored-events.stage', '.anchored-state.stage'];
  }
  const names = ['.anchored-events.stage', '.anchored-hash.stage',
    '.anchored-pending.json', '.anchored-state.stage'];
  if (['state-replace-after-create', 'state-replace-after-fsync'].includes(point)) {
    names.push('loop.json.replace');
  }
  if (['hash-replace-after-create', 'hash-replace-after-fsync'].includes(point)) {
    names.push('.loop.hash.replace');
  }
  return names.sort();
}

function canonicalBytes10d(root, runId) {
  const directory = runDir(root, runId);
  return Object.fromEntries(['event-log.jsonl', 'loop.json', '.loop.hash']
    .map(name => [name, read10d(join(directory, name))]));
}

const CRASH_WORKER_TIMEOUT_MS10D = 10_000;
const PRE_MARKER_CRASH_POINTS10D = new Set([
  'state-stage-after-rename', 'event-stage-after-rename',
]);
const PUBLIC_MUTATION_EVENT10D = Object.freeze({
  emit: 'handoff-emitted', prepare: 'app-task-prepared', confirm: 'app-task-confirmed',
  fail: 'app-task-failed', sweep: 'app-task-swept',
  'await-timeout': 'app-task-await-timeout', acquire: 'app-task-acquired',
  recover: 'run-recovered', finish: 'finish',
});

function assertCrashWorkerExit10d(child) {
  assert.notEqual(child.error?.code, 'ETIMEDOUT',
    `crash worker exceeded ${CRASH_WORKER_TIMEOUT_MS10D}ms`);
  assert.equal(child.status, 91, child.stderr || child.stdout || child.error?.message);
}

function assertPublicMutationCrashRecovery10d({ operation, crashPoint, worker }) {
  const { fixture, invoke } = mutationCase10d(operation);
  const canonicalBefore = canonicalBytes10d(fixture.root, fixture.runId);
  const child = spawn10d(process.execPath,
    [fileURLToPath(worker), fixture.root, fixture.runId, operation, crashPoint], {
      shell: false, encoding: 'utf8', env: { ...process.env,
        DEEP_LOOP_CRASH_OWNER: fixture.runId,
        DEEP_LOOP_CRASH_GENERATION: '1',
        DEEP_LOOP_CRASH_INPUT: JSON.stringify({ owner: fixture.runId, generation: 1,
          attemptId: fixture.attemptId, childRunId: fixture.childRunId }) },
      timeout: CRASH_WORKER_TIMEOUT_MS10D,
    });
  assertCrashWorkerExit10d(child);
  // The exact worker is dead. Remove only its orphan run lock to accelerate the production stale
  // TTL; the foreign and exact public retries below remain the only journal recovery attempts.
  rmdir10d(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  const pending = journalBytes10d(fixture.root, fixture.runId);
  const markerBacked = !PRE_MARKER_CRASH_POINTS10D.has(crashPoint);
  assert.equal(Object.hasOwn(pending, '.anchored-pending.json'), markerBacked);
  assert.deepEqual(fixedJournalInventory10d(fixture.root, fixture.runId),
    expectedJournalInventory10d(crashPoint),
  `${operation}/${crashPoint} exact journal inventory`);
  if (markerBacked) {
    assert.throws(() => verified10d(fixture.root, fixture.runId),
      /ANCHORED_TRANSACTION_PENDING/);
  } else {
    assert.doesNotThrow(() => verified10d(fixture.root, fixture.runId));
  }
  assert.deepEqual(journalBytes10d(fixture.root, fixture.runId), pending,
    `${operation}/${crashPoint} read-only verification changed journal bytes`);
  if (!markerBacked) {
    assert.deepEqual(canonicalBytes10d(fixture.root, fixture.runId), canonicalBefore,
      `${operation}/${crashPoint} changed canonical bytes before marker publication`);
    invoke();
    assert.deepEqual(fixedJournalInventory10d(fixture.root, fixture.runId), [],
      `${operation}/${crashPoint} exact post-recovery cleanup`);
    assert.equal(readLines(fixture.root, fixture.runId)
      .filter(event => event.type === PUBLIC_MUTATION_EVENT10D[operation]).length, 1);
    return;
  }
  const noAcquirePathCallbacks = Object.freeze({ platform: process.platform,
    exists: () => assert.fail('pending acquire identity fence must precede exists callback'),
    realpath: () => assert.fail('pending acquire identity fence must precede realpath callback'),
    stat: () => assert.fail('pending acquire identity fence must precede stat callback'),
    sameFile: () => assert.fail('pending acquire identity fence must precede sameFile callback') });
  const variants = [operation === 'acquire'
    ? { foreign: true, pathDeps: noAcquirePathCallbacks } : { foreign: true },
    ...(operation === 'recover' ? [] : [{ different: true }]),
    ...(operation === 'confirm' ? [{ wrongMode: true }] : []),
    ...(operation === 'acquire'
      ? [{ wrongRuntime: true, pathDeps: noAcquirePathCallbacks }] : [])];
  for (const variant of variants) {
    let result;
    try { result = invoke(variant); }
    catch (error) { assert.match(String(error?.message || error), /FENCED|PENDING/i); }
    if (result !== undefined) assert.equal(result.ok, false);
    assert.deepEqual(journalBytes10d(fixture.root, fixture.runId), pending,
      `${operation}/${crashPoint} divergent retry changed bytes`);
  }
  invoke();
  assert.deepEqual(fixedJournalInventory10d(fixture.root, fixture.runId), [],
    `${operation}/${crashPoint} exact post-recovery cleanup`);
  assert.equal(readLines(fixture.root, fixture.runId)
    .filter(event => event.type === PUBLIC_MUTATION_EVENT10D[operation]).length, 1);
}

test('finish settles every App phase without weakening proof or fence', () => {
  for (const phase of ['emitted', 'prepared', 'confirmed', 'failed', 'abandoned', 'acquired']) {
    const fixture = appFinishSeed10d(phase);
    assert.throws(() => finishRun(fixture.root, fixture.runId, { status: 'completed',
      reportRel: 'final.md', fence: { owner: '01JAPPWR0NG000000000000000', generation: 1,
        runtime: 'claude' } }), /LEASE_FENCED/);
    assert.throws(() => finishRun(fixture.root, fixture.runId, { status: 'completed',
      reportRel: 'final.md', fence: { ...fixture.fence, runtime: 'claude' } }),
    /RUNTIME_FENCED/);
    finishRun(fixture.root, fixture.runId, { status: 'completed', reportRel: 'final.md',
      fence: fixture.fence });
    const loop = readState(fixture.root, fixture.runId).data;
    const continuation = loop.session_chain.sessions
      .find(session => session.run_id === fixture.childRunId).continuation;
    assert.equal(loop.status, 'completed');
    assert.equal(continuation.phase,
      ['failed', 'abandoned', 'acquired'].includes(phase) ? phase : 'abandoned');
    if (!['failed', 'abandoned', 'acquired'].includes(phase)) {
      assert.equal(continuation.failure_code, 'run-finished');
    }
    for (const key of ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
      'handoff_idempotency_key', 'resume_policy', 'expires_at']) {
      assert.equal(loop.session_chain.lease[key], null);
    }
    assert.equal(readLines(fixture.root, fixture.runId)
      .filter(event => event.type === 'finish').length, 1);
    const finishEvent = readLines(fixture.root, fixture.runId)
      .filter(event => event.type === 'finish').at(-1);
    const expectedFailure = ['emitted', 'prepared', 'confirmed'].includes(phase)
      ? 'run-finished' : phase === 'failed'
        ? 'app-prepare-unattended' : 'consent-revoked';
    if (phase === 'acquired') {
      assert.equal(finishEvent.data.attempt_id, undefined);
      const terminalBytes = bytes10d(fixture.root, fixture.runId);
      assert.throws(() => acquireAppTask(fixture.root, fixture.runId, fixture.acquireInput,
        { cwdFn: () => fixture.root,
          nowFn: () => assert.fail('terminal acquire retry has no clock') }),
      /APP_ACQUIRE_PROJECTION_CHANGED/);
      assert.deepEqual(bytes10d(fixture.root, fixture.runId), terminalBytes);
    } else {
      assert.equal(finishEvent.data.attempt_id, fixture.attemptId);
      assert.equal(finishEvent.data.child_run_id, fixture.childRunId);
      assert.equal(finishEvent.data.failure_code, expectedFailure);
    }
  }
});

test('finish identity fence precedes proof and corrupt App state writes no bytes', () => {
  const fixture = appFinishSeed10d('emitted');
  raw10d(fixture.root, fixture.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:09.000Z';
  });
  const before = bytes10d(fixture.root, fixture.runId);
  assert.throws(() => finishRun(fixture.root, fixture.runId, { status: 'stopped',
    confirm: true, proof: { human_reason: 'wrong caller' },
    fence: { owner: 'wrong', generation: 1, runtime: 'codex' },
    nowFn: () => assert.fail('wrong caller cannot sample finish clock') }), /LEASE_FENCED/);
  assert.throws(() => finishRun(fixture.root, fixture.runId, { status: 'stopped',
    confirm: true, proof: { human_reason: 'correct corrupt caller' },
    fence: fixture.fence }), /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(bytes10d(fixture.root, fixture.runId), before);
});

test('every real App mutation recovers its own journal before its first canonical read', () => {
  const operations = [
    'emit', 'prepare', 'confirm', 'fail', 'sweep', 'await-timeout',
    'acquire', 'recover', 'finish',
  ];
  const crashPoints = [
    'state-stage-after-rename', 'event-stage-after-rename', 'pending-after-rename',
    'event-after-partial-append', 'event-after-full-append', 'state-after-rename',
    'hash-after-rename', 'before-cleanup',
    'state-replace-after-create', 'state-replace-after-fsync',
    'state-replace-after-rename-before-dir-fsync',
    'hash-replace-after-create', 'hash-replace-after-fsync',
    'hash-replace-after-rename-before-dir-fsync',
  ];
  for (const operation of operations) {
    for (const crashPoint of crashPoints) {
      assertPublicMutationCrashRecovery10d({ operation, crashPoint,
        worker: new URL('./helpers/anchored-crash-worker.mjs', import.meta.url) });
    }
  }
});

test('finish pending recovery succeeds once but its committed receipt stays terminal', () => {
  const { fixture, invoke } = mutationCase10d('finish');
  const worker = new URL('./helpers/anchored-crash-worker.mjs', import.meta.url);
  const child = spawn10d(process.execPath,
    [fileURLToPath(worker), fixture.root, fixture.runId, 'finish', 'pending-after-rename'], {
      shell: false, encoding: 'utf8', env: { ...process.env,
        DEEP_LOOP_CRASH_OWNER: fixture.runId,
        DEEP_LOOP_CRASH_GENERATION: '1',
        DEEP_LOOP_CRASH_INPUT: JSON.stringify({ owner: fixture.runId, generation: 1,
          attemptId: fixture.attemptId, childRunId: fixture.childRunId }) },
      timeout: CRASH_WORKER_TIMEOUT_MS10D,
    });
  assertCrashWorkerExit10d(child);
  rmdir10d(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  assert.deepEqual(invoke(), { ok: true, status: 'completed' });
  const terminalBytes = bytes10d(fixture.root, fixture.runId);
  assert.throws(() => invoke(), /FINISH_ALREADY_TERMINAL/);
  assert.deepEqual(bytes10d(fixture.root, fixture.runId), terminalBytes);
});

test('legacy first finish recovers its lineage checkpoint with the stopped result', () => {
  const fixture = legacyFinish10d();
  const moduleHref = new URL('../scripts/lib/finish.mjs', import.meta.url).href;
  const child = spawn10d(process.execPath, ['--input-type=module', '--eval',
    `import { finishRun } from ${JSON.stringify(moduleHref)};
     finishRun(process.argv[1], process.argv[2], { status: 'stopped', confirm: true,
       proof: { human_reason: 'legacy crash' },
       fence: { owner: process.argv[2], generation: 1, runtime: 'codex' } });`,
    fixture.root, fixture.runId], { shell: false, encoding: 'utf8', env: { ...process.env,
      NODE_ENV: 'test', DEEP_LOOP_TEST_CRASH_AT: 'pending-after-rename' }, timeout: 10_000 });
  assertCrashWorkerExit10d(child);
  rmdir10d(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  assert.deepEqual(finishRun(fixture.root, fixture.runId, { status: 'stopped', confirm: true,
    proof: { human_reason: 'legacy crash' }, fence: fixture.fence,
    nowFn: () => assert.fail('pending legacy finish recovery cannot sample a new clock') }),
  { ok: true, status: 'stopped' });
  assert.deepEqual(readLines(fixture.root, fixture.runId).slice(-3).map(event => event.type),
    ['lease-lineage-baselined', 'finish', 'cost']);
});

test('same-length staged-event corruption is rejected before any canonical mutation', () => {
  const { fixture, invoke } = mutationCase10d('confirm');
  const worker = new URL('./helpers/anchored-crash-worker.mjs', import.meta.url);
  const child = spawn10d(process.execPath,
    [fileURLToPath(worker), fixture.root, fixture.runId, 'confirm', 'pending-after-rename'], {
      shell: false, encoding: 'utf8', env: { ...process.env,
        DEEP_LOOP_CRASH_OWNER: fixture.runId,
        DEEP_LOOP_CRASH_GENERATION: '1',
        DEEP_LOOP_CRASH_INPUT: JSON.stringify({ owner: fixture.runId, generation: 1,
          attemptId: fixture.attemptId, childRunId: fixture.childRunId }) },
      timeout: CRASH_WORKER_TIMEOUT_MS10D,
    });
  assertCrashWorkerExit10d(child);
  rmdir10d(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  const canonicalBefore = canonicalBytes10d(fixture.root, fixture.runId);
  const stagePath = join(runDir(fixture.root, fixture.runId), '.anchored-events.stage');
  const corrupted = Buffer.from(read10d(stagePath));
  corrupted[0] = corrupted[0] === 0x7b ? 0x5b : 0x7b;
  write10d(stagePath, corrupted);
  assert.throws(() => invoke(), /ANCHORED_TRANSACTION_CORRUPT: stage digest/);
  assert.deepEqual(canonicalBytes10d(fixture.root, fixture.runId), canonicalBefore,
    'untrusted same-length stage bytes cannot change canonical event/state/hash bytes');
});

test('dangling journal symlink is corruption and never cleanup authority',
  { skip: process.platform === 'win32' }, () => {
    const { fixture, invoke } = mutationCase10d('confirm');
    const canonicalBefore = canonicalBytes10d(fixture.root, fixture.runId);
    symlink10d(join(fixture.root, 'missing-stage-target'),
      join(runDir(fixture.root, fixture.runId), '.anchored-events.stage'));
    assert.throws(() => invoke(), /ANCHORED_TRANSACTION_CORRUPT/);
    assert.deepEqual(canonicalBytes10d(fixture.root, fixture.runId), canonicalBefore);
  });

test('published confirm marker plus a different receipt is the public App fence', () => {
  const { fixture, invoke } = mutationCase10d('confirm');
  const worker = new URL('./helpers/anchored-crash-worker.mjs', import.meta.url);
  const child = spawn10d(process.execPath,
    [fileURLToPath(worker), fixture.root, fixture.runId, 'confirm', 'pending-after-rename'], {
      shell: false, encoding: 'utf8', env: { ...process.env,
        DEEP_LOOP_CRASH_OWNER: fixture.runId,
        DEEP_LOOP_CRASH_GENERATION: '1',
        DEEP_LOOP_CRASH_INPUT: JSON.stringify({ owner: fixture.runId, generation: 1,
          attemptId: fixture.attemptId, childRunId: fixture.childRunId }) },
      timeout: CRASH_WORKER_TIMEOUT_MS10D,
    });
  assertCrashWorkerExit10d(child);
  rmdir10d(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  const pending = journalBytes10d(fixture.root, fixture.runId);
  assert.throws(() => invoke({ different: true }), /APP_RECEIPT_FENCED/);
  assert.deepEqual(journalBytes10d(fixture.root, fixture.runId), pending);
  invoke();
});

test('published acquire marker accepts an equivalent normalized observation intent', () => {
  const { fixture, invoke } = mutationCase10d('acquire');
  const worker = new URL('./helpers/anchored-crash-worker.mjs', import.meta.url);
  const child = spawn10d(process.execPath,
    [fileURLToPath(worker), fixture.root, fixture.runId, 'acquire', 'pending-after-rename'], {
      shell: false, encoding: 'utf8', env: { ...process.env,
        DEEP_LOOP_CRASH_OWNER: fixture.runId,
        DEEP_LOOP_CRASH_GENERATION: '1',
        DEEP_LOOP_CRASH_INPUT: JSON.stringify({ owner: fixture.runId, generation: 1,
          attemptId: fixture.attemptId, childRunId: fixture.childRunId }) },
      timeout: CRASH_WORKER_TIMEOUT_MS10D,
    });
  assertCrashWorkerExit10d(child);
  rmdir10d(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  const result = invoke({ equivalentObservation: true });
  assert.equal(result.outcome, 'already-acquired');
  assert.deepEqual(fixedJournalInventory10d(fixture.root, fixture.runId), []);
});
