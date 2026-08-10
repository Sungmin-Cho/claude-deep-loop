import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { durableAtomicWrite, flushDirectory } from './atomic-write.mjs';
import { contentHash, wrap } from './envelope.mjs';
import {
  captureStableFileIdentity,
  matchingStableFileIdentity,
} from './fs-safe.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOP_KEYS = ['schema_version', 'envelope', 'payload'];
const ENVELOPE_KEYS = [
  'producer', 'artifact_kind', 'schema', 'run_id', 'parent_run_id',
  'generated_at', 'git', 'provenance',
];
const RECEIPT_KEYS = [
  'checkpoint_key', 'context_sha256', 'owner_run_id', 'generation', 'runtime',
  'workstream_id', 'episode_id', 'trigger', 'provider_evidence',
];
const EVIDENCE_KEYS = ['recorded', 'supplied', 'matched'];
const ADMISSION_KEYS = ['kind', 'source', 'receipt_trigger'];
const REQUEST_BINDING_KEYS = [
  'checkpoint_key', 'context_sha256', 'owner_run_id', 'generation', 'runtime',
  'admission_kind', 'source', 'confirm_manual_compact', 'proof',
];
const INTENT_KEYS = [
  'operation_id', 'pre_event_log_head', 'pre_loop_hash', 'checkpoint_key',
  'context_sha256', 'pre_restore_loop_hash', 'owner_run_id', 'generation',
  'runtime', 'workstream_id', 'episode_id', 'baseline_turns', 'cycle',
  'admission', 'provider_evidence', 'request_binding', 'request_binding_sha256',
  'timestamp', 'planned_event_line', 'planned_event_sha256', 'planned_event',
];
const PLANNED_EVENT_KEYS = ['seq', 'type', 'data', 'checksum'];

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plainObject(value)
  && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const canonicalIso = value => typeof value === 'string'
  && Number.isFinite(new Date(value).getTime())
  && new Date(value).toISOString() === value;
const boundary = value => exactKeys(value, ['seq', 'checksum'])
  && Number.isSafeInteger(value.seq) && value.seq >= 0
  && (value.seq === 0 ? value.checksum === 'GENESIS' : SHA256.test(value.checksum || ''));

function assertGuard(guard, runDirectory) {
  if (!guard || typeof guard.assertOwned !== 'function' || typeof guard.renew !== 'function') {
    throw new Error('LOCK_GUARD_REQUIRED');
  }
  guard.assertOwned(runDirectory);
}

function stableRegular(path, code) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch { throw new Error(code); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(code);
  const before = captureStableFileIdentity(path);
  const bytes = readFileSync(path);
  const after = captureStableFileIdentity(path);
  if (!matchingStableFileIdentity(before, after)) throw new Error(code);
  return bytes;
}

function exactEnvelope(value, { runId, artifactKind, sourceArtifacts }) {
  return exactKeys(value, TOP_KEYS)
    && value.schema_version === '1.0'
    && exactKeys(value.envelope, ENVELOPE_KEYS)
    && value.envelope.producer === 'deep-loop'
    && value.envelope.artifact_kind === artifactKind
    && exactKeys(value.envelope.schema, ['name', 'version'])
    && value.envelope.schema.name === artifactKind
    && value.envelope.schema.version === '1.0'
    && value.envelope.run_id === runId
    && value.envelope.parent_run_id === null
    && canonicalIso(value.envelope.generated_at)
    && exactKeys(value.envelope.git, [])
    && exactKeys(value.envelope.provenance, ['source_artifacts', 'tool_versions'])
    && JSON.stringify(value.envelope.provenance.source_artifacts) === JSON.stringify(sourceArtifacts)
    && exactKeys(value.envelope.provenance.tool_versions, []);
}

export function validCompactProviderEvidence(value) {
  return exactKeys(value, EVIDENCE_KEYS)
    && EVIDENCE_KEYS.every(key => typeof value[key] === 'boolean')
    && value.matched === (value.recorded && value.supplied);
}

