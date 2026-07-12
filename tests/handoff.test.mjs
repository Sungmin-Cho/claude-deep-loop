import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { reserveHandoff, releaseLease, acquireLease } from '../scripts/lib/lease.mjs';
import { emitHandoff, buildLaunchCommand } from '../scripts/lib/handoff.mjs';
import { newEpisode, abandonEpisode } from '../scripts/lib/episode.mjs';
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';

// Inject deterministic env so detectTerminal never probes real cmux/osascript.
function seed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime, goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }) });
  return { root, runId };
}

function expect_(runId) { return { owner: runId, generation: 1 }; }

// ── Entry map shape tests ────────────────────────────────────────────────────

test('buildLaunchCommand produces per-OS entry map referencing child run + resume', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'PARENT', childRunId: 'CHILD', handoffRel: 'handoffs/x.md' });
  // interactive has display only
  assert.match(c.interactive.display, /claude -n/);
  assert.match(c.interactive.display, /deep-loop-resume/);
  // terminal-app uses osascript
  assert.equal(c['terminal-app'].bin, 'osascript');
  // wt uses wt.exe
  assert.equal(c.wt.bin, 'wt.exe');
  // headless uses claude
  assert.equal(c.headless.bin, 'claude');
});

test('cmux entry: --command quotes only dynamic args, bin=launcherBin', () => {
  const c = buildLaunchCommand({ root: '/p a', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'cmux', launcherBin: '/a/cmux' });
  assert.equal(c.cmux.bin, '/a/cmux');
  // No launcherSocket → argv starts with new-workspace (no --socket prefix)
  assert.deepEqual(c.cmux.argv.slice(0, 4), ['new-workspace', '--cwd', '/p a', '--command']);
  // --command value uses q() on inner and resumePrompt, NOT on root
  assert.match(c.cmux.argv[4], /^claude -n 'deep-loop-C' '.*deep-loop-resume'$/);
});

test('cmux entry: --socket prepended when launcherSocket provided', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'cmux', launcherBin: '/a/cmux', launcherSocket: '/var/run/cmux.sock' });
  assert.deepEqual(c.cmux.argv.slice(0, 4), ['--socket', '/var/run/cmux.sock', 'new-workspace', '--cwd']);
});

test('headless entry has no bash; uses cwd=root, bin=claude', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'none' });
  assert.equal(c.headless.bin, 'claude');
  assert.equal(c.headless.cwd, '/p');
  assert.ok(!c.headless.argv.includes('-c'), 'no bash -c');
  assert.notEqual(c.headless.bin, 'bash');
});

test('buildLaunchCommand headless entry requests metric-bearing output', () => {
  const cmds = buildLaunchCommand({ root: '/r', parentRunId: 'p', childRunId: 'c', handoffRel: 'handoffs/x.md' });
  assert.ok(cmds.headless.argv.includes('--output-format'), 'headless must request output format');
  assert.ok(cmds.headless.argv.includes('json'), 'headless must request json format');
  assert.ok(cmds.headless.argv.includes('--permission-mode'), 'headless must specify permission mode');
  assert.match(cmds.headless.argv.join(' '), /--output-format json/);
});

test('iterm2 entry: bin=osascript, argv=["-e", ...]', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'iterm2' });
  assert.equal(c.iterm2.bin, 'osascript');
  assert.equal(c.iterm2.argv[0], '-e');
  assert.match(c.iterm2.argv[1], /iTerm/);
  assert.match(c.iterm2.argv[1], /create window/);
});

test('terminal-app entry: bin=osascript, argv=["-e", ...]', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'terminal-app' });
  assert.equal(c['terminal-app'].bin, 'osascript');
  assert.equal(c['terminal-app'].argv[0], '-e');
  assert.match(c['terminal-app'].argv[1], /Terminal/);
  assert.match(c['terminal-app'].argv[1], /do script/);
});

test('wt entry: bin=wt.exe, argv structure correct', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'wt' });
  assert.equal(c.wt.bin, 'wt.exe');
  assert.equal(c.wt.argv[0], '-d');
  assert.equal(c.wt.argv[1], '/p');
  assert.equal(c.wt.argv[2], 'claude');
  assert.equal(c.wt.argv[3], '-n');
  assert.equal(c.wt.argv[4], 'deep-loop-C');
  // resumePrompt is the last element (unquoted, no shell)
  assert.match(c.wt.argv[5], /deep-loop-resume/);
});

test('interactive entry has display string only (no bin/argv)', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md' });
  assert.ok(typeof c.interactive.display === 'string');
  assert.equal(c.interactive.bin, undefined);
  assert.equal(c.interactive.argv, undefined);
});

// ── Escaping tests ───────────────────────────────────────────────────────────

test('osascript inner cd uses q(root) + escApple backslash-doubling — apostrophe root safe', () => {
  const c = buildLaunchCommand({ root: "/p's", parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'terminal-app' });
  assert.equal(c['terminal-app'].bin, 'osascript');
  // q("/p's") = '/p'\''s' (one literal backslash). escApple DOUBLES it (\ → \\) so AppleScript's
  // string-literal parser decodes it back to a single backslash and the shell receives the
  // correct '/p'\''s' → /p's. Without doubling AppleScript would consume the lone backslash →
  // shell gets '/p''s' → /ps (wrong dir). So the AppleScript must contain the DOUBLED form.
  assert.ok(
    c['terminal-app'].argv[1].includes("cd '/p'\\\\''s'"),
    'escApple must double the backslash q() introduced for the apostrophe',
  );
  // The un-doubled (single-backslash) form must NOT appear — that would be the bug.
  assert.ok(!c['terminal-app'].argv[1].includes("cd '/p'\\''s'"), 'lone-backslash form must not leak through');
});

test('escApple doubles backslash AND escapes double-quote (root with both)', () => {
  const c = buildLaunchCommand({ root: '/a\\b"c', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'iterm2' });
  const script = c.iterm2.argv[1];
  // root /a\b"c → q() (no apostrophes) = '/a\b"c'. escApple: backslash → \\, then " → \".
  // So the AppleScript string literal must contain '/a\\b\"c' (doubled backslash + escaped quote).
  assert.ok(script.includes('/a\\\\b\\"c'), 'escApple must double the backslash then escape the double-quote');
});

const TRUSTED_PS_BIN = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
test('powershell uses -EncodedCommand of psq-escaped inner', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'powershell', launcherBin: TRUSTED_PS_BIN });
  assert.deepEqual(c.powershell.argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const cmdStr = c.powershell.argv[c.powershell.argv.indexOf('-Command') + 1];
  assert.match(cmdStr, /-ArgumentList '-NoProfile','-NoExit','-EncodedCommand'/);
  const b64 = cmdStr.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  const decoded = Buffer.from(b64, 'base64').toString('utf16le');
  assert.match(decoded, /Set-Location -LiteralPath '\/p'/);
});

test('powershell: root with single-quote is doubled (psq escaping)', () => {
  const c = buildLaunchCommand({ root: "/p'q", parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'powershell', launcherBin: TRUSTED_PS_BIN });
  const cmdStr = c.powershell.argv[c.powershell.argv.indexOf('-Command') + 1];
  const b64 = cmdStr.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  const decoded = Buffer.from(b64, 'base64').toString('utf16le');
  // psq("/p'q") = "/p''q" — single-quote doubled
  assert.match(decoded, /Set-Location -LiteralPath '\/p''q'/);
});

