import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { appHostTaskCwdDigest } from '../scripts/lib/host-surface.mjs';
import { seedVerifiedAppHistories } from './fixtures/verified-app-run.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
function run(root, args) { return execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' }); }
function runFail(root, args) { try { run(root, args); return 0; } catch (e) { return e.status; } }
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-sf-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', protocol: 'deep-work', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('fixed init manual-enums grammar carries prepared authority through retry workers', () => {
  const cli = readFileSync(join(process.cwd(), 'scripts', 'deep-loop.mjs'), 'utf8');
  const worker = readFileSync(join(process.cwd(), 'tests', 'helpers',
    'fixed-init-crash-worker.mjs'), 'utf8');
  for (const token of ["'prepared-authority'", 'exactPreparedAuthority',
    'prepared_authority: authority.value', 'authority.digest']) assert.ok(cli.includes(token), token);
  for (const token of ['authorityJson', 'prepared_authority: preparedAuthority']) {
    assert.ok(worker.includes(token), token);
  }
  assert.doesNotMatch(worker, /capturePreparedAuthority|prepareFixedInitialization/,
    'retry/crash worker must never recapture or prepare a replacement authority');
});

test('fixed init skillface is strict explicit-root READY transport with no fallback', () => {
  const cli = readFileSync(join(process.cwd(), 'scripts', 'deep-loop.mjs'), 'utf8');
  assert.match(cli, /async function dispatchFixedInit\(argv\)/);
  assert.match(cli, /explicitFixedRoot\(f\)/);
  assert.match(cli, /readStructuredJson\(\{ mode, purpose: 'init-commit'/);
  assert.match(cli, /fixedVerb \|\| hasFixedInitOnlyFlag\(a\)/);
  const fixedBody = cli.slice(cli.indexOf('async function dispatchFixedInit(argv)'),
    cli.indexOf('const initRunHandler'));
  assert.doesNotMatch(fixedBody, /rootOf\(|runIdOf\(/,
    'fixed dispatcher must not regain implicit cwd/current fallback');
});

test('app-task CLI exposes only the literal public forms without dynamic route authority', () => {
  const attempt = '01JAPPTASK0000000000000000';
  const childOwner = '01JAPPCHD00000000000000010';
  const forms = fixture => [
    ['handoff emit', ['handoff', 'emit', '--app-intent', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1',
      '--reason', 'bounded-reason', '--trigger', 'bounded-trigger'], undefined],
    ['confirm', ['app-task', 'confirm', '--project-root', fixture.root, '--run-id', fixture.runId,
      '--owner', fixture.runId, '--generation', '1', '--attempt', attempt,
      '--stdin-mode', 'pipe-open-noecho', '--receipt-stdin'], 'thread\n'],
    ['ordinary fail', ['app-task', 'fail', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1',
      '--attempt', attempt, '--code', 'host-call-failed'], undefined],
    ['receipt fail', ['app-task', 'fail', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1',
      '--attempt', attempt, '--code', 'message-unconfirmed', '--stdin-mode',
      'pipe-open-noecho', '--receipt-stdin'], 'thread\n'],
    ['revoke', ['app-task', 'revoke', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1',
      '--runtime', 'codex'], undefined],
    ['sweep', ['app-task', 'sweep-unconfirmed', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1',
      '--attempt', attempt], undefined],
    ['status', ['app-task', 'status', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--attempt', attempt], undefined],
    ['await', ['app-task', 'await', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--owner', fixture.runId, '--generation', '1',
      '--attempt', attempt], undefined],
    ['acquire', ['app-task', 'acquire', '--project-root', fixture.root,
      '--run-id', fixture.runId, '--owner', childOwner, '--generation', '1',
      '--runtime', 'codex', '--attempt', attempt, '--stdin-mode', 'pipe-open-noecho',
      '--observation-stdin'], '{}\n'],
  ];
  for (let index = 0; index < 9; index += 1) {
    const fixture = seed();
    const [label, args, input] = forms(fixture)[index];
    const accepted = spawnSync(process.execPath, [CLI, ...args], {
      cwd: fixture.root, encoding: 'utf8', shell: false, ...(input ? { input } : {}),
    });
    assert.notEqual(accepted.status, 2, `${label}: ${accepted.stderr}`);
    for (const forbidden of ['route', 'cwd', 'workstream', 'project']) {
      const rejected = spawnSync(process.execPath,
        [CLI, ...args, `--${forbidden}`, 'dynamic-authority'], {
          cwd: fixture.root, encoding: 'utf8', shell: false, ...(input ? { input } : {}),
        });
      assert.equal(rejected.status, 2, `${label}/${forbidden}: ${rejected.stderr}`);
      assert.equal(rejected.stdout.includes('DEEP_LOOP_STDIN_READY:'), false);
    }
  }
});

// Codex r1 should-fix-2: spec §6 의 4-verb 계약을 CLI 가 노출해야 한다 (dispatch 만 X).
test('adapter resolve returns a normalized 4-verb descriptor', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'Add auth']));
  assert.equal(out.dispatch.kind, 'skill');
  assert.equal(out.dispatch.role, 'maker');
  assert.equal(out.dispatch.skill, 'deep-work:deep-work-orchestrator');
  assert.match(out.dispatch.args, /Add auth/);
  assert.equal(out.await.kind, 'poll_file');
  assert.match(out.await.path, /Add auth/);          // path_template <task> 치환
  assert.ok('read' in out);                            // readArtifacts receipt 디스크립터
  assert.match(out.checker_via, /review dispatch/);    // checker 는 review dispatch CLI 경유
});

test('adapter resolve --verb selects a single verb descriptor', () => {
  const { root } = seed();
  const a = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--verb', 'await']));
  assert.equal(a.selected, 'await');
  assert.equal(a.descriptor.kind, 'poll_file');
});

test('adapter resolve blocks the deep-work implementer entirely under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, false);   // dispatch 자체가 implementer → 전체 차단
});

// Codex r7 sf-1: read-only superpowers 는 planning(writing-plans)은 허용하고 then(implementer)만 strip.
test('adapter resolve allows planning-only superpowers under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'superpowers', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, true);
  assert.equal(out.guard.planning_only, true);
  assert.equal(out.dispatch.skill, 'superpowers:writing-plans');
  assert.equal(out.dispatch.then, null);   // subagent-driven-development(implementer) 차단
});

