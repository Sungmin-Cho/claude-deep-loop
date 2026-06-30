import { readState } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { newEpisode } from './episode.mjs';
import { leaseCheck } from './lease.mjs';

// 연속 REQUEST_CHANGES 임계 (breaker.mjs THRESHOLD 미러 — fail-stop latch).
const BREAKER_THRESHOLD = 3;

// Hybrid episode-order comparator (shared — finish.mjs / next-action.mjs import it). Episode ids are
// `NNN-plugin` zero-padded to only 3 digits, so naive string `>` breaks at the 999→1000 boundary
// ('1000-x' < '999-x' lexicographically). When BOTH ids carry a numeric prefix, compare NUMERICALLY;
// otherwise fall back to string compare (preserves synthetic test ids like m1/m2/c1). "a is later than b"
// iff epOrder(a, b) > 0.
export const epOrder = (a, b) => {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};

export function resolveReviewer(loop, detected = {}) {
  const r = loop.review || {};
  let reviewer = r.reviewer || 'subagent-checker';
  if ((reviewer === 'deep-review-loop' || reviewer === 'deep-review') && !detected['deep-review']) {
    reviewer = detected['codex'] ? 'codex-cross' : 'subagent-checker';
  } else if (reviewer === 'subagent-checker' && detected['codex']) {
    reviewer = 'codex-cross';
  }
  return { reviewer, flags: r.flags || [], mode: r.mode || 'cross-model' };
}

export function parseVerdict(text) {
  if (text == null) return null;
  const s = String(text);
  try { const v = JSON.parse(s)?.verdict; if (['APPROVE', 'REQUEST_CHANGES', 'CONCERN'].includes(v)) return v; } catch { /* not json */ }
  if (/REQUEST_CHANGES/.test(s)) return 'REQUEST_CHANGES';
  if (/\bCONCERN\b/.test(s)) return 'CONCERN';
  if (/\b(?:do not|don't|not|never|cannot|can't)\s+approve\b/i.test(s)) return null;  // 부정문 오분류 방지 (Codex r4 ℹ️2)
  if (/\bAPPROVE\b/.test(s)) return 'APPROVE';
  return null;
}

// A maker is reviewed if there is a terminal checker bound to it (via target_maker) with approved/rejected status.
export function makerReviewed(loop, maker) {
  return (loop.episodes || []).some(e =>
    e.role === 'checker' && e.target_maker === maker.id &&
    (e.status === 'approved' || e.status === 'rejected')
  );
}

