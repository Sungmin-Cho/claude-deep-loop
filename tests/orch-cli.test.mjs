import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { canonicalProjectRoot, projectRootDigest } from '../scripts/lib/project-root.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const FORCE_WIN32 = join(process.cwd(), 'tests', 'helpers', 'force-win32.mjs');
function run(root, args) {
  return execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
}
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

const CODEX_TARGET_LAYOUT = Object.freeze({
  'darwin:arm64': { alias: '@openai/codex-darwin-arm64', suffix: 'darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex' },
  'darwin:x64': { alias: '@openai/codex-darwin-x64', suffix: 'darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex' },
  'linux:arm64': { alias: '@openai/codex-linux-arm64', suffix: 'linux-arm64', triple: 'aarch64-unknown-linux-musl', executable: 'codex' },
  'linux:x64': { alias: '@openai/codex-linux-x64', suffix: 'linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex' },
  'win32:arm64': { alias: '@openai/codex-win32-arm64', suffix: 'win32-arm64', triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe' },
  'win32:x64': { alias: '@openai/codex-win32-x64', suffix: 'win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe' },
});

const RUNTIME_EXECUTABLE_CLI_FIXTURE_UNAVAILABLE =
  'runtime executable CLI integration fixture requires a real native Windows executable; '
  + 'a generated or checked-in fake PE is intentionally not fabricated';
const LAUNCHER_EXECUTABLE_CLI_FIXTURE_UNAVAILABLE =
  'launcher executable CLI integration fixture requires real native Windows PE executables; '
  + 'POSIX shebang fixtures are never executed on native win32';

function canMaterializeRuntimeExecutableCliFixture(platform = process.platform) {
  return platform !== 'win32';
}

function runtimeExecutableCliTest(name, fn) {
  return test(name, {
    skip: canMaterializeRuntimeExecutableCliFixture() ? false : RUNTIME_EXECUTABLE_CLI_FIXTURE_UNAVAILABLE,
  }, fn);
}

function launcherExecutableCliTest(name, fn) {
  return test(name, {
    skip: process.platform === 'win32' ? LAUNCHER_EXECUTABLE_CLI_FIXTURE_UNAVAILABLE : false,
  }, fn);
}

function runtimeExecutableCliFixture({
  runRuntime = 'codex', platform = process.platform, arch = process.arch,
} = {}) {
  if (!canMaterializeRuntimeExecutableCliFixture(platform)) {
    throw new Error(RUNTIME_EXECUTABLE_CLI_FIXTURE_UNAVAILABLE);
  }
  const target = CODEX_TARGET_LAYOUT[`${platform}:${arch}`];
  if (!target) throw new Error(`unsupported runtime executable CLI fixture target: ${platform}:${arch}`);
  const { alias, suffix, triple, executable } = target;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-runtime-cli-')));
  const { runId } = initRun(root, { runtime: runRuntime, goal: 'g', now: new Date('2026-07-11T00:00:00Z') });
  const version = '0.144.1';
  const wrapperRoot = join(root, 'tool', 'node_modules', '@openai', 'codex');
  const wrapper = join(wrapperRoot, 'bin', 'codex.js');
  const optionalRoot = join(wrapperRoot, 'node_modules', ...alias.split('/'));
  const native = join(optionalRoot, 'vendor', triple, 'bin', executable);
  mkdirSync(join(wrapperRoot, 'bin'), { recursive: true });
  writeFileSync(wrapper, '#!/usr/bin/env node\n');
  writeFileSync(join(wrapperRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex', version, bin: { codex: 'bin/codex.js' },
    optionalDependencies: { [alias]: `npm:@openai/codex@${version}-${suffix}` },
  }));
  mkdirSync(join(optionalRoot, 'vendor', triple, 'bin'), { recursive: true });
  writeFileSync(join(optionalRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex', version: `${version}-${suffix}`, os: [platform], cpu: [arch],
  }));
  writeFileSync(native, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`);
  chmodSync(native, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(native)).digest('hex');
  return { root, runId, wrapper, native, sha256, version };
}

test('runtime executable CLI fixture contract: declares native Windows target layouts', () => {
  assert.deepEqual(CODEX_TARGET_LAYOUT['win32:x64'], {
    alias: '@openai/codex-win32-x64', suffix: 'win32-x64',
    triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe',
  });
  assert.deepEqual(CODEX_TARGET_LAYOUT['win32:arm64'], {
    alias: '@openai/codex-win32-arm64', suffix: 'win32-arm64',
    triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe',
  });
});

test('runtime executable CLI fixture contract: refuses to fabricate a native Windows executable', () => {
  assert.equal(canMaterializeRuntimeExecutableCliFixture('win32'), false);
  assert.equal(canMaterializeRuntimeExecutableCliFixture('darwin'), true);
  assert.equal(canMaterializeRuntimeExecutableCliFixture('linux'), true);
  assert.throws(
    () => runtimeExecutableCliFixture({ platform: 'win32', arch: 'x64' }),
    /runtime executable CLI integration fixture requires a real native Windows executable/,
  );
});

function validRuntimeApprovalArgs(fixture) {
  return [
    'runtime-executable', 'approve',
    '--runtime', 'codex',
    '--path', fixture.wrapper,
    '--canonical-path', fixture.native,
    '--sha256', fixture.sha256,
    '--actor', 'human',
    '--confirm',
    '--owner', fixture.runId,
    '--generation', '1',
    '--now', '2026-07-11T08:00:00Z',
  ];
}

function movedCliRun() {
  const { root: originalRoot, runId } = seed();
  const storedRoot = readState(originalRoot, runId).data.project.root;
  const candidateRoot = `${originalRoot}-moved`;
  renameSync(originalRoot, candidateRoot);
  return { originalRoot, candidateRoot, runId, storedRoot };
}

function cliSnapshot(root, runId) {
  const dir = runDir(root, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json'), 'utf8'),
    hash: readFileSync(join(dir, '.loop.hash'), 'utf8'),
    event: existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null,
  };
}

function runResult(root, args) {
  try { return { code: 0, stdout: run(root, args), stderr: '' }; }
  catch (e) { return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
}

// detect-terminal이 소비하는 host 터미널 신호는 forced-win32 fixture로 새면 안 된다 —
// cmux 분기가 fixture의 WT_SESSION 기대를 선점한다(실 cmux host에서 재현). fixture 의도 값은
// extraEnv로만 주입한다.
function hermeticTerminalEnv(extraEnv) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CMUX_')) delete env[key];
  for (const key of ['TERM_PROGRAM', 'TMUX', 'STY', 'WT_SESSION']) delete env[key];
  return { ...env, ...extraEnv };
}

function win32RunResult(root, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    encoding: 'utf8',
    shell: false,
    env: {
      ...hermeticTerminalEnv(extraEnv),
      NODE_OPTIONS: `--import=${FORCE_WIN32}`,
    },
  });
  return {
    code: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : String(result.error?.message || ''),
  };
}

function nativeWin32LauncherCliFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-win32-launcher-cli-')));
  const binDir = join(root, 'native fixtures');
  mkdirSync(binDir);
  const launcher = join(binDir, 'wt.exe');
  const runtime = join(binDir, 'claude.exe');
  const launches = join(root, 'launcher-invocations.log');
  writeFileSync(launcher, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    "  printf 'Windows Terminal 1.22.10352.0\\n'",
    '  exit 0',
    'fi',
    `printf '%s\\n' "$*" >> '${launches}'`,
    'exit 0',
    '',
  ].join('\n'));
  writeFileSync(runtime, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    "  printf '2.1.0 (Claude Code)\\n'",
    '  exit 0',
    'fi',
    'exit 9',
    '',
  ].join('\n'));
  chmodSync(launcher, 0o755);
  chmodSync(runtime, 0o755);
  return {
    root, launcher, runtime, launches,
    launcherSha256: createHash('sha256').update(readFileSync(launcher)).digest('hex'),
    runtimeSha256: createHash('sha256').update(readFileSync(runtime)).digest('hex'),
    env: { WT_SESSION: 'deterministic-test-session' },
  };
}

function validLauncherApprovalArgs(fixture, runId) {
  return [
    'launcher-executable', 'approve',
    '--kind', 'wt',
    '--path', fixture.launcher,
    '--canonical-path', fixture.launcher,
    '--sha256', fixture.launcherSha256,
    '--actor', 'human',
    '--confirm',
    '--owner', runId,
    '--generation', '1',
    '--now', '2026-07-12T01:00:00Z',
  ];
}

function initWin32LauncherRun(fixture) {
  const result = win32RunResult(fixture.root, [
    'init-run', '--runtime', 'claude', '--goal', 'native launcher CLI integration',
  ], fixture.env);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).run_id;
}

function validRebindArgs({ candidateRoot, runId, storedRoot }) {
  return [
    'root', 'rebind',
    '--candidate-project-root', candidateRoot,
    '--run-id', runId,
    '--owner', runId,
    '--generation', '1',
    '--actor', 'human',
    '--confirm',
    '--expected-stored-root-digest', projectRootDigest(storedRoot),
    '--now', '2026-07-11T00:00:00Z',
  ];
}

test('next-action prints descriptor JSON (deterministic now)', () => {
  const { root } = seed();   // run created_at = 2026-06-24T00:00:00Z
  const out = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z']));
  assert.ok(out.action && out.gate);
  assert.equal(out.action.type, 'discover');   // wallclock 창 안 → handoff 아님
});

test('next-action honors --now for wallclock hard-stop', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-30T00:00:00Z'])); // > 24h
  assert.equal(out.action.type, 'handoff');
  assert.equal(out.gate.blocked_by[0], 'budget');
});

test('init-run rejects the legacy standalone reviewer with invalid-value exit semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-cli-legacy-reviewer-'));
  const result = runResult(root, ['init-run', '--runtime', 'claude', '--goal', 'g', '--review', JSON.stringify({ reviewer: 'standalone' })]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /REVIEWER_STANDALONE_INVALID/);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('review dispatch accepts --independent-subagent and records a neutral legacy upgrade', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.review.reviewer = 'standalone';
  writeState(root, runId, data);
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'A', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '1']));
  writeFileSync(join(root, 'plan.txt'), 'artifact');
  const maker = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'plan', '--point', 'plan', '--workstream', ws.id, '--artifacts', '["plan.txt"]', '--owner', runId, '--generation', '1']));
  run(root, ['episode', 'record', '--id', maker.id, '--status', 'done', '--artifacts', '["plan.txt"]', '--owner', runId, '--generation', '1']);

  const dispatched = JSON.parse(run(root, ['review', 'dispatch', '--point', 'plan', '--workstream', ws.id, '--independent-subagent', '--owner', runId, '--generation', '1']));
  assert.equal(dispatched.reviewer, 'subagent-checker');
  assert.equal(dispatched.descriptor.kind, 'agent');
  assert.equal(dispatched.descriptor.agent_role, 'code-reviewer');
  assert.equal(dispatched.descriptor.requires_independent_session, true);
  const checker = readState(root, runId).data.episodes.find(e => e.id === dispatched.checkerEpisodeId);
  assert.equal(checker.reviewer_resolution.asserted_capability, 'independent-subagent');
});

test('root diagnose exits 0 with redacted eligibility for resolvable copies and moved roots', () => {
  const original = seed();
  const copyRoot = mkdtempSync(join(tmpdir(), 'dl-root-cli-copy-'));
  const storedRoot = readState(original.root, original.runId).data.project.root;
  cpSync(join(original.root, '.deep-loop'), join(copyRoot, '.deep-loop'), { recursive: true });

  const copied = runResult(copyRoot, [
    'root', 'diagnose', '--candidate-project-root', copyRoot, '--run-id', original.runId,
  ]);
  assert.equal(copied.code, 0);
  assert.deepEqual(JSON.parse(copied.stdout), {
    mismatch_class: 'fenced', rebind_allowed: false,
    stored_root_digest: projectRootDigest(storedRoot), owner: original.runId, generation: 1,
  });

  const moved = movedCliRun();
  const relocated = runResult(moved.candidateRoot, [
    'root', 'diagnose', '--candidate-project-root', moved.candidateRoot, '--run-id', moved.runId,
  ]);
  assert.equal(relocated.code, 0);
  assert.deepEqual(JSON.parse(relocated.stdout), {
    mismatch_class: 'unresolvable', rebind_allowed: true,
    stored_root_digest: projectRootDigest(moved.storedRoot), owner: moved.runId, generation: 1,
  });
});

test('root diagnose rejects a hash mismatch with exit 1 and no mutation', () => {
  const moved = movedCliRun();
  const loopPath = join(runDir(moved.candidateRoot, moved.runId), 'loop.json');
  const loop = JSON.parse(readFileSync(loopPath, 'utf8'));
  loop.goal = 'tampered';
  writeFileSync(loopPath, JSON.stringify(loop, null, 2));
  const before = cliSnapshot(moved.candidateRoot, moved.runId);

  const result = runResult(moved.candidateRoot, [
    'root', 'diagnose', '--candidate-project-root', moved.candidateRoot, '--run-id', moved.runId,
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /STATE_TAMPERED/);
  assert.deepEqual(cliSnapshot(moved.candidateRoot, moved.runId), before);
});

test('root rebind missing required flags or confirm exits 2 with usage errors', () => {
  const moved = movedCliRun();
  const base = validRebindArgs(moved);
  const omitFlag = (name) => {
    const index = base.indexOf(`--${name}`);
    const count = name === 'confirm' ? 1 : 2;
    return [...base.slice(0, index), ...base.slice(index + count)];
  };

  for (const name of ['candidate-project-root', 'run-id', 'owner', 'generation', 'actor', 'confirm', 'expected-stored-root-digest']) {
    const result = runResult(moved.candidateRoot, omitFlag(name));
    assert.equal(result.code, 2, name);
    assert.match(result.stderr, /(?:USAGE|REQUIRED|CONFIRM_REQUIRED)/, name);
  }
});

test('root rebind invalid actor, digest, candidate root, or state exits 1', () => {
  const moved = movedCliRun();
  const cases = [
    ['actor', validRebindArgs(moved).map(value => value === 'human' ? 'agent' : value), /INVALID_ACTOR/],
    ['digest', validRebindArgs(moved).map(value => value === projectRootDigest(moved.storedRoot) ? 'not-a-digest' : value), /INVALID_STORED_ROOT_DIGEST/],
    ['root', validRebindArgs({ ...moved, candidateRoot: join(moved.candidateRoot, 'missing') }), /PROJECT_ROOT_UNRESOLVABLE/],
  ];
  for (const [label, args, message] of cases) {
    const result = runResult(moved.candidateRoot, args);
    assert.equal(result.code, 1, label);
    assert.match(result.stderr, message, label);
  }

  const invalidOriginal = seed();
  const { data } = readState(invalidOriginal.root, invalidOriginal.runId);
  data.run_id = 'DIFFERENT-RUN-ID';
  writeState(invalidOriginal.root, invalidOriginal.runId, data);
  const invalidState = {
    candidateRoot: `${invalidOriginal.root}-moved`,
    runId: invalidOriginal.runId,
    storedRoot: data.project.root,
  };
  renameSync(invalidOriginal.root, invalidState.candidateRoot);
  const stateResult = runResult(invalidState.candidateRoot, validRebindArgs(invalidState));
  assert.equal(stateResult.code, 1);
  assert.match(stateResult.stderr, /STATE_INVALID/);
});

test('root rebind keeps a resolvable stopped copy fenced at exit 3', () => {
  const original = seed();
  const { data } = readState(original.root, original.runId);
  data.status = 'stopped';
  writeState(original.root, original.runId, data);
  const candidateRoot = mkdtempSync(join(tmpdir(), 'dl-root-cli-stopped-copy-'));
  cpSync(join(original.root, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });
  const fixture = { candidateRoot, runId: original.runId, storedRoot: data.project.root };
  const before = cliSnapshot(candidateRoot, original.runId);

  const result = runResult(candidateRoot, validRebindArgs(fixture));
  assert.equal(result.code, 3);
  assert.match(result.stderr, /PROJECT_ROOT_FENCED/);
  assert.deepEqual(cliSnapshot(candidateRoot, original.runId), before);
});

test('root rebind stale owner or generation exits 3 and changes no durable file', () => {
  for (const [flag, value] of [['--owner', 'stale-owner'], ['--generation', '9']]) {
    const moved = movedCliRun();
    const args = validRebindArgs(moved);
    args[args.indexOf(flag) + 1] = value;
    const before = cliSnapshot(moved.candidateRoot, moved.runId);
    const result = runResult(moved.candidateRoot, args);
    assert.equal(result.code, 3, flag);
    assert.match(result.stderr, /LEASE_FENCED/, flag);
    assert.deepEqual(cliSnapshot(moved.candidateRoot, moved.runId), before, flag);
  }
});

test('root rebind CLI relocates once and restores ordinary strict state access', () => {
  const moved = movedCliRun();
  const result = runResult(moved.candidateRoot, validRebindArgs(moved));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  const { data } = readState(moved.candidateRoot, moved.runId);
  assert.equal(data.project.root, canonicalProjectRoot(moved.candidateRoot));
});

runtimeExecutableCliTest('runtime-executable diagnose is read-only and reports the canonical native identity, never the wrapper', () => {
  const fixture = runtimeExecutableCliFixture();
  const before = cliSnapshot(fixture.root, fixture.runId);
  const result = runResult(fixture.root, [
    'runtime-executable', 'diagnose', '--runtime', 'codex', '--path', fixture.wrapper,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const diagnosed = JSON.parse(result.stdout);
  assert.equal(diagnosed.approval_required, true);
  assert.equal(diagnosed.identity.runtime, 'codex');
  assert.equal(diagnosed.identity.canonical_path, fixture.native);
  assert.equal(diagnosed.identity.sha256, fixture.sha256);
  assert.equal(diagnosed.identity.source, 'official-npm-native');
  assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), before);
});

runtimeExecutableCliTest('runtime-executable approve missing required flags or confirmation exits 2 without mutation', () => {
  for (const name of ['runtime', 'path', 'canonical-path', 'sha256', 'actor', 'confirm', 'owner', 'generation']) {
    const fixture = runtimeExecutableCliFixture();
    const args = validRuntimeApprovalArgs(fixture);
    const index = args.indexOf(`--${name}`);
    const count = name === 'confirm' ? 1 : 2;
    args.splice(index, count);
    const before = cliSnapshot(fixture.root, fixture.runId);
    const result = runResult(fixture.root, args);
    assert.equal(result.code, 2, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /(?:USAGE|CONFIRM_REQUIRED)/, name);
    assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), before, name);
  }
});

runtimeExecutableCliTest('runtime-executable approve invalid actor, hash, path, or runtime exits 1 without mutation', () => {
  for (const [label, flag, value, message] of [
    ['actor', '--actor', 'agent', /INVALID_ACTOR/],
    ['hash', '--sha256', 'A'.repeat(64), /RUNTIME_EXECUTABLE_HASH_INVALID/],
    ['path', '--canonical-path', '/not/the/diagnosed/native', /RUNTIME_EXECUTABLE_PATH_MISMATCH/],
    ['runtime', '--runtime', 'other', /INVALID_RUNTIME/],
  ]) {
    const fixture = runtimeExecutableCliFixture();
    const args = validRuntimeApprovalArgs(fixture);
    args[args.indexOf(flag) + 1] = value;
    const before = cliSnapshot(fixture.root, fixture.runId);
    const result = runResult(fixture.root, args);
    assert.equal(result.code, 1, `${label}: ${result.stderr}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), before, label);
  }
});

