import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { buildRuntimeResumeDescriptor } from '../scripts/lib/runtime-descriptor.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { respawn as respawnImpl } from '../scripts/lib/respawn.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';

const NOW0 = new Date('2026-06-24T00:00:00Z');
const NOW1 = Date.parse('2026-06-24T01:00:00Z');
const noOpRun = () => ({ code: 1 });
const noSleep = () => {};
const POSIX_FIXTURE_ROOT = '/tmp/deep-loop-posix-fixture';

function targetPosixRoot(root) {
  return process.platform === 'win32' ? POSIX_FIXTURE_ROOT : root;
}

function buildPosixDescriptor(options) {
  return buildRuntimeResumeDescriptor({ ...options, root: targetPosixRoot(options.root) });
}

function respawn(root, runId, options = {}) {
  const normalized = { ...options };
  if (normalized.expect == null) {
    const lease = readState(root, runId).data.session_chain.lease;
    normalized.expect = { owner: lease.owner_run_id, generation: lease.generation };
  }
  return respawnImpl(root, runId, {
    ...normalized,
    launchCommandBuilder: normalized.launchCommandBuilder
      ?? (descriptorOptions => buildPosixDescriptor(descriptorOptions).entries),
  });
}

function runtimeIdentity({
  platform = 'linux',
  canonicalPath = '/opt/openai/codex',
  sha256 = 'a'.repeat(64),
} = {}) {
  return {
    runtime: 'codex',
    canonical_path: canonicalPath,
    sha256,
    version: '0.144.1',
    platform,
    arch: 'x64',
    source: 'human-explicit',
    package: null,
    authenticode: null,
    approved_by: 'human',
    approved_at: '2026-06-24T00:00:00.000Z',
  };
}

function seedVisible({ approval, launcher = 'cmux', platform = 'linux' } = {}) {
  const effectiveApproval = approval === undefined ? runtimeIdentity({ platform }) : approval;
  const root = mkdtempSync(join(tmpdir(), 'dl-posix-codex-'));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', now: NOW0, env: {}, platform, run: noOpRun,
  });
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'visible';
  data.autonomy.runtime_executable_approval = effectiveApproval;
  const apple = launcher === 'iterm2' ? 'iTerm' : 'Terminal';
  data.session_spawn = {
    platform,
    launcher,
    launcher_bin: launcher === 'cmux' ? '/opt/cmux/bin/cmux' : '/usr/bin/osascript',
    launcher_socket: launcher === 'cmux' ? '/tmp/cmux.sock' : null,
    surface: launcher === 'cmux' ? 'workspace' : 'window',
    reachable: true,
    visible: true,
    signals: {},
    probe: launcher === 'cmux'
      ? { cmd: ['/opt/cmux/bin/cmux', '--socket', '/tmp/cmux.sock', 'ping'], code: 0 }
      : { cmd: ['/usr/bin/osascript', '-e', `id of application "${apple}"`], code: 0 },
    reason: null,
    fallback: 'launch-command-file',
    detected_at: '2026-06-24T00:00:00Z',
  };
  writeState(root, runId, data);
  return { root, runId, approval: effectiveApproval };
}

function emitVisible(root, runId, { platform = 'linux' } = {}) {
  return emitHandoff(root, runId, {
    trigger: 'posix-visible',
    now: NOW1,
    expect: { owner: runId, generation: 1 },
    platform,
    deepLoopRoot: '/opt/deep-loop',
    exists: path => path === '/usr/bin/osascript',
    descriptorBuilder: buildPosixDescriptor,
  });
}