test('adapter resolve rejects unknown protocol (exit 2)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--protocol', 'nope', '--task', 'x']), 2);
});

// Codex r1 should-fix-6: 비-fence 인자 누락은 usage 오류(exit 2)지 fence 코드(3) 가 아니다.
test('adapter resolve missing --protocol exits 2 (usage, not fence-3)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--task', 'x']), 2);
});

test('state get returns whole loop and a field path', () => {
  const { root } = seed();
  const whole = JSON.parse(run(root, ['state', 'get']));
  assert.equal(whole.goal, 'g');
  const status = JSON.parse(run(root, ['state', 'get', '--field', 'status']));
  assert.equal(status, 'running');
  const missing = JSON.parse(run(root, ['state', 'get', '--field', 'nope.deep']));
  assert.equal(missing, null);
});

test('state get masks App opaque IDs for whole parent and exact leaf without changing disk', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-redact-')));
  const observation = { kind: 'codex-app', source: 'codex-app-tool-provenance',
    capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
    structured_stdin_mode: 'pipe-open-noecho', host_task_cwd: root,
    host_task_cwd_source: 'app-task-context',
    observed_at: '2026-07-13T00:00:00.000Z' };
  const { runId } = initRun(root, { runtime: 'codex', goal: 'g',
    now: new Date('2026-07-13T00:00:00.000Z'), hostObservation: observation, cwdFn: () => root,
    appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: '2026-07-13T00:00:00.000Z', revoked_at: null } });
  const loop = readState(root, runId).data;
  Object.assign(loop.session_chain.lease, { generation: 2,
    acquired_at: '2026-07-13T00:00:30.000Z' });
  const rawProjectId = ' project $ backtick \\ ';
  const rawThreadId = ' thread $ backtick \\ ';
  const continuation = overrides => ({
    transport: 'codex-app', attempt_id: '01JAPPTASK0000000000000000',
    route: 'create', context_mode: 'fresh', phase: 'failed',
    expected_runtime: 'codex', expected_host_surface: 'codex-app',
    target_cwd: root, host_task_cwd_digest: appHostTaskCwdDigest(
      loop.session_chain.sessions[0].host_surface, root),
    workstream_id: null, project_id: rawProjectId,
    descriptor_digest: 'd'.repeat(64), emitted_at: '2026-07-13T00:00:00.000Z',
    prepare_deadline: '2026-07-13T00:05:00.000Z',
    prepared_at: '2026-07-13T00:00:10.000Z',
    confirmation_deadline: '2026-07-13T00:02:10.000Z',
    confirmed_at: '2026-07-13T00:00:20.000Z', acquired_at: null,
    acquired_generation: null, thread_id: rawThreadId,
    unconfirmed_thread_id: null, failure_code: 'host-call-failed',
    failure_binding: { owner_run_id: loop.run_id, generation: 1 }, ...overrides,
  });
  loop.session_chain.sessions.push(
    { run_id: '01JAPPCHD00000000000000010', started_at: null, ended_at: null, turns: 0,
      outcome: 'failed_launch', superseded_by: null, host_surface: null,
      continuation: continuation({}) },
    { run_id: '01JAPPCHD00000000000000011', started_at: null, ended_at: null, turns: 0,
      outcome: null, superseded_by: null, host_surface: null, continuation: continuation({
        attempt_id: '01JAPPTASK0000000000000001', route: 'fork',
        context_mode: 'inherited-completed-history', workstream_id: 'WS1',
        project_id: null, confirmed_at: null, thread_id: null,
        unconfirmed_thread_id: 'uncertain', failure_code: 'message-unconfirmed',
      }) },
  );
  seedVerifiedAppHistories(root, runId, loop.session_chain.sessions.slice(1));
  const disk = readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json'));
  for (const args of [
    ['state', 'get', '--run-id', runId],
    ['state', 'get', '--run-id', runId, '--field', 'session_chain.sessions'],
    ['state', 'get', '--run-id', runId, '--field', 'session_chain.sessions.1.continuation'],
    ['state', 'get', '--run-id', runId, '--field',
      'session_chain.sessions.1.continuation.thread_id'],
    ['state', 'get', '--run-id', runId, '--field',
      'session_chain.sessions.1.continuation.thread_id.0'],
    ['state', 'get', '--run-id', runId, '--field',
      'session_chain.sessions.1.continuation.project_id'],
    ['state', 'get', '--run-id', runId, '--field',
      'session_chain.sessions.1.continuation.project_id.length'],
    ['state', 'get', '--run-id', runId, '--field',
      'session_chain.sessions.2.continuation.unconfirmed_thread_id'],
    ['state', 'get', '--run-id', runId, '--field',
      'session_chain.sessions.2.continuation.unconfirmed_thread_id.0'],
  ]) {
    const output = run(root, args);
    assert.equal(output.includes(rawThreadId), false);
    assert.equal(output.includes(rawProjectId), false);
    assert.equal(output.includes('uncertain'), false);
    assert.match(output, /REDACTED_OPAQUE_ID/);
  }
  assert.match(run(root, ['state', 'get', '--run-id', runId, '--field',
    'session_chain.sessions.1.continuation.descriptor_digest']), /dddddddd/);
  assert.equal(JSON.parse(run(root, ['state', 'get', '--run-id', runId, '--field',
    'session_chain.sessions.2.continuation.project_id'])), null);
  assert.deepEqual(readFileSync(join(root, '.deep-loop', 'runs', runId, 'loop.json')), disk);
  assert.equal(readState(root, runId).data.session_chain.sessions[1].continuation.project_id,
    rawProjectId);
});

