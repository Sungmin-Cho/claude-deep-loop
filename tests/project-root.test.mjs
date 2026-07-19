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
  terminal7b(originalRoot, runId, { status: 'stopped' });
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
  terminal7b(originalRoot, runId, { status: 'stopped' });
  const { data } = readState(originalRoot, runId);
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

test('initialized run relocation appends rebound at sequence two and restores strict access', async () => {
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
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'run-initialized');
  assert.equal(lines[0].seq, 1);
  assert.equal(lines[1].type, 'project-root-rebound');
  assert.equal(lines[1].seq, 2);
  assert.equal(lines[1].ts, FIXED_NOW.toISOString());
  assert.deepEqual(lines[1].data, {
    old_root_digest: projectRootDigest(moved.storedRoot),
    new_root: canonicalProjectRoot(moved.candidateRoot),
  });
  assert.equal(data.project.root, canonicalProjectRoot(moved.candidateRoot));
  assert.deepEqual(data.event_log_head, { seq: lines[1].seq, checksum: lines[1].checksum });
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
  const invalidRaw = JSON.stringify(data, null, 2);
  writeFileSync(join(runDir(originalRoot, runId), 'loop.json'), invalidRaw);
  writeFileSync(join(runDir(originalRoot, runId), '.loop.hash'),
    createHash('sha256').update(invalidRaw).digest('hex'));
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
import { renameSync as rename7c } from 'node:fs';
import { rebindProjectRoot as rebind7c } from '../scripts/lib/project-root-recovery.mjs';
import { projectRootDigest as rootDigest7c } from '../scripts/lib/project-root.mjs';
import { durableRunBytes as bytes7c, rawHashValidState as raw7c,
  seedCorrelatedTerminal as terminal7b,
  verifiedAppRun as fixture7c } from './fixtures/verified-app-run.mjs';

test('root rebind proves App correlation before its sole direct append', () => {
  const fixture = fixture7c('dl-root-rebind-proof-');
  const moved = `${fixture.root}-moved`;
  rename7c(fixture.root, moved);
  raw7c(moved, fixture.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:01.000Z';
  }, { recovery: true });
  const before = bytes7c(moved, fixture.runId);
  assert.throws(() => rebind7c(moved, fixture.runId, { actor: 'human', confirm: true,
    expectedStoredRootDigest: rootDigest7c(fixture.root),
    fence: { owner: fixture.owner, generation: fixture.generation },
    now: Date.parse('2026-07-13T00:00:01.000Z') }), /RUN_SNAPSHOT_INVALID/);
  assert.deepEqual(bytes7c(moved, fixture.runId), before);
});

import { test as testRecovery7e } from 'node:test';
import assertRecovery7e from 'node:assert/strict';
import { renameSync as renameRecovery7e } from 'node:fs';
import { diagnoseProjectRoot as diagnoseRecovery7e }
  from '../scripts/lib/project-root-recovery.mjs';
import { projectRootDigest as projectRootDigest7e } from '../scripts/lib/project-root.mjs';
import { durableRunBytes as recoveryBytes7e,
  rawHashValidState as rawRecovery7e,
  verifiedAppRun as recoveryFixture7e } from './fixtures/verified-app-run.mjs';

