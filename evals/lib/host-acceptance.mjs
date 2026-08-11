import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { dispatchReview, claimIndependentReview } from '../../scripts/lib/review.mjs';
import { CLI_PATH } from './paths.mjs';
import { evalChildEnv } from './child-env.mjs';

const TASK = 'allow-review-import-111';
const ASSERTION = 'tests/review-import.test.mjs#allow-review-import-111';
const EXECUTOR = 'evals/lib/host-acceptance.mjs';
const ATTEMPT = 'attempt-eval-111';
const NOW = '2026-08-10T00:00:00.000Z';
const MAX = 64 * 1024;
const RESULT_KEYS = ['task_id','assertion_id','executor','status','attempt_id','binding','import_exit'];
const BINDING_KEYS = ['run_id','checker_episode_id','target_maker','workstream_id','point','reviewer_id','review_source','imported_verdict'];

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function sameBinding(actual, expected) {
  return exactKeys(actual, BINDING_KEYS)
    && BINDING_KEYS.every(key => actual[key] === expected[key]);
}

export function validateHostAcceptanceResult(task, result, seededBinding) {
  if (!task || task.id !== TASK || task.host_acceptance?.evidence_ref !== ASSERTION) return { ok: false, reason: 'task-contract' };
  if (!exactKeys(result, RESULT_KEYS)) return { ok: false, reason: 'unknown-or-missing-keys' };
  if (result.task_id !== TASK || result.assertion_id !== ASSERTION || result.executor !== EXECUTOR
    || result.status !== 'pass' || result.attempt_id !== ATTEMPT || result.import_exit !== 0) {
    return { ok: false, reason: 'producer-contract' };
  }
  if (!sameBinding(result.binding, seededBinding)) return { ok: false, reason: 'binding-mismatch' };
  return { ok: true, value: structuredClone(result) };
}

function validateInput(input) {
  if (!exactKeys(input, ['projectRoot','runId','fence','workstreamId'])) throw new Error('HOST_ACCEPTANCE_INPUT_KEYS');
  const { projectRoot, runId, fence, workstreamId } = input;
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || realpathSync(projectRoot) !== projectRoot
    || typeof runId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(runId)
    || typeof workstreamId !== 'string' || workstreamId.length === 0
    || !exactKeys(fence, ['owner','generation','intent']) || fence.owner !== runId
    || !Number.isInteger(fence.generation) || fence.generation < 1 || fence.intent !== 'business') {
    throw new Error('HOST_ACCEPTANCE_INPUT_INVALID');
  }
  return input;
}

function artifactHash(root, rel) {
  return createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
}

function readPublicState(projectRoot, runId) {
  const proc = spawnSync(process.execPath, [
    CLI_PATH, 'state', 'get', '--project-root', projectRoot, '--run-id', runId,
  ], {
    cwd: projectRoot, env: evalChildEnv(),
    encoding: 'utf8', timeout: 30_000, maxBuffer: MAX,
  });
  if (proc.status !== 0) throw new Error(`HOST_ACCEPTANCE_STATE_GET_FAILED:${String(proc.stderr || '').trim()}`);
  try { return JSON.parse(proc.stdout); }
  catch { throw new Error('HOST_ACCEPTANCE_STATE_GET_INVALID'); }
}

export function runAllowReviewImport111(input) {
  const { projectRoot, runId, fence, workstreamId } = validateInput(input);
  const seeded = readPublicState(projectRoot, runId);
  const open = seeded.workstreams.filter(workstream => !['ready','merged','abandoned'].includes(workstream.status));
  const makers = seeded.episodes.filter(episode => episode.role === 'maker' && episode.workstream_id === workstreamId && episode.status === 'done');
  if (open.length !== 1 || open[0].id !== workstreamId || makers.length !== 1 || seeded.episodes.length !== 1) {
    throw new Error('HOST_ACCEPTANCE_TOPOLOGY_INVALID');
  }
  const maker = makers[0];

  const dispatch = dispatchReview(projectRoot, runId, {
    point: 'implementation', workstreamId, detected: { 'deep-review': true }, independentSubagent: false, fence,
  });
  const claim = claimIndependentReview(projectRoot, runId, {
    episodeId: dispatch.checkerEpisodeId, fence, attemptIdFactory: () => ATTEMPT,
  });
  if (claim.attemptId !== ATTEMPT) throw new Error('HOST_ACCEPTANCE_CLAIM_MISMATCH');
  const claimedState = readPublicState(projectRoot, runId);
  const checker = claimedState.episodes.find(episode => episode.id === dispatch.checkerEpisodeId);
  if (!checker || checker.plugin !== 'deep-review' || checker.target_maker !== maker.id
    || checker.attempt_id !== ATTEMPT) throw new Error('HOST_ACCEPTANCE_CLAIM_NOT_PERSISTED');

  const document = {
    schema_version: '1.0', reviewer_id: 'deep-review', checker_episode_id: checker.id,
    target_maker: maker.id, attempt_id: claim.attemptId, verdict: 'APPROVE',
    report_body: '# host acceptance\n\nAPPROVE',
    artifacts: (maker.expected_artifacts || []).map(path => ({ path, sha256: artifactHash(projectRoot, path) })),
  };
  const inputBytes = JSON.stringify(document);
  if (Buffer.byteLength(inputBytes, 'utf8') > MAX) throw new Error('HOST_ACCEPTANCE_INPUT_TOO_LARGE');
  const args = [
    CLI_PATH, 'review', 'import', '--stdin', '--owner', runId, '--generation', String(fence.generation),
    '--project-root', projectRoot, '--run-id', runId, '--now', NOW,
  ];
  const proc = spawnSync(process.execPath, args, {
    cwd: projectRoot, input: inputBytes, env: evalChildEnv(),
    encoding: 'utf8', timeout: 30_000, maxBuffer: MAX,
  });
  const persisted = readPublicState(projectRoot, runId);
  const imported = persisted.episodes.find(episode => episode.id === checker.id);
  const pass = proc.status === 0 && imported?.status === 'approved'
    && imported?.review_source === 'imported-stdin'
    && imported?.attempt_id === ATTEMPT
    && imported?.target_maker === maker.id;
  const binding = {
    run_id: runId, checker_episode_id: checker.id, target_maker: maker.id,
    workstream_id: workstreamId, point: 'implementation', reviewer_id: checker.plugin,
    review_source: imported?.review_source || null, imported_verdict: pass ? 'APPROVE' : null,
  };
  return {
    task_id: TASK, assertion_id: ASSERTION, executor: EXECUTOR,
    status: pass ? 'pass' : 'fail', attempt_id: claim.attemptId, binding,
    import_exit: typeof proc.status === 'number' ? proc.status : 1,
  };
}

export const HOST_TASK_ID = TASK;
