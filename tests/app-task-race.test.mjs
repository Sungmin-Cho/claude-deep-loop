import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readLines, readVerifiedState, verifyLog } from '../scripts/lib/integrity.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { durableRunBytes as bytes11c,
  rawHashValidState } from './fixtures/verified-app-run.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { acquireAppTask, awaitAppTask, confirmAppTask,
  appNativePathDeps, prepareAppTask, revokeAppTaskContinuation,
  sweepUnconfirmedAppTask } from '../scripts/lib/app-task-continuation.mjs';

function appSeed11c() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-race-')));
  const observed = '2026-07-13T00:00:00.000Z';
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', now: new Date(observed),
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context',
      observed_at: observed }, cwdFn: () => root, appContinuationConsent: { mode: 'auto',
      authority: 'human-confirmed', confirmed_at: observed, revoked_at: null } });
  const attemptId = '01JAPPTASK0000000000000000';
  const descriptorBuilder = ({ runtime, root: projectRoot, parentRunId, childRunId }) => ({
    runtime, projectRoot, runId: parentRunId, usageOutputKind: 'json',
    resumeInvocation: childRunId, entries: Object.fromEntries(['interactive', 'headless',
      'cmux', 'iterm2', 'terminal-app', 'wt', 'powershell', 'desktop']
      .map(name => [name, { display: 'manual', unavailable: true }])) });
  return { root, runId, attemptId, descriptorBuilder };
}

function emitted8b() {
  const fixture = appSeed11c();
  const { root, runId, attemptId, descriptorBuilder } = fixture;
  const emitted = emitHandoff(root, runId, { trigger: 'race', appIntent: true,
    expect: { owner: runId, generation: 1 }, cwdFn: () => root, descriptorBuilder,
    attemptIdFactory: () => attemptId,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  return { ...fixture, childRunId: emitted.childRunId };
}

function prepared9a() {
  const fixture = emitted8b();
  prepareAppTask(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    stdinMode: 'pipe-open-noecho', hostInput: { currentHostTaskCwd: fixture.root,
      projects: [{ projectId: 'race-project', projectKind: 'local', path: fixture.root }] } }, {
    cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
    descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
      projectId: 'race-project', environment: { type: 'local' } }, prompt: 'race prompt' }),
    reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }),
  });
  return fixture;
}

function confirmed10a() {
  const fixture = prepared9a();
  confirmAppTask(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pipe-open-noecho', threadId: 'race-thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') });
  return fixture;
}

const observation10a = root => ({ kind: 'codex-app', source: 'codex-app-tool-provenance',
  capabilities: ['structured-process-stdin'], structured_stdin_mode: 'pipe-open-noecho',
  host_task_cwd: root, host_task_cwd_source: 'app-task-context' });

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'app-transition-worker.mjs');
const RACE_BARRIER_TIMEOUT_MS = 30_000;
const RACE_WORKER_COMPLETION_TIMEOUT_MS = 45_000;
function childOperation(payload) {
  const child = spawn(process.execPath,
    [WORKER, payload.op, payload.root, payload.runId],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  let text = '';
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    child.once('error', error => {
      if (!readySettled) { readySettled = true; reject(error); }
    });
    child.once('close', code => {
      if (!readySettled) {
        readySettled = true;
        reject(new Error(`worker-closed-before-ready-${code}`));
      }
    });
    child.stdout.on('data', chunk => {
      text += chunk;
      if (!readySettled && text.split('\n')[0] === `WORKER_READY:v1:${payload.op}`) {
        readySettled = true;
        resolve();
      }
    });
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(new Error(`worker-completion-timeout-${payload.op}`));
    }, RACE_WORKER_COMPLETION_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`worker-exit-${code}`));
      try { resolve(JSON.parse(text.trim().split('\n').at(-1))); }
      catch (error) { reject(error); }
    });
  });
  const body = JSON.stringify({ now: payload.now, input: payload.input,
    ...(payload.snapshotBarrier ? { snapshotBarrier: payload.snapshotBarrier } : {}),
    ...(payload.catchReadBarrier ? { catchReadBarrier: payload.catchReadBarrier } : {}),
    ...(payload.operationBarrier ? { operationBarrier: payload.operationBarrier } : {}) });
  return { ready, done, release: () => child.stdin.end(`${body}\n`),
    terminate: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
}
async function stopChildren(operations) {
  for (const operation of operations) operation.terminate();
  await Promise.allSettled(operations.map(operation => operation.done));
}
async function protectChildren(operations, action) {
  try { return await action(); }
  catch (error) { await stopChildren(operations); throw error; }
}
async function race(left, right) {
  const a = childOperation(left); const b = childOperation(right);
  return protectChildren([a, b], async () => {
    await Promise.all([a.ready, b.ready]);
    a.release(); b.release();
    return Promise.all([a.done, b.done]);
  });
}