testRecovery7e('diagnosis verifies cross-log semantics without requiring the stale stored root', () => {
  const fixture = recoveryFixture7e('dl-root-diagnosis-proof-');
  const movedRoot = `${fixture.root}-moved`;
  renameRecovery7e(fixture.root, movedRoot);
  const validBefore = recoveryBytes7e(movedRoot, fixture.runId);

  const diagnosis = diagnoseRecovery7e(movedRoot, fixture.runId);
  assertRecovery7e.deepEqual(diagnosis, {
    mismatch_class: 'unresolvable', rebind_allowed: true,
    stored_root_digest: projectRootDigest7e(fixture.root),
    owner: fixture.owner, generation: fixture.generation,
  });
  assertRecovery7e.equal(JSON.stringify(diagnosis).includes(fixture.root), false);
  assertRecovery7e.equal(JSON.stringify(diagnosis).includes(movedRoot), false);
  assertRecovery7e.deepEqual(recoveryBytes7e(movedRoot, fixture.runId), validBefore,
    'valid diagnosis is read-only');

  rawRecovery7e(movedRoot, fixture.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:01.000Z';
  }, { recovery: true });
  const corruptBefore = recoveryBytes7e(movedRoot, fixture.runId);
  let failureMessage = '';
  assertRecovery7e.throws(() => diagnoseRecovery7e(movedRoot, fixture.runId), error => {
    failureMessage = String(error?.message || error);
    return /RUN_SNAPSHOT_INVALID/.test(failureMessage);
  });
  assertRecovery7e.equal(failureMessage.includes(fixture.root), false,
    'failure must not disclose the stale root');
  assertRecovery7e.equal(failureMessage.includes(movedRoot), false,
    'failure must not disclose the candidate root');
  assertRecovery7e.deepEqual(recoveryBytes7e(movedRoot, fixture.runId), corruptBefore,
    'failed diagnosis is read-only');
});
test('verified under-lock commit has a closed production reference set', () => {
  const production = sourceFiles(join(REPO_ROOT, 'scripts'));
  for (const file of production) {
    const rel = portableRelative(REPO_ROOT, file);
    const count = (readFileSync(file, 'utf8')
      .match(/\bcommitVerifiedEventsUnderLock\b/g) || []).length;
    if (rel === 'scripts/lib/integrity.mjs') assert.equal(count, 3,
      'one definition plus appendAnchored and root-rebind calls');
    else if (rel === 'scripts/lib/lease.mjs') assert.equal(count, 2,
      'one import plus the generic-acquire generation commit');
    else if (rel === 'scripts/lib/budget.mjs') assert.equal(count, 2,
      'one import plus the single measured-accounting adapter call');
    else assert.equal(count, 0, `${rel}: unapproved verified under-lock commit reference`);
  }
});

import test7g from 'node:test';
import assert7g from 'node:assert/strict';
import { spawnSync as spawn7g } from 'node:child_process';
import { readFileSync as read7g, readdirSync as list7g, rmdirSync as rmdir7g,
  statSync as stat7g }
  from 'node:fs';
import { join as join7g, relative as relative7g } from 'node:path';
import { fileURLToPath as file7g } from 'node:url';
import { releaseLease as release7g, reserveHandoff as reserve7g,
  advanceHandoffPhase as advance7g, rollbackHandoff as rollback7g }
  from '../scripts/lib/lease.mjs';
import { tripBreaker as trip7g, resetBreaker as reset7g,
  recordReviewVerdict as rawVerdict7g } from '../scripts/lib/breaker.mjs';
import { appendAnchored as append7g, directMutationOptions as mutation7g,
  readLines as lines7g }
  from '../scripts/lib/integrity.mjs';
import { durableRunBytes as bytes7g, rawHashValidState as raw7g,
  seedCorrelatedTerminal as terminal7g,
  verifiedAppRun as fixture7g }
  from './fixtures/verified-app-run.mjs';
import { newEpisode as newEpisode7g } from './helpers/episode-request.mjs';
import { newWorkstream as newWorkstream7g } from './helpers/workstream-request.mjs';

const ROOT7G = file7g(new URL('..', import.meta.url));
const verdict7g = (root, runId, verdict, fence, options) =>
  rawVerdict7g(root, runId, verdict,
    { ...fence, runtime: fence.runtime ?? 'codex' }, options);
function sourceFiles7g(directory) {
  return list7g(directory).flatMap(name => {
    const path = join7g(directory, name);
    return stat7g(path).isDirectory() ? sourceFiles7g(path)
      : /\.mjs$/.test(path) ? [path] : [];
  });
}

