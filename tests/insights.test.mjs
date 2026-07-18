import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { computeRunMetrics, computeInsights, deriveCandidates, emitInsights, latestInsights, relInsightsPath, validateLedger, isSuspiciousActive } from '../scripts/lib/insights.mjs';
import { readState, writeState, runDir as runDirOf } from '../scripts/lib/state.mjs';
import { readLines, appendAnchored, appendEvent, lastLogHead } from '../scripts/lib/integrity.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { recordCost } from '../scripts/lib/budget.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import {
  rawHashValidHistory as rawHistory7b,
  seedCorrelatedTerminal as terminal7b,
} from './fixtures/verified-app-run.mjs';

const FIXED = new Date('2026-07-07T00:00:00Z');
const NOSLEEP = () => {};

const T0 = Date.parse('2026-07-07T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function loopFixture() {
  return {
    run_id: 'RUNA', goal: 'g', status: 'completed',
    recipe: { id: 'robust-implementation' }, routing: { protocol: 'deep-work' },
    created_at: iso(T0),
    circuit_breaker: { tripped: false, consecutive_request_changes: 0 },
    episodes: [
      { id: '001-m', role: 'maker', kind: 'design', point: 'design', workstream_id: 'ws-01', status: 'done' },
      { id: '002-c', role: 'checker', kind: 'review', point: 'design', workstream_id: 'ws-01', status: 'rejected' },
      { id: '003-m', role: 'maker', kind: 'fix', point: 'design', workstream_id: 'ws-01', status: 'done' },
      { id: '004-c', role: 'checker', kind: 'review', point: 'design', workstream_id: 'ws-01', status: 'approved' },
    ],
  };
}
// 이벤트는 실제 커널이 남기는 data 형태 그대로 (episode-new: {plugin,role,kind,point} / episode-record: {id,status,artifacts}
// / review-outcome: {episodeId, verdict} / cost: {turns,tokens,auto_floor?,for?} / comprehension-ack: {episodeId, actor})
function eventsFixture() {
  let seq = 0; const ev = (type, data, ts) => ({ seq: ++seq, ts: iso(ts), type, data, checksum: 'x' });
  return [
    ev('workstream-new', { title: 't' }, T0 + 1000),
    ev('cost', { turns: 1, tokens: 0, auto_floor: true, for: 'workstream-new' }, T0 + 1000),
    ev('episode-new', { plugin: 'p', role: 'maker', kind: 'design', point: 'design' }, T0 + 2000),
    ev('comprehension-ack', { episodeId: '001-m', actor: 'human' }, T0 + 3000),   // ack가 첫 in_progress보다 선행
    ev('episode-record', { id: '001-m', status: 'in_progress', artifacts: [] }, T0 + 4000),
    ev('episode-record', { id: '001-m', status: 'done', artifacts: ['a.md'] }, T0 + 5000),
    ev('review-outcome', { episodeId: '002-c', verdict: 'REQUEST_CHANGES' }, T0 + 6000),
    ev('episode-abandon', { id: 'zzz', reason: 'r' }, T0 + 7000),
    ev('review-outcome', { episodeId: '004-c', verdict: 'APPROVE' }, T0 + 8000),
    ev('cost', { turns: 5, tokens: 100 }, T0 + 9000),
    ev('run-paused', { reason: 'needs-human:x', mode: 'preserve' }, T0 + 10000),
    ev('run-recovered', {}, T0 + 11000),
    ev('respawn-failed', {}, T0 + 12000),
    ev('handoff-emitted', { reason: 'milestone' }, T0 + 13000),
  ];
}

test('computeRunMetrics: 지표 exact 단언', () => {
  const m = computeRunMetrics(loopFixture(), eventsFixture());
  assert.equal(m.run_id, 'RUNA');
  assert.equal(m.status, 'completed');
  assert.equal(m.last_seq, 14);
  assert.equal(m.wallclock_sec, 13);                       // created_at T0 → 마지막 이벤트 T0+13s
  assert.equal(m.episodes.total, 4);
  assert.equal(m.episodes.by_role.maker, 2);
  assert.equal(m.episodes.terminal.abandoned, 1);          // episode-abandon 이벤트 소스
  assert.equal(m.review.per_point.design.request_changes, 1);
  assert.equal(m.review.per_point.design.approve, 1);
  assert.equal(m.review.fix_cycles['ws-01|design'], 1);    // RC 1건 = fix cycle 1
  assert.equal(m.breaker.trips, 0);                         // untripped fixture → 0 (end-of-run latch only)
  assert.equal(m.breaker.trip_reason, null);                // untripped fixture — spec §4 breaker row 완결(trips·trip_reason·max_consecutive_rc)
  assert.equal(m.breaker.max_consecutive_rc, 0);
  assert.equal(m.cost.turns, 6);                            // floor 1 + explicit 5
  assert.equal(m.cost.auto_floor_turns, 1);
  assert.equal(m.cost.auto_floor_by_for['workstream-new'], 1);
  assert.equal(m.sessions.respawn.failed, 1);
  assert.equal(m.sessions.handoffs, 1);
  assert.equal(m.pauses.count, 1);
  assert.equal(m.pauses.recovered, 1);
  assert.equal(m.comprehension.ack_human, 1);
  assert.equal(m.comprehension.ack_before_first_dispatch, true);
});

test('computeRunMetrics: maker 없는 run은 ack_before_first_dispatch=null', () => {
  const loop = { ...loopFixture(), episodes: [] };
  const m = computeRunMetrics(loop, []);
  assert.equal(m.comprehension.ack_before_first_dispatch, null);
});

// fixture 전용 터미널 전이: readState → status 변경 → writeState (hash 재계산되므로 검증 읽기 통과)
function toTerminal(root, runId, status = 'completed') {
  return terminal7b(root, runId, { status });
}

// finish-edge 정합 픽스처: finishRun은 completed-proof(episode/review/report)를 요구하므로, 테스트는 동일
// 트랜잭션 모양(appendAnchored: finish 이벤트 + status 전이 + auto-floor cost)만 재현한다 — spec §3의
// 정상 event-log 형태 `insights-emitted(k) → cost(auto-floor) → finish(m) → cost(auto-floor)`가 만들어진다.
function finishFixture(root, runId) {
  return terminal7b(root, runId,
    { status: 'completed', floor: 1, now: FIXED.getTime() + 10_000 });
}

