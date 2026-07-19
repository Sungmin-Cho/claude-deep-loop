import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runPreCompactHandoff } from '../scripts/hooks-impl/precompact-handoff.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
import { readState } from '../scripts/lib/state.mjs';
import {
  FakeAppHost,
  FakeStructuredProcess,
  executePreparedAction,
} from './helpers/fake-app-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'deep-loop.mjs');
const APP_OBSERVATION_KEYS = [
  'kind', 'source', 'capabilities', 'structured_stdin_mode',
  'host_task_cwd', 'host_task_cwd_source',
];
const APP_OBSERVATION_CONTRACT_PREFIX = 'APP_OBSERVATION_CONTRACT_V1=';

function loadSkillObservationContract(skillDir) {
  const source = readFileSync(join(HERE, '..', 'skills', skillDir, 'SKILL.md'), 'utf8');
  const rows = source.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith(APP_OBSERVATION_CONTRACT_PREFIX));
  assert.equal(rows.length, 1, `${skillDir}: exact observation contract`);
  return JSON.parse(rows[0].slice(APP_OBSERVATION_CONTRACT_PREFIX.length));
}

function publicToolsForRoute(route) {
  return route === 'create'
    ? ['list_projects', 'create_thread(local)', 'structured_input']
    : ['fork_thread(same-directory)', 'send_message_to_thread', 'structured_input'];
}

function projectObservationFromSkill(skillDir, { publicTools, mode, cwd }) {
  const contract = loadSkillObservationContract(skillDir);
  assert.deepEqual(Object.keys(contract.raw_template), APP_OBSERVATION_KEYS);
  const capabilities = [...new Set(publicTools.map(tool => {
    const capability = contract.tool_to_kernel[tool];
    if (typeof capability !== 'string') throw new Error(`TEST_PUBLIC_TOOL_UNMAPPED:${tool}`);
    return capability;
  }))].sort();
  const values = { ...contract.raw_template, capabilities,
    structured_stdin_mode: mode, host_task_cwd: cwd };
  return Object.fromEntries(APP_OBSERVATION_KEYS.map(key => [key, values[key]]));
}

function escapeReadyPart(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function exactReadyPattern(purpose, binding, mode) {
  return new RegExp(`^DEEP_LOOP_STDIN_READY:v1:${escapeReadyPart(purpose)}:`
    + `${escapeReadyPart(binding)}:${escapeReadyPart(mode)}$`, 'u');
}

function probeReadyPattern(mode) {
  return new RegExp(`^DEEP_LOOP_STDIN_READY:v1:stdin-probe:[0-9a-f]{32}:`
    + `${escapeReadyPart(mode)}$`, 'u');
}

function lastJson(stdout) {
  for (const line of stdout.split(/\r?\n/u).filter(Boolean).reverse()) {
    try { return JSON.parse(line); } catch { /* READY/non-JSON line */ }
  }
  throw new Error(`SAFE_JSON_MISSING: ${stdout}`);
}

function snapshotDurableArtifacts(root, runId) {
  const run = join(root, '.deep-loop', 'runs', runId);
  return {
    state: readFileSync(join(run, 'loop.json')),
    events: readFileSync(join(run, 'event-log.jsonl')),
    hash: readFileSync(join(run, '.loop.hash')),
  };
}

function runKernel(root, args, { cwd = root, env = process.env } = {}) {
  const stdout = execFileSync(process.execPath, [CLI, ...args, '--project-root', root], {
    cwd, encoding: 'utf8', env,
  });
  return { json: lastJson(stdout), stdout };
}

function fixedClockEnv(root, now) {
  if (!Number.isFinite(now)) throw new Error('TEST_CLOCK_INVALID');
  const modulePath = join(root, '.deep-loop-test-fixed-clock.mjs');
  writeFileSync(modulePath, `Date.now = () => ${Math.trunc(now)};\n`);
  const option = `--import=${pathToFileURL(modulePath).href}`;
  return { ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, option].filter(Boolean).join(' ') };
}

