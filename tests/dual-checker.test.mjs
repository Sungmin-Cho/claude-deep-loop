import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview } from '../scripts/lib/review.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import {
  claimDualIndependentReview,
  importDualReviewOutcome,
  settleDualAttemptProcess,
} from '../scripts/lib/dual-checker.mjs';
import { parseDualReviewImport } from '../scripts/lib/review-import.mjs';

function events(root, runId) {
  return readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dl-dual-checker-'));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'dual independent review', detected: { 'deep-review': true },
    now: new Date('2026-08-15T00:00:00.000Z'),
  });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/dual-review';
  const ws = newWorkstream(root, runId, {
    title: 'dual review', branch: 'dual-review', worktree, fence,
  }).id;
  const artifact = `${worktree}/implementation.txt`;
  mkdirSync(dirname(join(root, artifact)), { recursive: true });
  writeFileSync(join(root, artifact), 'implementation');
  const makerId = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifact], fence,
  }).id;
  recordEpisode(root, runId, makerId, { status: 'in_progress', fence });
  recordEpisode(root, runId, makerId, {
    status: 'done', artifacts: [artifact], proof: {}, fence,
  });
  const { checkerEpisodeId } = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws,
    detected: { 'deep-review': true }, fence,
  });
  return { root, runId, fence, makerId, checkerEpisodeId };
}

test('dual claim atomically fixes exactly two independent reviewer transports without approving the outer checker', () => {
  const f = fixture();
  const result = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    fence: f.fence,
    now: '2026-08-15T00:01:00.000Z',
  });

  assert.match(result.aggregation_id, /^aggregation-[0-9a-f-]+$/);
  assert.equal(result.attempts.length, 2);
  for (const key of ['attempt_id', 'reviewer_id', 'reviewer_adapter', 'provider_id', 'model_id']) {
    assert.equal(new Set(result.attempts.map(attempt => attempt[key])).size, 2, key);
  }
  assert.equal(result.attempts.every(attempt => attempt.session_id === null), true);
  assert.deepEqual(result.attempts.map(attempt => attempt.slot), [0, 1]);
  assert.equal(new Set(result.attempts.map(attempt => attempt.source_claim_sha256)).size, 1);
  assert.match(result.attempts[0].source_claim_sha256, /^[0-9a-f]{64}$/);

  const state = readState(f.root, f.runId).data;
  const checker = state.episodes.find(episode => episode.id === f.checkerEpisodeId);
  assert.equal(state.schema_version, '0.5.0');
  assert.equal(checker.status, 'in_progress');
  assert.equal(checker.target_maker, f.makerId);
  assert.equal(checker.review_claim, undefined);
  assert.deepEqual(Object.keys(checker.review_aggregation).sort(), [
    'aggregate_proof', 'aggregate_status', 'aggregation_id', 'attempts', 'policy',
    'required_attempt_count', 'schema_version', 'source_binding',
  ]);
  assert.equal(checker.review_aggregation.schema_version, '2.0');
  assert.equal(checker.review_aggregation.policy, 'ALL_LITERAL_APPROVE_2');
  assert.equal(checker.review_aggregation.required_attempt_count, 2);
  assert.equal(checker.review_aggregation.aggregation_id, result.aggregation_id);
  assert.equal(checker.review_aggregation.aggregate_status, 'in_progress');
  assert.equal(checker.review_aggregation.aggregate_proof, null);
  assert.equal(checker.review_aggregation.source_binding.source_claim_sha256,
    result.source_binding.source_claim_sha256);
  assert.deepEqual(checker.review_aggregation.attempts, result.attempts);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 0);
  assert.equal(events(f.root, f.runId)
    .filter(event => event.type === 'independent-review-aggregation-claimed').length, 1);
});

function dualInput(claim, attempt, overrides = {}) {
  return {
    schema_version: '2.0',
    aggregation_id: claim.aggregation_id,
    reviewer_id: attempt.reviewer_id,
    reviewer_adapter: attempt.reviewer_adapter,
    provider_id: attempt.provider_id,
    model_id: attempt.model_id,
    session_id: attempt.session_id,
    checker_episode_id: claim.checker_episode_id,
    target_maker: claim.source_binding.target_maker,
    attempt_id: attempt.attempt_id,
    source_claim_sha256: attempt.source_claim_sha256,
    verdict: 'APPROVE',
    report_body: '# independent review\n\nAPPROVE',
    artifacts: claim.source_binding.artifacts,
    ...overrides,
  };
}

