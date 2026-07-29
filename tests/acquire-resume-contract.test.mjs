// acquire↔resume public 계약 (spec docs/superpowers/specs/2026-07-27-acquire-resume-contract.md r10).
// boundary 수준 계약 테스트 — T1 · T2b · T3 · T4 · T7 · T8 · T9 · T11.
// (T2a는 lib 수준이라 tests/lease.test.mjs에 있다. T6은 Phase 3의 R1 수정 — 아래 마지막 절.)
// 모든 시간은 고정 NOW 주입 — CLAUDE.md Determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import {
  captureReconciledRunSnapshot, pauseRun, readState, readStateForRootRecovery, runDir, writeState,
} from '../scripts/lib/state.mjs';
import { appendAnchored, readLines } from '../scripts/lib/integrity.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease, releaseLease } from '../scripts/lib/lease.mjs';
import { acquireRecovery, recoverBoundary, supersedeAffinity } from '../scripts/lib/recover.mjs';
import { acquireRootRecovery, recoverRelocatedRoot } from '../scripts/lib/project-root-recovery.mjs';
import { projectRootDigest } from '../scripts/lib/project-root.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO_ROOT, 'scripts', 'deep-loop.mjs');
const T0 = '2026-07-27T00:00:00.000Z';
const T1 = '2026-07-27T00:10:00.000Z';
const T2 = '2026-07-27T00:20:00.000Z';
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'acquire-resume-conformance.json');

function fence(runId, generation = 1) {
  return { owner: runId, generation, intent: 'business' };
}

function runCli(root, runId, args, owner = runId, generation = 1) {
  return spawnSync(process.execPath, [
    CLI, ...args,
    '--owner', owner, '--generation', String(generation),
    '--run-id', runId, '--project-root', root,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
}

// `lease acquire` 는 `--owner`/`--generation` 을 **인자**로 받는다(fence 플래그가 아니다). runCli 처럼
// 뒤에 다시 붙이면 parseFlags 의 마지막 값이 이겨 인자가 조용히 덮어써진다 — 그래서 전용 러너를 쓴다.
function runAcquireCli(root, runId, args) {
  return spawnSync(process.execPath, [
    CLI, ...args, '--run-id', runId, '--project-root', root,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function runReadCli(root, runId, args) {
  return spawnSync(process.execPath, [
    CLI, ...args, '--run-id', runId, '--project-root', root,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
}

// reconciliation 이후에 기준선을 잡는다 — spec §3.6.2/§7-T8 ②.
// whole-tree durableBytes는 쓰지 않는다(§7-T3 ①의 r5 범위 정정).
function anchoredBytes(root, runId) {
  captureReconciledRunSnapshot(root, runId);
  const dir = runDir(root, runId);
  const events = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json'), 'utf8'),
    hash: readFileSync(join(dir, '.loop.hash'), 'utf8'),
    events: existsSync(events) ? readFileSync(events, 'utf8') : null,
  };
}

function leaseAcquiredEvents(root, runId) {
  return readLines(root, runId).filter(event => event.type === 'lease-acquired');
}

function seedReviewed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-acquire-resume-'));
  const review = {
    points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
    flags: [], converge: true, max_review_rounds: 5, require_human_ack: false,
  };
  const { runId } = initRun(root, {
    runtime, goal: 'acquire-resume contract', review, now: new Date(T0),
  });
  const f = fence(runId);
  // recovery 경로의 safety 판정은 lock 안에서 실제 clock 을 샘플한다(CLI 는 clock 을 주입할 수 없다).
  // 고정 NOW 로 seed 한 run 은 실시각 기준으로 항상 오래됐으므로 wallclock 여유를 준다 —
  // recovery-affinity.test.mjs 의 armRealWallclock/extendBudget 선례와 같은 이유다.
  const seeded = readState(root, runId).data;
  seeded.budget.max_wallclock_sec = 10 * 365 * 24 * 60 * 60;
  writeState(root, runId, seeded);
  const worktree = '.claude/worktrees/closure';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, {
    title: 'closure', branch: 'feature/closure', worktree, fence: f,
  }).id;
  const artifact = `${worktree}/impl.txt`;
  writeFileSync(join(root, artifact), 'impl\n');
  const maker = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifact], fence: f,
  }).id;
  recordEpisode(root, runId, maker, { status: 'in_progress', fence: f });
  recordEpisode(root, runId, maker, {
    status: 'done', artifacts: [artifact], proof: {}, fence: f,
  });
  const checker = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected: {}, fence: f,
  }).checkerEpisodeId;
  const report = `${worktree}/impl-review.md`;
  writeFileSync(join(root, report), '# review\nAPPROVE\n');
  recordReviewOutcome(root, runId, {
    episodeId: checker, verdict: 'APPROVE', proof: { report }, fence: f,
  });
  return { root, runId, f, ws, worktree };
}

// boundary handoff 예약까지 — spec §7 서두의 검증된 선례(seedReviewed → closeWithSibling → emitHandoff).
// `platform` 은 launcher surface 강등을 호스트와 무관하게 주입하기 위한 것이다(T6 Windows 회귀).
function seedEmittedBoundary(runtime = 'claude', platform = process.platform) {
  const f = seedReviewed(runtime);
  newWorkstream(f.root, f.runId, {
    title: 'sibling', branch: 'feature/sibling', worktree: '.claude/worktrees/sibling', fence: f.f,
  });
  const closed = runCli(f.root, f.runId, [
    'workstream', 'terminal', '--id', f.ws, '--status', 'ready', '--proof', '{}', '--now', T1,
  ]);
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  const boundary = readState(f.root, f.runId).data.session_chain.sessions
    .find(session => session.run_id === f.runId).scope.terminal_event;
  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: boundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(T1),
    expect: { owner: f.runId, generation: 1 },
    env: {}, platform,
  });
  assert.equal(emitted.ok, true);
  return { ...f, boundary, child: emitted.childRunId, platform };
}

// 예약 없는 released lease — §3.5 normal 행 (lease.test.mjs:347-372 선례와 같은 형태).
function seedReleased(runtime = 'claude') {
  const f = seedReviewed(runtime);
  assert.deepEqual(releaseLease(f.root, f.runId, { owner: f.runId, generation: 1 }), {
    ok: true, reason: 'released',
  });
  return f;
}

function lease(root, runId) {
  return readState(root, runId).data.session_chain.lease;
}

// ─────────────────────────────────────────────────────────────────────────────
// T1 — (a) + B-2 부정: resume-command acquired 브랜치
// ─────────────────────────────────────────────────────────────────────────────

test('T1 resume-command echoes the consumed reservation after acquire without re-emitting an executable invocation', () => {
  const f = seedEmittedBoundary();
  const acquired = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(acquired.proceed, true);

  const shown = runReadCli(f.root, f.runId, ['resume-command']);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.doesNotMatch(shown.stdout, /no pending handoff/);
  assert.match(shown.stdout, new RegExp(`Handoff: consumed child_run_id=${f.child}`));
  assert.match(shown.stdout, /Consumed: takeover_kind=boundary-handoff/);
  assert.match(shown.stdout, /Status: consumed/);
  assert.match(shown.stdout, new RegExp(`Lease: owner=${f.child}[^\\n]*handoff_phase=acquired`));
  // 비실행 마커 — DOC-8: 실행 가능한 resume invocation을 재출력하지 않는다.
  assert.doesNotMatch(shown.stdout, /deep-loop-resume/);
  // 라운드 7 C2: `Status:` 줄은 Handoff/Recovery 헤드와 **공유**되므로 replay 절을 무조건 달 수 없다.
  // nonce 없이 소비한 이 케이스는 영수증에 attempt_id 가 없어 replay 가 원리적으로 불가능하다.
  assert.equal(lease(f.root, f.runId).acquisition_receipt.attempt_id, null);
  assert.doesNotMatch(shown.stdout, /같은 attempt_id 재호출은 replay/);
});

