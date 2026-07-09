// Review-loop finding 2 (mutation-proven gap): defaultDesktopProbe previously used the REAL host
// probe + realpathSync + allowlists internally with ZERO tests — swapping allowMacPaths/allowBundleIds
// args in the wiring would go undetected. defaultDesktopProbe now accepts injectable `run`/`realpath`
// deps (defaults = real host probe / realpathSync, so production behavior is unchanged) so the wiring
// itself — which platform selects which allowlist constants, and that both path AND bundle-id must
// match (not either alone) — can be exercised without shelling out to osascript/reg.exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesktopProbe, ALLOW_MAC_PATHS, ALLOW_BUNDLE_IDS, ALLOW_WIN_PATHS, ALLOW_TEAM_IDS, ALLOW_WIN_PUBLISHERS, winProbeRun, WIN_REG_BIN } from '../scripts/lib/desktop-target.mjs';

const idRp = (p) => p;   // injected realpath: identity (canonicalization itself is desktop-handler.test.mjs's concern)
const okRun = (out, code = 0) => () => ({ code, stdout: out });
// Fake codesign runner — a valid signature carrying the real allowlisted team-id. Injected so darwin
// tests never shell out to the real `codesign` binary (round-3 review Finding 3 wiring proof lives in
// desktop-handler.test.mjs; this file only proves defaultDesktopProbe threads verifySignature/allowTeamIds
// through, same as it already does for run/realpath/allowMacPaths/allowBundleIds).
const okSig = () => ({ ok: true, teamId: ALLOW_TEAM_IDS[0] });
// Fake Authenticode verifier — a VALID signature whose signer is NOT in the (round-10: intentionally
// empty, fail-closed) production ALLOW_WIN_PUBLISHERS. Injected so win32 tests never shell out to the real
// `powershell`/`pwsh`. The happy-path VERIFIED wiring for win32 is proven at the handler level
// (desktop-handler.test.mjs, which injects a non-empty allowWinPublishers directly); this file proves the
// defaultDesktopProbe→verifyDesktopHandler wiring via the negative outcomes (path/publisher rejection),
// which is all the empty production allowlist permits.
const okWinSig = () => ({ ok: true, publisher: 'CN=Unlisted Valid Signer', thumbprint: 'DEADBEEF' });

