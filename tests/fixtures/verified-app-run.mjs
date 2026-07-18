import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../../scripts/lib/envelope.mjs';
import { initRun } from '../../scripts/lib/initrun.mjs';
import { appendAnchored, appendEvent, commitVerifiedEventsUnderLock, lastLogHead,
  mutationIntentDigest, readLines }
  from '../../scripts/lib/integrity.mjs';
import { readState, readStateForRootRecovery, runDir, withLock }
  from '../../scripts/lib/state.mjs';

const TERMINAL_EVENT = new Map([
  ['host-call-timeout', 'app-task-failed'],
  ['host-call-no-return', 'app-task-failed'],
  ['host-call-failed', 'app-task-failed'],
  ['invalid-host-receipt', 'app-task-failed'],
  ['message-unconfirmed', 'app-task-failed'],
  ['app-prepare-unattended', 'app-task-swept'],
  ['app-launch-unconfirmed', 'app-task-swept'],
]);

export function seedVerifiedAppHistories(root, runId, sessions) {
  return withLock(root, runId, () => {
    const { data: loop, hash: baseStateHash } = readState(root, runId);
    const specs = [];
    for (const session of sessions) {
      const continuation = session.continuation;
      const identity = { attempt_id: continuation.attempt_id, child_run_id: session.run_id };
      for (const [field, type] of [
        ['emitted_at', 'handoff-emitted'], ['prepared_at', 'app-task-prepared'],
        ['confirmed_at', 'app-task-confirmed'],
      ]) {
        if (continuation[field] !== null) specs.push({ type, data: {
          ...identity, ...(type === 'app-task-prepared' ? {
            descriptor_digest: continuation.descriptor_digest,
          } : type === 'app-task-confirmed' ? {
            receipt_digest: contentHash('confirmed-thread\0' + continuation.thread_id),
          } : {}) },
        now: Date.parse(continuation[field]) });
      }
      if (['failed', 'abandoned'].includes(continuation.phase)) {
        const type = TERMINAL_EVENT.get(continuation.failure_code);
        if (type === undefined) throw new Error('TEST_HISTORY_CODE_UNSUPPORTED');
        const binding = continuation.failure_binding;
        if (continuation.phase === 'failed'
            && (typeof binding?.owner_run_id !== 'string'
              || !Number.isSafeInteger(binding?.generation))) {
          throw new Error('TEST_HISTORY_FAILURE_BINDING_UNSUPPORTED');
        }
        const lastClock = continuation.confirmed_at ?? continuation.prepared_at
          ?? continuation.emitted_at;
        specs.push({ type, now: Date.parse(lastClock) + 1,
          data: { ...identity, failure_code: continuation.failure_code,
            ...(continuation.failure_code === 'message-unconfirmed' ? {
              unconfirmed_receipt_digest: contentHash(
                'unconfirmed-thread\0' + continuation.unconfirmed_thread_id),
            } : {}),
            ...(continuation.phase === 'failed' ? binding : {}) } });
      }
    }
    const terminalNow = sessions.some(session =>
      ['failed', 'abandoned'].includes(session.continuation?.phase))
      ? Math.max(...specs.map(spec => spec.now)) + 1 : null;
    if (terminalNow !== null) {
      specs.push({ type: 'finish', data: { status: 'stopped', reportRel: null },
        now: terminalNow });
    }
    specs.sort((left, right) => left.now - right.now
      || left.type.localeCompare(right.type));
    return commitVerifiedEventsUnderLock(root, runId, loop, specs, candidate => {
      candidate.session_chain.sessions.push(...structuredClone(sessions));
      if (terminalNow !== null) {
        candidate.status = 'stopped';
        candidate.pause_reason = null;
        candidate.termination.finished_at = new Date(terminalNow).toISOString();
        delete candidate.termination.final_report;
      }
    }, { baseLines: readLines(root, runId), baseStateHash, callerBinding: {
      owner: loop.session_chain.lease.owner_run_id,
      generation: loop.session_chain.lease.generation,
    }, intentDigest: contentHash(JSON.stringify(specs)) });
  });
}

export function verifiedAppRun(prefix = 'dl-verified-app-') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const now = '2026-07-13T00:00:00.000Z';
  const { runId } = initRun(root, { runtime: 'codex', goal: 'verified App run',
    now: new Date(now), cwdFn: () => root,
    hostObservation: { kind: 'codex-app', source: 'codex-app-tool-provenance',
      capabilities: ['create-thread-local', 'list-projects', 'structured-process-stdin'],
      structured_stdin_mode: 'pty-raw-noecho', host_task_cwd: root,
      host_task_cwd_source: 'app-task-context', observed_at: now },
    appContinuationConsent: { mode: 'auto', authority: 'human-confirmed',
      confirmed_at: now, revoked_at: null } });
  return { root, runId, owner: runId, generation: 1 };
}

