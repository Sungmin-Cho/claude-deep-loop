import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState } from '../lib/state.mjs';
import { emitHandoff } from '../lib/handoff.mjs';
import { respawn } from '../lib/respawn.mjs';
import { headlessSpawn } from '../lib/spawn-driver.mjs';

function currentRunId(root) {
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

export async function runPreCompactHandoff(input = {}, { root = process.cwd(), spawnFn = headlessSpawn, now = Date.now() } = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };
  let loop;
  try { ({ data: loop } = readState(root, runId)); } catch (e) { return { ok: false, action: 'error', reason: String(e.message || e) }; }
  const lease = loop.session_chain?.lease || {};
  const expect = { owner: lease.owner_run_id, generation: lease.generation };
  const headless = input.unattended === true || loop.autonomy?.spawn_style === 'headless' || input.tty === false;
  const em = emitHandoff(root, runId, { reason: 'pre-compact', trigger: 'pre-compact', headless, expect });
  if (!em.ok) return { ok: false, action: 'fenced', reason: em.reason };
  // Codex r1 should-fix-3: 외부에서 게이트를 선검사하지 않는다. headless && auto_handoff 면 **항상** respawn 을 호출해
  // respawn 내부의 canonical 실패모드 A 경로(gate 차단 시 status=paused 기록)를 타게 한다. 선검사하면 budget/wallclock
  // 소진된 headless PreCompact 가 releasing handoff 만 남기고 paused 를 못 박는다(spec §9.1).
  if (headless && loop.autonomy?.auto_handoff) {
    const rr = respawn(root, runId, { childRunId: em.childRunId, key: em.key, handoffRel: em.handoffRel, headless: true, now, spawnFn });
    const action = rr.ok ? 'respawned' : (rr.outcome === 'gate-blocked' ? 'gate-blocked' : 'respawn-failed');
    return { ok: rr.ok, action, childRunId: em.childRunId, outcome: rr.outcome };
  }
  return { ok: true, action: 'emitted', childRunId: em.childRunId };   // interactive → 사람 수동 resume
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