runtimeExecutableCliTest('runtime-executable approve freshly fences stored runtime, owner, and generation at exit 3', () => {
  for (const [label, fixtureOptions, flag, value, message] of [
    ['runtime', { runRuntime: 'claude' }, null, null, /RUNTIME_FENCED/],
    ['owner', {}, '--owner', 'stale-owner', /LEASE_FENCED/],
    ['generation', {}, '--generation', '9', /LEASE_FENCED/],
  ]) {
    const fixture = runtimeExecutableCliFixture(fixtureOptions);
    const args = validRuntimeApprovalArgs(fixture);
    if (flag) args[args.indexOf(flag) + 1] = value;
    const before = cliSnapshot(fixture.root, fixture.runId);
    const result = runResult(fixture.root, args);
    assert.equal(result.code, 3, `${label}: ${result.stderr}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), before, label);
  }
});

runtimeExecutableCliTest('runtime-executable approve writes one fenced anchored approval with exact human path and hash', () => {
  const fixture = runtimeExecutableCliFixture();
  const result = runResult(fixture.root, validRuntimeApprovalArgs(fixture));
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.approval.canonical_path, fixture.native);
  assert.equal(output.approval.sha256, fixture.sha256);
  assert.equal(output.approval.approved_by, 'human');
  assert.equal(output.approval.approved_at, '2026-07-11T08:00:00.000Z');

  const { data } = readState(fixture.root, fixture.runId);
  assert.deepEqual(data.autonomy.runtime_executable_approval, output.approval);
  const events = readFileSync(join(runDir(fixture.root, fixture.runId), 'event-log.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  const approvals = events.filter(event => event.type === 'runtime-executable-approved');
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].data, {
    runtime: 'codex', canonical_path: fixture.native, sha256: fixture.sha256,
    version: fixture.version, source: 'official-npm-native', actor: 'human',
  });
});

runtimeExecutableCliTest('POSIX Codex CLI visible respawn consumes durable approval and exact cmux authority', () => {
  const fixture = runtimeExecutableCliFixture();
  JSON.parse(run(fixture.root, validRuntimeApprovalArgs(fixture)));

  const cmux = join(fixture.root, 'tool', 'cmux-test');
  const launchLog = join(fixture.root, '.deep-loop', 'cmux-launch-argv.txt');
  writeFileSync(cmux, [
    '#!/bin/sh',
    ': "${DEEP_LOOP_TEST_LAUNCH_LOG:?}"',
    'printf \'%s\\n\' "$@" > "$DEEP_LOOP_TEST_LAUNCH_LOG"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(cmux, 0o755);

  const { data } = readState(fixture.root, fixture.runId);
  data.autonomy.spawn_style = 'visible';
  data.autonomy.child_ready_timeout_sec = 0;
  data.session_spawn = {
    platform: process.platform,
    launcher: 'cmux',
    launcher_bin: cmux,
    launcher_socket: '/tmp/deep-loop-cmux-test.sock',
    surface: 'workspace',
    reachable: true,
    visible: true,
    signals: {},
    probe: { cmd: [cmux, '--socket', '/tmp/deep-loop-cmux-test.sock', 'ping'], code: 0 },
    reason: null,
    fallback: 'launch-command-file',
    detected_at: '2026-07-11T08:01:00.000Z',
  };
  writeState(fixture.root, fixture.runId, data);

  const emitted = JSON.parse(run(fixture.root, [
    'handoff', 'emit', '--owner', fixture.runId, '--generation', '1', '--run-id', fixture.runId,
    '--now', '2026-07-11T08:02:00Z',
  ]));
  assert.equal(emitted.ok, true);

  const launched = spawnSync(process.execPath, [
    CLI, 'respawn', '--owner', fixture.runId, '--generation', '1', '--attended',
    '--project-root', fixture.root, '--run-id', fixture.runId, '--now', '2026-07-11T08:03:00Z',
  ], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, DEEP_LOOP_TEST_LAUNCH_LOG: launchLog },
  });
  assert.equal(launched.status, 0, launched.stderr);
  const result = JSON.parse(launched.stdout);
  assert.equal(result.mode, 'cmux');
  assert.equal(result.outcome, 'child-timeout-awaiting');

  const argv = readFileSync(launchLog, 'utf8').trimEnd().split('\n');
  assert.deepEqual(argv.slice(0, 4), [
    '--socket', '/tmp/deep-loop-cmux-test.sock', 'new-workspace', '--cwd',
  ]);
  const command = argv[argv.indexOf('--command') + 1];
  assert.ok(command.includes(`'${fixture.native}'`));
  assert.equal(/(^|[;&]\s*)codex(?:\s|$)/.test(command), false);
  assert.equal(command.includes('claude'), false);

  const launchArtifact = readFileSync(join(runDir(fixture.root, fixture.runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.ok(launchArtifact.includes(fixture.native));
  assert.ok(launchArtifact.includes(cmux));
  const after = readState(fixture.root, fixture.runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
});

runtimeExecutableCliTest('runtime-executable approval can repair a paused run without unpausing or changing its lease', () => {
  const fixture = runtimeExecutableCliFixture();
  const { data } = readState(fixture.root, fixture.runId);
  data.status = 'paused';
  data.pause_reason = 'runtime-executable-approval-required';
  const leaseBefore = structuredClone(data.session_chain.lease);
  writeState(fixture.root, fixture.runId, data);

  const result = runResult(fixture.root, validRuntimeApprovalArgs(fixture));
  assert.equal(result.code, 0, result.stderr);
  const after = readState(fixture.root, fixture.runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'runtime-executable-approval-required');
  assert.deepEqual(after.session_chain.lease, leaseBefore);
  assert.equal(after.autonomy.runtime_executable_approval.sha256, fixture.sha256);
});

runtimeExecutableCliTest('runtime-executable approval rejects a terminal run as invalid state, not as a fence', () => {
  const fixture = runtimeExecutableCliFixture();
  const { data } = readState(fixture.root, fixture.runId);
  data.status = 'completed';
  writeState(fixture.root, fixture.runId, data);
  const before = cliSnapshot(fixture.root, fixture.runId);

  const result = runResult(fixture.root, validRuntimeApprovalArgs(fixture));
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /RUNTIME_EXECUTABLE_STATE_INVALID.*RUN_TERMINAL/);
  assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), before);
});

runtimeExecutableCliTest('runtime-executable approval rejects replacement after diagnosis without appending an event', () => {
  const fixture = runtimeExecutableCliFixture();
  const before = cliSnapshot(fixture.root, fixture.runId);
  writeFileSync(fixture.native, `#!/bin/sh\nprintf 'codex-cli ${fixture.version}\\n'\n# replacement\n`);
  chmodSync(fixture.native, 0o755);
  const result = runResult(fixture.root, validRuntimeApprovalArgs(fixture));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_EXECUTABLE_HASH_MISMATCH/);
  assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), before);
});

