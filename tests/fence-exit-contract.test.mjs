import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');

function invoke(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    encoding: 'utf8',
  });
}

function copiedFenceFixture() {
  const parent = mkdtempSync(join(tmpdir(), 'dl-fence-ab-'));
  const stored = join(parent, 'A');
  const candidate = join(parent, 'B');
  mkdirSync(stored);
  mkdirSync(candidate);
  const created = invoke(stored, ['init-run', '--runtime', 'claude', '--goal', 'g', '--protocol', 'standalone']);
  assert.equal(created.status, 0, created.stderr);
  const runId = JSON.parse(created.stdout).run_id;
  const acquired = invoke(stored, [
    'lease', 'acquire', '--runtime', 'claude', '--owner', 'O1', '--generation', '1', '--run-id', runId,
  ]);
  assert.equal(acquired.status, 0, acquired.stderr);
  cpSync(join(stored, '.deep-loop'), join(candidate, '.deep-loop'), { recursive: true });
  return { stored, candidate, runId };
}

function assertFence3(candidate, args, label) {
  const result = invoke(candidate, args);
  assert.equal(result.status, 3, `${label}: status=${result.status} stderr=${result.stderr}`);
  assert.match(result.stderr, /PROJECT_ROOT_FENCED/, label);
}

test('mutating routes that used to fold PROJECT_ROOT_FENCED now exit 3', () => {
  const { candidate, runId } = copiedFenceFixture();
  const fence = ['--owner', 'O1', '--generation', '1', '--run-id', runId];
  const cases = [
    ['pause', ['pause', '--mode', 'preserve', '--reason', 'p', ...fence]],
    ['breaker reset', ['breaker', 'reset', '--confirm', ...fence]],
    ['recover', ['recover', '--confirm', ...fence]],
    ['recover supersede', ['recover', '--supersede-affinity', '--reason', 'r', '--confirm', ...fence]],
    ['recovery acquire', ['recovery', 'acquire', '--capsule', 'recoveries/root/x.json', '--runtime', 'claude', ...fence]],
    ['attended-launch revoke', ['attended-launch', 'revoke', '--confirm', ...fence]],
    ['spawn-style reset-desktop', ['spawn-style', 'reset-desktop', ...fence]],
    ['budget extend', ['budget', 'extend', '--turns', '10', '--reason', 'r', '--confirm', ...fence]],
    ['root recovery acquire', [
      'root', 'recovery', 'acquire',
      '--candidate-project-root', candidate,
      '--capsule', 'recoveries/root/x.json',
      '--runtime', 'claude',
      '--binding-generation', '1',
      ...fence,
    ]],
  ];
  for (const [label, args] of cases) assertFence3(candidate, args, label);
});

test('requireLease-bypass routes that already used classifyKernelError stay exit 3', () => {
  const { candidate, runId } = copiedFenceFixture();
  const fence = ['--owner', 'O1', '--generation', '1', '--run-id', runId];
  assertFence3(candidate, ['lease', 'acquire', '--runtime', 'claude', ...fence], 'lease acquire');
  assertFence3(candidate, ['lease', 'release', ...fence], 'lease release');
  assertFence3(candidate, ['checkpoint', 'emit', '--runtime', 'claude', ...fence], 'checkpoint emit');
});

test('requireLease-path controls also keep PROJECT_ROOT_FENCED at exit 3', () => {
  const { candidate, runId } = copiedFenceFixture();
  const fence = ['--owner', 'O1', '--generation', '1', '--run-id', runId];
  assertFence3(candidate, ['spawn-style', 'offer-desktop', ...fence], 'spawn-style offer-desktop');
});

test('next-action and state get keep PROJECT_ROOT_FENCED at exit 1', () => {
  const { candidate, runId } = copiedFenceFixture();
  for (const [label, args] of [
    ['next-action', ['next-action', '--run-id', runId]],
    ['state get', ['state', 'get', '--run-id', runId]],
  ]) {
    const result = invoke(candidate, args);
    assert.equal(result.status, 1, `${label}: status=${result.status} stderr=${result.stderr}`);
    assert.match(result.stderr, /PROJECT_ROOT_FENCED/, label);
  }
});