function executableIdentity(runtime, canonicalPath, overrides = {}) {
  return {
    runtime,
    canonical_path: canonicalPath,
    sha256: 'a'.repeat(64),
    version: runtime === 'claude' ? '2.1.0' : '0.144.1',
    platform: 'win32', arch: 'x64', source: 'human-explicit', package: null,
    authenticode: null, approved_by: 'human', approved_at: '2026-07-11T08:00:00.000Z',
    ...overrides,
  };
}

function launcherIdentity(kind, canonicalPath) {
  return {
    kind, canonical_path: canonicalPath, sha256: 'b'.repeat(64), version: '1.0.0',
    platform: 'win32', arch: 'x64', source: 'verified-native', authenticode: null,
  };
}

test('Windows Claude descriptors without trusted runtime and launcher identities stay manual/unavailable', () => {
  const c = buildLaunchCommand({
    runtime: 'claude', platform: 'win32', root: 'C:\\repo', parentRunId: 'P', childRunId: 'C',
    handoffRel: 'handoffs/x.md', launcher: 'wt', launcherBin: 'wt.exe',
  });
  assert.equal(c.wt.unavailable, true);
  assert.equal(c.wt.bin, undefined);
  assert.equal(c.headless.unavailable, true);
  assert.equal(c.headless.bin, undefined);
  assert.match(c.interactive.display, /manual/i);
  assert.ok(!Object.values(c).some(entry => entry?.bin === 'wt.exe' || entry?.bin === 'claude'));
});

test('Windows Terminal descriptor uses verified absolute wt.exe and nested native Claude as single argv elements', () => {
  const claude = executableIdentity('claude', 'C:\\Program Files & Tools\\Claude\\claude native.exe');
  const wt = launcherIdentity('wt', 'C:\\Program Files\\WindowsApps\\wt.exe');
  const c = buildLaunchCommand({
    runtime: 'claude', platform: 'win32', root: 'C:\\repo & work', parentRunId: 'P', childRunId: 'C',
    handoffRel: 'handoffs/x.md', launcher: 'wt', runtimeExecutableIdentity: claude, launcherIdentity: wt,
  });
  assert.equal(c.wt.bin, wt.canonical_path);
  assert.equal(c.wt.shell, false);
  assert.equal(c.wt.argv[1], 'C:\\repo & work');
  assert.equal(c.wt.argv[2], claude.canonical_path);
  assert.equal(c.wt.argv.filter(value => value === claude.canonical_path).length, 1);
  assert.ok(!c.wt.argv.includes('claude'));
});

test('Windows Terminal display is a copy-pasteable PowerShell command with every dynamic argument protected', () => {
  const claude = executableIdentity('claude', "C:\\Program Files & O'Brien\\Claude\\claude native.exe");
  const wt = launcherIdentity('wt', "C:\\Program Files & O'Brien\\Windows Terminal\\wt.exe");
  const root = "C:\\repo & O'Brien";
  const c = buildLaunchCommand({
    runtime: 'claude', platform: 'win32', root, parentRunId: 'P', childRunId: 'C',
    handoffRel: 'handoffs/x.md', launcher: 'wt', runtimeExecutableIdentity: claude,
    launcherIdentity: wt, model: 'claude-opus-4-8[1m]', effort: 'xhigh',
  });

  assert.deepEqual(c.wt.argv, [
    '-d', root, claude.canonical_path, '-n', 'deep-loop-C',
    'Read .deep-loop/runs/P/handoffs/x.md first; then run /deep-loop-resume',
    '--model', 'claude-opus-4-8[1m]', '--effort', 'xhigh',
  ]);
  assert.deepEqual(c.wt.nativeExecutableArgvIndices, [2]);
  assert.equal(c.wt.shell, false);
  assert.equal(c.wt.display,
    "& 'C:\\Program Files & O''Brien\\Windows Terminal\\wt.exe' -d 'C:\\repo & O''Brien' "
    + "'C:\\Program Files & O''Brien\\Claude\\claude native.exe' -n 'deep-loop-C' "
    + "'Read .deep-loop/runs/P/handoffs/x.md first; then run /deep-loop-resume' "
    + "--model 'claude-opus-4-8[1m]' --effort 'xhigh'",
  );
});

test('Windows PowerShell descriptor uses verified launcher and encodes verified native Claude path, never a bare name', () => {
  const claude = executableIdentity('claude', "C:\\Program Files\\Claude & Co\\claude's native.exe");
  const ps = launcherIdentity('powershell', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  const c = buildLaunchCommand({
    runtime: 'claude', platform: 'win32', root: 'C:\\repo', parentRunId: 'P', childRunId: 'C',
    handoffRel: 'handoffs/x.md', launcher: 'powershell', runtimeExecutableIdentity: claude, launcherIdentity: ps,
  });
  assert.equal(c.powershell.bin, ps.canonical_path);
  assert.equal(c.powershell.shell, false);
  assert.deepEqual(c.powershell.argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const command = c.powershell.argv.at(-1);
  assert.match(command, /-ArgumentList '-NoProfile','-NoExit','-EncodedCommand'/);
  const encoded = command.match(/EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.ok(decoded.includes("& 'C:\\Program Files\\Claude & Co\\claude''s native.exe'"));
  assert.ok(!/(^|[;&]\s*)claude(?:\s|$)/i.test(decoded));
});

test('native Windows PowerShell display single-quotes the complete command argument', () => {
  const runtimePath = "C:\\Runtime $env $(Get-Date)\\O'Brien`Host\\claude.exe";
  const launcherPath = "C:\\Power $env $(Get-Date)\\O'Brien`Host\\pwsh.exe";
  const claude = executableIdentity('claude', runtimePath);
  const ps = launcherIdentity('powershell', launcherPath);
  const c = buildLaunchCommand({
    runtime: 'claude', platform: 'win32', root: 'C:\\repo', parentRunId: 'P', childRunId: 'C',
    handoffRel: 'handoffs/x.md', launcher: 'powershell', runtimeExecutableIdentity: claude, launcherIdentity: ps,
  });
  const innerPS = "Set-Location -LiteralPath 'C:\\repo'; & 'C:\\Runtime $env $(Get-Date)\\O''Brien`Host\\claude.exe' "
    + "-n 'deep-loop-C' 'Read .deep-loop/runs/P/handoffs/x.md first; then run /deep-loop-resume'";
  const encoded = Buffer.from(innerPS, 'utf16le').toString('base64');
  const psCmd = "Start-Process 'C:\\Power $env $(Get-Date)\\O''Brien`Host\\pwsh.exe' "
    + `-ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${encoded}'`;

  assert.deepEqual({
    platform: c.powershell.platform,
    bin: c.powershell.bin,
    argv: c.powershell.argv,
    shell: c.powershell.shell,
    nativeExecutableTargets: c.powershell.nativeExecutableTargets,
  }, {
    platform: 'win32',
    bin: launcherPath,
    argv: ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    shell: false,
    nativeExecutableTargets: [runtimePath],
  });
  assert.equal(
    c.powershell.display,
    `& 'C:\\Power $env $(Get-Date)\\O''Brien\`Host\\pwsh.exe' -NoProfile -NonInteractive -Command '${psCmd.replaceAll("'", "''")}'`,
  );
  assert.ok(!c.powershell.display.includes('-Command "'), 'complete command must not use an outer double-quoted region');
});

test('display strings use q(root) for paths with apostrophes and semicolons', () => {
  const specialRoot = "/p 's;x";
  const c = buildLaunchCommand({ root: specialRoot, parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcherBin: 'cmux', launcherSocket: '/sock x' });
  const display = c.interactive.display;
  // The raw unescaped root must not appear verbatim — if it did, ';x' would be a separate shell command.
  assert.ok(!display.includes(specialRoot), 'raw unescaped root must not appear verbatim in interactive display');
  // POSIX escape form must be present (q() wraps and escapes the apostrophe as '\''')
  assert.ok(display.includes("'\\''"), 'POSIX quote-escape must appear for apostrophe in root');
  // headless display also uses q(root)
  assert.ok(c.headless.display.includes("'\\''"), 'headless display must also use q(root)');
  // EVERY display must quote root (spec §5 / inv.8) — cmux.display and wt.display too.
  assert.ok(!c.cmux.display.includes(specialRoot), 'raw unescaped root must not appear verbatim in cmux display');
  assert.ok(c.cmux.display.includes("'\\''"), 'cmux display must q()-escape the apostrophe in root');
  assert.ok(!c.wt.display.includes(specialRoot), 'raw unescaped root must not appear verbatim in wt display');
  assert.ok(c.wt.display.includes("'\\''"), 'wt display must q()-escape the apostrophe in root');
  // launcherSocket with a space must also be quoted in cmux display (no bare token splitting).
  assert.ok(!c.cmux.display.includes('--socket /sock x'), 'cmux display must quote the socket');
});

// ── Validation tests ─────────────────────────────────────────────────────────

test('UNSAFE_SPAWN_ARG: childRunId with illegal chars throws', () => {
  assert.throws(
    () => buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'bad$id', handoffRel: 'handoffs/x.md' }),
    /UNSAFE_SPAWN_ARG/
  );
});

test('UNSAFE_SPAWN_ARG: parentRunId with illegal chars throws', () => {
  assert.throws(
    () => buildLaunchCommand({ root: '/p', parentRunId: 'P;evil', childRunId: 'C', handoffRel: 'handoffs/x.md' }),
    /UNSAFE_SPAWN_ARG/
  );
});

test('UNSAFE_SPAWN_ARG: parentRunId with shell-injection chars throws', () => {
  assert.throws(
    () => buildLaunchCommand({ root: '/p', parentRunId: 'P$(inject)', childRunId: 'C', handoffRel: 'handoffs/x.md' }),
    /UNSAFE_SPAWN_ARG/
  );
});

test('UNSAFE_SPAWN_ARG: handoffRel with path traversal throws', () => {
  assert.throws(
    () => buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/../evil.md' }),
    /UNSAFE_SPAWN_ARG/
  );
});

test('UNSAFE_SPAWN_ARG: handoffRel not starting with handoffs/ throws', () => {
  assert.throws(
    () => buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'other/x.md' }),
    /UNSAFE_SPAWN_ARG/
  );
});

