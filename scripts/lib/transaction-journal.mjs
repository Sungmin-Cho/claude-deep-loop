import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { durableAtomicWrite, flushDirectory, renameAtomicWithRetry } from './atomic-write.mjs';
import { contentHash, unwrap, wrap } from './envelope.mjs';
import {
  canonicalNonSymlinkDirectory,
  captureStableFileIdentity,
  matchingStableFileIdentity,
  normalizePortableRelativePath,
} from './fs-safe.mjs';

const MANIFEST_KEYS = [
  'kind', 'operationId', 'expect', 'runtime', 'projectRoot', 'preLoopHash', 'preEventHead',
  'eventLines', 'candidateLoopHash', 'topology', 'targets',
];
const STAGE_ROLES = new Set(['artifact', 'event-line', 'candidate-loop', 'candidate-loop-hash']);
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_OWNER_KEYS = [
  'protocol_version', 'token', 'pid', 'hostname', 'acquired_at_ms', 'heartbeat_at_ms', 'lock_identity',
];
const ORPHAN_STALE_TTL_MS = 30_000;
const RESERVED_ARTIFACT_FILES = new Set(['loop.json', '.loop.hash', 'event-log.jsonl']);
const RESERVED_ARTIFACT_DIRECTORIES = new Set(['.lock', 'transactions']);

function transactionError(message) {
  return new Error(`TRANSACTION_INVALID: ${message}`);
}

function reconciliationError(message) {
  return new Error(`TRANSACTION_RECONCILIATION_REQUIRED: ${message}`);
}

function scopeGuard(lockGuard, canonicalRunDir) {
  if (!lockGuard || typeof lockGuard !== 'object'
    || !UUID.test(lockGuard.token || '')
    || typeof lockGuard.assertOwned !== 'function'
    || typeof lockGuard.renew !== 'function') throw new Error('LOCK_GUARD_REQUIRED');
  lockGuard.assertOwned(canonicalRunDir);
  const assertScope = (expectedRunDir = canonicalRunDir) => {
    if (typeof expectedRunDir !== 'string' || resolve(expectedRunDir) !== resolve(canonicalRunDir)) {
      throw new Error('LOCK_RUN_MISMATCH');
    }
  };
  return Object.freeze({
    token: lockGuard.token,
    assertOwned(expectedRunDir) {
      assertScope(expectedRunDir);
      return lockGuard.assertOwned(canonicalRunDir);
    },
    renew(expectedRunDir) {
      assertScope(expectedRunDir);
      return lockGuard.renew(canonicalRunDir);
    },
  });
}

function guarded(lockGuard, action) {
  lockGuard.assertOwned();
  const result = action();
  lockGuard.renew();
  return result;
}

function guardedDurableWrite(lockGuard, durableWriteFn, path, contents, prefix, faultAt) {
  lockGuard.assertOwned();
  durableWriteFn(path, contents, {
    barrierAt(phase) {
      faultAt(`${prefix}:${phase}`);
      lockGuard.renew();
      lockGuard.assertOwned();
    },
  });
  lockGuard.renew();
}

function canonicalHostname(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim().toLowerCase();
  return normalized && !/[\u0000-\u001f\u007f]/.test(normalized) ? normalized : null;
}