function corruptTerminalWithoutFinish(root, runId, status = 'completed') {
  rawHistory7b(root, runId, [], loop => {
    loop.status = status;
    loop.pause_reason = null;
    loop.termination = loop.termination || {};
    loop.termination.finished_at = '2026-07-13T00:00:10.000Z';
  });
}
// finish-edge 위반 픽스처 — v1.6 재설계(plan Task 11 / 3차 r1 P2-b): appendAnchored 관문(RUN_TERMINAL: append)이
// 가드-시대 API로는 post-finish 이벤트 생성을 정확히 차단하므로(그것이 v1.6의 목적), 구버전(가드 이전)
// 오염 로그는 raw로 직조한다: appendEvent(체인 checksum 유지) + event_log_head 앵커 수동 재계산 —
// computeInsights의 무결성 검증(체인+head)을 통과해야 integrity_failed가 아닌 post_finish_mutated 경로로 분류된다.
function businessEventFixture(root, runId) {
  rawHistory7b(root, runId, [
    { type: 'episode-new', now: FIXED.getTime() + 20_000,
      data: { plugin: 'p', role: 'maker', kind: 'design', point: 'design' } },
    { type: 'cost', now: FIXED.getTime() + 20_000,
      data: { turns: 1, tokens: 0, auto_floor: true, for: 'episode-new' } },
  ]);
}

function terminalMakerReceiptFixture(root, runId) {
  appendEvent(root, runId, {
    type: 'cost',
    data: {
      turns: 0, tokens: 12, reported_turns: 1, reported_tokens: 12,
      input_tokens: 5, output_tokens: 7, owner: runId, generation: 1,
      terminal_process: 'codex-maker', source: 'terminal-maker-measured',
      accounting_key: 'a'.repeat(64),
    },
  });
  const d = readState(root, runId).data;
  d.event_log_head = lastLogHead(root, runId);
  d.budget.tokens_spent = 12;
  writeState(root, runId, d);
}

test('computeInsights: 터미널 + self만 집계, self_snapshot 표기, loop_sha256 기록', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins-'));
  const { runId: rA } = initRun(root, { runtime: 'claude', goal: 'a', now: FIXED });        // running (self)
  const { runId: rB } = initRun(root, { runtime: 'claude', goal: 'b', now: FIXED });
  toTerminal(root, rB);
  const out = computeInsights(root, { selfRunId: rA, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.excluded_active, []);                              // rA는 self라 포함
  assert.ok(out.per_run[rA].self_snapshot);
  assert.ok(out.per_run[rB]);
  assert.equal(out.runs_analyzed.find(r => r.run_id === rB).loop_sha256,
    contentHash(readFileSync(join(runDirOf(root, rB), 'loop.json'), 'utf8')));
});

test('computeInsights: 비터미널 타 run은 excluded_active, raw parse 실패는 unreadable(후보 없음)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins2-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const { runId: other } = initRun(root, { runtime: 'claude', goal: 'other', now: FIXED }); // running 타 run
  mkdirSync(join(root, '.deep-loop', 'runs', 'BROKEN'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'runs', 'BROKEN', 'loop.json'), '{not json');
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.excluded_active, [other]);
  assert.deepEqual(out.unreadable, ['BROKEN']);
  assert.deepEqual(out.integrity_failed_runs, []);
  assert.ok(!out.candidates.some(c => c.id === 'integrity_failure'));    // unreadable은 후보 발행 ❌
});

test('computeInsights: 터미널 검증 실패(해시 불일치) → 재시도 후 재실패만 integrity_failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins3-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const { runId: bad } = initRun(root, { runtime: 'claude', goal: 'bad', now: FIXED });
  toTerminal(root, bad);
  const lp = join(runDirOf(root, bad), 'loop.json');
  writeFileSync(lp, readFileSync(lp, 'utf8').replace('"bad"', '"BAD"'));   // hash 불일치 유발
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.integrity_failed_runs, [bad]);
});

test('computeInsights: 전이 race — 재시도가 성공하면 정상 승격 (integrity_failed ❌)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins4-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const { runId: racy } = initRun(root, { runtime: 'claude', goal: 'racy', now: FIXED });
  toTerminal(root, racy);
  const lp = join(runDirOf(root, racy), 'loop.json');
  const good = readFileSync(lp, 'utf8');
  writeFileSync(lp, good.replace('"racy"', '"RACY"'));                     // 1차 읽기는 실패하도록 변조
  // sleepFn이 "전이 완료"를 시뮬레이션: 재시도 직전에 원본 복원 → 재시도 성공해야 함
  const healingSleep = () => { writeFileSync(lp, good); };
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: healingSleep });
  assert.deepEqual(out.integrity_failed_runs, []);
  assert.ok(out.per_run[racy]);
});

// Production initRun leaves the immutable run-initialized event. The tamper fixture may corrupt
// that initialization event directly; type-filtered business-event metrics remain unchanged.
function seedTamperable(root, goal) {
  const { runId } = initRun(root, { runtime: 'claude', goal, now: FIXED });
  toTerminal(root, runId);
  return runId;
}

test('computeInsights: initialized run event-log 변조(JSON-valid, checksum 불변)는 verifyLog로 integrity_failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins5-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const tam = seedTamperable(root, 'tam');
  const ep = join(runDirOf(root, tam), 'event-log.jsonl');
  const lines = readFileSync(ep, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]); first.data = { ...first.data, tampered: true };   // checksum은 그대로
  writeFileSync(ep, [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.integrity_failed_runs, [tam]);
});

test('computeInsights: initialized run suffix truncation은 verifyHead로 integrity_failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins6-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const tr = seedTamperable(root, 'tr');
  const ep = join(runDirOf(root, tr), 'event-log.jsonl');
  const lines = readFileSync(ep, 'utf8').trim().split('\n');
  writeFileSync(ep, lines.slice(0, -1).join('\n') + '\n');            // 마지막 라인 절단 — 접두 체인은 여전히 유효
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.integrity_failed_runs, [tr]);                  // verifyLog는 통과하지만 verifyHead가 잡아야 함
});

test('computeInsights: 콜드스타트 runs 0개 → 빈 결과', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins0-'));
  const out = computeInsights(root, { now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.runs_analyzed, []);
  assert.deepEqual(out.candidates, []);
});

