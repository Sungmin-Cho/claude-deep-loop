import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import {
  newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal,
  inheritWorkstreams, integrationOrder,
} from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { createDirectoryJunction, fixtureDir } from './helpers/fs-fixtures.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

function fence(runId) { return { owner: runId, generation: 1, intent: 'business' }; }

function bindWorkstream(root, runId, workstreamId, f) {
  const { id } = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation',
    point: 'implementation', workstream: workstreamId, fence: f,
  });
  recordEpisode(root, runId, id, { status: 'in_progress', fence: f });
}

function clearOwnerScope(root, runId) {
  const { data } = readState(root, runId);
  const scope = data.session_chain.sessions.find(session => session.run_id === runId).scope;
  scope.workstream_id = null;
  scope.bound_at_seq = null;
  writeState(root, runId, data);
}

test('newWorkstream creates planned workstream with kernel fields', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'Auth Core', branch: 'dl/auth', worktree: '.worktrees/dl/auth', baseCommit: 'abc', fence: fence(runId) });
  const ws = readState(root, runId).data.workstreams.find(w => w.id === id);
  assert.match(id, /^ws-01-auth-core$/);
  assert.equal(ws.status, 'planned');
  assert.equal(ws.branch, 'dl/auth');
  assert.equal(ws.worktree, '.worktrees/dl/auth');
});

test('setWorkstreamStatus non-terminal ok; terminal value rejected', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: fence(runId) });
  setWorkstreamStatus(root, runId, id, 'in_progress', { fence: fence(runId) });
  assert.deepEqual(readState(root, runId).data.active_workstreams, [id]);
  assert.throws(() => setWorkstreamStatus(root, runId, id, 'merged', { fence: fence(runId) }), /WORKSTREAM_TERMINAL_NO_PROOF/);
});

test('max_parallel enforced on activation', () => {
  const { root, runId } = seed(); // max_parallel default 2
  const f = fence(runId);
  const a = newWorkstream(root, runId, { title: 'A', branch: 'a', worktree: '.claude/worktrees/wa', fence: f }).id;
  const b = newWorkstream(root, runId, { title: 'B', branch: 'b', worktree: '.claude/worktrees/wb', fence: f }).id;
  const c = newWorkstream(root, runId, { title: 'C', branch: 'c', worktree: '.claude/worktrees/wc', fence: f }).id;
  setWorkstreamStatus(root, runId, a, 'in_progress', { fence: f });
  setWorkstreamStatus(root, runId, b, 'in_progress', { fence: f });
  assert.throws(() => setWorkstreamStatus(root, runId, c, 'in_progress', { fence: f }), /MAX_PARALLEL_EXCEEDED/);
});

test('recordWorkstreamTerminal derives terminal from proof content; clears active', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', fence: f });
  bindWorkstream(root, runId, id, f);
  setWorkstreamStatus(root, runId, id, 'in_progress', { fence: f });
  // ready FAILS when review_points_done is empty (kernel-derived, not proof shortcut)
  assert.throws(() => recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: {}, fence: f }), /WORKSTREAM_TERMINAL_NO_PROOF/);
  // Populate review_points_done via readState+writeState to all review.points
  {
    const { data } = readState(root, runId);
    const ws = data.workstreams.find(w => w.id === id);
    ws.review_points_done = [...(data.review?.points || [])];
    writeState(root, runId, data);
  }
  // Now ready SUCCEEDS (proof can be empty — derivation is from state)
  recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: {}, fence: f });
  const { data } = readState(root, runId);
  assert.equal(data.workstreams.find(w => w.id === id).status, 'ready');
  assert.equal(data.active_workstreams.includes(id), false);
  // merged 는 사람 승인(merge_commit + human_approved) 필수 — 임의 proof 거부 (proposal-only)
  const { id: id2 } = newWorkstream(root, runId, { title: 'B', branch: 'b2', worktree: '.claude/worktrees/w2', fence: f });
  assert.throws(() => recordWorkstreamTerminal(root, runId, id2, {
    status: 'merged', proof: { merge_commit: 'abc123', human_approved: true }, fence: f,
  }), /WORKSTREAM_TERMINAL_LOCKED/);
  {
    const state = readState(root, runId).data;
    state.workstreams.find(w => w.id === id2).status = 'ready';
    writeState(root, runId, state);
  }
  assert.throws(() => recordWorkstreamTerminal(root, runId, id2, { status: 'merged', proof: { x: true }, fence: f }), /WORKSTREAM_TERMINAL_NO_PROOF/);
  recordWorkstreamTerminal(root, runId, id2, { status: 'merged', proof: { merge_commit: 'abc123', human_approved: true }, fence: f });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === id2).status, 'merged');
});

