import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIdSlug } from './slug.mjs';
import { matchRecipe } from './recipes.mjs';
import { writeState, runDir } from './state.mjs';
import { ulid } from './envelope.mjs';
import { detectTerminal, defaultProbeRun } from './detect-terminal.mjs';
import { pluginPresent } from './detect.mjs';

export function buildInitialLoop({ goal, protocol, recipe, detected = {}, review, now = new Date(), runId, git = {}, env = process.env, platform = process.platform, run = defaultProbeRun, pid = process.pid }) {
  const iso = now.toISOString();
  return {
    schema_version: '0.2.0', run_id: runId, goal, status: 'running',
    created_at: iso, updated_at: iso,
    project: { root: '', git: !!git.head, branch: git.branch || null, head: git.head || null, dirty: !!git.dirty },
    routing: { protocol, selected_by: 'auto' },
    recipe,
    plugins_detected: detected,
    loop_principles: { heartbeat: 'manual-v1', state_is_source_of_truth: true, maker_checker_split: true, human_review_required: true, worktree_isolation_policy: 'recommend' },
    review: review || { points: ['design', 'plan', 'implementation'], reviewer: pluginPresent(detected, 'deep-review') ? 'deep-review-loop' : 'subagent-checker', mode: 'cross-model', flags: ['--contract', '--codex'], converge: true, max_review_rounds: 5, require_human_ack: false },
    autonomy: { driver: 'continue', tier: 'recommend', auto_handoff: true, spawn_style: 'visible', max_unreviewed_episodes: 3, max_parallel: 2, max_sessions: 8, milestone_predicate: ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached'], recipe_override_auth: 'user-only', unattended_detect: ['driver:cron|loop', '--unattended', 'headless-invocation'], child_ready_timeout_sec: 75 },
    budget: { unit: 'turns', total: 200, spent: 0, tokens_total: 4000000, tokens_spent: 0, per_session_turn_cap: 40, max_wallclock_sec: 86400, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0, enforcement: 'best-effort-interactive', unattended_requires_headless: true, on_unmeasurable_usage: 'fail-closed', on_exhaust: 'pause-and-handoff' },
    comprehension: { episodes_total: 0, episodes_human_reviewed: 0, unreviewed_diff_lines: 0, debt_ratio: 0, debt_threshold: 0.5 },
    circuit_breaker: { consecutive_request_changes: 0, tripped: false, trip_reason: null },
    event_log_head: { seq: 0, checksum: 'GENESIS' },
    session_chain: { parent_run_id: null, lease: { owner_run_id: runId, generation: 1, acquired_at: iso, expires_at: null, state: 'active', handoff_idempotency_key: null, handoff_phase: 'idle' }, stale_lease_ttl_sec: 900, sessions: [{ run_id: runId, started_at: iso, ended_at: null, turns: 0, outcome: null, superseded_by: null }] },
    session_spawn: detectTerminal({ env, platform, run, now: iso, pid }),
    workspace_policy: 'recommend',
    workstreams: [], active_workstreams: [],
    discovered_items: [], triage: { actionable: [], needs_human: [], blocked: [], archived: [] },
    episodes: [], current_episode: null,
    connectors: { enabled: [], pre_authorized: [] },
    termination: { max_episodes_policy: 'derived', max_episodes: 24, proofs: ['implementation artifacts exist', 'independent review verdict approve or accepted concern', 'final report exists', 'human verification checklist written'] },
  };
}

export function initRun(root, { goal, protocol, recipe, review, detected = {}, now = new Date(), git = {}, env = process.env, platform = process.platform, run = defaultProbeRun, pid = process.pid }) {
  const runId = ulid(now.getTime());
  const m = matchRecipe(goal, detected);
  const proto = protocol || m.protocol;
  const rec = recipe ? { id: recipe, name: recipe, reason: 'user' } : { id: m.recipe, name: m.recipe, reason: m.reason };
  const loop = buildInitialLoop({ goal, protocol: proto, recipe: rec, detected, review, now, runId, git, env, platform, run, pid });
  loop.project.root = root;
  mkdirSync(runDir(root, runId), { recursive: true });
  writeState(root, runId, loop);
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId + '\n');
  return { runId, loop };
}
