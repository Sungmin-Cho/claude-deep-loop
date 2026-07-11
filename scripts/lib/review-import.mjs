import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWrite, unwrap, wrap } from './envelope.mjs';
import {
  canonicalNonSymlinkDirectory,
  containedRealFileWithin,
  normalizePortableRelativePath,
  pathWithin,
} from './fs-safe.mjs';
import { runDir } from './state.mjs';
import { REVIEW_IMPORT_MAX_BYTES } from './bounded-input.mjs';

export const REVIEW_REPORT_BODY_MAX_BYTES = 262_144;
export const REVIEW_IMPORT_MAX_ARTIFACTS = 256;

const TOP_LEVEL_KEYS = Object.freeze([
  'schema_version', 'reviewer_id', 'checker_episode_id', 'target_maker',
  'verdict', 'report_body', 'artifacts',
]);
const ARTIFACT_KEYS = Object.freeze(['path', 'sha256']);
const REVIEWERS = new Set(['deep-review', 'subagent-checker']);
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'CONCERN']);
const SHA256 = /^[0-9a-f]{64}$/;

// Closed proof identity set shared by record/import, routing, and finish.
// Legacy `standalone` (and unknown plugins) may remain in persisted history, but can never create proof.
export const isProofCapableChecker = checker => checker?.role === 'checker' && REVIEWERS.has(checker.plugin);

const exactKeys = (value, keys) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const nonEmptyString = value => typeof value === 'string' && value.length > 0;
export const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
export function sha256File(path) {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function parseReviewImport(raw) {
  if (typeof raw !== 'string') throw new Error('REVIEW_IMPORT_RAW_INVALID: expected UTF-8 text');
  if (Buffer.byteLength(raw, 'utf8') > REVIEW_IMPORT_MAX_BYTES) {
    throw new Error(`REVIEW_IMPORT_TOO_LARGE: input exceeds ${REVIEW_IMPORT_MAX_BYTES} bytes`);
  }
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error('REVIEW_IMPORT_JSON_INVALID: stdin must be one JSON document', { cause: error }); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('REVIEW_IMPORT_OBJECT_INVALID: top level must be an object');
  }
  if (!exactKeys(value, TOP_LEVEL_KEYS)) {
    throw new Error('REVIEW_IMPORT_PROPERTY_INVALID: exact top-level properties are required');
  }
  if (value.schema_version !== '1.0') throw new Error('REVIEW_IMPORT_SCHEMA_INVALID: schema_version must be 1.0');
  if (!nonEmptyString(value.reviewer_id)) throw new Error('REVIEW_IMPORT_REVIEWER_INVALID: reviewer_id must be a non-empty string');
  if (!nonEmptyString(value.checker_episode_id)) throw new Error('REVIEW_IMPORT_CHECKER_INVALID: checker_episode_id must be a non-empty string');
  if (!nonEmptyString(value.target_maker)) throw new Error('REVIEW_IMPORT_TARGET_INVALID: target_maker must be a non-empty string');
  if (!VERDICTS.has(value.verdict)) throw new Error(`REVIEW_IMPORT_VERDICT_INVALID: ${String(value.verdict)}`);
  if (typeof value.report_body !== 'string') throw new Error('REVIEW_IMPORT_BODY_INVALID: report_body must be a string');
  if (Buffer.byteLength(value.report_body, 'utf8') > REVIEW_REPORT_BODY_MAX_BYTES) {
    throw new Error(`REVIEW_IMPORT_BODY_TOO_LARGE: report_body exceeds ${REVIEW_REPORT_BODY_MAX_BYTES} UTF-8 bytes`);
  }
  if (!Array.isArray(value.artifacts)) throw new Error('REVIEW_IMPORT_ARTIFACTS_INVALID: artifacts must be an array');
  if (value.artifacts.length > REVIEW_IMPORT_MAX_ARTIFACTS) {
    throw new Error(`REVIEW_IMPORT_ARTIFACTS_TOO_MANY: artifacts exceeds ${REVIEW_IMPORT_MAX_ARTIFACTS}`);
  }

  const seen = new Set();
  const artifacts = value.artifacts.map((artifact) => {
    if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw new Error('REVIEW_IMPORT_ARTIFACT_INVALID: each artifact must be an object');
    }
    if (!exactKeys(artifact, ARTIFACT_KEYS)) {
      throw new Error('REVIEW_IMPORT_ARTIFACT_PROPERTY_INVALID: exact artifact properties are required');
    }
    const path = normalizePortableRelativePath(artifact.path);
    if (!path) throw new Error(`REVIEW_IMPORT_ARTIFACT_PATH_INVALID: ${String(artifact.path)}`);
    if (!SHA256.test(artifact.sha256 || '')) {
      throw new Error(`REVIEW_IMPORT_ARTIFACT_HASH_INVALID: ${path} sha256 must be lowercase 64-hex`);
    }
    if (seen.has(path)) throw new Error(`REVIEW_IMPORT_ARTIFACT_DUPLICATE: ${path}`);
    seen.add(path);
    return { path, sha256: artifact.sha256 };
  });
  return { ...value, artifacts };
}

