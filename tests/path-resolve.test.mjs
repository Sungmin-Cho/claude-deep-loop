import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { captureStableFileIdentity } from '../scripts/lib/fs-safe.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { appendAnchored, captureVerifiedRunSnapshot } from '../scripts/lib/integrity.mjs';
import { resolveRunPath } from '../scripts/lib/path-resolve.mjs';
import { captureReconciledRunSnapshot, readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { createDirectoryJunction, createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO_ROOT, 'scripts', 'deep-loop.mjs');
const NOW = new Date('2026-08-05T00:00:00.000Z');
const realpath = realpathSync.native || realpathSync;

function freshRoot(prefix = 'deep-loop-path-resolve-') {
  return realpath(mkdtempSync(join(tmpdir(), prefix)));
}

function seed({ worktree = '.claude/worktrees/impl' } = {}) {
  const root = freshRoot();
  const { runId } = initRun(root, { runtime: 'codex', goal: 'path resolver', now: NOW });
  const worktreeAbs = join(root, ...worktree.split('/'));
  mkdirSync(worktreeAbs, { recursive: true });
  const { id: workstreamId } = newWorkstream(root, runId, {
    title: 'impl', branch: 'feature/impl', worktree,
    fence: { owner: runId, generation: 1, intent: 'business' }, now: NOW,
  });
  return { root, runId, workstreamId, worktreeAbs };
}

function invoke(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function lstatOrNull(path) {
  try { return lstatSync(path); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function fileSnapshot(path) {
  const stat = lstatOrNull(path);
  if (!stat) return { present: false };
  return {
    present: true,
    identity: captureStableFileIdentity(path),
    kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'special',
    bytes: stat.isFile() ? readFileSync(path).toString('base64') : null,
  };
}

function recursiveFiles(path) {
  const stat = lstatOrNull(path);
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .flatMap(entry => recursiveFiles(join(path, entry.name)))
    .sort();
}

function stableRunSnapshotAt(dir, operationId) {
  const fixed = ['loop.json', '.loop.hash', 'event-log.jsonl'].map(name => join(dir, name));
  const transactionRoot = join(dir, 'transactions');
  const selected = new Set([...fixed, ...recursiveFiles(transactionRoot)]);
  if (operationId) selected.add(join(transactionRoot, operationId, 'committed.json'));
  return Object.fromEntries([...selected].sort().map(path => [relative(dir, path), fileSnapshot(path)]));
}

function stableCore(root, runId) {
  return stableRunSnapshotAt(runDir(root, runId));
}

function preparePublication(root, runId, operationId, barrier = 'prepared:digest-verified') {
  assert.throws(() => appendAnchored(
    root,
    runId,
    { type: 'path-resolve-fixture', data: { operation_id: operationId }, now: '2026-08-05T00:01:00.000Z' },
    loop => { loop.discovered_items.push(operationId); },
    undefined,
    {
      publication: {
        kind: 'path-resolve-fixture',
        operationId,
        artifacts: barrier.startsWith('artifact:')
          ? [{ rel: 'artifacts/partial.txt', bytes: Buffer.from('partial') }]
          : [],
        topology: { operation_id: operationId },
        faultAt(label) {
          if (label === barrier) throw new Error('fixture-stop-after-prepare');
        },
      },
    },
  ), /TRANSACTION_PENDING/);
}

function publishPublication(root, runId, operationId) {
  return appendAnchored(
    root,
    runId,
    { type: 'path-resolve-committed-fixture', data: { operation_id: operationId }, now: '2026-08-05T00:01:00.000Z' },
    loop => { loop.discovered_items.push(operationId); },
    undefined,
    {
      publication: {
        kind: 'path-resolve-fixture',
        operationId,
        artifacts: [],
        topology: { operation_id: operationId },
      },
    },
  );
}

function moveLineageComponent(root, runId, componentRel, variant) {
  const original = join(root, ...componentRel.split('/'));
  const originalRunDir = runDir(root, runId);
  let moved = `${original}.preserved-${variant}`;
  if (variant === 'external') {
    const outside = freshRoot('deep-loop-path-lineage-external-');
    moved = join(outside, 'preserved');
  }
  renameSync(original, moved);
  const movedRunDir = join(moved, relative(original, originalRunDir));
  if (variant === 'internal' || variant === 'external') {
    createDirectoryJunction(moved, original);
  } else if (variant === 'dangling') {
    const missing = join(freshRoot('deep-loop-path-dangling-parent-'), 'missing');
    createDirectoryJunction(missing, original);
  } else if (variant === 'regular-file') {
    writeFileSync(original, 'not a directory');
  } else if (variant === 'special-node') {
    assert.notEqual(process.platform, 'win32', 'POSIX FIFO fixture is selected only on POSIX');
    execFileSync('mkfifo', [original]);
  } else {
    throw new Error(`unknown fixture variant: ${variant}`);
  }
  return { original, moved, movedRunDir };
}

function replaceWorktreeComponent(root, componentRel, variant) {
  const original = join(root, ...componentRel.split('/'));
  let moved = `${original}.preserved-${variant}`;
  if (variant === 'external') {
    const outside = freshRoot('deep-loop-worktree-lineage-external-');
    moved = join(outside, 'preserved');
  }
  renameSync(original, moved);
  if (variant === 'internal' || variant === 'external') {
    createDirectoryJunction(moved, original);
  } else if (variant === 'dangling') {
    const missing = join(freshRoot('deep-loop-worktree-dangling-parent-'), 'missing');
    createDirectoryJunction(missing, original);
  } else if (variant === 'regular-file') {
    writeFileSync(original, 'not a directory');
  } else if (variant === 'special-node') {
    assert.notEqual(process.platform, 'win32', 'POSIX FIFO fixture is selected only on POSIX');
    execFileSync('mkfifo', [original]);
  } else {
    throw new Error(`unknown fixture variant: ${variant}`);
  }
}

test('resolveRunPath returns canonical run and selected workstream directories without mutation', () => {
  for (const worktree of ['.claude/worktrees/impl', '.worktrees/impl']) {
    const { root, runId, workstreamId, worktreeAbs } = seed({ worktree });
    const before = stableCore(root, runId);
    assert.equal(resolveRunPath(root, runId, { target: 'run-dir' }), realpath(runDir(root, runId)));
    assert.deepEqual(stableCore(root, runId), before);
    assert.equal(resolveRunPath(root, runId, { target: 'workstream', workstreamId }), realpath(worktreeAbs));
    assert.deepEqual(stableCore(root, runId), before);
    const unused = worktree.startsWith('.claude/') ? join(root, '.worktrees') : join(root, '.claude');
    assert.equal(lstatOrNull(unused), null, 'unused convention may remain absent');
  }
});

test('resolver rejects unsafe run id segments before state capture', () => {
  const { root } = seed();
  for (const runId of ['.', '..', 'a/b', 'a\\b']) {
    assert.throws(() => resolveRunPath(root, runId, { target: 'run-dir' }), /^Error: RUN_DIR_ESCAPE/);
  }
});

test('resolver rejects missing or empty persisted worktree instead of returning root', () => {
  for (const corruption of ['missing', 'empty']) {
    const { root, runId, workstreamId } = seed();
    const { data } = readState(root, runId);
    const stored = data.workstreams.find(item => item.id === workstreamId);
    if (corruption === 'missing') delete stored.worktree;
    else stored.worktree = '';
    writeState(root, runId, data);
    assert.throws(
      () => resolveRunPath(root, runId, { target: 'workstream', workstreamId }),
      /^Error: WORKSTREAM_WORKTREE_ESCAPE/,
    );
  }
});

test('newWorkstream still rejects missing and empty worktree inputs', () => {
  const root = freshRoot();
  const { runId } = initRun(root, { runtime: 'codex', goal: 'input', now: NOW });
  for (const worktree of [undefined, '']) {
    assert.throws(() => newWorkstream(root, runId, {
      title: 'bad', branch: 'bad', worktree,
      fence: { owner: runId, generation: 1, intent: 'business' }, now: NOW,
    }), /WORKSTREAM_INPUT_INVALID/);
  }
});

test('run-dir rejects alias, regular-file, and special-node substitution at every selected prefix', () => {
  const components = ['.deep-loop', '.deep-loop/runs', null];
  const variants = ['internal', 'external', 'dangling', 'regular-file', ...(process.platform === 'win32' ? [] : ['special-node'])];
  for (const variant of variants) {
    for (const componentTemplate of components) {
      const { root, runId } = seed();
      const component = componentTemplate ?? `.deep-loop/runs/${runId}`;
      const { movedRunDir } = moveLineageComponent(root, runId, component, variant);
      const before = stableRunSnapshotAt(movedRunDir);
      assert.throws(
        () => resolveRunPath(root, runId, { target: 'run-dir' }),
        /^Error: RUN_DIR_ESCAPE/,
        `${variant} at ${component}`,
      );
      assert.deepEqual(stableRunSnapshotAt(movedRunDir), before, `${variant} at ${component}`);
    }
  }
});

test('workstream rejects alias, regular-file, and special-node substitution at every selected component', () => {
  const components = ['.claude', '.claude/worktrees', '.claude/worktrees/intermediate', '.claude/worktrees/intermediate/impl'];
  const variants = ['internal', 'external', 'dangling', 'regular-file', ...(process.platform === 'win32' ? [] : ['special-node'])];
  for (const variant of variants) {
    for (const component of components) {
      const { root, runId, workstreamId } = seed({ worktree: '.claude/worktrees/intermediate/impl' });
      const before = stableCore(root, runId);
      replaceWorktreeComponent(root, component, variant);
      assert.throws(
        () => resolveRunPath(root, runId, { target: 'workstream', workstreamId }),
        /^Error: WORKSTREAM_WORKTREE_ESCAPE/,
        `${variant} at ${component}`,
      );
      assert.deepEqual(stableCore(root, runId), before, `${variant} at ${component}`);
    }
  }
});

test('POSIX file-symlink lineage is rejected when the host permits the fixture', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file-symlink fixture');
    return;
  }
  const { root, runId } = seed();
  const leaf = runDir(root, runId);
  const preserved = `${leaf}.preserved-file-symlink`;
  renameSync(leaf, preserved);
  const target = join(freshRoot('deep-loop-path-file-target-'), 'target.txt');
  writeFileSync(target, 'file target');
  if (!createFileSymlinkOrSkip(t, target, leaf)) return;
  const before = stableRunSnapshotAt(preserved);
  assert.throws(() => resolveRunPath(root, runId, { target: 'run-dir' }), /^Error: RUN_DIR_ESCAPE/);
  assert.deepEqual(stableRunSnapshotAt(preserved), before);
});

test('prepared publication behind an internal or escaped run alias is rejected by both targets before reconciliation', () => {
  for (const variant of ['internal', 'external']) {
    const { root, runId, workstreamId } = seed();
    const operationId = `prepared-${variant}`;
    preparePublication(root, runId, operationId);
    const { movedRunDir } = moveLineageComponent(root, runId, `.deep-loop/runs/${runId}`, variant);
    const before = stableRunSnapshotAt(movedRunDir, operationId);
    for (const options of [
      { target: 'run-dir' },
      { target: 'workstream', workstreamId },
    ]) {
      assert.throws(() => resolveRunPath(root, runId, options), /^Error: RUN_DIR_ESCAPE/, `${variant}:${options.target}`);
      assert.deepEqual(stableRunSnapshotAt(movedRunDir, operationId), before, `${variant}:${options.target}`);
    }
  }
});

test('foreign-project prepared publication is bounded by verified integrity before either target can reconcile it', () => {
  const source = seed();
  const operationId = 'prepared-foreign-root';
  preparePublication(source.root, source.runId, operationId);
  const candidateRoot = freshRoot('deep-loop-path-foreign-candidate-');
  const candidateRunDir = runDir(candidateRoot, source.runId);
  mkdirSync(dirname(candidateRunDir), { recursive: true });
  cpSync(runDir(source.root, source.runId), candidateRunDir, { recursive: true, preserveTimestamps: true });
  mkdirSync(join(candidateRoot, '.claude', 'worktrees', 'impl'), { recursive: true });
  const before = stableRunSnapshotAt(candidateRunDir, operationId);
  for (const options of [
    { target: 'run-dir' },
    { target: 'workstream', workstreamId: source.workstreamId },
  ]) {
    assert.throws(
      () => resolveRunPath(candidateRoot, source.runId, options),
      /^Error: integrity-invalid:prepared-foreign-root:transaction-tree$/,
    );
    assert.deepEqual(stableRunSnapshotAt(candidateRunDir, operationId), before);
  }
});

test('safe in-root prepared publication requires explicit reconciliation before both targets resolve', () => {
  const { root, runId, workstreamId, worktreeAbs } = seed();
  const operationId = 'prepared-safe';
  preparePublication(root, runId, operationId);
  const beforeReconcile = stableRunSnapshotAt(runDir(root, runId), operationId);
  for (const options of [
    { target: 'run-dir' },
    { target: 'workstream', workstreamId },
  ]) {
    assert.throws(
      () => resolveRunPath(root, runId, options),
      /^Error: reconciliation-required:prepared-safe:prepared$/,
    );
    assert.deepEqual(stableRunSnapshotAt(runDir(root, runId), operationId), beforeReconcile);
  }

  const first = captureReconciledRunSnapshot(root, runId);
  assert.deepEqual(first.data.discovered_items, [operationId]);
  assert.equal(first.logLines.filter(event => event.type === 'path-resolve-fixture').length, 1);
  const afterReconcile = stableRunSnapshotAt(runDir(root, runId), operationId);
  assert.equal(resolveRunPath(root, runId, { target: 'run-dir' }), runDir(root, runId));
  assert.equal(resolveRunPath(root, runId, { target: 'workstream', workstreamId }), realpath(worktreeAbs));
  assert.deepEqual(stableRunSnapshotAt(runDir(root, runId), operationId), afterReconcile);
});

test('PATH-RESOLVE-PREPARED returns reconciliation-required', () => {
  const { root, runId } = seed();
  preparePublication(root, runId, 'path-prepared');
  const before = stableCore(root, runId);
  const verified = captureVerifiedRunSnapshot(root, runId);
  assert.deepEqual(verified, {
    ok: false,
    kind: 'reconciliation-required',
    operation_id: 'path-prepared',
    phase: 'prepared',
  });
  assert.throws(
    () => resolveRunPath(root, runId, { target: 'run-dir', snapshot: verified }),
    /reconciliation-required/,
  );
  assert.deepEqual(stableCore(root, runId), before);
});

test('PATH-RESOLVE-PARTIAL returns reconciliation-required', () => {
  const { root, runId } = seed();
  preparePublication(root, runId, 'path-partial', 'artifact:0:target-done');
  const before = stableCore(root, runId);
  const verified = captureVerifiedRunSnapshot(root, runId);
  assert.equal(verified.kind, 'reconciliation-required');
  assert.equal(verified.phase, 'partial');
  assert.throws(
    () => resolveRunPath(root, runId, { target: 'run-dir', snapshot: verified }),
    /reconciliation-required/,
  );
  assert.deepEqual(stableCore(root, runId), before);
});

test('PATH-RESOLVE-VALID-COMMITTED resolves from clean-committed', () => {
  const { root, runId } = seed();
  assert.equal(publishPublication(root, runId, 'path-clean').ok, true);
  const before = stableCore(root, runId);
  const verified = captureVerifiedRunSnapshot(root, runId);
  assert.equal(verified.ok, true);
  assert.equal(verified.kind, 'clean-committed');
  let injectedCalls = 0;
  assert.equal(resolveRunPath(root, runId, {
    target: 'run-dir',
    snapshot: verified,
    captureVerifiedRunSnapshot() { injectedCalls += 1; throw new Error('unexpected second capture'); },
  }), runDir(root, runId));
  assert.equal(injectedCalls, 0);
  assert.equal(resolveRunPath(root, runId, {
    target: 'run-dir',
    captureVerifiedRunSnapshot() { injectedCalls += 1; return verified; },
  }), runDir(root, runId));
  assert.equal(injectedCalls, 1);
  assert.deepEqual(stableCore(root, runId), before);
});

test('PATH-RESOLVE-CROSS-RUN rejects an injected snapshot for both targets', () => {
  const first = seed();
  const secondRun = initRun(first.root, { runtime: 'codex', goal: 'second', now: NOW });
  const secondWorktree = '.claude/worktrees/second';
  mkdirSync(join(first.root, secondWorktree), { recursive: true });
  const secondWorkstream = newWorkstream(first.root, secondRun.runId, {
    title: 'second', branch: 'feature/second', worktree: secondWorktree,
    fence: { owner: secondRun.runId, generation: 1, intent: 'business' }, now: NOW,
  });
  const secondSnapshot = captureVerifiedRunSnapshot(first.root, secondRun.runId);
  for (const options of [
    { target: 'run-dir' },
    { target: 'workstream', workstreamId: first.workstreamId },
  ]) {
    assert.throws(
      () => resolveRunPath({ root: first.root, runId: first.runId, snapshot: secondSnapshot, ...options }),
      /snapshot run mismatch/,
    );
  }
  // Also prove the polarity is not accidentally accepted in the other
  // direction when a workstream from B is supplied to A's resolver.
  assert.throws(
    () => resolveRunPath(first.root, secondRun.runId, {
      target: 'workstream', workstreamId: secondWorkstream.id,
      snapshot: { ...secondSnapshot.snapshot, data: { ...secondSnapshot.snapshot.data, run_id: first.runId } },
    }),
    /snapshot run mismatch/,
  );
});

test('PATH-RESOLVE-CROSS-ROOT rejects a same-run-id snapshot from another root', () => {
  const source = seed();
  const candidateRoot = freshRoot('deep-loop-path-root-polarity-');
  const candidateRunDir = runDir(candidateRoot, source.runId);
  mkdirSync(dirname(candidateRunDir), { recursive: true });
  cpSync(runDir(source.root, source.runId), candidateRunDir, { recursive: true, preserveTimestamps: true });
  const verified = captureVerifiedRunSnapshot(source.root, source.runId);

  assert.equal(resolveRunPath(source.root, source.runId, {
    target: 'run-dir', snapshot: verified,
  }), runDir(source.root, source.runId));
  assert.throws(
    () => resolveRunPath(candidateRoot, source.runId, { target: 'run-dir', snapshot: verified }),
    /snapshot root mismatch/,
  );
});

test('CLI path resolve has exact one-line output and strict grammar', () => {
  const { root, runId, workstreamId, worktreeAbs } = seed();
  const common = ['--project-root', root, '--run-id', runId];
  const okRun = invoke(['path', 'resolve', '--target', 'run-dir', ...common]);
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.equal(okRun.stderr, '');
  assert.equal(okRun.stdout, `${realpath(runDir(root, runId))}\n`);
  const okWs = invoke(['path', 'resolve', '--target', 'workstream', '--workstream', workstreamId, ...common]);
  assert.equal(okWs.status, 0, okWs.stderr);
  assert.equal(okWs.stderr, '');
  assert.equal(okWs.stdout, `${realpath(worktreeAbs)}\n`);

  const usageCases = [
    ['path'],
    ['path', 'unknown', ...common],
    ['path', 'resolve', ...common],
    ['path', 'resolve', '--target', ...common],
    ['path', 'resolve', '--target=', ...common],
    ['path', 'resolve', '--target', '', ...common],
    ['path', 'resolve', '--target', 'run-dir', '--target', 'run-dir', ...common],
    ['path', 'resolve', '--target', 'run-dir', '--workstream', workstreamId, ...common],
    ['path', 'resolve', '--target', 'workstream', ...common],
    ['path', 'resolve', '--target', 'workstream', '--workstream', ...common],
    ['path', 'resolve', '--target', 'workstream', '--workstream=', ...common],
    ['path', 'resolve', '--target', 'workstream', '--workstream', '', ...common],
    ['path', 'resolve', '--target', 'run-dir', '--project-root', '--run-id', runId],
    ['path', 'resolve', '--target', 'run-dir', '--project-root=', '--run-id', runId],
    ['path', 'resolve', '--target', 'run-dir', '--project-root', '', '--run-id', runId],
    ['path', 'resolve', '--target', 'run-dir', '--project-root', root, '--run-id'],
    ['path', 'resolve', '--target', 'run-dir', '--project-root', root, '--run-id='],
    ['path', 'resolve', '--target', 'run-dir', '--project-root', root, '--run-id', ''],
    ['path', 'resolve', '--target', 'run-dir', '--project-root', root, '--project-root', root, '--run-id', runId],
    ['path', 'resolve', '--target', 'run-dir', '--project-root', root, '--run-id', runId, '--run-id', runId],
    ['path', 'resolve', '--target', 'run-dir', '--unknown', 'x', ...common],
    ['path', 'resolve', 'positional', '--target', 'run-dir', ...common],
  ];
  for (const args of usageCases) {
    const result = invoke(args);
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
  }
});

test('CLI and shared classifier retain invalid-value and fence exit classes', () => {
  const { root, runId } = seed();
  const common = ['--project-root', root, '--run-id', runId];
  const invalidCases = [
    { args: ['path', 'resolve', '--target', 'bogus', '--workstream', 'x', ...common], code: 'PATH_TARGET_INVALID' },
    { args: ['path', 'resolve', '--target', 'workstream', '--workstream', 'missing', ...common], code: 'WORKSTREAM_NOT_FOUND' },
    { args: ['path', 'resolve', '--target', 'run-dir', '--project-root', join(root, 'missing'), '--run-id', runId], code: 'PROJECT_ROOT_UNRESOLVABLE' },
    ...['.', '..', 'a/b', 'a\\b'].map(unsafe => ({
      args: ['path', 'resolve', '--target', 'run-dir', '--project-root', root, '--run-id', unsafe],
      code: unsafe === '.' || unsafe === '..' || unsafe.includes('/') || unsafe.includes('\\')
        ? 'RUN_ID_INVALID' : 'RUN_DIR_ESCAPE',
    })),
  ];
  for (const item of invalidCases) {
    const result = invoke(item.args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`(?:^|\\s)${item.code}:`));
  }

  const source = readFileSync(CLI, 'utf8');
  const classifier = source.match(/function classifyKernelError\(e\) \{[\s\S]*?\n\}/)?.[0] || '';
  for (const code of [
    'PATH_TARGET_INVALID', 'WORKSTREAM_NOT_FOUND', 'RUN_DIR_ESCAPE',
    'WORKSTREAM_WORKTREE_ESCAPE', 'PROJECT_ROOT_UNRESOLVABLE',
  ]) assert.match(classifier, new RegExp(`\\b${code}\\b`), code);
  for (const code of ['PROJECT_ROOT_FENCED', 'RUNTIME_FENCED']) {
    assert.match(classifier, new RegExp(`\\b${code}\\b`), code);
  }
});

test('CLI returns project-root binding fence exit 3', () => {
  const source = seed();
  const candidateRoot = freshRoot('deep-loop-path-cli-foreign-');
  const candidateRunDir = runDir(candidateRoot, source.runId);
  mkdirSync(dirname(candidateRunDir), { recursive: true });
  cpSync(runDir(source.root, source.runId), candidateRunDir, { recursive: true });
  const result = invoke([
    'path', 'resolve', '--target', 'run-dir',
    '--project-root', candidateRoot, '--run-id', source.runId,
  ]);
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /(?:^|\s)PROJECT_ROOT_FENCED:/);
});
