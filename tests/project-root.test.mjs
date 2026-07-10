import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initRun } from '../scripts/lib/initrun.mjs';
import {
  readState,
  readStateForRootRecovery,
  runDir,
  writeState,
} from '../scripts/lib/state.mjs';
import {
  assertProjectRootBinding,
  canonicalProjectRoot,
  classifyProjectRootBinding,
  projectRootDigest,
} from '../scripts/lib/project-root.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXED_NOW = new Date('2026-07-11T00:00:00.000Z');
const recoveryReaderReferencePattern = /\breadStateForRootRecovery\b/;
const genericRootBypassPattern = /\b(?:(?:skip|bypass|disable|ignore)(?:Project)?Root(?:Check|Binding)?|(?:skip|bypass|disable|ignore)[_-](?:project[_-])?root(?:[_-](?:check|binding))?)\b/i;

function freshRoot(prefix = 'dl-root-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function init(root) {
  return initRun(root, { runtime: 'claude', goal: 'bind root', now: FIXED_NOW });
}

function copyDurableState(sourceRoot, candidateRoot) {
  cpSync(join(sourceRoot, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.mjs')) out.push(path);
  }
  return out;
}

test('init through a symlink stores the canonical project root', () => {
  const parent = freshRoot('dl-root-link-');
  const realRoot = join(parent, 'real');
  const aliasRoot = join(parent, 'alias');
  mkdirSync(realRoot);
  symlinkSync(realRoot, aliasRoot, 'dir');

  const { runId, loop } = init(aliasRoot);
  assert.equal(loop.project.root, canonicalProjectRoot(realRoot));
  assert.equal(readState(aliasRoot, runId).data.project.root, canonicalProjectRoot(realRoot));
});

test('pre-change symlink aliases remain readable when both roots resolve to one identity', () => {
  const parent = freshRoot('dl-root-legacy-link-');
  const realRoot = join(parent, 'real');
  const aliasRoot = join(parent, 'legacy-alias');
  mkdirSync(realRoot);
  symlinkSync(realRoot, aliasRoot, 'dir');

  const { runId } = init(realRoot);
  const { data } = readState(realRoot, runId);
  data.project.root = aliasRoot; // simulate a pre-canonicalization loop.json
  writeState(realRoot, runId, data);

  assert.equal(readState(realRoot, runId).data.project.root, aliasRoot);
  assert.equal(readState(aliasRoot, runId).data.project.root, aliasRoot);
});

test('a copied run is fenced while the original stored root resolves', () => {
  const originalRoot = freshRoot('dl-root-original-');
  const candidateRoot = freshRoot('dl-root-copy-');
  const { runId } = init(originalRoot);
  copyDurableState(originalRoot, candidateRoot);

  assert.throws(() => readState(candidateRoot, runId), /PROJECT_ROOT_FENCED/);
  assert.equal(readStateForRootRecovery(candidateRoot, runId).data.project.root, canonicalProjectRoot(originalRoot));
});

test('stopping the original run never authorizes a copied candidate root', () => {
  const originalRoot = freshRoot('dl-root-stopped-original-');
  const candidateRoot = freshRoot('dl-root-stopped-copy-');
  const { runId } = init(originalRoot);
  const { data } = readState(originalRoot, runId);
  data.status = 'stopped';
  writeState(originalRoot, runId, data);
  copyDurableState(originalRoot, candidateRoot);

  assert.throws(() => readState(candidateRoot, runId), /PROJECT_ROOT_FENCED/);
  assert.equal(readStateForRootRecovery(candidateRoot, runId).data.status, 'stopped');
});

test('a moved run with an unresolvable stored root requires recovery', () => {
  const parent = freshRoot('dl-root-moved-parent-');
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'moved');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  renameSync(originalRoot, candidateRoot);

  assert.throws(() => readState(candidateRoot, runId), /PROJECT_ROOT_UNRESOLVABLE/);
  assert.equal(readStateForRootRecovery(candidateRoot, runId).data.project.root, storedRoot);
});

test('recovery-only state reads still verify the loop hash', () => {
  const originalRoot = freshRoot('dl-root-recovery-hash-original-');
  const candidateRoot = freshRoot('dl-root-recovery-hash-copy-');
  const { runId } = init(originalRoot);
  copyDurableState(originalRoot, candidateRoot);
  const loopPath = join(runDir(candidateRoot, runId), 'loop.json');
  const raw = JSON.parse(readFileSync(loopPath, 'utf8'));
  raw.goal = 'tampered-without-hash';
  // This direct fixture write intentionally leaves .loop.hash unchanged.
  writeFileSync(loopPath, JSON.stringify(raw, null, 2));

  assert.throws(() => readStateForRootRecovery(candidateRoot, runId), /STATE_TAMPERED/);
});

