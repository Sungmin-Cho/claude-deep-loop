import { readState, writeState, withLock } from './state.mjs';
import { newEpisode, recordEpisode } from './episode.mjs';
import { recordReviewVerdict } from './breaker.mjs';
import { leaseCheck } from './lease.mjs';

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

// checker episode 생성 + dispatch 디스크립터 반환 — 커널은 sibling을 호출하지 않음 (spec §1.1·§6).
export function dispatchReview(root, runId, { point, workstreamId, detected = {}, fence } = {}) {
  const { data } = readState(root, runId);
  const { reviewer, flags, mode } = resolveReviewer(data, detected);
  const { id } = newEpisode(root, runId, { plugin: reviewer === 'deep-review-loop' ? 'deep-review' : reviewer, role: 'checker', kind: `${point}-review`, point, workstream: workstreamId, fence });
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
  // Cheap CLI-layer prevalidation (verdict allowlist, episode exists, role===checker) — no race-safety needed here,
  // the atomic replay guard is inside recordEpisode's preCheck.
  if (!['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(verdict)) throw new Error(`REVIEW_VERDICT_INVALID: ${verdict}`);
  const pre = readState(root, runId).data;
  if (!pre.episodes.find(e => e.id === episodeId)) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  const tgt = pre.episodes.find(e => e.id === episodeId);
  if (tgt.role !== 'checker') throw new Error('REVIEW_TARGET_NOT_CHECKER: ' + episodeId);
  // Fast-path replay reject (non-atomic, best-effort early return). The atomic guard is inside recordEpisode preCheck.
  if (tgt.status === 'approved' || tgt.status === 'rejected') throw new Error('REVIEW_ALREADY_RECORDED: ' + episodeId);
  // Codex r2 🔴: 호출자 제공 workstreamId/point 를 신뢰하지 않음 — checker episode 에서 권위적으로 파생.
  const wsId = tgt.workstream_id;
  const pt = tgt.point;
  if (wsId && !pre.workstreams.find(w => w.id === wsId)) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  // Codex r3 🔴2: recordEpisode FIRST — its preCheck atomically rejects replay (EPISODE_ALREADY_TERMINAL).
  // Codex r1 🔴5: checker episode 터미널 상태를 verdict proof 에서 파생 — 안 하면 checker 가 pending 으로 남아
  // nextAction 이 fix_episode 로 진입 못 하고 finish 로 오폴백한다. 'accepted concern'(CONCERN)도 pass (spec §7).
  recordEpisode(root, runId, episodeId, { status: passed ? 'approved' : 'rejected', proof: { verdict }, fence });  // 자기 lock(appendAnchored) + atomic replay guard
  recordReviewVerdict(root, runId, verdict, fence);       // 자기 lock — breaker 카운터
  if (passed) {
    withLock(root, runId, () => {                          // review_points_done(kernel 필드) 기록 + comprehension
      const { data } = readState(root, runId);
      if (fence) {
        const r = leaseCheck(data, fence);
        if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);
      }
      const ws = data.workstreams.find(w => w.id === wsId);
      if (ws && !ws.review_points_done.includes(pt)) ws.review_points_done.push(pt);
      const requireHumanAck = data.review?.require_human_ack === true;
      if (!(requireHumanAck && source === 'deep-review-approve')) {
        for (const m of data.episodes.filter(e => e.role === 'maker' && e.workstream_id === wsId && e.point === pt && !e.human_reviewed)) {
          m.human_reviewed = true;
          data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
        }
      }
      writeState(root, runId, data);
    });
  }
  // REQUEST_CHANGES → checker='rejected'. nextAction 이 fix_episode 디스크립터를 반환하고 Execution 이 fix maker 를 생성.
  return { verdict, passed, terminal: passed ? 'approved' : 'rejected' };
}
