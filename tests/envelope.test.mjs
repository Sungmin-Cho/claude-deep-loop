import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid, wrap, unwrap, contentHash, atomicWrite } from '../scripts/lib/envelope.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ulid is 26-char Crockford base32', () => {
  const id = ulid(1700000000000, 0.5);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulid is monotonic-ish by time prefix', () => {
  const a = ulid(1000, 0.1), b = ulid(2000, 0.1);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
});

test('wrap produces M3 envelope, unwrap guards identity', () => {
  const env = wrap({ producer: 'deep-loop', artifact_kind: 'handoff',
    schema: { name: 'handoff', version: '1.0' }, run_id: ulid(1, 0.1),
    parent_run_id: null, git: { head: 'abc', branch: 'main', dirty: false },
    provenance: { source_artifacts: [], tool_versions: {} }, payload: { a: 1 }, now: '2026-01-01T00:00:00Z' });
  assert.equal(env.schema_version, '1.0');
  assert.equal(env.envelope.producer, 'deep-loop');
  assert.deepEqual(unwrap(env, { producer: 'deep-loop', artifact_kind: 'handoff' }).payload, { a: 1 });
  assert.equal(unwrap(env, { producer: 'deep-work', artifact_kind: 'handoff' }), null); // guard
});

test('atomicWrite then read roundtrips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const p = join(dir, 'x.json');
  atomicWrite(p, '{"k":1}');
  assert.equal(readFileSync(p, 'utf8'), '{"k":1}');
});

test('contentHash is stable sha256 hex', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.match(contentHash('abc'), /^[0-9a-f]{64}$/);
});