// ── v1.5.0 (a): suspicious_active — 죽은 lease 신호 라벨 (spec §2, 판정 표 그대로) ───
test('v1.5 (a): isSuspiciousActive 판정 표 — 위에서 아래 첫 매치', () => {
  const NOW = T0;
  // paused 최우선 제외 (released여도 false)
  assert.equal(isSuspiciousActive('paused', { state: 'released' }, NOW), false);
  assert.equal(isSuspiciousActive('paused', { state: 'releasing', expires_at: iso(T0 - 1000) }, NOW), false);
  // lease 부재/비객체 → 보수적 false
  assert.equal(isSuspiciousActive('running', null, NOW), false);
  assert.equal(isSuspiciousActive('running', undefined, NOW), false);
  // released → true (놓았는데 비-terminal)
  assert.equal(isSuspiciousActive('running', { state: 'released' }, NOW), true);
  // releasing + TTL만료 → true / 미만료 → false
  assert.equal(isSuspiciousActive('running', { state: 'releasing', expires_at: iso(T0 - 1) }, NOW), true);
  assert.equal(isSuspiciousActive('running', { state: 'releasing', expires_at: iso(T0 + 60000) }, NOW), false);
  // releasing + expires_at 부재/파싱불가 → true (r4 리뷰 — 규약 밖 stranded)
  assert.equal(isSuspiciousActive('running', { state: 'releasing' }, NOW), true);
  assert.equal(isSuspiciousActive('running', { state: 'releasing', expires_at: null }, NOW), true);
  assert.equal(isSuspiciousActive('running', { state: 'releasing', expires_at: 'garbage' }, NOW), true);
  // releasing + 달력-무효/비정규 expires_at → 규약 밖 = suspicious (impl-r5, round-trip)
  assert.equal(isSuspiciousActive('running', { state: 'releasing', expires_at: '2026-02-31T00:00:00Z' }, NOW), true);
  assert.equal(isSuspiciousActive('running', { state: 'releasing', expires_at: '2026-07-08T02:00:00Z' }, NOW), true);   // 밀리초 없음 — 커널 형식 아님
  assert.equal(isSuspiciousActive('running', { state: 'releasing', expires_at: iso(T0 + 60000) }, NOW), false);          // 정규 toISOString 미만료 — 기존 유지
  // active (expires_at=null 무기한 규약) → false
  assert.equal(isSuspiciousActive('running', { state: 'active', expires_at: null }, NOW), false);
});

test('v1.5 (a): computeInsights suspicious_active — excluded 부분집합, 집계 미포함, version 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-susp-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const { runId: dead } = initRun(root, { runtime: 'claude', goal: 'dead', now: FIXED });      // running + lease released → suspicious
  { const d = readState(root, dead).data; d.session_chain.lease.state = 'released'; writeState(root, dead, d); }
  const { runId: healthy } = initRun(root, { runtime: 'claude', goal: 'healthy', now: FIXED }); // running + lease active → 비suspicious
  const { runId: pausedR } = initRun(root, { runtime: 'claude', goal: 'paused', now: FIXED });  // paused + releasing+만료 → 비suspicious (preserve-pause)
  { const d = readState(root, pausedR).data; d.status = 'paused';
    d.session_chain.lease = { ...d.session_chain.lease, state: 'releasing', expires_at: iso(T0 - 1000) };
    writeState(root, pausedR, d); }
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.suspicious_active, [dead]);
  for (const id of out.suspicious_active) assert.ok(out.excluded_active.includes(id));   // ⊆ excluded_active
  assert.ok(out.excluded_active.includes(healthy) && out.excluded_active.includes(pausedR));
  assert.equal(out.per_run[dead], undefined);                                            // 집계 제외 원칙 불변
  assert.equal(out.insights_schema_version, 1);                                          // additive — version 유지
});

function metricsWith(over) {   // 최소 필드만 가진 per-run metrics 스텁
  return { run_id: 'R', status: 'completed', review: { per_point: {}, fix_cycles: {} },
    breaker: { trips: 0, max_consecutive_rc: 0 }, budget_ratio: 0, soft_stop_ratio: 0.8,
    pauses: { count: 0, reasons: [], recovered: 0 }, episodes: { terminal: { abandoned: 0 } },
    sessions: { respawn: { spawned: 0, failed: 0, timeout: 0 } },
    comprehension: { ack_before_first_dispatch: false }, ...over };
}

test('candidates: fix_cycles_high 경계 (평균 1.0 이상만)', () => {
  const hit = deriveCandidates({ R: metricsWith({ review: { per_point: {}, fix_cycles: { 'ws|design': 1 } } }) });
  assert.ok(hit.some(c => c.id === 'fix_cycles_high:design'));
  const miss = deriveCandidates({ R: metricsWith({ review: { per_point: {}, fix_cycles: {} } }) });
  assert.ok(!miss.some(c => c.id.startsWith('fix_cycles_high')));
});
test('candidates: bootstrap_ack_friction + integrity_failure는 target 없음(note)', () => {
  const cs = deriveCandidates({ R: metricsWith({ comprehension: { ack_before_first_dispatch: true } }) }, { integrityFailed: ['X'] });
  assert.ok(cs.some(c => c.id === 'bootstrap_ack_friction' && c.target_tier === 2));
  assert.ok(cs.some(c => c.id === 'integrity_failure' && c.target_hints.length === 0));
});
test('candidates: cross-run(min_runs=3) 후보는 2 runs에서 침묵', () => {
  const two = { A: metricsWith({ review: { per_point: {}, fix_cycles: { 'w|impl': 2 } } }),
                B: metricsWith({ review: { per_point: {}, fix_cycles: { 'w|impl': 2 } } }) };
  assert.ok(!deriveCandidates(two).some(c => c.id.startsWith('fix_convergence_slow')));
});
test('candidates: fix_convergence_slow — 3 runs 비감소 추세에서 발행, 감소 추세에서 침묵', () => {
  const fc = (n) => metricsWith({ review: { per_point: {}, fix_cycles: { 'w|impl': n } } });
  // 키(run_id ULID)가 시간순 정렬키 — 명시적으로 오름차순 이름 사용
  const rising = { '01A': fc(1), '01B': fc(1), '01C': fc(2) };     // 비감소(1,1,2) → 발행
  assert.ok(deriveCandidates(rising).some(c => c.id === 'fix_convergence_slow:impl'));
  const falling = { '01A': fc(3), '01B': fc(2), '01C': fc(1) };    // 감소(3,2,1) → 침묵
  assert.ok(!deriveCandidates(falling).some(c => c.id.startsWith('fix_convergence_slow')));
});

test('candidates: pause_frequency는 단일 run 내 빈도(≥2, max-of-run) — 여러 run 1회씩은 침묵', () => {
  const spread = { A: metricsWith({ pauses: { count: 1, reasons: ['x'], recovered: 0 } }),
                   B: metricsWith({ pauses: { count: 1, reasons: ['y'], recovered: 0 } }),
                   C: metricsWith({ pauses: { count: 1, reasons: ['z'], recovered: 0 } }) };
  assert.ok(!deriveCandidates(spread).some(c => c.id === 'pause_frequency'));
  const single = { A: metricsWith({ pauses: { count: 2, reasons: ['x', 'y'], recovered: 0 } }) };
  assert.ok(deriveCandidates(single).some(c => c.id === 'pause_frequency'));
});