test('setWorkstreamStatus throws WORKSTREAM_TERMINAL_LOCKED when workstream is terminal', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newWorkstream(root, runId, { title: 'C', branch: 'c', worktree: '.claude/worktrees/wc', fence: f });
  bindWorkstream(root, runId, id, f);
  setWorkstreamStatus(root, runId, id, 'in_progress', { fence: f });
  // Mark it ready via state manipulation + recordWorkstreamTerminal
  {
    const { data } = readState(root, runId);
    const ws = data.workstreams.find(w => w.id === id);
    ws.review_points_done = [...(data.review?.points || [])];
    writeState(root, runId, data);
  }
  recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: {}, fence: f });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === id).status, 'ready');
  // Now trying to set it back to in_progress must fail
  assert.throws(() => setWorkstreamStatus(root, runId, id, 'in_progress', { fence: f }), /WORKSTREAM_TERMINAL_LOCKED/);
});

// Codex r2 🔴: 터미널→터미널 전환 차단 — merged 는 흡수; ready→merged 는 허용; abandoned→merged 는 차단.
test('recordWorkstreamTerminal blocks terminal->terminal rewrites (merged/abandoned absorbing)', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  // Set up a workstream that is already merged
  const { id: idM } = newWorkstream(root, runId, { title: 'M', branch: 'bm', worktree: '.claude/worktrees/wm', fence: f });
  {
    const { data } = readState(root, runId);
    data.workstreams.find(w => w.id === idM).status = 'ready';
    writeState(root, runId, data);
  }
  recordWorkstreamTerminal(root, runId, idM, { status: 'merged', proof: { merge_commit: 'abc123', human_approved: true }, fence: f });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idM).status, 'merged');
  // merged → abandoned must throw WORKSTREAM_TERMINAL_LOCKED
  assert.throws(
    () => recordWorkstreamTerminal(root, runId, idM, { status: 'abandoned', proof: { reason: 'x' }, fence: f }),
    /WORKSTREAM_TERMINAL_LOCKED/
  );

  // Set up a workstream that is 'ready' and confirm it CAN go to 'merged'
  const { id: idR } = newWorkstream(root, runId, { title: 'R', branch: 'br', worktree: '.claude/worktrees/wr', fence: f });
  bindWorkstream(root, runId, idR, f);
  {
    const { data } = readState(root, runId);
    const ws = data.workstreams.find(w => w.id === idR);
    ws.review_points_done = [...(data.review?.points || [])];
    writeState(root, runId, data);
  }
  recordWorkstreamTerminal(root, runId, idR, { status: 'ready', proof: {}, fence: f });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idR).status, 'ready');
  // ready → merged must succeed (the only allowed terminal→terminal transition)
  recordWorkstreamTerminal(root, runId, idR, { status: 'merged', proof: { merge_commit: 'def456', human_approved: true }, fence: f });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idR).status, 'merged');

  // Set up an abandoned workstream — cannot go to merged
  clearOwnerScope(root, runId);
  const { id: idA } = newWorkstream(root, runId, { title: 'Ab', branch: 'ba2', worktree: '.claude/worktrees/wa2', fence: f });
  bindWorkstream(root, runId, idA, f);
  recordWorkstreamTerminal(root, runId, idA, { status: 'abandoned', proof: { reason: 'no longer needed' }, fence: f });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === idA).status, 'abandoned');
  assert.throws(
    () => recordWorkstreamTerminal(root, runId, idA, { status: 'merged', proof: { merge_commit: 'xyz', human_approved: true }, fence: f }),
    /WORKSTREAM_TERMINAL_LOCKED/
  );
});

