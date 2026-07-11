import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { containedRealFile, normalizePortableRelativePath, pathWithin } from '../scripts/lib/fs-safe.mjs';
import {
  createDirectoryJunction,
  createFileSymlinkOrSkip,
  fixtureDir,
} from './helpers/fs-fixtures.mjs';

function base() { return fixtureDir('dl-fss-'); }

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

test('containedRealFile rejects a root-relative symlink escaping the base (realpath deref)', (t) => {
  const b = base();
  const outside = base();
  writeFileSync(join(outside, 'secret.md'), 'x');
  if (!createFileSymlinkOrSkip(t, join(outside, 'secret.md'), join(b, 'link.md'))) return;
  assert.equal(containedRealFile(b, 'link.md'), null);
  // …but an INTERNAL symlink (staying under base) is allowed.
  writeFileSync(join(b, 'real.md'), 'x');
  if (!createFileSymlinkOrSkip(t, join(b, 'real.md'), join(b, 'inner-link.md'))) return;
  assert.equal(containedRealFile(b, 'inner-link.md'), realpathSync(join(b, 'real.md')));
});

test('containedRealFile rejects a directory junction escaping the base', () => {
  const b = base();
  const outside = base();
  writeFileSync(join(outside, 'secret.md'), 'x');
  createDirectoryJunction(outside, join(b, 'junction'));
  assert.equal(containedRealFile(b, 'junction/secret.md'), null);
});

test('pathWithin compares canonical Windows paths case-insensitively with segment boundaries', () => {
  const options = { pathApi: win32, platform: 'win32' };
  assert.equal(pathWithin('C:\\', 'C:\\repo\\worktree\\report.md', options), true);
  assert.equal(pathWithin('C:\\Repo', 'c:\\repo\\worktree\\report.md', options), true);
  assert.equal(pathWithin('C:\\Repo', 'c:\\repository\\report.md', options), false);
  assert.equal(pathWithin('C:\\', 'D:\\repo\\report.md', options), false);
  assert.equal(pathWithin('\\\\server\\share\\', '\\\\server\\share\\reports\\r.md', options), true);
  assert.equal(pathWithin('\\\\SERVER\\Share', '\\\\server\\share\\reports\\r.md', options), true);
  assert.equal(pathWithin('\\\\server\\share\\', '\\\\server\\other\\reports\\r.md', options), false);
});

test('portable durable paths normalize backslashes without becoming filesystem absolutes', () => {
  assert.equal(normalizePortableRelativePath('.claude\\worktrees\\ws\\report.md'), '.claude/worktrees/ws/report.md');
  assert.equal(normalizePortableRelativePath('C:\\repo\\report.md'), null);
  assert.equal(normalizePortableRelativePath('\\\\server\\share\\report.md'), null);
});

test('file-symlink fixture skips only native Windows EPERM and rethrows every other failure', () => {
  let skipped = null;
  const context = { skip(reason) { skipped = reason; } };
  const eperm = Object.assign(new Error('privilege'), { code: 'EPERM' });
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  const throwing = error => () => { throw error; };

  assert.equal(createFileSymlinkOrSkip(context, 'target', 'link', {
    platform: 'win32', symlink: throwing(eperm),
  }), false);
  assert.match(skipped, /EPERM/);
  assert.throws(() => createFileSymlinkOrSkip(context, 'target', 'link', {
    platform: 'win32', symlink: throwing(eacces),
  }), error => error === eacces);
  assert.throws(() => createFileSymlinkOrSkip(context, 'target', 'link', {
    platform: 'darwin', symlink: throwing(eperm),
  }), error => error === eperm);
});
