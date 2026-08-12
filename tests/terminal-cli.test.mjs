// v1.6 terminal guard — mutating CLI 전수 표 (spec §4-2) + 자체-계약 verb 회귀 (§4-5d/5f④)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { appendAnchored, readLines } from '../scripts/lib/integrity.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { baselineNode20RegularFiles } from './helpers/baseline-node20-walk.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');

function seedTerminal(status, mutate, runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-term-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  const { data } = readState(root, runId);
  data.status = status;
  if (mutate) mutate(data);
  writeState(root, runId, data);
  return { root, runId, owner: data.session_chain.lease.owner_run_id, gen: data.session_chain.lease.generation };
}
function fixtureRunId(root) {
  const runsRoot = join(root, '.deep-loop', 'runs');
  const ids = readdirSync(runsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.equal(ids.length, 1, `fixture must have exactly one target run, found ${ids.join(',')}`);
  return ids[0];
}

function routedArgs(root, args) {
  return args.includes('--run-id') ? [...args, '--project-root', root] : [...args, '--project-root', root, '--run-id', fixtureRunId(root)];
}

const run = (root, args, options = {}) => spawnSync(
  process.execPath,
  [CLI, ...routedArgs(root, args)],
  { encoding: 'utf8', ...options },
);

function runAsync(root, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CLI, ...routedArgs(root, args)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', status => resolveRun({ status, stdout, stderr }));
  });
}

function seedBoundaryCli() {
  const root = mkdtempSync(join(tmpdir(), 'dl-term-boundary-'));
  const review = {
    points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
    flags: [], converge: true, max_review_rounds: 5, require_human_ack: false,
  };
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', review, now: new Date('2026-07-23T00:00:00.000Z'),
  });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const worktree = '.claude/worktrees/boundary';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, {
    title: 'boundary', branch: 'feature/boundary', worktree, fence,
  }).id;
  const artifact = `${worktree}/artifact.txt`;
  writeFileSync(join(root, artifact), 'artifact');
  const maker = newEpisode(root, runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: ws, expectedArtifacts: [artifact], fence,
  }).id;
  recordEpisode(root, runId, maker, { status: 'in_progress', fence });
  recordEpisode(root, runId, maker, { status: 'done', artifacts: [artifact], proof: {}, fence });
  const checker = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected: {}, fence,
  }).checkerEpisodeId;
  const report = `${worktree}/review.md`;
  writeFileSync(join(root, report), '# review');
  recordReviewOutcome(root, runId, {
    episodeId: checker, verdict: 'APPROVE', proof: { report }, fence,
  });
  return { root, runId, owner: runId, gen: 1, ws };
}

function terminalDurableBytes(root, runId) {
  const dir = runDir(root, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
    events: existsSync(eventPath) ? readFileSync(eventPath) : null,
  };
}

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
  ['attended-launch', 'approve', '--style', 'visible', '--confirm'],
  ['handoff', 'emit'],
  ['checkpoint', 'emit', '--runtime', 'claude'],
  ['checkpoint', 'restore', '--checkpoint', `checkpoints/${'a'.repeat(64)}-compact.json`,
    '--runtime', 'claude', '--admission', 'human-attested', '--source', 'direct-human-skill',
    '--confirm-manual-compact', '--json'],
  ['respawn'],
  ['session-profile', 'set', '--model', 'm'],
  ['detect-terminal'],
  ['breaker', 'reset', '--confirm'],
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

for (const status of ['completed', 'stopped']) {
  test(`checkpoint observe reaches the authoritative terminal fence on ${status} run`, () => {
    const { root, runId, owner, gen } = seedTerminal(status);
    const result = run(root, [
      'checkpoint', 'observe',
      '--checkpoint', `checkpoints/${'a'.repeat(64)}-compact.json`,
      '--trigger', 'manual',
      '--runtime', 'claude',
      '--trusted-postcompact-stdin',
      '--json',
      '--owner', owner,
      '--generation', String(gen),
    ], {
      input: JSON.stringify({ hook_event_name: 'PostCompact', cwd: realpathSync(root), trigger: 'manual' }),
    });
    assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /RUN_TERMINAL/);
    assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), runId);
  });

  test(`checkpoint inspect remains read-only and reports non-resumable on ${status} run`, () => {
    const { root } = seedTerminal(status);
    const before = terminalDurableBytes(root, readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim());
    const result = run(root, ['checkpoint', 'inspect', '--json']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const descriptor = JSON.parse(result.stdout);
    assert.equal(descriptor.phase, 'none');
    assert.equal(descriptor.reason, 'run-not-resumable');
    assert.deepEqual(
      terminalDurableBytes(root, readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim()),
      before,
    );
  });
}

