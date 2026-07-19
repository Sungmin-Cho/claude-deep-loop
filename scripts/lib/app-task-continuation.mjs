import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { contentHash } from './envelope.mjs';
import { appendAnchored, intentField, readLines, readVerifiedState, verifyHeadLines,
  authenticateVerifiedMutationCaller, readAuthenticatedMutationSnapshot, verifyLines,
  withVerifiedMutationLock }
  from './integrity.mjs';
import { reconcileBudget } from './budget.mjs';
import { leaseCheck } from './lease.mjs';
import { respawnGate } from './respawn.mjs';
import { runtimeFence } from './runtime.mjs';
import { APP_CONFIRMATION_TIMEOUT_MS, validate, verifyAppEventCorrelation } from './schema.mjs';
import { classifyProjectTaskDirectory, exactRawHostObservation, normalizeHostObservation,
  appHostTaskCwdDigest, hostSurfaceFactsDigest, sameNativeDirectory,
  selectAppContinuationRoute, validateOpaqueId } from './host-surface.mjs';

export function appNativePathDeps(statFn = statSync) {
  return { platform: process.platform, exists: existsSync, realpath: realpathSync.native,
    stat: value => statFn(value, { bigint: true }),
    sameFile: (left, right) => left?.dev === right?.dev && left?.ino === right?.ino };
}

const hasEvery = (values, required) => required.every(value => values.includes(value));

export function deriveAppEmitAuthority(loop, root, parentOwner, actualCwd,
  deps = appNativePathDeps()) {
  const consent = loop.autonomy?.app_task_continuation;
  const lease = loop.session_chain?.lease;
  const parent = loop.session_chain?.sessions?.find(session => session.run_id === parentOwner);
  const host = parent?.host_surface;
  if (loop.autonomy?.session_runtime !== 'codex' || consent?.mode !== 'auto'
      || consent?.authority !== 'human-confirmed' || consent?.revoked_at != null
      || lease?.owner_run_id !== parentOwner
      || host?.kind !== 'codex-app'
      || !Number.isSafeInteger(host?.observed_generation)
      || host.observed_generation < 1
      || host.observed_generation !== lease?.generation
      || !['codex-app-host-context', 'codex-app-tool-provenance'].includes(host?.source)
      || host?.host_task_cwd_source !== 'app-task-context'
      || !['pipe-open-noecho', 'pty-raw-noecho'].includes(host?.structured_stdin_mode)
      || !sameNativeDirectory(host.host_task_cwd, actualCwd, deps)
      || !sameNativeDirectory(host.kernel_cwd_at_observation, actualCwd, deps)) {
    throw new Error('APP_EMIT_AUTHORITY_FENCED');
  }
  const canonicalRoot = deps.realpath(root);
  const targetCwd = deps.realpath(actualCwd);
  let route;
  if (sameNativeDirectory(canonicalRoot, targetCwd, deps)) {
    if (!hasEvery(host.capabilities, ['list-projects', 'create-thread-local',
      'structured-process-stdin'])) throw new Error('APP_EMIT_AUTHORITY_FENCED');
    route = { kind: 'create', targetCwd: canonicalRoot, projectId: null,
      workstreamId: null, contextMode: 'fresh' };
  } else {
    route = selectAppContinuationRoute({ root: canonicalRoot,
      recordedHostTaskCwd: host.host_task_cwd, currentHostTaskCwd: targetCwd,
      kernelCwd: targetCwd, capabilities: host.capabilities, projects: [],
      workstreams: loop.workstreams ?? [], activeWorkstreams: loop.active_workstreams ?? [] }, deps);
    if (route.kind !== 'fork' || route.projectId !== null) {
      throw new Error('APP_EMIT_AUTHORITY_FENCED');
    }
  }
  return Object.freeze({ route: route.kind, contextMode: route.contextMode,
    targetCwd: route.targetCwd, workstreamId: route.workstreamId,
    stdinMode: host.structured_stdin_mode,
    hostTaskCwdDigest: appHostTaskCwdDigest(host, route.targetCwd) });
}

function assertAppCommandIdentity(loop, input, code) {
  const runtime = runtimeFence(loop, input.runtime);
  const lease = loop?.session_chain?.lease;
  if (!runtime.ok || lease?.owner_run_id !== input.owner
      || lease?.generation !== input.generation) throw new Error(code);
}

function appMutationIntentDigest(input, operation) {
  const base = { operation, owner: input.owner, generation: input.generation,
    attempt_id: input.attemptId ?? null };
  const projection = operation === 'host-observe'
    ? { ...base, runtime: input.runtime ?? null, reader_mode: input.readerMode ?? null,
      observation_digest: intentField('host-observe-raw', input.observation) }
    : operation === 'app-prepare'
      ? { ...base, stdin_mode: input.stdinMode,
        route_digest: intentField('prepare-route', input.route),
        host_input_digest: input.hostInputDigest
          ?? intentField('prepare-host-input', input.hostInput),
        descriptor_digest: input.descriptorDigest ?? null }
    : operation === 'app-confirm'
      ? { ...base, receipt_digest: intentField('confirmed-thread', input.threadId),
        stdin_mode: input.stdinMode ?? null }
    : operation === 'app-fail'
      ? { ...base, failure_code: input.code,
        reason_digest: intentField('failure-reason', input.reason),
        unconfirmed_receipt_digest: intentField('unconfirmed-thread', input.unconfirmedThreadId),
        stdin_mode: input.stdinMode ?? null }
    : operation === 'app-sweep'
      ? { ...base, deadline_digest: intentField('sweep-deadline', input.deadline) }
    : operation === 'app-await'
      ? { ...base, timeout_ms: input.timeoutMs, interval_ms: input.intervalMs,
        deadline_digest: intentField('await-deadline', input.deadline) }
    : operation === 'app-acquire'
      ? { ...base, child_run_id: input.childRunId,
        observation_digest: input.observationDigest
          ?? intentField('acquire-observation', input.observation),
        stdin_mode: input.stdinMode ?? null, runtime: input.runtime ?? null }
    : operation === 'app-revoke'
      ? { ...base, runtime: input.runtime ?? null }
      : null;
  if (projection === null) {
    throw new Error(`MUTATION_INTENT_OPERATION_UNSUPPORTED: ${operation}`);
  }
  return contentHash(JSON.stringify(projection));
}

function withAppMutation(root, runId, input, operation, body, options = {}) {
  const callerBinding = { owner: input.owner, generation: input.generation };
  const intentDigest = appMutationIntentDigest(input, operation);
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: `LEASE_FENCED: ${operation}`,
    intentConflictError: options.intentConflictError
      ?? (['app-confirm', 'app-fail'].includes(operation)
        ? 'APP_RECEIPT_FENCED' : `APP_TASK_FENCED:${operation}`) }, body);
}

export { APP_PREPARE_TIMEOUT_MS, APP_CONFIRMATION_TIMEOUT_MS } from './schema.mjs';

export const DEFAULT_APP_TASK_CONTINUATION = Object.freeze({
  mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
});

const CONSENT_KEYS = ['authority', 'confirmed_at', 'mode', 'revoked_at'];
const snapshotConsent = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== CONSENT_KEYS.length
      || !keys.every(key => typeof key === 'string' && CONSENT_KEYS.includes(key))) return null;
  const snapshot = {};
  for (const key of CONSENT_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
};
const strictInstant = value => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};

export function validateGenesisConsent({ runtime, route, observation, consent }) {
  const value = snapshotConsent(consent ?? { mode: 'manual', authority: 'default-manual',
    confirmed_at: null, revoked_at: null });
  if (value === null) throw new Error('APP_CONSENT_INVALID');
  const manual = value.mode === 'manual' && value.authority === 'default-manual'
    && value.confirmed_at === null && value.revoked_at === null;
  if (manual) return value;
  const capabilities = new Set(observation?.capabilities ?? []);
  const completeCreate = ['list-projects', 'create-thread-local', 'structured-process-stdin']
    .every(capability => capabilities.has(capability));
  const completeFork = ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin']
    .every(capability => capabilities.has(capability));
  const auto = value.mode === 'auto' && value.authority === 'human-confirmed'
    && strictInstant(value.confirmed_at) && value.revoked_at === null;
  const observationKeys = ['capabilities', 'host_task_cwd', 'host_task_cwd_source',
    'kernel_cwd_at_observation', 'kind', 'observed_at', 'observed_generation',
    'source', 'structured_stdin_mode'];
  const strictObservation = observation && typeof observation === 'object'
    && !Array.isArray(observation)
    && Object.keys(observation).sort().length === observationKeys.length
    && observationKeys.every((key, index) => Object.keys(observation).sort()[index] === key);
  const sortedCapabilities = Array.isArray(observation?.capabilities)
    && JSON.stringify(observation.capabilities)
      === JSON.stringify([...observation.capabilities].sort())
    && new Set(observation.capabilities).size === observation.capabilities.length;
  if (!auto || runtime !== 'codex' || observation?.kind !== 'codex-app'
      || !strictObservation || !sortedCapabilities
      || !['codex-app-host-context', 'codex-app-tool-provenance'].includes(observation?.source)
      || observation.host_task_cwd_source !== 'app-task-context'
      || observation.host_task_cwd !== observation.kernel_cwd_at_observation
      || observation.observed_generation !== 1
      || !strictInstant(observation.observed_at)
      || !['pipe-open-noecho', 'pty-raw-noecho'].includes(observation.structured_stdin_mode)
      || !capabilities.has('structured-process-stdin')
      || (route === 'create' ? !completeCreate : route === 'fork' ? !completeFork : true)) {
    throw new Error('APP_CONSENT_INVALID');
  }
  return value;
}

const sameObservation = (left, right) => hostSurfaceFactsDigest(left)
  === hostSurfaceFactsDigest(right);

function assertObservedTaskDirectory(root, loop, observation, deps) {
  if (observation.kind === null) return;
  if (observation.host_task_cwd !== null
      && !sameNativeDirectory(observation.host_task_cwd, deps.kernelCwd, deps)) {
    throw new Error('HOST_SURFACE_FENCED');
  }
  const location = classifyProjectTaskDirectory(root, deps.kernelCwd, deps);
  if (location?.kind === 'root') return;
  if (location?.kind !== 'worktree') throw new Error('HOST_SURFACE_FENCED');
  const active = new Set(loop.active_workstreams ?? []);
  const matches = (loop.workstreams ?? []).filter(workstream => active.has(workstream.id)
    && ['in_progress', 'in_review'].includes(workstream.status)
    && typeof workstream.worktree === 'string'
    && sameNativeDirectory(resolve(root, workstream.worktree), location.cwd, deps));
  if (matches.length !== 1) throw new Error('HOST_SURFACE_FENCED');
}

