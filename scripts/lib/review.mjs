import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { readState } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { newEpisode } from './episode.mjs';
import { leaseCheck } from './lease.mjs';
import { pluginPresent } from './detect.mjs';
import { containedRealFile } from './fs-safe.mjs';
import { contentHash } from './envelope.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';

// impl-R2 Fix 4: a passing verdict's report must be BOUND to the reviewed workstream — its realpath must sit under
// the workstream's worktree directory. This stops an unrelated stale file (README.md, another ws's report) from
// being reused as fake evidence. `realReport` is already a realpath (via containedRealFile); worktree is realpath'd
// too so a symlinked worktree can't be spoofed.
function reportBoundToWorktree(root, realReport, worktreeRel) {
  if (!realReport || typeof worktreeRel !== 'string' || !worktreeRel.length) return false;
  let wt;
  try { wt = realpathSync(resolve(root, worktreeRel)); } catch { return false; }
  return realReport === wt || realReport.startsWith(wt + sep);
}

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

// UNIFIED rejected-checker resolution predicate — the SINGLE source of truth for
// "is this rejected checker RESOLVED (superseded)?", shared by next-action.mjs (routing)
// AND finish.mjs (settledEp). Before this, the two files answered the question differently
// (next-action: order-aware but ignored UNBOUND rejections; finish: review_points_done/any-approval,
// not order-aware) → a NEWER unbound REQUEST_CHANGES after an approved point could be silently
// finished past (next-action ignored it AND finish settled it). One predicate closes the whole class.
// Order is computed with epOrder (numeric-prefix compare, not string) so the 999→1000 boundary is correct.
//   bound (target_maker set): resolved iff the SAME target maker was re-reviewed and APPROVED by a checker
//     NEWER than this rejection (an OLDER approve followed by a NEWER reject must NOT count), OR a strictly
//     LATER done maker exists for the same (workstream_id, point) (the flow moved on to a newer maker).
//   unbound (no target_maker): ALWAYS resolved (neutral). Such a checker reviewed no maker, so a rejection on it is
//     meaningless — it must neither block finish nor route to action. dispatchReview no longer creates unbound
//     checkers (REVIEW_NO_ELIGIBLE_MAKER), so this branch only settles LEGACY unbound rejected checkers in old
//     loop.json — treating them as neutral avoids BOTH silent-completion (never silently masked by an unrelated
//     approval) AND strand (a terminal unbound checker can neither be abandoned nor re-recorded).
export function rejectionResolved(loop, e) {
  const eps = loop.episodes || [];
  if (e.target_maker) {
    const reApprovedNewer = eps.some(c => c.role === 'checker' && c.target_maker === e.target_maker && c.status === 'approved' && epOrder(c.id, e.id) > 0);
    const laterDoneMaker = eps.some(m => m.role === 'maker' && m.status === 'done' && m.workstream_id === e.workstream_id && m.point === e.point && epOrder(m.id, e.target_maker) > 0);
    return reApprovedNewer || laterDoneMaker;
  }
  return true;   // unbound → neutral (see comment above)
}