test('candidates: breaker_trip/respawn_failure/abandoned_episodes — ≥1 발행, 0 침묵', () => {
  assert.ok(deriveCandidates({ A: metricsWith({ breaker: { trips: 1, max_consecutive_rc: 3 } }) }).some(c => c.id === 'breaker_trip'));
  assert.ok(deriveCandidates({ A: metricsWith({ sessions: { respawn: { spawned: 0, failed: 1, timeout: 0 } } }) }).some(c => c.id === 'respawn_failure'));
  assert.ok(deriveCandidates({ A: metricsWith({ episodes: { terminal: { abandoned: 1 } } }) }).some(c => c.id === 'abandoned_episodes'));
  const none = deriveCandidates({ A: metricsWith({}) });
  for (const id of ['breaker_trip', 'respawn_failure', 'abandoned_episodes', 'pause_frequency', 'budget_overrun']) {
    assert.ok(!none.some(c => c.id === id), `unexpected ${id}`);
  }
});

test('candidates: budget_overrun — ratio ≥ soft_stop_ratio 발행, 미만/null 침묵', () => {
  assert.ok(deriveCandidates({ A: metricsWith({ budget_ratio: 0.85, soft_stop_ratio: 0.8 }) }).some(c => c.id === 'budget_overrun'));
  assert.ok(!deriveCandidates({ A: metricsWith({ budget_ratio: 0.5, soft_stop_ratio: 0.8 }) }).some(c => c.id === 'budget_overrun'));
  assert.ok(!deriveCandidates({ A: metricsWith({ budget_ratio: null, soft_stop_ratio: null }) }).some(c => c.id === 'budget_overrun'));
});

function emitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dl-emit-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: FIXED });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}

test('emit: envelope 형태 + anchored 이벤트(path+sha256) + candidates 반환', () => {
  const { root, runId, fence } = emitFixture();
  const r = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  assert.match(r.path, /^\.deep-loop\/insights\/[0-9A-HJKMNP-TV-Z]{26}-insights\.json$/);
  assert.ok(Array.isArray(r.candidates));                    // finish 제안 블록이 CLI 출력만으로 구성 가능해야 함(§9)
  const env = JSON.parse(readFileSync(join(root, r.path), 'utf8'));
  assert.equal(env.envelope.producer, 'deep-loop');
  assert.equal(env.envelope.artifact_kind, 'loop-insights');
  assert.equal(env.payload.insights_schema_version, 1);
  const ev = readLines(root, runId).find(e => e.type === 'insights-emitted');
  assert.equal(ev.data.path, r.path);
  assert.equal(ev.data.sha256, r.sha256);
});

test('emit: fence 누락/불완전은 FENCE_REQUIRED, 불일치는 LEASE_FENCED — 파일·이벤트·.tmp- 잔재 전부 없음', () => {
  const { root, runId } = emitFixture();
  assert.throws(() => emitInsights(root, runId, { now: FIXED.getTime() }), /FENCE_REQUIRED/);
  assert.throws(() => emitInsights(root, runId, { fence: { owner: runId }, now: FIXED.getTime() }), /FENCE_REQUIRED/);   // generation 정수 누락 (episode.mjs shape 동형)
  assert.throws(() => emitInsights(root, runId, { fence: { owner: 'WRONG', generation: 9, intent: 'business' }, now: FIXED.getTime() }), /LEASE_FENCED/);
  assert.ok(!readLines(root, runId).some(e => e.type === 'insights-emitted'));
  const dir = join(root, '.deep-loop', 'insights');
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0);       // wrong-generation도 .tmp- 잔재 ❌ (pre-tmp leaseCheck)
});

test('emit: rename 실패(②↔③ 창) → 이벤트만 존재, latest는 null (파일 부재 탈락)', () => {
  const { root, runId, fence } = emitFixture();
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => emitInsights(root, runId, {
    fence,
    now: FIXED.getTime(),
    platform: 'win32',
    monotonicNowFn: () => 0,
    sleepFn: () => { sleeps++; },
    renameFn: () => { attempts++; throw Object.assign(new Error('EIO'), { code: 'EIO' }); },
  }), /EIO/);
  assert.equal(attempts, 1, 'nonretryable publish error is single-shot');
  assert.equal(sleeps, 0);
  assert.ok(readLines(root, runId).some(e => e.type === 'insights-emitted'));   // 이벤트는 anchored
  assert.equal(latestInsights(root), null);                                      // 신뢰 파일 없음 + .tmp- 제외
});

test('emit: transient Windows publish retries only rename and anchors once before success', () => {
  const { root, runId, fence } = emitFixture();
  const calls = [];
  const sleeps = [];
  let now = 0;
  const result = emitInsights(root, runId, {
    fence,
    now: FIXED.getTime(),
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { sleeps.push(ms); now += ms; },
    renameFn: (src, dst) => {
      calls.push([src, dst]);
      if (calls.length < 3) throw Object.assign(new Error('shared'), { code: 'EACCES' });
      renameSync(src, dst);
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(calls.every(([src, dst]) => src === calls[0][0] && dst === calls[0][1]));
  assert.equal(readLines(root, runId).filter(e => e.type === 'insights-emitted').length, 1);
  assert.equal(existsSync(join(root, result.path)), true);
  assert.equal(readdirSync(join(root, '.deep-loop', 'insights')).filter(name => name.startsWith('.tmp-')).length, 0);
});

test('emit: exhausted Windows publish leaves one anchor and designated hidden tmp in a fresh root', () => {
  const { root, runId, fence } = emitFixture();
  const expected = Object.assign(new Error('still shared'), { code: 'EBUSY' });
  let now = 0;
  let attempts = 0;
  let sleeps = 0;
  assert.throws(() => emitInsights(root, runId, {
    fence,
    now: FIXED.getTime(),
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { sleeps++; now += ms; },
    renameFn: () => { attempts++; throw expected; },
  }), error => error === expected);
  assert.ok(attempts > 1);
  assert.equal(attempts, sleeps + 1);
  assert.equal(readLines(root, runId).filter(e => e.type === 'insights-emitted').length, 1);
  const entries = readdirSync(join(root, '.deep-loop', 'insights'));
  assert.equal(entries.filter(name => name.startsWith('.tmp-')).length, 1);
  assert.equal(entries.filter(name => name.endsWith('-insights.json')).length, 0);
  assert.equal(latestInsights(root), null, 'fresh root has no older trusted insights artifact');
});

test('a failed newer publish does not hide an older trusted insights artifact', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-emit-older-'));
  const { runId: older } = initRun(root, { runtime: 'claude', goal: 'older', now: FIXED });
  const olderFence = { owner: older, generation: 1, intent: 'business' };
  const trusted = emitInsights(root, older, { fence: olderFence, now: FIXED.getTime(), rnd: () => 0.1 });
  finishFixture(root, older);

  const later = new Date(FIXED.getTime() + 60_000);
  const { runId: newer } = initRun(root, { runtime: 'claude', goal: 'newer', now: later });
  const newerFence = { owner: newer, generation: 1, intent: 'business' };
  const expected = Object.assign(new Error('still shared'), { code: 'EACCES' });
  let now = 0;
  assert.throws(() => emitInsights(root, newer, {
    fence: newerFence,
    now: later.getTime(),
    platform: 'win32',
    monotonicNowFn: () => now,
    sleepFn: (ms) => { now += ms; },
    renameFn: () => { throw expected; },
  }), error => error === expected);
  assert.equal(latestInsights(root).path, trusted.path);
});

test('latest: 정상 emit → 검증 통과 최신 반환', () => {
  const { root, runId, fence } = emitFixture();
  const r1 = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.1 });
  const r2 = emitInsights(root, runId, { fence, now: FIXED.getTime() + 60000, rnd: () => 0.2 });
  finishFixture(root, runId);   // 이벤트 순 ie(r1)→af→ie(r2)→af→finish — r1은 after에 ie(r2)가 껴 skip, r2는 finish-인접
  const got = latestInsights(root);
  assert.equal(got.path, r2.path);                          // ULID 최신 + finish-인접
  assert.equal(got.envelope.envelope.run_id, runId);
  // codex r2 (P2 evidence): anchored 이벤트의 sha256을 소비자용으로 노출 — artifact 내용과 일치해야 한다
  assert.equal(got.sha256, contentHash(readFileSync(join(root, r2.path), 'utf8')));
});

