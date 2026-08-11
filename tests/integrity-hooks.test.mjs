// Phase 1 — appendAnchored 프리미티브 확장 (spec §3.2 노트 6·7·8, plan G1).
// 세 훅 모두 프로덕션 동작을 바꾸지 않는다: 1-a는 항상 전달되는 두 번째 인자,
// 1-b·1-c는 opt-in이라 미전달 시 호출 자체가 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import { captureReconciledRunSnapshot } from '../scripts/lib/integrity.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runDir } from '../scripts/lib/state.mjs';

const NOW = new Date('2026-07-28T00:00:00Z');

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-hooks-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: NOW });
  return { root, runId };
}

// 배리어 라벨의 의미는 주석이 아니라 디스크 상태로 고정한다 (리뷰 P1-W1).
// 그러지 않으면 나중 리팩터가 append/writeState 순서를 바꿔도 테스트가 GREEN을 유지하고,
// T3-③·T11-④가 의존하는 "정확히 이 창"이라는 전제가 조용히 무너진다.
function durable(root, runId) {
  const dir = runDir(root, runId);
  // initRun leaves only loop.json + .loop.hash — the log file appears on the first append.
  let logLines = 0;
  try {
    logLines = readFileSync(join(dir, 'event-log.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return {
    logLines,
    loopBytes: readFileSync(join(dir, 'loop.json')),
    hashBytes: readFileSync(join(dir, '.loop.hash')),
  };
}

test('family-3 event:appended fail-stop', () => {
  const { root, runId } = seed();
  const before = durable(root, runId);
  assert.throws(() => appendAnchored(root, runId, { type: 'family-3-event-appended', data: {}, now: NOW }, null, null, {
    faultAt: phase => { if (phase === 'event:appended') throw new Error('EVENT_APPENDED_BARRIER'); },
  }), /EVENT_APPENDED_BARRIER/);
  const after = durable(root, runId);
  assert.equal(after.logLines, before.logLines + 1);
  assert.deepEqual(after.loopBytes, before.loopBytes);
  assert.deepEqual(after.hashBytes, before.hashBytes);
  assert.throws(() => captureReconciledRunSnapshot(root, runId), /LOG_TAMPERED|STATE_TAMPERED|integrity/i);
});

test('family-3 state:written committed', () => {
  const { root, runId } = seed();
  const before = durable(root, runId);
  assert.throws(() => appendAnchored(root, runId, { type: 'family-3-state-written', data: {}, now: NOW }, null, null, {
    faultAt: phase => { if (phase === 'state:written') throw new Error('STATE_WRITTEN_BARRIER'); },
  }), /STATE_WRITTEN_BARRIER/);
  const after = durable(root, runId);
  assert.equal(after.logLines, before.logLines + 1);
  assert.notDeepEqual(after.loopBytes, before.loopBytes);
  assert.notDeepEqual(after.hashBytes, before.hashBytes);
  assert.equal(captureReconciledRunSnapshot(root, runId).data.event_log_head.seq, 1);
});

// 1-a — preCheck는 두 번째 인자로 { guard }를 받는다 (R4-C1).
// lease.mjs:215 / recover.mjs:1020 의 `…Locked` 호출이 guard를 요구하므로,
// preCheck 안에서 그 함수들을 부르려면 guard가 전달되어야 한다.
test('1-a: preCheck receives a guard context as its second argument', () => {
  const { root, runId } = seed();
  let seen;
  appendAnchored(root, runId, { type: 'decision', data: { k: 'v' }, now: NOW },
    null,
    (loop, ctx) => { seen = ctx; assert.ok(loop, 'preCheck still receives the loop first'); });
  assert.ok(seen, 'preCheck must receive a second argument');
  assert.ok(seen.guard, 'the second argument must carry .guard');
  assert.equal(typeof seen.guard.renew, 'function', 'guard must be the live lock guard');
});

// 1-a 회귀 — 두 번째 인자를 선언하지 않은 기존 호출부는 그대로 동작한다.
test('1-a: a preCheck declaring only (loop) is unaffected', () => {
  const { root, runId } = seed();
  let calls = 0;
  appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null, (loop) => { calls += 1; assert.ok(loop.run_id); });
  assert.equal(calls, 1);
});

// 1-b — 비-publication 분기의 faultAt (ARC-2). T3의 commit-직후 크래시 재현용.
// 두 지점: 이벤트 append 직후·writeState 전 / writeState 직후·return 전.
test('1-b: non-publication faultAt fires at both phases in order', () => {
  const { root, runId } = seed();
  const phases = [];
  appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null, null, { faultAt: phase => phases.push(phase) });
  assert.deepEqual(phases, ['event:appended', 'state:written']);
});

