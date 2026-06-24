import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, verifyLog, recomputeSpent } from '../scripts/lib/integrity.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';

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

// Codex impl r12 🔴: appendAnchored must NOT launder a suffix-truncated log — it fails closed before appending,
// so the stale anchor is preserved (reconcile can still detect the loss) rather than overwritten.
test('appendAnchored fails closed on a truncated event log (no launder)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  recordCost(root, runId, { turns: 1, tokens: 10 });
  recordCost(root, runId, { turns: 1, tokens: 10 });
  const anchorBefore = readState(root, runId).data.event_log_head;
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  writeFileSync(logPath, lines.slice(0, -1).join('\n') + '\n');   // suffix-truncate the last event
  assert.throws(() => recordCost(root, runId, { turns: 1, tokens: 10 }), /LOG_TAMPERED/);
  // anchor must NOT have advanced (no laundering of the truncation)
  assert.deepEqual(readState(root, runId).data.event_log_head, anchorBefore);
});