test('Linux Codex descriptor uses explicit POSIX path semantics for every resume path', () => {
  const root = "/tmp/project O'Brien";
  const descriptor = buildRuntimeResumeDescriptor({
    runtime: 'codex',
    platform: 'linux',
    root,
    parentRunId: 'PARENT',
    childRunId: 'CHILD',
    handoffRel: 'handoffs/next.md',
    launcher: 'cmux',
    launcherBin: '/opt/cmux/bin/cmux',
    launcherSocket: '/tmp/cmux.sock',
    runtimeExecutableIdentity: runtimeIdentity(),
    deepLoopRoot: '/opt/deep-loop',
    model: 'gpt-5.6',
    effort: 'xhigh',
  });
  const handoffPath = "/tmp/project O'Brien/.deep-loop/runs/PARENT/handoffs/next.md";
  const skillPath = '/opt/deep-loop/skills/deep-loop-resume/SKILL.md';

  assert.ok(descriptor.resumePrompt.includes(JSON.stringify(handoffPath)));
  assert.ok(descriptor.entries.headless.stdin.includes(JSON.stringify(handoffPath)));
  assert.ok(descriptor.entries.headless.stdin.includes(JSON.stringify(skillPath)));
  assert.equal(descriptor.entries.headless.stdin.includes('\\tmp\\project'), false);
  assert.equal(descriptor.entries.headless.stdin.includes('\\opt\\deep-loop'), false);
  assert.equal(descriptor.entries.headless.bin, '/opt/openai/codex');

  const cmux = descriptor.entries.cmux;
  assert.equal(cmux.bin, '/opt/cmux/bin/cmux');
  assert.equal(cmux.shell, false);
  assert.deepEqual(cmux.argv.slice(0, 4), ['--socket', '/tmp/cmux.sock', 'new-workspace', '--cwd']);
  const command = cmux.argv[cmux.argv.indexOf('--command') + 1];
  const manualPrompt = `Read ${JSON.stringify(handoffPath)} first; then run $deep-loop:deep-loop-resume --project-root ${JSON.stringify(root)} --run-id ${JSON.stringify('PARENT')}`;
  const q = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  assert.equal(command, [
    '/opt/openai/codex', '-C', root,
    '--model', 'gpt-5.6', '-c', 'model_reasoning_effort="xhigh"', manualPrompt,
  ].map(q).join(' '));
  assert.equal(command.includes('claude'), false);
});

test('target platform rejects roots from a different path namespace', () => {
  assert.throws(
    () => buildRuntimeResumeDescriptor({
      runtime: 'codex',
      platform: 'linux',
      root: 'C:\\repo',
      parentRunId: 'PARENT',
      childRunId: 'CHILD',
      handoffRel: 'handoffs/next.md',
      runtimeExecutableIdentity: runtimeIdentity(),
      deepLoopRoot: '/opt/deep-loop',
    }),
    /INVALID_TARGET_PATH/,
  );

  const win32Options = {
    runtime: 'codex',
    platform: 'win32',
    parentRunId: 'PARENT',
    childRunId: 'CHILD',
    handoffRel: 'handoffs/next.md',
    runtimeExecutableIdentity: runtimeIdentity({
      platform: 'win32', canonicalPath: 'C:\\Runtime\\codex.exe',
    }),
    deepLoopRoot: 'C:\\Deep Loop',
  };
  for (const root of [
    '/tmp/project', '\\tmp\\project', 'C:relative-project',
    '\\\\?\\C:\\project', '\\\\.\\C:\\project', '\\\\server',
  ]) {
    assert.throws(
      () => buildRuntimeResumeDescriptor({ ...win32Options, root }),
      /INVALID_TARGET_PATH/,
      root,
    );
  }
});

test('win32 target accepts only fully qualified drive or UNC project roots', () => {
  const common = {
    runtime: 'codex',
    platform: 'win32',
    parentRunId: 'PARENT',
    childRunId: 'CHILD',
    handoffRel: 'handoffs/next.md',
    runtimeExecutableIdentity: runtimeIdentity({
      platform: 'win32', canonicalPath: 'C:\\Runtime\\codex.exe',
    }),
    deepLoopRoot: 'C:\\Deep Loop',
  };
  for (const root of ['C:\\repo', 'C:/repo', '\\\\server\\share\\repo', '//server/share/repo']) {
    const descriptor = buildRuntimeResumeDescriptor({ ...common, root });
    assert.equal(descriptor.projectRoot, root);
    assert.equal(descriptor.entries.headless.unavailable, undefined, root);
    assert.ok(descriptor.entries.headless.argv.includes(root), `${root}: exact -C root`);
    assert.ok(
      descriptor.entries.headless.stdin.includes(JSON.stringify(
        win32.join(root, '.deep-loop', 'runs', 'PARENT', 'handoffs/next.md'),
      )),
      `${root}: target-namespace handoff path`,
    );
  }
});

