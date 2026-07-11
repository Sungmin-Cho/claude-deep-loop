import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  collectRuntimeExecutableCandidates,
  approveRuntimeExecutable,
  diagnoseRuntimeExecutable,
  resolveAuthenticatedCodexHome,
  resolveTrustedRuntimeExecutable,
  revalidateTrustedRuntimeExecutable,
} from '../scripts/lib/runtime-executable.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';

const TARGETS = Object.freeze({
  'darwin:arm64': {
    alias: '@openai/codex-darwin-arm64',
    suffix: 'darwin-arm64',
    triple: 'aarch64-apple-darwin',
  },
  'darwin:x64': {
    alias: '@openai/codex-darwin-x64',
    suffix: 'darwin-x64',
    triple: 'x86_64-apple-darwin',
  },
  'linux:arm64': {
    alias: '@openai/codex-linux-arm64',
    suffix: 'linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
  },
  'linux:x64': {
    alias: '@openai/codex-linux-x64',
    suffix: 'linux-x64',
    triple: 'x86_64-unknown-linux-musl',
  },
  'win32:x64': {
    alias: '@openai/codex-win32-x64',
    suffix: 'win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    executable: 'codex.exe',
  },
  'win32:arm64': {
    alias: '@openai/codex-win32-arm64',
    suffix: 'win32-arm64',
    triple: 'aarch64-pc-windows-msvc',
    executable: 'codex.exe',
  },
});

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function officialCodexFixture({ platform = 'darwin', arch = 'arm64', version = '0.144.1' } = {}) {
  const target = TARGETS[`${platform}:${arch}`];
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-runtime-executable-')));
  const wrapperRoot = join(root, 'node_modules', '@openai', 'codex');
  const wrapper = join(wrapperRoot, 'bin', 'codex.js');
  const optionalRoot = join(wrapperRoot, 'node_modules', ...target.alias.split('/'));
  const native = join(optionalRoot, 'vendor', target.triple, 'bin', target.executable || 'codex');
  const optionalSpec = `npm:@openai/codex@${version}-${target.suffix}`;

  json(join(wrapperRoot, 'package.json'), {
    name: '@openai/codex',
    version,
    bin: { codex: 'bin/codex.js' },
    optionalDependencies: { [target.alias]: optionalSpec },
  });
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, '#!/usr/bin/env node\n');
  json(join(optionalRoot, 'package.json'), {
    name: '@openai/codex',
    version: `${version}-${target.suffix}`,
    os: [platform],
    cpu: [arch],
  });
  mkdirSync(dirname(native), { recursive: true });
  writeFileSync(native, `native-${platform}-${arch}-${version}`);
  chmodSync(native, 0o755);

  const calls = [];
  const runVersion = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: 0, signal: null, stdout: `codex-cli ${version}\n`, stderr: '' };
  };
  return { root, wrapperRoot, wrapper, optionalRoot, native, platform, arch, version, target, calls, runVersion };
}

function resolveFixture(fixture, extra = {}) {
  return resolveTrustedRuntimeExecutable('codex', {
    candidatePaths: [fixture.wrapper],
    platform: fixture.platform,
    arch: fixture.arch,
    runVersion: fixture.runVersion,
    ...extra,
  });
}

test('collectRuntimeExecutableCandidates ignores cwd/relative PATH shadows and keeps absolute candidates only', () => {
  const fixture = officialCodexFixture();
  const cwd = mkdtempSync(join(tmpdir(), 'dl-runtime-shadow-cwd-'));
  writeFileSync(join(cwd, 'codex'), 'shadow');
  const absoluteBin = mkdtempSync(join(tmpdir(), 'dl-runtime-shadow-path-'));
  symlinkSync(fixture.wrapper, join(absoluteBin, 'codex'));

  const candidates = collectRuntimeExecutableCandidates('codex', {
    env: { PATH: `${join(cwd, 'relative-bin')}::${absoluteBin}` },
    cwd,
    platform: 'darwin',
  });

  assert.deepEqual(candidates.map(candidate => candidate.path), [join(absoluteBin, 'codex')]);
  assert.ok(candidates.every(candidate => candidate.source === 'path-search'));
  assert.ok(!candidates.some(candidate => candidate.path === join(cwd, 'codex')));
  assert.throws(
    () => collectRuntimeExecutableCandidates('codex', { explicitPath: './codex', cwd, platform: 'darwin' }),
    /RUNTIME_EXECUTABLE_PATH_INVALID/,
  );
});

