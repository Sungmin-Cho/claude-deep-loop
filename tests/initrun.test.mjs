import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initRun, buildInitialLoop } from '../scripts/lib/initrun.mjs';
import { extendBudget, checkHardBudget } from '../scripts/lib/budget.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';

const CLI = fileURLToPath(new URL('../scripts/deep-loop.mjs', import.meta.url));

// Inject a no-signal env + no-op probe so detect-terminal deterministically yields launcher:'none'
// regardless of the developer's ambient terminal environment.
const noSignalEnv = {};
const noSignalPlatform = 'linux';
const noOpRun = () => ({ code: 1 });

function initCli(root, args) {
  return spawnSync(process.execPath, [CLI, 'init-run', '--goal', 'g', '--runtime', 'claude', ...args, '--project-root', root], { encoding: 'utf8' });
}

function initializedState(root, result) {
  assert.equal(result.status, 0, result.stderr);
  return readState(root, JSON.parse(result.stdout).run_id).data;
}

const OPEN_WORKSTREAM_SCOPE = {
  kind: 'workstream', workstream_id: null, bound_at_seq: null, terminal_event: null,
  closed_at: null, superseded_at: null,
};

test('buildInitialLoop autonomy defaults — interactive workstream session with a root epoch', () => {
  const loop = buildInitialLoop({ runtime: 'claude', runId: 'r2', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun });
  assert.equal(loop.schema_version, '0.4.0');
  assert.equal(loop.project.binding_generation, 1);
  assert.equal(loop.autonomy.spawn_style, 'interactive');
  assert.equal(loop.autonomy.continuation_policy, 'workstream-session');
  assert.deepEqual(loop.autonomy.milestone_predicate, ['bound_workstream_first_terminal']);
  assert.equal(loop.autonomy.attended_launch_approval, null);
  assert.equal(loop.session_chain.lease.takeover_kind, null);
  assert.deepEqual(loop.session_chain.sessions[0].scope, OPEN_WORKSTREAM_SCOPE);
  assert.ok(!loop.autonomy.unattended_detect.includes('non-tty'), `unattended_detect must not include 'non-tty': ${JSON.stringify(loop.autonomy.unattended_detect)}`);
  assert.ok(loop.autonomy.unattended_detect.includes('headless-invocation'), `unattended_detect must include 'headless-invocation': ${JSON.stringify(loop.autonomy.unattended_detect)}`);
  assert.equal(loop.autonomy.child_ready_timeout_sec, 75);
  assert.ok(!('allow_powershell_visible' in loop.autonomy), 'allow_powershell_visible gate removed (PowerShell auto-detects)');
  assert.ok(loop.session_spawn !== undefined && loop.session_spawn !== null, 'session_spawn must be a valid descriptor');
  assert.equal(loop.session_spawn.launcher, 'none');
  assert.equal(loop.session_spawn.reason, 'no-host-signal');  // detectTerminal result for linux/no-signals
  assert.equal(loop.session_spawn.detected_at, '2026-06-27T00:00:00.000Z');
});

test('buildInitialLoop records explicit claude and codex runtime', () => {
  for (const runtime of ['claude', 'codex']) {
    const loop = buildInitialLoop({ runtime, runId: `runtime-${runtime}`, goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun });
    assert.equal(loop.autonomy.session_runtime, runtime);
    assert.equal(loop.autonomy.runtime_source, 'skill-asserted');
    assert.equal(loop.autonomy.continuation_policy, 'workstream-session');
    assert.equal(loop.autonomy.spawn_style, 'interactive');
    assert.deepEqual(loop.session_chain.sessions[0].scope, OPEN_WORKSTREAM_SCOPE);
  }
});

test('native win32 WT initialization stays manual until a launcher is durably approved', () => {
  let processCalls = 0;
  const loop = buildInitialLoop({
    runtime: 'claude', runId: 'win32-unapproved', goal: 'g', recipe: {},
    now: new Date('2026-07-12T00:00:00Z'), env: { WT_SESSION: 'session-1' }, platform: 'win32',
    run: () => { processCalls++; return { code: 0 }; },
  });

  assert.deepEqual(loop.autonomy.launcher_executable_approvals, { wt: null, powershell: null, tmux: null });
  assert.equal(loop.session_spawn.launcher, 'none');
  assert.equal(loop.session_spawn.reason, 'windows-terminal-unverified');
  assert.equal(loop.session_spawn.reachable, false);
  assert.equal(loop.session_spawn.fallback, 'launch-command-file');
  assert.equal(processCalls, 0, 'unapproved launcher code and PATH probes must remain unreachable');
});

