import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCodexJsonlParser, parseClaudeUsage, parseGrokJson, STREAM_LIMITS } from './usage-parser.mjs';
import {
  readProcessUsageReceipt,
  validateProcessUsageReceiptDescriptor,
} from './preflight-receipt-journal.mjs';
import { validCheckerProcessDiagnostic, validProcessStreamMetadata } from './schema.mjs';

const WORKER_REQUEST_BYTES = 2 * 1024 * 1024;
// 256 KiB final-message bytes become ~350 KiB canonical base64; add the independently
// bounded 64 KiB stderr diagnostic plus JSON overhead without permitting unbounded output.
const WORKER_RESULT_BYTES = 1024 * 1024;
const RUNTIME_KILL_GRACE_MS = 250;
const WORKER_TIMEOUT_GRACE_MS = RUNTIME_KILL_GRACE_MS + 1_000;
const NODE_TIMER_MAX_MS = 2_147_483_647;
const workerPath = fileURLToPath(new URL('../workers/streaming-child.mjs', import.meta.url));
const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function emptyStreamMetadata() {
  return { sha256: EMPTY_SHA256, byte_count: 0, truncated: false };
}

function bufferMetadata(value, truncated = false) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || '', 'utf8');
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byte_count: bytes.length,
    truncated,
  };
}

function emptyDiagnostic(reasonCode, processPhase) {
  return {
    reason_code: reasonCode,
    process_phase: processPhase,
    stderr: emptyStreamMetadata(),
    stdout: emptyStreamMetadata(),
  };
}

function withEmptyDiagnostic(result, enabled, reasonCode, processPhase) {
  return enabled
    ? { ...result, process_diagnostic: emptyDiagnostic(reasonCode, processPhase) }
    : result;
}

function validTimeout(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= NODE_TIMER_MAX_MS;
}

function exactCodexLaunchModel(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string'
    || arg.startsWith('--model=') || /^model\s*=/.test(arg))) return null;
  const positions = argv.flatMap((arg, index) => (
    arg === '--model' || arg === '-m' ? [index] : []
  ));
  const optionTerminator = argv.indexOf('--');
  if (positions.length !== 1
    || (optionTerminator !== -1 && positions[0] > optionTerminator)) return null;
  const model = argv[positions[0] + 1];
  return typeof model === 'string' && model.length > 0 && model.length <= 128
    && !/[\0\r\n]/.test(model) ? model : null;
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

function withDiagnostic(result, stderrChunks, stderrTruncated, processDiagnostic = null) {
  if (processDiagnostic != null) return { ...result, process_diagnostic: processDiagnostic };
  const decoded = decodeBoundedDiagnostic(stderrChunks);
  if (stderrChunks.length > 0) result.stderr = decoded.text;
  if (stderrTruncated || decoded.encodingTruncated) result.stderrTruncated = true;
  return result;
}

