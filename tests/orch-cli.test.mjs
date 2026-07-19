import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixedInitializationRequest, commitFixedInitialization, detectInitializationGit,
  initRun, prepareFixedInitialization, productionInitDeps } from '../scripts/lib/initrun.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { canonicalProjectRoot, projectRootDigest } from '../scripts/lib/project-root.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { structuredReadyToken } from '../scripts/lib/bounded-input.mjs';
import { confirmAppTask, prepareAppTask } from '../scripts/lib/app-task-continuation.mjs';
import { finishRun as finish11a } from '../scripts/lib/finish.mjs';
import { appendAnchored, readLines } from '../scripts/lib/integrity.mjs';
import { createDirectoryJunction } from './helpers/fs-fixtures.mjs';
import { appHostTaskCwdDigest } from '../scripts/lib/host-surface.mjs';
import { validate, verifyAppEventCorrelation } from '../scripts/lib/schema.mjs';
import {
  rawHashValidState as rawState7b,
  seedCorrelatedTerminal,
} from './fixtures/verified-app-run.mjs';

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
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'A', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--request-id', 'cli-review-workstream', '--owner', runId, '--generation', '1']));
  writeFileSync(join(root, 'plan.txt'), 'artifact');
  const maker = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'plan', '--point', 'plan', '--workstream', ws.id, '--artifacts', '["plan.txt"]', '--task', 'Produce the finish proof plan.', '--request-id', 'finish-proof-maker', '--owner', runId, '--generation', '1']));
  run(root, ['episode', 'record', '--id', maker.id, '--status', 'done', '--artifacts', '["plan.txt"]', '--owner', runId, '--generation', '1']);

  const dispatched = JSON.parse(run(root, ['review', 'dispatch', '--point', 'plan', '--workstream', ws.id, '--request-id', 'cli-review-round-1', '--independent-subagent', '--owner', runId, '--generation', '1']));
  assert.match(dispatched.request_markdown, /Independently review maker episode/);
  assert.match(dispatched.request_markdown_digest, /^[0-9a-f]{64}$/);
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
  rawState7b(invalidOriginal.root, invalidOriginal.runId,
    data => { data.run_id = 'DIFFERENT-RUN-ID'; });
  const { data } = readState(invalidOriginal.root, invalidOriginal.runId);
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
  seedCorrelatedTerminal(original.root, original.runId, { status: 'stopped' });
  const { data } = readState(original.root, original.runId);
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
  seedCorrelatedTerminal(fixture.root, fixture.runId, { status: 'completed' });
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
  assert.deepEqual(initial.autonomy.launcher_executable_approvals, { wt: null, powershell: null });

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
  seedCorrelatedTerminal(terminal.root, terminalRunId, { status: 'completed' });
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
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'Auth', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--request-id', 'cli-workstream-auth', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'in_progress');
});

test('mutating command with wrong generation is fenced (exit 3)', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--request-id', 'cli-workstream-wrong-generation', '--owner', runId, '--generation', '9']); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('episode new returns anchored inline request + episode via CLI', () => {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl', '--point', 'implementation', '--task', 'Implement the CLI episode fixture.', '--request-id', 'cli-episode-create', '--owner', runId, '--generation', '1']));
  assert.match(ep.id, /^001-deep-work$/);
  assert.match(ep.request_markdown, /Implement the CLI episode fixture\./);
  assert.doesNotMatch(ep.request_markdown, /fill the maker\/checker task/);
  assert.match(ep.request_markdown_digest, /^[0-9a-f]{64}$/);
  assert.equal(readState(root, runId).data.episodes.length, 1);
});

