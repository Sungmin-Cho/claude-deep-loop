import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { ack, computeDebt } from '../scripts/lib/comprehension.mjs';
import { readState } from '../scripts/lib/state.mjs';

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