async function raceAfterPreAppendSnapshots(left, right) {
  const markerA = join(left.root, `pre-append-${left.op}-a`);
  const markerB = join(left.root, `pre-append-${right.op}-b`);
  const release = join(left.root, `pre-append-${left.op}-${right.op}-release`);
  const a = childOperation({ ...left,
    operationBarrier: { mine: markerA, peer: markerB, release } });
  const b = childOperation({ ...right,
    operationBarrier: { mine: markerB, peer: markerA, release } });
  return protectChildren([a, b], async () => {
    await Promise.all([a.ready, b.ready]);
    a.release(); b.release();
    await Promise.all([
      waitForRaceFile(markerA, [a, b]), waitForRaceFile(markerB, [a, b]),
    ]);
    writeFileSync(release, 'continue', { flag: 'wx' });
    return Promise.all([a.done, b.done]);
  });
}

async function waitForRaceFile(path, operations = []) {
  const deadline = Date.now() + RACE_BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await stopChildren(operations);
  throw new Error(`snapshot-barrier-timeout:${path}`);
}

async function raceAfterInitialSnapshots(left, right) {
  const markerA = join(left.root, 'await-initial-a');
  const markerB = join(left.root, 'await-initial-b');
  const release = join(left.root, 'await-initial-release');
  const a = childOperation({ ...left,
    snapshotBarrier: { mine: markerA, peer: markerB, release } });
  const b = childOperation({ ...right,
    snapshotBarrier: { mine: markerB, peer: markerA, release } });
  return protectChildren([a, b], async () => {
    await Promise.all([a.ready, b.ready]);
    a.release(); b.release();
    await Promise.all([
      waitForRaceFile(markerA, [a, b]), waitForRaceFile(markerB, [a, b]),
    ]);
    writeFileSync(release, 'continue', { flag: 'wx' });
    return Promise.all([a.done, b.done]);
  });
}
const eventCount = (root, runId, type) => readLines(root, runId)
  .filter(event => event.type === type).length;
const assertAnchored = fixture => assert.equal(verifyLog(fixture.root, fixture.runId).ok, true);

function reentrantVerifiedRead(fixture, operation) {
  let calls = 0;
  return { seam: ({ operation: actual }) => {
    assert.equal(actual, operation);
    const snapshot = readVerifiedState(fixture.root, fixture.runId).data;
    assert.equal(snapshot.run_id, fixture.runId);
    calls += 1;
  }, assertCalled: () => assert.equal(calls, 1, `${operation} outside-lock callback count`) };
}

test('prepare confirm revoke and sweep callbacks can reenter the verified reader outside the lock', () => {
  {
    const fixture = emitted8b(); const probe = reentrantVerifiedRead(fixture, 'prepare');
    prepareAppTask(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
      stdinMode: 'pipe-open-noecho', hostInput: { currentHostTaskCwd: fixture.root,
        projects: [{ projectId: 'race-project', projectKind: 'local', path: fixture.root }] } }, {
      cwdFn: () => fixture.root, nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
        projectId: 'race-project', environment: { type: 'local' } }, prompt: 'race prompt' }),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }),
      beforeAppendFn: probe.seam });
    probe.assertCalled(); assertAnchored(fixture);
  }
  {
    const fixture = prepared9a(); const probe = reentrantVerifiedRead(fixture, 'confirm');
    confirmAppTask(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
      attemptId: fixture.attemptId, stdinMode: 'pipe-open-noecho', threadId: 'race-thread' },
    { cwdFn: () => fixture.root, nowFn: () => Date.parse('2026-07-13T00:00:03.000Z'),
      beforeAppendFn: probe.seam });
    probe.assertCalled(); assertAnchored(fixture);
  }
  {
    const fixture = emitted8b(); const probe = reentrantVerifiedRead(fixture, 'revoke');
    revokeAppTaskContinuation(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, runtime: 'codex' },
      { nowFn: () => Date.parse('2026-07-13T00:00:03.000Z'), beforeAppendFn: probe.seam });
    probe.assertCalled(); assertAnchored(fixture);
  }
  {
    const fixture = emitted8b(); const probe = reentrantVerifiedRead(fixture, 'sweep');
    sweepUnconfirmedAppTask(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
        deadline: '2026-07-13T00:05:01.000Z' },
      { cwdFn: () => fixture.root, nowFn: () => Date.parse('2026-07-13T00:05:01.001Z'),
        beforeAppendFn: probe.seam });
    probe.assertCalled(); assertAnchored(fixture);
  }
});

