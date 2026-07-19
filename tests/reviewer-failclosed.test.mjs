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
import { readState, writeState } from '../scripts/lib/state.mjs';
import { finishProofState } from '../scripts/lib/finish.mjs';
import { newWorkstream } from './helpers/workstream-request.mjs';
import { newEpisode, recordEpisode } from './helpers/episode-request.mjs';
import { blockIndependentReview, claimIndependentReview, resolveReviewer,
  dispatchReview, recordReviewOutcome } from './helpers/review-request.mjs';
import { appendAnchored, directMutationOptions } from '../scripts/lib/integrity.mjs';
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TRACKED_CONTRACT = join(here, '..', 'skills', 'deep-loop-workflow', 'references', 'contracts', 'HILLCLIMB-001.yaml');

function fence(runId) { return { owner: runId, generation: 1, intent: 'business' }; }

function seedRun({ reviewer, flags = [], recipe, detected = { 'deep-review': true, codex: true } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-fc-'));
  const review = reviewer
    ? { points: ['design', 'plan', 'implementation'], reviewer, mode: 'cross-model', flags, converge: true, max_review_rounds: 5, require_human_ack: true }
    : undefined;
  const { runId } = initRun(root, { runtime: 'claude', goal: recipe === 'harness-hill-climb' ? '하네스 개선' : 'g', recipe, review, detected, now: new Date('2026-07-10T00:00:00Z') });
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

// ── P1 codex r4: 명시적 무효값(빈 문자열·null)은 기본값 재작성 없이 거부 — `|| 'subagent-checker'`가
//    무효값을 유효화한 뒤 codex-cross로 승격되는 침묵 강등 잔여 경로 ──
test('P1: explicitly empty or null reviewer is rejected, not defaulted', () => {
  // resolveReviewer는 loop에 대한 순수 함수 — 명시적 무효값은 synthetic loop로 직접 검사한다
  // (seedRun은 falsy reviewer를 기본 review로 대체해 이 경로를 재현할 수 없다).
  for (const bad of ['', null, 42]) {
    assert.throws(() => resolveReviewer({ review: { reviewer: bad } }, { codex: true }), /REVIEWER_UNRECOGNIZED/, JSON.stringify(bad));
  }
  // 필드/review 부재는 기본값 유지(무회귀)
  assert.equal(resolveReviewer({ review: {} }, { codex: false }).reviewer, 'subagent-checker');
  assert.equal(resolveReviewer({}, { codex: false }).reviewer, 'subagent-checker');
});

// ── P1 보존 — runtime-neutral subagent identity와 정상 경로는 유지 ──
test('P1: subagent-checker remains runtime-neutral and normal paths are preserved', () => {
  const { root, runId } = seedRun({ reviewer: 'subagent-checker' });
  const data = readState(root, runId).data;
  assert.equal(resolveReviewer(data, { codex: true }).reviewer, 'subagent-checker');
  assert.equal(resolveReviewer(data, { codex: false }).reviewer, 'subagent-checker');
  assert.throws(() => resolveReviewer({ review: { reviewer: 'codex-cross' } }, { codex: true }), /REVIEWER_UNRECOGNIZED/);
  const dr = seedRun({ reviewer: 'deep-review-loop' });
  assert.equal(resolveReviewer(readState(dr.root, dr.runId).data, { 'deep-review': true }).reviewer, 'deep-review-loop');
});

// ── P2 tracked 계약 소스 — repo에 존재 + 소비자(deep-review contract-schema) 형태 (codex r4) ──
test('P2: tracked HILLCLIMB-001 contract exists with consumer-schema shape', () => {
  assert.ok(existsSync(TRACKED_CONTRACT), 'tracked contract yaml must exist in references/contracts/');
  const y = readFileSync(TRACKED_CONTRACT, 'utf8');
  assert.match(y, /^slice:\s*HILLCLIMB-001/m);
  assert.match(y, /^status:\s*active/m);
  assert.match(y, /^criteria:/m);
  // deep-review contract-schema.md 파리티 — criteria는 스칼라 문자열이 아니라 id/description/verification
  // 매핑이어야 소비자(deep-review Evaluator)가 평가 가능하다(codex r4). 6개 criterion 전부.
  for (const cid of ['A', 'B', 'C', 'D', 'E', 'F']) assert.match(y, new RegExp(`^  - id: ${cid}$`, 'm'), `criterion ${cid}`);
  assert.equal((y.match(/^\s+verification: auto$/gm) || []).length, 6, 'every criterion declares verification');
  assert.equal((y.match(/^\s+description: /gm) || []).length, 6, 'every criterion has a description');
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
  // Evidence is durable in the checker episode's anchored inline request.
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  const req = ep.request_markdown;
  assert.match(req, /## Evidence \(kernel-verified insights\)/);
  assert.match(req, /```json\nnull\n```/);
});

test('P2: non-hill-climb inline checker request omits evidence', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.ok(!('evidence' in r.descriptor), 'non-hill-climb descriptor has no evidence key');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.doesNotMatch(ep.request_markdown, /## Evidence/);
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

// codex r5/r6/r7: deep-review 파서는 `--contract SLICE-[0-9]+`(공백 형태)만 selector로 소비한다 —
// 명시 selector(타-slice는 우회, HILLCLIMB-001은 파싱 불가로 bare 취급+토큰 오염), `=` 형태(아예
// 미소비 → 무-contract), 중복(뒤 selector가 이김)은 전부 거부. 허용: 정확히 1회의 bare `--contract`.
test('P2: contract flag must be exactly one bare --contract — any selector, = form, or duplicate fails closed', () => {
  const bad = [
    ['--contract', 'SLICE-999', '--codex-only'],
    ['--contract=SLICE-999', '--codex-only'],
    ['--contract=HILLCLIMB-001'],                                   // = 형태는 downstream이 소비하지 않음
    ['--contract', 'HILLCLIMB-001', '--codex-only'],                // downstream이 selector로 파싱 못 함 (r7)
    ['--contract=HILLCLIMB-001', '--contract', 'SLICE-999'],        // 중복 — 뒤 selector가 이김
    ['--contract', '--contract'],                                    // 중복 bare
  ];
  for (const flags of bad) {
    const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags, recipe: 'harness-hill-climb' });
    const ws = doneMakerOn(root, runId, f);
    materializeContract(root, '.claude/worktrees/w-design');
    assert.throws(
      () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
      /REVIEW_CONTRACT_UNENFORCEABLE/, flags.join(' '));
  }
  for (const flags of [['--contract', '--codex-only'], ['--contract']]) {
    const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags, recipe: 'harness-hill-climb' });
    const ws = doneMakerOn(root, runId, f);
    materializeContract(root, '.claude/worktrees/w-design');
    const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
    assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop', flags.join(' '));
  }
});

// codex r7: bare --contract는 모든 active 계약을 로드 — contracts 디렉터리에 다른 계약 yaml이 있으면
// HILLCLIMB-001 단독 평가가 보장되지 않는다. dispatch·record 양쪽 fail-closed.
test('P2: a second contract yaml in the contracts dir fails closed at dispatch and at record', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  materializeContract(root, '.claude/worktrees/w-design');
  const dir = join(root, '.claude/worktrees/w-design', '.deep-review', 'contracts');
  writeFileSync(join(dir, 'SLICE-001.yaml'), 'slice: SLICE-001\nstatus: active\ncriteria: []\n');
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
  // dispatch 후 record 전에 추가된 경우 — record가 막는다
  rmSync(join(dir, 'SLICE-001.yaml'));
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  writeFileSync(join(dir, 'SLICE-001.yaml'), 'slice: SLICE-001\nstatus: active\ncriteria: []\n');
  const report = join('.claude/worktrees/w-design', 'review-report.md');
  writeFileSync(join(root, report), '# review report\nAPPROVE');
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
});