runtimeExecutableCliTest('explicit native executable is hashed without execution during diagnose and runs only after exact human approval', () => {
  const fixture = runtimeExecutableCliFixture();
  const custom = join(fixture.root, 'custom-codex');
  const marker = join(fixture.root, 'custom-executed');
  writeFileSync(custom, `#!/bin/sh\nprintf 'x' >> '${marker}'\nprintf 'codex-cli 7.8.9\\n'\n`);
  chmodSync(custom, 0o755);
  const customFixture = {
    ...fixture,
    wrapper: custom,
    native: custom,
    sha256: createHash('sha256').update(readFileSync(custom)).digest('hex'),
    version: '7.8.9',
  };

  const diagnosed = runResult(fixture.root, [
    'runtime-executable', 'diagnose', '--runtime', 'codex', '--path', custom,
  ]);
  assert.equal(diagnosed.code, 0, diagnosed.stderr);
  const diagnosis = JSON.parse(diagnosed.stdout);
  assert.equal(diagnosis.identity.source, 'human-explicit');
  assert.equal(diagnosis.identity.version, null);
  assert.equal(diagnosis.identity.sha256, customFixture.sha256);
  assert.equal(existsSync(marker), false, 'unapproved custom code must not run during diagnosis');

  const approved = runResult(fixture.root, validRuntimeApprovalArgs(customFixture));
  assert.equal(approved.code, 0, approved.stderr);
  const approval = JSON.parse(approved.stdout).approval;
  assert.equal(approval.source, 'human-explicit');
  assert.equal(approval.version, '7.8.9');
  assert.equal(approval.package, null);
  assert.equal(readFileSync(marker, 'utf8'), 'xx', 'approval revalidates once inside the locked transaction');
});

