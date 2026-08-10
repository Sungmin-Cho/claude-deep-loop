import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const VERIFIER = join(ROOT, 'scripts', 'verify-wsu1-f26-actual-run.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

function checksumFor(seq, ts, type, data, prev) {
  return sha256(Buffer.from(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`));
}

function nulChecksumFor(seq, ts, type, data, prev) {
  return sha256(Buffer.from(`${seq}\0${ts}\0${type}\0${JSON.stringify(data)}\0${prev}`));
}

function fixture() {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wsu1-f26-verifier-')));
  const runId = '01WSU1F26TESTACTUALRUN0001';
  const worktreePrefix = '.claude/worktrees/wsu1-acquire-contract';
  const worktree = join(projectRoot, ...worktreePrefix.split('/'));
  const runDir = join(projectRoot, '.deep-loop', 'runs', runId);
  const reviews = join(runDir, 'reviews');
  const fixtures = join(worktree, 'tests', 'fixtures');
  const scripts = join(worktree, 'scripts');
  mkdirSync(join(scripts, 'nested'), { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(reviews, { recursive: true });
  writeFileSync(join(scripts, 'surface.mjs'), 'export function surface() {}\n');
  writeFileSync(join(scripts, 'nested', 'surface-nested.mjs'), 'export const nested = true;\n');
  symlinkSync('surface.mjs', join(scripts, 'surface-decoy.mjs'));
  writeFileSync(join(fixtures, 'activation-pending-classification.seed.md'), 'seed\n');
  writeFileSync(join(fixtures, 'activation-pending-classification.md'), 'live\n');
  writeFileSync(join(fixtures, 'activation-pending-classification-evidence.json'), '{"rows":[]}\n');

  const relativeArtifacts = [
    'scripts/surface.mjs',
    'scripts/nested/surface-nested.mjs',
    'tests/fixtures/activation-pending-classification.seed.md',
    'tests/fixtures/activation-pending-classification.md',
    'tests/fixtures/activation-pending-classification-evidence.json',
  ].sort();
  const artifacts = relativeArtifacts.map((path) => ({
    path: `${worktreePrefix}/${path}`,
    sha256: sha256(readFileSync(join(worktree, ...path.split('/')))),
  }));
  const point = 'wsu1-f26-independent-review';
  const workstreamId = 'ws-010';
  const makerId = '001-deep-work';
  const checkerId = '002-deep-review';
  const attemptId = 'attempt-010';
  const claim = {
    run_id: runId,
    reviewer_id: 'deep-review',
    checker_episode_id: checkerId,
    target_maker: makerId,
    attempt_id: attemptId,
    workstream_id: workstreamId,
    point,
    project_root: projectRoot,
    runtime: 'codex',
    lease_owner: 'owner-010',
    lease_generation: 1,
    artifacts,
  };
  const input = {
    schema_version: '1.0',
    reviewer_id: claim.reviewer_id,
    checker_episode_id: checkerId,
    target_maker: makerId,
    attempt_id: attemptId,
    verdict: 'APPROVE',
    report_body: 'Reviewed residual semantics and conditional public fence wiring.',
    artifacts,
  };
  const envelope = {
    schema_version: '1.0',
    envelope: {
      producer: 'deep-loop',
      artifact_kind: 'review-report',
      schema: { name: 'review-report', version: '1.0' },
      run_id: runId,
      parent_run_id: null,
      generated_at: '2026-08-10T00:00:00.000Z',
      git: {},
      provenance: {
        source_artifacts: artifacts.map(({ path }) => path),
        tool_versions: {},
        review_binding: {
          reviewer_id: input.reviewer_id,
          checker_episode_id: checkerId,
          target_maker: makerId,
          attempt_id: attemptId,
          artifacts,
        },
      },
    },
    payload: { verdict: input.verdict, report_body: input.report_body },
  };
  const reportBytes = Buffer.from(JSON.stringify(envelope, null, 2));
  const reportSha = sha256(reportBytes);
  const reportPath = join(reviews, `${reportSha}.json`);
  writeFileSync(reportPath, reportBytes);
  const processContext = {
    origin_owner: 'owner-010',
    origin_generation: 1,
    checker_episode_id: checkerId,
    attempt_id: attemptId,
    target_maker: makerId,
    claim_hash: sha256(Buffer.from(JSON.stringify(claim))),
  };
  const ts = '2026-08-10T00:00:00.000Z';
  const costData = {
    source: 'codex-checker-measured',
    process_kind: 'checker',
    process_context: processContext,
  };
  const event = { seq: 1, ts, type: 'cost', data: costData };
  event.checksum = checksumFor(event.seq, event.ts, event.type, event.data, 'GENESIS');
  const loop = {
    run_id: runId,
    project: { root: projectRoot },
    autonomy: {
      session_runtime: 'codex', runtime_source: 'skill-asserted', continuation_policy: 'workstream-session',
    },
    session_chain: { lease: { owner_run_id: 'owner-010', generation: 1, resume_policy: 'auto' } },
    workstreams: [{ id: workstreamId, worktree: worktreePrefix }],
    episodes: [
      { id: makerId, role: 'maker', kind: 'implementation', status: 'done', point,
        workstream_id: workstreamId, artifacts: artifacts.map(({ path }) => path) },
      { id: checkerId, role: 'checker', plugin: 'deep-review', status: 'approved', point,
        workstream_id: workstreamId, target_maker: makerId, attempt_id: attemptId,
        review_source: 'imported-stdin', review_claim: claim },
    ],
    event_log_head: { seq: event.seq, checksum: event.checksum },
  };
  const observation = {
    schema_version: 1,
    observer_role: 'orchestrator',
    observer_session_id: 'orchestrator-session-010',
    observed_at: '2026-08-10T00:01:00.000Z',
    project_root: projectRoot,
    worktree: worktreePrefix,
    run_id: runId,
    workstream_id: workstreamId,
    point,
    maker_episode_id: makerId,
    checker_episode_id: checkerId,
    cwd: projectRoot,
    argv: [
      process.execPath,
      join(worktree, 'scripts', 'hooks-impl', 'drive-headless.mjs'),
      '--run-id',
      runId,
    ],
    env: { DEEP_LOOP_UNATTENDED: '1' },
    started_at: '2026-08-10T00:00:00.000Z',
    finished_at: '2026-08-10T00:01:00.000Z',
    exit_code: 0,
    stdout: '{"ok":true,"action":"checker-approved"}\n',
    stderr: '',
    checker_terminal_status: 'approved',
  };
  const loopPath = join(runDir, 'loop.json');
  const eventPath = join(runDir, 'event-log.jsonl');
  const inputPath = join(projectRoot, 'manual-review.json');
  const observationPath = join(projectRoot, 'external-observation.json');
  const receiptPath = join(projectRoot, 'receipt.json');
  writeFileSync(loopPath, `${JSON.stringify(loop, null, 2)}\n`);
  writeFileSync(eventPath, `${JSON.stringify(event)}\n`);
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  writeFileSync(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
  writeFileSync(receiptPath, 'sentinel-receipt-bytes\n');
  return {
    projectRoot, runId, worktreePrefix, worktree, runDir, reportPath, loopPath, eventPath,
    inputPath, observationPath, receiptPath, loop, event, input, observation, envelope,
    writeLoop: () => writeFileSync(loopPath, `${JSON.stringify(loop, null, 2)}\n`),
    writeEvents: (events) => {
      let prev = 'GENESIS';
      events.forEach((item, index) => {
        item.seq = index + 1;
        item.checksum = checksumFor(item.seq, item.ts, item.type, item.data, prev);
        prev = item.checksum;
      });
      loop.event_log_head = events.length
        ? { seq: events.at(-1).seq, checksum: events.at(-1).checksum }
        : { seq: 0, checksum: 'GENESIS' };
      writeFileSync(eventPath, events.map((item) => JSON.stringify(item)).join('\n') + (events.length ? '\n' : ''));
      writeFileSync(loopPath, `${JSON.stringify(loop, null, 2)}\n`);
    },
    writeObservation: () => writeFileSync(observationPath, `${JSON.stringify(observation, null, 2)}\n`),
  };
}

function invoke(fx, extraEnv = {}) {
  const sentinel = readFileSync(fx.receiptPath);
  const result = spawnSync(process.execPath, [
    VERIFIER,
    '--project-root', fx.projectRoot,
    '--run-id', fx.runId,
    '--worktree', fx.worktreePrefix,
    '--point', 'wsu1-f26-independent-review',
    '--import-input', fx.inputPath,
    '--external-observation', fx.observationPath,
    '--receipt', fx.receiptPath,
  ], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  assert.notEqual(result.status, 0, 'negative verifier fixture unexpectedly passed');
  assert.equal(result.stdout, '');
  assert.deepEqual(readFileSync(fx.receiptPath), sentinel, 'negative path changed receipt bytes');
  return result;
}

function verifierArgs(fx) {
  return [
    VERIFIER,
    '--project-root', fx.projectRoot,
    '--run-id', fx.runId,
    '--worktree', fx.worktreePrefix,
    '--point', 'wsu1-f26-independent-review',
    '--import-input', fx.inputPath,
    '--external-observation', fx.observationPath,
    '--receipt', fx.receiptPath,
  ];
}

function negative(name, diagnostic, mutate, extraEnv) {
  test(name, () => {
    const fx = fixture();
    mutate(fx);
    const result = invoke(fx, typeof extraEnv === 'function' ? extraEnv(fx) : extraEnv);
    assert.match(result.stderr, new RegExp(`^${diagnostic}\\n$`));
  });
}

negative('F26-ACTUAL-NEG-NON-CODEX', 'WSU1_F26_NON_CODEX', (fx) => {
  fx.loop.autonomy.session_runtime = 'claude'; fx.writeLoop();
});
negative('F26-ACTUAL-NEG-HUMAN-POLICY', 'WSU1_F26_HUMAN_POLICY', (fx) => {
  fx.loop.session_chain.lease.resume_policy = 'human'; fx.writeLoop();
});
negative('F26-ACTUAL-NEG-SYNTHETIC-RUN', 'WSU1_F26_SYNTHETIC_RUN', (fx) => {
  fx.loop.project.root = join(tmpdir(), 'different-project-root'); fx.writeLoop();
});
negative('F26-ACTUAL-NEG-MISSING-COST-EVENT', 'WSU1_F26_COST_EVENT_COUNT', (fx) => fx.writeEvents([]));
negative('F26-ACTUAL-NEG-DUPLICATE-COST-EVENT', 'WSU1_F26_COST_EVENT_COUNT', (fx) => {
  fx.writeEvents([fx.event, structuredClone(fx.event)]);
});
negative('F26-ACTUAL-NEG-MISSING-REPORT', 'WSU1_F26_REPORT_MISSING', (fx) => unlinkSync(fx.reportPath));
negative('F26-ACTUAL-NEG-CLAIM-CONTEXT-MISMATCH', 'WSU1_F26_CLAIM_CONTEXT', (fx) => {
  fx.loop.episodes[1].review_claim.attempt_id = 'different-attempt'; fx.writeLoop();
});
negative('F26-ACTUAL-NEG-WORKTREE-K-MISMATCH', 'WSU1_F26_WORKTREE_K', (fx) => {
  fx.loop.episodes[0].artifacts = fx.loop.episodes[0].artifacts.slice(1); fx.writeLoop();
});
negative('F26-ACTUAL-NEG-MISSING-OBSERVATION', 'WSU1_F26_OBSERVATION_MISSING', (fx) => {
  unlinkSync(fx.observationPath);
});
negative('F26-ACTUAL-NEG-OBSERVATION-NON-REGULAR', 'WSU1_F26_OBSERVATION_NON_REGULAR', (fx) => {
  const target = join(fx.projectRoot, 'observation-target.json');
  writeFileSync(target, `${JSON.stringify(fx.observation)}\n`);
  unlinkSync(fx.observationPath);
  symlinkSync(target, fx.observationPath);
});
negative('F26-ACTUAL-NEG-OBSERVATION-SHAPE', 'WSU1_F26_OBSERVATION_SHAPE', (fx) => {
  delete fx.observation.observed_at; fx.writeObservation();
});
negative('F26-ACTUAL-NEG-OBSERVATION-RUN-MISMATCH', 'WSU1_F26_OBSERVATION_RUN', (fx) => {
  fx.observation.run_id = '01DIFFERENTRUN00000000000000'; fx.writeObservation();
});
test('F26-ACTUAL-NEG-OBSERVATION-COMMAND-MISMATCH', () => {
  const cases = [
    ['wrong-cwd', (fx) => { fx.observation.cwd = fx.worktree; }],
    ['old-no-run-id', (fx) => { fx.observation.argv = fx.observation.argv.slice(0, 2); }],
    ['missing-run-id-value', (fx) => { fx.observation.argv = fx.observation.argv.slice(0, 3); }],
    ['wrong-run-id', (fx) => { fx.observation.argv[3] = '01WRONGRUN00000000000000000'; }],
  ];
  for (const [name, mutate] of cases) {
    const fx = fixture();
    mutate(fx);
    fx.writeObservation();
    const result = invoke(fx);
    assert.equal(result.stderr, 'WSU1_F26_OBSERVATION_COMMAND\n', name);
  }
});
negative('F26-ACTUAL-NEG-OBSERVATION-RESULT-MISMATCH', 'WSU1_F26_OBSERVATION_RESULT', (fx) => {
  fx.observation.exit_code = 1; fx.writeObservation();
});
negative('F26-ACTUAL-NEG-OBSERVATION-DIGEST-MISMATCH', 'WSU1_F26_OBSERVATION_DIGEST',
  () => {}, () => ({ WSU1_F26_EXPECT_OBSERVATION_SHA256: '0'.repeat(64) }));

test('STEP0-3 verifier test fixture guards the exact external-observation 20-key contract', () => {
  const fx = fixture();
  assert.equal(exactKeys(fx.observation, [
    'schema_version', 'observer_role', 'observer_session_id', 'observed_at', 'project_root', 'worktree',
    'run_id', 'workstream_id', 'point', 'maker_episode_id', 'checker_episode_id', 'cwd', 'argv', 'env',
    'started_at', 'finished_at', 'exit_code', 'stdout', 'stderr', 'checker_terminal_status',
  ]), true);
});

test('STEP0-3 verifier source uses only baseline Node20 Dirent fields and non-recursive readdir', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  assert.doesNotMatch(source, /\.parentPath\b/);
  assert.doesNotMatch(source, /readdirSync\([^)]*recursive\s*:\s*true/);
});

test('F26-ACTUAL-NEG-NUL-CHECKSUM rejects an otherwise coherent non-production checksum chain', () => {
  const fx = fixture();
  fx.event.checksum = nulChecksumFor(
    fx.event.seq, fx.event.ts, fx.event.type, fx.event.data, 'GENESIS',
  );
  fx.loop.event_log_head = { seq: fx.event.seq, checksum: fx.event.checksum };
  writeFileSync(fx.eventPath, `${JSON.stringify(fx.event)}\n`);
  fx.writeLoop();
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WSU1_F26_EVENT_LOG\n');
});

test('STEP0-3 coherent synthetic verifier fixture reaches exact success and atomically issues receipt', () => {
  const fx = fixture();
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(readFileSync(fx.receiptPath, 'utf8'));
  assert.deepEqual(Object.keys(receipt), [
    'run_id', 'workstream_id', 'worktree_prefix', 'point', 'scope', 'reviewed_source_sha256',
    'live_classification_sha256', 'evidence_rows_sha256', 'checker_cost_event',
    'external_observation', 'report_path', 'report_sha256', 'envelope',
  ]);
  assert.equal(receipt.run_id, fx.runId);
  assert.equal(receipt.scope, 'X_E_RESIDUAL_REASON_SEMANTICS+L_CONDITIONAL_DOMINANCE');
  assert.equal(receipt.checker_cost_event.claim_hash,
    sha256(Buffer.from(JSON.stringify(fx.loop.episodes[1].review_claim))));
  assert.equal(receipt.external_observation.observer_session_id, fx.observation.observer_session_id);
  assert.deepEqual(receipt.envelope, fx.envelope);
});
