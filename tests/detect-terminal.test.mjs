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
test('win32 WT_SESSION → wt; powershell needs opt-in', () => {
  assert.equal(detectTerminal({ env:{ WT_SESSION:'x' }, platform:'win32', run: ok, now: NOW }).launcher, 'wt');
  assert.equal(detectTerminal({ env:{}, platform:'win32', run: ok, now: NOW, allowPowershellVisible:false }).launcher, 'none');
  assert.equal(detectTerminal({ env:{}, platform:'win32', run: ok, now: NOW, allowPowershellVisible:true }).launcher, 'powershell');
});
test('linux / no signal → none', () => {
  assert.equal(detectTerminal({ env:{}, platform:'linux', run: ok, now: NOW }).launcher, 'none');
});
