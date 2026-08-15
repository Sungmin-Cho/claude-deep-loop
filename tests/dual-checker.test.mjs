import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, importReviewOutcome, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import {
  claimDualIndependentReview,
  importDualReviewOutcome,
  settleDualAttemptProcess,
} from '../scripts/lib/dual-checker.mjs';
import { parseDualReviewImport } from '../scripts/lib/review-import.mjs';
import {
  checkerApprovalMap,
  exactDualProcess,
  writeExactDualCapture,
} from './helpers/dual-capture.mjs';

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
  return { root, runId, fence, makerId, checkerEpisodeId, worktree };
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

function captureFixture(f, attempt, { sourceManifest, sourceSkill, sourceOverrides } = {}) {
  const captureOptions = {};
  if (sourceManifest !== undefined) captureOptions.manifest = Buffer.from(sourceManifest);
  if (sourceSkill !== undefined) captureOptions.skill = Buffer.from(sourceSkill);
  if (sourceOverrides !== undefined) captureOptions.sourceOverrides = sourceOverrides;
  return writeExactDualCapture({
    root: f.root,
    runId: f.runId,
    checkerEpisodeId: f.checkerEpisodeId,
    attemptId: attempt.attempt_id,
    sourceClaimSha256: attempt.source_claim_sha256,
    ...captureOptions,
  }).proof;
}

function withRewrittenRecord(root, proof, bytes) {
  writeFileSync(join(root, proof.record_path), bytes);
  const { capture_id: _captureId, ...binding } = proof;
  binding.record_sha256 = sha256(bytes);
  return { capture_id: sha256(JSON.stringify(binding)), ...binding };
}

function installCheckerApprovals(f, attempts) {
  const state = readState(f.root, f.runId).data;
  const approvals = checkerApprovalMap(attempts);
  if (JSON.stringify(state.autonomy.checker_executable_approvals) === JSON.stringify(approvals)) return;
  state.autonomy.checker_executable_approvals = approvals;
  writeState(f.root, f.runId, state);
}

function settleAttempt(f, claim, attempt, sessionId, usage = {
  num_turns: 1, input_tokens: 17, output_tokens: 5, tokens: 22,
}, captureOptions = {}) {
  installCheckerApprovals(f, claim.attempts);
  return settleDualAttemptProcess(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    attemptId: attempt.attempt_id,
    capture: captureFixture(f, attempt, captureOptions),
    process: exactDualProcess({ root: f.root, attempt, sessionId, usage }),
    fence: f.fence,
  });
}

test('reduced caller-authored provider labels cannot settle a dual process proof', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  installCheckerApprovals(f, claim.attempts);
  const attempt = claim.attempts[0];
  assert.throws(() => settleDualAttemptProcess(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    attemptId: attempt.attempt_id,
    capture: captureFixture(f, attempt),
    process: {
      provider_id: attempt.provider_id,
      model_id: attempt.model_id,
      session_id: '11111111-1111-4111-8111-111111111111',
      usage: { num_turns: 1, input_tokens: 2, output_tokens: 1, tokens: 3 },
      stdout_sha256: '1'.repeat(64),
      stderr_sha256: '2'.repeat(64),
    },
    fence: f.fence,
  }), /DUAL_REVIEW_PROCESS_INVALID/);
});

test('provider process receipt durably binds locked executable, launch, lifecycle, and full streams', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  installCheckerApprovals(f, claim.attempts);
  const attempt = claim.attempts[0];
  const process = exactDualProcess({
    root: f.root,
    attempt,
    sessionId: '11111111-1111-4111-8111-111111111111',
  });
  const settled = settleDualAttemptProcess(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    attemptId: attempt.attempt_id,
    capture: captureFixture(f, attempt),
    process,
    fence: f.fence,
  });

  assert.equal(settled.receipt.contract, 'deep-loop-dual-checker-process-receipt-v2');
  assert.deepEqual(settled.receipt.executable, process.executable);
  assert.deepEqual(settled.receipt.launch, process.launch);
  assert.deepEqual(settled.receipt.lifecycle, process.lifecycle);
  assert.deepEqual(settled.receipt.streams, process.streams);
  assert.deepEqual(settled.attempt.process_proof, {
    receipt_id: settled.receipt.receipt_id,
    receipt: settled.receipt_path,
    provider_id: attempt.provider_id,
    model_id: attempt.model_id,
    session_id: process.session_id,
    claim_hash: settled.receipt.claim_hash,
    executable: process.executable,
    launch: process.launch,
    lifecycle: process.lifecycle,
    streams: process.streams,
  });
});