test('T1 the Status line advertises replay only when the receipt actually carries an attempt id', () => {
  // 라운드 7 C2: 이전 판은 모든 소비에 "같은 attempt_id는 replay" 를 달았는데, 영수증에 attempt_id 가
  // 없는 상태 — recovery 소비 전부와 nonce 없는 lease acquire 소비 — 에 대해 거짓이었다. replay 조건 5
  // (`R.attempt_id === 요청값`)가 성립할 수 없기 때문이다. 절을 영수증에서 파생시켰고 여기서 고정한다.
  const withNonce = seedEmittedBoundary();
  assert.equal(acquireLease(withNonce.root, withNonce.runId, {
    owner: withNonce.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  }).proceed, true);
  assert.equal(lease(withNonce.root, withNonce.runId).acquisition_receipt.attempt_id, A1);
  const shownWithNonce = runReadCli(withNonce.root, withNonce.runId, ['resume-command']);
  assert.match(shownWithNonce.stdout, /Status: consumed/);
  assert.match(shownWithNonce.stdout, /같은 attempt_id 재호출은 replay/);

  // recovery 소비는 `--attempt-id` 를 받을 수 없으므로(§3.6.4) 그 절이 붙으면 거짓이 된다.
  const recovery = seedAffinityReservation();
  assert.equal(acquireRecovery(recovery.root, recovery.runId, {
    capsuleRel: recovery.recovery.recovery_rel,
    owner: recovery.recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    clock: () => Date.parse(T2),
  }).proceed, true);
  assert.equal(lease(recovery.root, recovery.runId).acquisition_receipt.attempt_id, null);
  const shownRecovery = runReadCli(recovery.root, recovery.runId, ['resume-command']);
  assert.match(shownRecovery.stdout, /Recovery: consumed/);
  assert.match(shownRecovery.stdout, /Status: consumed/);
  assert.doesNotMatch(shownRecovery.stdout, /같은 attempt_id 재호출은 replay/);

  // 라운드 8 W2: 절은 replay 가 **실제로 도달 가능**할 때만 붙어야 한다. 사람이 개시한 preserve-pause 는
  // lease 를 건드리지 않아 acquired 분기가 계속 발화하지만 replay 조건 2(`status === 'running'`)가
  // 막는다 — 그 상태에서 절이 남으면 커널 stdout 과 README 가 서로 모순된다.
  pauseRun(withNonce.root, withNonce.runId, {
    reason: 'human-hold', mode: 'preserve',
    expect: { owner: withNonce.child, generation: 2 }, now: Date.parse(T2) + 1_000,
  });
  const shownPaused = runReadCli(withNonce.root, withNonce.runId, ['resume-command']);
  assert.match(shownPaused.stdout, /Status: consumed/);
  assert.doesNotMatch(shownPaused.stdout, /같은 attempt_id 재호출은 replay/);
  // 그리고 실제로 replay 가 막혀 있음을 같은 테스트에서 확인한다.
  const afterPause = acquireLease(withNonce.root, withNonce.runId, {
    owner: withNonce.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2) + 2_000,
  });
  assert.equal(afterPause.proceed, false);
  assert.equal(afterPause.reason, 'already-owned');
});