test('prepare authorizes deadline and gate with the fresh final-lock clock', () => {
  const fixture = emitted8b();
  const before = bytes11c(fixture.root, fixture.runId);
  assert.throws(() => prepareAppTask(fixture.root, fixture.runId,
    { owner: fixture.runId, generation: 1, stdinMode: 'pipe-open-noecho',
      hostInput: { currentHostTaskCwd: fixture.root,
        projects: [{ projectId: 'race-project', projectKind: 'local', path: fixture.root }] } }, {
      cwdFn: () => fixture.root,
      precheckNowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      nowFn: () => Date.parse('2026-07-13T00:06:00.000Z'),
      descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
        projectId: 'race-project', environment: { type: 'local' } }, prompt: 'race prompt' }),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }),
    }), /APP_PREPARE_DEADLINE_EXPIRED/);
  assert.deepEqual(bytes11c(fixture.root, fixture.runId), before);
});

test('reentrant final-lock clock and gate seams fail closed without a write', () => {
  for (const seam of ['clock', 'gate']) {
    const fixture = emitted8b();
    const before = bytes11c(fixture.root, fixture.runId);
    const reenter = () => readVerifiedState(fixture.root, fixture.runId);
    assert.throws(() => prepareAppTask(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pipe-open-noecho',
        hostInput: { currentHostTaskCwd: fixture.root,
          projects: [{ projectId: 'race-project', projectKind: 'local', path: fixture.root }] } }, {
        cwdFn: () => fixture.root,
        precheckNowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
        nowFn: () => {
          if (seam === 'clock') reenter();
          return Date.parse('2026-07-13T00:00:02.000Z');
        },
        descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
          projectId: 'race-project', environment: { type: 'local' } }, prompt: 'race prompt' }),
        reconcileBudgetFn: () => {}, gateFn: (_loop, options) => {
          if (seam === 'gate') reenter();
          return { ok: true, blocked_by: [], now: options.now };
        },
      }), /LOCK_BUSY/);
    assert.deepEqual(bytes11c(fixture.root, fixture.runId), before);
  }
});

test('reentrant cwd and native-path callbacks finish before the final mutation lock', () => {
  for (const seam of ['cwd', 'realpath']) {
    const fixture = emitted8b();
    const native = appNativePathDeps();
    let callbackCalls = 0;
    const reenter = value => {
      callbackCalls += 1;
      readVerifiedState(fixture.root, fixture.runId);
      return value;
    };
    const deps = {
      cwdFn: () => seam === 'cwd' ? reenter(fixture.root) : fixture.root,
      pathDeps: { ...native,
        realpath: value => seam === 'realpath'
          ? reenter(native.realpath(value)) : native.realpath(value) },
      precheckNowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
        projectId: 'race-project', environment: { type: 'local' } }, prompt: 'race prompt' }),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }),
    };
    const result = prepareAppTask(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, stdinMode: 'pipe-open-noecho',
        hostInput: { currentHostTaskCwd: fixture.root,
          projects: [{ projectId: 'race-project', projectKind: 'local',
            path: fixture.root }] } }, deps);
    assert.equal(result.outcome, 'prepared');
    assert.ok(callbackCalls > 0, `${seam} callback did not run`);
    assertAnchored(fixture);
  }
});

test('race worker rejects process close before READY and leaves no live child', async () => {
  const fixture = emitted8b();
  const operation = childOperation({ op: 'invalid', root: fixture.root,
    runId: fixture.runId, now: Date.parse('2026-07-13T00:00:02.000Z'), input: {} });
  const done = assert.rejects(operation.done, /worker-exit-/);
  await assert.rejects(operation.ready, /worker-closed-before-ready-/);
  await done;
});

