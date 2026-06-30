import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDir } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease, advanceHandoffPhase, releaseLease } from '../scripts/lib/lease.mjs';
import { respawn, respawnGate, resolveSpawnMode, isHeadlessInvocation } from '../scripts/lib/respawn.mjs';

const NOW0 = new Date('2026-06-24T00:00:00Z');
const NOW1 = Date.parse('2026-06-24T01:00:00Z');

// Inject no-signal env + no-op run so detect-terminal is deterministic regardless of ambient env.
const noOpRun = () => ({ code: 1 });

// 자기완결 seed: run 생성 후 mutate(loop)로 필요한 필드만 조정하고 writeState.
function seed(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: NOW0, env: {}, platform: 'linux', run: noOpRun });
  if (mutate) { const { data } = readState(root, runId); mutate(data); writeState(root, runId, data); }
  return { root, runId };
}

// seed a run with a concrete visible launcher (cmux by default) + spawn_style.
function seedLauncher({ spawn_style = 'visible', launcher = 'cmux' } = {}) {
  return seed((d) => {
    d.autonomy.spawn_style = spawn_style;
    d.session_spawn = {
      platform: 'darwin', launcher,
      launcher_bin: '/abs/bin/' + launcher, launcher_socket: '/tmp/' + launcher + '.sock',
      surface: 'multiplexer', reachable: true, visible: true, signals: {}, probe: null,
      reason: 'detected', fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00Z',
    };
  });
}

function expect_(runId) { return { owner: runId, generation: 1 }; }

// Sequence helper for fake pollLease — returns successive values, last value sticks after exhaustion.
function seq(values) { let i = 0; return () => values[Math.min(i++, values.length - 1)]; }
const noSleep = () => {};

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

// R4-plan: phantom failed-launch sessions (never acquired) must NOT consume max_sessions slots.
test('respawnGate excludes failed_launch sessions from max_sessions (R4-plan, no phantom exhaustion)', () => {
  // 5 sessions but 4 are failed_launch phantoms → live count = 1 → not blocked even at max_sessions=1
  const { root, runId } = seed((d) => {
    d.autonomy.max_sessions = 1;
    d.session_chain.sessions = [
      { run_id: 'live', outcome: null },
      { run_id: 'p1', outcome: 'failed_launch' },
      { run_id: 'p2', outcome: 'failed_launch' },
      { run_id: 'p3', outcome: 'failed_launch' },
      { run_id: 'p4', outcome: 'failed_launch' },
    ];
  });
  const r = respawnGate(readState(root, runId).data, { now: NOW1 });
  assert.equal(r.blocked_by.includes('max_sessions'), false, 'phantom failed_launch sessions must not exhaust max_sessions');
});

// ── mode selection (resolveSpawnMode / isHeadlessInvocation, spec §7) ───────────

test('isHeadlessInvocation: concrete markers true; interactive/markerless false', () => {
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_UNATTENDED: '1' }), true);
  assert.equal(isHeadlessInvocation({ DEEP_LOOP_HEADLESS: 'true' }), true);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'sdk-py' }), true);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'print' }), true);
  assert.equal(isHeadlessInvocation({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), false);   // interactive TUI
  assert.equal(isHeadlessInvocation({}), false);                                  // markerless
  assert.equal(isHeadlessInvocation(null), false);
});

test('resolveSpawnMode: precedence (headless flag / spawn_style / invocation > visible launcher > interactive)', () => {
  const vis = readState(...Object.values(seedLauncher({ spawn_style: 'visible', launcher: 'cmux' }))).data;
  // explicit headless flag wins
  assert.equal(resolveSpawnMode(vis, { headless: true, attended: true, env: {} }), 'headless');
  // visible + attended + launcher → launcher
  assert.equal(resolveSpawnMode(vis, { headless: false, attended: true, env: {} }), 'cmux');
  // visible but NOT attended → interactive (no auto-spawn)
  assert.equal(resolveSpawnMode(vis, { headless: false, attended: false, env: {} }), 'interactive');
  // spawn_style headless wins over launcher+attended
  const hl = readState(...Object.values(seedLauncher({ spawn_style: 'headless', launcher: 'cmux' }))).data;
  assert.equal(resolveSpawnMode(hl, { headless: false, attended: true, env: {} }), 'headless');
});

