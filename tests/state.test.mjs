import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync as _rfRoot, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join, dirname as _dn, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LOCK_STALE_TTL_MS, readState, writeState, patch, withLock, runDir, findRoot } from '../scripts/lib/state.mjs';
import * as stateApi from '../scripts/lib/state.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { flushDirectory } from '../scripts/lib/atomic-write.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';

const STATE_TEST_HERE = _dn(fileURLToPath(import.meta.url));
const STATE_TEST_CLI = join(STATE_TEST_HERE, '..', 'scripts', 'deep-loop.mjs');

function runStateCli(root, runId, args) {
  return spawnSync(process.execPath, [
    STATE_TEST_CLI, ...args, '--owner', runId, '--generation', '1',
    '--project-root', root, '--run-id', runId,
  ], { encoding: 'utf8' });
}

const atomicApiPromise = import('../scripts/lib/atomic-write.mjs').catch(() => ({}));

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const runId = 'R1';
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
  const data = {
    schema_version: '0.4.0', run_id: runId, goal: 'g', status: 'running',
    project: { root, binding_generation: 1 }, routing: { protocol: 'deep-work' }, review: { points: ['design'] },
    autonomy: { tier: 'recommend', spawn_style: 'interactive', continuation_policy: 'rotate-per-unit', attended_launch_approval: null }, budget: { unit: 'turns', spent: 5 },
    comprehension: {}, circuit_breaker: { tripped: false }, session_chain: { lease: { state: 'active', handoff_phase: 'idle', handoff_trigger: null, takeover_kind: null }, consumed_milestones: [], sessions: [] },
    workstreams: [{ id: 'ws-1', status: 'in_progress', depends_on: [] }], active_workstreams: ['ws-1'],
    triage: { actionable: [] }, episodes: [{ id: 'e1', status: 'pending', request_rel: 'episodes/e1/request.md' }], termination: {},
  };
  writeState(root, runId, data);
  return { root, runId };
}

test('read after write roundtrips', () => {
  const { root, runId } = seed();
  assert.equal(readState(root, runId).data.goal, 'g');
});

test('patch allowed field succeeds', () => {
  const { root, runId } = seed();
  patch(root, runId, 'triage.actionable', [{ id: 'x' }]);
  assert.equal(readState(root, runId).data.triage.actionable.length, 1);
});

test('patch forbidden field (budget.spent) throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'budget.spent', 0), /FIELD_FORBIDDEN/);
});

test('patch forbidden review.* throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'review.points', []), /FIELD_FORBIDDEN/);
});

// impl-R2 Fix 3: a whitelisted field with a schema-INVALID value (active_workstreams := non-array) must be rejected
// BEFORE the event append — otherwise appendEvent commits, writeState's validate throws, and the event-log tail
// out-runs the loop.json anchor → every later write bricks with LOG_TAMPERED.
test('patch pre-validates the candidate: an invalid whitelisted value throws without staling the anchor', () => {
  const { root, runId } = seed();
  const before = readState(root, runId).data.budget.spent;
  assert.throws(() => patch(root, runId, 'active_workstreams', 'bad'), /SCHEMA_INVALID/);
  assert.equal(readState(root, runId).data.budget.spent, before, 'a rejected patch must not charge the floor');
  // No brick: a subsequent valid patch still succeeds (would throw LOG_TAMPERED if the tail had advanced past the anchor).
  assert.doesNotThrow(() => patch(root, runId, 'triage.actionable', [{ id: 'x' }]));
  assert.equal(readState(root, runId).data.triage.actionable.length, 1);
});

test('tampered hash detected on read', () => {
  const { root, runId } = seed();
  writeFileSync(join(runDir(root, runId), 'loop.json'), '{"goal":"hacked"}'); // direct write, hash unchanged
  assert.throws(() => readState(root, runId), /STATE_TAMPERED/);
});

test('copied-root reads verify the loop hash before checking project-root binding', () => {
  const originalRoot = mkdtempSync(join(tmpdir(), 'dl-hash-first-original-'));
  const candidateRoot = mkdtempSync(join(tmpdir(), 'dl-hash-first-copy-'));
  const { runId } = initRun(originalRoot, { runtime: 'claude', goal: 'g', now: new Date('2026-07-11T00:00:00Z') });
  cpSync(join(originalRoot, '.deep-loop'), join(candidateRoot, '.deep-loop'), { recursive: true });
  writeFileSync(join(runDir(candidateRoot, runId), 'loop.json'), '{"goal":"tampered-copy"}');
  assert.throws(() => readState(candidateRoot, runId), /STATE_TAMPERED/);
});

