import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode, abandonEpisode } from '../scripts/lib/episode.mjs';
import { ack, computeDebt } from '../scripts/lib/comprehension.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';

function freshRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-comp-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  return { root, runId, fence };
}

test('debt ratio computed; blocked when over threshold', () => {
  const r = computeDebt({ comprehension: { episodes_total: 10, episodes_human_reviewed: 4, debt_threshold: 0.5 } });
  assert.equal(r.debt_ratio, 0.6);
  assert.equal(r.blocked, true);
});
test('under threshold not blocked', () => {
  const r = computeDebt({ comprehension: { episodes_total: 10, episodes_human_reviewed: 6, debt_threshold: 0.5 } });
  assert.equal(r.blocked, false);
});
test('zero episodes → debt 0, not blocked', () => {
  const r = computeDebt({ comprehension: { episodes_total: 0, episodes_human_reviewed: 0, debt_threshold: 0.5 } });
  assert.equal(r.debt_ratio, 0);
  assert.equal(r.blocked, false);
});

test('ack is idempotent and validates episode existence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ack-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const ep = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  ack(root, runId, ep.id, { fence });
  ack(root, runId, ep.id, { fence });   // 중복 — 카운트 증가 금지
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 1);
  assert.throws(() => ack(root, runId, 'ghost', { fence }), /EPISODE_NOT_FOUND/);
  assert.throws(() => ack(root, runId, ep.id, { fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);
});

test('abandonEpisode decrements episodes_total for a maker (0-clamp)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 1);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
});

test('abandonEpisode also decrements episodes_human_reviewed when the maker was acked', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  ack(root, runId, id, { fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 1);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_total, 0);
  assert.equal(c.episodes_human_reviewed, 0);
});

test('abandonEpisode is idempotent-safe: double abandon rejected, counters not double-decremented', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.throws(() => abandonEpisode(root, runId, id, { reason: 'again', confirm: true, fence }), /EPISODE_ALREADY_TERMINAL/);
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
});

test('abandonEpisode clamps episodes_total at 0 for a legacy/corrupt run (total already 0)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  const data = readState(root, runId).data; data.comprehension.episodes_total = 0; writeState(root, runId, data);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
});

// P2-a regression: an abandoned NON-reviewed maker is out of BOTH comprehension counters and must be UN-ackable —
// a later ack must NOT bump episodes_human_reviewed (otherwise reviewed/total can exceed 1 and debt wrongly drops to 0,
// unblocking fan-out). After abandon, ep.human_reviewed is set true (primary fix) AND ack/recordReviewed skip an
// abandoned episode (belt-and-suspenders) → ack is a no-op either way.
test('P2-a: ack on an abandoned (never-reviewed) maker is a no-op — episodes_human_reviewed stays 0', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 1);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  // abandoned maker is out of episodes_total …
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
  // … and the maker is marked reviewed so ack returns early as a no-op (no double count into episodes_human_reviewed)
  const r = ack(root, runId, id, { fence });
  assert.equal(r.ok, true);
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_human_reviewed, 0, 'ack on an abandoned maker must not increment episodes_human_reviewed');
  assert.equal(c.episodes_total, 0);
  // computeDebt must not be corrupted to reviewed/total > 1 (debt 0): with both counters 0 → debt 0, not blocked.
  assert.equal(computeDebt(readState(root, runId).data).debt_ratio, 0);
});

// P2-a belt-and-suspenders: even if an abandoned episode somehow has human_reviewed=false (legacy/corrupt state),
// the comprehension guard makes ack a no-op purely from status==='abandoned' (independent of the episode.mjs fix).
test('P2-a: ack guard skips an abandoned episode with human_reviewed=false (status-based no-op)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  // Force the legacy/corrupt shape: abandoned but human_reviewed reset to false.
  const data = readState(root, runId).data; data.episodes.find(e => e.id === id).human_reviewed = false; writeState(root, runId, data);
  ack(root, runId, id, { fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 0, 'status==abandoned guard must keep ack a no-op');
});
