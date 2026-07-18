import { randomBytes as durableRandomBytes } from 'node:crypto';
import {
  closeSync as durableCloseSync,
  fstatSync as durableFstatSync,
  fsyncSync as durableFsyncSync,
  linkSync as durableLinkSync,
  lstatSync as durableLstatSync,
  openSync as durableOpenSync,
  readFileSync as durableReadFileSync,
  renameSync as durableRenameSync,
  unlinkSync as durableUnlinkSync,
  writeFileSync as durableWriteFileSync,
} from 'node:fs';
import { dirname as durableDirname } from 'node:path';
import { renameAtomicWithRetry } from './atomic-write.mjs';

const DURABLE_TEST_CRASH_POINT = /^(?:[a-z0-9-]+-(?:before-write|after-write|before-rename|after-rename(?:-before-dir-fsync)?|replace-after-create|replace-after-fsync|replace-after-rename-before-dir-fsync)|pending-delete-(?:before|after))$/;

function crashDurableIfScheduled(point) {
  if (point === null) return;
  const selected = process.env.NODE_ENV === 'test'
    ? process.env.DEEP_LOOP_TEST_CRASH_AT : undefined;
  if (selected === undefined || selected !== point) return;
  if (!DURABLE_TEST_CRASH_POINT.test(selected)) {
    throw new Error('DURABLE_TEST_CRASH_POINT_INVALID');
  }
  process.exit(91);
}

const durableDep = (deps, name, legacy, fallback) =>
  deps[name] ?? deps[legacy] ?? fallback;

