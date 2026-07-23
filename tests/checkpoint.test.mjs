import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureCheckpointSet,
  emitCompactCheckpoint,
  emitLegacyCompactCheckpointFromTrustedHook,
  inspectCompactCheckpoint,
  restoreCompactCheckpoint,
  selectCheckpoint as selectCheckpointFromSet,
} from '../scripts/lib/checkpoint.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { contentHash, ulid, wrap } from '../scripts/lib/envelope.mjs';
import { projectRootDigest } from '../scripts/lib/project-root.mjs';
import { newWorkstream, setWorkstreamStatus } from '../scripts/lib/workspace.mjs';
import { createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

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
  const result = initRun(root, {
    runtime: 'claude', goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1,
  });
  const dir = runDir(root, result.runId);
  const loopPath = join(dir, 'loop.json');
  const legacy = JSON.parse(readFileSync(loopPath, 'utf8'));
  legacy.schema_version = '0.3.0';
  delete legacy.project.binding_generation;
  delete legacy.autonomy.attended_launch_approval;
  delete legacy.session_chain.lease.takeover_kind;
  for (const session of legacy.session_chain.sessions) delete session.scope;
  legacy.autonomy.continuation_policy = 'compact-in-place';
  legacy.autonomy.milestone_predicate = ['workstream_status_change'];
  const raw = JSON.stringify(legacy, null, 2);
  writeFileSync(loopPath, raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  return result;
}

function initCurrent(root, runtime = 'claude') {
  return initRun(root, {
    runtime, goal: 'g', detected: {}, now: NOW, env: {}, platform: 'darwin', run: noRun, pid: 1,
  });
}

const loopPathOf = (root, runId) => join(runDir(root, runId), 'loop.json');
const hashPathOf = (root, runId) => join(runDir(root, runId), '.loop.hash');
const logPathOf = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');
const checkpointDirOf = (root, runId) => join(runDir(root, runId), 'checkpoints');
const strictCheckpointPath = (root, runId, emitted) => join(runDir(root, runId), emitted.checkpoint_rel);

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

  const r = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS });

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

  const valid = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS });
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

  const valid = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 6 });

  assert.equal(existsSync(forgedPath), false, 'foreign envelope must not receive current-owner protection');
  assert.equal(existsSync(valid.path), true);
  assert.equal(readdirSync(dir).filter(file => file.endsWith('-compact.json')).length, 5);
});

test('selectCheckpoint: unwraps identity and requires owner+generation+loop_hash triple match; none → null', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const first = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS });
  const second = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS + 1 });
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

test('public emit never downgrades to legacy and preserves fence, runtime, and terminal checks', () => {
  const wrongFence = freshRoot();
  const { runId: fencedRunId } = initClaude(wrongFence);
  assert.throws(() => emitCompactCheckpoint(wrongFence, fencedRunId, {
    fence: { owner: fencedRunId, generation: 9 },
    runtime: 'claude',
    now: NOW_MS,
  }), /LEASE_FENCED/);

  const wrongRuntime = freshRoot();
  const { runId: runtimeRunId } = initClaude(wrongRuntime);
  assert.throws(() => emitCompactCheckpoint(wrongRuntime, runtimeRunId, {
    fence: { owner: runtimeRunId, generation: 1 },
    runtime: 'codex',
    now: NOW_MS,
  }), /RUNTIME_FENCED/);

  const active = freshRoot();
  const { runId: activeRunId } = initClaude(active);
  assert.throws(() => emitCompactCheckpoint(active, activeRunId, {
    fence: { owner: activeRunId, generation: 1 },
    runtime: 'claude',
    now: NOW_MS,
  }), /CHECKPOINT_LEGACY_TRUST_REQUIRED/);
  assert.equal(existsSync(checkpointDirOf(active, activeRunId)), false);

  const terminal = freshRoot();
  const { runId: terminalRunId } = initClaude(terminal);
  const terminalState = readState(terminal, terminalRunId).data;
  terminalState.status = 'stopped';
  writeState(terminal, terminalRunId, terminalState);
  assert.throws(() => emitCompactCheckpoint(terminal, terminalRunId, {
    fence: { owner: terminalRunId, generation: 1 },
    runtime: 'claude',
    now: NOW_MS,
  }), /LEASE_FENCED: RUN_TERMINAL/);
  assert.equal(existsSync(checkpointDirOf(terminal, terminalRunId)), false);
});

