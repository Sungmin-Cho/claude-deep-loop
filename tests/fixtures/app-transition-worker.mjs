import { existsSync, writeFileSync } from 'node:fs';
import {
  acquireAppTask, awaitAppTask, confirmAppTask, prepareAppTask,
  observeHostSurface, revokeAppTaskContinuation, sweepUnconfirmedAppTask,
} from '../../scripts/lib/app-task-continuation.mjs';
import { emitHandoff } from '../../scripts/lib/handoff.mjs';
import { readVerifiedState } from '../../scripts/lib/integrity.mjs';
import { runPreCompactHandoff } from '../../scripts/hooks-impl/precompact-handoff.mjs';

const [op, root, runId] = process.argv.slice(2);
if (!['emit', 'prepare', 'confirm', 'revoke', 'sweep', 'acquire', 'await',
  'observe', 'precompact'].includes(op)) {
  throw new Error('WORKER_OP_INVALID');
}
const payloadPromise = new Promise((resolve, reject) => {
  let bytes = 0;
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > 32_768) return reject(new Error('WORKER_PAYLOAD_TOO_LARGE'));
    text += chunk;
  });
  process.stdin.on('end', () => {
    if (!text.endsWith('\n') || /[\r\n]/u.test(text.slice(0, -1))) {
      return reject(new Error('WORKER_PAYLOAD_LINE_INVALID'));
    }
    try { resolve(JSON.parse(text.slice(0, -1))); }
    catch { reject(new Error('WORKER_PAYLOAD_JSON_INVALID')); }
  });
  process.stdin.on('error', reject);
});
process.stdout.write(`WORKER_READY:v1:${op}\n`);
const payload = await payloadPromise;
const nowFn = () => payload.now;
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function waitForWorkerFiles(paths, label) {
  const deadline = Date.now() + 10_000;
  while (paths.some(path => !existsSync(path))) {
    if (Date.now() >= deadline) throw new Error(`WORKER_BARRIER_TIMEOUT:${label}`);
    Atomics.wait(WAIT_ARRAY, 0, 0, 5);
  }
}
function reachWorkerBarrier(spec, label) {
  if (!spec) return;
  writeFileSync(spec.mine, 'ready', { flag: 'wx' });
  waitForWorkerFiles([spec.peer, spec.release], label);
}
const beforeAppendFn = ({ operation }) =>
  reachWorkerBarrier(payload.operationBarrier, `before-append-${operation}`);
const operations = {
  emit: () => emitHandoff(root, runId, {
    reason: payload.input.reason, trigger: payload.input.trigger, appIntent: true,
    expect: { owner: payload.input.owner, generation: payload.input.generation },
    now: payload.now, nowFn, cwdFn: () => root,
    attemptIdFactory: () => payload.input.attemptId,
    descriptorBuilder: ({ runtime, root: projectRoot, parentRunId, childRunId }) => ({
      runtime, projectRoot, runId: parentRunId, usageOutputKind: 'json',
      resumeInvocation: childRunId, entries: Object.fromEntries(['interactive', 'headless',
        'cmux', 'iterm2', 'terminal-app', 'wt', 'powershell', 'desktop']
        .map(name => [name, { display: 'manual', unavailable: true }])) }),
    beforeFinalAppendFn: () => reachWorkerBarrier(payload.operationBarrier, 'final-emit'),
  }),
  prepare: () => prepareAppTask(root, runId, payload.input, {
    nowFn, precheckNowFn: nowFn, cwdFn: () => root,
    descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
      projectId: 'race-project', environment: { type: 'local' } }, prompt: 'bounded race prompt' }),
    reconcileBudgetFn: () => ({ turns: 0, tokens: 0 }),
    gateFn: () => ({ ok: true, blocked_by: [] }),
    beforeAppendFn,
  }),
  confirm: () => confirmAppTask(root, runId, payload.input,
    { nowFn, cwdFn: () => root, beforeAppendFn }),
  revoke: () => revokeAppTaskContinuation(root, runId, payload.input,
    { nowFn, beforeAppendFn }),
  sweep: () => sweepUnconfirmedAppTask(root, runId, payload.input,
    { nowFn, cwdFn: () => root, beforeAppendFn }),
  acquire: () => acquireAppTask(root, runId, payload.input, { nowFn, cwdFn: () => root }),
  observe: () => observeHostSurface(root, runId, payload.input, {
    kernelCwd: root, platform: process.platform, realpath: value => value,
    stat: () => ({ dev: 1, ino: 1 }), sameFile: () => true, nowFn,
  }),
  precompact: () => runPreCompactHandoff({ unattended: true }, {
    root, now: payload.now, cwdFn: () => root,
    gateFn: () => { throw new Error('GENERIC_GATE_FORBIDDEN'); },
    emitFn: (emitRoot, emitRunId, options) => emitHandoff(emitRoot, emitRunId, {
      ...options,
      descriptorBuilder: ({ runtime, root: projectRoot, parentRunId, childRunId }) => ({
        runtime, projectRoot, runId: parentRunId, usageOutputKind: 'json',
        resumeInvocation: childRunId, entries: Object.fromEntries(['interactive', 'headless',
          'cmux', 'iterm2', 'terminal-app', 'wt', 'powershell', 'desktop']
          .map(name => [name, { display: 'manual', unavailable: true }])) }),
      beforeFinalAppendFn: () => reachWorkerBarrier(payload.operationBarrier, 'precompact-final'),
    }),
  }),
  await: () => {
    let poll = payload.now;
    let firstRead = true;
    const readStateFn = () => {
      const loop = readVerifiedState(root, runId).data;
      if (firstRead && payload.snapshotBarrier) {
        firstRead = false;
        writeFileSync(payload.snapshotBarrier.mine, 'ready', { flag: 'wx' });
        waitForWorkerFiles(
          [payload.snapshotBarrier.peer, payload.snapshotBarrier.release], 'await-snapshot');
      }
      return loop;
    };
    const catchReadStateFn = () => {
      if (payload.catchReadBarrier) {
        writeFileSync(payload.catchReadBarrier.ready, 'ready', { flag: 'wx' });
        waitForWorkerFiles([payload.catchReadBarrier.release], 'await-catch-reread');
      }
      return readVerifiedState(root, runId).data;
    };
    return awaitAppTask(root, runId, payload.input, {
      pollNowFn: () => poll, nowFn: () => poll,
      sleepFn: milliseconds => { poll += milliseconds; }, pollIntervalMs: 1_000,
      readStateFn, catchReadStateFn, cwdFn: () => root,
    });
  },
};
try {
  const result = await operations[op]();
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: String(error?.message || error) })}\n`);
}
