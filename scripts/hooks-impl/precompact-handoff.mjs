import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundedText } from '../lib/bounded-input.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { findRoot, pauseRun } from '../lib/state.mjs';
import { readVerifiedState } from '../lib/integrity.mjs';
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
  let loop;
  try {
    loop = readVerifiedState(root, runId).data;
  } catch (caught) {
    return { ok: false, action: 'error',
      reason: String(caught?.message || caught) };
  }
  const lease = loop.session_chain?.lease || {};
  const expect = { owner: lease.owner_run_id, generation: lease.generation };
  const headless = resolveSpawnMode(loop, { headless: input.unattended === true, env }) === 'headless';
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
        mode: 'preserve', expect, now });
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
