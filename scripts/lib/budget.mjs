import {
  assertVerifiedRunSnapshot,
  commitVerifiedEventsUnderLock,
  mutationIntentDigest,
  withVerifiedMutationLock,
  MUTATION_TURN_FLOOR,
  readLines,
  recomputeSpent,
  verifyLog,
  verifyHead,
  validCost,
} from './integrity.mjs';
import { readState, withLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';
import { runtimeFence, sessionRuntime } from './runtime.mjs';
import { contentHash } from './envelope.mjs';
import { canonicalProjectRoot, projectRootDigest } from './project-root.mjs';

// #3: re-exported from integrity.mjs (the floor mechanism's home) so call sites/tests can import it from budget.mjs
// while state.mjs imports it directly from integrity.mjs (no state↔budget cycle).
export { MUTATION_TURN_FLOOR };

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// A Codex process is billable preflight evidence only when the streaming parser proved one complete turn
// with a non-overflowing input+output total. Optional cached/reasoning fields are non-additive breakdowns.
export function isMeasuredOneTurnUsage(usage) {
  if (usage == null || typeof usage !== 'object' || Array.isArray(usage)
    || usage.num_turns !== 1
    || !safeTokenCount(usage.input_tokens) || !safeTokenCount(usage.output_tokens)
    || !safeTokenCount(usage.tokens)
    || !safeTokenCount(usage.input_tokens + usage.output_tokens)
    || usage.tokens !== usage.input_tokens + usage.output_tokens) return false;
  return ['cached_input_tokens', 'reasoning_output_tokens']
    .every((field) => !Object.hasOwn(usage, field) || safeTokenCount(usage[field]));
}

function sameMeasuredUsage(left, right) {
  return ['num_turns', 'input_tokens', 'output_tokens', 'tokens', 'cached_input_tokens', 'reasoning_output_tokens']
    .every(field => Object.hasOwn(left, field) === Object.hasOwn(right, field)
      && (!Object.hasOwn(left, field) || left[field] === right[field]));
}

const OPTIONAL_MEASURED_EVENT_KEYS = [
  'cached_input_tokens',
  'reasoning_output_tokens',
];

function hasCanonicalEventData(data, requiredKeys) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return false;
  const expected = new Set(requiredKeys);
  for (const key of OPTIONAL_MEASURED_EVENT_KEYS) {
    if (Object.hasOwn(data, key)) expected.add(key);
  }
  const actual = Object.keys(data);
  return actual.length === expected.size && actual.every(key => expected.has(key));
}

function hasExactEventData(data, requiredKeys) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return false;
  const expected = new Set(requiredKeys);
  const actual = Object.keys(data);
  return actual.length === expected.size && actual.every(key => expected.has(key));
}

const CODEX_PREFLIGHT_RECEIPT_CONTRACT = 'deep-loop-codex-preflight-accounting-receipt-v1';
const CODEX_PROCESS_RECEIPT_CONTRACT = 'deep-loop-codex-process-accounting-receipt-v1';

function exactMeasuredUsage(usage) {
  return {
    num_turns: usage.num_turns,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    tokens: usage.tokens,
    ...(usage.cached_input_tokens !== undefined ? { cached_input_tokens: usage.cached_input_tokens } : {}),
    ...(usage.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: usage.reasoning_output_tokens } : {}),
  };
}

function preflightReceiptPayload({ root, runId, cacheKey, smokeKind, attemptId,
  predecessorReceiptId, owner, generation, usage }) {
  if (typeof runId !== 'string' || runId.length === 0
    || typeof cacheKey !== 'string' || !/^[a-f0-9]{64}$/.test(cacheKey)
    || !['read', 'write'].includes(smokeKind)
    || typeof attemptId !== 'string' || !/^[a-f0-9]{32,64}$/.test(attemptId)
    || typeof owner !== 'string' || owner.length === 0
    || !Number.isInteger(generation) || generation < 1
    || !isMeasuredOneTurnUsage(usage)
    || (smokeKind === 'read' && predecessorReceiptId !== null)
    || (smokeKind === 'write'
      && (typeof predecessorReceiptId !== 'string' || !/^[a-f0-9]{64}$/.test(predecessorReceiptId)))) {
    throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  }
  const canonicalRoot = canonicalProjectRoot(root);
  return {
    contract: CODEX_PREFLIGHT_RECEIPT_CONTRACT,
    project_root_digest: projectRootDigest(canonicalRoot),
    run_id: runId,
    cache_key: cacheKey,
    smoke_kind: smokeKind,
    attempt_id: attemptId,
    predecessor_receipt_id: predecessorReceiptId,
    owner,
    generation,
    usage: exactMeasuredUsage(usage),
  };
}

export function makeCodexPreflightReceipt(options = {}) {
  const payload = preflightReceiptPayload(options);
  return { ...payload, receipt_id: contentHash(JSON.stringify(payload)) };
}

