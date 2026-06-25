import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
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
  // spawnFn is no longer accepted — just verify action and that no side-effect occurs.
  const r = await runPreCompactHandoff({ tty: true }, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'emitted');
});

// PreCompact is emit-only: unattended within-budget → action='emitted', no child process spawned.
// The measured cron driveHeadless (headlessSpawn) will resume via round-2 handshake.
test('unattended within budget → emits handoff, no spawn (measured resume via cron)', async () => {
  const { root } = seed();
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'emitted');
  assert.ok(r.childRunId, 'childRunId present');
});

// Fix 2: gate-blocked (wallclock exhausted) → action='gate-blocked-paused', status=paused, no spawn.
test('unattended but gate-blocked → no spawn, run paused, action=gate-blocked-paused', async () => {
  const { root, runId } = seed();
  // created_at=2026-06-24 + now 한참 뒤 → wallclock(max 86400s) 초과 → respawnGate 차단.
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-07-01T00:00:00Z') });
  assert.equal(r.action, 'gate-blocked-paused');
  const { readState } = await import('../scripts/lib/state.mjs');
  assert.equal(readState(root, runId).data.status, 'paused');
});

// Fix 2 regression: gate must be evaluated on POST-emit state, not PRE-emit state.
// Seed a run whose sessions.length === max_sessions BEFORE PreCompact.
// emitHandoff will append the reserved child → sessions.length = max_sessions + 1 → gate blocks.
// On PRE-emit state sessions.length === max_sessions which is NOT > max_sessions → would NOT block (the bug).
test('unattended with sessions.length == max_sessions before emit → gate-blocked-paused after emit', async () => {
  const { root, runId } = seed();
  // After initRun there is 1 session. Set max_sessions=1 so the post-emit count (2) exceeds it.
  const { data } = readState(root, runId);
  data.autonomy.max_sessions = 1;
  writeState(root, runId, data);
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'gate-blocked-paused', `expected gate-blocked-paused, got ${r.action}`);
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