test('spawn_style!=visible → no visible spawn even with launcher present (mode interactive → no-launcher)', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'interactive', launcher: 'cmux' });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => { throw new Error('should not spawn'); }, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  // handoff PRESERVED (not rolled back) — the skill pauses via `deep-loop pause --mode preserve`
  const after = readState(root, runId).data.session_chain.lease;
  assert.equal(after.handoff_phase, 'emitted');
  assert.equal(after.handoff_child_run_id, h.childRunId);
});

test('markerless env + no launcher + not attended → interactive → no-launcher (fail-closed to pause)', () => {
  const { root, runId } = seed();   // launcher 'none' (linux + noOpRun); spawn_style 'visible' default
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'none');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: false, env: {}, now: NOW1, spawnFn: () => { throw new Error('should not spawn'); }, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
});

test('isHeadlessInvocation true → headless mode even with launcher + attended (and respawn skips readiness poll)', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  const env = { DEEP_LOOP_UNATTENDED: '1' };
  // even visible + attended + launcher, a headless-invocation env forces headless
  assert.equal(resolveSpawnMode(readState(root, runId).data, { headless: false, attended: true, env }), 'headless');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let polled = 0;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env, now: NOW1, spawnFn: () => ({ ok: true }), pollLease: () => { polled++; return { state: 'releasing' }; }, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(polled, 0, 'headless mode must NOT poll for child-readiness');
});

test('spawn_style=headless without --headless flag → headless mode (measured path), no readiness poll', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'headless', launcher: 'cmux' });
  // resolved mode is headless → CLI selects headlessSpawn (measured), not visibleSpawn
  assert.equal(resolveSpawnMode(readState(root, runId).data, { headless: false, attended: true, env: {} }), 'headless');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let polled = 0;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease: () => { polled++; return { state: 'releasing' }; }, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(polled, 0, 'headless mode keeps the synchronous measured path (no poll)');
});

// ── visible bounded child-readiness handshake (R1-B / R10-DD / R6-U) ────────────

test('visible + attended + launcher: spawnFn gets cmds[launcher] (bin+socket threaded); child acquires → success', () => {
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let got;
  const spawnFn = (e) => { got = e; return { ok: true }; };
  const pollLease = seq([{ state: 'releasing', owner_run_id: runId, generation: 1 }, { state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 }]);
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn, pollLease, sleep: noSleep });
  assert.equal(got.bin, '/abs/bin/cmux', 'cmux entry bin === session_spawn.launcher_bin (R3/R7-plan)');
  assert.ok(got.argv.includes('--socket'), 'cmux argv must thread --socket');
  assert.ok(got.argv.includes('/tmp/cmux.sock'), 'cmux argv must thread session_spawn.launcher_socket');
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  // launch-command.txt (written at emit) must also show the threaded bin + socket (not bare cmux/default socket).
  const lc = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.ok(lc.includes('/abs/bin/cmux'), 'launch-command.txt cmux line must use the absolute launcher_bin');
  assert.ok(lc.includes('/tmp/cmux.sock'), 'launch-command.txt cmux line must thread the launcher_socket');
});

test('child-readiness timeout → PRESERVE (reserved child kept, late acquire safe) — R6-plan', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const pollLease = () => ({ state: 'releasing', owner_run_id: runId, generation: 1 });   // never acquires
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'child-timeout-awaiting');
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.pause_reason, 'child-timeout-awaiting');
  assert.equal(d.session_chain.lease.handoff_child_run_id, h.childRunId);   // NOT invalidated
  assert.equal(d.session_chain.lease.resume_policy, 'human');
  assert.equal(d.session_chain.lease.expires_at, null);
  assert.equal(d.session_chain.lease.state, 'releasing');                    // preserved (acquirable by reserved child)
});

test('child acquires AFTER the timeout window → still succeeds (R6-plan late acquire + Task 8 unpause)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  // 1) readiness timeout → PRESERVE (paused, reserved child kept)
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease: () => ({ state: 'releasing', owner_run_id: runId, generation: 1 }), sleep: noSleep });
  assert.equal(r.outcome, 'child-timeout-awaiting');
  assert.equal(readState(root, runId).data.status, 'paused');
  // 2) a LATE /deep-loop-resume by the reserved child acquires the still-releasing lease (Task 8) → unpauses
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 + 5000 });
  assert.equal(acq.ok, true);
  assert.equal(acq.generation, 2);
  assert.equal(readState(root, runId).data.status, 'running', 'late child acquire must unpause the run');
});

