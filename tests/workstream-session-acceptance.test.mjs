import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readState as readKernelState,
  writeState,
} from '../scripts/lib/state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'deep-loop.mjs');
const SESSIONSTART = join(ROOT, 'scripts', 'hooks-impl', 'sessionstart-restore.mjs');
const COMPACT_SKILL = join(ROOT, 'skills', 'deep-loop-compact', 'SKILL.md');
const FIXED_NOW = '2026-07-24T00:05:00.000Z';
const MANUAL_COMPACT_NOW = '2026-07-24T00:05:01.000Z';

function cli(root, args, { input, env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    encoding: 'utf8',
    env: env == null ? process.env : { ...process.env, ...env },
    input,
    maxBuffer: 2_097_152,
  });
}

function jsonResult(result, label, expectedStatus = 0) {
  assert.equal(
    result.status,
    expectedStatus,
    `${label}: exit=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
}

function runDir(root, runId) {
  return join(root, '.deep-loop', 'runs', runId);
}

function state(root, runId) {
  return jsonResult(cli(root, [
    'state', 'get', '--run-id', runId,
  ]), 'state get');
}

function eventLog(root, runId) {
  return readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function durableInventory(root, runId) {
  const base = runDir(root, runId);
  const inventory = {};
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.lock') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, rel);
      else inventory[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(base);
  return inventory;
}

function compactIdentity(loop) {
  const lease = loop.session_chain.lease;
  const session = loop.session_chain.sessions
    .find(candidate => candidate.run_id === lease.owner_run_id);
  assert.ok(session, 'the lease owner must have one durable session record');
  return {
    owner: lease.owner_run_id,
    generation: lease.generation,
    session: session.run_id,
    scope: structuredClone(session.scope),
  };
}

function mutationArgs(runId, owner, generation) {
  return [
    '--owner', owner,
    '--generation', String(generation),
    '--run-id', runId,
  ];
}

function runSessionStart(root, runtime) {
  const payload = {
    cwd: realpathSync(root),
    hook_event_name: 'SessionStart',
    source: 'compact',
  };
  if (runtime === 'codex') payload.conversation_id = 'advisory-only-and-ignored';
  return spawnSync(process.execPath, [SESSIONSTART], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    maxBuffer: 2_097_152,
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function launchCapableHost(root) {
  const marker = join(root, 'spawn-attempt.jsonl');
  if (process.platform === 'win32') {
    return {
      env: { TASK15_SPAWN_MARKER: marker },
      marker,
    };
  }
  const launcher = join(root, 'task15-cmux');
  writeFileSync(launcher, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.at(-1) !== 'ping') {
  appendFileSync(process.env.TASK15_SPAWN_MARKER, JSON.stringify(args) + '\\n');
}
`, 'utf8');
  chmodSync(launcher, 0o755);
  return {
    env: {
      CMUX_BUNDLED_CLI_PATH: launcher,
      CMUX_SOCKET_PATH: join(root, 'task15-cmux.sock'),
      CMUX_WORKSPACE_ID: 'task15-workspace',
      TASK15_SPAWN_MARKER: marker,
    },
    marker,
  };
}

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} public routes preserve one Workstream across compact and rotate only at its boundary`, () => {
    const root = mkdtempSync(join(tmpdir(), `deep-loop-task15-${runtime}-`));
    mkdirSync(join(root, '.claude', 'worktrees', 'acceptance-a'), { recursive: true });
    mkdirSync(join(root, '.claude', 'worktrees', 'acceptance-b'), { recursive: true });
    const host = launchCapableHost(root);

    const initialized = jsonResult(cli(root, [
      'init-run',
      '--runtime', runtime,
      '--goal', `Task 15 ${runtime} acceptance`,
      '--continuation', 'workstream-session',
      '--now', FIXED_NOW,
    ], { env: host.env }), 'init-run');
    const runId = initialized.run_id;
    const initial = state(root, runId);
    assert.equal(initial.autonomy.continuation_policy, 'workstream-session');
    // Windows intentionally exercises the no-launcher path here; dedicated
    // native-launcher tests own Windows launch authorization.
    const expectedLauncher = process.platform === 'win32'
      ? { launcher: 'none', reachable: false, visible: false }
      : { launcher: 'cmux', reachable: true, visible: true };
    assert.equal(initial.session_spawn.launcher, expectedLauncher.launcher);
    assert.equal(initial.session_spawn.reachable, expectedLauncher.reachable);
    assert.equal(initial.session_spawn.visible, expectedLauncher.visible);
    assert.equal(initial.session_chain.lease.owner_run_id, runId);
    assert.equal(initial.session_chain.lease.generation, 1);
    assert.equal(initial.session_chain.sessions.length, 1);
    assert.equal(initial.created_at, FIXED_NOW);

    const fence1 = mutationArgs(runId, runId, 1);
    const workstreamA = jsonResult(cli(root, [
      'workstream', 'new',
      '--title', 'Acceptance A',
      '--branch', `task15-${runtime}-a`,
      '--worktree', '.claude/worktrees/acceptance-a',
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'workstream A new').id;
    const workstreamB = jsonResult(cli(root, [
      'workstream', 'new',
      '--title', 'Acceptance B',
      '--branch', `task15-${runtime}-b`,
      '--worktree', '.claude/worktrees/acceptance-b',
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'workstream B new').id;

    // Seed both planned maker requests while the owner is still unbound. Only
    // public episode record may bind either request to the owner session.
    const makerB = jsonResult(cli(root, [
      'episode', 'new',
      '--plugin', 'deep-work',
      '--role', 'maker',
      '--kind', 'implementation',
      '--point', 'implementation',
      '--workstream', workstreamB,
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'Workstream B maker new').id;
    const makerA = jsonResult(cli(root, [
      'episode', 'new',
      '--plugin', 'deep-work',
      '--role', 'maker',
      '--kind', 'implementation',
      '--point', 'implementation',
      '--workstream', workstreamA,
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'Workstream A maker new').id;
    jsonResult(cli(root, [
      'episode', 'record',
      '--id', makerA,
      '--status', 'in_progress',
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'Workstream A maker bind');

    const setupEvents = eventLog(root, runId).filter(event =>
      ['workstream-new', 'episode-new', 'episode-record'].includes(event.type));
    assert.equal(setupEvents.length, 5);
    assert.deepEqual(setupEvents.map(event => event.ts), Array(5).fill(FIXED_NOW));

    // PreCompact is reached because attended cadence is already at its cap.
    // Test setup fixes that state explicitly so the prepared fallback exercises
    // the immediate-readvice edge rather than a below-cap approximation.
    const cappedBeforePrepare = readKernelState(root, runId).data;
    const cappedPrepareOwner = cappedBeforePrepare.session_chain.sessions
      .find(session => session.run_id === cappedBeforePrepare.session_chain.lease.owner_run_id);
    cappedPrepareOwner.turns = cappedBeforePrepare.budget.per_session_turn_cap;
    writeState(root, runId, cappedBeforePrepare);

    const beforeCompact = state(root, runId);
    const identityBeforeCompact = compactIdentity(beforeCompact);
    assert.equal(identityBeforeCompact.scope.kind, 'workstream');
    assert.equal(identityBeforeCompact.scope.workstream_id, workstreamA);
    assert.equal(identityBeforeCompact.scope.terminal_event, null);
    assert.equal(identityBeforeCompact.scope.closed_at, null);

    const emitted = jsonResult(cli(root, [
      'checkpoint', 'emit',
      '--runtime', runtime,
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'checkpoint emit');
    assert.match(emitted.checkpoint_rel, /^checkpoints\/[0-9a-f]{64}-compact\.json$/);
    assert.equal(emitted.workstream_id, workstreamA);

    const hook = runSessionStart(root, runtime);
    assert.equal(hook.status, 0, hook.stderr);
    assert.equal(hook.stderr, '');
    const hookOutput = JSON.parse(hook.stdout);
    const context = hookOutput.hookSpecificOutput.additionalContext;
    const preparedCapsule = JSON.parse(context);
    assert.equal(preparedCapsule.marker, 'deep-loop-compact-capsule-v1');
    assert.equal(preparedCapsule.injected_by, 'sessionstart');
    assert.equal(preparedCapsule.capsule.phase, 'prepared');
    assert.equal(preparedCapsule.capsule.checkpoint_key, emitted.checkpoint_key);
    assert.equal(preparedCapsule.capsule.owner_run_id, runId);
    assert.equal(preparedCapsule.capsule.generation, 1);
    assert.equal(preparedCapsule.capsule.runtime, runtime);
    assert.equal(preparedCapsule.capsule.workstream_id, workstreamA);
    assert.equal(
      preparedCapsule.capsule.restore_command,
      runtime === 'claude'
        ? '/deep-loop-compact restore'
        : '$deep-loop:deep-loop-compact restore',
    );

    // A trusted prepared SessionStart capsule has no PostCompact receipt and
    // therefore takes the capsule-free public fallback. The four views prove
    // fresh affinity; the single routing read must not restore or mutate.
    const preparedViews = Object.fromEntries([
      'session_chain.lease',
      'session_chain.sessions',
      'workstreams',
      'current_episode',
    ].map(field => [field, jsonResult(cli(root, [
      'state', 'get', '--field', field, '--run-id', runId,
    ]), `prepared fallback ${field}`)]));
    assert.equal(preparedViews['session_chain.lease'].owner_run_id, runId);
    assert.equal(preparedViews['session_chain.lease'].generation, 1);
    assert.ok(preparedViews['session_chain.sessions']
      .some(session => session.run_id === runId
        && session.scope.workstream_id === workstreamA));
    assert.equal(preparedViews.workstreams
      .find(workstream => workstream.id === workstreamA).status, 'planned');
    assert.equal(preparedViews.current_episode, makerA);
    const beforePreparedFallback = durableInventory(root, runId);
    const preparedContinuation = jsonResult(cli(root, [
      'next-action', '--json', '--now', FIXED_NOW, '--run-id', runId,
    ]), 'prepared capsule-free continuation tick');
    assert.equal(preparedContinuation.action.episode_id, makerA);
    assert.notEqual(preparedContinuation.action.type, 'handoff');
    assert.equal(preparedContinuation.action.advice, 'compact',
      'without an invocation-local prepared fallback marker the kernel still exposes cap advice');
    assert.equal(preparedContinuation.action.advice_reason, 'per_session_turn_cap');
    assert.deepEqual(durableInventory(root, runId), beforePreparedFallback);
    assert.equal(eventLog(root, runId)
      .filter(event => event.type === 'compact-restored').length, 0);

    const inspected = jsonResult(cli(root, [
      'checkpoint', 'inspect',
      '--json',
      '--now', FIXED_NOW,
      '--run-id', runId,
    ]), 'checkpoint inspect');
    assert.equal(inspected.checkpoint_rel, emitted.checkpoint_rel);
    assert.equal(inspected.phase, 'prepared');
    const observed = jsonResult(cli(root, [
      'checkpoint', 'observe',
      '--checkpoint', emitted.checkpoint_rel,
      '--trigger', 'auto',
      '--runtime', runtime,
      '--trusted-postcompact-stdin',
      '--json',
      '--now', FIXED_NOW,
      ...fence1,
    ], {
      input: JSON.stringify({
        hook_event_name: 'PostCompact', cwd: realpathSync(root), trigger: 'auto',
      }),
    }), 'checkpoint observe');
    assert.equal(observed.created, true);
    assert.equal(observed.checkpoint_key, emitted.checkpoint_key);
    const compacted = jsonResult(cli(root, [
      'checkpoint', 'inspect', '--json', '--now', FIXED_NOW, '--run-id', runId,
    ]), 'checkpoint inspect compacted');
    assert.equal(compacted.phase, 'compacted');
    assert.equal(compacted.trigger, 'auto');

    const compactedHook = runSessionStart(root, runtime);
    assert.equal(compactedHook.status, 0, compactedHook.stderr);
    const compactedCapsule = JSON.parse(
      JSON.parse(compactedHook.stdout).hookSpecificOutput.additionalContext,
    ).capsule;
    assert.equal(compactedCapsule.phase, 'compacted');
    assert.deepEqual(compactedCapsule.admission, {
      kind: 'postcompact-observation', source: null, receipt_trigger: 'auto',
    });

    const restored = jsonResult(cli(root, [
      'checkpoint', 'restore',
      '--checkpoint', inspected.checkpoint_rel,
      '--runtime', runtime,
      '--admission', 'postcompact-observation',
      '--source', 'sessionstart',
      '--json',
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'checkpoint restore');
    assert.equal(restored.owner_run_id, runId);
    assert.equal(restored.generation, 1);
    assert.equal(restored.runtime, runtime);
    assert.equal(restored.phase, 'restored');
    assert.equal(restored.workstream_id, workstreamA);
    assert.equal(restored.next_command, null);
    assert.equal(restored.requires_model_turn, false);
    assert.deepEqual(compactIdentity(state(root, runId)), identityBeforeCompact);
    const restoredHook = runSessionStart(root, runtime);
    assert.equal(restoredHook.status, 0, restoredHook.stderr);
    assert.equal(restoredHook.stdout, '');

    const continuation = jsonResult(cli(root, [
      'next-action',
      '--json',
      '--now', FIXED_NOW,
      '--run-id', runId,
    ]), 'continue Workstream A');
    assert.equal(continuation.action.episode_id, makerA);
    assert.notEqual(continuation.action.type, 'handoff');

    // Hookless/manual compact is a complete same-owner path: no SessionStart
    // capsule is required, and exactly one direct continuation tick follows.
    jsonResult(cli(root, [
      'state', 'patch',
      '--field', 'discovered_items',
      '--value', '["manual-compact-fixture"]',
      '--now', MANUAL_COMPACT_NOW,
      ...fence1,
    ]), 'manual continuation state mutation');
    const manualEmitted = jsonResult(cli(root, [
      'checkpoint', 'emit',
      '--runtime', runtime,
      '--now', MANUAL_COMPACT_NOW,
      ...fence1,
    ]), 'manual checkpoint emit');
    const manualInspected = jsonResult(cli(root, [
      'checkpoint', 'inspect', '--json', '--now', MANUAL_COMPACT_NOW, '--run-id', runId,
    ]), 'manual checkpoint inspect');
    assert.equal(manualInspected.phase, 'prepared');
    assert.equal(manualInspected.checkpoint_rel, manualEmitted.checkpoint_rel);
    const manualRestored = jsonResult(cli(root, [
      'checkpoint', 'restore',
      '--checkpoint', manualInspected.checkpoint_rel,
      '--runtime', runtime,
      '--admission', 'human-attested',
      '--source', 'direct-human-skill',
      '--confirm-manual-compact',
      '--json',
      '--now', MANUAL_COMPACT_NOW,
      ...fence1,
    ]), 'manual checkpoint restore');
    assert.equal(manualRestored.disposition, 'committed');
    assert.deepEqual(manualRestored.admission, {
      kind: 'human-attested', source: 'direct-human-skill', receipt_trigger: null,
    });
    const manualRestoredInspect = jsonResult(cli(root, [
      'checkpoint', 'inspect', '--json', '--now', MANUAL_COMPACT_NOW, '--run-id', runId,
    ]), 'manual restored checkpoint inspect');
    assert.equal(manualRestoredInspect.phase, 'restored');
    assert.deepEqual(manualRestoredInspect.restore_event, manualRestored.restore_event);
    const manualContinuation = jsonResult(cli(root, [
      'next-action', '--json', '--now', MANUAL_COMPACT_NOW, '--run-id', runId,
    ]), 'manual direct-human continuation tick');
    assert.equal(manualContinuation.action.episode_id, makerA);
    assert.notEqual(manualContinuation.action.type, 'handoff');

    const capped = readKernelState(root, runId).data;
    const cappedOwner = capped.session_chain.sessions
      .find(session => session.run_id === capped.session_chain.lease.owner_run_id);
    cappedOwner.turns = (cappedOwner.compact_cursor?.baseline_turns ?? 0)
      + capped.budget.per_session_turn_cap;
    writeState(root, runId, capped);
    for (const autoHandoff of [true, false]) {
      const unattendedState = readKernelState(root, runId).data;
      unattendedState.autonomy.auto_handoff = autoHandoff;
      writeState(root, runId, unattendedState);
      const unattendedContinuation = jsonResult(cli(root, [
        'next-action',
        '--unattended',
        '--json',
        '--now', FIXED_NOW,
        '--run-id', runId,
      ]), `unattended Workstream A auto_handoff=${autoHandoff}`);
      assert.equal(unattendedContinuation.action.episode_id, makerA);
      assert.notEqual(unattendedContinuation.action.type, 'handoff');
      assert.equal(Object.hasOwn(unattendedContinuation.action, 'advice'), false);
      assert.equal(Object.hasOwn(unattendedContinuation.action, 'advice_reason'), false);
    }
    const restoredAutonomy = readKernelState(root, runId).data;
    restoredAutonomy.autonomy.auto_handoff = true;
    writeState(root, runId, restoredAutonomy);

    // Approval is a human-gated public mutation. Missing confirmation must be
    // a byte-preserving usage rejection, and therefore cannot authorize the
    // attended respawn exercised below.
    const beforeApproval = durableInventory(root, runId);
    const unconfirmedApproval = cli(root, [
      'attended-launch', 'approve',
      '--style', 'visible',
      ...fence1,
    ]);
    assert.equal(unconfirmedApproval.status, 2, unconfirmedApproval.stderr);
    assert.match(unconfirmedApproval.stderr, /CONFIRM_REQUIRED/);
    assert.deepEqual(durableInventory(root, runId), beforeApproval);

    // Fixture-only setup: make the persisted transport otherwise eligible for
    // attended visible launch while leaving durable approval absent. The route
    // under test remains the public respawn CLI. If its approval predicate is
    // removed, the fake reachable launcher records the external spawn attempt.
    const seeded = readKernelState(root, runId).data;
    seeded.autonomy.spawn_style = 'visible';
    seeded.autonomy.attended_launch_approval = null;
    writeState(root, runId, seeded);

    const beforeBudget = durableInventory(root, runId);
    const unconfirmedBudget = cli(root, [
      'budget', 'extend',
      '--turns', '1',
      '--reason', 'Task 15 must not extend without approval',
      ...fence1,
    ]);
    assert.equal(unconfirmedBudget.status, 2, unconfirmedBudget.stderr);
    assert.match(unconfirmedBudget.stderr, /BUDGET_EXTENSION_CONFIRM_REQUIRED/);
    assert.deepEqual(durableInventory(root, runId), beforeBudget);

    jsonResult(cli(root, [
      'episode', 'abandon',
      '--id', makerA,
      '--reason', 'Task 15 fixture reached its exact terminal boundary',
      '--confirm',
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'continue and settle Workstream A');
    jsonResult(cli(root, [
      'workstream', 'terminal',
      '--id', workstreamA,
      '--status', 'abandoned',
      '--proof', '{"reason":"Task 15 exact boundary"}',
      '--confirm',
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'Workstream A terminal');

    const afterTerminal = state(root, runId);
    const parent = afterTerminal.session_chain.sessions
      .find(session => session.run_id === runId);
    assert.equal(parent.scope.workstream_id, workstreamA);
    assert.equal(parent.scope.closed_at, FIXED_NOW);
    assert.deepEqual(
      afterTerminal.workstreams.find(item => item.id === workstreamA).terminal_events,
      [parent.scope.terminal_event],
    );
    assert.equal(afterTerminal.workstreams
      .flatMap(item => item.terminal_events ?? []).length, 1);
    assert.equal(eventLog(root, runId)
      .find(event => event.type === 'episode-abandon').ts, FIXED_NOW);

    const beforePrematureB = durableInventory(root, runId);
    const prematureB = cli(root, [
      'episode', 'record',
      '--id', makerB,
      '--status', 'in_progress',
      '--now', FIXED_NOW,
      ...fence1,
    ]);
    assert.equal(prematureB.status, 1, prematureB.stderr);
    assert.match(prematureB.stderr, /SESSION_SCOPE_MISMATCH/);
    assert.deepEqual(durableInventory(root, runId), beforePrematureB);

    const boundaryAction = jsonResult(cli(root, [
      'next-action',
      '--json',
      '--now', FIXED_NOW,
      '--run-id', runId,
    ]), 'terminal next-action');
    assert.deepEqual(boundaryAction.action, {
      type: 'handoff',
      reason: 'workstream-terminal',
      boundary_event: `${parent.scope.terminal_event.seq}:${parent.scope.terminal_event.checksum}`,
    });

    const handoff = jsonResult(cli(root, [
      'handoff', 'emit',
      '--reason', 'workstream-terminal',
      '--trigger', 'workstream-terminal',
      '--boundary-event', boundaryAction.action.boundary_event,
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'boundary handoff');
    assert.equal(handoff.ok, true);
    assert.equal(handoff.idempotent, false);

    // Every public mutation in this acceptance is driven by one fixed clock.
    // The handoff CLI must forward --now to the production route, not silently
    // fall back to Date.now().
    const handoffEvents = eventLog(root, runId)
      .filter(event => event.type === 'handoff-emitted');
    assert.equal(handoffEvents.length, 1);
    assert.equal(handoffEvents[0].ts, FIXED_NOW);

    const afterHandoff = state(root, runId);
    const child = afterHandoff.session_chain.sessions
      .find(session => session.run_id === handoff.childRunId);
    assert.ok(child);
    assert.equal(afterHandoff.session_chain.sessions.length, 2);
    assert.deepEqual(child.parent_boundary_event, parent.scope.terminal_event);
    assert.equal(child.scope.workstream_id, null);
    assert.equal(child.started_at, null);
    assert.equal(afterHandoff.session_chain.lease.owner_run_id, runId);
    assert.equal(afterHandoff.session_chain.lease.generation, 1);

    const launchPath = join(runDir(root, runId), 'terminal', 'launch-command.txt');
    const launchBytes = readFileSync(launchPath);
    assert.ok(launchBytes.length > 0);
    const launchMeta = JSON.parse(readFileSync(
      join(runDir(root, runId), 'terminal', 'launch-command.meta.json'),
      'utf8',
    ));
    assert.equal(launchMeta.payload.launch_command_sha256, sha256(launchBytes));
    assert.deepEqual(launchMeta.payload.boundary_event, parent.scope.terminal_event);
    assert.equal(launchMeta.payload.parent_run_id, runId);
    assert.equal(launchMeta.payload.child_run_id, handoff.childRunId);
    const resumeDescriptor = cli(root, [
      'resume-command',
      '--run-id', runId,
    ]);
    assert.equal(resumeDescriptor.status, 0, resumeDescriptor.stderr);
    assert.ok(resumeDescriptor.stdout.includes(launchBytes.toString('utf8').trimEnd()));

    const beforeRetry = durableInventory(root, runId);
    const retried = jsonResult(cli(root, [
      'handoff', 'emit',
      '--reason', 'workstream-terminal',
      '--trigger', 'workstream-terminal',
      '--boundary-event', boundaryAction.action.boundary_event,
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'idempotent boundary handoff retry');
    assert.equal(retried.ok, true);
    assert.equal(retried.idempotent, true);
    assert.equal(retried.childRunId, handoff.childRunId);
    assert.deepEqual(durableInventory(root, runId), beforeRetry);
    assert.equal(eventLog(root, runId)
      .filter(event => event.type === 'handoff-emitted').length, 1);

    const noLaunch = jsonResult(cli(root, [
      'respawn',
      '--attended',
      '--timeout-ms', '0',
      '--now', FIXED_NOW,
      ...fence1,
    ], { env: host.env }), 'unapproved attended respawn');
    assert.equal(noLaunch.mode, 'interactive');
    assert.equal(noLaunch.ok, false);
    assert.equal(noLaunch.outcome, 'no-launcher');
    assert.equal(noLaunch.reason, 'no-auto-launcher');
    assert.equal(existsSync(host.marker), false);

    const acquired = jsonResult(cli(root, [
      'lease', 'acquire',
      '--owner', handoff.childRunId,
      '--generation', '1',
      '--runtime', runtime,
      '--now', FIXED_NOW,
      '--run-id', runId,
    ]), 'boundary child acquire');
    assert.equal(acquired.ok, true);
    assert.equal(acquired.reason, 'acquired');
    assert.equal(acquired.generation, 2);

    const fence2 = mutationArgs(runId, handoff.childRunId, 2);
    jsonResult(cli(root, [
      'episode', 'record',
      '--id', makerB,
      '--status', 'in_progress',
      '--now', FIXED_NOW,
      ...fence2,
    ]), 'Workstream B bind after child acquisition');
    const final = state(root, runId);
    assert.equal(final.session_chain.lease.owner_run_id, handoff.childRunId);
    assert.equal(final.session_chain.lease.generation, 2);
    assert.equal(final.session_chain.sessions.length, 2);
    assert.equal(final.session_chain.sessions
      .find(session => session.run_id === handoff.childRunId)
      .scope.workstream_id, workstreamB);
  });
}

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} prepared SessionStart proof failure uses fenced preserve-pause without restore`, () => {
    const root = mkdtempSync(join(tmpdir(), `deep-loop-prepared-pause-${runtime}-`));
    mkdirSync(join(root, '.claude', 'worktrees', 'prepared-pause'), { recursive: true });
    const initialized = jsonResult(cli(root, [
      'init-run',
      '--runtime', runtime,
      '--goal', `Prepared fallback pause ${runtime}`,
      '--continuation', 'workstream-session',
      '--now', FIXED_NOW,
    ]), 'prepared pause init-run');
    const runId = initialized.run_id;
    const fence = mutationArgs(runId, runId, 1);
    const workstreamId = jsonResult(cli(root, [
      'workstream', 'new',
      '--title', 'Prepared pause',
      '--branch', `prepared-pause-${runtime}`,
      '--worktree', '.claude/worktrees/prepared-pause',
      '--now', FIXED_NOW,
      ...fence,
    ]), 'prepared pause workstream').id;
    const episodeId = jsonResult(cli(root, [
      'episode', 'new',
      '--plugin', 'deep-work',
      '--role', 'maker',
      '--kind', 'implementation',
      '--point', 'implementation',
      '--workstream', workstreamId,
      '--now', FIXED_NOW,
      ...fence,
    ]), 'prepared pause episode').id;
    jsonResult(cli(root, [
      'episode', 'record',
      '--id', episodeId,
      '--status', 'in_progress',
      '--now', FIXED_NOW,
      ...fence,
    ]), 'prepared pause bind');
    jsonResult(cli(root, [
      'checkpoint', 'emit',
      '--runtime', runtime,
      '--now', FIXED_NOW,
      ...fence,
    ]), 'prepared pause checkpoint');
    const hook = runSessionStart(root, runtime);
    assert.equal(hook.status, 0, hook.stderr);
    const capsule = JSON.parse(
      JSON.parse(hook.stdout).hookSpecificOutput.additionalContext,
    ).capsule;
    assert.equal(capsule.phase, 'prepared');

    // Model a legitimate race after SessionStart injection: one fresh view no
    // longer proves the received episode affinity. Test setup alone edits the
    // fixture; recovery still goes through the public fenced pause route.
    const drifted = readKernelState(root, runId).data;
    drifted.current_episode = null;
    writeState(root, runId, drifted);
    const currentEpisode = jsonResult(cli(root, [
      'state', 'get', '--field', 'current_episode', '--run-id', runId,
    ]), 'prepared pause failed proof');
    assert.equal(currentEpisode, null);

    const paused = jsonResult(cli(root, [
      'pause',
      '--mode', 'preserve',
      '--reason', 'host-session-lost',
      '--now', FIXED_NOW,
      ...fence,
    ]), 'prepared fallback preserve-pause');
    assert.deepEqual(paused, { ok: true, status: 'paused' });
    const after = state(root, runId);
    assert.equal(after.status, 'paused');
    assert.equal(after.pause_reason, 'host-session-lost');
    assert.equal(after.session_chain.lease.owner_run_id, runId);
    assert.equal(after.session_chain.lease.generation, 1);
    assert.equal(eventLog(root, runId)
      .filter(event => event.type === 'compact-restored').length, 0);
    assert.equal(eventLog(root, runId)
      .filter(event => event.type === 'run-paused').length, 1);
  });
}

test('compact preparation prints only the exact host-native compact commands', () => {
  const skill = readFileSync(COMPACT_SKILL, 'utf8');
  assert.match(skill, /Claude: print `\/compact <focus>`/);
  assert.match(skill, /Codex: print bare `\/compact`/);
  assert.doesNotMatch(skill, /Codex:[^\n]*`\/compact <focus>`/);
});