export function compactObservationRel(checkpointKey) {
  if (!SHA256.test(checkpointKey || '')) throw new Error('CHECKPOINT_RECEIPT_INVALID');
  return `checkpoints/${checkpointKey}-compact-observation.json`;
}

export function readCompactObservationProofLocked(runDirectory, runId, checkpointRel, expected, guard) {
  assertGuard(guard, runDirectory);
  const rel = compactObservationRel(expected.checkpoint_key);
  const path = join(runDirectory, ...rel.split('/'));
  if (resolve(path) !== resolve(runDirectory, ...rel.split('/'))) {
    throw new Error('CHECKPOINT_RECEIPT_INVALID');
  }
  const bytes = stableRegular(path, 'CHECKPOINT_RECEIPT_REQUIRED');
  if (bytes.length === 0 || bytes.length > 256 * 1024) throw new Error('CHECKPOINT_RECEIPT_INVALID');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_RECEIPT_INVALID'); }
  if (!exactEnvelope(value, {
    runId,
    artifactKind: 'compact-observation',
    sourceArtifacts: [checkpointRel],
  })
    || !exactKeys(value.payload, RECEIPT_KEYS)
    || value.payload.checkpoint_key !== expected.checkpoint_key
    || value.payload.context_sha256 !== expected.context_sha256
    || value.payload.owner_run_id !== expected.owner_run_id
    || value.payload.generation !== expected.generation
    || value.payload.runtime !== expected.runtime
    || value.payload.workstream_id !== expected.workstream_id
    || value.payload.episode_id !== expected.episode_id
    || !['manual', 'auto'].includes(value.payload.trigger)
    || !validCompactProviderEvidence(value.payload.provider_evidence)) {
    throw new Error('CHECKPOINT_RECEIPT_INVALID');
  }
  guard.renew();
  return Object.freeze({
    rel,
    digest: contentHash(bytes),
    payload: structuredClone(value.payload),
  });
}

export function compactRestoreRequestBinding(input) {
  const value = {
    checkpoint_key: input.checkpoint_key,
    context_sha256: input.context_sha256,
    owner_run_id: input.owner_run_id,
    generation: input.generation,
    runtime: input.runtime,
    admission_kind: input.admission_kind,
    source: input.source,
    confirm_manual_compact: input.confirm_manual_compact,
    proof: structuredClone(input.proof),
  };
  if (!exactKeys(value, REQUEST_BINDING_KEYS)
    || !SHA256.test(value.checkpoint_key || '')
    || !SHA256.test(value.context_sha256 || '')
    || typeof value.owner_run_id !== 'string' || value.owner_run_id.length === 0
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !['claude', 'codex'].includes(value.runtime)
    || !['postcompact-observation', 'human-attested'].includes(value.admission_kind)
    || !['sessionstart', 'external-controller', 'direct-human-skill'].includes(value.source)
    || typeof value.confirm_manual_compact !== 'boolean'
    || !plainObject(value.proof)) {
    throw new Error('CHECKPOINT_ADMISSION_INVALID');
  }
  return value;
}

export function compactRestoreRequestBindingDigest(binding) {
  if (!exactKeys(binding, REQUEST_BINDING_KEYS)) throw new Error('CHECKPOINT_ADMISSION_INVALID');
  return contentHash(JSON.stringify(binding));
}

function intentDirectory(runDirectory, { create = false } = {}) {
  const dir = join(runDirectory, 'compact-restore-intents');
  if (!existsSync(dir)) {
    if (!create) return null;
    mkdirSync(dir, { mode: 0o700 });
    flushDirectory(runDirectory);
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || realpathSync(dir) !== realpathSync(join(runDirectory, 'compact-restore-intents'))) {
    throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  }
  return dir;
}