for (const [key, target] of Object.entries(TARGETS)) {
  const [platform, arch] = key.split(':');
  test(`official Codex ${platform}/${arch} wrapper metadata resolves to its native optional-package binary`, () => {
    const fixture = officialCodexFixture({ platform, arch });
    const identity = resolveFixture(fixture);

    assert.equal(identity.runtime, 'codex');
    assert.equal(identity.canonical_path, fixture.native);
    assert.match(identity.sha256, /^[0-9a-f]{64}$/);
    assert.equal(identity.version, fixture.version);
    assert.equal(identity.platform, platform);
    assert.equal(identity.arch, arch);
    assert.equal(identity.source, 'official-npm-native');
    assert.equal(identity.authenticode, null);
    assert.deepEqual(identity.package, {
      wrapper_path: fixture.wrapper,
      wrapper_name: '@openai/codex',
      wrapper_version: fixture.version,
      optional_name: target.alias,
      optional_spec: `npm:@openai/codex@${fixture.version}-${target.suffix}`,
      native_name: '@openai/codex',
      native_version: `${fixture.version}-${target.suffix}`,
      target_triple: target.triple,
      os: [platform],
      cpu: [arch],
    });

    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].bin, fixture.native, 'the JavaScript wrapper must never execute');
    assert.deepEqual(fixture.calls[0].argv, ['--version']);
    assert.equal(fixture.calls[0].options.shell, false);
    assert.ok(fixture.calls[0].options.timeout > 0 && fixture.calls[0].options.timeout <= 5_000);
    assert.ok(fixture.calls[0].options.maxBuffer > 0 && fixture.calls[0].options.maxBuffer <= 64 * 1024);
    assert.deepEqual(fixture.calls[0].options.env, {}, 'the version probe must not inherit ambient secrets or PATH');
  });
}

test('resolver skips a PATH/cwd shadow and does not trust discovery ordering', () => {
  const fixture = officialCodexFixture();
  const shadowDir = mkdtempSync(join(tmpdir(), 'dl-runtime-shadow-'));
  const shadow = join(shadowDir, 'codex');
  writeFileSync(shadow, 'fake native');
  chmodSync(shadow, 0o755);

  const identity = resolveTrustedRuntimeExecutable('codex', {
    candidatePaths: [shadow, fixture.wrapper],
    platform: fixture.platform,
    arch: fixture.arch,
    runVersion: fixture.runVersion,
  });
  assert.equal(identity.canonical_path, fixture.native);
  assert.equal(fixture.calls.length, 1);

  assert.throws(
    () => resolveTrustedRuntimeExecutable('codex', {
      candidatePaths: [shadow], platform: fixture.platform, arch: fixture.arch, runVersion: fixture.runVersion,
    }),
    /RUNTIME_EXECUTABLE_UNTRUSTED/,
  );
  assert.equal(fixture.calls.length, 1, 'an untrusted shadow must never be executed for a version probe');
});

test('Windows npm shim is locator-only: resolver derives and executes only wrapper-adjacent codex.exe', () => {
  const fixture = officialCodexFixture({ platform: 'win32', arch: 'x64' });
  const shim = join(fixture.root, 'codex.cmd');
  writeFileSync(shim, '@echo off\r\nnode node_modules\\@openai\\codex\\bin\\codex.js %*\r\n');

  const identity = resolveTrustedRuntimeExecutable('codex', {
    candidatePaths: [shim], platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
  });

  assert.equal(identity.canonical_path, fixture.native);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].bin, fixture.native);
  assert.notEqual(fixture.calls[0].bin, shim, 'the cmd shim is never executed');
  assert.equal(fixture.calls[0].options.shell, false);
});

