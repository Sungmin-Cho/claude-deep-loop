import { randomUUID } from 'node:crypto';
import {
  closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import { contentHash, ulid } from './envelope.mjs';
import { verifyHeadLines, verifyLines } from './integrity.mjs';
import { validate } from './schema.mjs';
import { assertProjectRootBinding } from './project-root.mjs';
import { validateGenesisConsent } from './app-task-continuation.mjs';
import { exactRawHostObservation, hostSurfaceFactsDigest } from './host-surface.mjs';
import {
  createPreparedFile as createGenesisFile,
  readDurableRegularRecord as readGenesisRecord,
  renamePreparedFile as renameGenesisFile,
  syncParentDirectory as syncGenesisParent,
  unlinkRegularFile as unlinkGenesisFile,
} from './durable-file.mjs';

const NO_EXCLUDED_KEYS = new Set();
const KERNEL_GENERATED_KEYS = new Set([
  'created_at', 'updated_at', 'detected_at', 'confirmed_at', 'revoked_at',
  'observed_generation', 'observed_at',
]);
const INIT_FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const INIT_MAX_DEPTH = 8;
const INIT_MAX_NODES = 256;
const INIT_MAX_ENTRIES = 128;
const INIT_MAX_STRING_BYTES = 4096;
const INIT_MAX_CANONICAL_BYTES = 65_536;
const GENESIS_TEMP_NONCE = /^[A-Za-z0-9_-]{16,128}$/;

function invalidCanonicalValue(reason) {
  throw new Error(`INIT_CANONICAL_VALUE_INVALID: ${reason}`);
}

function canonicalClone(value, depth, { excludedKeys, ancestors, budget }) {
  budget.nodes += 1;
  if (depth > INIT_MAX_DEPTH || budget.nodes > INIT_MAX_NODES) {
    invalidCanonicalValue('tree bounds');
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > INIT_MAX_STRING_BYTES) {
      invalidCanonicalValue('string bytes');
    }
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) invalidCanonicalValue('number');
    return value;
  }
  if (typeof value !== 'object') invalidCanonicalValue(typeof value);
  if (types.isProxy(value)) invalidCanonicalValue('proxy');
  if (ancestors.has(value)) invalidCanonicalValue('cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalidCanonicalValue('non-plain array');
      }
      if (value.length > INIT_MAX_ENTRIES) invalidCanonicalValue('array entries');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some(key => typeof key === 'symbol')) invalidCanonicalValue('symbol key');
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) invalidCanonicalValue('array length');
      const expectedKeys = new Set(['length']);
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const key = String(index);
        expectedKeys.add(key);
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          invalidCanonicalValue('sparse or accessor array');
        }
        result.push(canonicalClone(descriptor.value, depth + 1,
          { excludedKeys, ancestors, budget }));
      }
      if (ownKeys.some(key => typeof key !== 'string' || !expectedKeys.has(key))) {
        invalidCanonicalValue('array property');
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidCanonicalValue('non-plain object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some(key => typeof key === 'symbol')) invalidCanonicalValue('symbol key');
    const includedKeys = ownKeys.filter(key => !excludedKeys.has(key));
    if (includedKeys.length > INIT_MAX_ENTRIES) invalidCanonicalValue('object entries');
    const entries = [];
    for (const key of includedKeys.sort()) {
      if (INIT_FORBIDDEN_KEYS.has(key)
          || Buffer.byteLength(key, 'utf8') > INIT_MAX_STRING_BYTES) {
        invalidCanonicalValue('object key');
      }
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        invalidCanonicalValue('accessor or non-enumerable property');
      }
      entries.push([key, canonicalClone(descriptor.value, depth + 1,
        { excludedKeys, ancestors, budget })]);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalValue(value, { excludedKeys = NO_EXCLUDED_KEYS } = {}) {
  const result = canonicalClone(value, 0,
    { excludedKeys, ancestors: new WeakSet(), budget: { nodes: 0 } });
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > INIT_MAX_CANONICAL_BYTES) {
    invalidCanonicalValue('canonical bytes');
  }
  return result;
}

// JSON.stringify performs inherited `toJSON` lookup even on a freshly cloned ordinary object.
// Serialize the already-canonical data tree from own data descriptors so primordial prototype
// pollution cannot collapse two requests, execute a trap, or split the size and digest bytes.
function canonicalJson(value, { sortKeys = true } = {}) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return `${value}`;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    let encoded = '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) encoded += ',';
      encoded += canonicalJson(descriptors[String(index)].value, { sortKeys });
    }
    return `${encoded}]`;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (sortKeys) keys.sort();
  let encoded = '{';
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) encoded += ',';
    const key = keys[index];
    encoded += `${JSON.stringify(key)}:${canonicalJson(descriptors[key].value, { sortKeys })}`;
  }
  return `${encoded}}`;
}

export function initializationRequestDigest(projection) {
  return contentHash(canonicalJson(canonicalValue(projection)));
}

function buildRunInitializedEvent(loop) {
  const data = { run_id: loop.run_id,
    request_digest: loop.initialization.request_digest,
    host_surface_digest: loop.initialization.host_surface_digest };
  const seq = 1;
  const ts = loop.created_at;
  const type = 'run-initialized';
  const checksum = contentHash(`${seq}|${ts}|${type}|${canonicalJson(data,
    { sortKeys: false })}|GENESIS`);
  return Object.freeze({ seq, ts, type, data: Object.freeze(data), checksum });
}

function withoutKernelGenerated(value) {
  return canonicalValue(value, { excludedKeys: KERNEL_GENERATED_KEYS });
}

export function hostObservationDigest(observation) {
  return observation == null ? 'NONE'
    : initializationRequestDigest(withoutKernelGenerated(observation));
}

export function normalizeInitializationRequest(root, options, deps) {
  if (types.isProxy(options)) invalidCanonicalValue('proxy');
  if (Object.hasOwn(options, 'observation')) throw new Error('INIT_REQUEST_RAW_OBSERVATION');
  const routing = deps.resolveRouting(options);
  const observationDigest = options.observationDigest ?? 'NONE';
  if (!/^(?:NONE|[0-9a-f]{64})$/.test(observationDigest)) {
    throw new Error('INIT_OBSERVATION_DIGEST_INVALID');
  }
  const enumProfile = options.enumProfile == null
    ? null : deps.normalizeEnumProfile(options.enumProfile);
  if (observationDigest !== 'NONE' && enumProfile !== null) {
    throw new Error('INIT_OBSERVATION_PROFILE_CONFLICT');
  }
  const consent = options.consent == null ? null : {
    mode: options.consent.mode, authority: options.consent.authority,
  };
  return canonicalValue({
    runtime: options.runtime, goal: options.goal, routing,
    review: deps.resolveReview(options), model: options.model ?? null, effort: options.effort ?? null,
    project: { root: deps.canonicalRoot(root), git: deps.normalizeGit(options.git ?? {}) },
    plugins_detected: deps.normalizePlugins(options.detected ?? {}),
    session_spawn: withoutKernelGenerated(deps.normalizeSessionSpawn(options.sessionSpawn ?? {})),
    consent, host_observation_digest: observationDigest,
    enum_profile: enumProfile == null ? null : canonicalValue(enumProfile),
  });
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function genesisClockFromAttempt(attemptId) {
  if (!ULID_ID.test(attemptId)) throw new Error('INIT_ATTEMPT_INVALID');
  let ms = 0;
  for (const character of attemptId.slice(0, 10)) {
    ms = ms * 32 + ULID_ALPHABET.indexOf(character);
  }
  const date = new Date(ms);
  if (!Number.isSafeInteger(ms) || !Number.isFinite(date.getTime())) {
    throw new Error('INIT_ATTEMPT_CLOCK_INVALID');
  }
  const iso = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) {
    throw new Error('INIT_ATTEMPT_CLOCK_INVALID');
  }
  return Object.freeze({ ms, iso });
}

// Build-time only: this proves the just-created genesis bytes before publication. Runtime snapshot
// verification hashes initialization.request_projection directly and never calls this helper.
function projectionFromGenesisLoop(loop) {
  const observation = loop.session_chain.sessions[0].host_surface;
  const initialization = loop.initialization;
  return canonicalValue({
    runtime: loop.autonomy.session_runtime, goal: loop.goal,
    routing: { protocol: loop.routing.protocol, recipe: loop.recipe },
    review: loop.review, model: loop.autonomy.session_model ?? null,
    effort: loop.autonomy.session_effort ?? null,
    project: { root: loop.project.root, git: { git: loop.project.git,
      head: loop.project.head, branch: loop.project.branch, dirty: loop.project.dirty } },
    plugins_detected: loop.plugins_detected,
    session_spawn: withoutKernelGenerated(loop.session_spawn),
    consent: { mode: loop.autonomy.app_task_continuation.mode,
      authority: loop.autonomy.app_task_continuation.authority },
    host_observation_digest: initialization.host_observation_digest,
    enum_profile: initialization.host_observation_digest === 'NONE'
      ? observation === null
        ? { kind: null, source: null, capabilities: [] }
        : { kind: observation.kind, source: observation.source,
          capabilities: [...observation.capabilities].sort() }
      : null,
  });
}

