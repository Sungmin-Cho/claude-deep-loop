import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync as rf, realpathSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { runPreCompactHandoff } from '../scripts/hooks-impl/precompact-handoff.mjs';
import { rollbackAndPause } from '../scripts/lib/respawn.mjs';
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { revokeAppTaskContinuation } from '../scripts/lib/app-task-continuation.mjs';
import { readVerifiedState } from '../scripts/lib/integrity.mjs';
import { rawHashValidState,
  seedCorrelatedTerminal } from './fixtures/verified-app-run.mjs';
const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRECOMPACT_HOOK = join(PROOT, 'scripts', 'hooks-impl', 'precompact-handoff.mjs');
const DRIVE_HOOK = join(PROOT, 'scripts', 'hooks-impl', 'drive-headless.mjs');
const EXPECTED_BOOTSTRAP = `node -e "const{join}=require('node:path');const{pathToFileURL}=require('node:url');const r=process.env.CLAUDE_PLUGIN_ROOT||process.env.PLUGIN_ROOT;if(!r){console.error('deep-loop: plugin root unavailable')}else{import(pathToFileURL(join(r,'scripts','hooks-impl','precompact-handoff.mjs')).href).then(m=>m.main()).catch(()=>console.error('deep-loop: precompact hook failed'))}"`;
const BOOTSTRAP_SOURCE = EXPECTED_BOOTSTRAP.slice('node -e "'.length, -1);

function events(root, runId) {
  return parseLog(join(runDir(root, runId), 'event-log.jsonl'));
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
}

function bootstrapEnv(rootName, root) {
  const env = { ...process.env };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.PLUGIN_ROOT;
  if (rootName) env[rootName] = root;
  return env;
}

function seed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
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

test('Codex ignores the Claude entrypoint heuristic when deriving precompact resume policy', async () => {
  const { root, runId } = seed('codex');
  const r = await runPreCompactHandoff({}, {
    root,
    now: Date.parse('2026-06-24T00:01:00Z'),
    env: { CLAUDE_CODE_ENTRYPOINT: 'print' },
  });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, false);
  assert.equal(readState(root, runId).data.session_chain.lease.resume_policy, 'visible');
});

test('Codex still honors an explicit driver marker in precompact mode derivation', async () => {
  const { root, runId } = seed('codex');
  const r = await runPreCompactHandoff({}, {
    root,
    now: Date.parse('2026-06-24T00:01:00Z'),
    env: { CLAUDE_CODE_ENTRYPOINT: 'print', DEEP_LOOP_HEADLESS: '1' },
  });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, true);
  assert.equal(readState(root, runId).data.session_chain.lease.resume_policy, 'headless');
});

test('Codex still honors explicit unattended input in precompact mode derivation', async () => {
  const { root, runId } = seed('codex');
  const r = await runPreCompactHandoff({ unattended: true }, {
    root,
    now: Date.parse('2026-06-24T00:01:00Z'),
    env: { CLAUDE_CODE_ENTRYPOINT: 'print' },
  });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, true);
  assert.equal(readState(root, runId).data.session_chain.lease.resume_policy, 'headless');
});

