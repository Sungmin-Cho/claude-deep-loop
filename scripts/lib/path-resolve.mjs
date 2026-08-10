import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { normalizePortableRelativePath, pathWithin } from './fs-safe.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { captureVerifiedRunSnapshot as captureVerifiedRunSnapshotDefault } from './integrity.mjs';

const realpath = realpathSync.native || realpathSync;

function safeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0
    || runId === '.' || runId === '..' || /[/\\]/.test(runId)) {
    throw new Error(`RUN_DIR_ESCAPE: ${String(runId)}`);
  }
}

function assertDirectoryLineage(canonicalRoot, lexicalCandidate, code) {
  const rel = relative(canonicalRoot, lexicalCandidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${code}: ${lexicalCandidate}`);
  }
  let current = canonicalRoot;
  for (const segment of rel.split(sep)) {
    if (!segment || segment === '.' || segment === '..') {
      throw new Error(`${code}: ${lexicalCandidate}`);
    }
    current = resolve(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpath(current) !== current) {
        throw new Error(`${code}: ${current}`);
      }
    } catch (error) {
      if (String(error?.message || error).startsWith(`${code}:`)) throw error;
      throw new Error(`${code}: ${current}`, { cause: error });
    }
  }
}

function assertSafeRunStateLineage(canonicalRoot, runId) {
  assertDirectoryLineage(
    canonicalRoot,
    resolve(canonicalRoot, '.deep-loop', 'runs', runId),
    'RUN_DIR_ESCAPE',
  );
}

function assertNoAliasComponents(canonicalRoot, lexicalCandidate) {
  assertDirectoryLineage(canonicalRoot, lexicalCandidate, 'WORKSTREAM_WORKTREE_ESCAPE');
}

function verifiedSnapshot(root, runId, options) {
  const supplied = options.snapshot;
  const captured = supplied === undefined
    ? (options.captureVerifiedRunSnapshot || captureVerifiedRunSnapshotDefault)(root, runId)
    : supplied;
  if (captured?.ok === false) {
    const operation = captured.operation_id ? `:${captured.operation_id}` : '';
    throw new Error(`${captured.kind || 'integrity-invalid'}${operation}:${captured.phase || 'snapshot'}`);
  }
  const snapshot = captured?.snapshot || captured;
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.data || typeof snapshot.hash !== 'string') {
    throw new Error('integrity-invalid: verified snapshot required');
  }
  if (snapshot.data.run_id !== runId) throw new Error('integrity-invalid: snapshot run mismatch');
  let snapshotRoot;
  try { snapshotRoot = canonicalProjectRoot(snapshot.data.project?.root); }
  catch { throw new Error('integrity-invalid: snapshot root mismatch'); }
  if (snapshotRoot !== root) throw new Error('integrity-invalid: snapshot root mismatch');
  return snapshot;
}

export function resolveRunPath(rootOrOptions, runIdArg, optionsArg = {}) {
  const objectForm = rootOrOptions && typeof rootOrOptions === 'object' && !Array.isArray(rootOrOptions);
  const root = objectForm ? rootOrOptions.root : rootOrOptions;
  const runId = objectForm ? rootOrOptions.runId : runIdArg;
  const {
    target, workstreamId, snapshot, captureVerifiedRunSnapshot,
  } = objectForm ? rootOrOptions : optionsArg;
  const canonicalRoot = canonicalProjectRoot(root);
  safeRunId(runId);
  assertSafeRunStateLineage(canonicalRoot, runId);
  const { data } = verifiedSnapshot(canonicalRoot, runId, {
    snapshot,
    captureVerifiedRunSnapshot,
  });

  if (target === 'run-dir') {
    const lexicalRuns = resolve(canonicalRoot, '.deep-loop', 'runs');
    const lexicalRunDir = resolve(lexicalRuns, runId);
    let canonicalRuns;
    let canonicalRunDir;
    try {
      canonicalRuns = realpath(lexicalRuns);
      canonicalRunDir = realpath(lexicalRunDir);
    } catch (error) {
      throw new Error(`RUN_DIR_ESCAPE: ${runId}`, { cause: error });
    }
    if (canonicalRuns !== lexicalRuns
      || canonicalRunDir !== lexicalRunDir
      || !pathWithin(canonicalRoot, canonicalRuns)
      || !pathWithin(lexicalRuns, canonicalRunDir)
      || relative(lexicalRuns, canonicalRunDir) === '') {
      throw new Error(`RUN_DIR_ESCAPE: ${runId}`);
    }
    return canonicalRunDir;
  }

  if (target !== 'workstream') throw new Error(`PATH_TARGET_INVALID: ${String(target)}`);
  const workstream = data.workstreams.find(item => item.id === workstreamId);
  if (!workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${String(workstreamId)}`);
  if (typeof workstream.worktree !== 'string' || workstream.worktree.length === 0) {
    throw new Error('WORKSTREAM_WORKTREE_ESCAPE: missing stored worktree');
  }
  const portable = normalizePortableRelativePath(workstream.worktree);
  if (!portable) throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: ${workstream.worktree}`);
  const convention = portable.startsWith('.claude/worktrees/')
    ? '.claude/worktrees'
    : portable.startsWith('.worktrees/') ? '.worktrees' : null;
  if (!convention) throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: ${workstream.worktree}`);

  const lexicalBase = resolve(canonicalRoot, convention);
  const lexicalCandidate = resolve(canonicalRoot, portable);
  assertNoAliasComponents(canonicalRoot, lexicalCandidate);
  let canonicalBase;
  let candidate;
  try {
    canonicalBase = realpath(lexicalBase);
    candidate = realpath(lexicalCandidate);
  } catch (error) {
    throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: ${workstream.worktree}`, { cause: error });
  }
  if (canonicalBase !== lexicalBase
    || !pathWithin(canonicalBase, candidate)
    || relative(canonicalBase, candidate) === '') {
    throw new Error(`WORKSTREAM_WORKTREE_ESCAPE: ${workstream.worktree}`);
  }
  return candidate;
}