test('visible launch FAILURE (exit≠0) → rollback AND paused (child never started, invalidated)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: false, reason: 'launch-exit-1' }), pollLease: () => ({ state: 'releasing' }), sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.pause_reason, 'launch-failed');
  assert.equal(d.session_chain.lease.handoff_child_run_id, null);   // invalidated (definitive failure)
  assert.equal(d.session_chain.lease.state, 'active');
  assert.equal(d.session_chain.lease.handoff_phase, 'idle');
  assert.equal(d.session_chain.sessions.find(s => s.run_id === h.childRunId).outcome, 'failed_launch');
});

test('fast child already acquired before poll → success not fenced (R6-U)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const pollLease = () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
});

// R6-U stronger: the reserved child actually acquires the REAL lease during spawnFn, BEFORE the parent
// records respawn-spawned → the parent fence fails but it is the reserved child → SUCCESS, not fenced.
test('fast child acquires real lease during spawnFn (before respawn-spawned record) → success not fenced (R6-U)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const spawnFn = () => {
    acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 });   // ultra-fast handshake
    return { ok: true };
  };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn, pollLease: () => readState(root, runId).data.session_chain.lease, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.owner_run_id, h.childRunId);
  assert.equal(lease.generation, 2);
});

test('generation change to a NON-reserved owner during readiness poll → fenced (real fence)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const pollLease = seq([{ state: 'releasing', owner_run_id: runId, generation: 1 }, { state: 'active', handoff_phase: 'acquired', owner_run_id: 'OTHER', generation: 2 }]);
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => ({ ok: true }), pollLease, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fenced');
});

// ── gate-blocked + headless paths (existing tests, adapted to mode params) ──────

test('respawn gate-blocked (budget) → rollback + paused, no spawn (mode A; R12-LL rollback)', () => {
  // Codex r1 🟡7: budget.spent 변조는 reconcileBudget 가 BUDGET_TAMPERED 로 throw → total=0 으로 hard-stop 유발.
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let called = false;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => { called = true; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'gate-blocked');
  assert.equal(called, false);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.match(after.pause_reason, /^gate:/);
  // R12-LL: gate-blocked now ROLLS BACK the reserved handoff (was: stays emitted)
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.state, 'active');
  assert.equal(after.session_chain.lease.handoff_child_run_id, null);
});

test('respawn launch failure (throw) → failed_launch + lease rollback + paused (mode B)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => { throw new Error('launch boom'); } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'launch-failed');
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

test('respawn success → spawned (headless), lease stays releasing, child can acquire via handshake; retry idempotent', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const entries = [];
  const spawnFn = (entry) => { entries.push(entry); return { ok: true }; };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(entries.length, 1);
  // headless entry display references parent run dir (🔴3)
  assert.match(entries[0].display, new RegExp(`\\.deep-loop/runs/${runId}/`));
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
  // Fix 2: lease stays 'releasing' — child acquires via handshake
  assert.equal(after.session_chain.lease.state, 'releasing');
  // Codex r1 🔴2: 같은 respawn 재시도는 already-spawned no-op (이중 spawn 금지)
  const retry = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(retry.outcome, 'already-spawned');
  assert.equal(entries.length, 1);
  // Child acquires the releasing lease via handshake (not released — acquiring 'releasing' directly)
  const a = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 });
  assert.equal(a.ok, true);
  assert.equal(a.generation, 2);
});

// Fix 2: After respawn, lease stays 'releasing'. Wrong child cannot acquire (not the reserved child, not expired).
test('releasing handoff lease is acquirable only by the reserved child (non-reserved child fenced)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => ({ ok: true }) });
  const wrong = acquireLease(root, runId, { owner: 'WRONG-CHILD', expectGeneration: 1, now: NOW1 });
  assert.equal(wrong.ok, false);
  assert.ok(['child-not-reserved', 'lease-not-takeable'].includes(wrong.reason));
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_child_run_id, h.childRunId);  // binding intact
  const ok = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
});