// Codex r1 🔴6: proof-파생 터미널/리뷰 결과가 CLI 경계로 도달 가능해야 (Execution 은 CLI 로만 상태 변경).
// Fix 2: workstream terminal --status ready now uses kernel-derived proof (abandoned doesn't need review_points).
test('workstream terminal (abandoned) + review record reach kernel via CLI', () => {
  const { root, runId } = seed();
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'A', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--request-id', 'cli-workstream-terminal-a', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  run(root, ['workstream', 'terminal', '--id', ws.id, '--status', 'abandoned', '--proof', '{"reason":"superseded"}', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'abandoned');
  // review record: a done maker (so the checker binds — dispatchReview refuses unbound), then dispatch + record.
  const ws2 = JSON.parse(run(root, ['workstream', 'new', '--title', 'B', '--branch', 'b2', '--worktree', '.claude/worktrees/w2', '--request-id', 'cli-workstream-terminal-b', '--owner', runId, '--generation', '1']));
  writeFileSync(join(root, 'plan-art.txt'), 'artifact');
  const maker = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'plan', '--point', 'plan', '--workstream', ws2.id, '--artifacts', '["plan-art.txt"]', '--task', 'Produce the CLI review maker plan.', '--request-id', 'cli-review-maker', '--owner', runId, '--generation', '1']));
  run(root, ['episode', 'record', '--id', maker.id, '--status', 'done', '--artifacts', '["plan-art.txt"]', '--owner', runId, '--generation', '1']);
  const disp = JSON.parse(run(root, ['review', 'dispatch', '--point', 'plan', '--workstream', ws2.id, '--request-id', 'cli-review-terminal-flow', '--owner', runId, '--generation', '1']));
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
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'checker', '--kind', 'impl-review', '--point', 'implementation', '--task', 'Review the CLI checker fixture.', '--request-id', 'cli-review-checker', '--owner', runId, '--generation', '1']));
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
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--request-id', 'cli-workstream-missing-generation-value', '--owner', runId, '--generation']); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('handoff emit via CLI sets releasing', () => {
  const { root, runId } = seed();
  run(root, ['handoff', 'emit', '--reason', 'milestone', '--trigger', 'milestone', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
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
  try { run(root, ['workstream', 'new', '--branch', 'b', '--worktree', '.claude/worktrees/w', '--request-id', 'cli-workstream-missing-title', '--owner', runId, '--generation', '1']); }
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
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl', '--point', 'implementation', '--task', 'Implement the abandon fixture.', '--request-id', 'cli-abandon-maker', '--owner', runId, '--generation', '1']));
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

function runReady(args, expectedReady, payload, { cwd: cwdOverride } = {}) {
  return new Promise((resolve, reject) => {
    const rootIndex = args.indexOf('--project-root');
    const cwd = cwdOverride ?? (rootIndex >= 0 ? args[rootIndex + 1] : undefined);
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let wrote = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!wrote && stdout.includes(`${expectedReady}\n`)) {
        wrote = true;
        child.stdin.end(`${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, wrote }));
  });
}

const fixedObservation = root => ({ kind: 'codex-app', source: 'codex-app-tool-provenance',
  capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
  structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
  host_task_cwd_source: 'app-task-context' });

test('init-run preflight is explicit-root READY-gated and byte-identical no-write', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-preflight-')));
  const nonce = '11111111111111111111111111111111';
  const ready = `DEEP_LOOP_STDIN_READY:v1:init-preflight:${nonce}:pipe-open-noecho`;
  const result = await runReady(['init-run', 'preflight', '--project-root', root, '--runtime',
    'codex', '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce', nonce,
    '--observation-stdin'], ready, fixedObservation(root));
  assert.equal(result.code, 0, result.stderr); assert.equal(result.wrote, true);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
  const extra = await runReady(['init-run', 'preflight', '--project-root', root, '--runtime',
    'codex', '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '--observation-stdin'],
  'DEEP_LOOP_STDIN_READY:v1:init-preflight:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:pipe-open-noecho',
  { ...fixedObservation(root), threadId: 'RAW_THREAD_SENTINEL' });
  assert.equal(extra.code, 1); assert.doesNotMatch(extra.stdout + extra.stderr, /RAW_THREAD_SENTINEL/);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
  const malformed = await runReady(['init-run', 'preflight', '--project-root', root, '--runtime',
    'codex', '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce', 'not-hex',
    '--observation-stdin'], 'unused', fixedObservation(root));
  assert.equal(malformed.code, 2); assert.equal(malformed.wrote, false);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-outside-')));
  const fenced = await runReady(['init-run', 'preflight', '--project-root', root, '--runtime',
    'codex', '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce', nonce,
    '--observation-stdin'], ready, fixedObservation(root), { cwd: outside });
  assert.equal(fenced.code, 3); assert.equal(fenced.wrote, false);
});

test('fixed structured JSON diagnostics never reflect malformed host payload bytes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-json-')));
  const nonce = '22222222222222222222222222222222';
  const secret = 'RAW_HOST_SECRET_SHOULD_NOT_ECHO';
  const result = await runReady(['init-run', 'preflight', '--project-root', root, '--runtime',
    'codex', '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce', nonce,
    '--observation-stdin'], `DEEP_LOOP_STDIN_READY:v1:init-preflight:${nonce}:pipe-open-noecho`,
  `{"host_task_cwd":"${secret}",BROKEN`);
  assert.equal(result.code, 1); assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.match(result.stderr, /STRUCTURED_JSON_INVALID/);
});

function manualFixed(root, goal = 'fixed') {
  return ['--project-root', root, '--manual-enums', '--runtime', 'codex', '--goal', goal,
    '--host-surface', 'codex-cli', '--host-source', 'codex-cli-host',
    '--app-continuation', 'manual', '--app-consent-authority', 'default-manual'];
}

for (const profile of [
  { label: 'paired-null', runtime: 'codex', suffix: [],
    expected: { kind: null, source: null, capabilities: [] } },
  { label: 'claude-code', runtime: 'claude',
    suffix: ['--host-surface', 'claude-code', '--host-source', 'claude-cli-entrypoint'],
    expected: { kind: 'claude-code', source: 'claude-cli-entrypoint', capabilities: [] } },
  { label: 'claude-desktop', runtime: 'claude',
    suffix: ['--host-surface', 'claude-desktop', '--host-source',
      'claude-desktop-local-agent', '--capabilities', 'send-message-to-thread'],
    expected: { kind: 'claude-desktop', source: 'claude-desktop-local-agent',
      capabilities: ['send-message-to-thread'] } },
  { label: 'codex-cli', runtime: 'codex',
    suffix: ['--host-surface', 'codex-cli', '--host-source', 'codex-cli-host'],
    expected: { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] } },
  { label: 'codex-app', runtime: 'codex',
    suffix: ['--host-surface', 'codex-app', '--host-source', 'codex-app-tool-provenance',
      '--capabilities', 'list-projects,create-thread-local'],
    expected: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects'] } },
]) {
  test(`fixed manual enum ${profile.label} prepares, commits, and retries the exact binding`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `dl-fixed-${profile.label}-`)));
    const common = ['--project-root', root, '--manual-enums', '--runtime', profile.runtime,
      '--goal', `manual-${profile.label}`, ...profile.suffix,
      '--app-continuation', 'manual', '--app-consent-authority', 'default-manual'];
    const prepare = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...common,
      '--expected-observation-digest', 'NONE'], { cwd: root, encoding: 'utf8' });
    assert.equal(prepare.status, 0, prepare.stderr);
    const binding = JSON.parse(prepare.stdout);
    assert.equal(existsSync(join(root, '.deep-loop')), false, 'prepare must be no-write');
    const fullArgs = [CLI, 'init-run', ...common,
      '--init-attempt', binding.attempt_id,
      '--expected-current-digest', binding.previous_current_digest,
      '--expected-request-digest', binding.expected_request_digest,
      '--expected-preflight-digest', 'NONE',
      '--prepared-authority', JSON.stringify(binding.prepared_authority)];
    const full = spawnSync(process.execPath, fullArgs, { cwd: root, encoding: 'utf8' });
    assert.equal(full.status, 0, full.stderr);
    assert.equal(JSON.parse(full.stdout).run_id, binding.attempt_id);
    const retry = spawnSync(process.execPath, fullArgs, { cwd: root, encoding: 'utf8' });
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).run_id, binding.attempt_id);
    const state = readState(root, binding.attempt_id).data;
    assert.equal(state.initialization.host_observation_digest, 'NONE');
    assert.deepEqual(state.initialization.request_projection.enum_profile, profile.expected);
    const stored = state.session_chain.sessions[0].host_surface;
    assert.equal(stored?.kind ?? null, profile.expected?.kind ?? null);
    assert.equal(stored?.structured_stdin_mode ?? null, null);
  });
}

test('fixed manual enums reject mixed, sentinel, cross-runtime, and structured forms without writes',
  () => {
    const invalid = [
      ['--runtime', 'codex', '--host-surface', 'codex-app'],
      ['--runtime', 'codex', '--host-surface', 'null', '--host-source', 'null'],
      ['--runtime', 'claude', '--host-surface', 'codex-app', '--host-source',
        'codex-app-tool-provenance'],
      ['--runtime', 'codex', '--host-surface', 'codex-app', '--host-source',
        'codex-app-tool-provenance', '--capabilities', 'structured-process-stdin'],
      ['--runtime', 'codex', '--stdin-mode', 'pipe-open-noecho'],
      ['--runtime', 'codex', '--host-task-cwd', '/raw/host/cwd'],
    ];
    for (const [index, suffix] of invalid.entries()) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `dl-fixed-invalid-${index}-`)));
      const result = spawnSync(process.execPath, [CLI, 'init-run', 'prepare',
        '--project-root', root, '--manual-enums', '--goal', 'invalid-manual',
        '--app-continuation', 'manual', '--app-consent-authority', 'default-manual',
        '--expected-observation-digest', 'NONE', ...suffix], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 2, `${suffix.join(' ')}: ${result.stderr}`);
      assert.equal(existsSync(join(root, '.deep-loop')), false);
    }
  });

test('prepare status and manual-enums forms require exact explicit authority bindings', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-query-')));
  const common = manualFixed(root);
  const prepare = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...common,
    '--expected-observation-digest', 'NONE'], { cwd: root, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr);
  const binding = JSON.parse(prepare.stdout);
  assert.deepEqual(Object.keys(binding.prepared_authority).sort(), ['cwd', 'root', 'version']);
  const status = spawnSync(process.execPath, [CLI, 'init-run', 'status', '--project-root', root,
    '--attempt', binding.attempt_id, '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest], { cwd: root, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).outcome, 'absent');
  assert.equal(existsSync(join(root, '.deep-loop')), false, 'prepare/status are no-write');
  const authority = JSON.stringify(binding.prepared_authority);
  const full = spawnSync(process.execPath, [CLI, 'init-run', ...common,
    '--init-attempt', binding.attempt_id, '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest, '--expected-preflight-digest', 'NONE',
    '--prepared-authority', authority], { cwd: root, encoding: 'utf8' });
  assert.equal(full.status, 0, full.stderr);
  assert.equal(JSON.parse(full.stdout).run_id, binding.attempt_id);
  for (const forbidden of [['--stdin-mode', 'pty-raw-noecho'],
    ['--capabilities', 'structured-process-stdin'], ['--project-root', root],
    ['--unknown-init-flag', 'value']]) {
    const bad = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...common,
      '--expected-observation-digest', 'NONE', ...forbidden], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 2, forbidden.join(' '));
  }
});

test('prepared_authority grammar fails closed before READY or mutation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-authority-')));
  const attempt = '01JAPPTASK0000000000000000';
  const base = ['init-run', '--project-root', root, '--runtime', 'codex', '--goal', 'authority',
    '--app-continuation', 'manual', '--app-consent-authority', 'default-manual',
    '--init-attempt', attempt, '--expected-current-digest', 'NONE',
    '--expected-request-digest', 'a'.repeat(64), '--expected-preflight-digest', 'b'.repeat(64),
    '--stdin-mode', 'pipe-open-noecho', '--app-host-input-stdin'];
  const identity = { realpath: root, dev: '1', ino: '2' };
  const cases = [[], ['--prepared-authority'], ['--prepared-authority', '{broken'],
    ['--prepared-authority', `{"version":1,"version":1,"root":${JSON.stringify(identity)},"cwd":null}`],
    ['--prepared-authority', `{"version":1,"root":${JSON.stringify(identity)},"root":${JSON.stringify(identity)},"cwd":null}`],
    ['--prepared-authority', `{"version":1,"root":{"realpath":${JSON.stringify(root)},"dev":"1","dev":"1","ino":"2"},"cwd":null}`],
    ['--prepared-authority', JSON.stringify({ version: 1,
      root: { realpath: root, dev: '1n', ino: '2' }, cwd: null })],
    ['--prepared-authority', JSON.stringify({ version: 1,
      root: { realpath: root, dev: '1' }, cwd: null })],
    ['--prepared-authority', JSON.stringify({ version: 1, root: { ...identity, dev: 1 }, cwd: identity })],
    ['--prepared-authority', JSON.stringify({ version: 1, root: identity, cwd: identity, extra: true })],
    ['--prepared-authority', JSON.stringify({ version: 1, root: identity, cwd: identity }),
      '--prepared-authority', JSON.stringify({ version: 1, root: identity, cwd: identity })]];
  for (const suffix of cases) {
    const result = spawnSync(process.execPath, [CLI, ...base, ...suffix], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2, `${suffix.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout.includes('DEEP_LOOP_STDIN_READY'), false);
    assert.equal(existsSync(join(root, '.deep-loop')), false);
  }
});

test('fixed request facts and fixed git facts are independently bound', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-facts-')));
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'deep-loop@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Deep Loop Test']);
  writeFileSync(join(root, 'seed.txt'), 'seed\n'); execFileSync('git', ['-C', root, 'add', 'seed.txt']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'seed']);
  mkdirSync(join(root, '.deep-loop'), { recursive: true }); writeFileSync(join(root, '.deep-loop', 'x'), 'x');
  assert.equal(detectInitializationGit(root).dirty, false);
  writeFileSync(join(root, 'user.txt'), 'x'); assert.equal(detectInitializationGit(root).dirty, true);
});

