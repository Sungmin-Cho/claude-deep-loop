import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync as rf, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { pauseRun, readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { runPreCompactHandoff } from '../scripts/hooks-impl/precompact-handoff.mjs';
import { inspectCompactCheckpoint } from '../scripts/lib/checkpoint.mjs';
import { abandonEpisode, newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease, reserveHandoff } from '../scripts/lib/lease.mjs';
import { rollbackAndPause } from '../scripts/lib/respawn.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import {
  newWorkstream,
  recordWorkstreamTerminal,
  setWorkstreamStatus,
} from '../scripts/lib/workspace.mjs';
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';
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

function persistLegacyPolicy(root, runId, policy) {
  const dir = runDir(root, runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(rf(loopPath, 'utf8'));
  legacy.schema_version = '0.3.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  for (const session of legacy.session_chain.sessions) delete session.scope;
  legacy.autonomy.spawn_style = 'visible';
  legacy.autonomy.continuation_policy = policy;
  legacy.autonomy.milestone_predicate = policy === 'compact-in-place'
    ? ['workstream_status_change']
    : ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached'];
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
}

function seed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  persistLegacyPolicy(root, runId, runtime === 'claude' ? 'compact-in-place' : 'rotate-per-unit');
  return { root, runId };
}

function seedRotate() {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc-rotate-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z'),
  });
  persistLegacyPolicy(root, runId, 'rotate-per-unit');
  return { root, runId };
}

function seedBound(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), `dl-pc-bound-${runtime}-`));
  const { runId } = initRun(root, {
    runtime, goal: 'g', now: new Date('2026-06-24T00:00:00Z'),
  });
  const fence = { owner: runId, generation: 1 };
  const worktree = `.claude/worktrees/precompact-${runtime}`;
  mkdirSync(join(root, worktree), { recursive: true });
  const workstreamId = newWorkstream(root, runId, {
    title: `precompact-${runtime}`,
    branch: `feature/precompact-${runtime}`,
    worktree,
    fence,
  }).id;
  setWorkstreamStatus(root, runId, workstreamId, 'in_progress', { fence });
  const episodeId = newEpisode(root, runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point: 'implementation',
    workstream: workstreamId,
    expectedArtifacts: [],
    fence,
  }).id;
  recordEpisode(root, runId, episodeId, { status: 'in_progress', fence });
  return { root, runId, runtime, fence, workstreamId, episodeId };
}

function closeBound(fixture) {
  abandonEpisode(fixture.root, fixture.runId, fixture.episodeId, {
    reason: 'Task9 closed-scope fixture',
    confirm: true,
    fence: fixture.fence,
  });
  recordWorkstreamTerminal(fixture.root, fixture.runId, fixture.workstreamId, {
    status: 'abandoned',
    proof: { reason: 'Task9 closed-scope fixture' },
    confirm: true,
    fence: fixture.fence,
    now: Date.parse('2026-06-24T00:00:30Z'),
  });
}