// ── emitHandoff integration tests (unchanged semantics) ─────────────────────

test('emitHandoff writes md + compaction-state(M3) + launch-command, chains session, sets releasing', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const r = emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', now, expect: expect_(runId) });
  assert.equal(r.ok, true);
  assert.ok(existsSync(r.handoffPath));
  // compaction-state는 M3 envelope (producer=deep-loop, parent_run_id=runId)
  const cs = JSON.parse(readFileSync(join(runDir(root, runId), 'handoffs', r.csName), 'utf8'));
  assert.equal(cs.envelope.producer, 'deep-loop');
  assert.equal(cs.envelope.parent_run_id, runId);
  const { data } = readState(root, runId);
  assert.equal(data.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(data.session_chain.lease.state, 'releasing');
  const cur = data.session_chain.sessions.find(s => s.run_id === runId);
  assert.equal(cur.superseded_by, r.childRunId);
  assert.ok(data.session_chain.sessions.some(s => s.run_id === r.childRunId));
  const md = readFileSync(r.handoffPath, 'utf8');
  assert.match(md, /이전 대화/);
  assert.match(md, /\/deep-loop-resume/);
});

test('legacy runtime handoff remains Claude-compatible', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  delete data.autonomy.session_runtime;
  delete data.autonomy.runtime_source;
  writeState(root, runId, data);
  const r = emitHandoff(root, runId, { now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId) });
  assert.equal(r.ok, true);
  const launch = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.match(launch, /claude -p/);
  assert.match(launch, /\/deep-loop-resume/);
  assert.ok(!launch.includes('$deep-loop:deep-loop-resume'));
});

test('Codex handoff emits qualified manual resume descriptors and no Claude process command', () => {
  const { root, runId } = seed('codex');
  const { data } = readState(root, runId);
  data.autonomy.session_model = 'claude-opus-4-8[1m]';
  data.autonomy.session_effort = 'xhigh';
  writeState(root, runId, data);
  const r = emitHandoff(root, runId, { now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId) });
  assert.equal(r.ok, true);
  const launch = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.match(launch, /\$deep-loop:deep-loop-resume/);
  assert.match(launch, /codex-transport-not-activated/);
  assert.ok(!/\bclaude\s+(?:-p|-n)\b/.test(launch), 'Codex handoff must not emit a Claude process command');
  assert.ok(!launch.includes('claude://'), 'Codex App handoff must not emit a private URL');
  assert.ok(!launch.includes('--model'));
  assert.ok(!launch.includes('--effort'));
});

test('Codex headless descriptor is runnable only with an explicit absolute executable', () => {
  const c = buildLaunchCommand({
    runtime: 'codex', root: 'C:\\repo', parentRunId: 'PARENT', childRunId: 'CHILD', handoffRel: 'handoffs/x.md',
    codexExecutable: 'C:\\trusted\\codex.exe', deepLoopRoot: 'C:\\deep-loop', model: 'gpt-5.4', effort: 'xhigh',
  });
  assert.equal(c.headless.bin, 'C:\\trusted\\codex.exe');
  assert.equal(c.headless.shell, false);
  assert.equal(c.headless.stdin.includes(JSON.stringify('C:\\deep-loop\\skills\\deep-loop-resume\\SKILL.md')), true);
  assert.equal(c.headless.argv.includes(c.headless.stdin), false, 'resume prompt must stay off argv');
  assert.deepEqual(c.headless.argv.slice(-3), ['-C', 'C:\\repo', '-']);
  assert.ok(c.headless.argv.includes('model_reasoning_effort="xhigh"'));
  assert.ok(!c.headless.argv.includes('--profile'));
  assert.ok(!c.headless.argv.includes('--add-dir'));
});

test('Codex native Windows headless descriptor accepts a revalidated identity and never a bare runtime', () => {
  const codex = executableIdentity('codex', 'C:\\Program Files & Tools\\Codex\\codex.exe');
  const c = buildLaunchCommand({
    runtime: 'codex', platform: 'win32', root: 'C:\\repo', parentRunId: 'PARENT', childRunId: 'CHILD',
    handoffRel: 'handoffs/x.md', runtimeExecutableIdentity: codex, deepLoopRoot: 'C:\\deep-loop',
    model: 'gpt-5.4', effort: 'xhigh',
  });
  assert.equal(c.headless.bin, codex.canonical_path);
  assert.equal(c.headless.shell, false);
  assert.ok(!c.headless.argv.includes('codex'));
});

