import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundedText } from '../lib/bounded-input.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { findRoot, pauseRun } from '../lib/state.mjs';
import { createPrecompactMutationIdentities, intentField, readKernelMutationAuthoritySnapshot,
  readLines, readVerifiedState, withVerifiedMutationLock } from '../lib/integrity.mjs';
import { emitHandoff } from '../lib/handoff.mjs';
import { respawnGate, resolveSpawnMode, rollbackAndPause } from '../lib/respawn.mjs';
import { deriveAppEmitAuthority } from '../lib/app-task-continuation.mjs';

/**
 * PreCompact emits a clean handoff only; measured fail-closed resumption is the cron `driveHeadless`
 * driver's job (spec §9). Gate-blocked unattended → status=paused (fail-closed).
 *
 * PreCompact is a within-session SAFETY NET: it writes the handoff artifact and updates the lease to
 * `releasing` so the measured cron driver (`driveHeadless`, whose shared host uses `headlessSpawn` with timeout
 * and usage accounting) can pick it up. PreCompact must NOT itself spawn an unmeasured child:
 * - sync spawn would block the hook (compaction delayed indefinitely on long runs)
 * - detached spawn can't measure turns/tokens → violates spec §9 fail-closed requirement
 */

function currentRunId(root) {
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

function precompactPostEmitFence(expect) {
  return current => {
    const lease = current.session_chain?.lease;
    if (lease?.owner_run_id !== expect.owner
        || lease?.generation !== expect.generation) {
      throw new Error('LEASE_FENCED: precompact-post-emit');
    }
  };
}

function exactRecoveredPrecompactResult(root, runId, loop, expect, headless) {
  const lease = loop.session_chain?.lease || {};
  const parent = loop.session_chain?.sessions?.find(session => session.run_id === expect.owner);
  if (loop.status === 'running' && lease.owner_run_id === expect.owner
      && lease.generation === expect.generation && lease.state === 'releasing'
      && lease.handoff_phase === 'emitted' && lease.resume_policy === 'app'
      && lease.handoff_transport === 'codex-app'
      && typeof lease.handoff_child_run_id === 'string') {
    return { ok: true, action: 'emitted', childRunId: lease.handoff_child_run_id, headless };
  }
  if (loop.status === 'paused' && loop.pause_reason === 'app-authority-unconfirmed'
      && lease.owner_run_id === expect.owner && lease.generation === expect.generation
      && lease.state === 'releasing' && lease.handoff_phase === 'emitted'
      && lease.resume_policy === 'human' && lease.handoff_transport == null
      && lease.handoff_attempt_id == null && typeof lease.handoff_child_run_id === 'string'
      && parent?.superseded_by === lease.handoff_child_run_id) {
    return { ok: true, action: 'app-authority-unconfirmed-paused',
      childRunId: lease.handoff_child_run_id, headless };
  }
  const last = readLines(root, runId).at(-1);
  if (loop.status === 'paused' && lease.owner_run_id === expect.owner
      && lease.generation === expect.generation && lease.state === 'active'
      && lease.handoff_phase === 'idle' && lease.handoff_child_run_id == null
      && last?.type === 'respawn-failed' && last.data?.trigger === 'pre-compact'
      && typeof last.data?.child_run_id === 'string'
      && loop.pause_reason === last.data.pause_reason) {
    return { ok: true, action: 'gate-blocked-paused',
      childRunId: last.data.child_run_id, headless };
  }
  return null;
}

export async function runPreCompactHandoff(input = {}, {
  root = findRoot(process.cwd()),
  now = Date.now(),
  env = process.env,
  rollbackFn = rollbackAndPause,
  emitFn = emitHandoff,
  gateFn = respawnGate,
  pauseFn = pauseRun,
  cwdFn = process.cwd,
  deriveAppAuthorityFn = deriveAppEmitAuthority,
} = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };
  let loop; let expect; let mutationIdentities;
  try {
    const authority = readKernelMutationAuthoritySnapshot(root, runId);
    loop = authority.data;
    expect = authority.callerBinding;
    const observedCwd = cwdFn();
    const requestDigest = intentField('precompact-handoff-request', {
      unattended: input.unattended === true, observedCwd,
      envHeadless: env?.DEEP_LOOP_HEADLESS ?? null,
      envUnattended: env?.DEEP_LOOP_UNATTENDED ?? null,
      claudeEntrypoint: env?.CLAUDE_CODE_ENTRYPOINT ?? null,
    });
    mutationIdentities = createPrecompactMutationIdentities(authority, requestDigest);
    if (authority.pending) {
      const pendingStage = Object.entries(mutationIdentities)
        .find(([, identity]) => identity.intentDigest === authority.pendingIntentDigest)?.[0];
      if (pendingStage === undefined) throw new Error('ANCHORED_TRANSACTION_PENDING');
      loop = withVerifiedMutationLock(root, runId, mutationIdentities[pendingStage], mutation =>
        mutation.readVerifiedState({ fenceCheck: precompactPostEmitFence(expect) }).data);
      const recoveredHeadless = resolveSpawnMode(loop,
        { headless: input.unattended === true, env }) === 'headless';
      const final = exactRecoveredPrecompactResult(
        root, runId, loop, expect, recoveredHeadless);
      if (final !== null) return final;
      if (pendingStage !== 'emit') throw new Error('PRECOMPACT_RECOVERY_PROJECTION_CHANGED');
    }
  } catch (caught) {
    return { ok: false, action: 'error',
      reason: String(caught?.message || caught) };
  }
  const headless = resolveSpawnMode(loop, { headless: input.unattended === true, env }) === 'headless';
  const recovered = exactRecoveredPrecompactResult(root, runId, loop, expect, headless);
  if (recovered !== null) return recovered;
  const ownerSession = loop.session_chain?.sessions?.find(session =>
    session.run_id === expect.owner);
  const appOrigin = loop.autonomy?.session_runtime === 'codex'
    && ownerSession?.host_surface?.kind === 'codex-app';
  let appIntent = false;
  if (appOrigin) {
    try {
      deriveAppAuthorityFn(loop, root, expect.owner, cwdFn());
      appIntent = true;
    } catch (caught) {
      if (!String(caught?.message || caught).startsWith('APP_EMIT_AUTHORITY_FENCED')) {
        throw caught;
      }
    }
  }
  const em = emitFn(root, runId, {
    reason: 'pre-compact',
    trigger: 'pre-compact',
    headless,
    expect,
    env,
    appIntent,
    cwdFn,
    now,
    nowFn: () => now,
    mutationIdentity: mutationIdentities.emit,
  });
  if (!em.ok) return { ok: false, action: 'fenced', reason: em.reason };

  if (appIntent) {
    return { ok: true, action: 'emitted',
      childRunId: em.childRunId, headless };
  }
  if (appOrigin) {
    if (em.appOriginFallback !== true) {
      throw new Error('APP_ORIGIN_FALLBACK_MISSING');
    }
    let fallback;
    try {
      fallback = readVerifiedState(root, runId, {
        fenceCheck: precompactPostEmitFence(expect),
      }).data;
    } catch (caught) {
      if (String(caught?.message || caught).startsWith('LEASE_FENCED:')) {
        return { ok: false, action: 'fenced',
          reason: 'lease-changed-after-precompact-emit',
          childRunId: em.childRunId, headless };
      }
      throw caught;
    }
    const fallbackLease = fallback.session_chain?.lease || {};
    const exactFallback = fallback.status === 'running'
      && fallbackLease.state === 'releasing'
      && fallbackLease.handoff_phase === 'emitted'
      && fallbackLease.handoff_child_run_id === em.childRunId
      && fallbackLease.resume_policy === 'human'
      && fallbackLease.handoff_transport == null
      && fallbackLease.handoff_attempt_id == null;
    if (!exactFallback) throw new Error('APP_ORIGIN_FALLBACK_INVALID');
    try {
      pauseFn(root, runId, { reason: 'app-authority-unconfirmed',
        mode: 'preserve', expect, now, mutationIdentity: mutationIdentities.pause });
    } catch (caught) {
      const message = String(caught?.message || caught);
      if (message.startsWith('RUN_TERMINAL')) {
        return { ok: false, action: 'terminal', reason: 'RUN_TERMINAL' };
      }
      if (message.startsWith('LEASE_FENCED')) {
        return { ok: false, action: 'fenced',
          reason: 'lease-changed-before-pause', childRunId: em.childRunId, headless };
      }
      throw caught;
    }
    return { ok: true, action: 'app-authority-unconfirmed-paused',
      childRunId: em.childRunId, headless };
  }

  let fresh;
  try {
    fresh = readVerifiedState(root, runId, {
      fenceCheck: precompactPostEmitFence(expect),
    }).data;
  } catch (caught) {
    if (String(caught?.message || caught).startsWith('LEASE_FENCED:')) {
      return { ok: false, action: 'fenced',
        reason: 'lease-changed-after-precompact-emit',
        childRunId: em.childRunId, headless };
    }
    throw caught;
  }
  if (headless && fresh.autonomy?.auto_handoff) {
    const gate = gateFn(fresh, { now });
    if (!gate.ok) {
      // R12-LL fix: gate-blocked must ROLLBACK (invalidate reserved child), not merely set status=paused.
      // A status-only pause leaves handoff_child_run_id intact, allowing a human to bypass the gate via
      // /deep-loop-resume → acquireLease(reserved child). Use rollbackAndPause (same as respawn's path):
      // child.outcome='failed_launch', superseded_by cleared, lease→active/idle, status='paused'.
      const res = rollbackFn(root, runId, {
        childRunId: em.childRunId, parentOwner: expect.owner, generation: expect.generation,
        eventData: { child_run_id: em.childRunId, gate: gate.reason, trigger: 'pre-compact' },
        pauseReason: `gate:${gate.reason}`,
        mutationIdentity: mutationIdentities.rollback,
      });
      if (res.terminal) return { ok: false, action: 'terminal', reason: 'RUN_TERMINAL' };
      if (res.fenced) return { ok: false, action: 'fenced', reason: 'lease-changed-before-pause', childRunId: em.childRunId, headless };
      return { ok: true, action: 'gate-blocked-paused', childRunId: em.childRunId, headless };
    }
  }
  return { ok: true, action: 'emitted',
    childRunId: em.childRunId, headless };
}

// CLI 진입 — best-effort, 절대 compaction 차단 안 함.
export async function main() {
  try {
    const raw = await readBoundedText(process.stdin);
    const input = raw.length === 0 ? {} : JSON.parse(raw);
    if (input === null || Array.isArray(input) || typeof input !== 'object') throw new Error('input-invalid');
    const cwd = input.cwd ?? process.cwd();
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('root-invalid');
    const response = await runPreCompactHandoff(input, { root: findRoot(cwd) });
    if (!response?.ok) throw new Error('driver-failed');
  } catch {
    process.stderr.write('deep-loop: precompact hook failed\n');
  }
}

const { isMain, diagnostic } = detectMain(import.meta.url, process.argv[1]);
if (diagnostic) {
  process.stderr.write(`${diagnostic}\n`);
} else if (isMain) {
  await main();
}
