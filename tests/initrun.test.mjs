import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun, buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';

// Inject a no-signal env + no-op probe so detect-terminal deterministically yields launcher:'none'
// regardless of the developer's ambient terminal environment.
const noSignalEnv = {};
const noSignalPlatform = 'linux';
const noOpRun = () => ({ code: 1 });

test('buildInitialLoop autonomy defaults — spawn_style visible, new fields', () => {
  const loop = buildInitialLoop({ runId: 'r2', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun });
  assert.equal(loop.autonomy.spawn_style, 'visible');
  assert.ok(!loop.autonomy.unattended_detect.includes('non-tty'), `unattended_detect must not include 'non-tty': ${JSON.stringify(loop.autonomy.unattended_detect)}`);
  assert.ok(loop.autonomy.unattended_detect.includes('headless-invocation'), `unattended_detect must include 'headless-invocation': ${JSON.stringify(loop.autonomy.unattended_detect)}`);
  assert.equal(loop.autonomy.child_ready_timeout_sec, 75);
  assert.ok(!('allow_powershell_visible' in loop.autonomy), 'allow_powershell_visible gate removed (PowerShell auto-detects)');
  assert.ok(loop.session_spawn !== undefined && loop.session_spawn !== null, 'session_spawn must be a valid descriptor');
  assert.equal(loop.session_spawn.launcher, 'none');
  assert.equal(loop.session_spawn.reason, 'no-host-signal');  // detectTerminal result for linux/no-signals
  assert.equal(loop.session_spawn.detected_at, '2026-06-27T00:00:00.000Z');
});

test('initRun creates state, current pointer, valid schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T15:42:00Z') });
  assert.ok(existsSync(join(runDir(root, runId), 'loop.json')));
  assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), runId);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.routing.protocol, 'deep-work');
  assert.equal(data.recipe.id, 'robust-implementation');
  assert.deepEqual(data.review.points, ['design', 'plan', 'implementation']);
  assert.equal(data.autonomy.tier, 'recommend'); // 기본
  assert.equal(data.session_chain.lease.owner_run_id, runId);
});

// ── C2: object-shape initial reviewer selection regression ─────────────────────
test('C2: initRun review.reviewer routes on present (object shape)', () => {
  const r1 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { goal: 'g', detected: { 'deep-review': { present: false } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r1.loop.review.reviewer, 'subagent-checker');
  const r2 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { goal: 'g', detected: { 'deep-review': { present: true } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r2.loop.review.reviewer, 'deep-review-loop');
});
