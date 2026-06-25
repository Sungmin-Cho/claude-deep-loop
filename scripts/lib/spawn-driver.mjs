import { spawnSync, spawn } from 'node:child_process';

function claudeAvailable() {
  try { return spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).status === 0; } catch { return false; }
}

// respawn launcher: detached fire-and-forget. Fix 2: claude binary precheck before spawn so a missing claude
// binary returns ok:false (failure-mode-B rollback) instead of silently succeeding and stranding the lease.
export function detachedSpawn(cmd, { available = claudeAvailable } = {}) {
  if (!available()) return { ok: false, reason: 'claude-not-found' };
  try { const c = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' }); c.unref(); return { ok: true }; }
  catch (e) { return { ok: false, reason: `launch-error: ${e.message || e}` }; }
}

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

export function defaultRun(cmd, { timeoutMs }) {
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  const timedOut = r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM');
  return { code: r.status ?? null, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!timedOut };
}

// respawn 의 spawnFn 계약: {ok:true} | throw/{ok:false,reason}. fail-closed = ok:false (respawn 실패모드 B 롤백).
export function headlessSpawn(cmd, { timeoutMs = 30 * 60 * 1000, run = defaultRun } = {}) {
  let out;
  try { out = run(cmd, { timeoutMs }); } catch (e) { return { ok: false, reason: `spawn-error: ${e.message || e}` }; }
  if (out.timedOut) return { ok: false, reason: 'timeout' };
  if (out.code !== 0) return { ok: false, reason: `exit-${out.code}` };
  const usage = parseUsage(out.stdout);
  if (usage == null) return { ok: false, reason: 'unmeasurable-fail-closed' };   // 트랩 F7
  return { ok: true, usage };
}
