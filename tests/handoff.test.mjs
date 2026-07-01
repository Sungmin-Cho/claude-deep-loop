import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { reserveHandoff, releaseLease, acquireLease } from '../scripts/lib/lease.mjs';
import { emitHandoff, buildLaunchCommand } from '../scripts/lib/handoff.mjs';
import { newEpisode, abandonEpisode } from '../scripts/lib/episode.mjs';

// Inject deterministic env so detectTerminal never probes real cmux/osascript.
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }) });
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
  assert.equal(c.powershell.argv[0], '-Command');
  const cmdStr = c.powershell.argv[1];
  const b64 = cmdStr.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  const decoded = Buffer.from(b64, 'base64').toString('utf16le');
  assert.match(decoded, /Set-Location -LiteralPath '\/p'/);
});

test('powershell: root with single-quote is doubled (psq escaping)', () => {
  const c = buildLaunchCommand({ root: "/p'q", parentRunId: 'P', childRunId: 'C', handoffRel: 'handoffs/x.md', launcher: 'powershell', launcherBin: TRUSTED_PS_BIN });
  const cmdStr = c.powershell.argv[1];
  const b64 = cmdStr.match(/-EncodedCommand','([A-Za-z0-9+/=]+)'/)[1];
  const decoded = Buffer.from(b64, 'base64').toString('utf16le');
  // psq("/p'q") = "/p''q" — single-quote doubled
  assert.match(decoded, /Set-Location -LiteralPath '\/p''q'/);
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
  acquireLease(root, runId, { owner: CHILD2, expectGeneration: 1, now });
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
  assert.match(cmds.powershell.display, /pwsh\.exe' -Command /);
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
  assert.equal(cmds.desktop.bin, 'open');
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
  assert.ok(!/claude:\/\//.test(cmds.desktop.display));          // negative: no raw deeplink in display
});

test('windows desktop entry targets verified exe', () => {
  const cmds = buildLaunchCommand(desktopArgs({ platform: 'win32', desktopTarget: { kind: 'win-exe', exePath: 'C:\\Program Files\\Claude\\Claude.exe' } }));
  assert.equal(cmds.desktop.bin, 'C:\\Program Files\\Claude\\Claude.exe');
  assert.match(cmds.desktop.argv[0], /^claude:\/\/code\/new/);
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