launcherExecutableCliTest('forced-win32 fixture is hermetic to host terminal signals (cmux/tmux leak)', () => {
  // detect-terminal은 cmux 신호를 wt보다 먼저 소비하므로, host 터미널 identity가 fixture
  // subprocess로 새면 forced-win32 기대(windows-terminal-unverified)가 host 값으로 대체된다.
  const fakes = {
    CMUX_BUNDLED_CLI_PATH: join(tmpdir(), 'dl-nonexistent-cmux-leak'),
    CMUX_SOCKET_PATH: join(tmpdir(), 'dl-nonexistent-cmux-leak.sock'),
    CMUX_WORKSPACE_ID: 'host-leak-workspace',
    CMUX_SURFACE_ID: 'host-leak-surface',
    TERM_PROGRAM: 'host-leak-terminal',
    TMUX: '/nonexistent/tmux-leak,1,0',
    STY: 'host-leak-screen',
  };
  const saved = Object.fromEntries(Object.keys(fakes).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(fakes)) process.env[k] = v;
  try {
    const fixture = nativeWin32LauncherCliFixture();
    const runId = initWin32LauncherRun(fixture);
    const initial = readState(fixture.root, runId).data;
    assert.equal(initial.session_spawn.launcher, 'none');
    assert.equal(initial.session_spawn.reason, 'windows-terminal-unverified');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
});

launcherExecutableCliTest('launcher-executable diagnose is read-only and approve requires every human/fence field', () => {
  const fixture = nativeWin32LauncherCliFixture();
  const runId = initWin32LauncherRun(fixture);
  const initial = readState(fixture.root, runId).data;
  assert.equal(initial.session_spawn.launcher, 'none');
  assert.equal(initial.session_spawn.reason, 'windows-terminal-unverified');
  assert.deepEqual(initial.autonomy.launcher_executable_approvals, { wt: null, powershell: null, tmux: null });

  const before = cliSnapshot(fixture.root, runId);
  const diagnosed = win32RunResult(fixture.root, [
    'launcher-executable', 'diagnose', '--kind', 'wt', '--path', fixture.launcher,
  ], fixture.env);
  assert.equal(diagnosed.code, 0, diagnosed.stderr);
  const diagnosis = JSON.parse(diagnosed.stdout);
  assert.equal(diagnosis.identity.canonical_path, fixture.launcher);
  assert.equal(diagnosis.identity.sha256, fixture.launcherSha256);
  assert.equal(diagnosis.identity.version, null);
  assert.equal(existsSync(fixture.launches), false, 'diagnosis must not launch the candidate');
  assert.deepEqual(cliSnapshot(fixture.root, runId), before);

  for (const name of ['kind', 'path', 'canonical-path', 'sha256', 'actor', 'confirm', 'owner', 'generation']) {
    const args = validLauncherApprovalArgs(fixture, runId);
    const index = args.indexOf(`--${name}`);
    args.splice(index, name === 'confirm' ? 1 : 2);
    const snapshot = cliSnapshot(fixture.root, runId);
    const result = win32RunResult(fixture.root, args, fixture.env);
    assert.equal(result.code, 2, `${name}: ${result.stderr}`);
    assert.match(result.stderr, /(?:USAGE|CONFIRM_REQUIRED)/, name);
    assert.deepEqual(cliSnapshot(fixture.root, runId), snapshot, name);
  }
});

launcherExecutableCliTest('launcher-executable approve maps invalid values to exit 1 and stale fences to exit 3 without append', () => {
  for (const [label, flag, value, expectedCode, message] of [
    ['kind', '--kind', 'cmd', 1, /LAUNCHER_EXECUTABLE_KIND_INVALID/],
    ['actor', '--actor', 'agent', 1, /INVALID_ACTOR/],
    ['hash', '--sha256', 'A'.repeat(64), 1, /LAUNCHER_EXECUTABLE_HASH_INVALID/],
    ['path', '--canonical-path', '/different/wt.exe', 1, /LAUNCHER_EXECUTABLE_PATH_MISMATCH/],
    ['owner', '--owner', 'stale-owner', 3, /LEASE_FENCED/],
    ['generation', '--generation', '9', 3, /LEASE_FENCED/],
  ]) {
    const fixture = nativeWin32LauncherCliFixture();
    const runId = initWin32LauncherRun(fixture);
    const args = validLauncherApprovalArgs(fixture, runId);
    args[args.indexOf(flag) + 1] = value;
    const before = cliSnapshot(fixture.root, runId);
    const result = win32RunResult(fixture.root, args, fixture.env);
    assert.equal(result.code, expectedCode, `${label}: ${result.stderr}`);
    assert.match(result.stderr, message, label);
    assert.deepEqual(cliSnapshot(fixture.root, runId), before, label);
  }

  const ambiguous = nativeWin32LauncherCliFixture();
  const runId = initWin32LauncherRun(ambiguous);
  const before = cliSnapshot(ambiguous.root, runId);
  const args = validLauncherApprovalArgs(ambiguous, runId);
  args.splice(4, 0, '--path', join(ambiguous.root, 'other', 'wt.exe'));
  const result = win32RunResult(ambiguous.root, args, ambiguous.env);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /LAUNCHER_EXECUTABLE_AMBIGUOUS/);
  assert.deepEqual(cliSnapshot(ambiguous.root, runId), before);
});

