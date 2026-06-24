import { readState, writeState, withLock } from './state.mjs';

export function computeDebt(loop) {
  const c = loop.comprehension || {};
  const total = c.episodes_total || 0;
  const reviewed = c.episodes_human_reviewed || 0;
  const debt_ratio = total === 0 ? 0 : 1 - reviewed / total;
  return { debt_ratio, blocked: total > 0 && debt_ratio >= (c.debt_threshold ?? 0.5) };
}

export function ack(root, runId, episodeId) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    const ep = data.episodes.find(e => e.id === episodeId);
    if (ep) ep.human_reviewed = true;
    writeState(root, runId, data);
  });
}

export function recordReviewed(root, runId, episodeId, source) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const requireHumanAck = data.review?.require_human_ack === true;
    if (source === 'deep-review-approve' && requireHumanAck) return; // ack 필요, 카운트 안 함
    const ep = data.episodes.find(e => e.id === episodeId);
    if (ep && !ep.human_reviewed) {
      ep.human_reviewed = true;
      data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    }
    writeState(root, runId, data);
  });
}