function normalizedMakerArtifacts(maker) {
  if (!Array.isArray(maker?.artifacts)) throw new Error('REVIEW_IMPORT_MAKER_ARTIFACT_INVALID: maker artifacts are missing');
  const normalized = [];
  const seen = new Set();
  for (const value of maker.artifacts) {
    const path = normalizePortableRelativePath(value);
    if (!path || seen.has(path)) throw new Error(`REVIEW_IMPORT_MAKER_ARTIFACT_INVALID: ${String(value)}`);
    seen.add(path); normalized.push(path);
  }
  return normalized;
}

export function validateImportedEvidence(root, loop, input, { checker, maker, workstream } = {}) {
  if (!isProofCapableChecker(checker)) throw new Error(`REVIEW_IMPORT_REVIEWER_INVALID: unsupported checker plugin ${String(checker?.plugin)}`);
  if (input.reviewer_id !== checker.plugin) throw new Error(`REVIEW_IMPORT_REVIEWER_MISMATCH: ${input.reviewer_id} != ${checker.plugin}`);
  if (input.checker_episode_id !== checker.id) throw new Error(`REVIEW_IMPORT_CHECKER_MISMATCH: ${input.checker_episode_id} != ${checker.id}`);
  if (input.target_maker !== maker.id || input.target_maker !== checker.target_maker) {
    throw new Error(`REVIEW_IMPORT_TARGET_MISMATCH: ${input.target_maker} != ${checker.target_maker}`);
  }

  const recorded = normalizedMakerArtifacts(maker);
  const imported = input.artifacts.map(artifact => artifact.path);
  if (recorded.length !== imported.length || recorded.some(path => !imported.includes(path))) {
    throw new Error('REVIEW_IMPORT_ARTIFACT_SET_MISMATCH: imported artifacts must equal the terminal maker artifact set');
  }

  const worktreeAbs = resolve(root, workstream.worktree);
  for (const artifact of input.artifacts) {
    const real = containedRealFileWithin(root, artifact.path, worktreeAbs);
    if (!real) throw new Error(`REVIEW_IMPORT_ARTIFACT_CONTAINMENT: ${artifact.path}`);
    const actual = sha256File(real);
    if (actual !== artifact.sha256) throw new Error(`REVIEW_IMPORT_ARTIFACT_HASH_MISMATCH: ${artifact.path}`);
  }
  return {
    reviewerId: checker.plugin,
    checkerEpisodeId: checker.id,
    targetMaker: maker.id,
    artifacts: input.artifacts.map(artifact => ({ ...artifact })),
  };
}