test('injected Windows case, drive-root, and UNC aliases compare by canonical identity', () => {
  const canonicalByInput = new Map([
    ['C:\\Repo', 'C:\\Repo'],
    ['c:\\repo', 'C:\\Repo'],
    ['C:\\', 'C:\\'],
    ['c:\\', 'C:\\'],
    ['\\\\Server\\Share\\Repo', '\\\\Server\\Share\\Repo'],
    ['\\\\server\\share\\repo', '\\\\Server\\Share\\Repo'],
    ['D:\\Repo', 'D:\\Repo'],
  ]);
  const deps = {
    realpathSync(value) {
      if (!canonicalByInput.has(value)) throw new Error(`ENOENT: ${value}`);
      return canonicalByInput.get(value);
    },
  };

  for (const [candidate, stored] of [
    ['c:\\repo', 'C:\\Repo'],
    ['c:\\', 'C:\\'],
    ['\\\\server\\share\\repo', '\\\\Server\\Share\\Repo'],
  ]) {
    const result = classifyProjectRootBinding(candidate, stored, deps);
    assert.equal(result.ok, true, `${candidate} and ${stored} should be one canonical identity`);
    assert.equal(result.mismatch_class, 'match');
  }

  assert.equal(classifyProjectRootBinding('D:\\Repo', 'C:\\Repo', deps).mismatch_class, 'fenced');
  assert.throws(
    () => assertProjectRootBinding('D:\\Repo', { project: { root: 'C:\\Repo' } }, deps),
    /PROJECT_ROOT_FENCED/
  );
});

test('projectRootDigest is the stable sha256 digest of the stored lexical root', () => {
  const storedRoot = 'C:\\Repo\\Legacy-Case';
  const expected = createHash('sha256').update(storedRoot).digest('hex');
  assert.equal(projectRootDigest(storedRoot), expected);
  assert.notEqual(projectRootDigest(storedRoot), projectRootDigest(storedRoot.toLowerCase()));
});

test('source guard detects namespace, alias/reference, and dynamic recovery-reader access', () => {
  const hostileSources = [
    `import * as state from './state.mjs'; state.readStateForRootRecovery(root, runId);`,
    `const recover = state['readStateForRootRecovery']; recover(root, runId);`,
    `const { readStateForRootRecovery: recover } = await import('./state.mjs');`,
  ];
  for (const source of hostileSources) {
    assert.equal(recoveryReaderReferencePattern.test(source), true, `must detect: ${source}`);
  }
});

test('source guard detects generic root-check bypass spellings', () => {
  const hostileSources = [
    'const skipRootCheck = true;',
    'const bypassProjectRootBinding = true;',
    'const disable_root_check = true;',
    `const option = 'ignore-project-root-check';`,
  ];
  for (const source of hostileSources) {
    assert.equal(genericRootBypassPattern.test(source), true, `must detect: ${source}`);
  }
});

test('only the state export and dedicated recovery module may reference readStateForRootRecovery', () => {
  const violations = [];
  for (const path of sourceFiles(join(REPO_ROOT, 'scripts'))) {
    const rel = relative(REPO_ROOT, path);
    const source = readFileSync(path, 'utf8');
    const references = source.match(/\breadStateForRootRecovery\b/g) || [];
    if (rel === 'scripts/lib/state.mjs') {
      const definitions = source.match(/\bexport\s+function\s+readStateForRootRecovery\s*\(/g) || [];
      if (references.length !== 1 || definitions.length !== 1) {
        violations.push(`${rel}: expected exactly one export definition, found ${references.length} references/${definitions.length} definitions`);
      }
    } else if (rel !== 'scripts/lib/project-root-recovery.mjs' && references.length > 0) {
      violations.push(`${rel}: ${references.length} forbidden recovery-reader reference(s)`);
    }
  }
  assert.deepEqual(violations, []);
});

test('scripts contain no generic project-root binding bypass tokens', () => {
  const violations = sourceFiles(join(REPO_ROOT, 'scripts'))
    .map(path => ({ path: relative(REPO_ROOT, path), source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => genericRootBypassPattern.test(source))
    .map(({ path }) => path);
  assert.deepEqual(violations, []);
});
