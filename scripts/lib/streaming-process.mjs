import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCodexJsonlParser, parseClaudeUsage, STREAM_LIMITS } from './usage-parser.mjs';

const WORKER_REQUEST_BYTES = 2 * 1024 * 1024;
// 256 KiB final-message bytes become ~350 KiB canonical base64; add the independently
// bounded 64 KiB stderr diagnostic plus JSON overhead without permitting unbounded output.
const WORKER_RESULT_BYTES = 1024 * 1024;
const RUNTIME_KILL_GRACE_MS = 250;
const WORKER_TIMEOUT_GRACE_MS = RUNTIME_KILL_GRACE_MS + 1_000;
const NODE_TIMER_MAX_MS = 2_147_483_647;
const workerPath = fileURLToPath(new URL('../workers/streaming-child.mjs', import.meta.url));

function validTimeout(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= NODE_TIMER_MAX_MS;
}

function appendBounded(chunks, chunk, retainedBytes, limit) {
  const remaining = limit - retainedBytes;
  if (remaining <= 0) return retainedBytes;
  const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(retained);
  return retainedBytes + retained.length;
}

function decodeBoundedDiagnostic(chunks) {
  const text = Buffer.concat(chunks).toString('utf8');
  if (Buffer.byteLength(text, 'utf8') <= STREAM_LIMITS.stderrBytes) {
    return { text, encodingTruncated: false };
  }
  let bounded = '';
  let bytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > STREAM_LIMITS.stderrBytes) break;
    bounded += character;
    bytes += width;
  }
  return { text: bounded, encodingTruncated: true };
}

function withDiagnostic(result, stderrChunks, stderrTruncated) {
  const decoded = decodeBoundedDiagnostic(stderrChunks);
  if (stderrChunks.length > 0) result.stderr = decoded.text;
  if (stderrTruncated || decoded.encodingTruncated) result.stderrTruncated = true;
  return result;
}

export function runStreamingProcess(entry, {
  timeoutMs = 30 * 60 * 1000,
  spawnImpl = spawn,
} = {}) {
  if (!validTimeout(timeoutMs)) {
    return Promise.resolve({ ok: false, reason: 'invalid-timeout' });
  }
  if (!entry || typeof entry.bin !== 'string' || !Array.isArray(entry.argv)) {
    return Promise.resolve({ ok: false, reason: 'invalid-entry' });
  }
  if (entry.shell != null && entry.shell !== false) {
    return Promise.resolve({ ok: false, reason: 'shell-not-allowed' });
  }

  const usageKind = entry.usageOutputKind ?? 'claude-json';
  if (usageKind !== 'claude-json' && usageKind !== 'codex-jsonl') {
    return Promise.resolve({ ok: false, reason: 'unsupported-usage-kind' });
  }
  const stdinPayload = entry.stdin ?? '';
  const stdinRequired = Buffer.isBuffer(stdinPayload)
    ? stdinPayload.length > 0
    : String(stdinPayload).length > 0;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(entry.bin, entry.argv, {
        cwd: entry.cwd,
        env: entry.env ?? process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, reason: `spawn-error: ${error?.message || error}` });
      return;
    }

    const stderrChunks = [];
    let stderrBytes = 0;
    let stderrTotalBytes = 0;
    const claudeChunks = [];
    let claudeBytes = 0;
    let claudeTotalBytes = 0;
    let timedOut = false;
    let spawnError = null;
    let stdinError = null;
    let stdinDelivered = !stdinRequired;
    let settled = false;
    let forceKillTimer = null;
    const codexParser = usageKind === 'codex-jsonl'
      ? createCodexJsonlParser({ captureFinalMessage: entry.captureFinalMessage === true })
      : null;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* close/error settles the result */ }
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL'); } catch { /* outer worker bound remains the backstop */ }
        }
      }, RUNTIME_KILL_GRACE_MS);
    }, timeoutMs);
    timer?.unref?.();

    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (codexParser) {
        codexParser.write(buffer);
        return;
      }
      claudeTotalBytes += buffer.length;
      claudeBytes = appendBounded(claudeChunks, buffer, claudeBytes, STREAM_LIMITS.claudeOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTotalBytes += buffer.length;
      stderrBytes = appendBounded(stderrChunks, buffer, stderrBytes, STREAM_LIMITS.stderrBytes);
    });
    child.stdin.on('error', (error) => {
      if (stdinRequired && stdinError == null) stdinError = error;
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const diagnostic = (result) => withDiagnostic(
        result,
        stderrChunks,
        stderrTotalBytes > STREAM_LIMITS.stderrBytes,
      );

      if (spawnError) {
        resolve(diagnostic({ ok: false, reason: `spawn-error: ${spawnError?.message || spawnError}` }));
        return;
      }
      if (timedOut) {
        resolve(diagnostic({ ok: false, reason: 'timeout' }));
        return;
      }
      if (code !== 0) {
        resolve(diagnostic({ ok: false, reason: `exit-${code}` }));
        return;
      }
      if (stdinError || !stdinDelivered) {
        resolve(diagnostic({ ok: false, reason: 'stdin-error' }));
        return;
      }

      if (codexParser) {
        const parsed = codexParser.end();
        resolve(diagnostic(parsed.ok
          ? {
              ok: true,
              usage: parsed.usage,
              ...(Buffer.isBuffer(parsed.finalMessage) ? { finalMessage: parsed.finalMessage } : {}),
            }
          : parsed));
        return;
      }
      if (claudeTotalBytes > STREAM_LIMITS.claudeOutputBytes) {
        resolve(diagnostic({ ok: false, reason: 'claude-output-overflow' }));
        return;
      }
      const usage = parseClaudeUsage(Buffer.concat(claudeChunks, claudeBytes));
      resolve(diagnostic(usage == null
        ? { ok: false, reason: 'unmeasurable-fail-closed' }
        : { ok: true, usage }));
    });

    try {
      child.stdin.end(stdinPayload, (error) => {
        if (!stdinRequired) return;
        if (error && stdinError == null) stdinError = error;
        else if (!error) stdinDelivered = true;
      });
    } catch (error) {
      if (stdinRequired) stdinError = error;
      child.stdin.destroy();
    }
  });
}