test('Windows candidate collection uses semicolon PATH and collects shims only as absolute candidates', () => {
  const first = realpathSync(mkdtempSync(join(tmpdir(), 'dl-win-path-a-')));
  const second = realpathSync(mkdtempSync(join(tmpdir(), 'dl-win-path-b-')));
  writeFileSync(join(first, 'codex.cmd'), 'shim');
  writeFileSync(join(second, 'codex.exe'), 'shadow');

  const candidates = collectRuntimeExecutableCandidates('codex', {
    platform: 'win32', env: { Path: `relative;;${first};${second}` },
  });

  assert.deepEqual(candidates.map(candidate => candidate.path), [join(first, 'codex.cmd'), join(second, 'codex.exe')]);
  assert.ok(candidates.every(candidate => candidate.source === 'path-search'));
});

test('multiple distinct verified Windows npm installations are ambiguous regardless of candidate ordering', () => {
  const a = officialCodexFixture({ platform: 'win32', arch: 'arm64' });
  const b = officialCodexFixture({ platform: 'win32', arch: 'arm64' });
  const runVersion = (bin, argv, options) => {
    assert.deepEqual(argv, ['--version']);
    assert.equal(options.shell, false);
    return { status: 0, signal: null, stdout: `codex-cli ${a.version}\n`, stderr: '' };
  };
  assert.throws(
    () => resolveTrustedRuntimeExecutable('codex', {
      candidatePaths: [b.wrapper, a.wrapper], platform: 'win32', arch: 'arm64', runVersion,
    }),
    /RUNTIME_EXECUTABLE_AMBIGUOUS/,
  );
});

test('Windows Authenticode observation is normalized and an explicit signer/thumbprint policy is enforced', () => {
  const fixture = officialCodexFixture({ platform: 'win32', arch: 'x64' });
  const authenticodeProbe = (path, options) => {
    assert.equal(path, fixture.native);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5_000);
    return { status: 'Valid', signer: 'OpenAI, L.L.C.', thumbprint: 'AA BB CC 11' };
  };
  const identity = resolveFixture(fixture, {
    authenticodeProbe,
    authenticodePolicy: { signer: 'OpenAI, L.L.C.', thumbprint: 'aabbcc11' },
  });
  assert.deepEqual(identity.authenticode, {
    status: 'valid', signer: 'OpenAI, L.L.C.', thumbprint: 'aabbcc11',
  });

  assert.throws(
    () => resolveFixture(officialCodexFixture({ platform: 'win32', arch: 'x64' }), {
      authenticodeProbe: () => ({ status: 'valid', signer: 'Unexpected', thumbprint: '00' }),
      authenticodePolicy: { signer: 'OpenAI, L.L.C.', thumbprint: 'aabbcc11' },
    }),
    /RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID/,
  );
  assert.throws(
    () => resolveFixture(officialCodexFixture({ platform: 'win32', arch: 'x64' }), {
      authenticodeProbe: () => { throw new Error('probe unavailable'); },
      authenticodePolicy: { signer: 'OpenAI, L.L.C.' },
    }),
    /RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID/,
  );
});

test('Windows has no guessed signer pin: absent observation remains null and still requires human approval', () => {
  const fixture = officialCodexFixture({ platform: 'win32', arch: 'x64' });
  const diagnosed = diagnoseRuntimeExecutable('codex', {
    explicitPath: fixture.wrapper, platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
  });
  assert.equal(diagnosed.approval_required, true);
  assert.equal(diagnosed.identity.authenticode, null);
  assert.equal(Object.hasOwn(diagnosed.identity, 'trusted_signer'), false);
});

