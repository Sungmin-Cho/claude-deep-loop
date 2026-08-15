import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claimDualIndependentReview,
  importDualReviewOutcome,
  settleDualAttemptProcess,
} from '../../scripts/lib/dual-checker.mjs';
import { withReconciledMutationLock } from '../../scripts/lib/integrity.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function writeExactDualCapture({
  root,
  runId,
  checkerEpisodeId,
  attemptId,
  sourceClaimSha256,
  manifest = Buffer.from('shared deep-review manifest'),
  skill = Buffer.from('shared deep-review doctrine'),
} = {}) {
  const base = `.deep-loop/runs/${runId}/checker-captures/${attemptId}`;
  const recordPath = `${base}/capture.json`;
  const manifestPath = `${base}/plugin.json`;
  const skillPath = `${base}/SKILL.md`;
  const source = {
    plugin_directory: '/trusted/deep-review',
    manifest_path: '/trusted/deep-review/.codex-plugin/plugin.json',
    skill_path: '/trusted/deep-review/skills/deep-review-loop/SKILL.md',
    plugin_name: 'deep-review',
    plugin_version: '2.4.0',
    manifest_sha256: sha256(manifest),
    skill_sha256: sha256(skill),
  };
  const binding = {
    run_id: runId,
    checker_episode_id: checkerEpisodeId,
    attempt_id: attemptId,
    source_claim_sha256: sourceClaimSha256,
  };
  const record = {
    schema_version: '1.0',
    binding,
    source,
    captured: {
      manifest_rel: 'plugin.json',
      manifest_sha256: source.manifest_sha256,
      skill_rel: 'SKILL.md',
      skill_sha256: source.skill_sha256,
    },
  };
  const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`);
  for (const [path, bytes] of [
    [recordPath, recordBytes], [manifestPath, manifest], [skillPath, skill],
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  const proofBinding = {
    ...binding,
    record_path: recordPath,
    record_sha256: sha256(recordBytes),
    manifest_path: manifestPath,
    source_manifest_sha256: source.manifest_sha256,
    skill_path: skillPath,
    source_skill_sha256: source.skill_sha256,
  };
  return {
    proof: { capture_id: sha256(JSON.stringify(proofBinding)), ...proofBinding },
    record,
    recordBytes,
  };
}

function deterministicUuid(seed) {
  const value = sha256(seed);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function settleExactDualReview({
  root,
  runId,
  checkerEpisodeId,
  targetMaker,
  fence,
  verdict = 'APPROVE',
  now = '2026-07-23T00:01:00.000Z',
} = {}) {
  let idIndex = 0;
  const claim = claimDualIndependentReview(root, runId, {
    episodeId: checkerEpisodeId,
    fence,
    idFactory: () => deterministicUuid(`${runId}:${checkerEpisodeId}:claim:${idIndex++}`),
    now,
  });
  const results = claim.attempts.map((attempt, index) => {
    const sessionId = deterministicUuid(`${runId}:${checkerEpisodeId}:session:${index}`);
    const capture = writeExactDualCapture({
      root,
      runId,
      checkerEpisodeId,
      attemptId: attempt.attempt_id,
      sourceClaimSha256: attempt.source_claim_sha256,
    }).proof;
    settleDualAttemptProcess(root, runId, {
      episodeId: checkerEpisodeId,
      attemptId: attempt.attempt_id,
      capture,
      process: {
        provider_id: attempt.provider_id,
        model_id: attempt.model_id,
        session_id: sessionId,
        usage: { num_turns: 1, input_tokens: 3 + index, output_tokens: 2, tokens: 5 + index },
        stdout_sha256: sha256(`stdout:${runId}:${attempt.attempt_id}`),
        stderr_sha256: sha256(`stderr:${runId}:${attempt.attempt_id}`),
      },
      fence,
      now,
    });
    return importDualReviewOutcome(root, runId, {
      raw: JSON.stringify({
        schema_version: '2.0',
        aggregation_id: claim.aggregation_id,
        reviewer_id: attempt.reviewer_id,
        reviewer_adapter: attempt.reviewer_adapter,
        provider_id: attempt.provider_id,
        model_id: attempt.model_id,
        session_id: sessionId,
        checker_episode_id: checkerEpisodeId,
        target_maker: targetMaker,
        attempt_id: attempt.attempt_id,
        source_claim_sha256: attempt.source_claim_sha256,
        verdict,
        report_body: `# exact dual fixture ${index + 1}\n\n${verdict}`,
        artifacts: claim.source_binding.artifacts,
      }),
      fence,
      now,
    });
  });
  withReconciledMutationLock(root, runId, () => {});
  return { claim, results };
}