test7g('post-genesis raw publisher closure', () => {
  const files = [
    ...sourceFiles7g(join7g(ROOT7G, 'scripts', 'lib')),
    ...sourceFiles7g(join7g(ROOT7G, 'scripts', 'hooks-impl')),
    join7g(ROOT7G, 'scripts', 'deep-loop.mjs'),
  ];
  const verdictCallers = [];
  for (const path of files) {
    const rel = relative7g(ROOT7G, path).replaceAll('\\', '/');
    const source = read7g(path, 'utf8');
    const imports = [...source.matchAll(/import[^;]*\bwriteState\b[^;]*;/g)];
    const calls = [...source.matchAll(/\bwriteState\s*\(/g)];
    if (rel === 'scripts/lib/state.mjs') {
      assert7g.equal(imports.length, 0);
      assert7g.equal(calls.length, 1, 'the fixture/genesis seam definition only');
    } else {
      assert7g.equal(imports.length, 0, `${rel}: raw writer import`);
      assert7g.equal(calls.length, 0, `${rel}: raw writer call`);
    }
    if (rel !== 'scripts/lib/breaker.mjs'
        && /\brecordReviewVerdict\s*\(/.test(source)) verdictCallers.push(rel);
  }
  assert7g.deepEqual(verdictCallers, [],
    'production review-verdict caller must not bypass the explicit breaker API contract');
});

function publisherCases7g() {
  const now = Date.parse('2026-07-13T00:00:10.000Z');
  const fresh = prefix => {
    const fixture = fixture7g(prefix);
    return { ...fixture, fence: { owner: fixture.owner, generation: fixture.generation } };
  };
  return [
    { event: 'lease-released', keys: ['generation', 'owner_run_id'], setup: () => {
      const f = fresh('dl-7g-release-');
      return { f, run: () => release7g(f.root, f.runId, f.fence),
        noOp: () => release7g(f.root, f.runId, f.fence) };
    } },
    { event: 'handoff-reserved',
      keys: ['child_run_id', 'generation', 'key_digest', 'owner_run_id'], setup: () => {
        const f = fresh('dl-7g-reserve-');
        const input = { trigger: '7g', now, expect: f.fence };
        return { f, run: () => reserve7g(f.root, f.runId, input),
          noOp: () => reserve7g(f.root, f.runId, input) };
      } },
    { event: 'handoff-phase-advanced',
      keys: ['from_phase', 'generation', 'key_digest', 'owner_run_id', 'to_phase'], setup: () => {
        const f = fresh('dl-7g-advance-');
        const reserved = reserve7g(f.root, f.runId, { trigger: '7g', now, expect: f.fence });
        const input = { key: reserved.key, toPhase: 'emitted', now: now + 1, expect: f.fence };
        return { f, run: () => advance7g(f.root, f.runId, input),
          noOp: () => advance7g(f.root, f.runId, input) };
      } },
    { event: 'handoff-rolled-back',
      keys: ['generation', 'owner_run_id', 'terminal'], setup: () => {
        const f = fresh('dl-7g-rollback-');
        reserve7g(f.root, f.runId, { trigger: '7g', now, expect: f.fence });
        return { f, run: () => rollback7g(f.root, f.runId, f.fence),
          noOp: () => rollback7g(f.root, f.runId, f.fence) };
      } },
    { event: 'breaker-tripped', keys: ['changed', 'generation', 'owner_run_id',
      'reason', 'request_digest', 'request_id_digest'], setup: () => {
      const f = fresh('dl-7g-trip-');
      const input = { fence: f.fence, requestId: 'publisher-trip' };
      return { f, run: () => trip7g(f.root, f.runId, 'test', input),
        noOp: () => trip7g(f.root, f.runId, 'test', input) };
    } },
    { event: 'breaker-reset',
      keys: ['changed', 'generation', 'next_count', 'next_status', 'operation',
        'owner_run_id', 'previous_count', 'request_digest', 'request_id_digest',
        'was_breaker'], setup: () => {
        const f = fresh('dl-7g-reset-');
        trip7g(f.root, f.runId, 'consecutive-request-changes',
          { fence: f.fence, requestId: 'publisher-reset-setup-trip' });
        const input = { fence: { ...f.fence, intent: 'breaker-reset' },
          requestId: 'publisher-reset' };
        return { f, run: () => reset7g(f.root, f.runId, input),
          noOp: () => reset7g(f.root, f.runId, input) };
    } },
    { event: 'breaker-review-verdict',
      keys: ['baseline_count', 'breaker_tripped', 'changed', 'generation', 'next_count',
        'owner_run_id', 'previous_count', 'request_digest', 'request_id_digest',
        'verdict'], setup: () => {
        const f = fresh('dl-7g-verdict-');
        const input = { requestId: 'publisher-request-changes' };
        return { f,
          run: () => verdict7g(f.root, f.runId, 'REQUEST_CHANGES', f.fence, input),
          noOp: () => verdict7g(f.root, f.runId, 'REQUEST_CHANGES', f.fence, input) };
      } },
  ];
}

function journalBytes7g(root, runId) {
  const directory = join7g(root, '.deep-loop', 'runs', runId);
  return Object.fromEntries(list7g(directory).sort()
    .filter(name => name.startsWith('.anchored-') || name === 'loop.json'
      || name === '.loop.hash' || name === 'event-log.jsonl')
    .map(name => [name, read7g(join7g(directory, name))]));
}

function retryPublisher7g(operation, fixture, foreign = false) {
  const owner = foreign ? '01JAPPF0R00000000000000000' : fixture.owner;
  const fence = { owner, generation: fixture.generation };
  if (operation === 'lease-release') {
    return release7g(fixture.root, fixture.runId, fence);
  }
  if (operation === 'handoff-reserve') {
    return reserve7g(fixture.root, fixture.runId,
      { trigger: 'crash-7g', now: Date.parse('2026-07-13T00:00:10.000Z'), expect: fence });
  }
  if (operation === 'breaker-trip') {
    return trip7g(fixture.root, fixture.runId, 'crash-7g',
      { fence, requestId: 'crash-7g-trip' });
  }
  if (operation === 'breaker-verdict') {
    return verdict7g(fixture.root, fixture.runId, 'REQUEST_CHANGES', fence,
      { requestId: 'crash-7g-verdict' });
  }
  throw new Error(`TEST_OPERATION_UNKNOWN: ${operation}`);
}

function assertRemainingPublisherCrash7g({ operation, point }) {
  const fixture = fixture7g(`dl-7g-${operation}-${point}-`);
  const worker = file7g(new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
  const child = spawn7g(process.execPath,
    [worker, fixture.root, fixture.runId, operation, point], {
      encoding: 'utf8', shell: false,
      env: { ...process.env, DEEP_LOOP_CRASH_OWNER: fixture.owner,
        DEEP_LOOP_CRASH_GENERATION: String(fixture.generation) },
    });
  assert7g.equal(child.status, 91, child.stderr || child.stdout);
  rmdir7g(join7g(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  const pending = journalBytes7g(fixture.root, fixture.runId);
  let foreign;
  try { foreign = retryPublisher7g(operation, fixture, true); }
  catch (error) { assert7g.match(String(error?.message || error), /FENCED|pending/i); }
  if (foreign !== undefined) assert7g.equal(foreign.ok, false);
  assert7g.deepEqual(journalBytes7g(fixture.root, fixture.runId), pending,
    'foreign retry must not recover or change a byte');
  retryPublisher7g(operation, fixture, false);
  assert7g.equal(lines7g(fixture.root, fixture.runId)
    .filter(event => ({ 'lease-release': 'lease-released',
      'handoff-reserve': 'handoff-reserved', 'breaker-trip': 'breaker-tripped',
      'breaker-verdict': 'breaker-review-verdict' }[operation] === event.type)).length, 1);
  assert7g.equal(Object.keys(journalBytes7g(fixture.root, fixture.runId))
    .some(name => name.startsWith('.anchored-')
      && name !== '.anchored-committed.json'), false);
}

test7g('lease mutation events and breaker mutation events are exact and no-op stable', () => {
  for (const spec of publisherCases7g()) {
    const { f, run, noOp } = spec.setup();
    run();
    const event = lines7g(f.root, f.runId).filter(item => item.type === spec.event).at(-1);
    assert7g.ok(event, spec.event);
    assert7g.deepEqual(Object.keys(event.data).sort(), [...spec.keys].sort());
    const before = bytes7g(f.root, f.runId);
    noOp();
    assert7g.deepEqual(bytes7g(f.root, f.runId), before, `${spec.event} no-op wrote`);
  }
});

test7g('terminal release is allowed only when no live App binding remains', () => {
  const clean = fixture7g('dl-7g-terminal-release-');
  terminal7g(clean.root, clean.runId, { status: 'stopped' });
  assert7g.deepEqual(release7g(clean.root, clean.runId,
    { owner: clean.owner, generation: clean.generation }),
  { ok: true, reason: 'released' });
  assert7g.equal(lines7g(clean.root, clean.runId)
    .filter(event => event.type === 'lease-released').length, 1);

  const live = fixture7g('dl-7g-terminal-live-app-release-');
  terminal7g(live.root, live.runId, { status: 'stopped' });
  const before = bytes7g(live.root, live.runId);
  raw7g(live.root, live.runId, loop => {
    loop.session_chain.lease.handoff_transport = 'codex-app';
    loop.session_chain.lease.handoff_attempt_id = '01JAPPTASK0000000000000000';
  });
  const marked = bytes7g(live.root, live.runId);
  assert7g.throws(() => release7g(live.root, live.runId,
    { owner: live.owner, generation: live.generation }), /RUN_SNAPSHOT_INVALID/);
  assert7g.deepEqual(bytes7g(live.root, live.runId), marked);
  assert7g.notDeepEqual(marked, before);
});

test7g('remaining publisher crash recovery uses real public APIs', () => {
  for (const operation of ['lease-release', 'handoff-reserve', 'breaker-trip', 'breaker-verdict']) {
    for (const point of ['pending-after-rename', 'event-after-partial-append',
      'state-after-rename', 'hash-after-rename', 'before-cleanup']) {
      assertRemainingPublisherCrash7g({ operation, point });
    }
  }
});

test7g('review verdict request identity survives journal cleanup and rejects reuse', () => {
  const fixture = fixture7g('dl-7g-verdict-response-loss-');
  const fence = { owner: fixture.owner, generation: fixture.generation };
  const input = { requestId: 'response-loss-verdict-1' };
  assert7g.deepEqual(verdict7g(fixture.root, fixture.runId,
    'REQUEST_CHANGES', fence, input), { ok: true, changed: true });
  const committed = bytes7g(fixture.root, fixture.runId);
  assert7g.deepEqual(verdict7g(fixture.root, fixture.runId,
    'REQUEST_CHANGES', fence, input), { ok: true, changed: true });
  assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), committed,
    'post-cleanup retry must not append or increment again');
  assert7g.throws(() => verdict7g(fixture.root, fixture.runId,
    'APPROVE', fence, input), /BREAKER_REQUEST_CONFLICT/);
  assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), committed);
});

test7g('review verdict enforces released releasing and paused lease policy before replay', () => {
  for (const state of ['released', 'releasing', 'paused']) {
    const fixture = fixture7g(`dl-7g-verdict-${state}-`);
    const fence = { owner: fixture.owner, generation: fixture.generation };
    raw7g(fixture.root, fixture.runId, loop => {
      if (state === 'paused') loop.status = 'paused';
      else loop.session_chain.lease.state = state;
    });
    const before = bytes7g(fixture.root, fixture.runId);
    assert7g.throws(() => verdict7g(fixture.root, fixture.runId,
      'REQUEST_CHANGES', fence, { requestId: `verdict-${state}` }), /LEASE_FENCED/);
    assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), before, state);
  }
});

