import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPlugins, pluginPresent } from '../scripts/lib/detect.mjs';

// versioned marketplace layout: <home>/<runtimeDir>/plugins/cache/<market>/<plugin>/<version>/<manifestDir>/plugin.json
function writeVersioned(home, runtimeDir, plugin, version, manifestDir) {
  const p = join(home, runtimeDir, 'plugins', 'cache', 'm1', plugin, version, manifestDir);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'plugin.json'), JSON.stringify({ name: plugin }));
}
// direct (git/local) layout: <home>/<runtimeDir>/plugins/cache/<entry>/<manifestDir>/plugin.json (name only in manifest)
function writeDirect(home, runtimeDir, entry, plugin, manifestDir) {
  const p = join(home, runtimeDir, 'plugins', 'cache', entry, manifestDir);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'plugin.json'), JSON.stringify({ name: plugin }));
}

test('C1: marker only → initialized:true, installed:false, present:true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  mkdirSync(join(root, '.deep-review'), { recursive: true });
  writeFileSync(join(root, '.deep-review', 'config.yaml'), 'x');
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const d = detectPlugins(root, home);
  assert.equal(d['deep-review'].initialized, true);
  assert.equal(d['deep-review'].installed, false);
  assert.equal(d['deep-review'].present, true);
});

test('C1: versioned manifest in Claude cache → installed:true, present:true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeVersioned(home, '.claude', 'deep-review', '1.12.2', '.claude-plugin');
  const d = detectPlugins(root, home);
  assert.equal(d['deep-review'].installed, true);
  assert.equal(d['deep-review'].present, true);
});

test('C1: union — manifest in EITHER runtime cache counts as installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeVersioned(home, '.codex', 'deep-work', '9.9.9', '.codex-plugin');   // installed only in Codex cache
  const d = detectPlugins(root, home);
  assert.equal(d['deep-work'].installed, true, 'a plugin installed in either runtime cache is installed (union)');
  assert.equal(d['deep-work'].present, true);
});

test('C1: direct git/local layout (manifest name, not versioned dirs) → installed:true — IMPL-ADV5', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeDirect(home, '.claude', 'temp_git_1781511107439_ereflh', 'deep-review', '.claude-plugin');
  const d = detectPlugins(root, home);
  assert.equal(d['deep-review'].installed, true, 'direct cache entry with manifest name must be detected');
});

test('C1: stale dir without a manifest → installed:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(home, '.claude', 'plugins', 'cache', 'm1', 'deep-review', '1.0.0'), { recursive: true }); // no plugin.json
  const d = detectPlugins(root, home);
  assert.equal(d['deep-review'].installed, false);
});

test('C1: manifest without a matching name → not counted for that plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeDirect(home, '.claude', 'temp_git_other', 'some-unrelated-plugin', '.claude-plugin');
  const d = detectPlugins(root, home);
  assert.equal(d['deep-review'].installed, false);
});

test('C1: nothing present → all false', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const d = detectPlugins(root, home);
  assert.equal(Object.values(d).every((v) => v.present === false), true);
});

test('C1: pluginPresent tolerates object and legacy boolean', () => {
  assert.equal(pluginPresent({ a: true }, 'a'), true);
  assert.equal(pluginPresent({ a: { present: true } }, 'a'), true);
  assert.equal(pluginPresent({ a: { present: false } }, 'a'), false);
  assert.equal(pluginPresent({}, 'a'), false);
});