function seedBound(runtime = 'claude', {
  expectedArtifacts,
  point = 'implementation',
} = {}) {
  const root = freshRoot();
  const { runId } = initCurrent(root, runtime);
  const fence = { owner: runId, generation: 1 };
  const worktree = '.claude/worktrees/checkpoint';
  mkdirSync(join(root, worktree), { recursive: true });
  const workstreamId = newWorkstream(root, runId, {
    title: 'checkpoint',
    branch: 'feature/checkpoint',
    worktree,
    fence,
  }).id;
  setWorkstreamStatus(root, runId, workstreamId, 'in_progress', { fence });
  const present = `${worktree}/present.txt`;
  const absent = `${worktree}/absent.txt`;
  writeFileSync(join(root, present), 'present checkpoint evidence');
  const episodeId = newEpisode(root, runId, {
    plugin: 'deep-work',
    role: 'maker',
    kind: 'implementation',
    point,
    workstream: workstreamId,
    expectedArtifacts: expectedArtifacts ?? [present, absent],
    fence,
  }).id;
  recordEpisode(root, runId, episodeId, { status: 'in_progress', fence });
  return {
    root, runId, fence, runtime, worktree, workstreamId, episodeId, present, absent,
  };
}

function durableRunBytes(fixture) {
  const dir = runDir(fixture.root, fixture.runId);
  return {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
    log: readFileSync(join(dir, 'event-log.jsonl')),
    lease: structuredClone(readState(fixture.root, fixture.runId).data.session_chain.lease),
    sessions: readState(fixture.root, fixture.runId).data.session_chain.sessions.length,
  };
}

const hostEvidence = (provider = 'claude-code', id = 'session-a') => ({ provider, id });

test('strict v0.4 emit binds exact affinity context and exact retry is byte- and inode-idempotent', () => {
  const fixture = seedBound();
  const before = durableRunBytes(fixture);
  const state = readState(fixture.root, fixture.runId);
  const expectedNext = nextAction(state.data, { now: NOW_MS + 1000, unattended: false });

  const first = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.match(first.checkpoint_key, /^[0-9a-f]{64}$/);
  assert.equal(first.checkpoint_rel, `checkpoints/${first.checkpoint_key}-compact.json`);
  assert.equal(Object.hasOwn(first, 'path'), false);
  assert.equal(JSON.stringify(first).includes(fixture.root), false);
  const firstPath = strictCheckpointPath(fixture.root, fixture.runId, first);
  const firstBytes = readFileSync(firstPath);
  const firstIdentity = lstatSync(firstPath, { bigint: true });
  const filesBeforeRetry = readdirSync(checkpointDirOf(fixture.root, fixture.runId)).sort();

  const retry = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 2000,
  });
  assert.deepEqual(retry, { ...first, created: false });
  assert.deepEqual(readdirSync(checkpointDirOf(fixture.root, fixture.runId)).sort(), filesBeforeRetry);
  assert.deepEqual(readFileSync(firstPath), firstBytes);
  const retryIdentity = lstatSync(firstPath, { bigint: true });
  assert.equal(retryIdentity.ino, firstIdentity.ino);
  assert.equal(retryIdentity.birthtimeNs, firstIdentity.birthtimeNs);
  assert.deepEqual(durableRunBytes(fixture), before);

  const env = JSON.parse(firstBytes);
  assert.deepEqual(Object.keys(env), ['schema_version', 'envelope', 'payload']);
  assert.equal(env.schema_version, '1.0');
  assert.deepEqual(env.envelope.schema, { name: 'compact-checkpoint', version: '2.0' });
  assert.deepEqual(Object.keys(env.payload), ['checkpoint_key', 'context', 'context_sha256']);
  assert.equal(env.payload.checkpoint_key, first.checkpoint_key);
  const context = env.payload.context;
  assert.deepEqual(Object.keys(context), [
    'run_id',
    'owner_run_id',
    'generation',
    'project_root_digest',
    'project_binding_generation',
    'runtime',
    'loop_hash',
    'scope',
    'workstream',
    'current_episode',
    'artifacts',
    'next_action',
    'provider_evidence',
  ]);
  assert.equal(context.run_id, fixture.runId);
  assert.equal(context.owner_run_id, fixture.runId);
  assert.equal(context.generation, 1);
  assert.equal(context.project_root_digest, projectRootDigest(state.data.project.root));
  assert.equal(context.project_binding_generation, state.data.project.binding_generation);
  assert.equal(context.runtime, 'claude');
  assert.equal(context.loop_hash, state.hash);
  const ownerSession = state.data.session_chain.sessions.find(item => item.run_id === fixture.runId);
  assert.deepEqual(context.scope, ownerSession.scope);
  assert.deepEqual(
    context.workstream,
    state.data.workstreams.find(item => item.id === fixture.workstreamId),
  );
  assert.deepEqual(
    context.current_episode,
    state.data.episodes.find(item => item.id === fixture.episodeId),
  );
  assert.deepEqual(context.artifacts, [
    { rel: fixture.absent, state: 'absent', sha256: null, size: null },
    {
      rel: fixture.present,
      state: 'present',
      sha256: contentHash(readFileSync(join(fixture.root, fixture.present))),
      size: readFileSync(join(fixture.root, fixture.present)).length,
    },
  ]);
  assert.deepEqual(context.next_action, expectedNext);
  assert.deepEqual(context.provider_evidence, {
    provider: 'claude-code',
    identity_sha256: contentHash('session-a'),
  });
  assert.equal(env.payload.context_sha256, contentHash(JSON.stringify(context)));
  assert.equal(
    first.checkpoint_key,
    contentHash(JSON.stringify(['deep-loop-compact-checkpoint-v2', context])),
  );
});