function requireReviewDirectory(root, runId, { createReviews = false } = {}) {
  let resolvedRoot;
  try { resolvedRoot = realpathSync(resolve(root)); }
  catch (error) { throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: canonical project root is unavailable', { cause: error }); }
  const canonicalRoot = canonicalNonSymlinkDirectory(resolvedRoot);
  if (!canonicalRoot) throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: canonical project root is not a directory');
  const deepLoop = join(canonicalRoot, '.deep-loop');
  const runs = join(deepLoop, 'runs');
  const run = runDir(canonicalRoot, runId);
  let parent = canonicalRoot;
  for (const path of [deepLoop, runs, run]) {
    const canonical = canonicalNonSymlinkDirectory(path);
    if (!canonical || !pathWithin(parent, canonical)) throw new Error(`REVIEW_IMPORT_DIRECTORY_UNSAFE: ${path}`);
    parent = canonical;
  }
  const reviews = join(run, 'reviews');
  if (createReviews && !existsSync(reviews)) {
    try { mkdirSync(reviews); }
    catch (error) { if (!existsSync(reviews)) throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: cannot create reviews directory', { cause: error }); }
  }
  const canonicalReviews = canonicalNonSymlinkDirectory(reviews);
  if (!canonicalReviews || !pathWithin(parent, canonicalReviews)) {
    throw new Error(`REVIEW_IMPORT_DIRECTORY_UNSAFE: ${reviews}`);
  }
  return { canonicalRoot, run, reviews: canonicalReviews };
}

function generatedAt(now) {
  const value = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error('INVALID_NOW: review import envelope timestamp');
  return value.toISOString();
}

export function materializeImportedReview(root, runId, input, binding, { now } = {}) {
  const { canonicalRoot, reviews } = requireReviewDirectory(root, runId, { createReviews: true });
  const envelope = wrap({
    producer: 'deep-loop', artifact_kind: 'review-report',
    schema: { name: 'review-report', version: '1.0' }, run_id: runId,
    provenance: {
      source_artifacts: binding.artifacts.map(artifact => artifact.path),
      tool_versions: {},
      review_binding: {
        reviewer_id: binding.reviewerId,
        checker_episode_id: binding.checkerEpisodeId,
        target_maker: binding.targetMaker,
        artifacts: binding.artifacts.map(artifact => ({ ...artifact })),
      },
    },
    payload: { verdict: input.verdict, report_body: input.report_body },
    now: generatedAt(now),
  });
  const raw = JSON.stringify(envelope, null, 2);
  const reportBytes = Buffer.byteLength(raw, 'utf8');
  const reportSha256 = sha256Bytes(Buffer.from(raw));
  const name = `${reportSha256}.json`;
  const reportAbs = join(reviews, name);
  if (existsSync(reportAbs)) {
    const st = lstatSync(reportAbs);
    if (st.isSymbolicLink() || !st.isFile() || st.size !== reportBytes || !readFileSync(reportAbs).equals(Buffer.from(raw))) {
      throw new Error(`REVIEW_IMPORT_ENVELOPE_COLLISION: ${name}`);
    }
  } else {
    atomicWrite(reportAbs, raw);
  }
  const report = ['.deep-loop', 'runs', runId, 'reviews', name].join('/');
  if (resolve(canonicalRoot, ...report.split('/')) !== reportAbs) {
    throw new Error('REVIEW_IMPORT_DIRECTORY_UNSAFE: durable report path mismatch');
  }
  return { report, reportAbs, reportBytes, reportSha256, input, binding };
}

const sameArtifacts = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function verifyImportedEnvelope(root, runId, evidence, lockedBinding) {
  const { canonicalRoot, reviews } = requireReviewDirectory(root, runId);
  if (!SHA256.test(evidence.reportSha256 || '')) throw new Error('REVIEW_REPORT_HASH_MISMATCH: invalid expected hash');
  const expectedName = `${evidence.reportSha256}.json`;
  const expectedAbs = join(reviews, expectedName);
  const expectedRel = ['.deep-loop', 'runs', runId, 'reviews', expectedName].join('/');
  if (evidence.report !== expectedRel || evidence.reportAbs !== expectedAbs || resolve(canonicalRoot, ...expectedRel.split('/')) !== expectedAbs) {
    throw new Error('REVIEW_IMPORT_ENVELOPE_BINDING_MISMATCH: report path');
  }
  let stat;
  try { stat = lstatSync(expectedAbs); } catch { throw new Error('REVIEW_IMPORT_ENVELOPE_MISSING: report'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('REVIEW_IMPORT_ENVELOPE_CONTAINMENT: report must be a regular non-symlink file');
  if (!Number.isSafeInteger(evidence.reportBytes) || stat.size !== evidence.reportBytes) {
    throw new Error('REVIEW_REPORT_HASH_MISMATCH: envelope size changed');
  }
  const raw = readFileSync(expectedAbs);
  if (sha256Bytes(raw) !== evidence.reportSha256) throw new Error('REVIEW_REPORT_HASH_MISMATCH: envelope bytes changed');
  let object;
  try { object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch (error) { throw new Error('REVIEW_IMPORT_ENVELOPE_INVALID: envelope JSON/UTF-8', { cause: error }); }
  const opened = unwrap(object, { producer: 'deep-loop', artifact_kind: 'review-report' });
  const binding = opened?.envelope?.provenance?.review_binding;
  if (!opened || opened.schema_version !== '1.0' || opened.envelope.schema?.version !== '1.0'
      || opened.envelope.run_id !== runId
      || binding?.reviewer_id !== lockedBinding.reviewerId
      || binding?.checker_episode_id !== lockedBinding.checkerEpisodeId
      || binding?.target_maker !== lockedBinding.targetMaker
      || !sameArtifacts(binding?.artifacts, lockedBinding.artifacts)
      || opened.payload?.verdict !== evidence.input.verdict
      || opened.payload?.report_body !== evidence.input.report_body) {
    throw new Error('REVIEW_IMPORT_ENVELOPE_BINDING_MISMATCH: kernel provenance');
  }
  return true;
}
