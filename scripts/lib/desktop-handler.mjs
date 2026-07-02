// Pure parser + decision: host lookup is done by the injected run(), path canonicalization by
// the injected realpath(), code-signature/team-id verification by the injected verifySignature().
// No now()/randomness. Trust boundary on macOS is THREE-FOLD: canonical app path + bundle-id +
// a valid Developer ID code signature whose TeamIdentifier is allowlisted. Path-in-allowlist and
// bundle-id-in-allowlist are each necessary but NOT sufficient on their own — a malicious app
// dropped at the trusted canonical path (or with a hand-edited Info.plist bundle id) would pass
// both of those checks; only the signature/team-id check closes that gap (round-3 review Finding 3).
export function verifyDesktopHandler({ platform, run, realpath = (p) => p, allowMacPaths = [], allowBundleIds = [], allowWinPaths = [], verifySignature, allowTeamIds = [] } = {}) {
  if (platform === 'darwin') {
    let out; try { out = run(); } catch { return { ok: false, reason: 'probe-error' }; }
    if (!out || out.code !== 0) return { ok: false, reason: 'probe-failed' };
    const [appPath, bundleId] = String(out.stdout || '').split('\n').map(s => s.trim());
    if (!appPath || !bundleId) return { ok: false, reason: 'probe-empty' };
    // Trust boundary = canonical app path (bundle-id is necessary but not sufficient).
    let canon; try { canon = realpath(appPath); } catch { return { ok: false, reason: 'realpath-error' }; }
    if (!allowMacPaths.map(p => { try { return realpath(p); } catch { return p; } }).includes(canon)) return { ok: false, reason: 'path-not-allowed' };
    if (!allowBundleIds.includes(bundleId)) return { ok: false, reason: 'bundle-not-allowed' };
    // Code-signature + TeamIdentifier check — fail closed on ANY of: verifySignature missing/throws,
    // an invalid/unsigned/ad-hoc signature, or a TeamIdentifier that isn't in allowTeamIds (this is
    // what actually stops the spoofed-bundle-at-trusted-path attack; path+bundle-id alone do not).
    let sig; try { sig = verifySignature({ appPath: canon }); } catch { return { ok: false, reason: 'signature-error' }; }
    if (!sig || sig.ok !== true) return { ok: false, reason: 'signature-invalid' };
    if (!sig.teamId || !allowTeamIds.includes(sig.teamId)) return { ok: false, reason: 'team-id-not-allowed' };
    return { ok: true, argvTarget: { kind: 'macos-app', appPath: canon } };   // canonical path returned (not the raw symlink) -> blocks TOCTOU
  }
  if (platform === 'win32') {
    let out; try { out = run(); } catch { return { ok: false, reason: 'probe-error' }; }
    if (!out || out.code !== 0) return { ok: false, reason: 'probe-failed' };
    let exePath; try { exePath = realpath(String(out.stdout || '').trim()); } catch { return { ok: false, reason: 'realpath-error' }; }
    if (!exePath || !allowWinPaths.map(p => { try { return realpath(p); } catch { return p; } }).includes(exePath)) return { ok: false, reason: 'path-not-allowed' };
    return { ok: true, argvTarget: { kind: 'win-exe', exePath } };
  }
  return { ok: false, reason: 'unsupported-platform' };
}
