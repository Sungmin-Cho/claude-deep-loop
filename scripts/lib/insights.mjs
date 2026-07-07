import { readdirSync, readFileSync, existsSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runDir, readState } from './state.mjs';
import { readLines, verifyLines, verifyHeadLines, appendAnchored, MUTATION_TURN_FLOOR } from './integrity.mjs';
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
  // 버킷 키(point/kind/for/run_id)는 episode new가 임의 문자열을 허용하는 user-supplied 값 —
  // plain {}에 '__proto__' 키를 넣으면 Object.prototype 오염/집계 유실이 나므로 모든 버킷은 null-prototype.
  const count = (arr, key) => arr.reduce((a, e) => ((a[e[key]] = (a[e[key]] || 0) + 1), a), Object.create(null));
  const terminal = { done: 0, approved: 0, rejected: 0, abandoned: 0 };
  for (const e of eps) if (terminal[e.status] !== undefined) terminal[e.status]++;
  // abandoned는 loop.episodes 상태에도 남지만 소스 규약(§4)은 episode-abandon 이벤트 — 이벤트 기준으로 덮어쓴다.
  terminal.abandoned = events.filter(e => e.type === 'episode-abandon').length;

  const per_point = Object.create(null); const fix_cycles = Object.create(null);
  for (const ev of events.filter(e => e.type === 'review-outcome')) {
    const ep = byId.get(ev.data.episodeId) || {};
    const point = ep.point || 'unknown';
    const p = (per_point[point] ||= { checker_count: 0, approve: 0, request_changes: 0, concern: 0 });
    p.checker_count++;
    // 분모 시드: 리뷰된 (ws,point) 쌍은 verdict와 무관하게 0부터 존재해야 한다 — RC-only 분모는
    // 평균을 항상 ≥1로 퇴화시켜 임계 1.0(스펙 §5)이 무의미해진다 (impl-R3 🟡A).
    const k = `${ep.workstream_id || 'unknown'}|${point}`;
    fix_cycles[k] ||= 0;
    if (ev.data.verdict === 'APPROVE') p.approve++;
    else if (ev.data.verdict === 'REQUEST_CHANGES') {
      p.request_changes++;
      fix_cycles[k] += 1;
    } else if (ev.data.verdict === 'CONCERN') p.concern++;
  }

  const costs = events.filter(e => e.type === 'cost');
  const cost = {
    turns: costs.reduce((a, e) => a + (e.data.turns || 0), 0),
    tokens: costs.reduce((a, e) => a + (e.data.tokens || 0), 0),
    auto_floor_turns: costs.filter(e => e.data.auto_floor).reduce((a, e) => a + e.data.turns, 0),
    auto_floor_by_for: costs.filter(e => e.data.auto_floor && e.data.for)
      .reduce((a, e) => ((a[e.data.for] = (a[e.data.for] || 0) + e.data.turns), a), Object.create(null)),
  };

  const acks = events.filter(e => e.type === 'comprehension-ack');
  const firstDispatch = events.find(e => e.type === 'episode-record' && e.data.status === 'in_progress');
  const firstHumanAck = acks.find(e => e.data.actor === 'human');
  const hasMaker = eps.some(e => e.role === 'maker');
  const ack_before_first_dispatch = !hasMaker ? null
    : Boolean(firstHumanAck && (!firstDispatch || firstHumanAck.seq < firstDispatch.seq));

  const pausedEvents = events.filter(e => e.type === 'run-paused');
  const last = events[events.length - 1];
  const budget = loop.budget || null;
  return {
    run_id: loop.run_id, goal: loop.goal, recipe: loop.recipe?.id ?? null,
    protocol: loop.routing?.protocol ?? null, status: loop.status,
    created_at: loop.created_at ?? null,
    last_event_at: last ? last.ts : null,
    last_seq: last ? last.seq : 0,
    wallclock_sec: (last && loop.created_at) ? Math.round((Date.parse(last.ts) - Date.parse(loop.created_at)) / 1000) : 0,
    episodes: { total: eps.length, by_role: count(eps, 'role'), by_kind: count(eps, 'kind'), by_point: count(eps, 'point'), terminal },
    review: { per_point, fix_cycles },
    // §5 budget_overrun 경계 산정용 — loop.budget이 없으면(콜드스타트/구버전 fixture) null.
    budget_ratio: loop.budget && loop.budget.total > 0 ? (loop.budget.spent / loop.budget.total) : null,
    soft_stop_ratio: budget ? budget.soft_stop_ratio : null,
    // Honest semantics: only the END-OF-RUN latch is observable — the kernel emits no breaker trip/reset
    // events (trips latch inline in review-outcome's mutate; resetBreaker writes state without an event),
    // so mid-run trip→reset history is NOT reconstructable. 0/1, not a lifetime count.
    breaker: { trips: loop.circuit_breaker?.tripped ? 1 : 0,
      trip_reason: loop.circuit_breaker?.trip_reason ?? null,
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

// review.fix_cycles 키는 computeRunMetrics에서 `${workstream_id}|${point}` 형태로 만든다 (§5 fix_cycles 정의).
// point는 첫 '|' 뒤 나머지 전부 — workstream_id 자체가 '|'를 포함할 일은 없다는 가정 하에 안전하다.
function pointOf(key) {
  const idx = key.indexOf('|');
  return idx === -1 ? key : key.slice(idx + 1);
}

// point별로 (ws,point) raw fix_cycles 항목을 모든 run에 걸쳐 pool한다 — fix_cycles_high(§5)와
// aggregates.avg_fix_cycles_by_point가 공유하는 집계.
function fixCyclesPointStats(perRunMap, runIds) {
  const stats = Object.create(null);
  for (const runId of runIds) {
    const m = perRunMap[runId];
    for (const [key, val] of Object.entries(m.review?.fix_cycles || {})) {
      const point = pointOf(key);
      const e = (stats[point] ||= { sum: 0, n: 0, recipes: [] });
      e.sum += val; e.n += 1;
      if (m.recipe && !e.recipes.includes(m.recipe)) e.recipes.push(m.recipe);
    }
  }
  return stats;
}

// run 하나 안에서 point별 평균 fix_cycles (같은 point에 여러 workstream이 걸쳐있을 수 있음) —
// fix_convergence_slow(§5)의 cross-run 시계열 한 점을 만드는 데 쓰인다.
function perRunPointAverages(fixCycles) {
  const acc = Object.create(null);
  for (const [key, val] of Object.entries(fixCycles || {})) {
    const point = pointOf(key);
    const e = (acc[point] ||= { sum: 0, n: 0 });
    e.sum += val; e.n += 1;
  }
  const out = Object.create(null);
  for (const [point, { sum, n }] of Object.entries(acc)) out[point] = sum / n;
  return out;
}

const recipeHints = (recipes) => (recipes || []).map(r => `recipes/${r}.json`);

// cross-run 집계 — aggregates.avg_fix_cycles_by_point 전용 (deriveCandidates와 동일 pooling 규약 재사용).
export function avgFixCyclesByPoint(perRunMap) {
  const runIds = Object.keys(perRunMap).sort();
  const stats = fixCyclesPointStats(perRunMap, runIds);
  const out = Object.create(null);
  for (const [point, { sum, n }] of Object.entries(stats)) out[point] = sum / n;
  return out;
}

// 스펙 §5 규칙표를 코드로 옮긴 순수 함수 — I/O 없음. cross-run 시간순은 반드시
// `Object.keys(perRunMap).sort()`(run_id ULID = 생성 시각순)로 고정한다 — 삽입순 의존 금지.
export function deriveCandidates(perRunMap, { integrityFailed = [] } = {}) {
  const runIds = Object.keys(perRunMap).sort();
  const candidates = [];

  // fix_cycles_high:<point> — 해당 point의 (ws,point)당 평균 fix_cycles ≥ 임계치(모든 run pool).
  const pointStats = fixCyclesPointStats(perRunMap, runIds);
  for (const [point, { sum, n, recipes }] of Object.entries(pointStats)) {
    const avg = sum / n;
    if (avg >= CANDIDATE_RULES.FIX_CYCLES_HIGH) {
      candidates.push({
        id: `fix_cycles_high:${point}`, metric: 'fix_cycles_avg', value: avg,
        threshold: CANDIDATE_RULES.FIX_CYCLES_HIGH, min_runs: 1, scope: 'run',
        target_hints: recipeHints(recipes), target_tier: 1,
        note: `point '${point}' 평균 fix_cycles ${avg.toFixed(2)} — T1: recipe 힌트 반영, ` +
          `T2: point 지침·review-strategy.md(human-proposal) + init 환류(max_review_rounds) 검토`,
      });
    }
  }

  // breaker_trip — tripped ≥ 1 (§4 note: 0/1 end-of-run latch, 생애주기 카운트 아님).
  {
    let sum = 0; const recipes = [];
    for (const runId of runIds) {
      const m = perRunMap[runId];
      const t = m.breaker?.trips || 0;
      sum += t;
      if (t >= 1 && m.recipe && !recipes.includes(m.recipe)) recipes.push(m.recipe);
    }
    if (sum >= 1) {
      candidates.push({
        id: 'breaker_trip', metric: 'breaker_trips_count', value: sum,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: recipeHints(recipes), target_tier: 1,
        note: 'circuit breaker trip 발생 — T1: trip 사유 연관 recipe, T2: 제어 스킬 안내(human-proposal)',
      });
    }
  }

  // respawn_failure — respawn-failed + respawn-timeout ≥ 1.
  {
    let sum = 0;
    for (const runId of runIds) {
      const r = perRunMap[runId].sessions?.respawn || {};
      sum += (r.failed || 0) + (r.timeout || 0);
    }
    if (sum >= 1) {
      candidates.push({
        id: 'respawn_failure', metric: 'respawn_failures_count', value: sum,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: [], target_tier: 2,
        note: 'respawn 실패/타임아웃 발생 — respawn/handoff 지침(T2, human-proposal)',
      });
    }
  }

  // bootstrap_ack_friction — ack_before_first_dispatch === true (maker episode ≥ 1인 run에서만 정의된 값이므로
  // null/false는 자연히 걸러진다).
  {
    let count = 0;
    for (const runId of runIds) if (perRunMap[runId].comprehension?.ack_before_first_dispatch === true) count++;
    if (count >= 1) {
      candidates.push({
        id: 'bootstrap_ack_friction', metric: 'ack_before_first_dispatch_count', value: count,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: [], target_tier: 2,
        note: 'ack가 첫 dispatch보다 선행 — init·continue 부트스트랩 안내(T2), init 환류(debt_threshold)',
      });
    }
  }

  // budget_overrun — 소진율(budget_ratio) ≥ soft_stop_ratio. run마다 자기 자신의 soft_stop_ratio가 임계치이므로
  // 가장 크게 초과한 run을 대표값으로 보고한다.
  {
    let best = null;
    for (const runId of runIds) {
      const m = perRunMap[runId];
      const ratio = m.budget_ratio, soft = m.soft_stop_ratio;
      if (ratio == null || soft == null) continue;
      if (ratio >= soft && (!best || ratio > best.ratio)) best = { ratio, soft, recipe: m.recipe };
    }
    if (best) {
      candidates.push({
        id: 'budget_overrun', metric: 'budget_ratio', value: best.ratio,
        threshold: best.soft, min_runs: 1, scope: 'run', target_hints: recipeHints([best.recipe].filter(Boolean)),
        target_tier: 1, note: '예산 소진율이 soft_stop_ratio 이상 — T1: recipe 힌트, T2: init 환류(budget) 검토',
      });
    }
  }

  // §5: min_runs=1의 per-run 규칙 — "run-paused ≥ 2"는 단일 run 내 빈도(max-of-run)다. threshold 1인
  // sibling 규칙들(breaker_trip 등)은 sum≡max라 패턴 근거가 없다. fleet-sum으로 바꾸면 1회씩 pause한
  // 정상 run N개가 위양성으로 발행된다 (2026-07-07 리뷰 판정).
  // pause_frequency — run-paused ≥ 임계치. 대표값 = 가장 빈발한 run.
  {
    let maxCount = 0, recipe = null;
    for (const runId of runIds) {
      const c = perRunMap[runId].pauses?.count || 0;
      if (c > maxCount) { maxCount = c; recipe = perRunMap[runId].recipe; }
    }
    if (maxCount >= CANDIDATE_RULES.PAUSE_FREQUENCY) {
      candidates.push({
        id: 'pause_frequency', metric: 'pause_count_max', value: maxCount,
        threshold: CANDIDATE_RULES.PAUSE_FREQUENCY, min_runs: 1, scope: 'run',
        target_hints: recipeHints([recipe].filter(Boolean)), target_tier: 1,
        note: 'run-paused 빈발 — T1: 사유 연관 recipe, T2: 스킬 지침(human-proposal)',
      });
    }
  }

  // abandoned_episodes — episode-abandon 이벤트 소스 총합 ≥ 1.
  {
    let sum = 0; const recipes = [];
    for (const runId of runIds) {
      const m = perRunMap[runId];
      const a = m.episodes?.terminal?.abandoned || 0;
      sum += a;
      if (a >= 1 && m.recipe && !recipes.includes(m.recipe)) recipes.push(m.recipe);
    }
    if (sum >= 1) {
      candidates.push({
        id: 'abandoned_episodes', metric: 'abandoned_count_total', value: sum,
        threshold: 1, min_runs: 1, scope: 'run', target_hints: recipeHints(recipes), target_tier: 1,
        note: 'episode abandon 발생 — T1: 해당 kind 연관 recipe, T2: 스킬 지침(human-proposal)',
      });
    }
  }

  // fix_convergence_slow:<point> — cross-run 전용. 3+ runs에서 point 평균 fix_cycles가 시간순
  // (runIds 정렬 = runs_analyzed 순서) 비감소일 때만 발행. min_runs 미만인 point는 침묵.
  const seriesByPoint = Object.create(null);
  for (const runId of runIds) {
    const avgs = perRunPointAverages(perRunMap[runId].review?.fix_cycles);
    for (const [point, avg] of Object.entries(avgs)) (seriesByPoint[point] ||= []).push(avg);
  }
  for (const [point, series] of Object.entries(seriesByPoint)) {
    if (series.length < CANDIDATE_RULES.CROSS_RUN_MIN) continue;
    // all-zero 시계열(클린 run들)은 "느린 수렴"이 아니다 — 0-시드 분모(위 🟡A) 도입 후 위양성 방지.
    const nonDecreasing = series.every((v, i) => i === 0 || v >= series[i - 1]) && series[series.length - 1] > 0;
    if (nonDecreasing) {
      candidates.push({
        id: `fix_convergence_slow:${point}`, metric: 'fix_cycles_trend', value: series[series.length - 1],
        threshold: series[0], min_runs: CANDIDATE_RULES.CROSS_RUN_MIN, scope: 'cross-run',
        target_hints: [], target_tier: 2,
        note: `point '${point}' fix_cycles 추세 비감소(${series.join('→')}) — 프로세스 지침(human-proposal, cross-run 전용)`,
      });
    }
  }

  // integrity_failure — §4-2 검증 실패 터미널 run 존재. 편집 대상 아님 — needs-human 조사 신호로만 표기.
  if (integrityFailed.length >= 1) {
    candidates.push({
      id: 'integrity_failure', metric: 'integrity_failed_count', value: integrityFailed.length,
      threshold: 1, min_runs: 1, scope: 'run', target_hints: [], target_tier: 2,
      note: `integrity 검증 실패 run 존재(${integrityFailed.join(', ')}) — 편집 대상 아님, needs-human 조사 신호`,
    });
  }

  return candidates;
}

function defaultSleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const TERMINAL_RUN = new Set(['completed', 'stopped']);

function listRunIds(root) {
  const dir = join(root, '.deep-loop', 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
}

function rawStatusOnce(root, runId) {
  return JSON.parse(readFileSync(join(runDir(root, runId), 'loop.json'), 'utf8')).status;
}

export function computeInsights(root, { selfRunId = null, now = Date.now(), retryDelayMs = 50, sleepFn = defaultSleep } = {}) {
  const out = {
    insights_schema_version: INSIGHTS_SCHEMA_VERSION,
    generated_at: new Date(now).toISOString(),
    runs_analyzed: [], excluded_active: [], unreadable: [], integrity_failed_runs: [],
    per_run: Object.create(null), aggregates: {}, candidates: [],
  };
  for (const id of listRunIds(root)) {
    const isSelf = id === selfRunId;
    // 1단: raw parse (실패 → 1회 재시도 → unreadable)
    let status;
    try { status = rawStatusOnce(root, id); }
    catch { try { sleepFn(retryDelayMs); status = rawStatusOnce(root, id); } catch { out.unreadable.push(id); continue; } }
    if (!isSelf && !TERMINAL_RUN.has(status)) { out.excluded_active.push(id); continue; }
    // 2단: 검증 읽기 = readState + verifyLog + verifyHead + readLines (스펙 §4-2). readLines는 JSON parse만 하므로
    // verifyLog(checksum/seq 체인)와 verifyHead(loop.json의 event_log_head anchor 대조 — suffix truncation 탐지,
    // appendAnchored와 동일 2중 검증)를 반드시 함께 돌린다. 실패 → ≥retryDelayMs 재시도 1회 → integrity_failed.
    let loopHash, loop, events;
    const verifiedRead = () => {
      // Single verified read: readState hash-checks loop.json and returns the verified content hash — a second
      // readFileSync would open a TOCTOU window where loop_sha256 hashes different bytes than the analyzed data.
      // 이벤트 로그도 같은 원리로 **1회만** 읽고 그 in-memory 배열에 체인 검증 + head-anchor 대조를 수행한다 —
      // verifyLog/verifyHead(디스크 재읽기)와 분석용 readLines를 분리하면 그 사이 concurrent append가
      // 검증 밖 suffix로 metrics/last_seq에 유입된다 (impl-R2 🟡2).
      const r = readState(root, id);                                   // hash anchor 검증
      const lines = readLines(root, id);                               // 단일 읽기 — 검증 배열 == 분석 배열
      const vl = verifyLines(lines);                                   // event-log 체인 검증
      if (!vl.ok) throw new Error(`LOG_TAMPERED: ${vl.errors.join('; ')}`);
      const vh = verifyHeadLines(lines, r.data.event_log_head);        // suffix truncation 탐지
      if (!vh.ok) throw new Error(`LOG_TAMPERED: ${vh.errors.join('; ')}`);
      return { hash: r.hash, data: r.data, events: lines };
    };
    try { ({ hash: loopHash, data: loop, events } = verifiedRead()); }
    catch { try { sleepFn(retryDelayMs); ({ hash: loopHash, data: loop, events } = verifiedRead()); } catch { out.integrity_failed_runs.push(id); continue; } }
    // 검증은 통과했으나 metrics 산출이 불능인 run(과거/타 버전 커널의 이벤트 shape drift)은 fail-soft로
    // unreadable에 분류 — run 하나가 insights 전체(피드백 루프)를 크래시하면 안 된다 (impl-R3 🟡D).
    let m;
    try { m = computeRunMetrics(loop, events); }
    catch { out.unreadable.push(id); continue; }
    if (isSelf) m.self_snapshot = true;
    out.per_run[id] = m;
    out.runs_analyzed.push({ run_id: id, last_seq: m.last_seq, loop_sha256: loopHash });
  }
  out.candidates = deriveCandidates(out.per_run, { integrityFailed: out.integrity_failed_runs });
  out.aggregates = { avg_fix_cycles_by_point: avgFixCyclesByPoint(out.per_run), total_runs: out.runs_analyzed.length };
  return out;
}

const insightsDir = (root) => join(root, '.deep-loop', 'insights');
export const relInsightsPath = (name) => `.deep-loop/insights/${name}`;

export function emitInsights(root, runId, { fence, now = Date.now(), rnd = Math.random, renameFn = renameSync, sleepFn } = {}) {
  // lib 진입점 fence 필수 — shape까지 episode.mjs:26-27/finish.mjs 동형(owner 문자열 + generation 정수, r2 리뷰 정정)
  if (!fence || typeof fence.owner !== 'string' || !fence.owner.length || !Number.isInteger(fence.generation)) {
    throw new Error('FENCE_REQUIRED: emitInsights requires {owner: string, generation: integer}');
  }
  // fast-fail leaseCheck를 tmp write **이전에** 수행 (r2 리뷰 정정 — wrong-generation 호출이 .tmp- 잔재를 남기지 않게).
  // 권위 검사는 여전히 아래 appendAnchored preCheck(락 안)에 있다 — 이건 잔재 방지용 사전 검사.
  { const { data: pre } = readState(root, runId); const lc = leaseCheck(pre, fence); if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason); }
  const payload = computeInsights(root, { selfRunId: runId, now, ...(sleepFn ? { sleepFn } : {}) });
  const { data: loop } = readState(root, runId);
  const envelope = wrap({ producer: 'deep-loop', artifact_kind: 'loop-insights',
    schema: { name: 'loop-insights', version: String(INSIGHTS_SCHEMA_VERSION) },
    run_id: runId, parent_run_id: loop.session_chain?.parent_run_id ?? null,
    payload, now: new Date(now).toISOString() });
  const json = JSON.stringify(envelope, null, 2);
  const sha256 = contentHash(json);
  const fileUlid = ulid(now, rnd);
  const finalName = `${fileUlid}-insights.json`;
  const rel = relInsightsPath(finalName);
  mkdirSync(insightsDir(root), { recursive: true });
  const tmp = join(insightsDir(root), `.tmp-${fileUlid}`);
  atomicWrite(tmp, json);                                            // ① tmp (latest 스캔 제외 접두)
  appendAnchored(root, runId,                                        // ② anchored 이벤트 = 신뢰 원천
    { type: 'insights-emitted', data: { path: rel, sha256, candidates_count: payload.candidates.length } },
    undefined,
    (l) => { if (fence) { const r = leaseCheck(l, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); } },
    { floor: MUTATION_TURN_FLOOR });
  renameFn(tmp, join(insightsDir(root), finalName));                 // ③ 공개
  // candidates를 반환에 포함 — finish 스킬이 파일을 직접 파싱하지 않고 CLI 출력만으로 제안 블록을 구성(§9, 2-plane)
  return { ok: true, path: rel, sha256, candidates_count: payload.candidates.length, candidates: payload.candidates };
}

export function latestInsights(root) {
  const dir = insightsDir(root);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => f.endsWith('-insights.json') && !f.startsWith('.tmp-')).sort().reverse();
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), 'utf8');
      const obj = unwrap(JSON.parse(raw), { producer: 'deep-loop', artifact_kind: 'loop-insights' });
      if (!obj) continue;
      if ((obj.payload?.insights_schema_version ?? Infinity) > INSIGHTS_SCHEMA_VERSION) { process.stderr.write(`[deep-loop:warn] insights ${f}: newer schema — skipped\n`); continue; }
      const rel = relInsightsPath(f);
      // 리뷰 판정(2026-07-07): anchored 신뢰는 체인 검증을 전제한다 — readLines는 parse만 하므로
      // verifyLines(체크섬 체인) + verifyHeadLines(head anchor, suffix truncation)를 통과한 로그의 이벤트만
      // 증거로 인정한다 (computeInsights §4-2 동형 — 단일 읽기, impl-R2 🟡2). 실패는 throw → per-file
      // catch → fail-soft skip.
      const rid = obj.envelope.run_id;
      const anchor = readState(root, rid).data.event_log_head;
      const lines = readLines(root, rid);
      const vl = verifyLines(lines);
      if (!vl.ok) throw new Error(`LOG_TAMPERED: ${vl.errors.join('; ')}`);
      const vh = verifyHeadLines(lines, anchor);
      if (!vh.ok) throw new Error(`LOG_TAMPERED: ${vh.errors.join('; ')}`);
      const ev = lines.find(e => e.type === 'insights-emitted' && e.data.path === rel);
      if (!ev) continue;                                    // path-binding: 이벤트의 path와 정확 일치 필수
      if (ev.data.sha256 !== contentHash(raw)) continue;    // 내용 무결성
      return { path: rel, envelope: obj };
    } catch (e) {
      process.stderr.write(`[deep-loop:warn] insights ${f}: ${String(e?.message || e)} — skipped\n`);   // fail-soft
    }
  }
  return null;
}

