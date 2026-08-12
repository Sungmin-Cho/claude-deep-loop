import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineNode20RegularFiles } from './helpers/baseline-node20-walk.mjs';
import { createFileSymlink } from './helpers/fs-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const LINK_ONLY_EXTRACTOR = join(HERE, 'helpers', 'wsu1-f26-link-only-extractor.mjs');
const STATIC_ANALYZER = join(HERE, 'helpers', 'wsu1-f26-static-analyzer.mjs');
const STATIC_ANALYZER_URL = pathToFileURL(STATIC_ANALYZER).href;
const FIXTURES = join(HERE, 'fixtures');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const byteSort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

const recursiveFiles = baselineNode20RegularFiles;

test('STEP0-3 symlink polarity uses the centralized portable fixture helper', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.doesNotMatch(source, new RegExp(`\\b${'symlink'}${'Sync'}\\b`));
  assert.match(source, /createFileSymlink\(join\(evals, 'dep\.mjs'\), join\(evals, 'linked\.mjs'\)\)/);
  assert.doesNotMatch(source, /await import\(STATIC_ANALYZER\)/,
    'Windows drive paths must be converted to file URLs before dynamic import');
  assert.doesNotMatch(source, /lastIndexOf\('\/'\)/,
    'temporary fixture names must use the native path implementation');
  assert.equal(readFileSync(join(ROOT, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
});

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
  assert.equal(output.file_count, 65);
  assert.equal(output.raw_export_name_count, 394);
  assert.equal(output.failures.length, 0);
  const linkedIds = output.files.flatMap((file) =>
    file.export_names.map((name) => `${file.module}#${name}`)).sort(byteSort);
  const analyzer = await import(STATIC_ANALYZER_URL);
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

test('STEP0-3 link-only extractor links repo-contained mjs dependencies but rejects escape and symlink decoys', () => {
  const run = (scriptsRoot) => spawnSync(process.execPath, [
    '--no-warnings', '--experimental-vm-modules', LINK_ONLY_EXTRACTOR, '--scripts-root', scriptsRoot,
  ], { encoding: 'utf8' });
  const scratch = mkdtempSync(join(tmpdir(), 'wsu1-link-boundary-'));
  const scripts = join(scratch, 'scripts');
  const evals = join(scratch, 'evals');
  mkdirSync(scripts);
  mkdirSync(evals);
  writeFileSync(join(evals, 'dep.mjs'), 'export const value = 1;\n');
  writeFileSync(join(scripts, 'main.mjs'), "export { value } from '../evals/dep.mjs';\n");
  const linked = run(scripts);
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(JSON.parse(linked.stdout).raw_export_name_count, 1);

  const outside = join(dirname(scratch), `${basename(scratch)}-outside.mjs`);
  writeFileSync(outside, 'export const escaped = true;\n');
  writeFileSync(join(scripts, 'main.mjs'), `export { escaped } from '../../${basename(outside)}';\n`);
  const escaped = run(scripts);
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /IMPORT_OUTSIDE_REPOSITORY/);

  writeFileSync(join(scripts, 'main.mjs'), "export { value } from '../evals/linked.mjs';\n");
  createFileSymlink(join(evals, 'dep.mjs'), join(evals, 'linked.mjs'));
  const symlink = run(scripts);
  assert.notEqual(symlink.status, 0);
  assert.match(symlink.stderr, /UNSAFE_REPOSITORY_IMPORT/);
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
  const analyzer = await import(STATIC_ANALYZER_URL);
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
  const analyzer = await import(STATIC_ANALYZER_URL);
  const result = analyzer.extractExportSurface({ files: [join(FIXTURES, 'mut16.js')] });
  assert.deepEqual(result.failures, [{
    guard: 1,
    file: 'mut16.js',
    reason: 'non-mjs-script',
  }]);
});

test('STEP0-3 static export parser matches the measured 394 raw and 386 canonical surface', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const result = analyzer.extractExportSurface({ files: recursiveFiles(join(ROOT, 'scripts')) });
  assert.deepEqual(result.failures, []);
  assert.equal(result.raw_ids.length, 394);
  assert.equal(result.canonical_ids.length, 386);
});

