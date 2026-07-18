import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { attachCandidateProofTransitions, readLines, readVerifiedState,
  intentField, proofEntityDigest, verifyProofTransitionCorrelation,
  verifyWorkstreamCreationCorrelation }
  from '../scripts/lib/integrity.mjs';
import { newEpisode, recordEpisode } from './helpers/episode-request.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal }
  from './helpers/workstream-request.mjs';
import { patch } from '../scripts/lib/state.mjs';
import { legacyInProgressProofFixture } from './fixtures/verified-app-run.mjs';
import { dispatchReview, recordReviewOutcome } from './helpers/review-request.mjs';
import { finishRun } from '../scripts/lib/finish.mjs';

const ROOT = () => mkdtempSync(join(tmpdir(), 'deep-loop-proof-transitions-'));
const FENCE = runId => ({ owner: runId, generation: 1, runtime: 'codex' });
const writeHashValid = (root, runId, mutate) => {
  const directory = join(root, '.deep-loop', 'runs', runId);
  const loop = JSON.parse(readFileSync(join(directory, 'loop.json'), 'utf8'));
  mutate(loop);
  const raw = JSON.stringify(loop, null, 2);
  writeFileSync(join(directory, 'loop.json'), raw);
  writeFileSync(join(directory, '.loop.hash'), contentHash(raw));
};

function verifiedProofFixture() {
  const root = ROOT();
  const { runId } = initRun(root, { runtime: 'codex', goal: 'proof rewrite fixture',
    cwdFn: () => root, now: new Date('2026-07-13T00:00:00.000Z') });
  const fence = FENCE(runId);
  const workstream = newWorkstream(root, runId, { title: 'rewrite', branch: 'rewrite',
    worktree: '.worktrees/rewrite', fence });
  const second = newWorkstream(root, runId, { title: 'rewrite second', branch: 'rewrite-second',
    worktree: '.worktrees/rewrite-second', fence });
  setWorkstreamStatus(root, runId, workstream.id, 'in_progress', { fence });
  setWorkstreamStatus(root, runId, second.id, 'in_progress', { fence });
  const maker = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker',
    kind: 'implementation', point: 'implementation', workstream: workstream.id,
    requestId: 'rewrite-maker-1', fence });
  return { root, runId, fence, workstreamId: workstream.id, makerId: maker.id };
}

test('central gateway owns every proof-event entity mapping', () => {
  const base = { episodes: [
    { id: 'maker', role: 'maker', status: 'in_progress' },
    { id: 'checker', role: 'checker', status: 'pending' },
  ], workstreams: [{ id: 'ws', status: 'in_progress', review_points_done: [] }],
  active_workstreams: ['ws'] };
  const scenarios = [
    ['episode-new', { episode_id: 'created' }, candidate => {
      candidate.episodes.push({ id: 'created', role: 'maker', status: 'pending' });
    }, ['episode:created']],
    ['episode-record', { id: 'maker' }, candidate => {
      candidate.episodes[0].status = 'done';
    }, ['episode:maker']],
    ['episode-abandon', { id: 'maker' }, candidate => {
      candidate.episodes[0].status = 'abandoned';
    }, ['episode:maker']],
    ['independent-review-claimed', { episode_id: 'checker' }, candidate => {
      candidate.episodes[1].status = 'in_progress';
    }, ['episode:checker']],
    ['independent-review-blocked', { episode_id: 'checker' }, candidate => {
      candidate.episodes[1].status = 'blocked';
    }, ['episode:checker']],
    ['review-outcome', { episodeId: 'checker', workstream_id: 'ws' }, candidate => {
      candidate.episodes[1].status = 'approved';
      candidate.workstreams[0].review_points_done = ['implementation'];
    }, ['episode:checker', 'workstream:ws']],
    ['workstream-new', { id: 'ws-new' }, candidate => {
      candidate.workstreams.push({ id: 'ws-new', status: 'planned', review_points_done: [] });
    }, ['workstream:ws-new']],
    ['workstream-status', { id: 'ws' }, candidate => {
      candidate.workstreams[0].status = 'in_review';
    }, ['workstream:ws']],
    ['workstream-terminal', { id: 'ws' }, candidate => {
      candidate.workstreams[0].status = 'ready';
    }, ['workstream:ws']],
    ['state-patch', { field: 'active_workstreams' }, candidate => {
      candidate.active_workstreams = [];
    }, ['workstream:ws']],
  ];
  for (const [type, data, mutate, expected] of scenarios) {
    const candidate = structuredClone(base); mutate(candidate);
    const events = [{ type, data: structuredClone(data) }];
    attachCandidateProofTransitions(base, candidate, events);
    assert.deepEqual(events[0].data.proof_transitions
      .map(item => `${item.kind}:${item.id}`), expected, type);
  }
  const ack = structuredClone(base);
  ack.episodes[0].human_reviewed = true;
  const events = [{ type: 'comprehension-acknowledged', data: {} }];
  assert.doesNotThrow(() => attachCandidateProofTransitions(base, ack, events));
  assert.equal(events[0].data.proof_transitions, undefined);
});

