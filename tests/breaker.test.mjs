import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBreaker, recordReviewVerdict, resetBreaker } from '../scripts/lib/breaker.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-breaker-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('not tripped under threshold', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 2 } }).tripped, false);
});
test('tripped at 3 consecutive REQUEST_CHANGES', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 3 } }).tripped, true);
});
test('explicit tripped flag honored', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: true, consecutive_request_changes: 0 } }).tripped, true);
});

// Codex r6 🟡: circuit breaker LATCHES at threshold — tripped is human-reset only
test('recordReviewVerdict latches breaker at 3 REQUEST_CHANGES', () => {
  const { root, runId } = seed();
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES');
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES');
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES');
  const { data } = readState(root, runId);
  assert.equal(data.circuit_breaker.tripped, true);
  assert.equal(data.circuit_breaker.trip_reason, 'consecutive-request-changes');
  assert.equal(data.status, 'paused');
});

test('recordReviewVerdict APPROVE after latch resets counter but keeps tripped latched', () => {
  const { root, runId } = seed();
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES');
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES');
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES');
  // Verify latched
  assert.equal(readState(root, runId).data.circuit_breaker.tripped, true);
  // Now record APPROVE
  recordReviewVerdict(root, runId, 'APPROVE');
  const { data } = readState(root, runId);
  assert.equal(data.circuit_breaker.consecutive_request_changes, 0, 'counter resets');
  assert.equal(data.circuit_breaker.tripped, true, 'tripped stays latched (human-reset only)');
});

test('resetBreaker clears a tripped latch under valid fence; wrong gen throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-rb-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES', fence);
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES', fence);
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES', fence);   // 연속 3 → tripped + status=paused
  assert.equal(checkBreaker(readState(root, runId).data).tripped, true);
  assert.throws(() => resetBreaker(root, runId, { fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);   // fence 강제
  // RUN_PAUSED gate: breaker reset requires intent='breaker-reset' on a paused run (exempt from RUN_PAUSED).
  const r = resetBreaker(root, runId, { fence: { owner: runId, generation: 1, intent: 'breaker-reset' } });
  assert.equal(r.status, 'running');   // breaker 사유 paused → 복귀
  assert.equal(checkBreaker(readState(root, runId).data).tripped, false);
});

// ── v1.6 직접-writer terminal 가드 (spec §2.3-7 / §4-5g) ─────────────────────
import { tripBreaker } from '../scripts/lib/breaker.mjs';
import { writeState } from '../scripts/lib/state.mjs';
import { validate } from '../scripts/lib/schema.mjs';

function terminalSeed(status = 'completed') {
  const root = mkdtempSync(join(tmpdir(), 'dl-brk-t-'));
  const { runId } = initRun(root, { runtime: 'claude', goal: 'g', now: new Date('2026-07-09T00:00:00Z') });
  const { data } = readState(root, runId);
  data.status = status;
  writeState(root, runId, data);
  return { root, runId, owner: runId };
}

test('tripBreaker / recordReviewVerdict: terminal run throws RUN_TERMINAL, state unchanged', () => {
  const { root, runId } = terminalSeed('completed');
  assert.throws(() => tripBreaker(root, runId, 'x'), /RUN_TERMINAL: tripBreaker/);
  // trip 분기 포함: REQUEST_CHANGES 3연속으로 paused 강등을 시도하는 fence-less 호출
  assert.throws(() => recordReviewVerdict(root, runId, 'REQUEST_CHANGES'), /RUN_TERMINAL: recordReviewVerdict/);
  const d = readState(root, runId).data;
  assert.equal(d.status, 'completed');
  assert.equal(d.circuit_breaker?.tripped ?? false, false);
});

test('resetBreaker: fenced call rejects via LEASE_FENCED channel; fence-less via own throw (order = contract)', () => {
  const { root, runId, owner } = terminalSeed('stopped');
  // fence 있는 호출 → leaseCheck 선행 (drive-headless LEASE_FENCED swallow 계약 보존)
  assert.throws(() => resetBreaker(root, runId, { fence: { owner, generation: 1, intent: 'breaker-reset' } }), /LEASE_FENCED: RUN_TERMINAL/);
  // fence-less 직접 호출 → 자체 가드
  assert.throws(() => resetBreaker(root, runId, {}), /RUN_TERMINAL: resetBreaker/);
});

