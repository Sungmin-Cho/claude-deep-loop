import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from './helpers/wsu1-f26-static-analyzer.mjs';
import {
  createDirectoryJunction, createFileSymlink, createFileSymlinkOrSkip,
} from './helpers/fs-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const VERIFIER = join(ROOT, 'scripts', 'verify-wsu1-f26-actual-run.mjs');
const NODE20_TRAVERSAL_SOURCES = [
  VERIFIER,
  join(HERE, 'helpers', 'baseline-node20-walk.mjs'),
  join(HERE, 'helpers', 'wsu1-f26-link-only-extractor.mjs'),
  join(HERE, 'activation-surface-classification.test.mjs'),
  join(HERE, 'terminal-cli.test.mjs'),
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

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
  const fixtures = join(worktree, 'tests', 'fixtures');
  const scripts = join(worktree, 'scripts');
  mkdirSync(join(scripts, 'nested'), { recursive: true });
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(reviews, { recursive: true });
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
      '--project-root',
      projectRoot,
      '--run-id',
      runId,
    ],
    env: { DEEP_LOOP_UNATTENDED: '1' },
    started_at: '2026-08-10T00:00:00.000Z',
    finished_at: '2026-08-10T00:01:00.000Z',
    exit_code: 0,
    stdout: `${JSON.stringify({
      ok: true,
      action: 'checker-complete',
      checkerEpisodeId: checkerId,
      attemptId,
    })}\n`,
    stderr: '',
    checker_terminal_status: 'approved',
  };
  const loopPath = join(runDir, 'loop.json');
  const loopHashPath = join(runDir, '.loop.hash');
  const eventPath = join(runDir, 'event-log.jsonl');
  const inputPath = join(projectRoot, 'manual-review.json');
  const observationPath = join(projectRoot, 'external-observation.json');
  const receiptPath = join(projectRoot, 'receipt.json');
  const writeLoop = () => {
    const bytes = Buffer.from(`${JSON.stringify(loop, null, 2)}\n`);
    writeFileSync(loopPath, bytes);
    writeFileSync(loopHashPath, sha256(bytes));
  };
  writeLoop();
  writeFileSync(eventPath, `${JSON.stringify(event)}\n`);
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  writeFileSync(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
  writeFileSync(receiptPath, 'sentinel-receipt-bytes\n');
  return {
    projectRoot, runId, worktreePrefix, worktree, runDir, reportPath, loopPath, loopHashPath, eventPath,
    inputPath, observationPath, receiptPath, loop, event, input, observation, envelope,
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

function invokeWithoutReceipt(fx, extraEnv = {}) {
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), {
    encoding: 'utf8', env: { ...process.env, ...extraEnv },
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
  createFileSymlink(target, fx.observationPath);
});
negative('F26-ACTUAL-NEG-OBSERVATION-SHAPE', 'WSU1_F26_OBSERVATION_SHAPE', (fx) => {
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
    assert.equal(result.stderr, 'WSU1_F26_OBSERVATION_SHAPE\n', name);
  }

  const fx = fixture();
  fx.observation.finished_at = fx.observation.started_at;
  fx.observation.observed_at = fx.observation.finished_at;
  fx.writeObservation();
  unlinkSync(fx.receiptPath);
  const result = spawnSync(process.execPath, verifierArgs(fx), { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
});
negative('F26-ACTUAL-NEG-OBSERVATION-RUN-MISMATCH', 'WSU1_F26_OBSERVATION_RUN', (fx) => {
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
    assert.equal(result.stderr, 'WSU1_F26_OBSERVATION_COMMAND\n', name);
  }
});
negative('F26-ACTUAL-NEG-OBSERVATION-RESULT-MISMATCH', 'WSU1_F26_OBSERVATION_RESULT', (fx) => {
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
    assert.equal(result.stderr, 'WSU1_F26_OBSERVATION_RESULT\n', name);
  }
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
  const result = spawnSync(process.execPath, verifierArgs(fx), { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'WSU1_F26_ACTUAL_RUN_VERIFIED\n');
});

test('F26-ACTUAL-NEG-WORKTREE-K rejects omission of an ignored imported regular script', () => {
  const fx = fixture({ ignoredRuntime: true, includeIgnoredArtifact: false });
  const result = invokeWithoutReceipt(fx);
  assert.equal(result.stderr, 'WSU1_F26_WORKTREE_K\n');
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

test('STEP0-3 verifier receipt publication flushes its parent before and after temp unlink', () => {
  const source = readFileSync(VERIFIER, 'utf8');
  const body = source.slice(source.indexOf('function atomicallyCreate('), source.indexOf('\nfunction main()', source.indexOf('function atomicallyCreate(')));
  const link = body.indexOf('linkSync(temporary, path)');
  const firstFlush = body.indexOf('flushDirectory(dirname(path))', link);
  const unlink = body.indexOf('unlinkSync(temporary)', firstFlush);
  const secondFlush = body.indexOf('flushDirectory(dirname(path))', unlink);
  assert.equal(link >= 0 && link < firstFlush && firstFlush < unlink && unlink < secondFlush, true);
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
  const publication = source.indexOf('atomicallyCreate(resolve(args[\'--receipt\'])', reread);
  assert.equal(initial >= 0 && initial < eventValidation && eventValidation < reread && reread < publication, true);
});
