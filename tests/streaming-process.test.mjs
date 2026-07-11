import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STREAM_LIMITS } from '../scripts/lib/usage-parser.mjs';

const fixture = fileURLToPath(new URL('./fixtures/stream-emitter.mjs', import.meta.url));

async function streamingModule() {
  try {
    return await import('../scripts/lib/streaming-process.mjs');
  } catch (error) {
    assert.fail(`streaming process module must load: ${error?.code || error}`);
  }
}

test('runStreamingProcess streams stdin to one real child with cwd and explicit env', async () => {
  const { runStreamingProcess } = await streamingModule();
  const cwd = mkdtempSync(join(tmpdir(), 'deep-loop-stream-'));
  let spawnCount = 0;
  const previousLeak = process.env.SHOULD_NOT_LEAK;
  process.env.SHOULD_NOT_LEAK = 'host-environment';
  let result;
  try {
    result = await runStreamingProcess({
      bin: process.execPath,
      argv: [fixture, 'checkpoint', cwd],
      cwd,
      env: { STREAM_TOKEN: 'explicit-only' },
      stdin: 'streaming checkpoint',
      shell: false,
      usageOutputKind: 'claude-json',
    }, {
      timeoutMs: 2_000,
      spawnImpl: (bin, argv, options) => {
        spawnCount += 1;
        assert.equal(options.shell, false);
        assert.deepEqual(options.env, { STREAM_TOKEN: 'explicit-only' });
        return spawn(bin, argv, options);
      },
    });
  } finally {
    if (previousLeak == null) delete process.env.SHOULD_NOT_LEAK;
    else process.env.SHOULD_NOT_LEAK = previousLeak;
  }

  assert.deepEqual(result.usage, { num_turns: 1, tokens: 12 });
  assert.equal(result.ok, true);
  assert.equal(spawnCount, 1, 'the runtime must be spawned exactly once');
  assert.equal(Object.hasOwn(result, 'stdout'), false, 'raw runtime stdout must never escape');
});

test('runStreamingProcess discards valid usage after timeout or non-zero exit', async () => {
  const { runStreamingProcess } = await streamingModule();
  const timedOut = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'timeout-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 40 });
  const nonzero = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'nonzero-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' });
  assert.deepEqual(nonzero, { ok: false, reason: 'exit-7' });
  assert.equal(timedOut.usage, undefined);
  assert.equal(nonzero.usage, undefined);
});

test('streaming process APIs reject invalid timeouts before spawning runtime or worker', async () => {
  const { runStreamingProcess, runStreamingProcessSync } = await streamingModule();
  const invalidTimeouts = [NaN, Infinity, -Infinity, -1, 1.5, 2_147_483_648];

  for (const timeoutMs of invalidTimeouts) {
    let runtimeSpawns = 0;
    const asyncResult = await runStreamingProcess({ bin: process.execPath, argv: [] }, {
      timeoutMs,
      spawnImpl: () => {
        runtimeSpawns += 1;
        throw new Error('invalid timeout must not spawn runtime');
      },
    });
    let workerSpawns = 0;
    const syncResult = runStreamingProcessSync({ bin: process.execPath, argv: [] }, {
      timeoutMs,
      spawnSyncImpl: () => {
        workerSpawns += 1;
        throw new Error('invalid timeout must not spawn worker');
      },
    });

    assert.deepEqual(asyncResult, { ok: false, reason: 'invalid-timeout' }, String(timeoutMs));
    assert.deepEqual(syncResult, { ok: false, reason: 'invalid-timeout' }, String(timeoutMs));
    assert.equal(runtimeSpawns, 0, String(timeoutMs));
    assert.equal(workerSpawns, 0, String(timeoutMs));
  }
});

function controlledChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.destroy = () => {};
  child.stdin.end = (_payload, callback) => {
    child.completeStdin = callback;
  };
  child.kill = () => true;
  return child;
}

test('non-empty stdin requires flush completion before a zero-exit child can succeed', async () => {
  const { runStreamingProcess } = await streamingModule();
  const child = controlledChild();
  const pending = runStreamingProcess({
    bin: process.execPath,
    argv: [],
    stdin: 'request',
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000, spawnImpl: () => child });
  child.stdout.emit('data', Buffer.from('{"num_turns":1}'));
  child.emit('close', 0);

  assert.deepEqual(await pending, { ok: false, reason: 'stdin-error' });
});