test('fixed request facts are independently recomputed and drift fences before any write', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-request-drift-')));
  const input = { root, runtime: 'codex', goal: 'facts', protocol: 'standalone', recipe: 'default',
    review: { reviewer: 'subagent-checker' }, model: null, effort: null,
    consentMode: 'manual', consentAuthority: 'default-manual', observationDigest: 'NONE',
    enumProfile: { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] } };
  let generation = 1;
  const deps = { detectPlugins: () => ({ marker: generation }),
    detectGit: () => ({ head: String(generation).repeat(40), branch: `b${generation}`, dirty: false }),
    detectSessionSpawn: () => ({ launcher: 'none', generation }) };
  const first = buildFixedInitializationRequest(input, deps);
  const prepared = prepareFixedInitialization(root, first,
    productionInitDeps(root, first, { cwdFn: () => root }));
  generation = 2; const second = buildFixedInitializationRequest(input, deps);
  assert.throws(() => commitFixedInitialization(root, { request: second, observation: null, prepared },
    productionInitDeps(root, second, { cwdFn: () => root })), /INIT_BINDING_FENCED/);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('fixed-only flags without an exact init attempt never fall through to one-shot init', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-no-fallback-')));
  const result = spawnSync(process.execPath, [CLI, 'init-run', '--project-root', root,
    '--runtime', 'codex', '--goal', 'no-write', '--prepared-authority', '{}'],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(existsSync(join(root, '.deep-loop')), false);
});

const FIXED_INIT_CRASH_WORKER = fileURLToPath(new URL('./helpers/fixed-init-crash-worker.mjs', import.meta.url));
test('fixed init crash worker URL is converted to a native filesystem path', () => {
  assert.equal(FIXED_INIT_CRASH_WORKER.endsWith(join('helpers', 'fixed-init-crash-worker.mjs')), true);
  assert.equal(FIXED_INIT_CRASH_WORKER.includes('%20'), false);
});

test('fixed preflight binds actual and host cwd within the root or one exact internal worktree', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-cwd-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-host-other-')));
  const args = nonce => ['init-run', 'preflight', '--project-root', root, '--runtime', 'codex',
    '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce', nonce, '--observation-stdin'];
  const wrongNonce = '33333333333333333333333333333333';
  const wrong = await runReady(args(wrongNonce),
    `DEEP_LOOP_STDIN_READY:v1:init-preflight:${wrongNonce}:pipe-open-noecho`,
    { ...fixedObservation(root), host_task_cwd: other });
  assert.equal(wrong.code, 0, wrong.stderr);
  assert.deepEqual(JSON.parse(wrong.stdout.trim().split('\n').at(-1)), {
    eligible: false, reason: 'cwd-mismatch', observation_digest: 'NONE',
  });
  const worktree = join(root, '.worktrees', 'exact-child'); mkdirSync(worktree, { recursive: true });
  const worktreeNonce = '44444444444444444444444444444444';
  const accepted = await runReady(args(worktreeNonce),
    `DEEP_LOOP_STDIN_READY:v1:init-preflight:${worktreeNonce}:pipe-open-noecho`,
    { ...fixedObservation(root), host_task_cwd: worktree }, { cwd: worktree });
  assert.equal(accepted.code, 0, accepted.stderr); assert.equal(accepted.wrote, true);
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('fixed prepare rejects missing immutable scalars and malformed review without state', () => {
  for (const suffix of [[], ['--goal'], ['--goal', 'g', '--protocol'],
    ['--goal', 'g', '--model', '-unsafe'], ['--runtime', 'invalid', '--goal', 'g']]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-scalars-')));
    const runtime = suffix.includes('--runtime') ? [] : ['--runtime', 'codex'];
    const result = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', '--project-root', root,
      '--manual-enums', ...runtime, '--host-surface', 'codex-cli', '--host-source', 'codex-cli-host',
      '--app-continuation', 'manual', '--app-consent-authority', 'default-manual',
      '--expected-observation-digest', 'NONE', ...suffix], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2, `${suffix.join(' ')}: ${result.stderr}`);
    assert.equal(existsSync(join(root, '.deep-loop')), false);
  }
  for (const review of ['null', '[]', '"scalar"', '{broken',
    JSON.stringify({ payload: 'x'.repeat(17_000) })]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-review-')));
    const result = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...manualFixed(root),
      '--review', review, '--expected-observation-digest', 'NONE'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(existsSync(join(root, '.deep-loop')), false);
  }
});

test('fixed review JSON is request-bound through full commit', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-review-bound-')));
  const review = JSON.stringify({ reviewer: 'deep-review-loop', max_review_rounds: 5,
    contract: { model: 'opus', effort: 'xhigh' } });
  const common = [...manualFixed(root, 'review-bound'), '--review', review];
  const prepared = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...common,
    '--expected-observation-digest', 'NONE'], { cwd: root, encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr); const binding = JSON.parse(prepared.stdout);
  const committed = spawnSync(process.execPath, [CLI, 'init-run', ...common,
    '--init-attempt', binding.attempt_id, '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest, '--expected-preflight-digest', 'NONE',
    '--prepared-authority', JSON.stringify(binding.prepared_authority)], { cwd: root, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  assert.deepEqual(readState(root, binding.attempt_id).data.review, JSON.parse(review));
});

test('fixed enum init response loss retries the same committed attempt only', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-loss-')));
  const fixed = manualFixed(root, 'response-loss');
  const prepare = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...fixed,
    '--expected-observation-digest', 'NONE'], { cwd: root, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr); const binding = JSON.parse(prepare.stdout);
  const authority = JSON.stringify(binding.prepared_authority);
  const crashed = spawnSync(process.execPath, [FIXED_INIT_CRASH_WORKER, root, binding.attempt_id,
    binding.previous_current_digest, binding.expected_request_digest, 'NONE', authority, 'enum',
    'after-commit'], { cwd: root, encoding: 'utf8' });
  assert.equal(crashed.status, 91, crashed.stderr);
  const retry = spawnSync(process.execPath, [CLI, 'init-run', ...fixed,
    '--init-attempt', binding.attempt_id, '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest, '--expected-preflight-digest', 'NONE',
    '--prepared-authority', authority], { cwd: root, encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).run_id, binding.attempt_id);
  assert.deepEqual(readdirSync(join(root, '.deep-loop', 'runs'))
    .filter(id => existsSync(join(root, '.deep-loop', 'runs', id, 'loop.json'))), [binding.attempt_id]);
});

test('fixed full init response loss retries the same structured observation and attempt', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-full-loss-')));
  const observation = fixedObservation(root); const nonce = '55555555555555555555555555555555';
  const preflight = await runReady(['init-run', 'preflight', '--project-root', root, '--runtime',
    'codex', '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce', nonce, '--observation-stdin'],
  `DEEP_LOOP_STDIN_READY:v1:init-preflight:${nonce}:pipe-open-noecho`, observation);
  assert.equal(preflight.code, 0, preflight.stderr);
  const observationDigest = JSON.parse(preflight.stdout.trim().split('\n').at(-1)).observation_digest;
  const fixed = ['--project-root', root, '--runtime', 'codex', '--goal', 'response-loss',
    '--app-continuation', 'manual', '--app-consent-authority', 'default-manual'];
  const prepare = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...fixed,
    '--expected-observation-digest', observationDigest], { cwd: root, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr); const binding = JSON.parse(prepare.stdout);
  const authority = JSON.stringify(binding.prepared_authority);
  const authorityDigest = createHash('sha256').update(authority).digest('hex');
  const readyBinding = [binding.attempt_id, binding.previous_current_digest,
    binding.expected_request_digest, observationDigest, authorityDigest].join('.');
  const crashed = spawnSync(process.execPath, [FIXED_INIT_CRASH_WORKER, root, binding.attempt_id,
    binding.previous_current_digest, binding.expected_request_digest, observationDigest, authority,
    'full', 'after-commit'], { cwd: root, encoding: 'utf8' });
  assert.equal(crashed.status, 91, crashed.stderr);
  const retry = await runReady(['init-run', ...fixed, '--init-attempt', binding.attempt_id,
    '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest,
    '--expected-preflight-digest', observationDigest, '--prepared-authority', authority,
    '--stdin-mode', 'pipe-open-noecho', '--app-host-input-stdin'],
  `DEEP_LOOP_STDIN_READY:v1:init-commit:${readyBinding}:pipe-open-noecho`, observation);
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout.trim().split('\n').at(-1)).run_id, binding.attempt_id);
});

