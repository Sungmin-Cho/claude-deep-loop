import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
import * as runtimeExecutable from '../scripts/lib/runtime-executable.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { detectAndPersist } from '../scripts/lib/detect-terminal.mjs';
import { seedCorrelatedTerminal } from './fixtures/verified-app-run.mjs';
import {
  canonicalRealpath,
  createDirectoryJunction,
  createFileSymlinkOrSkip,
} from './helpers/fs-fixtures.mjs';

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
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-runtime-executable-')));
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

const WINDOWS_NAMESPACE_REJECTION = 'RUNTIME_EXECUTABLE_UNTRUSTED: Windows UNC/device namespace runtime candidates are not trusted';
const WINDOWS_NAMESPACE_PATHS = Object.freeze([
  {
    label: 'backslash UNC',
    native: String.raw`\\server\share\codex.exe`,
    wrapper: String.raw`\\server\share\codex.cmd`,
  },
  {
    label: 'slash UNC',
    native: '//server/share/codex.exe',
    wrapper: '//server/share/codex.cmd',
  },
  {
    label: 'extended UNC',
    native: String.raw`\\?\UNC\server\share\codex.exe`,
    wrapper: String.raw`\\?\UNC\server\share\codex.cmd`,
  },
  {
    label: 'local-device namespace',
    native: String.raw`\\.\C:\tools\codex.exe`,
    wrapper: String.raw`\\.\C:\tools\codex.cmd`,
  },
  {
    label: 'extended drive namespace',
    native: String.raw`\\?\C:\tools\codex.exe`,
    wrapper: String.raw`\\?\C:\tools\codex.cmd`,
  },
]);

function assertWindowsNamespaceRejected(callback, label) {
  assert.throws(callback, error => {
    assert.equal(String(error?.message || error), WINDOWS_NAMESPACE_REJECTION, label);
    return true;
  }, label);
}

function durableApprovalBytes(root, runId) {
  const dir = join(root, '.deep-loop', 'runs', runId);
  return Object.fromEntries(['loop.json', '.loop.hash', 'event-log.jsonl'].map(name => {
    const path = join(dir, name);
    return [name, existsSync(path) ? readFileSync(path) : null];
  }));
}

function launcherApprovalFixture({ kind = 'wt', name = kind === 'wt' ? 'wt.exe' : 'pwsh.exe' } = {}) {
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-launcher-approval-')));
  const executable = join(root, name);
  writeFileSync(executable, `${kind} native launcher bytes`);
  chmodSync(executable, 0o755);
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const version = kind === 'wt' ? '1.22.10352.0' : '7.5.2';
  const versionLine = kind === 'wt' ? `Windows Terminal ${version}` : `PowerShell ${version}`;
  const calls = [];
  const runVersion = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: 0, signal: null, stdout: `${versionLine}\r\n`, stderr: '' };
  };
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', now: new Date('2026-07-12T00:00:00.000Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  return { root, runId, kind, executable, sha256, version, versionLine, calls, runVersion };
}

function launcherApprovalOptions(fixture, overrides = {}) {
  return {
    kind: fixture.kind,
    candidatePath: fixture.executable,
    expectedCanonicalPath: fixture.executable,
    expectedSha256: fixture.sha256,
    actor: 'human',
    confirm: true,
    fence: { owner: fixture.runId, generation: 1 },
    now: Date.parse('2026-07-12T01:00:00.000Z'),
    platform: 'win32',
    arch: 'x64',
    runVersion: fixture.runVersion,
    ...overrides,
  };
}

function assertLauncherOnlyError(callback, primaryCode, label) {
  assert.throws(callback, error => {
    const message = String(error?.message || error);
    assert.ok(message.startsWith(`${primaryCode}:`), `${label}: ${message}`);
    assert.doesNotMatch(message, /RUNTIME_EXECUTABLE_/, `${label}: ${message}`);
    return true;
  }, label);
}

