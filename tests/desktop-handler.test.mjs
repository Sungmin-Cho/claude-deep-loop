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

// Fake Windows Authenticode verifier: a valid signature carrying the allowlisted publisher — used
// as the default injected `verifyWinSignature` for the positive-path tests below (round-5 review
// Finding 1, parity with macOS's okSig/allowTeamIds).
const okWinSig = () => ({ ok: true, publisher: 'CN=Anthropic PBC', thumbprint: 'ABCDEF1234' });
const WIN_OK = {
  platform: 'win32', realpath: idRp,
  allowWinPaths: ['C:\\Program Files\\Claude\\Claude.exe'],
  verifyWinSignature: okWinSig, allowWinPublishers: ['CN=Anthropic PBC'],
};

test('win32: allowed exe path -> verified', () => {
  const r = verifyDesktopHandler({
    ...WIN_OK,
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'win-exe', exePath: 'C:\\Program Files\\Claude\\Claude.exe' });
});

// Round-5 review Finding 1: path-only verification would let a replaced/junctioned exe at an
// allowlisted path pass. (a) valid sig + allowed publisher -> ok:true (covered by the test above).
test('win32: path allowed but INVALID/absent Authenticode signature -> unavailable (signature-invalid)', () => {
  const r = verifyDesktopHandler({
    ...WIN_OK,
    verifyWinSignature: () => ({ ok: false }),
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature-invalid');
});

test('win32: Authenticode verifier throws -> unavailable (signature-error, fail closed)', () => {
  const r = verifyDesktopHandler({
    ...WIN_OK,
    verifyWinSignature: () => { throw new Error('Get-AuthenticodeSignature: boom'); },
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signature-error');
});

// (c) valid sig but WRONG publisher -> unavailable (the junction/replace case the finding is about:
// a malicious exe placed at the allowed canonical path, validly signed by SOMEONE ELSE, must still
// be rejected).
test('win32: path allowed + valid signature but WRONG publisher -> unavailable (publisher-not-allowed)', () => {
  const r = verifyDesktopHandler({
    ...WIN_OK,
    verifyWinSignature: () => ({ ok: true, publisher: 'CN=Evil Corp', thumbprint: 'EVILTHUMB' }),
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'publisher-not-allowed');
});

test('win32: valid signature matched by THUMBPRINT (not publisher string) -> verified', () => {
  const r = verifyDesktopHandler({
    ...WIN_OK,
    allowWinPublishers: ['ABCDEF1234'],
    verifyWinSignature: () => ({ ok: true, publisher: 'CN=Some Other Subject', thumbprint: 'ABCDEF1234' }),
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, true);
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
    ...WIN_OK,
    realpath: rp,
    allowWinPaths: ['C:\\canonical\\Claude.exe'],
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'win-exe', exePath: 'C:\\canonical\\Claude.exe' });
});

// ── WS2 (v1.7.0): MSIX 설치 경로 패턴 지원 ───────────────────────────────────
// 실기 관측(2026-07-09, Windows 11): claude:// 핸들러가 MSIX/Store 패키지로 등록됨 —
// C:\Program Files\WindowsApps\Claude_<버전>_x64__pzs8sxrjxfjjc\app\Claude.exe.
// 버전 문자열이 경로에 박혀 정확-일치 allowlist로는 pin 불가(업데이트마다 변경).
// allowWinPathPatterns(RegExp[])가 정확-일치 실패 시의 2차 매처 — publisher-id 해시는 고정.
const MSIX_RE = /^C:\\Program Files\\WindowsApps\\Claude_[0-9.]+_x64__pzs8sxrjxfjjc\\app\\Claude\.exe$/i;

test('win32: MSIX versioned path matches allowWinPathPatterns and passes with valid pinned signature', () => {
  const msix = 'C:\\Program Files\\WindowsApps\\Claude_1.18286.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';
  const r = verifyDesktopHandler({
    platform: 'win32', realpath: idRp,
    allowWinPaths: ['C:\\Program Files\\Claude\\Claude.exe'],
    allowWinPathPatterns: [MSIX_RE],
    allowWinPublishers: ['0D7581D2C51C59DF686C3000C70BF543F9F6C6CB'],
    verifyWinSignature: () => ({ ok: true, publisher: 'CN="Anthropic, PBC"', thumbprint: '0D7581D2C51C59DF686C3000C70BF543F9F6C6CB' }),
    run: macRun(`${msix}\n`),
  });
  assert.equal(r.ok, true);
  assert.equal(r.argvTarget.exePath, msix);
});

test('win32: MSIX pattern rejects different publisher-id hash and non-Claude package (pattern anchoring)', () => {
  for (const evil of [
    'C:\\Program Files\\WindowsApps\\Claude_1.0.0_x64__evilhash9999\\app\\Claude.exe',      // 다른 publisher-id
    'C:\\Program Files\\WindowsApps\\Evil_1.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe',       // 다른 패키지명
    'C:\\Program Files\\WindowsApps\\Claude_1.0.0_x64__pzs8sxrjxfjjc\\app\\Evil.exe',       // 다른 exe
    'C:\\Evil\\Program Files\\WindowsApps\\Claude_1.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe', // 접두 우회
  ]) {
    const r = verifyDesktopHandler({
      platform: 'win32', realpath: idRp,
      allowWinPaths: [],
      allowWinPathPatterns: [MSIX_RE],
      allowWinPublishers: ['0D7581D2C51C59DF686C3000C70BF543F9F6C6CB'],
      verifyWinSignature: () => ({ ok: true, publisher: 'x', thumbprint: '0D7581D2C51C59DF686C3000C70BF543F9F6C6CB' }),
      run: macRun(`${evil}\n`),
    });
    assert.equal(r.ok, false, evil);
    assert.equal(r.reason, 'path-not-allowed', evil);
  }
});

test('win32: MSIX path with valid pattern but non-allowlisted signer still rejected (signature stays authoritative)', () => {
  const msix = 'C:\\Program Files\\WindowsApps\\Claude_2.0.1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';
  const r = verifyDesktopHandler({
    platform: 'win32', realpath: idRp,
    allowWinPaths: [],
    allowWinPathPatterns: [MSIX_RE],
    allowWinPublishers: ['0D7581D2C51C59DF686C3000C70BF543F9F6C6CB'],
    verifyWinSignature: () => ({ ok: true, publisher: 'CN=Evil Corp', thumbprint: 'EVILTHUMB' }),
    run: macRun(`${msix}\n`),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'publisher-not-allowed');
});

test('win32: exact-match allowlist unaffected when patterns absent (backward compat)', () => {
  const r = verifyDesktopHandler({
    ...WIN_OK,
    allowWinPublishers: ['T1'],
    verifyWinSignature: () => ({ ok: true, publisher: 'p', thumbprint: 'T1' }),
    run: macRun('C:\\Program Files\\Claude\\Claude.exe\n'),
  });
  assert.equal(r.ok, true);
});
