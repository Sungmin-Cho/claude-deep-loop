import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrap } from '../scripts/lib/envelope.mjs';
import { loadProtocol, resolveAdapter, guardTierProtocol } from '../scripts/lib/adapters.mjs';

test('loadProtocol reads declarative protocol', () => {
  assert.equal(loadProtocol('deep-work').protocol, 'deep-work');
  assert.equal(loadProtocol('standalone').dispatch.kind, 'inline');
});

test('dispatch verb fills template + returns descriptor (no call)', () => {
  const a = resolveAdapter('deep-work');
  const d = a.dispatch({ task: 'auth-core' });
  assert.equal(d.kind, 'invoke_skill');
  assert.equal(d.skill, 'deep-work:deep-work-orchestrator');
  assert.match(d.args, /auth-core/);
});

test('awaitResult returns poll descriptor with concrete path', () => {
  const a = resolveAdapter('deep-work');
  const d = a.awaitResult({ task: 'auth-core' });
  assert.equal(d.kind, 'poll_file');
  assert.match(d.path, /\.deep-work\/auth-core\/session-receipt\.json$/);
});

test('readArtifacts applies identity guard: null on mismatch, payload on match', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const dir = join(root, '.deep-work', 'auth-core'); mkdirSync(dir, { recursive: true });
  const p = join(dir, 'session-receipt.json');
  writeFileSync(p, JSON.stringify(wrap({ producer: 'deep-work', artifact_kind: 'session-receipt', schema: { name: 'session-receipt', version: '1.0' }, run_id: 'X', payload: { outcome: 'done' } })));
  const a = resolveAdapter('deep-work');
  const ok = a.readArtifacts({ root, task: 'auth-core' });
  assert.equal(ok.receipt.payload.outcome, 'done');
  // wrong producer → guard returns null receipt + no throw
  writeFileSync(p, JSON.stringify(wrap({ producer: 'evil', artifact_kind: 'session-receipt', schema: { name: 'session-receipt', version: '1.0' }, run_id: 'X', payload: {} })));
  assert.equal(a.readArtifacts({ root, task: 'auth-core' }).receipt, null);
});

// Codex r4 🟡1: superpowers(producer:null) 는 markdown 을 JSON.parse 하지 않고 원문 receipt 로 반환.
test('superpowers readArtifacts returns raw markdown (producer:null)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const dir = join(root, 'docs', 'superpowers', 'plans'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth-core.md'), '# Plan\n\nbody');
  const r = resolveAdapter('superpowers').readArtifacts({ root, task: 'auth-core' });
  assert.equal(r.receipt.kind, 'raw');
  assert.match(r.receipt.content, /# Plan/);
  assert.equal(r.proofs.length, 1);
});

test('guardTierProtocol blocks read-only superpowers implementer dispatch', () => {
  assert.equal(guardTierProtocol('read-only', 'superpowers', 'then').ok, false);
  assert.equal(guardTierProtocol('recommend', 'superpowers', 'then').ok, true);
  assert.equal(guardTierProtocol('read-only', 'deep-work', 'awaitResult').ok, true);
});
