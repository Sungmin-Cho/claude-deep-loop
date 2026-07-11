import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlessSpawn, parseUsage, visibleSpawn } from '../scripts/lib/spawn-driver.mjs';

const streamFixture = fileURLToPath(new URL('./fixtures/stream-emitter.mjs', import.meta.url));

// Mock run functions: signature is (bin, argv, {timeoutMs, cwd}) — return shape unchanged.
const okRun = () => ({ code: 0, stdout: '{"num_turns":3,"usage":{"input_tokens":10}}', stderr: '', timedOut: false });
const timeoutRun = () => ({ code: null, stdout: '', stderr: '', timedOut: true });
const unmeasurableRun = () => ({ code: 0, stdout: 'done, no usage here', stderr: '', timedOut: false });
const costOnlyRun = () => ({ code: 0, stdout: '{"total_cost_usd":0.12}', stderr: '', timedOut: false });   // Codex r2 sf-4

// Minimal valid entry shape for headlessSpawn.
const okEntry = { bin: 'claude', argv: ['-p', 'x'], cwd: '/p' };
const codexEntry = { bin: '/trusted/codex', argv: ['exec', '--json', '-'], cwd: '/p', usageOutputKind: 'codex-jsonl' };

function codexStdout(usage = { input_tokens: 10, cached_input_tokens: 4, output_tokens: 7, reasoning_output_tokens: 3 }) {
  return `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n${JSON.stringify({ type: 'turn.completed', usage })}\n`;
}

test('headlessSpawn ok when usage measurable', () => {
  const r = headlessSpawn(okEntry, { run: okRun });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.usage.num_turns) || Number.isFinite(r.usage.tokens));
});

test('headlessSpawn fail-closed on timeout', () => {
  const r = headlessSpawn(okEntry, { run: timeoutRun });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
});

test('headlessSpawn fail-closed when usage unmeasurable', () => {
  const r = headlessSpawn(okEntry, { run: unmeasurableRun });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unmeasurable/);
});

// Codex r2 sf-4: cost-only JSON 에는 enforceable metric(turns/tokens)이 없으므로 fail-closed.
test('headlessSpawn fail-closed when only total_cost_usd is present', () => {
  const r = headlessSpawn(okEntry, { run: costOnlyRun });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unmeasurable/);
});

test('parseUsage requires a finite enforceable metric', () => {
  assert.equal(parseUsage('{"num_turns":2}').num_turns, 2);
  assert.ok(parseUsage('{"usage":{"input_tokens":5,"output_tokens":7}}').tokens === 12);
  assert.equal(parseUsage('{"total_cost_usd":0.12}'), null);   // cost-only → 측정 불가
  assert.equal(parseUsage('nothing'), null);
});

// headlessSpawn passes bin/argv/cwd to run without shell.
test('headlessSpawn passes entry.bin, entry.argv, entry.cwd to run (no bash -c)', () => {
  let calledBin, calledArgv, calledOpts;
  const capturingRun = (bin, argv, opts) => {
    calledBin = bin; calledArgv = argv; calledOpts = opts;
    return { code: 0, stdout: '{"num_turns":1}', stderr: '', timedOut: false };
  };
  const entry = { bin: 'claude', argv: ['-p', 'hello', '--output-format', 'json'], cwd: '/work' };
  headlessSpawn(entry, { run: capturingRun });
  assert.equal(calledBin, 'claude');
  assert.deepEqual(calledArgv, ['-p', 'hello', '--output-format', 'json']);
  assert.equal(calledOpts.cwd, '/work');
  assert.deepEqual(Object.keys(calledOpts).sort(), ['cwd', 'timeoutMs'], 'legacy run injection shape must stay exact');
  assert.notEqual(calledBin, 'bash');
});

// detachedSpawn was removed in Fix 2 (precompact-handoff.mjs is now emit-only; measured resume via cron driveHeadless).

// ── visibleSpawn ──────────────────────────────────────────────────────────────

test('visibleSpawn returns ok:true on exit 0', () => {
  const r = visibleSpawn({ bin: 'cmux', argv: ['new-workspace'] }, { launcher: 'cmux', run: () => ({ code: 0 }) });
  assert.deepEqual(r, { ok: true });
});