test('strict inspect orders two equal-time checkpoints by checkpoint_rel without mutating the frozen capture', () => {
  const fixture = seedBound();
  const first = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'tie-a'),
    now: NOW_MS + 1000,
  });
  const second = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'tie-b'),
    now: NOW_MS + 1000,
  });

  const inspected = inspectCompactCheckpoint(fixture.root, fixture.runId, {
    now: NOW_MS + 1000,
  });
  assert.equal(
    inspected.checkpoint_rel,
    [first.checkpoint_rel, second.checkpoint_rel].sort()[0],
  );
});

test('strict retention validates chronology, keeps the newest five, and removes malformed pressure first', () => {
  const fixture = seedBound();
  const dir = checkpointDirOf(fixture.root, fixture.runId);
  mkdirSync(dir, { recursive: true });
  const malformed = join(dir, `${'f'.repeat(64)}-compact.json`);
  writeFileSync(malformed, '{}');
  const emitted = [];
  for (let index = 0; index < 6; index += 1) {
    emitted.push(emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', `chronology-${index}`),
      now: NOW_MS + 1000 + index,
    }));
  }

  assert.equal(existsSync(malformed), false);
  assert.equal(
    existsSync(strictCheckpointPath(fixture.root, fixture.runId, emitted[0])),
    false,
  );
  for (const retained of emitted.slice(1)) {
    assert.equal(existsSync(strictCheckpointPath(fixture.root, fixture.runId, retained)), true);
  }
  assert.equal(readdirSync(dir).filter(name => name.endsWith('-compact.json')).length, 5);
  assert.equal(
    inspectCompactCheckpoint(fixture.root, fixture.runId, { now: NOW_MS + 2000 }).checkpoint_rel,
    emitted.at(-1).checkpoint_rel,
  );
});

test('strict affinity permits a bound current episode with an empty expected_artifacts set', () => {
  const fixture = seedBound('claude', { expectedArtifacts: [] });
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const env = JSON.parse(readFileSync(
    strictCheckpointPath(fixture.root, fixture.runId, emitted),
    'utf8',
  ));
  assert.deepEqual(env.payload.context.artifacts, []);
});

