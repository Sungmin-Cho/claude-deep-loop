import { resolve } from 'node:path';
import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { classifyProjectTaskDirectory, exactRawHostObservation, normalizeHostObservation,
  hostSurfaceFactsDigest, sameNativeDirectory } from './host-surface.mjs';

export { APP_PREPARE_TIMEOUT_MS, APP_CONFIRMATION_TIMEOUT_MS } from './schema.mjs';

export const DEFAULT_APP_TASK_CONTINUATION = Object.freeze({
  mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null,
});

const COMPLETE_CREATE = ['list-projects', 'create-thread-local', 'structured-process-stdin'];
const COMPLETE_FORK = [
  'fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin',
];

export function validateGenesisConsent({ runtime, route, observation, consent }) {
  const manual = consent?.mode === 'manual' && consent?.authority === 'default-manual'
    && consent.confirmed_at === null && consent.revoked_at === null;
  if (manual) return consent;
  const capabilities = new Set(observation?.capabilities ?? []);
  const complete = route === 'create'
    ? COMPLETE_CREATE.every(value => capabilities.has(value))
    : route === 'fork' && COMPLETE_FORK.every(value => capabilities.has(value));
  const auto = consent?.mode === 'auto' && consent?.authority === 'human-confirmed'
    && typeof consent.confirmed_at === 'string'
    && Number.isFinite(Date.parse(consent.confirmed_at)) && consent.revoked_at === null;
  if (!auto || runtime !== 'codex' || observation?.kind !== 'codex-app'
      || !['codex-app-host-context', 'codex-app-tool-provenance'].includes(observation.source)
      || observation.host_task_cwd_source !== 'app-task-context'
      || observation.host_task_cwd !== observation.kernel_cwd_at_observation
      || observation.observed_generation !== 1
      || !['pipe-open-noecho', 'pty-raw-noecho'].includes(observation.structured_stdin_mode)
      || !complete) throw new Error('APP_CONSENT_INVALID');
  return consent;
}

const withoutKernelAttestation = value => value == null ? null
  : Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['observed_generation', 'observed_at'].includes(key)));

const sameObservation = (left, right) => JSON.stringify(withoutKernelAttestation(left))
  === JSON.stringify(withoutKernelAttestation(right));

function assertObservedTaskDirectory(root, loop, observation, deps) {
  if (observation.kind !== 'codex-app' || observation.host_task_cwd === null) return;
  const location = classifyProjectTaskDirectory(root, observation.host_task_cwd, deps);
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
