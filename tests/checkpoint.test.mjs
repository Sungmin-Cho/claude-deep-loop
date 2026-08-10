import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  appendFileSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  __testEmitCompactCheckpoint,
  __testObserveCompactCheckpoint,
  __testRestoreCompactCheckpoint,
  captureCheckpointSet,
  captureVerifiedCheckpointSet,
  emitCompactCheckpoint,
  emitLegacyCompactCheckpointFromTrustedHook,
  inspectCompactForSessionStart,
  inspectCompactCheckpoint,
  observeCompactCheckpoint,
  restoreCompactCheckpoint,
  selectVerifiedCheckpointDescriptor,
  selectCheckpoint as selectCheckpointFromSet,
} from '../scripts/lib/checkpoint.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import {
  readState,
  runDir,
  withLock,
  withReconciledMutationLock,
  writeState,
} from '../scripts/lib/state.mjs';
import { contentHash, ulid, wrap } from '../scripts/lib/envelope.mjs';
import {
  appendAnchored,
  captureVerifiedRunSnapshot,
  reconcileCompactPruneTombstonesLocked,
} from '../scripts/lib/integrity.mjs';
import { projectRootDigest } from '../scripts/lib/project-root.mjs';
import {
  acquireRootRecovery,
  recoverRelocatedRoot,
} from '../scripts/lib/project-root-recovery.mjs';
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

function durableInventory(fixture) {
  const base = runDir(fixture.root, fixture.runId);
  const inventory = {};
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.lock') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, rel);
      else inventory[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(base);
  return inventory;
}

const hostEvidence = (provider = 'claude-code', id = 'session-a') => ({ provider, id });
const manualAdmission = Object.freeze({
  admission: 'human-attested',
  source: 'direct-human-skill',
  confirmManualCompact: true,
  env: {},
});

function compactCursorFromIntent(payload) {
  return {
    checkpoint_key: payload.checkpoint_key,
    context_sha256: payload.context_sha256,
    pre_restore_loop_hash: payload.pre_restore_loop_hash,
    owner_run_id: payload.owner_run_id,
    generation: payload.generation,
    runtime: payload.runtime,
    workstream_id: payload.workstream_id,
    episode_id: payload.episode_id,
    baseline_turns: payload.baseline_turns,
    restored_at: payload.timestamp,
    cycle: payload.cycle,
    restore_event: {
      seq: payload.planned_event.seq,
      checksum: payload.planned_event.checksum,
    },
    admission: structuredClone(payload.admission),
    provider_evidence: structuredClone(payload.provider_evidence),
  };
}

function compactCandidateBytes(predecessorBytes, runId, payload) {
  const candidate = JSON.parse(predecessorBytes.toString('utf8'));
  const owner = candidate.session_chain.sessions.find(session => session.run_id === runId);
  owner.compact_cursor = compactCursorFromIntent(payload);
  candidate.event_log_head = structuredClone(owner.compact_cursor.restore_event);
  candidate.updated_at = payload.timestamp;
  return Buffer.from(JSON.stringify(candidate, null, 2));
}

function seedHashFirstCompactPartial(fixture, emitted, admission = manualAdmission) {
  assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...admission,
    now: NOW_MS + 2000,
    faultAt: 'event:appended',
  }), /TEST_FAULT:event:appended/);
  const intentDir = join(runDir(fixture.root, fixture.runId), 'compact-restore-intents');
  const intent = JSON.parse(readFileSync(join(intentDir, readdirSync(intentDir)[0]), 'utf8'));
  const predecessorBytes = readFileSync(loopPathOf(fixture.root, fixture.runId));
  assert.equal(contentHash(predecessorBytes), intent.payload.pre_loop_hash);
  const candidateBytes = compactCandidateBytes(predecessorBytes, fixture.runId, intent.payload);
  writeFileSync(hashPathOf(fixture.root, fixture.runId), contentHash(candidateBytes));
  return { intent, predecessorBytes, candidateBytes };
}

function prepareGenericPublication(fixture, operationId) {
  assert.throws(() => appendAnchored(
    fixture.root,
    fixture.runId,
    {
      type: 'checkpoint-generic-publication-test',
      data: { operation_id: operationId },
      now: new Date(NOW_MS + 1500).toISOString(),
    },
    loop => { loop.discovered_items.push(operationId); },
    undefined,
    {
      publication: {
        kind: 'workstream-boundary',
        operationId,
        artifacts: [{
          rel: `artifacts/${operationId}.txt`,
          bytes: Buffer.from(`artifact:${operationId}`),
        }],
        topology: { operation_id: operationId, phase: 'prepared' },
        faultAt(label) {
          if (label === 'prepared:digest-verified') throw new Error('prepared publication');
        },
      },
    },
  ), /TRANSACTION_PENDING/);
}

function seedGenericPublicationPartial(fixture, operationId, seam) {
  assert.throws(() => appendAnchored(
    fixture.root,
    fixture.runId,
    {
      type: 'checkpoint-partial-recovery-test',
      data: { operation_id: operationId },
      now: new Date(NOW_MS + 1500).toISOString(),
    },
    loop => { loop.discovered_items.push(operationId); },
    undefined,
    {
      publication: {
        kind: 'workstream-boundary',
        operationId,
        artifacts: [{
          rel: `artifacts/${operationId}.txt`,
          bytes: Buffer.from(`artifact:${operationId}`),
        }],
        topology: { operation_id: operationId, phase: 'partial' },
        faultAt(label) {
          if (label === seam) throw new Error(`partial:${seam}`);
        },
      },
    },
  ), /TRANSACTION_PENDING/);
  const operationDir = join(runDir(fixture.root, fixture.runId), 'transactions', operationId);
  const prepared = JSON.parse(readFileSync(join(operationDir, 'prepared.json'), 'utf8'));
  const candidateStage = prepared.payload.stages.find(stage => stage.role === 'candidate-loop');
  const candidateBytes = readFileSync(join(
    operationDir,
    'stages',
    `${String(candidateStage.index).padStart(6, '0')}.bin`,
  ));
  return {
    operationId,
    candidate: JSON.parse(candidateBytes.toString('utf8')),
    candidateHash: prepared.payload.manifest.candidateLoopHash,
  };
}

function writeCandidateCheckpoint(fixture, partial, now) {
  const loop = partial.candidate;
  const session = loop.session_chain.sessions.find(item => item.run_id === fixture.runId);
  const workstream = loop.workstreams.find(item => item.id === fixture.workstreamId);
  const episode = loop.episodes.find(item => item.id === fixture.episodeId);
  const artifacts = [...new Set([
    ...(episode.expected_artifacts || []),
    ...(episode.artifacts || []),
  ])].sort().map(rel => {
    const path = join(fixture.root, rel);
    if (!existsSync(path)) return { rel, state: 'absent', sha256: null, size: null };
    const bytes = readFileSync(path);
    return { rel, state: 'present', sha256: contentHash(bytes), size: bytes.length };
  });
  const context = {
    run_id: fixture.runId,
    owner_run_id: fixture.fence.owner,
    generation: fixture.fence.generation,
    project_root_digest: projectRootDigest(loop.project.root),
    project_binding_generation: loop.project.binding_generation,
    runtime: fixture.runtime,
    loop_hash: partial.candidateHash,
    scope: structuredClone(session.scope),
    workstream: structuredClone(workstream),
    current_episode: structuredClone(episode),
    artifacts,
    next_action: nextAction(loop, { now, unattended: false }),
    provider_evidence: null,
  };
  const key = contentHash(JSON.stringify(['deep-loop-compact-checkpoint-v2', context]));
  const env = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-checkpoint',
    schema: { name: 'compact-checkpoint', version: '2.0' },
    run_id: fixture.runId,
    payload: {
      checkpoint_key: key,
      context,
      context_sha256: contentHash(JSON.stringify(context)),
    },
    now: new Date(now).toISOString(),
  });
  mkdirSync(checkpointDirOf(fixture.root, fixture.runId), { recursive: true });
  writeFileSync(join(checkpointDirOf(fixture.root, fixture.runId), `${key}-compact.json`),
    JSON.stringify(env, null, 2));
  return { checkpoint_rel: `checkpoints/${key}-compact.json`, checkpoint_key: key };
}

