import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, win32 } from 'node:path';

import { contentHash } from './envelope.mjs';
import { appendAnchored, readLines } from './integrity.mjs';
import { deriveIndependentReviewClaim, importReviewOutcome } from './review.mjs';
import {
  deriveReviewArtifactContract,
  parseDualReviewImport,
  parseReviewImport,
  prepareImportedDualReview,
  sha256File,
} from './review-import.mjs';
import { isMeasuredOneTurnUsage } from './budget.mjs';
import { containedRealFile } from './fs-safe.mjs';
import { leaseCheck } from './lease.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { captureReconciledRunSnapshot } from './state.mjs';
import { sessionRuntime } from './runtime.mjs';
import { runStreamingProcess } from './streaming-process.mjs';
import { STREAM_LIMITS } from './usage-parser.mjs';
import { captureTrustedCheckerSkill } from './codex-checker.mjs';
import { validDualCheckerLaunch } from './checker-launch.mjs';

export const DUAL_CHECKER_ROUTES = Object.freeze([
  Object.freeze({
    reviewer_id: 'deep-review',
    reviewer_adapter: 'codex-checker',
    provider_id: 'openai-codex',
    model_id: 'gpt-5.6-sol',
  }),
  Object.freeze({
    reviewer_id: 'grok-review',
    reviewer_adapter: 'grok-checker',
    provider_id: 'xai-grok',
    model_id: 'grok-4.6',
  }),
]);

export async function runDualCheckerProcesses(entries, { runProcess } = {}) {
  if (!Array.isArray(entries) || entries.length !== 2 || typeof runProcess !== 'function') {
    throw new Error('DUAL_CHECKER_PROCESS_INPUT_INVALID');
  }
  // Construct both promises before observing either. A synchronous throw from either
  // launch fails the pair; no first result can influence whether the second starts.
  const pending = entries.map(entry => Promise.resolve().then(() => runProcess(entry)));
  return Promise.all(pending);
}

const DUAL_WORKER_REQUEST_BYTES = 4 * 1024 * 1024;
const DUAL_WORKER_RESULT_BYTES = 2 * 1024 * 1024;
const DUAL_WORKER_TIMEOUT_GRACE_MS = 1_250;
const NODE_TIMER_MAX_MS = 2_147_483_647;
const dualWorkerPath = fileURLToPath(import.meta.url);

function validTimeout(timeoutMs) {
  return Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= NODE_TIMER_MAX_MS;
}

function encodeWorkerEntry(entry, index) {
  const expectedKind = index === 0 ? 'codex-jsonl' : 'grok-json';
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.bin !== 'string' || entry.bin.length === 0
    || !Array.isArray(entry.argv) || entry.argv.some(arg => typeof arg !== 'string')
    || entry.shell !== false || entry.usageOutputKind !== expectedKind
    || entry.captureFinalMessage !== true || entry.captureProcessDiagnostic !== true
    || entry.captureProcessLifecycle !== true
    || (index === 0 && entry.captureProviderIdentity !== true)
    || (Object.hasOwn(entry, 'cwd') && typeof entry.cwd !== 'string')
    || (Object.hasOwn(entry, 'env') && (entry.env == null || typeof entry.env !== 'object'
      || Array.isArray(entry.env) || Object.values(entry.env).some(value => typeof value !== 'string')))) {
    throw new Error('dual-worker-request-invalid');
  }
  const stdin = Buffer.isBuffer(entry.stdin)
    ? { encoding: 'base64', data: entry.stdin.toString('base64') }
    : { encoding: 'utf8', data: entry.stdin == null ? '' : String(entry.stdin) };
  return {
    bin: entry.bin,
    argv: entry.argv,
    ...(Object.hasOwn(entry, 'cwd') ? { cwd: entry.cwd } : {}),
    ...(Object.hasOwn(entry, 'env') ? { env: entry.env } : {}),
    shell: false,
    usageOutputKind: expectedKind,
    captureFinalMessage: true,
    captureProviderIdentity: index === 0,
    captureProcessDiagnostic: true,
    captureProcessLifecycle: true,
    stdin,
  };
}

function decodeWorkerEntry(value, index) {
  const expectedKeys = [
    'argv', 'bin', 'captureFinalMessage', 'captureProcessDiagnostic',
    'captureProcessLifecycle', 'captureProviderIdentity', 'shell', 'stdin', 'usageOutputKind',
    ...(Object.hasOwn(value || {}, 'cwd') ? ['cwd'] : []),
    ...(Object.hasOwn(value || {}, 'env') ? ['env'] : []),
  ].sort();
  if (value == null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
    || value.stdin == null || typeof value.stdin !== 'object' || Array.isArray(value.stdin)
    || JSON.stringify(Object.keys(value.stdin).sort()) !== JSON.stringify(['data', 'encoding'])
    || typeof value.stdin.data !== 'string'
    || !['utf8', 'base64'].includes(value.stdin.encoding)) {
    throw new Error('dual-worker-request-invalid');
  }
  const decoded = encodeWorkerEntry({
    ...value,
    stdin: value.stdin.encoding === 'base64'
      ? Buffer.from(value.stdin.data, 'base64')
      : value.stdin.data,
  }, index);
  if (value.stdin.encoding === 'base64'
    && decoded.stdin.data !== value.stdin.data) throw new Error('dual-worker-request-invalid');
  return {
    ...decoded,
    stdin: value.stdin.encoding === 'base64'
      ? Buffer.from(value.stdin.data, 'base64')
      : value.stdin.data,
  };
}

function safeWorkerIdentity(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\0\r\n]/.test(value);
}

function validWorkerStream(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify(['byte_count', 'sha256', 'truncated'])
    && SHA256.test(value.sha256 || '') && Number.isSafeInteger(value.byte_count)
    && value.byte_count >= 0 && typeof value.truncated === 'boolean';
}

function validWorkerLifecycle(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      'exit_code', 'finished_at', 'signal', 'spawned', 'started_at', 'timed_out',
    ])) return false;
  const started = new Date(value.started_at);
  const finished = new Date(value.finished_at);
  return value.spawned === true
    && Number.isSafeInteger(value.exit_code)
    && value.exit_code === 0
    && value.signal === null
    && value.timed_out === false
    && Number.isFinite(started.getTime()) && started.toISOString() === value.started_at
    && Number.isFinite(finished.getTime()) && finished.toISOString() === value.finished_at
    && finished.getTime() >= started.getTime();
}

function encodeTransportResult(result) {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, reason: 'transport-result-invalid' };
  }
  const encoded = { ...result };
  if (Buffer.isBuffer(encoded.finalMessage)) {
    encoded.finalMessageBase64 = encoded.finalMessage.toString('base64');
    delete encoded.finalMessage;
  }
  return encoded;
}

function decodeTransportResult(result) {
  const allowed = new Set([
    'ok', 'reason', 'usage', 'stderr', 'stderrTruncated', 'process_diagnostic',
    'process_lifecycle', 'process_streams', 'finalMessageBase64', 'providerIdentity',
  ]);
  if (result == null || typeof result !== 'object' || Array.isArray(result)
    || typeof result.ok !== 'boolean' || Object.keys(result).some(key => !allowed.has(key))) {
    throw new Error('dual-worker-protocol-invalid');
  }
  if (result.ok === false) {
    if (!safeWorkerIdentity(result.reason, 512) || Object.hasOwn(result, 'usage')
      || Object.hasOwn(result, 'finalMessageBase64') || Object.hasOwn(result, 'providerIdentity')) {
      throw new Error('dual-worker-protocol-invalid');
    }
    return structuredClone(result);
  }
  if (!isMeasuredOneTurnUsage(result.usage)
    || typeof result.finalMessageBase64 !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.finalMessageBase64)
    || result.providerIdentity == null || typeof result.providerIdentity !== 'object'
    || Array.isArray(result.providerIdentity)
    || JSON.stringify(Object.keys(result.providerIdentity).sort())
      !== JSON.stringify(['model_id', 'session_id'])
    || !safeWorkerIdentity(result.providerIdentity.session_id, 512)
    || !safeWorkerIdentity(result.providerIdentity.model_id, 128)
    || !validWorkerLifecycle(result.process_lifecycle)
    || result.process_streams == null || typeof result.process_streams !== 'object'
    || Array.isArray(result.process_streams)
    || JSON.stringify(Object.keys(result.process_streams).sort())
      !== JSON.stringify(['stderr', 'stdout'])
    || !validWorkerStream(result.process_streams.stderr)
    || !validWorkerStream(result.process_streams.stdout)) {
    throw new Error('dual-worker-protocol-invalid');
  }
  const finalMessage = Buffer.from(result.finalMessageBase64, 'base64');
  if (finalMessage.length === 0 || finalMessage.length > STREAM_LIMITS.finalMessageBytes
    || finalMessage.toString('base64') !== result.finalMessageBase64) {
    throw new Error('dual-worker-protocol-invalid');
  }
  const decoded = structuredClone(result);
  delete decoded.finalMessageBase64;
  decoded.finalMessage = finalMessage;
  return decoded;
}

