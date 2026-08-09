import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, lstatSync, realpathSync, readdirSync, rmSync, linkSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { newWorkstream, recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { respawn as respawnImpl } from '../scripts/lib/respawn.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { driveHeadless as driveHeadlessImpl } from '../scripts/hooks-impl/drive-headless.mjs';
import { pauseRun } from '../scripts/lib/state.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import { createDirectoryJunction, createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

const A = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'automation');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HANDOFF_REFERENCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md');
const GITHUB_WORKFLOW = join(A, 'github-actions-loop.yml');

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
  migrateAuthenticLegacyTransport(root, runId);
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
  migrateAuthenticLegacyTransport(root, runId);
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
  migrateAuthenticLegacyTransport(root, runId);
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
  migrateAuthenticLegacyTransport(root, runId);
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
  migrateAuthenticLegacyTransport(root, runId);
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
  migrateAuthenticLegacyTransport(root, runId);
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

test('cron uses explicit provisioned project-root and run-id, never implicit current', () => {
  const source = readFileSync(join(A, 'cron-morning-triage.yml'), 'utf8');
  assert.match(source, /one-time|provisioned|provisioning/i, 'cron must describe one-time identity provisioning');
  assert.match(source, /--project-root\s+["']?<PROJECT_ROOT>["']?/i);
  assert.match(source, /--run-id\s+["']?<RUN_ID>["']?/i);
  assert.doesNotMatch(source, /\.deep-loop\/current|current run|drive-headless\.mjs['"`]?\s*(?:>>|$)/i,
    'cron must not use current or no-argument driver invocation');
});

test('cron recipe provisions immutable project-root and run-id A', () => {
  const source = readFileSync(join(A, 'cron-morning-triage.yml'), 'utf8');
  assert.match(source, /provisioned_project_root:\s*["']<PROJECT_ROOT>["']/,
    'cron must name the provisioned canonical project-root input');
  assert.match(source, /provisioned_run_id:\s*["']<RUN_ID>["']/,
    'cron must name the provisioned run identity input');
  assert.match(source, /immutable:\s*true/,
    'cron identity must be immutable after one-time provisioning');
  assert.doesNotMatch(source, /DEEP_LOOP_ROOT\s*=|\.deep-loop\/current/i,
    'cron must not source authority from caller root or current hint');
});

test('exact probe binds persisted project root before A-only driver', () => {
  const source = trustedWorkflowSource();
  assert.match(source, /loop\.json/);
  assert.match(source, /loop\?\.project\?\.root/);
  assert.match(source, /--project-root[\s\S]{0,120}--run-id/);
  assert.match(source, /DEEP_LOOP_RUN_ID/);
  assert.match(source, /configuration-invalid/);
});

test('cron-shaped explicit missing run fails closed with routing-invalid exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-missing-'));
  const missingRunId = '01J00000000000000000000000';
  let error;
  try {
    execFileSync(process.execPath, [
      join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'hooks-impl', 'drive-headless.mjs'),
      '--project-root', root, '--run-id', missingRunId,
    ], { encoding: 'utf8', env: { ...process.env, DEEP_LOOP_UNATTENDED: '1' } });
  } catch (cause) {
    error = cause;
  }
  assert.equal(error?.status, 1, 'missing provisioned run must be a nonzero routing failure');
  const result = JSON.parse(error.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.action, 'routing-invalid');
  assert.equal(result.kind, 'invalid');
  assert.equal(result.total, 1);
});

function trustedWorkflowSource() {
  // GitHub checks out YAML with CRLF on Windows; normalize only this
  // line-oriented test extraction boundary.
  const source = readFileSync(GITHUB_WORKFLOW, 'utf8').replace(/\r\n?/g, '\n');
  const match = source.match(/node\s+--input-type=module\s+<<'NODE'\n([\s\S]*?)\n\s*NODE/);
  assert.ok(match, 'GitHub workflow must carry the trusted inline Node preflight');
  let extracted = match[1].split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const platformGuard = /if \(process\.platform !== 'linux' \|\| process\.arch !== 'x64' \|\| Number\(process\.versions\.node\.split\('\.'\)\[0\]\) < 20\)\n\s*throw new Error\('unsupported provisioned Linux\/x64 Node topology'\);/g;
  assert.equal([...extracted.matchAll(platformGuard)].length, 1, 'production platform guard must be exact and singular');
  extracted = extracted.replace(platformGuard, "if (false) throw new Error('unsupported provisioned Linux/x64 Node topology');");
  const timeoutSentinel = /const TEST_CHILD_TIMEOUT_MS = null;/g;
  assert.equal([...extracted.matchAll(timeoutSentinel)].length, 1, 'production child timeout override must be a single null sentinel');
  extracted = extracted.replace(timeoutSentinel, "const TEST_CHILD_TIMEOUT_MS = Number(process.env.DEEP_LOOP_TEST_CHILD_TIMEOUT_MS);");
  const probeRootSentinel = /const TEST_PROBE_PROJECT_ROOT = null;/g;
  const probeRunSentinel = /const TEST_PROBE_RUN_ID = null;/g;
  assert.equal([...extracted.matchAll(probeRootSentinel)].length, 1, 'production probe root override must be a single null sentinel');
  assert.equal([...extracted.matchAll(probeRunSentinel)].length, 1, 'production probe run override must be a single null sentinel');
  extracted = extracted.replace(probeRootSentinel, "const TEST_PROBE_PROJECT_ROOT = process.env.DEEP_LOOP_TEST_PROBE_PROJECT_ROOT;");
  extracted = extracted.replace(probeRunSentinel, "const TEST_PROBE_RUN_ID = process.env.DEEP_LOOP_TEST_PROBE_RUN_ID;");
  const probeFailure = "if (!probe.ok) throw new Error(probe.reason);";
  const driverFailure = "if (!driver.ok) throw new Error(driver.reason);";
  assert.equal(extracted.split(probeFailure).length - 1, 1, 'probe failure seam must remain singular');
  assert.equal(extracted.split(driverFailure).length - 1, 1, 'driver failure seam must remain singular');
  const boundedChildDetail = "const boundedChildDetail = value => String(value || '').replace(/[\\\\r\\\\n]+/g, ' ').slice(0, 120);";
  const envDeclaration = 'const env = name =>';
  assert.equal(extracted.split(envDeclaration).length - 1, 1, 'environment helper must remain singular');
  extracted = extracted.replace(envDeclaration, `${boundedChildDetail}\n          ${envDeclaration}`);
  extracted = extracted.replace(probeFailure,
    "if (!probe.ok) throw new Error(`${probe.reason}${probe.stderr?.length ? `: ${boundedChildDetail(probe.stderr.toString('utf8'))}` : ''}`);");
  extracted = extracted.replace(driverFailure,
    "if (!driver.ok) throw new Error(`${driver.reason}${driver.stderr?.length ? `: ${boundedChildDetail(driver.stderr.toString('utf8'))}` : ''}`);");
  return extracted;
}

test('trusted bootstrap imports only FD-bound V1', () => {
  const source = trustedWorkflowSource();
  assert.match(readFileSync(GITHUB_WORKFLOW, 'utf8'), /const TEST_CHILD_TIMEOUT_MS = null;/);
  assert.match(source, /const TEST_CHILD_TIMEOUT_MS = Number\(process\.env\.DEEP_LOOP_TEST_CHILD_TIMEOUT_MS\)/);
  assert.match(readFileSync(GITHUB_WORKFLOW, 'utf8'), /const TEST_PROBE_PROJECT_ROOT = null;[\s\S]*const TEST_PROBE_RUN_ID = null;/);
  assert.doesNotMatch(readFileSync(GITHUB_WORKFLOW, 'utf8'), /process\.env\.DEEP_LOOP_TEST_PROBE_/);
  assert.match(source, /const TEST_PROBE_PROJECT_ROOT = process\.env\.DEEP_LOOP_TEST_PROBE_PROJECT_ROOT/);
  assert.match(source, /const TEST_PROBE_RUN_ID = process\.env\.DEEP_LOOP_TEST_PROBE_RUN_ID/);
  assert.match(source, /TRUSTED_CHILD_BOOTSTRAP_SOURCE/);
  assert.match(source, /O_RDONLY[\s\S]{0,120}O_DIRECTORY[\s\S]{0,120}O_NOFOLLOW/);
  assert.match(source, /\/proc\/self\/fd\/3/);
  assert.match(source, /--preserve-symlinks/);
  assert.match(source, /--preserve-symlinks-main/);
  assert.match(source, /process\.argv\s*=\s*\[process\.execPath/);
  assert.match(source, /pathToFileURL|fileURLToPath/);
  assert.match(source, /childRel\.normalize\('NFC'\)/);
  assert.match(source, /seenFold/);
  assert.match(source, /stat\.nlink\s*!==\s*1/);
  assert.match(source, /seenIdentity/);
  assert.match(source, /framedBytes = 27/);
  assert.match(source, /pathBytes \+ rel\.length > 16 \* 1024 \* 1024/);
  assert.match(source, /framedBytes \+ frameBytes > 512 \* 1024 \* 1024/);
  assert.doesNotMatch(source, /DEEP_LOOP_CANDIDATE_ROOT[^;]*import|import[^;]*DEEP_LOOP_CANDIDATE_ROOT/);
});

test('exact probe argv and bounded child termination reasons are workflow-owned', () => {
  const source = trustedWorkflowSource();
  for (const flag of [
    '--input-type=module', '--eval', '--stage-fd', '3', '--public-root',
    '--entrypoint', 'scripts/deep-loop.mjs', '--field', 'project.root', '--json',
    '--project-root', '--run-id',
  ]) assert.ok(source.includes(flag), 'missing exact child argv token: ' + flag);
  for (const constant of [
    'CHILD_STARTUP_TIMEOUT_MS = 10_000',
    'PROBE_EXIT_TIMEOUT_MS = 30_000',
    'DRIVER_EXIT_TIMEOUT_MS = 1_800_000',
    'CHILD_STDOUT_MAX_BYTES = 1_048_576',
    'CHILD_STDERR_MAX_BYTES = 65_536',
    'CHILD_TERMINATION_GRACE_MS = 250',
    'CHILD_SETTLE_GRACE_MS = 1_250',
  ]) assert.ok(source.includes(constant), 'missing child limit: ' + constant);
  for (const reason of [
    'child-startup-timeout', 'probe-exit-timeout', 'driver-exit-timeout',
    'child-stdout-overflow', 'child-stderr-overflow', 'child-termination-failed',
  ]) assert.ok(source.includes(reason), 'missing child reason: ' + reason);
  assert.match(source, /probe[\s\S]{0,300}driver/);
  assert.match(source, /--stage-identity[\s\S]{0,240}['"]--['"]/,
    'bootstrap controls and public argv must have a second literal separator');
});

test('same-stage compatibility driver preserves B', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
  const { runId: siblingRunId } = initRun(fixture.project, {
    runtime: 'claude', goal: 'trusted sibling fixture', detected: {},
    review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false },
    now: new Date('2026-06-24T00:00:03.000Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const beforeB = durableRunSnapshot(fixture.project, siblingRunId);
  const beforeA = durableRunSnapshot(fixture.project, fixture.runId);
  const marker = join(fixture.base, 'child-v1.log');
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1',
    DEEP_LOOP_CHILD_V1_MARKER: marker,
  });
  assert.equal(result.status, 0, result.stdout);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.kind, 'trusted-fd-execution');
  assert.equal(output.probe, 1);
  assert.equal(output.driver, 1);
  assert.equal(output.spawn, 2);
  assert.deepEqual(durableRunSnapshot(fixture.project, fixture.runId), beforeA);
  assert.deepEqual(durableRunSnapshot(fixture.project, siblingRunId), beforeB);
  const markerLines = readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(markerLines.length, 4);
  assert.match(markerLines[0], new RegExp(`^probe-entry-v1:${fixture.runId}:file:///proc/self/fd/3/scripts/deep-loop\\.mjs$`));
  assert.match(markerLines[1], new RegExp(`^probe-transitive-v1:${fixture.runId}:file:///proc/self/fd/3/scripts/lib/child-transitive\\.mjs$`));
  assert.match(markerLines[2], new RegExp(`^driver-entry-v1:${fixture.runId}:file:///proc/self/fd/3/scripts/hooks-impl/drive-headless\\.mjs$`));
  assert.match(markerLines[3], new RegExp(`^driver-transitive-v1:${fixture.runId}:file:///proc/self/fd/3/scripts/lib/child-transitive\\.mjs$`));
});

test('A-only driver uses the real staged production source and leaves persistent B untouched', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const records = productionSourceRecords();
  assert.ok(Object.keys(records).length > 17, 'production fixture must include the complete source inventory');
  const fixture = seedTrustedFixture({ records });
  const { runId: siblingRunId } = initRun(fixture.project, {
    runtime: 'claude', goal: 'production sibling fixture', detected: {},
    review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false },
    now: new Date('2026-06-24T00:00:03.000Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const siblingDir = join(fixture.project, '.deep-loop', 'runs', siblingRunId);
  mkdirSync(join(siblingDir, 'transactions', 'prepared-sibling'), { recursive: true });
  writeFileSync(join(siblingDir, 'transactions', 'prepared-sibling', 'prepared.json'), '{"foreign":"prepared"}\n');
  writeFileSync(join(fixture.project, '.deep-loop', 'current'), `${siblingRunId}\n`);
  const beforeA = durableRunSnapshot(fixture.project, fixture.runId);
  const beforeB = durableRunSnapshot(fixture.project, siblingRunId);
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1',
  });
  assert.equal(result.status, 0, result.stdout);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.kind, 'trusted-fd-execution');
  assert.equal(output.run_id, fixture.runId);
  assert.equal(output.project_root, fixture.project);
  assert.equal(output.probe, 1);
  assert.equal(output.driver, 1);
  assert.equal(output.mutation, 0);
  assert.deepEqual(durableRunSnapshot(fixture.project, fixture.runId), beforeA);
  assert.deepEqual(durableRunSnapshot(fixture.project, siblingRunId), beforeB);
  assert.deepEqual(readdirSync(fixture.workspace), [], 'ordinary target workspace remains source-empty');
});

test('target checkout may omit plugin scripts when candidate root is valid', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
  assert.deepEqual(readdirSync(fixture.workspace), [], 'ordinary target workspace is not the candidate source');
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1',
    DEEP_LOOP_CHILD_V1_MARKER: join(fixture.base, 'target-without-source.log'),
  });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout.trim()).kind, 'trusted-fd-execution');
});

