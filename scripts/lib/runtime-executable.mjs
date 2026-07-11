import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import { validateSessionRuntime } from './runtime.mjs';
import { leaseCheck } from './lease.mjs';
import { appendAnchored, MUTATION_TURN_FLOOR } from './integrity.mjs';
import { validate as validateLoop } from './schema.mjs';

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BUFFER = 64 * 1024;
const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

const CODEX_TARGETS = Object.freeze({
  'darwin:arm64': Object.freeze({
    alias: '@openai/codex-darwin-arm64', suffix: 'darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex',
  }),
  'darwin:x64': Object.freeze({
    alias: '@openai/codex-darwin-x64', suffix: 'darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex',
  }),
  'linux:arm64': Object.freeze({
    alias: '@openai/codex-linux-arm64', suffix: 'linux-arm64', triple: 'aarch64-unknown-linux-musl', executable: 'codex',
  }),
  'linux:x64': Object.freeze({
    alias: '@openai/codex-linux-x64', suffix: 'linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex',
  }),
  'win32:x64': Object.freeze({
    alias: '@openai/codex-win32-x64', suffix: 'win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe',
  }),
  'win32:arm64': Object.freeze({
    alias: '@openai/codex-win32-arm64', suffix: 'win32-arm64', triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe',
  }),
});

function runtimeError(code, detail) {
  return new Error(`${code}: ${detail}`);
}

function canonicalRealpath(path) {
  const realpath = realpathSync.native || realpathSync;
  return realpath(path);
}

function absolutePath(value, code = 'RUNTIME_EXECUTABLE_PATH_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw runtimeError(code, 'an absolute filesystem path is required');
  }
  return resolve(value);
}

function bigintStat(path, { lstat = false } = {}) {
  return lstat ? lstatSync(path, { bigint: true }) : statSync(path, { bigint: true });
}

function sameNode(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function regularFile(path, { allowFinalSymlink = false } = {}) {
  const lexical = absolutePath(path);
  let before;
  try {
    before = bigintStat(lexical, { lstat: true });
  } catch (error) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', `candidate is unavailable (${error.code || 'fs-error'})`);
  }
  if (before.isSymbolicLink() && !allowFinalSymlink) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'final executable symlinks are not trusted');
  }
  let canonical;
  try {
    canonical = canonicalRealpath(lexical);
  } catch (error) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', `candidate cannot be canonicalized (${error.code || 'fs-error'})`);
  }
  const target = bigintStat(canonical, { lstat: true });
  if (target.isSymbolicLink() || !target.isFile()) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'candidate must resolve to a regular non-symlink file');
  }
  if (!before.isSymbolicLink() && !sameNode(before, target)) {
    throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'candidate identity changed during canonicalization');
  }
  return { lexical, canonical, stat: target };
}

function directoryIdentity(path, platform) {
  const lexical = absolutePath(path, 'CODEX_HOME_INVALID');
  let before;
  try {
    before = bigintStat(lexical, { lstat: true });
  } catch (error) {
    throw runtimeError('CODEX_HOME_INVALID', `directory is unavailable (${error.code || 'fs-error'})`);
  }
  if (before.isSymbolicLink()) throw runtimeError('CODEX_HOME_INVALID', 'final symlinks are forbidden');
  if (!before.isDirectory()) throw runtimeError('CODEX_HOME_INVALID', 'path must be a directory');

  let canonical;
  try {
    canonical = canonicalRealpath(lexical);
  } catch (error) {
    throw runtimeError('CODEX_HOME_INVALID', `directory cannot be canonicalized (${error.code || 'fs-error'})`);
  }
  const afterLexical = bigintStat(lexical, { lstat: true });
  const canonicalStat = bigintStat(canonical, { lstat: true });
  if (afterLexical.isSymbolicLink() || !afterLexical.isDirectory() || !canonicalStat.isDirectory()
    || !sameNode(before, afterLexical) || !sameNode(afterLexical, canonicalStat)) {
    throw runtimeError('CODEX_HOME_DRIFT', 'directory identity changed during authentication');
  }
  return {
    canonical_path: canonical,
    device: String(canonicalStat.dev),
    inode: String(canonicalStat.ino),
    birthtime_ns: String(canonicalStat.birthtimeNs),
    platform,
  };
}

