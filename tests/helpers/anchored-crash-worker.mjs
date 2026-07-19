import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentHash } from '../../scripts/lib/envelope.mjs';
import { finishRun } from '../../scripts/lib/finish.mjs';
import { emitHandoff } from '../../scripts/lib/handoff.mjs';
import { acquireAppTask, awaitAppTask, confirmAppTask, failAppTask, prepareAppTask,
  sweepUnconfirmedAppTask } from '../../scripts/lib/app-task-continuation.mjs';
import { recoverRun } from '../../scripts/lib/recover.mjs';
import { appendAnchored } from '../../scripts/lib/integrity.mjs';
import { emitInsights } from '../../scripts/lib/insights.mjs';
import { acquireLease, releaseLease, reserveHandoff } from '../../scripts/lib/lease.mjs';
import { recordReviewVerdict, tripBreaker } from '../../scripts/lib/breaker.mjs';
import { recordReviewed } from '../../scripts/lib/comprehension.mjs';
import { patch, pauseRun } from '../../scripts/lib/state.mjs';
import { newWorkstream } from '../../scripts/lib/workspace.mjs';
import { respawn } from '../../scripts/lib/respawn.mjs';
import { offerDesktop } from '../../scripts/lib/spawn-optin.mjs';
import { recordCost, settleCodexPreflightCost, settleCodexProcessCost,
  settleTerminalCodexMakerCost } from '../../scripts/lib/budget.mjs';

const EXTENSIONS = [];
const RUN_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const BASE_POINTS = new Set([
  'state-stage-after-rename', 'event-stage-after-rename', 'pending-after-rename',
  'event-after-partial-append', 'event-after-full-append', 'state-after-rename',
  'hash-after-rename', 'before-cleanup',
  'state-replace-after-create', 'state-replace-after-fsync',
  'state-replace-after-rename-before-dir-fsync',
  'hash-replace-after-create', 'hash-replace-after-fsync',
  'hash-replace-after-rename-before-dir-fsync',
  'cleanup-events-after-unlink', 'cleanup-state-after-unlink',
  'cleanup-hash-after-unlink', 'cleanup-marker-after-unlink',
  'response-after-cleanup',
]);

function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function parseInput(raw, keys) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('CRASH_INPUT_INVALID'); }
  if (!exactObject(value, keys)) throw new Error('CRASH_INPUT_INVALID');
  return value;
}

export function registerAnchoredCrashExtension(dispatch) {
  if (typeof dispatch !== 'function') throw new Error('CRASH_EXTENSION_INVALID');
  EXTENSIONS.push(dispatch);
}

const publisher7g = Object.freeze({
  'lease-release': ({ root, runId, owner, generation }) =>
    releaseLease(root, runId, { owner, generation }),
  'handoff-reserve': ({ root, runId, owner, generation }) =>
    reserveHandoff(root, runId, { trigger: 'crash-7g',
      now: Date.parse('2026-07-13T00:00:10.000Z'), expect: { owner, generation } }),
  'breaker-trip': ({ root, runId, owner, generation }) =>
    tripBreaker(root, runId, 'crash-7g', { fence: { owner, generation },
      requestId: 'crash-7g-trip' }),
  'breaker-verdict': ({ root, runId, owner, generation }) =>
    recordReviewVerdict(root, runId, 'REQUEST_CHANGES',
      { owner, generation, runtime: 'codex' },
      { requestId: 'crash-7g-verdict' }),
  'comprehension-reviewed': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['episodeId', 'requestId', 'source']);
    return recordReviewed(root, runId, input.episodeId, input.source,
      { fence: { owner, generation, runtime: 'codex' }, requestId: input.requestId });
  },
});

