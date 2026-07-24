// Task 7: recoverRun + recover CLI — TDD RED→GREEN
// Recover is the human-approved "unstick-for-resume" escape hatch for a preserve-paused or gate-blocked run.
// Hand-built seeds (no initRun) — live cmux env on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pauseRun, readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { recoverRun } from '../scripts/lib/recover.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const OWNER = 'RECOVER01';
const CHILD = 'CHILD01';
const GEN = 2;

function legacyScope() {
  return {
    kind: 'legacy', workstream_id: null, bound_at_seq: null,
    terminal_event: null, closed_at: null,
  };
}

function baseData(overrides = {}) {
  return {
    schema_version: '0.4.0', run_id: OWNER, goal: 'g', status: 'paused',
    pause_reason: 'preserve-handoff',
    project: { binding_generation: 1 }, routing: { protocol: 'deep-work' }, review: { points: ['design'] },
    autonomy: {
      tier: 'recommend', spawn_style: 'interactive', continuation_policy: 'rotate-per-unit',
      attended_launch_approval: null,
      session_runtime: 'claude', runtime_source: 'skill-asserted',
    },
    budget: { unit: 'turns', spent: 0 },
    comprehension: {}, circuit_breaker: { tripped: false },
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'releasing', handoff_phase: 'emitted',
        handoff_idempotency_key: 'key123', handoff_child_run_id: CHILD,
        expires_at: null, resume_policy: 'human', handoff_trigger: 'milestone',
        takeover_kind: null,
      },
      consumed_milestones: [],
      sessions: [
        { run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: CHILD, scope: legacyScope() },
        { run_id: CHILD, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null, scope: legacyScope() },
      ],
      stale_lease_ttl_sec: 900,
    },
    workstreams: [], active_workstreams: [],
    triage: { actionable: [] }, episodes: [], termination: {},
    ...overrides,
  };
}

function seed(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-recover-'));
  const runId = OWNER;
  mkdirSync(runDir(root, runId), { recursive: true });
  const data = baseData(overrides);
  data.project.root = root;
  writeState(root, runId, data);
  return { root, runId };
}

function requireLog(root, runId) {
  const p = join(runDir(root, runId), 'event-log.jsonl');
  try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

// ── 1. confirm required ───────────────────────────────────────────────────────

test('recoverRun: throws CONFIRM_REQUIRED if confirm is not true', () => {
  const { root, runId } = seed();
  assert.throws(
    () => recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN }, confirm: false }),
    /CONFIRM_REQUIRED/
  );
  assert.equal(readState(root, runId).data.status, 'paused', 'status must not change');
});

test('recoverRun: throws CONFIRM_REQUIRED if confirm is omitted', () => {
  const { root, runId } = seed();
  assert.throws(
    () => recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN } }),
    /CONFIRM_REQUIRED/
  );
});

// ── 2. happy path: preserve-paused run ───────────────────────────────────────

test('recoverRun: preserve-paused run → lease.state=released, handoff fields cleared, status stays paused', () => {
  const { root, runId } = seed();
  recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN }, confirm: true });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'paused', 'status must STAY paused after recover (Task 8 unpauses on acquireLease)');
  assert.equal(data.pause_reason, 'recovered:awaiting-resume');
  assert.equal(data.session_chain.lease.state, 'released');
  assert.equal(data.session_chain.lease.handoff_phase, 'idle');
  assert.equal(data.session_chain.lease.handoff_child_run_id, null);
  assert.equal(data.session_chain.lease.handoff_idempotency_key, null);
  assert.equal(data.session_chain.lease.handoff_trigger, null);
  assert.equal(data.session_chain.lease.expires_at, null);
  assert.equal(data.session_chain.lease.resume_policy, null);
});

test('recoverRun reconciles a prepared candidate before applying recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-recover-current-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'OLD-GOAL', now: new Date('2026-07-23T00:00:00.000Z'),
  });
  pauseRun(root, runId, {
    reason: 'test-recovery', expect: { owner: runId, generation: 1 }, now: Date.parse('2026-07-23T00:30:00.000Z'),
  });
  const legacy = readState(root, runId).data;
  legacy.autonomy.continuation_policy = 'rotate-per-unit';
  legacy.session_chain.sessions[0].scope = legacyScope();
  writeState(root, runId, legacy);
  assert.throws(() => appendAnchored(
    root,
    runId,
    { type: 'recover-late-state', data: {}, now: '2026-07-23T01:00:00.000Z' },
    loop => { loop.goal = 'NEW-GOAL'; },
    undefined,
    {
      publication: {
        kind: 'recover-late-state', operationId: 'recover-late-state', artifacts: [], topology: {},
        faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('barrier'); },
      },
    },
  ), /TRANSACTION_PENDING/);
  recoverRun(root, runId, { expect: { owner: runId, generation: 1 }, confirm: true });
  const { data } = readState(root, runId);
  assert.equal(data.goal, 'NEW-GOAL');
  assert.equal(data.pause_reason, 'recovered:awaiting-resume');
});