test('whole-object array patch bypass is forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0', { status: 'done' }), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.0', { status: 'merged' }), /FIELD_FORBIDDEN/);
});

test('terminal status value via dotted path is forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.status', 'done'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.0.status', 'merged'), /FIELD_FORBIDDEN/);
});

test('non-terminal status + depends_on allowed', () => {
  const { root, runId } = seed();
  patch(root, runId, 'episodes.0.status', 'in_progress');
  patch(root, runId, 'workstreams.0.depends_on', ['ws-2']);
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
  assert.deepEqual(readState(root, runId).data.workstreams[0].depends_on, ['ws-2']);
});

test('public new-policy state patch requires typed lifecycle routes and scopes remaining indexed fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-state-scope-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-23T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  mkdirSync(join(root, '.claude/worktrees'), { recursive: true });
  const wsA = newWorkstream(root, runId, { title: 'a', branch: 'a', worktree: '.claude/worktrees/a', fence }).id;
  const wsB = newWorkstream(root, runId, { title: 'b', branch: 'b', worktree: '.claude/worktrees/b', fence }).id;
  const makerA = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: wsA, fence }).id;
  const makerB = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: wsB, fence }).id;
  recordEpisode(root, runId, makerA, { status: 'in_progress', fence });
  const loop = readState(root, runId).data;
  const epA = loop.episodes.findIndex(ep => ep.id === makerA);
  const epB = loop.episodes.findIndex(ep => ep.id === makerB);
  const idxA = loop.workstreams.findIndex(ws => ws.id === wsA);
  const idxB = loop.workstreams.findIndex(ws => ws.id === wsB);

  for (const [field, value] of [
    ['active_workstreams', '[]'],
    [`episodes.${epA}.status`, '"blocked"'],
    [`episodes.${epA}.status`, '"done"'],
    [`workstreams.${idxA}.status`, '"parked"'],
    [`workstreams.${idxA}.status`, '"ready"'],
  ]) {
    const result = runStateCli(root, runId, ['state', 'patch', '--field', field, '--value', value]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /PATCH_TYPED_ROUTE_REQUIRED/);
  }

  for (const [field, value] of [
    [`episodes.${epA}.result_note`, '"same"'],
    [`workstreams.${idxA}.depends_on`, '[]'],
  ]) {
    const result = runStateCli(root, runId, ['state', 'patch', '--field', field, '--value', value]);
    assert.equal(result.status, 0, result.stderr);
  }
  for (const [field, value] of [
    [`episodes.${epB}.result_note`, '"cross"'],
    [`workstreams.${idxB}.depends_on`, '[]'],
  ]) {
    const before = _rfRoot(join(runDir(root, runId), 'loop.json'));
    const logBefore = _rfRoot(join(runDir(root, runId), 'event-log.jsonl'));
    const result = runStateCli(root, runId, ['state', 'patch', '--field', field, '--value', value]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SESSION_SCOPE_MISMATCH/);
    assert.equal(_rfRoot(join(runDir(root, runId), 'loop.json')).equals(before), true);
    assert.equal(_rfRoot(join(runDir(root, runId), 'event-log.jsonl')).equals(logBefore), true);
  }
});

test('public authentic legacy state patch retains the v1.10 whitelist', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-state-legacy-scope-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-23T00:00:00Z') });
  const loop = readState(root, runId).data;
  loop.autonomy.continuation_policy = 'rotate-per-unit';
  loop.autonomy.milestone_predicate = ['workstream_terminal'];
  for (const session of loop.session_chain.sessions) {
    session.scope = { kind: 'legacy', workstream_id: null, bound_at_seq: null, terminal_event: null, closed_at: session.ended_at ?? null };
  }
  writeState(root, runId, loop);
  assert.equal(runStateCli(root, runId, ['state', 'patch', '--field', 'active_workstreams', '--value', '[]']).status, 0);
  assert.equal(runStateCli(root, runId, ['state', 'patch', '--field', 'triage.actionable', '--value', '[]']).status, 0);
});

test('non-status workstream field (title) forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'workstreams.0.title', 'x'), /FIELD_FORBIDDEN/);
});

