import { test } from 'node:test'; import assert from 'node:assert/strict';
import { detectTerminal } from '../scripts/lib/detect-terminal.mjs';
const ok = () => ({ code: 0 }); const fail = () => ({ code: 1 });
const NOW = '2026-06-27T00:00:00Z';

test('cmux: bundled bin + socket + surface + ping ok → cmux (probe uses explicit socket)', () => {
  let captured = null;
  const recordRun = (bin, argv) => { captured = { bin, argv }; return { code: 0 }; };
  const d = detectTerminal({ env: { CMUX_BUNDLED_CLI_PATH:'/a/cmux', CMUX_SOCKET_PATH:'/run/cmux.sock', CMUX_WORKSPACE_ID:'w1', TERM_PROGRAM:'ghostty' }, platform:'darwin', run: recordRun, now: NOW });
  assert.equal(d.launcher, 'cmux');
  assert.equal(d.launcher_bin, '/a/cmux');
  assert.equal(d.launcher_socket, '/run/cmux.sock');
  assert.equal(d.reachable, true);
  // Lock in "same socket verified": probe targets the explicit socket.
  assert.equal(captured.bin, '/a/cmux');
  assert.deepEqual(captured.argv, ['--socket', '/run/cmux.sock', 'ping']);
});
test('cmux: ping fail → none fail-closed, no downgrade', () => {
  const d = detectTerminal({ env: { CMUX_BUNDLED_CLI_PATH:'/a/cmux', CMUX_SOCKET_PATH:'/run/cmux.sock', CMUX_SURFACE_ID:'s1', TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: fail, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'cmux-socket-denied');
});
test('cmux: bundled bin + surface but NO socket → none cmux-no-socket', () => {
  const d = detectTerminal({ env: { CMUX_BUNDLED_CLI_PATH:'/a/cmux', CMUX_WORKSPACE_ID:'w1' }, platform:'darwin', run: ok, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'cmux-no-socket'); assert.equal(d.launcher_socket, null);
});
test('cmux: bundled bin + socket but NO surface → none cmux-no-surface', () => {
  const d = detectTerminal({ env: { CMUX_BUNDLED_CLI_PATH:'/a/cmux', CMUX_SOCKET_PATH:'/run/cmux.sock' }, platform:'darwin', run: ok, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'cmux-no-surface');
});
test('cmux: socket + surface but NO bundled bin → none cmux-no-bundled-bin', () => {
  const d = detectTerminal({ env: { CMUX_SOCKET_PATH:'/run/cmux.sock', CMUX_WORKSPACE_ID:'w1' }, platform:'darwin', run: ok, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'cmux-no-bundled-bin');
});
test('darwin tmux → none multiplexer-v1-unsupported (TERM_PROGRAM stale)', () => {
  const d = detectTerminal({ env: { TMUX:'/tmp/tmux-0/default,1,0', TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: ok, now: NOW });
  assert.equal(d.launcher, 'none'); assert.equal(d.reason, 'multiplexer-v1-unsupported');
});
test('darwin iTerm2 installed → iterm2; not installed → none', () => {
  assert.equal(detectTerminal({ env:{ TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: ok, now: NOW }).launcher, 'iterm2');
  assert.equal(detectTerminal({ env:{ TERM_PROGRAM:'iTerm.app' }, platform:'darwin', run: fail, now: NOW }).launcher, 'none');
});
test('darwin Apple_Terminal id ok → terminal-app', () => {
  assert.equal(detectTerminal({ env:{ TERM_PROGRAM:'Apple_Terminal' }, platform:'darwin', run: ok, now: NOW }).launcher, 'terminal-app');
});
test('win32 WT_SESSION → wt (regression)', () => {
  assert.equal(detectTerminal({ env:{ WT_SESSION:'x' }, platform:'win32', run: ok, now: NOW }).launcher, 'wt');
});
test('linux / no signal → none', () => {
  assert.equal(detectTerminal({ env:{}, platform:'linux', run: ok, now: NOW }).launcher, 'none');
});

// Codex r3 🔴2: relative/bare CMUX_BUNDLED_CLI_PATH must fail-closed — never probe, never persist.
test('cmux: RELATIVE CMUX_BUNDLED_CLI_PATH (e.g. "cmux") → none cmux-bin-not-absolute, probe never called (codex-high)', () => {
  let probeCallCount = 0;
  const recordingRun = (bin, argv) => { probeCallCount++; return { code: 0 }; };
  const d = detectTerminal({
    env: { CMUX_BUNDLED_CLI_PATH: 'cmux', CMUX_SOCKET_PATH: '/run/cmux.sock', CMUX_WORKSPACE_ID: 'w1' },
    platform: 'linux',
    run: recordingRun,
    now: NOW,
  });
  assert.equal(d.launcher, 'none');
  assert.equal(d.reason, 'cmux-bin-not-absolute');
  assert.equal(probeCallCount, 0, 'probe must NOT be called when cmux_bin is not absolute');
});

// ── B1: probe stdout capture (2026-06-29 Windows fixes) ─────────────────────────
import { defaultProbeRun } from '../scripts/lib/detect-terminal.mjs';
test('B1: defaultProbeRun captures stdout when capture:true', () => {
  const r = defaultProbeRun(process.execPath, ['-e', "process.stdout.write('HELLO')"], { capture: true });
  assert.equal(r.code, 0);
  assert.equal(typeof r.stdout, 'string');
  assert.match(r.stdout, /HELLO/);
});
test('B1: defaultProbeRun without capture returns code only (no stdout field)', () => {
  const r = defaultProbeRun(process.execPath, ['-e', '0'], {});
  assert.equal(r.code, 0);
  assert.equal(r.stdout, undefined);
});

// ── B2: PowerShell host detection (trusted-path ancestry walk, measured-PS-only) ──
const PS7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const PS51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const mkRun = ({ probe = {}, whereWt = 0 } = {}) => (bin, argv) => {
  if (bin === 'where') return { code: argv[0] === 'wt.exe' ? whereWt : 1, stdout: '' };
  if (probe[bin]) return probe[bin];            // ancestry probe for a TRUSTED_PS bin
  return { code: 1, stdout: '' };
};
const existsOf = (set) => (p) => set.has(p);

test('B2: WT_SESSION → wt (ancestry not run)', () => {
  const d = detectTerminal({ env:{ WT_SESSION:'x' }, platform:'win32', run: mkRun({ whereWt:0 }), now: NOW, pid: 100, exists: existsOf(new Set([PS51])) });
  assert.equal(d.launcher, 'wt');
});
test('B2: no WT + PS7 exists + ancestry PS → powershell with PS7 launcher_bin', () => {
  const d = detectTerminal({ env:{}, platform:'win32', run: mkRun({ probe: { [PS7]: { code:0, stdout:'PS' } } }), now: NOW, pid: 100, exists: existsOf(new Set([PS7, PS51])) });
  assert.equal(d.launcher, 'powershell');
  assert.equal(d.launcher_bin, PS7);
  assert.equal(d.visible, true);
  assert.equal(d.surface, 'window');
});
test('B2: cmd guard — PSModulePath present but ancestry NO → none', () => {
  const env = { PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' };
  const d = detectTerminal({ env, platform:'win32', run: mkRun({ probe: { [PS51]: { code:0, stdout:'NO' } } }), now: NOW, pid: 100, exists: existsOf(new Set([PS51])) });
  assert.equal(d.launcher, 'none');
});
test('B2: 5.1 only (no channel) ancestry PS → powershell with 5.1 bin', () => {
  const d = detectTerminal({ env:{}, platform:'win32', run: mkRun({ probe: { [PS51]: { code:0, stdout:'PS' } } }), now: NOW, pid: 100, exists: existsOf(new Set([PS51])) });
  assert.equal(d.launcher, 'powershell');
  assert.equal(d.launcher_bin, PS51);
});
test('B2: ordered fallback — PS7 probe broken, 5.1 PS → powershell with 5.1 bin', () => {
  const d = detectTerminal({ env:{}, platform:'win32', run: mkRun({ probe: { [PS7]: { code:1, stdout:'' }, [PS51]: { code:0, stdout:'PS' } } }), now: NOW, pid: 100, exists: existsOf(new Set([PS7, PS51])) });
  assert.equal(d.launcher, 'powershell');
  assert.equal(d.launcher_bin, PS51);
});
test('B2: all probes fail + SPOOFED channel → none (no env fallback, plan-ADV1)', () => {
  const d = detectTerminal({ env:{ POWERSHELL_DISTRIBUTION_CHANNEL:'MSI:Windows 10 Enterprise' }, platform:'win32', run: mkRun({ probe: { [PS51]: { code:1, stdout:'' } } }), now: NOW, pid: 100, exists: existsOf(new Set([PS51])) });
  assert.equal(d.launcher, 'none');
});
test('B2: probe UNKNOWN + spoofed channel → none', () => {
  const d = detectTerminal({ env:{ POWERSHELL_DISTRIBUTION_CHANNEL:'x' }, platform:'win32', run: mkRun({ probe: { [PS51]: { code:0, stdout:'UNKNOWN' } } }), now: NOW, pid: 100, exists: existsOf(new Set([PS51])) });
  assert.equal(d.launcher, 'none');
});
test('B2: no trusted PS installed (exists empty) → none', () => {
  const d = detectTerminal({ env:{}, platform:'win32', run: mkRun({}), now: NOW, pid: 100, exists: existsOf(new Set()) });
  assert.equal(d.launcher, 'none');
});
test('B2: cwd-shadow C:\\repo\\powershell.exe is never a candidate', () => {
  const shadow = 'C:\\repo\\powershell.exe';
  const d = detectTerminal({ env:{}, platform:'win32', run: mkRun({ probe: { [shadow]: { code:0, stdout:'PS' } } }), now: NOW, pid: 100, exists: existsOf(new Set([shadow])) });
  assert.equal(d.launcher, 'none');
});
