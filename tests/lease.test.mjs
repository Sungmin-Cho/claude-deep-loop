import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '../scripts/lib/envelope.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { patch, pauseRun, readState, runDir, writeState } from '../scripts/lib/state.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { setSessionProfile } from '../scripts/lib/session-profile.mjs';
import {
  deriveIdempotencyKey, leaseCheck, acquireLease, releaseLease,
  reapLease,
  reserveHandoff, advanceHandoffPhase, rollbackHandoff,
  rollbackReservedEmit,
} from '../scripts/lib/lease.mjs';
import { readLines } from '../scripts/lib/integrity.mjs';
import { migrateAuthenticLegacyTransport } from './helpers/legacy-transport.mjs';
import * as leaseModule from '../scripts/lib/lease.mjs';
import { validate } from '../scripts/lib/schema.mjs';
import { recoverRun } from '../scripts/lib/recover.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');

function runCli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
}

function seed(runtime = 'claude') {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { runtime, goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  migrateAuthenticLegacyTransport(root, runId);
  return { root, runId };
}

function writeHashValidState(root, runId, data) {
  const raw = JSON.stringify(data, null, 2);
  const dir = runDir(root, runId);
  writeFileSync(join(dir, 'loop.json'), raw);
  writeFileSync(join(dir, '.loop.hash'), contentHash(raw));
}

function pendingLease(root, runId, {
  owner = 'SLICE006PENDINGOWNER',
  attemptId = 'SLICE006ATTEMPT01',
  clock = () => Date.parse('2026-08-09T00:00:00.000Z'),
} = {}) {
  assert.deepEqual(releaseLease(root, runId, { owner: runId, generation: 1 }), {
    ok: true, reason: 'released',
  });
  const acquired = acquireLease(root, runId, {
    owner,
    expectGeneration: 1,
    runtime: 'claude',
    attemptId,
    clock,
  });
  assert.equal(acquired.proceed, true);
  assert.notEqual(readState(root, runId).data.session_chain.lease.activation_deadline_at, null);
  return { owner, generation: acquired.generation, attemptId };
}

function activatePending(root, runId, pending, activationToken = 'SLICE006ACTIVATIONTOKEN') {
  const activated = leaseModule.activateLease(root, runId, {
    owner: pending.owner,
    generation: pending.generation,
    runtime: 'claude',
    attemptId: pending.attemptId,
    activationToken,
    now: Date.parse('2026-08-09T00:00:01.000Z'),
    clock: () => Date.parse('2026-08-09T00:00:01.000Z'),
  });
  assert.deepEqual(activated, { ok: true, reason: 'activated' });
  return activated;
}

function durableLeaseBytes(root, runId) {
  const dir = runDir(root, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
    events: existsSync(eventPath) ? readFileSync(eventPath) : null,
  };
}

test('SLICE-004 exposes activateLease as the dedicated activation mutation', () => {
  assert.equal(typeof leaseModule.activateLease, 'function');
});

// T2a — (d) lib 수준 응답 계약. spec §3.1/§3.2, docs/superpowers/specs/2026-07-27-acquire-resume-contract.md
test('T2a acquireLease distinguishes proceeding from idempotent responses and anchors one receipt', () => {
  const { root, runId } = seed();
  const idempotent = acquireLease(root, runId, {
    attemptId: 'MIGRATEDATTEMPT01',
    owner: runId, expectGeneration: 1, runtime: 'claude',
  });
  assert.equal(idempotent.reason, 'already-owned');
  assert.equal(idempotent.ok, true);
  assert.equal(idempotent.proceed, false);
  assert.equal(idempotent.consumed, null);
  assert.equal(idempotent.replayed, false);
  assert.equal(readLines(root, runId).filter(event => event.type === 'lease-acquired').length, 0);

  releaseLease(root, runId, { owner: runId, generation: 1 });
  const acquired = acquireLease(root, runId, {
    owner: 'FRESH', expectGeneration: 1, runtime: 'claude', attemptId: 'T2AATTEMPT01',
  });
  assert.equal(acquired.reason, 'acquired');
  assert.equal(acquired.proceed, true);
  assert.notEqual(acquired.consumed, undefined);
  assert.equal(acquired.consumed, null);   // 예약 없는 인수 → consumed 는 null 이지만 영수증은 남는다
  assert.equal(acquired.replayed, false);
  const events = readLines(root, runId).filter(event => event.type === 'lease-acquired');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, {
    owner: 'FRESH', from_generation: 1, to_generation: 2, attempt_id: 'T2AATTEMPT01',
  });
  const receipt = readState(root, runId).data.session_chain.lease.acquisition_receipt;
  assert.equal(receipt.takeover_kind, 'released-takeover');
  assert.equal(receipt.child_run_id, 'FRESH');
  assert.equal(receipt.superseded_owner_run_id, runId);
  assert.equal(receipt.from_generation, 1);
  assert.equal(receipt.to_generation, 2);
  assert.equal(receipt.attempt_id, 'T2AATTEMPT01');
});

test('SLICE-002 first post-upgrade acquire protects a schema-valid legacy run with the 900s default', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  delete data.session_chain.activation_deadline_sec;
  delete data.session_chain.lease.activation_deadline_at;
  writeState(root, runId, data); // writeState validation proves this exact legacy absence is schema-valid.

  assert.equal(Object.hasOwn(readState(root, runId).data.session_chain, 'activation_deadline_sec'), false);
  assert.equal(Object.hasOwn(readState(root, runId).data.session_chain.lease, 'activation_deadline_at'), false);
  assert.deepEqual(releaseLease(root, runId, { owner: runId, generation: 1 }), {
    ok: true, reason: 'released',
  });

  const safetyNow = Date.parse('2026-08-06T01:02:03.000Z');
  const acquired = acquireLease(root, runId, {
    owner: 'LEGACYPOSTUPGRADEOWNER',
    expectGeneration: 1,
    runtime: 'claude',
    attemptId: 'LEGACYUPGRADEATTEMPT01',
    now: Date.parse('2001-01-01T00:00:00.000Z'),
    clock: () => safetyNow,
  });
  assert.equal(acquired.proceed, true);
  assert.equal(acquired.generation, 2);

  const after = readState(root, runId).data;
  assert.equal(after.session_chain.activation_deadline_sec, 900);
  assert.equal(
    after.session_chain.lease.activation_deadline_at,
    new Date(safetyNow + 900_000).toISOString(),
  );
});

test('T2a a consumed reservation carries the boundary receipt and echoes it as consumed', () => {
  const { root, runId } = seed();
  const now0 = Date.parse('2026-06-24T00:00:00.000Z');
  const { key } = reserveHandoff(root, runId, { trigger: 'legacy-reserved-child', now: now0 });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', now: now0 });
  const child = readState(root, runId).data.session_chain.lease.handoff_child_run_id;
  const acquired = acquireLease(root, runId, {
    attemptId: 'MIGRATEDATTEMPT01',
    owner: child, expectGeneration: 1, runtime: 'claude', now: now0 + 1_000,
  });
  assert.equal(acquired.proceed, true);
  assert.equal(acquired.consumed.takeover_kind, 'legacy-handoff');
  assert.equal(acquired.consumed.child_run_id, child);
  assert.equal(acquired.consumed.boundary_event, null);
  assert.equal(acquired.consumed.from_generation, 1);
  assert.equal(acquired.consumed.to_generation, 2);
  // 영수증은 consumed 의 상위집합이다 — 응답은 reservation_key/at/attempt_id 를 뺀 나머지다(§3.2).
  const receipt = readState(root, runId).data.session_chain.lease.acquisition_receipt;
  assert.deepEqual(
    Object.fromEntries(Object.entries(receipt)
      .filter(([field]) => !['reservation_key', 'at', 'attempt_id'].includes(field))),
    acquired.consumed,
  );
  assert.equal(receipt.attempt_id, 'MIGRATEDATTEMPT01');
});

test('deriveIdempotencyKey is deterministic and trigger-sensitive', () => {
  const a = deriveIdempotencyKey('R', 1, 'milestone');
  assert.equal(a, deriveIdempotencyKey('R', 1, 'milestone'));
  assert.notEqual(a, deriveIdempotencyKey('R', 1, 'precompact'));
  assert.notEqual(a, deriveIdempotencyKey('R', 2, 'milestone'));
});

test('leaseCheck passes for current owner+generation, rejects mismatch; active owner never time-fenced', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  assert.equal(leaseCheck(data, { owner: runId, generation: 1 }).ok, true);
  assert.equal(leaseCheck(data, { owner: 'OTHER', generation: 1 }).ok, false);
  assert.equal(leaseCheck(data, { owner: runId, generation: 2 }).ok, false);
  // Codex r2 🔴2: active 소유자는 expires_at 가 과거여도 fence 되지 않는다 (deadlock 방지). leaseCheck 는 시간을 안 본다.
  data.session_chain.lease.expires_at = '2000-01-01T00:00:00Z';
  assert.equal(leaseCheck(data, { owner: runId, generation: 1 }).ok, true);
});

