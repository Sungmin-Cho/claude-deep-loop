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
import { normalizeHostObservation } from '../scripts/lib/host-surface.mjs';
import {
  boundedRootPrepareInput,
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

function processOutputs(...results) {
  return results.flatMap(result => [result?.stdout ?? '', result?.stderr ?? '']);
}

async function captureRejection(thunk, pattern) {
  try {
    await thunk();
  } catch (error) {
    assert.match(String(error?.message ?? error), pattern);
    return error;
  }
  assert.fail(`EXPECTED_REJECTION:${pattern}`);
}

function runKernel(root, args, { cwd = root, env = process.env } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    cwd, encoding: 'utf8', env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`KERNEL_EXIT_${result.status}: ${result.stderr}`);
  }
  return { json: lastJson(result.stdout), stdout: result.stdout, stderr: result.stderr };
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
      if (code !== 0) {
        const error = new Error(`READY_PROCESS_EXIT_${code}: ${stderr}`);
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
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
      now: Date.now() - 1_000 })
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

  const { projectsFor = null, ...resolvedHostOptions } = hostOptions;
  if (projectsFor != null && typeof projectsFor !== 'function') {
    throw new Error('TEST_PROJECTS_FOR_INVALID');
  }
  const host = new FakeAppHost({
    projects: projectsFor == null
      ? [{ projectId: 'PROJECT_CANARY_71C2', projectKind: 'local', path: root }]
      : projectsFor({ root, cwd }),
    createReceipt: { threadId: 'CREATE_THREAD_CANARY_71C2' },
    forkReceipt: { threadId: 'FORK_THREAD_CANARY_71C2' },
    sendReceipt: {},
    ...resolvedHostOptions,
  });
  const discovery = route === 'create'
    ? await boundedRootPrepareInput(host, cwd, { timeoutMs: 25 })
    : { discoveryAvailable: true, line: JSON.stringify({ host_task_cwd: cwd }) };
  const hostInput = discovery.line;
  const prepareArgs = [
    'app-task', 'prepare', '--run-id', runId, '--owner', runId, '--generation', '1',
    '--stdin-mode', mode, '--app-host-input-stdin',
  ];
  const firstPrepareResult = await runReadyKernel(root, prepareArgs, hostInput,
    exactReadyPattern('app-prepare', `${runId}.1`, mode), { cwd });
  if (simulatePrepareResultLoss) {
    // The execution-plane decision below uses only durable status. Retain the captured streams
    // solely for the test's post-hoc leak audit; they are not result authority.
    const exactStatus = runKernel(root, [
      'app-task', 'status', '--run-id', runId, '--attempt', emittedAttemptId,
    ], { cwd });
    const exactCurrent = exactStatus.json.current;
    const lossLoop = readState(root, runId).data;
    const lossContinuation = lossLoop.session_chain.sessions.find(session =>
      session.continuation?.attempt_id === emittedAttemptId)?.continuation;
    const liveDeadline = exactCurrent?.phase === 'emitted'
      ? lossContinuation?.prepare_deadline : lossContinuation?.confirmation_deadline;
    const decisionAnchor = exactCurrent?.phase === 'emitted'
      ? lossContinuation?.emitted_at : lossContinuation?.prepared_at;
    const decisionNow = Date.parse(decisionAnchor) + 1;
    const retryEligible = exactStatus.json.logical_run_id === runId
      && exactStatus.json.owner_run_id === runId
      && exactStatus.json.generation === 1
      && exactStatus.json.handoff_phase === (exactCurrent?.phase === 'emitted' ? 'emitted' : 'spawned')
      && exactStatus.json.manual_recovery === false
      && exactCurrent?.attempt_id === emittedAttemptId
      && ['emitted', 'prepared'].includes(exactCurrent?.phase)
      && Number.isFinite(decisionNow)
      && Number.isFinite(Date.parse(liveDeadline))
      && decisionNow <= Date.parse(liveDeadline);
    assert.equal(retryEligible, true);
    const lostResultRetry = await runReadyKernel(root, prepareArgs, hostInput,
      exactReadyPattern('app-prepare', `${runId}.1`, mode), { cwd });
    assert.equal(lostResultRetry.json.attempt_id, emittedAttemptId);
    return {
      root, cwd, route, mode, capabilities, parentObservation, initProbe, questionCount,
      runId, emitted, emittedAttemptId, host,
      emittedStatus, preActionStatusVerified, discovery, hostInput, prepareArgs,
      preparedStatusAfterLoss: exactStatus.json,
      preparedStatusOutput: processOutputs(exactStatus).join('\n'),
      // Actionable prepare stdout intentionally carries the reviewed project ID; stderr must not.
      lostPrepareStderrAudit: firstPrepareResult.stderr,
      prepared: null, duplicate: lostResultRetry.json, duplicateCheckedBeforeAction: true,
    };
  }
  const prepared = firstPrepareResult;
  if (prepared.json.do_not_call === true) {
    if (!stopAfterPrepare) throw new Error('TEST_MANUAL_PRESERVE_REQUIRES_STOP');
    return {
      root, cwd, route, mode, capabilities, parentObservation, initProbe, questionCount,
      runId, emitted, emittedAttemptId, host,
      emittedStatus, preActionStatusVerified, discovery, hostInput, prepareArgs,
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
      emittedStatus, preActionStatusVerified, discovery, hostInput, prepareArgs,
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
    awaitOrder, host, discovery, status, lease, childRunId, emittedAttemptId,
    emittedStatus, preActionStatusVerified, duplicateCheckedBeforeAction,
    threadId: receipt.threadId,
    projectId: 'PROJECT_CANARY_71C2',
    duplicate: duplicate.json, parentAwait: parentAwait.json,
    wrongOwnerAwait, wrongGenerationAwait,
    postActionOutputs: processOutputs(confirm, confirmRetry, duplicate,
      appStatusResult, acquire, parentAwait, wrongOwnerAwait, wrongGenerationAwait),
  };
}

function stopReadyKernelBeforeInput(root, args, readyPattern, {
  cwd = root,
  timeoutMs = 5_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root], {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sawReady = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!sawReady && stdout.split(/\r?\n/u).some(line => readyPattern.test(line))) {
        sawReady = true;
        child.kill();
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`READY_PROCESS_TIMEOUT: ${stderr}`));
      if (!sawReady) return reject(new Error(`READY_TOKEN_MISSING: ${stderr}`));
      const error = new Error('SIMULATED_CONFIRM_PROCESS_LOSS_BEFORE_COMMIT');
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function startLostResultKernel(root, args, {
  cwd = root, inputLine = null, readyPattern = null, timeoutMs = 5_000,
} = {}) {
  if ((readyPattern === null) !== (inputLine === null)) {
    throw new Error('LOST_RESULT_READY_INPUT_PAIR_INVALID');
  }
  const child = spawn(process.execPath, [CLI, ...args, '--project-root', root], {
    cwd, env: process.env, stdio: [readyPattern ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let processState = 'alive';
  let pollCount = 0;
  let sent = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      reject(new Error('LOST_RESULT_PROCESS_TIMEOUT'));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (readyPattern && !sent) {
        const readyLines = stdout.split(/\r?\n/u)
          .filter(line => line.startsWith('DEEP_LOOP_STDIN_READY:'));
        if (readyLines.length === 1 && readyPattern.test(readyLines[0])) {
          sent = true;
          child.stdin.end(`${inputLine}\n`);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      processState = 'exited';
      if (readyPattern && !sent) return reject(new Error(`LOST_RESULT_READY_MISSING: ${stderr}`));
      if (code !== 0) return reject(new Error(`LOST_RESULT_EXIT_${code}: ${stderr}`));
      // Suppress stdout/result deliberately: callers may only reconcile after this exact handle exits.
      resolve();
    });
  });
  return { done, pid: child.pid,
    poll: () => { pollCount += 1; return processState; },
    pollCount: () => pollCount,
    output: () => ({ stdout, stderr }),
    terminate: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    } };
}