test('strict emit rejects missing fences, runtime drift, and every non-bound affinity without artifacts', () => {
  const fixture = seedBound();
  assert.throws(
    () => emitCompactCheckpoint(fixture.root, fixture.runId, {
      runtime: 'claude', now: NOW_MS + 1000,
    }),
    /FENCE_REQUIRED/,
  );
  assert.throws(
    () => emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: { owner: fixture.runId, generation: 9 },
      runtime: 'claude',
      now: NOW_MS + 1000,
    }),
    /LEASE_FENCED/,
  );
  assert.throws(
    () => emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: 'codex',
      now: NOW_MS + 1000,
    }),
    /RUNTIME_FENCED/,
  );
  assert.throws(
    () => emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: 'claude',
      hostSessionEvidence: { provider: 'claude-code', id: '' },
      now: NOW_MS + 1000,
    }),
    /CHECKPOINT_EVIDENCE_INVALID/,
  );

  const unboundRoot = freshRoot();
  const { runId: unboundRunId } = initCurrent(unboundRoot);
  assert.throws(
    () => emitCompactCheckpoint(unboundRoot, unboundRunId, {
      fence: { owner: unboundRunId, generation: 1 },
      runtime: 'claude',
      now: NOW_MS + 1000,
    }),
    /CHECKPOINT_AFFINITY_INVALID/,
  );
  assert.equal(existsSync(checkpointDirOf(unboundRoot, unboundRunId)), false);
});

test('strict inspect derives current selectors and restore returns one bounded read-only descriptor', () => {
  const fixture = seedBound();
  const before = durableRunBytes(fixture);
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  const fileSet = readdirSync(checkpointDirOf(fixture.root, fixture.runId)).sort();

  const inspected = inspectCompactCheckpoint(fixture.root, fixture.runId, {
    now: NOW_MS + 1000,
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.checkpoint_rel, emitted.checkpoint_rel);
  assert.deepEqual(inspected.provider_evidence, { present: true, matched: null });

  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  assert.deepEqual(Object.keys(restored), [
    'ok',
    'checkpoint_rel',
    'checkpoint_key',
    'owner_run_id',
    'generation',
    'runtime',
    'scope',
    'workstream',
    'current_episode',
    'next_action',
    'context_sha256',
    'provider_evidence',
  ]);
  assert.equal(restored.ok, true);
  assert.equal(restored.checkpoint_rel, emitted.checkpoint_rel);
  assert.equal(restored.owner_run_id, fixture.runId);
  assert.equal(restored.generation, 1);
  assert.equal(restored.runtime, 'claude');
  assert.equal(restored.scope.workstream_id, fixture.workstreamId);
  assert.equal(restored.workstream.id, fixture.workstreamId);
  assert.equal(restored.current_episode.id, fixture.episodeId);
  assert.equal(restored.next_action.action.workstream_id, fixture.workstreamId);
  assert.deepEqual(restored.provider_evidence, { present: true, matched: true });
  const descriptorBytes = Buffer.from(JSON.stringify(restored));
  assert.ok(descriptorBytes.length <= 3072);
  assert.equal(descriptorBytes.toString('utf8').includes('\uFFFD'), false);
  assert.equal(descriptorBytes.toString('utf8').includes(fixture.root), false);
  assert.deepEqual(durableRunBytes(fixture), before);
  assert.deepEqual(readdirSync(checkpointDirOf(fixture.root, fixture.runId)).sort(), fileSet);

  const later = NOW_MS + 86_400_001;
  const restoredLater = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: later,
  });
  assert.deepEqual(
    restoredLater.next_action,
    nextAction(readState(fixture.root, fixture.runId).data, { now: later, unattended: false }),
    'restore derives a fresh action without making the captured checkpoint stale on clock drift alone',
  );
});

