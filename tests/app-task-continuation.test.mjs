import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { appendAnchored, readLines, readVerifiedState } from '../scripts/lib/integrity.mjs';
import { acquireLease, releaseLease, reserveHandoff } from '../scripts/lib/lease.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { observeHostSurface, revokeAppTaskContinuation, statusAppTask,
  validateGenesisConsent } from '../scripts/lib/app-task-continuation.mjs';
import { appHostTaskCwdDigest, hostSurfaceFactsDigest } from '../scripts/lib/host-surface.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import {
  rawHashValidHistory as rawHistory7b,
  rawHashValidState as rawState7b,
  seedCorrelatedTerminal as terminal7b,
} from './fixtures/verified-app-run.mjs';
import { durableRunBytes as bytes7d, rawHashValidState as raw7d,
  verifiedAppRun as fixture7d } from './fixtures/verified-app-run.mjs';

function observedRun({ legacyNullSurface = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-observe-')));
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z') });
  if (legacyNullSurface) {
    writeFileSync(join(root, '.deep-loop', 'runs', runId, 'event-log.jsonl'), '');
    rawState7b(root, runId, loop => {
      delete loop.initialization;
      delete loop.autonomy.app_task_continuation;
      loop.session_chain.sessions[0].host_surface = null;
      loop.event_log_head = { seq: 0, checksum: 'GENESIS' };
    });
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
  rawHistory7b(manual.root, manual.runId, [{ type: 'app-task-consent-revoked',
    now: Date.parse('2026-07-13T00:00:01.000Z'), data: {
    owner_run_id: manual.runId, generation: 1, attempt_id: null,
    child_run_id: null, failure_code: null,
  } }]);
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

test('revoke atomically clears an exact bare reservation left by lost emit response', () => {
  const { root, runId } = autoRun();
  const expect = { owner: runId, generation: 1 };
  const reserved = reserveHandoff(root, runId, { trigger: 'lost-app-emit-response',
    now: Date.parse('2026-07-13T00:00:01.000Z'), expect });
  assert.equal(reserved.reserved, true);
  assert.equal(readState(root, runId).data.session_chain.sessions
    .some(session => session.run_id === reserved.childRunId), false);
  assert.equal(revokeAppTaskContinuation(root, runId,
    { ...expect, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z') }).outcome, 'revoked');
  const verified = readVerifiedState(root, runId).data;
  assert.equal(verified.autonomy.app_task_continuation.mode, 'manual');
  assert.equal(verified.session_chain.lease.state, 'active');
  assert.equal(verified.session_chain.lease.handoff_phase, 'idle');
  assert.equal(verified.session_chain.lease.handoff_idempotency_key, null);
  assert.equal(verified.session_chain.lease.handoff_child_run_id, null);
  assert.equal(verified.session_chain.lease.expires_at, null);
  assert.equal(verified.session_chain.sessions
    .some(session => session.run_id === reserved.childRunId), false);
  assert.equal(readLines(root, runId).filter(event =>
    event.type === 'app-task-consent-revoked').length, 1);
  assert.deepEqual(acquireLease(root, runId, { owner: runId, expectGeneration: 1,
    runtime: 'codex' }), { ok: true, generation: 1, reason: 'already-owned' });
  assert.deepEqual(releaseLease(root, runId, expect), { ok: true, reason: 'released' });
});

test('revoke checks fence before terminal and abandons an in-flight attempt atomically', () => {
  const { root, runId } = autoRun();
  terminal7b(root, runId, { status: 'completed' });
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
  assert.equal(after.session_chain.lease.state, 'releasing');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(after.session_chain.lease.handoff_idempotency_key, 'a'.repeat(16));
  assert.equal(after.session_chain.lease.handoff_child_run_id, child);
  assert.equal(after.session_chain.lease.handoff_transport, 'codex-app');
  assert.equal(after.session_chain.lease.handoff_attempt_id, attempt);
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

test('observe revoke and status fence first then reject a corrupt success projection', () => {
  const fixture = fixture7d('dl-existing-app-proof-');
  raw7d(fixture.root, fixture.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:01.000Z';
  });
  const before = bytes7d(fixture.root, fixture.runId);
  const input = { owner: fixture.owner, generation: fixture.generation, runtime: 'codex',
    readerMode: 'pty-raw-noecho', observation: { kind: 'codex-app',
      source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: fixture.root,
      host_task_cwd_source: 'app-task-context' } };
  const deps = { kernelCwd: fixture.root, platform: process.platform,
    realpath: value => value, stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true,
    nowFn: () => Date.parse('2026-07-13T00:00:02.000Z') };
  assert.throws(() => observeHostSurface(fixture.root, fixture.runId,
    { ...input, owner: 'wrong' }, deps), /HOST_SURFACE_FENCED/);
  assert.throws(() => observeHostSurface(fixture.root, fixture.runId, input, deps),
    /RUN_SNAPSHOT_INVALID/);
  assert.throws(() => revokeAppTaskContinuation(fixture.root, fixture.runId,
    { owner: 'wrong', generation: 1, runtime: 'codex' }, deps), /APP_TASK_FENCED/);
  assert.throws(() => revokeAppTaskContinuation(fixture.root, fixture.runId,
    { owner: fixture.owner, generation: 1, runtime: 'codex' }, deps),
  /RUN_SNAPSHOT_INVALID/);
  assert.throws(() => statusAppTask(fixture.root, fixture.runId, {}),
    /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(bytes7d(fixture.root, fixture.runId), before);

  const terminal = fixture7d('dl-existing-app-terminal-proof-');
  raw7d(terminal.root, terminal.runId, loop => {
    loop.status = 'stopped';
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:01.000Z';
  });
  const terminalInput = { ...input, owner: terminal.owner,
    observation: { ...input.observation, host_task_cwd: terminal.root } };
  const terminalDeps = { ...deps, kernelCwd: terminal.root };
  const terminalBefore = bytes7d(terminal.root, terminal.runId);
  assert.throws(() => observeHostSurface(terminal.root, terminal.runId,
    { ...terminalInput, owner: 'wrong' }, terminalDeps), /HOST_SURFACE_FENCED/);
  assert.throws(() => observeHostSurface(terminal.root, terminal.runId,
    terminalInput, terminalDeps), /RUN_SNAPSHOT_INVALID/);
  assert.throws(() => revokeAppTaskContinuation(terminal.root, terminal.runId,
    { owner: 'wrong', generation: 1, runtime: 'codex' }, terminalDeps),
  /APP_TASK_FENCED/);
  assert.throws(() => revokeAppTaskContinuation(terminal.root, terminal.runId,
    { owner: terminal.owner, generation: 1, runtime: 'codex' }, terminalDeps),
  /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(bytes7d(terminal.root, terminal.runId), terminalBefore);
});

import { test as test8b } from 'node:test';
import assert8b from 'node:assert/strict';
import { existsSync as exists8b, mkdirSync as mkdir8b, mkdtempSync as temp8b,
  readdirSync as readDir8b, readFileSync as read8bFile, rmdirSync as rmdir8b,
  writeFileSync as write8bFile } from 'node:fs';
import { spawn as spawn8b } from 'node:child_process';
import { tmpdir as tmp8b } from 'node:os';
import { join as join8b } from 'node:path';
import { initRun as init8b } from '../scripts/lib/initrun.mjs';
import { emitHandoff as emit8b } from '../scripts/lib/handoff.mjs';
import { readLines as lines8b } from '../scripts/lib/integrity.mjs';
import { readState as read8b } from '../scripts/lib/state.mjs';
import { newWorkstream as newWorkstream8b,
  setWorkstreamStatus as setWorkstreamStatus8b } from '../scripts/lib/workspace.mjs';
import { prepareAppTask as prepare8b } from '../scripts/lib/app-task-continuation.mjs';
import { revokeAppTaskContinuation as revoke8b } from '../scripts/lib/app-task-continuation.mjs';

function handoffDescriptor8b({ runtime, root, parentRunId, childRunId }) {
  const display = 'manual continuation';
  return { runtime, projectRoot: root, runId: parentRunId, usageOutputKind: 'json',
    resumeInvocation: `$deep-loop:deep-loop-resume ${childRunId}`,
    entries: Object.fromEntries(['interactive', 'headless', 'cmux', 'iterm2', 'terminal-app',
      'wt', 'powershell', 'desktop'].map(name => [name, { display, unavailable: true }])) };
}

function emitted8b() {
  const root = temp8b(join8b(tmp8b(), 'dl-app-prepare-'));
  const { runId } = init8b(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z'),
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context',
      observed_at: '2026-07-13T00:00:00.000Z' },
    cwdFn: () => root, appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null } });
  const attemptId = '01JAPPTASK0000000000000000';
  const emitted = emit8b(root, runId, { trigger: 'milestone', appIntent: true,
    expect: { owner: runId, generation: 1 }, descriptorBuilder: handoffDescriptor8b,
    cwdFn: () => root, attemptIdFactory: () => attemptId,
    now: Date.parse('2026-07-13T00:00:01.000Z'),
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  return { root, runId, attemptId, childRunId: emitted.childRunId,
    hostInput: { currentHostTaskCwd: root,
      projects: [{ projectId: 'project $`\\', projectKind: 'local', path: root }] } };
}

test8b('prepare grants one action and only the exact request retries descriptor-free', () => {
  const fixture = emitted8b();
  const action = { tool: 'create_thread', target: { type: 'project', projectId: 'project $`\\',
    environment: { type: 'local' } }, prompt: 'bounded prompt' };
  const beforePreliminaryProbe = bytes7d(fixture.root, fixture.runId);
  let builderCalls = 0;
  const deps = { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
    cwdFn: () => fixture.root, descriptorBuilder: () => {
      if (builderCalls === 0) {
        assert8b.deepEqual(bytes7d(fixture.root, fixture.runId), beforePreliminaryProbe,
          'preliminary request recovery probe is write-free');
      }
      builderCalls += 1;
      return action;
    },
    reconcileBudgetFn: () => ({ turns: 0, tokens: 0 }), gateFn: () => ({ ok: true, blocked_by: [] }) };
  const input = { owner: fixture.runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: fixture.hostInput };
  const first = prepare8b(fixture.root, fixture.runId, input, deps);
  const retry = prepare8b(fixture.root, fixture.runId, input, {
    nowFn: () => assert8b.fail('retry does not sample'),
    cwdFn: () => fixture.root,
    descriptorBuilder: () => action,
    reconcileBudgetFn: () => assert8b.fail('retry does not reconcile'),
    gateFn: () => assert8b.fail('retry does not gate') });
  assert8b.deepEqual(first.action, action);
  assert8b.equal(first.do_not_call, false);
  assert8b.deepEqual(retry, { ok: true, outcome: 'already-prepared', do_not_call: true,
    attempt_id: fixture.attemptId });
  assert8b.equal(Object.hasOwn(retry, 'action'), false);
  assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
    { ...input, stdinMode: 'pipe-open-noecho' }, deps), /APP_STDIN_MODE_FENCED/);
  assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
    { ...input, hostInput: { ...input.hostInput,
      currentHostTaskCwd: `${fixture.root}/.` } }, deps), /APP_PREPARE_REQUEST_FENCED/);
  const preparedEvent = lines8b(fixture.root, fixture.runId)
    .find(event => event.type === 'app-task-prepared');
  assert8b.equal(preparedEvent.data.descriptor_digest,
    read8b(fixture.root, fixture.runId).data.session_chain.sessions
      .find(session => session.run_id === fixture.childRunId).continuation.descriptor_digest);
  assert8b.equal(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-prepared').length, 1);
  assert8b.equal(read8b(fixture.root, fixture.runId).data.session_chain.lease.handoff_phase, 'spawned');
});

test8b('prepare gate failure abandons without granting an action', () => {
  const fixture = emitted8b();
  const input = { owner: fixture.runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: fixture.hostInput };
  const result = prepare8b(fixture.root, fixture.runId, input, {
    nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
    cwdFn: () => fixture.root,
    descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
      projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' }),
    reconcileBudgetFn: () => ({ turns: 0, tokens: 0 }),
    gateFn: () => ({ ok: false, blocked_by: ['budget'] }),
  });
  assert8b.equal(result.do_not_call, true);
  assert8b.equal(Object.hasOwn(result, 'action'), false);
  const loop = read8b(fixture.root, fixture.runId).data;
  const child = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
  assert8b.equal(child.continuation.phase, 'abandoned');
  assert8b.equal(child.continuation.failure_code, 'gate-budget');
  assert8b.equal(loop.session_chain.lease.handoff_transport, null);
  assert8b.deepEqual(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-abandoned').at(-1).data,
  { attempt_id: fixture.attemptId, child_run_id: fixture.childRunId,
    failure_code: 'gate-budget', owner_run_id: fixture.runId, generation: 1 });
});

test8b('route drift with zero matching projects preserves the exact attempt for human recovery', () => {
  const fixture = emitted8b();
  const result = prepare8b(fixture.root, fixture.runId, {
    owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
    hostInput: { currentHostTaskCwd: fixture.root, projects: [] },
  }, { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
    cwdFn: () => fixture.root,
    descriptorBuilder: () => assert8b.fail('descriptor must not be built'),
    reconcileBudgetFn: () => ({ turns: 0, tokens: 0 }), gateFn: () => ({ ok: true, blocked_by: [] }) });
  assert8b.equal(result.outcome, 'manual-preserve');
  const loop = read8b(fixture.root, fixture.runId).data;
  assert8b.equal(loop.status, 'paused');
  assert8b.equal(loop.session_chain.lease.resume_policy, 'human');
  assert8b.equal(loop.session_chain.lease.handoff_attempt_id, fixture.attemptId);
  assert8b.equal(loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation.phase, 'emitted');
  assert8b.deepEqual(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-preserved').at(-1).data,
  { attempt_id: fixture.attemptId, child_run_id: fixture.childRunId,
    failure_code: 'app-launch-unconfirmed' });
  assert8b.equal(revoke8b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') }).outcome, 'revoked');
  const revoked = read8b(fixture.root, fixture.runId).data;
  assert8b.equal(revoked.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation.phase, 'abandoned');
  assert8b.equal(revoked.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation.failure_code, 'consent-revoked');
});

test8b('all five respawn gates fail closed with schema-safe codes', () => {
  for (const [blocked, code] of [
    ['budget', 'gate-budget'], ['breaker', 'gate-breaker'],
    ['max_sessions', 'gate-max-sessions'], ['wallclock', 'gate-wallclock'],
    ['auto_handoff', 'gate-auto-handoff'],
  ]) {
    const fixture = emitted8b();
    const result = prepare8b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
      stdinMode: 'pty-raw-noecho', hostInput: fixture.hostInput }, {
      nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'), cwdFn: () => fixture.root,
      descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
        projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' }),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: false, blocked_by: [blocked] }) });
    assert8b.equal(result.reason, code);
    assert8b.equal(Object.hasOwn(result, 'action'), false);
  }
});

test8b('project cardinality zero one and two is decisive', () => {
  for (const projects of [[], [
    { projectId: 'one', projectKind: 'local', path: null },
    { projectId: 'two', projectKind: 'local', path: null },
  ]]) {
    const fixture = emitted8b();
    const normalized = projects.map(project => ({ ...project, path: fixture.root }));
    const result = prepare8b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
      stdinMode: 'pty-raw-noecho',
      hostInput: { currentHostTaskCwd: fixture.root, projects: normalized } }, {
      nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'), cwdFn: () => fixture.root,
      descriptorBuilder: () => assert8b.fail('ambiguous route builds no descriptor'),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }) });
    assert8b.equal(result.outcome, 'manual-preserve');
  }
  const one = emitted8b();
  const result = prepare8b(one.root, one.runId, { owner: one.runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: one.hostInput }, {
    nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'), cwdFn: () => one.root,
    descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
      projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' }),
    reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }) });
  assert8b.equal(result.outcome, 'prepared');
});

