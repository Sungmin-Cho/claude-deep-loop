import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBudget,
  codexCheckerClaimHash,
  makeCodexProcessReceipt,
  isMeasuredOneTurnUsage,
  makeCodexPreflightReceipt,
  recordCost,
  reconcileBudget,
  settleCodexPreflightCost,
  settleCodexProcessCost,
  settleTerminalCodexMakerCost,
  MUTATION_TURN_FLOOR,
} from '../scripts/lib/budget.mjs';
import { appendAnchored, readLines, verifyLog, verifyHead } from '../scripts/lib/integrity.mjs';
import { writeState, readState, runDir, patch } from '../scripts/lib/state.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { newWorkstream, setWorkstreamStatus } from '../scripts/lib/workspace.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { releaseLease, acquireLease } from '../scripts/lib/lease.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';

function persistLegacyContinuationFixture(root, runId, policy) {
  assert.ok(['compact-in-place', 'rotate-per-unit'].includes(policy));
  const dir = runDir(root, runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = '0.3.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  legacy.autonomy.spawn_style = 'visible';
  legacy.autonomy.continuation_policy = policy;
  legacy.autonomy.milestone_predicate = policy === 'compact-in-place'
    ? ['workstream_status_change']
    : ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached'];
  assert.deepEqual(legacy.episodes, [], 'legacy floor fixture has no episode locators');
  for (const session of legacy.session_chain.sessions) {
    delete session.scope;
    assert.equal(session.handoff_rel, undefined, 'legacy floor fixture has no v0.4 handoff locator');
  }
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
}

function floorRun({ continuationPolicy = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-floor-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  if (continuationPolicy) persistLegacyContinuationFixture(root, runId, continuationPolicy);
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}
function ownerSessionTurns(root, runId) {
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  return (data.session_chain.sessions.find(s => s.run_id === owner) || {}).turns || 0;
}
function mk(root, runId, fence, n) {   // n distinct maker episodes (each a business mutation → floor)
  for (let i = 0; i < n; i++) newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'k', point: 'implementation', fence });
}

// 자기완결 minimal valid loop (cross-task import 없음)
function minimalLoop(root, runId) {
  return {
    schema_version: '0.4.0', run_id: runId, goal: 'g', status: 'running',
    project: { root, binding_generation: 1 }, routing: { protocol: 'standalone' }, review: {}, autonomy: { tier: 'act-gated', spawn_style: 'interactive', continuation_policy: 'rotate-per-unit', attended_launch_approval: null },
    budget: { unit: 'turns', total: 100, spent: 0, tokens_total: 1000, tokens_spent: 0, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0, max_wallclock_sec: 3600, enforcement: 'best-effort-interactive', on_unmeasurable_usage: 'fail-closed' },
    comprehension: {}, circuit_breaker: {}, session_chain: { lease: { state: 'active', handoff_phase: 'idle', handoff_trigger: null, takeover_kind: null }, consumed_milestones: [], sessions: [] },
    workstreams: [], active_workstreams: [], triage: {}, episodes: [], termination: {},
  };
}
function seedRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(runDir(root, 'R'), { recursive: true });
  writeState(root, 'R', minimalLoop(root, 'R'));
  return root;
}

const base = () => ({
  budget: { unit: 'turns', total: 100, spent: 0, tokens_total: 1000, tokens_spent: 0,
    max_wallclock_sec: 3600, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0,
    enforcement: 'best-effort-interactive', on_unmeasurable_usage: 'fail-closed' },
  autonomy: { tier: 'act-gated' },
});

test('under budget → ok', () => {
  const l = base(); l.budget.spent = 10;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).ok, true);
});
test('hard stop on turns → not ok', () => {
  const l = base(); l.budget.spent = 100;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).ok, false);
});
test('hard stop on wallclock → not ok', () => {
  const l = base(); l.budget.spent = 1;
  assert.equal(checkBudget(l, { now: 3601_000, sessionStart: 0 }).ok, false);
});
test('soft stop demotes tier', () => {
  const l = base(); l.budget.spent = 85;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).tier_after, 'recommend');
});
test('headless unmeasurable → fail-closed', () => {
  const l = base(); l.budget.enforcement = 'hard'; l.budget.spent = 1;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0, measurable: false }).ok, false);
});

test('isMeasuredOneTurnUsage accepts only an exact safe Codex one-turn measurement', () => {
  assert.equal(isMeasuredOneTurnUsage({
    num_turns: 1,
    tokens: 12,
    input_tokens: 5,
    output_tokens: 7,
    cached_input_tokens: 2,
    reasoning_output_tokens: 3,
  }), true);
  assert.equal(isMeasuredOneTurnUsage({
    num_turns: 1,
    tokens: 12,
    input_tokens: 5,
    output_tokens: 7,
  }), true);

  const invalid = [
    null,
    {},
    { num_turns: 2, tokens: 12, input_tokens: 5, output_tokens: 7 },
    { num_turns: 1, tokens: 11, input_tokens: 5, output_tokens: 7 },
    { num_turns: 1, tokens: -1, input_tokens: 0, output_tokens: 0 },
    { num_turns: 1, tokens: 1.5, input_tokens: 1, output_tokens: 0.5 },
    { num_turns: 1, tokens: Number.MAX_SAFE_INTEGER + 1, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { num_turns: 1, tokens: 1, input_tokens: 1 },
    { num_turns: 1, tokens: 1, output_tokens: 1 },
    { num_turns: 1, tokens: 2, input_tokens: 1, output_tokens: 1, cached_input_tokens: -1 },
    { num_turns: 1, tokens: 2, input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0.5 },
  ];
  for (const usage of invalid) assert.equal(isMeasuredOneTurnUsage(usage), false, JSON.stringify(usage));
});

function preflightReceiptFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dl-preflight-receipt-'));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', now: new Date('2026-07-12T00:00:00Z'),
  });
  const fence = { owner: runId, generation: 1, intent: 'accounting' };
  const cacheKey = 'a'.repeat(64);
  const attemptId = 'b'.repeat(32);
  const read = makeCodexPreflightReceipt({
    root, runId, cacheKey, smokeKind: 'read', attemptId,
    predecessorReceiptId: null, owner: runId, generation: 1,
    usage: { num_turns: 1, input_tokens: 2, output_tokens: 3, tokens: 5 },
  });
  const write = makeCodexPreflightReceipt({
    root, runId, cacheKey, smokeKind: 'write', attemptId,
    predecessorReceiptId: read.receipt_id, owner: runId, generation: 1,
    usage: { num_turns: 1, input_tokens: 5, output_tokens: 7, tokens: 12 },
  });
  return { root, runId, fence, read, write };
}

test('Codex preflight receipts settle read/write exactly once and survive a later valid lease', () => {
  const fixture = preflightReceiptFixture();
  assert.deepEqual(settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read, fence: fixture.fence,
  }), { ok: true, recorded: true, reason: 'recorded' });
  assert.deepEqual(settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.write, fence: fixture.fence,
  }), { ok: true, recorded: true, reason: 'recorded' });

  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const beforeState = readFileSync(statePath, 'utf8');
  const beforeLog = readFileSync(logPath, 'utf8');
  releaseLease(fixture.root, fixture.runId, { owner: fixture.runId, generation: 1 });
  assert.equal(acquireLease(fixture.root, fixture.runId, {
    owner: 'RECOVERY-OWNER', expectGeneration: 1, runtime: 'codex',
    now: Date.parse('2026-07-12T00:01:00Z'),
  }).ok, true);
  const recoveryFence = { owner: 'RECOVERY-OWNER', generation: 2, intent: 'accounting' };
  const afterLeaseState = readFileSync(statePath, 'utf8');
  const afterLeaseLog = readFileSync(logPath, 'utf8');

  assert.deepEqual(settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read, fence: recoveryFence,
  }), { ok: true, recorded: false, reason: 'already-recorded' });
  assert.deepEqual(settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.write, fence: recoveryFence,
  }), { ok: true, recorded: false, reason: 'already-recorded' });
  assert.equal(readFileSync(statePath, 'utf8'), afterLeaseState, 'exact retries must not rewrite state');
  assert.equal(readFileSync(logPath, 'utf8'), afterLeaseLog, 'exact retries must not append events');
  assert.notEqual(afterLeaseState, beforeState, 'the fixture must really advance the lease');
  assert.equal(afterLeaseLog, beforeLog, 'lease-only transitions do not append cost receipts');

  const costs = readLines(fixture.root, fixture.runId).filter(
    event => event.type === 'cost' && event.data?.source === 'codex-preflight-measured',
  );
  assert.deepEqual(costs.map(event => event.data.reported_tokens), [5, 12]);
  assert.deepEqual(costs.map(event => event.data.preflight_smoke), ['read', 'write']);
  assert.equal(new Set(costs.map(event => event.data.preflight_receipt_id)).size, 2);
  assert.equal(readState(fixture.root, fixture.runId).data.budget.tokens_spent, 17);
});

