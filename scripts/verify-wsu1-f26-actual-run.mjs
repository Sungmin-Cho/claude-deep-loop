#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { flushDirectory } from './lib/atomic-write.mjs';
import { verifyDualCaptureProof } from './lib/dual-checker.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAGS = Object.freeze([
  '--project-root', '--run-id', '--worktree', '--point',
  '--import-input-a', '--import-input-b',
  '--host-observation', '--receipt',
]);
const INPUT_KEYS = Object.freeze([
  'schema_version', 'aggregation_id', 'reviewer_id', 'reviewer_adapter',
  'provider_id', 'model_id', 'session_id', 'checker_episode_id', 'target_maker',
  'attempt_id', 'source_claim_sha256', 'verdict', 'report_body', 'artifacts',
]);
const HOST_OBSERVATION_KEYS = Object.freeze([
  'schema_version', 'observer_role', 'observer_session_id', 'observed_at', 'project_root', 'worktree',
  'run_id', 'workstream_id', 'point', 'maker_episode_id', 'checker_episode_id',
  'cwd', 'argv', 'env', 'started_at', 'finished_at', 'exit_code',
  'stdout', 'stderr', 'checker_terminal_status',
]);
const CAPTURE_KEYS = Object.freeze([
  'capture_id', 'run_id', 'checker_episode_id', 'attempt_id', 'source_claim_sha256',
  'record_path', 'record_sha256', 'manifest_path',
  'source_manifest_sha256', 'skill_path', 'source_skill_sha256',
]);
const PROCESS_PROOF_KEYS = Object.freeze([
  'receipt_id', 'receipt', 'provider_id', 'model_id', 'session_id', 'claim_hash',
  'stdout_sha256', 'stderr_sha256',
]);
const COST_PROOF_KEYS = Object.freeze([
  'receipt_id', 'event_seq', 'event_checksum', 'usage',
]);
const REPORT_PROOF_KEYS = Object.freeze([
  'verdict', 'report', 'report_sha256', 'event_seq', 'event_checksum',
]);
const RECEIPT_SCOPE = 'X_E_RESIDUAL_REASON_SEMANTICS+L_CONDITIONAL_DOMINANCE';
const byteSort = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => value != null && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort(byteSort)) === JSON.stringify([...keys].sort(byteSort));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function fail(code, detail = '') {
  throw Object.assign(new Error(detail || code), { diagnostic: code, detail });
}

function parseArgs(argv) {
  if (argv.length !== FLAGS.length * 2) fail('WSU1_F26_ARGUMENTS');
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.includes(flag) || Object.hasOwn(result, flag) || typeof value !== 'string' || value.length === 0) {
      fail('WSU1_F26_ARGUMENTS');
    }
    result[flag] = value;
  }
  if (!FLAGS.every((flag) => Object.hasOwn(result, flag))) fail('WSU1_F26_ARGUMENTS');
  return result;
}

function regularBytes(path, missingDiagnostic, nonRegularDiagnostic = missingDiagnostic) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(missingDiagnostic); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(nonRegularDiagnostic);
  return readFileSync(path);
}

function regularJson(path, missingDiagnostic, nonRegularDiagnostic = missingDiagnostic, parseDiagnostic = missingDiagnostic) {
  const bytes = regularBytes(path, missingDiagnostic, nonRegularDiagnostic);
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; }
  catch { fail(parseDiagnostic); }
}

function readRunEvidence(runDirectory) {
  const loopPath = join(runDirectory, 'loop.json');
  const loopHashPath = join(runDirectory, '.loop.hash');
  const eventPath = join(runDirectory, 'event-log.jsonl');
  const { bytes: loopBytes, value: loop } = regularJson(loopPath, 'WSU1_F26_SYNTHETIC_RUN');
  const loopHashBytes = regularBytes(loopHashPath, 'WSU1_F26_RUN_INTEGRITY');
  const loopHash = loopHashBytes.toString('utf8');
  if (!SHA256.test(loopHash) || loopHash !== sha256(loopBytes)) fail('WSU1_F26_RUN_INTEGRITY');
  const eventBytes = regularBytes(eventPath, 'WSU1_F26_EVENT_LOG');
  return {
    loop, loopPath, loopBytes, loopHashPath, loopHashBytes, eventPath, eventBytes,
  };
}

function verifyRunEvidenceUnchanged(evidence) {
  for (const [path, expected] of [
    [evidence.loopPath, evidence.loopBytes],
    [evidence.loopHashPath, evidence.loopHashBytes],
    [evidence.eventPath, evidence.eventBytes],
  ]) {
    const observed = regularBytes(path, 'WSU1_F26_RUN_INTEGRITY');
    if (!observed.equals(expected)) fail('WSU1_F26_RUN_INTEGRITY');
  }
}

function canonicalDirectory(path, diagnostic) {
  let stat;
  try { stat = lstatSync(path); } catch { fail(diagnostic); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(diagnostic);
  try { return realpathSync(path); } catch { fail(diagnostic); }
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

function stableIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev), ino: String(stat.ino), birthtime_ns: String(stat.birthtimeNs),
  });
}

function matchingIdentity(left, right) {
  if (!left || !right || left.ino === '0' || right.ino === '0' || left.ino !== right.ino) return false;
  if (left.dev !== '0' && right.dev !== '0') return left.dev === right.dev;
  return left.birthtime_ns !== '0' && right.birthtime_ns !== '0'
    && left.birthtime_ns === right.birthtime_ns;
}