function boundedText(value, max = 4_096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function normalizedProcessContext(processKind, context) {
  if (context == null || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_INVALID');
  }
  if (processKind === 'maker') {
    if (!boundedText(context.parent_owner, 512)
      || !Number.isInteger(context.parent_generation) || context.parent_generation < 1
      || !boundedText(context.child_run_id, 512)
      || context.child_generation !== context.parent_generation + 1
      || typeof context.handoff_key !== 'string' || !/^[a-f0-9]{16}$/.test(context.handoff_key)
      || typeof context.handoff_rel !== 'string' || context.handoff_rel.length > 4_096
      || context.handoff_rel.includes('\0')) {
      throw new Error('PROCESS_ACCOUNTING_CONTEXT_INVALID');
    }
    return {
      parent_owner: context.parent_owner,
      parent_generation: context.parent_generation,
      child_run_id: context.child_run_id,
      child_generation: context.child_generation,
      handoff_key: context.handoff_key,
      handoff_rel: context.handoff_rel,
    };
  }
  if (processKind === 'checker') {
    if (!boundedText(context.origin_owner, 512)
      || !Number.isInteger(context.origin_generation) || context.origin_generation < 1
      || !boundedText(context.checker_episode_id, 512)
      || !boundedText(context.attempt_id, 512)
      || !boundedText(context.target_maker, 512)
      || typeof context.claim_hash !== 'string' || !/^[a-f0-9]{64}$/.test(context.claim_hash)) {
      throw new Error('PROCESS_ACCOUNTING_CONTEXT_INVALID');
    }
    return {
      origin_owner: context.origin_owner,
      origin_generation: context.origin_generation,
      checker_episode_id: context.checker_episode_id,
      attempt_id: context.attempt_id,
      target_maker: context.target_maker,
      claim_hash: context.claim_hash,
    };
  }
  throw new Error('PROCESS_ACCOUNTING_KIND_INVALID');
}

export function codexCheckerClaimHash(claim) {
  if (claim == null || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new Error('PROCESS_ACCOUNTING_CLAIM_INVALID');
  }
  return contentHash(JSON.stringify(claim));
}

export function makeCodexProcessReceipt({ root, runId, processKind, context, usage } = {}) {
  if (typeof runId !== 'string' || runId.length === 0 || !isMeasuredOneTurnUsage(usage)) {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  let normalizedContext;
  try {
    normalizedContext = normalizedProcessContext(processKind, context);
  } catch {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  const payload = {
    contract: CODEX_PROCESS_RECEIPT_CONTRACT,
    project_root_digest: projectRootDigest(canonicalProjectRoot(root)),
    run_id: runId,
    process_kind: processKind,
    context: normalizedContext,
    usage: exactMeasuredUsage(usage),
  };
  return { ...payload, receipt_id: contentHash(JSON.stringify(payload)) };
}

function validateCodexProcessReceipt(root, runId, receipt) {
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.contract !== CODEX_PROCESS_RECEIPT_CONTRACT || receipt.run_id !== runId) {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  let expected;
  try {
    expected = makeCodexProcessReceipt({
      root,
      runId,
      processKind: receipt.process_kind,
      context: receipt.context,
      usage: receipt.usage,
    });
  } catch {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error('PROCESS_ACCOUNTING_RECEIPT_INVALID');
  }
  return expected;
}

function validateCodexPreflightReceipt(root, runId, receipt) {
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)
    || receipt.contract !== CODEX_PREFLIGHT_RECEIPT_CONTRACT
    || receipt.run_id !== runId) throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  let expected;
  try {
    expected = makeCodexPreflightReceipt({
      root,
      runId,
      cacheKey: receipt.cache_key,
      smokeKind: receipt.smoke_kind,
      attemptId: receipt.attempt_id,
      predecessorReceiptId: receipt.predecessor_receipt_id,
      owner: receipt.owner,
      generation: receipt.generation,
      usage: receipt.usage,
    });
  } catch {
    throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  }
  if (receipt.project_root_digest !== expected.project_root_digest
    || receipt.receipt_id !== expected.receipt_id
    || JSON.stringify(receipt) !== JSON.stringify(expected)) {
    throw new Error('PREFLIGHT_ACCOUNTING_RECEIPT_INVALID');
  }
  return expected;
}

export function checkBudget(loop, { now = Date.now(), sessionStart, measurable = true } = {}) {
  const b = loop.budget;
  if (!measurable && b.enforcement !== 'best-effort-interactive' && b.on_unmeasurable_usage === 'fail-closed') {
    return { ok: false, reason: 'unmeasurable-usage-fail-closed', tier_after: loop.autonomy.tier };
  }
  // sessionStart 미지정 시 run의 created_at에서 파생 → 호출자가 빠뜨려도 wallclock이 0으로 무력화되지 않음 (Codex impl 🟡6)
  const start = sessionStart ?? (loop.created_at ? Date.parse(loop.created_at) : now);
  const wall = (now - start) / 1000;
  if (b.spent >= b.total * b.hard_stop_ratio) return { ok: false, reason: 'turns-hard-stop', tier_after: loop.autonomy.tier };
  if (b.tokens_total && b.tokens_spent >= b.tokens_total) return { ok: false, reason: 'tokens-hard-stop', tier_after: loop.autonomy.tier };
  if (b.max_wallclock_sec && wall >= b.max_wallclock_sec) return { ok: false, reason: 'wallclock-hard-stop', tier_after: loop.autonomy.tier };
  if (b.spent >= b.total * b.soft_stop_ratio) {
    const demoted = ['act-gated', 'act-reversible'].includes(loop.autonomy.tier) ? 'recommend' : loop.autonomy.tier;
    return { ok: true, reason: 'soft-stop-demote', tier_after: demoted };
  }
  return { ok: true, reason: 'ok', tier_after: loop.autonomy.tier };
}

// #3 max-rule: the auto-floor turns/tokens accrued since the last EXPLICIT cost event (i.e. the current "tick").
// An explicit `budget record` ABSORBS this floor rather than stacking on top of it — the tick's contribution is
// max(reported, floor-sum), not the sum. A non-floor (explicit) cost resets the running tick.
// impl-R1 Fix 1: scoped to a SINGLE session (owner+generation). Only floors tagged with THIS session are absorbable;
// a prior session's floors are confirmed consumption and are skipped (never swallowed by a later report). An
// explicit cost of the SAME session closes its tick.
function trailingFloor(lines, owner, generation) {
  let tf = 0, tk = 0;
  for (const e of lines) {
    if (e.type !== 'cost') continue;
    if (e.data?.owner !== owner || e.data?.generation !== generation) continue;   // different session → not ours to absorb
    if (e.data?.auto_floor) { tf += e.data.turns || 0; tk += e.data.tokens || 0; }
    else { tf = 0; tk = 0; }   // this session's explicit cost ends its tick
  }
  return { tf, tk };
}

function commitMeasuredCost(root, runId, loop, lines, baseStateHash, eventData,
  { owner, addedTurns, callerBinding, intentDigest, requireSession = true }) {
  return commitVerifiedEventsUnderLock(root, runId, loop,
    [{ type: 'cost', data: eventData }], (candidate, spent) => {
      candidate.budget.spent = spent.turns;
      candidate.budget.tokens_spent = spent.tokens;
      const session = (candidate.session_chain?.sessions || [])
        .find(item => item.run_id === owner);
      if (!session && requireSession) throw new Error('ACCOUNTING_SESSION_INVALID');
      if (session) session.turns = (session.turns || 0) + addedTurns;
    }, { baseLines: lines, baseStateHash, callerBinding, intentDigest });
}

function accountingReplayFence(fence, {
  runtime = null, runtimeMessage = null, leasePolicy = false,
} = {}) {
  const identityCheck = loop => {
    const lease = loop.session_chain?.lease || {};
    if (runtime === null && fence.runtime !== undefined) {
      const checkedRuntime = runtimeFence(loop, fence.runtime);
      if (!checkedRuntime.ok) throw new Error(`LEASE_FENCED: ${checkedRuntime.reason}`);
    }
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (runtime !== null && sessionRuntime(loop) !== runtime) throw new Error(runtimeMessage);
  };
  identityCheck.policyCheck = leasePolicy ? loop => {
    const authorized = leaseCheck(loop, fence);
    if (!authorized.ok) throw new Error(`LEASE_FENCED: ${authorized.reason}`);
  } : null;
  return identityCheck;
}

function recoveredCostEvent(root, runId, mutation, predicate,
  { requestDigest = null, requestIdDigest = null, fenceCheck, policyCheck = null } = {}) {
  if (typeof fenceCheck !== 'function') throw new Error('ACCOUNTING_RECOVERY_FENCE_REQUIRED');
  if (policyCheck !== null && typeof policyCheck !== 'function') {
    throw new Error('ACCOUNTING_RECOVERY_POLICY_REQUIRED');
  }
  const snapshot = mutation.readVerifiedState({ fenceCheck });
  const lines = readLines(root, runId);
  if (fenceCheck.policyCheck !== null) fenceCheck.policyCheck(snapshot.data, lines);
  if (policyCheck !== null) policyCheck(snapshot.data, lines);
  if (requestIdDigest !== null) {
    const durable = lines.filter(event => event.type === 'cost'
      && event.data?.accounting_request_id_digest === requestIdDigest);
    if (durable.length > 1) throw new Error('ACCOUNTING_RECOVERY_PROJECTION_MISMATCH');
    if (durable.length === 1) {
      if (durable[0].data?.accounting_request_digest !== requestDigest) {
        throw new Error('ACCOUNTING_REQUEST_CONFLICT');
      }
      if (!predicate(durable[0])) throw new Error('ACCOUNTING_REQUEST_CONFLICT');
      if (mutation.recovered !== null
          && !mutation.recovered.events.some(event => event.seq === durable[0].seq
            && event.checksum === durable[0].checksum)) {
        throw new Error('ACCOUNTING_RECOVERY_PROJECTION_MISMATCH');
      }
      return true;
    }
  }
  if (mutation.recovered === null) return false;
  const recovered = mutation.recovered.events.filter(event =>
    event.type === 'cost' && predicate(event));
  if (recovered.length !== 1) throw new Error('ACCOUNTING_RECOVERY_PROJECTION_MISMATCH');
  const durable = lines.filter(event => event.seq === recovered[0].seq
    && event.checksum === recovered[0].checksum);
  if (durable.length !== 1 || !predicate(durable[0])) {
    throw new Error('ACCOUNTING_RECOVERY_PROJECTION_MISMATCH');
  }
  return true;
}

function assertPreflightReplayPolicy(loop, fence) {
  const authorized = leaseCheck(loop, fence);
  if (!authorized.ok) throw new Error(`LEASE_FENCED: ${authorized.reason}`);
}

function verifySettledCheckerAfterLeaseAdvance(loop, exact, origin, lines, fence) {
  const lease = loop.session_chain?.lease || {};
  if (!['completed', 'stopped'].includes(loop.status)
      || lease.owner_run_id !== fence.owner || lease.generation !== fence.generation
      || lease.state !== 'active' || lease.handoff_phase !== 'acquired'
      || origin.owner === fence.owner) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const checker = (loop.episodes || []).find(
    episode => episode.id === exact.context.checker_episode_id);
  if (checker?.status !== 'in_progress' || !checker.review_claim
      || checker.attempt_id !== exact.context.attempt_id) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const receipts = lines.filter(event => exactProcessCostEvent(event, exact, origin, lines));
  const handoffs = lines.filter(event => event.type === 'handoff-emitted'
    && event.data?.child_run_id === fence.owner);
  const finishes = lines.filter(event => event.type === 'finish');
  const receipt = receipts[0];
  const handoff = handoffs[0];
  const finish = finishes[0];
  const finishFloor = lines.find(event => event.seq === finish?.seq + 1
    && event.type === 'cost' && event.data?.auto_floor === true
    && event.data?.for === 'finish' && event.data?.owner === fence.owner
    && event.data?.generation === fence.generation);
  const outcomes = lines.filter(event => event.type === 'review-outcome'
    && event.data?.episodeId === exact.context.checker_episode_id
    && event.data?.attempt_id === exact.context.attempt_id);
  if (receipts.length !== 1 || handoffs.length !== 1 || finishes.length !== 1
      || !finishFloor || outcomes.length !== 0
      || !(receipt.seq < handoff.seq && handoff.seq < finish.seq)
      || finish.data?.status !== loop.status
      || typeof loop.termination?.finished_at !== 'string') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  if (lines.some(event => event.seq > finish.seq && event !== finishFloor)) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
}

function assertProcessReplayPolicy(loop, lines, exact, fence) {
  const authorized = leaseCheck(loop, fence);
  if (authorized.ok) return;
  if (authorized.reason !== 'RUN_TERMINAL') {
    throw new Error(`LEASE_FENCED: ${authorized.reason}`);
  }
  const origin = exact.process_kind === 'maker'
    ? makerOrigin(loop, exact, lines) : checkerOrigin(loop, exact);
  if (exact.process_kind === 'maker') {
    verifyTerminalMakerSettlement(loop, exact, origin, lines);
    return;
  }
  const checker = (loop.episodes || []).find(
    episode => episode.id === exact.context.checker_episode_id);
  if (loop.status === 'stopped' && checker?.status === 'in_progress') {
    const settledEvent = lines.find(event => exactProcessCostEvent(
      event, exact, origin, lines));
    const alreadySettled = settledEvent !== undefined;
    if (alreadySettled && origin.owner !== fence.owner) {
      verifySettledCheckerAfterLeaseAdvance(loop, exact, origin, lines, fence);
    } else {
      verifyStoppedPreImportCheckerSettlement(loop, exact, origin,
        alreadySettled ? lines.filter(event => event !== settledEvent) : lines);
    }
  } else {
    verifyTerminalCheckerSettlement(loop, exact, origin, lines);
  }
}

function assertTerminalMakerReplayPolicy(loop, lines, { usage, fence, handoffKey }) {
  const lease = loop.session_chain?.lease || {};
  if (loop.status !== 'completed' && loop.status !== 'stopped') {
    throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');
  }
  if (lease.state !== 'active' || lease.handoff_phase !== 'acquired') {
    throw new Error('TERMINAL_ACCOUNTING_CHILD_NOT_ACQUIRED');
  }
  const session = (loop.session_chain?.sessions || []).find(item => item.run_id === fence.owner);
  if (!session || typeof session.started_at !== 'string'
      || !Number.isFinite(Date.parse(session.started_at))
      || session.outcome === 'failed_launch'
      || !Number.isSafeInteger(session.turns) || session.turns < 0) {
    throw new Error('TERMINAL_ACCOUNTING_SESSION_INVALID');
  }
  const finishes = lines.filter(event => event.type === 'finish');
  const finish = finishes[0];
  if (finishes.length !== 1 || finish.data?.status !== loop.status
      || typeof loop.termination?.finished_at !== 'string') {
    throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');
  }
  const handoffs = lines.filter(event => event.type === 'handoff-emitted'
    && event.data?.child_run_id === fence.owner && event.data?.key === handoffKey);
  const finishFloor = lines.find(event => event.seq === finish.seq + 1
    && event.type === 'cost' && event.data?.auto_floor === true && event.data?.for === 'finish'
    && event.data?.owner === fence.owner && event.data?.generation === fence.generation);
  if (handoffs.length !== 1 || handoffs[0].seq >= finish.seq || !finishFloor) {
    throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');
  }
  const accountingKey = contentHash(
    `${loop.run_id}|${fence.owner}|${fence.generation}|${handoffKey}|${finish.checksum}`);
  const exactReceipt = event => event.type === 'cost'
    && event.data?.terminal_process === 'codex-maker'
    && event.data?.source === 'terminal-maker-measured'
    && event.data?.accounting_key === accountingKey
    && event.data?.owner === fence.owner && event.data?.generation === fence.generation;
  if (lines.some(event => event.seq > finish.seq
      && event !== finishFloor && !exactReceipt(event))) {
    throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');
  }
  const receipts = lines.filter(exactReceipt);
  if (receipts.length > 1) throw new Error('TERMINAL_ACCOUNTING_DUPLICATE');
  if (receipts.length === 1) {
    const priorUsage = processUsageFromEvent(receipts[0]);
    if (!sameMeasuredUsage(priorUsage, usage)) throw new Error('TERMINAL_ACCOUNTING_MISMATCH');
  }
  return accountingKey;
}

// Explicit cost report — its own withLock (needs to read the log to absorb the tick's floor before appending an
// ADJUSTED cost). Mirrors appendAnchored's verify→append→anchor→reconcile sequence; recomputeSpent stays a PURE
// sum so reconcileBudget agrees automatically. Negative/non-finite still rejected (validCost).
export function recordCost(root, runId, {
  turns = 0, tokens = 0, requestId, fence,
} = {}) {
  if (!validCost({ turns, tokens })) throw new Error(`INVALID_COST: turns/tokens must be finite >= 0 (got ${turns}/${tokens})`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId || '')) {
    throw new Error('ACCOUNTING_REQUEST_ID_REQUIRED');
  }
  if (!fence || typeof fence.owner !== 'string'
      || !Number.isSafeInteger(fence.generation) || fence.generation < 1) {
    throw new Error('BUDGET_ACCOUNTING_FENCE_REQUIRED');
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const requestIdDigest = contentHash(`budget-record-id\0${requestId}`);
  const requestDigest = contentHash(JSON.stringify({
    domain: 'budget-record-request-v1', request_id_digest: requestIdDigest,
    owner: fence.owner, generation: fence.generation, turns, tokens,
    runtime: fence.runtime ?? null, intent: fence.intent ?? null,
  }));
  const intentDigest = mutationIntentDigest('budget-record', callerBinding,
    { request_digest: requestDigest, turns, tokens,
      runtime: fence.runtime ?? null, intent: fence.intent ?? null });
  const replayFence = accountingReplayFence(fence, { leasePolicy: true });
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'BUDGET_FENCED: record' }, mutation => {
    if (recoveredCostEvent(root, runId, mutation, event =>
      event.data?.reported_turns === turns && event.data?.reported_tokens === tokens
      && event.data?.owner === fence.owner
      && event.data?.generation === fence.generation,
    { requestDigest, requestIdDigest, fenceCheck: replayFence })) return;
    const { data: loop, hash: baseStateHash } = readState(root, runId);
    const lease = loop.session_chain?.lease || {};
    const runtime = fence.runtime === undefined ? { ok: true } : runtimeFence(loop, fence.runtime);
    if (!runtime.ok) throw new Error(`LEASE_FENCED: ${runtime.reason}`);
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    const lines = readLines(root, runId);
    assertVerifiedRunSnapshot(root, runId, loop, { lines });
    const authorized = leaseCheck(loop, fence);
    if (!authorized.ok) throw new Error(`LEASE_FENCED: ${authorized.reason}`);
    if (loop.status === 'completed' || loop.status === 'stopped') {
      throw new Error('RUN_TERMINAL: recordCost');
    }
    const { tf, tk } = trailingFloor(lines, lease.owner_run_id, lease.generation);
    const adjTurns = Math.max(0, turns - tf), adjTokens = Math.max(0, tokens - tk);   // tick contribution = max(reported, floor-sum)
    const eventData = { turns: adjTurns, tokens: adjTokens, reported_turns: turns,
      reported_tokens: tokens, owner: lease.owner_run_id, generation: lease.generation,
      accounting_request_id_digest: requestIdDigest,
      accounting_request_digest: requestDigest };
    commitMeasuredCost(root, runId, loop, lines, baseStateHash, eventData,
      { owner: lease.owner_run_id, addedTurns: adjTurns, callerBinding, intentDigest,
        requireSession: false });
  });
}

