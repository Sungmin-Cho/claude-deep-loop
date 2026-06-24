import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import {
  newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal,
  inheritWorkstreams, integrationOrder,
} from '../scripts/lib/workspace.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('newWorkstream creates planned workstream with kernel fields', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'Auth Core', branch: 'dl/auth', worktree: '.worktrees/dl/auth', baseCommit: 'abc' });
  const ws = readState(root, runId).data.workstreams.find(w => w.id === id);
  assert.match(id, /^ws-01-auth-core$/);
  assert.equal(ws.status, 'planned');
  assert.equal(ws.branch, 'dl/auth');
  assert.equal(ws.worktree, '.worktrees/dl/auth');
});

test('setWorkstreamStatus non-terminal ok; terminal value rejected', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' });
  setWorkstreamStatus(root, runId, id, 'in_progress');
  assert.deepEqual(readState(root, runId).data.active_workstreams, [id]);
  assert.throws(() => setWorkstreamStatus(root, runId, id, 'merged'), /WORKSTREAM_TERMINAL_NO_PROOF/);
});

test('max_parallel enforced on activation', () => {
  const { root, runId } = seed(); // max_parallel default 2
  const a = newWorkstream(root, runId, { title: 'A', branch: 'a', worktree: 'wa' }).id;
  const b = newWorkstream(root, runId, { title: 'B', branch: 'b', worktree: 'wb' }).id;
  const c = newWorkstream(root, runId, { title: 'C', branch: 'c', worktree: 'wc' }).id;
  setWorkstreamStatus(root, runId, a, 'in_progress');
  setWorkstreamStatus(root, runId, b, 'in_progress');
  assert.throws(() => setWorkstreamStatus(root, runId, c, 'in_progress'), /MAX_PARALLEL_EXCEEDED/);
});

test('recordWorkstreamTerminal derives terminal from proof content; clears active', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' });
  setWorkstreamStatus(root, runId, id, 'in_progress');
  // ready FAILS when review_points_done is empty (kernel-derived, not proof shortcut)
  assert.throws(() => recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: {} }), /WORKSTREAM_TERMINAL_NO_PROOF/);
  // Populate review_points_done via readState+writeState to all review.points
  {
    const { data } = readState(root, runId);
    const ws = data.workstreams.find(w => w.id === id);
    ws.review_points_done = [...(data.review?.points || [])];
    writeState(root, runId, data);
  }
  // Now ready SUCCEEDS (proof can be empty — derivation is from state)
  recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: {} });
  const { data } = readState(root, runId);
  assert.equal(data.workstreams.find(w => w.id === id).status, 'ready');
  assert.equal(data.active_workstreams.includes(id), false);
  // merged 는 사람 승인(merge_commit + human_approved) 필수 — 임의 proof 거부 (proposal-only)
  const { id: id2 } = newWorkstream(root, runId, { title: 'B', branch: 'b2', worktree: 'w2' });
  assert.throws(() => recordWorkstreamTerminal(root, runId, id2, { status: 'merged', proof: { x: true } }), /WORKSTREAM_TERMINAL_NO_PROOF/);
  recordWorkstreamTerminal(root, runId, id2, { status: 'merged', proof: { merge_commit: 'abc123', human_approved: true } });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === id2).status, 'merged');
});

test('setWorkstreamStatus throws WORKSTREAM_TERMINAL_LOCKED when workstream is terminal', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'C', branch: 'c', worktree: 'wc' });
  setWorkstreamStatus(root, runId, id, 'in_progress');
  // Mark it ready via state manipulation + recordWorkstreamTerminal
  {
    const { data } = readState(root, runId);
    const ws = data.workstreams.find(w => w.id === id);
    ws.review_points_done = [...(data.review?.points || [])];
    writeState(root, runId, data);
  }
  recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: {} });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === id).status, 'ready');
  // Now trying to set it back to in_progress must fail
  assert.throws(() => setWorkstreamStatus(root, runId, id, 'in_progress'), /WORKSTREAM_TERMINAL_LOCKED/);
});

