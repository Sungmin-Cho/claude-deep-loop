// v1.6 terminal guard — mutating CLI 전수 표 (spec §4-2) + 자체-계약 verb 회귀 (§4-5d/5f④)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { seedCorrelatedTerminal } from './fixtures/verified-app-run.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');

function seedTerminal(status, mutate, runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-term-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  let { data } = readState(root, runId);
  if (['completed', 'stopped'].includes(status)) {
    seedCorrelatedTerminal(root, runId, { status });
    data = readState(root, runId).data;
  } else {
    data.status = status;
  }
  if (mutate) {
    mutate(data);
    writeState(root, runId, data);
  } else if (!['completed', 'stopped'].includes(status)) {
    writeState(root, runId, data);
  }
  return { root, runId, owner: data.session_chain.lease.owner_run_id, gen: data.session_chain.lease.generation };
}
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { encoding: 'utf8' });

// spec §4-2: 외곽 requireLease(leaseCheck)가 RUN_TERMINAL을 exit 3로 — requireLease-경유 mutating verb 전수.
// (spawn-style reset-desktop은 requireLease 우회 verb — 아래 자체-계약 테스트에서 별도 고정, §4-5d.)
const VERBS = (o, g) => [
  ['workstream', 'new', '--title', 'T', '--branch', 'b', '--worktree', '.claude/worktrees/w'],
  ['workstream', 'set', '--id', 'ws-x', '--status', 'in_progress'],
  ['workstream', 'terminal', '--id', 'ws-x', '--status', 'abandoned'],
  ['episode', 'new', '--plugin', 'p', '--role', 'maker', '--kind', 'k', '--point', 'design'],
  ['episode', 'record', '--id', 'e', '--status', 'done'],
  ['episode', 'abandon', '--id', 'e', '--reason', 'r', '--confirm'],
  ['review', 'dispatch', '--point', 'design', '--workstream', 'ws-x'],
  ['review', 'record', '--episode', 'e', '--verdict', 'APPROVE'],
  ['review', 'import', '--stdin'],
  ['state', 'patch', '--field', 'discovered_items', '--value', '[]'],   // classifyPatch 화이트리스트 필드
  ['budget', 'record', '--turns', '1'],
  ['comprehension', 'ack', '--episode', 'e'],
  ['insights', 'emit'],
  ['spawn-style', 'offer-desktop'],
  ['spawn-style', 'confirm-desktop', '--nonce', 'n'],
  ['spawn-style', 'decline-desktop'],
  ['handoff', 'emit'],
  ['respawn'],
  ['session-profile', 'set', '--model', 'm'],
  ['detect-terminal'],
  ['breaker', 'reset', '--confirm', '--request-id', 'terminal-sweep-reset'],
  ['finish', '--status', 'completed', '--report', 'final-report.md'],
].map(a => [...a, '--owner', o, '--generation', String(g)]);

for (const status of ['completed', 'stopped']) {
  test(`CLI sweep: every requireLease-mediated mutating verb exits 3 with RUN_TERMINAL on ${status} run`, () => {
    const { root, owner, gen } = seedTerminal(status);
    for (const args of VERBS(owner, gen)) {
      const r = run(root, args);
      assert.equal(r.status, 3, `${args.join(' ')} → exit ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
      assert.match(r.stderr, /RUN_TERMINAL/, args.join(' '));
    }
  });
}

// §4-5d (plan r3): reset-desktop은 requireLease 우회 human-recovery verb — 자체 계약(JSON ok:false + exit 1) 고정.
test('CLI spawn-style reset-desktop on terminal run: exit 1 + JSON ok:false RUN_TERMINAL, no mutation', () => {
  const { root, runId, owner, gen } = seedTerminal('completed', (d) => { d.autonomy.spawn_style = 'desktop'; });
  const r = run(root, ['spawn-style', 'reset-desktop', '--owner', owner, '--generation', String(gen)]);
  assert.equal(r.status, 1, `exit ${r.status}\n${r.stderr}${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'RUN_TERMINAL');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');   // 무변
});

// §4-5f ④ (2차 r2): lease acquire — run-terminal/runtime fence는 exit 3,
// generation-mismatch 등 그 외 ok:false는 기존 exit 0 + JSON 유지.
test('CLI lease acquire: terminal → exit 3 run-terminal; non-terminal generation-mismatch → exit 0 (contract preserved)', () => {
  const { root, owner, gen } = seedTerminal('completed');
  const r = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'claude']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).reason, 'run-terminal');
  // 비terminal + stale generation → 기존 계약(exit 0 + JSON)
  const fresh = mkdtempSync(join(tmpdir(), 'dl-term-nt-'));
  const { runId: r2 } = initRun(fresh, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  const r2res = run(fresh, ['lease', 'acquire', '--owner', 'other-run', '--generation', '9', '--runtime', 'claude']);
  assert.equal(r2res.status, 0, r2res.stdout + r2res.stderr);
  assert.equal(JSON.parse(r2res.stdout).reason, 'generation-mismatch');
  void r2;
});

test('CLI lease acquire requires a valued runtime', () => {
  const { root, owner, gen } = seedTerminal('running');

  const missing = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen)]);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /--runtime <claude\|codex> is required/);

  const valueless = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime']);
  assert.equal(valueless.status, 2, valueless.stdout + valueless.stderr);
  assert.match(valueless.stderr, /--runtime <claude\|codex> is required/);
});