test('defaultDesktopProbe: unsupported platform (linux) -> unavailable, no injection needed', () => {
  const r = defaultDesktopProbe({ platform: 'linux' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unsupported-platform');
});

test('defaultDesktopProbe: darwin + injected run/realpath/verifySignature returning an allowlisted app+bundle+team-id -> verified', () => {
  const appPath = ALLOW_MAC_PATHS[0];
  const bundleId = ALLOW_BUNDLE_IDS[0];
  const r = defaultDesktopProbe({
    platform: 'darwin',
    run: okRun(`${appPath}\n${bundleId}\n`),
    realpath: idRp,
    verifySignature: okSig,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'macos-app', appPath });
});

// Allowlist-wiring proof: an ALLOWED bundle-id at a NON-allowlisted path must still be rejected —
// this only holds if the real ALLOW_MAC_PATHS / ALLOW_BUNDLE_IDS module constants actually reached
// verifyDesktopHandler as allowMacPaths/allowBundleIds (not swapped, not omitted, not replaced by an
// empty/permissive default). A swapped-args regression (e.g. passing ALLOW_BUNDLE_IDS as allowMacPaths)
// would flip this case to ok:true and fail the test.
test('defaultDesktopProbe: allowlist wiring — allowed bundle-id at a NON-allowlisted path -> unavailable', () => {
  const bundleId = ALLOW_BUNDLE_IDS[0];
  const r = defaultDesktopProbe({
    platform: 'darwin',
    run: okRun(`/Applications/RogueClaude.app\n${bundleId}\n`),
    realpath: idRp,
    verifySignature: okSig,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'path-not-allowed');
});

// Team-id allowlist wiring proof: an allowed path + allowed bundle-id but a NON-allowlisted team-id
// must still be rejected — this only holds if the real ALLOW_TEAM_IDS module constant actually
// reached verifyDesktopHandler as allowTeamIds (not omitted/replaced by an empty/permissive default).
test('defaultDesktopProbe: allowlist wiring — allowed path+bundle but NON-allowlisted team-id -> unavailable', () => {
  const appPath = ALLOW_MAC_PATHS[0];
  const bundleId = ALLOW_BUNDLE_IDS[0];
  const r = defaultDesktopProbe({
    platform: 'darwin',
    run: okRun(`${appPath}\n${bundleId}\n`),
    realpath: idRp,
    verifySignature: () => ({ ok: true, teamId: 'EVILTEAM' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'team-id-not-allowed');
});

// Round-10 posture SUPERSEDED by WS2 (v1.7.0): ALLOW_WIN_PUBLISHERS is no longer empty — it pins the
// signer thumbprint OBSERVED on a real Windows 11 host (2026-07-09; see desktop-target.mjs comment for the
// observation evidence). The round-10 invariant that survives is narrower and still enforced here: a VALID
// signature whose signer is NOT the pinned one must still fail closed (`publisher-not-allowed`) — i.e. the
// pinned constant actually reaches verifyDesktopHandler and nothing widened to a permissive default.
test('defaultDesktopProbe: win32 valid signature at allowed path but UNPINNED signer -> fail-closed (pin is authoritative)', () => {
  const exePath = ALLOW_WIN_PATHS[0];
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun(`${exePath}\n`),
    realpath: idRp,
    verifyWinSignature: okWinSig,   // valid signature, but signer/thumbprint not in the pinned allowlist
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'publisher-not-allowed');
});

test('defaultDesktopProbe: win32 exe path not in allowlist -> unavailable (allowlist wiring)', () => {
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun('C:\\Users\\x\\Evil.exe\n'),
    realpath: idRp,
    verifyWinSignature: okWinSig,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'path-not-allowed');
});

// Publisher allowlist wiring proof: an allowed path but a NON-allowlisted publisher/thumbprint must
// still be rejected — this only holds if the real ALLOW_WIN_PUBLISHERS module constant actually
// reached verifyDesktopHandler as allowWinPublishers (not omitted/replaced by an empty/permissive default).
test('defaultDesktopProbe: allowlist wiring — win32 allowed path but NON-allowlisted publisher -> unavailable', () => {
  const exePath = ALLOW_WIN_PATHS[0];
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun(`${exePath}\n`),
    realpath: idRp,
    verifyWinSignature: () => ({ ok: true, publisher: 'CN=Evil Corp', thumbprint: 'EVILTHUMB' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'publisher-not-allowed');
});

// Round-8 review Finding 2: winProbeRun previously invoked bare `reg.exe`, which Node/Windows resolves
// via PATH/cwd — a malicious `reg.exe` placed in the workspace or earlier on PATH would execute BEFORE
// any Authenticode check ever runs. It must invoke a FIXED absolute System32 path instead (same trust
// rationale as detect-terminal.mjs's TRUSTED_PS), never a bare/PATH-resolved binary name. Host-independent:
// `probeRun` is injected so this never shells out to a real reg.exe.
test('winProbeRun: invokes reg.exe via the fixed absolute System32 path, never bare/PATH-resolved "reg.exe"', () => {
  assert.equal(WIN_REG_BIN, 'C:\\Windows\\System32\\reg.exe', 'fixed canonical absolute reg.exe path');
  let capturedBin;
  const r = winProbeRun({
    probeRun: (bin) => { capturedBin = bin; return { code: 0, stdout: '"C:\\Program Files\\Claude\\Claude.exe"' }; },
  });
  assert.equal(capturedBin, WIN_REG_BIN, 'winProbeRun must invoke the absolute System32 reg.exe, not bare reg.exe');
  assert.notEqual(capturedBin, 'reg.exe', 'must never PATH-resolve a bare reg.exe');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'C:\\Program Files\\Claude\\Claude.exe');
});

// Absent/broken reg.exe (missing key, non-zero exit, malformed output) must still fail closed — the
// absolute-path fix must not weaken the existing fail-closed behavior.
test('winProbeRun: probe failure (non-zero exit) fails closed', () => {
  const r = winProbeRun({ probeRun: () => ({ code: 1, stdout: '' }) });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
});

// ── WS2 (v1.7.0): 실기 관측 기반 Windows 활성화 ──────────────────────────────
// 2026-07-09 실제 Windows 11 머신 관측(Get-AuthenticodeSignature, Status=Valid, chain-to-trusted-root):
// thumbprint 0D7581D2C51C59DF686C3000C70BF543F9F6C6CB (leaf, 만료 2026-10-21 — 로테이션 시 재-pin),
// claude:// 핸들러는 MSIX 패키지 경로(WindowsApps\Claude_<ver>_x64__pzs8sxrjxfjjc\app\Claude.exe).
import { ALLOW_WIN_PATH_PATTERNS } from '../scripts/lib/desktop-target.mjs';

test('ALLOW_WIN_PUBLISHERS pins the observed real signer thumbprint (fail-closed posture replaced by observed pin)', () => {
  assert.deepEqual(ALLOW_WIN_PUBLISHERS, ['0D7581D2C51C59DF686C3000C70BF543F9F6C6CB']);
});

test('defaultDesktopProbe: win32 MSIX path + pinned thumbprint -> ok (module wiring of patterns + publishers)', () => {
  const msix = 'C:\\Program Files\\WindowsApps\\Claude_1.18286.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe';
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun(`${msix}\n`),
    realpath: idRp,
    verifyWinSignature: () => ({ ok: true, publisher: 'CN="Anthropic, PBC", O="Anthropic, PBC"', thumbprint: '0D7581D2C51C59DF686C3000C70BF543F9F6C6CB' }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.argvTarget.exePath, msix);
});

test('ALLOW_WIN_PATH_PATTERNS: anchored, publisher-id pinned, version-only wildcard (no version-pinned path)', () => {
  assert.equal(ALLOW_WIN_PATH_PATTERNS.length, 1);
  const re = ALLOW_WIN_PATH_PATTERNS[0];
  assert.ok(re.test('C:\\Program Files\\WindowsApps\\Claude_1.18286.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'));
  assert.ok(re.test('C:\\Program Files\\WindowsApps\\Claude_99.0.1_x64__pzs8sxrjxfjjc\\app\\Claude.exe'));   // 미래 버전
  assert.ok(!re.test('C:\\Program Files\\WindowsApps\\Claude_1.0_x64__evilhash\\app\\Claude.exe'));           // 타 publisher-id
  assert.ok(!re.test('C:\\Program Files\\WindowsApps\\Claude_1.0_x64__pzs8sxrjxfjjc\\app\\Evil.exe'));        // 타 exe
  assert.ok(!re.test('D:\\Program Files\\WindowsApps\\Claude_1.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'));      // 타 드라이브
});

test('defaultDesktopProbe: win32 traditional-installer exact path + pinned thumbprint -> ok (기존 경로 회귀)', () => {
  const exePath = ALLOW_WIN_PATHS[0];
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun(`${exePath}\n`),
    realpath: idRp,
    verifyWinSignature: () => ({ ok: true, publisher: 'CN="Anthropic, PBC"', thumbprint: '0D7581D2C51C59DF686C3000C70BF543F9F6C6CB' }),
  });
  assert.equal(r.ok, true, JSON.stringify(r));
});
