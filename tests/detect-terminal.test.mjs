import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAndPersist, detectTerminal } from '../scripts/lib/detect-terminal.mjs';
import * as runtimeExecutable from '../scripts/lib/runtime-executable.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
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
test('win32 WT_SESSION without an independently verified identity → none/manual and no process call', () => {
  let calls = 0;
  const d = detectTerminal({ env:{ WT_SESSION:'x' }, platform:'win32', run: () => { calls++; return { code: 0 }; }, now: NOW });
  assert.equal(d.launcher, 'none');
  assert.equal(d.reason, 'windows-terminal-unverified');
  assert.equal(calls, 0);
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
const psIdentity = (canonical_path) => ({
  kind: 'powershell', canonical_path, sha256: 'b'.repeat(64), version: '7.5.2',
  platform: 'win32', arch: 'x64', source: 'verified-native', authenticode: null,
});
const mkRun = ({ probe = {}, whereWt = 0 } = {}) => (bin, argv) => {
  if (bin === 'where') return { code: argv[0] === 'wt.exe' ? whereWt : 1, stdout: '' };
  if (probe[bin]) return probe[bin];            // ancestry probe for a TRUSTED_PS bin
  return { code: 1, stdout: '' };
};
const existsOf = (set) => (p) => set.has(p);

test('B2: WT_SESSION without verified wt identity → none (ancestry and bare where not run)', () => {
  const d = detectTerminal({ env:{ WT_SESSION:'x' }, platform:'win32', run: mkRun({ whereWt:0 }), now: NOW, pid: 100, exists: existsOf(new Set([PS51])) });
  assert.equal(d.launcher, 'none');
  assert.equal(d.reason, 'windows-terminal-unverified');
});
test('B2: fixed-path PowerShell existence alone is only a candidate, never authority', () => {
  let calls = 0;
  const d = detectTerminal({ env:{}, platform:'win32', run: () => { calls++; return { code:0, stdout:'PS' }; }, now: NOW, pid: 100, exists: existsOf(new Set([PS7, PS51])) });
  assert.equal(d.launcher, 'none');
  assert.equal(d.reason, 'powershell-unverified');
  assert.equal(calls, 0);
});
test('B2: cmd guard — PSModulePath present but ancestry NO → none', () => {
  const env = { PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' };
  const d = detectTerminal({ env, platform:'win32', run: mkRun({ probe: { [PS51]: { code:0, stdout:'NO' } } }), now: NOW, pid: 100, exists: existsOf(new Set([PS51])) });
  assert.equal(d.launcher, 'none');
});
test('B2: 5.1 only (no channel) ancestry PS → powershell with 5.1 bin', () => {
  const d = detectTerminal({ env:{}, platform:'win32', run: mkRun({ probe: { [PS51]: { code:0, stdout:'PS' } } }), now: NOW, pid: 100,
    windowsLauncherIdentities: { powershell: psIdentity(PS51) }, revalidateLauncher: value => value });
  assert.equal(d.launcher, 'powershell');
  assert.equal(d.launcher_bin, PS51);
});
test('B2: ordered fallback — PS7 probe broken, 5.1 PS → powershell with 5.1 bin', () => {
  const d = detectTerminal({ env:{}, platform:'win32', run: mkRun({ probe: { [PS7]: { code:1, stdout:'' }, [PS51]: { code:0, stdout:'PS' } } }), now: NOW, pid: 100,
    windowsLauncherIdentities: { powershell: psIdentity(PS51) }, revalidateLauncher: value => value });
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

function launcherFixture(name, versionLine) {
  const root = mkdtempSync(join(tmpdir(), 'dl-win-launcher-'));
  const executable = join(root, name);
  writeFileSync(executable, `${name} native bytes`);
  const calls = [];
  const runVersion = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: 0, signal: null, stdout: `${versionLine}\r\n`, stderr: '' };
  };
  return { executable, calls, runVersion };
}

test('verified absolute Windows Terminal identity enables wt and persists the complete identity', () => {
  const fixture = launcherFixture('wt.exe', 'Windows Terminal 1.22.10352.0');
  const identity = runtimeExecutable.resolveTrustedLauncherExecutable('wt', {
    candidatePaths: [fixture.executable], platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
  });
  const d = detectTerminal({
    env: { WT_SESSION: 'x' }, platform: 'win32', arch: 'x64', now: NOW,
    windowsLauncherIdentities: { wt: identity },
    launcherRevalidationOptions: { runVersion: fixture.runVersion },
    run: () => { throw new Error('WT detection must not execute where.exe or a bare launcher'); },
  });
  assert.equal(d.launcher, 'wt');
  assert.equal(d.launcher_bin, identity.canonical_path);
  assert.deepEqual(d.launcher_identity, identity);
  assert.equal(fixture.calls[0].options.shell, false);
});

test('detectAndPersist consumes the durable human launcher approval without identity injection', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-terminal-durable-approval-'));
  const fixture = launcherFixture('wt.exe', 'Windows Terminal 1.22.10352.0');
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-07-12T00:00:00Z'),
    env: { WT_SESSION: 'session-1' }, platform: 'win32',
    run: () => { throw new Error('unapproved init must not probe'); },
  });
  const diagnosis = runtimeExecutable.diagnoseLauncherExecutable('wt', {
    explicitPath: fixture.executable, platform: 'win32', arch: 'x64',
  });
  const approved = runtimeExecutable.approveLauncherExecutable(root, runId, {
    kind: 'wt', candidatePath: fixture.executable,
    expectedCanonicalPath: diagnosis.identity.canonical_path,
    expectedSha256: diagnosis.identity.sha256,
    actor: 'human', confirm: true, fence: { owner: runId, generation: 1 },
    now: Date.parse('2026-07-12T01:00:00Z'), platform: 'win32', arch: 'x64',
    runVersion: fixture.runVersion,
  });

  const descriptor = detectAndPersist(root, runId, {
    owner: runId, generation: 1, env: { WT_SESSION: 'session-1' },
    platform: 'win32', arch: 'x64', now: NOW,
    launcherRevalidationOptions: { runVersion: fixture.runVersion },
    run: () => { throw new Error('WT detection must not execute PATH or bare launcher probes'); },
  });
  assert.equal(descriptor.launcher, 'wt');
  assert.equal(descriptor.launcher_bin, approved.approval.canonical_path);
  assert.deepEqual(descriptor.launcher_identity, approved.approval);
  assert.deepEqual(readState(root, runId).data.session_spawn, descriptor);
});