test8b('prepare rejects every extra or exotic host projection without a durable write', () => {
  const variants = fixture => {
    const accessor = { ...fixture.hostInput };
    Object.defineProperty(accessor, 'currentHostTaskCwd', {
      enumerable: true, get: () => fixture.root,
    });
    const customProjects = [...fixture.hostInput.projects];
    customProjects.threadId = 'ARRAY-EXTRA';
    const hugeSparse = new Array(0xffffffff);
    return [
      { ...fixture.hostInput, threadId: 'ROOT-THREAD' },
      { ...fixture.hostInput, clientThreadId: 'ROOT-CLIENT' },
      { ...fixture.hostInput, observed_at: 'ROOT-CLOCK' },
      { ...fixture.hostInput, projects: [{ ...fixture.hostInput.projects[0],
        threadId: 'ROW-THREAD' }] },
      { ...fixture.hostInput, projects: [{ ...fixture.hostInput.projects[0],
        clientThreadId: 'ROW-CLIENT' }] },
      { ...fixture.hostInput, projects: customProjects },
      { ...fixture.hostInput, projects: hugeSparse },
      accessor,
    ];
  };
  for (let index = 0; index < 8; index += 1) {
    const fixture = emitted8b();
    const hostInput = variants(fixture)[index];
    const before = { state: structuredClone(read8b(fixture.root, fixture.runId).data),
      events: structuredClone(lines8b(fixture.root, fixture.runId)) };
    assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho', hostInput }, {
        cwdFn: () => fixture.root,
        nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
        descriptorBuilder: () => assert8b.fail('invalid host input builds no descriptor'),
        reconcileBudgetFn: () => assert8b.fail('invalid host input does not reconcile'),
        gateFn: () => ({ ok: true, blocked_by: [] }),
      }), /APP_HOST_INPUT_INVALID/);
    assert8b.deepEqual(read8b(fixture.root, fixture.runId).data, before.state, String(index));
    assert8b.deepEqual(lines8b(fixture.root, fixture.runId), before.events, String(index));
  }
});

test8b('prepare rejects a host accessor before intent hashing without invoking it', () => {
  const fixture = emitted8b();
  let reads = 0;
  const hostInput = { projects: fixture.hostInput.projects };
  Object.defineProperty(hostInput, 'currentHostTaskCwd', { enumerable: true,
    get() { reads += 1; return fixture.root; } });
  const before = { state: structuredClone(read8b(fixture.root, fixture.runId).data),
    events: structuredClone(lines8b(fixture.root, fixture.runId)) };
  assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho', hostInput }, {
      cwdFn: () => fixture.root,
      descriptorBuilder: () => assert8b.fail('invalid host input builds no descriptor'),
      reconcileBudgetFn: () => assert8b.fail('invalid host input does not reconcile'),
      gateFn: () => assert8b.fail('invalid host input does not gate'),
    }), /APP_HOST_INPUT_INVALID/);
  assert8b.equal(reads, 0);
  assert8b.deepEqual(read8b(fixture.root, fixture.runId).data, before.state);
  assert8b.deepEqual(lines8b(fixture.root, fixture.runId), before.events);
});

test8b('prepare rejects host projection proxies without invoking traps', () => {
  const trapped = target => {
    let calls = 0;
    const handler = Object.fromEntries(['get', 'getPrototypeOf', 'ownKeys',
      'getOwnPropertyDescriptor'].map(name => [name, (...args) => {
      calls += 1; return Reflect[name](...args);
    }]));
    return { value: new Proxy(target, handler), calls: () => calls };
  };
  for (const kind of ['root', 'projects', 'row']) {
    const fixture = emitted8b();
    const probe = trapped(kind === 'projects' ? [...fixture.hostInput.projects]
      : kind === 'row' ? { ...fixture.hostInput.projects[0] } : { ...fixture.hostInput });
    const hostInput = kind === 'root' ? probe.value
      : { ...fixture.hostInput, projects: kind === 'projects' ? probe.value : [probe.value] };
    const before = { state: structuredClone(read8b(fixture.root, fixture.runId).data),
      events: structuredClone(lines8b(fixture.root, fixture.runId)) };
    assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho', hostInput }, {
        cwdFn: () => fixture.root,
        descriptorBuilder: () => assert8b.fail('proxy host input builds no descriptor'),
        reconcileBudgetFn: () => assert8b.fail('proxy host input does not reconcile'),
        gateFn: () => assert8b.fail('proxy host input does not gate'),
      }), /APP_HOST_INPUT_INVALID/, kind);
    assert8b.equal(probe.calls(), 0, kind);
    assert8b.deepEqual(read8b(fixture.root, fixture.runId).data, before.state, kind);
    assert8b.deepEqual(lines8b(fixture.root, fixture.runId), before.events, kind);
  }
});

test8b('prepare rejects descriptor accessors proxies and cycles without invoking them', () => {
  let accessorReads = 0;
  let proxyTraps = 0;
  const accessor = { tool: 'create_thread', target: { type: 'project',
    projectId: 'project $`\\', environment: { type: 'local' } } };
  Object.defineProperty(accessor, 'prompt', { enumerable: true,
    get() { accessorReads += 1; return 'prompt'; } });
  const plain = { tool: 'create_thread', target: { type: 'project',
    projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' };
  const proxy = new Proxy(plain, { ownKeys(target) {
    proxyTraps += 1; return Reflect.ownKeys(target);
  } });
  const cycle = { tool: 'create_thread', target: { type: 'project',
    projectId: 'project $`\\', environment: { type: 'local' } }, prompt: null };
  cycle.prompt = cycle;
  for (const [label, action] of [['accessor', accessor], ['proxy', proxy], ['cycle', cycle]]) {
    const fixture = emitted8b();
    const before = { state: structuredClone(read8b(fixture.root, fixture.runId).data),
      events: structuredClone(lines8b(fixture.root, fixture.runId)) };
    assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
        hostInput: fixture.hostInput }, {
        cwdFn: () => fixture.root, descriptorBuilder: () => action,
        reconcileBudgetFn: () => assert8b.fail('invalid descriptor does not reconcile'),
        gateFn: () => assert8b.fail('invalid descriptor does not gate'),
      }), /APP_DESCRIPTOR_INVALID/, label);
    assert8b.deepEqual(read8b(fixture.root, fixture.runId).data, before.state, label);
    assert8b.deepEqual(lines8b(fixture.root, fixture.runId), before.events, label);
  }
  assert8b.equal(accessorReads, 0);
  assert8b.equal(proxyTraps, 0);
});

test8b('missing throwing or recursively extra descriptor is write free', () => {
  for (const builder of [undefined, () => { throw new Error('BUILDER_BOOM'); },
    () => ({ tool: 'create_thread', target: { type: 'project', projectId: 'project $`\\',
      environment: { type: 'local', model: 'forbidden' } }, prompt: 'prompt' })]) {
    const fixture = emitted8b();
    const before = { state: structuredClone(read8b(fixture.root, fixture.runId).data),
      events: structuredClone(lines8b(fixture.root, fixture.runId)) };
    assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
        hostInput: fixture.hostInput }, {
        nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'), cwdFn: () => fixture.root,
        ...(builder === undefined ? {} : { descriptorBuilder: builder }),
        reconcileBudgetFn: () => assert8b.fail('builder failure precedes reconcile'),
        gateFn: () => ({ ok: true, blocked_by: [] }) }),
    /APP_DESCRIPTOR_BUILDER_REQUIRED|BUILDER_BOOM|APP_DESCRIPTOR_INVALID/);
    assert8b.deepEqual(read8b(fixture.root, fixture.runId).data, before.state);
    assert8b.deepEqual(lines8b(fixture.root, fixture.runId), before.events);
  }
});

test8b('expired deadline and reconcile-time revoke grant no action', () => {
  const expired = emitted8b();
  assert8b.throws(() => prepare8b(expired.root, expired.runId,
    { owner: expired.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: expired.hostInput }, {
      nowFn: () => Date.parse('2026-07-13T00:05:01.001Z'), cwdFn: () => expired.root,
      descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
        projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' }),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }) }),
  /APP_PREPARE_DEADLINE_EXPIRED/);
  const revoked = emitted8b();
  assert8b.throws(() => prepare8b(revoked.root, revoked.runId,
    { owner: revoked.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: revoked.hostInput }, {
      nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'), cwdFn: () => revoked.root,
      descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
        projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' }),
      reconcileBudgetFn: () => revoke8b(revoked.root, revoked.runId,
        { owner: revoked.runId, generation: 1, runtime: 'codex' },
        { nowFn: () => Date.parse('2026-07-13T00:00:01.500Z') }),
      gateFn: () => ({ ok: true, blocked_by: [] }) }), /APP_CONSENT_FENCED|APP_ATTEMPT_FENCED/);
  assert8b.equal(lines8b(revoked.root, revoked.runId)
    .filter(event => event.type === 'app-task-prepared').length, 0);
});

test8b('wrong cwd and expired route or gate settlement are write free', () => {
  const snapshot = fixture => ({ state: structuredClone(read8b(fixture.root, fixture.runId).data),
    events: structuredClone(lines8b(fixture.root, fixture.runId)) });
  const assertUnchanged = (fixture, before) => {
    assert8b.deepEqual(read8b(fixture.root, fixture.runId).data, before.state);
    assert8b.deepEqual(lines8b(fixture.root, fixture.runId), before.events);
  };
  const action = () => ({ tool: 'create_thread', target: { type: 'project',
    projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' });

  const wrong = emitted8b();
  const wrongCwd = join8b(wrong.root, 'wrong-parent');
  mkdir8b(wrongCwd, { recursive: true });
  const beforeWrong = snapshot(wrong);
  assert8b.throws(() => prepare8b(wrong.root, wrong.runId,
    { owner: wrong.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: { ...wrong.hostInput, currentHostTaskCwd: wrongCwd } }, {
      cwdFn: () => wrongCwd, nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      descriptorBuilder: action, reconcileBudgetFn: () => {},
      gateFn: () => ({ ok: true, blocked_by: [] }),
    }), /APP_ROUTE_AUTHORITY_FENCED/);
  assertUnchanged(wrong, beforeWrong);

  for (const failure of ['route', 'gate']) {
    const fixture = emitted8b();
    const before = snapshot(fixture);
    assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
        hostInput: failure === 'route' ? { currentHostTaskCwd: fixture.root, projects: [] }
          : fixture.hostInput }, {
        cwdFn: () => fixture.root,
        nowFn: () => Date.parse('2026-07-13T00:05:01.001Z'),
        descriptorBuilder: action, reconcileBudgetFn: () => {},
        gateFn: () => failure === 'gate'
          ? ({ ok: false, blocked_by: ['budget'] }) : ({ ok: true, blocked_by: [] }),
      }), /APP_PREPARE_DEADLINE_EXPIRED/, failure);
    assertUnchanged(fixture, before);
  }
});

test8b('prepare identity fences precede clock and semantic proof at both read and CAS', () => {
  const corrupt = emitted8b();
  raw7d(corrupt.root, corrupt.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:09.000Z';
  });
  const corruptBefore = bytes7d(corrupt.root, corrupt.runId);
  const input = { owner: corrupt.runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: corrupt.hostInput };
  assert8b.throws(() => prepare8b(corrupt.root, corrupt.runId,
    { ...input, owner: 'wrong' }, {
      nowFn: () => assert8b.fail('wrong caller cannot sample prepare clock') }),
  /LEASE_FENCED/);
  assert8b.throws(() => prepare8b(corrupt.root, corrupt.runId, input, {}),
    /RUN_SNAPSHOT_INVALID/);
  assert8b.deepEqual(bytes7d(corrupt.root, corrupt.runId), corruptBefore);

  for (const winner of ['fence', 'proof']) {
    const fixture = emitted8b();
    let afterInjected = null;
    let clockCalls = 0;
    assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
        hostInput: fixture.hostInput }, {
        cwdFn: () => fixture.root,
        nowFn: () => { clockCalls += 1; return Date.parse('2026-07-13T00:00:02.000Z'); },
        descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
          projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' }),
        reconcileBudgetFn: () => {
          raw7d(fixture.root, fixture.runId, loop => {
            loop.session_chain.sessions[0].host_surface.observed_at =
              '2026-07-13T00:00:09.000Z';
            if (winner === 'fence') loop.session_chain.lease.owner_run_id = 'race-winner';
          });
          afterInjected = bytes7d(fixture.root, fixture.runId);
        },
        gateFn: () => ({ ok: true, blocked_by: [] }),
      }), winner === 'fence' ? /LEASE_FENCED/ : /RUN_SNAPSHOT_INVALID/);
    assert8b.deepEqual(bytes7d(fixture.root, fixture.runId), afterInjected);
    assert8b.equal(lines8b(fixture.root, fixture.runId)
      .filter(event => event.type === 'app-task-prepared').length, 0);
    assert8b.equal(clockCalls, winner === 'fence' ? 0 : 1);
  }
});

function prepareWorker8b(root, runId, { gateFile, readyFile,
  mode = 'valid', barrierReady = '-', barrierRelease = '-', crashAt = null,
  expectedExit = 0 }) {
  return new Promise((resolve, reject) => {
    const child = spawn8b(process.execPath,
      ['tests/fixtures/app-prepare-worker.mjs', root, runId, gateFile, readyFile,
        mode, barrierReady, barrierRelease],
      { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(crashAt === null ? {} : {
          NODE_ENV: 'test', DEEP_LOOP_TEST_CRASH_AT: crashAt,
        }) } });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== expectedExit) return reject(new Error(`worker ${code}: ${err}`));
      return resolve(code === 0 ? JSON.parse(out) : { status: code, stdout: out, stderr: err });
    });
  });
}