test('recoverRun: abandoned child outcome + parent superseded_by cleared', () => {
  const { root, runId } = seed();
  recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN }, confirm: true });
  const { data } = readState(root, runId);
  const child = data.session_chain.sessions.find(s => s.run_id === CHILD);
  assert.ok(child, 'child session must exist');
  assert.equal(child.outcome, 'abandoned_recover', 'child session outcome must be abandoned_recover');
  const parent = data.session_chain.sessions.find(s => s.run_id === OWNER);
  assert.equal(parent.superseded_by, null, 'parent superseded_by must be nulled');
});

test('recoverRun: run-recovered event appended to event log', () => {
  const { root, runId } = seed();
  recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN }, confirm: true });
  const events = requireLog(root, runId);
  const recovered = events.find(e => e.type === 'run-recovered');
  assert.ok(recovered, 'run-recovered event must be in log');
});

// ── 3. negative: not recoverable on running/completed/stopped ─────────────────

test('recoverRun: throws NOT_RECOVERABLE on running run', () => {
  const { root, runId } = seed({ status: 'running', pause_reason: undefined,
    session_chain: {
      lease: { owner_run_id: OWNER, generation: GEN, state: 'active', handoff_phase: 'idle',
        handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null, takeover_kind: null },
      sessions: [{ run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null, scope: legacyScope() }],
      stale_lease_ttl_sec: 900,
    }
  });
  assert.throws(
    () => recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN }, confirm: true }),
    /NOT_RECOVERABLE/
  );
  assert.equal(readState(root, runId).data.status, 'running');
});

test('recoverRun: throws NOT_RECOVERABLE on completed run', () => {
  const { root, runId } = seed({ status: 'completed', pause_reason: undefined,
    session_chain: {
      lease: { owner_run_id: OWNER, generation: GEN, state: 'released', handoff_phase: 'idle',
        handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null, takeover_kind: null },
      sessions: [{ run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null, scope: legacyScope() }],
      stale_lease_ttl_sec: 900,
    }
  });
  assert.throws(
    () => recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN }, confirm: true }),
    /NOT_RECOVERABLE/
  );
});

// ── 4. fence: wrong owner/generation ─────────────────────────────────────────

test('recoverRun: wrong generation → LEASE_FENCED', () => {
  const { root, runId } = seed();
  assert.throws(
    () => recoverRun(root, runId, { expect: { owner: OWNER, generation: 99 }, confirm: true }),
    /LEASE_FENCED/
  );
  assert.equal(readState(root, runId).data.status, 'paused', 'state must not change on fence');
});

test('recoverRun: wrong owner → LEASE_FENCED', () => {
  const { root, runId } = seed();
  assert.throws(
    () => recoverRun(root, runId, { expect: { owner: 'WRONG', generation: GEN }, confirm: true }),
    /LEASE_FENCED/
  );
});

// ── 5. child with existing outcome not overwritten ────────────────────────────

test('recoverRun: child with existing outcome is not overwritten', () => {
  const { root, runId } = seed({
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'releasing', handoff_phase: 'emitted',
        handoff_idempotency_key: 'key123', handoff_child_run_id: CHILD,
        expires_at: null, resume_policy: 'human',
        takeover_kind: null,
      },
      sessions: [
        { run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: CHILD, scope: legacyScope() },
        { run_id: CHILD, started_at: null, ended_at: null, turns: 0, outcome: 'took_over', superseded_by: null, scope: legacyScope() },
      ],
      stale_lease_ttl_sec: 900,
    },
  });
  recoverRun(root, runId, { expect: { owner: OWNER, generation: GEN }, confirm: true });
  const { data } = readState(root, runId);
  const child = data.session_chain.sessions.find(s => s.run_id === CHILD);
  assert.equal(child.outcome, 'took_over', 'existing child outcome must not be overwritten');
});

// ── 6. CLI: --confirm required ────────────────────────────────────────────────

test('CLI recover: missing --confirm exits non-zero', () => {
  const { root, runId } = seed();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'recover', '--owner', OWNER, '--generation', String(GEN), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.notEqual(code, 0, 'missing --confirm must exit non-zero');
  assert.equal(readState(root, runId).data.status, 'paused', 'state must not change');
});

// ── 7. CLI: success exits 0 ──────────────────────────────────────────────────

test('CLI recover: --confirm exits 0, lease.state=released, status=paused', () => {
  const { root, runId } = seed();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
  execFileSync('node', [CLI, 'recover', '--owner', OWNER, '--generation', String(GEN), '--confirm', '--project-root', root], { encoding: 'utf8' });
  const { data } = readState(root, runId);
  assert.equal(data.status, 'paused');
  assert.equal(data.session_chain.lease.state, 'released');
  assert.equal(data.pause_reason, 'recovered:awaiting-resume');
});

// ── 8. CLI: wrong generation exits 3 ─────────────────────────────────────────

test('CLI recover: wrong generation exits 3', () => {
  const { root, runId } = seed();
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'recover', '--owner', OWNER, '--generation', '99', '--confirm', '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 3, 'wrong generation must exit 3');
  assert.equal(readState(root, runId).data.status, 'paused');
});