test('empty stdin can succeed even when no flush callback arrives before child close', async () => {
  const { runStreamingProcess } = await streamingModule();
  const child = controlledChild();
  const pending = runStreamingProcess({
    bin: process.execPath,
    argv: [],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000, spawnImpl: () => child });
  child.stdout.emit('data', Buffer.from('{"num_turns":1}'));
  child.emit('close', 0);

  assert.deepEqual(await pending, { ok: true, usage: { num_turns: 1, tokens: null } });
});

test('runStreamingProcess fails closed when a non-empty stdin request is not delivered', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'close-stdin-valid'],
    stdin: 'x'.repeat(1024 * 1024),
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.deepEqual(result, { ok: false, reason: 'stdin-error' });
  assert.equal(result.usage, undefined);
});

test('runStreamingProcess drains multi-MiB stderr but retains only the diagnostic byte cap', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'large-stderr'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 5_000 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.usage, { num_turns: 1, tokens: 12 });
  assert.equal(Buffer.byteLength(result.stderr, 'utf8'), STREAM_LIMITS.stderrBytes);
  assert.equal(result.stderrTruncated, true);
  assert.equal(Object.hasOwn(result, 'stdout'), false);
});

test('runStreamingProcess keeps encoded stderr diagnostics within the raw byte cap', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'invalid-stderr'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Buffer.byteLength(result.stderr, 'utf8') <= STREAM_LIMITS.stderrBytes);
  assert.equal(result.stderrTruncated, true);
});

test('runStreamingProcess feeds Codex JSONL incrementally without returning raw output', async () => {
  const { runStreamingProcess } = await streamingModule();
  const result = await runStreamingProcess({
    bin: process.execPath,
    argv: [fixture, 'codex-stream'],
    usageOutputKind: 'codex-jsonl',
  }, { timeoutMs: 5_000 });

  assert.deepEqual(result, {
    ok: true,
    usage: {
      num_turns: 1,
      tokens: 24,
      input_tokens: 11,
      output_tokens: 13,
      cached_input_tokens: 4,
      reasoning_output_tokens: 3,
    },
  });
  assert.equal(Object.hasOwn(result, 'stdout'), false);
});

test('streaming async and sync paths opt into exact Codex final-message bytes', async () => {
  const { runStreamingProcess, runStreamingProcessSync } = await streamingModule();
  const entry = {
    bin: process.execPath,
    argv: [fixture, 'codex-final-message'],
    usageOutputKind: 'codex-jsonl',
    captureFinalMessage: true,
    shell: false,
  };
  const expected = Buffer.from('  exact review bytes: 한글🙂\n');
  const asyncResult = await runStreamingProcess(entry, { timeoutMs: 2_000 });
  const syncResult = runStreamingProcessSync(entry, { timeoutMs: 2_000 });

  for (const result of [asyncResult, syncResult]) {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(Buffer.isBuffer(result.finalMessage), true);
    assert.equal(result.finalMessage.equals(expected), true);
    assert.deepEqual(result.usage, {
      num_turns: 1,
      tokens: 12,
      input_tokens: 5,
      output_tokens: 7,
    });
  }
});

test('sync worker rejects non-canonical or malformed final-message transport', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const base = { status: 0, signal: null, stderr: '' };
  const usage = { num_turns: 1, tokens: 2, input_tokens: 1, output_tokens: 1 };
  for (const stdout of [
    JSON.stringify({ ok: true, usage, finalMessageBase64: '@@@' }),
    JSON.stringify({ ok: true, usage, finalMessageBase64: Buffer.from('x').toString('base64'), finalMessage: 'spoof' }),
  ]) {
    const result = runStreamingProcessSync({
      bin: process.execPath,
      argv: [],
      usageOutputKind: 'codex-jsonl',
      captureFinalMessage: true,
    }, { spawnSyncImpl: () => ({ ...base, stdout }) });
    assert.deepEqual(result, { ok: false, reason: 'worker-protocol-invalid' });
  }
});

test('sync worker bound accommodates the maximum final message plus maximum stderr diagnostic', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const finalMessage = Buffer.alloc(STREAM_LIMITS.finalMessageBytes, 0x61);
  const stderr = 'e'.repeat(STREAM_LIMITS.stderrBytes);
  const result = runStreamingProcessSync({
    bin: process.execPath,
    argv: [],
    usageOutputKind: 'codex-jsonl',
    captureFinalMessage: true,
  }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stderr: '',
      stdout: JSON.stringify({
        ok: true,
        usage: { num_turns: 1, tokens: 2, input_tokens: 1, output_tokens: 1 },
        finalMessageBase64: finalMessage.toString('base64'),
        stderr,
        stderrTruncated: true,
      }),
    }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.finalMessage.equals(finalMessage), true);
  assert.equal(Buffer.byteLength(result.stderr), STREAM_LIMITS.stderrBytes);
});