test('leaseCheck optionally fences a mismatched runtime before owner/generation and preserves matching semantics', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  assert.deepEqual(
    leaseCheck(data, { owner: 'OTHER', generation: 99, runtime: 'codex' }),
    { ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex' },
  );
  assert.equal(leaseCheck(data, { owner: 'OTHER', generation: 1, runtime: 'claude' }).reason, 'owner-mismatch');
  assert.equal(leaseCheck(data, { owner: runId, generation: 2, runtime: 'claude' }).reason, 'generation-mismatch');
  assert.equal(leaseCheck(data, { owner: runId, generation: 1, runtime: 'claude' }).ok, true);
});

test('reserveHandoff dedups concurrent triggers (PreCompact no-op after Decide)', () => {
  const { root, runId } = seed();
  const decide = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(decide.reserved, true);
  const precompact = reserveHandoff(root, runId, { trigger: 'precompact' });
  assert.equal(precompact.ok, false);
  assert.equal(precompact.reason, 'handoff-in-flight');
  // same trigger re-entry is idempotent (ok, not re-reserved)
  const retry = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(retry.ok, true);
  assert.equal(retry.reserved, false);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
});

test('SLICE-006 reserveHandoff independently blocks an activation-pending lease without durable writes', () => {
  const { root, runId } = seed();
  const pending = pendingLease(root, runId);
  const before = durableLeaseBytes(root, runId);

  assert.deepEqual(
    reserveHandoff(root, runId, {
      trigger: 'slice-006-negative-polarity',
      expect: { owner: pending.owner, generation: pending.generation },
      now: Date.parse('2026-08-09T00:00:02.000Z'),
    }),
    { ok: false, reason: 'ACTIVATION_PENDING' },
  );
  assert.deepEqual(durableLeaseBytes(root, runId), before);
});

test('SLICE-006 reserveHandoff activated polarity preserves the existing reservation path', () => {
  const { root, runId } = seed();
  const pending = pendingLease(root, runId);
  activatePending(root, runId, pending);

  const reserved = reserveHandoff(root, runId, {
    trigger: 'slice-006-positive-polarity',
    expect: { owner: pending.owner, generation: pending.generation },
    now: Date.parse('2026-08-09T00:00:02.000Z'),
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.reserved, true);
  assert.equal(reserved.reason, 'reserved');
});

test('SLICE-006 releaseLease blocks activation-pending state and releases after activation', () => {
  const { root, runId } = seed();
  const pending = pendingLease(root, runId);
  const before = durableLeaseBytes(root, runId);

  assert.deepEqual(releaseLease(root, runId, pending), {
    ok: false, reason: 'ACTIVATION_PENDING',
  });
  assert.deepEqual(durableLeaseBytes(root, runId), before);

  activatePending(root, runId, pending);
  assert.deepEqual(releaseLease(root, runId, pending), { ok: true, reason: 'released' });
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'released');
});

test('SLICE-006 rollbackHandoff blocks activation-pending phase and rolls back after activation', () => {
  const { root, runId } = seed();
  const pending = pendingLease(root, runId);
  const before = durableLeaseBytes(root, runId);

  const denied = rollbackHandoff(root, runId, pending);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'acquired');
  assert.deepEqual(denied, {
    ok: false, reason: 'ACTIVATION_PENDING',
  });
  assert.deepEqual(durableLeaseBytes(root, runId), before);

  activatePending(root, runId, pending);
  assert.deepEqual(rollbackHandoff(root, runId, pending), { ok: true, reason: 'rolled-back' });
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
});

test('SLICE-006 CLI lease release exits zero with structured pending denial, then releases after activation', () => {
  const { root, runId } = seed();
  const pending = pendingLease(root, runId, {
    owner: 'SLICE006CLIPENDINGOWNER',
    attemptId: 'SLICE006CLIATTEMPT01',
    clock: Date.now,
  });
  const releaseArgs = [
    'lease', 'release', '--run-id', runId,
    '--owner', pending.owner, '--generation', String(pending.generation),
  ];
  const before = durableLeaseBytes(root, runId);

  const denied = runCli(root, releaseArgs);
  assert.equal(denied.status, 0, denied.stdout + denied.stderr);
  assert.deepEqual(JSON.parse(denied.stdout), { ok: false, reason: 'ACTIVATION_PENDING' });
  assert.deepEqual(durableLeaseBytes(root, runId), before);

  const activated = runCli(root, [
    'lease', 'activate', '--run-id', runId,
    '--owner', pending.owner, '--generation', String(pending.generation),
    '--runtime', 'claude', '--attempt-id', pending.attemptId,
    '--activation-token', 'SLICE006CLIACTIVATIONTOKEN',
  ]);
  assert.equal(activated.status, 0, activated.stdout + activated.stderr);
  assert.deepEqual(JSON.parse(activated.stdout), { ok: true, reason: 'activated' });

  const released = runCli(root, releaseArgs);
  assert.equal(released.status, 0, released.stdout + released.stderr);
  assert.deepEqual(JSON.parse(released.stdout), { ok: true, reason: 'released' });
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'released');
});

test('advanceHandoffPhase enforces forward-only and sets releasing on emitted', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'spawned' }).ok, false); // skip
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'emitted' }).ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
  assert.equal(advanceHandoffPhase(root, runId, { key: 'wrong', toPhase: 'spawned' }).ok, false); // key fence
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'spawned' }).ok, true);
});

test('acquireLease: child takes over released lease, generation+1; stale generation rejected', () => {
  const { root, runId } = seed();
  // parent releases (after spawning a child)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  // wrong expectGeneration → fenced
  assert.equal(acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 5, runtime: 'claude' }).ok, false);
  const ok = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 1, runtime: 'claude' });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.owner_run_id, 'CHILD');
  assert.equal(lease.state, 'active');
  assert.equal(lease.handoff_phase, 'acquired');
  assert.equal(lease.handoff_idempotency_key, null);
});

test('acquireLease: active lease is never stolen (even past expires_at); released is takeable', () => {
  const { root, runId } = seed();
  // active → not takeable by another owner
  assert.equal(acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 1, runtime: 'claude' }).ok, false);
  // 심지어 active 에 과거 expires_at 이 있어도 탈취 불가 (active 는 deadline 없음 — Codex r2 🔴2)
  const { data } = readState(root, runId);
  data.session_chain.lease.expires_at = new Date(Date.parse('2026-06-24T00:00:00Z') + 1000).toISOString();
  writeState(root, runId, data);
  const future = Date.parse('2026-06-24T01:00:00Z');
  assert.equal(acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: future }).ok, false);
  // released → takeable, generation+1
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const ok = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: future });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
  assert.equal(readState(root, runId).data.session_chain.lease.expires_at, null);  // active = no deadline
});

test('rollbackHandoff restores active/idle (launch-failure path)', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted' });
  const r = rollbackHandoff(root, runId, { owner: runId, generation: 1 });
  assert.equal(r.ok, true);
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'active');
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_idempotency_key, null);
  assert.equal(lease.handoff_trigger, null);
});