test('CLI lease acquire classifies an invalid runtime enum or stored runtime state as exit 1', () => {
  const { root, runId, owner, gen } = seedTerminal('running');

  const invalid = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'other']);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /INVALID_RUNTIME/);

  const { data } = readState(root, runId);
  delete data.autonomy.session_runtime;
  data.autonomy.runtime_source = 'skill-asserted';
  const raw = JSON.stringify(data, null, 2);
  writeFileSync(join(runDir(root, runId), 'loop.json'), raw);
  writeFileSync(join(runDir(root, runId), '.loop.hash'), contentHash(raw));
  const invalidState = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'claude']);
  assert.equal(invalidState.status, 1, invalidState.stdout + invalidState.stderr);
  assert.match(invalidState.stderr, /INVALID_RUNTIME_STATE/);
  assert.doesNotMatch(invalidState.stderr, /\n\s+at /, 'classified runtime-state errors must not leak a stack');
});

test('CLI lease acquire rejects malformed autonomy without a wrong-runtime takeover or durable mutation', () => {
  const { root, runId, gen } = seedTerminal('running', (data) => {
    data.session_chain.lease.state = 'released';
  }, 'codex');
  const { data } = readState(root, runId);
  data.autonomy = [];
  const raw = JSON.stringify(data, null, 2);
  const dir = runDir(root, runId);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));

  const beforeLoop = readFileSync(join(dir, 'loop.json'), 'utf8');
  const beforeHash = readFileSync(join(dir, '.loop.hash'), 'utf8');
  const eventPath = join(dir, 'event-log.jsonl');
  const beforeEvents = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null;
  const result = run(root, [
    'lease', 'acquire', '--owner', 'CLAUDE-OWNER', '--generation', String(gen), '--runtime', 'claude',
  ]);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /INVALID_RUNTIME_STATE: autonomy must be object/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, 'classified runtime-state errors must not leak a stack');
  assert.equal(readFileSync(join(dir, 'loop.json'), 'utf8'), beforeLoop);
  assert.equal(readFileSync(join(dir, '.loop.hash'), 'utf8'), beforeHash);
  assert.equal(existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null, beforeEvents);
});

test('CLI lease acquire runtime mismatch exits 3 with structured RUNTIME_FENCED and mutates nothing', () => {
  const { root, runId, owner, gen } = seedTerminal('running');
  const before = structuredClone(readState(root, runId).data);
  const r = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'codex']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    ok: false,
    reason: 'RUNTIME_FENCED',
    expected: 'claude',
    actual: 'codex',
  });
  assert.deepEqual(readState(root, runId).data, before);
});

test('CLI lease acquire keeps missing/invalid owner and generation on the established exit-3 fence contract', () => {
  const { root, owner, gen } = seedTerminal('running');
  const cases = [
    ['lease', 'acquire', '--generation', String(gen), '--runtime', 'claude'],
    ['lease', 'acquire', '--owner', '--generation', String(gen), '--runtime', 'claude'],
    ['lease', 'acquire', '--owner', owner, '--runtime', 'claude'],
    ['lease', 'acquire', '--owner', owner, '--generation', '--runtime', 'claude'],
  ];
  for (const args of cases) {
    const r = run(root, args);
    assert.equal(r.status, 3, `${args.join(' ')} → ${r.status}\n${r.stdout}${r.stderr}`);
  }
});

// §2.3 의도 고정 (impl r1 adversarial 기각 근거의 테스트화): lease release는 terminal에서 **의도적으로 허용**
// (사람 확정 2026-07-09) — released는 terminal run의 자연 최종 상태(rollbackHandoff terminal 모드와 동일 안착점)이고,
// 이후 재획득은 acquireLease run-terminal이, 모든 write는 leaseCheck가 차단하므로 무해. 누락이 아니라 설계다.
test('CLI lease release on terminal run is intentionally allowed (cleanup path) and the result stays inert', () => {
  const { root, runId, owner, gen } = seedTerminal('completed');
  const r = run(root, ['lease', 'release', '--owner', owner, '--generation', String(gen)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'released');
  // 정리 후에도 불활성: 재획득 거부 + business write 거부
  const acq = run(root, ['lease', 'acquire', '--owner', 'other-run', '--generation', String(gen), '--runtime', 'claude']);
  assert.equal(acq.status, 3);
  assert.equal(JSON.parse(acq.stdout).reason, 'run-terminal');
  const w = run(root, ['state', 'patch', '--field', 'discovered_items', '--value', '[]', '--owner', owner, '--generation', String(gen)]);
  assert.equal(w.status, 3);
  assert.match(w.stderr, /RUN_TERMINAL/);
});