test('STEP0-3 live overlay closes the measured current delta with a disjoint 386-row partition', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const seed = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'), 'utf8');
  const overlay = readFileSync(join(FIXTURES, 'activation-pending-classification.md'), 'utf8');
  const live = analyzer.parseLiveClassification({ seed, overlay });
  assert.deepEqual(live.counts, {
    L: 33, B: 7, X: 34, E2: 150, E3: 14, E4: 21, E5: 1, E7: 86, E8: 40,
  });
  assert.equal(live.rows.size, 386);
  assert.deepEqual(live.rows.get('review.mjs#configureReviewFlags'), {
    classification: 'L', reason: 'leasecheck-dominated',
  });
  assert.deepEqual([
    'attended-launch.mjs#revokeAttendedLaunch',
    'budget.mjs#settleTerminalCodexMakerCost',
    'initrun.mjs#initRun',
    'lease.mjs#acquireLease',
    'lease.mjs#advanceHandoffPhase',
    'lease.mjs#rollbackReservedEmit',
    'project-root-recovery.mjs#acquireRootRecovery',
    'project-root-recovery.mjs#rebindProjectRoot',
    'project-root-recovery.mjs#recoverRelocatedRoot',
    'recover.mjs#acquireRecovery',
    'recover.mjs#recoverRun',
    'respawn.mjs#respawn',
    'spawn-optin.mjs#resetDesktop',
  ].map((id) => [id, live.rows.get(id)]), [
    ['attended-launch.mjs#revokeAttendedLaunch', {
      classification: 'X', reason: 'safety-downgrade',
    }],
    ['budget.mjs#settleTerminalCodexMakerCost', {
      classification: 'X', reason: 'structural-no-target',
    }],
    ['initrun.mjs#initRun', {
      classification: 'X', reason: 'structural-no-target',
    }],
    ['lease.mjs#acquireLease', {
      classification: 'X', reason: 'acquire-chain',
    }],
    ['lease.mjs#advanceHandoffPhase', {
      classification: 'X', reason: 'structural-no-target',
    }],
    ['lease.mjs#rollbackReservedEmit', {
      classification: 'X', reason: 'structural-no-target',
    }],
    ['project-root-recovery.mjs#acquireRootRecovery', {
      classification: 'X', reason: 'acquire-chain',
    }],
    ['project-root-recovery.mjs#rebindProjectRoot', {
      classification: 'X', reason: 'acquire-chain',
    }],
    ['project-root-recovery.mjs#recoverRelocatedRoot', {
      classification: 'X', reason: 'acquire-chain',
    }],
    ['recover.mjs#acquireRecovery', {
      classification: 'X', reason: 'acquire-chain',
    }],
    ['recover.mjs#recoverRun', {
      classification: 'X', reason: 'structural-no-target',
    }],
    ['respawn.mjs#respawn', {
      classification: 'X', reason: 'structural-no-target',
    }],
    ['spawn-optin.mjs#resetDesktop', {
      classification: 'X', reason: 'safety-downgrade',
    }],
  ]);
  assert.deepEqual([...live.rows.entries()].filter(([id]) => [
    'activation-secret.mjs#activateStoredLease',
    'codex-checker.mjs#captureTrustedCheckerSkill',
    'headless-host.mjs#acquireHeadlessHostLock',
    'lease.mjs#activateLease',
    'lease.mjs#reapLease',
    'preflight-receipt-journal.mjs#markCheckerImportUnconfirmed',
    'review-import.mjs#locateCapturedImportedReviewArtifact',
    'review-import.mjs#verifyCapturedImportedReviewProof',
    'schema.mjs#CHECKER_PROCESS_PHASES',
    'schema.mjs#CHECKER_PROCESS_REASON_CODES',
    'schema.mjs#CHECKER_PROCESS_REASON_PHASES',
    'schema.mjs#validCheckerIdentityDiagnostic',
    'schema.mjs#validCheckerImportDiagnostic',
    'schema.mjs#validCheckerProcessDiagnostic',
    'schema.mjs#validProcessStreamMetadata',
  ].includes(id)), [
    ['activation-secret.mjs#activateStoredLease', { classification: 'X', reason: 'enforcement-origin' }],
    ['codex-checker.mjs#captureTrustedCheckerSkill', { classification: 'E4', reason: 'non-run-state-durable-write' }],
    ['headless-host.mjs#acquireHeadlessHostLock', { classification: 'X', reason: 'damage-repair' }],
    ['lease.mjs#activateLease', { classification: 'X', reason: 'enforcement-origin' }],
    ['lease.mjs#reapLease', { classification: 'X', reason: 'enforcement-origin' }],
    ['preflight-receipt-journal.mjs#markCheckerImportUnconfirmed', { classification: 'E4', reason: 'non-run-state-durable-write' }],
    ['review-import.mjs#locateCapturedImportedReviewArtifact', { classification: 'E2', reason: 'no-run-state-write' }],
    ['review-import.mjs#verifyCapturedImportedReviewProof', { classification: 'E2', reason: 'no-run-state-write' }],
    ['schema.mjs#CHECKER_PROCESS_PHASES', { classification: 'E8', reason: 'non-callable-value' }],
    ['schema.mjs#CHECKER_PROCESS_REASON_CODES', { classification: 'E8', reason: 'non-callable-value' }],
    ['schema.mjs#CHECKER_PROCESS_REASON_PHASES', { classification: 'E8', reason: 'non-callable-value' }],
    ['schema.mjs#validCheckerIdentityDiagnostic', { classification: 'E2', reason: 'no-run-state-write' }],
    ['schema.mjs#validCheckerImportDiagnostic', { classification: 'E2', reason: 'no-run-state-write' }],
    ['schema.mjs#validCheckerProcessDiagnostic', { classification: 'E2', reason: 'no-run-state-write' }],
    ['schema.mjs#validProcessStreamMetadata', { classification: 'E2', reason: 'no-run-state-write' }],
  ]);
});