test('persisted probe root and run identity reject wrong argv', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  for (const override of [
    { DEEP_LOOP_TEST_PROBE_PROJECT_ROOT: join(tmpdir(), 'wrong-probe-root') },
    { DEEP_LOOP_TEST_PROBE_RUN_ID: '01J00000000000000000000000' },
  ]) {
    const result = runTrustedVerifier(seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS }), {
      DEEP_LOOP_RUN_CHILDREN: '1', ...override,
    });
    assert.equal(result.status, 1, result.stdout);
    const diagnostic = JSON.parse(result.stdout.trim());
    assert.equal(diagnostic.probe, 1);
    assert.equal(diagnostic.driver, 0);
  }
});

test('persisted same-project sibling B cannot override probe A', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
  const { runId: siblingRunId } = initRun(fixture.project, {
    runtime: 'claude', goal: 'trusted sibling fixture', detected: {},
    review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false },
    now: new Date('2026-06-24T00:00:03.000Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1', DEEP_LOOP_TEST_PROBE_RUN_ID: siblingRunId,
  });
  assert.equal(result.status, 1, result.stdout);
  const diagnostic = JSON.parse(result.stdout.trim());
  assert.equal(diagnostic.probe, 1);
  assert.equal(diagnostic.driver, 0);
});

test('post-final-parent swap does not import V2', () => {
  const source = trustedWorkflowSource();
  assert.match(source, /verifyCandidateStillMatches\(\);[\s\S]{0,500}verifyStage\(\);/);
  assert.match(source, /DEEP_LOOP_TEST_POST_FINAL_SWAP/);
  assert.match(source, /DEEP_LOOP_ROOT\s*=\s*fdRoot/);
  assert.doesNotMatch(source, /DEEP_LOOP_CANDIDATE_ROOT[\s\S]{0,120}import/);
});

test('post-final-parent V2 pathname swap remains V1-bound', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
  const marker = join(fixture.base, 'child-v1.log');
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1',
    DEEP_LOOP_CHILD_V1_MARKER: marker,
    DEEP_LOOP_TEST_POST_FINAL_SWAP: '1',
    DEEP_LOOP_TEST_POST_FINAL_V2: '1',
  });
  assert.equal(result.status, 0, result.stdout);
  const markerText = readFileSync(marker, 'utf8');
  assert.doesNotMatch(markerText, /v2-imported/);
  assertAllFdMarkerUrls(marker, fixture.runId);
});

test('mid-transitive swap does not import V2', () => {
  const source = trustedWorkflowSource();
  assert.match(source, /pathToFileURL\(fdEntry\)\.href/);
  assert.match(source, /fdRoot/);
  assert.doesNotMatch(source, /DEEP_LOOP_TEST_MID_TRANSITIVE_SWAP|DEEP_LOOP_TEST_MID_TRANSITIVE_V2|mid-old/);
  assert.doesNotMatch(source, /import\([^)]*publicRoot/);
});