test('Codex preflight receipt validation rejects altered usage and write-before-read without writes', () => {
  const mismatch = preflightReceiptFixture();
  const mismatchState = join(runDir(mismatch.root, mismatch.runId), 'loop.json');
  const stateBefore = readFileSync(mismatchState, 'utf8');
  assert.throws(() => settleCodexPreflightCost(mismatch.root, mismatch.runId, {
    receipt: { ...mismatch.read, usage: { ...mismatch.read.usage, output_tokens: 4, tokens: 6 } },
    fence: mismatch.fence,
  }), /PREFLIGHT_ACCOUNTING_RECEIPT_INVALID/);
  assert.equal(readFileSync(mismatchState, 'utf8'), stateBefore);
  assert.deepEqual(readLines(mismatch.root, mismatch.runId), []);

  const predecessor = preflightReceiptFixture();
  assert.throws(() => settleCodexPreflightCost(predecessor.root, predecessor.runId, {
    receipt: predecessor.write, fence: predecessor.fence,
  }), /PREFLIGHT_ACCOUNTING_PREDECESSOR_MISSING/);
  assert.equal(readLines(predecessor.root, predecessor.runId).filter(
    event => event.data?.preflight_receipt_id,
  ).length, 0);
});

test('Codex preflight settlement rejects a conflicting or duplicated durable receipt event', () => {
  const conflict = preflightReceiptFixture();
  appendAnchored(conflict.root, conflict.runId, {
    type: 'cost',
    data: {
      turns: 1,
      tokens: 6,
      reported_turns: 1,
      reported_tokens: 6,
      input_tokens: 2,
      output_tokens: 4,
      owner: conflict.read.owner,
      generation: conflict.read.generation,
      source: 'codex-preflight-measured',
      preflight_receipt_id: conflict.read.receipt_id,
      preflight_cache_key: conflict.read.cache_key,
      preflight_smoke: 'read',
      preflight_attempt_id: conflict.read.attempt_id,
      predecessor_receipt_id: null,
    },
  });
  assert.throws(() => settleCodexPreflightCost(conflict.root, conflict.runId, {
    receipt: conflict.read, fence: conflict.fence,
  }), /PREFLIGHT_ACCOUNTING_MISMATCH/);

  const duplicate = preflightReceiptFixture();
  settleCodexPreflightCost(duplicate.root, duplicate.runId, {
    receipt: duplicate.read, fence: duplicate.fence,
  });
  const exactData = structuredClone(readLines(duplicate.root, duplicate.runId).find(
    event => event.data?.preflight_receipt_id === duplicate.read.receipt_id,
  ).data);
  appendAnchored(duplicate.root, duplicate.runId, { type: 'cost', data: exactData });
  const statePath = join(runDir(duplicate.root, duplicate.runId), 'loop.json');
  const logPath = join(runDir(duplicate.root, duplicate.runId), 'event-log.jsonl');
  const stateBefore = readFileSync(statePath, 'utf8');
  const logBefore = readFileSync(logPath, 'utf8');
  assert.throws(() => settleCodexPreflightCost(duplicate.root, duplicate.runId, {
    receipt: duplicate.read, fence: duplicate.fence,
  }), /PREFLIGHT_ACCOUNTING_DUPLICATE/);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(readFileSync(logPath, 'utf8'), logBefore);
});

test('Codex preflight read/write receipts preserve the existing per-session max-rule', () => {
  const fixture = preflightReceiptFixture();
  newEpisode(fixture.root, fixture.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'k', point: 'implementation',
    fence: { ...fixture.fence, intent: 'business' },
  });
  settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read, fence: fixture.fence,
  });
  settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.write, fence: fixture.fence,
  });
  const state = readState(fixture.root, fixture.runId).data;
  assert.equal(state.budget.spent, 2, 'read absorbs the existing one-turn floor; write adds one turn');
  assert.equal(state.budget.tokens_spent, 17);
  assert.equal(state.session_chain.sessions.find(session => session.run_id === fixture.runId).turns, 2);
  assert.doesNotThrow(() => reconcileBudget(fixture.root, fixture.runId));
});

test('an exact recorded preflight receipt remains a write-free no-op under its current terminal fence', () => {
  const fixture = preflightReceiptFixture();
  settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read,
    fence: fixture.fence,
  });
  finishRun(fixture.root, fixture.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'terminal preflight receipt cleanup fixture' },
    fence: { owner: fixture.runId, generation: 1, intent: 'business' },
    now: Date.parse('2026-07-12T00:04:00.000Z'),
  });
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBefore = readFileSync(statePath, 'utf8');
  const logBefore = readFileSync(logPath, 'utf8');
  assert.deepEqual(settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read,
    fence: fixture.fence,
  }), { ok: true, recorded: false, reason: 'already-recorded' });
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(readFileSync(logPath, 'utf8'), logBefore);
  assert.throws(() => settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read,
    fence: { owner: 'WRONG', generation: 1, intent: 'accounting' },
  }), /LEASE_FENCED: owner-mismatch/);
  assert.throws(() => settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read,
    fence: { owner: fixture.runId, generation: 2, intent: 'accounting' },
  }), /LEASE_FENCED: generation-mismatch/);
});

test('terminal preflight retry still rejects a missing or mismatched receipt event', () => {
  const missing = preflightReceiptFixture();
  settleCodexPreflightCost(missing.root, missing.runId, {
    receipt: missing.read,
    fence: missing.fence,
  });
  finishRun(missing.root, missing.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'missing terminal receipt fixture' },
    fence: { owner: missing.runId, generation: 1, intent: 'business' },
    now: Date.parse('2026-07-12T00:04:00.000Z'),
  });
  assert.throws(() => settleCodexPreflightCost(missing.root, missing.runId, {
    receipt: missing.write,
    fence: missing.fence,
  }), /LEASE_FENCED: RUN_TERMINAL/);

  const mismatch = preflightReceiptFixture();
  appendAnchored(mismatch.root, mismatch.runId, {
    type: 'cost',
    data: {
      turns: 1,
      tokens: mismatch.read.usage.tokens,
      reported_turns: mismatch.read.usage.num_turns,
      reported_tokens: mismatch.read.usage.tokens,
      input_tokens: mismatch.read.usage.input_tokens,
      output_tokens: mismatch.read.usage.output_tokens,
      owner: mismatch.read.owner,
      generation: mismatch.read.generation,
      source: 'forged-preflight-source',
      preflight_receipt_id: mismatch.read.receipt_id,
      preflight_cache_key: mismatch.read.cache_key,
      preflight_smoke: mismatch.read.smoke_kind,
      preflight_attempt_id: mismatch.read.attempt_id,
      predecessor_receipt_id: null,
    },
  });
  finishRun(mismatch.root, mismatch.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'mismatched terminal receipt fixture' },
    fence: { owner: mismatch.runId, generation: 1, intent: 'business' },
    now: Date.parse('2026-07-12T00:04:00.000Z'),
  });
  assert.throws(() => settleCodexPreflightCost(mismatch.root, mismatch.runId, {
    receipt: mismatch.read,
    fence: mismatch.fence,
  }), /PREFLIGHT_ACCOUNTING_MISMATCH/);
});

test('preflight receipt idempotency rejects semantic event-data extras', () => {
  const fixture = preflightReceiptFixture();
  appendAnchored(fixture.root, fixture.runId, {
    type: 'cost',
    data: {
      turns: fixture.read.usage.num_turns,
      tokens: fixture.read.usage.tokens,
      reported_turns: fixture.read.usage.num_turns,
      reported_tokens: fixture.read.usage.tokens,
      input_tokens: fixture.read.usage.input_tokens,
      output_tokens: fixture.read.usage.output_tokens,
      owner: fixture.read.owner,
      generation: fixture.read.generation,
      source: 'codex-preflight-measured',
      preflight_receipt_id: fixture.read.receipt_id,
      preflight_cache_key: fixture.read.cache_key,
      preflight_smoke: fixture.read.smoke_kind,
      preflight_attempt_id: fixture.read.attempt_id,
      predecessor_receipt_id: null,
      auto_floor: true,
      for: 'smuggled-preflight-floor',
    },
  });
  assert.throws(() => settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read,
    fence: fixture.fence,
  }), /PREFLIGHT_ACCOUNTING_MISMATCH/);
});