test('STEP0-3 every current-delta row is required and rejects a wrong category', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const seed = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'), 'utf8');
  const overlay = readFileSync(join(FIXTURES, 'activation-pending-classification.md'), 'utf8');
  const begin = '<!-- F26-LIVE-JSON-BEGIN -->';
  const end = '<!-- F26-LIVE-JSON-END -->';
  const start = overlay.indexOf(begin) + begin.length;
  const finish = overlay.indexOf(end, start);
  const config = JSON.parse(overlay.slice(start, finish));
  const render = value => `${overlay.slice(0, start)}\n${JSON.stringify(value)}\n${overlay.slice(finish)}`;
  const currentDelta = config.add.slice(12);
  assert.equal(currentDelta.length, 74);
  for (const row of currentDelta) {
    const removed = structuredClone(config);
    removed.add = removed.add.filter(({ id }) => id !== row.id);
    assert.throws(() => analyzer.parseLiveClassification({ seed, overlay: render(removed) }),
      /CLASSIFICATION_COUNT_MISMATCH/, `removal mutant ${row.id}`);
  }
  const missingOverride = structuredClone(config);
  missingOverride.override = [];
  assert.throws(() => analyzer.parseLiveClassification({ seed, overlay: render(missingOverride) }),
    /CLASSIFICATION_COUNT_MISMATCH/, 'restore override removal mutant');
  for (const row of currentDelta) {
    const wrong = structuredClone(config);
    const target = wrong.add.find(({ id }) => id === row.id);
    target.classification = target.classification === 'E2' ? 'E7' : 'E2';
    target.reason = target.classification === 'E2' ? 'no-run-state-write' : 'expanded-read-pure-non-run-state';
    assert.throws(() => analyzer.parseLiveClassification({ seed, overlay: render(wrong) }),
      /CLASSIFICATION_COUNT_MISMATCH/, `wrong-category mutant ${row.id}`);
  }
});

