import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import {
  deriveIdempotencyKey, leaseCheck, acquireLease, releaseLease,
  reserveHandoff, advanceHandoffPhase, rollbackHandoff,
  rollbackReservedEmit,
} from '../scripts/lib/lease.mjs';

function seed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

function writeHashValidState(root, runId, data) {
  const raw = JSON.stringify(data, null, 2);
  const dir = runDir(root, runId);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
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

test('leaseCheck optionally fences a mismatched runtime before owner/generation and preserves matching semantics', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  assert.deepEqual(
    leaseCheck(data, { owner: 'OTHER', generation: 99, runtime: 'codex' }),
    { ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex' },
  );
  assert.equal(leaseCheck(data, { owner: 'OTHER', generation: 1, runtime: 'claude' }).reason, 'owner-mismatch');
  assert.equal(leaseCheck(data, { owner: runId, generation: 2, runtime: 'claude' }).reason, 'generation-mismatch');
  assert.equal(leaseCheck(data, { owner: runId, generation: 1, runtime: 'claude' }).ok, true);
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
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 5, runtime: 'claude' }).ok, false);
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, runtime: 'claude' });
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
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, runtime: 'claude' }).ok, false);
  // 심지어 active 에 과거 expires_at 이 있어도 탈취 불가 (active 는 deadline 없음 — Codex r2 🔴2)
  const { data } = readState(root, runId);
  data.session_chain.lease.expires_at = new Date(Date.parse('2026-06-24T00:00:00Z') + 1000).toISOString();
  writeState(root, runId, data);
  const future = Date.parse('2026-06-24T01:00:00Z');
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: future }).ok, false);
  // released → takeable, generation+1
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: future });
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
  assert.equal(lease.handoff_trigger, null);
});

test('rollbackReservedEmit preserves a reserved lease when a deterministic final exists', () => {
  const { root, runId } = seed();
  const expect = { owner: runId, generation: 1 };
  const reserved = reserveHandoff(root, runId, { trigger: 'milestone', expect, now: 1 });
  const dir = join(runDir(root, runId), 'handoffs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${reserved.childRunId}-next-session.md`), 'published');

  assert.deepEqual(
    rollbackReservedEmit(root, runId, {
      key: reserved.key, childRunId: reserved.childRunId, expect,
    }),
    { ok: false, reason: 'finals-present' },
  );
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
});

test('rollbackReservedEmit preserves a reserved lease when final absence is indeterminate', () => {
  const { root, runId } = seed();
  const expect = { owner: runId, generation: 1 };
  const reserved = reserveHandoff(root, runId, { trigger: 'milestone', expect, now: 1 });

  assert.deepEqual(
    rollbackReservedEmit(root, runId, {
      key: reserved.key, childRunId: reserved.childRunId, expect,
      statFn() { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
    }),
    { ok: false, reason: 'finals-indeterminate' },
  );
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
});

test('rollbackReservedEmit rolls back only after both deterministic finals prove absent', () => {
  const { root, runId } = seed();
  const expect = { owner: runId, generation: 1 };
  const reserved = reserveHandoff(root, runId, { trigger: 'milestone', expect, now: 1 });
  const checked = [];

  const result = rollbackReservedEmit(root, runId, {
    key: reserved.key, childRunId: reserved.childRunId, expect,
    statFn(path) {
      checked.push(path);
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
  });

  assert.deepEqual(result, { ok: true, rolledBack: true });
  assert.equal(checked.length, 2);
  assert.ok(checked[0].endsWith(`${reserved.childRunId}-next-session.md`));
  assert.ok(checked[1].endsWith(`${reserved.childRunId}-compaction-state.json`));
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
});

test('reserve persists raw handoff_trigger; acquireLease and rollbackHandoff clear it', () => {
  const first = seed();
  const reserved = reserveHandoff(first.root, first.runId, {
    trigger: 'raw:milestone', expect: { owner: first.runId, generation: 1 }, now: 1,
  });
  assert.equal(readState(first.root, first.runId).data.session_chain.lease.handoff_trigger, 'raw:milestone');
  advanceHandoffPhase(first.root, first.runId, { key: reserved.key, toPhase: 'emitted', now: 1 });
  const acquired = acquireLease(first.root, first.runId, {
    owner: reserved.childRunId, expectGeneration: 1, runtime: 'claude', now: 2,
  });
  assert.ok(acquired.ok);
  assert.equal(readState(first.root, first.runId).data.session_chain.lease.handoff_trigger, null);

  const second = seed();
  reserveHandoff(second.root, second.runId, {
    trigger: 'rollback-trigger', expect: { owner: second.runId, generation: 1 }, now: 1,
  });
  rollbackHandoff(second.root, second.runId, { owner: second.runId, generation: 1 });
  assert.equal(readState(second.root, second.runId).data.session_chain.lease.handoff_trigger, null);
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
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: now0 + 1000 }).ok, false);
  // TTL 경과 후: stale → 인수 가능
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: now0 + 901 * 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
});

