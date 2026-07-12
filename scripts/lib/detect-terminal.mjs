import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { appendAnchored } from './integrity.mjs';
import { readState } from './state.mjs';
import { reconcileBudget } from './budget.mjs';
import { revalidateTrustedLauncherExecutable } from './runtime-executable.mjs';

/** Non-invasive probe runner — never opens a window. capture:true returns stdout. */
export function defaultProbeRun(bin, argv, { timeoutMs = 5000, capture = false } = {}) {
  if (capture) {
    const r = spawnSync(bin, argv, { timeout: timeoutMs, encoding: 'utf8', shell: false });
    return { code: r.status ?? 1, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
  }
  const r = spawnSync(bin, argv, { timeout: timeoutMs, stdio: 'ignore', shell: false });
  return { code: r.status ?? 1 };
}

// Fixed canonical trusted PowerShell locations — NOT derived from overridable env
// (SystemRoot/ProgramFiles can be spoofed by a parent) and NOT from where/PATH/cwd.
const TRUSTED_PS = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',          // PS7 (preferred)
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',   // Windows PowerShell 5.1 (guaranteed)
];
// Exported so handoff.mjs's buildLaunchCommand can resolve a trusted PS bin at BUILD time (the
// Windows desktop launcher targets desktopTarget.exePath directly — it is not the persisted
// session_spawn.launcher_bin, so it needs its own resolution against the same trust boundary).
export function trustedPsCandidates(exists) {
  return TRUSTED_PS.filter((p) => { try { return exists(p); } catch { return false; } });
}
// Single source of the PowerShell trust boundary — exported so handoff/respawn re-validate a
// persisted launcher_bin against the SAME canonical set. Exact membership: a stale/hand-edited
// 'C:\repo\powershell.exe' or UNC '\\srv\share\pwsh.exe' is rejected → fail-closed.
export function isTrustedPsBin(p) { return TRUSTED_PS.includes(p); }

function sameAuthenticodeIdentity(left, right) {
  if (left == null || right == null) return left == null && right == null;
  if (typeof left !== 'object' || Array.isArray(left) || typeof right !== 'object' || Array.isArray(right)) return false;
  const expectedKeys = ['signer', 'status', 'thumbprint'];
  if (Object.keys(left).sort().join(',') !== expectedKeys.join(',')
    || Object.keys(right).sort().join(',') !== expectedKeys.join(',')) return false;
  return left.status === right.status && left.signer === right.signer && left.thumbprint === right.thumbprint;
}

function sameLauncherSecurityIdentity(left, right) {
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false;
  return ['kind', 'canonical_path', 'sha256', 'version', 'platform', 'arch', 'source']
    .every(field => left[field] === right[field])
    && sameAuthenticodeIdentity(left.authenticode ?? null, right.authenticode ?? null);
}

function launcherAuthority(loop, kind) {
  const approvals = loop.autonomy?.launcher_executable_approvals;
  if (approvals === undefined) {
    const session = loop.session_spawn;
    if (session?.launcher !== kind || !session.launcher_identity
      || typeof session.launcher_identity !== 'object' || Array.isArray(session.launcher_identity)) return null;
    return session.launcher_identity;
  }
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)
    || !Object.hasOwn(approvals, kind) || !approvals[kind]
    || typeof approvals[kind] !== 'object' || Array.isArray(approvals[kind])) return null;
  return approvals[kind];
}

// Bounded parent-process ancestry walk. The PS one-liner outputs 3-valued PS/NO/UNKNOWN
// (only a true top-reach is authoritative NO; CIM failure/exhaustion → UNKNOWN). MEASURED-PS-ONLY:
// only a measured 'PS' ancestor returns host:true. NO/UNKNOWN/all-probes-failed → host:false.
// No env fallback (POWERSHELL_DISTRIBUTION_CHANNEL is parent-spoofable; the walk already covers 5.1 + PS7).
function detectPsHost({ run, pid, candidates }) {
  const script = `$p=${pid}; $r='UNKNOWN'; for($i=0;$i -lt 8 -and $p;$i++){ $q=Get-CimInstance Win32_Process -Filter ("ProcessId="+$p) -EA SilentlyContinue; if(-not $q){ break }; if($q.Name -match '^(powershell|pwsh)(\\.exe)?$'){ $r='PS'; break }; if(-not $q.ParentProcessId -or $q.ParentProcessId -eq 0){ $r='NO'; break }; $p=$q.ParentProcessId }; $r`;
  for (const bin of candidates) {
    const r = run(bin, ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 5000, capture: true });
    const out = (r && typeof r.stdout === 'string') ? r.stdout : '';
    if (r && r.code === 0 && /(^|\s)PS(\s|$)/.test(out)) return { host: true, bin };
    if (r && r.code === 0 && /(^|\s)NO(\s|$)/.test(out)) return { host: false, bin };
    // UNKNOWN / failure → try next candidate
  }
  return { host: false, bin: candidates[candidates.length - 1] };   // no measured PS → not a PowerShell host
}