test('STEP0-3 structural exceptions require their closed source preconditions', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const cases = [
    {
      id: 'budget.mjs#settleTerminalCodexMakerCost',
      file: 'lib/budget.mjs',
      remove: (source) => source.replace(
        "if (loop.status !== 'completed' && loop.status !== 'stopped') throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');",
        "if (false) throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');"),
      prewrite: (source) => source.replace(
        "if (loop.status !== 'completed' && loop.status !== 'stopped') throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');",
        "appendEvent(root, runId, { type: 'mutant', data: {} });\n    if (loop.status !== 'completed' && loop.status !== 'stopped') throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');"),
    },
    {
      id: 'initrun.mjs#initRun',
      file: 'lib/initrun.mjs',
      remove: (source) => source.replace(
        'const runId = ulid(now.getTime());',
        "const runId = 'caller-selected';"),
      prewrite: (source) => source.replace(
        'const runId = ulid(now.getTime());',
        "writeState(canonicalRoot, 'existing-run', loop);\n  const runId = ulid(now.getTime());"),
    },
    {
      id: 'lease.mjs#advanceHandoffPhase',
      file: 'lib/lease.mjs',
      remove: (source) => source.replace(
        "if (next !== cur + 1) return { ok: false, reason: `illegal-transition ${lease.handoff_phase}->${toPhase}` };",
        "if (false) return { ok: false, reason: `illegal-transition ${lease.handoff_phase}->${toPhase}` };"),
      prewrite: (source) => source.replace(
        "if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };",
        "writeState(root, runId, data);\n    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };"),
    },
    {
      id: 'lease.mjs#rollbackReservedEmit',
      file: 'lib/lease.mjs',
      remove: (source) => source.replace(
        "if (childCommitted || lease.handoff_phase !== 'reserved') {",
        'if (false) {'),
      prewrite: (source) => source.replace(
        "if (childCommitted || lease.handoff_phase !== 'reserved') {",
        "writeState(root, runId, data);\n    if (childCommitted || lease.handoff_phase !== 'reserved') {"),
    },
    {
      id: 'recover.mjs#recoverRun',
      file: 'lib/recover.mjs',
      remove: (source) => source.replace(
        "if (snapshot.status !== 'paused') {",
        'if (false) {'),
      prewrite: (source) => source.replace(
        "if (snapshot.status !== 'paused') {",
        "legacyRecover(root, runId, { expect, now });\n  if (snapshot.status !== 'paused') {"),
    },
    {
      id: 'respawn.mjs#respawn',
      file: 'lib/respawn.mjs',
      remove: (source) => {
        const needle = "if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {";
        const at = source.lastIndexOf(needle);
        return at < 0 ? source : `${source.slice(0, at)}if (false) {${source.slice(at + needle.length)}`;
      },
      prewrite: (source) => {
        const needle = "if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {";
        const at = source.lastIndexOf(needle);
        return at < 0 ? source
          : `${source.slice(0, at)}preservePause(root, runId, {});\n  ${source.slice(at)}`;
      },
    },
  ];
  for (const item of cases) {
    const source = readFileSync(join(ROOT, 'scripts', item.file), 'utf8');
    const proof = analyzer.structuralPreconditionProof({ id: item.id, source });
    assert.equal(proof?.kind, item.id === 'initrun.mjs#initRun'
      ? 'fresh-target-isolation' : 'state-precondition');
    const mutant = item.remove(source);
    assert.notEqual(mutant, source, `${item.id} mutant replacement must apply`);
    assert.equal(analyzer.structuralPreconditionProof({ id: item.id, source: mutant }), null,
      `${item.id} guard/binding removal must invalidate the proof`);
    const prewrite = item.prewrite(source);
    assert.notEqual(prewrite, source, `${item.id} pre-guard write mutant must apply`);
    assert.equal(analyzer.structuralPreconditionProof({ id: item.id, source: prewrite }), null,
      `${item.id} pre-guard write must invalidate the proof`);
  }
  const leaseSource = readFileSync(join(ROOT, 'scripts', 'lib', 'lease.mjs'), 'utf8');
  const nestedPrewrite = leaseSource.replace(
    "if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };",
    "if (true) { writeState(root, runId, data); }\n    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };");
  assert.notEqual(nestedPrewrite, leaseSource);
  assert.equal(analyzer.structuralPreconditionProof({
    id: 'lease.mjs#advanceHandoffPhase', source: nestedPrewrite,
  }), null, 'nested unconditional pre-guard write must invalidate the proof');
  const wrappedPrewrite = leaseSource
    .replace('export function advanceHandoffPhase',
      'function mutantWrite(root, runId, data) { writeState(root, runId, data); }\n\nexport function advanceHandoffPhase')
    .replace("if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };",
      "mutantWrite(root, runId, data);\n    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };");
  assert.notEqual(wrappedPrewrite, leaseSource);
  assert.equal(analyzer.structuralPreconditionProof({
    id: 'lease.mjs#advanceHandoffPhase', source: wrappedPrewrite,
  }), null, 'transitive pre-guard write must invalidate the proof');
});