export function buildCanonicalGenesis(root, { prepared, request, observation }, deps) {
  const projection = normalizeInitializationRequest(root, request, deps);
  if (initializationRequestDigest(projection) !== prepared.expected_request_digest) {
    throw new Error('INIT_REQUEST_MISMATCH');
  }
  const actualObservationDigest = hostObservationDigest(observation);
  if (projection.host_observation_digest !== prepared.expected_observation_digest
      || actualObservationDigest !== prepared.expected_observation_digest) {
    throw new Error('INIT_OBSERVATION_MISMATCH');
  }
  if (observation !== null) {
    (deps.assertInitializationAuthority ?? (() => {}))(projection.project.root, observation);
  }
  const clock = genesisClockFromAttempt(prepared.attempt_id);
  const enumKernelCwd = observation === null && projection.enum_profile?.kind !== null
    ? deps.kernelCwd?.() : null;
  if (observation === null && projection.enum_profile?.kind !== null
      && (typeof enumKernelCwd !== 'string' || enumKernelCwd.length === 0)) {
    throw new Error('INIT_KERNEL_CWD_INVALID');
  }
  const storedObservation = observation === null
    ? (projection.enum_profile === null || projection.enum_profile.kind === null ? null : {
      ...projection.enum_profile, structured_stdin_mode: null,
      host_task_cwd: null, host_task_cwd_source: null,
      kernel_cwd_at_observation: enumKernelCwd,
      observed_generation: 1, observed_at: clock.iso,
    })
    : { ...withoutKernelGenerated(observation), observed_generation: 1,
      observed_at: clock.iso };
  const consent = projection.consent?.mode === 'auto'
    ? { mode: 'auto', authority: 'human-confirmed', confirmed_at: clock.iso, revoked_at: null }
    : { mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null };
  const consentRoute = storedObservation === null ? null
    : (deps.classifyObservationRoute ?? (() => null))(storedObservation);
  validateGenesisConsent({ runtime: projection.runtime, route: consentRoute,
    observation: storedObservation, consent });
  const initialization = { attempt_id: prepared.attempt_id,
    request_digest: prepared.expected_request_digest,
    request_projection: structuredClone(projection),
    previous_current_digest: prepared.previous_current_digest,
    host_observation_digest: prepared.expected_observation_digest,
    host_surface_digest: hostSurfaceFactsDigest(storedObservation) };
  const loop = deps.buildLoop({ runtime: projection.runtime, goal: projection.goal,
    protocol: projection.routing.protocol, recipe: structuredClone(projection.routing.recipe),
    detected: structuredClone(projection.plugins_detected),
    review: structuredClone(projection.review),
    now: new Date(clock.ms), runId: prepared.attempt_id,
    git: { head: projection.project.git.head, branch: projection.project.git.branch,
      dirty: projection.project.git.dirty }, model: projection.model, effort: projection.effort,
    initialization: structuredClone(initialization),
    hostObservation: structuredClone(storedObservation),
    appContinuationConsent: structuredClone(consent), appContinuationRoute: consentRoute,
    projectRoot: projection.project.root,
    sessionSpawn: { ...structuredClone(projection.session_spawn), detected_at: clock.iso } });
  if (initializationRequestDigest(projectionFromGenesisLoop(loop))
      !== prepared.expected_request_digest) throw new Error('INIT_BUILDER_PROJECTION_MISMATCH');
  if (initializationRequestDigest(loop.initialization.request_projection)
      !== loop.initialization.request_digest) throw new Error('INIT_STORED_PROJECTION_MISMATCH');
  const genesisEvents = [buildRunInitializedEvent(loop)];
  loop.event_log_head = { seq: 1, checksum: genesisEvents[0].checksum };
  return { loop, clock, projection, genesisEvents };
}

const ATTEMPT_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const PENDING_KEYS = ['attempt_id', 'previous_current_digest', 'request_digest', 'version'];

const exactKeys = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().length === keys.length
  && [...keys].sort().every((key, index) => Object.keys(value).sort()[index] === key);

function initPaths(root, attempt = null) {
  const control = join(root, '.deep-loop');
  const run = attempt === null ? null : join(control, 'runs', attempt);
  return { control, current: join(control, 'current'), pending: join(control, 'init-pending.json'),
    lock: join(control, '.init.lock'),
    run, loop: run === null ? null : join(run, 'loop.json'),
    hash: run === null ? null : join(run, '.loop.hash'),
    events: run === null ? null : join(run, 'event-log.jsonl') };
}

function queryLstat(path, deps) {
  try { return (deps.lstat ?? lstatSync)(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('INIT_QUERY_INDETERMINATE', { cause: error });
  }
}

function queryDirectory(path, deps) {
  const stat = queryLstat(path, deps);
  if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error('INIT_QUERY_INDETERMINATE');
  }
  return stat;
}

function querySnapshot(path, deps) {
  queryDirectory(dirname(path), deps);
  const stat = queryLstat(path, deps);
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INIT_QUERY_INDETERMINATE');
  const bytes = Buffer.from((deps.readFile ?? readFileSync)(path));
  return { identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(':'),
    bytes };
}

function sameSnapshot(left, right) {
  return left === null && right === null
    || left !== null && right !== null && left.identity === right.identity
      && left.bytes.equals(right.bytes);
}

function stableSet(paths, deps) {
  const unique = [...new Set(paths)];
  const pass = () => new Map(unique.map(path => [path, querySnapshot(path, deps)]));
  const first = pass();
  const second = pass();
  if (unique.some(path => !sameSnapshot(first.get(path), second.get(path)))) {
    throw new Error('INIT_QUERY_RACED');
  }
  return second;
}

const GENESIS_TEMP_NAME = /^\.tmp-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-[A-Za-z0-9_-]{16,128}$/;

function runDirectorySnapshot(path, deps) {
  queryDirectory(dirname(dirname(path)), deps);
  queryDirectory(dirname(path), deps);
  const directory = queryLstat(path, deps);
  if (directory === null) return { stable: 'missing', exists: false, plain: true,
    recoverableStaging: true };
  const directoryIdentity = [directory.dev, directory.ino, directory.mode,
    directory.size, directory.mtimeMs].join(':');
  if (directory.isSymbolicLink()) throw new Error('INIT_QUERY_INDETERMINATE');
  if (!directory.isDirectory()) {
    return { stable: JSON.stringify({ directoryIdentity, kind: 'invalid' }),
      exists: true, plain: false, recoverableStaging: false };
  }
  const entries = (deps.readdir ?? readdirSync)(path).sort().map(name => {
    const stat = queryLstat(join(path, name), deps);
    if (stat === null) throw new Error('INIT_QUERY_INDETERMINATE');
    const kind = stat.isSymbolicLink() ? 'symlink'
      : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
    return { name, kind,
      identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(':') };
  });
  const loopPresent = entries.some(entry => entry.name === 'loop.json');
  const hashPresent = entries.some(entry => entry.name === '.loop.hash');
  const eventLogPresent = entries.some(entry => entry.name === 'event-log.jsonl');
  const recoverableStaging = !loopPresent && entries.every(entry => entry.kind === 'file'
    && (entry.name === '.loop.hash' || entry.name === 'event-log.jsonl'
      || GENESIS_TEMP_NAME.test(entry.name))) && (!hashPresent || eventLogPresent);
  return { stable: JSON.stringify({ directoryIdentity, entries }), exists: true, plain: true,
    recoverableStaging };
}

function stableAuthoritySet(filePaths, runPaths, deps) {
  const uniqueRuns = [...new Set(runPaths.filter(path => typeof path === 'string'))];
  const before = new Map(uniqueRuns.map(path => [path, runDirectorySnapshot(path, deps)]));
  const unsafeTargets = new Set(uniqueRuns.filter(path => !before.get(path).plain)
    .flatMap(path => [join(path, 'loop.json'), join(path, '.loop.hash'),
      join(path, 'event-log.jsonl')]));
  const files = stableSet(filePaths.filter(path => !unsafeTargets.has(path)), deps);
  const after = new Map(uniqueRuns.map(path => [path, runDirectorySnapshot(path, deps)]));
  if (uniqueRuns.some(path => before.get(path).stable !== after.get(path).stable)) {
    throw new Error('INIT_QUERY_RACED');
  }
  return { files, directories: after };
}

function strictJson(bytes, code) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error(code); }
}

function strictIntegrity(loop, eventBytes) {
  let lines = [];
  if (eventBytes !== null) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(eventBytes); }
    catch { throw new Error('INIT_INTEGRITY_INVALID'); }
    if (text !== '' && !text.endsWith('\n')) throw new Error('INIT_INTEGRITY_INVALID');
    try { lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { throw new Error('INIT_INTEGRITY_INVALID'); }
  }
  const chain = verifyLines(lines);
  const head = verifyHeadLines(lines, loop.event_log_head);
  if (!chain.ok || !head.ok) throw new Error('INIT_INTEGRITY_INVALID');
  if (loop.initialization !== undefined) {
    const genesis = lines.filter(event => event.type === 'run-initialized');
    const event = genesis[0];
    if (genesis.length !== 1 || event !== lines[0] || event.seq !== 1
        || event.ts !== loop.created_at
        || !exactKeys(event.data, ['run_id', 'request_digest', 'host_surface_digest'])
        || event.data.run_id !== loop.run_id
        || event.data.request_digest !== loop.initialization.request_digest
        || event.data.host_surface_digest !== loop.initialization.host_surface_digest) {
      throw new Error('INIT_INTEGRITY_INVALID');
    }
  }
}