for (const seam of ['event:0:append', 'state:loop:rename']) {
  for (const verb of ['emit', 'observe']) {
    test(`${verb} reconciles the verified ${seam} publication partial exactly once`, () => {
      const fixture = seedBound();
      const operationId = `${verb}-${seam.replaceAll(':', '-')}-valid`;
      const partial = seedGenericPublicationPartial(fixture, operationId, seam);
      const checkpoint = verb === 'observe'
        ? writeCandidateCheckpoint(fixture, partial, NOW_MS + 2000)
        : null;

      const result = verb === 'emit'
        ? emitCompactCheckpoint(fixture.root, fixture.runId, {
            fence: fixture.fence,
            runtime: fixture.runtime,
            now: NOW_MS + 2500,
          })
        : observeCompactCheckpoint(fixture.root, fixture.runId, {
            checkpointRel: checkpoint.checkpoint_rel,
            trigger: 'manual',
            fence: fixture.fence,
            runtime: fixture.runtime,
            now: NOW_MS + 2500,
          });

      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      const state = readState(fixture.root, fixture.runId).data;
      assert.equal(state.discovered_items.filter(item => item === operationId).length, 1);
      const events = readFileSync(logPathOf(fixture.root, fixture.runId), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.type === 'checkpoint-partial-recovery-test').length, 1);
      assert.equal(readFileSync(join(
        runDir(fixture.root, fixture.runId), 'artifacts', `${operationId}.txt`,
      ), 'utf8'), `artifact:${operationId}`);
      assert.deepEqual(readdirSync(join(runDir(fixture.root, fixture.runId), 'transactions')), []);
      if (verb === 'emit') {
        assert.equal(existsSync(strictCheckpointPath(fixture.root, fixture.runId, result)), true);
      } else {
        assert.equal(existsSync(join(
          checkpointDirOf(fixture.root, fixture.runId),
          `${checkpoint.checkpoint_key}-compact-observation.json`,
        )), true);
      }
    });

    test(`${verb} wrong fence or runtime cannot reconcile the ${seam} publication partial`, () => {
      const fixture = seedBound();
      const operationId = `${verb}-${seam.replaceAll(':', '-')}-wrong`;
      const partial = seedGenericPublicationPartial(fixture, operationId, seam);
      const checkpoint = verb === 'observe'
        ? writeCandidateCheckpoint(fixture, partial, NOW_MS + 2000)
        : null;
      for (const rejected of [
        {
          fence: { owner: 'wrong-owner', generation: fixture.fence.generation },
          runtime: fixture.runtime,
          error: /LEASE_FENCED: owner-mismatch/,
        },
        { fence: fixture.fence, runtime: 'codex', error: /RUNTIME_FENCED: runtime mismatch/ },
      ]) {
        const before = durableInventory(fixture);
        const invoke = () => verb === 'emit'
          ? emitCompactCheckpoint(fixture.root, fixture.runId, {
              fence: rejected.fence,
              runtime: rejected.runtime,
              now: NOW_MS + 2500,
            })
          : observeCompactCheckpoint(fixture.root, fixture.runId, {
              checkpointRel: checkpoint.checkpoint_rel,
              trigger: 'manual',
              fence: rejected.fence,
              runtime: rejected.runtime,
              now: NOW_MS + 2500,
            });
        assert.throws(invoke, rejected.error);
        assert.deepEqual(durableInventory(fixture), before);
      }
    });
  }
}

test('public emit rejects a wrong fence before reconciling a prepared generic publication', () => {
  const fixture = seedBound();
  prepareGenericPublication(fixture, 'emit-wrong-fence-prepared-generic');
  const before = durableInventory(fixture);

  assert.throws(() => emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: { owner: 'wrong-owner', generation: fixture.fence.generation },
    runtime: fixture.runtime,
    now: NOW_MS + 2000,
  }), /LEASE_FENCED: owner-mismatch/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('public observe rejects a wrong fence before generic or tombstone reconciliation', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const tombstone = join(
    checkpointDirOf(fixture.root, fixture.runId),
    `${emitted.checkpoint_key}-compact-prune.json`,
  );
  writeFileSync(tombstone, '{}');
  prepareGenericPublication(fixture, 'observe-wrong-fence-prepared-generic');
  const before = durableInventory(fixture);

  assert.throws(() => observeCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    trigger: 'manual',
    fence: { owner: 'wrong-owner', generation: fixture.fence.generation },
    runtime: fixture.runtime,
    now: NOW_MS + 2000,
  }), /LEASE_FENCED: owner-mismatch/);
  assert.deepEqual(durableInventory(fixture), before);
});

function retireGenericPublicationToEmptyParent(fixture, operationId) {
  appendAnchored(
    fixture.root,
    fixture.runId,
    {
      type: 'checkpoint-generic-publication-commit',
      data: { operation_id: operationId },
      now: new Date(NOW_MS + 1500).toISOString(),
    },
    loop => { loop.discovered_items.push(operationId); },
    undefined,
    {
      publication: {
        kind: 'workstream-boundary',
        operationId,
        artifacts: [{
          rel: `artifacts/${operationId}.txt`,
          bytes: Buffer.from(`artifact:${operationId}`),
        }],
        topology: { operation_id: operationId, phase: 'committed' },
      },
    },
  );
  appendAnchored(
    fixture.root,
    fixture.runId,
    {
      type: 'checkpoint-generic-publication-retire',
      data: { operation_id: operationId },
      now: new Date(NOW_MS + 1600).toISOString(),
    },
    loop => { loop.discovered_items.push(`retired:${operationId}`); },
  );
  const transactions = join(runDir(fixture.root, fixture.runId), 'transactions');
  assert.equal(existsSync(transactions), true);
  assert.deepEqual(readdirSync(transactions), []);
}
const emptyInspectExpectation = reason => ({
  ok: false,
  phase: 'none',
  reason,
  checkpoint_rel: null,
  checkpoint_key: null,
  context_sha256: null,
  pre_restore_loop_hash: null,
  owner_run_id: null,
  generation: null,
  runtime: null,
  workstream_id: null,
  episode_id: null,
  trigger: null,
  cycle: null,
  admission: null,
  restore_event: null,
  next_command: null,
  requires_model_turn: false,
  replay: 'not-applicable',
  provider_evidence: reason === 'trusted-evidence-rejected'
    ? { recorded: true, supplied: true, matched: false }
    : { recorded: false, supplied: false, matched: false },
});

function seedCompactObservation(fixture, emitted, {
  trigger = 'auto',
  providerEvidence = { recorded: false, supplied: false, matched: false },
} = {}) {
  const checkpoint = JSON.parse(readFileSync(
    strictCheckpointPath(fixture.root, fixture.runId, emitted),
    'utf8',
  ));
  const context = checkpoint.payload.context;
  const receipt = wrap({
    producer: 'deep-loop',
    artifact_kind: 'compact-observation',
    schema: { name: 'compact-observation', version: '1.0' },
    run_id: fixture.runId,
    provenance: { source_artifacts: [emitted.checkpoint_rel], tool_versions: {} },
    payload: {
      checkpoint_key: emitted.checkpoint_key,
      context_sha256: checkpoint.payload.context_sha256,
      owner_run_id: fixture.runId,
      generation: fixture.fence.generation,
      runtime: fixture.runtime,
      workstream_id: context.workstream.id,
      episode_id: context.current_episode.id,
      trigger,
      provider_evidence: providerEvidence,
    },
    now: new Date(NOW_MS + 1000).toISOString(),
  });
  const path = join(
    checkpointDirOf(fixture.root, fixture.runId),
    `${emitted.checkpoint_key}-compact-observation.json`,
  );
  writeFileSync(path, JSON.stringify(receipt, null, 2));
  return path;
}

function publicManualRestore(fixture, emitted, now) {
  const env = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const result = spawnSync(process.execPath, [
    join(process.cwd(), 'scripts', 'deep-loop.mjs'),
    'checkpoint', 'restore',
    '--checkpoint', emitted.checkpoint_rel,
    '--owner', fixture.fence.owner,
    '--generation', String(fixture.fence.generation),
    '--runtime', fixture.runtime,
    '--admission', 'human-attested',
    '--source', 'direct-human-skill',
    '--confirm-manual-compact',
    '--json',
    '--now', String(now),
    '--project-root', fixture.root,
    '--run-id', fixture.runId,
  ], { encoding: 'utf8', env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

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

test('verified checkpoint capture never calls reconcile', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  let captureCalls = 0;
  const captured = captureVerifiedCheckpointSet({
    root: fixture.root,
    runId: fixture.runId,
    now: NOW_MS + 1000,
    captureVerifiedRunSnapshot() {
      captureCalls += 1;
      return captureVerifiedRunSnapshot(fixture.root, fixture.runId);
    },
    afterRunSnapshotCapture() {
      writeFileSync(strictCheckpointPath(fixture.root, fixture.runId, emitted), 'live checkpoint drift');
    },
    afterArtifactCapture({ rel }) {
      if (rel === fixture.present) writeFileSync(join(fixture.root, fixture.present), 'live artifact drift');
    },
  });
  assert.equal(captured.ok, true);
  assert.equal(captured.checkpoints.length, 1);
  assert.equal(captured.checkpoints[0].path, strictCheckpointPath(fixture.root, fixture.runId, emitted));
  assert.equal(captureCalls, 1, 'no-snapshot form captures the run exactly once');

  assert.throws(() => appendAnchored(
    fixture.root,
    fixture.runId,
    { type: 'checkpoint-prepared-fixture', data: { operation_id: 'checkpoint-prepared' }, now: '2026-07-20T00:02:00.000Z' },
    loop => { loop.discovered_items.push('checkpoint-prepared'); },
    undefined,
    {
      publication: {
        kind: 'checkpoint-fixture',
        operationId: 'checkpoint-prepared',
        artifacts: [],
        topology: { operation_id: 'checkpoint-prepared' },
        faultAt(label) {
          if (label === 'prepared:digest-verified') throw new Error('fixture-stop-after-prepare');
        },
      },
    },
  ), /TRANSACTION_PENDING/);
  const residueBefore = durableRunBytes(fixture);
  const residue = captureVerifiedCheckpointSet(fixture.root, fixture.runId);
  assert.deepEqual(residue, {
    ok: false,
    kind: 'reconciliation-required',
    operation_id: 'checkpoint-prepared',
    phase: 'prepared',
  });
  assert.deepEqual(durableRunBytes(fixture), residueBefore);
});

test('verified checkpoint capture accepts legacy ULID bytes from the immutable vector', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  const emitted = emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS });
  const expected = readFileSync(emitted.path);
  const captured = captureVerifiedCheckpointSet({
    root,
    runId,
    now: NOW_MS,
    afterRunSnapshotCapture() {
      writeFileSync(emitted.path, 'live replacement must not affect frozen bytes');
    },
  });
  assert.equal(captured.ok, true);
  assert.equal(captured.checkpoints.length, 1);
  assert.deepEqual(captured.checkpoints[0].bytes, expected);
});