test('collectRuntimeExecutableCandidates ignores cwd and relative PATH shadows', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dl-runtime-shadow-cwd-'));
  writeFileSync(join(cwd, 'codex'), 'shadow');

  const candidates = collectRuntimeExecutableCandidates('codex', {
    env: { PATH: `${join(cwd, 'relative-bin')}::` },
    cwd,
    platform: 'darwin',
  });

  assert.deepEqual(candidates, []);
  assert.ok(!candidates.some(candidate => candidate.path === join(cwd, 'codex')));
  assert.throws(
    () => collectRuntimeExecutableCandidates('codex', { explicitPath: './codex', cwd, platform: 'darwin' }),
    /RUNTIME_EXECUTABLE_PATH_INVALID/,
  );
});

test('collectRuntimeExecutableCandidates keeps an absolute PATH file-symlink candidate', (t) => {
  const fixture = officialCodexFixture();
  const absoluteBin = mkdtempSync(join(tmpdir(), 'dl-runtime-shadow-path-'));
  const link = join(absoluteBin, 'codex');
  if (!createFileSymlinkOrSkip(t, fixture.wrapper, link)) return;

  const candidates = collectRuntimeExecutableCandidates('codex', {
    env: { PATH: absoluteBin }, cwd: fixture.root, platform: 'darwin',
  });
  assert.deepEqual(candidates.map(candidate => candidate.path), [link]);
  assert.ok(candidates.every(candidate => candidate.source === 'path-search'));
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
  const first = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-win-path-a-')));
  const second = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-win-path-b-')));
  writeFileSync(join(first, 'codex.cmd'), 'shim');
  writeFileSync(join(second, 'codex.exe'), 'shadow');

  const candidates = collectRuntimeExecutableCandidates('codex', {
    platform: 'win32', env: { Path: `relative;;${first};${second}` },
  });

  assert.deepEqual(candidates.map(candidate => candidate.path), [join(first, 'codex.cmd'), join(second, 'codex.exe')]);
  assert.ok(candidates.every(candidate => candidate.source === 'path-search'));
});

test('Windows official resolver rejects UNC/device wrapper candidates before version or Authenticode probes', () => {
  let versionCalls = 0;
  let signerCalls = 0;
  for (const { label, wrapper } of WINDOWS_NAMESPACE_PATHS) {
    assertWindowsNamespaceRejected(
      () => resolveTrustedRuntimeExecutable('codex', {
        candidatePaths: [wrapper],
        platform: 'win32',
        arch: 'x64',
        runVersion: () => {
          versionCalls++;
          throw new Error('version probe must be unreachable');
        },
        authenticodeProbe: () => {
          signerCalls++;
          throw new Error('Authenticode probe must be unreachable');
        },
        authenticodePolicy: { signer: 'OpenAI, L.L.C.', thumbprint: 'aa' },
      }),
      label,
    );
  }
  assert.equal(versionCalls, 0);
  assert.equal(signerCalls, 0);
});

test('Windows diagnosis rejects UNC/device human-explicit candidates before hashing or probes', () => {
  let versionCalls = 0;
  let signerCalls = 0;
  for (const { label, native } of WINDOWS_NAMESPACE_PATHS) {
    assertWindowsNamespaceRejected(
      () => diagnoseRuntimeExecutable('codex', {
        explicitPath: native,
        platform: 'win32',
        arch: 'x64',
        runVersion: () => {
          versionCalls++;
          throw new Error('version probe must be unreachable');
        },
        authenticodeProbe: () => {
          signerCalls++;
          throw new Error('Authenticode probe must be unreachable');
        },
        authenticodePolicy: { signer: 'OpenAI, L.L.C.', thumbprint: 'aa' },
      }),
      label,
    );
  }
  assert.equal(versionCalls, 0);
  assert.equal(signerCalls, 0);
});