// codex r7: legacy approved(unpinned) maker는 재리뷰 재적격 — 새 계약-pinned checker가 최신이 되면
// finish의 hillclimb-contract-unpinned가 해소된다(사면초가 마이그레이션 경로).
test('P2: legacy unpinned-approved maker is re-review eligible and finish unblocks after pinned approval', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  const makerId = readState(root, runId).data.episodes.find(e => e.role === 'maker').id;
  const { id: legacyId } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'design-review', point: 'design', workstream: ws, targetMaker: makerId, fence: f });
  appendAnchored(root, runId,
    { type: 'state-patch', data: { field: 'test-legacy-approved' } }, d => {
      d.episodes.find(e => e.id === legacyId).status = 'approved';
    }, undefined, directMutationOptions('test-legacy-approved-checker',
      { owner: runId, generation: 1 },
      { checker_id: legacyId, status: 'approved' },
      'LEASE_FENCED: reviewer-fixture'));
  assert.ok(finishProofState(readState(root, runId).data).missing.includes('hillclimb-contract-unpinned'));
  materializeContract(root, '.claude/worktrees/w-design');
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  const report = join('.claude/worktrees/w-design', 'review-report.md');
  writeFileSync(join(root, report), '# review report\nAPPROVE');
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report }, fence: f });
  assert.ok(!finishProofState(readState(root, runId).data).missing.includes('hillclimb-contract-unpinned'));
});

// codex r6: `.deep-review`가 worktree 밖을 가리키는 symlink면 lexical resolve는 외부 사본을 valid로
// 수용한다 — realpath containment(root+worktree)로 거부되어야 한다.
test('P2: contract behind a symlink escaping the worktree fails closed', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  const outside = mkdtempSync(join(tmpdir(), 'dl-outside-'));
  mkdirSync(join(outside, 'contracts'), { recursive: true });
  copyFileSync(TRACKED_CONTRACT, join(outside, 'contracts', 'HILLCLIMB-001.yaml'));
  mkdirSync(join(root, '.claude/worktrees/w-design'), { recursive: true });
  createDirectoryJunction(outside, join(root, '.claude/worktrees/w-design', '.deep-review'));
  assert.throws(
    () => dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
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
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report }, fence: f }),
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
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
  // 복원(그대로 복사) 후에는 통과 — pending checker에 재기록 가능
  copyFileSync(TRACKED_CONTRACT, cPath);
  const out = recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', proof: { report }, fence: f });
  assert.equal(out.terminal, 'approved');
});

