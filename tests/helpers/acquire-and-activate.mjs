import {
  acquireLease as acquireLeasePending,
  activateLease,
} from '../../scripts/lib/lease.mjs';

const TEST_ACTIVATION_TOKEN = 'MIGRATEDTESTACTIVATIONTOKEN';

// Consumer fixtures model a replacement session that continues after acquire. Keep the raw
// acquire API in the contract tests; every actual test consumer crosses t1 before proceeding.
export function acquireLease(root, runId, options) {
  const acquired = acquireLeasePending(root, runId, options);
  if (!acquired.proceed) return acquired;
  activateAcquiredLease(root, runId, options, acquired);
  return acquired;
}

export function activateAcquiredLease(root, runId, options, acquired) {
  const activated = activateLease(root, runId, {
    owner: options.owner,
    generation: acquired.generation,
    runtime: options.runtime,
    attemptId: options.attemptId,
    activationToken: TEST_ACTIVATION_TOKEN,
    now: options.now,
  });
  if (!activated.ok) {
    throw new Error(`TEST_ACTIVATION_FAILED: ${activated.reason}`);
  }
  return activated;
}
