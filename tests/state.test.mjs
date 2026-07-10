import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync as _rfRoot } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname as _dn } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, writeState, patch, withLock, runDir, findRoot } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const runId = 'R1';
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
  const data = {
    schema_version: '0.2.0', run_id: runId, goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'deep-work' }, review: { points: ['design'] },
    autonomy: { tier: 'recommend', spawn_style: 'interactive' }, budget: { unit: 'turns', spent: 5 },
    comprehension: {}, circuit_breaker: { tripped: false }, session_chain: { lease: { state: 'active', handoff_phase: 'idle' }, sessions: [] },
    workstreams: [{ id: 'ws-1', status: 'in_progress', depends_on: [] }], active_workstreams: ['ws-1'],
    triage: { actionable: [] }, episodes: [{ id: 'e1', status: 'pending' }], termination: {},
  };
  writeState(root, runId, data);
  return { root, runId };
}

test('read after write roundtrips', () => {
  const { root, runId } = seed();
  assert.equal(readState(root, runId).data.goal, 'g');
});

test('patch allowed field succeeds', () => {
  const { root, runId } = seed();
  patch(root, runId, 'triage.actionable', [{ id: 'x' }]);
  assert.equal(readState(root, runId).data.triage.actionable.length, 1);
});

test('patch forbidden field (budget.spent) throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'budget.spent', 0), /FIELD_FORBIDDEN/);
});

test('patch forbidden review.* throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'review.points', []), /FIELD_FORBIDDEN/);
});

// impl-R2 Fix 3: a whitelisted field with a schema-INVALID value (active_workstreams := non-array) must be rejected
// BEFORE the event append — otherwise appendEvent commits, writeState's validate throws, and the event-log tail
// out-runs the loop.json anchor → every later write bricks with LOG_TAMPERED.
test('patch pre-validates the candidate: an invalid whitelisted value throws without staling the anchor', () => {
  const { root, runId } = seed();
  const before = readState(root, runId).data.budget.spent;
  assert.throws(() => patch(root, runId, 'active_workstreams', 'bad'), /SCHEMA_INVALID/);
  assert.equal(readState(root, runId).data.budget.spent, before, 'a rejected patch must not charge the floor');
  // No brick: a subsequent valid patch still succeeds (would throw LOG_TAMPERED if the tail had advanced past the anchor).
  assert.doesNotThrow(() => patch(root, runId, 'triage.actionable', [{ id: 'x' }]));
  assert.equal(readState(root, runId).data.triage.actionable.length, 1);
});

test('tampered hash detected on read', () => {
  const { root, runId } = seed();
  writeFileSync(join(runDir(root, runId), 'loop.json'), '{"goal":"hacked"}'); // direct write, hash unchanged
  assert.throws(() => readState(root, runId), /STATE_TAMPERED/);
});

test('whole-object array patch bypass is forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0', { status: 'done' }), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.0', { status: 'merged' }), /FIELD_FORBIDDEN/);
});

test('terminal status value via dotted path is forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.status', 'done'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.0.status', 'merged'), /FIELD_FORBIDDEN/);
});

test('non-terminal status + depends_on allowed', () => {
  const { root, runId } = seed();
  patch(root, runId, 'episodes.0.status', 'in_progress');
  patch(root, runId, 'workstreams.0.depends_on', ['ws-2']);
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
  assert.deepEqual(readState(root, runId).data.workstreams[0].depends_on, ['ws-2']);
});

test('non-status workstream field (title) forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'workstreams.0.title', 'x'), /FIELD_FORBIDDEN/);
});

test('episode result sub-path / lookalike forbidden, only result_* allowed', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.result.status', 'x'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'episodes.0.resultEvil', 'x'), /FIELD_FORBIDDEN/);
  patch(root, runId, 'episodes.0.result_summary', 'ok'); // allowed
  assert.equal(readState(root, runId).data.episodes[0].result_summary, 'ok');
});

test('missing hash anchor fails closed', () => {
  const { root, runId } = seed();
  rmSync(join(runDir(root, runId), '.loop.hash'));
  assert.throws(() => readState(root, runId), /STATE_TAMPERED/);
});

test('prototype-pollution field path forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.__proto__', { x: 1 }), /FIELD_FORBIDDEN/);
});

test('stale lock is reclaimed after TTL', () => {
  const { root, runId } = seed();
  const lock = join(runDir(root, runId), '.lock');
  mkdirSync(lock);                               // simulate dead-process lock
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);                    // 60s old > 30s TTL
  let ran = false;
  withLock(root, runId, () => { ran = true; }, { ttlMs: 30000, retries: 5, backoffMs: 1 });
  assert.equal(ran, true);
});

// Codex impl r12 🔴: runId must be a safe single path segment — a '../' (or slash) runId would let runDir
// resolve outside the project root and every state/event/episode/handoff writer would escape.
test('runDir rejects unsafe run-id path segments', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  for (const bad of ['../evil', '..', '.', 'a/b', 'a\\b', '', null]) {
    assert.throws(() => runDir(root, bad), /RUN_ID_INVALID/, `runId ${JSON.stringify(bad)} should be rejected`);
  }
  // a normal ULID-ish id is accepted
  assert.ok(runDir(root, '01KVWFJA0QKSCMN8XMQ0WJXBBC').endsWith('01KVWFJA0QKSCMN8XMQ0WJXBBC'));
});