export function observeHostSurface(root, runId, input, deps) {
  let materialized = null;
  const eventData = { run_id: runId, owner_run_id: input.owner, kind: null,
    observed_generation: null, observation_digest: null, outcome: null };
  const callerBinding = { owner: input.owner, generation: input.generation };
  const intentDigest = appMutationIntentDigest(input, 'host-observe');
  try {
    const recovered = appendAnchored(root, runId,
      { type: 'host-surface-observed', data: eventData },
      loop => {
        const session = loop.session_chain.sessions.find(item => item.run_id === input.owner);
        session.host_surface = materialized;
      },
      (loop, clock) => {
        const fence = leaseCheck(loop, { owner: input.owner, generation: input.generation,
          runtime: input.runtime, intent: 'business' });
        if (!fence.ok) {
          if (fence.reason === 'RUN_TERMINAL') throw new Error('HOST_SURFACE_TERMINAL');
          throw new Error('HOST_SURFACE_FENCED');
        }
        const source = input.readerMode === null ? input.observation
          : exactRawHostObservation(input.observation);
        let normalized;
        try {
          normalized = normalizeHostObservation({ ...source,
            runtime: input.runtime, observed_at: clock.iso }, deps);
        } catch {
          throw new Error('HOST_SURFACE_FENCED');
        }
        if (input.readerMode !== normalized.structured_stdin_mode) {
          throw new Error('HOST_SURFACE_FENCED');
        }
        assertObservedTaskDirectory(root, loop, normalized, deps);
        const session = loop.session_chain.sessions.find(item => item.run_id === input.owner);
        if (!session) throw new Error('HOST_SURFACE_FENCED');
        const existing = Object.hasOwn(session, 'host_surface') ? session.host_surface : null;
        if (existing !== null) {
          if (!sameObservation(existing, normalized)) throw new Error('HOST_SURFACE_FENCED');
          if (!Number.isSafeInteger(existing.observed_generation)
              || existing.observed_generation > input.generation) {
            throw new Error('HOST_SURFACE_FENCED');
          }
          if (existing.observed_generation === input.generation) {
            throw new Error('HOST_SURFACE_ALREADY');
          }
          materialized = { ...existing, observed_generation: input.generation,
            observed_at: clock.iso };
          eventData.kind = existing.kind;
          eventData.observed_generation = input.generation;
          eventData.observation_digest = hostSurfaceFactsDigest(materialized);
          eventData.outcome = 'reattested';
          return;
        }
        if (normalized.kind === null) throw new Error('HOST_SURFACE_UNOBSERVED');
        eventData.kind = normalized.kind;
        eventData.observed_generation = input.generation;
        eventData.outcome = 'observed';
        materialized = { ...normalized, observed_generation: input.generation };
        eventData.observation_digest = hostSurfaceFactsDigest(materialized);
      }, { nowFn: deps.nowFn ?? Date.now,
        fenceCheck: loop => assertAppCommandIdentity(loop, input, 'HOST_SURFACE_FENCED'),
        callerBinding, intentDigest, fenceError: 'HOST_SURFACE_FENCED',
        crashProbe: deps.crashProbe,
        onRecovered: () => ({ ok: true, outcome: 'already-observed' }) });
    if (recovered !== undefined) return recovered;
    return { ok: true, outcome: eventData.outcome };
  } catch (error) {
    if (error.message === 'HOST_SURFACE_ALREADY') return { ok: true, outcome: 'already-observed' };
    if (error.message === 'HOST_SURFACE_UNOBSERVED') return { ok: true, outcome: 'unobserved' };
    throw error;
  }
}

export function revokeAppTaskContinuation(root, runId, input, deps = {}) {
  const eventData = { owner_run_id: input.owner, generation: input.generation,
    attempt_id: null, child_run_id: null, failure_code: null };
  const callerBinding = { owner: input.owner, generation: input.generation };
  const intentDigest = appMutationIntentDigest(input, 'app-revoke');
  try {
    const recovered = appendAnchored(root, runId,
      { type: 'app-task-consent-revoked', data: eventData },
      (loop, _spent, clock) => {
        const consent = loop.autonomy.app_task_continuation;
        consent.mode = 'manual'; consent.revoked_at = clock.iso;
        const lease = loop.session_chain.lease;
        const exactBareReservation = lease.state === 'active'
          && lease.handoff_phase === 'reserved'
          && typeof lease.handoff_idempotency_key === 'string'
          && typeof lease.handoff_child_run_id === 'string'
          && lease.handoff_transport === null
          && lease.handoff_attempt_id === null
          && !loop.session_chain.sessions.some(session =>
            session.run_id === lease.handoff_child_run_id);
        if (exactBareReservation) {
          Object.assign(lease, { state: 'active', handoff_phase: 'idle',
            handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null });
        }
        const live = loop.session_chain.sessions.find(session =>
          session.run_id === lease.handoff_child_run_id
          && session.continuation?.attempt_id === lease.handoff_attempt_id
          && session.continuation.transport === 'codex-app'
          && ['emitted', 'prepared', 'confirmed'].includes(session.continuation.phase));
        if (live) {
          live.continuation.phase = 'abandoned';
          live.continuation.failure_code = 'consent-revoked';
          loop.session_chain.lease.resume_policy = 'human';
          loop.session_chain.lease.expires_at = null;
          loop.status = 'paused'; loop.pause_reason = 'app-task-human-preserve';
        }
      },
      (loop, clock) => {
        const fence = leaseCheck(loop, { owner: input.owner, generation: input.generation,
          runtime: input.runtime, intent: 'app-revoke' });
        if (!fence.ok) {
          if (fence.reason === 'RUN_TERMINAL') throw new Error('APP_TASK_TERMINAL');
          throw new Error('APP_TASK_FENCED');
        }
        const snapshot = validate(loop);
        if (!snapshot.ok) {
          throw new Error(`RUN_SNAPSHOT_INVALID: ${snapshot.errors.join('; ')}`);
        }
        const lines = readLines(root, runId);
        const chain = verifyLines(lines);
        const head = verifyHeadLines(lines, loop.event_log_head);
        const correlation = verifyAppEventCorrelation(loop, lines);
        const proofErrors = [...chain.errors, ...head.errors, ...correlation.errors];
        if (proofErrors.length !== 0) {
          throw new Error(`RUN_SNAPSHOT_INVALID: ${proofErrors.join('; ')}`);
        }
        const consent = loop.autonomy.app_task_continuation
          ?? { mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null };
        if (consent.mode === 'manual' && consent.authority === 'human-confirmed'
            && consent.revoked_at !== null) throw new Error('APP_TASK_ALREADY_REVOKED');
        if (consent.mode === 'manual') throw new Error('APP_TASK_NOT_AUTO');
        if (consent.mode !== 'auto' || consent.authority !== 'human-confirmed'
            || consent.revoked_at !== null || !strictInstant(consent.confirmed_at)
            || !clock || clock.ms < Date.parse(consent.confirmed_at)) {
          throw new Error('APP_TASK_CONSENT_INVALID');
        }
        const lease = loop.session_chain.lease;
        const livePhases = loop.session_chain.sessions.filter(session =>
          ['emitted', 'prepared', 'confirmed'].includes(session.continuation?.phase));
        const exactBound = loop.session_chain.sessions.filter(session =>
          session.run_id === lease.handoff_child_run_id
          && session.continuation?.attempt_id === lease.handoff_attempt_id
          && session.continuation?.transport === 'codex-app');
        const appBound = lease.handoff_transport === 'codex-app';
        if (!appBound && (lease.handoff_attempt_id !== null || livePhases.length !== 0)) {
          throw new Error('APP_TASK_TRANSITION_INVALID');
        }
        if (appBound && exactBound.length !== 1) throw new Error('APP_TASK_TRANSITION_INVALID');
        if (livePhases.length > 0
            && (livePhases.length !== 1 || exactBound[0] !== livePhases[0])) {
          throw new Error('APP_TASK_TRANSITION_INVALID');
        }
        if (appBound) {
          const bound = exactBound[0];
          const primary = ['emitted', 'prepared', 'confirmed'].includes(bound.continuation.phase);
          Object.assign(eventData, { attempt_id: bound.continuation.attempt_id,
            child_run_id: bound.run_id, failure_code: primary ? 'consent-revoked' : null });
          const preserved = ['failed', 'abandoned'].includes(bound.continuation.phase);
          const expectedPhase = bound.continuation.prepared_at === null ? 'emitted' : 'spawned';
          const parent = loop.session_chain.sessions.find(
            session => session.run_id === lease.owner_run_id);
          const runningPrimary = primary && loop.status === 'running' && loop.pause_reason == null
            && lease.resume_policy === 'app' && strictInstant(lease.expires_at);
          const emittedManualPreserve = bound.continuation.phase === 'emitted'
            && loop.status === 'paused' && loop.pause_reason === 'app-launch-unconfirmed'
            && lease.resume_policy === 'human' && lease.expires_at === null
            && bound.continuation.prepared_at === null
            && bound.continuation.failure_code === null;
          const confirmedAwaitPreserve = bound.continuation.phase === 'confirmed'
            && loop.status === 'paused' && loop.pause_reason === 'app-child-timeout-awaiting'
            && lease.resume_policy === 'human' && lease.expires_at === null
            && strictInstant(bound.continuation.prepared_at)
            && strictInstant(bound.continuation.confirmed_at)
            && bound.continuation.failure_code === null;
          const settledPreserve = preserved && loop.status === 'paused'
            && lease.resume_policy === 'human' && lease.expires_at === null
            && loop.pause_reason === bound.continuation.failure_code;
          if ((!runningPrimary && !emittedManualPreserve && !confirmedAwaitPreserve
                && !settledPreserve)
              || lease.state !== 'releasing' || lease.handoff_phase !== expectedPhase
              || !parent || parent.superseded_by !== bound.run_id) {
            throw new Error('APP_TASK_TRANSITION_INVALID');
          }
        }
      }, { nowFn: deps.nowFn ?? Date.now,
        fenceCheck: loop => assertAppCommandIdentity(loop, input, 'APP_TASK_FENCED'),
        callerBinding, intentDigest, fenceError: 'APP_TASK_FENCED',
        onRecovered: () => ({ ok: true, outcome: 'already-revoked' }) });
    if (recovered !== undefined) return recovered;
    return { ok: true, outcome: 'revoked' };
  } catch (error) {
    if (error.message === 'APP_TASK_ALREADY_REVOKED') {
      return { ok: true, outcome: 'already-revoked' };
    }
    if (error.message === 'APP_TASK_NOT_AUTO') return { ok: true, outcome: 'not-auto' };
    throw error;
  }
}

const APP_SECRET_KEYS = new Set(['thread_id', 'unconfirmed_thread_id', 'project_id']);

export function redactAppSecrets(value, keyPath = []) {
  const path = Array.isArray(keyPath) ? keyPath : [keyPath];
  const project = (current, currentPath, ancestors) => {
    if (currentPath.some(key => APP_SECRET_KEYS.has(key))) {
      return current == null ? null : '[REDACTED_OPAQUE_ID]';
    }
    if (current === null || typeof current !== 'object') return current;
    if (utilTypes.isProxy(current)) throw new Error('APP_REDACTION_INVALID: proxy');
    if (ancestors.has(current)) throw new Error('APP_REDACTION_INVALID: cycle');
    ancestors.add(current);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new Error('APP_REDACTION_INVALID: non-plain array');
        }
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new Error('APP_REDACTION_INVALID: array length');
        }
        return Array.from({ length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new Error('APP_REDACTION_INVALID: sparse or accessor array');
          }
          return project(descriptor.value, currentPath, ancestors);
        });
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('APP_REDACTION_INVALID: non-plain object');
      }
      const entries = [];
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') continue;
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) continue;
        const childPath = [...currentPath, key];
        if (!Object.hasOwn(descriptor, 'value')) {
          if (APP_SECRET_KEYS.has(key)) {
            entries.push([key, '[REDACTED_OPAQUE_ID]']);
            continue;
          }
          throw new Error('APP_REDACTION_INVALID: accessor object');
        }
        entries.push([key, project(descriptor.value, childPath, ancestors)]);
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(current);
    }
  };
  return project(value, path, new WeakSet());
}