// ── P2 codex r4: hill-climb passing verdict 게이트는 recipe 기준 — pre-patch dispatch로 만들어진
//    legacy pending checker(contract 필드 없음)의 무계약 APPROVE도 거부된다 ──
test('P2: legacy hill-climb checker without pinned contract cannot record a passing verdict', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  // pre-patch dispatchReview 동형 — contract 미기록 checker를 직접 생성(legacy 재현)
  const makerId = readState(root, runId).data.episodes.find(e => e.role === 'maker').id;
  const { id: checkerId } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'design-review', point: 'design', workstream: ws, targetMaker: makerId, fence: f });
  materializeContract(root, '.claude/worktrees/w-design');   // 파일이 있어도 checker에 pin이 없으면 거부
  const report = join('.claude/worktrees/w-design', 'review-report.md');
  writeFileSync(join(root, report), '# review report\nAPPROVE');
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'APPROVE', proof: { report }, fence: f }),
    /REVIEW_CONTRACT_MISSING/);
  // REQUEST_CHANGES는 경량 reject 경로 유지 — legacy checker도 정상 reject 가능
  const out = recordReviewOutcome(root, runId, { episodeId: checkerId, verdict: 'REQUEST_CHANGES', proof: {}, fence: f });
  assert.equal(out.terminal, 'rejected');
});

// ── P2 codex r6: legacy approved checker(contract 미pin)는 record 게이트를 재통과하지 않으므로
//    finish proof에서 막는다 — 마이그레이션은 abandon + 새 커널 re-dispatch ──
test('P2: legacy approved checker without pinned contract blocks hill-climb finish proof', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop', flags: ['--contract', '--codex-only'], recipe: 'harness-hill-climb' });
  const ws = doneMakerOn(root, runId, f);
  const makerId = readState(root, runId).data.episodes.find(e => e.role === 'maker').id;
  const { id: checkerId } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'design-review', point: 'design', workstream: ws, targetMaker: makerId, fence: f });
  const legacy = structuredClone(readState(root, runId).data);
  legacy.episodes.find(e => e.id === checkerId).status = 'approved';
  assert.ok(finishProofState(legacy).missing.includes('hillclimb-contract-unpinned'));
  // 대조: 같은 상태에서 contract가 pin되어 있으면 이 마커는 사라진다
  legacy.episodes.find(e => e.id === checkerId).contract = { slice: 'HILLCLIMB-001', path: '.claude/worktrees/w-design/.deep-review/contracts/HILLCLIMB-001.yaml', sha256: 'a'.repeat(64) };
  assert.ok(!finishProofState(legacy).missing.includes('hillclimb-contract-unpinned'));
});

// ── P2 스코프 한정 — hill-climb이 아닌 recipe는 계약 게이트 비대상(무회귀) ──
test('P2: non-hill-climb runs are not gated by contract presence', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
});

import { test as test7f } from 'node:test';
import assert7f from 'node:assert/strict';
import { createHash as hashDispatch7f } from 'node:crypto';
import { mkdirSync as mkdir7f, mkdtempSync as temp7f,
  readFileSync as readDispatch7f, readdirSync as readdirDispatch7f,
  realpathSync as realpath7f,
  rmSync as removeDispatch7f, symlinkSync as symlink7f,
  writeFileSync as write7f } from 'node:fs';
import { tmpdir as tmp7f } from 'node:os';
import { dirname as dirname7f, join as join7f } from 'node:path';
import { initRun as init7f } from '../scripts/lib/initrun.mjs';
import { newWorkstream as workstream7f } from '../scripts/lib/workspace.mjs';
import { newBlockedCheckerEpisode as productionBlockedEpisode7f,
  newEpisode as productionEpisode7f, recordEpisode as record7f }
  from '../scripts/lib/episode.mjs';
import { dispatchReview as dispatch7f } from './helpers/review-request.mjs';
import { emitInsights as emitDispatchInsights7f,
  latestInsights as latestDispatchInsights7f } from '../scripts/lib/insights.mjs';
import { finishRun as finishDispatchInsights7f } from '../scripts/lib/finish.mjs';
import { readLines as lines7f, readVerifiedState as verifiedDispatch7f }
  from '../scripts/lib/integrity.mjs';
import { readState as stateDispatch7f, runDir as runDirDispatch7f }
  from '../scripts/lib/state.mjs';
import { durableRunBytes as bytes7f, rawHashValidState as raw7f }
  from './fixtures/verified-app-run.mjs';

let episodeTaskSequence7f = 0;
const episode7f = (root, runId, input = {}) => {
  episodeTaskSequence7f += 1;
  return productionEpisode7f(root, runId, {
    ...input,
    task: input.task ?? `Execute reviewer fixture episode ${episodeTaskSequence7f}.`,
  });
};

function corruptDispatchFixture7f({ corrupt = true, hillClimb = true } = {}) {
  const root = realpath7f(temp7f(join7f(tmp7f(), 'dl-review-dispatch-proof-')));
  const observed = '2026-07-13T00:00:00.000Z';
  const { runId } = init7f(root, {
    runtime: 'codex', goal: '하네스 개선',
    recipe: hillClimb ? 'harness-hill-climb' : 'triage-and-discovery',
    review: { points: ['design'], reviewer: 'deep-review-loop', mode: 'cross-model',
      flags: hillClimb ? ['--contract'] : [], converge: true, max_review_rounds: 5,
      require_human_ack: false },
    detected: { 'deep-review': true, codex: true }, now: new Date(observed),
    cwdFn: () => root,
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context', observed_at: observed },
    appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: observed, revoked_at: null },
  });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/design';
  mkdir7f(join7f(root, worktree), { recursive: true });
  const ws = workstream7f(root, runId,
    { title: 'design', branch: 'design', worktree,
      requestId: 'review-dispatch-workstream', fence }).id;
  const artifact = `${worktree}/design.md`;
  write7f(join7f(root, artifact), '# design');
  const maker = episode7f(root, runId, { plugin: 'deep-work', role: 'maker',
    kind: 'design', point: 'design', workstream: ws,
    expectedArtifacts: [artifact], fence,
    requestId: 'review-dispatch-authority-maker' }).id;
  record7f(root, runId, maker, { status: 'done', artifacts: [artifact], fence });
  if (corrupt) {
    raw7f(root, runId, loop => {
      loop.session_chain.sessions[0].host_surface.observed_at =
        '2026-07-13T00:00:01.000Z';
    });
  }
  return { root, runId, ws, maker, fence };
}