function readJsonFile(path, label) {
  const file = regularFile(path);
  if (file.stat.size > BigInt(PACKAGE_JSON_MAX_BYTES)) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', `${label} package metadata is too large`);
  }
  try {
    return JSON.parse(readFileSync(file.canonical, 'utf8'));
  } catch {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', `${label} package metadata is invalid JSON`);
  }
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hashRegularFile(path, expectedStat = null) {
  const before = bigintStat(path, { lstat: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'hash target must be a regular non-symlink file');
  }
  if (expectedStat && !sameNode(expectedStat, before)) {
    throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'executable changed before hashing');
  }
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  const after = bigintStat(path, { lstat: true });
  if (!sameNode(before, after)) throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'executable changed while hashing');
  return hash.digest('hex');
}

function optionalPackageCandidates(wrapperRoot, alias) {
  const segments = alias.split('/');
  const candidates = [join(wrapperRoot, 'node_modules', ...segments)];
  let cursor = wrapperRoot;
  const filesystemRoot = parse(cursor).root;
  while (cursor !== filesystemRoot) {
    if (basename(cursor) === 'node_modules') candidates.push(join(cursor, ...segments));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (basename(filesystemRoot) === 'node_modules') candidates.push(join(filesystemRoot, ...segments));
  return [...new Set(candidates)];
}

function locateOptionalPackage(wrapperRoot, alias) {
  for (const candidate of optionalPackageCandidates(wrapperRoot, alias)) {
    if (!existsSync(join(candidate, 'package.json'))) continue;
    try {
      const lexical = absolutePath(candidate);
      const before = bigintStat(lexical, { lstat: true });
      const canonical = canonicalRealpath(lexical);
      const after = bigintStat(canonical, { lstat: true });
      if (!after.isDirectory()) continue;
      if (!before.isSymbolicLink() && !sameNode(before, after)) continue;
      return canonical;
    } catch {
      // Discovery is non-authoritative. A malformed candidate is skipped and cannot win by ordering.
    }
  }
  throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', `declared optional package ${alias} is unavailable`);
}

function probeVersion(executable, expectedVersion, runVersion = spawnSync) {
  const result = runVersion(executable, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: VERSION_MAX_BUFFER,
    windowsHide: true,
    env: {},
  });
  if (!result || result.error || result.status !== 0 || result.signal) {
    throw runtimeError('RUNTIME_EXECUTABLE_VERSION_INVALID', 'bounded direct --version probe failed');
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '');
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr || '');
  if (Buffer.byteLength(stdout) > 1024 || Buffer.byteLength(stderr) > 1024 || stderr.trim() !== '') {
    throw runtimeError('RUNTIME_EXECUTABLE_VERSION_INVALID', 'version output is not a bounded clean line');
  }
  const normalized = stdout.replace(/\r\n/g, '\n').trimEnd();
  if (normalized.includes('\n') || /[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)
    || normalized !== `codex-cli ${expectedVersion}`) {
    throw runtimeError('RUNTIME_EXECUTABLE_VERSION_INVALID', 'version output does not match package metadata');
  }
  return expectedVersion;
}

function probeExplicitCodexVersion(executable, runVersion = spawnSync, expectedVersion = null) {
  const result = runVersion(executable, ['--version'], {
    encoding: 'utf8', shell: false, timeout: VERSION_TIMEOUT_MS, maxBuffer: VERSION_MAX_BUFFER,
    windowsHide: true, env: {},
  });
  if (!result || result.error || result.status !== 0 || result.signal) {
    throw runtimeError('RUNTIME_EXECUTABLE_VERSION_INVALID', 'bounded direct --version probe failed');
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '');
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr || '');
  const normalized = stdout.replace(/\r\n/g, '\n').trimEnd();
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/.exec(normalized);
  if (!match || normalized.includes('\n') || stderr.trim() !== ''
    || Buffer.byteLength(stdout) > 1024 || Buffer.byteLength(stderr) > 1024
    || (expectedVersion !== null && match[1] !== expectedVersion)) {
    throw runtimeError('RUNTIME_EXECUTABLE_VERSION_INVALID', 'version output is not a matching bounded Codex line');
  }
  return match[1];
}

function probeExplicitClaudeVersion(executable, runVersion = spawnSync, expectedVersion = null) {
  const result = runVersion(executable, ['--version'], {
    encoding: 'utf8', shell: false, timeout: VERSION_TIMEOUT_MS, maxBuffer: VERSION_MAX_BUFFER,
    windowsHide: true, env: {},
  });
  if (!result || result.error || result.status !== 0 || result.signal) {
    throw runtimeError('RUNTIME_EXECUTABLE_VERSION_INVALID', 'bounded direct --version probe failed');
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '');
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr || '');
  const normalized = stdout.replace(/\r\n/g, '\n').trimEnd();
  const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?: \(Claude Code\))?$/.exec(normalized);
  if (!match || normalized.includes('\n') || stderr.trim() !== ''
    || Buffer.byteLength(stdout) > 1024 || Buffer.byteLength(stderr) > 1024
    || (expectedVersion !== null && match[1] !== expectedVersion)) {
    throw runtimeError('RUNTIME_EXECUTABLE_VERSION_INVALID', 'version output is not a matching bounded Claude line');
  }
  return match[1];
}