test('authorized provider launch rejects weakened argv and noncanonical cwd at settlement', () => {
  const cases = [
    ['codex sandbox value', 0, process => {
      process.launch.argv[process.launch.argv.indexOf('--sandbox') + 1] = 'danger-full-access';
    }],
    ['codex reduced argv', 0, process => {
      process.launch.argv = ['exec', '--model', process.model_id, '-'];
    }],
    ['grok missing no-subagents', 1, process => {
      process.launch.argv.splice(process.launch.argv.indexOf('--no-subagents'), 1);
    }],
    ['grok reduced argv', 1, process => {
      process.launch.argv = ['--model', process.model_id];
    }],
    ['wrong absolute cwd', 0, process => {
      process.launch.cwd = process.executable.platform === 'win32' ? 'C:\\attacker' : '/tmp/attacker';
    }],
    ['cross-dialect cwd', 0, process => {
      process.launch.cwd = process.executable.platform === 'win32' ? '/tmp/attacker' : 'C:\\Windows';
    }],
  ];
  for (const [label, slot, mutate] of cases) {
    const f = fixture();
    const claim = claimDualIndependentReview(f.root, f.runId, {
      episodeId: f.checkerEpisodeId, fence: f.fence,
    });
    installCheckerApprovals(f, claim.attempts);
    const attempt = claim.attempts[slot];
    const process = exactDualProcess({
      root: f.root,
      attempt,
      sessionId: slot === 0
        ? '11111111-1111-4111-8111-111111111111'
        : '22222222-2222-4222-8222-222222222222',
    });
    mutate(process);
    assert.throws(() => settleDualAttemptProcess(f.root, f.runId, {
      episodeId: f.checkerEpisodeId,
      attemptId: attempt.attempt_id,
      capture: captureFixture(f, attempt),
      process,
      fence: f.fence,
    }), /DUAL_REVIEW_PROCESS_INVALID/, label);
    assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost'
      && event.data?.dual_checker_attempt_id).length, 0, label);
  }
});

test('settlement rechecks exact executable security identity against the locked approval', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  installCheckerApprovals(f, claim.attempts);
  const attempt = claim.attempts[0];
  const process = exactDualProcess({
    root: f.root,
    attempt,
    sessionId: '11111111-1111-4111-8111-111111111111',
  });
  const state = readState(f.root, f.runId).data;
  state.autonomy.checker_executable_approvals.codex.version = '0.144.2';
  writeState(f.root, f.runId, state);

  assert.throws(() => settleDualAttemptProcess(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    attemptId: attempt.attempt_id,
    capture: captureFixture(f, attempt),
    process,
    fence: f.fence,
  }), /DUAL_REVIEW_PROCESS_(?:APPROVAL|MISMATCH)/);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id).length, 0);
});

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
    sourceSkill: '---\nname: deep-review-loop\ndescription: drifted doctrine\n---\n# Different review\n',
  }), /DUAL_REVIEW_CAPTURE_SOURCE_MISMATCH/);
  const checker = readState(f.root, f.runId).data.episodes
    .find(episode => episode.id === f.checkerEpisodeId);
  assert.equal(checker.status, 'in_progress');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id).length, 1);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-attempt-outcome').length, 0);
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 0);
});

test('capture settlement rejects self-consistent but semantically forged retained source bytes', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  installCheckerApprovals(f, claim.attempts);
  const attempt = claim.attempts[0];
  assert.throws(() => settleDualAttemptProcess(f.root, f.runId, {
    episodeId: f.checkerEpisodeId,
    attemptId: attempt.attempt_id,
    capture: captureFixture(f, attempt, { sourceManifest: 'caller-authored manifest bytes' }),
    process: exactDualProcess({
      root: f.root,
      attempt,
      sessionId: '11111111-1111-4111-8111-111111111111',
    }),
    fence: f.fence,
  }), /DUAL_REVIEW_CAPTURE_MISMATCH/);
});