test('verified legacy capture binds every restore-bearing payload field to the immutable snapshot', () => {
  const root = freshRoot();
  const { runId } = initClaude(root);
  emitLegacyCompactCheckpointFromTrustedHook(root, runId, { now: NOW_MS });
  const capturedSnapshot = captureVerifiedRunSnapshot(root, runId);
  assert.equal(capturedSnapshot.ok, true);
  const snapshot = capturedSnapshot.snapshot;
  const checkpointIndex = snapshot.vector.findIndex(entry => (
    entry[0] === runId && entry[1].startsWith('checkpoints/') && entry[2] === 'file'
  ));
  assert.notEqual(checkpointIndex, -1);

  for (const [field, forge] of [
    ['current_episode_detail', value => ({ ...value, status: 'forged' })],
    ['active_workstreams', value => [...value, 'forged-workstream']],
    ['next_action_hint', value => ({ ...value, type: 'forged-action' })],
  ]) {
    const envelope = JSON.parse(Buffer.from(snapshot.vector[checkpointIndex][3].base64, 'base64'));
    envelope.payload[field] = forge(envelope.payload[field]);
    const bytes = Buffer.from(JSON.stringify(envelope, null, 2));
    const vector = snapshot.vector.map(entry => [...entry]);
    vector[checkpointIndex][3] = {
      base64: bytes.toString('base64'),
      sha256: contentHash(bytes),
      size: bytes.length,
    };
    const forged = { ...snapshot, vector };
    assert.deepEqual(captureVerifiedCheckpointSet({ root, runId, snapshot: forged }), {
      ok: false,
      kind: 'integrity-invalid',
      phase: 'checkpoint',
    }, field);
  }

  const futureMs = NOW_MS + 86_400_000;
  const futureEnvelope = JSON.parse(Buffer.from(snapshot.vector[checkpointIndex][3].base64, 'base64'));
  futureEnvelope.envelope.generated_at = new Date(futureMs).toISOString();
  const futureNext = nextAction(snapshot.data, { now: futureMs, unattended: false });
  futureEnvelope.payload.next_action_hint = {
    type: futureNext.action.type,
    next_command: futureNext.next_command,
  };
  const futureBytes = Buffer.from(JSON.stringify(futureEnvelope, null, 2));
  const futureVector = snapshot.vector.map(entry => [...entry]);
  futureVector[checkpointIndex][3] = {
    base64: futureBytes.toString('base64'),
    sha256: contentHash(futureBytes),
    size: futureBytes.length,
  };
  assert.deepEqual(captureVerifiedCheckpointSet({
    root, runId, snapshot: { ...snapshot, vector: futureVector },
  }), {
    ok: false,
    kind: 'integrity-invalid',
    phase: 'checkpoint',
  });
});

test('verified checkpoint capture rejects a same-run-id snapshot from another root before observing artifacts', () => {
  const source = seedBound();
  const emitted = emitCompactCheckpoint(source.root, source.runId, {
    fence: source.fence,
    runtime: source.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  const snapshot = captureVerifiedRunSnapshot(source.root, source.runId);
  assert.equal(snapshot.ok, true);

  const candidateRoot = freshRoot();
  cpSync(runDir(source.root, source.runId), runDir(candidateRoot, source.runId), {
    recursive: true,
    preserveTimestamps: true,
  });
  cpSync(join(source.root, source.worktree), join(candidateRoot, source.worktree), {
    recursive: true,
    preserveTimestamps: true,
  });

  let candidateObservations = 0;
  assert.deepEqual(captureVerifiedCheckpointSet({
    root: candidateRoot,
    runId: source.runId,
    snapshot,
    now: NOW_MS + 1000,
    observeArtifactFn() {
      candidateObservations += 1;
      throw new Error('cross-root artifact observation must not run');
    },
  }), {
    ok: false,
    kind: 'integrity-invalid',
    phase: 'run-snapshot',
  });
  assert.equal(candidateObservations, 0);

  const sourceResult = captureVerifiedCheckpointSet({
    root: source.root,
    runId: source.runId,
    snapshot,
    now: NOW_MS + 1000,
  });
  assert.equal(sourceResult.ok, true);
  assert.equal(sourceResult.checkpoints.length, 1);
  assert.equal(sourceResult.checkpoints[0].path, strictCheckpointPath(source.root, source.runId, emitted));
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

test('pure verified checkpoint projection selects newest generated_at and retains the full bounded descriptor', () => {
  const fixture = seedBound();
  emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const newest = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 2000,
  });
  const captured = captureVerifiedCheckpointSet({ root: fixture.root, runId: fixture.runId, now: NOW_MS + 2000 });
  const descriptor = selectVerifiedCheckpointDescriptor(captured);
  assert.equal(descriptor.ok, true);
  assert.equal(descriptor.checkpoint_rel, newest.checkpoint_rel);
  assert.equal(descriptor.owner_run_id, fixture.runId);
  assert.equal(typeof descriptor.generation, 'number');
  assert.ok(descriptor.scope && descriptor.workstream && descriptor.current_episode && descriptor.next_action);
  assert.ok(descriptor.provider_evidence);
  const providerPresent = descriptor.provider_evidence.present;
  assert.equal(Object.hasOwn(captured.checkpoints[0], 'validation'), false);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.provider_evidence), true);
  try { descriptor.provider_evidence.present = false; } catch { /* strict frozen projection */ }
  assert.equal(selectVerifiedCheckpointDescriptor(captured).provider_evidence.present, providerPresent);
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

test('public and SessionStart inspectors preserve a prepared generic publication byte-for-byte', () => {
  for (const [label, inspect] of [
    ['public', (fixture, now) => inspectCompactCheckpoint(fixture.root, fixture.runId, { now })],
    ['sessionstart', (fixture, now) => inspectCompactForSessionStart(
      fixture.root,
      fixture.runId,
      { now },
    )],
  ]) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    prepareGenericPublication(fixture, `inspect-${label}`);
    const before = durableInventory(fixture);

    const descriptor = inspect(fixture, NOW_MS + 2000);

    assert.equal(descriptor.ok, true, label);
    assert.equal(descriptor.checkpoint_rel, emitted.checkpoint_rel, label);
    assert.deepEqual(durableInventory(fixture), before, label);
  }
});

test('invalid restore fence cannot reconcile or retire an unrelated prepared publication', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  prepareGenericPublication(fixture, 'restore-wrong-fence');
  const before = durableInventory(fixture);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: { owner: 'different-owner', generation: fixture.fence.generation },
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
  }), /LEASE_FENCED: owner-mismatch/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('valid restore commits after a generic publication retires to an empty transactions parent', () => {
  const fixture = seedBound();
  retireGenericPublicationToEmptyParent(fixture, 'empty-parent-valid-restore');
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 2000,
  });

  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 3000,
  });

  assert.equal(restored.disposition, 'committed');
  assert.equal(restored.checkpoint_key, emitted.checkpoint_key);
  const transactions = join(runDir(fixture.root, fixture.runId), 'transactions');
  assert.equal(existsSync(transactions), true);
  assert.deepEqual(readdirSync(transactions), []);
});

test('valid restore with a prepared generic publication fails closed byte-identically', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  prepareGenericPublication(fixture, 'valid-restore-prepared-generic');
  const before = durableInventory(fixture);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
  }), /TRANSACTION_RECONCILIATION_REQUIRED/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('paused restore reports the fresh fence result before paused status', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const state = readState(fixture.root, fixture.runId).data;
  state.status = 'paused';
  writeState(fixture.root, fixture.runId, state);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: { owner: 'different-owner', generation: fixture.fence.generation },
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
  }), /LEASE_FENCED: owner-mismatch/);
  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
  }), /LEASE_FENCED: RUN_PAUSED/);
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