launcherExecutableCliTest('launcher-executable approval repairs paused active state but rejects terminal state without changing lease', () => {
  const paused = nativeWin32LauncherCliFixture();
  const pausedRunId = initWin32LauncherRun(paused);
  const { data: pausedState } = readState(paused.root, pausedRunId);
  pausedState.status = 'paused';
  pausedState.pause_reason = 'launcher-executable-approval-required';
  const leaseBefore = structuredClone(pausedState.session_chain.lease);
  writeState(paused.root, pausedRunId, pausedState);
  const repaired = win32RunResult(paused.root, validLauncherApprovalArgs(paused, pausedRunId), paused.env);
  assert.equal(repaired.code, 0, repaired.stderr);
  const after = readState(paused.root, pausedRunId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'launcher-executable-approval-required');
  assert.deepEqual(after.session_chain.lease, leaseBefore);
  assert.equal(after.autonomy.launcher_executable_approvals.wt.sha256, paused.launcherSha256);

  const terminal = nativeWin32LauncherCliFixture();
  const terminalRunId = initWin32LauncherRun(terminal);
  const { data: terminalState } = readState(terminal.root, terminalRunId);
  terminalState.status = 'completed';
  writeState(terminal.root, terminalRunId, terminalState);
  const before = cliSnapshot(terminal.root, terminalRunId);
  const rejected = win32RunResult(terminal.root, validLauncherApprovalArgs(terminal, terminalRunId), terminal.env);
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.match(rejected.stderr, /LAUNCHER_EXECUTABLE_STATE_INVALID.*RUN_TERMINAL/);
  assert.deepEqual(cliSnapshot(terminal.root, terminalRunId), before);
});

