import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  importDualReviewOutcome,
  runDualStreamingProcessesSync,
} from '../scripts/lib/dual-checker.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview } from '../scripts/lib/review.mjs';
import { driveHeadlessRun } from '../scripts/lib/headless-host.mjs';
import { listProcessUsageReceipts } from '../scripts/lib/preflight-receipt-journal.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { writeExactDualCapture } from './helpers/dual-capture.mjs';

const CODEX_SESSION = '11111111-1111-4111-8111-111111111111';
const GROK_SESSION = '22222222-2222-4222-8222-222222222222';
const SESSION_PLACEHOLDER = 'provider-session-bound-by-host';

test('synchronous dual worker starts both real transports before either result is observed', () => {
  const coordination = mkdtempSync(join(tmpdir(), 'deep-loop-dual-worker-'));
  const marker = join(coordination, 'grok-started');
  const codexReview = JSON.stringify({ verdict: 'APPROVE', report_body: 'codex approve' });
  const codexScript = [
    "const { existsSync } = require('node:fs');",
    `const marker = ${JSON.stringify(marker)};`,
    'const deadline = Date.now() + 1500;',
    'while (!existsSync(marker) && Date.now() < deadline) {}',
    "if (!existsSync(marker)) process.exit(17);",
    `process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: ${JSON.stringify(CODEX_SESSION)} }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(codexReview)} } }) + '\\n');`,
    "process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }) + '\\n');",
  ].join('');
  const grokReviewObject = { verdict: 'APPROVE', report_body: 'grok approve' };
  const grokReview = JSON.stringify(grokReviewObject);
  const grokScript = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(marker)}, 'started');`,
    'process.stdout.write(JSON.stringify({',
    `session_id: ${JSON.stringify(GROK_SESSION)}, model: 'grok-4.6', num_turns: 1,`,
    `usage: { input_tokens: 5, output_tokens: 4 }, result: ${JSON.stringify(grokReviewObject)}`,
    '}));',
  ].join('');

  const results = runDualStreamingProcessesSync([
    {
      bin: process.execPath,
      argv: ['-e', codexScript, 'fixture', '--model', 'gpt-5.6-sol'],
      cwd: coordination,
      env: {},
      shell: false,
      usageOutputKind: 'codex-jsonl',
      captureFinalMessage: true,
      captureProviderIdentity: true,
      captureProcessDiagnostic: true,
    },
    {
      bin: process.execPath,
      argv: ['-e', grokScript],
      cwd: coordination,
      env: {},
      shell: false,
      usageOutputKind: 'grok-json',
      captureFinalMessage: true,
      captureProcessDiagnostic: true,
    },
  ], { timeoutMs: 2_000 });

  assert.equal(results.ok, true, JSON.stringify(results));
  assert.equal(results.results.length, 2);
  assert.equal(results.results[0].ok, true);
  assert.equal(results.results[0].finalMessage.toString('utf8'), codexReview);
  assert.deepEqual(results.results[0].providerIdentity, {
    session_id: CODEX_SESSION,
    model_id: 'gpt-5.6-sol',
  });
  assert.equal(results.results[1].ok, true);
  assert.equal(results.results[1].finalMessage.toString('utf8'), grokReview);
  assert.deepEqual(results.results[1].providerIdentity, {
    session_id: GROK_SESSION,
    model_id: 'grok-4.6',
  });
});

test('dual worker protocol rejects cardinality and malformed transport results', () => {
  assert.deepEqual(runDualStreamingProcessesSync([], { timeoutMs: 10 }), {
    ok: false,
    reason: 'dual-worker-request-invalid',
  });
  const result = runDualStreamingProcessesSync([
    {
      bin: process.execPath, argv: ['-e', 'process.exit(0)'], shell: false,
      usageOutputKind: 'codex-jsonl', captureFinalMessage: true,
      captureProviderIdentity: true, captureProcessDiagnostic: true,
    },
    {
      bin: process.execPath, argv: ['-e', 'process.exit(0)'], shell: false,
      usageOutputKind: 'grok-json', captureFinalMessage: true,
      captureProcessDiagnostic: true,
    },
  ], {
    timeoutMs: 10,
    spawnSyncImpl: () => ({ status: 0, signal: null, stdout: '{"ok":true}', stderr: '' }),
  });
  assert.deepEqual(result, { ok: false, reason: 'dual-worker-protocol-invalid' });
});

const sha256 = value => createHash('sha256').update(value).digest('hex');

function dualHostFixture({ approvals = 'approved' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deep-loop-dual-host-'));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'dual headless review', detected: { 'deep-review': true },
    now: new Date('2026-08-15T09:00:00.000Z'), env: {}, platform: 'linux',
    run: () => ({ code: 1 }),
  });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/dual-host';
  const artifact = `${worktree}/implementation.txt`;
  mkdirSync(dirname(join(root, artifact)), { recursive: true });
  writeFileSync(join(root, artifact), 'dual host implementation');
  const workstreamId = newWorkstream(root, runId, {
    title: 'dual host', branch: 'dual-host', worktree, fence,
  }).id;
  const makerId = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: workstreamId, expectedArtifacts: [artifact], fence,
  }).id;
  recordEpisode(root, runId, makerId, { status: 'in_progress', fence });
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: [artifact], proof: {}, fence });
  const checkerId = dispatchReview(root, runId, {
    point: 'implementation', workstreamId, detected: { 'deep-review': true }, fence,
  }).checkerEpisodeId;
  const state = readState(root, runId).data;
  state.autonomy.spawn_style = 'headless';
  if (approvals === 'approved') {
    state.autonomy.checker_executable_approvals = {
      codex: {
        checker: 'codex', reviewer_adapter: 'codex-checker', provider_id: 'openai-codex',
        model_id: 'gpt-5.6-sol',
        canonical_path: '/opt/codex/bin/codex', sha256: 'c'.repeat(64), version: '0.144.1',
        platform: process.platform, arch: process.arch, source: 'human-explicit', authenticode: null,
        approved_by: 'human', approved_at: '2026-08-15T09:00:01.000Z',
      },
      grok: {
        checker: 'grok', reviewer_adapter: 'grok-checker', provider_id: 'xai-grok',
        model_id: 'grok-4.6',
        canonical_path: '/opt/grok/bin/grok', sha256: 'd'.repeat(64), version: '1.0.4',
        platform: process.platform, arch: process.arch, source: 'human-explicit', authenticode: null,
        approved_by: 'human', approved_at: '2026-08-15T09:00:02.000Z',
      },
    };
  }
  writeState(root, runId, state);
  return { root, runId, fence, makerId, checkerId };
}

test('fresh null checker approval map is dual-required and cannot fall through to scalar review', () => {
  const f = dualHostFixture({ approvals: 'missing' });
  let transports = 0;
  const result = driveHeadlessRun({
    ...dualHostDependencies(f, () => {
      transports += 1;
      throw new Error('unapproved dual transport must not launch');
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'checker-blocked');
  assert.equal(result.reason, 'dual-checker-approval-missing');
  assert.equal(transports, 0);
  const finalEvents = events(f.root, f.runId);
  assert.equal(finalEvents.filter(event => event.type === 'independent-review-aggregation-claimed').length, 1);
  assert.equal(finalEvents.filter(event => event.type === 'independent-review-claimed').length, 0);
  const checker = readState(f.root, f.runId).data.episodes.find(episode => episode.id === f.checkerId);
  assert.equal(checker.status, 'blocked');
  assert.equal(checker.review_aggregation?.schema_version, '2.0');
});

function events(root, runId) {
  return readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function hostCaptureProof(fixture, attempt) {
  return writeExactDualCapture({
    root: fixture.root,
    runId: fixture.runId,
    checkerEpisodeId: fixture.checkerId,
    attemptId: attempt.attempt_id,
    sourceClaimSha256: attempt.source_claim_sha256,
  }).proof;
}

function dualImportBytes(claim, attempt, verdict = 'APPROVE') {
  return Buffer.from(JSON.stringify({
    schema_version: '2.0',
    aggregation_id: claim.aggregation_id,
    reviewer_id: attempt.reviewer_id,
    reviewer_adapter: attempt.reviewer_adapter,
    provider_id: attempt.provider_id,
    model_id: attempt.model_id,
    session_id: SESSION_PLACEHOLDER,
    checker_episode_id: claim.checker_episode_id,
    target_maker: claim.source_binding.target_maker,
    attempt_id: attempt.attempt_id,
    source_claim_sha256: attempt.source_claim_sha256,
    verdict,
    report_body: `# ${attempt.reviewer_id}\n\n${verdict}`,
    artifacts: claim.source_binding.artifacts,
  }));
}