export function runStreamingProcess(entry, {
  timeoutMs = 30 * 60 * 1000,
  spawnImpl = spawn,
  nowFn = () => Date.now(),
} = {}) {
  const captureProcessDiagnostic = entry?.captureProcessDiagnostic === true;
  const captureProcessLifecycle = entry?.captureProcessLifecycle === true;
  if (!validTimeout(timeoutMs)) {
    return Promise.resolve(withEmptyDiagnostic(
      { ok: false, reason: 'invalid-timeout' }, captureProcessDiagnostic,
      'process-config-invalid', 'request',
    ));
  }
  if (!entry || typeof entry.bin !== 'string' || !Array.isArray(entry.argv)) {
    return Promise.resolve(withEmptyDiagnostic(
      { ok: false, reason: 'invalid-entry' }, captureProcessDiagnostic,
      'process-config-invalid', 'request',
    ));
  }
  if (entry.shell != null && entry.shell !== false) {
    return Promise.resolve(withEmptyDiagnostic(
      { ok: false, reason: 'shell-not-allowed' }, captureProcessDiagnostic,
      'process-config-invalid', 'request',
    ));
  }

  const usageKind = entry.usageOutputKind ?? 'claude-json';
  if (!['claude-json', 'codex-jsonl', 'grok-json'].includes(usageKind)) {
    return Promise.resolve(withEmptyDiagnostic(
      { ok: false, reason: 'unsupported-usage-kind' }, captureProcessDiagnostic,
      'process-config-invalid', 'request',
    ));
  }
  const providerModel = usageKind === 'codex-jsonl' && entry.captureProviderIdentity === true
    ? exactCodexLaunchModel(entry.argv)
    : null;
  if (usageKind === 'codex-jsonl' && entry.captureProviderIdentity === true
    && providerModel === null) {
    return Promise.resolve(withEmptyDiagnostic(
      { ok: false, reason: 'codex-provider-model-invalid' }, captureProcessDiagnostic,
      'process-config-invalid', 'request',
    ));
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
      resolve(withEmptyDiagnostic(
        { ok: false, reason: `spawn-error: ${error?.message || error}` }, captureProcessDiagnostic,
        'child-spawn-failed', 'child-spawn',
      ));
      return;
    }
    const startedAt = captureProcessLifecycle ? new Date(nowFn()).toISOString() : null;

    const stderrChunks = [];
    let stderrBytes = 0;
    let stderrTotalBytes = 0;
    const stderrHash = captureProcessDiagnostic ? createHash('sha256') : null;
    const claudeChunks = [];
    let claudeBytes = 0;
    let claudeTotalBytes = 0;
    const stdoutHash = captureProcessDiagnostic ? createHash('sha256') : null;
    let timedOut = false;
    let spawnError = null;
    let stdinError = null;
    let stdinDelivered = !stdinRequired;
    let settled = false;
    let forceKillTimer = null;
    const codexParser = usageKind === 'codex-jsonl'
      ? createCodexJsonlParser({
          captureFinalMessage: entry.captureFinalMessage === true,
          captureProviderIdentity: entry.captureProviderIdentity === true,
          providerModel,
        })
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
      stdoutHash?.update(buffer);
      if (captureProcessDiagnostic) claudeTotalBytes += buffer.length;
      if (codexParser) {
        codexParser.write(buffer);
        return;
      }
      if (!captureProcessDiagnostic) claudeTotalBytes += buffer.length;
      claudeBytes = appendBounded(claudeChunks, buffer, claudeBytes, STREAM_LIMITS.claudeOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrHash?.update(buffer);
      stderrTotalBytes += buffer.length;
      stderrBytes = appendBounded(stderrChunks, buffer, stderrBytes, STREAM_LIMITS.stderrBytes);
    });
    child.stdin.on('error', (error) => {
      if (stdinRequired && stdinError == null) stdinError = error;
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const lifecycle = captureProcessLifecycle ? {
        spawned: true,
        started_at: startedAt,
        finished_at: new Date(nowFn()).toISOString(),
        exit_code: code,
        signal: signal ?? null,
        timed_out: timedOut,
      } : null;
      const streams = captureProcessDiagnostic ? {
        stderr: {
          sha256: stderrHash.digest('hex'),
          byte_count: stderrTotalBytes,
          truncated: stderrTotalBytes > STREAM_LIMITS.stderrBytes,
        },
        stdout: {
          sha256: stdoutHash.digest('hex'),
          byte_count: claudeTotalBytes,
          truncated: !codexParser && claudeTotalBytes > STREAM_LIMITS.claudeOutputBytes,
        },
      } : null;
      const withLifecycle = result => lifecycle == null
        ? result
        : { ...result, process_lifecycle: lifecycle };
      const diagnostic = (result, reasonCode, processPhase) => withDiagnostic(
        withLifecycle(result),
        stderrChunks,
        stderrTotalBytes > STREAM_LIMITS.stderrBytes,
        streams == null ? null : { reason_code: reasonCode, process_phase: processPhase, ...streams },
      );
      const success = (result) => streams == null
        ? diagnostic(result)
        : { ...withLifecycle(result), process_streams: streams };

      if (spawnError) {
        resolve(diagnostic(
          { ok: false, reason: `spawn-error: ${spawnError?.message || spawnError}` },
          'child-spawn-failed', 'child-spawn',
        ));
        return;
      }
      if (timedOut) {
        resolve(diagnostic({ ok: false, reason: 'timeout' }, 'child-timeout', 'child-execution'));
        return;
      }
      if (code !== 0) {
        resolve(diagnostic({ ok: false, reason: `exit-${code}` }, 'child-nonzero-exit', 'child-execution'));
        return;
      }
      if (stdinError || !stdinDelivered) {
        resolve(diagnostic({ ok: false, reason: 'stdin-error' }, 'child-stdin-failed', 'child-stdin'));
        return;
      }

      if (codexParser) {
        const parsed = codexParser.end();
        resolve(parsed.ok ? success(
          {
            ok: true,
            usage: parsed.usage,
            ...(Buffer.isBuffer(parsed.finalMessage) ? { finalMessage: parsed.finalMessage } : {}),
            ...(parsed.providerIdentity ? { providerIdentity: parsed.providerIdentity } : {}),
          }
        ) : diagnostic(parsed, 'child-protocol-invalid', 'child-protocol'));
        return;
      }
      if (usageKind === 'grok-json') {
        if (claudeTotalBytes > STREAM_LIMITS.claudeOutputBytes) {
          resolve(diagnostic({ ok: false, reason: 'grok-output-overflow' }, 'child-output-overflow', 'child-protocol'));
          return;
        }
        const parsed = parseGrokJson(Buffer.concat(claudeChunks, claudeBytes));
        resolve(parsed == null
          ? diagnostic({ ok: false, reason: 'grok-json-invalid' }, 'child-protocol-invalid', 'child-protocol')
          : success({ ok: true, ...parsed }));
        return;
      }
      if (claudeTotalBytes > STREAM_LIMITS.claudeOutputBytes) {
        resolve(diagnostic({ ok: false, reason: 'claude-output-overflow' }, 'child-output-overflow', 'child-protocol'));
        return;
      }
      const usage = parseClaudeUsage(Buffer.concat(claudeChunks, claudeBytes));
      resolve(usage == null
        ? diagnostic({ ok: false, reason: 'unmeasurable-fail-closed' }, 'usage-unmeasurable', 'usage-parse')
        : success({ ok: true, usage }));
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
    captureProcessDiagnostic: entry?.captureProcessDiagnostic === true,
    stdin,
  };
}