export function dispatchPublisherCrash7g({ root, runId, operation, point, owner, generation,
  rawInput }) {
  if (!Object.hasOwn(publisher7g, operation)) throw new Error('CRASH_OPERATION_INVALID');
  const points = new Set(['pending-after-rename', 'event-after-partial-append',
    'state-after-rename', 'hash-after-rename', 'before-cleanup']);
  if (!points.has(point)) throw new Error('CRASH_POINT_INVALID');
  return publisher7g[operation]({ root, runId, owner, generation, rawInput });
}

registerAnchoredCrashExtension(request => {
  if (!Object.hasOwn(publisher7g, request.operation)) return false;
  dispatchPublisherCrash7g(request);
  return true;
});

const generic = Object.freeze({
  'desktop-offer': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['now', 'ttlSec']);
    return offerDesktop(root, runId, {
      expect: { owner, generation }, now: input.now, ttlSec: input.ttlSec,
    });
  },
  'respawn-rollback': ({ root, runId, owner, generation, point, rawInput }) => {
    const input = parseInput(rawInput,
      ['attended', 'childRunId', 'handoffRel', 'key', 'kind', 'now']);
    delete process.env.DEEP_LOOP_TEST_CRASH_AT;
    return respawn(root, runId,
      { ...input, env: {}, expect: { owner, generation },
      spawnFn: () => {
        process.env.DEEP_LOOP_TEST_CRASH_AT = point;
        return { ok: false, reason: 'launch-exit-1' };
      },
      revalidateRuntimeExecutable: identity => identity,
      revalidateLauncherExecutable: identity => identity });
  },
  'respawn-timeout': ({ root, runId, owner, generation, point, rawInput }) => {
    const input = parseInput(rawInput,
      ['attended', 'childRunId', 'handoffRel', 'key', 'kind', 'now']);
    delete process.env.DEEP_LOOP_TEST_CRASH_AT;
    return respawn(root, runId,
      { ...input, env: {}, expect: { owner, generation },
      spawnFn: () => ({ ok: true }),
      pollLease: () => {
        process.env.DEEP_LOOP_TEST_CRASH_AT = point;
        return { state: 'releasing', owner_run_id: owner, generation };
      },
      sleep: () => {},
      revalidateRuntimeExecutable: identity => identity,
      revalidateLauncherExecutable: identity => identity });
  },
  'accounting-record': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['intent', 'requestId', 'tokens', 'turns']);
    return recordCost(root, runId, { turns: input.turns, tokens: input.tokens,
      requestId: input.requestId,
      fence: { owner, generation, intent: input.intent } });
  },
  'accounting-preflight': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['receipt']);
    return settleCodexPreflightCost(root, runId, { receipt: input.receipt,
      fence: { owner, generation, intent: 'accounting' } });
  },
  'accounting-process': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['receipt']);
    return settleCodexProcessCost(root, runId, { receipt: input.receipt,
      fence: { owner, generation, intent: 'accounting' } });
  },
  'accounting-terminal-maker': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['handoffKey', 'intent', 'usage']);
    return settleTerminalCodexMakerCost(root, runId, { usage: input.usage,
      handoffKey: input.handoffKey,
      fence: { owner, generation, intent: input.intent } });
  },
  'generic-append': ({ root, runId, owner, generation }) => appendAnchored(
    root, runId, { type: 'anchored-crash-probe', data: { owner, generation } }, undefined,
    undefined, { callerBinding: { owner, generation },
      intentDigest: contentHash(JSON.stringify(
        { operation: 'anchored-crash-probe', owner, generation })) }),
  'generic-acquire': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['childOwner']);
    return acquireLease(root, runId, { owner: input.childOwner,
      expectGeneration: generation, runtime: 'codex' });
  },
  'insights-emit': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['now', 'rnd']);
    return emitInsights(root, runId, { fence: { owner, generation }, now: input.now,
      rnd: () => input.rnd, sleepFn: () => {} });
  },
  'state-patch': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['field', 'value']);
    return patch(root, runId, input.field, input.value,
      { fence: { owner, generation } });
  },
  'state-pause': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput, ['mode', 'now', 'reason']);
    if (!['preserve', 'rollback'].includes(input.mode)
        || !Number.isFinite(input.now) || typeof input.reason !== 'string') {
      throw new Error('CRASH_INPUT_INVALID');
    }
    return pauseRun(root, runId, { mode: input.mode, now: input.now, reason: input.reason,
      expect: { owner, generation } });
  },
  'workstream-new': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput,
      ['baseCommit', 'branch', 'dependsOn', 'requestId', 'title', 'worktree']);
    return newWorkstream(root, runId, { ...input, fence: { owner, generation } });
  },
});

