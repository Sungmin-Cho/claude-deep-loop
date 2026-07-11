import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { readState } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { newBlockedCheckerEpisode, newEpisode } from './episode.mjs';
import { leaseCheck } from './lease.mjs';
import { pluginPresent } from './detect.mjs';
import { checkerDescriptor } from './adapters.mjs';
import { containedRealFile } from './fs-safe.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';
import { sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { validate } from './schema.mjs';
import {
  isProofCapableChecker,
  deriveReviewArtifactContract,
  materializeImportedReview,
  parseReviewImport,
  sha256File,
  validateImportedEvidence,
  verifyImportedEnvelope,
  REVIEW_ATTEMPT_ID,
} from './review-import.mjs';

export { isProofCapableChecker };

export function findPendingIndependentChecker(loop) {
  const eligible = episode => episode?.role === 'checker'
    && episode.status === 'pending'
    && episode.requires_independent_session === true;
  const current = (loop?.episodes || []).find(episode => episode.id === loop?.current_episode);
  if (eligible(current)) return current;
  return (loop?.episodes || []).find(eligible) || null;
}

function boundedBlockReason(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error('REVIEW_BLOCK_REASON_INVALID: bounded safe reason required');
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkIndependentReviewFence(loop, fence) {
  const runtime = sessionRuntime(loop);
  const checkedFence = leaseCheck(loop, { ...fence, runtime });
  if (!checkedFence.ok) throw new Error('LEASE_FENCED: ' + checkedFence.reason);
  return runtime;
}

function claimedContext(root, loop, episodeId, attemptId, fence) {
  const runtime = checkIndependentReviewFence(loop, fence);
  const context = snapshotContext(loop, episodeId);
  const checker = context.checker;
  if (!checker) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  if (checker.role !== 'checker' || checker.requires_independent_session !== true) {
    throw new Error('REVIEW_CLAIM_TARGET_INVALID: independent checker required');
  }
  if (!isProofCapableChecker(checker)) throw new Error('REVIEW_CLAIM_REVIEWER_INVALID: proof-capable checker required');
  if (!context.maker || context.maker.role !== 'maker' || context.maker.status !== 'done') {
    throw new Error('REVIEW_CLAIM_MAKER_INVALID: bound done maker required');
  }
  if (!context.workstream || checker.workstream_id !== context.maker.workstream_id
    || checker.point !== context.maker.point) throw new Error('REVIEW_CLAIM_BINDING_INVALID');
  const artifacts = deriveReviewArtifactContract(root, context.maker, context.workstream);
  const lease = loop.session_chain?.lease || {};
  const claim = {
    run_id: loop.run_id,
    reviewer_id: checker.plugin,
    checker_episode_id: checker.id,
    target_maker: context.maker.id,
    attempt_id: attemptId,
    workstream_id: checker.workstream_id,
    point: checker.point,
    project_root: canonicalProjectRoot(root),
    runtime,
    lease_owner: lease.owner_run_id,
    lease_generation: lease.generation,
    artifacts,
  };
  return { ...context, runtime, claim };
}

export function claimIndependentReview(root, runId, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new Error('REVIEW_CLAIM_INPUT_INVALID');
  for (const key of ['attemptId', 'attempt_id', 'reviewer_id', 'target_maker', 'runtime', 'project_root', 'artifacts']) {
    if (Object.hasOwn(options, key)) throw new Error(`REVIEW_METADATA_FORBIDDEN: claim derives ${key}`);
  }
  const { episodeId, fence, attemptIdFactory = randomUUID } = options;
  validFence(fence, 'claimIndependentReview');
  if (typeof episodeId !== 'string' || episodeId.length === 0) throw new Error('REVIEW_CLAIM_INPUT_INVALID: episodeId');
  if (typeof attemptIdFactory !== 'function') throw new Error('REVIEW_CLAIM_INPUT_INVALID: attemptIdFactory');
  const attemptId = attemptIdFactory();
  if (!REVIEW_ATTEMPT_ID.test(attemptId || '')) throw new Error('REVIEW_CLAIM_ATTEMPT_INVALID');
  const eventData = { episode_id: episodeId, attempt_id: attemptId };
  let context;
  let alreadyClaimed = false;
  try {
    appendAnchored(root, runId, { type: 'independent-review-claimed', data: eventData }, (loop) => {
      const checker = loop.episodes.find(episode => episode.id === episodeId);
      checker.status = 'in_progress';
      checker.attempt_id = attemptId;
      checker.review_claim = context.claim;
    }, (loop) => {
      checkIndependentReviewFence(loop, fence);
      const checker = loop.episodes.find(episode => episode.id === episodeId);
      if (checker?.status === 'in_progress' && checker.review_claim) {
        alreadyClaimed = true;
        throw Object.assign(new Error('REVIEW_ALREADY_CLAIMED'), { alreadyClaimed: true });
      }
      if (loop.status !== 'running') throw new Error('REVIEW_CLAIM_RUN_NOT_RUNNING');
      if (checker?.status !== 'pending') throw new Error('REVIEW_CLAIM_NOT_PENDING');
      context = claimedContext(root, loop, episodeId, attemptId, fence);
      Object.assign(eventData, {
        reviewer_id: context.claim.reviewer_id,
        target_maker: context.claim.target_maker,
        workstream_id: context.claim.workstream_id,
        point: context.claim.point,
        artifacts: context.claim.artifacts,
      });
    });
  } catch (error) {
    if (error?.alreadyClaimed === true || alreadyClaimed) return { ok: false, reason: 'already-claimed' };
    throw error;
  }
  return { ok: true, checkerEpisodeId: episodeId, attemptId, claim: context.claim };
}

export function blockIndependentReview(root, runId, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new Error('REVIEW_BLOCK_INPUT_INVALID');
  const { episodeId, attemptId, reason, fence } = options;
  validFence(fence, 'blockIndependentReview');
  if (!REVIEW_ATTEMPT_ID.test(attemptId || '')) throw new Error('REVIEW_BLOCK_ATTEMPT_INVALID');
  const safeReason = boundedBlockReason(reason);
  let locked;
  appendAnchored(root, runId, { type: 'independent-review-blocked', data: {
    episode_id: episodeId, attempt_id: attemptId, reason: safeReason,
  } }, (loop) => {
    const checker = locked.checker;
    checker.status = 'blocked';
    checker.block_reason = safeReason;
    checker.needs_human = true;
    loop.status = 'paused';
    loop.pause_reason = `independent-review:${safeReason}`;
    loop.session_chain.lease.resume_policy = 'human';
    loop.session_chain.lease.expires_at = null;
  }, (loop) => {
    checkIndependentReviewFence(loop, fence);
    const checker = loop.episodes.find(episode => episode.id === episodeId);
    if (checker?.status !== 'in_progress' || checker.attempt_id !== attemptId || !checker.review_claim) {
      throw new Error('REVIEW_BLOCK_CLAIM_MISMATCH');
    }
    locked = claimedContext(root, loop, episodeId, attemptId, fence);
    if (!sameJson(checker.review_claim, locked.claim)) throw new Error('REVIEW_BLOCK_CLAIM_MISMATCH');
  });
  return { ok: true, status: 'blocked', reason: safeReason };
}

export function revalidateIndependentReviewClaim(root, runId, options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new Error('REVIEW_CLAIM_INPUT_INVALID');
  const { episodeId, attemptId, fence } = options;
  validFence(fence, 'revalidateIndependentReviewClaim');
  if (!REVIEW_ATTEMPT_ID.test(attemptId || '')) throw new Error('REVIEW_CLAIM_ATTEMPT_INVALID');
  const { data: loop } = readState(root, runId);
  const checker = loop.episodes.find(episode => episode.id === episodeId);
  if (checker?.status !== 'in_progress' || checker.attempt_id !== attemptId || !checker.review_claim) {
    throw new Error('REVIEW_CLAIM_MISMATCH');
  }
  const fresh = claimedContext(root, loop, episodeId, attemptId, fence);
  if (!sameJson(checker.review_claim, fresh.claim)) throw new Error('REVIEW_CLAIM_MISMATCH');
  return { ok: true, claim: fresh.claim };
}

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
  // Unsupported/legacy checker proof is neutral history: it cannot demand a fix and cannot strand finish.
  if (!isProofCapableChecker(e)) return true;
  if (e.target_maker) {
    const reApprovedNewer = eps.some(c => isProofCapableChecker(c) && c.target_maker === e.target_maker && c.status === 'approved' && epOrder(c.id, e.id) > 0);
    const laterDoneMaker = eps.some(m => m.role === 'maker' && m.status === 'done' && m.workstream_id === e.workstream_id && m.point === e.point && epOrder(m.id, e.target_maker) > 0);
    return reApprovedNewer || laterDoneMaker;
  }
  return true;   // unbound → neutral (see comment above)
}

const LEGACY_INLINE_BLOCK_REASON = 'legacy-inline-checker-unsupported';

export function resolveReviewer(loop, detected = {}, { independentSubagent = false } = {}) {
  const r = loop.review || {};
  let reviewer = r.reviewer || 'subagent-checker';
  let reviewerResolution;
  let blockedReason;
  if (reviewer === 'standalone') {
    if (independentSubagent === true) {
      reviewer = 'subagent-checker';
      reviewerResolution = {
        legacy_reviewer: 'standalone',
        decision: 'upgraded',
        reviewer,
        asserted_capability: 'independent-subagent',
      };
    } else {
      blockedReason = LEGACY_INLINE_BLOCK_REASON;
      reviewerResolution = {
        legacy_reviewer: 'standalone',
        decision: 'blocked',
        reason: blockedReason,
      };
    }
  }
  if ((reviewer === 'deep-review-loop' || reviewer === 'deep-review') && !pluginPresent(detected, 'deep-review')) {
    reviewer = 'subagent-checker';
  } else if (!['deep-review-loop', 'deep-review', 'subagent-checker', 'standalone'].includes(reviewer)) {
    blockedReason = 'checker-capability-unsupported';
  }
  return { reviewer, flags: r.flags || [], mode: r.mode || 'cross-model', reviewerResolution, blockedReason };
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
    isProofCapableChecker(e) && e.target_maker === maker.id &&
    (e.status === 'approved' || e.status === 'rejected')
  );
}

