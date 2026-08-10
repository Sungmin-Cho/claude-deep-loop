import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedText } from '../lib/bounded-input.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { sessionRuntime } from '../lib/runtime.mjs';

export const MAX_POSTCOMPACT_INPUT_BYTES = 4096;
export const MAX_POSTCOMPACT_HOST_INPUT_BYTES = 256 * 1024;
export const MAX_POSTCOMPACT_RUN_ENTRIES = 256;
export const MAX_POSTCOMPACT_CHECKPOINT_ENTRIES = 256;
export const MAX_POSTCOMPACT_LOOP_BYTES = 1024 * 1024;
export const POSTCOMPACT_OBSERVE_TIMEOUT_MS = 5000;

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'deep-loop.mjs');
const CHECKPOINT_NAME = /^[0-9a-f]{64}-compact\.json$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function canonicalExactDirectory(value) {
  if (typeof value !== 'string' || value.length === 0 || resolve(value) !== value) return null;
  try {
    const canonical = realpathSync(value);
    return canonical === value && lstatSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function safeCurrentRunId(value) {
  return typeof value === 'string'
    && value.length <= 200
    && SAFE_SEGMENT.test(value)
    && value !== '.'
    && value !== '..';
}

function exactRegularFile(path) {
  try {
    const entry = lstatSync(path);
    return entry.isFile() && !entry.isSymbolicLink() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

function boundedDirectoryNames(path, maxEntries) {
  let directory;
  try {
    directory = opendirSync(path);
    const names = [];
    while (true) {
      const entry = directory.readSync();
      if (entry === null) return names;
      if (names.length >= maxEntries) return null;
      names.push(entry.name);
    }
  } catch {
    return null;
  } finally {
    try { directory?.closeSync(); } catch { /* best effort */ }
  }
}

function readBoundedExactRegular(path, maxBytes) {
  if (!exactRegularFile(path)) return null;
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(maxBytes)) return null;
    const expected = Number(stat.size);
    const bytes = Buffer.allocUnsafe(expected + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return offset === expected ? bytes.subarray(0, offset) : null;
  } catch {
    return null;
  } finally {
    try { if (descriptor !== undefined) closeSync(descriptor); } catch { /* best effort */ }
  }
}

function containedWorktreeBase(canonicalCwd) {
  let current = canonicalCwd;
  while (true) {
    const parent = dirname(current);
    const currentName = current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1));
    const grandparent = dirname(parent);
    const parentName = parent.slice(grandparent.length + (grandparent.endsWith(sep) ? 0 : 1));
    const base = currentName === '.worktrees'
      ? parent
      : parentName === '.claude' && currentName === 'worktrees'
        ? grandparent
        : null;
    if (base && exactRegularFile(join(base, '.deep-loop', 'current'))) return base;
    if (parent === current) return null;
    current = parent;
  }
}

export function resolvePostCompactProjectRoot(cwd, { expectedRoot } = {}) {
  const canonicalCwd = canonicalExactDirectory(cwd);
  if (canonicalCwd === null) return null;
  const expected = expectedRoot === undefined ? undefined : canonicalExactDirectory(expectedRoot);
  if (expectedRoot !== undefined && expected === null) return null;

  let base;
  let worktreeRoot = null;
  if (exactRegularFile(join(canonicalCwd, '.deep-loop', 'current'))) {
    base = canonicalCwd;
  } else {
    base = containedWorktreeBase(canonicalCwd);
    if (base === null) return null;
    const rel = relative(base, canonicalCwd);
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return null;
    const parts = rel.split(sep);
    const offset = parts[0] === '.worktrees'
      ? 1
      : parts[0] === '.claude' && parts[1] === 'worktrees'
        ? 2
        : -1;
    if (offset < 0 || typeof parts[offset] !== 'string' || parts[offset].length === 0) return null;
    worktreeRoot = join(base, ...parts.slice(0, offset + 1));
    if (canonicalExactDirectory(worktreeRoot) !== worktreeRoot) return null;
  }

  const canonicalBase = canonicalExactDirectory(base);
  if (canonicalBase === null || (expected !== undefined && expected !== canonicalBase)) return null;
  if (worktreeRoot !== null) {
    let current = canonicalCwd;
    while (current !== worktreeRoot) {
      if (exactRegularFile(join(current, '.deep-loop', 'current'))
        || existsSync(join(current, '.git'))) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return canonicalBase;
}

function newestCheckpoint(runPath) {
  const directory = join(runPath, 'checkpoints');
  if (canonicalExactDirectory(directory) !== directory) return null;
  const entries = boundedDirectoryNames(directory, MAX_POSTCOMPACT_CHECKPOINT_ENTRIES);
  if (entries === null) return null;
  const names = entries.filter(name => CHECKPOINT_NAME.test(name));
  const candidates = [];
  for (const name of names) {
    const path = join(directory, name);
    if (!exactRegularFile(path)) continue;
    try { candidates.push({ name, mtimeMs: statSync(path).mtimeMs }); } catch { /* ignore */ }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  return candidates.length === 0 ? null : `checkpoints/${candidates[0].name}`;
}

function runObservationCandidate(root, runId, canonicalCwd) {
  const runPath = join(root, '.deep-loop', 'runs', runId);
  if (canonicalExactDirectory(runPath) !== runPath) return null;
  const loopPath = join(runPath, 'loop.json');
  const loopBytes = readBoundedExactRegular(loopPath, MAX_POSTCOMPACT_LOOP_BYTES);
  if (loopBytes === null) return null;
  let loop;
  try { loop = JSON.parse(loopBytes.toString('utf8')); } catch { return null; }
  if (loop?.run_id !== runId || loop?.status !== 'running') return null;
  let storedRoot;
  try { storedRoot = realpathSync(loop?.project?.root); } catch { return null; }
  if (storedRoot !== root) return null;

  const lease = loop?.session_chain?.lease;
  const owner = lease?.owner_run_id;
  const generation = lease?.generation;
  if (!safeCurrentRunId(owner)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || lease?.state !== 'active') return null;
  const ownerSession = Array.isArray(loop?.session_chain?.sessions)
    ? loop.session_chain.sessions.find(session => session?.run_id === owner)
    : null;
  const scope = ownerSession?.scope;
  if (scope?.kind !== 'workstream'
    || typeof scope.workstream_id !== 'string'
    || scope.workstream_id.length === 0
    || scope.terminal_event !== null
    || scope.closed_at !== null
    || scope.superseded_at !== null) return null;
  const workstream = Array.isArray(loop?.workstreams)
    ? loop.workstreams.find(item => item?.id === scope.workstream_id)
    : null;
  const episode = Array.isArray(loop?.episodes)
    ? loop.episodes.find(item => item?.id === loop.current_episode)
    : null;
  if (!workstream
    || ['ready', 'merged', 'abandoned'].includes(workstream.status)
    || episode?.workstream_id !== scope.workstream_id
    || typeof workstream.worktree !== 'string') return null;
  const worktreePath = resolve(root, workstream.worktree);
  const canonicalWorktree = canonicalExactDirectory(worktreePath);
  if (canonicalWorktree === null) return null;
  const rootRelative = relative(root, canonicalWorktree);
  if (!rootRelative || rootRelative.startsWith('..') || rootRelative.split(sep).includes('..')) return null;
  const cwdRelative = relative(canonicalWorktree, canonicalCwd);
  const cwdBound = cwdRelative === ''
    || (!cwdRelative.startsWith('..') && !cwdRelative.split(sep).includes('..'));
  let runtime;
  try { runtime = sessionRuntime(loop); } catch { return null; }
  const checkpointRel = newestCheckpoint(runPath);
  return {
    runId,
    owner,
    generation,
    runtime,
    checkpointRel,
    cwdBound,
  };
}

function observationRequest(root, cwd) {
  const canonicalCwd = canonicalExactDirectory(cwd);
  if (canonicalCwd === null) return null;
  const runsPath = join(root, '.deep-loop', 'runs');
  if (canonicalExactDirectory(runsPath) !== runsPath) return null;
  const entries = boundedDirectoryNames(runsPath, MAX_POSTCOMPACT_RUN_ENTRIES);
  if (entries === null) return null;
  const names = entries.filter(safeCurrentRunId).sort();
  const candidates = names
    .map(runId => runObservationCandidate(root, runId, canonicalCwd))
    .filter(Boolean);
  const cwdBound = candidates.filter(candidate => candidate.cwdBound);
  const selected = cwdBound.length === 1
    ? cwdBound[0]
    : cwdBound.length === 0 && candidates.length === 1
      ? candidates[0]
      : null;
  if (selected === null || selected.checkpointRel === null) return null;
  const { cwdBound: _cwdBound, ...request } = selected;
  return request;
}

function trustedBody(input, root) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || input.hook_event_name !== 'PostCompact'
    || !['manual', 'auto'].includes(input.trigger)
    || resolvePostCompactProjectRoot(input.cwd, { expectedRoot: root }) !== root) return null;
  if (Object.hasOwn(input, 'session_id')
    && (typeof input.session_id !== 'string'
      || input.session_id.length === 0
      || input.session_id.length > 1024
      || /[\0\r\n]/.test(input.session_id))) return null;
  const body = {
    cwd: input.cwd,
    hook_event_name: 'PostCompact',
    trigger: input.trigger,
    ...(Object.hasOwn(input, 'session_id') ? { session_id: input.session_id } : {}),
  };
  const raw = JSON.stringify(body);
  return Buffer.byteLength(raw, 'utf8') <= MAX_POSTCOMPACT_INPUT_BYTES ? raw : null;
}

export function runPostCompactObserve(input = {}, {
  spawnSyncImpl = spawnSync,
  expectedRoot,
} = {}) {
  const root = resolvePostCompactProjectRoot(input?.cwd, { expectedRoot });
  if (root === null) return { ok: false, action: 'ignored', reason: 'host-context-invalid' };
  const body = trustedBody(input, root);
  if (body === null) return { ok: false, action: 'ignored', reason: 'host-context-invalid' };
  const request = observationRequest(root, input.cwd);
  if (request === null) return { ok: false, action: 'ignored', reason: 'observation-unavailable' };
  const argv = [
    CLI,
    'checkpoint', 'observe',
    '--checkpoint', request.checkpointRel,
    '--trigger', input.trigger,
    '--owner', request.owner,
    '--generation', String(request.generation),
    '--runtime', request.runtime,
    '--trusted-postcompact-stdin',
    '--json',
    '--project-root', root,
    '--run-id', request.runId,
  ];
  let child;
  try {
    child = spawnSyncImpl(process.execPath, argv, {
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      input: body,
      windowsHide: true,
      timeout: POSTCOMPACT_OBSERVE_TIMEOUT_MS,
    });
  } catch {
    return { ok: false, action: 'failed', reason: 'observe-child-failed' };
  }
  return child?.status === 0 && child.signal == null && child.error === undefined
    ? { ok: true, action: 'observed' }
    : { ok: false, action: 'failed', reason: 'observe-child-failed' };
}

export async function main() {
  try {
    const raw = await readBoundedText(process.stdin, { maxBytes: MAX_POSTCOMPACT_HOST_INPUT_BYTES });
    const input = JSON.parse(raw);
    const result = runPostCompactObserve(input);
    if (!result.ok) throw new Error('adapter-failed');
  } catch {
    process.stderr.write('deep-loop: postcompact hook failed\n');
  }
}

const { isMain, diagnostic } = detectMain(import.meta.url, process.argv[1]);
if (diagnostic) {
  process.stderr.write(`${diagnostic}\n`);
} else if (isMain) {
  await main();
}