function preflightUsageFromEvent(event) {
  return {
    num_turns: event.data?.reported_turns,
    input_tokens: event.data?.input_tokens,
    output_tokens: event.data?.output_tokens,
    tokens: event.data?.reported_tokens,
    ...(event.data?.cached_input_tokens !== undefined
      ? { cached_input_tokens: event.data.cached_input_tokens } : {}),
    ...(event.data?.reasoning_output_tokens !== undefined
      ? { reasoning_output_tokens: event.data.reasoning_output_tokens } : {}),
  };
}

function exactPreflightCostEvent(event, receipt, lines) {
  const eventIndex = lines.indexOf(event);
  if (eventIndex < 0 || !hasCanonicalEventData(event.data, [
    'turns',
    'tokens',
    'reported_turns',
    'reported_tokens',
    'input_tokens',
    'output_tokens',
    'owner',
    'generation',
    'source',
    'preflight_receipt_id',
    'preflight_cache_key',
    'preflight_smoke',
    'preflight_attempt_id',
    'predecessor_receipt_id',
  ])) return false;
  const priorLines = eventIndex < 0 ? [] : lines.slice(0, eventIndex);
  const { tf, tk } = trailingFloor(priorLines, receipt.owner, receipt.generation);
  let eventReceipt;
  try {
    eventReceipt = makeCodexPreflightReceipt({
      root: receipt.__root,
      runId: receipt.run_id,
      cacheKey: event.data?.preflight_cache_key,
      smokeKind: event.data?.preflight_smoke,
      attemptId: event.data?.preflight_attempt_id,
      predecessorReceiptId: event.data?.predecessor_receipt_id,
      owner: event.data?.owner,
      generation: event.data?.generation,
      usage: preflightUsageFromEvent(event),
    });
  } catch {
    return false;
  }
  return event.type === 'cost'
    && event.data?.source === 'codex-preflight-measured'
    && event.data?.preflight_receipt_id === receipt.receipt_id
    && eventReceipt.receipt_id === receipt.receipt_id
    && event.data?.preflight_cache_key === receipt.cache_key
    && event.data?.preflight_smoke === receipt.smoke_kind
    && event.data?.preflight_attempt_id === receipt.attempt_id
    && event.data?.predecessor_receipt_id === receipt.predecessor_receipt_id
    && event.data?.owner === receipt.owner
    && event.data?.generation === receipt.generation
    && event.data?.turns === Math.max(0, receipt.usage.num_turns - tf)
    && event.data?.tokens === Math.max(0, receipt.usage.tokens - tk)
    && sameMeasuredUsage(preflightUsageFromEvent(event), receipt.usage);
}