function probeExplicitRuntimeVersion(runtime, executable, runVersion = spawnSync, expectedVersion = null) {
  return runtime === 'claude'
    ? probeExplicitClaudeVersion(executable, runVersion, expectedVersion)
    : probeExplicitCodexVersion(executable, runVersion, expectedVersion);
}

function normalizeAuthenticode(executable, { platform, authenticodeProbe, authenticodePolicy } = {}) {
  if (platform !== 'win32') return null;
  if (authenticodeProbe == null) {
    if (authenticodePolicy != null) {
      throw runtimeError('RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID', 'configured policy requires an Authenticode observation');
    }
    return null;
  }
  if (typeof authenticodeProbe !== 'function') {
    throw runtimeError('RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID', 'Authenticode probe must be a function');
  }
  let observed;
  try {
    observed = authenticodeProbe(executable, { timeoutMs: VERSION_TIMEOUT_MS, shell: false });
  } catch {
    throw runtimeError('RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID', 'Authenticode signer probe failed');
  }
  if (observed == null) {
    if (authenticodePolicy != null) {
      throw runtimeError('RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID', 'configured policy requires an Authenticode observation');
    }
    return null;
  }
  const status = typeof observed.status === 'string' ? observed.status.trim().toLowerCase() : '';
  const signer = typeof observed.signer === 'string' ? observed.signer.trim() : '';
  const thumbprint = typeof observed.thumbprint === 'string'
    ? observed.thumbprint.replace(/[\s:]/g, '').toLowerCase()
    : '';
  if (status !== 'valid' || !signer || signer.length > 512 || !/^[0-9a-f]+$/.test(thumbprint) || thumbprint.length > 256) {
    throw runtimeError('RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID', 'Authenticode observation is invalid');
  }
  if (authenticodePolicy != null) {
    if (!authenticodePolicy || typeof authenticodePolicy !== 'object' || Array.isArray(authenticodePolicy)) {
      throw runtimeError('RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID', 'Authenticode policy is invalid');
    }
    const expectedSigner = authenticodePolicy.signer;
    const expectedThumbprint = typeof authenticodePolicy.thumbprint === 'string'
      ? authenticodePolicy.thumbprint.replace(/[\s:]/g, '').toLowerCase()
      : null;
    if ((expectedSigner != null && signer !== expectedSigner)
      || (expectedThumbprint != null && thumbprint !== expectedThumbprint)) {
      throw runtimeError('RUNTIME_EXECUTABLE_AUTHENTICODE_INVALID', 'Authenticode signer policy mismatch');
    }
  }
  return { status, signer, thumbprint };
}

function assertApprovableNativePath(path) {
  if (/\.(?:cmd|bat|ps1|js|mjs|cjs)$/i.test(path)) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'script and shell shim executables cannot be approved');
  }
}

function inspectHumanApprovedExecutable(runtime, candidatePath, {
  platform, arch, expectedSha256, runVersion, authenticodeProbe, authenticodePolicy,
}) {
  const candidate = regularFile(candidatePath);
  assertApprovableNativePath(candidate.canonical);
  const sha256 = hashRegularFile(candidate.canonical, candidate.stat);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 || '') || sha256 !== expectedSha256) {
    throw runtimeError('RUNTIME_EXECUTABLE_HASH_MISMATCH', 'exact lowercase SHA-256 does not match the canonical executable');
  }
  const version = probeExplicitRuntimeVersion(runtime, candidate.canonical, runVersion);
  const authenticode = normalizeAuthenticode(candidate.canonical, {
    platform, authenticodeProbe, authenticodePolicy,
  });
  return {
    runtime,
    canonical_path: candidate.canonical,
    sha256,
    version,
    platform,
    arch,
    source: 'human-explicit',
    package: null,
    authenticode,
  };
}

function officialWrapperCandidate(candidatePath, platform) {
  const candidate = regularFile(candidatePath, { allowFinalSymlink: true });
  if (basename(candidate.canonical) === 'codex.js' && basename(dirname(candidate.canonical)) === 'bin') {
    return candidate.canonical;
  }
  if (platform !== 'win32' || !/^codex\.(?:cmd|bat|ps1)$/i.test(basename(candidate.canonical))) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'candidate is not the official JavaScript wrapper entrypoint');
  }
  const adjacent = join(dirname(candidate.canonical), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return regularFile(adjacent, { allowFinalSymlink: true }).canonical;
}