export function durableRunBytes(root, runId) {
  const directory = runDir(root, runId);
  const events = join(directory, 'event-log.jsonl');
  return { loop: readFileSync(join(directory, 'loop.json')),
    hash: readFileSync(join(directory, '.loop.hash')),
    events: existsSync(events) ? readFileSync(events) : null };
}

export function rawHashValidState(root, runId, mutate, { recovery = false } = {}) {
  const reader = recovery ? readStateForRootRecovery : readState;
  const loop = structuredClone(reader(root, runId).data);
  mutate(loop);
  const raw = JSON.stringify(loop, null, 2);
  const directory = runDir(root, runId);
  writeFileSync(join(directory, 'loop.json'), raw);
  writeFileSync(join(directory, '.loop.hash'), contentHash(raw));
}

export function seedCorrelatedTerminal(root, runId,
  { status = 'completed', reportRel = null,
    now = Date.parse('2026-07-13T00:00:10.000Z'), floor = 0 } = {}) {
  if (!['completed', 'stopped'].includes(status)) throw new Error('TEST_TERMINAL_STATUS');
  const lease = readState(root, runId).data.session_chain.lease;
  const callerBinding = { owner: lease.owner_run_id, generation: lease.generation };
  const intentDigest = mutationIntentDigest('test-correlated-terminal', callerBinding,
    { status, reportRel, now, floor });
  appendAnchored(root, runId,
    { type: 'finish', data: { status, reportRel } },
    (loop, _spent, clock) => {
      loop.status = status;
      loop.pause_reason = null;
      loop.termination = loop.termination || {};
      loop.termination.finished_at = clock.iso;
      if (reportRel === null) delete loop.termination.final_report;
      else loop.termination.final_report = reportRel;
    }, undefined, { nowFn: () => now, ...(floor > 0 ? { floor } : {}),
      callerBinding, intentDigest,
      fenceError: 'LEASE_FENCED: test-terminal' });
  return readState(root, runId).data;
}

export function rawHashValidHistory(root, runId, eventSpecs, mutate = () => {}) {
  for (const event of eventSpecs) appendEvent(root, runId, event);
  rawHashValidState(root, runId, loop => {
    loop.event_log_head = lastLogHead(root, runId);
    mutate(loop);
  });
}

function legacyEventLines(specs) {
  let previous = 'GENESIS';
  return specs.map((spec, index) => {
    const seq = index + 1;
    const ts = new Date(spec.now).toISOString();
    const checksum = contentHash(`${seq}|${ts}|${spec.type}|${JSON.stringify(spec.data)}|${previous}`);
    previous = checksum;
    return { seq, ts, type: spec.type, data: spec.data, checksum };
  });
}

export function legacyInProgressProofFixture({ appAuthority = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dl-legacy-proof-')));
  const now = '2026-07-13T00:00:00.000Z';
  const { runId } = initRun(root, { runtime: 'codex', goal: 'legacy proof continuation',
    now: new Date(now), cwdFn: () => root });
  const directory = runDir(root, runId);
  const loop = structuredClone(readState(root, runId).data);
  const workstreamId = 'ws-01-legacy';
  const makerId = '001-legacy-maker';
  delete loop.initialization;
  if (!appAuthority) loop.session_chain.sessions[0].host_surface = null;
  loop.review.points = ['implementation'];
  loop.workstreams = [{ id: workstreamId, title: 'legacy', status: 'in_progress',
    branch: 'legacy', worktree: '.worktrees/legacy', base_commit: null,
    dirty_on_handoff: false, pr: { intended: true, state: 'none', url: null },
    episodes: [makerId], review_points_done: [], depends_on: [] }];
  loop.active_workstreams = [workstreamId, workstreamId, 'ws-legacy-unknown'];
  loop.episodes = [{ id: makerId, plugin: 'deep-work', role: 'maker',
    kind: 'implementation', point: 'implementation', workstream_id: workstreamId,
    status: 'in_progress', request_path: join(directory, 'legacy-request.md'),
    expected_artifacts: ['legacy.md'], verification: { checker_episode_required: true,
      checker_plugin: 'deep-review', review_point: 'implementation',
      proof_required: ['legacy.md'] } }];
  const lines = legacyEventLines([
    { type: 'workstream-new', data: { title: 'legacy' }, now },
    { type: 'episode-new', data: { plugin: 'deep-work', role: 'maker',
      kind: 'implementation', point: 'implementation' },
    now: '2026-07-13T00:00:01.000Z' },
  ]);
  loop.event_log_head = { seq: lines.at(-1).seq, checksum: lines.at(-1).checksum };
  loop.updated_at = lines.at(-1).ts;
  const raw = JSON.stringify(loop, null, 2);
  writeFileSync(join(directory, 'event-log.jsonl'),
    `${lines.map(event => JSON.stringify(event)).join('\n')}\n`);
  writeFileSync(join(directory, 'loop.json'), raw);
  writeFileSync(join(directory, '.loop.hash'), contentHash(raw));
  return { root, runId, makerId, workstreamId,
    fence: { owner: runId, generation: 1, runtime: 'codex' } };
}