test('Darwin Codex descriptor activates exact osascript launchers and Linux does not', () => {
  const common = {
    runtime: 'codex',
    root: '/tmp/project with space',
    parentRunId: 'PARENT',
    childRunId: 'CHILD',
    handoffRel: 'handoffs/next.md',
    runtimeExecutableIdentity: runtimeIdentity({
      platform: 'darwin', canonicalPath: '/Applications/Codex Tools/codex',
    }),
    deepLoopRoot: '/Applications/deep-loop',
    model: 'gpt-5.6',
    effort: 'xhigh',
    exists: path => path === '/usr/bin/osascript',
  };
  for (const name of ['iterm2', 'terminal-app']) {
    const darwin = buildRuntimeResumeDescriptor({ ...common, platform: 'darwin', launcher: name });
    const entry = darwin.entries[name];
    assert.equal(entry.bin, '/usr/bin/osascript', name);
    assert.equal(entry.shell, false, name);
    assert.equal(entry.argv[0], '-e', name);
    assert.ok(entry.argv[1].includes("'/Applications/Codex Tools/codex'"), name);
    assert.ok(entry.argv[1].includes('$deep-loop:deep-loop-resume'), name);
    assert.equal(entry.argv[1].includes(' claude '), false, name);
    const other = name === 'iterm2' ? 'terminal-app' : 'iterm2';
    assert.equal(darwin.entries[other].unavailable, true, `${other} was not positively detected`);
  }

  const linux = buildRuntimeResumeDescriptor({
    ...common,
    platform: 'linux',
    runtimeExecutableIdentity: runtimeIdentity(),
    deepLoopRoot: '/opt/deep-loop',
  });
  assert.equal(linux.entries.iterm2.unavailable, true);
  assert.equal(linux.entries['terminal-app'].unavailable, true);

  const unsupported = buildRuntimeResumeDescriptor({
    ...common,
    platform: 'freebsd',
    launcher: 'cmux',
    launcherBin: '/opt/cmux/bin/cmux',
    launcherSocket: '/tmp/cmux.sock',
    runtimeExecutableIdentity: runtimeIdentity({ platform: 'freebsd' }),
    deepLoopRoot: '/opt/deep-loop',
  });
  assert.equal(unsupported.entries.cmux.unavailable, true);
});

test('identity-less or target-mismatched executables never activate POSIX Codex visible entries', () => {
  const common = {
    runtime: 'codex', platform: 'linux', root: '/repo', parentRunId: 'PARENT', childRunId: 'CHILD',
    handoffRel: 'handoffs/next.md', launcher: 'cmux', launcherBin: '/opt/cmux/bin/cmux',
    launcherSocket: '/tmp/cmux.sock', deepLoopRoot: '/opt/deep-loop',
  };
  const identityLess = buildRuntimeResumeDescriptor({
    ...common, codexExecutable: '/opt/unapproved/codex',
  });
  assert.equal(identityLess.entries.headless.bin, '/opt/unapproved/codex');
  assert.equal(identityLess.entries.cmux.unavailable, true);

  const wrongPlatform = buildRuntimeResumeDescriptor({
    ...common,
    runtimeExecutableIdentity: runtimeIdentity({ platform: 'darwin' }),
  });
  assert.equal(wrongPlatform.entries.headless.unavailable, true);
  assert.equal(wrongPlatform.entries.cmux.unavailable, true);
});

test('POSIX Codex headless respawn sends exact target-platform paths to the process', () => {
  const { root, runId } = seedVisible({ approval: null });
  const { data } = readState(root, runId);
  data.autonomy.spawn_style = 'headless';
  writeState(root, runId, data);
  const handoff = emitVisible(root, runId);
  let captured = null;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    headless: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    codexExecutable: '/opt/openai/codex',
    deepLoopRoot: '/opt/deep-loop',
    spawnFn: entry => { captured = entry; return { ok: true }; },
  });
  const canonicalRoot = targetPosixRoot(readState(root, runId).data.project.root);
  const expectedHandoff = posix.join(canonicalRoot, '.deep-loop', 'runs', runId, handoff.handoffRel);
  const expectedSkill = '/opt/deep-loop/skills/deep-loop-resume/SKILL.md';
  const expectedPrompt = `Read ${JSON.stringify(expectedHandoff)} first. Then read ${JSON.stringify(expectedSkill)} and execute that workflow inline for project root ${JSON.stringify(canonicalRoot)} and run id ${JSON.stringify(runId)}.`;

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'spawned');
  assert.equal(captured.stdin, expectedPrompt);
  assert.equal(captured.stdin.includes('\\opt\\deep-loop'), false);
  assert.equal(captured.stdin.includes('\\.deep-loop\\runs'), false);
});

