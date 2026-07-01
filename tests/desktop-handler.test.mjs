import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDesktopHandler } from '../scripts/lib/desktop-handler.mjs';

const macRun = (out, code = 0) => () => ({ code, stdout: out });
const idRp = (p) => p;   // injected realpath: tests use identity (path canonicalization tested separately elsewhere)
const MAC_OK = { platform: 'darwin', realpath: idRp, allowMacPaths: ['/Applications/Claude.app'], allowBundleIds: ['com.anthropic.claude'] };

test('macOS: allowed app-path + bundle -> verified', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'macos-app', appPath: '/Applications/Claude.app' });
});

test('macOS: allowed bundle at UNTRUSTED path -> unavailable (path is the trust boundary)', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: macRun('/Users/x/Evil.app\ncom.anthropic.claude\n') });
  assert.equal(r.ok, false);            // bundle matches but path not in allowMacPaths
});

test('macOS: trusted path but wrong bundle -> unavailable', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: macRun('/Applications/Claude.app\ncom.evil\n') });
  assert.equal(r.ok, false);
});

test('probe failure -> unavailable', () => {
  assert.equal(verifyDesktopHandler({ ...MAC_OK, run: macRun('', 1) }).ok, false);
});

test('unsupported platform -> unavailable', () => {
  assert.equal(verifyDesktopHandler({ platform: 'linux', realpath: idRp, run: macRun('') }).ok, false);
});

test('macOS: probe throws -> unavailable (probe-error)', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'probe-error');
});

test('macOS: empty probe output -> unavailable (probe-empty)', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: macRun('\n\n') });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'probe-empty');
});

test('macOS: realpath uses canonical path, not raw symlink, for comparison and result', () => {
  const rp = (p) => (p === '/Applications/Claude.app' ? '/private/var/canonical/Claude.app' : p);
  const r = verifyDesktopHandler({
    platform: 'darwin',
    realpath: rp,
    allowMacPaths: ['/private/var/canonical/Claude.app'],
    allowBundleIds: ['com.anthropic.claude'],
    run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'macos-app', appPath: '/private/var/canonical/Claude.app' });
});

test('win32: allowed exe path -> verified', () => {
  const r = verifyDesktopHandler({
    platform: 'win32',
    realpath: idRp,
    allowWinPaths: ['C:\\Program Files\\Claude\\Claude.exe'],
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'win-exe', exePath: 'C:\\Program Files\\Claude\\Claude.exe' });
});

test('win32: exe path not in allowlist -> unavailable', () => {
  const r = verifyDesktopHandler({
    platform: 'win32',
    realpath: idRp,
    allowWinPaths: ['C:\\Program Files\\Claude\\Claude.exe'],
    run: macRun('C:\\Users\\x\\Evil.exe\n'),
  });
  assert.equal(r.ok, false);
});

test('win32: probe failure -> unavailable', () => {
  const r = verifyDesktopHandler({
    platform: 'win32',
    realpath: idRp,
    allowWinPaths: ['C:\\Program Files\\Claude\\Claude.exe'],
    run: macRun('', 1),
  });
  assert.equal(r.ok, false);
});
