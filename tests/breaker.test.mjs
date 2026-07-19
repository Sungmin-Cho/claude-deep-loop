import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBreaker, recordReviewVerdict, resetBreaker } from '../scripts/lib/breaker.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-breaker-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

let verdictRequest7g = 0;
function reviewVerdict7g(root, runId, verdict, { fence = null, requestId = null } = {}) {
  const state = readState(root, runId).data;
  const lease = state.session_chain.lease;
  const runtime = state.autonomy?.session_runtime ?? 'claude';
  const binding = fence == null
    ? { owner: lease.owner_run_id, generation: lease.generation, runtime }
    : { ...fence, runtime: fence.runtime ?? runtime };
  verdictRequest7g += 1;
  return recordReviewVerdict(root, runId, verdict, binding,
    { requestId: requestId ?? `breaker-test-${verdictRequest7g}` });
}

test('not tripped under threshold', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 2 } }).tripped, false);
});
test('tripped at 3 consecutive REQUEST_CHANGES', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 3 } }).tripped, true);
});
test('explicit tripped flag honored', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: true, consecutive_request_changes: 0 } }).tripped, true);
});

// Codex r6 🟡: circuit breaker LATCHES at threshold — tripped is human-reset only
test('recordReviewVerdict latches breaker at 3 REQUEST_CHANGES', () => {
  const { root, runId } = seed();
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES');
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES');
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES');
  const { data } = readState(root, runId);
  assert.equal(data.circuit_breaker.tripped, true);
  assert.equal(data.circuit_breaker.trip_reason, 'consecutive-request-changes');
  assert.equal(data.status, 'paused');
});

test('recordReviewVerdict rejects a paused lease without mutating the latch', () => {
  const { root, runId } = seed();
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES');
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES');
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES');
  // Verify latched
  assert.equal(readState(root, runId).data.circuit_breaker.tripped, true);
  const before = JSON.stringify(readState(root, runId).data);
  assert.throws(() => reviewVerdict7g(root, runId, 'APPROVE'),
    /LEASE_FENCED: RUN_PAUSED/);
  assert.equal(JSON.stringify(readState(root, runId).data), before);
  const { data } = readState(root, runId);
  assert.equal(data.circuit_breaker.consecutive_request_changes, 3);
  assert.equal(data.circuit_breaker.tripped, true, 'tripped stays latched (human-reset only)');
});

test('resetBreaker clears a tripped latch under valid fence; wrong gen throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-rb-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES', { fence });
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES', { fence });
  reviewVerdict7g(root, runId, 'REQUEST_CHANGES', { fence });
  assert.equal(checkBreaker(readState(root, runId).data).tripped, true);
  assert.throws(() => resetBreaker(root, runId, { fence: { owner: runId, generation: 9 }, requestId: 'wrong-generation-reset' }), /LEASE_FENCED/);
  // RUN_PAUSED gate: breaker reset requires intent='breaker-reset' on a paused run (exempt from RUN_PAUSED).
  const r = resetBreaker(root, runId, { fence: { owner: runId, generation: 1, intent: 'breaker-reset' }, requestId: 'valid-reset' });
  assert.equal(r.status, 'running');   // breaker 사유 paused → 복귀
  assert.equal(checkBreaker(readState(root, runId).data).tripped, false);
});

// ── v1.6 직접-writer terminal 가드 (spec §2.3-7 / §4-5g) ─────────────────────
import { tripBreaker } from '../scripts/lib/breaker.mjs';
function terminalSeed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-brk-t-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  finishRun(root, runId, { status: 'stopped', confirm: true,
    proof: { human_reason: 'terminal breaker fixture' },
    fence: { owner: runId, generation: 1 } });
  return { root, runId, owner: runId };
}

test('tripBreaker / recordReviewVerdict: terminal run throws RUN_TERMINAL, state unchanged', () => {
  const { root, runId } = terminalSeed();
  const fence = { owner: runId, generation: 1 };
  assert.throws(() => tripBreaker(root, runId, 'x', { fence, requestId: 'terminal-trip' }),
    /RUN_TERMINAL: tripBreaker/);
  assert.throws(() => reviewVerdict7g(root, runId, 'REQUEST_CHANGES', { fence }),
    /RUN_TERMINAL: recordReviewVerdict/);
  const d = readState(root, runId).data;
  assert.equal(d.status, 'stopped');
  assert.equal(d.circuit_breaker?.tripped ?? false, false);
});

test('resetBreaker: fenced call rejects via LEASE_FENCED channel; fence-less via own throw (order = contract)', () => {
  const { root, runId, owner } = terminalSeed();
  // fence 있는 호출 → leaseCheck 선행 (drive-headless LEASE_FENCED swallow 계약 보존)
  assert.throws(() => resetBreaker(root, runId, { fence: { owner, generation: 1, intent: 'breaker-reset' }, requestId: 'terminal-reset' }), /LEASE_FENCED: RUN_TERMINAL/);
  // Missing authority is rejected before any terminal business policy.
  assert.throws(() => resetBreaker(root, runId, {}), /FENCE_REQUIRED: breaker-reset/);
});
