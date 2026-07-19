import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode, abandonEpisode } from './helpers/episode-request.mjs';
import { ack, computeDebt } from '../scripts/lib/comprehension.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { verifyLog } from '../scripts/lib/integrity.mjs';
import { seedCorrelatedTerminal } from './fixtures/verified-app-run.mjs';

// Non-headless env for attended human acks — the test runner may inherit a headless CLAUDE_CODE_ENTRYPOINT,
// so pass an explicit empty env whenever an ack should NOT be treated as headless.
const ATTENDED = {};
function eventLog(root, runId) {
  return readFileSync(join(runDir(root, runId), 'event-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function freshRun(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-comp-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  return { root, runId, fence };
}

test('debt ratio computed; blocked when over threshold', () => {
  const r = computeDebt({ comprehension: { episodes_total: 10, episodes_human_reviewed: 4, debt_threshold: 0.5 } });
  assert.equal(r.debt_ratio, 0.6);
  assert.equal(r.blocked, true);
});
test('under threshold not blocked', () => {
  const r = computeDebt({ comprehension: { episodes_total: 10, episodes_human_reviewed: 6, debt_threshold: 0.5 } });
  assert.equal(r.blocked, false);
});
test('zero episodes → debt 0, not blocked', () => {
  const r = computeDebt({ comprehension: { episodes_total: 0, episodes_human_reviewed: 0, debt_threshold: 0.5 } });
  assert.equal(r.debt_ratio, 0);
  assert.equal(r.blocked, false);
});

test('ack is idempotent and validates episode existence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ack-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const ep = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  ack(root, runId, ep.id, { actor: 'human', confirm: true, env: ATTENDED, fence });
  ack(root, runId, ep.id, { actor: 'human', confirm: true, env: ATTENDED, fence });   // 중복 — 카운트 증가 금지
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 1);
  assert.throws(() => ack(root, runId, 'ghost', { actor: 'human', confirm: true, env: ATTENDED, fence }), /EPISODE_NOT_FOUND/);
  assert.throws(() => ack(root, runId, ep.id, { actor: 'human', confirm: true, env: ATTENDED, fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);
});

test('abandonEpisode decrements episodes_total for a maker (0-clamp)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 1);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
});

test('abandonEpisode also decrements episodes_human_reviewed when the maker was acked', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  ack(root, runId, id, { actor: 'human', confirm: true, env: ATTENDED, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 1);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_total, 0);
  assert.equal(c.episodes_human_reviewed, 0);
});

test('abandonEpisode is idempotent-safe: double abandon rejected, counters not double-decremented', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.throws(() => abandonEpisode(root, runId, id, { reason: 'again', confirm: true, fence }), /EPISODE_ALREADY_TERMINAL/);
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
});

test('abandonEpisode clamps episodes_total at 0 for a legacy/corrupt run (total already 0)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  const data = readState(root, runId).data; data.comprehension.episodes_total = 0; writeState(root, runId, data);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
});

// P2-a regression: an abandoned NON-reviewed maker is out of BOTH comprehension counters and must be UN-ackable —
// a later ack must NOT bump episodes_human_reviewed (otherwise reviewed/total can exceed 1 and debt wrongly drops to 0,
// unblocking fan-out). After abandon, ep.human_reviewed is set true (primary fix) AND ack/recordReviewed skip an
// abandoned episode (belt-and-suspenders) → ack is a no-op either way.
test('P2-a: ack on an abandoned (never-reviewed) maker is a no-op — episodes_human_reviewed stays 0', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 1);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  // abandoned maker is out of episodes_total …
  assert.equal(readState(root, runId).data.comprehension.episodes_total, 0);
  // … and the maker is marked reviewed so ack returns early as a no-op (no double count into episodes_human_reviewed)
  const r = ack(root, runId, id, { actor: 'human', confirm: true, env: ATTENDED, fence });
  assert.equal(r.ok, true);
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_human_reviewed, 0, 'ack on an abandoned maker must not increment episodes_human_reviewed');
  assert.equal(c.episodes_total, 0);
  // computeDebt must not be corrupted to reviewed/total > 1 (debt 0): with both counters 0 → debt 0, not blocked.
  assert.equal(computeDebt(readState(root, runId).data).debt_ratio, 0);
});