test('mid-transitive V2 pathname swap remains V1-bound', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
  const marker = join(fixture.base, 'child-v1.log');
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1',
    DEEP_LOOP_CHILD_V1_MARKER: marker,
    DEEP_LOOP_TEST_MID_TRANSITIVE_SWAP: '1',
    DEEP_LOOP_TEST_MID_TRANSITIVE_V2: '1',
  });
  assert.equal(result.status, 0, result.stdout);
  const markerText = readFileSync(marker, 'utf8');
  assert.doesNotMatch(markerText, /v2-imported/);
  assertAllFdMarkerUrls(marker, fixture.runId);
});

test('pre-check rename is configuration-invalid', () => {
  const source = trustedWorkflowSource();
  assert.match(source, /DEEP_LOOP_TEST_PRECHECK_RENAME/);
  assert.match(source, /bootstrap public root mismatch/);
  assert.match(source, /source-preflight-invalid/);
});

test('pre-check rename rejects before any entrypoint import', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
  const marker = join(fixture.base, 'precheck.marker');
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1', DEEP_LOOP_TEST_PRECHECK_RENAME: '1', DEEP_LOOP_CHILD_V1_MARKER: marker,
  });
  assertConfigurationInvalid(result);
  assert.equal(existsSync(marker), false);
});

test('stage symlink alias is rejected before a child can run', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const result = runTrustedVerifier(seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS }), {
    DEEP_LOOP_RUN_CHILDREN: '1',
    DEEP_LOOP_TEST_STAGE_SYMLINK: '1',
  });
  assertConfigurationInvalid(result);
});

test('probe timeout kills the whole process group and never starts the driver', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async () => {
  const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
  const pidFile = join(fixture.base, 'descendant.pid');
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_RUN_CHILDREN: '1',
    DEEP_LOOP_CHILD_DESCENDANT: '1',
    DEEP_LOOP_CHILD_PID_FILE: pidFile,
    DEEP_LOOP_TEST_CHILD_TIMEOUT_MS: '100',
  });
  assert.equal(result.status, 1, result.stdout);
  const diagnostic = JSON.parse(result.stdout.trim());
  assert.equal(diagnostic.kind, 'github-actions-configuration-invalid');
  assert.equal(diagnostic.reason, 'probe-exit-timeout');
  assert.equal(diagnostic.probe, 1);
  assert.equal(diagnostic.driver, 0);
  assert.equal(diagnostic.mutation, 0);
  const descendantPid = Number(readFileSync(pidFile, 'utf8'));
  let gone = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { process.kill(descendantPid, 0); } catch (error) { if (error?.code === 'ESRCH') { gone = true; break; } }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(gone, true, `descendant ${descendantPid} survived process-group termination`);
});

test('stdout and stderr overflow are bounded child failures', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  for (const [envName, reason] of [
    ['DEEP_LOOP_CHILD_STDOUT_OVERFLOW', 'child-stdout-overflow'],
    ['DEEP_LOOP_CHILD_STDERR_OVERFLOW', 'child-stderr-overflow'],
  ]) {
    const result = runTrustedVerifier(seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS }), {
      DEEP_LOOP_RUN_CHILDREN: '1', [envName]: '1', DEEP_LOOP_TEST_CHILD_TIMEOUT_MS: '1000',
    });
    assert.equal(result.status, 1, result.stdout);
    const diagnostic = JSON.parse(result.stdout.trim());
    assert.equal(diagnostic.reason, reason);
    assert.equal(diagnostic.driver, 0);
  }
});

test('driver stdout and stderr overflow are independently bounded', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  for (const [envName, reason] of [
    ['DEEP_LOOP_CHILD_DRIVER_STDOUT_OVERFLOW', 'child-stdout-overflow'],
    ['DEEP_LOOP_CHILD_DRIVER_STDERR_OVERFLOW', 'child-stderr-overflow'],
  ]) {
    const result = runTrustedVerifier(seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS }), {
      DEEP_LOOP_RUN_CHILDREN: '1', [envName]: '1', DEEP_LOOP_TEST_CHILD_TIMEOUT_MS: '1000',
    });
    assert.equal(result.status, 1, result.stdout);
    const diagnostic = JSON.parse(result.stdout.trim());
    assert.equal(diagnostic.reason, reason);
    assert.equal(diagnostic.probe, 1);
    assert.equal(diagnostic.driver, 1);
  }
});

test('driver timeout and startup failure are bounded with no later child', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const timeout = runTrustedVerifier(seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS }), {
    DEEP_LOOP_RUN_CHILDREN: '1', DEEP_LOOP_CHILD_DRIVER_HANG: '1', DEEP_LOOP_TEST_CHILD_TIMEOUT_MS: '100',
  });
  assert.equal(timeout.status, 1, timeout.stdout);
  const timeoutDiagnostic = JSON.parse(timeout.stdout.trim());
  assert.equal(timeoutDiagnostic.reason, 'driver-exit-timeout');
  assert.equal(timeoutDiagnostic.probe, 1);
  assert.equal(timeoutDiagnostic.driver, 1);

  const startup = runTrustedVerifier(seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS }), {
    DEEP_LOOP_RUN_CHILDREN: '1', DEEP_LOOP_TEST_CHILD_STARTUP_FAILURE: '1',
  });
  assert.equal(startup.status, 1, startup.stdout);
  const startupDiagnostic = JSON.parse(startup.stdout.trim());
  assert.equal(startupDiagnostic.reason, 'child-startup-timeout');
  assert.equal(startupDiagnostic.probe, 0);
  assert.equal(startupDiagnostic.driver, 0);
});

test('forced settlement reports termination failure at the fixed deadline', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  const result = runTrustedVerifier(seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS }), {
    DEEP_LOOP_RUN_CHILDREN: '1', DEEP_LOOP_TEST_GROUP_NEVER_GONE: '1', DEEP_LOOP_TEST_CHILD_TIMEOUT_MS: '100',
  });
  assert.equal(result.status, 1, result.stdout);
  const diagnostic = JSON.parse(result.stdout.trim());
  assert.equal(diagnostic.reason, 'child-termination-failed');
  assert.equal(diagnostic.driver, 0);
});

