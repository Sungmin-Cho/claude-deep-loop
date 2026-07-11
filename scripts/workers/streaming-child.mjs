import { runStreamingProcess } from '../lib/streaming-process.mjs';

const WORKER_REQUEST_BYTES = 2 * 1024 * 1024;
const WORKER_RESULT_BYTES = 512 * 1024;

async function readRequest() {
  const chunks = [];
  let retained = 0;
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (retained < WORKER_REQUEST_BYTES) {
      const slice = buffer.subarray(0, WORKER_REQUEST_BYTES - retained);
      chunks.push(slice);
      retained += slice.length;
    }
  }
  if (total > WORKER_REQUEST_BYTES) throw new Error('worker-request-overflow');
  return JSON.parse(Buffer.concat(chunks, retained).toString('utf8'));
}

function decodeEntry(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error('worker-request-invalid');
  const stdin = value.stdin;
  if (stdin == null || typeof stdin !== 'object' || Array.isArray(stdin) || typeof stdin.data !== 'string') {
    throw new Error('worker-request-invalid');
  }
  let decodedStdin;
  if (stdin.encoding === 'utf8') decodedStdin = stdin.data;
  else if (stdin.encoding === 'base64') decodedStdin = Buffer.from(stdin.data, 'base64');
  else throw new Error('worker-request-invalid');
  return {
    bin: value.bin,
    argv: value.argv,
    ...(Object.hasOwn(value, 'cwd') ? { cwd: value.cwd } : {}),
    ...(Object.hasOwn(value, 'env') ? { env: value.env } : {}),
    shell: value.shell,
    usageOutputKind: value.usageOutputKind,
    stdin: decodedStdin,
  };
}

function boundedMessage(error) {
  return String(error?.message || error || 'worker-error').slice(0, 512);
}

let result;
try {
  const request = await readRequest();
  if (request?.version !== 1 || !Number.isFinite(request.timeoutMs) || request.timeoutMs < 0) {
    throw new Error('worker-request-invalid');
  }
  result = await runStreamingProcess(decodeEntry(request.entry), { timeoutMs: request.timeoutMs });
} catch (error) {
  result = { ok: false, reason: boundedMessage(error) };
}

let encoded = JSON.stringify(result);
if (Buffer.byteLength(encoded, 'utf8') > WORKER_RESULT_BYTES) {
  encoded = JSON.stringify({ ok: false, reason: 'worker-result-overflow' });
}
process.stdout.write(encoded);