// P2-a belt-and-suspenders: even if an abandoned episode somehow has human_reviewed=false (legacy/corrupt state),
// the comprehension guard makes ack a no-op purely from status==='abandoned' (independent of the episode.mjs fix).
test('P2-a: ack guard skips an abandoned episode with human_reviewed=false (status-based no-op)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  // Force the legacy/corrupt shape: abandoned but human_reviewed reset to false.
  const data = readState(root, runId).data; data.episodes.find(e => e.id === id).human_reviewed = false; writeState(root, runId, data);
  ack(root, runId, id, { actor: 'human', confirm: true, env: ATTENDED, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 0, 'status==abandoned guard must keep ack a no-op');
});

// ── #1: human/agent ack separation (tamper-evident + 절차 금지 + headless fail-closed) ──

// #1(a): actor='agent' must route to the AGENT counter only — the human gate (episodes_human_reviewed,
// the one computeDebt reads) must stay untouched so a machine review never lowers comprehension debt.
test('#1(a): agent ack accrues to episodes_agent_reviewed, never the human gate counter', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  const r = ack(root, runId, id, { actor: 'agent', env: ATTENDED, fence });
  assert.equal(r.ok, true);
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_human_reviewed, 0, 'agent ack must not touch the human gate counter');
  assert.equal(c.episodes_agent_reviewed, 1, 'agent ack increments the agent counter');
  // agent ack is idempotent (no double count)
  ack(root, runId, id, { actor: 'agent', env: ATTENDED, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_agent_reviewed, 1);
});

// #1(default): actor defaults to 'agent' — an unqualified ack never releases the human gate.
test('#1: ack defaults to actor=agent (gate not released)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  ack(root, runId, id, { env: ATTENDED, fence });
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_human_reviewed, 0);
  assert.equal(c.episodes_agent_reviewed, 1);
});

// #1(d): a successful ack lands in the tamper-evident event-log as a comprehension-ack event (with actor context) —
// the old withLock+writeState path left NO audit trail. verifyLog must stay green after the anchored append.
test('#1(d): ack appends a comprehension-ack event (audit trail) + keeps the log verifiable', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  ack(root, runId, id, { actor: 'human', confirm: true, env: ATTENDED, fence });
  const ev = eventLog(root, runId).find(e => e.type === 'comprehension-ack');
  assert.ok(ev, 'ack must append a comprehension-ack event');
  assert.equal(ev.data.actor, 'human');
  assert.equal(ev.data.headless, false);
  assert.equal(verifyLog(root, runId).ok, true);
});

// #1(c): a headless invocation asserting actor='human' is fail-closed — single flow: append a
// comprehension-ack-rejected event (never a counter bump) THEN return non-ok. Three simultaneous assertions.
test('#1(c): headless + actor=human → ack-rejected event, counter untouched, non-ok returned', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  const r = ack(root, runId, id, { actor: 'human', confirm: true, env: { DEEP_LOOP_UNATTENDED: '1' }, fence });
  assert.equal(r.ok, false);
  assert.equal(r.rejected, true);
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 0, 'headless human ack must not release the gate');
  const rej = eventLog(root, runId).find(e => e.type === 'comprehension-ack-rejected');
  assert.ok(rej, 'a comprehension-ack-rejected event must be appended (post-audit)');
  assert.equal(rej.data.reason, 'headless-human-ack-forbidden');
  assert.equal(verifyLog(root, runId).ok, true);
});

test('#1(c): Codex human ack ignores the Claude entrypoint heuristic', () => {
  const { root, runId, fence } = freshRun('codex');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  const r = ack(root, runId, id, {
    actor: 'human',
    confirm: true,
    env: { CLAUDE_CODE_ENTRYPOINT: 'print' },
    fence,
  });
  assert.equal(r.ok, true);
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 1);
  assert.ok(!eventLog(root, runId).some(e => e.type === 'comprehension-ack-rejected'));
});

test('#1(c): Codex human ack still rejects an explicit driver marker', () => {
  const { root, runId, fence } = freshRun('codex');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  const r = ack(root, runId, id, {
    actor: 'human',
    confirm: true,
    env: { CLAUDE_CODE_ENTRYPOINT: 'print', DEEP_LOOP_HEADLESS: '1' },
    fence,
  });
  assert.equal(r.ok, false);
  assert.equal(r.rejected, true);
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 0);
});

