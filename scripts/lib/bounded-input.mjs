export const REVIEW_IMPORT_MAX_BYTES = 1_048_576;

export async function readBoundedText(stream, { maxBytes = REVIEW_IMPORT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('REVIEW_IMPORT_BOUND_INVALID: maxBytes must be a positive safe integer');
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('REVIEW_IMPORT_STREAM_INVALID: expected an async byte stream');
  }

  const chunks = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(String(value));
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new Error(`REVIEW_IMPORT_TOO_LARGE: stdin exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch (error) {
    throw new Error('REVIEW_IMPORT_UTF8_INVALID: stdin must be valid UTF-8', { cause: error });
  }
}

export const APP_STDIN_READ_TIMEOUT_MS = 30_000;
const TOKEN_PART = /^[A-Za-z0-9._-]+$/;
const validTokenPart = value => typeof value === 'string' && TOKEN_PART.test(value)
  && Buffer.byteLength(value, 'utf8') <= 512;

export function structuredReadyToken({ purpose, binding, mode }) {
  if (!validTokenPart(purpose) || !validTokenPart(binding)
      || !['pipe-open-noecho', 'pty-raw-noecho'].includes(mode)) {
    throw new Error('STRUCTURED_STDIN_BINDING_INVALID');
  }
  return `DEEP_LOOP_STDIN_READY:v1:${purpose}:${binding}:${mode}`;
}

function structuredChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value));
}

export async function readStructuredLine(stream, {
  mode, purpose, binding, maxBytes = 513,
  writeReady = token => process.stdout.write(`${token}\n`),
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  if (!stream || typeof stream.on !== 'function' || typeof stream.removeListener !== 'function'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 2) throw new Error('STRUCTURED_STDIN_INVALID');
  const token = structuredReadyToken({ purpose, binding, mode });
  return await new Promise((resolve, reject) => {
    let timer = null;
    let raw = false;
    let total = 0;
    let settled = false;
    let ready = false;
    let candidate = null;
    let finalizeImmediate = null;
    const chunks = [];
    const cleanup = () => {
      if (timer !== null) clearTimeoutFn(timer);
      if (finalizeImmediate !== null) clearImmediate(finalizeImmediate);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
      if (raw) { raw = false; stream.setRawMode(false); }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const onError = () => finish(new Error('STRUCTURED_STDIN_ERROR'));
    const onEnd = () => candidate === null
      ? finish(new Error('STRUCTURED_STDIN_EARLY_EOF')) : finish(null, candidate);
    const onClose = () => candidate === null
      ? finish(new Error('STRUCTURED_STDIN_CLOSED')) : finish(null, candidate);
    const onData = value => {
      if (!ready) return finish(new Error('STRUCTURED_STDIN_EARLY_WRITE'));
      const chunk = structuredChunk(value);
      if (candidate !== null && chunk.byteLength > 0) return finish(new Error('STRUCTURED_STDIN_MULTILINE'));
      total += chunk.byteLength;
      if (total > maxBytes) return finish(new Error('STRUCTURED_STDIN_TOO_LARGE'));
      chunks.push(chunk);
      const bytes = Buffer.concat(chunks, total);
      const lf = bytes.indexOf(0x0a);
      if (lf < 0) return;
      if (lf !== bytes.length - 1 || bytes.subarray(0, lf).includes(0x0a)) {
        return finish(new Error('STRUCTURED_STDIN_MULTILINE'));
      }
      try {
        candidate = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, lf));
        // Keep the listener live through a full later event-loop turn. A second write that was
        // already scheduled by the one-shot structured-input adapter is therefore rejected before
        // this process returns and removes the channel. End/close may still finalize immediately.
        finalizeImmediate = setImmediate(() => {
          finalizeImmediate = setImmediate(() => {
            finalizeImmediate = null;
            if (!settled && candidate !== null) finish(null, candidate);
          });
        });
      } catch {
        finish(new Error('STRUCTURED_STDIN_UTF8_INVALID'));
      }
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
    try {
      if (mode === 'pty-raw-noecho') {
        if (stream.isTTY !== true || typeof stream.setRawMode !== 'function') throw new Error('STRUCTURED_STDIN_RAW_UNAVAILABLE');
        raw = true;
        stream.setRawMode(true);
        if (settled) return;
      } else if (mode === 'pipe-open-noecho') {
        if (stream.isTTY === true) throw new Error('STRUCTURED_STDIN_PIPE_TTY');
        if (stream.readable !== true || stream.destroyed === true || stream.readableEnded === true
            || stream.readableAborted === true) throw new Error('STRUCTURED_STDIN_PIPE_CLOSED');
      }
      timer = setTimeoutFn(() => finish(new Error('STRUCTURED_STDIN_TIMEOUT')), APP_STDIN_READ_TIMEOUT_MS);
      writeReady(token);
      ready = true;
    } catch (error) {
      finish(error);
    }
  });
}
