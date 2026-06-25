import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { reserveHandoff, releaseLease, acquireLease } from '../scripts/lib/lease.mjs';
import { emitHandoff, buildLaunchCommand } from '../scripts/lib/handoff.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

function expect_(runId) { return { owner: runId, generation: 1 }; }

test('buildLaunchCommand produces per-OS commands referencing child run + resume', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'PARENT', childRunId: 'CHILD', handoffRel: 'handoffs/x.md', headless: false });
  assert.match(c.interactive, /claude -n/);
  assert.match(c.macos, /osascript/);
  assert.match(c.windows, /wt\.exe/);
  assert.match(c.tmux, /tmux/);
  assert.match(c.interactive, /deep-loop-resume/);
});

test('emitHandoff writes md + compaction-state(M3) + launch-command, chains session, sets releasing', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const r = emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', now, expect: expect_(runId) });
  assert.equal(r.ok, true);
  assert.ok(existsSync(r.handoffPath));
  // compaction-state는 M3 envelope (producer=deep-loop, parent_run_id=runId)
  const cs = JSON.parse(readFileSync(join(runDir(root, runId), 'handoffs', r.csName), 'utf8'));
  assert.equal(cs.envelope.producer, 'deep-loop');
  assert.equal(cs.envelope.parent_run_id, runId);
  const { data } = readState(root, runId);
  assert.equal(data.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(data.session_chain.lease.state, 'releasing');
  const cur = data.session_chain.sessions.find(s => s.run_id === runId);
  assert.equal(cur.superseded_by, r.childRunId);
  assert.ok(data.session_chain.sessions.some(s => s.run_id === r.childRunId));
  const md = readFileSync(r.handoffPath, 'utf8');
  assert.match(md, /이전 대화/);
  assert.match(md, /\/deep-loop-resume/);
});

test('emitHandoff dedups: second trigger while in-flight is a no-op', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const ex = expect_(runId);
  assert.equal(emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex }).ok, true);
  const second = emitHandoff(root, runId, { trigger: 'precompact', now, expect: ex });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'handoff-in-flight');
});

// Codex r1 🔴1: 같은 트리거 재호출은 새 child/session 을 만들지 않고 기존 emit 을 멱등 반환.
test('emitHandoff same-trigger re-entry is idempotent (one child, no duplicate session)', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const ex = expect_(runId);
  const first = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  const again = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'already-emitted');
  assert.equal(again.childRunId, first.childRunId);
  assert.equal(again.handoffRel, first.handoffRel);  // 전체 메타데이터 멱등 반환 (Codex r2 🔴1) → respawn 이 올바른 경로 사용
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});

// launch 명령이 **부모** run 경로의 handoff 파일을 가리키는지 (Codex r1 🔴3)
test('launch command references parent run dir handoff path', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'PARENT', childRunId: 'CHILD', handoffRel: 'handoffs/x.md', headless: false });
  assert.match(c.interactive, /\.deep-loop\/runs\/PARENT\/handoffs\/x\.md/);
  assert.match(c.interactive, /deep-loop-CHILD/);
});

// Fix 3: emitHandoff with stale expect is fenced at reserve step; correct expect succeeds
test('emitHandoff: stale expect fences at reserve (no mutation); correct expect proceeds', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  // Stale owner → fenced
  const r1 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: { owner: 'WRONG', generation: 1 } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'fenced');
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
  // Correct expect → succeeds
  const r2 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: { owner: runId, generation: 1 } });
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, 'emitted');
});

// Fix 3: emitHandoff with generation bumped (lease acquired by another actor) → fenced at reserve step
test('emitHandoff: lease stolen before call → fenced at reserve, new owner lease intact', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const CHILD2 = 'CHILD2-ACTOR';
  // Lease is released and taken by another actor (generation bumps to 2)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  acquireLease(root, runId, { owner: CHILD2, expectGeneration: 1, now });
  // emitHandoff with stale expect (original owner/gen=1) → fenced at reserveHandoff (generation mismatch)
  const r = emitHandoff(root, runId, { trigger: 'milestone', now, expect: { owner: runId, generation: 1 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fenced');
  // New owner's lease is intact (not mutated)
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.owner_run_id, CHILD2);
  assert.equal(lease.generation, 2);
  assert.equal(lease.handoff_phase, 'acquired');
});

// Codex r3 🔴1: reserve 후 session 미생성(첫 emit 중단) 상태에서 재진입해도 reserve 가 영속한 childRunId 로 1개만 생성.
test('emitHandoff fall-through after bare reserve reuses reserved childRunId (no duplicate child)', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const ex = expect_(runId);
  const r = reserveHandoff(root, runId, { trigger: 'milestone', now });
  assert.equal(r.reserved, true);
  const e1 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  assert.equal(e1.childRunId, r.childRunId);
  const e2 = emitHandoff(root, runId, { trigger: 'milestone', now, expect: ex });
  assert.equal(e2.childRunId, r.childRunId);
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});

// Codex r13: FENCE_REQUIRED — emitHandoff throws when expect is absent
test('emitHandoff throws FENCE_REQUIRED when called without expect', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  assert.throws(
    () => emitHandoff(root, runId, { trigger: 'milestone', now }),
    /FENCE_REQUIRED/
  );
});

test('buildLaunchCommand headless requests metric-bearing output', () => {
  const cmds = buildLaunchCommand({ root: '/r', parentRunId: 'p', childRunId: 'c', handoffRel: 'handoffs/x.md', headless: true });
  assert.match(cmds.headless, /--output-format json/);
  assert.match(cmds.interactive, /--output-format json/);   // headless=true 면 interactive 필드도 headless 명령
});