// ── Phase6 ITEM-4 (adversarial): finish는 proof 검증 이전에 insights emit을 실행하므로, proof 미충족
// (FINISH_PROOF_UNMET)으로 finish가 실패하면 status=running인 run의 insights가 검증 통과 상태로
// latest에 남아 다음 init/hill-climb이 소비할 수 있었다 — producer run terminal-only 게이트로 닫는다 ───
test('latest: producer run이 running인 동안은 emit된 artifact를 반환하지 않는다 (emit→finish-proof 창 닫힘)', () => {
  const { root, runId, fence } = emitFixture();
  emitInsights(root, runId, { fence, now: FIXED.getTime() });
  // toTerminal 미호출 — producer run은 여전히 running(emitFixture의 initRun 기본 상태)
  assert.equal(latestInsights(root), null);
});
test('latest: producer run을 completed로 전환하면 동일 emit artifact가 즉시 유효화된다', () => {
  const { root, runId, fence } = emitFixture();
  const r = emitInsights(root, runId, { fence, now: FIXED.getTime() });
  assert.equal(latestInsights(root), null);       // running 동안은 불신뢰
  finishFixture(root, runId);
  const got = latestInsights(root);                // 재emit 없이 같은 파일이 finish로 유효화
  assert.equal(got.path, r.path);
});

test('latest: anchored 이벤트 없는 고아 파일 불신뢰', () => {
  const { root, runId, fence } = emitFixture();
  emitInsights(root, runId, { fence, now: FIXED.getTime() });
  finishFixture(root, runId);
  // 고아 주입: 실제 emit 파일을 더 최신 ULID 이름으로 복사 (이벤트 없음 → path-binding 실패)
  const dir = join(root, '.deep-loop', 'insights');
  const real = readdirSync(dir).find(f => f.endsWith('-insights.json'));
  writeFileSync(join(dir, 'ZZZZZZZZZZ9999999999999999-insights.json'), readFileSync(join(dir, real)));
  const got = latestInsights(root);
  assert.notEqual(got.path, '.deep-loop/insights/ZZZZZZZZZZ9999999999999999-insights.json');  // path-binding이 복사본 거부
  assert.equal(got.path, relInsightsPath(real));   // 원본은 통과 — insights.mjs가 export하는 헬퍼를 import해 사용
});

test('latest: sha 불일치 불신뢰 → 유일 파일이면 null', () => {
  const { root, runId, fence } = emitFixture();
  const r = emitInsights(root, runId, { fence, now: FIXED.getTime() });
  // finish-edge까지 먼저 충족시켜야 한다 — non-terminal이면 producer-terminal 게이트가 먼저 null을 만들어
  // sha 분기에 영원히 도달하지 못하는 pre-existing 커버리지 약점(plan-r3 P2)이 있었다.
  finishFixture(root, runId);
  const abs = join(root, r.path);
  writeFileSync(abs, readFileSync(abs, 'utf8').replace('"goal": "g"', '"goal": "tampered"'));
  assert.equal(latestInsights(root), null);
});

test('latest: 상위 insights_schema_version 파일은 skip하고 더 오래된 유효 파일을 반환 (schema 분기 고립 검증)', () => {
  // finish-edge 도입 후 단일 run으로는 schema 분기를 고립할 수 없다 — 한 run에는 finish 이벤트가 하나뿐이라
  // 두 artifact가 동시에 finish-edge를 통과할 수 없다(리뷰 실증: ZZZZ가 schema가 아닌 finish-edge에서 skip).
  // **two-run 구조**: 각 run이 자기 finish에 인접한 artifact를 하나씩 갖게 해, ZZZZ는 terminal·체인·path·sha·
  // finish-edge를 전부 통과하고 **오직 schema 검사에서만** skip되도록 만든다.
  const root = mkdtempSync(join(tmpdir(), 'dl-schema-'));
  // run A — 폴백으로 반환될 rOld (자기 finish에 인접)
  const { runId: runA } = initRun(root, { runtime: 'claude', goal: 'a', now: FIXED });
  const rOld = emitInsights(root, runA, { fence: { owner: runA, generation: 1, intent: 'business' },
    now: FIXED.getTime(), rnd: () => 0.5 });
  finishFixture(root, runA);                                 // rOld의 after = [finish] → finish-edge 통과
  // run B — future-schema 소재. r0B는 ULID가 rOld보다 작도록 과거 now로 emit.
  // ⚠ 순회 순서는 now의 60초 갭(ULID 타임스탬프 접두)이 결정한다 — rnd(0.5/0.1)는 장식이다.
  //   두 emit을 같은 now로 "단순화"하면 순서가 조용히 뒤집힌다 (v1.6 Minor (b)1).
  const { runId: runB } = initRun(root, { runtime: 'claude', goal: 'b', now: FIXED });
  const r0B = emitInsights(root, runB, { fence: { owner: runB, generation: 1, intent: 'business' },
    now: FIXED.getTime() - 60000, rnd: () => 0.1 });
  // r2 리뷰 정정(codex S2): 미래 파일을 path-binding/sha까지 **통과**하도록 만들어 schema 분기만 고립 검증한다 —
  // 테스트 seam으로 appendAnchored를 직접 호출해 그 경로에 대한 anchored 이벤트(sha 일치)를 심는다.
  const dir = join(root, '.deep-loop', 'insights');
  const future = JSON.parse(readFileSync(join(root, r0B.path), 'utf8'));
  future.payload.insights_schema_version = 99;
  const futureJson = JSON.stringify(future, null, 2);
  const futureName = 'ZZZZZZZZZZ9999999999999999-insights.json';
  appendAnchored(root, runB, { type: 'insights-emitted',
    data: { path: relInsightsPath(futureName), sha256: contentHash(futureJson), candidates_count: 0 } },
    undefined, undefined, { floor: 1 });                     // path-binding+sha 성립 (auto-floor cost 포함)
  writeFileSync(join(dir, futureName), futureJson);
  finishFixture(root, runB);                                 // ZZZZ의 after = [finish] → finish-edge까지 전부 통과
  // 순회(ULID 내림차순): ZZZZ → rOld → r0B. ZZZZ는 **schema 검사 하나만으로** skip되어야 rOld가 반환된다
  // (r0B는 자기 after에 ie(ZZZZ)가 껴 finish-edge 탈락이지만, rOld가 먼저 반환되므로 도달하지 않는다).
  const got = latestInsights(root);
  assert.equal(got.path, rOld.path);
});

