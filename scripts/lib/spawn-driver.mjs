import { spawnSync } from 'node:child_process';

// Codex r2 sf-4: budget 을 강제하려면 enforceable metric(turns 또는 tokens)이 최소 1개 finite 여야 한다.
// total_cost_usd 만 있는 출력은 turns/tokens 로 budget 게이트를 못 거니 측정 불가(null) → fail-closed.
export function parseUsage(stdout) {
  const s = String(stdout || '');
  let turns = null, tokens = null;
  try {
    const j = JSON.parse(s);
    if (j) {
      if (Number.isFinite(j.num_turns)) turns = j.num_turns;
      const inT = j.usage?.input_tokens, outT = j.usage?.output_tokens;
      if (Number.isFinite(inT) || Number.isFinite(outT)) tokens = (Number.isFinite(inT) ? inT : 0) + (Number.isFinite(outT) ? outT : 0);
    }
  } catch { /* not json */ }
  if (turns == null) { const m = s.match(/"(?:num_turns|turns)"\s*:\s*(\d+)/); if (m) turns = Number(m[1]); }
  if (!Number.isFinite(turns) && !Number.isFinite(tokens)) return null;   // 측정 불가 → fail-closed
  return { num_turns: turns, tokens };
}

// Direct spawnSync (no bash -c): bin and argv are passed directly to the OS.
export function defaultRun(bin, argv, { timeoutMs, cwd } = {}) {
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout: timeoutMs, cwd });
  const timedOut = r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM');
  return { code: r.status ?? null, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!timedOut };
}

// visibleSpawn: launcher-agnostic best-effort launch for interactive (visible) sessions.
// entry shape: { bin: string, argv: string[], cwd?: string }
// launcher: informational tag only (tmux|wezterm|cmux|…); actual dispatch is entry.bin/argv.
// Returns {ok:true} on exit 0 — this only means "launch command accepted by the multiplexer",
// NOT that the child session succeeded (readiness is verified later by respawn's handshake in Task 9).
export function visibleSpawn(entry, { launcher, timeoutMs = 30000, run = defaultRun } = {}) {
  let out;
  try { out = run(entry.bin, entry.argv, { timeoutMs, cwd: entry.cwd }); } catch (e) { return { ok: false, reason: `spawn-error: ${e.message || e}` }; }
  if (out.timedOut) return { ok: false, reason: 'launch-timeout' };
  if ((out.code ?? null) !== 0) return { ok: false, reason: `launch-exit-${out.code}` };
  return { ok: true };
}

// respawn 의 spawnFn 계약: {ok:true} | throw/{ok:false,reason}. fail-closed = ok:false (respawn 실패모드 B 롤백).
// entry shape: { bin: string, argv: string[], cwd?: string }
export function headlessSpawn(entry, { timeoutMs = 30 * 60 * 1000, run = defaultRun } = {}) {
  let out;
  try { out = run(entry.bin, entry.argv, { timeoutMs, cwd: entry.cwd }); } catch (e) { return { ok: false, reason: `spawn-error: ${e.message || e}` }; }
  if (out.timedOut) return { ok: false, reason: 'timeout' };
  if (out.code !== 0) return { ok: false, reason: `exit-${out.code}` };
  const usage = parseUsage(out.stdout);
  if (usage == null) return { ok: false, reason: 'unmeasurable-fail-closed' };   // 트랩 F7
  return { ok: true, usage };
}