const SOURCE_HEADER = Buffer.from('646565702d6c6f6f702d706c7567696e2d736f757263652d763100', 'hex');
const FIXTURE_RECORDS = Object.freeze({
  '.claude-plugin/plugin.json': '{"name":"deep-loop","version":"1.14.0"}\n',
  '.codex-plugin/plugin.json': '{"name":"deep-loop","version":"1.14.0"}\n',
  'hooks/hooks.json': '{"fixture":"hooks"}\n',
  'package.json': '{"name":"deep-loop","version":"1.14.0"}\n',
  'protocols/deep-work.json': '{"fixture":"deep-work"}\n',
  'recipes/automation/github-actions-loop.yml': 'fixture: github-actions-loop\n',
  'recipes/hillclimb-ledger.json': '{"fixture":"hillclimb-ledger"}\n',
  'recipes/triage-and-discovery.json': '{"fixture":"triage-and-discovery"}\n',
  'schemas/loop-run.schema.json': '{"fixture":"loop-run"}\n',
  'schemas/review-import.schema.json': '{"fixture":"review-import"}\n',
  'scripts/deep-loop.mjs': 'export const fixture = 1;\n',
  'scripts/hooks-impl/drive-headless.mjs': 'export const fixture = 2;\n',
  'scripts/lib/headless-host.mjs': 'export const fixture = 3;\n',
  'skills/deep-loop-continue/SKILL.md': 'fixture-skill-continue\n',
  'skills/deep-loop-resume/SKILL.md': 'fixture-skill-resume\n',
  'skills/deep-loop-workflow/references/adapters.md': 'fixture-reference-adapters\n',
  'skills/deep-loop-workflow/references/contracts/HILLCLIMB-001.yaml': 'fixture-contract-hillclimb\n',
});
const CHILD_EXECUTION_RECORDS = Object.freeze({
  ...FIXTURE_RECORDS,
  'scripts/lib/child-transitive.mjs': "import fs from 'node:fs'; export function record(prefix) { if (process.env.DEEP_LOOP_CHILD_V1_MARKER) fs.appendFileSync(process.env.DEEP_LOOP_CHILD_V1_MARKER, `${prefix}:${import.meta.url}\\n`); }\n",
  'scripts/deep-loop.mjs': "import fs from 'node:fs'; import path from 'node:path'; import childProcess from 'node:child_process'; const projectIndex = process.argv.indexOf('--project-root'); const runIndex = process.argv.indexOf('--run-id'); if (projectIndex < 0 || runIndex < 0) process.exit(2); const projectRoot = process.argv[projectIndex + 1]; const runId = process.argv[runIndex + 1]; const loop = JSON.parse(fs.readFileSync(path.join(projectRoot, '.deep-loop', 'runs', runId, 'loop.json'), 'utf8')); if (loop.run_id !== runId || runId !== process.env.DEEP_LOOP_RUN_ID || loop.project?.root !== projectRoot) process.exit(3); if (process.env.DEEP_LOOP_CHILD_V1_MARKER) fs.appendFileSync(process.env.DEEP_LOOP_CHILD_V1_MARKER, `probe-entry-v1:${runId}:${import.meta.url}\\n`); let publicStage = null; let midOld = null; if (process.env.DEEP_LOOP_TEST_MID_TRANSITIVE_SWAP === '1') { publicStage = fs.realpathSync('/proc/self/fd/3'); midOld = `${publicStage}.fixture-mid-old-${process.pid}`; fs.renameSync(publicStage, midOld); fs.cpSync(midOld, publicStage, { recursive: true, errorOnExist: true, force: false }); const v2Path = path.join(publicStage, 'scripts/lib/child-transitive.mjs'); fs.chmodSync(v2Path, 0o644); fs.writeFileSync(v2Path, \"import fs from 'node:fs'; export function record() { if (process.env.DEEP_LOOP_CHILD_V1_MARKER) fs.appendFileSync(process.env.DEEP_LOOP_CHILD_V1_MARKER, 'v2-imported\\\\n'); }\\n\"); fs.chmodSync(v2Path, 0o444); } try { const { record } = await import('./lib/child-transitive.mjs'); record(`probe-transitive-v1:${runId}`); } finally { if (midOld) { const retained = `${midOld}.new-${process.pid}`; fs.renameSync(publicStage, retained); fs.renameSync(midOld, publicStage); } } if (process.env.DEEP_LOOP_CHILD_STDOUT_OVERFLOW) process.stdout.write('x'.repeat(1048577)); if (process.env.DEEP_LOOP_CHILD_STDERR_OVERFLOW) process.stderr.write('x'.repeat(65537)); if (process.env.DEEP_LOOP_CHILD_DESCENDANT) { const descendant = childProcess.spawn(process.execPath, ['--input-type=module', '--eval', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)\"], { stdio: 'ignore' }); if (process.env.DEEP_LOOP_CHILD_PID_FILE) fs.writeFileSync(process.env.DEEP_LOOP_CHILD_PID_FILE, String(descendant.pid)); setTimeout(() => {}, 60000); } process.stdout.write(JSON.stringify(loop.project.root) + '\\n');\n",
  'scripts/hooks-impl/drive-headless.mjs': "import fs from 'node:fs'; const projectIndex = process.argv.indexOf('--project-root'); const runIndex = process.argv.indexOf('--run-id'); if (projectIndex < 0 || runIndex < 0 || process.argv[runIndex + 1] !== process.env.DEEP_LOOP_RUN_ID) process.exit(3); const runId = process.argv[runIndex + 1]; if (process.env.DEEP_LOOP_CHILD_V1_MARKER) fs.appendFileSync(process.env.DEEP_LOOP_CHILD_V1_MARKER, `driver-entry-v1:${runId}:${import.meta.url}\\n`); const { record } = await import('../lib/child-transitive.mjs'); record(`driver-transitive-v1:${runId}`); if (process.env.DEEP_LOOP_CHILD_DRIVER_STDOUT_OVERFLOW) process.stdout.write('x'.repeat(1048577)); if (process.env.DEEP_LOOP_CHILD_DRIVER_STDERR_OVERFLOW) process.stderr.write('x'.repeat(65537)); if (process.env.DEEP_LOOP_CHILD_DRIVER_HANG) setTimeout(() => {}, 60000);\n",
});
function fixtureDigest(records = FIXTURE_RECORDS, header = SOURCE_HEADER) {
  const chunks = [header];
  for (const rel of Object.keys(records).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))) {
    const p = Buffer.from(rel); const bytes = Buffer.from(records[rel]);
    const pl = Buffer.alloc(8); pl.writeBigUInt64BE(BigInt(p.length));
    const cl = Buffer.alloc(8); cl.writeBigUInt64BE(BigInt(bytes.length));
    chunks.push(pl, p, cl, bytes);
  }
  return crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
}

function productionSourceRecords() {
  const records = {};
  const walk = relDir => {
    const absoluteDir = join(REPO_ROOT, relDir);
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const rel = join(relDir, entry.name).split('\\').join('/');
      const absolute = join(REPO_ROOT, rel);
      if (entry.isDirectory()) walk(rel);
      else {
        assert.equal(entry.isFile(), true, `production source inventory must contain regular files: ${rel}`);
        const stat = lstatSync(absolute);
        assert.equal(stat.isSymbolicLink(), false, `production source inventory must reject aliases: ${rel}`);
        records[rel] = readFileSync(absolute);
      }
    }
  };
  for (const root of ['scripts', 'skills', 'schemas', 'protocols', 'recipes', 'hooks']) walk(root);
  for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'package.json']) {
    const stat = lstatSync(join(REPO_ROOT, rel));
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `production metadata must be regular: ${rel}`);
    records[rel] = readFileSync(join(REPO_ROOT, rel));
  }
  return Object.freeze(records);
}
function seedTrustedFixture({
  records = FIXTURE_RECORDS,
  workspaceOverlap = false,
  anchoredEvent = false,
  committedPublication = false,
  genericPublication = false,
  genericArtifactRel = 'artifacts/safe.txt',
} = {}) {
  let fixtureParent = tmpdir();
  if (process.platform === 'linux' && process.arch === 'x64') {
    try {
      const home = homedir();
      const stat = lstatSync(home);
      if (stat.isDirectory() && (stat.mode & 0o022) === 0) fixtureParent = home;
    } catch { /* portable fallback keeps non-Linux fixtures available */ }
  }
  const base = mkdtempSync(join(fixtureParent, 'dl-github-source-'));
  const candidate = join(base, 'candidate'); const stageParent = join(base, 'stage-parent');
  const project = join(base, 'project'); const workspace = workspaceOverlap ? project : join(base, 'workspace');
  mkdirSync(candidate, { recursive: true }); mkdirSync(stageParent); mkdirSync(project, { recursive: true });
  if (!workspaceOverlap) mkdirSync(workspace);
  for (const rel of Object.keys(records)) {
    const absolute = join(candidate, rel); mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, records[rel]);
  }
  const { runId } = initRun(project, {
    runtime: 'claude', goal: 'trusted source fixture', detected: {},
    review: { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false },
    now: new Date('2026-06-24T00:00:00.000Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  if (anchoredEvent) appendAnchored(project, runId, {
    type: 'seed-event', data: { fixture: true }, now: new Date('2026-06-24T00:00:01.000Z'),
  }, () => {});
  if (genericPublication) {
    const genericPublicationResult = appendAnchored(project, runId, {
      type: 'generic-publication-fixture', data: { fixture: true }, now: new Date('2026-06-24T00:00:01.000Z'),
    }, () => {}, undefined, {
      publication: {
        kind: 'generic-publication',
        operationId: 'generic-automation-publication',
        artifacts: [{ rel: genericArtifactRel, bytes: Buffer.from('generic artifact\n') }],
        topology: { fixture: 'generic' },
      },
    });
    if (!genericPublicationResult?.ok) throw new Error('failed to create generic committed fixture');
  }
  if (committedPublication) {
    const fence = { owner: runId, generation: 1, intent: 'business' };
    const worktree = '.claude/worktrees/closure';
    mkdirSync(join(project, worktree), { recursive: true });
    const ws = newWorkstream(project, runId, {
      title: 'automation journal fixture', branch: 'feature/automation-journal', worktree, fence,
    }).id;
    newWorkstream(project, runId, {
      title: 'automation journal sibling', branch: 'feature/automation-sibling',
      worktree: '.claude/worktrees/sibling', fence,
    });
    const artifact = `${worktree}/baseline-review.md`;
    writeFileSync(join(project, artifact), '# baseline review\n');
    const maker = newEpisode(project, runId, {
      plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
      workstream: ws, expectedArtifacts: [artifact], fence,
    }).id;
    recordEpisode(project, runId, maker, { status: 'in_progress', fence });
    recordEpisode(project, runId, maker, { status: 'done', artifacts: [artifact], proof: {}, fence });
    const checker = dispatchReview(project, runId, {
      point: 'implementation', workstreamId: ws, detected: {}, fence,
    }).checkerEpisodeId;
    const report = `${worktree}/checker-review.md`;
    writeFileSync(join(project, report), '# checker review\nAPPROVE\n');
    recordReviewOutcome(project, runId, {
      episodeId: checker, verdict: 'APPROVE', proof: { report }, fence,
    });
    recordWorkstreamTerminal(project, runId, ws, {
      status: 'ready', proof: {}, fence, now: Date.parse('2026-06-24T00:00:01.000Z'),
    });
    const { data } = readState(project, runId);
    const boundary = data.session_chain.sessions.find(session => session.run_id === runId).scope.terminal_event;
    const emitted = emitHandoff(project, runId, {
      boundaryEvent: boundary, reason: 'workstream-terminal', trigger: 'automation-journal-fixture',
      now: Date.parse('2026-06-24T00:00:02.000Z'), expect: { owner: runId, generation: 1 }, env: {},
    });
    if (!emitted.ok) throw new Error(`failed to create committed fixture: ${JSON.stringify(emitted)}`);
  }
  const canonicalFixturePath = realpathSync.native || realpathSync;
  return { base: canonicalFixturePath(base), candidate: canonicalFixturePath(candidate), stageParent: canonicalFixturePath(stageParent),
    project: canonicalFixturePath(project), workspace: canonicalFixturePath(workspace), runId, digest: fixtureDigest(records) };
}
function runTrustedVerifier(fixture, options = {}) {
  const env = {
    ...process.env,
    DEEP_LOOP_CANDIDATE_ROOT: fixture.candidate, DEEP_LOOP_STAGE_PARENT: fixture.stageParent,
    DEEP_LOOP_PROJECT_ROOT: fixture.project, DEEP_LOOP_CANONICAL_PROJECT_ROOT: fixture.project,
    GITHUB_WORKSPACE: fixture.workspace, DEEP_LOOP_RUN_ID: fixture.runId,
    DEEP_LOOP_EXPECTED_PLUGIN_NAME: 'deep-loop', DEEP_LOOP_EXPECTED_PLUGIN_VERSION: '1.14.0',
    DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256: fixture.digest, ...options,
  };
  const sourceDir = mkdtempSync(join(tmpdir(), 'dl-trusted-source-'));
  const sourcePath = join(sourceDir, 'trusted-workflow.mjs');
  writeFileSync(sourcePath, trustedWorkflowSource(), { mode: 0o600 });
  try {
    const stdout = execFileSync(process.execPath, [sourcePath], { encoding: 'utf8', env });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout || '') };
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
}
function durableRunSnapshot(project, runId) {
  const root = join(project, '.deep-loop', 'runs', runId);
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push([relative(root, absolute), readFileSync(absolute).toString('hex')]);
    }
  };
  walk(root);
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}
function assertAllFdMarkerUrls(marker, runId) {
  const lines = readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    `probe-entry-v1:${runId}:file:///proc/self/fd/3/scripts/deep-loop.mjs`,
    `probe-transitive-v1:${runId}:file:///proc/self/fd/3/scripts/lib/child-transitive.mjs`,
    `driver-entry-v1:${runId}:file:///proc/self/fd/3/scripts/hooks-impl/drive-headless.mjs`,
    `driver-transitive-v1:${runId}:file:///proc/self/fd/3/scripts/lib/child-transitive.mjs`,
  ]);
}
function assertConfigurationInvalid(result) {
  assert.equal(result.status, 1, result.stdout);
  const diagnostic = JSON.parse(result.stdout.trim());
  assert.equal(diagnostic.kind, 'github-actions-configuration-invalid');
  assert.equal(diagnostic.probe, 0);
  assert.equal(diagnostic.driver, 0);
  assert.equal(diagnostic.spawn, 0);
  assert.equal(diagnostic.mutation, 0);
}

