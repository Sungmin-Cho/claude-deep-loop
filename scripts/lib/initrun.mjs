import { existsSync, realpathSync, statSync } from 'node:fs';
import { runIdSlug } from './slug.mjs';
import { matchRecipe } from './recipes.mjs';
import { readState } from './state.mjs';
import { ulid } from './envelope.mjs';
import { detectTerminal, defaultProbeRun } from './detect-terminal.mjs';
import { pluginPresent } from './detect.mjs';
import { validateModel, validateEffort } from './session-profile.mjs';
import { validateSessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { DEFAULT_APP_TASK_CONTINUATION, validateGenesisConsent } from './app-task-continuation.mjs';
import { commitPreparedInit, hostObservationDigest,
  prepareInitialization } from './init-transaction.mjs';
import { classifyProjectTaskDirectory, normalizeHostObservation,
  sameNativeDirectory } from './host-surface.mjs';

export function resolveInitialReview(review, detected = {}) {
  if (review?.reviewer === 'standalone') throw new Error('REVIEWER_STANDALONE_INVALID: standalone reviewer is supported only for legacy-state resolution');
  return review ?? { points: ['design', 'plan', 'implementation'],
    reviewer: pluginPresent(detected, 'deep-review') ? 'deep-review-loop' : 'subagent-checker',
    mode: 'cross-model', flags: ['--contract', '--codex'], converge: true,
    max_review_rounds: 5, require_human_ack: true };
}

export function buildInitialLoop({ runtime, goal, protocol, recipe, detected = {}, review,
  now = new Date(), runId, git = {}, env = process.env, platform = process.platform,
  run = defaultProbeRun, pid = process.pid, model = null, effort = null,
  initialization, hostObservation = null, appContinuationConsent = null,
  appContinuationRoute = null, sessionSpawn = undefined, projectRoot = '' }) {
  validateSessionRuntime(runtime);
  const resolvedReview = resolveInitialReview(review, detected);
  const consent = appContinuationConsent == null
    ? { ...DEFAULT_APP_TASK_CONTINUATION }
    : appContinuationConsent;
  const validatedConsent = validateGenesisConsent({
    runtime, route: appContinuationRoute, observation: hostObservation, consent,
  });
  const iso = now.toISOString();
  const loop = {
    schema_version: '0.2.0', run_id: runId, goal, status: 'running',
    created_at: iso, updated_at: iso,
    project: { root: projectRoot, git: !!git.head, branch: git.branch || null, head: git.head || null, dirty: !!git.dirty },
    routing: { protocol, selected_by: 'auto' },
    recipe,
    plugins_detected: detected,
    loop_principles: { heartbeat: 'manual-v1', state_is_source_of_truth: true, maker_checker_split: true, human_review_required: true, worktree_isolation_policy: 'recommend' },
    review: structuredClone(resolvedReview),
    autonomy: { driver: 'continue', tier: 'recommend', auto_handoff: true, spawn_style: 'visible', max_unreviewed_episodes: 3, max_parallel: 2, max_sessions: 8, milestone_predicate: ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached'], recipe_override_auth: 'user-only', unattended_detect: ['driver:cron|loop', '--unattended', 'headless-invocation'], child_ready_timeout_sec: 75, session_runtime: runtime, runtime_source: 'skill-asserted', runtime_executable_approval: null, launcher_executable_approvals: { wt: null, powershell: null }, ...(model != null ? { session_model: model } : {}), ...(effort != null ? { session_effort: effort } : {}) },
    budget: { unit: 'turns', total: 200, spent: 0, tokens_total: 4000000, tokens_spent: 0, per_session_turn_cap: 40, max_wallclock_sec: 86400, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0, enforcement: 'best-effort-interactive', unattended_requires_headless: true, on_unmeasurable_usage: 'fail-closed', on_exhaust: 'pause-and-handoff' },
    comprehension: { episodes_total: 0, episodes_human_reviewed: 0, episodes_agent_reviewed: 0, unreviewed_diff_lines: 0, debt_ratio: 0, debt_threshold: 0.5 },
    circuit_breaker: { consecutive_request_changes: 0, tripped: false, trip_reason: null },
    event_log_head: { seq: 0, checksum: 'GENESIS' },
    session_chain: { parent_run_id: null, lease: { owner_run_id: runId, generation: 1, acquired_at: iso, expires_at: null, state: 'active', handoff_idempotency_key: null, handoff_phase: 'idle' }, stale_lease_ttl_sec: 900, sessions: [{ run_id: runId, started_at: iso, ended_at: null, turns: 0, outcome: null, superseded_by: null }] },
    session_spawn: sessionSpawn === undefined
      ? detectTerminal({ env, platform, run, now: iso, pid })
      : structuredClone(sessionSpawn),
    workspace_policy: 'recommend',
    workstreams: [], active_workstreams: [],
    discovered_items: [], triage: { actionable: [], needs_human: [], blocked: [], archived: [] },
    episodes: [], current_episode: null,
    connectors: { enabled: [], pre_authorized: [] },
    termination: { max_episodes_policy: 'derived', max_episodes: 24, proofs: ['implementation artifacts exist', 'independent review verdict approve or accepted concern', 'final report exists', 'human verification checklist written'] },
  };
  loop.autonomy.app_task_continuation = structuredClone(validatedConsent);
  loop.session_chain.lease.handoff_transport = null;
  loop.session_chain.lease.handoff_attempt_id = null;
  loop.session_chain.lease.resume_policy ??= null;
  loop.session_chain.sessions[0].host_surface = hostObservation == null
    ? null : structuredClone(hostObservation);
  if (initialization !== undefined) loop.initialization = structuredClone(initialization);
  return loop;
}

const DEFAULT_INIT_CONSENT = Object.freeze({ mode: 'manual', authority: 'default-manual' });

function initialRouteEligibility(root, actualCwd, observation, native) {
  if (observation?.kind !== 'codex-app') {
    return { eligible: false, reason: 'surface-ineligible', route: null };
  }
  const location = classifyProjectTaskDirectory(root, actualCwd, native);
  if (location === null) return { eligible: false, reason: 'cwd-mismatch', route: null };
  const capabilities = new Set(observation.capabilities);
  const required = location.kind === 'root'
    ? ['list-projects', 'create-thread-local', 'structured-process-stdin']
    : ['fork-thread-same-directory', 'send-message-to-thread', 'structured-process-stdin'];
  if (!required.every(value => capabilities.has(value))) {
    return { eligible: false, reason: 'capability-incomplete', route: null };
  }
  return { eligible: true, reason: 'eligible',
    route: { kind: location.kind === 'root' ? 'create' : 'fork' } };
}

function nativeInitObservationDeps(kernelCwd, platform) {
  return { kernelCwd, platform, exists: existsSync,
    realpath: value => (realpathSync.native || realpathSync)(value),
    stat: value => statSync(value, { bigint: true }),
    sameFile: (left, right) => left.dev === right.dev && left.ino === right.ino };
}

function nativePidIdentity({ pid }) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error?.code === 'ESRCH' ? 'definitely-dead' : 'unknown'; }
}