test('preflight process identity rejects a second rehashed receipt with altered usage', () => {
  const fixture = preflightReceiptFixture();
  settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read,
    fence: fixture.fence,
  });
  const altered = makeCodexPreflightReceipt({
    root: fixture.root,
    runId: fixture.runId,
    cacheKey: fixture.read.cache_key,
    smokeKind: fixture.read.smoke_kind,
    attemptId: fixture.read.attempt_id,
    predecessorReceiptId: fixture.read.predecessor_receipt_id,
    owner: fixture.read.owner,
    generation: fixture.read.generation,
    usage: { num_turns: 1, input_tokens: 2, output_tokens: 4, tokens: 6 },
  });
  assert.notEqual(altered.receipt_id, fixture.read.receipt_id);
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBefore = readFileSync(statePath, 'utf8');
  const logBefore = readFileSync(logPath, 'utf8');
  assert.throws(() => settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: altered,
    fence: fixture.fence,
  }), /PREFLIGHT_ACCOUNTING_MISMATCH/);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(readFileSync(logPath, 'utf8'), logBefore);
});

test('an exact preflight write receipt still requires its unique read predecessor', () => {
  const fixture = preflightReceiptFixture();
  appendAnchored(fixture.root, fixture.runId, {
    type: 'cost',
    data: {
      turns: fixture.write.usage.num_turns,
      tokens: fixture.write.usage.tokens,
      reported_turns: fixture.write.usage.num_turns,
      reported_tokens: fixture.write.usage.tokens,
      input_tokens: fixture.write.usage.input_tokens,
      output_tokens: fixture.write.usage.output_tokens,
      owner: fixture.write.owner,
      generation: fixture.write.generation,
      source: 'codex-preflight-measured',
      preflight_receipt_id: fixture.write.receipt_id,
      preflight_cache_key: fixture.write.cache_key,
      preflight_smoke: fixture.write.smoke_kind,
      preflight_attempt_id: fixture.write.attempt_id,
      predecessor_receipt_id: fixture.write.predecessor_receipt_id,
    },
  });
  assert.throws(() => settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.write,
    fence: fixture.fence,
  }), /PREFLIGHT_ACCOUNTING_PREDECESSOR_MISSING/);
});

test('a preflight write rejects multiple read receipts for the same raw-journal attempt', () => {
  const fixture = preflightReceiptFixture();
  settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.read,
    fence: fixture.fence,
  });
  const conflictingRead = makeCodexPreflightReceipt({
    root: fixture.root,
    runId: fixture.runId,
    cacheKey: fixture.read.cache_key,
    smokeKind: 'read',
    attemptId: fixture.read.attempt_id,
    predecessorReceiptId: null,
    owner: fixture.read.owner,
    generation: fixture.read.generation,
    usage: { num_turns: 1, input_tokens: 2, output_tokens: 4, tokens: 6 },
  });
  appendAnchored(fixture.root, fixture.runId, {
    type: 'cost',
    data: {
      turns: conflictingRead.usage.num_turns,
      tokens: conflictingRead.usage.tokens,
      reported_turns: conflictingRead.usage.num_turns,
      reported_tokens: conflictingRead.usage.tokens,
      input_tokens: conflictingRead.usage.input_tokens,
      output_tokens: conflictingRead.usage.output_tokens,
      owner: conflictingRead.owner,
      generation: conflictingRead.generation,
      source: 'codex-preflight-measured',
      preflight_receipt_id: conflictingRead.receipt_id,
      preflight_cache_key: conflictingRead.cache_key,
      preflight_smoke: conflictingRead.smoke_kind,
      preflight_attempt_id: conflictingRead.attempt_id,
      predecessor_receipt_id: null,
    },
  });
  assert.throws(() => settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt: fixture.write,
    fence: fixture.fence,
  }), /PREFLIGHT_ACCOUNTING_DUPLICATE/);
});

test('an exact preflight receipt still requires a durable origin session', () => {
  const fixture = preflightReceiptFixture();
  const receipt = makeCodexPreflightReceipt({
    root: fixture.root,
    runId: fixture.runId,
    cacheKey: fixture.read.cache_key,
    smokeKind: 'read',
    attemptId: 'c'.repeat(32),
    predecessorReceiptId: null,
    owner: 'MISSING-ORIGIN',
    generation: 1,
    usage: fixture.read.usage,
  });
  appendAnchored(fixture.root, fixture.runId, {
    type: 'cost',
    data: {
      turns: receipt.usage.num_turns,
      tokens: receipt.usage.tokens,
      reported_turns: receipt.usage.num_turns,
      reported_tokens: receipt.usage.tokens,
      input_tokens: receipt.usage.input_tokens,
      output_tokens: receipt.usage.output_tokens,
      owner: receipt.owner,
      generation: receipt.generation,
      source: 'codex-preflight-measured',
      preflight_receipt_id: receipt.receipt_id,
      preflight_cache_key: receipt.cache_key,
      preflight_smoke: receipt.smoke_kind,
      preflight_attempt_id: receipt.attempt_id,
      predecessor_receipt_id: null,
    },
  });
  assert.throws(() => settleCodexPreflightCost(fixture.root, fixture.runId, {
    receipt,
    fence: fixture.fence,
  }), /PREFLIGHT_ACCOUNTING_ORIGIN_INVALID/);
});

function makerProcessReceiptFixture({ acquire = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-maker-process-receipt-'));
  const now = Date.parse('2026-07-12T00:00:00.000Z');
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', now: new Date(now) });
  migrateAuthenticLegacyTransport(root, runId);
  const handoff = emitHandoff(root, runId, {
    trigger: 'maker-process-receipt',
    headless: true,
    resumePolicy: 'headless',
    expect: { owner: runId, generation: 1 },
    now: now + 1_000,
  });
  assert.equal(handoff.ok, true);
  if (acquire) {
    assert.equal(acquireLease(root, runId, {
      owner: handoff.childRunId,
      expectGeneration: 1,
      runtime: 'codex',
      now: now + 2_000,
    }).ok, true);
  }
  const receipt = makeCodexProcessReceipt({
    root,
    runId,
    processKind: 'maker',
    context: {
      parent_owner: runId,
      parent_generation: 1,
      child_run_id: handoff.childRunId,
      child_generation: 2,
      handoff_key: handoff.key,
      handoff_rel: handoff.handoffRel,
    },
    usage: { num_turns: 1, input_tokens: 2, output_tokens: 3, tokens: 5 },
  });
  const fence = acquire
    ? { owner: handoff.childRunId, generation: 2, intent: 'accounting' }
    : { owner: runId, generation: 1, intent: 'accounting' };
  return { root, runId, handoff, receipt, fence };
}

test('maker process receipts derive parent versus acquired-child origin and retry as an exact no-op', () => {
  for (const acquire of [false, true]) {
    const fixture = makerProcessReceiptFixture({ acquire });
    assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
      receipt: fixture.receipt,
      fence: fixture.fence,
    }), { ok: true, recorded: true, reason: 'recorded' });
    const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
    const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
    const stateBeforeRetry = readFileSync(statePath, 'utf8');
    const logBeforeRetry = readFileSync(logPath, 'utf8');
    assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
      receipt: fixture.receipt,
      fence: fixture.fence,
    }), { ok: true, recorded: false, reason: 'already-recorded' });
    assert.equal(readFileSync(statePath, 'utf8'), stateBeforeRetry);
    assert.equal(readFileSync(logPath, 'utf8'), logBeforeRetry);

    const cost = readLines(fixture.root, fixture.runId).find(
      event => event.data?.process_receipt_id === fixture.receipt.receipt_id,
    );
    const expectedOwner = acquire ? fixture.handoff.childRunId : fixture.runId;
    assert.equal(cost.data.owner, expectedOwner);
    assert.equal(cost.data.generation, acquire ? 2 : 1);
    assert.equal(cost.data.reported_tokens, 5);
    assert.equal(readState(fixture.root, fixture.runId).data.session_chain.sessions.find(
      session => session.run_id === expectedOwner,
    ).turns >= 1, true);
    assert.doesNotThrow(() => reconcileBudget(fixture.root, fixture.runId));
  }
});