test('Windows approval rejects UNC/device candidates before probes or durable append', () => {
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-runtime-unc-approve-')));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', now: new Date('2026-07-11T08:00:00.000Z'),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const before = durableApprovalBytes(root, runId);
  let versionCalls = 0;
  let signerCalls = 0;
  for (const { label, native, wrapper } of WINDOWS_NAMESPACE_PATHS) {
    for (const [kind, candidatePath] of [['human-explicit', native], ['official-wrapper', wrapper]]) {
      assertWindowsNamespaceRejected(
        () => approveRuntimeExecutable(root, runId, {
          runtime: 'codex',
          candidatePath,
          expectedCanonicalPath: join(root, 'expected-codex.exe'),
          expectedSha256: '0'.repeat(64),
          actor: 'human',
          confirm: true,
          fence: { owner: runId, generation: 1 },
          now: Date.parse('2026-07-11T08:01:00.000Z'),
          platform: 'win32',
          arch: 'x64',
          runVersion: () => {
            versionCalls++;
            throw new Error('version probe must be unreachable');
          },
          authenticodeProbe: () => {
            signerCalls++;
            throw new Error('Authenticode probe must be unreachable');
          },
          authenticodePolicy: { signer: 'OpenAI, L.L.C.', thumbprint: 'aa' },
        }),
        `${label} ${kind}`,
      );
    }
  }
  assert.equal(versionCalls, 0);
  assert.equal(signerCalls, 0);
  assert.deepEqual(durableApprovalBytes(root, runId), before, 'approval state/event bytes must remain unchanged');
});

test('Windows revalidation rejects UNC/device pinned and wrapper paths before hashing or probes', () => {
  let versionCalls = 0;
  let signerCalls = 0;
  const options = {
    platform: 'win32',
    arch: 'x64',
    runVersion: () => {
      versionCalls++;
      throw new Error('version probe must be unreachable');
    },
    authenticodeProbe: () => {
      signerCalls++;
      throw new Error('Authenticode probe must be unreachable');
    },
    authenticodePolicy: { signer: 'OpenAI, L.L.C.', thumbprint: 'aa' },
  };
  for (const { label, native } of WINDOWS_NAMESPACE_PATHS) {
    const identity = {
      runtime: 'codex',
      canonical_path: native,
      sha256: '0'.repeat(64),
      version: '1.2.3',
      platform: 'win32',
      arch: 'x64',
      source: 'human-explicit',
      package: null,
      authenticode: { status: 'valid', signer: 'OpenAI, L.L.C.', thumbprint: 'aa' },
      approved_by: 'human',
      approved_at: '2026-07-11T08:00:00.000Z',
    };
    assertWindowsNamespaceRejected(
      () => revalidateTrustedRuntimeExecutable(identity, options),
      `${label} pinned path`,
    );
  }

  const fixture = officialCodexFixture({ platform: 'win32', arch: 'x64' });
  const official = resolveFixture(fixture);
  for (const { label, wrapper } of WINDOWS_NAMESPACE_PATHS) {
    assertWindowsNamespaceRejected(
      () => revalidateTrustedRuntimeExecutable({
        ...official,
        package: { ...official.package, wrapper_path: wrapper },
      }, options),
      `${label} stored wrapper path`,
    );
  }
  assert.equal(versionCalls, 0);
  assert.equal(signerCalls, 0);
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
  ]) {
    const fixture = officialCodexFixture();
    mutate(fixture);
    assert.throws(() => resolveFixture(fixture), /RUNTIME_EXECUTABLE_UNTRUSTED/, label);
    assert.equal(fixture.calls.length, 0, `${label}: no mismatched candidate may execute`);
  }
});

