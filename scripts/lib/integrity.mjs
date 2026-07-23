import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { contentHash } from './envelope.mjs';
import {
  parseHashVerifiedStateBytes,
  runDir,
  readState,
  writeState,
  withLock,
} from './state.mjs';
import {
  assertProjectRootBinding,
  canonicalProjectRoot,
  classifyProjectRootBinding,
  projectRootDigest,
} from './project-root.mjs';
import { validate } from './schema.mjs';
import { durableAtomicWrite, flushDirectory } from './atomic-write.mjs';
import {
  classifyArtifactTargetsLocked,
  findPreparedPublicationLocked,
  markPublicationCommittedLocked,
  preparePublicationStagesLocked,
  publicationCommittedLocked,
  publishArtifactTargetsLocked,
  retireCommittedPublicationLocked,
} from './transaction-journal.mjs';
import {
  captureStableFileIdentity,
  matchingStableFileIdentity,
  normalizePortableRelativePath,
} from './fs-safe.mjs';

const logPath = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');

// #3: every business-intent mutation is charged at least this many turns via appendAnchored's `opts.floor`
// (paired cost, same anchor). Lives here (with the floor mechanism) so both state.mjs and budget.mjs can import
// it without a state↔budget cycle; budget.mjs re-exports it for call sites/tests.
export const MUTATION_TURN_FLOOR = 1;

