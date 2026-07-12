import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('validate exits 0', () => {
  const out = execFileSync('node', ['scripts/deep-loop.mjs', 'validate'], { encoding: 'utf8' });
  assert.match(out, /ok/);
});

test('package.json is module type with node>=20', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, />=20/);
});

test('package.json uses portable Node test discovery without a shell glob', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test');
});

// Regression: the Claude Code plugin installer validates `.claude-plugin/plugin.json`
// against a schema where `repository` MUST be a string URL. An object form
// ({ type, url }) — valid in npm package.json — makes the manifest UNINSTALLABLE
// ("repository: expected string, received object"), so no user (and no respawned
// child session needing the deep-loop skills) can install the plugin.
test('plugin manifest is installable-shaped', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(typeof m.name, 'string');
  assert.equal(typeof m.version, 'string');
  // repository, if present, must be a string URL — never an object.
  if ('repository' in m) assert.equal(typeof m.repository, 'string', 'repository must be a string URL, not an object');
});

test('release metadata uses version 1.8.0 across both hosts and npm', () => {
  const claude = readJson('.claude-plugin/plugin.json');
  const codex = readJson('.codex-plugin/plugin.json');
  const pkg = readJson('package.json');

  assert.equal(claude.version, '1.8.0');
  assert.equal(codex.version, '1.8.0');
  assert.equal(pkg.version, '1.8.0');
});

test('durable run schema remains at 0.2.0 independently of the release version', () => {
  const schema = readJson('schemas/loop-run.schema.json');
  const initRunSource = readFileSync('scripts/lib/initrun.mjs', 'utf8');
  const validatorSource = readFileSync('scripts/lib/schema.mjs', 'utf8');

  assert.equal(schema.$schema, 'deep-loop/v0.2.0');
  assert.match(initRunSource, /schema_version:\s*'0\.2\.0'/);
  assert.match(validatorSource, /loopJson\.schema_version !== '0\.2\.0'/);
});

test('Claude and Codex manifests share release identity and declare the publisher', () => {
  const claude = readJson('.claude-plugin/plugin.json');
  const codex = readJson('.codex-plugin/plugin.json');

  for (const field of ['name', 'version', 'repository', 'license']) {
    assert.equal(codex[field], claude[field], `${field} must agree across host manifests`);
  }
  assert.deepEqual(codex.author, { name: 'Sungmin Cho' });
});

test('Codex manifest preserves its skill and interface contract', () => {
  const codex = readJson('.codex-plugin/plugin.json');

  assert.equal(codex.skills, './skills/');
  assert.deepEqual(codex.interface, {
    displayName: 'Deep Loop',
    shortDescription: 'Loop Engineering control plane over the deep-suite',
    longDescription: 'Discovers work, routes to sibling deep-* plugins as maker/checker episodes, keeps durable loop state, and hands off to fresh sessions autonomously.',
    developerName: 'Sungmin Cho',
    category: 'Coding',
    capabilities: ['Interactive', 'Read', 'Write'],
    defaultPrompt: ['$deep-loop:deep-loop "<goal>"'],
  });
});

test('both manifests advertise Claude Code, Codex CLI/App, and native Windows support', () => {
  const manifests = [
    ['Claude', readJson('.claude-plugin/plugin.json')],
    ['Codex', readJson('.codex-plugin/plugin.json')],
  ];

  for (const [host, manifest] of manifests) {
    assert.match(manifest.description, /Claude Code/i, `${host} description must mention Claude Code`);
    assert.match(manifest.description, /Codex CLI/i, `${host} description must mention Codex CLI`);
    assert.match(manifest.description, /Codex App/i, `${host} description must mention Codex App`);
    assert.match(manifest.description, /Windows/i, `${host} description must mention Windows`);
    for (const keyword of ['claude-code', 'codex-cli', 'codex-app', 'windows']) {
      assert.ok(manifest.keywords.includes(keyword), `${host} keywords must include ${keyword}`);
    }
  }
});