function workerEntry(entry) {
  const stdin = Buffer.isBuffer(entry?.stdin)
    ? { encoding: 'base64', data: entry.stdin.toString('base64') }
    : { encoding: 'utf8', data: entry?.stdin == null ? '' : String(entry.stdin) };
  return {
    bin: entry?.bin,
    argv: entry?.argv,
    ...(entry && Object.hasOwn(entry, 'cwd') ? { cwd: entry.cwd } : {}),
    ...(entry && Object.hasOwn(entry, 'env') ? { env: entry.env } : {}),
    shell: entry?.shell ?? false,
    usageOutputKind: entry?.usageOutputKind ?? 'claude-json',
    captureFinalMessage: entry?.captureFinalMessage === true,
    stdin,
  };
}

function decodeWorkerResult(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  const allowedKeys = new Set(['ok', 'reason', 'usage', 'stderr', 'stderrTruncated', 'finalMessageBase64']);
  if (result == null || typeof result !== 'object' || Array.isArray(result)
    || typeof result.ok !== 'boolean'
    || Object.keys(result).some((key) => !allowedKeys.has(key))
    || (Object.hasOwn(result, 'stderr')
      && (typeof result.stderr !== 'string'
        || Buffer.byteLength(result.stderr, 'utf8') > STREAM_LIMITS.stderrBytes))
    || (Object.hasOwn(result, 'stderrTruncated') && typeof result.stderrTruncated !== 'boolean')) {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  if (result.ok === false) {
    if (typeof result.reason !== 'string' || Object.hasOwn(result, 'usage')
      || Object.hasOwn(result, 'finalMessageBase64')) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    return result;
  }
  if (Object.hasOwn(result, 'reason') || result.usage == null || typeof result.usage !== 'object'
    || Array.isArray(result.usage)
    || (!Number.isFinite(result.usage.num_turns) && !Number.isFinite(result.usage.tokens))) {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  if (Object.hasOwn(result, 'finalMessageBase64')) {
    if (typeof result.finalMessageBase64 !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.finalMessageBase64)) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    const finalMessage = Buffer.from(result.finalMessageBase64, 'base64');
    if (finalMessage.length > STREAM_LIMITS.finalMessageBytes
      || finalMessage.toString('base64') !== result.finalMessageBase64) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    const { finalMessageBase64: _encoded, ...rest } = result;
    return { ...rest, finalMessage };
  }
  return result;
}

export function runStreamingProcessSync(entry, {
  timeoutMs = 30 * 60 * 1000,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!validTimeout(timeoutMs)) return { ok: false, reason: 'invalid-timeout' };
  let request;
  try {
    request = JSON.stringify({ version: 1, entry: workerEntry(entry), timeoutMs });
  } catch {
    return { ok: false, reason: 'worker-request-invalid' };
  }
  if (Buffer.byteLength(request, 'utf8') > WORKER_REQUEST_BYTES) {
    return { ok: false, reason: 'worker-request-overflow' };
  }

  const workerTimeoutMs = timeoutMs + WORKER_TIMEOUT_GRACE_MS;
  let out;
  try {
    out = spawnSyncImpl(process.execPath, [workerPath], {
      input: request,
      encoding: 'utf8',
      maxBuffer: WORKER_RESULT_BYTES,
      timeout: workerTimeoutMs,
      shell: false,
    });
  } catch (error) {
    return { ok: false, reason: `worker-spawn-error: ${error?.message || error}` };
  }

  if (out.error) {
    if (out.error.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
    if (out.error.code === 'ENOBUFS') return { ok: false, reason: 'worker-result-overflow' };
    return { ok: false, reason: `worker-spawn-error: ${out.error?.message || out.error}` };
  }
  if (out.signal != null) return { ok: false, reason: 'worker-terminated' };
  if (out.status !== 0) return { ok: false, reason: `worker-exit-${out.status}` };
  if (Buffer.byteLength(out.stdout || '', 'utf8') > WORKER_RESULT_BYTES) {
    return { ok: false, reason: 'worker-result-overflow' };
  }
  return decodeWorkerResult(out.stdout || '');
}