test7f('versioned episode request is anchored inline and creates no request sidecar', () => {
  const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const run = runDirDispatch7f(fixture.root, fixture.runId);
  const beforeNames = readdirDispatch7f(run).sort();
  const result = episode7f(fixture.root, fixture.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'fix', point: 'design',
    workstream: fixture.ws, fence: fixture.fence,
    task: 'Repair the reviewed design and write the bounded proof artifact.',
    contract: { schema: 'episode-task-v1', verdict: 'maker-proof-required' },
    requestId: 'episode-inline-request',
  });
  const state = verifiedDispatch7f(fixture.root, fixture.runId).data;
  const episode = state.episodes.find(item => item.id === result.id);
  const event = lines7f(fixture.root, fixture.runId)
    .find(item => item.type === 'episode-new' && item.data.episode_id === result.id);
  assert7f.equal(episode.request_path, undefined);
  assert7f.equal(result.requestMarkdown, episode.request_markdown);
  assert7f.equal(result.requestMarkdownDigest, episode.request_markdown_digest);
  assert7f.equal(event.data.request_markdown, result.requestMarkdown);
  assert7f.equal(event.data.request_markdown_digest, result.requestMarkdownDigest);
  assert7f.match(result.requestMarkdown,
    /Repair the reviewed design and write the bounded proof artifact\./);
  assert7f.match(result.requestMarkdown, /"schema": "episode-task-v1"/);
  assert7f.equal(episode.task,
    'Repair the reviewed design and write the bounded proof artifact.');
  assert7f.deepEqual(event.data.contract,
    { schema: 'episode-task-v1', verdict: 'maker-proof-required' });
  assert7f.deepEqual(readdirDispatch7f(run).sort(), beforeNames,
    'the anchored state/event commit creates no request pathname');
});

test7f('episode exact retry returns the same inline request without another write', () => {
  const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const input = { plugin: 'deep-work', role: 'maker', kind: 'fix', point: 'design',
    workstream: fixture.ws, fence: fixture.fence,
    task: 'Apply the exact inline-request retry contract.',
    contract: { schema: 'episode-task-v1' },
    requestId: 'episode-inline-retry' };
  const first = episode7f(fixture.root, fixture.runId, input);
  const committed = bytes7f(fixture.root, fixture.runId);
  const second = episode7f(fixture.root, fixture.runId, input);
  assert7f.deepEqual(second, first);
  assert7f.deepEqual(bytes7f(fixture.root, fixture.runId), committed);
  assert7f.equal(lines7f(fixture.root, fixture.runId).filter(event =>
    event.type === 'episode-new' && event.data.episode_id === first.id).length, 1);
});

test7f('episode task is mandatory bounded UTF-8 before mutation', () => {
  const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const before = bytes7f(fixture.root, fixture.runId);
  for (const task of [undefined, '', 'x'.repeat(16 * 1024 + 1),
    'carriage\rreturn', '\uD800']) {
    assert7f.throws(() => productionEpisode7f(fixture.root, fixture.runId, {
      plugin: 'deep-work', role: 'maker', kind: 'fix', point: 'design',
      workstream: fixture.ws, fence: fixture.fence, task,
      requestId: `invalid-task-${String(task).length}`,
    }), /EPISODE_TASK_INVALID/);
    assert7f.deepEqual(bytes7f(fixture.root, fixture.runId), before);
  }
});

function materializeHillContract7f(fixture) {
  const destination = join7f(fixture.root, '.claude', 'worktrees', 'design',
    '.deep-review', 'contracts', 'HILLCLIMB-001.yaml');
  mkdir7f(dirname7f(destination), { recursive: true });
  write7f(destination, readDispatch7f(new URL(
    '../skills/deep-loop-workflow/references/contracts/HILLCLIMB-001.yaml',
    import.meta.url)));
  return destination;
}

test7f('review dispatch proves authority before descriptor and contract source actions', () => {
  const fixture = corruptDispatchFixture7f();
  const before = bytes7f(fixture.root, fixture.runId);
  for (const [owner, expected] of [
    ['01JAPPWR0NG000000000000000', /LEASE_FENCED/],
    [fixture.runId, /RUN_SNAPSHOT_INVALID/],
  ]) {
    assert7f.throws(() => dispatch7f(fixture.root, fixture.runId, {
      point: 'design', workstreamId: fixture.ws,
      detected: { 'deep-review': true, codex: true },
      requestId: 'authority-proof-dispatch',
      fence: { ...fixture.fence, owner },
    }), expected);
  }
  assert7f.deepEqual(bytes7f(fixture.root, fixture.runId), before);
});