// spec §8.3 — hillclimb-ledger.json 스키마 검증 (배열·append-only 항목 형태만; append-only 강제는
// checker 계약 (f)의 diff 검사 + git history 폴백이 담당 — 여기서는 스키마·배열 형태만 단언).
export function validateLedger(arr) {
  const errors = [];
  if (!Array.isArray(arr)) return { ok: false, errors: ['ledger must be an array'] };
  arr.forEach((item, i) => {
    if (typeof item?.date !== 'string') errors.push(`item ${i}: date must be a string`);
    if (typeof item?.insights_ref !== 'string') errors.push(`item ${i}: insights_ref must be a string`);
    if (!Array.isArray(item?.candidates_addressed) || !item.candidates_addressed.every(v => typeof v === 'string')) {
      errors.push(`item ${i}: candidates_addressed must be a string[]`);
    }
    if (typeof item?.falsification !== 'string') errors.push(`item ${i}: falsification must be a string`);
    if (item?.changes !== undefined && (!Array.isArray(item.changes) || !item.changes.every(v => typeof v === 'string'))) {
      errors.push(`item ${i}: changes must be a string[]`);
    }
    if (item?.human_proposals !== undefined && (!Array.isArray(item.human_proposals) || !item.human_proposals.every(v => typeof v === 'string'))) {
      errors.push(`item ${i}: human_proposals must be a string[]`);
    }
    if (item?.insights_sha256 !== undefined && typeof item.insights_sha256 !== 'string') {
      errors.push(`item ${i}: insights_sha256 must be a string`);
    }
  });
  return { ok: errors.length === 0, errors };
}
