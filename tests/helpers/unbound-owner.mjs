// Builds the only production shape of an OPEN workstream-session owner scope with workstream_id:null:
// a proof-complete boundary handoff followed by child lease acquisition (handoff.mjs:382-384).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../../scripts/lib/initrun.mjs';
import { newWorkstream, recordWorkstreamTerminal } from '../../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../../scripts/lib/episode.mjs';
import { dispatchReview } from '../../scripts/lib/review.mjs';
import {
  claimDualIndependentReview,
  importDualReviewOutcome,
  settleDualAttemptProcess,
} from '../../scripts/lib/dual-checker.mjs';
import { emitHandoff } from '../../scripts/lib/handoff.mjs';
import { acquireLease } from './acquire-and-activate.mjs';
import { readState, writeState } from '../../scripts/lib/state.mjs';
import {
  checkerApprovalMap,
  exactDualProcess,
  writeExactDualCapture,
} from './dual-capture.mjs';

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
  const ids = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ];
  const claim = claimDualIndependentReview(root, runId, {
    episodeId: checkerId,
    fence: parentFence,
    idFactory: () => ids.shift(),
    now: NOW,
  });
  const claimedState = readState(root, runId).data;
  claimedState.autonomy.checker_executable_approvals = checkerApprovalMap(claim.attempts);
  writeState(root, runId, claimedState);
  const sessions = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  for (const [index, attempt] of claim.attempts.entries()) {
    const capture = writeExactDualCapture({
      root,
      runId,
      checkerEpisodeId: checkerId,
      attemptId: attempt.attempt_id,
      sourceClaimSha256: attempt.source_claim_sha256,
    }).proof;
    settleDualAttemptProcess(root, runId, {
      episodeId: checkerId,
      attemptId: attempt.attempt_id,
      capture,
      process: exactDualProcess({
        root,
        attempt,
        sessionId: sessions[index],
        usage: { num_turns: 1, input_tokens: 4 + index, output_tokens: 2, tokens: 6 + index },
        stdout: `stdout:unbound-owner:${index}`,
        stderr: `stderr:unbound-owner:${index}`,
      }),
      fence: parentFence,
      now: NOW + index + 1,
    });
    importDualReviewOutcome(root, runId, {
      raw: JSON.stringify({
        schema_version: '2.0',
        aggregation_id: claim.aggregation_id,
        reviewer_id: attempt.reviewer_id,
        reviewer_adapter: attempt.reviewer_adapter,
        provider_id: attempt.provider_id,
        model_id: attempt.model_id,
        session_id: sessions[index],
        checker_episode_id: checkerId,
        target_maker: makerId,
        attempt_id: attempt.attempt_id,
        source_claim_sha256: attempt.source_claim_sha256,
        verdict: 'APPROVE',
        report_body: `# ${attempt.reviewer_id}\n\nAPPROVE`,
        artifacts: claim.source_binding.artifacts,
      }),
      fence: parentFence,
      now: NOW + index + 3,
    });
  }
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
    attemptId: 'MIGRATEDATTEMPT01',
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