test('workstream terminal CLI accepts exactly the three affirmative abandoned spellings', () => {
  for (const confirmArgs of [
    ['--confirm'],
    ['--confirm=true'],
    ['--confirm', 'true'],
  ]) {
    const f = seedBoundaryCli();
    const result = run(f.root, [
      'workstream', 'terminal', '--id', f.ws, '--status', 'abandoned',
      '--proof', '{"reason":"cancelled"}', ...confirmArgs,
      '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(result.status, 0, `${confirmArgs.join(' ')}\n${result.stdout}${result.stderr}`);
  }
});

test('workstream terminal CLI rejects missing, false, empty, valued, and duplicate abandoned confirmation without mutation', () => {
  for (const confirmArgs of [
    [],
    ['--confirm=false'],
    ['--confirm', 'false'],
    ['--confirm='],
    ['--confirm=yes'],
    ['--confirm', '--confirm'],
    ['--confirm=true', '--confirm=true'],
    ['--confirm=true', '--confirm=false'],
  ]) {
    const f = seedBoundaryCli();
    const before = terminalDurableBytes(f.root, f.runId);
    const missing = run(f.root, [
      'workstream', 'terminal', '--id', f.ws, '--status', 'abandoned',
      '--proof', '{"reason":"cancelled"}', ...confirmArgs,
      '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(missing.status, 2, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /CONFIRM_REQUIRED/);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  }
});

test('workstream terminal CLI rejects any ready or merged confirm occurrence without mutation', () => {
  for (const [status, setup, proof] of [
    ['ready', () => {}, '{}'],
    ['merged', (f) => {
      const ready = run(f.root, [
        'workstream', 'terminal', '--id', f.ws, '--status', 'ready',
        '--proof', '{}', '--owner', f.owner, '--generation', String(f.gen),
      ]);
      assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    }, '{"merge_commit":"abc123","human_approved":true}'],
  ]) {
    for (const confirmArgs of [
      ['--confirm'],
      ['--confirm=true'],
      ['--confirm', 'true'],
      ['--confirm=false'],
      ['--confirm='],
      ['--confirm', '--confirm'],
      ['--confirm=true', '--confirm=false'],
    ]) {
      const f = seedBoundaryCli();
      setup(f);
      const before = terminalDurableBytes(f.root, f.runId);
      const forbidden = run(f.root, [
        'workstream', 'terminal', '--id', f.ws, '--status', status,
        '--proof', proof, ...confirmArgs,
        '--owner', f.owner, '--generation', String(f.gen),
      ]);
      assert.equal(forbidden.status, 2, `${status} ${confirmArgs.join(' ')}\n${forbidden.stdout}${forbidden.stderr}`);
      assert.match(forbidden.stderr, /CONFIRM_FORBIDDEN/);
      assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
    }
  }
});

test('workstream terminal confirmation grammar precedes proof parsing and state lookup', () => {
  for (const [status, confirmArgs, expected] of [
    ['abandoned', [], /CONFIRM_REQUIRED/],
    ['ready', ['--confirm=false'], /CONFIRM_FORBIDDEN/],
    ['merged', ['--confirm='], /CONFIRM_FORBIDDEN/],
  ]) {
    const f = seedBoundaryCli();
    const before = terminalDurableBytes(f.root, f.runId);
    const malformed = run(f.root, [
      'workstream', 'terminal', '--id', 'ws-does-not-exist', '--status', status,
      '--proof', '{', ...confirmArgs,
      '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(malformed.status, 2, malformed.stdout + malformed.stderr);
    assert.match(malformed.stderr, expected);
    assert.doesNotMatch(malformed.stderr, /Unexpected|WORKSTREAM_NOT_FOUND/);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  }
});

test('workstream terminal public precedence is status, existence, transition, scope, closure, then proof', () => {
  {
    const f = seedBoundaryCli();
    const invalid = run(f.root, [
      'workstream', 'terminal', '--id', f.ws, '--status', 'bogus',
      '--proof', '{', '--confirm', '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(invalid.stderr, /WORKSTREAM_STATUS_INVALID/);
    assert.doesNotMatch(invalid.stderr, /CONFIRM_FORBIDDEN|Unexpected/);
  }

  {
    const f = seedBoundaryCli();
    const missing = run(f.root, [
      'workstream', 'terminal', '--id', 'ws-does-not-exist', '--status', 'abandoned',
      '--proof', '{"reason":"cancelled"}', '--confirm',
      '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /WORKSTREAM_NOT_FOUND/);
  }

  {
    const f = seedBoundaryCli();
    const state = readState(f.root, f.runId).data;
    state.session_chain.sessions[0].scope.workstream_id = 'ws-other';
    state.workstreams.find(item => item.id === f.ws).review_points_done = [];
    state.episodes.find(item => item.role === 'maker').status = 'pending';
    writeState(f.root, f.runId, state);
    const before = terminalDurableBytes(f.root, f.runId);

    const transition = run(f.root, [
      'workstream', 'terminal', '--id', f.ws, '--status', 'merged',
      '--proof', '{"merge_commit":"abc123","human_approved":true}',
      '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(transition.status, 1, transition.stdout + transition.stderr);
    assert.match(transition.stderr, /WORKSTREAM_TERMINAL_LOCKED/);
    assert.doesNotMatch(transition.stderr, /SESSION_SCOPE_MISMATCH|WORKSTREAM_CLOSURE_UNMET/);

    const scope = run(f.root, [
      'workstream', 'terminal', '--id', f.ws, '--status', 'ready',
      '--proof', '{}', '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(scope.status, 1, scope.stdout + scope.stderr);
    assert.match(scope.stderr, /SESSION_SCOPE_MISMATCH/);
    assert.doesNotMatch(scope.stderr, /WORKSTREAM_CLOSURE_UNMET|WORKSTREAM_TERMINAL_NO_PROOF/);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  }

  {
    const f = seedBoundaryCli();
    const state = readState(f.root, f.runId).data;
    state.workstreams.find(item => item.id === f.ws).review_points_done = [];
    state.episodes.find(item => item.role === 'maker').status = 'pending';
    writeState(f.root, f.runId, state);
    const closure = run(f.root, [
      'workstream', 'terminal', '--id', f.ws, '--status', 'ready',
      '--proof', '{}', '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(closure.status, 1, closure.stdout + closure.stderr);
    assert.match(closure.stderr, /WORKSTREAM_CLOSURE_UNMET/);
    assert.doesNotMatch(closure.stderr, /WORKSTREAM_TERMINAL_NO_PROOF/);
  }

  {
    const f = seedBoundaryCli();
    const state = readState(f.root, f.runId).data;
    state.workstreams.find(item => item.id === f.ws).review_points_done = [];
    writeState(f.root, f.runId, state);
    const proof = run(f.root, [
      'workstream', 'terminal', '--id', f.ws, '--status', 'ready',
      '--proof', '{}', '--owner', f.owner, '--generation', String(f.gen),
    ]);
    assert.equal(proof.status, 1, proof.stdout + proof.stderr);
    assert.match(proof.stderr, /WORKSTREAM_TERMINAL_NO_PROOF/);
  }
});

test('public state get rejects a forged legacy terminal-event string under workstream-session', () => {
  const f = seedBoundaryCli();
  const dir = runDir(f.root, f.runId);
  const state = readState(f.root, f.runId).data;
  state.workstreams.find(item => item.id === f.ws).terminal_events = ['999:forged:ready'];
  const raw = JSON.stringify(state, null, 2);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));

  const result = run(f.root, ['state', 'get', '--run-id', f.runId]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /SCHEMA_INVALID.*workstream-session/);
  assert.equal(result.stdout, '');
});

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
  const r = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'claude', '--attempt-id', 'TERMINALATTEMPT01']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).reason, 'run-terminal');
  // 비terminal + stale generation → 기존 계약(exit 0 + JSON)
  const fresh = mkdtempSync(join(tmpdir(), 'dl-term-nt-'));
  const { runId: r2 } = initRun(fresh, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  const r2res = run(fresh, ['lease', 'acquire', '--owner', 'other-run', '--generation', '9', '--runtime', 'claude', '--attempt-id', 'TERMINALATTEMPT02']);
  assert.equal(r2res.status, 0, r2res.stdout + r2res.stderr);
  assert.equal(JSON.parse(r2res.stdout).reason, 'generation-mismatch');
  void r2;
});

test('CLI lease acquire returns a retryable JSON envelope for concurrent lock contention', async () => {
  const { root, runId, owner, gen } = seedTerminal('running');
  const lock = join(runDir(root, runId), '.lock');
  // Keep the kernel lock occupied while two public acquisitions race. Both calls
  // must surface the same structured transient result, never a raw Node stack.
  mkdirSync(lock);
  try {
    const args = ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'claude', '--attempt-id', 'LOCKBUSYATTEMPT01', '--run-id', runId];
    const results = await Promise.all([runAsync(root, args), runAsync(root, args)]);
    for (const result of results) {
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: false,
        generation: gen,
        reason: 'lock-busy',
        proceed: false,
        consumed: null,
        replayed: false,
        retryable: true,
      });
      assert.equal(result.stderr, '');
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
});

test('CLI pause validates mode while preserving default, preserve, and rollback behavior', () => {
  const invalid = seedTerminal('running');
  const before = terminalDurableBytes(invalid.root, invalid.runId);
  const rejected = run(invalid.root, [
    'pause', '--owner', invalid.owner, '--generation', String(invalid.gen),
    '--reason', 'test', '--mode', 'bogus', '--run-id', invalid.runId,
  ]);
  assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /--mode must be preserve or rollback/);
  assert.deepEqual(terminalDurableBytes(invalid.root, invalid.runId), before);

  for (const mode of [undefined, 'preserve', 'rollback']) {
    const fixture = seedTerminal('running');
    const args = [
      'pause', '--owner', fixture.owner, '--generation', String(fixture.gen),
      '--reason', 'test', '--run-id', fixture.runId,
    ];
    if (mode) args.push('--mode', mode);
    const result = run(fixture.root, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lease = readState(fixture.root, fixture.runId).data.session_chain.lease;
    assert.equal(lease.handoff_phase, 'idle');
    assert.equal(lease.resume_policy, mode === 'rollback' ? undefined : 'human');
  }
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

  const invalid = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'other', '--attempt-id', 'RUNTIMEATTEMPT01']);
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /INVALID_RUNTIME/);

  const { data } = readState(root, runId);
  delete data.autonomy.session_runtime;
  data.autonomy.runtime_source = 'skill-asserted';
  const raw = JSON.stringify(data, null, 2);
  writeFileSync(join(runDir(root, runId), 'loop.json'), raw);
  writeFileSync(join(runDir(root, runId), '.loop.hash'), contentHash(raw));
  const invalidState = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'claude', '--attempt-id', 'RUNTIMEATTEMPT02']);
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
    '--attempt-id', 'AUTONOMYATTEMPT01',
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
  const r = run(root, ['lease', 'acquire', '--owner', owner, '--generation', String(gen), '--runtime', 'codex', '--attempt-id', 'RUNTIMEATTEMPT03']);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    ok: false,
    reason: 'RUNTIME_FENCED',
    expected: 'claude',
    actual: 'codex',
    // 의도된 shape 변경 — spec §3.1. RUNTIME_FENCED 는 runtimeFence 객체를 그대로 복원하므로
    // `generation` 이 없고, 계약 3필드만 더해진다.
    proceed: false,
    consumed: null,
    replayed: false,
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
  const acq = run(root, ['lease', 'acquire', '--owner', 'other-run', '--generation', String(gen), '--runtime', 'claude', '--attempt-id', 'TERMINALATTEMPT03']);
  assert.equal(acq.status, 3);
  assert.equal(JSON.parse(acq.stdout).reason, 'run-terminal');
  const w = run(root, ['state', 'patch', '--field', 'discovered_items', '--value', '[]', '--owner', owner, '--generation', String(gen)]);
  assert.equal(w.status, 3);
  assert.match(w.stderr, /RUN_TERMINAL/);
});

test('CLI state get rejects prepared publication without reconciliation or mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-state-get-reconcile-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'before', now: new Date('2026-07-23T00:00:00.000Z'),
  });
  assert.throws(() => appendAnchored(
    root,
    runId,
    { type: 'state-get-candidate', data: {}, now: '2026-07-23T00:01:00.000Z' },
    loop => { loop.goal = 'after'; },
    undefined,
    {
      publication: {
        kind: 'state-get-barrier', operationId: 'state-get-barrier', artifacts: [], topology: {},
        faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('barrier'); },
      },
    },
  ), /TRANSACTION_PENDING/);

  const before = {
    loop: readFileSync(join(runDir(root, runId), 'loop.json')),
    hash: readFileSync(join(runDir(root, runId), '.loop.hash')),
    goal: readState(root, runId).data.goal,
  };
  const result = run(root, ['state', 'get', '--run-id', runId]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, 'reconciliation-required');
  assert.equal(readState(root, runId).data.goal, before.goal);
  assert.deepEqual(readFileSync(join(runDir(root, runId), 'loop.json')), before.loop);
  assert.deepEqual(readFileSync(join(runDir(root, runId), '.loop.hash')), before.hash);
});

test('CLI state get fail-stops byte-different replay lines without publishing later resources', () => {
  const cases = [
    {
      name: 'business-leading-space',
      barrier: 'event:0:append',
      tamper(bytes) { return Buffer.concat([Buffer.from(' '), bytes]); },
    },
    {
      name: 'business-crlf',
      barrier: 'event:0:append',
      tamper(bytes) { return Buffer.concat([bytes.subarray(0, -1), Buffer.from('\r\n')]); },
    },
    {
      name: 'business-extra-trailing-newline',
      barrier: 'event:0:append',
      tamper(bytes) { return Buffer.concat([bytes, Buffer.from('\n')]); },
    },
    {
      name: 'floor-trailing-space',
      barrier: 'event:1:append',
      tamper(bytes) {
        const firstEnd = bytes.indexOf(0x0a) + 1;
        return Buffer.concat([
          bytes.subarray(0, firstEnd),
          bytes.subarray(firstEnd, -1),
          Buffer.from(' \n'),
        ]);
      },
    },
  ];

  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'dl-state-get-exact-event-'));
    const { runId } = initRun(root, {
      runtime: 'claude', goal: 'before', now: new Date('2026-07-23T00:00:00.000Z'),
    });
    const dir = runDir(root, runId);
    const operationId = `exact-${scenario.name}`;
    assert.throws(() => appendAnchored(
      root,
      runId,
      { type: 'state-get-exact-event', data: { scenario: scenario.name }, now: '2026-07-23T00:01:00.000Z' },
      loop => { loop.goal = 'after'; },
      undefined,
      {
        publication: {
          kind: 'state-get-exact-event', operationId, artifacts: [], topology: { scenario: scenario.name },
          faultAt(label) { if (label === scenario.barrier) throw new Error('barrier'); },
        },
        floor: 1,
      },
    ), /TRANSACTION_PENDING/, scenario.name);

    const logPath = join(dir, 'event-log.jsonl');
    const tamperedLog = scenario.tamper(readFileSync(logPath));
    writeFileSync(logPath, tamperedLog);
    const beforeLoop = readFileSync(join(dir, 'loop.json'));
    const beforeHash = readFileSync(join(dir, '.loop.hash'));
    const committedPath = join(dir, 'transactions', operationId, 'committed.json');

    const result = run(root, ['state', 'get', '--run-id', runId]);
    assert.deepEqual({
      status: result.status,
      classified: /reconciliation-required|integrity-invalid|INTEGRITY_INVALID|TRANSACTION_RECONCILIATION_REQUIRED/i.test(`${result.stdout}${result.stderr}`),
      rawEqual: readFileSync(logPath).equals(tamperedLog),
      loopEqual: readFileSync(join(dir, 'loop.json')).equals(beforeLoop),
      hashEqual: readFileSync(join(dir, '.loop.hash')).equals(beforeHash),
      committed: existsSync(committedPath),
    }, {
      status: 1,
      classified: true,
      rawEqual: true,
      loopEqual: true,
      hashEqual: true,
      committed: false,
    }, scenario.name);
  }
});