test('App secret projection masks secret accessors and rejects other dynamic objects without traps',
  async () => {
    const { redactAppSecrets } = await import('../scripts/lib/app-task-continuation.mjs');
    let getterCalls = 0;
    const secretAccessor = {};
    Object.defineProperty(secretAccessor, 'thread_id', { enumerable: true, get() {
      getterCalls++;
      return 'raw-thread';
    } });
    assert.deepEqual(redactAppSecrets(secretAccessor), {
      thread_id: '[REDACTED_OPAQUE_ID]',
    });
    assert.equal(getterCalls, 0);

    const otherAccessor = {};
    Object.defineProperty(otherAccessor, 'nested', { enumerable: true, get() {
      getterCalls++;
      return { project_id: 'raw-project' };
    } });
    assert.throws(() => redactAppSecrets(otherAccessor), /APP_REDACTION_INVALID/);
    assert.equal(getterCalls, 0);

    let proxyTraps = 0;
    const proxy = new Proxy({}, { ownKeys() { proxyTraps++; return []; } });
    assert.throws(() => redactAppSecrets(proxy), /APP_REDACTION_INVALID/);
    assert.equal(proxyTraps, 0);
  });

test('state patch writes whitelisted field with valid fence', () => {
  const { root, runId } = seed();
  run(root, ['state', 'patch', '--field', 'discovered_items', '--value', '["a","b"]', '--owner', runId, '--generation', '1']);
  const got = JSON.parse(run(root, ['state', 'get', '--field', 'discovered_items']));
  assert.deepEqual(got, ['a', 'b']);
});