test7f('review dispatch exact retry after marker cleanup reuses one checker', () => {
  const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const input = { point: 'design', workstreamId: fixture.ws,
    detected: { 'deep-review': true, codex: true },
    requestId: 'dispatch-design-round-1', fence: fixture.fence };
  const first = dispatch7f(fixture.root, fixture.runId, input);
  const firstEpisode = stateDispatch7f(fixture.root, fixture.runId).data.episodes
    .find(episode => episode.id === first.checkerEpisodeId);
  const requestMarkdown = firstEpisode.request_markdown;
  const requestMarkdownDigest = firstEpisode.request_markdown_digest;
  assert7f.equal(first.request_markdown, requestMarkdown);
  assert7f.equal(first.request_markdown_digest, requestMarkdownDigest);
  const committed = bytes7f(fixture.root, fixture.runId);
  const second = dispatch7f(fixture.root, fixture.runId, input);
  assert7f.deepEqual(second, first);
  const replayedEpisode = stateDispatch7f(fixture.root, fixture.runId).data.episodes
    .find(episode => episode.id === first.checkerEpisodeId);
  assert7f.equal(replayedEpisode.request_markdown, requestMarkdown);
  assert7f.equal(replayedEpisode.request_markdown_digest, requestMarkdownDigest);
  assert7f.deepEqual(bytes7f(fixture.root, fixture.runId), committed,
    'post-cleanup exact dispatch retry must be byte-identical');
  const state = stateDispatch7f(fixture.root, fixture.runId).data;
  assert7f.equal(state.episodes.filter(episode => episode.role === 'checker'
    && episode.target_maker === fixture.maker).length, 1);
  assert7f.equal(lines7f(fixture.root, fixture.runId).filter(event =>
    event.type === 'episode-new' && event.data?.role === 'checker').length, 1);
  assert7f.equal(dispatch7f(fixture.root, fixture.runId, input).checkerEpisodeId,
    first.checkerEpisodeId);
  assert7f.match(requestMarkdown, /Independently review maker episode/);
  assert7f.match(requestMarkdown, /## Contract\n\n```json/);
});

test7f('hill-climb same-ID replay bypasses mutable contract and evidence derivation', () => {
  const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: true });
  const contract = materializeHillContract7f(fixture);
  const input = { point: 'design', workstreamId: fixture.ws,
    detected: { 'deep-review': true, codex: true },
    requestId: 'hill-mutable-replay', fence: fixture.fence };
  const first = dispatch7f(fixture.root, fixture.runId, input);
  const committed = bytes7f(fixture.root, fixture.runId);
  const { runId: insightsRun } = init7f(fixture.root, {
    runtime: 'claude', goal: 'mutable replay evidence',
    now: new Date('2026-07-13T00:01:00.000Z'),
  });
  const insightsFence = { owner: insightsRun, generation: 1, runtime: 'claude' };
  emitDispatchInsights7f(fixture.root, insightsRun, {
    fence: insightsFence, now: Date.parse('2026-07-13T00:01:01.000Z'),
    rnd: () => 0.25, sleepFn: () => {},
  });
  finishDispatchInsights7f(fixture.root, insightsRun, {
    status: 'stopped', confirm: true,
    proof: { human_reason: 'materialize changed latest insights' },
    fence: insightsFence, now: Date.parse('2026-07-13T00:01:02.000Z'),
  });
  assert7f.notEqual(latestDispatchInsights7f(fixture.root), null);
  removeDispatch7f(contract);
  const replayed = dispatch7f(fixture.root, fixture.runId, {
    ...input,
    beforeMutableReviewInputs: () => assert7f.fail(
      'same-ID replay must precede contract/latest-insights derivation'),
  });
  assert7f.deepEqual(replayed, first);
  assert7f.deepEqual(bytes7f(fixture.root, fixture.runId), committed);
});

test7f('paired state and event request Markdown tampering is rejected semantically', () => {
  const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const input = { point: 'design', workstreamId: fixture.ws,
    detected: { 'deep-review': true, codex: true },
    requestId: 'inline-request-tamper', fence: fixture.fence };
  const first = dispatch7f(fixture.root, fixture.runId, input);
  rewriteEpisodeCreationEvent7f(fixture, data => {
    data.request_markdown = '# forged request';
    data.request_markdown_digest = hashDispatch7f('sha256').update('forged').digest('hex');
  });
  raw7f(fixture.root, fixture.runId, loop => {
    const checker = loop.episodes.find(episode => episode.id === first.checkerEpisodeId);
    checker.request_markdown = '# forged request';
    checker.request_markdown_digest = hashDispatch7f('sha256').update('forged').digest('hex');
  });
  assert7f.throws(() => verifiedDispatch7f(fixture.root, fixture.runId),
    /episode creation/);
});

test7f('paired state and event task or contract tampering is rejected semantically', () => {
  for (const field of ['task', 'contract']) {
    const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
    const first = dispatch7f(fixture.root, fixture.runId, {
      point: 'design', workstreamId: fixture.ws,
      detected: { 'deep-review': true, codex: true },
      requestId: `inline-${field}-tamper`, fence: fixture.fence,
    });
    const forged = field === 'task' ? 'Forged checker task.' : { forged: true };
    rewriteEpisodeCreationEvent7f(fixture, data => { data[field] = forged; });
    raw7f(fixture.root, fixture.runId, loop => {
      loop.episodes.find(episode => episode.id === first.checkerEpisodeId)[field] = forged;
    });
    assert7f.throws(() => verifiedDispatch7f(fixture.root, fixture.runId),
      /episode creation/, field);
  }
});

