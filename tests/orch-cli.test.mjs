import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
function run(root, args) {
  return execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
}
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('next-action prints descriptor JSON (deterministic now)', () => {
  const { root } = seed();   // run created_at = 2026-06-24T00:00:00Z
  const out = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z']));
  assert.ok(out.action && out.gate);
  assert.equal(out.action.type, 'discover');   // wallclock 창 안 → handoff 아님
});

test('next-action honors --now for wallclock hard-stop', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-30T00:00:00Z'])); // > 24h
  assert.equal(out.action.type, 'handoff');
  assert.equal(out.gate.blocked_by[0], 'budget');
});

test('workstream new + set via CLI with lease', () => {
  const { root, runId } = seed();
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'Auth', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'in_progress');
});

test('mutating command with wrong generation is fenced (exit 3)', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation', '9']); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('episode new creates request + episode via CLI', () => {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl', '--point', 'implementation', '--owner', runId, '--generation', '1']));
  assert.match(ep.id, /^001-deep-work$/);
  assert.equal(readState(root, runId).data.episodes.length, 1);
});

// Codex r1 🔴6: proof-파생 터미널/리뷰 결과가 CLI 경계로 도달 가능해야 (Execution 은 CLI 로만 상태 변경).
// Fix 2: workstream terminal --status ready now uses kernel-derived proof (abandoned doesn't need review_points).
test('workstream terminal (abandoned) + review record reach kernel via CLI', () => {
  const { root, runId } = seed();
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'A', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  run(root, ['workstream', 'terminal', '--id', ws.id, '--status', 'abandoned', '--proof', '{"reason":"superseded"}', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'abandoned');
  // review record: dispatch then record outcome (checker episode)
  const ws2 = JSON.parse(run(root, ['workstream', 'new', '--title', 'B', '--branch', 'b2', '--worktree', 'w2', '--owner', runId, '--generation', '1']));
  const disp = JSON.parse(run(root, ['review', 'dispatch', '--point', 'plan', '--workstream', ws2.id, '--owner', runId, '--generation', '1']));
  run(root, ['review', 'record', '--episode', disp.checkerEpisodeId, '--workstream', ws2.id, '--point', 'plan', '--verdict', 'APPROVE', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === disp.checkerEpisodeId).status, 'approved');
});

// Fix 1: episode record --status approved/rejected exits nonzero (status 1 — invalid value, not a fence violation)
test('episode record --status approved exits with code 1', () => {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'checker', '--kind', 'impl-review', '--point', 'implementation', '--owner', runId, '--generation', '1']));
  let code = 0;
  try { run(root, ['episode', 'record', '--id', ep.id, '--status', 'approved', '--proof', '{"verdict":"APPROVE"}', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; }
  assert.equal(code, 1);
});

// Fix 5: respawn --dry-run returns JSON with ok field and exits 0
test('respawn --dry-run returns JSON with ok field', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['respawn', '--dry-run']));
  assert.ok('ok' in out);
});

// Fix 6: workstream new with --generation flag but no value exits nonzero (status 3)
test('workstream new with valueless --generation flag exits with code 3', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation']); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('handoff emit via CLI sets releasing', () => {
  const { root, runId } = seed();
  run(root, ['handoff', 'emit', '--reason', 'milestone', '--trigger', 'milestone', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
});

// Codex r5 🟡3: lease acquire with valueless --owner exits 3
test('lease acquire --owner (valueless) exits with code 3', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['lease', 'acquire', '--owner', '--generation', '1', '--run-id', runId]); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

// Codex r5 🟡3: lease acquire with missing --owner exits 3
test('lease acquire (missing --owner) exits with code 3', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['lease', 'acquire', '--generation', '1', '--run-id', runId]); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

// Fix 3: workstream new missing --title exits 2 (usage error, not a fence violation)
test('workstream new missing --title exits with code 2', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; }
  assert.equal(code, 2);
});

test('full suite still green count grows (smoke: validate ok)', () => {
  const { root } = seed();
  const out = run(root, ['validate']);
  assert.match(out, /ok/);
});

function setupRunWithPendingMaker() {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl', '--point', 'implementation', '--owner', runId, '--generation', '1']));
  return { root, runId, episodeId: ep.id };
}

// Task 9: episode abandon verb + record abandoned rejection
test('episode abandon settles a stranded pending maker (exit 0)', () => {
  const { root, runId, episodeId } = setupRunWithPendingMaker();
  run(root, ['episode', 'abandon', '--id', episodeId, '--reason', 'orphan', '--confirm', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.episodes[0].status, 'abandoned');
});

test('episode record --status abandoned is rejected (exit 1)', () => {
  const { root, runId, episodeId } = setupRunWithPendingMaker();
  let code = 0;
  try { run(root, ['episode', 'record', '--id', episodeId, '--status', 'abandoned', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; }
  assert.equal(code, 1);
});