test('state patch rejects forbidden field (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['state', 'patch', '--field', 'budget.spent', '--value', '999', '--owner', runId, '--generation', '1']), 1);
});

test('state patch is fenced on wrong generation (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['state', 'patch', '--field', 'decisions', '--value', '["x"]', '--owner', runId, '--generation', '9']), 3);
});

test('state patch forbids terminal episode status (exit 1)', () => {
  const { root, runId } = seed();
  // episodes.0.status=done 은 터미널 → classifyPatch forbid (episode 가 없어도 분류 단계에서 거부)
  assert.equal(runFail(root, ['state', 'patch', '--field', 'episodes.0.status', '--value', '"done"', '--owner', runId, '--generation', '1']), 1);
});

test('budget record accrues turns/tokens via event log with fence', () => {
  const { root, runId } = seed();
  const r = JSON.parse(run(root, ['budget', 'record', '--turns', '3', '--tokens', '1000',
    '--request-id', 'cli-budget-record-1', '--owner', runId, '--generation', '1']));
  assert.equal(r.ok, true);
  const spent = JSON.parse(run(root, ['state', 'get', '--field', 'budget.spent']));
  assert.equal(spent, 3);
});

test('budget record is fenced (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns', '1',
    '--request-id', 'cli-budget-fenced-1', '--owner', runId, '--generation', '9']), 3);
});

// Codex r4 sf-4: 값 없는 --turns 는 1 로 오기록하지 말고 거부(exit 1).
test('budget record rejects a valueless --turns (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns',
    '--request-id', 'cli-budget-invalid-turns-1', '--owner', runId, '--generation', '1']), 1);
});

test('budget record requires a request id as usage (exit 2)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns', '1',
    '--owner', runId, '--generation', '1']), 2);
});

test('budget record rejects a valueless request id as usage (exit 2)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns', '1', '--request-id',
    '--owner', runId, '--generation', '1']), 2);
});

test('budget check is read-only and reports ok', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['budget', 'check', '--now', '2026-06-24T00:00:01Z']));
  assert.equal(r.ok, true);
});

// Codex r3 critical-1: budget record 가 세션 turns 를 증가시켜 per_session_turn_cap 마일스톤을 실제로 구동.
test('budget record drives per_session_turn_cap → next-action handoff', () => {
  const { root, runId } = seed();
  run(root, ['budget', 'record', '--turns', '40',
    '--request-id', 'cli-budget-cap-1', '--owner', runId, '--generation', '1']);   // == per_session_turn_cap(40)
  const na = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z']));
  assert.equal(na.action.type, 'handoff');
  assert.equal(na.action.reason, 'per_session_turn_cap');
});

