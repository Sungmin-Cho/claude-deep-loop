import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_RUNTIMES,
  validateSessionRuntime,
  sessionRuntime,
  runtimeFence,
} from '../scripts/lib/runtime.mjs';
import { classifyPatch } from '../scripts/lib/state.mjs';

test('session runtime allowlist is immutable and validation returns the asserted enum', () => {
  assert.deepEqual(SESSION_RUNTIMES, ['claude', 'codex']);
  assert.equal(Object.isFrozen(SESSION_RUNTIMES), true);
  assert.equal(validateSessionRuntime('claude'), 'claude');
  assert.equal(validateSessionRuntime('codex'), 'codex');
  assert.throws(() => validateSessionRuntime(undefined), /INVALID_RUNTIME/);
  assert.throws(() => validateSessionRuntime('other'), /INVALID_RUNTIME/);
});

test('sessionRuntime maps state with both runtime fields absent to legacy claude', () => {
  assert.equal(sessionRuntime({ autonomy: {} }), 'claude');
  assert.equal(sessionRuntime({}), 'claude');
});

test('sessionRuntime rejects runtime_source without session_runtime', () => {
  assert.throws(
    () => sessionRuntime({ autonomy: { runtime_source: 'skill-asserted' } }),
    /INVALID_RUNTIME_STATE/,
  );
});

test('sessionRuntime rejects explicit runtime with missing or wrong source', () => {
  assert.throws(
    () => sessionRuntime({ autonomy: { session_runtime: 'codex' } }),
    /INVALID_RUNTIME_STATE/,
  );
  assert.throws(
    () => sessionRuntime({ autonomy: { session_runtime: 'codex', runtime_source: 'inferred' } }),
    /INVALID_RUNTIME_STATE/,
  );
});

test('sessionRuntime accepts explicit runtime with skill-asserted source', () => {
  assert.equal(sessionRuntime({ autonomy: { session_runtime: 'codex', runtime_source: 'skill-asserted' } }), 'codex');
});

test('runtimeFence returns the audited structured match and mismatch results', () => {
  const loop = { autonomy: { session_runtime: 'codex', runtime_source: 'skill-asserted' } };
  assert.deepEqual(runtimeFence(loop, 'codex'), { ok: true, runtime: 'codex' });
  assert.deepEqual(runtimeFence(loop, 'claude'), {
    ok: false,
    reason: 'RUNTIME_FENCED',
    expected: 'codex',
    actual: 'claude',
  });
  assert.throws(() => runtimeFence(loop, 'other'), /INVALID_RUNTIME/);
});

test('autonomy.session_runtime remains forbidden to generic state patch', () => {
  assert.equal(classifyPatch('autonomy.session_runtime', 'codex'), 'forbid');
});
