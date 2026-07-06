import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containedRealFile } from '../scripts/lib/fs-safe.mjs';

function base() { return mkdtempSync(join(tmpdir(), 'dl-fss-')); }

test('containedRealFile returns the canonical path of an existing contained regular file', () => {
  const b = base();
  writeFileSync(join(b, 'r.md'), 'x');
  assert.equal(containedRealFile(b, 'r.md'), realpathSync(join(b, 'r.md')));
  mkdirSync(join(b, 'sub'));
  writeFileSync(join(b, 'sub', 'nested.md'), 'x');
  assert.equal(containedRealFile(b, 'sub/nested.md'), realpathSync(join(b, 'sub', 'nested.md')));
});

test('containedRealFile rejects absolute, .., missing, non-string, and directory targets', () => {
  const b = base();
  writeFileSync(join(b, 'r.md'), 'x');
  mkdirSync(join(b, 'dir'));
  assert.equal(containedRealFile(b, '/etc/passwd'), null);
  assert.equal(containedRealFile(b, '../r.md'), null);
  assert.equal(containedRealFile(b, 'missing.md'), null);
  assert.equal(containedRealFile(b, ''), null);
  assert.equal(containedRealFile(b, undefined), null);
  assert.equal(containedRealFile(b, 'dir'), null);   // a directory is not a file
});

test('containedRealFile rejects a root-relative symlink escaping the base (realpath deref)', () => {
  const b = base();
  const outside = base();
  writeFileSync(join(outside, 'secret.md'), 'x');
  symlinkSync(join(outside, 'secret.md'), join(b, 'link.md'));
  assert.equal(containedRealFile(b, 'link.md'), null);
  // …but an INTERNAL symlink (staying under base) is allowed.
  writeFileSync(join(b, 'real.md'), 'x');
  symlinkSync(join(b, 'real.md'), join(b, 'inner-link.md'));
  assert.equal(containedRealFile(b, 'inner-link.md'), realpathSync(join(b, 'real.md')));
});