function decodeDualWorkerResponse(stdout) {
  let value;
  try { value = JSON.parse(stdout); }
  catch { return { ok: false, reason: 'dual-worker-protocol-invalid' }; }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'dual-worker-protocol-invalid' };
  }
  if (value.ok === false && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['ok', 'reason'])
    && safeWorkerIdentity(value.reason, 512)) return value;
  if (value.ok !== true || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['ok', 'results'])
    || !Array.isArray(value.results) || value.results.length !== 2) {
    return { ok: false, reason: 'dual-worker-protocol-invalid' };
  }
  try { return { ok: true, results: value.results.map(decodeTransportResult) }; }
  catch { return { ok: false, reason: 'dual-worker-protocol-invalid' }; }
}

export function runDualStreamingProcessesSync(entries, {
  timeoutMs = 30 * 60 * 1000,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!Array.isArray(entries) || entries.length !== 2 || !validTimeout(timeoutMs)) {
    return { ok: false, reason: 'dual-worker-request-invalid' };
  }
  let request;
  try {
    request = JSON.stringify({
      version: 1,
      entries: entries.map(encodeWorkerEntry),
      timeoutMs,
    });
  } catch {
    return { ok: false, reason: 'dual-worker-request-invalid' };
  }
  if (Buffer.byteLength(request, 'utf8') > DUAL_WORKER_REQUEST_BYTES
    || timeoutMs > NODE_TIMER_MAX_MS - DUAL_WORKER_TIMEOUT_GRACE_MS) {
    return { ok: false, reason: 'dual-worker-request-invalid' };
  }
  let child;
  try {
    child = spawnSyncImpl(process.execPath, [dualWorkerPath, '--dual-process-worker'], {
      input: request,
      encoding: 'utf8',
      maxBuffer: DUAL_WORKER_RESULT_BYTES,
      timeout: timeoutMs + DUAL_WORKER_TIMEOUT_GRACE_MS,
      shell: false,
    });
  } catch {
    return { ok: false, reason: 'dual-worker-spawn-failed' };
  }
  if (child?.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'dual-worker-timeout' };
  if (child?.error?.code === 'ENOBUFS'
    || Buffer.byteLength(child?.stdout || '', 'utf8') > DUAL_WORKER_RESULT_BYTES) {
    return { ok: false, reason: 'dual-worker-result-overflow' };
  }
  if (child?.error || child?.signal != null || child?.status !== 0) {
    return { ok: false, reason: 'dual-worker-transport-failed' };
  }
  return decodeDualWorkerResponse(child.stdout || '');
}

async function readDualWorkerRequest() {
  const chunks = [];
  let retained = 0;
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (retained < DUAL_WORKER_REQUEST_BYTES) {
      const slice = bytes.subarray(0, DUAL_WORKER_REQUEST_BYTES - retained);
      chunks.push(slice);
      retained += slice.length;
    }
  }
  if (total > DUAL_WORKER_REQUEST_BYTES) throw new Error('dual-worker-request-overflow');
  return JSON.parse(Buffer.concat(chunks, retained).toString('utf8'));
}

async function runDualWorkerMain() {
  let response;
  try {
    const request = await readDualWorkerRequest();
    if (request == null || typeof request !== 'object' || Array.isArray(request)
      || JSON.stringify(Object.keys(request).sort())
        !== JSON.stringify(['entries', 'timeoutMs', 'version'])
      || request.version !== 1 || !validTimeout(request.timeoutMs)
      || !Array.isArray(request.entries) || request.entries.length !== 2) {
      throw new Error('dual-worker-request-invalid');
    }
    const entries = request.entries.map(decodeWorkerEntry);
    const results = await runDualCheckerProcesses(entries, {
      runProcess: entry => runStreamingProcess(entry, { timeoutMs: request.timeoutMs }),
    });
    response = { ok: true, results: results.map(encodeTransportResult) };
  } catch (error) {
    response = {
      ok: false,
      reason: String(error?.message || error || 'dual-worker-failed').slice(0, 512),
    };
  }
  let encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded, 'utf8') > DUAL_WORKER_RESULT_BYTES) {
    encoded = JSON.stringify({ ok: false, reason: 'dual-worker-result-overflow' });
  }
  process.stdout.write(encoded);
}