test('resolver fails closed on official package metadata and containment mismatches', () => {
  for (const [label, mutate] of [
    ['wrapper name', fixture => {
      json(join(fixture.wrapperRoot, 'package.json'), {
        name: '@evil/codex', version: fixture.version, bin: { codex: 'bin/codex.js' },
        optionalDependencies: { [fixture.target.alias]: `npm:@openai/codex@${fixture.version}-${fixture.target.suffix}` },
      });
    }],
    ['optional alias spec', fixture => {
      json(join(fixture.wrapperRoot, 'package.json'), {
        name: '@openai/codex', version: fixture.version, bin: { codex: 'bin/codex.js' },
        optionalDependencies: { [fixture.target.alias]: 'npm:@evil/codex@0.144.1' },
      });
    }],
    ['native package name', fixture => {
      json(join(fixture.optionalRoot, 'package.json'), {
        name: '@evil/codex', version: `${fixture.version}-${fixture.target.suffix}`,
        os: [fixture.platform], cpu: [fixture.arch],
      });
    }],
    ['native package version', fixture => {
      json(join(fixture.optionalRoot, 'package.json'), {
        name: '@openai/codex', version: `9.9.9-${fixture.target.suffix}`,
        os: [fixture.platform], cpu: [fixture.arch],
      });
    }],
    ['native package os', fixture => {
      json(join(fixture.optionalRoot, 'package.json'), {
        name: '@openai/codex', version: `${fixture.version}-${fixture.target.suffix}`,
        os: ['linux'], cpu: [fixture.arch],
      });
    }],
    ['native package cpu', fixture => {
      json(join(fixture.optionalRoot, 'package.json'), {
        name: '@openai/codex', version: `${fixture.version}-${fixture.target.suffix}`,
        os: [fixture.platform], cpu: ['x64'],
      });
    }],
    ['native containment', fixture => {
      const outside = join(fixture.root, 'outside-codex');
      writeFileSync(outside, 'outside');
      const native = fixture.native;
      renameSync(native, `${native}.old`);
      symlinkSync(outside, native);
    }],
  ]) {
    const fixture = officialCodexFixture();
    mutate(fixture);
    assert.throws(() => resolveFixture(fixture), /RUNTIME_EXECUTABLE_UNTRUSTED/, label);
    assert.equal(fixture.calls.length, 0, `${label}: no mismatched candidate may execute`);
  }
});

test('bounded version failure and metadata/version disagreement fail closed', () => {
  for (const [label, result] of [
    ['timeout', { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: new Error('ETIMEDOUT') }],
    ['nonzero', { status: 7, signal: null, stdout: '', stderr: 'failed' }],
    ['wrong version', { status: 0, signal: null, stdout: 'codex-cli 9.9.9\n', stderr: '' }],
    ['multiline', { status: 0, signal: null, stdout: 'codex-cli 0.144.1\nextra\n', stderr: '' }],
  ]) {
    const fixture = officialCodexFixture();
    assert.throws(
      () => resolveFixture(fixture, { runVersion: () => result }),
      /RUNTIME_EXECUTABLE_VERSION_INVALID/,
      label,
    );
  }
});

test('revalidation detects post-pin replacement before a spawn can use it', () => {
  const fixture = officialCodexFixture();
  const identity = resolveFixture(fixture);
  writeFileSync(fixture.native, 'replacement');

  assert.throws(
    () => revalidateTrustedRuntimeExecutable(identity, { runVersion: fixture.runVersion }),
    /RUNTIME_EXECUTABLE_DRIFT/,
  );
  assert.equal(fixture.calls.length, 1, 'hash drift must be detected before another execution');
});

