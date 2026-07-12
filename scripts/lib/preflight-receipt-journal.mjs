import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { makeCodexPreflightReceipt, makeCodexProcessReceipt } from './budget.mjs';
import { contentHash } from './envelope.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { runDir } from './state.mjs';

const RECEIPT_MAX_BYTES = 16 * 1024;
const RECEIPT_MAX_FILES = 256;
const DESCRIPTOR_KEYS = new Set([
  'journalPath',
  'root',
  'runId',
  'cacheKey',
  'smokeKind',
  'attemptId',
  'predecessorReceiptId',
  'owner',
  'generation',
]);
const PROCESS_DESCRIPTOR_KEYS = new Set(['journalPath', 'root', 'runId', 'processKind', 'context']);

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function canonicalRealpath(path) {
  const realpath = realpathSync.native || realpathSync;
  return realpath(path);
}

function journalDirectory(root, runId) {
  return join(runDir(root, runId), 'preflight', 'process-receipts');
}

function expectedJournalPath(root, runId, attemptId, smokeKind) {
  return join(journalDirectory(root, runId), `${attemptId}-${smokeKind}.json`);
}

function processDescriptorId(processKind, context) {
  return contentHash(JSON.stringify({ process_kind: processKind, context }));
}

function expectedProcessJournalPath(root, runId, processKind, context) {
  return join(journalDirectory(root, runId), `${processDescriptorId(processKind, context)}-${processKind}.json`);
}

function descriptorFailure(error) {
  throw new Error('PREFLIGHT_USAGE_RECEIPT_DESCRIPTOR_INVALID', { cause: error });
}

export function validatePreflightUsageReceiptDescriptor(value) {
  try {
    if (value == null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== DESCRIPTOR_KEYS.size
      || Object.keys(value).some(key => !DESCRIPTOR_KEYS.has(key))
      || typeof value.journalPath !== 'string' || !isAbsolute(value.journalPath)
      || typeof value.root !== 'string' || value.root.length === 0
      || typeof value.runId !== 'string' || value.runId.length === 0
      || typeof value.cacheKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.cacheKey)
      || !['read', 'write'].includes(value.smokeKind)
      || typeof value.attemptId !== 'string' || !/^[a-f0-9]{32,64}$/.test(value.attemptId)
      || typeof value.owner !== 'string' || value.owner.length === 0
      || !Number.isInteger(value.generation) || value.generation < 1
      || (value.smokeKind === 'read' && value.predecessorReceiptId !== null)
      || (value.smokeKind === 'write'
        && (typeof value.predecessorReceiptId !== 'string'
          || !/^[a-f0-9]{64}$/.test(value.predecessorReceiptId)))) {
      throw new Error('shape');
    }
    const root = canonicalProjectRoot(value.root);
    const journalPath = expectedJournalPath(root, value.runId, value.attemptId, value.smokeKind);
    if (resolve(value.root) !== root || resolve(value.journalPath) !== journalPath) {
      throw new Error('path');
    }
    return {
      journalPath,
      root,
      runId: value.runId,
      cacheKey: value.cacheKey,
      smokeKind: value.smokeKind,
      attemptId: value.attemptId,
      predecessorReceiptId: value.predecessorReceiptId,
      owner: value.owner,
      generation: value.generation,
    };
  } catch (error) {
    descriptorFailure(error);
  }
}

export function validateProcessUsageReceiptDescriptor(value) {
  if (value != null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'smokeKind')) {
    return validatePreflightUsageReceiptDescriptor(value);
  }
  try {
    if (value == null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== PROCESS_DESCRIPTOR_KEYS.size
      || Object.keys(value).some(key => !PROCESS_DESCRIPTOR_KEYS.has(key))
      || typeof value.journalPath !== 'string' || !isAbsolute(value.journalPath)
      || typeof value.root !== 'string' || value.root.length === 0
      || typeof value.runId !== 'string' || value.runId.length === 0
      || !['maker', 'checker'].includes(value.processKind)) {
      throw new Error('shape');
    }
    const root = canonicalProjectRoot(value.root);
    const normalized = makeCodexProcessReceipt({
      root,
      runId: value.runId,
      processKind: value.processKind,
      context: value.context,
      usage: { num_turns: 1, input_tokens: 0, output_tokens: 0, tokens: 0 },
    });
    const journalPath = expectedProcessJournalPath(
      root,
      value.runId,
      value.processKind,
      normalized.context,
    );
    if (resolve(value.root) !== root || resolve(value.journalPath) !== journalPath) {
      throw new Error('path');
    }
    return {
      journalPath,
      root,
      runId: value.runId,
      processKind: value.processKind,
      context: normalized.context,
    };
  } catch (error) {
    throw new Error('PROCESS_USAGE_RECEIPT_DESCRIPTOR_INVALID', { cause: error });
  }
}