test('source identity positive 17-record fixture', () => {
  const source = trustedWorkflowSource();
  assert.equal(Object.keys(FIXTURE_RECORDS).length, 17);
  assert.equal(fixtureDigest(), 'f0a6680ee6b1c6d62c449b92d12ee6ab29462daabab094ae9dba124bda16a18c');
  const fixture = seedTrustedFixture();
  const result = runTrustedVerifier(fixture);
  assert.equal(result.status, 0, result.stdout);
  const verified = JSON.parse(result.stdout.trim());
  assert.equal(verified.ok, true);
  assert.equal(verified.records, 17);
  assert.match(source, /deep-loop-plugin-source-v1/);
  assert.match(source, /f0a6680ee6b1c6d62c449b92d12ee6ab29462daabab094ae9dba124bda16a18c/);
  assert.match(source, /\.claude-plugin\/plugin\.json/);
  assert.match(source, /\.codex-plugin\/plugin\.json/);
  assert.match(source, /package\.json/);
  for (const root of ['scripts', 'skills', 'schemas', 'protocols', 'recipes', 'hooks']) {
    assert.match(source, new RegExp(`['"]${root}['"]`), `missing exact source root ${root}`);
  }
  assert.match(source, /U64BE|writeBigUInt64BE/);
  assert.match(source, /646565702d6c6f6f702d706c7567696e2d736f757263652d763100/);
  assert.match(source, /CASE_FOLD_15_1_C_F_GZIP_B64/);
  const encoded = source.match(/CASE_FOLD_15_1_C_F_GZIP_B64\s*=\s*'([^']+)'/u)?.[1];
  assert.ok(encoded, 'compressed pinned fold table is present');
  const records = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8').split(',');
  assert.equal(records.length, 1530, 'Unicode 15.1 C/F mapping record count');
  assert.ok(records.includes('c0:e0'), 'À/à fold is pinned');
  assert.ok(records.includes('3a3:3c3'), 'Σ/σ fold is pinned');
  assert.ok(records.includes('df:73.73'), 'ß/ss fold is pinned');
});

test('authentic anchored event-log chain and head are accepted', () => {
  const result = runTrustedVerifier(seedTrustedFixture({ anchoredEvent: true }));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout.trim()).ok, true);
});

test('pinned Unicode 15.1 folds reject equivalent path collisions', () => {
  const source = trustedWorkflowSource();
  assert.match(source, /CASE_FOLD_15_1_C_F_GZIP_B64/);
  for (const [left, right] of [['ß', 'ss'], ['Σ', 'σ'], ['À', 'à']]) {
    const records = { ...FIXTURE_RECORDS, [`scripts/${left}.txt`]: 'left\n', [`scripts/${right}.txt`]: 'right\n' };
    assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture({ records }), {
      DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256: fixtureDigest(records),
    }));
  }
});

test('source identity wrong header is rejected', () => {
  const source = trustedWorkflowSource();
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_WRONG_HEADER: '1' }));
  assert.match(source, /wrong header|header/i);
  assert.match(source, /github-actions-configuration-invalid/);
  assert.match(source, /5c30|single.?NUL|trailing NUL/i);
});

test('candidate V2 before first token barrier is configuration-invalid', () => {
  const source = trustedWorkflowSource();
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_BARRIER: 'before-token' }));
  assert.match(source, /copyToken/);
  assert.match(source, /before[^\n]{0,100}(?:first|candidate)[^\n]{0,100}barrier|first[^\n]{0,100}candidate[^\n]{0,100}barrier/i);
  assert.match(source, /verifyCandidateStillMatches/);
  assert.match(source, /probe\s*[:=]\s*0|probe=0/);
});

test('candidate V2 after stage digest is configuration-invalid', () => {
  const source = trustedWorkflowSource();
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_BARRIER: 'after-stage-digest' }));
  assert.match(source, /after[^\n]{0,100}stage[^\n]{0,100}digest|stage[^\n]{0,100}digest[^\n]{0,100}after/i);
  assert.match(source, /second[^\n]{0,100}candidate|post[^\n]{0,100}probe/i);
  assert.match(source, /driver\s*[:=]\s*0|driver=0/);
});

test('missing or noncanonical candidate/stage parent is configuration-invalid', () => {
  const source = trustedWorkflowSource();
  const fixture = seedTrustedFixture();
  assertConfigurationInvalid(runTrustedVerifier(fixture, { DEEP_LOOP_CANDIDATE_ROOT: join(fixture.base, 'missing-candidate') }));
  assertConfigurationInvalid(runTrustedVerifier(fixture, { DEEP_LOOP_STAGE_PARENT: join(fixture.base, 'missing-stage-parent') }));
  for (const name of ['DEEP_LOOP_CANDIDATE_ROOT', 'DEEP_LOOP_STAGE_PARENT']) {
    assert.match(source, new RegExp(name));
  }
  assert.match(source, /missing|empty|placeholder|non.?canonical/i);
  assert.match(source, /realpath|lstat/);
  assert.match(source, /github-actions-configuration-invalid/);
});

test('wrong manifest/version/digest is configuration-invalid', () => {
  const source = trustedWorkflowSource();
  const fixture = seedTrustedFixture();
  assertConfigurationInvalid(runTrustedVerifier(fixture, { DEEP_LOOP_EXPECTED_PLUGIN_VERSION: '9.9.9' }));
  assertConfigurationInvalid(runTrustedVerifier(fixture, { DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256: '0'.repeat(64) }));
  assert.match(source, /DEEP_LOOP_EXPECTED_PLUGIN_NAME/);
  assert.match(source, /DEEP_LOOP_EXPECTED_PLUGIN_VERSION/);
  assert.match(source, /DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256/);
  assert.match(source, /manifest|package\.json|version|sha256|digest/i);
  assert.match(source, /out.?of.?band|provisioned/i);
});

