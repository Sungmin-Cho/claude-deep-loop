import { buildInitialLoop, resolveInitialReview } from '../../scripts/lib/initrun.mjs';
import { commitPreparedInit } from '../../scripts/lib/init-transaction.mjs';

const [root, attempt, previous, requestDigest, point] = process.argv.slice(2);
const CRASH_POINT = /^(?:(?:pending|events|hash|loop|current)-(?:before-write|after-write|before-rename|after-rename)|pending-delete-(?:before|after))$/;
if (!CRASH_POINT.test(point || '') || process.env.NODE_ENV !== 'test'
    || process.env.DEEP_LOOP_TEST_CRASH_AT !== point) process.exit(64);
const request = { runtime: 'codex', goal: 'g', protocol: 'standalone',
  recipe: { id: 'r', name: 'r', reason: 'test' }, review: null,
  detected: {}, git: {}, sessionSpawn: {},
  consent: { mode: 'manual', authority: 'default-manual', confirmed_at: null, revoked_at: null },
  observationDigest: 'NONE',
  enumProfile: { kind: 'codex-cli', source: 'codex-cli-host', capabilities: [] } };
const deps = {
  canonicalRoot: () => root,
  resolveRouting: value => ({ protocol: value.protocol, recipe: value.recipe }),
  resolveReview: value => resolveInitialReview(value.review, value.detected),
  normalizePlugins: value => value,
  normalizeGit: value => ({ git: !!value.head, head: value.head ?? null,
    branch: value.branch ?? null, dirty: !!value.dirty }),
  normalizeSessionSpawn: value => value, kernelCwd: () => root,
  normalizeEnumProfile: value => ({ ...value, capabilities: [...value.capabilities].sort() }),
  assertRoot: () => ({ ok: true }), buildLoop: buildInitialLoop,
  pid: process.pid, nonce: () => String(process.pid).padStart(16, '0'),
  tempNonce: () => 'temp000000000000',
  now: () => Date.parse('2030-01-01T00:00:00.000Z'),
  probePidIdentity: () => 'alive',
};
const prepared = { ok: true, outcome: 'prepared', attempt_id: attempt,
  previous_current_digest: previous, expected_request_digest: requestDigest,
  expected_observation_digest: 'NONE' };
commitPreparedInit(root, { prepared, request, observation: null }, deps);
process.exit(70);
