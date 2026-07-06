import { appendEvent, lastLogHead, readLines, recomputeSpent, verifyLog, verifyHead, validCost } from './integrity.mjs';
import { readState, writeState, withLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';

// #3: re-exported from integrity.mjs (the floor mechanism's home) so call sites/tests can import it from budget.mjs
// while state.mjs imports it directly from integrity.mjs (no state↔budget cycle).
export { MUTATION_TURN_FLOOR } from './integrity.mjs';

export function checkBudget(loop, { now = Date.now(), sessionStart, measurable = true } = {}) {
  const b = loop.budget;
  if (!measurable && b.enforcement !== 'best-effort-interactive' && b.on_unmeasurable_usage === 'fail-closed') {
    return { ok: false, reason: 'unmeasurable-usage-fail-closed', tier_after: loop.autonomy.tier };
  }
  // sessionStart 미지정 시 run의 created_at에서 파생 → 호출자가 빠뜨려도 wallclock이 0으로 무력화되지 않음 (Codex impl 🟡6)
  const start = sessionStart ?? (loop.created_at ? Date.parse(loop.created_at) : now);
  const wall = (now - start) / 1000;
  if (b.spent >= b.total * b.hard_stop_ratio) return { ok: false, reason: 'turns-hard-stop', tier_after: loop.autonomy.tier };
  if (b.tokens_total && b.tokens_spent >= b.tokens_total) return { ok: false, reason: 'tokens-hard-stop', tier_after: loop.autonomy.tier };
  if (b.max_wallclock_sec && wall >= b.max_wallclock_sec) return { ok: false, reason: 'wallclock-hard-stop', tier_after: loop.autonomy.tier };
  if (b.spent >= b.total * b.soft_stop_ratio) {
    const demoted = ['act-gated', 'act-reversible'].includes(loop.autonomy.tier) ? 'recommend' : loop.autonomy.tier;
    return { ok: true, reason: 'soft-stop-demote', tier_after: demoted };
  }
  return { ok: true, reason: 'ok', tier_after: loop.autonomy.tier };
}

// #3 max-rule: the auto-floor turns/tokens accrued since the last EXPLICIT cost event (i.e. the current "tick").
// An explicit `budget record` ABSORBS this floor rather than stacking on top of it — the tick's contribution is
// max(reported, floor-sum), not the sum. A non-floor (explicit) cost resets the running tick.
// impl-R1 Fix 1: scoped to a SINGLE session (owner+generation). Only floors tagged with THIS session are absorbable;
// a prior session's floors are confirmed consumption and are skipped (never swallowed by a later report). An
// explicit cost of the SAME session closes its tick.
function trailingFloor(lines, owner, generation) {
  let tf = 0, tk = 0;
  for (const e of lines) {
    if (e.type !== 'cost') continue;
    if (e.data?.owner !== owner || e.data?.generation !== generation) continue;   // different session → not ours to absorb
    if (e.data?.auto_floor) { tf += e.data.turns || 0; tk += e.data.tokens || 0; }
    else { tf = 0; tk = 0; }   // this session's explicit cost ends its tick
  }
  return { tf, tk };
}

// Explicit cost report — its own withLock (needs to read the log to absorb the tick's floor before appending an
// ADJUSTED cost). Mirrors appendAnchored's verify→append→anchor→reconcile sequence; recomputeSpent stays a PURE
// sum so reconcileBudget agrees automatically. Negative/non-finite still rejected (validCost).
export function recordCost(root, runId, { turns = 0, tokens = 0, fence } = {}) {
  if (!validCost({ turns, tokens })) throw new Error(`INVALID_COST: turns/tokens must be finite >= 0 (got ${turns}/${tokens})`);
  return withLock(root, runId, () => {
    const { data: loop } = readState(root, runId);
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    const v = verifyLog(root, runId); if (!v.ok) throw new Error(`LOG_TAMPERED: ${v.errors.join('; ')}`);
    const h = verifyHead(root, runId, loop.event_log_head); if (!h.ok) throw new Error(`LOG_TAMPERED: ${h.errors.join('; ')}`);
    const lease = loop.session_chain?.lease || {};
    const { tf, tk } = trailingFloor(readLines(root, runId), lease.owner_run_id, lease.generation);   // this session's tick floor only
    const adjTurns = Math.max(0, turns - tf), adjTokens = Math.max(0, tokens - tk);   // tick contribution = max(reported, floor-sum)
    appendEvent(root, runId, { type: 'cost', data: { turns: adjTurns, tokens: adjTokens, reported_turns: turns, reported_tokens: tokens, owner: lease.owner_run_id, generation: lease.generation } });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId);   // pure sum = prior + floors + adjusted = prior-session floors + max(reported, this-session floors)
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    // per_session_turn_cap 판정용 session.turns 도 max-rule을 따른다 — 이 tick 기여분 = tf(이미 floor로 반영) + adjTurns.
    const sess = (loop.session_chain?.sessions || []).find(s => s.run_id === lease.owner_run_id);
    if (sess) sess.turns = (sess.turns || 0) + adjTurns;
    writeState(root, runId, loop);
  });
}

// 저장된 budget vs event-log 재계산 비교 + log head 앵커 대조 — 불일치/손상/truncation 시 fail-stop
export function reconcileBudget(root, runId) {
  return withLock(root, runId, () => {
    const v = verifyLog(root, runId);
    if (!v.ok) throw new Error(`BUDGET_TAMPERED: event-log integrity: ${v.errors.join('; ')}`);
    const { data } = readState(root, runId);
    const h = verifyHead(root, runId, data.event_log_head);   // suffix truncation 탐지
    if (!h.ok) throw new Error(`BUDGET_TAMPERED: ${h.errors.join('; ')}`);
    const t = recomputeSpent(root, runId);
    if ((data.budget.spent || 0) !== t.turns || (data.budget.tokens_spent || 0) !== t.tokens) {
      throw new Error(`BUDGET_TAMPERED: stored ${data.budget.spent}/${data.budget.tokens_spent} != log ${t.turns}/${t.tokens}`);
    }
    return { turns: t.turns, tokens: t.tokens };
  });
}