test('restore always bounds and sanitizes schema-valid hostile strings without leaking absolute paths', () => {
  const hostilePoint = `/Users/reviewer/private/${'x'.repeat(4000)}`;
  const fixture = seedBound('claude', {
    expectedArtifacts: [],
    point: hostilePoint,
  });
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const json = JSON.stringify(restored);
  assert.ok(Buffer.byteLength(json) <= 3072);
  assert.equal(json.includes('/Users/reviewer/private/'), false);
  assert.equal(json.includes(fixture.root), false);
  assert.equal(restored.owner_run_id, fixture.runId);
  assert.equal(restored.generation, 1);
  assert.equal(restored.runtime, 'claude');
  assert.equal(restored.scope.workstream_id, fixture.workstreamId);
  assert.equal(restored.next_action.action.type, 'await_human');
  assert.deepEqual(restored.current_episode.point, {
    sha256: contentHash(hostilePoint),
    utf8_bytes: Buffer.byteLength(hostilePoint),
  });
});

test('restore hash-summarizes absolute path tokens after any punctuation and preserves exact slash commands', () => {
  const hostilePoints = [
    'hostile,[/tmp/strict-secret]',
    'hostile,{/var/tmp/strict-secret}',
    'hostile,(/opt/strict-secret)',
    'hostile,!/srv/strict-secret',
    'hostile,[C:\\strict-secret\\file.txt]',
    'hostile,{D:/strict-secret/file.txt}',
    'hostile,(\\\\server\\share\\strict-secret)',
    'hostile,[/deep-loop-status]',
  ];
  for (const point of hostilePoints) {
    const fixture = seedBound('claude', { expectedArtifacts: [], point });
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    const json = JSON.stringify(restored);
    assert.deepEqual(restored.current_episode.point, {
      sha256: contentHash(point),
      utf8_bytes: Buffer.byteLength(point),
    }, point);
    assert.equal(json.includes(point), false, point);
    assert.equal(json.includes(fixture.root), false, point);
  }

  const commandFixture = seedBound('claude', { point: '/deep-loop-status' });
  const commandCheckpoint = emitCompactCheckpoint(commandFixture.root, commandFixture.runId, {
    fence: commandFixture.fence,
    runtime: commandFixture.runtime,
    now: NOW_MS + 1000,
  });
  const commandRestore = restoreCompactCheckpoint(commandFixture.root, commandFixture.runId, {
    checkpointRel: commandCheckpoint.checkpoint_rel,
    fence: commandFixture.fence,
    runtime: commandFixture.runtime,
    now: NOW_MS + 1000,
  });
  assert.equal(commandRestore.current_episode.point, '/deep-loop-status');
  assert.equal(commandRestore.next_action.next_command, '/deep-loop-continue');
});

