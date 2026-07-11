import { createHash } from 'node:crypto';

export { atomicWrite, renameAtomicWithRetry, RENAME_RETRY_MAX_ELAPSED_MS } from './atomic-write.mjs';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford

export function ulid(now = Date.now(), rnd = Math.random) {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) { ts = B32[t % 32] + ts; t = Math.floor(t / 32); }
  let rand = '';
  for (let i = 0; i < 16; i++) {
    const r = typeof rnd === 'function' ? rnd() : rnd;
    rand += B32[Math.floor(r * 32) % 32];
  }
  return ts + rand;
}

export function contentHash(str) {
  return createHash('sha256').update(str).digest('hex');
}

export function wrap({ producer, artifact_kind, schema, run_id, parent_run_id = null, git = {}, provenance = { source_artifacts: [], tool_versions: {} }, payload, now }) {
  return {
    schema_version: '1.0',
    envelope: { producer, artifact_kind, schema, run_id, parent_run_id,
      generated_at: now ?? new Date().toISOString(), git, provenance },
    payload,
  };
}

export function unwrap(obj, { producer, artifact_kind }) {
  const e = obj?.envelope;
  if (!e || e.producer !== producer || e.artifact_kind !== artifact_kind || e.schema?.name !== artifact_kind) return null;
  return obj;
}