test('durable launcher approval is authoritative while legacy stored session identity remains compatible', () => {
  const durableFixture = launcherFixture('wt.exe', 'Windows Terminal 1.22.10352.0');
  const root = mkdtempSync(join(tmpdir(), 'dl-terminal-authority-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-07-12T00:00:00Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const diagnosis = runtimeExecutable.diagnoseLauncherExecutable('wt', {
    explicitPath: durableFixture.executable, platform: 'win32', arch: 'x64',
  });
  const approval = runtimeExecutable.approveLauncherExecutable(root, runId, {
    kind: 'wt', candidatePath: durableFixture.executable,
    expectedCanonicalPath: diagnosis.identity.canonical_path, expectedSha256: diagnosis.identity.sha256,
    actor: 'human', confirm: true, fence: { owner: runId, generation: 1 },
    now: Date.parse('2026-07-12T01:00:00Z'), platform: 'win32', arch: 'x64',
    runVersion: durableFixture.runVersion,
  }).approval;
  const injected = { ...approval, canonical_path: '/tmp/replacement/wt.exe', sha256: 'f'.repeat(64) };
  const authoritative = detectAndPersist(root, runId, {
    owner: runId, generation: 1, env: { WT_SESSION: 'session-1' }, platform: 'win32', arch: 'x64', now: NOW,
    windowsLauncherIdentities: { wt: injected },
    launcherRevalidationOptions: { runVersion: durableFixture.runVersion },
  });
  assert.deepEqual(authoritative.launcher_identity, approval, 'test injection cannot replace durable authority');

  const { data } = readState(root, runId);
  delete data.autonomy.launcher_executable_approvals;
  data.session_spawn = { ...authoritative, launcher_identity: { ...approval, source: 'verified-native' } };
  writeState(root, runId, data);
  const legacy = detectAndPersist(root, runId, {
    owner: runId, generation: 1, env: { WT_SESSION: 'session-1' }, platform: 'win32', arch: 'x64', now: NOW,
    revalidateLauncher: identity => identity,
  });
  assert.equal(legacy.launcher, 'wt');
  assert.equal(legacy.launcher_identity.source, 'verified-native');
});

