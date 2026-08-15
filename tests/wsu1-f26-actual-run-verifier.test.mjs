import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenize } from './helpers/wsu1-f26-static-analyzer.mjs';
import { writeExactDualCapture } from './helpers/dual-capture.mjs';
import {
  createDirectoryJunction, createFileSymlink, createFileSymlinkOrSkip,
} from './helpers/fs-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const VERIFIER = join(ROOT, 'scripts', 'verify-wsu1-f26-actual-run.mjs');
const ATOMIC_WRITE = join(ROOT, 'scripts', 'lib', 'atomic-write.mjs');
const DUAL_CHECKER = join(ROOT, 'scripts', 'lib', 'dual-checker.mjs');
const NODE20_TRAVERSAL_SOURCES = [
  VERIFIER,
  join(HERE, 'helpers', 'baseline-node20-walk.mjs'),
  join(HERE, 'helpers', 'wsu1-f26-link-only-extractor.mjs'),
  join(HERE, 'activation-surface-classification.test.mjs'),
  join(HERE, 'terminal-cli.test.mjs'),
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

test('P7 verifier exposes two imports, one authenticated host observation, and two provider process proofs', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  for (const flag of [
    '--import-input-a', '--import-input-b',
    '--host-observation',
  ]) assert.match(source, new RegExp(flag));
  assert.doesNotMatch(source, /'--import-input',|'--external-observation(?:-a|-b)?',/u);
  assert.match(source, /WSU1_F26_EXPECT_HOST_OBSERVATION_SHA256/u);
  assert.match(source, /provider_process_proofs/u);
  for (const diagnostic of [
    'WSU1_F26_DUAL_INPUT_COUNT', 'WSU1_F26_DUAL_IDENTITY_COLLISION',
    'WSU1_F26_DUAL_SOURCE_MISMATCH', 'WSU1_F26_DUAL_REPORT_PROOF',
    'WSU1_F26_DUAL_PROCESS_PROOF', 'WSU1_F26_DUAL_COST_PROOF',
    'WSU1_F26_DUAL_OBSERVATION', 'WSU1_F26_DUAL_AGGREGATE_ORDER',
    'WSU1_F26_SYNTHETIC_AGGREGATE',
  ]) assert.match(source, new RegExp(diagnostic));
});