function validOperationId(value) {
  return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
    && !value.includes('\0') && !/[/\\]/.test(value) && !/^[A-Za-z]:/.test(value)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function canonicalSize(value) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? value : null;
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function reservedArtifactTarget(rel) {
  const segments = rel.split('/');
  const first = segments[0].toLowerCase();
  return RESERVED_ARTIFACT_DIRECTORIES.has(first)
    || (segments.length === 1 && RESERVED_ARTIFACT_FILES.has(first));
}

function validatePredecessor(value) {
  if (exactKeys(value, ['kind']) && value.kind === 'absent') return;
  if (!exactKeys(value, ['kind', 'sha256', 'identity', 'size']) || value.kind !== 'present'
    || !SHA256.test(value.sha256 || '') || canonicalSize(value.size) === null
    || !matchingStableFileIdentity(value.identity, value.identity)) {
    throw transactionError('target predecessor');
  }
}

function validateAndMaterialize(manifest, inputStages) {
  if (!exactKeys(manifest, MANIFEST_KEYS) || !validOperationId(manifest.operationId)
    || typeof manifest.kind !== 'string' || !manifest.kind
    || !manifest.expect || typeof manifest.expect.owner !== 'string'
    || !Number.isSafeInteger(manifest.expect.generation) || manifest.expect.generation < 1
    || !['claude', 'codex'].includes(manifest.runtime)
    || typeof manifest.projectRoot !== 'string' || !manifest.projectRoot
    || !SHA256.test(manifest.preLoopHash || '') || !SHA256.test(manifest.candidateLoopHash || '')
    || !Array.isArray(manifest.eventLines) || !Array.isArray(manifest.targets)
    || !Array.isArray(inputStages) || inputStages.length === 0) {
    throw transactionError('manifest shape');
  }
  const stages = inputStages.map((stage, index) => {
    if (!stage || typeof stage !== 'object' || !STAGE_ROLES.has(stage.role)
      || !Buffer.isBuffer(stage.bytes)) throw transactionError(`stage ${index}`);
    const targetRel = stage.target_rel === null ? null : normalizePortableRelativePath(stage.target_rel);
    if ((stage.role === 'artifact') !== (targetRel !== null)) throw transactionError(`stage ${index} target`);
    if (stage.role === 'artifact' && reservedArtifactTarget(targetRel)) {
      throw transactionError(`stage ${index} reserved target`);
    }
    const bytes = Buffer.from(stage.bytes);
    return Object.freeze({
      index,
      role: stage.role,
      target_rel: targetRel,
      sha256: contentHash(bytes),
      size: String(bytes.length),
      bytes,
    });
  });
  if (stages.filter(stage => stage.role === 'candidate-loop').length !== 1
    || stages.filter(stage => stage.role === 'candidate-loop-hash').length !== 1) {
    throw transactionError('candidate stages');
  }
  const candidateLoop = stages.find(stage => stage.role === 'candidate-loop');
  const candidateHash = stages.find(stage => stage.role === 'candidate-loop-hash');
  if (candidateLoop.sha256 !== manifest.candidateLoopHash
    || candidateHash.bytes.toString('utf8').trim() !== manifest.candidateLoopHash) {
    throw transactionError('candidate stage binding');
  }
  for (const event of manifest.eventLines) {
    if (!exactKeys(event, ['stage_index', 'seq', 'checksum', 'sha256', 'size'])
      || !Number.isSafeInteger(event.stage_index) || event.stage_index < 0
      || !Number.isSafeInteger(event.seq) || event.seq < 0
      || !SHA256.test(event.checksum || '') || !SHA256.test(event.sha256 || '')
      || canonicalSize(event.size) === null
      || stages[event.stage_index]?.role !== 'event-line'
      || event.sha256 !== stages[event.stage_index].sha256
      || event.size !== stages[event.stage_index].size) {
      throw transactionError('event stage reference');
    }
  }
  for (const target of manifest.targets) {
    if (!exactKeys(target, ['role', 'rel', 'stage_index', 'candidate_sha256', 'candidate_size', 'predecessor'])
      || target.role !== 'artifact'
      || !Number.isInteger(target.stage_index)
      || stages[target.stage_index]?.role !== 'artifact'
      || normalizePortableRelativePath(target.rel) !== target.rel
      || stages[target.stage_index].target_rel !== target.rel
      || !SHA256.test(target.candidate_sha256 || '')
      || canonicalSize(target.candidate_size) === null
      || target.candidate_sha256 !== stages[target.stage_index].sha256
      || target.candidate_size !== stages[target.stage_index].size) throw transactionError('target stage reference');
    validatePredecessor(target.predecessor);
  }
  return stages;
}

function stageRecord(stage) {
  return {
    index: stage.index,
    role: stage.role,
    target_rel: stage.target_rel,
    sha256: stage.sha256,
    size: stage.size,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stageName(index) {
  return `${String(index).padStart(6, '0')}.bin`;
}

function ensureCanonicalRunDir(runDir) {
  const canonical = canonicalNonSymlinkDirectory(runDir);
  if (!canonical || !validOperationId(basename(canonical))) {
    throw transactionError('run directory');
  }
  return canonical;
}

function ensureStrictDirectory(base, rel, { mkdirFn = mkdirSync, lstatFn = lstatSync } = {}) {
  const normalized = normalizePortableRelativePath(rel);
  if (!normalized) throw transactionError('directory path');
  let current = base;
  for (const segment of normalized.split('/')) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirFn(current, { mode: 0o700 });
    const stat = lstatFn(current, { bigint: true });
    if (stat.isSymbolicLink?.() || !stat.isDirectory?.()) throw transactionError('symlink/non-directory component');
    const canonical = (realpathSync.native || realpathSync)(current);
    if (resolve(canonical) !== resolve(current)) throw transactionError('non-canonical directory component');
  }
  return current;
}

function ownerEnvelope(runId, operationId, lockOwner, operationDirIdentity, now) {
  return wrap({
    producer: 'deep-loop',
    artifact_kind: 'transaction-owner',
    schema: { name: 'transaction-owner', version: '1.0' },
    run_id: runId,
    payload: {
      operation_id: operationId,
      lock_owner: lockOwner,
      operation_dir_identity: operationDirIdentity,
      created_at: new Date(now).toISOString(),
    },
    now: new Date(now).toISOString(),
  });
}

function validSavedLockOwner(value) {
  return exactKeys(value, LOCK_OWNER_KEYS) && value.protocol_version === 1
    && UUID.test(value.token || '') && Number.isSafeInteger(value.pid) && value.pid > 0
    && canonicalHostname(value.hostname) === value.hostname
    && Number.isSafeInteger(value.acquired_at_ms) && value.acquired_at_ms >= 0
    && Number.isSafeInteger(value.heartbeat_at_ms) && value.heartbeat_at_ms >= value.acquired_at_ms
    && matchingStableFileIdentity(value.lock_identity, value.lock_identity);
}

function parseOwner(path, operationId) {
  try {
    if (basename(dirname(path)) !== 'transactions') return null;
    const canonicalRunDir = canonicalNonSymlinkDirectory(dirname(dirname(path)));
    if (!canonicalRunDir) return null;
    const env = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    if (!unwrap(env, { producer: 'deep-loop', artifact_kind: 'transaction-owner' })
      || env.envelope?.schema?.version !== '1.0'
      || env.envelope?.run_id !== basename(canonicalRunDir)
      || !canonicalIsoTimestamp(env.envelope?.generated_at)
      || !exactKeys(env.payload, ['operation_id', 'lock_owner', 'operation_dir_identity', 'created_at'])
      || env.payload?.operation_id !== operationId
      || !validSavedLockOwner(env.payload.lock_owner)
      || !matchingStableFileIdentity(env.payload.operation_dir_identity, env.payload.operation_dir_identity)
      || !canonicalIsoTimestamp(env.payload.created_at)
      || env.envelope.generated_at !== env.payload.created_at) return null;
    return env;
  } catch {
    return null;
  }
}

function defaultProbePid(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function verifyOperationDirectory(path, ownerEnv) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const canonical = (realpathSync.native || realpathSync)(path);
    if (resolve(canonical) !== resolve(path)) return false;
    return matchingStableFileIdentity(
      captureStableFileIdentity(path),
      ownerEnv.payload.operation_dir_identity,
    );
  } catch {
    return false;
  }
}

function captureCanonicalRegularFileIdentity(path) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw reconciliationError('stage file type');
  const canonical = (realpathSync.native || realpathSync)(path);
  if (resolve(canonical) !== resolve(path)) throw reconciliationError('stage path substitution');
  return captureStableFileIdentity(path, { lstatFn: () => stat });
}

