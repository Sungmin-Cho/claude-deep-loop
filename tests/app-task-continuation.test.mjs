import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { appendAnchored, readLines } from '../scripts/lib/integrity.mjs';
import { acquireLease, releaseLease } from '../scripts/lib/lease.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { observeHostSurface, revokeAppTaskContinuation, statusAppTask,
  validateGenesisConsent } from '../scripts/lib/app-task-continuation.mjs';
import { appHostTaskCwdDigest, hostSurfaceFactsDigest } from '../scripts/lib/host-surface.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';

function observedRun({ legacyNullSurface = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-observe-')));
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z') });
  if (legacyNullSurface) {
    const loop = readState(root, runId).data;
    delete loop.initialization;
    delete loop.autonomy.app_task_continuation;
    loop.session_chain.sessions[0].host_surface = null;
    writeState(root, runId, loop);
  }
  return { root, runId };
}

const observationInput = root => ({ kind: 'codex-app',
  source: 'codex-app-tool-provenance',
  capabilities: ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin'],
  structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
  host_task_cwd_source: 'app-task-context' });

test('host-surface observe is write-free in-generation and re-attests identical later generations', () => {
  const { root, runId } = observedRun();
  const deps = { kernelCwd: root, platform: process.platform,
    realpath: value => value, stat: () => ({ dev: 1, ino: 1 }),
    sameFile: () => true, nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
  const input = { owner: runId, generation: 1, runtime: 'codex',
    readerMode: 'pty-raw-noecho', observation: observationInput(root) };
  assert.equal(observeHostSurface(root, runId, input, deps).outcome, 'observed');
  const stored = readState(root, runId).data.session_chain.sessions[0].host_surface;
  assert.equal(stored.observed_generation, 1);
  assert.equal(stored.observed_at, '2026-07-13T00:00:01.000Z');
  assert.equal(stored.structured_stdin_mode, input.readerMode);
  const before = { state: readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    events: readLines(root, runId) };
  assert.equal(observeHostSurface(root, runId, input, deps).outcome, 'already-observed');
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')), before.state);
  assert.deepEqual(readLines(root, runId), before.events);

  assert.equal(releaseLease(root, runId, { owner: runId, generation: 1 }).reason, 'released');
  assert.deepEqual(acquireLease(root, runId, { owner: runId, expectGeneration: 1,
    runtime: 'codex', now: Date.parse('2026-07-13T00:00:01.000Z') }),
  { ok: true, generation: 2, reason: 'acquired' });
  const stale = readState(root, runId).data;
  assert.equal(stale.session_chain.lease.generation, 2);
  assert.equal(stale.session_chain.sessions[0].host_surface.observed_generation, 1,
    'generic acquire makes the old positive surface historical without rewriting it');
  assert.equal(observeHostSurface(root, runId, { ...input, generation: 2 }, deps).outcome,
    'reattested');
  const refreshed = readState(root, runId).data.session_chain.sessions[0].host_surface;
  assert.equal(refreshed.observed_generation, 2);
  assert.equal(refreshed.observed_at, '2026-07-13T00:00:01.000Z',
    'generation, not wall-clock ordering, restores current authority');
  const observationEvents = readLines(root, runId)
    .filter(event => event.type === 'host-surface-observed');
  assert.equal(observationEvents.length, 2);
  const observationDigest = hostSurfaceFactsDigest(refreshed);
  assert.deepEqual(observationEvents.map(event => ({ ts: event.ts, data: event.data })), [
    { ts: '2026-07-13T00:00:01.000Z', data: { run_id: runId, owner_run_id: runId,
      kind: 'codex-app', observed_generation: 1, observation_digest: observationDigest,
      outcome: 'observed' } },
    { ts: '2026-07-13T00:00:01.000Z', data: { run_id: runId, owner_run_id: runId,
      kind: 'codex-app', observed_generation: 2, observation_digest: observationDigest,
      outcome: 'reattested' } },
  ]);
  const afterRefresh = { state: readFileSync(join(root, '.deep-loop', 'runs', runId,
    'loop.json')), events: readLines(root, runId) };
  assert.equal(observeHostSurface(root, runId, { ...input, generation: 2 }, deps).outcome,
    'already-observed');
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    afterRefresh.state);
  assert.deepEqual(readLines(root, runId), afterRefresh.events);

  const changed = structuredClone({ ...input, generation: 2 });
  changed.observation.capabilities.push('create-thread-local');
  assert.throws(() => observeHostSurface(root, runId, changed, deps), /HOST_SURFACE_FENCED/);
});

test('App observe accepts root or one active recorded worktree and rejects escape before write', () => {
  const accepted = observedRun();
  const worktree = join(accepted.root, '.worktrees', 'observe');
  mkdirSync(worktree, { recursive: true });
  const loop = readState(accepted.root, accepted.runId).data;
  loop.workstreams = [{ id: 'WS1', status: 'in_progress', worktree: '.worktrees/observe' }];
  loop.active_workstreams = ['WS1'];
  writeState(accepted.root, accepted.runId, loop);
  const native = cwd => ({ kernelCwd: cwd, platform: process.platform,
    exists: existsSync, realpath: value => realpathSync(value),
    stat: value => statSync(value, { bigint: true }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  const input = { owner: accepted.runId, generation: 1, runtime: 'codex',
    readerMode: 'pty-raw-noecho', observation: observationInput(worktree) };
  assert.equal(observeHostSurface(accepted.root, accepted.runId, input, native(worktree)).outcome,
    'observed');

  for (const staleStatus of ['parked', 'ready', 'merged']) {
    const stale = observedRun();
    const staleWorktree = join(stale.root, '.worktrees', `observe-${staleStatus}`);
    mkdirSync(staleWorktree, { recursive: true });
    const staleLoop = readState(stale.root, stale.runId).data;
    staleLoop.workstreams = [{ id: 'WS1', status: staleStatus,
      worktree: `.worktrees/observe-${staleStatus}` }];
    staleLoop.active_workstreams = ['WS1'];
    writeState(stale.root, stale.runId, staleLoop);
    const staleBefore = { state: readFileSync(join(stale.root, '.deep-loop', 'runs', stale.runId,
      'loop.json')), events: readLines(stale.root, stale.runId) };
    assert.throws(() => observeHostSurface(stale.root, stale.runId, {
      owner: stale.runId, generation: 1, runtime: 'codex', readerMode: 'pty-raw-noecho',
      observation: observationInput(staleWorktree),
    }, native(staleWorktree)), /HOST_SURFACE_FENCED/);
    assert.deepEqual(readFileSync(join(stale.root, '.deep-loop', 'runs', stale.runId,
      'loop.json')), staleBefore.state);
    assert.deepEqual(readLines(stale.root, stale.runId), staleBefore.events);
  }

  const escaped = observedRun();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dl-observe-outside-')));
  const before = { state: readFileSync(join(escaped.root, '.deep-loop', 'runs', escaped.runId,
    'loop.json')), events: readLines(escaped.root, escaped.runId) };
  assert.throws(() => observeHostSurface(escaped.root, escaped.runId, {
    owner: escaped.runId, generation: 1, runtime: 'codex', readerMode: 'pty-raw-noecho',
    observation: observationInput(outside),
  }, native(outside)), /HOST_SURFACE_FENCED/);
  assert.deepEqual(readFileSync(join(escaped.root, '.deep-loop', 'runs', escaped.runId,
    'loop.json')), before.state);
  assert.deepEqual(readLines(escaped.root, escaped.runId), before.events);
});

test('observe wrong owner generation runtime or current directory is fence-only', () => {
  const { root, runId } = observedRun();
  const deps = { kernelCwd: root, platform: process.platform, realpath: value => value,
    stat: value => ({ dev: 1, ino: value === root ? 1 : 2 }),
    sameFile: (left, right) => left.ino === right.ino,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
  const base = { owner: runId, generation: 1, runtime: 'codex',
    readerMode: 'pty-raw-noecho', observation: observationInput(root) };
  for (const changed of [
    { ...base, owner: '01JAPP0TH00000000000000000' }, { ...base, generation: 2 },
    { ...base, runtime: 'claude' },
    { ...base, readerMode: 'pipe-open-noecho' },
    { ...base, observation: { ...base.observation, host_task_cwd: '/other' } },
  ]) assert.throws(() => observeHostSurface(root, runId, changed, deps), /FENCED/);
});

test('full observe rejects non-six-key raw input without state event or secret leakage', () => {
  for (const extra of ['runtime', 'kernel_cwd_at_observation', 'observed_generation', 'observed_at',
    'projectId', 'threadId', 'clientThreadId']) {
    const { root, runId } = observedRun();
    const statePath = join(root, '.deep-loop', 'runs', runId, 'loop.json');
    const before = { state: readFileSync(statePath), events: readLines(root, runId) };
    const sentinel = `OBSERVE_RAW_EXTRA_${extra}`;
    const deps = { kernelCwd: root, platform: process.platform,
      realpath: value => value, stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true,
      nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
    assert.throws(() => observeHostSurface(root, runId, { owner: runId, generation: 1,
      runtime: 'codex', readerMode: 'pty-raw-noecho',
      observation: { ...observationInput(root), [extra]: sentinel } }, deps),
    /HOST_OBSERVATION_INPUT_INVALID/);
    assert.deepEqual(readFileSync(statePath), before.state, extra);
    assert.deepEqual(readLines(root, runId), before.events, extra);
    assert.equal((before.state.toString('utf8') + JSON.stringify(before.events))
      .includes(sentinel), false, extra);
  }
});

test('enum-only Codex App observe records positive enums without host cwd authority', () => {
  const { root, runId } = observedRun();
  const input = { owner: runId, generation: 1, runtime: 'codex', readerMode: null,
    observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects'], structured_stdin_mode: null,
      host_task_cwd: null, host_task_cwd_source: null } };
  const deps = { kernelCwd: root, platform: process.platform,
    realpath: value => value, stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
  assert.equal(observeHostSurface(root, runId, input, deps).outcome, 'observed');
  const stored = readState(root, runId).data.session_chain.sessions[0].host_surface;
  assert.deepEqual(stored, { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['create-thread-local', 'list-projects'], structured_stdin_mode: null,
    host_task_cwd: null, host_task_cwd_source: null,
    kernel_cwd_at_observation: root, observed_generation: 1,
    observed_at: '2026-07-13T00:00:01.000Z' });
});

test('enum-only observe fences an external kernel cwd before state or event write', () => {
  const { root, runId } = observedRun();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dl-observe-enum-outside-')));
  const statePath = join(root, '.deep-loop', 'runs', runId, 'loop.json');
  const before = { state: readFileSync(statePath), events: readLines(root, runId) };
  const deps = { kernelCwd: outside, platform: process.platform,
    realpath: value => realpathSync(value), stat: value => statSync(value, { bigint: true }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
  assert.throws(() => observeHostSurface(root, runId, {
    owner: runId, generation: 1, runtime: 'codex', readerMode: null,
    observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects'], structured_stdin_mode: null,
      host_task_cwd: null, host_task_cwd_source: null },
  }, deps), /HOST_SURFACE_FENCED/);
  assert.deepEqual(readFileSync(statePath), before.state);
  assert.deepEqual(readLines(root, runId), before.events);
});

test('enum-only observe accepts one active recorded worktree as the kernel cwd', () => {
  const { root, runId } = observedRun();
  const worktree = join(root, '.worktrees', 'enum-observe');
  mkdirSync(worktree, { recursive: true });
  const loop = readState(root, runId).data;
  loop.workstreams = [{ id: 'WS1', status: 'in_review', worktree: '.worktrees/enum-observe' }];
  loop.active_workstreams = ['WS1'];
  writeState(root, runId, loop);
  const deps = { kernelCwd: worktree, platform: process.platform,
    realpath: value => realpathSync(value), stat: value => statSync(value, { bigint: true }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
  assert.equal(observeHostSurface(root, runId, {
    owner: runId, generation: 1, runtime: 'codex', readerMode: null,
    observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects'], structured_stdin_mode: null,
      host_task_cwd: null, host_task_cwd_source: null },
  }, deps).outcome, 'observed');
  const stored = readState(root, runId).data.session_chain.sessions[0].host_surface;
  assert.equal(stored.kernel_cwd_at_observation, realpathSync(worktree));
  assert.equal(stored.host_task_cwd, null);
});

test('production initialized host surface cannot be upgraded by observe', () => {
  const { root, runId } = observedRun({ legacyNullSurface: false });
  const before = { state: readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    events: readLines(root, runId) };
  const deps = { kernelCwd: root, platform: process.platform,
    realpath: value => value, stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
  assert.throws(() => observeHostSurface(root, runId, {
    owner: runId, generation: 1, runtime: 'codex', readerMode: null,
    observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects'], structured_stdin_mode: null,
      host_task_cwd: null, host_task_cwd_source: null },
  }, deps), /HOST_SURFACE_FENCED/);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')), before.state);
  assert.deepEqual(readLines(root, runId), before.events);
});

test('legacy absent host surface materializes but an explicit null observation is inert', () => {
  const legacy = observedRun();
  const legacyLoop = readState(legacy.root, legacy.runId).data;
  delete legacyLoop.session_chain.sessions[0].host_surface;
  writeState(legacy.root, legacy.runId, legacyLoop);
  const deps = root => ({ kernelCwd: root, platform: process.platform,
    realpath: value => value, stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  const full = { owner: legacy.runId, generation: 1, runtime: 'codex',
    readerMode: 'pty-raw-noecho', observation: observationInput(legacy.root) };
  assert.equal(observeHostSurface(legacy.root, legacy.runId, full, deps(legacy.root)).outcome,
    'observed');
  assert.equal(readState(legacy.root, legacy.runId)
    .data.session_chain.sessions[0].host_surface.kind, 'codex-app');

  const ambiguous = observedRun();
  const before = {
    state: readFileSync(join(ambiguous.root, '.deep-loop', 'runs', ambiguous.runId, 'loop.json')),
    events: readLines(ambiguous.root, ambiguous.runId),
  };
  const nullInput = { owner: ambiguous.runId, generation: 1, runtime: 'codex',
    readerMode: null, observation: { runtime: 'codex', kind: null, source: null,
      capabilities: [], structured_stdin_mode: null, host_task_cwd: null,
      host_task_cwd_source: null, observed_at: null } };
  assert.equal(observeHostSurface(ambiguous.root, ambiguous.runId, nullInput,
    deps(ambiguous.root)).outcome, 'unobserved');
  assert.deepEqual(readFileSync(join(ambiguous.root, '.deep-loop', 'runs', ambiguous.runId,
    'loop.json')), before.state);
  assert.deepEqual(readLines(ambiguous.root, ambiguous.runId), before.events);
});

function autoRun() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-consent-')));
  const observation = { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
    structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
    host_task_cwd_source: 'app-task-context',
    observed_at: '2026-07-13T00:00:00.000Z' };
  const consent = { mode: 'auto', authority: 'human-confirmed',
    confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null };
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z'),
    hostObservation: observation, appContinuationConsent: consent, cwdFn: () => root });
  const stored = readState(root, runId).data;
  return { root, runId,
    observation: stored.session_chain.sessions[0].host_surface,
    consent: stored.autonomy.app_task_continuation };
}

function writeUncheckedLoop(root, runId, loop) {
  const raw = JSON.stringify(loop, null, 2);
  const run = join(root, '.deep-loop', 'runs', runId);
  writeFileSync(join(run, 'loop.json'), raw);
  writeFileSync(join(run, '.loop.hash'), contentHash(raw));
}

function rewriteAnchoredEvents(root, runId, loop, transform) {
  const run = join(root, '.deep-loop', 'runs', runId);
  const events = transform(structuredClone(readLines(root, runId)));
  let previous = 'GENESIS';
  for (const [index, event] of events.entries()) {
    event.seq = index + 1;
    event.checksum = contentHash(`${event.seq}|${event.ts}|${event.type}|${JSON.stringify(event.data)}|${previous}`);
    previous = event.checksum;
  }
  writeFileSync(join(run, 'event-log.jsonl'), events.length === 0 ? ''
    : `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  loop.event_log_head = events.length === 0 ? { seq: 0, checksum: 'GENESIS' }
    : { seq: events.at(-1).seq, checksum: events.at(-1).checksum };
  writeUncheckedLoop(root, runId, loop);
}

function preservedAutoRun(phase) {
  const fixture = autoRun();
  const attempt = '01JAPPTASK0000000000000000';
  const child = '01JAPPCHD00000000000000000';
  const emitted = '2026-07-13T00:00:00.000Z';
  appendAnchored(fixture.root, fixture.runId, { type: 'handoff-emitted',
    data: { attempt_id: attempt, child_run_id: child } }, loop => {
    const parent = loop.session_chain.sessions[0];
    parent.superseded_by = child;
    Object.assign(loop.session_chain.lease, { state: 'releasing', handoff_phase: 'emitted',
      handoff_idempotency_key: 'a'.repeat(16), handoff_child_run_id: child,
      handoff_transport: 'codex-app', handoff_attempt_id: attempt,
      resume_policy: 'app', expires_at: '2026-07-13T00:15:00.000Z' });
    loop.session_chain.sessions.push({ run_id: child, started_at: null, ended_at: null,
      turns: 0, outcome: null, superseded_by: null, host_surface: null,
      continuation: { transport: 'codex-app', attempt_id: attempt, route: 'create',
        context_mode: 'fresh', phase: 'emitted', expected_runtime: 'codex',
        expected_host_surface: 'codex-app', target_cwd: fixture.root,
        host_task_cwd_digest: appHostTaskCwdDigest(parent.host_surface, fixture.root),
        workstream_id: null, project_id: null, descriptor_digest: null,
        emitted_at: emitted, prepare_deadline: '2026-07-13T00:05:00.000Z',
        prepared_at: null, confirmation_deadline: null, confirmed_at: null,
        acquired_at: null, acquired_generation: null, thread_id: null,
        unconfirmed_thread_id: null, failure_code: null, failure_binding: null } });
  }, undefined, { nowFn: () => Date.parse(emitted) });
  const loop = readState(fixture.root, fixture.runId).data;
  Object.assign(loop, { status: 'paused', pause_reason: phase === 'emitted'
    ? 'app-launch-unconfirmed' : 'app-child-timeout-awaiting' });
  Object.assign(loop.session_chain.lease, { handoff_phase: phase === 'emitted'
    ? 'emitted' : 'spawned', resume_policy: 'human', expires_at: null });
  const continuation = loop.session_chain.sessions.at(-1).continuation;
  if (phase !== 'emitted') Object.assign(continuation, { phase, project_id: 'project-safe-id',
    descriptor_digest: 'd'.repeat(64), prepared_at: '2026-07-13T00:00:10.000Z',
    confirmation_deadline: '2026-07-13T00:02:10.000Z' });
  if (phase === 'confirmed') Object.assign(continuation, {
    confirmed_at: '2026-07-13T00:00:15.000Z', thread_id: 'raw-thread-must-not-leak',
  });
  if (phase === 'emitted') {
    writeState(fixture.root, fixture.runId, loop);
  } else {
    rewriteAnchoredEvents(fixture.root, fixture.runId, loop, events => [...events,
      { type: 'app-task-prepared', ts: continuation.prepared_at, data: {
        attempt_id: attempt, child_run_id: child,
        descriptor_digest: continuation.descriptor_digest,
      } },
      ...(phase === 'confirmed' ? [{ type: 'app-task-confirmed',
        ts: continuation.confirmed_at, data: { attempt_id: attempt, child_run_id: child,
          receipt_digest: contentHash(`confirmed-thread\0${continuation.thread_id}`) } }] : []),
    ]);
  }
  return { ...fixture, attempt, child };
}

test('genesis consent accepts only default manual or route-matched complete App auto', () => {
  assert.deepEqual(validateGenesisConsent({ runtime: 'codex', route: null,
    observation: null, consent: null }),
  { mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null });
  const { observation, consent } = autoRun();
  assert.deepEqual(validateGenesisConsent({ runtime: 'codex', route: 'create',
    observation, consent }), consent);
  for (const changed of [
    { runtime: 'claude', route: 'create', observation, consent },
    { runtime: 'codex', route: 'create',
      observation: { ...observation, host_task_cwd: '/other' }, consent },
    { runtime: 'codex', route: 'create', observation: { ...observation,
      capabilities: ['structured-process-stdin'] }, consent },
    { runtime: 'codex', route: 'fork', observation, consent },
    { runtime: 'codex', route: 'create', observation,
      consent: { ...consent, authority: 'default-manual' } },
  ]) assert.throws(() => validateGenesisConsent(changed), /APP_CONSENT_INVALID/);
});

test('genesis consent rejects accessors without invocation and returns one frozen data snapshot', () => {
  let reads = 0;
  const accessor = { authority: 'default-manual', confirmed_at: null, revoked_at: null };
  Object.defineProperty(accessor, 'mode', { enumerable: true, get() {
    reads++;
    return reads === 1 ? 'manual' : 'auto';
  } });
  assert.throws(() => validateGenesisConsent({ runtime: 'codex', route: null,
    observation: null, consent: accessor }), /APP_CONSENT_INVALID/);
  assert.equal(reads, 0, 'descriptor validation must not invoke attacker-controlled accessors');

  const consent = { mode: 'manual', authority: 'default-manual',
    confirmed_at: null, revoked_at: null };
  const snapshot = validateGenesisConsent({ runtime: 'codex', route: null,
    observation: null, consent });
  consent.mode = 'auto';
  assert.equal(snapshot.mode, 'manual');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.notStrictEqual(snapshot, consent);
});

test('revoke is one anchored write, exact retry is inert, and default manual is not-auto', () => {
  const { root, runId } = autoRun();
  const input = { owner: runId, generation: 1, runtime: 'codex' };
  const deps = { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') };
  assert.equal(revokeAppTaskContinuation(root, runId, input, deps).outcome, 'revoked');
  const before = { state: readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    events: readLines(root, runId) };
  assert.equal(revokeAppTaskContinuation(root, runId, input, deps).outcome, 'already-revoked');
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')), before.state);
  assert.deepEqual(readLines(root, runId), before.events);
  const status = statusAppTask(root, runId, {});
  assert.deepEqual(Object.keys(status).sort(), ['current', 'generation', 'generic_current', 'handoff_phase',
    'has_app_history', 'history', 'logical_run_id', 'manual_recovery', 'ok', 'owner_run_id',
    'recovery_pending', 'resume_policy']);
  assert.equal(status.generic_current, null);
  assert.equal(status.recovery_pending, null);
  assert.equal(status.resume_policy, null);
  assert.equal(status.manual_recovery, false);
  assert.equal(JSON.stringify(status).includes('thread_id'), false);
  const manual = observedRun({ legacyNullSurface: false });
  const manualBefore = readLines(manual.root, manual.runId);
  assert.equal(revokeAppTaskContinuation(manual.root, manual.runId,
    { owner: manual.runId, generation: 1, runtime: 'codex' }, deps).outcome, 'not-auto');
  assert.deepEqual(readLines(manual.root, manual.runId), manualBefore);
});

test('revoke retry and not-auto verify schema, anchored log, and event correlation before success', () => {
  for (const corruption of ['missing-event', 'tampered-event', 'malformed-state']) {
    const fixture = autoRun();
    const input = { owner: fixture.runId, generation: 1, runtime: 'codex' };
    assert.equal(revokeAppTaskContinuation(fixture.root, fixture.runId, input,
      { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') }).outcome, 'revoked');
    const loop = readState(fixture.root, fixture.runId).data;
    if (corruption === 'missing-event') {
      rewriteAnchoredEvents(fixture.root, fixture.runId, loop,
        events => events.filter(event => event.type !== 'app-task-consent-revoked'));
    } else if (corruption === 'tampered-event') {
      rewriteAnchoredEvents(fixture.root, fixture.runId, loop, events => {
        events.find(event => event.type === 'app-task-consent-revoked')
          .data.owner_run_id = '01JAPPWR0NG000000000000000';
        return events;
      });
    } else {
      loop.autonomy.app_task_continuation.authority = 'default-manual';
      writeUncheckedLoop(fixture.root, fixture.runId, loop);
    }
    const run = join(fixture.root, '.deep-loop', 'runs', fixture.runId);
    const before = { state: readFileSync(join(run, 'loop.json')),
      events: readFileSync(join(run, 'event-log.jsonl')) };
    assert.throws(() => revokeAppTaskContinuation(fixture.root, fixture.runId, input,
      { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z') }),
    /RUN_SNAPSHOT_INVALID/, corruption);
    assert.deepEqual(readFileSync(join(run, 'loop.json')), before.state, corruption);
    assert.deepEqual(readFileSync(join(run, 'event-log.jsonl')), before.events, corruption);
  }

  const manual = observedRun({ legacyNullSurface: false });
  appendAnchored(manual.root, manual.runId, { type: 'app-task-consent-revoked', data: {
    owner_run_id: manual.runId, generation: 1, attempt_id: null,
    child_run_id: null, failure_code: null,
  } }, undefined, undefined, { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  const run = join(manual.root, '.deep-loop', 'runs', manual.runId);
  const before = { state: readFileSync(join(run, 'loop.json')),
    events: readFileSync(join(run, 'event-log.jsonl')) };
  assert.throws(() => revokeAppTaskContinuation(manual.root, manual.runId,
    { owner: manual.runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z') }), /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(readFileSync(join(run, 'loop.json')), before.state);
  assert.deepEqual(readFileSync(join(run, 'event-log.jsonl')), before.events);
});

test('revoke rejects a backward consent clock before appending an event', () => {
  const { root, runId } = autoRun();
  const before = {
    state: readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    events: readLines(root, runId),
  };
  assert.throws(() => revokeAppTaskContinuation(root, runId,
    { owner: runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-12T23:59:59.999Z') }),
  /APP_TASK_CONSENT_INVALID/);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    before.state);
  assert.deepEqual(readLines(root, runId), before.events);
});

test('revoke checks fence before terminal and abandons an in-flight attempt atomically', () => {
  const { root, runId } = autoRun();
  const loop = readState(root, runId).data;
  loop.status = 'completed';
  writeState(root, runId, loop);
  assert.throws(() => revokeAppTaskContinuation(root, runId,
    { owner: '01JAPPWR0NG000000000000000', generation: 9, runtime: 'codex' }, {}), /FENCED/);
  assert.throws(() => revokeAppTaskContinuation(root, runId,
    { owner: runId, generation: 1, runtime: 'codex' }, {}), /TERMINAL/);
});

test('revoke abandons only the exact current live attempt in the same anchored transaction', () => {
  const { root, runId } = autoRun();
  const attempt = '01JAPPTASK0000000000000000';
  const child = '01JAPPCHD00000000000000000';
  const emitted = '2026-07-13T00:00:00.000Z';
  appendAnchored(root, runId, { type: 'handoff-emitted',
    data: { attempt_id: attempt, child_run_id: child } }, loop => {
    const parent = loop.session_chain.sessions[0];
    loop.session_chain.lease = { ...loop.session_chain.lease, state: 'releasing',
      handoff_phase: 'emitted', handoff_idempotency_key: 'a'.repeat(16),
      handoff_child_run_id: child, handoff_transport: 'codex-app',
      handoff_attempt_id: attempt, resume_policy: 'app',
      expires_at: '2026-07-13T00:15:00.000Z' };
    parent.superseded_by = child;
    loop.session_chain.sessions.push({ run_id: child, started_at: null, ended_at: null,
      turns: 0, outcome: null, superseded_by: null, host_surface: null,
      continuation: { transport: 'codex-app', attempt_id: attempt, route: 'create',
        context_mode: 'fresh', phase: 'emitted', expected_runtime: 'codex',
        expected_host_surface: 'codex-app', target_cwd: root,
        host_task_cwd_digest: appHostTaskCwdDigest(parent.host_surface, root),
        workstream_id: null, project_id: null, descriptor_digest: null,
        emitted_at: emitted, prepare_deadline: '2026-07-13T00:05:00.000Z',
        prepared_at: null, confirmation_deadline: null, confirmed_at: null,
        acquired_at: null, acquired_generation: null, thread_id: null,
        unconfirmed_thread_id: null, failure_code: null, failure_binding: null } });
  }, undefined, { nowFn: () => Date.parse(emitted) });
  const loop = readState(root, runId).data;
  const orphan = structuredClone(loop.session_chain.sessions.at(-1));
  orphan.run_id = '01JAPPCHD00000000000000001';
  orphan.continuation.attempt_id = '01JAPPTASK0000000000000001';
  loop.session_chain.sessions.push(orphan);
  writeUncheckedLoop(root, runId, loop);
  const beforeRejected = {
    state: readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    events: readLines(root, runId),
  };
  assert.throws(() => revokeAppTaskContinuation(root, runId,
    { owner: runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') }), /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    beforeRejected.state);
  assert.deepEqual(readLines(root, runId), beforeRejected.events,
    'ambiguous live cardinality must fail before appendAnchored writes an event');
  loop.session_chain.sessions.pop();
  const orphanedLease = structuredClone(loop);
  orphanedLease.session_chain.sessions.pop();
  writeUncheckedLoop(root, runId, orphanedLease);
  const orphanBytes = readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json'));
  assert.throws(() => revokeAppTaskContinuation(root, runId,
    { owner: runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') }), /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    orphanBytes);
  assert.deepEqual(readLines(root, runId), beforeRejected.events,
    'an orphan App lease binding also fails before event append');
  writeState(root, runId, loop);
  assert.equal(revokeAppTaskContinuation(root, runId,
    { owner: runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z') }).outcome, 'revoked');
  const after = readState(root, runId).data;
  const continuation = after.session_chain.sessions.find(item => item.run_id === child).continuation;
  assert.equal(after.autonomy.app_task_continuation.mode, 'manual');
  assert.equal(after.autonomy.app_task_continuation.revoked_at, '2026-07-13T00:00:02.000Z');
  assert.equal(continuation.phase, 'abandoned');
  assert.equal(continuation.failure_code, 'consent-revoked');
  assert.equal(after.session_chain.lease.resume_policy, 'human');
  assert.equal(after.session_chain.lease.expires_at, null);
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'app-task-human-preserve');
  const status = statusAppTask(root, runId, {});
  assert.equal(status.current.phase, 'abandoned');
  assert.equal(status.manual_recovery, true);
});

test('revoke accepts only exact primary human-preserve shapes and status projects no raw facts', () => {
  for (const phase of ['emitted', 'confirmed']) {
    const fixture = preservedAutoRun(phase);
    assert.equal(revokeAppTaskContinuation(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, runtime: 'codex' },
      { nowFn: () => Date.parse('2026-07-13T00:00:20.000Z') }).outcome, 'revoked');
    const stored = readState(fixture.root, fixture.runId).data;
    assert.equal(stored.session_chain.sessions.at(-1).continuation.phase, 'abandoned');
    const status = statusAppTask(fixture.root, fixture.runId, { attempt: fixture.attempt });
    assert.deepEqual(Object.keys(status.current).sort(),
      ['attempt_id', 'failure_code', 'handoff_rel', 'phase', 'route', 'run_id']);
    const projected = JSON.stringify(status);
    for (const raw of [fixture.root, 'project-safe-id', 'd'.repeat(64),
      'raw-thread-must-not-leak', 'host_task_cwd', 'descriptor_digest', 'thread_id']) {
      assert.equal(projected.includes(raw), false, `${phase}: ${raw}`);
    }
  }

  const invalid = preservedAutoRun('prepared');
  const before = { state: readFileSync(join(invalid.root, '.deep-loop', 'runs', invalid.runId,
    'loop.json')), events: readLines(invalid.root, invalid.runId) };
  assert.throws(() => revokeAppTaskContinuation(invalid.root, invalid.runId,
    { owner: invalid.runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:20.000Z') }), /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(readFileSync(join(invalid.root, '.deep-loop', 'runs', invalid.runId,
    'loop.json')), before.state);
  assert.deepEqual(readLines(invalid.root, invalid.runId), before.events);
});
