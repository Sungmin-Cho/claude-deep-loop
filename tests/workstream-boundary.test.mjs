import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { abandonEpisode, newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';
import * as finishModule from '../scripts/lib/finish.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const NOW = '2026-07-23T04:05:06.789Z';

function fence(runId, generation = 1) {
  return { owner: runId, generation, intent: 'business' };
}

function runCli(root, runId, args, generation = 1) {
  return spawnSync(process.execPath, [
    CLI, ...args,
    '--owner', runId, '--generation', String(generation),
    '--run-id', runId, '--project-root', root,
  ], { encoding: 'utf8' });
}

function durableBytes(root) {
  const files = {};
  const visit = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.lock') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, rel);
      else files[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return files;
}

function seedReviewed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-workstream-boundary-'));
  const review = {
    points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model',
    flags: [], converge: true, max_review_rounds: 5, require_human_ack: false,
  };
  const { runId } = initRun(root, {
    runtime: 'claude', goal: 'g', review, now: new Date('2026-07-23T00:00:00.000Z'),
  });
  const f = fence(runId);
  const worktree = '.claude/worktrees/closure';
  mkdirSync(join(root, worktree), { recursive: true });
  const ws = newWorkstream(root, runId, {
    title: 'closure', branch: 'feature/closure', worktree, fence: f,
  }).id;
  const baseline = addDoneMaker({ root, runId, f, ws, worktree }, 'baseline');
  const checker = dispatchReview(root, runId, {
    point: 'implementation', workstreamId: ws, detected: {}, fence: f,
  }).checkerEpisodeId;
  const report = `${worktree}/baseline-review.md`;
  writeFileSync(join(root, report), '# baseline review\nAPPROVE\n');
  recordReviewOutcome(root, runId, {
    episodeId: checker, verdict: 'APPROVE', proof: { report }, fence: f,
  });
  return { root, runId, f, ws, worktree, baseline, checker };
}

function addMaker(f, name) {
  const artifact = `${f.worktree}/${name}.txt`;
  mkdirSync(dirname(join(f.root, artifact)), { recursive: true });
  writeFileSync(join(f.root, artifact), `${name}\n`);
  const id = newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation',
    workstream: f.ws, expectedArtifacts: [artifact], fence: f.f,
  }).id;
  return { id, artifact };
}

function addDoneMaker(f, name) {
  const maker = addMaker(f, name);
  recordEpisode(f.root, f.runId, maker.id, { status: 'in_progress', fence: f.f });
  recordEpisode(f.root, f.runId, maker.id, {
    status: 'done', artifacts: [maker.artifact], proof: {}, fence: f.f,
  });
  return maker.id;
}

function addApprovedReview(f, makerId, name) {
  const checkerId = dispatchReview(f.root, f.runId, {
    point: 'implementation', workstreamId: f.ws, detected: {}, fence: f.f,
  }).checkerEpisodeId;
  const report = `${f.worktree}/${name}-review.md`;
  writeFileSync(join(f.root, report), `# ${name} review\nAPPROVE\n`);
  recordReviewOutcome(f.root, f.runId, {
    episodeId: checkerId, verdict: 'APPROVE', proof: { report }, fence: f.f,
  });
  return { makerId, checkerId };
}

function prepareDefect(kind) {
  const f = seedReviewed();
  if (kind === 'pending') {
    addMaker(f, 'pending');
  } else if (kind === 'in-progress') {
    const maker = addMaker(f, 'in-progress');
    recordEpisode(f.root, f.runId, maker.id, { status: 'in_progress', fence: f.f });
  } else if (kind === 'blocked') {
    const maker = addMaker(f, 'blocked');
    recordEpisode(f.root, f.runId, maker.id, { status: 'in_progress', fence: f.f });
    recordEpisode(f.root, f.runId, maker.id, { status: 'blocked', proof: {}, fence: f.f });
  } else if (kind === 'done-unreviewed') {
    addDoneMaker(f, 'done-unreviewed');
  } else if (kind === 'unresolved-rejected') {
    addDoneMaker(f, 'unresolved-rejected');
    const checkerId = dispatchReview(f.root, f.runId, {
      point: 'implementation', workstreamId: f.ws, detected: {}, fence: f.f,
    }).checkerEpisodeId;
    recordReviewOutcome(f.root, f.runId, {
      episodeId: checkerId, verdict: 'REQUEST_CHANGES', fence: f.f,
    });
  } else if (kind === 'latest-checker-rejected') {
    const makerId = addDoneMaker(f, 'latest-checker-rejected');
    addApprovedReview(f, makerId, 'latest-checker-approved-first');
    const state = readState(f.root, f.runId).data;
    state.episodes.push({
      id: '999-subagent-checker',
      plugin: 'subagent-checker',
      role: 'checker',
      kind: 'implementation-review',
      point: 'implementation',
      workstream_id: f.ws,
      target_maker: makerId,
      status: 'rejected',
      request_rel: 'episodes/999-subagent-checker/request.md',
    });
    writeState(f.root, f.runId, state);
  } else if (kind === 'contract-unpinned') {
    const state = readState(f.root, f.runId).data;
    state.recipe = { id: 'harness-hill-climb' };
    delete state.episodes.find(ep => ep.id === f.checker).contract;
    writeState(f.root, f.runId, state);
  } else {
    throw new Error(`unknown defect: ${kind}`);
  }
  return f;
}