function validateIntentEnvelope(value, runId) {
  const checkpointRel = `checkpoints/${value?.payload?.checkpoint_key}-compact.json`;
  if (!exactEnvelope(value, {
    runId,
    artifactKind: 'compact-restore-intent',
    sourceArtifacts: [checkpointRel],
  }) || !exactKeys(value.payload, INTENT_KEYS)) {
    throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  }
  const payload = value.payload;
  if (!ULID.test(payload.operation_id || '')
    || !boundary(payload.pre_event_log_head)
    || !SHA256.test(payload.pre_loop_hash || '')
    || !SHA256.test(payload.checkpoint_key || '')
    || !SHA256.test(payload.context_sha256 || '')
    || !SHA256.test(payload.pre_restore_loop_hash || '')
    || typeof payload.owner_run_id !== 'string' || payload.owner_run_id.length === 0
    || !Number.isSafeInteger(payload.generation) || payload.generation < 1
    || !['claude', 'codex'].includes(payload.runtime)
    || typeof payload.workstream_id !== 'string' || payload.workstream_id.length === 0
    || typeof payload.episode_id !== 'string' || payload.episode_id.length === 0
    || !Number.isSafeInteger(payload.baseline_turns) || payload.baseline_turns < 0
    || !Number.isSafeInteger(payload.cycle) || payload.cycle < 1
    || !exactKeys(payload.admission, ADMISSION_KEYS)
    || !['postcompact-observation', 'human-attested'].includes(payload.admission.kind)
    || (payload.admission.kind === 'postcompact-observation'
      && (!['sessionstart', 'external-controller'].includes(payload.admission.source)
        || !['manual', 'auto'].includes(payload.admission.receipt_trigger)))
    || (payload.admission.kind === 'human-attested'
      && (payload.admission.source !== 'direct-human-skill'
        || payload.admission.receipt_trigger !== null))
    || !validCompactProviderEvidence(payload.provider_evidence)
    || !exactKeys(payload.request_binding, REQUEST_BINDING_KEYS)
    || compactRestoreRequestBindingDigest(payload.request_binding) !== payload.request_binding_sha256
    || !canonicalIso(payload.timestamp)
    || typeof payload.planned_event_line !== 'string'
    || !payload.planned_event_line.endsWith('\n')
    || payload.planned_event_line.endsWith('\n\n')
    || contentHash(payload.planned_event_line) !== payload.planned_event_sha256
    || !exactKeys(payload.planned_event, PLANNED_EVENT_KEYS)
    || !Number.isSafeInteger(payload.planned_event.seq) || payload.planned_event.seq < 1
    || payload.planned_event.type !== 'compact-restored'
    || !exactKeys(payload.planned_event.data, [
      'operation_id', 'checkpoint_key', 'context_sha256', 'pre_restore_loop_hash',
      'owner_run_id', 'generation', 'runtime', 'workstream_id', 'episode_id',
      'baseline_turns', 'cycle', 'admission', 'provider_evidence',
    ])
    || payload.planned_event.data.operation_id !== payload.operation_id
    || !SHA256.test(payload.planned_event.checksum || '')) {
    throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  }
  const expectedData = {
    operation_id: payload.operation_id,
    checkpoint_key: payload.checkpoint_key,
    context_sha256: payload.context_sha256,
    pre_restore_loop_hash: payload.pre_restore_loop_hash,
    owner_run_id: payload.owner_run_id,
    generation: payload.generation,
    runtime: payload.runtime,
    workstream_id: payload.workstream_id,
    episode_id: payload.episode_id,
    baseline_turns: payload.baseline_turns,
    cycle: payload.cycle,
    admission: payload.admission,
    provider_evidence: payload.provider_evidence,
  };
  const binding = payload.request_binding;
  if (payload.pre_restore_loop_hash !== payload.pre_loop_hash
    || payload.planned_event.seq !== payload.pre_event_log_head.seq + 1
    || JSON.stringify(payload.planned_event.data) !== JSON.stringify(expectedData)
    || payload.planned_event.checksum !== contentHash(
      `${payload.planned_event.seq}|${payload.timestamp}|compact-restored|${JSON.stringify(expectedData)}|${payload.pre_event_log_head.checksum}`,
    )
    || binding.checkpoint_key !== payload.checkpoint_key
    || binding.context_sha256 !== payload.context_sha256
    || binding.owner_run_id !== payload.owner_run_id
    || binding.generation !== payload.generation
    || binding.runtime !== payload.runtime
    || binding.admission_kind !== payload.admission.kind
    || binding.source !== payload.admission.source
    || binding.confirm_manual_compact !== (payload.admission.kind === 'human-attested')) {
    throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  }
  let line;
  try { line = JSON.parse(payload.planned_event_line.slice(0, -1)); }
  catch { throw new Error('COMPACT_RESTORE_INTENT_INVALID'); }
  if (JSON.stringify(line) !== JSON.stringify({
    seq: payload.planned_event.seq,
    ts: payload.timestamp,
    type: payload.planned_event.type,
    data: payload.planned_event.data,
    checksum: payload.planned_event.checksum,
  })) throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  return payload;
}

