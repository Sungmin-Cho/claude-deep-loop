import { readState, pauseRun } from '../lib/state.mjs';
import { recordCost } from '../lib/budget.mjs';
import { respawn } from '../lib/respawn.mjs';
import { headlessSpawn } from '../lib/spawn-driver.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function currentRunId(root) { const p = join(root, '.deep-loop', 'current'); return existsSync(p) ? readFileSync(p, 'utf8').trim() : null; }

// 무인 자동화 진입점: headlessSpawn 으로 claude -p 를 timeout + usage 측정 하에 구동.
// PreCompact 가 emit 한 handoff(phase=emitted|spawned, reserved child)를 재개(round-2 handshake).
// 측정불가/timeout/비0 종료 → fail-closed. 성공 시 **측정 usage 를 budget 에 권위있게 커밋**(spec §9 hard 강제).
// DEEP_LOOP_UNATTENDED=1 로 자식의 자기보고를 끄므로 driver 의 기록이 단일 출처(이중계상 없음).
// respawn() 경유로 respawnGate(budget/breaker/max_sessions/wallclock/auto_handoff) 와 emitted→spawned CAS 클레임 강제.
export function driveHeadless({ root = process.cwd(), spawnFn = headlessSpawn, now = Date.now(), timeoutMs } = {}) {
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

  // R5-plan gate: resume ONLY if the PERSISTED resume_policy is 'headless' (Task 10).
  // 'human' → preserve/needs-human must never be auto-headless.
  // 'visible' or null/undefined → a visible session's emitted handoff; the cron driver must not degrade it.
  const resumePolicy = lease.resume_policy;
  if (resumePolicy === 'human') return { ok: true, skipped: true, reason: 'human-resume-policy' };
  if (resumePolicy !== 'headless') return { ok: true, skipped: true, reason: 'not-headless-intended' };

  const childRunId = lease.handoff_child_run_id;
  const key = lease.handoff_idempotency_key;
  const cs = loop.session_chain.sessions.find(s => s.run_id === childRunId);
  const handoffRel = cs && cs.handoff_rel;

  // Usage capture: wrap spawnFn to capture the measured result; respawn discards it beyond ok.
  // entry shape: { bin, argv, cwd } — passed through to headlessSpawn (or mock in tests).
  let captured = null;
  const measuring = (entry) => {
    const r = spawnFn(entry);
    captured = r;
    return r;
  };

  // 정규 경로: respawn 이 respawnGate + emitted→spawned CAS 클레임 + 실패모드-B 롤백을 처리.
  const rr = respawn(root, runId, { childRunId, key, handoffRel, headless: true, now, spawnFn: measuring });

  if (rr.outcome === 'gate-blocked') {
    // respawn 이 이미 status=paused 로 기록함. 사람이 수동 resume 필요.
    return { ok: false, action: 'gate-blocked', reason: rr.reason };
  }
  if (rr.outcome === 'already-spawned') {
    // 멱등 — 이전 호출이 이미 클레임함; 비용 이중 기록 금지, captured 는 null.
    return { ok: true, action: 'already-spawned' };
  }
  if (!rr.ok) {
    // If the measured spawnFn itself failed (captured.ok===false), apply fail-closed pause regardless of
    // whether the child already acquired the lease (outcome='fenced') or rollback succeeded (outcome='failed_launch').
    // This ensures that a timed-out/unmeasurable resume that leaves child-owned committed state ACTIVE
    // does not silently continue — spec §9 headless fail-closed invariant.
    if (captured && captured.ok === false) {
      // spec §9: fail-closed regardless of lease ownership — must pause even if child took over.
      // Primary attempt uses initial lease (the "lease we hold"). If LEASE_FENCED (child already
      // acquired), re-read state: terminal → skip pause (fail-closed-terminal); non-terminal →
      // retry with fresh fence. Never unfenced. If retry also fenced/terminal: fail-closed-raced.
      try {
        pauseRun(root, runId, { reason: 'headless-unmeasurable', mode: 'preserve', expect: { owner: lease.owner_run_id, generation: lease.generation }, now });
      } catch (pauseErr) {
        const pauseMsg = String(pauseErr?.message || pauseErr);
        if (!pauseMsg.includes('LEASE_FENCED')) throw pauseErr;
        // LEASE_FENCED: child already acquired — re-read current state to detect terminal.
        const freshLoop = readState(root, runId).data;
        if (freshLoop.status === 'completed' || freshLoop.status === 'stopped') {
          // Terminal run: do NOT demote to paused; child ran to completion normally.
          return { ok: false, action: 'fail-closed-terminal', reason: (captured && captured.reason) || rr.reason };
        }
        // Non-terminal: pause with a FRESH fence (never unfenced) — spec §9 fail-closed + no unfenced demote.
        const freshLease = freshLoop.session_chain?.lease || {};
        try {
          pauseRun(root, runId, { reason: 'headless-unmeasurable', mode: 'preserve', expect: { owner: freshLease.owner_run_id, generation: freshLease.generation }, now });
        } catch (retryErr) {
          // LEASE_FENCED or RUN_TERMINAL on retry (concurrent change): swallow — do not loop.
          return { ok: false, action: 'fail-closed-raced', reason: (captured && captured.reason) || rr.reason };
        }
      }
      return { ok: false, action: 'fail-closed', reason: (captured && captured.reason) || rr.reason };
    }
    // respawn blocked before ever calling spawnFn (not-emitted, phase-error, key-mismatch, child-mismatch, fenced-pre-spawn, etc.)
    return { ok: false, action: rr.outcome || 'failed', reason: rr.reason };
  }

  // rr.ok && rr.outcome === 'spawned'
  // Acquisition proof: the child MUST have taken over the lease (owner_run_id moved away from parent) OR
  // the run reached terminal status. A claude -p that exits 0 without running /deep-loop-resume leaves the
  // lease in releasing/spawned (parent-owned) → silently stranded. Fail-closed when unconfirmed (spec §9).
  const freshLoop = readState(root, runId).data;
  const freshLease = freshLoop.session_chain?.lease || {};
  const isTerminal = freshLoop.status === 'completed' || freshLoop.status === 'stopped';
  // Lease moved forward = owner changed away from parent (child acquired, possibly re-emitted or grandchild took over).
  const leaseMovedForward = freshLease.owner_run_id !== runId;

  if (!leaseMovedForward && !isTerminal) {
    // Child did not acquire — fail-closed: pause with fresh fence (same pattern as unmeasurable branch).
    try {
      pauseRun(root, runId, { reason: 'headless-child-did-not-acquire', mode: 'preserve', expect: { owner: freshLease.owner_run_id, generation: freshLease.generation }, now });
    } catch (pauseErr) {
      const pauseMsg = String(pauseErr?.message || pauseErr);
      if (!pauseMsg.includes('LEASE_FENCED')) throw pauseErr;
      // LEASE_FENCED: state changed concurrently — re-read for terminal check.
      const freshLoop2 = readState(root, runId).data;
      if (freshLoop2.status === 'completed' || freshLoop2.status === 'stopped') {
        return { ok: false, action: 'fail-closed-terminal', reason: 'child-did-not-acquire' };
      }
      const freshLease2 = freshLoop2.session_chain?.lease || {};
      try {
        pauseRun(root, runId, { reason: 'headless-child-did-not-acquire', mode: 'preserve', expect: { owner: freshLease2.owner_run_id, generation: freshLease2.generation }, now });
      } catch (retryErr) {
        return { ok: false, action: 'fail-closed-raced', reason: 'child-did-not-acquire' };
      }
    }
    return { ok: false, action: 'resumed-unconfirmed', reason: 'child-did-not-acquire' };
  }

  // Acquisition confirmed — record cost with accounting fence.
  // accounting carve-out: intent='accounting' allows write even across owner change (leaseCheck spec §9.1).
  // 손자(grandchild)가 완전 인수(owner 또 바뀜) → LEASE_FENCED → swallow, recorded=false.
  const fence = { owner: freshLease.owner_run_id, generation: freshLease.generation, intent: 'accounting' };

  let recorded = false;
  try {
    if (captured && captured.usage) {
      recordCost(root, runId, { turns: captured.usage.num_turns || 0, tokens: captured.usage.tokens || 0, fence });
      recorded = true;
    }
  } catch (e) { if (!String(e.message).startsWith('LEASE_FENCED')) throw e; }

  return { ok: true, action: 'resumed', usage: captured && captured.usage, recorded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = driveHeadless({ root: process.cwd() });
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}
