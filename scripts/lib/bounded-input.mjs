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