test7g('review verdict requires and enforces runtime before fresh or replay semantics', () => {
  const replay = fixture7g('dl-7g-verdict-runtime-replay-');
  const correct = { owner: replay.owner, generation: replay.generation, runtime: 'codex' };
  const input = { requestId: 'runtime-replay-verdict' };
  assert7g.deepEqual(verdict7g(replay.root, replay.runId,
    'REQUEST_CHANGES', correct, input), { ok: true, changed: true });
  const committed = bytes7g(replay.root, replay.runId);
  assert7g.throws(() => rawVerdict7g(replay.root, replay.runId,
    'REQUEST_CHANGES', { ...correct, runtime: 'claude' }, input),
  /LEASE_FENCED: RUNTIME_FENCED/);
  assert7g.deepEqual(bytes7g(replay.root, replay.runId), committed);

  const fresh = fixture7g('dl-7g-verdict-runtime-fresh-');
  const before = bytes7g(fresh.root, fresh.runId);
  assert7g.throws(() => rawVerdict7g(fresh.root, fresh.runId,
    'REQUEST_CHANGES', { owner: fresh.owner, generation: fresh.generation,
      runtime: 'claude' }, { requestId: 'runtime-fresh-verdict' }),
  /LEASE_FENCED: RUNTIME_FENCED/);
  assert7g.deepEqual(bytes7g(fresh.root, fresh.runId), before);
});

