import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { respawn as respawnImpl } from '../scripts/lib/respawn.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { driveHeadless as driveHeadlessImpl } from '../scripts/hooks-impl/drive-headless.mjs';
import { pauseRun } from '../scripts/lib/state.mjs';

const A = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'automation');
const HANDOFF_REFERENCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md');

// Deterministic "now" within the run's wallclock window so respawnGate does not wallclock-block.
const NOW1 = Date.parse('2026-06-24T00:01:00Z');

// These legacy driver tests exercise the POSIX Claude transport. Native-Windows
// executable authority has dedicated coverage in runtime/respawn integration tests.
function respawn(root, runId, options = {}) {
  return respawnImpl(root, runId, { ...options, platform: 'linux' });
}

function driveHeadless(options = {}) {
  return driveHeadlessImpl({
    ...options,
    respawnFn: options.respawnFn
      ?? ((root, runId, respawnOptions) => respawn(root, runId, respawnOptions)),
  });
}

// Seed a run AND emit a handoff so there is a pending handoff with a reserved child.
// Returns { root, runId, em, childRunId } where em is the emitHandoff result and
// childRunId is the reserved child run id (from lease.handoff_child_run_id).
function seedRunWithHandoff() {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
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
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

// driveHeadless must issue the measured RESUME command (claude -p "<resume prompt>" --output-format json)
// when there is an emitted handoff with a reserved child.
// spawnFn now receives an entry {bin, argv, cwd} (not a shell string) — check argv contents.
test('driveHeadless resumes pending handoff with measured resume command', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
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
      // Simulate child calling /deep-loop-resume → acquires lease (generation+1)
      acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
      return { ok: true, usage: { num_turns: 2, tokens: 50 } };
    },
  });
  assert.equal(r.action, 'resumed');
  assert.ok(capturedEntry, 'spawnFn must have been called');
});