test('STEP0-3 call graph recomputes reachability and same-lock dominance for every live row', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const seed = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'), 'utf8');
  const overlay = readFileSync(join(FIXTURES, 'activation-pending-classification.md'), 'utf8');
  const live = analyzer.parseLiveClassification({ seed, overlay });
  const result = analyzer.analyzeClassification({
    files: recursiveFiles(join(ROOT, 'scripts')),
    live,
  });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.violations, []);
  assert.equal(result.rows.length, 386);
  assert.deepEqual(result.rows.find(({ id }) => id === 'headless-host.mjs#acquireHeadlessHostLock'), {
    id: 'headless-host.mjs#acquireHeadlessHostLock',
    classification: 'X',
    write_reachability: 'reaches',
    leasecheck_dominance: 'does-not-dominate',
    reason: 'damage-repair',
    evidence: [
      {
        kind: 'non-dominance',
        path: [
          'headless-host.mjs#acquireHeadlessHostLock',
          'state.mjs#withReconciledMutationLock',
          'integrity.mjs#withReconciledMutationLock',
          'integrity.mjs#reconcileAnchoredPublicationLocked',
        ],
        coordinates: [
          'scripts/lib/headless-host.mjs:213',
          'scripts/lib/state.mjs:270',
          'scripts/lib/integrity.mjs:1953',
          'scripts/lib/integrity.mjs:1806',
        ],
      },
      {
        kind: 'transitive',
        path: [
          'headless-host.mjs#acquireHeadlessHostLock',
          'state.mjs#withReconciledMutationLock',
          'integrity.mjs#withReconciledMutationLock',
          'integrity.mjs#reconcileAnchoredPublicationLocked',
        ],
        coordinates: [
          'scripts/lib/headless-host.mjs:213',
          'scripts/lib/state.mjs:270',
          'scripts/lib/integrity.mjs:1953',
          'scripts/lib/integrity.mjs:1806',
        ],
      },
    ],
  });
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
  const dualPendingBlockIds = [
    'breaker.mjs#recordReviewVerdict',
    'comprehension.mjs#ack',
    'state.mjs#patch',
  ];
  for (const id of dualPendingBlockIds) {
    const row = result.rows.find((candidate) => candidate.id === id);
    assert.equal(row.activation_pending_block_dominance, 'dominates', id);
    assert.equal(row.evidence.some(({ kind }) => kind === 'activation-pending-block-dominance'), true, id);
  }
  assert.equal(conditionalRows.filter(({ activation_pending_block_dominance }) =>
    activation_pending_block_dominance !== 'dominates').length, 7,
  'only seven conditional L rows still require public-wiring human review');
  const stored = result.rows.find(({ id }) => id === 'activation-secret.mjs#activateStoredLease');
  assert.equal(stored.write_reachability, 'reaches');
  assert.equal(stored.leasecheck_dominance, 'does-not-dominate');
  assert.equal(stored.evidence.some(({ kind, path }) => kind === 'transitive'
    && path[0] === 'activation-secret.mjs#activateStoredLease'
    && path[1] === 'lease.mjs#activateLease'
    && path.at(-1) === 'integrity.mjs#appendAnchored'), true);
  assert.equal(stored.evidence.some(({ kind }) => kind === 'no-path'), false,
    'default dependency aliases must not seal stale no-path evidence');
});