/**
 * Fail-closed, positive-host-signal terminal/launcher detection.
 *
 * Returns a descriptor matching the session_spawn shape persisted by initrun:
 *   { platform, launcher, launcher_bin, launcher_socket, surface,
 *     reachable, visible, signals, probe, reason, fallback, detected_at }
 *
 * launcher ∈ { cmux, iterm2, terminal-app, wt, powershell, none }
 * fallback is always 'launch-command-file' (v1 constant).
 */
export function detectTerminal({
  env = process.env,
  platform = process.platform,
  run = defaultProbeRun,
  now,
  pid = (typeof process !== 'undefined' ? process.pid : 0),
  exists = (p) => { try { return existsSync(p); } catch { return false; } },
  arch = process.arch,
  windowsLauncherIdentities = {},
  revalidateLauncher = revalidateTrustedLauncherExecutable,
  launcherRevalidationOptions = {},
} = {}) {
  // detected_at is an ISO string passed in; do NOT call .toISOString() on it.
  const detected_at = now;

  // Signals snapshot (pure reads — no run() here).
  const signals = {
    term_program: env.TERM_PROGRAM ?? null,
    cmux_socket:  !!env.CMUX_BUNDLED_CLI_PATH,  // per spec: records CMUX_BUNDLED_CLI_PATH presence
    wt_session:   !!env.WT_SESSION,
    tmux:         !!env.TMUX,
    sty:          !!env.STY,
  };

  /** Convenience: none descriptor without a probe (probe ran = null). */
  function noneDescriptor(reason, probeRecord = null) {
    return {
      platform, launcher: 'none', launcher_bin: null, launcher_socket: null,
      surface: null, reachable: false, visible: false,
      signals, probe: probeRecord, reason,
      fallback: 'launch-command-file', detected_at,
    };
  }

  // ── 1. cmux branch ──────────────────────────────────────────────────────────
  // Fail-closed, explicit-socket premise (Handoff §4 invariant 6, spec R6-plan):
  // cmux requires ALL of — absolute CMUX_BUNDLED_CLI_PATH AND CMUX_SOCKET_PATH
  // AND a caller surface (CMUX_WORKSPACE_ID || CMUX_SURFACE_ID). There is NO
  // bare-`cmux` / default-socket / auto-discovery fallback anywhere.
  //
  // The branch is entered on ANY positive cmux signal so a partial cmux context
  // reports the SPECIFIC missing-piece reason (fail-closed) instead of falling
  // through and falsely detecting another launcher.
  const cmux_signal =
    env.CMUX_BUNDLED_CLI_PATH || env.CMUX_SOCKET_PATH ||
    env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID;
  if (cmux_signal) {
    const cmux_bin    = env.CMUX_BUNDLED_CLI_PATH;
    const socket_path = env.CMUX_SOCKET_PATH;
    const surface_id  = env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID;

    // Missing-piece reason precedence (check in this exact order).
    if (!cmux_bin)                 return noneDescriptor('cmux-no-bundled-bin');
    // Codex r3 🔴2: a relative/bare bin (e.g. 'cmux') resolves via PATH/cwd at probe time —
    // fail-closed without probing or persisting any relative value.
    if (!isAbsolute(cmux_bin))     return noneDescriptor('cmux-bin-not-absolute');
    if (!socket_path)              return noneDescriptor('cmux-no-socket');
    if (!surface_id)               return noneDescriptor('cmux-no-surface');

    // Probe MUST target the explicit socket — persist the SAME verified socket.
    const probe_argv   = ['--socket', socket_path, 'ping'];
    const probe_cmd    = [cmux_bin, ...probe_argv];
    const probe_result = run(cmux_bin, probe_argv, { timeoutMs: 5000 });
    const probe_record = { cmd: probe_cmd, code: probe_result.code };

    // Fail-closed: a non-zero probe never downgrades to another launcher.
    if (probe_result.code !== 0) {
      return noneDescriptor('cmux-socket-denied', probe_record);
    }

    return {
      platform,
      launcher:        'cmux',
      launcher_bin:    cmux_bin,
      launcher_socket: socket_path,   // the SAME socket the probe verified
      surface:         'workspace',
      reachable:       true,
      visible:         true,
      signals,
      probe:           probe_record,
      reason:          null,
      fallback:        'launch-command-file',
      detected_at,
    };
  }

  // ── 1.5. Multiplexer v1 unsupported ─────────────────────────────────────────
  // Must come BEFORE the darwin TERM_PROGRAM check because TERM_PROGRAM is
  // stale/incorrect inside a tmux/screen session.
  if (env.TMUX || env.STY) {
    return noneDescriptor('multiplexer-v1-unsupported');
  }

  // ── 2. macOS / darwin ───────────────────────────────────────────────────────
  if (platform === 'darwin') {
    const term_program = env.TERM_PROGRAM;

    if (term_program === 'iTerm.app') {
      const argv  = ['-e', 'id of application "iTerm"'];
      const pr    = run('osascript', argv, { timeoutMs: 5000 });
      const probe = { cmd: ['osascript', ...argv], code: pr.code };
      if (pr.code === 0) {
        return {
          platform, launcher: 'iterm2', launcher_bin: null, launcher_socket: null,
          surface: 'window', reachable: true, visible: true,
          signals, probe, reason: null, fallback: 'launch-command-file', detected_at,
        };
      }
      return noneDescriptor('no-host-signal', probe);
    }

    if (term_program === 'Apple_Terminal') {
      const argv  = ['-e', 'id of application "Terminal"'];
      const pr    = run('osascript', argv, { timeoutMs: 5000 });
      const probe = { cmd: ['osascript', ...argv], code: pr.code };
      if (pr.code === 0) {
        return {
          platform, launcher: 'terminal-app', launcher_bin: null, launcher_socket: null,
          surface: 'window', reachable: true, visible: true,
          signals, probe, reason: null, fallback: 'launch-command-file', detected_at,
        };
      }
      return noneDescriptor('no-host-signal', probe);
    }

    return noneDescriptor('no-host-signal');
  }

  // ── 3. Windows / win32 ──────────────────────────────────────────────────────
  if (platform === 'win32') {
    if (env.WT_SESSION) {
      let identity;
      try {
        const stored = windowsLauncherIdentities?.wt;
        if (stored == null) throw new Error('missing');
        identity = revalidateLauncher(stored, { ...launcherRevalidationOptions, platform, arch });
        if (!sameLauncherSecurityIdentity(identity, stored) || identity.kind !== 'wt') {
          throw new Error('mismatch');
        }
      } catch {
        return noneDescriptor('windows-terminal-unverified');
      }
      return {
        platform, launcher: 'wt', launcher_bin: identity.canonical_path,
        launcher_identity: identity, launcher_socket: null,
        surface: 'tab', reachable: true, visible: true,
        signals, probe: null, reason: null, fallback: 'launch-command-file', detected_at,
      };
    }

    // Fixed paths and PATH hits are only candidates. Automatic launch requires a separately
    // verified and revalidated native identity; otherwise preserve a manual fallback.
    let identity;
    try {
      const stored = windowsLauncherIdentities?.powershell;
      if (stored == null) throw new Error('missing');
      identity = revalidateLauncher(stored, { ...launcherRevalidationOptions, platform, arch });
      if (!sameLauncherSecurityIdentity(identity, stored) || identity.kind !== 'powershell') {
        throw new Error('mismatch');
      }
    } catch {
      return noneDescriptor('powershell-unverified');
    }
    const { host, bin } = detectPsHost({ run, pid, candidates: [identity.canonical_path] });
    if (host) {
      return {
        platform, launcher: 'powershell', launcher_bin: bin, launcher_socket: null,
        launcher_identity: identity,
        surface: 'window', reachable: true, visible: true,
        signals, probe: null, reason: null, fallback: 'launch-command-file', detected_at,
      };
    }
    return noneDescriptor('no-host-signal');
  }

  // ── 4. Any other platform ───────────────────────────────────────────────────
  return noneDescriptor('no-host-signal');
}