test7g('pending review verdict rejects wrong runtime before recovery changes any byte', () => {
  const worker = file7g(new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
  for (const point of ['pending-after-rename', 'state-after-rename']) {
    const fixture = fixture7g(`dl-7g-verdict-preauth-${point}-`);
    const child = spawn7g(process.execPath,
      [worker, fixture.root, fixture.runId, 'breaker-verdict', point], {
        encoding: 'utf8', shell: false,
        env: { ...process.env, DEEP_LOOP_CRASH_OWNER: fixture.owner,
          DEEP_LOOP_CRASH_GENERATION: String(fixture.generation) },
      });
    assert7g.equal(child.status, 91, child.stderr || child.stdout);
    rmdir7g(join7g(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
    const pending = bytes7g(fixture.root, fixture.runId);
    assert7g.throws(() => rawVerdict7g(fixture.root, fixture.runId,
      'REQUEST_CHANGES', { owner: fixture.owner, generation: fixture.generation,
        runtime: 'claude' }, { requestId: 'crash-7g-verdict' }),
    /LEASE_FENCED: RUNTIME_FENCED/);
    assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), pending,
      `${point}: wrong runtime must not recover pending journal bytes`);
    assert7g.deepEqual(rawVerdict7g(fixture.root, fixture.runId,
      'REQUEST_CHANGES', { owner: fixture.owner, generation: fixture.generation,
        runtime: 'codex' }, { requestId: 'crash-7g-verdict' }),
    { ok: true, changed: true });
  }
});

test7g('threshold-crossing pending verdict retry converges once with original response', () => {
  const breakerSource = read7g(join7g(ROOT7G, 'scripts', 'lib', 'breaker.mjs'), 'utf8');
  assert7g.match(breakerSource, /context\.recoverySource === 'pending'/);
  assert7g.doesNotMatch(breakerSource, /authentication\.pending/);
  const worker = file7g(new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
  for (const point of ['pending-after-rename', 'state-after-rename']) {
    const fixture = fixture7g(`dl-7g-threshold-recovery-${point}-`);
    raw7g(fixture.root, fixture.runId, loop => {
      loop.circuit_breaker.consecutive_request_changes = 2;
    });
    const child = spawn7g(process.execPath,
      [worker, fixture.root, fixture.runId, 'breaker-verdict', point], {
        encoding: 'utf8', shell: false,
        env: { ...process.env, DEEP_LOOP_CRASH_OWNER: fixture.owner,
          DEEP_LOOP_CRASH_GENERATION: String(fixture.generation) },
      });
    assert7g.equal(child.status, 91, child.stderr || child.stdout);
    rmdir7g(join7g(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
    assert7g.deepEqual(rawVerdict7g(fixture.root, fixture.runId,
      'REQUEST_CHANGES', { owner: fixture.owner, generation: fixture.generation,
        runtime: 'codex' }, { requestId: 'crash-7g-verdict' }),
    { ok: true, changed: true });
    const state = readState(fixture.root, fixture.runId).data;
    assert7g.equal(state.circuit_breaker.consecutive_request_changes, 3);
    assert7g.equal(state.status, 'paused');
    assert7g.equal(lines7g(fixture.root, fixture.runId)
      .filter(event => event.type === 'breaker-review-verdict').length, 1);
  }
});

test7g('committed verdict receipt replay enforces current full lease policy first', () => {
  for (const policy of ['paused', 'released']) {
    const fixture = fixture7g(`dl-7g-receipt-policy-${policy}-`);
    const fence = { owner: fixture.owner, generation: fixture.generation, runtime: 'codex' };
    const input = { requestId: `receipt-policy-${policy}` };
    assert7g.deepEqual(rawVerdict7g(fixture.root, fixture.runId,
      'REQUEST_CHANGES', fence, input), { ok: true, changed: true });
    raw7g(fixture.root, fixture.runId, loop => {
      if (policy === 'paused') loop.status = 'paused';
      else loop.session_chain.lease.state = 'released';
    });
    const before = bytes7g(fixture.root, fixture.runId);
    assert7g.throws(() => rawVerdict7g(fixture.root, fixture.runId,
      'REQUEST_CHANGES', fence, input), /LEASE_FENCED/);
    assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), before);
  }
});

test7g('zero-count APPROVE receipt cannot reset a newer verdict after response loss', () => {
  const fixture = fixture7g('dl-7g-approve-noop-response-loss-');
  const fence = { owner: fixture.owner, generation: fixture.generation };
  const approve = { requestId: 'approve-noop-before-newer-verdict' };
  assert7g.deepEqual(verdict7g(fixture.root, fixture.runId,
    'APPROVE', fence, approve), { ok: true, changed: false });
  const receipt = lines7g(fixture.root, fixture.runId).at(-1);
  assert7g.equal(receipt.type, 'breaker-review-verdict');
  assert7g.deepEqual({ verdict: receipt.data.verdict, changed: receipt.data.changed,
    previous: receipt.data.previous_count, next: receipt.data.next_count },
  { verdict: 'APPROVE', changed: false, previous: 0, next: 0 });

  assert7g.deepEqual(verdict7g(fixture.root, fixture.runId,
    'REQUEST_CHANGES', fence, { requestId: 'newer-request-changes' }),
  { ok: true, changed: true });
  const afterNewerVerdict = bytes7g(fixture.root, fixture.runId);
  assert7g.deepEqual(verdict7g(fixture.root, fixture.runId,
    'APPROVE', fence, approve), { ok: true, changed: false });
  assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), afterNewerVerdict,
    'retry must recover the old no-op receipt without resetting newer state');
  assert7g.equal(readState(fixture.root, fixture.runId)
    .data.circuit_breaker.consecutive_request_changes, 1);
});