function findAppAttempt(loop, attemptId) {
  const session = (loop.session_chain?.sessions ?? []).find(item =>
    item?.continuation?.transport === 'codex-app' && item.continuation.attempt_id === attemptId);
  if (!session) throw new Error('APP_ATTEMPT_FENCED');
  return { session, continuation: session.continuation };
}

function assertAppParentIdentity(loop, input) {
  const lease = loop.session_chain?.lease;
  if (lease?.owner_run_id !== input.owner || lease?.generation !== input.generation) {
    throw new Error('LEASE_FENCED: app-task');
  }
  if (loop.autonomy?.session_runtime !== 'codex') throw new Error('RUNTIME_FENCED: app-task');
}

function assertAppParentFence(loop, input, phases) {
  assertAppParentIdentity(loop, input);
  const lease = loop.session_chain?.lease;
  if (loop.status === 'completed' || loop.status === 'stopped') throw new Error('RUN_TERMINAL: app-task');
  const consent = loop.autonomy?.app_task_continuation;
  if (consent?.mode !== 'auto' || consent?.authority !== 'human-confirmed' || consent?.revoked_at != null) {
    throw new Error('APP_CONSENT_FENCED');
  }
  const attemptId = input.attemptId ?? lease.handoff_attempt_id;
  const found = findAppAttempt(loop, attemptId);
  if (!phases.includes(found.continuation.phase)
      || lease.handoff_transport !== 'codex-app'
      || lease.handoff_attempt_id !== attemptId
      || lease.handoff_child_run_id !== found.session.run_id) throw new Error('APP_ATTEMPT_FENCED');
  return { ...found, attemptId };
}

function assertAppParentRoute(loop, root, input, deps = {}) {
  const pathDeps = deps.pathDeps ?? appNativePathDeps();
  const actualCwd = (deps.cwdFn ?? process.cwd)();
  const parent = loop.session_chain.sessions.find(session => session.run_id === input.owner);
  const attemptId = input.attemptId ?? loop.session_chain.lease.handoff_attempt_id;
  const { continuation } = findAppAttempt(loop, attemptId);
  let authority;
  try { authority = deriveAppEmitAuthority(loop, root, input.owner, actualCwd, pathDeps); }
  catch { throw new Error('APP_ROUTE_UNCONFIRMED:parent-authority'); }
  if (authority.route !== continuation.route
      || authority.contextMode !== continuation.context_mode
      || authority.targetCwd !== continuation.target_cwd
      || authority.workstreamId !== continuation.workstream_id
      || authority.hostTaskCwdDigest !== continuation.host_task_cwd_digest
      || (input.stdinMode !== undefined
        && input.stdinMode !== parent?.host_surface?.structured_stdin_mode)) {
    throw new Error('APP_ROUTE_UNCONFIRMED:parent-authority');
  }
  return authority;
}

function assertAppParentMutationFence(loop, root, input, phases, deps = {}) {
  const bound = assertAppParentFence(loop, input, phases);
  assertAppParentRoute(loop, root, input, deps);
  return bound;
}

function assertAppParentDirectoryIdentity(loop, root, input, deps = {}) {
  const pathDeps = deps.pathDeps ?? appNativePathDeps();
  const actualCwd = (deps.cwdFn ?? process.cwd)();
  const parent = loop.session_chain.sessions.find(session => session.run_id === input.owner);
  const attemptId = input.attemptId ?? loop.session_chain.lease.handoff_attempt_id;
  const { continuation } = findAppAttempt(loop, attemptId);
  if (classifyProjectTaskDirectory(root, actualCwd, pathDeps) === null
      || !sameNativeDirectory(parent?.host_surface?.host_task_cwd, actualCwd, pathDeps)
      || !sameNativeDirectory(continuation.target_cwd, actualCwd, pathDeps)) {
    throw new Error('APP_ROUTE_AUTHORITY_FENCED');
  }
}

function clearLiveAppBinding(loop, { leaseState = 'active', handoffPhase = 'idle' } = {}) {
  Object.assign(loop.session_chain.lease, { state: leaseState, handoff_phase: handoffPhase,
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null, expires_at: null, resume_policy: null });
}

function validateAppCandidate(loop) {
  const result = validate(loop);
  if (!result.ok) throw new Error(`STATE_INVALID: ${result.errors.join('; ')}`);
}

function exactPrepareRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || utilTypes.isProxy(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.getOwnPropertySymbols(value).length !== 0
        || Object.getOwnPropertyNames(value).join('\0') !== keys.join('\0')) {
      throw new Error('APP_HOST_INPUT_INVALID');
    }
    return Object.fromEntries(keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('APP_HOST_INPUT_INVALID');
      }
      return [key, descriptor.value];
    }));
  } catch (error) {
    if (error?.message === 'APP_HOST_INPUT_INVALID') throw error;
    throw new Error('APP_HOST_INPUT_INVALID');
  }
}

function exactPrepareProjects(value) {
  if (utilTypes.isProxy(value) || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype
      || value.length > 256 || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error('APP_HOST_INPUT_INVALID');
  }
  const indices = [...Array(value.length).keys()].map(String);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== indices.length + 1 || names.at(-1) !== 'length'
      || !indices.every((key, index) => names[index] === key)) {
    throw new Error('APP_HOST_INPUT_INVALID');
  }
  return indices.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('APP_HOST_INPUT_INVALID');
    }
    const row = exactPrepareRecord(descriptor.value, ['projectId', 'projectKind', 'path']);
    if (Object.values(row).some(item => typeof item !== 'string')) {
      throw new Error('APP_HOST_INPUT_INVALID');
    }
    return row;
  });
}

function exactPrepareHostInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || utilTypes.isProxy(value)) throw new Error('APP_HOST_INPUT_INVALID');
  const names = Object.getOwnPropertyNames(value);
  const keys = names.join('\0') === 'currentHostTaskCwd'
    ? ['currentHostTaskCwd']
    : names.join('\0') === 'currentHostTaskCwd\0projects'
      ? ['currentHostTaskCwd', 'projects'] : null;
  if (keys === null) throw new Error('APP_HOST_INPUT_INVALID');
  const hostInput = exactPrepareRecord(value, keys);
  if (typeof hostInput.currentHostTaskCwd !== 'string') throw new Error('APP_HOST_INPUT_INVALID');
  if (keys.length === 1) return Object.freeze(hostInput);
  const projects = exactPrepareProjects(hostInput.projects)
    .map(project => Object.freeze(project));
  return Object.freeze({ currentHostTaskCwd: hostInput.currentHostTaskCwd,
    projects: Object.freeze(projects) });
}

function resolvePrepareRoute(loop, root, input, deps) {
  const lease = loop.session_chain.lease;
  const parent = loop.session_chain.sessions.find(session => session.run_id === input.owner);
  const pathDeps = deps.pathDeps ?? appNativePathDeps();
  const actualCwd = (deps.cwdFn ?? process.cwd)();
  let authority;
  try { authority = deriveAppEmitAuthority(loop, root, input.owner, actualCwd, pathDeps); }
  catch { throw new Error('APP_ROUTE_UNCONFIRMED:durable-authority-drift'); }
  const hostInput = exactPrepareHostInput(input.hostInput);
  const route = selectAppContinuationRoute({ root, recordedHostTaskCwd: parent.host_surface.host_task_cwd,
    currentHostTaskCwd: hostInput.currentHostTaskCwd, kernelCwd: actualCwd,
    capabilities: parent.host_surface.capabilities, projects: hostInput.projects ?? [],
    workstreams: loop.workstreams ?? [], activeWorkstreams: loop.active_workstreams ?? [] }, pathDeps);
  const { continuation } = findAppAttempt(loop, lease.handoff_attempt_id);
  if (!['create', 'fork'].includes(route.kind)
      || route.kind !== authority.route || route.kind !== continuation.route
      || route.contextMode !== authority.contextMode
      || route.contextMode !== continuation.context_mode
      || route.targetCwd !== authority.targetCwd || route.targetCwd !== continuation.target_cwd
      || route.workstreamId !== authority.workstreamId
      || route.workstreamId !== continuation.workstream_id
      || continuation.host_task_cwd_digest !== authority.hostTaskCwdDigest
      || parent.host_surface.structured_stdin_mode !== input.stdinMode) {
    throw new Error(`APP_ROUTE_UNCONFIRMED:${route.reason ?? 'binding-drift'}`);
  }
  return Object.freeze(route);
}

function applyPrepared(loop, attemptId, route, descriptorDigest, clock) {
  const { continuation } = findAppAttempt(loop, attemptId);
  continuation.phase = 'prepared';
  continuation.project_id = route.kind === 'create' ? route.projectId : null;
  continuation.descriptor_digest = descriptorDigest;
  continuation.prepared_at = clock.iso;
  continuation.confirmation_deadline = new Date(clock.ms + APP_CONFIRMATION_TIMEOUT_MS).toISOString();
  Object.assign(loop.session_chain.lease, { handoff_phase: 'spawned', state: 'releasing' });
}

function exactActionRecord(value, expected) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || utilTypes.isProxy(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.getOwnPropertySymbols(value).length !== 0
        || Object.getOwnPropertyNames(value).sort().join('\0')
          !== [...expected].sort().join('\0')) throw new Error('APP_DESCRIPTOR_INVALID');
    return Object.fromEntries(expected.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('APP_DESCRIPTOR_INVALID');
      }
      return [key, descriptor.value];
    }));
  } catch (error) {
    if (error?.message === 'APP_DESCRIPTOR_INVALID') throw error;
    throw new Error('APP_DESCRIPTOR_INVALID');
  }
}

function exactPreparedAction(action, route) {
  const top = exactActionRecord(action, route.kind === 'create'
    ? ['tool', 'target', 'prompt'] : ['tool', 'environment', 'followup']);
  let normalized;
  if (route.kind === 'create') {
    const target = exactActionRecord(top.target, ['type', 'projectId', 'environment']);
    const environment = exactActionRecord(target.environment, ['type']);
    if (top.tool !== 'create_thread' || target.type !== 'project'
        || environment.type !== 'local' || target.projectId !== route.projectId
        || typeof top.prompt !== 'string') {
      throw new Error('APP_DESCRIPTOR_INVALID');
    }
    normalized = { tool: top.tool, target: { type: target.type,
      projectId: target.projectId, environment: { type: environment.type } },
    prompt: top.prompt };
  } else {
    const environment = exactActionRecord(top.environment, ['type']);
    const followup = exactActionRecord(top.followup, ['tool', 'prompt']);
    if (top.tool !== 'fork_thread' || environment.type !== 'same-directory'
        || followup.tool !== 'send_message_to_thread'
        || typeof followup.prompt !== 'string') throw new Error('APP_DESCRIPTOR_INVALID');
    normalized = { tool: top.tool, environment: { type: environment.type },
      followup: { tool: followup.tool, prompt: followup.prompt } };
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 32_768) {
    throw new Error('APP_DESCRIPTOR_INVALID');
  }
  return normalized;
}