function terminalArgs(ws, status, { confirm = status === 'abandoned' } = {}) {
  const proof = status === 'ready'
    ? {}
    : status === 'merged'
      ? { merge_commit: 'abc123', human_approved: true }
      : { reason: 'confirmed cancellation' };
  return [
    'workstream', 'terminal', '--id', ws, '--status', status,
    '--proof', JSON.stringify(proof), '--now', NOW,
    ...(confirm ? ['--confirm'] : []),
  ];
}

for (const status of ['ready', 'abandoned']) {
  for (const defect of [
    'pending',
    'in-progress',
    'blocked',
    'unresolved-rejected',
    'done-unreviewed',
    'latest-checker-rejected',
    'contract-unpinned',
  ]) {
    test(`public ${status} rejects ${defect} closure proof without durable mutation`, () => {
      const f = prepareDefect(defect);
      const before = durableBytes(f.root);
      const result = runCli(f.root, f.runId, terminalArgs(f.ws, status));
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /WORKSTREAM_CLOSURE_UNMET/);
      assert.deepEqual(durableBytes(f.root), before);
    });
  }
}

test('stale terminal fence wins over closure defects and preserves all bytes', () => {
  const f = prepareDefect('pending');
  const before = durableBytes(f.root);
  const result = runCli(f.root, f.runId, terminalArgs(f.ws, 'ready'), 9);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /LEASE_FENCED/);
  assert.doesNotMatch(result.stderr, /WORKSTREAM_CLOSURE_UNMET/);
  assert.deepEqual(durableBytes(f.root), before);
});

for (const status of ['ready', 'abandoned']) {
  test(`${status} closes once after per-episode settlement with exact anchored identity`, () => {
    const f = seedReviewed();
    const pending = addMaker(f, `${status}-cancelled`);
    const blocked = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /WORKSTREAM_CLOSURE_UNMET/);

    abandonEpisode(f.root, f.runId, pending.id, {
      reason: 'explicitly cancelled', confirm: true, fence: f.f,
    });
    const result = runCli(f.root, f.runId, terminalArgs(f.ws, status));
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const state = readState(f.root, f.runId).data;
    const ws = state.workstreams.find(item => item.id === f.ws);
    const scope = state.session_chain.sessions.find(session => session.run_id === f.runId).scope;
    const events = readFileSync(join(f.root, '.deep-loop', 'runs', f.runId, 'event-log.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const terminal = events.findLast(event => event.type === 'workstream-terminal');
    const identity = { seq: terminal.seq, checksum: terminal.checksum };
    assert.deepEqual(ws.terminal_events, [identity]);
    assert.deepEqual(scope.terminal_event, identity);
    assert.equal(scope.closed_at, terminal.ts);
    assert.deepEqual(Object.keys(ws.terminal_events[0]).sort(), ['checksum', 'seq']);
    assert.deepEqual(nextAction(state, { now: Date.parse(NOW) }).gate.unconsumed_milestones, []);
  });
}

test('ready to merged is lifecycle-only and cannot alter the closed boundary', () => {
  const f = seedReviewed();
  assert.equal(runCli(f.root, f.runId, terminalArgs(f.ws, 'ready')).status, 0);
  const ready = readState(f.root, f.runId).data;
  const readyWs = ready.workstreams.find(item => item.id === f.ws);
  const readyScope = ready.session_chain.sessions.find(session => session.run_id === f.runId).scope;
  const boundary = structuredClone(readyWs.terminal_events);
  const scopeBoundary = structuredClone(readyScope);

  const merged = runCli(f.root, f.runId, terminalArgs(f.ws, 'merged'));
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  const after = readState(f.root, f.runId).data;
  const afterWs = after.workstreams.find(item => item.id === f.ws);
  const afterScope = after.session_chain.sessions.find(session => session.run_id === f.runId).scope;
  assert.equal(afterWs.status, 'merged');
  assert.deepEqual(afterWs.terminal_events, boundary);
  assert.deepEqual(afterScope, scopeBoundary);
});

test('shared closure helper exposes literal order-aware proof defects', () => {
  assert.equal(typeof finishModule.workstreamClosureProofState, 'function');
  const loop = {
    recipe: { id: 'harness-hill-climb' },
    episodes: [
      { id: '001-maker', role: 'maker', status: 'done', point: 'implementation', workstream_id: 'w' },
      { id: '002-checker', role: 'checker', plugin: 'subagent-checker', status: 'approved', point: 'implementation', workstream_id: 'w', target_maker: '001-maker' },
      { id: '003-checker', role: 'checker', plugin: 'subagent-checker', status: 'rejected', point: 'implementation', workstream_id: 'w', target_maker: '001-maker' },
    ],
  };
  const proof = finishModule.workstreamClosureProofState(loop, 'w');
  assert.equal(proof.ok, false);
  assert.deepEqual(proof.unsettledEpisodeIds, ['003-checker']);
  assert.deepEqual(proof.unreviewedMakerIds, []);
  assert.deepEqual(proof.unresolvedRejectionIds, ['003-checker']);
  assert.deepEqual(proof.nonConvergedMakerIds, ['001-maker']);
  assert.ok(proof.missing.includes('unsettled-episodes'));
  assert.ok(proof.missing.includes('unresolved-rejection'));
  assert.ok(proof.missing.includes('non-converged-maker'));
});