async function initializeFromExecutionPlaneDecision({ exactReady, capabilities, process, ask }) {
  const complete = ['list-projects', 'create-thread-local', 'structured-process-stdin']
    .every(capability => capabilities.includes(capability));
  let probeOk = false;
  if (complete && process !== null) {
    const ready = process.start();
    if (ready === exactReady) {
      const probeInput = '{"probe":"bounded-canary"}';
      const result = process.writeLine(`${probeInput}\n`);
      const expected = { ok: true, mode: 'pipe-open-noecho',
        byte_length: Buffer.byteLength(probeInput, 'utf8'),
        sha256: createHash('sha256').update(probeInput).digest('hex') };
      probeOk = result !== null && typeof result === 'object'
        && Object.keys(result).sort().join(',') === Object.keys(expected).sort().join(',')
        && Object.entries(expected).every(([key, value]) => result[key] === value)
        && process.echoedInputs.length === 0;
    }
  }
  if (!probeOk) {
    return { fixture: initializeManualRun(
      capabilities.filter(value => value !== 'structured-process-stdin')),
    questionCount: 0 };
  }
  return initializeObservedManualRun({ ask });
}

async function initializeObservedManualRun({ ask = async () => false } = {}) {
  const { root, cwd } = createDisposableRepo('create');
  const mode = 'pipe-open-noecho';
  const observation = projectObservationFromSkill('deep-loop', {
    publicTools: publicToolsForRoute('create'), mode, cwd,
  });
  const observationLine = JSON.stringify(observation);
  const preflightNonce = 'fedcba9876543210fedcba9876543210';
  const preflight = await runReadyKernel(root, [
    'init-run', 'preflight', '--runtime', 'codex', '--preflight-nonce', preflightNonce,
    '--stdin-mode', mode, '--observation-stdin',
  ], observationLine, exactReadyPattern('init-preflight', preflightNonce, mode), { cwd });
  let questionCount = 0;
  let approved = false;
  if (preflight.json.eligible === true) {
    questionCount += 1;
    approved = await ask() === true;
  }
  if (approved) throw new Error('TEST_AUTO_DECISION_REQUIRES_AUTO_INITIALIZER');
  const prepared = runKernel(root, [
    'init-run', 'prepare', '--runtime', 'codex', '--goal', 'App declined fixture',
    '--app-continuation', 'manual', '--app-consent-authority', 'default-manual',
    '--expected-observation-digest', preflight.json.observation_digest,
  ], { cwd }).json;
  await runReadyKernel(root, [
    'init-run', '--init-attempt', prepared.attempt_id,
    '--expected-current-digest', prepared.previous_current_digest,
    '--expected-request-digest', prepared.expected_request_digest,
    '--expected-preflight-digest', prepared.expected_observation_digest,
    '--prepared-authority', prepared.prepared_authority_json_compact,
    '--stdin-mode', mode, '--app-host-input-stdin', '--app-continuation', 'manual',
    '--app-consent-authority', 'default-manual', '--runtime', 'codex',
    '--goal', 'App declined fixture',
  ], observationLine, exactReadyPattern('init-commit', [
    prepared.attempt_id, prepared.previous_current_digest,
    prepared.expected_request_digest, prepared.expected_observation_digest,
    prepared.prepared_authority_digest,
  ].join('.'), mode), { cwd });
  const consent = runKernel(root, [
    'state', 'get', '--run-id', prepared.attempt_id,
    '--field', 'autonomy.app_task_continuation',
  ], { cwd }).json;
  const sessions = runKernel(root, [
    'state', 'get', '--run-id', prepared.attempt_id, '--field', 'session_chain.sessions',
  ], { cwd }).json;
  const appStatus = runKernel(root, [
    'app-task', 'status', '--run-id', prepared.attempt_id,
  ], { cwd }).json;
  return { fixture: {
    root, cwd, runId: prepared.attempt_id, consent, appStatus,
    parentSurface: sessions[0].host_surface,
    preflightEligible: preflight.json.eligible,
  }, questionCount };
}

function initializeManualRun(capabilities, {
  runtime = 'codex',
  hostSurface = 'codex-app',
  hostSource = 'codex-app-tool-provenance',
} = {}) {
  const { root, cwd } = createDisposableRepo('create');
  const surfaceSourceBothNull = hostSurface === null && hostSource === null;
  const surfaceSourceBothStrings = typeof hostSurface === 'string' && typeof hostSource === 'string';
  if (!surfaceSourceBothNull && !surfaceSourceBothStrings) {
    throw new Error('TEST_MANUAL_SURFACE_SOURCE_PAIR_INVALID');
  }
  const common = [
    '--manual-enums', '--runtime', runtime, '--goal', 'App manual fixture',
    ...(surfaceSourceBothNull ? [] : ['--host-surface', hostSurface, '--host-source', hostSource]),
    ...(capabilities.length === 0 ? [] : ['--capabilities', capabilities.join(',')]),
    '--app-continuation', 'manual',
    '--app-consent-authority', 'default-manual',
  ];
  const prepared = runKernel(root, [
    'init-run', 'prepare', ...common, '--expected-observation-digest', 'NONE',
  ], { cwd }).json;
  runKernel(root, [
    'init-run', '--init-attempt', prepared.attempt_id,
    '--expected-current-digest', prepared.previous_current_digest,
    '--expected-request-digest', prepared.expected_request_digest,
    '--expected-preflight-digest', 'NONE',
    '--prepared-authority', prepared.prepared_authority_json_compact, ...common,
  ], { cwd });
  const consent = runKernel(root, [
    'state', 'get', '--run-id', prepared.attempt_id,
    '--field', 'autonomy.app_task_continuation',
  ], { cwd }).json;
  const appStatus = runKernel(root, [
    'app-task', 'status', '--run-id', prepared.attempt_id,
  ], { cwd }).json;
  const sessions = runKernel(root, [
    'state', 'get', '--run-id', prepared.attempt_id, '--field', 'session_chain.sessions',
  ], { cwd }).json;
  return { root, cwd, runId: prepared.attempt_id, consent, appStatus,
    parentSurface: sessions[0].host_surface };
}

