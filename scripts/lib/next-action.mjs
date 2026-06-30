import { checkBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { computeDebt } from './comprehension.mjs';
import { makerReviewed } from './review.mjs';

function currentSessionTurns(loop) {
  const s = (loop.session_chain?.sessions || []).find(x => x.run_id === loop.session_chain?.lease?.owner_run_id);
  return s ? (s.turns || 0) : 0;
}

const A = (gate, action, next_command) => ({ gate, action, next_command });

// point-level review satisfaction — used for checker convergence (superseded rejected checker skipping).
function reviewSatisfied(loop, ep) {
  const ws = (loop.workstreams || []).find(w => w.id === ep.workstream_id);
  if (ws && (ws.review_points_done || []).includes(ep.point)) return true;
  // Fix 3: only a BOUND (target_maker set) approved checker satisfies a review point — unbound approvals do not.
  return (loop.episodes || []).some(e => e.role === 'checker' && e.status === 'approved' && e.target_maker && e.workstream_id === ep.workstream_id && e.point === ep.point);
}

// 현재 actionable episode 가 없을 때: 미완 maker/거부 checker/in-progress/미리뷰 done maker 를 우선 처리하고, 전부 정리됐을 때만 finish.
function finishOrAdvance(loop, gate, fanoutBlocked) {
  const eps = loop.episodes || [];
  const pendingMaker = eps.find(e => e.role === 'maker' && e.status === 'pending');
  if (pendingMaker) {
    // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
    if (fanoutBlocked && pendingMaker.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: pendingMaker.id, reason: 'comprehension-debt' }, '/deep-loop-status');
    return A(gate, { type: 'dispatch_maker', episode_id: pendingMaker.id, point: pendingMaker.point, workstream_id: pendingMaker.workstream_id }, '/deep-loop-continue');
  }
  // Codex r3 🔴3: skip superseded rejected checkers whose point is already review-satisfied (convergence fix).
  const rejected = eps.find(e => e.role === 'checker' && e.status === 'rejected' && !reviewSatisfied(loop, e));
  if (rejected) return A(gate, { type: 'fix_episode', episode_id: rejected.id, point: rejected.point, workstream_id: rejected.workstream_id }, '/deep-loop-continue');
  const inProg = eps.find(e => e.status === 'in_progress');
  if (inProg) return A(gate, { type: 'await_result', episode_id: inProg.id, workstream_id: inProg.workstream_id }, '/deep-loop-continue');
  // Codex r3 🔴4: 리뷰 안 된 done maker 가 있으면 finish 금지 → checker dispatch (리뷰 게이트 불변식).
  // Uses per-maker binding predicate (makerReviewed) so two checkers for maker1 cannot satisfy maker2.
  const unreviewed = eps.find(e => e.role === 'maker' && e.status === 'done' && !makerReviewed(loop, e));
  if (unreviewed) return A(gate, { type: 'dispatch_checker', episode_id: unreviewed.id, point: unreviewed.point, workstream_id: unreviewed.workstream_id }, '/deep-loop-continue');
  // finish 는 active workstream 0 + 모든 episode 가 settled 일 때만 (Codex r2 🔴7 / r3 🔴4 / r5 🟡2)
  // settled: done/approved, OR 리뷰-충족된 rejected checker (나중 승인으로 포인트가 통과된 경우).
  const settled = (e) => ['done', 'approved'].includes(e.status) || (e.role === 'checker' && e.status === 'rejected' && reviewSatisfied(loop, e));
  const noActiveWs = (loop.active_workstreams || []).length === 0;
  const allSettled = eps.length > 0 && eps.every(settled);
  if (noActiveWs && allSettled) return A(gate, { type: 'finish' }, '/deep-loop-finish');
  return A(gate, { type: 'await_human', reason: 'active-work-remains' }, '/deep-loop-status');
}

export function nextAction(loop, { now = Date.now() } = {}) {
  const b = checkBudget(loop, { now });
  const br = checkBreaker(loop);
  const debt = computeDebt(loop);

  // budget hard-stop / breaker 는 모든 행동을 막는 전역 게이트.
  if (!b.ok) return A({ allowed: false, blocked_by: ['budget'], reason: b.reason, tier_after: b.tier_after }, { type: 'handoff', reason: 'budget' }, '/deep-loop-handoff');
  if (br.tripped) return A({ allowed: false, blocked_by: ['breaker'], reason: br.reason, tier_after: b.tier_after }, { type: 'await_human', reason: 'breaker' }, '/deep-loop-status');

  // comprehension-debt 는 **새 fan-out(discover)만** 막는다 — 현재 episode 진행/fix/리뷰/handoff/finish 는 허용 (spec §15, Codex r2 🔴4).
  const gate = { allowed: true, blocked_by: debt.blocked ? ['comprehension-debt'] : [], reason: b.reason, tier_after: b.tier_after };

  // 마일스톤: per_session_turn_cap 도달 → 선제 handoff
  const cap = loop.budget?.per_session_turn_cap;
  if (cap && currentSessionTurns(loop) >= cap) return A(gate, { type: 'handoff', reason: 'per_session_turn_cap' }, '/deep-loop-handoff');

  const ep = (loop.episodes || []).find(e => e.id === loop.current_episode);
  if (!ep) {
    if (!loop.episodes || loop.episodes.length === 0) {
      if (debt.blocked) return A(gate, { type: 'await_human', reason: 'comprehension-debt' }, '/deep-loop-status');  // discover=fan-out → debt 면 사람 검토 먼저
      return A(gate, { type: 'discover' }, '/deep-loop-discover');
    }
    return finishOrAdvance(loop, gate, debt.blocked);
  }
  if (ep.role === 'maker') {
    if (ep.status === 'pending') {
      // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
      if (debt.blocked && ep.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'comprehension-debt' }, '/deep-loop-status');
      return A(gate, { type: 'dispatch_maker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    }
    if (ep.status === 'in_progress') return A(gate, { type: 'await_result', episode_id: ep.id, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
    if (ep.status === 'done') return A(gate, { type: 'dispatch_checker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
  }
  if (ep.role === 'checker') {
    if (ep.status === 'pending') return A(gate, { type: 'dispatch_checker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    if (ep.status === 'in_progress') return A(gate, { type: 'await_result', episode_id: ep.id, workstream_id: ep.workstream_id }, '/deep-loop-continue');   // 재dispatch 금지 (Codex r2 🔴7)
    if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
    if (ep.status === 'rejected') return A(gate, { type: 'fix_episode', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');  // Codex r1 🔴5
    if (ep.status === 'approved') return finishOrAdvance(loop, gate, debt.blocked);
  }
  return finishOrAdvance(loop, gate, debt.blocked);
}