function samePreflightProcessIdentity(event, receipt) {
  return event.type === 'cost'
    && event.data?.preflight_cache_key === receipt.cache_key
    && event.data?.preflight_smoke === receipt.smoke_kind
    && event.data?.preflight_attempt_id === receipt.attempt_id;
}

function verifyPreflightWritePredecessor(runId, exact, lines) {
  if (exact.smoke_kind !== 'write') return;
  const predecessors = lines.filter(event => samePreflightProcessIdentity(event, {
    cache_key: exact.cache_key,
    smoke_kind: 'read',
    attempt_id: exact.attempt_id,
  }));
  if (predecessors.length === 0) throw new Error('PREFLIGHT_ACCOUNTING_PREDECESSOR_MISSING');
  if (predecessors.length !== 1) throw new Error('PREFLIGHT_ACCOUNTING_DUPLICATE');
  const predecessor = predecessors[0];
  let predecessorReceipt;
  try {
    predecessorReceipt = {
      ...makeCodexPreflightReceipt({
        root: exact.__root,
        runId,
        cacheKey: exact.cache_key,
        smokeKind: 'read',
        attemptId: exact.attempt_id,
        predecessorReceiptId: null,
        owner: exact.owner,
        generation: exact.generation,
        usage: preflightUsageFromEvent(predecessor),
      }),
      __root: exact.__root,
    };
  } catch {
    throw new Error('PREFLIGHT_ACCOUNTING_PREDECESSOR_INVALID');
  }
  if (predecessor.data?.preflight_receipt_id !== exact.predecessor_receipt_id
    || predecessorReceipt.receipt_id !== exact.predecessor_receipt_id
    || !exactPreflightCostEvent(predecessor, predecessorReceipt, lines)) {
    throw new Error('PREFLIGHT_ACCOUNTING_PREDECESSOR_INVALID');
  }
}