function resolveOfficialCodex(candidatePath, {
  platform, arch, runVersion, authenticodeProbe, authenticodePolicy,
}) {
  const target = CODEX_TARGETS[`${platform}:${arch}`];
  if (!target) throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', `unsupported Codex target ${platform}/${arch}`);
  const wrapper = regularFile(officialWrapperCandidate(candidatePath, platform), { allowFinalSymlink: true });
  if (basename(wrapper.canonical) !== 'codex.js' || basename(dirname(wrapper.canonical)) !== 'bin') {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'candidate is not the official JavaScript wrapper entrypoint');
  }

  const wrapperRoot = dirname(dirname(wrapper.canonical));
  const wrapperPackage = readJsonFile(join(wrapperRoot, 'package.json'), 'wrapper');
  if (wrapperPackage?.name !== '@openai/codex' || !SAFE_VERSION.test(wrapperPackage?.version || '')
    || wrapperPackage?.bin?.codex !== 'bin/codex.js') {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'wrapper package provenance mismatch');
  }
  const optionalSpec = `npm:@openai/codex@${wrapperPackage.version}-${target.suffix}`;
  if (wrapperPackage?.optionalDependencies?.[target.alias] !== optionalSpec) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'wrapper optional-package alias mismatch');
  }

  const optionalRoot = locateOptionalPackage(wrapperRoot, target.alias);
  const nativePackage = readJsonFile(join(optionalRoot, 'package.json'), 'native');
  const expectedNativeVersion = `${wrapperPackage.version}-${target.suffix}`;
  if (nativePackage?.name !== '@openai/codex' || nativePackage?.version !== expectedNativeVersion
    || !Array.isArray(nativePackage.os) || nativePackage.os.length !== 1 || nativePackage.os[0] !== platform
    || !Array.isArray(nativePackage.cpu) || nativePackage.cpu.length !== 1 || nativePackage.cpu[0] !== arch) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'native optional-package provenance mismatch');
  }

  const nativeLexical = join(optionalRoot, 'vendor', target.triple, 'bin', target.executable);
  const native = regularFile(nativeLexical);
  if (!contained(optionalRoot, native.canonical)) {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', 'native executable escapes its optional package');
  }
  const sha256 = hashRegularFile(native.canonical, native.stat);
  const version = probeVersion(native.canonical, wrapperPackage.version, runVersion);
  const authenticode = normalizeAuthenticode(native.canonical, {
    platform, authenticodeProbe, authenticodePolicy,
  });
  return {
    runtime: 'codex',
    canonical_path: native.canonical,
    sha256,
    version,
    platform,
    arch,
    source: 'official-npm-native',
    package: {
      wrapper_path: wrapper.canonical,
      wrapper_name: wrapperPackage.name,
      wrapper_version: wrapperPackage.version,
      optional_name: target.alias,
      optional_spec: optionalSpec,
      native_name: nativePackage.name,
      native_version: nativePackage.version,
      target_triple: target.triple,
      os: [...nativePackage.os],
      cpu: [...nativePackage.cpu],
    },
    authenticode,
  };
}

function securityIdentity(identity) {
  return {
    runtime: identity.runtime,
    canonical_path: identity.canonical_path,
    sha256: identity.sha256,
    version: identity.version,
    platform: identity.platform,
    arch: identity.arch,
    source: identity.source,
    package: identity.package ?? null,
    authenticode: identity.authenticode ?? null,
  };
}

function assertIdentityShape(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw runtimeError('RUNTIME_EXECUTABLE_IDENTITY_INVALID', 'identity must be an object');
  }
  validateSessionRuntime(identity.runtime);
  absolutePath(identity.canonical_path, 'RUNTIME_EXECUTABLE_IDENTITY_INVALID');
  if (!/^[0-9a-f]{64}$/.test(identity.sha256 || '') || typeof identity.version !== 'string'
    || identity.version.length === 0 || typeof identity.platform !== 'string' || typeof identity.arch !== 'string'
    || typeof identity.source !== 'string') {
    throw runtimeError('RUNTIME_EXECUTABLE_IDENTITY_INVALID', 'identity fields are invalid');
  }
}