test('approved POSIX Codex visible respawn binds the exact runtime through three revalidations', () => {
  const { root, runId, approval } = seedVisible();
  const handoff = emitVisible(root, runId);
  let runtimeChecks = 0;
  let captured = null;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: identity => {
      runtimeChecks += 1;
      assert.deepEqual(identity, approval);
      return identity;
    },
    spawnFn: entry => { captured = entry; return { ok: true }; },
    pollLease: () => ({
      state: 'active', handoff_phase: 'acquired', owner_run_id: handoff.childRunId, generation: 2,
    }),
    sleep: noSleep,
  });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'spawned');
  assert.equal(runtimeChecks, 3, 'initial, pre-CAS, and post-CAS runtime checks are mandatory');
  assert.equal(captured.bin, '/opt/cmux/bin/cmux');
  const command = captured.argv[captured.argv.indexOf('--command') + 1];
  assert.ok(command.includes("'/opt/openai/codex'"));
  assert.equal(command.includes('claude'), false);

  const launch = readFileSync(join(runDir(root, runId), 'terminal', 'launch-command.txt'), 'utf8');
  assert.ok(launch.includes('/opt/openai/codex'));
  assert.ok(launch.includes('/opt/cmux/bin/cmux'));
});

test('approved Darwin Codex visible respawn reaches only the positively detected Apple launcher', () => {
  for (const launcher of ['iterm2', 'terminal-app']) {
    const { root, runId, approval } = seedVisible({ platform: 'darwin', launcher });
    const handoff = emitVisible(root, runId, { platform: 'darwin' });
    let runtimeChecks = 0;
    let captured = null;
    const result = respawn(root, runId, {
      childRunId: handoff.childRunId,
      key: handoff.key,
      handoffRel: handoff.handoffRel,
      attended: true,
      env: {},
      now: NOW1,
      platform: 'darwin',
      deepLoopRoot: '/opt/deep-loop',
      descriptorExists: path => path === '/usr/bin/osascript',
      revalidateRuntimeExecutable: identity => { runtimeChecks += 1; assert.deepEqual(identity, approval); return identity; },
      spawnFn: entry => { captured = entry; return { ok: true }; },
      pollLease: () => ({
        state: 'active', handoff_phase: 'acquired', owner_run_id: handoff.childRunId, generation: 2,
      }),
      sleep: noSleep,
    });

    assert.equal(result.ok, true, launcher);
    assert.equal(result.outcome, 'spawned', launcher);
    assert.equal(runtimeChecks, 3, launcher);
    assert.equal(captured.bin, '/usr/bin/osascript', launcher);
    assert.equal(captured.shell, false, launcher);
    assert.ok(captured.argv[1].includes("'/opt/openai/codex'"), launcher);
  }
});