test('maker process receipt retry remains an exact no-op after late acquisition', () => {
  const fixture = makerProcessReceiptFixture();
  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), { ok: true, recorded: true, reason: 'recorded' });
  const initialProcessCosts = readLines(fixture.root, fixture.runId).filter(
    event => event.data?.process_receipt_id === fixture.receipt.receipt_id,
  );
  assert.equal(initialProcessCosts.length, 1);
  assert.equal(initialProcessCosts[0].data.owner, fixture.runId);
  assert.equal(initialProcessCosts[0].data.generation, 1);

  assert.equal(acquireLease(fixture.root, fixture.runId, {
    owner: fixture.handoff.childRunId,
    expectGeneration: 1,
    runtime: 'codex',
    now: Date.parse(initialProcessCosts[0].ts) + 1,
  }).ok, true);
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBeforeRetry = readFileSync(statePath, 'utf8');
  const logBeforeRetry = readFileSync(logPath, 'utf8');
  const currentFence = {
    owner: fixture.handoff.childRunId,
    generation: 2,
    intent: 'accounting',
  };

  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: currentFence,
  }), { ok: true, recorded: false, reason: 'already-recorded' });
  assert.equal(readFileSync(statePath, 'utf8'), stateBeforeRetry);
  assert.equal(readFileSync(logPath, 'utf8'), logBeforeRetry);
  const processCosts = readLines(fixture.root, fixture.runId).filter(
    event => event.data?.process_receipt_id === fixture.receipt.receipt_id,
  );
  assert.equal(processCosts.length, 1);
  assert.equal(processCosts[0].data.owner, fixture.runId);
  assert.equal(processCosts[0].data.generation, 1);
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), /LEASE_FENCED: owner-mismatch/);
});

test('maker process receipt retry remains exact after a backdated late acquisition', () => {
  const fixture = makerProcessReceiptFixture();
  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), { ok: true, recorded: true, reason: 'recorded' });
  const processCost = readLines(fixture.root, fixture.runId).find(
    event => event.data?.process_receipt_id === fixture.receipt.receipt_id,
  );
  assert.equal(processCost.data.owner, fixture.runId);
  assert.equal(acquireLease(fixture.root, fixture.runId, {
    owner: fixture.handoff.childRunId,
    expectGeneration: 1,
    runtime: 'codex',
    now: Date.parse(processCost.ts) - 60_000,
  }).ok, true);
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBeforeRetry = readFileSync(statePath, 'utf8');
  const logBeforeRetry = readFileSync(logPath, 'utf8');

  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: {
      owner: fixture.handoff.childRunId,
      generation: 2,
      intent: 'accounting',
    },
  }), { ok: true, recorded: false, reason: 'already-recorded' });
  assert.equal(readFileSync(statePath, 'utf8'), stateBeforeRetry);
  assert.equal(readFileSync(logPath, 'utf8'), logBeforeRetry);
  assert.equal(readLines(fixture.root, fixture.runId).filter(
    event => event.data?.process_receipt_id === fixture.receipt.receipt_id,
  ).length, 1);
});

test('an acquired maker process receipt has only the existing handoff-and-finish-bound terminal carve-out', () => {
  const fixture = makerProcessReceiptFixture({ acquire: true });
  finishRun(fixture.root, fixture.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'generic terminal process receipt fixture' },
    fence: { owner: fixture.handoff.childRunId, generation: 2, intent: 'business' },
    now: Date.parse('2026-07-12T00:03:00.000Z'),
  });
  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), { ok: true, recorded: true, reason: 'recorded' });
  const state = readState(fixture.root, fixture.runId).data;
  assert.equal(state.status, 'stopped');
  const event = readLines(fixture.root, fixture.runId).find(
    item => item.data?.process_receipt_id === fixture.receipt.receipt_id,
  );
  assert.equal(event.data.terminal_process, 'codex-maker');
  assert.equal(event.data.turns, 0, 'the terminal receipt absorbs the kernel finish floor');
  assert.equal(state.session_chain.sessions.find(
    session => session.run_id === fixture.handoff.childRunId,
  ).turns, 1);
  assert.doesNotThrow(() => reconcileBudget(fixture.root, fixture.runId));
});

function appendExactishMakerReceiptEvent(fixture, {
  owner,
  generation,
  turns = 1,
  tokens = 5,
  processContext = fixture.receipt.context,
  extraData = {},
} = {}) {
  appendAnchored(fixture.root, fixture.runId, {
    type: 'cost',
    data: {
      turns,
      tokens,
      reported_turns: fixture.receipt.usage.num_turns,
      reported_tokens: fixture.receipt.usage.tokens,
      input_tokens: fixture.receipt.usage.input_tokens,
      output_tokens: fixture.receipt.usage.output_tokens,
      owner,
      generation,
      source: 'codex-maker-measured',
      process_receipt_id: fixture.receipt.receipt_id,
      process_kind: 'maker',
      process_context: processContext,
      ...extraData,
    },
  });
}

test('acquired maker idempotency rejects a pre-existing receipt event charged to the parent', () => {
  const fixture = makerProcessReceiptFixture({ acquire: true });
  appendExactishMakerReceiptEvent(fixture, {
    owner: fixture.runId,
    generation: 1,
  });
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), /PROCESS_ACCOUNTING_MISMATCH/);
});

test('process receipt idempotency rejects wrong adjusted turns and tokens for the derived origin', () => {
  const fixture = makerProcessReceiptFixture({ acquire: true });
  newEpisode(fixture.root, fixture.runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'fixture-floor',
    point: 'implementation',
    fence: { owner: fixture.handoff.childRunId, generation: 2, intent: 'business' },
  });
  appendExactishMakerReceiptEvent(fixture, {
    owner: fixture.handoff.childRunId,
    generation: 2,
    turns: 1,
    tokens: 4,
  });
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), /PROCESS_ACCOUNTING_MISMATCH/);
});

test('process receipt idempotency rejects a normalized context with an extra property', () => {
  const fixture = makerProcessReceiptFixture();
  appendExactishMakerReceiptEvent(fixture, {
    owner: fixture.runId,
    generation: 1,
    processContext: { ...fixture.receipt.context, ignored_extra: true },
  });
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), /PROCESS_ACCOUNTING_MISMATCH/);
});

test('process receipt idempotency rejects semantic event-data extras', () => {
  const fixture = makerProcessReceiptFixture();
  appendExactishMakerReceiptEvent(fixture, {
    owner: fixture.runId,
    generation: 1,
    extraData: { auto_floor: true, for: 'smuggled-process-floor' },
  });
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), /PROCESS_ACCOUNTING_MISMATCH/);
});

test('maker process identity rejects a second rehashed receipt with altered usage', () => {
  const fixture = makerProcessReceiptFixture();
  settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  });
  const altered = makeCodexProcessReceipt({
    root: fixture.root,
    runId: fixture.runId,
    processKind: fixture.receipt.process_kind,
    context: fixture.receipt.context,
    usage: { num_turns: 1, input_tokens: 2, output_tokens: 4, tokens: 6 },
  });
  assert.notEqual(altered.receipt_id, fixture.receipt.receipt_id);
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBefore = readFileSync(statePath, 'utf8');
  const logBefore = readFileSync(logPath, 'utf8');
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: altered,
    fence: fixture.fence,
  }), /PROCESS_ACCOUNTING_MISMATCH/);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(readFileSync(logPath, 'utf8'), logBefore);
});