test('public/transitive readers and independent writers are statically closed through reconciliation gateways', () => {
  const readers = [
    'scripts/deep-loop.mjs',
    'scripts/lib/insights.mjs',
    'scripts/lib/review.mjs',
    'scripts/lib/respawn.mjs',
    'scripts/lib/headless-host.mjs',
    'scripts/lib/checkpoint.mjs',
    'scripts/lib/session-profile.mjs',
    'scripts/lib/handoff.mjs',
    'scripts/lib/detect-terminal.mjs',
    'scripts/lib/recover.mjs',
    'scripts/lib/workspace.mjs',
    'scripts/lib/episode.mjs',
    'scripts/hooks-impl/precompact-handoff.mjs',
    'scripts/hooks-impl/sessionstart-restore.mjs',
  ];
  for (const rel of readers) {
    const source = readFileSync(join(process.cwd(), rel), 'utf8');
    assert.doesNotMatch(source, /\breadState\s*\(/, `${rel}: raw state read`);
  }

  const writers = [
    'scripts/lib/budget.mjs',
    'scripts/lib/breaker.mjs',
    'scripts/lib/comprehension.mjs',
    'scripts/lib/lease.mjs',
    'scripts/lib/headless-host.mjs',
    'scripts/lib/checkpoint.mjs',
    'scripts/lib/session-profile.mjs',
  ];
  for (const rel of writers) {
    const source = readFileSync(join(process.cwd(), rel), 'utf8');
    assert.doesNotMatch(source, /\bwithLock\s*\(/, `${rel}: raw writer lock`);
  }

  const rootRecovery = readFileSync(join(process.cwd(), 'scripts/lib/project-root-recovery.mjs'), 'utf8');
  assert.match(rootRecovery, /captureReconciledRootRecoverySnapshot\s*\(/);
  assert.match(rootRecovery, /withReconciledRootRecoveryLock\s*\(/);
  assert.doesNotMatch(rootRecovery, /\b(?:withLock|captureReconciledRunSnapshot|withReconciledMutationLock)\s*\(/);
});

test('semantic public import graph admits no raw state reader or lock consumer outside integrity', () => {
  const scriptsRoot = resolve(process.cwd(), 'scripts');
  const files = [];
  const enumerate = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) enumerate(path);
      else if (name.endsWith('.mjs')) files.push(path);
    }
  };
  enumerate(scriptsRoot);

  const sources = new Map(files.map(path => [path, readFileSync(path, 'utf8')]));
  const dependencies = new Map();
  const importPattern = /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const [path, source] of sources) {
    const imported = [];
    for (const match of source.matchAll(importPattern)) {
      if (!match[1].startsWith('.')) continue;
      const target = resolve(dirname(path), match[1]);
      if (sources.has(target)) imported.push(target);
    }
    dependencies.set(path, imported);
  }

  const scriptRel = path => relative(scriptsRoot, path).split(sep).join('/');
  const roots = files.filter(path => scriptRel(path) === 'deep-loop.mjs'
    || scriptRel(path).startsWith('hooks-impl/')
    || scriptRel(path).startsWith('workers/'));
  const reachable = new Set();
  const queue = [...roots];
  while (queue.length) {
    const path = queue.shift();
    if (reachable.has(path)) continue;
    reachable.add(path);
    queue.push(...(dependencies.get(path) || []));
  }

  for (const expected of ['handoff.mjs', 'detect-terminal.mjs', 'recover.mjs', 'workspace.mjs', 'episode.mjs']) {
    assert.ok([...reachable].some(path => scriptRel(path) === `lib/${expected}`), `${expected}: public graph reachability`);
  }

  const forbidden = new Set(['readState', 'readStateForRootRecovery', 'withLock']);
  const stateImport = /import\s*\{([^}]+)\}\s*from\s*['"][^'"]*state\.mjs['"]/gs;
  for (const path of reachable) {
    if (scriptRel(path) === 'lib/integrity.mjs') continue;
    const source = sources.get(path);
    assert.doesNotMatch(source, /import\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*state\.mjs['"]/, `${relative(process.cwd(), path)}: state namespace import`);
    for (const match of source.matchAll(stateImport)) {
      const bindings = match[1].split(',').map(binding => binding.trim().split(/\s+as\s+/)[0]);
      const raw = bindings.filter(binding => forbidden.has(binding));
      assert.deepEqual(raw, [], `${relative(process.cwd(), path)}: raw state bindings`);
    }
  }
});

function seedActivationCli(runtime = 'claude') {
  const f = seedTerminal('running', undefined, runtime);
  const released = run(f.root, [
    'lease', 'release', '--owner', f.owner, '--generation', String(f.gen), '--run-id', f.runId,
  ]);
  assert.equal(released.status, 0, released.stdout + released.stderr);
  const owner = 'CLIACTIVATIONOWNER';
  const acquired = run(f.root, [
    'lease', 'acquire', '--owner', owner, '--generation', '1', '--runtime', runtime,
    '--attempt-id', 'CLIACTIVATIONATTEMPT', '--run-id', f.runId,
  ]);
  assert.equal(acquired.status, 0, acquired.stdout + acquired.stderr);
  assert.equal(JSON.parse(acquired.stdout).proceed, true);
  return { ...f, owner, gen: 2, attemptId: 'CLIACTIVATIONATTEMPT' };
}

function activateCli(f, extra = [], owner = f.owner, generation = f.gen, runtime = 'claude') {
  return run(f.root, [
    'lease', 'activate', '--owner', owner, '--generation', String(generation),
    '--runtime', runtime, '--run-id', f.runId, ...extra,
  ]);
}

function storedActivateCli(f, {
  root = f.root, owner = f.owner, generation = f.gen, runtime = 'claude',
  attemptId = f.attemptId, attemptArgs = ['--attempt-id', attemptId], privateHome, extra = [],
} = {}) {
  const home = privateHome || mkdtempSync(join(tmpdir(), 'dl-stored-fence-home-'));
  const result = spawnSync(process.execPath, [
    CLI, 'lease', 'activate', '--stored-token', '--owner', owner,
    '--generation', String(generation), '--runtime', runtime, ...attemptArgs,
    '--run-id', f.runId, '--project-root', root, ...extra,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, '.state'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
    },
  });
  return { ...result, privateHome: home };
}

function privateActivationRoot(home) {
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'deep-loop')
    : join(home, '.state', 'deep-loop');
}