test('Codex native Windows Terminal descriptor pins trusted machine argv and literal-safe PowerShell display', () => {
  const root = "C:\\repo $env $(Get-Date) & O'Brien`Work";
  const runtimePath = "C:\\Runtime $env $(Get-Date) & O'Brien`Host\\codex.exe";
  const launcherPath = "C:\\Terminal $env $(Get-Date) & O'Brien`Host\\wt.exe";
  const codex = executableIdentity('codex', runtimePath);
  const wt = launcherIdentity('wt', launcherPath);
  const c = buildLaunchCommand({
    runtime: 'codex', platform: 'win32', root, parentRunId: 'PARENT', childRunId: 'CHILD',
    handoffRel: 'handoffs/x.md', runtimeExecutableIdentity: codex, launcherIdentity: wt,
    deepLoopRoot: 'C:\\Deep Loop', model: 'gpt-5.4', effort: 'xhigh',
  });
  const prompt = `Read ${JSON.stringify(`${root}\\.deep-loop\\runs\\PARENT\\handoffs\\x.md`)} first; then run $deep-loop:deep-loop-resume --project-root ${JSON.stringify(root)} --run-id ${JSON.stringify('PARENT')}`;
  const effortConfig = 'model_reasoning_effort="xhigh"';

  assert.equal(c.wt.unavailable, undefined, 'trusted Codex+WT identities with an explicit valid deep-loop root must activate WT');
  assert.deepEqual({
    platform: c.wt.platform,
    bin: c.wt.bin,
    argv: c.wt.argv,
    nativeExecutableArgvIndices: c.wt.nativeExecutableArgvIndices,
    shell: c.wt.shell,
  }, {
    platform: 'win32',
    bin: launcherPath,
    argv: ['-d', root, runtimePath, '-C', root, '--model', 'gpt-5.4', '-c', effortConfig, prompt],
    nativeExecutableArgvIndices: [2],
    shell: false,
  });
  assert.equal(
    c.wt.display,
    `& '${launcherPath.replaceAll("'", "''")}' -d '${root.replaceAll("'", "''")}' `
      + `'${runtimePath.replaceAll("'", "''")}' -C '${root.replaceAll("'", "''")}' `
      + `--model 'gpt-5.4' -c '${effortConfig}' '${prompt.replaceAll("'", "''")}'`,
  );
  assert.equal(c.powershell.unavailable, true, 'a WT identity must not authorize PowerShell');
  assert.ok(!c.wt.argv.includes('codex'), 'the nested runtime must never be a bare name');
});

test('Codex native Windows PowerShell descriptor pins encoded trusted invocation and hostile literal safety', () => {
  const root = "C:\\repo $env $(Get-Date) & O'Brien`Work";
  const runtimePath = "C:\\Runtime $env $(Get-Date) & O'Brien`Host\\codex.exe";
  const launcherPath = "C:\\Power $env $(Get-Date) & O'Brien`Host\\pwsh.exe";
  const codex = executableIdentity('codex', runtimePath);
  const ps = launcherIdentity('powershell', launcherPath);
  const c = buildLaunchCommand({
    runtime: 'codex', platform: 'win32', root, parentRunId: 'PARENT', childRunId: 'CHILD',
    handoffRel: 'handoffs/x.md', runtimeExecutableIdentity: codex, launcherIdentity: ps,
    deepLoopRoot: 'C:\\Deep Loop', model: 'gpt-5.4', effort: 'xhigh',
  });
  const prompt = `Read ${JSON.stringify(`${root}\\.deep-loop\\runs\\PARENT\\handoffs\\x.md`)} first; then run $deep-loop:deep-loop-resume --project-root ${JSON.stringify(root)} --run-id ${JSON.stringify('PARENT')}`;
  const effortConfig = 'model_reasoning_effort="xhigh"';
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const inner = `Set-Location -LiteralPath ${quote(root)}; & ${quote(runtimePath)} -C ${quote(root)} --model ${quote('gpt-5.4')} -c ${quote(effortConfig)} ${quote(prompt)}`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const psCmd = `Start-Process ${quote(launcherPath)} -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${encoded}'`;

  assert.equal(c.powershell.unavailable, undefined, 'trusted Codex+PowerShell identities with an explicit valid deep-loop root must activate PowerShell');
  assert.deepEqual({
    platform: c.powershell.platform,
    bin: c.powershell.bin,
    argv: c.powershell.argv,
    nativeExecutableTargets: c.powershell.nativeExecutableTargets,
    shell: c.powershell.shell,
  }, {
    platform: 'win32',
    bin: launcherPath,
    argv: ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    nativeExecutableTargets: [runtimePath],
    shell: false,
  });
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), inner);
  assert.equal(
    c.powershell.display,
    `& ${quote(launcherPath)} -NoProfile -NonInteractive -Command ${quote(psCmd)}`,
  );
  assert.equal(c.wt.unavailable, true, 'a PowerShell identity must not authorize WT');
  assert.ok(!/(^|[;&]\s*)codex(?:\s|$)/i.test(inner), 'the encoded invocation must never use a bare runtime');
});

test('Codex native Windows visible descriptors reject bare, UNC, and mismatched executable identities', () => {
  const base = {
    runtime: 'codex', platform: 'win32', root: 'C:\\repo', parentRunId: 'PARENT', childRunId: 'CHILD',
    handoffRel: 'handoffs/x.md', deepLoopRoot: 'C:\\Deep Loop',
  };
  for (const [label, runtimePath, launcher] of [
    ['bare runtime', 'codex.exe', launcherIdentity('wt', 'C:\\Windows\\wt.exe')],
    ['UNC runtime', '\\\\server\\share\\codex.exe', launcherIdentity('wt', 'C:\\Windows\\wt.exe')],
    ['UNC launcher', 'C:\\Runtime\\codex.exe', launcherIdentity('wt', '\\\\server\\share\\wt.exe')],
    ['mismatched launcher', 'C:\\Runtime\\codex.exe', launcherIdentity('powershell', 'C:\\PowerShell\\pwsh.exe')],
  ]) {
    const c = buildLaunchCommand({
      ...base,
      runtimeExecutableIdentity: executableIdentity('codex', runtimePath),
      launcherIdentity: launcher,
    });
    assert.equal(c.wt.unavailable, true, label);
    assert.equal(c.wt.bin, undefined, label);
  }
});

test('emitHandoff: approved native Windows Codex uses injected deep-loop root and emits one child', () => {
  const { root, runId } = seed('codex');
  const codex = executableIdentity('codex', 'C:\\Program Files & Tools\\Codex\\codex.exe');
  const deepLoopRoot = 'C:\\Injected Deep Loop';
  const { data } = readState(root, runId);
  data.autonomy.runtime_executable_approval = codex;
  writeState(root, runId, data);

  let emitted;
  let constructionError = null;
  try {
    emitted = emitHandoff(root, runId, {
      now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId),
      platform: 'win32', deepLoopRoot,
    });
  } catch (error) {
    constructionError = error;
  }
  const after = readState(root, runId).data;
  const lease = after.session_chain.lease;
  assert.equal(
    constructionError,
    null,
    `approved Codex descriptor threw ${constructionError?.message}; phase=${lease.handoff_phase}; child=${lease.handoff_child_run_id}; handoffs=${existsSync(join(runDir(root, runId), 'handoffs'))}; terminal=${existsSync(join(runDir(root, runId), 'terminal'))}`,
  );
  assert.equal(emitted.ok, true);
  assert.equal(emitted.reason, 'emitted');
  assert.equal(lease.handoff_phase, 'emitted');
  assert.equal(lease.state, 'releasing');
  const children = after.session_chain.sessions.filter(session => session.run_id !== runId);
  assert.equal(children.length, 1);
  assert.equal(children[0].run_id, emitted.childRunId);

  const entries = buildLaunchCommand({
    runtime: 'codex', platform: 'win32', root, parentRunId: runId,
    childRunId: emitted.childRunId, handoffRel: emitted.handoffRel,
    runtimeExecutableIdentity: codex, deepLoopRoot,
  });
  const resumeSkillPath = 'C:\\Injected Deep Loop\\skills\\deep-loop-resume\\SKILL.md';
  assert.ok(entries.headless.stdin.includes(JSON.stringify(resumeSkillPath)));
});

