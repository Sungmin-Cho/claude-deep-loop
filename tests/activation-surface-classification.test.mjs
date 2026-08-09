import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const LINK_ONLY_EXTRACTOR = join(HERE, 'helpers', 'wsu1-f26-link-only-extractor.mjs');
const STATIC_ANALYZER = join(HERE, 'helpers', 'wsu1-f26-static-analyzer.mjs');
const FIXTURES = join(HERE, 'fixtures');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byteSort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function recursiveFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort(byteSort);
}

function exactKeys(value, keys) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort(byteSort)) === JSON.stringify([...keys].sort(byteSort));
}

function readRegularJson(path) {
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${path} must not be a symlink`);
  assert.equal(stat.isFile(), true, `${path} must be a regular file`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('STEP0-3 seed bytes pin the approved four spans and terminator', () => {
  const seed = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'));
  assert.equal(seed.length, 39_665);
  assert.equal(sha256(seed), '6f6202df0e365f0e68a4f1e81a0a6242d80b1cc493a7acde91d587fdaad7bf13');
});

test('STEP0-3 guard 4 link-only extractor reports every scripts namespace without evaluation', async () => {
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--experimental-vm-modules',
    LINK_ONLY_EXTRACTOR,
    '--scripts-root', join(ROOT, 'scripts'),
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.schema_version, 1);
  assert.equal(output.file_count, 58);
  assert.equal(output.raw_export_name_count, 314);
  assert.equal(output.failures.length, 0);
  const linkedIds = output.files.flatMap((file) =>
    file.export_names.map((name) => `${file.module}#${name}`)).sort(byteSort);
  const analyzer = await import(STATIC_ANALYZER);
  const parsed = analyzer.extractExportSurface({ files: recursiveFiles(join(ROOT, 'scripts')) });
  assert.deepEqual(linkedIds, parsed.raw_ids);
});

test('STEP0-3 guard 4 fails closed when the vm-modules child flag is absent', () => {
  const result = spawnSync(process.execPath, [
    '--no-warnings', LINK_ONLY_EXTRACTOR, '--scripts-root', join(ROOT, 'scripts'),
  ], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /VM_MODULES_UNAVAILABLE: run with --experimental-vm-modules/);
});

test('STEP0-3 local design auxiliary check matches all four pinned seed spans', () => {
  const designPath = join(ROOT, 'docs', 'specs', '2026-08-03-acquire-resume-gap1a-gap2-design.md');
  if (!existsSync(designPath)) return;
  const design = readFileSync(designPath, 'utf8');
  const seed = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'), 'utf8');
  const start = design.indexOf('**7.7-1');
  const end = design.indexOf('### 7.8', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const terminatorEnd = design.indexOf('\n', end) + 1;
  assert.equal(seed, design.slice(start, terminatorEnd));
});

test('STEP0-3 rule B and export parser preserve all nine live reversal polarities', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const files = ['mut01.mjs', 'mut12.mjs', 'mut13.mjs', 'mut14.mjs', 'mut15.mjs',
    'mut18.mjs', 'mut19.mjs', 'mut20.mjs'].map((name) => join(FIXTURES, name));
  const result = analyzer.extractExportSurface({ files });

  assert.deepEqual(result.failures, []);
  assert.equal(result.canonical_ids.includes('mut01.mjs#persist'), true);
  assert.equal(result.canonical_ids.includes('mut12.mjs#alias'), false);
  assert.equal(result.canonical_ids.includes('mut12.mjs#canonical'), true);
  assert.equal(result.canonical_ids.includes('mut13.mjs#facadeOfLocal'), true);
  assert.equal(result.canonical_ids.includes('mut14.mjs#forwardingWrapper'), true);
  assert.equal(result.canonical_ids.includes('mut15.mjs#alias'), false);
  assert.equal(result.canonical_ids.includes('mut15.mjs#canonical'), false);
  assert.equal(result.raw_ids.includes('mut18.mjs#multiDeclarator'), true);
  assert.equal(result.raw_ids.includes('mut19.mjs#renamedSecond'), true);
  assert.equal(result.canonical_ids.includes('mut20.mjs#alias'), true);
  assert.equal(result.canonical_ids.includes('mut20.mjs#canonical'), true);
});