function regularFileIdentity(stat) {
  if (stat.isSymbolicLink() || !stat.isFile()) fail('WSU1_F26_WORKTREE_K');
  return Object.freeze({
    ...stableIdentity(stat),
    mode: String(stat.mode),
    size: String(stat.size),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
  });
}

function matchingRegularFileIdentity(left, right) {
  return matchingIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtime_ns === right.mtime_ns
    && left.ctime_ns === right.ctime_ns;
}

function inspectReceiptParent(parent) {
  let before;
  try { before = lstatSync(parent, { bigint: true }); } catch { fail('WSU1_F26_WORKTREE_K'); }
  if (before.isSymbolicLink() || !before.isDirectory()) fail('WSU1_F26_WORKTREE_K');
  let canonical;
  try { canonical = (realpathSync.native || realpathSync)(parent); } catch { fail('WSU1_F26_WORKTREE_K'); }
  let after;
  try { after = lstatSync(canonical, { bigint: true }); } catch { fail('WSU1_F26_WORKTREE_K'); }
  if (resolve(canonical) !== resolve(parent) || after.isSymbolicLink() || !after.isDirectory()
    || !matchingIdentity(stableIdentity(before), stableIdentity(after))) fail('WSU1_F26_WORKTREE_K');
  return { canonical, identity: stableIdentity(after) };
}

function verifyReceiptParent(binding) {
  const observed = inspectReceiptParent(binding.parent);
  if (observed.canonical !== binding.canonical_parent
    || !matchingIdentity(observed.identity, binding.parent_identity)) fail('WSU1_F26_WORKTREE_K');
}

function canonicalProspectivePath(path, diagnostic) {
  const suffix = [];
  let cursor = resolve(path);
  for (;;) {
    try {
      lstatSync(cursor);
      return resolve(realpathSync(cursor), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') fail(diagnostic);
      const parent = dirname(cursor);
      if (parent === cursor) fail(diagnostic);
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

function safeReceiptTarget(value, worktree) {
  const lexical = resolve(value);
  const canonical = canonicalProspectivePath(lexical, 'WSU1_F26_WORKTREE_K');
  const scripts = canonicalDirectory(join(worktree, 'scripts'), 'WSU1_F26_WORKTREE_K');
  if (within(resolve(worktree, 'scripts'), lexical) || within(scripts, canonical)) {
    fail('WSU1_F26_WORKTREE_K');
  }
  for (const name of [
    'activation-pending-classification.seed.md',
    'activation-pending-classification.md',
    'activation-pending-classification-evidence.json',
  ]) {
    const fixture = join(worktree, 'tests', 'fixtures', name);
    if (lexical === resolve(fixture)
      || canonical === canonicalProspectivePath(fixture, 'WSU1_F26_WORKTREE_K')) {
      fail('WSU1_F26_WORKTREE_K');
    }
  }
  const parent = dirname(lexical);
  try { mkdirSync(parent, { recursive: true }); } catch { fail('WSU1_F26_WORKTREE_K'); }
  const inspected = inspectReceiptParent(parent);
  return Object.freeze({
    path: lexical,
    parent,
    canonical_parent: inspected.canonical,
    parent_identity: inspected.identity,
  });
}

function portableRelative(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || path.includes('\\')) return null;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function canonicalArtifacts(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (!exactKeys(item, ['path', 'sha256']) || !portableRelative(item.path)
      || !SHA256.test(item.sha256 || '') || seen.has(item.path)) return null;
    seen.add(item.path);
    result.push({ path: item.path, sha256: item.sha256 });
  }
  return result.sort((left, right) => byteSort(left.path, right.path));
}

function sourceArtifacts(worktree) {
  const files = [];
  const scripts = join(worktree, 'scripts');
  canonicalDirectory(scripts, 'WSU1_F26_WORKTREE_K');
  const directories = [scripts];
  while (directories.length > 0) {
    const parent = directories.pop();
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const path = join(parent, entry.name);
      let stat;
      try { stat = lstatSync(path); } catch { fail('WSU1_F26_WORKTREE_K'); }
      if (stat.isSymbolicLink()) fail('WSU1_F26_WORKTREE_K');
      if (stat.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!stat.isFile()) fail('WSU1_F26_WORKTREE_K');
      files.push(path);
    }
  }
  for (const name of [
    'activation-pending-classification.seed.md',
    'activation-pending-classification.md',
    'activation-pending-classification-evidence.json',
  ]) files.push(join(worktree, 'tests', 'fixtures', name));
  const rows = [];
  for (const path of files.sort(byteSort)) {
    const bytes = regularBytes(path, 'WSU1_F26_WORKTREE_K');
    const rel = relative(worktree, path).split(sep).join('/');
    if (!portableRelative(rel)) fail('WSU1_F26_WORKTREE_K');
    rows.push({ path: rel, sha256: sha256(bytes), bytes });
  }
  return rows.sort((left, right) => byteSort(left.path, right.path));
}

function sourceContract(rows) {
  return rows.map(({ path, sha256: digest }) => ({ path, sha256: digest }));
}

function verifySourceArtifactsUnchanged(worktree, expectedContract) {
  if (!same(sourceContract(sourceArtifacts(worktree)), expectedContract)) fail('WSU1_F26_WORKTREE_K');
}

function reviewedSourceHash(rows) {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(Buffer.from(row.path));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(row.bytes.length)));
    hash.update(Buffer.from([0]));
    hash.update(row.bytes);
  }
  return hash.digest('hex');
}

