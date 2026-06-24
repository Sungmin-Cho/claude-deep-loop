import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('validate exits 0', () => {
  const out = execFileSync('node', ['scripts/deep-loop.mjs', 'validate'], { encoding: 'utf8' });
  assert.match(out, /ok/);
});

test('package.json is module type with node>=20', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, />=20/);
});
