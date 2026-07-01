// Pure parser + decision: host lookup is done by the injected run(), path canonicalization by
// the injected realpath(). No now()/randomness. Trust boundary is the canonical app path — a
// matching bundle-id is necessary but NOT sufficient (a rogue app at an untrusted path with the
// allowed bundle-id must be rejected).
export function verifyDesktopHandler({ platform, run, realpath = (p) => p, allowMacPaths = [], allowBundleIds = [], allowWinPaths = [] } = {}) {
  if (platform === 'darwin') {
    let out; try { out = run(); } catch { return { ok: false, reason: 'probe-error' }; }
    if (!out || out.code !== 0) return { ok: false, reason: 'probe-failed' };
    const [appPath, bundleId] = String(out.stdout || '').split('\n').map(s => s.trim());
    if (!appPath || !bundleId) return { ok: false, reason: 'probe-empty' };
    // Trust boundary = canonical app path (bundle-id is necessary but not sufficient).
    let canon; try { canon = realpath(appPath); } catch { return { ok: false, reason: 'realpath-error' }; }
    if (!allowMacPaths.map(p => { try { return realpath(p); } catch { return p; } }).includes(canon)) return { ok: false, reason: 'path-not-allowed' };
    if (!allowBundleIds.includes(bundleId)) return { ok: false, reason: 'bundle-not-allowed' };
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
