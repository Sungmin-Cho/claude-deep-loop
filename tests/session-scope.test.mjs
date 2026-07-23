import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir, writeState } from '../scripts/lib/state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'scripts', 'deep-loop.mjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dl-session-scope-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'scope', now: new Date('2026-07-23T00:00:00.000Z'),
  });
  mkdirSync(join(root, '.claude', 'worktrees'), { recursive: true });
  return { root, runId };
}

function runCli(root, runId, args, { generation = 1, input } = {}) {
  return spawnSync(process.execPath, [
    CLI, ...args,
    '--owner', runId, '--generation', String(generation),
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8', input });
}

function newWorkstream(root, runId, suffix) {
  const result = runCli(root, runId, [
    'workstream', 'new', '--title', suffix, '--branch', `scope-${suffix}`,
    '--worktree', `.claude/worktrees/${suffix}`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).id;
}

function newEpisode(root, runId, { role = 'maker', workstream, suffix = role } = {}) {
  const args = [
    'episode', 'new', '--plugin', role === 'maker' ? 'deep-work' : 'deep-review',
    '--role', role, '--kind', `${suffix}-implementation`, '--point', 'implementation',
  ];
  if (workstream !== undefined) args.push('--workstream', workstream);
  const result = runCli(root, runId, args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).id;
}

function eventLog(root, runId) {
  const path = join(runDir(root, runId), 'event-log.jsonl');
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function fileInventory(root, runId) {
  const base = runDir(root, runId);
  const out = {};
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.lock') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, rel);
      else out[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(base);
  return out;
}

test('public maker in_progress binds the lease-owner session at the exact business event seq', () => {
  const { root, runId } = fixture();
  const ws = newWorkstream(root, runId, 'a');
  const maker = newEpisode(root, runId, { workstream: ws });

  // The lease owner is deliberately not the last session. Binding must not attach to the reserved child.
  const seeded = readState(root, runId).data;
  seeded.session_chain.sessions.push({
    run_id: 'reserved-child', started_at: null, ended_at: null, turns: 0, outcome: null,
    superseded_by: null,
    scope: {
      kind: 'workstream', workstream_id: null, bound_at_seq: null,
      terminal_event: null, closed_at: null, superseded_at: null,
    },
  });
  writeState(root, runId, seeded);

  const result = runCli(root, runId, ['episode', 'record', '--id', maker, '--status', 'in_progress']);
  assert.equal(result.status, 0, result.stderr);
  const loop = readState(root, runId).data;
  const owner = loop.session_chain.sessions.find(session => session.run_id === runId);
  const child = loop.session_chain.sessions.find(session => session.run_id === 'reserved-child');
  const business = eventLog(root, runId).findLast(event => event.type === 'episode-record');
  const floor = eventLog(root, runId).findLast(event => event.type === 'cost');
  assert.equal(owner.scope.workstream_id, ws);
  assert.equal(owner.scope.bound_at_seq, business.seq);
  assert.notEqual(owner.scope.bound_at_seq, floor.seq, 'paired floor cost is not the bind event');
  assert.equal(child.scope.workstream_id, null, 'last session is not owner authority');

  const originalSeq = owner.scope.bound_at_seq;
  const repeat = runCli(root, runId, ['episode', 'record', '--id', maker, '--status', 'in_progress']);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(
    readState(root, runId).data.session_chain.sessions.find(session => session.run_id === runId).scope.bound_at_seq,
    originalSeq,
  );
});

test('public bind rejects null workstream, checker-first, stale fence, terminal target, and second workstream without bytes', () => {
  for (const scenario of ['null', 'checker', 'stale', 'terminal', 'second']) {
    const { root, runId } = fixture();
    const wsA = newWorkstream(root, runId, 'a');
    const wsB = newWorkstream(root, runId, 'b');
    const makerA = newEpisode(root, runId, { workstream: wsA, suffix: 'a' });
    const makerB = scenario === 'null'
      ? newEpisode(root, runId, { workstream: undefined, suffix: 'null' })
      : scenario === 'checker'
        ? newEpisode(root, runId, { role: 'checker', workstream: wsB, suffix: 'checker' })
        : newEpisode(root, runId, { workstream: wsB, suffix: 'b' });

    if (scenario === 'second') {
      const bound = runCli(root, runId, ['episode', 'record', '--id', makerA, '--status', 'in_progress']);
      assert.equal(bound.status, 0, bound.stderr);
    }
    if (scenario === 'terminal') {
      const loop = readState(root, runId).data;
      loop.workstreams.find(ws => ws.id === wsB).status = 'ready';
      writeState(root, runId, loop);
    }
    const before = fileInventory(root, runId);
    const result = runCli(root, runId, [
      'episode', 'record', '--id', makerB, '--status', 'in_progress',
    ], { generation: scenario === 'stale' ? 9 : 1 });
    assert.equal(result.status, scenario === 'stale' ? 3 : 1, `${scenario}: ${result.stderr}`);
    assert.match(result.stderr, scenario === 'null' ? /WORKSTREAM_REQUIRED/
      : scenario === 'terminal' ? /WORKSTREAM_TERMINAL_LOCKED/
        : scenario === 'stale' ? /LEASE_FENCED/
          : /SESSION_SCOPE_MISMATCH/);
    assert.deepEqual(fileInventory(root, runId), before, scenario);
  }
});

test('terminal workstreams reject episode new and review dispatch before request artifacts for every policy', () => {
  for (const policy of ['workstream-session', 'compact-in-place']) {
    for (const terminal of ['ready', 'merged', 'abandoned']) {
      const { root, runId } = fixture();
      const ws = newWorkstream(root, runId, `${policy}-${terminal}`);
      const loop = readState(root, runId).data;
      loop.autonomy.continuation_policy = policy;
      if (policy !== 'workstream-session') {
        for (const session of loop.session_chain.sessions) {
          session.scope = {
            kind: 'legacy', workstream_id: null, bound_at_seq: null,
            terminal_event: null, closed_at: session.ended_at ?? null,
          };
        }
        loop.autonomy.milestone_predicate = ['workstream_terminal'];
      }
      loop.workstreams.find(item => item.id === ws).status = terminal;
      writeState(root, runId, loop);
      const before = fileInventory(root, runId);

      const episode = runCli(root, runId, [
        'episode', 'new', '--plugin', 'deep-work', '--role', 'maker',
        '--kind', 'implementation', '--point', 'implementation', '--workstream', ws,
      ]);
      assert.equal(episode.status, 1, episode.stderr);
      assert.match(episode.stderr, /WORKSTREAM_TERMINAL_LOCKED/);
      assert.deepEqual(fileInventory(root, runId), before);

      const review = runCli(root, runId, [
        'review', 'dispatch', '--point', 'implementation', '--workstream', ws,
      ]);
      assert.equal(review.status, 1, review.stderr);
      assert.match(review.stderr, /WORKSTREAM_TERMINAL_LOCKED/);
      assert.deepEqual(fileInventory(root, runId), before);
    }
  }
});

test('public Workstream set and terminal routes reject a second Workstream before durable mutation', () => {
  const { root, runId } = fixture();
  const wsA = newWorkstream(root, runId, 'a');
  const wsB = newWorkstream(root, runId, 'b');
  const maker = newEpisode(root, runId, { workstream: wsA });
  const bind = runCli(root, runId, ['episode', 'record', '--id', maker, '--status', 'in_progress']);
  assert.equal(bind.status, 0, bind.stderr);

  const same = runCli(root, runId, ['workstream', 'set', '--id', wsA, '--status', 'in_review']);
  assert.equal(same.status, 0, same.stderr);
  for (const args of [
    ['workstream', 'set', '--id', wsB, '--status', 'in_progress'],
    ['workstream', 'terminal', '--id', wsB, '--status', 'abandoned', '--proof', '{"reason":"cross"}'],
  ]) {
    const before = fileInventory(root, runId);
    const result = runCli(root, runId, args);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SESSION_SCOPE_MISMATCH/);
    assert.deepEqual(fileInventory(root, runId), before);
  }
});
