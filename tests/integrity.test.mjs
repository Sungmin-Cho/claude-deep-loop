import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, verifyLog, recomputeSpent } from '../scripts/lib/integrity.mjs';
import { runDir } from '../scripts/lib/state.mjs';

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(runDir(root, 'R'), { recursive: true });
  return root;
}

test('append + verify chain ok', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.equal(verifyLog(root, 'R').ok, true);
});

test('recomputeSpent sums cost events', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'decision', data: {} });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.deepEqual(recomputeSpent(root, 'R'), { turns: 5, tokens: 150 });
});

test('tampered event breaks chain', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendFileSync(join(runDir(root, 'R'), 'event-log.jsonl'),
    JSON.stringify({ seq: 2, ts: 'x', type: 'cost', data: { turns: 999 }, checksum: 'forged' }) + '\n');
  assert.equal(verifyLog(root, 'R').ok, false);
});