function applyPrepareFailure(loop, input, code, preserve) {
  const attemptId = input.attemptId ?? loop.session_chain.lease.handoff_attempt_id;
  const { session, continuation } = findAppAttempt(loop, attemptId);
  loop.status = 'paused';
  loop.pause_reason = code;
  if (preserve) {
    loop.session_chain.lease.resume_policy = 'human';
    loop.session_chain.lease.expires_at = null;
    return;
  }
  continuation.phase = 'abandoned';
  continuation.failure_code = code;
  session.outcome = 'failed_launch';
  const parent = loop.session_chain.sessions.find(item => item.superseded_by === session.run_id);
  if (parent) parent.superseded_by = null;
  clearLiveAppBinding(loop);
}

function settlePrepareFailure(root, runId, input,
  { code, preserve, nowFn, gateFn, deps, phase }) {
  return phase(mutation => {
    const snapshot = mutation.readVerifiedState(
      { fenceCheck: loop => assertAppParentIdentity(loop, input) }).data;
    const attemptId = input.attemptId ?? snapshot.session_chain.lease.handoff_attempt_id;
    const childRunId = findAppAttempt(snapshot, attemptId).session.run_id;
    let result;
    mutation.appendAnchored({ type: preserve ? 'app-task-preserved' : 'app-task-abandoned',
      data: { attempt_id: attemptId, child_run_id: childRunId, failure_code: code,
        ...(preserve ? {} : { owner_run_id: input.owner, generation: input.generation }) } }, loop => {
      applyPrepareFailure(loop, input, code, preserve);
      result = { ok: false, outcome: preserve ? 'manual-preserve' : 'gate-blocked',
        do_not_call: true, attempt_id: attemptId, reason: code };
    }, (loop, clock) => {
      const bound = assertAppParentFence(loop, input, ['emitted']);
      assertAppParentDirectoryIdentity(loop, root, input, deps);
      if (clock.ms > Date.parse(bound.continuation.prepare_deadline)) {
        throw new Error('APP_PREPARE_DEADLINE_EXPIRED');
      }
      if (preserve) {
        let stillUnconfirmed = false;
        try { resolvePrepareRoute(loop, root, input, deps); }
        catch (error) {
          if (String(error?.message || error).startsWith('APP_ROUTE_UNCONFIRMED')) {
            stillUnconfirmed = true;
          } else {
            throw error;
          }
        }
        if (!stillUnconfirmed) throw new Error('APP_PREPARE_ROUTE_CHANGED');
      } else {
        const gate = gateFn(loop, { now: clock.ms });
        if (gate.ok || `gate-${gate.blocked_by[0].replaceAll('_', '-')}` !== code) {
          throw new Error('APP_GATE_CHANGED');
        }
      }
      const candidate = structuredClone(loop);
      applyPrepareFailure(candidate, input, code, preserve);
      validateAppCandidate(candidate);
    }, { nowFn, fenceCheck: loop => assertAppParentIdentity(loop, input) });
    return result;
  });
}

const PREPARE_GATE_FAILURE_CODES = new Set([
  'gate-budget', 'gate-breaker', 'gate-max-sessions', 'gate-wallclock',
  'gate-auto-handoff',
]);

function exactRecoveredFailureData(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error('APP_PREPARE_RECOVERY_INVALID');
  }
  return value;
}

function recoveredPrepareFailure(mutation, input) {
  const recovered = mutation.recovered;
  if (!recovered || !Array.isArray(recovered.events) || recovered.events.length !== 1) {
    throw new Error('APP_PREPARE_RECOVERY_INVALID');
  }
  const event = recovered.events[0];
  const preserve = event?.type === 'app-task-preserved';
  const abandoned = event?.type === 'app-task-abandoned';
  if (!preserve && !abandoned) throw new Error('APP_PREPARE_RECOVERY_INVALID');
  const data = exactRecoveredFailureData(event.data, preserve
    ? ['attempt_id', 'child_run_id', 'failure_code']
    : ['attempt_id', 'child_run_id', 'failure_code', 'owner_run_id', 'generation']);
  if (typeof data.attempt_id !== 'string' || typeof data.child_run_id !== 'string'
      || (input.attemptId !== null && input.attemptId !== data.attempt_id)) {
    throw new Error('APP_PREPARE_RECOVERY_INVALID');
  }
  const current = mutation.readVerifiedState().data;
  const { session, continuation } = findAppAttempt(current, data.attempt_id);
  if (session.run_id !== data.child_run_id || current.status !== 'paused'
      || current.pause_reason !== data.failure_code) {
    throw new Error('APP_PREPARE_RECOVERY_INVALID');
  }
  if (preserve) {
    const lease = current.session_chain.lease;
    if (data.failure_code !== 'app-launch-unconfirmed'
        || continuation.phase !== 'emitted'
        || lease.owner_run_id !== input.owner || lease.generation !== input.generation
        || lease.handoff_transport !== 'codex-app'
        || lease.handoff_attempt_id !== data.attempt_id
        || lease.handoff_child_run_id !== data.child_run_id
        || lease.resume_policy !== 'human' || lease.expires_at !== null) {
      throw new Error('APP_PREPARE_RECOVERY_INVALID');
    }
    return { ok: false, outcome: 'manual-preserve', do_not_call: true,
      attempt_id: data.attempt_id, reason: data.failure_code };
  }
  const lease = current.session_chain.lease;
  if (!PREPARE_GATE_FAILURE_CODES.has(data.failure_code)
      || data.owner_run_id !== input.owner || data.generation !== input.generation
      || continuation.phase !== 'abandoned'
      || continuation.failure_code !== data.failure_code
      || session.outcome !== 'failed_launch'
      || lease.state !== 'active' || lease.handoff_phase !== 'idle'
      || lease.handoff_transport !== null || lease.handoff_attempt_id !== null
      || lease.handoff_child_run_id !== null || lease.handoff_idempotency_key !== null
      || lease.expires_at !== null || lease.resume_policy !== null) {
    throw new Error('APP_PREPARE_RECOVERY_INVALID');
  }
  return { ok: false, outcome: 'gate-blocked', do_not_call: true,
    attempt_id: data.attempt_id, reason: data.failure_code };
}

export function prepareAppTask(root, runId, input, deps = {}) {
  const hostInput = exactPrepareHostInput(input.hostInput);
  const request = Object.freeze({ owner: input.owner, generation: input.generation,
    attemptId: input.attemptId ?? null, stdinMode: input.stdinMode, hostInput,
    hostInputDigest: intentField('prepare-host-input', hostInput) });
  const reconcile = deps.reconcileBudgetFn ?? reconcileBudget;
  const gateFor = deps.gateFn ?? respawnGate;
  const authoritativeNow = deps.nowFn ?? Date.now;
  const prepareRequestDigest = appMutationIntentDigest(request, 'app-prepare');
  const requestPhase = body => withAppMutation(root, runId, request, 'app-prepare', body);
  const authenticated = readAuthenticatedMutationSnapshot(root, runId, {
    callerBinding: { owner: request.owner, generation: request.generation },
    fenceCheck: loop => assertAppParentIdentity(loop, request),
    fenceError: 'LEASE_FENCED: app-prepare',
  });
  const snapshot = authenticated.data;
  try {
    const failureRetry = requestPhase(mutation => mutation.recovered === null
      ? null : recoveredPrepareFailure(mutation, request));
    if (failureRetry !== null) return failureRetry;
  } catch (error) {
    // A final action claim has a stronger descriptor-bound intent. Its pending marker must remain
    // untouched until the complete action is rebuilt and authenticated by completePhase below.
    if (String(error?.message || error) !== 'APP_TASK_FENCED:app-prepare') throw error;
  }
  const existing = assertAppParentFence(snapshot, request, ['emitted', 'prepared']);
  if (snapshot.status !== 'running' || snapshot.session_chain.lease.resume_policy !== 'app') {
    throw new Error('RUN_PAUSED: app-prepare');
  }
  const alreadyPrepared = existing.continuation.phase === 'prepared';
  if (alreadyPrepared) {
    if (snapshot.session_chain.lease.handoff_phase !== 'spawned'
        || snapshot.session_chain.lease.state !== 'releasing') throw new Error('APP_ATTEMPT_FENCED');
  }
  assertAppParentDirectoryIdentity(snapshot, root, request, deps);
  let route;
  try { route = resolvePrepareRoute(snapshot, root, request, deps); }
  catch (error) {
    if (!String(error?.message || error).startsWith('APP_ROUTE_UNCONFIRMED')) throw error;
    if (alreadyPrepared) {
      const parent = snapshot.session_chain.sessions.find(session => session.run_id === request.owner);
      throw new Error(request.stdinMode !== parent?.host_surface?.structured_stdin_mode
        ? 'APP_STDIN_MODE_FENCED' : 'APP_PREPARE_REQUEST_FENCED');
    }
    return settlePrepareFailure(root, runId, request, { code: 'app-launch-unconfirmed',
      preserve: true, nowFn: authoritativeNow, gateFn: gateFor, deps, phase: requestPhase });
  }
  if (typeof deps.descriptorBuilder !== 'function') throw new Error('APP_DESCRIPTOR_BUILDER_REQUIRED');
  const action = exactPreparedAction(deps.descriptorBuilder({ loop: snapshot, route,
    child: existing.session, attemptId: existing.attemptId }), route);
  const descriptorDigest = contentHash(JSON.stringify({ action,
    prepare_request_digest: prepareRequestDigest }));
  const completeRequest = Object.freeze({ ...request, descriptorDigest });
  const completePhase = body => withAppMutation(root, runId, completeRequest,
    'app-prepare', body, { intentConflictError: 'APP_PREPARE_REQUEST_FENCED' });
  const preparedNoop = mutation => {
    const current = mutation.readVerifiedState(
      { fenceCheck: loop => assertAppParentIdentity(loop, completeRequest) }).data;
    const bound = assertAppParentFence(current, completeRequest, ['prepared']);
    if (bound.continuation.descriptor_digest !== descriptorDigest
        || bound.continuation.project_id
          !== (route.kind === 'create' ? route.projectId : null)
        || current.session_chain.lease.handoff_phase !== 'spawned'
        || current.session_chain.lease.state !== 'releasing') {
      throw new Error('APP_PREPARE_REQUEST_FENCED');
    }
    return { ok: true, outcome: 'already-prepared', do_not_call: true,
      attempt_id: bound.attemptId };
  };
  if (alreadyPrepared || authenticated.pending) {
    return completePhase(preparedNoop);
  }
  const outerGate = gateFor(snapshot, { now: Number((deps.precheckNowFn ?? Date.now)()) });
  if (!outerGate.ok) return settlePrepareFailure(root, runId, request, {
    code: `gate-${outerGate.blocked_by[0].replaceAll('_', '-')}`,
    preserve: false, nowFn: authoritativeNow, gateFn: gateFor, deps,
    phase: requestPhase });
  // This is the final operation before the CAS. Proved pending transactions returned above enter
  // their complete-action gateway directly, so recovery precedes any new advisory work.
  reconcile(root, runId, {});
  try {
    return completePhase(mutation => {
      let result;
      try {
        mutation.appendAnchored({ type: 'app-task-prepared',
          data: { attempt_id: existing.attemptId, child_run_id: existing.session.run_id,
            descriptor_digest: descriptorDigest } },
        (loop, _spent, clock) => {
          applyPrepared(loop, existing.attemptId, route, descriptorDigest, clock);
          result = { ok: true, outcome: 'prepared', do_not_call: false,
            attempt_id: existing.attemptId, route: route.kind,
            context_mode: existing.continuation.context_mode, action };
        }, (loop, clock) => {
          const bound = assertAppParentMutationFence(loop, root, request,
            ['emitted', 'prepared'], deps);
          if (loop.status !== 'running' || loop.session_chain.lease.resume_policy !== 'app') {
            throw new Error('RUN_PAUSED: app-prepare');
          }
          if (bound.continuation.phase === 'prepared') throw new Error('APP_PREPARE_CAS_LOST');
          if (clock.ms > Date.parse(bound.continuation.prepare_deadline)) {
            throw new Error('APP_PREPARE_DEADLINE_EXPIRED');
          }
          let freshRoute;
          try { freshRoute = resolvePrepareRoute(loop, root, request, deps); }
          catch { throw new Error('APP_PREPARE_ROUTE_CHANGED'); }
          if (JSON.stringify(freshRoute) !== JSON.stringify(route)) {
            throw new Error('APP_PREPARE_ROUTE_CHANGED');
          }
          const freshGate = gateFor(loop, { now: clock.ms });
          if (!freshGate.ok) throw new Error(`APP_GATE_BLOCKED:${freshGate.blocked_by[0]}`);
          const candidate = structuredClone(loop);
          applyPrepared(candidate, existing.attemptId, route, descriptorDigest, clock);
          validateAppCandidate(candidate);
        }, { nowFn: authoritativeNow,
          fenceCheck: loop => assertAppParentIdentity(loop, request) });
      } catch (error) {
        if (String(error?.message || error) !== 'APP_PREPARE_CAS_LOST') throw error;
        const current = mutation.readVerifiedState().data;
        const bound = assertAppParentFence(current, request, ['prepared']);
        if (bound.attemptId === existing.attemptId
            && bound.continuation.descriptor_digest === descriptorDigest
            && bound.continuation.project_id === (route.kind === 'create' ? route.projectId : null)
            && current.session_chain.lease.handoff_phase === 'spawned') {
          return { ok: true, outcome: 'already-prepared', do_not_call: true,
            attempt_id: existing.attemptId };
        }
        throw error;
      }
      return result;
    });
  } catch (error) {
    if (String(error?.message || error) === 'APP_PREPARE_ROUTE_CHANGED') {
      return settlePrepareFailure(root, runId, request, { code: 'app-launch-unconfirmed',
        preserve: true, nowFn: authoritativeNow, gateFn: gateFor, deps,
        phase: requestPhase });
    }
    const match = /^APP_GATE_BLOCKED:(budget|breaker|max_sessions|wallclock|auto_handoff)$/.exec(
      String(error?.message || error));
    if (!match) throw error;
    return settlePrepareFailure(root, runId, request,
      { code: `gate-${match[1].replaceAll('_', '-')}`,
        preserve: false, nowFn: authoritativeNow, gateFn: gateFor, deps,
        phase: requestPhase });
  }
}