function reserveAndPauseClosedBoundary(fixture) {
  const siblingWorktree = `.claude/worktrees/precompact-sibling-${fixture.runtime}`;
  mkdirSync(join(fixture.root, siblingWorktree), { recursive: true });
  newWorkstream(fixture.root, fixture.runId, {
    title: `precompact-sibling-${fixture.runtime}`,
    branch: `feature/precompact-sibling-${fixture.runtime}`,
    worktree: siblingWorktree,
    fence: fixture.fence,
  });
  closeBound(fixture);
  const closed = readState(fixture.root, fixture.runId).data;
  const owner = closed.session_chain.sessions
    .find(session => session.run_id === fixture.runId);
  const boundaryEvent = owner.scope.terminal_event;
  const reserved = reserveHandoff(fixture.root, fixture.runId, {
    trigger: 'workstream-terminal',
    boundaryEvent,
    expect: fixture.fence,
    now: Date.parse('2026-06-24T00:00:40Z'),
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.reason, 'reserved');
  pauseRun(fixture.root, fixture.runId, {
    reason: 'host-session-lost',
    mode: 'preserve',
    expect: fixture.fence,
    now: Date.parse('2026-06-24T00:00:50Z'),
  });
  return { boundaryEvent, reserved };
}

function checkpointFiles(root, runId) {
  const dir = join(runDir(root, runId), 'checkpoints');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(file => file.endsWith('-compact.json'));
}

function durableBytes(root, runId) {
  const dir = runDir(root, runId);
  const logPath = join(dir, 'event-log.jsonl');
  return {
    loop: rf(join(dir, 'loop.json')),
    hash: rf(join(dir, '.loop.hash')),
    log: existsSync(logPath) ? rf(logPath) : null,
  };
}

test('workstream-session PreCompact checkpoints every runtime and trigger mode without rotating affinity', async () => {
  const cases = [
    ['claude', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'claude-manual' }, {}, false],
    ['claude', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'claude-auto' }, {}, false],
    ['claude', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'claude-headless' }, { DEEP_LOOP_HEADLESS: '1' }, true],
    ['claude', { hook_event_name: 'PreCompact', trigger: 'manual' }, {}, false],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'codex-manual' }, {}, false],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'codex-auto' }, {}, false],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'codex-headless' }, { DEEP_LOOP_HEADLESS: '1' }, true],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'manual', conversation_id: 'ignored' }, {}, false],
  ];
  for (const [runtime, input, env, headless] of cases) {
    const fixture = seedBound(runtime);
    const before = durableBytes(fixture.root, fixture.runId);
    const beforeState = readState(fixture.root, fixture.runId).data;
    const beforeLease = structuredClone(beforeState.session_chain.lease);
    const beforeSessions = structuredClone(beforeState.session_chain.sessions);

    const result = await runPreCompactHandoff(input, {
      root: fixture.root,
      now: Date.parse('2026-06-24T00:01:00Z'),
      env,
    });

    assert.deepEqual(result, { ok: true, action: 'checkpointed', headless }, `${runtime}:${JSON.stringify(input)}`);
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
    const after = readState(fixture.root, fixture.runId).data;
    assert.deepEqual(after.session_chain.lease, beforeLease);
    assert.deepEqual(after.session_chain.sessions, beforeSessions);
    assert.equal(events(fixture.root, fixture.runId).some(event => event.type === 'handoff-emitted'), false);
    assert.equal(checkpointFiles(fixture.root, fixture.runId).length, 1);
    const evidence = Object.hasOwn(input, 'session_id')
      ? { provider: runtime === 'claude' ? 'claude-code' : 'codex', id: input.session_id }
      : undefined;
    const inspected = inspectCompactCheckpoint(fixture.root, fixture.runId, {
      hostSessionEvidence: evidence,
      now: Date.parse('2026-06-24T00:01:00Z'),
    });
    assert.equal(inspected.ok, true);
    assert.deepEqual(inspected.provider_evidence, {
      present: evidence !== undefined,
      matched: evidence === undefined ? null : true,
    });
  }
});

test('workstream-session PreCompact rejects malformed or ambiguous host evidence without legacy fallthrough', async () => {
  const cases = [
    ['claude', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: '' }],
    ['claude', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 42 }],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: '' }],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 42 }],
    ['claude', { hook_event_name: 'SessionStart', trigger: 'manual' }],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'unknown' }],
  ];
  for (const [runtime, input] of cases) {
    const fixture = seedBound(runtime);
    const before = durableBytes(fixture.root, fixture.runId);
    const beforeState = structuredClone(readState(fixture.root, fixture.runId).data);

    const result = await runPreCompactHandoff(input, {
      root: fixture.root,
      now: Date.parse('2026-06-24T00:01:00Z'),
      env: {},
    });

    assert.deepEqual(result, {
      ok: false,
      action: 'checkpoint-failed',
      reason: 'host-evidence-invalid',
    });
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
    assert.deepEqual(readState(fixture.root, fixture.runId).data, beforeState);
    assert.deepEqual(checkpointFiles(fixture.root, fixture.runId), []);
  }
});