// 'event:appended' 는 half-commit 창을 뜻한다 — 로그는 커밋됐고 state는 아직이다.
// 그 의미를 디스크로 고정한다: 로그 +1줄, loop.json·.loop.hash 바이트 불변.
// 주의(Phase 2): 이 상태는 복구 가능한 half-commit이 아니다. 다음 읽기에서
// verifyHeadLines(integrity.mjs:127-128)가 낡은 앵커를 보고 LOG_TAMPERED로 fail-stop한다.
// 이 배리어를 쓰는 테스트는 복구가 아니라 fail-stop을 assert해야 한다.
test("1-b: aborting at 'event:appended' leaves the log committed and the state untouched", () => {
  const { root, runId } = seed();
  const before = durable(root, runId);
  assert.throws(() => appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null, null, {
      faultAt: phase => { if (phase === 'event:appended') throw new Error('CRASH_AFTER_APPEND'); },
    }), /CRASH_AFTER_APPEND/);
  const after = durable(root, runId);
  assert.equal(after.logLines, before.logLines + 1, 'the event must already be on disk');
  assert.deepEqual(after.loopBytes, before.loopBytes, 'writeState must not have run yet');
  assert.deepEqual(after.hashBytes, before.hashBytes, 'the anchor must still be the old one');
});

// 'state:written' 은 로그와 state 모두 커밋됐고 caller가 아직 반환을 못 본 창이다.
test("1-b: aborting at 'state:written' leaves both the log and the state committed", () => {
  const { root, runId } = seed();
  const before = durable(root, runId);
  assert.throws(() => appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null, null, {
      faultAt: phase => { if (phase === 'state:written') throw new Error('CRASH_AFTER_COMMIT'); },
    }), /CRASH_AFTER_COMMIT/);
  const after = durable(root, runId);
  assert.equal(after.logLines, before.logLines + 1);
  assert.notDeepEqual(after.loopBytes, before.loopBytes, 'writeState must have run');
  assert.notDeepEqual(after.hashBytes, before.hashBytes, 'the anchor must have been re-stamped');
});

// 1-b opt-in — 미전달 시 훅 호출 자체가 없다 (G1). "exactly"를 지탱하는 것은 전수 GREEN이므로
// 이 테스트는 그 이름을 주장하지 않고 (a) 반환 계약과 (b) 커밋이 실제로 일어남만 고정한다.
test('1-b: omitting faultAt returns undefined and still commits both durables', () => {
  const { root, runId } = seed();
  const before = durable(root, runId);
  assert.equal(appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW }, null, null),
    undefined, 'the non-publication branch still returns undefined');
  const after = durable(root, runId);
  assert.equal(after.logLines, before.logLines + 1);
  assert.notDeepEqual(after.loopBytes, before.loopBytes);
});

// 1-c — preCheckSeam (R6-W2). T11의 stale-snapshot 오라클.
// lock 획득·reconciliation 이후, caller preCheck 직전에 정확히 한 번.
test('1-c: preCheckSeam runs exactly once, immediately before preCheck', () => {
  const { root, runId } = seed();
  const order = [];
  appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null,
    () => order.push('preCheck'),
    { preCheckSeam: () => order.push('seam') });
  assert.deepEqual(order, ['seam', 'preCheck']);
});

test('1-c: preCheckSeam runs even when no preCheck is supplied', () => {
  const { root, runId } = seed();
  let calls = 0;
  appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null, null, { preCheckSeam: () => { calls += 1; } });
  assert.equal(calls, 1);
});

// 1-c opt-in — 미전달 시 호출 자체가 없다 (G1). seam이 없으면 preCheck가 첫 caller 훅이다.
test('1-c: omitting preCheckSeam leaves preCheck as the first caller hook', () => {
  const { root, runId } = seed();
  const order = [];
  appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null, () => order.push('preCheck'));
  assert.deepEqual(order, ['preCheck']);
});

// 1-c 는 caller preCheck 앞이므로, seam이 throw하면 append가 일어나지 않는다.
test('1-c: a throwing preCheckSeam aborts before any append', () => {
  const { root, runId } = seed();
  const before = durable(root, runId);
  let preCheckRan = false;
  assert.throws(() => appendAnchored(root, runId, { type: 'decision', data: {}, now: NOW },
    null,
    () => { preCheckRan = true; },
    { preCheckSeam: () => { throw new Error('SEAM_ABORT'); } }), /SEAM_ABORT/);
  assert.equal(preCheckRan, false, 'preCheck must not run after the seam throws');
  // 호출 장부만 보면 "append 전"이라는 이름을 지탱하지 못한다 — 디스크로 고정한다.
  const after = durable(root, runId);
  assert.equal(after.logLines, before.logLines, 'no event may reach the log');
  assert.deepEqual(after.loopBytes, before.loopBytes);
  assert.deepEqual(after.hashBytes, before.hashBytes);
});