test('maker process receipt alteration, mismatched events, and duplicate events fail closed', () => {
  for (const mutate of [
    receipt => { receipt.context.handoff_key = 'f'.repeat(16); },
    receipt => { receipt.usage.output_tokens += 1; receipt.usage.tokens += 1; },
  ]) {
    const fixture = makerProcessReceiptFixture();
    const altered = structuredClone(fixture.receipt);
    mutate(altered);
    const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
    const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
    const beforeState = readFileSync(statePath, 'utf8');
    const beforeLog = readFileSync(logPath, 'utf8');
    assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
      receipt: altered,
      fence: fixture.fence,
    }), /PROCESS_ACCOUNTING_RECEIPT_INVALID/);
    assert.equal(readFileSync(statePath, 'utf8'), beforeState);
    assert.equal(readFileSync(logPath, 'utf8'), beforeLog);
  }

  const mismatch = makerProcessReceiptFixture();
  appendAnchored(mismatch.root, mismatch.runId, {
    type: 'cost',
    data: {
      turns: 1,
      tokens: 5,
      reported_turns: 1,
      reported_tokens: 5,
      input_tokens: 2,
      output_tokens: 3,
      owner: mismatch.runId,
      generation: 1,
      source: 'forged',
      process_receipt_id: mismatch.receipt.receipt_id,
      process_kind: 'maker',
      process_context: mismatch.receipt.context,
    },
  });
  assert.throws(() => settleCodexProcessCost(mismatch.root, mismatch.runId, {
    receipt: mismatch.receipt,
    fence: mismatch.fence,
  }), /PROCESS_ACCOUNTING_MISMATCH/);

  const duplicate = makerProcessReceiptFixture();
  settleCodexProcessCost(duplicate.root, duplicate.runId, {
    receipt: duplicate.receipt,
    fence: duplicate.fence,
  });
  const exactData = structuredClone(readLines(duplicate.root, duplicate.runId).find(
    event => event.data?.process_receipt_id === duplicate.receipt.receipt_id,
  ).data);
  appendAnchored(duplicate.root, duplicate.runId, { type: 'cost', data: exactData });
  assert.throws(() => settleCodexProcessCost(duplicate.root, duplicate.runId, {
    receipt: duplicate.receipt,
    fence: duplicate.fence,
  }), /PROCESS_ACCOUNTING_DUPLICATE/);
});

function checkerProcessReceiptFixture({ originOwner, originGeneration } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-checker-process-origin-'));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', now: new Date('2026-07-12T00:00:00Z'),
  });
  migrateAuthenticLegacyTransport(root, runId);
  const claim = {
    run_id: runId,
    reviewer_id: 'deep-review',
    checker_episode_id: 'checker-1',
    target_maker: 'maker-1',
    attempt_id: 'attempt-1',
    workstream_id: 'ws-1',
    point: 'implementation',
    project_root: readState(root, runId).data.project.root,
    runtime: 'codex',
    lease_owner: runId,
    lease_generation: 1,
    artifacts: [],
  };
  const { data } = readState(root, runId);
  data.episodes.push({
    id: claim.checker_episode_id,
    role: 'checker',
    status: 'in_progress',
    request_rel: `episodes/${claim.checker_episode_id}/request.md`,
    attempt_id: claim.attempt_id,
    target_maker: claim.target_maker,
    review_claim: claim,
  });
  data.session_chain.sessions.push({
    run_id: 'OTHER-SESSION',
    started_at: '2026-07-12T00:00:01.000Z',
    ended_at: null,
    turns: 0,
    outcome: null,
    superseded_by: null,
    scope: {
      kind: 'workstream', workstream_id: null, bound_at_seq: null,
      terminal_event: null, closed_at: null, superseded_at: null,
    },
  });
  writeState(root, runId, data);
  const receipt = makeCodexProcessReceipt({
    root,
    runId,
    processKind: 'checker',
    context: {
      origin_owner: originOwner ?? claim.lease_owner,
      origin_generation: originGeneration ?? claim.lease_generation,
      checker_episode_id: claim.checker_episode_id,
      attempt_id: claim.attempt_id,
      target_maker: claim.target_maker,
      claim_hash: codexCheckerClaimHash(claim),
    },
    usage: { num_turns: 1, input_tokens: 2, output_tokens: 3, tokens: 5 },
  });
  return {
    root,
    runId,
    claim,
    receipt,
    fence: { owner: runId, generation: 1, intent: 'accounting' },
  };
}

function checkerClaimEventData(claim) {
  return {
    episode_id: claim.checker_episode_id,
    attempt_id: claim.attempt_id,
    reviewer_id: claim.reviewer_id,
    target_maker: claim.target_maker,
    workstream_id: claim.workstream_id,
    point: claim.point,
    artifacts: claim.artifacts,
  };
}

function appendCheckerClaimEvent(fixture, overrides = {}) {
  appendAnchored(fixture.root, fixture.runId, {
    type: 'independent-review-claimed',
    data: { ...checkerClaimEventData(fixture.claim), ...overrides },
  });
}

function stopPreImportCheckerFixture({ claimEvents = 1, originOwner, originGeneration } = {}) {
  const fixture = checkerProcessReceiptFixture({ originOwner, originGeneration });
  for (let i = 0; i < claimEvents; i += 1) appendCheckerClaimEvent(fixture);
  finishRun(fixture.root, fixture.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'stopped pre-import checker fixture' },
    fence: { owner: fixture.runId, generation: 1, intent: 'business' },
    now: Date.parse('2026-07-12T00:03:00.000Z'),
  });
  return fixture;
}

function setManualTerminal(fixture, {
  status = 'stopped',
  finishFloor = 'correct',
  postFinishEvent = null,
  claimAfterFinish = false,
} = {}) {
  appendAnchored(fixture.root, fixture.runId, {
    type: 'finish',
    data: { status, reportRel: null },
  }, undefined, undefined, finishFloor === 'correct' ? { floor: MUTATION_TURN_FLOOR } : {});
  if (finishFloor === 'wrong') {
    appendAnchored(fixture.root, fixture.runId, {
      type: 'cost',
      data: {
        turns: MUTATION_TURN_FLOOR,
        tokens: 0,
        auto_floor: true,
        for: 'finish',
        owner: 'OTHER-SESSION',
        generation: 1,
      },
    });
  }
  if (claimAfterFinish) appendCheckerClaimEvent(fixture);
  if (postFinishEvent) appendAnchored(fixture.root, fixture.runId, postFinishEvent);
  const { data } = readState(fixture.root, fixture.runId);
  data.status = status;
  data.termination.finished_at = '2026-07-12T00:03:00.000Z';
  if (finishFloor === 'wrong') {
    data.budget.spent += MUTATION_TURN_FLOOR;
    data.session_chain.sessions.find(session => session.run_id === 'OTHER-SESSION').turns += MUTATION_TURN_FLOOR;
  }
  writeState(fixture.root, fixture.runId, data);
  return fixture;
}

function assertProcessSettlementRejectsWithoutWrites(fixture, error, fence = fixture.fence) {
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBefore = readFileSync(statePath, 'utf8');
  const logBefore = readFileSync(logPath, 'utf8');
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence,
  }), error);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(readFileSync(logPath, 'utf8'), logBefore);
}

test('checker process receipt origin must equal the immutable review claim lease', () => {
  const fixture = checkerProcessReceiptFixture({
    originOwner: 'OTHER-SESSION',
    originGeneration: 2,
  });
  const { root, runId, receipt } = fixture;
  const statePath = join(runDir(root, runId), 'loop.json');
  const stateBefore = readFileSync(statePath, 'utf8');
  const logBefore = readLines(root, runId);
  assert.throws(() => settleCodexProcessCost(root, runId, {
    receipt,
    fence: fixture.fence,
  }), /PROCESS_ACCOUNTING_CONTEXT_MISMATCH/);
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.deepEqual(readLines(root, runId), logBefore);
});

test('stopped pre-import checker settlement rejects malformed claim, attempt, target, and origin', () => {
  for (const [label, fixture, mutate] of [
    ['claim', stopPreImportCheckerFixture(), checker => { checker.review_claim.point = 'changed'; }],
    ['attempt', stopPreImportCheckerFixture(), checker => { checker.attempt_id = 'attempt-other'; }],
    ['target', stopPreImportCheckerFixture(), checker => { checker.target_maker = 'maker-other'; }],
    ['origin', stopPreImportCheckerFixture({
      originOwner: 'OTHER-SESSION', originGeneration: 1,
    }), () => {}],
  ]) {
    const { data } = readState(fixture.root, fixture.runId);
    mutate(data.episodes.find(episode => episode.id === fixture.claim.checker_episode_id));
    writeState(fixture.root, fixture.runId, data);
    assertProcessSettlementRejectsWithoutWrites(
      fixture,
      /PROCESS_ACCOUNTING_CONTEXT_MISMATCH/,
    );
    assert.equal(readState(fixture.root, fixture.runId).data.status, 'stopped', label);
  }
});