test('T1 negative: a reservation-less released takeover and a stale-generation receipt never echo consumed', () => {
  const released = seedReleased();
  const fresh = acquireLease(released.root, released.runId, {
    owner: 'FRESHOWNERWITHOUTRESERVATION', expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.proceed, true);
  assert.equal(fresh.consumed, null);
  const afterReleasedTakeover = runReadCli(released.root, released.runId, ['resume-command']);
  assert.equal(afterReleasedTakeover.status, 0, afterReleasedTakeover.stderr);
  assert.doesNotMatch(afterReleasedTakeover.stdout, /consumed/);

  // ② 소비했던 child가 release 후 재인수 — 새 영수증이 released-takeover이므로 미표출.
  const f = seedEmittedBoundary();
  acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.deepEqual(releaseLease(f.root, f.runId, { owner: f.child, generation: 2 }), {
    ok: true, reason: 'released',
  });
  const reacquired = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 2, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(reacquired.proceed, true);
  assert.equal(reacquired.consumed, null);
  const afterReacquire = runReadCli(f.root, f.runId, ['resume-command']);
  assert.doesNotMatch(afterReacquire.stdout, /consumed/);
});

test('T1 negative: a released lease never shows the consumed marker, because the next acquire would proceed', () => {
  // checker W1: releaseLease 는 spread 로 state 만 바꾸고 handoff_phase/generation 을 남기므로,
  // 가드에 `state === 'active'` 가 없으면 이 창에서 `Status: consumed — 새 진입 시도는 proceed:false` 가
  // 출력된다. 그런데 released lease 는 takeable 이라 다음 acquire 는 proceed:true 를 낸다 — §3.4 가
  // consumed 마커에서 승격을 금지하므로 정당한 인수가 교착된다.
  const f = seedEmittedBoundary();
  assert.equal(acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  }).proceed, true);
  assert.match(runReadCli(f.root, f.runId, ['resume-command']).stdout, /Status: consumed/);

  assert.deepEqual(releaseLease(f.root, f.runId, { owner: f.child, generation: 2 }), {
    ok: true, reason: 'released',
  });
  const released = lease(f.root, f.runId);
  assert.equal(released.state, 'released');
  assert.equal(released.handoff_phase, 'acquired');       // 소비 흔적은 남아 있다
  assert.equal(released.acquisition_receipt.to_generation, released.generation);

  const shown = runReadCli(f.root, f.runId, ['resume-command']);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.doesNotMatch(shown.stdout, /Status: consumed/);
  assert.doesNotMatch(shown.stdout, /Consumed:/);

  // 그리고 실제로 진행 가능함을 같은 테스트에서 고정한다 — 마커의 예측과 커널이 어긋나지 않는다.
  const next = acquireLease(f.root, f.runId, {
    owner: 'FRESHTAKEOVERPRINCIPAL', expectGeneration: 2, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(next.proceed, true);
  assert.equal(next.generation, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// T2b — (c)+(d) 정확히 한 번의 소비 · 최대 한 번의 진행 attempt
// ─────────────────────────────────────────────────────────────────────────────

test('T2b exactly one consumption transaction and at most one proceeding attempt', () => {
  const f = seedEmittedBoundary();
  const first = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(first.ok, true);
  assert.equal(first.reason, 'acquired');
  assert.equal(first.proceed, true);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.consumed.boundary_event, f.boundary);
  assert.equal(first.consumed.takeover_kind, 'boundary-handoff');
  assert.equal(first.consumed.child_run_id, f.child);
  assert.equal(first.consumed.superseded_owner_run_id, f.runId);
  assert.equal(first.consumed.from_generation, 1);
  assert.equal(first.consumed.to_generation, 2);

  const second = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'already-owned');
  assert.equal(second.proceed, false);
  assert.equal(second.consumed, null);
  assert.equal(second.replayed, false);

  const third = acquireLease(f.root, f.runId, {
    owner: 'UNRELATEDOWNER0000000000', expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(third.ok, false);
  assert.equal(third.proceed, false);
  assert.equal(third.consumed, null);

  // ① 소비 트랜잭션이 정확히 1회
  assert.equal(leaseAcquiredEvents(f.root, f.runId).length, 1);
  assert.equal(lease(f.root, f.runId).generation, 2);
  assert.equal(lease(f.root, f.runId).acquisition_receipt.to_generation, 2);
  // ② 진행 권한을 얻은 attempt는 최대 1개
  assert.equal([first, second, third].filter(r => r.proceed === true).length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 — (b) 무변이 + M2 잔여 고정
// ─────────────────────────────────────────────────────────────────────────────

test('T3 every non-proceeding acquire leaves the reconciled baseline and the preserve-pause intact', () => {
  const f = seedEmittedBoundary();
  pauseRun(f.root, f.runId, {
    reason: 'host-session-lost', mode: 'preserve',
    expect: { owner: f.runId, generation: 1 }, now: Date.parse(T1) + 1_000,
  });
  const before = anchoredBytes(f.root, f.runId);

  const attempts = [
    { label: 'stale generation', args: { owner: f.child, expectGeneration: 9, runtime: 'claude' } },
    { label: 'unrelated owner', args: { owner: 'UNRELATEDOWNER0000000000', expectGeneration: 1, runtime: 'claude' } },
    { label: 'wrong runtime', args: { owner: f.child, expectGeneration: 1, runtime: 'codex' } },
  ];
  for (const attempt of attempts) {
    const result = acquireLease(f.root, f.runId, { ...attempt.args, now: Date.parse(T2) });
    assert.equal(result.ok, false, attempt.label);
    assert.equal(result.proceed, false, attempt.label);
    assert.equal(result.consumed, null, attempt.label);
    assert.deepEqual(anchoredBytes(f.root, f.runId), before, attempt.label);
    assert.equal(readState(f.root, f.runId).data.status, 'paused', attempt.label);
  }
  assert.equal(leaseAcquiredEvents(f.root, f.runId).length, 0);
});

test('T3 the commit-then-crash window is durably indistinguishable from a committed acquire (M2 residue)', () => {
  const f = seedEmittedBoundary();
  const seen = [];
  assert.throws(() => acquireLease(f.root, f.runId, {
    owner: f.child,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    __testFaultAt: (barrier) => {
      seen.push(barrier);
      if (barrier === 'state:written') throw new Error('SIMULATED_PRINCIPAL_DEATH');
    },
  }), /SIMULATED_PRINCIPAL_DEATH/);
  assert.deepEqual(seen, ['event:appended', 'state:written']);

  // durable 상태는 커밋된 성공과 동일하다 — 고아 창의 존재를 문서화-고정(제거 증명이 아니다).
  const after = lease(f.root, f.runId);
  assert.equal(after.owner_run_id, f.child);
  assert.equal(after.generation, 2);
  assert.equal(after.handoff_phase, 'acquired');
  assert.equal(after.acquisition_receipt.takeover_kind, 'boundary-handoff');
  assert.equal(leaseAcquiredEvents(f.root, f.runId).length, 1);
  assert.equal(readState(f.root, f.runId).data.status, 'running');
});

test('T3 a crash at the event:appended barrier is a fail-stop, not a recoverable half-commit', () => {
  const f = seedEmittedBoundary();
  assert.throws(() => acquireLease(f.root, f.runId, {
    owner: f.child,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    __testFaultAt: (barrier) => {
      if (barrier === 'event:appended') throw new Error('SIMULATED_CRASH_BEFORE_STATE');
    },
  }), /SIMULATED_CRASH_BEFORE_STATE/);
  // 이 시점 상태는 복구 가능한 half-commit이 아니다 — 다음 읽기가 낡은 앵커를 보고 fail-stop한다.
  assert.throws(() => captureReconciledRunSnapshot(f.root, f.runId), /LOG_TAMPERED/);
});

test('T3 the M2 runbook recovers an orphaned consumption through the exact reserved replacement child', () => {
  const f = seedEmittedBoundary();
  acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude',
    attemptId: 'ATTEMPTDEADPRINCIPAL', now: Date.parse(T2),
  });

  // 대체 주체는 다른 attempt이므로 replay 대상이 아니다.
  const replacement = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.child, '--generation', '2', '--runtime', 'claude',
    '--attempt-id', 'ATTEMPTREPLACEMENT01', '--now', T2,
  ]);
  assert.equal(replacement.status, 0, replacement.stderr);
  const replacementJson = JSON.parse(replacement.stdout);
  assert.equal(replacementJson.reason, 'already-owned');
  assert.equal(replacementJson.proceed, false);
  assert.match(runReadCli(f.root, f.runId, ['resume-command']).stdout, /Status: consumed/);

  // 런북 ① fenced preserve-pause
  const paused = runCli(f.root, f.runId, [
    'pause', '--reason', 'orphaned-principal', '--mode', 'preserve', '--now', T2,
  ], f.child, 2);
  assert.equal(paused.status, 0, paused.stderr);
  assert.equal(JSON.parse(paused.stdout).status, 'paused');

  // 런북 ② recover --confirm → 예약된 replacement child id를 캡처
  const recovered = runCli(f.root, f.runId, ['recover', '--confirm', '--now', T2], f.child, 2);
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveredChild = JSON.parse(recovered.stdout).child_run_id;
  assert.equal(typeof recoveredChild, 'string');
  // ⑤ 응답 유실 변형 — 상태에서 예약된 child를 재발견할 수 있다.
  const rediscovered = runReadCli(f.root, f.runId, [
    'state', 'get', '--field', 'session_chain.lease.handoff_child_run_id',
  ]);
  assert.equal(JSON.parse(rediscovered.stdout), recoveredChild);

  // 반례: 임의 owner는 child-not-reserved exit 3
  const wrongOwner = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', 'ARBITRARYOWNER00000000', '--generation', '2', '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(wrongOwner.status, 3, wrongOwner.stdout + wrongOwner.stderr);

  // 런북 ③ 정확한 replacement child로 인수
  const resumed = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', recoveredChild, '--generation', '2', '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const resumedJson = JSON.parse(resumed.stdout);
  assert.equal(resumedJson.proceed, true);
  assert.equal(resumedJson.consumed.takeover_kind, 'boundary-recovery');
  assert.equal(readState(f.root, f.runId).data.status, 'running');
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — exit code 고정 (spread 함정)
// ─────────────────────────────────────────────────────────────────────────────

function seedBoundaryRecoveryReservation() {
  const f = seedEmittedBoundary();
  pauseRun(f.root, f.runId, {
    reason: 'boundary-host-lost', mode: 'preserve',
    expect: { owner: f.runId, generation: 1 }, now: Date.parse(T1) + 2_000,
  });
  const recovery = recoverBoundary(f.root, f.runId, {
    confirm: true,
    expect: { owner: f.runId, generation: 1 },
    now: Date.parse(T1) + 3_000,
    clock: () => Date.parse(T1) + 3_000,
  });
  return { ...f, recovery };
}

test('T7 the contract fields never downgrade the boundary-recovery exit codes', () => {
  const f = seedBoundaryRecoveryReservation();
  const staleGeneration = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.recovery.child_run_id, '--generation', '9', '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(staleGeneration.status, 3, staleGeneration.stdout + staleGeneration.stderr);
  assert.equal(JSON.parse(staleGeneration.stdout).reason, 'generation-mismatch');
  assert.equal(JSON.parse(staleGeneration.stdout).proceed, false);

  const notReserved = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', 'NOTTHERESERVEDCHILD000', '--generation', '1', '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(notReserved.status, 3, notReserved.stdout + notReserved.stderr);
  assert.equal(JSON.parse(notReserved.stdout).reason, 'child-not-reserved');

  // topology 파괴 → recovery-topology-invalid exit 1
  const broken = readState(f.root, f.runId).data;
  broken.session_chain.sessions.find(s => s.run_id === f.recovery.child_run_id).recovery_sha256 = 'f'.repeat(64);
  writeState(f.root, f.runId, broken);
  const topology = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.recovery.child_run_id, '--generation', '1', '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(topology.status, 1, topology.stdout + topology.stderr);
  assert.equal(JSON.parse(topology.stdout).reason, 'recovery-topology-invalid');
});

test('T7 run-terminal and RUNTIME_FENCED stay exit 3 on the normal path', () => {
  const runtimeFenced = seedEmittedBoundary();
  const fenced = runAcquireCli(runtimeFenced.root, runtimeFenced.runId, [
    'lease', 'acquire', '--owner', runtimeFenced.child, '--generation', '1', '--runtime', 'codex', '--now', T2,
  ]);
  assert.equal(fenced.status, 3, fenced.stdout + fenced.stderr);
  const fencedJson = JSON.parse(fenced.stdout);
  assert.equal(fencedJson.reason, 'RUNTIME_FENCED');
  assert.equal(fencedJson.proceed, false);
  assert.equal(fencedJson.consumed, null);

  const terminal = seedEmittedBoundary();
  // 먼저 정상 인수로 예약 publication 을 retire 한다 — 그 전에 raw writeState 를 하면 prepared
  // transaction 의 state/hash 순서가 깨져 reconciliation 이 먼저 실패한다(계약과 무관한 seed 결함).
  assert.equal(acquireLease(terminal.root, terminal.runId, {
    owner: terminal.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  }).proceed, true);
  const state = readState(terminal.root, terminal.runId).data;
  state.status = 'completed';
  writeState(terminal.root, terminal.runId, state);
  // 다른 owner + 현재 generation → generation CAS 를 통과한 뒤 terminal 배리어(lease.mjs 검증 4)에 걸린다.
  const rejected = runAcquireCli(terminal.root, terminal.runId, [
    'lease', 'acquire', '--owner', 'ANOTHERPRINCIPAL00000', '--generation', '2', '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(rejected.status, 3, rejected.stdout + rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).reason, 'run-terminal');
  assert.equal(JSON.parse(rejected.stdout).proceed, false);
});

// spec §7-T8-② 의 필수 대조 케이스용 — reconciliation 이 정리할 **pending publication** 을 남긴다.
// 선례: tests/handoff.test.mjs:1672 (publication + faultAt('prepared:digest-verified') → TRANSACTION_PENDING).
function leavePendingPublication(root, runId, goal) {
  assert.throws(() => appendAnchored(
    root,
    runId,
    { type: 'contract-pending-probe', data: { goal }, now: T2 },
    loop => { loop.goal = goal; },
    undefined,
    {
      publication: {
        kind: 'contract-pending-probe',
        operationId: 'c'.repeat(64),
        artifacts: [],
        topology: { goal },
        faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('barrier'); },
      },
    },
  ), /TRANSACTION_PENDING/);
}

function anchoredShape(root, runId) {
  const lines = readLines(root, runId);
  return {
    events: lines.length,
    types: lines.map(event => event.type).join(','),
    transactionsDir: existsSync(join(runDir(root, runId), 'transactions')),
    goal: readState(root, runId).data.goal,
    // N1(리뷰 라운드 2): §7-T8-② 는 **세** 파일을 말한다. 대조 arm 이 loop.json 과 event-log 만 보고
    // .loop.hash 를 빠뜨리고 있었다 — 앵커가 함께 갱신됐는지도 대조 대상이다.
    hash: readFileSync(join(runDir(root, runId), '.loop.hash'), 'utf8'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T8 — (b) M1: attempt nonce replay
// ─────────────────────────────────────────────────────────────────────────────

const A1 = '01KATTEMPTAAAAAAAAAAAAAAAA';
const A2 = '01KATTEMPTBBBBBBBBBBBBBBBB';

test('T8 the same attempt id replays the proceeding response without any replay-originated write', () => {
  const f = seedEmittedBoundary();
  const first = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  assert.equal(first.proceed, true);
  assert.equal(first.replayed, false);

  // ② 기준선은 reconciliation 이후에 캡처한다.
  const before = anchoredBytes(f.root, f.runId);
  const replay = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  // ① replay 성립
  assert.equal(replay.ok, true);
  assert.equal(replay.reason, 'acquired');
  assert.equal(replay.proceed, true);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.consumed, first.consumed);
  assert.equal(replay.generation, 2);
  // ② 무변이
  assert.deepEqual(anchoredBytes(f.root, f.runId), before);
  assert.equal(leaseAcquiredEvents(f.root, f.runId).length, 1);

  // ③ 다른 nonce 거부
  const otherNonce = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A2, now: Date.parse(T2),
  });
  assert.equal(otherNonce.reason, 'already-owned');
  assert.equal(otherNonce.proceed, false);
  // ④ nonce 미제시 거부 (후방 호환)
  const noNonce = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(noNonce.reason, 'already-owned');
  assert.equal(noNonce.proceed, false);
});

test('T8 with a pending publication the three anchored files change from reconciliation, not from replay', () => {
  // spec §7-T8-② 가 **필수**로 표시한 두 번째 케이스(checker W3). §3.6.2 의 r5 재정의
  // ("reconciliation 완료 후 replay-originated write 없음")가 동어반복이 아니게 만드는 케이스다:
  // pending publication 이 있으면 appendAnchored 는 caller preCheck **이전에** 그것을 정리하며
  // (integrity.mjs:791) 그 정리가 세 파일을 정당하게 쓴다. 그 변화를 "replay 가 상태를 바꿨다"고
  // 읽으면 오진이므로, **read-only 호출도 같은 변화를 만든다**는 대조로 인과를 고정한다.
  const build = (goal) => {
    const f = seedEmittedBoundary();
    const first = acquireLease(f.root, f.runId, {
      owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
    });
    assert.equal(first.proceed, true);
    leavePendingPublication(f.root, f.runId, goal);
    return { ...f, first, before: anchoredShape(f.root, f.runId) };
  };

  // (A) replay 를 호출한다 — 세 파일이 바뀌지만 그 변화는 reconciliation 이 만든 것이다.
  const viaReplay = build('PENDING-VIA-REPLAY');
  assert.equal(viaReplay.before.transactionsDir, true);
  assert.notEqual(viaReplay.before.goal, 'PENDING-VIA-REPLAY');
  const replay = acquireLease(viaReplay.root, viaReplay.runId, {
    owner: viaReplay.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.proceed, true);
  assert.deepEqual(replay.consumed, viaReplay.first.consumed);
  const afterReplay = anchoredShape(viaReplay.root, viaReplay.runId);

  // (B) 같은 상태에서 replay 대신 **read-only** 호출을 한다 — 동일한 변화가 일어난다.
  const viaRead = build('PENDING-VIA-READ');
  assert.equal(viaRead.before.transactionsDir, true);
  captureReconciledRunSnapshot(viaRead.root, viaRead.runId);
  const afterRead = anchoredShape(viaRead.root, viaRead.runId);

  // 인과 고정: 두 경로의 변화가 구조적으로 동일하다(staged 이벤트 1건 append + 상태 반영 + 트랜잭션 retire).
  assert.equal(afterReplay.events, viaReplay.before.events + 1);
  assert.equal(afterRead.events, viaRead.before.events + 1);
  assert.equal(afterReplay.types, `${viaReplay.before.types},contract-pending-probe`);
  assert.equal(afterRead.types, `${viaRead.before.types},contract-pending-probe`);
  assert.equal(afterReplay.goal, 'PENDING-VIA-REPLAY');
  assert.equal(afterRead.goal, 'PENDING-VIA-READ');
  assert.equal(afterReplay.transactionsDir, afterRead.transactionsDir);
  assert.notEqual(afterReplay.hash, viaReplay.before.hash);
  assert.notEqual(afterRead.hash, viaRead.before.hash);
  // replay 는 lease-acquired 를 추가하지 않는다 — 소비는 여전히 정확히 1회다.
  assert.equal(leaseAcquiredEvents(viaReplay.root, viaReplay.runId).length, 1);

  // reconciliation 이 끝난 기준선 이후로는 replay 가 **바이트 단위로** 아무것도 쓰지 않는다.
  const settled = anchoredBytes(viaReplay.root, viaReplay.runId);
  const again = acquireLease(viaReplay.root, viaReplay.runId, {
    owner: viaReplay.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  assert.equal(again.replayed, true);
  assert.deepEqual(anchoredBytes(viaReplay.root, viaReplay.runId), settled);
});

test('T8 replay does not cross a generation boundary', () => {
  const f = seedEmittedBoundary();
  acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  releaseLease(f.root, f.runId, { owner: f.child, generation: 2 });
  const other = acquireLease(f.root, f.runId, {
    owner: 'ANOTHEROWNER0000000000', expectGeneration: 2, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(other.proceed, true);
  const stale = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  assert.equal(stale.proceed, false);
  assert.notEqual(stale.reason, 'acquired');
});

test('T8 replay refuses a generation the receipt did not start from (condition 7)', () => {
  // checker W5: 조건 1~6 이 모두 참인데 7 만 거짓인 경우 — 조건 7 을 지우면 이 테스트만 깨진다.
  // spec §3.6.2 는 조건 7 이 §4-(c)("모든 public 경로가 같은 generation fence 를 통과한다")를 지키기
  // 위해 존재한다고 명시한다. 없으면 replay 가 generation fence 를 우회하는 유일한 경로가 된다.
  const f = seedEmittedBoundary();
  const first = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  assert.equal(first.proceed, true);
  const receipt = lease(f.root, f.runId).acquisition_receipt;
  assert.equal(receipt.from_generation, 1);
  assert.equal(receipt.to_generation, 2);

  // 조건 1(같은 owner active) · 2(running) · 3(nonce 제시) · 4(영수증 존재) · 5(nonce 일치) ·
  // 6(to_generation === lease.generation) 은 모두 참이고, expectGeneration 만 인수 **후** 세대다.
  const wrongStart = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 2, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  assert.equal(wrongStart.ok, true);
  assert.equal(wrongStart.reason, 'already-owned');
  assert.equal(wrongStart.proceed, false);
  assert.equal(wrongStart.replayed, false);
  // 대조: 올바른 출발 세대면 같은 nonce 로 replay 가 성립한다.
  const correctStart = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  assert.equal(correctStart.replayed, true);
  assert.equal(correctStart.proceed, true);
});

test('T8 a released takeover replays with consumed:null, including for an owner without a session entry', () => {
  for (const owner of ['FRESHOWNERNOENTRY00000', null]) {
    const f = seedReleased();
    const takeover = owner || f.runId;
    const first = acquireLease(f.root, f.runId, {
      owner: takeover, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
    });
    assert.equal(first.proceed, true);
    assert.equal(first.consumed, null);
    assert.equal(lease(f.root, f.runId).acquisition_receipt.takeover_kind, 'released-takeover');
    const replay = acquireLease(f.root, f.runId, {
      owner: takeover, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
    });
    assert.equal(replay.reason, 'acquired');
    assert.equal(replay.proceed, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.consumed, null);
  }
});

test('T8 terminal and human preserve-pause both outrank replay', () => {
  const terminal = seedEmittedBoundary();
  acquireLease(terminal.root, terminal.runId, {
    owner: terminal.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  const completed = readState(terminal.root, terminal.runId).data;
  completed.status = 'completed';
  writeState(terminal.root, terminal.runId, completed);
  const afterTerminal = runAcquireCli(terminal.root, terminal.runId, [
    'lease', 'acquire', '--owner', terminal.child, '--generation', '1',
    '--runtime', 'claude', '--attempt-id', A1, '--now', T2,
  ]);
  assert.equal(afterTerminal.status, 3, afterTerminal.stdout + afterTerminal.stderr);
  assert.equal(JSON.parse(afterTerminal.stdout).reason, 'run-terminal');

  // ⑦-b preserve-pause는 lease를 건드리지 않으므로 조건 1로는 걸러지지 않는다.
  const paused = seedEmittedBoundary();
  acquireLease(paused.root, paused.runId, {
    owner: paused.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2),
  });
  pauseRun(paused.root, paused.runId, {
    reason: 'human-hold', mode: 'preserve',
    expect: { owner: paused.child, generation: 2 }, now: Date.parse(T2) + 1_000,
  });
  assert.equal(lease(paused.root, paused.runId).state, 'active');
  const afterPause = acquireLease(paused.root, paused.runId, {
    owner: paused.child, expectGeneration: 1, runtime: 'claude', attemptId: A1, now: Date.parse(T2) + 2_000,
  });
  assert.equal(afterPause.reason, 'already-owned');
  assert.equal(afterPause.proceed, false);
  assert.equal(afterPause.replayed, false);
});

test('T8 malformed attempt ids are invalid values, not fence failures', () => {
  const f = seedEmittedBoundary();
  for (const value of ['', 'short7c', 'x'.repeat(129), 'has space', 'has.dot']) {
    const rejected = runAcquireCli(f.root, f.runId, [
      'lease', 'acquire', '--owner', f.child, '--generation', '1',
      '--runtime', 'claude', '--attempt-id', value, '--now', T2,
    ]);
    assert.equal(rejected.status, 1, `${JSON.stringify(value)}: ${rejected.stdout}${rejected.stderr}`);
  }
  assert.equal(lease(f.root, f.runId).generation, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// T9 — 경로별 계약 커버리지 (5경로)
// ─────────────────────────────────────────────────────────────────────────────

test('T9 normal path: response shape, receipt, duplicate, same-attempt replay, exit', () => {
  const f = seedReleased();
  const acquired = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', 'NORMALPATHOWNER000000', '--generation', '1',
    '--runtime', 'claude', '--attempt-id', A1, '--now', T2,
  ]);
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const json = JSON.parse(acquired.stdout);
  assert.equal(json.reason, 'acquired');
  assert.equal(json.proceed, true);
  assert.equal(json.consumed, null);
  assert.equal(json.replayed, false);
  const receipt = lease(f.root, f.runId).acquisition_receipt;
  assert.equal(receipt.takeover_kind, 'released-takeover');
  assert.equal(receipt.attempt_id, A1);
  assert.equal(receipt.boundary_event, null);
  assert.equal(receipt.reservation_key, null);
  assert.equal(receipt.from_generation, 1);
  assert.equal(receipt.to_generation, 2);

  const duplicate = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', 'NORMALPATHOWNER000000', '--generation', '1',
    '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(duplicate.status, 0);
  assert.equal(JSON.parse(duplicate.stdout).reason, 'already-owned');
  assert.equal(JSON.parse(duplicate.stdout).proceed, false);

  const replay = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', 'NORMALPATHOWNER000000', '--generation', '1',
    '--runtime', 'claude', '--attempt-id', A1, '--now', T2,
  ]);
  assert.equal(replay.status, 0);
  assert.deepEqual(JSON.parse(replay.stdout).replayed, true);
  assert.equal(JSON.parse(replay.stdout).consumed, null);
  assert.doesNotMatch(runReadCli(f.root, f.runId, ['resume-command']).stdout, /consumed/);
});

test('T9 boundary-handoff path: response shape, receipt, duplicate, same-attempt replay, exit', () => {
  const f = seedEmittedBoundary();
  const acquired = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.child, '--generation', '1',
    '--runtime', 'claude', '--attempt-id', A1, '--now', T2,
  ]);
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const json = JSON.parse(acquired.stdout);
  assert.equal(json.proceed, true);
  assert.equal(json.consumed.takeover_kind, 'boundary-handoff');
  assert.deepEqual(json.consumed.boundary_event, f.boundary);
  assert.equal(json.consumed.handoff_rel, `handoffs/${f.child}-next-session.md`);
  const receipt = lease(f.root, f.runId).acquisition_receipt;
  assert.equal(receipt.takeover_kind, 'boundary-handoff');
  assert.equal(typeof receipt.reservation_key, 'string');
  assert.equal(receipt.attempt_id, A1);

  const duplicate = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.child, '--generation', '1', '--runtime', 'claude', '--now', T2,
  ]);
  assert.equal(JSON.parse(duplicate.stdout).reason, 'already-owned');
  const replay = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.child, '--generation', '1',
    '--runtime', 'claude', '--attempt-id', A1, '--now', T2,
  ]);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.equal(JSON.parse(replay.stdout).consumed.takeover_kind, 'boundary-handoff');
  assert.match(runReadCli(f.root, f.runId, ['resume-command']).stdout, /Handoff: consumed/);
});

test('T9 boundary-recovery path: response shape, receipt, duplicate, same-attempt replay, exit', () => {
  const f = seedBoundaryRecoveryReservation();
  const acquired = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.recovery.child_run_id, '--generation', '1',
    '--runtime', 'claude', '--attempt-id', A1, '--now', T2,
  ]);
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  const json = JSON.parse(acquired.stdout);
  assert.equal(json.proceed, true);
  assert.equal(json.consumed.takeover_kind, 'boundary-recovery');
  assert.equal(json.consumed.handoff_rel, null);
  assert.equal(lease(f.root, f.runId).acquisition_receipt.takeover_kind, 'boundary-recovery');

  const replay = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.recovery.child_run_id, '--generation', '1',
    '--runtime', 'claude', '--attempt-id', A1, '--now', T2,
  ]);
  assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.equal(JSON.parse(replay.stdout).consumed.takeover_kind, 'boundary-recovery');
  assert.match(runReadCli(f.root, f.runId, ['resume-command']).stdout, /Recovery: consumed/);
});

function seedAffinityReservation() {
  const f = seedReviewed();
  const artifact = `${f.worktree}/affinity.txt`;
  writeFileSync(join(f.root, artifact), 'affinity\n');
  const maker = newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: f.ws, expectedArtifacts: [artifact], fence: f.f,
  }).id;
  recordEpisode(f.root, f.runId, maker, { status: 'in_progress', fence: f.f });
  pauseRun(f.root, f.runId, {
    reason: 'host-session-lost', mode: 'preserve',
    expect: { owner: f.runId, generation: 1 }, now: Date.parse(T1),
  });
  const recovery = supersedeAffinity(f.root, f.runId, {
    reason: 'lost host affinity',
    confirm: true,
    expect: { owner: f.runId, generation: 1 },
    now: Date.parse(T1) + 1_000,
    clock: () => Date.parse(T1) + 1_000,
  });
  return { ...f, recovery };
}

