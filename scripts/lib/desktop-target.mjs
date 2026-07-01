import { realpathSync } from 'node:fs';
import { verifyDesktopHandler } from './desktop-handler.mjs';
import { defaultProbeRun } from './detect-terminal.mjs';

// Trust boundary allowlists — the ONLY app path / bundle-id / exe path verifyDesktopHandler will
// accept as the real `claude://` deeplink handler. Fixed, non-configurable constants (not env-derived
// — an env var is parent-spoofable, same rationale as detect-terminal's TRUSTED_PS list).
export const ALLOW_MAC_PATHS = ['/Applications/Claude.app'];
// Real installed Claude Desktop's bundle id (verified via the macProbeRun query below against an
// actual install) is `com.anthropic.claudefordesktop` — NOT `com.anthropic.claude`. Keep the latter
// as an extra fallback entry in case a differently-bundled build ever registers under it.
export const ALLOW_BUNDLE_IDS = ['com.anthropic.claudefordesktop', 'com.anthropic.claude'];
export const ALLOW_WIN_PATHS = [
  'C:\\Program Files\\Claude\\Claude.exe',
  'C:\\Program Files (x86)\\Claude\\Claude.exe',
];

// macOS: ask NSWorkspace (via a small JXA snippet) which app is currently bound to the `claude://`
// URL scheme, then read that app's Info.plist bundle id — the two facts verifyDesktopHandler needs
// (appPath + bundleId, newline-separated on stdout). This is a read-only Cocoa API query (no Apple
// Event sent to another app), so it needs no automation/accessibility permission. Bounded timeout via
// defaultProbeRun; any failure (no osascript, no handler registered, malformed output) surfaces as a
// non-zero/empty result — verifyDesktopHandler already treats that as unavailable (fail-closed).
function macProbeRun() {
  const script = [
    'ObjC.import("AppKit");',
    'ObjC.import("Foundation");',
    'var ws = $.NSWorkspace.sharedWorkspace;',
    'var url = $.NSURL.URLWithString("claude://probe");',
    'var appURL = url ? ws.URLForApplicationToOpenURL(url) : $();',
    'if (!appURL || appURL.isNil()) { ""; } else {',
    '  var appPath = ObjC.unwrap(appURL.path);',
    '  var bundle = $.NSBundle.bundleWithURL(appURL);',
    '  var bundleId = (bundle && !bundle.isNil()) ? ObjC.unwrap(bundle.bundleIdentifier) : "";',
    '  appPath + "\\n" + bundleId;',
    '}',
  ].join('\n');
  return defaultProbeRun('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeoutMs: 5000, capture: true });
}

// Windows: the `claude` URL protocol's default open command lives in the registry at
// HKCR\claude\shell\open\command (the standard URL-protocol-handler registration point). `reg query
// /ve` prints the default value; extract the quoted .exe path. Any failure (reg.exe missing, key
// absent, malformed output) → empty stdout / non-zero code → verifyDesktopHandler fails closed.
function winProbeRun() {
  const r = defaultProbeRun('reg.exe', ['query', 'HKCR\\claude\\shell\\open\\command', '/ve'], { timeoutMs: 5000, capture: true });
  if (!r || r.code !== 0) return { code: 1, stdout: '' };
  const m = /"([^"]+\.exe)"/i.exec(String(r.stdout || ''));
  return { code: m ? 0 : 1, stdout: m ? m[1] : '' };
}

/**
 * Thin wrapper: supplies the REAL host query + realpathSync + allowlist constants to
 * verifyDesktopHandler (Task 4), returning its verdict. Best-effort and MUST fail closed — any
 * probe/parse failure (or an unsupported platform) returns `{ ok:false }`, never throws.
 *
 * `run` and `realpath` are INJECTABLE (default to the real per-platform host probe / realpathSync)
 * so tests can exercise the wiring — which platform selects which allowlist, and that the module
 * allowlist constants actually reach verifyDesktopHandler — without shelling out to osascript/reg.exe
 * (see tests/desktop-target.test.mjs). Production callers (respawn/emitHandoff) never pass these,
 * so real runtime behavior is unchanged: platform-appropriate real probe + realpathSync + the fixed
 * module allowlist constants.
 */
export function defaultDesktopProbe({ platform = process.platform, run, realpath = realpathSync } = {}) {
  try {
    if (platform === 'darwin') {
      return verifyDesktopHandler({
        platform, run: run || macProbeRun, realpath,
        allowMacPaths: ALLOW_MAC_PATHS, allowBundleIds: ALLOW_BUNDLE_IDS,
      });
    }
    if (platform === 'win32') {
      return verifyDesktopHandler({
        platform, run: run || winProbeRun, realpath,
        allowWinPaths: ALLOW_WIN_PATHS,
      });
    }
    return { ok: false, reason: 'unsupported-platform' };
  } catch {
    return { ok: false, reason: 'probe-error' };
  }
}