function verifyCanonicalDirectory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw reconciliationError('stage directory type');
  const canonical = (realpathSync.native || realpathSync)(path);
  if (resolve(canonical) !== resolve(path)) throw reconciliationError('stage directory substitution');
  return captureStableFileIdentity(path, { lstatFn: () => stat });
}

function quarantineAndRemove(
  transactionsDir,
  path,
  operationId,
  ownerEnv,
  lockGuard,
  faultAt,
  flushDirectoryFn = flushDirectory,
) {
  const savedToken = ownerEnv.payload.lock_owner.token;
  const quarantine = join(transactionsDir, `.orphan-${operationId}-${savedToken}`);
  if (path !== quarantine) {
    if (guarded(lockGuard, () => existsSync(quarantine))) {
      throw reconciliationError('orphan quarantine collision');
    }
    lockGuard.assertOwned();
    renameSync(path, quarantine);
    faultAt('orphan:quarantined');
    lockGuard.renew();
    lockGuard.assertOwned();
    flushDirectoryFn(transactionsDir);
    faultAt('orphan:quarantine-parent-flushed');
    lockGuard.renew();
  }
  const reloaded = guarded(lockGuard, () => parseOwner(quarantine, operationId));
  const unchanged = reloaded && guarded(lockGuard, () => (
    JSON.stringify(reloaded.payload) === JSON.stringify(ownerEnv.payload)
      && verifyOperationDirectory(quarantine, reloaded)
      && !existsSync(join(quarantine, 'prepared.json'))
  ));
  if (!unchanged) {
    throw reconciliationError('orphan changed after quarantine');
  }
  faultAt('orphan:delete');
  const finalOwner = guarded(lockGuard, () => parseOwner(quarantine, operationId));
  const safeToDelete = finalOwner && guarded(lockGuard, () => (
    JSON.stringify(finalOwner.payload) === JSON.stringify(ownerEnv.payload)
      && verifyOperationDirectory(quarantine, finalOwner)
      && !existsSync(join(quarantine, 'prepared.json'))
  ));
  if (!safeToDelete) throw reconciliationError('orphan changed before delete');
  lockGuard.assertOwned();
  rmSync(quarantine, { recursive: true, force: false });
  faultAt('orphan:deleted');
  lockGuard.renew();
  lockGuard.assertOwned();
  flushDirectoryFn(transactionsDir);
  faultAt('orphan:delete-parent-flushed');
  lockGuard.renew();
}

