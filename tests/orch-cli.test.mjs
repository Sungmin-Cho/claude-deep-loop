import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
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
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'Auth', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'in_progress');
});

test('mutating command with wrong generation is fenced (exit 3)', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '9']); }
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
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'A', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  run(root, ['workstream', 'terminal', '--id', ws.id, '--status', 'abandoned', '--proof', '{"reason":"superseded"}', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'abandoned');
  // review record: a done maker (so the checker binds — dispatchReview refuses unbound), then dispatch + record.
  const ws2 = JSON.parse(run(root, ['workstream', 'new', '--title', 'B', '--branch', 'b2', '--worktree', '.claude/worktrees/w2', '--owner', runId, '--generation', '1']));
  writeFileSync(join(root, 'plan-art.txt'), 'artifact');
  const maker = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'plan', '--point', 'plan', '--workstream', ws2.id, '--artifacts', '["plan-art.txt"]', '--owner', runId, '--generation', '1']));
  run(root, ['episode', 'record', '--id', maker.id, '--status', 'done', '--artifacts', '["plan-art.txt"]', '--owner', runId, '--generation', '1']);
  const disp = JSON.parse(run(root, ['review', 'dispatch', '--point', 'plan', '--workstream', ws2.id, '--owner', runId, '--generation', '1']));
  // #2+Fix4: a passing verdict via CLI must carry --report — a real file under the reviewed ws worktree (.claude/worktrees/w2).
  mkdirSync(join(root, '.claude/worktrees/w2'), { recursive: true });
  writeFileSync(join(root, '.claude/worktrees/w2/plan-review.md'), '# plan review');
  run(root, ['review', 'record', '--episode', disp.checkerEpisodeId, '--workstream', ws2.id, '--point', 'plan', '--verdict', 'APPROVE', '--report', '.claude/worktrees/w2/plan-review.md', '--owner', runId, '--generation', '1']);
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
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation']); }
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
  try { run(root, ['lease', 'acquire', '--owner', '--generation', '1', '--runtime', 'claude', '--run-id', runId]); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

// Codex r5 🟡3: lease acquire with missing --owner exits 3
test('lease acquire (missing --owner) exits with code 3', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['lease', 'acquire', '--generation', '1', '--runtime', 'claude', '--run-id', runId]); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

// Fix 3: workstream new missing --title exits 2 (usage error, not a fence violation)
test('workstream new missing --title exits with code 2', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '1']); }
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

// Codex review P2: episode abandon WITHOUT --confirm must exit 2 (usage/human-gate) with CONFIRM_REQUIRED,
// mirroring the recover/breaker-reset contract — NOT exit 1 from an uncaught CONFIRM_REQUIRED throw.
test('episode abandon without --confirm exits 2 with CONFIRM_REQUIRED', () => {
  const { root, runId, episodeId } = setupRunWithPendingMaker();
  let code = 0, stderr = '';
  try { run(root, ['episode', 'abandon', '--id', episodeId, '--reason', 'orphan', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; stderr = String(e.stderr || ''); }
  assert.equal(code, 2);
  assert.match(stderr, /CONFIRM_REQUIRED/);
  assert.equal(readState(root, runId).data.episodes[0].status, 'pending');   // not abandoned
});

test('CLI validate from nested .claude/worktrees cwd resolves the run (rootOf upward-search)', () => {
  const { root, runId } = seed();
  const wt = join(root, '.claude', 'worktrees', 'ws-01');
  mkdirSync(wt, { recursive: true });
  // --project-root 없이, cwd 를 worktree 로 두고 validate 호출 → run 을 찾아야 함.
  const out = execFileSync('node', [CLI, 'validate'], { cwd: wt, encoding: 'utf8' });
  assert.match(out, new RegExp(`ok \\(run ${runId}\\)`), 'validate found run from worktree cwd');
});

// ── v1.5.0 (c): parseNow malformed → 전-커맨드 공통 INVALID_NOW exit 1 (spec §4) ───
test('v1.5 (c): malformed --now → exit 1 + INVALID_NOW (read-only와 mutating 대표 커맨드)', () => {
  const { root, runId } = seed();
  const cases = [
    ['next-action', '--json', '--now', 'not-a-date'],
    ['insights', 'emit', '--now', 'not-a-date', '--owner', runId, '--generation', '1'],
  ];
  for (const args of cases) {
    let code = 0, stderr = '';
    try { run(root, args); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, /INVALID_NOW/, args.join(' '));
  }
});

test('v1.5 (c): value-less --now → exit 1 + INVALID_NOW', () => {
  const { root } = seed();
  let code = 0, stderr = '';
  try { run(root, ['next-action', '--json', '--now']); } catch (e) { code = e.status; stderr = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(stderr, /INVALID_NOW/);
});

test('v1.5 (c): Date 범위 밖 유한 숫자 --now → exit 1 + INVALID_NOW (후속 toISOString RangeError 차단, plan-r4)', () => {
  const { root } = seed();
  let code = 0, stderr = '';
  try { run(root, ['next-action', '--json', '--now', '8640000000000001']); } catch (e) { code = e.status; stderr = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(stderr, /INVALID_NOW/);
});

test('v1.5 (c): 숫자형 오타 --now(1.5/+1/-1)는 legacy Date.parse로 새지 않고 exit 1 (impl-r1)', () => {
  const { root } = seed();
  for (const bad of ['1.5', '+1', '-1']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});

test('v1.5 (c): --now 미지정·유효 ms·유효 ISO는 정상 동작 유지', () => {
  const { root } = seed();
  assert.ok(JSON.parse(run(root, ['next-action', '--json'])).action);
  assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', String(Date.parse('2026-06-24T00:00:01Z'))])).action);
  assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z'])).action);
});

test('v1.5 (c): legacy Date.parse 형식(1/2, 2026-1-1, 자연어 날짜)은 화이트리스트에서 거부 (impl-r2)', () => {
  const { root } = seed();
  for (const bad of ['1/2', '2026-1-1', 'June 24, 2026']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});

test('v1.5 (c): ISO 화이트리스트 변형(date-only, 오프셋, 밀리초)은 정상', () => {
  const { root } = seed();
  for (const ok of ['2026-06-24', '2026-06-24T00:00:01+09:00', '2026-06-24T00:00:01.500Z']) {
    assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', ok])).action, ok);
  }
});

test('v1.5 (c): 달력-무효·tz-less ISO는 롤오버/로컬 해석 없이 exit 1 (impl-r3, 2/2)', () => {
  const { root } = seed();
  for (const bad of ['2026-02-31', '2026-04-31', '2025-02-29', '2026-06-24T00:00:01']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});

test('v1.5 (c): 윤년 02-29·date-only는 UTC 자정으로 정상 (호스트 TZ 무관)', () => {
  const { root } = seed();
  for (const ok of ['2028-02-29', '2026-06-24']) {
    assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', ok])).action, ok);
  }
});

test('v1.5 (c): 범위 밖 tz 오프셋(+09:99, +24:00)은 exit 1 (impl-r4)', () => {
  const { root } = seed();
  for (const bad of ['2026-06-24T00:00:00+09:99', '2026-06-24T00:00:00+24:00']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});
