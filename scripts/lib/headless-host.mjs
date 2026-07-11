import { fileURLToPath } from 'node:url';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { findRoot, pauseRun, readState, runDir, withLock } from './state.mjs';
import { recordCost, isMeasuredOneTurnUsage } from './budget.mjs';
import { respawn, respawnGate, resolveSpawnMode } from './respawn.mjs';
import { headlessSpawn } from './spawn-driver.mjs';
import { ensureCodexPreflight } from './codex-preflight.mjs';
import {
  revalidateTrustedRuntimeExecutable,
  resolveAuthenticatedCodexHome,
} from './runtime-executable.mjs';
import { buildMinimalCodexEnv } from './codex-runtime.mjs';
import { buildLaunchCommand } from './runtime-descriptor.mjs';
import { sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';

const DEFAULT_DEEP_LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESUME_SKILL_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
const HOST_LOCK_GRACE_MS = 15 * 60 * 1000;
const HOST_LOCK_CRASH_GRACE_MS = 30 * 1000;
const NODE_TIMER_MAX_MS = 2_147_483_647;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function inspectDirectoryNode(path) {
  const lexical = resolve(path);
  const before = lstatSync(lexical, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('directory must be non-symlink');
  const canonical = (realpathSync.native || realpathSync)(lexical);
  if (resolve(canonical) !== lexical) throw new Error('directory must already be canonical');
  const after = lstatSync(canonical, { bigint: true });
  if (after.isSymbolicLink() || !after.isDirectory()
    || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) {
    throw new Error('directory identity changed');
  }
  return {
    canonical_path: canonical,
    device: String(after.dev),
    inode: String(after.ino),
    mode: String(after.mode),
  };
}

function inspectRegularFileIdentity(path) {
  const lexical = resolve(path);
  const before = lstatSync(lexical, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o444n) === 0n
    || before.size > BigInt(RESUME_SKILL_MAX_BYTES)) {
    throw new Error('file must be a bounded readable non-symlink');
  }
  const canonical = (realpathSync.native || realpathSync)(lexical);
  const canonicalStat = lstatSync(canonical, { bigint: true });
  if (resolve(canonical) !== lexical || canonicalStat.isSymbolicLink() || !canonicalStat.isFile()
    || !sameFileIdentity(before, canonicalStat)) {
    throw new Error('file identity changed during canonicalization');
  }
  let fd;
  let bytes;
  try {
    fd = openSync(canonical, 'r');
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(canonicalStat, opened)) throw new Error('file changed before read');
    bytes = readFileSync(fd);
    const read = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(opened, read)) throw new Error('file changed during read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const after = lstatSync(canonical, { bigint: true });
  if (!sameFileIdentity(canonicalStat, after)) throw new Error('file changed after read');
  return {
    canonical_path: canonical,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    device: String(after.dev),
    inode: String(after.ino),
    mode: String(after.mode),
    size: String(after.size),
    mtime_ns: String(after.mtimeNs),
    ctime_ns: String(after.ctimeNs),
  };
}

function hostLockTtl(timeoutMs) {
  const bounded = Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= NODE_TIMER_MAX_MS
    ? timeoutMs
    : DEFAULT_PROCESS_TIMEOUT_MS;
  return Math.min(Number.MAX_SAFE_INTEGER, bounded * 3 + HOST_LOCK_GRACE_MS);
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireHeadlessHostLock(root, runId, {
  timeoutMs,
  wallNow = Date.now,
  processAlive = defaultProcessAlive,
  pid = process.pid,
} = {}) {
  const lockPath = join(runDir(root, runId), '.headless-host.lock');
  const ownerPath = join(lockPath, 'owner');
  const token = randomUUID();
  const ttlMs = hostLockTtl(timeoutMs);
  const ownerPayload = JSON.stringify({ token, pid, started_at_ms: wallNow() });
  let acquired = false;
  try {
    // The kernel lock coordinates only this small metadata transaction. It is released before authentication,
    // preflight, cost recording, maker CAS, or any runtime process, so normal kernel mutations cannot deadlock.
    acquired = withLock(root, runId, () => {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const ageMs = wallNow() - statSync(lockPath).mtimeMs;
        let observedOwner = null;
        try { observedOwner = readFileSync(ownerPath, 'utf8'); } catch (inspectError) {
          if (inspectError?.code !== 'ENOENT') throw inspectError;
        }
        let owner = null;
        try {
          const parsed = JSON.parse(observedOwner);
          if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0
            && Number.isInteger(parsed.pid) && parsed.pid > 0) owner = parsed;
        } catch { /* malformed metadata is treated like an owner-missing partial acquire */ }
        let alive = true;
        if (owner && ageMs > HOST_LOCK_CRASH_GRACE_MS) {
          try { alive = processAlive(owner.pid); } catch { alive = true; }
        }
        const reclaimable = Number.isFinite(ageMs)
          && (ageMs > ttlMs
            || (ageMs > HOST_LOCK_CRASH_GRACE_MS && (!owner || !alive)));
        if (!reclaimable) return false;
        try {
          if (observedOwner != null) unlinkSync(ownerPath);
          rmdirSync(lockPath);
          mkdirSync(lockPath, { mode: 0o700 });
        } catch {
          return false;
        }
      }
      try {
        writeFileSync(ownerPath, ownerPayload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      } catch (error) {
        try { rmdirSync(lockPath); } catch { /* best effort */ }
        throw error;
      }
      return true;
    });
  } catch (error) {
    if (String(error?.message || error).startsWith('LOCK_BUSY')) return null;
    throw error;
  }
  if (!acquired) return null;
  let released = false;
  return {
    release() {
      if (released) return;
      withLock(root, runId, () => {
        let current;
        try { current = readFileSync(ownerPath, 'utf8'); } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw error;
        }
        if (current !== ownerPayload) return;
        unlinkSync(ownerPath);
        rmdirSync(lockPath);
      }, { retries: 2_000, backoffMs: 5 });
      released = true;
    },
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminal(loop) {
  return loop.status === 'completed' || loop.status === 'stopped';
}

function exactChildAcquired(loop, childRunId) {
  const child = (loop.session_chain?.sessions || []).find((session) => session.run_id === childRunId);
  return typeof child?.started_at === 'string' && child.started_at.length > 0;
}

function pendingHandoff(loop) {
  const lease = loop.session_chain?.lease || {};
  return (lease.handoff_phase === 'emitted' || lease.handoff_phase === 'spawned')
    && typeof lease.handoff_child_run_id === 'string'
    && lease.handoff_child_run_id.length > 0;
}

function pauseWithFreshFence(root, runId, { reason, expect, now }) {
  const attempt = (fence) => pauseRun(root, runId, {
    reason,
    mode: 'preserve',
    expect: fence,
    now,
  });
  try {
    attempt(expect);
    return 'paused';
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('RUN_TERMINAL')) return 'terminal';
    if (!message.startsWith('LEASE_FENCED')) throw error;
  }
  const { data: freshLoop } = readState(root, runId);
  if (terminal(freshLoop)) return 'terminal';
  const freshLease = freshLoop.session_chain?.lease || {};
  try {
    attempt({ owner: freshLease.owner_run_id, generation: freshLease.generation });
    return 'paused';
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('RUN_TERMINAL')) return 'terminal';
    if (message.startsWith('LEASE_FENCED')) return 'raced';
    throw error;
  }
}