test('STEP0-3 guard 1 rejects the approved non-mjs reversal instead of silently shrinking C', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const result = analyzer.extractExportSurface({ files: [join(FIXTURES, 'mut16.js')] });
  assert.deepEqual(result.failures, [{
    guard: 1,
    file: 'mut16.js',
    reason: 'non-mjs-script',
  }]);
});

test('STEP0-3 static export parser matches the measured 314 raw and 306 canonical surface', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const result = analyzer.extractExportSurface({ files: recursiveFiles(join(ROOT, 'scripts')) });
  assert.deepEqual(result.failures, []);
  assert.equal(result.raw_ids.length, 314);
  assert.equal(result.canonical_ids.length, 306);
});

test('STEP0-3 live overlay closes the measured six-id delta with a disjoint 306-row partition', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const seed = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'), 'utf8');
  const overlay = readFileSync(join(FIXTURES, 'activation-pending-classification.md'), 'utf8');
  const live = analyzer.parseLiveClassification({ seed, overlay });
  assert.deepEqual(live.counts, {
    L: 28, B: 7, X: 32, E2: 114, E3: 12, E4: 16, E5: 1, E7: 73, E8: 23,
  });
  assert.equal(live.rows.size, 306);
  assert.deepEqual([...live.rows.entries()].filter(([id]) => [
    'headless-host.mjs#acquireHeadlessHostLock',
    'lease.mjs#activateLease',
    'lease.mjs#reapLease',
    'preflight-receipt-journal.mjs#markCheckerImportUnconfirmed',
    'review-import.mjs#locateCapturedImportedReviewArtifact',
    'review-import.mjs#verifyCapturedImportedReviewProof',
  ].includes(id)), [
    ['headless-host.mjs#acquireHeadlessHostLock', { classification: 'E4', reason: 'non-run-state-durable-write' }],
    ['lease.mjs#activateLease', { classification: 'X', reason: 'enforcement-origin' }],
    ['lease.mjs#reapLease', { classification: 'X', reason: 'enforcement-origin' }],
    ['preflight-receipt-journal.mjs#markCheckerImportUnconfirmed', { classification: 'E4', reason: 'non-run-state-durable-write' }],
    ['review-import.mjs#locateCapturedImportedReviewArtifact', { classification: 'E2', reason: 'no-run-state-write' }],
    ['review-import.mjs#verifyCapturedImportedReviewProof', { classification: 'E2', reason: 'no-run-state-write' }],
  ]);
});

test('STEP0-3 call graph recomputes reachability and same-lock dominance for every live row', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const seed = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'), 'utf8');
  const overlay = readFileSync(join(FIXTURES, 'activation-pending-classification.md'), 'utf8');
  const live = analyzer.parseLiveClassification({ seed, overlay });
  const result = analyzer.analyzeClassification({
    files: recursiveFiles(join(ROOT, 'scripts')),
    live,
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.violations, []);
  assert.equal(result.rows.length, 306);
  assert.deepEqual(result.rows.find(({ id }) => id === 'session-profile.mjs#setSessionProfile'), {
    id: 'session-profile.mjs#setSessionProfile',
    classification: 'L',
    write_reachability: 'reaches',
    leasecheck_dominance: 'dominates',
    reason: 'leasecheck-dominated',
    evidence: result.rows.find(({ id }) => id === 'session-profile.mjs#setSessionProfile').evidence,
  });
  assert.equal(result.rows.find(({ id }) => id === 'insights.mjs#emitInsights').leasecheck_dominance,
    'conditional-dominates');
  assert.equal(result.rows.find(({ id }) => id === 'breaker.mjs#tripBreaker').leasecheck_dominance,
    'does-not-dominate');
  assert.equal(result.rows.find(({ id }) => id === 'review-import.mjs#locateCapturedImportedReviewArtifact').write_reachability,
    'does-not-reach');
  const conditionalRows = result.rows.filter(({ classification, leasecheck_dominance }) =>
    classification === 'L' && leasecheck_dominance === 'conditional-dominates');
  assert.equal(conditionalRows.length, 10);
  assert.equal(conditionalRows.every(({ evidence }) =>
    evidence.some(({ kind }) => kind === 'conditional-dominance')), true);
});