export function productionInitDeps(root, request, overrides = {}) {
  const actualCwd = (overrides.cwdFn ?? process.cwd)();
  const native = nativeInitObservationDeps(actualCwd, overrides.platform ?? process.platform);
  return { canonicalRoot: canonicalProjectRoot,
    resolveRouting: value => ({ protocol: value.protocol, recipe: value.recipe }),
    resolveReview: value => resolveInitialReview(value.review, value.detected ?? {}),
    normalizePlugins: value => structuredClone(value),
    normalizeGit: value => ({ git: !!value.head, head: value.head ?? null,
      branch: value.branch ?? null, dirty: !!value.dirty }),
    normalizeSessionSpawn: value => structuredClone(value),
    normalizeEnumProfile: value => {
      const normalized = normalizeHostObservation({ runtime: request.runtime,
        kind: value.kind, source: value.source, capabilities: value.capabilities,
        structured_stdin_mode: null, host_task_cwd: null,
        host_task_cwd_source: null, observed_at: null }, native);
      return normalized.kind === null ? null
        : { kind: normalized.kind, source: normalized.source,
          capabilities: normalized.capabilities };
    },
    normalizeObservation: value => normalizeHostObservation(value, native),
    assertInitializationAuthority: (candidateRoot, observation) => {
      if (classifyProjectTaskDirectory(candidateRoot, actualCwd, native) === null
          || !sameNativeDirectory(observation.host_task_cwd, actualCwd, native)
          || !sameNativeDirectory(observation.kernel_cwd_at_observation, actualCwd, native)) {
        throw new Error('INIT_CWD_MISMATCH');
      }
    },
    kernelCwd: () => native.realpath(actualCwd), probePidIdentity: nativePidIdentity,
    eligible: observation => initialRouteEligibility(root, actualCwd, observation, native),
    classifyObservationRoute: observation =>
      initialRouteEligibility(root, actualCwd, observation, native).route?.kind ?? null,
    buildLoop: buildInitialLoop, ...overrides };
}

export function initRun(root, options) {
  const { runtime, goal, protocol, recipe, review, detected = {}, now = new Date(),
    git = {}, env = process.env, platform = process.platform, run = defaultProbeRun,
    pid = process.pid, model = null, effort = null, cwdFn = process.cwd } = options;
  validateSessionRuntime(runtime);
  if (model != null) validateModel(model);
  if (effort != null) validateEffort(effort);
  const canonicalRoot = canonicalProjectRoot(root);
  const match = matchRecipe(goal, detected);
  const resolvedProtocol = protocol || match.protocol;
  const resolvedRecipe = recipe
    ? { id: recipe, name: recipe, reason: 'user' }
    : { id: match.recipe, name: match.recipe, reason: match.reason };
  const actualCwd = cwdFn();
  const native = nativeInitObservationDeps(actualCwd, platform);
  const observation = options.hostObservation == null ? null
    : normalizeHostObservation({ ...options.hostObservation, runtime }, native);
  const request = { runtime, goal, protocol: resolvedProtocol, recipe: resolvedRecipe,
    review: review ?? null, detected, git, model, effort,
    sessionSpawn: detectTerminal({ env, platform, run, now: now.toISOString(), pid }),
    consent: options.appContinuationConsent ?? DEFAULT_INIT_CONSENT,
    observationDigest: hostObservationDigest(observation),
    enumProfile: observation === null
      ? runtime === 'codex'
        ? { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] }
        : { kind: 'claude-code', source: 'claude-cli-entrypoint', capabilities: [] }
      : null };
  const deps = productionInitDeps(canonicalRoot, request, {
    platform, cwdFn: () => actualCwd, ulid: () => ulid(now.getTime()), pid,
  });
  const prepared = prepareInitialization(canonicalRoot, request, deps);
  const committed = commitPreparedInit(canonicalRoot, {
    prepared, request, observation,
  }, deps);
  const { data: loop } = readState(canonicalRoot, committed.run_id);
  return { runId: committed.run_id, loop };
}
