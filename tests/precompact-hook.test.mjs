import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runPreCompactHandoff } from '../scripts/hooks-impl/precompact-handoff.mjs';
const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('no current run → no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc0-'));
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'no-run');
});

test('interactive → emits handoff, no spawn', async () => {
  const { root } = seed();
  let spawned = false;
  const r = await runPreCompactHandoff({ tty: true }, { root, now: Date.parse('2026-06-24T00:01:00Z'), spawnFn: () => { spawned = true; return { ok: true }; } });
  assert.equal(r.action, 'emitted');
  assert.equal(spawned, false);
});

test('unattended → emits + respawns with injected spawnFn', async () => {
  const { root } = seed();
  let spawnedCmd = null;
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z'), spawnFn: (cmd) => { spawnedCmd = cmd; return { ok: true }; } });
  assert.equal(r.action, 'respawned');
  assert.match(spawnedCmd, /claude -p/);
  assert.match(spawnedCmd, /--output-format json/);   // Codex r6 sf-4: 측정 가능한 출력 요청
});

// Codex r1 should-fix-3: gate 차단(wallclock 소진) headless PreCompact 는 spawn 하지 않고 status=paused.
test('unattended but gate-blocked → no spawn, run paused', async () => {
  const { root, runId } = seed();
  let spawned = false;
  // created_at=2026-06-24 + now 한참 뒤 → wallclock(max 86400s) 초과 → respawnGate 차단.
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-07-01T00:00:00Z'), spawnFn: () => { spawned = true; return { ok: true }; } });
  assert.equal(spawned, false);
  assert.equal(r.action, 'gate-blocked');
  const { readState } = await import('../scripts/lib/state.mjs');
  assert.equal(readState(root, runId).data.status, 'paused');
});

test('hooks.json declares PreCompact → precompact-handoff.sh', () => {
  const h = JSON.parse(rf(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(h.hooks.PreCompact, 'PreCompact event present');
  const cmd = h.hooks.PreCompact[0].hooks[0].command;
  assert.match(cmd, /precompact-handoff\.sh/);
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test('precompact-handoff.sh is Bash 3.2 safe', () => {
  const sh = rf(join(PROOT, 'hooks', 'scripts', 'precompact-handoff.sh'), 'utf8');
  assert.match(sh, /set -Eeuo pipefail/);
  assert.ok(!/declare -A/.test(sh), 'no associative arrays');
  assert.ok(!/\$\{[A-Za-z_]+,,\}/.test(sh), 'no ${var,,} lowercasing');
  assert.match(sh, /precompact-handoff\.mjs/);
});