test('patch enforces fence inside the lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pf-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  patch(root, runId, 'discovered_items', ['a'], { fence: { owner: runId, generation: 1, intent: 'business' } });
  assert.deepEqual(readState(root, runId).data.discovered_items, ['a']);
  assert.throws(() => patch(root, runId, 'discovered_items', ['b'], { fence: { owner: runId, generation: 9, intent: 'business' } }), /LEASE_FENCED/);
  // forbidden field 는 fence 와 무관하게 거부
  assert.throws(() => patch(root, runId, 'budget.spent', 1, { fence: { owner: runId, generation: 1, intent: 'business' } }), /FIELD_FORBIDDEN/);
});

test('patch: cannot set episode status to abandoned (classifyPatch forbids)', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.status', 'abandoned'), /FIELD_FORBIDDEN/);
});

test('patch: cannot resurrect a terminal episode to non-terminal via patch', () => {
  const { root, runId } = seed();
  const data = readState(root, runId).data;
  data.episodes[0].status = 'abandoned';
  writeState(root, runId, data);
  assert.throws(() => patch(root, runId, 'episodes.0.status', 'pending'), /FIELD_FORBIDDEN/);
});

test('patch: out-of-range index rejected for all indexed sub-fields (no phantom item)', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.5.status', 'in_progress'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'episodes.5.result_summary', 'x'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.9.status', 'in_progress'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.9.depends_on', ['x']), /FIELD_FORBIDDEN/);
});

test('patch: non-canonical (leading-zero) index rejected on both arrays', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.01.status', 'in_progress'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.01.depends_on', ['x']), /FIELD_FORBIDDEN/);
});

test('patch: non-terminal workstream status allowed; terminal workstream resurrection rejected', () => {
  const { root, runId } = seed();   // workstreams[0]=ws-1, status in_progress
  patch(root, runId, 'workstreams.0.status', 'in_progress');                 // non-terminal → allowed
  assert.equal(readState(root, runId).data.workstreams[0].status, 'in_progress');
  const data = readState(root, runId).data; data.workstreams[0].status = 'ready'; writeState(root, runId, data);  // fix terminal
  assert.throws(() => patch(root, runId, 'workstreams.0.status', 'in_progress'), /FIELD_FORBIDDEN/);   // resurrection rejected
});

test('findRoot: from .claude/worktrees/<slug> resolves to main root (bounded)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fr-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), 'run-x');
  const wt = join(root, '.claude', 'worktrees', 'ws-01');
  mkdirSync(wt, { recursive: true });
  assert.equal(findRoot(wt), root, 'from worktree resolves to main root');
  assert.equal(findRoot(join(root, '.worktrees', 'ws-02')), root, '.worktrees convention too');
  assert.equal(findRoot(root), root, 'at root resolves to root');
});

test('findRoot: falls back to startDir when no .deep-loop/current ancestor', () => {
  const d = mkdtempSync(join(tmpdir(), 'fr2-'));
  assert.equal(findRoot(d), d, 'no marker → startDir fallback (init-run path)');
});

test('findRoot: does NOT bind a nested repo under a parent run (R5 high-2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fr3-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), 'run-parent');
  const nested = join(root, 'some', 'nested-repo');
  mkdirSync(nested, { recursive: true });
  // nested dir 은 worktree 컨벤션 밖 → 부모 run 으로 올라가지 않고 자기 자신 반환(격리 유지).
  assert.equal(findRoot(nested), nested, 'nested non-worktree dir resolves to itself, not parent run');
});

// FIX H: nested convention worktrees — <root>/.claude/worktrees/a/.claude/worktrees/b
// 내부 base(<root>/.claude/worktrees/a)에 .deep-loop/current 없어도 계속 탐색해 외부 root 발견.
test('findRoot: nested convention worktrees resolves to outer root with .deep-loop/current (FIX H)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fr4-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), 'run-outer');
  // nested: <root>/.claude/worktrees/a/.claude/worktrees/b
  const nested = join(root, '.claude', 'worktrees', 'a', '.claude', 'worktrees', 'b');
  mkdirSync(nested, { recursive: true });
  // inner base <root>/.claude/worktrees/a has no .deep-loop/current — should NOT stop here
  assert.equal(findRoot(nested), root, 'nested convention: inner base without marker continues to outer root');
});

const _R = _dn(_dn(fileURLToPath(import.meta.url)));   // repo root (tests/..)
test('findRoot is shared across CLI + hook + headless entrypoints', () => {
  for (const f of ['scripts/deep-loop.mjs', 'scripts/hooks-impl/precompact-handoff.mjs', 'scripts/hooks-impl/drive-headless.mjs']) {
    assert.match(_rfRoot(join(_R, f), 'utf8'), /findRoot\s*\(/, `${f} must resolve root via shared findRoot`);
  }
});