function rewriteEpisodeCreationEvent7f(fixture, mutate, episodeId = null) {
  const path = join7f(runDirDispatch7f(fixture.root, fixture.runId),
    'event-log.jsonl');
  const events = readDispatch7f(path, 'utf8').trim().split('\n').map(JSON.parse);
  mutate(events.find(event => event.type === 'episode-new'
    && (episodeId === null ? event.data?.role === 'checker'
      : event.data?.episode_id === episodeId)).data);
  let previous = 'GENESIS';
  for (const event of events) {
    event.checksum = hashDispatch7f('sha256').update(
      `${event.seq}|${event.ts}|${event.type}|${JSON.stringify(event.data)}|${previous}`)
      .digest('hex');
    previous = event.checksum;
  }
  write7f(path, `${events.map(JSON.stringify).join('\n')}\n`);
  raw7f(fixture.root, fixture.runId, loop => {
    const last = events.at(-1);
    loop.event_log_head = { seq: last.seq, checksum: last.checksum };
  });
}

test7f('episode creation preserves role and artifact path guards before mutation', () => {
  const direct = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const base = { plugin: 'deep-work', role: 'maker', kind: 'input-validation',
    point: 'design', task: 'Exercise direct episode input validation.',
    workstream: direct.ws, expectedArtifacts: [], fence: direct.fence };
  const before = bytes7f(direct.root, direct.runId);
  assert7f.throws(() => productionEpisode7f(direct.root, direct.runId, {
    ...base, role: 'typo', requestId: 'direct-invalid-role',
  }), /EPISODE_INPUT_INVALID: role/);
  assert7f.deepEqual(bytes7f(direct.root, direct.runId), before,
    'an invalid role is rejected before durable mutation');
  assert7f.throws(() => productionEpisode7f(direct.root, direct.runId, {
    ...base, reviewerResolution: { source: 'forged' },
    requestId: 'direct-maker-reviewer-resolution',
  }), /EPISODE_INPUT_INVALID: reviewerResolution/);
  assert7f.deepEqual(bytes7f(direct.root, direct.runId), before,
    'checker-only reviewer resolution is rejected before durable mutation');
  assert7f.throws(() => productionEpisode7f(direct.root, direct.runId, {
    ...base, role: 'checker', targetMaker: { forged: true },
    requestId: 'direct-invalid-target-maker',
  }), /EPISODE_INPUT_INVALID: targetMaker/);
  assert7f.deepEqual(bytes7f(direct.root, direct.runId), before,
    'a malformed target maker is rejected before durable mutation');
  assert7f.throws(() => productionBlockedEpisode7f(direct.root, direct.runId, {
    plugin: 'deep-review', kind: 'input-validation', point: 'design',
    task: 'Exercise blocked checker input validation.', workstream: direct.ws,
    targetMaker: '001-deep-work', reason: undefined, fence: direct.fence,
    requestId: 'direct-blocked-reason',
  }), /EPISODE_INPUT_INVALID: blockReason/);
  assert7f.deepEqual(bytes7f(direct.root, direct.runId), before,
    'a blocked checker without a reason is rejected before durable mutation');
  for (const [requestId, artifact] of [
    ['direct-parent-artifact', '../proof.md'],
    ['direct-absolute-artifact', join7f(direct.root, 'proof.md')],
  ]) {
    assert7f.throws(() => productionEpisode7f(direct.root, direct.runId, {
      ...base, expectedArtifacts: [artifact], requestId,
    }), /EPISODE_ARTIFACT_UNSAFE/);
    assert7f.deepEqual(bytes7f(direct.root, direct.runId), before, artifact);
  }
});