test('runStreamingProcessSync uses one dedicated Node worker and one runtime spawn', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  assert.equal(typeof runStreamingProcessSync, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-stream-sync-'));
  const counterPath = join(dir, 'runtime-spawns.txt');
  let workerSpawnCount = 0;
  let workerArgv;
  let workerInput;
  const result = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'count-once', counterPath],
    stdin: 'worker-only stdin',
    env: {},
    shell: false,
    usageOutputKind: 'claude-json',
  }, {
    timeoutMs: 2_000,
    spawnSyncImpl: (bin, argv, options) => {
      workerSpawnCount += 1;
      assert.equal(bin, process.execPath);
      assert.equal(options.shell, false);
      workerArgv = argv;
      workerInput = options.input;
      return spawnSync(bin, argv, options);
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(workerSpawnCount, 1, 'the facade must synchronously spawn one worker');
  assert.equal(readFileSync(counterPath, 'utf8'), 'spawned\n', 'the worker must spawn the runtime once');
  assert.equal(workerArgv.includes('worker-only stdin'), false, 'runtime stdin must not appear in worker argv');
  assert.equal(Buffer.from(workerInput).includes(Buffer.from('worker-only stdin')), true);
  assert.equal(Object.hasOwn(result, 'stdout'), false, 'worker protocol must not expose raw runtime stdout');
});

test('runStreamingProcessSync preserves timeout/non-zero precedence across the worker boundary', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const timedOut = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'timeout-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 40 });
  const nonzero = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'nonzero-valid'],
    usageOutputKind: 'claude-json',
  }, { timeoutMs: 2_000 });

  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' });
  assert.deepEqual(nonzero, { ok: false, reason: 'exit-7' });
  assert.equal(timedOut.usage, undefined);
  assert.equal(nonzero.usage, undefined);
});

test('runStreamingProcessSync escalates timeout termination so the runtime cannot outlive its worker', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  const dir = mkdtempSync(join(tmpdir(), 'deep-loop-stream-timeout-'));
  const pidPath = join(dir, 'runtime.pid');
  let pid;
  try {
    const result = runStreamingProcessSync({
      bin: process.execPath,
      argv: [fixture, 'ignore-term', pidPath],
      usageOutputKind: 'claude-json',
    }, { timeoutMs: 200 });
    pid = Number(readFileSync(pidPath, 'utf8'));

    assert.deepEqual(result, { ok: false, reason: 'timeout' });
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error?.code === 'ESRCH',
      'timed-out runtime must be gone before the worker returns',
    );
  } finally {
    if (Number.isInteger(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  }
});

test('runStreamingProcessSync bounds worker request and result protocols before decoding', async () => {
  const { runStreamingProcessSync } = await streamingModule();
  let spawns = 0;
  const requestOverflow = runStreamingProcessSync({
    bin: process.execPath,
    argv: [fixture, 'checkpoint', '/unused'],
    stdin: 'x'.repeat(2 * 1024 * 1024),
  }, {
    spawnSyncImpl: () => {
      spawns += 1;
      throw new Error('overflow request must not spawn a worker');
    },
  });
  const rawStdoutProtocol = runStreamingProcessSync({ bin: process.execPath, argv: [] }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ ok: true, usage: { num_turns: 1 }, stdout: 'raw-runtime-output' }),
      stderr: '',
    }),
  });
  const missingUsageProtocol = runStreamingProcessSync({ bin: process.execPath, argv: [] }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ ok: true }),
      stderr: '',
    }),
  });
  const resultOverflow = runStreamingProcessSync({ bin: process.execPath, argv: [] }, {
    spawnSyncImpl: () => ({
      status: 0,
      signal: null,
      stdout: 'x'.repeat(1025 * 1024),
      stderr: '',
    }),
  });

  assert.deepEqual(requestOverflow, { ok: false, reason: 'worker-request-overflow' });
  assert.equal(spawns, 0);
  assert.deepEqual(rawStdoutProtocol, { ok: false, reason: 'worker-protocol-invalid' });
  assert.deepEqual(missingUsageProtocol, { ok: false, reason: 'worker-protocol-invalid' });
  assert.deepEqual(resultOverflow, { ok: false, reason: 'worker-result-overflow' });
});