test('STEP0-3 W1 and W2 inspect direct calls or references for every E2-E5/E7/E8 row', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const result = analyzer.analyzeClassification({
    files: [join(FIXTURES, 'mut22.mjs')],
    live: {
      rows: new Map([['mut22.mjs#falselyExceptionalSurface', {
        classification: 'E2', reason: 'no-run-state-write',
      }]]),
    },
    requireExactSurface: false,
  });

  assert.equal(result.rows[0].write_reachability, 'reaches');
  assert.deepEqual(result.violations.map(({ code }) => [...code.split(':').slice(0, 1)]).flat(), [
    'CLASSIFICATION_RECALCULATION_MISMATCH',
    'E_DIRECT_OR_REFERENCE_WRITE',
  ]);

  for (const [classification, reason] of [
    ['E3', 'infrastructure-primitive'],
    ['E4', 'non-run-state-durable-write'],
    ['E5', 'legacy-hook-adapter'],
  ]) {
    const expanded = analyzer.analyzeClassification({
      files: [join(FIXTURES, 'mut22.mjs')],
      live: { rows: new Map([['mut22.mjs#falselyExceptionalSurface', { classification, reason }]]) },
      requireExactSurface: false,
    });
    assert.equal(expanded.violations.some(({ code }) => code === 'E_DIRECT_OR_REFERENCE_WRITE'), true,
      `${classification} omitted from the W2 domain`);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'wsu1-f26-reference-'));
  const referenceFile = join(scratch, 'reference.mjs');
  writeFileSync(referenceFile,
    `import { appendAnchored } from '${join(ROOT, 'scripts', 'lib', 'integrity.mjs')}';\nexport const w = appendAnchored;\n`);
  const reference = analyzer.analyzeClassification({
    files: [referenceFile],
    live: { rows: new Map([['reference.mjs#w', {
      classification: 'E7', reason: 'expanded-read-pure-non-run-state',
    }]]) },
    requireExactSurface: false,
  });
  assert.equal(reference.violations.some(({ code }) => code === 'E_DIRECT_OR_REFERENCE_WRITE'), true);
});

test('STEP0-3 reversal mutants expose non-dominance and false structural exception', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const nondominating = analyzer.analyzeClassification({
    files: [join(FIXTURES, 'mut21.mjs')],
    live: { rows: new Map([['mut21.mjs#nondominatingSurface', {
      classification: 'L', reason: 'leasecheck-dominated',
    }]]) },
    requireExactSurface: false,
  });
  assert.equal(nondominating.rows[0].write_reachability, 'reaches');
  assert.equal(nondominating.rows[0].leasecheck_dominance, 'does-not-dominate');
  assert.equal(nondominating.violations.some(({ code }) => code === 'L_WRITE_NOT_DOMINATED'), true);

  const falseException = analyzer.analyzeClassification({
    files: [join(FIXTURES, 'mut22.mjs')],
    live: { rows: new Map([['mut22.mjs#falselyExceptionalSurface', {
      classification: 'X', reason: 'structural-no-target',
    }]]) },
    requireExactSurface: false,
  });
  assert.equal(falseException.rows[0].write_reachability, 'reaches');
  assert.equal(falseException.violations.some(({ code }) =>
    code === 'CLASSIFICATION_RECALCULATION_MISMATCH'), true);

  const falsePure = analyzer.analyzeClassification({
    files: [join(FIXTURES, 'mut23.mjs')],
    live: { rows: new Map([['mut23.mjs#falselyPureSurface', {
      classification: 'E2', reason: 'no-run-state-write',
    }]]) },
    requireExactSurface: false,
  });
  assert.equal(falsePure.rows[0].write_reachability, 'reaches');
  assert.equal(falsePure.violations.some(({ code }) =>
    code === 'CLASSIFICATION_RECALCULATION_MISMATCH'), true);
});

