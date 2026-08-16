import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { locateDeepModelRouter } from '../scripts/lib/locate-deep-model-router.mjs';
import {
  buildRoutingRecord,
  mayRecordInProgress,
  shouldAttachRouting,
  translateRouteOutcome,
} from '../scripts/lib/router-adapter.mjs';

const ROUTER_CLI = '/Users/sungmin/Dev/claude-plugins/deep-model-router/skills/model-router/scripts/route_task.py';
const POLICY_A = 'a'.repeat(64);
const POLICY_B = 'b'.repeat(64);

function decision(overrides = {}) {
  return {
    route_schema_version: 1,
    router_plugin_version: '1.0.0',
    policy_sha256: POLICY_A,
    effective_policy: {
      minimum_capability_tier: null,
      minimum_effort: null,
      minimum_reviewers: null,
      minimum_provider_families: null,
      allowed_families: null,
    },
    selected_model: 'claude-sonnet-5',
    selected_effort_native: 'high',
    risk_band: 'MEDIUM',
    terminal: null,
    ...overrides,
  };
}

function outcome(partial) {
  return translateRouteOutcome(partial);
}

test('locator: DEEP_MODEL_ROUTER_CLI hits an injected route_task.py including a source checkout', () => {
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: ROUTER_CLI },
    home: mkdtempSync(join(tmpdir(), 'dl-loc-home-')),
  });
  assert.equal(found, resolve(ROUTER_CLI));
});

test('locator: DEEP_MODEL_ROUTER_ROOT wins after a missing CLI and does not require cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-loc-root-'));
  const cli = join(root, 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '#!/usr/bin/env python3\n');
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: root },
    home: mkdtempSync(join(tmpdir(), 'dl-loc-home-')),
  });
  assert.equal(found, resolve(cli));
});

test('locator: missing env and empty caches return null', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-miss-'));
  assert.equal(locateDeepModelRouter({ env: {}, home }), null);
});

test('locator: personal ~/.claude/skills/model-router symlink is rejected', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-skill-'));
  const personal = join(home, '.claude', 'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(personal), { recursive: true });
  writeFileSync(personal, '# personal\n');
  chmodSync(personal, 0o755);
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: personal },
    home,
  }), null);
});

test('locator: rejects a ../deep-model-router relative checkout path', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-rel-'));
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: '../deep-model-router/skills/model-router/scripts/route_task.py' },
    home,
    cwd: home,
  }), null);
});

test('locator: Claude cache prefers the highest semver and ignores a personal skill tree', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-cache-'));
  const low = join(home, '.claude', 'plugins', 'cache', 'suite', 'deep-model-router', '1.0.0',
    'skills', 'model-router', 'scripts', 'route_task.py');
  const high = join(home, '.claude', 'plugins', 'cache', 'suite', 'deep-model-router', '1.2.0',
    'skills', 'model-router', 'scripts', 'route_task.py');
  const personal = join(home, '.claude', 'skills', 'model-router', 'scripts', 'route_task.py');
  for (const p of [low, high, personal]) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '# cache\n');
  }
  const found = locateDeepModelRouter({ env: {}, home });
  assert.equal(found, resolve(high));
});

test('locator: Codex cache is used only when Claude cache has no route_task.py', () => {
  const home = mkdtempSync(join(tmpdir(), 'dl-loc-codex-'));
  const codex = join(home, '.codex', 'plugins', 'deep-model-router', '1.1.0',
    'skills', 'model-router', 'scripts', 'route_task.py');
  mkdirSync(dirname(codex), { recursive: true });
  writeFileSync(codex, '# codex\n');
  assert.equal(locateDeepModelRouter({ env: {}, home }), resolve(codex));
});

const EXIT_CASES = [
  { exit: 0, status: 'ok', dispatch_authorized: true, provenance: 'router', degrade_forbidden: false },
  { exit: 1, status: 'terminal', dispatch_authorized: false, provenance: 'local-fallback', degrade_forbidden: false },
  { exit: 2, status: 'invalid', dispatch_authorized: false, provenance: 'local-fallback', degrade_forbidden: false },
  { exit: 3, status: 'human_gate', dispatch_authorized: false, provenance: 'router', degrade_forbidden: true },
  { exit: 4, status: 'deferred_confirm', dispatch_authorized: true, provenance: 'router', degrade_forbidden: true },
  { exit: 5, status: 'internal', dispatch_authorized: false, provenance: 'local-fallback', degrade_forbidden: false },
];