// #1(f) (plan-R1 Fix 1): the lib itself enforces confirm/actor BEFORE any mutation, so a CLI-bypass direct call
// cannot mint human credit. Neither rejected attempt may touch a counter or append an event.
test('#1(f): lib ack enforces confirm/actor before any mutation (CLI-bypass guard)', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  assert.throws(() => ack(root, runId, id, { actor: 'human', confirm: false, env: ATTENDED, fence }), /CONFIRM_REQUIRED/);
  assert.throws(() => ack(root, runId, id, { actor: 'bogus', env: ATTENDED, fence }), /INVALID_ACTOR/);
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_human_reviewed || 0, 0);
  assert.equal(c.episodes_agent_reviewed || 0, 0);
  // no event appended by the rejected attempts (a fresh run's log has only the episode-new event)
  assert.ok(!eventLog(root, runId).some(e => e.type === 'comprehension-ack' || e.type === 'comprehension-ack-rejected'));
});

// impl-R3 Fix 5: ack must target a MAKER episode. episodes_total counts only makers, so acking a checker would
// inflate episodes_human_reviewed past episodes_total and drop debt_ratio below threshold with no maker reviewed.
test('#1(Fix5): ack rejects a non-maker (checker) episode — both counters stay 0', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation', fence });
  assert.throws(() => ack(root, runId, id, { actor: 'human', confirm: true, env: ATTENDED, fence }), /ACK_NOT_MAKER/);
  assert.throws(() => ack(root, runId, id, { actor: 'agent', env: ATTENDED, fence }), /ACK_NOT_MAKER/);
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_human_reviewed || 0, 0);
  assert.equal(c.episodes_agent_reviewed || 0, 0);
});

// #1: abandon decrements the agent counter symmetrically (mirrors the human-counter decrement).
test('#1: abandonEpisode decrements episodes_agent_reviewed when the maker was agent-acked', () => {
  const { root, runId, fence } = freshRun();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: null, expectedArtifacts: [], fence });
  ack(root, runId, id, { actor: 'agent', env: ATTENDED, fence });
  assert.equal(readState(root, runId).data.comprehension.episodes_agent_reviewed, 1);
  abandonEpisode(root, runId, id, { reason: 'orphan', confirm: true, fence });
  const c = readState(root, runId).data.comprehension;
  assert.equal(c.episodes_total, 0);
  assert.equal(c.episodes_agent_reviewed, 0);
});

// ── v1.6 recordReviewed terminal 가드 (spec §2.3-7 / §4-5g) ──────────────────
import { recordReviewed } from '../scripts/lib/comprehension.mjs';

test('recordReviewed: terminal run throws RUN_TERMINAL, counters unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-comp-t-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  seedCorrelatedTerminal(root, runId, { status: 'stopped' });
  assert.throws(() => recordReviewed(root, runId, 'ep-x', 'src',
    { fence: { owner: runId, generation: 1 }, requestId: 'terminal-reviewed' }),
  /RUN_TERMINAL: recordReviewed/);
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed || 0, 0);
});

import { test as testComprehension7e } from 'node:test';
import assertComprehension7e from 'node:assert/strict';
import { newEpisode as newEpisode7e } from './helpers/episode-request.mjs';
import { ack as ack7e, recordReviewed as recordReviewed7e }
  from '../scripts/lib/comprehension.mjs';
import { durableRunBytes as comprehensionBytes7e,
  rawHashValidState as rawComprehension7e,
  verifiedAppRun as comprehensionFixture7e } from './fixtures/verified-app-run.mjs';

const ATTENDED7E = {};

testComprehension7e('comprehension runtime and recordReviewed no-op require a verified snapshot', () => {
  const fixture = comprehensionFixture7e('dl-comprehension-proof-');
  const fence = { owner: fixture.owner, generation: fixture.generation,
    intent: 'business' };
  const { id } = newEpisode7e(fixture.root, fixture.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    expectedArtifacts: [], fence,
  });
  rawComprehension7e(fixture.root, fixture.runId, loop => {
    loop.review.require_human_ack = true;
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:01.000Z';
  });
  const before = comprehensionBytes7e(fixture.root, fixture.runId);

  assertComprehension7e.throws(() => ack7e(fixture.root, fixture.runId, id, {
    actor: 'agent', env: ATTENDED7E,
    fence: { ...fence, owner: 'wrong-owner' },
  }), /LEASE_FENCED/);
  assertComprehension7e.throws(() => ack7e(fixture.root, fixture.runId, id,
    { actor: 'agent', env: ATTENDED7E, fence }), /RUN_SNAPSHOT_INVALID/);
  assertComprehension7e.throws(() => recordReviewed7e(fixture.root, fixture.runId, id,
    'deep-review-approve', { fence, requestId: 'corrupt-reviewed' }),
  /RUN_SNAPSHOT_INVALID/);
  assertComprehension7e.deepEqual(comprehensionBytes7e(fixture.root, fixture.runId), before,
    'failed ack/no-op paths must not change state, hash, or events');
});