// Codex r3 FIX 2: atomic terminal guard — second recordWorkstreamTerminal throws WORKSTREAM_TERMINAL_LOCKED
test('recordWorkstreamTerminal twice on same workstream → second throws WORKSTREAM_TERMINAL_LOCKED', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newWorkstream(root, runId, { title: 'T', branch: 'b', worktree: '.claude/worktrees/w', fence: f });
  bindWorkstream(root, runId, id, f);
  // First terminal call (abandoned is immediately takeable from planned without review points)
  recordWorkstreamTerminal(root, runId, id, { status: 'abandoned', proof: { reason: 'no longer needed' }, fence: f });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === id).status, 'abandoned');
  // Second call — must throw WORKSTREAM_TERMINAL_LOCKED atomically
  assert.throws(
    () => recordWorkstreamTerminal(root, runId, id, { status: 'abandoned', proof: { reason: 'retry' }, fence: f }),
    /WORKSTREAM_TERMINAL_LOCKED/
  );
  // Status must be unchanged
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === id).status, 'abandoned');
});

test('inheritWorkstreams reports missing worktree paths (no silent recreate)', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const present = join(root, '.claude', 'worktrees', 'wt-present'); mkdirSync(present, { recursive: true });
  const a = newWorkstream(root, runId, { title: 'A', branch: 'a', worktree: present, fence: f }).id;
  const b = newWorkstream(root, runId, { title: 'B', branch: 'b', worktree: join(root, '.claude', 'worktrees', 'wt-gone'), fence: f }).id;
  setWorkstreamStatus(root, runId, a, 'in_progress', { fence: f });
  setWorkstreamStatus(root, runId, b, 'in_progress', { fence: f });
  const r = inheritWorkstreams(root, runId);
  assert.deepEqual(r.inherited, [a]);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].id, b);
});

test('inheritWorkstreams reconciles a prepared worktree-path update before reporting inheritance', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const present = join(root, '.claude', 'worktrees', 'wt-before');
  mkdirSync(present, { recursive: true });
  const id = newWorkstream(root, runId, {
    title: 'Reconciled', branch: 'reconciled', worktree: present, fence: f,
  }).id;
  setWorkstreamStatus(root, runId, id, 'in_progress', { fence: f });
  assert.throws(() => appendAnchored(
    root,
    runId,
    { type: 'worktree-relocated', data: { id }, now: '2026-07-23T01:00:00.000Z' },
    loop => { loop.workstreams.find(workstream => workstream.id === id).worktree = '.claude/worktrees/wt-after'; },
    undefined,
    {
      publication: {
        kind: 'worktree-relocated', operationId: 'worktree-relocated', artifacts: [], topology: { id },
        faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('barrier'); },
      },
    },
  ), /TRANSACTION_PENDING/);

  assert.deepEqual(inheritWorkstreams(root, runId), {
    inherited: [],
    missing: [{ id, worktree: '.claude/worktrees/wt-after', reason: 'worktree-path-missing' }],
  });
});

// Codex r6 🟡: workstream input validation
test('newWorkstream throws WORKSTREAM_INPUT_INVALID for empty title', () => {
  const { root, runId } = seed();
  assert.throws(
    () => newWorkstream(root, runId, { title: '', branch: 'b', worktree: '.claude/worktrees/w', fence: fence(runId) }),
    /WORKSTREAM_INPUT_INVALID/
  );
});