test('visibleSpawn returns ok:false on nonzero exit', () => {
  const r = visibleSpawn({ bin: 'cmux', argv: ['new-workspace'] }, { run: () => ({ code: 1 }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'launch-exit-1');
});

test('visibleSpawn returns ok:false on timeout', () => {
  const r = visibleSpawn({ bin: 'tmux', argv: ['new-session'] }, { run: () => ({ timedOut: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'launch-timeout');
});

test('visibleSpawn returns ok:false when run throws', () => {
  const r = visibleSpawn({ bin: 'cmux', argv: [] }, { run: () => { throw new Error('boom'); } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /spawn-error.*boom/);
});

test('visibleSpawn does NOT parse usage (exit 0 = launch issued, not session success)', () => {
  // No stdout field needed — visible is best-effort; we only check launch exit code.
  const r = visibleSpawn({ bin: 'cmux', argv: ['new-workspace'] }, { run: () => ({ code: 0 }) });
  assert.equal(r.ok, true);
  assert.equal(r.usage, undefined);
});

// ── headlessSpawn regression: usage.num_turns exact value ────────────────────

test('headlessSpawn usage.num_turns equals 3 from stdout', () => {
  const r = headlessSpawn(
    { bin: 'claude', argv: ['-p', 'x'], cwd: '/p' },
    { run: () => ({ code: 0, stdout: '{"num_turns":3}', stderr: '', timedOut: false }) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.usage.num_turns, 3);
});

test('headlessSpawn reason is exact string unmeasurable-fail-closed', () => {
  const r = headlessSpawn(
    { bin: 'claude', argv: ['-p', 'x'], cwd: '/p' },
    { run: () => ({ code: 0, stdout: 'no metric', stderr: '', timedOut: false }) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unmeasurable-fail-closed');
});

test('headlessSpawn selects bounded Codex JSONL usage from the entry descriptor', () => {
  const r = headlessSpawn(codexEntry, {
    run: () => ({ code: 0, stdout: codexStdout(), stderr: '', timedOut: false }),
  });

  assert.deepEqual(r, {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: 17,
      input_tokens: 10,
      output_tokens: 7,
      cached_input_tokens: 4,
      reasoning_output_tokens: 3,
    },
  });
});

test('headlessSpawn never applies Claude text fallback to Codex output', () => {
  const r = headlessSpawn(codexEntry, {
    run: () => ({ code: 0, stdout: 'prefix "num_turns": 9 suffix', stderr: '', timedOut: false }),
  });
  assert.deepEqual(r, { ok: false, reason: 'codex-malformed-json' });
});

test('headlessSpawn propagates distinct Codex parser failures', () => {
  const r = headlessSpawn(codexEntry, {
    run: () => ({ code: 0, stdout: '{"type":"turn.failed","error":{"message":"boom"}}\n', stderr: '', timedOut: false }),
  });
  assert.deepEqual(r, { ok: false, reason: 'codex-turn-failed' });
});

test('headlessSpawn discards valid Codex usage after timeout or non-zero exit', () => {
  const stdout = codexStdout();
  const timedOut = headlessSpawn(codexEntry, {
    run: () => ({ code: 0, stdout, stderr: '', timedOut: true }),
  });
  const nonzero = headlessSpawn(codexEntry, {
    run: () => ({ code: 7, stdout, stderr: '', timedOut: false }),
  });

  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' });
  assert.deepEqual(nonzero, { ok: false, reason: 'exit-7' });
  assert.equal(timedOut.usage, undefined);
  assert.equal(nonzero.usage, undefined);
});

test('spawn driver exports a dedicated synchronous visible launcher runner', async () => {
  const module = await import('../scripts/lib/spawn-driver.mjs');
  assert.equal(typeof module.defaultVisibleRun, 'function');
  const out = module.defaultVisibleRun(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs: 2_000 });
  assert.equal(out.code, 0);
  assert.equal(out.timedOut, false);
});

test('headlessSpawn delegates synchronously to the compact worker facade', () => {
  const entry = { bin: '/runtime/not-called-directly', argv: ['--flag'], stdin: 'secret prompt', shell: false };
  let calls = 0;
  const result = headlessSpawn(entry, {
    timeoutMs: 321,
    runSync: (receivedEntry, options) => {
      calls += 1;
      assert.strictEqual(receivedEntry, entry);
      assert.deepEqual(options, { timeoutMs: 321 });
      return { ok: true, usage: { num_turns: 1, tokens: 9 } };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, { ok: true, usage: { num_turns: 1, tokens: 9 } });
  assert.equal(typeof result?.then, 'undefined', 'respawn requires a synchronous plain result');
});

test('headlessSpawn default path sends runtime stdin through one worker-owned spawn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-headless-worker-'));
  const counterPath = join(dir, 'runtime-spawns.txt');
  const result = headlessSpawn({
    bin: process.execPath,
    argv: [streamFixture, 'count-once', counterPath],
    stdin: 'worker-only stdin',
    env: {},
    shell: false,
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.deepEqual(result, { ok: true, usage: { num_turns: 1, tokens: 12 } });
  assert.equal(readFileSync(counterPath, 'utf8'), 'spawned\n');
  assert.equal(Object.hasOwn(result, 'stdout'), false);
});
