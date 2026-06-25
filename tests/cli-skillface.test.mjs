import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
function run(root, args) { return execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' }); }
function runFail(root, args) { try { run(root, args); return 0; } catch (e) { return e.status; } }
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-sf-'));
  const { runId } = initRun(root, { goal: 'g', protocol: 'deep-work', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

// Codex r1 should-fix-2: spec §6 의 4-verb 계약을 CLI 가 노출해야 한다 (dispatch 만 X).
test('adapter resolve returns a normalized 4-verb descriptor', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'Add auth']));
  assert.equal(out.dispatch.kind, 'invoke_skill');
  assert.equal(out.dispatch.skill, 'deep-work:deep-work-orchestrator');
  assert.match(out.dispatch.args, /Add auth/);
  assert.equal(out.await.kind, 'poll_file');
  assert.match(out.await.path, /Add auth/);          // path_template <task> 치환
  assert.ok('read' in out);                            // readArtifacts receipt 디스크립터
  assert.match(out.checker_via, /review dispatch/);    // checker 는 review dispatch CLI 경유
});

test('adapter resolve --verb selects a single verb descriptor', () => {
  const { root } = seed();
  const a = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--verb', 'await']));
  assert.equal(a.selected, 'await');
  assert.equal(a.descriptor.kind, 'poll_file');
});

test('adapter resolve blocks the deep-work implementer entirely under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, false);   // dispatch 자체가 implementer → 전체 차단
});

// Codex r7 sf-1: read-only superpowers 는 planning(writing-plans)은 허용하고 then(implementer)만 strip.
test('adapter resolve allows planning-only superpowers under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'superpowers', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, true);
  assert.equal(out.guard.planning_only, true);
  assert.equal(out.dispatch.skill, 'superpowers:writing-plans');
  assert.equal(out.dispatch.then, null);   // subagent-driven-development(implementer) 차단
});

test('adapter resolve rejects unknown protocol (exit 2)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--protocol', 'nope', '--task', 'x']), 2);
});

// Codex r1 should-fix-6: 비-fence 인자 누락은 usage 오류(exit 2)지 fence 코드(3) 가 아니다.
test('adapter resolve missing --protocol exits 2 (usage, not fence-3)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--task', 'x']), 2);
});