test('STEP0-3 unsupported dynamic call syntax fails closed instead of being skipped', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const scratch = mkdtempSync(join(tmpdir(), 'wsu1-f26-unsupported-'));
  const file = join(scratch, 'unsupported.mjs');
  writeFileSync(file, 'export function uncertain(o) { return o["append" + "Anchored"](); }\n');
  const result = analyzer.analyzeClassification({
    files: [file],
    live: { rows: new Map([['unsupported.mjs#uncertain', {
      classification: 'E2', reason: 'no-run-state-write',
    }]]) },
    requireExactSurface: false,
  });
  assert.equal(result.failures.some(({ reason }) => reason === 'unsupported-dynamic-call'), true);
});

test('STEP0-3 tracked evidence matrix is canonical and exactly matches source recalculation', async () => {
  const analyzer = await import(STATIC_ANALYZER);
  const seedBytes = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'));
  const liveBytes = readFileSync(join(FIXTURES, 'activation-pending-classification.md'));
  const evidence = JSON.parse(readFileSync(
    join(FIXTURES, 'activation-pending-classification-evidence.json'), 'utf8'));
  assert.deepEqual(Object.keys(evidence), [
    'schema_version', 'design_sha256', 'seed_sha256', 'live_classification_sha256',
    'candidate_ids_sha256', 'candidate_ids', 'rows',
  ]);
  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.design_sha256, '14a62655b601f9b8278d7106e22d52c162e7d952303be765ffa07e57719ea2ee');
  assert.equal(evidence.seed_sha256, sha256(seedBytes));
  assert.equal(evidence.live_classification_sha256, sha256(liveBytes));
  assert.equal(evidence.candidate_ids_sha256,
    sha256(Buffer.from(`${evidence.candidate_ids.join('\n')}\n`)));

  const live = analyzer.parseLiveClassification({ seed: seedBytes.toString(), overlay: liveBytes.toString() });
  const calculated = analyzer.analyzeClassification({
    files: recursiveFiles(join(ROOT, 'scripts')),
    live,
  });
  assert.deepEqual(calculated.failures, []);
  assert.deepEqual(calculated.violations, []);
  assert.deepEqual(evidence.candidate_ids, calculated.candidate_ids);
  assert.deepEqual(evidence.rows, calculated.rows);
});

