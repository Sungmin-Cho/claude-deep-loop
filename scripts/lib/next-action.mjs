import { checkBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { computeDebt } from './comprehension.mjs';
import { makerReviewed, unsatisfiedReviewPoints } from './review.mjs';
import { finishProofState } from './finish.mjs';

function currentSessionTurns(loop) {
  const s = (loop.session_chain?.sessions || []).find(x => x.run_id === loop.session_chain?.lease?.owner_run_id);
  return s ? (s.turns || 0) : 0;
}

const A = (gate, action, next_command) => ({ gate, action, next_command });

// A rejected checker is GENUINELY SUPERSEDED — and thus must NOT re-trigger fix_episode — when either
//   (a) its target maker was re-reviewed and APPROVED (a bound approved checker shares its target_maker), or
//   (b) a LATER done maker exists for the same (workstream_id, point) than its target_maker (the flow moved on
//       to a newer maker, whose own review drives progress — ids are zero-padded so lexicographic `>` is order).
// NOTE: point-level review_points_done deliberately does NOT suppress a rejected checker — an earlier approval on
// the same point must not mask a LATER done maker that was genuinely rejected (else the fix flow never dispatches).
function supersededRejected(loop, e) {
  if (!e.target_maker) return false;   // unbound rejected checker has no maker to have been superseded for
  const eps = loop.episodes || [];
  // (a) the same target maker was re-reviewed and APPROVED (bound)
  if (eps.some(c => c.role === 'checker' && c.status === 'approved' && c.target_maker === e.target_maker)) return true;
  // (b) a strictly later done maker exists for the same (workstream_id, point)
  return eps.some(m => m.role === 'maker' && m.status === 'done'
    && m.workstream_id === e.workstream_id && m.point === e.point && m.id > e.target_maker);
}

// 현재 actionable episode 가 없을 때: 미완 maker/거부 checker/in-progress/미리뷰 done maker 를 우선 처리하고,
// 그 외엔 canonical finish 게이트(finishProofState)를 재사용 — finish 추천 ≡ finishRun 집행 (divergence 제거).
function finishOrAdvance(loop, gate, fanoutBlocked) {
  const eps = loop.episodes || [];
  const wsExists = (id) => !!id && (loop.workstreams || []).some(w => w.id === id);
  const pendingMaker = eps.find(e => e.role === 'maker' && e.status === 'pending');
  if (pendingMaker) {
    // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
    if (fanoutBlocked && pendingMaker.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: pendingMaker.id, reason: 'comprehension-debt' }, '/deep-loop-status');
    return A(gate, { type: 'dispatch_maker', episode_id: pendingMaker.id, point: pendingMaker.point, workstream_id: pendingMaker.workstream_id }, '/deep-loop-continue');
  }
  // Codex r3 🔴3: skip GENUINELY superseded rejected checkers (re-approved maker, or a later done maker for the
  // same (ws,point)) — but a later rejected maker on an already-done point still routes to fix (convergence fix).
  // Codex r2 (final fix 2): only BOUND rejected checkers (target_maker set) drive fix — an UNBOUND rejected
  // checker reviewed no specific maker, so it cannot anchor a "fix THIS maker" flow; its settlement is governed by
  // finishProofState/reviewSatisfied. Without this guard supersededRejected (which short-circuits false on unbound)
  // would route it to fix_episode forever, diverging from the finish gate (recommend ≠ enforce).
  const rejected = eps.find(e => e.role === 'checker' && e.status === 'rejected' && e.target_maker && !supersededRejected(loop, e));
  if (rejected) return A(gate, { type: 'fix_episode', episode_id: rejected.id, point: rejected.point, workstream_id: rejected.workstream_id }, '/deep-loop-continue');
  const inProg = eps.find(e => e.status === 'in_progress');
  if (inProg) return A(gate, { type: 'await_result', episode_id: inProg.id }, '/deep-loop-continue');
  // pending checker 는 actionable 이나 auto-dispatch (dispatch_checker = review dispatch) 가 중복 checker 를 만든다.
  // 사람에게 surface — driver 가 무한 dispatch loop 에 빠지지 않도록.
  const pendingChecker = eps.find(e => e.role === 'checker' && e.status === 'pending');
  if (pendingChecker) return A(gate, { type: 'await_human', episode_id: pendingChecker.id, reason: 'pending-checker-unresolved' }, '/deep-loop-status');
  // Codex r3 🔴4: 리뷰 안 된 done maker 가 있으면 finish 금지 → checker dispatch (리뷰 게이트 불변식).
  // Uses per-maker binding predicate (makerReviewed) so two checkers for maker1 cannot satisfy maker2.
  const unreviewed = eps.find(e => e.role === 'maker' && e.status === 'done' && !makerReviewed(loop, e));
  if (unreviewed) {
    // workstream 이 없는 done maker 는 checker 를 dispatch 해도 WORKSTREAM_NOT_FOUND 로 막힌다 (dead-end). 사람에게 surface.
    if (!wsExists(unreviewed.workstream_id)) return A(gate, { type: 'await_human', episode_id: unreviewed.id, reason: 'unbound-proof-episode' }, '/deep-loop-status');
    return A(gate, { type: 'dispatch_checker', episode_id: unreviewed.id, point: unreviewed.point, workstream_id: unreviewed.workstream_id }, '/deep-loop-continue');
  }
  // actionable 없음 → canonical finish 게이트 재사용 (추천 ≡ 집행: finishProofState 가 통과해야만 finish).
  const ps = finishProofState(loop);
  if (ps.missing.length === 0) return A(gate, { type: 'finish' }, '/deep-loop-finish');
  if (ps.missing.includes('review-point-unsatisfied')) return A(gate, { type: 'await_human', reason: `review-point-unsatisfied:${unsatisfiedReviewPoints(loop).join(',')}` }, '/deep-loop-status');
  if (ps.missing.includes('unbound-proof-episode')) return A(gate, { type: 'await_human', reason: 'unbound-proof-episode' }, '/deep-loop-status');
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
    if (ep.status === 'in_progress') return A(gate, { type: 'await_result', episode_id: ep.id }, '/deep-loop-continue');
    if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
    if (ep.status === 'done') {
      // dispatch_checker 는 workstream 이 있어야 가능 (review dispatch → WORKSTREAM_NOT_FOUND 방지). 없으면 사람에게 surface.
      if (!(loop.workstreams || []).some(w => w.id === ep.workstream_id)) return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'unbound-proof-episode' }, '/deep-loop-status');
      return A(gate, { type: 'dispatch_checker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    }
  }
  if (ep.role === 'checker') {
    // pending checker auto-dispatch 는 중복 checker 를 만든다 (dispatch_checker = review dispatch). 사람에게 surface.
    if (ep.status === 'pending') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'pending-checker-unresolved' }, '/deep-loop-status');
    if (ep.status === 'in_progress') return A(gate, { type: 'await_result', episode_id: ep.id }, '/deep-loop-continue');   // 재dispatch 금지 (Codex r2 🔴7)
    if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
    // Codex r1 🔴5 / final fix 2: same predicate as the finishOrAdvance scan — only a BOUND, non-superseded
    // rejected checker drives fix. An UNBOUND (or superseded) rejected checker reviewed no specific maker, so it
    // falls through to the finishProofState gate instead of routing to fix_episode forever (recommend ≡ enforce).
    // (current_episode points at the last-created episode, so a redundant re-review on an already-approved point
    // leaves an unbound rejected checker as current_episode — this path must not diverge from the finish gate.)
    if (ep.status === 'rejected' && ep.target_maker && !supersededRejected(loop, ep)) return A(gate, { type: 'fix_episode', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    if (ep.status === 'approved') return finishOrAdvance(loop, gate, debt.blocked);
  }
  return finishOrAdvance(loop, gate, debt.blocked);
}
