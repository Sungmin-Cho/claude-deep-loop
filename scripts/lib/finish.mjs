import { withVerifiedMutationLock } from './integrity.mjs';
import { contentHash } from './envelope.mjs';
import { leaseCheck } from './lease.mjs';
import { runDir } from './state.mjs';
import { validate } from './schema.mjs';
import { runtimeFence } from './runtime.mjs';
import { isProofCapableChecker, makerReviewed, unsatisfiedReviewPoints, epOrder, rejectionResolved } from './review.mjs';
import { MUTATION_TURN_FLOOR } from './budget.mjs';
import { containedRealFile } from './fs-safe.mjs';

// A rejected checker is settled only when it is RESOLVED by the SINGLE unified predicate rejectionResolved
// (review.mjs) — the SAME order-aware predicate next-action.mjs uses for routing. (Replaces the old local
// reviewSatisfied, which settled on review_points_done / any same-point approval and was NOT order-aware,
// so a NEWER unbound REQUEST_CHANGES after an approved point was silently settled.) The boundLatestApproved
// convergence check below is complementary (it gates makers, not the rejected checker's settlement).
const settledEp = (loop, e) => ['done', 'approved', 'abandoned'].includes(e.status) || (e.role === 'checker' && e.status === 'rejected' && rejectionResolved(loop, e));
const TERMINAL_WS = ['ready', 'merged', 'abandoned'];

export function finishProofState(loop) {
  const eps = loop.episodes || [];
  const hasWork = eps.length > 0;                                  // Codex r1 critical-1: 빈 run 의 공허-통과 차단
  const settled = eps.every(e => settledEp(loop, e));
  const noActiveWs = (loop.active_workstreams || []).length === 0;
  const wsAll = (loop.workstreams || []).every(w => TERMINAL_WS.includes(w.status));
  // Per-maker binding check: every done maker must have a bound terminal checker (target_maker === maker.id).
  const doneMakers = eps.filter(e => e.role === 'maker' && e.status === 'done');
  const allMakersReviewed = doneMakers.every(m => makerReviewed(loop, m));
  // Convergence: for each (ws,point) that has done makers, the LATEST done maker (highest episode id,
  // via epOrder — numeric prefix compare, not string, so the 999→1000 boundary is correct)
  // must have a bound APPROVED checker. An unbound approved checker cannot satisfy this requirement.
  const latestByPoint = new Map();
  for (const m of doneMakers) {
    const k = `${m.workstream_id}|${m.point}`;
    const cur = latestByPoint.get(k);
    if (!cur || epOrder(m.id, cur.id) > 0) latestByPoint.set(k, m);
  }
  // final-fix-4: convergence must be ORDER-AWARE on the checker side too — mirror the unified rejectionResolved.
  // A maker converges only when its LATEST bound terminal checker (by epOrder) is APPROVED. An older approve
  // followed by a newer reject (same target_maker) must NOT mask the rejection (a plain any-approved test would,
  // diverging from nextAction which routes to fix_episode). An unbound checker has no target_maker so cannot count.
  const latestBoundChecker = (mid) => {
    const cs = (loop.episodes || []).filter(e => isProofCapableChecker(e) && e.target_maker === mid && (e.status === 'approved' || e.status === 'rejected'));
    return cs.length ? cs.reduce((a, b) => (epOrder(a.id, b.id) >= 0 ? a : b)) : null;
  };
  const boundLatestApproved = (mid) => latestBoundChecker(mid)?.status === 'approved';
  const allPointsConverged = [...latestByPoint.values()].every(m => boundLatestApproved(m.id));
  // P2 codex r6: hill-climb run의 review proof는 계약-강제 리뷰여야 한다 — proof를 만족시키는 각 latest
  // APPROVED checker에 dispatch가 pin한 contract(sha256)가 있어야 한다. pre-patch 커널로 approved된
  // legacy checker는 record-시점 게이트를 다시 거치지 않으므로 finish에서 막는다. 마이그레이션(r7,
  // abandon 불필요 — terminal checker는 abandon 불가): dispatchReview의 legacyUnpinned 특례가 해당
  // maker를 재리뷰 재적격으로 되돌리므로, 사람이 `review dispatch`를 다시 실행해 계약-pinned checker가
  // 최신이 되면 이 게이트가 해소된다.
  const hillClimb = loop.recipe?.id === 'harness-hill-climb';
  const contractPinned = !hillClimb || [...latestByPoint.values()].every(m => {
    const c = latestBoundChecker(m.id);
    return !c || c.status !== 'approved' || !!c.contract?.sha256;
  });
  const reviewedProof = doneMakers.length > 0 && allMakersReviewed && allPointsConverged && contractPinned;
  const unboundDoneMaker = doneMakers.some(m => !m.workstream_id || !(loop.workstreams || []).some(w => w.id === m.workstream_id));
  const missing = [];
  if (!hasWork) missing.push('no-proof-of-work');                  // 최소 1 episode 필요 (Array.every 공허-통과 방지)
  if (!settled) missing.push('unsettled-episodes');
  if (!noActiveWs) missing.push('active-workstreams');
  if (!wsAll) missing.push('non-terminal-workstreams');
  if (!allMakersReviewed) missing.push('unreviewed-maker');        // 미리뷰 done maker 차단
  if (hasWork && !reviewedProof) missing.push('no-independent-review');
  if (hasWork && !contractPinned) missing.push('hillclimb-contract-unpinned');   // legacy approved checker — contract materialize 후 fresh pinned review 필요
  if (unsatisfiedReviewPoints(loop).length) missing.push('review-point-unsatisfied');
  if (unboundDoneMaker) missing.push('unbound-proof-episode');
  return { hasWork, settled, noActiveWs, allWsTerminal: wsAll, allMakersReviewed, reviewedProof, missing };
}