function exactOptions(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commonSourceBinding(scalarClaim) {
  const {
    reviewer_id: _reviewerId,
    attempt_id: _attemptId,
    evidence: _legacyEvidence,
    contract: _legacyContract,
    ...sourceClaim
  } = scalarClaim;
  return sourceClaim;
}

function attemptClaim(route, slot, attemptId, sourceClaimSha256) {
  return {
    slot,
    attempt_id: attemptId,
    reviewer_id: route.reviewer_id,
    reviewer_adapter: route.reviewer_adapter,
    provider_id: route.provider_id,
    model_id: route.model_id,
    session_id: null,
    source_claim_sha256: sourceClaimSha256,
    status: 'claimed',
    capture_proof: null,
    process_proof: null,
    report_proof: null,
    cost_proof: null,
  };
}

export function claimDualIndependentReview(root, runId, options = {}) {
  if (!exactOptions(options)) throw new Error('DUAL_REVIEW_CLAIM_INPUT_INVALID');
  for (const key of [
    'aggregation_id', 'attempts', 'routes', 'reviewer_id', 'reviewer_adapter',
    'provider_id', 'model_id', 'source_claim_sha256',
  ]) {
    if (Object.hasOwn(options, key)) throw new Error(`REVIEW_METADATA_FORBIDDEN: claim derives ${key}`);
  }
  const { episodeId, fence, idFactory = randomUUID, now } = options;
  if (typeof episodeId !== 'string' || episodeId.length === 0
    || typeof idFactory !== 'function') {
    throw new Error('DUAL_REVIEW_CLAIM_INPUT_INVALID');
  }

  const aggregationId = `aggregation-${idFactory()}`;
  const attemptIds = [`attempt-${idFactory()}`, `attempt-${idFactory()}`];
  let sourceBinding;
  let sourceClaimSha256;
  let attempts;
  const eventData = { episode_id: episodeId, aggregation_id: aggregationId };

  appendAnchored(root, runId, {
    type: 'independent-review-aggregation-claimed', data: eventData, now,
  }, (loop) => {
    const checker = loop.episodes.find(episode => episode.id === episodeId);
    loop.schema_version = '0.5.0';
    checker.status = 'in_progress';
    delete checker.attempt_id;
    delete checker.review_claim;
    checker.review_aggregation = {
      schema_version: '2.0',
      policy: 'ALL_LITERAL_APPROVE_2',
      aggregation_id: aggregationId,
      required_attempt_count: 2,
      aggregate_status: 'in_progress',
      source_binding: sourceBinding,
      attempts,
      aggregate_proof: null,
    };
  }, (loop) => {
    const checked = leaseCheck(loop, { ...fence, runtime: sessionRuntime(loop) });
    if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    if (loop.status !== 'running') throw new Error('REVIEW_CLAIM_RUN_NOT_RUNNING');
    const checker = loop.episodes.find(episode => episode.id === episodeId);
    if (checker?.review_aggregation !== undefined || checker?.review_claim !== undefined) {
      throw new Error('REVIEW_ALREADY_CLAIMED');
    }
    if (checker?.status !== 'pending') throw new Error('REVIEW_CLAIM_NOT_PENDING');
    const scalar = deriveIndependentReviewClaim(root, loop, episodeId, attemptIds[0], fence);
    const sourceWithoutDigest = commonSourceBinding(scalar.claim);
    sourceClaimSha256 = contentHash(JSON.stringify(sourceWithoutDigest));
    sourceBinding = { ...sourceWithoutDigest, source_claim_sha256: sourceClaimSha256 };
    attempts = DUAL_CHECKER_ROUTES.map((route, index) => (
      attemptClaim(route, index, attemptIds[index], sourceClaimSha256)
    ));
    Object.assign(eventData, {
      target_maker: sourceBinding.target_maker,
      workstream_id: sourceBinding.workstream_id,
      point: sourceBinding.point,
      source_claim_sha256: sourceClaimSha256,
      attempts: attempts.map(attempt => ({
        attempt_id: attempt.attempt_id,
        reviewer_id: attempt.reviewer_id,
        reviewer_adapter: attempt.reviewer_adapter,
        provider_id: attempt.provider_id,
        model_id: attempt.model_id,
        slot: attempt.slot,
      })),
    });
  });

  return {
    ok: true,
    checker_episode_id: episodeId,
    aggregation_id: aggregationId,
    source_binding: structuredClone(sourceBinding),
    attempts: structuredClone(attempts),
  };
}

const SHA256 = /^[0-9a-f]{64}$/;
const CAPTURE_KEYS = Object.freeze([
  'capture_id', 'run_id', 'checker_episode_id', 'attempt_id', 'source_claim_sha256',
  'record_path', 'record_sha256', 'manifest_path',
  'source_manifest_sha256', 'skill_path', 'source_skill_sha256',
]);
const PROCESS_KEYS = Object.freeze([
  'provider_id', 'model_id', 'session_id', 'executable', 'launch', 'lifecycle', 'streams',
  'usage',
]);
const PROCESS_EXECUTABLE_KEYS = Object.freeze([
  'checker', 'reviewer_adapter', 'provider_id', 'model_id', 'canonical_path', 'sha256',
  'version', 'platform', 'arch', 'source', 'authenticode',
]);
const PROCESS_LAUNCH_KEYS = Object.freeze(['bin', 'argv', 'cwd', 'shell']);
const PROCESS_LIFECYCLE_KEYS = Object.freeze([
  'spawned', 'started_at', 'finished_at', 'exit_code', 'signal', 'timed_out',
]);
const PROCESS_STREAM_KEYS = Object.freeze(['stdout', 'stderr']);
const PROCESS_STREAM_METADATA_KEYS = Object.freeze(['sha256', 'byte_count', 'truncated']);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function safeIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\0\r\n]/.test(value);
}

function safeAbsolute(value) {
  return safeIdentity(value) && (isAbsolute(value) || win32.isAbsolute(value));
}

function validProcessStream(value) {
  return exactKeys(value, PROCESS_STREAM_METADATA_KEYS)
    && SHA256.test(value.sha256 || '')
    && Number.isSafeInteger(value.byte_count) && value.byte_count >= 0
    && typeof value.truncated === 'boolean';
}

function processSecurityIdentity(approval) {
  if (approval == null || typeof approval !== 'object' || Array.isArray(approval)) return null;
  const identity = { ...approval };
  delete identity.approved_by;
  delete identity.approved_at;
  return identity;
}

function validProcessExecutable(value, attempt) {
  const expectedChecker = attempt.slot === 0 ? 'codex' : 'grok';
  return exactKeys(value, PROCESS_EXECUTABLE_KEYS)
    && value.checker === expectedChecker
    && value.reviewer_adapter === attempt.reviewer_adapter
    && value.provider_id === attempt.provider_id
    && value.model_id === attempt.model_id
    && safeAbsolute(value.canonical_path)
    && SHA256.test(value.sha256 || '')
    && safeIdentity(value.version) && safeIdentity(value.platform) && safeIdentity(value.arch)
    && value.source === 'human-explicit'
    && (value.authenticode === null
      || (typeof value.authenticode === 'object' && !Array.isArray(value.authenticode)));
}

function validProcessLaunch(value, executable, attempt, projectRoot) {
  return exactKeys(value, PROCESS_LAUNCH_KEYS) && validDualCheckerLaunch({
    launch: value,
    executable,
    attempt,
    projectRoot,
  });
}

function validProcessLifecycle(value) {
  if (!exactKeys(value, PROCESS_LIFECYCLE_KEYS)) return false;
  const started = new Date(value.started_at);
  const finished = new Date(value.finished_at);
  return value.spawned === true && value.exit_code === 0 && value.signal === null
    && value.timed_out === false
    && Number.isFinite(started.getTime()) && started.toISOString() === value.started_at
    && Number.isFinite(finished.getTime()) && finished.toISOString() === value.finished_at
    && finished.getTime() >= started.getTime();
}

function attemptIdentity(aggregation, attempt) {
  return {
    aggregation_id: aggregation.aggregation_id,
    slot: attempt.slot,
    attempt_id: attempt.attempt_id,
    reviewer_id: attempt.reviewer_id,
    reviewer_adapter: attempt.reviewer_adapter,
    provider_id: attempt.provider_id,
    model_id: attempt.model_id,
    source_claim_sha256: attempt.source_claim_sha256,
  };
}

function attemptClaimHash(aggregation, attempt) {
  return contentHash(JSON.stringify(attemptIdentity(aggregation, attempt)));
}

function validateCaptureProof(root, runId, capture, {
  checkerEpisodeId, attemptId, sourceClaimSha256,
} = {}) {
  if (!exactKeys(capture, CAPTURE_KEYS)) throw new Error('DUAL_REVIEW_CAPTURE_INVALID');
  try {
    return captureTrustedCheckerSkill({
      root: canonicalProjectRoot(root),
      runId,
      checkerEpisodeId,
      attemptId,
      sourceClaimSha256,
      proof: capture,
    });
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith('checker-capture-binding-invalid')
      || message.startsWith('checker-capture-proof-invalid')) {
      throw new Error('DUAL_REVIEW_CAPTURE_INVALID');
    }
    throw new Error('DUAL_REVIEW_CAPTURE_MISMATCH');
  }
}

export function verifyDualCaptureProof(root, runId, capture, expected = {}) {
  return validateCaptureProof(root, runId, capture, expected);
}

export function blockDualIndependentReview(root, runId, options = {}) {
  if (!exactOptions(options)) throw new Error('DUAL_REVIEW_BLOCK_INPUT_INVALID');
  const { episodeId, reason, fence, now } = options;
  if (!safeIdentity(episodeId) || !safeIdentity(reason)) {
    throw new Error('DUAL_REVIEW_BLOCK_INPUT_INVALID');
  }
  const eventData = { episode_id: episodeId, reason };
  appendAnchored(root, runId, {
    type: 'independent-review-aggregation-blocked', data: eventData, now,
  }, (loop) => {
    const checker = loop.episodes.find(episode => episode.id === episodeId);
    checker.status = 'blocked';
    checker.review_aggregation.aggregate_status = 'blocked';
    checker.review_aggregation.aggregate_proof = null;
    for (const attempt of checker.review_aggregation.attempts) {
      if (attempt.status === 'claimed') attempt.status = 'blocked';
    }
  }, (loop) => {
    const checked = leaseCheck(loop, fence);
    if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    const checker = loop.episodes.find(episode => episode.id === episodeId);
    const aggregation = checker?.review_aggregation;
    if (loop.schema_version !== '0.5.0' || checker?.role !== 'checker'
      || checker.status !== 'in_progress' || aggregation?.schema_version !== '2.0'
      || aggregation.aggregate_status !== 'in_progress'
      || !Array.isArray(aggregation.attempts) || aggregation.attempts.length !== 2
      || aggregation.attempts.every(attempt => attempt.status === 'imported')) {
      throw new Error('DUAL_REVIEW_BLOCK_CONTEXT_INVALID');
    }
    Object.assign(eventData, {
      aggregation_id: aggregation.aggregation_id,
      target_maker: checker.target_maker,
      attempt_ids: aggregation.attempts.map(attempt => attempt.attempt_id),
    });
  });
  return { ok: true, status: 'blocked', checker_episode_id: episodeId, reason };
}