test('resolver fails closed on a native binary replaced by a file symlink', (t) => {
  const fixture = officialCodexFixture();
  const outside = join(fixture.root, 'outside-codex');
  writeFileSync(outside, 'outside');
  const native = fixture.native;
  renameSync(native, `${native}.old`);
  if (!createFileSymlinkOrSkip(t, outside, native)) return;

  assert.throws(() => resolveFixture(fixture), /RUNTIME_EXECUTABLE_UNTRUSTED/);
  assert.equal(fixture.calls.length, 0, 'the escaped native candidate must never execute');
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
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-runtime-human-revalidate-')));
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
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-runtime-claude win & meta-')));
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
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-runtime-claude-approve-')));
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
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-runtime-claude-shim-')));
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
  const root = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-runtime-shim-diagnose-')));
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

test('launcher diagnosis hashes one explicit native path without executing it; approval performs fresh fenced verification once', () => {
  const fixture = launcherApprovalFixture();
  const before = durableApprovalBytes(fixture.root, fixture.runId);

  const diagnosed = runtimeExecutable.diagnoseLauncherExecutable('wt', {
    explicitPath: fixture.executable, platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
  });
  assert.equal(diagnosed.approval_required, true);
  assert.deepEqual(diagnosed.identity, {
    kind: 'wt', canonical_path: fixture.executable, sha256: fixture.sha256, version: null,
    platform: 'win32', arch: 'x64', source: 'human-explicit', authenticode: null,
    version_probe: 'deferred-until-human-approval',
  });
  assert.equal(fixture.calls.length, 0, 'diagnosis must never execute unapproved launcher code');
  assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), before, 'diagnosis is read-only');

  const result = runtimeExecutable.approveLauncherExecutable(
    fixture.root, fixture.runId, launcherApprovalOptions(fixture),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.approval, {
    kind: 'wt', canonical_path: fixture.executable, sha256: fixture.sha256,
    version: fixture.version, platform: 'win32', arch: 'x64', source: 'human-explicit',
    authenticode: null, approved_by: 'human', approved_at: '2026-07-12T01:00:00.000Z',
  });
  assert.equal(fixture.calls.length, 2, 'the confirmed in-lock identity is observed then revalidated for drift');
  assert.ok(fixture.calls.every(call => call.bin === fixture.executable && call.options.shell === false));

  const state = readState(fixture.root, fixture.runId).data;
  assert.deepEqual(state.autonomy.launcher_executable_approvals, {
    wt: result.approval, powershell: null,
  });
  const events = readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId, 'event-log.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  const approvals = events.filter(event => event.type === 'launcher-executable-approved');
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].data, {
    kind: 'wt', canonical_path: fixture.executable, sha256: fixture.sha256,
    version: fixture.version, source: 'human-explicit', actor: 'human',
  });
});

test('launcher approval rejects missing authority, unsafe targets, and version failure without probing or appending', () => {
  const cases = [
    ['kind', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), kind: undefined }), /LAUNCHER_EXECUTABLE_KIND_INVALID/],
    ['actor', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), actor: undefined }), /INVALID_ACTOR/],
    ['confirm', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), confirm: false }), /CONFIRM_REQUIRED/],
    ['fence', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), fence: undefined }), /FENCE_REQUIRED/],
    ['path', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), candidatePath: undefined }), /LAUNCHER_EXECUTABLE_PATH_INVALID/],
    ['hash', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), expectedSha256: 'A'.repeat(64) }), /LAUNCHER_EXECUTABLE_HASH_INVALID/],
    ['bare', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), candidatePath: 'wt.exe' }), /LAUNCHER_EXECUTABLE_PATH_INVALID/],
    ['relative', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), candidatePath: '.\\wt.exe' }), /LAUNCHER_EXECUTABLE_PATH_INVALID/],
    ['UNC', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), candidatePath: String.raw`\\server\share\wt.exe` }), /LAUNCHER_EXECUTABLE_UNTRUSTED/],
    ['device', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), candidatePath: String.raw`\\?\C:\tools\wt.exe` }), /LAUNCHER_EXECUTABLE_UNTRUSTED/],
    ['script', () => launcherApprovalFixture({ name: 'wt.ps1' }), fixture => launcherApprovalOptions(fixture), /LAUNCHER_EXECUTABLE_UNTRUSTED/],
    ['version', () => launcherApprovalFixture(), fixture => ({ ...launcherApprovalOptions(fixture), runVersion: () => ({ status: 1, signal: null, stdout: '', stderr: 'failed' }) }), /LAUNCHER_EXECUTABLE_VERSION_INVALID/],
  ];

  for (const [label, makeFixture, makeOptions, expected] of cases) {
    const fixture = makeFixture();
    const before = durableApprovalBytes(fixture.root, fixture.runId);
    assert.throws(
      () => runtimeExecutable.approveLauncherExecutable(fixture.root, fixture.runId, makeOptions(fixture)),
      expected,
      label,
    );
    assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), before, label);
    if (!['version'].includes(label)) assert.equal(fixture.calls.length, 0, `${label}: rejected authority must not execute`);
  }
});