async function waitForFile8b(path) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (exists8b(path)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`barrier-timeout:${path}`);
}

function pendingJournalBytes8b(root, runId) {
  const directory = join8b(root, '.deep-loop', 'runs', runId);
  return Object.fromEntries(readDir8b(directory).filter(name => name.startsWith('.anchored-'))
    .sort().map(name => [name, read8bFile(join8b(directory, name))]));
}

test8b('pending prepare authenticates the complete action before recovery', async () => {
  const fixture = emitted8b();
  const gateFile = join8b(fixture.root, 'start-pending-prepare');
  const readyFile = join8b(fixture.root, 'pending-prepare-ready');
  write8bFile(gateFile, 'go');
  const crashed = await prepareWorker8b(fixture.root, fixture.runId, {
    gateFile, readyFile, crashAt: 'pending-after-rename', expectedExit: 91,
  });
  assert8b.equal(crashed.status, 91, crashed.stderr || crashed.stdout || 'wrong crash exit');
  rmdir8b(join8b(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));

  const input = { owner: fixture.runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: fixture.hostInput };
  const action = prompt => ({ tool: 'create_thread', target: { type: 'project',
    projectId: 'project $`\\', environment: { type: 'local' } }, prompt });
  const before = bytes7d(fixture.root, fixture.runId);
  const pendingBefore = pendingJournalBytes8b(fixture.root, fixture.runId);
  assert8b.throws(() => prepare8b(fixture.root, fixture.runId, input, {
    cwdFn: () => fixture.root, descriptorBuilder: () => action('changed prompt'),
    reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }),
  }), /APP_PREPARE_REQUEST_FENCED/);
  assert8b.deepEqual(bytes7d(fixture.root, fixture.runId), before,
    'divergent action must not publish the pending transaction');
  assert8b.deepEqual(pendingJournalBytes8b(fixture.root, fixture.runId), pendingBefore,
    'divergent action must not alter pending transaction bytes');
  const stillEmitted = read8b(fixture.root, fixture.runId).data.session_chain.sessions
    .find(session => session.run_id === fixture.childRunId).continuation;
  assert8b.equal(stillEmitted.phase, 'emitted');
  assert8b.equal(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-prepared').length, 0);

  const exact = prepare8b(fixture.root, fixture.runId, input, {
    cwdFn: () => fixture.root, descriptorBuilder: () => action('prompt'),
    nowFn: () => assert8b.fail('pending exact retry does not sample a new clock'),
    reconcileBudgetFn: () => assert8b.fail('pending exact retry does not reconcile'),
    gateFn: () => assert8b.fail('pending exact retry does not gate'),
  });
  assert8b.deepEqual(exact, { ok: true, outcome: 'already-prepared', do_not_call: true,
    attempt_id: fixture.attemptId });
  assert8b.equal(Object.hasOwn(exact, 'action'), false);
  assert8b.equal(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-prepared').length, 1);
});

const PREPARE_MARKER_CRASH_POINTS8B = Object.freeze([
  'pending-after-rename', 'event-after-partial-append', 'event-after-full-append',
  'state-after-rename', 'hash-after-rename', 'before-cleanup',
  'state-replace-after-create', 'state-replace-after-fsync',
  'state-replace-after-rename-before-dir-fsync',
  'hash-replace-after-create', 'hash-replace-after-fsync',
  'hash-replace-after-rename-before-dir-fsync',
  'cleanup-events-after-unlink', 'cleanup-state-after-unlink',
  'cleanup-hash-after-unlink',
]);

test8b('exact action retry converges from every pending prepare marker stage', async () => {
  for (const point of PREPARE_MARKER_CRASH_POINTS8B) {
    const fixture = emitted8b();
    const gateFile = join8b(fixture.root, `start-${point}`);
    const readyFile = join8b(fixture.root, `ready-${point}`);
    write8bFile(gateFile, 'go');
    const crashed = await prepareWorker8b(fixture.root, fixture.runId, {
      gateFile, readyFile, crashAt: point, expectedExit: 91,
    });
    assert8b.equal(crashed.status, 91,
      `${point}: ${crashed.stderr || crashed.stdout || 'wrong crash exit'}`);
    rmdir8b(join8b(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
    const exact = prepare8b(fixture.root, fixture.runId, {
      owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: fixture.hostInput,
    }, {
      cwdFn: () => fixture.root,
      descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
        projectId: 'project $`\\', environment: { type: 'local' } }, prompt: 'prompt' }),
      nowFn: () => assert8b.fail(`${point}: exact retry does not sample a new clock`),
      reconcileBudgetFn: () => assert8b.fail(`${point}: exact retry does not reconcile`),
      gateFn: () => assert8b.fail(`${point}: exact retry does not gate`),
    });
    assert8b.deepEqual(exact, { ok: true, outcome: 'already-prepared', do_not_call: true,
      attempt_id: fixture.attemptId }, point);
    assert8b.equal(Object.hasOwn(exact, 'action'), false, point);
    assert8b.equal(lines8b(fixture.root, fixture.runId)
      .filter(event => event.type === 'app-task-prepared').length, 1, point);
  }
});

test8b('request-only failure retries recover pending markers and committed receipts', async () => {
  for (const [mode, point, expected, projects] of [
    ['gate-blocked', 'pending-after-rename',
      { outcome: 'gate-blocked', reason: 'gate-budget' }, null],
    ['gate-blocked', 'response-after-cleanup',
      { outcome: 'gate-blocked', reason: 'gate-budget' }, null],
    ['route-preserve', 'pending-after-rename',
      { outcome: 'manual-preserve', reason: 'app-launch-unconfirmed' }, []],
    ['route-preserve', 'response-after-cleanup',
      { outcome: 'manual-preserve', reason: 'app-launch-unconfirmed' }, []],
  ]) {
    const fixture = emitted8b();
    const gateFile = join8b(fixture.root, `start-${mode}-${point}`);
    const readyFile = join8b(fixture.root, `ready-${mode}-${point}`);
    write8bFile(gateFile, 'go');
    const crashed = await prepareWorker8b(fixture.root, fixture.runId, {
      gateFile, readyFile, mode, crashAt: point, expectedExit: 91,
    });
    assert8b.equal(crashed.status, 91,
      `${mode}/${point}: ${crashed.stderr || crashed.stdout || 'wrong crash exit'}`);
    rmdir8b(join8b(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));

    const exact = prepare8b(fixture.root, fixture.runId, {
      owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: projects === null ? fixture.hostInput
        : { currentHostTaskCwd: fixture.root, projects },
    }, {
      cwdFn: () => fixture.root,
      descriptorBuilder: () => assert8b.fail(`${mode}/${point}: retry builds no action`),
      nowFn: () => assert8b.fail(`${mode}/${point}: retry samples no clock`),
      reconcileBudgetFn: () => assert8b.fail(`${mode}/${point}: retry does not reconcile`),
      gateFn: () => assert8b.fail(`${mode}/${point}: retry does not gate`),
    });
    assert8b.deepEqual(exact, { ok: false, outcome: expected.outcome, do_not_call: true,
      attempt_id: fixture.attemptId, reason: expected.reason }, `${mode}/${point}`);
    assert8b.equal(Object.hasOwn(exact, 'action'), false, `${mode}/${point}`);
    const expectedEvent = mode === 'gate-blocked'
      ? 'app-task-abandoned' : 'app-task-preserved';
    assert8b.equal(lines8b(fixture.root, fixture.runId)
      .filter(event => event.type === expectedEvent).length, 1, `${mode}/${point}`);
  }
});

test8b('prepare response loss converges without regranting complete action authority', async () => {
  const fixture = emitted8b();
  const gateFile = join8b(fixture.root, 'start-crash-prepare');
  const readyFile = join8b(fixture.root, 'crash-prepare-ready');
  write8bFile(gateFile, 'go');
  const crashed = await prepareWorker8b(fixture.root, fixture.runId, {
    gateFile, readyFile, crashAt: 'response-after-cleanup', expectedExit: 91,
  });
  assert8b.equal(crashed.status, 91, crashed.stderr || crashed.stdout || 'wrong crash exit');
  rmdir8b(join8b(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));

  const input = { owner: fixture.runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: fixture.hostInput };
  const action = prompt => ({ tool: 'create_thread', target: { type: 'project',
    projectId: 'project $`\\', environment: { type: 'local' } }, prompt });
  const retry = prepare8b(fixture.root, fixture.runId, input, {
    cwdFn: () => fixture.root, descriptorBuilder: () => action('prompt'),
    nowFn: () => assert8b.fail('committed retry does not sample a clock'),
    reconcileBudgetFn: () => assert8b.fail('committed retry does not reconcile'),
    gateFn: () => assert8b.fail('committed retry does not gate'),
  });
  assert8b.deepEqual(retry, { ok: true, outcome: 'already-prepared', do_not_call: true,
    attempt_id: fixture.attemptId });
  assert8b.equal(Object.hasOwn(retry, 'action'), false);
  const committed = bytes7d(fixture.root, fixture.runId);

  assert8b.throws(() => prepare8b(fixture.root, fixture.runId, input, {
    cwdFn: () => fixture.root, descriptorBuilder: () => action('changed prompt'),
  }), /APP_PREPARE_REQUEST_FENCED/);
  assert8b.deepEqual(bytes7d(fixture.root, fixture.runId), committed,
    'changed complete action must be write-free');
  assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
    { ...input, stdinMode: 'pipe-open-noecho' }, {
      cwdFn: () => fixture.root, descriptorBuilder: () => action('prompt'),
    }), /APP_STDIN_MODE_FENCED/);
  assert8b.deepEqual(bytes7d(fixture.root, fixture.runId), committed,
    'changed stdin mode must be write-free');
  assert8b.throws(() => prepare8b(fixture.root, fixture.runId,
    { ...input, hostInput: { ...input.hostInput,
      currentHostTaskCwd: `${fixture.root}/.` } }, {
      cwdFn: () => fixture.root, descriptorBuilder: () => action('prompt'),
    }), /APP_PREPARE_REQUEST_FENCED/);
  assert8b.deepEqual(bytes7d(fixture.root, fixture.runId), committed,
    'changed host input must be write-free');
  assert8b.equal(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-prepared').length, 1);
});

test8b('two processes contend and exactly one receives actionable authority', async () => {
  const fixture = emitted8b();
  const gateFile = join8b(fixture.root, 'start-prepare');
  const readyFiles = [join8b(fixture.root, 'prepare-ready-a'),
    join8b(fixture.root, 'prepare-ready-b')];
  const workers = readyFiles.map(readyFile => prepareWorker8b(fixture.root, fixture.runId,
    { gateFile, readyFile }));
  await Promise.all(readyFiles.map(waitForFile8b));
  write8bFile(gateFile, 'go');
  const results = await Promise.all(workers);
  assert8b.deepEqual(results.map(result => result.do_not_call).sort(), [false, true]);
  assert8b.equal(results.filter(result => Object.hasOwn(result, 'action')).length, 1);
  assert8b.equal(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-prepared').length, 1);
  const continuation = read8b(fixture.root, fixture.runId).data.session_chain.sessions
    .find(session => session.run_id === fixture.childRunId).continuation;
  assert8b.equal(continuation.confirmation_deadline, '2026-07-13T00:02:02.000Z');
});

test8b('prepare CAS cannot grant action after a concurrent manual preserve', async () => {
  const fixture = emitted8b();
  const gateFile = join8b(fixture.root, 'start-raced-prepare');
  const workerReady = join8b(fixture.root, 'raced-worker-ready');
  const barrierReady = join8b(fixture.root, 'raced-pre-cas-ready');
  const barrierRelease = join8b(fixture.root, 'raced-pre-cas-release');
  const worker = prepareWorker8b(fixture.root, fixture.runId, { gateFile,
    readyFile: workerReady, mode: 'barrier-valid', barrierReady, barrierRelease });
  await waitForFile8b(workerReady);
  write8bFile(gateFile, 'go');
  await waitForFile8b(barrierReady);

  const preserved = prepare8b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: { currentHostTaskCwd: fixture.root, projects: [] } }, {
      cwdFn: () => fixture.root,
      nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      descriptorBuilder: () => assert8b.fail('ambiguous route has no descriptor'),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }),
    });
  assert8b.equal(preserved.outcome, 'manual-preserve');
  write8bFile(barrierRelease, 'continue');
  const raced = await worker;
  assert8b.match(raced.worker_error, /RUN_PAUSED|APP_ATTEMPT_FENCED/);
  assert8b.equal(Object.hasOwn(raced, 'action'), false);
  assert8b.equal(lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-prepared').length, 0);
  const loop = read8b(fixture.root, fixture.runId).data;
  assert8b.equal(loop.status, 'paused');
  assert8b.equal(loop.session_chain.lease.resume_policy, 'human');
});

function forkEmitted8b() {
  const root = temp8b(join8b(tmp8b(), 'dl-app-fork-'));
  const worktree = join8b(root, '.worktrees', 'ws');
  mkdir8b(worktree, { recursive: true });
  const { runId } = init8b(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z'),
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['fork-thread-same-directory', 'send-message-to-thread',
        'structured-process-stdin'], structured_stdin_mode: 'pty-raw-noecho',
      host_task_cwd: worktree, host_task_cwd_source: 'app-task-context',
      observed_at: '2026-07-13T00:00:00.000Z' },
    cwdFn: () => worktree, appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null } });
  const fence = { owner: runId, generation: 1 };
  const { id: workstreamId } = newWorkstream8b(root, runId, {
    title: 'WS1', branch: 'codex/ws1', worktree: '.worktrees/ws',
    requestId: 'app-prepare-fork-ws1', fence,
  });
  setWorkstreamStatus8b(root, runId, workstreamId, 'in_progress', { fence });
  const attemptId = '01JAPPTASK0000000000000000';
  const emitted = emit8b(root, runId, { trigger: 'fork', appIntent: true,
    expect: { owner: runId, generation: 1 }, descriptorBuilder: handoffDescriptor8b,
    cwdFn: () => worktree, attemptIdFactory: () => attemptId,
    now: Date.parse('2026-07-13T00:00:01.000Z'),
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  return { root, runId, worktree, attemptId, childRunId: emitted.childRunId };
}

test8b('fork prepare consumes the one emit-verified durable workstream binding', () => {
  const fixture = forkEmitted8b();
  const result = prepare8b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: { currentHostTaskCwd: fixture.worktree } }, {
      cwdFn: () => fixture.worktree,
      nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      descriptorBuilder: () => ({ tool: 'fork_thread',
        environment: { type: 'same-directory' },
        followup: { tool: 'send_message_to_thread', prompt: 'prompt' } }),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }) });
  assert8b.equal(result.outcome, 'prepared');
  assert8b.equal(Object.hasOwn(result, 'action'), true);
});

