import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

export const RENAME_RETRY_MAX_ELAPSED_MS = 1_000;

const RENAME_RETRY_BACKOFF_MS = 50;
const TRANSIENT_WINDOWS_RENAME_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

function defaultMonotonicNow() { return performance.now(); }
function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function renameAtomicWithRetry(src, dst, {
  platform = process.platform,
  monotonicNowFn = defaultMonotonicNow,
  sleepFn = defaultSleep,
  renameFn = renameSync,
} = {}) {
  const deadline = monotonicNowFn() + RENAME_RETRY_MAX_ELAPSED_MS;
  let retryError = null;
  for (;;) {
    if (retryError && monotonicNowFn() >= deadline) throw retryError;
    try {
      return renameFn(src, dst);
    } catch (error) {
      if (platform !== 'win32' || !TRANSIENT_WINDOWS_RENAME_CODES.has(error?.code)) throw error;
      const now = monotonicNowFn();
      if (!Number.isFinite(now) || now + RENAME_RETRY_BACKOFF_MS >= deadline) throw error;
      sleepFn(RENAME_RETRY_BACKOFF_MS);
      if (monotonicNowFn() >= deadline) throw error;
      retryError = error;
    }
  }
}

export function atomicWrite(path, contents, { writeFn = writeFileSync, ...renameOptions } = {}) {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  writeFn(tmp, contents);
  return renameAtomicWithRetry(tmp, path, renameOptions);
}
