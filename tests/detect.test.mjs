import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPlugins, pluginPresent } from '../scripts/lib/detect.mjs';

// Synthetic resolved-module-path under each runtime cache (this is what import.meta.url resolves to in prod).
const claudeMod = (home) => join(home, '.claude', 'plugins', 'cache', 'deep-loop', '0.1.0', 'scripts', 'lib', 'detect.mjs');
const codexMod  = (home) => join(home, '.codex', 'plugins', 'cache', 'deep-loop', '0.1.0', 'scripts', 'lib', 'detect.mjs');
function writeManifest(home, runtimeDir, plugin, version, manifestDir) {
  const p = join(home, runtimeDir, 'plugins', 'cache', 'm1', plugin, version, manifestDir);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'plugin.json'), '{}');
}

test('C1: marker only → initialized:true, installed:false, present:true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  mkdirSync(join(root, '.deep-review'), { recursive: true });
  writeFileSync(join(root, '.deep-review', 'config.yaml'), 'x');
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const d = detectPlugins(root, home, claudeMod(home));
  assert.equal(d['deep-review'].initialized, true);
  assert.equal(d['deep-review'].installed, false);
  assert.equal(d['deep-review'].present, true);
});

test('C1: versioned manifest in CURRENT (Claude) runtime cache → installed:true, present:true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeManifest(home, '.claude', 'deep-review', '1.12.2', '.claude-plugin');
  const d = detectPlugins(root, home, claudeMod(home));
  assert.equal(d['deep-review'].installed, true);
  assert.equal(d['deep-review'].present, true);
});

test('C1: Codex-only cache under Claude runtime → installed:false, installed_other:true, present:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeManifest(home, '.codex', 'deep-review', '9.9.9', '.codex-plugin');
  const d = detectPlugins(root, home, claudeMod(home));   // running under Claude
  assert.equal(d['deep-review'].installed, false);
  assert.equal(d['deep-review'].installed_other, true);
  assert.equal(d['deep-review'].present, false);
});

test('C1: Claude-only cache under Codex runtime → installed:false, installed_other:true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeManifest(home, '.claude', 'deep-review', '1.12.2', '.claude-plugin');
  const d = detectPlugins(root, home, codexMod(home));    // running under Codex
  assert.equal(d['deep-review'].installed, false);
  assert.equal(d['deep-review'].installed_other, true);
});

test('C1: current-runtime match (Codex cache under Codex) → installed:true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeManifest(home, '.codex', 'deep-review', '9.9.9', '.codex-plugin');
  const d = detectPlugins(root, home, codexMod(home));
  assert.equal(d['deep-review'].installed, true);
  assert.equal(d['deep-review'].present, true);
});

test('C1: stale dir without manifest → installed:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(home, '.claude', 'plugins', 'cache', 'm1', 'deep-review', '1.0.0'), { recursive: true }); // no plugin.json
  const d = detectPlugins(root, home, claudeMod(home));
  assert.equal(d['deep-review'].installed, false);
});

test('C1: runtime derives from module path, not spoofable env (plan-ADV4)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  writeManifest(home, '.claude', 'deep-review', '1.12.2', '.claude-plugin');
  const prevEnv = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = join('X:', 'spoof', '.codex', 'plugins', 'cache');  // hostile spoof toward Codex
  try {
    const d = detectPlugins(root, home, claudeMod(home));   // module path says Claude; env ignored
    assert.equal(d['deep-review'].installed, true);
    // dev/standalone module path (neither cache) → Claude default, still finds the Claude manifest
    const d2 = detectPlugins(root, home, join(home, 'Dev', 'deep-loop', 'scripts', 'lib', 'detect.mjs'));
    assert.equal(d2['deep-review'].installed, true);
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = prevEnv;
  }
});

test('C1: nothing present → all false', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-c1-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const d = detectPlugins(root, home, claudeMod(home));
  assert.equal(Object.values(d).every((v) => v.present === false), true);
});

test('C1: pluginPresent tolerates object and legacy boolean', () => {
  assert.equal(pluginPresent({ a: true }, 'a'), true);
  assert.equal(pluginPresent({ a: { present: true } }, 'a'), true);
  assert.equal(pluginPresent({ a: { present: false } }, 'a'), false);
  assert.equal(pluginPresent({}, 'a'), false);
});
