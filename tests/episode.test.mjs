import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('newEpisode scaffolds request.md, bumps episodes_total, sets current', () => {
  const { root, runId } = seed();
  const { id, requestPath } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation' });
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
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation' });
  recordEpisode(root, runId, id, { status: 'in_progress', proof: { result_summary: 'started' } });
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
});

test('recordEpisode done requires expected artifacts to exist', () => {
  const { root, runId } = seed();
  const art = join(root, 'out.txt');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['out.txt'] });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'] }), /EPISODE_TERMINAL_NO_PROOF/);
  writeFileSync(art, 'x');
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'] });
  assert.equal(readState(root, runId).data.episodes[0].status, 'done');
});

// Fix 3: path-traversal plugin name produces safe id and file is inside episodes dir
test('newEpisode with path-traversal plugin name produces safe id and contained path', () => {
  const { root, runId } = seed();
  const { id, requestPath } = newEpisode(root, runId, { plugin: '../../../../etc/evil', role: 'maker', kind: 'x', point: 'implementation' });
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
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['/etc/passwd'] }),
    /EPISODE_ARTIFACT_UNSAFE/
  );
  assert.throws(
    () => newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['../../x'] }),
    /EPISODE_ARTIFACT_UNSAFE/
  );
});

// Codex r2 🟡: recordEpisode done 에서 artifacts 가 expected_artifacts 를 커버하지 않으면 EPISODE_ARTIFACTS_INCOMPLETE.
test('recordEpisode done throws EPISODE_ARTIFACTS_INCOMPLETE when artifacts do not cover expected', () => {
  const { root, runId } = seed();
  const art = join(root, 'out.txt');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['out.txt'] });
  writeFileSync(art, 'x');
  // artifacts: [] does not cover expected 'out.txt'
  assert.throws(
    () => recordEpisode(root, runId, id, { status: 'done', artifacts: [] }),
    /EPISODE_ARTIFACTS_INCOMPLETE/
  );
});

test('recordEpisode approved/rejected derive from verdict proof', () => {
  const { root, runId } = seed();
  const { id } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation' });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'approved', proof: { verdict: 'REQUEST_CHANGES' } }), /EPISODE_TERMINAL_NO_PROOF/);
  recordEpisode(root, runId, id, { status: 'approved', proof: { verdict: 'APPROVE' } });
  assert.equal(readState(root, runId).data.episodes[0].status, 'approved');
});