test('structured full verifies transported root and required cwd authority before READY or write', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-authority-before-ready-')));
  const observation = fixedObservation(root);
  const nonce = '66666666666666666666666666666666';
  const preflight = await runReady(['init-run', 'preflight', '--project-root', root, '--runtime',
    'codex', '--stdin-mode', 'pipe-open-noecho', '--preflight-nonce', nonce,
    '--observation-stdin'],
  `DEEP_LOOP_STDIN_READY:v1:init-preflight:${nonce}:pipe-open-noecho`, observation);
  assert.equal(preflight.code, 0, preflight.stderr);
  const observationDigest = JSON.parse(preflight.stdout.trim().split('\n').at(-1)).observation_digest;
  const fixed = ['--project-root', root, '--runtime', 'codex', '--goal', 'authority-before-ready',
    '--app-continuation', 'manual', '--app-consent-authority', 'default-manual'];
  const prepare = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...fixed,
    '--expected-observation-digest', observationDigest], { cwd: root, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr);
  const binding = JSON.parse(prepare.stdout);
  const full = authorityJson => ['init-run', ...fixed, '--init-attempt', binding.attempt_id,
    '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest,
    '--expected-preflight-digest', observationDigest,
    '--prepared-authority', authorityJson,
    '--stdin-mode', 'pipe-open-noecho', '--app-host-input-stdin'];
  for (const authority of [
    { ...binding.prepared_authority,
      root: { ...binding.prepared_authority.root, realpath: `${root}/.` } },
    { ...binding.prepared_authority, cwd: null },
  ]) {
    const authorityJson = JSON.stringify(authority);
    const authorityDigest = createHash('sha256').update(authorityJson).digest('hex');
    const readyBinding = [binding.attempt_id, binding.previous_current_digest,
      binding.expected_request_digest, observationDigest, authorityDigest].join('.');
    const result = await runReady(full(authorityJson),
      `DEEP_LOOP_STDIN_READY:v1:init-commit:${readyBinding}:pipe-open-noecho`, observation);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.wrote, false, 'transported authority is fenced before host observation');
    assert.equal(result.stdout.includes('DEEP_LOOP_STDIN_READY'), false);
    assert.match(result.stderr, /INIT_PREPARED_AUTHORITY_MISMATCH/);
    assert.equal(existsSync(join(root, '.deep-loop')), false,
      'pre-READY authority rejection cannot create control state');
  }
});

test('hard crash inside append-only init authority requires explicit manual compaction', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-fixed-stale-')));
  execFileSync('git', ['init', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'deep-loop@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Deep Loop Test']);
  writeFileSync(join(root, 'seed.txt'), 'seed\n'); execFileSync('git', ['-C', root, 'add', 'seed.txt']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'seed']);
  const fixed = manualFixed(root, 'response-loss');
  const prepare = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...fixed,
    '--expected-observation-digest', 'NONE'], { cwd: root, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr); const binding = JSON.parse(prepare.stdout);
  const authorityJson = JSON.stringify(binding.prepared_authority);
  const crashed = spawnSync(process.execPath, [FIXED_INIT_CRASH_WORKER, root, binding.attempt_id,
    binding.previous_current_digest, binding.expected_request_digest, 'NONE', authorityJson, 'enum',
    'inside-lock'], { cwd: root, encoding: 'utf8' });
  assert.equal(crashed.status, 91, crashed.stderr);
  const status = spawnSync(process.execPath, [CLI, 'init-run', 'status', '--project-root', root,
    '--attempt', binding.attempt_id, '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest], { cwd: root, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).lock_state, 'stale-manual');
  const blocked = spawnSync(process.execPath, [CLI, 'init-run', ...fixed,
    '--init-attempt', binding.attempt_id, '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest, '--expected-preflight-digest', 'NONE',
    '--prepared-authority', authorityJson], { cwd: root, encoding: 'utf8' });
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /LOCK_STALE_MANUAL/);
  const control = join(root, '.deep-loop');
  const authorityFiles = readdirSync(control).filter(name => name === '.init.lock'
    || /^\.init-lock-(?:candidate-(?:0|[1-9][0-9]*)-|successor-|release-)[A-Za-z0-9_-]{16,128}$/.test(name));
  assert.ok(authorityFiles.includes('.init.lock'));
  for (const name of authorityFiles) unlinkSync(join(control, name));
  const recovered = spawnSync(process.execPath, [CLI, 'init-run', ...fixed,
    '--init-attempt', binding.attempt_id, '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest, '--expected-preflight-digest', 'NONE',
    '--prepared-authority', authorityJson], { cwd: root, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).run_id, binding.attempt_id);
});

function runReadyMatch(args, readyPattern, line, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let wrote = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const ready = stdout.split('\n').find(value => readyPattern.test(value));
      if (!wrote && ready !== undefined) {
        wrote = true;
        child.stdin.end(line + '\n');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr, wrote }));
  });
}

test('host-surface stdin-probe is a literal READY-gated no-echo process', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-probe-')));
  const canary = 'DEEP_LOOP_CANARY_7f3a';
  const result = await runReadyMatch(['host-surface', 'stdin-probe',
    '--project-root', root, '--stdin-mode', 'pipe-open-noecho', '--probe-stdin'],
  /^DEEP_LOOP_STDIN_READY:v1:stdin-probe:[0-9a-f]{32}:pipe-open-noecho$/, canary);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.wrote, true);
  assert.equal(result.stdout.includes(canary), false);
  assert.equal(result.stderr.includes(canary), false);
  const lines = result.stdout.trim().split('\n');
  const receipt = JSON.parse(lines.at(-1));
  assert.deepEqual(Object.keys(receipt).sort(), ['byte_length', 'mode', 'ok', 'sha256']);
  assert.deepEqual(receipt, { ok: true, mode: 'pipe-open-noecho',
    byte_length: Buffer.byteLength(canary),
    sha256: createHash('sha256').update(canary).digest('hex') });
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});

test('host-surface observe has exact grammar and safe malformed JSON diagnostics', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-observe-cli-')));
  const { runId } = initRun(root, { runtime: 'codex', goal: 'observe-cli',
    cwdFn: () => root, now: new Date('2026-07-13T00:00:00.000Z') });
  writeFileSync(join(runDir(root, runId), 'event-log.jsonl'), '');
  rawState7b(root, runId, loop => {
    delete loop.initialization;
    delete loop.autonomy.app_task_continuation;
    loop.session_chain.sessions[0].host_surface = null;
    loop.event_log_head = { seq: 0, checksum: 'GENESIS' };
  });
  const manual = ['host-surface', 'observe', '--project-root', root, '--run-id', runId,
    '--owner', runId, '--generation', '1', '--runtime', 'codex', '--manual-enums',
    '--host-surface', 'codex-cli', '--host-source', 'codex-cli-host'];
  for (const extra of [
    ['--project-root', root],
    ['--stdin-mode', 'pipe-open-noecho'],
    ['--observation-stdin'],
    ['--unknown-host-flag', 'value'],
  ]) {
    const rejected = spawnSync(process.execPath, [CLI, ...manual, ...extra],
      { cwd: root, encoding: 'utf8' });
    assert.equal(rejected.status, 2, rejected.stderr);
  }
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dl-observe-cli-outside-')));
  const outsideBefore = {
    state: readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    events: readLines(root, runId),
  };
  const outsideEnum = spawnSync(process.execPath, [CLI, 'host-surface', 'observe',
    '--project-root', root, '--run-id', runId, '--owner', runId, '--generation', '1',
    '--runtime', 'codex', '--manual-enums', '--host-surface', 'codex-app',
    '--host-source', 'codex-app-tool-provenance', '--capabilities',
    'create-thread-local,list-projects'], { cwd: outside, encoding: 'utf8' });
  assert.equal(outsideEnum.status, 3, outsideEnum.stderr);
  assert.match(outsideEnum.stderr, /HOST_SURFACE_FENCED/);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')),
    outsideBefore.state);
  assert.deepEqual(readLines(root, runId), outsideBefore.events);
  const enumApp = spawnSync(process.execPath, [CLI, 'host-surface', 'observe',
    '--project-root', root, '--run-id', runId, '--owner', runId, '--generation', '1',
    '--runtime', 'codex', '--manual-enums', '--host-surface', 'codex-app',
    '--host-source', 'codex-app-tool-provenance', '--capabilities',
    'create-thread-local,list-projects'], { cwd: root, encoding: 'utf8' });
  assert.equal(enumApp.status, 0, enumApp.stderr);
  assert.equal(JSON.parse(enumApp.stdout).outcome, 'observed');
  const enumStored = readState(root, runId).data.session_chain.sessions[0].host_surface;
  assert.equal(enumStored.kind, 'codex-app');
  assert.equal(enumStored.host_task_cwd, null);
  assert.equal(enumStored.structured_stdin_mode, null);
  assert.equal(enumStored.kernel_cwd_at_observation, root);
  assert.equal(enumStored.observed_generation, 1);
  const before = readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json'));
  const secret = 'RAW_OBSERVATION_SECRET_SHOULD_NOT_ECHO';
  const malformed = await runReadyMatch(['host-surface', 'observe', '--project-root', root,
    '--run-id', runId, '--owner', runId, '--generation', '1', '--runtime', 'codex',
    '--stdin-mode', 'pipe-open-noecho', '--observation-stdin'],
  new RegExp('^DEEP_LOOP_STDIN_READY:v1:host-observe:' + runId
    + '\\.1:pipe-open-noecho$'), '{"secret":"' + secret + '",BROKEN');
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stdout.includes(secret), false);
  assert.equal(malformed.stderr.includes(secret), false);
  assert.match(malformed.stderr, /STRUCTURED_JSON_INVALID/);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')), before);

  const sentinel = 'RAW_OBSERVE_EXTRA_THREAD_ID';
  const rejected = await runReadyMatch(['host-surface', 'observe', '--project-root', root,
    '--run-id', runId, '--owner', runId, '--generation', '1', '--runtime', 'codex',
    '--stdin-mode', 'pipe-open-noecho', '--observation-stdin'],
  new RegExp('^DEEP_LOOP_STDIN_READY:v1:host-observe:' + runId
    + '\\.1:pipe-open-noecho$'), JSON.stringify({ kind: 'codex-app',
      source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context', threadId: sentinel }), { cwd: root });
  assert.equal(rejected.code, 1, rejected.stderr);
  assert.equal((rejected.stdout + rejected.stderr).includes(sentinel), false);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')), before);
  assert.equal(readLines(root, runId).some(event => JSON.stringify(event).includes(sentinel)), false);
});

test('App fence mismatches exit 3 but terminal after a valid fence exits 1', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-exit-')));
  const { runId } = initRun(root, { runtime: 'codex', goal: 'exit-precedence',
    cwdFn: () => root, now: new Date('2026-07-13T00:00:00.000Z') });
  assert.equal(runResult(root, ['app-task', 'status', '--run-id', runId]).code, 0);
  const missingRoot = spawnSync(process.execPath, [CLI, 'app-task', 'status', '--run-id', runId],
    { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(missingRoot.status, 2);
  assert.equal(runResult(root, ['app-task', 'status', '--run-id', runId,
    '--attempt', '01JAPPTASK0000000000000000']).code, 0);
  assert.equal(runResult(root, ['app-task', 'status', '--run-id', runId,
    '--attempt', 'not-an-attempt']).code, 2);
  assert.equal(runResult(root, ['app-task', 'revoke',
    '--run-id', 'ABSENT', '--runtime', 'codex']).code, 2);
  assert.equal(runResult(root, ['app-task', 'revoke',
    '--run-id', runId, '--owner', runId, '--generation', '1', '--runtime', 'codex',
    '--unknown-app-flag', 'value']).code, 2);
  assert.equal(runResult(root, ['app-task', 'revoke',
    '--run-id', runId, '--owner', runId, '--generation', 'bad', '--runtime', 'codex']).code, 2);
  assert.equal(runResult(root, ['app-task', 'revoke',
    '--run-id', runId, '--owner', '01JAPPWR0NG000000000000000',
    '--generation', '99', '--runtime', 'codex']).code, 3);
  const beforeClaude = cliSnapshot(root, runId);
  const claude = runResult(root, ['app-task', 'revoke',
    '--run-id', runId, '--owner', runId, '--generation', '1', '--runtime', 'claude']);
  assert.equal(claude.code, 2);
  assert.equal((claude.stdout + claude.stderr).includes('DEEP_LOOP_STDIN_READY:'), false);
  assert.deepEqual(cliSnapshot(root, runId), beforeClaude);
  assert.equal(runResult(root, ['app-task', 'revoke',
    '--run-id', runId, '--owner', runId, '--generation', '1', '--runtime', 'invalid']).code, 2);
  seedCorrelatedTerminal(root, runId, { status: 'completed' });
  assert.equal(runResult(root, ['app-task', 'revoke',
    '--run-id', runId, '--owner', runId, '--generation', '1', '--runtime', 'codex']).code, 1);
  assert.equal(runResult(root, ['app-task', 'consent', '--run-id', runId]).code, 2);
});

function seedAutoAppRun(goal) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-transition-')));
  const observed = '2026-07-13T00:00:00.000Z';
  const observation = { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
    structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
    host_task_cwd_source: 'app-task-context', observed_at: observed };
  const { runId } = initRun(root, { runtime: 'codex', goal, cwdFn: () => root,
    now: new Date(observed), hostObservation: observation,
    appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: observed, revoked_at: null } });
  return { root, runId, observed };
}