// Codex r2 🔴: 터미널→터미널 전환 차단 — merged 는 흡수; ready→merged 는 허용; abandoned→merged 는 차단.
test('recordWorkstreamTerminal blocks terminal->terminal rewrites (merged/abandoned absorbing)', () => {
  const { root, runId } = seed();
  // Set up a workstream that is already merged
  const { id: idM } = newWorkstream(root, runId, { title: 'M', branch: 'bm', worktree: 'wm' });
  recordWorkstreamTerminal(root, runId, idM, { status: 'merged', proof: { merge_commit: 'abc123', human_approved: true } });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idM).status, 'merged');
  // merged → abandoned must throw WORKSTREAM_TERMINAL_LOCKED
  assert.throws(
    () => recordWorkstreamTerminal(root, runId, idM, { status: 'abandoned', proof: { reason: 'x' } }),
    /WORKSTREAM_TERMINAL_LOCKED/
  );

  // Set up a workstream that is 'ready' and confirm it CAN go to 'merged'
  const { id: idR } = newWorkstream(root, runId, { title: 'R', branch: 'br', worktree: 'wr' });
  {
    const { data } = readState(root, runId);
    const ws = data.workstreams.find(w => w.id === idR);
    ws.review_points_done = [...(data.review?.points || [])];
    writeState(root, runId, data);
  }
  recordWorkstreamTerminal(root, runId, idR, { status: 'ready', proof: {} });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idR).status, 'ready');
  // ready → merged must succeed (the only allowed terminal→terminal transition)
  recordWorkstreamTerminal(root, runId, idR, { status: 'merged', proof: { merge_commit: 'def456', human_approved: true } });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idR).status, 'merged');

  // Set up an abandoned workstream — cannot go to merged
  const { id: idA } = newWorkstream(root, runId, { title: 'Ab', branch: 'ba2', worktree: 'wa2' });
  recordWorkstreamTerminal(root, runId, idA, { status: 'abandoned', proof: { reason: 'no longer needed' } });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idA).status, 'abandoned');
  assert.throws(
    () => recordWorkstreamTerminal(root, runId, idA, { status: 'merged', proof: { merge_commit: 'xyz', human_approved: true } }),
    /WORKSTREAM_TERMINAL_LOCKED/
  );
});

test('inheritWorkstreams reports missing worktree paths (no silent recreate)', () => {
  const { root, runId } = seed();
  const present = join(root, 'wt-present'); mkdirSync(present, { recursive: true });
  const a = newWorkstream(root, runId, { title: 'A', branch: 'a', worktree: present }).id;
  const b = newWorkstream(root, runId, { title: 'B', branch: 'b', worktree: join(root, 'wt-gone') }).id;
  setWorkstreamStatus(root, runId, a, 'in_progress');
  setWorkstreamStatus(root, runId, b, 'in_progress');
  const r = inheritWorkstreams(root, runId);
  assert.deepEqual(r.inherited, [a]);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].id, b);
});

test('integrationOrder topo-sorts by depends_on and detects cycles', () => {
  const { root, runId } = seed();
  const core = newWorkstream(root, runId, { title: 'Core', branch: 'c', worktree: 'wc' }).id;
  const ui = newWorkstream(root, runId, { title: 'UI', branch: 'u', worktree: 'wu', dependsOn: [core] }).id;
  const { data } = readState(root, runId);
  const r = integrationOrder(data);
  assert.equal(r.cycle, false);
  assert.ok(r.order.indexOf(core) < r.order.indexOf(ui));
  // inject a cycle
  data.workstreams[0].depends_on = [ui];
  assert.equal(integrationOrder(data).cycle, true);
  // 미지 의존 → missing 보고 + order 비움 (Codex r2 🟡9)
  data.workstreams[0].depends_on = ['ws-99-nonexistent'];
  data.workstreams[1].depends_on = [];
  const m = integrationOrder(data);
  assert.equal(m.missing.length, 1);
  assert.deepEqual(m.order, []);
});