function dualHostDependencies(f, transport) {
  const idValues = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ];
  return {
    root: f.root,
    runId: f.runId,
    now: Date.parse('2026-08-15T09:01:00.000Z'),
    clock: () => Date.parse('2026-08-15T09:01:00.000Z'),
    expect: { owner: f.runId, generation: 1 },
    revalidateCheckerExecutable: (identity, options) => {
      assert.equal(options?.expectedModelId, identity.model_id);
      return identity;
    },
    resolveCodexHome: () => ({
      canonical_path: '/home/test/.codex', device: '1', inode: '2',
      birthtime_ns: '3', platform: process.platform,
    }),
    buildDualCodexEnvFn: () => ({}),
    resolveCheckerSkill: () => ({ source: 'trusted-deep-review' }),
    dualCaptureProofFn: ({ attempt }) => hostCaptureProof(f, attempt),
    buildDualCodexEntryFn: options => ({ transport: 'codex', options }),
    buildDualGrokEntryFn: options => ({ transport: 'grok', options }),
    dualRunFn: transport,
    dualIdFactory: () => idValues.shift(),
    dualSessionIdFactory: () => { throw new Error('host must not mint provider session identity'); },
    emitHandoffFn: () => ({ ok: true }),
  };
}

test('headless dual route emits checker-complete only after both measured imports and one aggregate outcome', () => {
  const f = dualHostFixture();
  const sessions = [CODEX_SESSION, GROK_SESSION];
  const captureCalls = [];
  const importStates = [];
  const deps = dualHostDependencies(f, entries => {
    assert.deepEqual(entries.map(entry => entry.transport), ['codex', 'grok']);
    assert.equal(entries[0].options.contract.session_id, SESSION_PLACEHOLDER);
    assert.equal(entries[1].options.contract.session_id, SESSION_PLACEHOLDER);
    assert.equal(Object.hasOwn(entries[1].options, 'sessionId'), false);
    const state = readState(f.root, f.runId).data;
    const claim = state.episodes.find(episode => episode.id === f.checkerId).review_aggregation;
    return {
      ok: true,
      results: claim.attempts.map((attempt, index) => ({
        ok: true,
        usage: { num_turns: 1, input_tokens: 7 + index, output_tokens: 3, tokens: 10 + index },
        finalMessage: dualImportBytes({
          aggregation_id: claim.aggregation_id,
          checker_episode_id: f.checkerId,
          source_binding: claim.source_binding,
        }, attempt),
        providerIdentity: { session_id: sessions[index], model_id: attempt.model_id },
        process_streams: {
          stdout: { sha256: sha256(`stdout:${attempt.attempt_id}`), byte_count: 1, truncated: false },
          stderr: { sha256: sha256(`stderr:${attempt.attempt_id}`), byte_count: 0, truncated: false },
        },
      })),
    };
  });
  const result = driveHeadlessRun({
    ...deps,
    dualCaptureProofFn: ({ attempt }) => {
      captureCalls.push(attempt.attempt_id);
      return hostCaptureProof(f, attempt);
    },
    importDualReviewFn: (root, runId, options) => {
      const imported = importDualReviewOutcome(root, runId, options);
      const state = readState(root, runId).data;
      const checker = state.episodes.find(episode => episode.id === f.checkerId);
      importStates.push({
        terminal: imported.terminal,
        checker_status: checker.status,
        aggregate_events: events(root, runId).filter(event => event.type === 'review-outcome').length,
      });
      return imported;
    },
  });

  assert.equal(result.action, 'checker-complete', JSON.stringify(result));
  assert.equal(result.recorded, true);
  assert.equal(captureCalls.length, 2);
  assert.equal(new Set(captureCalls).size, 2);
  assert.deepEqual(importStates, [
    { terminal: null, checker_status: 'in_progress', aggregate_events: 0 },
    { terminal: 'approved', checker_status: 'approved', aggregate_events: 1 },
  ]);
  const finalEvents = events(f.root, f.runId);
  assert.equal(finalEvents.filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id).length, 2);
  assert.equal(finalEvents.filter(event => event.type === 'review-attempt-outcome').length, 2);
  assert.equal(finalEvents.filter(event => event.type === 'review-outcome').length, 1);
  const checker = readState(f.root, f.runId).data.episodes.find(episode => episode.id === f.checkerId);
  assert.equal(checker.review_aggregation.attempts.every(attempt => attempt.status === 'imported'), true);
  assert.equal(checker.review_aggregation.aggregate_status, 'approved');
  const receiptDir = join(runDir(f.root, f.runId), 'preflight', 'process-receipts');
  const dualReceiptNames = readdirSync(receiptDir).filter(name => name.endsWith('-dual-checker.json'));
  assert.equal(dualReceiptNames.length, 2);
  assert.deepEqual(
    listProcessUsageReceipts({ root: f.root, runId: f.runId }),
    [],
    'settled dual proof receipts must remain immutable without entering scalar recovery',
  );
  const tamperedReceipt = join(receiptDir, dualReceiptNames[0]);
  const tampered = JSON.parse(readFileSync(tamperedReceipt, 'utf8'));
  tampered.usage.tokens += 1;
  writeFileSync(tamperedReceipt, JSON.stringify(tampered, null, 2));
  assert.throws(
    () => listProcessUsageReceipts({ root: f.root, runId: f.runId }),
    /PROCESS_USAGE_RECEIPT_INVALID/,
    'dual receipts may be excluded only after exact state, event, and content reconciliation',
  );
});

