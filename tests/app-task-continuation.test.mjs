import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
import { acquireLease, releaseLease } from '../scripts/lib/lease.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { observeHostSurface } from '../scripts/lib/app-task-continuation.mjs';
import { hostSurfaceFactsDigest } from '../scripts/lib/host-surface.mjs';

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