function workerDescriptor10d({ runtime, root: projectRoot, parentRunId, childRunId }) {
  return { runtime, projectRoot, runId: parentRunId, usageOutputKind: 'json',
    resumeInvocation: childRunId, entries: Object.fromEntries(['interactive', 'headless',
      'cmux', 'iterm2', 'terminal-app', 'wt', 'powershell', 'desktop']
      .map(name => [name, { display: 'manual', unavailable: true }])) };
}
function workerPrepareDescriptor10d() {
  return { tool: 'create_thread', target: { type: 'project', projectId: 'p',
    environment: { type: 'local' } }, prompt: 'prompt' };
}
function workerObservation10d(root) {
  return { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['structured-process-stdin'], structured_stdin_mode: 'pty-raw-noecho',
    host_task_cwd: root, host_task_cwd_source: 'app-task-context' };
}
const publicMutation10d = Object.freeze({
  emit: ({ root, runId, input }) => emitHandoff(root, runId, {
    trigger: 'crash-emit', reason: 'same', appIntent: true,
    expect: { owner: input.owner, generation: input.generation }, cwdFn: () => root,
    attemptIdFactory: () => input.attemptId, descriptorBuilder: workerDescriptor10d,
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') }),
  prepare: ({ root, runId, input }) => prepareAppTask(root, runId,
    { owner: input.owner, generation: input.generation, stdinMode: 'pty-raw-noecho',
      hostInput: { currentHostTaskCwd: root,
        projects: [{ projectId: 'p', projectKind: 'local', path: root }] } },
    { cwdFn: () => root, descriptorBuilder: workerPrepareDescriptor10d,
      nowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      precheckNowFn: () => Date.parse('2026-07-13T00:00:02.000Z'),
      reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }) }),
  confirm: ({ root, runId, input }) => confirmAppTask(root, runId,
    { ...input, stdinMode: 'pty-raw-noecho', threadId: 'confirmed-thread' },
    { cwdFn: () => root,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') }),
  fail: ({ root, runId, input }) => failAppTask(root, runId,
    input.messageFailure === true
      ? { owner: input.owner, generation: input.generation, attemptId: input.attemptId,
        code: 'message-unconfirmed', stdinMode: 'pty-raw-noecho',
        unconfirmedThreadId: 'known-message-thread' }
      : { owner: input.owner, generation: input.generation, attemptId: input.attemptId,
        code: 'host-call-failed' },
    { cwdFn: () => input.messageCwd ?? root,
      nowFn: () => Date.parse('2026-07-13T00:00:03.000Z') }),
  sweep: ({ root, runId, input }) => sweepUnconfirmedAppTask(root, runId,
    { ...input, deadline: '2026-07-13T00:05:00.000Z' },
    { cwdFn: () => root, nowFn: () => Date.parse('2026-07-13T00:05:01.001Z') }),
  'await-timeout': ({ root, runId, input }) => {
    let pollNow = Date.parse('2026-07-13T00:00:03.000Z');
    return awaitAppTask(root, runId, { ...input, timeoutMs: 1, intervalMs: 1 }, {
      cwdFn: () => root, pollNowFn: () => pollNow,
      pollIntervalMs: 1_000, sleepFn: ms => { pollNow += ms; },
      nowFn: () => pollNow + 1,
    });
  },
  acquire: ({ root, runId, input }) => acquireAppTask(root, runId,
    { ...input, owner: input.childRunId, runtime: 'codex', stdinMode: 'pty-raw-noecho',
      observation: workerObservation10d(root) }, { cwdFn: () => root,
      nowFn: () => Date.parse('2026-07-13T00:00:04.000Z') }),
  recover: ({ root, runId, input }) => recoverRun(root, runId,
    { expect: { owner: input.owner, generation: input.generation }, confirm: true }),
  finish: ({ root, runId, input }) => finishRun(root, runId, {
    status: 'completed', reportRel: 'final.md', proof: { human_reason: 'same' },
    fence: { owner: input.owner, generation: input.generation,
      runtime: 'codex', intent: 'business' } }),
});

export function dispatchPublicMutationCrash10d({ root, runId, operation, point, rawInput }) {
  if (!Object.hasOwn(publicMutation10d, operation)) throw new Error('CRASH_OPERATION_INVALID');
  const points = new Set(['state-stage-after-rename', 'event-stage-after-rename',
    'pending-after-rename', 'event-after-partial-append', 'event-after-full-append',
    'state-after-rename', 'hash-after-rename', 'before-cleanup',
    'state-replace-after-create', 'state-replace-after-fsync',
    'state-replace-after-rename-before-dir-fsync',
    'hash-replace-after-create', 'hash-replace-after-fsync',
    'hash-replace-after-rename-before-dir-fsync']);
  if (!points.has(point)) throw new Error('CRASH_POINT_INVALID');
  const input = JSON.parse(rawInput);
  const inputKeys = Object.keys(input).sort();
  const baseKeys = ['attemptId', 'childRunId', 'generation', 'owner'];
  const messageKeys = [...baseKeys, 'messageCwd', 'messageFailure'].sort();
  if (JSON.stringify(inputKeys) !== JSON.stringify(baseKeys)
      && JSON.stringify(inputKeys) !== JSON.stringify(messageKeys)
      || input.messageFailure !== undefined && input.messageFailure !== true
      || input.messageFailure === true
        && (typeof input.messageCwd !== 'string' || input.messageCwd.length === 0)) {
    throw new Error('CRASH_INPUT_INVALID');
  }
  return publicMutation10d[operation]({ root, runId, input });
}

registerAnchoredCrashExtension(request => {
  if (!Object.hasOwn(publicMutation10d, request.operation)) return false;
  dispatchPublicMutationCrash10d(request);
  return true;
});

export function dispatchAnchoredCrash(request) {
  if (Object.hasOwn(generic, request.operation)) return generic[request.operation](request);
  for (const dispatch of EXTENSIONS) if (dispatch(request) === true) return;
  throw new Error('CRASH_OPERATION_INVALID');
}

export function runAnchoredCrashWorker(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 4) throw new Error('CRASH_USAGE_INVALID');
  const [root, runId, operation, point] = argv;
  if (!isAbsolute(root) || !RUN_ID.test(runId) || !BASE_POINTS.has(point)
      || typeof env.DEEP_LOOP_CRASH_OWNER !== 'string'
      || !/^[1-9]\d*$/.test(env.DEEP_LOOP_CRASH_GENERATION || '')) {
    throw new Error('CRASH_INPUT_INVALID');
  }
  process.env.NODE_ENV = 'test';
  process.env.DEEP_LOOP_TEST_CRASH_AT = point;
  dispatchAnchoredCrash({ root, runId, operation, point,
    owner: env.DEEP_LOOP_CRASH_OWNER,
    generation: Number(env.DEEP_LOOP_CRASH_GENERATION),
    rawInput: env.DEEP_LOOP_CRASH_INPUT ?? '{}',
  });
  throw new Error('CRASH_POINT_NOT_REACHED');
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href) {
  queueMicrotask(() => {
    try { runAnchoredCrashWorker(); }
    catch (error) {
      process.stderr.write(`${String(error?.message || error)}\n`);
      process.exitCode = 1;
    }
  });
}