// A successful Codex preflight smoke is represented by an immutable, hash-bound receipt before an active cache
// can be published. The current accounting fence authorizes settlement, while the receipt's origin session owns
// the charge. An identical retry is a byte-preserving no-op even after the lease has legitimately advanced.
export function settleCodexPreflightCost(root, runId, { receipt, fence } = {}) {
  const exact = { ...validateCodexPreflightReceipt(root, runId, receipt), __root: canonicalProjectRoot(root) };
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isInteger(fence.generation) || fence.generation < 1
    || fence.intent !== 'accounting') {
    throw new Error('PREFLIGHT_ACCOUNTING_FENCE_REQUIRED');
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = mutationIntentDigest('budget-preflight-settle', callerBinding,
    { receipt_digest: contentHash(JSON.stringify(exact)) });
  const replayFence = accountingReplayFence(fence, { runtime: 'codex',
    runtimeMessage: 'RUNTIME_FENCED: preflight accounting requires codex' });
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'BUDGET_FENCED: preflight' }, mutation => {
    if (recoveredCostEvent(root, runId, mutation, event =>
      event.data?.preflight_receipt_id === exact.receipt_id
      && event.data?.preflight_cache_key === exact.cache_key,
    { fenceCheck: replayFence,
      policyCheck: loop => assertPreflightReplayPolicy(loop, fence) })) {
      return { ok: true, recorded: true, reason: 'recorded' };
    }
    const { data: loop, hash: baseStateHash } = readState(root, runId);
    const lease = loop.session_chain?.lease || {};
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (sessionRuntime(loop) !== 'codex') {
      throw new Error('RUNTIME_FENCED: preflight accounting requires codex');
    }
    const lines = readLines(root, runId);
    assertVerifiedRunSnapshot(root, runId, loop, { lines });
    const originSession = (loop.session_chain?.sessions || [])
      .find(session => session.run_id === exact.owner);
    if (!originSession || !Number.isSafeInteger(originSession.turns) || originSession.turns < 0) {
      throw new Error('PREFLIGHT_ACCOUNTING_ORIGIN_INVALID');
    }
    verifyPreflightWritePredecessor(runId, exact, lines);

    const receiptEvents = lines.filter(event => event.type === 'cost'
      && event.data?.preflight_receipt_id === exact.receipt_id);
    const identityEvents = lines.filter(event => samePreflightProcessIdentity(event, exact));
    const relatedEvents = new Set([...receiptEvents, ...identityEvents]);
    if (receiptEvents.length > 1 || identityEvents.length > 1 || relatedEvents.size > 1) {
      throw new Error('PREFLIGHT_ACCOUNTING_DUPLICATE');
    }
    if (receiptEvents.length === 1) {
      if (identityEvents[0] !== receiptEvents[0]
        || !exactPreflightCostEvent(receiptEvents[0], exact, lines)) {
        throw new Error('PREFLIGHT_ACCOUNTING_MISMATCH');
      }
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }
    if (identityEvents.length === 1) throw new Error('PREFLIGHT_ACCOUNTING_MISMATCH');

    const authorized = leaseCheck(loop, fence);
    if (!authorized.ok) throw new Error(`LEASE_FENCED: ${authorized.reason}`);
    const { tf, tk } = trailingFloor(lines, exact.owner, exact.generation);
    const adjustedTurns = Math.max(0, exact.usage.num_turns - tf);
    const adjustedTokens = Math.max(0, exact.usage.tokens - tk);
    const eventData = {
        turns: adjustedTurns,
        tokens: adjustedTokens,
        reported_turns: exact.usage.num_turns,
        reported_tokens: exact.usage.tokens,
        input_tokens: exact.usage.input_tokens,
        output_tokens: exact.usage.output_tokens,
        ...(exact.usage.cached_input_tokens !== undefined
          ? { cached_input_tokens: exact.usage.cached_input_tokens } : {}),
        ...(exact.usage.reasoning_output_tokens !== undefined
          ? { reasoning_output_tokens: exact.usage.reasoning_output_tokens } : {}),
        owner: exact.owner,
        generation: exact.generation,
        source: 'codex-preflight-measured',
        preflight_receipt_id: exact.receipt_id,
        preflight_cache_key: exact.cache_key,
        preflight_smoke: exact.smoke_kind,
        preflight_attempt_id: exact.attempt_id,
        predecessor_receipt_id: exact.predecessor_receipt_id,
    };
    commitMeasuredCost(root, runId, loop, lines, baseStateHash, eventData,
      { owner: exact.owner, addedTurns: adjustedTurns, callerBinding, intentDigest,
        requireSession: true });
    return { ok: true, recorded: true, reason: 'recorded' };
  });
}

function processUsageFromEvent(event) {
  return {
    num_turns: event.data?.reported_turns,
    input_tokens: event.data?.input_tokens,
    output_tokens: event.data?.output_tokens,
    tokens: event.data?.reported_tokens,
    ...(event.data?.cached_input_tokens !== undefined
      ? { cached_input_tokens: event.data.cached_input_tokens } : {}),
    ...(event.data?.reasoning_output_tokens !== undefined
      ? { reasoning_output_tokens: event.data.reasoning_output_tokens } : {}),
  };
}

function exactProcessCostEvent(event, exact, origin, lines) {
  const eventIndex = lines.indexOf(event);
  const followsFinish = eventIndex >= 0
    && lines.slice(0, eventIndex).some(item => item.type === 'finish');
  const terminalMaker = exact.process_kind === 'maker' && followsFinish;
  if (eventIndex < 0
    || !hasCanonicalEventData(event.data, [
      'turns',
      'tokens',
      'reported_turns',
      'reported_tokens',
      'input_tokens',
      'output_tokens',
      'owner',
      'generation',
      'source',
      'process_receipt_id',
      'process_kind',
      'process_context',
      ...(terminalMaker ? ['terminal_process'] : []),
    ])
    || (terminalMaker && event.data?.terminal_process !== 'codex-maker')
    || JSON.stringify(event.data?.process_context) !== JSON.stringify(exact.context)) return false;
  let reconstructed;
  try {
    reconstructed = makeCodexProcessReceipt({
      root: exact.__root,
      runId: exact.run_id,
      processKind: event.data?.process_kind,
      context: event.data?.process_context,
      usage: processUsageFromEvent(event),
    });
  } catch {
    return false;
  }
  const { tf, tk } = trailingFloor(
    lines.slice(0, eventIndex),
    origin.owner,
    origin.generation,
  );
  return event.type === 'cost'
    && event.data?.source === `codex-${exact.process_kind}-measured`
    && event.data?.process_receipt_id === exact.receipt_id
    && event.data?.process_kind === exact.process_kind
    && reconstructed.receipt_id === exact.receipt_id
    && sameMeasuredUsage(processUsageFromEvent(event), exact.usage)
    && event.data?.owner === origin.owner
    && event.data?.generation === origin.generation
    && event.data?.turns === Math.max(0, exact.usage.num_turns - tf)
    && event.data?.tokens === Math.max(0, exact.usage.tokens - tk);
}

function sameProcessIdentity(event, exact) {
  return event.type === 'cost'
    && event.data?.process_kind === exact.process_kind
    && JSON.stringify(event.data?.process_context) === JSON.stringify(exact.context);
}

// An exact event admitted by this writer leaves the stored budget reconciled with the verified cost log.
// This durable footprint distinguishes idempotent history from an append-only lookalike without trusting clocks.
function storedBudgetMatchesLines(loop, lines) {
  const spent = lines.filter(event => event.type === 'cost').reduce((total, event) => ({
    turns: total.turns + event.data.turns,
    tokens: total.tokens + event.data.tokens,
  }), { turns: 0, tokens: 0 });
  return loop.budget?.spent === spent.turns && loop.budget?.tokens_spent === spent.tokens;
}

function exactSession(loop, owner) {
  const session = (loop.session_chain?.sessions || []).find(item => item.run_id === owner);
  if (!session || !Number.isSafeInteger(session.turns) || session.turns < 0) {
    throw new Error('PROCESS_ACCOUNTING_ORIGIN_INVALID');
  }
  return session;
}

function makerContext(loop, exact, lines) {
  const context = exact.context;
  const parent = exactSession(loop, context.parent_owner);
  const child = exactSession(loop, context.child_run_id);
  if (child.handoff_rel !== context.handoff_rel) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  const handoffs = lines.filter(event => event.type === 'handoff-emitted'
    && event.data?.child_run_id === context.child_run_id
    && event.data?.key === context.handoff_key);
  if (handoffs.length !== 1) throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  return { context, parent, child };
}