test('launcher approval fence, terminal state, candidate replacement, and security drift fail closed with no append', () => {
  for (const [label, prepare, overrides, expected] of [
    ['owner fence', () => {}, { fence: { owner: 'stale-owner', generation: 1 } }, /LEASE_FENCED/],
    ['generation fence', () => {}, { fence: { owner: null, generation: 9 } }, /LEASE_FENCED/],
    ['terminal', fixture => {
      seedCorrelatedTerminal(fixture.root, fixture.runId, { status: 'completed' });
    }, {}, /LAUNCHER_EXECUTABLE_STATE_INVALID.*RUN_TERMINAL/],
    ['candidate replacement', fixture => {
      writeFileSync(fixture.executable, 'replacement launcher bytes');
    }, {}, /LAUNCHER_EXECUTABLE_HASH_MISMATCH/],
  ]) {
    const fixture = launcherApprovalFixture();
    prepare(fixture);
    const resolvedOverrides = label === 'generation fence'
      ? { ...overrides, fence: { owner: fixture.runId, generation: 9 } }
      : overrides;
    const before = durableApprovalBytes(fixture.root, fixture.runId);
    assert.throws(
      () => runtimeExecutable.approveLauncherExecutable(
        fixture.root, fixture.runId, launcherApprovalOptions(fixture, resolvedOverrides),
      ),
      expected,
      label,
    );
    assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), before, label);
    if (label !== 'candidate replacement') assert.equal(fixture.calls.length, 0, `${label}: fence/state must win before execution`);
  }

  const drift = launcherApprovalFixture();
  let signerCalls = 0;
  const before = durableApprovalBytes(drift.root, drift.runId);
  assert.throws(
    () => runtimeExecutable.approveLauncherExecutable(drift.root, drift.runId, launcherApprovalOptions(drift, {
      authenticodeProbe: () => ({
        status: 'valid', signer: signerCalls++ === 0 ? 'Expected Signer' : 'Replacement Signer', thumbprint: 'aabb',
      }),
    })),
    /LAUNCHER_EXECUTABLE_DRIFT/,
  );
  assert.equal(signerCalls, 2);
  assert.deepEqual(durableApprovalBytes(drift.root, drift.runId), before);
});

test('launcher candidate ambiguity is never authority and cannot mutate durable state', () => {
  const run = launcherApprovalFixture();
  const other = launcherApprovalFixture();
  const before = durableApprovalBytes(run.root, run.runId);
  assert.throws(
    () => runtimeExecutable.resolveTrustedLauncherExecutable('wt', {
      candidatePaths: [run.executable, other.executable], platform: 'win32', arch: 'x64',
      runVersion: run.runVersion,
    }),
    /LAUNCHER_EXECUTABLE_AMBIGUOUS/,
  );
  assert.deepEqual(durableApprovalBytes(run.root, run.runId), before);
});

test('launcher approval rejects a present malformed approval map instead of repairing it', () => {
  const fixture = launcherApprovalFixture();
  const { data } = readState(fixture.root, fixture.runId);
  data.autonomy.launcher_executable_approvals = null;
  const dir = join(fixture.root, '.deep-loop', 'runs', fixture.runId);
  const raw = JSON.stringify(data, null, 2);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  const before = durableApprovalBytes(fixture.root, fixture.runId);
  assert.throws(
    () => runtimeExecutable.approveLauncherExecutable(
      fixture.root, fixture.runId, launcherApprovalOptions(fixture),
    ),
    /RUN_SNAPSHOT_INVALID.*launcher_executable_approvals/,
  );
  assert.equal(fixture.calls.length, 0, 'malformed durable state must fail before executing a candidate');
  assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), before);
});