function runKernelResult(root, args, { cwd = root } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    cwd, encoding: 'utf8', env: process.env,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsyncKernel(root, args, { cwd = root, timeoutMs = 15_000 } = {}) {
  const child = spawn(process.execPath, [CLI, ...args, '--project-root', root], {
    cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(new Error('ASYNC_KERNEL_TIMEOUT'));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ASYNC_KERNEL_EXIT_${code}: ${stderr}`));
      resolve({ json: lastJson(stdout), stdout, stderr });
    });
  });
  return {
    done,
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

function runReadyKernel(root, args, inputLine, readyPattern, { cwd = root, timeoutMs = 5_000 } = {}) {
  if (typeof inputLine !== 'string' || /[\r\n]/u.test(inputLine)) {
    return Promise.reject(new Error('TEST_STRUCTURED_INPUT_MUST_BE_EXACTLY_ONE_LINE'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root], {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sent = false;
    let readyError = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('READY_PROCESS_TIMEOUT'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const completeLines = stdout.split(/\r?\n/u);
      if (!/\r?\n$/u.test(stdout)) completeLines.pop();
      const readyLines = completeLines.filter(line => line.startsWith('DEEP_LOOP_STDIN_READY:'));
      if (readyLines.length > 1 || readyLines.some(line => !readyPattern.test(line))) {
        readyError = new Error(`READY_TOKEN_DRIFT: ${readyLines.join('|')}`);
        child.kill();
        return;
      }
      if (!sent && readyLines.length === 1) {
        sent = true;
        child.stdin.end(`${inputLine}\n`);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (readyError) return reject(readyError);
      const readyLines = stdout.split(/\r?\n/u)
        .filter(line => line.startsWith('DEEP_LOOP_STDIN_READY:'));
      if (readyLines.length !== 1 || !readyPattern.test(readyLines[0])) {
        return reject(new Error(`READY_TOKEN_DRIFT: ${readyLines.join('|')}`));
      }
      if (code !== 0) return reject(new Error(`READY_PROCESS_EXIT_${code}: ${stderr}`));
      if (!sent) return reject(new Error('READY_TOKEN_MISSING'));
      resolve({ json: lastJson(stdout), stdout, stderr });
    });
  });
}

function createDisposableRepo(route) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-e2e-')));
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'deep-loop@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Deep Loop Test']);
  writeFileSync(join(root, 'seed.txt'), 'seed\n');
  execFileSync('git', ['-C', root, 'add', 'seed.txt']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'seed']);
  if (route === 'create') return { root, cwd: root };
  const cwd = join(root, '.claude', 'worktrees', 'app-e2e');
  execFileSync('git', ['-C', root, 'worktree', 'add', '-b', 'app-e2e', cwd]);
  return { root, cwd };
}

export function classifyInitReconciliation(status, processState) {
  if (!status || status.request_match !== true || status.previous_current_match !== true) return 'stop';
  if (processState !== 'exited') return 'stop';
  if (status.outcome === 'committed') return 'success';
  // `raced` authorizes only another bounded read-only status poll, never a full-init retry.
  // It is considered only after the original process handle has proven exit.
  if (status.outcome === 'raced') return 'poll-status';
  if (['pending', 'state-only', 'absent'].includes(status.outcome)) return 'retry-same-binding';
  return 'stop';
}

export async function runAppLifecycle(route, {
  stopAfterPrepare = false,
  stopAfterEmit = false,
  simulatePrepareResultLoss = false,
  hostOptions = {},
  childPublicTools = null,
  ask = async () => true,
  awaitOrder = 'spawn-before-acquire',
  emitSource = 'attended',
} = {}) {
  if (!['create', 'fork'].includes(route)) throw new Error('TEST_ROUTE_INVALID');
  if (!['spawn-before-acquire', 'acquire-before-await'].includes(awaitOrder)) {
    throw new Error('TEST_AWAIT_ORDER_INVALID');
  }
  if (!['attended', 'precompact'].includes(emitSource)) throw new Error('TEST_EMIT_SOURCE_INVALID');
  const { root, cwd } = createDisposableRepo(route);
  // This integration helper owns ordinary Node pipes, not a PTY. The real App smoke is the
  // only card allowed to claim the observed `pty-raw-noecho` adapter.
  const mode = 'pipe-open-noecho';
  const initCanary = 'DEEP_LOOP_INIT_CANARY_71C2';
  const initProbe = await runReadyKernel(root, [
    'host-surface', 'stdin-probe', '--stdin-mode', mode, '--probe-stdin',
  ], initCanary, probeReadyPattern(mode), { cwd });
  assert.deepEqual(initProbe.json, {
    ok: true, mode, byte_length: Buffer.byteLength(initCanary),
    sha256: createHash('sha256').update(initCanary).digest('hex'),
  });
  assert.equal(`${initProbe.stdout}\n${initProbe.stderr}`.includes(initCanary), false);
  const parentObservation = projectObservationFromSkill('deep-loop', {
    publicTools: publicToolsForRoute(route), mode, cwd,
  });
  const capabilities = parentObservation.capabilities;
  const observationLine = JSON.stringify(parentObservation);
  const preflightNonce = '0123456789abcdef0123456789abcdef';
  const preflight = await runReadyKernel(root, [
    'init-run', 'preflight', '--runtime', 'codex', '--preflight-nonce', preflightNonce,
    '--stdin-mode', mode, '--observation-stdin',
  ], observationLine, exactReadyPattern('init-preflight', preflightNonce, mode), { cwd });
  assert.equal(preflight.json.eligible, true);
  let questionCount = 0;
  questionCount += 1;
  const approved = await ask({ route, cwd,
    question: '이 run에서 handoff 시 별도 Codex task를 자동 생성하도록 허용할까요?' });
  if (approved !== true) throw new Error('TEST_APP_CONSENT_NOT_APPROVED');
  const binding = runKernel(root, [
    'init-run', 'prepare', '--runtime', 'codex', '--goal', 'App E2E',
    '--app-continuation', 'auto', '--app-consent-authority', 'human-confirmed',
    '--expected-observation-digest', preflight.json.observation_digest,
  ], { cwd }).json;
  await runReadyKernel(root, [
    'init-run', '--init-attempt', binding.attempt_id,
    '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest,
    '--expected-preflight-digest', binding.expected_observation_digest,
    '--prepared-authority', binding.prepared_authority_json_compact,
    '--stdin-mode', mode, '--app-host-input-stdin', '--app-continuation', 'auto',
    '--app-consent-authority', 'human-confirmed', '--runtime', 'codex', '--goal', 'App E2E',
  ], observationLine, exactReadyPattern('init-commit', [
    binding.attempt_id, binding.previous_current_digest,
    binding.expected_request_digest, binding.expected_observation_digest,
    binding.prepared_authority_digest,
  ].join('.'), mode), { cwd });
  const runId = binding.attempt_id;
  if (route === 'fork') {
    const workstream = runKernel(root, [
      'workstream', 'new', '--title', 'App E2E', '--branch', 'app-e2e',
      '--worktree', '.claude/worktrees/app-e2e', '--request-id', 'app-e2e-workstream',
      '--owner', runId, '--generation', '1', '--run-id', runId,
    ], { cwd }).json;
    runKernel(root, [
      'workstream', 'set', '--id', workstream.id, '--status', 'in_progress',
      '--owner', runId, '--generation', '1', '--run-id', runId,
    ], { cwd });
  }

  const emitted = emitSource === 'precompact'
    ? await runPreCompactHandoff({}, { root, cwdFn: () => cwd,
      now: Date.parse('2026-07-13T00:00:02.000Z') })
    : runKernel(root, [
      'handoff', 'emit', '--run-id', runId, '--reason', 'milestone', '--trigger', 'milestone',
      '--owner', runId, '--generation', '1', '--app-intent',
    ], { cwd }).json;
  assert.equal(emitted.ok, true);
  const emittedSummary = runKernel(root, ['app-task', 'status', '--run-id', runId], { cwd }).json;
  const emittedAttemptId = emittedSummary.current?.attempt_id;
  assert.match(emittedAttemptId, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
  const emittedStatusResult = runKernel(root, [
    'app-task', 'status', '--run-id', runId, '--attempt', emittedAttemptId,
  ], { cwd });
  const emittedStatus = emittedStatusResult.json;
  assert.equal(emittedStatus.logical_run_id, runId);
  assert.equal(emittedStatus.owner_run_id, runId);
  assert.equal(emittedStatus.generation, 1);
  assert.equal(emittedStatus.handoff_phase, 'emitted');
  assert.equal(emittedStatus.current?.attempt_id, emittedAttemptId);
  assert.equal(emittedStatus.current?.run_id, emitted.childRunId);
  assert.equal(emittedStatus.current?.phase, 'emitted');
  assert.equal(emittedStatus.current?.route, route);
  const preActionStatusVerified = true;
  if (stopAfterEmit) return { root, cwd, route, mode, capabilities, parentObservation,
    initProbe, questionCount,
    runId, emitted, emittedAttemptId, emittedStatus, preActionStatusVerified, hostCalls: [] };

  const host = new FakeAppHost({
    projects: [{ projectId: 'PROJECT_CANARY_71C2', projectKind: 'local', path: root }],
    createReceipt: { threadId: 'CREATE_THREAD_CANARY_71C2' },
    forkReceipt: { threadId: 'FORK_THREAD_CANARY_71C2' },
    sendReceipt: {},
    ...hostOptions,
  });
  const projects = route === 'create' ? await host.list_projects() : null;
  const hostInput = JSON.stringify({
    host_task_cwd: cwd,
    ...(projects == null ? {} : { projects }),
  });
  const prepareArgs = [
    'app-task', 'prepare', '--run-id', runId, '--owner', runId, '--generation', '1',
    '--stdin-mode', mode, '--app-host-input-stdin',
  ];
  const firstPrepareResult = await runReadyKernel(root, prepareArgs, hostInput,
    exactReadyPattern('app-prepare', `${runId}.1`, mode), { cwd });
  if (simulatePrepareResultLoss) {
    // Deliberately discard firstPrepareResult without reading any field from it. The emitted
    // attempt is the only durable binding available after the simulated response loss.
    void firstPrepareResult;
    const exactStatus = runKernel(root, [
      'app-task', 'status', '--run-id', runId, '--attempt', emittedAttemptId,
    ], { cwd });
    const lostResultRetry = await runReadyKernel(root, prepareArgs, hostInput,
      exactReadyPattern('app-prepare', `${runId}.1`, mode), { cwd });
    assert.equal(lostResultRetry.json.attempt_id, emittedAttemptId);
    return {
      root, cwd, route, mode, capabilities, parentObservation, initProbe, questionCount,
      runId, emitted, emittedAttemptId, host,
      emittedStatus, preActionStatusVerified, hostInput, prepareArgs,
      preparedStatusAfterLoss: exactStatus.json, preparedStatusOutput: exactStatus.stdout,
      prepared: null, duplicate: lostResultRetry.json, duplicateCheckedBeforeAction: true,
    };
  }
  const prepared = firstPrepareResult;
  if (prepared.json.do_not_call === true) {
    if (!stopAfterPrepare) throw new Error('TEST_MANUAL_PRESERVE_REQUIRES_STOP');
    return {
      root, cwd, route, mode, capabilities, parentObservation, initProbe, questionCount,
      runId, emitted, emittedAttemptId, host,
      emittedStatus, preActionStatusVerified, hostInput, prepareArgs,
      prepared: prepared.json, duplicate: null, duplicateCheckedBeforeAction: false,
    };
  }
  const duplicate = await runReadyKernel(root, prepareArgs, hostInput,
    exactReadyPattern('app-prepare', `${runId}.1`, mode), { cwd });
  assert.equal(duplicate.json.do_not_call, true);
  assert.equal(duplicate.json.attempt_id, prepared.json.attempt_id);
  assert.deepEqual(host.calls.map(call => call.tool), route === 'create' ? ['list_projects'] : []);
  const duplicateCheckedBeforeAction = true;
  if (stopAfterPrepare) {
    return {
      root, cwd, route, mode, capabilities, parentObservation, initProbe, questionCount,
      runId, emitted, emittedAttemptId, host,
      emittedStatus, preActionStatusVerified, hostInput, prepareArgs,
      prepared: prepared.json, duplicate: duplicate.json, duplicateCheckedBeforeAction,
    };
  }
  const receipt = await executePreparedAction(prepared.json.action, host);
  const confirmArgs = [
    'app-task', 'confirm', '--run-id', runId, '--owner', runId, '--generation', '1',
    '--attempt', prepared.json.attempt_id, '--stdin-mode', mode, '--receipt-stdin',
  ];
  const confirmInput = receipt.threadId;
  const confirm = await runReadyKernel(root, confirmArgs, confirmInput,
    exactReadyPattern('app-confirm', prepared.json.attempt_id, mode), { cwd });
  const confirmRetry = await runReadyKernel(root, confirmArgs, confirmInput,
    exactReadyPattern('app-confirm', prepared.json.attempt_id, mode), { cwd });

  const canary = 'DEEP_LOOP_E2E_CANARY_7f4771';
  const probe = await runReadyKernel(root, [
    'host-surface', 'stdin-probe', '--stdin-mode', mode, '--probe-stdin',
  ], canary, probeReadyPattern(mode), { cwd });
  if (`${probe.stdout}\n${probe.stderr}`.includes(canary)) throw new Error('CANARY_ECHOED');
  const appStatusResult = runKernel(root, [
    'app-task', 'status', '--run-id', runId, '--attempt', prepared.json.attempt_id,
  ], { cwd });
  const appStatus = appStatusResult.json;
  const childRunId = emitted.childRunId;
  assert.equal(appStatus.current.run_id, childRunId);
  const awaitArgs = [
    'app-task', 'await', '--run-id', runId, '--owner', runId, '--generation', '1',
    '--attempt', prepared.json.attempt_id,
  ];
  const parentAwaitOperation = awaitOrder === 'spawn-before-acquire'
    ? runAsyncKernel(root, awaitArgs, { cwd })
    : null;
  const childObservation = projectObservationFromSkill('deep-loop-resume', {
    publicTools: childPublicTools ?? publicToolsForRoute(route), mode, cwd,
  });
  const childObservationLine = JSON.stringify(childObservation);
  let acquire;
  let parentAwait;
  try {
    acquire = await runReadyKernel(root, [
      'app-task', 'acquire', '--run-id', runId, '--owner', childRunId, '--generation', '1',
      '--runtime', 'codex', '--attempt', prepared.json.attempt_id,
      '--stdin-mode', mode, '--observation-stdin',
    ], childObservationLine,
    exactReadyPattern('app-acquire', prepared.json.attempt_id, mode), { cwd });
    parentAwait = parentAwaitOperation == null
      ? runKernel(root, awaitArgs, { cwd })
      : await parentAwaitOperation.done;
  } catch (error) {
    parentAwaitOperation?.terminate();
    if (parentAwaitOperation) await Promise.allSettled([parentAwaitOperation.done]);
    throw error;
  }
  const wrongOwnerAwait = runKernelResult(root, [
    'app-task', 'await', '--run-id', runId, '--owner', '01JAPPWR0NG000000000000000',
    '--generation', '1', '--attempt', prepared.json.attempt_id,
  ], { cwd });
  const wrongGenerationAwait = runKernelResult(root, [
    'app-task', 'await', '--run-id', runId, '--owner', runId,
    '--generation', '2', '--attempt', prepared.json.attempt_id,
  ], { cwd });
  const status = runKernel(root, ['state', 'get', '--run-id', runId, '--field', 'status'], { cwd }).json;
  const lease = runKernel(root, ['state', 'get', '--run-id', runId, '--field', 'session_chain.lease'], { cwd }).json;
  return {
    root, cwd, route, mode, capabilities, parentObservation, childObservation,
    initProbe, questionCount, runId,
    awaitOrder, host, status, lease, childRunId, emittedAttemptId,
    emittedStatus, preActionStatusVerified, duplicateCheckedBeforeAction,
    threadId: receipt.threadId,
    projectId: 'PROJECT_CANARY_71C2',
    duplicate: duplicate.json, parentAwait: parentAwait.json,
    wrongOwnerAwait, wrongGenerationAwait,
    postActionOutputs: [confirm.stdout, confirmRetry.stdout, duplicate.stdout,
      appStatusResult.stdout, acquire.stdout, parentAwait.stdout,
      wrongOwnerAwait.stdout, wrongOwnerAwait.stderr,
      wrongGenerationAwait.stdout, wrongGenerationAwait.stderr],
  };
}

test('fake structured process rejects pre-READY writes and records zero echo', () => {
  const process = new FakeStructuredProcess({
    readyToken: 'DEEP_LOOP_STDIN_READY:v1:app-confirm:ATTEMPT:pipe-open-noecho',
    result: { ok: true },
  });
  assert.throws(() => process.writeLine('THREAD\n'), /WRITE_BEFORE_READY/);
  assert.equal(process.start(), 'DEEP_LOOP_STDIN_READY:v1:app-confirm:ATTEMPT:pipe-open-noecho');
  assert.deepEqual(process.writeLine('THREAD\n'), { ok: true });
  assert.deepEqual(process.transcript, [
    'DEEP_LOOP_STDIN_READY:v1:app-confirm:ATTEMPT:pipe-open-noecho',
    '{"ok":true}',
  ]);
  assert.deepEqual(process.echoedInputs, []);
  assert.throws(() => process.writeLine('SECOND\n'), /STRUCTURED_INPUT_ALREADY_CONSUMED/);

  const bounded = new FakeStructuredProcess({ readyToken: 'READY', result: { ok: true },
    maxBytes: 6 });
  assert.equal(bounded.start(), 'READY');
  assert.throws(() => bounded.writeLine('1234567\n'), /STRUCTURED_LINE_TOO_LARGE/);
  assert.throws(() => bounded.writeLine('123456\n'), /STRUCTURED_INPUT_ALREADY_CONSUMED/);
  const boundary = new FakeStructuredProcess({ readyToken: 'READY', result: { ok: true },
    maxBytes: 6 });
  assert.equal(boundary.start(), 'READY');
  assert.deepEqual(boundary.writeLine('123456\n'), { ok: true });
});

test('fake host executes only reviewed create or fork public actions', async () => {
  const createHost = new FakeAppHost({ createReceipt: { threadId: 'CREATE-ID' } });
  assert.deepEqual(await executePreparedAction({
    tool: 'create_thread', target: { type: 'project', projectId: 'PROJECT', environment: { type: 'local' } },
    prompt: 'PROMPT',
  }, createHost), { threadId: 'CREATE-ID' });
  assert.deepEqual(createHost.calls.map(call => call.tool), ['create_thread']);

  const forkHost = new FakeAppHost({ forkReceipt: { threadId: 'FORK-ID' }, sendReceipt: {} });
  assert.deepEqual(await executePreparedAction({
    tool: 'fork_thread', environment: { type: 'same-directory' },
    followup: { tool: 'send_message_to_thread', prompt: 'PROMPT' },
  }, forkHost), { threadId: 'FORK-ID' });
  assert.deepEqual(forkHost.calls.map(call => call.tool), ['fork_thread', 'send_message_to_thread']);
  assert.equal(JSON.stringify(forkHost.calls).includes('model'), false);
  assert.equal(JSON.stringify(forkHost.calls).includes('thinking'), false);
});

test('App lifecycle reaches exact acquired child through root create and worktree fork', async () => {
  for (const route of ['create', 'fork']) {
    const result = await runAppLifecycle(route, { awaitOrder: 'spawn-before-acquire' });
    assert.equal(result.mode, 'pipe-open-noecho', `${route}: pipe harness mode`);
    const initCanary = 'DEEP_LOOP_INIT_CANARY_71C2';
    assert.deepEqual(result.initProbe.json, {
      ok: true, mode: 'pipe-open-noecho', byte_length: Buffer.byteLength(initCanary),
      sha256: createHash('sha256').update(initCanary).digest('hex'),
    }, `${route}: exact production probe receipt`);
    assert.equal(`${result.initProbe.stdout}\n${result.initProbe.stderr}`.includes(initCanary),
      false, `${route}: probe input is not echoed`);
    assert.equal(result.questionCount, 1, `${route}: positive consent is asked exactly once`);
    assert.equal(result.awaitOrder, 'spawn-before-acquire', route);
    assert.equal(result.status, 'running', route);
    assert.equal(result.lease.handoff_phase, 'acquired', route);
    assert.equal(result.lease.owner_run_id, result.childRunId, route);
    const loop = readState(result.root, result.runId).data;
    const parent = loop.session_chain.sessions[0];
    const child = loop.session_chain.sessions.find(session =>
      session.run_id === result.childRunId);
    assert.equal(parent.host_surface.observed_generation, 1, `${route}: genesis attestation`);
    assert.equal(child.host_surface.observed_generation, 2, `${route}: child attestation`);
    assert.equal(child.host_surface.observed_generation, result.lease.generation,
      `${route}: exact current authority`);
    assert.equal(child.continuation.acquired_generation, result.lease.generation,
      `${route}: acquire provenance`);
    assert.equal(result.duplicate.do_not_call, true, route);
    assert.equal(result.duplicateCheckedBeforeAction, true, route);
    assert.equal(result.preActionStatusVerified, true, route);
    assert.equal(result.parentAwait.ok, true, route);
    assert.equal(result.postActionOutputs.some(output => output.includes(result.threadId)), false, route);
    assert.equal(result.postActionOutputs.some(output => output.includes(result.projectId)), false, route);
    assert.equal(JSON.stringify(result.host.calls).includes('model'), false, route);
    assert.equal(JSON.stringify(result.host.calls).includes('thinking'), false, route);
    assert.deepEqual(result.host.calls.map(call => call.tool), route === 'create'
      ? ['list_projects', 'create_thread']
      : ['fork_thread', 'send_message_to_thread']);
  }
});

test('App lifecycle await accepts an exact child acquired before invocation and fences drift', async () => {
  const result = await runAppLifecycle('create', { awaitOrder: 'acquire-before-await' });
  assert.equal(result.awaitOrder, 'acquire-before-await');
  assert.equal(result.parentAwait.ok, true);
  assert.equal(result.wrongOwnerAwait.status, 3);
  assert.equal(result.wrongGenerationAwait.status, 3);
  assert.equal(result.postActionOutputs.some(output => output.includes(result.threadId)), false);
  assert.equal(result.postActionOutputs.some(output => output.includes(result.projectId)), false);
});

test('child acquire projects current tools from the resume skill instead of inheriting parent capabilities', async () => {
  const result = await runAppLifecycle('create', { childPublicTools: ['structured_input'] });
  assert.deepEqual(result.parentObservation.capabilities, [
    'create-thread-local', 'list-projects', 'structured-process-stdin',
  ]);
  assert.deepEqual(result.childObservation.capabilities, ['structured-process-stdin']);
  assert.deepEqual(Object.keys(result.parentObservation), APP_OBSERVATION_KEYS);
  assert.deepEqual(Object.keys(result.childObservation), APP_OBSERVATION_KEYS);
  const child = readState(result.root, result.runId).data.session_chain.sessions
    .find(session => session.run_id === result.childRunId);
  assert.deepEqual(child.host_surface.capabilities, ['structured-process-stdin']);
  assert.equal(child.host_surface.observed_generation, 2);
  assert.equal(child.host_surface.observed_generation, child.continuation.acquired_generation);
});

test('generic same-owner reacquire requires current-generation re-attestation before App emit',
  async () => {
    const result = await runAppLifecycle('create');
    const released = runKernel(result.root, [
      'lease', 'release', '--run-id', result.runId, '--owner', result.childRunId,
      '--generation', '2',
    ], { cwd: result.cwd }).json;
    assert.equal(released.reason, 'released');
    const reacquired = runKernel(result.root, [
      'lease', 'acquire', '--run-id', result.runId, '--owner', result.childRunId,
      '--generation', '3', '--expect-generation', '2', '--runtime', 'codex',
    ], { cwd: result.cwd }).json;
    assert.deepEqual(reacquired, { ok: true, generation: 3, reason: 'acquired' });
    let loop = readState(result.root, result.runId).data;
    let child = loop.session_chain.sessions.find(session => session.run_id === result.childRunId);
    assert.equal(loop.session_chain.lease.generation, 3);
    assert.equal(child.host_surface.observed_generation, 2);
    const staleBefore = snapshotDurableArtifacts(result.root, result.runId);
    const fenced = runKernelResult(result.root, [
      'handoff', 'emit', '--run-id', result.runId, '--reason', 'stale-attestation',
      '--trigger', 'stale-attestation', '--owner', result.childRunId,
      '--generation', '3', '--app-intent',
    ], { cwd: result.cwd });
    assert.equal(fenced.status, 3, fenced.stderr);
    assert.deepEqual(snapshotDurableArtifacts(result.root, result.runId), staleBefore);

    const raw = JSON.stringify(result.childObservation);
    const reattested = await runReadyKernel(result.root, [
      'host-surface', 'observe', '--run-id', result.runId, '--owner', result.childRunId,
      '--generation', '3', '--runtime', 'codex', '--stdin-mode', result.mode,
      '--observation-stdin',
    ], raw, exactReadyPattern('host-observe', `${result.childRunId}.3`, result.mode),
    { cwd: result.cwd });
    assert.equal(reattested.json.outcome, 'reattested');
    loop = readState(result.root, result.runId).data;
    child = loop.session_chain.sessions.find(session => session.run_id === result.childRunId);
    assert.equal(child.host_surface.observed_generation, 3);
    const currentBefore = snapshotDurableArtifacts(result.root, result.runId);
    const exactRetry = await runReadyKernel(result.root, [
      'host-surface', 'observe', '--run-id', result.runId, '--owner', result.childRunId,
      '--generation', '3', '--runtime', 'codex', '--stdin-mode', result.mode,
      '--observation-stdin',
    ], raw, exactReadyPattern('host-observe', `${result.childRunId}.3`, result.mode),
    { cwd: result.cwd });
    assert.equal(exactRetry.json.outcome, 'already-observed');
    assert.deepEqual(snapshotDurableArtifacts(result.root, result.runId), currentBefore);
    const emitted = runKernel(result.root, [
      'handoff', 'emit', '--run-id', result.runId, '--reason', 'current-attestation',
      '--trigger', 'current-attestation', '--owner', result.childRunId,
      '--generation', '3', '--app-intent',
    ], { cwd: result.cwd }).json;
    assert.equal(emitted.ok, true);
    assert.equal(readState(result.root, result.runId).data
      .session_chain.lease.handoff_transport, 'codex-app');
  });

test('fixed-init response-loss matrix never changes attempt or retries a live process', () => {
  const matched = { request_match: true, previous_current_match: true };
  assert.equal(classifyInitReconciliation({ outcome: 'committed', ...matched }, 'exited'), 'success');
  for (const outcome of ['pending', 'state-only', 'absent']) {
    assert.equal(classifyInitReconciliation({ outcome, ...matched }, 'exited'), 'retry-same-binding');
  }
  assert.equal(classifyInitReconciliation({ outcome: 'raced', ...matched }, 'exited'),
    'poll-status');
  for (const processState of ['alive', 'unknown']) {
    for (const outcome of ['committed', 'raced', 'pending', 'state-only', 'absent']) {
      assert.equal(classifyInitReconciliation({ outcome, ...matched }, processState),
        'stop', `${outcome}/${processState}: original process must exit first`);
    }
  }
  for (const outcome of ['indeterminate', 'conflict']) {
    assert.equal(classifyInitReconciliation({ outcome, ...matched }, 'exited'), 'stop');
  }
  assert.equal(classifyInitReconciliation({ outcome: 'committed', request_match: false, previous_current_match: true }, 'exited'), 'stop');
});
