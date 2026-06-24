// Codex r3 FIX 1: atomic lease fencing tests — library-level interleaving scenarios
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { acquireLease, releaseLease } from '../scripts/lib/lease.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-fence-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

// FIX 1: stale parent (gen 1) loses lease → child acquires gen 2 → parent's mutator throws LEASE_FENCED
test('newWorkstream with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen1 = data.session_chain.lease.generation;

  // Simulate child takeover: release gen1, acquire gen2
  releaseLease(root, runId, { owner, generation: gen1 });
  const newOwner = 'child-run-id-01';
  acquireLease(root, runId, { owner: newOwner, expectGeneration: gen1 });

  // Old parent tries to mutate with stale fence (gen1) — must throw LEASE_FENCED
  assert.throws(
    () => newWorkstream(root, runId, { title: 'T', branch: 'b', worktree: 'w', fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

test('newWorkstream with correct current fence succeeds', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen = data.session_chain.lease.generation;

  // Correct fence — should succeed
  const { id } = newWorkstream(root, runId, { title: 'Auth', branch: 'b', worktree: 'w', fence: { owner, generation: gen, intent: 'business' } });
  assert.match(id, /^ws-01-auth$/);
});

test('setWorkstreamStatus with stale fence throws LEASE_FENCED', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen1 = data.session_chain.lease.generation;

  const { id } = newWorkstream(root, runId, { title: 'T', branch: 'b', worktree: 'w', fence: { owner, generation: gen1, intent: 'business' } });

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-002', expectGeneration: gen1 });

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

  const { id } = newWorkstream(root, runId, { title: 'T', branch: 'b', worktree: 'w', fence: { owner, generation: gen1, intent: 'business' } });

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-003', expectGeneration: gen1 });

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
  acquireLease(root, runId, { owner: 'child-run-004', expectGeneration: gen1 });

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
  acquireLease(root, runId, { owner: 'child-run-005', expectGeneration: gen1 });

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

  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w', fence: { owner, generation: gen1, intent: 'business' } }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true }, fence: { owner, generation: gen1, intent: 'business' } });

  // Simulate child takeover
  releaseLease(root, runId, { owner, generation: gen1 });
  acquireLease(root, runId, { owner: 'child-run-006', expectGeneration: gen1 });

  assert.throws(
    () => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE', fence: { owner, generation: gen1, intent: 'business' } }),
    /LEASE_FENCED/
  );
});

// Codex r13: fence is now MANDATORY — calling any mutator without fence throws FENCE_REQUIRED
test('all mutators without fence param throw FENCE_REQUIRED (fence is now mandatory)', () => {
  const { root, runId } = seed();
  // newWorkstream
  assert.throws(
    () => newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }),
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
});