// Codex r2 🔴3: 외부 spawn 전 원자적 클레임이 동시 호출의 이중 spawn 을 막는지.
test('respawn claims atomically before external spawn → concurrent re-entry does not double-spawn', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawns = 0; let reentered = null;
  const spawnFn = () => {
    spawns++;
    if (spawns === 1) reentered = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
    return { ok: true };
  };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(spawns, 1);                       // 재진입 호출은 외부 spawn 을 추가 실행하지 않음
  assert.equal(reentered.outcome, 'already-spawned');
});

// Codex r3 🔴2: claim(spawned) 후 release 전 크래시는 영구 stranded 가 아니다 — releasing+expired 로 successor 인수 복구.
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
    releaseLease(root, runId, { owner: runId, generation: 1 });
    acquireLease(root, runId, { owner: CHILD, expectGeneration: 1, now: NOW1 });
    throw new Error('external-spawn-failed-after-acquire');
  };
  const r = respawn(root, runId, { childRunId: CHILD, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn });
  assert.equal(spawnCalled, true);
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'fenced');
  const after = readState(root, runId).data;
  const lease = after.session_chain.lease;
  assert.equal(lease.owner_run_id, CHILD);
  assert.equal(lease.state, 'active');
  assert.equal(lease.generation, 2);
  const childSession = after.session_chain.sessions.find(s => s.run_id === CHILD);
  assert.notEqual(childSession?.outcome, 'failed_launch');
});

// Codex r5 🔴1: gate-blocked pause write fenced — lease taken over between emit and respawn.
test('respawn gate-blocked with lease takeover before pause → fenced, status NOT paused', () => {
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const CHILD = h.childRunId;
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: CHILD, expectGeneration: 1, now: NOW1 });
  const r = respawn(root, runId, { childRunId: CHILD, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => ({ ok: true }) });
  assert.equal(r.ok, false);
  // owner-mismatch check removed; key is nulled by acquireLease → key-mismatch fires (still a fencing outcome).
  assert.ok(r.outcome === 'fenced' || r.outcome === 'key-mismatch', 'must return a fencing outcome when lease changed before pause write');
  const after = readState(root, runId).data;
  assert.notEqual(after.status, 'paused', 'status must NOT be paused when fenced');
});

// ── codex r5 finding A (HIGH): already-spawned re-entry must VERIFY child acquisition ───────────
// CAS-before-spawn ordering means handoff_phase==='spawned' is only the CAS claim, NOT proof the child
// launched + took over. A prior call may have crashed AFTER the CAS, before/during the external spawn.
// The idempotent re-entry must therefore verify child acquisition and recover (bounded wait → preserve-
// pause) instead of returning a false 'already-spawned' success that strands the handoff with no
// autonomous recovery. Re-spawn is NEVER done on this path (the CAS double-spawn guard must hold).

test('already-spawned re-entry, child NEVER acquires (visible) → bounded wait then preserve-pause, no re-spawn (codex-r5a)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  // Simulate a prior respawn that did the emitted→spawned CAS then crashed before/during the external spawn.
  advanceHandoffPhase(root, runId, { key: h.key, toPhase: 'spawned', now: NOW1 });
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'spawned');
  // Reserved child never acquires (poll always shows the parent still releasing). spawnFn must NOT be re-called.
  const pollLease = () => ({ state: 'releasing', owner_run_id: runId, generation: 1 });
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, sleep: noSleep, pollLease,
    spawnFn: () => { throw new Error('must NOT re-spawn on the already-spawned path (CAS double-spawn guard)'); },
  });
  // NOT a bare already-spawned success — it waited to the deadline then preserve-paused (autonomous-detectable).
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'spawn-unconfirmed-awaiting');
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.equal(d.session_chain.lease.handoff_child_run_id, h.childRunId, 'reserved child preserved (not invalidated)');
  assert.equal(d.session_chain.lease.resume_policy, 'human');
  assert.equal(d.session_chain.lease.expires_at, null);
  assert.equal(d.session_chain.lease.state, 'releasing', 'lease still releasing → reserved child can still acquire');
  // Task 8 late-acquire: a subsequent reserved-child acquireLease STILL succeeds + unpauses.
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 + 5000 });
  assert.equal(acq.ok, true);
  assert.equal(acq.generation, 2);
  assert.equal(readState(root, runId).data.status, 'running', 'late reserved-child acquire must unpause');
});

