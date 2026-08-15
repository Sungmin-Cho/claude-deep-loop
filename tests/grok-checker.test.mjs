import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGrokHeadlessEntry } from '../scripts/lib/grok-runtime.mjs';
import { buildGrokCheckerPrompt, runIndependentGrokChecker } from '../scripts/lib/grok-checker.mjs';
import { runDualCheckerProcesses } from '../scripts/lib/dual-checker.mjs';

const HOST_ECHO_SESSION = '11111111-1111-4111-8111-111111111111';
const PROVIDER_SESSION = '22222222-2222-4222-8222-222222222222';

test('Grok checker entry is shell-free, one-turn, exact-model, structured, and feature-disabled', () => {
  const entry = buildGrokHeadlessEntry({
    executable: '/opt/grok/bin/grok',
    projectRoot: '/repo',
    prompt: 'review',
    schema: { type: 'object', additionalProperties: false },
    sessionId: HOST_ECHO_SESSION,
    model: 'grok-4.6',
    effort: 'xhigh',
    env: { PATH: '/usr/bin' },
  });
  assert.equal(entry.bin, '/opt/grok/bin/grok');
  assert.equal(entry.cwd, '/repo');
  assert.equal(entry.shell, false);
  assert.equal(entry.usageOutputKind, 'grok-json');
  assert.equal(entry.captureFinalMessage, true);
  assert.equal(Object.hasOwn(entry, 'trustedSessionId'), false);
  assert.equal(entry.argv.includes('--session-id'), false);
  for (const pair of [
    ['--model', 'grok-4.6'], ['--effort', 'xhigh'],
    ['--output-format', 'json'], ['--max-turns', '1'], ['--sandbox', 'read-only'],
  ]) {
    const index = entry.argv.indexOf(pair[0]);
    assert.deepEqual(entry.argv.slice(index, index + 2), pair);
  }
  for (const flag of [
    '--no-auto-update', '--verbatim', '--no-plan', '--no-subagents', '--no-memory',
    '--disable-web-search',
  ]) assert.ok(entry.argv.includes(flag), flag);
  assert.ok(entry.argv.includes('--json-schema'));
  assert.equal(entry.argv.at(-1), 'review');
});

test('Grok checker requires provider-emitted session/model identity and returns bounded v2 JSON', () => {
  const contract = {
    schema_version: '2.0', aggregation_id: 'aggregation-1', reviewer_id: 'grok-review',
    reviewer_adapter: 'grok-checker', provider_id: 'xai-grok', model_id: 'grok-4.6',
    checker_episode_id: '002-deep-review', target_maker: '001-deep-work',
    attempt_id: 'attempt-grok', source_claim_sha256: 'a'.repeat(64), artifacts: [],
  };
  assert.match(buildGrokCheckerPrompt({ ...contract, checker_skill_path: '/capture/SKILL.md' }), /Immutable review contract/);
  const final = Buffer.from(JSON.stringify({
    ...contract,
    session_id: HOST_ECHO_SESSION,
    verdict: 'APPROVE',
    report_body: 'APPROVE',
  }));
  const result = runIndependentGrokChecker({
    executable: '/opt/grok/bin/grok', projectRoot: '/repo', checkerSkillPath: '/capture/SKILL.md',
    outputSchema: { type: 'object' }, contract, env: {}, model: 'grok-4.6', effort: 'xhigh',
    sessionId: HOST_ECHO_SESSION, timeoutMs: 100,
    runProcess: () => ({
      ok: true,
      usage: { num_turns: 1, input_tokens: 7, output_tokens: 3, tokens: 10 },
      finalMessage: final,
      providerIdentity: { session_id: PROVIDER_SESSION, model_id: 'grok-4.6' },
      process_streams: {
        stdout: { sha256: 'b'.repeat(64), byte_count: final.length, truncated: false },
        stderr: { sha256: 'c'.repeat(64), byte_count: 0, truncated: false },
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.providerIdentity, { session_id: PROVIDER_SESSION, model_id: 'grok-4.6' });
  assert.equal(result.finalMessage.equals(final), true);

  const mismatch = runIndependentGrokChecker({
    executable: '/opt/grok/bin/grok', projectRoot: '/repo', checkerSkillPath: '/capture/SKILL.md',
    outputSchema: { type: 'object' }, contract, env: {}, model: 'grok-4.6', effort: 'xhigh',
    sessionId: HOST_ECHO_SESSION, timeoutMs: 100,
    runProcess: () => ({
      ok: true,
      usage: { num_turns: 1, input_tokens: 7, output_tokens: 3, tokens: 10 },
      finalMessage: final,
      providerIdentity: { session_id: PROVIDER_SESSION, model_id: 'grok-other' },
    }),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'checker-provider-identity-mismatch');
});

test('dual process runner starts both independent transports before observing either result', async () => {
  const started = [];
  const resolvers = [];
  const pending = runDualCheckerProcesses([
    { bin: '/codex', argv: [], shell: false, transportId: 'codex' },
    { bin: '/grok', argv: [], shell: false, transportId: 'grok' },
  ], {
    runProcess: entry => new Promise(resolve => {
      started.push(entry.transportId);
      resolvers.push(() => resolve({ ok: true, transportId: entry.transportId }));
    }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['codex', 'grok']);
  resolvers.forEach(resolve => resolve());
  assert.deepEqual(await pending, [
    { ok: true, transportId: 'codex' },
    { ok: true, transportId: 'grok' },
  ]);
});
