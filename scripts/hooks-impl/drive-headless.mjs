import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState } from '../lib/state.mjs';
import { recordCost } from '../lib/budget.mjs';
import { headlessSpawn } from '../lib/spawn-driver.mjs';
import { buildLaunchCommand } from '../lib/handoff.mjs';

function currentRunId(root) { const p = join(root, '.deep-loop', 'current'); return existsSync(p) ? readFileSync(p, 'utf8').trim() : null; }

// 무인 자동화 진입점: headlessSpawn 으로 claude -p 를 timeout + usage 측정 하에 구동.
// PreCompact 가 emit 한 handoff(phase=emitted|spawned, reserved child)를 재개(round-2 handshake).
// 측정불가/timeout/비0 종료 → fail-closed. 성공 시 **측정 usage 를 budget 에 권위있게 커밋**(spec §9 hard 강제).
// DEEP_LOOP_UNATTENDED=1 로 자식의 자기보고를 끄므로 driver 의 기록이 단일 출처(이중계상 없음).
export function driveHeadless({ root = process.cwd(), spawnFn = headlessSpawn, timeoutMs } = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };

  const { data: loop } = readState(root, runId);
  const lease = loop.session_chain?.lease || {};

  // 대기 중인 handoff(emitted 또는 spawned) + reserved child 가 있을 때만 resume.
  const pendingHandoff = (lease.handoff_phase === 'emitted' || lease.handoff_phase === 'spawned') && lease.handoff_child_run_id;
  if (!pendingHandoff) {
    // active/idle: cron 은 emitted handoff 만 resume 가능; 직접 구동 중인 run 은 건드리지 않음.
    return { ok: true, action: 'no-pending-handoff' };
  }

  const childRunId = lease.handoff_child_run_id;
  const cs = loop.session_chain.sessions.find(s => s.run_id === childRunId);
  const handoffRel = cs && cs.handoff_rel;

  // 측정 resume 명령 — buildLaunchCommand 의 headless 변형: claude -p "<resume prompt>" --output-format json --permission-mode acceptEdits
  const cmd = buildLaunchCommand({ root, parentRunId: runId, childRunId, handoffRel, headless: true }).headless;

  const res = spawnFn(cmd, timeoutMs ? { timeoutMs } : {});
  if (!res.ok) return { ok: false, action: 'fail-closed', reason: res.reason };

  // POST-resume 소유자로 lease 를 신선하게 재읽어 fence 구성.
  // 성공한 /deep-loop-resume 은 reserved child lease 를 인수(generation+1)했거나, 추가 handoff → releasing.
  // accounting carve-out: releasing 상태에서도 intent='accounting' 이면 허용 (leaseCheck spec §9.1).
  // 자식이 추가 handoff 없이 정상 완료 → lease 는 여전히 releasing(부모 owner/gen) → recorded=true.
  // 손자(grandchild)가 완전 인수(generation 또 올라감) → LEASE_FENCED → swallow, recorded=false.
  const freshLease = readState(root, runId).data.session_chain?.lease || {};
  const fence = { owner: freshLease.owner_run_id, generation: freshLease.generation, intent: 'accounting' };

  let recorded = false;
  try {
    recordCost(root, runId, { turns: res.usage?.num_turns || 0, tokens: res.usage?.tokens || 0, fence });
    recorded = true;
  } catch (e) { if (!String(e.message).startsWith('LEASE_FENCED')) throw e; }

  return { ok: true, action: 'resumed', usage: res.usage, recorded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = driveHeadless({ root: process.cwd() });
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}
