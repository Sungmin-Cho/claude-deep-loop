import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureCheckpointSet,
  emitCompactCheckpoint,
  selectCheckpoint as selectCheckpointFromSet,
} from '../scripts/lib/checkpoint.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { ulid, wrap } from '../scripts/lib/envelope.mjs';

const NOW_MS = Date.parse('2026-07-20T00:00:00.000Z');
const NOW = new Date(NOW_MS);
const noRun = () => ({ code: 1, stdout: '', stderr: '' });
const selectCheckpoint = (root, runId, identity) => {
  const selected = selectCheckpointFromSet(captureCheckpointSet(root, runId), identity);
  return selected?.path ?? null;
};

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'dl-checkpoint-'));
}

function initClaude(root) {
  return initRun(root, {
    runtime: 'claude', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1,
  });
}

const loopPathOf = (root, runId) => join(runDir(root, runId), 'loop.json');
const hashPathOf = (root, runId) => join(runDir(root, runId), '.loop.hash');
const logPathOf = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');
const checkpointDirOf = (root, runId) => join(runDir(root, runId), 'checkpoints');

test('emitCompactCheckpoint: artifact-only — loop.json bytes and .loop.hash unchanged, no lease change', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const episode = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    expectedArtifacts: ['artifacts/result.json'], fence: { owner: runId, generation: 1 },
  });
  const before = readFileSync(loopPathOf(root, runId), 'utf8');
  const beforeHash = readFileSync(hashPathOf(root, runId), 'utf8');
  const beforeLog = readFileSync(logPathOf(root, runId), 'utf8');
  const beforeState = readState(root, runId).data;
  const beforeLease = structuredClone(beforeState.session_chain.lease);
  const expectedNext = nextAction(beforeState, { now: NOW_MS, unattended: false });

  const r = emitCompactCheckpoint(root, runId, { now: NOW_MS });

  assert.ok(r.ok && existsSync(r.path));
  assert.equal(readFileSync(loopPathOf(root, runId), 'utf8'), before);
  assert.equal(readFileSync(hashPathOf(root, runId), 'utf8'), beforeHash);
  assert.equal(readFileSync(logPathOf(root, runId), 'utf8'), beforeLog);
  assert.deepEqual(readState(root, runId).data.session_chain.lease, beforeLease);
  const env = JSON.parse(readFileSync(r.path, 'utf8'));
  assert.equal(env.envelope.artifact_kind, 'compact-checkpoint');
  assert.deepEqual(env.envelope.schema, { name: 'compact-checkpoint', version: '1.0' });
  assert.equal(env.envelope.generated_at, new Date(NOW_MS).toISOString());
  assert.equal(env.payload.owner_run_id, runId);
  assert.equal(env.payload.generation, 1);
  assert.equal(env.payload.loop_hash, beforeHash.trim());
  assert.equal(env.payload.current_episode, episode.id);
  assert.deepEqual(env.payload.current_episode_detail, {
    id: episode.id,
    role: 'maker',
    status: 'pending',
    point: 'implementation',
    workstream_id: null,
  });
  assert.deepEqual(env.payload.active_workstreams, []);
  assert.deepEqual(env.payload.next_action_hint, {
    type: expectedNext.action.type,
    next_command: expectedNext.next_command,
  });
  assert.deepEqual(env.payload.artifacts, ['artifacts/result.json']);
});

test('retention: latest-5 with current-owner preference', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const dir = checkpointDirOf(root, runId);
  mkdirSync(dir, { recursive: true });
  const { data, hash } = readState(root, runId);
  const generation = data.session_chain.lease.generation;

  for (let i = 1; i <= 5; i += 1) {
    const stale = wrap({
      producer: 'deep-loop',
      artifact_kind: 'compact-checkpoint',
      schema: { name: 'compact-checkpoint', version: '1.0' },
      run_id: runId,
      payload: { owner_run_id: 'stale-owner', generation, loop_hash: hash },
      now: new Date(NOW_MS + i).toISOString(),
    });
    writeFileSync(join(dir, `${ulid(NOW_MS + i, 0)}-compact.json`), JSON.stringify(stale, null, 2));
  }

  const valid = emitCompactCheckpoint(root, runId, { now: NOW_MS });
  const files = readdirSync(dir).filter(file => file.endsWith('-compact.json'));

  assert.equal(files.length, 5);
  assert.equal(existsSync(valid.path), true, 'current owner/generation checkpoint must survive stale-owner pressure');
});

test('retention: owner protection ignores forged checkpoint identity', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const dir = checkpointDirOf(root, runId);
  mkdirSync(dir, { recursive: true });
  const { data, hash } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const generation = data.session_chain.lease.generation;

  const forged = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-checkpoint',
    schema: { name: 'compact-checkpoint', version: '1.0' },
    run_id: runId,
    payload: { owner_run_id: owner, generation, loop_hash: hash },
    now: new Date(NOW_MS).toISOString(),
  });
  forged.envelope.artifact_kind = 'foreign-checkpoint';
  const forgedPath = join(dir, `${ulid(NOW_MS, 0)}-compact.json`);
  writeFileSync(forgedPath, JSON.stringify(forged, null, 2));

  for (let i = 1; i <= 5; i += 1) {
    const stale = wrap({
      producer: 'deep-loop',
      artifact_kind: 'compact-checkpoint',
      schema: { name: 'compact-checkpoint', version: '1.0' },
      run_id: runId,
      payload: { owner_run_id: 'stale-owner', generation, loop_hash: hash },
      now: new Date(NOW_MS + i).toISOString(),
    });
    writeFileSync(join(dir, `${ulid(NOW_MS + i, 0)}-compact.json`), JSON.stringify(stale, null, 2));
  }

  const valid = emitCompactCheckpoint(root, runId, { now: NOW_MS + 6 });

  assert.equal(existsSync(forgedPath), false, 'foreign envelope must not receive current-owner protection');
  assert.equal(existsSync(valid.path), true);
  assert.equal(readdirSync(dir).filter(file => file.endsWith('-compact.json')).length, 5);
});

test('selectCheckpoint: unwraps identity and requires owner+generation+loop_hash triple match; none → null', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const first = emitCompactCheckpoint(root, runId, { now: NOW_MS });
  const second = emitCompactCheckpoint(root, runId, { now: NOW_MS + 1 });
  const { data, hash } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const generation = data.session_chain.lease.generation;

  assert.equal(selectCheckpoint(root, runId, { owner, generation, loopHash: hash }), second.path);
  assert.equal(selectCheckpoint(root, runId, { owner: 'other-owner', generation, loopHash: hash }), null);
  assert.equal(selectCheckpoint(root, runId, { owner, generation: generation + 1, loopHash: hash }), null);
  assert.equal(selectCheckpoint(root, runId, { owner, generation, loopHash: 'wrong-hash' }), null);

  const forged = JSON.parse(readFileSync(second.path, 'utf8'));
  forged.envelope.artifact_kind = 'foreign-checkpoint';
  writeFileSync(second.path, JSON.stringify(forged, null, 2));
  assert.equal(selectCheckpoint(root, runId, { owner, generation, loopHash: hash }), first.path);

  const advanced = readState(root, runId).data;
  advanced.discovered_items.push({ note: 'advance state revision' });
  writeState(root, runId, advanced);
  const freshHash = readState(root, runId).hash;
  assert.notEqual(freshHash, hash);
  assert.equal(selectCheckpoint(root, runId, { owner, generation, loopHash: freshHash }), null);
});
