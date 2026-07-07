import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runDir } from '../scripts/lib/state.mjs';

function runValidate(args = []) {
  try {
    execFileSync('node', ['scripts/deep-loop.mjs', 'validate', ...args], { encoding: 'utf8' });
    return 0;
  } catch (e) { return e.status ?? 1; }
}

test('validate exits 0 with no run (schema+builder self-test)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  assert.equal(runValidate(['--project-root', root]), 0);
});

test('validate exits 0 for a freshly initialized run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'x', detected: {}, now: new Date() });
  assert.equal(runValidate(['--project-root', root, '--run-id', runId]), 0);
});

test('validate exits nonzero when loop.json is corrupted (hash anchor fires)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'x', detected: {}, now: new Date() });
  writeFileSync(join(runDir(root, runId), 'loop.json'), '{"goal":"hacked"}'); // hash mismatch
  assert.notEqual(runValidate(['--project-root', root, '--run-id', runId]), 0);
});

// ── impl-R3 🟡C: recipes fail-closed 검증 — 런타임 loadRecipes는 fail-soft(skip)지만, 손상은
// validate(preflight/머지 게이트)가 파일명과 함께 fail-closed로 잡아야 silent 라우팅 변경이 없다 ───
test('validate exits nonzero when a recipes/*.json is malformed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'broken.json'), '{oops');
  assert.notEqual(runValidate(['--project-root', root]), 0);
});
test('validate exits nonzero when a non-ledger recipe lacks a triggers array', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'not-a-recipe.json'), JSON.stringify({ id: 'x' }));
  assert.notEqual(runValidate(['--project-root', root]), 0);
});
test('validate exits 0 with valid recipes + array ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'ok.json'), JSON.stringify({ id: 'ok', triggers: ['x'] }));
  writeFileSync(join(root, 'recipes', 'hillclimb-ledger.json'), '[]');
  assert.equal(runValidate(['--project-root', root]), 0);
});