export function makeProcessUsageReceiptDescriptor({ root, runId, processKind, context } = {}) {
  const canonicalRoot = canonicalProjectRoot(root);
  const normalized = makeCodexProcessReceipt({
    root: canonicalRoot,
    runId,
    processKind,
    context,
    usage: { num_turns: 1, input_tokens: 0, output_tokens: 0, tokens: 0 },
  });
  return validateProcessUsageReceiptDescriptor({
    journalPath: expectedProcessJournalPath(canonicalRoot, runId, processKind, normalized.context),
    root: canonicalRoot,
    runId,
    processKind,
    context: normalized.context,
  });
}

function trustedJournalDirectory(path, root, runId) {
  const expected = journalDirectory(root, runId);
  if (resolve(path) !== expected) throw new Error('journal directory mismatch');
  const before = lstatSync(expected, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('journal parent invalid');
  const canonical = canonicalRealpath(expected);
  const after = lstatSync(canonical, { bigint: true });
  if (canonical !== expected || after.isSymbolicLink() || !after.isDirectory()
    || !sameFileIdentity(before, after)) throw new Error('journal parent changed');
  return canonical;
}

function readTrustedReceiptBytes(path, parent) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()
    || before.size <= 0n || before.size > BigInt(RECEIPT_MAX_BYTES)) {
    throw new Error('receipt file invalid');
  }
  const canonical = canonicalRealpath(path);
  const canonicalStat = lstatSync(canonical, { bigint: true });
  const rel = relative(parent, canonical);
  if (canonical !== path || rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || canonicalStat.isSymbolicLink() || !canonicalStat.isFile()
    || !sameFileIdentity(before, canonicalStat)) throw new Error('receipt identity invalid');
  let fd;
  let bytes;
  try {
    fd = openSync(canonical, 'r');
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(canonicalStat, opened)) throw new Error('receipt changed before read');
    bytes = readFileSync(fd);
    const afterRead = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(opened, afterRead)) throw new Error('receipt changed during read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const afterPath = lstatSync(path, { bigint: true });
  if (!sameFileIdentity(canonicalStat, afterPath)) throw new Error('receipt changed after read');
  return bytes;
}

function exactReceipt(descriptor, receipt) {
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.usage == null || typeof receipt.usage !== 'object' || Array.isArray(receipt.usage)) {
    throw new Error('receipt shape invalid');
  }
  const expected = makeCodexPreflightReceipt({ ...descriptor, usage: receipt.usage });
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error('receipt payload invalid');
  return expected;
}

function exactProcessReceipt(descriptor, receipt) {
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.usage == null || typeof receipt.usage !== 'object' || Array.isArray(receipt.usage)) {
    throw new Error('receipt shape invalid');
  }
  const expected = makeCodexProcessReceipt({ ...descriptor, usage: receipt.usage });
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error('receipt payload invalid');
  return expected;
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
}

export function readPreflightUsageReceipt(value) {
  let descriptor;
  try {
    descriptor = validatePreflightUsageReceiptDescriptor(value);
    const parent = trustedJournalDirectory(
      join(runDir(descriptor.root, descriptor.runId), 'preflight', 'process-receipts'),
      descriptor.root,
      descriptor.runId,
    );
    let bytes;
    try {
      bytes = readTrustedReceiptBytes(descriptor.journalPath, parent);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const receipt = exactReceipt(descriptor, JSON.parse(bytes.toString('utf8')));
    if (!bytes.equals(receiptBytes(receipt))) throw new Error('receipt bytes invalid');
    return receipt;
  } catch (error) {
    if (String(error?.message || error) === 'PREFLIGHT_USAGE_RECEIPT_DESCRIPTOR_INVALID') throw error;
    throw new Error('PREFLIGHT_USAGE_RECEIPT_INVALID', { cause: error });
  }
}

export function writePreflightUsageReceipt(value, usage) {
  try {
    const descriptor = validatePreflightUsageReceiptDescriptor(value);
    trustedJournalDirectory(
      join(runDir(descriptor.root, descriptor.runId), 'preflight', 'process-receipts'),
      descriptor.root,
      descriptor.runId,
    );
    const receipt = makeCodexPreflightReceipt({ ...descriptor, usage });
    const bytes = receiptBytes(receipt);
    const prior = readPreflightUsageReceipt(descriptor);
    if (prior != null) {
      if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error('receipt conflict');
      return prior;
    }
    let fd;
    try {
      fd = openSync(descriptor.journalPath, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* preserve the original failure */ }
      }
      if (error?.code === 'EEXIST') {
        const raced = readPreflightUsageReceipt(descriptor);
        if (raced != null && JSON.stringify(raced) === JSON.stringify(receipt)) return raced;
      }
      throw error;
    }
    const written = readPreflightUsageReceipt(descriptor);
    if (written == null || JSON.stringify(written) !== JSON.stringify(receipt)) {
      throw new Error('receipt post-write validation failed');
    }
    return written;
  } catch (error) {
    throw new Error('PREFLIGHT_USAGE_RECEIPT_WRITE_FAILED', { cause: error });
  }
}