test('headless dual rejection emits no checker-complete and no continuation', () => {
  const f = dualHostFixture();
  const sessions = [CODEX_SESSION, GROK_SESSION];
  let handoffs = 0;
  const deps = dualHostDependencies(f, () => {
    const state = readState(f.root, f.runId).data;
    const claim = state.episodes.find(episode => episode.id === f.checkerId).review_aggregation;
    return {
      ok: true,
      results: claim.attempts.map((attempt, index) => ({
        ok: true,
        usage: { num_turns: 1, input_tokens: 5, output_tokens: 2, tokens: 7 },
        finalMessage: dualImportBytes({
          aggregation_id: claim.aggregation_id,
          checker_episode_id: f.checkerId,
          source_binding: claim.source_binding,
        }, attempt, index === 0 ? 'APPROVE' : 'CONCERN'),
        providerIdentity: { session_id: sessions[index], model_id: attempt.model_id },
        process_streams: {
          stdout: { sha256: sha256(`reject-out-${index}`), byte_count: 1, truncated: false },
          stderr: { sha256: sha256(`reject-err-${index}`), byte_count: 0, truncated: false },
        },
      })),
    };
  });
  const result = driveHeadlessRun({
    ...deps,
    emitHandoffFn: () => { handoffs += 1; return { ok: true }; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, 'checker-rejected');
  assert.equal(result.continuation, false);
  assert.equal(handoffs, 0);
  const checker = readState(f.root, f.runId).data.episodes.find(episode => episode.id === f.checkerId);
  assert.equal(checker.status, 'rejected');
  assert.equal(checker.review_aggregation.aggregate_status, 'rejected');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'review-outcome').length, 1);
});