test('detectAndPersist cannot overwrite a concurrent human launcher re-approval with its stale descriptor', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-terminal-reapproval-race-'));
  const oldFixture = launcherFixture('wt.exe', 'Windows Terminal 1.22.10352.0');
  const freshFixture = launcherFixture('wt.exe', 'Windows Terminal 1.22.10353.0');
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-07-12T00:00:00Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const approve = (fixture, at) => {
    const diagnosis = runtimeExecutable.diagnoseLauncherExecutable('wt', {
      explicitPath: fixture.executable, platform: 'win32', arch: 'x64',
    });
    return runtimeExecutable.approveLauncherExecutable(root, runId, {
      kind: 'wt', candidatePath: fixture.executable,
      expectedCanonicalPath: diagnosis.identity.canonical_path,
      expectedSha256: diagnosis.identity.sha256,
      actor: 'human', confirm: true, fence: { owner: runId, generation: 1 },
      now: Date.parse(at), platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
    }).approval;
  };
  const oldApproval = approve(oldFixture, '2026-07-12T01:00:00.000Z');
  let freshApproval;
  let raced = false;

  assert.throws(
    () => detectAndPersist(root, runId, {
      owner: runId, generation: 1, env: { WT_SESSION: 'session-old' },
      platform: 'win32', arch: 'x64', now: NOW,
      revalidateLauncher: (identity) => {
        assert.deepEqual(identity, oldApproval);
        if (!raced) {
          raced = true;
          freshApproval = approve(freshFixture, '2026-07-12T02:00:00.000Z');
        }
        return identity;
      },
    }),
    (error) => {
      assert.match(error.message, /^LAUNCHER_EXECUTABLE_DRIFT: detect-terminal authority changed$/);
      assert.doesNotMatch(error.message, /LAUNCHER_AUTHORITY_DRIFT/);
      return true;
    },
  );

  const after = readState(root, runId).data;
  assert.deepEqual(after.autonomy.launcher_executable_approvals.wt, freshApproval);
  assert.equal(after.session_spawn.launcher, 'none');
  assert.equal(after.session_spawn.launcher_bin, null);
  assert.notEqual(after.session_spawn.reason, null);
  assert.equal(after.session_spawn.launcher_identity, undefined);
});

test('a present durable approval map never falls back to a stale session identity or injected identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-terminal-present-map-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-07-12T00:00:00Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const stale = {
    kind: 'wt', canonical_path: 'C:\\Old\\wt.exe', sha256: 'a'.repeat(64),
    version: '1.0.0', platform: 'win32', arch: 'x64', source: 'human-explicit',
    authenticode: null, approved_by: 'human', approved_at: '2026-07-12T01:00:00.000Z',
  };
  const { data } = readState(root, runId);
  data.autonomy.launcher_executable_approvals = { powershell: null };
  data.session_spawn = {
    platform: 'win32', launcher: 'wt', launcher_bin: stale.canonical_path,
    launcher_identity: stale, launcher_socket: null, surface: 'tab', reachable: true,
    visible: true, signals: {}, probe: null, reason: null,
    fallback: 'launch-command-file', detected_at: NOW,
  };
  writeState(root, runId, data);

  let revalidations = 0;
  const descriptor = detectAndPersist(root, runId, {
    owner: runId, generation: 1, env: { WT_SESSION: 'session-new' },
    platform: 'win32', arch: 'x64', now: NOW,
    windowsLauncherIdentities: { wt: stale },
    revalidateLauncher: identity => { revalidations++; return identity; },
  });
  assert.equal(descriptor.launcher, 'none');
  assert.equal(descriptor.reason, 'windows-terminal-unverified');
  assert.equal(revalidations, 0, 'present durable state is authoritative even when its selected slot is absent');
  assert.equal(readState(root, runId).data.session_spawn.launcher, 'none');
});

