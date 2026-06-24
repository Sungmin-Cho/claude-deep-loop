import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBreaker } from '../scripts/lib/breaker.mjs';

test('not tripped under threshold', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 2 } }).tripped, false);
});
test('tripped at 3 consecutive REQUEST_CHANGES', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 3 } }).tripped, true);
});
test('explicit tripped flag honored', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: true, consecutive_request_changes: 0 } }).tripped, true);
});
