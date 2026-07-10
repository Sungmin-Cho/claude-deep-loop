// P1+P2 (hillclimb-ledger 2026-07-10 release-blocking proposals) — reviewer 식별자 fail-closed + hill-climb 계약 가용성.
// P1: 문서화된 init 경로가 inline-review로 조용히 강등되는 3경로 봉합 —
//   ① 네임스페이스 접두(`deep-review:deep-review-loop`) 정규화 ② 인식 리터럴 `deep-review` alias canonicalize
//   ③ 미인식 reviewer fail-closed 거부(inline-review fallback 제거) ④ deep-review 의존성-부재 시 fail-closed
//   (codex-cross/subagent-checker 조용한 대체 제거). recordReviewOutcome은 report producer를 검증하지 않으므로
//   강등된 리뷰도 proof를 만족한다 — 강등은 에러여야 한다(silent downgrade = review-gate 침묵 약화).
// P2: hill-climb run의 checker 계약(HILLCLIMB-001)이 gitignored 로컬에만 있으면 fresh checkout에서
//   무-contract skip으로 계약 미강제 APPROVE가 가능 — tracked 소스 + dispatch 시 부재 fail-closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { resolveReviewer, dispatchReview } from '../scripts/lib/review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TRACKED_CONTRACT = join(here, '..', 'skills', 'deep-loop-workflow', 'references', 'contracts', 'HILLCLIMB-001.yaml');

function fence(runId) { return { owner: runId, generation: 1, intent: 'business' }; }

function seedRun({ reviewer, flags = [], recipe, detected = { 'deep-review': true, codex: true } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-fc-'));
  const review = reviewer
    ? { points: ['design', 'plan', 'implementation'], reviewer, mode: 'cross-model', flags, converge: true, max_review_rounds: 5, require_human_ack: true }
    : undefined;
  const { runId } = initRun(root, { goal: recipe === 'harness-hill-climb' ? '하네스 개선' : 'g', recipe, review, detected, now: new Date('2026-07-10T00:00:00Z') });
  return { root, runId, f: fence(runId) };
}

function doneMakerOn(root, runId, f, point = 'design') {
  const ws = newWorkstream(root, runId, { title: point, branch: 'b-' + point, worktree: '.claude/worktrees/w-' + point, fence: f }).id;
  const art = `${point}-art.txt`;
  writeFileSync(join(root, art), 'artifact');
  const { id } = newEpisode(root, runId, { plugin: 'standalone', role: 'maker', kind: point, point, workstream: ws, expectedArtifacts: [art], fence: f });
  recordEpisode(root, runId, id, { status: 'done', artifacts: [art], proof: {}, fence: f });
  return ws;
}

function episodeCount(root, runId) {
  return readState(root, runId).data.episodes.length;
}

// ── P1 ① 네임스페이스 접두 정규화 — SKILL.md가 예시하는 형식이 커널에서 그대로 동작해야 한다 ──
test('P1: namespaced reviewer id normalizes to deep-review-loop and dispatches the real skill', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review:deep-review-loop', flags: ['--codex-only', '--max=7'] });
  assert.equal(resolveReviewer(readState(root, runId).data, { 'deep-review': true }).reviewer, 'deep-review-loop');
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
  assert.equal(r.descriptor.args, '--codex-only --max=7');
});

// ── P1 ② 인식 리터럴 `deep-review` alias — resolveReviewer는 인식하지만 skillByReviewer 맵에 없어
//    inline-review로 강등되던 갭(checker-020 BB) ──
test('P1: deep-review alias canonicalizes to deep-review-loop (no inline-review downgrade)', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review', flags: ['--codex-only'] });
  assert.equal(resolveReviewer(readState(root, runId).data, { 'deep-review': true }).reviewer, 'deep-review-loop');
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
});