function captureFixture(f, attempt, {
  sourceManifest = 'manifest:shared-source',
  sourceSkill = 'skill:shared-review-doctrine',
} = {}) {
  const base = `.deep-loop/runs/${f.runId}/checker-captures/${attempt.attempt_id}`;
  const files = {
    record_path: `${base}/capture.json`,
    manifest_path: `${base}/plugin.json`,
    skill_path: `${base}/SKILL.md`,
  };
  const bytes = {
    record_path: Buffer.from(`capture:${attempt.attempt_id}`),
    manifest_path: Buffer.from(sourceManifest),
    skill_path: Buffer.from(sourceSkill),
  };
  for (const key of Object.keys(files)) {
    mkdirSync(dirname(join(f.root, files[key])), { recursive: true });
    writeFileSync(join(f.root, files[key]), bytes[key]);
  }
  const binding = {
    record_path: files.record_path,
    record_sha256: sha256(bytes.record_path),
    manifest_path: files.manifest_path,
    source_manifest_sha256: sha256(bytes.manifest_path),
    skill_path: files.skill_path,
    source_skill_sha256: sha256(bytes.skill_path),
  };
  return { capture_id: sha256(JSON.stringify(binding)), ...binding };
}

function settleAttempt(f, claim, attempt, sessionId, usage = {
  num_turns: 1, input_tokens: 17, output_tokens: 5, tokens: 22,
}, captureOptions = {}) {
  return settleDualAttemptProcess(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    attemptId: attempt.attempt_id,
    capture: captureFixture(f, attempt, captureOptions),
    process: {
      provider_id: attempt.provider_id,
      model_id: attempt.model_id,
      session_id: sessionId,
      usage,
      stdout_sha256: sha256(`stdout:${attempt.attempt_id}`),
      stderr_sha256: sha256(`stderr:${attempt.attempt_id}`),
    },
    fence: f.fence,
  });
}

test('v2 parser accepts only the exact per-attempt identity envelope and never promotes v1 scalar input', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  const input = dualInput(claim, claim.attempts[0], {
    session_id: '11111111-1111-4111-8111-111111111111',
  });
  assert.deepEqual(parseDualReviewImport(JSON.stringify(input)), input);

  const { provider_id: _missing, ...missing } = input;
  assert.throws(() => parseDualReviewImport(JSON.stringify(missing)), /DUAL_REVIEW_IMPORT_PROPERTY_INVALID/);
  assert.throws(() => parseDualReviewImport(JSON.stringify({ ...input, extra: true })), /DUAL_REVIEW_IMPORT_PROPERTY_INVALID/);
  assert.throws(() => parseDualReviewImport(JSON.stringify({
    schema_version: '1.0',
    reviewer_id: input.reviewer_id,
    checker_episode_id: input.checker_episode_id,
    target_maker: input.target_maker,
    attempt_id: input.attempt_id,
    verdict: input.verdict,
    report_body: input.report_body,
    artifacts: input.artifacts,
  })), /DUAL_REVIEW_IMPORT_PROPERTY_INVALID|DUAL_REVIEW_IMPORT_SCHEMA_INVALID/);
});

test('first APPROVE import remains nonterminal; second atomically publishes one content-addressed aggregate outcome', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  const sessions = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  claim.attempts.forEach((attempt, index) => settleAttempt(f, claim, attempt, sessions[index]));

  const firstInput = dualInput(claim, claim.attempts[0], { session_id: sessions[0] });
  const first = importDualReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(firstInput), fence: f.fence, now: '2026-08-15T00:02:00.000Z',
  });
  assert.equal(first.terminal, null);
  assert.equal(first.status, 'awaiting-second-attempt');
  let state = readState(f.root, f.runId).data;
  let checker = state.episodes.find(episode => episode.id === f.checkerEpisodeId);
  assert.equal(checker.status, 'in_progress');
  assert.equal(checker.review_aggregation.aggregate_status, 'in_progress');
  assert.equal(checker.review_aggregation.attempts[0].status, 'imported');
  assert.equal(state.episodes.find(episode => episode.id === f.makerId).agent_reviewed, undefined);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-attempt-outcome').length, 1);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 0);
  const firstRetry = importDualReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(firstInput), fence: f.fence, now: '2026-08-15T00:09:00.000Z',
  });
  assert.equal(firstRetry.recovered, true);
  assert.equal(firstRetry.status, 'awaiting-second-attempt');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-attempt-outcome').length, 1);

  const secondInput = dualInput(claim, claim.attempts[1], { session_id: sessions[1] });
  const second = importDualReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(secondInput), fence: f.fence, now: '2026-08-15T00:03:00.000Z',
  });
  assert.equal(second.terminal, 'approved');
  assert.equal(second.status, 'approved');
  assert.equal(second.report, undefined, 'aggregate must not synthesize a third report');

  state = readState(f.root, f.runId).data;
  checker = state.episodes.find(episode => episode.id === f.checkerEpisodeId);
  assert.equal(checker.status, 'approved');
  assert.equal(checker.review_aggregation.aggregate_status, 'approved');
  assert.deepEqual(checker.review_aggregation.aggregate_proof.attempt_ids,
    checker.review_aggregation.attempts.map(attempt => attempt.attempt_id));
  assert.equal(checker.review_aggregation.attempts.every(attempt => attempt.status === 'imported'), true);
  assert.equal(state.episodes.find(episode => episode.id === f.makerId).agent_reviewed, true);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-attempt-outcome').length, 2);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 1);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id).length, 2);
  const secondRetry = importDualReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(secondInput), fence: f.fence, now: '2026-08-15T00:10:00.000Z',
  });
  assert.equal(secondRetry.recovered, true);
  assert.equal(secondRetry.terminal, 'approved');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-attempt-outcome').length, 2);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 1);
});