async function settlePreparedFailure(fixture, code, receipt) {
  if ((code === 'message-unconfirmed') !== (typeof receipt === 'string')) {
    throw new Error('TEST_FAILURE_RECEIPT_SHAPE_INVALID');
  }
  const common = [
    'app-task', 'fail', '--run-id', fixture.runId, '--owner', fixture.runId,
    '--generation', '1', '--attempt', fixture.prepared.attempt_id, '--code', code,
  ];
  const transition = code === 'message-unconfirmed'
    ? await runReadyKernel(fixture.root,
      [...common, '--stdin-mode', fixture.mode, '--receipt-stdin'], receipt,
      exactReadyPattern('app-fail', fixture.prepared.attempt_id, fixture.mode),
      { cwd: fixture.cwd })
    : runKernel(fixture.root, common, { cwd: fixture.cwd });
  const app = runKernel(fixture.root, [
    'app-task', 'status', '--run-id', fixture.runId,
    '--attempt', fixture.prepared.attempt_id,
  ], { cwd: fixture.cwd });
  const runStatus = runKernel(fixture.root, [
    'state', 'get', '--run-id', fixture.runId, '--field', 'status',
  ], { cwd: fixture.cwd });
  const lease = runKernel(fixture.root, [
    'state', 'get', '--run-id', fixture.runId, '--field', 'session_chain.lease',
  ], { cwd: fixture.cwd });
  return {
    appStatus: app.json, runStatus: runStatus.json, lease: lease.json,
    outputs: processOutputs(transition, app, runStatus, lease),
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

test('documented denial partial capability READY and echo paths persist manual state with zero task calls', async () => {
  const skill = readFileSync(join(HERE, '..', 'skills', 'deep-loop', 'SKILL.md'), 'utf8');
  const question = '이 run에서 handoff 시 별도 Codex task를 자동 생성하도록 허용할까요?';
  assert.equal(skill.split(question).length - 1, 1, 'eligible run asks exactly once');
  assert.match(skill, /partial capability, cwd ambiguity, probe failure, READY mismatch, echo, closed stdin은 질문 없이[^\n]*manual\/default-manual/);

  const exactReady = 'DEEP_LOOP_STDIN_READY:v1:stdin-probe:0123456789abcdef0123456789abcdef:pipe-open-noecho';
  const probeInput = '{"probe":"bounded-canary"}';
  const exactProbeReceipt = { ok: true, mode: 'pipe-open-noecho',
    byte_length: Buffer.byteLength(probeInput, 'utf8'),
    sha256: createHash('sha256').update(probeInput).digest('hex') };
  const rows = [
    { name: 'declined', expectedQuestions: 1,
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      process: new FakeStructuredProcess({ readyToken: exactReady, result: exactProbeReceipt }) },
    { name: 'partial', expectedQuestions: 0, capabilities: ['list-projects'], process: null },
    { name: 'wrong-ready', expectedQuestions: 0,
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      process: new FakeStructuredProcess({ readyToken: `${exactReady}-WRONG`, result: exactProbeReceipt }) },
    { name: 'echo', expectedQuestions: 0,
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      process: new FakeStructuredProcess({ readyToken: exactReady, result: exactProbeReceipt,
        echoInput: true }) },
  ];
  for (const row of rows) {
    const decision = await initializeFromExecutionPlaneDecision({
      exactReady, capabilities: row.capabilities, process: row.process,
      ask: async () => false,
    });
    const fixture = decision.fixture;
    const attempted = runKernelResult(fixture.root, [
      'handoff', 'emit', '--run-id', fixture.runId, '--reason', 'milestone', '--trigger', 'milestone',
      '--owner', fixture.runId, '--generation', '1', '--app-intent',
    ], { cwd: fixture.cwd });
    assert.equal(attempted.status, 3, row.name);
    const attemptedOutput = `${attempted.stdout}\n${attempted.stderr}`;
    assert.doesNotMatch(attemptedOutput,
      /"action"|create_thread|fork_thread|send_message_to_thread/, row.name);
    assert.equal((attemptedOutput.match(/"action"/gu) ?? []).length, 0, row.name);
    assert.equal(fixture.consent.mode, 'manual', row.name);
    assert.equal(fixture.consent.authority, 'default-manual', row.name);
    assert.equal(fixture.appStatus.has_app_history, false, row.name);
    assert.equal(fixture.appStatus.current, null, row.name);
    assert.equal(decision.questionCount, row.expectedQuestions, row.name);
    if (row.name === 'declined') {
      assert.equal(fixture.preflightEligible, true);
      assert.equal(fixture.parentSurface.kind, 'codex-app');
      assert.equal(fixture.parentSurface.structured_stdin_mode, 'pipe-open-noecho');
      assert.deepEqual(fixture.parentSurface.capabilities, [
        'create-thread-local', 'list-projects', 'structured-process-stdin',
      ]);
    }
  }
});

test('ambiguous project uses one discovery call then durable manual preserve with zero task calls', async () => {
  const fixture = await runAppLifecycle('create', { stopAfterPrepare: true, hostOptions: {
    projectsFor: ({ root }) => [
      { projectId: ' RAW-PROJECT-ONE ', projectKind: 'local', path: root },
      { projectId: ' RAW-PROJECT-TWO ', projectKind: 'local', path: root },
    ],
  } });
  const runStatus = runKernel(fixture.root, [
    'state', 'get', '--run-id', fixture.runId, '--field', 'status',
  ], { cwd: fixture.cwd });
  const lease = runKernel(fixture.root, [
    'state', 'get', '--run-id', fixture.runId, '--field', 'session_chain.lease',
  ], { cwd: fixture.cwd });
  const app = runKernel(fixture.root, [
    'app-task', 'status', '--run-id', fixture.runId, '--attempt', fixture.prepared.attempt_id,
  ], { cwd: fixture.cwd });
  assert.equal(fixture.prepared.do_not_call, true);
  assert.equal(fixture.prepared.outcome, 'manual-preserve');
  assert.equal(fixture.duplicate, null);
  assert.equal(fixture.duplicateCheckedBeforeAction, false);
  assert.equal(fixture.discovery.discoveryAvailable, true);
  assert.deepEqual(fixture.host.calls.map(call => call.tool), ['list_projects']);
  assert.equal(runStatus.json, 'paused');
  assert.equal(lease.json.resume_policy, 'human');
  assert.equal(app.json.current.phase, 'emitted');
  for (const raw of [' RAW-PROJECT-ONE ', ' RAW-PROJECT-TWO ']) {
    assert.equal(processOutputs(runStatus, lease, app)
      .some(output => output.includes(raw)), false);
  }
});

test('current Codex App v1 list_projects envelope is projected for root prepare', async () => {
  const root = '/repo/current-app-envelope';
  const envelope = {
    schemaVersion: 1,
    projects: [{
      projectId: 'PROJECT-CURRENT-APP',
      projectKind: 'local',
      path: root,
      label: 'current-app-envelope',
      hostId: 'local',
      hostDisplayName: 'Local',
    }],
  };
  const host = new FakeAppHost({
    listProjectsReceipt: JSON.stringify(envelope),
  });

  const discovery = await boundedRootPrepareInput(host, root, { timeoutMs: 25 });

  assert.equal(discovery.discoveryAvailable, true);
  assert.deepEqual(JSON.parse(discovery.line), {
    host_task_cwd: root,
    projects: [{
      projectId: 'PROJECT-CURRENT-APP',
      projectKind: 'local',
      path: root,
    }],
  });
  assert.deepEqual(host.calls.map(call => call.tool), ['list_projects']);
});

test('current App wire receipts decode one canonical JSON layer before strict validation', async () => {
  const root = '/repo/current-app-wire';
  const envelope = { schemaVersion: 1, projects: [{
    projectId: 'PROJECT-CURRENT-WIRE', projectKind: 'local', path: root,
  }] };
  for (const listProjectsReceipt of [envelope, JSON.stringify(envelope)]) {
    const discovery = await boundedRootPrepareInput(
      new FakeAppHost({ listProjectsReceipt }), root, { timeoutMs: 25 });
    assert.equal(discovery.discoveryAvailable, true);
    assert.equal(JSON.parse(discovery.line).projects[0].projectId, 'PROJECT-CURRENT-WIRE');
  }

  const createAction = { tool: 'create_thread', target: {
    type: 'project', projectId: 'PROJECT', environment: { type: 'local' },
  }, prompt: 'PROMPT' };
  assert.deepEqual(await executePreparedAction(createAction, new FakeAppHost({
    createReceipt: JSON.stringify({ threadId: 'CREATE-WIRE' }),
  })), { threadId: 'CREATE-WIRE' });

  const forkAction = { tool: 'fork_thread', environment: { type: 'same-directory' },
    followup: { tool: 'send_message_to_thread', prompt: 'PROMPT' } };
  assert.deepEqual(await executePreparedAction(forkAction, new FakeAppHost({
    forkReceipt: JSON.stringify({ threadId: 'FORK-WIRE' }),
    sendReceipt: JSON.stringify({ threadId: 'FORK-WIRE' }),
  })), { threadId: 'FORK-WIRE' });
  assert.deepEqual(await executePreparedAction(forkAction, new FakeAppHost({
    forkReceipt: JSON.stringify({ threadId: 'FORK-WIRE' }),
    sendReceipt: 'null',
  })), { threadId: 'FORK-WIRE' });

  for (const listProjectsReceipt of [
    ` ${JSON.stringify(envelope)}`,
    `${JSON.stringify(envelope)}\n`,
    JSON.stringify(JSON.stringify(envelope)),
    '{"schemaVersion":1,"projects":',
    `\ufeff${JSON.stringify(envelope)}`,
    JSON.stringify({ schemaVersion: 1, projects: [{
      projectId: 'PROJECT', projectKind: 'local', path: 'x'.repeat(1_048_576),
    }] }),
  ]) {
    const discovery = await boundedRootPrepareInput(
      new FakeAppHost({ listProjectsReceipt }), root, { timeoutMs: 25 });
    assert.equal(discovery.discoveryAvailable, false);
  }
  for (const createReceipt of [
    ` ${JSON.stringify({ threadId: 'CREATE-WIRE' })}`,
    JSON.stringify(JSON.stringify({ threadId: 'CREATE-WIRE' })),
    '{"threadId":"CREATE-WIRE"',
    JSON.stringify({ threadId: 'x'.repeat(1_048_576) }),
  ]) {
    await assert.rejects(() => executePreparedAction(createAction,
      new FakeAppHost({ createReceipt })), /CREATE_RECEIPT_INVALID/);
  }
  for (const forkReceipt of [
    ` ${JSON.stringify({ threadId: 'FORK-WIRE' })}`,
    JSON.stringify(JSON.stringify({ threadId: 'FORK-WIRE' })),
  ]) {
    await assert.rejects(() => executePreparedAction(forkAction, new FakeAppHost({
      forkReceipt,
    })), /FORK_RECEIPT_INVALID/);
  }
  for (const sendReceipt of [
    ` ${JSON.stringify({ threadId: 'FORK-WIRE' })}`,
    JSON.stringify(JSON.stringify({ threadId: 'FORK-WIRE' })),
  ]) {
    await assert.rejects(() => executePreparedAction(forkAction, new FakeAppHost({
      forkReceipt: JSON.stringify({ threadId: 'FORK-WIRE' }), sendReceipt,
    })), /SEND_RECEIPT_MISMATCH/);
  }
});

test('project discovery rejects hostile array and row descriptors before projection', async () => {
  const root = '/repo/hostile-project-envelope';
  const goodRow = { projectId: 'PROJECT', projectKind: 'local', path: root };
  const customArray = [goodRow];
  Object.setPrototypeOf(customArray, { custom: true });
  const sparseArray = new Array(1);
  const accessorArray = [];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true, configurable: true, get: () => goodRow,
  });
  Object.defineProperty(accessorArray, 'length', { value: 1, writable: true });
  const symbolArray = [goodRow];
  symbolArray[Symbol('project')] = goodRow;
  const customRow = Object.create({ inherited: true });
  Object.assign(customRow, goodRow);
  const accessorRow = { projectKind: 'local', path: root };
  Object.defineProperty(accessorRow, 'projectId', {
    enumerable: true, get: () => 'PROJECT',
  });
  for (const projects of [customArray, sparseArray, accessorArray, symbolArray,
    [customRow], [accessorRow]]) {
    const discovery = await boundedRootPrepareInput(new FakeAppHost({
      listProjectsReceipt: { schemaVersion: 1, projects },
    }), root, { timeoutMs: 25 });
    assert.equal(discovery.discoveryAvailable, false);
  }
});