export function readProcessUsageReceipt(value) {
  if (value != null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'smokeKind')) {
    return readPreflightUsageReceipt(value);
  }
  try {
    const descriptor = validateProcessUsageReceiptDescriptor(value);
    const parent = trustedJournalDirectory(journalDirectory(descriptor.root, descriptor.runId),
      descriptor.root, descriptor.runId);
    let bytes;
    try {
      bytes = readTrustedReceiptBytes(descriptor.journalPath, parent);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    const receipt = exactProcessReceipt(descriptor, JSON.parse(bytes.toString('utf8')));
    if (!bytes.equals(receiptBytes(receipt))) throw new Error('receipt bytes invalid');
    return receipt;
  } catch (error) {
    if (String(error?.message || error) === 'PROCESS_USAGE_RECEIPT_DESCRIPTOR_INVALID') throw error;
    throw new Error('PROCESS_USAGE_RECEIPT_INVALID', { cause: error });
  }
}

export function writeProcessUsageReceipt(value, usage) {
  if (value != null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'smokeKind')) {
    return writePreflightUsageReceipt(value, usage);
  }
  try {
    const descriptor = validateProcessUsageReceiptDescriptor(value);
    trustedJournalDirectory(journalDirectory(descriptor.root, descriptor.runId),
      descriptor.root, descriptor.runId);
    const receipt = makeCodexProcessReceipt({ ...descriptor, usage });
    const bytes = receiptBytes(receipt);
    const prior = readProcessUsageReceipt(descriptor);
    if (prior != null) {
      if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error('receipt conflict');
      return prior;
    }
    let fd;
    try {
      fd = openSync(descriptor.journalPath, 'wx', 0o600);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* preserve the original failure */ }
      }
      if (error?.code === 'EEXIST') {
        const raced = readProcessUsageReceipt(descriptor);
        if (raced != null && JSON.stringify(raced) === JSON.stringify(receipt)) return raced;
      }
      throw error;
    }
    const written = readProcessUsageReceipt(descriptor);
    if (written == null || JSON.stringify(written) !== JSON.stringify(receipt)) {
      throw new Error('receipt post-write validation failed');
    }
    return written;
  } catch (error) {
    throw new Error('PROCESS_USAGE_RECEIPT_WRITE_FAILED', { cause: error });
  }
}