test('latest: per-file 예외(깨진 JSON)는 fail-soft로 skip하고 다음 유효 파일 반환', () => {
  const { root, runId, fence } = emitFixture();
  const ok = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.1 });
  finishFixture(root, runId);   // 검사 대상 기제(깨진 JSON)만 고립 — ok는 finish-인접으로 신뢰 전제
  const dir = join(root, '.deep-loop', 'insights');
  writeFileSync(join(dir, 'ZZZZZZZZZZ8888888888888888-insights.json'), '{torn');   // 최신 이름의 깨진 파일
  const got = latestInsights(root);                          // 크래시 없이
  assert.equal(got.path, ok.path);                           // 다음 후보(정상본) 반환
});

test('latest: 참조 run의 event-log 체인 변조(checksum 불변) → 파일 skip, latest null', () => {
  const { root, runId, fence } = emitFixture();
  emitInsights(root, runId, { fence, now: FIXED.getTime() });
  finishFixture(root, runId);   // 검사 대상 기제(체인 변조)만 고립 — finish-edge까지 먼저 충족시켜 둔다
  const ep = join(runDirOf(root, runId), 'event-log.jsonl');
  const lines = readFileSync(ep, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]); first.data = { ...first.data, tampered: true };   // checksum 그대로 → verifyLog가 잡아야 함
  writeFileSync(ep, [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');
  assert.equal(latestInsights(root), null);
});

// ── v1.5.0 (b): finish-edge — 앵커 이후 non-exempt 이벤트가 정확히 finish 하나여야 신뢰 (spec §3) ───
test('v1.5 (b): 정상 emit→auto-floor→finish 인접 → 신뢰', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-fe1-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const r = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  finishFixture(root, runId);
  const got = latestInsights(root);
  assert.equal(got.path, r.path);
});

test('v1.5 (b): mid-run emit(뒤에 business 이벤트) → skip — finish-인접 emit만 신뢰 (2-emit 재시도, r3 앵커 회귀)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-fe2-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const rMid = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.1 });
  newEpisode(root, runId,
    { plugin: 'p', role: 'maker', kind: 'design', point: 'design', fence });
  const rFinal = emitInsights(root, runId, { fence, now: FIXED.getTime() + 60000, rnd: () => 0.2 });
  finishFixture(root, runId);
  assert.equal(latestInsights(root).path, rFinal.path);          // 최신이자 유일하게 finish-인접
  // r3 앵커 회귀: rFinal 파일을 지워 순회가 rMid로 폴백해도, rMid는 자기 앵커 기준 인접성 실패 → null
  unlinkSync(join(root, rFinal.path));
  assert.equal(latestInsights(root), null);
});

test('v1.5 (b): 동일 path 매칭 insights-emitted 이벤트 2개 → fail-closed skip (r3)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-fe6-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const r = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  // 같은 path·sha를 가리키는 중복 insights-emitted 이벤트(규약 밖 — 정상 경로에서 ULID 파일명은 유일)
  appendAnchored(root, runId, { type: 'insights-emitted', data: { path: r.path, sha256: r.sha256, candidates_count: 0 } },
    undefined, undefined, { floor: 1 });
  finishFixture(root, runId);
  assert.equal(latestInsights(root), null);                      // 앵커 모호 → fail-closed
});

test('v1.5 (b): emit→finish 사이 명시 budget record cost(auto_floor 부재) → skip (r1 P2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-fe3-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  recordCost(root, runId, { turns: 3, tokens: 0, requestId: 'insights-cost-1',
    fence: { owner: runId, generation: 1 } });
  finishFixture(root, runId);
  assert.equal(latestInsights(root), null);
});

test('v1.5 (b): finish 후 non-exempt 이벤트(post-finish mutation) → skip (r2 🔴)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-fe4-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  finishFixture(root, runId);
  businessEventFixture(root, runId);
  assert.equal(latestInsights(root), null);
});

test('terminal Codex maker receipt is completion bookkeeping, not a dirty post-finish mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-fe-terminal-cost-'));
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const emitted = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  finishFixture(root, runId);
  terminalMakerReceiptFixture(root, runId);

  assert.equal(latestInsights(root).path, emitted.path);
  const out = computeInsights(root, { selfRunId: runId, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.post_finish_mutated, []);
});

test('v1.5 (b): finish 이벤트 부재(status만 terminal) → skip', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-fe5-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  corruptTerminalWithoutFinish(root, runId);                     // finish 이벤트 없이 status만 전이(레거시/드리프트)
  assert.equal(latestInsights(root), null);
});

// ── v1.5.0 (b′): post_finish_mutated 라벨 — 집계 유지 + 노출 (spec §3, r5 리뷰 라벨 방식) ───
test('v1.5 (b′): finish 후 이벤트 낀 terminal run → post_finish_mutated 라벨 + per_run 유지', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pfm-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const { runId: tainted } = initRun(root, { runtime: 'claude', goal: 'tainted', now: FIXED });
  const { runId: clean } = initRun(root, { runtime: 'claude', goal: 'clean', now: FIXED });
  finishFixture(root, tainted);
  businessEventFixture(root, tainted);                          // post-finish mutation (커널이 현재 막지 않음 — r2 판정)
  finishFixture(root, clean);
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.post_finish_mutated, [tainted]);
  assert.ok(out.per_run[tainted]);                              // 라벨이지 제외가 아니다 — 집계 유지
  assert.ok(out.per_run[clean]);
  assert.equal(out.insights_schema_version, 1);
});

