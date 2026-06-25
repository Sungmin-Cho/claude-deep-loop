import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease, advanceHandoffPhase, releaseLease } from '../scripts/lib/lease.mjs';
import { respawn, respawnGate } from '../scripts/lib/respawn.mjs';

const NOW0 = new Date('2026-06-24T00:00:00Z');
const NOW1 = Date.parse('2026-06-24T01:00:00Z');

// 자기완결 seed: run 생성 후 mutate(loop)로 필요한 필드만 조정하고 writeState.
function seed(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: NOW0 });
  if (mutate) { const { data } = readState(root, runId); mutate(data); writeState(root, runId, data); }
  return { root, runId };
}

function expect_(runId) { return { owner: runId, generation: 1 }; }

test('respawnGate: total sessions may reach max_sessions but not exceed (off-by-one, Codex r3 🟡6)', () => {
  // 경계: sessions.length == max_sessions (pending child 가 max 번째) → 허용
  const ok = seed((d) => { d.autonomy.max_sessions = 2; d.session_chain.sessions = [{ run_id: 'a' }, { run_id: 'b' }]; });
  assert.equal(respawnGate(readState(ok.root, ok.runId).data, { now: NOW1 }).blocked_by.includes('max_sessions'), false);
  // 초과: sessions.length > max_sessions → 차단
  const over = seed((d) => { d.autonomy.max_sessions = 1; d.session_chain.sessions = [{ run_id: 'a' }, { run_id: 'b' }]; });
  const r = respawnGate(readState(over.root, over.runId).data, { now: NOW1 });
  assert.equal(r.ok, false);
  assert.ok(r.blocked_by.includes('max_sessions'));
});

test('respawn gate-blocked (budget) → paused, no spawn, lease stays emitted (mode A)', () => {
  // Codex r1 🟡7: budget.spent 를 변조하면 respawn 의 reconcileBudget 가 BUDGET_TAMPERED 로 throw.
  // 대신 total=0 으로 만들어 stored/log 불일치 없이 hard-stop(spent 0 >= 0) 을 유발한다.
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let called = false;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => { called = true; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'gate-blocked');
  assert.equal(called, false);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('respawn launch failure → failed_launch outcome + lease rollback (mode B)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => { throw new Error('launch boom'); } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.state, 'active');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === h.childRunId).outcome, 'failed_launch');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === runId).superseded_by, null);
});

// Codex impl r8 🟡: a valid key must not spawn an arbitrary (unreserved) child.
test('respawn rejects childRunId that does not match the reserved handoff child (no spawn, no phase advance)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, { childRunId: 'WRONG-CHILD', key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => { spawned = true; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'child-mismatch');
  assert.equal(spawned, false);
  const after = readState(root, runId).data.session_chain.lease;
  assert.equal(after.handoff_phase, 'emitted');   // no advance to spawned
  assert.equal(after.state, 'releasing');
});

test('respawn success → spawned, lease released, child can acquire (generation+1); retry is idempotent', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const cmds = [];
  const spawnFn = (cmd) => { cmds.push(cmd); return { ok: true }; };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], new RegExp(`\\.deep-loop/runs/${runId}/`));  // 부모 경로 참조 (🔴3)
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
  assert.equal(after.session_chain.lease.state, 'released');
  // Codex r1 🔴2: 같은 respawn 재시도는 already-spawned no-op (이중 spawn 금지)
  const retry = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
  assert.equal(retry.outcome, 'already-spawned');
  assert.equal(cmds.length, 1);
  const a = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 });
  assert.equal(a.ok, true);
  assert.equal(a.generation, 2);
});

// Codex impl r9 🔴: a RELEASED handoff lease may be acquired ONLY by the reserved child (before stale TTL).
test('released handoff lease is acquirable only by the reserved child (non-reserved child fenced)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => ({ ok: true }) });
  // wrong child cannot acquire the released lease before stale TTL
  const wrong = acquireLease(root, runId, { owner: 'WRONG-CHILD', expectGeneration: 1, now: NOW1 });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'child-not-reserved');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_child_run_id, h.childRunId);  // binding intact
  // reserved child acquires (generation+1)
  const ok = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
});

