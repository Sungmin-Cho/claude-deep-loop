import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundedText } from '../lib/bounded-input.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { readState, findRoot } from '../lib/state.mjs';
import { emitHandoff } from '../lib/handoff.mjs';
import { respawnGate, resolveSpawnMode, rollbackAndPause } from '../lib/respawn.mjs';

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

export async function runPreCompactHandoff(input = {}, {
  root = findRoot(process.cwd()),
  now = Date.now(),
  env = process.env,
  rollbackFn = rollbackAndPause,
} = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };
  let loop;
  try { ({ data: loop } = readState(root, runId)); } catch (e) { return { ok: false, action: 'error', reason: String(e.message || e) }; }
  const lease = loop.session_chain?.lease || {};
  const expect = { owner: lease.owner_run_id, generation: lease.generation };
  const headless = resolveSpawnMode(loop, { headless: input.unattended === true, env }) === 'headless';
  const em = emitHandoff(root, runId, { reason: 'pre-compact', trigger: 'pre-compact', headless, expect, env });
  if (!em.ok) return { ok: false, action: 'fenced', reason: em.reason };

  if (headless && loop.autonomy?.auto_handoff) {
    // Gate check on POST-emit state (Fix 2): emitHandoff appended the reserved child session so
    // sessions.length grew — respawnGate must see the fresh state or max_sessions is off-by-one.
    const fresh = readState(root, runId).data;
    const gate = respawnGate(fresh, { now });
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
    // Gate open: handoff emitted with lease=releasing; measured cron driveHeadless will resume via round-2 handshake.
    return { ok: true, action: 'emitted', childRunId: em.childRunId, headless };
  }
  return { ok: true, action: 'emitted', childRunId: em.childRunId, headless };   // interactive → human uses terminal/launch-command.txt
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