test('compact restore commits one fixed event and cursor then exact-replays byte-identically', () => {
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
  assert.deepEqual(inspected.provider_evidence, {
    recorded: true, supplied: false, matched: false,
  });

  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 1000,
  });
  assert.deepEqual(Object.keys(restored), [
    'ok',
    'disposition',
    'phase',
    'checkpoint_rel',
    'checkpoint_key',
    'owner_run_id',
    'generation',
    'runtime',
    'workstream_id',
    'episode_id',
    'baseline_turns',
    'cycle',
    'restore_event',
    'admission',
    'provider_evidence',
    'next_command',
    'requires_model_turn',
    'replay',
  ]);
  assert.equal(restored.ok, true);
  assert.equal(restored.disposition, 'committed');
  assert.equal(restored.phase, 'restored');
  assert.equal(restored.checkpoint_rel, emitted.checkpoint_rel);
  assert.equal(restored.owner_run_id, fixture.runId);
  assert.equal(restored.generation, 1);
  assert.equal(restored.runtime, 'claude');
  assert.equal(restored.workstream_id, fixture.workstreamId);
  assert.equal(restored.episode_id, fixture.episodeId);
  assert.equal(restored.baseline_turns, 4);
  assert.equal(restored.cycle, 1);
  assert.deepEqual(restored.admission, {
    kind: 'human-attested', source: 'direct-human-skill', receipt_trigger: null,
  });
  assert.deepEqual(restored.provider_evidence, {
    recorded: true, supplied: false, matched: false,
  });
  assert.equal(restored.next_command, null);
  assert.equal(restored.requires_model_turn, false);
  assert.equal(restored.replay, 'not-applicable');

  const committed = durableRunBytes(fixture);
  assert.notDeepEqual(committed, before);
  const state = readState(fixture.root, fixture.runId).data;
  const owner = state.session_chain.sessions.find(session => session.run_id === fixture.runId);
  const events = readFileSync(logPathOf(fixture.root, fixture.runId), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const event = events.at(-1);
  assert.equal(event.type, 'compact-restored');
  assert.deepEqual(Object.keys(event.data), [
    'operation_id', 'checkpoint_key', 'context_sha256', 'pre_restore_loop_hash',
    'owner_run_id', 'generation', 'runtime', 'workstream_id', 'episode_id',
    'baseline_turns', 'cycle', 'admission', 'provider_evidence',
  ]);
  assert.equal(event.ts, new Date(NOW_MS + 1000).toISOString());
  assert.equal(state.updated_at, event.ts);
  assert.equal(owner.compact_cursor.restored_at, event.ts);
  assert.deepEqual(owner.compact_cursor.restore_event, {
    seq: event.seq, checksum: event.checksum,
  });
  const exactDelta = structuredClone(state);
  const exactDeltaOwner = exactDelta.session_chain.sessions
    .find(session => session.run_id === fixture.runId);
  delete exactDeltaOwner.compact_cursor;
  exactDelta.event_log_head = JSON.parse(before.loop).event_log_head;
  exactDelta.updated_at = JSON.parse(before.loop).updated_at;
  assert.deepEqual(exactDelta, JSON.parse(before.loop));
  assert.equal(committed.hash.toString('utf8'), contentHash(committed.loop));
  assert.equal(readdirSync(join(runDir(fixture.root, fixture.runId), 'compact-restore-intents')).length, 0);
  assert.deepEqual(readdirSync(checkpointDirOf(fixture.root, fixture.runId)).sort(), fileSet);

  const later = NOW_MS + 86_400_001;
  const committedInventory = durableInventory(fixture);
  const restoredLater = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: later,
  });
  assert.equal(restoredLater.disposition, 'replayed');
  assert.equal(restoredLater.replay, 'exact');
  assert.deepEqual({ ...restoredLater, disposition: 'committed', replay: 'not-applicable' }, restored);
  assert.deepEqual(durableRunBytes(fixture), committed);
  assert.deepEqual(durableInventory(fixture), committedInventory);
});

test('committed compact replay fails closed byte-identically on a prepared generic publication', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const committed = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
  });
  assert.equal(committed.disposition, 'committed');
  prepareGenericPublication(fixture, 'committed-replay-prepared-generic');
  const before = durableInventory(fixture);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 3000,
  }), /TRANSACTION_RECONCILIATION_REQUIRED/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('compact restore reconciles every isolated journal fault through one ordinary retry', () => {
  for (const faultAt of [
    'restore:intent-written',
    'event:appended',
    'state:written',
    'restore:intent-cleanup',
  ]) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...manualAdmission,
      now: NOW_MS + 2000,
      faultAt,
    }), new RegExp(`TEST_FAULT:${faultAt}`), faultAt);

    const restored = publicManualRestore(fixture, emitted, NOW_MS + 86_400_000);
    assert.equal(restored.phase, 'restored', faultAt);
    const events = readFileSync(logPathOf(fixture.root, fixture.runId), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.type === 'compact-restored').length, 1, faultAt);
    const state = readState(fixture.root, fixture.runId).data;
    assert.deepEqual(state.event_log_head, restored.restore_event, faultAt);
    assert.equal(
      readdirSync(join(runDir(fixture.root, fixture.runId), 'compact-restore-intents')).length,
      0,
      faultAt,
    );
  }
});

test('generic mutations cannot cross a retained compact restore intent', () => {
  for (const faultAt of ['restore:intent-written', 'event:appended', 'state:written']) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...manualAdmission,
      now: NOW_MS + 2000,
      faultAt,
    }), new RegExp(`TEST_FAULT:${faultAt}`), faultAt);
    const before = durableInventory(fixture);

    assert.throws(() => appendAnchored(fixture.root, fixture.runId, {
      type: 'compact-restore-interleaving-test',
      data: { fault_at: faultAt },
      now: new Date(NOW_MS + 3000).toISOString(),
    }, loop => { loop.discovered_items.push(faultAt); }), /COMPACT_RESTORE_INTENT_PENDING/, faultAt);
    let callbackCalled = false;
    assert.throws(() => withReconciledMutationLock(fixture.root, fixture.runId, () => {
      callbackCalled = true;
    }), /COMPACT_RESTORE_INTENT_PENDING/, `${faultAt}: fixed-shape gateway`);
    assert.equal(callbackCalled, false, `${faultAt}: fixed-shape callback`);
    assert.deepEqual(durableInventory(fixture), before, faultAt);

    const restored = publicManualRestore(fixture, emitted, NOW_MS + 4000);
    assert.equal(restored.phase, 'restored', faultAt);
    const events = readFileSync(logPathOf(fixture.root, fixture.runId), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(events.filter(event => event.type === 'compact-restored').length, 1, faultAt);
    assert.equal(events.filter(event => event.type === 'compact-restore-interleaving-test').length, 0, faultAt);
  }
});

test('public checkpoint emit preserves stale-fence precedence over a retained restore intent', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
    faultAt: 'restore:intent-written',
  }), /TEST_FAULT:restore:intent-written/);
  const before = durableInventory(fixture);

  for (const args of [
    ['checkpoint', 'emit', '--runtime', fixture.runtime],
    ['state', 'patch', '--field', 'discovered_items', '--value', '[]'],
    ['breaker', 'reset', '--confirm'],
    ['lease', 'release'],
  ]) {
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts', 'deep-loop.mjs'),
      ...args,
      '--owner', 'wrong-owner',
      '--generation', String(fixture.fence.generation),
      '--project-root', fixture.root,
      '--run-id', fixture.runId,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 3, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /LEASE_FENCED: owner-mismatch/, args.join(' '));
    assert.doesNotMatch(result.stderr, /COMPACT_RESTORE_INTENT_PENDING/, args.join(' '));
  }

  const authorized = spawnSync(process.execPath, [
    join(process.cwd(), 'scripts', 'deep-loop.mjs'),
    'state', 'patch', '--field', 'discovered_items', '--value', '[]',
    '--owner', fixture.fence.owner,
    '--generation', String(fixture.fence.generation),
    '--project-root', fixture.root,
    '--run-id', fixture.runId,
  ], { encoding: 'utf8' });
  assert.equal(authorized.status, 1, `${authorized.stdout}\n${authorized.stderr}`);
  assert.match(authorized.stderr, /COMPACT_RESTORE_INTENT_PENDING/);

  const blockedInsights = spawnSync(process.execPath, [
    join(process.cwd(), 'scripts', 'deep-loop.mjs'),
    'insights', 'emit',
    '--owner', fixture.fence.owner,
    '--generation', String(fixture.fence.generation),
    '--project-root', fixture.root,
    '--run-id', fixture.runId,
  ], { encoding: 'utf8' });
  assert.equal(blockedInsights.status, 1, `${blockedInsights.stdout}\n${blockedInsights.stderr}`);
  assert.match(blockedInsights.stderr, /COMPACT_RESTORE_INTENT_PENDING/);
  const insightsDir = join(fixture.root, '.deep-loop', 'insights');
  assert.ok(!existsSync(insightsDir) || readdirSync(insightsDir).length === 0,
    'intent-blocked insights emit must leave no hidden temporary artifact');
  assert.deepEqual(durableInventory(fixture), before);
});