test7g('first upgraded verdict authenticates a nonzero legacy counter baseline', () => {
  for (const baseline of [1, 2]) {
    const fixture = fixture7g(`dl-7g-legacy-breaker-${baseline}-`);
    raw7g(fixture.root, fixture.runId, loop => {
      loop.circuit_breaker.consecutive_request_changes = baseline;
    });
    const fence = { owner: fixture.owner, generation: fixture.generation };
    const input = { requestId: `legacy-baseline-${baseline}` };
    const first = verdict7g(fixture.root, fixture.runId, 'REQUEST_CHANGES', fence, input);
    assert7g.deepEqual(first, { ok: true, changed: true });
    const event = lines7g(fixture.root, fixture.runId)
      .filter(item => item.type === 'breaker-review-verdict').at(-1);
    assert7g.equal(event.data.baseline_count, baseline);
    assert7g.equal(event.data.previous_count, baseline);
    assert7g.equal(event.data.next_count, baseline + 1);
    const committed = bytes7g(fixture.root, fixture.runId);
    if (baseline === 1) {
      assert7g.deepEqual(
        verdict7g(fixture.root, fixture.runId, 'REQUEST_CHANGES', fence, input), first);
    } else {
      assert7g.throws(() => verdict7g(fixture.root, fixture.runId,
        'REQUEST_CHANGES', fence, input), /LEASE_FENCED: RUN_PAUSED/);
    }
    assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), committed);
  }

  const reset = fixture7g('dl-7g-legacy-breaker-reset-');
  raw7g(reset.root, reset.runId, loop => {
    loop.circuit_breaker = { consecutive_request_changes: 2,
      tripped: false, trip_reason: null };
  });
  const resetFence = { owner: reset.owner, generation: reset.generation };
  reset7g(reset.root, reset.runId,
    { fence: { ...resetFence, intent: 'breaker-reset' },
      requestId: 'legacy-reset-lineage' });
  verdict7g(reset.root, reset.runId, 'APPROVE', resetFence,
    { requestId: 'post-reset-baseline' });
  const postReset = lines7g(reset.root, reset.runId)
    .filter(item => item.type === 'breaker-review-verdict').at(-1);
  assert7g.equal(postReset.data.baseline_count, null,
    'an anchored reset establishes the zero lineage without a legacy baseline');
});