function acquiredMakerContext(context, parent, child) {
  const acquired = typeof child.started_at === 'string'
    && Number.isFinite(Date.parse(child.started_at))
    && child.outcome !== 'failed_launch'
    && parent.outcome === 'took_over';
  if (acquired && parent.superseded_by !== context.child_run_id) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  if (!acquired && (child.started_at != null
    || (parent.superseded_by !== context.child_run_id && child.outcome !== 'failed_launch'))) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  return acquired;
}

function makerOrigin(loop, exact, lines) {
  const { context, parent, child } = makerContext(loop, exact, lines);
  const acquired = acquiredMakerContext(context, parent, child);
  return acquired
    ? { session: child, owner: context.child_run_id, generation: context.child_generation, acquired: true }
    : { session: parent, owner: context.parent_owner, generation: context.parent_generation, acquired: false };
}

function historicalMakerOrigin(loop, exact, event, lines) {
  const { context, parent, child } = makerContext(loop, exact, lines);
  const acquired = acquiredMakerContext(context, parent, child);
  if (event.data?.owner === context.parent_owner
    && event.data?.generation === context.parent_generation) {
    return {
      session: parent,
      owner: context.parent_owner,
      generation: context.parent_generation,
      acquired: false,
    };
  }
  if (event.data?.owner === context.child_run_id
    && event.data?.generation === context.child_generation) {
    if (!acquired) throw new Error('PROCESS_ACCOUNTING_MISMATCH');
    return {
      session: child,
      owner: context.child_run_id,
      generation: context.child_generation,
      acquired: true,
    };
  }
  throw new Error('PROCESS_ACCOUNTING_MISMATCH');
}

function checkerOrigin(loop, exact) {
  const context = exact.context;
  const checker = (loop.episodes || []).find(episode => episode.id === context.checker_episode_id);
  if (!checker || checker.attempt_id !== context.attempt_id
    || checker.target_maker !== context.target_maker
    || checker.review_claim?.lease_owner !== context.origin_owner
    || checker.review_claim?.lease_generation !== context.origin_generation
    || codexCheckerClaimHash(checker.review_claim) !== context.claim_hash) {
    throw new Error('PROCESS_ACCOUNTING_CONTEXT_MISMATCH');
  }
  return {
    session: exactSession(loop, context.origin_owner),
    owner: context.origin_owner,
    generation: context.origin_generation,
    acquired: false,
  };
}

function verifyTerminalMakerSettlement(loop, exact, origin, lines) {
  if (!origin.acquired || loop.status !== 'completed' && loop.status !== 'stopped') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const lease = loop.session_chain?.lease || {};
  if (lease.owner_run_id !== origin.owner || lease.generation !== origin.generation
    || lease.state !== 'active' || lease.handoff_phase !== 'acquired') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const finishes = lines.filter(event => event.type === 'finish');
  const finish = finishes[0];
  if (finishes.length !== 1 || finish.data?.status !== loop.status
    || typeof loop.termination?.finished_at !== 'string') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const finishFloor = lines.find(event => event.seq === finish.seq + 1
    && event.type === 'cost' && event.data?.auto_floor === true && event.data?.for === 'finish'
    && event.data?.owner === origin.owner && event.data?.generation === origin.generation);
  const handoff = lines.find(event => event.type === 'handoff-emitted'
    && event.data?.child_run_id === exact.context.child_run_id
    && event.data?.key === exact.context.handoff_key);
  if (!finishFloor || !handoff || handoff.seq >= finish.seq) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const forbidden = lines.some(event => event.seq > finish.seq
    && event !== finishFloor && !exactProcessCostEvent(event, exact, origin, lines));
  if (forbidden) throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
}

function verifyTerminalCheckerSettlement(loop, exact, origin, lines) {
  if (loop.status !== 'completed' && loop.status !== 'stopped') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const lease = loop.session_chain?.lease || {};
  if (lease.owner_run_id !== origin.owner || lease.generation !== origin.generation
    || lease.state !== 'active') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const checker = (loop.episodes || []).find(
    episode => episode.id === exact.context.checker_episode_id,
  );
  if (!['approved', 'rejected'].includes(checker?.status)
    || checker.review_source !== 'imported-stdin'
    || checker.attempt_id !== exact.context.attempt_id) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const outcomes = lines.filter(event => event.type === 'review-outcome'
    && event.data?.episodeId === exact.context.checker_episode_id
    && event.data?.attempt_id === exact.context.attempt_id
    && event.data?.target_maker === exact.context.target_maker
    && event.data?.review_source === 'imported-stdin');
  const finishes = lines.filter(event => event.type === 'finish');
  const outcome = outcomes[0];
  const finish = finishes[0];
  if (outcomes.length !== 1 || finishes.length !== 1 || outcome.seq >= finish.seq
    || finish.data?.status !== loop.status || typeof loop.termination?.finished_at !== 'string') {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
  const finishFloor = lines.find(event => event.seq === finish.seq + 1
    && event.type === 'cost' && event.data?.auto_floor === true && event.data?.for === 'finish'
    && event.data?.owner === origin.owner && event.data?.generation === origin.generation);
  if (!finishFloor) throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  const forbidden = lines.some(event => event.seq > finish.seq
    && event !== finishFloor && !exactProcessCostEvent(event, exact, origin, lines));
  if (forbidden) throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
}

function verifyStoppedPreImportCheckerSettlement(loop, exact, origin, lines) {
  const context = exact.context;
  const lease = loop.session_chain?.lease || {};
  const checker = (loop.episodes || []).find(
    episode => episode.id === context.checker_episode_id,
  );
  const claim = checker?.review_claim;
  if (loop.status !== 'stopped'
    || lease.owner_run_id !== origin.owner || lease.generation !== origin.generation
    || lease.state !== 'active'
    || checker?.status !== 'in_progress' || checker.review_source != null
    || !hasExactEventData(claim, [
      'run_id',
      'reviewer_id',
      'checker_episode_id',
      'target_maker',
      'attempt_id',
      'workstream_id',
      'point',
      'project_root',
      'runtime',
      'lease_owner',
      'lease_generation',
      'artifacts',
    ])
    || claim.run_id !== loop.run_id
    || claim.runtime !== 'codex'
    || claim.project_root !== exact.__root
    || claim.checker_episode_id !== context.checker_episode_id
    || claim.target_maker !== context.target_maker
    || claim.attempt_id !== context.attempt_id
    || claim.lease_owner !== origin.owner
    || claim.lease_generation !== origin.generation
    || !Array.isArray(claim.artifacts)) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const claimIdentityEvents = lines.filter(event => event.type === 'independent-review-claimed'
    && event.data?.episode_id === context.checker_episode_id
    && event.data?.attempt_id === context.attempt_id);
  const claimEvent = claimIdentityEvents[0];
  if (claimIdentityEvents.length !== 1
    || !hasExactEventData(claimEvent?.data, [
      'episode_id',
      'attempt_id',
      'reviewer_id',
      'target_maker',
      'workstream_id',
      'point',
      'artifacts',
      'proof_transitions',
    ])
    || claimEvent.data.reviewer_id !== claim.reviewer_id
    || claimEvent.data.target_maker !== claim.target_maker
    || claimEvent.data.workstream_id !== claim.workstream_id
    || claimEvent.data.point !== claim.point
    || JSON.stringify(claimEvent.data.artifacts) !== JSON.stringify(claim.artifacts)) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const finishes = lines.filter(event => event.type === 'finish');
  const finish = finishes[0];
  const finalReport = Object.hasOwn(loop.termination || {}, 'final_report')
    ? loop.termination.final_report : null;
  if (finishes.length !== 1
    || !hasExactEventData(finish?.data, ['status', 'reportRel'])
    || finish.data.status !== 'stopped'
    || finish.data.reportRel !== finalReport
    || claimEvent.seq >= finish.seq
    || typeof loop.termination?.finished_at !== 'string'
    || !Number.isFinite(Date.parse(loop.termination.finished_at))) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const finishFloor = lines.find(event => event.seq === finish.seq + 1);
  if (finishFloor?.type !== 'cost'
    || !hasExactEventData(finishFloor.data, [
      'turns', 'tokens', 'auto_floor', 'for', 'owner', 'generation',
    ])
    || finishFloor.data.turns !== MUTATION_TURN_FLOOR
    || finishFloor.data.tokens !== 0
    || finishFloor.data.auto_floor !== true
    || finishFloor.data.for !== 'finish'
    || finishFloor.data.owner !== origin.owner
    || finishFloor.data.generation !== origin.generation) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }

  const outcomes = lines.filter(event => event.type === 'review-outcome'
    && event.data?.episodeId === context.checker_episode_id
    && event.data?.attempt_id === context.attempt_id);
  const forbiddenAfterFinish = lines.some(event => event.seq > finish.seq
    && event !== finishFloor);
  if (outcomes.length !== 0 || forbiddenAfterFinish) {
    throw new Error('PROCESS_ACCOUNTING_TERMINAL_PROOF_MISSING');
  }
}

