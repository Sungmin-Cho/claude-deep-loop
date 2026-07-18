import { resolve } from 'node:path';
import { types as utilTypes } from 'node:util';
import { appendAnchored, readLines, verifyHeadLines, verifyLines } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { readState } from './state.mjs';
import { validate, verifyAppEventCorrelation } from './schema.mjs';
import { classifyProjectTaskDirectory, exactRawHostObservation, normalizeHostObservation,
  hostSurfaceFactsDigest, sameNativeDirectory } from './host-surface.mjs';

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

const withoutKernelAttestation = value => value == null ? null
  : Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['observed_generation', 'observed_at'].includes(key)));

const sameObservation = (left, right) => JSON.stringify(withoutKernelAttestation(left))
  === JSON.stringify(withoutKernelAttestation(right));

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
  try {
    appendAnchored(root, runId, { type: 'host-surface-observed', data: eventData },
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
      }, { nowFn: deps.nowFn ?? Date.now });
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
  try {
    appendAnchored(root, runId, { type: 'app-task-consent-revoked', data: eventData },
      (loop, _spent, clock) => {
        const consent = loop.autonomy.app_task_continuation;
        consent.mode = 'manual'; consent.revoked_at = clock.iso;
        const lease = loop.session_chain.lease;
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
          throw new Error('APP_TASK_FENCED');
        }
        if (appBound && exactBound.length !== 1) throw new Error('APP_TASK_FENCED');
        if (livePhases.length > 0
            && (livePhases.length !== 1 || exactBound[0] !== livePhases[0])) {
          throw new Error('APP_TASK_FENCED');
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
            throw new Error('APP_TASK_FENCED');
          }
        }
      }, { nowFn: deps.nowFn ?? Date.now });
    return { ok: true, outcome: 'revoked' };
  } catch (error) {
    if (error.message === 'APP_TASK_ALREADY_REVOKED') {
      return { ok: true, outcome: 'already-revoked' };
    }
    if (error.message === 'APP_TASK_NOT_AUTO') return { ok: true, outcome: 'not-auto' };
    throw error;
  }
}

export function statusAppTask(root, runId, { attempt = null } = {}) {
  const { data: loop } = readState(root, runId);
  const sessions = loop.session_chain.sessions.filter(session => session.continuation);
  const safe = session => ({ run_id: session.run_id,
    attempt_id: session.continuation.attempt_id, route: session.continuation.route,
    phase: session.continuation.phase,
    failure_code: session.continuation.failure_code,
    handoff_rel: `.deep-loop/runs/${session.run_id}/handoff.md` });
  const history = (attempt === null ? sessions : sessions.filter(session =>
    session.continuation.attempt_id === attempt)).map(safe);
  const lease = loop.session_chain.lease;
  const currentSession = sessions.find(session =>
    session.run_id === lease.handoff_child_run_id
    && session.continuation.attempt_id === lease.handoff_attempt_id) ?? null;
  const current = currentSession !== null
      && (attempt === null || currentSession.continuation.attempt_id === attempt)
    ? safe(currentSession) : null;
  return { ok: true, has_app_history: sessions.length > 0, logical_run_id: runId,
    generic_current: null, recovery_pending: null, current, history,
    owner_run_id: lease.owner_run_id, generation: lease.generation,
    handoff_phase: lease.handoff_phase,
    resume_policy: lease.resume_policy ?? null,
    manual_recovery: loop.status === 'paused' && lease.resume_policy === 'human' };
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