export function listPreflightUsageReceipts({ root, runId, journalDir } = {}) {
  try {
    const canonicalRoot = canonicalProjectRoot(root);
    const expectedDir = journalDirectory(canonicalRoot, runId);
    if (typeof journalDir !== 'string' || !isAbsolute(journalDir)
      || resolve(root) !== canonicalRoot || resolve(journalDir) !== expectedDir) {
      throw new Error('journal directory mismatch');
    }
    const parent = trustedJournalDirectory(journalDir, canonicalRoot, runId);
    const entries = readdirSync(parent, { withFileTypes: true });
    if (entries.length > RECEIPT_MAX_FILES) throw new Error('too many receipt files');
    const candidates = entries.flatMap(entry => {
      const match = entry.name.match(/^([a-f0-9]{32,64})-(read|write)\.json$/);
      const processMatch = entry.name.match(/^[a-f0-9]{64}-(maker|checker)\.json$/);
      if (!entry.isFile() || entry.isSymbolicLink() || (!match && !processMatch)) {
        throw new Error('unexpected receipt entry');
      }
      return match ? [{ name: entry.name, attemptId: match[1], smokeKind: match[2] }] : [];
    }).sort((left, right) => left.attemptId.localeCompare(right.attemptId)
      || (left.smokeKind === right.smokeKind ? 0 : (left.smokeKind === 'read' ? -1 : 1)));

    const output = [];
    const reads = new Map();
    for (const candidate of candidates) {
      const journalPath = join(parent, candidate.name);
      const bytes = readTrustedReceiptBytes(journalPath, parent);
      const raw = JSON.parse(bytes.toString('utf8'));
      const descriptor = validatePreflightUsageReceiptDescriptor({
        journalPath,
        root: canonicalRoot,
        runId,
        cacheKey: raw?.cache_key,
        smokeKind: candidate.smokeKind,
        attemptId: candidate.attemptId,
        predecessorReceiptId: raw?.predecessor_receipt_id,
        owner: raw?.owner,
        generation: raw?.generation,
      });
      const receipt = exactReceipt(descriptor, raw);
      if (!bytes.equals(receiptBytes(receipt))) throw new Error('receipt bytes invalid');
      if (candidate.smokeKind === 'read') {
        reads.set(candidate.attemptId, receipt);
      } else {
        const read = reads.get(candidate.attemptId);
        if (read == null || receipt.predecessor_receipt_id !== read.receipt_id
          || receipt.cache_key !== read.cache_key || receipt.owner !== read.owner
          || receipt.generation !== read.generation) throw new Error('write predecessor invalid');
      }
      output.push({ receipt, descriptor, journalPath });
    }
    return output;
  } catch (error) {
    throw new Error('PREFLIGHT_USAGE_RECEIPT_INVALID', { cause: error });
  }
}

export function listProcessUsageReceipts({ root, runId, journalDir } = {}) {
  let canonicalRoot;
  let expectedDir;
  try {
    canonicalRoot = canonicalProjectRoot(root);
    expectedDir = journalDirectory(canonicalRoot, runId);
    if (journalDir != null && (typeof journalDir !== 'string' || !isAbsolute(journalDir)
      || resolve(journalDir) !== expectedDir)) throw new Error('journal directory mismatch');
    let entries;
    try {
      const parent = trustedJournalDirectory(expectedDir, canonicalRoot, runId);
      entries = readdirSync(parent, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    if (entries.length > RECEIPT_MAX_FILES) throw new Error('too many receipt files');
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()
        || (!/^([a-f0-9]{32,64})-(read|write)\.json$/.test(entry.name)
          && !/^[a-f0-9]{64}-(maker|checker)\.json$/.test(entry.name))) {
        throw new Error('unexpected receipt entry');
      }
    }
    const preflight = listPreflightUsageReceipts({
      root: canonicalRoot,
      runId,
      journalDir: expectedDir,
    });
    const output = [...preflight];
    const parent = trustedJournalDirectory(expectedDir, canonicalRoot, runId);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const match = entry.name.match(/^([a-f0-9]{64})-(maker|checker)\.json$/);
      if (!match) continue;
      const journalPath = join(parent, entry.name);
      const bytes = readTrustedReceiptBytes(journalPath, parent);
      const raw = JSON.parse(bytes.toString('utf8'));
      const descriptor = validateProcessUsageReceiptDescriptor({
        journalPath,
        root: canonicalRoot,
        runId,
        processKind: match[2],
        context: raw?.context,
      });
      const receipt = exactProcessReceipt(descriptor, raw);
      if (!bytes.equals(receiptBytes(receipt))) throw new Error('receipt bytes invalid');
      output.push({ receipt, descriptor, journalPath });
    }
    return output.sort((left, right) => left.journalPath.localeCompare(right.journalPath));
  } catch (error) {
    throw new Error('PROCESS_USAGE_RECEIPT_INVALID', { cause: error });
  }
}

export function removeProcessUsageReceipt({ receipt, descriptor = null, journalPath = null } = {}) {
  try {
    const exactDescriptor = descriptor;
    if (exactDescriptor == null || (journalPath != null && exactDescriptor.journalPath !== journalPath)) {
      throw new Error('process descriptor required');
    }
    const stored = readProcessUsageReceipt(exactDescriptor);
    if (stored == null) return { ok: true, removed: false };
    if (JSON.stringify(stored) !== JSON.stringify(receipt)) throw new Error('receipt changed');
    rmSync(exactDescriptor.journalPath);
    if (readProcessUsageReceipt(exactDescriptor) != null) throw new Error('receipt remained');
    return { ok: true, removed: true };
  } catch (error) {
    throw new Error('PROCESS_USAGE_RECEIPT_CLEANUP_FAILED', { cause: error });
  }
}