test('stopped pre-import checker settlement requires exactly one matching claim before finish', () => {
  for (const [label, fixture] of [
    ['missing', stopPreImportCheckerFixture({ claimEvents: 0 })],
    ['duplicate', stopPreImportCheckerFixture({ claimEvents: 2 })],
    ['after-finish', setManualTerminal(checkerProcessReceiptFixture(), { claimAfterFinish: true })],
  ]) {
    assertProcessSettlementRejectsWithoutWrites(
      fixture,
      /PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING/,
    );
    assert.equal(readState(fixture.root, fixture.runId).data.status, 'stopped', label);
  }
});

test('stopped pre-import checker settlement rejects non-stopped or ambiguous finish proof', () => {
  const completed = checkerProcessReceiptFixture();
  appendCheckerClaimEvent(completed);
  setManualTerminal(completed, { status: 'completed' });

  const multiple = checkerProcessReceiptFixture();
  appendCheckerClaimEvent(multiple);
  appendAnchored(multiple.root, multiple.runId, {
    type: 'finish', data: { status: 'stopped', reportRel: 'unrelated' },
  });
  finishRun(multiple.root, multiple.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'multiple finish fixture' },
    fence: { owner: multiple.runId, generation: 1, intent: 'business' },
    now: Date.parse('2026-07-12T00:03:00.000Z'),
  });

  for (const [label, fixture] of [['completed', completed], ['multiple', multiple]]) {
    assertProcessSettlementRejectsWithoutWrites(
      fixture,
      /PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING/,
    );
    assert.equal(readState(fixture.root, fixture.runId).data.status, label === 'completed' ? 'completed' : 'stopped');
  }
});

test('stopped pre-import checker settlement requires the exact adjacent finish floor', () => {
  for (const finishFloor of ['missing', 'wrong']) {
    const fixture = checkerProcessReceiptFixture();
    appendCheckerClaimEvent(fixture);
    setManualTerminal(fixture, { finishFloor });
    assertProcessSettlementRejectsWithoutWrites(
      fixture,
      /PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING/,
    );
  }
});

test('stopped pre-import checker settlement rejects review outcome or unrelated post-finish event', () => {
  const outcome = checkerProcessReceiptFixture();
  appendCheckerClaimEvent(outcome);
  appendAnchored(outcome.root, outcome.runId, {
    type: 'review-outcome',
    data: {
      episodeId: outcome.claim.checker_episode_id,
      attempt_id: outcome.claim.attempt_id,
      target_maker: outcome.claim.target_maker,
      review_source: 'imported-stdin',
    },
  });
  finishRun(outcome.root, outcome.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'outcome fixture' },
    fence: { owner: outcome.runId, generation: 1, intent: 'business' },
    now: Date.parse('2026-07-12T00:03:00.000Z'),
  });

  const postFinish = checkerProcessReceiptFixture();
  appendCheckerClaimEvent(postFinish);
  setManualTerminal(postFinish, {
    postFinishEvent: { type: 'decision', data: { note: 'unrelated-after-finish' } },
  });
  for (const fixture of [outcome, postFinish]) {
    assertProcessSettlementRejectsWithoutWrites(
      fixture,
      /PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING/,
    );
  }
});

test('stopped pre-import checker settlement enforces the exact current fence', () => {
  const fixture = stopPreImportCheckerFixture();
  assertProcessSettlementRejectsWithoutWrites(
    fixture,
    /LEASE_FENCED: owner-mismatch/,
    { owner: 'OTHER-SESSION', generation: 1, intent: 'accounting' },
  );
  assertProcessSettlementRejectsWithoutWrites(
    fixture,
    /LEASE_FENCED: generation-mismatch/,
    { owner: fixture.runId, generation: 2, intent: 'accounting' },
  );
});

test('stopped pre-import checker settlement records once and exact retry is write-free', () => {
  const fixture = stopPreImportCheckerFixture();
  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), { ok: true, recorded: true, reason: 'recorded' });
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBeforeRetry = readFileSync(statePath, 'utf8');
  const logBeforeRetry = readFileSync(logPath, 'utf8');
  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), { ok: true, recorded: false, reason: 'already-recorded' });
  assert.equal(readFileSync(statePath, 'utf8'), stateBeforeRetry);
  assert.equal(readFileSync(logPath, 'utf8'), logBeforeRetry);
  const state = readState(fixture.root, fixture.runId).data;
  assert.equal(state.status, 'stopped');
  assert.equal(state.episodes.find(
    episode => episode.id === fixture.claim.checker_episode_id,
  ).status, 'in_progress');
  assert.equal(readLines(fixture.root, fixture.runId).filter(
    event => event.type === 'review-outcome',
  ).length, 0);
  const receiptEvents = readLines(fixture.root, fixture.runId).filter(
    event => event.data?.process_receipt_id === fixture.receipt.receipt_id,
  );
  assert.equal(receiptEvents.length, 1);
  assert.deepEqual(Object.keys(receiptEvents[0].data).sort(), [
    'generation',
    'input_tokens',
    'output_tokens',
    'owner',
    'process_context',
    'process_kind',
    'process_receipt_id',
    'reported_tokens',
    'reported_turns',
    'source',
    'tokens',
    'turns',
  ]);
  assert.equal(receiptEvents[0].data.turns, 0);
  assert.equal(receiptEvents[0].data.tokens, fixture.receipt.usage.tokens);
  assert.equal(receiptEvents[0].data.owner, fixture.runId);
  assert.equal(receiptEvents[0].data.generation, 1);
  assert.equal(state.budget.spent, MUTATION_TURN_FLOOR);
  assert.equal(state.budget.tokens_spent, fixture.receipt.usage.tokens);
  assert.equal(state.session_chain.sessions.find(
    session => session.run_id === fixture.runId,
  ).turns, MUTATION_TURN_FLOOR);
});

test('an exact checker receipt remains a write-free no-op after lease advance and terminal finish', () => {
  const fixture = checkerProcessReceiptFixture();
  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), { ok: true, recorded: true, reason: 'recorded' });
  const handoff = emitHandoff(fixture.root, fixture.runId, {
    trigger: 'checker-receipt-cleanup-fixture',
    headless: true,
    resumePolicy: 'headless',
    expect: { owner: fixture.runId, generation: 1 },
    now: Date.parse('2026-07-12T00:01:00.000Z'),
  });
  assert.equal(handoff.ok, true);
  assert.equal(acquireLease(fixture.root, fixture.runId, {
    owner: handoff.childRunId,
    expectGeneration: 1,
    runtime: 'codex',
    now: Date.parse('2026-07-12T00:02:00.000Z'),
  }).ok, true);
  finishRun(fixture.root, fixture.runId, {
    status: 'stopped',
    confirm: true,
    proof: { human_reason: 'terminal checker receipt cleanup fixture' },
    fence: { owner: handoff.childRunId, generation: 2, intent: 'business' },
    now: Date.parse('2026-07-12T00:03:00.000Z'),
  });
  const statePath = join(runDir(fixture.root, fixture.runId), 'loop.json');
  const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
  const stateBefore = readFileSync(statePath, 'utf8');
  const logBefore = readFileSync(logPath, 'utf8');
  const currentFence = { owner: handoff.childRunId, generation: 2, intent: 'accounting' };
  assert.deepEqual(settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: currentFence,
  }), { ok: true, recorded: false, reason: 'already-recorded' });
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(readFileSync(logPath, 'utf8'), logBefore);
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: fixture.fence,
  }), /LEASE_FENCED: owner-mismatch/);
  assert.throws(() => settleCodexProcessCost(fixture.root, fixture.runId, {
    receipt: fixture.receipt,
    fence: { owner: handoff.childRunId, generation: 3, intent: 'accounting' },
  }), /LEASE_FENCED: generation-mismatch/);
});

test('recordCost syncs kernel-derived spent from event-log', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 5, tokens: 100 });
  recordCost(root, 'R', { turns: 3, tokens: 50 });
  const { data } = readState(root, 'R');
  assert.equal(data.budget.spent, 8);
  assert.equal(data.budget.tokens_spent, 150);
});

test('reconcileBudget throws on stored/log mismatch', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 5, tokens: 0 });
  const { data } = readState(root, 'R'); data.budget.spent = 0; writeState(root, 'R', data); // tamper low
  assert.throws(() => reconcileBudget(root, 'R'), /BUDGET_TAMPERED/);
});

