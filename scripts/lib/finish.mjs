import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { runDir } from './state.mjs';

function reviewSatisfied(loop, ep) {
  const ws = (loop.workstreams || []).find(w => w.id === ep.workstream_id);
  if (ws && (ws.review_points_done || []).includes(ep.point)) return true;
  return (loop.episodes || []).some(e => e.role === 'checker' && e.status === 'approved' && e.workstream_id === ep.workstream_id && e.point === ep.point);
}
const settledEp = (loop, e) => ['done', 'approved'].includes(e.status) || (e.role === 'checker' && e.status === 'rejected' && reviewSatisfied(loop, e));
const TERMINAL_WS = ['ready', 'merged', 'abandoned'];

export function finishProofState(loop) {
  const eps = loop.episodes || [];
  const hasWork = eps.length > 0;                                  // Codex r1 critical-1: 빈 run 의 공허-통과 차단
  const settled = eps.every(e => settledEp(loop, e));
  const noActiveWs = (loop.active_workstreams || []).length === 0;
  const wsAll = (loop.workstreams || []).every(w => TERMINAL_WS.includes(w.status));
  // Codex r2 critical-1: COUNT-BASED per-(ws,point) check — 같은 ws+point 의 두 번째 done maker 도 자신의 checker 필요.
  // terminalCheckers >= doneMakers && approvedCheckers >= 1 인 그룹만 리뷰 커버.
  const groups = new Map();
  for (const e of eps) {
    const key = `${e.workstream_id}|${e.point}`;
    if (!groups.has(key)) groups.set(key, { doneMakers: 0, terminalCheckers: 0, approvedCheckers: 0 });
    const g = groups.get(key);
    if (e.role === 'maker' && e.status === 'done') g.doneMakers++;
    if (e.role === 'checker' && (e.status === 'approved' || e.status === 'rejected')) g.terminalCheckers++;
    if (e.role === 'checker' && e.status === 'approved') g.approvedCheckers++;
  }
  const allMakersReviewed = [...groups.values()].every(g => g.doneMakers === 0 || (g.terminalCheckers >= g.doneMakers && g.approvedCheckers >= 1));
  const totalDoneMakers = [...groups.values()].reduce((s, g) => s + g.doneMakers, 0);
  const reviewedProof = totalDoneMakers > 0 && allMakersReviewed;   // 최소 1 리뷰된 maker = 독립 리뷰 proof
  const missing = [];
  if (!hasWork) missing.push('no-proof-of-work');                  // 최소 1 episode 필요 (Array.every 공허-통과 방지)
  if (!settled) missing.push('unsettled-episodes');
  if (!noActiveWs) missing.push('active-workstreams');
  if (!wsAll) missing.push('non-terminal-workstreams');
  if (!allMakersReviewed) missing.push('unreviewed-maker');        // 미리뷰 done maker 차단
  if (hasWork && !reviewedProof) missing.push('no-independent-review');
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