test('v1.5 (b′): emitInsights 반환 JSON에 라벨 2배열 포함 — finish 스킬 소비 배선 (plan-r2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pfm3-'));
  const { runId: dead } = initRun(root, { runtime: 'claude', goal: 'dead', now: FIXED });     // suspicious 대상
  { const d = readState(root, dead).data; d.session_chain.lease.state = 'released'; writeState(root, dead, d); }
  const { runId } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const r = emitInsights(root, runId, { fence, now: FIXED.getTime() });
  assert.deepEqual(r.suspicious_active, [dead]);                // CLI 반환으로 노출 — 2-plane: 소비자는 stdout만 읽는다
  assert.deepEqual(r.post_finish_mutated, []);
});

test('v1.5 (b′): finish 이벤트 없는 terminal 로그(레거시)는 판정 불가 → 라벨 없음', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pfm2-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const { runId: legacy } = initRun(root, { runtime: 'claude', goal: 'legacy', now: FIXED });
  corruptTerminalWithoutFinish(root, legacy);                    // finish 이벤트 없이 status만 terminal
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.post_finish_mutated, []);
  assert.ok(out.per_run[legacy]);
});

// CLI tests
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'deep-loop.mjs');
function cli(root, args, opts = {}) {
  try { return { code: 0, out: execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8', ...opts }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
}

test('CLI insights: read-only 계산 (fence 불필요) + invalid run exit 1 + unknown verb exit 2', () => {
  const { root, runId, fence } = emitFixture();
  const r = cli(root, ['insights', '--json']);
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.out).per_run[runId]);              // self(current) 포함
  assert.equal(cli(root, ['insights', '--run', 'NOPE', '--json']).code, 1);
  assert.equal(cli(root, ['insights', 'bogus-verb']).code, 2);
});

test('CLI insights emit: fence 누락 exit 3 / 정상 emit 후 latest가 반환', () => {
  const { root, runId } = emitFixture();
  assert.equal(cli(root, ['insights', 'emit']).code, 3);
  // Phase6 info-1: 절대 FIXED 대신 상대 오프셋 — 실벽시계가 FIXED보다 과거인 환경(CI 시계 skew)에서도
  // INSIGHTS_NOW_FUTURE 가드(실 Date.now() 비교)를 결정론적으로 통과한다.
  const ok = cli(root, ['insights', 'emit', '--owner', runId, '--generation', '1', '--now', String(Date.now() - 86_400_000)]);
  assert.equal(ok.code, 0);
  finishFixture(root, runId);   // latestInsights는 producer run의 finish-인접 emit만 신뢰한다
  const latest = cli(root, ['insights', 'latest', '--json']);
  assert.equal(JSON.parse(latest.out).path, JSON.parse(ok.out).path);
});

// Phase6 warning-1 (adversarial): --now를 그대로 ulid(now) 파일명에 흘려보내면 latestInsights의 파일명
// 내림차순 선택이 미래 emit을 영구히 latest로 pinning한다 — CLI 경계에서 future --now를 거부한다
// (과거 --now는 자기치유되므로 계속 허용, 결정론적 테스트용 FIXED emit은 위 테스트가 이미 검증).
test('CLI insights emit: 미래 --now는 INSIGHTS_NOW_FUTURE exit 1로 거부 — ULID latest pinning 차단', () => {
  const { root, runId } = emitFixture();
  const future = Date.now() + 6 * 60 * 60 * 1000;   // 현재 + 6시간
  const r = cli(root, ['insights', 'emit', '--owner', runId, '--generation', '1', '--now', String(future)]);
  assert.equal(r.code, 1);
  assert.match(r.err, /INSIGHTS_NOW_FUTURE/);
  const dir = join(root, '.deep-loop', 'insights');
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0);   // 거부된 emit은 파일/tmp 잔재를 남기지 않음
});

test('CLI insights emit: 과거 고정 --now는 계속 성공 (결정론 회귀 방지)', () => {
  const { root, runId } = emitFixture();
  // Phase6 info-1: 절대 FIXED 대신 상대 오프셋 — 실벽시계 기준 항상 과거이므로 CI 시계 skew에 flake하지 않는다.
  const r = cli(root, ['insights', 'emit', '--owner', runId, '--generation', '1', '--now', String(Date.now() - 86_400_000)]);
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.out).path, /-insights\.json$/);
});

test('ledger 스키마: 필수 필드 검증 + 실파일은 스키마 통과', () => {
  assert.equal(validateLedger([]).ok, true);
  assert.equal(validateLedger([{ date: '2026-07-07', insights_ref: 'x', candidates_addressed: ['a'], falsification: 'f' }]).ok, true);
  assert.equal(validateLedger([{ date: 1 }]).ok, false);
  assert.equal(validateLedger('nope').ok, false);
  // 시드 "정확히 빈 배열" 단언은 hill-climbing 계약 §3.3(implementation maker의 append-only 기록)과
  // 첫 append 시점부터 결정론적으로 모순 — 스키마 검증으로 교체 (2026-07-10 사람 승인, T2 변경).
  const seed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'hillclimb-ledger.json'), 'utf8'));
  assert.equal(validateLedger(seed).ok, true);
});

// ── impl-R3 🟡A: fix_cycles 분모에 0-cycle 리뷰 쌍 포함 — RC-only 분모는 평균을 항상 ≥1로 퇴화시켜
// 단발 reject 1건에도 fix_cycles_high가 발행된다 (스펙 §5 임계 1.0의 의미 복원) ───
test('fix_cycles: approve-only 리뷰 쌍도 0으로 분모에 포함된다', () => {
  const loop = {
    run_id: 'RUNZ', goal: 'g', status: 'completed', created_at: iso(T0),
    episodes: [
      { id: '001-m', role: 'maker', kind: 'implement', point: 'implementation', workstream_id: 'ws-a', status: 'done' },
      { id: '002-c', role: 'checker', kind: 'review', point: 'implementation', workstream_id: 'ws-a', status: 'approved' },
      { id: '003-m', role: 'maker', kind: 'implement', point: 'implementation', workstream_id: 'ws-b', status: 'done' },
      { id: '004-c', role: 'checker', kind: 'review', point: 'implementation', workstream_id: 'ws-b', status: 'rejected' },
    ],
  };
  let seq = 0; const ev = (type, data, ts) => ({ seq: ++seq, ts: iso(ts), type, data, checksum: 'x' });
  const events = [
    ev('review-outcome', { episodeId: '002-c', verdict: 'APPROVE' }, T0 + 1000),
    ev('review-outcome', { episodeId: '004-c', verdict: 'REQUEST_CHANGES' }, T0 + 2000),
  ];
  const m = computeRunMetrics(loop, events);
  assert.equal(m.review.fix_cycles['ws-a|implementation'], 0);   // approve-only 쌍이 분모에 존재
  assert.equal(m.review.fix_cycles['ws-b|implementation'], 1);
  // 평균 = (0+1)/2 = 0.5 < 1.0 → 단발 reject가 fix_cycles_high를 만들지 않는다
  assert.ok(!deriveCandidates({ RUNZ: m }).some(c => c.id === 'fix_cycles_high:implementation'));
  // 0-시드가 fix_convergence_slow에 위양성을 만들지도 않는다 — all-zero 시계열(클린 run 3개)은 후보 아님
  const zero = { review: { per_point: {}, fix_cycles: { 'w|impl': 0 } } };
  const three = { A: metricsWith(zero), B: metricsWith(zero), C: metricsWith(zero) };
  assert.ok(!deriveCandidates(three).some(c => c.id === 'fix_convergence_slow:impl'));
});

