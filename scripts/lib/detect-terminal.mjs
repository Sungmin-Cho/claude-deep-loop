import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { appendAnchored } from './integrity.mjs';
import { readState } from './state.mjs';
import { reconcileBudget } from './budget.mjs';

/** Non-invasive probe runner — never opens a window. capture:true returns stdout. */
export function defaultProbeRun(bin, argv, { timeoutMs = 5000, capture = false } = {}) {
  if (capture) {
    const r = spawnSync(bin, argv, { timeout: timeoutMs, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
  }
  const r = spawnSync(bin, argv, { timeout: timeoutMs, stdio: 'ignore' });
  return { code: r.status ?? 1 };
}

// Fixed canonical trusted PowerShell locations — NOT derived from overridable env
// (SystemRoot/ProgramFiles can be spoofed by a parent) and NOT from where/PATH/cwd.
const TRUSTED_PS = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',          // PS7 (preferred)
  'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',   // Windows PowerShell 5.1 (guaranteed)
];
function trustedPsCandidates(exists) {
  return TRUSTED_PS.filter((p) => { try { return exists(p); } catch { return false; } });
}
// Single source of the PowerShell trust boundary — exported so handoff/respawn re-validate a
// persisted launcher_bin against the SAME canonical set. Exact membership: a stale/hand-edited
// 'C:\repo\powershell.exe' or UNC '\\srv\share\pwsh.exe' is rejected → fail-closed.
export function isTrustedPsBin(p) { return TRUSTED_PS.includes(p); }

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
      const pr    = run('where', ['wt.exe'], { timeoutMs: 5000 });
      const probe = { cmd: ['where', 'wt.exe'], code: pr.code };
      if (pr.code === 0) {
        return {
          platform, launcher: 'wt', launcher_bin: null, launcher_socket: null,
          surface: 'tab', reachable: true, visible: true,
          signals, probe, reason: null, fallback: 'launch-command-file', detected_at,
        };
      }
      return noneDescriptor('no-host-signal', probe);
    }

    // No WT_SESSION: PowerShell host detection (no opt-in). launcher_bin resolves ONLY from the
    // fixed TRUSTED_PS system paths (no where/PATH/cwd/env-derived roots); host is decided by a
    // measured parent-process ancestry walk run via the trusted bin.
    const candidates = trustedPsCandidates(exists);
    if (candidates.length === 0) return noneDescriptor('no-host-signal');
    const { host, bin } = detectPsHost({ run, pid, candidates });
    if (host) {
      return {
        platform, launcher: 'powershell', launcher_bin: bin, launcher_socket: null,
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
 * Releasing-safe (R11-HH): the preCheck compares owner/generation ONLY — it does
 * NOT apply the leaseCheck releasing-carve-out so detect-terminal succeeds even
 * while the parent lease is in `state: 'releasing'` (post-handoff-emit metadata).
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
} = {}) {
  reconcileBudget(root, runId);
  const { data: loop } = readState(root, runId);
  const d = detectTerminal({ env, platform, run, now, pid });
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
    }
  );
  return d;
}