function validateProcessInput(root, process, attempt) {
  if (!exactKeys(process, PROCESS_KEYS)
    || process.provider_id !== attempt.provider_id
    || process.model_id !== attempt.model_id
    || !safeIdentity(process.session_id)
    || !isMeasuredOneTurnUsage(process.usage)
    || !validProcessExecutable(process.executable, attempt)
    || !validProcessLaunch(
      process.launch, process.executable, attempt, canonicalProjectRoot(root),
    )
    || !validProcessLifecycle(process.lifecycle)
    || !exactKeys(process.streams, PROCESS_STREAM_KEYS)
    || !validProcessStream(process.streams.stdout)
    || !validProcessStream(process.streams.stderr)) {
    throw new Error('DUAL_REVIEW_PROCESS_INVALID');
  }
  return structuredClone(process);
}

function processReceiptPayload(root, runId, aggregation, attempt, capture, process) {
  return {
    contract: 'deep-loop-dual-checker-process-receipt-v2',
    project_root: canonicalProjectRoot(root),
    run_id: runId,
    ...attemptIdentity(aggregation, attempt),
    session_id: process.session_id,
    claim_hash: attemptClaimHash(aggregation, attempt),
    capture,
    executable: process.executable,
    launch: process.launch,
    lifecycle: process.lifecycle,
    streams: process.streams,
    usage: process.usage,
  };
}

function receiptWithId(payload) {
  return { ...payload, receipt_id: contentHash(JSON.stringify(payload)) };
}

function findDualContext(loop, episodeId, attemptId, { allowTerminal = false } = {}) {
  const checker = (loop.episodes || []).find(episode => episode.id === episodeId);
  const aggregation = checker?.review_aggregation;
  const matches = (aggregation?.attempts || []).filter(attempt => attempt.attempt_id === attemptId);
  const inProgress = checker?.status === 'in_progress'
    && aggregation?.aggregate_status === 'in_progress';
  const terminal = allowTerminal && ['approved', 'rejected'].includes(checker?.status)
    && aggregation?.aggregate_status === checker.status;
  if (loop.schema_version !== '0.5.0' || checker?.role !== 'checker'
    || (!inProgress && !terminal)
    || !Array.isArray(aggregation.attempts) || aggregation.attempts.length !== 2
    || matches.length !== 1) {
    throw new Error('DUAL_REVIEW_CONTEXT_INVALID');
  }
  const maker = (loop.episodes || []).find(episode => episode.id === checker.target_maker);
  const workstream = (loop.workstreams || []).find(item => item.id === checker.workstream_id);
  if (!maker || maker.role !== 'maker' || maker.status !== 'done' || !workstream
    || maker.workstream_id !== checker.workstream_id || maker.point !== checker.point) {
    throw new Error('DUAL_REVIEW_BINDING_INVALID');
  }
  return { checker, aggregation, attempt: matches[0], maker, workstream };
}

export function settleDualAttemptProcess(root, runId, options = {}) {
  if (!exactOptions(options)) throw new Error('DUAL_REVIEW_PROCESS_INPUT_INVALID');
  const { episodeId, attemptId, capture, process, fence, now } = options;
  if (!safeIdentity(episodeId) || !safeIdentity(attemptId)) {
    throw new Error('DUAL_REVIEW_PROCESS_INPUT_INVALID');
  }
  const snapshot = captureReconciledRunSnapshot(root, runId).data;
  const initial = findDualContext(snapshot, episodeId, attemptId);
  if (initial.attempt.status !== 'claimed' || initial.attempt.session_id !== null
    || initial.attempt.process_proof !== null) {
    throw new Error('DUAL_REVIEW_PROCESS_ALREADY_SETTLED');
  }
  const exactCapture = validateCaptureProof(root, runId, capture, {
    checkerEpisodeId: initial.checker.id,
    attemptId: initial.attempt.attempt_id,
    sourceClaimSha256: initial.attempt.source_claim_sha256,
  });
  const exactProcess = validateProcessInput(root, process, initial.attempt);
  const payload = processReceiptPayload(
    root, runId, initial.aggregation, initial.attempt, exactCapture, exactProcess,
  );
  const receipt = receiptWithId(payload);
  const receiptRel = `preflight/process-receipts/${receipt.receipt_id}-dual-checker.json`;
  const receiptPath = `.deep-loop/runs/${runId}/${receiptRel}`;
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
  const eventData = {
    turns: exactProcess.usage.num_turns,
    tokens: exactProcess.usage.tokens,
    reported_turns: exactProcess.usage.num_turns,
    reported_tokens: exactProcess.usage.tokens,
    input_tokens: exactProcess.usage.input_tokens,
    output_tokens: exactProcess.usage.output_tokens,
    owner: initial.aggregation.source_binding.lease_owner,
    generation: initial.aggregation.source_binding.lease_generation,
    source: `${exactProcess.provider_id}-dual-checker-measured`,
    process_receipt_id: receipt.receipt_id,
    dual_checker_aggregation_id: initial.aggregation.aggregation_id,
    dual_checker_attempt_id: initial.attempt.attempt_id,
    provider_id: exactProcess.provider_id,
    model_id: exactProcess.model_id,
    session_id: exactProcess.session_id,
  };
  let result;
  appendAnchored(root, runId, { type: 'cost', data: eventData, now }, (loop, spent, tx) => {
    const locked = findDualContext(loop, episodeId, attemptId);
    const attempt = locked.attempt;
    attempt.session_id = exactProcess.session_id;
    attempt.capture_proof = exactCapture;
    attempt.process_proof = {
      receipt_id: receipt.receipt_id,
      receipt: receiptPath,
      provider_id: exactProcess.provider_id,
      model_id: exactProcess.model_id,
      session_id: exactProcess.session_id,
      claim_hash: payload.claim_hash,
      executable: exactProcess.executable,
      launch: exactProcess.launch,
      lifecycle: exactProcess.lifecycle,
      streams: exactProcess.streams,
    };
    attempt.cost_proof = {
      receipt_id: receipt.receipt_id,
      event_seq: tx.event_identity.seq,
      event_checksum: tx.event_identity.checksum,
      usage: exactProcess.usage,
    };
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    const session = (loop.session_chain?.sessions || []).find(item => (
      item.run_id === initial.aggregation.source_binding.lease_owner
    ));
    if (!session) throw new Error('DUAL_REVIEW_ACCOUNTING_ORIGIN_INVALID');
    session.turns += exactProcess.usage.num_turns;
    result = structuredClone(attempt);
  }, (loop) => {
    const checked = leaseCheck(loop, fence, 'accounting');
    if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    const locked = findDualContext(loop, episodeId, attemptId);
    if (locked.attempt.status !== 'claimed' || locked.attempt.session_id !== null
      || locked.attempt.capture_proof !== null || locked.attempt.process_proof !== null
      || locked.attempt.cost_proof !== null || locked.attempt.report_proof !== null) {
      throw new Error('DUAL_REVIEW_PROCESS_ALREADY_SETTLED');
    }
    validateCaptureProof(root, runId, exactCapture, {
      checkerEpisodeId: locked.checker.id,
      attemptId: locked.attempt.attempt_id,
      sourceClaimSha256: locked.attempt.source_claim_sha256,
    });
    validateProcessInput(root, exactProcess, locked.attempt);
    const approval = locked.checker?.review_aggregation?.schema_version === '2.0'
      ? loop.autonomy?.checker_executable_approvals?.[exactProcess.executable.checker]
      : null;
    if (!sameJson(processSecurityIdentity(approval), exactProcess.executable)) {
      throw new Error('DUAL_REVIEW_PROCESS_APPROVAL_MISMATCH');
    }
    const collision = locked.aggregation.attempts.some(attempt => (
      attempt !== locked.attempt && attempt.session_id === exactProcess.session_id
    ));
    if (collision) throw new Error('DUAL_REVIEW_SESSION_COLLISION');
    const prospective = structuredClone(locked.aggregation);
    const prospectiveAttempt = prospective.attempts.find(item => item.attempt_id === attemptId);
    prospectiveAttempt.capture_proof = exactCapture;
    validateDualCaptureSet(prospective);
    const lockedReceipt = receiptWithId(processReceiptPayload(
      root, runId, locked.aggregation, locked.attempt, exactCapture, exactProcess,
    ));
    if (JSON.stringify(lockedReceipt) !== JSON.stringify(receipt)) {
      throw new Error('DUAL_REVIEW_PROCESS_MISMATCH');
    }
  }, {
    publication: {
      kind: 'dual-checker-process',
      operationId: `dual-checker-process-${receipt.receipt_id}`,
      artifacts: [{ rel: receiptRel, bytes: receiptBytes }],
      topology: {
        aggregation_id: initial.aggregation.aggregation_id,
        attempt_id: initial.attempt.attempt_id,
        receipt_id: receipt.receipt_id,
      },
    },
  });
  return {
    ok: true,
    attempt: result,
    receipt,
    receipt_path: receiptPath,
  };
}