// Codex r3 sf-2: 스킬이 쓰는 CLI 경로(episode new --artifacts → record done)가 실제로 통과하는지 통합 검증.
test('episode new --artifacts then record done (the skill flow)', () => {
  const { root, runId } = seed();
  writeFileSync(join(root, 'art.txt'), 'x');   // expected artifact 가 root 하위에 존재해야 done 통과
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--artifacts', '["art.txt"]', '--task', 'Implement the skillface fixture.', '--request-id', 'skillface-episode', '--owner', runId, '--generation', '1']));
  run(root, ['episode', 'record', '--id', ep.id, '--status', 'done', '--artifacts', '["art.txt"]', '--owner', runId, '--generation', '1']);
  assert.equal(JSON.parse(run(root, ['state', 'get', '--field', 'episodes.0.status'])), 'done');
});

test('comprehension status is read-only', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['comprehension', 'status']));
  assert.equal(r.debt_ratio, 0);
});

test('comprehension ack is fenced (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--episode', 'x', '--owner', runId, '--generation', '9']), 3);
});

// Codex r1 should-fix-5: 부재 episode ack 는 overcount 를 일으키면 안 된다 → 거부(exit 1).
test('comprehension ack rejects nonexistent episode (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--episode', 'ghost', '--owner', runId, '--generation', '1']), 1);
});

// Codex r1 should-fix-6: 비-fence 인자 누락 → exit 2 (usage).
test('comprehension ack missing --episode exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--owner', runId, '--generation', '1']), 2);
});

test('breaker reset requires --confirm (exit 2)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['breaker', 'reset', '--request-id', 'reset-without-confirm',
    '--owner', runId, '--generation', '1']), 2);
});

test('breaker reset requires --request-id (exit 2)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['breaker', 'reset', '--confirm',
    '--owner', runId, '--generation', '1']), 2);
});

test('breaker reset with --confirm is still fenced (exit 3)', () => {
  const { root, runId } = seed();   // Codex r2 critical-1: confirm 만으로는 부족, fence 도 필요
  assert.equal(runFail(root, ['breaker', 'reset', '--confirm', '--request-id', 'wrong-fence-reset', '--owner', runId, '--generation', '9']), 3);
});

test('breaker check is read-only', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['breaker', 'check']));
  assert.equal(r.tripped, false);
});

// Fix 3: missing required non-fence args → exit 2
test('episode new missing --plugin exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['episode', 'new', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--owner', runId, '--generation', '1']), 2);
});

test('episode new missing --role exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['episode', 'new', '--plugin', 'deep-work', '--kind', 'implementation', '--point', 'implementation', '--owner', runId, '--generation', '1']), 2);
});

test('review dispatch missing --point exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['review', 'dispatch', '--workstream', 'ws1', '--owner', runId, '--generation', '1']), 2);
});

// ── Problem A: state get no-active-run guard (2026-06-29 Windows fixes) ──────────
import { mkdirSync, rmSync } from 'node:fs';
function runBoth(root, args) {
  try { const out = execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' }); return { out: out.trim(), code: 0, err: '' }; }
  catch (e) { return { out: (e.stdout || '').trim(), code: e.status ?? 1, err: (e.stderr || '').trim() }; }
}

test('A1: state get with no current pointer → null, exit 0, no stacktrace', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const r = runBoth(root, ['state', 'get', '--field', 'status']);
  assert.equal(r.out, 'null');
  assert.equal(r.code, 0);
  assert.ok(!/\bat .*:\d+:\d+/.test(r.err), 'no stacktrace in stderr');
});

test('A1: dangling current (run dir absent) → null, exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), '01JABCNOTAREALRUN\n');
  const r = runBoth(root, ['state', 'get', '--field', 'status']);
  assert.equal(r.out, 'null');
  assert.equal(r.code, 0);
});

test('A1: partial state loss (run dir present, loop.json gone) → STATE_MISSING, exit≠0', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const rid = '01JABCPARTIALLOSS';
  const rd = join(root, '.deep-loop', 'runs', rid);
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, 'event-log.jsonl'), '{}\n');   // run dir + artifact exist; loop.json does NOT
  writeFileSync(join(root, '.deep-loop', 'current'), rid + '\n');
  const r = runBoth(root, ['state', 'get', '--field', 'status']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /STATE_MISSING/);
});

