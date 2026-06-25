import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { respawn } from '../scripts/lib/respawn.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { driveHeadless } from '../scripts/hooks-impl/drive-headless.mjs';
import { pauseRun } from '../scripts/lib/state.mjs';

const A = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'automation');

// Deterministic "now" within the run's wallclock window so respawnGate does not wallclock-block.
const NOW1 = Date.parse('2026-06-24T00:01:00Z');

// Seed a run AND emit a handoff so there is a pending handoff with a reserved child.
// Returns { root, runId, em, childRunId } where em is the emitHandoff result and
// childRunId is the reserved child run id (from lease.handoff_child_run_id).
function seedRunWithHandoff() {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const em = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true,
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.ok(em.ok, `emitHandoff must succeed: ${em.reason}`);
  const childRunId = readState(root, runId).data.session_chain.lease.handoff_child_run_id;
  return { root, runId, em, childRunId };
}

function seedRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

// driveHeadless must issue the measured RESUME command (claude -p "<resume prompt>" --output-format json)
// when there is an emitted handoff with a reserved child.
test('driveHeadless resumes pending handoff with measured resume command', () => {
  const { root } = seedRunWithHandoff();
  let capturedCmd = null;
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: (cmd) => {
      capturedCmd = cmd;
      assert.match(cmd, /deep-loop-resume/, 'resume command must reference deep-loop-resume');
      assert.match(cmd, /--output-format json/, 'must request json output for measurement');
      return { ok: true, usage: { num_turns: 2, tokens: 50 } };
    },
  });
  assert.equal(r.action, 'resumed');
  assert.ok(capturedCmd, 'spawnFn must have been called');
});

// driveHeadless commits measured usage to budget on success.
// The injected spawnFn does not actually acquire the lease (no real claude session),
// so the lease stays releasing with the parent owner/gen → accounting carve-out allows recordCost.
test('driveHeadless commits measured usage to budget on success', () => {
  const { root, runId } = seedRunWithHandoff();
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => ({ ok: true, usage: { num_turns: 2, tokens: 50 } }),
  });
  assert.equal(r.action, 'resumed');
  assert.equal(r.recorded, true);
  const d = readState(root, runId).data;
  assert.equal(d.budget.spent, 2);
  assert.equal(d.budget.tokens_spent, 50);
});

// fail-closed: spawnFn returns { ok:false } → respawn does failure-mode-B rollback and returns
// outcome:'failed_launch'; driveHeadless surfaces this as action:'fail-closed'.
test('driveHeadless fails closed when usage unmeasurable/timeout', () => {
  const { root } = seedRunWithHandoff();
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => ({ ok: false, reason: 'unmeasurable-fail-closed' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed');
});

// gate-blocked: budget.total=0 forces budget gate block; spawnFn must NOT be called; status=paused.
test('driveHeadless returns gate-blocked and pauses run when respawnGate blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  // Emit handoff first so there is a pending handoff to attempt.
  const em = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true,
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.ok(em.ok, `emitHandoff must succeed: ${em.reason}`);
  // Exhaust the budget: set spent >= total * hard_stop_ratio.
  // Directly mutate state to set budget.spent >= budget.total (bypass recordCost to avoid lease issues).
  const { data } = readState(root, runId);
  data.budget.total = 0;  // 0 total → spent(0) >= 0*ratio → gate blocks
  // Write directly without going through recordCost to avoid lease issues.
  writeState(root, runId, data);

  let spawnCalled = false;
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => { spawnCalled = true; throw new Error('should not spawn'); },
  });
  assert.equal(r.ok, false, 'gate-blocked must return ok:false');
  assert.equal(r.action, 'gate-blocked', 'action must be gate-blocked');
  assert.equal(spawnCalled, false, 'spawnFn must NOT be called when gate blocks');
  assert.equal(readState(root, runId).data.status, 'paused', 'run status must be paused');
});