test('verified PowerShell identity is the only ancestry probe target; PATH/fixed strings are not authority', () => {
  const fixture = launcherFixture('pwsh.exe', 'PowerShell 7.5.2');
  const identity = runtimeExecutable.resolveTrustedLauncherExecutable('powershell', {
    candidatePaths: [fixture.executable], platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
  });
  const ancestryCalls = [];
  const d = detectTerminal({
    env: { Path: `C:\\repo;${fixture.executable}` }, platform: 'win32', arch: 'x64', now: NOW, pid: 10,
    windowsLauncherIdentities: { powershell: identity },
    launcherRevalidationOptions: { runVersion: fixture.runVersion },
    run: (bin, argv, options) => {
      ancestryCalls.push({ bin, argv, options });
      return { code: 0, stdout: 'PS' };
    },
  });
  assert.equal(d.launcher, 'powershell');
  assert.equal(d.launcher_bin, identity.canonical_path);
  assert.deepEqual(d.launcher_identity, identity);
  assert.deepEqual(ancestryCalls.map(call => call.bin), [identity.canonical_path]);
});

test('launcher identity replacement fails closed before terminal probing and never falls back to another candidate', () => {
  const fixture = launcherFixture('wt.exe', 'Windows Terminal 1.22.10352.0');
  const identity = runtimeExecutable.resolveTrustedLauncherExecutable('wt', {
    candidatePaths: [fixture.executable], platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
  });
  writeFileSync(fixture.executable, 'replacement');
  let processCalls = 0;
  const d = detectTerminal({
    env: { WT_SESSION: 'x' }, platform: 'win32', arch: 'x64', now: NOW,
    windowsLauncherIdentities: { wt: identity },
    run: () => { processCalls++; return { code: 0 }; },
  });
  assert.equal(d.launcher, 'none');
  assert.equal(d.reason, 'windows-terminal-unverified');
  assert.equal(processCalls, 0);
});

test('launcher revalidation options cannot override authoritative win32 platform or host architecture', () => {
  const stored = {
    kind: 'wt', canonical_path: 'C:\\Program Files\\WindowsApps\\wt.exe',
    sha256: 'a'.repeat(64), version: '1.22.10352.0', platform: 'win32', arch: 'x64',
    source: 'verified-native', authenticode: null,
  };
  let seenOptions;
  const d = detectTerminal({
    env: { WT_SESSION: 'x' }, platform: 'win32', arch: 'x64', now: NOW,
    windowsLauncherIdentities: { wt: stored },
    launcherRevalidationOptions: { platform: 'linux', arch: 'arm64', marker: 'kept' },
    revalidateLauncher: (identity, options) => {
      assert.strictEqual(identity, stored);
      seenOptions = options;
      return identity;
    },
  });
  assert.equal(d.launcher, 'wt');
  assert.equal(seenOptions.platform, 'win32');
  assert.equal(seenOptions.arch, 'x64');
  assert.equal(seenOptions.marker, 'kept');
});

test('same kind/path with altered hash version or Authenticode is rejected and never persisted', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-terminal-identity-drift-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-06-27T00:00:00Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const stored = {
    kind: 'wt', canonical_path: 'C:\\Program Files\\WindowsApps\\wt.exe',
    sha256: 'a'.repeat(64), version: '1.22.10352.0', platform: 'win32', arch: 'x64',
    source: 'verified-native',
    authenticode: { status: 'valid', signer: 'Expected Signer', thumbprint: 'aabb' },
  };
  const altered = {
    ...stored,
    sha256: 'b'.repeat(64),
    version: '9.9.9',
    authenticode: { status: 'valid', signer: 'Replacement Signer', thumbprint: 'ccdd' },
  };
  const result = detectAndPersist(root, runId, {
    owner: runId, generation: 1, env: { WT_SESSION: 'x' }, platform: 'win32', arch: 'x64', now: NOW,
    windowsLauncherIdentities: { wt: stored },
    revalidateLauncher: () => altered,
  });
  assert.equal(result.launcher, 'none');
  assert.equal(result.reason, 'windows-terminal-unverified');
  const persisted = readState(root, runId).data.session_spawn;
  assert.equal(persisted.launcher, 'none');
  assert.equal(persisted.launcher_identity, undefined);
  assert.notDeepEqual(persisted.launcher_identity, altered);
});
