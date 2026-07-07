import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRunMetrics } from '../scripts/lib/insights.mjs';

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