test('six-root tamper is configuration-invalid', () => {
  const source = trustedWorkflowSource();
  const tampered = Object.fromEntries(Object.entries(FIXTURE_RECORDS).filter(([rel]) => !rel.startsWith('schemas/')));
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture({ records: tampered })));
  for (const root of ['scripts', 'skills', 'schemas', 'protocols', 'recipes', 'hooks']) {
    assert.match(source, new RegExp(root));
  }
  assert.match(source, /extra|missing|changed|tamper|identity/i);
  assert.match(source, /no[^\n]{0,80}(?:child|probe|driver)|probe\s*[:=]\s*0/);
});

test('source inventory rejects changed extra missing symlink and hardlink entries', () => {
  const extra = { ...FIXTURE_RECORDS, 'scripts/extra.txt': 'unexpected\n' };
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture({ records: extra }), {
    DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256: fixtureDigest(),
  }));
  const changed = { ...FIXTURE_RECORDS, 'schemas/loop-run.schema.json': '{"tampered":true}\n' };
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture({ records: changed }), {
    DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256: fixtureDigest(),
  }));
  const symlinkFixture = seedTrustedFixture();
  createDirectoryJunction(symlinkFixture.workspace, join(symlinkFixture.candidate, 'scripts', 'alias'));
  assertConfigurationInvalid(runTrustedVerifier(symlinkFixture));
  const hardlinkFixture = seedTrustedFixture();
  linkSync(join(hardlinkFixture.candidate, 'scripts', 'deep-loop.mjs'), join(hardlinkFixture.candidate, 'scripts', 'hardlink.mjs'));
  assertConfigurationInvalid(runTrustedVerifier(hardlinkFixture, {
    DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256: fixtureDigest({ ...FIXTURE_RECORDS, 'scripts/hardlink.mjs': FIXTURE_RECORDS['scripts/deep-loop.mjs'] }),
  }));
});

test('source preflight rejects retained-stage aliases, target-log residue, and directory over-cap', () => {
  const retained = seedTrustedFixture();
  createDirectoryJunction(retained.workspace, join(retained.stageParent, 'deep-loop-stage-foreign'));
  assertConfigurationInvalid(runTrustedVerifier(retained));

  const badLog = seedTrustedFixture();
  writeFileSync(join(badLog.project, '.deep-loop', 'runs', badLog.runId, 'event-log.jsonl'),
    JSON.stringify({ kind: 'foreign-run', run_id: '01J00000000000000000000001' }) + '\n');
  assertConfigurationInvalid(runTrustedVerifier(badLog));

  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_STAGE_BARRIER: '1' }));
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_METADATA_BARRIER: '1' }));

  const overCap = { ...FIXTURE_RECORDS };
  for (let index = 0; index < 4097; index += 1) overCap[`scripts/over-cap/${String(index).padStart(4, '0')}.mjs`] = `${index}\n`;
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture({ records: overCap }), {
    DEEP_LOOP_EXPECTED_PLUGIN_SOURCE_SHA256: fixtureDigest(overCap),
  }));
});

test('stage token rejects sealed root replacement with identical bytes', () => {
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_STAGE_ROOT_BARRIER: '1' }));
});

test('stage token rejects an empty directory added after capture', () => {
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_STAGE_EMPTY_BARRIER: '1' }));
});

test('pre-bootstrap stage hardlink and portable-directory corruption reject before import', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, () => {
  for (const seam of ['DEEP_LOOP_TEST_STAGE_HARDLINK_REPLACE', 'DEEP_LOOP_TEST_STAGE_NONNFC_DIR', 'DEEP_LOOP_TEST_STAGE_FOLD_DIR']) {
    const fixture = seedTrustedFixture({ records: CHILD_EXECUTION_RECORDS });
    const marker = join(fixture.base, `${seam}.marker`);
    const result = runTrustedVerifier(fixture, {
      DEEP_LOOP_RUN_CHILDREN: '1', [seam]: '1', DEEP_LOOP_CHILD_V1_MARKER: marker,
    });
    assert.equal(result.status, 1, result.stdout);
    const diagnostic = JSON.parse(result.stdout.trim());
    assert.equal(diagnostic.kind, 'github-actions-configuration-invalid');
    assert.equal(diagnostic.probe, 1, seam);
    assert.equal(diagnostic.spawn, 1, seam);
    assert.equal(diagnostic.driver, 0, seam);
    assert.equal(diagnostic.mutation, 0, seam);
    assert.equal(existsSync(marker), false, seam);
  }
});

test('candidate token rejects metadata parent replacement with moved original inode', () => {
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_METADATA_BARRIER: '1' }));
});

test('root tokens reject candidate and initial-stage same-byte swaps', () => {
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_CANDIDATE_SWAP: '1' }));
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_STAGE_INITIAL_SWAP: '1' }));
});