test('capture settlement rejects arbitrary records and cross-attempt, cross-run, and stale-source swaps', () => {
  {
    const f = fixture();
    const claim = claimDualIndependentReview(f.root, f.runId, {
      episodeId: f.checkerEpisodeId, fence: f.fence,
    });
    const arbitrary = withRewrittenRecord(
      f.root,
      captureFixture(f, claim.attempts[0]),
      Buffer.from('caller-authored arbitrary capture bytes'),
    );
    assert.throws(() => settleDualAttemptProcess(f.root, f.runId, {
      episodeId: f.checkerEpisodeId,
      attemptId: claim.attempts[0].attempt_id,
      capture: arbitrary,
      process: {
        provider_id: claim.attempts[0].provider_id,
        model_id: claim.attempts[0].model_id,
        session_id: '11111111-1111-4111-8111-111111111111',
        usage: { num_turns: 1, input_tokens: 1, output_tokens: 1, tokens: 2 },
        stdout_sha256: '1'.repeat(64), stderr_sha256: '2'.repeat(64),
      },
      fence: f.fence,
    }), /DUAL_REVIEW_CAPTURE_MISMATCH/);
  }
  {
    const f = fixture();
    const claim = claimDualIndependentReview(f.root, f.runId, {
      episodeId: f.checkerEpisodeId, fence: f.fence,
    });
    const firstCapture = captureFixture(f, claim.attempts[0]);
    assert.throws(() => settleDualAttemptProcess(f.root, f.runId, {
      episodeId: f.checkerEpisodeId,
      attemptId: claim.attempts[1].attempt_id,
      capture: firstCapture,
      process: {
        provider_id: claim.attempts[1].provider_id,
        model_id: claim.attempts[1].model_id,
        session_id: '22222222-2222-4222-8222-222222222222',
        usage: { num_turns: 1, input_tokens: 1, output_tokens: 1, tokens: 2 },
        stdout_sha256: '3'.repeat(64), stderr_sha256: '4'.repeat(64),
      },
      fence: f.fence,
    }), /DUAL_REVIEW_CAPTURE_INVALID/);
  }
  {
    const left = fixture();
    const leftClaim = claimDualIndependentReview(left.root, left.runId, {
      episodeId: left.checkerEpisodeId, fence: left.fence,
    });
    const leftCapture = captureFixture(left, leftClaim.attempts[0]);
    const right = fixture();
    const rightClaim = claimDualIndependentReview(right.root, right.runId, {
      episodeId: right.checkerEpisodeId, fence: right.fence,
    });
    assert.throws(() => settleDualAttemptProcess(right.root, right.runId, {
      episodeId: right.checkerEpisodeId,
      attemptId: rightClaim.attempts[0].attempt_id,
      capture: leftCapture,
      process: {
        provider_id: rightClaim.attempts[0].provider_id,
        model_id: rightClaim.attempts[0].model_id,
        session_id: '11111111-1111-4111-8111-111111111111',
        usage: { num_turns: 1, input_tokens: 1, output_tokens: 1, tokens: 2 },
        stdout_sha256: '5'.repeat(64), stderr_sha256: '6'.repeat(64),
      },
      fence: right.fence,
    }), /DUAL_REVIEW_CAPTURE_INVALID/);
  }
  {
    const f = fixture();
    const claim = claimDualIndependentReview(f.root, f.runId, {
      episodeId: f.checkerEpisodeId, fence: f.fence,
    });
    const capture = captureFixture(f, claim.attempts[0]);
    const stale = 'f'.repeat(64);
    const record = JSON.parse(readFileSync(join(f.root, capture.record_path), 'utf8'));
    record.binding.source_claim_sha256 = stale;
    const staleProof = withRewrittenRecord(
      f.root, { ...capture, source_claim_sha256: stale }, Buffer.from(`${JSON.stringify(record)}\n`),
    );
    assert.throws(() => settleDualAttemptProcess(f.root, f.runId, {
      episodeId: f.checkerEpisodeId,
      attemptId: claim.attempts[0].attempt_id,
      capture: staleProof,
      process: {
        provider_id: claim.attempts[0].provider_id,
        model_id: claim.attempts[0].model_id,
        session_id: '11111111-1111-4111-8111-111111111111',
        usage: { num_turns: 1, input_tokens: 1, output_tokens: 1, tokens: 2 },
        stdout_sha256: '7'.repeat(64), stderr_sha256: '8'.repeat(64),
      },
      fence: f.fence,
    }), /DUAL_REVIEW_CAPTURE_INVALID/);
  }
});

