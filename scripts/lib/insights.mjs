import { readdirSync, readFileSync, existsSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runDir, readState } from './state.mjs';
import { readLines, verifyLog, verifyHead, appendAnchored, MUTATION_TURN_FLOOR } from './integrity.mjs';
import { contentHash, wrap, unwrap, ulid, atomicWrite } from './envelope.mjs';
import { leaseCheck } from './lease.mjs';

export const INSIGHTS_SCHEMA_VERSION = 1;

// 스펙 §5 — 임계값 고정 상수 (v1 설정화 ❌)
export const CANDIDATE_RULES = {
  FIX_CYCLES_HIGH: 1.0,        // (ws,point)당 평균 fix_cycles ≥
  PAUSE_FREQUENCY: 2,          // run-paused ≥
  CROSS_RUN_MIN: 3,            // cross-run 후보 최소 run 수
};

export function computeRunMetrics(loop, events) {
  const eps = loop.episodes || [];
  const byId = new Map(eps.map(e => [e.id, e]));
  const count = (arr, key) => arr.reduce((a, e) => ((a[e[key]] = (a[e[key]] || 0) + 1), a), {});
  const terminal = { done: 0, approved: 0, rejected: 0, abandoned: 0 };
  for (const e of eps) if (terminal[e.status] !== undefined) terminal[e.status]++;
  // abandoned는 loop.episodes 상태에도 남지만 소스 규약(§4)은 episode-abandon 이벤트 — 이벤트 기준으로 덮어쓴다.
  terminal.abandoned = events.filter(e => e.type === 'episode-abandon').length;

  const per_point = {}; const fix_cycles = {};
  for (const ev of events.filter(e => e.type === 'review-outcome')) {
    const ep = byId.get(ev.data.episodeId) || {};
    const point = ep.point || 'unknown';
    const p = (per_point[point] ||= { checker_count: 0, approve: 0, request_changes: 0, concern: 0 });
    p.checker_count++;
    if (ev.data.verdict === 'APPROVE') p.approve++;
    else if (ev.data.verdict === 'REQUEST_CHANGES') {
      p.request_changes++;
      const k = `${ep.workstream_id || 'unknown'}|${point}`;
      fix_cycles[k] = (fix_cycles[k] || 0) + 1;
    } else if (ev.data.verdict === 'CONCERN') p.concern++;
  }

  const costs = events.filter(e => e.type === 'cost');
  const cost = {
    turns: costs.reduce((a, e) => a + (e.data.turns || 0), 0),
    tokens: costs.reduce((a, e) => a + (e.data.tokens || 0), 0),
    auto_floor_turns: costs.filter(e => e.data.auto_floor).reduce((a, e) => a + e.data.turns, 0),
    auto_floor_by_for: costs.filter(e => e.data.auto_floor && e.data.for)
      .reduce((a, e) => ((a[e.data.for] = (a[e.data.for] || 0) + e.data.turns), a), {}),
  };

  const acks = events.filter(e => e.type === 'comprehension-ack');
  const firstDispatch = events.find(e => e.type === 'episode-record' && e.data.status === 'in_progress');
  const firstHumanAck = acks.find(e => e.data.actor === 'human');
  const hasMaker = eps.some(e => e.role === 'maker');
  const ack_before_first_dispatch = !hasMaker ? null
    : Boolean(firstHumanAck && (!firstDispatch || firstHumanAck.seq < firstDispatch.seq));

  const pausedEvents = events.filter(e => e.type === 'run-paused');
  const last = events[events.length - 1];
  return {
    run_id: loop.run_id, goal: loop.goal, recipe: loop.recipe?.id ?? null,
    protocol: loop.routing?.protocol ?? null, status: loop.status,
    created_at: loop.created_at ?? null,
    last_event_at: last ? last.ts : null,
    last_seq: last ? last.seq : 0,
    wallclock_sec: (last && loop.created_at) ? Math.round((Date.parse(last.ts) - Date.parse(loop.created_at)) / 1000) : 0,
    episodes: { total: eps.length, by_role: count(eps, 'role'), by_kind: count(eps, 'kind'), by_point: count(eps, 'point'), terminal },
    review: { per_point, fix_cycles },
    // Honest semantics: only the END-OF-RUN latch is observable — the kernel emits no breaker trip/reset
    // events (trips latch inline in review-outcome's mutate; resetBreaker writes state without an event),
    // so mid-run trip→reset history is NOT reconstructable. 0/1, not a lifetime count.
    breaker: { trips: loop.circuit_breaker?.tripped ? 1 : 0,
      max_consecutive_rc: loop.circuit_breaker?.consecutive_request_changes ?? 0 },
    cost,
    sessions: { count: (loop.session_chain?.sessions || []).length,
      handoffs: events.filter(e => e.type === 'handoff-emitted').length,
      handoff_reasons: events.filter(e => e.type === 'handoff-emitted').map(e => e.data.reason ?? null),
      respawn: { spawned: events.filter(e => e.type === 'respawn-spawned').length,
        failed: events.filter(e => e.type === 'respawn-failed').length,
        timeout: events.filter(e => e.type === 'respawn-timeout').length } },
    pauses: { count: pausedEvents.length, reasons: pausedEvents.map(e => e.data.reason ?? null),
      recovered: events.filter(e => e.type === 'run-recovered').length },
    comprehension: { ack_human: acks.filter(e => e.data.actor === 'human').length,
      ack_agent: acks.filter(e => e.data.actor === 'agent').length,
      ack_rejected: events.filter(e => e.type === 'comprehension-ack-rejected').length,
      ack_before_first_dispatch },
  };
}