// checker episode 생성 + dispatch 디스크립터 반환 — 커널은 sibling을 호출하지 않음 (spec §1.1·§6).
export function dispatchReview(root, runId, { point, workstreamId, detected = {}, fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: dispatchReview');
  // Fix 3: validate point before any state read/write
  if (!point || typeof point !== 'string' || !point.length) throw new Error('REVIEW_INPUT_INVALID: point');
  const { data } = readState(root, runId);
  // Codex impl r14 🟡: validate the workstream EXISTS at dispatch time — otherwise the checker is bound to a phantom
  // workstream and recordReviewOutcome (which derives workstream_id from the checker) later fails WORKSTREAM_NOT_FOUND,
  // stranding a pending checker that can't converge. Fail early instead.
  if (!workstreamId || !data.workstreams.find(w => w.id === workstreamId)) throw new Error(`WORKSTREAM_NOT_FOUND: ${workstreamId}`);
  // Derive the target maker: the latest done maker for this (workstreamId, point) that does NOT already have a bound terminal checker.
  const eps = data.episodes || [];
  const eligibleMakers = eps.filter(e =>
    e.role === 'maker' && e.status === 'done' &&
    e.workstream_id === workstreamId && e.point === point &&
    !makerReviewed(data, e)
  );
  // Pick the latest episode via epOrder (hybrid numeric/string). Naive string `>` is WRONG here: ids are
  // zero-padded to only 3 digits, so '1000-x' < '999-x' lexicographically — at the 999→1000 boundary it
  // would mis-pick the target maker.
  const targetMakerEp = eligibleMakers.length > 0
    ? eligibleMakers.reduce((a, b) => (epOrder(a.id, b.id) > 0 ? a : b))
    : null;
  const targetMaker = targetMakerEp ? targetMakerEp.id : undefined;
  const { reviewer, flags, mode } = resolveReviewer(data, detected);
  const { id } = newEpisode(root, runId, { plugin: reviewer === 'deep-review-loop' ? 'deep-review' : reviewer, role: 'checker', kind: `${point}-review`, point, workstream: workstreamId, targetMaker, fence });
  const skillByReviewer = {
    'deep-review-loop': 'deep-review:deep-review-loop',
    'codex-cross': 'codex:rescue',
    'subagent-checker': 'Task(code-reviewer)',
    'standalone': 'inline-review',
  };
  const descriptor = { kind: reviewer === 'standalone' ? 'inline' : 'invoke_skill', skill: skillByReviewer[reviewer] || 'inline-review', args: flags.join(' '), mode, review_point: point, workstream: workstreamId };
  return { checkerEpisodeId: id, reviewer, descriptor };
}

export function recordReviewOutcome(root, runId, { episodeId, workstreamId, point, verdict, source = 'deep-review-approve', fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: recordReviewOutcome');
  // Codex impl r10 🔴: the ENTIRE review outcome (checker terminal + breaker + review_points_done + comprehension)
  // must be ONE atomic appendAnchored transaction. A multi-lock version could half-commit if a handoff sets the
  // lease to `releasing` between locks (checker terminalized, but breaker/review_points throw LEASE_FENCED, with
  // no repair path because the checker is now terminal). Single preCheck + single mutate = all-or-nothing.
  if (!['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(verdict)) throw new Error(`REVIEW_VERDICT_INVALID: ${verdict}`);
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  let result;
  appendAnchored(root, runId, { type: 'review-outcome', data: { episodeId, verdict } },
    (loop) => {
      // mutate — all in-memory on the single locked loop, written once (atomic)
      const tgt = loop.episodes.find(e => e.id === episodeId);
      const wsId = tgt.workstream_id;   // Codex r2 🔴: derive authoritatively from the checker episode
      const pt = tgt.point;
      tgt.status = passed ? 'approved' : 'rejected';   // checker terminal derived from verdict proof
      // breaker counter + fail-stop latch (mirrors breaker.recordReviewVerdict)
      const cb = loop.circuit_breaker || { consecutive_request_changes: 0 };
      if (verdict === 'REQUEST_CHANGES') {
        cb.consecutive_request_changes = (cb.consecutive_request_changes || 0) + 1;
        if (cb.consecutive_request_changes >= BREAKER_THRESHOLD && !cb.tripped) {
          cb.tripped = true; cb.trip_reason = 'consecutive-request-changes'; loop.status = 'paused';
        }
      } else {
        cb.consecutive_request_changes = 0;   // counter resets; tripped stays latched (human-reset only)
      }
      loop.circuit_breaker = cb;
      if (passed) {
        // FIX 1: only mark review_points_done when the passing checker is bound to a maker (unbound checkers reviewed no maker).
        const ws = loop.workstreams.find(w => w.id === wsId);
        if (ws && tgt.target_maker && !ws.review_points_done.includes(pt)) ws.review_points_done.push(pt);
        // FIX 3: comprehension — honor require_human_ack and only mark the bound maker.
        const requireHumanAck = loop.review?.require_human_ack === true;
        if (!requireHumanAck) {
          // Only the maker bound to this checker counts; unbound checker marks nothing.
          const target = loop.episodes.find(e => e.id === tgt.target_maker);
          if (target && target.role === 'maker' && !target.human_reviewed) {
            target.human_reviewed = true;
            loop.comprehension.episodes_human_reviewed = (loop.comprehension.episodes_human_reviewed || 0) + 1;
          }
        }
      }
      result = { verdict, passed, terminal: tgt.status };
    },
    (loop) => {
      // preCheck — runs on the fresh loop before the event append; throws here never stale the anchor
      if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
      const tgt = loop.episodes.find(e => e.id === episodeId);
      if (!tgt) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
      if (tgt.role !== 'checker') throw new Error('REVIEW_TARGET_NOT_CHECKER: ' + episodeId);
      const REVIEW_TERMINAL = ['done', 'approved', 'rejected', 'abandoned'];
      if (REVIEW_TERMINAL.includes(tgt.status)) throw new Error('REVIEW_ALREADY_RECORDED: ' + episodeId);
      if (!loop.workstreams.find(w => w.id === tgt.workstream_id)) throw new Error(`WORKSTREAM_NOT_FOUND: ${tgt.workstream_id}`);
    });
  // REQUEST_CHANGES → checker='rejected'. nextAction returns fix_episode and Execution creates the fix maker.
  return result;
}

// review.points = run-level 계약. 충족은 workstream review_points_done(bound approved checker가 채움)이 단일 출처.
export function unsatisfiedReviewPoints(loop) {
  const pts = loop.review?.points || [];
  const done = (loop.workstreams || []).flatMap(w => w.review_points_done || []);
  return pts.filter(p => !done.includes(p));
}