const FAILED_PROCESS_KEYS = Object.freeze([
  'provider_id', 'model_id', 'session_id', 'usage', 'stdout_sha256', 'stderr_sha256',
]);

export function settleDualAttemptFailureCost(root, runId, options = {}) {
  if (!exactOptions(options)) throw new Error('DUAL_REVIEW_FAILURE_COST_INPUT_INVALID');
  const { episodeId, attemptId, process, reason, fence, now } = options;
  if (!safeIdentity(episodeId) || !safeIdentity(attemptId) || !safeIdentity(reason)
    || !exactKeys(process, FAILED_PROCESS_KEYS)
    || !safeIdentity(process.provider_id) || !safeIdentity(process.model_id)
    || !safeIdentity(process.session_id) || !isMeasuredOneTurnUsage(process.usage)
    || !SHA256.test(process.stdout_sha256 || '') || !SHA256.test(process.stderr_sha256 || '')) {
    throw new Error('DUAL_REVIEW_FAILURE_COST_INPUT_INVALID');
  }
  const snapshot = captureReconciledRunSnapshot(root, runId).data;
  const initial = findDualContext(snapshot, episodeId, attemptId);
  if (initial.attempt.status !== 'claimed' || initial.attempt.session_id !== null
    || initial.attempt.capture_proof !== null || initial.attempt.process_proof !== null
    || initial.attempt.report_proof !== null || initial.attempt.cost_proof !== null) {
    throw new Error('DUAL_REVIEW_FAILURE_COST_ALREADY_SETTLED');
  }
  const payload = {
    contract: 'deep-loop-dual-checker-failed-process-receipt-v1',
    project_root: canonicalProjectRoot(root),
    run_id: runId,
    aggregation_id: initial.aggregation.aggregation_id,
    attempt_id: initial.attempt.attempt_id,
    reviewer_id: initial.attempt.reviewer_id,
    reviewer_adapter: initial.attempt.reviewer_adapter,
    expected_provider_id: initial.attempt.provider_id,
    expected_model_id: initial.attempt.model_id,
    observed_provider_id: process.provider_id,
    observed_model_id: process.model_id,
    observed_session_id: process.session_id,
    source_claim_sha256: initial.attempt.source_claim_sha256,
    claim_hash: attemptClaimHash(initial.aggregation, initial.attempt),
    failure_reason: reason,
    usage: process.usage,
    stdout_sha256: process.stdout_sha256,
    stderr_sha256: process.stderr_sha256,
  };
  const receipt = receiptWithId(payload);
  const receiptRel = `preflight/process-receipts/${receipt.receipt_id}-dual-checker-failed.json`;
  const receiptPath = `.deep-loop/runs/${runId}/${receiptRel}`;
  const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
  const eventData = {
    turns: process.usage.num_turns,
    tokens: process.usage.tokens,
    reported_turns: process.usage.num_turns,
    reported_tokens: process.usage.tokens,
    input_tokens: process.usage.input_tokens,
    output_tokens: process.usage.output_tokens,
    owner: initial.aggregation.source_binding.lease_owner,
    generation: initial.aggregation.source_binding.lease_generation,
    source: `${initial.attempt.provider_id}-dual-checker-failed-measured`,
    process_receipt_id: receipt.receipt_id,
    dual_checker_aggregation_id: initial.aggregation.aggregation_id,
    dual_checker_attempt_id: initial.attempt.attempt_id,
    provider_id: process.provider_id,
    model_id: process.model_id,
    session_id: process.session_id,
    expected_provider_id: initial.attempt.provider_id,
    expected_model_id: initial.attempt.model_id,
    dual_checker_failure_reason: reason,
  };
  appendAnchored(root, runId, { type: 'cost', data: eventData, now }, (loop, spent) => {
    const locked = findDualContext(loop, episodeId, attemptId);
    locked.attempt.status = 'blocked';
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    const session = (loop.session_chain?.sessions || []).find(item => (
      item.run_id === initial.aggregation.source_binding.lease_owner
    ));
    if (!session) throw new Error('DUAL_REVIEW_ACCOUNTING_ORIGIN_INVALID');
    session.turns += process.usage.num_turns;
  }, (loop) => {
    const checked = leaseCheck(loop, fence, 'accounting');
    if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    const locked = findDualContext(loop, episodeId, attemptId);
    if (locked.attempt.status !== 'claimed' || locked.attempt.session_id !== null
      || locked.attempt.capture_proof !== null || locked.attempt.process_proof !== null
      || locked.attempt.report_proof !== null || locked.attempt.cost_proof !== null
      || attemptClaimHash(locked.aggregation, locked.attempt) !== payload.claim_hash) {
      throw new Error('DUAL_REVIEW_FAILURE_COST_ALREADY_SETTLED');
    }
  }, {
    publication: {
      kind: 'dual-checker-failed-process',
      operationId: `dual-checker-failed-process-${receipt.receipt_id}`,
      artifacts: [{ rel: receiptRel, bytes: receiptBytes }],
      topology: {
        aggregation_id: initial.aggregation.aggregation_id,
        attempt_id: initial.attempt.attempt_id,
        receipt_id: receipt.receipt_id,
      },
    },
  });
  return { ok: true, receipt, receipt_path: receiptPath };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyStoredProcessProof(root, runId, aggregation, attempt, lines, approvals) {
  if (!['claimed', 'imported'].includes(attempt.status)) {
    throw new Error('DUAL_REVIEW_PROCESS_PROOF_MISSING');
  }
  const capture = attempt.capture_proof;
  const process = attempt.process_proof;
  const cost = attempt.cost_proof;
  validateCaptureProof(root, runId, capture, {
    checkerEpisodeId: aggregation.source_binding.checker_episode_id,
    attemptId: attempt.attempt_id,
    sourceClaimSha256: attempt.source_claim_sha256,
  });
  if (!exactKeys(process, [
    'receipt_id', 'receipt', 'provider_id', 'model_id', 'session_id', 'claim_hash',
    'executable', 'launch', 'lifecycle', 'streams',
  ]) || !exactKeys(cost, ['receipt_id', 'event_seq', 'event_checksum', 'usage'])
    || process.receipt_id !== cost.receipt_id
    || process.provider_id !== attempt.provider_id || process.model_id !== attempt.model_id
    || process.session_id !== attempt.session_id || !safeIdentity(process.session_id)
    || !SHA256.test(process.receipt_id || '')
    || !SHA256.test(process.claim_hash || '') || !isMeasuredOneTurnUsage(cost.usage)) {
    throw new Error('DUAL_REVIEW_PROCESS_PROOF_INVALID');
  }
  const receiptPrefix = `.deep-loop/runs/${runId}/preflight/process-receipts/`;
  if (!process.receipt.startsWith(receiptPrefix)) throw new Error('DUAL_REVIEW_PROCESS_PROOF_INVALID');
  const receiptFile = containedRealFile(canonicalProjectRoot(root), process.receipt);
  if (!receiptFile) throw new Error('DUAL_REVIEW_PROCESS_RECEIPT_MISSING');
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptFile, 'utf8')); }
  catch { throw new Error('DUAL_REVIEW_PROCESS_RECEIPT_INVALID'); }
  const processInput = {
    provider_id: process.provider_id,
    model_id: process.model_id,
    session_id: process.session_id,
    executable: process.executable,
    launch: process.launch,
    lifecycle: process.lifecycle,
    streams: process.streams,
    usage: cost.usage,
  };
  validateProcessInput(root, processInput, attempt);
  if (!sameJson(
    processSecurityIdentity(approvals?.[process.executable.checker]),
    process.executable,
  )) throw new Error('DUAL_REVIEW_PROCESS_APPROVAL_MISMATCH');
  const expected = receiptWithId(processReceiptPayload(
    root, runId, aggregation, attempt, capture, processInput,
  ));
  if (!sameJson(receipt, expected) || receipt.receipt_id !== process.receipt_id
    || process.claim_hash !== expected.claim_hash) {
    throw new Error('DUAL_REVIEW_PROCESS_RECEIPT_MISMATCH');
  }
  const costs = lines.filter(event => event.seq === cost.event_seq
    && event.checksum === cost.event_checksum
    && event.type === 'cost'
    && event.data?.process_receipt_id === process.receipt_id
    && event.data?.dual_checker_aggregation_id === aggregation.aggregation_id
    && event.data?.dual_checker_attempt_id === attempt.attempt_id
    && event.data?.provider_id === attempt.provider_id
    && event.data?.model_id === attempt.model_id
    && event.data?.session_id === process.session_id);
  if (costs.length !== 1
    || costs[0].data.reported_turns !== cost.usage.num_turns
    || costs[0].data.reported_tokens !== cost.usage.tokens
    || costs[0].data.input_tokens !== cost.usage.input_tokens
    || costs[0].data.output_tokens !== cost.usage.output_tokens) {
    throw new Error('DUAL_REVIEW_COST_PROOF_MISMATCH');
  }
  return { receipt, receiptFile };
}