// ── P1 ③ 미인식 reviewer — inline-review fallback 대신 fail-closed, checker episode 미생성 ──
test('P1: unrecognized reviewer fails closed and creates no checker episode', () => {
  const { root, runId, f } = seedRun({ reviewer: 'totally-unknown-reviewer' });
  assert.throws(() => resolveReviewer(readState(root, runId).data, { 'deep-review': true }), /REVIEWER_UNRECOGNIZED/);
  const ws = doneMakerOn(root, runId, f);
  const before = episodeCount(root, runId);
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
    /REVIEWER_UNRECOGNIZED/);
  assert.equal(episodeCount(root, runId), before, 'no checker episode on unrecognized reviewer');
});

// ── P1 ④ deep-review 의존성-부재 — codex 유무 양쪽에서 조용한 대체(codex-cross/subagent-checker) 대신
//    fail-closed(AQ1: 인식된 contract-capable reviewer의 대체는 계약을 소비하지 않는 checker를 만든다) ──
test('P1: configured deep-review reviewer with plugin absent fails closed (codex present)', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  assert.throws(
    () => resolveReviewer(readState(root, runId).data, { 'deep-review': false, codex: true }),
    /REVIEWER_DEPENDENCY_MISSING/);
  const ws = doneMakerOn(root, runId, f);
  const before = episodeCount(root, runId);
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': false, codex: true }, fence: f }),
    /REVIEWER_DEPENDENCY_MISSING/);
  assert.equal(episodeCount(root, runId), before, 'no checker episode on missing dependency');
});

test('P1: configured deep-review reviewer with plugin absent fails closed (codex absent)', () => {
  const { root, runId } = seedRun({ reviewer: 'deep-review-loop' });
  assert.throws(
    () => resolveReviewer(readState(root, runId).data, { 'deep-review': false, codex: false }),
    /REVIEWER_DEPENDENCY_MISSING/);
});

// ── P1 보존 — 강등이 아닌 승격(subagent-checker → codex-cross)과 정상 경로는 유지 ──
test('P1: subagent-checker promotion to codex-cross and normal paths are preserved', () => {
  const { root, runId } = seedRun({ reviewer: 'subagent-checker' });
  const data = readState(root, runId).data;
  assert.equal(resolveReviewer(data, { codex: true }).reviewer, 'codex-cross');
  assert.equal(resolveReviewer(data, { codex: false }).reviewer, 'subagent-checker');
  const dr = seedRun({ reviewer: 'deep-review-loop' });
  assert.equal(resolveReviewer(readState(dr.root, dr.runId).data, { 'deep-review': true }).reviewer, 'deep-review-loop');
});

// ── P2 tracked 계약 소스 — repo에 존재 + 필수 형태 (parity) ──
test('P2: tracked HILLCLIMB-001 contract exists with required shape', () => {
  assert.ok(existsSync(TRACKED_CONTRACT), 'tracked contract yaml must exist in references/contracts/');
  const y = readFileSync(TRACKED_CONTRACT, 'utf8');
  assert.match(y, /^slice:\s*HILLCLIMB-001/m);
  assert.match(y, /^status:\s*active/m);
  assert.match(y, /^criteria:/m);
  // phase-적용성 parity: (d)(f)가 implementation 전용으로 마킹되어 있어야 §3.4와 정합
  assert.match(y, /\(d\).*implementation/i);
  assert.match(y, /\(f\).*implementation/i);
});

// ── P2 계약-부재 dispatch fail-closed — hill-climb run은 active 계약 없이 checker를 만들 수 없다 ──
test('P2: hill-climb run dispatch fails closed without materialized contract (no episode)', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  const before = episodeCount(root, runId);
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
  assert.equal(episodeCount(root, runId), before, 'no checker episode without contract');
});

test('P2: hill-climb run dispatch succeeds after contract is materialized from tracked source', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  mkdirSync(join(root, '.deep-review', 'contracts'), { recursive: true });
  copyFileSync(TRACKED_CONTRACT, join(root, '.deep-review', 'contracts', 'HILLCLIMB-001.yaml'));
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
});

// ── P2 스코프 한정 — hill-climb이 아닌 recipe는 계약 게이트 비대상(무회귀) ──
test('P2: non-hill-climb runs are not gated by contract presence', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
});