test('STEP0-3 higher-order authorize gates dominate writes and gate-removal mutants fail closed', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const analyze = (name, source) => {
    const scratch = mkdtempSync(join(tmpdir(), 'wsu1-authorize-boundary-'));
    const file = join(scratch, name);
    writeFileSync(file, source);
    const id = `${name}#surface`;
    return analyzer.analyzeClassification({
      files: [file],
      live: { rows: new Map([[id, { classification: 'L', reason: 'leasecheck-dominated' }]]) },
      requireExactSurface: false,
    });
  };
  const source = [
    "import { withFencedReconciledMutationLock } from './integrity.mjs';",
    "import { writeCompactRestoreState } from './state.mjs';",
    "import { leaseCheck } from './lease.mjs';",
    'export function surface(root, runId, fence) {',
    '  return withFencedReconciledMutationLock(root, runId, (_guard, { data }) => {',
    '    writeCompactRestoreState(root, runId, data, data.updated_at);',
    '  }, { authorize: (_guard, { data }) => leaseCheck(data, fence) });',
    '}',
  ].join('\n');
  const guarded = analyze('guarded.mjs', source);
  assert.deepEqual(guarded.violations, []);
  assert.equal(guarded.rows[0].leasecheck_dominance, 'dominates');
  for (const mutant of [
    source.replace('leaseCheck(data, fence)', 'true'),
    source.replace('writeCompactRestoreState(root, runId, data, data.updated_at);',
      'writeCompactRestoreState(root, runId, data, data.updated_at);\n    return true;')
      .replace(', { authorize: (_guard, { data }) => leaseCheck(data, fence) }', ''),
  ]) {
    const result = analyze('mutant.mjs', mutant);
    assert.equal(result.violations.some(({ code }) => code === 'L_WRITE_NOT_DOMINATED'), true);
  }
});