export function resolveReviewer(loop, detected = {}) {
  const r = loop.review || {};
  let reviewer = r.reviewer || 'subagent-checker';
  if ((reviewer === 'deep-review-loop' || reviewer === 'deep-review') && !pluginPresent(detected, 'deep-review')) {
    reviewer = pluginPresent(detected, 'codex') ? 'codex-cross' : 'subagent-checker';
  } else if (reviewer === 'subagent-checker' && pluginPresent(detected, 'codex')) {
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
  // ROOT FIX: a review MUST bind to a real done maker. With no eligible done maker the checker would be UNBOUND
  // ("reviewed no maker") — a degenerate state that either silently completes (if its REQUEST_CHANGES is ignored)
  // or strands the run (a terminal unbound checker can't be abandoned or re-recorded). Refuse to create it at the
  // source, so every checker is ALWAYS bound going forward. (preCheck — thrown before newEpisode: no episode created.)
  if (!targetMakerEp) throw new Error('REVIEW_NO_ELIGIBLE_MAKER: no done maker to review for ' + point + '/' + workstreamId);
  const targetMaker = targetMakerEp.id;
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

export function recordReviewOutcome(root, runId, { episodeId, workstreamId, point, verdict, source = 'deep-review-approve', proof = {}, fence } = {}) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: recordReviewOutcome');
  // Codex impl r10 🔴: the ENTIRE review outcome (checker terminal + breaker + review_points_done + comprehension)
  // must be ONE atomic appendAnchored transaction. A multi-lock version could half-commit if a handoff sets the
  // lease to `releasing` between locks (checker terminalized, but breaker/review_points throw LEASE_FENCED, with
  // no repair path because the checker is now terminal). Single preCheck + single mutate = all-or-nothing.
  if (!['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(verdict)) throw new Error(`REVIEW_VERDICT_INVALID: ${verdict}`);
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  // #2: a passing verdict (APPROVE/CONCERN) must be backed by a REAL review-report artifact contained under the
  // project root — symmetric with the maker's done-needs-existing-artifacts contract (episode.mjs). realpath
  // containment (fs-safe) blocks a root-relative symlink escaping the project. The report's content hash is
  // recorded in the event so a completed run's "independent review passed" claim is auditable + tamper-evident.
  // Inline `findings` is only auxiliary metadata (forgeable) — it can never stand in for the report. REQUEST_CHANGES
  // stays lightweight (reject reason only; only the passing path opens finish proof).
  const realReport = passed ? containedRealFile(resolve(root), proof.report) : null;
  const reportHash = realReport ? contentHash(readFileSync(realReport, 'utf8')) : null;
  const findings = (proof.findings != null && String(proof.findings).length) ? String(proof.findings).slice(0, 2000) : null;
  let result;
  appendAnchored(root, runId, { type: 'review-outcome', data: { episodeId, verdict,
      ...(realReport ? { report: proof.report, report_sha256: reportHash } : {}),
      ...(findings ? { findings } : {}) } },
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
        // FIX(#1): a machine review (checker APPROVE/CONCERN) accrues to the AGENT comprehension counter only —
        // it must NEVER mark the maker human_reviewed nor lower comprehension debt (computeDebt reads only
        // episodes_human_reviewed). The old require_human_ack gate is removed: no config lets a machine review
        // grant human credit — only /deep-loop-ack --actor human --confirm releases the human gate.
        const target = loop.episodes.find(e => e.id === tgt.target_maker);
        if (target && target.role === 'maker' && !target.human_reviewed && !target.agent_reviewed) {
          target.agent_reviewed = true;
          loop.comprehension.episodes_agent_reviewed = (loop.comprehension.episodes_agent_reviewed || 0) + 1;
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
      // Defense-in-depth (mirrors dispatchReview's REVIEW_NO_ELIGIBLE_MAKER): never record a verdict on an UNBOUND
      // checker (no target_maker — reviewed no maker). Blocks any legacy pending unbound checker from being
      // terminalized, so no NEW unbound terminal (rejected/approved) checker can arise.
      if (!tgt.target_maker) throw new Error('REVIEW_UNBOUND_CHECKER: cannot record a verdict on a checker bound to no maker: ' + episodeId);
      const REVIEW_TERMINAL = ['done', 'approved', 'rejected', 'abandoned'];
      if (REVIEW_TERMINAL.includes(tgt.status)) throw new Error('REVIEW_ALREADY_RECORDED: ' + episodeId);
      const wsForReport = loop.workstreams.find(w => w.id === tgt.workstream_id);
      if (!wsForReport) throw new Error(`WORKSTREAM_NOT_FOUND: ${tgt.workstream_id}`);
      // #2 + impl-R2 Fix 4 evidence gate — LAST (so fence/checker/terminal errors still fire first). A passing
      // verdict needs a real report BOUND to THIS review: an existing file whose realpath sits under the reviewed
      // workstream's worktree (an unrelated file like README.md at root is refused). Kernel-authoritative (CLI-bypass safe).
      if (passed && !reportBoundToWorktree(root, realReport, wsForReport.worktree)) {
        throw new Error('REVIEW_NO_EVIDENCE: passing verdict requires proof.report — a real file under the reviewed workstream worktree');
      }
    }, { floor: MUTATION_TURN_FLOOR });
  // REQUEST_CHANGES → checker='rejected'. nextAction returns fix_episode and Execution creates the fix maker.
  return result;
}

// review.points = run-level 계약. 충족은 workstream review_points_done(bound approved checker가 채움)이 단일 출처.
export function unsatisfiedReviewPoints(loop) {
  const pts = loop.review?.points || [];
  const done = (loop.workstreams || []).flatMap(w => w.review_points_done || []);
  return pts.filter(p => !done.includes(p));
}
