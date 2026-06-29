import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import {
  deriveIdempotencyKey, leaseCheck, acquireLease, releaseLease,
  reserveHandoff, advanceHandoffPhase, rollbackHandoff,
} from '../scripts/lib/lease.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('deriveIdempotencyKey is deterministic and trigger-sensitive', () => {
  const a = deriveIdempotencyKey('R', 1, 'milestone');
  assert.equal(a, deriveIdempotencyKey('R', 1, 'milestone'));
  assert.notEqual(a, deriveIdempotencyKey('R', 1, 'precompact'));
  assert.notEqual(a, deriveIdempotencyKey('R', 2, 'milestone'));
});

test('leaseCheck passes for current owner+generation, rejects mismatch; active owner never time-fenced', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  assert.equal(leaseCheck(data, { owner: runId, generation: 1 }).ok, true);
  assert.equal(leaseCheck(data, { owner: 'OTHER', generation: 1 }).ok, false);
  assert.equal(leaseCheck(data, { owner: runId, generation: 2 }).ok, false);
  // Codex r2 🔴2: active 소유자는 expires_at 가 과거여도 fence 되지 않는다 (deadlock 방지). leaseCheck 는 시간을 안 본다.
  data.session_chain.lease.expires_at = '2000-01-01T00:00:00Z';
  assert.equal(leaseCheck(data, { owner: runId, generation: 1 }).ok, true);
});

test('reserveHandoff dedups concurrent triggers (PreCompact no-op after Decide)', () => {
  const { root, runId } = seed();
  const decide = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(decide.reserved, true);
  const precompact = reserveHandoff(root, runId, { trigger: 'precompact' });
  assert.equal(precompact.ok, false);
  assert.equal(precompact.reason, 'handoff-in-flight');
  // same trigger re-entry is idempotent (ok, not re-reserved)
  const retry = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(retry.ok, true);
  assert.equal(retry.reserved, false);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
});

test('advanceHandoffPhase enforces forward-only and sets releasing on emitted', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'spawned' }).ok, false); // skip
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'emitted' }).ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
  assert.equal(advanceHandoffPhase(root, runId, { key: 'wrong', toPhase: 'spawned' }).ok, false); // key fence
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'spawned' }).ok, true);
});

test('acquireLease: child takes over released lease, generation+1; stale generation rejected', () => {
  const { root, runId } = seed();
  // parent releases (after spawning a child)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  // wrong expectGeneration → fenced
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 5 }).ok, false);
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.owner_run_id, 'CHILD');
  assert.equal(lease.state, 'active');
  assert.equal(lease.handoff_phase, 'acquired');
  assert.equal(lease.handoff_idempotency_key, null);
});

test('acquireLease: active lease is never stolen (even past expires_at); released is takeable', () => {
  const { root, runId } = seed();
  // active → not takeable by another owner
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1 }).ok, false);
  // 심지어 active 에 과거 expires_at 이 있어도 탈취 불가 (active 는 deadline 없음 — Codex r2 🔴2)
  const { data } = readState(root, runId);
  data.session_chain.lease.expires_at = new Date(Date.parse('2026-06-24T00:00:00Z') + 1000).toISOString();
  writeState(root, runId, data);
  const future = Date.parse('2026-06-24T01:00:00Z');
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: future }).ok, false);
  // released → takeable, generation+1
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: future });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
  assert.equal(readState(root, runId).data.session_chain.lease.expires_at, null);  // active = no deadline
});

test('rollbackHandoff restores active/idle (launch-failure path)', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted' });
  const r = rollbackHandoff(root, runId, { owner: runId, generation: 1 });
  assert.equal(r.ok, true);
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'active');
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_idempotency_key, null);
});

// Codex r1 🔴4: emitted 진입이 expires_at 를 설정해야 부모 크래시(releaseLease 누락) 후에도 자식이 TTL 경과로 인수 가능.
test('emitted sets expires_at → child can take over after stale TTL without explicit release', () => {
  const { root, runId } = seed();
  const now0 = Date.parse('2026-06-24T00:00:00Z');
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', now: now0 });
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'releasing');
  assert.ok(lease.expires_at, 'expires_at must be set on emitted');
  // 부모가 releaseLease 를 못 하고 죽음. TTL(900s) 경과 전: 인수 불가(releasing 은 takeable 아님)
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: now0 + 1000 }).ok, false);
  // TTL 경과 후: stale → 인수 가능
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: now0 + 901 * 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
});

test('leaseCheck allows accounting during releasing for matching owner/generation', () => {
  const loop = { session_chain: { lease: { owner_run_id: 'r', generation: 2, state: 'releasing' } } };
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'business' }).ok, false);    // 업무 write 거부
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'accounting' }).ok, true);   // 회계 허용
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 3, intent: 'accounting' }).ok, false);  // generation 불일치 거부
});

// Fix A: reserveHandoff with stale expect is fenced (generation-mismatch); without expect is unchanged
test('reserveHandoff: stale expect fences without mutating; no expect is unchanged', () => {
  const { root, runId } = seed();
  // Stale owner → fenced
  const r1 = reserveHandoff(root, runId, { trigger: 'milestone', expect: { owner: 'WRONG', generation: 1 } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'fenced');
  assert.equal(r1.reserved, false);
  // Stale generation → fenced
  const r2 = reserveHandoff(root, runId, { trigger: 'milestone', expect: { owner: runId, generation: 99 } });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'fenced');
  // State is NOT mutated by fenced calls
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
  // Correct expect → succeeds
  const r3 = reserveHandoff(root, runId, { trigger: 'milestone', expect: { owner: runId, generation: 1 } });
  assert.equal(r3.ok, true);
  assert.equal(r3.reserved, true);
  // No expect → unchanged behavior (backward compat)
  const { root: root2, runId: runId2 } = seed();
  const r4 = reserveHandoff(root2, runId2, { trigger: 'milestone' });
  assert.equal(r4.ok, true);
  assert.equal(r4.reserved, true);
});