test('T9 affinity recovery path: response shape, receipt, duplicate fence-throw, exit', () => {
  const f = seedAffinityReservation();
  const acquired = acquireRecovery(f.root, f.runId, {
    capsuleRel: f.recovery.recovery_rel,
    owner: f.recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    clock: () => Date.parse(T2),
  });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.reason, 'acquired');
  assert.equal(acquired.proceed, true);
  assert.equal(acquired.replayed, false);
  assert.equal(acquired.consumed.takeover_kind, 'affinity-supersession');
  assert.equal(acquired.consumed.handoff_rel, null);
  const receipt = lease(f.root, f.runId).acquisition_receipt;
  assert.equal(receipt.takeover_kind, 'affinity-supersession');
  assert.equal(receipt.attempt_id, null);
  assert.match(runReadCli(f.root, f.runId, ['resume-command']).stdout, /Recovery: consumed/);

  // duplicate는 멱등이 아니라 fence-throw (§3.5)
  assert.throws(() => acquireRecovery(f.root, f.runId, {
    capsuleRel: f.recovery.recovery_rel,
    owner: f.recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
  }), /LEASE_FENCED: generation-mismatch/);
});

// 이전된 project root 위의 affinity 예약 — project-root.test.mjs의 open-affinity 토폴로지와 같은 형태.
function seedRelocatedRootReservation(runtime = 'claude') {
  const parent = mkdtempSync(join(tmpdir(), 'dl-acquire-resume-root-'));
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = initRun(originalRoot, { runtime, goal: 'relocated root', now: new Date(T0) });
  const f = fence(runId);
  const ws = newWorkstream(originalRoot, runId, {
    title: 'relocated affinity',
    branch: 'feature/relocated-affinity',
    worktree: '.worktrees/relocated-affinity',
    fence: f,
  }).id;
  const { data } = readState(originalRoot, runId);
  data.budget.max_wallclock_sec = 10 * 365 * 24 * 60 * 60;
  data.workstreams.find(item => item.id === ws).status = 'in_progress';
  data.active_workstreams = [ws];
  data.session_chain.sessions[0].scope.workstream_id = ws;
  data.session_chain.sessions[0].scope.bound_at_seq = 1;
  writeState(originalRoot, runId, data);
  const storedRoot = data.project.root;
  renameSync(originalRoot, candidateRoot);
  const current = readStateForRootRecovery(candidateRoot, runId).data;
  const recovered = recoverRelocatedRoot(candidateRoot, runId, {
    actor: 'human',
    confirm: true,
    expectedStoredRootDigest: projectRootDigest(storedRoot),
    expectedBindingGeneration: current.project.binding_generation,
    fence: {
      owner: current.session_chain.lease.owner_run_id,
      generation: current.session_chain.lease.generation,
    },
    now: Date.parse(T1),
  });
  return { root: candidateRoot, runId, recovered };
}

