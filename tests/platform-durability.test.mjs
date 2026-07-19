import testDurability from 'node:test';
import assertDurability from 'node:assert/strict';
import { mkdtempSync as mkdtempDurability, readdirSync as listDurability }
  from 'node:fs';
import { tmpdir as tmpDurability } from 'node:os';
import { join as joinDurability } from 'node:path';
import { initRun as initDurability } from '../scripts/lib/initrun.mjs';
import { patch as patchDurability, readState as stateDurability,
  runDir as runDirDurability } from '../scripts/lib/state.mjs';
import { readLines as linesDurability, verifyLog as verifyDurability }
  from '../scripts/lib/integrity.mjs';

testDurability('real platform publishes durable genesis and one anchored journal mutation', () => {
  const root = mkdtempDurability(joinDurability(tmpDurability(), 'dl-platform-durable-'));
  const { runId } = initDurability(root, { runtime: 'codex', goal: 'platform durability',
    protocol: 'standalone', recipe: 'default',
    now: new Date('2026-07-13T00:00:00.000Z') });
  const genesis = stateDurability(root, runId).data;
  assertDurability.equal(linesDurability(root, runId)
    .filter(event => event.type === 'run-initialized').length, 1);
  patchDurability(root, runId, 'discovered_items', ['real-platform-journal'], {
    fence: { owner: runId, generation: 1, intent: 'business' },
  });
  const final = stateDurability(root, runId).data;
  assertDurability.deepEqual(final.discovered_items, ['real-platform-journal']);
  assertDurability.notEqual(final.event_log_head, genesis.event_log_head);
  assertDurability.equal(verifyDurability(root, runId).ok, true);
  const journalArtifacts = listDurability(runDirDurability(root, runId)).sort()
    .filter(name => name.startsWith('.anchored-') || name.endsWith('.replace'));
  assertDurability.deepEqual(journalArtifacts, ['.anchored-committed.json']);
});