// checker episode 생성 + dispatch 디스크립터 반환 — 커널은 sibling을 호출하지 않음 (spec §1.1·§6).
export function dispatchReview(root, runId, { point, workstreamId, detected = {}, independentSubagent = false, fence } = {}) {
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
  const { reviewer, flags, mode, reviewerResolution, blockedReason } = resolveReviewer(data, detected, { independentSubagent });
  const episodeInput = {
    plugin: reviewer === 'deep-review-loop' || reviewer === 'deep-review' ? 'deep-review' : reviewer,
    kind: `${point}-review`, point, workstream: workstreamId, targetMaker, reviewerResolution, fence,
  };
  const { id } = blockedReason
    ? newBlockedCheckerEpisode(root, runId, { ...episodeInput, reason: blockedReason })
    : newEpisode(root, runId, { ...episodeInput, role: 'checker' });
  const descriptor = checkerDescriptor(reviewer, { point, workstreamId, flags, mode, reason: blockedReason });
  return { checkerEpisodeId: id, reviewer, descriptor };
}

const REVIEW_TERMINAL = new Set(['done', 'approved', 'rejected', 'abandoned']);
const REVIEW_SOURCES = new Set(['recorded-path', 'imported-stdin']);

function snapshotContext(loop, episodeId) {
  const checker = loop?.episodes?.find(e => e.id === episodeId) || null;
  const maker = checker?.target_maker ? loop.episodes.find(e => e.id === checker.target_maker) || null : null;
  const workstream = checker?.workstream_id ? loop.workstreams.find(w => w.id === checker.workstream_id) || null : null;
  return {
    checker, maker, workstream,
    workstreamId: checker?.workstream_id,
    point: checker?.point,
    targetMaker: checker?.target_maker,
    reviewerId: checker?.plugin,
  };
}

