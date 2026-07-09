import { realpathSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { verifyDesktopHandler } from './desktop-handler.mjs';
import { defaultProbeRun, trustedPsCandidates } from './detect-terminal.mjs';

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
// WS2 (v1.7.0): MSIX/Store 패키지 경로 패턴 — 실기 관측(2026-07-09, Windows 11)에서 claude:// 핸들러가
//   C:\Program Files\WindowsApps\Claude_1.18286.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe
// 로 등록됨. 버전 문자열이 경로에 박혀 정확-일치로는 pin 불가(업데이트마다 변경) — 버전-고정 경로 pin은
// 취약하므로 하지 않는다. 대신 **버전만 와일드카드**하고 나머지는 전부 고정한다:
//  - `pzs8sxrjxfjjc`는 MSIX publisher-id 해시로 패키지 서명자에서 파생 — 버전 무관 안정(사실상 2차 서명자 앵커).
//  - WindowsApps는 TrustedInstaller 소유(일반/관리자 쓰기 불가) — 전통 경로보다 변조가 어렵다.
//  - `i` 플래그: Windows 경로는 대소문자 불감 — 케이스 변형은 같은 파일이므로 우회가 아니라 오탐 방지.
//  - x64만: 관측된 아키텍처만 pin(추측 pin 금지 원칙 — arm64 패키지가 관측되면 그때 추가).
// 경로 게이트는 필요조건일 뿐 — Authenticode 서명자 검사(ALLOW_WIN_PUBLISHERS)가 뒤에서 여전히 권위다.
export const ALLOW_WIN_PATH_PATTERNS = [
  /^C:\\Program Files\\WindowsApps\\Claude_[0-9.]+_x64__pzs8sxrjxfjjc\\app\\Claude\.exe$/i,
];
// Round-3 review Finding 3: macOS TeamIdentifier allowlist — closes the gap where a malicious app
// placed at the allowed canonical path with the allowed bundle id would otherwise pass. Observed
// via `codesign -dv --verbose=4 /Applications/Claude.app` against a real, notarized install:
//   Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)
//   TeamIdentifier=Q6L2SF6YDW
export const ALLOW_TEAM_IDS = ['Q6L2SF6YDW'];

// Round-5 review Finding 1: Windows Authenticode publisher/thumbprint allowlist — parity with the
// macOS TeamIdentifier check above. Closes the same gap on Windows: a malicious/replaced exe placed
// at an ALLOW_WIN_PATHS path would otherwise pass on path alone.
//
// CONFIGURED (WS2, v1.7.0) — pinned from a REAL Windows 11 host observation (2026-07-09), replacing the
// deliberate round-10 empty-list fail-closed posture. Guessed values were never acceptable here (a plausible
// Subject guess could accidentally match the real signer with no verified trust anchor); an OBSERVED leaf
// thumbprint is the strongest cryptographic identity available. Observation evidence
// (Get-AuthenticodeSignature on the claude:// handler exe, chain builds & trusted: True):
//   Status:     Valid ("Signature verified.")
//   Subject:    CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US (EV code sign)
//   Issuer:     DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1 → DigiCert Trusted Root G4
//   Thumbprint: 0D7581D2C51C59DF686C3000C70BF543F9F6C6CB (leaf) — NotAfter 2026-10-21
//
// ROTATION CONTRACT: this is a LEAF pin. When Anthropic renews the cert (~2026-10-21) the thumbprint
// changes and win32 desktop dispatch returns to deterministic fail-closed (`publisher-not-allowed`) —
// the safe failure mode; humans fall back to manual `/deep-loop-resume`. To re-pin: on a real Windows
// host, resolve the claude:// handler exe (HKCR\claude\shell\open\command), run
//   Get-AuthenticodeSignature '<exe>' | Select-Object -ExpandProperty SignerCertificate
// verify Status='Valid' + chain-to-trusted-root, then replace the Thumbprint below (uppercase, no
// separators — the raw SignerCertificate.Thumbprint form compared verbatim by verifyDesktopHandler).
export const ALLOW_WIN_PUBLISHERS = ['0D7581D2C51C59DF686C3000C70BF543F9F6C6CB'];

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

// Fixed canonical trusted reg.exe location — NOT derived from %SystemRoot%/PATH/cwd (same trust
// rationale as detect-terminal.mjs's TRUSTED_PS: an env var or PATH entry is parent-spoofable). A
// bare `reg.exe` is resolved by Node/Windows via PATH/cwd, so a malicious `reg.exe` placed in the
// workspace or earlier on PATH would execute BEFORE any Authenticode check ever runs (round-8 review
// Finding 2). Exported so tests can assert the probe never regresses to a bare/PATH-resolved binary.
export const WIN_REG_BIN = 'C:\\Windows\\System32\\reg.exe';

// Windows: the `claude` URL protocol's default open command lives in the registry at
// HKCR\claude\shell\open\command (the standard URL-protocol-handler registration point). `reg query
// /ve` prints the default value; extract the quoted .exe path. Any failure (reg.exe missing, key
// absent, malformed output) → empty stdout / non-zero code → verifyDesktopHandler fails closed.
// `probeRun` is INJECTABLE (defaults to the real defaultProbeRun) purely for host-independent testing
// (see tests/desktop-target.test.mjs) — production callers (defaultDesktopProbe passes this whole
// function as `run`, called with zero args) always get the real spawnSync-backed probe.
export function winProbeRun({ probeRun = defaultProbeRun } = {}) {
  const r = probeRun(WIN_REG_BIN, ['query', 'HKCR\\claude\\shell\\open\\command', '/ve'], { timeoutMs: 5000, capture: true });
  if (!r || r.code !== 0) return { code: 1, stdout: '' };
  const m = /"([^"]+\.exe)"/i.exec(String(r.stdout || ''));
  return { code: m ? 0 : 1, stdout: m ? m[1] : '' };
}