test('handoff protocol binds discovery to the current strict v1 App envelope', () => {
  const protocol = readFileSync(join(HERE, '..', 'skills', 'deep-loop-workflow',
    'references', 'handoff-respawn.md'), 'utf8');
  assert.match(protocol,
    /canonical JSON wire text[\s\S]{0,300}exactly one layer[\s\S]{0,500}`schemaVersion === 1`/u);
  assert.match(protocol, /bare array[\s\S]{0,180}discovery unavailable/u);
});

test('discovery failure is bounded into one emitted manual-preserve prepare with zero task calls', async () => {
  const rows = [
    ['throw', { behaviors: { list_projects: 'throw' } }],
    ['timeout', { behaviors: { list_projects: 'timeout' } }],
    ['no-return', { behaviors: { list_projects: 'no-return' } }],
    ['legacy-bare-array', { listProjectsReceipt: [] }],
    ['unsupported-schema', { listProjectsReceipt: { schemaVersion: 2, projects: [] } }],
    ['extra-envelope-key', {
      listProjectsReceipt: { schemaVersion: 1, projects: [], ignored: true },
    }],
    ['malformed', { projects: { projectId: 'NOT-AN-ARRAY' } }],
    ['too-many', { projects: Array.from({ length: 257 }, (_, index) => ({
      projectId: `P-${index}`, projectKind: 'local', path: `/repo/${index}`,
    })) }],
    ['too-large', { projects: [{ projectId: 'P', projectKind: 'local',
      path: `/${'x'.repeat(32_768)}` }] }],
  ];
  for (const [name, hostOptions] of rows) {
    const fixture = await runAppLifecycle('create', { stopAfterPrepare: true, hostOptions });
    assert.equal(fixture.discovery.discoveryAvailable, false, name);
    assert.equal(fixture.prepared.outcome, 'manual-preserve', name);
    assert.equal(fixture.prepared.do_not_call, true, name);
    assert.equal(fixture.duplicate, null, name);
    assert.equal(fixture.duplicateCheckedBeforeAction, false, name);
    assert.deepEqual(fixture.host.calls.map(call => call.tool), ['list_projects'], name);
    const app = runKernel(fixture.root, [
      'app-task', 'status', '--run-id', fixture.runId, '--attempt', fixture.prepared.attempt_id,
    ], { cwd: fixture.cwd }).json;
    const status = runKernel(fixture.root, [
      'state', 'get', '--run-id', fixture.runId, '--field', 'status',
    ], { cwd: fixture.cwd }).json;
    const lease = runKernel(fixture.root, [
      'state', 'get', '--run-id', fixture.runId, '--field', 'session_chain.lease',
    ], { cwd: fixture.cwd }).json;
    assert.equal(app.current.phase, 'emitted', name);
    assert.equal(status, 'paused', name);
    assert.equal(lease.resume_policy, 'human', name);
  }
});

test('PreCompact-first emit is taken over once by an attended tick or swept with no task call', async () => {
  const takeover = await runAppLifecycle('create', {
    emitSource: 'precompact', stopAfterPrepare: true,
  });
  assert.equal(takeover.prepared.attempt_id, takeover.emittedAttemptId);
  assert.equal(takeover.prepared.do_not_call, false);
  assert.equal(takeover.duplicate.do_not_call, true);
  assert.equal(takeover.duplicateCheckedBeforeAction, true);
  assert.deepEqual(takeover.host.calls.map(call => call.tool), ['list_projects']);

  const idle = await runAppLifecycle('create', { emitSource: 'precompact', stopAfterEmit: true });
  const loop = readState(idle.root, idle.runId).data;
  const child = loop.session_chain.sessions.find(session =>
    session.continuation?.attempt_id === idle.emittedAttemptId);
  const swept = runKernel(idle.root, [
    'app-task', 'sweep-unconfirmed', '--run-id', idle.runId, '--owner', idle.runId,
    '--generation', '1', '--attempt', idle.emittedAttemptId,
  ], { cwd: idle.cwd,
    env: fixedClockEnv(idle.root, Date.parse(child.continuation.prepare_deadline) + 1) }).json;
  assert.equal(swept.outcome, 'swept');
  assert.equal(swept.failure_code, 'app-prepare-unattended');
  const after = runKernel(idle.root, [
    'app-task', 'status', '--run-id', idle.runId, '--attempt', idle.emittedAttemptId,
  ], { cwd: idle.cwd }).json;
  assert.equal(after.current.phase, 'failed');
  assert.equal(after.current.failure_code, 'app-prepare-unattended');
  assert.deepEqual(idle.hostCalls, []);
});