test('emitHandoff: invalid relative deepLoopRoot rolls back reservation before artifacts and rethrows original error', () => {
  const { root, runId } = seed('codex');
  const { data } = readState(root, runId);
  data.autonomy.runtime_executable_approval = executableIdentity('codex', 'C:\\trusted\\codex.exe');
  writeState(root, runId, data);

  assert.throws(
    () => emitHandoff(root, runId, {
      now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId),
      platform: 'win32', deepLoopRoot: 'relative/deep-loop',
    }),
    (error) => error?.message === 'INVALID_DEEP_LOOP_ROOT: explicit absolute deep-loop root required',
  );
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_idempotency_key, null);
  assert.equal(lease.handoff_child_run_id, null);
  assert.equal(existsSync(join(runDir(root, runId), 'handoffs')), false);
  assert.equal(existsSync(join(runDir(root, runId), 'terminal')), false);
});

test('Codex max effort fails before handoff reservation or artifact writes', () => {
  const { root, runId } = seed('codex');
  const { data } = readState(root, runId);
  data.autonomy.session_effort = 'max';
  writeState(root, runId, data);

  assert.throws(
    () => emitHandoff(root, runId, { now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId) }),
    /UNSUPPORTED_RUNTIME_EFFORT/,
  );
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.lease.handoff_child_run_id ?? null, null);
  assert.equal(existsSync(join(runDir(root, runId), 'handoffs')), false);
  assert.equal(existsSync(join(runDir(root, runId), 'terminal')), false);
});

test('handoff descriptor records canonical project root and explicit logical run id', () => {
  const parent = mkdtempSync(join(tmpdir(), 'dl-alias-'));
  const canonicalRoot = join(parent, 'canonical');
  const aliasRoot = join(parent, 'alias');
  mkdirSync(canonicalRoot);
  createDirectoryJunction(canonicalRoot, aliasRoot);
  const { runId } = initRun(aliasRoot, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }) });
  const storedRoot = readState(aliasRoot, runId).data.project.root;
  const r = emitHandoff(aliasRoot, runId, { now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId) });
  assert.equal(r.ok, true);
  assert.ok(r.handoffPath.startsWith(storedRoot), 'artifact path must use the stored canonical root');
  const md = readFileSync(r.handoffPath, 'utf8');
  assert.ok(md.includes(storedRoot), 'handoff must carry canonical project root');
  assert.ok(md.includes(runId), 'handoff must carry explicit logical run id');
  const launch = readFileSync(join(runDir(storedRoot, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.ok(launch.includes(storedRoot), 'launch descriptor must use the canonical root');
  assert.ok(!launch.includes(aliasRoot), 'launch descriptor must not preserve the symlink alias');
});

test('copied-root handoff is fenced before any descriptor file is written', () => {
  const { root, runId } = seed();
  const copyParent = mkdtempSync(join(tmpdir(), 'dl-copy-'));
  const copyRoot = join(copyParent, 'copy');
  cpSync(root, copyRoot, { recursive: true });
  const copiedRunDir = runDir(copyRoot, runId);
  const copiedLaunch = join(runDir(copyRoot, runId), 'terminal', 'launch-command.txt');
  const copiedHandoffs = join(copiedRunDir, 'handoffs');
  const beforeLoop = readFileSync(join(copiedRunDir, 'loop.json'), 'utf8');
  const beforeHash = readFileSync(join(copiedRunDir, '.loop.hash'), 'utf8');
  assert.equal(existsSync(copiedLaunch), false);
  assert.equal(existsSync(copiedHandoffs), false);
  assert.throws(
    () => emitHandoff(copyRoot, runId, { now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId) }),
    /PROJECT_ROOT_FENCED/,
  );
  assert.equal(existsSync(copiedLaunch), false, 'root fence must precede descriptor writes');
  assert.equal(existsSync(copiedHandoffs), false, 'root fence must precede handoff artifact directory creation');
  assert.equal(readFileSync(join(copiedRunDir, 'loop.json'), 'utf8'), beforeLoop, 'copied durable state must remain byte-identical');
  assert.equal(readFileSync(join(copiedRunDir, '.loop.hash'), 'utf8'), beforeHash, 'copied state anchor must remain byte-identical');
});

test('emitHandoff dedups: second trigger while in-flight is a no-op', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const ex = expect_(runId);
  assert.equal(emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex }).ok, true);
  const second = emitHandoff(root, runId, { trigger: 'precompact', now, expect: ex });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'handoff-in-flight');
});

// Codex r1 🔴1: 같은 트리거 재호출은 새 child/session 을 만들지 않고 기존 emit 을 멱등 반환.
test('emitHandoff same-trigger re-entry is idempotent (one child, no duplicate session)', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const ex = expect_(runId);
  const first = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  const again = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'already-emitted');
  assert.equal(again.childRunId, first.childRunId);
  assert.equal(again.handoffRel, first.handoffRel);  // 전체 메타데이터 멱등 반환 (Codex r2 🔴1) → respawn 이 올바른 경로 사용
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});

// launch 명령이 **부모** run 경로의 handoff 파일을 가리키는지 (Codex r1 🔴3)
test('launch command references parent run dir handoff path', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'PARENT', childRunId: 'CHILD', handoffRel: 'handoffs/x.md' });
  assert.match(c.interactive.display, /\.deep-loop\/runs\/PARENT\/handoffs\/x\.md/);
  assert.match(c.headless.display, /\.deep-loop\/runs\/PARENT\/handoffs\/x\.md/);
  assert.match(c.interactive.display, /deep-loop-CHILD/);
});

// Fix 3: emitHandoff with stale expect is fenced at reserve step; correct expect succeeds
test('emitHandoff: stale expect fences at reserve (no mutation); correct expect proceeds', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  // Stale owner → fenced
  const r1 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: { owner: 'WRONG', generation: 1 } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'fenced');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
  // Correct expect → succeeds
  const r2 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: { owner: runId, generation: 1 } });
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, 'emitted');
});