test('recordCost rejects negative / non-finite values', () => {
  const root = seedRun();
  assert.throws(() => recordCost(root, 'R', { turns: -1, tokens: 0 }), /INVALID_COST/);
  assert.throws(() => recordCost(root, 'R', { turns: 1, tokens: Infinity }), /INVALID_COST/);
});

test('recordCost records one known checker turn on a paused run only through the matching accounting fence', () => {
  const { root, runId } = floorRun();
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.pause_reason = 'consecutive-request-changes';
  writeState(root, runId, data);
  assert.doesNotThrow(() => recordCost(root, runId, {
    turns: 1,
    tokens: 12,
    fence: { owner: runId, generation: 1, intent: 'accounting' },
  }));
  assert.equal(readState(root, runId).data.budget.spent, 1);
  assert.throws(() => recordCost(root, runId, {
    turns: 1,
    tokens: 12,
    fence: { owner: runId, generation: 1, intent: 'business' },
  }), /LEASE_FENCED: RUN_PAUSED/);
});

test('reconcileBudget detects event-log suffix truncation', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 2, tokens: 0 });
  recordCost(root, 'R', { turns: 3, tokens: 0 });
  const p = join(runDir(root, 'R'), 'event-log.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  writeFileSync(p, lines.slice(0, -1).join('\n') + '\n'); // drop last event
  assert.throws(() => reconcileBudget(root, 'R'), /BUDGET_TAMPERED/);
});

test('checkBudget derives wallclock from created_at when sessionStart omitted', () => {
  const l = base();
  l.created_at = new Date(Date.now() - 4000 * 1000).toISOString(); // 4000s ago > 3600 cap
  assert.equal(checkBudget(l, {}).ok, false);
});

test('non-cost anchored append keeps reconcile consistent; its truncation is caught', () => {
  const root = seedRun();
  recordCost(root, 'R', { turns: 2, tokens: 0 });
  appendAnchored(root, 'R', { type: 'decision', data: { note: 'x' } }); // non-cost advances anchor (no floor opt)
  reconcileBudget(root, 'R'); // must NOT throw (anchor tracks tail, spent still 2)
  const p = join(runDir(root, 'R'), 'event-log.jsonl');
  const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
  writeFileSync(p, lines.slice(0, -1).join('\n') + '\n'); // truncate the non-cost event
  assert.throws(() => reconcileBudget(root, 'R'), /BUDGET_TAMPERED/);
});

// ── #3: kernel-boundary per-mutation cost floor ──

// #3(a): each business mutation is charged MUTATION_TURN_FLOOR even without any `budget record` — spent AND the
// owner's session.turns both grow with the NUMBER of mutations (per-mutation, not per-generation).
test('#3(a): N business mutations charge N×floor to spent AND session.turns (no budget record)', () => {
  const { root, runId, fence } = floorRun();
  mk(root, runId, fence, 3);
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR);
  assert.equal(ownerSessionTurns(root, runId), 3 * MUTATION_TURN_FLOOR);
  assert.doesNotThrow(() => reconcileBudget(root, runId));   // floor is anchored → reconcile stays consistent
});

// #3(b): an explicit `budget record` ABSORBS the tick's floor (max-rule), not stacks on it —
// tick contribution = max(reported, floor-sum), never reported + floor-sum.
test('#3(b): explicit budget record absorbs the tick floor (max-rule, no double count)', () => {
  const { root, runId, fence } = floorRun();
  mk(root, runId, fence, 2);   // 2 floors → spent 2, session.turns 2
  recordCost(root, runId, { turns: 5, tokens: 0, fence });   // reported 5 > floor-sum 2
  // tick contribution = max(5, 2) = 5, so total spent = 5 (NOT 2 + 5 = 7)
  assert.equal(readState(root, runId).data.budget.spent, 5);
  assert.equal(ownerSessionTurns(root, runId), 5);
  assert.doesNotThrow(() => reconcileBudget(root, runId));
});

// #3(c): the floor drives per_session_turn_cap proportionally to the number of mutations — reaching the cap
// through floors alone routes unattended nextAction to handoff (attended compact-in-place receives advice).
test('#3(c): per_session_turn_cap is reached through floors and routes unattended to handoff', () => {
  const { root, runId, fence } = floorRun({ continuationPolicy: 'compact-in-place' });
  assert.equal(
    readState(root, runId).data.autonomy.continuation_policy,
    'compact-in-place',
    'legacy cap-routing fixture must come from public v0.3 migration',
  );
  const d = readState(root, runId).data; d.budget.per_session_turn_cap = 2; writeState(root, runId, d);
  mk(root, runId, fence, 2);   // 2 floors → session.turns 2 == cap
  const r = nextAction(readState(root, runId).data, { now: Date.parse('2026-06-24T00:00:01Z'), unattended: true });
  assert.equal(r.action.type, 'handoff');
  assert.equal(r.action.reason, 'per_session_turn_cap');
});

// #3(d): negatives still rejected; wallclock backstop + log integrity unaffected by floor events.
test('#3(d): floor keeps negatives rejected and the log verifiable', () => {
  const { root, runId, fence } = floorRun();
  mk(root, runId, fence, 2);
  assert.throws(() => recordCost(root, runId, { turns: -1, tokens: 0, fence }), /INVALID_COST/);
  const { data } = readState(root, runId);
  assert.equal(verifyLog(root, runId).ok, true);
  assert.equal(verifyHead(root, runId, data.event_log_head).ok, true);
});

// #3(e) (R1 Fix 2): the previously non-anchored setWorkstreamStatus + patch paths are now anchored AND floor-charged —
// they emit workstream-status / state-patch events and grow spent (closing the "drive finish/routing for free" gap).
test('#3(e): setWorkstreamStatus + patch are anchored and floor-charged (workstream-status / state-patch events)', () => {
  const { root, runId, fence } = floorRun();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence }).id;   // floor 1
  setWorkstreamStatus(root, runId, ws, 'in_progress', { fence });   // floor 2, active_workstreams push
  patch(root, runId, 'decisions', ['noted'], { fence });            // floor 3, whitelisted field
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR);
  const lines = readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(lines.some(e => e.type === 'workstream-status' && e.data.id === ws && e.data.status === 'in_progress'));
  assert.ok(lines.some(e => e.type === 'state-patch' && e.data.field === 'decisions'));
  assert.ok(readState(root, runId).data.active_workstreams.includes(ws), 'setWorkstreamStatus mutation still applied');
  assert.deepEqual(readState(root, runId).data.decisions, ['noted'], 'patch mutation still applied');
  assert.doesNotThrow(() => reconcileBudget(root, runId));
});

// #3 (impl-R1 Fix 1): an explicit budget record in a LATER session must NOT absorb an EARLIER session's floors —
// those are confirmed prior consumption. gen 1: 3 floors, no report → advance lease to gen 2 → record K=5:
// total = 3×floor + max(K, gen-2 floors=0) = 3 + 5 = 8, NOT max(3, 5) = 5 (the bug that swallowed the gen-1 floors).
test('#3(Fix1): a later session budget record does not absorb an earlier session floors (session-scoped absorption)', () => {
  const { root, runId, fence } = floorRun();
  const now = Date.parse('2026-06-24T00:00:00Z');
  mk(root, runId, fence, 3);   // gen 1: 3 floors → spent 3
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR);
  // advance the lease: release gen 1, a child acquires (gen 2)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: 'CHILD-ACTOR', expectGeneration: 1, runtime: 'claude', now });
  // gen 2 reports 5 turns — its own tick floor is 0, so it must NOT absorb the gen-1 floors
  recordCost(root, runId, { turns: 5, tokens: 0, fence: { owner: 'CHILD-ACTOR', generation: 2, intent: 'business' } });
  assert.equal(readState(root, runId).data.budget.spent, 3 * MUTATION_TURN_FLOOR + 5, 'gen-1 floors survive; gen-2 report adds max(5, 0)=5 on top');
  assert.doesNotThrow(() => reconcileBudget(root, runId));
});

// ── v1.6 recordCost terminal 가드 (spec §2.3-7 / §4-5g) ──────────────────────
import { initRun as initRunT } from '../scripts/lib/initrun.mjs';