// Codex r2 🔴3: 외부 spawn 전 원자적 클레임이 동시 호출의 이중 spawn 을 막는지.
// spawnFn 안에서 같은 respawn 을 재진입(=동시 호출 시뮬레이션): 첫 호출이 이미 spawned 로 클레임했으므로 둘째는 spawn 안 함.
test('respawn claims atomically before external spawn → concurrent re-entry does not double-spawn', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawns = 0; let reentered = null;
  const spawnFn = (cmd) => {
    spawns++;
    if (spawns === 1) reentered = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
    return { ok: true };
  };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(spawns, 1);                       // 재진입 호출은 외부 spawn 을 추가 실행하지 않음
  assert.equal(reentered.outcome, 'already-spawned');
});

// Codex r3 🔴2: claim(spawned) 후 release 전 크래시는 **영구 stranded 가 아니다** — releasing+expired 로 successor 인수 복구.
test('crash after spawned-claim recovers via stale-TTL acquire (not permanently stranded)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });   // expires_at = NOW1 + 900s
  advanceHandoffPhase(root, runId, { key: h.key, toPhase: 'spawned', now: NOW1 });   // claim 만(=respawn 이 release 전 크래시)
  const st = readState(root, runId).data.session_chain.lease;
  assert.equal(st.handoff_phase, 'spawned');
  assert.equal(st.state, 'releasing');
  // TTL 경과 전: 인수 불가
  assert.equal(acquireLease(root, runId, { owner: 'RESUME', expectGeneration: 1, now: NOW1 + 1000 }).ok, false);
  // TTL(900s) 경과 후: releasing+expired → 인수 복구
  const a = acquireLease(root, runId, { owner: 'RESUME', expectGeneration: 1, now: NOW1 + 901 * 1000 });
  assert.equal(a.ok, true);
  assert.equal(a.generation, 2);
});

// Codex r1 🟡8: 동시 다발 실패 시 게이트 순서(budget→breaker→max_sessions→wallclock) 보고가 일관적인지.
test('respawnGate reports documented order; wallclock not mislabeled as budget', () => {
  const { root, runId } = seed((d) => {
    d.autonomy.max_sessions = 1; d.session_chain.sessions = [{ run_id: 'a' }, { run_id: 'b' }];
    d.budget.max_wallclock_sec = 1;            // created_at(NOW0) 기준 NOW1 은 1h 경과 → wallclock 초과
  });
  const r = respawnGate(readState(root, runId).data, { now: NOW1 });
  assert.equal(r.ok, false);
  assert.ok(r.blocked_by.includes('max_sessions'));
  assert.ok(r.blocked_by.includes('wallclock'));
  assert.equal(r.blocked_by.includes('budget'), false);  // wallclock 이 budget 으로 오분류되지 않음
});