export function collectRuntimeExecutableCandidates(runtime, options = {}) {
  validateSessionRuntime(runtime);
  const platform = options.platform ?? process.platform;
  const executableName = runtime === 'codex' ? 'codex' : 'claude';
  const candidates = [];
  const add = (path, source) => {
    const absolute = absolutePath(path);
    if (!candidates.some(candidate => candidate.path === absolute)) candidates.push({ path: absolute, source });
  };

  if (options.explicitPath !== undefined) {
    add(options.explicitPath, 'explicit');
    return candidates;
  }
  if (options.candidatePaths !== undefined) {
    if (!Array.isArray(options.candidatePaths)) {
      throw runtimeError('RUNTIME_EXECUTABLE_PATH_INVALID', 'candidatePaths must be an array');
    }
    for (const candidate of options.candidatePaths) {
      if (typeof candidate === 'string') add(candidate, 'provided');
      else if (candidate && typeof candidate.path === 'string') add(candidate.path, candidate.source || 'provided');
      else throw runtimeError('RUNTIME_EXECUTABLE_PATH_INVALID', 'candidate path must be a string');
    }
    return candidates;
  }

  const env = options.env ?? process.env;
  const pathValue = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '');
  const pathDelimiter = platform === 'win32' ? ';' : delimiter;
  const names = platform === 'win32'
    ? [`${executableName}.cmd`, `${executableName}.exe`, `${executableName}.bat`, `${executableName}.ps1`, executableName]
    : [executableName];
  for (const entry of String(pathValue).split(pathDelimiter)) {
    // Empty/relative entries resolve through cwd and are therefore shadow candidates, never authority.
    if (!entry || !isAbsolute(entry)) continue;
    for (const name of names) {
      const candidate = join(entry, name);
      if (existsSync(candidate)) add(candidate, 'path-search');
    }
  }
  return candidates;
}

export function resolveTrustedRuntimeExecutable(runtime, options = {}) {
  validateSessionRuntime(runtime);
  if (options.approval !== undefined) {
    if (options.approval?.runtime !== runtime) {
      throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'approval runtime does not match requested runtime');
    }
    return revalidateTrustedRuntimeExecutable(options.approval, options);
  }
  if (runtime !== 'codex') {
    throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', `${runtime} native trust is not implemented on this platform slice`);
  }
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const candidates = collectRuntimeExecutableCandidates(runtime, { ...options, platform });
  const resolved = new Map();
  const failures = [];
  for (const candidate of candidates) {
    try {
      const identity = resolveOfficialCodex(candidate.path, {
        platform,
        arch,
        runVersion: options.runVersion ?? spawnSync,
        authenticodeProbe: options.authenticodeProbe,
        authenticodePolicy: options.authenticodePolicy,
      });
      resolved.set(identity.canonical_path, identity);
    } catch (error) {
      failures.push(String(error?.message || error));
    }
  }
  if (resolved.size === 1) return [...resolved.values()][0];
  if (resolved.size > 1) {
    throw runtimeError('RUNTIME_EXECUTABLE_AMBIGUOUS', 'multiple distinct trusted native executables were found');
  }
  throw runtimeError('RUNTIME_EXECUTABLE_UNTRUSTED', failures[0] || 'no trusted native executable candidate was found');
}

export function revalidateTrustedRuntimeExecutable(identity, options = {}) {
  assertIdentityShape(identity);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (identity.platform !== platform || identity.arch !== arch) {
    throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'platform or architecture changed');
  }
  try {
    const executable = regularFile(identity.canonical_path);
    if (executable.canonical !== identity.canonical_path
      || hashRegularFile(executable.canonical, executable.stat) !== identity.sha256) {
      throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'canonical path or hash changed');
    }
    let current;
    if (identity.source === 'official-npm-native' && identity.package?.wrapper_path !== undefined) {
      current = resolveTrustedRuntimeExecutable(identity.runtime, {
        candidatePaths: [identity.package.wrapper_path],
        platform,
        arch,
        runVersion: options.runVersion ?? spawnSync,
        authenticodeProbe: options.authenticodeProbe,
        authenticodePolicy: options.authenticodePolicy,
      });
    } else if (identity.source === 'human-explicit' && identity.package === null) {
      const version = probeExplicitRuntimeVersion(
        identity.runtime, executable.canonical, options.runVersion ?? spawnSync, identity.version,
      );
      const authenticode = identity.authenticode == null && options.authenticodePolicy == null
        ? null
        : normalizeAuthenticode(executable.canonical, {
          platform,
          authenticodeProbe: options.authenticodeProbe,
          authenticodePolicy: options.authenticodePolicy,
        });
      current = { ...securityIdentity(identity), version, authenticode };
    } else {
      throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'unsupported identity source');
    }
    if (JSON.stringify(securityIdentity(current)) !== JSON.stringify(securityIdentity(identity))) {
      throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'trusted executable identity changed');
    }
    return identity;
  } catch (error) {
    if (String(error?.message || error).startsWith('RUNTIME_EXECUTABLE_DRIFT:')) throw error;
    throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', String(error?.message || error));
  }
}

const WINDOWS_POWERSHELL_CANDIDATES = Object.freeze([
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
]);