function eventLines(bytes) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0x0a) fail('WSU1_F26_EVENT_LOG');
  try { return bytes.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line)); }
  catch { fail('WSU1_F26_EVENT_LOG'); }
}

function checksumFor(seq, ts, type, data, prev) {
  return sha256(Buffer.from(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`));
}

function validateEventLog(lines, head) {
  let prev = 'GENESIS';
  for (let index = 0; index < lines.length; index += 1) {
    const event = lines[index];
    if (!exactKeys(event, ['seq', 'ts', 'type', 'data', 'checksum']) || event.seq !== index + 1
      || typeof event.ts !== 'string' || typeof event.type !== 'string'
      || event.data == null || typeof event.data !== 'object' || Array.isArray(event.data)
      || event.checksum !== checksumFor(event.seq, event.ts, event.type, event.data, prev)) {
      fail('WSU1_F26_EVENT_LOG');
    }
    prev = event.checksum;
  }
  const expected = lines.length ? { seq: lines.at(-1).seq, checksum: lines.at(-1).checksum }
    : { seq: 0, checksum: 'GENESIS' };
  if (!same(head, expected)) fail('WSU1_F26_EVENT_LOG');
}

function safeIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\0\r\n]/.test(value);
}

function measuredUsage(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && value.num_turns === 1
    && ['input_tokens', 'output_tokens', 'tokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && value.tokens === value.input_tokens + value.output_tokens
    && ['cached_input_tokens', 'reasoning_output_tokens'].every(key => (
      !Object.hasOwn(value, key) || (Number.isSafeInteger(value[key]) && value[key] >= 0)
    ));
}

function validateInput(input) {
  if (!exactKeys(input, INPUT_KEYS) || input.schema_version !== '2.0'
    || !['aggregation_id', 'reviewer_id', 'reviewer_adapter', 'provider_id', 'model_id', 'session_id',
      'checker_episode_id', 'target_maker'].every(key => safeIdentity(input[key]))
    || !RUN_ID.test(input.attempt_id || '') || !SHA256.test(input.source_claim_sha256 || '')
    || input.verdict !== 'APPROVE' || typeof input.report_body !== 'string'
    || !canonicalArtifacts(input.artifacts)?.length) fail('WSU1_F26_DUAL_INPUT_COUNT');
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

function validateCapture(projectRoot, runId, capture, attempt, aggregation) {
  if (!exactKeys(capture, CAPTURE_KEYS)) fail('WSU1_F26_DUAL_PROCESS_PROOF');
  try {
    verifyDualCaptureProof(projectRoot, runId, capture, {
      checkerEpisodeId: aggregation.source_binding.checker_episode_id,
      attemptId: attempt.attempt_id,
      sourceClaimSha256: attempt.source_claim_sha256,
    });
  } catch {
    fail('WSU1_F26_DUAL_PROCESS_PROOF');
  }
}

function validateProcessProof(projectRoot, runId, aggregation, attempt) {
  const process = attempt.process_proof;
  const cost = attempt.cost_proof;
  validateCapture(projectRoot, runId, attempt.capture_proof, attempt, aggregation);
  if (!exactKeys(process, PROCESS_PROOF_KEYS) || !exactKeys(cost, COST_PROOF_KEYS)
    || !measuredUsage(cost.usage) || process.receipt_id !== cost.receipt_id
    || process.provider_id !== attempt.provider_id || process.model_id !== attempt.model_id
    || process.session_id !== attempt.session_id || !safeIdentity(process.session_id)
    || ![process.receipt_id, process.claim_hash, process.stdout_sha256, process.stderr_sha256]
      .every(value => SHA256.test(value || ''))) fail('WSU1_F26_DUAL_PROCESS_PROOF');
  const receiptPath = `.deep-loop/runs/${runId}/preflight/process-receipts/${process.receipt_id}-dual-checker.json`;
  if (process.receipt !== receiptPath) fail('WSU1_F26_DUAL_PROCESS_PROOF');
  const { bytes, value: receipt } = regularJson(
    resolve(projectRoot, ...receiptPath.split('/')), 'WSU1_F26_DUAL_PROCESS_PROOF',
  );
  const payload = {
    contract: 'deep-loop-dual-checker-process-receipt-v1',
    project_root: projectRoot,
    run_id: runId,
    ...attemptIdentity(aggregation, attempt),
    session_id: attempt.session_id,
    claim_hash: sha256(Buffer.from(JSON.stringify(attemptIdentity(aggregation, attempt)))),
    capture: attempt.capture_proof,
    stdout_sha256: process.stdout_sha256,
    stderr_sha256: process.stderr_sha256,
    usage: cost.usage,
  };
  const expected = { ...payload, receipt_id: sha256(Buffer.from(JSON.stringify(payload))) };
  if (!same(receipt, expected) || !bytes.equals(Buffer.from(JSON.stringify(expected, null, 2)))
    || process.receipt_id !== expected.receipt_id || process.claim_hash !== expected.claim_hash) {
    fail('WSU1_F26_DUAL_PROCESS_PROOF');
  }
  return {
    receipt,
    path: receiptPath,
    sha256: sha256(bytes),
  };
}

function validateReport(projectRoot, runId, aggregation, attempt, input) {
  const proof = attempt.report_proof;
  if (!exactKeys(proof, REPORT_PROOF_KEYS) || proof.verdict !== 'APPROVE'
    || !SHA256.test(proof.report_sha256 || '')
    || proof.report !== `.deep-loop/runs/${runId}/reviews/${proof.report_sha256}.json`) {
    fail('WSU1_F26_DUAL_REPORT_PROOF');
  }
  const { bytes, value: report } = regularJson(
    resolve(projectRoot, ...proof.report.split('/')), 'WSU1_F26_DUAL_REPORT_PROOF',
  );
  if (sha256(bytes) !== proof.report_sha256 || report?.schema_version !== '1.0'
    || report.envelope?.producer !== 'deep-loop'
    || report.envelope?.artifact_kind !== 'review-attempt-report'
    || report.envelope?.schema?.name !== 'review-attempt-report'
    || report.envelope?.schema?.version !== '2.0' || report.envelope?.run_id !== runId
    || !same(report.envelope?.provenance?.source_artifacts, input.artifacts.map(({ path }) => path))
    || !same(report.payload, { verdict: 'APPROVE', report_body: input.report_body })) {
    fail('WSU1_F26_DUAL_REPORT_PROOF');
  }
  const expectedBinding = {
    aggregation_id: aggregation.aggregation_id,
    reviewer_id: attempt.reviewer_id,
    reviewer_adapter: attempt.reviewer_adapter,
    provider_id: attempt.provider_id,
    model_id: attempt.model_id,
    session_id: attempt.session_id,
    checker_episode_id: input.checker_episode_id,
    target_maker: input.target_maker,
    attempt_id: attempt.attempt_id,
    source_claim_sha256: attempt.source_claim_sha256,
    process_receipt_id: attempt.process_proof.receipt_id,
    cost_event_seq: attempt.cost_proof.event_seq,
    capture_sha256: attempt.capture_proof.record_sha256,
    artifacts: input.artifacts,
  };
  if (!same(report.envelope?.provenance?.review_binding, expectedBinding)) {
    fail('WSU1_F26_DUAL_REPORT_PROOF');
  }
  return { report, bytes };
}

function validateHostObservation(observation, context) {
  const observedAt = Date.parse(observation?.observed_at);
  const startedAt = Date.parse(observation?.started_at);
  const finishedAt = Date.parse(observation?.finished_at);
  if (!exactKeys(observation, HOST_OBSERVATION_KEYS) || observation.schema_version !== 1
    || observation.observer_role !== 'orchestrator'
    || !safeIdentity(observation.observer_session_id)
    || !Number.isFinite(observedAt) || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)
    || startedAt > finishedAt || finishedAt > observedAt) fail('WSU1_F26_DUAL_OBSERVATION');
  if (observation.project_root !== context.projectRoot || observation.worktree !== context.worktreePrefix
    || observation.run_id !== context.runId || observation.workstream_id !== context.workstream.id
    || observation.point !== context.point || observation.maker_episode_id !== context.maker.id
    || observation.checker_episode_id !== context.checker.id) {
    fail('WSU1_F26_DUAL_OBSERVATION');
  }
  const expectedArgv = [
    process.execPath,
    join(context.worktree, 'scripts', 'hooks-impl', 'drive-headless.mjs'),
    '--project-root',
    context.projectRoot,
    '--run-id',
    context.runId,
  ];
  if (observation.cwd !== context.projectRoot || !same(observation.argv, expectedArgv)
    || !same(observation.env, { DEEP_LOOP_UNATTENDED: '1' })) fail('WSU1_F26_DUAL_OBSERVATION');
  let result;
  try { result = JSON.parse(observation.stdout.trim()); } catch { fail('WSU1_F26_DUAL_OBSERVATION'); }
  if (observation.exit_code !== 0 || observation.stderr !== '' || observation.checker_terminal_status !== 'approved'
    || result?.ok !== true || result.action !== 'checker-complete'
    || result.checkerEpisodeId !== context.checker.id
    || result.attemptId !== context.aggregation.attempts[1].attempt_id) fail('WSU1_F26_DUAL_OBSERVATION');
}

function unlinkExact(path, identity) {
  if (!identity) return;
  try {
    const observed = stableIdentity(lstatSync(path, { bigint: true }));
    if (matchingIdentity(observed, identity)) unlinkSync(path);
  } catch { /* cleanup is best-effort and never follows a replacement */ }
}

function atomicallyCreate(binding, bytes) {
  const { path, parent } = binding;
  verifyReceiptParent(binding); // RECEIPT_BOUNDARY_PRE_OPEN
  if (existsSync(path)) fail('WSU1_F26_RECEIPT_EXISTS');
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const fd = openSync(temporary, 'wx', 0o600);
  let temporaryIdentity;
  let installedIdentity;
  try {
    temporaryIdentity = stableIdentity(fstatSync(fd, { bigint: true }));
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    verifyReceiptParent(binding); // RECEIPT_BOUNDARY_PRE_LINK
    linkSync(temporary, path);
    const observedIdentity = stableIdentity(lstatSync(path, { bigint: true }));
    if (!matchingIdentity(temporaryIdentity, observedIdentity)) fail('WSU1_F26_WORKTREE_K');
    installedIdentity = observedIdentity;
    verifyReceiptParent(binding); // RECEIPT_BOUNDARY_POST_LINK
    flushDirectory(parent);
    unlinkExact(temporary, temporaryIdentity);
    flushDirectory(parent);
    return installedIdentity;
  } catch (error) {
    unlinkExact(path, installedIdentity);
    unlinkExact(temporary, temporaryIdentity);
    if (error?.diagnostic) throw error;
    fail(error?.code === 'EEXIST' ? 'WSU1_F26_RECEIPT_EXISTS' : 'WSU1_F26_WORKTREE_K');
  }
}

function verifyPublishedReceipt(binding, installedIdentity, expectedBytes) {
  const { path } = binding;
  verifyReceiptParent(binding);
  let before;
  try { before = regularFileIdentity(lstatSync(path, { bigint: true })); }
  catch (error) {
    if (error?.diagnostic) throw error;
    fail('WSU1_F26_WORKTREE_K');
  }
  if (!matchingIdentity(before, installedIdentity)) fail('WSU1_F26_WORKTREE_K');

  let fd;
  let failure;
  let afterRead;
  try {
    // RECEIPT_VERIFICATION_PRE_OPEN
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = regularFileIdentity(fstatSync(fd, { bigint: true }));
    if (!matchingRegularFileIdentity(before, opened)) fail('WSU1_F26_WORKTREE_K');
    const observedBytes = readFileSync(fd);
    // RECEIPT_VERIFICATION_POST_READ
    afterRead = regularFileIdentity(fstatSync(fd, { bigint: true }));
    if (!matchingRegularFileIdentity(opened, afterRead) || !observedBytes.equals(expectedBytes)) {
      fail('WSU1_F26_WORKTREE_K');
    }
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (error) { failure ||= error; }
    }
  }
  if (failure) {
    if (failure?.diagnostic) throw failure;
    fail('WSU1_F26_WORKTREE_K');
  }

  // RECEIPT_VERIFICATION_PRE_FINAL_PATH
  let finalPath;
  try { finalPath = regularFileIdentity(lstatSync(path, { bigint: true })); }
  catch (error) {
    if (error?.diagnostic) throw error;
    fail('WSU1_F26_WORKTREE_K');
  }
  if (!matchingRegularFileIdentity(afterRead, finalPath)) fail('WSU1_F26_WORKTREE_K');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = canonicalDirectory(resolve(args['--project-root']), 'WSU1_F26_SYNTHETIC_RUN');
  if (!RUN_ID.test(args['--run-id'])) fail('WSU1_F26_SYNTHETIC_RUN');
  const worktreePrefix = portableRelative(args['--worktree']);
  if (!worktreePrefix) fail('WSU1_F26_WORKTREE_K');
  const worktree = canonicalDirectory(resolve(projectRoot, ...worktreePrefix.split('/')), 'WSU1_F26_WORKTREE_K');
  if (!within(projectRoot, worktree) || relative(projectRoot, worktree).split(sep).join('/') !== worktreePrefix) {
    fail('WSU1_F26_WORKTREE_K');
  }
  const receiptBinding = safeReceiptTarget(args['--receipt'], worktree);
  const runId = args['--run-id'];
  const point = args['--point'];
  if (point !== 'wsu1-f26-independent-review') fail('WSU1_F26_CLAIM_CONTEXT');
  const runDirectory = canonicalDirectory(join(projectRoot, '.deep-loop', 'runs', runId), 'WSU1_F26_SYNTHETIC_RUN');
  if (!within(projectRoot, runDirectory)) fail('WSU1_F26_SYNTHETIC_RUN');
  const runEvidence = readRunEvidence(runDirectory);
  const { loop } = runEvidence;
  if (loop?.run_id !== runId) fail('WSU1_F26_SYNTHETIC_RUN');
  let loopRoot;
  try { loopRoot = realpathSync(resolve(loop?.project?.root)); } catch { fail('WSU1_F26_SYNTHETIC_RUN'); }
  if (loopRoot !== projectRoot) fail('WSU1_F26_SYNTHETIC_RUN');
  if (loop.autonomy?.session_runtime !== 'codex' || loop.autonomy?.runtime_source !== 'skill-asserted') {
    fail('WSU1_F26_NON_CODEX');
  }
  if (loop.session_chain?.lease?.resume_policy === 'human') fail('WSU1_F26_HUMAN_POLICY');

  const inputPaths = [resolve(args['--import-input-a']), resolve(args['--import-input-b'])];
  const hostObservationPath = resolve(args['--host-observation']);
  if (new Set(inputPaths).size !== 2) {
    fail('WSU1_F26_DUAL_INPUT_COUNT');
  }
  const inputs = inputPaths.map(path => regularJson(path, 'WSU1_F26_DUAL_INPUT_COUNT').value);
  inputs.forEach(validateInput);
  const [firstInput] = inputs;
  const workstream = loop.workstreams?.find((item) => item?.worktree === worktreePrefix);
  const maker = loop.episodes?.find((item) => item?.id === firstInput.target_maker);
  const checker = loop.episodes?.find((item) => item?.id === firstInput.checker_episode_id);
  const aggregation = checker?.review_aggregation;
  if (loop.schema_version !== '0.5.0' || !workstream || maker?.role !== 'maker'
    || maker.status !== 'done' || maker.point !== point || maker.workstream_id !== workstream.id
    || checker?.role !== 'checker' || !['deep-review', 'subagent-checker'].includes(checker.plugin)
    || checker.status !== 'approved' || checker.review_source !== 'imported-stdin'
    || checker.point !== point || checker.workstream_id !== workstream.id
    || checker.target_maker !== maker.id || Object.hasOwn(checker, 'review_claim')
    || Object.hasOwn(checker, 'attempt_id')
    || !exactKeys(aggregation, [
      'schema_version', 'policy', 'aggregation_id', 'required_attempt_count', 'aggregate_status',
      'source_binding', 'attempts', 'aggregate_proof',
    ]) || aggregation.schema_version !== '2.0' || aggregation.policy !== 'ALL_LITERAL_APPROVE_2'
    || aggregation.required_attempt_count !== 2 || aggregation.aggregate_status !== 'approved'
    || !safeIdentity(aggregation.aggregation_id) || !Array.isArray(aggregation.attempts)
    || aggregation.attempts.length !== 2) fail('WSU1_F26_DUAL_INPUT_COUNT');

  const attemptKeys = [
    'slot', 'attempt_id', 'reviewer_id', 'reviewer_adapter', 'provider_id', 'model_id',
    'session_id', 'status', 'source_claim_sha256', 'capture_proof', 'process_proof',
    'report_proof', 'cost_proof',
  ];
  for (let index = 0; index < 2; index += 1) {
    const attempt = aggregation.attempts[index];
    const input = inputs[index];
    if (!exactKeys(attempt, attemptKeys) || attempt.slot !== index || attempt.status !== 'imported'
      || input.aggregation_id !== aggregation.aggregation_id
      || input.checker_episode_id !== checker.id || input.target_maker !== maker.id
      || !['attempt_id', 'reviewer_id', 'reviewer_adapter', 'provider_id', 'model_id', 'session_id',
        'source_claim_sha256'].every(key => input[key] === attempt[key])) {
      fail('WSU1_F26_DUAL_INPUT_COUNT');
    }
  }
  for (const key of [
    'attempt_id', 'reviewer_id', 'reviewer_adapter', 'provider_id', 'model_id', 'session_id',
  ]) {
    if (new Set(aggregation.attempts.map(attempt => attempt[key])).size !== 2) {
      fail('WSU1_F26_DUAL_IDENTITY_COLLISION');
    }
  }

  const sources = sourceArtifacts(worktree);
  const relativeContract = sourceContract(sources);
  const kernelContract = relativeContract.map(({ path, sha256: digest }) => ({
    path: `${worktreePrefix}/${path}`, sha256: digest,
  })).sort((left, right) => byteSort(left.path, right.path));
  const source = aggregation.source_binding;
  const sourceKeys = [
    'run_id', 'checker_episode_id', 'target_maker', 'workstream_id', 'point', 'project_root',
    'runtime', 'lease_owner', 'lease_generation', 'artifacts', 'source_claim_sha256',
  ];
  const { source_claim_sha256: sourceClaimSha256, ...sourceWithoutDigest } = source || {};
  if (!exactKeys(source, sourceKeys) || source.run_id !== runId || source.checker_episode_id !== checker.id
    || source.target_maker !== maker.id || source.workstream_id !== workstream.id || source.point !== point
    || source.project_root !== projectRoot || source.runtime !== 'codex'
    || source.lease_owner !== loop.session_chain.lease.owner_run_id
    || source.lease_generation !== loop.session_chain.lease.generation
    || !SHA256.test(sourceClaimSha256 || '')
    || sourceClaimSha256 !== sha256(Buffer.from(JSON.stringify(sourceWithoutDigest)))
    || !same(canonicalArtifacts(source.artifacts), kernelContract)
    || inputs.some(input => !same(canonicalArtifacts(input.artifacts), kernelContract)
      || input.source_claim_sha256 !== sourceClaimSha256)
    || aggregation.attempts.some(attempt => attempt.source_claim_sha256 !== sourceClaimSha256)
    || !same([...(maker.artifacts || [])].sort(byteSort), kernelContract.map(({ path }) => path))) {
    fail('WSU1_F26_DUAL_SOURCE_MISMATCH');
  }
  const { eventBytes } = runEvidence;
  const events = eventLines(eventBytes);
  validateEventLog(events, loop.event_log_head);
  const reports = [];
  const receipts = [];
  const attemptEvents = [];
  const costs = [];
  for (let index = 0; index < 2; index += 1) {
    const attempt = aggregation.attempts[index];
    const input = inputs[index];
    receipts.push(validateProcessProof(projectRoot, runId, aggregation, attempt));
    reports.push(validateReport(projectRoot, runId, aggregation, attempt, input));
    const cost = events.filter(event => event.type === 'cost'
      && event.seq === attempt.cost_proof.event_seq
      && event.checksum === attempt.cost_proof.event_checksum
      && event.data?.process_receipt_id === attempt.process_proof.receipt_id);
    const expectedCost = {
      turns: attempt.cost_proof.usage.num_turns,
      tokens: attempt.cost_proof.usage.tokens,
      reported_turns: attempt.cost_proof.usage.num_turns,
      reported_tokens: attempt.cost_proof.usage.tokens,
      input_tokens: attempt.cost_proof.usage.input_tokens,
      output_tokens: attempt.cost_proof.usage.output_tokens,
      owner: source.lease_owner,
      generation: source.lease_generation,
      source: `${attempt.provider_id}-dual-checker-measured`,
      process_receipt_id: attempt.process_proof.receipt_id,
      dual_checker_aggregation_id: aggregation.aggregation_id,
      dual_checker_attempt_id: attempt.attempt_id,
      provider_id: attempt.provider_id,
      model_id: attempt.model_id,
      session_id: attempt.session_id,
    };
    if (cost.length !== 1 || !same(cost[0].data, expectedCost)) fail('WSU1_F26_DUAL_COST_PROOF');
    costs.push(cost[0]);
    const expectedAttemptOutcome = {
      episodeId: checker.id,
      aggregation_id: aggregation.aggregation_id,
      attempt_id: attempt.attempt_id,
      reviewer_id: attempt.reviewer_id,
      reviewer_adapter: attempt.reviewer_adapter,
      provider_id: attempt.provider_id,
      model_id: attempt.model_id,
      session_id: attempt.session_id,
      target_maker: maker.id,
      verdict: 'APPROVE',
      report: attempt.report_proof.report,
      report_sha256: attempt.report_proof.report_sha256,
      process_receipt_id: attempt.process_proof.receipt_id,
      cost_event_seq: attempt.cost_proof.event_seq,
      capture_sha256: attempt.capture_proof.record_sha256,
      source_claim_sha256: sourceClaimSha256,
    };
    const outcomes = events.filter(event => event.type === 'review-attempt-outcome'
      && event.seq === attempt.report_proof.event_seq
      && event.checksum === attempt.report_proof.event_checksum);
    if (outcomes.length !== 1 || !same(outcomes[0].data, expectedAttemptOutcome)) {
      fail('WSU1_F26_DUAL_REPORT_PROOF');
    }
    attemptEvents.push(outcomes[0]);
  }

  const distinctAxes = [
    aggregation.attempts.map(attempt => attempt.capture_proof.capture_id),
    aggregation.attempts.map(attempt => attempt.capture_proof.record_path),
    aggregation.attempts.map(attempt => attempt.process_proof.receipt_id),
    aggregation.attempts.map(attempt => attempt.report_proof.report_sha256),
    aggregation.attempts.map(attempt => attempt.cost_proof.event_seq),
  ];
  if (distinctAxes.some(values => new Set(values).size !== 2)) {
    fail('WSU1_F26_DUAL_IDENTITY_COLLISION');
  }
  const attempts = aggregation.attempts;
  const aggregate = {
    aggregation_id: aggregation.aggregation_id,
    checker_episode_id: checker.id,
    target_maker: maker.id,
    source_claim_sha256: sourceClaimSha256,
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
  const aggregateData = {
    episodeId: checker.id,
    verdict: 'APPROVE',
    workstream_id: workstream.id,
    point,
    target_maker: maker.id,
    reviewer_id: 'dual-checker-aggregate',
    review_source: 'imported-stdin',
    ...aggregate,
  };
  const aggregateProof = aggregation.aggregate_proof;
  const proofKeys = [
    'source_claim_sha256', 'attempt_ids', 'report_hashes', 'process_receipt_ids',
    'cost_event_seqs', 'capture_hashes', 'final_event_seq', 'final_event_checksum',
  ];
  const aggregateEvents = events.filter(event => event.type === 'review-outcome'
    && event.data?.episodeId === checker.id);
  if (!exactKeys(aggregateProof, proofKeys) || aggregateEvents.length !== 1
    || aggregateEvents[0].seq !== aggregateProof.final_event_seq
    || aggregateEvents[0].checksum !== aggregateProof.final_event_checksum
    || !same(aggregateEvents[0].data, aggregateData)
    || !same(aggregateProof, {
      source_claim_sha256: aggregate.source_claim_sha256,
      attempt_ids: aggregate.attempt_ids,
      report_hashes: aggregate.report_hashes,
      process_receipt_ids: aggregate.process_receipt_ids,
      cost_event_seqs: aggregate.cost_event_seqs,
      capture_hashes: aggregate.capture_hashes,
      final_event_seq: aggregateEvents[0].seq,
      final_event_checksum: aggregateEvents[0].checksum,
    }) || aggregateEvents[0].seq <= Math.max(...attemptEvents.map(event => event.seq), ...costs.map(event => event.seq))) {
    fail('WSU1_F26_DUAL_AGGREGATE_ORDER');
  }
  if (events.filter(event => event.type === 'review-attempt-outcome'
    && event.data?.episodeId === checker.id).length !== 2
    || events.filter(event => event.type === 'cost'
      && event.data?.dual_checker_aggregation_id === aggregation.aggregation_id).length !== 2) {
    fail('WSU1_F26_DUAL_AGGREGATE_ORDER');
  }
  const reviewsDirectory = canonicalDirectory(join(runDirectory, 'reviews'), 'WSU1_F26_DUAL_REPORT_PROOF');
  const reviewFiles = readdirSync(reviewsDirectory, { withFileTypes: true });
  if (reviewFiles.length !== 2 || reviewFiles.some(entry => !entry.isFile()
    || !attempts.some(attempt => entry.name === `${attempt.report_proof.report_sha256}.json`))
    || Object.keys(aggregateEvents[0].data).some(key => ['report', 'report_sha256', 'report_body'].includes(key))) {
    fail('WSU1_F26_SYNTHETIC_AGGREGATE');
  }

  const { bytes: hostObservationBytes, value: hostObservationValue } = regularJson(
    hostObservationPath, 'WSU1_F26_DUAL_OBSERVATION', 'WSU1_F26_DUAL_OBSERVATION',
    'WSU1_F26_DUAL_OBSERVATION',
  );
  validateHostObservation(hostObservationValue, {
    projectRoot, worktreePrefix, worktree, runId, workstream, maker, checker, aggregation, point,
  });
  const hostObservationSha256 = sha256(hostObservationBytes);
  const expectedHostObservationSha256 = process.env.WSU1_F26_EXPECT_HOST_OBSERVATION_SHA256;
  if (!SHA256.test(expectedHostObservationSha256 || '')
    || expectedHostObservationSha256 !== hostObservationSha256) {
    fail('WSU1_F26_DUAL_OBSERVATION');
  }
  const hostObservationReread = regularBytes(hostObservationPath, 'WSU1_F26_DUAL_OBSERVATION');
  if (!hostObservationReread.equals(hostObservationBytes)
    || sha256(hostObservationReread) !== hostObservationSha256) {
    fail('WSU1_F26_DUAL_OBSERVATION');
  }
  if (new Set(receipts.map(item => item.path)).size !== 2
    || new Set(receipts.map(item => item.sha256)).size !== 2
    || new Set(receipts.map(item => item.receipt.receipt_id)).size !== 2) {
    fail('WSU1_F26_DUAL_PROCESS_PROOF');
  }

  const evidence = JSON.parse(sources.find(({ path }) =>
    path === 'tests/fixtures/activation-pending-classification-evidence.json').bytes.toString('utf8'));
  const receipt = {
    run_id: runId,
    workstream_id: workstream.id,
    worktree_prefix: worktreePrefix,
    point,
    scope: RECEIPT_SCOPE,
    reviewed_source_sha256: reviewedSourceHash(sources),
    live_classification_sha256: relativeContract.find(({ path }) =>
      path === 'tests/fixtures/activation-pending-classification.md').sha256,
    evidence_rows_sha256: sha256(Buffer.from(`${JSON.stringify(evidence.rows)}\n`)),
    source_claim_sha256: sourceClaimSha256,
    attempts: attempts.map(attempt => ({
      slot: attempt.slot,
      attempt_id: attempt.attempt_id,
      reviewer_id: attempt.reviewer_id,
      reviewer_adapter: attempt.reviewer_adapter,
      provider_id: attempt.provider_id,
      model_id: attempt.model_id,
      session_id: attempt.session_id,
      capture_id: attempt.capture_proof.capture_id,
      capture_path: attempt.capture_proof.record_path,
      capture_sha256: attempt.capture_proof.record_sha256,
      process_receipt: attempt.process_proof.receipt,
      process_receipt_id: attempt.process_proof.receipt_id,
      cost_event_seq: attempt.cost_proof.event_seq,
      cost_event_checksum: attempt.cost_proof.event_checksum,
      report_path: attempt.report_proof.report,
      report_sha256: attempt.report_proof.report_sha256,
      attempt_outcome_seq: attempt.report_proof.event_seq,
      attempt_outcome_checksum: attempt.report_proof.event_checksum,
    })),
    provider_process_proofs: receipts.map(({ receipt, path, sha256: receiptSha256 }) => ({
      receipt: path,
      receipt_id: receipt.receipt_id,
      receipt_sha256: receiptSha256,
      provider_id: receipt.provider_id,
      model_id: receipt.model_id,
      session_id: receipt.session_id,
      stdout_sha256: receipt.stdout_sha256,
      stderr_sha256: receipt.stderr_sha256,
    })),
    host_observation: {
      path: relative(projectRoot, hostObservationPath).split(sep).join('/'),
      sha256: hostObservationSha256,
      observer_session_id: hostObservationValue.observer_session_id,
    },
    aggregate_event: {
      seq: aggregateEvents[0].seq,
      checksum: aggregateEvents[0].checksum,
      source_claim_sha256: sourceClaimSha256,
    },
    host_result_sha256: sha256(Buffer.from(hostObservationValue.stdout)),
  };
  verifyRunEvidenceUnchanged(runEvidence);
  verifySourceArtifactsUnchanged(worktree, relativeContract); // K_BOUNDARY_PRE_PUBLICATION
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const receiptIdentity = atomicallyCreate(receiptBinding, receiptBytes);
  const binding = receiptBinding;
  try {
    verifyReceiptParent(binding); // RECEIPT_BOUNDARY_POST_PUBLICATION
    verifySourceArtifactsUnchanged(worktree, relativeContract);
    verifyPublishedReceipt(binding, receiptIdentity, receiptBytes);
  } catch {
    unlinkExact(receiptBinding.path, receiptIdentity);
    try { flushDirectory(receiptBinding.parent); } catch { /* parent drift is already fail-closed */ }
    fail('WSU1_F26_WORKTREE_K');
  }
  process.stdout.write('WSU1_F26_ACTUAL_RUN_VERIFIED\n');
}

try { main(); }
catch (error) {
  const detail = process.env.WSU1_F26_DEBUG === '1' && error?.detail ? `:${error.detail}` : '';
  process.stderr.write(`${error?.diagnostic || 'WSU1_F26_VERIFICATION_FAILED'}${detail}\n`);
  process.exitCode = 1;
}