import { test as test9a } from 'node:test';
import assert9a from 'node:assert/strict';
import { readFileSync as read9a, writeFileSync as write9a } from 'node:fs';
import { join as join9a } from 'node:path';
import { APP_FAILURE_CODES as failureCodes9a, APP_PUBLIC_FAILURE_CODES as publicCodes9a,
  confirmAppTask as confirm9a, failAppTask as fail9a,
  isAppPublicFailureCode as isPublic9a,
  prepareAppTask as prepare9a } from '../scripts/lib/app-task-continuation.mjs';
import { readState as state9a, runDir as runDir9a } from '../scripts/lib/state.mjs';
import { contentHash as hash9a } from '../scripts/lib/envelope.mjs';
import { recordCost as recordCost9a } from '../scripts/lib/budget.mjs';

function durable9a(root, runId) {
  const dir = runDir9a(root, runId);
  return ['loop.json', '.loop.hash', 'event-log.jsonl'].map(name => {
    try { return read9a(join9a(dir, name), 'utf8'); } catch { return null; }
  });
}

function prepared9a({ route = 'create' } = {}) {
  const fixture = route === 'fork' ? forkEmitted8b() : emitted8b();
  const projectId = 'project $`\\';
  prepare9a(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    stdinMode: 'pty-raw-noecho', hostInput: route === 'fork'
      ? { currentHostTaskCwd: fixture.worktree } : fixture.hostInput }, {
    nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
    cwdFn: () => route === 'fork' ? fixture.worktree : fixture.root,
    descriptorBuilder: ({ route: selected }) => selected.kind === 'create'
      ? { tool: 'create_thread', target: { type: 'project', projectId,
        environment: { type: 'local' } }, prompt: 'prompt' }
      : { tool: 'fork_thread', environment: { type: 'same-directory' },
        followup: { tool: 'send_message_to_thread', prompt: 'prompt' } },
    reconcileBudgetFn: () => ({ turns: 0, tokens: 0 }), gateFn: () => ({ ok: true, blocked_by: [] }),
  });
  return fixture;
}

test9a('first confirm is anchored and exact response-loss retry is write-free', () => {
  const fixture = prepared9a();
  const threadId = ' id $`\\ data ';
  const input = { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
    stdinMode: 'pty-raw-noecho', threadId };
  const first = confirm9a(fixture.root, fixture.runId, input,
    { cwdFn: () => fixture.root,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const snapshot = durable9a(fixture.root, fixture.runId);
  const retry = confirm9a(fixture.root, fixture.runId, input,
    { nowFn: () => Date.parse('2026-07-13T00:03:00.000Z') });
  assert9a.deepEqual(first, { ok: true, outcome: 'confirmed', attempt_id: fixture.attemptId });
  assert9a.deepEqual(retry, { ok: true, outcome: 'already-confirmed', attempt_id: fixture.attemptId });
  const confirmEvent = lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-confirmed').at(-1);
  assert9a.equal(confirmEvent.data.receipt_digest,
    hash9a('confirmed-thread\0' + threadId));
  assert9a.equal(JSON.stringify(confirmEvent).includes(threadId), false);
  assert9a.deepEqual(durable9a(fixture.root, fixture.runId), snapshot);
  assert9a.throws(() => confirm9a(fixture.root, fixture.runId,
    { ...input, stdinMode: 'pipe-open-noecho' },
    { nowFn: () => assert9a.fail('mode-fenced retry has no clock') }), /APP_STDIN_MODE_FENCED/);
  assert9a.deepEqual(durable9a(fixture.root, fixture.runId), snapshot);
  assert9a.throws(() => confirm9a(fixture.root, fixture.runId,
    { ...input, threadId: 'different' }, { nowFn: () => Date.now() }), /APP_RECEIPT_FENCED/);
  raw7d(fixture.root, fixture.runId, loop => {
    loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
      .continuation.thread_id = 'hash-valid-state-rewrite';
  });
  const rewritten = bytes7d(fixture.root, fixture.runId);
  assert9a.throws(() => confirm9a(fixture.root, fixture.runId, input),
    /RUN_SNAPSHOT_INVALID/);
  assert9a.deepEqual(bytes7d(fixture.root, fixture.runId), rewritten);
});

test9a('fork message failure preserves one known receipt without retry authority', () => {
  const fixture = prepared9a({ route: 'fork' });
  const result = fail9a(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, code: 'message-unconfirmed', stdinMode: 'pty-raw-noecho',
    unconfirmedThreadId: 'known $`\\ child' },
  { cwdFn: () => fixture.worktree,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  assert9a.deepEqual(result, { ok: true, outcome: 'failed', attempt_id: fixture.attemptId,
    failure_code: 'message-unconfirmed' });
  const loop = state9a(fixture.root, fixture.runId).data;
  const continuation = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId).continuation;
  assert9a.equal(continuation.phase, 'failed');
  assert9a.equal(continuation.failure_code, 'message-unconfirmed');
  assert9a.equal(loop.status, 'paused');
  assert9a.equal(loop.session_chain.lease.resume_policy, 'human');
  const failureEvent = lines8b(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-failed').at(-1);
  assert9a.deepEqual(Object.keys(failureEvent.data).sort(), [
    'attempt_id', 'child_run_id', 'failure_code', 'generation', 'owner_run_id',
    'unconfirmed_receipt_digest',
  ]);
  assert9a.equal(failureEvent.data.unconfirmed_receipt_digest,
    hash9a('unconfirmed-thread\0known $`\\ child'));
  assert9a.equal(JSON.stringify(failureEvent).includes('known $`\\ child'), false);
  const snapshot = durable9a(fixture.root, fixture.runId);
  assert9a.throws(() => fail9a(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId, code: 'message-unconfirmed',
    stdinMode: 'pipe-open-noecho', unconfirmedThreadId: 'known $`\\ child' }),
  /APP_STDIN_MODE_FENCED/);
  assert9a.deepEqual(durable9a(fixture.root, fixture.runId), snapshot);

  const directory = runDir9a(fixture.root, fixture.runId);
  const eventPath = join9a(directory, 'event-log.jsonl');
  const events = read9a(eventPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const forged = events.at(-1);
  forged.data.unconfirmed_thread_id = 'raw receipt must never enter the log';
  const previous = events.at(-2)?.checksum ?? 'GENESIS';
  forged.checksum = hash9a(`${forged.seq}|${forged.ts}|${forged.type}`
    + `|${JSON.stringify(forged.data)}|${previous}`);
  write9a(eventPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  raw7d(fixture.root, fixture.runId, loop => { loop.event_log_head = forged.checksum; });
  const leaked = bytes7d(fixture.root, fixture.runId);
  assert9a.throws(() => fail9a(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId, code: 'message-unconfirmed',
    stdinMode: 'pty-raw-noecho', unconfirmedThreadId: 'known $`\\ child' }),
  /RUN_SNAPSHOT_INVALID/);
  assert9a.deepEqual(bytes7d(fixture.root, fixture.runId), leaked);
});

test9a('ordinary host failures require no receipt channel and close the live binding', () => {
  for (const code of ['host-call-timeout', 'host-call-no-return', 'host-call-failed',
    'invalid-host-receipt']) {
    const fixture = prepared9a();
    const result = fail9a(fixture.root, fixture.runId, { owner: fixture.runId,
      generation: 1, attemptId: fixture.attemptId, code },
    { cwdFn: () => fixture.root });
    assert9a.equal(result.failure_code, code);
    const loop = state9a(fixture.root, fixture.runId).data;
    const child = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
    assert9a.equal(child.continuation.phase, 'failed');
    assert9a.equal(child.continuation.unconfirmed_thread_id, null);
    assert9a.equal(loop.session_chain.lease.handoff_transport, null);
    assert9a.equal(JSON.stringify(loop).includes('raw host error'), false);
  }
});

test9a('failed response-loss retry requires its exact immediate failure projection', () => {
  for (const kind of ['ordinary', 'message']) {
    const fixture = prepared9a({ route: kind === 'message' ? 'fork' : 'create' });
    const input = kind === 'message'
      ? { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
        code: 'message-unconfirmed', stdinMode: 'pty-raw-noecho',
        unconfirmedThreadId: 'known-child' }
      : { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
        code: 'host-call-failed' };
    fail9a(fixture.root, fixture.runId, input, {
      cwdFn: () => kind === 'message' ? fixture.worktree : fixture.root,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z'),
    });
    const loop = state9a(fixture.root, fixture.runId).data;
    const child = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
    assert9a.deepEqual(child.continuation.failure_binding,
      { owner_run_id: fixture.runId, generation: 1 });
    const failureEvent = lines8b(fixture.root, fixture.runId)
      .filter(event => ['app-task-failed', 'app-task-swept'].includes(event.type)).at(-1);
    assert9a.deepEqual({ owner_run_id: failureEvent.data.owner_run_id,
      generation: failureEvent.data.generation }, child.continuation.failure_binding);
    const snapshot = durable9a(fixture.root, fixture.runId);
    const retry = fail9a(fixture.root, fixture.runId, input, {
      cwdFn: () => assert9a.fail('failed retry has no cwd callback'),
      nowFn: () => assert9a.fail('failed retry has no clock'),
    });
    assert9a.equal(retry.outcome, 'already-failed');
    assert9a.deepEqual(durable9a(fixture.root, fixture.runId), snapshot);
  }
});

test9a('ordinary failed response-loss rejects another child and unaudited state revival', () => {
  const progressed = prepared9a();
  const input = { owner: progressed.runId, generation: 1,
    attemptId: progressed.attemptId, code: 'host-call-failed' };
  fail9a(progressed.root, progressed.runId, input, { cwdFn: () => progressed.root });
  raw7d(progressed.root, progressed.runId, loop => {
    const otherRunId = '01JAPPCHD00000000000000077';
    loop.session_chain.sessions.find(item => item.run_id === progressed.runId)
      .superseded_by = otherRunId;
    loop.session_chain.sessions.push({ run_id: otherRunId, started_at: null,
      ended_at: null, turns: 0, outcome: 'failed_launch', superseded_by: null,
      handoff_rel: 'handoffs/other.md' });
  });
  const progressedBytes = bytes7d(progressed.root, progressed.runId);
  assert9a.throws(() => fail9a(progressed.root, progressed.runId, input,
    { nowFn: () => assert9a.fail('progressed failure retry has no clock') }),
  /APP_RESPONSE_PROJECTION_CHANGED/);
  assert9a.deepEqual(bytes7d(progressed.root, progressed.runId), progressedBytes);

  for (const forged of ['running', 'released', 'owner-swap', 'terminal']) {
    const fixture = prepared9a();
    fail9a(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
      attemptId: fixture.attemptId, code: 'host-call-failed' },
    { cwdFn: () => fixture.root });
    raw7d(fixture.root, fixture.runId, loop => {
      if (forged === 'running') {
        loop.status = 'running'; loop.pause_reason = null;
      } else if (forged === 'owner-swap') {
        const otherRunId = '01JAPPHST00000000000000078';
        loop.session_chain.sessions.push({ run_id: otherRunId, started_at: null,
          ended_at: null, turns: 0, outcome: null, superseded_by: null,
          handoff_rel: 'handoffs/owner-swap.md' });
        loop.session_chain.lease.owner_run_id = otherRunId;
        loop.status = 'running'; loop.pause_reason = null;
      } else if (forged === 'terminal') {
        loop.status = 'completed'; loop.pause_reason = null;
        loop.termination = { ...(loop.termination ?? {}),
          finished_at: '2026-07-13T00:00:09.000Z', final_report: 'final.md' };
      } else {
        loop.pause_reason = 'recovered:awaiting-resume';
        loop.session_chain.lease.state = 'released';
      }
    });
    const before = bytes7d(fixture.root, fixture.runId);
    assert9a.throws(() => fail9a(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
        code: 'host-call-failed' }), /RUN_SNAPSHOT_INVALID/);
    if (['running', 'owner-swap', 'terminal'].includes(forged)) {
      assert9a.throws(() => reserveHandoff(fixture.root, fixture.runId,
        { trigger: 'forged-failure', expect: {
          owner: forged === 'owner-swap' ? '01JAPPHST00000000000000078' : fixture.runId,
          generation: 1,
        } }),
      /RUN_SNAPSHOT_INVALID/);
    } else {
      assert9a.throws(() => acquireLease(fixture.root, fixture.runId,
        { owner: fixture.runId, expectGeneration: 1, runtime: 'codex' }),
      /RUN_SNAPSHOT_INVALID/);
    }
    assert9a.deepEqual(bytes7d(fixture.root, fixture.runId), before);
  }
});

test9a('public fail rejects gate revoke and sweep-only provenance codes without writing', () => {
  for (const code of ['gate-budget', 'consent-revoked', 'app-prepare-unattended',
    'app-launch-unconfirmed']) {
    const fixture = prepared9a();
    const before = durable9a(fixture.root, fixture.runId);
    assert9a.throws(() => fail9a(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
        code, stdinMode: 'pty-raw-noecho', unconfirmedThreadId: null }),
    /APP_FAILURE_CODE_INVALID/);
    assert9a.deepEqual(durable9a(fixture.root, fixture.runId), before);
  }
});

test9a('failure-code exports are immutable views over private membership', () => {
  assert9a.throws(() => publicCodes9a.push('gate-budget'), TypeError);
  assert9a.throws(() => failureCodes9a.splice(0, 1), TypeError);
  assert9a.equal(isPublic9a('host-call-failed'), true);
  assert9a.equal(isPublic9a('gate-budget'), false);
});

