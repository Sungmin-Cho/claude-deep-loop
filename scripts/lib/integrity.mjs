import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './envelope.mjs';
import { runDir, readState, writeState, withLock } from './state.mjs';
import { assertProjectRootBinding, canonicalProjectRoot, projectRootDigest } from './project-root.mjs';
import { validate } from './schema.mjs';

const logPath = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');

// #3: every business-intent mutation is charged at least this many turns via appendAnchored's `opts.floor`
// (paired cost, same anchor). Lives here (with the floor mechanism) so both state.mjs and budget.mjs can import
// it without a state↔budget cycle; budget.mjs re-exports it for call sites/tests.
export const MUTATION_TURN_FLOOR = 1;

export function readLines(root, runId) {
  const p = logPath(root, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function checksumFor(seq, ts, type, data, prev) {
  return contentHash(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`);
}

function nextEvent(lines, { type, data, now }) {
  const prev = lines.length ? lines[lines.length - 1].checksum : 'GENESIS';
  const seq = lines.length + 1;
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_NOW: event timestamp');
  const ts = date.toISOString();
  const checksum = checksumFor(seq, ts, type, data, prev);
  return { seq, ts, type, data, checksum };
}

export function appendEvent(root, runId, { type, data, now }) {
  const event = nextEvent(readLines(root, runId), { type, data, now });
  appendFileSync(logPath(root, runId), JSON.stringify(event) + '\n');
  return event;
}

// line-based 검증 — 호출자가 이미 읽어둔 in-memory 배열을 검증한다. "검증한 배열 == 분석하는 배열"이
// 필요한 소비자(insights의 단일 읽기 스냅샷)가 디스크 재읽기 없이 쓴다 (impl-R2 🟡2: verifyHead와
// readLines 사이 concurrent append가 검증 밖 suffix로 유입되는 창 제거).
export function verifyLines(lines) {
  const errors = [];
  let prev = 'GENESIS';
  lines.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`seq gap at ${i + 1}`);
    if (e.checksum !== checksumFor(e.seq, e.ts, e.type, e.data, prev)) errors.push(`checksum break at seq ${e.seq}`);
    if (e.type === 'cost' && !validCost(e.data)) errors.push(`invalid cost data at seq ${e.seq}`);
    prev = e.checksum;
  });
  return { ok: errors.length === 0, errors };
}

export function verifyLog(root, runId) {
  return verifyLines(readLines(root, runId));
}

// cost turns/tokens는 유한 비음수만 허용 (음수 주입으로 spent를 낮추는 우회 차단, Codex impl 🔴2)
export function validCost(d) {
  return d && Number.isFinite(d.turns) && d.turns >= 0 && Number.isFinite(d.tokens) && d.tokens >= 0;
}

export function recomputeSpent(root, runId) {
  return readLines(root, runId).filter(e => e.type === 'cost').reduce((acc, e) => {
    if (!validCost(e.data)) throw new Error(`LOG_CORRUPT: invalid cost event at seq ${e.seq}`);
    return { turns: acc.turns + e.data.turns, tokens: acc.tokens + e.data.tokens };
  }, { turns: 0, tokens: 0 });
}

// 마지막 이벤트의 head {seq, checksum} (빈 로그면 GENESIS) — loop.json 앵커와 대조용 (Codex impl 🔴3)
export function headOfLines(lines) {
  return lines.length ? { seq: lines[lines.length - 1].seq, checksum: lines[lines.length - 1].checksum } : { seq: 0, checksum: 'GENESIS' };
}

export function lastLogHead(root, runId) {
  return headOfLines(readLines(root, runId));
}

// 로그 tail이 기대 head와 일치하는지 — suffix truncation 탐지. line-based 변형은 verifyLines와 같은
// 이유(검증 배열과 소비 배열의 동일성)로 존재한다.
export function verifyHeadLines(lines, expected) {
  const exp = expected || { seq: 0, checksum: 'GENESIS' };
  const head = headOfLines(lines);
  if (head.seq !== exp.seq || head.checksum !== exp.checksum) {
    return { ok: false, errors: [`log head ${head.seq}/${head.checksum} != anchor ${exp.seq}/${exp.checksum}`] };
  }
  return { ok: true, errors: [] };
}

export function verifyHead(root, runId, expected) {
  return verifyHeadLines(readLines(root, runId), expected);
}

// 단일 anchored append 경로 — 이벤트 append + loop.json의 event_log_head 앵커 갱신을 한 lock 안에서.
// 모든 이벤트 기록(cost 포함)은 이 경로를 통해야 앵커가 stale되지 않는다 (Codex impl r2 🟡).
// mutate(loop, spent): 호출자별 상태 변경(예: budget.spent) — 선택.
// preCheck(loop): lock 안 fresh loop 위에서 실행 — throw하면 append 전에 중단 (Codex r3 🔴: 가드 원자성).
// opts.floor (#3): a business-intent mutation is charged a minimum floor of `opts.floor` turns via a PAIRED cost
// event appended in the SAME lock/anchor, so a driver cannot neutralize the turns budget / per_session_turn_cap by
// under-reporting or skipping `budget record`. Omitting floor (control-plane appends, recordCost) keeps the old
// behavior exactly — floor is strictly opt-in.
export function appendAnchored(root, runId, { type, data }, mutate, preCheck, opts = {}) {
  return withLock(root, runId, () => {
    const { data: loop } = readState(root, runId);
    // Defense in depth at the shared mutation gateway: this check stays inside the existing lock and precedes
    // caller guards and event writes. readState is already strict, so no unbound reader is exposed here.
    assertProjectRootBinding(root, loop);
    let clock;
    if (opts.nowFn !== undefined) {
      if (typeof opts.nowFn !== 'function') throw new Error('INVALID_NOW: nowFn');
      const sampled = opts.nowFn();
      if (typeof sampled !== 'number' || !Number.isFinite(sampled)) {
        throw new Error('INVALID_NOW: anchored clock');
      }
      const date = new Date(sampled);
      if (!Number.isFinite(date.getTime())) {
        throw new Error('INVALID_NOW: anchored clock');
      }
      clock = Object.freeze({ ms: sampled, iso: date.toISOString() });
    }
    if (preCheck) preCheck(loop, clock);              // throws BEFORE append → anchor stays consistent
    // v1.6 gateway terminal gate (spec §2.1.5): 반드시 caller preCheck **뒤** — fence-first 보존
    // (LEASE_FENCED/RESPAWN_FENCED/RUN_TERMINAL:emitHandoff 등 특정-에러 경로가 먼저 발화해야 한다).
    // 여기 도달했는데 terminal이면 "어떤 preCheck도 못 잡은" fence-less 경로 — 최후 방벽.
    // finish 이벤트는 preCheck 시점 non-terminal(전이는 mutate 단계)이라 자연 통과; double-finish는 차단된다.
    if (loop.status === 'completed' || loop.status === 'stopped') throw new Error('RUN_TERMINAL: append');
    // Codex impl r12 🔴: verify the existing log (chain + tail vs stored anchor) BEFORE appending. Otherwise a
    // suffix-truncated/tampered log would be laundered — a new append + fresh anchor would hide the loss and
    // reconcileBudget would no longer detect it. Fail-stop here keeps the anchor honest.
    const v = verifyLog(root, runId);
    if (!v.ok) throw new Error(`LOG_TAMPERED: ${v.errors.join('; ')}`);
    const h = verifyHead(root, runId, loop.event_log_head);
    if (!h.ok) throw new Error(`LOG_TAMPERED: ${h.errors.join('; ')}`);
    appendEvent(root, runId, { type, data, now: clock?.ms });
    // Paired floor cost — SAME lock/anchor as the mutation event, so verifyHead/reconcileBudget stay consistent.
    // impl-R1 Fix 1: tag the floor with the CURRENT lease owner+generation. recordCost only absorbs floors from its
    // OWN session, so an explicit report in a LATER session cannot swallow an EARLIER session's floors (which are
    // confirmed prior consumption) — that would undercount total spent and weaken per_session_turn_cap.
    if (opts.floor) {
      const lease = loop.session_chain?.lease || {};
      appendEvent(root, runId, { type: 'cost', data: { turns: opts.floor, tokens: 0, auto_floor: true, for: type, owner: lease.owner_run_id, generation: lease.generation }, now: clock?.ms });
    }
    loop.event_log_head = lastLogHead(root, runId);   // floor present → the cost event is the head
    const spent = (mutate || opts.floor) ? recomputeSpent(root, runId) : null;
    if (opts.floor) {
      loop.budget.spent = spent.turns;
      loop.budget.tokens_spent = spent.tokens;
      // per_session_turn_cap is judged off the lease owner's session.turns (next-action.mjs) — bump it here so
      // the floor drives the handoff cadence (= human checkpoints) too, not only budget.spent.
      const owner = loop.session_chain?.lease?.owner_run_id;
      const sess = (loop.session_chain?.sessions || []).find(s => s.run_id === owner);
      if (sess) sess.turns = (sess.turns || 0) + opts.floor;
    }
    if (mutate) mutate(loop, spent, clock);
    writeState(root, runId, loop);
  });
}

// Root relocation is the sole mutation that cannot enter appendAnchored: the old lexical root is intentionally
// unresolvable, while appendAnchored performs a strict bound read and owns its own non-reentrant lock. The caller
// already owns the candidate run lock. This fixed commit accepts neither a caller-selected event nor a mutation
// callback; all validation completes before its single hard-coded append.
export function commitProjectRootRebindUnderLock(root, runId, loop, { oldRootDigest, newRoot, now }) {
  if (!loop || typeof loop !== 'object' || loop.run_id !== runId) {
    throw new Error('STATE_INVALID: loop.run_id mismatch');
  }
  if (!/^[0-9a-f]{64}$/.test(oldRootDigest || '') || projectRootDigest(loop.project?.root) !== oldRootDigest) {
    throw new Error('INVALID_STORED_ROOT_DIGEST: stored root changed');
  }
  let canonicalRoot;
  try {
    canonicalRoot = canonicalProjectRoot(root);
    if (canonicalProjectRoot(newRoot) !== canonicalRoot || newRoot !== canonicalRoot) {
      throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed');
    }
  } catch (error) {
    if (String(error?.message || error) === 'PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed') throw error;
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root', { cause: error });
  }

  const lines = readLines(root, runId);
  const verified = verifyLines(lines);
  if (!verified.ok) throw new Error(`LOG_TAMPERED: ${verified.errors.join('; ')}`);
  const anchored = verifyHeadLines(lines, loop.event_log_head);
  if (!anchored.ok) throw new Error(`LOG_TAMPERED: ${anchored.errors.join('; ')}`);

  const data = { old_root_digest: oldRootDigest, new_root: canonicalRoot };
  const event = nextEvent(lines, { type: 'project-root-rebound', data, now });
  const candidate = structuredClone(loop);
  candidate.project.root = canonicalRoot;
  candidate.event_log_head = { seq: event.seq, checksum: event.checksum };
  const stateValidation = validate(candidate);
  if (!stateValidation.ok) throw new Error(`STATE_INVALID: ${stateValidation.errors.join('; ')}`);

  appendFileSync(logPath(root, runId), JSON.stringify(event) + '\n');
  writeState(root, runId, candidate);
  return { ok: true };
}