test('newWorkstream throws WORKSTREAM_INPUT_INVALID for non-array dependsOn', () => {
  const { root, runId } = seed();
  assert.throws(
    () => newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: '.claude/worktrees/w', dependsOn: true, fence: fence(runId) }),
    /WORKSTREAM_INPUT_INVALID/
  );
});

test('integrationOrder treats non-array depends_on as no-deps (defensive)', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  // Create workstream normally
  newWorkstream(root, runId, { title: 'Core', branch: 'c', worktree: '.claude/worktrees/wc', fence: f });
  // Inject malformed depends_on via writeState
  {
    const { data } = readState(root, runId);
    data.workstreams[0].depends_on = 'bad-value';
    writeState(root, runId, data);
  }
  // Should not throw — malformed treated as no-deps
  const { data } = readState(root, runId);
  const r = integrationOrder(data);
  assert.equal(r.cycle, false);
  assert.equal(r.missing.length, 0);
  assert.deepEqual(r.order, [data.workstreams[0].id]);
});

test('integrationOrder topo-sorts by depends_on and detects cycles', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const core = newWorkstream(root, runId, { title: 'Core', branch: 'c', worktree: '.claude/worktrees/wc', fence: f }).id;
  const ui = newWorkstream(root, runId, { title: 'UI', branch: 'u', worktree: '.claude/worktrees/wu', dependsOn: [core], fence: f }).id;
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

// Codex r13: FENCE_REQUIRED — mutators throw when fence is absent
test('newWorkstream throws FENCE_REQUIRED when called without fence', () => {
  const { root, runId } = seed();
  assert.throws(
    () => newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }),
    /FENCE_REQUIRED/
  );
});

test('newWorkstream rejects worktree outside project root (containment)', () => {
  const { root, runId } = seed();
  for (const bad of ['/tmp/escape-wt', '../sibling/wt', '.claude/worktrees/../../escape',
                     'tmp/ws', 'src', root, '.']) {
    assert.throws(
      () => newWorkstream(root, runId, { title: 'X', branch: 'b', worktree: bad, fence: fence(runId) }),
      /WORKSTREAM_WORKTREE_ESCAPE/, `must reject ${bad}`);
  }
});

test('newWorkstream allows worktree under convention dirs (.claude/worktrees/ or .worktrees/)', () => {
  const { root, runId } = seed();
  // .claude/worktrees/ convention (relative)
  assert.ok(newWorkstream(root, runId, { title: 'Rel', branch: 'b2', worktree: '.claude/worktrees/ws', fence: fence(runId) }).id);
  // .claude/worktrees/ convention (absolute)
  assert.ok(newWorkstream(root, runId, { title: 'Abs', branch: 'b3', worktree: join(root, '.claude/worktrees/ws2'), fence: fence(runId) }).id);
  // .worktrees/ convention (relative)
  assert.ok(newWorkstream(root, runId, { title: 'Wt', branch: 'b6', worktree: '.worktrees/ws3', fence: fence(runId) }).id);
  // .worktrees/ convention (absolute)
  assert.ok(newWorkstream(root, runId, { title: 'WtAbs', branch: 'b7', worktree: join(root, '.worktrees/ws4'), fence: fence(runId) }).id);
});

test('newWorkstream rejects a junction/reparse-like worktree parent escaping root', () => {
  const { root, runId } = seed();
  const outside = fixtureDir('dl-outside-junction-');   // 프로젝트 밖 실제 디렉터리
  mkdirSync(join(root, '.claude'), { recursive: true });
  createDirectoryJunction(outside, join(root, '.claude', 'worktrees'));
  mkdirSync(join(outside, 'ws'), { recursive: true });           // 실제 worktree 는 outside/ws
  // lexical 로는 root 밑처럼 보이나 realpath 는 outside → 거부돼야 함.
  assert.throws(
    () => newWorkstream(root, runId, { title: 'Sym', branch: 'bs', worktree: '.claude/worktrees/ws', fence: fence(runId) }),
    /WORKSTREAM_WORKTREE_ESCAPE/, 'symlinked parent escaping root rejected');
});