test9a('confirm and fail recheck actual parent cwd and durable route under the mutation lock', () => {
  for (const operation of ['confirm', 'fail']) {
    const fixture = prepared9a();
    const wrongCwd = join8b(fixture.root, 'wrong-parent-cwd');
    mkdir8b(wrongCwd, { recursive: true });
    const before = durable9a(fixture.root, fixture.runId);
    const deps = { cwdFn: () => wrongCwd,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') };
    assert9a.throws(() => operation === 'confirm'
      ? confirm9a(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
        attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' }, deps)
      : fail9a(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
        attemptId: fixture.attemptId, code: 'host-call-failed' }, deps),
    /APP_ROUTE_UNCONFIRMED/);
    assert9a.deepEqual(durable9a(fixture.root, fixture.runId), before);
  }
});

test9a('confirm and fail prove the snapshot and fence mutation identity before clock or write', () => {
  for (const operation of ['confirm', 'fail']) {
    const wrong = prepared9a();
    const wrongInput = operation === 'confirm'
      ? { owner: 'wrong-parent', generation: 1, attemptId: wrong.attemptId,
        stdinMode: 'pty-raw-noecho', threadId: 'thread' }
      : { owner: 'wrong-parent', generation: 1, attemptId: wrong.attemptId,
        code: 'host-call-failed' };
    const wrongBefore = durable9a(wrong.root, wrong.runId);
    assert9a.throws(() => (operation === 'confirm' ? confirm9a : fail9a)(
      wrong.root, wrong.runId, wrongInput,
      { nowFn: () => assert9a.fail('identity-fenced mutation has no clock') }),
    /LEASE_FENCED/);
    assert9a.deepEqual(durable9a(wrong.root, wrong.runId), wrongBefore);

    const corrupt = prepared9a();
    raw7d(corrupt.root, corrupt.runId, loop => {
      loop.session_chain.sessions[0].host_surface.observed_at =
        '2026-07-13T00:00:09.000Z';
    });
    const corruptInput = operation === 'confirm'
      ? { owner: corrupt.runId, generation: 1, attemptId: corrupt.attemptId,
        stdinMode: 'pty-raw-noecho', threadId: 'thread' }
      : { owner: corrupt.runId, generation: 1, attemptId: corrupt.attemptId,
        code: 'host-call-failed' };
    const corruptBefore = bytes7d(corrupt.root, corrupt.runId);
    assert9a.throws(() => (operation === 'confirm' ? confirm9a : fail9a)(
      corrupt.root, corrupt.runId, corruptInput,
      { nowFn: () => assert9a.fail('corrupt mutation has no clock') }),
    /RUN_SNAPSHOT_INVALID/);
    assert9a.deepEqual(bytes7d(corrupt.root, corrupt.runId), corruptBefore);
  }
});

test9a('response-loss entry authenticates exact historical parent before semantic proof', () => {
  for (const operation of ['confirm', 'fail']) {
    const fixture = prepared9a();
    const input = operation === 'confirm'
      ? { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
        stdinMode: 'pty-raw-noecho', threadId: 'thread' }
      : { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
        code: 'host-call-failed' };
    (operation === 'confirm' ? confirm9a : fail9a)(fixture.root, fixture.runId, input, {
      cwdFn: () => fixture.root,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z'),
    });
    const completed = durable9a(fixture.root, fixture.runId);
    assert9a.throws(() => (operation === 'confirm' ? confirm9a : fail9a)(
      fixture.root, fixture.runId, { ...input, generation: 2 },
      { nowFn: () => assert9a.fail('wrong-generation replay has no clock') }),
    /LEASE_FENCED/);
    assert9a.deepEqual(durable9a(fixture.root, fixture.runId), completed);

    raw7d(fixture.root, fixture.runId, loop => {
      const parent = loop.session_chain.sessions.find(item => item.run_id === fixture.runId);
      const child = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
      child.host_surface = structuredClone(parent.host_surface);
    });
    const corrupt = bytes7d(fixture.root, fixture.runId);
    assert9a.throws(() => (operation === 'confirm' ? confirm9a : fail9a)(
      fixture.root, fixture.runId, { ...input, owner: fixture.childRunId },
      { nowFn: () => assert9a.fail('wrong historical owner has no clock') }),
    /LEASE_FENCED/);
    assert9a.deepEqual(bytes7d(fixture.root, fixture.runId), corrupt);
    assert9a.throws(() => (operation === 'confirm' ? confirm9a : fail9a)(
      fixture.root, fixture.runId, input,
      { nowFn: () => assert9a.fail('corrupt completed retry has no clock') }),
    /RUN_SNAPSHOT_INVALID/);
    assert9a.deepEqual(bytes7d(fixture.root, fixture.runId), corrupt);
  }
});

test9a('confirmed response-loss rejects a later accounting event without callbacks or writes', () => {
  const fixture = prepared9a();
  const input = { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
    stdinMode: 'pty-raw-noecho', threadId: 'confirmed-tail-thread' };
  confirm9a(fixture.root, fixture.runId, input, {
    cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z'),
  });
  recordCost9a(fixture.root, fixture.runId, { turns: 1, tokens: 0,
    requestId: 'task9a-confirm-tail', fence: { owner: fixture.runId, generation: 1,
      runtime: 'codex', intent: 'accounting' } });
  const afterCost = durable9a(fixture.root, fixture.runId);
  assert9a.throws(() => confirm9a(fixture.root, fixture.runId, input, {
    cwdFn: () => assert9a.fail('displaced confirm retry has no cwd callback'),
    nowFn: () => assert9a.fail('displaced confirm retry has no clock'),
  }), /APP_RESPONSE_PROJECTION_CHANGED/);
  assert9a.deepEqual(durable9a(fixture.root, fixture.runId), afterCost);
});

test9a('failed response-loss rejects a later accounting event without callbacks or writes', () => {
  const fixture = prepared9a();
  const input = { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
    code: 'host-call-failed' };
  fail9a(fixture.root, fixture.runId, input, { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  recordCost9a(fixture.root, fixture.runId, { turns: 1, tokens: 0,
    requestId: 'task9a-fail-tail', fence: { owner: fixture.runId, generation: 1,
      runtime: 'codex', intent: 'accounting' } });
  const afterCost = durable9a(fixture.root, fixture.runId);
  assert9a.throws(() => fail9a(fixture.root, fixture.runId, input, {
    cwdFn: () => assert9a.fail('displaced fail retry has no cwd callback'),
    nowFn: () => assert9a.fail('displaced fail retry has no clock'),
  }), /APP_RESPONSE_PROJECTION_CHANGED/);
  assert9a.deepEqual(durable9a(fixture.root, fixture.runId), afterCost);
});

test9a('acquired response-loss rejects extra lifecycle tail data without callbacks or writes', () => {
  const fixture = prepared9a();
  const input = { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
    stdinMode: 'pty-raw-noecho', threadId: 'acquired-tail-thread' };
  confirm9a(fixture.root, fixture.runId, input, { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const acquiredAt = '2026-07-13T00:00:04.000Z';
  const loop = state9a(fixture.root, fixture.runId).data;
  const parentSurface = loop.session_chain.sessions
    .find(item => item.run_id === fixture.runId).host_surface;
  const childSurface = { ...structuredClone(parentSurface),
    observed_generation: 2, observed_at: acquiredAt };
  const directory = runDir9a(fixture.root, fixture.runId);
  const eventPath = join9a(directory, 'event-log.jsonl');
  const events = read9a(eventPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
  const tail = events.at(-1);
  const acquired = { seq: tail.seq + 1, ts: acquiredAt, type: 'app-task-acquired', data: {
    attempt_id: fixture.attemptId, child_run_id: fixture.childRunId,
    observation_digest: hostSurfaceFactsDigest(childSurface),
    raw_receipt: 'must-not-be-accepted',
  } };
  acquired.checksum = hash9a(`${acquired.seq}|${acquired.ts}|${acquired.type}`
    + `|${JSON.stringify(acquired.data)}|${tail.checksum}`);
  write9a(eventPath, [...events, acquired].map(event => JSON.stringify(event)).join('\n') + '\n');
  raw7d(fixture.root, fixture.runId, current => {
    const parent = current.session_chain.sessions.find(item => item.run_id === fixture.runId);
    const child = current.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
    Object.assign(current.session_chain.lease, { owner_run_id: fixture.childRunId,
      generation: 2, acquired_at: acquiredAt, state: 'active', handoff_phase: 'acquired',
      handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
      handoff_idempotency_key: null, resume_policy: null, expires_at: null });
    Object.assign(child.continuation, { phase: 'acquired', acquired_at: acquiredAt,
      acquired_generation: 2 });
    child.host_surface = childSurface;
    child.started_at = acquiredAt;
    parent.outcome = 'took_over';
    current.status = 'running';
    current.pause_reason = null;
    current.updated_at = acquiredAt;
    current.event_log_head = { seq: acquired.seq, checksum: acquired.checksum };
  });
  const forged = durable9a(fixture.root, fixture.runId);
  assert9a.throws(() => confirm9a(fixture.root, fixture.runId, input, {
    cwdFn: () => assert9a.fail('extra acquired tail retry has no cwd callback'),
    nowFn: () => assert9a.fail('extra acquired tail retry has no clock'),
  }), /APP_RESPONSE_PROJECTION_CHANGED/);
  assert9a.deepEqual(durable9a(fixture.root, fixture.runId), forged);
});

import { test as test9b } from 'node:test';
import assert9b from 'node:assert/strict';
import { awaitAppTask as await9b, confirmAppTask as confirm9b,
  revokeAppTaskContinuation as revoke9b,
  statusAppTask as status9b, sweepUnconfirmedAppTask as sweep9b } from '../scripts/lib/app-task-continuation.mjs';
import { readState as state9b } from '../scripts/lib/state.mjs';
import { readFileSync as readSource9b } from 'node:fs';

function acquiredProjection9b(fixture, source = state9b(fixture.root, fixture.runId).data) {
  const acquired = structuredClone(source);
  const child = acquired.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
  const parent = acquired.session_chain.sessions.find(item => item.run_id === fixture.runId);
  child.continuation.phase = 'acquired';
  child.continuation.acquired_at = '2026-07-13T00:00:04.000Z';
  child.continuation.acquired_generation = 2;
  child.started_at = child.continuation.acquired_at;
  child.ended_at = null;
  child.outcome = null;
  child.superseded_by = null;
  child.host_surface = { ...structuredClone(parent.host_surface),
    observed_generation: 2, observed_at: child.continuation.acquired_at };
  parent.outcome = 'took_over';
  parent.superseded_by = child.run_id;
  Object.assign(acquired.session_chain.lease, { owner_run_id: fixture.childRunId, generation: 2,
    state: 'active', handoff_phase: 'acquired', acquired_at: child.continuation.acquired_at,
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null, resume_policy: null, expires_at: null });
  acquired.status = 'running';
  acquired.pause_reason = null;
  return acquired;
}

test9b('sweep handles only the two expired unconfirmed phases', () => {
  const emitted = emitted8b();
  const early = sweep9b(emitted.root, emitted.runId, { owner: emitted.runId, generation: 1,
    attemptId: emitted.attemptId }, { cwdFn: () => emitted.root,
      nowFn: () => Date.parse('2026-07-13T00:05:01.000Z') });
  assert9b.equal(early.outcome, 'not-expired');
  const swept = sweep9b(emitted.root, emitted.runId, { owner: emitted.runId, generation: 1,
    attemptId: emitted.attemptId }, { cwdFn: () => emitted.root,
      nowFn: () => Date.parse('2026-07-13T00:05:01.001Z') });
  assert9b.equal(swept.failure_code, 'app-prepare-unattended');
  const loop = state9b(emitted.root, emitted.runId).data;
  assert9b.equal(loop.status, 'paused');
  assert9b.equal(loop.session_chain.lease.resume_policy, 'human');
  assert9b.equal(loop.session_chain.lease.handoff_attempt_id, emitted.attemptId);
  const sweptChild = loop.session_chain.sessions.find(item => item.run_id === emitted.childRunId);
  assert9b.deepEqual(sweptChild.continuation.failure_binding,
    { owner_run_id: emitted.runId, generation: 1 });
  const sweepEvent = lines8b(emitted.root, emitted.runId)
    .filter(event => event.type === 'app-task-swept').at(-1);
  assert9b.deepEqual({ owner_run_id: sweepEvent.data.owner_run_id,
    generation: sweepEvent.data.generation }, sweptChild.continuation.failure_binding);
  const sweptSnapshot = { state: structuredClone(loop),
    events: structuredClone(lines8b(emitted.root, emitted.runId)) };
  const duplicate = sweep9b(emitted.root, emitted.runId, { owner: emitted.runId,
    generation: 1, attemptId: emitted.attemptId },
  { nowFn: () => assert9b.fail('already-swept retry has no clock') });
  assert9b.equal(duplicate.outcome, 'already-swept');
  assert9b.deepEqual(state9b(emitted.root, emitted.runId).data, sweptSnapshot.state);
  assert9b.deepEqual(lines8b(emitted.root, emitted.runId), sweptSnapshot.events);

  for (const field of ['started_at', 'ended_at', 'host_surface', 'superseded_by',
    'parent_outcome']) {
    const changed = emitted8b();
    sweep9b(changed.root, changed.runId, { owner: changed.runId, generation: 1,
      attemptId: changed.attemptId }, { cwdFn: () => changed.root,
      nowFn: () => Date.parse('2026-07-13T00:05:01.001Z') });
    raw7d(changed.root, changed.runId, loop => {
      const child = loop.session_chain.sessions.find(item => item.run_id === changed.childRunId);
      const parent = loop.session_chain.sessions.find(item => item.run_id === changed.runId);
      if (field === 'host_surface') child.host_surface = structuredClone(parent.host_surface);
      else if (field === 'superseded_by') child.superseded_by =
        '01JAPPCHD00000000000000088';
      else if (field === 'parent_outcome') parent.outcome = 'took_over';
      else child[field] = '2026-07-13T00:00:09.000Z';
    });
    const changedBytes = bytes7d(changed.root, changed.runId);
    assert9b.throws(() => sweep9b(changed.root, changed.runId,
      { owner: changed.runId, generation: 1, attemptId: changed.attemptId }),
    /APP_RESPONSE_PROJECTION_CHANGED|RUN_SNAPSHOT_INVALID|LEASE_FENCED/, field);
    assert9b.deepEqual(bytes7d(changed.root, changed.runId), changedBytes, field);
  }

  const prepared = prepared9a();
  const preparedSweep = sweep9b(prepared.root, prepared.runId, { owner: prepared.runId,
    generation: 1, attemptId: prepared.attemptId },
  { cwdFn: () => prepared.root,
    nowFn: () => Date.parse('2026-07-13T00:02:02.001Z') });
  assert9b.equal(preparedSweep.failure_code, 'app-launch-unconfirmed');
});

test9b('await timeout preserves a confirmed attempt and status is raw-ID-free', () => {
  const fixture = prepared9a();
  confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'secret-thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  let now = Date.parse('2026-07-13T00:00:03.000Z');
  const result = await9b(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId }, {
    pollNowFn: () => now, nowFn: () => now,
    sleepFn: ms => { now += ms; }, pollIntervalMs: 1_000,
    readStateFn: () => state9b(fixture.root, fixture.runId).data,
    cwdFn: () => fixture.root,
  });
  assert9b.equal(result.outcome, 'timeout-preserved');
  const afterTimeout = { state: structuredClone(state9b(fixture.root, fixture.runId).data),
    events: structuredClone(lines8b(fixture.root, fixture.runId)) };
  assert9b.throws(() => confirm9b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
      stdinMode: 'pty-raw-noecho', threadId: 'secret-thread' },
    { nowFn: () => assert9b.fail('timeout-progressed confirm retry has no clock') }),
  /APP_RESPONSE_PROJECTION_CHANGED/);
  assert9b.deepEqual(state9b(fixture.root, fixture.runId).data, afterTimeout.state);
  assert9b.deepEqual(lines8b(fixture.root, fixture.runId), afterTimeout.events);
  const retry = await9b(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId }, {
    pollNowFn: () => assert9b.fail('preserved retry does not poll'),
    nowFn: () => assert9b.fail('preserved retry does not mutate') });
  assert9b.equal(retry.outcome, 'already-timeout-preserved');
  assert9b.deepEqual(state9b(fixture.root, fixture.runId).data, afterTimeout.state);
  assert9b.deepEqual(lines8b(fixture.root, fixture.runId), afterTimeout.events);
  const loop = state9b(fixture.root, fixture.runId).data;
  assert9b.equal(loop.pause_reason, 'app-child-timeout-awaiting');
  assert9b.equal(loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation.phase, 'confirmed');
  const projected = status9b(fixture.root, fixture.runId, { attemptId: fixture.attemptId });
  const safe = JSON.stringify(projected);
  assert9b.equal(safe.includes('secret-thread'), false);
  assert9b.equal(projected.logical_run_id, fixture.runId);
  assert9b.equal(projected.resume_policy, 'human');
  assert9b.deepEqual(projected.current, { run_id: fixture.childRunId,
    attempt_id: fixture.attemptId, route: 'create', phase: 'confirmed',
    failure_code: null, handoff_rel: projected.current.handoff_rel });
  assert9b.equal(projected.history.length, 1);
  assert9b.equal(status9b(fixture.root, fixture.runId,
    { attemptId: '01JAPPZZZZ0000000000000000' }).has_app_history, true);
  assert9b.equal(status9b(fixture.root, fixture.runId,
    { attemptId: '01JAPPZZZZ0000000000000000' }).current, null);
  const late = await9b(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId }, {
    readStateFn: () => acquiredProjection9b(fixture, loop),
    pollNowFn: () => assert9b.fail('late acquired projection does not poll'),
    nowFn: () => assert9b.fail('late acquired projection does not mutate'),
  });
  assert9b.equal(late.outcome, 'acquired');
  assert9b.equal(revoke9b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:01:00.000Z') }).outcome, 'revoked');
  const revoked = state9b(fixture.root, fixture.runId).data;
  assert9b.equal(revoked.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation.phase, 'abandoned');
  assert9b.equal(revoked.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation.failure_code, 'consent-revoked');
});

test9b('status exposes one exact shape for app, human, and null resume policies', () => {
  const expectedKeys = ['current', 'generation', 'generic_current', 'handoff_phase',
    'has_app_history', 'history', 'logical_run_id', 'manual_recovery', 'ok', 'owner_run_id',
    'recovery_pending', 'resume_policy'];
  const initial = autoRun();
  const projections = [status9b(initial.root, initial.runId, {})];
  const active = emitted8b();
  projections.push(status9b(active.root, active.runId, { attemptId: active.attemptId }));
  assert9b.equal(revoke9b(active.root, active.runId,
    { owner: active.runId, generation: 1, runtime: 'codex' },
    { nowFn: () => Date.parse('2026-07-13T00:00:02.000Z') }).outcome, 'revoked');
  projections.push(status9b(active.root, active.runId, { attemptId: active.attemptId }));
  assert9b.deepEqual(projections.map(projected => projected.resume_policy),
    [null, 'app', 'human']);
  for (const projected of projections) {
    assert9b.deepEqual(Object.keys(projected).sort(), expectedKeys);
  }
});

test9b('status rejects unsafe App-history handoff paths', () => {
  for (const invalid of ['/tmp/outside.md', 'handoffs/../outside.md']) {
    const fixture = prepared9a();
    const loop = state9b(fixture.root, fixture.runId).data;
    const child = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
    child.handoff_rel = invalid;
    writeState(fixture.root, fixture.runId, loop);
    const projected = status9b(fixture.root, fixture.runId, { attemptId: fixture.attemptId });
    assert9b.equal(projected.current.handoff_rel, null);
    assert9b.equal(projected.history.at(-1).handoff_rel, null);
    assert9b.equal(JSON.stringify(projected).includes(invalid), false);
  }
});

test9b('status CLI forwards the exact attempt under the final API name', () => {
  const source = readSource9b(new URL('../scripts/deep-loop.mjs', import.meta.url), 'utf8');
  assert9b.match(source,
    /statusAppTask\(root, runId, \{ attemptId: f\.attempt \?\? null \}\)/);
  assert9b.doesNotMatch(source,
    /statusAppTask\(root, runId, \{ attempt: f\.attempt \?\? null \}\)/);
});

test9b('acquire-before-await exact projection succeeds before stale parent fence', () => {
  const fixture = prepared9a();
  confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const acquired = acquiredProjection9b(fixture);
  const result = await9b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId }, {
      readStateFn: () => acquired,
      pollNowFn: () => assert9b.fail('already acquired does not poll'),
      nowFn: () => assert9b.fail('already acquired does not mutate') });
  assert9b.deepEqual(result, { ok: true, outcome: 'acquired', attempt_id: fixture.attemptId });
});