test('A1: explicit --run-id miss → fail closed (not null)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const r = runBoth(root, ['state', 'get', '--run-id', '01JABCDOESNOTEXIST', '--field', 'status']);
  assert.notEqual(r.code, 0);
  assert.notEqual(r.out, 'null');
});

test('A1: corrupt loop.json (bad JSON) → fail closed (not null)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const rid = '01JABCCORRUPTJSON';
  const rd = join(root, '.deep-loop', 'runs', rid);
  mkdirSync(rd, { recursive: true });
  writeFileSync(join(rd, 'loop.json'), '{ not json');
  writeFileSync(join(rd, '.loop.hash'), 'whatever');
  writeFileSync(join(root, '.deep-loop', 'current'), rid + '\n');
  const r = runBoth(root, ['state', 'get', '--field', 'status']);
  assert.notEqual(r.code, 0);
  assert.notEqual(r.out, 'null');
});

test('A1: state patch with no run → MISSING_RUN_ID, exit 2', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-a1-'));
  const r = runBoth(root, ['state', 'patch', '--field', 'discovered_items', '--value', '[]', '--owner', 'x', '--generation', '1']);
  assert.equal(r.code, 2);
  assert.match(r.err, /MISSING_RUN_ID/);
});

// #4: finish --status stopped is a human-only bypass — the CLI fast-fails (exit 2) without --confirm,
// mirroring abandon/recover/breaker-reset. completed is unaffected.
test('finish --status stopped without --confirm exits 2 (#4)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['finish', '--status', 'stopped', '--proof', '{"human_reason":"x"}', '--owner', runId, '--generation', '1']), 2);
});

test('structured input has no argv env file base64 or echo fallback', () => {
  const source = readFileSync(join(process.cwd(), 'scripts', 'lib', 'bounded-input.mjs'), 'utf8');
  const readyWrite = 'writeReady = token => process.stdout.write(`${token}\\n`),';
  assert.equal(source.split(readyWrite).length - 1, 1);
  const sourceWithoutReadyWrite = source.replace(readyWrite, '');
  assert.doesNotMatch(sourceWithoutReadyWrite,
    /process\.(?:stdout|stderr)\.write|console\.(?:log|info|warn|error)|\.pipe\s*\(/);
  assert.deepEqual(source.match(/\bwriteReady\s*\([^)]*\)/g), ['writeReady(token)']);
  assert.doesNotMatch(source,
    /process\.(?:argv|env)|node:(?:fs|os)|['"](?:fs|fs\/promises|os)['"]|\b(?:readFile|writeFile|appendFile|copyFile|rename|open|mkdtemp|createReadStream|createWriteStream)(?:Sync)?\s*\(|\b(?:atob|btoa|Deno|Bun)\b|['"`]base64['"`]|fileURLToPath|pathToFileURL/i);
});

import { test as testCli7e } from 'node:test';
import assertCli7e from 'node:assert/strict';
import { spawnSync as spawn7e } from 'node:child_process';
import { mkdirSync as mkdir7e, mkdtempSync as mkdtemp7e,
  writeFileSync as writeFile7e } from 'node:fs';
import { tmpdir as tmpdir7e } from 'node:os';
import { join as join7e } from 'node:path';
import { fileURLToPath as fileURLToPath7e } from 'node:url';
import { durableRunBytes as cliBytes7e, rawHashValidState as rawCli7e,
  verifiedAppRun as cliFixture7e } from './fixtures/verified-app-run.mjs';

const CLI7E = fileURLToPath7e(new URL('../scripts/deep-loop.mjs', import.meta.url));
function runCli7e(root, args) {
  const child = spawn7e('node', [CLI7E, ...args, '--project-root', root],
    { encoding: 'utf8' });
  return { code: child.status ?? 1, stdout: child.stdout || '', stderr: child.stderr || '' };
}