test('launcher approval rejects a running releasing handoff before candidate execution', () => {
  const fixture = launcherApprovalFixture();
  const { data } = readState(fixture.root, fixture.runId);
  data.session_chain.lease.state = 'releasing';
  data.session_chain.lease.handoff_phase = 'emitted';
  data.session_chain.lease.handoff_idempotency_key = 'test-key';
  data.session_chain.lease.handoff_child_run_id = 'reserved-child';
  writeState(fixture.root, fixture.runId, data);
  const before = durableApprovalBytes(fixture.root, fixture.runId);
  assert.throws(
    () => runtimeExecutable.approveLauncherExecutable(
      fixture.root, fixture.runId, launcherApprovalOptions(fixture),
    ),
    /LAUNCHER_EXECUTABLE_STATE_INVALID.*lease-releasing-carveout/,
  );
  assert.equal(fixture.calls.length, 0, 'releasing fence must win before unapproved code execution');
  assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), before);
});

test('launcher public diagnose and approve APIs use launcher-specific unavailable errors', () => {
  const fixture = launcherApprovalFixture();
  const missing = join(fixture.root, 'missing', 'wt.exe');
  assert.throws(
    () => runtimeExecutable.diagnoseLauncherExecutable('wt', {
      explicitPath: missing, platform: 'win32', arch: 'x64',
    }),
    error => String(error?.message || error).startsWith('LAUNCHER_EXECUTABLE_UNTRUSTED:'),
  );

  const before = durableApprovalBytes(fixture.root, fixture.runId);
  assert.throws(
    () => runtimeExecutable.approveLauncherExecutable(fixture.root, fixture.runId, launcherApprovalOptions(fixture, {
      candidatePath: missing,
      expectedCanonicalPath: missing,
    })),
    error => String(error?.message || error).startsWith('LAUNCHER_EXECUTABLE_UNTRUSTED:'),
  );
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), before);

  assertLauncherOnlyError(
    () => runtimeExecutable.approveLauncherExecutable(fixture.root, fixture.runId, launcherApprovalOptions(fixture, {
      authenticodeProbe: () => ({ status: 'invalid', signer: 'Unknown', thumbprint: 'aa' }),
    })),
    'LAUNCHER_EXECUTABLE_AUTHENTICODE_INVALID',
    'approve invalid Authenticode',
  );
  assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), before);
});

test('launcher resolution sanitizes a missing candidate without changing its unavailable primary code', () => {
  const missingFixture = launcherApprovalFixture();
  const missing = join(missingFixture.root, 'missing', 'wt.exe');
  assertLauncherOnlyError(
    () => runtimeExecutable.resolveTrustedLauncherExecutable('wt', {
      candidatePaths: [missing], platform: 'win32', arch: 'x64',
      runVersion: missingFixture.runVersion,
    }),
    'LAUNCHER_EXECUTABLE_UNTRUSTED',
    'resolve missing launcher',
  );
});

test('launcher diagnosis and approval keep missing candidates in the launcher namespace', () => {
  const missingFixture = launcherApprovalFixture();
  const missing = join(missingFixture.root, 'missing', 'wt.exe');
  assertLauncherOnlyError(
    () => runtimeExecutable.diagnoseLauncherExecutable('wt', {
      explicitPath: missing, platform: 'win32', arch: 'x64',
    }),
    'LAUNCHER_EXECUTABLE_UNTRUSTED',
    'diagnose missing launcher',
  );
  assertLauncherOnlyError(
    () => runtimeExecutable.approveLauncherExecutable(
      missingFixture.root,
      missingFixture.runId,
      launcherApprovalOptions(missingFixture, {
        candidatePath: missing,
        expectedCanonicalPath: missing,
      }),
    ),
    'LAUNCHER_EXECUTABLE_UNTRUSTED',
    'approve missing launcher',
  );
});

test('launcher revalidation preserves drift while sanitizing a missing approved candidate', () => {
  const approvedFixture = launcherApprovalFixture();
  const approved = runtimeExecutable.approveLauncherExecutable(
    approvedFixture.root,
    approvedFixture.runId,
    launcherApprovalOptions(approvedFixture),
  ).approval;
  renameSync(approvedFixture.executable, `${approvedFixture.executable}.removed`);
  assertLauncherOnlyError(
    () => runtimeExecutable.revalidateTrustedLauncherExecutable(approved, {
      platform: 'win32', arch: 'x64', runVersion: approvedFixture.runVersion,
    }),
    'LAUNCHER_EXECUTABLE_DRIFT',
    'revalidate missing launcher',
  );
});

