import { contentHash } from './envelope.mjs';
import { validateGenesisConsent } from './app-task-continuation.mjs';
import { hostSurfaceFactsDigest } from './host-surface.mjs';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function initializationRequestDigest(projection) {
  return contentHash(JSON.stringify(canonicalValue(projection)));
}

function buildRunInitializedEvent(loop) {
  const data = { run_id: loop.run_id,
    request_digest: loop.initialization.request_digest,
    host_surface_digest: loop.initialization.host_surface_digest };
  const seq = 1;
  const ts = loop.created_at;
  const type = 'run-initialized';
  const checksum = contentHash(`${seq}|${ts}|${type}|${JSON.stringify(data)}|GENESIS`);
  return Object.freeze({ seq, ts, type, data: Object.freeze(data), checksum });
}

const KERNEL_GENERATED_KEYS = new Set([
  'created_at', 'updated_at', 'detected_at', 'confirmed_at', 'revoked_at',
  'observed_generation', 'observed_at',
]);
function withoutKernelGenerated(value) {
  if (Array.isArray(value)) return value.map(withoutKernelGenerated);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !KERNEL_GENERATED_KEYS.has(key))
    .map(([key, item]) => [key, withoutKernelGenerated(item)]));
  return value;
}

export function hostObservationDigest(observation) {
  return observation == null ? 'NONE'
    : initializationRequestDigest(withoutKernelGenerated(observation));
}

export function normalizeInitializationRequest(root, options, deps) {
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
  return Object.freeze({ ms, iso: date.toISOString() });
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
    protocol: projection.routing.protocol, recipe: projection.routing.recipe,
    detected: projection.plugins_detected, review: projection.review,
    now: new Date(clock.ms), runId: prepared.attempt_id,
    git: { head: projection.project.git.head, branch: projection.project.git.branch,
      dirty: projection.project.git.dirty }, model: projection.model, effort: projection.effort,
    initialization, hostObservation: storedObservation,
    appContinuationConsent: consent, appContinuationRoute: consentRoute,
    projectRoot: projection.project.root,
    sessionSpawn: { ...projection.session_spawn, detected_at: clock.iso } });
  if (initializationRequestDigest(projectionFromGenesisLoop(loop))
      !== prepared.expected_request_digest) throw new Error('INIT_BUILDER_PROJECTION_MISMATCH');
  if (initializationRequestDigest(loop.initialization.request_projection)
      !== loop.initialization.request_digest) throw new Error('INIT_STORED_PROJECTION_MISMATCH');
  const genesisEvents = [buildRunInitializedEvent(loop)];
  loop.event_log_head = { seq: 1, checksum: genesisEvents[0].checksum };
  return { loop, clock, projection, genesisEvents };
}