// Fix 2: spawnFn bumps the lease generation (simulates child acquiring mid-spawn), then throws.
// respawn must return outcome='fenced', NOT mark the active child as failed_launch or corrupt the lease.
test('respawn: lease stolen during spawnFn → fenced outcome, child lease not corrupted', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const CHILD = h.childRunId;
  let spawnCalled = false;
  const spawnFn = () => {
    spawnCalled = true;
    // Simulate: child acquires the lease (parent releases + child acquire bumps gen to 2) THEN spawn fails
    releaseLease(root, runId, { owner: runId, generation: 1 });
    acquireLease(root, runId, { owner: CHILD, expectGeneration: 1, now: NOW1 });
    throw new Error('external-spawn-failed-after-acquire');
  };
  const r = respawn(root, runId, { childRunId: CHILD, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
  assert.equal(spawnCalled, true);
  // Must return fenced outcome (not failed_launch) because the child already owns the lease
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fenced');
  // Child's lease must be active and NOT marked failed_launch
  const after = readState(root, runId).data;
  const lease = after.session_chain.lease;
  assert.equal(lease.owner_run_id, CHILD);
  assert.equal(lease.state, 'active');
  assert.equal(lease.generation, 2);
  // Child session must NOT be marked failed_launch (it is actively running)
  const childSession = after.session_chain.sessions.find(s => s.run_id === CHILD);
  assert.notEqual(childSession?.outcome, 'failed_launch');
});

// Codex r5 🔴1: gate-blocked pause write fenced — if the lease is taken over between emitHandoff and
// respawn (parent releases + child acquires), respawn must return 'fenced' and NOT set status='paused'.
test('respawn gate-blocked with lease takeover before pause → fenced, status NOT paused', () => {
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const CHILD = h.childRunId;
  // Simulate takeover: parent releases, child acquires → generation advances to 2
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: CHILD, expectGeneration: 1, now: NOW1 });
  // Now call respawn as the original parent (runId, gen 1) — gate-blocked but lease has changed
  const r = respawn(root, runId, { childRunId: CHILD, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => { return { ok: true }; } });
  assert.equal(r.ok, false);
  // After Fix 1: owner-mismatch check removed; key is nulled by acquireLease → key-mismatch fires (still a fencing outcome).
  assert.ok(r.outcome === 'fenced' || r.outcome === 'key-mismatch', 'must return a fencing outcome when lease changed before pause write');
  const after = readState(root, runId).data;
  assert.notEqual(after.status, 'paused', 'status must NOT be paused when fenced');
});

// respawn race (§14 test 12): Continue↔PreCompact 동시 트리거 → 멱등키로 emit 1회
test('double emit + single respawn (race): only one child chain, no double spawn', () => {
  const { root, runId } = seed();
  const ex = expect_(runId);
  const a = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: ex });
  const b = emitHandoff(root, runId, { trigger: 'precompact', now: NOW1, expect: ex });   // no-op
  assert.equal(a.ok, true); assert.equal(b.ok, false);
  let spawns = 0;
  const r1 = respawn(root, runId, { childRunId: a.childRunId, key: a.key, handoffRel: a.handoffRel, now: NOW1, spawnFn: () => { spawns++; return { ok: true }; } });
  assert.equal(r1.ok, true);
  assert.equal(spawns, 1);
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});

test('a child owner can emit a second handoff and respawn (multi-session, Fix 1)', () => {
  const { root, runId } = seed();
  const NOWa = Date.parse('2026-06-24T00:01:00Z'), NOWb = Date.parse('2026-06-24T00:02:00Z');
  const h1 = emitHandoff(root, runId, { trigger: 'm1', now: NOWa, expect: { owner: runId, generation: 1 } });
  respawn(root, runId, { childRunId: h1.childRunId, key: h1.key, handoffRel: h1.handoffRel, headless: true, now: NOWa, spawnFn: () => ({ ok: true }) });
  acquireLease(root, runId, { owner: h1.childRunId, expectGeneration: 1, now: NOWa });   // child owns, generation 2
  const h2 = emitHandoff(root, runId, { trigger: 'm2', now: NOWb, expect: { owner: h1.childRunId, generation: 2 } });
  assert.equal(h2.ok, true);
  const r2 = respawn(root, runId, { childRunId: h2.childRunId, key: h2.key, handoffRel: h2.handoffRel, headless: true, now: NOWb, spawnFn: () => ({ ok: true }) });
  assert.equal(r2.ok, true);
  assert.equal(r2.outcome, 'spawned');
  assert.equal(readState(root, runId).data.session_chain.sessions.find(s => s.run_id === h1.childRunId).superseded_by, h2.childRunId);
});

test('child can acquire the lease after a headless respawn releases it (Fix 2)', () => {
  const { root, runId } = seed();
  const NOWa = Date.parse('2026-06-24T00:01:00Z'), NOWb = Date.parse('2026-06-24T00:02:00Z');
  const h = emitHandoff(root, runId, { trigger: 'm', now: NOWa, expect: { owner: runId, generation: 1 } });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOWa, spawnFn: () => ({ ok: true }) });
  assert.equal(r.outcome, 'spawned');
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'released');
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOWb });
  assert.equal(acq.ok, true); assert.equal(acq.generation, 2);
});