test('explicit codex runtime wins when both Claude and Codex markers exist', () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-py', CODEX_THREAD_ID: 'thread-1' };
  const loop = buildInitialLoop({ runtime: 'codex', runId: 'runtime-codex', goal: 'g', recipe: {}, now: new Date('2026-06-27T00:00:00Z'), env, platform: noSignalPlatform, run: noOpRun });
  assert.equal(loop.autonomy.session_runtime, 'codex');
  assert.equal(loop.autonomy.runtime_source, 'skill-asserted');
});

test('initRun creates state, current pointer, valid schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T15:42:00Z') });
  assert.ok(existsSync(join(runDir(root, runId), 'loop.json')));
  assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), runId);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.routing.protocol, 'deep-work');
  assert.equal(data.recipe.id, 'robust-implementation');
  assert.deepEqual(data.review.points, ['design', 'plan', 'implementation']);
  assert.equal(data.autonomy.tier, 'recommend'); // 기본
  assert.equal(data.session_chain.lease.owner_run_id, runId);
});

test('initial token budget keeps the 4M default and accepts a human-approved 10M absolute seed', () => {
  const defaultLoop = buildInitialLoop({
    runtime: 'claude', runId: 'default-budget', goal: 'g', recipe: {},
    now: new Date('2026-08-14T00:00:00Z'), env: noSignalEnv,
    platform: noSignalPlatform, run: noOpRun,
  });
  assert.deepEqual({
    total: defaultLoop.budget.total,
    spent: defaultLoop.budget.spent,
    tokens_total: defaultLoop.budget.tokens_total,
    tokens_spent: defaultLoop.budget.tokens_spent,
    max_wallclock_sec: defaultLoop.budget.max_wallclock_sec,
    soft_stop_ratio: defaultLoop.budget.soft_stop_ratio,
    hard_stop_ratio: defaultLoop.budget.hard_stop_ratio,
  }, {
    total: 200,
    spent: 0,
    tokens_total: 4_000_000,
    tokens_spent: 0,
    max_wallclock_sec: 86_400,
    soft_stop_ratio: 0.8,
    hard_stop_ratio: 1,
  });

  const apiRoot = mkdtempSync(join(tmpdir(), 'dl-init-budget-api-'));
  const direct = initRun(apiRoot, {
    runtime: 'claude', goal: 'g', budgetTokens: 10_000_000,
    now: new Date('2026-08-14T00:00:00Z'), env: noSignalEnv,
    platform: noSignalPlatform, run: noOpRun,
  });
  assert.equal(direct.loop.budget.tokens_total, 10_000_000);
  assert.equal(direct.loop.budget.tokens_spent, 0);
  assert.equal(direct.loop.budget.spent, 0);
  assert.equal(existsSync(join(runDir(apiRoot, direct.runId), 'event-log.jsonl')), false,
    'an initial seed must not masquerade as a budget extension or cost event');

  const cliRoot = mkdtempSync(join(tmpdir(), 'dl-init-budget-cli-'));
  const cli = initializedState(cliRoot, initCli(cliRoot, ['--budget-tokens', '10000000']));
  assert.equal(cli.budget.tokens_total, 10_000_000);
  assert.equal(cli.budget.tokens_spent, 0);
  assert.equal(cli.budget.total, 200);
  assert.equal(cli.budget.spent, 0);
});

test('init-run rejects invalid direct and CLI token seeds before durable creation', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10000000']) {
    const root = mkdtempSync(join(tmpdir(), 'dl-init-budget-api-invalid-'));
    assert.throws(() => initRun(root, {
      runtime: 'claude', goal: 'g', budgetTokens: value,
      now: new Date('2026-08-14T00:00:00Z'), env: noSignalEnv,
      platform: noSignalPlatform, run: noOpRun,
    }), /INITIAL_BUDGET_TOKENS_INVALID/, String(value));
    assert.equal(existsSync(join(root, '.deep-loop')), false, String(value));
  }

  for (const value of ['0', '-1', '1.5', '1e7', '9007199254740992', 'ten-million']) {
    const root = mkdtempSync(join(tmpdir(), 'dl-init-budget-cli-invalid-'));
    const result = initCli(root, ['--budget-tokens', value]);
    assert.equal(result.status, 1, `${value}: ${result.stderr}`);
    assert.match(result.stderr, /INITIAL_BUDGET_TOKENS_INVALID/);
    assert.equal(existsSync(join(root, '.deep-loop')), false, value);
  }
});