test('releasing lease blocks parent self-reacquisition through TTL and permits it only after injected expiry', () => {
  const { root, runId } = seed();
  const now0 = Date.parse('2026-06-24T00:00:00.000Z');
  const { key } = reserveHandoff(root, runId, { trigger: 'parent-self-reacquire', now: now0 });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', now: now0 });
  const expiresAt = Date.parse(readState(root, runId).data.session_chain.lease.expires_at);

  const withinTtl = acquireLease(root, runId, {
    owner: runId, expectGeneration: 1, runtime: 'claude', now: expiresAt,
  });
  assert.deepEqual(withinTtl, { ok: false, generation: 1, reason: 'lease-not-takeable' });
  assert.equal(readState(root, runId).data.session_chain.lease.owner_run_id, runId);
  assert.equal(readState(root, runId).data.session_chain.lease.generation, 1);

  const afterTtl = acquireLease(root, runId, {
    owner: runId, expectGeneration: 1, runtime: 'claude', now: expiresAt + 1,
  });
  assert.deepEqual(afterTtl, { ok: true, generation: 2, reason: 'acquired' });
  assert.equal(readState(root, runId).data.session_chain.lease.owner_run_id, runId);
  assert.equal(readState(root, runId).data.session_chain.lease.generation, 2);
});

test('leaseCheck allows accounting during releasing for matching owner/generation', () => {
  const loop = { session_chain: { lease: { owner_run_id: 'r', generation: 2, state: 'releasing' } } };
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'business' }).ok, false);    // 업무 write 거부
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'accounting' }).ok, true);   // 회계 허용
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 3, intent: 'accounting' }).ok, false);  // generation 불일치 거부
});

test('leaseCheck allows only matching accounting on a nonterminal paused run', () => {
  const loop = {
    status: 'paused',
    session_chain: { lease: { owner_run_id: 'r', generation: 2, state: 'active' } },
  };
  assert.deepEqual(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'accounting' }), { ok: true, reason: 'ok' });
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'business' }).reason, 'RUN_PAUSED');
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'lease' }).reason, 'RUN_PAUSED');
  assert.equal(leaseCheck(loop, { owner: 'other', generation: 2, intent: 'accounting' }).reason, 'owner-mismatch');
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 3, intent: 'accounting' }).reason, 'generation-mismatch');
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

  const r = acquireLease(root, runId, { owner: 'C', expectGeneration: 1, runtime: 'claude', now: now0 });
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
  const r = acquireLease(root, runId, { owner: 'OTHER', expectGeneration: 1, runtime: 'claude', now: Date.parse('2099-01-01T00:00:00Z') });
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

  const r = acquireLease(root, runId, { owner: 'FRESH', expectGeneration: 1, runtime: 'claude' });
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

  const r = acquireLease(root, runId, { owner: 'NEW', expectGeneration: 1, runtime: 'claude' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-terminal');
});

test('terminal guard: completed run rejects acquireLease with run-terminal', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const { data: d0 } = readState(root, runId);
  d0.status = 'completed';
  writeState(root, runId, d0);

  const r = acquireLease(root, runId, { owner: 'NEW', expectGeneration: 1, runtime: 'claude' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-terminal');
});

test('regression: non-paused run acquire leaves status running, no spurious pause_reason write', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const r = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, runtime: 'claude' });
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
  const acq = acquireLease(root, runId, { owner: 'BYPASS', expectGeneration: 1, runtime: 'claude' });
  assert.equal(acq.ok, false);
  assert.ok(acq.reason !== 'acquired', 'paused run must not be re-acquired via bypassed release');
  // run status remains paused
  assert.equal(readState(root, runId).data.status, 'paused');
});