function assertRecordedReaderMode(loop, input) {
  const recorded = loop.session_chain.sessions.find(item => item.run_id === input.owner)
    ?.host_surface?.structured_stdin_mode;
  if (input.stdinMode !== recorded) throw new Error('APP_STDIN_MODE_FENCED');
  return recorded;
}

function appAttemptParent(loop, child) {
  const parents = loop.session_chain.sessions.filter(parent =>
    parent.superseded_by === child.run_id);
  return parents.length === 1 ? parents[0] : null;
}

function assertAppParentEntryIdentity(loop, input,
  { allowAcquired = false, allowFailed = false } = {}) {
  if (loop.autonomy?.session_runtime !== 'codex') throw new Error('RUNTIME_FENCED: app-task');
  const lease = loop.session_chain?.lease;
  const { session: child, continuation } = findAppAttempt(loop, input.attemptId);
  const parent = loop.session_chain.sessions.find(session =>
    session.run_id === input.owner && session.superseded_by === child.run_id);
  const linkedLiveParent = ['emitted', 'prepared', 'confirmed'].includes(continuation.phase)
    && parent?.run_id === input.owner && lease?.owner_run_id === input.owner
    && lease?.generation === input.generation;
  const acquiredHistoricalParent = allowAcquired && continuation.phase === 'acquired'
    && parent?.run_id === input.owner && lease?.owner_run_id === child.run_id
    && lease?.generation === input.generation + 1;
  const failedHistoricalParent = allowFailed && continuation.phase === 'failed'
    && continuation.failure_binding?.owner_run_id === input.owner
    && continuation.failure_binding?.generation === input.generation;
  if (!linkedLiveParent && !acquiredHistoricalParent && !failedHistoricalParent) {
    throw new Error('LEASE_FENCED: app-task-entry');
  }
}

function exactImmediateAppAcquiredProjection(loop, input) {
  const { session: child, continuation } = findAppAttempt(loop, input.attemptId);
  const parent = appAttemptParent(loop, child);
  const lease = loop.session_chain.lease;
  return continuation.phase === 'acquired' && parent?.run_id === input.owner
    && loop.status === 'running' && loop.pause_reason == null
    && lease.owner_run_id === child.run_id && lease.generation === input.generation + 1
    && lease.state === 'active' && lease.handoff_phase === 'acquired'
    && continuation.acquired_generation === lease.generation
    && continuation.acquired_at === lease.acquired_at
    && child.started_at === continuation.acquired_at
    && child.host_surface?.observed_generation === lease.generation
    && child.host_surface?.observed_at === continuation.acquired_at
    && parent.outcome === 'took_over' && child.outcome == null && child.ended_at == null
    && child.superseded_by == null
    && ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
      'handoff_idempotency_key', 'resume_policy', 'expires_at']
      .every(key => lease[key] == null);
}

function exactConfirmedResponseProjection(loop, input) {
  const { session: child, continuation } = findAppAttempt(loop, input.attemptId);
  const parent = appAttemptParent(loop, child);
  const lease = loop.session_chain.lease;
  return continuation.phase === 'confirmed' && parent?.run_id === input.owner
    && parent.outcome == null
    && loop.status === 'running' && loop.pause_reason == null
    && lease.owner_run_id === input.owner && lease.generation === input.generation
    && lease.state === 'releasing' && lease.handoff_phase === 'spawned'
    && lease.handoff_transport === 'codex-app'
    && lease.handoff_attempt_id === input.attemptId
    && lease.handoff_child_run_id === child.run_id
    && typeof lease.handoff_idempotency_key === 'string'
    && lease.resume_policy === 'app' && typeof lease.expires_at === 'string'
    && child.outcome == null && child.started_at == null && child.ended_at == null
    && child.host_surface == null && child.superseded_by == null;
}

function exactFailedResponseProjection(loop, input, receipt) {
  const { session: child, continuation } = findAppAttempt(loop, input.attemptId);
  const parent = appAttemptParent(loop, child);
  const owner = loop.session_chain.sessions.find(item => item.run_id === input.owner);
  const lease = loop.session_chain.lease;
  const common = continuation.phase === 'failed'
    && continuation.failure_code === input.code
    && continuation.unconfirmed_thread_id === receipt
    && continuation.failure_binding?.owner_run_id === input.owner
    && continuation.failure_binding?.generation === input.generation
    && owner != null && owner.outcome == null
    && loop.status === 'paused' && loop.pause_reason === input.code
    && lease.owner_run_id === input.owner && lease.generation === input.generation
    && child.started_at == null && child.ended_at == null
    && child.host_surface == null && child.superseded_by == null;
  if (!common) return false;
  if (input.code === 'message-unconfirmed') {
    return parent?.run_id === input.owner && child.outcome == null
      && lease.state === 'releasing' && lease.handoff_phase === 'spawned'
      && lease.handoff_transport === 'codex-app'
      && lease.handoff_attempt_id === input.attemptId
      && lease.handoff_child_run_id === child.run_id
      && typeof lease.handoff_idempotency_key === 'string'
      && lease.resume_policy === 'human' && lease.expires_at == null;
  }
  if (['app-prepare-unattended', 'app-launch-unconfirmed'].includes(input.code)) {
    const expectedPhase = continuation.prepared_at == null ? 'emitted' : 'spawned';
    return parent?.run_id === input.owner && child.outcome == null
      && lease.state === 'releasing' && lease.handoff_phase === expectedPhase
      && lease.handoff_transport === 'codex-app'
      && lease.handoff_attempt_id === input.attemptId
      && lease.handoff_child_run_id === child.run_id
      && typeof lease.handoff_idempotency_key === 'string'
      && lease.resume_policy === 'human' && lease.expires_at == null;
  }
  return owner.superseded_by == null
    && !loop.session_chain.sessions.some(item => item.superseded_by === child.run_id)
    && child.outcome === 'failed_launch'
    && lease.state === 'active' && lease.handoff_phase === 'idle'
    && ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
      'handoff_idempotency_key', 'resume_policy', 'expires_at']
      .every(key => lease[key] == null);
}

function exactAppLifecycleTail(loop, lines, input, phase, receipt = null) {
  const { session: child } = findAppAttempt(loop, input.attemptId);
  const tail = lines.at(-1);
  const head = loop.event_log_head;
  const exactKeys = keys => JSON.stringify(Object.keys(tail?.data ?? {}).sort())
    === JSON.stringify([...keys].sort());
  if (tail?.seq !== head?.seq || tail?.checksum !== head?.checksum
      || tail.data?.attempt_id !== input.attemptId
      || tail.data?.child_run_id !== child.run_id) return false;
  if (phase === 'confirmed') {
    return exactKeys(['attempt_id', 'child_run_id', 'receipt_digest'])
      && tail.type === 'app-task-confirmed'
      && tail.data?.receipt_digest === contentHash('confirmed-thread\0' + input.threadId);
  }
  if (phase === 'acquired') {
    let observationDigest;
    try { observationDigest = hostSurfaceFactsDigest(child.host_surface); }
    catch { return false; }
    return exactKeys(['attempt_id', 'child_run_id', 'observation_digest'])
      && tail.type === 'app-task-acquired'
      && tail.data?.observation_digest === observationDigest;
  }
  if (phase !== 'failed' && phase !== 'swept') return false;
  const binding = child.continuation.failure_binding;
  const failureKeys = ['attempt_id', 'child_run_id', 'failure_code',
    'generation', 'owner_run_id'];
  if (input.code === 'message-unconfirmed') failureKeys.push('unconfirmed_receipt_digest');
  const expectedType = phase === 'swept' ? 'app-task-swept' : 'app-task-failed';
  const exactFailure = exactKeys(failureKeys) && tail.type === expectedType
    && tail.data?.failure_code === input.code
    && tail.data?.owner_run_id === binding?.owner_run_id
    && tail.data?.generation === binding?.generation;
  return exactFailure && (input.code === 'message-unconfirmed'
    ? tail.data?.unconfirmed_receipt_digest
      === contentHash('unconfirmed-thread\0' + receipt)
    : !Object.hasOwn(tail.data ?? {}, 'unconfirmed_receipt_digest'));
}

