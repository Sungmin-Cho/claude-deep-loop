import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { types } from 'node:util';
import { contentHash, ulid } from './envelope.mjs';
import { verifyHeadLines, verifyLines } from './integrity.mjs';
import { validate } from './schema.mjs';
import { assertProjectRootBinding } from './project-root.mjs';
import { validateGenesisConsent } from './app-task-continuation.mjs';
import { exactRawHostObservation, hostSurfaceFactsDigest } from './host-surface.mjs';

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

function querySnapshot(path, deps) {
  const exists = deps.exists ?? existsSync;
  if (!exists(path)) return null;
  const stat = (deps.lstat ?? lstatSync)(path);
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
  const exists = deps.exists ?? existsSync;
  if (!exists(path)) return { stable: 'missing', exists: false, plain: true,
    recoverableStaging: true };
  const directory = (deps.lstat ?? lstatSync)(path);
  const directoryIdentity = [directory.dev, directory.ino, directory.mode,
    directory.size, directory.mtimeMs].join(':');
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    return { stable: JSON.stringify({ directoryIdentity, kind: 'invalid' }),
      exists: true, plain: false, recoverableStaging: false };
  }
  const entries = (deps.readdir ?? readdirSync)(path).sort().map(name => {
    const stat = (deps.lstat ?? lstatSync)(join(path, name));
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
      || GENESIS_TEMP_NAME.test(entry.name))) && (!eventLogPresent || hashPresent);
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
      return { ok: true, outcome: 'prepared', attempt_id: pending.attempt_id,
        previous_current_digest: previous, expected_request_digest: expectedRequest,
        expected_observation_digest: expectedObservation };
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
  return { ok: true, outcome: 'prepared', attempt_id: attempt,
    previous_current_digest: previous, expected_request_digest: expectedRequest,
    expected_observation_digest: expectedObservation };
}
