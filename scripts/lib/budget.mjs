import { appendEvent, recomputeSpent, verifyLog } from './integrity.mjs';
import { readState, writeState, withLock } from './state.mjs';

export function checkBudget(loop, { now = Date.now(), sessionStart = now, measurable = true } = {}) {
  const b = loop.budget;
  if (!measurable && b.enforcement !== 'best-effort-interactive' && b.on_unmeasurable_usage === 'fail-closed') {
    return { ok: false, reason: 'unmeasurable-usage-fail-closed', tier_after: loop.autonomy.tier };
  }
  const wall = (now - sessionStart) / 1000;
  if (b.spent >= b.total * b.hard_stop_ratio) return { ok: false, reason: 'turns-hard-stop', tier_after: loop.autonomy.tier };
  if (b.tokens_total && b.tokens_spent >= b.tokens_total) return { ok: false, reason: 'tokens-hard-stop', tier_after: loop.autonomy.tier };
  if (b.max_wallclock_sec && wall >= b.max_wallclock_sec) return { ok: false, reason: 'wallclock-hard-stop', tier_after: loop.autonomy.tier };
  if (b.spent >= b.total * b.soft_stop_ratio) {
    const demoted = ['act-gated', 'act-reversible'].includes(loop.autonomy.tier) ? 'recommend' : loop.autonomy.tier;
    return { ok: true, reason: 'soft-stop-demote', tier_after: demoted };
  }
  return { ok: true, reason: 'ok', tier_after: loop.autonomy.tier };
}

// cost 이벤트 기록 + 커널 파생 spent를 loop.json에 동기화 (append/recompute/write를 단일 lock 안에서)
export function recordCost(root, runId, { turns = 0, tokens = 0 }) {
  return withLock(root, runId, () => {
    appendEvent(root, runId, { type: 'cost', data: { turns, tokens } });
    const { data } = readState(root, runId);
    const t = recomputeSpent(root, runId);
    data.budget.spent = t.turns;
    data.budget.tokens_spent = t.tokens;
    writeState(root, runId, data);
  });
}

// 저장된 budget vs event-log 재계산 비교 — 불일치/로그손상 시 fail-stop (lock 안에서 일관 관측)
export function reconcileBudget(root, runId) {
  return withLock(root, runId, () => {
    const v = verifyLog(root, runId);
    if (!v.ok) throw new Error(`BUDGET_TAMPERED: event-log integrity: ${v.errors.join('; ')}`);
    const { data } = readState(root, runId);
    const t = recomputeSpent(root, runId);
    if ((data.budget.spent || 0) !== t.turns || (data.budget.tokens_spent || 0) !== t.tokens) {
      throw new Error(`BUDGET_TAMPERED: stored ${data.budget.spent}/${data.budget.tokens_spent} != log ${t.turns}/${t.tokens}`);
    }
    return { turns: t.turns, tokens: t.tokens };
  });
}