test('strict host receipt validation rejects inherited alternate control and oversize IDs', async () => {
  const action = { tool: 'create_thread', target: {
    type: 'project', projectId: 'PROJECT', environment: { type: 'local' },
  }, prompt: 'PROMPT' };
  const inherited = Object.create({ threadId: 'INHERITED' });
  const inheritedAlternate = Object.create({ clientThreadId: 'ALTERNATE' });
  inheritedAlternate.threadId = 'OWN';
  const symbolAlternate = { threadId: 'OWN' };
  symbolAlternate[Symbol('clientThreadId')] = 'ALTERNATE';
  const accessorId = {};
  Object.defineProperty(accessorId, 'threadId', {
    enumerable: true, get: () => 'OWN',
  });
  for (const receipt of [
    inherited,
    inheritedAlternate,
    symbolAlternate,
    accessorId,
    { threadId: 'OWN', clientThreadId: 'ALTERNATE' },
    { threadId: 'OWN', clientThreadID: 'ALTERNATE' },
    { threadId: 'OWN', clientthreadid: 'ALTERNATE' },
    { threadId: 'OWN', clientThreadiD: 'ALTERNATE' },
    { threadId: 'OWN', otherId: 'ALTERNATE' },
    { threadId: 'OWN', otherid: 'ALTERNATE' },
    { threadId: 'OWN', threadIds: ['OWN', 'ALTERNATE'] },
    { threadId: 'OWN', threadidS: ['OWN', 'ALTERNATE'] },
    { threadId: 'OWN', ids: ['ALTERNATE'] },
    { threadId: 'OWN', nested: { threadId: 'ALTERNATE' } },
    { threadId: 'OWN', nested: { threadID: 'ALTERNATE' } },
    { threadId: 'OWN', nested: { identifier: 'ALTERNATE' } },
    { threadId: 'bad\u0000id' },
    { threadId: 'bad\nid' },
    { threadId: 'bad\rid' },
    { threadId: 'bad\u0085id' },
    { threadId: 'bad\ud800id' },
    { threadId: 'bad\udc00id' },
    { threadId: 'x'.repeat(513) },
  ]) {
    await assert.rejects(() => executePreparedAction(action,
      new FakeAppHost({ createReceipt: receipt })), /CREATE_RECEIPT_INVALID/);
  }
  const forkAction = { tool: 'fork_thread', environment: { type: 'same-directory' },
    followup: { tool: 'send_message_to_thread', prompt: 'PROMPT' } };
  await assert.rejects(() => executePreparedAction(forkAction, new FakeAppHost({
    forkReceipt: { threadId: 'FORK', nested: { ids: ['OTHER'] } },
  })), /FORK_RECEIPT_INVALID/);
  await assert.rejects(() => executePreparedAction(forkAction, new FakeAppHost({
    forkReceipt: { threadId: 'FORK' }, sendReceipt: { nested: { threadId: 'OTHER' } },
  })), /SEND_RECEIPT_MISMATCH/);
  const functionReceipt = function receipt() {};
  functionReceipt.clientThreadId = 'OTHER';
  const customKeyArray = [];
  customKeyArray.clientThreadId = 'OTHER';
  const symbolArray = [];
  symbolArray[Symbol('threadId')] = 'OTHER';
  const accessorArray = [];
  Object.defineProperty(accessorArray, 'clientThreadId', {
    enumerable: true, get: () => 'OTHER',
  });
  const customPrototypeArray = [];
  Object.setPrototypeOf(customPrototypeArray, { custom: true });
  const sparseArray = new Array(1);
  const hugeSparseArray = [];
  hugeSparseArray.length = 0xffff_ffff;
  const tooDeep = {};
  let deepCursor = tooDeep;
  for (let depth = 0; depth < 40; depth += 1) {
    deepCursor.next = {};
    deepCursor = deepCursor.next;
  }
  const tooWide = Object.fromEntries(
    [...Array(257).keys()].map(index => [`field${index}`, true]));
  const namedArrayFlood = [];
  for (let index = 0; index < 257; index += 1) namedArrayFlood[`field${index}`] = true;
  const nodeFlood = [...Array(5).keys()].map(() => Array(256).fill(true));
  const nonWritableLength = Object.freeze([]);
  const nonWritableIndex = ['ok'];
  Object.defineProperty(nonWritableIndex, '0', {
    value: 'ok', enumerable: true, writable: false, configurable: true,
  });
  const nonConfigurableIndex = ['ok'];
  Object.defineProperty(nonConfigurableIndex, '0', {
    value: 'ok', enumerable: true, writable: true, configurable: false,
  });
  for (const sendReceipt of [functionReceipt, customKeyArray, symbolArray, accessorArray,
    customPrototypeArray, new (class ReceiptArray extends Array {})(), sparseArray,
    hugeSparseArray, tooDeep, tooWide, namedArrayFlood, nodeFlood, nonWritableLength,
    nonWritableIndex, nonConfigurableIndex,
    Symbol('receipt'), 1n, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(() => executePreparedAction(forkAction, new FakeAppHost({
      forkReceipt: { threadId: 'FORK' }, sendReceipt,
    })), /SEND_RECEIPT_MISMATCH/);
  }
  for (const sendReceipt of [null, undefined, 'ok', 1, true, [], [{ ok: true }]]) {
    assert.deepEqual(await executePreparedAction(forkAction, new FakeAppHost({
      forkReceipt: { threadId: 'FORK' }, sendReceipt,
    })), { threadId: 'FORK' });
  }
});

test('raw confirm and message-unconfirmed stdin accept 512 UTF-8 bytes and reject 513 without JSON', async () => {
  const maxId = 'x'.repeat(512);
  assert.equal(Buffer.byteLength(maxId, 'utf8'), 512);
  const accepted = await runAppLifecycle('create', {
    stopAfterPrepare: true, hostOptions: { createReceipt: { threadId: maxId } },
  });
  const receipt = await executePreparedAction(accepted.prepared.action, accepted.host);
  assert.equal(receipt.threadId, maxId);
  const args = [
    'app-task', 'confirm', '--run-id', accepted.runId, '--owner', accepted.runId,
    '--generation', '1', '--attempt', accepted.prepared.attempt_id,
    '--stdin-mode', accepted.mode, '--receipt-stdin',
  ];
  const confirmed = await runReadyKernel(accepted.root, args, receipt.threadId,
    exactReadyPattern('app-confirm', accepted.prepared.attempt_id, accepted.mode),
    { cwd: accepted.cwd });
  assert.equal(confirmed.json.outcome, 'confirmed');
  assert.equal(processOutputs(confirmed).some(output => output.includes(maxId)), false);

  const rejected = await runAppLifecycle('create', { stopAfterPrepare: true });
  const over = 'y'.repeat(513);
  const rejectedError = await captureRejection(() => runReadyKernel(rejected.root, [
    'app-task', 'confirm', '--run-id', rejected.runId, '--owner', rejected.runId,
    '--generation', '1', '--attempt', rejected.prepared.attempt_id,
    '--stdin-mode', rejected.mode, '--receipt-stdin',
  ], over, exactReadyPattern('app-confirm', rejected.prepared.attempt_id, rejected.mode),
  { cwd: rejected.cwd }), /READY_PROCESS_EXIT_1/);
  assert.equal(processOutputs(rejectedError).some(output => output.includes(over)), false);
  const status = runKernel(rejected.root, [
    'app-task', 'status', '--run-id', rejected.runId,
    '--attempt', rejected.prepared.attempt_id,
  ], { cwd: rejected.cwd });
  assert.equal(status.json.current.phase, 'prepared');
  assert.equal(processOutputs(status).some(output => output.includes(over)), false);

  const uncertain = await runAppLifecycle('fork', {
    stopAfterPrepare: true,
    hostOptions: { forkReceipt: { threadId: maxId }, behaviors: { send_message_to_thread: 'no-return' } },
  });
  await assert.rejects(() => executePreparedAction(uncertain.prepared.action, uncertain.host,
    { timeoutMs: 25 }), /SEND_NO_RETURN/);
  const failed = await settlePreparedFailure(uncertain, 'message-unconfirmed', maxId);
  assert.equal(failed.appStatus.current.phase, 'failed');
  assert.equal(failed.appStatus.current.failure_code, 'message-unconfirmed');
  assert.equal(failed.outputs.some(output => output.includes(maxId)), false);

  const rejectedMessage = await runAppLifecycle('fork', { stopAfterPrepare: true });
  const rejectedMessageError = await captureRejection(() => runReadyKernel(rejectedMessage.root, [
    'app-task', 'fail', '--run-id', rejectedMessage.runId, '--owner', rejectedMessage.runId,
    '--generation', '1', '--attempt', rejectedMessage.prepared.attempt_id,
    '--code', 'message-unconfirmed', '--stdin-mode', rejectedMessage.mode, '--receipt-stdin',
  ], over, exactReadyPattern('app-fail', rejectedMessage.prepared.attempt_id, rejectedMessage.mode),
  { cwd: rejectedMessage.cwd }), /READY_PROCESS_EXIT_1/);
  assert.equal(processOutputs(rejectedMessageError).some(output => output.includes(over)), false);
  const rejectedMessageStatus = runKernel(rejectedMessage.root, [
    'app-task', 'status', '--run-id', rejectedMessage.runId,
    '--attempt', rejectedMessage.prepared.attempt_id,
  ], { cwd: rejectedMessage.cwd });
  assert.equal(rejectedMessageStatus.json.current.phase, 'prepared');
  assert.equal(processOutputs(rejectedMessageStatus).some(output => output.includes(over)), false);
});

test('resolved null or undefined send completion succeeds and never resends', async () => {
  for (const [name, hostOptions] of [
    ['null', { sendReceipt: null }],
    ['undefined', { behaviors: { send_message_to_thread: 'undefined' } }],
  ]) {
    const fixture = await runAppLifecycle('fork', { stopAfterPrepare: true, hostOptions });
    const receipt = await executePreparedAction(fixture.prepared.action, fixture.host, { timeoutMs: 25 });
    assert.equal(receipt.threadId, 'FORK_THREAD_CANARY_71C2', name);
    assert.deepEqual(fixture.host.calls.map(call => call.tool),
      ['fork_thread', 'send_message_to_thread'], name);
  }
});

test('create fork and send throw timeout and invalid rows fail durably without retry', async () => {
  const scenarios = [
    { name: 'create-throw', route: 'create', hostOptions: { behaviors: { create_thread: 'throw' } },
      error: /CREATE_HOST_THROW/, calls: ['list_projects', 'create_thread'], code: 'host-call-failed' },
    { name: 'create-timeout', route: 'create', hostOptions: { behaviors: { create_thread: 'timeout' } },
      error: /CREATE_HOST_TIMEOUT/, calls: ['list_projects', 'create_thread'], code: 'host-call-timeout' },
    { name: 'create-no-return', route: 'create', hostOptions: { behaviors: { create_thread: 'no-return' } },
      error: /CREATE_NO_RETURN/, calls: ['list_projects', 'create_thread'], code: 'host-call-no-return' },
    { name: 'create-invalid', route: 'create', hostOptions: { createReceipt: { clientThreadId: 'ALT' } },
      error: /CREATE_RECEIPT_INVALID/, calls: ['list_projects', 'create_thread'], code: 'invalid-host-receipt' },
    { name: 'fork-throw', route: 'fork', hostOptions: { behaviors: { fork_thread: 'throw' } },
      error: /FORK_HOST_THROW/, calls: ['fork_thread'], code: 'host-call-failed' },
    { name: 'fork-timeout', route: 'fork', hostOptions: { behaviors: { fork_thread: 'timeout' } },
      error: /FORK_HOST_TIMEOUT/, calls: ['fork_thread'], code: 'host-call-timeout' },
    { name: 'fork-no-return', route: 'fork', hostOptions: { behaviors: { fork_thread: 'no-return' } },
      error: /FORK_NO_RETURN/, calls: ['fork_thread'], code: 'host-call-no-return' },
    { name: 'fork-invalid', route: 'fork', hostOptions: { forkReceipt: { clientThreadId: 'ALT' } },
      error: /FORK_RECEIPT_INVALID/, calls: ['fork_thread'], code: 'invalid-host-receipt' },
    { name: 'send-throw', route: 'fork', hostOptions: {
      forkReceipt: { threadId: 'KNOWN-FORK' }, behaviors: { send_message_to_thread: 'throw' } },
      error: /SEND_HOST_THROW/, calls: ['fork_thread', 'send_message_to_thread'],
      code: 'message-unconfirmed', receipt: 'KNOWN-FORK' },
    { name: 'send-timeout', route: 'fork', hostOptions: {
      forkReceipt: { threadId: 'KNOWN-FORK' }, behaviors: { send_message_to_thread: 'timeout' } },
      error: /SEND_HOST_TIMEOUT/, calls: ['fork_thread', 'send_message_to_thread'],
      code: 'message-unconfirmed', receipt: 'KNOWN-FORK' },
    { name: 'send-no-return', route: 'fork', hostOptions: {
      forkReceipt: { threadId: 'KNOWN-FORK' }, behaviors: { send_message_to_thread: 'no-return' } },
      error: /SEND_NO_RETURN/, calls: ['fork_thread', 'send_message_to_thread'],
      code: 'message-unconfirmed', receipt: 'KNOWN-FORK' },
    { name: 'send-invalid', route: 'fork', hostOptions: {
      forkReceipt: { threadId: 'KNOWN-FORK' }, sendReceipt: { threadId: 7 } },
      error: /SEND_RECEIPT_MISMATCH/, calls: ['fork_thread', 'send_message_to_thread'],
      code: 'message-unconfirmed', receipt: 'KNOWN-FORK' },
    { name: 'send-mismatch', route: 'fork', hostOptions: {
      forkReceipt: { threadId: 'KNOWN-FORK' }, sendReceipt: { threadId: 'OTHER' } },
      error: /SEND_RECEIPT_MISMATCH/, calls: ['fork_thread', 'send_message_to_thread'],
      code: 'message-unconfirmed', receipt: 'KNOWN-FORK' },
  ];
  for (const scenario of scenarios) {
    const fixture = await runAppLifecycle(scenario.route, {
      stopAfterPrepare: true, hostOptions: scenario.hostOptions,
    });
    assert.equal(fixture.duplicate.do_not_call, true, scenario.name);
    assert.equal(fixture.duplicateCheckedBeforeAction, true, scenario.name);
    await assert.rejects(() => executePreparedAction(fixture.prepared.action, fixture.host,
      { timeoutMs: 25 }), scenario.error, scenario.name);
    assert.deepEqual(fixture.host.calls.map(call => call.tool), scenario.calls, scenario.name);
    const failed = await settlePreparedFailure(fixture, scenario.code, scenario.receipt ?? null);
    assert.equal(failed.runStatus, 'paused', scenario.name);
    assert.equal(failed.appStatus.current.phase, 'failed', scenario.name);
    assert.equal(failed.appStatus.current.failure_code, scenario.code, scenario.name);
    assert.equal(failed.lease.resume_policy,
      scenario.code === 'message-unconfirmed' ? 'human' : null, scenario.name);
    if (scenario.code !== 'message-unconfirmed') {
      assert.equal(failed.lease.handoff_transport, null, scenario.name);
      assert.equal(failed.lease.handoff_attempt_id, null, scenario.name);
    }
    if (scenario.code === 'message-unconfirmed') {
      assert.match(failed.outputs[0], /DEEP_LOOP_STDIN_READY:v1:app-fail:/u, scenario.name);
    } else {
      assert.doesNotMatch(failed.outputs[0], /DEEP_LOOP_STDIN_READY:/u, scenario.name);
    }
    for (const raw of [scenario.receipt, fixture.prepared.action?.target?.projectId].filter(Boolean)) {
      assert.equal(failed.outputs.some(output => output.includes(raw)), false, `${scenario.name}: ${raw}`);
    }
    assert.deepEqual(fixture.host.calls.map(call => call.tool), scenario.calls,
      `${scenario.name}: external action count is unchanged`);
  }
});

test('ordinary and message failure result loss reconcile only after the original handle exits', async () => {
  const rows = [
    { name: 'ordinary', route: 'create', code: 'host-call-failed', receipt: null,
      hostOptions: { behaviors: { create_thread: 'throw' } }, error: /CREATE_HOST_THROW/,
      calls: ['list_projects', 'create_thread'] },
    { name: 'message', route: 'fork', code: 'message-unconfirmed', receipt: 'KNOWN-FORK',
      hostOptions: { forkReceipt: { threadId: 'KNOWN-FORK' },
        behaviors: { send_message_to_thread: 'timeout' } }, error: /SEND_HOST_TIMEOUT/,
      calls: ['fork_thread', 'send_message_to_thread'] },
  ];
  for (const row of rows) {
    const fixture = await runAppLifecycle(row.route, {
      stopAfterPrepare: true, hostOptions: row.hostOptions,
    });
    await assert.rejects(() => executePreparedAction(fixture.prepared.action, fixture.host,
      { timeoutMs: 25 }), row.error);
    const args = [
      'app-task', 'fail', '--run-id', fixture.runId, '--owner', fixture.runId,
      '--generation', '1', '--attempt', fixture.prepared.attempt_id, '--code', row.code,
      ...(row.receipt === null ? []
        : ['--stdin-mode', fixture.mode, '--receipt-stdin']),
    ];
    const original = startLostResultKernel(fixture.root, args, {
      cwd: fixture.cwd, inputLine: row.receipt,
      readyPattern: row.receipt === null ? null
        : exactReadyPattern('app-fail', fixture.prepared.attempt_id, fixture.mode),
    });
    assert.equal(Number.isInteger(original.pid), true, row.name);
    original.poll();
    try { await original.done; }
    catch (error) { original.terminate(); throw error; }
    assert.equal(original.poll(), 'exited', row.name);
    assert.ok(original.pollCount() >= 2, row.name);
    const status = runKernel(fixture.root, [
      'app-task', 'status', '--run-id', fixture.runId,
      '--attempt', fixture.prepared.attempt_id,
    ], { cwd: fixture.cwd });
    assert.equal(status.json.current.phase, 'failed', row.name);
    assert.equal(status.json.current.failure_code, row.code, row.name);
    assert.deepEqual(fixture.host.calls.map(call => call.tool), row.calls,
      `${row.name}: no external retry after result loss`);
    for (const raw of [row.receipt, fixture.prepared.action?.target?.projectId].filter(Boolean)) {
      assert.equal([...processOutputs(status), ...processOutputs(original.output())]
        .some(output => output.includes(raw)), false, `${row.name}: safe output redaction`);
    }
  }
});

test('prepare result loss reads exact status then proves do-not-call and sweeps manual with zero task action', async () => {
  const fixture = await runAppLifecycle('create', { simulatePrepareResultLoss: true });
  assert.equal(fixture.preparedStatusAfterLoss.current.phase, 'prepared');
  assert.equal(fixture.duplicate.outcome, 'already-prepared');
  assert.equal(fixture.duplicate.do_not_call, true);
  assert.equal(fixture.duplicateCheckedBeforeAction, true);
  assert.deepEqual(fixture.host.calls.map(call => call.tool), ['list_projects']);
  assert.equal([fixture.preparedStatusOutput, fixture.lostPrepareStderrAudit]
    .some(output => output.includes('PROJECT_CANARY_71C2')), false);
  const loop = readState(fixture.root, fixture.runId).data;
  const child = loop.session_chain.sessions.find(session =>
    session.continuation?.attempt_id === fixture.emittedAttemptId);
  const swept = runKernel(fixture.root, [
    'app-task', 'sweep-unconfirmed', '--run-id', fixture.runId, '--owner', fixture.runId,
    '--generation', '1', '--attempt', fixture.emittedAttemptId,
  ], { cwd: fixture.cwd,
    env: fixedClockEnv(fixture.root,
      Date.parse(child.continuation.confirmation_deadline) + 1) }).json;
  assert.equal(swept.outcome, 'swept');
  assert.equal(swept.failure_code, 'app-launch-unconfirmed');
  const status = runKernel(fixture.root, [
    'app-task', 'status', '--run-id', fixture.runId, '--attempt', fixture.emittedAttemptId,
  ], { cwd: fixture.cwd });
  assert.equal(status.json.current.phase, 'failed');
  assert.equal(status.json.current.failure_code, 'app-launch-unconfirmed');
  assert.equal(status.json.manual_recovery, true);
  assert.deepEqual(fixture.host.calls.map(call => call.tool), ['list_projects']);
});

test('lost manual-preserve prepare result stops from exact status without retry or sweep', async () => {
  const fixture = await runAppLifecycle('create', { stopAfterEmit: true });
  const prepareArgs = [
    'app-task', 'prepare', '--run-id', fixture.runId, '--owner', fixture.runId,
    '--generation', '1', '--stdin-mode', fixture.mode, '--app-host-input-stdin',
  ];
  const hostInput = JSON.stringify({ host_task_cwd: fixture.cwd });
  let prepareProcessStarts = 0;
  const startPrepare = () => {
    prepareProcessStarts += 1;
    return startLostResultKernel(fixture.root, prepareArgs, {
    cwd: fixture.cwd, inputLine: hostInput,
    readyPattern: exactReadyPattern('app-prepare', `${fixture.runId}.1`, fixture.mode),
    });
  };
  const original = startPrepare();
  assert.equal(original.poll(), 'alive');
  try { await original.done; }
  catch (error) { original.terminate(); throw error; }
  assert.equal(original.poll(), 'exited');
  assert.ok(original.pollCount() >= 2);

  const status = runKernel(fixture.root, [
    'app-task', 'status', '--run-id', fixture.runId, '--attempt', fixture.emittedAttemptId,
  ], { cwd: fixture.cwd });
  const runStatus = runKernel(fixture.root, [
    'state', 'get', '--run-id', fixture.runId, '--field', 'status',
  ], { cwd: fixture.cwd });
  const lease = runKernel(fixture.root, [
    'state', 'get', '--run-id', fixture.runId, '--field', 'session_chain.lease',
  ], { cwd: fixture.cwd });
  assert.equal(status.json.current.phase, 'emitted');
  assert.equal(status.json.current.attempt_id, fixture.emittedAttemptId);
  assert.equal(status.json.logical_run_id, fixture.runId);
  assert.equal(status.json.owner_run_id, fixture.runId);
  assert.equal(status.json.generation, 1);
  assert.equal(status.json.manual_recovery, true);
  assert.equal(status.json.handoff_phase, 'emitted');
  assert.equal(runStatus.json, 'paused');
  assert.equal(lease.json.resume_policy, 'human');
  const retryEligible = status.json.current.phase === 'emitted'
    && status.json.manual_recovery === false
    && status.json.handoff_phase === 'emitted';
  assert.equal(retryEligible, false);
  assert.equal(prepareProcessStarts, 1);
  assert.equal(readLines(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-preserved').length, 1);
  assert.equal(readLines(fixture.root, fixture.runId)
    .some(event => event.type === 'app-task-swept'), false);
  assert.deepEqual(fixture.hostCalls, []);
  assert.equal(processOutputs(status, runStatus, lease, original.output())
    .some(output => output.includes('PROJECT_CANARY_71C2')), false);
});

test('acquired safe status is not success authority after release interleaving', async () => {
  const fixture = await runAppLifecycle('create');
  const released = runKernel(fixture.root, [
    'lease', 'release', '--run-id', fixture.runId,
    '--owner', fixture.childRunId, '--generation', '2',
  ], { cwd: fixture.cwd });
  assert.equal(released.json.reason, 'released');
  const candidate = runKernel(fixture.root, [
    'app-task', 'status', '--run-id', fixture.runId, '--attempt', fixture.emittedAttemptId,
  ], { cwd: fixture.cwd });
  assert.equal(candidate.json.current.phase, 'acquired');
  assert.equal(candidate.json.owner_run_id, fixture.childRunId);
  assert.equal(candidate.json.generation, 2);
  assert.equal(candidate.json.handoff_phase, 'acquired');
  const observation = JSON.stringify(fixture.childObservation);
  await assert.rejects(() => runReadyKernel(fixture.root, [
    'app-task', 'acquire', '--run-id', fixture.runId, '--owner', fixture.childRunId,
    '--generation', '1', '--runtime', 'codex', '--attempt', fixture.emittedAttemptId,
    '--stdin-mode', fixture.mode, '--observation-stdin',
  ], observation, exactReadyPattern('app-acquire', fixture.emittedAttemptId, fixture.mode),
  { cwd: fixture.cwd }), /READY_PROCESS_EXIT_3/);
});

test('confirm result loss retries the exact receipt before and after commit without a second create', async () => {
  for (const lossPoint of ['before-commit', 'after-commit']) {
    const fixture = await runAppLifecycle('create', { stopAfterPrepare: true });
    const receipt = await executePreparedAction(fixture.prepared.action, fixture.host);
    const args = [
      'app-task', 'confirm', '--run-id', fixture.runId, '--owner', fixture.runId,
      '--generation', '1', '--attempt', fixture.prepared.attempt_id,
      '--stdin-mode', fixture.mode, '--receipt-stdin',
    ];
    let lostProcessOutput;
    if (lossPoint === 'before-commit') {
      lostProcessOutput = await captureRejection(() => stopReadyKernelBeforeInput(fixture.root, args,
        exactReadyPattern('app-confirm', fixture.prepared.attempt_id, fixture.mode),
        { cwd: fixture.cwd }),
      /SIMULATED_CONFIRM_PROCESS_LOSS_BEFORE_COMMIT/);
    } else {
      await assert.rejects(async () => {
        lostProcessOutput = await runReadyKernel(fixture.root, args,
          receipt.threadId,
          exactReadyPattern('app-confirm', fixture.prepared.attempt_id, fixture.mode),
          { cwd: fixture.cwd });
        throw new Error('SIMULATED_CONFIRM_RESULT_LOSS_AFTER_COMMIT');
      }, /SIMULATED_CONFIRM_RESULT_LOSS_AFTER_COMMIT/);
    }
    const beforeRetry = runKernel(fixture.root, [
      'app-task', 'status', '--run-id', fixture.runId, '--attempt', fixture.prepared.attempt_id,
    ], { cwd: fixture.cwd });
    const expectedPhase = lossPoint === 'before-commit' ? 'prepared' : 'confirmed';
    assert.equal(beforeRetry.json.current.phase, expectedPhase, lossPoint);
    const loop = readState(fixture.root, fixture.runId).data;
    const continuation = loop.session_chain.sessions.find(session =>
      session.continuation?.attempt_id === fixture.prepared.attempt_id)?.continuation;
    const decisionAnchor = expectedPhase === 'prepared'
      ? continuation?.prepared_at : continuation?.confirmed_at;
    const decisionNow = Date.parse(decisionAnchor) + 1;
    const retryEligible = beforeRetry.json.logical_run_id === fixture.runId
      && beforeRetry.json.owner_run_id === fixture.runId
      && beforeRetry.json.generation === 1
      && beforeRetry.json.handoff_phase === 'spawned'
      && beforeRetry.json.manual_recovery === false
      && beforeRetry.json.current?.attempt_id === fixture.prepared.attempt_id
      && beforeRetry.json.current?.phase === expectedPhase
      && Number.isFinite(decisionNow)
      && (expectedPhase === 'confirmed'
        || (Number.isFinite(Date.parse(continuation?.confirmation_deadline))
          && decisionNow <= Date.parse(continuation.confirmation_deadline)));
    assert.equal(retryEligible, true, lossPoint);
    assert.deepEqual(fixture.host.calls.map(call => call.tool), ['list_projects', 'create_thread']);
    const retry = await runReadyKernel(fixture.root, args,
      receipt.threadId,
      exactReadyPattern('app-confirm', fixture.prepared.attempt_id, fixture.mode),
      { cwd: fixture.cwd });
    assert.equal(retry.json.outcome,
      lossPoint === 'before-commit' ? 'confirmed' : 'already-confirmed', lossPoint);
    const app = runKernel(fixture.root, [
      'app-task', 'status', '--run-id', fixture.runId, '--attempt', fixture.prepared.attempt_id,
    ], { cwd: fixture.cwd });
    assert.equal(app.json.current.phase, 'confirmed', lossPoint);
    assert.deepEqual(fixture.host.calls.map(call => call.tool), ['list_projects', 'create_thread']);
    for (const raw of [receipt.threadId, fixture.prepared.action.target.projectId]) {
      assert.equal([...processOutputs(lostProcessOutput),
        ...processOutputs(beforeRetry, retry, app)]
        .some(output => output.includes(raw)), false, lossPoint);
    }
  }
});

test('non-App surface observations confer zero App host-call authority', () => {
  const rows = [
    { runtime: 'claude', kind: 'claude-code', source: 'claude-cli-entrypoint', host_task_cwd_source: 'direct-cli-cwd' },
    { runtime: 'claude', kind: 'claude-desktop', source: 'claude-desktop-local-agent', host_task_cwd_source: 'desktop-code-context' },
    { runtime: 'codex', kind: 'codex-cli', source: 'codex-cli-host', host_task_cwd_source: 'direct-cli-cwd' },
  ];
  for (const row of rows) {
    const fixture = initializeManualRun([], {
      runtime: row.runtime, hostSurface: row.kind, hostSource: row.source,
    });
    const observation = normalizeHostObservation({
      ...row, capabilities: [], structured_stdin_mode: null, host_task_cwd: fixture.root,
    }, {
      platform: 'linux', kernelCwd: fixture.root, exists: () => true, realpath: value => value,
      stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true,
    });
    assert.notEqual(observation.kind, 'codex-app');
    const attempted = runKernelResult(fixture.root, [
      'handoff', 'emit', '--run-id', fixture.runId, '--reason', 'milestone', '--trigger', 'milestone',
      '--owner', fixture.runId, '--generation', '1', '--app-intent',
    ], { cwd: fixture.cwd });
    assert.equal(attempted.status, 3, row.kind);
    const output = `${attempted.stdout}\n${attempted.stderr}`;
    assert.doesNotMatch(output,
      /"action"|create_thread|fork_thread|send_message_to_thread/, row.kind);
    assert.equal((output.match(/"action"/gu) ?? []).length, 0, row.kind);
    assert.equal(fixture.consent.mode, 'manual', row.kind);
    assert.equal(fixture.appStatus.has_app_history, false, row.kind);
    assert.equal(fixture.appStatus.current, null, row.kind);
  }
});

test('manual enum omission preserves exact empty capabilities and paired-null surface source', () => {
  const fixture = initializeManualRun([], {
    runtime: 'codex', hostSurface: null, hostSource: null,
  });
  assert.equal(fixture.parentSurface, null);
  assert.equal(fixture.appStatus.has_app_history, false);
  assert.equal(fixture.appStatus.current, null);
  assert.deepEqual(fixture.appStatus.history, []);
  assert.equal(fixture.consent.mode, 'manual');
  assert.equal(fixture.consent.authority, 'default-manual');
  const attempted = runKernelResult(fixture.root, [
    'handoff', 'emit', '--run-id', fixture.runId, '--reason', 'milestone',
    '--trigger', 'milestone', '--owner', fixture.runId, '--generation', '1', '--app-intent',
  ], { cwd: fixture.cwd });
  assert.equal(attempted.status, 3);
  assert.doesNotMatch(`${attempted.stdout}\n${attempted.stderr}`,
    /"action"|create_thread|fork_thread|send_message_to_thread/);
});
