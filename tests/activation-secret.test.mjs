import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateStoredLease } from '../scripts/lib/activation-secret.mjs';

const ROOT = '/canonical/project';
const RUN = '01KSTOREDSECRETRUN00000000';
const BINDING = {
  owner: '01KSTOREDSECRETOWNER000000', generation: 2, runtime: 'claude',
  attemptId: '01KSTOREDSECRETATTEMPT000',
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function linuxDeps(stateRoot, overrides = {}) {
  return {
    platform: 'linux', env: { XDG_STATE_HOME: stateRoot }, homedirFn: () => '/unused',
    canonicalProjectRootFn: value => value,
    randomBytesFn: () => Buffer.alloc(32, 0x5a),
    activateLeaseFn: (_root, _runId, options) => {
      const token = options.activationTokenProvider({
        guard: { assertOwned() {}, renew() {} }, allowCreate: true,
      });
      return { ok: true, reason: 'activated', observedToken: token };
    },
    ...overrides,
  };
}

function windowsDeps(stateRoot, overrides = {}) {
  const systemRoot = 'C:\\Windows';
  const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  return linuxDeps(stateRoot, {
    platform: 'win32', testStateRoot: stateRoot,
    env: { SystemRoot: systemRoot, LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', PATH: 'C:\\attacker' },
    windowsExecutableLstatFn(path) {
      return {
        isDirectory: () => path === systemRoot,
        isFile: () => path === executable,
        isSymbolicLink: () => false,
      };
    },
    windowsExecutableRealpathFn: path => path,
    ...overrides,
  });
}

test('stored activation publishes one opaque private exact-schema secret and reuses it', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dl-secret-state-'));
  const seen = [];
  const deps = linuxDeps(stateRoot, {
    activateLeaseFn: (_root, _runId, options) => {
      seen.push(options.activationTokenProvider({
        guard: { assertOwned() {}, renew() {} }, allowCreate: seen.length === 0,
      }));
      return { ok: true, reason: seen.length === 1 ? 'activated' : 'already-activated' };
    },
  });
  assert.deepEqual(activateStoredLease(ROOT, RUN, BINDING, deps), { ok: true, reason: 'activated' });
  deps.randomBytesFn = () => Buffer.alloc(32, 0x33);
  assert.deepEqual(activateStoredLease(ROOT, RUN, BINDING, deps), { ok: true, reason: 'already-activated' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'retry must reuse the first published token');
  assert.match(seen[0], /^[A-Za-z0-9_-]{43}$/);

  const directory = join(stateRoot, 'deep-loop', 'activation-secrets');
  const names = readdirSync(directory);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[0-9a-f]{64}\.json$/);
  for (const raw of [ROOT, RUN, BINDING.owner, BINDING.attemptId, seen[0]]) {
    assert.equal(names[0].includes(raw), false);
  }
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(directory, names[0])).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, names[0]), 'utf8')), {
    schema_version: '1.0',
    binding: {
      project_root_sha256: sha256(ROOT), run_id: RUN, owner_run_id: BINDING.owner,
      generation: 2, runtime: 'claude', attempt_id: BINDING.attemptId,
    },
    token: seen[0],
  });
});

test('stored activation defers every private-store write until the kernel commit callback', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dl-secret-deferred-'));
  const directory = join(stateRoot, 'deep-loop', 'activation-secrets');
  let observed;
  const deps = linuxDeps(stateRoot, {
    activateLeaseFn(_root, _runId, options) {
      assert.equal(readdirSync(stateRoot).length, 0, 'no private directory before kernel eligibility');
      assert.equal(typeof options.activationTokenProvider, 'function');
      observed = options.activationTokenProvider({
        guard: { assertOwned() {}, renew() {} }, allowCreate: true,
      });
      assert.equal(readdirSync(directory).length, 1, 'provider publishes exactly one final secret');
      return { ok: true, reason: 'activated' };
    },
  });
  assert.deepEqual(activateStoredLease(ROOT, RUN, BINDING, deps), { ok: true, reason: 'activated' });
  assert.match(observed, /^[A-Za-z0-9_-]{43}$/);
});