test('recordCost: terminal run — fenced call LEASE_FENCED channel, fence-less own throw; no event written', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-bud-t-'));
  const { runId } = initRunT(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  const { data } = readState(root, runId);
  data.status = 'completed';
  writeState(root, runId, data);
  // fence 있는 호출 → leaseCheck 선행 → LEASE_FENCED: RUN_TERMINAL (drive-headless swallow 계약)
  assert.throws(() => recordCost(root, runId, { turns: 1, tokens: 0, fence: { owner: runId, generation: 1, intent: 'accounting' } }), /LEASE_FENCED: RUN_TERMINAL/);
  // fence-less 직접 호출 → 자체 가드
  assert.throws(() => recordCost(root, runId, { turns: 1, tokens: 0 }), /RUN_TERMINAL: recordCost/);
  assert.equal(readState(root, runId).data.budget.spent, 0);
});

function terminalCodexChildRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-terminal-cost-'));
  const { runId } = initRun(root, {
    runtime: 'codex', goal: 'g', now: new Date('2026-07-11T00:00:00Z'),
  });
  const childRunId = '01JTERMINALCHILD0000000000';
  const handoffKey = 'a'.repeat(64);
  appendAnchored(root, runId, {
    type: 'handoff-emitted',
    data: { child_run_id: childRunId, reason: 'fixture', key: handoffKey },
  }, (data) => {
    data.session_chain.sessions.push({
      run_id: childRunId, started_at: null, ended_at: null,
      turns: 0, outcome: null, superseded_by: null,
      scope: {
        kind: 'workstream', workstream_id: null, bound_at_seq: null,
        terminal_event: null, closed_at: null, superseded_at: null,
      },
    });
    data.session_chain.lease = {
      ...data.session_chain.lease,
      state: 'releasing',
      handoff_phase: 'spawned',
      handoff_idempotency_key: handoffKey,
      handoff_child_run_id: childRunId,
    };
  });
  assert.equal(acquireLease(root, runId, {
    owner: childRunId, expectGeneration: 1, runtime: 'codex',
    now: Date.parse('2026-07-11T00:01:00Z'),
  }).ok, true);
  const finishFence = { owner: childRunId, generation: 2, intent: 'business' };
  finishRun(root, runId, {
    status: 'stopped', confirm: true, proof: { human_reason: 'terminal accounting fixture' },
    fence: finishFence, now: Date.parse('2026-07-11T00:02:00Z'),
  });
  return { root, runId, childRunId, handoffKey };
}

test('terminal Codex maker settlement absorbs the finish floor exactly once and is idempotent', () => {
  const { root, runId, childRunId, handoffKey } = terminalCodexChildRun();
  const usage = { num_turns: 1, input_tokens: 5, output_tokens: 7, tokens: 12 };
  const fence = { owner: childRunId, generation: 2, intent: 'accounting' };

  const reorderedUsage = { tokens: 12, output_tokens: 7, input_tokens: 5, num_turns: 1 };
  assert.deepEqual(settleTerminalCodexMakerCost(root, runId, { usage: reorderedUsage, fence, handoffKey }), {
    ok: true, recorded: true, reason: 'recorded',
  });
  let state = readState(root, runId).data;
  assert.equal(state.status, 'stopped');
  assert.equal(state.budget.spent, 1, 'the explicit one-turn report must absorb the finish floor');
  assert.equal(state.budget.tokens_spent, 12);
  assert.equal(state.session_chain.sessions.find(s => s.run_id === childRunId).turns, 1);
  let costs = readLines(root, runId).filter(event => event.type === 'cost');
  assert.equal(costs.length, 2);
  assert.equal(costs[1].data.terminal_process, 'codex-maker');
  assert.equal(costs[1].data.reported_turns, 1);
  assert.equal(costs[1].data.reported_tokens, 12);
  assert.equal(costs[1].data.turns, 0);
  assert.doesNotThrow(() => reconcileBudget(root, runId));

  assert.deepEqual(settleTerminalCodexMakerCost(root, runId, { usage, fence, handoffKey }), {
    ok: true, recorded: false, reason: 'already-recorded',
  });
  state = readState(root, runId).data;
  costs = readLines(root, runId).filter(event => event.type === 'cost');
  assert.equal(costs.length, 2, 'an identical retry must not append a second process cost');
  assert.equal(state.budget.spent, 1);
  const statePath = join(runDir(root, runId), 'loop.json');
  const logPath = join(runDir(root, runId), 'event-log.jsonl');
  const stateBeforeConflict = readFileSync(statePath, 'utf8');
  const logBeforeConflict = readFileSync(logPath, 'utf8');
  assert.throws(() => settleTerminalCodexMakerCost(root, runId, {
    usage: { ...usage, output_tokens: 8, tokens: 13 }, fence, handoffKey,
  }), /TERMINAL_ACCOUNTING_MISMATCH/);
  assert.equal(readFileSync(statePath, 'utf8'), stateBeforeConflict);
  assert.equal(readFileSync(logPath, 'utf8'), logBeforeConflict);
});

test('terminal Codex maker settlement remains narrow to an exact acquired child and kernel finish proof', () => {
  const { root, runId, childRunId, handoffKey } = terminalCodexChildRun();
  const usage = { num_turns: 1, input_tokens: 5, output_tokens: 7, tokens: 12 };
  assert.throws(() => settleTerminalCodexMakerCost(root, runId, {
    usage, fence: { owner: 'OTHER', generation: 2, intent: 'accounting' }, handoffKey,
  }), /LEASE_FENCED: owner-mismatch/);
  assert.throws(() => settleTerminalCodexMakerCost(root, runId, {
    usage, fence: { owner: childRunId, generation: 3, intent: 'accounting' }, handoffKey,
  }), /LEASE_FENCED: generation-mismatch/);
  assert.throws(() => settleTerminalCodexMakerCost(root, runId, {
    usage, fence: { owner: childRunId, generation: 2, intent: 'accounting' }, handoffKey: 'b'.repeat(64),
  }), /TERMINAL_ACCOUNTING_PROOF_MISSING/);

  const { data } = readState(root, runId);
  data.status = 'running';
  writeState(root, runId, data);
  assert.throws(() => settleTerminalCodexMakerCost(root, runId, {
    usage, fence: { owner: childRunId, generation: 2, intent: 'accounting' }, handoffKey,
  }), /RUN_NOT_TERMINAL/);
});

test('terminal Codex maker settlement rejects malformed session, runtime, proof, and log anchors without appending', () => {
  const usage = { num_turns: 1, input_tokens: 5, output_tokens: 7, tokens: 12 };
  const invoke = fixture => settleTerminalCodexMakerCost(fixture.root, fixture.runId, {
    usage,
    fence: { owner: fixture.childRunId, generation: 2, intent: 'accounting' },
    handoffKey: fixture.handoffKey,
  });

  {
    const fixture = terminalCodexChildRun();
    const { data } = readState(fixture.root, fixture.runId);
    data.session_chain.sessions.find(s => s.run_id === fixture.childRunId).turns = '1';
    writeState(fixture.root, fixture.runId, data);
    assert.throws(() => invoke(fixture), /TERMINAL_ACCOUNTING_SESSION_INVALID/);
  }
  {
    const fixture = terminalCodexChildRun();
    const { data } = readState(fixture.root, fixture.runId);
    data.autonomy.session_runtime = 'claude';
    writeState(fixture.root, fixture.runId, data);
    assert.throws(() => invoke(fixture), /RUNTIME_FENCED/);
  }
  {
    const fixture = terminalCodexChildRun();
    const { data } = readState(fixture.root, fixture.runId);
    delete data.termination.finished_at;
    writeState(fixture.root, fixture.runId, data);
    assert.throws(() => invoke(fixture), /TERMINAL_ACCOUNTING_PROOF_MISSING/);
  }
  {
    const fixture = terminalCodexChildRun();
    const { data } = readState(fixture.root, fixture.runId);
    data.event_log_head = { seq: 0, checksum: 'GENESIS' };
    writeState(fixture.root, fixture.runId, data);
    assert.throws(() => invoke(fixture), /LOG_TAMPERED/);
  }
  {
    const fixture = terminalCodexChildRun();
    const logPath = join(runDir(fixture.root, fixture.runId), 'event-log.jsonl');
    const before = readFileSync(logPath, 'utf8');
    writeFileSync(logPath, before.replace('"reason":"fixture"', '"reason":"tampered"'));
    assert.throws(() => invoke(fixture), /LOG_TAMPERED/);
  }
});