launcherExecutableCliTest('forced-win32 POSIX CLI fixture never becomes runnable native launcher authority', () => {
  const fixture = nativeWin32LauncherCliFixture();
  const runId = initWin32LauncherRun(fixture);

  const launcherDiagnosis = win32RunResult(fixture.root, [
    'launcher-executable', 'diagnose', '--kind', 'wt', '--path', fixture.launcher,
  ], fixture.env);
  assert.equal(launcherDiagnosis.code, 0, launcherDiagnosis.stderr);
  const diagnosedLauncher = JSON.parse(launcherDiagnosis.stdout).identity;
  assert.equal(diagnosedLauncher.canonical_path, fixture.launcher);
  assert.equal(diagnosedLauncher.sha256, fixture.launcherSha256);
  assert.equal(existsSync(fixture.launches), false);

  const launcherApproval = win32RunResult(
    fixture.root, validLauncherApprovalArgs(fixture, runId), fixture.env,
  );
  assert.equal(launcherApproval.code, 0, launcherApproval.stderr);

  const detected = win32RunResult(fixture.root, [
    'detect-terminal', '--owner', runId, '--generation', '1',
  ], fixture.env);
  assert.equal(detected.code, 0, detected.stderr);
  const descriptor = JSON.parse(detected.stdout);
  assert.equal(descriptor.launcher, 'wt');
  assert.equal(descriptor.launcher_bin, fixture.launcher);
  assert.equal(descriptor.launcher_identity.sha256, fixture.launcherSha256);

  const runtimeDiagnosis = win32RunResult(fixture.root, [
    'runtime-executable', 'diagnose', '--runtime', 'claude', '--path', fixture.runtime,
  ], fixture.env);
  assert.equal(runtimeDiagnosis.code, 0, runtimeDiagnosis.stderr);
  const diagnosedRuntime = JSON.parse(runtimeDiagnosis.stdout).identity;
  assert.equal(diagnosedRuntime.canonical_path, fixture.runtime);
  assert.equal(diagnosedRuntime.sha256, fixture.runtimeSha256);

  const runtimeApproval = win32RunResult(fixture.root, [
    'runtime-executable', 'approve', '--runtime', 'claude',
    '--path', fixture.runtime, '--canonical-path', fixture.runtime,
    '--sha256', fixture.runtimeSha256, '--actor', 'human', '--confirm',
    '--owner', runId, '--generation', '1', '--now', '2026-07-12T01:01:00Z',
  ], fixture.env);
  assert.equal(runtimeApproval.code, 0, runtimeApproval.stderr);

  const { data } = readState(fixture.root, runId);
  data.autonomy.child_ready_timeout_sec = 0;
  writeState(fixture.root, runId, data);
  const emitted = win32RunResult(fixture.root, [
    'handoff', 'emit', '--reason', 'milestone', '--trigger', 'milestone',
    '--owner', runId, '--generation', '1',
  ], fixture.env);
  assert.equal(emitted.code, 0, emitted.stderr);
  assert.equal(JSON.parse(emitted.stdout).ok, true);

  const respawned = win32RunResult(fixture.root, [
    'respawn', '--attended', '--timeout-ms', '0',
    '--owner', runId, '--generation', '1',
  ], fixture.env);
  assert.equal(respawned.code, 0, respawned.stderr);
  const outcome = JSON.parse(respawned.stdout);
  assert.equal(outcome.mode, 'wt');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.outcome, 'no-launcher');
  assert.equal(outcome.reason, 'trusted-native-identity-unavailable');

  assert.equal(existsSync(fixture.launches), false, 'a POSIX fixture path must never be invoked as native Windows authority');
  const finalState = readState(fixture.root, runId).data;
  assert.equal(finalState.status, 'paused');
  assert.equal(finalState.pause_reason, 'trusted-native-identity-unavailable');
  assert.equal(finalState.session_chain.lease.handoff_phase, 'emitted');
});

test('workstream new + set via CLI with lease', () => {
  const { root, runId } = seed();
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'Auth', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'in_progress');
});