function pauseWithOriginalFence(root, runId, { reason, expect, now }) {
  try {
    pauseRun(root, runId, { reason, mode: 'preserve', expect, now });
    return 'paused';
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('RUN_TERMINAL')) return 'terminal';
    if (message.startsWith('LEASE_FENCED')) return 'fenced';
    throw error;
  }
}

function driveHeadlessRunLocked({
  root,
  runId,
  now = Date.now(),
  timeoutMs,
  env = process.env,
  expect = null,
  headless = true,
  overrideVisiblePolicy = false,
  deepLoopRoot = DEFAULT_DEEP_LOOP_ROOT,
  spawnFn = headlessSpawn,
  preflightFn = ensureCodexPreflight,
  recordCostFn = recordCost,
  respawnFn = respawn,
  revalidateExecutable = revalidateTrustedRuntimeExecutable,
  resolveCodexHome = resolveAuthenticatedCodexHome,
  inspectDirectory = inspectDirectoryNode,
  inspectResumeSkill = inspectRegularFileIdentity,
} = {}) {
  const { data: initialLoop } = readState(root, runId);
  const runtime = sessionRuntime(initialLoop);
  const projectRoot = canonicalProjectRoot(initialLoop.project.root);
  const initialLease = initialLoop.session_chain?.lease || {};
  const parentFence = expect ?? {
    owner: initialLease.owner_run_id,
    generation: initialLease.generation,
  };
  if (initialLease.owner_run_id !== parentFence.owner
    || initialLease.generation !== parentFence.generation) {
    return { ok: false, action: 'fenced', reason: 'caller-parent-fence-mismatch' };
  }
  const parentOwner = parentFence.owner;
  const parentGeneration = parentFence.generation;
  const childRunId = initialLease.handoff_child_run_id;
  const key = initialLease.handoff_idempotency_key;
  const initialApproval = initialLoop.autonomy?.runtime_executable_approval;

  if (!pendingHandoff(initialLoop)) return { ok: true, action: 'no-pending-handoff' };
  if (terminal(initialLoop)) return { ok: false, action: 'terminal', reason: 'RUN_TERMINAL' };
  if (initialLease.resume_policy === 'human') {
    return { ok: true, skipped: true, reason: 'human-resume-policy' };
  }
  const visiblePolicyOverride = overrideVisiblePolicy === true
    && initialLoop.status === 'running'
    && initialLease.resume_policy === 'visible';
  if (initialLease.resume_policy !== 'headless' && !visiblePolicyOverride) {
    return { ok: true, skipped: true, reason: 'not-headless-intended' };
  }

  if (initialLease.handoff_phase === 'spawned') {
    if (exactChildAcquired(initialLoop, childRunId)) {
      return { ok: true, action: 'already-spawned' };
    }
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-child-did-not-acquire',
      expect: parentFence,
      now,
    });
    if (pauseOutcome === 'terminal') return { ok: true, action: 'already-spawned' };
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'resumed-unconfirmed',
      reason: 'child-did-not-acquire',
      recorded: false,
    };
  }

  const initialMode = resolveSpawnMode(initialLoop, { headless, env });
  if (initialMode !== 'headless') {
    return {
      ok: false,
      action: 'mode-changed',
      reason: `spawn-mode-changed:headless->${initialMode}`,
    };
  }

  const child = (initialLoop.session_chain?.sessions || []).find((session) => session.run_id === childRunId);
  const handoffRel = child?.handoff_rel || '';
  const resumeSkillPath = join(deepLoopRoot, 'skills', 'deep-loop-resume', 'SKILL.md');
  const preliminaryGate = respawnGate(initialLoop, { now });
  const failPreflight = (reason) => {
    const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
      reason,
      expect: { owner: parentOwner, generation: parentGeneration },
      now,
    });
    if (pauseOutcome === 'terminal') return { ok: false, action: 'fail-closed-terminal', reason };
    if (pauseOutcome === 'fenced') return { ok: false, action: 'fenced', reason };
    return { ok: false, action: 'preflight-failed', reason };
  };

  let executable = null;
  let codexHome = null;
  let makerEnvSnapshot = null;
  let projectDirectorySnapshot = null;
  let pluginDirectorySnapshot = null;
  let resumeSkillSnapshot = null;
  if (runtime === 'codex' && preliminaryGate.ok) {
    try {
      executable = revalidateExecutable(initialLoop.autonomy?.runtime_executable_approval);
    } catch {
      return failPreflight('executable-invalid');
    }
    try {
      codexHome = resolveCodexHome({ env, platform: executable.platform });
    } catch {
      return failPreflight('codex-home-invalid');
    }
    try {
      makerEnvSnapshot = buildMinimalCodexEnv({
        platform: executable.platform,
        sourceEnv: env,
        codexHome: codexHome.canonical_path,
        runId,
        projectRoot,
        owner: childRunId,
        generation: parentGeneration + 1,
      });
    } catch {
      return failPreflight('preflight-invalid');
    }
    try {
      projectDirectorySnapshot = inspectDirectory(projectRoot);
      pluginDirectorySnapshot = inspectDirectory(deepLoopRoot);
    } catch {
      return failPreflight('root-invalid');
    }
    try {
      resumeSkillSnapshot = inspectResumeSkill(resumeSkillPath);
    } catch {
      return failPreflight('resume-skill-invalid');
    }
    let preflight;
    try {
      preflight = preflightFn({
        projectRoot,
        runId,
        executableIdentity: initialApproval,
        codexHomeIdentity: codexHome,
        deepLoopRoot,
        resumeSkillPath,
        sourceEnv: env,
        owner: parentOwner,
        generation: parentGeneration,
        model: initialLoop.autonomy?.session_model ?? null,
        effort: initialLoop.autonomy?.session_effort ?? null,
        timeoutMs,
        revalidateExecutable,
        resolveCodexHome,
      });
    } catch {
      return failPreflight('preflight-error');
    }
    const validPreflight = preflight != null
      && typeof preflight === 'object'
      && !Array.isArray(preflight)
      && typeof preflight.ok === 'boolean'
      && Array.isArray(preflight.measured_usage)
      && (preflight.ok
        ? typeof preflight.cache_hit === 'boolean'
          && (preflight.cache_hit ? preflight.measured_usage.length === 0 : preflight.measured_usage.length === 2)
        : typeof preflight.reason === 'string' && preflight.reason.length > 0
          && preflight.pause_mode === 'preserve' && preflight.measured_usage.length <= 2);
    if (!validPreflight) return failPreflight('preflight-invalid');
    const measuredUsage = preflight.measured_usage;
    let preflightRecorded = 0;
    for (const usage of measuredUsage) {
      if (!isMeasuredOneTurnUsage(usage)) return failPreflight('preflight-usage-invalid');
      try {
        recordCostFn(projectRoot, runId, {
          turns: usage.num_turns,
          tokens: usage.tokens,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        });
        preflightRecorded += 1;
      } catch (error) {
        const message = String(error?.message || error);
        if (!message.startsWith('LEASE_FENCED') && !message.startsWith('RUN_TERMINAL')) throw error;
        const pauseOutcome = pauseWithOriginalFence(projectRoot, runId, {
          reason: 'preflight-accounting-failed',
          expect: parentFence,
          now,
        });
        return {
          ok: false,
          action: pauseOutcome === 'terminal' ? 'fail-closed-terminal'
            : (pauseOutcome === 'fenced' ? 'fenced' : 'preflight-accounting-failed'),
          reason: 'accounting-fenced',
          recorded: preflightRecorded,
        };
      }
    }
    if (!preflight.ok) return failPreflight(preflight.reason);
  }

  let captured = null;
  let spawnCalls = 0;
  const measuredSpawn = (entry) => {
    spawnCalls += 1;
    if (spawnCalls !== 1) return { ok: false, reason: 'maker-spawn-reentry' };
    let enriched = entry;
    if (runtime === 'codex') {
      try {
        let freshProjectDirectory;
        let freshPluginDirectory;
        try {
          freshProjectDirectory = inspectDirectory(projectRoot);
          freshPluginDirectory = inspectDirectory(deepLoopRoot);
        } catch {
          return { ok: false, reason: 'post-cas-root-drift' };
        }
        if (!sameValue(freshProjectDirectory, projectDirectorySnapshot)
          || !sameValue(freshPluginDirectory, pluginDirectorySnapshot)) {
          return { ok: false, reason: 'post-cas-root-drift' };
        }
        const { data: freshLoop } = readState(projectRoot, runId);
        const freshLease = freshLoop.session_chain?.lease || {};
        const freshExecutable = revalidateExecutable(freshLoop.autonomy?.runtime_executable_approval);
        const freshHome = resolveCodexHome({
          env,
          expectedIdentity: codexHome,
          platform: freshExecutable.platform,
        });
        const freshMakerEnv = buildMinimalCodexEnv({
          platform: freshExecutable.platform,
          sourceEnv: env,
          codexHome: freshHome.canonical_path,
          runId,
          projectRoot,
          owner: childRunId,
          generation: parentGeneration + 1,
        });
        if (sessionRuntime(freshLoop) !== 'codex'
          || canonicalProjectRoot(freshLoop.project.root) !== projectRoot
          || freshLease.owner_run_id !== parentOwner
          || freshLease.generation !== parentGeneration
          || freshLease.state !== 'releasing'
          || freshLease.handoff_phase !== 'spawned'
          || freshLease.handoff_idempotency_key !== key
          || freshLease.handoff_child_run_id !== childRunId
          || !sameValue(freshLoop.autonomy?.runtime_executable_approval, initialApproval)
          || !sameValue(freshExecutable, executable)
          || freshLoop.autonomy?.session_model !== initialLoop.autonomy?.session_model
          || freshLoop.autonomy?.session_effort !== initialLoop.autonomy?.session_effort) {
          return { ok: false, reason: 'post-cas-identity-drift' };
        }
        if (!sameValue(freshMakerEnv, makerEnvSnapshot)) {
          return { ok: false, reason: 'post-cas-env-drift' };
        }
        const expectedEntry = buildLaunchCommand({
          runtime: 'codex',
          root: projectRoot,
          parentRunId: runId,
          childRunId,
          handoffRel,
          model: initialLoop.autonomy?.session_model ?? null,
          effort: initialLoop.autonomy?.session_effort ?? null,
          codexExecutable: executable.canonical_path,
          deepLoopRoot,
        }).headless;
        if (!sameValue(entry, expectedEntry)) return { ok: false, reason: 'post-cas-entry-mismatch' };
        let freshResumeSkill;
        try {
          freshResumeSkill = inspectResumeSkill(resumeSkillPath);
        } catch {
          return { ok: false, reason: 'post-cas-resume-skill-drift' };
        }
        if (!sameValue(freshResumeSkill, resumeSkillSnapshot)) {
          return { ok: false, reason: 'post-cas-resume-skill-drift' };
        }
        enriched = {
          ...entry,
          cwd: projectRoot,
          env: freshMakerEnv,
          usageOutputKind: 'codex-jsonl',
        };
      } catch {
        return { ok: false, reason: 'post-cas-identity-drift' };
      }
    }
    try {
      captured = spawnFn(enriched, { timeoutMs });
    } catch (error) {
      captured = { ok: false, reason: `spawn-error: ${error?.message || error}` };
    }
    if (captured == null || typeof captured !== 'object' || typeof captured.then === 'function') {
      captured = { ok: false, reason: 'sync-worker-required' };
    }
    if (captured.ok !== true && captured.ok !== false) {
      captured = { ok: false, reason: 'worker-protocol-invalid' };
    } else if (captured.ok === false
      && (typeof captured.reason !== 'string' || captured.reason.length === 0)) {
      captured = { ok: false, reason: 'worker-protocol-invalid' };
    } else if (runtime === 'codex' && captured.ok === true && !isMeasuredOneTurnUsage(captured.usage)) {
      captured = { ok: false, reason: 'worker-protocol-invalid' };
    }
    return captured;
  };

  const result = respawnFn(projectRoot, runId, {
    childRunId,
    key,
    handoffRel,
    headless,
    now,
    env,
    spawnFn: preliminaryGate.ok
      ? measuredSpawn
      : () => ({ ok: false, reason: `preliminary-gate:${preliminaryGate.reason}` }),
    codexExecutable: executable?.canonical_path ?? null,
    deepLoopRoot,
    expect: parentFence,
    expectedMode: 'headless',
  });
  const { data: freshLoop } = readState(projectRoot, runId);
  const childAcquired = exactChildAcquired(freshLoop, childRunId);
  if (result.outcome === 'already-spawned' && captured == null) {
    if (terminal(freshLoop) || childAcquired) return { ok: true, action: 'already-spawned' };
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-child-did-not-acquire',
      expect: parentFence,
      now,
    });
    if (pauseOutcome === 'terminal') return { ok: true, action: 'already-spawned' };
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'resumed-unconfirmed',
      reason: 'child-did-not-acquire',
      recorded: false,
    };
  }
  if (captured?.ok === false) {
    const reason = captured.reason || result.reason;
    if (terminal(freshLoop)) return { ok: false, action: 'fail-closed-terminal', reason };
    if (result.outcome === 'failed_launch') return { ok: false, action: 'fail-closed', reason };
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-unmeasurable',
      expect: parentFence,
      now,
    });
    if (pauseOutcome === 'terminal') return { ok: false, action: 'fail-closed-terminal', reason };
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'fail-closed',
      reason,
    };
  }
  if (captured?.ok === true && !terminal(freshLoop) && !childAcquired) {
    let recorded = false;
    if (runtime === 'codex' && captured.usage) {
      try {
        recordCostFn(projectRoot, runId, {
          turns: captured.usage.num_turns,
          tokens: captured.usage.tokens,
          fence: { owner: parentOwner, generation: parentGeneration, intent: 'accounting' },
        });
        recorded = true;
      } catch (error) {
        const message = String(error?.message || error);
        if (!message.startsWith('LEASE_FENCED') && !message.startsWith('RUN_TERMINAL')) throw error;
      }
    }
    const pauseOutcome = pauseWithFreshFence(projectRoot, runId, {
      reason: 'headless-child-did-not-acquire',
      expect: parentFence,
      now,
    });
    if (pauseOutcome === 'terminal') {
      return { ok: true, action: 'resumed', usage: captured.usage, recorded };
    }
    return {
      ok: false,
      action: pauseOutcome === 'raced' ? 'fail-closed-raced' : 'resumed-unconfirmed',
      reason: 'child-did-not-acquire',
      ...(runtime === 'codex' ? { usage: captured.usage, recorded } : {}),
    };
  }

  if (!result.ok && captured?.ok !== true) {
    return {
      ok: false,
      action: result.outcome === 'failed_launch' ? 'fail-closed' : (result.outcome || 'failed'),
      reason: result.reason,
    };
  }
  let recorded = false;
  if (captured?.usage) {
    try {
      recordCostFn(projectRoot, runId, {
        turns: captured.usage.num_turns || 0,
        tokens: captured.usage.tokens || 0,
        fence: { owner: childRunId, generation: parentGeneration + 1, intent: 'accounting' },
      });
      recorded = true;
    } catch (error) {
      if (!String(error?.message || error).startsWith('LEASE_FENCED')) throw error;
    }
  }
  return { ok: true, action: 'resumed', usage: captured?.usage, recorded };
}

export function driveHeadlessRun(options = {}) {
  const acquireHostLock = options.acquireHostLock ?? acquireHeadlessHostLock;
  const lock = acquireHostLock(options.root, options.runId, {
    timeoutMs: options.timeoutMs,
    wallNow: options.lockWallNow,
    processAlive: options.hostProcessAlive,
    pid: options.hostPid,
  });
  if (!lock) return { ok: true, action: 'already-driving' };
  try {
    return driveHeadlessRunLocked(options);
  } finally {
    lock.release();
  }
}

export function driveHeadless({
  root = findRoot(process.cwd()),
  driveRun = driveHeadlessRun,
  ...options
} = {}) {
  const currentPath = join(root, '.deep-loop', 'current');
  const runId = existsSync(currentPath) ? readFileSync(currentPath, 'utf8').trim() : null;
  if (!runId) return { ok: true, action: 'no-run' };
  return driveRun({ root, runId, ...options });
}
