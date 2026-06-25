import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlessSpawn, parseUsage } from '../scripts/lib/spawn-driver.mjs';

const okRun = () => ({ code: 0, stdout: '{"num_turns":3,"usage":{"input_tokens":10}}', stderr: '', timedOut: false });
const timeoutRun = () => ({ code: null, stdout: '', stderr: '', timedOut: true });
const unmeasurableRun = () => ({ code: 0, stdout: 'done, no usage here', stderr: '', timedOut: false });
const costOnlyRun = () => ({ code: 0, stdout: '{"total_cost_usd":0.12}', stderr: '', timedOut: false });   // Codex r2 sf-4

test('headlessSpawn ok when usage measurable', () => {
  const r = headlessSpawn('claude -p x', { run: okRun });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.usage.num_turns) || Number.isFinite(r.usage.tokens));
});

test('headlessSpawn fail-closed on timeout', () => {
  const r = headlessSpawn('claude -p x', { run: timeoutRun });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
});

test('headlessSpawn fail-closed when usage unmeasurable', () => {
  const r = headlessSpawn('claude -p x', { run: unmeasurableRun });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unmeasurable/);
});

// Codex r2 sf-4: cost-only JSON 에는 enforceable metric(turns/tokens)이 없으므로 fail-closed.
test('headlessSpawn fail-closed when only total_cost_usd is present', () => {
  const r = headlessSpawn('claude -p x', { run: costOnlyRun });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unmeasurable/);
});

test('parseUsage requires a finite enforceable metric', () => {
  assert.equal(parseUsage('{"num_turns":2}').num_turns, 2);
  assert.ok(parseUsage('{"usage":{"input_tokens":5,"output_tokens":7}}').tokens === 12);
  assert.equal(parseUsage('{"total_cost_usd":0.12}'), null);   // cost-only → 측정 불가
  assert.equal(parseUsage('nothing'), null);
});

// detachedSpawn was removed in Fix 2 (precompact-handoff.mjs is now emit-only; measured resume via cron driveHeadless).