for (const row of EXIT_CASES) {
  test(`adapter: exit ${row.exit} → status=${row.status} authorized=${row.dispatch_authorized}`, () => {
    const translated = outcome({
      exit: row.exit,
      stdout: JSON.stringify(decision({ risk_band: 'MEDIUM' })),
      stderr: '',
    });
    assert.equal(translated.status, row.status);
    assert.equal(translated.dispatch_authorized, row.dispatch_authorized);
    assert.equal(translated.routing_provenance, row.provenance);
    assert.equal(translated.degrade_forbidden, row.degrade_forbidden);
    assert.equal(translated.write_retry_forbidden, false);
    assert.equal(translated.risk_band, 'MEDIUM');
    assert.equal(translated.decision.selected_model, 'claude-sonnet-5');
  });
}

test('adapter: missing CLI / python3 / non-JSON / unsupported schema / digest mismatch / signal map to the exit-2 consumer path', () => {
  const cases = [
    outcome({ exit: 0, stdout: '', stderr: '', cliPath: false, python3Available: true }),
    outcome({ exit: 0, stdout: '', stderr: '', cliPath: ROUTER_CLI, python3Available: false }),
    outcome({ exit: 0, stdout: 'not-json', stderr: '' }),
    outcome({ exit: 0, stdout: JSON.stringify(decision({ route_schema_version: 2 })), stderr: '' }),
    outcome({
      exit: 0,
      stdout: JSON.stringify(decision({ policy_sha256: POLICY_B })),
      stderr: '',
      frozenDigest: POLICY_A,
    }),
    outcome({ exit: 0, stdout: JSON.stringify(decision()), stderr: '', processState: 'signaled' }),
  ];
  for (const translated of cases) {
    assert.equal(translated.dispatch_authorized, false, translated.degrade_reason);
    assert.ok(['invalid', 'unavailable', 'internal'].includes(translated.status), translated.status);
    assert.equal(translated.routing_provenance, 'local-fallback');
  }
});

test('adapter: spawn failure, permission, timeout, empty/truncated stdout, out-of-range exit are unauthorized', () => {
  const cases = [
    outcome({ processState: 'spawn_failed', stdout: '', stderr: 'ENOENT' }),
    outcome({ processState: 'permission_denied', stdout: '', stderr: 'EACCES' }),
    outcome({ processState: 'timeout', stdout: '', stderr: '' }),
    outcome({ exit: 0, stdout: '', stderr: '' }),
    outcome({ exit: 0, stdout: '{"route_schema_version":1,', stderr: '' }),
    outcome({ exit: 7, stdout: JSON.stringify(decision()), stderr: '' }),
    outcome({ exit: -1, stdout: JSON.stringify(decision()), stderr: '' }),
  ];
  for (const translated of cases) {
    assert.equal(translated.dispatch_authorized, false, translated.degrade_reason || translated.status);
    assert.ok(['unavailable', 'internal', 'invalid'].includes(translated.status), translated.status);
  }
});

test('adapter: TERMINATION_UNCONFIRMED sets the write-retry fence', () => {
  const fromState = outcome({
    processState: 'TERMINATION_UNCONFIRMED',
    stdout: JSON.stringify(decision()),
    stderr: '',
  });
  const fromStderr = outcome({
    exit: 0,
    stdout: JSON.stringify(decision()),
    stderr: 'dispatch_agent: TERMINATION_UNCONFIRMED after kill ladder',
  });
  for (const translated of [fromState, fromStderr]) {
    assert.equal(translated.dispatch_authorized, false);
    assert.equal(translated.write_retry_forbidden, true);
    assert.equal(translated.status, 'internal');
    assert.equal(mayRecordInProgress(translated), false);
  }
});