test('init-run closes value-less, duplicate, unknown, and positional budget grammar before durable creation', () => {
  const cases = [
    ['bare', ['--budget-tokens']],
    ['empty equals', ['--budget-tokens=']],
    ['empty argv', ['--budget-tokens', '']],
    ['valid then invalid duplicate', ['--budget-tokens', '10000000', '--budget-tokens', '1e7']],
    ['invalid then valid duplicate', ['--budget-tokens', '1e7', '--budget-tokens', '10000000']],
    ['unknown flag', ['--budegt-tokens', '10000000']],
    ['positional', ['unexpected-positional']],
  ];
  for (const [label, args] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'dl-init-budget-cli-usage-'));
    const result = initCli(root, args);
    assert.equal(result.status, 2, `${label}: ${result.stderr}`);
    assert.equal(existsSync(join(root, '.deep-loop')), false, label);
  }
});

test('a hard-stopped custom token seed resumes only through an additive confirmed extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-init-budget-resume-'));
  const now = Date.parse('2026-08-14T00:00:00Z');
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', budgetTokens: 10_000_000, now: new Date(now),
    env: noSignalEnv, platform: noSignalPlatform, run: noOpRun,
  });
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.pause_reason = 'gate:tokens-hard-stop';
  data.budget.tokens_spent = 10_000_000;
  writeState(root, runId, data);
  assert.deepEqual(checkHardBudget(data, { now }), { blocked: true, reason: 'tokens-hard-stop' });

  assert.deepEqual(extendBudget(root, runId, {
    tokens: 1_000_000,
    reason: 'human approved one bounded token extension',
    confirm: true,
    fence: { owner: runId, generation: 1 },
    now,
  }), { ok: true, status: 'running' });
  const after = readState(root, runId).data;
  assert.equal(after.budget.tokens_total, 11_000_000);
  assert.equal(after.budget.tokens_spent, 10_000_000);
  assert.equal(after.budget.spent, 0);
  assert.equal(after.status, 'running');
  assert.equal(after.pause_reason, null);
  assert.deepEqual(checkHardBudget(after, { now }), { blocked: false, reason: null });
  const events = readLines(root, runId);
  assert.deepEqual(events.map(event => [event.type, event.data.tokens]), [
    ['budget-extended', 1_000_000],
  ]);
});

test('new runs persist the activation deadline config and explicit null lease marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-activation-schema-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-08-05T00:00:00Z'),
    env: noSignalEnv, platform: noSignalPlatform, run: noOpRun,
  });
  const { data } = readState(root, runId);
  const lease = data.session_chain.lease;
  assert.equal(data.session_chain.activation_deadline_sec, 900);
  assert.equal(Object.hasOwn(lease, 'activation_deadline_at'), true);
  assert.equal(lease.activation_deadline_at, null);
  assert.equal(lease.state === 'active' && !Object.hasOwn(lease, 'activation_deadline_at'), false);
});

test('fresh initRun output passes the public validate CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-activation-validate-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-08-05T00:00:00Z'),
    env: noSignalEnv, platform: noSignalPlatform, run: noOpRun,
  });
  const { data } = readState(root, runId);
  assert.equal(data.session_chain.activation_deadline_sec, 900);
  assert.equal(data.session_chain.lease.activation_deadline_at, null);
  const result = spawnSync(process.execPath, [CLI, 'validate', '--project-root', root, '--run-id', runId], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

// ── C2: object-shape initial reviewer selection — routes on present (installed‖initialized) ───
test('C2: initRun review.reviewer routes on present (object shape)', () => {
  const r1 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { runtime: 'claude', goal: 'g', detected: { 'deep-review': { present: false } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r1.loop.review.reviewer, 'subagent-checker');
  const r2 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { runtime: 'claude', goal: 'g', detected: { 'deep-review': { present: true } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r2.loop.review.reviewer, 'deep-review-loop');
  // installed-but-uninitialized (original Problem C) → present:true → deep-review-loop
  const r3 = initRun(mkdtempSync(join(tmpdir(), 'dl-c2-')), { runtime: 'claude', goal: 'g', detected: { 'deep-review': { installed: true, initialized: false, present: true } }, now: new Date('2026-06-24T00:00:00Z') });
  assert.equal(r3.loop.review.reviewer, 'deep-review-loop');
});

test('initRun seeds autonomy.session_model/effort when provided (WS1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ir-'));
  const { loop } = initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }), model: 'claude-opus-4-8[1m]', effort: 'xhigh' });
  assert.equal(loop.autonomy.session_model, 'claude-opus-4-8[1m]');
  assert.equal(loop.autonomy.session_effort, 'xhigh');
});

test('initRun omits session_model/effort when not provided (backward compat)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ir-'));
  const { loop } = initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }) });
  assert.equal(loop.autonomy.session_model, undefined);
  assert.equal(loop.autonomy.session_effort, undefined);
});