test('already-spawned re-entry where the child HAS acquired → already-spawned immediately, no false pause (codex-r5a)', () => {
  const { root, runId } = seedLauncher();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  advanceHandoffPhase(root, runId, { key: h.key, toPhase: 'spawned', now: NOW1 });
  // Lease already shows the reserved child acquired (a prior call genuinely spawned + the child took over).
  const pollLease = () => ({ state: 'active', handoff_phase: 'acquired', owner_run_id: h.childRunId, generation: 2 });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1, sleep: noSleep, pollLease,
    spawnFn: () => { spawned = true; return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'already-spawned');
  assert.equal(spawned, false, 'must NOT re-spawn when the child already acquired');
  assert.notEqual(readState(root, runId).data.status, 'paused', 'genuine already-spawned must not pause');
});

// respawn race (§14 test 12): Continue↔PreCompact 동시 트리거 → 멱등키로 emit 1회
test('double emit + single respawn (race): only one child chain, no double spawn', () => {
  const { root, runId } = seed();
  const ex = expect_(runId);
  const a = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: ex });
  const b = emitHandoff(root, runId, { trigger: 'precompact', now: NOW1, expect: ex });   // no-op
  assert.equal(a.ok, true); assert.equal(b.ok, false);
  let spawns = 0;
  const r1 = respawn(root, runId, { childRunId: a.childRunId, key: a.key, handoffRel: a.handoffRel, headless: true, now: NOW1, spawnFn: () => { spawns++; return { ok: true }; } });
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

test('child can acquire the releasing lease after a headless respawn via handshake (Fix 2)', () => {
  const { root, runId } = seed();
  const NOWa = Date.parse('2026-06-24T00:01:00Z'), NOWb = Date.parse('2026-06-24T00:02:00Z');
  const h = emitHandoff(root, runId, { trigger: 'm', now: NOWa, expect: { owner: runId, generation: 1 } });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOWa, spawnFn: () => ({ ok: true }) });
  assert.equal(r.outcome, 'spawned');
  // Fix 2: lease stays 'releasing' — child acquires via handshake
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOWb });
  assert.equal(acq.ok, true); assert.equal(acq.generation, 2);
});

// Codex r3 🔴3: buildLaunchCommand throw must happen BEFORE spawned CAS — lease stays emitted.
test('respawn: buildLaunchCommand throw (unsafe handoffRel) must not advance lease to spawned (codex-medium)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  // Blank the child session's handoff_rel so effHandoffRel falls back to the respawn arg.
  { const { data } = readState(root, runId); const cs = data.session_chain.sessions.find(s => s.run_id === h.childRunId); if (cs) cs.handoff_rel = null; writeState(root, runId, data); }
  // Pass unsafe/empty handoffRel (fails SAFE_HANDOFF_REL → buildLaunchCommand throws UNSAFE_SPAWN_ARG).
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: '', headless: true, now: NOW1, spawnFn: () => { throw new Error('must not reach spawnFn'); } });
  // Lease MUST NOT have advanced to 'spawned' (must be emitted/releasing — re-tryable, not stranded).
  const lease = readState(root, runId).data.session_chain.lease;
  assert.notEqual(lease.handoff_phase, 'spawned', 'buildLaunchCommand throw must happen before spawned CAS');
  assert.equal(lease.state, 'releasing', 'lease must stay releasing (emitted, re-tryable)');
  assert.equal(lease.handoff_phase, 'emitted', 'lease must stay emitted when build throws before CAS');
  assert.equal(r.ok, false, 'respawn must return ok:false on build error');
});

// RUN_PAUSED gate: respawn on a paused run returns {ok:false, outcome:'paused'} (Task 6).
test('respawn on a paused run returns paused (RUN_PAUSED precondition)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  { const { data } = readState(root, runId); data.status = 'paused'; writeState(root, runId, data); }
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, headless: true, now: NOW1, spawnFn: () => { throw new Error('should not spawn'); } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'paused');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