function sameUsage(left, right) {
  if (left == null || typeof left !== 'object' || Array.isArray(left)
    || right == null || typeof right !== 'object' || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function decodeWorkerResult(stdout, usageReceiptDescriptor = null) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  const allowedKeys = new Set([
    'ok',
    'reason',
    'usage',
    'usageReceipt',
    'stderr',
    'stderrTruncated',
    'process_diagnostic',
    'process_streams',
    'finalMessageBase64',
    'providerIdentity',
  ]);
  if (result == null || typeof result !== 'object' || Array.isArray(result)
    || typeof result.ok !== 'boolean'
    || Object.keys(result).some((key) => !allowedKeys.has(key))
    || (Object.hasOwn(result, 'stderr')
      && (typeof result.stderr !== 'string'
        || Buffer.byteLength(result.stderr, 'utf8') > STREAM_LIMITS.stderrBytes))
    || (Object.hasOwn(result, 'stderrTruncated') && typeof result.stderrTruncated !== 'boolean')
    || (Object.hasOwn(result, 'process_diagnostic')
      && !validCheckerProcessDiagnostic(result.process_diagnostic))
    || (Object.hasOwn(result, 'process_streams')
      && (result.process_streams == null || typeof result.process_streams !== 'object'
        || Array.isArray(result.process_streams)
        || Object.keys(result.process_streams).sort().join(',') !== 'stderr,stdout'
        || !validProcessStreamMetadata(result.process_streams.stderr)
        || !validProcessStreamMetadata(result.process_streams.stdout)))
    || (Object.hasOwn(result, 'providerIdentity')
      && (result.providerIdentity == null || typeof result.providerIdentity !== 'object'
        || Array.isArray(result.providerIdentity)
        || JSON.stringify(Object.keys(result.providerIdentity).sort()) !== JSON.stringify(['model_id', 'session_id'])
        || typeof result.providerIdentity.session_id !== 'string'
        || result.providerIdentity.session_id.length === 0
        || result.providerIdentity.session_id.length > 512
        || /[\0\r\n]/.test(result.providerIdentity.session_id)
        || typeof result.providerIdentity.model_id !== 'string'
        || result.providerIdentity.model_id.length === 0
        || result.providerIdentity.model_id.length > 128
        || /[\0\r\n]/.test(result.providerIdentity.model_id)))) {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  if (result.ok === false) {
    if (typeof result.reason !== 'string' || Object.hasOwn(result, 'usage')
      || Object.hasOwn(result, 'usageReceipt') || Object.hasOwn(result, 'finalMessageBase64')
      || Object.hasOwn(result, 'process_streams') || Object.hasOwn(result, 'providerIdentity')) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    return result;
  }
  if (Object.hasOwn(result, 'reason') || result.usage == null || typeof result.usage !== 'object'
    || Array.isArray(result.usage)
    || Object.hasOwn(result, 'process_diagnostic')
    || (!Number.isFinite(result.usage.num_turns) && !Number.isFinite(result.usage.tokens))) {
    return { ok: false, reason: 'worker-protocol-invalid' };
  }
  if (usageReceiptDescriptor == null) {
    if (Object.hasOwn(result, 'usageReceipt')) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
  } else {
    if (result.usageReceipt == null || typeof result.usageReceipt !== 'object'
      || Array.isArray(result.usageReceipt)) {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
    try {
      const durable = readProcessUsageReceipt(usageReceiptDescriptor);
      if (durable == null || JSON.stringify(result.usageReceipt) !== JSON.stringify(durable)
        || !sameUsage(result.usage, durable.usage)) {
        return { ok: false, reason: 'worker-protocol-invalid' };
      }
      result.usageReceipt = durable;
    } catch {
      return { ok: false, reason: 'worker-protocol-invalid' };
    }
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
  usageReceipt = null,
} = {}) {
  const captureProcessDiagnostic = entry?.captureProcessDiagnostic === true;
  const fail = (result, reasonCode, processPhase, streams = null) => captureProcessDiagnostic
    ? {
        ...result,
        process_diagnostic: {
          reason_code: reasonCode,
          process_phase: processPhase,
          ...(streams ?? { stderr: emptyStreamMetadata(), stdout: emptyStreamMetadata() }),
        },
      }
    : result;
  if (!validTimeout(timeoutMs)) return fail(
    { ok: false, reason: 'invalid-timeout' }, 'process-config-invalid', 'request',
  );
  let normalizedUsageReceipt = null;
  if (usageReceipt != null) {
    try {
      if (entry?.usageOutputKind !== 'codex-jsonl') throw new Error('usage receipt requires Codex JSONL');
      normalizedUsageReceipt = validateProcessUsageReceiptDescriptor(usageReceipt);
    } catch {
      return fail({ ok: false, reason: 'usage-receipt-write-failed' }, 'usage-receipt-write-failed', 'receipt-write');
    }
  }
  let request;
  try {
    request = JSON.stringify({
      version: 1,
      entry: workerEntry(entry),
      timeoutMs,
      ...(normalizedUsageReceipt == null ? {} : { usageReceipt: normalizedUsageReceipt }),
    });
  } catch {
    return fail({ ok: false, reason: 'worker-request-invalid' }, 'worker-request-invalid', 'request');
  }
  if (Buffer.byteLength(request, 'utf8') > WORKER_REQUEST_BYTES) {
    return fail({ ok: false, reason: 'worker-request-overflow' }, 'worker-request-overflow', 'request');
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
    return fail({ ok: false, reason: `worker-spawn-error: ${error?.message || error}` }, 'worker-spawn-failed', 'worker-spawn');
  }

  const workerStreams = {
    stderr: bufferMetadata(out.stderr || '', false),
    stdout: bufferMetadata(out.stdout || '', out.error?.code === 'ENOBUFS'),
  };
  if (out.error) {
    if (out.error.code === 'ETIMEDOUT') return fail({ ok: false, reason: 'timeout' }, 'worker-timeout', 'worker-transport', workerStreams);
    if (out.error.code === 'ENOBUFS') return fail({ ok: false, reason: 'worker-result-overflow' }, 'worker-result-overflow', 'worker-transport', workerStreams);
    return fail({ ok: false, reason: `worker-spawn-error: ${out.error?.message || out.error}` }, 'worker-spawn-failed', 'worker-spawn', workerStreams);
  }
  if (out.signal != null) return fail({ ok: false, reason: 'worker-terminated' }, 'worker-terminated', 'worker-transport', workerStreams);
  if (out.status !== 0) return fail({ ok: false, reason: `worker-exit-${out.status}` }, 'worker-nonzero-exit', 'worker-transport', workerStreams);
  if (Buffer.byteLength(out.stdout || '', 'utf8') > WORKER_RESULT_BYTES) {
    return fail({ ok: false, reason: 'worker-result-overflow' }, 'worker-result-overflow', 'worker-transport', workerStreams);
  }
  const decoded = decodeWorkerResult(out.stdout || '', normalizedUsageReceipt);
  if (captureProcessDiagnostic && decoded?.ok === false && !validCheckerProcessDiagnostic(decoded.process_diagnostic)) {
    return fail({ ok: false, reason: 'worker-protocol-invalid' }, 'worker-protocol-invalid', 'worker-transport', workerStreams);
  }
  return decoded;
}