test('STEP4 tracked-only manual proof gate remains fail-closed until orchestrator artifacts land', () => {
  const inputPath = join(FIXTURES, 'activation-pending-classification-manual-review.json');
  const receiptPath = join(FIXTURES, 'activation-pending-classification-manual-review-receipt.json');
  const input = readRegularJson(inputPath);
  const receipt = readRegularJson(receiptPath);
  assert.equal(exactKeys(input, [
    'schema_version', 'reviewer_id', 'checker_episode_id', 'target_maker',
    'attempt_id', 'verdict', 'report_body', 'artifacts',
  ]), true);
  assert.equal(input.schema_version, '1.0');
  assert.equal(input.verdict, 'APPROVE');
  assert.equal(typeof input.report_body === 'string' && input.report_body.trim().length > 0, true);
  assert.equal(exactKeys(receipt, [
    'run_id', 'workstream_id', 'worktree_prefix', 'point', 'scope', 'reviewed_source_sha256',
    'live_classification_sha256', 'evidence_rows_sha256', 'checker_cost_event',
    'external_observation', 'report_path', 'report_sha256', 'envelope',
  ]), true);
  assert.equal(receipt.worktree_prefix, '.claude/worktrees/wsu1-acquire-contract');
  assert.equal(receipt.point, 'wsu1-f26-independent-review');
  assert.equal(receipt.scope, 'X_E_RESIDUAL_REASON_SEMANTICS+L_CONDITIONAL_DOMINANCE');

  const current = [
    ...recursiveFiles(join(ROOT, 'scripts')),
    join(FIXTURES, 'activation-pending-classification.seed.md'),
    join(FIXTURES, 'activation-pending-classification.md'),
    join(FIXTURES, 'activation-pending-classification-evidence.json'),
  ].map((path) => ({
    path: path.slice(ROOT.length + 1).replaceAll('\\', '/'),
    bytes: readFileSync(path),
  })).sort((left, right) => byteSort(left.path, right.path));
  const currentArtifacts = current.map(({ path, bytes }) => ({ path, sha256: sha256(bytes) }));
  const prefix = `${receipt.worktree_prefix}/`;
  const transformed = input.artifacts.map((artifact) => {
    assert.equal(exactKeys(artifact, ['path', 'sha256']), true);
    assert.equal(artifact.path.startsWith(prefix), true);
    const path = artifact.path.slice(prefix.length);
    assert.equal(path.startsWith(prefix), false);
    assert.equal(path.split('/').some((part) => part === '.' || part === '..' || part === ''), false);
    return { path, sha256: artifact.sha256 };
  }).sort((left, right) => byteSort(left.path, right.path));
  assert.deepEqual(transformed, currentArtifacts);

  const sourceHash = createHash('sha256');
  for (const item of current) {
    sourceHash.update(Buffer.from(item.path));
    sourceHash.update(Buffer.from([0]));
    sourceHash.update(Buffer.from(String(item.bytes.length)));
    sourceHash.update(Buffer.from([0]));
    sourceHash.update(item.bytes);
  }
  const evidence = JSON.parse(readFileSync(
    join(FIXTURES, 'activation-pending-classification-evidence.json'), 'utf8'));
  assert.equal(receipt.reviewed_source_sha256, sourceHash.digest('hex'));
  assert.equal(receipt.live_classification_sha256,
    sha256(readFileSync(join(FIXTURES, 'activation-pending-classification.md'))));
  assert.equal(receipt.evidence_rows_sha256,
    sha256(Buffer.from(`${JSON.stringify(evidence.rows)}\n`)));

  assert.equal(exactKeys(receipt.checker_cost_event, ['seq', 'process_context', 'claim_hash']), true);
  assert.equal(Number.isInteger(receipt.checker_cost_event.seq) && receipt.checker_cost_event.seq > 0, true);
  assert.equal(exactKeys(receipt.checker_cost_event.process_context, [
    'origin_owner', 'origin_generation', 'checker_episode_id', 'attempt_id', 'target_maker', 'claim_hash',
  ]), true);
  const context = receipt.checker_cost_event.process_context;
  assert.equal(context.checker_episode_id, input.checker_episode_id);
  assert.equal(context.attempt_id, input.attempt_id);
  assert.equal(context.target_maker, input.target_maker);
  assert.equal(context.claim_hash, receipt.checker_cost_event.claim_hash);
  assert.match(context.claim_hash, /^[a-f0-9]{64}$/);
  assert.equal(exactKeys(receipt.external_observation, ['path', 'sha256', 'observer_session_id']), true);
  assert.match(receipt.external_observation.sha256, /^[a-f0-9]{64}$/);

  assert.equal(receipt.report_path,
    `.deep-loop/runs/${receipt.run_id}/reviews/${receipt.report_sha256}.json`);
  assert.equal(sha256(Buffer.from(JSON.stringify(receipt.envelope, null, 2))), receipt.report_sha256);
  const binding = receipt.envelope?.envelope?.provenance?.review_binding;
  assert.deepEqual(binding, {
    reviewer_id: input.reviewer_id,
    checker_episode_id: input.checker_episode_id,
    target_maker: input.target_maker,
    attempt_id: input.attempt_id,
    artifacts: input.artifacts,
  });
  assert.deepEqual(receipt.envelope?.payload,
    { verdict: input.verdict, report_body: input.report_body });
});