function checksumFor(seq, ts, type, data, prev) {
  return sha256(Buffer.from(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`));
}

function nulChecksumFor(seq, ts, type, data, prev) {
  return sha256(Buffer.from(`${seq}\0${ts}\0${type}\0${JSON.stringify(data)}\0${prev}`));
}

function baselineNode20TraversalViolations(source, file = '<source>') {
  const tokens = tokenize(source, file);
  const violations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value === 'parentPath') violations.push('Dirent.parentPath');
    if (tokens[index].value !== 'readdirSync' || tokens[index + 1]?.value !== '(') continue;
    let depth = 0;
    let close = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value === '(') depth += 1;
      if (tokens[cursor].value === ')') depth -= 1;
      if (depth === 0) { close = cursor; break; }
    }
    assert.notEqual(close, -1, `${file}: unbalanced readdirSync call`);
    for (let cursor = index + 2; cursor < close; cursor += 1) {
      if (tokens[cursor].value === 'recursive' && tokens[cursor + 1]?.value === ':') {
        violations.push('recursive readdirSync');
      }
    }
    index = close;
  }
  return violations;
}

function fixture({
  scriptDecoy = null, ignoredRuntime = false, includeIgnoredArtifact = true, testContext = null,
} = {}) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wsu1-f26-verifier-')));
  const runId = '01WSU1F26TESTACTUALRUN0001';
  const worktreePrefix = '.claude/worktrees/wsu1-acquire-contract';
  const worktree = join(projectRoot, ...worktreePrefix.split('/'));
  const runDir = join(projectRoot, '.deep-loop', 'runs', runId);
  const reviews = join(runDir, 'reviews');
  const captures = join(runDir, 'checker-captures');
  const processReceipts = join(runDir, 'preflight', 'process-receipts');
  const fixtures = join(worktree, 'tests', 'fixtures');
  const scripts = join(worktree, 'scripts');
  mkdirSync(join(scripts, 'nested'), { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(reviews, { recursive: true });
  mkdirSync(captures, { recursive: true });
  mkdirSync(processReceipts, { recursive: true });
  const imports = [];
  writeFileSync(join(scripts, 'nested', 'surface-nested.mjs'), 'export const nested = true;\n');
  if (scriptDecoy === 'file') {
    const outside = join(projectRoot, 'outside-file.mjs');
    writeFileSync(outside, 'export const outside = true;\n');
    if (testContext && !createFileSymlinkOrSkip(testContext, outside, join(scripts, 'imported-decoy.mjs'))) {
      return null;
    }
    if (!testContext) createFileSymlink(outside, join(scripts, 'imported-decoy.mjs'));
    imports.push("import './imported-decoy.mjs';");
  }
  if (scriptDecoy === 'directory') {
    const outsideScripts = join(projectRoot, 'outside-scripts');
    mkdirSync(outsideScripts);
    writeFileSync(join(outsideScripts, 'outside.mjs'), 'export const outside = true;\n');
    createDirectoryJunction(outsideScripts, join(scripts, 'directory-decoy'));
    imports.push("import './directory-decoy/outside.mjs';");
  }
  if (ignoredRuntime) {
    const initialized = spawnSync('git', ['init', '--quiet', worktree], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    writeFileSync(join(worktree, '.gitignore'), 'scripts/ignored-runtime.mjs\n');
    writeFileSync(join(scripts, 'ignored-runtime.mjs'), 'export const ignoredRuntime = true;\n');
    imports.push("import './ignored-runtime.mjs';");
  }
  writeFileSync(join(scripts, 'surface.mjs'), `${imports.join('\n')}${imports.length ? '\n' : ''}export function surface() {}\n`);
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
  if (ignoredRuntime && includeIgnoredArtifact) relativeArtifacts.push('scripts/ignored-runtime.mjs');
  relativeArtifacts.sort();
  const artifacts = relativeArtifacts.map((path) => ({
    path: `${worktreePrefix}/${path}`,
    sha256: sha256(readFileSync(join(worktree, ...path.split('/')))),
  }));
  const point = 'wsu1-f26-independent-review';
  const workstreamId = 'ws-010';
  const makerId = '001-deep-work';
  const checkerId = '002-deep-review';
  const aggregationId = 'aggregation-010';
  const sourceWithoutDigest = {
    run_id: runId,
    checker_episode_id: checkerId,
    target_maker: makerId,
    workstream_id: workstreamId,
    point,
    project_root: projectRoot,
    runtime: 'codex',
    lease_owner: 'owner-010',
    lease_generation: 1,
    artifacts,
  };
  const sourceClaimSha256 = sha256(Buffer.from(JSON.stringify(sourceWithoutDigest)));
  const sourceBinding = { ...sourceWithoutDigest, source_claim_sha256: sourceClaimSha256 };
  const routes = [
    {
      slot: 0, attempt_id: 'attempt-010-a', reviewer_id: 'deep-review',
      reviewer_adapter: 'codex-checker', provider_id: 'openai-codex',
      model_id: 'gpt-5.6-sol', session_id: '11111111-1111-4111-8111-111111111111',
    },
    {
      slot: 1, attempt_id: 'attempt-010-b', reviewer_id: 'grok-review',
      reviewer_adapter: 'grok-checker', provider_id: 'xai-grok',
      model_id: 'grok-4.6', session_id: '22222222-2222-4222-8222-222222222222',
    },
  ];
  const usage = [
    { num_turns: 1, input_tokens: 17, output_tokens: 5, tokens: 22 },
    { num_turns: 1, input_tokens: 19, output_tokens: 7, tokens: 26 },
  ];
  const attempts = [];
  const inputs = [];
  const envelopes = [];
  const reportPaths = [];
  const receiptObjects = [];
  for (const route of routes) {
    const { proof: captureProof } = writeExactDualCapture({
      root: projectRoot,
      runId,
      checkerEpisodeId: checkerId,
      attemptId: route.attempt_id,
      sourceClaimSha256,
      manifest: Buffer.from(`manifest:${route.reviewer_id}`),
      skill: Buffer.from(`skill:${route.reviewer_adapter}`),
    });
    const identity = {
      aggregation_id: aggregationId,
      slot: route.slot,
      attempt_id: route.attempt_id,
      reviewer_id: route.reviewer_id,
      reviewer_adapter: route.reviewer_adapter,
      provider_id: route.provider_id,
      model_id: route.model_id,
      source_claim_sha256: sourceClaimSha256,
    };
    const receiptPayload = {
      contract: 'deep-loop-dual-checker-process-receipt-v1',
      project_root: projectRoot,
      run_id: runId,
      ...identity,
      session_id: route.session_id,
      claim_hash: sha256(Buffer.from(JSON.stringify(identity))),
      capture: captureProof,
      stdout_sha256: sha256(Buffer.from(`stdout:${route.attempt_id}`)),
      stderr_sha256: sha256(Buffer.from(`stderr:${route.attempt_id}`)),
      usage: usage[route.slot],
    };
    const receipt = {
      ...receiptPayload, receipt_id: sha256(Buffer.from(JSON.stringify(receiptPayload))),
    };
    receiptObjects.push(receipt);
    const receiptRel = `.deep-loop/runs/${runId}/preflight/process-receipts/${receipt.receipt_id}-dual-checker.json`;
    writeFileSync(join(projectRoot, ...receiptRel.split('/')), JSON.stringify(receipt, null, 2));
    const input = {
      schema_version: '2.0',
      aggregation_id: aggregationId,
      reviewer_id: route.reviewer_id,
      reviewer_adapter: route.reviewer_adapter,
      provider_id: route.provider_id,
      model_id: route.model_id,
      session_id: route.session_id,
      checker_episode_id: checkerId,
      target_maker: makerId,
      attempt_id: route.attempt_id,
      source_claim_sha256: sourceClaimSha256,
      verdict: 'APPROVE',
      report_body: `Independent review ${route.slot + 1} approved the bounded source contract.`,
      artifacts,
    };
    inputs.push(input);
    attempts.push({
      ...route,
      status: 'imported',
      source_claim_sha256: sourceClaimSha256,
      capture_proof: captureProof,
      process_proof: {
        receipt_id: receipt.receipt_id,
        receipt: receiptRel,
        provider_id: route.provider_id,
        model_id: route.model_id,
        session_id: route.session_id,
        claim_hash: receipt.claim_hash,
        stdout_sha256: receipt.stdout_sha256,
        stderr_sha256: receipt.stderr_sha256,
      },
      report_proof: null,
      cost_proof: {
        receipt_id: receipt.receipt_id,
        event_seq: route.slot + 1,
        event_checksum: null,
        usage: usage[route.slot],
      },
    });
  }

  for (const route of routes) {
    const attempt = attempts[route.slot];
    const input = inputs[route.slot];
    const envelope = {
      schema_version: '1.0',
      envelope: {
        producer: 'deep-loop',
        artifact_kind: 'review-attempt-report',
        schema: { name: 'review-attempt-report', version: '2.0' },
        run_id: runId,
        parent_run_id: null,
        generated_at: `2026-08-10T00:00:0${route.slot + 2}.000Z`,
        git: {},
        provenance: {
          source_artifacts: artifacts.map(({ path }) => path),
          tool_versions: {},
          review_binding: {
            aggregation_id: aggregationId,
            reviewer_id: route.reviewer_id,
            reviewer_adapter: route.reviewer_adapter,
            provider_id: route.provider_id,
            model_id: route.model_id,
            session_id: route.session_id,
            checker_episode_id: checkerId,
            target_maker: makerId,
            attempt_id: route.attempt_id,
            source_claim_sha256: sourceClaimSha256,
            process_receipt_id: attempt.process_proof.receipt_id,
            cost_event_seq: attempt.cost_proof.event_seq,
            capture_sha256: attempt.capture_proof.record_sha256,
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
    envelopes.push(envelope);
    reportPaths.push(reportPath);
    attempt.report_proof = {
      verdict: 'APPROVE',
      report: `.deep-loop/runs/${runId}/reviews/${reportSha}.json`,
      report_sha256: reportSha,
      event_seq: route.slot + 3,
      event_checksum: null,
    };
  }

  const ts = '2026-08-10T00:00:00.000Z';
  const events = attempts.map(attempt => ({
    ts,
    type: 'cost',
    data: {
      turns: attempt.cost_proof.usage.num_turns,
      tokens: attempt.cost_proof.usage.tokens,
      reported_turns: attempt.cost_proof.usage.num_turns,
      reported_tokens: attempt.cost_proof.usage.tokens,
      input_tokens: attempt.cost_proof.usage.input_tokens,
      output_tokens: attempt.cost_proof.usage.output_tokens,
      owner: 'owner-010',
      generation: 1,
      source: `${attempt.provider_id}-dual-checker-measured`,
      process_receipt_id: attempt.process_proof.receipt_id,
      dual_checker_aggregation_id: aggregationId,
      dual_checker_attempt_id: attempt.attempt_id,
      provider_id: attempt.provider_id,
      model_id: attempt.model_id,
      session_id: attempt.session_id,
    },
  }));
  for (const attempt of attempts) {
    events.push({
      ts,
      type: 'review-attempt-outcome',
      data: {
        episodeId: checkerId,
        aggregation_id: aggregationId,
        attempt_id: attempt.attempt_id,
        reviewer_id: attempt.reviewer_id,
        reviewer_adapter: attempt.reviewer_adapter,
        provider_id: attempt.provider_id,
        model_id: attempt.model_id,
        session_id: attempt.session_id,
        target_maker: makerId,
        verdict: 'APPROVE',
        report: attempt.report_proof.report,
        report_sha256: attempt.report_proof.report_sha256,
        process_receipt_id: attempt.process_proof.receipt_id,
        cost_event_seq: attempt.cost_proof.event_seq,
        capture_sha256: attempt.capture_proof.record_sha256,
        source_claim_sha256: sourceClaimSha256,
      },
    });
  }
  const aggregate = {
    aggregation_id: aggregationId,
    checker_episode_id: checkerId,
    target_maker: makerId,
    source_claim_sha256: sourceClaimSha256,
    attempt_ids: attempts.map(attempt => attempt.attempt_id),
    reviewer_ids: attempts.map(attempt => attempt.reviewer_id),
    reviewer_adapters: attempts.map(attempt => attempt.reviewer_adapter),
    provider_ids: attempts.map(attempt => attempt.provider_id),
    model_ids: attempts.map(attempt => attempt.model_id),
    session_ids: attempts.map(attempt => attempt.session_id),
    attempt_reports: attempts.map(attempt => attempt.report_proof.report),
    report_hashes: attempts.map(attempt => attempt.report_proof.report_sha256),
    process_receipts: attempts.map(attempt => attempt.process_proof.receipt),
    process_receipt_ids: attempts.map(attempt => attempt.process_proof.receipt_id),
    cost_event_seqs: attempts.map(attempt => attempt.cost_proof.event_seq),
    capture_ids: attempts.map(attempt => attempt.capture_proof.capture_id),
    capture_records: attempts.map(attempt => attempt.capture_proof.record_path),
    capture_hashes: attempts.map(attempt => attempt.capture_proof.record_sha256),
  };
  events.push({
    ts,
    type: 'review-outcome',
    data: {
      episodeId: checkerId,
      verdict: 'APPROVE',
      workstream_id: workstreamId,
      point,
      target_maker: makerId,
      reviewer_id: 'dual-checker-aggregate',
      review_source: 'imported-stdin',
      ...aggregate,
    },
  });
  let previous = 'GENESIS';
  events.forEach((event, index) => {
    event.seq = index + 1;
    event.checksum = checksumFor(event.seq, event.ts, event.type, event.data, previous);
    previous = event.checksum;
  });
  attempts.forEach((attempt, index) => {
    attempt.cost_proof.event_checksum = events[index].checksum;
    attempt.report_proof.event_checksum = events[index + 2].checksum;
  });
  const aggregateEvent = events.at(-1);
  const loop = {
    schema_version: '0.5.0',
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
        workstream_id: workstreamId, target_maker: makerId,
        review_source: 'imported-stdin',
        review_aggregation: {
          schema_version: '2.0',
          policy: 'ALL_LITERAL_APPROVE_2',
          aggregation_id: aggregationId,
          required_attempt_count: 2,
          aggregate_status: 'approved',
          source_binding: sourceBinding,
          attempts,
          aggregate_proof: {
            source_claim_sha256: sourceClaimSha256,
            attempt_ids: aggregate.attempt_ids,
            report_hashes: aggregate.report_hashes,
            process_receipt_ids: aggregate.process_receipt_ids,
            cost_event_seqs: aggregate.cost_event_seqs,
            capture_hashes: aggregate.capture_hashes,
            final_event_seq: aggregateEvent.seq,
            final_event_checksum: aggregateEvent.checksum,
          },
        } },
    ],
    event_log_head: { seq: aggregateEvent.seq, checksum: aggregateEvent.checksum },
  };
  const hostResult = `${JSON.stringify({
    ok: true,
    action: 'checker-complete',
    checkerEpisodeId: checkerId,
    attemptId: attempts[1].attempt_id,
  })}\n`;
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
      '--project-root', projectRoot, '--run-id', runId,
    ],
    env: { DEEP_LOOP_UNATTENDED: '1' },
    started_at: '2026-08-10T00:00:00.000Z',
    finished_at: '2026-08-10T00:01:00.000Z',
    exit_code: 0,
    stdout: hostResult,
    stderr: '',
    checker_terminal_status: 'approved',
  };
  const loopPath = join(runDir, 'loop.json');
  const loopHashPath = join(runDir, '.loop.hash');
  const eventPath = join(runDir, 'event-log.jsonl');
  const inputPaths = [join(projectRoot, 'manual-review-a.json'), join(projectRoot, 'manual-review-b.json')];
  const observationPath = join(projectRoot, 'host-observation.json');
  const receiptPath = join(projectRoot, 'receipt.json');
  const writeLoop = () => {
    const bytes = Buffer.from(`${JSON.stringify(loop, null, 2)}\n`);
    writeFileSync(loopPath, bytes);
    writeFileSync(loopHashPath, sha256(bytes));
  };
  writeLoop();
  writeFileSync(eventPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`);
  inputPaths.forEach((path, index) => writeFileSync(path, `${JSON.stringify(inputs[index], null, 2)}\n`));
  writeFileSync(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
  writeFileSync(receiptPath, 'sentinel-receipt-bytes\n');
  return {
    projectRoot, runId, worktreePrefix, worktree, runDir,
    reportPath: reportPaths[0], reportPaths, loopPath, loopHashPath, eventPath,
    inputPath: inputPaths[0], inputPaths, observationPath,
    receiptPath, loop, event: events[0], events, input: inputs[0], inputs,
    observation, envelope: envelopes[0], envelopes,
    expectedHostObservationSha256: sha256(readFileSync(observationPath)),
    writeLoop,
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
      writeLoop();
    },
    writeObservation: () => writeFileSync(
      observationPath, `${JSON.stringify(observation, null, 2)}\n`,
    ),
    writeInput: (index = 0) => writeFileSync(
      inputPaths[index], `${JSON.stringify(inputs[index], null, 2)}\n`,
    ),
  };
}

function invoke(fx, extraEnv = {}) {
  const sentinel = readFileSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), {
    encoding: 'utf8', env: verifierEnv(fx, extraEnv),
  });
  assert.notEqual(result.status, 0, 'negative verifier fixture unexpectedly passed');
  assert.equal(result.stdout, '');
  assert.deepEqual(readFileSync(fx.receiptPath), sentinel, 'negative path changed receipt bytes');
  return result;
}

