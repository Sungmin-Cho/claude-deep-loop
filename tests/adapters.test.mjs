import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.equal(d.kind, 'skill');
  assert.equal(d.role, 'maker');
  assert.equal(d.skill, 'deep-work:deep-work-orchestrator');
  assert.match(d.args, /auth-core/);
});

test('protocol dispatch descriptors are runtime-neutral and standalone alone declares maker-inline fallback', () => {
  for (const name of ['deep-work', 'superpowers']) {
    const protocol = loadProtocol(name);
    assert.equal(protocol.dispatch.kind, 'skill', name);
    assert.equal(protocol.dispatch.role, 'maker', name);
    assert.notEqual(protocol.dispatch.explicit_fallback, true, name);
  }
  const standalone = loadProtocol('standalone').dispatch;
  assert.equal(standalone.kind, 'inline');
  assert.equal(standalone.role, 'maker');
  assert.equal(standalone.explicit_fallback, true);
});

test('adapter checker descriptors are neutral and require an independent session', () => {
  const adapter = resolveAdapter('deep-work');
  const deepReview = adapter.checker({ point: 'implementation' }, { reviewer: 'deep-review-loop' });
  assert.equal(deepReview.kind, 'skill');
  assert.equal(deepReview.role, 'checker');
  assert.equal(deepReview.skill, 'deep-review:deep-review-loop');
  assert.equal(deepReview.requires_independent_session, true);

  const subagent = adapter.checker({ point: 'implementation' }, { reviewer: 'subagent-checker' });
  assert.equal(subagent.kind, 'agent');
  assert.equal(subagent.role, 'checker');
  assert.equal(subagent.agent_role, 'code-reviewer');
  assert.equal(subagent.requires_independent_session, true);
});

test('dispatch implementation sources contain no runtime-specific or inline checker fallback spellings', () => {
  const sources = [
    'protocols/deep-work.json',
    'protocols/superpowers.json',
    'protocols/standalone.json',
    'scripts/lib/adapters.mjs',
    'scripts/lib/review.mjs',
    'scripts/lib/episode.mjs',
    'scripts/lib/initrun.mjs',
    'scripts/deep-loop.mjs',
  ].map((path) => [path, readFileSync(join(process.cwd(), path), 'utf8')]);
  const forbidden = ['codex:' + 'rescue', 'Task(' + 'code-reviewer)', 'inline-' + 'review'];
  for (const [path, source] of sources) {
    for (const spelling of forbidden) assert.equal(source.includes(spelling), false, `${path}: ${spelling}`);
  }
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
