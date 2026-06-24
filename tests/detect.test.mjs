import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPlugins } from '../scripts/lib/detect.mjs';

test('detects deep-review by .deep-review/config.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, '.deep-review'), { recursive: true });
  writeFileSync(join(root, '.deep-review', 'config.yaml'), 'x');
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  assert.equal(detectPlugins(root, home)['deep-review'], true);
  assert.equal(detectPlugins(root, home)['deep-wiki'], false);
});

test('missing siblings report false, never throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const d = detectPlugins(root, home);
  assert.equal(Object.values(d).every(v => v === false), true);
});
