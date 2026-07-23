import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';
import { contentHash, ulid, unwrap, wrap } from './envelope.mjs';
import {
  captureStableFileIdentity,
  matchingStableFileIdentity,
  normalizePortableRelativePath,
} from './fs-safe.mjs';
import { leaseCheck } from './lease.mjs';
import { nextAction } from './next-action.mjs';
import { projectRootDigest } from './project-root.mjs';
import { validateSessionRuntime, sessionRuntime } from './runtime.mjs';
import { validate } from './schema.mjs';
import { isOpenScope, ownerSession } from './session-scope.mjs';
import { runDir, withReconciledMutationLock } from './state.mjs';

const KEEP = 5;
const STRICT_SCHEMA_VERSION = '2.0';
const STRICT_CONTEXT_DOMAIN = 'deep-loop-compact-checkpoint-v2';
const STRICT_FILE = /^([0-9a-f]{64})-compact\.json$/;
const MAX_CHECKPOINT_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACTS = 256;
const MAX_DESCRIPTOR_BYTES = 3072;
const TERMINAL_WORKSTREAM = new Set(['ready', 'merged', 'abandoned']);
const DESCRIPTOR_SLASH_COMMANDS = new Set([
  '/deep-loop-continue',
  '/deep-loop-discover',
  '/deep-loop-finish',
  '/deep-loop-handoff',
  '/deep-loop-status',
]);

const TOP_KEYS = Object.freeze(['schema_version', 'envelope', 'payload']);
const ENVELOPE_KEYS = Object.freeze([
  'producer', 'artifact_kind', 'schema', 'run_id', 'parent_run_id',
  'generated_at', 'git', 'provenance',
]);
const PAYLOAD_KEYS = Object.freeze(['checkpoint_key', 'context', 'context_sha256']);
const CONTEXT_KEYS = Object.freeze([
  'run_id',
  'owner_run_id',
  'generation',
  'project_root_digest',
  'project_binding_generation',
  'runtime',
  'loop_hash',
  'scope',
  'workstream',
  'current_episode',
  'artifacts',
  'next_action',
  'provider_evidence',
]);
const LEGACY_PAYLOAD_KEYS = Object.freeze([
  'owner_run_id',
  'generation',
  'loop_hash',
  'current_episode',
  'current_episode_detail',
  'active_workstreams',
  'next_action_hint',
  'artifacts',
]);

const checkpointDir = (root, runId) => join(runDir(root, runId), 'checkpoints');
const checkpointRel = key => `checkpoints/${key}-compact.json`;
const strictPath = (root, runId, key) => join(checkpointDir(root, runId), `${key}-compact.json`);
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const canonicalIso = value => typeof value === 'string'
  && Number.isFinite(new Date(value).getTime())
  && new Date(value).toISOString() === value;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compareLexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const exactKeys = (value, keys) => plainObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key, index) => Object.keys(value)[index] === key);

function authenticLegacy(loop) {
  let scope;
  try { scope = ownerSession(loop).scope; } catch { return false; }
  return scope?.kind === 'legacy'
    && loop?.autonomy?.continuation_policy !== 'workstream-session';
}

function assertCurrentSchema(loop) {
  const result = validate(loop);
  if (loop?.schema_version !== '0.4.0' || !result.ok) {
    throw new Error(`CHECKPOINT_STATE_INVALID: ${result.errors.join('; ')}`);
  }
}

function assertFence(loop, fence, runtime) {
  if (!plainObject(fence)
    || typeof fence.owner !== 'string'
    || fence.owner.length === 0
    || !Number.isSafeInteger(fence.generation)
    || fence.generation < 1) {
    throw new Error('FENCE_REQUIRED: owner and positive generation');
  }
  const assertedRuntime = validateSessionRuntime(runtime);
  if (sessionRuntime(loop) !== assertedRuntime) throw new Error('RUNTIME_FENCED: runtime mismatch');
  const checked = leaseCheck(loop, {
    owner: fence.owner,
    generation: fence.generation,
    runtime: assertedRuntime,
  });
  if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
  return assertedRuntime;
}