function checkedContext(loop, episodeId, { reviewSource } = {}) {
  const context = snapshotContext(loop, episodeId);
  const checker = context.checker;
  if (!checker) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  if (checker.role !== 'checker') throw new Error('REVIEW_TARGET_NOT_CHECKER: ' + episodeId);
  if (checker.status === 'blocked') throw new Error('REVIEW_CHECKER_BLOCKED: independent checker capability is required: ' + episodeId);
  if (REVIEW_TERMINAL.has(checker.status)) throw new Error('REVIEW_ALREADY_RECORDED: ' + episodeId);
  if (!isProofCapableChecker(checker)) {
    const code = reviewSource === 'imported-stdin' ? 'REVIEW_IMPORT_REVIEWER_INVALID' : 'REVIEW_CHECKER_IDENTITY_UNSUPPORTED';
    throw new Error(`${code}: unsupported checker plugin ${String(checker.plugin)}`);
  }
  if (reviewSource === 'imported-stdin' && (checker.status !== 'in_progress' || !checker.review_claim)) {
    throw new Error('REVIEW_IMPORT_CHECKER_NOT_CLAIMED: checker must carry an in-progress host claim');
  }
  if (reviewSource === 'recorded-path' && checker.review_claim) {
    throw new Error('REVIEW_CLAIM_REQUIRES_IMPORT: a host claim can be completed only by review import');
  }
  if (!checker.target_maker) throw new Error('REVIEW_UNBOUND_CHECKER: cannot record a verdict on a checker bound to no maker: ' + episodeId);
  const maker = context.maker;
  if (!maker || maker.role !== 'maker') throw new Error('REVIEW_TARGET_MAKER_INVALID: ' + checker.target_maker);
  if (maker.status !== 'done') throw new Error('REVIEW_TARGET_MAKER_NOT_DONE: ' + maker.id);
  if (checker.workstream_id !== maker.workstream_id || checker.point !== maker.point) {
    throw new Error('REVIEW_MAKER_BINDING_MISMATCH: checker and maker workstream/point differ');
  }
  if (!context.workstream) throw new Error(`WORKSTREAM_NOT_FOUND: ${checker.workstream_id}`);
  return context;
}