test('rollbackReservedEmit preserves a reserved lease when a deterministic final exists', () => {
  const { root, runId } = seed();
  const expect = { owner: runId, generation: 1 };
  const reserved = reserveHandoff(root, runId, { trigger: 'milestone', expect, now: 1 });
  const dir = join(runDir(root, runId), 'handoffs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${reserved.childRunId}-next-session.md`), 'published');

  assert.deepEqual(
    rollbackReservedEmit(root, runId, {
      key: reserved.key, childRunId: reserved.childRunId, expect,
    }),
    { ok: false, reason: 'finals-present' },
  );
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
});

test('rollbackReservedEmit preserves a reserved lease when final absence is indeterminate', () => {
  const { root, runId } = seed();
  const expect = { owner: runId, generation: 1 };
  const reserved = reserveHandoff(root, runId, { trigger: 'milestone', expect, now: 1 });

  assert.deepEqual(
    rollbackReservedEmit(root, runId, {
      key: reserved.key, childRunId: reserved.childRunId, expect,
      statFn() { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
    }),
    { ok: false, reason: 'finals-indeterminate' },
  );
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
});

test('rollbackReservedEmit rolls back only after both deterministic finals prove absent', () => {
  const { root, runId } = seed();
  const expect = { owner: runId, generation: 1 };
  const reserved = reserveHandoff(root, runId, { trigger: 'milestone', expect, now: 1 });
  const checked = [];

  const result = rollbackReservedEmit(root, runId, {
    key: reserved.key, childRunId: reserved.childRunId, expect,
    statFn(path) {
      checked.push(path);
      throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    },
  });

  assert.deepEqual(result, { ok: true, rolledBack: true });
  assert.equal(checked.length, 2);
  assert.ok(checked[0].endsWith(`${reserved.childRunId}-next-session.md`));
  assert.ok(checked[1].endsWith(`${reserved.childRunId}-compaction-state.json`));
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
});

test('reserve persists raw handoff_trigger; acquireLease and rollbackHandoff clear it', () => {
  const first = seed();
  const reserved = reserveHandoff(first.root, first.runId, {
    trigger: 'raw:milestone', expect: { owner: first.runId, generation: 1 }, now: 1,
  });
  assert.equal(readState(first.root, first.runId).data.session_chain.lease.handoff_trigger, 'raw:milestone');
  advanceHandoffPhase(first.root, first.runId, { key: reserved.key, toPhase: 'emitted', now: 1 });
  const acquired = acquireLease(first.root, first.runId, {
    attemptId: 'MIGRATEDATTEMPT01',
    owner: reserved.childRunId, expectGeneration: 1, runtime: 'claude', now: 2,
  });
  assert.ok(acquired.ok);
  assert.equal(readState(first.root, first.runId).data.session_chain.lease.handoff_trigger, null);

  const second = seed();
  reserveHandoff(second.root, second.runId, {
    trigger: 'rollback-trigger', expect: { owner: second.runId, generation: 1 }, now: 1,
  });
  rollbackHandoff(second.root, second.runId, { owner: second.runId, generation: 1 });
  assert.equal(readState(second.root, second.runId).data.session_chain.lease.handoff_trigger, null);
});

// Codex r1 🔴4: emitted 진입이 expires_at 를 설정해야 부모 크래시(releaseLease 누락) 후에도 자식이 TTL 경과로 인수 가능.
test('emitted sets expires_at → child can take over after stale TTL without explicit release', () => {
  const { root, runId } = seed();
  const now0 = Date.parse('2026-06-24T00:00:00Z');
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', now: now0 });
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'releasing');
  assert.ok(lease.expires_at, 'expires_at must be set on emitted');
  // 부모가 releaseLease 를 못 하고 죽음. TTL(900s) 경과 전: 인수 불가(releasing 은 takeable 아님)
  assert.equal(acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: now0 + 1000 }).ok, false);
  // TTL 경과 후: stale → 인수 가능
  const ok = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 1, runtime: 'claude', now: now0 + 901 * 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
});

test('releasing lease blocks parent self-reacquisition through TTL and permits it only after injected expiry', () => {
  const { root, runId } = seed();
  const now0 = Date.parse('2026-06-24T00:00:00.000Z');
  const { key } = reserveHandoff(root, runId, { trigger: 'parent-self-reacquire', now: now0 });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', now: now0 });
  const expiresAt = Date.parse(readState(root, runId).data.session_chain.lease.expires_at);

  const withinTtl = acquireLease(root, runId, {
    attemptId: 'MIGRATEDATTEMPT01',
    owner: runId, expectGeneration: 1, runtime: 'claude', now: expiresAt,
  });
  assert.deepEqual(withinTtl, {
    ok: false, generation: 1, reason: 'lease-not-takeable',
    proceed: false, consumed: null, replayed: false,
  });
  assert.equal(readState(root, runId).data.session_chain.lease.owner_run_id, runId);
  assert.equal(readState(root, runId).data.session_chain.lease.generation, 1);

  const afterTtl = acquireLease(root, runId, {
    attemptId: 'MIGRATEDATTEMPT01',
    owner: runId, expectGeneration: 1, runtime: 'claude', now: expiresAt + 1,
  });
  assert.deepEqual(afterTtl, {
    ok: true, generation: 2, reason: 'acquired',
    proceed: true, consumed: null, replayed: false,
  });
  assert.equal(readState(root, runId).data.session_chain.lease.owner_run_id, runId);
  assert.equal(readState(root, runId).data.session_chain.lease.generation, 2);
});

test('leaseCheck allows accounting during releasing for matching owner/generation', () => {
  const loop = { session_chain: { lease: { owner_run_id: 'r', generation: 2, state: 'releasing' } } };
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'business' }).ok, false);    // 업무 write 거부
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'accounting' }).ok, true);   // 회계 허용
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 3, intent: 'accounting' }).ok, false);  // generation 불일치 거부
});

test('leaseCheck allows only matching accounting on a nonterminal paused run', () => {
  const loop = {
    status: 'paused',
    session_chain: { lease: { owner_run_id: 'r', generation: 2, state: 'active' } },
  };
  assert.deepEqual(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'accounting' }), { ok: true, reason: 'ok' });
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'business' }).reason, 'RUN_PAUSED');
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'lease' }).reason, 'RUN_PAUSED');
  assert.equal(leaseCheck(loop, { owner: 'other', generation: 2, intent: 'accounting' }).reason, 'owner-mismatch');
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 3, intent: 'accounting' }).reason, 'generation-mismatch');
});

// Fix A: reserveHandoff with stale expect is fenced (generation-mismatch); without expect is unchanged
test('reserveHandoff: stale expect fences without mutating; no expect is unchanged', () => {
  const { root, runId } = seed();
  // Stale owner → fenced
  const r1 = reserveHandoff(root, runId, { trigger: 'milestone', expect: { owner: 'WRONG', generation: 1 } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'fenced');
  assert.equal(r1.reserved, false);
  // Stale generation → fenced
  const r2 = reserveHandoff(root, runId, { trigger: 'milestone', expect: { owner: runId, generation: 99 } });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'fenced');
  // State is NOT mutated by fenced calls
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'idle');
  // Correct expect → succeeds
  const r3 = reserveHandoff(root, runId, { trigger: 'milestone', expect: { owner: runId, generation: 1 } });
  assert.equal(r3.ok, true);
  assert.equal(r3.reserved, true);
  // No expect → unchanged behavior (backward compat)
  const { root: root2, runId: runId2 } = seed();
  const r4 = reserveHandoff(root2, runId2, { trigger: 'milestone' });
  assert.equal(r4.ok, true);
  assert.equal(r4.reserved, true);
});

// Fix A: advanceHandoffPhase with stale expect is fenced before key/phase checks
test('advanceHandoffPhase: stale expect fences before key/phase checks; correct expect proceeds', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  // Stale generation → fenced (before key check)
  const r1 = advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', expect: { owner: runId, generation: 99 } });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'fenced');
  // State not mutated
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
  // Correct expect → proceeds
  const r2 = advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', expect: { owner: runId, generation: 1 } });
  assert.equal(r2.ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
});

// ── Task 8: preserve-resume unpause + terminal guard ─────────────────────────

// Helper: seed a preserve-paused run (status=paused, lease.state=releasing, reserved child)
function seedPreservePaused(root, runId, childRunId = 'C') {
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.pause_reason = 'preserve-paused-test';
  data.session_chain.lease = {
    ...data.session_chain.lease,
    state: 'releasing',
    handoff_child_run_id: childRunId,
    handoff_phase: 'spawned',
    resume_policy: 'human',
    expires_at: null,
  };
  writeState(root, runId, data);
}

test('reserved child acquiring a preserve-paused run unpauses it (R14-RR)', () => {
  const { root, runId } = seed();
  seedPreservePaused(root, runId, 'C');
  const now0 = Date.parse('2026-06-24T12:00:00Z');

  const r = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'C', expectGeneration: 1, runtime: 'claude', now: now0 });
  assert.equal(r.ok, true);
  assert.equal(r.generation, 2);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.pause_reason, null);
  assert.equal(data.session_chain.lease.resume_policy, null);
  assert.equal(data.session_chain.lease.generation, 2);
});

test('non-reserved owner still cannot acquire preserve-paused run (expires_at=null)', () => {
  const { root, runId } = seed();
  seedPreservePaused(root, runId, 'C');
  // expires_at=null → expired=false → only reserved child 'C' is takeable; 'OTHER' is not
  const r = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'OTHER', expectGeneration: 1, runtime: 'claude', now: Date.parse('2099-01-01T00:00:00Z') });
  assert.equal(r.ok, false);
  // status must remain paused (no spurious change)
  assert.equal(readState(root, runId).data.status, 'paused');
});

test('recover round-trip: released-paused run acquired by fresh owner unpauses (Task 7 closed)', () => {
  // Simulates the state left by recoverRun: status=paused, lease.state=released,
  // handoff_child_run_id=null, pause_reason='recovered:awaiting-resume'.
  // Task 8 acquireLease must clear the pause.
  const { root, runId } = seed();
  const { data: d0 } = readState(root, runId);
  d0.status = 'paused';
  d0.pause_reason = 'recovered:awaiting-resume';
  d0.session_chain.lease = {
    ...d0.session_chain.lease,
    state: 'released',
    handoff_child_run_id: null,
    handoff_idempotency_key: null,
    handoff_phase: 'idle',
    resume_policy: null,
    expires_at: null,
  };
  writeState(root, runId, d0);

  const r = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'FRESH', expectGeneration: 1, runtime: 'claude' });
  assert.equal(r.ok, true);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.pause_reason, null);
  assert.equal(data.session_chain.lease.generation, 2);
});