// ── v1.6 terminal guard (spec §2.1/§4-1) ─────────────────────────────────────
function makeTerminal(root, runId, status = 'completed') {
  const { data } = readState(root, runId);
  data.status = status;                    // writeState가 .loop.hash 앵커를 재계산
  writeState(root, runId, data);
}

test('leaseCheck: terminal run rejects EVERY intent with RUN_TERMINAL', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen = data.session_chain.lease.generation;
  const intents = ['business', 'lease', 'accounting', 'breaker-reset', 'recover', 'resume'];
  for (const status of ['completed', 'stopped']) {
    const loop = structuredClone(data);
    loop.status = status;
    for (const intent of intents) {
      assert.deepEqual(leaseCheck(loop, { owner, generation: gen, intent }),
        { ok: false, reason: 'RUN_TERMINAL' }, `${status}/${intent}`);
    }
    // terminal 게이트는 lease.state 게이트보다 앞 (spec r3 🟡3): released/releasing이어도 RUN_TERMINAL
    for (const ls of ['released', 'releasing']) {
      const l2 = structuredClone(loop);
      l2.session_chain.lease.state = ls;
      assert.equal(leaseCheck(l2, { owner, generation: gen, intent: 'business' }).reason, 'RUN_TERMINAL', `${status}/${ls}`);
    }
    // fence first: owner/generation 불일치가 terminal보다 우선
    assert.equal(leaseCheck(loop, { owner: 'other', generation: gen, intent: 'business' }).reason, 'owner-mismatch');
    assert.equal(leaseCheck(loop, { owner, generation: gen + 9, intent: 'business' }).reason, 'generation-mismatch');
  }
  // 비terminal 회귀: running/paused 기존 reason 불변
  assert.equal(leaseCheck(data, { owner, generation: gen, intent: 'business' }).ok, true);
  const paused = structuredClone(data); paused.status = 'paused';
  assert.equal(leaseCheck(paused, { owner, generation: gen, intent: 'business' }).reason, 'RUN_PAUSED');
  assert.equal(leaseCheck(paused, { owner, generation: gen, intent: 'recover' }).ok, true);
});

test('reserveHandoff / advanceHandoffPhase reject terminal runs (spec §2.3-1/3)', () => {
  const { root, runId } = seed();
  // running에서 reserve 성공 → finish 경합 재현
  const r1 = reserveHandoff(root, runId, { trigger: 't', now: Date.parse('2026-07-09T00:00:00Z') });
  assert.equal(r1.reserved, true);
  makeTerminal(root, runId, 'completed');
  assert.deepEqual(
    advanceHandoffPhase(root, runId, { key: r1.key, toPhase: 'emitted', now: Date.parse('2026-07-09T00:00:01Z') }),
    { ok: false, reason: 'RUN_TERMINAL' });
  const r2 = reserveHandoff(root, runId, { trigger: 't2', now: Date.parse('2026-07-09T00:00:02Z') });
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'RUN_TERMINAL'); assert.equal(r2.childRunId, null);
});

test('acquireLease: active-terminal rejects with run-terminal; generation fence-first preserved (spec §4-5f)', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen = data.session_chain.lease.generation;
  makeTerminal(root, runId, 'completed');   // lease는 active 그대로 (정상 finish 상태)
  // ① same-owner acquire → already-owned 위장 금지
  assert.equal(acquireLease(root, runId, { owner, expectGeneration: gen, runtime: 'claude' }).reason, 'run-terminal');
  // ② 타-owner + 올바른 generation → run-terminal
  assert.equal(acquireLease(root, runId, { owner: 'other-run', expectGeneration: gen, runtime: 'claude' }).reason, 'run-terminal');
  // ③ 타-owner + stale generation → generation-mismatch 우선 (fence-first)
  assert.equal(acquireLease(root, runId, { owner: 'other-run', expectGeneration: gen + 9, runtime: 'claude' }).reason, 'generation-mismatch');
  // 비terminal 회귀: same-owner active 멱등 불변
  const { root: r2, runId: run2 } = seed();
  assert.equal(acquireLease(r2, run2, { owner: run2, expectGeneration: 1, runtime: 'claude' }).reason, 'already-owned');
});