function validateDualCaptureSet(aggregation) {
  const captures = aggregation.attempts.map(attempt => attempt.capture_proof);
  if (captures.some(capture => capture === null)) return;
  if (captures[0].source_manifest_sha256 !== captures[1].source_manifest_sha256
    || captures[0].source_skill_sha256 !== captures[1].source_skill_sha256) {
    throw new Error('DUAL_REVIEW_CAPTURE_SOURCE_MISMATCH');
  }
  for (const key of [
    'capture_id', 'record_path', 'record_sha256', 'manifest_path', 'skill_path',
  ]) {
    if (captures[0][key] === captures[1][key]) {
      throw new Error(`DUAL_REVIEW_CAPTURE_COLLISION: ${key}`);
    }
  }
}

function validateDualImportBinding(root, runId, loop, input, lines) {
  const context = findDualContext(loop, input.checker_episode_id, input.attempt_id, {
    allowTerminal: true,
  });
  const { checker, aggregation, attempt, maker, workstream } = context;
  const exact = attemptIdentity(aggregation, attempt);
  for (const key of [
    'aggregation_id', 'reviewer_id', 'reviewer_adapter', 'provider_id', 'model_id',
    'attempt_id', 'source_claim_sha256',
  ]) {
    if (input[key] !== exact[key]) throw new Error(`DUAL_REVIEW_IMPORT_IDENTITY_MISMATCH: ${key}`);
  }
  if (input.session_id !== attempt.session_id
    || input.session_id !== attempt.process_proof?.session_id
    || input.target_maker !== maker.id || input.checker_episode_id !== checker.id) {
    throw new Error('DUAL_REVIEW_IMPORT_IDENTITY_MISMATCH');
  }
  const source = aggregation.source_binding;
  const { source_claim_sha256: persistedDigest, ...sourceWithoutDigest } = source;
  const lease = loop.session_chain?.lease || {};
  if (source.run_id !== loop.run_id || source.checker_episode_id !== checker.id
    || source.target_maker !== maker.id || source.workstream_id !== checker.workstream_id
    || source.point !== checker.point || source.project_root !== canonicalProjectRoot(root)
    || source.runtime !== sessionRuntime(loop) || source.lease_owner !== lease.owner_run_id
    || source.lease_generation !== lease.generation
    || persistedDigest !== contentHash(JSON.stringify(sourceWithoutDigest))) {
    throw new Error('DUAL_REVIEW_SOURCE_CLAIM_MISMATCH');
  }
  const currentArtifacts = deriveReviewArtifactContract(root, maker, workstream);
  if (!sameJson(currentArtifacts, source.artifacts) || !sameJson(input.artifacts, source.artifacts)) {
    throw new Error('DUAL_REVIEW_ARTIFACT_MISMATCH');
  }
  verifyStoredProcessProof(
    root, runId, aggregation, attempt, lines, loop.autonomy?.checker_executable_approvals,
  );
  validateDualCaptureSet(aggregation);
  const sessionIds = aggregation.attempts.map(item => item.session_id).filter(Boolean);
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error('DUAL_REVIEW_SESSION_COLLISION');
  return {
    aggregationId: aggregation.aggregation_id,
    reviewerId: attempt.reviewer_id,
    reviewerAdapter: attempt.reviewer_adapter,
    providerId: attempt.provider_id,
    modelId: attempt.model_id,
    sessionId: attempt.session_id,
    checkerEpisodeId: checker.id,
    targetMaker: maker.id,
    attemptId: attempt.attempt_id,
    sourceClaimSha256: source.source_claim_sha256,
    processReceiptId: attempt.process_proof.receipt_id,
    costEventSeq: attempt.cost_proof.event_seq,
    captureSha256: attempt.capture_proof.record_sha256,
    artifacts: source.artifacts,
  };
}

function verifyImportedAttemptArtifact(root, runId, attempt) {
  if (attempt.status !== 'imported'
    || !exactKeys(attempt.report_proof, ['verdict', 'report', 'report_sha256', 'event_seq', 'event_checksum'])
    || !['APPROVE', 'REQUEST_CHANGES', 'CONCERN'].includes(attempt.report_proof.verdict)
    || !SHA256.test(attempt.report_proof.report_sha256 || '')
    || attempt.report_proof.report !== `.deep-loop/runs/${runId}/reviews/${attempt.report_proof.report_sha256}.json`) {
    throw new Error('DUAL_REVIEW_REPORT_PROOF_INVALID');
  }
  const real = containedRealFile(canonicalProjectRoot(root), attempt.report_proof.report);
  if (!real || sha256File(real) !== attempt.report_proof.report_sha256) {
    throw new Error('DUAL_REVIEW_REPORT_PROOF_MISMATCH');
  }
}

function aggregateBinding(aggregation, checker, attempts) {
  return {
    aggregation_id: aggregation.aggregation_id,
    checker_episode_id: checker.id,
    target_maker: checker.target_maker,
    source_claim_sha256: aggregation.source_binding.source_claim_sha256,
    attempt_ids: attempts.map(attempt => attempt.attempt_id),
    reviewer_ids: attempts.map(attempt => attempt.reviewer_id),
    reviewer_adapters: attempts.map(attempt => attempt.reviewer_adapter),
    provider_ids: attempts.map(attempt => attempt.provider_id),
    model_ids: attempts.map(attempt => attempt.model_id),
    session_ids: attempts.map(attempt => attempt.session_id),
    attempt_reports: attempts.map(attempt => attempt.report_proof.report),
    report_hashes: attempts.map(attempt => attempt.report_proof.report_sha256),
    process_receipts: attempts.map(attempt => attempt.process_proof.receipt),
    process_receipt_ids: attempts.map(attempt => attempt.process_proof.receipt_id),
    cost_event_seqs: attempts.map(attempt => attempt.cost_proof.event_seq),
    capture_ids: attempts.map(attempt => attempt.capture_proof.capture_id),
    capture_records: attempts.map(attempt => attempt.capture_proof.record_path),
    capture_hashes: attempts.map(attempt => attempt.capture_proof.record_sha256),
  };
}