test('stored activation rejects malformed, mismatched, unsafe and symlink entries without replacement', () => {
  for (const [label, prepare, code] of [
    ['malformed', path => writeFileSync(path, '{', { mode: 0o600 }), 'ACTIVATION_SECRET_MALFORMED'],
    ['extra key', path => writeFileSync(path, JSON.stringify({ schema_version: '1.0', binding: {}, token: 'x', extra: true }), { mode: 0o600 }), 'ACTIVATION_SECRET_MALFORMED'],
    ['unsafe mode', path => { writeFileSync(path, '{}', { mode: 0o644 }); chmodSync(path, 0o644); }, 'ACTIVATION_SECRET_UNSAFE'],
    ['symlink', path => { const target = `${path}.outside`; writeFileSync(target, '{}'); symlinkSync(target, path); }, 'ACTIVATION_SECRET_UNSAFE'],
  ]) {
    const stateRoot = mkdtempSync(join(tmpdir(), `dl-secret-${label.replace(' ', '-')}-`));
    const directory = join(stateRoot, 'deep-loop', 'activation-secrets');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const digest = sha256([ROOT, RUN, BINDING.owner, '2', 'claude', BINDING.attemptId].join('\0'));
    const path = join(directory, `${digest}.json`);
    prepare(path);
    const before = lstatSync(path).isSymbolicLink() ? null : readFileSync(path);
    assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, linuxDeps(stateRoot)),
      error => error?.message === code, label);
    if (before) assert.deepEqual(readFileSync(path), before, `${label}: existing bytes changed`);
  }
});

test('stored activation root selection rejects relative trusted config and Windows ACL must verify', () => {
  assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, linuxDeps('relative/path')),
    error => error?.message === 'ACTIVATION_SECRET_ROOT_INVALID');
  const linkedRootParent = mkdtempSync(join(tmpdir(), 'dl-secret-linked-root-'));
  const linkedRootTarget = join(linkedRootParent, 'target');
  const linkedRoot = join(linkedRootParent, 'link');
  mkdirSync(linkedRootTarget, { mode: 0o700 });
  symlinkSync(linkedRootTarget, linkedRoot);
  assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, linuxDeps(linkedRoot)),
    error => error?.message === 'ACTIVATION_SECRET_UNSAFE');

  const stateRoot = mkdtempSync(join(tmpdir(), 'dl-secret-win-'));
  let calls = 0;
  const deps = windowsDeps(stateRoot, {
    windowsAclFn: ({ kind }) => { calls += 1; return kind === 'directory'; },
  });
  assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, deps),
    error => error?.message === 'ACTIVATION_SECRET_UNSAFE');
  assert.ok(calls >= 2, 'directory and file ACLs must both be verified');
});

test('Windows ACL command absence, failure, and overbroad verification fail closed', () => {
  for (const [label, result] of [
    ['command absent', { status: null, error: Object.assign(new Error('absent'), { code: 'ENOENT' }) }],
    ['command failure', { status: 1 }],
    ['overbroad ACL', { status: 42 }],
  ]) {
    const stateRoot = mkdtempSync(join(tmpdir(), `dl-secret-win-${label.replaceAll(' ', '-')}-`));
    const calls = [];
    const deps = windowsDeps(stateRoot, {
      windowsExecutor(command, args, options) {
        calls.push({ command, args, options });
        return result;
      },
    });
    assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, deps),
      error => error?.message === 'ACTIVATION_SECRET_UNSAFE', label);
    assert.equal(calls.length, 1, label);
    assert.equal(calls[0].command,
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].args.some(arg => typeof arg === 'string' && arg.includes('WlpaWlpa')), false,
      `${label}: token must not enter process arguments`);
  }
});

test('Windows PowerShell identity ignores PATH and rejects missing, relative, or mismatched SystemRoot', () => {
  for (const [label, overrides, code] of [
    ['missing SystemRoot', { env: { PATH: 'C:\\attacker' } }, 'ACTIVATION_SECRET_ROOT_INVALID'],
    ['relative SystemRoot', { env: { SystemRoot: 'Windows', PATH: 'C:\\attacker' } }, 'ACTIVATION_SECRET_ROOT_INVALID'],
    ['mismatched executable', {
      windowsExecutableRealpathFn(path) {
        return path.endsWith('powershell.exe') ? 'C:\\attacker\\powershell.exe' : path;
      },
    }, 'ACTIVATION_SECRET_UNSAFE'],
  ]) {
    const stateRoot = mkdtempSync(join(tmpdir(), `dl-secret-win-identity-${label.replaceAll(' ', '-')}-`));
    let executed = false;
    const deps = windowsDeps(stateRoot, {
      ...overrides,
      windowsExecutor() { executed = true; return { status: 0 }; },
    });
    assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, deps),
      error => error?.message === code, label);
    assert.equal(executed, false, `${label}: untrusted executable must not run`);
  }
});