testCli7e('read-only CLI and requireLease reject cross-log-invalid authority', () => {
  const fixture = cliFixture7e('dl-cli-verified-read-');
  rawCli7e(fixture.root, fixture.runId, loop => {
    loop.session_chain.sessions[0].host_surface.observed_at =
      '2026-07-13T00:00:01.000Z';
  });
  const before = cliBytes7e(fixture.root, fixture.runId);
  const readOnly = [
    ['validate', ['validate', '--run-id', fixture.runId]],
    ['state get', ['state', 'get', '--run-id', fixture.runId]],
    ['next-action', ['next-action', '--run-id', fixture.runId]],
    ['tick', ['tick', '--run-id', fixture.runId]],
    ['lease check', ['lease', 'check', '--run-id', fixture.runId,
      '--owner', fixture.owner, '--generation', String(fixture.generation)]],
    ['budget check', ['budget', 'check', '--run-id', fixture.runId]],
    ['comprehension status', ['comprehension', 'status', '--run-id', fixture.runId]],
    ['breaker check', ['breaker', 'check', '--run-id', fixture.runId]],
  ];
  for (const [label, args] of readOnly) {
    const result = runCli7e(fixture.root, args);
    assertCli7e.equal(result.code, 1, `${label} must fail closed`);
    assertCli7e.match(result.stderr, /RUN_SNAPSHOT_INVALID/, label);
    assertCli7e.doesNotMatch(result.stderr, /\n\s+at\s/, `${label} must not leak a stack`);
  }

  const mutation = ['state', 'patch', '--run-id', fixture.runId,
    '--field', 'decisions', '--value', '[]'];
  const wrong = runCli7e(fixture.root, [...mutation,
    '--owner', 'wrong-owner', '--generation', String(fixture.generation)]);
  assertCli7e.equal(wrong.code, 3);
  assertCli7e.match(wrong.stderr, /LEASE_FENCED/);
  const correct = runCli7e(fixture.root, [...mutation,
    '--owner', fixture.owner, '--generation', String(fixture.generation)]);
  assertCli7e.equal(correct.code, 1);
  assertCli7e.match(correct.stderr, /RUN_SNAPSHOT_INVALID/);
  assertCli7e.deepEqual(cliBytes7e(fixture.root, fixture.runId), before,
    'read-only and rejected mutation commands must preserve durable bytes');

  const emptyRoot = mkdtemp7e(join7e(tmpdir7e(), 'dl-cli-no-current-'));
  const missing = runCli7e(emptyRoot, ['state', 'get']);
  assertCli7e.equal(missing.code, 0);
  assertCli7e.equal(missing.stdout.trim(), 'null',
    'implicit current missing remains a clean null projection');

  const danglingRoot = mkdtemp7e(join7e(tmpdir7e(), 'dl-cli-dangling-current-'));
  mkdir7e(join7e(danglingRoot, '.deep-loop'), { recursive: true });
  writeFile7e(join7e(danglingRoot, '.deep-loop', 'current'),
    '01JABCNOTAREALRUN\n');
  const dangling = runCli7e(danglingRoot, ['state', 'get']);
  assertCli7e.equal(dangling.code, 0);
  assertCli7e.equal(dangling.stdout.trim(), 'null',
    'an implicit pointer to an absent run directory remains a clean null projection');
});
test('episode new missing --request-id exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker',
    '--kind', 'implementation', '--point', 'implementation', '--task', 'Bounded task.',
    '--owner', runId, '--generation', '1']), 2);
});
test('episode new missing --task exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker',
    '--kind', 'implementation', '--point', 'implementation',
    '--request-id', 'missing-task', '--owner', runId, '--generation', '1']), 2);
});

test('review dispatch missing --request-id exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['review', 'dispatch', '--point', 'design',
    '--workstream', 'ws1', '--owner', runId, '--generation', '1']), 2);
});