function samePrepared(left, right) {
  return left.report === right.report && left.reportRel === right.reportRel
    && left.reportSha256 === right.reportSha256 && left.bytes.equals(right.bytes);
}

function attemptOutcomeData(context, input, prepared) {
  return {
    episodeId: context.checker.id,
    aggregation_id: context.aggregation.aggregation_id,
    attempt_id: context.attempt.attempt_id,
    reviewer_id: context.attempt.reviewer_id,
    reviewer_adapter: context.attempt.reviewer_adapter,
    provider_id: context.attempt.provider_id,
    model_id: context.attempt.model_id,
    session_id: context.attempt.session_id,
    target_maker: context.maker.id,
    verdict: input.verdict,
    report: prepared.report,
    report_sha256: prepared.reportSha256,
    process_receipt_id: context.attempt.process_proof.receipt_id,
    cost_event_seq: context.attempt.cost_proof.event_seq,
    capture_sha256: context.attempt.capture_proof.record_sha256,
    source_claim_sha256: context.aggregation.source_binding.source_claim_sha256,
  };
}

function aggregateVerdict(attempts) {
  if (attempts.every(attempt => attempt.report_proof.verdict === 'APPROVE')) return 'APPROVE';
  if (attempts.some(attempt => attempt.report_proof.verdict === 'REQUEST_CHANGES')) {
    return 'REQUEST_CHANGES';
  }
  return 'CONCERN';
}

function aggregateOutcomeData(context, aggregate, attempts) {
  return {
    episodeId: context.checker.id,
    verdict: aggregateVerdict(attempts),
    workstream_id: context.checker.workstream_id,
    point: context.checker.point,
    target_maker: context.maker.id,
    reviewer_id: 'dual-checker-aggregate',
    review_source: 'imported-stdin',
    ...aggregate,
  };
}

function recoveredPreparedAttempt(root, runId, input, binding, attempt) {
  verifyImportedAttemptArtifact(root, runId, attempt);
  const real = containedRealFile(canonicalProjectRoot(root), attempt.report_proof.report);
  let persisted;
  try { persisted = JSON.parse(readFileSync(real, 'utf8')); }
  catch { throw new Error('DUAL_REVIEW_REPORT_PROOF_MISMATCH'); }
  const generatedAt = persisted?.envelope?.generated_at;
  const prepared = prepareImportedDualReview(root, runId, input, binding, { now: generatedAt });
  if (prepared.report !== attempt.report_proof.report
    || prepared.reportSha256 !== attempt.report_proof.report_sha256
    || !readFileSync(real).equals(prepared.bytes)) {
    throw new Error('DUAL_REVIEW_REPORT_PROOF_MISMATCH');
  }
  return prepared;
}

function exactEvent(lines, { type, seq, checksum, data }, code) {
  const matches = lines.filter(event => event.seq === seq && event.checksum === checksum);
  if (matches.length !== 1 || matches[0].type !== type
    || !sameJson(matches[0].data, data)) throw new Error(code);
  return matches[0];
}

function recoverImportedDualOutcome(root, runId, snapshot, input, binding, initial) {
  if (initial.attempt.status !== 'imported') return null;
  const prepared = recoveredPreparedAttempt(root, runId, input, binding, initial.attempt);
  exactEvent(snapshot.logLines, {
    type: 'review-attempt-outcome',
    seq: initial.attempt.report_proof.event_seq,
    checksum: initial.attempt.report_proof.event_checksum,
    data: attemptOutcomeData(initial, input, prepared),
  }, 'DUAL_REVIEW_REPORT_PROOF_MISMATCH');

  const imported = initial.aggregation.attempts.filter(attempt => attempt.status === 'imported');
  if (initial.aggregation.aggregate_status === 'in_progress') {
    if (initial.checker.status !== 'in_progress' || imported.length !== 1
      || initial.aggregation.aggregate_proof !== null) {
      throw new Error('DUAL_REVIEW_AGGREGATION_INVALID');
    }
    return {
      ok: true,
      recovered: true,
      status: 'awaiting-second-attempt',
      terminal: null,
      attempt_id: initial.attempt.attempt_id,
      report: prepared.report,
      report_sha256: prepared.reportSha256,
    };
  }

  if (!['approved', 'rejected'].includes(initial.aggregation.aggregate_status)
    || initial.checker.status !== initial.aggregation.aggregate_status
    || imported.length !== 2) throw new Error('DUAL_REVIEW_AGGREGATION_INVALID');
  for (const attempt of imported) {
    verifyImportedAttemptArtifact(root, runId, attempt);
    verifyStoredProcessProof(
      root, runId, initial.aggregation, attempt, snapshot.logLines,
      snapshot.data.autonomy?.checker_executable_approvals,
    );
  }
  const aggregate = aggregateBinding(initial.aggregation, initial.checker, imported);
  const aggregateData = aggregateOutcomeData(initial, aggregate, imported);
  const proof = initial.aggregation.aggregate_proof;
  const event = exactEvent(snapshot.logLines, {
    type: 'review-outcome',
    seq: proof?.final_event_seq,
    checksum: proof?.final_event_checksum,
    data: aggregateData,
  }, 'DUAL_REVIEW_AGGREGATE_PROOF_MISMATCH');
  const evidenceSeqs = imported.flatMap(attempt => [
    attempt.report_proof.event_seq,
    attempt.cost_proof.event_seq,
  ]);
  if (event.seq <= Math.max(...evidenceSeqs)
    || !sameJson(proof?.attempt_ids, aggregate.attempt_ids)
    || !sameJson(proof?.report_hashes, aggregate.report_hashes)
    || !sameJson(proof?.process_receipt_ids, aggregate.process_receipt_ids)
    || !sameJson(proof?.cost_event_seqs, aggregate.cost_event_seqs)
    || !sameJson(proof?.capture_hashes, aggregate.capture_hashes)
    || proof?.source_claim_sha256 !== aggregate.source_claim_sha256) {
    throw new Error('DUAL_REVIEW_AGGREGATE_PROOF_MISMATCH');
  }
  return {
    ok: true,
    recovered: true,
    status: initial.aggregation.aggregate_status,
    terminal: initial.aggregation.aggregate_status,
    aggregate_proof: structuredClone(proof),
  };
}

function publicReviewImportSchema(raw) {
  let scalarError;
  try {
    parseReviewImport(raw);
    return '1.0';
  } catch (error) {
    scalarError = error;
  }
  let dualError;
  try {
    parseDualReviewImport(raw);
    return '2.0';
  } catch (error) {
    dualError = error;
  }
  if (typeof raw !== 'string'
    || String(scalarError?.message || scalarError).startsWith('REVIEW_IMPORT_TOO_LARGE')) {
    throw scalarError;
  }
  let declared;
  try { declared = JSON.parse(raw)?.schema_version; } catch { declared = null; }
  throw declared === '2.0' ? dualError : scalarError;
}