test('human-explicit identity revalidates exact path/hash/version and detects replacement before execution', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-runtime-human-revalidate-')));
  const executable = join(root, 'custom-codex');
  writeFileSync(executable, 'custom native bytes');
  chmodSync(executable, 0o755);
  const identity = {
    runtime: 'codex', canonical_path: executable,
    sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    version: '7.8.9', platform: process.platform, arch: process.arch,
    source: 'human-explicit', package: null, authenticode: null,
    approved_by: 'human', approved_at: '2026-07-11T08:00:00.000Z',
  };
  const calls = [];
  const runVersion = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: 0, signal: null, stdout: 'codex-cli 7.8.9\n', stderr: '' };
  };
  assert.deepEqual(revalidateTrustedRuntimeExecutable(identity, { runVersion }), identity);
  assert.equal(calls.length, 1);

  writeFileSync(executable, 'replacement');
  assert.throws(
    () => revalidateTrustedRuntimeExecutable(identity, { runVersion }),
    /RUNTIME_EXECUTABLE_DRIFT/,
  );
  assert.equal(calls.length, 1, 'hash drift must be rejected before executing the replacement');
});

test('human-explicit native Claude on Windows revalidates exact path/hash/version with no shell or argv splitting', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-runtime-claude win & meta-')));
  const executable = join(root, 'claude native & signed.exe');
  writeFileSync(executable, 'claude native bytes');
  const identity = {
    runtime: 'claude', canonical_path: executable,
    sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    version: '2.1.0', platform: 'win32', arch: 'x64',
    source: 'human-explicit', package: null, authenticode: null,
    approved_by: 'human', approved_at: '2026-07-11T08:00:00.000Z',
  };
  const calls = [];
  const runVersion = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: 0, signal: null, stdout: '2.1.0 (Claude Code)\r\n', stderr: '' };
  };

  assert.deepEqual(revalidateTrustedRuntimeExecutable(identity, { platform: 'win32', arch: 'x64', runVersion }), identity);
  assert.deepEqual(calls.map(call => call.bin), [executable]);
  assert.deepEqual(calls[0].argv, ['--version']);
  assert.equal(calls[0].options.shell, false);
});