// FIX M: dangling symlink component (.claude/worktrees -> nonexistent target) must also be rejected.
// existsSync returns false for dangling symlinks (follows symlink, target absent) so _resolveDeep
// previously treated them as absent leaves and reconstructed a lexical path → escape once target created.
test('newWorkstream rejects dangling symlink worktree component (FIX M)', () => {
  const { root, runId } = seed();
  mkdirSync(join(root, '.claude'), { recursive: true });
  // Create a privilege-free Windows junction (directory symlink elsewhere), then remove its target so the
  // component is dangling on every host without blanket-skipping the containment assertion.
  const target = fixtureDir('dl-dangling-target-');
  createDirectoryJunction(target, join(root, '.claude', 'worktrees'));
  rmSync(target, { recursive: true, force: true });
  assert.throws(
    () => newWorkstream(root, runId, { title: 'Dangle', branch: 'bd', worktree: '.claude/worktrees/ws', fence: fence(runId) }),
    /WORKSTREAM_WORKTREE_ESCAPE/, 'dangling symlink component must be rejected');
});

// Confirm normal absent leaf (no symlink) still accepted under convention dir
test('newWorkstream allows absent (not-yet-created) worktree leaf under convention dir', () => {
  const { root, runId } = seed();
  // No symlinks — the leaf simply does not exist yet (normal worktree creation path)
  const id = newWorkstream(root, runId, { title: 'Future', branch: 'bf', worktree: '.claude/worktrees/future-ws', fence: fence(runId) }).id;
  assert.match(id, /^ws-\d+-/, 'absent-leaf worktree accepted');
});

// FIX Q: kernel must normalize stored worktree to root-relative regardless of whether absolute or
// relative input is given — so artifact paths (derived from stored worktree prefix) stay root-relative
// and pass episode.mjs containment (which rejects absolute/.. paths).
test('newWorkstream normalizes absolute worktree input to root-relative in stored state (FIX Q)', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  // Absolute input: <root>/.claude/worktrees/ws-abs → stored as .claude/worktrees/ws-abs
  newWorkstream(root, runId, { title: 'AbsClaude', branch: 'b-abs-c', worktree: join(root, '.claude/worktrees/ws-abs'), fence: f });
  const ws1 = readState(root, runId).data.workstreams.find(w => w.branch === 'b-abs-c');
  assert.equal(ws1.worktree, '.claude/worktrees/ws-abs', 'absolute .claude/worktrees/ input stored root-relative');

  // Absolute input: <root>/.worktrees/ws-abs2 → stored as .worktrees/ws-abs2
  newWorkstream(root, runId, { title: 'AbsWt', branch: 'b-abs-w', worktree: join(root, '.worktrees/ws-abs2'), fence: f });
  const ws2 = readState(root, runId).data.workstreams.find(w => w.branch === 'b-abs-w');
  assert.equal(ws2.worktree, '.worktrees/ws-abs2', 'absolute .worktrees/ input stored root-relative');

  // Relative input: stored unchanged
  newWorkstream(root, runId, { title: 'Rel', branch: 'b-rel', worktree: '.claude/worktrees/ws-rel', fence: f });
  const ws3 = readState(root, runId).data.workstreams.find(w => w.branch === 'b-rel');
  assert.equal(ws3.worktree, '.claude/worktrees/ws-rel', 'relative input stored as-is (already root-relative)');
});

test('newWorkstream stores backslash relative input as a slash-normalized durable path', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  newWorkstream(root, runId, {
    title: 'Windows Relative', branch: 'b-win-rel',
    worktree: '.claude\\worktrees\\windows-relative', fence: f,
  });
  const ws = readState(root, runId).data.workstreams.find(w => w.branch === 'b-win-rel');
  assert.equal(ws.worktree, '.claude/worktrees/windows-relative');
});