test('episode result sub-path / lookalike forbidden, only result_* allowed', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.result.status', 'x'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'episodes.0.resultEvil', 'x'), /FIELD_FORBIDDEN/);
  patch(root, runId, 'episodes.0.result_summary', 'ok'); // allowed
  assert.equal(readState(root, runId).data.episodes[0].result_summary, 'ok');
});

test('missing hash anchor fails closed', () => {
  const { root, runId } = seed();
  rmSync(join(runDir(root, runId), '.loop.hash'));
  assert.throws(() => readState(root, runId), /STATE_TAMPERED/);
});

test('prototype-pollution field path forbidden', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.__proto__', { x: 1 }), /FIELD_FORBIDDEN/);
});

test('a manually-created empty stale lock is indeterminate and never age-reclaimed', () => {
  const { root, runId } = seed();
  const lock = join(runDir(root, runId), '.lock');
  mkdirSync(lock);
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.throws(() => withLock(root, runId, () => {}, { retries: 1, backoffMs: 0 }), /LOCK_BUSY/);
  assert.equal(statSync(lock).isDirectory(), true);
});

test('withLock persists canonical ownership before exposing a frozen guard', () => {
  const { root, runId } = seed();
  const now = 1_782_864_000_000;
  const token = '11111111-1111-4111-8111-111111111111';
  withLock(root, runId, guard => {
    assert.equal(Object.isFrozen(guard), true);
    assert.deepEqual(Object.keys(guard), ['token', 'assertOwned', 'renew']);
    assert.equal(guard.token, token);
    const lock = join(runDir(root, runId), '.lock');
    const ownerPath = join(lock, 'owner.json');
    const owner = JSON.parse(_rfRoot(ownerPath, 'utf8'));
    assert.deepEqual(Object.keys(owner), [
      'protocol_version', 'token', 'pid', 'hostname', 'acquired_at_ms', 'heartbeat_at_ms', 'lock_identity',
    ]);
    assert.equal(owner.protocol_version, 1);
    assert.equal(owner.token, token);
    assert.equal(owner.pid, 4242);
    assert.equal(owner.hostname, hostname().normalize('NFC').toLowerCase());
    assert.equal(owner.acquired_at_ms, now);
    assert.equal(owner.heartbeat_at_ms, now);
    assert.deepEqual(Object.keys(owner.lock_identity), ['dev', 'ino', 'birthtime_ns']);
    if (process.platform !== 'win32') {
      assert.equal(statSync(ownerPath).mode & 0o777, 0o600);
    }
    assert.doesNotThrow(() => guard.assertOwned());
  }, {
    nowFn: () => now,
    hostnameFn: hostname,
    pid: 4242,
    tokenFactory: () => token,
  });
});

test('withLock guard binds optional run validation without changing its public keys', () => {
  const first = seed();
  const second = seed();
  withLock(first.root, first.runId, guard => {
    assert.deepEqual(Object.keys(guard), ['token', 'assertOwned', 'renew']);
    assert.doesNotThrow(() => guard.assertOwned(runDir(first.root, first.runId)));
    assert.doesNotThrow(() => guard.renew(runDir(first.root, first.runId)));
    assert.throws(() => guard.assertOwned(runDir(second.root, second.runId)), /LOCK_RUN_MISMATCH/);
    assert.throws(() => guard.renew(runDir(second.root, second.runId)), /LOCK_RUN_MISMATCH/);
  });
});

test('withLock renews the heartbeat under the same ownership token and identity', () => {
  const { root, runId } = seed();
  let now = 1_782_864_000_000;
  const token = '22222222-2222-4222-8222-222222222222';
  withLock(root, runId, guard => {
    const ownerPath = join(runDir(root, runId), '.lock', 'owner.json');
    const before = JSON.parse(_rfRoot(ownerPath, 'utf8'));
    now += 5_000;
    guard.renew();
    const after = JSON.parse(_rfRoot(ownerPath, 'utf8'));
    assert.equal(after.token, before.token);
    assert.deepEqual(after.lock_identity, before.lock_identity);
    assert.equal(after.acquired_at_ms, before.acquired_at_ms);
    assert.equal(after.heartbeat_at_ms, now);
  }, { nowFn: () => now, tokenFactory: () => token });
});

