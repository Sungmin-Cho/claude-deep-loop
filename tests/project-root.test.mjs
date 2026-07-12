import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
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
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXED_NOW = new Date('2026-07-11T00:00:00.000Z');
const recoveryReaderReferencePattern = /\breadStateForRootRecovery\b/;
const recoveryCommitReferencePattern = /\bcommitProjectRootRebindUnderLock\b/;
const portableRelative = (from, to) => relative(from, to).split(sep).join('/');
const genericRootBypassPattern = /\b(?:(?:skip|bypass|disable|ignore)(?:Project)?Root(?:Check|Binding)?|(?:skip|bypass|disable|ignore)[_-](?:project[_-])?root(?:[_-](?:check|binding))?)\b/i;
const recoveryApiPromise = import('../scripts/lib/project-root-recovery.mjs').catch(() => ({}));

function freshRoot(prefix = 'dl-root-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function init(root) {
  return initRun(root, { runtime: 'claude', goal: 'bind root', now: FIXED_NOW });
}

function copyDurableState(sourceRoot, candidateRoot) {
  cpSync(join(sourceRoot, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });
}

async function recoveryApi() {
  const api = await recoveryApiPromise;
  assert.equal(typeof api.diagnoseProjectRoot, 'function', 'diagnoseProjectRoot must be exported');
  assert.equal(typeof api.rebindProjectRoot, 'function', 'rebindProjectRoot must be exported');
  return api;
}

function movedRun(prefix = 'dl-root-relocated-') {
  const parent = freshRoot(prefix);
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  renameSync(originalRoot, candidateRoot);
  return { originalRoot, candidateRoot, runId, storedRoot };
}

function durableSnapshot(root, runId) {
  const dir = runDir(root, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json'), 'utf8'),
    hash: readFileSync(join(dir, '.loop.hash'), 'utf8'),
    event: existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null,
  };
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
  createDirectoryJunction(realRoot, aliasRoot);

  const { runId, loop } = init(aliasRoot);
  assert.equal(loop.project.root, canonicalProjectRoot(realRoot));
  assert.equal(readState(aliasRoot, runId).data.project.root, canonicalProjectRoot(realRoot));
});

