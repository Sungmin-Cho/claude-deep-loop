import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containedRealFile, normalizePortableRelativePath, pathWithin } from '../scripts/lib/fs-safe.mjs';
import * as fsFixtures from './helpers/fs-fixtures.mjs';

const {
  createDirectoryJunction,
  createFileSymlinkOrSkip,
  fixtureDir,
} = fsFixtures;

const TESTS_ROOT = dirname(fileURLToPath(import.meta.url));

function base() { return fixtureDir('dl-fss-'); }

function discoveredTestFiles(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...discoveredTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) paths.push(path);
  }
  return paths;
}

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

test('base file-symlink fixture always requests a file link and propagates every failure', () => {
  assert.equal(typeof fsFixtures.createFileSymlink, 'function');
  let call = null;
  fsFixtures.createFileSymlink('target', 'link', {
    symlink(...args) { call = args; },
  });
  assert.deepEqual(call, ['target', 'link', 'file']);

  const failure = Object.assign(new Error('denied'), { code: 'EPERM' });
  assert.throws(() => fsFixtures.createFileSymlink('target', 'link', {
    symlink() { throw failure; },
  }), error => error === failure);
});

test('directory fixture requests a junction on Windows and a directory link elsewhere', () => {
  const calls = [];
  for (const platform of ['win32', 'linux']) {
    createDirectoryJunction('target', 'link', {
      platform,
      symlink(...args) { calls.push(args); },
    });
  }
  assert.deepEqual(calls, [
    ['target', 'link', 'junction'],
    ['target', 'link', 'dir'],
  ]);
});

test('portable discovered tests centralize every symlink fixture syscall', () => {
  const directSymlinkCall = new RegExp(`\\b${['symlink', 'Sync'].join('')}\\s*\\(`);
  const paths = [
    ...discoveredTestFiles(TESTS_ROOT),
    join(TESTS_ROOT, 'fixtures', 'fake-codex-native.mjs'),
  ];
  const violations = [];
  for (const path of paths) {
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (directSymlinkCall.test(line)) violations.push(`${relative(TESTS_ROOT, path)}:${index + 1}`);
    });
  }
  assert.deepEqual(violations, []);
});