// Fix 3: emitHandoff with generation bumped (lease acquired by another actor) → fenced at reserve step
test('emitHandoff: lease stolen before call → fenced at reserve, new owner lease intact', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const CHILD2 = 'CHILD2-ACTOR';
  // Lease is released and taken by another actor (generation bumps to 2)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: CHILD2, expectGeneration: 1, runtime: 'claude', now });
  // emitHandoff with stale expect (original owner/gen=1) → fenced at reserveHandoff (generation mismatch)
  const r = emitHandoff(root, runId, { trigger: 'milestone', now, expect: { owner: runId, generation: 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fenced');
  // New owner's lease is intact (not mutated)
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.owner_run_id, CHILD2);
  assert.equal(lease.generation, 2);
  assert.equal(lease.handoff_phase, 'acquired');
});

// Codex r3 🔴1: reserve 후 session 미생성(첫 emit 중단) 상태에서 재진입해도 reserve 가 영속한 childRunId 로 1개만 생성.
test('emitHandoff fall-through after bare reserve reuses reserved childRunId (no duplicate child)', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const ex = expect_(runId);
  const r = reserveHandoff(root, runId, { trigger: 'milestone', now });
  assert.equal(r.reserved, true);
  const e1 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  assert.equal(e1.childRunId, r.childRunId);
  const e2 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  assert.equal(e2.childRunId, r.childRunId);
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});

// Codex r13: FENCE_REQUIRED — emitHandoff throws when expect is absent
test('emitHandoff throws FENCE_REQUIRED when called without expect', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  assert.throws(
    () => emitHandoff(root, runId, { trigger: 'milestone', now }),
    /FENCE_REQUIRED/
  );
});

// Task 11: resumePolicy wired to lease.resume_policy in same appendAnchored txn
test('emitHandoff with resumePolicy headless → lease.resume_policy headless', () => {
  const { root, runId } = seed();
  emitHandoff(root, runId, { trigger: 'milestone', now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId), resumePolicy: 'headless' });
  assert.equal(readState(root, runId).data.session_chain.lease.resume_policy, 'headless');
});

test('emitHandoff with resumePolicy visible → lease.resume_policy visible', () => {
  const { root, runId } = seed();
  emitHandoff(root, runId, { trigger: 'milestone', now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId), resumePolicy: 'visible' });
  assert.equal(readState(root, runId).data.session_chain.lease.resume_policy, 'visible');
});

test('emitHandoff with no resumePolicy → lease.resume_policy defaults to visible', () => {
  const { root, runId } = seed();
  emitHandoff(root, runId, { trigger: 'milestone', now: Date.parse('2026-06-24T01:00:00Z'), expect: expect_(runId) });
  assert.equal(readState(root, runId).data.session_chain.lease.resume_policy, 'visible');
});

// Task 10: abandoned episodes must appear in handoff markdown so the inheriting session sees cancelled work.
test('handoff markdown lists abandoned episodes under abandoned: label', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const fence = expect_(runId);
  // Create a maker episode then immediately abandon it (simulates orphaned/stranded work).
  const ep = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implement', point: 'implementation',
    fence,
  });
  abandonEpisode(root, runId, ep.id, { reason: 'orphan', confirm: true, fence });
  // Emit handoff and read the generated markdown.
  const r = emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', now, expect: fence });
  assert.equal(r.ok, true);
  const md = readFileSync(r.handoffPath, 'utf8');
  assert.match(md, /abandoned:.*001-deep-work/);
});

// ── B3: nullable powershell entry + trusted-bin gate (2026-06-29 Windows fixes) ──
const baseArgs = { root: '/p', parentRunId: '01PARENT', childRunId: '01CHILD', handoffRel: 'handoffs/x.md' };
const PS7BIN = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

test('B3: powershell entry uses absolute trusted launcherBin as bin (not bare powershell)', () => {
  const cmds = buildLaunchCommand({ ...baseArgs, launcher: 'powershell', launcherBin: PS7BIN });
  assert.equal(cmds.powershell.bin, PS7BIN);
  assert.notEqual(cmds.powershell.bin, 'powershell');
  assert.ok(!cmds.powershell.unavailable);
});