export const APP_FAILURE_CODES = Object.freeze([
  'host-call-timeout', 'host-call-no-return', 'host-call-failed',
  'invalid-host-receipt', 'message-unconfirmed', 'app-prepare-unattended',
  'app-launch-unconfirmed', 'consent-revoked', 'gate-budget', 'gate-breaker',
  'gate-max-sessions', 'gate-wallclock', 'gate-auto-handoff', 'human-recovered',
  'run-finished',
]);
export const APP_PUBLIC_FAILURE_CODES = Object.freeze([
  'host-call-timeout', 'host-call-no-return', 'host-call-failed',
  'invalid-host-receipt', 'message-unconfirmed',
]);
const APP_PUBLIC_FAILURE_CODE_SET = new Set(APP_PUBLIC_FAILURE_CODES);

export function isAppPublicFailureCode(value) {
  return APP_PUBLIC_FAILURE_CODE_SET.has(value);
}

export function confirmAppTask(root, runId, input, deps = {}) {
  const threadId = validateOpaqueId(input.threadId, { label: 'thread-id' });
  return withAppMutation(root, runId, input, 'app-confirm', mutation => {
    const snapshot = mutation.readVerifiedState(
      { fenceCheck: loop => assertAppParentEntryIdentity(loop, input,
        { allowAcquired: true }) }).data;
    const existing = findAppAttempt(snapshot, input.attemptId).continuation;
    if (['confirmed', 'acquired'].includes(existing.phase)) {
      assertRecordedReaderMode(snapshot, input);
      if (existing.thread_id !== threadId) throw new Error('APP_RECEIPT_FENCED');
      const exact = existing.phase === 'acquired'
        ? exactImmediateAppAcquiredProjection(snapshot, input)
        : exactConfirmedResponseProjection(snapshot, input);
      const exactTail = exactAppLifecycleTail(
        snapshot, readLines(root, runId), input, existing.phase);
      if (!exact || !exactTail) throw new Error('APP_RESPONSE_PROJECTION_CHANGED');
      return { ok: true,
        outcome: existing.phase === 'acquired' ? 'already-complete' : 'already-confirmed',
        attempt_id: input.attemptId };
    }
    let result;
    mutation.appendAnchored({ type: 'app-task-confirmed', data: {
      attempt_id: input.attemptId,
      child_run_id: findAppAttempt(snapshot, input.attemptId).session.run_id,
      receipt_digest: contentHash('confirmed-thread\0' + threadId),
    } }, (loop, _spent, clock) => {
      const { continuation } = findAppAttempt(loop, input.attemptId);
      continuation.phase = 'confirmed';
      continuation.thread_id = threadId;
      continuation.confirmed_at = clock.iso;
      result = { ok: true, outcome: 'confirmed', attempt_id: input.attemptId };
    }, (loop, clock) => {
      const { continuation } = assertAppParentMutationFence(
        loop, root, input, ['prepared'], deps);
      assertRecordedReaderMode(loop, input);
      if (clock.ms > Date.parse(continuation.confirmation_deadline)) {
        throw new Error('APP_ATTEMPT_FENCED');
      }
      const candidate = structuredClone(loop);
      const next = findAppAttempt(candidate, input.attemptId).continuation;
      next.phase = 'confirmed'; next.thread_id = threadId; next.confirmed_at = clock.iso;
      validateAppCandidate(candidate);
    }, { nowFn: deps.nowFn ?? Date.now,
      fenceCheck: loop => assertAppParentIdentity(loop, input),
    });
    return result;
  });
}

function applyAppFailure(loop, input, code, receipt) {
  const { session, continuation } = findAppAttempt(loop, input.attemptId);
  continuation.phase = 'failed';
  continuation.failure_code = code;
  continuation.failure_binding = { owner_run_id: input.owner, generation: input.generation };
  loop.status = 'paused';
  loop.pause_reason = code;
  if (code === 'message-unconfirmed') {
    continuation.unconfirmed_thread_id = receipt;
    loop.session_chain.lease.resume_policy = 'human';
    loop.session_chain.lease.expires_at = null;
  } else {
    session.outcome = 'failed_launch';
    const parent = loop.session_chain.sessions.find(item => item.superseded_by === session.run_id);
    if (parent) parent.superseded_by = null;
    clearLiveAppBinding(loop);
  }
}

export function failAppTask(root, runId, input, deps = {}) {
  if (!isAppPublicFailureCode(input.code)) throw new Error('APP_FAILURE_CODE_INVALID');
  const receipt = input.unconfirmedThreadId == null ? null
    : validateOpaqueId(input.unconfirmedThreadId, { label: 'thread-id' });
  return withAppMutation(root, runId, input, 'app-fail', mutation => {
    const snapshot = mutation.readVerifiedState(
      { fenceCheck: loop => assertAppParentEntryIdentity(loop, input,
        { allowFailed: true }) }).data;
    const existing = findAppAttempt(snapshot, input.attemptId).continuation;
    if (input.code === 'message-unconfirmed') assertRecordedReaderMode(snapshot, input);
    else if (input.stdinMode != null || receipt !== null) throw new Error('APP_RECEIPT_FENCED');
    if (existing.phase === 'failed') {
      if (existing.failure_code !== input.code || existing.unconfirmed_thread_id !== receipt) {
        throw new Error('APP_RECEIPT_FENCED');
      }
      if (!exactFailedResponseProjection(snapshot, input, receipt)
          || !exactAppLifecycleTail(
            snapshot, readLines(root, runId), input, 'failed', receipt)) {
        throw new Error('APP_RESPONSE_PROJECTION_CHANGED');
      }
      return { ok: true, outcome: 'already-failed', attempt_id: input.attemptId,
        failure_code: input.code };
    }
    if ((input.code === 'message-unconfirmed') !== (receipt !== null)
        || (input.code === 'message-unconfirmed' && existing.route !== 'fork')) {
      throw new Error('APP_RECEIPT_FENCED');
    }
    let result;
    mutation.appendAnchored({ type: 'app-task-failed', data: {
      attempt_id: input.attemptId,
      child_run_id: findAppAttempt(snapshot, input.attemptId).session.run_id,
      failure_code: input.code, owner_run_id: input.owner, generation: input.generation,
      ...(input.code === 'message-unconfirmed' ? {
        unconfirmed_receipt_digest: contentHash('unconfirmed-thread\0' + receipt),
      } : {}),
    } }, loop => {
      applyAppFailure(loop, input, input.code, receipt);
      result = { ok: true, outcome: 'failed', attempt_id: input.attemptId,
        failure_code: input.code };
    }, loop => {
      const { continuation } = assertAppParentMutationFence(
        loop, root, input, ['prepared'], deps);
      if (input.code === 'message-unconfirmed') assertRecordedReaderMode(loop, input);
      if (input.code === 'message-unconfirmed' && continuation.route !== 'fork') {
        throw new Error('APP_RECEIPT_FENCED');
      }
      const candidate = structuredClone(loop);
      applyAppFailure(candidate, input, input.code, receipt);
      validateAppCandidate(candidate);
    }, { nowFn: deps.nowFn ?? Date.now,
      fenceCheck: loop => assertAppParentIdentity(loop, input),
    });
    return result;
  });
}

function observationFacts(observation) {
  const copy = structuredClone(observation);
  delete copy.observed_generation;
  delete copy.observed_at;
  return copy;
}

function exactAcquireObservationInput(value) {
  let raw;
  try { raw = exactRawHostObservation(value); }
  catch { throw new Error('APP_CHILD_OBSERVATION_INVALID'); }
  if (['host_task_cwd', 'host_task_cwd_source', 'kind', 'source',
    'structured_stdin_mode'].some(key => typeof raw[key] !== 'string')) {
    throw new Error('APP_CHILD_OBSERVATION_INVALID');
  }
  return raw;
}

function normalizeAcquireObservation(raw, input, pathDeps, actualCwd, failureCode) {
  try {
    return normalizeHostObservation({ ...raw, observed_at: null, runtime: input.runtime },
      { ...pathDeps, kernelCwd: actualCwd });
  } catch {
    throw new Error(failureCode);
  }
}

function anchoredAcquireObservation(observation, clock, generation) {
  return Object.freeze({ ...observationFacts(observation),
    observed_generation: generation, observed_at: clock.iso });
}

function assertAppAcquireEntryIdentity(loop, input) {
  if (loop.autonomy?.session_runtime !== input.runtime || input.runtime !== 'codex') {
    throw new Error('RUNTIME_FENCED: app-acquire');
  }
  const lease = loop.session_chain?.lease;
  const { session: child } = findAppAttempt(loop, input.attemptId);
  if (child.run_id !== input.owner) throw new Error('LEASE_FENCED: APP_ATTEMPT_FENCED');
  const parent = loop.session_chain.sessions.find(session =>
    session.superseded_by === child.run_id);
  const beforeAcquire = parent != null && lease?.owner_run_id === parent.run_id
    && lease?.generation === input.generation;
  const afterAcquire = parent != null && lease?.owner_run_id === child.run_id
    && lease?.generation === input.generation + 1;
  if (!beforeAcquire && !afterAcquire) throw new Error('LEASE_FENCED: app-acquire-entry');
}

function exactAcquiredProjection(loop, input, observation) {
  const found = findAppAttempt(loop, input.attemptId);
  const child = found.session;
  const parent = appAttemptParent(loop, child);
  return input.runtime === 'codex' && child.run_id === input.owner && parent != null
    && exactImmediateAppAcquiredProjection(loop, { attemptId: input.attemptId,
      owner: parent.run_id, generation: input.generation })
    && input.stdinMode === child.host_surface?.structured_stdin_mode
    && input.stdinMode === observation.structured_stdin_mode
    && JSON.stringify(observationFacts(child.host_surface))
      === JSON.stringify(observationFacts(observation));
}

function applyAppAcquire(loop, input, observation, clock) {
  const { session: child, continuation } = findAppAttempt(loop, input.attemptId);
  const lease = loop.session_chain.lease;
  loop.session_chain.lease = { ...lease, owner_run_id: child.run_id,
    generation: input.generation + 1, state: 'active', handoff_phase: 'acquired',
    acquired_at: clock.iso, expires_at: null, resume_policy: null,
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null };
  continuation.phase = 'acquired';
  continuation.acquired_at = clock.iso;
  continuation.acquired_generation = input.generation + 1;
  child.host_surface = anchoredAcquireObservation(observation, clock, input.generation + 1);
  child.started_at = clock.iso;
  const parent = appAttemptParent(loop, child);
  if (parent) parent.outcome = 'took_over';
  loop.status = 'running';
  loop.pause_reason = null;
}