// ── impl-R3 🟡D: 마이닝 대상은 과거/타 버전 커널이 쓴 run — 이벤트 shape drift로 metrics 산출이
// 불능이어도 run 하나가 insights 전체를 크래시하면 안 된다 (per-run fail-soft → unreadable) ───
test('computeInsights: metrics 산출 불능 run은 unreadable로 fail-soft한다', () => {
  const { root, runId } = emitFixture();
  rawHistory7b(root, runId,
    [{ type: 'review-outcome', now: FIXED.getTime() + 10_000 }]);
  const out = computeInsights(root, { selfRunId: runId, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.ok(out.unreadable.includes(runId));
  assert.equal(out.per_run[runId], undefined);
});

// ── impl-R2 🟡2: 단일 읽기 검증 스냅샷 — line-based 검증 helper (integrity.mjs). verifiedRead가
// 로그를 두 번 읽으면(verifyLog↔readLines) 그 사이 concurrent append가 검증 밖 suffix로 유입된다 ───
test('integrity: verifyLines/verifyHeadLines가 in-memory 라인 배열을 검증한다', async () => {
  const integ = await import('../scripts/lib/integrity.mjs');
  assert.equal(typeof integ.verifyLines, 'function');
  assert.equal(typeof integ.verifyHeadLines, 'function');
  const { root, runId, fence } = emitFixture();
  emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.5 });
  const lines = readLines(root, runId);
  assert.ok(lines.length >= 1);
  assert.equal(integ.verifyLines(lines).ok, true);
  const anchor = readState(root, runId).data.event_log_head;
  assert.equal(integ.verifyHeadLines(lines, anchor).ok, true);
  // anchor 초과 suffix(검증 밖 이벤트)는 head 불일치로 fail
  const extra = [...lines, { ...lines[lines.length - 1], seq: lines.length + 1 }];
  assert.equal(integ.verifyHeadLines(extra, anchor).ok, false);
  // 체인 훼손 감지
  const tampered = lines.map((e, i) => (i === 0 ? { ...e, data: { ...e.data, x: 1 } } : e));
  assert.equal(integ.verifyLines(tampered).ok, false);
});

// ── impl-R2 ℹ️7: malformed run id도 clean 에러 exit 1 (uncaught RUN_ID_INVALID 스택 금지) ───
test('CLI insights --run: malformed run id는 clean RUN_NOT_FOUND exit 1', () => {
  const { root } = emitFixture();
  const r = cli(root, ['insights', '--run', '../nope', '--json']);
  assert.equal(r.code, 1);
  assert.match(String(r.err), /RUN_NOT_FOUND/);
});

// ── impl-R1 🟡2: user-supplied point·kind 키(__proto__)가 plain-object 버킷에서 Object.prototype을
// 오염시키거나 집계를 유실하면 안 된다 (2026-07-08 리뷰 — episode.mjs:33은 비어있지 않은 문자열만 검사) ───
test('computeRunMetrics/deriveCandidates: __proto__ point·kind가 프로토타입을 오염시키지 않고 own-entry로 집계된다', (t) => {
  t.after(() => {
    for (const k of ['checker_count', 'approve', 'request_changes', 'concern', 'sum', 'n', 'recipes']) {
      delete Object.prototype[k];
    }
  });
  const loop = {
    run_id: 'RUNP', goal: 'g', status: 'completed', created_at: iso(T0),
    episodes: [{ id: '001-m', role: 'maker', kind: '__proto__', point: '__proto__', workstream_id: 'ws-01', status: 'done' }],
  };
  let seq = 0; const ev = (type, data, ts) => ({ seq: ++seq, ts: iso(ts), type, data, checksum: 'x' });
  const events = [ev('review-outcome', { episodeId: '001-m', verdict: 'REQUEST_CHANGES' }, T0 + 1000)];
  const m = computeRunMetrics(loop, events);
  // 전역 오염 없음 (p.checker_count++가 Object.prototype에 쓰였는지 검사)
  assert.equal(Object.prototype.checker_count, undefined);
  // __proto__ 키가 own-entry로 정상 집계됨
  assert.equal(m.review.per_point['__proto__'].checker_count, 1);
  assert.equal(m.review.per_point['__proto__'].request_changes, 1);
  assert.equal(m.episodes.by_kind['__proto__'], 1);
  assert.equal(m.review.fix_cycles['ws-01|__proto__'], 1);
  // cross-run 집계 경로(fixCyclesPointStats/perRunPointAverages)도 own-entry로 동작 + 무오염
  const cands = deriveCandidates({ RUNP: m });
  assert.ok(cands.some(c => c.id === 'fix_cycles_high:__proto__'));
  assert.equal(Object.prototype.sum, undefined);
});

// ── v1.6 Minor (b)2: double-finish 명시 회귀 — raw 픽스처 (plan Task 11) ─────
test('post_finish_mutated: legacy double-finish log is labeled (raw fixture — guard-era APIs cannot create this)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-dfin-'));
  const { runId: self } = initRun(root, { runtime: 'claude', goal: 'self', now: FIXED });
  const { runId: doubled } = initRun(root, { runtime: 'claude', goal: 'doubled', now: FIXED });
  finishFixture(root, doubled);                       // 정상 first finish (앵커)
  // 둘째 finish는 v1.6 가드(leaseCheck·관문·FINISH_ALREADY_TERMINAL)가 전부 막으므로 커널 API로는
  // 재현 불가 — 구버전(가드 이전) 로그를 raw로 직조한다: appendEvent(체인 checksum 유지) + head 앵커 재계산.
  rawHistory7b(root, doubled, [{ type: 'finish', now: FIXED.getTime() + 20_000,
    data: { status: 'completed', reportRel: null } }]);
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.ok(!(out.integrity_failed_runs || []).includes(doubled));   // 앵커 유효 — 라벨 경로로 분류 (plan r2)
  assert.ok(out.post_finish_mutated.includes(doubled));              // 둘째 finish도 non-exempt → 라벨
  assert.ok(out.per_run[doubled]);                                   // 라벨이지 제외가 아니다 (집계 유지)
});
