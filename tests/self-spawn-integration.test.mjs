/**
 * Task 13: Self-spawn end-to-end integration tests (injected runners, no real terminals).
 *
 * Covers four spec paths not exercised as a round-trip in respawn.test.mjs:
 *   (a) R14-RR  no-launcher attended round-trip
 *   (b) R12-LL  gate-blocked rollback
 *   (c)         markerless mode-gate (positive launcher, not attended → no visible spawn)
 *   (d) R5-R    cmux --command POSIX-tokenize contract
 *
 * HYGIENE: initRun seeded with {env:{}, platform:'linux', run:()=>({code:1})} so
 *   detectTerminal always returns launcher='none'; no ambient environment leaks.
 *   No real terminals, no real subprocesses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initRun } from '../scripts/lib/initrun.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';
import { driveHeadlessRun as driveHeadlessRunImpl } from '../scripts/lib/headless-host.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
import { readState, writeState, pauseRun, patch } from '../scripts/lib/state.mjs';
import { emitHandoff, buildLaunchCommand } from '../scripts/lib/handoff.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { respawn as respawnImpl } from '../scripts/lib/respawn.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

const NOW0 = new Date('2026-06-24T00:00:00Z');
const NOW1 = Date.parse('2026-06-24T01:00:00Z');

// No-op run: detectTerminal probes always fail → launcher='none'. No subprocess launched.
const noOpRun = () => ({ code: 1 });
const noSleep = () => {};

function buildPosixLaunchCommand(options) {
  return buildLaunchCommand({
    ...options,
    platform: 'linux',
    root: '/fixture-project',
    deepLoopRoot: '/fixture-deep-loop',
  });
}

function respawn(root, runId, options = {}) {
  return respawnImpl(root, runId, {
    ...options,
    platform: 'linux',
    launchCommandBuilder: options.launchCommandBuilder ?? buildPosixLaunchCommand,
  });
}

function driveHeadlessRun(options = {}) {
  return driveHeadlessRunImpl({
    ...options,
    launchCommandBuilder: options.launchCommandBuilder ?? buildPosixLaunchCommand,
    respawnFn: options.respawnFn ?? ((root, runId, respawnOptions) => {
      const identity = readState(root, runId).data.autonomy.runtime_executable_approval;
      return respawn(root, runId, {
        ...respawnOptions,
        revalidateRuntimeExecutable: stored => stored,
        runtimeRevalidationOptions: { platform: 'linux', arch: identity.arch },
      });
    }),
  });
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/** Seed a run. initRun with no-signal env so launcher is always 'none'. */
function seed(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dl-int-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: NOW0, env: {}, platform: 'linux', run: noOpRun });
  if (mutate) {
    const { data } = readState(root, runId);
    mutate(data);
    writeState(root, runId, data);
  }
  return { root, runId };
}

/** Seed with an injected positive launcher (cmux by default). */
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

