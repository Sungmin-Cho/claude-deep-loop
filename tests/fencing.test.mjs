// Codex r3 FIX 1: atomic lease fencing tests — library-level interleaving scenarios
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { acquireLease, releaseLease } from '../scripts/lib/lease.mjs';
import { detectAndPersist } from '../scripts/lib/detect-terminal.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, importReviewOutcome, recordReviewOutcome } from '../scripts/lib/review.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-fence-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('direct writeState replacement is fenced at a copied project root', () => {
  const { root: originalRoot, runId } = seed();
  const candidateRoot = mkdtempSync(join(tmpdir(), 'dl-fence-copy-'));
  const { data } = readState(originalRoot, runId);
  cpSync(join(originalRoot, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });
  const hashPath = join(runDir(candidateRoot, runId), '.loop.hash');
  const beforeHash = readFileSync(hashPath, 'utf8');

  data.discovered_items = ['must-not-write'];
  assert.throws(() => writeState(candidateRoot, runId, data), /PROJECT_ROOT_FENCED/);
  assert.equal(readFileSync(hashPath, 'utf8'), beforeHash);
});

// FIX 1: stale parent (gen 1) loses lease → child acquires gen 2 → parent's mutator throws LEASE_FENCED
test('newWorkstream with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen1 = data.session_chain.lease.generation;

  // Simulate child takeover: release gen1, acquire gen2
  releaseLease(root, runId, { owner, generation: gen1 });
  const newOwner = 'child-run-id-01';
  acquireLease(root, runId, { owner: newOwner, expectGeneration: gen1, runtime: 'claude' });

  // Old parent tries to mutate with stale fence (gen1) — must throw LEASE_FENCED
  assert.throws(
    () => newWorkstream(root, runId, { title: 'T', branch: 'b', worktree: '.claude/worktrees/w', fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

test('newWorkstream with correct current fence succeeds', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen = data.session_chain.lease.generation;

  // Correct fence — should succeed
  const { id } = newWorkstream(root, runId, { title: 'Auth', branch: 'b', worktree: '.claude/worktrees/w', fence: { owner, generation: gen, intent: 'business' } });
  assert.match(id, /^ws-01-auth$/);
});

test('setWorkstreamStatus with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen1 = data.session_chain.lease.generation;

  const { id } = newWorkstream(root, runId, { title: 'T', branch: 'b', worktree: '.claude/worktrees/w', fence: { owner, generation: gen1, intent: 'business' } });

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-002', expectGeneration: gen1, runtime: 'claude' });

  assert.throws(
    () => setWorkstreamStatus(root, runId, id, 'in_progress', { fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

test('recordWorkstreamTerminal with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen1 = data.session_chain.lease.generation;

  const { id } = newWorkstream(root, runId, { title: 'T', branch: 'b', worktree: '.claude/worktrees/w', fence: { owner, generation: gen1, intent: 'business' } });

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-003', expectGeneration: gen1, runtime: 'claude' });

  assert.throws(
    () => recordWorkstreamTerminal(root, runId, id, { status: 'abandoned', proof: { reason: 'x' }, fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

test('newEpisode with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen1 = data.session_chain.lease.generation;

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-004', expectGeneration: gen1, runtime: 'claude' });

  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

test('recordEpisode with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data: d0 } = readState(root, runId);
  const owner = d0.session_chain.lease.owner_run_id;
  const gen1 = d0.session_chain.lease.generation;

  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', fence: { owner, generation: gen1, intent: 'business' } });

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-005', expectGeneration: gen1, runtime: 'claude' });

  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'in_progress', fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

test('recordReviewOutcome with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data: d0 } = readState(root, runId);
  const owner = d0.session_chain.lease.owner_run_id;
  const gen1 = d0.session_chain.lease.generation;

  const fence1 = { owner, generation: gen1, intent: 'business' };
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: fence1 }).id;
  // A done maker so dispatchReview binds the checker (unbound checkers are refused: REVIEW_NO_ELIGIBLE_MAKER).
  writeFileSync(join(root, 'plan-art.txt'), 'artifact');
  const m = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'plan', point: 'plan', workstream: ws, expectedArtifacts: ['plan-art.txt'], fence: fence1 });
  recordEpisode(root, runId, m.id, { status: 'done', artifacts: ['plan-art.txt'], proof: {}, fence: fence1 });
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: fence1 });

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-006', expectGeneration: gen1, runtime: 'claude' });

  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, verdict: 'APPROVE', fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

// Codex r13: fence is now MANDATORY — calling any mutator without fence throws FENCE_REQUIRED
test('all mutators without fence param throw FENCE_REQUIRED (fence is now mandatory)', () => {
  const { root, runId } = seed();
  // newWorkstream
  assert.throws(
    () => newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w' }),
    /FENCE_REQUIRED/
  );
  // setWorkstreamStatus (need a ws to call it, but the FENCE_REQUIRED is thrown before any state read)
  assert.throws(
    () => setWorkstreamStatus(root, runId, 'ws-01', 'in_progress'),
    /FENCE_REQUIRED/
  );
  // recordWorkstreamTerminal
  assert.throws(
    () => recordWorkstreamTerminal(root, runId, 'ws-01', { status: 'abandoned', proof: { reason: 'x' } }),
    /FENCE_REQUIRED/
  );
  // newEpisode
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation' }),
    /FENCE_REQUIRED/
  );
  // recordEpisode
  assert.throws(
    () => recordEpisode(root, runId, 'ep-id', { status: 'in_progress' }),
    /FENCE_REQUIRED/
  );
  // dispatchReview
  assert.throws(
    () => dispatchReview(root, runId, { point: 'plan', workstreamId: 'ws-01', detected: {} }),
    /FENCE_REQUIRED/
  );
  // recordReviewOutcome
  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: 'ep-id', verdict: 'APPROVE' }),
    /FENCE_REQUIRED/
  );
  // importReviewOutcome
  assert.throws(
    () => importReviewOutcome(root, runId, { raw: '{}' }),
    /FENCE_REQUIRED/
  );
});

// ── Task 3: detectAndPersist fencing + releasing-safe tests ─────────────────

const noOpRun = () => ({ code: 1 });
const DT_NOW = '2026-06-28T00:00:00.000Z';

function readLog(root, runId) {
  const p = join(runDir(root, runId), 'event-log.jsonl');
  try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

test('detectAndPersist: wrong owner throws LEASE_FENCED', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-dt-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-28T00:00:00Z') });
  assert.throws(
    () => detectAndPersist(root, runId, { owner: 'wrong-owner', generation: 1, env: {}, platform: 'linux', run: noOpRun, now: DT_NOW }),
    /LEASE_FENCED/
  );
});

test('detectAndPersist: wrong generation throws LEASE_FENCED', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-dt-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-28T00:00:00Z') });
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  assert.throws(
    () => detectAndPersist(root, runId, { owner, generation: 99, env: {}, platform: 'linux', run: noOpRun, now: DT_NOW }),
    /LEASE_FENCED/
  );
});

test('detectAndPersist: success writes session_spawn and terminal-detected event atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-dt-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-28T00:00:00Z') });
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const generation = data.session_chain.lease.generation;

  const d = detectAndPersist(root, runId, { owner, generation, env: {}, platform: 'linux', run: noOpRun, now: DT_NOW });
  assert.equal(d.launcher, 'none');
  assert.equal(d.detected_at, DT_NOW);

  const after = readState(root, runId).data;
  assert.deepEqual(after.session_spawn, d);

  const log = readLog(root, runId);
  const evt = log.find(e => e.type === 'terminal-detected');
  assert.ok(evt, 'terminal-detected event must be in the log');
  assert.equal(evt.data.launcher, 'none');
  // anchor must be updated (event_log_head.seq should match last log entry)
  assert.equal(after.event_log_head.seq, log[log.length - 1].seq);
});