test('CLI init-run accepts empty, partial, and complete session-profile JSON', () => {
  for (const [profile, expected] of [
    ['{}', {}],
    ['{"model":"opus"}', { session_model: 'opus' }],
    ['{"model":"opus","effort":"xhigh"}', { session_model: 'opus', session_effort: 'xhigh' }],
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'dl-init-profile-'));
    const data = initializedState(root, initCli(root, ['--session-profile', profile]));
    assert.equal(data.autonomy.session_model, expected.session_model);
    assert.equal(data.autonomy.session_effort, expected.session_effort);
  }
});

test('CLI init-run session-profile matches legacy seed and keeps independent Codex validation', () => {
  const legacyRoot = mkdtempSync(join(tmpdir(), 'dl-init-legacy-'));
  const jsonRoot = mkdtempSync(join(tmpdir(), 'dl-init-json-'));
  const legacy = initializedState(legacyRoot, initCli(legacyRoot, ['--model', 'opus', '--effort', 'xhigh']));
  const json = initializedState(jsonRoot, initCli(jsonRoot, ['--session-profile', '{"model":"opus","effort":"xhigh"}']));
  assert.deepEqual(
    { model: json.autonomy.session_model, effort: json.autonomy.session_effort },
    { model: legacy.autonomy.session_model, effort: legacy.autonomy.session_effort },
  );

  const codexRoot = mkdtempSync(join(tmpdir(), 'dl-init-codex-max-'));
  const result = spawnSync(process.execPath, [
    CLI, 'init-run', '--goal', 'g', '--runtime', 'codex',
    '--session-profile', '{"model":"gpt-5.6-sol","effort":"max"}',
    '--project-root', codexRoot,
  ], { encoding: 'utf8' });
  const codex = initializedState(codexRoot, result);
  assert.equal(codex.autonomy.session_model, 'gpt-5.6-sol');
  assert.equal(codex.autonomy.session_effort, 'max');
});

test('CLI init-run classifies malformed session-profile JSON and invalid shapes as exit 1', () => {
  const invalid = [
    '{', 'null', '[]', '"opus"',
    '{"unknown":"x"}', '{"model":null}', '{"model":1}', '{"model":""}', '{"effort":""}',
  ];
  for (const profile of invalid) {
    const root = mkdtempSync(join(tmpdir(), 'dl-init-profile-invalid-'));
    const result = initCli(root, ['--session-profile', profile]);
    assert.equal(result.status, 1, `${profile}: ${result.stderr}`);
    assert.match(result.stderr, /INVALID_SESSION_PROFILE/);
    assert.equal(existsSync(join(root, '.deep-loop')), false);
  }
});

test('CLI init-run classifies every value-less session-profile spelling and legacy mixing as usage', () => {
  const cases = [
    ['--session-profile'],
    ['--session-profile='],
    ['--session-profile', ''],
    ['--session-profile', '{}', '--model', 'opus'],
    ['--session-profile', '{}', '--effort', 'high'],
  ];
  for (const args of cases) {
    const root = mkdtempSync(join(tmpdir(), 'dl-init-profile-usage-'));
    const result = initCli(root, args);
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stderr}`);
    assert.equal(existsSync(join(root, '.deep-loop')), false);
  }
});

test('initRun rejects invalid effort (WS1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ir-'));
  assert.throws(() => initRun(root, { runtime: 'claude', goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), env: {}, platform: 'linux', run: () => ({ code: 1 }), effort: 'ultra' }), /INVALID_EFFORT/);
});

test('initRun rejects missing and invalid runtime before creating files', () => {
  for (const [label, options] of [
    ['missing', {}],
    ['invalid', { runtime: 'other' }],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `dl-runtime-${label}-`));
    assert.throws(() => initRun(root, { goal: 'g', detected: {}, now: new Date('2026-07-02T00:00:00Z'), ...options }), /INVALID_RUNTIME/);
    assert.equal(existsSync(join(root, '.deep-loop')), false, `${label} runtime must not create .deep-loop`);
  }
});

test('new runs reject the legacy standalone reviewer before creating durable state', () => {
  assert.throws(
    () => buildInitialLoop({ runtime: 'claude', runId: 'legacy-reviewer', goal: 'g', recipe: {}, review: { reviewer: 'standalone' }, now: new Date('2026-07-11T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun }),
    /REVIEWER_STANDALONE_INVALID/
  );
  const root = mkdtempSync(join(tmpdir(), 'dl-legacy-reviewer-'));
  assert.throws(
    () => initRun(root, { runtime: 'claude', goal: 'g', review: { reviewer: 'standalone' }, now: new Date('2026-07-11T00:00:00Z'), env: noSignalEnv, platform: noSignalPlatform, run: noOpRun }),
    /REVIEWER_STANDALONE_INVALID/
  );
  assert.equal(existsSync(join(root, '.deep-loop')), false);
});
