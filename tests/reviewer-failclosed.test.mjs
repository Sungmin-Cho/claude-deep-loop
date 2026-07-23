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
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { finishProofState } from '../scripts/lib/finish.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { resolveReviewer, dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
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
  // codex r2: evidence는 디스크립터(휘발)만이 아니라 checker request.md에 durable 기록되어야 한다
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(Object.hasOwn(ep, 'request_path'), false);
  const req = readFileSync(join(runDir(root, runId), ...ep.request_rel.split('/')), 'utf8');
  assert.match(req, /## Evidence \(kernel-verified insights\)/);
  assert.match(req, /```json\nnull\n```/);
});

test('P2: non-hill-climb checker request has no evidence section (undefined omits it)', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.ok(!('evidence' in r.descriptor), 'non-hill-climb descriptor has no evidence key');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(Object.hasOwn(ep, 'request_path'), false);
  assert.doesNotMatch(readFileSync(join(runDir(root, runId), ...ep.request_rel.split('/')), 'utf8'), /## Evidence/);
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
  const d = readState(root, runId).data;
  d.episodes.find(e => e.id === legacyId).status = 'approved';   // pre-patch 커널 잔재 재현 (contract 미pin)
  writeState(root, runId, d);
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
  // pre-patch 커널이 남긴 approved 상태 재현 (fixture 전용 raw 전이 — 정상 경로로는 record 게이트가 막음)
  const d = readState(root, runId).data;
  d.episodes.find(e => e.id === checkerId).status = 'approved';
  writeState(root, runId, d);
  assert.ok(finishProofState(readState(root, runId).data).missing.includes('hillclimb-contract-unpinned'));
  // 대조: 같은 상태에서 contract가 pin되어 있으면 이 마커는 사라진다
  const d2 = readState(root, runId).data;
  d2.episodes.find(e => e.id === checkerId).contract = { slice: 'HILLCLIMB-001', path: '.claude/worktrees/w-design/.deep-review/contracts/HILLCLIMB-001.yaml', sha256: 'a'.repeat(64) };
  writeState(root, runId, d2);
  assert.ok(!finishProofState(readState(root, runId).data).missing.includes('hillclimb-contract-unpinned'));
});

// ── P2 스코프 한정 — hill-climb이 아닌 recipe는 계약 게이트 비대상(무회귀) ──
test('P2: non-hill-climb runs are not gated by contract presence', () => {
  const { root, runId, f } = seedRun({ reviewer: 'deep-review-loop' });
  const ws = doneMakerOn(root, runId, f);
  const r = dispatchReview(root, runId, { point: 'design', workstreamId: ws, detected: { 'deep-review': true }, fence: f });
  assert.equal(r.descriptor.skill, 'deep-review:deep-review-loop');
});