test9b('foreign owner or generation is fenced without timeout mutation', () => {
  const fixture = prepared9a();
  confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const foreign = structuredClone(state9b(fixture.root, fixture.runId).data);
  Object.assign(foreign.session_chain.lease, {
    owner_run_id: '01JAPPF0R00000000000000000', generation: 2 });
  const before = structuredClone(lines8b(fixture.root, fixture.runId));
  assert9b.throws(() => await9b(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId }, {
    readStateFn: () => foreign, pollNowFn: () => Date.parse('2026-07-13T00:00:03.000Z'),
    nowFn: () => assert9b.fail('foreign fence has no mutation clock'),
  }), /LEASE_FENCED/);
  assert9b.deepEqual(lines8b(fixture.root, fixture.runId), before);
});

test9b('acquired readiness binds the exact immediate parent after two handoffs', () => {
  const fixture = prepared9a();
  confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const twice = acquiredProjection9b(fixture);
  const rootParent = twice.session_chain.sessions.find(item => item.run_id === fixture.runId);
  const firstChild = twice.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
  const secondChild = structuredClone(firstChild);
  secondChild.run_id = '01JAPPCHD00000000000000029';
  secondChild.continuation.attempt_id = '01JAPPTASK0000000000000029';
  secondChild.continuation.acquired_at = '2026-07-13T00:00:05.000Z';
  secondChild.continuation.acquired_generation = 3;
  secondChild.started_at = secondChild.continuation.acquired_at;
  secondChild.host_surface.observed_generation = 3;
  secondChild.host_surface.observed_at = secondChild.continuation.acquired_at;
  secondChild.outcome = null;
  secondChild.superseded_by = null;
  firstChild.outcome = 'took_over';
  firstChild.superseded_by = secondChild.run_id;
  rootParent.outcome = 'took_over';
  rootParent.superseded_by = firstChild.run_id;
  twice.session_chain.sessions.push(secondChild);
  Object.assign(twice.session_chain.lease, { owner_run_id: secondChild.run_id, generation: 3,
    acquired_at: secondChild.continuation.acquired_at });
  const readStateFn = () => twice;
  assert9b.throws(() => await9b(fixture.root, fixture.runId, {
    owner: rootParent.run_id, generation: 2, attemptId: secondChild.continuation.attempt_id,
  }, { readStateFn, pollNowFn: () => assert9b.fail('wrong parent does not poll'),
    nowFn: () => assert9b.fail('wrong parent does not mutate') }), /LEASE_FENCED/);
  assert9b.equal(await9b(fixture.root, fixture.runId, {
    owner: firstChild.run_id, generation: 2, attemptId: secondChild.continuation.attempt_id,
  }, { readStateFn, pollNowFn: () => assert9b.fail('acquired exact parent does not poll'),
    nowFn: () => assert9b.fail('acquired exact parent does not mutate') }).outcome, 'acquired');
});

test9b('foreign lease outranks same-attempt failed or abandoned readiness', () => {
  const fixture = prepared9a();
  confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const failed = structuredClone(state9b(fixture.root, fixture.runId).data);
  const continuation = failed.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation;
  continuation.phase = 'failed';
  continuation.failure_code = 'host-call-failed';
  continuation.failure_binding = { owner_run_id: fixture.runId, generation: 1 };
  const sameGeneration = await9b(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId }, {
      readStateFn: () => failed,
      pollNowFn: () => assert9b.fail('same-generation terminal readiness does not poll'),
      nowFn: () => assert9b.fail('same-generation terminal readiness does not mutate'),
    });
  assert9b.equal(sameGeneration.outcome, 'failed');
  Object.assign(failed.session_chain.lease, {
    owner_run_id: '01JAPPF0R00000000000000000', generation: 2 });
  assert9b.throws(() => await9b(fixture.root, fixture.runId, { owner: fixture.runId,
    generation: 1, attemptId: fixture.attemptId }, {
      readStateFn: () => failed,
      pollNowFn: () => assert9b.fail('foreign terminal readiness does not poll'),
      nowFn: () => assert9b.fail('foreign terminal readiness does not mutate'),
    }), /LEASE_FENCED/);
});