// ── POSIX single-quote tokenizer (spec R5-R) ─────────────────────────────────
//
// Implements the POSIX shell tokenization rules needed to verify that the
// --command string produced by buildLaunchCommand(launcher='cmux') has 'claude'
// as argv[0] after tokenization. Handles:
//   • Unquoted tokens split by IFS (space/tab)
//   • Single-quoted strings: all content is literal, no escapes inside
//   • Double-quoted strings: \ escapes $`"\<newline>
//   • Backslash escaping outside quotes
//   • Adjacent-string concatenation (quote types mix into one token)
function posixTokenize(s) {
  const tokens = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      if (cur.length > 0) { tokens.push(cur); cur = ''; }
      i++;
    } else if (c === "'") {
      // Single-quoted: literal until next '. No escapes inside.
      i++;
      while (i < s.length && s[i] !== "'") { cur += s[i++]; }
      i++; // consume closing '
    } else if (c === '"') {
      // Double-quoted: backslash escapes $, `, ", \, <newline>.
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\') {
          const nx = s[i + 1];
          if (nx === '$' || nx === '`' || nx === '"' || nx === '\\' || nx === '\n') {
            cur += nx; i += 2;
          } else {
            cur += s[i++]; // literal backslash
          }
        } else {
          cur += s[i++];
        }
      }
      i++; // consume closing "
    } else if (c === '\\') {
      // Backslash outside quotes: next char is literal.
      if (i + 1 < s.length) { cur += s[i + 1]; i += 2; }
      else { i++; }
    } else {
      cur += c; i++;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

// ── Test (a): R14-RR — no-launcher attended round-trip ───────────────────────
//
// Flow:
//   1. Seed with launcher='none' (linux + noOpRun), spawn_style='visible'.
//   2. emitHandoff → reserved child.
//   3. respawn(attended=true) → mode='interactive' (launcher=none) → {ok:false, outcome:'no-launcher'}.
//      Handoff is PRESERVED (not rolled back) — skill does NOT auto-spawn.
//   4. Skill calls pauseRun(mode='preserve') → status=paused, lease stays releasing, child intact.
//   5. Reserved child calls acquireLease → SUCCEEDS, run UNPAUSES.
//   6. Business mutation (patch) SUCCEEDS with child's lease fence.
test('(R14-RR) no-launcher attended round-trip: respawn no-launcher → pauseRun preserve → child acquires → unpauses → mutation succeeds', () => {
  // Step 1: seed — launcher='none' (linux + noOpRun), spawn_style='visible' (initRun default)
  const { root, runId } = seed();
  const initState = readState(root, runId).data;
  assert.equal(initState.session_spawn.launcher, 'none', 'sanity: linux seed must detect launcher=none');
  assert.equal(initState.autonomy.spawn_style, 'visible', 'sanity: initRun defaults to spawn_style=visible');

  // Step 2: emit handoff → reserve a child
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: { owner: runId, generation: 1 } });
  assert.equal(h.ok, true, 'emitHandoff must succeed');

  // Step 3: respawn with attended=true — but launcher=none → mode='interactive' → no-launcher
  let spawnCalled = false;
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: true, env: {}, now: NOW1,
    spawnFn: () => { spawnCalled = true; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(r.ok, false, 'respawn must return ok:false for no-launcher');
  assert.equal(r.outcome, 'no-launcher', 'outcome must be no-launcher');
  assert.equal(spawnCalled, false, 'spawnFn must NOT be called for no-launcher outcome');

  // Handoff PRESERVED — no rollback when mode=interactive (spec §7 / R14-RR)
  const leaseAfterRespawn = readState(root, runId).data.session_chain.lease;
  assert.equal(leaseAfterRespawn.handoff_phase, 'emitted', 'handoff_phase must stay emitted (not rolled back)');
  assert.equal(leaseAfterRespawn.state, 'releasing', 'lease.state must stay releasing');
  assert.equal(leaseAfterRespawn.handoff_child_run_id, h.childRunId, 'reserved child must be intact');

  // Step 4: skill calls pauseRun(mode='preserve') — status=paused, lease stays releasing, child kept
  pauseRun(root, runId, {
    reason: 'no-auto-launcher', mode: 'preserve',
    expect: { owner: runId, generation: 1 },
  });
  const dPaused = readState(root, runId).data;
  assert.equal(dPaused.status, 'paused', 'run must be paused after pauseRun preserve');
  assert.equal(dPaused.pause_reason, 'no-auto-launcher');
  assert.equal(dPaused.session_chain.lease.state, 'releasing', 'preserve keeps lease.state=releasing');
  assert.equal(dPaused.session_chain.lease.resume_policy, 'human', 'preserve sets resume_policy=human');
  assert.equal(dPaused.session_chain.lease.expires_at, null, 'preserve nulls expires_at');
  assert.equal(dPaused.session_chain.lease.handoff_child_run_id, h.childRunId, 'reserved child intact after preserve pause');

  // Step 5: reserved child (/deep-loop-resume) calls acquireLease — succeeds and UNPAUSES the run
  const acq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 + 5000 });
  assert.equal(acq.ok, true, 'reserved child must be able to acquire the releasing lease');
  assert.equal(acq.generation, 2, 'generation must advance to 2 on acquire');

  const dRunning = readState(root, runId).data;
  assert.equal(dRunning.status, 'running', 'acquireLease must unpause the run (R14-RR)');
  assert.equal(dRunning.pause_reason, null, 'pause_reason must be cleared on unpause');
  assert.equal(dRunning.session_chain.lease.owner_run_id, h.childRunId, 'child must own the lease');
  assert.equal(dRunning.session_chain.lease.handoff_phase, 'acquired');
  assert.equal(dRunning.session_chain.lease.state, 'active');

  // Step 6: business mutation succeeds — leaseCheck passes for child at generation 2
  patch(root, runId, 'triage.actionable', [{ id: 'work-item-1', title: 'First real work' }], {
    fence: { owner: h.childRunId, generation: 2 },
  });
  const dMutated = readState(root, runId).data;
  assert.equal(dMutated.triage.actionable.length, 1, 'business mutation after unpause must succeed');
  assert.equal(dMutated.triage.actionable[0].id, 'work-item-1');
});

