import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { resolveSpawnMode } from '../scripts/lib/respawn.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const APPROVED_AT = '2026-07-23T00:00:00.000Z';

const attendedModule = () => import('../scripts/lib/attended-launch.mjs');

function seed({ status = 'running', phase = 'idle', leaseState = 'active' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-attended-'));
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'attended launch', now: new Date(APPROVED_AT),
    env: {}, platform: 'linux', run: () => ({ code: 1 }),
  });
  const { data } = readState(root, runId);
  data.status = status;
  data.session_chain.lease.handoff_phase = phase;
  data.session_chain.lease.state = leaseState;
  writeState(root, runId, data);
  return {
    root, runId,
    fence: { owner: data.session_chain.lease.owner_run_id, generation: data.session_chain.lease.generation },
  };
}

function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
}

test('attendedLaunchAuthorized accepts only the exact nested style-bound canonical approval', async () => {
  const { attendedLaunchAuthorized } = await attendedModule();
  const loop = {
    autonomy: {
      spawn_style: 'visible',
      attended_launch_approval: { style: 'visible', approved_at: APPROVED_AT },
    },
    session_spawn: { launcher: 'cmux' },
  };
  assert.equal(attendedLaunchAuthorized(loop, 'visible'), true);
  assert.equal(attendedLaunchAuthorized(loop, 'desktop'), false);

  const hostile = [
    { ...loop, autonomy: { ...loop.autonomy, attended_launch_approval: null }, attended_launch_approval: loop.autonomy.attended_launch_approval },
    { ...loop, autonomy: { ...loop.autonomy, attended_launch_approval: { style: 'visible', approved_at: '2026-07-23T00:00:00Z' } } },
    { ...loop, autonomy: { ...loop.autonomy, attended_launch_approval: { style: 'visible', approved_at: '2026-02-30T00:00:00.000Z' } } },
    { ...loop, autonomy: { ...loop.autonomy, attended_launch_approval: { style: 'visible', approved_at: APPROVED_AT, extra: true } } },
  ];
  for (const candidate of hostile) assert.equal(attendedLaunchAuthorized(candidate, 'visible'), false);
});

test('detected attended surfaces never auto-launch without durable approval', () => {
  for (const launcher of ['cmux', 'tmux', 'iterm2', 'terminal-app', 'wt', 'powershell']) {
    const loop = {
      autonomy: {
        spawn_style: 'visible', attended_launch_approval: null,
        session_runtime: 'claude', runtime_source: 'skill-asserted',
      },
      session_spawn: { launcher },
    };
    assert.equal(resolveSpawnMode(loop, { attended: true, env: {} }), 'interactive', launcher);
  }
});

test('approve visible atomically sets style and approval; desktop directs to nonce flow', async () => {
  const { approveAttendedLaunch } = await attendedModule();
  const f = seed();
  const approved = approveAttendedLaunch(f.root, f.runId, {
    style: 'visible', confirm: true, fence: f.fence, now: Date.parse(APPROVED_AT),
  });
  assert.equal(approved.ok, true);
  const after = readState(f.root, f.runId).data;
  assert.equal(after.autonomy.spawn_style, 'visible');
  assert.deepEqual(after.autonomy.attended_launch_approval, {
    style: 'visible', approved_at: APPROVED_AT,
  });
  assert.equal(after.event_log_head.seq, 1);

  const desktop = approveAttendedLaunch(f.root, f.runId, {
    style: 'desktop', confirm: true, fence: f.fence, now: Date.parse(APPROVED_AT),
  });
  assert.deepEqual(desktop, { ok: false, reason: 'DESKTOP_FLOW_REQUIRED' });
  assert.deepEqual(readState(f.root, f.runId).data.autonomy.attended_launch_approval,
    after.autonomy.attended_launch_approval);
  assert.equal(readState(f.root, f.runId).data.event_log_head.seq, 1);
});

test('approve rejects invalid confirmation, style, and timestamp before append', async () => {
  const { approveAttendedLaunch } = await attendedModule();
  for (const options of [
    { style: 'visible', confirm: false, now: Date.parse(APPROVED_AT), reason: 'CONFIRM_REQUIRED' },
    { style: 'interactive', confirm: true, now: Date.parse(APPROVED_AT), reason: 'STYLE_INVALID' },
    { style: 'visible', confirm: true, now: Number.POSITIVE_INFINITY, reason: 'INVALID_NOW' },
  ]) {
    const f = seed();
    const result = approveAttendedLaunch(f.root, f.runId, { ...options, fence: f.fence });
    assert.equal(result.ok, false);
    assert.equal(result.reason, options.reason);
    const after = readState(f.root, f.runId).data;
    assert.equal(after.event_log_head.seq, 0);
    assert.equal(after.autonomy.attended_launch_approval, null);
  }
});

