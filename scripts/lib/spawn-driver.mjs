import { spawnSync } from 'node:child_process';
import { createCodexJsonlParser, parseClaudeUsage } from './usage-parser.mjs';

// Codex r2 sf-4: budget 을 강제하려면 enforceable metric(turns 또는 tokens)이 최소 1개 finite 여야 한다.
// total_cost_usd 만 있는 출력은 turns/tokens 로 budget 게이트를 못 거니 측정 불가(null) → fail-closed.
export const parseUsage = parseClaudeUsage;

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
  const usageKind = entry?.usageOutputKind ?? 'claude-json';
  if (usageKind === 'codex-jsonl') {
    const parser = createCodexJsonlParser();
    parser.write(Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(String(out.stdout || ''), 'utf8'));
    const parsed = parser.end();
    return parsed.ok ? { ok: true, usage: parsed.usage } : parsed;
  }
  if (usageKind !== 'claude-json') return { ok: false, reason: 'unsupported-usage-kind' };
  const usage = parseClaudeUsage(out.stdout);
  if (usage == null) return { ok: false, reason: 'unmeasurable-fail-closed' };   // 트랩 F7
  return { ok: true, usage };
}
