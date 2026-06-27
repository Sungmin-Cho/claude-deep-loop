// Task 6: pauseRun two-mode + RUN_PAUSED gate tests
// Hand-built seeds (no initRun) per task hygiene — this machine has a live cmux env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeState, runDir, pauseRun } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { respawn } from '../scripts/lib/respawn.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { setWorkstreamStatus } from '../scripts/lib/workspace.mjs';
import { recordReviewOutcome } from '../scripts/lib/review.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const OWNER = 'PAUSE01';
const GEN = 1;

function baseData(overrides = {}) {
  return {
    schema_version: '0.2.0', run_id: OWNER, goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'deep-work' }, review: { points: ['design'] },
    autonomy: { tier: 'recommend', spawn_style: 'interactive' },
    budget: { unit: 'turns', spent: 0 },
    comprehension: {}, circuit_breaker: { tripped: false },
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'active', handoff_phase: 'idle',
        handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null,
      },
      sessions: [{ run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null }],
    },
    workstreams: [], active_workstreams: [],
    triage: { actionable: [] }, episodes: [], termination: {},
    ...overrides,
  };
}

function seed(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-pause-'));
  const runId = OWNER;
  mkdirSync(runDir(root, runId), { recursive: true });
  writeState(root, runId, baseData(overrides));
  return { root, runId };
}

// ── 1. pauseRun preserve mode ────────────────────────────────────────────────

test('pauseRun preserve: status=paused, lease.state stays releasing, child intact, resume_policy=human, expires_at=null', () => {
  const { root, runId } = seed({
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'releasing', handoff_phase: 'emitted',
        handoff_idempotency_key: 'abc123', handoff_child_run_id: 'CHILD01',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      sessions: [
        { run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: 'CHILD01' },
        { run_id: 'CHILD01', started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null },
      ],
      stale_lease_ttl_sec: 900,
    },
  });
  pauseRun(root, runId, { reason: 'test-pause', mode: 'preserve', expect: { owner: OWNER, generation: GEN } });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'paused');
  assert.equal(data.pause_reason, 'test-pause');
  assert.equal(data.session_chain.lease.state, 'releasing', 'preserve keeps lease.state=releasing');
  assert.equal(data.session_chain.lease.handoff_child_run_id, 'CHILD01', 'preserve keeps handoff_child_run_id');
  assert.equal(data.session_chain.lease.resume_policy, 'human');
  assert.equal(data.session_chain.lease.expires_at, null);
});

// ── 2. pauseRun rollback mode ────────────────────────────────────────────────

test('pauseRun rollback: lease back to active/idle, handoff fields cleared', () => {
  const { root, runId } = seed({
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'releasing', handoff_phase: 'emitted',
        handoff_idempotency_key: 'abc123', handoff_child_run_id: 'CHILD01',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      sessions: [
        { run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: 'CHILD01' },
        { run_id: 'CHILD01', started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null },
      ],
      stale_lease_ttl_sec: 900,
    },
  });
  pauseRun(root, runId, { reason: 'rollback-reason', mode: 'rollback', expect: { owner: OWNER, generation: GEN } });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'paused');
  assert.equal(data.pause_reason, 'rollback-reason');
  assert.equal(data.session_chain.lease.state, 'active');
  assert.equal(data.session_chain.lease.handoff_phase, 'idle');
  assert.equal(data.session_chain.lease.handoff_child_run_id, null);
  assert.equal(data.session_chain.lease.handoff_idempotency_key, null);
  assert.equal(data.session_chain.lease.expires_at, null);
});

// ── 3. pauseRun default mode (preserve) ─────────────────────────────────────

test('pauseRun default mode is preserve: paused, resume_policy=human set', () => {
  const { root, runId } = seed();
  pauseRun(root, runId, { reason: 'default-mode', expect: { owner: OWNER, generation: GEN } });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'paused');
  assert.equal(data.session_chain.lease.resume_policy, 'human');
});