test('STEP0-3 dual pending-block proof rejects missing, misplaced, conditional, and partial guards', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const liveRow = (id) => ({ rows: new Map([[id, {
    classification: 'L', reason: 'leasecheck-dominated',
  }]]) });
  const analyzeMutant = (id, source) => {
    const scratch = mkdtempSync(join(tmpdir(), 'wsu1-f26-pending-block-'));
    const file = join(scratch, id.slice(0, id.indexOf('#')));
    writeFileSync(file, source);
    return analyzer.analyzeClassification({ files: [file], live: liveRow(id), requireExactSurface: false });
  };
  const targets = [
    ['state.mjs#patch', readFileSync(join(ROOT, 'scripts/lib/state.mjs'), 'utf8')],
    ['breaker.mjs#recordReviewVerdict', readFileSync(join(ROOT, 'scripts/lib/breaker.mjs'), 'utf8')],
    ['comprehension.mjs#ack', readFileSync(join(ROOT, 'scripts/lib/comprehension.mjs'), 'utf8')],
  ];
  for (const [id, source] of targets) {
    const guard = /\s*else if \([^\n]*activation_deadline_at != null\) \{\n\s*throw new Error\('ACTIVATION_PENDING: [^']+'\);\n\s*\}/;
    const removed = source.replace(guard, '');
    assert.notEqual(removed, source, `${id} guard-removal mutant must apply`);
    const result = analyzeMutant(id, removed);
    assert.equal(result.violations.some((item) =>
      item.code === 'L_PENDING_BLOCK_NOT_DOMINATED' && item.id === id), true, id);
  }

  const ackSource = targets.find(([id]) => id === 'comprehension.mjs#ack')[1];
  const oneGuardRemoved = ackSource.replace(
    /\s*else if \([^\n]*activation_deadline_at != null\) \{\n\s*throw new Error\('ACTIVATION_PENDING: ack'\);\n\s*\}/,
    '',
  );
  assert.notEqual(oneGuardRemoved, ackSource);
  assert.equal(analyzeMutant('comprehension.mjs#ack', oneGuardRemoved).violations.some(({ code }) =>
    code === 'L_PENDING_BLOCK_NOT_DOMINATED'), true, 'both ack append branches must be covered');

  const conditional = targets[0][1].replace('else if (loop.session_chain.lease.activation_deadline_at != null)',
    'else if (fence && loop.session_chain.lease.activation_deadline_at != null)');
  assert.notEqual(conditional, targets[0][1]);
  assert.equal(analyzeMutant('state.mjs#patch', conditional).violations.some(({ code }) =>
    code === 'L_PENDING_BLOCK_NOT_DOMINATED'), true, 'absent-fence block cannot depend on fence truthiness');

  const wrongBinding = targets[0][1].replace(
    'loop.session_chain.lease.activation_deadline_at != null',
    'attacker.session_chain.lease.activation_deadline_at != null',
  );
  assert.notEqual(wrongBinding, targets[0][1]);
  assert.equal(analyzeMutant('state.mjs#patch', wrongBinding).violations.some(({ code }) =>
    code === 'L_PENDING_BLOCK_NOT_DOMINATED'), true, 'guard must bind the locked callback state');

  const outsideLock = targets[1][1].replace(
    '  return withReconciledMutationLock(root, runId, (_guard, { data }) => {',
    "  if (captureReconciledRunSnapshot(root, runId).data.session_chain.lease.activation_deadline_at != null) throw new Error('ACTIVATION_PENDING: recordReviewVerdict');\n  return withReconciledMutationLock(root, runId, (_guard, { data }) => {",
  ).replace(/\s*else if \([^\n]*activation_deadline_at != null\) \{\n\s*throw new Error\('ACTIVATION_PENDING: recordReviewVerdict'\);\n\s*\}/, '');
  assert.notEqual(outsideLock, targets[1][1]);
  assert.equal(analyzeMutant('breaker.mjs#recordReviewVerdict', outsideLock).violations.some(({ code }) =>
    code === 'L_PENDING_BLOCK_NOT_DOMINATED'), true, 'stale out-of-lock precheck cannot count');
});

test('STEP0-3 analyzer generically follows nullish default dependency aliases', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const scratch = mkdtempSync(join(tmpdir(), 'wsu1-f26-default-alias-'));
  const wrapper = join(scratch, 'default-alias.mjs');
  writeFileSync(wrapper, `import { appendAnchored } from '${join(ROOT, 'scripts', 'lib', 'integrity.mjs')}';\n`
    + 'export function wrapper(deps = {}) {\n'
    + '  const writeFn = deps.writeFn ?? appendAnchored;\n'
    + "  return writeFn('/root', 'run', { type: 'x' }, () => {}, () => {});\n"
    + '}\n');
  const result = analyzer.analyzeClassification({
    files: [wrapper],
    live: { rows: new Map([['default-alias.mjs#wrapper', {
      classification: 'X', reason: 'enforcement-origin',
    }]]) },
    requireExactSurface: false,
  });
  assert.deepEqual(result.failures, []);
  const row = result.rows[0];
  assert.equal(row.write_reachability, 'reaches');
  assert.deepEqual(row.evidence.find(({ kind }) => kind === 'direct')?.path,
    ['default-alias.mjs#wrapper', 'integrity.mjs#appendAnchored']);
});