// ── Test (b): R12-LL — gate-blocked rollback ──────────────────────────────────
//
// Flow:
//   1. Seed budget over hard cap (total=0) → respawnGate blocks on 'budget'.
//   2. emitHandoff → reserved child.
//   3. respawn(headless=true) → gate blocked → rollbackAndPause (ONE transaction):
//        • child.outcome = 'failed_launch' (invalidated, excluded from max_sessions)
//        • parent.superseded_by cleared
//        • lease → active/idle (rolled back)
//        • status = 'paused', pause_reason = 'gate:budget'
//   4. Old child tries acquireLease → REJECTED (lease-not-takeable: state=active, not releasing).
test('(R12-LL) gate-blocked rollback: budget exhausted → rollback + paused, old child acquire rejected', () => {
  // Step 1: seed with budget.total=0 → hard-stop fires immediately (0 >= 0 * 1.0)
  const { root, runId } = seed((d) => { d.budget.total = 0; });

  // Step 2: emit handoff to get the reserved child
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: { owner: runId, generation: 1 } });
  assert.equal(h.ok, true, 'emitHandoff must succeed (run is not yet paused)');

  let spawnCalled = false;
  // Step 3: respawn — mode=headless (headless:true) → gate checked → budget blocks
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    headless: true, now: NOW1,
    spawnFn: () => { spawnCalled = true; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(r.ok, false, 'respawn must fail when gate is blocked');
  assert.equal(r.outcome, 'gate-blocked', 'outcome must be gate-blocked');
  assert.ok(r.reason.includes('budget'), `reason must name 'budget', got: ${r.reason}`);
  assert.equal(spawnCalled, false, 'spawnFn must NOT be called when gate blocks');

  // Verify rollback + pause state (ONE transaction — R12-LL invariant)
  const d = readState(root, runId).data;
  assert.equal(d.status, 'paused', 'run must be paused after gate-blocked rollback');
  assert.ok(d.pause_reason.startsWith('gate:'), `pause_reason must start with 'gate:', got: ${d.pause_reason}`);

  // Lease rolled back to active/idle — NOT preserving handoff (gate-blocked is definitive failure)
  assert.equal(d.session_chain.lease.state, 'active', 'lease.state must be active after rollback');
  assert.equal(d.session_chain.lease.handoff_phase, 'idle', 'handoff_phase must be idle after rollback');
  assert.equal(d.session_chain.lease.handoff_child_run_id, null, 'handoff_child_run_id must be cleared after rollback');
  assert.equal(d.session_chain.lease.handoff_idempotency_key, null, 'idempotency_key must be cleared after rollback');

  // Reserved child invalidated: outcome='failed_launch' (excludes from max_sessions phantom counting)
  const childSession = d.session_chain.sessions.find(s => s.run_id === h.childRunId);
  assert.ok(childSession, 'child session must still exist in the session chain');
  assert.equal(childSession.outcome, 'failed_launch', 'invalidated child must have outcome=failed_launch');

  // Parent superseded_by cleared (rollback undo)
  const parentSession = d.session_chain.sessions.find(s => s.run_id === runId);
  assert.equal(parentSession?.superseded_by, null, 'parent superseded_by must be cleared after rollback');

  // Step 4: old child (invalidated) tries acquireLease → REJECTED
  // Lease is active (not releasing/released) and owner is the parent → not takeable by the old child.
  const rejectAcq = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, runtime: 'claude', now: NOW1 + 5000 });
  assert.equal(rejectAcq.ok, false, 'invalidated child must NOT be able to acquire the rolled-back lease');
  assert.equal(rejectAcq.reason, 'lease-not-takeable', `expected lease-not-takeable, got: ${rejectAcq.reason}`);
  // Run remains paused (no side-effect from the failed acquire attempt)
  assert.equal(readState(root, runId).data.status, 'paused', 'status must still be paused after rejected acquire');
});