function normalizeProviderEvidence(value) {
  if (value === undefined || value === null) return null;
  if (!exactKeys(value, ['provider', 'id'])
    || typeof value.provider !== 'string'
    || value.provider.length === 0
    || value.provider.length > 128
    || /[\0\r\n]/.test(value.provider)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || value.id.length > 1024
    || /[\0\r\n]/.test(value.id)) {
    throw new Error('CHECKPOINT_EVIDENCE_INVALID');
  }
  return {
    provider: value.provider,
    identity_sha256: contentHash(value.id),
  };
}

function validStoredProviderEvidence(value) {
  return value === null || (exactKeys(value, ['provider', 'identity_sha256'])
    && typeof value.provider === 'string'
    && value.provider.length > 0
    && value.provider.length <= 128
    && !/[\0\r\n]/.test(value.provider)
    && sha256(value.identity_sha256));
}

function assertCheckpointDirectory(root, runId, { create = false } = {}) {
  const dir = checkpointDir(root, runId);
  if (!existsSync(dir)) {
    if (!create) return null;
    mkdirSync(dir, { recursive: true });
  }
  let lexical;
  try { lexical = lstatSync(dir); } catch { throw new Error('CHECKPOINT_PATH_INVALID'); }
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new Error('CHECKPOINT_PATH_INVALID');
  }
  const canonical = realpathSync(dir);
  if (canonical !== realpathSync(join(runDir(root, runId), 'checkpoints'))) {
    throw new Error('CHECKPOINT_PATH_INVALID');
  }
  return dir;
}