test('STEP0-3 repair gateway recursion rejects stale damage-repair no-path evidence', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
  const scratch = mkdtempSync(join(tmpdir(), 'wsu1-f26-repair-gateway-'));
  const integrity = join(scratch, 'integrity.mjs');
  const state = join(scratch, 'state.mjs');
  const caller = join(scratch, 'headless-host.mjs');
  const detached = join(scratch, 'detached.mjs');
  writeFileSync(integrity, 'export function reconcileAnchoredPublicationLocked() {}\n');
  writeFileSync(state, "import { reconcileAnchoredPublicationLocked } from './integrity.mjs';\nexport function withReconciledMutationLock() { return reconcileAnchoredPublicationLocked(); }\n");
  writeFileSync(caller, "import { withReconciledMutationLock } from './state.mjs';\nexport function acquireHeadlessHostLock() { return withReconciledMutationLock(); }\n");
  writeFileSync(detached, 'export function detachedRepair() {}\n');

  const reached = analyzer.analyzeClassification({
    files: [integrity, state, caller],
    live: { rows: new Map([['headless-host.mjs#acquireHeadlessHostLock', {
      classification: 'X', reason: 'damage-repair',
    }]]) },
    requireExactSurface: false,
  });
  assert.deepEqual(reached.violations, []);
  assert.deepEqual(reached.rows[0].evidence.find(({ kind }) => kind === 'transitive').path, [
    'headless-host.mjs#acquireHeadlessHostLock',
    'state.mjs#withReconciledMutationLock',
    'integrity.mjs#reconcileAnchoredPublicationLocked',
  ]);

  const stale = analyzer.analyzeClassification({
    files: [detached],
    live: { rows: new Map([['detached.mjs#detachedRepair', {
      classification: 'X', reason: 'damage-repair',
    }]]) },
    requireExactSurface: false,
  });
  assert.equal(stale.rows[0].evidence[0].kind, 'no-path');
  assert.deepEqual(stale.violations, [{
    code: 'CLASSIFICATION_RECALCULATION_MISMATCH', id: 'detached.mjs#detachedRepair',
  }]);
});

test('STEP0-3 W1 and W2 inspect direct calls or references for every E2-E5/E7/E8 row', async () => {
  const analyzer = await import(STATIC_ANALYZER_URL);
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
  const analyzer = await import(STATIC_ANALYZER_URL);
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
    code === 'STRUCTURAL_PRECONDITION_MISSING'), true);

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
  const analyzer = await import(STATIC_ANALYZER_URL);
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
  const analyzer = await import(STATIC_ANALYZER_URL);
  const seedBytes = readFileSync(join(FIXTURES, 'activation-pending-classification.seed.md'));
  const liveBytes = readFileSync(join(FIXTURES, 'activation-pending-classification.md'));
  const evidence = JSON.parse(readFileSync(
    join(FIXTURES, 'activation-pending-classification-evidence.json'), 'utf8'));
  assert.deepEqual(Object.keys(evidence), [
    'schema_version', 'design_sha256', 'seed_sha256', 'live_classification_sha256',
    'candidate_ids_sha256', 'candidate_ids', 'rows',
  ]);
  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.design_sha256, 'b56b161c883eae957718b70fabc31bbec293ba4173e6404cac542aeea9abc61a');
  assert.equal(evidence.seed_sha256, sha256(seedBytes));
  assert.equal(evidence.live_classification_sha256, sha256(liveBytes));
  assert.equal(evidence.candidate_ids_sha256,
    sha256(Buffer.from(`${evidence.candidate_ids.join('\n')}\n`)));
  const dualPendingBlockIds = new Set([
    'breaker.mjs#recordReviewVerdict',
    'comprehension.mjs#ack',
    'state.mjs#patch',
  ]);
  const structuralPreconditionIds = new Set([
    'budget.mjs#settleTerminalCodexMakerCost',
    'initrun.mjs#initRun',
    'lease.mjs#advanceHandoffPhase',
    'lease.mjs#rollbackReservedEmit',
    'recover.mjs#recoverRun',
    'respawn.mjs#respawn',
  ]);
  for (const row of evidence.rows) {
    const rowKeys = ['id', 'classification', 'write_reachability', 'leasecheck_dominance', 'reason', 'evidence'];
    if (dualPendingBlockIds.has(row.id)) rowKeys.push('activation_pending_block_dominance');
    if (structuralPreconditionIds.has(row.id)) rowKeys.push('structural_precondition');
    assert.equal(exactKeys(row, rowKeys), true,
    `unexpected evidence row shape for ${row.id}`);
    assert.equal(row.evidence.every((item) => exactKeys(item, ['kind', 'path', 'coordinates'])), true,
      `unexpected evidence item shape for ${row.id}`);
  }

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