test('pre-change symlink aliases remain readable when both roots resolve to one identity', () => {
  const parent = freshRoot('dl-root-legacy-link-');
  const realRoot = join(parent, 'real');
  const aliasRoot = join(parent, 'legacy-alias');
  mkdirSync(realRoot);
  createDirectoryJunction(realRoot, aliasRoot);

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

test('root diagnosis is hash-verified, read-only, path-redacted, and denies a resolvable copy', async () => {
  const originalRoot = freshRoot('dl-root-diagnose-original-');
  const candidateRoot = freshRoot('dl-root-diagnose-copy-');
  const { runId } = init(originalRoot);
  const storedRoot = readState(originalRoot, runId).data.project.root;
  copyDurableState(originalRoot, candidateRoot);
  const before = durableSnapshot(candidateRoot, runId);
  const { diagnoseProjectRoot } = await recoveryApi();

  const result = diagnoseProjectRoot(candidateRoot, runId);

  assert.deepEqual(result, {
    mismatch_class: 'fenced',
    rebind_allowed: false,
    stored_root_digest: projectRootDigest(storedRoot),
    owner: runId,
    generation: 1,
  });
  assert.equal(JSON.stringify(result).includes(originalRoot), false, 'diagnosis must not reveal the stored path');
  assert.equal(JSON.stringify(result).includes(candidateRoot), false, 'diagnosis must not reveal the candidate path');
  assert.deepEqual(durableSnapshot(candidateRoot, runId), before, 'diagnosis must not mutate state, hash, or event log');

  const loopPath = join(runDir(candidateRoot, runId), 'loop.json');
  const tampered = JSON.parse(readFileSync(loopPath, 'utf8'));
  tampered.goal = 'tampered-without-hash';
  writeFileSync(loopPath, JSON.stringify(tampered, null, 2));
  const tamperedBefore = durableSnapshot(candidateRoot, runId);
  assert.throws(() => diagnoseProjectRoot(candidateRoot, runId), /STATE_TAMPERED/);
  assert.deepEqual(durableSnapshot(candidateRoot, runId), tamperedBefore, 'failed diagnosis must remain read-only');
});

test('only an unresolvable stored root is diagnosed as rebindable', async () => {
  const { candidateRoot, runId, storedRoot } = movedRun();
  const { diagnoseProjectRoot } = await recoveryApi();

  assert.deepEqual(diagnoseProjectRoot(candidateRoot, runId), {
    mismatch_class: 'unresolvable',
    rebind_allowed: true,
    stored_root_digest: projectRootDigest(storedRoot),
    owner: runId,
    generation: 1,
  });
});

test('a stopped original still fences diagnosis and rebind while its stored root resolves', async () => {
  const originalRoot = freshRoot('dl-root-rebind-stopped-original-');
  const candidateRoot = freshRoot('dl-root-rebind-stopped-copy-');
  const { runId } = init(originalRoot);
  const { data } = readState(originalRoot, runId);
  data.status = 'stopped';
  writeState(originalRoot, runId, data);
  copyDurableState(originalRoot, candidateRoot);
  const storedRoot = data.project.root;
  const before = durableSnapshot(candidateRoot, runId);
  const { diagnoseProjectRoot, rebindProjectRoot } = await recoveryApi();

  assert.equal(diagnoseProjectRoot(candidateRoot, runId).rebind_allowed, false);
  assert.throws(
    () => rebindProjectRoot(candidateRoot, runId, {
      actor: 'human', confirm: true,
      expectedStoredRootDigest: projectRootDigest(storedRoot),
      fence: { owner: runId, generation: 1 }, now: FIXED_NOW.getTime(),
    }),
    /PROJECT_ROOT_FENCED/
  );
  assert.deepEqual(durableSnapshot(candidateRoot, runId), before);
});

test('rebind requires the exact human confirmation, stored-root digest, owner, and generation', async () => {
  const { rebindProjectRoot } = await recoveryApi();
  const variants = [
    ['actor', ({ runId, digest }) => ({ actor: 'agent', confirm: true, expectedStoredRootDigest: digest, fence: { owner: runId, generation: 1 } }), /INVALID_ACTOR/],
    ['confirm', ({ runId, digest }) => ({ actor: 'human', confirm: false, expectedStoredRootDigest: digest, fence: { owner: runId, generation: 1 } }), /CONFIRM_REQUIRED/],
    ['missing digest', ({ runId }) => ({ actor: 'human', confirm: true, fence: { owner: runId, generation: 1 } }), /INVALID_STORED_ROOT_DIGEST/],
    ['wrong digest', ({ runId }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: '0'.repeat(64), fence: { owner: runId, generation: 1 } }), /INVALID_STORED_ROOT_DIGEST/],
    ['non-canonical digest spelling', ({ runId }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: 'A'.repeat(64), fence: { owner: runId, generation: 1 } }), /INVALID_STORED_ROOT_DIGEST/],
    ['missing owner', ({ digest }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: digest, fence: { generation: 1 } }), /FENCE_REQUIRED/],
    ['missing generation', ({ runId, digest }) => ({ actor: 'human', confirm: true, expectedStoredRootDigest: digest, fence: { owner: runId } }), /FENCE_REQUIRED/],
  ];

  for (const [label, optionsFor, expectedError] of variants) {
    const moved = movedRun(`dl-root-guard-${label.replaceAll(' ', '-')}-`);
    const digest = projectRootDigest(moved.storedRoot);
    const before = durableSnapshot(moved.candidateRoot, moved.runId);
    assert.throws(
      () => rebindProjectRoot(moved.candidateRoot, moved.runId, {
        ...optionsFor({ ...moved, digest }), now: FIXED_NOW.getTime(),
      }),
      expectedError,
      label
    );
    assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), before, `${label} must not mutate durable state`);
  }
});

test('rebind rejects stale owner or generation without changing event, hash, or state', async () => {
  const { rebindProjectRoot } = await recoveryApi();
  for (const fence of [{ owner: 'stale-owner', generation: 1 }, { owner: null, generation: 9 }]) {
    const moved = movedRun('dl-root-stale-fence-');
    const before = durableSnapshot(moved.candidateRoot, moved.runId);
    const actualFence = { ...fence, owner: fence.owner ?? moved.runId };
    assert.throws(
      () => rebindProjectRoot(moved.candidateRoot, moved.runId, {
        actor: 'human', confirm: true,
        expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
        fence: actualFence, now: FIXED_NOW.getTime(),
      }),
      /LEASE_FENCED/
    );
    assert.deepEqual(durableSnapshot(moved.candidateRoot, moved.runId), before);
  }
});