test('capture directory extras and post-settlement replacement block import without aggregate credit', () => {
  const extra = fixture();
  const extraClaim = claimDualIndependentReview(extra.root, extra.runId, {
    episodeId: extra.checkerEpisodeId, fence: extra.fence,
  });
  const extraCapture = captureFixture(extra, extraClaim.attempts[0]);
  writeFileSync(join(dirname(join(extra.root, extraCapture.record_path)), 'unexpected.txt'), 'extra');
  assert.throws(() => settleAttempt(
    extra, extraClaim, extraClaim.attempts[0], '11111111-1111-4111-8111-111111111111',
  ), /DUAL_REVIEW_CAPTURE_MISMATCH/);

  const replaced = fixture();
  const claim = claimDualIndependentReview(replaced.root, replaced.runId, {
    episodeId: replaced.checkerEpisodeId, fence: replaced.fence,
  });
  const sessions = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  claim.attempts.forEach((attempt, index) => settleAttempt(replaced, claim, attempt, sessions[index]));
  importDualReviewOutcome(replaced.root, replaced.runId, {
    raw: JSON.stringify(dualInput(claim, claim.attempts[0], { session_id: sessions[0] })),
    fence: replaced.fence,
  });
  const firstCapture = readState(replaced.root, replaced.runId).data.episodes
    .find(episode => episode.id === replaced.checkerEpisodeId).review_aggregation.attempts[0].capture_proof;
  writeFileSync(join(replaced.root, firstCapture.record_path), 'replacement');
  assert.throws(() => importDualReviewOutcome(replaced.root, replaced.runId, {
    raw: JSON.stringify(dualInput(claim, claim.attempts[1], { session_id: sessions[1] })),
    fence: replaced.fence,
  }), /DUAL_REVIEW_CAPTURE_MISMATCH/);
  assert.equal(events(replaced.root, replaced.runId).filter(event => event.type === 'review-outcome').length, 0);
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

test('public review import routes persisted dual state to v2 and rejects scalar version crossing', () => {
  const f = fixture();
  const claim = claimDualIndependentReview(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, fence: f.fence,
  });
  const sessions = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  claim.attempts.forEach((attempt, index) => settleAttempt(f, claim, attempt, sessions[index]));

  const v1 = {
    schema_version: '1.0', reviewer_id: 'deep-review', checker_episode_id: f.checkerEpisodeId,
    target_maker: f.makerId, attempt_id: claim.attempts[0].attempt_id,
    verdict: 'APPROVE', report_body: 'scalar bypass', artifacts: claim.source_binding.artifacts,
  };
  assert.throws(() => importReviewOutcome(f.root, f.runId, {
    raw: JSON.stringify(v1), fence: f.fence,
  }), /DUAL_REVIEW_IMPORT_VERSION_MISMATCH/);
  const report = `${f.worktree}/scalar-bypass.md`;
  writeFileSync(join(f.root, report), '# scalar bypass');
  assert.throws(() => recordReviewOutcome(f.root, f.runId, {
    episodeId: f.checkerEpisodeId, verdict: 'APPROVE', proof: { report }, fence: f.fence,
  }), /DUAL_REVIEW_REQUIRED/);

  const cli = join(process.cwd(), 'scripts', 'deep-loop.mjs');
  const invoke = raw => spawnSync(process.execPath, [
    cli, 'review', 'import', '--stdin', '--owner', f.runId, '--generation', '1',
    '--project-root', f.root, '--run-id', f.runId,
  ], { input: raw, encoding: 'utf8', shell: false });
  const first = invoke(JSON.stringify(dualInput(claim, claim.attempts[0], { session_id: sessions[0] })));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'awaiting-second-attempt');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 0);

  const second = invoke(JSON.stringify(dualInput(claim, claim.attempts[1], { session_id: sessions[1] })));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).terminal, 'approved');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 1);
});