function reapCli(f, extra = [], owner = f.owner, generation = f.gen) {
  return run(f.root, [
    'lease', 'reap', '--owner', owner, '--generation', String(generation),
    '--run-id', f.runId, ...extra,
  ]);
}

function activationVerbCli(f, verb, fenceArgs) {
  const verbArgs = verb === 'activate'
    ? [
      '--runtime', 'claude', '--attempt-id', f.attemptId,
      '--activation-token', 'CliTaxonomyToken_01',
    ]
    : [];
  return run(f.root, [
    'lease', verb, ...fenceArgs, ...verbArgs, '--run-id', f.runId,
  ]);
}

test('SLICE-010 new lease verbs classify omitted, bare, and empty fence options as usage exit 2', () => {
  const cases = [
    { label: 'owner omitted', fenceArgs: ['--generation', '2'], field: 'owner' },
    { label: 'owner bare', fenceArgs: ['--owner', '--generation', '2'], field: 'owner' },
    { label: 'owner empty', fenceArgs: ['--owner=', '--generation', '2'], field: 'owner' },
    { label: 'generation omitted', fenceArgs: ['--owner', 'CLIACTIVATIONOWNER'], field: 'generation' },
    { label: 'generation bare', fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--generation'], field: 'generation' },
    { label: 'generation empty', fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--generation='], field: 'generation' },
  ];
  for (const verb of ['activate', 'reap']) {
    for (const { label, fenceArgs, field } of cases) {
      const f = seedActivationCli();
      const before = terminalDurableBytes(f.root, f.runId);
      const result = activationVerbCli(f, verb, fenceArgs);
      assert.equal(result.status, 2, `${verb} ${label}\n${result.stdout}${result.stderr}`);
      assert.match(result.stderr, new RegExp(`USAGE: --${field}`));
      assert.deepEqual(terminalDurableBytes(f.root, f.runId), before, `${verb} ${label}`);
    }
  }
});

test('SLICE-010 new lease verbs reject every duplicate fence option ordering as usage exit 2', () => {
  const cases = [
    {
      label: 'owner bare then valid',
      fenceArgs: ['--owner', '--owner', 'CLIACTIVATIONOWNER', '--generation', '2'],
    },
    {
      label: 'owner valid then bare',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--owner', '--generation', '2'],
    },
    {
      label: 'owner empty then valid',
      fenceArgs: ['--owner=', '--owner', 'CLIACTIVATIONOWNER', '--generation', '2'],
    },
    {
      label: 'owner valid then empty',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--owner=', '--generation', '2'],
    },
    {
      label: 'owner valid then valid',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--owner', 'OTHEROWNER', '--generation', '2'],
    },
    {
      label: 'generation bare then valid',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--generation', '--generation', '2'],
    },
    {
      label: 'generation valid then bare',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--generation', '2', '--generation'],
    },
    {
      label: 'generation invalid then valid',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--generation', '0', '--generation', '2'],
    },
    {
      label: 'generation valid then invalid',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--generation', '2', '--generation', '0'],
    },
    {
      label: 'generation valid then valid',
      fenceArgs: ['--owner', 'CLIACTIVATIONOWNER', '--generation', '2', '--generation', '3'],
    },
  ];
  for (const verb of ['activate', 'reap']) {
    for (const { label, fenceArgs } of cases) {
      const f = seedActivationCli();
      const before = terminalDurableBytes(f.root, f.runId);
      const result = activationVerbCli(f, verb, fenceArgs);
      assert.equal(result.status, 2, `${verb} ${label}\n${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /USAGE: --(owner|generation)/);
      assert.deepEqual(terminalDurableBytes(f.root, f.runId), before, `${verb} ${label}`);
    }
  }
});

test('SLICE-010 new lease verbs classify malformed generations as invalid-value exit 1', () => {
  for (const verb of ['activate', 'reap']) {
    for (const generation of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
      const f = seedActivationCli();
      const before = terminalDurableBytes(f.root, f.runId);
      const result = activationVerbCli(f, verb, [
        '--owner', f.owner, '--generation', generation,
      ]);
      assert.equal(result.status, 1,
        `${verb} generation=${generation}\n${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /INVALID_GENERATION/);
      assert.deepEqual(terminalDurableBytes(f.root, f.runId), before,
        `${verb} generation=${generation}`);
    }
  }
});

test('SLICE-010 new lease verbs reserve exit 3 for valid-shaped stale fences', () => {
  for (const verb of ['activate', 'reap']) {
    for (const fenceArgs of [
      ['--owner', 'STALEOWNER', '--generation', '2'],
      ['--owner', 'CLIACTIVATIONOWNER', '--generation', '999'],
    ]) {
      const f = seedActivationCli();
      const before = terminalDurableBytes(f.root, f.runId);
      const result = activationVerbCli(f, verb, fenceArgs);
      assert.equal(result.status, 3, `${verb} ${fenceArgs.join(' ')}\n${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /LEASE_FENCED: (owner|generation)-mismatch/);
      assert.deepEqual(terminalDurableBytes(f.root, f.runId), before,
        `${verb} ${fenceArgs.join(' ')}`);
    }
  }
});

test('SLICE-004 CLI lease activate records --now and returns activated', () => {
  const f = seedActivationCli();
  const result = activateCli(f, [
    '--attempt-id', f.attemptId, '--activation-token', 'CliActivationToken_01',
    '--now', '2026-08-06T08:09:10.000Z',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, reason: 'activated' });
  const state = readState(f.root, f.runId).data;
  assert.equal(state.session_chain.lease.activation.activated_at, '2026-08-06T08:09:10.000Z');
  assert.equal(state.session_chain.lease.activation_deadline_at, null);
  assert.equal(readLines(f.root, f.runId).filter(event => event.type === 'lease-activated').length, 1);
});

test('stored-token activation creates a private secret, activates, reuses it, and leaks no raw token', () => {
  const f = seedActivationCli();
  const privateHome = mkdtempSync(join(tmpdir(), 'dl-stored-home-'));
  const argv = [
    CLI, 'lease', 'activate', '--stored-token', '--owner', f.owner,
    '--generation', String(f.gen), '--runtime', 'claude', '--attempt-id', f.attemptId,
    '--run-id', f.runId, '--project-root', f.root,
  ];
  const invoke = () => spawnSync(process.execPath, argv, {
    encoding: 'utf8', env: { ...process.env, HOME: privateHome },
  });
  const first = invoke();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { ok: true, reason: 'activated' });
  const second = invoke();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { ok: true, reason: 'already-activated' });

  const directory = process.platform === 'darwin'
    ? join(privateHome, 'Library', 'Application Support', 'deep-loop', 'activation-secrets')
    : join(privateHome, '.local', 'state', 'deep-loop', 'activation-secrets');
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  const secret = JSON.parse(readFileSync(join(directory, files[0]), 'utf8')).token;
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr, new RegExp(secret));
  const durable = terminalDurableBytes(f.root, f.runId);
  for (const bytes of Object.values(durable).filter(Boolean)) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, 'raw token leaked into kernel durable bytes');
  }
  for (const file of baselineNode20RegularFiles(f.root)) {
    const bytes = readFileSync(file);
    assert.equal(bytes.includes(Buffer.from(secret)), false,
      `raw token leaked into project artifact ${relative(f.root, file)}`);
  }
  assert.equal(readState(f.root, f.runId).data.session_chain.lease.activation.activation_token_digest,
    contentHash(secret));
});

test('stored-token mode is bare exactly once and mutually exclusive with raw-token mode', () => {
  for (const flags of [
    ['--stored-token=true'],
    ['--stored-token', '--stored-token'],
    ['--stored-token', '--activation-token', 'CliCompatibilityToken_01'],
    ['--stored-token', '--secret-root', '/attacker/path'],
  ]) {
    const f = seedActivationCli();
    const before = terminalDurableBytes(f.root, f.runId);
    const result = activateCli(f, ['--attempt-id', f.attemptId, ...flags]);
    assert.equal(result.status, 2, `${flags.join(' ')}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /stored-token/);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  }
});

test('lease activate and reap reject unknown, positional, and duplicate flags without mutation', () => {
  const cases = [
    ['activate', ['--attempt-id', 'CLIACTIVATIONATTEMPT', '--activation-token', 'CliGrammarToken_01', '--runtimee', 'claude']],
    ['activate', ['--attempt-id', 'CLIACTIVATIONATTEMPT', '--activation-token', 'CliGrammarToken_01', 'positional']],
    ['activate', ['--attempt-id', 'CLIACTIVATIONATTEMPT', '--activation-token', 'CliGrammarToken_01', '--runtime', 'claude']],
    ['activate', ['--attempt-id', 'CLIACTIVATIONATTEMPT', '--activation-token', 'CliGrammarToken_01', '--activation-token', 'CliGrammarToken_01']],
    ['reap', ['--unknown', 'value']],
    ['reap', ['positional']],
    ['reap', ['--run-id', 'SAME_RUN_ID_REPLACED_BELOW']],
    ['reap', ['--project-root', 'SAME_PROJECT_ROOT_REPLACED_BELOW']],
  ];
  for (const [verb, rawExtra] of cases) {
    const f = seedActivationCli();
    const extra = rawExtra.map(value => value === 'SAME_RUN_ID_REPLACED_BELOW'
      ? f.runId
      : value === 'SAME_PROJECT_ROOT_REPLACED_BELOW' ? f.root : value);
    const before = terminalDurableBytes(f.root, f.runId);
    const result = verb === 'activate' ? activateCli(f, extra) : reapCli(f, extra);
    assert.equal(result.status, 2, `${verb} ${extra.join(' ')}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /USAGE:/);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before, `${verb} ${extra.join(' ')}`);
  }
});

test('stored-token activation rejects duplicate binding flags before private publication', () => {
  const f = seedActivationCli();
  const before = terminalDurableBytes(f.root, f.runId);
  const result = storedActivateCli(f, { extra: ['--runtime', 'claude'] });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /USAGE:/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  assert.equal(existsSync(privateActivationRoot(result.privateHome)), false);
});

for (const mode of ['raw-token', 'stored-token']) {
  for (const [ordering, attemptArgs] of [
    ['valid then invalid', ['--attempt-id', 'CLIACTIVATIONATTEMPT', '--attempt-id', 'bad!']],
    ['invalid then valid', ['--attempt-id', 'bad!', '--attempt-id', 'CLIACTIVATIONATTEMPT']],
  ]) {
    test(`${mode} activation classifies duplicate attempt-id ${ordering} as usage before value validation`, () => {
      const f = seedActivationCli();
      const before = terminalDurableBytes(f.root, f.runId);
      const result = mode === 'raw-token'
        ? activateCli(f, [...attemptArgs, '--activation-token', 'CliDuplicateAttemptToken_01'])
        : storedActivateCli(f, { attemptArgs });
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /USAGE:/);
      assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
      if (mode === 'stored-token') {
        assert.equal(existsSync(privateActivationRoot(result.privateHome)), false);
      }
    });
  }
}

test('stored-token activation preserves owner, generation, and runtime fences as exit 3 without mutation', () => {
  for (const [label, overrides, expected] of [
    ['owner', { owner: 'STALEOWNER' }, /LEASE_FENCED: owner-mismatch/],
    ['generation', { generation: 999 }, /LEASE_FENCED: generation-mismatch/],
    ['runtime', { runtime: 'codex' }, /RUNTIME_FENCED/],
  ]) {
    const f = seedActivationCli();
    const before = terminalDurableBytes(f.root, f.runId);
    const result = storedActivateCli(f, overrides);
    assert.equal(result.status, 3, `${label}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, expected, label);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before, label);
    assert.equal(existsSync(privateActivationRoot(result.privateHome)), false,
      `${label}: rejected fence must leave no private-store residue`);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(result.privateHome), label);
  }
});

test('stored-token activation preserves a copied-root project fence as exit 3 without mutation', () => {
  const f = seedActivationCli();
  const candidateRoot = mkdtempSync(join(tmpdir(), 'dl-stored-project-fence-'));
  cpSync(join(f.root, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });
  const before = terminalDurableBytes(candidateRoot, f.runId);
  const result = storedActivateCli(f, { root: candidateRoot });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /PROJECT_ROOT_FENCED/);
  assert.deepEqual(terminalDurableBytes(candidateRoot, f.runId), before);
  assert.equal(existsSync(privateActivationRoot(result.privateHome)), false,
    'project fence must leave no private-store residue');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(result.privateHome));
});

