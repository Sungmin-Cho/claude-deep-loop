import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRunMetrics, computeInsights, deriveCandidates, emitInsights, latestInsights, relInsightsPath } from '../scripts/lib/insights.mjs';
import { readState, writeState, runDir as runDirOf } from '../scripts/lib/state.mjs';
import { readLines, appendAnchored } from '../scripts/lib/integrity.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';

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
  const d = readState(root, runId).data; d.status = status; writeState(root, runId, d);
}

test('computeInsights: 터미널 + self만 집계, self_snapshot 표기, loop_sha256 기록', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins-'));
  const { runId: rA } = initRun(root, { goal: 'a', now: FIXED });        // running (self)
  const { runId: rB } = initRun(root, { goal: 'b', now: FIXED });
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
  const { runId: self } = initRun(root, { goal: 'self', now: FIXED });
  const { runId: other } = initRun(root, { goal: 'other', now: FIXED }); // running 타 run
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
  const { runId: self } = initRun(root, { goal: 'self', now: FIXED });
  const { runId: bad } = initRun(root, { goal: 'bad', now: FIXED });
  toTerminal(root, bad);
  const lp = join(runDirOf(root, bad), 'loop.json');
  writeFileSync(lp, readFileSync(lp, 'utf8').replace('"bad"', '"BAD"'));   // hash 불일치 유발
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.integrity_failed_runs, [bad]);
});

test('computeInsights: 전이 race — 재시도가 성공하면 정상 승격 (integrity_failed ❌)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins4-'));
  const { runId: self } = initRun(root, { goal: 'self', now: FIXED });
  const { runId: racy } = initRun(root, { goal: 'racy', now: FIXED });
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

// r2 리뷰 정정(opus S1): initRun은 event-log에 아무 이벤트도 남기지 않는다(event_log_head=GENESIS) —
// 변조 fixture는 tamper 전에 **실제 anchored 이벤트**를 먼저 생성해야 한다. newWorkstream이 이벤트+floor cost를 남긴다.
function seedTamperable(root, goal) {
  const { runId } = initRun(root, { goal, now: FIXED });
  newWorkstream(root, runId, { title: 't', branch: 'b', worktree: '.claude/worktrees/x',
    fence: { owner: runId, generation: 1, intent: 'business' } });   // 이벤트 2줄(workstream-new + cost) 생성
  toTerminal(root, runId);
  return runId;
}

test('computeInsights: 터미널 run의 event-log 변조(JSON-valid, checksum 불변)는 verifyLog로 integrity_failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins5-'));
  const { runId: self } = initRun(root, { goal: 'self', now: FIXED });
  const tam = seedTamperable(root, 'tam');
  const ep = join(runDirOf(root, tam), 'event-log.jsonl');
  const lines = readFileSync(ep, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]); first.data = { ...first.data, tampered: true };   // checksum은 그대로
  writeFileSync(ep, [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');
  const out = computeInsights(root, { selfRunId: self, now: FIXED.getTime(), sleepFn: NOSLEEP });
  assert.deepEqual(out.integrity_failed_runs, [tam]);
});

test('computeInsights: suffix truncation(체인 유효, head anchor stale)은 verifyHead로 integrity_failed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ins6-'));
  const { runId: self } = initRun(root, { goal: 'self', now: FIXED });
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
  const { runId } = initRun(root, { goal: 'g', now: FIXED });
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
  assert.throws(() => emitInsights(root, runId, { fence, now: FIXED.getTime(), renameFn: () => { throw new Error('EIO'); } }), /EIO/);
  assert.ok(readLines(root, runId).some(e => e.type === 'insights-emitted'));   // 이벤트는 anchored
  assert.equal(latestInsights(root), null);                                      // 신뢰 파일 없음 + .tmp- 제외
});

test('latest: 정상 emit → 검증 통과 최신 반환', () => {
  const { root, runId, fence } = emitFixture();
  const r1 = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.1 });
  const r2 = emitInsights(root, runId, { fence, now: FIXED.getTime() + 60000, rnd: () => 0.2 });
  const got = latestInsights(root);
  assert.equal(got.path, r2.path);                          // ULID 최신
  assert.equal(got.envelope.envelope.run_id, runId);
});

test('latest: anchored 이벤트 없는 고아 파일 불신뢰', () => {
  const { root, runId, fence } = emitFixture();
  emitInsights(root, runId, { fence, now: FIXED.getTime() });
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
  const abs = join(root, r.path);
  writeFileSync(abs, readFileSync(abs, 'utf8').replace('"goal": "g"', '"goal": "tampered"'));
  assert.equal(latestInsights(root), null);
});

test('latest: 상위 insights_schema_version 파일은 skip하고 더 오래된 유효 파일을 반환 (schema 분기 고립 검증)', () => {
  const { root, runId, fence } = emitFixture();
  const old = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.1 });
  // r2 리뷰 정정(codex S2): 미래 파일을 path-binding/sha까지 **통과**하도록 만들어 schema 분기만 고립 검증한다 —
  // 테스트 seam으로 appendAnchored를 직접 호출해 그 경로에 대한 anchored 이벤트(sha 일치)를 심는다.
  const dir = join(root, '.deep-loop', 'insights');
  const future = JSON.parse(readFileSync(join(root, old.path), 'utf8'));
  future.payload.insights_schema_version = 99;
  const futureJson = JSON.stringify(future, null, 2);
  const futureName = 'ZZZZZZZZZZ9999999999999999-insights.json';
  const futureRel = `.deep-loop/insights/${futureName}`;
  appendAnchored(root, runId, { type: 'insights-emitted',
    data: { path: futureRel, sha256: contentHash(futureJson), candidates_count: 0 } });   // path-binding+sha 성립
  writeFileSync(join(dir, futureName), futureJson);
  const got = latestInsights(root);
  assert.equal(got.path, old.path);                          // schema 검사 **하나만으로** 미래 파일이 skip되어야 함
});

test('latest: per-file 예외(깨진 JSON)는 fail-soft로 skip하고 다음 유효 파일 반환', () => {
  const { root, runId, fence } = emitFixture();
  const ok = emitInsights(root, runId, { fence, now: FIXED.getTime(), rnd: () => 0.1 });
  const dir = join(root, '.deep-loop', 'insights');
  writeFileSync(join(dir, 'ZZZZZZZZZZ8888888888888888-insights.json'), '{torn');   // 최신 이름의 깨진 파일
  const got = latestInsights(root);                          // 크래시 없이
  assert.equal(got.path, ok.path);                           // 다음 후보(정상본) 반환
});
