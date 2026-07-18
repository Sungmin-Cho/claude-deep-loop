import { randomBytes as durableRandomBytes } from 'node:crypto';
import {
  closeSync as durableCloseSync,
  fsyncSync as durableFsyncSync,
  linkSync as durableLinkSync,
  lstatSync as durableLstatSync,
  openSync as durableOpenSync,
  unlinkSync as durableUnlinkSync,
  writeFileSync as durableWriteFileSync,
} from 'node:fs';
import { dirname as durableDirname } from 'node:path';
import { renameAtomicWithRetry } from './atomic-write.mjs';

const DURABLE_TEST_CRASH_POINT = /^(?:[a-z0-9-]+-(?:before-write|after-write|before-rename|after-rename(?:-before-dir-fsync)?|replace-after-create|replace-after-fsync|replace-after-rename-before-dir-fsync)|pending-delete-(?:before|after))$/;

function crashDurableIfScheduled(point) {
  const selected = process.env.NODE_ENV === 'test'
    ? process.env.DEEP_LOOP_TEST_CRASH_AT : undefined;
  if (selected === undefined || selected !== point) return;
  if (!DURABLE_TEST_CRASH_POINT.test(selected)) {
    throw new Error('DURABLE_TEST_CRASH_POINT_INVALID');
  }
  process.exit(91);
}

function regularIfPresent(path, deps, label) {
  let stat;
  try { stat = (deps.lstat ?? durableLstatSync)(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}: non-regular path`);
  return true;
}

export function syncRegularFile(path, deps = {}) {
  if (!regularIfPresent(path, deps, 'DURABLE_FILE_INVALID')) {
    throw new Error('DURABLE_FILE_MISSING');
  }
  // Windows FlushFileBuffers requires a write-capable handle. `r+` is non-truncating and is also
  // valid for POSIX fsync. Directory handles are opened only by the POSIX parent-sync branch.
  const descriptor = (deps.open ?? durableOpenSync)(path, 'r+');
  try { (deps.fsync ?? durableFsyncSync)(descriptor); }
  finally { (deps.close ?? durableCloseSync)(descriptor); }
}

export function syncParentDirectory(path, deps = {}) {
  if ((deps.platform ?? process.platform) === 'win32') return;
  const directory = (deps.open ?? durableOpenSync)(durableDirname(path), 'r');
  try { (deps.fsync ?? durableFsyncSync)(directory); }
  finally { (deps.close ?? durableCloseSync)(directory); }
}

export function renamePreparedFile(source, destination, {
  renamedPoint = 'file-after-rename-before-dir-fsync',
  sourceAlreadySynced = false,
} = {}, deps = {}) {
  if (!sourceAlreadySynced) syncRegularFile(source, deps);
  if (regularIfPresent(destination, deps, 'DURABLE_DESTINATION_INVALID') === false) {
    // Absence is valid. A live or dangling symlink is rejected by lstat above.
  }
  renameAtomicWithRetry(source, destination, {
    platform: deps.platform ?? process.platform,
    monotonicNowFn: deps.monotonicNowFn,
    sleepFn: deps.sleepFn,
    renameFn: deps.rename,
  });
  crashDurableIfScheduled(renamedPoint);
  syncParentDirectory(destination, deps);
}

export function unlinkRegularFile(path, deps = {}) {
  if (!regularIfPresent(path, deps, 'DURABLE_UNLINK_INVALID')) return false;
  (deps.unlink ?? durableUnlinkSync)(path);
  syncParentDirectory(path, deps);
  return true;
}

export function createFileDurablyIfAbsent(path, bytes, {
  validateExisting = () => {}, mode = 0o600, nonce,
} = {}, deps = {}) {
  const suffix = (nonce ?? (() => durableRandomBytes(12).toString('hex')))();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(suffix)) {
    throw new Error('DURABLE_CREATE_NONCE_INVALID');
  }
  const temporary = `${path}.create-${suffix}`;
  (deps.writeFile ?? durableWriteFileSync)(temporary, bytes, { flag: 'wx', mode });
  try {
    syncRegularFile(temporary, deps);
    try { (deps.link ?? durableLinkSync)(temporary, path); }
    catch (error) {
      if (error?.code === 'EEXIST') {
        if (!regularIfPresent(path, deps, 'DURABLE_EXISTING_INVALID')) {
          throw new Error('DURABLE_EXISTING_MISSING');
        }
        validateExisting(path);
        return false;
      }
      throw error;
    }
    syncParentDirectory(path, deps);
    return true;
  } finally {
    // This invocation owns only `temporary`; a racing destination is never unlinked or renamed.
    unlinkRegularFile(temporary, deps);
  }
}

export function replaceFileDurably(path, bytes, {
  label = 'file', mode = 0o600,
} = {}, deps = {}) {
  const temporary = `${path}.replace`;
  unlinkRegularFile(temporary, deps);
  (deps.writeFile ?? durableWriteFileSync)(temporary, bytes, { flag: 'wx', mode });
  crashDurableIfScheduled(`${label}-replace-after-create`);
  syncRegularFile(temporary, deps);
  crashDurableIfScheduled(`${label}-replace-after-fsync`);
  renamePreparedFile(temporary, path, {
    sourceAlreadySynced: true,
    renamedPoint: `${label}-replace-after-rename-before-dir-fsync`,
  }, deps);
}