test('argumentless App status CLI returns the exact live current attempt', () => {
  const fixture = seedAutoAppRun('status-current');
  const attemptId = '01JAPPTASK0000000000000091';
  const emitted = emitHandoff(fixture.root, fixture.runId, {
    trigger: 'status-current', appIntent: true,
    expect: { owner: fixture.runId, generation: 1 },
    cwdFn: () => fixture.root, attemptIdFactory: () => attemptId,
    now: Date.parse('2026-07-13T00:00:01.000Z'),
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z'),
    descriptorBuilder: ({ runtime, root, parentRunId, childRunId }) => ({
      runtime, projectRoot: root, runId: parentRunId, usageOutputKind: 'json',
      resumeInvocation: `$deep-loop:deep-loop-resume ${childRunId}`,
      entries: Object.fromEntries(['interactive', 'headless', 'cmux', 'iterm2',
        'terminal-app', 'wt', 'powershell', 'desktop']
        .map(name => [name, { display: 'manual continuation', unavailable: true }])),
    }),
  });
  const result = runResult(fixture.root,
    ['app-task', 'status', '--run-id', fixture.runId]);
  assert.equal(result.code, 0, result.stderr);
  const projected = JSON.parse(result.stdout);
  assert.deepEqual({ run_id: projected.current?.run_id,
    attempt_id: projected.current?.attempt_id }, {
    run_id: emitted.childRunId, attempt_id: attemptId,
  });
});

test('App post-fence transition invalidity exits 1 while fences stay 3 and retry is inert', () => {
  const fixture = seedAutoAppRun('transition-invalid');
  const attempt = '01JAPPTASK0000000000000000';
  const child = '01JAPPCHD00000000000000020';
  appendAnchored(fixture.root, fixture.runId, { type: 'handoff-emitted',
    data: { attempt_id: attempt, child_run_id: child } }, loop => {
    const parent = loop.session_chain.sessions[0];
    parent.superseded_by = child;
    Object.assign(loop.session_chain.lease, { state: 'releasing', handoff_phase: 'emitted',
      handoff_idempotency_key: 'a'.repeat(16), handoff_child_run_id: child,
      handoff_transport: 'codex-app', handoff_attempt_id: attempt,
      resume_policy: 'app', expires_at: '2026-07-13T00:15:00.000Z' });
    loop.session_chain.sessions.push({ run_id: child, started_at: null, ended_at: null,
      turns: 0, outcome: null, superseded_by: null, host_surface: null,
      continuation: { transport: 'codex-app', attempt_id: attempt, route: 'create',
        context_mode: 'fresh', phase: 'emitted', expected_runtime: 'codex',
        expected_host_surface: 'codex-app', target_cwd: fixture.root,
        host_task_cwd_digest: appHostTaskCwdDigest(parent.host_surface, fixture.root),
        workstream_id: null, project_id: null, descriptor_digest: null,
        emitted_at: fixture.observed, prepare_deadline: '2026-07-13T00:05:00.000Z',
        prepared_at: null, confirmation_deadline: null, confirmed_at: null,
        acquired_at: null, acquired_generation: null, thread_id: null,
        unconfirmed_thread_id: null, failure_code: null, failure_binding: null } });
  }, undefined, { nowFn: () => Date.parse(fixture.observed) });
  appendAnchored(fixture.root, fixture.runId, { type: 'app-task-abandoned', data: {
    owner_run_id: fixture.runId, generation: 1, attempt_id: attempt,
    child_run_id: child, failure_code: 'gate-budget',
  } }, loop => {
    const continuation = loop.session_chain.sessions.at(-1).continuation;
    continuation.phase = 'abandoned';
    continuation.failure_code = 'gate-budget';
    loop.status = 'paused';
    loop.pause_reason = 'operator-preserve';
    loop.session_chain.lease.resume_policy = 'human';
    loop.session_chain.lease.expires_at = null;
  }, undefined, { nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  const loop = readState(fixture.root, fixture.runId).data;
  const schema = validate(loop);
  const correlation = verifyAppEventCorrelation(loop, readLines(fixture.root, fixture.runId));
  assert.equal(schema.ok, true, schema.errors.join('; '));
  assert.equal(correlation.ok, true, correlation.errors.join('; '));
  const before = cliSnapshot(fixture.root, fixture.runId);
  assert.equal(runResult(fixture.root, ['app-task', 'revoke', '--run-id', fixture.runId,
    '--owner', '01JAPPWR0NG000000000000000', '--generation', '1',
    '--runtime', 'codex']).code, 3);
  const beforeClaude = cliSnapshot(fixture.root, fixture.runId);
  const claude = runResult(fixture.root, ['app-task', 'revoke', '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1',
    '--runtime', 'claude']);
  assert.equal(claude.code, 2);
  assert.equal((claude.stdout + claude.stderr).includes('DEEP_LOOP_STDIN_READY:'), false);
  assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), beforeClaude);
  assert.equal(runResult(fixture.root, ['app-task', 'revoke', '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1', '--runtime', 'codex']).code, 1);
  assert.deepEqual(cliSnapshot(fixture.root, fixture.runId), before);

  const retry = seedAutoAppRun('retry-inert');
  const args = ['app-task', 'revoke', '--run-id', retry.runId, '--owner', retry.runId,
    '--generation', '1', '--runtime', 'codex'];
  assert.equal(runResult(retry.root, args).code, 0);
  const revoked = cliSnapshot(retry.root, retry.runId);
  assert.equal(runResult(retry.root, args).code, 0);
  assert.deepEqual(cliSnapshot(retry.root, retry.runId), revoked);
});
function appFinishCliSeed10d() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-finish-cli-')));
  const observed = '2026-07-13T00:00:00.000Z';
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', now: new Date(observed),
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context',
      observed_at: observed }, cwdFn: () => root, appContinuationConsent: { mode: 'auto',
      authority: 'human-confirmed', confirmed_at: observed, revoked_at: null } });
  const descriptorBuilder = ({ runtime, root: projectRoot, parentRunId, childRunId }) => ({
    runtime, projectRoot, runId: parentRunId, usageOutputKind: 'json',
    resumeInvocation: childRunId, entries: Object.fromEntries(['interactive', 'headless', 'cmux',
      'iterm2', 'terminal-app', 'wt', 'powershell', 'desktop']
      .map(name => [name, { display: 'manual', unavailable: true }])) });
  emitHandoff(root, runId, { trigger: 'finish-cli', appIntent: true,
    expect: { owner: runId, generation: 1 }, cwdFn: () => root, descriptorBuilder,
    attemptIdFactory: () => '01JAPPTASK0000000000000000',
    nowFn: () => Date.parse('2026-07-13T00:00:01.000Z') });
  return { root, runId };
}