test9b('sweep and await recheck actual parent cwd and durable route before mutation', () => {
  const emitted = emitted8b();
  const wrongCwd = join8b(emitted.root, 'wrong-sweep-cwd');
  mkdir8b(wrongCwd, { recursive: true });
  const beforeSweep = durable9a(emitted.root, emitted.runId);
  assert9b.throws(() => sweep9b(emitted.root, emitted.runId, { owner: emitted.runId,
    generation: 1, attemptId: emitted.attemptId }, {
      cwdFn: () => wrongCwd,
      nowFn: () => Date.parse('2026-07-13T00:05:01.001Z'),
    }), /APP_ROUTE_UNCONFIRMED/);
  assert9b.deepEqual(durable9a(emitted.root, emitted.runId), beforeSweep);

  const confirmed = prepared9a();
  confirm9b(confirmed.root, confirmed.runId, { owner: confirmed.runId, generation: 1,
    attemptId: confirmed.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => confirmed.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const other = join8b(confirmed.root, 'wrong-await-cwd');
  mkdir8b(other, { recursive: true });
  const beforeAwait = durable9a(confirmed.root, confirmed.runId);
  assert9b.throws(() => await9b(confirmed.root, confirmed.runId, { owner: confirmed.runId,
    generation: 1, attemptId: confirmed.attemptId }, {
      cwdFn: () => other,
      pollNowFn: () => Date.parse('2026-07-13T00:00:03.000Z'),
      nowFn: () => assert9b.fail('wrong-cwd await has no mutation clock'),
    }), /APP_ROUTE_UNCONFIRMED/);
  assert9b.deepEqual(durable9a(confirmed.root, confirmed.runId), beforeAwait);
});

test9b('sweep fences before proof and proves before returning not-expired', () => {
  const corrupt = emitted8b();
  raw7d(corrupt.root, corrupt.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:09.000Z';
  });
  const before = bytes7d(corrupt.root, corrupt.runId);
  assert9b.throws(() => sweep9b(corrupt.root, corrupt.runId,
    { owner: 'wrong-parent', generation: 1, attemptId: corrupt.attemptId },
    { nowFn: () => assert9b.fail('identity fence precedes the sweep clock') }),
  /LEASE_FENCED/);
  assert9b.throws(() => sweep9b(corrupt.root, corrupt.runId,
    { owner: corrupt.runId, generation: 1, attemptId: corrupt.attemptId },
    { nowFn: () => assert9b.fail('proof precedes not-expired clock/result') }),
  /RUN_SNAPSHOT_INVALID/);
  assert9b.deepEqual(bytes7d(corrupt.root, corrupt.runId), before);
});

test9b('await fences every initial and poll read before semantic proof', () => {
  const initial = prepared9a();
  confirm9b(initial.root, initial.runId, { owner: initial.runId, generation: 1,
    attemptId: initial.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => initial.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  raw7d(initial.root, initial.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:09.000Z';
  });
  const initialBytes = bytes7d(initial.root, initial.runId);
  assert9b.throws(() => await9b(initial.root, initial.runId,
    { owner: 'wrong-parent', generation: 1, attemptId: initial.attemptId }, {
      pollNowFn: () => assert9b.fail('wrong await caller cannot poll'),
      nowFn: () => assert9b.fail('wrong await caller has no mutation clock'),
    }), /LEASE_FENCED/);
  assert9b.throws(() => await9b(initial.root, initial.runId,
    { owner: initial.runId, generation: 1, attemptId: initial.attemptId }, {
      pollNowFn: () => assert9b.fail('corrupt initial read cannot poll'),
      nowFn: () => assert9b.fail('corrupt initial read has no mutation clock'),
    }), /RUN_SNAPSHOT_INVALID/);
  assert9b.deepEqual(bytes7d(initial.root, initial.runId), initialBytes);

  const polled = prepared9a();
  confirm9b(polled.root, polled.runId, { owner: polled.runId, generation: 1,
    attemptId: polled.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => polled.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const base = Date.parse('2026-07-13T00:00:03.000Z');
  let clockReads = 0;
  assert9b.throws(() => await9b(polled.root, polled.runId,
    { owner: polled.runId, generation: 1, attemptId: polled.attemptId }, {
      pollNowFn: () => {
        clockReads += 1;
        if (clockReads === 2) raw7d(polled.root, polled.runId, loop => {
          loop.session_chain.sessions[0].host_surface.observed_at =
            '2026-07-13T00:00:09.000Z';
        });
        return base;
      }, nowFn: () => assert9b.fail('corrupt poll read has no mutation clock'),
      cwdFn: () => polled.root,
      sleepFn: () => assert9b.fail('corrupt poll read cannot sleep'),
    }), /RUN_SNAPSHOT_INVALID/);
});

test9b('await does not reread or converge an unrelated mutation failure', () => {
  const fixture = prepared9a();
  confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const base = Date.parse('2026-07-13T00:00:03.000Z');
  const timeout = (state9b(fixture.root, fixture.runId).data.autonomy.child_ready_timeout_sec ?? 75)
    * 1_000;
  const poll = [base, base + timeout + 1];
  let reads = 0;
  const before = durable9a(fixture.root, fixture.runId);
  assert9b.throws(() => await9b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId }, {
      readStateFn: () => { reads += 1; return state9b(fixture.root, fixture.runId).data; },
      pollNowFn: () => poll.shift(), nowFn: () => base,
      cwdFn: () => fixture.root,
    }), /APP_AWAIT_NOT_EXPIRED/);
  assert9b.equal(reads, 1, 'non-convergence errors never trigger a catch-path reread');
  assert9b.deepEqual(durable9a(fixture.root, fixture.runId), before);
});

test9b('acquired readiness rejects host-surface and unique-parent drift', () => {
  for (const drift of ['host-surface', 'unique-parent']) {
    const fixture = prepared9a();
    confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
      attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
    { cwdFn: () => fixture.root,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
    const acquired = acquiredProjection9b(fixture);
    const child = acquired.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
    if (drift === 'host-surface') {
      child.host_surface.observed_generation = 9;
    } else {
      const duplicate = structuredClone(acquired.session_chain.sessions
        .find(item => item.run_id === fixture.runId));
      duplicate.run_id = '01JAPPPRNT0000000000000002';
      duplicate.outcome = null;
      acquired.session_chain.sessions.push(duplicate);
    }
    assert9b.throws(() => await9b(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId }, {
        readStateFn: () => acquired,
        pollNowFn: () => assert9b.fail('drifted acquired projection does not poll'),
        nowFn: () => assert9b.fail('drifted acquired projection does not mutate'),
      }), /LEASE_FENCED/, drift);
  }
});

function assertInvalidAwaitTiming9b(scenario) {
  const fixture = prepared9a();
  confirm9b(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  const injected = structuredClone(state9b(fixture.root, fixture.runId).data);
  if (Object.hasOwn(scenario, 'timeout')) {
    injected.autonomy.child_ready_timeout_sec = scenario.timeout;
  }
  const before = durable9a(fixture.root, fixture.runId);
  assert9b.throws(() => await9b(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId }, {
      readStateFn: () => injected, pollNowFn: scenario.poll,
      pollIntervalMs: scenario.interval, cwdFn: () => fixture.root,
      nowFn: () => assert9b.fail('invalid await timing has no mutation clock'),
      sleepFn: () => assert9b.fail('invalid await timing does not sleep'),
    }), /APP_AWAIT_(?:CLOCK|INTERVAL|TIMEOUT)_INVALID/, scenario.name);
  assert9b.deepEqual(durable9a(fixture.root, fixture.runId), before, scenario.name);
}

test9b('await rejects every invalid poll clock sample without writing', () => {
  assertInvalidAwaitTiming9b({ name: 'initial NaN clock',
    poll: () => Number.NaN, interval: 1_000 });
  const samples = [Date.parse('2026-07-13T00:00:03.000Z'), Number.POSITIVE_INFINITY];
  assertInvalidAwaitTiming9b({ name: 'later infinite clock',
    poll: () => samples.shift(), interval: 1_000 });
});

test9b('await rejects non-positive and non-finite poll intervals without writing', () => {
  for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertInvalidAwaitTiming9b({ name: `interval ${String(interval)}`, interval,
      poll: () => assert9b.fail('invalid interval does not sample the poll clock') });
  }
});

test9b('await rejects non-positive and non-finite derived timeouts without writing', () => {
  for (const timeout of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertInvalidAwaitTiming9b({ name: `timeout ${String(timeout)}`, timeout, interval: 1_000,
      poll: () => assert9b.fail('invalid timeout does not sample the poll clock') });
  }
});

test9b('swept response-loss rejects a later accounting event without callbacks or writes', () => {
  const fixture = emitted8b();
  const input = { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId };
  sweep9b(fixture.root, fixture.runId, input, { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:05:01.001Z') });
  recordCost9a(fixture.root, fixture.runId, { turns: 1, tokens: 0,
    requestId: 'task9b-sweep-tail', fence: { owner: fixture.runId, generation: 1,
      runtime: 'codex', intent: 'accounting' } });
  const afterCost = durable9a(fixture.root, fixture.runId);
  assert9b.throws(() => sweep9b(fixture.root, fixture.runId, input, {
    cwdFn: () => assert9b.fail('displaced sweep retry has no cwd callback'),
    nowFn: () => assert9b.fail('displaced sweep retry has no clock'),
  }), /APP_RESPONSE_PROJECTION_CHANGED/);
  assert9b.deepEqual(durable9a(fixture.root, fixture.runId), afterCost);
});

import { test as test10a } from 'node:test';
import assert10a from 'node:assert/strict';
import { acquireAppTask as acquire10a, awaitAppTask as await10a,
  confirmAppTask as confirm10a } from '../scripts/lib/app-task-continuation.mjs';
import { readLines as lines10a } from '../scripts/lib/integrity.mjs';
import { readState as state10a } from '../scripts/lib/state.mjs';
import { durableRunBytes as bytes10a, rawHashValidState as raw10a }
  from './fixtures/verified-app-run.mjs';

function confirmed10a() {
  const fixture = prepared9a();
  confirm10a(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  return fixture;
}

const observation10a = root => ({
  kind: 'codex-app', source: 'codex-app-tool-provenance',
  capabilities: ['structured-process-stdin'], structured_stdin_mode: 'pty-raw-noecho',
  host_task_cwd: root, host_task_cwd_source: 'app-task-context',
});

test10a('App acquire succeeds only from confirmed and exact response-loss retry is inert', () => {
  const fixture = confirmed10a();
  const input = { attemptId: fixture.attemptId, owner: fixture.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho', observation: observation10a(fixture.root) };
  const first = acquire10a(fixture.root, fixture.runId, input, { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
  const before = { state: structuredClone(state10a(fixture.root, fixture.runId).data),
    events: structuredClone(lines10a(fixture.root, fixture.runId)) };
  const retry = acquire10a(fixture.root, fixture.runId,
    { ...input, observation: observation10a(fixture.root) },
    { cwdFn: () => fixture.root, nowFn: () => assert10a.fail('retry has no clock') });
  assert10a.deepEqual(first, { ok: true, outcome: 'acquired', generation: 2 });
  assert10a.deepEqual(retry, { ok: true, outcome: 'already-acquired', generation: 2 });
  const confirmInput = { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
    stdinMode: 'pty-raw-noecho', threadId: 'thread' };
  const confirmBytes = durable9a(fixture.root, fixture.runId);
  assert10a.deepEqual(confirm10a(fixture.root, fixture.runId, confirmInput,
    { nowFn: () => assert10a.fail('confirm response-loss retry has no clock') }),
  { ok: true, outcome: 'already-complete', attempt_id: fixture.attemptId });
  assert10a.throws(() => confirm10a(fixture.root, fixture.runId,
    { ...confirmInput, owner: fixture.childRunId, generation: 2 },
    { nowFn: () => assert10a.fail('current child is fenced before proof') }), /LEASE_FENCED/);
  assert10a.deepEqual(durable9a(fixture.root, fixture.runId), confirmBytes);
  assert10a.deepEqual(state10a(fixture.root, fixture.runId).data, before.state);
  assert10a.deepEqual(lines10a(fixture.root, fixture.runId), before.events);
  const loop = before.state;
  assert10a.equal(loop.session_chain.lease.owner_run_id, fixture.childRunId);
  for (const key of ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
    'handoff_idempotency_key', 'resume_policy', 'expires_at']) {
    assert10a.equal(loop.session_chain.lease[key], null);
  }
  assert10a.equal(loop.session_chain.sessions.find(s => s.run_id === fixture.childRunId)
    .continuation.phase, 'acquired');
  assert10a.equal(loop.session_chain.sessions.find(s => s.run_id === fixture.childRunId)
    .host_surface.observed_at, '2026-07-13T00:00:04.000Z');
  assert10a.equal(loop.session_chain.sessions.find(s => s.run_id === fixture.childRunId)
    .host_surface.observed_generation, 2);
  assert10a.equal(loop.session_chain.sessions.find(s => s.run_id === fixture.childRunId)
    .host_surface.observed_generation, loop.session_chain.lease.generation);
  assert10a.throws(() => acquire10a(fixture.root, fixture.runId,
    { ...input, stdinMode: 'pipe-open-noecho', observation: {
      ...input.observation, structured_stdin_mode: 'pipe-open-noecho' } },
    { cwdFn: () => fixture.root, nowFn: () => assert10a.fail('mode-fenced retry has no clock') }),
  /APP_STDIN_MODE_FENCED/);
  assert10a.throws(() => acquire10a(fixture.root, fixture.runId,
    { ...input, observation: { ...input.observation, source: 'codex-app-host-context' } },
    { cwdFn: () => fixture.root }), /APP_ACQUIRE_PROJECTION_CHANGED/);
});

test10a('acquire response-loss rejects a later accounting event', () => {
  const fixture = confirmed10a();
  const input = { attemptId: fixture.attemptId, owner: fixture.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho', observation: observation10a(fixture.root) };
  acquire10a(fixture.root, fixture.runId, input, { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
  recordCost9a(fixture.root, fixture.runId, { turns: 1, tokens: 0,
    requestId: 'task10a-acquire-tail', fence: { owner: fixture.childRunId, generation: 2,
      runtime: 'codex', intent: 'accounting' } });
  const changed = bytes10a(fixture.root, fixture.runId);
  assert10a.throws(() => acquire10a(fixture.root, fixture.runId, input,
    { cwdFn: () => fixture.root,
      nowFn: () => assert10a.fail('displaced acquire retry has no clock') }),
  /APP_ACQUIRE_PROJECTION_CHANGED/);
  assert10a.deepEqual(bytes10a(fixture.root, fixture.runId), changed);
});

test10a('unconfirmed is fenced but exact confirmed child stays eligible after parent await timeout', () => {
  const unconfirmed = prepared9a();
  assert10a.throws(() => acquire10a(unconfirmed.root, unconfirmed.runId,
    { attemptId: unconfirmed.attemptId, owner: unconfirmed.childRunId, generation: 1,
      runtime: 'codex', stdinMode: 'pty-raw-noecho',
      observation: observation10a(unconfirmed.root) }, { cwdFn: () => unconfirmed.root }),
  /APP_CONFIRMATION_REQUIRED/);
  const late = confirmed10a();
  let now = Date.parse('2026-07-13T00:00:03.000Z');
  await10a(late.root, late.runId, { owner: late.runId, generation: 1,
    attemptId: late.attemptId }, { pollNowFn: () => now, nowFn: () => now,
    sleepFn: ms => { now += ms; }, pollIntervalMs: 1_000, cwdFn: () => late.root });
  const result = acquire10a(late.root, late.runId,
    { attemptId: late.attemptId, owner: late.childRunId, generation: 1,
      runtime: 'codex', stdinMode: 'pty-raw-noecho', observation: observation10a(late.root) },
    { cwdFn: () => late.root, nowFn: () => now + 1 });
  assert10a.equal(result.outcome, 'acquired');
  assert10a.equal(state10a(late.root, late.runId).data.status, 'running');
});

test10a('acquire separates malformed shape from valid authority mismatch after state fences', () => {
  const fixture = confirmed10a();
  const base = { attemptId: fixture.attemptId, owner: fixture.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho' };
  const before = durable9a(fixture.root, fixture.runId);
  assert10a.throws(() => acquire10a(fixture.root, fixture.runId,
    { ...base, observation: {} }, { cwdFn: () => fixture.root }),
  /APP_CHILD_OBSERVATION_INVALID/);
  assert10a.deepEqual(durable9a(fixture.root, fixture.runId), before);

  const wrongCwd = join8b(fixture.root, 'wrong-child-cwd');
  mkdir8b(wrongCwd, { recursive: true });
  const authorityMismatch = { ...observation10a(wrongCwd),
    source: 'terminal-app' };
  assert10a.throws(() => acquire10a(fixture.root, fixture.runId,
    { ...base, owner: fixture.runId, observation: authorityMismatch },
    { cwdFn: () => wrongCwd }), /LEASE_FENCED/);
  assert10a.throws(() => acquire10a(fixture.root, fixture.runId,
    { ...base, observation: authorityMismatch }, { cwdFn: () => wrongCwd }),
  /APP_CHILD_OBSERVATION_FENCED/);
  assert10a.deepEqual(durable9a(fixture.root, fixture.runId), before);
});

test10a('confirm and acquire response-loss no-ops reject alias parents and lifecycle drift', () => {
  for (const operation of ['confirm', 'acquire']) {
    for (const drift of ['alias-parent', 'child-ended', 'parent-outcome']) {
      const fixture = confirmed10a();
      const confirmInput = { owner: fixture.runId, generation: 1,
        attemptId: fixture.attemptId, stdinMode: 'pty-raw-noecho', threadId: 'thread' };
      const acquireInput = { attemptId: fixture.attemptId, owner: fixture.childRunId,
        generation: 1, runtime: 'codex', stdinMode: 'pty-raw-noecho',
        observation: observation10a(fixture.root) };
      if (operation === 'acquire') {
        acquire10a(fixture.root, fixture.runId, acquireInput,
          { cwdFn: () => fixture.root,
            nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
      }
      raw10a(fixture.root, fixture.runId, loop => {
        const child = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
        const parent = loop.session_chain.sessions.find(item => item.run_id === fixture.runId);
        if (drift === 'alias-parent') {
          loop.session_chain.sessions.push({ run_id: '01JAPPHST00000000000000091',
            started_at: null, ended_at: null, turns: 0, outcome: null,
            superseded_by: fixture.childRunId, handoff_rel: 'handoffs/alias.md' });
        } else if (drift === 'child-ended') {
          child.ended_at = '2026-07-13T00:00:09.000Z';
        } else {
          parent.outcome = operation === 'confirm' ? 'took_over' : null;
        }
      });
      const changed = bytes10a(fixture.root, fixture.runId);
      const invoke = operation === 'confirm'
        ? () => confirm10a(fixture.root, fixture.runId, confirmInput,
          { nowFn: () => assert10a.fail('corrupt confirm retry has no clock') })
        : () => acquire10a(fixture.root, fixture.runId, acquireInput,
          { cwdFn: () => fixture.root,
            nowFn: () => assert10a.fail('corrupt acquire retry has no clock') });
      assert10a.throws(invoke,
        /RUN_SNAPSHOT_INVALID|APP_RESPONSE_PROJECTION_CHANGED|APP_ACQUIRE_PROJECTION_CHANGED/,
      `${operation}/${drift}`);
      assert10a.deepEqual(bytes10a(fixture.root, fixture.runId), changed,
        `${operation}/${drift}`);
    }
  }
});

test10a('acquire final lock fences identity before proof and proves before terminal business', () => {
  const entry = confirmed10a();
  raw10a(entry.root, entry.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:09.000Z';
  });
  const entryBefore = bytes10a(entry.root, entry.runId);
  let callbackCalls = 0;
  const pathDeps = {
    platform: process.platform,
    exists: () => { callbackCalls += 1; return true; },
    realpath: value => { callbackCalls += 1; return value; },
    stat: () => { callbackCalls += 1; return { dev: 1, ino: 1 }; },
    sameFile: () => { callbackCalls += 1; return true; },
  };
  for (const [identity, expected] of [
    [{ owner: entry.runId, generation: 1 }, /APP_ATTEMPT_FENCED/],
    [{ owner: entry.childRunId, generation: 9 }, /LEASE_FENCED/],
    [{ owner: entry.childRunId, generation: 1, runtime: 'claude' }, /RUNTIME_FENCED/],
  ]) {
    assert10a.throws(() => acquire10a(entry.root, entry.runId, {
      attemptId: entry.attemptId, runtime: 'codex', ...identity,
      stdinMode: 'pty-raw-noecho', observation: observation10a(entry.root),
    }, { cwdFn: () => { callbackCalls += 1; return entry.root; }, pathDeps }), expected);
  }
  assert10a.equal(callbackCalls, 0,
    'entry identity fence precedes observation parsing, cwd, and native-path callbacks');
  assert10a.deepEqual(bytes10a(entry.root, entry.runId), entryBefore);

  const fixture = confirmed10a();
  const input = { attemptId: fixture.attemptId, owner: fixture.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho',
    observation: observation10a(fixture.root) };
  let corrupted;
  const invoke = () => acquire10a(fixture.root, fixture.runId, input, {
    cwdFn: () => {
      raw10a(fixture.root, fixture.runId, loop => { loop.status = 'stopped'; });
      corrupted = bytes10a(fixture.root, fixture.runId);
      return fixture.root;
    },
  });
  assert10a.throws(invoke, /RUN_SNAPSHOT_INVALID/);
  assert10a.deepEqual(bytes10a(fixture.root, fixture.runId), corrupted);
});

import { test as test10b } from 'node:test';
import assert10b from 'node:assert/strict';
import { readFileSync as read10b } from 'node:fs';
import { statusAppTask as status10b } from '../scripts/lib/app-task-continuation.mjs';
import { emitHandoff as genericEmit10b } from '../scripts/lib/handoff.mjs';
import { acquireLease as genericAcquire10b, releaseLease as genericRelease10b,
  reserveHandoff as reserve10b } from '../scripts/lib/lease.mjs';
import { classifyPatch as classify10b, patch as patch10b,
  pauseRun as pause10b, readState as state10b } from '../scripts/lib/state.mjs';
import { readLines as lines10b, verifyLog as verify10b } from '../scripts/lib/integrity.mjs';

test10b('generic acquire and release cannot consume or dismantle a live App attempt', () => {
  const emitted = emitted8b();
  const before = structuredClone(state10b(emitted.root, emitted.runId).data);
  assert10b.deepEqual(genericAcquire10b(emitted.root, emitted.runId,
    { owner: emitted.childRunId, expectGeneration: 1, runtime: 'codex' }),
  { ok: false, generation: 1, reason: 'app-confirmation-required' });
  assert10b.throws(() => genericRelease10b(emitted.root, emitted.runId,
    { owner: '01JAPPWR0NG000000000000000', generation: 1 }), /LEASE_FENCED/);
  assert10b.equal(genericRelease10b(emitted.root, emitted.runId,
    { owner: emitted.runId, generation: 1 }).reason, 'app-transport-owned');
  assert10b.throws(() => patch10b(emitted.root, emitted.runId, 'active_workstreams', [],
    { fence: { owner: emitted.runId, generation: 1, runtime: 'codex' } }),
  /APP_TRANSPORT_OWNED/);
  const eventsBeforePause = lines10b(emitted.root, emitted.runId);
  for (const mode of ['preserve', 'rollback']) {
    assert10b.throws(() => pause10b(emitted.root, emitted.runId, {
      reason: `generic-${mode}`, mode,
      expect: { owner: emitted.runId, generation: 1 },
    }), /APP_TRANSPORT_OWNED/, mode);
  }
  assert10b.deepEqual(lines10b(emitted.root, emitted.runId), eventsBeforePause,
    'rejected pause appends no run-paused event');
  assert10b.equal(verify10b(emitted.root, emitted.runId).ok, true);
  assert10b.deepEqual(state10b(emitted.root, emitted.runId).data, before);
  assert10b.equal(classify10b('session_chain.sessions.1.continuation.phase', 'acquired'), 'forbid');
});

test10b('paused preserve wins before live-App release and cleared acquire restores normal release', () => {
  const preserved = emitted8b();
  prepare8b(preserved.root, preserved.runId,
    { owner: preserved.runId, generation: 1, stdinMode: 'pty-raw-noecho',
      hostInput: { currentHostTaskCwd: preserved.root, projects: [] } }, {
      cwdFn: () => preserved.root, nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      descriptorBuilder: () => assert10b.fail('no descriptor'), reconcileBudgetFn: () => {},
      gateFn: () => ({ ok: true, blocked_by: [] }) });
  assert10b.equal(genericRelease10b(preserved.root, preserved.runId,
    { owner: preserved.runId, generation: 1 }).reason, 'RUN_PAUSED');
  const acquired = confirmed10a();
  const oldAcquire = { attemptId: acquired.attemptId, owner: acquired.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho', observation: observation10a(acquired.root) };
  acquire10a(acquired.root, acquired.runId, oldAcquire,
    { cwdFn: () => acquired.root, nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
  assert10b.equal(genericRelease10b(acquired.root, acquired.runId,
    { owner: acquired.childRunId, generation: 2 }).reason, 'released');
  const releasedBytes = durable9a(acquired.root, acquired.runId);
  const oldConfirm = { owner: acquired.runId, generation: 1, attemptId: acquired.attemptId,
    stdinMode: 'pty-raw-noecho', threadId: 'thread' };
  assert10b.throws(() => confirm10a(acquired.root, acquired.runId, oldConfirm,
    { nowFn: () => assert10b.fail('released confirm retry has no clock') }),
  /APP_RESPONSE_PROJECTION_CHANGED/);
  assert10b.throws(() => acquire10a(acquired.root, acquired.runId, oldAcquire,
    { cwdFn: () => acquired.root,
      nowFn: () => assert10b.fail('released acquire retry has no clock') }),
  /APP_ACQUIRE_PROJECTION_CHANGED/);
  assert10b.deepEqual(durable9a(acquired.root, acquired.runId), releasedBytes);
  const projected = status10b(acquired.root, acquired.runId, {});
  assert10b.deepEqual(projected.generic_current,
    { run_id: acquired.childRunId, handoff_rel: projected.current.handoff_rel });
  assert10b.equal(projected.recovery_pending, null);
  assert10b.deepEqual(genericAcquire10b(acquired.root, acquired.runId, {
    owner: projected.generic_current.run_id, expectGeneration: 2, runtime: 'codex',
  }), { ok: true, generation: 3, reason: 'acquired' });
  const reacquiredBytes = durable9a(acquired.root, acquired.runId);
  assert10b.throws(() => confirm10a(acquired.root, acquired.runId, oldConfirm,
    { nowFn: () => assert10b.fail('generation-fenced confirm retry has no clock') }),
  /LEASE_FENCED/);
  assert10b.throws(() => acquire10a(acquired.root, acquired.runId, oldAcquire,
    { cwdFn: () => assert10b.fail('generation-fenced acquire retry has no cwd'),
      nowFn: () => assert10b.fail('generation-fenced acquire retry has no clock') }),
  /LEASE_FENCED/);
  assert10b.deepEqual(durable9a(acquired.root, acquired.runId), reacquiredBytes);
  const genericallyReacquired = state10b(acquired.root, acquired.runId).data;
  const currentSession = genericallyReacquired.session_chain.sessions.find(session =>
    session.run_id === acquired.childRunId);
  assert10b.equal(currentSession.host_surface.observed_generation, 2);
  assert10b.equal(genericallyReacquired.session_chain.lease.generation, 3);
  assert10b.notEqual(currentSession.host_surface.observed_generation,
    genericallyReacquired.session_chain.lease.generation,
    'generic reacquire preserves history but invalidates exact App authority until re-attestation');
});

test10b('failed and abandoned human-preserve bindings remain App-owned', () => {
  const failed = prepared9a({ route: 'fork' });
  fail9a(failed.root, failed.runId, { owner: failed.runId, generation: 1,
    attemptId: failed.attemptId, code: 'message-unconfirmed', stdinMode: 'pty-raw-noecho',
    unconfirmedThreadId: 'known-child' }, { cwdFn: () => failed.worktree });
  assert10b.equal(genericAcquire10b(failed.root, failed.runId,
    { owner: failed.childRunId, expectGeneration: 1, runtime: 'codex' }).reason,
  'app-confirmation-required');
  assert10b.equal(genericRelease10b(failed.root, failed.runId,
    { owner: failed.runId, generation: 1 }).reason, 'RUN_PAUSED');

  const abandoned = emitted8b();
  revoke8b(abandoned.root, abandoned.runId,
    { owner: abandoned.runId, generation: 1, runtime: 'codex' });
  assert10b.equal(genericAcquire10b(abandoned.root, abandoned.runId,
    { owner: abandoned.childRunId, expectGeneration: 1, runtime: 'codex' }).reason,
  'app-confirmation-required');
  assert10b.equal(genericRelease10b(abandoned.root, abandoned.runId,
    { owner: abandoned.runId, generation: 1 }).reason, 'RUN_PAUSED');
});

test10b('old acquired provenance survives a same-generation later reservation', () => {
  const fixture = confirmed10a();
  const oldAcquire = { attemptId: fixture.attemptId, owner: fixture.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho', observation: observation10a(fixture.root) };
  acquire10a(fixture.root, fixture.runId, oldAcquire,
    { cwdFn: () => fixture.root, nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
  assert10b.equal(reserve10b(fixture.root, fixture.runId,
    { trigger: 'next', expect: { owner: fixture.childRunId, generation: 2 } }).ok, true);
  const loop = state10b(fixture.root, fixture.runId).data;
  const old = loop.session_chain.sessions.find(session => session.run_id === fixture.childRunId);
  assert10b.equal(old.continuation.acquired_generation, 2);
  assert10b.equal(loop.session_chain.lease.handoff_phase, 'reserved');
  const reservedBytes = durable9a(fixture.root, fixture.runId);
  assert10b.throws(() => confirm10a(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
      stdinMode: 'pty-raw-noecho', threadId: 'thread' },
    { nowFn: () => assert10b.fail('reserved-progressed confirm retry has no clock') }),
  /APP_RESPONSE_PROJECTION_CHANGED/);
  assert10b.throws(() => acquire10a(fixture.root, fixture.runId, oldAcquire,
    { cwdFn: () => fixture.root,
      nowFn: () => assert10b.fail('reserved acquire retry has no clock') }),
  /APP_ACQUIRE_PROJECTION_CHANGED/);
  assert10b.deepEqual(durable9a(fixture.root, fixture.runId), reservedBytes);
});

test10b('generic handoff after App history remains acquirable by its new exact child', () => {
  const fixture = confirmed10a();
  const oldAcquire = { attemptId: fixture.attemptId, owner: fixture.childRunId, generation: 1,
    runtime: 'codex', stdinMode: 'pty-raw-noecho', observation: observation10a(fixture.root) };
  acquire10a(fixture.root, fixture.runId, oldAcquire,
    { cwdFn: () => fixture.root, nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') });
  const emitted = genericEmit10b(fixture.root, fixture.runId, {
    reason: 'next generic child', trigger: 'milestone',
    now: Date.parse('2026-07-13T00:00:05.000Z'),
    expect: { owner: fixture.childRunId, generation: 2 },
  });
  assert10b.equal(emitted.ok, true);
  const before = state10b(fixture.root, fixture.runId).data;
  const historical = before.session_chain.sessions.find(session =>
    session.run_id === fixture.childRunId);
  assert10b.equal(historical.continuation.phase, 'acquired');
  assert10b.equal(before.session_chain.lease.state, 'releasing');
  assert10b.equal(before.session_chain.lease.handoff_phase, 'emitted');
  assert10b.equal(before.session_chain.lease.handoff_transport, null);
  assert10b.equal(before.session_chain.lease.handoff_attempt_id, null);
  assert10b.equal(before.session_chain.lease.handoff_child_run_id, emitted.childRunId);
  const emittedBytes = durable9a(fixture.root, fixture.runId);
  assert10b.throws(() => acquire10a(fixture.root, fixture.runId, oldAcquire,
    { cwdFn: () => fixture.root,
      nowFn: () => assert10b.fail('emitted acquire retry has no clock') }),
  /APP_ACQUIRE_PROJECTION_CHANGED/);
  assert10b.deepEqual(durable9a(fixture.root, fixture.runId), emittedBytes);
  const projected = status10b(fixture.root, fixture.runId, {});
  assert10b.equal(projected.has_app_history, true);
  assert10b.deepEqual(projected.generic_current,
    { run_id: emitted.childRunId, handoff_rel: emitted.handoffRel });
  assert10b.equal(projected.current.run_id, fixture.childRunId,
    'historical App current remains separate from current generic transport');
  assert10b.equal(JSON.stringify(projected).includes(emitted.handoffPath), false,
    'safe generic projection exposes only the relative handoff path');
  const handoff = read10b(emitted.handoffPath, 'utf8');
  assert10b.match(handoff, new RegExp(emitted.childRunId));
  assert10b.match(handoff, new RegExp(fixture.runId));
  const resumed = genericAcquire10b(fixture.root, fixture.runId, {
    owner: emitted.childRunId, expectGeneration: 2, runtime: 'codex',
  });
  assert10b.deepEqual(resumed, { ok: true, generation: 3, reason: 'acquired' });
  const after = state10b(fixture.root, fixture.runId).data;
  assert10b.equal(after.session_chain.lease.owner_run_id, emitted.childRunId);
  assert10b.equal(after.session_chain.lease.generation, 3);
  assert10b.equal(after.status, 'running');
  assert10b.equal(after.session_chain.sessions.find(session =>
    session.run_id === fixture.childRunId).continuation.phase, 'acquired');
  assert10b.equal(genericRelease10b(fixture.root, fixture.runId,
    { owner: emitted.childRunId, generation: 3 }).reason, 'released');
  const released = status10b(fixture.root, fixture.runId, {});
  assert10b.deepEqual(released.generic_current,
    { run_id: emitted.childRunId, handoff_rel: emitted.handoffRel });
  assert10b.equal(released.current.run_id, fixture.childRunId,
    'released generic owner outranks stale App history');
  assert10b.equal(released.recovery_pending, null);
  const resumedAgain = genericAcquire10b(fixture.root, fixture.runId, {
    owner: released.generic_current.run_id,
    expectGeneration: released.generation, runtime: 'codex',
  });
  assert10b.deepEqual(resumedAgain, { ok: true, generation: 4, reason: 'acquired' });
  assert10b.equal(state10b(fixture.root, fixture.runId).data.session_chain.lease.owner_run_id,
    emitted.childRunId);
});