test('session collision, duplicate, and second identity mismatch fail closed without aggregate credit', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  const sessions = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  settleAttempt(f, claim, claim.attempts[0], sessions[0]);
  assert.throws(() => settleAttempt(
    f, claim, claim.attempts[1], sessions[0],
  ), /DUAL_REVIEW_SESSION_COLLISION|DUAL_REVIEW_PROCESS_INVALID/);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id).length, 1);

  const first = dualInput(claim, claim.attempts[0], { session_id: sessions[0] });
  importDualReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(first), fence: f.fence,
  });
  assert.throws(() => importDualReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify({ ...first, report_body: '# changed duplicate\n\nAPPROVE' }), fence: f.fence,
  }), /DUAL_REVIEW_ATTEMPT_ALREADY_IMPORTED|DUAL_REVIEW_REPORT_PROOF_MISMATCH/);

  settleAttempt(f, claim, claim.attempts[1], sessions[1]);
  const second = dualInput(claim, claim.attempts[1], {
    session_id: sessions[1], provider_id: claim.attempts[0].provider_id,
  });
  assert.throws(() => importDualReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(second), fence: f.fence,
  }), /DUAL_REVIEW_IMPORT_IDENTITY_MISMATCH: provider_id/);

  const state = readState(f.root, f.runId).data;
  const checker = state.episodes.find(episode => episode.id === f.checkerEpisodeId);
  assert.equal(checker.status, 'in_progress');
  assert.equal(checker.review_aggregation.aggregate_status, 'in_progress');
  assert.equal(state.episodes.find(episode => episode.id === f.makerId).agent_reviewed, undefined);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 0);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-attempt-outcome').length, 1);
});

test('byte-different source captures cannot be aggregated as independent reviews of one source', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  const sessions = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  settleAttempt(f, claim, claim.attempts[0], sessions[0]);
  assert.throws(() => settleAttempt(f, claim, claim.attempts[1], sessions[1], undefined, {
    sourceSkill: 'skill:drifted-review-doctrine',
  }), /DUAL_REVIEW_CAPTURE_SOURCE_MISMATCH/);
  const checker = readState(f.root, f.runId).data.episodes
    .find(episode => episode.id === f.checkerEpisodeId);
  assert.equal(checker.status, 'in_progress');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id).length, 1);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-attempt-outcome').length, 0);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 0);
});

test('CONCERN or REQUEST_CHANGES never receives approval credit and rejects only after both proofed imports', () => {
  for (const verdict of ['CONCERN', 'REQUEST_CHANGES']) {
    const f = fixture();
    const claim = claimDualIndependentReview(f.root, f.runId, {
      episodeId: f.checkerEpisodeId, fence: f.fence,
    });
    const sessions = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    claim.attempts.forEach((attempt, index) => settleAttempt(
      f, claim, attempt, sessions[index],
    ));
    const first = importDualReviewOutcome(f.root, f.runId, {
      raw: JSON.stringify(dualInput(claim, claim.attempts[0], {
        session_id: sessions[0], verdict,
      })),
      fence: f.fence,
    });
    assert.equal(first.status, 'awaiting-second-attempt', verdict);
    assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
    const second = importDualReviewOutcome(f.root, f.runId, {
      raw: JSON.stringify(dualInput(claim, claim.attempts[1], {
        session_id: sessions[1], verdict: 'APPROVE',
      })),
      fence: f.fence,
    });
    assert.equal(second.terminal, 'rejected', verdict);
    const state = readState(f.root, f.runId).data;
    const checker = state.episodes.find(episode => episode.id === f.checkerEpisodeId);
    assert.equal(checker.status, 'rejected', verdict);
    assert.equal(checker.review_aggregation.aggregate_status, 'rejected', verdict);
    assert.equal(state.episodes.find(episode => episode.id === f.makerId).agent_reviewed, undefined);
    assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 1);
  }
});
