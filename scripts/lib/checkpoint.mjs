import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';
import { ulid, unwrap, wrap } from './envelope.mjs';
import { nextAction } from './next-action.mjs';
import { withReconciledMutationLock } from './state.mjs';

const dirOf = (root, runId) => join(root, '.deep-loop', 'runs', runId, 'checkpoints');
const KEEP = 5;

// Artifact-only: loop.json/event-log/lease remain unchanged, so no fence is required (spec §4.1).
// Consumer-side identity and loop-hash selection provides freshness.
export function emitCompactCheckpoint(root, runId, { now = Date.now() } = {}) {
  return withReconciledMutationLock(root, runId, (_guard, { data: loop, hash }) => {
    const lease = loop.session_chain?.lease || {};
    const ep = (loop.episodes || []).find(episode => episode.id === loop.current_episode) || null;
    const na = nextAction(loop, { now, unattended: false });
    const payload = {
      owner_run_id: lease.owner_run_id,
      generation: lease.generation,
      loop_hash: hash,
      current_episode: loop.current_episode,
      current_episode_detail: ep ? {
        id: ep.id,
        role: ep.role,
        status: ep.status,
        point: ep.point,
        workstream_id: ep.workstream_id,
      } : null,
      active_workstreams: loop.active_workstreams || [],
      next_action_hint: { type: na.action.type, next_command: na.next_command },
      artifacts: ep && Array.isArray(ep.expected_artifacts) ? ep.expected_artifacts : [],
    };
    const env = wrap({
      producer: 'deep-loop',
      artifact_kind: 'compact-checkpoint',
      schema: { name: 'compact-checkpoint', version: '1.0' },
      run_id: runId,
      payload,
      now: new Date(now).toISOString(),
    });
    mkdirSync(dirOf(root, runId), { recursive: true });
    const path = join(dirOf(root, runId), `${ulid(now)}-compact.json`);
    atomicWrite(path, JSON.stringify(env, null, 2));
    prune(root, runId, lease.owner_run_id, lease.generation);
    return { ok: true, path };
  });
}

export function captureCheckpointSet(root, runId) {
  return withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    const checkpoints = [];
    const dir = dirOf(root, runId);
    if (existsSync(dir)) {
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('CHECKPOINT_PATH_INVALID');
      const names = Object.freeze(readdirSync(dir)
        .filter(file => file.endsWith('-compact.json'))
        .sort()
        .reverse());
      for (const name of names) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        checkpoints.push(Object.freeze({ path, bytes: Buffer.from(readFileSync(path)) }));
      }
    }
    return Object.freeze({ snapshot, checkpoints: Object.freeze(checkpoints) });
  });
}

function listCheckpoints(root, runId) {
  const dir = dirOf(root, runId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(file => file.endsWith('-compact.json'))
    .sort()
    .map(file => join(dir, file));
}

function prune(root, runId, owner, generation) {
  const all = listCheckpoints(root, runId);
  if (all.length <= KEEP) return;
  const owned = new Set(all.filter(path => {
    try {
      const env = JSON.parse(readFileSync(path, 'utf8'));
      if (unwrap(env, { producer: 'deep-loop', artifact_kind: 'compact-checkpoint' }) === null) return false;
      if (env.envelope?.run_id !== runId) return false;
      return env.payload?.owner_run_id === owner && env.payload?.generation === generation;
    } catch {
      return false;
    }
  }));
  const removable = [
    ...all.filter(path => !owned.has(path)),
    ...all.filter(path => owned.has(path)),
  ];
  for (const path of removable) {
    if (listCheckpoints(root, runId).length <= KEEP) break;
    rmSync(path, { force: true });
  }
}

export function selectCheckpoint(checkpointSet, { owner, generation, loopHash }) {
  if (!checkpointSet || !Array.isArray(checkpointSet.checkpoints)) throw new Error('CHECKPOINT_SNAPSHOT_REQUIRED');
  const runId = checkpointSet.snapshot?.data?.run_id;
  for (const checkpoint of checkpointSet.checkpoints) {
    try {
      const env = JSON.parse(checkpoint.bytes.toString('utf8'));
      if (unwrap(env, { producer: 'deep-loop', artifact_kind: 'compact-checkpoint' }) === null) continue;
      if (env.envelope?.run_id !== runId) continue;
      const payload = env.payload;
      if (typeof payload?.owner_run_id !== 'string' || typeof payload?.loop_hash !== 'string') continue;
      if (payload.owner_run_id === owner
        && payload.generation === generation
        && payload.loop_hash === loopHash) {
        return checkpoint;
      }
    } catch {
      // Malformed or foreign artifacts are not eligible restore context.
    }
  }
  return null;
}