test7f('episode creation identity is state-event correlated and status-independent', () => {
  const direct = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const repeatedInput = { plugin: 'deep-work', role: 'maker', kind: 'repeat',
    point: 'design', task: 'Exercise direct episode creation identity.',
    workstream: direct.ws, fence: direct.fence };
  const repeatedA = episode7f(direct.root, direct.runId,
    { ...repeatedInput, requestId: 'direct-repeat-a' });
  const repeatedB = episode7f(direct.root, direct.runId,
    { ...repeatedInput, requestId: 'direct-repeat-b' });
  assert7f.notEqual(repeatedA.id, repeatedB.id,
    'two intentional direct creations with equal content and different IDs remain distinct');
  const repeatedRetry = episode7f(direct.root, direct.runId,
    { ...repeatedInput, requestId: 'direct-repeat-a' });
  assert7f.equal(repeatedRetry.id, repeatedA.id,
    'an exact direct retry with the same request ID reuses its episode');
  assert7f.throws(() => episode7f(direct.root, direct.runId, {
    ...repeatedInput, kind: 'changed', requestId: 'direct-repeat-a',
  }), /EPISODE_REQUEST_CONFLICT/);
  assert7f.throws(() => episode7f(direct.root, direct.runId, repeatedInput),
    /EPISODE_REQUEST_ID_REQUIRED/);

  const malformedCaller = 'g'.repeat(64);
  rewriteEpisodeCreationEvent7f(direct, data => {
    data.creation_request_id_digest = malformedCaller;
    data.request_projection.creation_request_id_digest = malformedCaller;
  }, repeatedB.id);
  raw7f(direct.root, direct.runId, loop => {
    loop.episodes.find(episode => episode.id === repeatedB.id)
      .creation_request_id_digest = malformedCaller;
  });
  assert7f.throws(() => verifiedDispatch7f(direct.root, direct.runId),
    /ambiguous creation identity/);

  const malformedDispatch = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const malformedReview = dispatch7f(malformedDispatch.root, malformedDispatch.runId, {
    point: 'design', workstreamId: malformedDispatch.ws,
    detected: { 'deep-review': true, codex: true },
    requestId: 'malformed-dispatch-identity', fence: malformedDispatch.fence,
  });
  const uppercaseDigest = 'A'.repeat(64);
  rewriteEpisodeCreationEvent7f(malformedDispatch, data => {
    data.dispatch_request_id_digest = uppercaseDigest;
    data.request_projection.dispatch_request_id_digest = uppercaseDigest;
  }, malformedReview.checkerEpisodeId);
  raw7f(malformedDispatch.root, malformedDispatch.runId, loop => {
    loop.episodes.find(episode => episode.id === malformedReview.checkerEpisodeId)
      .dispatch_request_id_digest = uppercaseDigest;
  });
  assert7f.throws(() => verifiedDispatch7f(malformedDispatch.root, malformedDispatch.runId),
    /ambiguous creation identity/);

  const duplicateIdentity = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const duplicateInput = { plugin: 'deep-work', role: 'maker', kind: 'duplicate',
    point: 'design', workstream: duplicateIdentity.ws, fence: duplicateIdentity.fence };
  const identityA = episode7f(duplicateIdentity.root, duplicateIdentity.runId,
    { ...duplicateInput, requestId: 'duplicate-identity-a' });
  const identityB = episode7f(duplicateIdentity.root, duplicateIdentity.runId,
    { ...duplicateInput, requestId: 'duplicate-identity-b' });
  const duplicateDigest = stateDispatch7f(duplicateIdentity.root, duplicateIdentity.runId).data
    .episodes.find(episode => episode.id === identityA.id).creation_request_id_digest;
  rewriteEpisodeCreationEvent7f(duplicateIdentity, data => {
    data.creation_request_id_digest = duplicateDigest;
    data.request_projection.creation_request_id_digest = duplicateDigest;
  }, identityB.id);
  raw7f(duplicateIdentity.root, duplicateIdentity.runId, loop => {
    loop.episodes.find(episode => episode.id === identityB.id)
      .creation_request_id_digest = duplicateDigest;
  });
  assert7f.throws(() => verifiedDispatch7f(duplicateIdentity.root, duplicateIdentity.runId),
    /duplicate episode creation request identity/);

  const stateOnly = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const input = { point: 'design', workstreamId: stateOnly.ws,
    detected: { 'deep-review': true, codex: true },
    requestId: 'state-correlation-dispatch', fence: stateOnly.fence };
  const first = dispatch7f(stateOnly.root, stateOnly.runId, input);
  raw7f(stateOnly.root, stateOnly.runId, loop => {
    loop.episodes.find(episode => episode.id === first.checkerEpisodeId)
      .creation_request_digest = '0'.repeat(64);
  });
  assert7f.throws(() => verifiedDispatch7f(stateOnly.root, stateOnly.runId),
    /episode creation/);

  const semanticOnly = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const semantic = dispatch7f(semanticOnly.root, semanticOnly.runId, {
    ...input, workstreamId: semanticOnly.ws, fence: semanticOnly.fence,
    requestId: 'semantic-correlation-dispatch',
  });
  raw7f(semanticOnly.root, semanticOnly.runId, loop => {
    const checker = loop.episodes.find(episode => episode.id === semantic.checkerEpisodeId);
    checker.target_maker = '999-forged-maker';
    checker.expected_artifacts = ['forged-output.md'];
  });
  assert7f.throws(() => verifiedDispatch7f(semanticOnly.root, semanticOnly.runId),
    /episode creation/,
    'copied creation digest cannot authenticate mutated immutable semantic fields');

  const eventOnly = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  dispatch7f(eventOnly.root, eventOnly.runId, { ...input,
    workstreamId: eventOnly.ws, fence: eventOnly.fence });
  rewriteEpisodeCreationEvent7f(eventOnly,
    data => { data.request_digest = '1'.repeat(64); });
  assert7f.throws(() => verifiedDispatch7f(eventOnly.root, eventOnly.runId),
    /episode creation/);

  const downgraded = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const downgradedResult = dispatch7f(downgraded.root, downgraded.runId, {
    ...input, workstreamId: downgraded.ws, fence: downgraded.fence,
    requestId: 'discriminator-downgrade-dispatch',
  });
  raw7f(downgraded.root, downgraded.runId, loop => {
    delete loop.episodes.find(episode =>
      episode.id === downgradedResult.checkerEpisodeId).creation_contract;
  });
  rewriteEpisodeCreationEvent7f(downgraded,
    data => { delete data.creation_contract; });
  assert7f.throws(() => verifiedDispatch7f(downgraded.root, downgraded.runId),
    /episode creation/,
    'paired state/event discriminator removal cannot downgrade initialized proof');

  const injected = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const injectedResult = dispatch7f(injected.root, injected.runId, {
    ...input, workstreamId: injected.ws, fence: injected.fence,
    requestId: 'unversioned-injection-dispatch',
  });
  raw7f(injected.root, injected.runId, loop => {
    const forged = structuredClone(loop.episodes.find(episode =>
      episode.id === injectedResult.checkerEpisodeId));
    forged.id = '999-forged-unversioned';
    delete forged.creation_contract;
    loop.episodes.push(forged);
  });
  assert7f.throws(() => verifiedDispatch7f(injected.root, injected.runId),
    /episode creation/,
    'an initialized run rejects an unversioned episode with no creation event');

  for (const status of ['pending', 'in_progress', 'approved', 'rejected', 'blocked']) {
    const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
    const retryInput = { point: 'design', workstreamId: fixture.ws,
      detected: { 'deep-review': true, codex: true },
      requestId: `status-retry-${status}`, fence: fixture.fence };
    const created = dispatch7f(fixture.root, fixture.runId, retryInput);
    if (status === 'in_progress' || status === 'blocked') {
      const claim = claimIndependentReview(fixture.root, fixture.runId, {
        episodeId: created.checkerEpisodeId, fence: fixture.fence,
        attemptIdFactory: () => `status-attempt-${status}`,
      });
      if (status === 'blocked') {
        blockIndependentReview(fixture.root, fixture.runId, {
          episodeId: created.checkerEpisodeId, attemptId: claim.attemptId,
          reason: 'status-replay-blocked', fence: fixture.fence,
        });
      }
    } else if (status === 'approved') {
      const report = '.claude/worktrees/design/status-review.md';
      write7f(join7f(fixture.root, report), '# approved\n');
      recordReviewOutcome(fixture.root, fixture.runId, {
        episodeId: created.checkerEpisodeId, verdict: 'APPROVE',
        proof: { report }, fence: fixture.fence,
      });
    } else if (status === 'rejected') {
      recordReviewOutcome(fixture.root, fixture.runId, {
        episodeId: created.checkerEpisodeId, verdict: 'REQUEST_CHANGES',
        fence: fixture.fence,
      });
    }
    assert7f.equal(dispatch7f(fixture.root, fixture.runId, retryInput).checkerEpisodeId,
      created.checkerEpisodeId, status);
  }
});