// ── 4. pauseRun fenced ───────────────────────────────────────────────────────

test('pauseRun fenced: wrong generation throws LEASE_FENCED, no state change', () => {
  const { root, runId } = seed();
  assert.throws(
    () => pauseRun(root, runId, { reason: 'x', expect: { owner: OWNER, generation: 99 } }),
    /LEASE_FENCED/
  );
  assert.equal(readState(root, runId).data.status, 'running', 'status must not have changed');
});

test('pauseRun fenced: wrong owner throws LEASE_FENCED, no state change', () => {
  const { root, runId } = seed();
  assert.throws(
    () => pauseRun(root, runId, { reason: 'x', expect: { owner: 'WRONG-OWNER', generation: GEN } }),
    /LEASE_FENCED/
  );
  assert.equal(readState(root, runId).data.status, 'running', 'status must not have changed');
});

// ── 5. RUN_PAUSED gate: newEpisode blocked ───────────────────────────────────

test('RUN_PAUSED gate: newEpisode on paused run throws LEASE_FENCED RUN_PAUSED', () => {
  const { root, runId } = seed({ status: 'paused' });
  const fence = { owner: OWNER, generation: GEN, intent: 'business' };
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'design', fence }),
    /LEASE_FENCED.*RUN_PAUSED|RUN_PAUSED/
  );
  // No episode created
  assert.equal(readState(root, runId).data.episodes.length, 0);
});

// ── 6. RUN_PAUSED gate: setWorkstreamStatus blocked ─────────────────────────

test('RUN_PAUSED gate: setWorkstreamStatus on paused run throws LEASE_FENCED RUN_PAUSED', () => {
  const { root, runId } = seed({
    status: 'paused',
    workstreams: [{ id: 'ws-01-test', status: 'planned', depends_on: [], title: 'T',
      branch: 'b', worktree: 'w', base_commit: null, dirty_on_handoff: false,
      pr: { intended: true, state: 'none', url: null }, episodes: [], review_points_done: [] }],
  });
  const fence = { owner: OWNER, generation: GEN, intent: 'business' };
  assert.throws(
    () => setWorkstreamStatus(root, runId, 'ws-01-test', 'in_progress', { fence }),
    /LEASE_FENCED.*RUN_PAUSED|RUN_PAUSED/
  );
  // Status must not have changed
  assert.equal(readState(root, runId).data.workstreams[0].status, 'planned');
});

// ── 7. RUN_PAUSED gate: recordReviewOutcome blocked ─────────────────────────

test('RUN_PAUSED gate: recordReviewOutcome on paused run throws LEASE_FENCED RUN_PAUSED', () => {
  const { root, runId } = seed({
    status: 'paused',
    workstreams: [{ id: 'ws-01-test', status: 'in_progress', depends_on: [], title: 'T',
      branch: 'b', worktree: 'w', base_commit: null, dirty_on_handoff: false,
      pr: { intended: true, state: 'none', url: null }, episodes: [], review_points_done: [] }],
    episodes: [
      { id: '001-maker', plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'design',
        workstream_id: 'ws-01-test', status: 'done', request_path: '/x/r.md', expected_artifacts: [],
        verification: { checker_episode_required: true, checker_plugin: 'deep-review', review_point: 'design', proof_required: [] } },
      { id: '002-checker', plugin: 'deep-review', role: 'checker', kind: 'design-review', point: 'design',
        workstream_id: 'ws-01-test', status: 'pending', target_maker: '001-maker', request_path: '/x/r2.md', expected_artifacts: [],
        verification: { checker_episode_required: false, checker_plugin: 'deep-review', review_point: 'design', proof_required: [] } },
    ],
  });
  const fence = { owner: OWNER, generation: GEN, intent: 'business' };
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: '002-checker', workstreamId: 'ws-01-test', point: 'design', verdict: 'APPROVE', fence }),
    /LEASE_FENCED.*RUN_PAUSED|RUN_PAUSED/
  );
  // Checker episode must still be pending
  assert.equal(readState(root, runId).data.episodes[1].status, 'pending');
});