// ── Test (c): Markerless mode-gate — positive launcher, not attended ──────────
//
// Even with a positive launcher (cmux), if attended=false, resolveSpawnMode returns
// 'interactive' → respawn returns {ok:false, outcome:'no-launcher'} → spawnFn never called.
// This covers the "markerless" case from the spec: CLAUDE_CODE_ENTRYPOINT=cli / no headless
// marker + no attended flag = interactive session that cannot auto-spawn a visible child.
test('(markerless) positive launcher + not attended → mode=interactive → no-launcher → spawnFn not invoked', () => {
  // Seed with a positive cmux launcher, spawn_style='visible'
  const { root, runId } = seedLauncher({ spawn_style: 'visible', launcher: 'cmux' });
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'cmux', 'sanity: launcher must be cmux');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible', 'sanity: spawn_style=visible');

  // emit handoff → reserve child
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1, expect: { owner: runId, generation: 1 } });
  assert.equal(h.ok, true, 'emitHandoff must succeed');

  let spawnCalled = false;
  // attended=false (default) → resolveSpawnMode: spawn_style==='visible' BUT attended!==true → 'interactive'
  const r = respawn(root, runId, {
    childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel,
    attended: false, // NOT attended — markerless interactive session
    env: {},         // no headless markers
    now: NOW1,
    spawnFn: () => { spawnCalled = true; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(r.ok, false, 'respawn must return ok:false (no auto-spawn without attended)');
  assert.equal(r.outcome, 'no-launcher', 'outcome must be no-launcher even with a positive launcher');
  assert.equal(spawnCalled, false, 'spawnFn must NOT be invoked when mode=interactive');

  // Handoff PRESERVED — no rollback (same as attended+no-launcher: caller pauses via preserve)
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'emitted', 'handoff_phase must remain emitted (not rolled back)');
  assert.equal(lease.state, 'releasing', 'lease.state must remain releasing (not rolled back)');
  assert.equal(lease.handoff_child_run_id, h.childRunId, 'reserved child must be intact');

  // Verify that spawn_style !== 'visible' also prevents visible spawn even with attended=true
  // (belt-and-suspenders: the second markerless form from the spec)
  const { root: root2, runId: runId2 } = seedLauncher({ spawn_style: 'headless', launcher: 'cmux' });
  const h2 = emitHandoff(root2, runId2, { trigger: 'milestone', now: NOW1, expect: { owner: runId2, generation: 1 } });
  let spawn2Called = false;
  const r2 = respawn(root2, runId2, {
    childRunId: h2.childRunId, key: h2.key, handoffRel: h2.handoffRel,
    attended: true, env: {}, now: NOW1,
    spawnFn: () => { spawn2Called = true; return { ok: true }; },
    sleep: noSleep,
  });
  // spawn_style=headless + attended=true → resolveSpawnMode returns 'headless' (not interactive)
  // → spawnFn IS called (headless path), outcome='spawned'
  assert.equal(r2.ok, true, 'headless spawn_style + attended → spawned (not interactive)');
  assert.equal(spawn2Called, true, 'headless mode must invoke spawnFn');
  // This confirms the contrast: spawn_style=visible + NOT attended → no spawn (interactive);
  // spawn_style=headless + attended → spawn (headless). The markerless guard is the attended flag.
});

// ── Test (d): R5-R — cmux --command POSIX-tokenize contract ─────────────────
//
// buildLaunchCommand(launcher='cmux') produces a cmux argv where --command holds a
// shell fragment. After POSIX single-quote tokenization, argv[0] must be 'claude'.
// This verifies the R5-R spec: the cmux --command value is tokenizable and the first
// token is the claude CLI entry point (no accidental shell metacharacter injection).
test('(R5-R) cmux --command POSIX-tokenize: first token is claude', () => {
  // Build cmux launch command directly (no run state needed)
  const cmds = buildLaunchCommand({
    platform: 'linux',
    root: '/test/project',
    parentRunId: 'PARENT01',
    childRunId: 'CHILD01',
    handoffRel: 'handoffs/2026-06-24T00-00-00-000Z-next-session.md',
    launcher: 'cmux',
    launcherBin: '/usr/local/bin/cmux',
    launcherSocket: '/tmp/cmux.sock',
  });

  // Extract the --command value from cmux argv
  const argv = cmds.cmux.argv;
  assert.equal(cmds.cmux.bin, '/usr/local/bin/cmux', 'cmux bin must be launcherBin');
  const cmdIdx = argv.indexOf('--command');
  assert.ok(cmdIdx >= 0, '--command flag must be present in cmux argv');
  const cmdStr = argv[cmdIdx + 1];
  assert.ok(typeof cmdStr === 'string' && cmdStr.length > 0, '--command value must be a non-empty string');

  // The --command value is a shell fragment passed to cmux to run inside a new workspace.
  // It must begin with 'claude' so cmux opens a claude session with the handoff prompt.
  assert.ok(cmdStr.startsWith('claude '), `--command must start with 'claude ', got: ${JSON.stringify(cmdStr.slice(0, 40))}`);

  // POSIX-tokenize: verify after full tokenization (including single-quote unwrapping)
  const tokens = posixTokenize(cmdStr);
  assert.ok(tokens.length >= 3, `tokenizer must produce at least 3 tokens (claude, -n, <name>), got: ${tokens.length}`);
  assert.equal(tokens[0], 'claude', `POSIX argv[0] after tokenization must be 'claude', got: ${JSON.stringify(tokens[0])}`);
  assert.equal(tokens[1], '-n', `POSIX argv[1] must be '-n' (new session flag), got: ${JSON.stringify(tokens[1])}`);

  // The third token is the workspace name (deep-loop-<childRunId>)
  assert.ok(tokens[2].startsWith('deep-loop-'), `workspace name must start with 'deep-loop-', got: ${JSON.stringify(tokens[2])}`);
  assert.equal(tokens[2], 'deep-loop-CHILD01', 'workspace name must include childRunId');

  // The fourth token is the resume prompt (a single-quoted string unwrapped)
  assert.ok(tokens.length >= 4, 'tokenizer must produce a 4th token for the resume prompt');
  assert.ok(tokens[3].startsWith('Read '), `resume prompt must start with 'Read ', got: ${JSON.stringify(tokens[3].slice(0, 30))}`);
  assert.ok(tokens[3].includes('PARENT01'), 'resume prompt must reference parentRunId');
  assert.ok(tokens[3].includes('/deep-loop-resume'), 'resume prompt must include /deep-loop-resume');
});