test('headless dual route recovers either exact committed import after acknowledgement loss', () => {
  for (const lostAttempt of [0, 1]) {
    const f = dualHostFixture();
    const sessions = [CODEX_SESSION, GROK_SESSION];
    const deps = dualHostDependencies(f, () => {
      const state = readState(f.root, f.runId).data;
      const claim = state.episodes.find(episode => episode.id === f.checkerId).review_aggregation;
      return {
        ok: true,
        results: claim.attempts.map((attempt, index) => ({
          ok: true,
          usage: { num_turns: 1, input_tokens: 4 + index, output_tokens: 2, tokens: 6 + index },
          finalMessage: dualImportBytes({
            aggregation_id: claim.aggregation_id,
            checker_episode_id: f.checkerId,
            source_binding: claim.source_binding,
          }, attempt),
          providerIdentity: { session_id: sessions[index], model_id: attempt.model_id },
          process_streams: {
            stdout: { sha256: sha256(`ack-out-${index}`), byte_count: 1, truncated: false },
            stderr: { sha256: sha256(`ack-err-${index}`), byte_count: 0, truncated: false },
          },
        })),
      };
    });
    let committedImports = 0;
    let injected = false;
    const result = driveHeadlessRun({
      ...deps,
      importDualReviewFn: (root, runId, options) => {
        const imported = importDualReviewOutcome(root, runId, options);
        if (imported.recovered !== true) committedImports += 1;
        if (!injected && committedImports === lostAttempt + 1) {
          injected = true;
          throw new Error('injected acknowledgement loss after commit');
        }
        return imported;
      },
    });

    assert.equal(result.action, 'checker-complete', `attempt ${lostAttempt}: ${JSON.stringify(result)}`);
    assert.equal(injected, true);
    const log = events(f.root, f.runId);
    assert.equal(log.filter(event => event.type === 'cost'
      && event.data?.dual_checker_attempt_id).length, 2);
    assert.equal(log.filter(event => event.type === 'review-attempt-outcome').length, 2);
    assert.equal(log.filter(event => event.type === 'review-outcome').length, 1);
  }
});