test('workstream creation identities are globally unique across distinct entity IDs', () => {
  const requestIdentity = 'a'.repeat(64);
  const projections = [
    { title: 'first', branch: 'first', worktree: '.worktrees/first',
      baseCommit: null, dependsOn: [] },
    { title: 'second', branch: 'second', worktree: '.worktrees/second',
      baseCommit: null, dependsOn: [] },
  ];
  const workstreams = projections.map((projection, index) => ({
    id: `ws-0${index + 1}`, title: projection.title, branch: projection.branch,
    worktree: projection.worktree, base_commit: null, depends_on: [],
    creation_contract: 'workstream-create-v1',
    creation_request_id_digest: requestIdentity,
    creation_request_digest: intentField('workstream-create-request', projection),
  }));
  const lines = workstreams.map((workstream, index) => ({
    type: 'workstream-new', data: { id: workstream.id,
      creation_contract: workstream.creation_contract,
      creation_request_id_digest: requestIdentity,
      creation_request_digest: workstream.creation_request_digest,
      request_projection: projections[index] },
  }));
  assert.equal(verifyWorkstreamCreationCorrelation(
    { initialization: {}, workstreams }, lines).ok, false);
});

test('transition reducer rejects digest and multi-entity event tampering', () => {
  const empty = { initialization: {}, episodes: [], workstreams: [], active_workstreams: [] };
  const created = { initialization: {}, episodes: [
    { id: 'checker', role: 'checker', status: 'pending' },
  ], workstreams: [
    { id: 'ws', status: 'in_review', review_points_done: [] },
  ], active_workstreams: ['ws'] };
  const workstreamCreate = { type: 'workstream-new', data: { id: 'ws',
    proof_transitions: [{ kind: 'workstream', id: 'ws', before_digest: 'NONE',
      after_digest: proofEntityDigest('workstream', created.workstreams[0], created) }] } };
  const episodeCreate = { type: 'episode-new', data: { episode_id: 'checker',
    proof_transitions: [{ kind: 'episode', id: 'checker', before_digest: 'NONE',
      after_digest: proofEntityDigest('episode', created.episodes[0], created) }] } };
  const approved = structuredClone(created);
  approved.episodes[0].status = 'approved';
  approved.workstreams[0].review_points_done = ['implementation'];
  const outcome = { type: 'review-outcome',
    data: { episodeId: 'checker', workstream_id: 'ws' } };
  attachCandidateProofTransitions(created, approved, [outcome]);
  const lines = [workstreamCreate, episodeCreate, outcome];
  assert.equal(verifyProofTransitionCorrelation(approved, lines).ok, true);

  const digestDrift = structuredClone(lines);
  digestDrift[2].data.proof_transitions[0].after_digest = 'f'.repeat(64);
  assert.equal(verifyProofTransitionCorrelation(approved, digestDrift).ok, false);
  const missingMember = structuredClone(lines);
  missingMember[2].data.proof_transitions.pop();
  assert.equal(verifyProofTransitionCorrelation(approved, missingMember).ok, false);
  const reordered = structuredClone(lines);
  reordered[2].data.proof_transitions.reverse();
  assert.equal(verifyProofTransitionCorrelation(approved, reordered).ok, false);
  const duplicate = structuredClone(lines);
  duplicate[2].data.proof_transitions.push(
    structuredClone(duplicate[2].data.proof_transitions[0]));
  assert.equal(verifyProofTransitionCorrelation(approved, duplicate).ok, false);
  assert.equal(verifyProofTransitionCorrelation(empty, []).ok, true);
});