test('post-cleanup compact restore retry fails closed after a later generic mutation', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  seedCompactObservation(fixture, emitted);
  assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
    faultAt: 'restore:intent-cleanup',
  }), /TEST_FAULT:restore:intent-cleanup/);
  assert.equal(
    readdirSync(join(runDir(fixture.root, fixture.runId), 'compact-restore-intents')).length,
    0,
  );
  appendAnchored(fixture.root, fixture.runId, {
    type: 'compact-restore-post-cleanup-test',
    data: { after_cleanup: true },
    now: new Date(NOW_MS + 3000).toISOString(),
  }, loop => { loop.discovered_items.push('after-compact-restore'); });
  const beforeReplay = durableInventory(fixture);
  const current = readState(fixture.root, fixture.runId).data;
  const context = JSON.parse(readFileSync(
    strictCheckpointPath(fixture.root, fixture.runId, emitted),
    'utf8',
  )).payload.context;
  assert.equal(context.run_id, fixture.runId);
  assert.equal(context.owner_run_id, fixture.fence.owner);
  assert.equal(context.generation, fixture.fence.generation);
  assert.equal(context.runtime, fixture.runtime);
  assert.equal(context.project_root_digest, projectRootDigest(current.project.root));
  assert.equal(context.project_binding_generation, current.project.binding_generation);
  assert.equal(context.scope.workstream_id, current.session_chain.sessions.at(-1).scope.workstream_id);
  assert.equal(context.workstream.id, current.workstreams[0].id);
  assert.equal(context.current_episode.id, current.current_episode);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'sessionstart',
    now: NOW_MS + 4000,
  }), /CHECKPOINT_CONTEXT_MISMATCH/);
  assert.deepEqual(durableInventory(fixture), beforeReplay);
  const events = readFileSync(logPathOf(fixture.root, fixture.runId), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'compact-restored').length, 1);
  assert.equal(events.filter(event => event.type === 'compact-restore-post-cleanup-test').length, 1);
});

test('ordinary restore converges the exact compact hash-first state partial', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  seedHashFirstCompactPartial(fixture, emitted);
  assert.throws(() => readState(fixture.root, fixture.runId), /STATE_TAMPERED/);

  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 3000,
  });

  assert.equal(restored.disposition, 'committed');
  assert.equal(contentHash(readFileSync(loopPathOf(fixture.root, fixture.runId))),
    readFileSync(hashPathOf(fixture.root, fixture.runId), 'utf8'));
  assert.equal(
    readdirSync(join(runDir(fixture.root, fixture.runId), 'compact-restore-intents')).length,
    0,
  );
  const events = readFileSync(logPathOf(fixture.root, fixture.runId), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'compact-restored').length, 1);
});

test('compact hash-first recovery rejects tampered predecessor and candidate anchors byte-identically', () => {
  for (const variant of ['predecessor', 'candidate-hash']) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    const partial = seedHashFirstCompactPartial(fixture, emitted);
    if (variant === 'predecessor') {
      const tampered = JSON.parse(partial.predecessorBytes.toString('utf8'));
      tampered.discovered_items.push('forged-predecessor');
      const tamperedBytes = Buffer.from(JSON.stringify(tampered, null, 2));
      writeFileSync(loopPathOf(fixture.root, fixture.runId), tamperedBytes);
      writeFileSync(
        hashPathOf(fixture.root, fixture.runId),
        contentHash(compactCandidateBytes(tamperedBytes, fixture.runId, partial.intent.payload)),
      );
    } else {
      writeFileSync(hashPathOf(fixture.root, fixture.runId), 'f'.repeat(64));
    }
    const before = durableInventory(fixture);

    assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...manualAdmission,
      now: NOW_MS + 3000,
    }), /STATE_TAMPERED/, variant);
    assert.deepEqual(durableInventory(fixture), before, variant);
  }
});

test('compact hash-first recovery validates the fresh fence before repairing state', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  seedHashFirstCompactPartial(fixture, emitted);
  const before = durableInventory(fixture);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: { owner: 'different-owner', generation: fixture.fence.generation },
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 3000,
  }), /LEASE_FENCED: owner-mismatch/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('compact hash-first recovery validates the retained request binding before repairing state', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  seedCompactObservation(fixture, emitted);
  seedHashFirstCompactPartial(fixture, emitted, {
    admission: 'postcompact-observation', source: 'sessionstart', env: {},
  });
  const before = durableInventory(fixture);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'external-controller',
    env: {},
    now: NOW_MS + 3000,
  }), /CHECKPOINT_RESTORE_REQUEST_MISMATCH/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('retained compact intent recovers when the generic transactions parent is empty', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
    faultAt: 'restore:intent-written',
  }), /TEST_FAULT:restore:intent-written/);
  const transactions = join(runDir(fixture.root, fixture.runId), 'transactions');
  mkdirSync(transactions);
  assert.deepEqual(readdirSync(transactions), []);

  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 3000,
  });

  assert.equal(restored.disposition, 'committed');
  assert.equal(
    readdirSync(join(runDir(fixture.root, fixture.runId), 'compact-restore-intents')).length,
    0,
  );
  assert.equal(existsSync(transactions), true);
  assert.deepEqual(readdirSync(transactions), []);
});

test('retained restore intent binds admission source and proof before any recovery mutation', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const receiptPath = seedCompactObservation(fixture, emitted);
  assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'sessionstart',
    now: NOW_MS + 2000,
    faultAt: 'restore:intent-written',
  }), /TEST_FAULT:restore:intent-written/);

  const intentDir = join(runDir(fixture.root, fixture.runId), 'compact-restore-intents');
  const intent = JSON.parse(readFileSync(join(intentDir, readdirSync(intentDir)[0]), 'utf8'));
  assert.match(intent.payload.operation_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(intent.payload.planned_event_line.endsWith('\n'), true);
  assert.equal(intent.payload.planned_event_line.endsWith('\n\n'), false);
  assert.equal(contentHash(intent.payload.planned_event_line), intent.payload.planned_event_sha256);
  const planned = JSON.parse(intent.payload.planned_event_line.slice(0, -1));
  assert.equal(planned.data.operation_id, intent.payload.operation_id);
  assert.equal(planned.checksum, intent.payload.planned_event.checksum);
  assert.equal(
    contentHash(JSON.stringify(intent.payload.request_binding)),
    intent.payload.request_binding_sha256,
  );
  assert.throws(
    () => prepareGenericPublication(fixture, 'retained-restore-wrong-binding'),
    /COMPACT_RESTORE_INTENT_PENDING/,
  );

  for (const request of [
    { admission: 'postcompact-observation', source: 'external-controller' },
    manualAdmission,
  ]) {
    const before = durableInventory(fixture);
    assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...request,
      now: NOW_MS + 3000,
    }), /CHECKPOINT_RESTORE_REQUEST_MISMATCH/);
    assert.deepEqual(durableInventory(fixture), before);
  }

  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.payload.trigger = 'manual';
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const beforeProofMismatch = durableInventory(fixture);
  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'sessionstart',
    now: NOW_MS + 3000,
  }), /CHECKPOINT_RESTORE_REQUEST_MISMATCH/);
  assert.deepEqual(durableInventory(fixture), beforeProofMismatch);
});

test('committed compact cursor cross-source replay validates each request and preserves winner audit', () => {
  for (const [winner, replay] of [
    ['sessionstart', 'external-controller'],
    ['external-controller', 'sessionstart'],
  ]) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    seedCompactObservation(fixture, emitted, { trigger: 'auto' });
    const committed = restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      admission: 'postcompact-observation',
      source: winner,
      now: NOW_MS + 2000,
    });
    const committedBytes = durableInventory(fixture);
    const replayed = restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      admission: 'postcompact-observation',
      source: replay,
      now: NOW_MS + 3000,
    });
    assert.equal(replayed.disposition, 'replayed');
    assert.deepEqual(replayed.admission, committed.admission);
    assert.equal(replayed.admission.source, winner);
    assert.deepEqual(durableInventory(fixture), committedBytes);
  }

  for (const observationFirst of [false, true]) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    seedCompactObservation(fixture, emitted);
    const observation = {
      admission: 'postcompact-observation', source: 'sessionstart',
    };
    const first = observationFirst ? observation : manualAdmission;
    const second = observationFirst ? manualAdmission : observation;
    const committed = restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...first,
      now: NOW_MS + 2000,
    });
    const committedBytes = durableInventory(fixture);
    const replayed = restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...second,
      now: NOW_MS + 3000,
    });
    assert.equal(replayed.disposition, 'replayed');
    assert.deepEqual(replayed.admission, committed.admission);
    assert.deepEqual(replayed.provider_evidence, committed.provider_evidence);
    assert.deepEqual(durableInventory(fixture), committedBytes);
  }
});

test('observation admission validates the fixed receipt envelope and preserves its evidence row', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  const receiptPath = seedCompactObservation(fixture, emitted, {
    trigger: 'manual',
    providerEvidence: { recorded: true, supplied: true, matched: true },
  });
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.envelope.extra = true;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const before = durableInventory(fixture);
  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'external-controller',
    now: NOW_MS + 2000,
  }), /CHECKPOINT_RECEIPT_INVALID/);
  assert.deepEqual(durableInventory(fixture), before);

  delete receipt.envelope.extra;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const restored = restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'external-controller',
    now: NOW_MS + 2000,
  });
  assert.deepEqual(restored.admission, {
    kind: 'postcompact-observation', source: 'external-controller', receipt_trigger: 'manual',
  });
  assert.deepEqual(restored.provider_evidence, {
    recorded: true, supplied: true, matched: true,
  });
});