function recoveryBreakerFixture(kind) {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const supersededAt = '2026-07-23T00:00:00.000Z';
  const owner = data.session_chain.sessions[0];
  data.status = 'paused';
  data.pause_reason = `recovery:${kind}`;
  data.circuit_breaker = {
    consecutive_request_changes: 3,
    tripped: true,
    trip_reason: 'consecutive-request-changes',
  };
  data.session_chain.lease = {
    ...data.session_chain.lease,
    state: 'released',
    takeover_kind: kind,
    handoff_phase: 'reserved',
    handoff_child_run_id: 'RECOVERY-CHILD',
    handoff_idempotency_key: 'a'.repeat(64),
    expires_at: null,
    recovery_rel: `recoveries/${kind}.json`,
    recovery_sha256: 'b'.repeat(64),
    recovery_discriminator: `disc:${kind}`,
  };
  owner.superseded_by = kind === 'boundary-recovery'
    ? 'STALE-BOUNDARY-CHILD'
    : 'RECOVERY-CHILD';
  if (kind === 'affinity-supersession') {
    owner.scope = {
      kind: 'workstream', workstream_id: 'ws-recovery', bound_at_seq: 7,
      terminal_event: null, closed_at: null, superseded_at: supersededAt,
      supersede_reason: 'host-session-lost', superseded_by: 'RECOVERY-CHILD',
    };
  } else {
    owner.scope = {
      kind: 'workstream', workstream_id: 'ws-closed', bound_at_seq: 5,
      terminal_event: { seq: 11, checksum: 'c'.repeat(64) },
      closed_at: supersededAt, superseded_at: null,
    };
    data.session_chain.sessions.push({
      run_id: 'STALE-BOUNDARY-CHILD', started_at: null, ended_at: supersededAt,
      turns: 0, outcome: 'abandoned_recover', superseded_by: 'RECOVERY-CHILD',
      scope: {
        kind: 'workstream', workstream_id: null, bound_at_seq: null,
        terminal_event: null, closed_at: null, superseded_at: supersededAt,
        supersede_reason: 'boundary-recovery', superseded_by: 'RECOVERY-CHILD',
      },
    });
  }
  data.session_chain.sessions.push({
    run_id: 'RECOVERY-CHILD', started_at: null, ended_at: null, turns: 0,
    outcome: null, superseded_by: null,
    recovered_from: kind === 'boundary-recovery' ? 'STALE-BOUNDARY-CHILD' : runId,
    recovery_kind: kind, recovery_rel: data.session_chain.lease.recovery_rel,
    recovery_sha256: data.session_chain.lease.recovery_sha256,
    scope: {
      kind: 'workstream',
      workstream_id: kind === 'boundary-recovery' ? null : 'ws-recovery',
      bound_at_seq: kind === 'boundary-recovery' ? null : 7,
      terminal_event: null, closed_at: null, superseded_at: null,
    },
  });
  writeState(root, runId, data);
  return { root, runId };
}

test('resetBreaker preserves exact paused released recovery reservations for both recovery kinds', () => {
  for (const kind of ['affinity-supersession', 'boundary-recovery']) {
    const { root, runId } = recoveryBreakerFixture(kind);
    const before = readState(root, runId).data;
    const topology = structuredClone({
      status: before.status,
      pause_reason: before.pause_reason,
      lease: before.session_chain.lease,
      sessions: before.session_chain.sessions,
    });
    const result = resetBreaker(root, runId, {
      fence: { owner: runId, generation: 1, intent: 'breaker-reset' },
    });
    assert.deepEqual(result, { ok: true, status: 'paused' }, kind);
    const after = readState(root, runId).data;
    assert.deepEqual({
      status: after.status,
      pause_reason: after.pause_reason,
      lease: after.session_chain.lease,
      sessions: after.session_chain.sessions,
    }, topology, kind);
    assert.deepEqual(after.circuit_breaker, {
      consecutive_request_changes: 0,
      tripped: false,
      trip_reason: null,
    }, kind);
  }
});