// ── 8. RUN_PAUSED gate: emitHandoff blocked ──────────────────────────────────

test('RUN_PAUSED gate: emitHandoff on paused run returns {ok:false, reason:RUN_PAUSED}', () => {
  const { root, runId } = seed({ status: 'paused' });
  const result = emitHandoff(root, runId, { expect: { owner: OWNER, generation: GEN } });
  assert.equal(result.ok, false, 'emitHandoff must fail on paused run');
  assert.match(result.reason, /RUN_PAUSED/);
  // lease phase must not have changed from idle
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
});

// ── 9. RUN_PAUSED gate: respawn blocked ──────────────────────────────────────

test('RUN_PAUSED gate: respawn on paused run returns {ok:false}', () => {
  // seed with emitted handoff + status paused + consistent budget (spent=0, no cost events)
  const { root, runId } = seed({
    status: 'paused',
    budget: { unit: 'turns', spent: 0, tokens_spent: 0, total: 100, hard_stop_ratio: 0.9, soft_stop_ratio: 0.8 },
    autonomy: { tier: 'recommend', spawn_style: 'headless', auto_handoff: true, max_sessions: 10 },
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'releasing', handoff_phase: 'emitted',
        handoff_idempotency_key: 'k123', handoff_child_run_id: 'CHILD01',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      sessions: [
        { run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: 'CHILD01' },
        { run_id: 'CHILD01', started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null, handoff_rel: 'handoffs/h.md' },
      ],
      stale_lease_ttl_sec: 900,
    },
  });
  const result = respawn(root, runId, { childRunId: 'CHILD01', key: 'k123', handoffRel: 'handoffs/h.md', spawnFn: () => ({ ok: true }) });
  assert.equal(result.ok, false, 'respawn must fail on paused run');
  assert.match(result.reason, /RUN_PAUSED|paused/i);
  // handoff phase must not have advanced to 'spawned'
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

// ── 10. pause CLI: success exits 0 ───────────────────────────────────────────

test('pause CLI: success exits 0, run is paused', () => {
  const { root, runId } = seed();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
  execFileSync('node', [CLI, 'pause', '--owner', OWNER, '--generation', String(GEN), '--reason', 'test-cli-pause', '--project-root', root], { encoding: 'utf8' });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'paused');
  assert.equal(data.pause_reason, 'test-cli-pause');
});

// ── 11. pause CLI: wrong generation exits 3 ──────────────────────────────────

test('pause CLI: wrong generation exits 3, status unchanged', () => {
  const { root, runId } = seed();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'pause', '--owner', OWNER, '--generation', '99', '--reason', 'x', '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 3, 'wrong generation must exit 3');
  assert.equal(readState(root, runId).data.status, 'running', 'status must be unchanged');
});

// ── 12. pause CLI: missing --reason exits 2 ──────────────────────────────────

test('pause CLI: missing --reason exits 2', () => {
  const { root, runId } = seed();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'pause', '--owner', OWNER, '--generation', String(GEN), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 2, 'missing --reason must exit 2');
});

// ── 13. run-paused event in log ───────────────────────────────────────────────

test('pauseRun appends run-paused event to event log', () => {
  const { root, runId } = seed();
  pauseRun(root, runId, { reason: 'event-log-check', expect: { owner: OWNER, generation: GEN } });
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const events = require_log(logPath);
  assert.ok(events.length >= 1, 'at least one event must be in log');
  const paused = events.find(e => e.type === 'run-paused');
  assert.ok(paused, 'run-paused event must be in log');
  assert.equal(paused.data.reason, 'event-log-check');
});

// ── helpers ────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
function require_log(path) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}