test7g('trip and reset retries preserve their original response across newer operations', () => {
  const fixture = fixture7g('dl-7g-breaker-intervening-retry-');
  const fence = { owner: fixture.owner, generation: fixture.generation };
  const trip = { fence, requestId: 'intervening-trip' };
  assert7g.deepEqual(trip7g(fixture.root, fixture.runId,
    'consecutive-request-changes', trip),
    { ok: true, changed: true });
  const reset = { fence: { ...fence, intent: 'breaker-reset' },
    requestId: 'intervening-reset' };
  assert7g.deepEqual(reset7g(fixture.root, fixture.runId, reset),
    { ok: true, changed: true, status: 'running' });
  const afterReset = bytes7g(fixture.root, fixture.runId);
  assert7g.deepEqual(trip7g(fixture.root, fixture.runId,
    'consecutive-request-changes', trip),
    { ok: true, changed: true });
  assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), afterReset,
    'old trip retry must not re-trip after the newer reset');

  verdict7g(fixture.root, fixture.runId, 'REQUEST_CHANGES', fence,
    { requestId: 'verdict-after-reset' });
  const afterVerdict = bytes7g(fixture.root, fixture.runId);
  assert7g.deepEqual(reset7g(fixture.root, fixture.runId, reset),
    { ok: true, changed: true, status: 'running' });
  assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), afterVerdict,
    'old reset retry must not erase a newer verdict');
  assert7g.equal(readState(fixture.root, fixture.runId)
    .data.circuit_breaker.consecutive_request_changes, 1);
});