// Worker-owned maker/checker receipts are immutable before the trusted sync facade can return success.
// Settlement is authorized by the current accounting fence, but charges the context-derived origin session.
// Terminal exceptions are limited to the exact acquired maker with handoff + finish proof and the exact stopped,
// pre-import checker with claim + finish proof. Neither branch can alter proof, status, lease, or event shape.
export function settleCodexProcessCost(root, runId, { receipt, fence } = {}) {
  if (receipt?.contract === CODEX_PREFLIGHT_RECEIPT_CONTRACT) {
    return settleCodexPreflightCost(root, runId, { receipt, fence });
  }
  const exact = { ...validateCodexProcessReceipt(root, runId, receipt), __root: canonicalProjectRoot(root) };
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isInteger(fence.generation) || fence.generation < 1
    || fence.intent !== 'accounting') {
    throw new Error('PROCESS_ACCOUNTING_FENCE_REQUIRED');
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = mutationIntentDigest('budget-process-settle', callerBinding,
    { receipt_digest: contentHash(JSON.stringify(exact)) });
  const replayFence = accountingReplayFence(fence, { runtime: 'codex',
    runtimeMessage: 'RUNTIME_FENCED: process accounting requires codex' });
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'BUDGET_FENCED: process' }, mutation => {
    if (recoveredCostEvent(root, runId, mutation, event =>
      event.data?.process_receipt_id === exact.receipt_id
      && event.data?.process_kind === exact.process_kind,
    { fenceCheck: replayFence,
      policyCheck: (loop, lines) => assertProcessReplayPolicy(loop, lines, exact, fence) })) {
      return { ok: true, recorded: true, reason: 'recorded' };
    }
    const { data: loop, hash: baseStateHash } = readState(root, runId);
    const lease = loop.session_chain?.lease || {};
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (sessionRuntime(loop) !== 'codex') {
      throw new Error('RUNTIME_FENCED: process accounting requires codex');
    }
    const lines = readLines(root, runId);
    assertVerifiedRunSnapshot(root, runId, loop, { lines });
    const receiptEvents = lines.filter(event => event.type === 'cost'
      && event.data?.process_receipt_id === exact.receipt_id);
    const identityEvents = lines.filter(event => sameProcessIdentity(event, exact));
    const relatedEvents = new Set([...receiptEvents, ...identityEvents]);
    if (receiptEvents.length > 1 || identityEvents.length > 1 || relatedEvents.size > 1) {
      throw new Error('PROCESS_ACCOUNTING_DUPLICATE');
    }
    if (receiptEvents.length === 1) {
      if (!storedBudgetMatchesLines(loop, lines)) {
        throw new Error('PROCESS_ACCOUNTING_MISMATCH');
      }
      const origin = exact.process_kind === 'maker'
        ? historicalMakerOrigin(loop, exact, receiptEvents[0], lines)
        : checkerOrigin(loop, exact);
      if (identityEvents[0] !== receiptEvents[0]
        || !exactProcessCostEvent(receiptEvents[0], exact, origin, lines)) {
        throw new Error('PROCESS_ACCOUNTING_MISMATCH');
      }
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }
    if (identityEvents.length === 1) throw new Error('PROCESS_ACCOUNTING_MISMATCH');

    const origin = exact.process_kind === 'maker'
      ? makerOrigin(loop, exact, lines)
      : checkerOrigin(loop, exact);

    const authorized = leaseCheck(loop, fence);
    if (!authorized.ok) {
      if (authorized.reason !== 'RUN_TERMINAL') {
        throw new Error(`LEASE_FENCED: ${authorized.reason}`);
      }
      if (exact.process_kind === 'maker') verifyTerminalMakerSettlement(loop, exact, origin, lines);
      else if (exact.process_kind === 'checker') {
        const checker = (loop.episodes || []).find(
          episode => episode.id === exact.context.checker_episode_id,
        );
        if (loop.status === 'stopped' && checker?.status === 'in_progress') {
          verifyStoppedPreImportCheckerSettlement(loop, exact, origin, lines);
        } else {
          verifyTerminalCheckerSettlement(loop, exact, origin, lines);
        }
      }
      else throw new Error(`LEASE_FENCED: ${authorized.reason}`);
    }
    const { tf, tk } = trailingFloor(lines, origin.owner, origin.generation);
    const adjustedTurns = Math.max(0, exact.usage.num_turns - tf);
    const adjustedTokens = Math.max(0, exact.usage.tokens - tk);
    const eventData = {
        turns: adjustedTurns,
        tokens: adjustedTokens,
        reported_turns: exact.usage.num_turns,
        reported_tokens: exact.usage.tokens,
        input_tokens: exact.usage.input_tokens,
        output_tokens: exact.usage.output_tokens,
        ...(exact.usage.cached_input_tokens !== undefined
          ? { cached_input_tokens: exact.usage.cached_input_tokens } : {}),
        ...(exact.usage.reasoning_output_tokens !== undefined
          ? { reasoning_output_tokens: exact.usage.reasoning_output_tokens } : {}),
        owner: origin.owner,
        generation: origin.generation,
        source: `codex-${exact.process_kind}-measured`,
        process_receipt_id: exact.receipt_id,
        process_kind: exact.process_kind,
        process_context: exact.context,
        ...(exact.process_kind === 'maker'
          && (loop.status === 'completed' || loop.status === 'stopped')
          ? { terminal_process: 'codex-maker' } : {}),
    };
    commitMeasuredCost(root, runId, loop, lines, baseStateHash, eventData,
      { owner: origin.owner, addedTurns: adjustedTurns, callerBinding, intentDigest,
        requireSession: true });
    return { ok: true, recorded: true, reason: 'recorded' };
  });
}