test('successful relocation commits one fixed event, root, and anchor then restores strict access', async () => {
  const moved = movedRun('dl-root-rebind-success-');
  const before = durableSnapshot(moved.candidateRoot, moved.runId);
  const { rebindProjectRoot } = await recoveryApi();

  rebindProjectRoot(moved.candidateRoot, moved.runId, {
    actor: 'human', confirm: true,
    expectedStoredRootDigest: projectRootDigest(moved.storedRoot),
    fence: { owner: moved.runId, generation: 1 },
    now: FIXED_NOW.getTime(),
  });

  const { data } = readState(moved.candidateRoot, moved.runId);
  const lines = readFileSync(join(runDir(moved.candidateRoot, moved.runId), 'event-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'project-root-rebound');
  assert.equal(lines[0].ts, FIXED_NOW.toISOString());
  assert.deepEqual(lines[0].data, {
    old_root_digest: projectRootDigest(moved.storedRoot),
    new_root: canonicalProjectRoot(moved.candidateRoot),
  });
  assert.equal(data.project.root, canonicalProjectRoot(moved.candidateRoot));
  assert.deepEqual(data.event_log_head, { seq: lines[0].seq, checksum: lines[0].checksum });
  assert.notEqual(durableSnapshot(moved.candidateRoot, moved.runId).hash, before.hash);
});

test('rebind rejects a loop.run_id mismatch without durable mutation', async () => {
  const parent = freshRoot('dl-root-run-id-mismatch-');
  const originalRoot = join(parent, 'original');
  const candidateRoot = join(parent, 'candidate');
  mkdirSync(originalRoot);
  const { runId } = init(originalRoot);
  const { data } = readState(originalRoot, runId);
  data.run_id = 'DIFFERENT-RUN-ID';
  writeState(originalRoot, runId, data);
  const storedRoot = data.project.root;
  renameSync(originalRoot, candidateRoot);
  const before = durableSnapshot(candidateRoot, runId);
  const { rebindProjectRoot } = await recoveryApi();

  assert.throws(
    () => rebindProjectRoot(candidateRoot, runId, {
      actor: 'human', confirm: true,
      expectedStoredRootDigest: projectRootDigest(storedRoot),
      fence: { owner: runId, generation: 1 }, now: FIXED_NOW.getTime(),
    }),
    /STATE_INVALID/
  );
  assert.deepEqual(durableSnapshot(candidateRoot, runId), before);
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

test('source guard detects namespace, alias/reference, and dynamic recovery-commit access', () => {
  const hostileSources = [
    `import * as integrity from './integrity.mjs'; integrity.commitProjectRootRebindUnderLock(root, runId, loop, input);`,
    `const commit = integrity['commitProjectRootRebindUnderLock']; commit(root, runId, loop, input);`,
    `const { commitProjectRootRebindUnderLock: commit } = await import('./integrity.mjs');`,
  ];
  for (const source of hostileSources) {
    assert.equal(recoveryCommitReferencePattern.test(source), true, `must detect: ${source}`);
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
    const rel = portableRelative(REPO_ROOT, path);
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

test('only integrity and the dedicated recovery module may reference the fixed rebind commit', () => {
  const violations = [];
  let integrityDefinitions = 0;
  let recoveryReferences = 0;
  for (const path of sourceFiles(join(REPO_ROOT, 'scripts'))) {
    const rel = portableRelative(REPO_ROOT, path);
    const source = readFileSync(path, 'utf8');
    const references = source.match(/\bcommitProjectRootRebindUnderLock\b/g) || [];
    if (rel === 'scripts/lib/integrity.mjs') {
      const definitions = source.match(/\bexport\s+function\s+commitProjectRootRebindUnderLock\s*\(/g) || [];
      integrityDefinitions += definitions.length;
      if (references.length !== 1 || definitions.length !== 1) {
        violations.push(`${rel}: expected exactly one export definition, found ${references.length} references/${definitions.length} definitions`);
      }
    } else if (rel === 'scripts/lib/project-root-recovery.mjs') {
      recoveryReferences += references.length;
    } else if (references.length > 0) {
      violations.push(`${rel}: ${references.length} forbidden recovery-commit reference(s)`);
    }
  }
  if (integrityDefinitions !== 1) violations.push(`integrity helper definitions: expected 1, found ${integrityDefinitions}`);
  if (recoveryReferences < 2) violations.push(`recovery helper references: expected import + call, found ${recoveryReferences}`);
  assert.deepEqual(violations, []);
});

test('scripts contain no generic project-root binding bypass tokens', () => {
  const violations = sourceFiles(join(REPO_ROOT, 'scripts'))
    .map(path => ({ path: relative(REPO_ROOT, path), source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => genericRootBypassPattern.test(source))
    .map(({ path }) => path);
  assert.deepEqual(violations, []);
});
