import { appendEvent, lastLogHead, readLines, recomputeSpent, verifyLog, verifyHead, validCost } from './integrity.mjs';
import { readState, writeState, withLock } from './state.mjs';
import { leaseCheck } from './lease.mjs';
import { sessionRuntime } from './runtime.mjs';
import { contentHash } from './envelope.mjs';

// #3: re-exported from integrity.mjs (the floor mechanism's home) so call sites/tests can import it from budget.mjs
// while state.mjs imports it directly from integrity.mjs (no state↔budget cycle).
export { MUTATION_TURN_FLOOR } from './integrity.mjs';

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

// Explicit cost report — its own withLock (needs to read the log to absorb the tick's floor before appending an
// ADJUSTED cost). Mirrors appendAnchored's verify→append→anchor→reconcile sequence; recomputeSpent stays a PURE
// sum so reconcileBudget agrees automatically. Negative/non-finite still rejected (validCost).
export function recordCost(root, runId, { turns = 0, tokens = 0, fence } = {}) {
  if (!validCost({ turns, tokens })) throw new Error(`INVALID_COST: turns/tokens must be finite >= 0 (got ${turns}/${tokens})`);
  return withLock(root, runId, () => {
    const { data: loop } = readState(root, runId);
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    // v1.6 (spec §2.3-7): recordCost는 자체 appendEvent+writeState 경로(appendAnchored 관문 비경유).
    // fence가 있으면 위 leaseCheck가 LEASE_FENCED: RUN_TERMINAL로 선착 — drive-headless의 LEASE_FENCED
    // swallow 계약 보존(순서가 계약). fence-less 직접 호출만 이 자체 가드가 잡는다.
    if (loop.status === 'completed' || loop.status === 'stopped') throw new Error('RUN_TERMINAL: recordCost');
    const v = verifyLog(root, runId); if (!v.ok) throw new Error(`LOG_TAMPERED: ${v.errors.join('; ')}`);
    const h = verifyHead(root, runId, loop.event_log_head); if (!h.ok) throw new Error(`LOG_TAMPERED: ${h.errors.join('; ')}`);
    const lease = loop.session_chain?.lease || {};
    const { tf, tk } = trailingFloor(readLines(root, runId), lease.owner_run_id, lease.generation);   // this session's tick floor only
    const adjTurns = Math.max(0, turns - tf), adjTokens = Math.max(0, tokens - tk);   // tick contribution = max(reported, floor-sum)
    appendEvent(root, runId, { type: 'cost', data: { turns: adjTurns, tokens: adjTokens, reported_turns: turns, reported_tokens: tokens, owner: lease.owner_run_id, generation: lease.generation } });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId);   // pure sum = prior + floors + adjusted = prior-session floors + max(reported, this-session floors)
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    // per_session_turn_cap 판정용 session.turns 도 max-rule을 따른다 — 이 tick 기여분 = tf(이미 floor로 반영) + adjTurns.
    const sess = (loop.session_chain?.sessions || []).find(s => s.run_id === lease.owner_run_id);
    if (sess) sess.turns = (sess.turns || 0) + adjTurns;
    writeState(root, runId, loop);
  });
}

// The measured headless Codex maker returns its usage only after the child process exits. A legitimate child may
// finish the run before that exit, so the ordinary recordCost path is correctly terminal-fenced by then. This is
// the one narrow settlement path: it accepts only one measured Codex turn, for the exact acquired child lease,
// after a kernel-authored matching finish event. It is deliberately not exposed by the CLI and cannot mutate
// status, proof, lease, or any caller-selected field/event. An identical retry is a no-write idempotent success.
export function settleTerminalCodexMakerCost(root, runId, { usage, fence, handoffKey } = {}) {
  if (!isMeasuredOneTurnUsage(usage)) throw new Error('TERMINAL_ACCOUNTING_USAGE_INVALID');
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)
    || fence.intent !== 'accounting') {
    throw new Error('TERMINAL_ACCOUNTING_FENCE_REQUIRED');
  }
  if (typeof handoffKey !== 'string' || !/^[a-f0-9]{16}$/.test(handoffKey)) {
    throw new Error('TERMINAL_ACCOUNTING_HANDOFF_INVALID');
  }
  return withLock(root, runId, () => {
    const { data: loop } = readState(root, runId);
    const lease = loop.session_chain?.lease || {};
    if (lease.owner_run_id !== fence.owner) throw new Error('LEASE_FENCED: owner-mismatch');
    if (lease.generation !== fence.generation) throw new Error('LEASE_FENCED: generation-mismatch');
    if (loop.status !== 'completed' && loop.status !== 'stopped') throw new Error('RUN_NOT_TERMINAL: terminal maker settlement');
    if (sessionRuntime(loop) !== 'codex') throw new Error('RUNTIME_FENCED: terminal maker settlement requires codex');
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

    const v = verifyLog(root, runId);
    if (!v.ok) throw new Error(`LOG_TAMPERED: ${v.errors.join('; ')}`);
    const h = verifyHead(root, runId, loop.event_log_head);
    if (!h.ok) throw new Error(`LOG_TAMPERED: ${h.errors.join('; ')}`);
    const lines = readLines(root, runId);
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
    appendEvent(root, runId, {
      type: 'cost',
      data: {
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
      },
    });
    loop.event_log_head = lastLogHead(root, runId);
    const spent = recomputeSpent(root, runId);
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    session.turns += adjTurns;
    writeState(root, runId, loop);
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