const inexactBreakerRecoveryCases = [
    {
      label: 'terminal replacement child',
      mutate(data, child) {
        child.scope.terminal_event = { seq: 12, checksum: 'd'.repeat(64) };
      },
    },
    {
      label: 'extra open scope',
      mutate(data) {
        data.session_chain.sessions.push({
          run_id: 'EXTRA-OPEN', started_at: null, ended_at: null, turns: 0,
          outcome: null, superseded_by: null,
          scope: {
            kind: 'workstream', workstream_id: null, bound_at_seq: null,
            terminal_event: null, closed_at: null, superseded_at: null,
          },
        });
      },
    },
    {
      label: 'duplicate child session identity',
      mutate(data) {
        data.session_chain.sessions.push({
          run_id: data.session_chain.lease.handoff_child_run_id,
          started_at: null, ended_at: null, turns: 0,
          outcome: 'abandoned_recover', superseded_by: null,
          scope: {
            kind: 'workstream', workstream_id: null, bound_at_seq: null,
            terminal_event: null, closed_at: null,
            superseded_at: '2026-07-23T00:00:00.000Z',
            supersede_reason: 'boundary-recovery',
            superseded_by: 'UNRELATED',
          },
        });
      },
    },
    {
      label: 'broken predecessor link',
      mutate(data, child) {
        const predecessor = data.session_chain.sessions.find(
          session => session.run_id === child.recovered_from,
        );
        predecessor.superseded_by = 'UNRELATED';
        predecessor.scope.superseded_by = 'UNRELATED';
      },
    },
    {
      label: 'wrong boundary supersession reason',
      mutate(data, child) {
        const predecessor = data.session_chain.sessions.find(
          session => session.run_id === child.recovered_from,
        );
        predecessor.scope.supersede_reason = 'operator-recovery';
      },
    },
    {
      label: 'already-started replacement child',
      mutate(_data, child) {
        child.started_at = '2026-07-23T00:00:01.000Z';
      },
    },
    {
      label: 'ended replacement child',
      mutate(_data, child) {
        child.ended_at = '2026-07-23T00:00:01.000Z';
        child.outcome = 'abandoned_recover';
      },
    },
    {
      label: 're-superseded replacement child',
      mutate(_data, child) {
        child.superseded_by = 'UNRELATED';
      },
    },
    {
      label: 'used replacement child',
      mutate(_data, child) {
        child.turns = 1;
      },
    },
];

for (const item of inexactBreakerRecoveryCases) {
  test(`resetBreaker rejects schema-valid ${item.label} without mutation`, () => {
    const { root, runId } = recoveryBreakerFixture('boundary-recovery');
    const { data } = readState(root, runId);
    const child = data.session_chain.sessions.find(
      session => session.run_id === data.session_chain.lease.handoff_child_run_id,
    );
    item.mutate(data, child);
    assert.deepEqual(validate(data), { ok: true, errors: [] }, item.label);
    writeState(root, runId, data);
    const before = JSON.stringify(readState(root, runId).data);
    assert.throws(() => resetBreaker(root, runId, {
      fence: { owner: runId, generation: 1, intent: 'breaker-reset' },
    }), /LEASE_FENCED/, item.label);
    assert.equal(JSON.stringify(readState(root, runId).data), before, item.label);
  });
}

test('resetBreaker rejects a malformed released recovery reservation without mutation', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.pause_reason = 'recovery:boundary-recovery';
  data.circuit_breaker = {
    consecutive_request_changes: 3,
    tripped: true,
    trip_reason: 'consecutive-request-changes',
  };
  data.session_chain.lease = {
    ...data.session_chain.lease,
    state: 'released',
    takeover_kind: 'boundary-recovery',
    handoff_phase: 'spawned',
    handoff_child_run_id: 'RECOVERY-CHILD',
    handoff_idempotency_key: 'a'.repeat(64),
    expires_at: null,
  };
  writeState(root, runId, data);
  const before = JSON.stringify(readState(root, runId).data);
  assert.throws(() => resetBreaker(root, runId, {
    fence: { owner: runId, generation: 1, intent: 'breaker-reset' },
  }), /LEASE_FENCED/);
  assert.equal(JSON.stringify(readState(root, runId).data), before);
});