import { spawnSync as spawnComprehension7g } from 'node:child_process';
import { rmdirSync as rmdirComprehension7g } from 'node:fs';
import { fileURLToPath as fileComprehension7g } from 'node:url';
import { durableRunBytes as comprehensionBytes7g,
  rawHashValidState as rawComprehension7g,
  verifiedAppRun as comprehensionFixture7g } from './fixtures/verified-app-run.mjs';

test('recordReviewed requires explicit authority and journals one fixed request receipt', () => {
  const fixture = comprehensionFixture7g('dl-comprehension-7g-');
  const fence = { owner: fixture.owner, generation: fixture.generation };
  const { id } = newEpisode7e(fixture.root, fixture.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    expectedArtifacts: [], fence: { ...fence, intent: 'business' },
  });
  const initial = comprehensionBytes7g(fixture.root, fixture.runId);
  assert.throws(() => recordReviewed7e(fixture.root, fixture.runId, id, 'manual'),
    /FENCE_REQUIRED: recordReviewed/);
  assert.throws(() => recordReviewed7e(fixture.root, fixture.runId, id, 'manual', { fence }),
    /REQUEST_ID_REQUIRED: recordReviewed/);
  assert.throws(() => recordReviewed7e(fixture.root, fixture.runId, id, 'manual', {
    fence: { ...fence, owner: 'wrong-owner' }, requestId: 'reviewed-wrong-fence',
  }), /LEASE_FENCED/);
  assert.deepEqual(comprehensionBytes7g(fixture.root, fixture.runId), initial);

  const request = { fence, requestId: 'reviewed-success' };
  assert.equal(recordReviewed7e(fixture.root, fixture.runId, id, 'manual', request), undefined);
  const events = eventLog(fixture.root, fixture.runId)
    .filter(event => event.type === 'comprehension-reviewed');
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0].data).sort(), [
    'changed', 'episode_id', 'generation', 'owner_run_id', 'request_digest',
    'request_id_digest', 'source',
  ].sort());
  assert.deepEqual({ changed: events[0].data.changed, episode: events[0].data.episode_id,
    source: events[0].data.source }, { changed: true, episode: id, source: 'manual' });
  assert.equal(readState(fixture.root, fixture.runId)
    .data.comprehension.episodes_human_reviewed, 1);
  const committed = comprehensionBytes7g(fixture.root, fixture.runId);
  assert.equal(recordReviewed7e(fixture.root, fixture.runId, id, 'manual', request), undefined);
  assert.deepEqual(comprehensionBytes7g(fixture.root, fixture.runId), committed,
    'exact response-loss retry is byte-preserving');
  assert.throws(() => recordReviewed7e(fixture.root, fixture.runId, id, 'other', request),
    /COMPREHENSION_REQUEST_CONFLICT/);
  assert.deepEqual(comprehensionBytes7g(fixture.root, fixture.runId), committed);
});

test('recordReviewed semantic no-ops are verified and write-free', () => {
  const make = prefix => {
    const fixture = comprehensionFixture7g(prefix);
    const fence = { owner: fixture.owner, generation: fixture.generation };
    const { id } = newEpisode7e(fixture.root, fixture.runId, {
      plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
      expectedArtifacts: [], fence: { ...fence, intent: 'business' },
    });
    return { ...fixture, fence, id };
  };
  const human = make('dl-comprehension-7g-human-');
  rawComprehension7g(human.root, human.runId,
    loop => { loop.review.require_human_ack = true; });
  const humanBefore = comprehensionBytes7g(human.root, human.runId);
  assert.equal(recordReviewed7e(human.root, human.runId, human.id,
    'deep-review-approve', { fence: human.fence, requestId: 'human-ack-noop' }), undefined);
  assert.deepEqual(comprehensionBytes7g(human.root, human.runId), humanBefore);

  const abandoned = make('dl-comprehension-7g-abandoned-');
  abandonEpisode(abandoned.root, abandoned.runId, abandoned.id,
    { reason: 'orphan', confirm: true, fence: { ...abandoned.fence, intent: 'business' } });
  rawComprehension7g(abandoned.root, abandoned.runId, loop => {
    loop.episodes.find(item => item.id === abandoned.id).human_reviewed = false;
  });
  const abandonedBefore = comprehensionBytes7g(abandoned.root, abandoned.runId);
  assert.equal(recordReviewed7e(abandoned.root, abandoned.runId, abandoned.id, 'manual',
    { fence: abandoned.fence, requestId: 'abandoned-noop' }), undefined);
  assert.deepEqual(comprehensionBytes7g(abandoned.root, abandoned.runId), abandonedBefore);

  const already = make('dl-comprehension-7g-already-');
  recordReviewed7e(already.root, already.runId, already.id, 'manual',
    { fence: already.fence, requestId: 'already-setup' });
  const alreadyBefore = comprehensionBytes7g(already.root, already.runId);
  assert.equal(recordReviewed7e(already.root, already.runId, already.id, 'manual',
    { fence: already.fence, requestId: 'already-noop' }), undefined);
  assert.deepEqual(comprehensionBytes7g(already.root, already.runId), alreadyBefore);
});