test('observe process winning after PreCompact read forces human fallback and preserve-pause', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-precompact-observe-race-')));
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z'), hostObservation: null,
    cwdFn: () => root });
  writeFileSync(join(root, '.deep-loop', 'runs', runId, 'event-log.jsonl'), '');
  rawHashValidState(root, runId, loop => {
    delete loop.initialization;
    delete loop.autonomy.app_task_continuation;
    loop.session_chain.sessions[0].host_surface = null;
    loop.event_log_head = { seq: 0, checksum: 'GENESIS' };
  });
  assert.equal(readState(root, runId).data.session_chain.sessions[0].host_surface, null);
  const precompactReady = join(root, 'precompact-final-ready');
  const observationDone = join(root, 'observation-done');
  const release = join(root, 'precompact-final-release');
  const precompact = childOperation({ op: 'precompact', root, runId,
    now: Date.parse('2026-07-13T00:00:02.000Z'), input: {},
    operationBarrier: { mine: precompactReady, peer: observationDone, release } });
  const observe = childOperation({ op: 'observe', root, runId,
    now: Date.parse('2026-07-13T00:00:01.000Z'), input: {
      owner: runId, generation: 1, runtime: 'codex', readerMode: 'pty-raw-noecho',
      observation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
        capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
        structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
        host_task_cwd_source: 'app-task-context' },
    } });
  await protectChildren([precompact, observe], async () => {
    await Promise.all([precompact.ready, observe.ready]);
    precompact.release();
    await Promise.race([
      waitForRaceFile(precompactReady, [precompact, observe]),
      precompact.done.then(result => {
        throw new Error(`precompact-finished-before-barrier:${JSON.stringify(result)}`);
      }),
    ]);
    observe.release();
    const observed = await observe.done;
    assert.equal(observed.ok, true, JSON.stringify(observed));
    assert.equal(observed.result.outcome, 'observed');
    writeFileSync(observationDone, 'observed', { flag: 'wx' });
    writeFileSync(release, 'continue', { flag: 'wx' });
    const result = await precompact.done;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.action, 'app-authority-unconfirmed-paused');
  });
  const loop = readState(root, runId).data;
  assert.equal(loop.session_chain.sessions[0].host_surface.kind, 'codex-app');
  assert.equal(loop.status, 'paused');
  assert.equal(loop.pause_reason, 'app-authority-unconfirmed');
  assert.equal(loop.session_chain.lease.state, 'releasing');
  assert.equal(loop.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(loop.session_chain.lease.resume_policy, 'human');
  assert.equal(loop.session_chain.lease.handoff_transport, null);
  assert.equal(eventCount(root, runId, 'host-surface-observed'), 1);
  assert.equal(eventCount(root, runId, 'handoff-emitted'), 1);
  assert.equal(eventCount(root, runId, 'run-paused'), 1);
  assertAnchored({ root, runId });
});