test('Codex emitted handoff stays on the shared measured host path through preflight, CAS, and accounting', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-self-spawn-codex-'));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'shared host round-trip', now: NOW0,
    env: {}, platform: 'linux', run: noOpRun,
  });
  const executable = {
    runtime: 'codex', canonical_path: '/opt/codex/bin/codex', sha256: 'a'.repeat(64),
    version: '0.144.1', platform: 'linux', arch: process.arch,
    source: 'human-explicit', package: null, authenticode: null,
    approved_by: 'human', approved_at: NOW0.toISOString(),
  };
  const seeded = readState(root, runId).data;
  seeded.autonomy.spawn_style = 'headless';
  seeded.autonomy.runtime_executable_approval = executable;
  writeState(root, runId, seeded);
  const handoff = emitHandoff(root, runId, {
    trigger: 'shared-measured-host', headless: true, resumePolicy: 'headless',
    expect: { owner: runId, generation: 1 }, now: NOW1,
  });

  const order = [];
  const measured = inputTokens => ({
    num_turns: 1, input_tokens: inputTokens, output_tokens: 1, tokens: inputTokens + 1,
  });
  const deps = {
    env: { PATH: '/usr/bin', CODEX_HOME: '/authenticated/codex-home' },
    revalidateExecutable: () => executable,
    resolveCodexHome: () => ({
      canonical_path: '/authenticated/codex-home', device: '1', inode: '2',
      birthtime_ns: '3', platform: 'linux',
    }),
    preflightFn: () => {
      order.push('preflight');
      return { ok: true, cache_hit: false, measured_usage: [measured(10), measured(20)] };
    },
    recordCostFn: (projectRoot, id, options) => {
      order.push(`cost:${options.tokens}`);
      return recordCost(projectRoot, id, options);
    },
    spawnFn: (entry) => {
      order.push('maker');
      assert.equal(entry.shell, false);
      assert.equal(entry.usageOutputKind, 'codex-jsonl');
      assert.equal(entry.env.DEEP_LOOP_OWNER, handoff.childRunId);
      acquireLease(root, runId, {
        owner: handoff.childRunId, expectGeneration: 1, runtime: 'codex', now: NOW1 + 1_000,
      });
      return { ok: true, usage: measured(30) };
    },
  };
  const first = driveHeadlessRun({
    root, runId, expect: { owner: runId, generation: 1 }, now: NOW1 + 500, ...deps,
  });

  assert.equal(first.action, 'resumed', JSON.stringify(first));
  assert.equal(first.recorded, true);
  assert.deepEqual(order, ['preflight', 'cost:11', 'cost:21', 'maker', 'cost:31']);
  assert.deepEqual(
    readLines(root, runId).filter(event => event.type === 'cost' && event.data.reported_turns === 1)
      .map(event => event.data.reported_tokens),
    [11, 21, 31],
  );
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.owner_run_id, handoff.childRunId);
  assert.equal(after.session_chain.lease.generation, 2);

  const beforeSecondTick = order.length;
  const second = driveHeadlessRun({
    root, runId, now: NOW1 + 2_000,
    ...deps,
    preflightFn: () => { throw new Error('completed shared host path must not repeat preflight'); },
    spawnFn: () => { throw new Error('completed shared host path must not repeat maker'); },
  });
  assert.equal(second.action, 'no-pending-handoff');
  assert.equal(order.length, beforeSecondTick);
});