test('recordReviewed response-loss recovery converges through its public API', () => {
  const fixture = comprehensionFixture7g('dl-comprehension-7g-crash-');
  const fence = { owner: fixture.owner, generation: fixture.generation };
  const { id } = newEpisode7e(fixture.root, fixture.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    expectedArtifacts: [], fence: { ...fence, intent: 'business' },
  });
  const worker = fileComprehension7g(
    new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
  const request = { episodeId: id, source: 'crash-reviewed',
    requestId: 'crash-reviewed-request' };
  const child = spawnComprehension7g(process.execPath,
    [worker, fixture.root, fixture.runId, 'comprehension-reviewed', 'pending-after-rename'], {
      encoding: 'utf8', shell: false,
      env: { ...process.env, DEEP_LOOP_CRASH_OWNER: fixture.owner,
        DEEP_LOOP_CRASH_GENERATION: String(fixture.generation),
        DEEP_LOOP_CRASH_INPUT: JSON.stringify(request) },
    });
  assert.equal(child.status, 91, child.stderr || child.stdout);
  rmdirComprehension7g(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
  assert.equal(recordReviewed7e(fixture.root, fixture.runId, id, request.source,
    { fence, requestId: request.requestId }), undefined);
  assert.equal(eventLog(fixture.root, fixture.runId)
    .filter(event => event.type === 'comprehension-reviewed').length, 1);
  assert.equal(readState(fixture.root, fixture.runId)
    .data.comprehension.episodes_human_reviewed, 1);
});

test('recordReviewed pending recovery rejects wrong runtime without changing bytes', () => {
  for (const point of ['pending-after-rename', 'state-after-rename']) {
    const fixture = comprehensionFixture7g(`dl-comprehension-runtime-${point}-`);
    const fence = { owner: fixture.owner, generation: fixture.generation };
    const { id } = newEpisode7e(fixture.root, fixture.runId, {
      plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
      expectedArtifacts: [], fence: { ...fence, intent: 'business' },
    });
    const worker = fileComprehension7g(
      new URL('./helpers/anchored-crash-worker.mjs', import.meta.url));
    const request = { episodeId: id, source: 'crash-reviewed-runtime',
      requestId: `crash-reviewed-${point}` };
    const child = spawnComprehension7g(process.execPath,
      [worker, fixture.root, fixture.runId, 'comprehension-reviewed', point], {
        encoding: 'utf8', shell: false,
        env: { ...process.env, DEEP_LOOP_CRASH_OWNER: fixture.owner,
          DEEP_LOOP_CRASH_GENERATION: String(fixture.generation),
          DEEP_LOOP_CRASH_INPUT: JSON.stringify(request) },
      });
    assert.equal(child.status, 91, child.stderr || child.stdout);
    rmdirComprehension7g(join(fixture.root, '.deep-loop', 'runs', fixture.runId, '.lock'));
    const pending = comprehensionBytes7g(fixture.root, fixture.runId);
    assert.throws(() => recordReviewed7e(fixture.root, fixture.runId, id, request.source,
      { fence: { ...fence, runtime: 'claude' }, requestId: request.requestId }),
    /LEASE_FENCED: RUNTIME_FENCED/);
    assert.deepEqual(comprehensionBytes7g(fixture.root, fixture.runId), pending,
      `${point}: wrong runtime must not recover comprehension bytes`);
    assert.equal(recordReviewed7e(fixture.root, fixture.runId, id, request.source,
      { fence: { ...fence, runtime: 'codex' }, requestId: request.requestId }), undefined);
  }
});