test('all public launcher paths reject scripts without leaking the runtime namespace', () => {
  for (const operation of ['resolve', 'diagnose', 'approve', 'revalidate']) {
    const fixture = launcherApprovalFixture({ name: 'wt.ps1' });
    const scriptIdentity = {
      kind: 'wt', canonical_path: fixture.executable, sha256: fixture.sha256,
      version: fixture.version, platform: 'win32', arch: 'x64', source: 'verified-native',
      authenticode: null,
    };
    const invoke = {
      resolve: () => runtimeExecutable.resolveTrustedLauncherExecutable('wt', {
        candidatePaths: [fixture.executable], platform: 'win32', arch: 'x64',
        runVersion: fixture.runVersion,
      }),
      diagnose: () => runtimeExecutable.diagnoseLauncherExecutable('wt', {
        explicitPath: fixture.executable, platform: 'win32', arch: 'x64',
      }),
      approve: () => runtimeExecutable.approveLauncherExecutable(
        fixture.root, fixture.runId, launcherApprovalOptions(fixture),
      ),
      revalidate: () => runtimeExecutable.revalidateTrustedLauncherExecutable(scriptIdentity, {
        platform: 'win32', arch: 'x64', runVersion: fixture.runVersion,
      }),
    }[operation];
    assertLauncherOnlyError(
      invoke,
      operation === 'revalidate' ? 'LAUNCHER_EXECUTABLE_DRIFT' : 'LAUNCHER_EXECUTABLE_UNTRUSTED',
      `${operation} script launcher`,
    );
  }
});

test('launcher resolution sanitizes invalid Authenticode without changing its unavailable primary code', () => {
  const resolveFixture = launcherApprovalFixture();
  assertLauncherOnlyError(
    () => runtimeExecutable.resolveTrustedLauncherExecutable('wt', {
      candidatePaths: [resolveFixture.executable], platform: 'win32', arch: 'x64',
      runVersion: resolveFixture.runVersion,
      authenticodeProbe: () => ({ status: 'invalid', signer: 'Unknown', thumbprint: 'aa' }),
    }),
    'LAUNCHER_EXECUTABLE_UNTRUSTED',
    'resolve invalid Authenticode',
  );
});

test('launcher revalidation sanitizes hashing and Authenticode drift without changing its primary code', () => {
  const driftFixture = launcherApprovalFixture();
  const approved = runtimeExecutable.approveLauncherExecutable(
    driftFixture.root,
    driftFixture.runId,
    launcherApprovalOptions(driftFixture, {
      authenticodeProbe: () => ({ status: 'valid', signer: 'Expected', thumbprint: 'aa' }),
    }),
  ).approval;

  writeFileSync(driftFixture.executable, 'hash drift after approval');
  assertLauncherOnlyError(
    () => runtimeExecutable.revalidateTrustedLauncherExecutable(approved, {
      platform: 'win32', arch: 'x64', runVersion: driftFixture.runVersion,
      authenticodeProbe: () => ({ status: 'valid', signer: 'Expected', thumbprint: 'aa' }),
    }),
    'LAUNCHER_EXECUTABLE_DRIFT',
    'revalidate hash drift',
  );

  writeFileSync(driftFixture.executable, `${driftFixture.kind} native launcher bytes`);
  assertLauncherOnlyError(
    () => runtimeExecutable.revalidateTrustedLauncherExecutable(approved, {
      platform: 'win32', arch: 'x64', runVersion: driftFixture.runVersion,
      authenticodeProbe: () => ({ status: 'invalid', signer: 'Unknown', thumbprint: 'aa' }),
    }),
    'LAUNCHER_EXECUTABLE_DRIFT',
    'revalidate invalid Authenticode',
  );
});