test('two final-emit processes leave one event and the loser cannot roll back the winner', async () => {
  const fixture = appSeed11c();
  const payload = { op: 'emit', root: fixture.root, runId: fixture.runId,
    now: Date.parse('2026-07-13T00:00:01.000Z'), input: {
      owner: fixture.runId, generation: 1, reason: 'process-race', trigger: 'process-race',
      attemptId: fixture.attemptId,
    } };
  const results = await raceAfterPreAppendSnapshots(payload, payload);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.equal(results.filter(row => row.code === 'HANDOFF_PHASE_FENCED').length, 1);
  const winner = results.find(row => row.ok).result;
  const loop = readState(fixture.root, fixture.runId).data;
  assert.equal(loop.session_chain.lease.state, 'releasing');
  assert.equal(loop.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(loop.session_chain.lease.handoff_transport, 'codex-app');
  assert.equal(loop.session_chain.lease.handoff_attempt_id, fixture.attemptId);
  assert.equal(loop.session_chain.lease.handoff_child_run_id, winner.childRunId);
  assert.equal(loop.session_chain.sessions.filter(session =>
    session.run_id === winner.childRunId).length, 1);
  assert.equal(eventCount(fixture.root, fixture.runId, 'handoff-emitted'), 1);
  assert.equal(validate(loop).ok, true);
  assertAnchored(fixture);
});

test('acquire process is fenced while confirm is paused before append then succeeds after commit', async () => {
  const fixture = prepared9a();
  const confirmReady = join(fixture.root, 'confirm-before-acquire-ready');
  const confirmRelease = join(fixture.root, 'confirm-before-acquire-release');
  const before = { state: structuredClone(readState(fixture.root, fixture.runId).data),
    events: structuredClone(readLines(fixture.root, fixture.runId)) };
  const operations = [];
  const confirming = childOperation({ op: 'confirm', root: fixture.root,
    runId: fixture.runId, now: Date.parse('2026-07-13T00:00:03.000Z'),
    input: { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId,
      stdinMode: 'pipe-open-noecho', threadId: 'race-thread' },
    operationBarrier: { mine: confirmReady, peer: confirmReady, release: confirmRelease } });
  operations.push(confirming);
  await protectChildren(operations, async () => {
    await confirming.ready;
    confirming.release();
    await waitForRaceFile(confirmReady, operations);

    const blocked = childOperation({ op: 'acquire', root: fixture.root,
      runId: fixture.runId, now: Date.parse('2026-07-13T00:00:03.500Z'),
      input: { owner: fixture.childRunId, generation: 1, attemptId: fixture.attemptId,
        runtime: 'codex', stdinMode: 'pipe-open-noecho',
        observation: observation10a(fixture.root) } });
    operations.push(blocked);
    await blocked.ready;
    blocked.release();
    const denied = await blocked.done;
    assert.equal(denied.ok, false);
    assert.match(denied.code, /APP_CONFIRMATION_REQUIRED/);
    assert.deepEqual(readState(fixture.root, fixture.runId).data, before.state);
    assert.deepEqual(readLines(fixture.root, fixture.runId), before.events);

    writeFileSync(confirmRelease, 'continue', { flag: 'wx' });
    assert.equal((await confirming.done).result.outcome, 'confirmed');
    const acquiring = childOperation({ op: 'acquire', root: fixture.root,
      runId: fixture.runId, now: Date.parse('2026-07-13T00:00:04.000Z'),
      input: { owner: fixture.childRunId, generation: 1, attemptId: fixture.attemptId,
        runtime: 'codex', stdinMode: 'pipe-open-noecho',
        observation: observation10a(fixture.root) } });
    operations.push(acquiring);
    await acquiring.ready;
    acquiring.release();
    const acquired = await acquiring.done;
    assert.equal(acquired.ok, true);
    assert.equal(acquired.result.outcome, 'acquired');
    assert.equal(eventCount(fixture.root, fixture.runId, 'app-task-confirmed'), 1);
    assert.equal(eventCount(fixture.root, fixture.runId, 'app-task-acquired'), 1);
    assertAnchored(fixture);
  });
});

test('prepare/prepare grants one action and one descriptor-free retry across processes', async () => {
  const f = emitted8b();
  const payload = { op: 'prepare', root: f.root, runId: f.runId, now: Date.parse('2026-07-13T00:00:02.000Z'),
    input: { owner: f.runId, generation: 1, stdinMode: 'pipe-open-noecho',
      hostInput: { currentHostTaskCwd: f.root,
        projects: [{ projectId: 'race-project', projectKind: 'local', path: f.root }] } } };
  const results = await raceAfterPreAppendSnapshots(payload, payload);
  assert.deepEqual(results.map(row => row.result?.outcome).sort(), ['already-prepared', 'prepared']);
  assert.equal(results.filter(row => row.result?.do_not_call === false && row.result?.action).length, 1);
  assert.equal(results.filter(row => row.result?.do_not_call === true
    && !Object.hasOwn(row.result, 'action')).length, 1);
  assert.equal(eventCount(f.root, f.runId, 'app-task-prepared'), 1);
  assertAnchored(f);
});

test('confirm/revoke and confirm/sweep each linearize to one valid durable terminal projection', async () => {
  const revoked = prepared9a();
  await raceAfterPreAppendSnapshots({ op: 'confirm', root: revoked.root, runId: revoked.runId,
    now: Date.parse('2026-07-13T00:00:03.000Z'), input: { owner: revoked.runId, generation: 1,
      attemptId: revoked.attemptId, stdinMode: 'pipe-open-noecho', threadId: 'race-thread' } },
  { op: 'revoke', root: revoked.root, runId: revoked.runId,
    now: Date.parse('2026-07-13T00:00:03.000Z'),
    input: { owner: revoked.runId, generation: 1, runtime: 'codex' } });
  const revokedChild = readState(revoked.root, revoked.runId).data.session_chain.sessions
    .find(item => item.run_id === revoked.childRunId);
  assert.equal(revokedChild.continuation.phase, 'abandoned');
  assert.equal(eventCount(revoked.root, revoked.runId, 'app-task-consent-revoked'), 1);
  assertAnchored(revoked);

  const swept = prepared9a();
  const pair = await raceAfterPreAppendSnapshots({ op: 'confirm', root: swept.root, runId: swept.runId,
    now: Date.parse('2026-07-13T00:02:01.999Z'), input: { owner: swept.runId, generation: 1,
      attemptId: swept.attemptId, stdinMode: 'pipe-open-noecho', threadId: 'race-thread' } },
  { op: 'sweep', root: swept.root, runId: swept.runId,
    now: Date.parse('2026-07-13T00:02:02.001Z'),
    input: { owner: swept.runId, generation: 1, attemptId: swept.attemptId } });
  assert.equal(pair.filter(row => row.ok).length, 1);
  const phase = readState(swept.root, swept.runId).data.session_chain.sessions
    .find(item => item.run_id === swept.childRunId).continuation.phase;
  assert.ok(['confirmed', 'failed'].includes(phase));
  assertAnchored(swept);
});

test('acquire/await is safe in either order and response-loss retries append nothing', async () => {
  const f = confirmed10a();
  const acquire = { op: 'acquire', root: f.root, runId: f.runId,
    now: Date.parse('2026-07-13T00:00:04.000Z'), input: { attemptId: f.attemptId,
      owner: f.childRunId, generation: 1, runtime: 'codex', stdinMode: 'pipe-open-noecho',
      observation: observation10a(f.root) } };
  const awaiting = { op: 'await', root: f.root, runId: f.runId,
    now: Date.parse('2026-07-13T00:00:40.000Z'),
    input: { owner: f.runId, generation: 1, attemptId: f.attemptId } };
  const pair = await race(acquire, awaiting);
  assert.equal(pair[0].ok, true);
  assert.ok(['acquired', 'already-acquired'].includes(pair[0].result.outcome));
  assert.equal(pair[1].ok, true);
  assert.ok(['acquired', 'timeout-preserved', 'already-timeout-preserved']
    .includes(pair[1].result.outcome));
  assert.equal(readState(f.root, f.runId).data.session_chain.lease.owner_run_id, f.childRunId);
  assert.equal(eventCount(f.root, f.runId, 'app-task-acquired'), 1);
  assert.ok(eventCount(f.root, f.runId, 'app-task-await-timeout') <= 1);
  const before = readLines(f.root, f.runId);
  const retry = acquireAppTask(f.root, f.runId, acquire.input,
    { nowFn: () => Date.parse('2026-07-13T00:01:00.000Z'), cwdFn: () => f.root });
  assert.equal(retry.outcome, 'already-acquired');
  assert.deepEqual(readLines(f.root, f.runId), before);
  assert.equal(awaitAppTask(f.root, f.runId, awaiting.input,
    { pollNowFn: () => assert.fail('acquire-before-await must not poll'),
      nowFn: () => assert.fail('acquire-before-await must not mutate') }).outcome, 'acquired');
  assertAnchored(f);
});

test('await/await has one timeout commit and a write-free exact CAS loser', async () => {
  const fixture = confirmed10a();
  const payload = { op: 'await', root: fixture.root, runId: fixture.runId,
    now: Date.parse('2026-07-13T00:00:03.000Z'),
    input: { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId } };
  const results = await raceAfterInitialSnapshots(payload, payload);
  assert.deepEqual(results.map(row => row.result?.outcome).sort(),
    ['already-timeout-preserved', 'timeout-preserved']);
  assert.equal(eventCount(fixture.root, fixture.runId, 'app-task-await-timeout'), 1);
  const before = readLines(fixture.root, fixture.runId);
  const retry = awaitAppTask(fixture.root, fixture.runId, payload.input, {
    pollNowFn: () => assert.fail('preserved retry must not poll'),
    nowFn: () => assert.fail('preserved retry must not sample a mutation clock'),
  });
  assert.equal(retry.outcome, 'already-timeout-preserved');
  assert.deepEqual(readLines(fixture.root, fixture.runId), before);
  assertAnchored(fixture);
});

test('await CAS loser converges when acquire commits before its catch re-read', async () => {
  const fixture = confirmed10a();
  const markerA = join(fixture.root, 'await-three-initial-a');
  const markerB = join(fixture.root, 'await-three-initial-b');
  const initialRelease = join(fixture.root, 'await-three-initial-release');
  const catchReady = join(fixture.root, 'await-three-catch-ready');
  const catchRelease = join(fixture.root, 'await-three-catch-release');
  const base = { op: 'await', root: fixture.root, runId: fixture.runId,
    now: Date.parse('2026-07-13T00:00:03.000Z'),
    input: { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId },
    catchReadBarrier: { ready: catchReady, release: catchRelease } };
  const a = childOperation({ ...base,
    snapshotBarrier: { mine: markerA, peer: markerB, release: initialRelease } });
  const b = childOperation({ ...base,
    snapshotBarrier: { mine: markerB, peer: markerA, release: initialRelease } });
  await protectChildren([a, b], async () => {
    await Promise.all([a.ready, b.ready]);
    a.release(); b.release();
    await Promise.all([
      waitForRaceFile(markerA, [a, b]), waitForRaceFile(markerB, [a, b]),
    ]);
    writeFileSync(initialRelease, 'continue', { flag: 'wx' });
    await waitForRaceFile(catchReady, [a, b]);
    const acquired = acquireAppTask(fixture.root, fixture.runId, {
      attemptId: fixture.attemptId, owner: fixture.childRunId, generation: 1,
      runtime: 'codex', stdinMode: 'pipe-open-noecho', observation: observation10a(fixture.root),
    }, { cwdFn: () => fixture.root,
      nowFn: () => Date.parse('2026-07-13T00:01:19.000Z') });
    assert.equal(acquired.outcome, 'acquired');
    writeFileSync(catchRelease, 'continue', { flag: 'wx' });
    const results = await Promise.all([a.done, b.done]);
    assert.deepEqual(results.map(row => row.result?.outcome).sort(),
      ['acquired', 'timeout-preserved']);
    assert.equal(eventCount(fixture.root, fixture.runId, 'app-task-await-timeout'), 1);
    assert.equal(eventCount(fixture.root, fixture.runId, 'app-task-acquired'), 1);
    assertAnchored(fixture);
  });
});

test('await CAS loser returns safe terminal outcome when revoke wins before catch re-read', async () => {
  const fixture = confirmed10a();
  const markerA = join(fixture.root, 'await-terminal-initial-a');
  const markerB = join(fixture.root, 'await-terminal-initial-b');
  const initialRelease = join(fixture.root, 'await-terminal-initial-release');
  const catchReady = join(fixture.root, 'await-terminal-catch-ready');
  const catchRelease = join(fixture.root, 'await-terminal-catch-release');
  const base = { op: 'await', root: fixture.root, runId: fixture.runId,
    now: Date.parse('2026-07-13T00:00:03.000Z'),
    input: { owner: fixture.runId, generation: 1, attemptId: fixture.attemptId },
    catchReadBarrier: { ready: catchReady, release: catchRelease } };
  const a = childOperation({ ...base,
    snapshotBarrier: { mine: markerA, peer: markerB, release: initialRelease } });
  const b = childOperation({ ...base,
    snapshotBarrier: { mine: markerB, peer: markerA, release: initialRelease } });
  await protectChildren([a, b], async () => {
    await Promise.all([a.ready, b.ready]);
    a.release(); b.release();
    await Promise.all([
      waitForRaceFile(markerA, [a, b]), waitForRaceFile(markerB, [a, b]),
    ]);
    writeFileSync(initialRelease, 'continue', { flag: 'wx' });
    await waitForRaceFile(catchReady, [a, b]);
    revokeAppTaskContinuation(fixture.root, fixture.runId,
      { owner: fixture.runId, generation: 1, runtime: 'codex' },
      { nowFn: () => Date.parse('2026-07-13T00:01:19.000Z') });
    writeFileSync(catchRelease, 'continue', { flag: 'wx' });
    const results = await Promise.all([a.done, b.done]);
    assert.deepEqual(results.map(row => row.result?.outcome).sort(),
      ['abandoned', 'timeout-preserved']);
    assert.equal(eventCount(fixture.root, fixture.runId, 'app-task-await-timeout'), 1);
    assert.equal(eventCount(fixture.root, fixture.runId, 'app-task-consent-revoked'), 1);
    assertAnchored(fixture);
  });
});