// driveHeadless commits measured usage to budget on success (child acquired the lease).
test('driveHeadless commits measured usage to budget on success', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => {
      // Simulate child calling /deep-loop-resume → acquires lease (generation+1)
      acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
      return { ok: true, usage: { num_turns: 2, tokens: 50 } };
    },
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
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
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

// Idempotency: after the child acquires on the first call, the second call sees no pending handoff.
// No double cost, spawnFn called exactly once.
test('driveHeadless is idempotent — second call returns no-pending-handoff after acquisition, no double cost', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  let spawnCount = 0;
  const spawnFn = () => {
    spawnCount++;
    // Child acquires the lease (generation+1) so the second call sees no pending handoff.
    acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
    return { ok: true, usage: { num_turns: 3, tokens: 60 } };
  };

  const r1 = driveHeadless({ root, now: NOW1, spawnFn });
  assert.equal(r1.action, 'resumed', 'first call must resume');
  assert.equal(r1.recorded, true);
  const spent1 = readState(root, runId).data.budget.spent;

  // After child acquired, handoff_phase is 'acquired' → no pending handoff on second call.
  const r2 = driveHeadless({ root, now: NOW1, spawnFn });
  assert.equal(r2.action, 'no-pending-handoff', 'second call returns no-pending-handoff after child acquired');
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

// When the child acquires the lease, driveHeadless confirms acquisition and records cost.
// ok must be true, action must be 'resumed', recorded must be a boolean (true on normal acquire).
test('driveHeadless does not throw when post-resume lease fenced (child acquired)', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => {
      // Child acquires the lease (generation+1) — leaseMovedForward=true → proceed to record.
      acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
      return { ok: true, usage: { num_turns: 4, tokens: 100 } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'resumed');
  // recorded must be a boolean (true when accounting fence matches)
  assert.ok(typeof r.recorded === 'boolean');
});

// Regression: driveHeadless must fail-closed PAUSE even when the resume child already acquired the
// lease before measurement failure was detected (spec §9 headless fail-closed invariant).
test('driveHeadless fails closed (pauses) when measurement fails after the child acquired the lease', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({ root, now: NOW1, spawnFn: () => {
    // Simulate: the resume child takes over the releasing lease (generation+1), then the process
    // times out / is unmeasurable — spawnFn returns {ok:false} after the child already acquired.
    acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
    return { ok: false, reason: 'unmeasurable-fail-closed' };
  }});
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed');
  assert.equal(readState(root, runId).data.status, 'paused', 'fail-closed pause must be set even when child took over lease');
});

// R5-plan gate: driveHeadless must skip handoffs not intended for headless resumption.

test('driveHeadless skips handoff with resume_policy=human (spawnFn must NOT be called)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
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

test('driveHeadless skips visible-intended handoff (resume_policy visible — not-headless-intended)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const em = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true, resumePolicy: 'visible',
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.ok(em.ok, `emitHandoff must succeed: ${em.reason}`);
  // Explicit visible intent must not be degraded into an unattended resume.

  const r = driveHeadless({
    root, now: NOW1,
    spawnFn: () => { throw new Error('spawnFn must NOT be called for null-policy handoff'); },
  });
  assert.equal(r.skipped, true, 'must be skipped');
  assert.equal(r.reason, 'not-headless-intended');
});

test('driveHeadless resumes headless-intended handoff (resume_policy=headless)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
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
  const childRunId = readState(root, runId).data.session_chain.lease.handoff_child_run_id;

  let spawnCalled = false;
  const r = driveHeadless({
    root, now: NOW1,
    spawnFn: (entry) => {
      spawnCalled = true;
      assert.ok(entry.argv.join(' ').includes('deep-loop-resume'), 'must invoke resume command');
      // Simulate child calling /deep-loop-resume → acquires lease (generation+1)
      acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
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

test('execution-plane automation is root-portable and delegates to the runtime-selected trusted measured driver', () => {
  const source = readFileSync(HANDOFF_REFERENCE, 'utf8');
  assert.match(source, /loaded SKILL\.md path|로드된 `?SKILL\.md`? 경로/i,
    'automation reference derives the plugin root from the loaded skill path');
  assert.match(source, /literal[\s\S]{0,160}DEEP_LOOP_ROOT[\s\S]{0,200}(?:never|금지|않)/i,
    'literal placeholder is never passed to Node');
  assert.doesNotMatch(source, /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/,
    'automation docs must not depend on POSIX environment expansion');
  for (const line of source.split('\n').filter((entry) => /deep-loop\.mjs/.test(entry))) {
    assert.match(line, /^\s*node "DEEP_LOOP_ROOT\/scripts\/deep-loop\.mjs"(?:\s|$)/,
      `non-portable automation kernel command: ${line}`);
  }
  assert.match(source, /immutable runtime|불변 runtime/i, 'stored runtime selects the driver');
  assert.match(source, /trusted|승인된|검증된/i, 'driver executable identity stays trusted');
  assert.match(source, /measured|계측/i, 'driver usage remains measured');
  assert.match(source, /no cross-runtime fallback|교차 런타임[^\n]{0,120}(?:fallback|폴백)[^\n]{0,80}(?:없|금지|하지)/i,
    'automation must not fall back to a different runtime');
});

test('cron hook is thin glue over the shared headless host core', () => {
  const hook = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks-impl', 'drive-headless.mjs');
  const source = readFileSync(hook, 'utf8');
  assert.match(source, /lib\/headless-host\.mjs/);
  assert.doesNotMatch(source, /lib\/respawn\.mjs/);
  assert.doesNotMatch(source, /lib\/spawn-driver\.mjs/);
  assert.doesNotMatch(source, /recordCost\s*\(/);
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
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
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
  const childRunId2 = readState(root, runId).data.session_chain.lease.handoff_child_run_id;
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => {
      // Simulate child calling /deep-loop-resume → acquires lease (generation+1)
      acquireLease(root, runId, { owner: childRunId2, expectGeneration: 1, runtime: 'claude', now: NOW1 });
      return { ok: true, usage: { num_turns: 1, tokens: 10 } };
    },
  });
  assert.equal(r.action, 'resumed',
    `driveHeadless must resume, not skip: ${JSON.stringify(r)}`);
});

test('Codex handoff intent ignores CLAUDE_CODE_ENTRYPOINT and honors only durable or driver-owned headless signals', () => {
  for (const { env, expected } of [
    { env: { CLAUDE_CODE_ENTRYPOINT: 'print' }, expected: 'visible' },
    { env: { DEEP_LOOP_HEADLESS: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }, expected: 'headless' },
    { env: { DEEP_LOOP_UNATTENDED: 'true', CLAUDE_CODE_ENTRYPOINT: 'cli' }, expected: 'headless' },
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-auto-codex-intent-')));
    const { runId } = initRun(root, {
      runtime: 'codex', goal: 'g', now: new Date('2026-07-11T00:00:00Z'),
      env: {}, platform: 'linux', run: () => ({ code: 1 }),
    });
    const emitted = emitHandoff(root, runId, {
      trigger: 'milestone',
      expect: { owner: runId, generation: 1 },
      env,
      now: Date.parse('2026-07-11T00:01:00Z'),
    });
    assert.equal(emitted.ok, true);
    assert.equal(readState(root, runId).data.session_chain.lease.resume_policy, expected);
  }
});

// ── Codex-R5B: terminal guard + fresh-fence regression tests ─────────────────

// driveHeadless must NOT demote a terminal (completed) run to paused, even when
// the measured spawn fails AND the child already acquired the lease (unfenced demote bug).
// Expected: action='fail-closed-terminal', status stays 'completed'.
test('driveHeadless: fail-closed-terminal when spawn fails and run reached completed status', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({ root, now: NOW1, spawnFn: () => {
    // Child acquires the lease (generation bumps to 2)
    acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
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
    acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
    return { ok: false, reason: 'unmeasurable-fail-closed' };
  }});
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed', 'non-terminal run must be fail-closed paused');
  assert.equal(readState(root, runId).data.status, 'paused', 'run must be paused with fresh fence');
});

// ── Codex-R6B: child acquisition verification before reporting success ──────────

// Codex r6 HIGH: headless resume must verify child acquisition before reporting success (fail-closed otherwise).
// A claude -p that exits 0 with usage but never runs /deep-loop-resume leaves the run in releasing/spawned;
// driveHeadless must NOT report 'resumed' — must fail-closed with action:'resumed-unconfirmed'.
test('driveHeadless: resumed-unconfirmed (fail-closed) when spawn ok but child never acquired lease', () => {
  const { root, runId } = seedRunWithHandoff();
  const budgetBefore = readState(root, runId).data.budget.spent;
  const r = driveHeadless({
    root, now: NOW1,
    // spawnFn returns ok:true with usage but child NEVER calls /deep-loop-resume → lease stays releasing/spawned
    spawnFn: () => ({ ok: true, usage: { num_turns: 2, tokens: 50 } }),
  });
  assert.equal(r.ok, false, 'must be ok:false when child did not acquire');
  assert.equal(r.action, 'resumed-unconfirmed', 'action must be resumed-unconfirmed');
  assert.equal(r.reason, 'child-did-not-acquire', 'reason must be child-did-not-acquire');
  assert.equal(readState(root, runId).data.budget.spent, budgetBefore,
    'must NOT record cost when unconfirmed (no proven progress)');
  assert.equal(readState(root, runId).data.status, 'paused',
    'must fail-closed pause the run when child did not acquire');
});

// Codex r6 HIGH happy path: child DID acquire the lease → action:'resumed' + cost recorded.
test('driveHeadless: resumed with cost when child acquires lease (acquisition proof confirmed)', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({
    root, now: NOW1,
    spawnFn: () => {
      // Child calls /deep-loop-resume → acquires the lease (generation+1)
      acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
      return { ok: true, usage: { num_turns: 2, tokens: 50 } };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'resumed');
  assert.equal(r.recorded, true);
  assert.ok(readState(root, runId).data.budget.spent > 0, 'cost must be recorded on confirmed acquisition');
});

// ── Codex-R7: pre-respawn-snapshot fix regression tests ──────────────────────
//
// Seed a 2nd-generation run: lease.owner_run_id is already 'child1' (not the top-level runId)
// because a prior handoff already happened. A pending handoff has reserved 'child2'.
// Returns { root, runId, child1RunId, child2RunId }.
function seedRun2ndGenHandoff() {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });

  // 1st handoff: top-level runId emits, child1 is reserved then acquired.
  const em1 = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true, resumePolicy: 'headless',
    expect: { owner: runId, generation: 1 },
    now: NOW1,
  });
  assert.ok(em1.ok, `1st emitHandoff must succeed: ${em1.reason}`);
  const child1RunId = em1.childRunId;

  // child1 acquires the lease (simulates /deep-loop-resume in the child session).
  // After this: owner_run_id=child1, generation=2, handoff_phase='acquired'.
  const acq = acquireLease(root, runId, { owner: child1RunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
  assert.ok(acq.ok, `child1 acquireLease must succeed: ${acq.reason}`);
  assert.equal(acq.generation, 2);

  // 2nd handoff: child1 emits a new handoff, reserving child2.
  // headless intent must use child1 as owner with generation=2.
  const em2 = emitHandoff(root, runId, {
    reason: 'pre-compact', trigger: 'pre-compact', headless: true, resumePolicy: 'headless',
    expect: { owner: child1RunId, generation: 2 },
    now: NOW1 + 1000,
  });
  assert.ok(em2.ok, `2nd emitHandoff must succeed: ${em2.reason}`);
  const child2RunId = em2.childRunId;

  // Ensure resume_policy='headless' is persisted (emitHandoff sets this but verify).
  const { data } = readState(root, runId);
  assert.equal(data.session_chain.lease.resume_policy, 'headless', 'resume_policy must be headless');
  assert.equal(data.session_chain.lease.owner_run_id, child1RunId, 'lease owner must be child1 (not top-level runId)');
  assert.equal(data.session_chain.lease.generation, 2, 'generation must be 2');
  assert.equal(data.session_chain.lease.handoff_child_run_id, child2RunId, 'child2 must be reserved');

  return { root, runId, child1RunId, child2RunId };
}

// Codex r7 HIGH regression (RED→GREEN):
// On a 2nd-generation headless handoff the lease pre-respawn owner is child1 (≠ top-level runId).
// If child2 exits 0 without acquiring, freshLease.owner_run_id is still child1.
// OLD check (`!== runId`): child1 !== R1 → TRUE → falsely returns action:'resumed'.
// NEW check (pre-respawn snapshot): child1 !== child1 → FALSE → fail-closes correctly.
test('driveHeadless: 2nd-gen no-acquire must fail-close (not falsely resumed) — codex-r7', () => {
  const { root, runId } = seedRun2ndGenHandoff();
  const budgetBefore = readState(root, runId).data.budget.spent;

  const r = driveHeadless({
    root, now: NOW1 + 2000,
    // child2 exits 0 with usage but NEVER calls /deep-loop-resume — lease stays on child1.
    spawnFn: () => ({ ok: true, usage: { num_turns: 3, tokens: 75 } }),
  });

  assert.equal(r.ok, false, 'must be ok:false when child2 did not acquire (2nd-gen)');
  // The fix must NOT return 'resumed' — it must fail-close.
  assert.notEqual(r.action, 'resumed', 'action must NOT be resumed when child2 never acquired');
  // Expected fail-closed action is 'resumed-unconfirmed' (child did not acquire branch).
  assert.equal(r.action, 'resumed-unconfirmed', 'action must be resumed-unconfirmed for 2nd-gen no-acquire');
  assert.equal(r.reason, 'child-did-not-acquire', 'reason must be child-did-not-acquire');
  // No cost must be recorded (no proven progress).
  assert.equal(readState(root, runId).data.budget.spent, budgetBefore,
    'budget.spent must NOT increase when child2 did not acquire');
  // Run must be paused (fail-closed).
  assert.equal(readState(root, runId).data.status, 'paused',
    'run must be paused (fail-closed) on 2nd-gen no-acquire');
});

// Codex r7 HIGH contrast: 2nd-gen where child2 DOES acquire → action:'resumed' + cost recorded.
// Verifies the fix does not break the happy path for 2nd-generation handoffs.
test('driveHeadless: 2nd-gen child2 acquires → action:resumed + cost recorded (codex-r7 happy path)', () => {
  const { root, runId, child2RunId } = seedRun2ndGenHandoff();

  const r = driveHeadless({
    root, now: NOW1 + 2000,
    spawnFn: () => {
      // child2 calls /deep-loop-resume → acquires the lease (generation 2→3).
      const acq = acquireLease(root, runId, { owner: child2RunId, expectGeneration: 2, runtime: 'claude', now: NOW1 + 3000 });
      assert.ok(acq.ok, `child2 acquireLease must succeed: ${acq.reason}`);
      assert.equal(acq.generation, 3, 'generation must bump to 3 after child2 acquisition');
      return { ok: true, usage: { num_turns: 3, tokens: 75 } };
    },
  });

  assert.equal(r.ok, true, 'must be ok:true when child2 acquired (2nd-gen happy path)');
  assert.equal(r.action, 'resumed', 'action must be resumed after confirmed 2nd-gen acquisition');
  assert.equal(r.recorded, true, 'cost must be recorded on confirmed 2nd-gen acquisition');
  assert.ok(readState(root, runId).data.budget.spent > 0, 'budget.spent must increase after child2 acquired');
});

// ── v1.6 terminal 회귀 (spec §2.4 / §4-5·5c) ────────────────────────────────
test('driveHeadless: terminal Claude child keeps the legacy terminal fence and records no post-terminal cost', () => {
  const { root, runId, childRunId } = seedRunWithHandoff();
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => {
      // 자식이 acquire 후 작업을 끝내고 run을 terminal로 전이시킨 시나리오
      acquireLease(root, runId, { owner: childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 });
      const { data } = readState(root, runId);
      data.status = 'completed';
      writeState(root, runId, data);
      return { ok: true, usage: { num_turns: 3, tokens: 70 } };
    },
  });
  // Claude usage has no exact Codex one-turn receipt/handoff binding, so the generic terminal fence remains closed.
  assert.equal(r.ok, true);
  assert.equal(r.action, 'resumed');
  assert.equal(r.recorded, false);
  const d = readState(root, runId).data;
  assert.equal(d.status, 'completed');            // paused 강등 없음
  assert.equal(d.budget.spent, 0);                // usage 이벤트 미기록 (전면 거부 — 사람 확정 트레이드오프)
});

test('driveHeadless: legacy terminal+emitted pending handoff → no write, terminal outcome (spec §4-5c ②)', () => {
  const { root, runId } = seedRunWithHandoff();
  const { data } = readState(root, runId);
  data.status = 'completed';                       // legacy 오염 상태 직조 (가드 이전 로그 잔재 시나리오)
  writeState(root, runId, data);
  const before = JSON.stringify(readState(root, runId).data);
  const r = driveHeadless({
    root,
    now: NOW1,
    spawnFn: () => { throw new Error('must not spawn'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'terminal');
  assert.equal(JSON.stringify(readState(root, runId).data), before);   // 상태 무변
});