// Fix A: advanceHandoffPhase with stale expect is fenced before key/phase checks
test('advanceHandoffPhase: stale expect fences before key/phase checks; correct expect proceeds', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  // Stale generation → fenced (before key check)
  const r1 = advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', expect: { owner: runId, generation: 99 } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'fenced');
  // State not mutated
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
  // Correct expect → proceeds
  const r2 = advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', expect: { owner: runId, generation: 1 } });
  assert.equal(r2.ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
});

// ── Task 8: preserve-resume unpause + terminal guard ─────────────────────────

// Helper: seed a preserve-paused run (status=paused, lease.state=releasing, reserved child)
function seedPreservePaused(root, runId, childRunId = 'C') {
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.pause_reason = 'preserve-paused-test';
  data.session_chain.lease = {
    ...data.session_chain.lease,
    state: 'releasing',
    handoff_child_run_id: childRunId,
    handoff_phase: 'spawned',
    resume_policy: 'human',
    expires_at: null,
  };
  writeState(root, runId, data);
}

test('reserved child acquiring a preserve-paused run unpauses it (R14-RR)', () => {
  const { root, runId } = seed();
  seedPreservePaused(root, runId, 'C');
  const now0 = Date.parse('2026-06-24T12:00:00Z');

  const r = acquireLease(root, runId, { owner: 'C', expectGeneration: 1, now: now0 });
  assert.equal(r.ok, true);
  assert.equal(r.generation, 2);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.pause_reason, null);
  assert.equal(data.session_chain.lease.resume_policy, null);
  assert.equal(data.session_chain.lease.generation, 2);
});

test('non-reserved owner still cannot acquire preserve-paused run (expires_at=null)', () => {
  const { root, runId } = seed();
  seedPreservePaused(root, runId, 'C');
  // expires_at=null → expired=false → only reserved child 'C' is takeable; 'OTHER' is not
  const r = acquireLease(root, runId, { owner: 'OTHER', expectGeneration: 1, now: Date.parse('2099-01-01T00:00:00Z') });
  assert.equal(r.ok, false);
  // status must remain paused (no spurious change)
  assert.equal(readState(root, runId).data.status, 'paused');
});

test('recover round-trip: released-paused run acquired by fresh owner unpauses (Task 7 closed)', () => {
  // Simulates the state left by recoverRun: status=paused, lease.state=released,
  // handoff_child_run_id=null, pause_reason='recovered:awaiting-resume'.
  // Task 8 acquireLease must clear the pause.
  const { root, runId } = seed();
  const { data: d0 } = readState(root, runId);
  d0.status = 'paused';
  d0.pause_reason = 'recovered:awaiting-resume';
  d0.session_chain.lease = {
    ...d0.session_chain.lease,
    state: 'released',
    handoff_child_run_id: null,
    handoff_idempotency_key: null,
    handoff_phase: 'idle',
    resume_policy: null,
    expires_at: null,
  };
  writeState(root, runId, d0);

  const r = acquireLease(root, runId, { owner: 'FRESH', expectGeneration: 1 });
  assert.equal(r.ok, true);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.pause_reason, null);
  assert.equal(data.session_chain.lease.generation, 2);
});

test('terminal guard: stopped run rejects acquireLease with run-terminal', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const { data: d0 } = readState(root, runId);
  d0.status = 'stopped';
  writeState(root, runId, d0);

  const r = acquireLease(root, runId, { owner: 'NEW', expectGeneration: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-terminal');
});

test('terminal guard: completed run rejects acquireLease with run-terminal', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const { data: d0 } = readState(root, runId);
  d0.status = 'completed';
  writeState(root, runId, d0);

  const r = acquireLease(root, runId, { owner: 'NEW', expectGeneration: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-terminal');
});

test('regression: non-paused run acquire leaves status running, no spurious pause_reason write', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const r = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1 });
  assert.equal(r.ok, true);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.ok(!data.pause_reason, 'pause_reason must not be set on non-paused acquire');
});

// Codex r3 🔴1: releaseLease must reject when status=paused — prevents owner bypassing recover audit path.
test('releaseLease on paused run returns RUN_PAUSED; lease NOT released; acquireLease stays blocked (codex-high)', () => {
  const { root, runId } = seed();
  // Seed a gate-blocked-style paused state: status=paused, lease.state=active, same owner/generation.
  { const { data } = readState(root, runId); data.status = 'paused'; data.pause_reason = 'gate:budget'; writeState(root, runId, data); }
  // releaseLease must refuse
  const r = releaseLease(root, runId, { owner: runId, generation: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'RUN_PAUSED');
  // lease NOT released — state still active
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'active');
  assert.equal(lease.owner_run_id, runId);
  // acquireLease by a new owner must still be blocked (run is paused, lease not released → not takeable)
  const acq = acquireLease(root, runId, { owner: 'BYPASS', expectGeneration: 1 });
  assert.equal(acq.ok, false);
  assert.ok(acq.reason !== 'acquired', 'paused run must not be re-acquired via bypassed release');
  // run status remains paused
  assert.equal(readState(root, runId).data.status, 'paused');
});