test('workstream-session PreCompact unbound and closed scopes never fall through to legacy checkpoint or handoff', async () => {
  const unboundRoot = mkdtempSync(join(tmpdir(), 'dl-pc-unbound-'));
  const { runId: unboundRunId } = initRun(unboundRoot, {
    runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z'),
  });
  const closed = seedBound('codex');
  closeBound(closed);

  for (const [root, runId, input] of [
    [unboundRoot, unboundRunId, {
      hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'unbound-session',
    }],
    [closed.root, closed.runId, {
      hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'closed-session',
    }],
  ]) {
    const before = durableBytes(root, runId);
    const beforeState = structuredClone(readState(root, runId).data);
    const result = await runPreCompactHandoff(input, {
      root,
      now: Date.parse('2026-06-24T00:01:00Z'),
      env: {},
    });
    assert.deepEqual(result, { ok: true, action: 'no-affinity' });
    assert.deepEqual(durableBytes(root, runId), before);
    assert.deepEqual(readState(root, runId).data, beforeState);
    assert.deepEqual(checkpointFiles(root, runId), []);
    assert.equal(events(root, runId).some(event => event.type === 'handoff-emitted'), false);
  }
});

test('workstream-session PreCompact preserves a public reserved boundary across fenced preserve-pause', async () => {
  const fixture = seedBound('claude');
  const { boundaryEvent, reserved } = reserveAndPauseClosedBoundary(fixture);
  const before = durableBytes(fixture.root, fixture.runId);
  const beforeState = structuredClone(readState(fixture.root, fixture.runId).data);

  const result = await runPreCompactHandoff({
    hook_event_name: 'PreCompact',
    trigger: 'auto',
    session_id: 'paused-owner-session',
  }, {
    root: fixture.root,
    now: Date.parse('2026-06-24T00:01:00Z'),
    env: { DEEP_LOOP_HEADLESS: '1' },
  });

  const after = readState(fixture.root, fixture.runId).data;
  assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
  assert.deepEqual(after, beforeState);
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'reserved');
  assert.equal(after.session_chain.lease.handoff_child_run_id, reserved.childRunId);
  assert.equal(after.session_chain.lease.handoff_idempotency_key, reserved.key);
  assert.deepEqual(after.session_chain.lease.handoff_boundary_event, boundaryEvent);
  assert.deepEqual(result, { ok: true, action: 'no-affinity' });
  assert.deepEqual(checkpointFiles(fixture.root, fixture.runId), []);
});

test('exact manifest PreCompact subprocess checkpoints Claude and Codex manual, auto, and headless affinity', () => {
  const manifest = JSON.parse(rf(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  const command = manifest.hooks.PreCompact[0].hooks[0].command;
  assert.equal(command, EXPECTED_BOOTSTRAP);
  for (const [runtime, input] of [
    ['claude', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'claude-manual' }],
    ['claude', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'claude-auto' }],
    ['claude', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'claude-headless', headless: true }],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'manual', session_id: 'codex-manual' }],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'codex-auto' }],
    ['codex', { hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'codex-headless', headless: true }],
  ]) {
    const fixture = seedBound(runtime);
    const before = durableBytes(fixture.root, fixture.runId);
    const beforeState = readState(fixture.root, fixture.runId).data;
    const result = runNode(['-e', BOOTSTRAP_SOURCE], {
      cwd: fixture.root,
      env: {
        ...bootstrapEnv(runtime === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT', PROOT),
        ...(input.headless ? { DEEP_LOOP_HEADLESS: '1' } : {}),
      },
      input: JSON.stringify({
        cwd: fixture.root,
        hook_event_name: input.hook_event_name,
        trigger: input.trigger,
        session_id: input.session_id,
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(durableBytes(fixture.root, fixture.runId), before);
    const after = readState(fixture.root, fixture.runId).data;
    assert.deepEqual(after.session_chain.lease, beforeState.session_chain.lease);
    assert.deepEqual(after.session_chain.sessions, beforeState.session_chain.sessions);
    assert.equal(checkpointFiles(fixture.root, fixture.runId).length, 1);
  }
});

test('no current run → no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc0-'));
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'no-run');
});

test('interactive compact-in-place → checkpoints in place, no spawn', async () => {
  const { root } = seed();
  // spawnFn is no longer accepted — just verify action and that no side-effect occurs.
  const r = await runPreCompactHandoff({ tty: true }, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'checkpointed');
});

test('compact-in-place attended idle → checkpointed with byte-identical loop and no child reservation', async () => {
  const { root, runId } = seed();
  const loopPath = join(runDir(root, runId), 'loop.json');
  const before = rf(loopPath, 'utf8');
  const beforeSessions = readState(root, runId).data.session_chain.sessions.length;

  const r = await runPreCompactHandoff({}, {
    root, now: Date.parse('2026-06-24T00:01:00Z'), env: {},
  });

  assert.deepEqual(r, { ok: true, action: 'checkpointed', headless: false });
  assert.equal(rf(loopPath, 'utf8'), before);
  assert.equal(readState(root, runId).data.session_chain.sessions.length, beforeSessions);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
  assert.equal(checkpointFiles(root, runId).length, 1);
});

