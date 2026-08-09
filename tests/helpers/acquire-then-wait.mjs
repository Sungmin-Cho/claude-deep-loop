import { createHash } from 'node:crypto';
import {
  closeSync, fsyncSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLease } from '../../scripts/lib/lease.mjs';

export const ACQUIRE_DURABLE_MESSAGE = 'acquire-marker-durable';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function boundedChildEvent(child, eventName, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('INVALID_CHILD_EVENT_TIMEOUT');
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolveEvent, rejectEvent) => {
    const cleanup = () => {
      child.off(eventName, onEvent);
      child.off('error', onError);
      timeoutSignal.removeEventListener('abort', onTimeout);
    };
    const onEvent = (...args) => {
      cleanup();
      resolveEvent(args);
    };
    const onError = (error) => {
      cleanup();
      rejectEvent(error);
    };
    const onTimeout = () => {
      cleanup();
      rejectEvent(new Error(`CHILD_${eventName.toUpperCase()}_TIMEOUT`));
    };
    child.once(eventName, onEvent);
    child.once('error', onError);
    timeoutSignal.addEventListener('abort', onTimeout, { once: true });
  });
}

export function writeDurableAcquireMarker(markerPath, payload) {
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  const fd = openSync(markerPath, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { bytes, sha256: sha256(bytes) };
}

export async function waitForDurableAcquireMarker(child, markerPath, { timeoutMs = 30_000 } = {}) {
  const [[message], [exitCode, exitSignal]] = await Promise.race([
    boundedChildEvent(child, 'message', timeoutMs).then(value => [value, [null, null]]),
    boundedChildEvent(child, 'exit', timeoutMs).then(value => [[null], value]),
  ]);
  if (message === null) {
    throw new Error(`CHILD_EXITED_BEFORE_DURABLE_MARKER: code=${exitCode} signal=${exitSignal}`);
  }
  if (message?.type !== ACQUIRE_DURABLE_MESSAGE) {
    throw new Error(`UNEXPECTED_CHILD_MESSAGE: ${JSON.stringify(message)}`);
  }
  if (message.pid !== child.pid) throw new Error('CHILD_PID_MISMATCH');
  if (message.marker_path !== markerPath) throw new Error('CHILD_MARKER_PATH_MISMATCH');

  const bytes = readFileSync(markerPath);
  if (sha256(bytes) !== message.marker_sha256) throw new Error('CHILD_MARKER_DIGEST_MISMATCH');
  const marker = JSON.parse(bytes.toString('utf8'));
  if (marker.pid !== child.pid) throw new Error('CHILD_MARKER_PID_MISMATCH');
  if (marker.phase !== 'acquire-returned-before-activation') {
    throw new Error('CHILD_MARKER_PHASE_MISMATCH');
  }
  return { marker, message, bytes };
}

export function terminationContract(platform) {
  if (platform === 'win32') {
    return {
      request: 'SIGKILL',
      mechanism: 'windows-forceful-abrupt-termination',
      expected_exit: { code: null, signal: 'SIGKILL' },
    };
  }
  return {
    request: 'SIGKILL',
    mechanism: 'posix-sigkill',
    expected_exit: { code: null, signal: 'SIGKILL' },
  };
}

export async function terminateExactChild(child, { platform = process.platform, timeoutMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error('CHILD_PID_INVALID');
  const contract = terminationContract(platform);
  const targetPid = child.pid;
  const exited = boundedChildEvent(child, 'exit', timeoutMs);
  const sent = child.kill(contract.request);
  if (!sent) throw new Error(`CHILD_TERMINATION_NOT_SENT: pid=${targetPid}`);
  const [code, signal] = await exited;
  return { ...contract, target_pid: targetPid, sent, code, signal };
}

function parseChildArgs(argv) {
  if (argv.length !== 8) throw new Error('ACQUIRE_THEN_WAIT_ARGS_INVALID');
  const [root, runId, owner, generationRaw, attemptId, nowRaw, safetyNowRaw, markerPath] = argv;
  const generation = Number(generationRaw);
  const now = Number(nowRaw);
  const safetyNow = Number(safetyNowRaw);
  if (!Number.isSafeInteger(generation) || generation < 1
    || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(safetyNow) || safetyNow < 0) {
    throw new Error('ACQUIRE_THEN_WAIT_ARGS_INVALID');
  }
  return { root, runId, owner, generation, attemptId, now, safetyNow, markerPath };
}

async function runChild() {
  const args = parseChildArgs(process.argv.slice(2));
  const acquired = acquireLease(args.root, args.runId, {
    owner: args.owner,
    expectGeneration: args.generation,
    runtime: 'claude',
    attemptId: args.attemptId,
    now: args.now,
    clock: () => args.safetyNow,
  });
  if (acquired.proceed !== true || acquired.replayed !== false) {
    throw new Error(`CHILD_ACQUIRE_DID_NOT_PROCEED: ${JSON.stringify(acquired)}`);
  }

  const payload = {
    schema_version: 1,
    phase: 'acquire-returned-before-activation',
    pid: process.pid,
    run_id: args.runId,
    owner_run_id: args.owner,
    from_generation: args.generation,
    to_generation: acquired.generation,
    attempt_id: args.attemptId,
    proceed: acquired.proceed,
    replayed: acquired.replayed,
  };
  const marker = writeDurableAcquireMarker(args.markerPath, payload);
  if (typeof process.send !== 'function') throw new Error('CHILD_IPC_UNAVAILABLE');
  process.send({
    type: ACQUIRE_DURABLE_MESSAGE,
    pid: process.pid,
    marker_path: args.markerPath,
    marker_sha256: marker.sha256,
  });

  // The referenced IPC listener keeps the acquired child alive without polling or a sleep timer.
  process.on('message', () => {});
  process.on('disconnect', () => process.exit(0));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  runChild().catch((error) => {
    if (typeof process.send === 'function') {
      process.send({ type: 'acquire-error', pid: process.pid, error: error?.stack || String(error) });
    }
    process.exitCode = 1;
    process.disconnect?.();
  });
}