test('mutating command with wrong generation is fenced (exit 3)', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '9']); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('episode new creates request + episode via CLI', () => {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl', '--point', 'implementation', '--owner', runId, '--generation', '1']));
  assert.match(ep.id, /^001-deep-work$/);
  assert.equal(readState(root, runId).data.episodes.length, 1);
});

// Codex r1 🔴6: proof-파생 터미널/리뷰 결과가 CLI 경계로 도달 가능해야 (Execution 은 CLI 로만 상태 변경).
// Fix 2: workstream terminal --status ready now uses kernel-derived proof (abandoned doesn't need review_points).
test('workstream terminal (abandoned) + review record reach kernel via CLI', () => {
  const { root, runId } = seed();
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'A', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  run(root, ['workstream', 'terminal', '--id', ws.id, '--status', 'abandoned', '--proof', '{"reason":"superseded"}', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'abandoned');
  // review record: a done maker (so the checker binds — dispatchReview refuses unbound), then dispatch + record.
  const ws2 = JSON.parse(run(root, ['workstream', 'new', '--title', 'B', '--branch', 'b2', '--worktree', '.claude/worktrees/w2', '--owner', runId, '--generation', '1']));
  writeFileSync(join(root, 'plan-art.txt'), 'artifact');
  const maker = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'plan', '--point', 'plan', '--workstream', ws2.id, '--artifacts', '["plan-art.txt"]', '--owner', runId, '--generation', '1']));
  run(root, ['episode', 'record', '--id', maker.id, '--status', 'done', '--artifacts', '["plan-art.txt"]', '--owner', runId, '--generation', '1']);
  const disp = JSON.parse(run(root, ['review', 'dispatch', '--point', 'plan', '--workstream', ws2.id, '--owner', runId, '--generation', '1']));
  // #2+Fix4: a passing verdict via CLI must carry --report — a real file under the reviewed ws worktree (.claude/worktrees/w2).
  mkdirSync(join(root, '.claude/worktrees/w2'), { recursive: true });
  writeFileSync(join(root, '.claude/worktrees/w2/plan-review.md'), '# plan review');
  run(root, ['review', 'record', '--episode', disp.checkerEpisodeId, '--verdict', 'APPROVE', '--report', '.claude/worktrees/w2/plan-review.md', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === disp.checkerEpisodeId).status, 'approved');
});

test('review record derives proof metadata and rejects legacy caller source/workstream/point flags', () => {
  for (const [name, value] of [['source', 'spoof'], ['workstream', 'ws-spoof'], ['point', 'plan']]) {
    const { root, runId } = seed();
    const result = runResult(root, ['review', 'record', '--episode', 'checker', '--verdict', 'REQUEST_CHANGES', `--${name}`, value, '--owner', runId, '--generation', '1']);
    assert.equal(result.code, 1, name);
    assert.match(result.stderr, /REVIEW_METADATA_FORBIDDEN/, name);
  }
});

test('review record missing episode or verdict remains usage exit 2', () => {
  for (const args of [
    ['review', 'record', '--verdict', 'REQUEST_CHANGES'],
    ['review', 'record', '--episode', 'checker'],
  ]) {
    const { root, runId } = seed();
    const result = runResult(root, [...args, '--owner', runId, '--generation', '1']);
    assert.equal(result.code, 2, args.join(' '));
  }
});

// Fix 1: episode record --status approved/rejected exits nonzero (status 1 — invalid value, not a fence violation)
test('episode record --status approved exits with code 1', () => {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'checker', '--kind', 'impl-review', '--point', 'implementation', '--owner', runId, '--generation', '1']));
  let code = 0;
  try { run(root, ['episode', 'record', '--id', ep.id, '--status', 'approved', '--proof', '{"verdict":"APPROVE"}', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; }
  assert.equal(code, 1);
});

// Fix 5: respawn --dry-run returns JSON with ok field and exits 0
test('respawn --dry-run returns JSON with ok field', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['respawn', '--dry-run']));
  assert.ok('ok' in out);
});

test('explicit CLI Codex --headless overrides visible handoff intent and cannot bypass preflight', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-cli-headless-host-')));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', now: new Date('2026-07-11T00:00:00Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'visible';
  writeState(root, runId, data);
  const handoff = emitHandoff(root, runId, {
    trigger: 'milestone',
    resumePolicy: 'visible',
    expect: { owner: runId, generation: 1 },
    now: Date.parse('2026-07-11T00:01:00Z'),
  });
  assert.equal(handoff.ok, true);

  const output = JSON.parse(run(root, [
    'respawn',
    '--headless',
    '--owner', runId,
    '--generation', '1',
    '--now', '2026-07-11T00:02:00Z',
  ]));
  assert.deepEqual(output, {
    mode: 'headless',
    ok: false,
    action: 'preflight-failed',
    reason: 'executable-invalid',
  });
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.pause_reason, 'executable-invalid');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(after.session_chain.lease.handoff_child_run_id, handoff.childRunId);
  assert.equal(
    readFileSync(CLI, 'utf8').includes("from './lib/headless-host.mjs'"),
    true,
  );
  assert.match(
    readFileSync(CLI, 'utf8'),
    /clock:\s*f\.now === undefined \? Date\.now : null/,
    'normal CLI headless runs must refresh wallclock after preflight while explicit --now stays deterministic',
  );
});