test('acquireLease checks runtime before same-owner idempotency', () => {
  const { root, runId } = seed();
  assert.deepEqual(
    acquireLease(root, runId, { owner: runId, expectGeneration: 1, runtime: 'codex' }),
    { ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex' },
  );
  assert.equal(
    acquireLease(root, runId, { owner: runId, expectGeneration: 1, runtime: 'claude' }).reason,
    'already-owned',
  );
});

test('acquireLease checks runtime before stale generation and paused unpause without mutating state', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.pause_reason = 'recovered:awaiting-resume';
  data.session_chain.lease.state = 'released';
  data.session_chain.lease.resume_policy = 'human';
  writeState(root, runId, data);
  const before = structuredClone(readState(root, runId).data);

  assert.deepEqual(
    acquireLease(root, runId, { owner: 'FRESH', expectGeneration: 99, runtime: 'codex' }),
    { ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex' },
  );
  const afterMismatch = readState(root, runId).data;
  assert.deepEqual(afterMismatch, before);
  assert.equal(afterMismatch.session_chain.lease.generation, before.session_chain.lease.generation);
  assert.equal(afterMismatch.status, before.status);
  assert.equal(afterMismatch.pause_reason, before.pause_reason);
  assert.equal(afterMismatch.session_chain.lease.resume_policy, before.session_chain.lease.resume_policy);

  assert.equal(
    acquireLease(root, runId, { owner: 'FRESH', expectGeneration: 99, runtime: 'claude' }).reason,
    'generation-mismatch',
  );
  assert.equal(readState(root, runId).data.status, 'paused');

  const acquired = acquireLease(root, runId, { owner: 'FRESH', expectGeneration: 1, runtime: 'claude' });
  assert.equal(acquired.reason, 'acquired');
  assert.equal(readState(root, runId).data.status, 'running');
});

test('acquireLease treats only Claude as matching a valid legacy runtime state', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  delete data.autonomy.session_runtime;
  delete data.autonomy.runtime_source;
  writeState(root, runId, data);
  releaseLease(root, runId, { owner: runId, generation: 1 });

  assert.deepEqual(
    acquireLease(root, runId, { owner: 'FRESH', expectGeneration: 1, runtime: 'codex' }),
    { ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex' },
  );
  const acquired = acquireLease(root, runId, {
    owner: 'FRESH', expectGeneration: 1, runtime: 'claude',
  });
  assert.equal(acquired.reason, 'acquired');
  assert.equal(readState(root, runId).data.session_chain.lease.owner_run_id, 'FRESH');
});

test('acquireLease rejects hash-valid malformed autonomy before a wrong-runtime takeover and mutates nothing', () => {
  for (const autonomy of [null, [], 'invalid', 1, true]) {
    const { root, runId } = seed('codex');
    releaseLease(root, runId, { owner: runId, generation: 1 });
    const { data } = readState(root, runId);
    data.autonomy = autonomy;
    writeHashValidState(root, runId, data);

    const dir = runDir(root, runId);
    const beforeLoop = readFileSync(join(dir, 'loop.json'), 'utf8');
    const beforeHash = readFileSync(join(dir, '.loop.hash'), 'utf8');
    const eventPath = join(dir, 'event-log.jsonl');
    const beforeEvents = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null;

    assert.throws(
      () => acquireLease(root, runId, {
        owner: 'CLAUDE-OWNER', expectGeneration: 1, runtime: 'claude',
      }),
      /INVALID_RUNTIME_STATE: autonomy must be object/,
      `acquireLease accepted autonomy=${JSON.stringify(autonomy)}`,
    );
    const afterLoop = readFileSync(join(dir, 'loop.json'), 'utf8');
    assert.equal(afterLoop, beforeLoop);
    assert.equal(readFileSync(join(dir, '.loop.hash'), 'utf8'), beforeHash);
    assert.equal(existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null, beforeEvents);
    const after = JSON.parse(afterLoop);
    assert.equal(after.session_chain.lease.owner_run_id, runId);
    assert.equal(after.session_chain.lease.generation, 1);
    assert.equal(after.session_chain.lease.state, 'released');
    assert.equal(after.status, 'running');
  }
});
