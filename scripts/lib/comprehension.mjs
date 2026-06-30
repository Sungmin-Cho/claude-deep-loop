import { readState, writeState, withLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';

export function computeDebt(loop) {
  const c = loop.comprehension || {};
  const total = c.episodes_total || 0;
  const reviewed = c.episodes_human_reviewed || 0;
  const debt_ratio = total === 0 ? 0 : 1 - reviewed / total;
  return { debt_ratio, blocked: total > 0 && debt_ratio >= (c.debt_threshold ?? 0.5) };
}

export function ack(root, runId, episodeId, { fence } = {}) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (fence) { const r = leaseCheck(data, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    const ep = data.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // Codex r1 sf-5: 부재 episode overcount 차단
    // P2-a (belt-and-suspenders): an abandoned maker is already out of episodes_total — never count it as
    // human-reviewed (would push reviewed/total > 1 and wrongly drop comprehension debt). No-op, no increment.
    if (ep.status === 'abandoned') return { ok: true, abandoned: true };
    if (ep.human_reviewed) return { ok: true, already: true };     // 멱등 — 중복 ack 는 카운트 증가 안 함
    ep.human_reviewed = true;
    data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    writeState(root, runId, data);
    return { ok: true, already: false };
  });
}

export function recordReviewed(root, runId, episodeId, source) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const requireHumanAck = data.review?.require_human_ack === true;
    if (source === 'deep-review-approve' && requireHumanAck) return; // ack 필요, 카운트 안 함
    const ep = data.episodes.find(e => e.id === episodeId);
    // P2-a (belt-and-suspenders): skip an abandoned episode — it is out of episodes_total and must not be counted.
    if (ep && ep.status !== 'abandoned' && !ep.human_reviewed) {
      ep.human_reviewed = true;
      data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    }
    writeState(root, runId, data);
  });
}