test('CLI respawn threads an explicit --timeout-ms into the shared headless host', () => {
  const source = readFileSync(CLI, 'utf8');
  assert.match(source, /['"]timeout-ms['"]/);
  assert.match(source, /driveHeadlessRun\(\{[^}]*timeoutMs/s);
});

// Fix 6: workstream new with --generation flag but no value exits nonzero (status 3)
test('workstream new with valueless --generation flag exits with code 3', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation']); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('handoff emit via CLI sets releasing', () => {
  const { root, runId } = seed();
  run(root, ['handoff', 'emit', '--reason', 'milestone', '--trigger', 'milestone', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
});

test('handoff emit CLI maps an in-lock LEASE_FENCED result to exit 3', () => {
  const { root, runId } = seed();
  const loopPath = join(runDir(root, runId), 'loop.json');
  const before = readFileSync(loopPath, 'utf8');
  const result = spawnSync(process.execPath, [
    CLI,
    'handoff', 'emit',
    '--reason', 'milestone',
    '--trigger', 'milestone',
    '--owner', runId,
    '--generation', '2',
    '--project-root', root,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /LEASE_FENCED/);
  assert.equal(readFileSync(loopPath, 'utf8'), before);
});

// Codex r5 🟡3: lease acquire with valueless --owner exits 3
test('lease acquire --owner (valueless) exits with code 3', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['lease', 'acquire', '--owner', '--generation', '1', '--runtime', 'claude', '--run-id', runId]); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

// Codex r5 🟡3: lease acquire with missing --owner exits 3
test('lease acquire (missing --owner) exits with code 3', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['lease', 'acquire', '--generation', '1', '--runtime', 'claude', '--run-id', runId]); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

// Fix 3: workstream new missing --title exits 2 (usage error, not a fence violation)
test('workstream new missing --title exits with code 2', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; }
  assert.equal(code, 2);
});

test('full suite still green count grows (smoke: validate ok)', () => {
  const { root } = seed();
  const out = run(root, ['validate']);
  assert.match(out, /ok/);
});

function setupRunWithPendingMaker() {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl', '--point', 'implementation', '--owner', runId, '--generation', '1']));
  return { root, runId, episodeId: ep.id };
}

// Task 9: episode abandon verb + record abandoned rejection
test('episode abandon settles a stranded pending maker (exit 0)', () => {
  const { root, runId, episodeId } = setupRunWithPendingMaker();
  run(root, ['episode', 'abandon', '--id', episodeId, '--reason', 'orphan', '--confirm', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.episodes[0].status, 'abandoned');
});

test('episode record --status abandoned is rejected (exit 1)', () => {
  const { root, runId, episodeId } = setupRunWithPendingMaker();
  let code = 0;
  try { run(root, ['episode', 'record', '--id', episodeId, '--status', 'abandoned', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; }
  assert.equal(code, 1);
});

// Codex review P2: episode abandon WITHOUT --confirm must exit 2 (usage/human-gate) with CONFIRM_REQUIRED,
// mirroring the recover/breaker-reset contract — NOT exit 1 from an uncaught CONFIRM_REQUIRED throw.
test('episode abandon without --confirm exits 2 with CONFIRM_REQUIRED', () => {
  const { root, runId, episodeId } = setupRunWithPendingMaker();
  let code = 0, stderr = '';
  try { run(root, ['episode', 'abandon', '--id', episodeId, '--reason', 'orphan', '--owner', runId, '--generation', '1']); }
  catch (e) { code = e.status; stderr = String(e.stderr || ''); }
  assert.equal(code, 2);
  assert.match(stderr, /CONFIRM_REQUIRED/);
  assert.equal(readState(root, runId).data.episodes[0].status, 'pending');   // not abandoned
});

test('CLI validate from nested .claude/worktrees cwd resolves the run (rootOf upward-search)', () => {
  const { root, runId } = seed();
  const wt = join(root, '.claude', 'worktrees', 'ws-01');
  mkdirSync(wt, { recursive: true });
  // --project-root 없이, cwd 를 worktree 로 두고 validate 호출 → run 을 찾아야 함.
  const out = execFileSync('node', [CLI, 'validate'], { cwd: wt, encoding: 'utf8' });
  assert.match(out, new RegExp(`ok \\(run ${runId}\\)`), 'validate found run from worktree cwd');
});

// ── v1.5.0 (c): parseNow malformed → 전-커맨드 공통 INVALID_NOW exit 1 (spec §4) ───
test('v1.5 (c): malformed --now → exit 1 + INVALID_NOW (read-only와 mutating 대표 커맨드)', () => {
  const { root, runId } = seed();
  const cases = [
    ['next-action', '--json', '--now', 'not-a-date'],
    ['insights', 'emit', '--now', 'not-a-date', '--owner', runId, '--generation', '1'],
  ];
  for (const args of cases) {
    let code = 0, stderr = '';
    try { run(root, args); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, args.join(' '));
    assert.match(stderr, /INVALID_NOW/, args.join(' '));
  }
});

test('v1.5 (c): value-less --now → exit 1 + INVALID_NOW', () => {
  const { root } = seed();
  let code = 0, stderr = '';
  try { run(root, ['next-action', '--json', '--now']); } catch (e) { code = e.status; stderr = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(stderr, /INVALID_NOW/);
});

test('v1.5 (c): Date 범위 밖 유한 숫자 --now → exit 1 + INVALID_NOW (후속 toISOString RangeError 차단, plan-r4)', () => {
  const { root } = seed();
  let code = 0, stderr = '';
  try { run(root, ['next-action', '--json', '--now', '8640000000000001']); } catch (e) { code = e.status; stderr = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(stderr, /INVALID_NOW/);
});

test('v1.5 (c): 숫자형 오타 --now(1.5/+1/-1)는 legacy Date.parse로 새지 않고 exit 1 (impl-r1)', () => {
  const { root } = seed();
  for (const bad of ['1.5', '+1', '-1']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});

test('v1.5 (c): --now 미지정·유효 ms·유효 ISO는 정상 동작 유지', () => {
  const { root } = seed();
  assert.ok(JSON.parse(run(root, ['next-action', '--json'])).action);
  assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', String(Date.parse('2026-06-24T00:00:01Z'))])).action);
  assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z'])).action);
});

test('v1.5 (c): legacy Date.parse 형식(1/2, 2026-1-1, 자연어 날짜)은 화이트리스트에서 거부 (impl-r2)', () => {
  const { root } = seed();
  for (const bad of ['1/2', '2026-1-1', 'June 24, 2026']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});

test('v1.5 (c): ISO 화이트리스트 변형(date-only, 오프셋, 밀리초)은 정상', () => {
  const { root } = seed();
  for (const ok of ['2026-06-24', '2026-06-24T00:00:01+09:00', '2026-06-24T00:00:01.500Z']) {
    assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', ok])).action, ok);
  }
});

test('v1.5 (c): 달력-무효·tz-less ISO는 롤오버/로컬 해석 없이 exit 1 (impl-r3, 2/2)', () => {
  const { root } = seed();
  for (const bad of ['2026-02-31', '2026-04-31', '2025-02-29', '2026-06-24T00:00:01']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});

test('v1.5 (c): 윤년 02-29·date-only는 UTC 자정으로 정상 (호스트 TZ 무관)', () => {
  const { root } = seed();
  for (const ok of ['2028-02-29', '2026-06-24']) {
    assert.ok(JSON.parse(run(root, ['next-action', '--json', '--now', ok])).action, ok);
  }
});

test('v1.5 (c): 범위 밖 tz 오프셋(+09:99, +24:00)은 exit 1 (impl-r4)', () => {
  const { root } = seed();
  for (const bad of ['2026-06-24T00:00:00+09:99', '2026-06-24T00:00:00+24:00']) {
    let code = 0, stderr = '';
    try { run(root, ['next-action', '--json', '--now', bad]); } catch (e) { code = e.status; stderr = String(e.stderr); }
    assert.equal(code, 1, bad);
    assert.match(stderr, /INVALID_NOW/, bad);
  }
});