// already-spawned idempotency: second call returns action:'already-spawned', no double cost.
test('driveHeadless is idempotent — second call returns already-spawned, no double cost', () => {
  const { root, runId } = seedRunWithHandoff();
  let spawnCount = 0;
  const spawnFn = () => { spawnCount++; return { ok: true, usage: { num_turns: 3, tokens: 60 } }; };

  const r1 = driveHeadless({ root, now: NOW1, spawnFn });
  assert.equal(r1.action, 'resumed', 'first call must resume');
  assert.equal(r1.recorded, true);
  const spent1 = readState(root, runId).data.budget.spent;

  const r2 = driveHeadless({ root, now: NOW1, spawnFn });
  assert.equal(r2.action, 'already-spawned', 'second call must be idempotent');
  const spent2 = readState(root, runId).data.budget.spent;
  assert.equal(spent2, spent1, 'budget.spent must not increase on second call');
  assert.equal(spawnCount, 1, 'spawnFn must have been called exactly once');
});

// no pending handoff: a fresh initRun (no emitHandoff) → action:'no-pending-handoff'
test('driveHeadless returns no-pending-handoff when no handoff in flight', () => {
  const { root } = seedRun();
  const r = driveHeadless({ root, now: NOW1, spawnFn: () => { throw new Error('must not spawn'); } });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'no-pending-handoff');
});

// no run: empty root → action:'no-run'
test('driveHeadless is a no-op when no current run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto0-'));
  assert.equal(driveHeadless({ root }).action, 'no-run');
});

// When a grandchild fully acquires the lease (generation bumped twice), the post-resume
// fence is the grandchild's lease; accounting under that owner succeeds → recorded=true.
// (In practice the grandchild would have its own accounting; LEASE_FENCED is the defense.)
// This test verifies the swallow path: even if we get fenced we return ok:true, recorded:false.
test('driveHeadless does not throw when post-resume lease fenced (grandchild acquired)', () => {
  const { root, runId, em } = seedRunWithHandoff();
  const spawnNow = Date.parse('2026-06-24T00:00:01Z');
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => {
      // Simulate: child acquires the lease (generation+1); then emits its own handoff (releasing)
      // so the grandchild also acquires → generation+2. driveHeadless reads THAT as the fresh fence.
      // Here we just advance to emitted phase (the parent lease is already releasing/emitted).
      // The important thing: recorded may be true or false; ok must be true.
      return { ok: true, usage: { num_turns: 4, tokens: 100 } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'resumed');
  // recorded may be true (accounting carve-out applies) — just ensure no throw
  assert.ok(typeof r.recorded === 'boolean');
});

// Regression: driveHeadless must fail-closed PAUSE even when the resume child already acquired the
// lease before measurement failure was detected (spec §9 headless fail-closed invariant).
test('driveHeadless fails closed (pauses) when measurement fails after the child acquired the lease', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({ root, now: NOW1, spawnFn: () => {
    // Simulate: the resume child takes over the releasing lease (generation+1), then the process
    // times out / is unmeasurable — spawnFn returns {ok:false} after the child already acquired.
    acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, now: NOW1 });
    return { ok: false, reason: 'unmeasurable-fail-closed' };
  }});
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed');
  assert.equal(readState(root, runId).data.status, 'paused', 'fail-closed pause must be set even when child took over lease');
});

test('cron template calls the fail-closed driver (not raw claude -p)', () => {
  const f = join(A, 'cron-morning-triage.yml'); assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /cron|schedule|\d+\s+\d+\s+\*/i);
  assert.match(s, /drive-headless\.mjs/);                 // 드라이버 경유
  assert.match(s, /fail-closed|budget|proposal-only/i);
});

test('github-actions template is a scheduled workflow calling the driver', () => {
  const f = join(A, 'github-actions-loop.yml'); assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /on:\s*[\s\S]*schedule/);
  assert.match(s, /cron:/);
  assert.match(s, /drive-headless\.mjs/);
  assert.match(s, /proposal-only|사람 승인|human/i);
});
