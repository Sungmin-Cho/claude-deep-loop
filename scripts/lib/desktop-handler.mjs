// Pure parser + decision: host lookup is done by the injected run(), path canonicalization by
// the injected realpath(), code-signature/team-id verification by the injected verifySignature()
// (macOS) / verifyWinSignature() (Windows). No now()/randomness. Trust boundary on macOS is
// THREE-FOLD: canonical app path + bundle-id + a valid Developer ID code signature whose
// TeamIdentifier is allowlisted. Path-in-allowlist and bundle-id-in-allowlist are each necessary
// but NOT sufficient on their own — a malicious app dropped at the trusted canonical path (or with
// a hand-edited Info.plist bundle id) would pass both of those checks; only the signature/team-id
// check closes that gap (round-3 review Finding 3). Windows trust boundary mirrors this: exe path
// in allowlist + a valid Authenticode signature whose signer (publisher subject or thumbprint) is
// allowlisted — path-in-allowlist alone would let a replaced/junctioned exe at the trusted path
// pass (round-5 review Finding 1, parity with the macOS codesign/team-id check).
export function verifyDesktopHandler({ platform, run, realpath = (p) => p, allowMacPaths = [], allowBundleIds = [], allowWinPaths = [], allowWinPathPatterns = [], verifySignature, allowTeamIds = [], verifyWinSignature, allowWinPublishers = [] } = {}) {
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
    // Path gate: exact-match allowlist (traditional installer paths) OR anchored pattern allowlist
    // (WS2 v1.7.0 — MSIX/Store packages live under a VERSIONED WindowsApps directory, e.g.
    // C:\Program Files\WindowsApps\Claude_<ver>_x64__pzs8sxrjxfjjc\app\Claude.exe, so exact match
    // can never pin them; the pattern pins the signer-derived publisher-id hash and wildcards only
    // the version). Either way the Authenticode signer check below stays authoritative — the path
    // gate alone is necessary but not sufficient, same as before.
    const exactOk = !!exePath && allowWinPaths.map(p => { try { return realpath(p); } catch { return p; } }).includes(exePath);
    const patternOk = !!exePath && allowWinPathPatterns.some(re => re.test(exePath));
    if (!exactOk && !patternOk) return { ok: false, reason: 'path-not-allowed' };
    // Authenticode signature + publisher check — mirrors the macOS codesign/TeamIdentifier check
    // above (round-5 review Finding 1): path-in-allowlist alone would let a replaced/junctioned exe
    // at the trusted path pass. Fail closed on ANY of: verifyWinSignature missing/throws, an
    // invalid/absent Authenticode signature, or a signer (publisher/thumbprint) not in allowWinPublishers.
    let sig; try { sig = verifyWinSignature({ exePath }); } catch { return { ok: false, reason: 'signature-error' }; }
    if (!sig || sig.ok !== true) return { ok: false, reason: 'signature-invalid' };
    const publisherOk = !!sig.publisher && allowWinPublishers.includes(sig.publisher);
    const thumbprintOk = !!sig.thumbprint && allowWinPublishers.includes(sig.thumbprint);
    if (!publisherOk && !thumbprintOk) return { ok: false, reason: 'publisher-not-allowed' };
    return { ok: true, argvTarget: { kind: 'win-exe', exePath } };
  }
  return { ok: false, reason: 'unsupported-platform' };
}