test('finish CLI requires the exact App runtime and then settles the bound attempt', () => {
  const fixture = appFinishCliSeed10d();
  const common = ['finish', '--project-root', fixture.root, '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1', '--status', 'stopped', '--confirm',
    '--proof', JSON.stringify({ human_reason: 'test' })];
  const before = structuredClone(readState(fixture.root, fixture.runId).data);
  for (const runtimeArgs of [[], ['--runtime', 'claude']]) {
    const result = spawnSync(process.execPath, [CLI, ...common, ...runtimeArgs],
      { cwd: fixture.root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /RUNTIME_FENCED/);
    assert.deepEqual(readState(fixture.root, fixture.runId).data, before);
  }
  const success = spawnSync(process.execPath, [CLI, ...common, '--runtime', 'codex'],
    { cwd: fixture.root, encoding: 'utf8', shell: false });
  assert.equal(success.status, 0, success.stderr);
  const loop = readState(fixture.root, fixture.runId).data;
  assert.equal(loop.status, 'stopped');
  assert.equal(loop.session_chain.lease.handoff_transport, null);
  assert.equal(loop.session_chain.lease.handoff_attempt_id, null);
  const terminal = spawnSync(process.execPath, [CLI, ...common, '--runtime', 'codex'],
    { cwd: fixture.root, encoding: 'utf8', shell: false });
  assert.equal(terminal.status, 1);
  assert.match(terminal.stderr, /FINISH_ALREADY_TERMINAL/);
});
test('App READY grammar is exact and purpose-separated', () => {
  assert.equal(structuredReadyToken({ purpose: 'app-prepare',
    binding: '01JAPPPAR00000000000000000.4',
    mode: 'pty-raw-noecho' }),
  'DEEP_LOOP_STDIN_READY:v1:app-prepare:01JAPPPAR00000000000000000.4:pty-raw-noecho');
  for (const purpose of ['app-confirm', 'app-fail', 'app-acquire']) {
    assert.equal(structuredReadyToken({ purpose, binding: '01JAPPTASK0000000000000000',
      mode: 'pty-raw-noecho' }),
    `DEEP_LOOP_STDIN_READY:v1:${purpose}:01JAPPTASK0000000000000000:pty-raw-noecho`);
  }
});

function appCliSeed11a() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-cli-')));
  const base = Date.now() - 60_000;
  const observed = new Date(base).toISOString();
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', now: new Date(observed),
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['list-projects', 'create-thread-local', 'structured-process-stdin'],
      structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context',
      observed_at: observed }, cwdFn: () => root, appContinuationConsent: { mode: 'auto',
      authority: 'human-confirmed', confirmed_at: observed, revoked_at: null } });
  const attemptId = '01JAPPTASK0000000000000000';
  const descriptorBuilder = ({ runtime, root: projectRoot, parentRunId, childRunId }) => ({
    runtime, projectRoot, runId: parentRunId, usageOutputKind: 'json',
    resumeInvocation: childRunId, entries: Object.fromEntries(['interactive', 'headless', 'cmux',
      'iterm2', 'terminal-app', 'wt', 'powershell', 'desktop']
      .map(name => [name, { display: 'manual', unavailable: true }])) });
  const emitted = emitHandoff(root, runId, { trigger: 'cli', appIntent: true,
    expect: { owner: runId, generation: 1 }, cwdFn: () => root, descriptorBuilder,
    attemptIdFactory: () => attemptId,
    nowFn: () => base + 1_000 });
  return { root, runId, attemptId, childRunId: emitted.childRunId, base };
}

function preparedCliSeed11a() {
  const fixture = appCliSeed11a();
  prepareAppTask(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    stdinMode: 'pipe-open-noecho', hostInput: { currentHostTaskCwd: fixture.root,
      projects: [{ projectId: 'project', projectKind: 'local', path: fixture.root }] } }, {
    cwdFn: () => fixture.root,
    nowFn: () => fixture.base + 2_000,
    descriptorBuilder: () => ({ tool: 'create_thread', target: { type: 'project',
      projectId: 'project', environment: { type: 'local' } }, prompt: 'prompt' }),
    reconcileBudgetFn: () => {}, gateFn: () => ({ ok: true, blocked_by: [] }),
  });
  return fixture;
}

function confirmedCliSeed11a() {
  const fixture = preparedCliSeed11a();
  confirmAppTask(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1,
    attemptId: fixture.attemptId, stdinMode: 'pipe-open-noecho', threadId: 'thread' },
  { cwdFn: () => fixture.root,
    nowFn: () => fixture.base + 3_000 });
  return fixture;
}

function runReady11a(fixture, args, input, expectedReady, { cwd = fixture.root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let sent = false;
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split('\n').filter(Boolean);
      const readyLines = lines.filter(line => line.startsWith('DEEP_LOOP_STDIN_READY:'));
      if (readyLines.some(line => line !== expectedReady)) {
        child.kill();
        reject(new Error(`unexpected READY: ${readyLines.join(',')}`));
        return;
      }
      if (!sent && readyLines.includes(expectedReady)) {
        sent = true;
        const payload = typeof input === 'string' ? input : JSON.stringify(input);
        child.stdin.end(`${payload}\n`);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('app-task prepare projects snake_case stdin then fails closed before Task 12 builder', async () => {
  const fixture = appCliSeed11a();
  const args = ['app-task', 'prepare', '--project-root', fixture.root, '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1', '--stdin-mode', 'pipe-open-noecho',
    '--app-host-input-stdin'];
  const ready = `DEEP_LOOP_STDIN_READY:v1:app-prepare:${fixture.runId}.1:pipe-open-noecho`;
  const result = await runReady11a(fixture, args, { host_task_cwd: fixture.root,
    projects: [{ projectId: ' p$`\\id ', projectKind: 'local', path: fixture.root }] }, ready);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split('\n')[0], ready);
  assert.match(result.stderr, /APP_DESCRIPTOR_BUILDER_REQUIRED/);
  const loop = readState(fixture.root, fixture.runId).data;
  const child = loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId);
  assert.equal(child.continuation.phase, 'emitted');
  assert.equal(readLines(fixture.root, fixture.runId)
    .filter(event => event.type === 'app-task-prepared').length, 0);
});

test('app-task prepare rejects extra top-level and project-row IDs without write or echo', async () => {
  const payloads = fixture => [
    { host_task_cwd: fixture.root, threadId: 'RAW-ROOT-THREAD' },
    { host_task_cwd: fixture.root, clientThreadId: 'RAW-ROOT-CLIENT' },
    { host_task_cwd: fixture.root, observed_at: 'RAW-ROOT-CLOCK' },
    { host_task_cwd: fixture.root, projects: [{ projectId: 'project', projectKind: 'local',
      path: fixture.root, threadId: 'RAW-ROW-THREAD' }] },
    { host_task_cwd: fixture.root, projects: [{ projectId: 'project', projectKind: 'local',
      path: fixture.root, clientThreadId: 'RAW-ROW-CLIENT' }] },
  ];
  for (let index = 0; index < 5; index += 1) {
    const fixture = appCliSeed11a();
    const payload = payloads(fixture)[index];
    const args = ['app-task', 'prepare', '--project-root', fixture.root, '--run-id', fixture.runId,
      '--owner', fixture.runId, '--generation', '1', '--stdin-mode', 'pipe-open-noecho',
      '--app-host-input-stdin'];
    const ready = `DEEP_LOOP_STDIN_READY:v1:app-prepare:${fixture.runId}.1:pipe-open-noecho`;
    const before = { state: readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
      'loop.json')), events: readLines(fixture.root, fixture.runId) };
    const result = await runReady11a(fixture, args, payload, ready);
    assert.equal(result.code, 1, `${index}: ${result.stderr}`);
    for (const sentinel of Object.values(payload).flatMap(value => typeof value === 'string'
      ? [value] : Array.isArray(value) ? value.flatMap(Object.values) : [])) {
      if (String(sentinel).startsWith('RAW-')) {
        assert.equal((result.stdout + result.stderr).includes(sentinel), false, sentinel);
      }
    }
    assert.deepEqual(readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
      'loop.json')), before.state);
    assert.deepEqual(readLines(fixture.root, fixture.runId), before.events);
  }
});

