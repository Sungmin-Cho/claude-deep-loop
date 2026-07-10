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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { resolveReviewer, dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';

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

// ── P1 ②-b 네임스페이스 canonicalize는 문서화된 정확히 한 형식만(codex r1) — 임의 `deep-review:*`
//    prefix-strip은 `deep-review:standalone` 류를 더 약한 checker로 통과시키는 또 다른 침묵 경로 ──
test('P1: other deep-review-namespaced ids are rejected, not prefix-stripped', () => {
  for (const bad of ['deep-review:standalone', 'deep-review:subagent-checker', 'deep-review:codex-cross']) {
    const { root, runId } = seedRun({ reviewer: bad });
    assert.throws(() => resolveReviewer(readState(root, runId).data, { 'deep-review': true }), /REVIEWER_UNRECOGNIZED/, bad);
  }
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

// 게이트 위치 = 소비처(codex r1) — checker는 worktree cwd에서 deep-review를 실행하므로 계약은
// worktree-local `.deep-review/contracts/`에 있어야 한다. project-root 사본만으로는 통과 불가.
function materializeContract(root, worktreeRel) {
  mkdirSync(join(root, worktreeRel, '.deep-review', 'contracts'), { recursive: true });
  copyFileSync(TRACKED_CONTRACT, join(root, worktreeRel, '.deep-review', 'contracts', 'HILLCLIMB-001.yaml'));
}

test('P2: hill-climb run dispatch succeeds after contract is materialized into the workstream worktree', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  materializeContract(root, '.claude/worktrees/w-design');
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
  // criterion (a) 결정론 근거 — hill-climb 디스크립터는 evidence 키를 항상 실어준다(검증 insights 부재 시 null)
  assert.ok('evidence' in r.descriptor, 'hill-climb descriptor carries kernel-verified insights evidence');
  assert.equal(r.descriptor.evidence, null, 'fresh test run has no verified insights — evidence is null');
  // codex r2: evidence는 디스크립터(휘발)만이 아니라 checker request.md에 durable 기록되어야 한다
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  const req = readFileSync(ep.request_path, 'utf8');
  assert.match(req, /## Evidence \(kernel-verified insights\)/);
  assert.match(req, /```json\nnull\n```/);
});

test('P2: non-hill-climb checker request has no evidence section (undefined omits it)', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.ok(!('evidence' in r.descriptor), 'non-hill-climb descriptor has no evidence key');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.doesNotMatch(readFileSync(ep.request_path, 'utf8'), /## Evidence/);
});

test('P2: project-root-only contract copy does NOT satisfy the worktree-local gate', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  mkdirSync(join(root, '.deep-review', 'contracts'), { recursive: true });
  copyFileSync(TRACKED_CONTRACT, join(root, '.deep-review', 'contracts', 'HILLCLIMB-001.yaml'));
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
});

// 내용 검증(codex r1) — `status: active` 문자열만 있는 stale/변조 사본은 tracked 소스와 byte-identical이
// 아니므로 거부된다 (빈 criteria 사본이면 deep-review가 계약 검증을 skip — 무계약 APPROVE 재개방 경로).
test('P2: tampered materialized contract (status active but altered) fails closed', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  const dir = join(root, '.claude/worktrees/w-design', '.deep-review', 'contracts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'HILLCLIMB-001.yaml'), 'slice: HILLCLIMB-001\nstatus: active\ncriteria: []\n');
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
});

// 계약-소비 가능 reviewer 강제(codex r1) — subagent/codex-cross/standalone은 HILLCLIMB-001.yaml을 읽지
// 않으므로 계약 파일이 있어도 무계약 APPROVE가 된다. --contract 플래그 부재도 동일(첫 시리즈 재-init #2 실측).
test('P2: hill-climb run with a non-contract-capable reviewer fails closed (no episode)', () => {
  const { root, runId, f } = seedRun({ reviewer: 'subagent-checker', flags: [], recipe: 'harness-hill-climb', detected: { codex: false } });
  const ws = doneMakerOn(root, runId, f);
  materializeContract(root, '.claude/worktrees/w-design');
  const before = episodeCount(root, runId);
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { codex: false }, fence: f }),
    /REVIEW_CONTRACT_UNENFORCEABLE/);
  assert.equal(episodeCount(root, runId), before, 'no checker episode for a contract-incapable reviewer');
});

test('P2: hill-climb run without the --contract flag fails closed', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  materializeContract(root, '.claude/worktrees/w-design');
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
    /REVIEW_CONTRACT_UNENFORCEABLE/);
});

// ── P2 codex r3: 계약 identity가 checker에 durable 기록되고, record 시점에 재검증된다(TOCTOU 봉합) ──
test('P2: dispatch pins contract identity on the checker (anchored loop.json)', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  materializeContract(root, '.claude/worktrees/w-design');
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(ep.contract.slice, 'HILLCLIMB-001');
  assert.equal(ep.contract.path, '.claude/worktrees/w-design/.deep-review/contracts/HILLCLIMB-001.yaml');
  assert.match(ep.contract.sha256, /^[0-9a-f]{64}$/);
  assert.ok('evidence' in ep, 'evidence is anchored in loop.json, not only in the editable request.md');
});

test('P2: contract removed between dispatch and record — passing verdict fails closed, checker stays pending', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  materializeContract(root, '.claude/worktrees/w-design');
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const report = join('.claude/worktrees/w-design', 'review-report.md');
  writeFileSync(join(root, report), '# review report\nAPPROVE');
  rmSync(join(root, '.claude/worktrees/w-design', '.deep-review', 'contracts', 'HILLCLIMB-001.yaml'));
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'design', verdict: 'APPROVE', proof: { report }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId).status, 'pending');
});

test('P2: contract altered between dispatch and record — sha mismatch fails closed; intact contract passes', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  materializeContract(root, '.claude/worktrees/w-design');
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const report = join('.claude/worktrees/w-design', 'review-report.md');
  writeFileSync(join(root, report), '# review report\nAPPROVE');
  const cPath = join(root, '.claude/worktrees/w-design', '.deep-review', 'contracts', 'HILLCLIMB-001.yaml');
  writeFileSync(cPath, readFileSync(cPath, 'utf8').replace('status: active', 'status: archived'));
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'design', verdict: 'APPROVE', proof: { report }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
  // 복원(그대로 복사) 후에는 통과 — pending checker에 재기록 가능
  copyFileSync(TRACKED_CONTRACT, cPath);
  const out = recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'design', verdict: 'APPROVE', proof: { report }, fence: f });
  assert.equal(out.terminal, 'approved');
});

// ── P2 스코프 한정 — hill-climb이 아닌 recipe는 계약 게이트 비대상(무회귀) ──
test('P2: non-hill-climb runs are not gated by contract presence', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
});
