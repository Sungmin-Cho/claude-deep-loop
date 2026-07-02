// Review-loop finding 2 (mutation-proven gap): defaultDesktopProbe previously used the REAL host
// probe + realpathSync + allowlists internally with ZERO tests — swapping allowMacPaths/allowBundleIds
// args in the wiring would go undetected. defaultDesktopProbe now accepts injectable `run`/`realpath`
// deps (defaults = real host probe / realpathSync, so production behavior is unchanged) so the wiring
// itself — which platform selects which allowlist constants, and that both path AND bundle-id must
// match (not either alone) — can be exercised without shelling out to osascript/reg.exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultDesktopProbe, ALLOW_MAC_PATHS, ALLOW_BUNDLE_IDS, ALLOW_WIN_PATHS, ALLOW_TEAM_IDS } from '../scripts/lib/desktop-target.mjs';

const idRp = (p) => p;   // injected realpath: identity (canonicalization itself is desktop-handler.test.mjs's concern)
const okRun = (out, code = 0) => () => ({ code, stdout: out });
// Fake codesign runner — a valid signature carrying the real allowlisted team-id. Injected so darwin
// tests never shell out to the real `codesign` binary (round-3 review Finding 3 wiring proof lives in
// desktop-handler.test.mjs; this file only proves defaultDesktopProbe threads verifySignature/allowTeamIds
// through, same as it already does for run/realpath/allowMacPaths/allowBundleIds).
const okSig = () => ({ ok: true, teamId: ALLOW_TEAM_IDS[0] });

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

test('defaultDesktopProbe: win32 + injected run/realpath returning an allowlisted exe -> verified', () => {
  const exePath = ALLOW_WIN_PATHS[0];
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun(`${exePath}\n`),
    realpath: idRp,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argvTarget, { kind: 'win-exe', exePath });
});

test('defaultDesktopProbe: win32 exe path not in allowlist -> unavailable (allowlist wiring)', () => {
  const r = defaultDesktopProbe({
    platform: 'win32',
    run: okRun('C:\\Users\\x\\Evil.exe\n'),
    realpath: idRp,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'path-not-allowed');
});