test('human exact path+SHA approval accepts native Claude.exe and persists the bounded direct identity', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-runtime-claude-approve-')));
  const executable = join(root, 'Claude Native.exe');
  writeFileSync(executable, 'approved claude native bytes');
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-07-11T08:00:00.000Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const calls = [];
  const result = approveRuntimeExecutable(root, runId, {
    runtime: 'claude', candidatePath: executable, expectedCanonicalPath: executable, expectedSha256: sha256,
    actor: 'human', confirm: true, fence: { owner: runId, generation: 1 },
    now: Date.parse('2026-07-11T08:01:00.000Z'), platform: 'win32', arch: 'x64',
    runVersion: (bin, argv, options) => {
      calls.push({ bin, argv, options });
      return { status: 0, signal: null, stdout: '2.1.0 (Claude Code)\r\n', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.approval.runtime, 'claude');
  assert.equal(result.approval.canonical_path, executable);
  assert.equal(result.approval.sha256, sha256);
  assert.equal(result.approval.version, '2.1.0');
  assert.equal(result.approval.platform, 'win32');
  assert.equal(result.approval.source, 'human-explicit');
  assert.equal(result.approval.authenticode, null);
  assert.deepEqual(readState(root, runId).data.autonomy.runtime_executable_approval, result.approval);
  assert.ok(calls.length >= 2, 'approval performs initial and fresh in-lock direct probes');
  assert.ok(calls.every(call => call.bin === executable && call.options.shell === false));
});

test('official Windows approval persists the observed Authenticode identity and repeats the pinned probe in-lock', () => {
  const fixture = officialCodexFixture({ platform: 'win32', arch: 'x64' });
  const policy = { signer: 'OpenAI, L.L.C.', thumbprint: 'aabbcc11' };
  const observation = { status: 'Valid', signer: 'OpenAI, L.L.C.', thumbprint: 'AA BB CC 11' };
  const diagnosed = resolveFixture(fixture, {
    authenticodeProbe: () => observation, authenticodePolicy: policy,
  });
  const { runId } = initRun(fixture.root, {
    runtime: 'codex', goal: 'g', now: new Date('2026-07-11T08:00:00.000Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  let signerProbes = 0;
  const result = approveRuntimeExecutable(fixture.root, runId, {
    runtime: 'codex', candidatePath: fixture.wrapper,
    expectedCanonicalPath: diagnosed.canonical_path, expectedSha256: diagnosed.sha256,
    actor: 'human', confirm: true, fence: { owner: runId, generation: 1 },
    now: Date.parse('2026-07-11T08:01:00.000Z'), platform: 'win32', arch: 'x64',
    runVersion: fixture.runVersion,
    authenticodeProbe: (path, options) => {
      signerProbes++;
      assert.equal(path, fixture.native);
      assert.equal(options.shell, false);
      return observation;
    },
    authenticodePolicy: policy,
  });
  assert.deepEqual(result.approval.authenticode, {
    status: 'valid', signer: 'OpenAI, L.L.C.', thumbprint: 'aabbcc11',
  });
  assert.equal(signerProbes, 2, 'approval and fresh in-lock verification must both observe the signer');
  assert.deepEqual(readState(fixture.root, runId).data.autonomy.runtime_executable_approval, result.approval);
});

test('Claude shim-only Windows installs are never diagnosable or revalidatable as native executables', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-runtime-claude-shim-')));
  for (const extension of ['cmd', 'bat', 'ps1', 'js']) {
    const shim = join(root, `claude.${extension}`);
    writeFileSync(shim, 'shim');
    assert.throws(
      () => diagnoseRuntimeExecutable('claude', { explicitPath: shim, platform: 'win32', arch: 'x64' }),
      /RUNTIME_EXECUTABLE_UNTRUSTED/,
    );
  }
});

test('diagnose never presents script or shell shims as human-approvable native executables', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-runtime-shim-diagnose-')));
  for (const extension of ['js', 'mjs', 'cjs', 'cmd', 'bat', 'ps1']) {
    const shim = join(root, `codex.${extension}`);
    writeFileSync(shim, 'shim');
    assert.throws(
      () => diagnoseRuntimeExecutable('codex', { explicitPath: shim }),
      /RUNTIME_EXECUTABLE_UNTRUSTED/,
      extension,
    );
  }
});

test('authenticated CODEX_HOME requires an absolute existing non-symlink directory and records directory identity', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'dl-codex-home-')));
  const home = join(parent, 'auth-home');
  mkdirSync(home);
  const identity = resolveAuthenticatedCodexHome({ path: home });

  assert.equal(identity.canonical_path, home);
  assert.match(identity.device, /^\d+$/);
  assert.match(identity.inode, /^\d+$/);
  assert.match(identity.birthtime_ns, /^\d+$/);
  assert.equal(identity.platform, process.platform);
  assert.deepEqual(resolveAuthenticatedCodexHome({ path: home, expectedIdentity: identity }), identity);

  assert.throws(() => resolveAuthenticatedCodexHome({ path: 'relative-home' }), /CODEX_HOME_INVALID/);
  assert.throws(() => resolveAuthenticatedCodexHome({ path: join(parent, 'missing') }), /CODEX_HOME_INVALID/);
  const file = join(parent, 'file');
  writeFileSync(file, 'not a directory');
  assert.throws(() => resolveAuthenticatedCodexHome({ path: file }), /CODEX_HOME_INVALID/);
  const link = join(parent, 'link');
  symlinkSync(home, link, 'dir');
  assert.throws(() => resolveAuthenticatedCodexHome({ path: link }), /CODEX_HOME_INVALID/);
});

test('authenticated CODEX_HOME revalidation detects directory replacement', () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'dl-codex-home-drift-')));
  const home = join(parent, 'auth-home');
  mkdirSync(home);
  const identity = resolveAuthenticatedCodexHome({ path: home });
  renameSync(home, join(parent, 'old-home'));
  mkdirSync(home);

  assert.throws(
    () => resolveAuthenticatedCodexHome({ path: home, expectedIdentity: identity }),
    /CODEX_HOME_DRIFT/,
  );
});