function cleanupUnprepared(transactionsDir, lockGuard, {
  nowFn = Date.now,
  hostnameFn = hostname,
  probePid = defaultProbePid,
  faultAt = () => {},
  flushDirectoryFn = flushDirectory,
} = {}) {
  if (!guarded(lockGuard, () => existsSync(transactionsDir))) return;
  const localHost = canonicalHostname(hostnameFn());
  const names = guarded(lockGuard, () => readdirSync(transactionsDir).sort());
  const identities = new Map();
  for (const name of names) {
    const orphan = name.match(/^\.orphan-(.+)-([0-9a-f-]{36})$/);
    const operationId = orphan ? orphan[1] : name;
    if (!validOperationId(operationId)) continue;
    if (identities.has(operationId)) throw reconciliationError('divergent orphan collision');
    identities.set(operationId, name);
  }
  for (const name of names) {
    const orphan = name.match(/^\.orphan-(.+)-([0-9a-f-]{36})$/);
    const operationId = orphan ? orphan[1] : name;
    if (!validOperationId(operationId)) continue;
    const path = join(transactionsDir, name);
    let stat;
    try { stat = guarded(lockGuard, () => lstatSync(path, { bigint: true })); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw reconciliationError('transaction entry type');
    if (guarded(lockGuard, () => existsSync(join(path, 'prepared.json')))) continue;
    const ownerEnv = guarded(lockGuard, () => parseOwner(path, operationId));
    if (!ownerEnv || !guarded(lockGuard, () => verifyOperationDirectory(path, ownerEnv))) {
      throw reconciliationError('unowned staging directory');
    }
    const saved = ownerEnv.payload.lock_owner;
    if (orphan && orphan[2] !== saved.token) throw reconciliationError('orphan marker changed');
    const ownedByCaller = saved.token === lockGuard.token;
    let deadOwner = false;
    if (!ownedByCaller) {
      const now = nowFn();
      const age = Number.isSafeInteger(now) && Number.isSafeInteger(saved.heartbeat_at_ms)
        ? now - saved.heartbeat_at_ms : -1;
      let liveness = 'unknown';
      try { liveness = probePid(saved.pid); } catch { liveness = 'unknown'; }
      deadOwner = saved.hostname === localHost && age > ORPHAN_STALE_TTL_MS && liveness === 'dead';
    }
    if (!ownedByCaller && !deadOwner) throw reconciliationError('orphan ownership not dead');
    quarantineAndRemove(
      transactionsDir,
      path,
      operationId,
      ownerEnv,
      lockGuard,
      faultAt,
      flushDirectoryFn,
    );
  }
}

function preparedEnvelope(runId, manifest, stages, now) {
  return wrap({
    producer: 'deep-loop',
    artifact_kind: 'anchored-publication',
    schema: { name: 'anchored-publication', version: '1.0' },
    run_id: runId,
    payload: { manifest, stages: stages.map(stageRecord) },
    now: new Date(now).toISOString(),
  });
}

export function preparePublicationStagesLocked(runDir, lockGuard, manifest, inputStages, {
  nowFn = Date.now,
  faultAt = () => {},
  hostnameFn = hostname,
  probePid = defaultProbePid,
  durableWriteFn = durableAtomicWrite,
  flushDirectoryFn = flushDirectory,
  renameOperationFn = renameAtomicWithRetry,
} = {}) {
  const canonicalRunDir = ensureCanonicalRunDir(runDir);
  lockGuard = scopeGuard(lockGuard, canonicalRunDir);
  const frozenManifest = deepFreeze(structuredClone(manifest));
  const stages = guarded(lockGuard, () => validateAndMaterialize(frozenManifest, inputStages));
  const transactionsDir = guarded(lockGuard, () => ensureStrictDirectory(canonicalRunDir, 'transactions'));
  guarded(lockGuard, () => flushDirectoryFn(canonicalRunDir));
  guarded(lockGuard, () => flushDirectoryFn(transactionsDir));
  cleanupUnprepared(transactionsDir, lockGuard, {
    nowFn, hostnameFn, probePid, faultAt, flushDirectoryFn,
  });
  const existing = findPreparedPublicationLocked(canonicalRunDir, lockGuard);
  if (existing) throw reconciliationError('pending operation exists');

  const operationId = frozenManifest.operationId;
  const lockDir = join(canonicalRunDir, '.lock');
  const bootstrapRoot = guarded(lockGuard, () => ensureStrictDirectory(lockDir, 'operation-bootstrap'));
  guarded(lockGuard, () => flushDirectoryFn(lockDir));
  guarded(lockGuard, () => flushDirectoryFn(bootstrapRoot));
  const bootstrap = join(bootstrapRoot, `${operationId}-${lockGuard.token}`);
  const operationDir = join(transactionsDir, operationId);
  if (guarded(lockGuard, () => existsSync(bootstrap) || existsSync(operationDir))) {
    throw reconciliationError('operation path exists');
  }
  let moved = false;
  let operationOwner = null;
  try {
    lockGuard.assertOwned();
    mkdirSync(bootstrap, { mode: 0o700 });
    faultAt('bootstrap:created');
    lockGuard.renew();
    guarded(lockGuard, () => flushDirectoryFn(bootstrapRoot));
    faultAt('bootstrap:entry-parent-flushed');
    lockGuard.assertOwned();
    const operationIdentity = captureStableFileIdentity(bootstrap);
    faultAt('bootstrap:identity');
    lockGuard.renew();
    const lockOwner = guarded(lockGuard, () => JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')));
    const now = nowFn();
    operationOwner = ownerEnvelope(basename(canonicalRunDir), operationId, lockOwner, operationIdentity, now);
    guardedDurableWrite(
      lockGuard,
      durableWriteFn,
      join(bootstrap, 'owner.json'),
      JSON.stringify(operationOwner),
      'bootstrap:owner',
      faultAt,
    );
    faultAt('bootstrap:owner-durable');
    lockGuard.assertOwned();
    renameOperationFn(bootstrap, operationDir);
    moved = true;
    faultAt('bootstrap:renamed');
    lockGuard.renew();
    lockGuard.assertOwned();
    flushDirectoryFn(bootstrapRoot);
    faultAt('bootstrap:source-parent-flushed');
    lockGuard.renew();
    lockGuard.assertOwned();
    flushDirectoryFn(transactionsDir);
    faultAt('bootstrap:destination-parent-flushed');
    lockGuard.renew();
    faultAt('bootstrap:rename');
    if (!guarded(lockGuard, () => verifyOperationDirectory(operationDir, operationOwner))) {
      throw reconciliationError('operation identity after transfer');
    }
    const stagesDir = guarded(lockGuard, () => ensureStrictDirectory(operationDir, 'stages'));
    guarded(lockGuard, () => flushDirectoryFn(operationDir));
    guarded(lockGuard, () => flushDirectoryFn(stagesDir));
    for (const stage of stages) {
      guardedDurableWrite(
        lockGuard,
        durableWriteFn,
        join(stagesDir, stageName(stage.index)),
        stage.bytes,
        `stage:${stage.index}`,
        faultAt,
      );
      const observed = guarded(lockGuard, () => readFileSync(join(stagesDir, stageName(stage.index))));
      const observedHash = guarded(lockGuard, () => contentHash(observed));
      if (String(observed.length) !== stage.size || observedHash !== stage.sha256) {
        throw reconciliationError(`stage ${stage.index} digest`);
      }
      faultAt(`stage:${stage.index}:digest-verified`);
      faultAt(`stage:${stage.index}:verified`);
    }
    const prepared = preparedEnvelope(basename(canonicalRunDir), frozenManifest, stages, now);
    const preparedBytes = Buffer.from(JSON.stringify(prepared));
    faultAt('prepared:before-write');
    guardedDurableWrite(
      lockGuard,
      durableWriteFn,
      join(operationDir, 'prepared.json'),
      preparedBytes,
      'prepared',
      faultAt,
    );
    const observedPrepared = guarded(lockGuard, () => readFileSync(join(operationDir, 'prepared.json')));
    const preparedHash = guarded(lockGuard, () => contentHash(preparedBytes));
    const observedPreparedHash = guarded(lockGuard, () => contentHash(observedPrepared));
    if (observedPrepared.length !== preparedBytes.length || observedPreparedHash !== preparedHash) {
      throw reconciliationError('prepared manifest digest');
    }
    faultAt('prepared:digest-verified');
    return { ok: true, operationId };
  } catch (error) {
    if (moved && existsSync(join(operationDir, 'prepared.json'))) {
      throw new Error('TRANSACTION_PENDING: prepared publication requires reconciliation', { cause: error });
    }
    if (moved && operationOwner && existsSync(operationDir)
      && !existsSync(join(operationDir, 'prepared.json'))) {
      try {
        quarantineAndRemove(
          transactionsDir,
          operationDir,
          operationId,
          operationOwner,
          lockGuard,
          faultAt,
          flushDirectoryFn,
        );
      } catch {
        // Preserve the original pre-prepare failure; the verified orphan remains for a later guard.
      }
    }
    if (String(error?.message || error).startsWith('TRANSACTION_INVALID')
      || String(error?.message || error).startsWith('TRANSACTION_RECONCILIATION_REQUIRED')
      || String(error?.message || error).startsWith('LOCK_')) throw error;
    return { ok: false, reason: 'TRANSACTION_NOT_PREPARED' };
  }
}

function verifyPreparedOperation(operationDir, lockGuard) {
  const operationId = basename(operationDir);
  const owner = guarded(lockGuard, () => parseOwner(operationDir, operationId));
  if (!owner || !guarded(lockGuard, () => verifyOperationDirectory(operationDir, owner))) {
    throw reconciliationError('prepared operation ownership');
  }
  const stagesDir = join(operationDir, 'stages');
  const stagesDirectoryIdentity = guarded(lockGuard, () => verifyCanonicalDirectory(stagesDir));
  let env;
  try {
    env = guarded(lockGuard, () => JSON.parse(readFileSync(join(operationDir, 'prepared.json'), 'utf8')));
  } catch {
    throw reconciliationError('prepared manifest unreadable');
  }
  if (!unwrap(env, { producer: 'deep-loop', artifact_kind: 'anchored-publication' })
    || env.schema_version !== '1.0'
    || env.envelope?.schema?.version !== '1.0'
    || env.envelope?.run_id !== basename(dirname(dirname(operationDir)))
    || !canonicalIsoTimestamp(env.envelope?.generated_at)
    || env.envelope.generated_at !== owner.payload.created_at
    || !env.payload || !exactKeys(env.payload, ['manifest', 'stages'])
    || !Array.isArray(env.payload.stages)) throw reconciliationError('prepared envelope');
  const records = env.payload.stages;
  const stageBytes = [];
  const stageIdentities = [];
  const expectedNames = records.map((_, index) => stageName(index));
  const actualNames = guarded(lockGuard, () => readdirSync(stagesDir).sort());
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw reconciliationError('stage set');
  }
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!exactKeys(record, ['index', 'role', 'target_rel', 'sha256', 'size'])
      || record.index !== index || !STAGE_ROLES.has(record.role)
      || !SHA256.test(record.sha256 || '') || canonicalSize(record.size) === null
      || (record.role === 'artifact') !== (normalizePortableRelativePath(record.target_rel) !== null)) {
      throw reconciliationError(`stage record ${index}`);
    }
    const path = join(stagesDir, stageName(index));
    const beforeIdentity = guarded(lockGuard, () => captureCanonicalRegularFileIdentity(path));
    let bytes;
    try {
      bytes = guarded(lockGuard, () => readFileSync(path));
    } catch {
      throw reconciliationError(`stage ${index}`);
    }
    const afterIdentity = guarded(lockGuard, () => captureCanonicalRegularFileIdentity(path));
    if (!matchingStableFileIdentity(beforeIdentity, afterIdentity)) {
      throw reconciliationError(`stage ${index} identity drift`);
    }
    const observedHash = guarded(lockGuard, () => contentHash(bytes));
    if (String(bytes.length) !== record.size || observedHash !== record.sha256) {
      throw reconciliationError(`stage ${index}`);
    }
    stageBytes.push(bytes);
    stageIdentities.push(beforeIdentity);
  }
  let rematerialized;
  try {
    rematerialized = guarded(lockGuard, () => validateAndMaterialize(env.payload.manifest, records.map((record, index) => ({
      role: record.role,
      target_rel: record.target_rel,
      bytes: stageBytes[index],
    }))));
  } catch (error) {
    throw reconciliationError(`prepared binding: ${error?.message || error}`);
  }
  if (JSON.stringify(rematerialized.map(stageRecord)) !== JSON.stringify(records)) {
    throw reconciliationError('prepared stage records');
  }
  if (env.envelope.run_id !== basename(dirname(dirname(operationDir)))
    || env.payload.manifest.operationId !== operationId) {
    throw reconciliationError('prepared operation ownership');
  }
  const readStage = index => {
    lockGuard.assertOwned();
    if (!Number.isSafeInteger(index) || index < 0) throw reconciliationError('stage index');
    const record = records[index];
    if (!record) throw reconciliationError(`stage index ${index}`);
    if (!guarded(lockGuard, () => verifyOperationDirectory(operationDir, owner))) {
      throw reconciliationError('operation identity drift');
    }
    const currentStagesIdentity = guarded(lockGuard, () => verifyCanonicalDirectory(stagesDir));
    if (!matchingStableFileIdentity(currentStagesIdentity, stagesDirectoryIdentity)) {
      throw reconciliationError('stage directory identity drift');
    }
    const path = join(stagesDir, stageName(index));
    const beforeIdentity = guarded(lockGuard, () => captureCanonicalRegularFileIdentity(path));
    if (!matchingStableFileIdentity(beforeIdentity, stageIdentities[index])) {
      throw reconciliationError(`stage ${index} identity drift`);
    }
    const bytes = guarded(lockGuard, () => readFileSync(path));
    const afterIdentity = guarded(lockGuard, () => captureCanonicalRegularFileIdentity(path));
    if (!matchingStableFileIdentity(beforeIdentity, afterIdentity)) {
      throw reconciliationError(`stage ${index} identity drift`);
    }
    const observedHash = guarded(lockGuard, () => contentHash(bytes));
    if (String(bytes.length) !== record.size || observedHash !== record.sha256) {
      throw reconciliationError(`stage ${index} digest`);
    }
    return Buffer.from(bytes);
  };
  return Object.freeze({
    operationDir,
    manifest: deepFreeze(env.payload.manifest),
    stages: deepFreeze(records),
    readStage,
  });
}