function strictPending(bytes) {
  const value = strictJson(bytes, 'INIT_PENDING_CONFLICT');
  if (!exactKeys(value, PENDING_KEYS) || value.version !== 1
      || !ATTEMPT_ID.test(value.attempt_id) || !SHA256.test(value.request_digest)
      || !/^(?:NONE|[0-9a-f]{64})$/.test(value.previous_current_digest)) {
    throw new Error('INIT_PENDING_CONFLICT');
  }
  return value;
}

function currentValue(snapshot, path) {
  const bytes = snapshot.get(path)?.bytes;
  if (bytes === undefined) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('INIT_CURRENT_INVALID'); }
  const value = text.endsWith('\n') ? text.slice(0, -1) : '';
  if (!ATTEMPT_ID.test(value) || text !== value + '\n') throw new Error('INIT_CURRENT_INVALID');
  return value;
}

function targetClassification(root, snapshot, paths, attempt, pending = null, deps = {}, requireInitialization = true) {
  const loopBytes = snapshot.get(paths.loop)?.bytes ?? null;
  const hashBytes = snapshot.get(paths.hash)?.bytes ?? null;
  if (loopBytes === null) return hashBytes === null ? { kind: 'absent' } : { kind: 'hash-only' };
  let storedHash;
  try { storedHash = hashBytes === null ? null
    : new TextDecoder('utf-8', { fatal: true }).decode(hashBytes); }
  catch { return { kind: 'malformed' }; }
  if (storedHash === null || !SHA256.test(storedHash)
      || storedHash !== contentHash(loopBytes.toString('utf8'))) {
    return { kind: 'malformed' };
  }
  let loop;
  try { loop = strictJson(loopBytes, 'INIT_STATE_MALFORMED'); }
  catch { return { kind: 'malformed' }; }
  const stateValid = (deps.validateState ?? validate)(loop).ok === true;
  const init = loop.initialization;
  if (!stateValid || loop.run_id !== attempt
      || (requireInitialization && init?.attempt_id !== attempt)
      || (pending !== null && (init?.attempt_id !== attempt
        || init.request_digest !== pending.request_digest
        || init.previous_current_digest !== pending.previous_current_digest))) {
    return { kind: 'malformed' };
  }
  try { (deps.assertRoot ?? assertProjectRootBinding)(root, loop); }
  catch { return { kind: 'malformed' }; }
  try { strictIntegrity(loop, snapshot.get(paths.events)?.bytes ?? null); }
  catch { return { kind: 'malformed' }; }
  return { kind: 'complete', loop };
}

export function preflightInitialization(root, input, deps) {
  if (!NONCE.test(input?.nonce || '')) {
    throw new Error('INIT_PREFLIGHT_BINDING_INVALID');
  }
  const raw = exactRawHostObservation(input?.observation);
  if (input.readerMode !== raw.structured_stdin_mode) {
    throw new Error('INIT_PREFLIGHT_BINDING_INVALID');
  }
  let observation;
  try {
    observation = deps.normalizeObservation({ ...raw, runtime: input.runtime, observed_at: null });
  } catch (error) {
    if (error?.message === 'HOST_SURFACE_INVALID: cwd identity') {
      return { eligible: false, reason: 'cwd-mismatch', observation_digest: 'NONE' };
    }
    throw error;
  }
  if (input.readerMode !== observation.structured_stdin_mode) {
    throw new Error('INIT_PREFLIGHT_BINDING_INVALID');
  }
  let eligibility;
  try {
    (deps.assertInitializationAuthority ?? (() => {}))(deps.canonicalRoot(root), observation);
    eligibility = deps.eligible(observation);
  } catch (error) {
    if (error?.message !== 'INIT_CWD_MISMATCH') throw error;
    eligibility = { eligible: false, reason: 'cwd-mismatch', route: null };
  }
  const eligible = eligibility?.eligible === true
    && ['create', 'fork'].includes(eligibility?.route?.kind);
  const allowedReason = new Set(['route-ineligible', 'surface-ineligible', 'cwd-mismatch', 'capability-incomplete']);
  return { eligible, reason: eligible ? 'eligible'
    : allowedReason.has(eligibility?.reason) ? eligibility.reason : 'route-ineligible',
    observation_digest: hostObservationDigest(observation) };
}

export function prepareInitialization(root, options, deps) {
  const projection = normalizeInitializationRequest(root, options, deps);
  const expectedRequest = initializationRequestDigest(projection);
  const expectedObservation = projection.host_observation_digest;
  const preparedAuthority = capturePreparedAuthority(root, deps);
  const finishPrepared = result => {
    verifyPreparedAuthority(root, preparedAuthority, deps);
    return preparedAuthority === undefined ? result
      : { ...result, prepared_authority: structuredClone(preparedAuthority) };
  };
  const basePaths = initPaths(root);
  const discovery = stableSet([basePaths.current, basePaths.pending], deps);
  const discoveredCurrent = currentValue(discovery, basePaths.current);
  const discoveredPendingBytes = discovery.get(basePaths.pending)?.bytes ?? null;
  const discoveredPending = discoveredPendingBytes === null ? null : strictPending(discoveredPendingBytes);
  const currentPaths = discoveredCurrent === null ? null : initPaths(root, discoveredCurrent);
  const pendingPaths = discoveredPending === null ? null : initPaths(root, discoveredPending.attempt_id);
  const authorityPaths = [basePaths.current, basePaths.pending,
    ...(currentPaths === null ? [] : [currentPaths.loop, currentPaths.hash, currentPaths.events]),
    ...(pendingPaths === null ? [] : [pendingPaths.loop, pendingPaths.hash, pendingPaths.events])];
  let authority = stableAuthoritySet(authorityPaths,
    [currentPaths?.run, pendingPaths?.run], deps);
  let snapshot = authority.files;
  let current = currentValue(snapshot, basePaths.current);
  const pendingBytes = snapshot.get(basePaths.pending)?.bytes ?? null;
  const pending = pendingBytes === null ? null : strictPending(pendingBytes);
  if (current !== discoveredCurrent
      || pending?.attempt_id !== discoveredPending?.attempt_id
      || (pending === null) !== (discoveredPending === null)) throw new Error('INIT_QUERY_RACED');
  if (currentPaths !== null
      && targetClassification(root, snapshot, currentPaths, current, null, deps, false).kind !== 'complete') {
    throw new Error('INIT_CURRENT_INVALID');
  }
  let previous = current === null ? 'NONE' : contentHash(current);
  let completedPending = null;
  if (pending !== null) {
    const classification = targetClassification(root, snapshot, pendingPaths,
      pending.attempt_id, pending, deps);
    if (classification.kind === 'malformed') throw new Error('INIT_PENDING_CONFLICT');
    const pendingDirectory = authority.directories.get(pendingPaths.run);
    if (classification.kind !== 'complete' && !pendingDirectory?.recoverableStaging) {
      throw new Error('INIT_PENDING_CONFLICT');
    }
    if (classification.kind === 'complete' && current === pending.attempt_id) {
      completedPending = pending;
    } else {
      if (pending.request_digest !== expectedRequest
          || pending.previous_current_digest !== previous) throw new Error('INIT_PENDING_CONFLICT');
      return finishPrepared({ ok: true, outcome: 'prepared', attempt_id: pending.attempt_id,
        previous_current_digest: previous, expected_request_digest: expectedRequest,
        expected_observation_digest: expectedObservation });
    }
  }
  const attempt = (deps.ulid ?? ulid)(deps.nowMs?.());
  if (!ATTEMPT_ID.test(attempt)) throw new Error('INIT_ATTEMPT_INVALID');
  const targetPaths = initPaths(root, attempt);
  authority = stableAuthoritySet([
    ...authorityPaths, targetPaths.loop, targetPaths.hash, targetPaths.events,
  ], [currentPaths?.run, pendingPaths?.run, targetPaths.run], deps);
  snapshot = authority.files;
  current = currentValue(snapshot, basePaths.current);
  if (current !== discoveredCurrent) throw new Error('INIT_QUERY_RACED');
  if (currentPaths !== null
      && targetClassification(root, snapshot, currentPaths, current, null, deps, false).kind !== 'complete') {
    throw new Error('INIT_CURRENT_INVALID');
  }
  const finalPendingBytes = snapshot.get(basePaths.pending)?.bytes ?? null;
  const finalPending = finalPendingBytes === null ? null : strictPending(finalPendingBytes);
  if (completedPending !== null) {
    if (finalPending?.attempt_id !== completedPending.attempt_id
        || finalPending.request_digest !== completedPending.request_digest
        || finalPending.previous_current_digest !== completedPending.previous_current_digest
        || targetClassification(root, snapshot, pendingPaths,
          completedPending.attempt_id, completedPending, deps).kind !== 'complete'
        || current !== completedPending.attempt_id) throw new Error('INIT_QUERY_RACED');
  } else if (finalPending !== null) {
    throw new Error('INIT_QUERY_RACED');
  }
  const targetDirectory = authority.directories.get(targetPaths.run);
  if (targetDirectory?.exists || snapshot.get(targetPaths.loop) !== null
      || snapshot.get(targetPaths.hash) !== null || snapshot.get(targetPaths.events) !== null) {
    throw new Error('INIT_ATTEMPT_COLLISION');
  }
  previous = current === null ? 'NONE' : contentHash(current);
  return finishPrepared({ ok: true, outcome: 'prepared', attempt_id: attempt,
    previous_current_digest: previous, expected_request_digest: expectedRequest,
    expected_observation_digest: expectedObservation });
}

function validPreparedIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === ['dev', 'ino', 'realpath'].join('\0')
    && typeof value.realpath === 'string' && value.realpath.length > 0
    && typeof value.dev === 'string' && typeof value.ino === 'string'
    && /^(?:0|[1-9][0-9]*)$/.test(value.dev)
    && /^(?:0|[1-9][0-9]*)$/.test(value.ino);
}

function validPreparedAuthority(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === ['cwd', 'root', 'version'].join('\0')
    && value.version === 1 && validPreparedIdentity(value.root)
    && (value.cwd === null || validPreparedIdentity(value.cwd));
}

function capturePreparedAuthority(root, deps) {
  if (deps.requirePreparedAuthority !== true) return undefined;
  if (typeof deps.capturePreparedAuthority !== 'function') {
    throw new Error('INIT_PREPARED_AUTHORITY_INVALID');
  }
  const authority = deps.capturePreparedAuthority(root);
  if (!validPreparedAuthority(authority)) {
    throw new Error('INIT_PREPARED_AUTHORITY_INVALID');
  }
  return structuredClone(authority);
}

function verifyPreparedAuthority(root, authority, deps) {
  if (deps.requirePreparedAuthority !== true && authority === undefined) return;
  if (!validPreparedAuthority(authority)
      || typeof deps.verifyPreparedAuthority !== 'function') {
    throw new Error('INIT_PREPARED_AUTHORITY_INVALID');
  }
  try { deps.verifyPreparedAuthority(root, authority); }
  catch (error) {
    if (error?.message === 'INIT_PREPARED_AUTHORITY_MISMATCH') throw error;
    throw new Error('INIT_PREPARED_AUTHORITY_MISMATCH');
  }
}

export const INIT_LOCK_CANDIDATE_TTL_MS = 300_000;
export const INIT_LOCK_CANDIDATE_SWEEP_MAX = 64;
export const INIT_LOCK_CHAIN_MAX = 64;
const INIT_CANDIDATE_NAME = /^\.init-lock-candidate-(?:0|[1-9][0-9]*)-[A-Za-z0-9_-]{16,128}$/;
const INIT_SUCCESSOR_NAME = /^\.init-lock-successor-[A-Za-z0-9_-]{16,128}$/;
const INIT_RELEASE_NAME = /^\.init-lock-release-[A-Za-z0-9_-]{16,128}$/;
const HOLDER_KEYS = ['acquired_at', 'nonce', 'pid'];

function initAuthorityNameKind(name) {
  if (name === '.init.lock') return 'fixed';
  if (INIT_SUCCESSOR_NAME.test(name)) return 'successor';
  if (INIT_RELEASE_NAME.test(name)) return 'release';
  if (name.startsWith('.init.lock') || name.startsWith('.init-lock-successor')
      || name.startsWith('.init-lock-release')) return 'invalid';
  return null;
}

function caseVariantAuthorityName(name) {
  for (const prefix of ['.init.lock', '.init-lock-successor', '.init-lock-release']) {
    if (name.length >= prefix.length && name.slice(0, prefix.length).toLowerCase() === prefix
        && !name.startsWith(prefix)) return prefix + name.slice(prefix.length);
  }
  return null;
}