function inspectTerminalAppBinding(loop) {
  const lease = loop.session_chain.lease;
  if (lease.handoff_transport !== 'codex-app') return null;
  const child = loop.session_chain.sessions.find(session =>
    session.run_id === lease.handoff_child_run_id);
  const continuation = child?.continuation;
  if (!child || continuation?.transport !== 'codex-app'
      || continuation.attempt_id !== lease.handoff_attempt_id
      || !['emitted', 'prepared', 'confirmed', 'failed', 'abandoned']
        .includes(continuation.phase)) {
    throw new Error('APP_TERMINAL_BINDING_INVALID');
  }
  const live = ['emitted', 'prepared', 'confirmed'].includes(continuation.phase);
  return Object.freeze({ childRunId: child.run_id, attemptId: continuation.attempt_id,
    failureCode: live ? 'run-finished' : continuation.failure_code });
}

function sameTerminalAppBinding(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function finishIdentityFence(fence) {
  return loop => {
    const lease = loop.session_chain?.lease;
    if (!lease || lease.owner_run_id !== fence.owner
        || lease.generation !== fence.generation) throw new Error('LEASE_FENCED: finish');
    if (fence.runtime !== undefined) {
      const runtime = runtimeFence(loop, fence.runtime);
      if (!runtime.ok) throw new Error(`RUNTIME_FENCED: ${runtime.reason}`);
    }
  };
}

function applyTerminalAppCleanup(loop, binding) {
  if (binding === null) return;
  const lease = loop.session_chain.lease;
  const child = loop.session_chain.sessions.find(session => session.run_id === binding.childRunId);
  const continuation = child.continuation;
  if (['emitted', 'prepared', 'confirmed'].includes(continuation.phase)) {
    continuation.phase = 'abandoned';
    continuation.failure_code = 'run-finished';
    if (!child.outcome) child.outcome = 'abandoned_finish';
  }
  const parent = loop.session_chain.sessions.find(session =>
    session.superseded_by === binding.childRunId);
  if (parent) parent.superseded_by = null;
  Object.assign(lease, { state: 'released', handoff_phase: 'idle',
    handoff_transport: null, handoff_attempt_id: null, handoff_child_run_id: null,
    handoff_idempotency_key: null, expires_at: null, resume_policy: null });
}

function applyFinish(loop, { status, reportRel, binding, clock }) {
  applyTerminalAppCleanup(loop, binding);
  loop.status = status;
  loop.termination = loop.termination || {};
  loop.termination.finished_at = clock.iso;
  if (reportRel) loop.termination.final_report = reportRel;
}

function assertRecoveredFinishProjection(loop, recovered, { status, reportRel, fence }) {
  if (recovered.events?.length !== 2 || recovered.events[0]?.type !== 'finish'
      || recovered.events[1]?.type !== 'cost') {
    throw new Error('FINISH_RESPONSE_PROJECTION_CHANGED');
  }
  const event = recovered.events[0];
  const cost = recovered.events[1];
  const expectedCostKeys = ['auto_floor', 'for', 'generation', 'owner', 'tokens', 'turns'];
  if (JSON.stringify(Object.keys(cost.data ?? {}).sort()) !== JSON.stringify(expectedCostKeys)
      || cost.data.turns !== MUTATION_TURN_FLOOR || cost.data.tokens !== 0
      || cost.data.auto_floor !== true || cost.data.for !== 'finish'
      || cost.data.owner !== fence.owner || cost.data.generation !== fence.generation
      || cost.ts !== event.ts || cost.seq !== event.seq + 1) {
    throw new Error('FINISH_RESPONSE_PROJECTION_CHANGED');
  }
  const data = event.data ?? {};
  const appKeys = ['attempt_id', 'child_run_id', 'failure_code'];
  const hasAppProjection = appKeys.some(key => Object.hasOwn(data, key));
  const expectedKeys = ['reportRel', 'status', ...(hasAppProjection ? appKeys : [])].sort();
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(expectedKeys)
      || data.status !== status || data.reportRel !== (reportRel || null)
      || loop.status !== status || loop.termination?.finished_at !== event.ts
      || (reportRel && loop.termination?.final_report !== reportRel)) {
    throw new Error('FINISH_RESPONSE_PROJECTION_CHANGED');
  }
  if (!hasAppProjection) return;
  const child = loop.session_chain.sessions.find(session => session.run_id === data.child_run_id);
  const continuation = child?.continuation;
  const lease = loop.session_chain.lease;
  const cleared = ['handoff_transport', 'handoff_attempt_id', 'handoff_child_run_id',
    'handoff_idempotency_key', 'resume_policy', 'expires_at'];
  if (!child || continuation?.transport !== 'codex-app'
      || continuation.attempt_id !== data.attempt_id
      || continuation.failure_code !== data.failure_code
      || (data.failure_code === 'run-finished'
        && (continuation.phase !== 'abandoned' || child.outcome !== 'abandoned_finish'))
      || lease.state !== 'released' || lease.handoff_phase !== 'idle'
      || cleared.some(key => lease[key] !== null)
      || loop.session_chain.sessions.some(session => session.superseded_by === child.run_id)) {
    throw new Error('FINISH_RESPONSE_PROJECTION_CHANGED');
  }
}