export function readLines(root, runId) {
  const p = logPath(root, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function checksumFor(seq, ts, type, data, prev) {
  return contentHash(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`);
}

function nextEvent(lines, { type, data, now }) {
  const prev = lines.length ? lines[lines.length - 1].checksum : 'GENESIS';
  const seq = lines.length + 1;
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_NOW: event timestamp');
  const ts = date.toISOString();
  const checksum = checksumFor(seq, ts, type, data, prev);
  return { seq, ts, type, data, checksum };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function transactionError(message) {
  return new Error(`TRANSACTION_RECONCILIATION_REQUIRED: ${message}`);
}

function exactLogBytes(lines) {
  return Buffer.from(lines.map(line => `${JSON.stringify(line)}\n`).join(''));
}

function parseExactLogBytes(bytes, { reconciliation = false } = {}) {
  const fail = message => {
    if (reconciliation) throw transactionError(message);
    throw new Error(`LOG_TAMPERED: ${message}`);
  };
  const raw = Buffer.from(bytes);
  if (raw.length === 0) return { lines: [], lineBytes: [] };
  if (raw.at(-1) !== 0x0a) fail('partial event-log line');
  const lineBytes = [];
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== 0x0a) continue;
    const line = Buffer.from(raw.subarray(start, index + 1));
    if (line.length === 1) fail('blank event-log line');
    lineBytes.push(line);
    start = index + 1;
  }
  let lines;
  try { lines = lineBytes.map(line => JSON.parse(line.subarray(0, -1).toString('utf8'))); }
  catch { fail('event-log parse'); }
  const checked = verifyLines(lines);
  if (!checked.ok) fail(`event-log chain: ${checked.errors.join('; ')}`);
  return { lines, lineBytes };
}

function readRawRun(root, runId) {
  const dir = runDir(root, runId);
  const loopBytes = readFileSync(join(dir, 'loop.json'));
  const hashBytes = existsSync(join(dir, '.loop.hash')) ? readFileSync(join(dir, '.loop.hash')) : null;
  const logBytes = existsSync(join(dir, 'event-log.jsonl'))
    ? readFileSync(join(dir, 'event-log.jsonl'))
    : Buffer.alloc(0);
  return { dir, loopBytes, hashBytes, logBytes };
}

function snapshotRaw(root, runId, raw, { requireSchema = true, requireProjectBinding = true } = {}) {
  const parsed = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
    requireSchema,
    requireProjectBinding,
  });
  const { lines: logLines } = parseExactLogBytes(raw.logBytes);
  const head = verifyHeadLines(logLines, parsed.data.event_log_head);
  if (!head.ok) throw new Error(`LOG_TAMPERED: ${head.errors.join('; ')}`);
  return {
    data: structuredClone(parsed.data),
    hash: parsed.hash,
    loopBytes: Buffer.from(raw.loopBytes),
    hashBytes: Buffer.from(raw.hashBytes),
    logBytes: Buffer.from(raw.logBytes),
    logLines: structuredClone(logLines),
  };
}

function captureArtifactLocked(root, runId, rel) {
  if (normalizePortableRelativePath(rel) !== rel) throw new Error(`ARTIFACT_REL_INVALID: ${String(rel)}`);
  const base = runDir(root, runId);
  const canonicalBase = (realpathSync.native || realpathSync)(base);
  const parts = rel.split('/');
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    if (!existsSync(current)) return Object.freeze({ state: 'absent' });
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`ARTIFACT_REL_INVALID: symlink ${rel}`);
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) throw new Error(`ARTIFACT_REL_INVALID: parent ${rel}`);
      const canonical = (realpathSync.native || realpathSync)(current);
      const expected = join(canonicalBase, ...parts.slice(0, index + 1));
      if (resolve(canonical) !== resolve(expected)) throw new Error(`ARTIFACT_REL_INVALID: alias ${rel}`);
      continue;
    }
    if (!stat.isFile()) throw new Error(`ARTIFACT_REL_INVALID: target ${rel}`);
    const before = captureStableFileIdentity(current);
    const bytes = readFileSync(current);
    const after = captureStableFileIdentity(current);
    if (!matchingStableFileIdentity(before, after)) throw new Error(`ARTIFACT_REL_INVALID: identity drift ${rel}`);
    return Object.freeze({ state: 'present', bytes: Buffer.from(bytes), sha256: contentHash(bytes) });
  }
  throw new Error(`ARTIFACT_REL_INVALID: ${rel}`);
}

function captureArtifactsLocked(root, runId, artifactRels = []) {
  if (!Array.isArray(artifactRels) || new Set(artifactRels).size !== artifactRels.length) {
    throw new Error('ARTIFACT_REL_INVALID: fixed unique list required');
  }
  const artifacts = Object.create(null);
  for (const rel of artifactRels) artifacts[rel] = captureArtifactLocked(root, runId, rel);
  return artifacts;
}

function operationTimestamp(now) {
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_NOW: event timestamp');
  return date.toISOString();
}

function materializePublication(publication) {
  if (!publication || typeof publication !== 'object' || Array.isArray(publication)) {
    throw new Error('TRANSACTION_INVALID: publication shape');
  }
  const allowed = new Set([
    'kind', 'operationId', 'artifacts', 'topology', 'faultAt', 'forceUnlinkReplacement',
    'durableWriteFn', 'nowFn',
  ]);
  if (Object.keys(publication).some(key => !allowed.has(key))
    || typeof publication.kind !== 'string' || publication.kind.length === 0
    || typeof publication.operationId !== 'string' || publication.operationId.length === 0
    || !Array.isArray(publication.artifacts)
    || !publication.topology || typeof publication.topology !== 'object' || Array.isArray(publication.topology)) {
    throw new Error('TRANSACTION_INVALID: publication shape');
  }
  const artifacts = publication.artifacts.map((artifact, index) => {
    if (!artifact || typeof artifact !== 'object'
      || JSON.stringify(Object.keys(artifact)) !== JSON.stringify(['rel', 'bytes'])
      || normalizePortableRelativePath(artifact.rel) !== artifact.rel
      || !Buffer.isBuffer(artifact.bytes)) {
      throw new Error(`TRANSACTION_INVALID: publication artifact ${index}`);
    }
    return Object.freeze({ rel: artifact.rel, bytes: Buffer.from(artifact.bytes) });
  });
  return Object.freeze({
    kind: publication.kind,
    operationId: publication.operationId,
    artifacts: Object.freeze(artifacts),
    topology: deepFreeze(structuredClone(publication.topology)),
    faultAt: typeof publication.faultAt === 'function' ? publication.faultAt : () => {},
    forceUnlinkReplacement: publication.forceUnlinkReplacement === true,
    durableWriteFn: publication.durableWriteFn || durableAtomicWrite,
    nowFn: publication.nowFn,
  });
}

function committedRetryResult(prepared, publication, eventInput, floor, now) {
  const manifest = prepared.manifest;
  const artifactMatch = manifest.targets.length === publication.artifacts.length
    && manifest.targets.every((target, index) => target.rel === publication.artifacts[index].rel
      && target.candidate_sha256 === contentHash(publication.artifacts[index].bytes)
      && target.candidate_size === String(publication.artifacts[index].bytes.length));
  const eventCount = floor ? 2 : 1;
  let event;
  try {
    const descriptor = manifest.eventLines[0];
    const bytes = prepared.readStage(descriptor.stage_index).toString('utf8');
    event = JSON.parse(bytes.slice(0, -1));
  } catch {
    throw transactionError('committed retry event');
  }
  if (manifest.kind !== publication.kind
    || JSON.stringify(manifest.topology) !== JSON.stringify(publication.topology)
    || !artifactMatch
    || manifest.eventLines.length !== eventCount
    || event.type !== eventInput.type
    || JSON.stringify(event.data) !== JSON.stringify(eventInput.data)
    || (now !== undefined && event.ts !== operationTimestamp(now))) {
    throw transactionError('committed retry mismatch');
  }
  if (floor) {
    let cost;
    try {
      const descriptor = manifest.eventLines[1];
      const bytes = prepared.readStage(descriptor.stage_index).toString('utf8');
      cost = JSON.parse(bytes.slice(0, -1));
    } catch { throw transactionError('committed retry floor'); }
    if (cost.type !== 'cost' || cost.data?.turns !== floor || cost.data?.tokens !== 0
      || cost.data?.auto_floor !== true || cost.data?.for !== eventInput.type
      || cost.data?.owner !== manifest.expect.owner
      || cost.data?.generation !== manifest.expect.generation) {
      throw transactionError('committed retry floor');
    }
  }
  return {
    ok: true,
    event_identity: { seq: event.seq, checksum: event.checksum },
    operation_id: publication.operationId,
  };
}

function stableArtifactPredecessor(rootDir, rel) {
  const normalized = normalizePortableRelativePath(rel);
  if (!normalized) throw new Error('TRANSACTION_INVALID: artifact target');
  const parts = normalized.split('/');
  let current = rootDir;
  for (let index = 0; index < parts.length - 1; index++) {
    current = join(current, parts[index]);
    if (!existsSync(current)) return { kind: 'absent' };
    const stat = lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw transactionError('artifact parent type');
    const canonical = (realpathSync.native || realpathSync)(current);
    if (resolve(canonical) !== resolve(current)) throw transactionError('artifact parent substitution');
  }
  const target = join(rootDir, ...parts);
  if (!existsSync(target)) return { kind: 'absent' };
  const before = captureStableFileIdentity(target);
  const stat = lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw transactionError('artifact target type');
  const bytes = readFileSync(target);
  const after = captureStableFileIdentity(target);
  if (!matchingStableFileIdentity(before, after)) throw transactionError('artifact predecessor identity drift');
  return {
    kind: 'present',
    sha256: contentHash(bytes),
    identity: before,
    size: String(bytes.length),
  };
}

function exactBoundaryIdentity(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['checksum', 'seq'])
    && Number.isSafeInteger(value.seq)
    && value.seq > 0
    && /^[0-9a-f]{64}$/.test(value.checksum || '');
}

function sameBoundaryIdentity(left, right) {
  return exactBoundaryIdentity(left)
    && exactBoundaryIdentity(right)
    && left.seq === right.seq
    && left.checksum === right.checksum;
}

function validateBoundaryPublication(prepared, candidate) {
  const manifest = prepared.manifest;
  if (manifest.kind !== 'workstream-boundary-handoff') return;
  const topology = manifest.topology;
  const topologyKeys = [
    'boundary_event', 'child_run_id', 'handoff_rel', 'parent_run_id',
    'phase', 'project_binding_generation', 'project_root_digest',
  ];
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)
    || JSON.stringify(Object.keys(topology).sort()) !== JSON.stringify(topologyKeys)
    || topology.parent_run_id !== manifest.expect.owner
    || typeof topology.child_run_id !== 'string' || topology.child_run_id.length === 0
    || topology.phase !== 'emitted'
    || topology.project_binding_generation !== candidate.project?.binding_generation
    || topology.project_root_digest !== projectRootDigest(candidate.project?.root)
    || !sameBoundaryIdentity(topology.boundary_event, topology.boundary_event)) {
    throw transactionError('boundary publication topology');
  }
  const lease = candidate.session_chain?.lease || {};
  const child = (candidate.session_chain?.sessions || [])
    .find(session => session.run_id === topology.child_run_id);
  const parent = (candidate.session_chain?.sessions || [])
    .find(session => session.run_id === topology.parent_run_id);
  const workstream = parent && (candidate.workstreams || [])
    .find(item => item.id === parent.scope?.workstream_id);
  if (lease.takeover_kind !== 'boundary-handoff'
    || lease.handoff_phase !== 'emitted'
    || lease.handoff_idempotency_key !== manifest.operationId
    || lease.handoff_child_run_id !== topology.child_run_id
    || !sameBoundaryIdentity(lease.handoff_boundary_event, topology.boundary_event)
    || lease.handoff_project_binding_generation !== topology.project_binding_generation
    || lease.handoff_project_root_digest !== topology.project_root_digest
    || !child
    || child.parent_run_id !== topology.parent_run_id
    || child.handoff_rel !== topology.handoff_rel
    || child.project_binding_generation !== topology.project_binding_generation
    || child.project_root_digest !== topology.project_root_digest
    || !sameBoundaryIdentity(child.parent_boundary_event, topology.boundary_event)
    || child.scope?.kind !== 'workstream'
    || child.scope.workstream_id !== null
    || child.scope.terminal_event !== null
    || !parent
    || parent.superseded_by !== topology.child_run_id
    || parent.scope?.kind !== 'workstream'
    || parent.scope.closed_at == null
    || parent.scope.superseded_at == null
    || !sameBoundaryIdentity(parent.scope.terminal_event, topology.boundary_event)
    || !workstream
    || !(workstream.terminal_events || [])
      .some(event => sameBoundaryIdentity(event, topology.boundary_event))) {
    throw transactionError('boundary publication candidate topology');
  }
  const expectedTargets = [
    topology.handoff_rel,
    `handoffs/${topology.child_run_id}-compaction-state.json`,
    'terminal/launch-command.txt',
    'terminal/launch-command.meta.json',
  ];
  if (manifest.targets.length !== expectedTargets.length
    || manifest.targets.some((target, index) => target.rel !== expectedTargets[index])) {
    throw transactionError('boundary publication targets');
  }
  let launchBytes;
  let meta;
  try {
    launchBytes = prepared.readStage(manifest.targets[2].stage_index);
    meta = JSON.parse(prepared.readStage(manifest.targets[3].stage_index).toString('utf8'));
  } catch {
    throw transactionError('boundary publication metadata');
  }
  const payload = meta?.payload;
  if (meta?.envelope?.producer !== 'deep-loop'
    || meta.envelope.artifact_kind !== 'launch-command-meta'
    || meta.envelope.schema?.name !== 'launch-command-meta'
    || payload?.launch_command_sha256 !== contentHash(launchBytes)
    || payload.parent_run_id !== topology.parent_run_id
    || payload.child_run_id !== topology.child_run_id
    || payload.handoff_phase !== topology.phase
    || payload.handoff_rel !== topology.handoff_rel
    || payload.project_binding_generation !== topology.project_binding_generation
    || payload.project_root_digest !== topology.project_root_digest
    || !sameBoundaryIdentity(payload.boundary_event, topology.boundary_event)) {
    throw transactionError('boundary publication metadata');
  }
}

function validatePreparedAuthority(root, runId, prepared, candidate, candidateBytes, candidateHashBytes, {
  rootRecovery = false,
} = {}) {
  const manifest = prepared.manifest;
  const projectAuthorityMatches = rootRecovery
    ? projectRootDigest(manifest.projectRoot) === projectRootDigest(candidate.project?.root)
    : manifest.projectRoot === canonicalProjectRoot(root);
  if (!projectAuthorityMatches
    || candidate.run_id !== runId
    || candidate.autonomy?.session_runtime !== manifest.runtime
    || contentHash(candidateBytes) !== manifest.candidateLoopHash
    || candidateHashBytes.toString('utf8').trim() !== manifest.candidateLoopHash) {
    throw transactionError('prepared candidate authority');
  }
  const lease = candidate.session_chain?.lease;
  if (!lease || lease.owner_run_id !== manifest.expect.owner || lease.generation !== manifest.expect.generation) {
    throw transactionError('prepared fence authority');
  }
  validateBoundaryPublication(prepared, candidate);
}

function classifyPreparedRun(root, runId, guard, prepared, { rootRecovery = false } = {}) {
  const manifest = prepared.manifest;
  const loopStage = prepared.stages.find(stage => stage.role === 'candidate-loop');
  const hashStage = prepared.stages.find(stage => stage.role === 'candidate-loop-hash');
  if (!loopStage || !hashStage) throw transactionError('candidate stages');
  const candidateBytes = prepared.readStage(loopStage.index);
  const candidateHashBytes = prepared.readStage(hashStage.index);
  let candidate;
  try {
    candidate = parseHashVerifiedStateBytes(root, runId, candidateBytes, candidateHashBytes, {
      requireSchema: true,
      requireProjectBinding: !rootRecovery,
    }).data;
  } catch (error) {
    throw transactionError(`candidate state: ${error?.message || error}`);
  }
  validatePreparedAuthority(root, runId, prepared, candidate, candidateBytes, candidateHashBytes, { rootRecovery });

  const stagedEvents = [];
  let expectedHead = manifest.preEventHead;
  for (let index = 0; index < manifest.eventLines.length; index++) {
    const descriptor = manifest.eventLines[index];
    const bytes = prepared.readStage(descriptor.stage_index);
    let event;
    try {
      if (!bytes.toString('utf8').endsWith('\n')) throw new Error('newline');
      event = JSON.parse(bytes.toString('utf8').slice(0, -1));
    } catch { throw transactionError(`event stage ${index}`); }
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || JSON.stringify(Object.keys(event)) !== JSON.stringify(['seq', 'ts', 'type', 'data', 'checksum'])
      || operationTimestamp(event.ts) !== event.ts) {
      throw transactionError(`event shape ${index}`);
    }
    const expected = nextEvent([], { type: event.type, data: event.data, now: event.ts });
    const checksum = checksumFor(event.seq, event.ts, event.type, event.data, expectedHead.checksum);
    if (event.seq !== expectedHead.seq + 1 || event.seq !== descriptor.seq
      || event.checksum !== checksum || event.checksum !== descriptor.checksum
      || contentHash(bytes) !== descriptor.sha256 || String(bytes.length) !== descriptor.size
      || expected.type !== event.type || expected.data === undefined) {
      throw transactionError(`event stage binding ${index}`);
    }
    stagedEvents.push({ event, bytes });
    expectedHead = { seq: event.seq, checksum: event.checksum };
  }
  if (candidate.event_log_head?.seq !== expectedHead.seq
    || candidate.event_log_head?.checksum !== expectedHead.checksum) {
    throw transactionError('candidate event head');
  }
  const costTotal = stagedEvents.reduce((acc, item) => {
    if (item.event.type !== 'cost') return acc;
    if (!validCost(item.event.data)) throw transactionError('candidate cost event');
    return { turns: acc.turns + item.event.data.turns, tokens: acc.tokens + item.event.data.tokens };
  }, { turns: 0, tokens: 0 });

  const raw = readRawRun(root, runId);
  const currentLoopHash = contentHash(raw.loopBytes);
  const storedHash = raw.hashBytes?.toString('utf8');
  const loopState = currentLoopHash === manifest.preLoopHash
    ? 'predecessor'
    : currentLoopHash === manifest.candidateLoopHash ? 'candidate' : 'conflict';
  const hashState = storedHash === manifest.preLoopHash
    ? 'predecessor'
    : storedHash === manifest.candidateLoopHash ? 'candidate' : 'conflict';
  if (loopState === 'conflict' || hashState === 'conflict'
    || (loopState === 'predecessor' && hashState === 'candidate')) {
    throw transactionError('state/hash publication order');
  }
  if (loopState === 'predecessor' && hashState === 'predecessor') {
    let predecessor;
    try {
      predecessor = parseHashVerifiedStateBytes(root, runId, raw.loopBytes, raw.hashBytes, {
        requireSchema: true,
        requireProjectBinding: !rootRecovery,
      }).data;
    } catch (error) {
      throw transactionError(`predecessor state: ${error?.message || error}`);
    }
    const lease = predecessor.session_chain?.lease;
    if (predecessor.autonomy?.session_runtime !== manifest.runtime
      || !lease || lease.owner_run_id !== manifest.expect.owner
      || lease.generation !== manifest.expect.generation) {
      throw transactionError('predecessor authority');
    }
  }

  const currentLog = parseExactLogBytes(raw.logBytes, { reconciliation: true });
  const currentLines = currentLog.lines;
  const preSeq = manifest.preEventHead?.seq;
  if (!Number.isSafeInteger(preSeq) || preSeq < 0 || currentLines.length < preSeq
    || currentLines.length > preSeq + stagedEvents.length
    || JSON.stringify(headOfLines(currentLines.slice(0, preSeq))) !== JSON.stringify(manifest.preEventHead)) {
    throw transactionError('event predecessor');
  }
  const appendedCount = currentLines.length - preSeq;
  for (let index = 0; index < appendedCount; index++) {
    const observedBytes = currentLog.lineBytes[preSeq + index];
    const descriptor = manifest.eventLines[index];
    if (String(observedBytes.length) !== descriptor.size
      || contentHash(observedBytes) !== descriptor.sha256
      || !observedBytes.equals(stagedEvents[index].bytes)) {
      throw transactionError('event publication prefix');
    }
  }
  const predecessorCosts = currentLines.slice(0, preSeq).reduce((acc, item) => {
    if (item.type !== 'cost') return acc;
    return { turns: acc.turns + item.data.turns, tokens: acc.tokens + item.data.tokens };
  }, { turns: 0, tokens: 0 });
  if (candidate.budget?.spent !== predecessorCosts.turns + costTotal.turns
    || candidate.budget?.tokens_spent !== predecessorCosts.tokens + costTotal.tokens) {
    throw transactionError('candidate accounting');
  }

  const artifactVector = classifyArtifactTargetsLocked(raw.dir, guard, manifest);
  const artifactsComplete = artifactVector.classifications.every(item => item.state === 'candidate' && item.targetDone);
  const eventsComplete = appendedCount === stagedEvents.length;
  const stateComplete = loopState === 'candidate' && hashState === 'candidate';
  const committed = publicationCommittedLocked(raw.dir, guard, prepared);
  if ((appendedCount > 0 && !artifactsComplete)
    || (loopState === 'candidate' && !eventsComplete)
    || (hashState === 'candidate' && loopState !== 'candidate')
    || (committed && (!artifactsComplete || !eventsComplete || !stateComplete))) {
    throw transactionError('cross-resource publication order');
  }
  return {
    raw,
    manifest,
    candidateBytes,
    candidateHashBytes,
    stagedEvents,
    appendedCount,
    loopState,
    hashState,
    committed,
  };
}

function appendDurableLine(path, bytes, guard, faultAt, index) {
  guard.assertOwned();
  const fd = openSync(path, 'a', 0o600);
  try {
    appendFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  faultAt(`event:${index}:append`);
  guard.renew();
}

export function reconcileAnchoredPublicationLocked(root, runId, guard, {
  faultAt = () => {},
  forceUnlinkReplacement = false,
  durableWriteFn = durableAtomicWrite,
  rootRecovery = false,
} = {}) {
  guard.assertOwned();
  if (!existsSync(join(runDir(root, runId), 'transactions'))) {
    return { ok: true, reconciled: false };
  }
  const prepared = findPreparedPublicationLocked(runDir(root, runId), guard);
  if (!prepared) return { ok: true, reconciled: false };
  const classified = classifyPreparedRun(root, runId, guard, prepared, { rootRecovery });
  if (classified.committed) return { ok: true, reconciled: true, committed: true };

  publishArtifactTargetsLocked(runDir(root, runId), guard, classified.manifest, {
    faultAt,
    forceUnlinkReplacement,
    durableWriteFn,
  });
  for (let index = classified.appendedCount; index < classified.stagedEvents.length; index++) {
    appendDurableLine(logPath(root, runId), classified.stagedEvents[index].bytes, guard, faultAt, index);
  }
  if (classified.loopState === 'predecessor') {
    durableWriteFn(join(runDir(root, runId), 'loop.json'), classified.candidateBytes, {
      barrierAt(phase) { faultAt(`state:loop:${phase}`); guard.renew(); },
    });
    faultAt('state:loop:rename');
  }
  if (classified.hashState === 'predecessor') {
    durableWriteFn(join(runDir(root, runId), '.loop.hash'), classified.candidateHashBytes, {
      barrierAt(phase) { faultAt(`state:hash:${phase}`); guard.renew(); },
    });
    faultAt('state:hash:rename');
  }
  const finalClassified = classifyPreparedRun(root, runId, guard, prepared, { rootRecovery });
  if (finalClassified.loopState !== 'candidate' || finalClassified.hashState !== 'candidate'
    || finalClassified.appendedCount !== finalClassified.stagedEvents.length
    || !finalClassified.raw.hashBytes) throw transactionError('incomplete replay');
  markPublicationCommittedLocked(runDir(root, runId), guard, prepared, { durableWriteFn, faultAt });
  return { ok: true, reconciled: true, committed: true };
}

export function captureReconciledRunSnapshot(root, runId, options = {}) {
  return withLock(root, runId, guard => {
    reconcileAnchoredPublicationLocked(root, runId, guard, options);
    const snapshot = snapshotRaw(root, runId, readRawRun(root, runId));
    return { ...snapshot, artifacts: captureArtifactsLocked(root, runId, options.artifactRels) };
  }, options.lockOptions);
}

function frozenRunIds(root, requested) {
  if (requested !== undefined) {
    if (!Array.isArray(requested)) throw new Error('RUN_SET_INVALID: runIds');
    const ids = [...new Set(requested)].sort();
    for (const id of ids) runDir(root, id);
    return Object.freeze(ids);
  }
  const dir = join(root, '.deep-loop', 'runs');
  if (!existsSync(dir)) return Object.freeze([]);
  return Object.freeze([...new Set(readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name))].sort());
}

export function captureReconciledRunSet(root, options = {}) {
  const runIds = frozenRunIds(root, options.runIds);
  options.afterEnumeration?.(runIds);
  const runs = Object.create(null);
  const errors = Object.create(null);
  for (const runId of runIds) {
    const capture = () => captureReconciledRunSnapshot(root, runId, {
      artifactRels: options.artifactRelsByRun?.[runId] || [],
      lockOptions: options.lockOptions,
    });
    try {
      runs[runId] = capture();
    } catch (firstError) {
      try {
        const delay = options.retryDelayMs ?? 50;
        if (options.sleepFn) options.sleepFn(delay);
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        runs[runId] = capture();
      } catch (error) {
        errors[runId] = Object.freeze({
          kind: error?.name === 'SyntaxError' ? 'unreadable' : 'integrity',
          message: String(error?.message || error),
        });
      }
    }
  }
  return Object.freeze({ root: canonicalProjectRoot(root), runIds, runs, errors });
}

function assertRootRecoveryBinding(candidateRoot, snapshot) {
  const binding = classifyProjectRootBinding(candidateRoot, snapshot.data.project?.root);
  if (binding.mismatch_class !== 'unresolvable') {
    if (binding.mismatch_class === 'fenced') throw new Error('PROJECT_ROOT_FENCED: stored project root still resolves');
    throw new Error('PROJECT_ROOT_REBIND_NOT_ALLOWED: project root already matches');
  }
  return binding;
}

export function captureReconciledRootRecoverySnapshot(candidateRoot, runId, options = {}) {
  return withLock(candidateRoot, runId, guard => {
    reconcileAnchoredPublicationLocked(candidateRoot, runId, guard, { ...options, rootRecovery: true });
    const snapshot = snapshotRaw(candidateRoot, runId, readRawRun(candidateRoot, runId), {
      requireProjectBinding: false,
    });
    assertRootRecoveryBinding(candidateRoot, snapshot);
    return { ...snapshot, artifacts: captureArtifactsLocked(candidateRoot, runId, options.artifactRels) };
  }, options.lockOptions);
}

export function withReconciledRootRecoveryLock(candidateRoot, runId, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('MUTATION_CALLBACK_REQUIRED');
  return withLock(candidateRoot, runId, guard => {
    reconcileAnchoredPublicationLocked(candidateRoot, runId, guard, { ...options, rootRecovery: true });
    const snapshot = snapshotRaw(candidateRoot, runId, readRawRun(candidateRoot, runId), {
      requireProjectBinding: false,
    });
    assertRootRecoveryBinding(candidateRoot, snapshot);
    if (existsSync(join(runDir(candidateRoot, runId), 'transactions'))) {
      retireCommittedPublicationLocked(runDir(candidateRoot, runId), guard);
    }
    return callback(guard, snapshot);
  }, options.lockOptions);
}

export function withReconciledMutationLock(root, runId, callback, options = {}) {
  if (typeof callback !== 'function') throw new Error('MUTATION_CALLBACK_REQUIRED');
  return withLock(root, runId, guard => {
    reconcileAnchoredPublicationLocked(root, runId, guard, options);
    const snapshot = snapshotRaw(root, runId, readRawRun(root, runId), { requireSchema: false });
    if (existsSync(join(runDir(root, runId), 'transactions'))) {
      retireCommittedPublicationLocked(runDir(root, runId), guard);
    }
    return callback(guard, snapshot);
  }, options.lockOptions);
}

export function appendEvent(root, runId, { type, data, now }) {
  const event = nextEvent(readLines(root, runId), { type, data, now });
  appendFileSync(logPath(root, runId), JSON.stringify(event) + '\n');
  return event;
}

// line-based 검증 — 호출자가 이미 읽어둔 in-memory 배열을 검증한다. "검증한 배열 == 분석하는 배열"이
// 필요한 소비자(insights의 단일 읽기 스냅샷)가 디스크 재읽기 없이 쓴다 (impl-R2 🟡2: verifyHead와
// readLines 사이 concurrent append가 검증 밖 suffix로 유입되는 창 제거).
export function verifyLines(lines) {
  const errors = [];
  let prev = 'GENESIS';
  lines.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`seq gap at ${i + 1}`);
    if (e.checksum !== checksumFor(e.seq, e.ts, e.type, e.data, prev)) errors.push(`checksum break at seq ${e.seq}`);
    if (e.type === 'cost' && !validCost(e.data)) errors.push(`invalid cost data at seq ${e.seq}`);
    prev = e.checksum;
  });
  return { ok: errors.length === 0, errors };
}

export function verifyLog(root, runId) {
  return verifyLines(readLines(root, runId));
}

// cost turns/tokens는 유한 비음수만 허용 (음수 주입으로 spent를 낮추는 우회 차단, Codex impl 🔴2)
export function validCost(d) {
  return d && Number.isFinite(d.turns) && d.turns >= 0 && Number.isFinite(d.tokens) && d.tokens >= 0;
}

export function recomputeSpent(root, runId) {
  return readLines(root, runId).filter(e => e.type === 'cost').reduce((acc, e) => {
    if (!validCost(e.data)) throw new Error(`LOG_CORRUPT: invalid cost event at seq ${e.seq}`);
    return { turns: acc.turns + e.data.turns, tokens: acc.tokens + e.data.tokens };
  }, { turns: 0, tokens: 0 });
}

// 마지막 이벤트의 head {seq, checksum} (빈 로그면 GENESIS) — loop.json 앵커와 대조용 (Codex impl 🔴3)
export function headOfLines(lines) {
  return lines.length ? { seq: lines[lines.length - 1].seq, checksum: lines[lines.length - 1].checksum } : { seq: 0, checksum: 'GENESIS' };
}

export function lastLogHead(root, runId) {
  return headOfLines(readLines(root, runId));
}

// 로그 tail이 기대 head와 일치하는지 — suffix truncation 탐지. line-based 변형은 verifyLines와 같은
// 이유(검증 배열과 소비 배열의 동일성)로 존재한다.
export function verifyHeadLines(lines, expected) {
  const exp = expected || { seq: 0, checksum: 'GENESIS' };
  const head = headOfLines(lines);
  if (head.seq !== exp.seq || head.checksum !== exp.checksum) {
    return { ok: false, errors: [`log head ${head.seq}/${head.checksum} != anchor ${exp.seq}/${exp.checksum}`] };
  }
  return { ok: true, errors: [] };
}

export function verifyHead(root, runId, expected) {
  return verifyHeadLines(readLines(root, runId), expected);
}

// 단일 anchored append 경로 — 이벤트 append + loop.json의 event_log_head 앵커 갱신을 한 lock 안에서.
// 모든 이벤트 기록(cost 포함)은 이 경로를 통해야 앵커가 stale되지 않는다 (Codex impl r2 🟡).
// mutate(loop, spent): 호출자별 상태 변경(예: budget.spent) — 선택.
// preCheck(loop): lock 안 fresh loop 위에서 실행 — throw하면 append 전에 중단 (Codex r3 🔴: 가드 원자성).
// opts.floor (#3): a business-intent mutation is charged a minimum floor of `opts.floor` turns via a PAIRED cost
// event appended in the SAME lock/anchor, so a driver cannot neutralize the turns budget / per_session_turn_cap by
// under-reporting or skipping `budget record`. Omitting floor (control-plane appends, recordCost) keeps the old
// behavior exactly — floor is strictly opt-in.
export function appendAnchored(root, runId, { type, data, now }, mutate, preCheck, opts = {}) {
  return withLock(root, runId, guard => {
    const publication = opts.publication ? materializePublication(opts.publication) : null;
    reconcileAnchoredPublicationLocked(root, runId, guard, {
      faultAt: publication?.faultAt,
      forceUnlinkReplacement: publication?.forceUnlinkReplacement,
      durableWriteFn: publication?.durableWriteFn,
    });
    if (publication && existsSync(join(runDir(root, runId), 'transactions'))) {
      const existing = findPreparedPublicationLocked(runDir(root, runId), guard);
      if (existing?.manifest.operationId === publication.operationId
        && publicationCommittedLocked(runDir(root, runId), guard, existing)) {
        return committedRetryResult(existing, publication, { type, data }, opts.floor, now);
      }
    }
    if (existsSync(join(runDir(root, runId), 'transactions'))) {
      retireCommittedPublicationLocked(runDir(root, runId), guard);
    }
    const before = snapshotRaw(root, runId, readRawRun(root, runId), { requireSchema: false });
    const loop = structuredClone(before.data);
    // Defense in depth at the shared mutation gateway: this check stays inside the existing lock and precedes
    // caller guards and event writes. readState is already strict, so no unbound reader is exposed here.
    assertProjectRootBinding(root, loop);
    if (preCheck) preCheck(loop);              // throws BEFORE append → anchor stays consistent
    // Invariant: do not add a throwing guard after preCheck; preCheck side effects are coupled to this ordering.
    // v1.6 gateway terminal gate (spec §2.1.5): 반드시 caller preCheck **뒤** — fence-first 보존
    // (LEASE_FENCED/RESPAWN_FENCED/RUN_TERMINAL:emitHandoff 등 특정-에러 경로가 먼저 발화해야 한다).
    // 여기 도달했는데 terminal이면 "어떤 preCheck도 못 잡은" fence-less 경로 — 최후 방벽.
    // finish 이벤트는 preCheck 시점 non-terminal(전이는 mutate 단계)이라 자연 통과; double-finish는 차단된다.
    if (loop.status === 'completed' || loop.status === 'stopped') throw new Error('RUN_TERMINAL: append');
    // Codex impl r12 🔴: verify the existing log (chain + tail vs stored anchor) BEFORE appending. Otherwise a
    // suffix-truncated/tampered log would be laundered — a new append + fresh anchor would hide the loss and
    // reconcileBudget would no longer detect it. Fail-stop here keeps the anchor honest.
    const timestamp = operationTimestamp(now ?? publication?.nowFn?.());
    const frozenData = deepFreeze(structuredClone(data));
    const event = deepFreeze(nextEvent(before.logLines, { type, data: frozenData, now: timestamp }));
    const events = [event];
    // Paired floor cost — SAME lock/anchor as the mutation event, so verifyHead/reconcileBudget stay consistent.
    // impl-R1 Fix 1: tag the floor with the CURRENT lease owner+generation. recordCost only absorbs floors from its
    // OWN session, so an explicit report in a LATER session cannot swallow an EARLIER session's floors (which are
    // confirmed prior consumption) — that would undercount total spent and weaken per_session_turn_cap.
    if (opts.floor) {
      const lease = loop.session_chain?.lease || {};
      events.push(deepFreeze(nextEvent([...before.logLines, ...events], {
        type: 'cost',
        data: { turns: opts.floor, tokens: 0, auto_floor: true, for: type, owner: lease.owner_run_id, generation: lease.generation },
        now: timestamp,
      })));
    }
    loop.event_log_head = headOfLines([...before.logLines, ...events]);
    const spent = (mutate || opts.floor)
      ? [...before.logLines, ...events].filter(item => item.type === 'cost').reduce((acc, item) => {
        if (!validCost(item.data)) throw new Error(`LOG_CORRUPT: invalid cost event at seq ${item.seq}`);
        return { turns: acc.turns + item.data.turns, tokens: acc.tokens + item.data.tokens };
      }, { turns: 0, tokens: 0 })
      : null;
    if (opts.floor) {
      loop.budget.spent = spent.turns;
      loop.budget.tokens_spent = spent.tokens;
      // per_session_turn_cap is judged off the lease owner's session.turns (next-action.mjs) — bump it here so
      // the floor drives the handoff cadence (= human checkpoints) too, not only budget.spent.
      const owner = loop.session_chain?.lease?.owner_run_id;
      const sess = (loop.session_chain?.sessions || []).find(s => s.run_id === owner);
      if (sess) sess.turns = (sess.turns || 0) + opts.floor;
    }
    const tx = deepFreeze({
      event,
      event_identity: deepFreeze({ seq: event.seq, checksum: event.checksum }),
    });
    if (mutate) mutate(loop, spent, tx);
    loop.updated_at = timestamp;
    assertProjectRootBinding(root, loop);
    const checked = validate(loop);
    if (!checked.ok) throw new Error(`STATE_INVALID: ${checked.errors.join('; ')}`);

    if (!publication) {
      for (const item of events) appendFileSync(logPath(root, runId), `${JSON.stringify(item)}\n`);
      writeState(root, runId, loop);
      return undefined;
    }

    const dir = (realpathSync.native || realpathSync)(runDir(root, runId));
    const candidateBytes = Buffer.from(JSON.stringify(loop, null, 2));
    const candidateLoopHash = contentHash(candidateBytes);
    const candidateHashBytes = Buffer.from(candidateLoopHash);
    const stages = publication.artifacts.map(artifact => ({
      role: 'artifact', target_rel: artifact.rel, bytes: artifact.bytes,
    }));
    const targets = publication.artifacts.map((artifact, stageIndex) => ({
      role: 'artifact',
      rel: artifact.rel,
      stage_index: stageIndex,
      candidate_sha256: contentHash(artifact.bytes),
      candidate_size: String(artifact.bytes.length),
      predecessor: stableArtifactPredecessor(dir, artifact.rel),
    }));
    const eventLines = events.map(item => {
      const bytes = Buffer.from(`${JSON.stringify(item)}\n`);
      const stage_index = stages.length;
      stages.push({ role: 'event-line', target_rel: null, bytes });
      return {
        stage_index,
        seq: item.seq,
        checksum: item.checksum,
        sha256: contentHash(bytes),
        size: String(bytes.length),
      };
    });
    stages.push({ role: 'candidate-loop', target_rel: null, bytes: candidateBytes });
    stages.push({ role: 'candidate-loop-hash', target_rel: null, bytes: candidateHashBytes });
    const lease = before.data.session_chain?.lease;
    if (!lease || typeof lease.owner_run_id !== 'string'
      || !Number.isSafeInteger(lease.generation) || lease.generation < 1) {
      throw new Error('TRANSACTION_INVALID: publication fence');
    }
    const manifest = {
      kind: publication.kind,
      operationId: publication.operationId,
      expect: { owner: lease.owner_run_id, generation: lease.generation },
      runtime: before.data.autonomy?.session_runtime,
      projectRoot: canonicalProjectRoot(root),
      preLoopHash: before.hash,
      preEventHead: structuredClone(before.data.event_log_head),
      eventLines,
      candidateLoopHash,
      topology: publication.topology,
      targets,
    };
    const prepared = preparePublicationStagesLocked(dir, guard, manifest, stages, {
      nowFn: () => Date.parse(timestamp),
      faultAt: publication.faultAt,
      durableWriteFn: publication.durableWriteFn,
    });
    if (!prepared.ok) throw new Error('TRANSACTION_NOT_PREPARED');
    try {
      reconcileAnchoredPublicationLocked(root, runId, guard, {
        faultAt: publication.faultAt,
        forceUnlinkReplacement: publication.forceUnlinkReplacement,
        durableWriteFn: publication.durableWriteFn,
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (message.startsWith('TRANSACTION_RECONCILIATION_REQUIRED') || message.startsWith('LOCK_')) throw error;
      throw new Error('TRANSACTION_PENDING: prepared publication requires reconciliation', { cause: error });
    }
    return { ok: true, event_identity: tx.event_identity, operation_id: publication.operationId };
  });
}

// Root relocation is the sole mutation that cannot enter appendAnchored: the old lexical root is intentionally
// unresolvable, while appendAnchored performs a strict bound read and owns its own non-reentrant lock. The caller
// already owns the candidate run lock. This fixed commit accepts neither a caller-selected event nor a mutation
// callback; all validation completes before its single hard-coded append.
export function commitProjectRootRebindUnderLock(root, runId, loop, { oldRootDigest, newRoot, now }) {
  if (!loop || typeof loop !== 'object' || loop.run_id !== runId) {
    throw new Error('STATE_INVALID: loop.run_id mismatch');
  }
  if (!/^[0-9a-f]{64}$/.test(oldRootDigest || '') || projectRootDigest(loop.project?.root) !== oldRootDigest) {
    throw new Error('INVALID_STORED_ROOT_DIGEST: stored root changed');
  }
  let canonicalRoot;
  try {
    canonicalRoot = canonicalProjectRoot(root);
    if (canonicalProjectRoot(newRoot) !== canonicalRoot || newRoot !== canonicalRoot) {
      throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed');
    }
  } catch (error) {
    if (String(error?.message || error) === 'PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed') throw error;
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root', { cause: error });
  }

  const lines = readLines(root, runId);
  const verified = verifyLines(lines);
  if (!verified.ok) throw new Error(`LOG_TAMPERED: ${verified.errors.join('; ')}`);
  const anchored = verifyHeadLines(lines, loop.event_log_head);
  if (!anchored.ok) throw new Error(`LOG_TAMPERED: ${anchored.errors.join('; ')}`);

  const data = { old_root_digest: oldRootDigest, new_root: canonicalRoot };
  const event = nextEvent(lines, { type: 'project-root-rebound', data, now });
  const candidate = structuredClone(loop);
  candidate.project.root = canonicalRoot;
  candidate.event_log_head = { seq: event.seq, checksum: event.checksum };
  const stateValidation = validate(candidate);
  if (!stateValidation.ok) throw new Error(`STATE_INVALID: ${stateValidation.errors.join('; ')}`);

  appendFileSync(logPath(root, runId), JSON.stringify(event) + '\n');
  writeState(root, runId, candidate);
  return { ok: true };
}