// R12-LL regression: gate-blocked + no-launcher → gate WINS (rollback), not 'no-launcher' (preserve).
// Before the fix, mode selection fired before respawnGate so a no-launcher run returned 'no-launcher'
// and kept the reserved child alive — bypassing the gate. After the fix, gate is evaluated first.
test('R12-LL: gate-blocked + no-launcher → gate wins, reserved child rolled back (not preserved)', () => {
  // budget.total=0 → gate blocks; default linux+noOpRun seed → launcher='none', attended=false → no-launcher
  // IF mode were checked first (old bug). After fix, gate fires first → rollback.
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'none', 'seed must have no launcher');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: false, env: {}, now: NOW1,
    spawnFn: () => { spawned = true; return { ok: true }; },
    sleep: noSleep,
  });

  // Gate MUST win: outcome is 'gate-blocked', not 'no-launcher'
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'gate-blocked', 'gate-blocked must win over no-launcher (R12-LL)');
  assert.equal(spawned, false, 'spawnFn must not be called when gate blocks');

  // Reserved child MUST be invalidated (rollback, not preserve)
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused');
  assert.match(d.pause_reason, /^gate:/, 'pause_reason must start with gate:');
  assert.equal(d.session_chain.lease.handoff_child_run_id, null, 'handoff_child_run_id must be cleared (invalidated)');
  assert.equal(d.session_chain.lease.state, 'active', 'lease state must roll back to active');
  assert.equal(d.session_chain.lease.handoff_phase, 'idle', 'handoff_phase must roll back to idle');
  const childSession = d.session_chain.sessions.find(s => s.run_id === h.childRunId);
  assert.equal(childSession.outcome, 'failed_launch', 'child session outcome must be failed_launch (invalidated)');
  const parentSession = d.session_chain.sessions.find(s => s.run_id === runId);
  assert.equal(parentSession.superseded_by, null, 'parent superseded_by must be cleared');

  // Gate must NOT be bypassed: the old reserved child cannot acquire the now-active lease
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 + 1000 });
  assert.equal(acq.ok, false, 'old child must not be able to acquire after gate-blocked rollback');
});

// R12-LL companion: gate-OK + no-launcher → 'no-launcher' with reserved child PRESERVED (needs-human).
// Proves the two paths are correctly distinguished after the gate-before-mode reorder.
test('R12-LL: gate-OK + no-launcher → no-launcher outcome, reserved child preserved (needs-human)', () => {
  // Default seed: gate passes (budget.total=200, auto_handoff=true, etc.); launcher='none', attended=false
  const { root, runId } = seed();
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'none', 'seed must have no launcher');
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: false, env: {}, now: NOW1,
    spawnFn: () => { throw new Error('should not spawn'); },
    sleep: noSleep,
  });

  // Gate passes → mode='interactive' → no-launcher (correct: genuine needs-human)
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher', 'gate-OK + no-launcher must return no-launcher (not gate-blocked)');

  // Reserved child MUST be PRESERVED (not rolled back): skill pauses via `deep-loop pause --mode preserve`
  const d = readState(root, runId).data;
  assert.equal(d.session_chain.lease.handoff_child_run_id, h.childRunId, 'handoff_child_run_id must be preserved');
  assert.equal(d.session_chain.lease.handoff_phase, 'emitted', 'handoff_phase must stay emitted');
  assert.equal(d.session_chain.lease.state, 'releasing', 'lease state must stay releasing');
  assert.notEqual(d.status, 'paused', 'status must NOT be paused (skill handles pause-mode-preserve separately)');
});

// ── B3: unavailable PowerShell entry (no trusted launcher_bin) routes to no-launcher (plan-ADV6) ──
test('B3: powershell launcher with null launcher_bin → no-launcher (preserve), never spawns', () => {
  const { root, runId } = seed((d) => {
    d.autonomy.spawn_style = 'visible';
    d.session_spawn = {
      platform: 'win32', launcher: 'powershell', launcher_bin: null, launcher_socket: null,
      surface: 'window', reachable: true, visible: true, signals: {}, probe: null,
      reason: null, fallback: 'launch-command-file', detected_at: '2026-06-24T00:00:00Z',
    };
  });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: expect_(runId) });
  let spawned = false;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, attended: true, env: {}, now: NOW1, spawnFn: () => { spawned = true; return { ok: true }; }, sleep: noSleep });
  assert.equal(spawned, false, 'must not spawn a bare powershell');
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'no-launcher');
  // respawn SELF-preserve-pauses — the VISIBLE skill branch (launcher!=='none') runs `respawn --attended` and
  // does NOT inspect the outcome, so without a self-pause the handoff would be stranded (IMPL-ADV1).
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused', 'run must be preserve-paused by respawn itself');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');     // handoff preserved for recovery
  assert.equal(after.session_chain.lease.resume_policy, 'human');
});