test('a released guard cannot validate a successor lock', () => {
  const { root, runId } = seed();
  let stale;
  withLock(root, runId, guard => { stale = guard; }, {
    tokenFactory: () => '33333333-3333-4333-8333-333333333333',
  });
  withLock(root, runId, () => {
    assert.throws(() => stale.assertOwned(), /LOCK_OWNERSHIP_LOST/);
    assert.throws(() => stale.renew(), /LOCK_OWNERSHIP_LOST/);
  }, { tokenFactory: () => '44444444-4444-4444-8444-444444444444' });
});

test('a local definitely-dead stale owner is quarantined before reclaim', () => {
  const { root, runId } = seed();
  let now = 1_000;
  withLock(root, runId, () => {}, {
    nowFn: () => now,
    pid: 40_001,
    tokenFactory: () => '55555555-5555-4555-8555-555555555555',
    faultAt(label) { if (label === 'release:validated') throw new Error('KILL'); },
  });
  now += LOCK_STALE_TTL_MS + 1;
  const labels = [];
  const flushes = [];
  let entered = false;
  withLock(root, runId, () => { entered = true; }, {
    nowFn: () => now,
    pid: 40_002,
    tokenFactory: () => '66666666-6666-4666-8666-666666666666',
    probePid: () => 'dead',
    faultAt(label) { labels.push(label); },
    flushDirectoryFn(path) { flushes.push(path); flushDirectory(path); },
    retries: 2,
    backoffMs: 0,
  });
  assert.equal(entered, true);
  assert.ok(labels.includes('reclaim:quarantined'));
  assert.ok(labels.includes('reclaim:quarantine-parent-flushed'));
  assert.ok(labels.includes('reclaim:deleted'));
  assert.ok(labels.includes('reclaim:delete-parent-flushed'));
  assert.ok(flushes.filter(path => path === runDir(root, runId)).length >= 2);
});

test('an interrupted dead-owner quarantine is revalidated and completed exactly once', () => {
  const { root, runId } = seed();
  let now = 1_000;
  withLock(root, runId, () => {}, {
    nowFn: () => now, pid: 40_101,
    tokenFactory: () => '10101010-1010-4010-8010-101010101010',
    faultAt(label) { if (label === 'release:validated') throw new Error('KILL'); },
  });
  now += LOCK_STALE_TTL_MS + 1;
  assert.throws(() => withLock(root, runId, () => {}, {
    nowFn: () => now, pid: 40_102,
    tokenFactory: () => '20202020-2020-4020-8020-202020202020',
    probePid: () => 'dead', retries: 1, backoffMs: 0,
    faultAt(label) { if (label === 'reclaim:quarantined') throw new Error('KILL'); },
  }), /KILL/);
  const run = runDir(root, runId);
  assert.equal(existsSync(join(run, '.lock')), false);
  assert.equal(readdirSync(run)
    .some(name => name.startsWith('.lock.quarantine-')), true);
  let entered = false;
  const resumeLabels = [];
  const resumeFlushes = [];
  withLock(root, runId, () => { entered = true; }, {
    nowFn: () => now, pid: 40_103,
    tokenFactory: () => '30303030-3030-4030-8030-303030303030',
    probePid: () => 'dead', retries: 1, backoffMs: 0,
    faultAt(label) { resumeLabels.push(label); },
    flushDirectoryFn(path) { resumeFlushes.push(path); flushDirectory(path); },
  });
  assert.equal(entered, true);
  assert.equal(readdirSync(run)
    .some(name => name.startsWith('.lock.quarantine-')), false);
  assert.ok(resumeLabels.includes('reclaim:resumed-deleted'));
  assert.ok(resumeLabels.includes('reclaim:resumed-delete-parent-flushed'));
  assert.ok(resumeFlushes.includes(run));
});

test('live, reused, EPERM, or unknown stale owners remain busy beyond the TTL', () => {
  for (const liveness of ['alive', 'unknown', 'eperm']) {
    const { root, runId } = seed();
    let now = 1_000;
    withLock(root, runId, () => {}, {
      nowFn: () => now,
      pid: 41_001,
      tokenFactory: () => '77777777-7777-4777-8777-777777777777',
      faultAt(label) { if (label === 'release:validated') throw new Error('KILL'); },
    });
    now += LOCK_STALE_TTL_MS + 1;
    assert.throws(() => withLock(root, runId, () => {}, {
      nowFn: () => now,
      pid: 41_002,
      tokenFactory: () => '88888888-8888-4888-8888-888888888888',
      probePid: () => {
        if (liveness === 'eperm') throw Object.assign(new Error('denied'), { code: 'EPERM' });
        return liveness;
      },
      retries: 1,
      backoffMs: 0,
    }), /LOCK_BUSY/, liveness);
  }
});