export function acquireAppTask(root, runId, input, deps = {}) {
  // This first lock is authentication-only. It validates either the verified canonical state or a
  // marker-authenticated exact before/after state without recovering the marker, then closes before
  // any caller observation is parsed or cwd/native-path dependency can execute. The final gateway
  // independently matches the complete intent, recovers if exact, and re-fences.
  authenticateVerifiedMutationCaller(root, runId, {
    callerBinding: { owner: input.owner, generation: input.generation },
    fenceCheck: loop => assertAppAcquireEntryIdentity(loop, input),
    fenceError: 'LEASE_FENCED: app-acquire-entry',
  });
  const rawObservation = exactAcquireObservationInput(input.observation);
  const pathDeps = deps.pathDeps ?? appNativePathDeps();
  // After authenticated entry, canonicalize only against the observation's own directory identity.
  // The post-fence normalization below must reproduce the same immutable facts against actual cwd.
  const intentObservation = normalizeAcquireObservation(rawObservation,
    input, pathDeps,
    rawObservation.host_task_cwd, 'APP_CHILD_OBSERVATION_FENCED');
  const observationDigest = hostSurfaceFactsDigest(intentObservation);
  const intentInput = Object.freeze({ ...input, childRunId: input.owner, observationDigest });
  const actualCwd = (deps.cwdFn ?? process.cwd)();
  const normalizedObservation = normalizeAcquireObservation(rawObservation,
    input, pathDeps, actualCwd, 'APP_CHILD_OBSERVATION_FENCED');
  if (hostSurfaceFactsDigest(normalizedObservation) !== observationDigest) {
    throw new Error('APP_CHILD_OBSERVATION_FENCED');
  }
  return withAppMutation(root, runId, intentInput, 'app-acquire', mutation => {
    const snapshot = mutation.readVerifiedState(
      { fenceCheck: loop => assertAppAcquireEntryIdentity(loop, input) }).data;
    const historical = findAppAttempt(snapshot, input.attemptId);
    if (historical.continuation.phase === 'acquired') {
      if (input.stdinMode !== historical.session.host_surface?.structured_stdin_mode) {
        throw new Error('APP_STDIN_MODE_FENCED');
      }
      if (exactAcquiredProjection(snapshot, input, normalizedObservation)
          && exactAppLifecycleTail(
            snapshot, readLines(root, runId), input, 'acquired')) {
        return { ok: true, outcome: 'already-acquired', generation: input.generation + 1 };
      }
      throw new Error('APP_ACQUIRE_PROJECTION_CHANGED');
    }
    const observation = normalizedObservation;
    let result;
    const eventData = { attempt_id: input.attemptId,
      child_run_id: historical.session.run_id, observation_digest: observationDigest };
    mutation.appendAnchored({ type: 'app-task-acquired', data: eventData },
    (loop, _spent, clock) => {
      applyAppAcquire(loop, input, observation, clock);
      result = { ok: true, outcome: 'acquired', generation: input.generation + 1 };
    }, (loop, clock) => {
      if (loop.status === 'completed' || loop.status === 'stopped') {
        throw new Error('RUN_TERMINAL: app-acquire');
      }
      const lease = loop.session_chain.lease;
      const exactAttempt = findAppAttempt(loop, input.attemptId);
      const { session: child, continuation } = exactAttempt;
      const parent = appAttemptParent(loop, child);
      const consent = loop.autonomy.app_task_continuation;
      if (!parent || lease.owner_run_id !== parent.run_id || child.run_id !== input.owner
          || lease.state !== 'releasing'
          || lease.handoff_phase !== 'spawned' || lease.handoff_transport !== 'codex-app'
          || lease.handoff_attempt_id !== input.attemptId
          || lease.handoff_child_run_id !== child.run_id
          || continuation.phase !== 'confirmed') throw new Error('APP_CONFIRMATION_REQUIRED');
      if (consent?.mode !== 'auto' || consent?.authority !== 'human-confirmed'
          || consent.revoked_at != null) throw new Error('APP_CONSENT_FENCED');
      if (observation.kind !== 'codex-app'
          || !['codex-app-host-context', 'codex-app-tool-provenance'].includes(observation.source)
          || observation.structured_stdin_mode !== input.stdinMode
          || !observation.capabilities.includes('structured-process-stdin')
          || !sameNativeDirectory(observation.host_task_cwd, continuation.target_cwd, pathDeps)
          || !sameNativeDirectory(actualCwd, continuation.target_cwd, pathDeps)) {
        throw new Error('APP_CHILD_OBSERVATION_FENCED');
      }
      const candidate = structuredClone(loop);
      applyAppAcquire(candidate, input, observation, clock);
      validateAppCandidate(candidate);
    }, {
      nowFn: deps.nowFn ?? Date.now,
      fenceCheck: loop => {
        const lease = loop.session_chain.lease;
        if (loop.autonomy?.session_runtime !== input.runtime || input.runtime !== 'codex') {
          throw new Error('RUNTIME_FENCED: app-acquire');
        }
        const exactAttempt = findAppAttempt(loop, input.attemptId);
        if (exactAttempt.session.run_id !== input.owner) throw new Error('APP_ATTEMPT_FENCED');
        if (lease.generation !== input.generation || lease.owner_run_id === input.owner) {
          throw new Error('LEASE_FENCED: app-acquire');
        }
      },
      // Hard-crash selection is private scalar process state in the anchored publisher.
    });
    return result;
  });
}

function exactAppReadiness(loop, input) {
  const attemptId = input.attemptId;
  const { session, continuation } = findAppAttempt(loop, attemptId);
  const lease = loop.session_chain?.lease;
  const parent = appAttemptParent(loop, session);
  const acquired = continuation.phase === 'acquired'
    && parent?.run_id === input.owner
    && exactImmediateAppAcquiredProjection(loop, input);
  if (acquired) return 'acquired';
  if (lease?.generation !== input.generation || lease?.owner_run_id !== input.owner) return 'foreign';
  if (['failed', 'abandoned'].includes(continuation.phase)) return continuation.phase;
  return 'pending';
}

function exactAwaitTimeoutProjection(loop, input) {
  const found = findAppAttempt(loop, input.attemptId);
  const lease = loop.session_chain?.lease;
  return found.continuation.phase === 'confirmed'
    && loop.status === 'paused' && loop.pause_reason === 'app-child-timeout-awaiting'
    && lease?.resume_policy === 'human' && lease.expires_at == null
    && lease.owner_run_id === input.owner && lease.generation === input.generation
    && lease.state === 'releasing' && lease.handoff_phase === 'spawned'
    && lease.handoff_transport === 'codex-app'
    && lease.handoff_attempt_id === input.attemptId
    && lease.handoff_child_run_id === found.session.run_id;
}

function assertAppAwaitEntryIdentity(loop, input) {
  if (loop.autonomy?.session_runtime !== 'codex') throw new Error('RUNTIME_FENCED: app-await');
  const lease = loop.session_chain?.lease;
  const { session: child, continuation } = findAppAttempt(loop, input.attemptId);
  const exactInputParent = loop.session_chain.sessions.find(session =>
    session.run_id === input.owner && session.superseded_by === child.run_id);
  const linkedCurrent = ['emitted', 'prepared', 'confirmed'].includes(continuation.phase)
    && exactInputParent != null && lease?.owner_run_id === input.owner
    && lease?.generation === input.generation;
  const acquired = continuation.phase === 'acquired' && exactInputParent != null
    && lease?.owner_run_id === child.run_id && lease?.generation === input.generation + 1;
  const failed = continuation.phase === 'failed'
    && continuation.failure_binding?.owner_run_id === input.owner
    && continuation.failure_binding?.generation === input.generation;
  const abandoned = continuation.phase === 'abandoned'
    && lease?.owner_run_id === input.owner && lease?.generation === input.generation;
  if (!linkedCurrent && !acquired && !failed && !abandoned) {
    throw new Error('LEASE_FENCED: app-await-entry');
  }
}

function readAppAwaitSnapshot(root, runId, input, deps, mutation) {
  if (deps.readStateFn) {
    const loop = deps.readStateFn();
    assertAppAwaitEntryIdentity(loop, input);
    return loop;
  }
  return mutation.readVerifiedState(
    { fenceCheck: loop => assertAppAwaitEntryIdentity(loop, input) }).data;
}

export function sweepUnconfirmedAppTask(root, runId, input, deps = {}) {
  return withAppMutation(root, runId, input, 'app-sweep', mutation => {
    const snapshot = mutation.readVerifiedState(
      { fenceCheck: loop => assertAppParentEntryIdentity(loop, input,
        { allowFailed: true }) }).data;
    const historical = findAppAttempt(snapshot, input.attemptId);
    if (historical.continuation.phase === 'failed'
        && ['app-prepare-unattended', 'app-launch-unconfirmed']
          .includes(historical.continuation.failure_code)) {
      const replayInput = { ...input, code: historical.continuation.failure_code };
      if (!exactFailedResponseProjection(snapshot, replayInput, null)
          || !exactAppLifecycleTail(
            snapshot, readLines(root, runId), replayInput, 'swept', null)) {
        throw new Error('APP_RESPONSE_PROJECTION_CHANGED');
      }
      return { ok: true, outcome: 'already-swept', attempt_id: input.attemptId,
        failure_code: historical.continuation.failure_code };
    }
    const existing = assertAppParentFence(snapshot, input, ['emitted', 'prepared']);
    const code = existing.continuation.phase === 'emitted'
      ? 'app-prepare-unattended' : 'app-launch-unconfirmed';
    let result;
    try {
      mutation.appendAnchored({ type: 'app-task-swept', data: {
        attempt_id: input.attemptId, child_run_id: existing.session.run_id, failure_code: code,
        owner_run_id: input.owner, generation: input.generation,
      } }, loop => {
        const { continuation } = findAppAttempt(loop, input.attemptId);
        continuation.phase = 'failed'; continuation.failure_code = code;
        continuation.failure_binding = { owner_run_id: input.owner, generation: input.generation };
        loop.status = 'paused'; loop.pause_reason = code;
        loop.session_chain.lease.resume_policy = 'human';
        loop.session_chain.lease.expires_at = null;
        result = { ok: true, outcome: 'swept', attempt_id: input.attemptId, failure_code: code };
      }, (loop, clock) => {
        const { continuation } = assertAppParentMutationFence(loop, root, input,
          [existing.continuation.phase], deps);
        const freshCode = continuation.phase === 'emitted'
          ? 'app-prepare-unattended' : 'app-launch-unconfirmed';
        const freshDeadline = continuation.phase === 'emitted'
          ? continuation.prepare_deadline : continuation.confirmation_deadline;
        if (freshCode !== code) throw new Error('APP_ATTEMPT_FENCED');
        if (clock.ms <= Date.parse(freshDeadline)) throw new Error('APP_NOT_EXPIRED');
        const candidate = structuredClone(loop);
        const next = findAppAttempt(candidate, input.attemptId).continuation;
        next.phase = 'failed'; next.failure_code = code;
        next.failure_binding = { owner_run_id: input.owner, generation: input.generation };
        candidate.status = 'paused'; candidate.pause_reason = code;
        candidate.session_chain.lease.resume_policy = 'human';
        candidate.session_chain.lease.expires_at = null;
        validateAppCandidate(candidate);
      }, { nowFn: deps.nowFn ?? Date.now,
        fenceCheck: loop => assertAppParentIdentity(loop, input),
      });
    } catch (error) {
      if (String(error?.message || error) === 'APP_NOT_EXPIRED') {
        return { ok: true, outcome: 'not-expired', attempt_id: input.attemptId };
      }
      throw error;
    }
    return result;
  });
}