test('fresh exact human re-approval replaces a launcher atomically and requires terminal re-detection', () => {
  const fixture = launcherApprovalFixture();
  const first = runtimeExecutable.approveLauncherExecutable(
    fixture.root, fixture.runId, launcherApprovalOptions(fixture),
  ).approval;
  assert.equal(readState(fixture.root, fixture.runId).data.session_spawn.launcher, 'none');
  const firstDescriptor = detectAndPersist(fixture.root, fixture.runId, {
    owner: fixture.runId, generation: 1, env: { WT_SESSION: 'session-1' },
    platform: 'win32', arch: 'x64', now: '2026-07-12T01:01:00.000Z',
    launcherRevalidationOptions: { runVersion: fixture.runVersion },
  });
  assert.equal(firstDescriptor.launcher, 'wt');
  assert.equal(firstDescriptor.launcher_bin, first.canonical_path);

  const replacementDir = join(fixture.root, 'replacement');
  mkdirSync(replacementDir);
  const replacement = join(replacementDir, 'wt.exe');
  writeFileSync(replacement, 'replacement native launcher bytes');
  const replacementSha256 = createHash('sha256').update(readFileSync(replacement)).digest('hex');
  const replacementCalls = [];
  const replacementRunVersion = (bin, argv, options) => {
    replacementCalls.push({ bin, argv, options });
    return { status: 0, signal: null, stdout: `Windows Terminal ${fixture.version}\r\n`, stderr: '' };
  };
  const replacementOptions = launcherApprovalOptions(fixture, {
    candidatePath: replacement,
    expectedCanonicalPath: replacement,
    expectedSha256: replacementSha256,
    now: Date.parse('2026-07-12T02:00:00.000Z'),
    runVersion: replacementRunVersion,
  });

  const beforeFailedReplacement = durableApprovalBytes(fixture.root, fixture.runId);
  assert.throws(
    () => runtimeExecutable.approveLauncherExecutable(fixture.root, fixture.runId, {
      ...replacementOptions, expectedSha256: first.sha256,
    }),
    /LAUNCHER_EXECUTABLE_HASH_MISMATCH/,
  );
  assert.deepEqual(durableApprovalBytes(fixture.root, fixture.runId), beforeFailedReplacement);
  assert.deepEqual(readState(fixture.root, fixture.runId).data.autonomy.launcher_executable_approvals.wt, first);

  const second = runtimeExecutable.approveLauncherExecutable(
    fixture.root, fixture.runId, replacementOptions,
  ).approval;
  assert.equal(second.canonical_path, replacement);
  assert.equal(second.sha256, replacementSha256);
  assert.equal(second.approved_at, '2026-07-12T02:00:00.000Z');
  const pendingDetection = readState(fixture.root, fixture.runId).data.session_spawn;
  assert.equal(pendingDetection.launcher, 'none',
    'fresh approval must invalidate the old runnable descriptor until detection binds the new authority');
  assert.equal(pendingDetection.launcher_bin, null);
  assert.equal(pendingDetection.launcher_identity, undefined);
  assert.equal(pendingDetection.reason, 'launcher-reapproval-pending-detection');
  const events = readFileSync(join(fixture.root, '.deep-loop', 'runs', fixture.runId, 'event-log.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'launcher-executable-approved').length, 2);

  const descriptor = detectAndPersist(fixture.root, fixture.runId, {
    owner: fixture.runId, generation: 1, env: { WT_SESSION: 'session-2' },
    platform: 'win32', arch: 'x64', now: '2026-07-12T02:01:00.000Z',
    launcherRevalidationOptions: { runVersion: replacementRunVersion },
  });
  assert.equal(descriptor.launcher, 'wt');
  assert.equal(descriptor.launcher_bin, replacement);
  assert.deepEqual(descriptor.launcher_identity, second);
});

test('authenticated CODEX_HOME requires an absolute existing non-symlink directory and records directory identity', () => {
  const parent = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-codex-home-')));
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
  createDirectoryJunction(home, link);
  assert.throws(() => resolveAuthenticatedCodexHome({ path: link }), /CODEX_HOME_INVALID/);
});

test('authenticated CODEX_HOME revalidation detects directory replacement', () => {
  const parent = canonicalRealpath(mkdtempSync(join(tmpdir(), 'dl-codex-home-drift-')));
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
