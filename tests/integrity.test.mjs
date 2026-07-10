import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, verifyLog, recomputeSpent } from '../scripts/lib/integrity.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(runDir(root, 'R'), { recursive: true });
  return root;
}

test('append + verify chain ok', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.equal(verifyLog(root, 'R').ok, true);
});

test('recomputeSpent sums cost events', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'decision', data: {} });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.deepEqual(recomputeSpent(root, 'R'), { turns: 5, tokens: 150 });
});

test('tampered event breaks chain', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendFileSync(join(runDir(root, 'R'), 'event-log.jsonl'),
    JSON.stringify({ seq: 2, ts: 'x', type: 'cost', data: { turns: 999 }, checksum: 'forged' }) + '\n');
  assert.equal(verifyLog(root, 'R').ok, false);
});

// Codex impl r12 🔴: appendAnchored must NOT launder a suffix-truncated log — it fails closed before appending,
// so the stale anchor is preserved (reconcile can still detect the loss) rather than overwritten.
test('appendAnchored fails closed on a truncated event log (no launder)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  recordCost(root, runId, { turns: 1, tokens: 10 });
  recordCost(root, runId, { turns: 1, tokens: 10 });
  const anchorBefore = readState(root, runId).data.event_log_head;
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  writeFileSync(logPath, lines.slice(0, -1).join('\n') + '\n');   // suffix-truncate the last event
  assert.throws(() => recordCost(root, runId, { turns: 1, tokens: 10 }), /LOG_TAMPERED/);
  // anchor must NOT have advanced (no laundering of the truncation)
  assert.deepEqual(readState(root, runId).data.event_log_head, anchorBefore);
});

test('appendAnchored rechecks project-root binding in-lock before precheck, event, or hash writes', () => {
  const originalRoot = mkdtempSync(join(tmpdir(), 'dl-root-gateway-original-'));
  const candidateRoot = mkdtempSync(join(tmpdir(), 'dl-root-gateway-copy-'));
  const { runId } = initRun(originalRoot, { runtime: 'claude', goal: 'g', now: new Date('2026-07-11T00:00:00Z') });
  appendAnchored(originalRoot, runId, { type: 'seed-event', data: {} }, () => {});
  cpSync(join(originalRoot, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });

  const eventPath = join(runDir(candidateRoot, runId), 'event-log.jsonl');
  const hashPath = join(runDir(candidateRoot, runId), '.loop.hash');
  const beforeEvent = readFileSync(eventPath, 'utf8');
  const beforeHash = readFileSync(hashPath, 'utf8');
  let preCheckRan = false;

  assert.throws(
    () => appendAnchored(candidateRoot, runId, { type: 'must-not-append', data: {} }, () => {}, () => { preCheckRan = true; }),
    /PROJECT_ROOT_FENCED/
  );
  assert.equal(preCheckRan, false, 'root binding must reject before caller preCheck runs');
  assert.equal(readFileSync(eventPath, 'utf8'), beforeEvent, 'root-fenced mutation must emit no event');
  assert.equal(readFileSync(hashPath, 'utf8'), beforeHash, 'root-fenced mutation must not change the loop hash');
});

// ── v1.6 appendAnchored gateway terminal gate (spec §2.1.5/§4-1b) ────────────
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import { writeState, patch } from '../scripts/lib/state.mjs';

function seededRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-gw-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  return { root, runId };
}
function makeTerminal(root, runId, status = 'completed') {
  const { data } = readState(root, runId);
  data.status = status;
  writeState(root, runId, data);
}

test('appendAnchored: terminal gateway blocks any event after caller preCheck (spec §2.1.5)', () => {
  const { root, runId } = seededRun();
  appendAnchored(root, runId, { type: 'x-pre', data: {} }, () => {});   // 로그 생성 (fresh run은 이벤트 0)
  makeTerminal(root, runId, 'completed');
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const before = readFileSync(logPath, 'utf8');
  // ① preCheck 없는 직접 append → RUN_TERMINAL: append
  assert.throws(() => appendAnchored(root, runId, { type: 'x-test', data: {} }, () => {}), /RUN_TERMINAL: append/);
  // ③ 순서 계약(4차 r1): caller preCheck의 특정 에러가 관문보다 우선 (fence-first)
  assert.throws(() => appendAnchored(root, runId, { type: 'x-test', data: {} }, () => {},
    () => { throw new Error('LEASE_FENCED: owner-mismatch'); }), /LEASE_FENCED: owner-mismatch/);
  // 로그/상태 무변
  assert.equal(readFileSync(logPath, 'utf8'), before);
  assert.equal(readState(root, runId).data.status, 'completed');
});

test('appendAnchored: fence-less state patch is blocked on terminal (spec §4-1b ②)', () => {
  const { root, runId } = seededRun();
  makeTerminal(root, runId, 'stopped');
  // 'discovered_items'는 classifyPatch 화이트리스트 필드 (비허용 필드는 FIELD_FORBIDDEN이 선착 — 관문 검증 불가)
  assert.throws(() => patch(root, runId, 'discovered_items', []), /RUN_TERMINAL: append/);
});

test('appendAnchored: non-terminal finish transition + auto-floor cost still commit (spec §4-1b ④)', () => {
  const { root, runId } = seededRun();
  appendAnchored(root, runId, { type: 'x-transition', data: {} },
    (loop) => { loop.status = 'stopped'; }, undefined, { floor: 1 });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'stopped');   // 전이 자체는 mutate 단계 — preCheck 시점 non-terminal이라 통과
  assert.ok(readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8').includes('auto_floor'));
});
