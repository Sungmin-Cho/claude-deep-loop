import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { runPreCompactHandoff } from '../scripts/hooks-impl/precompact-handoff.mjs';
const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('no current run → no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc0-'));
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'no-run');
});

test('interactive → emits handoff, no spawn', async () => {
  const { root } = seed();
  // spawnFn is no longer accepted — just verify action and that no side-effect occurs.
  const r = await runPreCompactHandoff({ tty: true }, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'emitted');
});

// PreCompact is emit-only: unattended within-budget → action='emitted', no child process spawned.
// The measured cron driveHeadless (headlessSpawn) will resume via round-2 handshake.
test('unattended within budget → emits handoff, no spawn (measured resume via cron)', async () => {
  const { root } = seed();
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'emitted');
  assert.ok(r.childRunId, 'childRunId present');
});

// Fix 2: gate-blocked (wallclock exhausted) → action='gate-blocked-paused', status=paused, no spawn.
test('unattended but gate-blocked → no spawn, run paused, action=gate-blocked-paused', async () => {
  const { root, runId } = seed();
  // created_at=2026-06-24 + now 한참 뒤 → wallclock(max 86400s) 초과 → respawnGate 차단.
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-07-01T00:00:00Z') });
  assert.equal(r.action, 'gate-blocked-paused');
  const { readState } = await import('../scripts/lib/state.mjs');
  assert.equal(readState(root, runId).data.status, 'paused');
});

// Fix 2 regression: gate must be evaluated on POST-emit state, not PRE-emit state.
// Seed a run whose sessions.length === max_sessions BEFORE PreCompact.
// emitHandoff will append the reserved child → sessions.length = max_sessions + 1 → gate blocks.
// On PRE-emit state sessions.length === max_sessions which is NOT > max_sessions → would NOT block (the bug).
test('unattended with sessions.length == max_sessions before emit → gate-blocked-paused after emit', async () => {
  const { root, runId } = seed();
  // After initRun there is 1 session. Set max_sessions=1 so the post-emit count (2) exceeds it.
  const { data } = readState(root, runId);
  data.autonomy.max_sessions = 1;
  writeState(root, runId, data);
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'gate-blocked-paused', `expected gate-blocked-paused, got ${r.action}`);
  assert.equal(readState(root, runId).data.status, 'paused');
});

// Task 11: tty===false alone (no unattended, spawn_style visible) → headless false (uses isHeadlessInvocation, not tty flag)
test('tty===false alone with empty env → headless false (isHeadlessInvocation replaces tty check)', async () => {
  const { root } = seed();
  const r = await runPreCompactHandoff({ tty: false }, { root, now: Date.parse('2026-06-24T00:01:00Z'), env: {} });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, false, 'tty===false alone must NOT trigger headless; only env signals do');
});

// Task 11: explicit unattended:true → headless true
test('explicit unattended:true → headless true (input.unattended wins)', async () => {
  const { root } = seed();
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z'), env: {} });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, true);
});

// Task 11: spawn_style visible + no input.unattended + env DEEP_LOOP_UNATTENDED=1 → headless true
test('env DEEP_LOOP_UNATTENDED=1 with spawn_style visible → headless true (isHeadlessInvocation)', async () => {
  const { root } = seed(); // default spawn_style='visible'
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-06-24T00:01:00Z'), env: { DEEP_LOOP_UNATTENDED: '1' } });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, true);
});

test('hooks.json declares PreCompact → precompact-handoff.sh', () => {
  const h = JSON.parse(rf(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(h.hooks.PreCompact, 'PreCompact event present');
  const cmd = h.hooks.PreCompact[0].hooks[0].command;
  assert.match(cmd, /precompact-handoff\.sh/);
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test('precompact-handoff.sh is Bash 3.2 safe', () => {
  const sh = rf(join(PROOT, 'hooks', 'scripts', 'precompact-handoff.sh'), 'utf8');
  assert.match(sh, /set -Eeuo pipefail/);
  assert.ok(!/declare -A/.test(sh), 'no associative arrays');
  assert.ok(!/\$\{[A-Za-z_]+,,\}/.test(sh), 'no ${var,,} lowercasing');
  assert.match(sh, /precompact-handoff\.mjs/);
});

// R12-LL regression: gate-blocked precompact MUST rollback the reserved child (invalidate it),
// NOT merely set status=paused while leaving handoff_child_run_id intact (which would allow a
// human to bypass the gate via /deep-loop-resume → acquireLease(reserved child)).
test('gate-blocked precompact ROLLBACK: reserved child invalidated, respawn-failed event appended (R12-LL)', async () => {
  const { root, runId } = seed();
  // Trip the circuit breaker so respawnGate returns { ok: false, blocked_by: ['breaker'] }.
  const { data } = readState(root, runId);
  data.circuit_breaker.tripped = true;
  writeState(root, runId, data);

  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z'), env: {} });
  assert.equal(r.action, 'gate-blocked-paused', `expected gate-blocked-paused, got ${r.action}`);
  assert.ok(r.childRunId, 'childRunId must be present in response');

  const { data: loop } = readState(root, runId);
  const lease = loop.session_chain.lease;

  // 1. Reserved child must be invalidated — NOT resumable via acquireLease.
  assert.equal(lease.handoff_child_run_id, null, 'lease.handoff_child_run_id must be null after rollback');

  // 2. Child session outcome must be failed_launch (excluded from max_sessions).
  const childSession = loop.session_chain.sessions.find(s => s.run_id === r.childRunId);
  assert.ok(childSession, 'child session must exist in sessions array');
  assert.equal(childSession.outcome, 'failed_launch', 'child.outcome must be failed_launch');

  // 3. Parent session superseded_by must be cleared.
  const parentSession = loop.session_chain.sessions.find(s => s.run_id === runId);
  assert.ok(parentSession, 'parent session must exist');
  assert.equal(parentSession.superseded_by, null, 'parent.superseded_by must be null after rollback');

  // 4. Lease fully rolled back to active/idle state.
  assert.equal(lease.state, 'active', 'lease.state must be active');
  assert.equal(lease.handoff_phase, 'idle', 'lease.handoff_phase must be idle');
  assert.equal(lease.expires_at, null, 'lease.expires_at must be null');
  assert.equal(lease.resume_policy, null, 'lease.resume_policy must be null');

  // 5. Run paused with gate: prefixed reason.
  assert.equal(loop.status, 'paused', 'status must be paused');
  assert.match(loop.pause_reason, /^gate:/, 'pause_reason must start with gate:');

  // 6. Event log must contain a respawn-failed event (ONE appendAnchored transaction).
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const events = parseLog(logPath);
  const respawnFailed = events.find(e => e.type === 'respawn-failed');
  assert.ok(respawnFailed, 'event log must contain a respawn-failed event');
});

function parseLog(path) {
  try { return rf(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

// ── v1.6: terminal run에서 PreCompact 훅 graceful 거부 (spec §4-4③) ──────────
test('terminal run → hook returns ok:false action:fenced RUN_TERMINAL (graceful, no write)', async () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'completed';
  writeState(root, runId, data);
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-09T00:01:00Z') });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fenced');
  assert.equal(r.reason, 'RUN_TERMINAL');
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'idle');   // 예약 잔여 없음
});
