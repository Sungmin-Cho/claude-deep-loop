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

// Round-10 review fix (codex adversarial [high]): the production ALLOW_WIN_PUBLISHERS is intentionally
// EMPTY (fail-closed until a real Windows signer is pinned — a guessed Subject could accidentally match the
// real notarized signer and pass with no verified trust anchor). So even a VALID signature at an ALLOWED
// path fails closed at the defaultDesktopProbe level — the current "Windows desktop not yet configured"
// posture. This asserts the empty module constant actually reaches verifyDesktopHandler (a permissive/
// non-empty default would flip this to ok:true). The happy-path VERIFIED win32 wiring is covered in
// desktop-handler.test.mjs, which injects a non-empty allowWinPublishers directly.
test('defaultDesktopProbe: win32 valid signature at allowed path but empty production ALLOW_WIN_PUBLISHERS -> fail-closed (not yet configured)', () => {
  const exePath = ALLOW_WIN_PATHS[0];
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun(`${exePath}\n`),
    realpath: idRp,
    verifyWinSignature: okWinSig,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'publisher-not-allowed');
  assert.equal(ALLOW_WIN_PUBLISHERS.length, 0, 'Windows desktop is fail-closed until a real signer thumbprint is pinned (round-10)');
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