test('hooks.json contains exactly one exact static Node bootstrap and no shell expansion', () => {
  const h = JSON.parse(rf(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(h.hooks.PreCompact, 'PreCompact event present');
  assert.equal(h.hooks.PreCompact.length, 1);
  assert.equal(h.hooks.PreCompact[0].hooks.length, 1);
  const command = h.hooks.PreCompact[0].hooks[0].command;
  assert.equal(command, EXPECTED_BOOTSTRAP);
  assert.doesNotMatch(command, /bash|\.sh\b|\$\{|\$\(|`/);
});

test('static bootstrap imports a root containing spaces through either root variable, including a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-bootstrap-'));
  const linkedRoot = join(root, 'plugin root with spaces');
  createDirectoryJunction(PROOT, linkedRoot);

  for (const rootName of ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT']) {
    const result = runNode(['-e', BOOTSTRAP_SOURCE], {
      cwd: root,
      env: bootstrapEnv(rootName, linkedRoot),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('static bootstrap missing-root and import-error paths exit zero with only fixed bounded diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-bootstrap-fail-'));
  const missingRoot = runNode(['-e', BOOTSTRAP_SOURCE], { cwd: root, env: bootstrapEnv(null) });
  assert.equal(missingRoot.status, 0);
  assert.equal(missingRoot.stdout, '');
  assert.equal(missingRoot.stderr, 'deep-loop: plugin root unavailable\n');

  const importError = runNode(['-e', BOOTSTRAP_SOURCE], {
    cwd: root,
    env: bootstrapEnv('CLAUDE_PLUGIN_ROOT', join(root, 'does-not-exist')),
  });
  assert.equal(importError.status, 0);
  assert.equal(importError.stdout, '');
  assert.equal(importError.stderr, 'deep-loop: precompact hook failed\n');
});

test('the Bash wrapper is absent', () => {
  assert.equal(existsSync(join(PROOT, 'hooks', 'scripts', 'precompact-handoff.sh')), false);
});

test('precompact direct execution runs main exactly once while imports with missing or mismatched argv stay inert', () => {
  const direct = seed();
  const directResult = runNode([PRECOMPACT_HOOK], { cwd: direct.root, input: '{}' });
  assert.equal(directResult.status, 0, directResult.stderr);
  assert.equal(directResult.stdout, '');
  assert.equal(directResult.stderr, '');
  assert.equal(events(direct.root, direct.runId).filter(event => event.type === 'handoff-emitted').length, 1);

  for (const extraArgs of [[], [DRIVE_HOOK]]) {
    const imported = seed();
    const code = `await import(${JSON.stringify(pathToFileURL(PRECOMPACT_HOOK).href)})`;
    const result = runNode(['--input-type=module', '--eval', code, ...extraArgs], { cwd: imported.root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(events(imported.root, imported.runId).filter(event => event.type === 'handoff-emitted').length, 0);
  }
});

test('drive-headless direct execution writes one JSON result and imports with missing or mismatched argv stay inert', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-drive-main-'));
  const direct = runNode([DRIVE_HOOK], { cwd: root });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stderr, '');
  assert.equal(direct.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(direct.stdout), { ok: true, action: 'no-run' });

  for (const extraArgs of [[], [PRECOMPACT_HOOK]]) {
    const code = `await import(${JSON.stringify(pathToFileURL(DRIVE_HOOK).href)})`;
    const result = runNode(['--input-type=module', '--eval', code, ...extraArgs], { cwd: root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('precompact invalid JSON exits zero with one fixed bounded diagnostic', () => {
  const result = runNode([PRECOMPACT_HOOK], { cwd: mkdtempSync(join(tmpdir(), 'dl-pc-json-')), input: '{' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'deep-loop: precompact hook failed\n');
});

test('precompact invalid input root exits zero with one fixed bounded diagnostic', () => {
  const result = runNode([PRECOMPACT_HOOK], {
    cwd: mkdtempSync(join(tmpdir(), 'dl-pc-root-')),
    input: JSON.stringify({ cwd: 42 }),
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'deep-loop: precompact hook failed\n');
});

test('precompact driver failure exits zero with one fixed bounded diagnostic', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc-driver-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), 'missing-run');
  const result = runNode([PRECOMPACT_HOOK], { cwd: root, input: '{}' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'deep-loop: precompact hook failed\n');
});

test('precompact stdin is bounded and overflow exits zero with one fixed diagnostic', () => {
  const oversizedValidJson = Buffer.concat([
    Buffer.from('{}'),
    Buffer.alloc(1_048_577, 0x20),
  ]);
  const result = runNode([PRECOMPACT_HOOK], {
    cwd: mkdtempSync(join(tmpdir(), 'dl-pc-bound-')),
    input: oversizedValidJson,
    maxBuffer: 2_097_152,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'deep-loop: precompact hook failed\n');
});

test('precompact exported main does not call process.exit', () => {
  const source = rf(PRECOMPACT_HOOK, 'utf8');
  assert.match(source, /export\s+async\s+function\s+main\s*\(/);
  assert.doesNotMatch(source, /process\.exit\s*\(/);
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

test('gate-blocked precompact propagates a terminal rollback race without changing terminal state', async () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.circuit_breaker.tripped = true;
  writeState(root, runId, data);

  let terminalSnapshot;
  const rollbackFn = (rollbackRoot, rollbackRunId, options) => {
    seedCorrelatedTerminal(rollbackRoot, rollbackRunId, { status: 'completed' });
    terminalSnapshot = structuredClone(readState(rollbackRoot, rollbackRunId).data);
    return rollbackAndPause(rollbackRoot, rollbackRunId, options);
  };

  const r = await runPreCompactHandoff({ unattended: true }, {
    root,
    now: Date.parse('2026-06-24T00:01:00Z'),
    env: {},
    rollbackFn,
  });
  assert.deepEqual(r, { ok: false, action: 'terminal', reason: 'RUN_TERMINAL' });
  assert.deepEqual(readState(root, runId).data, terminalSnapshot);
});

function parseLog(path) {
  try { return rf(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

// ── v1.6: terminal run에서 PreCompact 훅 graceful 거부 (spec §4-4③) ──────────
test('terminal run → hook returns ok:false action:fenced RUN_TERMINAL (graceful, no write)', async () => {
  const { root, runId } = seed();
  seedCorrelatedTerminal(root, runId, { status: 'completed' });
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-09T00:01:00Z') });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fenced');
  assert.equal(r.reason, 'RUN_TERMINAL');
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'idle');   // 예약 잔여 없음
});

function appPrecompactSeed11b() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-precompact-')));
  const observed = '2026-07-13T00:00:00.000Z';
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g',
    now: new Date(observed), cwdFn: () => root,
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context', observed_at: observed },
    appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: observed, revoked_at: null } });
  return { root, runId };
}

test('PreCompact exact App authority is emit-only and bypasses every generic branch', async () => {
  const fixture = appPrecompactSeed11b();
  let gates = 0; let rollbacks = 0;
  const result = await runPreCompactHandoff({ unattended: true }, {
    root: fixture.root, cwdFn: () => fixture.root,
    emitFn: (_root, _runId, options) => {
      assert.equal(options.appIntent, true);
      return { ok: true, childRunId: '01JAPPCHD00000000000000015',
        key: 'key', handoffRel: 'handoffs/next.md' };
    },
    gateFn: () => { gates += 1; return { ok: false, blocked_by: ['budget'] }; },
    rollbackFn: () => { rollbacks += 1; throw new Error('forbidden'); },
    pauseFn: () => assert.fail('exact App transport cannot pause generically') });
  assert.equal(result.action, 'emitted');
  assert.deepEqual({ gates, rollbacks }, { gates: 0, rollbacks: 0 });
});

test('PreCompact revoked App origin emits human legacy transport and preserve-pauses', async () => {
  const fixture = appPrecompactSeed11b();
  revokeAppTaskContinuation(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  const result = await runPreCompactHandoff({ unattended: true }, {
    root: fixture.root, now: Date.parse('2026-07-13T00:00:02.000Z'),
    cwdFn: () => fixture.root });
  assert.equal(result.action, 'app-authority-unconfirmed-paused');
  const loop = readVerifiedState(fixture.root, fixture.runId).data;
  assert.equal(loop.status, 'paused');
  assert.equal(loop.session_chain.lease.resume_policy, 'human');
  assert.equal(loop.session_chain.lease.handoff_transport, null);
});

test('PreCompact proves initial and generic post-emit state before gate or rollback', async () => {
  const initial = appPrecompactSeed11b();
  rawHashValidState(initial.root, initial.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:09.000Z';
  });
  let emits = 0; let gates = 0; let rollbacks = 0;
  const failed = await runPreCompactHandoff({ unattended: true }, {
    root: initial.root, emitFn: () => { emits += 1; throw new Error('forbidden'); },
    gateFn: () => { gates += 1; throw new Error('forbidden'); },
    rollbackFn: () => { rollbacks += 1; throw new Error('forbidden'); } });
  assert.equal(failed.action, 'error');
  assert.deepEqual({ emits, gates, rollbacks }, { emits: 0, gates: 0, rollbacks: 0 });

  const generic = seed('claude');
  await assert.rejects(() => runPreCompactHandoff({ unattended: true }, {
    root: generic.root,
    emitFn: (emitRoot, emitRunId, options) => {
      const emitted = emitHandoff(emitRoot, emitRunId, options);
      rawHashValidState(emitRoot, emitRunId,
        loop => { loop.event_log_head.checksum = 'f'.repeat(64); });
      return emitted;
    },
    gateFn: () => { gates += 1; throw new Error('forbidden'); },
    rollbackFn: () => { rollbacks += 1; throw new Error('forbidden'); },
  }), /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual({ gates, rollbacks }, { gates: 0, rollbacks: 0 });
});