export function finishRun(root, runId,
  { status, reportRel, proof = {}, confirm, fence, now,
    nowFn = now === undefined ? Date.now : () => now } = {}) {
  if (!fence || typeof fence.owner !== 'string'
      || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: finishRun');
  const fenceCheck = finishIdentityFence(fence);
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = contentHash(JSON.stringify({ operation: 'finish',
    owner: fence.owner, generation: fence.generation, status,
    runtime: fence.runtime ?? null, confirm: confirm === true,
    report_digest: reportRel == null ? null
      : contentHash(`finish-report\0${reportRel}`),
    proof_digest: contentHash(`finish-proof\0${JSON.stringify(proof)}`) }));
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'LEASE_FENCED: finishRun' }, mutation => {
    const snapshot = mutation.readVerifiedState({ fenceCheck }).data;
    if (mutation.recoverySource === 'pending') {
      assertRecoveredFinishProjection(snapshot, mutation.recovered, { status, reportRel, fence });
      return { ok: true, status };
    }
    const binding = inspectTerminalAppBinding(snapshot);
    if (binding !== null && fence.runtime === undefined) {
      throw new Error('RUNTIME_FENCED: App finish requires runtime');
    }
    const eventData = { status, reportRel: reportRel || null,
      ...(binding === null ? {} : { attempt_id: binding.attemptId,
        child_run_id: binding.childRunId, failure_code: binding.failureCode }) };
    let result;
    mutation.appendAnchored({ type: 'finish', data: eventData },
    (loop, _spent, clock) => {
      applyFinish(loop, { status, reportRel, binding, clock });
      result = { ok: true, status };
    },
    (loop, clock) => {
      const lease = loop.session_chain?.lease;
      const appTransport = lease.handoff_transport === 'codex-app';
      if (appTransport && fence.runtime === undefined) {
        throw new Error('RUNTIME_FENCED: App finish requires runtime');
      }
      if (loop.status === 'completed' || loop.status === 'stopped') {
        throw new Error(`FINISH_ALREADY_TERMINAL: ${loop.status}`);
      }

      const freshBinding = inspectTerminalAppBinding(loop);
      if (!sameTerminalAppBinding(freshBinding, binding)) {
        throw new Error('APP_TERMINAL_BINDING_CHANGED');
      }
      if (freshBinding === null) {
        const business = leaseCheck(loop, fence);
        if (!business.ok) throw new Error(`LEASE_FENCED: ${business.reason}`);
      }
      if (status !== 'completed' && status !== 'stopped') {
        throw new Error(`FINISH_STATUS_INVALID: ${status}`);
      }
      if (status === 'stopped') {
        if (confirm !== true) {
          throw new Error('CONFIRM_REQUIRED: stopped requires --confirm (human-only)');
        }
        if (!proof?.human_reason) {
          throw new Error('FINISH_PROOF_UNMET: stopped requires proof.human_reason');
        }
      } else {
        const checkedProof = finishProofState(loop);
        const real = reportRel ? containedRealFile(runDir(root, runId), reportRel) : null;
        if (!real) checkedProof.missing.push('final-report-missing');
        if (checkedProof.missing.length) {
          throw new Error(`FINISH_PROOF_UNMET: ${checkedProof.missing.join(',')}`);
        }
      }

      const candidate = structuredClone(loop);
      applyFinish(candidate, { status, reportRel, binding: freshBinding, clock });
      const checked = validate(candidate);
      if (!checked.ok) throw new Error(`STATE_INVALID: ${checked.errors.join('; ')}`);
    }, { floor: MUTATION_TURN_FLOOR, nowFn, fenceCheck });
    return result;
  });
}