test('run containment rejects symlinked run directories and prepared residue', () => {
  const symlinked = seedTrustedFixture();
  const runDirectory = join(symlinked.project, '.deep-loop', 'runs', symlinked.runId);
  const moved = `${runDirectory}.real`;
  renameSync(runDirectory, moved);
  createDirectoryJunction(moved, runDirectory);
  assertConfigurationInvalid(runTrustedVerifier(symlinked));

  const prepared = seedTrustedFixture();
  const preparedDir = join(prepared.project, '.deep-loop', 'runs', prepared.runId, 'transactions', 'op-001');
  mkdirSync(preparedDir, { recursive: true });
  writeFileSync(join(preparedDir, 'prepared.json'), '{}');
  assertConfigurationInvalid(runTrustedVerifier(prepared));

  const dangling = seedTrustedFixture();
  const danglingTransactions = join(dangling.project, '.deep-loop', 'runs', dangling.runId, 'transactions');
  mkdirSync(danglingTransactions, { recursive: true });
  createDirectoryJunction('missing-operation', join(danglingTransactions, 'op-dangling'));
  assertConfigurationInvalid(runTrustedVerifier(dangling));

  const committedOnly = seedTrustedFixture();
  const committedDir = join(committedOnly.project, '.deep-loop', 'runs', committedOnly.runId, 'transactions', 'op-002');
  mkdirSync(committedDir, { recursive: true });
  writeFileSync(join(committedDir, 'committed.json'), '{}');
  assertConfigurationInvalid(runTrustedVerifier(committedOnly));

  const unprepared = seedTrustedFixture();
  const unpreparedDir = join(unprepared.project, '.deep-loop', 'runs', unprepared.runId, 'transactions', 'op-003');
  mkdirSync(join(unpreparedDir, 'stages'), { recursive: true });
  writeFileSync(join(unpreparedDir, 'owner.json'), '{}');
  assertConfigurationInvalid(runTrustedVerifier(unprepared));

  const orphan = seedTrustedFixture();
  const orphanDir = join(orphan.project, '.deep-loop', 'runs', orphan.runId, 'transactions', '.orphan-op-004-00000000-0000-4000-8000-000000000000');
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, 'owner.json'), '{}');
  assertConfigurationInvalid(runTrustedVerifier(orphan));

  const committed = seedTrustedFixture({ committedPublication: true });
  const committedResult = runTrustedVerifier(committed);
  assert.equal(committedResult.status, 0, committedResult.stdout);

  const generic = seedTrustedFixture({ genericPublication: true });
  const genericResult = runTrustedVerifier(generic);
  assert.equal(genericResult.status, 0, genericResult.stdout);
  const controlGeneric = seedTrustedFixture({
    genericPublication: true,
    genericArtifactRel: 'artifacts/control\u0001.txt',
  });
  const controlGenericResult = runTrustedVerifier(controlGeneric);
  assert.equal(controlGenericResult.status, 0, controlGenericResult.stdout);
  const forgedGeneric = seedTrustedFixture({ genericPublication: true });
  const forgedGenericRunDirectory = join(forgedGeneric.project, '.deep-loop', 'runs', forgedGeneric.runId);
  const forgedGenericOperation = readdirSync(join(forgedGenericRunDirectory, 'transactions'))[0];
  const forgedGenericOperationDirectory = join(forgedGenericRunDirectory, 'transactions', forgedGenericOperation);
  const forgedGenericPreparedPath = join(forgedGenericOperationDirectory, 'prepared.json');
  const forgedGenericPrepared = JSON.parse(readFileSync(forgedGenericPreparedPath, 'utf8'));
  const forgedGenericTarget = forgedGenericPrepared.payload.manifest.targets[0];
  const forgedGenericRel = 'a\\b';
  forgedGenericPrepared.payload.manifest.kind = 'generic-publication';
  forgedGenericTarget.rel = forgedGenericRel;
  forgedGenericTarget.predecessor = { kind: 'absent' };
  forgedGenericPrepared.payload.stages[forgedGenericTarget.stage_index].target_rel = forgedGenericRel;
  const forgedGenericStagePath = join(
    forgedGenericOperationDirectory,
    'stages',
    String(forgedGenericTarget.stage_index).padStart(6, '0') + '.bin',
  );
  writeFileSync(join(forgedGenericRunDirectory, forgedGenericRel), readFileSync(forgedGenericStagePath));
  const forgedGenericMarkerPath = join(
    forgedGenericOperationDirectory,
    'markers',
    'target-done-' + String(forgedGenericTarget.stage_index).padStart(6, '0') + '.json',
  );
  const forgedGenericMarker = JSON.parse(readFileSync(forgedGenericMarkerPath, 'utf8'));
  forgedGenericMarker.rel = forgedGenericRel;
  forgedGenericMarker.predecessor_sha256 = null;
  writeFileSync(forgedGenericMarkerPath, JSON.stringify(forgedGenericMarker));
  writeFileSync(forgedGenericPreparedPath, JSON.stringify(forgedGenericPrepared));
  assertConfigurationInvalid(runTrustedVerifier(forgedGeneric));

  const malformed = seedTrustedFixture({ committedPublication: true });
  const malformedOperation = readdirSync(join(malformed.project, '.deep-loop', 'runs', malformed.runId, 'transactions'))[0];
  writeFileSync(join(malformed.project, '.deep-loop', 'runs', malformed.runId, 'transactions', malformedOperation, 'owner.json'), '{}');
  assertConfigurationInvalid(runTrustedVerifier(malformed));

  const missingTargetDone = seedTrustedFixture({ committedPublication: true });
  const missingOperation = readdirSync(join(missingTargetDone.project, '.deep-loop', 'runs', missingTargetDone.runId, 'transactions'))[0];
  const missingMarkers = join(missingTargetDone.project, '.deep-loop', 'runs', missingTargetDone.runId, 'transactions', missingOperation, 'markers');
  rmSync(join(missingMarkers, readdirSync(missingMarkers).find(name => name.startsWith('target-done-'))));
  assertConfigurationInvalid(runTrustedVerifier(missingTargetDone));

  const tamperedArtifact = seedTrustedFixture({ committedPublication: true });
  const tamperedOperation = readdirSync(join(tamperedArtifact.project, '.deep-loop', 'runs', tamperedArtifact.runId, 'transactions'))[0];
  const tamperedPrepared = JSON.parse(readFileSync(join(tamperedArtifact.project, '.deep-loop', 'runs', tamperedArtifact.runId, 'transactions', tamperedOperation, 'prepared.json'), 'utf8'));
  const tamperedTarget = tamperedPrepared.payload.manifest.targets[0];
  writeFileSync(join(tamperedArtifact.project, '.deep-loop', 'runs', tamperedArtifact.runId, tamperedTarget.rel), 'tampered artifact\n');
  assertConfigurationInvalid(runTrustedVerifier(tamperedArtifact));

  const tamperedCandidateStage = seedTrustedFixture({ committedPublication: true });
  const candidateOperation = readdirSync(join(tamperedCandidateStage.project, '.deep-loop', 'runs', tamperedCandidateStage.runId, 'transactions'))[0];
  const candidatePrepared = JSON.parse(readFileSync(join(tamperedCandidateStage.project, '.deep-loop', 'runs', tamperedCandidateStage.runId, 'transactions', candidateOperation, 'prepared.json'), 'utf8'));
  const candidateIndex = candidatePrepared.payload.stages.findIndex(stage => stage.role === 'candidate-loop');
  writeFileSync(join(tamperedCandidateStage.project, '.deep-loop', 'runs', tamperedCandidateStage.runId, 'transactions', candidateOperation, 'stages', `${String(candidateIndex).padStart(6, '0')}.bin`), 'tampered candidate\n');
  assertConfigurationInvalid(runTrustedVerifier(tamperedCandidateStage));

  const forgedTopology = seedTrustedFixture({ committedPublication: true });
  const forgedOperation = readdirSync(join(forgedTopology.project, '.deep-loop', 'runs', forgedTopology.runId, 'transactions'))[0];
  const forgedPreparedPath = join(forgedTopology.project, '.deep-loop', 'runs', forgedTopology.runId, 'transactions', forgedOperation, 'prepared.json');
  const forgedPrepared = JSON.parse(readFileSync(forgedPreparedPath, 'utf8'));
  forgedPrepared.payload.manifest.topology.project_root_digest = '0'.repeat(64);
  writeFileSync(forgedPreparedPath, JSON.stringify(forgedPrepared));
  assertConfigurationInvalid(runTrustedVerifier(forgedTopology));

  const forgedLaunchMetadata = seedTrustedFixture({ committedPublication: true });
  const forgedLaunchOperation = readdirSync(join(forgedLaunchMetadata.project, '.deep-loop', 'runs', forgedLaunchMetadata.runId, 'transactions'))[0];
  const forgedLaunchPath = join(forgedLaunchMetadata.project, '.deep-loop', 'runs', forgedLaunchMetadata.runId, 'transactions', forgedLaunchOperation, 'prepared.json');
  const forgedLaunchPrepared = JSON.parse(readFileSync(forgedLaunchPath, 'utf8'));
  const metadataTarget = forgedLaunchPrepared.payload.manifest.targets[3];
  const metadataStagePath = join(forgedLaunchMetadata.project, '.deep-loop', 'runs', forgedLaunchMetadata.runId, 'transactions', forgedLaunchOperation, 'stages', `${String(metadataTarget.stage_index).padStart(6, '0')}.bin`);
  const forgedMetadata = JSON.parse(readFileSync(metadataStagePath, 'utf8'));
  forgedMetadata.payload.child_run_id = '01FORGEDCHILD00000000000000';
  const forgedMetadataBytes = Buffer.from(JSON.stringify(forgedMetadata));
  const forgedMetadataHash = crypto.createHash('sha256').update(forgedMetadataBytes).digest('hex');
  writeFileSync(metadataStagePath, forgedMetadataBytes);
  const metadataStage = forgedLaunchPrepared.payload.stages[metadataTarget.stage_index];
  metadataStage.sha256 = forgedMetadataHash;
  metadataStage.size = String(forgedMetadataBytes.length);
  metadataTarget.candidate_sha256 = forgedMetadataHash;
  metadataTarget.candidate_size = String(forgedMetadataBytes.length);
  writeFileSync(join(forgedLaunchMetadata.project, '.deep-loop', 'runs', forgedLaunchMetadata.runId, metadataTarget.rel), forgedMetadataBytes);
  const metadataMarkerPath = join(forgedLaunchMetadata.project, '.deep-loop', 'runs', forgedLaunchMetadata.runId, 'transactions', forgedLaunchOperation, 'markers', `target-done-${String(metadataTarget.stage_index).padStart(6, '0')}.json`);
  const metadataMarker = JSON.parse(readFileSync(metadataMarkerPath, 'utf8'));
  metadataMarker.candidate_sha256 = forgedMetadataHash;
  writeFileSync(metadataMarkerPath, JSON.stringify(metadataMarker));
  writeFileSync(forgedLaunchPath, JSON.stringify(forgedLaunchPrepared));
  assertConfigurationInvalid(runTrustedVerifier(forgedLaunchMetadata));

  const forgedProject = seedTrustedFixture({ committedPublication: true });
  const forgedProjectOperation = readdirSync(join(forgedProject.project, '.deep-loop', 'runs', forgedProject.runId, 'transactions'))[0];
  const forgedProjectPath = join(forgedProject.project, '.deep-loop', 'runs', forgedProject.runId, 'transactions', forgedProjectOperation, 'prepared.json');
  const forgedProjectPrepared = JSON.parse(readFileSync(forgedProjectPath, 'utf8'));
  forgedProjectPrepared.payload.manifest.projectRoot = join(forgedProject.base, 'foreign-project');
  writeFileSync(forgedProjectPath, JSON.stringify(forgedProjectPrepared));
  assertConfigurationInvalid(runTrustedVerifier(forgedProject));

  const duplicateEvent = seedTrustedFixture({ committedPublication: true });
  const duplicateOperation = readdirSync(join(duplicateEvent.project, '.deep-loop', 'runs', duplicateEvent.runId, 'transactions'))[0];
  const duplicatePath = join(duplicateEvent.project, '.deep-loop', 'runs', duplicateEvent.runId, 'transactions', duplicateOperation, 'prepared.json');
  const duplicatePrepared = JSON.parse(readFileSync(duplicatePath, 'utf8'));
  duplicatePrepared.payload.manifest.eventLines.push({ ...duplicatePrepared.payload.manifest.eventLines[0] });
  writeFileSync(duplicatePath, JSON.stringify(duplicatePrepared));
  assertConfigurationInvalid(runTrustedVerifier(duplicateEvent));

  const orphanStage = seedTrustedFixture({ committedPublication: true });
  const orphanStageOperation = readdirSync(join(orphanStage.project, '.deep-loop', 'runs', orphanStage.runId, 'transactions'))[0];
  writeFileSync(join(orphanStage.project, '.deep-loop', 'runs', orphanStage.runId, 'transactions', orphanStageOperation, 'stages', '999999.bin'), 'orphan stage\n');
  assertConfigurationInvalid(runTrustedVerifier(orphanStage));

  const illegalReplaceIntent = seedTrustedFixture({ committedPublication: true });
  const illegalOperation = readdirSync(join(illegalReplaceIntent.project, '.deep-loop', 'runs', illegalReplaceIntent.runId, 'transactions'))[0];
  const illegalPreparedPath = join(illegalReplaceIntent.project, '.deep-loop', 'runs', illegalReplaceIntent.runId, 'transactions', illegalOperation, 'prepared.json');
  const illegalPrepared = JSON.parse(readFileSync(illegalPreparedPath, 'utf8'));
  const illegalTarget = illegalPrepared.payload.manifest.targets[0];
  writeFileSync(join(illegalReplaceIntent.project, '.deep-loop', 'runs', illegalReplaceIntent.runId, 'transactions', illegalOperation, 'markers', `replace-intent-${String(illegalTarget.stage_index).padStart(6, '0')}.json`), JSON.stringify({
    kind: 'replace-intent', stage_index: illegalTarget.stage_index, rel: illegalTarget.rel,
    candidate_sha256: illegalTarget.candidate_sha256, predecessor_sha256: null,
  }));
  assertConfigurationInvalid(runTrustedVerifier(illegalReplaceIntent));

  const sameBytesNewInode = seedTrustedFixture({ committedPublication: true });
  const sameInodeOperation = readdirSync(join(sameBytesNewInode.project, '.deep-loop', 'runs', sameBytesNewInode.runId, 'transactions'))[0];
  const sameInodePreparedPath = join(sameBytesNewInode.project, '.deep-loop', 'runs', sameBytesNewInode.runId, 'transactions', sameInodeOperation, 'prepared.json');
  const sameInodePrepared = JSON.parse(readFileSync(sameInodePreparedPath, 'utf8'));
  const sameInodeTarget = sameInodePrepared.payload.manifest.targets[0];
  const sameInodeTargetPath = join(sameBytesNewInode.project, '.deep-loop', 'runs', sameBytesNewInode.runId, sameInodeTarget.rel);
  const predecessorStat = lstatSync(sameInodeTargetPath, { bigint: true });
  sameInodeTarget.predecessor = {
    kind: 'present', sha256: sameInodeTarget.candidate_sha256,
    identity: { dev: String(predecessorStat.dev), ino: String(predecessorStat.ino), birthtime_ns: String(predecessorStat.birthtimeNs) },
    size: sameInodeTarget.candidate_size,
  };
  const sameInodeMarkerPath = join(sameBytesNewInode.project, '.deep-loop', 'runs', sameBytesNewInode.runId, 'transactions', sameInodeOperation, 'markers', `target-done-${String(sameInodeTarget.stage_index).padStart(6, '0')}.json`);
  const sameInodeMarker = JSON.parse(readFileSync(sameInodeMarkerPath, 'utf8'));
  sameInodeMarker.predecessor_sha256 = sameInodeTarget.candidate_sha256;
  writeFileSync(sameInodePreparedPath, JSON.stringify(sameInodePrepared));
  writeFileSync(sameInodeMarkerPath, JSON.stringify(sameInodeMarker));
  const replacementPath = `${sameInodeTargetPath}.replacement`;
  writeFileSync(replacementPath, readFileSync(sameInodeTargetPath));
  renameSync(replacementPath, sameInodeTargetPath);
  assertConfigurationInvalid(runTrustedVerifier(sameBytesNewInode));
});