test('adapter: digest freeze accepts the first digest and rejects a later mismatch', () => {
  const first = outcome({ exit: 0, stdout: JSON.stringify(decision({ policy_sha256: POLICY_A })) });
  assert.equal(first.dispatch_authorized, true);
  const frozen = first.decision.policy_sha256;
  const same = outcome({
    exit: 0,
    stdout: JSON.stringify(decision({ policy_sha256: POLICY_A })),
    frozenDigest: frozen,
  });
  assert.equal(same.dispatch_authorized, true);
  const mismatch = outcome({
    exit: 0,
    stdout: JSON.stringify(decision({ policy_sha256: POLICY_B })),
    frozenDigest: frozen,
  });
  assert.equal(mismatch.dispatch_authorized, false);
  assert.equal(mismatch.status, 'invalid');
  assert.equal(mismatch.degrade_reason, 'digest-mismatch');
});

test('adapter: HIGH/CRITICAL failures must not advance in_progress; LOW/MEDIUM may degrade', () => {
  const highFail = outcome({
    exit: 1,
    stdout: JSON.stringify(decision({ risk_band: 'HIGH', terminal: 'HUMAN_REQUIRED', selected_model: null })),
  });
  const criticalFail = outcome({
    exit: 5,
    stdout: JSON.stringify(decision({ risk_band: 'CRITICAL' })),
  });
  const lowFail = outcome({
    exit: 1,
    stdout: JSON.stringify(decision({ risk_band: 'LOW', terminal: 'SUPPLY_EXHAUSTED', selected_model: null })),
  });
  const mediumMissing = outcome({
    exit: null,
    stdout: '',
    stderr: '',
    cliPath: false,
    localBand: 'MEDIUM',
  });
  assert.equal(mayRecordInProgress(highFail), false);
  assert.equal(mayRecordInProgress(criticalFail), false);
  assert.equal(shouldAttachRouting(highFail), false);
  assert.equal(mayRecordInProgress(lowFail), true);
  assert.equal(shouldAttachRouting(lowFail), false);
  assert.equal(mayRecordInProgress(mediumMissing), true);
  assert.equal(shouldAttachRouting(mediumMissing), false);
  const gate = outcome({ exit: 3, stdout: JSON.stringify(decision({ risk_band: 'LOW' })) });
  assert.equal(mayRecordInProgress(gate), false);
  assert.equal(gate.degrade_forbidden, true);
});

test('adapter: live DEEP_MODEL_ROUTER_CLI LOW route is dispatchable and freezes identity fields', () => {
  const cli = locateDeepModelRouter({
    env: { ...process.env, DEEP_MODEL_ROUTER_CLI: ROUTER_CLI },
    home: mkdtempSync(join(tmpdir(), 'dl-live-home-')),
  });
  assert.equal(cli, resolve(ROUTER_CLI));
  const dir = mkdtempSync(join(tmpdir(), 'dl-live-req-'));
  const request = {
    route_schema_version: 1,
    task_class: 'IMPLEMENTATION',
    complexity: 1,
    uncertainty: 1,
    blast_radius: 0,
    reversibility: 0,
    reasoning_centric: false,
    flags: [],
    runtime: 'claude_code',
  };
  const reqPath = join(dir, 'req.json');
  writeFileSync(reqPath, JSON.stringify(request));
  const spawned = spawnSync(process.env.PYTHON || 'python3', [cli, '--request-json', reqPath, '--format', 'json'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, DEEP_MODEL_ROUTER_CLI: ROUTER_CLI },
  });
  const translated = translateRouteOutcome({
    exit: spawned.status,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
  });
  assert.equal(translated.dispatch_authorized, true, spawned.stderr);
  assert.equal(translated.status, 'ok');
  assert.equal(translated.decision.route_schema_version, 1);
  assert.match(translated.decision.router_plugin_version, /^\d+\.\d+\.\d+/);
  assert.match(translated.decision.policy_sha256, /^[0-9a-f]{64}$/);
  const frozen = buildRoutingRecord(request, translated.decision);
  assert.deepEqual(Object.keys(frozen).sort(), [
    'decision', 'effective_policy', 'provenance', 'request',
    'selected_effort_native', 'selected_model',
  ].sort());
  assert.equal(frozen.provenance, 'router');
  assert.equal(frozen.selected_model, translated.decision.selected_model);
  assert.equal(frozen.decision.policy_sha256, translated.decision.policy_sha256);
});