test('gateway derives exact episode workstream and active-array transitions', () => {
  const root = ROOT();
  const { runId } = initRun(root, { runtime: 'codex', goal: 'proof gateway',
    cwdFn: () => root, now: new Date('2026-07-13T00:00:00.000Z') });
  const fence = FENCE(runId);
  const first = newWorkstream(root, runId, { title: 'first', branch: 'first',
    worktree: '.worktrees/first', requestId: 'proof-workstream-first', fence });
  const second = newWorkstream(root, runId, { title: 'second', branch: 'second',
    worktree: '.worktrees/second', requestId: 'proof-workstream-second', fence });
  setWorkstreamStatus(root, runId, first.id, 'in_progress', { fence });
  setWorkstreamStatus(root, runId, second.id, 'in_progress', { fence });
  const maker = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker',
    kind: 'implementation', point: 'implementation', workstream: first.id,
    expectedArtifacts: ['result.md'], requestId: 'proof-maker-1', fence });
  writeFileSync(join(root, 'result.md'), 'proof result\n');
  recordEpisode(root, runId, maker.id, { status: 'done', artifacts: ['result.md'], fence });
  patch(root, runId, 'active_workstreams', [second.id], { fence });
  const snapshot = readVerifiedState(root, runId).data;
  assert.equal(verifyProofTransitionCorrelation(snapshot, readLines(root, runId)).ok, true);
  const patchEvent = readLines(root, runId).findLast(event => event.type === 'state-patch');
  assert.deepEqual(patchEvent.data.proof_transitions.map(item => `${item.kind}:${item.id}`),
    [`workstream:${first.id}`, `workstream:${second.id}`].sort());
  recordWorkstreamTerminal(root, runId, second.id,
    { status: 'abandoned', proof: { reason: 'complete probe' }, fence });
});

test('pre-checkpoint legacy proof history is opaque and existing entities advance from origins', () => {
  const { root, runId, makerId, workstreamId, fence } = legacyInProgressProofFixture();
  assert.deepEqual(readVerifiedState(root, runId).data.active_workstreams,
    [workstreamId, workstreamId, 'ws-legacy-unknown']);
  writeFileSync(join(root, 'legacy.md'), 'legacy result\n');
  recordEpisode(root, runId, makerId, { status: 'done', artifacts: ['legacy.md'], fence });
  assert.deepEqual(readVerifiedState(root, runId).data.active_workstreams, [workstreamId]);
  setWorkstreamStatus(root, runId, workstreamId, 'in_review', { fence });
  const review = dispatchReview(root, runId, { point: 'implementation', workstreamId,
    detected: { 'deep-review': true }, requestId: 'legacy-dispatch-1', fence });
  mkdirSync(join(root, '.worktrees', 'legacy'), { recursive: true });
  writeFileSync(join(root, '.worktrees', 'legacy', 'review.md'), '# approved\n');
  recordReviewOutcome(root, runId, { episodeId: review.checkerEpisodeId,
    verdict: 'APPROVE', proof: { report: '.worktrees/legacy/review.md' }, fence });
  recordWorkstreamTerminal(root, runId, workstreamId, { status: 'ready', proof: {}, fence });
  writeFileSync(join(root, '.deep-loop', 'runs', runId, 'final-report.md'),
    '# legacy completed\n');
  assert.equal(finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md',
    proof: {}, fence }).ok, true);
  const lines = readLines(root, runId);
  const baseline = lines.find(event => event.type === 'lease-lineage-baselined');
  assert.equal(baseline.data.legacy_proof_origins.length, 2);
  assert.deepEqual(baseline.data.legacy_active_workstreams, [workstreamId]);
  const completed = readVerifiedState(root, runId).data;
  assert.deepEqual(completed.legacy_lineage,
    { active_workstreams: [workstreamId] });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.workstreams[0].status, 'ready');
  assert.equal(completed.episodes.find(episode => episode.role === 'checker').status, 'approved');
  assert.equal(verifyProofTransitionCorrelation(completed, lines).ok, true);
});

test('hash-valid proof and exact active-array rewrites fail closed', () => {
  for (const mutate of [
    loop => { loop.episodes[0].status = 'approved'; },
    loop => { loop.workstreams[0].review_points_done = ['implementation']; },
    loop => { loop.active_workstreams = [loop.workstreams[0].id, loop.workstreams[0].id]; },
    loop => { loop.active_workstreams = ['unknown-workstream']; },
    loop => { loop.active_workstreams = [...loop.active_workstreams].reverse(); },
  ]) {
    const fixture = verifiedProofFixture();
    writeHashValid(fixture.root, fixture.runId, mutate);
    assert.throws(() => readVerifiedState(fixture.root, fixture.runId), /RUN_SNAPSHOT_INVALID/);
  }
});