test('wrong-cwd prepare is an exit-3 authority fence with no durable change', async () => {
  const fixture = appCliSeed11a();
  const wrongCwd = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-cli-cwd-')));
  const beforeState = readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
    'loop.json'));
  const beforeEvents = readLines(fixture.root, fixture.runId);
  const args = ['app-task', 'prepare', '--project-root', fixture.root, '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1', '--stdin-mode', 'pipe-open-noecho',
    '--app-host-input-stdin'];
  const ready = `DEEP_LOOP_STDIN_READY:v1:app-prepare:${fixture.runId}.1:pipe-open-noecho`;
  const result = await runReady11a(fixture, args, { host_task_cwd: fixture.root,
    projects: [{ projectId: 'project', projectKind: 'local', path: fixture.root }] }, ready,
  { cwd: wrongCwd });
  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stderr, /APP_ROUTE_AUTHORITY_FENCED/);
  assert.deepEqual(readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
    'loop.json')), beforeState);
  assert.deepEqual(readLines(fixture.root, fixture.runId), beforeEvents);
});

test('App CLI requires explicit root/run and exposes boolean-only handoff intent', () => {
  const fixture = appCliSeed11a();
  const beforeState = readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
    'loop.json'));
  const beforeEvents = readLines(fixture.root, fixture.runId);
  const missingRun = spawnSync(process.execPath, [CLI, 'app-task', 'status',
    '--project-root', fixture.root], { encoding: 'utf8', shell: false });
  assert.equal(missingRun.status, 2);
  const invalidUlid = spawnSync(process.execPath, [CLI, 'app-task', 'status',
    '--project-root', fixture.root, '--run-id', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ'],
  { encoding: 'utf8', shell: false });
  assert.equal(invalidUlid.status, 2);
  const authority = ['--project-root', fixture.root, '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1'];
  const required = [...authority, '--reason', 'milestone', '--trigger', 'milestone'];
  const invalidHandoffs = [
    ['--app-intent', '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1'],
    ['--app-intent', '--project-root', fixture.root, '--owner', fixture.runId, '--generation', '1'],
    ['--app-intent=true', ...required],
    ['--app-intent', ...required, '--project-root', fixture.root],
    ['--app-intent', ...required, '--app-attempt', 'forbidden'],
    ['--app-intent', ...authority, '--trigger', 'milestone'],
    ['--app-intent', ...authority, '--reason', 'milestone'],
    ['--app-intent', ...authority, '--reason', 'bad\nreason', '--trigger', 'milestone'],
  ];
  for (const args of invalidHandoffs) {
    const result = spawnSync(process.execPath, [CLI, 'handoff', 'emit', ...args],
      { cwd: fixture.root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
  }
  const staleArgs = [...required];
  staleArgs[staleArgs.indexOf('--generation') + 1] = '2';
  const stale = spawnSync(process.execPath, [CLI, 'handoff', 'emit', '--app-intent',
    ...staleArgs], { cwd: fixture.root, encoding: 'utf8', shell: false });
  assert.equal(stale.status, 3, stale.stderr);
  assert.deepEqual(readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
    'loop.json')), beforeState);
  assert.deepEqual(readLines(fixture.root, fixture.runId), beforeEvents);
  const sentinel = join(fixture.root, 'SENTINEL');
  const hostile = spawnSync(process.execPath, [CLI, 'app-task', 'status', '--project-root', fixture.root,
    '--run-id', `${fixture.runId};touch ${sentinel}`], { encoding: 'utf8', shell: false });
  assert.notEqual(hostile.status, 0);
  assert.equal(existsSync(sentinel), false);
  assert.match(readFileSync(CLI, 'utf8'),
    /HANDOFF_\(\?:PHASE_FENCED\|KEY_MISMATCH\)/,
    'both final handoff CAS conflicts are exit-3 fences');
});

test('App parsers reject root aliases before state read and distinguish unresolvable roots', () => {
  const fixture = appCliSeed11a();
  const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), 'dl-app-root-alias-')));
  const link = join(aliasParent, 'project-link');
  createDirectoryJunction(fixture.root, link);
  const beforeState = readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
    'loop.json'));
  const beforeEvents = readLines(fixture.root, fixture.runId);
  const handoffTail = ['--run-id', fixture.runId, '--owner', fixture.runId,
    '--generation', '1', '--reason', 'alias', '--trigger', 'alias'];
  for (const alias of [link, `${fixture.root}/.`, `${fixture.root}/`]) {
    const status = spawnSync(process.execPath, [CLI, 'app-task', 'status',
      '--project-root', alias, '--run-id', fixture.runId],
    { cwd: fixture.root, encoding: 'utf8', shell: false });
    assert.equal(status.status, 3, status.stderr);
    assert.match(status.stderr, /PROJECT_ROOT_FENCED/);
    const handoff = spawnSync(process.execPath, [CLI, 'handoff', 'emit', '--app-intent',
      '--project-root', alias, ...handoffTail],
    { cwd: fixture.root, encoding: 'utf8', shell: false });
    assert.equal(handoff.status, 3, handoff.stderr);
    assert.match(handoff.stderr, /PROJECT_ROOT_FENCED/);
  }
  assert.deepEqual(readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId,
    'loop.json')), beforeState);
  assert.deepEqual(readLines(fixture.root, fixture.runId), beforeEvents);

  const absent = join(aliasParent, 'absent-project');
  const unresolvedStatus = spawnSync(process.execPath, [CLI, 'app-task', 'status',
    '--project-root', absent, '--run-id', fixture.runId],
  { cwd: fixture.root, encoding: 'utf8', shell: false });
  assert.equal(unresolvedStatus.status, 1, unresolvedStatus.stderr);
  assert.match(unresolvedStatus.stderr, /PROJECT_ROOT_UNRESOLVABLE/);
  const unresolvedHandoff = spawnSync(process.execPath, [CLI, 'handoff', 'emit', '--app-intent',
    '--project-root', absent, ...handoffTail],
  { cwd: fixture.root, encoding: 'utf8', shell: false });
  assert.equal(unresolvedHandoff.status, 1, unresolvedHandoff.stderr);
  assert.match(unresolvedHandoff.stderr, /PROJECT_ROOT_UNRESOLVABLE/);
});

test('confirm accepts one raw bounded receipt only after exact pipe READY', async () => {
  const fixture = preparedCliSeed11a();
  const receipt = ' opaque $`\\ receipt ';
  const ready = `DEEP_LOOP_STDIN_READY:v1:app-confirm:${fixture.attemptId}:pipe-open-noecho`;
  const result = await runReady11a(fixture, ['app-task', 'confirm',
    '--project-root', fixture.root, '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1', '--attempt', fixture.attemptId,
    '--stdin-mode', 'pipe-open-noecho', '--receipt-stdin'], receipt, ready);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], ready);
  assert.equal((result.stdout + result.stderr).includes(receipt), false);
  const continuation = readState(fixture.root, fixture.runId).data.session_chain.sessions
    .find(item => item.run_id === fixture.childRunId).continuation;
  assert.equal(continuation.phase, 'confirmed');
  assert.equal(continuation.thread_id, receipt);
});

test('confirm CLI maps a published marker with a different receipt to exit 3', async () => {
  const fixture = preparedCliSeed11a();
  const moduleUrl = new URL('../scripts/lib/app-task-continuation.mjs', import.meta.url).href;
  const crashScript = `
    import { confirmAppTask } from ${JSON.stringify(moduleUrl)};
    confirmAppTask(process.argv[1], process.argv[2], {
      owner: process.env.DEEP_LOOP_CRASH_OWNER,
      generation: Number(process.env.DEEP_LOOP_CRASH_GENERATION),
      attemptId: process.env.DEEP_LOOP_CRASH_ATTEMPT,
      stdinMode: 'pipe-open-noecho',
      threadId: 'confirmed-thread',
    }, { cwdFn: () => process.argv[1], nowFn: () => Number(process.env.DEEP_LOOP_CRASH_NOW) });
  `;
  const crashed = spawnSync(process.execPath,
    ['--input-type=module', '--eval', crashScript, fixture.root, fixture.runId], {
      cwd: fixture.root, encoding: 'utf8', shell: false, env: { ...process.env,
        DEEP_LOOP_CRASH_OWNER: fixture.runId,
        DEEP_LOOP_CRASH_GENERATION: '1',
        DEEP_LOOP_CRASH_ATTEMPT: fixture.attemptId,
        DEEP_LOOP_CRASH_NOW: String(fixture.base + 3_000),
        NODE_ENV: 'test', DEEP_LOOP_TEST_CRASH_AT: 'pending-after-rename' },
    });
  assert.equal(crashed.status, 91, crashed.stderr || crashed.stdout);
  const directory = join(fixture.root, '.deep-loop', 'runs', fixture.runId);
  rmdirSync(join(directory, '.lock'));
  const journalNames = ['.anchored-pending.json', '.anchored-events.stage',
    '.anchored-state.stage', '.anchored-hash.stage', 'event-log.jsonl', 'loop.json', '.loop.hash'];
  const pending = Object.fromEntries(journalNames.map(name =>
    [name, readFileSync(join(directory, name))]));
  const ready = `DEEP_LOOP_STDIN_READY:v1:app-confirm:${fixture.attemptId}:pipe-open-noecho`;
  const args = ['app-task', 'confirm', '--project-root', fixture.root,
    '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1',
    '--attempt', fixture.attemptId, '--stdin-mode', 'pipe-open-noecho', '--receipt-stdin'];
  const different = await runReady11a(fixture, args, 'different-thread', ready);
  assert.equal(different.code, 3, different.stderr);
  assert.match(different.stderr, /APP_RECEIPT_FENCED/);
  assert.deepEqual(Object.fromEntries(journalNames.map(name =>
    [name, readFileSync(join(directory, name))])), pending);
  const exact = await runReady11a(fixture, args, 'confirmed-thread', ready);
  assert.equal(exact.code, 0, exact.stderr);
});

