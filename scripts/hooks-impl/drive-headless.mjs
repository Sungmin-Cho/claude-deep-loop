import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState } from '../lib/state.mjs';
import { recordCost } from '../lib/budget.mjs';
import { headlessSpawn } from '../lib/spawn-driver.mjs';

function currentRunId(root) { const p = join(root, '.deep-loop', 'current'); return existsSync(p) ? readFileSync(p, 'utf8').trim() : null; }

// 무인 자동화 진입점: headlessSpawn 으로 claude -p 를 timeout + usage 측정 하에 구동.
// 측정불가/timeout/비0 종료 → fail-closed. 성공 시 **측정 usage 를 budget 에 권위있게 커밋**(spec §9 hard 강제).
// DEEP_LOOP_UNATTENDED=1 로 자식의 자기보고를 끄므로 driver 의 기록이 단일 출처(이중계상 없음, Codex r5 critical-2).
export function driveHeadless({ root = process.cwd(), prompt = '/deep-loop-continue', spawnFn = headlessSpawn, timeoutMs } = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };
  // Codex r7 sf-2: fence 를 spawn **이전에** 캡처. 자식이 generation+1 로 lease 를 인수했으면 stale 부모는
  // generation/owner mismatch 로 펜싱돼 recordCost 가 LEASE_FENCED → skip(자식이 자기 회계를 가짐). post-spawn lease 를
  // 쓰면 자식 신원으로 잘못 기록되므로 금지.
  const pre = readState(root, runId).data.session_chain?.lease || {};
  const fence = { owner: pre.owner_run_id, generation: pre.generation, intent: 'accounting' };
  // Codex r6 sf-4: --output-format json 으로 num_turns/usage 를 stdout 에 내보내야 headlessSpawn 이 측정 가능.
  const cmd = `cd ${root} && DEEP_LOOP_UNATTENDED=1 claude -p "${prompt}" --output-format json --permission-mode acceptEdits`;
  const res = spawnFn(cmd, timeoutMs ? { timeoutMs } : {});
  if (!res.ok) return { ok: false, action: 'fail-closed', reason: res.reason };
  // 측정 usage 를 캡처한 fence(intent:'accounting')로 커밋 — releasing(같은 owner/gen)은 허용, generation 변경은 거부.
  let recorded = false;
  try {
    recordCost(root, runId, { turns: res.usage?.num_turns || 0, tokens: res.usage?.tokens || 0, fence });
    recorded = true;
  } catch (e) { if (!String(e.message).startsWith('LEASE_FENCED')) throw e; }
  return { ok: true, action: 'drove', usage: res.usage, recorded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = driveHeadless({ root: process.cwd() });
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}