test('T9 root recovery path: reason acquired, proceed true, receipt without an event', () => {
  const f = seedRelocatedRootReservation();
  const before = readStateForRootRecovery(f.root, f.runId).data;
  const child = before.session_chain.sessions.find(
    session => session.run_id === f.recovered.replacement_session_id,
  );
  const eventsBefore = readLines(f.root, f.runId).length;
  const acquired = acquireRootRecovery(f.root, f.runId, {
    capsuleRel: child.recovery_rel,
    owner: child.run_id,
    expectGeneration: before.session_chain.lease.generation,
    bindingGeneration: before.project.binding_generation,
    runtime: 'claude',
    now: Date.parse(T2),
    clock: () => Date.parse(T2),
  });
  assert.equal(acquired.ok, true);
  assert.equal(acquired.reason, 'acquired');
  assert.equal(acquired.proceed, true);
  assert.equal(acquired.replayed, false);
  assert.equal(acquired.consumed.takeover_kind, 'project-root');
  assert.equal(acquired.consumed.handoff_rel, null);
  assert.equal(readLines(f.root, f.runId).length, eventsBefore, 'root recovery records no event');
  const receipt = lease(f.root, f.runId).acquisition_receipt;
  assert.equal(receipt.takeover_kind, 'project-root');
  assert.equal(receipt.attempt_id, null);
  assert.equal(typeof receipt.reservation_key, 'string');

  // duplicate는 예약이 소비로 지워졌으므로 fence-throw (§3.5)
  assert.throws(() => acquireRootRecovery(f.root, f.runId, {
    capsuleRel: child.recovery_rel,
    owner: child.run_id,
    expectGeneration: before.session_chain.lease.generation,
    bindingGeneration: before.project.binding_generation,
    runtime: 'claude',
    now: Date.parse(T2),
    clock: () => Date.parse(T2),
    // 실측(checker I1 확증): 소비로 예약이 지워지면 `exactReceipt`(project-root-recovery.mjs:907)가
    // reservation fence(:917)보다 **먼저** 발화하므로 신원은 항상 이것이다. spec §3.5 의 duplicate 셀은
    // `LEASE_FENCED: …` 와 **exit 3** 을 적었지만 실제는 이 신원이고 CLI 매핑(deep-loop.mjs:328)에 걸리지
    // 않아 **exit 1** 이다 — Phase 6 이 §3.5 매트릭스를 README 에 옮길 때 이 두 칸을 정정해야 한다.
    // 일어날 수 없는 대안을 허용하지 않도록 관측된 신원 하나로 조인다.
  }), /ROOT_OPERATION_PROOF_INVALID/);
  assert.equal(lease(f.root, f.runId).acquisition_receipt.to_generation, before.session_chain.lease.generation + 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// T11 — preCheck guard 계약
// ─────────────────────────────────────────────────────────────────────────────

test('T11 the boundary-recovery capsule is validated inside the lock through the preCheck guard', () => {
  const f = seedBoundaryRecoveryReservation();
  const capsule = join(runDir(f.root, f.runId), f.recovery.recovery_rel);
  // capsule 은 예약 publication 의 digest 대상이므로 **lock 밖** 변조는 reconciliation 이 먼저 잡는다
  // (recovery-affinity.test.mjs:731 선례와 같은 두 신원). 그것만으로는 preCheck 의 lock-안 읽기가
  // 검증되지 않으므로, 아래에서 seam 으로 lock 안·reconciliation 뒤·preCheck 앞에 변조를 주입한다.
  const seamTampered = acquireLease(f.root, f.runId, {
    owner: f.recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    __testPreCheckSeam: () => {
      writeFileSync(capsule, `${readFileSync(capsule, 'utf8')}\n`);
    },
  });
  assert.equal(seamTampered.ok, false);
  assert.equal(seamTampered.reason, 'recovery-capsule-invalid');
  assert.equal(seamTampered.proceed, false);
  assert.equal(seamTampered.consumed, null);
  // sentinel 복원이 non-enumerable kernel_exit_code 를 재구성했는지 — spread 함정(§3.2 노트 2).
  assert.equal(seamTampered.kernel_exit_code, 1);
  assert.equal(lease(f.root, f.runId).generation, 1);
  assert.equal(lease(f.root, f.runId).takeover_kind, 'boundary-recovery');

  // lock 밖 변조도 fail-closed 다 — 어느 신원이든 acquire 는 성공하지 않는다.
  const outside = runAcquireCli(f.root, f.runId, [
    'lease', 'acquire', '--owner', f.recovery.child_run_id, '--generation', '1',
    '--runtime', 'claude', '--now', T2,
  ]);
  assert.notEqual(outside.status, 0);
  assert.equal(lease(f.root, f.runId).generation, 1);
});

test('T11 the affinity capsule is validated inside the lock through the preCheck guard', () => {
  const f = seedAffinityReservation();
  const capsule = join(runDir(f.root, f.runId), f.recovery.recovery_rel);
  writeFileSync(capsule, `${readFileSync(capsule, 'utf8')}\n`);
  assert.throws(() => acquireRecovery(f.root, f.runId, {
    capsuleRel: f.recovery.recovery_rel,
    owner: f.recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    // recovery-affinity.test.mjs:731 선례와 동일한 두 신원 — 변조 위치에 따라 reconciliation 이 먼저 잡는다.
  }), /RECOVERY_CAPSULE_INVALID|TRANSACTION_RECONCILIATION_REQUIRED/);
  assert.equal(lease(f.root, f.runId).generation, 1);
});

test('T11 the affinity in-lock read detects a capsule tampered after reconciliation', () => {
  // checker W2: 위 테스트는 lock **밖** 변조라 reconciliation 이 먼저 발화하고
  // `recoveryArtifactBytesLocked` 에 도달하지 못한다 — fail-closed 만 증명한다. §3.2 노트 6 과 §7-T11-③ 은
  // 두 recovery 경로 **각각**에 tamper 테스트를 요구하므로, boundary-recovery 와 같은 방식으로
  // lock 안·reconciliation 뒤·preCheck 앞 seam 에 변조를 주입해 lock-안 읽기 자체를 고정한다.
  const f = seedAffinityReservation();
  const capsule = join(runDir(f.root, f.runId), f.recovery.recovery_rel);
  assert.throws(() => acquireRecovery(f.root, f.runId, {
    capsuleRel: f.recovery.recovery_rel,
    owner: f.recovery.child_run_id,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    __testPreCheckSeam: () => {
      writeFileSync(capsule, `${readFileSync(capsule, 'utf8')}\n`);
    },
  }), /RECOVERY_CAPSULE_INVALID/);
  assert.equal(lease(f.root, f.runId).generation, 1);
  assert.equal(lease(f.root, f.runId).takeover_kind, 'affinity-supersession');
});

test('T11 preCheck consumes the in-lock loop the seam mutated, not the pre-lock snapshot', () => {
  // checker W4: 이전 판은 seam 안에서 durable `writeState` 를 했는데 그것은 preCheck 에 보이지 않는다 —
  // appendAnchored 는 `structuredClone(before.data)` 를 seam 과 preCheck 에 **같은 객체로** 넘기고
  // (integrity.mjs:811/827/830) 자기 writeState 로 덮어쓴다. 따라서 오라클은 durable write 가 아니라
  // **그 in-lock 객체의 변형이 preCheck 에 관측되는가**다. seam 이 예약된 child 를 바꿔치면 preCheck 의
  // 예약 검증이 발화해야 한다 — pre-lock 스냅샷을 봤다면 그대로 acquire 에 성공한다. 실측 배리어는
  // exact-child fence(검증 7)가 아니라 **boundary topology 전량 검증(검증 6)** 이다: bogus child id 는
  // 부모/자식 계보 대조에서 먼저 걸린다(§2.1 의 6 → 7 순서).
  const f = seedEmittedBoundary();
  let seamRuns = 0;
  const swapped = acquireLease(f.root, f.runId, {
    owner: f.child,
    expectGeneration: 1,
    runtime: 'claude',
    now: Date.parse(T2),
    __testPreCheckSeam: (loop) => {
      seamRuns += 1;
      loop.session_chain.lease.handoff_child_run_id = 'SEAMSWAPPEDCHILD00000';
    },
  });
  assert.equal(seamRuns, 1);
  assert.equal(swapped.ok, false);
  assert.equal(swapped.reason, 'boundary-topology-invalid');   // preCheck 가 seam 이 쓴 값을 봤다는 증거
  assert.equal(swapped.proceed, false);
  assert.equal(swapped.consumed, null);
  // 무변이: 거부이므로 예약은 그대로다.
  assert.equal(lease(f.root, f.runId).generation, 1);
  assert.equal(lease(f.root, f.runId).handoff_child_run_id, f.child);
  assert.equal(leaseAcquiredEvents(f.root, f.runId).length, 0);

  // seam 을 넘기지 않으면 호출 자체가 없고 같은 acquire 는 성공한다 (opt-in 확인).
  const clean = acquireLease(f.root, f.runId, {
    owner: f.child, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(clean.proceed, true);
  assert.equal(clean.consumed.takeover_kind, 'boundary-handoff');
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 — conformance fixture 재생 (5 ordering + seed)
// ─────────────────────────────────────────────────────────────────────────────

function substitute(value, bindings) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const key of Object.keys(bindings).sort((a, b) => b.length - a.length)) {
    out = out.split(key).join(String(bindings[key]));
  }
  return out;
}

function dotPath(value, path) {
  if (path === '') return value;
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), value);
}

function subsetMatch(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual?.[key], value, `${label}: field ${key}`);
  }
}

function replayFixtureStep(step, bindings, counters) {
  if (step.op === 'mkdir') {
    mkdirSync(join(bindings.$ROOT, substitute(step.rel, bindings)), { recursive: true });
    return;
  }
  if (step.op === 'write-file') {
    const target = join(bindings.$ROOT, substitute(step.rel, bindings));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, substitute(step.content, bindings));
    return;
  }
  assert.equal(step.op, 'cli', 'unknown fixture op');
  const argv = step.argv.map(item => substitute(item, bindings));
  const implicit = argv[0] === 'init-run'
    ? []
    : ['--project-root', bindings.$ROOT, '--run-id', bindings.$RUN];
  const result = spawnSync(process.execPath, [CLI, ...argv, ...implicit], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  const label = argv.join(' ');
  if (step.expect?.exit !== undefined) {
    assert.equal(result.status, step.expect.exit, `${label}\n${result.stdout}${result.stderr}`);
  }
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  if (step.expect?.json) subsetMatch(parsed, step.expect.json, label);
  if (step.expect?.stdout_has) {
    for (const needle of step.expect.stdout_has) {
      assert.ok(
        result.stdout.includes(substitute(needle, bindings)),
        `${label}: stdout missing ${substitute(needle, bindings)}\n${result.stdout}`,
      );
    }
  }
  if (step.expect_consumed_takeover_kind !== undefined) {
    assert.equal(parsed?.consumed?.takeover_kind, step.expect_consumed_takeover_kind, label);
  }
  if (parsed?.proceed === true) counters.proceed += 1;
  for (const [name, path] of Object.entries(step.capture || {})) {
    bindings[name] = dotPath(parsed, path);
    assert.notEqual(bindings[name], undefined, `${label}: capture ${name}`);
  }
}

test('T4 the conformance fixture replays deterministically through the public CLI', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(fixture.contract, 'deep-loop-acquire-resume-conformance');
  assert.equal(fixture.orderings.length, 5 + 1);
  for (const ordering of fixture.orderings) {
    const root = mkdtempSync(join(tmpdir(), `dl-conformance-${ordering.id}-`));
    const bindings = { $ROOT: root };
    // fixture 의 now_binding 규칙: 시각은 **재생 시점 기준 상대 오프셋**으로 바인딩한다. recovery safety 는
    // lock 안에서 실제 clock 을 샘플하므로(주입 불가) 절대 과거 시각에 고정하면 재생 시점에 따라 응답이
    // 갈린다. 오프셋 바인딩은 응답 계약을 시각 독립적으로 만든다 — fixture 는 타임스탬프를 비교하지 않는다.
    const replayStart = Date.now();
    for (const [name, offset] of Object.entries(fixture.now_binding.offsets_sec)) {
      bindings[`$${name}`] = new Date(replayStart + (offset * 1000)).toISOString();
    }
    const counters = { proceed: 0 };
    for (const step of fixture.seed) replayFixtureStep(step, bindings, counters);
    counters.proceed = 0;
    for (const step of ordering.steps) replayFixtureStep(step, bindings, counters);

    const finalLease = runReadCli(root, bindings.$RUN, ['state', 'get', '--field', 'session_chain.lease']);
    assert.equal(finalLease.status, 0, finalLease.stderr);
    const leaseState = JSON.parse(finalLease.stdout);
    const finalStatus = runReadCli(root, bindings.$RUN, ['state', 'get', '--field', 'status']);
    const expectedFinal = ordering.final;
    for (const [key, value] of Object.entries(expectedFinal)) {
      const resolved = substitute(value, bindings);
      if (key === 'status') {
        assert.equal(JSON.parse(finalStatus.stdout), resolved, `${ordering.id}: status`);
      } else {
        assert.deepEqual(leaseState[key], resolved, `${ordering.id}: lease.${key}`);
      }
    }
    if (ordering.id === 'duplicate') {
      assert.equal(counters.proceed, 1, 'duplicate ordering grants proceed exactly once');
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — R1: 연속 2회 boundary rotation (spec §6.5)
// ─────────────────────────────────────────────────────────────────────────────

// C1 fence 로 sibling workstream 을 닫아 **두 번째** boundary event 를 만든다.
function closeSiblingForSecondBoundary(f, owner, generation) {
  const fenceForOwner = { owner, generation, intent: 'business' };
  // boundary handoff 는 승계할 열린 workstream 이 있어야 성립한다 — 없으면 커널이 FINISH_REQUIRED 를 낸다.
  // 디렉터리를 미리 만들지 않는다: newWorkstream 의 containment 해석은 존재하지 않는 경로에 대해 가장
  // 가까운 기존 조상까지 올라간다(workspace.mjs:33-52) — seedEmittedBoundary 의 sibling 도 그래서 없다.
  newWorkstream(f.root, f.runId, {
    title: 'successor', branch: 'feature/successor',
    worktree: '.claude/worktrees/successor', fence: fenceForOwner,
  });
  const worktree = '.claude/worktrees/sibling';
  const sibling = readState(f.root, f.runId).data.workstreams.find(ws => ws.title === 'sibling').id;
  const artifact = `${worktree}/impl2.txt`;
  mkdirSync(join(f.root, worktree), { recursive: true });
  writeFileSync(join(f.root, artifact), 'impl2\n');
  const maker = newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: sibling, expectedArtifacts: [artifact], fence: fenceForOwner,
  }).id;
  recordEpisode(f.root, f.runId, maker, { status: 'in_progress', fence: fenceForOwner });
  recordEpisode(f.root, f.runId, maker, {
    status: 'done', artifacts: [artifact], proof: {}, fence: fenceForOwner,
  });
  const checker = dispatchReview(f.root, f.runId, {
    point: 'implementation', workstreamId: sibling, detected: {}, fence: fenceForOwner,
  }).checkerEpisodeId;
  const report = `${worktree}/impl2-review.md`;
  writeFileSync(join(f.root, report), '# review\nAPPROVE\n');
  recordReviewOutcome(f.root, f.runId, {
    episodeId: checker, verdict: 'APPROVE', proof: { report }, fence: fenceForOwner,
  });
  const closed = runCli(f.root, f.runId, [
    'workstream', 'terminal', '--id', sibling, '--status', 'ready', '--proof', '{}', '--now', T2,
  ], owner, generation);
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  return readState(f.root, f.runId).data.session_chain.sessions
    .find(session => session.run_id === owner).scope.terminal_event;
}

test('T6 two consecutive boundary rotations bind lineage to the current owner, not the logical run id', () => {
  const f = seedEmittedBoundary();                       // emit#1 (expect.owner === runId)
  const c1 = f.child;
  const first = acquireLease(f.root, f.runId, {
    owner: c1, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(first.proceed, true);
  assert.equal(first.generation, 2);

  const secondBoundary = closeSiblingForSecondBoundary(f, c1, 2);
  assert.notDeepEqual(secondBoundary, f.boundary);

  // emit#2 — 현행 writer 는 논리 runId 를 lineage 에 쓰고 검증자는 expect.owner 를 요구하므로
  // `TRANSACTION_RECONCILIATION_REQUIRED: boundary publication topology` 로 거부된다(RED).
  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: secondBoundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(T2) + 1_000,
    expect: { owner: c1, generation: 2 },
    env: {},
  });
  assert.equal(emitted.ok, true);
  const c2 = emitted.childRunId;

  // reconcile 이 정상이고 prepared 저널이 남지 않는다.
  captureReconciledRunSnapshot(f.root, f.runId);
  const transactions = join(runDir(f.root, f.runId), 'transactions');
  // 잔존 = **prepared 인데 commit 되지 않은** 저널이다. commit 은 prepared.json 을 지우지 않고
  // committed.json 을 함께 남기므로(transaction-journal.mjs:1228,1248) prepared.json 존재만으로는
  // 판정할 수 없다 — 그렇게 세면 정상 커밋된 publication 도 잔존으로 오탐한다.
  const stranded = existsSync(transactions)
    ? readdirSync(transactions).filter(entry => existsSync(join(transactions, entry, 'prepared.json'))
      && !existsSync(join(transactions, entry, 'committed.json')))
    : [];
  assert.deepEqual(stranded, []);

  const afterEmit = readState(f.root, f.runId).data;
  const childEntry = afterEmit.session_chain.sessions.find(session => session.run_id === c2);
  const parentEntry = afterEmit.session_chain.sessions.find(session => session.run_id === c1);
  assert.equal(childEntry.parent_run_id, c1, 'lineage binds to the superseded owner');
  assert.equal(parentEntry.superseded_by, c2);

  // compaction-state / launch-command-meta 도 같은 owner 를 기록한다.
  const dir = runDir(f.root, f.runId);
  const compaction = JSON.parse(readFileSync(join(dir, 'handoffs', `${c2}-compaction-state.json`), 'utf8'));
  assert.equal(compaction.envelope.parent_run_id, c1);
  const meta = JSON.parse(readFileSync(join(dir, 'terminal', 'launch-command.meta.json'), 'utf8'));
  assert.equal(meta.envelope.parent_run_id, c1);
  assert.equal(meta.payload.parent_run_id, c1);

  // F1(리뷰 라운드 3): reader 수정(R-r1)은 T6 의 writer 회전만으로는 고정되지 않는다 — 두 반쪽 중
  // 어느 쪽을 되돌려도 T6 는 green 이고, 저장소의 모든 resume-command boundary-metadata 테스트는
  // generation 1(변경이 no-op)이다. 2세대에서 journaled launch-command.txt 를 신뢰하는지는 상태로는
  // 관측되지 않고 **어느 문자열을 출력하는지**로만 드러나므로 여기서 직접 assert 한다. reader 가
  // 논리 runId 로 되돌아가면 meta/child 대조가 어긋나 재구성된 launcher 줄로 조용히 강등된다.
  const journaledLaunch = readFileSync(
    join(runDir(f.root, f.runId), 'terminal', 'launch-command.txt'),
    'utf8',
  ).trimEnd();
  const shown = runReadCli(f.root, f.runId, ['resume-command']);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.ok(shown.stdout.includes('Launcher guidance (from launch-command.txt):'),
    `gen-2 resume-command must trust the journaled launch text:\n${shown.stdout}`);
  assert.ok(shown.stdout.includes(journaledLaunch));
  assert.ok(shown.stdout.includes(`child_run_id=${c2}`));

  // 멱등 재-emit — 2세대에서 처음으로 성립한다. durable 바이트 불변.
  const before = anchoredBytes(f.root, f.runId);
  const again = emitHandoff(f.root, f.runId, {
    boundaryEvent: secondBoundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(T2) + 2_000,
    expect: { owner: c1, generation: 2 },
    env: {},
  });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.childRunId, c2);
  assert.deepEqual(anchoredBytes(f.root, f.runId), before);

  // 회전 2회 완주 — C2 가 인수하고 consumed 가 직전 owner 를 가리킨다.
  const second = acquireLease(f.root, f.runId, {
    owner: c2, expectGeneration: 2, runtime: 'claude', now: Date.parse(T2) + 3_000,
  });
  assert.equal(second.proceed, true);
  assert.equal(second.generation, 3);
  assert.equal(second.consumed.takeover_kind, 'boundary-handoff');
  assert.equal(second.consumed.superseded_owner_run_id, c1);
  assert.deepEqual(second.consumed.boundary_event, secondBoundary);
});

// T6 Windows 회귀 — 선재 publication 결함이 R1(2회 rotation) 이후 처음 도달 가능해진 것이다.
// win32 에서는 8개 launcher surface 가 전부 상수 manual/unavailable 로 강등돼
// `terminal/launch-command.txt` 가 emit 간 **바이트 동일**해진다. 그러면 그 target 은
// "디스크 내용 == candidate" 이므로 `candidate` 로 분류되는데, 앞의 두 handoff target 은 신규(미발행)
// 이라 contiguous-prefix 규칙이 `artifact publication order` 로 헛발화했다.
// POSIX 에서는 osascript/cmux surface 가 emit 마다 달라져 그 조합이 만들어지지 않으므로 Windows CI
// 에서만 드러났다 — platform 을 주입해 모든 호스트에서 같은 경로를 태운다.
test('T6 a second boundary emit publishes an emit-invariant launcher text (Windows regression)', () => {
  const f = seedEmittedBoundary('claude', 'win32');
  const c1 = f.child;
  const first = acquireLease(f.root, f.runId, {
    owner: c1, expectGeneration: 1, runtime: 'claude', now: Date.parse(T2),
  });
  assert.equal(first.proceed, true);

  const secondBoundary = closeSiblingForSecondBoundary(f, c1, 2);
  const launchPath = join(runDir(f.root, f.runId), 'terminal', 'launch-command.txt');
  const launchBefore = readFileSync(launchPath);

  const emitted = emitHandoff(f.root, f.runId, {
    boundaryEvent: secondBoundary,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: Date.parse(T2) + 1_000,
    expect: { owner: c1, generation: 2 },
    env: {}, platform: 'win32',
  });
  assert.equal(emitted.ok, true);
  const c2 = emitted.childRunId;

  // 전제 고정: 이 테스트가 덮는 것은 **무변경 재발행**이다. win32 launcher 텍스트가 emit 마다 달라지게
  // 바뀌면 여기서 먼저 깨지고, 그때는 커버리지가 옮겨간 것이다 — 메커니즘 자체는
  // tests/transaction-journal.test.mjs 의 order-neutral 테스트가 계속 고정한다.
  assert.deepEqual(readFileSync(launchPath), launchBefore,
    'win32 launcher text must stay emit-invariant for this regression to cover anything');

  // 앞선 신규 target 들이 실제로 발행됐는지, 그리고 **커밋되지 않은** prepared 저널이 남지 않았는지.
  // 성공한 emit 의 committed 디렉터리는 다음 appendAnchored 가 retire 할 때까지 남으므로(:1266) 잔존
  // 판정에서 제외한다 — prepared.json 존재만으로 세면 정상 커밋도 오탐한다.
  const dir = runDir(f.root, f.runId);
  assert.equal(existsSync(join(dir, 'handoffs', `${c2}-next-session.md`)), true);
  const compaction = JSON.parse(readFileSync(join(dir, 'handoffs', `${c2}-compaction-state.json`), 'utf8'));
  assert.equal(compaction.envelope.parent_run_id, c1);
  const meta = JSON.parse(readFileSync(join(dir, 'terminal', 'launch-command.meta.json'), 'utf8'));
  assert.equal(meta.payload.child_run_id, c2);
  assert.equal(meta.payload.launch_command_sha256, contentHash(launchBefore));

  captureReconciledRunSnapshot(f.root, f.runId);
  const transactions = join(dir, 'transactions');
  const stranded = existsSync(transactions)
    ? readdirSync(transactions).filter(entry => existsSync(join(transactions, entry, 'prepared.json'))
      && !existsSync(join(transactions, entry, 'committed.json')))
    : [];
  assert.deepEqual(stranded, []);
});