test('foreign-host and missing-owner stale locks fail closed', () => {
  const foreign = seed();
  let now = 1_000;
  withLock(foreign.root, foreign.runId, () => {}, {
    nowFn: () => now,
    hostnameFn: () => 'foreign.example',
    pid: 42_001,
    tokenFactory: () => '99999999-9999-4999-8999-999999999999',
    faultAt(label) { if (label === 'release:validated') throw new Error('KILL'); },
  });
  now += LOCK_STALE_TTL_MS + 1;
  assert.throws(() => withLock(foreign.root, foreign.runId, () => {}, {
    nowFn: () => now,
    hostnameFn: () => 'local.example',
    pid: 42_002,
    tokenFactory: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    probePid: () => 'dead', retries: 1, backoffMs: 0,
  }), /LOCK_BUSY/);

  const missing = seed();
  const lock = join(runDir(missing.root, missing.runId), '.lock');
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.throws(() => withLock(missing.root, missing.runId, () => {}, {
    probePid: () => 'dead', retries: 1, backoffMs: 0,
  }), /LOCK_BUSY/);
});

test('token drift and directory replacement fence the guard and preserve the successor', () => {
  const tokenDrift = seed();
  withLock(tokenDrift.root, tokenDrift.runId, guard => {
    const ownerPath = join(runDir(tokenDrift.root, tokenDrift.runId), '.lock', 'owner.json');
    const owner = JSON.parse(_rfRoot(ownerPath, 'utf8'));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    assert.throws(() => guard.assertOwned(), /LOCK_OWNERSHIP_LOST/);
  }, { tokenFactory: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });

  const replaced = seed();
  const lock = join(runDir(replaced.root, replaced.runId), '.lock');
  const displaced = `${lock}.displaced`;
  withLock(replaced.root, replaced.runId, guard => {
    renameSync(lock, displaced);
    mkdirSync(lock);
    writeFileSync(join(lock, 'successor'), 'keep');
    assert.throws(() => guard.assertOwned(), /LOCK_OWNERSHIP_LOST/);
  });
  assert.equal(_rfRoot(join(lock, 'successor'), 'utf8'), 'keep');
});

test('release quarantine cannot remove a successor created at the lock path', () => {
  const { root, runId } = seed();
  const lock = join(runDir(root, runId), '.lock');
  const labels = [];
  const flushes = [];
  withLock(root, runId, () => {}, {
    tokenFactory: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    faultAt(label) {
      labels.push(label);
      if (label === 'release:quarantined') {
        mkdirSync(lock);
        writeFileSync(join(lock, 'successor'), 'keep');
      }
    },
    flushDirectoryFn(path) { flushes.push(path); flushDirectory(path); },
  });
  assert.equal(_rfRoot(join(lock, 'successor'), 'utf8'), 'keep');
  assert.ok(labels.includes('release:quarantine-parent-flushed'));
  assert.ok(labels.includes('release:deleted'));
  assert.ok(labels.includes('release:delete-parent-flushed'));
  assert.ok(flushes.filter(path => path === runDir(root, runId)).length >= 2);
});

test('a competing command cannot age-reap an active owner during blocked synchronous work', () => {
  const { root, runId } = seed();
  let now = 1_000;
  withLock(root, runId, guard => {
    now += LOCK_STALE_TTL_MS + 1;
    assert.throws(() => withLock(root, runId, () => {}, {
      nowFn: () => now,
      pid: 43_002,
      tokenFactory: () => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      probePid: () => 'alive', retries: 1, backoffMs: 0,
    }), /LOCK_BUSY/);
    assert.doesNotThrow(() => guard.assertOwned());
  }, {
    nowFn: () => now,
    pid: 43_001,
    tokenFactory: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  });
});

test('lock and rename timing constants pin the two-replacement transaction budget', async () => {
  const stateApi = await import('../scripts/lib/state.mjs');
  const atomicApi = await atomicApiPromise;
  assert.equal(stateApi.LOCK_STALE_TTL_MS, 30_000);
  assert.equal(atomicApi.RENAME_RETRY_MAX_ELAPSED_MS, 1_000);
  assert.ok(2 * atomicApi.RENAME_RETRY_MAX_ELAPSED_MS < stateApi.LOCK_STALE_TTL_MS / 10);
});

