import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
