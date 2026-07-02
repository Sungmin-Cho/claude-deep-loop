import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDesktopHandler } from '../scripts/lib/desktop-handler.mjs';

const macRun = (out, code = 0) => () => ({ code, stdout: out });
const idRp = (p) => p;   // injected realpath: tests use identity (path canonicalization tested separately elsewhere)
// Fake signature checker: a valid signature carrying the allowlisted team-id — used as the default
// injected `verifySignature` for the positive-path tests below (round-3 review Finding 3).
const okSig = () => ({ ok: true, teamId: 'TEAMID1' });
const MAC_OK = {
  platform: 'darwin', realpath: idRp,
  allowMacPaths: ['/Applications/Claude.app'], allowBundleIds: ['com.anthropic.claude'],
  verifySignature: okSig, allowTeamIds: ['TEAMID1'],
};

test('macOS: allowed app-path + bundle + valid signature + allowed team-id -> verified', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'macos-app', appPath: '/Applications/Claude.app' });
});

// Finding 3 (round-3 review): the exact spoofed-bundle-at-trusted-path attack the finding is about —
// a malicious app placed at the allowed canonical path, with the allowed bundle id (e.g. a hand-edited
// Info.plist), must still be rejected once its signature's team-id doesn't match the allowlist.
test('macOS: allowed path + allowed bundle but WRONG team-id -> unavailable (spoofed app at trusted path)', () => {
  const r = verifyDesktopHandler({
    ...MAC_OK,
    verifySignature: () => ({ ok: true, teamId: 'EVILTEAM' }),
    run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'team-id-not-allowed');
});

test('macOS: allowed path + allowed bundle but ABSENT team-id -> unavailable', () => {
  const r = verifyDesktopHandler({
    ...MAC_OK,
    verifySignature: () => ({ ok: true, teamId: null }),
    run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'team-id-not-allowed');
});

test('macOS: invalid/unsigned code signature -> unavailable (signature-invalid)', () => {
  const r = verifyDesktopHandler({
    ...MAC_OK,
    verifySignature: () => ({ ok: false }),
    run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature-invalid');
});

test('macOS: codesign runner throws -> unavailable (signature-error, fail closed)', () => {
  const r = verifyDesktopHandler({
    ...MAC_OK,
    verifySignature: () => { throw new Error('codesign: boom'); },
    run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature-error');
});

test('macOS: allowed bundle at UNTRUSTED path -> unavailable (path is the trust boundary)', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: macRun('/Users/x/Evil.app\ncom.anthropic.claude\n') });
  assert.equal(r.ok, false);            // bundle matches but path not in allowMacPaths
  assert.equal(r.reason, 'path-not-allowed');
});

test('macOS: trusted path but wrong bundle -> unavailable', () => {
  const r = verifyDesktopHandler({ ...MAC_OK, run: macRun('/Applications/Claude.app\ncom.evil\n') });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bundle-not-allowed');
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
    verifySignature: okSig,
    allowTeamIds: ['TEAMID1'],
    run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'macos-app', appPath: '/private/var/canonical/Claude.app' });
});

test('macOS: realpath throws on appPath -> unavailable (realpath-error)', () => {
  const throwingRealpath = (p) => {
    if (p === '/Applications/Claude.app') throw new Error('realpath failed');
    return p;
  };
  const r = verifyDesktopHandler({
    platform: 'darwin',
    realpath: throwingRealpath,
    allowMacPaths: ['/Applications/Claude.app'],
    allowBundleIds: ['com.anthropic.claude'],
    run: macRun('/Applications/Claude.app\ncom.anthropic.claude\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'realpath-error');
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
  assert.equal(r.reason, 'path-not-allowed');
});

test('win32: probe failure -> unavailable', () => {
  const r = verifyDesktopHandler({
    platform: 'win32',
    realpath: idRp,
    allowWinPaths: ['C:\\Program Files\\Claude\\Claude.exe'],
    run: macRun('', 1),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'probe-failed');
});

test('win32: realpath throws on exePath -> unavailable (realpath-error)', () => {
  const throwingRealpath = (p) => {
    if (p === 'C:\\Program Files\\Claude\\Claude.exe') throw new Error('realpath failed');
    return p;
  };
  const r = verifyDesktopHandler({
    platform: 'win32',
    realpath: throwingRealpath,
    allowWinPaths: ['C:\\Program Files\\Claude\\Claude.exe'],
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'realpath-error');
});

test('win32: realpath uses canonical path for comparison and result', () => {
  const rp = (p) => (p === 'C:\\Program Files\\Claude\\Claude.exe' ? 'C:\\canonical\\Claude.exe' : p);
  const r = verifyDesktopHandler({
    platform: 'win32',
    realpath: rp,
    allowWinPaths: ['C:\\canonical\\Claude.exe'],
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'win-exe', exePath: 'C:\\canonical\\Claude.exe' });
});
