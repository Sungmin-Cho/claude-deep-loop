import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runDir } from '../scripts/lib/state.mjs';

function runValidate(args = []) {
  try {
    execFileSync('node', ['scripts/deep-loop.mjs', 'validate', ...args], { encoding: 'utf8' });
    return 0;
  } catch (e) { return e.status ?? 1; }
}

const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));
function runCli(args) {
  return spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('CLI init-run missing runtime exits 2 and creates no run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-runtime-cli-'));
  const result = runCli(['init-run', '--goal', 'g', '--project-root', root]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /runtime/i);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('CLI init-run invalid runtime exits 1 and creates no run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-runtime-cli-'));
  const result = runCli(['init-run', '--goal', 'g', '--runtime', 'other', '--project-root', root]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /INVALID_RUNTIME/);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('validate exits 0 with no run (schema+builder self-test)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  assert.equal(runValidate(['--project-root', root]), 0);
});

test('validate exits 0 for a freshly initialized run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'x', detected: {}, now: new Date() });
  assert.equal(runValidate(['--project-root', root, '--run-id', runId]), 0);
});

test('validate exits nonzero when loop.json is corrupted (hash anchor fires)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'x', detected: {}, now: new Date() });
  writeFileSync(join(runDir(root, runId), 'loop.json'), '{"goal":"hacked"}'); // hash mismatch
  assert.notEqual(runValidate(['--project-root', root, '--run-id', runId]), 0);
});

// ── impl-R3 🟡C + Phase6 ITEM-1: recipes/ledger fail-closed 검증은 런타임 라우팅이 실제로 읽는
// **플러그인 번들 recipesDir** 기준이다 (project-root 기준이 아님) — --project-root가 타 프로젝트를
// 가리켜도 그 프로젝트 자체의 recipes/*.json은 검사 대상이 아니다(false-failure 방지, validateRecipesDir
// 유닛 테스트는 tests/recipes.test.mjs가 주입 dir로 fail-closed 동작을 직접 검증한다).
test('validate exits 0 even when --project-root has its own malformed recipes/*.json (project-root recipes/ is not the validated dir)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'broken.json'), '{oops');
  assert.equal(runValidate(['--project-root', root]), 0);
});
test('validate exits 0 even when a --project-root recipe lacks a triggers array (project-root recipes/ is not the validated dir)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'not-a-recipe.json'), JSON.stringify({ id: 'x' }));
  assert.equal(runValidate(['--project-root', root]), 0);
});
test('validate exits 0 with valid recipes + array ledger under --project-root (irrelevant to validated dir, still harmless)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, 'recipes'), { recursive: true });
  writeFileSync(join(root, 'recipes', 'ok.json'), JSON.stringify({ id: 'ok', triggers: ['x'] }));
  writeFileSync(join(root, 'recipes', 'hillclimb-ledger.json'), '[]');
  assert.equal(runValidate(['--project-root', root]), 0);
});
// The bundled recipesDir itself (this repo's recipes/) must always validate clean, regardless of --project-root.
test('validate exits 0 for the bundled recipes/ dir (validated independent of --project-root)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  assert.equal(runValidate(['--project-root', root]), 0);
});