test('run containment rejects a nested stage file symlink', (t) => {
  const nestedSymlink = seedTrustedFixture({ committedPublication: true });
  const nestedOperation = readdirSync(join(nestedSymlink.project, '.deep-loop', 'runs', nestedSymlink.runId, 'transactions'))[0];
  const nestedStages = join(nestedSymlink.project, '.deep-loop', 'runs', nestedSymlink.runId, 'transactions', nestedOperation, 'stages');
  const nestedStage = join(nestedStages, readdirSync(nestedStages)[0]);
  renameSync(nestedStage, `${nestedStage}.real`);
  if (!createFileSymlinkOrSkip(t, `${nestedStage}.real`, nestedStage)) return;
  assertConfigurationInvalid(runTrustedVerifier(nestedSymlink));
});

test('aggregate source bound fails before reading the next file', () => {
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_MAX_FILES: '16' }));
});

test('retained scan rejects arbitrary-entry overflow and parent replacement', () => {
  const overflow = seedTrustedFixture();
  for (let index = 0; index < 65; index += 1) mkdirSync(join(overflow.stageParent, `retained-noise-${index}`));
  assertConfigurationInvalid(runTrustedVerifier(overflow));
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_RETAINED_PARENT_SWAP: '1' }));
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_STAGE_PARENT_POST_RETAINED_SWAP: '1' }));
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture(), { DEEP_LOOP_TEST_RUN_DIRECTORY_SWAP: '1' }));
});

test('target checkout without plugin root never reaches MODULE_NOT_FOUND', () => {
  const source = trustedWorkflowSource();
  const fixture = seedTrustedFixture();
  assertConfigurationInvalid(runTrustedVerifier(fixture, { DEEP_LOOP_CANDIDATE_ROOT: fixture.workspace }));
  assert.match(source, /GITHUB_WORKSPACE/);
  assert.match(source, /target[^\n]{0,100}(?:workspace|checkout|plugin root)|plugin root[^\n]{0,100}target/i);
  assert.doesNotMatch(source, /MODULE_NOT_FOUND/);
  assert.match(source, /configuration-invalid/);
});

test('workspace/project/state overlap is rejected before cleanup', () => {
  const source = trustedWorkflowSource();
  assertConfigurationInvalid(runTrustedVerifier(seedTrustedFixture({ workspaceOverlap: true })));
  assert.match(source, /DEEP_LOOP_PROJECT_ROOT/);
  assert.match(source, /GITHUB_WORKSPACE/);
  assert.match(source, /\.deep-loop/);
  assert.match(source, /ancestor|descendant|containment|disjoint|overlap/i);
  assert.doesNotMatch(source, /git\s+(?:clean|reset)|actions\/checkout|\brm\s+-rf\b|\bdelete\b/i);
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
  assert.match(s, /timeout-minutes:\s*35/);
  assert.match(s, /drive-headless\.mjs/);
  assert.match(s, /proposal-only|사람 승인|human/i);
});

test('GitHub automation provisions canonical A and isolates the ordinary target checkout', () => {
  const source = readFileSync(join(A, 'github-actions-loop.yml'), 'utf8');
  assert.match(source, /runs-on:\s*\[self-hosted,\s*deep-loop,\s*linux,\s*x64\]/);
  assert.match(source, /DEEP_LOOP_PROJECT_ROOT:\s*\$\{\{\s*vars\.DEEP_LOOP_PROJECT_ROOT\s*\}\}/);
  assert.match(source, /DEEP_LOOP_RUN_ID:\s*\$\{\{\s*vars\.DEEP_LOOP_RUN_ID\s*\}\}/);
  assert.match(source, /GITHUB_WORKSPACE/);
  assert.match(source, /persistent project\/state and candidate source roots/i);
  assert.doesNotMatch(source, /actions\/checkout|git\s+(?:clean|reset)|\brm\s+-rf\b|\.deep-loop\/current/i);
  assert.doesNotMatch(source, /vars\.DEEP_LOOP_ROOT|vars\.RUN_ID/);
});

test('GitHub canonical-root mismatch fails closed before probe or driver', () => {
  const fixture = seedTrustedFixture();
  const result = runTrustedVerifier(fixture, {
    DEEP_LOOP_CANONICAL_PROJECT_ROOT: join(fixture.base, 'wrong-canonical-project'),
  });
  assertConfigurationInvalid(result);
});

// Regression: handoff emit CLI must honor spawn_style='headless' even without --headless flag.
// Bug: CLI derived resumePolicy from ONLY --headless → autonomous loops stall (not-headless-intended).
// Fix: symmetric derivation (spawn_style + isHeadlessInvocation), same as precompact-handoff.mjs.
test('handoff emit derives resume_policy=headless from spawn_style without --headless flag (CLI regression)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  migrateAuthenticLegacyTransport(root, runId);
  // Seed spawn_style='headless' so autonomous driver knows this run is headless.
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'headless';
  writeState(root, runId, data);

  // Call handoff emit via CLI WITHOUT --headless flag — the fix must derive headless from spawn_style.
  const out = JSON.parse(execFileSync('node', [
    CLI, 'handoff', 'emit',
    '--reason', 'milestone',
    '--owner', runId, '--generation', '1',
    '--project-root', root, '--run-id', runId,
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
    migrateAuthenticLegacyTransport(root, runId);
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
  migrateAuthenticLegacyTransport(root, runId);

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
    root, runId, now: NOW1 + 2000,
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
    root, runId, now: NOW1 + 2000,
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
    root, runId,
    now: NOW1,
    spawnFn: () => { throw new Error('must not spawn'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'terminal');
  assert.equal(JSON.stringify(readState(root, runId).data), before);   // 상태 무변
});