/**
 * Fenced, releasing-safe: detect the terminal and persist the descriptor.
 *
 * Releasing-safe (R11-HH): the lease portion of preCheck compares owner/generation
 * without applying the leaseCheck releasing carve-out, so detect-terminal succeeds
 * while the parent is `releasing`. A separate in-lock guard binds any runnable
 * Windows launcher descriptor to the current durable/legacy authority.
 *
 * Returns the descriptor so the CLI can print it.
 */
export function detectAndPersist(root, runId, {
  owner, generation,
  env = process.env,
  platform = process.platform,
  run = defaultProbeRun,
  now,
  pid = (typeof process !== 'undefined' ? process.pid : 0),
  arch = process.arch,
  windowsLauncherIdentities = {},
  revalidateLauncher = revalidateTrustedLauncherExecutable,
  launcherRevalidationOptions = {},
} = {}) {
  reconcileBudget(root, runId);
  const { data: loop } = readState(root, runId);
  const persistedLauncher = loop.session_spawn?.launcher;
  const persistedIdentity = loop.session_spawn?.launcher_identity;
  // Authority order: durable human approval > legacy persisted session identity > explicit test fallback.
  // Production callers do not inject windowsLauncherIdentities; keeping it last preserves focused tests without
  // turning PATH/fixed candidates into authority. Legacy states may omit the new approval map entirely.
  const durableApprovals = loop.autonomy?.launcher_executable_approvals;
  const hasDurableApprovalMap = durableApprovals !== undefined;
  const effectiveWindowsIdentities = hasDurableApprovalMap ? {} : { ...windowsLauncherIdentities };
  if (!hasDurableApprovalMap && persistedIdentity != null
    && (persistedLauncher === 'wt' || persistedLauncher === 'powershell')) {
    effectiveWindowsIdentities[persistedLauncher] = persistedIdentity;
  }
  if (hasDurableApprovalMap && durableApprovals && typeof durableApprovals === 'object' && !Array.isArray(durableApprovals)) {
    for (const kind of ['wt', 'powershell']) {
      if (durableApprovals[kind] != null) effectiveWindowsIdentities[kind] = durableApprovals[kind];
    }
  }
  const d = detectTerminal({
    env, platform, run, now, pid, arch, windowsLauncherIdentities: effectiveWindowsIdentities,
    revalidateLauncher, launcherRevalidationOptions,
  });
  appendAnchored(
    root, runId,
    { type: 'terminal-detected', data: { launcher: d.launcher } },
    (l) => { l.session_spawn = d; },
    (l) => {
      const lease = l.session_chain.lease;
      // Direct owner/generation check only — must NOT reject on lease.state==='releasing'.
      if (lease.owner_run_id !== owner || lease.generation !== generation) {
        throw new Error('LEASE_FENCED: detect-terminal');
      }
      // v1.6 (spec §2.3-4, r1 🟡2): terminal run에 terminal-detected write 금지. lease.state는 계속
      // 안 보므로 releasing-safe(R11-HH) 불변. CLI 외곽 requireLease는 TOCTOU 창이 있고 lib 직접
      // 호출은 외곽을 안 거친다 — 이 in-lock이 권위.
      if (l.status === 'completed' || l.status === 'stopped') {
        throw new Error('RUN_TERMINAL: detect-terminal');
      }
      if (platform === 'win32' && (d.launcher === 'wt' || d.launcher === 'powershell')) {
        const authority = launcherAuthority(l, d.launcher);
        if (authority == null || !isDeepStrictEqual(d.launcher_identity, authority)) {
          throw new Error('LAUNCHER_EXECUTABLE_DRIFT: detect-terminal authority changed');
        }
      }
    }
  );
  return d;
}