test('terminal guard: stopped run rejects acquireLease with run-terminal', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const { data: d0 } = readState(root, runId);
  d0.status = 'stopped';
  writeState(root, runId, d0);

  const r = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'NEW', expectGeneration: 1, runtime: 'claude' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-terminal');
});

test('terminal guard: completed run rejects acquireLease with run-terminal', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const { data: d0 } = readState(root, runId);
  d0.status = 'completed';
  writeState(root, runId, d0);

  const r = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'NEW', expectGeneration: 1, runtime: 'claude' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'run-terminal');
});

test('regression: non-paused run acquire leaves status running, no spurious pause_reason write', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const r = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'CHILD', expectGeneration: 1, runtime: 'claude' });
  assert.equal(r.ok, true);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.ok(!data.pause_reason, 'pause_reason must not be set on non-paused acquire');
});

// Codex r3 🔴1: releaseLease must reject when status=paused — prevents owner bypassing recover audit path.
test('releaseLease on paused run returns RUN_PAUSED; lease NOT released; acquireLease stays blocked (codex-high)', () => {
  const { root, runId } = seed();
  // Seed a gate-blocked-style paused state: status=paused, lease.state=active, same owner/generation.
  { const { data } = readState(root, runId); data.status = 'paused'; data.pause_reason = 'gate:budget'; writeState(root, runId, data); }
  // releaseLease must refuse
  const r = releaseLease(root, runId, { owner: runId, generation: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'RUN_PAUSED');
  // lease NOT released — state still active
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'active');
  assert.equal(lease.owner_run_id, runId);
  // acquireLease by a new owner must still be blocked (run is paused, lease not released → not takeable)
  const acq = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'BYPASS', expectGeneration: 1, runtime: 'claude' });
  assert.equal(acq.ok, false);
  assert.ok(acq.reason !== 'acquired', 'paused run must not be re-acquired via bypassed release');
  // run status remains paused
  assert.equal(readState(root, runId).data.status, 'paused');
});

// ── v1.6 terminal guard (spec §2.1/§4-1) ─────────────────────────────────────
function makeTerminal(root, runId, status = 'completed') {
  const { data } = readState(root, runId);
  data.status = status;                    // writeState가 .loop.hash 앵커를 재계산
  writeState(root, runId, data);
}

test('leaseCheck: terminal run rejects EVERY intent with RUN_TERMINAL', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen = data.session_chain.lease.generation;
  const intents = ['business', 'lease', 'accounting', 'breaker-reset', 'recover', 'resume'];
  for (const status of ['completed', 'stopped']) {
    const loop = structuredClone(data);
    loop.status = status;
    for (const intent of intents) {
      assert.deepEqual(leaseCheck(loop, { owner, generation: gen, intent }),
        { ok: false, reason: 'RUN_TERMINAL' }, `${status}/${intent}`);
    }
    // terminal 게이트는 lease.state 게이트보다 앞 (spec r3 🟡3): released/releasing이어도 RUN_TERMINAL
    for (const ls of ['released', 'releasing']) {
      const l2 = structuredClone(loop);
      l2.session_chain.lease.state = ls;
      assert.equal(leaseCheck(l2, { owner, generation: gen, intent: 'business' }).reason, 'RUN_TERMINAL', `${status}/${ls}`);
    }
    // fence first: owner/generation 불일치가 terminal보다 우선
    assert.equal(leaseCheck(loop, { owner: 'other', generation: gen, intent: 'business' }).reason, 'owner-mismatch');
    assert.equal(leaseCheck(loop, { owner, generation: gen + 9, intent: 'business' }).reason, 'generation-mismatch');
  }
  // 비terminal 회귀: running/paused 기존 reason 불변
  assert.equal(leaseCheck(data, { owner, generation: gen, intent: 'business' }).ok, true);
  const paused = structuredClone(data); paused.status = 'paused';
  assert.equal(leaseCheck(paused, { owner, generation: gen, intent: 'business' }).reason, 'RUN_PAUSED');
  assert.equal(leaseCheck(paused, { owner, generation: gen, intent: 'recover' }).ok, true);
});

test('reserveHandoff / advanceHandoffPhase reject terminal runs (spec §2.3-1/3)', () => {
  const { root, runId } = seed();
  // running에서 reserve 성공 → finish 경합 재현
  const r1 = reserveHandoff(root, runId, { trigger: 't', now: Date.parse('2026-07-09T00:00:00Z') });
  assert.equal(r1.reserved, true);
  makeTerminal(root, runId, 'completed');
  assert.deepEqual(
    advanceHandoffPhase(root, runId, { key: r1.key, toPhase: 'emitted', now: Date.parse('2026-07-09T00:00:01Z') }),
    { ok: false, reason: 'RUN_TERMINAL' });
  const r2 = reserveHandoff(root, runId, { trigger: 't2', now: Date.parse('2026-07-09T00:00:02Z') });
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'RUN_TERMINAL'); assert.equal(r2.childRunId, null);
});

test('acquireLease: active-terminal rejects with run-terminal; generation fence-first preserved (spec §4-5f)', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  const owner = data.session_chain.lease.owner_run_id;
  const gen = data.session_chain.lease.generation;
  makeTerminal(root, runId, 'completed');   // lease는 active 그대로 (정상 finish 상태)
  // ① same-owner acquire → already-owned 위장 금지
  assert.equal(acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner, expectGeneration: gen, runtime: 'claude' }).reason, 'run-terminal');
  // ② 타-owner + 올바른 generation → run-terminal
  assert.equal(acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'other-run', expectGeneration: gen, runtime: 'claude' }).reason, 'run-terminal');
  // ③ 타-owner + stale generation → generation-mismatch 우선 (fence-first)
  assert.equal(acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'other-run', expectGeneration: gen + 9, runtime: 'claude' }).reason, 'generation-mismatch');
  // 비terminal 회귀: same-owner active 멱등 불변
  const { root: r2, runId: run2 } = seed();
  assert.equal(acquireLease(r2, run2, { attemptId: 'MIGRATEDATTEMPT01', owner: run2, expectGeneration: 1, runtime: 'claude' }).reason, 'already-owned');
});

test('acquireLease checks runtime before same-owner idempotency', () => {
  const { root, runId } = seed();
  assert.deepEqual(
    acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: runId, expectGeneration: 1, runtime: 'codex' }),
    {
      ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex',
      proceed: false, consumed: null, replayed: false,
    },
  );
  assert.equal(
    acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: runId, expectGeneration: 1, runtime: 'claude' }).reason,
    'already-owned',
  );
});

test('acquireLease checks runtime before stale generation and paused unpause without mutating state', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  data.status = 'paused';
  data.pause_reason = 'recovered:awaiting-resume';
  data.session_chain.lease.state = 'released';
  data.session_chain.lease.resume_policy = 'human';
  writeState(root, runId, data);
  const before = structuredClone(readState(root, runId).data);

  assert.deepEqual(
    acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'FRESH', expectGeneration: 99, runtime: 'codex' }),
    {
      ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex',
      proceed: false, consumed: null, replayed: false,
    },
  );
  const afterMismatch = readState(root, runId).data;
  assert.deepEqual(afterMismatch, before);
  assert.equal(afterMismatch.session_chain.lease.generation, before.session_chain.lease.generation);
  assert.equal(afterMismatch.status, before.status);
  assert.equal(afterMismatch.pause_reason, before.pause_reason);
  assert.equal(afterMismatch.session_chain.lease.resume_policy, before.session_chain.lease.resume_policy);

  assert.equal(
    acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'FRESH', expectGeneration: 99, runtime: 'claude' }).reason,
    'generation-mismatch',
  );
  assert.equal(readState(root, runId).data.status, 'paused');

  const acquired = acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'FRESH', expectGeneration: 1, runtime: 'claude' });
  assert.equal(acquired.reason, 'acquired');
  assert.equal(readState(root, runId).data.status, 'running');
});

test('acquireLease treats only Claude as matching a valid legacy runtime state', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  delete data.autonomy.session_runtime;
  delete data.autonomy.runtime_source;
  writeState(root, runId, data);
  releaseLease(root, runId, { owner: runId, generation: 1 });

  assert.deepEqual(
    acquireLease(root, runId, { attemptId: 'MIGRATEDATTEMPT01', owner: 'FRESH', expectGeneration: 1, runtime: 'codex' }),
    {
      ok: false, reason: 'RUNTIME_FENCED', expected: 'claude', actual: 'codex',
      proceed: false, consumed: null, replayed: false,
    },
  );
  const acquired = acquireLease(root, runId, {
    attemptId: 'MIGRATEDATTEMPT01',
    owner: 'FRESH', expectGeneration: 1, runtime: 'claude',
  });
  assert.equal(acquired.reason, 'acquired');
  assert.equal(readState(root, runId).data.session_chain.lease.owner_run_id, 'FRESH');
});

