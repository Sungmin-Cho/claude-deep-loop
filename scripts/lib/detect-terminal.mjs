import { spawnSync } from 'node:child_process';

/** Non-invasive probe runner — never opens a window. */
export function defaultProbeRun(bin, argv, { timeoutMs = 5000 } = {}) {
  const r = spawnSync(bin, argv, { timeout: timeoutMs, stdio: 'ignore' });
  return { code: r.status ?? 1 };
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
  allowPowershellVisible = false,
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
    if (!cmux_bin)    return noneDescriptor('cmux-no-bundled-bin');
    if (!socket_path) return noneDescriptor('cmux-no-socket');
    if (!surface_id)  return noneDescriptor('cmux-no-surface');

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

    if (allowPowershellVisible) {
      const pr    = run('where', ['powershell'], { timeoutMs: 5000 });
      const probe = { cmd: ['where', 'powershell'], code: pr.code };
      if (pr.code === 0) {
        return {
          platform, launcher: 'powershell', launcher_bin: null, launcher_socket: null,
          surface: 'window', reachable: true, visible: true,
          signals, probe, reason: null, fallback: 'launch-command-file', detected_at,
        };
      }
      return noneDescriptor('no-host-signal', probe);
    }

    // No WT_SESSION and powershell opt-in not granted.
    return noneDescriptor('powershell-needs-optin');
  }

  // ── 4. Any other platform ───────────────────────────────────────────────────
  return noneDescriptor('no-host-signal');
}