test('writeState performs exactly the loop and hash atomic replacements', () => {
  const { root, runId } = seed();
  const data = readState(root, runId).data;
  const replacements = [];
  writeState(root, runId, data, {
    atomicWriteFn: (path, contents) => { replacements.push({ path, contents }); },
  });
  assert.deepEqual(replacements.map(({ path }) => basename(path)), ['loop.json', '.loop.hash']);
});

test('a live directory lock remains busy before the default stale TTL', () => {
  const { root, runId } = seed();
  const lock = join(runDir(root, runId), '.lock');
  mkdirSync(lock);
  assert.throws(() => withLock(root, runId, () => {}, { retries: 1, backoffMs: 0 }), /LOCK_BUSY/);
});

// Codex impl r12 🔴: runId must be a safe single path segment — a '../' (or slash) runId would let runDir
// resolve outside the project root and every state/event/episode/handoff writer would escape.
test('runDir rejects unsafe run-id path segments', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  for (const bad of ['../evil', '..', '.', 'a/b', 'a\\b', '', null]) {
    assert.throws(() => runDir(root, bad), /RUN_ID_INVALID/, `runId ${JSON.stringify(bad)} should be rejected`);
  }
  // a normal ULID-ish id is accepted
  assert.ok(runDir(root, '01KVWFJA0QKSCMN8XMQ0WJXBBC').endsWith('01KVWFJA0QKSCMN8XMQ0WJXBBC'));
});

test('patch enforces fence inside the lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pf-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  patch(root, runId, 'discovered_items', ['a'], { fence: { owner: runId, generation: 1, intent: 'business' } });
  assert.deepEqual(readState(root, runId).data.discovered_items, ['a']);
  assert.throws(() => patch(root, runId, 'discovered_items', ['b'], { fence: { owner: runId, generation: 9, intent: 'business' } }), /LEASE_FENCED/);
  // forbidden field 는 fence 와 무관하게 거부
  assert.throws(() => patch(root, runId, 'budget.spent', 1, { fence: { owner: runId, generation: 1, intent: 'business' } }), /FIELD_FORBIDDEN/);
});

test('patch: cannot set episode status to abandoned (classifyPatch forbids)', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.0.status', 'abandoned'), /FIELD_FORBIDDEN/);
});

test('patch: cannot resurrect a terminal episode to non-terminal via patch', () => {
  const { root, runId } = seed();
  const data = readState(root, runId).data;
  data.episodes[0].status = 'abandoned';
  writeState(root, runId, data);
  assert.throws(() => patch(root, runId, 'episodes.0.status', 'pending'), /FIELD_FORBIDDEN/);
});

test('patch: out-of-range index rejected for all indexed sub-fields (no phantom item)', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.5.status', 'in_progress'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'episodes.5.result_summary', 'x'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.9.status', 'in_progress'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.9.depends_on', ['x']), /FIELD_FORBIDDEN/);
});

test('patch: non-canonical (leading-zero) index rejected on both arrays', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'episodes.01.status', 'in_progress'), /FIELD_FORBIDDEN/);
  assert.throws(() => patch(root, runId, 'workstreams.01.depends_on', ['x']), /FIELD_FORBIDDEN/);
});

test('patch: non-terminal workstream status allowed; terminal workstream resurrection rejected', () => {
  const { root, runId } = seed();   // workstreams[0]=ws-1, status in_progress
  patch(root, runId, 'workstreams.0.status', 'in_progress');                 // non-terminal → allowed
  assert.equal(readState(root, runId).data.workstreams[0].status, 'in_progress');
  const data = readState(root, runId).data; data.workstreams[0].status = 'ready'; writeState(root, runId, data);  // fix terminal
  assert.throws(() => patch(root, runId, 'workstreams.0.status', 'in_progress'), /FIELD_FORBIDDEN/);   // resurrection rejected
});

test('findRoot: from .claude/worktrees/<slug> resolves to main root (bounded)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fr-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), 'run-x');
  const wt = join(root, '.claude', 'worktrees', 'ws-01');
  mkdirSync(wt, { recursive: true });
  assert.equal(findRoot(wt), root, 'from worktree resolves to main root');
  assert.equal(findRoot(join(root, '.worktrees', 'ws-02')), root, '.worktrees convention too');
  assert.equal(findRoot(root), root, 'at root resolves to root');
});

test('findRoot: falls back to startDir when no .deep-loop/current ancestor', () => {
  const d = mkdtempSync(join(tmpdir(), 'fr2-'));
  assert.equal(findRoot(d), d, 'no marker → startDir fallback (init-run path)');
});