export function importDualReviewOutcome(root, runId, options = {}) {
  if (!exactOptions(options)) throw new Error('DUAL_REVIEW_IMPORT_INPUT_INVALID');
  for (const key of [
    'aggregation_id', 'attempt_id', 'reviewer_id', 'reviewer_adapter', 'provider_id',
    'model_id', 'session_id', 'target_maker', 'source_claim_sha256',
  ]) {
    if (Object.hasOwn(options, key)) throw new Error(`REVIEW_METADATA_FORBIDDEN: import derives ${key}`);
  }
  const { raw, fence, now } = options;
  if (publicReviewImportSchema(raw) === '1.0') {
    return importReviewOutcome(root, runId, { raw, fence, now });
  }
  const input = parseDualReviewImport(raw);
  const snapshot = captureReconciledRunSnapshot(root, runId);
  const binding = validateDualImportBinding(root, runId, snapshot.data, input, snapshot.logLines);
  const initial = findDualContext(snapshot.data, input.checker_episode_id, input.attempt_id, {
    allowTerminal: true,
  });
  const recovered = recoverImportedDualOutcome(root, runId, snapshot, input, binding, initial);
  if (recovered !== null) return recovered;
  const prepared = prepareImportedDualReview(root, runId, input, binding, { now });
  const importedBefore = initial.aggregation.attempts.filter(attempt => attempt.status === 'imported');
  if (importedBefore.length > 1) throw new Error('DUAL_REVIEW_AGGREGATION_INVALID');
  const completes = importedBefore.length === 1;
  const attemptEventData = attemptOutcomeData(initial, input, prepared);

  let aggregate = null;
  let aggregateEventData = null;
  if (completes) {
    const prospective = structuredClone(initial.aggregation.attempts);
    const prospectiveAttempt = prospective.find(attempt => attempt.attempt_id === input.attempt_id);
    prospectiveAttempt.status = 'imported';
    prospectiveAttempt.report_proof = {
      verdict: input.verdict, report: prepared.report, report_sha256: prepared.reportSha256,
      event_seq: 0, event_checksum: '0'.repeat(64),
    };
    aggregate = aggregateBinding(initial.aggregation, initial.checker, prospective);
    for (const key of [
      'attempt_ids', 'reviewer_ids', 'reviewer_adapters', 'provider_ids', 'model_ids',
      'session_ids', 'attempt_reports', 'report_hashes', 'process_receipts',
      'process_receipt_ids', 'cost_event_seqs', 'capture_ids', 'capture_records',
      'capture_hashes',
    ]) {
      if (new Set(aggregate[key]).size !== 2) {
        throw new Error(`DUAL_REVIEW_AGGREGATE_IDENTITY_COLLISION: ${key}`);
      }
    }
    aggregateEventData = aggregateOutcomeData(initial, aggregate, prospective);
  }

  let result;
  appendAnchored(root, runId, {
    type: 'review-attempt-outcome', data: attemptEventData,
    ...(prepared.generatedAt ? { now: prepared.generatedAt } : {}),
  }, (loop, _spent, tx) => {
    const locked = findDualContext(loop, input.checker_episode_id, input.attempt_id);
    locked.attempt.status = 'imported';
    locked.attempt.report_proof = {
      verdict: input.verdict,
      report: prepared.report,
      report_sha256: prepared.reportSha256,
      event_seq: tx.event_identity.seq,
      event_checksum: tx.event_identity.checksum,
    };
    if (!completes) {
      result = {
        ok: true,
        status: 'awaiting-second-attempt',
        terminal: null,
        attempt_id: locked.attempt.attempt_id,
        report: prepared.report,
        report_sha256: prepared.reportSha256,
      };
      return;
    }
    const attempts = locked.aggregation.attempts;
    if (attempts.some(attempt => attempt.status !== 'imported'
      || !['APPROVE', 'REQUEST_CHANGES', 'CONCERN'].includes(attempt.report_proof?.verdict))) {
      throw new Error('DUAL_REVIEW_AGGREGATION_INCOMPLETE');
    }
    const approved = attempts.every(attempt => attempt.report_proof.verdict === 'APPROVE');
    const finalEventSeq = tx.event_identity.seq + 1;
    const finalEventChecksum = contentHash(
      `${finalEventSeq}|${tx.event.ts}|review-outcome|${JSON.stringify(aggregateEventData)}|${tx.event_identity.checksum}`,
    );
    locked.aggregation.aggregate_status = approved ? 'approved' : 'rejected';
    locked.aggregation.aggregate_proof = {
      source_claim_sha256: aggregate.source_claim_sha256,
      attempt_ids: aggregate.attempt_ids,
      report_hashes: aggregate.report_hashes,
      process_receipt_ids: aggregate.process_receipt_ids,
      cost_event_seqs: aggregate.cost_event_seqs,
      capture_hashes: aggregate.capture_hashes,
      final_event_seq: finalEventSeq,
      final_event_checksum: finalEventChecksum,
    };
    locked.checker.status = approved ? 'approved' : 'rejected';
    locked.checker.review_source = 'imported-stdin';
    if (approved && !locked.workstream.review_points_done.includes(locked.checker.point)) {
      locked.workstream.review_points_done.push(locked.checker.point);
    }
    if (approved && !locked.maker.human_reviewed && !locked.maker.agent_reviewed) {
      locked.maker.agent_reviewed = true;
      loop.comprehension.episodes_agent_reviewed += 1;
    }
    if (attempts.some(attempt => attempt.report_proof.verdict === 'REQUEST_CHANGES')) {
      loop.circuit_breaker.consecutive_request_changes += 1;
    } else {
      loop.circuit_breaker.consecutive_request_changes = 0;
    }
    result = {
      ok: true,
      status: approved ? 'approved' : 'rejected',
      terminal: approved ? 'approved' : 'rejected',
      aggregate_proof: structuredClone(locked.aggregation.aggregate_proof),
    };
  }, (loop) => {
    const checked = leaseCheck(loop, fence);
    if (!checked.ok) throw new Error(`LEASE_FENCED: ${checked.reason}`);
    const locked = findDualContext(loop, input.checker_episode_id, input.attempt_id);
    if (locked.attempt.status !== 'claimed' || locked.attempt.process_proof === null
      || locked.attempt.capture_proof === null || locked.attempt.cost_proof === null
      || locked.attempt.report_proof !== null || locked.attempt.session_id === null) {
      throw new Error('DUAL_REVIEW_ATTEMPT_ALREADY_IMPORTED');
    }
    const lockedBinding = validateDualImportBinding(root, runId, loop, input, readLines(root, runId));
    const lockedPrepared = prepareImportedDualReview(root, runId, input, lockedBinding, {
      now: prepared.generatedAt,
    });
    if (!samePrepared(prepared, lockedPrepared)) throw new Error('DUAL_REVIEW_REPORT_MISMATCH');
    const imported = locked.aggregation.attempts.filter(attempt => attempt.status === 'imported');
    if (imported.length !== importedBefore.length) throw new Error('DUAL_REVIEW_IMPORT_RACE');
    if (completes) {
      if (imported.length !== 1) throw new Error('DUAL_REVIEW_AGGREGATION_INCOMPLETE');
      verifyImportedAttemptArtifact(root, runId, imported[0]);
      verifyStoredProcessProof(
        root, runId, locked.aggregation, imported[0], readLines(root, runId),
        loop.autonomy?.checker_executable_approvals,
      );
      const prospective = structuredClone(locked.aggregation.attempts);
      const prospectiveAttempt = prospective.find(attempt => attempt.attempt_id === input.attempt_id);
      prospectiveAttempt.status = 'imported';
      prospectiveAttempt.report_proof = {
        verdict: input.verdict, report: prepared.report, report_sha256: prepared.reportSha256,
        event_seq: 0, event_checksum: '0'.repeat(64),
      };
      const lockedAggregate = aggregateBinding(locked.aggregation, locked.checker, prospective);
      if (!sameJson(aggregate, lockedAggregate)) {
        throw new Error('DUAL_REVIEW_AGGREGATE_MISMATCH');
      }
    }
  }, {
    publication: {
      kind: completes ? 'dual-review-aggregate' : 'dual-review-attempt',
      operationId: completes
        ? `dual-review-aggregate-${contentHash(JSON.stringify(aggregateEventData))}`
        : `dual-review-attempt-${prepared.reportSha256}`,
      artifacts: [{ rel: prepared.reportRel, bytes: prepared.bytes }],
      topology: {
        aggregation_id: initial.aggregation.aggregation_id,
        attempt_id: initial.attempt.attempt_id,
        report_sha256: prepared.reportSha256,
        aggregate_event_sha256: completes ? contentHash(JSON.stringify(aggregateEventData)) : null,
      },
    },
    ...(completes ? {
      additionalEvents: [{ type: 'review-outcome', data: aggregateEventData }],
    } : {}),
  });
  return result;
}

if (process.argv[1] === dualWorkerPath && process.argv[2] === '--dual-process-worker') {
  await runDualWorkerMain();
}
