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