test('acquireLease rejects hash-valid malformed autonomy before a wrong-runtime takeover and mutates nothing', () => {
  for (const autonomy of [null, [], 'invalid', 1, true]) {
    const { root, runId } = seed('codex');
    releaseLease(root, runId, { owner: runId, generation: 1 });
    const { data } = readState(root, runId);
    data.autonomy = autonomy;
    writeHashValidState(root, runId, data);

    const dir = runDir(root, runId);
    const beforeLoop = readFileSync(join(dir, 'loop.json'), 'utf8');
    const beforeHash = readFileSync(join(dir, '.loop.hash'), 'utf8');
    const eventPath = join(dir, 'event-log.jsonl');
    const beforeEvents = existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null;

    assert.throws(
      () => acquireLease(root, runId, {
        attemptId: 'MIGRATEDATTEMPT01',
        owner: 'CLAUDE-OWNER', expectGeneration: 1, runtime: 'claude',
      }),
      /INVALID_RUNTIME_STATE: autonomy must be object/,
      `acquireLease accepted autonomy=${JSON.stringify(autonomy)}`,
    );
    const afterLoop = readFileSync(join(dir, 'loop.json'), 'utf8');
    assert.equal(afterLoop, beforeLoop);
    assert.equal(readFileSync(join(dir, '.loop.hash'), 'utf8'), beforeHash);
    assert.equal(existsSync(eventPath) ? readFileSync(eventPath, 'utf8') : null, beforeEvents);
    const after = JSON.parse(afterLoop);
    assert.equal(after.session_chain.lease.owner_run_id, runId);
    assert.equal(after.session_chain.lease.generation, 1);
    assert.equal(after.session_chain.lease.state, 'released');
    assert.equal(after.status, 'running');
  }
});

for (const [label, attemptId] of [
  ['undefined', undefined],
  ['null', null],
  ['empty', ''],
  ['short', 'short7c'],
  ['too-long', 'x'.repeat(129)],
  ['space', 'has space'],
  ['dot', 'has.dot'],
]) {
  test(`SLICE-002 acquireLease rejects ${label} attemptId before lock entry`, () => {
    const { root, runId } = seed();
    releaseLease(root, runId, { owner: runId, generation: 1 });
    const dir = runDir(root, runId);
    const before = {
      loop: readFileSync(join(dir, 'loop.json'), 'utf8'),
      hash: readFileSync(join(dir, '.loop.hash'), 'utf8'),
      events: existsSync(join(dir, 'event-log.jsonl'))
        ? readFileSync(join(dir, 'event-log.jsonl'), 'utf8')
        : null,
    };
    mkdirSync(join(dir, '.lock'));

    assert.throws(
      () => acquireLease(root, runId, {
        owner: 'FRESH', expectGeneration: 1, runtime: 'claude', attemptId,
      }),
      /^Error: INVALID_ATTEMPT_ID$/,
    );
    assert.equal(readFileSync(join(dir, 'loop.json'), 'utf8'), before.loop);
    assert.equal(readFileSync(join(dir, '.loop.hash'), 'utf8'), before.hash);
    assert.equal(
      existsSync(join(dir, 'event-log.jsonl')) ? readFileSync(join(dir, 'event-log.jsonl'), 'utf8') : null,
      before.events,
    );
  });
}

const ACTIVATION_ATTEMPT = 'ACTIVATIONATTEMPT01';
const ACTIVATION_TOKEN = 'ActivationToken_01';
const ACTIVATED_AT = Date.parse('2026-08-06T06:07:08.000Z');
const ACTIVATION_DEADLINE = '2026-08-06T06:15:00.000Z';

function seedActivationPending(runtime = 'claude') {
  const fixture = seed(runtime);
  assert.deepEqual(releaseLease(fixture.root, fixture.runId, {
    owner: fixture.runId, generation: 1,
  }), { ok: true, reason: 'released' });
  const owner = 'ACTIVATIONOWNER01';
  const acquired = acquireLease(fixture.root, fixture.runId, {
    owner, expectGeneration: 1, runtime, attemptId: ACTIVATION_ATTEMPT,
    now: Date.parse('2026-08-06T06:00:00.000Z'),
    clock: () => Date.parse('2026-08-06T06:00:00.000Z'),
  });
  assert.equal(acquired.proceed, true);
  return { ...fixture, owner, generation: 2 };
}

function activationDurableBytes(root, runId) {
  const dir = runDir(root, runId);
  const eventPath = join(dir, 'event-log.jsonl');
  return {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
    events: existsSync(eventPath) ? readFileSync(eventPath) : null,
  };
}

function activate(fixture, overrides = {}) {
  return leaseModule.activateLease(fixture.root, fixture.runId, {
    owner: fixture.owner,
    generation: fixture.generation,
    runtime: 'claude',
    attemptId: ACTIVATION_ATTEMPT,
    activationToken: ACTIVATION_TOKEN,
    now: ACTIVATED_AT,
    clock: () => Date.parse(ACTIVATION_DEADLINE) - 1,
    ...overrides,
  });
}

function activationFence(fixture) {
  return { owner: fixture.owner, generation: fixture.generation };
}

test('SLICE-005 leaseCheck fences only business intent while activation is pending', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  const fence = activationFence(f);
  assert.deepEqual(leaseCheck(data, fence), { ok: false, reason: 'ACTIVATION_PENDING' });
  assert.deepEqual(leaseCheck(data, { ...fence, intent: 'business' }), {
    ok: false, reason: 'ACTIVATION_PENDING',
  });
  for (const intent of ['lease', 'accounting', 'recover', 'resume', 'breaker-reset']) {
    assert.deepEqual(leaseCheck(data, { ...fence, intent }), { ok: true, reason: 'ok' });
  }
});

test('SLICE-005 activation-pending state patch rejects without anchored mutation', () => {
  const f = seedActivationPending();
  const before = activationDurableBytes(f.root, f.runId);
  assert.throws(() => patch(f.root, f.runId, 'discovered_items', ['pending-write'], {
    fence: activationFence(f),
  }), /LEASE_FENCED: ACTIVATION_PENDING/);
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-005 activation-pending newEpisode rejects without state or request mutation', () => {
  const f = seedActivationPending();
  const before = activationDurableBytes(f.root, f.runId);
  const episodesDir = join(runDir(f.root, f.runId), 'episodes');
  assert.throws(() => newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'slice-005',
    fence: activationFence(f),
  }), /LEASE_FENCED: ACTIVATION_PENDING/);
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
  assert.equal(existsSync(episodesDir), false);
});

test('SLICE-005 activation-pending newWorkstream rejects without anchored mutation', () => {
  const f = seedActivationPending();
  const before = activationDurableBytes(f.root, f.runId);
  assert.throws(() => newWorkstream(f.root, f.runId, {
    title: 'Pending workstream', branch: 'pending-workstream',
    worktree: '.claude/worktrees/pending-workstream', fence: activationFence(f),
  }), /LEASE_FENCED: ACTIVATION_PENDING/);
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-005 pending session-profile lease write succeeds but the next business write rejects', () => {
  const f = seedActivationPending();
  assert.deepEqual(setSessionProfile(f.root, f.runId, {
    model: 'gpt-5.6-sol', expect: activationFence(f),
  }), { ok: true, changed: true });
  const afterLeaseWrite = activationDurableBytes(f.root, f.runId);
  assert.throws(() => patch(f.root, f.runId, 'discovered_items', ['still-pending'], {
    fence: activationFence(f),
  }), /LEASE_FENCED: ACTIVATION_PENDING/);
  assert.deepEqual(activationDurableBytes(f.root, f.runId), afterLeaseWrite);
});

test('SLICE-005 activated lease permits state patch', () => {
  const f = seedActivationPending();
  assert.deepEqual(activate(f), { ok: true, reason: 'activated' });
  patch(f.root, f.runId, 'discovered_items', ['activated-write'], {
    fence: activationFence(f),
  });
  assert.deepEqual(readState(f.root, f.runId).data.discovered_items, ['activated-write']);
});

test('SLICE-005 activated lease permits newEpisode', () => {
  const f = seedActivationPending();
  activate(f);
  const result = newEpisode(f.root, f.runId, {
    plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'slice-005',
    fence: activationFence(f),
  });
  assert.equal(readState(f.root, f.runId).data.current_episode, result.id);
  assert.equal(existsSync(result.requestPath), true);
});

test('SLICE-005 activated lease permits newWorkstream', () => {
  const f = seedActivationPending();
  activate(f);
  const result = newWorkstream(f.root, f.runId, {
    title: 'Activated workstream', branch: 'activated-workstream',
    worktree: '.claude/worktrees/activated-workstream', fence: activationFence(f),
  });
  assert.equal(readState(f.root, f.runId).data.workstreams.at(-1).id, result.id);
});