test('human-attested admission requires direct source, one confirmation, and non-headless runtime', () => {
  for (const options of [
    { admission: 'human-attested', source: 'sessionstart', confirmManualCompact: true },
    { admission: 'human-attested', source: 'direct-human-skill', confirmManualCompact: false },
    {
      admission: 'human-attested',
      source: 'direct-human-skill',
      confirmManualCompact: true,
      env: { DEEP_LOOP_HEADLESS: '1' },
    },
  ]) {
    const fixture = seedBound();
    const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 1000,
    });
    const before = durableInventory(fixture);
    assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: emitted.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...options,
      now: NOW_MS + 2000,
    }), /CHECKPOINT_(?:ADMISSION_INVALID|MANUAL_ATTESTATION_REQUIRED)/);
    assert.deepEqual(durableInventory(fixture), before);
  }
});

test('human-attested admission rejects durable headless spawn style with an empty environment', () => {
  const fixture = seedBound();
  const state = readState(fixture.root, fixture.runId).data;
  state.autonomy.spawn_style = 'headless';
  writeState(fixture.root, fixture.runId, state);
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const before = durableInventory(fixture);

  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
  }), /CHECKPOINT_MANUAL_ATTESTATION_REQUIRED/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('unjournaled compact-restored raw suffix fails closed without changing durable bytes', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 2000,
    faultAt: 'restore:intent-written',
  }), /TEST_FAULT:restore:intent-written/);
  const intentDir = join(runDir(fixture.root, fixture.runId), 'compact-restore-intents');
  const intentPath = join(intentDir, readdirSync(intentDir)[0]);
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  rmSync(intentPath);
  appendFileSync(logPathOf(fixture.root, fixture.runId), intent.payload.planned_event_line);
  const before = durableInventory(fixture);
  assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    ...manualAdmission,
    now: NOW_MS + 3000,
  }), /LOG_TAMPERED/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('strict checkpoint projects every prepared optional-identity evidence row in ordered boolean form', () => {
  const cases = [
    [undefined, undefined, { recorded: false, supplied: false, matched: false }],
    [undefined, hostEvidence(), { recorded: false, supplied: true, matched: false }],
    [hostEvidence(), undefined, { recorded: true, supplied: false, matched: false }],
    [hostEvidence(), hostEvidence(), { recorded: true, supplied: true, matched: true }],
  ];
  for (const [recorded, supplied, expected] of cases) {
    const fixture = seedBound();
    emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: recorded,
      now: NOW_MS + 1000,
    });
    const inspected = inspectCompactForSessionStart(fixture.root, fixture.runId, {
      hostSessionEvidence: supplied,
      now: NOW_MS + 1000,
    });
    assert.equal(inspected.ok, true);
    assert.deepEqual(Object.keys(inspected.provider_evidence), ['recorded', 'supplied', 'matched']);
    assert.deepEqual(inspected.provider_evidence, expected);
  }

  const mismatch = seedBound();
  emitCompactCheckpoint(mismatch.root, mismatch.runId, {
    fence: mismatch.fence,
    runtime: mismatch.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 1000,
  });
  assert.deepEqual(
    inspectCompactForSessionStart(mismatch.root, mismatch.runId, {
      hostSessionEvidence: hostEvidence('claude-code', 'different-session'),
      now: NOW_MS + 1000,
    }),
    emptyInspectExpectation('trusted-evidence-rejected'),
  );
});

test('trusted observation creates one fixed receipt, is trigger-idempotent, and rejects identity conflict', () => {
  const fixture = seedBound();
  const recorded = hostEvidence();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: recorded,
    now: NOW_MS + 1000,
  });
  const first = observeCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    trigger: 'manual',
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: recorded,
    now: NOW_MS + 2000,
  });
  assert.deepEqual(first.provider_evidence, { recorded: true, supplied: true, matched: true });
  assert.equal(first.created, true);
  const receiptPath = join(
    checkpointDirOf(fixture.root, fixture.runId),
    `${emitted.checkpoint_key}-compact-observation.json`,
  );
  const firstBytes = readFileSync(receiptPath);

  const retry = observeCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    trigger: 'auto',
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: recorded,
    now: NOW_MS + 3000,
  });
  assert.equal(retry.created, false);
  assert.equal(retry.trigger, 'manual');
  assert.deepEqual(readFileSync(receiptPath), firstBytes);
  assert.throws(() => observeCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    trigger: 'manual',
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'different-session'),
    now: NOW_MS + 4000,
  }), /CHECKPOINT_EVIDENCE_MISMATCH/);
  assert.deepEqual(readFileSync(receiptPath), firstBytes);

  const conflictFixture = seedBound();
  const conflictCheckpoint = emitCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    now: NOW_MS + 1000,
  });
  observeCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    checkpointRel: conflictCheckpoint.checkpoint_rel,
    trigger: 'auto',
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    now: NOW_MS + 2000,
  });
  assert.throws(() => observeCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    checkpointRel: conflictCheckpoint.checkpoint_rel,
    trigger: 'auto',
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 3000,
  }), /CHECKPOINT_RECEIPT_CONFLICT/);

  const older = emitCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'older'),
    now: NOW_MS + 4000,
  });
  emitCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'newer'),
    now: NOW_MS + 5000,
  });
  assert.throws(() => observeCompactCheckpoint(conflictFixture.root, conflictFixture.runId, {
    checkpointRel: older.checkpoint_rel,
    trigger: 'auto',
    fence: conflictFixture.fence,
    runtime: conflictFixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'older'),
    now: NOW_MS + 6000,
  }), /CHECKPOINT_INELIGIBLE/);
});

test('synchronized inspect exposes ordered prepared, compacted, and restored projections', () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const prepared = inspectCompactForSessionStart(fixture.root, fixture.runId, {
    now: NOW_MS + 1000,
  });
  assert.deepEqual(Object.keys(prepared), [
    'ok', 'phase', 'reason', 'checkpoint_rel', 'checkpoint_key', 'context_sha256',
    'pre_restore_loop_hash', 'owner_run_id', 'generation', 'runtime', 'workstream_id',
    'episode_id', 'trigger', 'cycle', 'admission', 'restore_event', 'next_command',
    'requires_model_turn', 'replay', 'provider_evidence',
  ]);
  assert.equal(prepared.phase, 'prepared');
  assert.equal(prepared.admission, null);

  observeCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    trigger: 'auto',
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 2000,
  });
  const compacted = inspectCompactCheckpoint(fixture.root, fixture.runId, { now: NOW_MS + 2000 });
  assert.equal(compacted.phase, 'compacted');
  assert.deepEqual(compacted.admission, {
    kind: 'postcompact-observation', source: null, receipt_trigger: 'auto',
  });

  restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: emitted.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'sessionstart',
    now: NOW_MS + 3000,
  });
  const restored = inspectCompactForSessionStart(fixture.root, fixture.runId, { now: NOW_MS + 3000 });
  assert.equal(restored.phase, 'restored');
  assert.equal(restored.requires_model_turn, false);
  assert.equal(restored.replay, 'exact');

  const newer = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'newer-global-key'),
    now: NOW_MS + 4000,
  });
  const globallySelected = inspectCompactForSessionStart(fixture.root, fixture.runId, {
    now: NOW_MS + 4000,
  });
  assert.equal(globallySelected.phase, 'prepared');
  assert.equal(globallySelected.checkpoint_key, newer.checkpoint_key);
});

test('pair pruning exposes four crash seams and reconciles tombstones while live intents pin pairs', () => {
  assert.equal(typeof __testEmitCompactCheckpoint, 'function');
  assert.equal(typeof __testObserveCompactCheckpoint, 'function');
  for (const seam of [
    'prune:tombstone-written',
    'prune:receipt-unlinked',
    'prune:checkpoint-unlinked',
    'prune:tombstone-cleanup',
  ]) {
    const fixture = seedBound();
    for (let index = 0; index < 6; index += 1) {
      try {
        __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
          fence: fixture.fence,
          runtime: fixture.runtime,
          hostSessionEvidence: hostEvidence('claude-code', `prune-${index}`),
          now: NOW_MS + index + 1,
          faultAt: index === 5 ? seam : undefined,
        });
      } catch (error) {
        assert.match(error.message, new RegExp(`TEST_FAULT:${seam}`));
      }
    }
    emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', 'reconcile'),
      now: NOW_MS + 100,
    });
    assert.equal(
      readdirSync(checkpointDirOf(fixture.root, fixture.runId))
        .some(name => name.endsWith('-compact-prune.json')),
      false,
      seam,
    );
  }
});