test('detectAndPersist: re-detect overwrites session_spawn (idempotent)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-dt-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-28T00:00:00Z') });
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const generation = data.session_chain.lease.generation;

  const NOW1 = '2026-06-28T01:00:00.000Z';
  const NOW2 = '2026-06-28T02:00:00.000Z';
  detectAndPersist(root, runId, { owner, generation, env: {}, platform: 'linux', run: noOpRun, now: NOW1 });
  const d2 = detectAndPersist(root, runId, { owner, generation, env: {}, platform: 'linux', run: noOpRun, now: NOW2 });

  const after = readState(root, runId).data;
  assert.equal(after.session_spawn.detected_at, NOW2);
  assert.deepEqual(after.session_spawn, d2);
});

test('detectAndPersist: works when lease.state === releasing (releasing-safe R11-HH)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-dt-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-28T00:00:00Z') });
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const generation = data.session_chain.lease.generation;

  // Simulate a post-handoff releasing state
  data.session_chain.lease.state = 'releasing';
  data.session_chain.lease.handoff_phase = 'emitted';
  writeState(root, runId, data);

  // Must NOT throw LEASE_FENCED even though lease is releasing
  const d = detectAndPersist(root, runId, { owner, generation, env: {}, platform: 'linux', run: noOpRun, now: DT_NOW });
  assert.equal(d.launcher, 'none');

  const after = readState(root, runId).data;
  assert.deepEqual(after.session_spawn, d);
});

// ── v1.6: detectAndPersist terminal 가드 (spec §2.3-4 / §4-5b) ───────────────
test('detectAndPersist: terminal run throws RUN_TERMINAL (releasing-safe preserved)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-dt-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  // terminal → 유효 fence여도 in-lock 가드가 거부 (외곽 requireLease 없이 lib 직접 — in-lock이 권위)
  data.status = 'completed';
  writeState(root, runId, data);
  assert.throws(
    () => detectAndPersist(root, runId, { owner, generation: 1, env: {}, platform: 'linux', run: noOpRun, now: '2026-07-09T00:00:01.000Z' }),
    /RUN_TERMINAL: detect-terminal/
  );
  assert.equal(readLog(root, runId).filter(e => e.type === 'terminal-detected').length, 0);
  // releasing-safe 불변: 비terminal + releasing lease는 기존대로 통과
  const d2 = readState(root, runId).data;
  d2.status = 'running';
  d2.session_chain.lease.state = 'releasing';
  writeState(root, runId, d2);
  const d = detectAndPersist(root, runId, { owner, generation: 1, env: {}, platform: 'linux', run: noOpRun, now: '2026-07-09T00:00:02.000Z' });
  assert.equal(typeof d.launcher, 'string');
});