export function findCompactRestoreIntentLocked(runDirectory, runId, guard) {
  assertGuard(guard, runDirectory);
  const dir = intentDirectory(runDirectory);
  if (dir === null) return null;
  const names = readdirSync(dir).sort().filter(name => name.endsWith('.prepared.json'));
  if (names.length > 1) throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  if (names.length === 0) return null;
  const match = names[0].match(/^([0-9A-HJKMNP-TV-Z]{26})\.prepared\.json$/);
  if (!match) throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  const path = join(dir, names[0]);
  const bytes = stableRegular(path, 'COMPACT_RESTORE_INTENT_INVALID');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('COMPACT_RESTORE_INTENT_INVALID'); }
  const payload = validateIntentEnvelope(value, runId);
  if (payload.operation_id !== match[1]) throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  guard.renew();
  return Object.freeze({ path, bytes: Buffer.from(bytes), payload: structuredClone(payload) });
}

export function writeCompactRestoreIntentLocked(runDirectory, runId, payload, guard, {
  durableWriteFn = durableAtomicWrite,
  faultAt = () => {},
} = {}) {
  assertGuard(guard, runDirectory);
  if (findCompactRestoreIntentLocked(runDirectory, runId, guard)) {
    throw new Error('COMPACT_RESTORE_INTENT_PENDING');
  }
  const envelope = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-restore-intent',
    schema: { name: 'compact-restore-intent', version: '1.0' },
    run_id: runId,
    provenance: {
      source_artifacts: [`checkpoints/${payload.checkpoint_key}-compact.json`],
      tool_versions: {},
    },
    payload,
    now: payload.timestamp,
  });
  validateIntentEnvelope(envelope, runId);
  const dir = intentDirectory(runDirectory, { create: true });
  const path = join(dir, `${payload.operation_id}.prepared.json`);
  if (existsSync(path)) throw new Error('COMPACT_RESTORE_INTENT_INVALID');
  durableWriteFn(path, JSON.stringify(envelope, null, 2));
  guard.renew();
  faultAt('restore:intent-written');
  return Object.freeze({ path, payload: structuredClone(payload) });
}

export function removeCompactRestoreIntentLocked(intent, guard, {
  faultAt = () => {},
  removeFn = rmSync,
  flushDirectoryFn = flushDirectory,
} = {}) {
  assertGuard(guard, dirname(dirname(intent.path)));
  removeFn(intent.path, { force: false });
  flushDirectoryFn(dirname(intent.path));
  guard.renew();
  faultAt('restore:intent-cleanup');
}

export function liveCompactRestorePairsLocked(runDirectory, runId, guard) {
  const intent = findCompactRestoreIntentLocked(runDirectory, runId, guard);
  if (!intent) return Object.freeze([]);
  const key = intent.payload.checkpoint_key;
  return Object.freeze([Object.freeze({
    checkpoint_rel: `checkpoints/${key}-compact.json`,
    receipt_rel: compactObservationRel(key),
  })]);
}