test('headless partial transport failure preserves each measurable successful attempt cost and blocks aggregation', () => {
  const f = dualHostFixture();
  const result = driveHeadlessRun(dualHostDependencies(f, () => {
    const state = readState(f.root, f.runId).data;
    const claim = state.episodes.find(episode => episode.id === f.checkerId).review_aggregation;
    const attempt = claim.attempts[0];
    return {
      ok: true,
      results: [
        {
          ok: true,
          usage: { num_turns: 1, input_tokens: 7, output_tokens: 3, tokens: 10 },
          finalMessage: dualImportBytes({
            aggregation_id: claim.aggregation_id,
            checker_episode_id: f.checkerId,
            source_binding: claim.source_binding,
          }, attempt),
          providerIdentity: { session_id: CODEX_SESSION, model_id: attempt.model_id },
          process_streams: {
            stdout: { sha256: sha256('partial-stdout'), byte_count: 1, truncated: false },
            stderr: { sha256: sha256('partial-stderr'), byte_count: 0, truncated: false },
          },
        },
        { ok: false, reason: 'child-nonzero-exit' },
      ],
    };
  }));

  assert.equal(result.action, 'checker-blocked', JSON.stringify(result));
  assert.equal(result.reason, 'dual-checker-process-failed');
  const state = readState(f.root, f.runId).data;
  const checker = state.episodes.find(episode => episode.id === f.checkerId);
  assert.equal(checker.status, 'blocked');
  assert.equal(checker.review_aggregation.aggregate_status, 'blocked');
  assert.equal(events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id).length, 1);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-attempt-outcome'), false);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
});

test('headless provider session collision charges both measured transports but imports neither', () => {
  const f = dualHostFixture();
  const result = driveHeadlessRun(dualHostDependencies(f, () => {
    const state = readState(f.root, f.runId).data;
    const claim = state.episodes.find(episode => episode.id === f.checkerId).review_aggregation;
    return {
      ok: true,
      results: claim.attempts.map((attempt, index) => ({
        ok: true,
        usage: { num_turns: 1, input_tokens: 5 + index, output_tokens: 2, tokens: 7 + index },
        finalMessage: dualImportBytes({
          aggregation_id: claim.aggregation_id,
          checker_episode_id: f.checkerId,
          source_binding: claim.source_binding,
        }, attempt),
        providerIdentity: { session_id: CODEX_SESSION, model_id: attempt.model_id },
        process_streams: {
          stdout: { sha256: sha256(`collision-out-${index}`), byte_count: 1, truncated: false },
          stderr: { sha256: sha256(`collision-err-${index}`), byte_count: 0, truncated: false },
        },
      })),
    };
  }));

  assert.equal(result.action, 'checker-blocked', JSON.stringify(result));
  assert.equal(result.reason, 'dual-checker-provider-identity-collision');
  const costs = events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id);
  assert.equal(costs.length, 2);
  assert.equal(new Set(costs.map(event => event.data.process_receipt_id)).size, 2);
  assert.equal(costs.filter(event => event.data.dual_checker_failure_reason
    === 'provider-identity-collision').length, 1);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-attempt-outcome'), false);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
  assert.deepEqual(listProcessUsageReceipts({ root: f.root, runId: f.runId }), []);
});