test('B3: powershell display is PS-pasteable (call operator) for a path with spaces — plan-ADV2', () => {
  const cmds = buildLaunchCommand({ ...baseArgs, launcher: 'powershell', launcherBin: PS7BIN });
  assert.match(cmds.powershell.display, /^& '/);
  assert.match(cmds.powershell.display, /pwsh\.exe' -NoProfile -NonInteractive -Command /);
  assert.ok(!/^'C:\\/.test(cmds.powershell.display), 'display must not be a bare quoted-path literal');
});

test('B3: launcher=powershell + launcherBin null → unavailable entry, no bare bin', () => {
  const cmds = buildLaunchCommand({ ...baseArgs, launcher: 'powershell', launcherBin: null });
  assert.equal(cmds.powershell.unavailable, true);
  assert.equal(cmds.powershell.bin, null);
  assert.equal(typeof cmds.powershell.display, 'string');   // still has a display for launch-command.txt
});

test('B3: untrusted absolute / UNC launcherBin → unavailable (not runnable) — plan-ADV3', () => {
  for (const bad of ['C:\\repo\\powershell.exe', '\\\\server\\share\\pwsh.exe', 'C:\\Users\\me\\powershell.exe']) {
    const cmds = buildLaunchCommand({ ...baseArgs, launcher: 'powershell', launcherBin: bad });
    assert.equal(cmds.powershell.unavailable, true, `untrusted ${bad} must be unavailable`);
    assert.equal(cmds.powershell.bin, null);
  }
});

test('B3: non-PowerShell launcher + launcherBin null → buildLaunchCommand does not throw, builds all entries', () => {
  assert.doesNotThrow(() => {
    const cmds = buildLaunchCommand({ ...baseArgs, launcher: 'terminal-app', launcherBin: null });
    assert.equal(typeof cmds.powershell.display, 'string');  // unavailable placeholder, not a throw
    assert.ok(cmds['terminal-app'].display);                 // the actual launcher entry is intact
  });
});

// ── desktop entry tests (Task 5: buildLaunchCommand desktop key, verified-target only) ──
const desktopArgs = (over) => ({ root: '/repo', parentRunId: 'P1', childRunId: 'C1', handoffRel: 'handoffs/x.md', ...over });

test('macOS desktop entry targets verified app, never bare/-b', () => {
  const cmds = buildLaunchCommand(desktopArgs({ platform: 'darwin', desktopTarget: { kind: 'macos-app', appPath: '/Applications/Claude.app' } }));
  // absolute path — NOT the bare, PATH-resolvable 'open' (a PATH shim ahead of /usr/bin/open would
  // otherwise intercept the launch and defeat the verified-handler trust boundary; see handoff.mjs).
  assert.equal(cmds.desktop.bin, '/usr/bin/open');
  assert.ok(cmds.desktop.bin.startsWith('/'), 'desktop bin must be an absolute path, not PATH-resolved');
  assert.equal(cmds.desktop.argv[0], '-a');
  assert.equal(cmds.desktop.argv[1], '/Applications/Claude.app');
  const url = cmds.desktop.argv[2];
  assert.match(url, /^claude:\/\/code\/new\?folder=/);
  assert.match(url, /q=Read/);
  assert.ok(!cmds.desktop.argv.includes('-b'));                 // negative: no bundle-id-only
  assert.equal(cmds.desktop.available, true);                   // machine entry available (display는 emitHandoff이 구성)
});

test('unverified desktopTarget → unavailable entry', () => {
  const cmds = buildLaunchCommand(desktopArgs({ platform: 'darwin', desktopTarget: null }));
  assert.equal(cmds.desktop.unavailable, true);
  // the unavailable entry carries no URL-bearing field at all (no `display`, no `argv`) — a
  // raw claude:// deeplink can never leak through it.
  assert.ok(!('display' in cmds.desktop) || !/claude:\/\//.test(String(cmds.desktop.display)));
  assert.ok(!('argv' in cmds.desktop));
});

// Windows desktop launch: a verified win-exe target + a trusted PowerShell bin dispatches through
// `Start-Process -FilePath <verified-exe>` — DETACHED and non-blocking, so it fixes the resident-GUI
// launch-timeout rollback the interim v1 fail-closed behavior was sidestepping. (macOS `open -a`
// already exits immediately, so darwin is unaffected — see the macOS test above.)
test('windows desktop entry: verified win-exe target + trusted PS available → non-blocking Start-Process launcher', () => {
  const trustedPs = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const exePath = 'C:\\Program Files\\Claude\\Claude.exe';
  const cmds = buildLaunchCommand(desktopArgs({
    platform: 'win32', desktopTarget: { kind: 'win-exe', exePath },
    launcherIdentity: launcherIdentity('powershell', trustedPs),
  }));
  assert.equal(cmds.desktop.available, true);
  assert.equal(cmds.desktop.bin, trustedPs);
  assert.deepEqual(cmds.desktop.argv.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  const joined = cmds.desktop.argv.join(' ');
  assert.match(joined, /Start-Process -FilePath '/);
  assert.ok(joined.includes(exePath), 'argv must target the verified exe path');
  assert.match(joined, /-ArgumentList '/);
  // the encoded resume URL is present (single-quoted) in argv...
  assert.match(joined, /claude:\/\/code\/new\?folder=/);
  // ...but never as a bare direct-exec of the exe, and never delegated to the OS default handler.
  assert.ok(!/Claude\.exe\s+claude:\/\//.test(joined), 'must not directly exec the exe with the raw url');
  assert.ok(!/Start-Process\s+'claude:\/\//.test(joined), 'must not Start-Process the url itself (default-handler form)');
  // no human-readable display carries the raw URL.
  assert.ok(!('display' in cmds.desktop) || !/claude:\/\//.test(String(cmds.desktop.display)));
});

test('windows desktop entry: no trusted PS bin found → unavailable (fail-closed)', () => {
  const exePath = 'C:\\Program Files\\Claude\\Claude.exe';
  const cmds = buildLaunchCommand(desktopArgs({
    platform: 'win32', desktopTarget: { kind: 'win-exe', exePath }, launcherIdentity: null,
  }));
  assert.equal(cmds.desktop.unavailable, true);
});

test('url folder/q are encodeURIComponent-encoded', () => {
  const cmds = buildLaunchCommand(desktopArgs({ root: '/re po/&x', platform: 'darwin', desktopTarget: { kind: 'macos-app', appPath: '/Applications/Claude.app' } }));
  assert.match(cmds.desktop.argv[2], /folder=%2Fre%20po%2F%26x/);
});

test('desktop entry: mismatched platform/kind (win-exe on darwin) → unavailable', () => {
  const cmds = buildLaunchCommand(desktopArgs({ platform: 'darwin', desktopTarget: { kind: 'win-exe', exePath: 'C:\\Program Files\\Claude\\Claude.exe' } }));
  assert.equal(cmds.desktop.unavailable, true);
});

test('desktop entry: no platform/desktopTarget passed (existing callers) defaults to unavailable, no throw', () => {
  assert.doesNotThrow(() => {
    const cmds = buildLaunchCommand({ ...baseArgs });
    assert.equal(cmds.desktop.unavailable, true);
  });
});

// ── Task 5b (review fix): emitHandoff's desktopProbe call is gated to spawn_style==='desktop' ──
// (mirrors respawn.mjs's `mode === 'desktop'` gate). Non-desktop runs (the vast majority of the
// suite) must never pay for a real osascript/reg.exe subprocess. buildLaunchCommand's `desktop` key
// is computed but NOT yet written into launch-command.txt (that's Task 6, still unimplemented) — so
// the only currently-observable wiring signal is whether the injected desktopProbe is invoked at all.
test('emitHandoff: spawn_style=desktop invokes the injected desktopProbe (probe is honored)', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'desktop';
  writeState(root, runId, data);
  const now = Date.parse('2026-06-24T01:00:00Z');
  let calls = 0;
  let seenPlatform;
  const desktopProbe = (opts) => {
    calls += 1;
    seenPlatform = opts?.platform;
    return { ok: true, argvTarget: { kind: 'macos-app', appPath: '/Applications/Claude.app' } };
  };
  const r = emitHandoff(root, runId, { trigger: 'milestone', now, expect: expect_(runId), platform: 'darwin', desktopProbe });
  assert.equal(r.ok, true);
  assert.equal(calls, 1, 'desktop spawn_style must invoke the injected desktopProbe exactly once');
  assert.equal(seenPlatform, 'darwin', 'the platform passed to emitHandoff must be forwarded to desktopProbe');
});

test('emitHandoff: non-desktop spawn_style (default visible) never invokes desktopProbe', () => {
  const { root, runId } = seed();   // seed()'s initRun leaves autonomy.spawn_style at its default ('visible')
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
  const now = Date.parse('2026-06-24T01:00:00Z');
  let called = false;
  const desktopProbe = () => { called = true; throw new Error('desktopProbe must not be called for non-desktop runs'); };
  const r = emitHandoff(root, runId, { trigger: 'milestone', now, expect: expect_(runId), platform: 'darwin', desktopProbe });
  assert.equal(r.ok, true, 'emitHandoff must succeed (probe never invoked, so its throw never surfaces)');
  assert.equal(called, false, 'non-desktop emitHandoff must never invoke desktopProbe');
});

// ── Task 6: launch-command.txt `# desktop` line — verified-target instruction or unavailable marker,
// NEVER a raw claude:// deeplink (URL lives only in machine argv, per handoff.mjs's desktopEntry). ──
test('launch-command.txt desktop line is verified-target resume instruction, never raw deeplink', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'desktop';
  writeState(root, runId, data);
  const now = Date.parse('2026-06-24T01:00:00Z');
  const desktopProbe = () => ({ ok: true, argvTarget: { kind: 'macos-app', appPath: '/Applications/Claude.app' } });
  const r = emitHandoff(root, runId, { trigger: 'milestone', now, expect: expect_(runId), platform: 'darwin', desktopProbe });
  assert.equal(r.ok, true);
  const txt = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.match(txt, /# desktop/);
  // Extract desktop line (content immediately after '# desktop' header)
  const desktopLineIndex = txt.split('\n').indexOf('# desktop');
  const desktopLine = txt.split('\n')[desktopLineIndex + 1];
  assert.match(desktopLine, /\/deep-loop-resume/);
  assert.ok(!/claude:\/\//.test(txt), 'launch-command.txt must never contain a raw claude:// deeplink');
});

test('launch-command.txt desktop line is unavailable marker for non-desktop runs; still no raw deeplink', () => {
  const { root, runId } = seed();   // default spawn_style='visible' → desktopProbe never invoked, dt stays null
  const now = Date.parse('2026-06-24T01:00:00Z');
  const r = emitHandoff(root, runId, { trigger: 'milestone', now, expect: expect_(runId), platform: 'darwin' });
  assert.equal(r.ok, true);
  const txt = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.match(txt, /# desktop/);
  // Extract desktop line (content immediately after '# desktop' header)
  const desktopLineIndex = txt.split('\n').indexOf('# desktop');
  const desktopLine = txt.split('\n')[desktopLineIndex + 1];
  assert.match(desktopLine, /unavailable/);
  assert.ok(!/\/deep-loop-resume/.test(desktopLine), 'desktop line in unavailable case must not contain /deep-loop-resume');
  assert.ok(!/claude:\/\//.test(txt), 'launch-command.txt must never contain a raw claude:// deeplink');
});

// ── WS1: model/effort threading ──────────────────────────────────────────────
function writeStateWith(root, runId, mutate) {
  const { data } = readState(root, runId);
  mutate(data);
  writeState(root, runId, data);
}

test('buildLaunchCommand threads --model/--effort into every transport', () => {
  const m = 'claude-opus-4-8[1m]';
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'cmux', launcherBin: '/a/cmux', model: m, effort: 'xhigh' });
  assert.ok(c.headless.argv.includes('--model') && c.headless.argv.includes(m));
  assert.ok(c.headless.argv.includes('--effort') && c.headless.argv.includes('xhigh'));
  assert.ok(c.wt.argv.includes('--model') && c.wt.argv.includes(m));
  assert.match(c.wt.display, /--model 'claude-opus-4-8\[1m\]' --effort 'xhigh'/);
  const cmuxCmd = c.cmux.argv[c.cmux.argv.indexOf('--command') + 1];
  assert.match(cmuxCmd, /--model 'claude-opus-4-8\[1m\]' --effort 'xhigh'/);
  assert.match(c.interactive.display, /--model 'claude-opus-4-8\[1m\]' --effort 'xhigh'/);
  assert.match(c.headless.display, /--model 'claude-opus-4-8\[1m\]' --effort 'xhigh'/);
});

test('buildLaunchCommand omits flags when model/effort absent (backward compat)', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md' });
  assert.ok(!c.headless.argv.includes('--model'));
  assert.ok(!c.headless.argv.includes('--effort'));
  assert.ok(!c.wt.argv.includes('--model'));
  assert.ok(!c.wt.display.includes('--model'));
  assert.ok(!c.interactive.display.includes('--model'));
  assert.ok(!c.interactive.display.includes('undefined'));
});

test('powershell entry threads --model/--effort with psq quoting', () => {
  const psBin = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'powershell', launcherBin: psBin, model: 'claude-sonnet-5', effort: 'high' });
  assert.ok(!c.powershell.unavailable, 'trusted PS bin → runnable entry');
  const psCmd = c.powershell.argv[c.powershell.argv.indexOf('-Command') + 1];
  const enc = psCmd.match(/EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  const innerPS = Buffer.from(enc, 'base64').toString('utf16le');
  assert.match(innerPS, /--model 'claude-sonnet-5' --effort 'high'/);
});

test('emitHandoff threads state model/effort into launch-command.txt + continuity note', () => {
  const { root, runId } = seed();
  writeStateWith(root, runId, (d) => { d.autonomy.session_model = 'claude-opus-4-8[1m]'; d.autonomy.session_effort = 'xhigh'; });
  const r = emitHandoff(root, runId, { now: 1, expect: expect_(runId) });
  assert.equal(r.ok, true);
  const lc = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.match(lc, /--model 'claude-opus-4-8\[1m\]' --effort 'xhigh'/);
  const desktopLine = lc.split('\n').find((ln) => ln.startsWith('# desktop:'));
  assert.match(desktopLine, /model=claude-opus-4-8\[1m\]/);
  assert.match(desktopLine, /effort=xhigh/);
  const md = readFileSync(r.handoffPath, 'utf8');
  assert.match(md, /## Session continuity/);
  assert.match(md, /claude-opus-4-8\[1m\]/);
  assert.match(md, /xhigh/);
});

test('emitHandoff does NOT modify autonomy.session_* (refresh is the setter, not emit)', () => {
  const { root, runId } = seed();
  writeStateWith(root, runId, (d) => { d.autonomy.session_model = 'opus'; d.autonomy.session_effort = 'high'; });
  emitHandoff(root, runId, { now: 1, expect: expect_(runId) });
  const { data } = readState(root, runId);
  assert.equal(data.autonomy.session_model, 'opus');
  assert.equal(data.autonomy.session_effort, 'high');
});

// ── v1.6 terminal race + compensating rollback (spec §2.3-2 / §4-4·5e) ──────
import { rollbackHandoff } from '../scripts/lib/lease.mjs';

const T_NOW = Date.parse('2026-07-09T03:00:00Z');
function makeTerminal(root, runId, status = 'completed') {
  const { data } = readState(root, runId);
  data.status = status;
  writeState(root, runId, data);
}

test('emitHandoff: reserve-succeeds-then-finish race → final-append rejected + compensating rollback (spec §4-5e)', () => {
  const { root, runId } = seed();
  const expect = expect_(runId);
  // seam (plan r3): desktopProbe는 reserve 성공 후·최종 appendAnchored 전에 호출된다(spawn_style='desktop').
  // 여기서 terminal 전이를 심어 "reserve는 running에서 성공 → 파일 write 중 finish → 최종 append 거부 → 보상" race를 재현.
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'desktop';
  writeState(root, runId, data);
  const em = emitHandoff(root, runId, {
    reason: 'milestone', trigger: 'milestone', now: T_NOW, expect,
    desktopProbe: () => { makeTerminal(root, runId, 'completed'); return null; },
  });
  assert.equal(em.ok, false); assert.equal(em.reason, 'RUN_TERMINAL');
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'released');            // terminal-aware rollback 안착 (3차 r1)
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_child_run_id, null);
  assert.equal(lease.handoff_idempotency_key, null);
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';   // 로그 부재 = 이벤트 0 (fresh run)
  assert.ok(!log.includes('handoff-emitted'));      // 이벤트 미등록 — 파일 잔여는 불활성(감사 흔적 보존)
});

test('emitHandoff: pre-reserved terminal re-entry → early-return compensation cleans reserved residue (plan r1 P2-a)', () => {
  const { root, runId } = seed();
  const expect = expect_(runId);
  const res = reserveHandoff(root, runId, { trigger: 'milestone', now: T_NOW, expect });
  assert.equal(res.reserved, true);
  makeTerminal(root, runId, 'stopped');
  const em = emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', now: T_NOW + 1000, expect });
  assert.equal(em.ok, false); assert.equal(em.reason, 'RUN_TERMINAL');
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'released');
  assert.equal(lease.handoff_phase, 'idle');
});

test('rollbackHandoff: terminal-aware — reserved settles to released; idle terminal is a no-op write (plan r2 P1)', () => {
  const { root, runId } = seed();
  const expect = expect_(runId);
  // 비terminal: 기존 계약 — active/idle 복원
  reserveHandoff(root, runId, { trigger: 't', now: T_NOW, expect });
  assert.equal(rollbackHandoff(root, runId, expect).ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'active');
  // terminal + reserved 잔여: released 안착
  reserveHandoff(root, runId, { trigger: 't2', now: T_NOW + 1, expect });
  makeTerminal(root, runId, 'stopped');
  assert.equal(rollbackHandoff(root, runId, expect).ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'released');
  // terminal + idle(잔여 없음): write 없는 no-op — lease.state를 임의 값으로 관측
  const { data: d2 } = readState(root, runId);
  d2.session_chain.lease.state = 'active';   // 정상-finish 직후 모양 재현
  writeState(root, runId, d2);
  const r = rollbackHandoff(root, runId, expect);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'noop-idle-terminal');
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'active');   // write 안 함
});