test('skill publishes the exact fixed App init command family', () => {
  const source = readFileSync(join(process.cwd(), 'skills', 'deep-loop', 'SKILL.md'), 'utf8');
  for (const command of [
    'host-surface stdin-probe --project-root "<canonical_project_root>" --stdin-mode <pipe-open-noecho|pty-raw-noecho> --probe-stdin',
    'init-run preflight --runtime codex --preflight-nonce <32_hex_process_nonce> --stdin-mode <pipe-open-noecho|pty-raw-noecho> --observation-stdin',
    'init-run prepare --runtime codex',
    'init-run prepare --manual-enums --runtime <codex|claude>',
    'init-run --init-attempt <init_attempt> --expected-current-digest <previous_current_digest> --expected-request-digest <expected_request_digest> --expected-preflight-digest NONE --prepared-authority \'<prepared_authority_json_compact>\' --manual-enums',
    'init-run status --attempt <init_attempt>',
    '--expected-current-digest <previous_current_digest>',
    '--expected-request-digest <expected_request_digest>',
    'DEEP_LOOP_STDIN_READY:v1:init-commit:<attempt>.<previous_current_digest>.<request_digest>.<preflight_digest>.<prepared_authority_digest>:<mode>',
  ]) assert.ok(source.includes(command), `missing fixed init CLI: ${command}`);

  const variants = [
    ['profile:model+effort', '--model "<session_model>" --effort "<session_effort>"'],
    ['profile:model-only', '--model "<session_model>"'],
    ['profile:none', ''],
  ];
  for (let index = 0; index < variants.length; index += 1) {
    const [marker, flags] = variants[index];
    const start = source.indexOf(marker);
    const end = index + 1 < variants.length
      ? source.indexOf(variants[index + 1][0], start + marker.length)
      : source.indexOf('프로필 선택 뒤에만', start + marker.length);
    assert.ok(start >= 0 && end > start, `missing profile variant block: ${marker}`);
    const block = source.slice(start, end);
    const prepare = block.split('\n').find(line => line.includes('init-run prepare'));
    const commit = block.split('\n').find(line => line.includes('init-run --init-attempt'));
    assert.ok(prepare && commit, `${marker}: exact prepare/full pair required`);
    assert.equal(prepare.includes('--model'), flags.includes('--model'), `${marker}: prepare model`);
    assert.equal(commit.includes('--model'), flags.includes('--model'), `${marker}: commit model`);
    assert.equal(prepare.includes('--effort'), flags.includes('--effort'), `${marker}: prepare effort`);
    assert.equal(commit.includes('--effort'), flags.includes('--effort'), `${marker}: commit effort`);
    if (flags) {
      assert.ok(prepare.includes(flags), `${marker}: prepare flags drift`);
      assert.ok(commit.includes(flags), `${marker}: commit flags drift`);
    }
    assert.ok(commit.includes('--expected-request-digest <expected_request_digest>'),
      `${marker}: full commit must bind prepare request digest`);
    assert.ok(commit.includes("--prepared-authority '<prepared_authority_json_compact>'"),
      `${marker}: full commit must transport prepare authority`);
  }
  assert.match(source, /prepared_authority_json_compact[^\n]*byte-for-byte/i);
  assert.match(source, /prepared_authority_digest[^\n]*SHA-256/i);
  assert.match(source, /prepared_authority_json_compact[^\n]*(재구성|reconstruct)[^\n]*(금지|않)/i);
  assert.match(source, /surface\/source paired form:[^\n]*둘 다 생략[^\n]*null\/null/);
  assert.match(source, /capability가 0개이면[^\n]*--capabilities[^\n]*생략[^\n]*exact `\[\]`/i);
});

test('documented enum prepare authority completes a real fixed init commit', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-skill-authority-')));
  const common = ['--project-root', root, '--manual-enums', '--runtime', 'codex',
    '--goal', 'skill-authority-fixture', '--app-continuation', 'manual',
    '--app-consent-authority', 'default-manual'];
  const prepared = spawnSync(process.execPath, [CLI, 'init-run', 'prepare', ...common,
    '--expected-observation-digest', 'NONE'], { cwd: root, encoding: 'utf8' });
  assert.equal(prepared.status, 0, prepared.stderr);
  const binding = JSON.parse(prepared.stdout);
  const authority = JSON.stringify(binding.prepared_authority);
  const committed = spawnSync(process.execPath, [CLI, 'init-run', ...common,
    '--init-attempt', binding.attempt_id,
    '--expected-current-digest', binding.previous_current_digest,
    '--expected-request-digest', binding.expected_request_digest,
    '--expected-preflight-digest', 'NONE', '--prepared-authority', authority],
  { cwd: root, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  assert.equal(JSON.parse(committed.stdout).run_id, binding.attempt_id);
});