function invokeWithoutReceipt(fx, extraEnv = {}) {
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), {
    encoding: 'utf8', env: verifierEnv(fx, extraEnv),
  });
  assert.notEqual(result.status, 0, 'negative verifier fixture unexpectedly passed');
  assert.equal(result.stdout, '');
  assert.equal(lstatOrNull(fx.receiptPath), null, 'negative path created a receipt');
  return result;
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function verifierArgs(fx) {
  return [
    VERIFIER,
    '--project-root', fx.projectRoot,
    '--run-id', fx.runId,
    '--worktree', fx.worktreePrefix,
    '--point', 'wsu1-f26-independent-review',
    '--import-input-a', fx.inputPaths[0],
    '--import-input-b', fx.inputPaths[1],
    '--host-observation', fx.observationPath,
    '--receipt', fx.receiptPath,
  ];
}

function verifierEnv(fx, extraEnv = {}) {
  let digest = fx.expectedHostObservationSha256;
  try { digest = sha256(readFileSync(fx.observationPath)); } catch { /* missing is verifier-owned */ }
  return {
    ...process.env,
    WSU1_F26_EXPECT_HOST_OBSERVATION_SHA256: digest,
    ...extraEnv,
  };
}

function runnerVerifierSource() {
  return readFileSync(VERIFIER, 'utf8').replace(
    "'./lib/dual-checker.mjs'",
    JSON.stringify(pathToFileURL(DUAL_CHECKER).href),
  );
}

function invokeReceiptTarget(fx, receiptTarget, { cwd = ROOT } = {}) {
  if (lstatOrNull(fx.receiptPath)) unlinkSync(fx.receiptPath);
  const args = verifierArgs(fx);
  args[args.indexOf('--receipt') + 1] = receiptTarget;
  const absoluteTarget = resolve(cwd, receiptTarget);
  const before = lstatOrNull(absoluteTarget);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd, env: verifierEnv(fx) });
  assert.notEqual(result.status, 0, 'protected receipt target unexpectedly passed');
  assert.equal(result.stdout, '');
  const after = lstatOrNull(absoluteTarget);
  if (before === null) assert.equal(after, null, 'protected receipt target was created');
  else assert.equal(after?.isSymbolicLink(), before.isSymbolicLink(), 'protected receipt target type changed');
  const parent = dirname(absoluteTarget);
  if (lstatOrNull(parent)?.isDirectory()) {
    assert.equal(readdirSync(parent).some((name) => name.startsWith(`${basename(absoluteTarget)}.tmp-`)), false,
      'protected receipt temporary was created');
  }
  return result;
}