function classifiedInitAuthorityNames(control, deps) {
  const names = (deps.readdir ?? readdirSync)(control);
  const listed = new Set(names);
  const lstat = deps.lstat ?? (value => lstatSync(value, { bigint: true }));
  const sameFile = deps.sameFile
    ?? ((left, right) => left.dev === right.dev && left.ino === right.ino);
  return names.map(name => {
    let kind = initAuthorityNameKind(name);
    const canonical = kind === null ? caseVariantAuthorityName(name) : null;
    if (canonical !== null && !listed.has(canonical)) {
      try {
        if (sameFile(lstat(join(control, name)), lstat(join(control, canonical)))) kind = 'invalid';
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return { name, kind };
  });
}

function parseInitHolder(bytes) {
  let holder;
  try { holder = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return null; }
  if (!exactKeys(holder, HOLDER_KEYS) || !Number.isSafeInteger(holder.pid) || holder.pid < 1
      || !/^[A-Za-z0-9_-]{16,128}$/.test(holder.nonce)) return null;
  try {
    if (new Date(holder.acquired_at).toISOString() !== holder.acquired_at) return null;
  } catch { return null; }
  return holder;
}

function initFileRecord(path, deps, lstat) {
  let stat;
  try { stat = lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { stat, bytes: null, regular: false };
  return { stat, bytes: Buffer.from((deps.readFile ?? readFileSync)(path)), regular: true };
}

function sameInitFile(left, right, sameFile) {
  return left !== null && right !== null && left.regular && right.regular
    && left.bytes.equals(right.bytes) && sameFile(left.stat, right.stat);
}

function sweepInitCandidates(control, deps, nowMs) {
  const lstat = deps.lstat ?? (value => lstatSync(value, { bigint: true }));
  const sameFile = deps.sameFile
    ?? ((left, right) => left.dev === right.dev && left.ino === right.ino);
  const names = (deps.readdir ?? readdirSync)(control)
    .filter(name => INIT_CANDIDATE_NAME.test(name)).sort()
    .slice(0, INIT_LOCK_CANDIDATE_SWEEP_MAX);
  for (const name of names) {
    const path = join(control, name);
    try {
      const observed = initFileRecord(path, deps, lstat);
      if (observed === null || !observed.regular) continue;
      const holder = parseInitHolder(observed.bytes);
      if (holder === null) continue;
      const acquiredMs = Date.parse(holder.acquired_at);
      if (nowMs - acquiredMs <= INIT_LOCK_CANDIDATE_TTL_MS) continue;
      if (deps.probePidIdentity?.({ pid: holder.pid, acquiredAt: holder.acquired_at })
          !== 'definitely-dead') continue;
      const revalidated = initFileRecord(path, deps, lstat);
      if (!sameInitFile(observed, revalidated, sameFile)) continue;
      (deps.unlink ?? unlinkSync)(path);
    } catch {
      // Candidate uncertainty preserves the path.
    }
  }
}

function ensureControlDirectory(root, deps) {
  const platform = deps.platform ?? process.platform;
  const realpath = deps.realpath ?? (realpathSync.native || realpathSync);
  const lstat = deps.lstat ?? lstatSync;
  const statPath = deps.stat ?? statSync;
  const sameFile = deps.sameFile ?? ((left, right) => left.dev === right.dev && left.ino === right.ino);
  const mkdir = deps.mkdir ?? mkdirSync;
  const canonicalRoot = realpath(root);
  if (platform === 'win32'
    ? !sameFile(statPath(root), statPath(canonicalRoot))
    : canonicalRoot !== root) {
    throw new Error('INIT_ROOT_NOT_CANONICAL');
  }
  const control = join(canonicalRoot, '.deep-loop');
  try { mkdir(control); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = lstat(control);
  const controlReal = realpath(control);
  const exactControl = platform === 'win32'
    ? sameFile(statPath(control), statPath(controlReal)) : controlReal === control;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !exactControl) {
    throw new Error('INIT_ROOT_CONTAINMENT_INVALID');
  }
  syncGenesisParent(control, deps);
  return control;
}

function authorityRecord(path, deps, lstat) {
  let stat;
  try { stat = lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { stat, holder: null };
  let holder = null;
  try { holder = parseInitHolder(Buffer.from((deps.readFile ?? readFileSync)(path))); }
  catch { /* invalid authority remains busy */ }
  return { stat, holder };
}

function initAuthorityNamespace(control, deps) {
  const names = new Set();
  for (const { name, kind } of classifiedInitAuthorityNames(control, deps)) {
    if (kind === 'invalid') throw new Error('LOCK_CHAIN_INVALID');
    if (kind !== null) names.add(name);
  }
  return names;
}

function requireCompleteAuthorityNamespace(namespace, consumed) {
  if (namespace.size !== consumed.size
      || [...namespace].some(name => !consumed.has(name))) {
    throw new Error('LOCK_CHAIN_INVALID');
  }
}

function requireStableAuthorityNamespace(control, deps, before) {
  const after = initAuthorityNamespace(control, deps);
  if (before.size !== after.size || [...before].some(name => !after.has(name))) {
    throw new Error('LOCK_CHAIN_INVALID');
  }
  return after;
}

function requireBracketedCompleteAuthorityNamespace(control, deps, before, consumed) {
  const after = requireStableAuthorityNamespace(control, deps, before);
  requireCompleteAuthorityNamespace(before, consumed);
  requireCompleteAuthorityNamespace(after, consumed);
}

function followInitAuthority(control, deps) {
  const lstat = deps.lstat ?? (value => lstatSync(value, { bigint: true }));
  const sameFile = deps.sameFile
    ?? ((left, right) => left.dev === right.dev && left.ino === right.ino);
  const namespace = initAuthorityNamespace(control, deps);
  let authorityPath = join(control, '.init.lock');
  const visited = new Set();
  const consumed = new Set();
  for (let depth = 0; depth < INIT_LOCK_CHAIN_MAX; depth += 1) {
    const authority = authorityRecord(authorityPath, deps, lstat);
    if (authority === null) {
      if (depth === 0) {
        requireBracketedCompleteAuthorityNamespace(control, deps, namespace, consumed);
        return { state: 'free', publishPath: authorityPath, visited };
      }
      throw new Error('LOCK_CHAIN_INVALID');
    }
    consumed.add(authorityPath === join(control, '.init.lock')
      ? '.init.lock' : authorityPath.slice(control.length + 1));
    if (authority.holder === null || visited.has(authority.holder.nonce)) {
      requireBracketedCompleteAuthorityNamespace(control, deps, namespace, consumed);
      return { state: 'held', authorityPath, authority, invalid: true, visited };
    }
    visited.add(authority.holder.nonce);
    const releaseName = '.init-lock-release-' + authority.holder.nonce;
    const releasePath = join(control, releaseName);
    const release = authorityRecord(releasePath, deps, lstat);
    if (release === null) {
      requireBracketedCompleteAuthorityNamespace(control, deps, namespace, consumed);
      return { state: 'held', authorityPath, authority, releasePath,
        invalid: false, visited };
    }
    consumed.add(releaseName);
    if (release.holder === null || release.holder.nonce !== authority.holder.nonce
        || !sameFile(authority.stat, release.stat)) {
      requireBracketedCompleteAuthorityNamespace(control, deps, namespace, consumed);
      return { state: 'held', authorityPath, authority, releasePath,
        invalid: true, visited };
    }
    const successorName = '.init-lock-successor-' + authority.holder.nonce;
    const successorPath = join(control, successorName);
    const successor = authorityRecord(successorPath, deps, lstat);
    if (depth === INIT_LOCK_CHAIN_MAX - 1) {
      if (successor === null) {
        requireBracketedCompleteAuthorityNamespace(control, deps, namespace, consumed);
      } else {
        requireStableAuthorityNamespace(control, deps, namespace);
      }
      throw new Error('LOCK_CHAIN_EXHAUSTED');
    }
    if (successor === null) {
      requireBracketedCompleteAuthorityNamespace(control, deps, namespace, consumed);
      return { state: 'free', publishPath: successorPath,
        predecessorPath: authorityPath, predecessor: authority, visited };
    }
    authorityPath = successorPath;
  }
  throw new Error('LOCK_CHAIN_EXHAUSTED');
}

function throwHeldAuthority(terminal, deps) {
  const holder = terminal.authority?.holder;
  const liveness = holder === null || holder === undefined || terminal.invalid
    ? 'unknown'
    : deps.probePidIdentity?.({ pid: holder.pid, acquiredAt: holder.acquired_at }) ?? 'unknown';
  if (['definitely-dead', 'pid-reused'].includes(liveness)) {
    throw new Error('LOCK_STALE_MANUAL');
  }
  throw new Error('LOCK_BUSY');
}

export function withInitLock(root, fn, deps = {}) {
  const control = ensureControlDirectory(root, deps);
  const nowMs = (deps.now ?? Date.now)();
  const pid = deps.pid ?? process.pid;
  const nonce = (deps.nonce ?? (() => randomUUID().replace(/-/g, '')))();
  if (!Number.isSafeInteger(pid) || pid < 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
    throw new Error('LOCK_OWNER_INVALID');
  }
  const initial = followInitAuthority(control, deps);
  if (initial.state !== 'free') throwHeldAuthority(initial, deps);
  if (initial.visited.has(nonce)) throw new Error('LOCK_OWNER_REUSED');
  // A cap already visible at entry is raised above before sweep or candidate publication.
  sweepInitCandidates(control, deps, nowMs);
  const holder = { pid, nonce, acquired_at: new Date(nowMs).toISOString() };
  const holderBytes = Buffer.from(JSON.stringify(holder));
  const candidate = join(control, '.init-lock-candidate-' + pid + '-' + nonce);
  const releasePath = join(control, '.init-lock-release-' + nonce);
  const unlink = deps.unlink ?? unlinkSync;
  const link = deps.link ?? linkSync;
  const lstat = deps.lstat ?? (value => lstatSync(value, { bigint: true }));
  const sameFile = deps.sameFile
    ?? ((left, right) => left.dev === right.dev && left.ino === right.ino);
  let candidateOwned = null;
  let linked = false;
  let releaseAuthorized = false;
  let authorizedAuthorityPath = null;
  let releaseError = null;
  try {
    let candidateDescriptor = null;
    let createdIdentity = null;
    let writeError = null;
    let closeError = null;
    try {
      candidateDescriptor = (deps.lockOpen ?? openSync)(candidate, 'wx');
      const descriptorStat = (deps.lockFstat
        ?? (value => fstatSync(value, { bigint: true })))(candidateDescriptor);
      if (!descriptorStat.isFile()) throw new Error('LOCK_CANDIDATE_INDETERMINATE');
      createdIdentity = descriptorStat;
      if (deps.lockWriteFile !== undefined) {
        deps.lockWriteFile(candidate, holderBytes, { flag: 'r+' });
      } else {
        (deps.lockWriteDescriptor ?? writeFileSync)(candidateDescriptor, holderBytes);
      }
    } catch (error) {
      writeError = error;
    } finally {
      if (candidateDescriptor !== null) {
        try { (deps.lockClose ?? closeSync)(candidateDescriptor); }
        catch (error) { closeError = error; }
      }
    }
    if (createdIdentity !== null && closeError === null) {
      try {
        const afterDescriptor = initFileRecord(candidate, deps, lstat);
        if (afterDescriptor?.regular && sameFile(createdIdentity, afterDescriptor.stat)) {
          candidateOwned = afterDescriptor;
        }
      } catch { /* descriptor/path uncertainty preserves the pathname */ }
    }
    if (closeError !== null) {
      throw new Error('LOCK_CANDIDATE_INDETERMINATE', { cause: closeError });
    }
    if (writeError !== null) throw writeError;
    if (candidateOwned === null || !candidateOwned.bytes.equals(holderBytes)) {
      throw new Error('LOCK_CANDIDATE_INDETERMINATE');
    }
    const terminal = followInitAuthority(control, deps);
    if (terminal.state !== 'free') throwHeldAuthority(terminal, deps);
    if (terminal.visited.has(nonce)) throw new Error('LOCK_OWNER_REUSED');
    const beforePublish = initFileRecord(candidate, deps, lstat);
    if (!sameInitFile(candidateOwned, beforePublish, sameFile)) {
      throw new Error('LOCK_ACQUIRE_RACED');
    }
    try {
      link(candidate, terminal.publishPath);
      linked = true;
    } catch (error) {
      if (error?.code === 'EEXIST') throwHeldAuthority(followInitAuthority(control, deps), deps);
      if (['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error?.code)) {
        throw new Error('LOCK_UNSUPPORTED');
      }
      throw new Error('LOCK_ACQUIRE_FAILED');
    }
    const published = followInitAuthority(control, deps);
    const afterPublish = initFileRecord(candidate, deps, lstat);
    if (published.state !== 'held' || published.authorityPath !== terminal.publishPath
        || published.invalid || published.authority.holder.pid !== holder.pid
        || published.authority.holder.nonce !== holder.nonce
        || published.authority.holder.acquired_at !== holder.acquired_at
        || !sameInitFile(candidateOwned, afterPublish, sameFile)
        || !sameFile(candidateOwned.stat, published.authority.stat)) {
      throw new Error('LOCK_ACQUIRE_RACED');
    }
    authorizedAuthorityPath = published.authorityPath;
    releaseAuthorized = true;
    return fn();
  } finally {
    if (linked && releaseAuthorized) {
      try {
        const held = followInitAuthority(control, deps);
        const beforeRelease = initFileRecord(candidate, deps, lstat);
        if (held.state !== 'held' || held.authorityPath !== authorizedAuthorityPath
            || held.invalid || held.authority.holder.pid !== holder.pid
            || held.authority.holder.nonce !== holder.nonce
            || held.authority.holder.acquired_at !== holder.acquired_at
            || !sameFile(candidateOwned.stat, held.authority.stat)
            || !sameInitFile(candidateOwned, beforeRelease, sameFile)) {
          releaseError = new Error('LOCK_RELEASE_INDETERMINATE');
        } else {
          try { link(candidate, releasePath); }
          catch (error) {
            if (error?.code !== 'EEXIST') {
              releaseError = new Error('LOCK_RELEASE_INDETERMINATE');
            }
          }
          const release = initFileRecord(releasePath, deps, lstat);
          if (!sameInitFile(candidateOwned, release, sameFile)) {
            releaseError = new Error('LOCK_RELEASE_INDETERMINATE');
          }
        }
      } catch { releaseError = new Error('LOCK_RELEASE_INDETERMINATE'); }
    }
    if (candidateOwned !== null) {
      try {
        const beforeUnlink = initFileRecord(candidate, deps, lstat);
        if (sameInitFile(candidateOwned, beforeUnlink, sameFile)) unlink(candidate);
      } catch { /* candidate uncertainty or absence preserves the path */ }
    }
    if (releaseError !== null) throw releaseError;
  }
}

function readOptionalRegular(path, deps) {
  try {
    const stat = (deps.lstat ?? lstatSync)(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('INIT_ROOT_CONTAINMENT_INVALID');
    }
    return Buffer.from((deps.readFile ?? readFileSync)(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function parseCurrent(bytes) {
  if (bytes === null) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('INIT_CURRENT_INVALID'); }
  const value = text.endsWith('\n') ? text.slice(0, -1) : '';
  if (!ATTEMPT_ID.test(value) || text !== value + '\n') {
    throw new Error('INIT_CURRENT_INVALID');
  }
  return value;
}

function exactPendingAt(path, expected, deps) {
  const record = readGenesisRecord(path, {
    optional: true,
    invalidCode: 'INIT_ROOT_CONTAINMENT_INVALID',
    changedCode: 'INIT_PENDING_CONFLICT',
  }, deps);
  if (record === null) return null;
  const value = strictPending(record.bytes);
  if (expected !== null && (value.attempt_id !== expected.attempt_id
      || value.request_digest !== expected.request_digest
      || value.previous_current_digest !== expected.previous_current_digest)) {
    throw new Error('INIT_PENDING_CONFLICT');
  }
  return { value, record };
}

function assertPlainDirectory(path, deps, { create = false } = {}) {
  const mkdir = deps.mkdir ?? mkdirSync;
  if (create) {
    try { mkdir(path); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  let lexical;
  try { lexical = (deps.lstat ?? lstatSync)(path); }
  catch { throw new Error('INIT_ROOT_CONTAINMENT_INVALID'); }
  if (!lexical.isDirectory() || lexical.isSymbolicLink()) {
    throw new Error('INIT_ROOT_CONTAINMENT_INVALID');
  }
  const resolved = (deps.realpath ?? (realpathSync.native || realpathSync))(path);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const sameFile = deps.sameFile
      ?? ((left, right) => left.dev === right.dev && left.ino === right.ino);
    if (!sameFile((deps.stat ?? statSync)(path), (deps.stat ?? statSync)(resolved))) {
      throw new Error('INIT_ROOT_CONTAINMENT_INVALID');
    }
  } else if (resolved !== path) {
    throw new Error('INIT_ROOT_CONTAINMENT_INVALID');
  }
  if (create) syncGenesisParent(path, deps);
  return resolved;
}

function genesisRunDirectory(root, attempt, deps, { create = false } = {}) {
  if (!ATTEMPT_ID.test(attempt)) throw new Error('INIT_ATTEMPT_INVALID');
  const canonicalRoot = assertPlainDirectory(root, deps);
  const control = join(canonicalRoot, '.deep-loop');
  assertPlainDirectory(control, deps);
  const runs = join(control, 'runs');
  assertPlainDirectory(runs, deps, { create });
  const run = join(runs, attempt);
  assertPlainDirectory(run, deps, { create });
  return run;
}

function strictGenesisProof(root, binding, expectedRaw, deps,
  { checkObservation = true } = {}) {
  const paths = initPaths(root, binding.attempt_id);
  const run = genesisRunDirectory(root, binding.attempt_id, deps);
  if (run !== dirname(paths.loop)) throw new Error('INIT_ROOT_CONTAINMENT_INVALID');
  const loopBytes = readOptionalRegular(paths.loop, deps);
  const hashBytes = readOptionalRegular(paths.hash, deps);
  if (loopBytes === null || hashBytes === null) throw new Error('INIT_STATE_CORRUPT');
  const raw = loopBytes.toString('utf8');
  if (!SHA256.test(hashBytes.toString('utf8'))
      || hashBytes.toString('utf8') !== contentHash(raw)
      || expectedRaw !== null && raw !== expectedRaw) {
    throw new Error('INIT_STATE_CORRUPT');
  }
  const loop = strictJson(loopBytes, 'INIT_STATE_CORRUPT');
  const init = loop.initialization;
  if (!(deps.validateState ?? validate)(loop).ok || loop.run_id !== binding.attempt_id
      || init?.attempt_id !== binding.attempt_id
      || init.request_digest !== binding.request_digest
      || init.previous_current_digest !== binding.previous_current_digest
      || checkObservation && init.host_observation_digest !== binding.observation_digest) {
    throw new Error('INIT_STATE_CORRUPT');
  }
  try { (deps.assertRoot ?? assertProjectRootBinding)(root, loop); }
  catch { throw new Error('INIT_STATE_ROOT_INVALID'); }
  try { strictIntegrity(loop, readOptionalRegular(paths.events, deps)); }
  catch { throw new Error('INIT_STATE_CORRUPT'); }
  return loop;
}

function completedPendingMarker(root, pending, current, deps) {
  if (current !== pending.attempt_id) return false;
  try {
    strictGenesisProof(root, { ...pending, observation_digest: 'NONE' }, null, deps,
      { checkObservation: false });
    return true;
  } catch { return false; }
}

function strictExistingCurrent(root, current, deps) {
  if (current === null) return;
  const paths = initPaths(root, current);
  const snapshot = new Map([paths.loop, paths.hash, paths.events].map(path => {
    const bytes = readOptionalRegular(path, deps);
    return [path, bytes === null ? null : { bytes }];
  }));
  if (targetClassification(root, snapshot, paths, current, null, deps, false).kind
      !== 'complete') {
    throw new Error('INIT_CURRENT_INVALID');
  }
}

function removeOwnTemp(path, deps, expectedRecord = null) {
  unlinkGenesisFile(path, deps, expectedRecord);
}

function strictTempPaths(directory, deps) {
  const paths = [];
  for (const name of (deps.readdir ?? readdirSync)(directory).sort()
    .filter(value => value.startsWith('.tmp-'))) {
    const path = join(directory, name);
    const stat = (deps.lstat ?? lstatSync)(path);
    if (!GENESIS_TEMP_NAME.test(name) || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('INIT_STATE_CORRUPT');
    }
    paths.push(path);
  }
  return paths;
}

const GENESIS_TEST_CRASH_POINT = /^(?:[a-z0-9-]+-(?:before-write|after-write|before-rename)|pending-delete-(?:before|after))$/;

function crashGenesisIfScheduled(point) {
  const selected = process.env.NODE_ENV === 'test'
    ? process.env.DEEP_LOOP_TEST_CRASH_AT : undefined;
  if (selected === undefined || selected !== point) return;
  if (!GENESIS_TEST_CRASH_POINT.test(selected)) {
    throw new Error('GENESIS_TEST_CRASH_POINT_INVALID');
  }
  process.exit(91);
}

function writeGenesisArtifact(path, attempt, slot, bytes, deps) {
  const nonce = (deps.tempNonce ?? (() => randomUUID().replace(/-/g, '')))();
  const pid = deps.pid ?? process.pid;
  const nowMs = (deps.now ?? Date.now)();
  if (!ATTEMPT_ID.test(attempt) || !GENESIS_TEMP_NONCE.test(nonce)
      || !Number.isSafeInteger(pid) || pid < 1
      || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('INIT_TEMP_IDENTITY_INVALID');
  }
  const name = `.tmp-${pid}-${nowMs}-${nonce}`;
  const temporary = join(dirname(path), name);
  let tempRecord = null;
  try {
    tempRecord = createGenesisFile(temporary, bytes, {
      beforeWritePoint: `${slot}-before-write`,
      afterWritePoint: `${slot}-after-write`,
    }, deps);
    crashGenesisIfScheduled(`${slot}-before-rename`);
    renameGenesisFile(temporary, path, {
      sourceAlreadySynced: true,
      sourceRecord: tempRecord,
      renamedPoint: `${slot}-after-rename`,
    }, deps);
  } finally {
    if (tempRecord !== null) removeOwnTemp(temporary, deps, tempRecord);
  }
}

function deletePending(path, deps, expectedRecord) {
  crashGenesisIfScheduled('pending-delete-before');
  if (!unlinkGenesisFile(path, deps, expectedRecord)) throw new Error('INIT_PENDING_CONFLICT');
  crashGenesisIfScheduled('pending-delete-after');
}

export function publishGenesisState(root, runId, canonical, deps = {}) {
  const { loop, genesisEvents } = canonical;
  const paths = initPaths(root, runId);
  const init = loop.initialization;
  const expectedPending = { version: 1, attempt_id: runId,
    request_digest: init?.request_digest,
    previous_current_digest: init?.previous_current_digest };
  if (exactPendingAt(paths.pending, expectedPending, deps) === null) {
    throw new Error('INIT_PENDING_CONFLICT');
  }
  if (loop.run_id !== runId || !(deps.validateState ?? validate)(loop).ok) {
    throw new Error('INIT_STATE_INVALID');
  }
  try { (deps.assertRoot ?? assertProjectRootBinding)(root, loop); }
  catch { throw new Error('INIT_STATE_ROOT_INVALID'); }
  const run = genesisRunDirectory(root, runId, deps, { create: true });
  if (!Array.isArray(genesisEvents) || genesisEvents.length !== 1
      || genesisEvents[0]?.type !== 'run-initialized'
      || genesisEvents[0]?.ts !== loop.created_at
      || genesisEvents[0]?.data?.run_id !== runId
      || genesisEvents[0]?.data?.request_digest !== init.request_digest
      || genesisEvents[0]?.data?.host_surface_digest !== init.host_surface_digest
      || !(deps.verifyLines ?? verifyLines)(genesisEvents).ok
      || !(deps.verifyHeadLines ?? verifyHeadLines)(genesisEvents, loop.event_log_head).ok) {
    throw new Error('INIT_GENESIS_EVENT_INVALID');
  }
  const eventRaw = genesisEvents.map(event => JSON.stringify(event)).join('\n') + '\n';
  const raw = JSON.stringify(loop, null, 2) + '\n';
  const digest = contentHash(raw);
  const entries = (deps.readdir ?? readdirSync)(run).sort();
  for (const name of entries) {
    const path = join(run, name);
    const stat = (deps.lstat ?? lstatSync)(path);
    if (stat.isSymbolicLink() || !stat.isFile()
        || !['.loop.hash', 'loop.json', 'event-log.jsonl'].includes(name)
          && !GENESIS_TEMP_NAME.test(name)) {
      throw new Error('INIT_STATE_CORRUPT');
    }
  }
  const loopBytes = readOptionalRegular(paths.loop, deps);
  const hashBytes = readOptionalRegular(paths.hash, deps);
  const eventBytes = readOptionalRegular(paths.events, deps);
  if (loopBytes !== null) {
    strictGenesisProof(root, { attempt_id: runId, request_digest: init.request_digest,
      previous_current_digest: init.previous_current_digest,
      observation_digest: init.host_observation_digest }, raw, deps);
    for (const name of entries.filter(name => GENESIS_TEMP_NAME.test(name))) {
      removeOwnTemp(join(run, name), deps);
    }
    return { outcome: 'already-published', raw };
  }
  if (hashBytes !== null && hashBytes.toString('utf8') !== digest) {
    throw new Error('INIT_STATE_CORRUPT');
  }
  if (eventBytes !== null && !eventBytes.equals(Buffer.from(eventRaw))) {
    throw new Error('INIT_STATE_CORRUPT');
  }
  for (const name of entries.filter(name => GENESIS_TEMP_NAME.test(name))) {
    removeOwnTemp(join(run, name), deps);
  }
  if (eventBytes === null) writeGenesisArtifact(paths.events, runId, 'events', eventRaw, deps);
  if (hashBytes === null) writeGenesisArtifact(paths.hash, runId, 'hash', digest, deps);
  writeGenesisArtifact(paths.loop, runId, 'loop', raw, deps);
  return { outcome: hashBytes === null ? 'published' : 'recovered-hash', raw };
}

export function commitPreparedInit(root, input, deps = {}) {
  const prepared = input?.prepared;
  if (prepared?.ok !== true || prepared.outcome !== 'prepared'
      || !ATTEMPT_ID.test(prepared.attempt_id)
      || !SHA256.test(prepared.expected_request_digest)
      || !/^(?:NONE|[0-9a-f]{64})$/.test(prepared.previous_current_digest)
      || !/^(?:NONE|[0-9a-f]{64})$/.test(prepared.expected_observation_digest)) {
    throw new Error('INIT_COMMIT_BINDING_INVALID');
  }
  verifyPreparedAuthority(root, prepared.prepared_authority, deps);
  const canonical = buildCanonicalGenesis(root, {
    prepared, request: input.request, observation: input.observation ?? null,
  }, deps);
  const canonicalRaw = JSON.stringify(canonical.loop, null, 2) + '\n';
  const binding = { attempt_id: prepared.attempt_id,
    request_digest: prepared.expected_request_digest,
    previous_current_digest: prepared.previous_current_digest,
    observation_digest: prepared.expected_observation_digest };
  return withInitLock(root, () => {
    verifyPreparedAuthority(root, prepared.prepared_authority, deps);
    const paths = initPaths(root, prepared.attempt_id);
    let current = parseCurrent(readOptionalRegular(paths.current, deps));
    let pending = exactPendingAt(paths.pending, null, deps);
    if (current === prepared.attempt_id) {
      strictGenesisProof(root, binding, null, deps);
      if (pending?.value.attempt_id === prepared.attempt_id) {
        const validatedPending = exactPendingAt(paths.pending,
          { version: 1, attempt_id: binding.attempt_id,
          request_digest: binding.request_digest,
          previous_current_digest: binding.previous_current_digest }, deps);
        deletePending(paths.pending, deps, validatedPending.record);
        return { ok: true, outcome: 'recovered-pending', run_id: prepared.attempt_id };
      }
      return { ok: true, outcome: 'already-initialized', run_id: prepared.attempt_id };
    }
    strictExistingCurrent(root, current, deps);
    let completedForeign = false;
    if (pending !== null && pending.value.attempt_id !== prepared.attempt_id) {
      if (!completedPendingMarker(root, pending.value, current, deps)
          || prepared.previous_current_digest !== contentHash(current)) {
        throw new Error('INIT_PENDING_CONFLICT');
      }
      const validatedPending = exactPendingAt(paths.pending, pending.value, deps);
      deletePending(paths.pending, deps, validatedPending.record);
      if (exactPendingAt(paths.pending, null, deps) !== null) {
        throw new Error('INIT_PENDING_CONFLICT');
      }
      pending = null;
      completedForeign = true;
    }
    const actualPrevious = current === null ? 'NONE' : contentHash(current);
    if (actualPrevious !== prepared.previous_current_digest) {
      throw new Error('INIT_CURRENT_CONFLICT');
    }
    const expectedPending = { version: 1, attempt_id: prepared.attempt_id,
      request_digest: prepared.expected_request_digest,
      previous_current_digest: prepared.previous_current_digest };
    const recovering = pending !== null;
    if (recovering) exactPendingAt(paths.pending, expectedPending, deps);
    const control = assertPlainDirectory(join(assertPlainDirectory(root, deps), '.deep-loop'), deps);
    if (dirname(paths.pending) !== control) throw new Error('INIT_ROOT_CONTAINMENT_INVALID');
    const controlTemps = strictTempPaths(control, deps);
    if (controlTemps.length > 0 && !recovering && !completedForeign) {
      throw new Error('INIT_STATE_CORRUPT');
    }
    for (const temporary of controlTemps) removeOwnTemp(temporary, deps);
    if (queryLstat(dirname(paths.run), deps) !== null) {
      assertPlainDirectory(dirname(paths.run), deps);
    }
    const targetDirectory = runDirectorySnapshot(paths.run, deps);
    if (!targetDirectory.plain
        || !recovering && targetDirectory.exists
        || recovering && readOptionalRegular(paths.loop, deps) === null
          && !targetDirectory.recoverableStaging) {
      throw new Error('INIT_STATE_CORRUPT');
    }
    if (pending === null) {
      writeGenesisArtifact(paths.pending, prepared.attempt_id, 'pending',
        JSON.stringify(expectedPending), deps);
    }
    exactPendingAt(paths.pending, expectedPending, deps);
    publishGenesisState(root, prepared.attempt_id, canonical, deps);
    strictGenesisProof(root, binding, canonicalRaw, deps);
    current = parseCurrent(readOptionalRegular(paths.current, deps));
    const currentDigest = current === null ? 'NONE' : contentHash(current);
    if (currentDigest !== prepared.previous_current_digest
        && current !== prepared.attempt_id) {
      throw new Error('INIT_CURRENT_CONFLICT');
    }
    if (current !== prepared.attempt_id) {
      writeGenesisArtifact(paths.current, prepared.attempt_id, 'current',
        prepared.attempt_id + '\n', deps);
    }
    strictGenesisProof(root, binding, canonicalRaw, deps);
    if (parseCurrent(readOptionalRegular(paths.current, deps)) !== prepared.attempt_id) {
      throw new Error('INIT_CURRENT_CONFLICT');
    }
    const validatedPending = exactPendingAt(paths.pending, expectedPending, deps);
    deletePending(paths.pending, deps, validatedPending.record);
    return { ok: true, outcome: recovering ? 'recovered-pending' : 'initialized',
      run_id: prepared.attempt_id };
  }, deps);
}

const statusResult = (outcome, lock_state, fields = {}) => ({
  ok: true, outcome, request_match: false, previous_current_match: false,
  consent_mode: null, host_surface: null, structured_stdin_mode: null,
  lock_state, ...fields,
});

function lockArtifactSnapshot(control, deps) {
  if (queryDirectory(control, deps) === null) return { stable: 'absent', entries: [] };
  const names = classifiedInitAuthorityNames(control, deps)
    .filter(entry => entry.kind !== null).map(entry => entry.name).sort();
  const entries = names.map(name => {
    const path = join(control, name);
    const stat = queryLstat(path, deps);
    if (stat === null) throw new Error('INIT_QUERY_INDETERMINATE');
    let bytes = null;
    try { bytes = Buffer.from((deps.readFile ?? readFileSync)(path)); } catch {}
    return { name, stat, bytes, regular: stat.isFile() && !stat.isSymbolicLink(),
      identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(':') };
  });
  return { entries, stable: JSON.stringify(entries.map(entry => ({ name: entry.name,
    identity: entry.identity, regular: entry.regular,
    bytes: entry.bytes?.toString('base64') ?? null }))) };
}

function lockStateFromSnapshot(snapshot, deps) {
  const entries = snapshot.entries;
  if (entries.some(entry => !entry.regular || entry.bytes === null
      || entry.name !== '.init.lock' && !INIT_SUCCESSOR_NAME.test(entry.name)
        && !INIT_RELEASE_NAME.test(entry.name))) return 'invalid';
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  let authority = byName.get('.init.lock');
  if (authority === undefined) return entries.length === 0 ? 'free' : 'invalid';
  const visited = new Set();
  const consumed = new Set();
  for (let depth = 0; depth < 64; depth += 1) {
    let holder;
    try { holder = JSON.parse(authority.bytes.toString('utf8')); } catch { return 'invalid'; }
    try {
      if (!exactKeys(holder, ['acquired_at', 'nonce', 'pid'])
          || !Number.isSafeInteger(holder.pid) || holder.pid < 1
          || !/^[A-Za-z0-9_-]{16,128}$/.test(holder.nonce)
          || new Date(holder.acquired_at).toISOString() !== holder.acquired_at
          || visited.has(holder.nonce)) return 'invalid';
    } catch { return 'invalid'; }
    visited.add(holder.nonce);
    consumed.add(authority.name);
    const releaseName = '.init-lock-release-' + holder.nonce;
    const release = byName.get(releaseName);
    if (release === undefined) {
      if (consumed.size !== entries.length) return 'invalid';
      const liveness = deps.probePidIdentity?.({
        pid: holder.pid, acquiredAt: holder.acquired_at,
      }) ?? 'unknown';
      return ['definitely-dead', 'pid-reused'].includes(liveness) ? 'stale-manual'
        : ['alive', 'unknown'].includes(liveness) ? 'busy' : 'invalid';
    }
    consumed.add(releaseName);
    if (authority.stat.dev !== release.stat.dev || authority.stat.ino !== release.stat.ino) {
      return 'invalid';
    }
    const successorName = '.init-lock-successor-' + holder.nonce;
    const successor = byName.get(successorName);
    if (depth === 63) return 'invalid';
    if (successor === undefined) return consumed.size === entries.length ? 'free' : 'invalid';
    authority = successor;
  }
  return 'invalid';
}

function controlTempSnapshot(path, deps) {
  const directory = queryDirectory(path, deps);
  if (directory === null) return { stable: '', staging: 'none' };
  const directoryIdentity = [directory.dev, directory.ino, directory.mode,
    directory.size, directory.mtimeMs].join(':');
  const entries = (deps.readdir ?? readdirSync)(path).filter(name => name.startsWith('.tmp-'))
    .sort().map(name => {
      const stat = queryLstat(join(path, name), deps);
      if (stat === null) throw new Error('INIT_QUERY_INDETERMINATE');
      const kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other';
      return { name, kind, identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs].join(':') };
    });
  const invalid = entries.some(entry => entry.kind !== 'file' || !GENESIS_TEMP_NAME.test(entry.name));
  return { stable: JSON.stringify({ directoryIdentity, entries }),
    staging: invalid ? 'invalid' : entries.length === 0 ? 'none' : 'strict' };
}

function stableStatusSet(paths, deps) {
  const beforeControl = controlTempSnapshot(paths.control, deps);
  const beforeLock = lockArtifactSnapshot(paths.control, deps);
  const authority = stableAuthoritySet(
    [paths.current, paths.pending, paths.loop, paths.hash, paths.events],
    [paths.run], deps);
  const afterLock = lockArtifactSnapshot(paths.control, deps);
  const afterControl = controlTempSnapshot(paths.control, deps);
  if (beforeControl.stable !== afterControl.stable
      || beforeLock.stable !== afterLock.stable) {
    throw new Error('INIT_QUERY_RACED');
  }
  const lockState = lockStateFromSnapshot(afterLock, deps);
  return { files: authority.files, directory: authority.directories.get(paths.run),
    controlStaging: afterControl.staging, lockState };
}

export function statusInitialization(root, binding, deps) {
  let lockState = 'invalid';
  try {
    if (!ATTEMPT_ID.test(binding?.attempt_id || '')
        || !/^(?:NONE|[0-9a-f]{64})$/.test(binding?.expected_current_digest || '')
        || !SHA256.test(binding?.expected_request_digest || '')) {
      return statusResult('indeterminate', 'invalid');
    }
    const paths = initPaths(root, binding.attempt_id);
    const { files: snapshot, directory, controlStaging,
      lockState: stableLock } = stableStatusSet(paths, deps);
    lockState = stableLock;
    const current = currentValue(snapshot, paths.current);
    const actualCurrentDigest = current === null ? 'NONE' : contentHash(current);
    const target = targetClassification(root, snapshot, paths, binding.attempt_id, null, deps);
    const loop = target.kind === 'complete' ? target.loop : null;
    const requestMatch = loop?.initialization?.request_digest === binding.expected_request_digest;
    const previousMatch = loop?.initialization?.previous_current_digest === binding.expected_current_digest;
    const safeFields = loop === null ? {} : {
      consent_mode: loop.autonomy?.app_task_continuation?.mode ?? null,
      host_surface: loop.session_chain?.sessions?.[0]?.host_surface?.kind ?? null,
      structured_stdin_mode: loop.session_chain?.sessions?.[0]?.host_surface?.structured_stdin_mode ?? null,
    };
    if (target.kind === 'complete' && current === binding.attempt_id) {
      return requestMatch && previousMatch
        ? statusResult('committed', lockState, {
          request_match: true, previous_current_match: true, ...safeFields,
        }) : statusResult('conflict', lockState, {
          request_match: requestMatch, previous_current_match: previousMatch,
        });
    }
    if (controlStaging === 'invalid') return statusResult('indeterminate', lockState);
    const pendingBytes = snapshot.get(paths.pending)?.bytes ?? null;
    if (pendingBytes !== null) {
      let pending;
      try { pending = strictPending(pendingBytes); }
      catch { return statusResult('conflict', lockState); }
      const exact = pending.attempt_id === binding.attempt_id;
      if (!exact) return statusResult('conflict', lockState);
      const pendingRequest = pending.request_digest === binding.expected_request_digest;
      const pendingPrevious = pending.previous_current_digest === binding.expected_current_digest
        && actualCurrentDigest === binding.expected_current_digest;
      if (!pendingRequest || !pendingPrevious) {
        return statusResult('conflict', lockState, {
          request_match: pendingRequest, previous_current_match: pendingPrevious,
        });
      }
      if (target.kind === 'malformed'
          || target.kind !== 'complete' && !directory.recoverableStaging) {
        return statusResult('indeterminate', lockState, {
          request_match: true, previous_current_match: true,
        });
      }
      if (target.kind === 'complete') {
        return requestMatch && previousMatch
          ? statusResult('state-only', lockState, {
            request_match: true, previous_current_match: true, ...safeFields,
          }) : statusResult('conflict', lockState, {
            request_match: requestMatch, previous_current_match: previousMatch,
          });
      }
      if (['absent', 'hash-only'].includes(target.kind)) {
        return statusResult('pending', lockState, {
          request_match: true, previous_current_match: true,
        });
      }
      return statusResult('indeterminate', lockState, {
        request_match: true, previous_current_match: true,
      });
    }
    if (target.kind === 'malformed' || target.kind === 'hash-only'
        || target.kind === 'absent' && directory.exists
        || controlStaging !== 'none') {
      return statusResult('indeterminate', lockState);
    }
    if (target.kind === 'complete') {
      const currentPreserved = actualCurrentDigest === binding.expected_current_digest;
      return statusResult('indeterminate', lockState, {
        request_match: requestMatch,
        previous_current_match: previousMatch && currentPreserved,
      });
    }
    const previousMatchAbsent = actualCurrentDigest === binding.expected_current_digest;
    return previousMatchAbsent
      ? statusResult('absent', lockState, {
        request_match: true, previous_current_match: true,
      }) : statusResult('conflict', lockState, {
        request_match: true, previous_current_match: false,
      });
  } catch (error) {
    return statusResult(String(error?.message).includes('INIT_QUERY_RACED')
      ? 'raced' : 'indeterminate', lockState);
  }
}