test('compact-in-place attended acquired → checkpointed after rotation, byte-identical and no new reservation', async () => {
  const { root, runId } = seed();
  const emitted = emitHandoff(root, runId, {
    reason: 'manual rotation', trigger: 'manual-rotation', now: Date.parse('2026-06-24T00:01:00Z'),
    expect: { owner: runId, generation: 1 }, env: {},
  });
  assert.equal(emitted.ok, true);
  const acquired = acquireLease(root, runId, {
    owner: emitted.childRunId, expectGeneration: 1, runtime: 'claude', now: Date.parse('2026-06-24T00:02:00Z'),
  });
  assert.equal(acquired.reason, 'acquired');
  const loopPath = join(runDir(root, runId), 'loop.json');
  const before = rf(loopPath, 'utf8');
  const beforeSessions = readState(root, runId).data.session_chain.sessions.length;

  const r = await runPreCompactHandoff({}, {
    root, now: Date.parse('2026-06-24T00:03:00Z'), env: {},
  });

  assert.deepEqual(r, { ok: true, action: 'checkpointed', headless: false });
  assert.equal(rf(loopPath, 'utf8'), before);
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.sessions.length, beforeSessions);
  assert.equal(after.session_chain.lease.owner_run_id, emitted.childRunId);
  assert.equal(after.session_chain.lease.generation, 2);
  assert.equal(after.session_chain.lease.handoff_phase, 'acquired');
  assert.equal(checkpointFiles(root, runId).length, 1);
});

test('rotate-per-unit attended → existing emitted handoff behavior', async () => {
  const { root, runId } = seedRotate();
  const r = await runPreCompactHandoff({}, {
    root, now: Date.parse('2026-06-24T00:01:00Z'), env: {},
  });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, false);
  assert.ok(r.childRunId);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
  assert.deepEqual(checkpointFiles(root, runId), []);
});

test('compact-in-place headless invocation ignores attended policy and emits handoff', async () => {
  const { root, runId } = seed();
  const r = await runPreCompactHandoff({ unattended: true }, {
    root, now: Date.parse('2026-06-24T00:01:00Z'), env: {},
  });
  assert.equal(r.action, 'emitted');
  assert.equal(r.headless, true);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
  assert.deepEqual(checkpointFiles(root, runId), []);
});