function invokeWithSourceRace(fx, mutationSource) {
  const runnerRoot = mkdtempSync(join(tmpdir(), 'wsu1-f26-race-runner-'));
  const runnerScripts = join(runnerRoot, 'scripts');
  mkdirSync(join(runnerScripts, 'lib'), { recursive: true });
  const source = runnerVerifierSource();
  const seam = '  verifySourceArtifactsUnchanged(worktree, relativeContract); // K_BOUNDARY_PRE_PUBLICATION';
  assert.equal(source.split(seam).length, 2, 'pre-publication source recheck must have one unambiguous seam');
  writeFileSync(join(runnerScripts, 'verify.mjs'), source.replace(seam, `  ${mutationSource}\n${seam}`));
  writeFileSync(join(runnerScripts, 'lib', 'atomic-write.mjs'), readFileSync(ATOMIC_WRITE));
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, [join(runnerScripts, 'verify.mjs'), ...verifierArgs(fx).slice(1)], {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.notEqual(result.status, 0, 'source race unexpectedly minted a receipt');
  assert.equal(result.stdout, '');
  assert.equal(lstatOrNull(fx.receiptPath), null, 'source race created a receipt');
  return result;
}

function invokeWithReceiptParentRace(fx, boundary, { preexistingBytes = null } = {}) {
  const runnerRoot = mkdtempSync(join(tmpdir(), 'wsu1-f26-parent-race-'));
  const runnerScripts = join(runnerRoot, 'scripts');
  mkdirSync(join(runnerScripts, 'lib'), { recursive: true });
  const target = join(fx.projectRoot, 'race-receipts', 'verified.json');
  mkdirSync(dirname(target));
  if (preexistingBytes !== null) writeFileSync(target, preexistingBytes);
  const held = `${dirname(target)}-held`;
  const replacement = [
    `process.getBuiltinModule('node:fs').renameSync(${JSON.stringify(dirname(target))}, ${JSON.stringify(held)});`,
    `process.getBuiltinModule('node:fs').mkdirSync(${JSON.stringify(dirname(target))});`,
  ].join('\n');
  const marker = `// RECEIPT_BOUNDARY_${boundary}`;
  const source = runnerVerifierSource();
  assert.equal(source.split(marker).length, 2, `${boundary} boundary must be unique`);
  const markerIndex = source.indexOf(marker);
  const markerLine = source.lastIndexOf('\n', markerIndex) + 1;
  const markerLineEnd = source.indexOf('\n', markerIndex);
  const crossed = join(runnerRoot, `crossed-${boundary}`);
  writeFileSync(join(runnerScripts, 'verify.mjs'),
    `${source.slice(0, markerLine)}  ${replacement}\n${source.slice(markerLine, markerLineEnd + 1)}`
    + `  process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(crossed)}, 'crossed');\n`
    + source.slice(markerLineEnd + 1));
  writeFileSync(join(runnerScripts, 'lib', 'atomic-write.mjs'), readFileSync(ATOMIC_WRITE));
  unlinkSync(fx.receiptPath);
  const args = verifierArgs(fx);
  args[args.indexOf('--receipt') + 1] = target;
  const result = spawnSync(process.execPath, [join(runnerScripts, 'verify.mjs'), ...args.slice(1)], {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.notEqual(result.status, 0, `${boundary} parent race unexpectedly passed`);
  assert.equal(lstatOrNull(crossed), null, `${boundary} guard allowed control to cross the drift boundary`);
  assert.equal(result.stdout, '');
  assert.equal(lstatOrNull(target), null, `${boundary} parent race left a target receipt`);
  assert.equal(lstatSync(dirname(target)).isDirectory(), true);
  assert.equal(lstatOrNull(join(fx.worktree, 'scripts', 'verified.json')), null,
    `${boundary} parent race wrote into K`);
  const heldEntries = readdirSync(held);
  if (preexistingBytes !== null) {
    assert.deepEqual(readFileSync(join(held, basename(target))), preexistingBytes,
      `${boundary} parent race changed the pre-existing receipt`);
  } else if (boundary === 'PRE_OPEN') {
    assert.deepEqual(heldEntries, []);
  } else {
    // Node exposes no portable openat/unlinkat handle. Once the caller-owned parent is renamed
    // away, fail-closed means no VERIFIED/current-target/K artifact, not zero unreachable residue.
    assert.equal(heldEntries.every((name) => name === basename(target)
      || name.startsWith(`${basename(target)}.tmp-`)), true);
  }
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  assert.doesNotMatch(result.stderr, /race-receipts|verified\.json|scripts|wsu1-f26-verifier-/u);
}

function invokeWithReachablePostPublicationFailure(fx, { competingReceiptBytes = null } = {}) {
  const runnerRoot = mkdtempSync(join(tmpdir(), 'wsu1-f26-cleanup-race-'));
  const runnerScripts = join(runnerRoot, 'scripts');
  mkdirSync(join(runnerScripts, 'lib'), { recursive: true });
  const source = runnerVerifierSource();
  const marker = '  verifyReceiptParent(binding); // RECEIPT_BOUNDARY_POST_PUBLICATION';
  assert.equal(source.split(marker).length, 2, 'post-publication boundary must be unique');
  const receiptReplacement = competingReceiptBytes === null ? '' : [
    `process.getBuiltinModule('node:fs').unlinkSync(${JSON.stringify(fx.receiptPath)});`,
    `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(fx.receiptPath)},`,
    `  Buffer.from(${JSON.stringify(competingReceiptBytes.toString('base64'))}, 'base64'));`,
  ].join('\n    ');
  const mutation = [receiptReplacement,
    `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(
      join(fx.worktree, 'scripts', 'surface.mjs'),
    )}, 'post-publication drift\\n');`].filter(Boolean).join('\n    ');
  writeFileSync(join(runnerScripts, 'verify.mjs'), source.replace(marker, `${marker}\n    ${mutation}`));
  writeFileSync(join(runnerScripts, 'lib', 'atomic-write.mjs'), readFileSync(ATOMIC_WRITE));
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, [join(runnerScripts, 'verify.mjs'), ...verifierArgs(fx).slice(1)], {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.notEqual(result.status, 0, 'post-publication K drift unexpectedly passed');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  if (competingReceiptBytes === null) {
    assert.equal(lstatOrNull(fx.receiptPath), null, 'new receipt survived reachable cleanup');
  } else {
    assert.deepEqual(readFileSync(fx.receiptPath), competingReceiptBytes,
      'identity-safe cleanup removed or changed a competing receipt');
  }
}

function invokeWithLinkObservationReplacement(fx) {
  const runnerRoot = mkdtempSync(join(tmpdir(), 'wsu1-f26-link-observe-race-'));
  const runnerScripts = join(runnerRoot, 'scripts');
  mkdirSync(join(runnerScripts, 'lib'), { recursive: true });
  const target = join(fx.projectRoot, 'link-observe-race', 'verified.json');
  const competitor = Buffer.from('competing receipt before lstat must survive\n');
  const source = runnerVerifierSource();
  const seam = '    linkSync(temporary, path);';
  assert.equal(source.split(seam).length, 2, 'link publication seam must be unique');
  const replacement = [
    seam,
    `    process.getBuiltinModule('node:fs').unlinkSync(path);`,
    `    process.getBuiltinModule('node:fs').writeFileSync(path,`,
    `      Buffer.from(${JSON.stringify(competitor.toString('base64'))}, 'base64'));`,
  ].join('\n');
  writeFileSync(join(runnerScripts, 'verify.mjs'), source.replace(seam, replacement));
  writeFileSync(join(runnerScripts, 'lib', 'atomic-write.mjs'), readFileSync(ATOMIC_WRITE));
  unlinkSync(fx.receiptPath);
  const args = verifierArgs(fx);
  args[args.indexOf('--receipt') + 1] = target;
  const result = spawnSync(process.execPath, [join(runnerScripts, 'verify.mjs'), ...args.slice(1)], {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.notEqual(result.status, 0, 'link-to-lstat replacement unexpectedly passed');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  assert.deepEqual(readFileSync(target), competitor, 'identity mismatch cleanup deleted the competitor');
  assert.equal(readdirSync(dirname(target)).some(name => name.startsWith(`${basename(target)}.tmp-`)), false,
    'identity mismatch cleanup retained the verifier-owned temporary');
  assert.doesNotMatch(result.stderr, /link-observe-race|verified\.json|competing/u);
}

function invokeWithFinalReceiptDrift(fx, kind) {
  const runnerRoot = mkdtempSync(join(tmpdir(), 'wsu1-f26-final-receipt-race-'));
  const runnerScripts = join(runnerRoot, 'scripts');
  mkdirSync(join(runnerScripts, 'lib'), { recursive: true });
  const source = runnerVerifierSource();
  const seam = '    verifySourceArtifactsUnchanged(worktree, relativeContract);';
  assert.equal(source.split(seam).length, 2, 'final K boundary must have one unambiguous seam');
  const competitor = Buffer.from('foreign receipt installed after the final K check\n');
  const mutation = kind === 'replacement' ? [
    `process.getBuiltinModule('node:fs').unlinkSync(${JSON.stringify(fx.receiptPath)});`,
    `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(fx.receiptPath)},`,
    `  Buffer.from(${JSON.stringify(competitor.toString('base64'))}, 'base64'));`,
  ].join('\n    ') : [
    `const receiptBytesAfterK = process.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(fx.receiptPath)});`,
    'receiptBytesAfterK[0] ^= 1;',
    `process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(fx.receiptPath)}, receiptBytesAfterK);`,
  ].join('\n    ');
  writeFileSync(join(runnerScripts, 'verify.mjs'), source.replace(seam, `${seam}\n    ${mutation}`));
  writeFileSync(join(runnerScripts, 'lib', 'atomic-write.mjs'), readFileSync(ATOMIC_WRITE));
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, [join(runnerScripts, 'verify.mjs'), ...verifierArgs(fx).slice(1)], {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.notEqual(result.status, 0, `final receipt ${kind} drift unexpectedly passed`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  if (kind === 'replacement') {
    assert.deepEqual(readFileSync(fx.receiptPath), competitor,
      'identity-safe cleanup removed or changed the post-K competitor');
  } else {
    assert.equal(lstatOrNull(fx.receiptPath), null,
      'same-inode corruption of the verifier-owned receipt survived cleanup');
  }
  assert.doesNotMatch(result.stderr, /final-receipt-race|receipt\.json|foreign/u);
}

function invokeWithinFinalReceiptVerification(fx, boundary) {
  const runnerRoot = mkdtempSync(join(tmpdir(), 'wsu1-f26-final-receipt-read-race-'));
  const runnerScripts = join(runnerRoot, 'scripts');
  mkdirSync(join(runnerScripts, 'lib'), { recursive: true });
  const source = runnerVerifierSource();
  const marker = `// RECEIPT_VERIFICATION_${boundary}`;
  assert.equal(source.split(marker).length, 2, `${boundary} receipt verification boundary must be unique`);
  const competitor = Buffer.from(`foreign receipt at ${boundary}\n`);
  const replacement = boundary === 'POST_READ' ? [
    `const receiptBytesDuringRead = process.getBuiltinModule('node:fs').readFileSync(path);`,
    'receiptBytesDuringRead[0] ^= 1;',
    `process.getBuiltinModule('node:fs').writeFileSync(path, receiptBytesDuringRead);`,
  ] : [
    `process.getBuiltinModule('node:fs').unlinkSync(path);`,
    `process.getBuiltinModule('node:fs').writeFileSync(path,`,
    `  Buffer.from(${JSON.stringify(competitor.toString('base64'))}, 'base64'));`,
  ];
  writeFileSync(join(runnerScripts, 'verify.mjs'), source.replace(marker, `${marker}\n    ${replacement.join('\n    ')}`));
  writeFileSync(join(runnerScripts, 'lib', 'atomic-write.mjs'), readFileSync(ATOMIC_WRITE));
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, [join(runnerScripts, 'verify.mjs'), ...verifierArgs(fx).slice(1)], {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.notEqual(result.status, 0, `${boundary} receipt verification race unexpectedly passed`);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  if (boundary === 'POST_READ') {
    assert.equal(lstatOrNull(fx.receiptPath), null,
      `${boundary} same-inode corruption of the verifier-owned receipt survived cleanup`);
  } else {
    assert.deepEqual(readFileSync(fx.receiptPath), competitor,
      `${boundary} identity-safe cleanup removed or changed the competitor`);
  }
  assert.doesNotMatch(result.stderr, /final-receipt-read-race|receipt\.json|foreign/u);
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
test('F26-ACTUAL-NEG-RUN-INTEGRITY requires the anchored loop bytes without leaking evidence', () => {
  const cases = [
    ['missing-hash', (fx) => unlinkSync(fx.loopHashPath)],
    ['malformed-hash', (fx) => writeFileSync(fx.loopHashPath, 'not-a-sha256')],
    ['mismatched-hash', (fx) => writeFileSync(fx.loopHashPath, '0'.repeat(64))],
    ['stale-hash-after-loop-tamper', (fx) => {
      const secret = 'RAW-LOOP-SECRET-MUST-NOT-LEAK';
      fx.loop.untrusted = secret;
      writeFileSync(fx.loopPath, `${JSON.stringify(fx.loop, null, 2)}\n`);
    }],
  ];
  for (const [name, mutate] of cases) {
    const fx = fixture();
    mutate(fx);
    const result = invokeWithoutReceipt(fx);
    assert.equal(result.stderr, 'WSU1_F26_RUN_INTEGRITY\n', name);
    assert.doesNotMatch(result.stderr, /RAW-LOOP-SECRET|loop\.json|\.loop\.hash|wsu1-f26-verifier-/u, name);
  }
});
negative('F26-ACTUAL-NEG-MISSING-COST-EVENT', 'WSU1_F26_DUAL_COST_PROOF', (fx) => fx.writeEvents([]));
negative('F26-ACTUAL-NEG-DUPLICATE-COST-EVENT', 'WSU1_F26_DUAL_AGGREGATE_ORDER', (fx) => {
  fx.writeEvents([...fx.events, structuredClone(fx.event)]);
});
negative('F26-ACTUAL-NEG-MISSING-REPORT', 'WSU1_F26_DUAL_REPORT_PROOF', (fx) => unlinkSync(fx.reportPath));
negative('F26-ACTUAL-NEG-CLAIM-CONTEXT-MISMATCH', 'WSU1_F26_DUAL_INPUT_COUNT', (fx) => {
  fx.loop.episodes[1].review_aggregation.attempts[0].attempt_id = 'different-attempt'; fx.writeLoop();
});
negative('F26-ACTUAL-NEG-WORKTREE-K-MISMATCH', 'WSU1_F26_DUAL_SOURCE_MISMATCH', (fx) => {
  fx.loop.episodes[0].artifacts = fx.loop.episodes[0].artifacts.slice(1); fx.writeLoop();
});
negative('F26-ACTUAL-NEG-DUAL-INPUT rejects a scalar-shaped or partial second import',
  'WSU1_F26_DUAL_INPUT_COUNT', (fx) => {
    fx.inputs[1].schema_version = '1.0'; fx.writeInput(1);
  });
negative('F26-ACTUAL-NEG-DUAL-IDENTITY-COLLISION rejects copied reviewer identity before proof use',
  'WSU1_F26_DUAL_IDENTITY_COLLISION', (fx) => {
    const attempts = fx.loop.episodes[1].review_aggregation.attempts;
    attempts[1].reviewer_id = attempts[0].reviewer_id;
    fx.inputs[1].reviewer_id = attempts[0].reviewer_id;
    fx.writeInput(1); fx.writeLoop();
  });
negative('F26-ACTUAL-NEG-DUAL-PROCESS-PROOF rejects a missing independent process receipt',
  'WSU1_F26_DUAL_PROCESS_PROOF', (fx) => {
    const attempt = fx.loop.episodes[1].review_aggregation.attempts[1];
    unlinkSync(join(fx.projectRoot, ...attempt.process_proof.receipt.split('/')));
  });
negative('F26-ACTUAL-NEG-DUAL-PROCESS-PROOF rejects caller substitution of one provider receipt',
  'WSU1_F26_DUAL_PROCESS_PROOF', (fx) => {
    const attempts = fx.loop.episodes[1].review_aggregation.attempts;
    const first = join(fx.projectRoot, ...attempts[0].process_proof.receipt.split('/'));
    const second = join(fx.projectRoot, ...attempts[1].process_proof.receipt.split('/'));
    writeFileSync(second, readFileSync(first));
  });
negative('F26-ACTUAL-NEG-DUAL-CAPTURE rejects arbitrary capture record bytes',
  'WSU1_F26_DUAL_PROCESS_PROOF', (fx) => {
    const capture = fx.loop.episodes[1].review_aggregation.attempts[0].capture_proof;
    writeFileSync(join(fx.projectRoot, ...capture.record_path.split('/')), '{}');
  });
negative('F26-ACTUAL-NEG-DUAL-CAPTURE rejects a proof copied across attempts',
  'WSU1_F26_DUAL_PROCESS_PROOF', (fx) => {
    const attempts = fx.loop.episodes[1].review_aggregation.attempts;
    [attempts[0].capture_proof, attempts[1].capture_proof]
      = [attempts[1].capture_proof, attempts[0].capture_proof];
    fx.writeLoop();
  });
negative('F26-ACTUAL-NEG-SYNTHETIC-AGGREGATE rejects any third review artifact',
  'WSU1_F26_SYNTHETIC_AGGREGATE', (fx) => {
    writeFileSync(join(fx.runDir, 'reviews', `${'f'.repeat(64)}.json`), '{}');
  });
test('F26-ACTUAL-NEG-DUAL-AGGREGATE-REVERSAL rejects aggregate publication before either attempt outcome', () => {
  const fx = fixture();
  const aggregate = fx.events.find(event => event.type === 'review-outcome');
  const outcomes = fx.events.filter(event => event.type === 'review-attempt-outcome');
  fx.writeEvents([fx.events[0], fx.events[1], outcomes[0], aggregate, outcomes[1]]);
  const checker = fx.loop.episodes[1];
  for (const attempt of checker.review_aggregation.attempts) {
    const cost = fx.events.find(event => event.type === 'cost'
      && event.data.dual_checker_attempt_id === attempt.attempt_id);
    const outcome = fx.events.find(event => event.type === 'review-attempt-outcome'
      && event.data.attempt_id === attempt.attempt_id);
    attempt.cost_proof.event_seq = cost.seq;
    attempt.cost_proof.event_checksum = cost.checksum;
    attempt.report_proof.event_seq = outcome.seq;
    attempt.report_proof.event_checksum = outcome.checksum;
  }
  checker.review_aggregation.aggregate_proof.final_event_seq = aggregate.seq;
  checker.review_aggregation.aggregate_proof.final_event_checksum = aggregate.checksum;
  fx.writeLoop();
  const result = invoke(fx);
  assert.equal(result.stderr, 'WSU1_F26_DUAL_AGGREGATE_ORDER\n');
});
negative('F26-ACTUAL-NEG-MISSING-OBSERVATION', 'WSU1_F26_DUAL_OBSERVATION', (fx) => {
  unlinkSync(fx.observationPath);
});
negative('F26-ACTUAL-NEG-OBSERVATION-NON-REGULAR', 'WSU1_F26_DUAL_OBSERVATION', (fx) => {
  const target = join(fx.projectRoot, 'observation-target.json');
  writeFileSync(target, `${JSON.stringify(fx.observation)}\n`);
  unlinkSync(fx.observationPath);
  createFileSymlink(target, fx.observationPath);
});
negative('F26-ACTUAL-NEG-OBSERVATION-SHAPE', 'WSU1_F26_DUAL_OBSERVATION', (fx) => {
  delete fx.observation.observed_at; fx.writeObservation();
});
test('F26-ACTUAL-NEG-OBSERVATION-CHRONOLOGY rejects impossible intervals and permits equality', () => {
  const invalid = [
    ['finish-before-start', (fx) => { fx.observation.finished_at = '2026-08-09T23:59:59.999Z'; }],
    ['observe-before-finish', (fx) => { fx.observation.observed_at = '2026-08-10T00:00:59.999Z'; }],
  ];
  for (const [name, mutate] of invalid) {
    const fx = fixture();
    mutate(fx);
    fx.writeObservation();
    const result = invokeWithoutReceipt(fx);
    assert.equal(result.stderr, 'WSU1_F26_DUAL_OBSERVATION\n', name);
  }

  const fx = fixture();
  fx.observation.finished_at = fx.observation.started_at;
  fx.observation.observed_at = fx.observation.finished_at;
  fx.writeObservation();
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
});
negative('F26-ACTUAL-NEG-OBSERVATION-RUN-MISMATCH', 'WSU1_F26_DUAL_OBSERVATION', (fx) => {
  fx.observation.run_id = '01DIFFERENTRUN00000000000000'; fx.writeObservation();
});
test('F26-ACTUAL-NEG-OBSERVATION-COMMAND-MISMATCH', () => {
  const cases = [
    ['wrong-cwd', (fx) => { fx.observation.cwd = fx.worktree; }],
    ['old-no-routing-pair', (fx) => { fx.observation.argv = fx.observation.argv.slice(0, 2); }],
    ['missing-run-id-value', (fx) => { fx.observation.argv = fx.observation.argv.slice(0, 5); }],
    ['wrong-project-root', (fx) => { fx.observation.argv[3] = fx.worktree; }],
    ['wrong-run-id', (fx) => { fx.observation.argv[5] = '01WRONGRUN00000000000000000'; }],
  ];
  for (const [name, mutate] of cases) {
    const fx = fixture();
    mutate(fx);
    fx.writeObservation();
    const result = invoke(fx);
    assert.equal(result.stderr, 'WSU1_F26_DUAL_OBSERVATION\n', name);
  }
});
negative('F26-ACTUAL-NEG-OBSERVATION-RESULT-MISMATCH', 'WSU1_F26_DUAL_OBSERVATION', (fx) => {
  fx.observation.exit_code = 1; fx.writeObservation();
});
test('F26-ACTUAL-NEG-OBSERVATION-CHECKER-OUTCOME requires the exact durable checker identity', () => {
  const cases = [
    ['no-pending-handoff', { ok: true, action: 'no-pending-handoff' }],
    ['unknown-action', { ok: true, action: 'unknown-action' }],
    ['fixture-checker-approved', { ok: true, action: 'checker-approved' }],
    ['wrong-checker', {
      ok: true, action: 'checker-complete', checkerEpisodeId: 'wrong-checker', attemptId: 'attempt-010',
    }],
    ['wrong-attempt', {
      ok: true, action: 'checker-complete', checkerEpisodeId: '002-deep-review', attemptId: 'wrong-attempt',
    }],
  ];
  for (const [name, outcome] of cases) {
    const fx = fixture();
    fx.observation.stdout = `${JSON.stringify(outcome)}\n`;
    fx.writeObservation();
    const result = invoke(fx);
    assert.equal(result.stderr, 'WSU1_F26_DUAL_OBSERVATION\n', name);
  }
});
negative('F26-ACTUAL-NEG-OBSERVATION-DIGEST-MISMATCH', 'WSU1_F26_DUAL_OBSERVATION',
  () => {}, () => ({ WSU1_F26_EXPECT_HOST_OBSERVATION_SHA256: '0'.repeat(64) }));
negative('F26-ACTUAL-NEG-OBSERVATION-MISSING-AUTHORITY-DIGEST', 'WSU1_F26_DUAL_OBSERVATION',
  () => {}, () => ({ WSU1_F26_EXPECT_HOST_OBSERVATION_SHA256: undefined }));
negative('F26-ACTUAL-NEG-HOST-OBSERVATION-CANNOT-CLAIM-PROVIDER-PROOF',
  'WSU1_F26_DUAL_OBSERVATION', (fx) => {
    fx.observation.provider_id = 'caller-authored-provider-claim'; fx.writeObservation();
  });

test('STEP0-3 verifier fixture separates one host observation from provider process proof', () => {
  const fx = fixture();
  assert.equal(exactKeys(fx.observation, [
    'schema_version', 'observer_role', 'observer_session_id', 'observed_at', 'project_root', 'worktree',
    'run_id', 'workstream_id', 'point', 'maker_episode_id', 'checker_episode_id',
    'cwd', 'argv', 'env', 'started_at', 'finished_at', 'exit_code',
    'stdout', 'stderr', 'checker_terminal_status',
  ]), true);
  const attempts = fx.loop.episodes[1].review_aggregation.attempts;
  assert.equal(new Set(attempts.map(item => item.process_proof.receipt_id)).size, 2);
  assert.equal(new Set(attempts.map(item => item.process_proof.receipt)).size, 2);
});

test('STEP0-3 traversal sources use only baseline Node20 Dirent fields and non-recursive readdir', () => {
  const unsafe = NODE20_TRAVERSAL_SOURCES.flatMap((file) =>
    baselineNode20TraversalViolations(readFileSync(file, 'utf8'), file)
      .map((violation) => ({ file: file.slice(ROOT.length + 1), violation })));
  assert.deepEqual(unsafe, []);
  assert.deepEqual(baselineNode20TraversalViolations(
    'readdirSync(nested(root), { withFileTypes: true, recursive: true })',
  ), ['recursive readdirSync']);
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects an imported file symlink without leakage', (t) => {
  const fx = fixture({ scriptDecoy: 'file', testContext: t });
  if (!fx) return;
  assert.equal(lstatSync(join(fx.worktree, 'scripts', 'imported-decoy.mjs')).isSymbolicLink(), true);
  const result = invokeWithoutReceipt(fx);
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  assert.doesNotMatch(result.stderr, /outside|decoy|wsu1-f26-verifier-/u);
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects an imported directory symlink without leakage', () => {
  const fx = fixture({ scriptDecoy: 'directory' });
  assert.equal(lstatSync(join(fx.worktree, 'scripts', 'directory-decoy')).isSymbolicLink(), true);
  const result = invokeWithoutReceipt(fx);
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  assert.doesNotMatch(result.stderr, /outside|decoy|wsu1-f26-verifier-/u);
});

test('STEP0-3 verifier includes an ignored imported regular script in the coherent source contract', () => {
  const fx = fixture({ ignoredRuntime: true });
  assert.equal(fx.input.artifacts.some(({ path }) => path.endsWith('/scripts/ignored-runtime.mjs')), true);
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects omission of an ignored imported regular script', () => {
  const fx = fixture({ ignoredRuntime: true, includeIgnoredArtifact: false });
  const result = invokeWithoutReceipt(fx);
  assert.equal(result.stderr, 'WSU1_F26_DUAL_SOURCE_MISMATCH\n');
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects a nonregular scripts entry', {
  skip: process.platform === 'win32' ? 'mkfifo is unavailable on Windows' : false,
}, () => {
  const fx = fixture();
  const fifo = join(fx.worktree, 'scripts', 'runtime-fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const result = invokeWithoutReceipt(fx);
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects add, change, and remove races at the publication seam', () => {
  const cases = [
    ['add', (fx) => `writeFileSync(${JSON.stringify(join(fx.worktree, 'scripts', 'race-added.mjs'))}, 'secret-add')`],
    ['change', (fx) => `writeFileSync(${JSON.stringify(join(fx.worktree, 'scripts', 'surface.mjs'))}, 'secret-change')`],
    ['remove', (fx) => `unlinkSync(${JSON.stringify(join(fx.worktree, 'scripts', 'nested', 'surface-nested.mjs'))})`],
    ['rename-same-bytes', (fx) => {
      const oldPath = join(fx.worktree, 'scripts', 'nested', 'surface-nested.mjs');
      const newPath = join(fx.worktree, 'scripts', 'nested', 'surface-renamed.mjs');
      return `writeFileSync(${JSON.stringify(newPath)}, readFileSync(${JSON.stringify(oldPath)})); unlinkSync(${JSON.stringify(oldPath)})`;
    }],
  ];
  for (const [name, buildMutation] of cases) {
    const fx = fixture();
    const mutation = buildMutation(fx);
    const result = invokeWithSourceRace(fx, mutation);
    assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n', name);
    assert.doesNotMatch(result.stderr, /secret-|race-added|surface\.mjs|wsu1-f26-verifier-/u, name);
  }
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects direct and relative receipt targets under scripts', () => {
  const cases = [
    ['direct', (fx) => join(fx.worktree, 'scripts', 'new-receipt.json'), ROOT],
    ['relative', (fx) => relative(fx.projectRoot, join(fx.worktree, 'scripts', 'nested', 'new-receipt.json')),
      (fx) => fx.projectRoot],
  ];
  for (const [name, targetOf, cwdOf] of cases) {
    const fx = fixture();
    const target = targetOf(fx);
    const cwd = typeof cwdOf === 'function' ? cwdOf(fx) : cwdOf;
    const before = readFileSync(join(fx.worktree, 'scripts', 'surface.mjs'));
    const result = invokeReceiptTarget(fx, target, { cwd });
    assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n', name);
    assert.deepEqual(readFileSync(join(fx.worktree, 'scripts', 'surface.mjs')), before, name);
    assert.doesNotMatch(result.stderr, /new-receipt|scripts|wsu1-f26-verifier-/u, name);
  }
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects receipt aliases into reviewed source paths', () => {
  const fx = fixture();
  const alias = join(fx.projectRoot, 'source-alias');
  createDirectoryJunction(join(fx.worktree, 'scripts'), alias);
  let result = invokeReceiptTarget(fx, join(alias, 'aliased-receipt.json'));
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');

  const fixtureAlias = join(fx.projectRoot, 'fixture-alias.json');
  const reviewedFixture = join(fx.worktree, 'tests', 'fixtures', 'activation-pending-classification.md');
  try {
    createFileSymlink(reviewedFixture, fixtureAlias);
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') return;
    throw error;
  }
  result = invokeReceiptTarget(fx, fixtureAlias);
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
  assert.doesNotMatch(result.stderr, /source-alias|fixture-alias|activation-pending/u);
});

test('STEP0-3 verifier permits a new receipt outside the reviewed source closure', () => {
  const fx = fixture();
  const target = join(fx.projectRoot, 'receipts', 'verified.json');
  unlinkSync(fx.receiptPath);
  const args = verifierArgs(fx);
  args[args.indexOf('--receipt') + 1] = target;
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: verifierEnv(fx) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).run_id, fx.runId);
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects receipt-parent replacement at every publication boundary', () => {
  for (const boundary of ['PRE_OPEN', 'PRE_LINK', 'POST_LINK', 'POST_PUBLICATION']) {
    invokeWithReceiptParentRace(fixture(), boundary);
  }
});

test('F26-ACTUAL-NEG-WORKTREE-K preserves a pre-existing outside receipt across parent drift', () => {
  invokeWithReceiptParentRace(fixture(), 'PRE_OPEN', {
    preexistingBytes: Buffer.from('pre-existing receipt must survive\n'),
  });
});

test('F26-ACTUAL-NEG-WORKTREE-K removes a newly published receipt on reachable postpublication drift', () => {
  invokeWithReachablePostPublicationFailure(fixture());
});

test('F26-ACTUAL-NEG-WORKTREE-K preserves a competing outside receipt during reachable cleanup', () => {
  invokeWithReachablePostPublicationFailure(fixture(), {
    competingReceiptBytes: Buffer.from('competing receipt must survive cleanup\n'),
  });
});

test('F26-ACTUAL-NEG-WORKTREE-K never owns a link-to-lstat competitor and cleans only its temp', () => {
  invokeWithLinkObservationReplacement(fixture());
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects a foreign receipt replacement after the final K check', () => {
  invokeWithFinalReceiptDrift(fixture(), 'replacement');
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects same-inode receipt corruption after the final K check', () => {
  invokeWithFinalReceiptDrift(fixture(), 'same-inode');
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects receipt drift across descriptor verification boundaries', () => {
  for (const boundary of ['PRE_OPEN', 'POST_READ', 'PRE_FINAL_PATH']) {
    invokeWithinFinalReceiptVerification(fixture(), boundary);
  }
});

test('STEP0-3 verifier materializes and binds an initially missing outside receipt parent', () => {
  const fx = fixture();
  const target = join(fx.projectRoot, 'missing-parent', 'nested', 'verified.json');
  assert.equal(lstatOrNull(dirname(target)), null);
  unlinkSync(fx.receiptPath);
  const args = verifierArgs(fx);
  args[args.indexOf('--receipt') + 1] = target;
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: verifierEnv(fx) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).run_id, fx.runId);
});

test('STEP0-3 receipt target guard binds both lexical and canonical reviewed-source axes', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  const body = source.slice(
    source.indexOf('function safeReceiptTarget('),
    source.indexOf('\nfunction portableRelative(', source.indexOf('function safeReceiptTarget(')),
  );
  assert.match(body, /within\(resolve\(worktree, 'scripts'\), lexical\)/u);
  assert.match(body, /within\(scripts, canonical\)/u);
  assert.match(body, /lexical === resolve\(fixture\)/u);
  assert.match(body, /canonical === canonicalProspectivePath\(fixture, 'WSU1_F26_WORKTREE_K'\)/u);
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
  const result = spawnSync(process.execPath, verifierArgs(fx), {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WSU1_F26_EVENT_LOG\n');
});

test('STEP0-3 coherent synthetic verifier fixture reaches exact success and atomically issues receipt', () => {
  const fx = fixture();
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), {
    encoding: 'utf8', env: verifierEnv(fx),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(readFileSync(fx.receiptPath, 'utf8'));
  assert.deepEqual(Object.keys(receipt), [
    'run_id', 'workstream_id', 'worktree_prefix', 'point', 'scope', 'reviewed_source_sha256',
    'live_classification_sha256', 'evidence_rows_sha256', 'source_claim_sha256',
    'attempts', 'provider_process_proofs', 'host_observation', 'aggregate_event', 'host_result_sha256',
  ]);
  assert.equal(receipt.run_id, fx.runId);
  assert.equal(receipt.scope, 'X_E_RESIDUAL_REASON_SEMANTICS+L_CONDITIONAL_DOMINANCE');
  assert.equal(receipt.attempts.length, 2);
  assert.deepEqual(receipt.attempts.map(item => item.report_sha256),
    fx.loop.episodes[1].review_aggregation.attempts.map(item => item.report_proof.report_sha256));
  assert.deepEqual(receipt.attempts.map(item => item.process_receipt_id),
    fx.loop.episodes[1].review_aggregation.attempts.map(item => item.process_proof.receipt_id));
  assert.equal(receipt.provider_process_proofs.length, 2);
  assert.equal(new Set(receipt.provider_process_proofs.map(item => item.receipt_sha256)).size, 2);
  assert.equal(receipt.host_observation.sha256, sha256(readFileSync(fx.observationPath)));
  assert.equal(receipt.aggregate_event.seq,
    fx.loop.episodes[1].review_aggregation.aggregate_proof.final_event_seq);
  assert.equal(Object.hasOwn(receipt, 'envelope'), false, 'receipt must not embed reviewer prose');
});

test('STEP0-3 verifier receipt publication flushes its parent before and after temp unlink', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  const body = source.slice(source.indexOf('function atomicallyCreate('), source.indexOf('\nfunction main()', source.indexOf('function atomicallyCreate(')));
  const link = body.indexOf('linkSync(temporary, path)');
  const firstFlush = body.indexOf('flushDirectory(parent)', link);
  const unlink = body.indexOf('unlinkExact(temporary, temporaryIdentity)', firstFlush);
  const secondFlush = body.indexOf('flushDirectory(parent)', unlink);
  assert.equal(link >= 0 && link < firstFlush && firstFlush < unlink && unlink < secondFlush, true);
});

test('STEP0-3 verifier binds final receipt bytes and full same-descriptor identity after final K', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  const start = source.indexOf('function verifyPublishedReceipt(');
  const end = source.indexOf('\nfunction main()', start);
  const body = source.slice(start, end);
  const before = body.indexOf("regularFileIdentity(lstatSync(path, { bigint: true }))");
  const open = body.indexOf('openSync(path, constants.O_RDONLY');
  const firstFstat = body.indexOf('regularFileIdentity(fstatSync(fd, { bigint: true }))', open);
  const read = body.indexOf('readFileSync(fd)', firstFstat);
  const secondFstat = body.indexOf('regularFileIdentity(fstatSync(fd, { bigint: true }))', firstFstat + 1);
  const finalLstat = body.indexOf('regularFileIdentity(lstatSync(path, { bigint: true }))', before + 1);
  assert.equal(before >= 0 && before < open && open < firstFstat && firstFstat < read
    && read < secondFstat && secondFstat < finalLstat, true);
  assert.match(body, /constants\.O_RDONLY \| \(constants\.O_NOFOLLOW \?\? 0\) \| \(constants\.O_NONBLOCK \?\? 0\)/u);
  assert.match(body, /matchingIdentity\(before, installedIdentity\)/u);
  assert.match(body, /matchingRegularFileIdentity\(before, opened\)/u);
  assert.match(body, /matchingRegularFileIdentity\(opened, afterRead\)/u);
  assert.match(body, /observedBytes\.equals\(expectedBytes\)/u);
  assert.match(body, /matchingRegularFileIdentity\(afterRead, finalPath\)/u);
  assert.match(body, /finally \{[\s\S]*closeSync\(fd\)/u);

  const receiptBytes = source.indexOf('const receiptBytes = Buffer.from(');
  const publication = source.indexOf('atomicallyCreate(receiptBinding, receiptBytes)', receiptBytes);
  const finalK = source.indexOf('verifySourceArtifactsUnchanged(worktree, relativeContract)', publication);
  const finalReceipt = source.indexOf('verifyPublishedReceipt(binding, receiptIdentity, receiptBytes)', finalK);
  const verified = source.indexOf("process.stdout.write('WSU1_F26_ACTUAL_RUN_VERIFIED\\n')", finalReceipt);
  assert.equal(receiptBytes >= 0 && receiptBytes < publication && publication < finalK
    && finalK < finalReceipt && finalReceipt < verified, true);
});

test('STEP0-3 verifier rechecks the anchored run evidence before receipt publication', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  const body = source.slice(
    source.indexOf('function verifyRunEvidenceUnchanged('),
    source.indexOf('\nfunction canonicalDirectory(', source.indexOf('function verifyRunEvidenceUnchanged(')),
  );
  assert.deepEqual(
    ['loopBytes', 'loopHashBytes', 'eventBytes'].filter((name) => body.includes(`evidence.${name}]`)),
    ['loopBytes', 'loopHashBytes', 'eventBytes'],
  );
  assert.match(body, /if \(!observed\.equals\(expected\)\) fail\('WSU1_F26_RUN_INTEGRITY'\)/u);
  const initial = source.indexOf('const runEvidence = readRunEvidence(runDirectory)');
  const eventValidation = source.indexOf('validateEventLog(events, loop.event_log_head)', initial);
  const reread = source.indexOf('verifyRunEvidenceUnchanged(runEvidence)', eventValidation);
  const publication = source.indexOf('atomicallyCreate(receiptBinding', reread);
  assert.equal(initial >= 0 && initial < eventValidation && eventValidation < reread && reread < publication, true);
});

test('STEP0-3 verifier re-enumerates K after run evidence and immediately before publication', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  const initial = source.indexOf('const sources = sourceArtifacts(worktree)');
  const runReread = source.indexOf('verifyRunEvidenceUnchanged(runEvidence)', initial);
  const sourceReread = source.indexOf('verifySourceArtifactsUnchanged(worktree, relativeContract)', runReread);
  const publication = source.indexOf('atomicallyCreate(receiptBinding', sourceReread);
  assert.equal(initial >= 0 && initial < runReread && runReread < sourceReread && sourceReread < publication, true);
  assert.equal(source.slice(sourceReread, publication).trim(), [
    'verifySourceArtifactsUnchanged(worktree, relativeContract); // K_BOUNDARY_PRE_PUBLICATION',
    '  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\\n`);',
    '  const receiptIdentity =',
  ].join('\n'));
});