test('strict validator rejects tamper, stale context, foreign run, evidence mismatch, and conflicting retry bytes', () => {
  const variants = [
    ['malformed', (fixture, emitted) => writeFileSync(strictCheckpointPath(fixture.root, fixture.runId, emitted), '{')],
    ['foreign-run', (_fixture, emitted, env) => {
      env.envelope.run_id = 'foreign-run';
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['owner', (_fixture, emitted, env) => {
      env.payload.context.owner_run_id = 'foreign-owner';
      env.payload.context_sha256 = contentHash(JSON.stringify(env.payload.context));
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['generation', (_fixture, emitted, env) => {
      env.payload.context.generation += 1;
      env.payload.context_sha256 = contentHash(JSON.stringify(env.payload.context));
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['root-digest', (_fixture, emitted, env) => {
      env.payload.context.project_root_digest = 'a'.repeat(64);
      env.payload.context_sha256 = contentHash(JSON.stringify(env.payload.context));
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['root-generation', (_fixture, emitted, env) => {
      env.payload.context.project_binding_generation += 1;
      env.payload.context_sha256 = contentHash(JSON.stringify(env.payload.context));
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['runtime', (_fixture, emitted, env) => {
      env.payload.context.runtime = 'codex';
      env.payload.context_sha256 = contentHash(JSON.stringify(env.payload.context));
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['loop-hash', (_fixture, emitted, env) => {
      env.payload.context.loop_hash = 'b'.repeat(64);
      env.payload.context_sha256 = contentHash(JSON.stringify(env.payload.context));
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['scope', (_fixture, emitted, env) => {
      env.payload.context.scope.workstream_id = 'foreign-workstream';
      env.payload.context_sha256 = contentHash(JSON.stringify(env.payload.context));
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['context-digest', (_fixture, emitted, env) => {
      env.payload.context_sha256 = 'c'.repeat(64);
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
    ['extra-key', (_fixture, emitted, env) => {
      env.payload.extra = true;
      writeFileSync(strictCheckpointPath(_fixture.root, _fixture.runId, emitted), JSON.stringify(env));
    }],
  ];
  for (const [label, mutate] of variants) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence(),
      now: NOW_MS + 1000,
    });
    const env = JSON.parse(readFileSync(strictCheckpointPath(fixture.root, fixture.runId, emitted), 'utf8'));
    mutate(fixture, emitted, env);
    assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    }), /CHECKPOINT_/, label);
  }

  const evidenceFixture = seedBound();
  const evidenceCheckpoint = emitCompactCheckpoint(evidenceFixture.root, evidenceFixture.runId, {
    fence: evidenceFixture.fence,
    runtime: evidenceFixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  assert.throws(() => restoreCompactCheckpoint(evidenceFixture.root, evidenceFixture.runId, {
    checkpointRel: evidenceCheckpoint.checkpoint_rel,
    fence: evidenceFixture.fence,
    runtime: evidenceFixture.runtime,
    hostSessionEvidence: hostEvidence('codex', 'session-a'),
    now: NOW_MS + 1000,
  }), /CHECKPOINT_EVIDENCE_MISMATCH/);
  assert.throws(() => restoreCompactCheckpoint(evidenceFixture.root, evidenceFixture.runId, {
    checkpointRel: evidenceCheckpoint.checkpoint_rel,
    fence: evidenceFixture.fence,
    runtime: evidenceFixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'session-b'),
    now: NOW_MS + 1000,
  }), /CHECKPOINT_EVIDENCE_MISMATCH/);

  const conflictFixture = seedBound();
  const conflict = emitCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    now: NOW_MS + 1000,
  });
  const conflictPath = strictCheckpointPath(conflictFixture.root, conflictFixture.runId, conflict);
  writeFileSync(conflictPath, '{}');
  assert.throws(() => emitCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    now: NOW_MS + 2000,
  }), /CHECKPOINT_CONFLICT/);
  assert.equal(readFileSync(conflictPath, 'utf8'), '{}');
});

test('strict restore rejects every unsafe rel spelling and symlink without mutation', t => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const before = durableRunBytes(fixture);
  for (const rel of [
    '/absolute.json',
    'C:/absolute.json',
    '\\\\server\\share\\checkpoint.json',
    '..\\outside.json',
    '../outside.json',
    './checkpoints/x.json',
    `checkpoints/${emitted.checkpoint_key}/nested-compact.json`,
    `checkpoints/${emitted.checkpoint_key}-compact.json\0suffix`,
  ]) {
    assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    }), /CHECKPOINT_REL_INVALID/, rel);
  }

  const target = join(fixture.root, 'checkpoint-target.json');
  const emittedPath = strictCheckpointPath(fixture.root, fixture.runId, emitted);
  writeFileSync(target, readFileSync(emittedPath));
  rmSync(emittedPath);
  if (!createFileSymlinkOrSkip(t, target, emittedPath)) return;
  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  }), /CHECKPOINT_PATH_INVALID/);
  assert.deepEqual(durableRunBytes(fixture), before);
});

test('strict artifact observations stale on content change and invalid entries cannot evict current checkpoint', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  writeFileSync(join(fixture.root, fixture.present), 'changed');
  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  }), /CHECKPOINT_CONTEXT_MISMATCH/);

  const pressure = seedBound();
  const dir = checkpointDirOf(pressure.root, pressure.runId);
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    writeFileSync(join(dir, `${String(index).padStart(64, '0')}-compact.json`), '{}');
  }
  const current = emitCompactCheckpoint(pressure.root, pressure.runId, {
    fence: pressure.fence,
    runtime: pressure.runtime,
    now: NOW_MS + 1000,
  });
  assert.equal(existsSync(strictCheckpointPath(pressure.root, pressure.runId, current)), true);
  assert.equal(readdirSync(dir).filter(name => name.endsWith('-compact.json')).length, 5);
});