export function findPreparedPublicationLocked(runDir, lockGuard) {
  const canonicalRunDir = ensureCanonicalRunDir(runDir);
  lockGuard = scopeGuard(lockGuard, canonicalRunDir);
  const transactionsDir = join(canonicalRunDir, 'transactions');
  if (!guarded(lockGuard, () => existsSync(transactionsDir))) return null;
  const prepared = [];
  for (const name of guarded(lockGuard, () => readdirSync(transactionsDir).sort())) {
    if (!validOperationId(name)) continue;
    const operationDir = join(transactionsDir, name);
    let stat;
    try { stat = guarded(lockGuard, () => lstatSync(operationDir, { bigint: true })); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw reconciliationError('operation entry type');
    if (guarded(lockGuard, () => existsSync(join(operationDir, 'prepared.json')))) prepared.push(operationDir);
  }
  if (prepared.length > 1) throw reconciliationError('multiple prepared operations');
  return prepared.length === 0 ? null : verifyPreparedOperation(prepared[0], lockGuard);
}

function artifactPathReadOnly(runDir, rel, lockGuard) {
  const normalized = normalizePortableRelativePath(rel);
  if (!normalized) throw transactionError('artifact target');
  const segments = normalized.split('/');
  const leaf = segments.pop();
  let parent = runDir;
  let parentAbsent = false;
  for (const segment of segments) {
    parent = join(parent, segment);
    if (parentAbsent || !guarded(lockGuard, () => existsSync(parent))) {
      parentAbsent = true;
      continue;
    }
    const stat = guarded(lockGuard, () => lstatSync(parent, { bigint: true }));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw reconciliationError('artifact parent type');
    const canonical = guarded(lockGuard, () => (realpathSync.native || realpathSync)(parent));
    if (resolve(canonical) !== resolve(parent)) throw reconciliationError('artifact parent substitution');
  }
  const target = join(parent, leaf);
  if (resolve(target) !== resolve(runDir, ...normalized.split('/'))) throw transactionError('artifact containment');
  if (!parentAbsent && guarded(lockGuard, () => existsSync(target))) {
    const stat = guarded(lockGuard, () => lstatSync(target, { bigint: true }));
    if (stat.isSymbolicLink() || !stat.isFile()) throw reconciliationError('artifact target type');
  }
  return { target, parentAbsent };
}

function markerRecord(kind, target) {
  return {
    kind,
    stage_index: target.stage_index,
    rel: target.rel,
    candidate_sha256: target.candidate_sha256,
    predecessor_sha256: target.predecessor.kind === 'present' ? target.predecessor.sha256 : null,
  };
}

function markerPath(prepared, kind, stageIndex) {
  return join(prepared.operationDir, 'markers', `${kind}-${String(stageIndex).padStart(6, '0')}.json`);
}

function inspectMarker(prepared, kind, target, lockGuard) {
  const path = markerPath(prepared, kind, target.stage_index);
  if (!guarded(lockGuard, () => existsSync(path))) return false;
  const stat = guarded(lockGuard, () => lstatSync(path, { bigint: true }));
  if (stat.isSymbolicLink() || !stat.isFile()) throw reconciliationError(`${kind} marker type`);
  const expected = JSON.stringify(markerRecord(kind, target));
  const observed = guarded(lockGuard, () => readFileSync(path, 'utf8'));
  if (observed !== expected) throw reconciliationError(`${kind} marker mismatch`);
  return true;
}

function readStableArtifact(path, lockGuard) {
  const before = guarded(lockGuard, () => captureStableFileIdentity(path));
  const bytes = guarded(lockGuard, () => readFileSync(path));
  const after = guarded(lockGuard, () => captureStableFileIdentity(path));
  if (!matchingStableFileIdentity(before, after)) throw reconciliationError('artifact identity drift');
  return { bytes, identity: before, sha256: contentHash(bytes), size: String(bytes.length) };
}

export function classifyArtifactTargetsLocked(runDir, lockGuard, manifest) {
  const canonicalRunDir = ensureCanonicalRunDir(runDir);
  lockGuard = scopeGuard(lockGuard, canonicalRunDir);
  const prepared = findPreparedPublicationLocked(canonicalRunDir, lockGuard);
  if (!prepared || JSON.stringify(prepared.manifest) !== JSON.stringify(manifest)) {
    throw reconciliationError('prepared manifest mismatch');
  }
  const classifications = [];
  let sawPredecessor = false;
  for (const target of manifest.targets) {
    const record = prepared.stages[target.stage_index];
    if (!record || record.role !== 'artifact' || record.target_rel !== target.rel) {
      throw reconciliationError('non-artifact target');
    }
    const { target: finalPath, parentAbsent } = artifactPathReadOnly(canonicalRunDir, target.rel, lockGuard);
    const replaceIntent = inspectMarker(prepared, 'replace-intent', target, lockGuard);
    const targetDone = inspectMarker(prepared, 'target-done', target, lockGuard);
    let state;
    if (!parentAbsent && guarded(lockGuard, () => existsSync(finalPath))) {
      const current = readStableArtifact(finalPath, lockGuard);
      if (current.size === target.candidate_size && current.sha256 === target.candidate_sha256) {
        state = 'candidate';
      } else if (target.predecessor.kind === 'present'
        && current.size === target.predecessor.size
        && current.sha256 === target.predecessor.sha256
        && matchingStableFileIdentity(current.identity, target.predecessor.identity)) {
        state = 'predecessor';
      } else {
        throw reconciliationError('artifact predecessor mismatch');
      }
    } else if (target.predecessor.kind === 'absent') {
      state = 'predecessor';
    } else if (replaceIntent) {
      state = 'replace-unlinked';
    } else {
      throw reconciliationError('missing artifact predecessor');
    }
    if (targetDone && state !== 'candidate') throw reconciliationError('target-done before candidate');
    if (replaceIntent && target.predecessor.kind !== 'present') {
      throw reconciliationError('replace-intent for absent predecessor');
    }
    if (sawPredecessor && state === 'candidate') {
      throw reconciliationError('artifact publication order');
    }
    if (state !== 'candidate') sawPredecessor = true;
    classifications.push(Object.freeze({
      target,
      finalPath,
      state,
      replaceIntent,
      targetDone,
    }));
  }
  return Object.freeze({ prepared, classifications: Object.freeze(classifications) });
}

function writeMarker(prepared, kind, target, lockGuard, durableWriteFn, faultAt) {
  const markersDir = guarded(lockGuard, () => ensureStrictDirectory(prepared.operationDir, 'markers'));
  guarded(lockGuard, () => flushDirectory(prepared.operationDir));
  guarded(lockGuard, () => flushDirectory(markersDir));
  const path = markerPath(prepared, kind, target.stage_index);
  const bytes = JSON.stringify(markerRecord(kind, target));
  if (guarded(lockGuard, () => existsSync(path))) {
    if (!inspectMarker(prepared, kind, target, lockGuard)) throw reconciliationError(`${kind} marker`);
    return;
  }
  guardedDurableWrite(lockGuard, durableWriteFn, path, bytes, `${kind}:${target.stage_index}`, faultAt);
  if (!inspectMarker(prepared, kind, target, lockGuard)) throw reconciliationError(`${kind} marker`);
  faultAt(`${kind}:${target.stage_index}`);
}

export function publishArtifactTargetsLocked(runDir, lockGuard, manifest, {
  durableWriteFn = durableAtomicWrite,
  faultAt = () => {},
  forceUnlinkReplacement = false,
} = {}) {
  const canonicalRunDir = ensureCanonicalRunDir(runDir);
  lockGuard = scopeGuard(lockGuard, canonicalRunDir);
  const { prepared, classifications } = classifyArtifactTargetsLocked(canonicalRunDir, lockGuard, manifest);
  let published = 0;
  for (const classification of classifications) {
    const { target, finalPath } = classification;
    const candidate = prepared.readStage(target.stage_index);
    if (classification.state === 'candidate') {
      if (!classification.targetDone) {
        writeMarker(prepared, 'target-done', target, lockGuard, durableWriteFn, faultAt);
      }
      published += 1;
      continue;
    }
    const segments = target.rel.split('/');
    segments.pop();
    if (segments.length) guarded(lockGuard, () => ensureStrictDirectory(canonicalRunDir, segments.join('/')));
    const replaceExisting = (forceUnlinkReplacement || classification.replaceIntent)
      && classification.state === 'predecessor'
      && target.predecessor.kind === 'present';
    if (replaceExisting && !classification.replaceIntent) {
      writeMarker(prepared, 'replace-intent', target, lockGuard, durableWriteFn, faultAt);
    }
    guardedDurableWrite(
      lockGuard,
      (path, contents, options) => durableWriteFn(path, contents, {
        ...options,
        unlinkBeforeRename: replaceExisting,
        beforeUnlink() {
          lockGuard.assertOwned();
          faultAt(`artifact:${target.stage_index}:replace-intent`);
        },
      }),
      finalPath,
      candidate,
      `artifact:${target.stage_index}`,
      faultAt,
    );
    if (replaceExisting) faultAt(`artifact:${target.stage_index}:unlink`);
    const installed = guarded(lockGuard, () => readFileSync(finalPath));
    const installedHash = guarded(lockGuard, () => contentHash(installed));
    if (String(installed.length) !== target.candidate_size || installedHash !== target.candidate_sha256) {
      throw reconciliationError('artifact candidate mismatch');
    }
    faultAt(`artifact:${target.stage_index}:digest-verified`);
    writeMarker(prepared, 'target-done', target, lockGuard, durableWriteFn, faultAt);
    faultAt(`artifact:${target.stage_index}:target-done`);
    published += 1;
  }
  return { ok: true, published };
}

function committedRecord(prepared) {
  return JSON.stringify({
    kind: 'committed',
    operation_id: prepared.manifest.operationId,
    candidate_loop_hash: prepared.manifest.candidateLoopHash,
  });
}

export function publicationCommittedLocked(runDir, lockGuard, prepared = null) {
  const canonicalRunDir = ensureCanonicalRunDir(runDir);
  lockGuard = scopeGuard(lockGuard, canonicalRunDir);
  prepared ||= findPreparedPublicationLocked(canonicalRunDir, lockGuard);
  if (!prepared) return false;
  const path = join(prepared.operationDir, 'committed.json');
  if (!guarded(lockGuard, () => existsSync(path))) return false;
  const stat = guarded(lockGuard, () => lstatSync(path, { bigint: true }));
  if (stat.isSymbolicLink() || !stat.isFile()
    || guarded(lockGuard, () => readFileSync(path, 'utf8')) !== committedRecord(prepared)) {
    throw reconciliationError('committed marker mismatch');
  }
  return true;
}

export function markPublicationCommittedLocked(runDir, lockGuard, prepared, {
  durableWriteFn = durableAtomicWrite,
  faultAt = () => {},
} = {}) {
  const canonicalRunDir = ensureCanonicalRunDir(runDir);
  lockGuard = scopeGuard(lockGuard, canonicalRunDir);
  if (publicationCommittedLocked(canonicalRunDir, lockGuard, prepared)) return { ok: true };
  guardedDurableWrite(
    lockGuard,
    durableWriteFn,
    join(prepared.operationDir, 'committed.json'),
    committedRecord(prepared),
    'committed',
    faultAt,
  );
  faultAt('committed:rename');
  if (!publicationCommittedLocked(canonicalRunDir, lockGuard, prepared)) {
    throw reconciliationError('committed marker missing');
  }
  return { ok: true };
}

export function retireCommittedPublicationLocked(runDir, lockGuard) {
  const canonicalRunDir = ensureCanonicalRunDir(runDir);
  lockGuard = scopeGuard(lockGuard, canonicalRunDir);
  const prepared = findPreparedPublicationLocked(canonicalRunDir, lockGuard);
  if (!prepared || !publicationCommittedLocked(canonicalRunDir, lockGuard, prepared)) return false;
  lockGuard.assertOwned();
  rmSync(prepared.operationDir, { recursive: true, force: false });
  lockGuard.renew();
  flushDirectory(dirname(prepared.operationDir));
  lockGuard.renew();
  return true;
}
