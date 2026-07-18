import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { newWorkstream, recordWorkstreamTerminal } from './helpers/workstream-request.mjs';
import { newEpisode, recordEpisode, abandonEpisode } from './helpers/episode-request.mjs';
import { dispatchReview, recordReviewOutcome } from './helpers/review-request.mjs';
import { finishRun, finishProofState } from '../scripts/lib/finish.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
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

// ── v1.6 double-finish 회귀 (spec §2.2/§4-3) ─────────────────────────────────
test('exact finish response-loss retry is inert while a different finish remains terminal-fenced', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# done');
  assert.equal(finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }).ok, true);
  // 동일 caller+intent의 response-loss retry는 committed receipt에서 원래 결과를 복원한다.
  assert.equal(finishRun(root, runId,
    { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }).ok, true);
  // 다른 intent는 receipt를 재사용하지 않으며 기존 terminal fence를 그대로 받는다.
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'x' }, confirm: true, fence }), /LEASE_FENCED: RUN_TERMINAL/);
  // finish 이벤트는 정확히 1개
  const log = readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8');
  assert.equal(log.split('\n').filter(l => l.includes('"type":"finish"')).length, 1);
});