test7f('review dispatch separates retry identity, later rounds, and final-lock checker CAS', () => {
  const fixture = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const common = { point: 'design', workstreamId: fixture.ws,
    detected: { 'deep-review': true, codex: true }, fence: fixture.fence };
  const first = dispatch7f(fixture.root, fixture.runId,
    { ...common, requestId: 'logical-review-round-1' });
  recordReviewOutcome(fixture.root, fixture.runId, {
    episodeId: first.checkerEpisodeId, verdict: 'REQUEST_CHANGES',
    fence: fixture.fence,
  });
  const artifact = '.claude/worktrees/design/fix.md';
  write7f(join7f(fixture.root, artifact), '# fixed design');
  const fixMaker = episode7f(fixture.root, fixture.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'fix', point: 'design',
    workstream: fixture.ws, expectedArtifacts: [artifact], fence: fixture.fence,
    requestId: 'logical-review-fix-maker',
  });
  record7f(fixture.root, fixture.runId, fixMaker.id,
    { status: 'done', artifacts: [artifact], fence: fixture.fence });
  assert7f.equal(dispatch7f(fixture.root, fixture.runId,
    { ...common, requestId: 'logical-review-round-1' }).checkerEpisodeId,
  first.checkerEpisodeId, 'response-loss retry remains bound to its original maker');
  const second = dispatch7f(fixture.root, fixture.runId,
    { ...common, requestId: 'logical-review-round-2' });
  assert7f.notEqual(second.checkerEpisodeId, first.checkerEpisodeId);
  assert7f.equal(stateDispatch7f(fixture.root, fixture.runId).data.episodes
    .find(episode => episode.id === second.checkerEpisodeId).target_maker, fixMaker.id);
  const detectorDriftReplay = dispatch7f(fixture.root, fixture.runId, {
    ...common, detected: { codex: true }, requestId: 'logical-review-round-2',
  });
  assert7f.equal(detectorDriftReplay.checkerEpisodeId, second.checkerEpisodeId);
  assert7f.deepEqual(detectorDriftReplay.descriptor, second.descriptor,
    'fresh detector drift cannot alter a durable same-ID response');

  const raced = corruptDispatchFixture7f({ corrupt: false, hillClimb: false });
  const racedCommon = { point: 'design', workstreamId: raced.ws,
    detected: { 'deep-review': true, codex: true }, fence: raced.fence };
  assert7f.throws(() => dispatch7f(raced.root, raced.runId, {
    ...racedCommon, requestId: 'cas-loser', beforeFinalLock: () => {
      dispatch7f(raced.root, raced.runId, { ...racedCommon, requestId: 'cas-winner' });
    },
  }), /REVIEW_NO_ELIGIBLE_MAKER/);
  const checkers = stateDispatch7f(raced.root, raced.runId).data.episodes
    .filter(episode => episode.role === 'checker' && episode.target_maker === raced.maker);
  assert7f.equal(checkers.length, 1);
});
