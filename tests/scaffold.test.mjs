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

// Regression: the Claude Code plugin installer validates `.claude-plugin/plugin.json`
// against a schema where `repository` MUST be a string URL. An object form
// ({ type, url }) — valid in npm package.json — makes the manifest UNINSTALLABLE
// ("repository: expected string, received object"), so no user (and no respawned
// child session needing the deep-loop skills) can install the plugin.
test('plugin manifest is installable-shaped', () => {
  const m = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
  assert.equal(typeof m.name, 'string');
  assert.equal(typeof m.version, 'string');
  // repository, if present, must be a string URL — never an object.
  if ('repository' in m) assert.equal(typeof m.repository, 'string', 'repository must be a string URL, not an object');
});
