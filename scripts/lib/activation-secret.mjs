import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, linkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep, win32 as winPath } from 'node:path';
import { spawnSync } from 'node:child_process';
import { activateLease } from './lease.mjs';
import { canonicalProjectRoot } from './project-root.mjs';

const CLOSED = new Set([
  'ACTIVATION_SECRET_ROOT_INVALID',
  'ACTIVATION_SECRET_UNSAFE',
  'ACTIVATION_SECRET_MALFORMED',
  'ACTIVATION_SECRET_BINDING_MISMATCH',
  'ACTIVATION_SECRET_IO_UNAVAILABLE',
]);
const EXACT_TOP = ['binding', 'schema_version', 'token'];
const EXACT_BINDING = [
  'attempt_id', 'generation', 'owner_run_id', 'project_root_sha256', 'run_id', 'runtime',
];
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function closed(code) { return new Error(code); }
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function stateRoot({ platform, env, homedirFn, testStateRoot }) {
  if (testStateRoot !== undefined) return testStateRoot;
  if (platform === 'darwin') return join(homedirFn(), 'Library', 'Application Support');
  if (platform === 'linux') return env.XDG_STATE_HOME || join(homedirFn(), '.local', 'state');
  if (platform === 'win32') return env.LOCALAPPDATA;
  throw closed('ACTIVATION_SECRET_ROOT_INVALID');
}

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $args[0]
$kind = $args[1]
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$inheritance = if ($kind -eq 'directory') { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.SetOwner($sid)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
$check = Get-Acl -LiteralPath $target
if ((New-Object System.Security.Principal.NTAccount($check.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 41 }
$allow = @($check.Access | Where-Object { $_.AccessControlType -eq 'Allow' })
if ($allow.Count -ne 1 -or $allow[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or (($allow[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq 0)) { exit 42 }
exit 0
`;

function trustedWindowsPowerShell({ env, lstatFn, realpathFn }) {
  const systemRoot = env.SystemRoot;
  if (typeof systemRoot !== 'string' || !winPath.isAbsolute(systemRoot)) {
    throw closed('ACTIVATION_SECRET_ROOT_INVALID');
  }
  const relativeExecutable = winPath.join('System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const expected = winPath.join(systemRoot, relativeExecutable);
  const rootStat = lstatFn(systemRoot);
  const executableStat = lstatFn(expected);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw closed('ACTIVATION_SECRET_UNSAFE');
  }
  const canonicalRoot = winPath.normalize(realpathFn(systemRoot));
  const canonicalExecutable = winPath.normalize(realpathFn(expected));
  const boundExecutable = winPath.normalize(winPath.join(canonicalRoot, relativeExecutable));
  if (canonicalExecutable.toLowerCase() !== boundExecutable.toLowerCase()) {
    throw closed('ACTIVATION_SECRET_UNSAFE');
  }
  const rel = winPath.relative(canonicalRoot, canonicalExecutable);
  if (rel.startsWith(`..${winPath.sep}`) || rel === '..' || winPath.isAbsolute(rel)) {
    throw closed('ACTIVATION_SECRET_UNSAFE');
  }
  return canonicalExecutable;
}

function defaultWindowsAcl({ path, kind }, execute, executable) {
  const result = execute(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT, path, kind,
  ], { shell: false, stdio: 'ignore', windowsHide: true });
  return result.status === 0 && !result.error;
}

function validateMode(stat, wanted, platform) {
  return platform === 'win32' || (stat.mode & 0o777) === wanted;
}

function ensureDirectory(path, { platform, mkdirFn, lstatFn, realpathFn, windowsAclFn }) {
  try {
    mkdirFn(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = lstatFn(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !validateMode(stat, 0o700, platform)) {
    throw closed('ACTIVATION_SECRET_UNSAFE');
  }
  realpathFn(path);
  if (platform === 'win32' && !windowsAclFn({ path, kind: 'directory' })) {
    throw closed('ACTIVATION_SECRET_UNSAFE');
  }
}

function parseStored(bytes, expected, stat, platform, windowsAclFn, path) {
  if (!stat.isFile() || stat.isSymbolicLink() || !validateMode(stat, 0o600, platform)) {
    throw closed('ACTIVATION_SECRET_UNSAFE');
  }
  if (platform === 'win32' && !windowsAclFn({ path, kind: 'file' })) {
    throw closed('ACTIVATION_SECRET_UNSAFE');
  }
  let value;
  try { value = JSON.parse(bytes); } catch { throw closed('ACTIVATION_SECRET_MALFORMED'); }
  if (!exactKeys(value, EXACT_TOP) || value.schema_version !== '1.0'
    || !exactKeys(value.binding, EXACT_BINDING) || !TOKEN.test(value.token)
    || typeof value.binding.project_root_sha256 !== 'string'
    || !HEX64.test(value.binding.project_root_sha256)
    || typeof value.binding.run_id !== 'string' || !SAFE_ID.test(value.binding.run_id)
    || typeof value.binding.owner_run_id !== 'string' || value.binding.owner_run_id.length === 0
    || !Number.isSafeInteger(value.binding.generation) || value.binding.generation < 1
    || !['claude', 'codex'].includes(value.binding.runtime)
    || typeof value.binding.attempt_id !== 'string' || !SAFE_ID.test(value.binding.attempt_id)) {
    throw closed('ACTIVATION_SECRET_MALFORMED');
  }
  if (EXACT_BINDING.some(key => value.binding[key] !== expected[key])) {
    throw closed('ACTIVATION_SECRET_BINDING_MISMATCH');
  }
  return value.token;
}

function mapError(error) {
  if (CLOSED.has(error?.message)) return error;
  return closed('ACTIVATION_SECRET_IO_UNAVAILABLE');
}

const AUTHORIZED_KERNEL_ERROR = /^(?:LEASE_FENCED|FENCE_REQUIRED|RUNTIME_FENCED|PROJECT_ROOT_FENCED|PROJECT_BINDING_FENCED|INVALID_NOW|INVALID_RUNTIME(?:_STATE)?|PROJECT_ROOT_UNRESOLVABLE|CHECKPOINT_[A-Z_]+|INVALID_ACTOR|INVALID_GENERATION|INVALID_STORED_ROOT_DIGEST|PROJECT_ROOT_REBIND_NOT_ALLOWED|RUN_ID_INVALID|STATE_INVALID|ACTIVATION_DEADLINE_INVALID|RUN_TERMINAL)(?::|$)/;

function mapKernelError(error) {
  const message = String(error?.message || error);
  if (AUTHORIZED_KERNEL_ERROR.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error('STATE_INVALID: stored activation kernel failure');
}

export function activateStoredLease(root, runId, {
  owner, generation, runtime, attemptId, now,
} = {}, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const homedirFn = deps.homedirFn ?? homedir;
  const canonicalProjectRootFn = deps.canonicalProjectRootFn ?? canonicalProjectRoot;
  const randomBytesFn = deps.randomBytesFn ?? randomBytes;
  const activateLeaseFn = deps.activateLeaseFn ?? activateLease;
  const mkdirFn = deps.mkdirFn ?? mkdirSync;
  const lstatFn = deps.lstatFn ?? lstatSync;
  const realpathFn = deps.realpathFn ?? (realpathSync.native || realpathSync);
  const writeFn = deps.writeFn ?? writeFileSync;
  const readFn = deps.readFn ?? readFileSync;
  const openFn = deps.openFn ?? openSync;
  const fsyncFn = deps.fsyncFn ?? fsyncSync;
  const closeFn = deps.closeFn ?? closeSync;
  const linkFn = deps.linkFn ?? linkSync;
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  const windowsExecutor = deps.windowsExecutor ?? spawnSync;
  const windowsExecutableLstatFn = deps.windowsExecutableLstatFn ?? lstatSync;
  const windowsExecutableRealpathFn = deps.windowsExecutableRealpathFn ?? (realpathSync.native || realpathSync);
  let token;

  try {
    if (typeof runId !== 'string' || !SAFE_ID.test(runId)
      || typeof owner !== 'string' || owner.length === 0
      || !Number.isSafeInteger(generation) || generation < 1
      || !['claude', 'codex'].includes(runtime)
      || typeof attemptId !== 'string' || !SAFE_ID.test(attemptId)) {
      throw closed('ACTIVATION_SECRET_BINDING_MISMATCH');
    }
    const windowsExecutable = platform === 'win32'
      ? trustedWindowsPowerShell({
        env, lstatFn: windowsExecutableLstatFn, realpathFn: windowsExecutableRealpathFn,
      })
      : null;
    const windowsAclFn = deps.windowsAclFn
      ?? (options => defaultWindowsAcl(options, windowsExecutor, windowsExecutable));
    const canonicalRoot = canonicalProjectRootFn(root);
    const base = stateRoot({ platform, env, homedirFn, testStateRoot: deps.testStateRoot });
    if (typeof base !== 'string' || !isAbsolute(base)) throw closed('ACTIVATION_SECRET_ROOT_INVALID');
    mkdirFn(base, { recursive: true, mode: 0o700 });
    const baseStat = lstatFn(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
      throw closed('ACTIVATION_SECRET_UNSAFE');
    }
    const canonicalBase = realpathFn(base);
    const parent = join(canonicalBase, 'deep-loop');
    const directory = join(parent, 'activation-secrets');
    ensureDirectory(parent, { platform, mkdirFn, lstatFn, realpathFn, windowsAclFn });
    ensureDirectory(directory, { platform, mkdirFn, lstatFn, realpathFn, windowsAclFn });
    const canonicalDirectory = realpathFn(directory);
    const rel = relative(canonicalBase, canonicalDirectory);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw closed('ACTIVATION_SECRET_UNSAFE');
    }

    const binding = {
      project_root_sha256: digest(canonicalRoot), run_id: runId, owner_run_id: owner,
      generation, runtime, attempt_id: attemptId,
    };
    const key = digest([canonicalRoot, runId, owner, String(generation), runtime, attemptId].join('\0'));
    const path = join(canonicalDirectory, `${key}.json`);
    if (existsSync(path)) {
      token = parseStored(readFn(path, 'utf8'), binding, lstatFn(path), platform, windowsAclFn, path);
    } else {
      const candidate = randomBytesFn(32).toString('base64url');
      if (!TOKEN.test(candidate)) throw closed('ACTIVATION_SECRET_IO_UNAVAILABLE');
      const value = `${JSON.stringify({ schema_version: '1.0', binding, token: candidate })}\n`;
      const temp = join(canonicalDirectory, `.tmp-${process.pid}-${randomBytesFn(8).toString('hex')}`);
      let published = false;
      try {
        writeFn(temp, value, { flag: 'wx', mode: 0o600 });
        if (platform === 'win32' && !windowsAclFn({ path: temp, kind: 'file' })) {
          throw closed('ACTIVATION_SECRET_UNSAFE');
        }
        let fd;
        try { fd = openFn(temp, constants.O_RDONLY); fsyncFn(fd); } finally { if (fd !== undefined) closeFn(fd); }
        try {
          linkFn(temp, path);
          published = true;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        unlinkFn(temp);
        let dirFd;
        try { dirFd = openFn(canonicalDirectory, constants.O_RDONLY); fsyncFn(dirFd); }
        catch (error) {
          if (platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'ENOSYS', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
        } finally { if (dirFd !== undefined) closeFn(dirFd); }
        token = parseStored(readFn(path, 'utf8'), binding, lstatFn(path), platform, windowsAclFn, path);
      } finally {
        if (!published) { try { unlinkFn(temp); } catch { /* preserve primary failure */ } }
      }
    }
  } catch (error) {
    throw mapError(error);
  }
  try {
    const result = activateLeaseFn(root, runId, {
      owner, generation, runtime, attemptId, activationToken: token, now,
    });
    return { ok: result?.ok === true, reason: result?.reason };
  } catch (error) {
    throw mapKernelError(error);
  }
}
