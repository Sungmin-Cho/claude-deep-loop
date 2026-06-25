import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { newWorkstream, recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { finishRun, finishProofState } from '../scripts/lib/finish.mjs';

// Codex r2 should-fix-2: review.points 를 ['implementation'] 한 개로 시드해야 recordWorkstreamTerminal('ready')
// 의 "전 review point done" 게이트(workspace.mjs:77-82, 기본 [design,plan,implementation])를 한 번의 approve 로 충족한다.
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-fin-'));
  const review = { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false };
  const { runId } = initRun(root, { goal: 'g', review, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}

// 완전히 settled+reviewed+terminal 인 run 을 실제 lib 계약대로 조립 (completed proof 충족).
// Codex r2 sf-2: recordEpisode('done')는 expected_artifacts 가 비어있지 않고 실제 파일이 root 하위에 존재해야 한다
// (episode.mjs:89-112). recordWorkstreamTerminal('ready')는 전 review point coverage 필요(위 seed 가 1개로 축소).
function buildSettledRun(root, runId, fence) {
  writeFileSync(join(root, 'art.txt'), 'artifact');   // expected artifact 가 디스크에 존재해야 done 통과
  const ws = newWorkstream(root, runId, { title: 'W', branch: 'b', worktree: 'wt', fence });
  const ep = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws.id, expectedArtifacts: ['art.txt'], fence });
  recordEpisode(root, runId, ep.id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence });   // artifacts 가 expected 를 커버
  const dr = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws.id, detected: {}, fence });
  recordReviewOutcome(root, runId, { episodeId: dr.checkerEpisodeId, workstreamId: ws.id, point: 'implementation', verdict: 'APPROVE', fence });
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
      { id: 'c', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.deepEqual(finishProofState(loop).missing, []);
});

// Codex r6 critical-1: 한 maker 는 리뷰됐지만 다른 done maker 는 미리뷰면 completed 차단.
test('finishProofState blocks when any one done maker is unreviewed', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'approved' },
      { id: 'm2', role: 'maker', point: 'plan', workstream_id: 'w', status: 'done' }],   // 'plan' 리뷰 없음
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unreviewed-maker'));
});

// FIX 1 regression: 같은 ws+point 에 done maker 2명인데 approved checker 가 1명뿐 → unreviewed-maker
test('finishProofState blocks two done makers sharing one approved checker (anomaly: count-based)', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'm2', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'approved' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unreviewed-maker'));
});

// Plan-3 r3 fix: two done makers same ws+point, TWO checkers both bound to maker1 (one approved), maker2 unbound → blocks.
// Validates per-maker binding: checkers for maker1 cannot satisfy maker2's review requirement.
test('finishProofState blocks when two checkers are both bound to maker1 but maker2 has no bound checker', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'm2', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'rejected', target_maker: 'm1' },
      { id: 'c2', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm1' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unreviewed-maker'));
});

// FIX 1 regression: fix-loop 형태 — maker1 (done) + checker bound to maker1 (rejected) + maker2 (done) + checker bound to maker2 (approved) → 통과
test('finishProofState passes for a fix-loop (maker1+rejected-checker, maker2+approved-checker, same point)', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'm2', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'rejected', target_maker: 'm1' },
      { id: 'c2', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'approved', target_maker: 'm2' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
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

test('finish stopped requires human_reason', () => {
  const { root, runId, fence } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: {}, fence }), /human_reason|FINISH_PROOF_UNMET/);
  const r = finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'user asked' }, fence });
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