function launcherIdentityShape(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
    || !['wt', 'powershell'].includes(identity.kind)) {
    throw runtimeError('LAUNCHER_EXECUTABLE_IDENTITY_INVALID', 'launcher identity is invalid');
  }
  absolutePath(identity.canonical_path, 'LAUNCHER_EXECUTABLE_IDENTITY_INVALID');
  if (!/^[0-9a-f]{64}$/.test(identity.sha256 || '') || typeof identity.version !== 'string'
    || identity.version.length === 0 || identity.platform !== 'win32'
    || typeof identity.arch !== 'string' || identity.source !== 'verified-native') {
    throw runtimeError('LAUNCHER_EXECUTABLE_IDENTITY_INVALID', 'launcher identity fields are invalid');
  }
}

function launcherSecurityIdentity(identity) {
  return {
    kind: identity.kind,
    canonical_path: identity.canonical_path,
    sha256: identity.sha256,
    version: identity.version,
    platform: identity.platform,
    arch: identity.arch,
    source: identity.source,
    authenticode: identity.authenticode ?? null,
  };
}

function assertExpectedLauncherName(kind, path) {
  const name = basename(path).toLowerCase();
  if ((kind === 'wt' && name !== 'wt.exe')
    || (kind === 'powershell' && name !== 'pwsh.exe' && name !== 'powershell.exe')) {
    throw runtimeError('LAUNCHER_EXECUTABLE_UNTRUSTED', 'unexpected native launcher filename');
  }
  if (/^(?:\\\\|\/\/)/.test(path)) {
    throw runtimeError('LAUNCHER_EXECUTABLE_UNTRUSTED', 'UNC launcher targets are not trusted');
  }
  assertApprovableNativePath(path);
}

function probeLauncherVersion(kind, executable, runVersion = spawnSync, expectedVersion = null) {
  const isWindowsPowerShell = kind === 'powershell' && basename(executable).toLowerCase() === 'powershell.exe';
  const argv = kind === 'wt'
    ? ['--version']
    : (isWindowsPowerShell
      ? ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
      : ['--version']);
  const result = runVersion(executable, argv, {
    encoding: 'utf8', shell: false, timeout: VERSION_TIMEOUT_MS, maxBuffer: VERSION_MAX_BUFFER,
    windowsHide: true, env: {},
  });
  if (!result || result.error || result.status !== 0 || result.signal) {
    throw runtimeError('LAUNCHER_EXECUTABLE_VERSION_INVALID', 'bounded direct version probe failed');
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : String(result.stdout || '');
  const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.stderr || '');
  const normalized = stdout.replace(/\r\n/g, '\n').trimEnd();
  let version;
  if (kind === 'wt') version = /^Windows Terminal ([0-9]+(?:\.[0-9]+)+)$/.exec(normalized)?.[1] ?? null;
  else version = /^(?:PowerShell )?([0-9]+(?:\.[0-9]+)+)$/.exec(normalized)?.[1] ?? null;
  if (!version || normalized.includes('\n') || stderr.trim() !== ''
    || Buffer.byteLength(stdout) > 1024 || Buffer.byteLength(stderr) > 1024
    || (expectedVersion !== null && version !== expectedVersion)) {
    throw runtimeError('LAUNCHER_EXECUTABLE_VERSION_INVALID', 'version output is not a matching bounded launcher line');
  }
  return version;
}

function collectLauncherCandidates(kind, options) {
  if (options.candidatePaths !== undefined) {
    if (!Array.isArray(options.candidatePaths)) {
      throw runtimeError('LAUNCHER_EXECUTABLE_PATH_INVALID', 'candidatePaths must be an array');
    }
    return options.candidatePaths.map(path => absolutePath(path, 'LAUNCHER_EXECUTABLE_PATH_INVALID'));
  }
  const candidates = [];
  const add = (path) => {
    try {
      const absolute = absolutePath(path, 'LAUNCHER_EXECUTABLE_PATH_INVALID');
      if (existsSync(absolute) && !candidates.includes(absolute)) candidates.push(absolute);
    } catch {
      // Candidate discovery is not authority.
    }
  };
  if (kind === 'powershell') for (const candidate of WINDOWS_POWERSHELL_CANDIDATES) add(candidate);
  const env = options.env ?? process.env;
  const names = kind === 'wt' ? ['wt.exe'] : ['pwsh.exe', 'powershell.exe'];
  for (const entry of String(env.Path ?? env.PATH ?? '').split(';')) {
    if (!entry || !(isAbsolute(entry) || win32.isAbsolute(entry))) continue;
    for (const name of names) add(join(entry, name));
  }
  return candidates;
}