test('findRoot: does NOT bind a nested repo under a parent run (R5 high-2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fr3-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), 'run-parent');
  const nested = join(root, 'some', 'nested-repo');
  mkdirSync(nested, { recursive: true });
  // nested dir 은 worktree 컨벤션 밖 → 부모 run 으로 올라가지 않고 자기 자신 반환(격리 유지).
  assert.equal(findRoot(nested), nested, 'nested non-worktree dir resolves to itself, not parent run');
});

// FIX H: nested convention worktrees — <root>/.claude/worktrees/a/.claude/worktrees/b
// 내부 base(<root>/.claude/worktrees/a)에 .deep-loop/current 없어도 계속 탐색해 외부 root 발견.
test('findRoot: nested convention worktrees resolves to outer root with .deep-loop/current (FIX H)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fr4-'));
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), 'run-outer');
  // nested: <root>/.claude/worktrees/a/.claude/worktrees/b
  const nested = join(root, '.claude', 'worktrees', 'a', '.claude', 'worktrees', 'b');
  mkdirSync(nested, { recursive: true });
  // inner base <root>/.claude/worktrees/a has no .deep-loop/current — should NOT stop here
  assert.equal(findRoot(nested), root, 'nested convention: inner base without marker continues to outer root');
});

function findVirtualWindowsRoot(startDir, marker) {
  return findRoot(startDir, {
    pathApi: win32,
    existsSync: candidate => win32.normalize(candidate).toLowerCase() === win32.normalize(marker).toLowerCase(),
  });
}

test('findRoot preserves a Windows drive root instead of reducing it to drive-relative C:', () => {
  assert.equal(
    findVirtualWindowsRoot('C:\\.worktrees\\ws-drive\\src', 'C:\\.deep-loop\\current'),
    'C:\\',
  );
});

test('findRoot preserves the outer project root through nested Windows convention worktrees', () => {
  assert.equal(
    findVirtualWindowsRoot(
      'C:\\repo\\.claude\\worktrees\\outer\\.worktrees\\inner\\src',
      'C:\\repo\\.deep-loop\\current',
    ),
    'C:\\repo',
  );
});

test('findRoot preserves a UNC share root while walking convention ancestors', () => {
  assert.equal(
    findVirtualWindowsRoot(
      '\\\\server\\share\\.claude\\worktrees\\ws-unc\\src',
      '\\\\server\\share\\.deep-loop\\current',
    ),
    '\\\\server\\share\\',
  );
});

test('findRoot matches mixed-case .claude/worktrees components under Windows drive-root semantics', () => {
  assert.equal(
    findVirtualWindowsRoot('C:\\.ClAuDe\\WoRkTrEeS\\ws-drive\\src', 'C:\\.deep-loop\\current'),
    'C:\\',
  );
});

test('findRoot matches a mixed-case .worktrees component under Windows drive-root semantics', () => {
  assert.equal(
    findVirtualWindowsRoot('D:\\.WoRkTrEeS\\ws-drive\\src', 'D:\\.deep-loop\\current'),
    'D:\\',
  );
});

test('findRoot matches mixed-case convention components under Windows UNC semantics', () => {
  assert.equal(
    findVirtualWindowsRoot(
      '\\\\ServerCase\\ShareCase\\.ClAuDe\\WoRkTrEeS\\ws-unc\\src',
      '\\\\servercase\\sharecase\\.deep-loop\\current',
    ),
    '\\\\ServerCase\\ShareCase\\',
  );
});

test('findRoot continues past a markerless inner mixed-case Windows convention and preserves outer base spelling', () => {
  assert.equal(
    findVirtualWindowsRoot(
      'C:\\RepoCase\\.ClAuDe\\WoRkTrEeS\\outer\\.WoRkTrEeS\\inner\\src',
      'c:\\repocase\\.deep-loop\\current',
    ),
    'C:\\RepoCase',
  );
});

test('findRoot rejects a non-convention sibling spelling despite Windows case-insensitive semantics', () => {
  const startDir = 'C:\\RepoCase\\.WoRkTrEeS-sibling\\ws\\src';
  assert.equal(
    findVirtualWindowsRoot(startDir, 'C:\\RepoCase\\.deep-loop\\current'),
    startDir,
  );
});