test('ordinary fail has no stdin mode, receipt flag, or READY', () => {
  const fixture = preparedCliSeed11a();
  const result = spawnSync(process.execPath, [CLI, 'app-task', 'fail',
    '--project-root', fixture.root, '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1', '--attempt', fixture.attemptId,
    '--code', 'host-call-failed'], { cwd: fixture.root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('DEEP_LOOP_STDIN_READY:'), false);
  const continuation = readState(fixture.root, fixture.runId).data.session_chain.sessions
    .find(item => item.run_id === fixture.childRunId).continuation;
  assert.equal(continuation.failure_code, 'host-call-failed');
});

test('app-task revoke survives the strict dispatcher with its runtime fence', () => {
  const fixture = appCliSeed11a();
  const result = spawnSync(process.execPath, [CLI, 'app-task', 'revoke',
    '--project-root', fixture.root, '--run-id', fixture.runId,
    '--owner', fixture.runId, '--generation', '1', '--runtime', 'codex'],
  { cwd: fixture.root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  const loop = readState(fixture.root, fixture.runId).data;
  const revokedAt = loop.autonomy.app_task_continuation.revoked_at;
  assert.equal(new Date(revokedAt).toISOString(), revokedAt);
  assert.ok(Date.parse(revokedAt) >= Date.parse('2026-07-13T00:00:00.000Z'));
  assert.equal(loop.session_chain.sessions.find(item => item.run_id === fixture.childRunId)
    .continuation.failure_code, 'consent-revoked');
});

test('malformed acquire exits 1 valid authority mismatch exits 3 and terminal remains exit 1', async () => {
  const malformed = confirmedCliSeed11a();
  const ready = `DEEP_LOOP_STDIN_READY:v1:app-acquire:${malformed.attemptId}:pipe-open-noecho`;
  const malformedResult = await runReady11a(malformed, ['app-task', 'acquire',
    '--project-root', malformed.root, '--run-id', malformed.runId,
    '--owner', malformed.childRunId, '--generation', '1', '--attempt', malformed.attemptId,
    '--runtime', 'codex', '--stdin-mode', 'pipe-open-noecho', '--observation-stdin'], {}, ready);
  assert.equal(malformedResult.code, 1);
  assert.match(malformedResult.stderr, /APP_CHILD_OBSERVATION_INVALID/);

  const authorityResult = await runReady11a(malformed, ['app-task', 'acquire',
    '--project-root', malformed.root, '--run-id', malformed.runId,
    '--owner', malformed.childRunId, '--generation', '1', '--attempt', malformed.attemptId,
    '--runtime', 'codex', '--stdin-mode', 'pipe-open-noecho', '--observation-stdin'], {
      kind: 'codex-app', source: 'terminal-app', capabilities: ['structured-process-stdin'],
      structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: malformed.root,
      host_task_cwd_source: 'app-task-context',
    }, ready);
  assert.equal(authorityResult.code, 3);
  assert.match(authorityResult.stderr, /APP_CHILD_OBSERVATION_FENCED/);

  const terminal = appCliSeed11a();
  finish11a(terminal.root, terminal.runId, { status: 'stopped', confirm: true,
    proof: { human_reason: 'test' },
    fence: { owner: terminal.runId, generation: 1, runtime: 'codex', intent: 'business' },
    now: Date.parse('2026-07-13T00:00:02.000Z') });
  const terminalResult = spawnSync(process.execPath, [CLI, 'app-task', 'revoke',
    '--project-root', terminal.root, '--run-id', terminal.runId,
    '--owner', terminal.runId, '--generation', '1', '--runtime', 'codex'],
  { cwd: terminal.root, encoding: 'utf8', shell: false });
  assert.equal(terminalResult.status, 1);
  assert.match(terminalResult.stderr, /APP_TASK_TERMINAL/);
  const terminalHandoff = spawnSync(process.execPath, [CLI, 'handoff', 'emit', '--app-intent',
    '--project-root', terminal.root, '--run-id', terminal.runId,
    '--owner', terminal.runId, '--generation', '1', '--reason', 'terminal',
    '--trigger', 'terminal'],
  { cwd: terminal.root, encoding: 'utf8', shell: false });
  assert.equal(terminalHandoff.status, 1);
  assert.match(terminalHandoff.stderr, /RUN_TERMINAL/);

  const beforeTerminalFences = {
    state: readFileSync(join(terminal.root, '.deep-loop', 'runs', terminal.runId, 'loop.json')),
    events: readLines(terminal.root, terminal.runId),
  };
  const staleTerminalHandoff = spawnSync(process.execPath,
    [CLI, 'handoff', 'emit', '--app-intent', '--project-root', terminal.root,
      '--run-id', terminal.runId, '--owner', terminal.runId, '--generation', '2',
      '--reason', 'terminal-stale', '--trigger', 'terminal-stale'],
    { cwd: terminal.root, encoding: 'utf8', shell: false });
  assert.equal(staleTerminalHandoff.status, 3, staleTerminalHandoff.stderr);
  assert.match(staleTerminalHandoff.stderr, /LEASE_FENCED/);

  const acquireReady = `DEEP_LOOP_STDIN_READY:v1:app-acquire:${terminal.attemptId}:pipe-open-noecho`;
  const wrongChild = await runReady11a(terminal, ['app-task', 'acquire',
    '--project-root', terminal.root, '--run-id', terminal.runId,
    '--owner', '01JAPPWR0NG000000000000000', '--generation', '1',
    '--attempt', terminal.attemptId, '--runtime', 'codex',
    '--stdin-mode', 'pipe-open-noecho', '--observation-stdin'], {
      kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['structured-process-stdin'], structured_stdin_mode: 'pipe-open-noecho',
      host_task_cwd: terminal.root, host_task_cwd_source: 'app-task-context',
    }, acquireReady);
  assert.equal(wrongChild.code, 3, wrongChild.stderr);
  assert.match(wrongChild.stderr, /APP_ATTEMPT_FENCED/);
  assert.deepEqual(readFileSync(join(terminal.root, '.deep-loop', 'runs', terminal.runId,
    'loop.json')), beforeTerminalFences.state);
  assert.deepEqual(readLines(terminal.root, terminal.runId), beforeTerminalFences.events);
});

test('receipt reader rejects over-513-byte or multi-line input without echo', async () => {
  for (const receipt of ['x'.repeat(513), 'first\nsecond']) {
    const fixture = preparedCliSeed11a();
    const ready = `DEEP_LOOP_STDIN_READY:v1:app-confirm:${fixture.attemptId}:pipe-open-noecho`;
    const result = await runReady11a(fixture, ['app-task', 'confirm',
      '--project-root', fixture.root, '--run-id', fixture.runId,
      '--owner', fixture.runId, '--generation', '1', '--attempt', fixture.attemptId,
      '--stdin-mode', 'pipe-open-noecho', '--receipt-stdin'], receipt, ready);
    assert.equal(result.code, 1);
    assert.equal((result.stdout + result.stderr).includes(receipt), false);
    assert.equal(readState(fixture.root, fixture.runId).data.session_chain.sessions
      .find(item => item.run_id === fixture.childRunId).continuation.phase, 'prepared');
  }
});

test('every App syntax error exits 2 before state read or READY', () => {
  const root = join(tmpdir(), 'definitely-absent-app-cli-root');
  const cases = [
    ['status', '--project-root', root],
    ['status', '--project-root', root, '--project-root', root, '--run-id', 'RUN'],
    ['status', '--project-root', root, '--run-id', 'RUN', 'positional'],
    ['prepare', '--project-root', root, '--run-id', 'RUN', '--owner', 'P',
      '--generation', '1', '--stdin-mode', 'pipe-open-noecho'],
    ['revoke', '--project-root', root, '--run-id', 'RUN', '--owner', 'P',
      '--generation', '1'],
    ['fail', '--project-root', root, '--run-id', 'RUN', '--owner', 'P', '--generation', '1',
      '--attempt', '01JAPPTASK0000000000000000', '--code', 'host-call-failed',
      '--stdin-mode', 'pipe-open-noecho', '--receipt-stdin'],
    ['confirm', '--project-root', root, '--run-id', 'RUN', '--owner', 'P', '--generation', '0',
      '--attempt', 'bad', '--stdin-mode', 'pipe-open-noecho', '--receipt-stdin'],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [CLI, 'app-task', ...args],
      { encoding: 'utf8', shell: false });
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.equal(result.stdout.includes('DEEP_LOOP_STDIN_READY:'), false);
  }
});