test('stored-token structured and invalid-state rejections leave no private-store residue', () => {
  for (const [label, mutate, overrides, status, expected] of [
    ['paused', data => { data.status = 'paused'; data.pause_reason = 'human-hold'; }, {}, 0, /RUN_PAUSED/],
    ['terminal', data => { data.status = 'completed'; }, {}, 0, /RUN_TERMINAL/],
    ['attempt mismatch', () => {}, { attemptId: 'OTHERATTEMPT0001' }, 0, /attempt-mismatch/],
    ['expired', data => { data.session_chain.lease.activation_deadline_at = '2000-01-01T00:00:00.000Z'; }, {}, 0, /activation-deadline-expired/],
    ['malformed deadline', data => { data.session_chain.lease.activation_deadline_at = 'not-an-iso-deadline'; }, {}, 1, /ACTIVATION_DEADLINE_INVALID/],
  ]) {
    const f = seedActivationCli();
    const { data } = readState(f.root, f.runId);
    mutate(data);
    const raw = JSON.stringify(data, null, 2);
    writeFileSync(join(runDir(f.root, f.runId), 'loop.json'), raw);
    writeFileSync(join(runDir(f.root, f.runId), '.loop.hash'), contentHash(raw));
    const before = terminalDurableBytes(f.root, f.runId);
    const result = storedActivateCli(f, overrides);
    assert.equal(result.status, status, `${label}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, expected, label);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before, label);
    assert.equal(existsSync(privateActivationRoot(result.privateHome)), false,
      `${label}: rejection must leave no private-store residue`);
  }
});

test('stored-token private-store IO failure is exit 1 with kernel mutation zero', () => {
  if (process.platform === 'win32') return; // Windows ACL polarity is injected in activation-secret.test.mjs.
  const f = seedActivationCli();
  const privateHome = mkdtempSync(join(tmpdir(), 'dl-stored-io-home-'));
  const base = process.platform === 'darwin'
    ? join(privateHome, 'Library', 'Application Support')
    : join(privateHome, '.state');
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(base, 'not-a-directory');
  const before = terminalDurableBytes(f.root, f.runId);
  const result = storedActivateCli(f, { privateHome });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ACTIVATION_SECRET_IO_UNAVAILABLE/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(privateHome));
});

test('stored-token retry never creates a replacement token after activation is already durable', () => {
  const f = seedActivationCli();
  const activated = activateCli(f, [
    '--attempt-id', f.attemptId, '--activation-token', 'RawCompatibilityToken_01',
  ]);
  assert.equal(activated.status, 0, activated.stdout + activated.stderr);
  const before = terminalDurableBytes(f.root, f.runId);
  const result = storedActivateCli(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ACTIVATION_SECRET_IO_UNAVAILABLE/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  assert.equal(existsSync(privateActivationRoot(result.privateHome)), false,
    'an activated generation without its original store must not mint a replacement token');
});

test('SLICE-004 CLI expired activation is structured exit zero and mutation-free', () => {
  const f = seedActivationCli();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.activation_deadline_at = '2000-01-01T00:00:00.000Z';
  writeState(f.root, f.runId, data);
  const before = terminalDurableBytes(f.root, f.runId);
  const result = activateCli(f, [
    '--attempt-id', f.attemptId, '--activation-token', 'CliExpiredToken_01',
    '--now', '1900-01-01T00:00:00.000Z',
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false, reason: 'activation-deadline-expired',
  });
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 CLI malformed nonnull activation deadline is exit one and mutation-free', () => {
  const f = seedActivationCli();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.activation_deadline_at = 'not-an-iso-deadline';
  const raw = JSON.stringify(data, null, 2);
  const dir = runDir(f.root, f.runId);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
  const before = terminalDurableBytes(f.root, f.runId);
  const result = activateCli(f, [
    '--attempt-id', f.attemptId, '--activation-token', 'CliMalformedToken_01',
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ACTIVATION_DEADLINE_INVALID/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 expired activate versus reap CLI race serializes to reap-only expiry', async () => {
  const f = seedActivationCli();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.activation_deadline_at = '2000-01-01T00:00:00.000Z';
  writeState(f.root, f.runId, data);
  const activateArgs = [
    'lease', 'activate', '--owner', f.owner, '--generation', String(f.gen),
    '--runtime', 'claude', '--attempt-id', f.attemptId,
    '--activation-token', 'CliExpiredRaceToken_01', '--run-id', f.runId,
  ];
  const reapArgs = [
    'lease', 'reap', '--owner', f.owner, '--generation', String(f.gen), '--run-id', f.runId,
  ];
  let [activation, expiry] = await Promise.all([
    runAsync(f.root, activateArgs),
    runAsync(f.root, reapArgs),
  ]);
  if (activation.status === 1 && /LOCK_BUSY/.test(activation.stderr)) {
    activation = await runAsync(f.root, activateArgs);
  }
  if (expiry.status === 1 && /LOCK_BUSY/.test(expiry.stderr)) {
    expiry = await runAsync(f.root, reapArgs);
  }
  assert.equal(activation.status, 0, activation.stdout + activation.stderr);
  assert.ok([
    'activation-deadline-expired',
    'RUN_PAUSED',
  ].includes(JSON.parse(activation.stdout).reason), activation.stdout);
  assert.equal(expiry.status, 0, expiry.stdout + expiry.stderr);
  assert.deepEqual(JSON.parse(expiry.stdout), {
    ok: true, reason: 'activation-expired', transition: 'preserve-pause',
  });
  const events = readLines(f.root, f.runId);
  assert.equal(events.filter(event => event.type === 'lease-activated').length, 0);
  assert.equal(events.filter(event => event.type === 'activation-expired').length, 1);
  assert.equal(readState(f.root, f.runId).data.status, 'paused');
});

test('SLICE-007 CLI lease reap settles an expired pending acquisition', () => {
  const f = seedActivationCli();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.activation_deadline_at = '2000-01-01T00:00:00.000Z';
  writeState(f.root, f.runId, data);
  const result = reapCli(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true, reason: 'activation-expired', transition: 'preserve-pause',
  });
  const settled = readState(f.root, f.runId).data;
  assert.equal(settled.status, 'paused');
  assert.equal(settled.session_chain.lease.resume_policy, 'human');
  assert.equal(Object.hasOwn(settled, 'resume_policy'), false);
});

test('SLICE-007 CLI lease reap rejects the --now argument itself without mutation', () => {
  const f = seedActivationCli();
  const before = terminalDurableBytes(f.root, f.runId);
  const result = reapCli(f, ['--now', '2999-01-01T00:00:00.000Z']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /USAGE: lease reap does not accept --now/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});

test('SLICE-007 CLI lease reap maps stale owner fences to exit 3 without mutation', () => {
  const f = seedActivationCli();
  const before = terminalDurableBytes(f.root, f.runId);
  const result = reapCli(f, [], 'STALEOWNER');
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /LEASE_FENCED: owner-mismatch/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});

test('SLICE-010 CLI lease reap maps terminal state to invalid-state exit 1 after the fresh fence', () => {
  const f = seedActivationCli();
  const { data } = readState(f.root, f.runId);
  data.status = 'completed';
  writeState(f.root, f.runId, data);
  const before = terminalDurableBytes(f.root, f.runId);
  const result = reapCli(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /RUN_TERMINAL/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 CLI omitted or empty activation attempt is usage exit 2 without mutation', () => {
  for (const attemptArgs of [[], ['--attempt-id', '']]) {
    const f = seedActivationCli();
    const before = terminalDurableBytes(f.root, f.runId);
    const result = activateCli(f, [
      ...attemptArgs, '--activation-token', 'CliActivationToken_02',
    ]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  }
});

test('SLICE-004 CLI malformed activation attempt is invalid-value exit 1 without mutation', () => {
  const f = seedActivationCli();
  const before = terminalDurableBytes(f.root, f.runId);
  const result = activateCli(f, [
    '--attempt-id', 'bad!', '--activation-token', 'CliActivationToken_03',
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /INVALID_ATTEMPT_ID/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 CLI omitted or empty activation token is usage exit 2 without mutation', () => {
  for (const tokenArgs of [[], ['--activation-token', '']]) {
    const f = seedActivationCli();
    const before = terminalDurableBytes(f.root, f.runId);
    const result = activateCli(f, [
      '--attempt-id', f.attemptId, ...tokenArgs,
    ]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
  }
});

test('SLICE-004 CLI malformed activation token is invalid-value exit 1 without mutation', () => {
  const f = seedActivationCli();
  const before = terminalDurableBytes(f.root, f.runId);
  const result = activateCli(f, [
    '--attempt-id', f.attemptId, '--activation-token', 'bad!',
  ]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /INVALID_ACTIVATION_TOKEN/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 CLI runtime fence precedes owner and generation fences', () => {
  const f = seedActivationCli();
  const before = terminalDurableBytes(f.root, f.runId);
  const runtime = activateCli(f, [
    '--attempt-id', f.attemptId, '--activation-token', 'CliActivationToken_04',
  ], 'WRONG', 999, 'codex');
  assert.equal(runtime.status, 3, runtime.stdout + runtime.stderr);
  assert.match(runtime.stderr, /RUNTIME_FENCED/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);

  const owner = activateCli(f, [
    '--attempt-id', f.attemptId, '--activation-token', 'CliActivationToken_04',
  ], 'WRONG', f.gen, 'claude');
  assert.equal(owner.status, 3, owner.stdout + owner.stderr);
  assert.match(owner.stderr, /LEASE_FENCED: owner-mismatch/);
  assert.deepEqual(terminalDurableBytes(f.root, f.runId), before);
});