export function statusAppTask(root, runId, { attemptId } = {}) {
  const loop = readVerifiedState(root, runId).data;
  const allSessions = loop.session_chain?.sessions ?? [];
  const sessions = allSessions.filter(item =>
    item?.continuation?.transport === 'codex-app');
  const lease = loop.session_chain?.lease ?? {};
  const safeHandoffRel = value => typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= 1_024
    && value.startsWith('handoffs/') && value.endsWith('.md')
    && !/[\u0000-\u001f\u007f-\u009f\\]/u.test(value)
    && value.split('/').every(segment => segment !== ''
      && segment !== '.' && segment !== '..');
  const safe = item => ({ run_id: item.run_id, attempt_id: item.continuation.attempt_id,
    route: item.continuation.route, phase: item.continuation.phase,
    failure_code: item.continuation.failure_code,
    handoff_rel: safeHandoffRel(item.handoff_rel) ? item.handoff_rel : null });
  const selected = attemptId == null
    ? sessions.find(item => item.continuation.attempt_id === lease.handoff_attempt_id)
      ?? sessions.at(-1) ?? null
    : sessions.find(item => item.continuation.attempt_id === attemptId) ?? null;
  const cleared = lease.handoff_transport == null && lease.handoff_attempt_id == null
    && lease.handoff_child_run_id == null && lease.handoff_idempotency_key == null
    && lease.resume_policy == null && lease.expires_at == null;
  const recoveredShape = loop.status === 'paused'
    && loop.pause_reason === 'recovered:awaiting-resume'
    && lease.state === 'released' && lease.handoff_phase === 'idle' && cleared;
  const recoveredSession = recoveredShape ? allSessions.at(-1) ?? null : null;
  const recoveredContinuation = recoveredSession?.continuation;
  const recoveredApp = recoveredContinuation?.transport === 'codex-app'
    && ['failed', 'abandoned'].includes(recoveredContinuation.phase)
    && typeof recoveredContinuation.attempt_id === 'string';
  const recoveredGeneric = recoveredSession?.continuation == null;
  const recoveryBinding = recoveredSession?.recovery_binding;
  const recoveryPending = recoveredSession?.outcome === 'abandoned_recover'
      && recoveredSession.started_at == null && safeHandoffRel(recoveredSession.handoff_rel)
      && recoveryBinding?.owner_run_id === lease.owner_run_id
      && recoveryBinding?.generation === lease.generation
      && (recoveredApp || recoveredGeneric)
    ? { run_id: recoveredSession.run_id, handoff_rel: recoveredSession.handoff_rel,
      transport: recoveredApp ? 'codex-app' : 'generic',
      attempt_id: recoveredApp ? recoveredContinuation.attempt_id : null,
      phase: recoveredApp ? recoveredContinuation.phase : null }
    : null;
  const liveGeneric = loop.status === 'running' && lease.state === 'releasing'
      && ['emitted', 'spawned'].includes(lease.handoff_phase)
      && lease.handoff_transport == null && lease.handoff_attempt_id == null
      && typeof lease.handoff_child_run_id === 'string'
      && typeof lease.handoff_idempotency_key === 'string'
    ? allSessions.find(item => item.run_id === lease.handoff_child_run_id
      && item.continuation == null && safeHandoffRel(item.handoff_rel)) ?? null
    : null;
  const releasedGeneric = loop.status === 'running' && lease.state === 'released'
      && ['acquired', 'idle'].includes(lease.handoff_phase) && cleared
    ? allSessions.find(item => item.run_id === lease.owner_run_id
      && (item.handoff_rel == null || safeHandoffRel(item.handoff_rel))) ?? null
    : null;
  const recoveredCurrent = recoveredShape && recoveryPending === null
    ? allSessions.find(item => item.run_id === lease.owner_run_id
      && (item.handoff_rel == null || safeHandoffRel(item.handoff_rel))) ?? null
    : null;
  const genericSession = liveGeneric ?? releasedGeneric ?? recoveredCurrent;
  const genericCurrent = genericSession === null
    ? null : { run_id: genericSession.run_id,
      handoff_rel: genericSession.handoff_rel ?? null };
  return { ok: true, logical_run_id: runId, has_app_history: sessions.length > 0,
    generic_current: genericCurrent, recovery_pending: recoveryPending,
    owner_run_id: lease.owner_run_id ?? null, generation: lease.generation ?? null,
    handoff_phase: lease.handoff_phase ?? null,
    resume_policy: lease.resume_policy ?? null,
    manual_recovery: loop.status === 'paused' || lease.resume_policy === 'human',
    current: selected ? safe(selected) : null,
    history: sessions.map(safe) };
}

export function awaitAppTask(root, runId, input, deps = {}) {
  const read = () => withAppMutation(root, runId, input, 'app-await', mutation =>
    readAppAwaitSnapshot(root, runId, input, deps, mutation));
  const authoritativeNow = deps.nowFn ?? Date.now;
  const pollNow = deps.pollNowFn ?? Date.now;
  const sleep = deps.sleepFn ?? (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const initial = read();
  // Response-loss/acquire-before-await succeeds before checking the now-stale parent fence.
  const initialReadiness = exactAppReadiness(initial, input);
  if (initialReadiness === 'acquired') {
    return { ok: true, outcome: 'acquired', attempt_id: input.attemptId };
  }
  if (initialReadiness === 'foreign') throw new Error('LEASE_FENCED: App readiness');
  if (['failed', 'abandoned'].includes(initialReadiness)) {
    const safe = statusAppTask(root, runId, { attemptId: input.attemptId });
    return { ok: false, outcome: initialReadiness, attempt_id: input.attemptId,
      failure_code: safe.current?.failure_code ?? null };
  }
  if (exactAwaitTimeoutProjection(initial, input)) {
    return { ok: false, outcome: 'already-timeout-preserved', attempt_id: input.attemptId };
  }
  assertAppParentMutationFence(initial, root, input, ['confirmed'], deps);
  const timeoutMs = (initial.autonomy?.child_ready_timeout_sec ?? 75) * 1_000;
  const interval = deps.pollIntervalMs ?? 1_500;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('APP_AWAIT_TIMEOUT_INVALID');
  }
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error('APP_AWAIT_INTERVAL_INVALID');
  }
  const samplePollNow = () => {
    const value = Number(pollNow());
    if (!Number.isFinite(value)) throw new Error('APP_AWAIT_CLOCK_INVALID');
    return value;
  };
  const deadline = samplePollNow() + timeoutMs;
  if (!Number.isFinite(deadline)) throw new Error('APP_AWAIT_CLOCK_INVALID');
  while (samplePollNow() <= deadline) {
    const loop = read();
    const readiness = exactAppReadiness(loop, input);
    if (readiness === 'acquired') return { ok: true, outcome: 'acquired', attempt_id: input.attemptId };
    if (readiness === 'foreign') throw new Error('LEASE_FENCED: App readiness');
    if (['failed', 'abandoned'].includes(readiness)) {
      const safe = statusAppTask(root, runId, { attemptId: input.attemptId });
      return { ok: false, outcome: readiness, attempt_id: input.attemptId,
        failure_code: safe.current?.failure_code ?? null };
    }
    const nextPoll = samplePollNow() + interval;
    if (!Number.isFinite(nextPoll)) throw new Error('APP_AWAIT_CLOCK_INVALID');
    if (nextPoll > deadline) break;
    sleep(interval);
  }
  let result;
  try {
    withAppMutation(root, runId, input, 'app-await', mutation =>
      mutation.appendAnchored({ type: 'app-task-await-timeout', data: {
        attempt_id: input.attemptId,
        child_run_id: findAppAttempt(initial, input.attemptId).session.run_id,
        failure_code: 'app-child-timeout-awaiting',
      } }, loop => {
        loop.status = 'paused'; loop.pause_reason = 'app-child-timeout-awaiting';
        loop.session_chain.lease.resume_policy = 'human';
        loop.session_chain.lease.expires_at = null;
        result = { ok: false, outcome: 'timeout-preserved', attempt_id: input.attemptId };
      }, (loop, clock) => {
        const readiness = exactAppReadiness(loop, input);
        if (readiness === 'acquired') throw new Error('APP_READY_ACQUIRED');
        if (readiness === 'foreign') throw new Error('LEASE_FENCED: App readiness');
        const found = findAppAttempt(loop, input.attemptId).continuation;
        if (['failed', 'abandoned'].includes(found.phase)) throw new Error('APP_READY_CHANGED');
        assertAppParentMutationFence(loop, root, input, ['confirmed'], deps);
        if (clock.ms < deadline) throw new Error('APP_AWAIT_NOT_EXPIRED');
        const candidate = structuredClone(loop);
        candidate.status = 'paused'; candidate.pause_reason = 'app-child-timeout-awaiting';
        candidate.session_chain.lease.resume_policy = 'human';
        candidate.session_chain.lease.expires_at = null;
        validateAppCandidate(candidate);
      }, { nowFn: authoritativeNow,
        fenceCheck: loop => assertAppParentIdentity(loop, input),
      }));
  } catch (error) {
    const message = String(error?.message || error);
    const convergence = ['APP_READY_ACQUIRED', 'APP_READY_CHANGED'].includes(message)
      || message.startsWith('LEASE_FENCED:');
    if (!convergence) throw error;
    const current = read();
    const currentReadiness = exactAppReadiness(current, input);
    if ((['APP_READY_ACQUIRED', 'APP_READY_CHANGED'].includes(message)
        || message.startsWith('LEASE_FENCED:')) && currentReadiness === 'foreign') {
      throw new Error('LEASE_FENCED: App readiness');
    }
    if ((message === 'APP_READY_ACQUIRED' || message.startsWith('LEASE_FENCED:'))
        && currentReadiness === 'acquired') {
      return { ok: true, outcome: 'acquired', attempt_id: input.attemptId };
    }
    if (message === 'APP_READY_CHANGED') {
      if (['failed', 'abandoned'].includes(currentReadiness)) {
        const safe = statusAppTask(root, runId, { attemptId: input.attemptId });
        return { ok: false, outcome: currentReadiness, attempt_id: input.attemptId,
          failure_code: safe.current?.failure_code ?? null };
      }
    }
    throw error;
  }
  return result;
}