test('compact-in-place reserved residue enters emitFn reserved-finalization path, not checkpoint path', async () => {
  const { root, runId } = seed();
  const reserved = reserveHandoff(root, runId, {
    trigger: 'milestone', now: Date.parse('2026-06-24T00:00:30Z'), expect: { owner: runId, generation: 1 },
  });
  assert.equal(reserved.reason, 'reserved');
  let emitCalls = 0;
  let checkpointCalls = 0;
  const emitFn = (...args) => {
    emitCalls += 1;
    return emitHandoff(...args);
  };
  const checkpointFn = () => { checkpointCalls += 1; };

  const r = await runPreCompactHandoff({}, {
    root, now: Date.parse('2026-06-24T00:01:00Z'), env: {}, emitFn, checkpointFn,
  });

  assert.equal(r.action, 'emitted');
  assert.equal(emitCalls, 1);
  assert.equal(checkpointCalls, 0);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('emitted/spawned handoff is an early no-op regardless of stored trigger', async () => {
  for (const phase of ['emitted', 'spawned']) {
    const { root, runId } = seed();
    const { data } = readState(root, runId);
    data.session_chain.lease = {
      ...data.session_chain.lease,
      state: 'releasing',
      handoff_phase: phase,
      handoff_idempotency_key: 'stored-key',
      handoff_child_run_id: '01INFLIGHTCHILD0000000000AA',
      handoff_trigger: 'milestone',
    };
    writeState(root, runId, data);
    let emitCalls = 0;
    let checkpointCalls = 0;
    const r = await runPreCompactHandoff({}, {
      root,
      now: Date.parse('2026-06-24T00:01:00Z'),
      env: {},
      emitFn: () => { emitCalls += 1; throw new Error('must not emit'); },
      checkpointFn: () => { checkpointCalls += 1; throw new Error('must not checkpoint'); },
    });
    assert.deepEqual(r, { ok: true, action: 'handoff-in-flight' });
    assert.equal(emitCalls, 0, `${phase}: emit must not be called`);
    assert.equal(checkpointCalls, 0, `${phase}: checkpoint must not be called`);
  }
});

test('compact-in-place checkpoint failure is best-effort and never blocks compaction', async () => {
  const { root } = seed();
  const r = await runPreCompactHandoff({}, {
    root,
    now: Date.parse('2026-06-24T00:01:00Z'),
    env: {},
    checkpointFn: () => { throw new Error('disk unavailable'); },
  });
  assert.deepEqual(r, { ok: true, action: 'checkpointed', headless: false });
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
  assert.equal(r.action, 'checkpointed');
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
  assert.equal(events(direct.root, direct.runId).filter(event => event.type === 'handoff-emitted').length, 0);
  assert.equal(checkpointFiles(direct.root, direct.runId).length, 1);

  for (const extraArgs of [[], [DRIVE_HOOK]]) {
    const imported = seed();
    const code = `await import(${JSON.stringify(pathToFileURL(PRECOMPACT_HOOK).href)})`;
    const result = runNode(['--input-type=module', '--eval', code, ...extraArgs], { cwd: imported.root });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(events(imported.root, imported.runId).filter(event => event.type === 'handoff-emitted').length, 0);
    assert.equal(checkpointFiles(imported.root, imported.runId).length, 0);
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
    const raced = readState(rollbackRoot, rollbackRunId).data;
    raced.status = 'completed';
    writeState(rollbackRoot, rollbackRunId, raced);
    terminalSnapshot = structuredClone(readState(rollbackRoot, rollbackRunId).data);
    return rollbackAndPause(rollbackRoot, rollbackRunId, options);
  };

  const r = await runPreCompactHandoff({ unattended: true }, {
    root,
    now: Date.parse('2026-06-24T00:01:00Z'),
    env: {},
    rollbackFn,
  });
  // spec §3.4.1: rollback 중 terminal 판명(구 {ok:false, action:'terminal'})도 benign no-run-terminal.
  assert.deepEqual(r, { ok: true, action: 'no-run-terminal' });
  assert.deepEqual(readState(root, runId).data, terminalSnapshot);   // 상태 무변경은 그대로 유지
});

// ── §3.4.1: emit-시점 경합(체크와 emit 사이 상태 전이) reason-특정 정규화 ──────────
// (c-1) readState는 active를 봤으나 emitHandoff가 RUN_TERMINAL 반환(내부 rollback 후) → benign
test('interleaving: emit returns RUN_TERMINAL on active-looking state → benign no-run-terminal', async () => {
  const { root } = seedRotate();
  const emitFn = () => ({ ok: false, reason: 'RUN_TERMINAL', key: 'k' });
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z'), emitFn });
  assert.deepEqual(r, { ok: true, action: 'no-run-terminal' });
});

// (c-2) emitHandoff가 RUN_PAUSED 반환(reserve-시점 거부) — 잔재 없음 → 단순 benign 정규화
test('interleaving: emit returns RUN_PAUSED without residue → benign no-run-paused, lease untouched', async () => {
  const { root, runId } = seedRotate();
  const before = structuredClone(readState(root, runId).data.session_chain.lease);
  const emitFn = () => ({ ok: false, reason: 'RUN_PAUSED', key: null });
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z'), emitFn });
  assert.deepEqual(r, { ok: true, action: 'no-run-paused' });
  assert.deepEqual(readState(root, runId).data.session_chain.lease, before);
});

// (c-3) 반환-RUN_PAUSED 시점에 phase='reserved' 잔재 → 정리 경유 후 benign (emitted/spawned는 보존 규칙대로)
test('interleaving: emit returns RUN_PAUSED with reserved residue → swept then benign no-run-paused', async () => {
  const { root, runId } = seedRotate();
  const emitFn = () => {
    const raced = readState(root, runId).data;
    raced.session_chain.lease = { ...raced.session_chain.lease, handoff_phase: 'reserved', handoff_idempotency_key: 'race-key', handoff_child_run_id: '01STALECHILD000000000000FF' };
    writeState(root, runId, raced);
    return { ok: false, reason: 'RUN_PAUSED', key: 'race-key' };
  };
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z'), emitFn });
  assert.deepEqual(r, { ok: true, action: 'no-run-paused' });
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
});

// (c-4) reserve 성공 후 append 중 pause → RUN_PAUSED **던짐**(rollback 없이 탈출) → reservation 정리 후 benign,
// handoff_phase idle 복귀 (정리 없이 정규화만 하면 이후 handoff가 in-flight 거부되는 교착이 남는다)
test('interleaving: emit THROWS RUN_PAUSED after reserve → reservation swept, handoff_phase back to idle, benign', async () => {
  const { root, runId } = seedRotate();
  const emitFn = () => {
    const raced = readState(root, runId).data;
    raced.session_chain.lease = { ...raced.session_chain.lease, handoff_phase: 'reserved', handoff_idempotency_key: 'thrown-key', handoff_child_run_id: '01STALECHILD000000000000GG' };
    writeState(root, runId, raced);
    throw new Error('RUN_PAUSED: emitHandoff');
  };
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z'), emitFn });
  assert.deepEqual(r, { ok: true, action: 'no-run-paused' });
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_idempotency_key, null);
  assert.equal(lease.handoff_child_run_id, null);
});

// fenced reason은 의도적으로 정규화하지 않는다 — 진짜 lease 이상 신호 표면화 (스코핑 회귀 방지)
test('emit returns fenced → stays non-benign ok:false action:fenced', async () => {
  const { root } = seedRotate();
  const emitFn = () => ({ ok: false, reason: 'fenced', key: null });
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z'), emitFn });
  assert.deepEqual(r, { ok: false, action: 'fenced', reason: 'fenced' });
});

function parseLog(path) {
  try { return rf(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

// ── §3.4.1: terminal run 무해 처리 — 검증-선행 fenced terminal-cleanup ──────────
// (a) 잔재 없음 → benign no-run-terminal, 상태 무변경(write 없음)
test('terminal run without residue → benign no-run-terminal, state untouched', async () => {
  for (const status of ['completed', 'stopped']) {
    const { root, runId } = seed();
    const { data } = readState(root, runId);
    data.status = status;
    writeState(root, runId, data);
    const before = structuredClone(readState(root, runId).data);
    const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z') });
    assert.deepEqual(r, { ok: true, action: 'no-run-terminal' });
    assert.deepEqual(readState(root, runId).data, before, `${status}: no write on residue-free terminal`);
  }
});

// (a) subprocess 레벨: exit 0 · stdout/stderr 무출력
test('terminal run subprocess → exit 0, silent', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'completed';
  writeState(root, runId, data);
  const result = runNode([PRECOMPACT_HOOK], { cwd: root, input: '{}' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

// (d) terminal + reserved 잔재 → fenced 정리 경로로 잔재(phase/key/child) 정리 + benign
test('terminal run with reserved residue → residue swept via rollbackHandoff, benign no-run-terminal', async () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'completed';
  data.session_chain.lease = { ...data.session_chain.lease, handoff_phase: 'reserved', handoff_idempotency_key: 'stale-key', handoff_child_run_id: '01STALECHILD000000000000AA' };
  writeState(root, runId, data);
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z') });
  assert.deepEqual(r, { ok: true, action: 'no-run-terminal' });
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_idempotency_key, null);
  assert.equal(lease.handoff_child_run_id, null);
  assert.equal(lease.state, 'released');   // terminal-aware rollback은 released로 불활성 안착
});

// (d′) version-skew: 스키마(type string)는 통과하지만 emitHandoff의 validateRuntimeProfile(MODEL_RE)이
// INVALID_MODEL을 던지는 낡은 메타데이터 상태 — 전용 정리 경로는 emitHandoff의 선행 검증을 경유하지
// 않으므로 정리가 성공하고 silent여야 한다.
test('terminal run with residue and malformed runtime metadata → cleanup still succeeds silently (version-skew)', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'stopped';
  data.autonomy.session_model = 'bad model name!';   // MODEL_RE 위반 — emitHandoff였다면 INVALID_MODEL throw
  data.session_chain.lease = { ...data.session_chain.lease, handoff_phase: 'emitted', handoff_idempotency_key: 'skewed-key', handoff_child_run_id: '01STALECHILD000000000000BB' };
  writeState(root, runId, data);
  const result = runNode([PRECOMPACT_HOOK], { cwd: root, input: '{}' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'idle');
});

// (d-acquired) handoff/resume을 거쳐 완료된 run은 lease가 active/acquired로 남는다(finishRun은 lease
// 미초기화, acquireLease가 key/child를 null로 세팅) — spec §3.4.1 잔재 정의(phase ≠ idle)에 따라
// sweep되어 released/idle로 불활성 안착해야 한다 (checker 008 B2).
test('terminal run with acquired lease (post-resume finish) → swept to released/idle, benign', async () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'completed';
  data.session_chain.lease = { ...data.session_chain.lease, state: 'active', handoff_phase: 'acquired', handoff_idempotency_key: null, handoff_child_run_id: null };
  writeState(root, runId, data);
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z') });
  assert.deepEqual(r, { ok: true, action: 'no-run-terminal' });
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'released');
  assert.equal(lease.handoff_phase, 'idle');
});

// ── §3.4.1: paused run 무해 처리 — 정리 범위는 phase='reserved'만 ──────────
// (b) paused, 잔재 없음 → benign no-run-paused, 무변경
test('paused run without residue → benign no-run-paused, state untouched', async () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'paused';
  writeState(root, runId, data);
  const before = structuredClone(readState(root, runId).data);
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z') });
  assert.deepEqual(r, { ok: true, action: 'no-run-paused' });
  assert.deepEqual(readState(root, runId).data, before);
});

// (b) subprocess 레벨: exit 0 · silent
test('paused run subprocess → exit 0, silent', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'paused';
  writeState(root, runId, data);
  const result = runNode([PRECOMPACT_HOOK], { cwd: root, input: '{}' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

// (d″-1) paused + phase='reserved'(stale 중단-emit reservation) → fenced 정리 후 no-run-paused
test('paused run with reserved residue → residue swept, benign no-run-paused', async () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.session_chain.lease = { ...data.session_chain.lease, handoff_phase: 'reserved', handoff_idempotency_key: 'stale-key', handoff_child_run_id: '01STALECHILD000000000000DD' };
  writeState(root, runId, data);
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z') });
  assert.deepEqual(r, { ok: true, action: 'no-run-paused' });
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_idempotency_key, null);
  assert.equal(lease.handoff_child_run_id, null);
});

// (d″-2) paused + emitted/spawned = preserve-pause의 의도적 연속성 상태 → 절대 무변경 보존
test('paused run with emitted/spawned residue → preserved untouched, benign no-run-paused', async () => {
  for (const phase of ['emitted', 'spawned']) {
    const { root, runId } = seed();
    const { data } = readState(root, runId);
    data.status = 'paused';
    data.session_chain.lease = { ...data.session_chain.lease, handoff_phase: phase, handoff_idempotency_key: 'live-key', handoff_child_run_id: '01LIVECHILD0000000000000EE', state: 'releasing' };
    writeState(root, runId, data);
    const before = structuredClone(readState(root, runId).data);
    const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z') });
    assert.deepEqual(r, { ok: true, action: 'no-run-paused' });
    assert.deepEqual(readState(root, runId).data, before, `${phase}: preserve-pause 연속성 파괴 금지`);
  }
});

// (d‴) fenced 경합: 정리 도중 owner/generation 변경 → 비-benign 전파 (false success 금지)
test('terminal cleanup raced by lease change → non-benign fenced propagation', async () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'completed';
  data.session_chain.lease = { ...data.session_chain.lease, handoff_phase: 'reserved', handoff_idempotency_key: 'race-key', handoff_child_run_id: '01STALECHILD000000000000CC' };
  writeState(root, runId, data);
  const { rollbackHandoff } = await import('../scripts/lib/lease.mjs');
  const cleanupFn = (r2, id2, fence) => {
    const raced = readState(r2, id2).data;
    raced.session_chain.lease = { ...raced.session_chain.lease, owner_run_id: 'someone-else', generation: raced.session_chain.lease.generation + 1 };
    writeState(r2, id2, raced);
    return rollbackHandoff(r2, id2, fence);
  };
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-07-19T00:01:00Z'), cleanupFn });
  assert.deepEqual(r, { ok: false, action: 'fenced', reason: 'residue-cleanup-fenced' });
});