// The measured headless Codex maker returns its usage only after the child process exits. A legitimate child may
// finish the run before that exit, so the ordinary recordCost path is correctly terminal-fenced by then. This is
// the one narrow settlement path: it accepts only one measured Codex turn, for the exact acquired child lease,
// after a kernel-authored matching finish event. It is deliberately not exposed by the CLI and cannot mutate
// status, proof, lease, or any caller-selected field/event. An identical retry is a no-write idempotent success.
export function settleTerminalCodexMakerCost(root, runId, {
  usage, fence, handoffKey,
} = {}) {
  if (!isMeasuredOneTurnUsage(usage)) throw new Error('TERMINAL_ACCOUNTING_USAGE_INVALID');
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)
    || fence.intent !== 'accounting') {
    throw new Error('TERMINAL_ACCOUNTING_FENCE_REQUIRED');
  }
  if (typeof handoffKey !== 'string' || !/^[a-f0-9]{16}$/.test(handoffKey)) {
    throw new Error('TERMINAL_ACCOUNTING_HANDOFF_INVALID');
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = mutationIntentDigest('budget-terminal-maker-settle', callerBinding,
    { usage_digest: contentHash(JSON.stringify(usage)), handoff_key: handoffKey });
  const replayFence = accountingReplayFence(fence, { runtime: 'codex',
    runtimeMessage: 'RUNTIME_FENCED: terminal maker settlement requires codex' });
  let replayAccountingKey = null;
  return withVerifiedMutationLock(root, runId, { callerBinding, intentDigest,
    fenceError: 'BUDGET_FENCED: terminal-maker' }, mutation => {
    if (recoveredCostEvent(root, runId, mutation, event =>
      event.data?.terminal_process === 'codex-maker'
      && event.data?.source === 'terminal-maker-measured'
      && event.data?.reported_turns === usage.num_turns
      && event.data?.reported_tokens === usage.tokens
      && event.data?.owner === fence.owner
      && event.data?.generation === fence.generation
      && event.data?.accounting_key === replayAccountingKey,
    { fenceCheck: replayFence,
      policyCheck: (loop, lines) => {
        replayAccountingKey = assertTerminalMakerReplayPolicy(
          loop, lines, { usage, fence, handoffKey });
      } })) {
      return { ok: true, recorded: true, reason: 'recorded' };
    }
    const { data: loop, hash: baseStateHash } = readState(root, runId);
    const lease = loop.session_chain?.lease || {};
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (sessionRuntime(loop) !== 'codex') throw new Error('RUNTIME_FENCED: terminal maker settlement requires codex');
    const lines = readLines(root, runId);
    assertVerifiedRunSnapshot(root, runId, loop, { lines });
    if (loop.status !== 'completed' && loop.status !== 'stopped') throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');
    if (lease.state !== 'active' || lease.handoff_phase !== 'acquired') {
      throw new Error('TERMINAL_ACCOUNTING_CHILD_NOT_ACQUIRED');
    }
    const session = (loop.session_chain?.sessions || []).find(item => item.run_id === fence.owner);
    if (!session || typeof session.started_at !== 'string' || !Number.isFinite(Date.parse(session.started_at))
      || session.outcome === 'failed_launch') {
      throw new Error('TERMINAL_ACCOUNTING_SESSION_INVALID');
    }
    if (!Number.isSafeInteger(session.turns) || session.turns < 0) {
      throw new Error('TERMINAL_ACCOUNTING_SESSION_INVALID');
    }

    const finishes = lines.filter(event => event.type === 'finish');
    const finish = finishes[0];
    if (finishes.length !== 1 || finish.data?.status !== loop.status
      || typeof loop.termination?.finished_at !== 'string') {
      throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');
    }
    const handoffs = lines.filter(event => event.type === 'handoff-emitted'
      && event.data?.child_run_id === fence.owner && event.data?.key === handoffKey);
    const finishFloor = lines.find(event => event.seq === finish.seq + 1
      && event.type === 'cost' && event.data?.auto_floor === true && event.data?.for === 'finish'
      && event.data?.owner === fence.owner && event.data?.generation === fence.generation);
    if (handoffs.length !== 1 || handoffs[0].seq >= finish.seq || !finishFloor) {
      throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');
    }
    const accountingKey = contentHash(`${runId}|${fence.owner}|${fence.generation}|${handoffKey}|${finish.checksum}`);
    const exactReceipt = event => event.type === 'cost'
      && event.data?.terminal_process === 'codex-maker'
      && event.data?.source === 'terminal-maker-measured'
      && event.data?.accounting_key === accountingKey
      && event.data?.owner === fence.owner
      && event.data?.generation === fence.generation;
    const forbiddenAfterFinish = lines.some(event => event.seq > finish.seq
      && event !== finishFloor
      && !exactReceipt(event));
    if (forbiddenAfterFinish) throw new Error('TERMINAL_ACCOUNTING_PROOF_MISSING');

    const receipts = lines.filter(event => event.type === 'cost'
      && event.data?.terminal_process === 'codex-maker'
      && event.data?.owner === fence.owner
      && event.data?.generation === fence.generation);
    if (receipts.length > 1) throw new Error('TERMINAL_ACCOUNTING_DUPLICATE');
    const prior = receipts[0];
    if (prior) {
      const priorUsage = {
        num_turns: prior.data.reported_turns,
        input_tokens: prior.data.input_tokens,
        output_tokens: prior.data.output_tokens,
        tokens: prior.data.reported_tokens,
        ...(prior.data.cached_input_tokens !== undefined ? { cached_input_tokens: prior.data.cached_input_tokens } : {}),
        ...(prior.data.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: prior.data.reasoning_output_tokens } : {}),
      };
      if (prior.data.accounting_key !== accountingKey || !sameMeasuredUsage(priorUsage, usage)) {
        throw new Error('TERMINAL_ACCOUNTING_MISMATCH');
      }
      return { ok: true, recorded: false, reason: 'already-recorded' };
    }

    const { tf, tk } = trailingFloor(lines, fence.owner, fence.generation);
    const adjTurns = Math.max(0, usage.num_turns - tf);
    const adjTokens = Math.max(0, usage.tokens - tk);
    const eventData = {
        turns: adjTurns,
        tokens: adjTokens,
        reported_turns: usage.num_turns,
        reported_tokens: usage.tokens,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ...(usage.cached_input_tokens !== undefined ? { cached_input_tokens: usage.cached_input_tokens } : {}),
        ...(usage.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: usage.reasoning_output_tokens } : {}),
        owner: fence.owner,
        generation: fence.generation,
        terminal_process: 'codex-maker',
        source: 'terminal-maker-measured',
        accounting_key: accountingKey,
    };
    commitMeasuredCost(root, runId, loop, lines, baseStateHash, eventData,
      { owner: fence.owner, addedTurns: adjTurns, callerBinding, intentDigest,
        requireSession: true });
    return { ok: true, recorded: true, reason: 'recorded' };
  });
}

// 저장된 budget vs event-log 재계산 비교 + log head 앵커 대조 — 불일치/손상/truncation 시 fail-stop
export function reconcileBudget(root, runId) {
  return withLock(root, runId, () => {
    const v = verifyLog(root, runId);
    if (!v.ok) throw new Error(`BUDGET_TAMPERED: event-log integrity: ${v.errors.join('; ')}`);
    const { data } = readState(root, runId);
    const h = verifyHead(root, runId, data.event_log_head);   // suffix truncation 탐지
    if (!h.ok) throw new Error(`BUDGET_TAMPERED: ${h.errors.join('; ')}`);
    const t = recomputeSpent(root, runId);
    if ((data.budget.spent || 0) !== t.turns || (data.budget.tokens_spent || 0) !== t.tokens) {
      throw new Error(`BUDGET_TAMPERED: stored ${data.budget.spent}/${data.budget.tokens_spent} != log ${t.turns}/${t.tokens}`);
    }
    return { turns: t.turns, tokens: t.tokens };
  });
}
