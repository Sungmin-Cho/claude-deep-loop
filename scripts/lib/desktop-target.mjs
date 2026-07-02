import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
// Round-3 review Finding 3: macOS TeamIdentifier allowlist — closes the gap where a malicious app
// placed at the allowed canonical path with the allowed bundle id would otherwise pass. Observed
// via `codesign -dv --verbose=4 /Applications/Claude.app` against a real, notarized install:
//   Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
//   TeamIdentifier=Q6L2SF6YDW
export const ALLOW_TEAM_IDS = ['Q6L2SF6YDW'];

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

// macOS: verify the Developer ID code signature of the resolved app bundle and extract its
// TeamIdentifier — the actual trust boundary that stops a malicious app placed at the allowed
// canonical path (with a hand-edited allowed bundle id) from passing (round-3 review Finding 3).
// Two checks, both required:
//   1. `codesign --verify --deep --strict` exits 0 (full nested-resource/requirement validation).
//   2. `codesign -dv --verbose=4` (which prints its fields to STDERR, not stdout — hence a bespoke
//      spawnSync call here rather than reusing defaultProbeRun's stdout-only capture) contains a
//      `TeamIdentifier=<id>` line.
// Bounded timeout, same style as defaultProbeRun. Any missing binary/timeout/non-zero exit/unparseable
// output -> { ok:false } (fail closed) — never throws (verifyDesktopHandler still wraps the call in
// try/catch as defense-in-depth, but this function itself does not let spawnSync exceptions escape
// beyond what spawnSync already returns as a non-zero/undefined status).
function macCodesignVerify({ appPath } = {}, { timeoutMs = 5000 } = {}) {
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { timeout: timeoutMs, encoding: 'utf8' });
  if ((verify.status ?? 1) !== 0) return { ok: false };
  const info = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { timeout: timeoutMs, encoding: 'utf8' });
  if ((info.status ?? 1) !== 0) return { ok: false };
  const combined = `${info.stdout || ''}\n${info.stderr || ''}`;
  const m = /^TeamIdentifier=(.+)$/m.exec(combined);
  if (!m) return { ok: false };
  const teamId = m[1].trim();
  if (!teamId || teamId === 'not set') return { ok: false };   // ad-hoc/unsigned binaries print "TeamIdentifier=not set"
  return { ok: true, teamId };
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
 * `run`, `realpath` and (darwin-only) `verifySignature` are INJECTABLE (default to the real
 * per-platform host probe / realpathSync / macCodesignVerify) so tests can exercise the wiring —
 * which platform selects which allowlist, and that the module allowlist constants actually reach
 * verifyDesktopHandler — without shelling out to osascript/reg.exe/codesign (see
 * tests/desktop-target.test.mjs). Production callers (respawn/emitHandoff) never pass these, so real
 * runtime behavior is unchanged: platform-appropriate real probe + realpathSync + real codesign
 * verification + the fixed module allowlist/team-id constants.
 */
export function defaultDesktopProbe({ platform = process.platform, run, realpath = realpathSync, verifySignature } = {}) {
  try {
    if (platform === 'darwin') {
      return verifyDesktopHandler({
        platform, run: run || macProbeRun, realpath,
        allowMacPaths: ALLOW_MAC_PATHS, allowBundleIds: ALLOW_BUNDLE_IDS,
        verifySignature: verifySignature || macCodesignVerify, allowTeamIds: ALLOW_TEAM_IDS,
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