test('revoke clears approval and pending nonce while running or safely paused', async () => {
  const { revokeAttendedLaunch } = await attendedModule();
  for (const status of ['running', 'paused']) {
    const f = seed({ status });
    const { data } = readState(f.root, f.runId);
    data.autonomy.spawn_style = 'visible';
    data.autonomy.attended_launch_approval = { style: 'visible', approved_at: APPROVED_AT };
    data.autonomy.spawn_style_optin_pending = {
      nonce: 'pending', expires_at: '2026-07-23T00:10:00.000Z',
    };
    writeState(f.root, f.runId, data);
    const result = revokeAttendedLaunch(f.root, f.runId, {
      confirm: true, fence: f.fence, now: Date.parse(APPROVED_AT),
    });
    assert.equal(result.ok, true);
    const after = readState(f.root, f.runId).data;
    assert.equal(after.autonomy.spawn_style, 'interactive');
    assert.equal(after.autonomy.attended_launch_approval, null);
    assert.equal(after.autonomy.spawn_style_optin_pending, undefined);
    assert.equal(after.event_log_head.seq, 1);
  }
});

test('revoke rejects every in-flight handoff shape without mutation', async () => {
  const { revokeAttendedLaunch } = await attendedModule();
  const cases = [
    ['reserved', 'releasing'],
    ['emitted', 'releasing'],
    ['spawned', 'releasing'],
    ['idle', 'releasing'],
    ['idle', 'released'],
  ];
  for (const [phase, leaseState] of cases) {
    const f = seed({ phase, leaseState });
    const { data } = readState(f.root, f.runId);
    data.autonomy.spawn_style = 'visible';
    data.autonomy.attended_launch_approval = { style: 'visible', approved_at: APPROVED_AT };
    writeState(f.root, f.runId, data);
    const before = readState(f.root, f.runId).data;
    const result = revokeAttendedLaunch(f.root, f.runId, {
      confirm: true, fence: f.fence, now: Date.parse(APPROVED_AT),
    });
    assert.deepEqual(result, { ok: false, reason: 'HANDOFF_IN_FLIGHT' });
    assert.deepEqual(readState(f.root, f.runId).data, before);
  }
});

test('attended-launch CLI exposes confirmation, desktop guidance, and stale-fence exits', () => {
  const f = seed();
  const missing = cli(f.root, [
    'attended-launch', 'approve', '--style', 'visible',
    '--owner', f.fence.owner, '--generation', String(f.fence.generation),
  ]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /CONFIRM_REQUIRED/);

  const desktop = cli(f.root, [
    'attended-launch', 'approve', '--style', 'desktop', '--confirm',
    '--owner', f.fence.owner, '--generation', String(f.fence.generation),
  ]);
  assert.equal(desktop.status, 1, desktop.stderr);
  assert.match(desktop.stderr, /spawn-style.*confirm-desktop/i);

  const stale = cli(f.root, [
    'attended-launch', 'approve', '--style', 'visible', '--confirm',
    '--owner', 'stale-owner', '--generation', String(f.fence.generation),
  ]);
  assert.equal(stale.status, 3, stale.stderr);
  assert.match(stale.stderr, /LEASE_FENCED/);
});

test('attended-launch CLI approve then revoke is symmetric; revoke terminal and missing-confirm exits are exact', () => {
  const f = seed();
  const approve = cli(f.root, [
    'attended-launch', 'approve', '--style', 'visible', '--confirm',
    '--owner', f.fence.owner, '--generation', String(f.fence.generation),
    '--now', String(Date.parse(APPROVED_AT)),
  ]);
  assert.equal(approve.status, 0, approve.stderr);
  assert.deepEqual(readState(f.root, f.runId).data.autonomy.attended_launch_approval, {
    style: 'visible', approved_at: APPROVED_AT,
  });

  const missing = cli(f.root, [
    'attended-launch', 'revoke',
    '--owner', f.fence.owner, '--generation', String(f.fence.generation),
  ]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /CONFIRM_REQUIRED/);

  const revoke = cli(f.root, [
    'attended-launch', 'revoke', '--confirm',
    '--owner', f.fence.owner, '--generation', String(f.fence.generation),
    '--now', String(Date.parse(APPROVED_AT)),
  ]);
  assert.equal(revoke.status, 0, revoke.stderr);
  const after = readState(f.root, f.runId).data;
  assert.equal(after.autonomy.spawn_style, 'interactive');
  assert.equal(after.autonomy.attended_launch_approval, null);

  const terminal = seed({ status: 'completed' });
  const rejected = cli(terminal.root, [
    'attended-launch', 'revoke', '--confirm',
    '--owner', terminal.fence.owner, '--generation', String(terminal.fence.generation),
  ]);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /RUN_TERMINAL/);
});