// Windows: verify the Authenticode signature of the resolved exe — the trust boundary that stops a
// replaced/junctioned exe placed at an ALLOW_WIN_PATHS path from passing (round-5 review Finding 1,
// parity with macCodesignVerify above). Runs through a TRUSTED PowerShell (same fixed TRUSTED_PS
// allowlist detect-terminal.mjs's trustedPsCandidates() resolves against — never PATH/where-resolved,
// same rationale as the Windows launcher build in handoff.mjs) executing `Get-AuthenticodeSignature`.
// -EncodedCommand (base64 UTF-16LE, same technique handoff.mjs's powershellEntry uses) sidesteps all
// quoting hazards for exePath rather than string-interpolating it into a quoted PS literal.
// Fail closed on: no trusted PS bin found, non-zero exit, Status !== 'Valid', or a missing/unparseable
// signer certificate. Never throws (verifyDesktopHandler still wraps the call in try/catch as
// defense-in-depth, but this function itself does not let spawnSync exceptions escape).
function winAuthenticodeVerify({ exePath } = {}, { timeoutMs = 5000, exists = existsSync } = {}) {
  const psBin = trustedPsCandidates(exists)[0];
  if (!psBin) return { ok: false };
  const escaped = String(exePath).replace(/'/g, "''");
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${escaped}'; if ($s.Status -ne 'Valid' -or -not $s.SignerCertificate) { 'INVALID' } else { 'VALID|' + $s.SignerCertificate.Subject + '|' + $s.SignerCertificate.Thumbprint }`;
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync(psBin, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: timeoutMs, encoding: 'utf8' });
  if ((r.status ?? 1) !== 0) return { ok: false };
  const out = String(r.stdout || '').trim();
  if (!out.startsWith('VALID|')) return { ok: false };
  const parts = out.split('|');
  const publisher = (parts[1] || '').trim();
  const thumbprint = (parts[2] || '').trim();
  if (!publisher || !thumbprint) return { ok: false };
  return { ok: true, publisher, thumbprint };
}

/**
 * Thin wrapper: supplies the REAL host query + realpathSync + allowlist constants to
 * verifyDesktopHandler (Task 4), returning its verdict. Best-effort and MUST fail closed — any
 * probe/parse failure (or an unsupported platform) returns `{ ok:false }`, never throws.
 *
 * `run`, `realpath`, (darwin-only) `verifySignature` and (win32-only) `verifyWinSignature` are
 * INJECTABLE (default to the real per-platform host probe / realpathSync / macCodesignVerify /
 * winAuthenticodeVerify) so tests can exercise the wiring — which platform selects which allowlist,
 * and that the module allowlist constants actually reach verifyDesktopHandler — without shelling out
 * to osascript/reg.exe/codesign/powershell (see tests/desktop-target.test.mjs). Production callers
 * (respawn/emitHandoff) never pass these, so real runtime behavior is unchanged: platform-appropriate
 * real probe + realpathSync + real codesign/Authenticode verification + the fixed module
 * allowlist/team-id/publisher constants.
 */
export function defaultDesktopProbe({ platform = process.platform, run, realpath = realpathSync, verifySignature, verifyWinSignature } = {}) {
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
        allowWinPaths: ALLOW_WIN_PATHS, allowWinPathPatterns: ALLOW_WIN_PATH_PATTERNS,
        verifyWinSignature: verifyWinSignature || winAuthenticodeVerify, allowWinPublishers: ALLOW_WIN_PUBLISHERS,
      });
    }
    return { ok: false, reason: 'unsupported-platform' };
  } catch {
    return { ok: false, reason: 'probe-error' };
  }
}