test('unsupported POSIX-like platforms never enter Codex visible runtime authority or spawn', () => {
  const { root, runId } = seedVisible({ platform: 'freebsd' });
  const handoff = emitVisible(root, runId, { platform: 'freebsd' });
  let runtimeChecks = 0;
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'freebsd',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: identity => { runtimeChecks += 1; return identity; },
    spawnFn: () => { spawned += 1; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(runtimeChecks, 0);
  assert.equal(spawned, 0);
  assert.equal(result.outcome, 'no-launcher');
  assert.equal(result.reason, 'codex-transport-not-activated');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('POSIX Codex visible respawn without durable runtime approval preserves before CAS', () => {
  const { root, runId } = seedVisible({ approval: null });
  const handoff = emitVisible(root, runId);
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: () => { throw new Error('missing'); },
    spawnFn: () => { spawned += 1; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'no-launcher');
  assert.equal(result.reason, 'runtime-identity-unavailable');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('POSIX Codex visible respawn requires the launcher-specific positive surface', () => {
  const { root, runId, approval } = seedVisible();
  const { data } = readState(root, runId);
  data.session_spawn.surface = 'tab';
  writeState(root, runId, data);
  const handoff = emitVisible(root, runId);
  let runtimeChecks = 0;
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: identity => { runtimeChecks += 1; assert.deepEqual(identity, approval); return identity; },
    spawnFn: () => { spawned += 1; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(runtimeChecks, 1);
  assert.equal(spawned, 0);
  assert.equal(result.outcome, 'no-launcher');
  assert.equal(result.reason, 'launcher-identity-unavailable');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('POSIX Codex visible respawn catches runtime approval replacement before CAS', () => {
  const { root, runId, approval } = seedVisible();
  const handoff = emitVisible(root, runId);
  const replacement = runtimeIdentity({
    canonicalPath: '/opt/openai/codex-v2', sha256: 'b'.repeat(64),
  });
  let runtimeChecks = 0;
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: identity => {
      runtimeChecks += 1;
      assert.deepEqual(identity, approval);
      if (runtimeChecks === 1) {
        const { data } = readState(root, runId);
        data.autonomy.runtime_executable_approval = replacement;
        writeState(root, runId, data);
      }
      return identity;
    },
    spawnFn: () => { spawned += 1; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(runtimeChecks, 1);
  assert.equal(result.outcome, 'no-launcher');
  assert.equal(result.reason, 'runtime-identity-drift');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('POSIX Codex visible respawn catches runtime approval replacement after CAS', () => {
  const { root, runId, approval } = seedVisible();
  const handoff = emitVisible(root, runId);
  const replacement = runtimeIdentity({
    canonicalPath: '/opt/openai/codex-v2', sha256: 'b'.repeat(64),
  });
  let runtimeChecks = 0;
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: identity => {
      runtimeChecks += 1;
      assert.deepEqual(identity, approval);
      if (runtimeChecks === 2) {
        const { data } = readState(root, runId);
        data.autonomy.runtime_executable_approval = replacement;
        writeState(root, runId, data);
      }
      return identity;
    },
    spawnFn: () => { spawned += 1; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(runtimeChecks, 2, 'fresh durable approval mismatch is rejected before a third executable probe');
  assert.equal(result.outcome, 'failed_launch');
  assert.equal(result.reason, 'runtime-identity-drift');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === handoff.childRunId).outcome, 'failed_launch');
});

test('POSIX Codex visible respawn binds the detected launcher snapshot before CAS', () => {
  const { root, runId, approval } = seedVisible();
  const handoff = emitVisible(root, runId);
  let runtimeChecks = 0;
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: identity => {
      runtimeChecks += 1;
      assert.deepEqual(identity, approval);
      if (runtimeChecks === 1) {
        const { data } = readState(root, runId);
        data.session_spawn.launcher_socket = '/tmp/replaced.sock';
        writeState(root, runId, data);
      }
      return identity;
    },
    spawnFn: () => { spawned += 1; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(result.outcome, 'no-launcher');
  assert.equal(result.reason, 'launcher-identity-drift');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'emitted');
});

test('POSIX Codex visible respawn binds the detected launcher snapshot after CAS', () => {
  const { root, runId, approval } = seedVisible();
  const handoff = emitVisible(root, runId);
  let runtimeChecks = 0;
  let spawned = 0;
  const result = respawn(root, runId, {
    childRunId: handoff.childRunId,
    key: handoff.key,
    handoffRel: handoff.handoffRel,
    attended: true,
    env: {},
    now: NOW1,
    platform: 'linux',
    deepLoopRoot: '/opt/deep-loop',
    revalidateRuntimeExecutable: identity => {
      runtimeChecks += 1;
      assert.deepEqual(identity, approval);
      if (runtimeChecks === 2) {
        const { data } = readState(root, runId);
        data.session_spawn.launcher_socket = '/tmp/replaced.sock';
        data.session_spawn.probe = {
          cmd: ['/opt/cmux/bin/cmux', '--socket', '/tmp/replaced.sock', 'ping'], code: 0,
        };
        writeState(root, runId, data);
      }
      return identity;
    },
    spawnFn: () => { spawned += 1; return { ok: true }; },
    sleep: noSleep,
  });

  assert.equal(spawned, 0);
  assert.equal(runtimeChecks, 3, 'post-CAS runtime validation precedes launcher snapshot validation');
  assert.equal(result.outcome, 'failed_launch');
  assert.equal(result.reason, 'launcher-identity-drift');
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === handoff.childRunId).outcome, 'failed_launch');
});