function rejectCallerMetadata(options, operation) {
  for (const key of ['source', 'workstreamId', 'workstream_id', 'workstream', 'point', 'targetMaker', 'target_maker', 'reviewer_id', 'reviewSource', 'review_source', 'runtime', 'attemptId', 'attempt_id', 'attempt-id']) {
    if (Object.hasOwn(options, key)) throw new Error(`REVIEW_METADATA_FORBIDDEN: ${operation} derives ${key}`);
  }
}

function validFence(fence, operation) {
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) {
    throw new Error(`FENCE_REQUIRED: ${operation}`);
  }
}

function validVerdict(verdict) {
  if (!['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(verdict)) {
    throw new Error(`REVIEW_VERDICT_INVALID: ${verdict}`);
  }
}

// Sole proof transaction for both adapters. appendAnchored performs the root-bound fresh read first; this
// preCheck then applies runtime/lease, checker/maker, and source-evidence checks in the locked order.
function commitReviewOutcome(root, runId, {
  episodeId, verdict, reviewSource, evidence, fence, runtime, snapshot,
}) {
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  if (!REVIEW_SOURCES.has(reviewSource)) throw new Error(`REVIEW_SOURCE_INVALID: ${reviewSource}`);
  const eventData = {
    episodeId, verdict,
    workstream_id: snapshot.workstreamId,
    point: snapshot.point,
    target_maker: snapshot.targetMaker,
    reviewer_id: snapshot.reviewerId,
    review_source: reviewSource,
    ...(reviewSource === 'imported-stdin' ? { attempt_id: evidence.input?.attempt_id } : {}),
    ...(evidence.report ? { report: evidence.report, report_sha256: evidence.reportSha256 } : {}),
    ...(evidence.findings ? { findings: evidence.findings } : {}),
  };
  let lockedContext;
  let result;
  appendAnchored(root, runId, { type: 'review-outcome', data: eventData },
    (loop) => {
      const checker = lockedContext.checker;
      const maker = lockedContext.maker;
      const workstream = lockedContext.workstream;
      checker.status = passed ? 'approved' : 'rejected';
      checker.review_source = reviewSource;
      const breaker = loop.circuit_breaker;
      if (verdict === 'REQUEST_CHANGES') {
        breaker.consecutive_request_changes = (breaker.consecutive_request_changes || 0) + 1;
        if (breaker.consecutive_request_changes >= BREAKER_THRESHOLD && !breaker.tripped) {
          breaker.tripped = true;
          breaker.trip_reason = 'consecutive-request-changes';
          loop.status = 'paused';
        }
      } else {
        breaker.consecutive_request_changes = 0;
      }
      if (passed) {
        if (!workstream.review_points_done.includes(checker.point)) workstream.review_points_done.push(checker.point);
        if (!maker.human_reviewed && !maker.agent_reviewed) {
          maker.agent_reviewed = true;
          loop.comprehension.episodes_agent_reviewed = (loop.comprehension.episodes_agent_reviewed || 0) + 1;
        }
      }
      result = {
        verdict, passed, terminal: checker.status, review_source: reviewSource,
        ...(evidence.report ? { report: evidence.report, report_sha256: evidence.reportSha256 } : {}),
      };
    },
    (loop) => {
      const checkedFence = leaseCheck(loop, { ...fence, runtime });
      if (!checkedFence.ok) throw new Error('LEASE_FENCED: ' + checkedFence.reason);
      lockedContext = checkedContext(loop, episodeId, { reviewSource });
      if (lockedContext.workstreamId !== snapshot.workstreamId
          || lockedContext.point !== snapshot.point
          || lockedContext.targetMaker !== snapshot.targetMaker
          || lockedContext.reviewerId !== snapshot.reviewerId) {
        throw new Error('REVIEW_CONTEXT_FENCED: checker binding changed before commit');
      }
      const breaker = loop.circuit_breaker;
      const comprehension = loop.comprehension;
      if (breaker === null || typeof breaker !== 'object' || Array.isArray(breaker)
          || !Number.isInteger(breaker.consecutive_request_changes) || breaker.consecutive_request_changes < 0
          || typeof breaker.tripped !== 'boolean'
          || !Array.isArray(lockedContext.workstream.review_points_done)
          || comprehension === null || typeof comprehension !== 'object' || Array.isArray(comprehension)
          || !Number.isInteger(comprehension.episodes_agent_reviewed) || comprehension.episodes_agent_reviewed < 0) {
        throw new Error('STATE_INVALID: review outcome mutation structures');
      }
      const stateValidation = validate(loop);
      if (!stateValidation.ok) throw new Error(`STATE_INVALID: ${stateValidation.errors.join('; ')}`);
      if (reviewSource === 'recorded-path') {
        if (passed) {
          const reopened = containedRealFile(resolve(root), evidence.report);
          if (!reopened || reopened !== evidence.realReport
              || !reportBoundToWorktree(root, reopened, lockedContext.workstream.worktree)) {
            throw new Error('REVIEW_NO_EVIDENCE: passing verdict requires proof.report — a real file under the reviewed workstream worktree');
          }
          if (sha256File(reopened) !== evidence.reportSha256) {
            throw new Error('REVIEW_REPORT_HASH_MISMATCH: recorded report bytes changed');
          }
        }
      } else {
        if (evidence.preparationError) throw evidence.preparationError;
        const binding = validateImportedEvidence(root, loop, evidence.input, lockedContext);
        verifyImportedEnvelope(root, runId, evidence, binding);
      }
    }, { floor: MUTATION_TURN_FLOOR });
  return result;
}

export function recordReviewOutcome(root, runId, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('REVIEW_INPUT_INVALID: options');
  }
  rejectCallerMetadata(options, 'recordReviewOutcome');
  const { episodeId, verdict, proof = {}, fence } = options;
  validFence(fence, 'recordReviewOutcome');
  validVerdict(verdict);
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('REVIEW_INPUT_INVALID: proof');
  rejectCallerMetadata(proof, 'recordReviewOutcome proof');
  const preState = readState(root, runId).data;
  const runtime = sessionRuntime(preState);
  const snapshot = snapshotContext(preState, episodeId);
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  const realReport = passed ? containedRealFile(resolve(root), proof.report) : null;
  const evidence = {
    realReport,
    report: realReport ? proof.report : null,
    reportSha256: realReport ? sha256File(realReport) : null,
    findings: proof.findings != null && String(proof.findings).length ? String(proof.findings).slice(0, 2000) : null,
  };
  return commitReviewOutcome(root, runId, {
    episodeId, verdict, reviewSource: 'recorded-path', evidence, fence, runtime, snapshot,
  });
}

