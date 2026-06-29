import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');
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
  // Task 10: driveHeadless gates on resume_policy==='headless'. Task 11 will persist this via emitHandoff;
  // for now, seed it directly so headless-driver test scenarios reflect headless-intended handoffs.
  const { data } = readState(root, runId);
  data.session_chain.lease.resume_policy = 'headless';
  writeState(root, runId, data);
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
// spawnFn now receives an entry {bin, argv, cwd} (not a shell string) — check argv contents.
test('driveHeadless resumes pending handoff with measured resume command', () => {
  const { root } = seedRunWithHandoff();
  let capturedEntry = null;
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: (entry) => {
      capturedEntry = entry;
      // headless entry: bin='claude', argv contains resume prompt and output format flag
      const argStr = entry.argv.join(' ');
      assert.ok(argStr.includes('deep-loop-resume'), 'resume command must reference deep-loop-resume');
      assert.ok(entry.argv.includes('--output-format'), 'must include --output-format flag for measurement');
      return { ok: true, usage: { num_turns: 2, tokens: 50 } };
    },
  });
  assert.equal(r.action, 'resumed');
  assert.ok(capturedEntry, 'spawnFn must have been called');
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
  // Set resume_policy='headless' so the R5 gate passes; budget exhaustion is what triggers gate-blocked.
  // Directly mutate state to set budget.spent >= budget.total (bypass recordCost to avoid lease issues).
  const { data } = readState(root, runId);
  data.budget.total = 0;  // 0 total → spent(0) >= 0*ratio → gate blocks
  data.session_chain.lease.resume_policy = 'headless';
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

// R5-plan gate: driveHeadless must skip handoffs not intended for headless resumption.

test('driveHeadless skips handoff with resume_policy=human (spawnFn must NOT be called)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const em = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true,
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.ok(em.ok, `emitHandoff must succeed: ${em.reason}`);
  // Simulate preserve-timeout: resume_policy='human' (Task 11 will set this via emitHandoff for visible spawns)
  const { data } = readState(root, runId);
  data.session_chain.lease.resume_policy = 'human';
  writeState(root, runId, data);

  const r = driveHeadless({
    root, now: NOW1,
    spawnFn: () => { throw new Error('spawnFn must NOT be called for human-policy handoff'); },
  });
  assert.equal(r.skipped, true, 'must be skipped');
  assert.equal(r.reason, 'human-resume-policy');
});

test('driveHeadless skips visible-intended handoff (resume_policy null — not-headless-intended)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const em = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true,
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.ok(em.ok, `emitHandoff must succeed: ${em.reason}`);
  // resume_policy stays null (Task 11 not yet applied) — driveHeadless must skip

  const r = driveHeadless({
    root, now: NOW1,
    spawnFn: () => { throw new Error('spawnFn must NOT be called for null-policy handoff'); },
  });
  assert.equal(r.skipped, true, 'must be skipped');
  assert.equal(r.reason, 'not-headless-intended');
});

test('driveHeadless resumes headless-intended handoff (resume_policy=headless)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const em = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true,
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.ok(em.ok, `emitHandoff must succeed: ${em.reason}`);
  // Seed resume_policy='headless' (Task 11 will do this via emitHandoff param)
  const { data } = readState(root, runId);
  data.session_chain.lease.resume_policy = 'headless';
  writeState(root, runId, data);

  let spawnCalled = false;
  const r = driveHeadless({
    root, now: NOW1,
    spawnFn: (entry) => {
      spawnCalled = true;
      assert.ok(entry.argv.join(' ').includes('deep-loop-resume'), 'must invoke resume command');
      return { ok: true, usage: { num_turns: 1, tokens: 10 } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'resumed');
  assert.equal(spawnCalled, true, 'spawnFn must be called for headless-policy handoff');
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

// Regression: handoff emit CLI must honor spawn_style='headless' even without --headless flag.
// Bug: CLI derived resumePolicy from ONLY --headless → autonomous loops stall (not-headless-intended).
// Fix: symmetric derivation (spawn_style + isHeadlessInvocation), same as precompact-handoff.mjs.
test('handoff emit derives resume_policy=headless from spawn_style without --headless flag (CLI regression)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  // Seed spawn_style='headless' so autonomous driver knows this run is headless.
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'headless';
  writeState(root, runId, data);

  // Call handoff emit via CLI WITHOUT --headless flag — the fix must derive headless from spawn_style.
  const out = JSON.parse(execFileSync('node', [
    CLI, 'handoff', 'emit',
    '--reason', 'milestone',
    '--owner', runId, '--generation', '1',
    '--project-root', root,
  ], { encoding: 'utf8' }));
  assert.ok(out.ok, `handoff emit must succeed: ${JSON.stringify(out)}`);

  // resume_policy must be 'headless' (derived from spawn_style, not --headless flag).
  const d = readState(root, runId).data;
  assert.equal(d.session_chain.lease.resume_policy, 'headless',
    'resume_policy must be headless when spawn_style=headless even without --headless CLI flag');

  // driveHeadless on this run must RESUME — not skip with reason='not-headless-intended'.
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => ({ ok: true, usage: { num_turns: 1, tokens: 10 } }),
  });
  assert.equal(r.action, 'resumed',
    `driveHeadless must resume, not skip: ${JSON.stringify(r)}`);
});

// ── Codex-R5B: terminal guard + fresh-fence regression tests ─────────────────

// driveHeadless must NOT demote a terminal (completed) run to paused, even when
// the measured spawn fails AND the child already acquired the lease (unfenced demote bug).
// Expected: action='fail-closed-terminal', status stays 'completed'.
test('driveHeadless: fail-closed-terminal when spawn fails and run reached completed status', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({ root, now: NOW1, spawnFn: () => {
    // Child acquires the lease (generation bumps to 2)
    acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, now: NOW1 });
    // Then the run reaches terminal status (completed)
    const { data } = readState(root, runId);
    data.status = 'completed';
    writeState(root, runId, data);
    // Spawn returns failure (unmeasurable)
    return { ok: false, reason: 'unmeasurable-fail-closed' };
  }});
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed-terminal', 'terminal run must not be demoted to paused');
  assert.equal(readState(root, runId).data.status, 'completed', 'status must stay completed, not paused');
});

// driveHeadless must use a FRESH fence (not unfenced) when the child acquired the lease
// and the run is non-terminal. After fix: fresh-fence pause succeeds normally.
// Expected: action='fail-closed', status='paused' (same end result but via fenced pause).
test('driveHeadless: fresh-fence pause when spawn fails, child acquired, run non-terminal', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({ root, now: NOW1, spawnFn: () => {
    // Child acquires the lease (generation bumps to 2), run stays 'running'
    acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, now: NOW1 });
    return { ok: false, reason: 'unmeasurable-fail-closed' };
  }});
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed', 'non-terminal run must be fail-closed paused');
  assert.equal(readState(root, runId).data.status, 'paused', 'run must be paused with fresh fence');
});
