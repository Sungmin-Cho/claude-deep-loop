import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { reconcileBudget } from '../scripts/lib/budget.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

function fence(runId) { return { owner: runId, generation: 1, intent: 'business' }; }

test('newEpisode scaffolds request.md, bumps episodes_total, sets current', () => {
  const { root, runId } = seed();
  const { id, requestPath } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', fence: fence(runId) });
  assert.match(id, /^001-deep-work$/);
  assert.ok(existsSync(requestPath));
  const { data } = readState(root, runId);
  assert.equal(data.comprehension.episodes_total, 1);
  assert.equal(data.current_episode, id);
  assert.equal(data.episodes[0].status, 'pending');
  assert.equal(data.episodes[0].verification.checker_episode_required, true);
});

test('recordEpisode non-terminal status + result_* allowed', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', fence: f });
  recordEpisode(root, runId, id, { status: 'in_progress', proof: { result_summary: 'started' }, fence: f });
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
});

test('recordEpisode done requires expected artifacts to exist', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const art = join(root, 'out.txt');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['out.txt'], fence: f });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'], fence: f }), /EPISODE_TERMINAL_NO_PROOF/);
  writeFileSync(art, 'x');
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'], fence: f });
  assert.equal(readState(root, runId).data.episodes[0].status, 'done');
});

// Fix 3: path-traversal plugin name produces safe id and file is inside episodes dir
test('newEpisode with path-traversal plugin name produces safe id and contained path', () => {
  const { root, runId } = seed();
  const { id, requestPath } = newEpisode(root, runId, { plugin: '../../../../etc/evil', role: 'maker', kind: 'x', point: 'implementation', fence: fence(runId) });
  // id must not contain path separators
  assert.match(id, /^001-[a-z0-9-]+$/);
  assert.ok(!/[/\\]/.test(id), 'id must not contain path separators');
  // request file must exist and be under runDir/episodes
  assert.ok(existsSync(requestPath));
  const base = resolve(runDir(root, runId), 'episodes');
  assert.ok(requestPath.startsWith(base), `requestPath ${requestPath} must start with ${base}`);
});

// Codex r2 🟡: newEpisode 에 절대 경로나 '..' 세그먼트가 있는 expectedArtifacts 는 거부.
test('newEpisode throws EPISODE_ARTIFACT_UNSAFE for absolute or path-traversal expectedArtifacts', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['/etc/passwd'], fence: f }),
    /EPISODE_ARTIFACT_UNSAFE/
  );
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['../../x'], fence: f }),
    /EPISODE_ARTIFACT_UNSAFE/
  );
});

// Codex r2 🟡: recordEpisode done 에서 artifacts 가 expected_artifacts 를 커버하지 않으면 EPISODE_ARTIFACTS_INCOMPLETE.
test('recordEpisode done throws EPISODE_ARTIFACTS_INCOMPLETE when artifacts do not cover expected', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const art = join(root, 'out.txt');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['out.txt'], fence: f });
  writeFileSync(art, 'x');
  // artifacts: [] does not cover expected 'out.txt'
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'done', artifacts: [], fence: f }),
    /EPISODE_ARTIFACTS_INCOMPLETE/
  );
});

test('recordEpisode approved/rejected derive from verdict proof', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation', fence: f });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'approved', proof: { verdict: 'REQUEST_CHANGES' }, fence: f }), /EPISODE_TERMINAL_NO_PROOF/);
  recordEpisode(root, runId, id, { status: 'approved', proof: { verdict: 'APPROVE' }, fence: f });
  assert.equal(readState(root, runId).data.episodes[0].status, 'approved');
});

// Codex r3 FIX 2: atomic replay guard — EPISODE_ALREADY_TERMINAL on second terminal call
test('recordEpisode twice on same episode with terminal status throws EPISODE_ALREADY_TERMINAL', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation', fence: f });
  recordEpisode(root, runId, id, { status: 'approved', proof: { verdict: 'APPROVE' }, fence: f });
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'rejected', proof: { verdict: 'REQUEST_CHANGES' }, fence: f }),
    /EPISODE_ALREADY_TERMINAL/
  );
  // Status must be unchanged
  assert.equal(readState(root, runId).data.episodes[0].status, 'approved');
});

// Codex r3 FIX 4: submitted artifact path validation — escaping paths rejected
test('recordEpisode done throws EPISODE_ARTIFACT_ESCAPE for path-traversal in submitted artifacts', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const artPath = join(root, 'out.txt');
  writeFileSync(artPath, 'x');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['out.txt'], fence: f });
  // Submitted artifact includes a path-traversal entry alongside the valid one
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt', '../outside'], fence: f }),
    /EPISODE_ARTIFACT/
  );
});

// Codex impl r7 🔴: malformed non-terminal inputs (null artifacts/proof) must fail BEFORE appendAnchored,
// leaving the event-log anchor consistent (no BUDGET_TAMPERED on next reconcile).
test('recordEpisode rejects null artifacts/proof cleanly without staling the event_log_head anchor', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', fence: f });
  // FENCE_REQUIRED is thrown first when fence is missing, but we pass a valid fence here to test the null artifact/proof path
  assert.throws(() => recordEpisode(root, runId, id, { status: 'in_progress', artifacts: null, fence: f }), /EPISODE_INPUT_INVALID/);
  assert.throws(() => recordEpisode(root, runId, id, { status: 'in_progress', proof: null, fence: f }), /EPISODE_INPUT_INVALID/);
  // anchor must still reconcile (no orphaned event appended)
  assert.doesNotThrow(() => reconcileBudget(root, runId));
  // a well-formed record still works after the rejected attempts
  recordEpisode(root, runId, id, { status: 'in_progress', proof: { result_note: 'ok' }, fence: f });
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
});

// Codex r13: FENCE_REQUIRED — mutators throw when fence is absent
test('newEpisode throws FENCE_REQUIRED when called without fence', () => {
  const { root, runId } = seed();
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation' }),
    /FENCE_REQUIRED/
  );
});

// Fix 3: newEpisode throws EPISODE_INPUT_INVALID for missing required fields
test('newEpisode throws EPISODE_INPUT_INVALID when role is missing', () => {
  const { root, runId } = seed();
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', kind: 'impl', point: 'implementation', fence: fence(runId) }),
    /EPISODE_INPUT_INVALID/
  );
});

// Codex impl r15 🟡: a non-null nonexistent workstream is rejected at creation (no stranded/unreviewable maker).
test('newEpisode rejects a non-null nonexistent workstream; no episode created, anchor stays consistent', () => {
  const { root, runId } = seed();
  const f = fence(runId);
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', workstream: 'ws-nope', fence: f }),
    /WORKSTREAM_NOT_FOUND/
  );
  assert.equal(readState(root, runId).data.episodes.length, 0);   // no stranded episode
  assert.doesNotThrow(() => reconcileBudget(root, runId));          // preCheck threw before append → anchor consistent
});