export function resolveTrustedLauncherExecutable(kind, options = {}) {
  if (!['wt', 'powershell'].includes(kind)) {
    throw runtimeError('LAUNCHER_EXECUTABLE_UNTRUSTED', 'unsupported Windows launcher');
  }
  if (options.approval !== undefined) return revalidateTrustedLauncherExecutable(options.approval, options);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'win32') throw runtimeError('LAUNCHER_EXECUTABLE_UNTRUSTED', 'Windows launcher requires win32');
  const resolved = new Map();
  const failures = [];
  for (const candidatePath of collectLauncherCandidates(kind, options)) {
    try {
      const candidate = regularFile(candidatePath);
      assertExpectedLauncherName(kind, candidate.canonical);
      const sha256 = hashRegularFile(candidate.canonical, candidate.stat);
      const version = probeLauncherVersion(kind, candidate.canonical, options.runVersion ?? spawnSync);
      const authenticode = normalizeAuthenticode(candidate.canonical, {
        platform, authenticodeProbe: options.authenticodeProbe, authenticodePolicy: options.authenticodePolicy,
      });
      const identity = {
        kind, canonical_path: candidate.canonical, sha256, version, platform, arch,
        source: 'verified-native', authenticode,
      };
      resolved.set(identity.canonical_path, identity);
    } catch (error) {
      failures.push(String(error?.message || error));
    }
  }
  if (resolved.size === 1) return [...resolved.values()][0];
  if (resolved.size > 1) throw runtimeError('LAUNCHER_EXECUTABLE_AMBIGUOUS', 'multiple launcher identities were found');
  throw runtimeError('LAUNCHER_EXECUTABLE_UNTRUSTED', failures[0] || 'no verified launcher candidate was found');
}

export function revalidateTrustedLauncherExecutable(identity, options = {}) {
  launcherIdentityShape(identity);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== identity.platform || arch !== identity.arch) {
    throw runtimeError('LAUNCHER_EXECUTABLE_DRIFT', 'launcher platform or architecture changed');
  }
  try {
    const candidate = regularFile(identity.canonical_path);
    assertExpectedLauncherName(identity.kind, candidate.canonical);
    if (candidate.canonical !== identity.canonical_path
      || hashRegularFile(candidate.canonical, candidate.stat) !== identity.sha256) {
      throw runtimeError('LAUNCHER_EXECUTABLE_DRIFT', 'launcher canonical path or hash changed');
    }
    const version = probeLauncherVersion(
      identity.kind, candidate.canonical, options.runVersion ?? spawnSync, identity.version,
    );
    const authenticode = identity.authenticode == null && options.authenticodePolicy == null
      ? null
      : normalizeAuthenticode(candidate.canonical, {
        platform, authenticodeProbe: options.authenticodeProbe, authenticodePolicy: options.authenticodePolicy,
      });
    const current = { ...launcherSecurityIdentity(identity), version, authenticode };
    if (JSON.stringify(current) !== JSON.stringify(launcherSecurityIdentity(identity))) {
      throw runtimeError('LAUNCHER_EXECUTABLE_DRIFT', 'launcher identity changed');
    }
    return identity;
  } catch (error) {
    if (String(error?.message || error).startsWith('LAUNCHER_EXECUTABLE_DRIFT:')) throw error;
    throw runtimeError('LAUNCHER_EXECUTABLE_DRIFT', String(error?.message || error));
  }
}

export function resolveAuthenticatedCodexHome(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const selected = options.path ?? env.CODEX_HOME ?? join(options.homeDirectory ?? homedir(), '.codex');
  const current = directoryIdentity(selected, platform);
  if (options.expectedIdentity !== undefined) {
    const expected = options.expectedIdentity;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
      || typeof expected.canonical_path !== 'string' || typeof expected.device !== 'string'
      || typeof expected.inode !== 'string' || typeof expected.birthtime_ns !== 'string'
      || typeof expected.platform !== 'string') {
      throw runtimeError('CODEX_HOME_INVALID', 'expected directory identity is malformed');
    }
    if (current.canonical_path !== expected.canonical_path || current.device !== expected.device
      || current.inode !== expected.inode || current.birthtime_ns !== expected.birthtime_ns
      || current.platform !== expected.platform) {
      throw runtimeError('CODEX_HOME_DRIFT', 'authenticated directory identity changed');
    }
  }
  return current;
}