test('compact prune reconciliation validates M3 identity and both surviving pair bindings before unlink', () => {
  for (const [label, mutate] of [
    ['run binding', value => { value.envelope.run_id = 'foreign-run'; }],
    ['source binding', value => { value.envelope.provenance.source_artifacts.reverse(); }],
    ['checkpoint bytes binding', value => { value.payload.checkpoint_sha256 = 'e'.repeat(64); }],
    ['checkpoint binding', value => { value.payload.context_sha256 = '0'.repeat(64); }],
    ['receipt binding', value => { value.payload.receipt_sha256 = 'f'.repeat(64); }],
  ]) {
    const fixture = seedBound();
    const emitted = [];
    for (let index = 0; index < 5; index += 1) {
      emitted.push(__testEmitCompactCheckpoint(fixture.root, fixture.runId, {
        fence: fixture.fence,
        runtime: fixture.runtime,
        hostSessionEvidence: hostEvidence('claude-code', `validated-prune-${label}-${index}`),
        now: NOW_MS + index + 1,
      }));
    }
    seedCompactObservation(fixture, emitted[0]);
    assert.throws(() => __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', `validated-prune-${label}-trigger`),
      now: NOW_MS + 100,
      faultAt: seam => { if (seam === 'prune:tombstone-written') throw new Error(seam); },
    }), /prune:tombstone-written/);
    const tombstone = join(
      checkpointDirOf(fixture.root, fixture.runId),
      `${emitted[0].checkpoint_key}-compact-prune.json`,
    );
    const value = JSON.parse(readFileSync(tombstone, 'utf8'));
    mutate(value);
    writeFileSync(tombstone, JSON.stringify(value, null, 2));
    const before = durableInventory(fixture);

    assert.throws(() => emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      now: NOW_MS + 200,
    }), /COMPACT_PRUNE_INVALID/, label);
    assert.deepEqual(durableInventory(fixture), before, label);
  }
});

test('compact prune reconciliation rejects a malformed checkpoint replaced after tombstone publication', () => {
  const fixture = seedBound();
  const dir = checkpointDirOf(fixture.root, fixture.runId);
  mkdirSync(dir, { recursive: true });
  const key = 'f'.repeat(64);
  const checkpoint = join(dir, `${key}-compact.json`);
  writeFileSync(checkpoint, '{"invalid":"original"}');
  for (let index = 0; index < 4; index += 1) {
    __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', `malformed-prune-${index}`),
      now: NOW_MS + index + 1,
    });
  }
  assert.throws(() => __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'malformed-prune-trigger'),
    now: NOW_MS + 100,
    faultAt: seam => { if (seam === 'prune:tombstone-written') throw new Error(seam); },
  }), /prune:tombstone-written/);
  assert.equal(existsSync(join(dir, `${key}-compact-prune.json`)), true);

  writeFileSync(checkpoint, '{"invalid":"replacement"}');
  const before = durableInventory(fixture);
  assert.throws(() => emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 200,
  }), /COMPACT_PRUNE_INVALID/);
  assert.deepEqual(durableInventory(fixture), before);
});

test('compact prune writer revalidates surviving pair bytes after tombstone publication before unlink', () => {
  for (const target of ['checkpoint', 'receipt']) {
    const fixture = seedBound();
    const emitted = [];
    for (let index = 0; index < 5; index += 1) {
      emitted.push(__testEmitCompactCheckpoint(fixture.root, fixture.runId, {
        fence: fixture.fence,
        runtime: fixture.runtime,
        hostSessionEvidence: hostEvidence('claude-code', `writer-race-${target}-${index}`),
        now: NOW_MS + index + 1,
      }));
    }
    seedCompactObservation(fixture, emitted[0]);
    const dir = checkpointDirOf(fixture.root, fixture.runId);
    const checkpoint = strictCheckpointPath(fixture.root, fixture.runId, emitted[0]);
    const receipt = join(dir, `${emitted[0].checkpoint_key}-compact-observation.json`);
    const tombstone = join(dir, `${emitted[0].checkpoint_key}-compact-prune.json`);
    const replacementPath = target === 'checkpoint' ? checkpoint : receipt;
    const replacement = Buffer.from(`replacement-${target}-after-tombstone`);

    assert.throws(() => __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', `writer-race-${target}-trigger`),
      now: NOW_MS + 100,
      faultAt: seam => {
        if (seam === 'prune:tombstone-written') writeFileSync(replacementPath, replacement);
      },
    }), /COMPACT_PRUNE_INVALID/, target);
    assert.deepEqual(readFileSync(replacementPath), replacement, `${target} replacement must survive`);
    assert.equal(existsSync(checkpoint), true, `${target} race must not partially unlink checkpoint`);
    assert.equal(existsSync(receipt), true, `${target} race must not partially unlink receipt`);
    assert.equal(existsSync(tombstone), true, `${target} race must preserve tombstone evidence`);
  }
});

test('compact prune reconciliation revalidates surviving bytes after validation before unlink', () => {
  for (const target of ['checkpoint', 'receipt']) {
    const fixture = seedBound();
    const emitted = [];
    for (let index = 0; index < 5; index += 1) {
      emitted.push(__testEmitCompactCheckpoint(fixture.root, fixture.runId, {
        fence: fixture.fence,
        runtime: fixture.runtime,
        hostSessionEvidence: hostEvidence('claude-code', `reconcile-race-${target}-${index}`),
        now: NOW_MS + index + 1,
      }));
    }
    seedCompactObservation(fixture, emitted[0]);
    assert.throws(() => __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', `reconcile-race-${target}-trigger`),
      now: NOW_MS + 100,
      faultAt: seam => { if (seam === 'prune:tombstone-written') throw new Error(seam); },
    }), /prune:tombstone-written/);
    const dir = checkpointDirOf(fixture.root, fixture.runId);
    const checkpoint = strictCheckpointPath(fixture.root, fixture.runId, emitted[0]);
    const receipt = join(dir, `${emitted[0].checkpoint_key}-compact-observation.json`);
    const tombstone = join(dir, `${emitted[0].checkpoint_key}-compact-prune.json`);
    const replacementPath = target === 'checkpoint' ? checkpoint : receipt;
    const replacement = Buffer.from(`replacement-${target}-after-reconcile-validation`);

    assert.throws(() => withLock(fixture.root, fixture.runId, guard =>
      reconcileCompactPruneTombstonesLocked(fixture.root, fixture.runId, guard, {
        checkpointKey: emitted[0].checkpoint_key,
        faultAt: seam => {
          if (seam === 'prune:reconcile-validated') writeFileSync(replacementPath, replacement);
        },
      })), /COMPACT_PRUNE_INVALID/, target);
    assert.deepEqual(readFileSync(replacementPath), replacement, `${target} replacement must survive`);
    assert.equal(existsSync(checkpoint), true, `${target} race must not partially unlink checkpoint`);
    assert.equal(existsSync(receipt), true, `${target} race must not partially unlink receipt`);
    assert.equal(existsSync(tombstone), true, `${target} race must preserve tombstone evidence`);
  }
});

test('compact prune retry converges a parseable invalid checkpoint with a plausible context digest', () => {
  const fixture = seedBound();
  const dir = checkpointDirOf(fixture.root, fixture.runId);
  mkdirSync(dir, { recursive: true });
  const key = 'f'.repeat(64);
  const checkpoint = join(dir, `${key}-compact.json`);
  const receipt = join(dir, `${key}-compact-observation.json`);
  const tombstone = join(dir, `${key}-compact-prune.json`);
  writeFileSync(checkpoint, JSON.stringify({
    payload: { context_sha256: 'a'.repeat(64) },
  }));
  writeFileSync(receipt, '{"receipt":"invalid-checkpoint-pair"}');
  for (let index = 0; index < 4; index += 1) {
    __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', `invalid-context-prune-${index}`),
      now: NOW_MS + index + 1,
    });
  }
  assert.throws(() => __testEmitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'invalid-context-prune-trigger'),
    now: NOW_MS + 100,
    faultAt: seam => { if (seam === 'prune:tombstone-written') throw new Error(seam); },
  }), /prune:tombstone-written/);
  assert.equal(existsSync(checkpoint), true);
  assert.equal(existsSync(receipt), true);
  assert.equal(existsSync(tombstone), true);
  assert.equal(
    JSON.parse(readFileSync(tombstone, 'utf8')).payload.context_sha256,
    null,
  );

  emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 200,
  });

  assert.equal(existsSync(checkpoint), false);
  assert.equal(existsSync(receipt), false);
  assert.equal(existsSync(tombstone), false);
});

