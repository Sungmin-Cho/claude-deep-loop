import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState, writeState, withLock } from '../lib/state.mjs';
import { emitHandoff } from '../lib/handoff.mjs';
import { respawnGate } from '../lib/respawn.mjs';

/**
 * PreCompact emits a clean handoff only; measured fail-closed resumption is the cron `driveHeadless`
 * driver's job (spec §9). Gate-blocked unattended → status=paused (fail-closed).
 *
 * PreCompact is a within-session SAFETY NET: it writes the handoff artifact and updates the lease to
 * `releasing` so the measured cron driver (`driveHeadless`, which uses `headlessSpawn` with timeout
 * and usage accounting) can pick it up. PreCompact must NOT itself spawn an unmeasured child:
 * - sync spawn would block the hook (compaction delayed indefinitely on long runs)
 * - detached spawn can't measure turns/tokens → violates spec §9 fail-closed requirement
 */

function currentRunId(root) {
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

export async function runPreCompactHandoff(input = {}, { root = process.cwd(), now = Date.now() } = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };
  let loop;
  try { ({ data: loop } = readState(root, runId)); } catch (e) { return { ok: false, action: 'error', reason: String(e.message || e) }; }
  const lease = loop.session_chain?.lease || {};
  const expect = { owner: lease.owner_run_id, generation: lease.generation };
  const headless = input.unattended === true || loop.autonomy?.spawn_style === 'headless' || input.tty === false;
  const em = emitHandoff(root, runId, { reason: 'pre-compact', trigger: 'pre-compact', headless, expect });
  if (!em.ok) return { ok: false, action: 'fenced', reason: em.reason };

  if (headless && loop.autonomy?.auto_handoff) {
    // Gate check: if budget/breaker/wallclock/max_sessions blocks resumption, mark paused (fail-closed).
    // The measured cron driveHeadless will resume if/when the gate opens.
    const gate = respawnGate(loop, { now });
    if (!gate.ok) {
      // Fence-before-write: only set paused if the lease is still ours (mirroring respawn's fence-before-write).
      const parentOwner = expect.owner;
      const generation = expect.generation;
      let fenced = false;
      withLock(root, runId, () => {
        const { data } = readState(root, runId);
        const l = data.session_chain.lease;
        if (l.owner_run_id !== parentOwner || l.generation !== generation) { fenced = true; return; }
        data.status = 'paused';
        writeState(root, runId, data);
      });
      if (fenced) return { ok: false, action: 'fenced', reason: 'lease-changed-before-pause', childRunId: em.childRunId };
      return { ok: true, action: 'gate-blocked-paused', childRunId: em.childRunId };
    }
    // Gate open: handoff emitted with lease=releasing; measured cron driveHeadless will resume via round-2 handshake.
    return { ok: true, action: 'emitted', childRunId: em.childRunId };
  }
  return { ok: true, action: 'emitted', childRunId: em.childRunId };   // interactive → human uses terminal/launch-command.txt
}

// CLI 진입 — best-effort, 절대 compaction 차단 안 함.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let input = {};
    try {
      const chunks = []; for await (const c of process.stdin) chunks.push(c);
      if (chunks.length) input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { /* ignore */ }
    try { await runPreCompactHandoff(input, { root: input.cwd || process.cwd() }); } catch { /* swallow */ }
    process.exit(0);
  })();
}