export function diagnoseRuntimeExecutable(runtime, options = {}) {
  validateSessionRuntime(runtime);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  try {
    const identity = resolveTrustedRuntimeExecutable(runtime, options);
    return { approval_required: true, identity };
  } catch (officialError) {
    if (options.explicitPath === undefined) throw officialError;
    const candidate = regularFile(options.explicitPath);
    assertApprovableNativePath(candidate.canonical);
    const sha256 = hashRegularFile(candidate.canonical, candidate.stat);
    return {
      approval_required: true,
      identity: {
        runtime,
        canonical_path: candidate.canonical,
        sha256,
        version: null,
        platform,
        arch,
        source: 'human-explicit',
        package: null,
        authenticode: null,
        version_probe: 'deferred-until-human-approval',
      },
    };
  }
}

export function approveRuntimeExecutable(root, runId, {
  runtime,
  candidatePath,
  expectedCanonicalPath,
  expectedSha256,
  actor,
  confirm,
  fence,
  now = Date.now(),
  platform = process.platform,
  arch = process.arch,
  runVersion = spawnSync,
  authenticodeProbe,
  authenticodePolicy,
} = {}) {
  validateSessionRuntime(runtime);
  if (actor !== 'human') throw runtimeError('INVALID_ACTOR', 'runtime executable approval requires actor human');
  if (confirm !== true) throw runtimeError('CONFIRM_REQUIRED', 'runtime executable approval requires confirmation');
  const expectedPath = absolutePath(expectedCanonicalPath, 'RUNTIME_EXECUTABLE_PATH_INVALID');
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 || '')) {
    throw runtimeError('RUNTIME_EXECUTABLE_HASH_INVALID', 'exact lowercase SHA-256 is required');
  }
  const approvedAt = new Date(now);
  if (!Number.isFinite(approvedAt.getTime())) throw runtimeError('INVALID_NOW', 'runtime executable approval timestamp');

  let identity;
  try {
    identity = resolveTrustedRuntimeExecutable(runtime, {
      explicitPath: candidatePath, platform, arch, runVersion, authenticodeProbe, authenticodePolicy,
    });
  } catch (officialError) {
    identity = inspectHumanApprovedExecutable(runtime, candidatePath, {
      platform, arch, expectedSha256, runVersion, authenticodeProbe, authenticodePolicy,
    });
  }
  if (identity.canonical_path !== expectedPath) {
    throw runtimeError('RUNTIME_EXECUTABLE_PATH_MISMATCH', 'diagnosed canonical path does not match approval');
  }
  if (identity.sha256 !== expectedSha256) {
    throw runtimeError('RUNTIME_EXECUTABLE_HASH_MISMATCH', 'diagnosed SHA-256 does not match approval');
  }
  const approval = {
    ...securityIdentity(identity),
    approved_by: 'human',
    approved_at: approvedAt.toISOString(),
  };
  const eventData = {
    runtime: approval.runtime,
    canonical_path: approval.canonical_path,
    sha256: approval.sha256,
    version: approval.version,
    source: approval.source,
    actor: 'human',
  };

  appendAnchored(root, runId, { type: 'runtime-executable-approved', data: eventData },
    (loop) => { loop.autonomy.runtime_executable_approval = approval; },
    (loop) => {
      const lease = leaseCheck(loop, { ...fence, runtime, intent: 'recover' });
      if (!lease.ok) {
        if (lease.reason === 'RUNTIME_FENCED') throw runtimeError('RUNTIME_FENCED', 'stored runtime does not match approval');
        if (lease.reason === 'RUN_TERMINAL' || lease.reason === 'no-lease') {
          throw runtimeError('RUNTIME_EXECUTABLE_STATE_INVALID', lease.reason);
        }
        throw runtimeError('LEASE_FENCED', lease.reason);
      }
      let fresh;
      try {
        fresh = resolveTrustedRuntimeExecutable(runtime, {
          explicitPath: candidatePath, platform, arch, runVersion, authenticodeProbe, authenticodePolicy,
        });
      } catch {
        fresh = inspectHumanApprovedExecutable(runtime, candidatePath, {
          platform, arch, expectedSha256, runVersion, authenticodeProbe, authenticodePolicy,
        });
      }
      if (JSON.stringify(securityIdentity(fresh)) !== JSON.stringify(securityIdentity(identity))
        || fresh.canonical_path !== expectedPath || fresh.sha256 !== expectedSha256) {
        throw runtimeError('RUNTIME_EXECUTABLE_DRIFT', 'candidate changed before the approval transaction');
      }
      const candidateLoop = structuredClone(loop);
      candidateLoop.autonomy.runtime_executable_approval = approval;
      const validation = validateLoop(candidateLoop);
      if (!validation.ok) {
        throw runtimeError('STATE_INVALID', `runtime executable approval would violate schema (${validation.errors.join('; ')})`);
      }
    },
    { floor: MUTATION_TURN_FLOOR });
  return { ok: true, approval };
}