test('headless actual-model mismatch is charged as failed process evidence and never imported', () => {
  const f = dualHostFixture();
  const sessions = [CODEX_SESSION, GROK_SESSION];
  const result = driveHeadlessRun(dualHostDependencies(f, () => {
    const state = readState(f.root, f.runId).data;
    const claim = state.episodes.find(episode => episode.id === f.checkerId).review_aggregation;
    return {
      ok: true,
      results: claim.attempts.map((attempt, index) => ({
        ok: true,
        usage: { num_turns: 1, input_tokens: 6 + index, output_tokens: 2, tokens: 8 + index },
        finalMessage: dualImportBytes({
          aggregation_id: claim.aggregation_id,
          checker_episode_id: f.checkerId,
          source_binding: claim.source_binding,
        }, attempt),
        providerIdentity: {
          session_id: sessions[index],
          model_id: index === 0 ? attempt.model_id : 'grok-untrusted-alias',
        },
        process_streams: {
          stdout: { sha256: sha256(`model-out-${index}`), byte_count: 1, truncated: false },
          stderr: { sha256: sha256(`model-err-${index}`), byte_count: 0, truncated: false },
        },
      })),
    };
  }));

  assert.equal(result.action, 'checker-blocked', JSON.stringify(result));
  assert.equal(result.reason, 'dual-checker-process-failed');
  const costs = events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id);
  assert.equal(costs.length, 2);
  assert.equal(costs.filter(event => event.data.dual_checker_failure_reason
    === 'provider-model-mismatch').length, 1);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-attempt-outcome'), false);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
});

test('headless post-process capture drift charges both measured attempts and blocks every import', () => {
  const f = dualHostFixture();
  const sessions = [CODEX_SESSION, GROK_SESSION];
  const deps = dualHostDependencies(f, () => {
    const state = readState(f.root, f.runId).data;
    const claim = state.episodes.find(episode => episode.id === f.checkerId).review_aggregation;
    return {
      ok: true,
      results: claim.attempts.map((attempt, index) => ({
        ok: true,
        usage: { num_turns: 1, input_tokens: 9 + index, output_tokens: 2, tokens: 11 + index },
        finalMessage: dualImportBytes({
          aggregation_id: claim.aggregation_id,
          checker_episode_id: f.checkerId,
          source_binding: claim.source_binding,
        }, attempt),
        providerIdentity: { session_id: sessions[index], model_id: attempt.model_id },
        process_streams: {
          stdout: { sha256: sha256(`drift-out-${index}`), byte_count: 1, truncated: false },
          stderr: { sha256: sha256(`drift-err-${index}`), byte_count: 0, truncated: false },
        },
      })),
    };
  });
  let captureVerifications = 0;
  const result = driveHeadlessRun({
    ...deps,
    verifyDualCaptureFn: () => {
      captureVerifications += 1;
      if (captureVerifications === 5) throw new Error('capture drift after both processes');
      return true;
    },
  });

  assert.equal(result.action, 'checker-blocked', JSON.stringify(result));
  assert.equal(result.reason, 'dual-checker-post-process-drift');
  const costs = events(f.root, f.runId).filter(event => event.type === 'cost'
    && event.data?.dual_checker_attempt_id);
  assert.equal(costs.length, 2);
  assert.equal(costs.every(event => event.data.dual_checker_failure_reason
    === 'post-process-identity-drift'), true);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-attempt-outcome'), false);
  assert.equal(events(f.root, f.runId).some(event => event.type === 'review-outcome'), false);
});