test7g('review verdict replay authenticates intervening review-outcome transitions', () => {
  const fixture = fixture7g('dl-7g-review-outcome-lineage-');
  const fence = { owner: fixture.owner, generation: fixture.generation };
  const mutationFence = { ...fence, intent: 'business' };
  const workstreamId = newWorkstream7g(fixture.root, fixture.runId, {
    title: 'lineage', branch: 'codex/lineage',
    worktree: '.claude/worktrees/lineage', fence: mutationFence,
  }).id;
  const episodeId = newEpisode7g(fixture.root, fixture.runId, {
    plugin: 'deep-review', role: 'checker', kind: 'review', point: 'implementation',
    workstream: workstreamId, expectedArtifacts: [], fence: mutationFence,
  }).id;
  const original = { requestId: 'lineage-verdict' };
  verdict7g(fixture.root, fixture.runId, 'REQUEST_CHANGES', fence, original);
  append7g(fixture.root, fixture.runId, {
    type: 'review-outcome', data: { verdict: 'REQUEST_CHANGES', episodeId,
      workstream_id: workstreamId },
  }, loop => { loop.circuit_breaker.consecutive_request_changes += 1; }, undefined,
  mutation7g('test-review-outcome', fence,
    { requestId: 'lineage-review-request-changes', verdict: 'REQUEST_CHANGES' },
    'LEASE_FENCED: test-review-outcome'));
  const afterRequestChanges = bytes7g(fixture.root, fixture.runId);
  assert7g.deepEqual(verdict7g(fixture.root, fixture.runId,
    'REQUEST_CHANGES', fence, original), { ok: true, changed: true });
  assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), afterRequestChanges);
  append7g(fixture.root, fixture.runId, {
    type: 'review-outcome', data: { verdict: 'APPROVE', episodeId,
      workstream_id: workstreamId },
  }, loop => { loop.circuit_breaker.consecutive_request_changes = 0; }, undefined,
  mutation7g('test-review-outcome', fence,
    { requestId: 'lineage-review-approve', verdict: 'APPROVE' },
    'LEASE_FENCED: test-review-outcome'));
  const afterApprove = bytes7g(fixture.root, fixture.runId);
  assert7g.deepEqual(verdict7g(fixture.root, fixture.runId,
    'REQUEST_CHANGES', fence, original), { ok: true, changed: true });
  assert7g.deepEqual(bytes7g(fixture.root, fixture.runId), afterApprove);
});