function queryLstat(path, deps) {
  try { return durableDep(deps, 'durableLstat', 'lstat', durableLstatSync)(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function regularStat(stat, code) {
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) throw new Error(code);
  return stat;
}

function sameIdentity(left, right, deps) {
  const compare = deps.durableSameFile ?? deps.sameFile
    ?? ((a, b) => a.dev === b.dev && a.ino === b.ino);
  return compare(left, right);
}

function recordMatches(left, right, deps) {
  return left === null && right === null
    || left !== null && right !== null && sameIdentity(left.stat, right.stat, deps)
      && left.bytes.equals(right.bytes);
}

function regularRecord(path, deps, {
  optional = false,
  invalidCode = 'DURABLE_FILE_INVALID',
  changedCode = 'DURABLE_FILE_CHANGED',
} = {}) {
  const before = queryLstat(path, deps);
  if (before === null) {
    if (optional) return null;
    throw new Error('DURABLE_FILE_MISSING');
  }
  regularStat(before, invalidCode);
  const read = () => {
    try {
      return Buffer.from(durableDep(deps, 'durableReadFile', 'readFile',
        durableReadFileSync)(path));
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(changedCode);
      throw error;
    }
  };
  const firstBytes = read();
  const middle = queryLstat(path, deps);
  const secondBytes = read();
  const after = queryLstat(path, deps);
  if (middle === null || after === null || !middle.isFile() || middle.isSymbolicLink()
      || !after.isFile() || after.isSymbolicLink()
      || !sameIdentity(before, middle, deps) || !sameIdentity(middle, after, deps)
      || !firstBytes.equals(secondBytes)) {
    throw new Error(changedCode);
  }
  return { stat: after, bytes: secondBytes };
}

function requireRecord(path, expected, deps, codes) {
  const actual = regularRecord(path, deps, codes);
  if (!recordMatches(expected, actual, deps)) throw new Error(codes.changedCode);
  return actual;
}

export function readDurableRegularRecord(path, options = {}, deps = {}) {
  return regularRecord(path, deps, options);
}

export function syncRegularFile(path, deps = {}, expectedRecord = null) {
  const expected = expectedRecord ?? regularRecord(path, deps, {
    invalidCode: 'DURABLE_FILE_INVALID', changedCode: 'DURABLE_SOURCE_CHANGED',
  });
  // Windows FlushFileBuffers requires a write-capable handle. `r+` is non-truncating and is also
  // valid for POSIX fsync. Directory handles are opened only by the POSIX parent-sync branch.
  const descriptor = durableDep(deps, 'durableOpen', 'open', durableOpenSync)(path, 'r+');
  try {
    const before = regularStat(
      durableDep(deps, 'durableFstat', 'fstat', durableFstatSync)(descriptor),
      'DURABLE_FILE_INVALID');
    if (!sameIdentity(expected.stat, before, deps)) throw new Error('DURABLE_SOURCE_CHANGED');
    durableDep(deps, 'durableFsync', 'fsync', durableFsyncSync)(descriptor);
    const after = regularStat(
      durableDep(deps, 'durableFstat', 'fstat', durableFstatSync)(descriptor),
      'DURABLE_FILE_INVALID');
    if (!sameIdentity(before, after, deps)) throw new Error('DURABLE_SOURCE_CHANGED');
  } finally {
    durableDep(deps, 'durableClose', 'close', durableCloseSync)(descriptor);
  }
  return requireRecord(path, expected, deps, {
    invalidCode: 'DURABLE_FILE_INVALID', changedCode: 'DURABLE_SOURCE_CHANGED',
  });
}

export function syncParentDirectory(path, deps = {}) {
  if ((deps.platform ?? process.platform) === 'win32') return;
  const directory = durableDep(deps, 'durableOpen', 'open', durableOpenSync)(
    durableDirname(path), 'r');
  try { durableDep(deps, 'durableFsync', 'fsync', durableFsyncSync)(directory); }
  finally { durableDep(deps, 'durableClose', 'close', durableCloseSync)(directory); }
}

export function renamePreparedFile(source, destination, {
  renamedPoint = 'file-after-rename-before-dir-fsync',
  sourceAlreadySynced = false,
  sourceRecord = null,
} = {}, deps = {}) {
  const sourceInitial = sourceRecord ?? regularRecord(source, deps, {
    invalidCode: 'DURABLE_FILE_INVALID', changedCode: 'DURABLE_SOURCE_CHANGED',
  });
  const destinationInitial = regularRecord(destination, deps, {
    optional: true, invalidCode: 'DURABLE_DESTINATION_INVALID',
    changedCode: 'DURABLE_DESTINATION_CHANGED',
  });
  const sourceReady = sourceAlreadySynced
    ? requireRecord(source, sourceInitial, deps, {
      invalidCode: 'DURABLE_FILE_INVALID', changedCode: 'DURABLE_SOURCE_CHANGED',
    })
    : syncRegularFile(source, deps, sourceInitial);
  // Only the before hook models an interleaving. The primitive is the faithful syscall seam;
  // the after hook is observation-only and must not be used to mutate either pathname.
  const rename = deps.durableRenamePrimitive ?? durableRenameSync;
  renameAtomicWithRetry(source, destination, {
    platform: deps.platform ?? process.platform,
    monotonicNowFn: deps.monotonicNowFn,
    sleepFn: deps.sleepFn,
    renameFn: (from, to) => {
      deps.durableBeforeRename?.(from, to);
      requireRecord(from, sourceReady, deps, {
        invalidCode: 'DURABLE_FILE_INVALID', changedCode: 'DURABLE_SOURCE_CHANGED',
      });
      const destinationReady = regularRecord(to, deps, {
        optional: true, invalidCode: 'DURABLE_DESTINATION_INVALID',
        changedCode: 'DURABLE_DESTINATION_CHANGED',
      });
      if (!recordMatches(destinationInitial, destinationReady, deps)) {
        throw new Error('DURABLE_DESTINATION_CHANGED');
      }
      const result = rename(from, to);
      deps.durableAfterRename?.(from, to);
      return result;
    },
  });
  crashDurableIfScheduled(renamedPoint);
  const published = regularRecord(destination, deps, {
    invalidCode: 'DURABLE_DESTINATION_INVALID',
    changedCode: 'DURABLE_DESTINATION_CHANGED',
  });
  if (!recordMatches(sourceReady, published, deps)) {
    throw new Error('DURABLE_DESTINATION_CHANGED');
  }
  if (regularRecord(source, deps, {
    optional: true, invalidCode: 'DURABLE_FILE_INVALID',
    changedCode: 'DURABLE_SOURCE_CHANGED',
  }) !== null) {
    throw new Error('DURABLE_SOURCE_CHANGED');
  }
  syncParentDirectory(destination, deps);
}

export function unlinkRegularFile(path, deps = {}, expectedRecord = null) {
  const initial = regularRecord(path, deps, {
    optional: true, invalidCode: 'DURABLE_UNLINK_INVALID',
    changedCode: 'DURABLE_OWNERSHIP_CHANGED',
  });
  if (initial === null) return false;
  if (expectedRecord !== null && !recordMatches(expectedRecord, initial, deps)) {
    throw new Error('DURABLE_OWNERSHIP_CHANGED');
  }
  requireRecord(path, initial, deps, {
    invalidCode: 'DURABLE_UNLINK_INVALID', changedCode: 'DURABLE_OWNERSHIP_CHANGED',
  });
  deps.durableBeforeUnlink?.(path);
  requireRecord(path, initial, deps, {
    invalidCode: 'DURABLE_UNLINK_INVALID', changedCode: 'DURABLE_OWNERSHIP_CHANGED',
  });
  // As with rename, the dedicated primitive is the syscall itself; generic lock `unlink` seams are
  // deliberately not consumed by this durability boundary.
  (deps.durableUnlinkPrimitive ?? durableUnlinkSync)(path);
  deps.durableAfterUnlink?.(path);
  if (regularRecord(path, deps, {
    optional: true, invalidCode: 'DURABLE_UNLINK_INVALID',
    changedCode: 'DURABLE_OWNERSHIP_CHANGED',
  }) !== null) {
    throw new Error('DURABLE_OWNERSHIP_CHANGED');
  }
  syncParentDirectory(path, deps);
  return true;
}

export function createPreparedFile(path, bytes, {
  mode = 0o600,
  beforeWritePoint = null,
  afterWritePoint = null,
  afterSyncPoint = null,
} = {}, deps = {}) {
  const payload = Buffer.from(bytes);
  let descriptor = null;
  let creationStat = null;
  let primaryError = null;
  crashDurableIfScheduled(beforeWritePoint);
  try {
    descriptor = durableDep(deps, 'durableOpen', 'open', durableOpenSync)(path, 'wx', mode);
    creationStat = regularStat(
      durableDep(deps, 'durableFstat', 'fstat', durableFstatSync)(descriptor),
      'DURABLE_FILE_INVALID');
    durableDep(deps, 'durableWriteDescriptor', 'writeDescriptor',
      durableWriteFileSync)(descriptor, payload);
    crashDurableIfScheduled(afterWritePoint);
    durableDep(deps, 'durableFsync', 'fsync', durableFsyncSync)(descriptor);
    crashDurableIfScheduled(afterSyncPoint);
  } catch (error) {
    primaryError = error;
  } finally {
    if (descriptor !== null) {
      try { durableDep(deps, 'durableClose', 'close', durableCloseSync)(descriptor); }
      catch (error) { if (primaryError === null) primaryError = error; }
    }
  }
  let owned = null;
  if (creationStat !== null) {
    try {
      const candidate = regularRecord(path, deps, {
        invalidCode: 'DURABLE_FILE_INVALID', changedCode: 'DURABLE_OWNERSHIP_CHANGED',
      });
      if (sameIdentity(creationStat, candidate.stat, deps)) owned = candidate;
    } catch { /* absence, replacement, or malformed path is not proven owned */ }
  }
  if (primaryError === null && (owned === null || !owned.bytes.equals(payload))) {
    primaryError = new Error('DURABLE_SOURCE_CHANGED');
  }
  if (primaryError !== null) {
    if (owned !== null) unlinkRegularFile(path, deps, owned);
    throw primaryError;
  }
  return owned;
}

export function createFileDurablyIfAbsent(path, bytes, {
  validateExisting = () => {}, mode = 0o600, nonce,
} = {}, deps = {}) {
  const suffix = (nonce ?? (() => durableRandomBytes(12).toString('hex')))();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(suffix)) {
    throw new Error('DURABLE_CREATE_NONCE_INVALID');
  }
  const temporary = `${path}.create-${suffix}`;
  const owned = createPreparedFile(temporary, bytes, { mode }, deps);
  try {
    requireRecord(temporary, owned, deps, {
      invalidCode: 'DURABLE_FILE_INVALID', changedCode: 'DURABLE_OWNERSHIP_CHANGED',
    });
    try {
      durableDep(deps, 'durableLink', 'link', durableLinkSync)(temporary, path);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        regularRecord(path, deps, {
          invalidCode: 'DURABLE_EXISTING_INVALID', changedCode: 'DURABLE_EXISTING_CHANGED',
        });
        validateExisting(path);
        return false;
      }
      throw error;
    }
    const published = regularRecord(path, deps, {
      invalidCode: 'DURABLE_DESTINATION_INVALID',
      changedCode: 'DURABLE_DESTINATION_CHANGED',
    });
    if (!recordMatches(owned, published, deps)) throw new Error('DURABLE_DESTINATION_CHANGED');
    syncParentDirectory(path, deps);
    return true;
  } finally {
    // Cleanup is authorized only while the pathname is still the captured inode and exact bytes.
    unlinkRegularFile(temporary, deps, owned);
  }
}

export function replaceFileDurably(path, bytes, {
  label = 'file', mode = 0o600,
} = {}, deps = {}) {
  const temporary = `${path}.replace`;
  const owned = createPreparedFile(temporary, bytes, {
    mode,
    afterWritePoint: `${label}-replace-after-create`,
    afterSyncPoint: `${label}-replace-after-fsync`,
  }, deps);
  try {
    renamePreparedFile(temporary, path, {
      sourceAlreadySynced: true,
      sourceRecord: owned,
      renamedPoint: `${label}-replace-after-rename-before-dir-fsync`,
    }, deps);
  } finally {
    const remaining = regularRecord(temporary, deps, {
      optional: true, invalidCode: 'DURABLE_UNLINK_INVALID',
      changedCode: 'DURABLE_OWNERSHIP_CHANGED',
    });
    if (remaining !== null) unlinkRegularFile(temporary, deps, owned);
  }
}