test('SLICE-004 first activation commits the exact seven-key receipt and clears the deadline', () => {
  const f = seedActivationPending();
  assert.deepEqual(activate(f), { ok: true, reason: 'activated' });
  const current = readState(f.root, f.runId).data.session_chain.lease;
  assert.deepEqual(current.activation, {
    owner_run_id: f.owner,
    generation: 2,
    from_generation: 1,
    to_generation: 2,
    attempt_id: ACTIVATION_ATTEMPT,
    activation_token_digest: contentHash(ACTIVATION_TOKEN),
    activated_at: '2026-08-06T06:07:08.000Z',
  });
  assert.equal(current.activation_deadline_at, null);
});

test('SLICE-004 first activation uses the safety clock while public future now remains receipt-only', () => {
  const f = seedActivationPending();
  const publicFuture = Date.parse('2999-01-01T00:00:00.000Z');
  assert.deepEqual(activate(f, {
    now: publicFuture,
    clock: () => Date.parse(ACTIVATION_DEADLINE) - 1,
  }), { ok: true, reason: 'activated' });
  assert.equal(
    readState(f.root, f.runId).data.session_chain.lease.activation.activated_at,
    '2999-01-01T00:00:00.000Z',
  );
});

for (const [label, safetyNow] of [
  ['equal', Date.parse(ACTIVATION_DEADLINE)],
  ['after', Date.parse(ACTIVATION_DEADLINE) + 1],
]) {
  test(`SLICE-004 activation ${label} to the deadline is rejected so reap alone settles expiry`, () => {
    const f = seedActivationPending();
    const before = activationDurableBytes(f.root, f.runId);
    assert.deepEqual(activate(f, {
      now: Date.parse('2000-01-01T00:00:00.000Z'),
      clock: () => safetyNow,
    }), { ok: false, reason: 'activation-deadline-expired' });
    assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
    assert.equal(readState(f.root, f.runId).data.session_chain.lease.activation_deadline_at,
      ACTIVATION_DEADLINE);
    assert.deepEqual(reapLease(f.root, f.runId, {
      owner: f.owner,
      generation: f.generation,
      clock: () => safetyNow,
    }), { ok: true, reason: 'activation-expired', transition: 'preserve-pause' });
    assert.equal(readLines(f.root, f.runId).filter(event => event.type === 'lease-activated').length, 0);
    assert.equal(readLines(f.root, f.runId).filter(event => event.type === 'activation-expired').length, 1);
  });
}

test('SLICE-004 malformed nonnull activation deadline fails closed without laundering', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.activation_deadline_at = 'not-an-iso-deadline';
  writeHashValidState(f.root, f.runId, data);
  const before = activationDurableBytes(f.root, f.runId);
  assert.throws(() => activate(f), /ACTIVATION_DEADLINE_INVALID/);
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 activation event data is strictly equal to the committed receipt', () => {
  const f = seedActivationPending();
  activate(f);
  const receipt = readState(f.root, f.runId).data.session_chain.lease.activation;
  const events = readLines(f.root, f.runId).filter(event => event.type === 'lease-activated');
  assert.equal(events.length, 1);
  assert.deepStrictEqual(events[0].data, receipt);
  assert.deepEqual(Object.keys(events[0].data).sort(), [
    'activated_at', 'activation_token_digest', 'attempt_id', 'from_generation',
    'generation', 'owner_run_id', 'to_generation',
  ]);
});

test('SLICE-004 the actually committed activation receipt fails exact-shape schema mutations', () => {
  const f = seedActivationPending();
  activate(f);
  const state = readState(f.root, f.runId).data;
  assert.equal(validate(state).ok, true, validate(state).errors.join('; '));
  for (const mutate of [
    receipt => { delete receipt.owner_run_id; },
    receipt => { receipt.extra = true; },
    receipt => { receipt.generation = '2'; },
    receipt => { receipt.activation_token_digest = 'A'.repeat(64); },
  ]) {
    const candidate = structuredClone(state);
    mutate(candidate.session_chain.lease.activation);
    assert.equal(validate(candidate).ok, false);
  }
});

test('SLICE-004 same token is idempotent and appends no second event', () => {
  const f = seedActivationPending();
  activate(f);
  const before = activationDurableBytes(f.root, f.runId);
  assert.deepEqual(activate(f, {
    now: ACTIVATED_AT + 10_000,
    clock: () => Date.parse(ACTIVATION_DEADLINE) + 1,
  }), {
    ok: true, reason: 'already-activated',
  });
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
  assert.equal(readLines(f.root, f.runId).filter(event => event.type === 'lease-activated').length, 1);
});

test('SLICE-004 a different token loses first-wins without mutation', () => {
  const f = seedActivationPending();
  activate(f);
  const before = activationDurableBytes(f.root, f.runId);
  assert.deepEqual(activate(f, { activationToken: 'DifferentToken_02' }), {
    ok: false, reason: 'activation-token-mismatch',
  });
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 an attempt mismatch is structured and mutation-free', () => {
  const f = seedActivationPending();
  const before = activationDurableBytes(f.root, f.runId);
  assert.deepEqual(activate(f, { attemptId: 'OTHERATTEMPT0001' }), {
    ok: false, reason: 'attempt-mismatch',
  });
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 paused status outranks activation state and is mutation-free', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  data.status = 'paused';
  data.pause_reason = 'human-hold';
  writeState(f.root, f.runId, data);
  const before = activationDurableBytes(f.root, f.runId);
  assert.deepEqual(activate(f), { ok: false, reason: 'RUN_PAUSED' });
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 terminal status returns RUN_TERMINAL without mutation', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  data.status = 'completed';
  writeState(f.root, f.runId, data);
  const before = activationDurableBytes(f.root, f.runId);
  assert.deepEqual(activate(f), { ok: false, reason: 'RUN_TERMINAL' });
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 runtime mismatch precedes owner and generation fences', () => {
  const f = seedActivationPending();
  const before = activationDurableBytes(f.root, f.runId);
  assert.throws(() => activate(f, {
    runtime: 'codex', owner: 'WRONG', generation: 999,
  }), /RUNTIME_FENCED/);
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 matching runtime preserves owner then generation LEASE_FENCED failures', () => {
  const f = seedActivationPending();
  assert.throws(() => activate(f, { owner: 'WRONG' }), /LEASE_FENCED: owner-mismatch/);
  assert.throws(() => activate(f, { generation: 999 }), /LEASE_FENCED: generation-mismatch/);
});

test('SLICE-004 first consume rejects a nonactive lease as not activation pending', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.state = 'released';
  writeState(f.root, f.runId, data);
  assert.deepEqual(activate(f), { ok: false, reason: 'not-activation-pending' });
});

test('SLICE-004 first consume rejects a nonacquired handoff phase as not activation pending', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.handoff_phase = 'idle';
  writeState(f.root, f.runId, data);
  assert.deepEqual(activate(f), { ok: false, reason: 'not-activation-pending' });
});

test('SLICE-004 first consume rejects a null deadline as not activation pending', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.activation_deadline_at = null;
  writeState(f.root, f.runId, data);
  assert.deepEqual(activate(f), { ok: false, reason: 'not-activation-pending' });
});

test('SLICE-004 first consume rejects a missing legacy deadline as not activation pending', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  delete data.session_chain.lease.activation_deadline_at;
  writeState(f.root, f.runId, data);
  assert.deepEqual(activate(f), { ok: false, reason: 'not-activation-pending' });
});

test('SLICE-004 existing same-token activation bypasses later phase checks', () => {
  const f = seedActivationPending();
  activate(f);
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.state = 'released';
  data.session_chain.lease.handoff_phase = 'idle';
  writeState(f.root, f.runId, data);
  const before = activationDurableBytes(f.root, f.runId);
  assert.deepEqual(activate(f), { ok: true, reason: 'already-activated' });
  assert.deepEqual(activationDurableBytes(f.root, f.runId), before);
});

test('SLICE-004 invalid library attempt ids fail before lock entry', () => {
  const f = seedActivationPending();
  mkdirSync(join(runDir(f.root, f.runId), '.lock'));
  for (const attemptId of [undefined, null, '', 'bad!', 'short7']) {
    assert.throws(() => activate(f, { attemptId }), /^Error: INVALID_ATTEMPT_ID$/);
  }
});

test('SLICE-004 invalid library activation tokens fail before lock entry', () => {
  const f = seedActivationPending();
  mkdirSync(join(runDir(f.root, f.runId), '.lock'));
  for (const activationToken of [undefined, null, '', 'bad!', 'short7', 'x'.repeat(129)]) {
    assert.throws(() => activate(f, { activationToken }), /^Error: INVALID_ACTIVATION_TOKEN$/);
  }
});

