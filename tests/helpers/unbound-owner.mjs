// Builds the only production shape of an OPEN workstream-session owner scope with workstream_id:null:
// a proof-complete boundary handoff followed by child lease acquisition (handoff.mjs:382-384).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../../scripts/lib/initrun.mjs';
import { newWorkstream, recordWorkstreamTerminal } from '../../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../../scripts/lib/review.mjs';
import { emitHandoff } from '../../scripts/lib/handoff.mjs';
import { acquireLease } from '../../scripts/lib/lease.mjs';
import { readState } from '../../scripts/lib/state.mjs';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');

export function reviewedMakerThenHandoff({ runtime = 'claude' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-open-unbound-'));
  const review = {
    points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
    flags: [], converge: true, max_review_rounds: 5, require_human_ack: true,
  };
  const { runId } = initRun(root, {
    runtime, goal: 'open-unbound fixture', review, now: new Date(NOW),
  });
  const parentFence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/boundary';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, {
    title: 'boundary', branch: 'boundary', worktree, fence: parentFence,
  }).id;
  const siblingWs = newWorkstream(root, runId, {
    title: 'sibling', branch: 'sibling', worktree: '.claude/worktrees/sibling', fence: parentFence,
  }).id;
  const artifact = `${worktree}/artifact.txt`;
  writeFileSync(join(root, artifact), 'artifact');
  const makerId = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifact], fence: parentFence,
  }).id;
  recordEpisode(root, runId, makerId, { status: 'in_progress', fence: parentFence });
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: [artifact], fence: parentFence });
  const checkerId = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected: {}, fence: parentFence,
  }).checkerEpisodeId;
  const report = `${worktree}/review.md`;
  writeFileSync(join(root, report), '# review\n\nAPPROVE\n');
  recordReviewOutcome(root, runId, {
    episodeId: checkerId, verdict: 'APPROVE', proof: { report }, fence: parentFence,
  });
  recordWorkstreamTerminal(root, runId, ws, {
    status: 'ready', proof: {}, fence: parentFence, now: NOW + 1,
  });

  const closed = readState(root, runId).data;
  const parentOwnerId = closed.session_chain.lease.owner_run_id;
  const parent = closed.session_chain.sessions.find(session => session.run_id === parentOwnerId);
  assert.equal(parent.scope.closed_at != null, true);
  const emitted = emitHandoff(root, runId, {
    boundaryEvent: parent.scope.terminal_event,
    reason: 'workstream-terminal',
    trigger: 'workstream-terminal',
    now: NOW + 2,
    expect: { owner: parentOwnerId, generation: closed.session_chain.lease.generation },
    env: {},
  });
  const releasing = readState(root, runId).data;
  const acquired = acquireLease(root, runId, {
    owner: emitted.childRunId,
    expectGeneration: releasing.session_chain.lease.generation,
    runtime,
    now: NOW + 3,
  });
  assert.equal(acquired.ok, true);

  const current = readState(root, runId).data;
  const ownerId = current.session_chain.lease.owner_run_id;
  const owner = current.session_chain.sessions.find(session => session.run_id === ownerId);
  assert.equal(ownerId, emitted.childRunId);
  assert.deepEqual(owner.scope, {
    kind: 'workstream', workstream_id: null, bound_at_seq: null,
    terminal_event: null, closed_at: null, superseded_at: null,
  });
  return {
    root, runId, ws, siblingWs, makerId, checkerId,
    fence: { owner: ownerId, generation: current.session_chain.lease.generation, intent: 'business' },
  };
}
