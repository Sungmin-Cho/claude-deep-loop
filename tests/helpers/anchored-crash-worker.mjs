import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentHash } from '../../scripts/lib/envelope.mjs';
import { finishRun } from '../../scripts/lib/finish.mjs';
import { appendAnchored } from '../../scripts/lib/integrity.mjs';
import { emitInsights } from '../../scripts/lib/insights.mjs';
import { acquireLease, releaseLease, reserveHandoff } from '../../scripts/lib/lease.mjs';
import { recordReviewVerdict, tripBreaker } from '../../scripts/lib/breaker.mjs';
import { recordReviewed } from '../../scripts/lib/comprehension.mjs';
import { patch } from '../../scripts/lib/state.mjs';
import { newWorkstream } from '../../scripts/lib/workspace.mjs';
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
  finish: ({ root, runId, owner, generation }) => finishRun(root, runId, {
    status: 'stopped', reportRel: null, confirm: true,
    proof: { human_reason: 'crash-worker' },
    fence: { owner, generation, runtime: 'codex', intent: 'business' },
  }),
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
  'workstream-new': ({ root, runId, owner, generation, rawInput }) => {
    const input = parseInput(rawInput,
      ['baseCommit', 'branch', 'dependsOn', 'requestId', 'title', 'worktree']);
    return newWorkstream(root, runId, { ...input, fence: { owner, generation } });
  },
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