test('SLICE-004 activation makes same-attempt acquire fall through to already-owned', () => {
  const f = seedActivationPending();
  activate(f);
  assert.deepEqual(acquireLease(f.root, f.runId, {
    owner: f.owner, expectGeneration: 1, runtime: 'claude', attemptId: ACTIVATION_ATTEMPT,
  }), {
    ok: true, generation: 2, reason: 'already-owned',
    proceed: false, consumed: null, replayed: false,
  });
});

const REAP_DEADLINE = ACTIVATION_DEADLINE;
const REAP_DECIDED = '2026-08-06T06:15:01.000Z';

function seedReapPending(overrides = {}) {
  const fixture = seedActivationPending();
  if (Object.keys(overrides).length > 0) {
    const { data } = readState(fixture.root, fixture.runId);
    Object.assign(data.session_chain.lease, overrides.lease || {});
    if (overrides.status !== undefined) data.status = overrides.status;
    if (overrides.pause_reason !== undefined) data.pause_reason = overrides.pause_reason;
    writeState(fixture.root, fixture.runId, data);
  }
  return fixture;
}

function reap(fixture, overrides = {}) {
  return reapLease(fixture.root, fixture.runId, {
    owner: fixture.owner,
    generation: fixture.generation,
    clock: () => Date.parse(REAP_DECIDED),
    ...overrides,
  });
}

function activationExpiredEvents(fixture) {
  return readLines(fixture.root, fixture.runId)
    .filter(event => event.type === 'activation-expired');
}

test('SLICE-007 exposes reapLease as the sole new reap library surface', () => {
  assert.equal(typeof reapLease, 'function');
});

test('SLICE-007 expired activation settles preserve-pause with an exact receipt and event', () => {
  const f = seedReapPending();
  assert.deepEqual(reap(f), {
    ok: true, reason: 'activation-expired', transition: 'preserve-pause',
  });
  const state = readState(f.root, f.runId).data;
  assert.equal(state.status, 'paused');
  assert.equal(state.pause_reason, 'activation-expired');
  assert.equal(state.resume_policy, 'human');
  assert.equal(state.session_chain.lease.activation_deadline_at, null);
  assert.deepStrictEqual(state.session_chain.lease.expiry_receipt, {
    decision_kind: 'activation-expiry',
    evidence_kind: 'kernel-activation-deadline',
    authority: 'kernel-clock',
    transition: 'preserve-pause',
    run_id: f.runId,
    subject_owner_run_id: f.owner,
    subject_attempt_id: ACTIVATION_ATTEMPT,
    subject_from_generation: 1,
    subject_to_generation: 2,
    deadline_at: REAP_DEADLINE,
    decided_at: REAP_DECIDED,
  });
  const events = activationExpiredEvents(f);
  assert.equal(events.length, 1);
  assert.deepStrictEqual(events[0].data, state.session_chain.lease.expiry_receipt);
});

test('SLICE-007 samples the safety clock once inside the expiry decision', () => {
  const f = seedReapPending();
  let samples = 0;
  reap(f, {
    clock: () => {
      samples += 1;
      return Date.parse(REAP_DECIDED);
    },
  });
  assert.equal(samples, 1);
});

test('SLICE-007 a deadline equal to the safety clock is expired', () => {
  const f = seedReapPending();
  assert.equal(reap(f, { clock: () => Date.parse(REAP_DEADLINE) }).ok, true);
});

test('SLICE-007 a deadline after the safety clock is mutation-free deadline-not-expired', () => {
  const f = seedReapPending();
  const before = durableLeaseBytes(f.root, f.runId);
  assert.deepEqual(reap(f, { clock: () => Date.parse(REAP_DEADLINE) - 1 }), {
    ok: false, reason: 'deadline-not-expired',
  });
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 activation before reap preserves the live principal as no-expiry-pending', () => {
  const f = seedReapPending();
  activate(f, { now: Date.parse(REAP_DECIDED) });
  const before = durableLeaseBytes(f.root, f.runId);
  assert.deepEqual(reap(f), { ok: false, reason: 'no-expiry-pending' });
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 past public acquire time cannot cause immediate safety expiry', () => {
  const { root, runId } = seed();
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const safetyNow = Date.parse('2026-08-09T12:00:00.000Z');
  const acquired = acquireLease(root, runId, {
    owner: 'PUBLICNOWREAPOWNER', expectGeneration: 1, runtime: 'claude',
    attemptId: 'PUBLICNOWREAPATTEMPT',
    now: Date.parse('2000-01-01T00:00:00.000Z'),
    clock: () => safetyNow,
  });
  assert.equal(acquired.proceed, true);
  assert.deepEqual(reapLease(root, runId, {
    owner: 'PUBLICNOWREAPOWNER', generation: acquired.generation,
    clock: () => safetyNow,
  }), { ok: false, reason: 'deadline-not-expired' });
});

test('SLICE-007 blocked pending release leaves the expiry reap path available', () => {
  const f = seedReapPending();
  assert.deepEqual(releaseLease(f.root, f.runId, {
    owner: f.owner, generation: f.generation,
  }), { ok: false, reason: 'ACTIVATION_PENDING' });
  assert.deepEqual(reap(f), {
    ok: true, reason: 'activation-expired', transition: 'preserve-pause',
  });
});

test('SLICE-007 wrong owner fences before terminal and deadline checks without mutation', () => {
  const f = seedReapPending();
  const { data } = readState(f.root, f.runId);
  data.status = 'completed';
  writeState(f.root, f.runId, data);
  const before = durableLeaseBytes(f.root, f.runId);
  assert.throws(() => reap(f, { owner: 'WRONGOWNER' }), /LEASE_FENCED: owner-mismatch/);
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 wrong generation is fenced without mutation', () => {
  const f = seedReapPending();
  const before = durableLeaseBytes(f.root, f.runId);
  assert.throws(() => reap(f, { generation: 99 }), /LEASE_FENCED: generation-mismatch/);
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 terminal outranks already-safe and returns RUN_TERMINAL without mutation', () => {
  const f = seedReapPending({ status: 'stopped' });
  const before = durableLeaseBytes(f.root, f.runId);
  assert.throws(() => reap(f), /RUN_TERMINAL/);
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 paused run is already-safe without mutation', () => {
  const f = seedReapPending({ status: 'paused', pause_reason: 'human-hold' });
  const before = durableLeaseBytes(f.root, f.runId);
  assert.deepEqual(reap(f), { ok: false, reason: 'already-safe' });
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 released lease with null deadline is already-safe', () => {
  const f = seedReapPending({ lease: { state: 'released', activation_deadline_at: null } });
  const before = durableLeaseBytes(f.root, f.runId);
  assert.deepEqual(reap(f), { ok: false, reason: 'already-safe' });
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 releasing lease with null deadline is already-safe', () => {
  const f = seedReapPending({ lease: {
    state: 'releasing', activation_deadline_at: null,
    expires_at: '2026-08-09T00:30:00.000Z',
  } });
  const before = durableLeaseBytes(f.root, f.runId);
  assert.deepEqual(reap(f), { ok: false, reason: 'already-safe' });
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});

test('SLICE-007 running nonactive lease with a deadline is anomaly-settled, not already-safe', () => {
  const f = seedReapPending({ lease: { state: 'released' } });
  const stateBefore = readState(f.root, f.runId).data;
  const preserved = {
    state: stateBefore.session_chain.lease.state,
    handoff_phase: stateBefore.session_chain.lease.handoff_phase,
    handoff_child_run_id: stateBefore.session_chain.lease.handoff_child_run_id,
  };
  assert.equal(reap(f).reason, 'activation-expired');
  const after = readState(f.root, f.runId).data.session_chain.lease;
  assert.deepEqual({
    state: after.state,
    handoff_phase: after.handoff_phase,
    handoff_child_run_id: after.handoff_child_run_id,
  }, preserved);
});

test('SLICE-007 replayed expiry evidence consumes no second event', () => {
  const f = seedReapPending();
  reap(f);
  const before = durableLeaseBytes(f.root, f.runId);
  assert.deepEqual(reap(f), { ok: false, reason: 'already-safe' });
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
  assert.equal(activationExpiredEvents(f).length, 1);
});

test('SLICE-007 stale fence rejects after reacquire and a fresh fence reaches the current deadline', () => {
  const f = seedReapPending();
  activate(f);
  assert.deepEqual(releaseLease(f.root, f.runId, {
    owner: f.owner, generation: f.generation,
  }), { ok: true, reason: 'released' });
  const acquired = acquireLease(f.root, f.runId, {
    owner: 'FRESHREAPOWNER', expectGeneration: f.generation, runtime: 'claude',
    attemptId: 'FRESHREAPATTEMPT', clock: () => Date.parse(REAP_DECIDED),
  });
  assert.equal(acquired.proceed, true);
  const before = durableLeaseBytes(f.root, f.runId);
  assert.throws(() => reap(f), /LEASE_FENCED/);
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
  assert.deepEqual(reapLease(f.root, f.runId, {
    owner: 'FRESHREAPOWNER', generation: acquired.generation,
    clock: () => Date.parse(REAP_DECIDED),
  }), { ok: false, reason: 'deadline-not-expired' });
});