export function importReviewOutcome(root, runId, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('REVIEW_INPUT_INVALID: options');
  }
  rejectCallerMetadata(options, 'importReviewOutcome');
  const { raw, fence, now } = options;
  validFence(fence, 'importReviewOutcome');
  const input = parseReviewImport(raw);
  const preState = readState(root, runId).data;
  const runtime = sessionRuntime(preState);
  const snapshot = snapshotContext(preState, input.checker_episode_id);
  let evidence;
  try {
    const checked = checkedContext(preState, input.checker_episode_id, { reviewSource: 'imported-stdin' });
    const binding = validateImportedEvidence(root, preState, input, checked);
    evidence = materializeImportedReview(root, runId, input, binding, { now });
  } catch (preparationError) {
    // Preserve the authoritative locked error order. Invalid/stale source material never receives proof,
    // but the commit preCheck still gets to report root/runtime/lease/checker fences first.
    evidence = { input, preparationError, report: null, reportSha256: null };
  }
  return commitReviewOutcome(root, runId, {
    episodeId: input.checker_episode_id,
    verdict: input.verdict,
    reviewSource: 'imported-stdin',
    evidence,
    fence,
    runtime,
    snapshot,
  });
}

// review.points = run-level 계약. 충족은 workstream review_points_done(bound approved checker가 채움)이 단일 출처.
export function unsatisfiedReviewPoints(loop) {
  const pts = loop.review?.points || [];
  const done = (loop.workstreams || []).flatMap(w => w.review_points_done || []);
  return pts.filter(p => !done.includes(p));
}