test('direct restore retry converges a crashed prune tombstone under the restore transaction lock', () => {
  for (const seam of [
    'prune:tombstone-written',
    'prune:receipt-unlinked',
    'prune:checkpoint-unlinked',
  ]) {
    const fixture = seedBound();
    const emitted = [];
    for (let index = 0; index < 6; index += 1) {
      try {
        emitted.push(__testEmitCompactCheckpoint(fixture.root, fixture.runId, {
          fence: fixture.fence,
          runtime: fixture.runtime,
          hostSessionEvidence: hostEvidence('claude-code', `restore-prune-${index}`),
          now: NOW_MS + index + 1,
          faultAt: index === 5
            ? label => { if (label === seam) throw new Error(`TEST_FAULT:${label}`); }
            : undefined,
        }));
      } catch (error) {
        assert.match(error.message, new RegExp(`TEST_FAULT:${seam}`));
      }
    }
    const target = emitted[0];
    const dir = checkpointDirOf(fixture.root, fixture.runId);
    const tombstone = join(dir, `${target.checkpoint_key}-compact-prune.json`);
    const checkpoint = strictCheckpointPath(fixture.root, fixture.runId, target);
    const receipt = join(dir, `${target.checkpoint_key}-compact-observation.json`);
    assert.equal(existsSync(tombstone), true, seam);
    const beforeRun = durableRunBytes(fixture);

    assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: target.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...manualAdmission,
      now: NOW_MS + 100,
    }), /CHECKPOINT_INELIGIBLE/, seam);

    assert.equal(existsSync(tombstone), false, seam);
    assert.equal(existsSync(checkpoint), false, seam);
    assert.equal(existsSync(receipt), false, seam);
    assert.deepEqual(durableRunBytes(fixture), beforeRun, seam);
    assert.throws(() => restoreCompactCheckpoint(fixture.root, fixture.runId, {
      checkpointRel: target.checkpoint_rel,
      fence: fixture.fence,
      runtime: fixture.runtime,
      ...manualAdmission,
      now: NOW_MS + 101,
    }), /CHECKPOINT_NOT_FOUND/, seam);
  }
});

test('restore rechecks prune ineligibility after a competing writer held the transaction lock', async () => {
  const fixture = seedBound();
  const emitted = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1000,
  });
  const marker = join(fixture.root, 'restore-child-ready');
  const tombstone = join(
    checkpointDirOf(fixture.root, fixture.runId),
    `${emitted.checkpoint_key}-compact-prune.json`,
  );
  const cli = join(process.cwd(), 'scripts', 'deep-loop.mjs');
  const childSource = `
    import { writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    writeFileSync(${JSON.stringify(marker)}, 'ready');
    const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' };
    delete env.DEEP_LOOP_UNATTENDED;
    delete env.DEEP_LOOP_HEADLESS;
    const result = spawnSync(process.execPath, ${JSON.stringify([
      cli,
      'checkpoint', 'restore',
      '--checkpoint', emitted.checkpoint_rel,
      '--owner', fixture.fence.owner,
      '--generation', String(fixture.fence.generation),
      '--runtime', fixture.runtime,
      '--admission', 'human-attested',
      '--source', 'direct-human-skill',
      '--confirm-manual-compact',
      '--json',
      '--now', String(NOW_MS + 2000),
      '--project-root', fixture.root,
      '--run-id', fixture.runId,
    ])}, { encoding: 'utf8', env });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  `;
  let child;
  let stdout = '';
  let stderr = '';
  withLock(fixture.root, fixture.runId, () => {
    child = spawn(process.execPath, ['--input-type=module', '-e', childSource]);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(existsSync(marker), true);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    writeFileSync(tombstone, '{}');
  });
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  });

  assert.equal(code, 1, `${stdout}\n${stderr}`);
  assert.match(stderr, /COMPACT_PRUNE_INVALID/);
  assert.equal(existsSync(tombstone), true);
  assert.equal(existsSync(strictCheckpointPath(fixture.root, fixture.runId, emitted)), true);
});

test('live restore intent pins its checkpoint and receipt pair until intent cleanup', () => {
  const fixture = seedBound();
  const pinned = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    now: NOW_MS + 1,
  });
  const pinnedReceipt = seedCompactObservation(fixture, pinned);
  assert.throws(() => __testRestoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: pinned.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'sessionstart',
    now: NOW_MS + 2,
    faultAt: 'restore:intent-written',
  }), /TEST_FAULT:restore:intent-written/);

  assert.throws(() => emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence('claude-code', 'blocked-pressure'),
    now: NOW_MS + 10,
  }), /COMPACT_RESTORE_INTENT_PENDING/);
  assert.equal(existsSync(strictCheckpointPath(fixture.root, fixture.runId, pinned)), true);
  assert.equal(existsSync(pinnedReceipt), true);

  restoreCompactCheckpoint(fixture.root, fixture.runId, {
    checkpointRel: pinned.checkpoint_rel,
    fence: fixture.fence,
    runtime: fixture.runtime,
    admission: 'postcompact-observation',
    source: 'sessionstart',
    now: NOW_MS + 100,
  });
  for (let index = 0; index < 7; index += 1) {
    emitCompactCheckpoint(fixture.root, fixture.runId, {
      fence: fixture.fence,
      runtime: fixture.runtime,
      hostSessionEvidence: hostEvidence('claude-code', `after-cleanup-${index}`),
      now: NOW_MS + 101 + index,
    });
  }
  assert.equal(existsSync(strictCheckpointPath(fixture.root, fixture.runId, pinned)), false);
  assert.equal(existsSync(pinnedReceipt), false);
});

test('restore descriptor excludes captured routing and hostile checkpoint strings', () => {
  for (const point of [
    `/Users/reviewer/private/${'x'.repeat(4000)}`,
    'hostile,[C:\\strict-secret\\file.txt]',
    'https://example.test/strict-secret',
    '/deep-loop-status',
  ]) {
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
      ...manualAdmission,
      now: NOW_MS + 1000,
    });
    const json = JSON.stringify(restored);
    assert.equal(json.includes(point), false, point);
    assert.equal(json.includes(fixture.root), false, point);
    assert.equal(Object.hasOwn(restored, 'scope'), false);
    assert.equal(Object.hasOwn(restored, 'current_episode'), false);
    assert.equal(Object.hasOwn(restored, 'next_action'), false);
  }
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
      ...manualAdmission,
      now: NOW_MS + 1000,
    }), /CHECKPOINT_/, label);
  }

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
      ...manualAdmission,
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
    ...manualAdmission,
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
    ...manualAdmission,
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

test('root relocation stales old compact checkpoints by root epoch, generation, and loop hash', () => {
  const fixture = seedBound('claude');
  const stateBefore = readState(fixture.root, fixture.runId);
  stateBefore.data.budget.max_wallclock_sec = 10 * 365 * 24 * 60 * 60;
  writeState(fixture.root, fixture.runId, stateBefore.data);
  const oldIdentity = readState(fixture.root, fixture.runId);
  const oldCheckpoint = emitCompactCheckpoint(fixture.root, fixture.runId, {
    fence: fixture.fence,
    runtime: fixture.runtime,
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 5_000,
  });
  const oldPath = strictCheckpointPath(fixture.root, fixture.runId, oldCheckpoint);
  const oldBytes = readFileSync(oldPath);
  const candidateRoot = `${fixture.root}-relocated`;
  renameSync(fixture.root, candidateRoot);
  const recovered = recoverRelocatedRoot(candidateRoot, fixture.runId, {
    actor: 'human',
    confirm: true,
    expectedStoredRootDigest: projectRootDigest(oldIdentity.data.project.root),
    expectedBindingGeneration: oldIdentity.data.project.binding_generation,
    fence: {
      owner: oldIdentity.data.session_chain.lease.owner_run_id,
      generation: oldIdentity.data.session_chain.lease.generation,
    },
    now: NOW_MS + 6_000,
  });
  const reserved = readState(candidateRoot, fixture.runId).data;
  const child = reserved.session_chain.sessions.find(
    session => session.run_id === recovered.replacement_session_id,
  );
  acquireRootRecovery(candidateRoot, fixture.runId, {
    capsuleRel: child.recovery_rel,
    owner: child.run_id,
    expectGeneration: reserved.session_chain.lease.generation,
    bindingGeneration: reserved.project.binding_generation,
    runtime: 'claude',
    now: NOW_MS + 7_000,
    clock: () => NOW_MS + 7_000,
  });
  assert.deepEqual(inspectCompactForSessionStart(candidateRoot, fixture.runId, {
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 8_000,
  }), emptyInspectExpectation('checkpoint-ineligible'));
  assert.deepEqual(readFileSync(join(runDir(candidateRoot, fixture.runId), oldCheckpoint.checkpoint_rel)), oldBytes);

  const acquired = readState(candidateRoot, fixture.runId).data;
  const freshCheckpoint = emitCompactCheckpoint(candidateRoot, fixture.runId, {
    fence: {
      owner: acquired.session_chain.lease.owner_run_id,
      generation: acquired.session_chain.lease.generation,
    },
    runtime: 'claude',
    hostSessionEvidence: hostEvidence(),
    now: NOW_MS + 9_000,
  });
  const fresh = JSON.parse(readFileSync(
    join(runDir(candidateRoot, fixture.runId), freshCheckpoint.checkpoint_rel),
    'utf8',
  ));
  assert.equal(
    fresh.payload.context.project_root_digest,
    projectRootDigest(readState(candidateRoot, fixture.runId).data.project.root),
  );
  assert.equal(fresh.payload.context.project_binding_generation, oldIdentity.data.project.binding_generation + 1);
  assert.equal(fresh.payload.context.generation, oldIdentity.data.session_chain.lease.generation + 2);
  assert.notEqual(fresh.payload.context.loop_hash, oldIdentity.hash);
  assert.equal(JSON.stringify(fresh).includes(oldIdentity.data.project.root), false);
});