test('SLICE-007 event-appended crash reconciles to exactly one expiry event', () => {
  const f = seedReapPending();
  assert.throws(() => reap(f, {
    __testFaultAt: barrier => {
      if (barrier === 'event:appended') throw new Error('SIMULATED_REAP_EVENT_CRASH');
    },
  }), /TRANSACTION_PENDING/);
  assert.deepEqual(reap(f), { ok: false, reason: 'already-safe' });
  assert.equal(activationExpiredEvents(f).length, 1);
  const state = readState(f.root, f.runId).data;
  assert.equal(state.status, 'paused');
  assert.deepStrictEqual(activationExpiredEvents(f)[0].data, state.session_chain.lease.expiry_receipt);
});

test('SLICE-007 actual expiry receipt and event data share exact schema rejection polarity', () => {
  const f = seedReapPending();
  reap(f);
  const committed = readState(f.root, f.runId).data;
  const eventData = activationExpiredEvents(f)[0].data;
  for (const [label, mutate] of [
    ['missing', value => { delete value.subject_attempt_id; }],
    ['extra', value => { value.extra = true; }],
    ['decision', value => { value.decision_kind = 'wrong-enum'; }],
    ['evidence', value => { value.evidence_kind = 'wrong-enum'; }],
    ['authority', value => { value.authority = 'wrong-enum'; }],
    ['transition', value => { value.transition = 'wrong-enum'; }],
  ]) {
    for (const [source, value] of [
      ['receipt', committed.session_chain.lease.expiry_receipt],
      ['event', eventData],
    ]) {
      const candidate = structuredClone(committed);
      candidate.status = 'paused';
      candidate.session_chain.lease.expiry_receipt = structuredClone(value);
      mutate(candidate.session_chain.lease.expiry_receipt);
      assert.equal(validate(candidate).ok, false, `${label}:${source}`);
    }
  }
});

function sameAttemptAfterPause(fixture) {
  return acquireLease(fixture.root, fixture.runId, {
    owner: fixture.owner,
    expectGeneration: 1,
    runtime: 'claude',
    attemptId: ACTIVATION_ATTEMPT,
  });
}

test('SLICE-008 F5 old principal return after reap is denied across replay, activation, and business write', () => {
  const f = seedReapPending();
  reap(f);
  assert.deepEqual(sameAttemptAfterPause(f), {
    ok: true, generation: 2, reason: 'already-owned',
    proceed: false, consumed: null, replayed: false,
  });
  assert.deepEqual(activate(f), { ok: false, reason: 'RUN_PAUSED' });
  assert.throws(() => patch(f.root, f.runId, 'discovered_items', ['double-progress'], {
    fence: activationFence(f),
  }), /RUN_PAUSED/);
  assert.equal(activationExpiredEvents(f).length, 1);
});

test('SLICE-008 F8 a live principal that lost the acquire response cannot replay after reap', () => {
  const f = seedReapPending();
  assert.equal(readState(f.root, f.runId).data.session_chain.lease.acquisition_receipt.attempt_id, ACTIVATION_ATTEMPT);
  reap(f);
  const retry = sameAttemptAfterPause(f);
  assert.equal(retry.proceed, false);
  assert.equal(retry.replayed, false);
  assert.equal(activationExpiredEvents(f).length, 1);
});

test('SLICE-008 F18 human preserve-pause revokes replay without changing the pending lease', () => {
  const f = seedActivationPending();
  const deadline = readState(f.root, f.runId).data.session_chain.lease.activation_deadline_at;
  pauseRun(f.root, f.runId, {
    reason: 'human-hold', mode: 'preserve',
    expect: activationFence(f), now: ACTIVATED_AT,
  });
  assert.equal(readState(f.root, f.runId).data.session_chain.lease.activation_deadline_at, deadline);
  assert.equal(sameAttemptAfterPause(f).replayed, false);
});

test('SLICE-008 F18 automation-host fail-closed preserve-pause revokes replay origin-neutrally', () => {
  const f = seedActivationPending();
  pauseRun(f.root, f.runId, {
    reason: 'usage-unmeasurable', mode: 'preserve',
    expect: activationFence(f), now: ACTIVATED_AT,
  });
  const retry = sameAttemptAfterPause(f);
  assert.equal(retry.proceed, false);
  assert.equal(retry.replayed, false);
});

test('SLICE-008 F18 kernel expiry preserve-pause revokes replay origin-neutrally', () => {
  const f = seedReapPending();
  reap(f);
  const retry = sameAttemptAfterPause(f);
  assert.equal(retry.proceed, false);
  assert.equal(retry.replayed, false);
});

function rotateActivatedGeneration() {
  const f = seedActivationPending();
  activate(f);
  assert.deepEqual(releaseLease(f.root, f.runId, {
    owner: f.owner, generation: f.generation,
  }), { ok: true, reason: 'released' });
  const nextOwner = 'SLICE008GEN3OWNER';
  const nextAttempt = 'SLICE008GEN3ATTEMPT';
  const acquired = acquireLease(f.root, f.runId, {
    owner: nextOwner,
    expectGeneration: f.generation,
    runtime: 'claude',
    attemptId: nextAttempt,
    clock: () => Date.parse('2026-08-09T12:00:00.000Z'),
  });
  assert.equal(acquired.proceed, true);
  return { ...f, nextOwner, nextAttempt, nextGeneration: acquired.generation };
}

test('SLICE-008 F21 generation rotation clears activation and expiry receipts and creates a fresh deadline', () => {
  const f = rotateActivatedGeneration();
  const current = readState(f.root, f.runId).data.session_chain.lease;
  assert.equal(Object.hasOwn(current, 'activation'), false);
  assert.equal(Object.hasOwn(current, 'expiry_receipt'), false);
  assert.equal(current.activation_deadline_at, '2026-08-09T12:15:00.000Z');
});

test('SLICE-008 F21 an old generation token cannot consume the new generation', () => {
  const f = rotateActivatedGeneration();
  assert.throws(() => leaseModule.activateLease(f.root, f.runId, {
    owner: f.owner,
    generation: f.generation,
    runtime: 'claude',
    attemptId: ACTIVATION_ATTEMPT,
    activationToken: ACTIVATION_TOKEN,
  }), /LEASE_FENCED/);
  assert.equal(Object.hasOwn(readState(f.root, f.runId).data.session_chain.lease, 'activation'), false);
});

test('SLICE-008 F21 recover then fresh acquire clears the prior expiry receipt', () => {
  const f = seedReapPending();
  reap(f);
  assert.equal(Object.hasOwn(readState(f.root, f.runId).data.session_chain.lease, 'expiry_receipt'), true);
  recoverRun(f.root, f.runId, {
    expect: activationFence(f),
    confirm: true,
    now: REAP_DECIDED,
  });
  const acquired = acquireLease(f.root, f.runId, {
    owner: 'SLICE008RECOVEREDOWNER',
    expectGeneration: f.generation,
    runtime: 'claude',
    attemptId: 'SLICE008RECOVERATTEMPT',
    clock: () => Date.parse('2026-08-09T13:00:00.000Z'),
  });
  assert.equal(acquired.proceed, true);
  assert.equal(Object.hasOwn(readState(f.root, f.runId).data.session_chain.lease, 'expiry_receipt'), false);
});

test('SLICE-008 F17 legacy active lease validates, reads, does not reap or replay, and remains byte-stable', () => {
  const f = seedActivationPending();
  const { data } = readState(f.root, f.runId);
  data.session_chain.lease.acquisition_receipt.attempt_id = null;
  delete data.session_chain.lease.activation_deadline_at;
  delete data.session_chain.lease.activation;
  delete data.session_chain.lease.expiry_receipt;
  writeState(f.root, f.runId, data);
  assert.equal(validate(readState(f.root, f.runId).data).ok, true);
  assert.equal(Object.hasOwn(readState(f.root, f.runId).data.session_chain.lease, 'activation_deadline_at'), false);
  const before = durableLeaseBytes(f.root, f.runId);
  assert.deepEqual(reapLease(f.root, f.runId, {
    owner: f.owner, generation: f.generation,
    clock: () => Date.parse(REAP_DECIDED),
  }), { ok: false, reason: 'no-expiry-pending' });
  const retry = acquireLease(f.root, f.runId, {
    owner: f.owner, expectGeneration: 1, runtime: 'claude', attemptId: ACTIVATION_ATTEMPT,
  });
  assert.equal(retry.proceed, false);
  assert.equal(retry.replayed, false);
  assert.deepEqual(durableLeaseBytes(f.root, f.runId), before);
});