test('findRoot keeps convention component matching case-sensitive under POSIX semantics', () => {
  const startDir = '/repo/.CLAUDE/WORKTREES/ws/src';
  assert.equal(
    findRoot(startDir, {
      pathApi: posix,
      existsSync: candidate => posix.normalize(candidate) === '/repo/.deep-loop/current',
    }),
    startDir,
  );
});

const _R = _dn(_dn(fileURLToPath(import.meta.url)));   // repo root (tests/..)
test('findRoot is shared across CLI + hook + headless entrypoints', () => {
  for (const f of ['scripts/deep-loop.mjs', 'scripts/hooks-impl/precompact-handoff.mjs', 'scripts/hooks-impl/drive-headless.mjs']) {
    assert.match(_rfRoot(join(_R, f), 'utf8'), /findRoot\s*\(/, `${f} must resolve root via shared findRoot`);
  }
});

test('captureReconciledRunSnapshot returns immutable-by-copy verified loop/hash/log bytes', () => {
  assert.equal(typeof stateApi.captureReconciledRunSnapshot, 'function');
  const root = mkdtempSync(join(tmpdir(), 'dl-snapshot-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'snapshot', now: new Date('2026-07-23T00:00:00.000Z'),
  });
  const first = stateApi.captureReconciledRunSnapshot(root, runId);
  first.loopBytes.fill(0);
  first.hashBytes.fill(0);
  first.logBytes.fill(0);
  first.data.goal = 'mutated-return-value';

  const second = stateApi.captureReconciledRunSnapshot(root, runId);
  assert.equal(second.data.goal, 'snapshot');
  assert.equal(contentHash(second.loopBytes), second.hash);
  assert.equal(second.hashBytes.toString('utf8').trim(), second.hash);
  assert.deepEqual(second.logLines, []);
});

test('captureReconciledRunSnapshot captures only route-declared artifact bytes under the same immutable snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-artifact-snapshot-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'artifact snapshot', now: new Date('2026-07-23T00:00:00.000Z'),
  });
  const terminal = join(runDir(root, runId), 'terminal');
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, 'launch-command.txt'), 'candidate launch\n');

  const snapshot = stateApi.captureReconciledRunSnapshot(root, runId, {
    artifactRels: ['terminal/launch-command.txt', 'terminal/launch-command.meta.json'],
  });
  assert.deepEqual(Object.keys(snapshot.artifacts), [
    'terminal/launch-command.txt',
    'terminal/launch-command.meta.json',
  ]);
  assert.equal(snapshot.artifacts['terminal/launch-command.txt'].state, 'present');
  assert.equal(snapshot.artifacts['terminal/launch-command.txt'].bytes.toString(), 'candidate launch\n');
  assert.equal(
    snapshot.artifacts['terminal/launch-command.txt'].sha256,
    contentHash(Buffer.from('candidate launch\n')),
  );
  assert.deepEqual(snapshot.artifacts['terminal/launch-command.meta.json'], { state: 'absent' });

  snapshot.artifacts['terminal/launch-command.txt'].bytes.fill(0);
  const reopened = stateApi.captureReconciledRunSnapshot(root, runId, {
    artifactRels: ['terminal/launch-command.txt'],
  });
  assert.equal(reopened.artifacts['terminal/launch-command.txt'].bytes.toString(), 'candidate launch\n');
  assert.throws(
    () => stateApi.captureReconciledRunSnapshot(root, runId, { artifactRels: ['../loop.json'] }),
    /ARTIFACT_REL_INVALID/,
  );
});

test('withReconciledMutationLock repairs a prepared candidate before invoking its fixed writer callback', () => {
  assert.equal(typeof stateApi.withReconciledMutationLock, 'function');
  const root = mkdtempSync(join(tmpdir(), 'dl-writer-barrier-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'writer barrier', now: new Date('2026-07-23T00:00:00.000Z'),
  });
  assert.throws(() => appendAnchored(
    root,
    runId,
    { type: 'prepared-first', data: {}, now: '2026-07-23T00:01:00.000Z' },
    loop => { loop.discovered_items.push('candidate'); },
    undefined,
    {
      publication: {
        kind: 'writer-barrier', operationId: 'writer-barrier', artifacts: [], topology: {},
        faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('barrier'); },
      },
    },
  ), /TRANSACTION_PENDING/);

  stateApi.withReconciledMutationLock(root, runId, (_guard, snapshot) => {
    assert.deepEqual(snapshot.data.discovered_items, ['candidate']);
  });
});
