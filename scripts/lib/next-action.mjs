import { checkBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { computeDebt } from './comprehension.mjs';
import { makerReviewed, unsatisfiedReviewPoints, rejectionResolved } from './review.mjs';
import { finishProofState } from './finish.mjs';

function currentSessionTurns(loop) {
  const s = (loop.session_chain?.sessions || []).find(x => x.run_id === loop.session_chain?.lease?.owner_run_id);
  return s ? (s.turns || 0) : 0;
}

const A = (gate, action, next_command) => ({ gate, action, next_command });

// Finish-path robustness (repro-009): a PROOF-IMPOSSIBLE ORPHAN maker — one whose expected_artifacts is an explicit
// empty array — can NEVER be recorded `done` (recordEpisode rejects empty expected_artifacts with
// EPISODE_TERMINAL_NO_PROOF). Dispatching it forever burns budget / spins autonomous runs; instead surface the
// human-gated `episode abandon --confirm` recovery via await_human. PRECISE: fires ONLY on an explicit empty array
// (how newEpisode stores an artifact-less maker), NOT on synthetic fixtures that omit the field (those still dispatch).
const isOrphanMaker = (ep) => Array.isArray(ep.expected_artifacts) && ep.expected_artifacts.length === 0;

// "Is this rejected checker resolved (superseded)?" is answered by the SINGLE unified predicate
// rejectionResolved (review.mjs) — the SAME predicate finish.mjs settledEp uses, so next-action routing and
// finishProofState can never disagree on a rejected checker. An UNRESOLVED rejected checker is routed by binding:
// BOUND (target_maker set) → fix_episode (re-make THIS maker); UNBOUND → await_human (no maker to fix; a human
// resolves it, e.g. `episode abandon --confirm`). A resolved rejected checker falls through to the finish gate.

// 현재 actionable episode 가 없을 때: 미완 maker/거부 checker/in-progress/미리뷰 done maker 를 우선 처리하고,
// 그 외엔 canonical finish 게이트(finishProofState)를 재사용 — finish 추천 ≡ finishRun 집행 (divergence 제거).
function finishOrAdvance(loop, gate, fanoutBlocked) {
  const eps = loop.episodes || [];
  const wsExists = (id) => !!id && (loop.workstreams || []).some(w => w.id === id);
  const pendingMaker = eps.find(e => e.role === 'maker' && e.status === 'pending');
  if (pendingMaker) {
    // Proof-impossible orphan (expected_artifacts === []) can NEVER reach `done` → route to the human-gated
    // `episode abandon --confirm` recovery instead of dispatching forever. BEFORE the debt check (an orphan can
    // never complete regardless of debt). Keeps next-action ↔ finishProofState consistent (orphan = unsettled).
    if (isOrphanMaker(pendingMaker)) return A(gate, { type: 'await_human', episode_id: pendingMaker.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
    // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
    if (fanoutBlocked && pendingMaker.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: pendingMaker.id, reason: 'comprehension-debt' }, '/deep-loop-status');
    return A(gate, { type: 'dispatch_maker', episode_id: pendingMaker.id, point: pendingMaker.point, workstream_id: pendingMaker.workstream_id }, '/deep-loop-continue');
  }
  // Unified: find ANY unresolved rejected checker (bound or unbound) via rejectionResolved — the SAME predicate
  // finishProofState.settledEp uses. A resolved one (re-approved newer / later done maker / newer same-point approval)
  // is skipped and falls through to the finish gate. BOUND → fix_episode (re-make THIS maker); UNBOUND → await_human
  // (no maker to anchor a fix; a human resolves it, e.g. `episode abandon --confirm`). This keeps next-action ↔
  // finishProofState consistent: an unresolved rejection blocks finish AND is surfaced here (never silently finished past).
  const rejected = eps.find(e => e.role === 'checker' && e.status === 'rejected' && !rejectionResolved(loop, e));
  if (rejected) {
    if (rejected.target_maker) return A(gate, { type: 'fix_episode', episode_id: rejected.id, point: rejected.point, workstream_id: rejected.workstream_id }, '/deep-loop-continue');
    return A(gate, { type: 'await_human', episode_id: rejected.id, reason: 'unbound-rejected-unresolved' }, '/deep-loop-status');
  }
  const inProg = eps.find(e => e.status === 'in_progress');
  if (inProg) {
    // P2-b: a proof-impossible orphan maker (expected_artifacts === []) cannot reach `done` even from in_progress
    // (recordEpisode('done') rejects empty expected_artifacts) → don't await_result forever; surface abandon recovery.
    if (inProg.role === 'maker' && isOrphanMaker(inProg)) return A(gate, { type: 'await_human', episode_id: inProg.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
    return A(gate, { type: 'await_result', episode_id: inProg.id }, '/deep-loop-continue');
  }
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
      // Proof-impossible orphan (expected_artifacts === []) can NEVER reach `done` → human-gated abandon recovery.
      // BEFORE the debt check (an orphan can never complete regardless of debt). See finishOrAdvance for rationale.
      if (isOrphanMaker(ep)) return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
      // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
      if (debt.blocked && ep.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'comprehension-debt' }, '/deep-loop-status');
      return A(gate, { type: 'dispatch_maker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    }
    if (ep.status === 'in_progress') {
      // P2-b: same orphan routing as finishOrAdvance — an in_progress orphan maker can never reach `done`, so surface
      // the human-gated abandon recovery instead of awaiting a result that can never validate.
      if (isOrphanMaker(ep)) return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'orphan-maker-no-artifacts' }, '/deep-loop-status');
      return A(gate, { type: 'await_result', episode_id: ep.id }, '/deep-loop-continue');
    }
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
    // Same unified predicate as the finishOrAdvance scan (recommend ≡ enforce). An UNRESOLVED rejected checker:
    // BOUND → fix_episode (re-make THIS maker); UNBOUND → await_human (no maker to fix; human resolves). A RESOLVED
    // rejected checker (re-approved newer / later done maker / newer same-point approval) falls through to the finish
    // gate — current_episode points at the last-created episode, so a redundant re-review on an already-approved point
    // can leave a (resolved) rejected checker as current_episode; this path must not diverge from finishProofState.
    if (ep.status === 'rejected' && !rejectionResolved(loop, ep)) {
      if (ep.target_maker) return A(gate, { type: 'fix_episode', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
      return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'unbound-rejected-unresolved' }, '/deep-loop-status');
    }
    if (ep.status === 'approved') return finishOrAdvance(loop, gate, debt.blocked);
  }
  return finishOrAdvance(loop, gate, debt.blocked);
}