test('stored activation maps filesystem failures to closed codes without raw path or cause', () => {
  const marker = '/SECRET/attacker/chosen/path';
  const deps = linuxDeps(mkdtempSync(join(tmpdir(), 'dl-secret-io-')), {
    linkFn() { throw Object.assign(new Error(marker), { code: 'EIO' }); },
  });
  assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, deps), error => {
    assert.equal(error.message, 'ACTIVATION_SECRET_IO_UNAVAILABLE');
    assert.doesNotMatch(error.message, /attacker|chosen|path/);
    return true;
  });

  let activated = false;
  const cleanupDeps = linuxDeps(mkdtempSync(join(tmpdir(), 'dl-secret-cleanup-')), {
    unlinkFn() { throw Object.assign(new Error(marker), { code: 'EIO' }); },
    activateLeaseFn(_root, _runId, options) {
      options.activationTokenProvider({
        guard: { assertOwned() {}, renew() {} }, allowCreate: true,
      });
      activated = true;
      return { ok: true, reason: 'activated' };
    },
  });
  assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, cleanupDeps),
    error => error?.message === 'ACTIVATION_SECRET_IO_UNAVAILABLE');
  assert.equal(activated, false, 'temp cleanup failure must fail closed before lease activation');
});

test('exclusive publish race discards the losing candidate and reuses the validated winner', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dl-secret-race-'));
  const winner = Buffer.alloc(32, 0x44).toString('base64url');
  let observed;
  const deps = linuxDeps(stateRoot, {
    linkFn(temp, path) {
      const value = JSON.parse(readFileSync(temp, 'utf8'));
      value.token = winner;
      writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
      throw Object.assign(new Error('race'), { code: 'EEXIST' });
    },
    activateLeaseFn(_root, _runId, options) {
      observed = options.activationTokenProvider({
        guard: { assertOwned() {}, renew() {} }, allowCreate: true,
      });
      return { ok: true, reason: 'activated' };
    },
  });
  assert.deepEqual(activateStoredLease(ROOT, RUN, BINDING, deps), { ok: true, reason: 'activated' });
  assert.equal(observed, winner);
});

test('post-publication kernel crash preserves the explicit cross-filesystem residue seam', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'dl-secret-crash-seam-'));
  const marker = '/SECRET/kernel-crash-cause';
  assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, linuxDeps(stateRoot, {
    activateLeaseFn(_root, _runId, options) {
      options.activationTokenProvider({
        guard: { assertOwned() {}, renew() {} }, allowCreate: true,
      });
      throw new Error(marker);
    },
  })), error => error?.message === 'STATE_INVALID: stored activation kernel failure');
  const directory = join(stateRoot, 'deep-loop', 'activation-secrets');
  assert.equal(readdirSync(directory).length, 1,
    'publication before a kernel append crash is an acknowledged durable residue seam');
});

test('stored activation preserves authorized kernel taxonomy and sanitizes unknown kernel errors', () => {
  for (const message of [
    'LEASE_FENCED: owner-mismatch',
    'RUNTIME_FENCED: expected=claude actual=codex',
    'PROJECT_ROOT_FENCED: candidate differs',
    'STATE_INVALID: fixture state',
    'INVALID_RUNTIME_STATE: fixture runtime',
    'ACTIVATION_DEADLINE_INVALID',
    'RUN_TERMINAL',
  ]) {
    const stateRoot = mkdtempSync(join(tmpdir(), 'dl-secret-kernel-error-'));
    assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, linuxDeps(stateRoot, {
      activateLeaseFn() { throw new Error(message); },
    })), error => error?.message === message, message);
  }

  const marker = '/SECRET/attacker/chosen/kernel-cause';
  const stateRoot = mkdtempSync(join(tmpdir(), 'dl-secret-kernel-unknown-'));
  assert.throws(() => activateStoredLease(ROOT, RUN, BINDING, linuxDeps(stateRoot, {
    activateLeaseFn() { throw new Error(marker); },
  })), error => {
    assert.equal(error.message, 'STATE_INVALID: stored activation kernel failure');
    assert.doesNotMatch(error.message, /SECRET|attacker|chosen|kernel-cause/);
    return true;
  });
});
