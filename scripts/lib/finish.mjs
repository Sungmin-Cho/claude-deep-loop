import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { runDir } from './state.mjs';
import { makerReviewed, unsatisfiedReviewPoints, epOrder } from './review.mjs';

function reviewSatisfied(loop, ep) {
  const ws = (loop.workstreams || []).find(w => w.id === ep.workstream_id);
  if (ws && (ws.review_points_done || []).includes(ep.point)) return true;
  return (loop.episodes || []).some(e => e.role === 'checker' && e.status === 'approved' && e.workstream_id === ep.workstream_id && e.point === ep.point);
}
const settledEp = (loop, e) => ['done', 'approved', 'abandoned'].includes(e.status) || (e.role === 'checker' && e.status === 'rejected' && reviewSatisfied(loop, e));
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
  // final-fix-4: convergence must be ORDER-AWARE on the checker side too — mirror next-action's supersededRejected.
  // A maker converges only when its LATEST bound terminal checker (by epOrder) is APPROVED. An older approve
  // followed by a newer reject (same target_maker) must NOT mask the rejection (a plain any-approved test would,
  // diverging from nextAction which routes to fix_episode). An unbound checker has no target_maker so cannot count.
  const boundLatestApproved = (mid) => {
    const cs = (loop.episodes || []).filter(e => e.role === 'checker' && e.target_maker === mid && (e.status === 'approved' || e.status === 'rejected'));
    if (!cs.length) return false;
    const latest = cs.reduce((a, b) => (epOrder(a.id, b.id) >= 0 ? a : b));
    return latest.status === 'approved';
  };
  const allPointsConverged = [...latestByPoint.values()].every(m => boundLatestApproved(m.id));
  const reviewedProof = doneMakers.length > 0 && allMakersReviewed && allPointsConverged;
  const unboundDoneMaker = doneMakers.some(m => !m.workstream_id || !(loop.workstreams || []).some(w => w.id === m.workstream_id));
  const missing = [];
  if (!hasWork) missing.push('no-proof-of-work');                  // 최소 1 episode 필요 (Array.every 공허-통과 방지)
  if (!settled) missing.push('unsettled-episodes');
  if (!noActiveWs) missing.push('active-workstreams');
  if (!wsAll) missing.push('non-terminal-workstreams');
  if (!allMakersReviewed) missing.push('unreviewed-maker');        // 미리뷰 done maker 차단
  if (hasWork && !reviewedProof) missing.push('no-independent-review');
  if (unsatisfiedReviewPoints(loop).length) missing.push('review-point-unsatisfied');
  if (unboundDoneMaker) missing.push('unbound-proof-episode');
  return { hasWork, settled, noActiveWs, allWsTerminal: wsAll, allMakersReviewed, reviewedProof, missing };
}

export function finishRun(root, runId, { status, reportRel, proof = {}, fence, now = Date.now() } = {}) {
  // Codex r3 sf-3: fence 는 lib 레벨에서 **필수** (CLI 우회 호출도 fence 강제). newEpisode/recordEpisode 와 동일 규약.
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: finishRun');
  let result;
  appendAnchored(root, runId, { type: 'finish', data: { status, reportRel: reportRel || null } },
    (loop) => {
      loop.status = status;
      loop.termination = loop.termination || {};
      loop.termination.finished_at = new Date(now).toISOString();
      if (reportRel) loop.termination.final_report = reportRel;
      result = { ok: true, status };
    },
    (loop) => {
      const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);   // 무조건 (fence 필수)
      if (status !== 'completed' && status !== 'stopped') throw new Error(`FINISH_STATUS_INVALID: ${status}`);
      if (status === 'stopped') {
        if (!proof || !proof.human_reason) throw new Error('FINISH_PROOF_UNMET: stopped requires proof.human_reason');
        return;
      }
      // completed: report 는 runDir 하위로 정규화·격리(containment)된 채 존재해야 — CLI 가드에 의존하지 않고 lib 가 강제.
      const ps = finishProofState(loop);
      const base = resolve(runDir(root, runId));
      const full = reportRel ? resolve(base, reportRel) : null;
      // Codex r4 critical-1: report 는 runDir **하위**(자체 아님)의 **실제 파일**이어야 한다 — `--report .` / 디렉터리 거부.
      const reportOk = full && full.startsWith(base + sep) && existsSync(full) && statSync(full).isFile();
      if (!reportOk) ps.missing.push('final-report-missing');
      if (ps.missing.length) throw new Error(`FINISH_PROOF_UNMET: ${ps.missing.join(',')}`);
    });
  return result;
}