function observeArtifact(root, rel) {
  const normalized = normalizePortableRelativePath(rel);
  if (normalized === null || normalized !== rel) {
    throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${String(rel)}`);
  }
  let current = root;
  const segments = normalized.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    if (!existsSync(current)) {
      return { rel: normalized, state: 'absent', sha256: null, size: null };
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    }
    const before = captureStableFileIdentity(current);
    const bytes = readFileSync(current);
    const after = captureStableFileIdentity(current);
    if (!matchingStableFileIdentity(before, after) || bytes.length !== stat.size) {
      throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
    }
    return {
      rel: normalized,
      state: 'present',
      sha256: contentHash(bytes),
      size: bytes.length,
    };
  }
  throw new Error(`CHECKPOINT_ARTIFACT_INVALID: ${normalized}`);
}

function affinity(loop) {
  const session = ownerSession(loop);
  const scope = session.scope;
  if (!isOpenScope(scope)
    || scope.closed_at !== null
    || !Number.isSafeInteger(scope.bound_at_seq)
    || scope.bound_at_seq < 1
    || typeof scope.workstream_id !== 'string'
    || scope.workstream_id.length === 0) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: owner scope is not open and bound');
  }
  const workstream = (loop.workstreams || []).find(item => item?.id === scope.workstream_id);
  const episode = (loop.episodes || []).find(item => item?.id === loop.current_episode);
  if (!workstream
    || TERMINAL_WORKSTREAM.has(workstream.status)
    || !episode
    || episode.workstream_id !== scope.workstream_id) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: current Workstream or episode mismatch');
  }
  const artifacts = [...new Set([
    ...(Array.isArray(episode.expected_artifacts) ? episode.expected_artifacts : []),
    ...(Array.isArray(episode.artifacts) ? episode.artifacts : []),
  ])].sort();
  if (artifacts.length > MAX_ARTIFACTS) {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: artifact set too large');
  }
  return { scope, workstream, episode, artifacts };
}

function deriveContext(root, runId, snapshot, { now, providerEvidence }) {
  const { data: loop, hash } = snapshot;
  assertCurrentSchema(loop);
  if (loop.autonomy?.continuation_policy !== 'workstream-session') {
    throw new Error('CHECKPOINT_AFFINITY_INVALID: workstream-session required');
  }
  const { scope, workstream, episode, artifacts } = affinity(loop);
  return {
    run_id: runId,
    owner_run_id: loop.session_chain.lease.owner_run_id,
    generation: loop.session_chain.lease.generation,
    project_root_digest: projectRootDigest(loop.project.root),
    project_binding_generation: loop.project.binding_generation,
    runtime: sessionRuntime(loop),
    loop_hash: hash,
    scope: structuredClone(scope),
    workstream: structuredClone(workstream),
    current_episode: structuredClone(episode),
    artifacts: artifacts.map(rel => observeArtifact(root, rel)),
    next_action: nextAction(loop, { now, unattended: false }),
    provider_evidence: providerEvidence,
  };
}

function strictEnvelope(runId, context, now) {
  const contextSha = contentHash(JSON.stringify(context));
  const key = contentHash(JSON.stringify([STRICT_CONTEXT_DOMAIN, context]));
  const env = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-checkpoint',
    schema: { name: 'compact-checkpoint', version: STRICT_SCHEMA_VERSION },
    run_id: runId,
    payload: {
      checkpoint_key: key,
      context,
      context_sha256: contextSha,
    },
    now: new Date(now).toISOString(),
  });
  return { env, key };
}

function validateStrictSelf(env, { runId, key }) {
  if (!exactKeys(env, TOP_KEYS)
    || env.schema_version !== '1.0'
    || !exactKeys(env.envelope, ENVELOPE_KEYS)
    || env.envelope.producer !== 'deep-loop'
    || env.envelope.artifact_kind !== 'compact-checkpoint'
    || !exactKeys(env.envelope.schema, ['name', 'version'])
    || env.envelope.schema.name !== 'compact-checkpoint'
    || env.envelope.schema.version !== STRICT_SCHEMA_VERSION
    || env.envelope.run_id !== runId
    || env.envelope.parent_run_id !== null
    || !canonicalIso(env.envelope.generated_at)
    || !exactKeys(env.envelope.git, [])
    || !exactKeys(env.envelope.provenance, ['source_artifacts', 'tool_versions'])
    || !Array.isArray(env.envelope.provenance.source_artifacts)
    || env.envelope.provenance.source_artifacts.length !== 0
    || !exactKeys(env.envelope.provenance.tool_versions, [])
    || !exactKeys(env.payload, PAYLOAD_KEYS)
    || env.payload.checkpoint_key !== key
    || !exactKeys(env.payload.context, CONTEXT_KEYS)
    || !sha256(env.payload.context_sha256)
    || contentHash(JSON.stringify(env.payload.context)) !== env.payload.context_sha256
    || contentHash(JSON.stringify([STRICT_CONTEXT_DOMAIN, env.payload.context])) !== key
    || !validStoredProviderEvidence(env.payload.context.provider_evidence)) {
    throw new Error('CHECKPOINT_INVALID');
  }
  return env.payload.context;
}

function validateStrictBytes(bytes, { root, runId, key, snapshot, now, hostSessionEvidence }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CHECKPOINT_BYTES) {
    throw new Error('CHECKPOINT_INVALID');
  }
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_INVALID'); }
  const context = validateStrictSelf(env, { runId, key });
  const expected = deriveContext(root, runId, snapshot, {
    now: Date.parse(env.envelope.generated_at),
    providerEvidence: context.provider_evidence,
  });
  if (JSON.stringify(context) !== JSON.stringify(expected)) {
    throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
  }
  const supplied = normalizeProviderEvidence(hostSessionEvidence);
  if (supplied !== null && context.provider_evidence !== null
    && (supplied.provider !== context.provider_evidence.provider
      || supplied.identity_sha256 !== context.provider_evidence.identity_sha256)) {
    throw new Error('CHECKPOINT_EVIDENCE_MISMATCH');
  }
  return {
    env,
    context,
    freshNextAction: nextAction(snapshot.data, { now, unattended: false }),
    evidenceMatched: supplied === null ? null : context.provider_evidence !== null,
  };
}

function readStableRegular(path, invalidCode = 'CHECKPOINT_PATH_INVALID') {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error('CHECKPOINT_NOT_FOUND'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(invalidCode);
  const before = captureStableFileIdentity(path);
  const bytes = readFileSync(path);
  const after = captureStableFileIdentity(path);
  if (!matchingStableFileIdentity(before, after)) throw new Error(invalidCode);
  return { bytes, identity: after };
}

function captureDirectoryEntries(dir) {
  if (dir === null) return [];
  return Object.freeze(readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    let identity = null;
    let regular = false;
    let removable = false;
    try {
      const stat = lstatSync(path);
      identity = captureStableFileIdentity(path);
      regular = stat.isFile() && !stat.isSymbolicLink();
      removable = !stat.isDirectory();
    } catch {
      // Identity drift is treated as ineligible and cannot displace a valid checkpoint.
    }
    return Object.freeze({ name, path, identity, regular, removable });
  }));
}

function readCapturedStable(entry, invalidCode = 'CHECKPOINT_PATH_INVALID') {
  if (!entry.regular || !entry.identity) throw new Error(invalidCode);
  let before;
  try { before = captureStableFileIdentity(entry.path); } catch { throw new Error(invalidCode); }
  if (!matchingStableFileIdentity(entry.identity, before)) throw new Error(invalidCode);
  const bytes = readFileSync(entry.path);
  let after;
  try { after = captureStableFileIdentity(entry.path); } catch { throw new Error(invalidCode); }
  if (!matchingStableFileIdentity(before, after)
    || !matchingStableFileIdentity(entry.identity, after)) {
    throw new Error(invalidCode);
  }
  return bytes;
}

function capturedStrictMetadata(entry, runId) {
  const match = entry.name.match(STRICT_FILE);
  if (!match) throw new Error('CHECKPOINT_INVALID');
  const bytes = readCapturedStable(entry);
  if (bytes.length === 0 || bytes.length > MAX_CHECKPOINT_BYTES) {
    throw new Error('CHECKPOINT_INVALID');
  }
  let env;
  try { env = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('CHECKPOINT_INVALID'); }
  validateStrictSelf(env, { runId, key: match[1] });
  return {
    entry,
    bytes,
    key: match[1],
    rel: checkpointRel(match[1]),
    generatedAt: env.envelope.generated_at,
  };
}

function compareNewest(left, right) {
  const time = compareLexical(right.generatedAt, left.generatedAt);
  return time !== 0 ? time : compareLexical(left.rel, right.rel);
}

function removeCaptured(entry) {
  if (!entry.identity || !entry.removable) return false;
  let currentIdentity;
  try { currentIdentity = captureStableFileIdentity(entry.path); } catch { return false; }
  if (!matchingStableFileIdentity(entry.identity, currentIdentity)) return false;
  rmSync(entry.path, { force: true });
  return true;
}

function pruneCaptured(entries, currentPath, created, runId) {
  let count = entries.filter(entry => entry.removable && entry.name.endsWith('-compact.json')).length
    + (created ? 1 : 0);
  if (count <= KEEP) return;
  const invalid = [];
  const valid = [];
  for (const entry of entries) {
    if (!entry.removable || !entry.name.endsWith('-compact.json')) continue;
    try {
      valid.push(capturedStrictMetadata(entry, runId));
    } catch {
      invalid.push(entry);
    }
  }
  invalid.sort((left, right) => compareLexical(left.name, right.name));
  valid.sort((left, right) => {
    const time = compareLexical(left.generatedAt, right.generatedAt);
    return time !== 0 ? time : compareLexical(right.rel, left.rel);
  });
  const candidates = [
    ...invalid,
    ...valid.map(item => item.entry),
  ];
  for (const entry of candidates) {
    if (count <= KEEP) break;
    if (entry.path === currentPath) continue;
    if (removeCaptured(entry)) count -= 1;
  }
}

function strictEmit(root, runId, snapshot, options) {
  const runtime = assertFence(snapshot.data, options.fence, options.runtime);
  const providerEvidence = normalizeProviderEvidence(options.hostSessionEvidence);
  const context = deriveContext(root, runId, snapshot, {
    now: options.now,
    providerEvidence,
  });
  if (context.runtime !== runtime) throw new Error('RUNTIME_FENCED: context runtime mismatch');
  const { env, key } = strictEnvelope(runId, context, options.now);
  const bytes = Buffer.from(JSON.stringify(env, null, 2));
  if (bytes.length > MAX_CHECKPOINT_BYTES) throw new Error('CHECKPOINT_TOO_LARGE');

  const dir = assertCheckpointDirectory(root, runId, { create: true });
  const entries = captureDirectoryEntries(dir);
  const path = strictPath(root, runId, key);
  const rel = checkpointRel(key);
  const result = {
    ok: true,
    checkpoint_rel: rel,
    checkpoint_key: key,
    workstream_id: context.scope.workstream_id,
    created: true,
  };
  if (existsSync(path)) {
    let existing;
    try { existing = readStableRegular(path).bytes; } catch {
      throw new Error('CHECKPOINT_CONFLICT');
    }
    try {
      validateStrictBytes(existing, {
        root,
        runId,
        key,
        snapshot,
        now: options.now,
        hostSessionEvidence: options.hostSessionEvidence,
      });
    } catch {
      throw new Error('CHECKPOINT_CONFLICT');
    }
    return { ...result, created: false };
  }
  atomicWrite(path, bytes);
  pruneCaptured(entries, path, true, runId);
  return result;
}

function legacyEmit(root, runId, snapshot, now) {
  const { data: loop, hash } = snapshot;
  const lease = loop.session_chain?.lease || {};
  const ep = (loop.episodes || []).find(episode => episode.id === loop.current_episode) || null;
  const na = nextAction(loop, { now, unattended: false });
  const payload = {
    owner_run_id: lease.owner_run_id,
    generation: lease.generation,
    loop_hash: hash,
    current_episode: loop.current_episode,
    current_episode_detail: ep ? {
      id: ep.id,
      role: ep.role,
      status: ep.status,
      point: ep.point,
      workstream_id: ep.workstream_id,
    } : null,
    active_workstreams: loop.active_workstreams || [],
    next_action_hint: { type: na.action.type, next_command: na.next_command },
    artifacts: ep && Array.isArray(ep.expected_artifacts) ? ep.expected_artifacts : [],
  };
  const env = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-checkpoint',
    schema: { name: 'compact-checkpoint', version: '1.0' },
    run_id: runId,
    payload,
    now: new Date(now).toISOString(),
  });
  mkdirSync(checkpointDir(root, runId), { recursive: true });
  const path = join(checkpointDir(root, runId), `${ulid(now)}-compact.json`);
  atomicWrite(path, JSON.stringify(env, null, 2));
  legacyPrune(root, runId, lease.owner_run_id, lease.generation);
  return { ok: true, path };
}

export function emitCompactCheckpoint(root, runId, {
  fence,
  runtime,
  hostSessionEvidence,
  now = Date.now(),
} = {}) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    if (authenticLegacy(snapshot.data)) {
      assertFence(snapshot.data, fence, runtime);
      throw new Error('CHECKPOINT_LEGACY_TRUST_REQUIRED');
    }
    return strictEmit(root, runId, snapshot, {
      fence,
      runtime,
      hostSessionEvidence,
      now,
    });
  });
}

// Compatibility-only adapter for the installed PreCompact hook. Public callers must use
// emitCompactCheckpoint, whose fence/runtime/status checks never downgrade to v1 semantics.
export function emitLegacyCompactCheckpointFromTrustedHook(root, runId, {
  now = Date.now(),
} = {}) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    if (!authenticLegacy(snapshot.data)) {
      throw new Error('CHECKPOINT_LEGACY_POLICY_REQUIRED');
    }
    return legacyEmit(root, runId, snapshot, now);
  });
}

function strictRel(value) {
  if (typeof value !== 'string'
    || value.includes('\0')
    || value.includes('\\')
    || normalizePortableRelativePath(value) !== value) {
    throw new Error('CHECKPOINT_REL_INVALID');
  }
  const match = value.match(/^checkpoints\/([0-9a-f]{64})-compact\.json$/);
  if (!match) throw new Error('CHECKPOINT_REL_INVALID');
  return match[1];
}

function pathBearing(value) {
  return value.includes('/')
    || /[A-Za-z]:[\\/]/.test(value)
    || value.includes('\\\\');
}

function stringSummary(value) {
  return {
    sha256: contentHash(value),
    utf8_bytes: Buffer.byteLength(value),
  };
}

function boundedDescriptorValue(value, depth = 0) {
  if (typeof value === 'string') {
    if (DESCRIPTOR_SLASH_COMMANDS.has(value)
      || (Buffer.byteLength(value) <= 192 && !pathBearing(value))) {
      return value;
    }
    return stringSummary(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    if (value.length > 8 || depth >= 3) return {
      sha256: contentHash(JSON.stringify(value)),
      items: value.length,
    };
    return value.map(item => boundedDescriptorValue(item, depth + 1));
  }
  if (!plainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 16 || depth >= 4) return {
    sha256: contentHash(JSON.stringify(value)),
    keys: entries.length,
  };
  return Object.fromEntries(entries.map(([key, item]) => [
    key,
    boundedDescriptorValue(item, depth + 1),
  ]));
}

function summarizeScope(value) {
  return boundedDescriptorValue({
    kind: value.kind,
    workstream_id: value.workstream_id,
    bound_at_seq: value.bound_at_seq,
    terminal_event: value.terminal_event,
    closed_at: value.closed_at,
    superseded_at: value.superseded_at,
  });
}

function summarizeWorkstream(value) {
  return {
    id: boundedDescriptorValue(value.id),
    status: boundedDescriptorValue(value.status),
    worktree: boundedDescriptorValue(value.worktree),
  };
}

function summarizeEpisode(value) {
  return {
    id: boundedDescriptorValue(value.id),
    role: boundedDescriptorValue(value.role),
    status: boundedDescriptorValue(value.status),
    point: boundedDescriptorValue(value.point),
    workstream_id: boundedDescriptorValue(value.workstream_id),
  };
}

function descriptor(rel, key, validation) {
  const { context, evidenceMatched, freshNextAction } = validation;
  const result = {
    ok: true,
    checkpoint_rel: rel,
    checkpoint_key: key,
    owner_run_id: boundedDescriptorValue(context.owner_run_id),
    generation: context.generation,
    runtime: context.runtime,
    scope: summarizeScope(context.scope),
    workstream: summarizeWorkstream(context.workstream),
    current_episode: summarizeEpisode(context.current_episode),
    next_action: boundedDescriptorValue(freshNextAction),
    context_sha256: contentHash(JSON.stringify(context)),
    provider_evidence: {
      present: context.provider_evidence !== null,
      matched: evidenceMatched,
    },
  };
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > MAX_DESCRIPTOR_BYTES) {
    result.scope = {
      kind: boundedDescriptorValue(context.scope.kind),
      workstream_id: boundedDescriptorValue(context.scope.workstream_id),
      bound_at_seq: context.scope.bound_at_seq,
    };
    result.workstream = {
      id: boundedDescriptorValue(context.workstream.id),
      status: boundedDescriptorValue(context.workstream.status),
    };
    result.current_episode = summarizeEpisode(context.current_episode);
    result.next_action = {
      action: {
        type: boundedDescriptorValue(freshNextAction?.action?.type),
      },
      next_command: boundedDescriptorValue(freshNextAction?.next_command),
    };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_DESCRIPTOR_BYTES) {
    result.scope = {
      kind: boundedDescriptorValue(context.scope.kind),
      sha256: contentHash(JSON.stringify(context.scope)),
    };
    result.workstream = {
      id: boundedDescriptorValue(context.workstream.id),
      status: boundedDescriptorValue(context.workstream.status),
    };
    result.current_episode = {
      id: boundedDescriptorValue(context.current_episode.id),
      point: boundedDescriptorValue(context.current_episode.point),
    };
    result.next_action = {
      action: {
        type: boundedDescriptorValue(freshNextAction?.action?.type),
      },
    };
  }
  return result;
}

export function inspectCompactCheckpoint(root, runId, {
  hostSessionEvidence,
  now = Date.now(),
} = {}) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    assertCurrentSchema(snapshot.data);
    if (snapshot.data.autonomy?.continuation_policy !== 'workstream-session') {
      return { ok: false, reason: 'CHECKPOINT_NOT_FOUND' };
    }
    affinity(snapshot.data);
    const dir = assertCheckpointDirectory(root, runId);
    if (dir === null) return { ok: false, reason: 'CHECKPOINT_NOT_FOUND' };
    const candidates = [];
    const entries = captureDirectoryEntries(dir);
    for (const entry of entries) {
      try {
        const metadata = capturedStrictMetadata(entry, runId);
        const validation = validateStrictBytes(metadata.bytes, {
          root,
          runId,
          key: metadata.key,
          snapshot,
          now,
          hostSessionEvidence,
        });
        candidates.push({ ...metadata, validation });
      } catch {
        // A malformed, stale, foreign, or replaced entry is never eligible.
      }
    }
    candidates.sort(compareNewest);
    if (candidates.length > 0) {
      const selected = candidates[0];
      return descriptor(selected.rel, selected.key, selected.validation);
    }
    return { ok: false, reason: 'CHECKPOINT_NOT_FOUND' };
  });
}

export function restoreCompactCheckpoint(root, runId, {
  checkpointRel: requestedRel,
  fence,
  runtime,
  hostSessionEvidence,
  now = Date.now(),
} = {}) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    assertCurrentSchema(snapshot.data);
    assertFence(snapshot.data, fence, runtime);
    if (snapshot.data.autonomy?.continuation_policy !== 'workstream-session') {
      throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
    }
    const key = strictRel(requestedRel);
    assertCheckpointDirectory(root, runId);
    const path = strictPath(root, runId, key);
    const { bytes } = readStableRegular(path);
    const validation = validateStrictBytes(bytes, {
      root,
      runId,
      key,
      snapshot,
      now,
      hostSessionEvidence,
    });
    return descriptor(requestedRel, key, validation);
  });
}

export function captureCheckpointSet(root, runId) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    const checkpoints = [];
    const dir = checkpointDir(root, runId);
    if (existsSync(dir)) {
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('CHECKPOINT_PATH_INVALID');
      const names = Object.freeze(readdirSync(dir)
        .filter(file => file.endsWith('-compact.json'))
        .sort()
        .reverse());
      for (const name of names) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        checkpoints.push(Object.freeze({ path, bytes: Buffer.from(readFileSync(path)) }));
      }
    }
    return Object.freeze({ snapshot, checkpoints: Object.freeze(checkpoints) });
  });
}

function listLegacyCheckpoints(root, runId) {
  const dir = checkpointDir(root, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(file => file.endsWith('-compact.json'))
    .sort()
    .map(file => join(dir, file));
}

function validLegacy(env, runId) {
  return unwrap(env, { producer: 'deep-loop', artifact_kind: 'compact-checkpoint' }) !== null
    && exactKeys(env, TOP_KEYS)
    && env.schema_version === '1.0'
    && exactKeys(env.envelope, ENVELOPE_KEYS)
    && env.envelope.schema?.version === '1.0'
    && env.envelope.run_id === runId
    && exactKeys(env.payload, LEGACY_PAYLOAD_KEYS);
}

function legacyPrune(root, runId, owner, generation) {
  const all = listLegacyCheckpoints(root, runId);
  if (all.length <= KEEP) return;
  const owned = new Set(all.filter(path => {
    try {
      const env = JSON.parse(readFileSync(path, 'utf8'));
      if (!validLegacy(env, runId)) return false;
      return env.payload.owner_run_id === owner && env.payload.generation === generation;
    } catch {
      return false;
    }
  }));
  const removable = [
    ...all.filter(path => !owned.has(path)),
    ...all.filter(path => owned.has(path)),
  ];
  for (const path of removable) {
    if (listLegacyCheckpoints(root, runId).length <= KEEP) break;
    rmSync(path, { force: true });
  }
}

export function selectCheckpoint(checkpointSet, { owner, generation, loopHash }) {
  if (!checkpointSet || !Array.isArray(checkpointSet.checkpoints)) {
    throw new Error('CHECKPOINT_SNAPSHOT_REQUIRED');
  }
  if (!authenticLegacy(checkpointSet.snapshot?.data)) return null;
  const runId = checkpointSet.snapshot.data.run_id;
  for (const checkpoint of checkpointSet.checkpoints) {
    try {
      const env = JSON.parse(checkpoint.bytes.toString('utf8'));
      if (!validLegacy(env, runId)) continue;
      const payload = env.payload;
      if (typeof payload.owner_run_id !== 'string' || typeof payload.loop_hash !== 'string') continue;
      if (payload.owner_run_id === owner
        && payload.generation === generation
        && payload.loop_hash === loopHash) {
        return checkpoint;
      }
    } catch {
      // Malformed or foreign artifacts are not eligible restore context.
    }
  }
  return null;
}
