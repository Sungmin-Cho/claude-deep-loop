#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { flushDirectory } from './lib/atomic-write.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAGS = Object.freeze([
  '--project-root', '--run-id', '--worktree', '--point', '--import-input',
  '--external-observation', '--receipt',
]);
const INPUT_KEYS = Object.freeze([
  'schema_version', 'reviewer_id', 'checker_episode_id', 'target_maker',
  'attempt_id', 'verdict', 'report_body', 'artifacts',
]);
const OBSERVATION_KEYS = Object.freeze([
  'schema_version', 'observer_role', 'observer_session_id', 'observed_at', 'project_root', 'worktree',
  'run_id', 'workstream_id', 'point', 'maker_episode_id', 'checker_episode_id', 'cwd', 'argv', 'env',
  'started_at', 'finished_at', 'exit_code', 'stdout', 'stderr', 'checker_terminal_status',
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

function shouldIgnore(worktree, path) {
  if (!existsSync(join(worktree, '.git'))) return false;
  const checked = spawnSync('git', ['-C', worktree, 'check-ignore', '--no-index', '--quiet', '--', path], {
    stdio: 'ignore',
  });
  if (checked.status === 0) return true;
  if (checked.status === 1) return false;
  fail('WSU1_F26_WORKTREE_K');
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
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) fail('WSU1_F26_WORKTREE_K');
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
    if (shouldIgnore(worktree, path)) continue;
    const rel = relative(worktree, path).split(sep).join('/');
    if (!portableRelative(rel)) fail('WSU1_F26_WORKTREE_K');
    rows.push({ path: rel, sha256: sha256(bytes), bytes });
  }
  return rows.sort((left, right) => byteSort(left.path, right.path));
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

function validateInput(input) {
  if (!exactKeys(input, INPUT_KEYS) || input.schema_version !== '1.0'
    || typeof input.reviewer_id !== 'string' || input.reviewer_id.length === 0
    || typeof input.checker_episode_id !== 'string' || input.checker_episode_id.length === 0
    || typeof input.target_maker !== 'string' || input.target_maker.length === 0
    || !RUN_ID.test(input.attempt_id || '') || input.verdict !== 'APPROVE'
    || typeof input.report_body !== 'string' || input.report_body.trim().length === 0
    || !canonicalArtifacts(input.artifacts)) fail('WSU1_F26_CLAIM_CONTEXT');
}

function validateReport(report, input, claim, runId) {
  if (report?.schema_version !== '1.0' || report.envelope?.producer !== 'deep-loop'
    || report.envelope?.artifact_kind !== 'review-report'
    || report.envelope?.schema?.name !== 'review-report' || report.envelope?.schema?.version !== '1.0'
    || report.envelope?.run_id !== runId) return false;
  const binding = report.envelope?.provenance?.review_binding;
  const expectedBinding = {
    reviewer_id: input.reviewer_id,
    checker_episode_id: input.checker_episode_id,
    target_maker: input.target_maker,
    attempt_id: input.attempt_id,
    artifacts: canonicalArtifacts(input.artifacts),
  };
  return same(binding, expectedBinding)
    && same(report.envelope?.provenance?.source_artifacts, expectedBinding.artifacts.map(({ path }) => path))
    && same(report.payload, { verdict: input.verdict, report_body: input.report_body })
    && same(canonicalArtifacts(claim.artifacts), expectedBinding.artifacts);
}

function locateReport(runDirectory, input, claim, runId) {
  const reviews = canonicalDirectory(join(runDirectory, 'reviews'), 'WSU1_F26_REPORT_MISSING');
  const matches = [];
  for (const entry of readdirSync(reviews, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const path = join(reviews, entry.name);
    const bytes = regularBytes(path, 'WSU1_F26_REPORT_MISSING');
    if (sha256(bytes) !== entry.name.slice(0, 64)) continue;
    let report;
    try { report = JSON.parse(bytes.toString('utf8')); } catch { continue; }
    if (validateReport(report, input, claim, runId)) matches.push({ path, bytes, report, sha: entry.name.slice(0, 64) });
  }
  if (matches.length !== 1) fail('WSU1_F26_REPORT_MISSING');
  return matches[0];
}

function validateObservation(observation, context) {
  if (!exactKeys(observation, OBSERVATION_KEYS) || observation.schema_version !== 1
    || observation.observer_role !== 'orchestrator'
    || typeof observation.observer_session_id !== 'string' || observation.observer_session_id.length === 0
    || !Number.isFinite(Date.parse(observation.observed_at))
    || !Number.isFinite(Date.parse(observation.started_at))
    || !Number.isFinite(Date.parse(observation.finished_at))) fail('WSU1_F26_OBSERVATION_SHAPE');
  if (observation.project_root !== context.projectRoot || observation.worktree !== context.worktreePrefix
    || observation.run_id !== context.runId || observation.workstream_id !== context.workstream.id
    || observation.point !== context.point || observation.maker_episode_id !== context.maker.id
    || observation.checker_episode_id !== context.checker.id) fail('WSU1_F26_OBSERVATION_RUN');
  const expectedArgv = [
    process.execPath,
    join(context.worktree, 'scripts', 'hooks-impl', 'drive-headless.mjs'),
    '--project-root',
    context.projectRoot,
    '--run-id',
    context.runId,
  ];
  if (observation.cwd !== context.projectRoot || !same(observation.argv, expectedArgv)
    || !same(observation.env, { DEEP_LOOP_UNATTENDED: '1' })) fail('WSU1_F26_OBSERVATION_COMMAND');
  let result;
  try { result = JSON.parse(observation.stdout.trim()); } catch { fail('WSU1_F26_OBSERVATION_RESULT'); }
  if (observation.exit_code !== 0 || observation.stderr !== '' || observation.checker_terminal_status !== 'approved'
    || result?.ok !== true || result.action !== 'checker-complete'
    || result.checkerEpisodeId !== context.checker.id
    || result.attemptId !== context.claim.attempt_id) fail('WSU1_F26_OBSERVATION_RESULT');
}

function atomicallyCreate(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) fail('WSU1_F26_RECEIPT_EXISTS');
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); } catch { unlinkSync(temporary); fail('WSU1_F26_RECEIPT_EXISTS'); }
  flushDirectory(dirname(path));
  unlinkSync(temporary);
  flushDirectory(dirname(path));
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
  const runId = args['--run-id'];
  const point = args['--point'];
  if (point !== 'wsu1-f26-independent-review') fail('WSU1_F26_CLAIM_CONTEXT');
  const runDirectory = canonicalDirectory(join(projectRoot, '.deep-loop', 'runs', runId), 'WSU1_F26_SYNTHETIC_RUN');
  if (!within(projectRoot, runDirectory)) fail('WSU1_F26_SYNTHETIC_RUN');
  const { value: loop } = regularJson(join(runDirectory, 'loop.json'), 'WSU1_F26_SYNTHETIC_RUN');
  if (loop?.run_id !== runId) fail('WSU1_F26_SYNTHETIC_RUN');
  let loopRoot;
  try { loopRoot = realpathSync(resolve(loop?.project?.root)); } catch { fail('WSU1_F26_SYNTHETIC_RUN'); }
  if (loopRoot !== projectRoot) fail('WSU1_F26_SYNTHETIC_RUN');
  if (loop.autonomy?.session_runtime !== 'codex' || loop.autonomy?.runtime_source !== 'skill-asserted') {
    fail('WSU1_F26_NON_CODEX');
  }
  if (loop.session_chain?.lease?.resume_policy === 'human') fail('WSU1_F26_HUMAN_POLICY');

  const { value: input } = regularJson(resolve(args['--import-input']), 'WSU1_F26_CLAIM_CONTEXT');
  validateInput(input);
  const workstream = loop.workstreams?.find((item) => item?.worktree === worktreePrefix);
  const maker = loop.episodes?.find((item) => item?.id === input.target_maker);
  const checker = loop.episodes?.find((item) => item?.id === input.checker_episode_id);
  if (!workstream || maker?.role !== 'maker' || maker.status !== 'done' || maker.point !== point
    || maker.workstream_id !== workstream.id || checker?.role !== 'checker'
    || !['deep-review', 'subagent-checker'].includes(checker.plugin) || checker.status !== 'approved'
    || checker.review_source !== 'imported-stdin' || checker.point !== point
    || checker.workstream_id !== workstream.id || checker.target_maker !== maker.id
    || checker.attempt_id !== input.attempt_id) fail('WSU1_F26_CLAIM_CONTEXT', 'identity');
  const claim = checker.review_claim;
  const claimAxes = claim && [claim.reviewer_id, claim.checker_episode_id, claim.target_maker, claim.attempt_id];
  if (!same(claimAxes, [input.reviewer_id, input.checker_episode_id, input.target_maker, input.attempt_id])
    || claim.run_id !== runId || claim.workstream_id !== workstream.id || claim.point !== point
    || claim.project_root !== projectRoot || claim.runtime !== 'codex'
    || claim.lease_owner !== loop.session_chain.lease.owner_run_id
    || claim.lease_generation !== loop.session_chain.lease.generation) fail('WSU1_F26_CLAIM_CONTEXT', JSON.stringify({
      axes: same(claimAxes, [input.reviewer_id, input.checker_episode_id, input.target_maker, input.attempt_id]),
      run: claim?.run_id === runId,
      workstream: claim?.workstream_id === workstream.id,
      point: claim?.point === point,
      root: claim?.project_root === projectRoot,
      runtime: claim?.runtime === 'codex',
      owner: claim?.lease_owner === loop.session_chain.lease.owner_run_id,
      generation: claim?.lease_generation === loop.session_chain.lease.generation,
    }));

  const sources = sourceArtifacts(worktree);
  const relativeContract = sources.map(({ path, sha256: digest }) => ({ path, sha256: digest }));
  const kernelContract = relativeContract.map(({ path, sha256: digest }) => ({
    path: `${worktreePrefix}/${path}`, sha256: digest,
  })).sort((left, right) => byteSort(left.path, right.path));
  if (!same(canonicalArtifacts(input.artifacts), kernelContract)
    || !same(canonicalArtifacts(claim.artifacts), kernelContract)
    || !same([...(maker.artifacts || [])].sort(byteSort), kernelContract.map(({ path }) => path))) {
    fail('WSU1_F26_WORKTREE_K');
  }
  const report = locateReport(runDirectory, input, claim, runId);
  const eventBytes = regularBytes(join(runDirectory, 'event-log.jsonl'), 'WSU1_F26_EVENT_LOG');
  const events = eventLines(eventBytes);
  validateEventLog(events, loop.event_log_head);
  const claimHash = sha256(Buffer.from(JSON.stringify(claim)));
  const costs = events.filter((event) => event.type === 'cost'
    && event.data?.source === 'codex-checker-measured'
    && event.data?.process_kind === 'checker'
    && event.data?.process_context?.checker_episode_id === input.checker_episode_id
    && event.data?.process_context?.attempt_id === input.attempt_id
    && event.data?.process_context?.target_maker === input.target_maker
    && event.data?.process_context?.claim_hash === claimHash);
  if (costs.length !== 1) fail('WSU1_F26_COST_EVENT_COUNT');
  const processContext = costs[0].data.process_context;
  if (!exactKeys(processContext, [
    'origin_owner', 'origin_generation', 'checker_episode_id', 'attempt_id', 'target_maker', 'claim_hash',
  ]) || processContext.origin_owner !== claim.lease_owner
    || processContext.origin_generation !== claim.lease_generation) fail('WSU1_F26_CLAIM_CONTEXT');

  const observationPath = resolve(args['--external-observation']);
  const { bytes: observationBytes, value: observation } = regularJson(observationPath,
    'WSU1_F26_OBSERVATION_MISSING', 'WSU1_F26_OBSERVATION_NON_REGULAR', 'WSU1_F26_OBSERVATION_SHAPE');
  validateObservation(observation, {
    projectRoot, worktreePrefix, worktree, runId, workstream, maker, checker, claim, point,
  });
  const observationSha = sha256(observationBytes);
  if (process.env.WSU1_F26_EXPECT_OBSERVATION_SHA256 !== undefined
    && process.env.WSU1_F26_EXPECT_OBSERVATION_SHA256 !== observationSha) fail('WSU1_F26_OBSERVATION_DIGEST');
  const rereadObservation = regularBytes(observationPath, 'WSU1_F26_OBSERVATION_MISSING',
    'WSU1_F26_OBSERVATION_NON_REGULAR');
  if (!rereadObservation.equals(observationBytes) || sha256(rereadObservation) !== observationSha) {
    fail('WSU1_F26_OBSERVATION_DIGEST');
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
    checker_cost_event: {
      seq: costs[0].seq,
      process_context: processContext,
      claim_hash: claimHash,
    },
    external_observation: {
      path: relative(projectRoot, observationPath).split(sep).join('/'),
      sha256: observationSha,
      observer_session_id: observation.observer_session_id,
    },
    report_path: `.deep-loop/runs/${runId}/reviews/${report.sha}.json`,
    report_sha256: report.sha,
    envelope: report.report,
  };
  atomicallyCreate(resolve(args['--receipt']), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`));
  process.stdout.write('WSU1_F26_ACTUAL_RUN_VERIFIED\n');
}

try { main(); }
catch (error) {
  const detail = process.env.WSU1_F26_DEBUG === '1' && error?.detail ? `:${error.detail}` : '';
  process.stderr.write(`${error?.diagnostic || 'WSU1_F26_VERIFICATION_FAILED'}${detail}\n`);
  process.exitCode = 1;
}
