import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'deep-loop.mjs');
const SESSIONSTART = join(ROOT, 'scripts', 'hooks-impl', 'sessionstart-restore.mjs');
const COMPACT_SKILL = join(ROOT, 'skills', 'deep-loop-compact', 'SKILL.md');
const FIXED_NOW = '2026-07-24T00:05:00.000Z';

function cli(root, args, { input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    encoding: 'utf8',
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
    cwd: root,
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

for (const runtime of ['claude', 'codex']) {
  test(`${runtime} public routes preserve one Workstream across compact and rotate only at its boundary`, () => {
    const root = mkdtempSync(join(tmpdir(), `deep-loop-task15-${runtime}-`));
    mkdirSync(join(root, '.claude', 'worktrees', 'acceptance-a'), { recursive: true });
    mkdirSync(join(root, '.claude', 'worktrees', 'acceptance-b'), { recursive: true });

    const initialized = jsonResult(cli(root, [
      'init-run',
      '--runtime', runtime,
      '--goal', `Task 15 ${runtime} acceptance`,
      '--continuation', 'workstream-session',
    ]), 'init-run');
    const runId = initialized.run_id;
    const initial = state(root, runId);
    assert.equal(initial.autonomy.continuation_policy, 'workstream-session');
    assert.equal(initial.session_chain.lease.owner_run_id, runId);
    assert.equal(initial.session_chain.lease.generation, 1);
    assert.equal(initial.session_chain.sessions.length, 1);

    const fence1 = mutationArgs(runId, runId, 1);
    const workstreamA = jsonResult(cli(root, [
      'workstream', 'new',
      '--title', 'Acceptance A',
      '--branch', `task15-${runtime}-a`,
      '--worktree', '.claude/worktrees/acceptance-a',
      ...fence1,
    ]), 'workstream A new').id;
    const workstreamB = jsonResult(cli(root, [
      'workstream', 'new',
      '--title', 'Acceptance B',
      '--branch', `task15-${runtime}-b`,
      '--worktree', '.claude/worktrees/acceptance-b',
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
      ...fence1,
    ]), 'Workstream B maker new').id;
    const makerA = jsonResult(cli(root, [
      'episode', 'new',
      '--plugin', 'deep-work',
      '--role', 'maker',
      '--kind', 'implementation',
      '--point', 'implementation',
      '--workstream', workstreamA,
      ...fence1,
    ]), 'Workstream A maker new').id;
    jsonResult(cli(root, [
      'episode', 'record',
      '--id', makerA,
      '--status', 'in_progress',
      ...fence1,
    ]), 'Workstream A maker bind');

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
    assert.match(context, /source=compact/);
    assert.match(
      context,
      runtime === 'claude'
        ? /\/deep-loop-compact restore/
        : /\$deep-loop:deep-loop-compact restore/,
    );
    assert.match(context, new RegExp(emitted.checkpoint_rel.replace(/[.]/g, '\\.')));
    assert.match(context, new RegExp(`owner=${runId}`));
    assert.match(context, /generation=1/);
    assert.match(context, new RegExp(`runtime=${runtime}`));
    assert.match(context, new RegExp(`workstream=${workstreamA}`));

    const inspected = jsonResult(cli(root, [
      'checkpoint', 'inspect',
      '--json',
      '--now', FIXED_NOW,
      '--run-id', runId,
    ]), 'checkpoint inspect');
    assert.equal(inspected.checkpoint_rel, emitted.checkpoint_rel);

    const restored = jsonResult(cli(root, [
      'checkpoint', 'restore',
      '--checkpoint', inspected.checkpoint_rel,
      '--runtime', runtime,
      '--json',
      '--now', FIXED_NOW,
      ...fence1,
    ]), 'checkpoint restore');
    assert.equal(restored.owner_run_id, runId);
    assert.equal(restored.generation, 1);
    assert.equal(restored.runtime, runtime);
    assert.equal(restored.scope.workstream_id, workstreamA);
    assert.deepEqual(compactIdentity(state(root, runId)), identityBeforeCompact);

    const continuation = jsonResult(cli(root, [
      'next-action',
      '--json',
      '--now', FIXED_NOW,
      '--run-id', runId,
    ]), 'continue Workstream A');
    assert.equal(continuation.action.episode_id, makerA);
    assert.notEqual(continuation.action.type, 'handoff');

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

    const beforePrematureB = durableInventory(root, runId);
    const prematureB = cli(root, [
      'episode', 'record',
      '--id', makerB,
      '--status', 'in_progress',
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
    ]), 'unapproved attended respawn');
    assert.equal(noLaunch.mode, 'interactive');
    assert.equal(noLaunch.ok, false);
    assert.equal(noLaunch.outcome, 'no-launcher');
    assert.equal(noLaunch.reason, 'no-auto-launcher');

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

test('compact preparation prints only the exact host-native compact commands', () => {
  const skill = readFileSync(COMPACT_SKILL, 'utf8');
  assert.match(skill, /Claude: print `\/compact <focus>`/);
  assert.match(skill, /Codex: print bare `\/compact`/);
  assert.doesNotMatch(skill, /Codex:[^\n]*`\/compact <focus>`/);
});
