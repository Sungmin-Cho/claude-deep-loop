// Task 7: opt-in nonce — offer/confirm/decline (fenced, appendAnchored) — TDD RED→GREEN
// Hand-built seeds (no initRun) per task hygiene — matches pause.test.mjs / recover.test.mjs convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { appendAnchored, directMutationOptions } from '../scripts/lib/integrity.mjs';
import { offerDesktop, confirmDesktop, declineDesktop, resetDesktop } from '../scripts/lib/spawn-optin.mjs';
import { seedCorrelatedTerminal as terminal7b } from './fixtures/verified-app-run.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const OWNER = '01KX9SZA00V7WATCFMFBBDJSRM';
const GEN = 1;
const T0 = Date.parse('2026-07-01T00:00:00.000Z');

// Round-6 review fix (part a): confirmDesktop now gates the desktop→ transition on a LIVE
// desktopProbe({platform}) result — lib-level happy-path tests inject a deterministic PASSING probe so
// they never depend on this host's real Claude Desktop install (host-dependence is confined to the
// dedicated probe-desktop/confirm-desktop CLI smoke tests below, which stay host-gated).
const passingProbe = () => ({ ok: true, argvTarget: { kind: 'macos-app', appPath: '/Applications/Claude.app' } });
const failingProbe = () => ({ ok: false, reason: 'signature-invalid' });

// Round-7 review fix, Finding 2: computed ONCE at module load by actually running the real, uninjected
// `probe-desktop` CLI verb — NOT inferred from `process.platform` alone. A darwin/win32 host with no
// verified Claude Desktop install (clean CI, a Windows box before ALLOW_WIN_PUBLISHERS is confirmed
// against a real signature — see desktop-target.mjs) reports {ok:false}, and any CLI test that exercises
// the REAL confirm-desktop happy path (which always probes the real, uninjected desktopProbe — see
// spawn-optin.mjs confirmDesktop) must be skipped there too, or `npm test` becomes host-dependent. On a
// host that IS provisioned (this dev machine), it stays gated to true and the happy-path still runs.
const desktopProbeVerified = (() => {
  if (!['darwin', 'win32'].includes(process.platform)) return false;
  try {
    const out = execFileSync('node', [CLI, 'spawn-style', 'probe-desktop'], { encoding: 'utf8' });
    return JSON.parse(out).ok === true;
  } catch { return false; }
})();

function baseData(overrides = {}) {
  return {
    schema_version: '0.2.0', run_id: OWNER, goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'deep-work' }, review: { points: ['design'] },
    autonomy: { tier: 'recommend', spawn_style: 'visible' },
    budget: { unit: 'turns', spent: 0 },
    event_log_head: { seq: 0, checksum: 'GENESIS' },
    comprehension: {}, circuit_breaker: { tripped: false },
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'active', handoff_phase: 'idle',
        handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null,
        acquired_at: '2026-07-01T00:00:00.000Z',
      },
      sessions: [{ run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null }],
    },
    workstreams: [], active_workstreams: [],
    triage: { actionable: [] }, episodes: [], termination: {},
    ...overrides,
  };
}

function seedFreshRun({ spawn_style } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-spawn-optin-'));
  const runId = OWNER;
  mkdirSync(runDir(root, runId), { recursive: true });
  const data = baseData();
  data.project.root = root;
  if (spawn_style) data.autonomy.spawn_style = spawn_style;
  writeState(root, runId, data);
  withCurrentPointer(root, runId);
  return { root, runId, expect: { owner: OWNER, generation: GEN } };
}

// test seam: simulate a concurrent, legitimate kernel-transition changing spawn_style out-of-band
// (a real appendAnchored transaction, distinct from the opt-in path under test).
function forceSpawnStyle(root, runId, style) {
  appendAnchored(root, runId, { type: 'test-force-spawn-style', data: { style } },
    (l) => { l.autonomy.spawn_style = style; }, undefined,
    directMutationOptions('test-force-spawn-style',
      { owner: OWNER, generation: GEN }, { style }, 'LEASE_FENCED: test'));
}

// Round-7 review fix (Finding 1): reproduces the EXACT stuck state respawn.mjs's preservePause leaves
// behind on a desktop-unavailable respawn — status='paused', lease.state='releasing' (handoff still
// 'emitted', reserved child never acquired), spawn_style='desktop'. Mirrors recover.test.mjs's baseData
// override shape (same seeding convention for a preserve-paused run).
function seedPausedReleasingDesktop() {
  const root = mkdtempSync(join(tmpdir(), 'dl-spawn-optin-stuck-'));
  const runId = OWNER;
  const CHILD = '01KX9SZA00V7WATCFMFBBDJSRN';
  mkdirSync(runDir(root, runId), { recursive: true });
  const data = baseData({
    status: 'paused',
    pause_reason: 'desktop-launcher-unavailable',
    autonomy: { tier: 'recommend', spawn_style: 'desktop' },
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: 'releasing', handoff_phase: 'emitted',
        handoff_idempotency_key: 'key123', handoff_child_run_id: CHILD,
        expires_at: null, resume_policy: 'human', acquired_at: '2026-07-01T00:00:00.000Z',
      },
      sessions: [
        { run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: CHILD },
        { run_id: CHILD, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null },
      ],
    },
  });
  data.project.root = root;
  writeState(root, runId, data);
  withCurrentPointer(root, runId);
  return { root, runId, expect: { owner: OWNER, generation: GEN } };
}

function withCurrentPointer(root, runId) {
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
}

// ── lib: offerDesktop / confirmDesktop / declineDesktop ──────────────────────

test('confirm without pending nonce is rejected', () => {
  const { root, runId, expect } = seedFreshRun();
  const r = confirmDesktop(root, runId, { expect, now: T0, nonce: 'n1', platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NONCE_INVALID');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('offer→confirm transitions to desktop and consumes nonce (single-use)', () => {
  const { root, runId, expect } = seedFreshRun();
  const o = offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  assert.equal(o.ok, true);
  assert.equal(o.nonce, 'n1');
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending.nonce, 'n1');
  assert.equal(confirmDesktop(root, runId, { expect, now: T0 + 1000, nonce: 'n1', platform: 'darwin', desktopProbe: passingProbe }).ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined, 'pending cleared on confirm');
  // reuse rejected — nonce is single-use
  const r2 = confirmDesktop(root, runId, { expect, now: T0 + 2000, nonce: 'n1', platform: 'darwin', desktopProbe: passingProbe });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'NONCE_INVALID');
});

test('offerDesktop generates a nonce via crypto.randomUUID when none injected', () => {
  const { root, runId, expect } = seedFreshRun();
  const o = offerDesktop(root, runId, { expect, now: T0 });
  assert.equal(o.ok, true);
  assert.equal(typeof o.nonce, 'string');
  assert.ok(o.nonce.length > 0);
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending.nonce, o.nonce);
});

test('offerDesktop default TTL is 600s from injected now', () => {
  const { root, runId, expect } = seedFreshRun();
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const pending = readState(root, runId).data.autonomy.spawn_style_optin_pending;
  assert.equal(Date.parse(pending.expires_at), T0 + 600 * 1000);
});

test('decline clears pending nonce', () => {
  const { root, runId, expect } = seedFreshRun();
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const d = declineDesktop(root, runId, { expect, now: T0 + 1000 });
  assert.equal(d.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined);
  assert.equal(confirmDesktop(root, runId, { expect, now: T0 + 2000, nonce: 'n1', platform: 'darwin' }).ok, false);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('expired nonce is rejected', () => {
  const { root, runId, expect } = seedFreshRun();
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1', ttlSec: 600 });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 600001, nonce: 'n1', platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NONCE_EXPIRED');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('confirm rejected when spawn_style not in {visible,interactive} (headless)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'headless' });
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1', platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SOURCE_INVALID');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'headless');
});

test('confirm accepted when spawn_style=interactive', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'interactive' });
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1', platform: 'darwin', desktopProbe: passingProbe });
  assert.equal(r.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
});

// Round-6 review fix, part (a) — codex both reviewers 2/2: confirmDesktop must never persist
// spawn_style='desktop' unless the handler that will actually be invoked on every future handoff
// verifies RIGHT NOW. A FAILING probe rejects with HANDLER_UNVERIFIED, leaves spawn_style untouched,
// and — critically — does NOT consume the pending nonce (no half-commit; a subsequent confirm with a
// PASSING probe using the SAME nonce still succeeds).
test('confirmDesktop with a FAILING desktopProbe rejects HANDLER_UNVERIFIED — no transition, nonce not consumed', () => {
  const { root, runId, expect } = seedFreshRun();
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1', platform: 'darwin', desktopProbe: failingProbe });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HANDLER_UNVERIFIED');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible', 'spawn_style unchanged on a failing probe');
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending.nonce, 'n1', 'nonce NOT consumed by a rejected confirm');
  // the SAME nonce still works once the handler verifies — proves no half-commit / no nonce burn.
  const r2 = confirmDesktop(root, runId, { expect, now: T0 + 2, nonce: 'n1', platform: 'darwin', desktopProbe: passingProbe });
  assert.equal(r2.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
});

test('confirmDesktop with a FAILING desktopProbe appends NO event (no half-commit)', () => {
  const { root, runId, expect } = seedFreshRun();
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const beforeSeq = readState(root, runId).data.event_log_head.seq;
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1', platform: 'darwin', desktopProbe: failingProbe });
  assert.equal(r.ok, false);
  assert.equal(readState(root, runId).data.event_log_head.seq, beforeSeq, 'a HANDLER_UNVERIFIED rejection must not advance event_log_head');
});

// Finding 2 (round-3 review): kernel-side platform guard — confirmDesktop must reject the transition
// on an unsupported platform even with an otherwise-valid nonce + source state, so a buggy skill can
// never durably set spawn_style='desktop' on Linux (Claude Desktop only ships for macOS/Windows).
test('confirmDesktop with platform:"linux" is rejected (PLATFORM_UNSUPPORTED) even with valid nonce + visible source', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'visible' });
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1', platform: 'linux' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'PLATFORM_UNSUPPORTED');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible', 'spawn_style unchanged');
  // the pending nonce is also untouched (preCheck threw before mutate ran) — a subsequent confirm on
  // a supported platform with the SAME nonce still succeeds, proving no partial mutation occurred.
  const r2 = confirmDesktop(root, runId, { expect, now: T0 + 2, nonce: 'n1', platform: 'darwin', desktopProbe: passingProbe });
  assert.equal(r2.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
});

test('offerDesktop is unconditional on source-state (only fenced, not source-restricted)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'headless' });
  const o = offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  assert.equal(o.ok, true);
  assert.ok(readState(root, runId).data.autonomy.spawn_style_optin_pending);
});

test('fence mismatch → confirmDesktop throws LEASE_FENCED (fence checked first, even with no pending)', () => {
  const { root, runId } = seedFreshRun();
  assert.throws(() => confirmDesktop(root, runId, { expect: { owner: 'wrong', generation: 1 }, now: T0, nonce: 'n1', platform: 'darwin' }), /LEASE_FENCED/);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('fence mismatch → offerDesktop and declineDesktop also throw LEASE_FENCED', () => {
  const { root, runId, expect } = seedFreshRun();
  assert.throws(() => offerDesktop(root, runId, { expect: { owner: 'wrong', generation: GEN }, now: T0, nonce: 'n1' }), /LEASE_FENCED/);
  assert.throws(() => declineDesktop(root, runId, { expect: { owner: expect.owner, generation: 99 }, now: T0 }), /LEASE_FENCED/);
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined, 'no mutation on fenced call');
});

test('missing/invalid fence shape throws FENCE_REQUIRED (defense-in-depth)', () => {
  const { root, runId } = seedFreshRun();
  assert.throws(() => confirmDesktop(root, runId, { now: T0, nonce: 'n1', platform: 'darwin' }), /FENCE_REQUIRED/);
  assert.throws(() => offerDesktop(root, runId, { now: T0, nonce: 'n1' }), /FENCE_REQUIRED/);
  assert.throws(() => declineDesktop(root, runId, { now: T0 }), /FENCE_REQUIRED/);
});

test('confirm rechecks source state IN-LOCK (stale pre-read cannot overwrite a concurrent transition)', () => {
  const { root, runId, expect } = seedFreshRun();                 // visible
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  forceSpawnStyle(root, runId, 'headless');                       // concurrent legit transition (test seam)
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1', platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SOURCE_INVALID');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'headless');   // not overwritten to desktop
});

test('confirmDesktop appends exactly one event on success; rejections append none', () => {
  const { root, runId, expect } = seedFreshRun();
  confirmDesktop(root, runId, { expect, now: T0, nonce: 'n1', platform: 'darwin' });                       // rejected: no pending
  const afterReject = readState(root, runId).data.event_log_head;
  assert.equal(afterReject.seq, 0, 'a rejected confirm must append NO event');
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1', platform: 'darwin', desktopProbe: passingProbe });                   // accepted
  const afterAccept = readState(root, runId).data.event_log_head;
  assert.equal(afterAccept.seq, 3,
    'legacy checkpoint + offer + confirm each append exactly one event');
});

// ── out-of-range ttlSec must fail BEFORE appendAnchored, never half-commit an event ──
// (Finding 2: computing `new Date(now + ttlSec*1000)` INSIDE the appendAnchored mutate callback
// throws AFTER the event is already appended — appendAnchored appends the event, THEN runs mutate,
// THEN writes loop.json's event_log_head anchor (see integrity.mjs). A digits-but-out-of-range
// --ttl-sec passes the CLI's `/^\d+$/` integer check yet overflows Date's ~±8.64e15ms range →
// `RangeError: Invalid time value` from mutate → event-log.jsonl ends up ahead of the persisted
// anchor → every subsequent op fails LOG_TAMPERED. The fix computes+validates the expiry BEFORE
// entering appendAnchored, so an invalid ttlSec never appends anything at all.)
test('offerDesktop with out-of-range ttlSec returns {ok:false} and appends NO event (no half-commit)', () => {
  const { root, runId, expect } = seedFreshRun();
  const before = readState(root, runId).data.event_log_head;
  assert.equal(before.seq, 0);

  const r = offerDesktop(root, runId, { expect, now: T0, ttlSec: Number.MAX_SAFE_INTEGER, nonce: 'n1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'INVALID_TTL_SEC');

  // no event appended, no pending nonce persisted, anchor untouched — no half-commit.
  const after = readState(root, runId).data.event_log_head;
  assert.deepEqual(after, before, 'a rejected offer must not advance event_log_head at all');
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined);

  // crucially: a subsequent NORMAL kernel op on the same run must still work — proof the log/anchor
  // was never corrupted (no LOG_TAMPERED fallout from a half-committed event).
  const o = offerDesktop(root, runId, { expect, now: T0 + 1000, nonce: 'n2' });
  assert.equal(o.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending.nonce, 'n2');
  assert.equal(readState(root, runId).data.event_log_head.seq, 2,
    'the checkpoint and good offer are the first events — the bad one appended none');
});

test('offerDesktop with non-finite now returns {ok:false} INVALID_TTL_SEC and appends no event', () => {
  const { root, runId, expect } = seedFreshRun();
  const r = offerDesktop(root, runId, { expect, now: NaN, ttlSec: 600, nonce: 'n1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'INVALID_TTL_SEC');
  assert.equal(readState(root, runId).data.event_log_head.seq, 0);
});

// ── lib: resetDesktop (Round-6 review, part c — human recovery downgrade) ────

test('resetDesktop transitions desktop -> visible (fenced)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'desktop' });
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('resetDesktop also clears a stray pending nonce', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'desktop' });
  // defensive case: a pending nonce left over despite spawn_style already being 'desktop'.
  appendAnchored(root, runId, { type: 'test-force-pending', data: {} }, (l) => {
    l.autonomy.spawn_style_optin_pending = { nonce: 'stray', expires_at: new Date(T0 + 1000).toISOString() };
  }, undefined, directMutationOptions('test-force-pending',
    { owner: OWNER, generation: GEN }, { nonce: 'stray', expiresAt: T0 + 1000 },
    'LEASE_FENCED: test'));
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined);
});

test('resetDesktop rejected when spawn_style is not desktop (SOURCE_INVALID, no mutation)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'visible' });
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SOURCE_INVALID');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('resetDesktop fence mismatch throws LEASE_FENCED, no mutation', () => {
  const { root, runId } = seedFreshRun({ spawn_style: 'desktop' });
  assert.throws(() => resetDesktop(root, runId, { expect: { owner: 'wrong', generation: 1 }, now: T0 }), /LEASE_FENCED/);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
});

test('resetDesktop missing/invalid fence shape throws FENCE_REQUIRED', () => {
  const { root, runId } = seedFreshRun({ spawn_style: 'desktop' });
  assert.throws(() => resetDesktop(root, runId, { now: T0 }), /FENCE_REQUIRED/);
});

test('resetDesktop appends exactly one event on success; rejections append none', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'visible' });
  resetDesktop(root, runId, { expect, now: T0 });                         // rejected: not desktop
  assert.equal(readState(root, runId).data.event_log_head.seq, 0, 'a rejected reset must append NO event');
  forceSpawnStyle(root, runId, 'desktop');
  const afterForce = readState(root, runId).data.event_log_head.seq;
  const r = resetDesktop(root, runId, { expect, now: T0 + 1 });
  assert.equal(r.ok, true);
  assert.equal(readState(root, runId).data.event_log_head.seq, afterForce + 1, 'a successful reset appends exactly one event');
});

// Round-7 review fix, Finding 1: resetDesktop is the escape hatch for a run stuck in EXACTLY the state a
// desktop-unavailable respawn leaves it in (status='paused', lease.state='releasing') — proves it is NOT
// fenced out of the paused/releasing state it exists to repair, and that a wrong owner/generation is
// still correctly rejected (LEASE_FENCED) even in that same stuck state (not accidentally wide-open).
test('resetDesktop succeeds while status=paused and lease.state=releasing (the exact desktop-unavailable stuck state)', () => {
  const { root, runId, expect } = seedPausedReleasingDesktop();
  const before = readState(root, runId).data;
  assert.equal(before.status, 'paused');
  assert.equal(before.session_chain.lease.state, 'releasing');
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, true);
  const after = readState(root, runId).data;
  assert.equal(after.autonomy.spawn_style, 'visible');
  // status/lease.state deliberately untouched — downgrading spawn_style is the full scope of this op;
  // unpausing is left to the existing `recover` path (see spawn-optin.mjs resetDesktop doc comment).
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.state, 'releasing');
});

test('resetDesktop wrong owner/generation while paused+releasing still throws LEASE_FENCED (no mutation)', () => {
  const { root, runId } = seedPausedReleasingDesktop();
  assert.throws(() => resetDesktop(root, runId, { expect: { owner: 'wrong', generation: 1 }, now: T0 }), /LEASE_FENCED/);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'no mutation on a fenced call');
});

// Round-10 review fix (codex review P2 + adversarial [medium]): resetDesktop's bespoke owner+generation
// fence must ALSO reject released leases and terminal runs — recoverRun (whose pattern this borrows) is
// safe only because it additionally gates on status==='paused'. Without these guards a stale former owner
// whose generation is still recorded could mutate spawn_style after `lease release` (state==='released') or
// after the run settled (completed/stopped). Helper seeds a desktop run with a custom status/lease.state.
function seedDesktopWith({ status = 'running', leaseState = 'active', handoffPhase = 'idle' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dl-spawn-optin-reset-'));
  const runId = OWNER;
  mkdirSync(runDir(root, runId), { recursive: true });
  const terminal = ['completed', 'stopped'].includes(status) ? status : null;
  const data = baseData({
    status: terminal ? 'running' : status,
    autonomy: { tier: 'recommend', spawn_style: 'desktop' },
    session_chain: {
      lease: {
        owner_run_id: OWNER, generation: GEN, state: leaseState, handoff_phase: handoffPhase,
        handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null,
        acquired_at: '2026-07-01T00:00:00.000Z',
      },
      sessions: [{ run_id: OWNER, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null }],
    },
  });
  data.project.root = root;
  writeState(root, runId, data);
  withCurrentPointer(root, runId);
  if (terminal) terminal7b(root, runId, { status: terminal });
  return { root, runId, expect: { owner: OWNER, generation: GEN } };
}

test('resetDesktop on a RELEASED lease is fenced (LEASE_FENCED: lease-released) even with matching owner/generation — no mutation', () => {
  const { root, runId, expect } = seedDesktopWith({ leaseState: 'released' });
  assert.throws(() => resetDesktop(root, runId, { expect, now: T0 }), /LEASE_FENCED: lease-released/);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'released lease must not permit a spawn_style mutation');
});

test('resetDesktop on a COMPLETED (terminal) run is rejected (RUN_TERMINAL, exit-1 semantics) — no mutation', () => {
  const { root, runId, expect } = seedDesktopWith({ status: 'completed' });
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'RUN_TERMINAL');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'terminal run is settled — no mutation');
});

test('resetDesktop on a STOPPED (terminal) run is rejected (RUN_TERMINAL) — no mutation', () => {
  const { root, runId, expect } = seedDesktopWith({ status: 'stopped' });
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'RUN_TERMINAL');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'terminal run is settled — no mutation');
});

// The healthy downgrade path (running + active lease) still works — the new guards fence out ONLY
// released/terminal, not the normal case resetDesktop is also meant to serve.
test('resetDesktop on a healthy running+active desktop run still succeeds (guards do not over-fence)', () => {
  const { root, runId, expect } = seedDesktopWith({ status: 'running', leaseState: 'active' });
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

// Round-11 review fix (codex adversarial [high]): a HEALTHY in-flight handoff is status='running' +
// lease.state='releasing' + handoff_phase='emitted' (emitHandoff refuses to emit on a paused run, so this
// is NOT the paused+releasing escape hatch). resetDesktop must NOT flip spawn_style in that window — doing
// so mid-handoff could strand the emitted handoff unpaused with no child acquired. Rejected as
// HANDOFF_IN_FLIGHT (exit-1 semantics), no mutation. The paused+releasing escape hatch (tested above) and
// the running+active healthy downgrade (tested above) are BOTH still allowed — this fences out only the
// running+releasing shape.
test('resetDesktop during a healthy in-flight handoff (running+releasing+emitted) is rejected (HANDOFF_IN_FLIGHT) — no mutation', () => {
  const { root, runId, expect } = seedDesktopWith({ status: 'running', leaseState: 'releasing', handoffPhase: 'emitted' });
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HANDOFF_IN_FLIGHT');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'must not flip spawn_style mid-handoff');
});

test('resetDesktop during a running+releasing+spawned handoff is also rejected (HANDOFF_IN_FLIGHT)', () => {
  const { root, runId, expect } = seedDesktopWith({ status: 'running', leaseState: 'releasing', handoffPhase: 'spawned' });
  const r = resetDesktop(root, runId, { expect, now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HANDOFF_IN_FLIGHT');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'must not flip spawn_style mid-handoff');
});

// ── CLI: spawn-style probe-desktop ────────────────────────────────────────────

// Round-7 review fix, Finding 2: asserts SHAPE only (exit 0, valid JSON, boolean `ok`) — never `ok===true`.
// Asserting a real positive verdict here would require an actual verified /Applications/Claude.app (or
// win32 equivalent) install on the host running `npm test`, which fails on a clean CI runner / Windows
// placeholder and breaks the zero-external-dep, host-independent preflight invariant (CLAUDE.md). The
// POSITIVE (ok:true) path is proven deterministically via INJECTED probes in tests/desktop-target.test.mjs
// (defaultDesktopProbe) and tests/desktop-handler.test.mjs (verifyDesktopHandler) — this CLI test only
// proves the subcommand is wired, read-only, and returns a well-shaped verdict on ANY host.
test('CLI spawn-style probe-desktop is read-only and prints a well-shaped probe verdict (host-independent)', () => {
  const out = execFileSync('node', [CLI, 'spawn-style', 'probe-desktop'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(typeof r.ok, 'boolean');
});

test('CLI spawn-style probe-desktop needs no run/owner/generation (works with no active run at all)', () => {
  // deliberately no --project-root / --owner / --generation — proves it never touches lease/state.
  const out = execFileSync('node', [CLI, 'spawn-style', 'probe-desktop'], { encoding: 'utf8', cwd: mkdtempSync(join(tmpdir(), 'dl-probe-no-run-')) });
  assert.equal(typeof JSON.parse(out).ok, 'boolean');
});

// ── CLI: spawn-style reset-desktop ────────────────────────────────────────────

test('CLI spawn-style reset-desktop transitions desktop -> visible (exit 0)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'desktop' });
  withCurrentPointer(root, runId);
  const out = execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('CLI spawn-style reset-desktop wrong generation exits 3 (fence)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'desktop' });
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', expect.owner, '--generation', '99', '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 3);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'a fenced-out reset must not mutate spawn_style');
});

test('CLI spawn-style reset-desktop when spawn_style is not desktop exits 1 (SOURCE_INVALID)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'visible' });
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 1);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

// Round-7 review fix, Finding 1: the CLI-level proof that reset-desktop is NOT fenced out of the exact
// stuck state it exists to repair (status='paused', lease.state='releasing' — see respawn.mjs
// preservePause on a desktop-launcher-unavailable respawn). Previously this went through requireLease's
// default business-intent leaseCheck() at the CLI precheck layer and returned exit 3 (LEASE_FENCED)
// before ever reaching resetDesktop.
test('CLI spawn-style reset-desktop succeeds while status=paused and lease.state=releasing (exit 0)', () => {
  const { root, runId, expect } = seedPausedReleasingDesktop();
  withCurrentPointer(root, runId);
  const out = execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).ok, true);
  const after = readState(root, runId).data;
  assert.equal(after.autonomy.spawn_style, 'visible');
  assert.equal(after.status, 'paused', 'unpausing is left to the existing recover path, not reset-desktop');
});

test('CLI spawn-style reset-desktop wrong owner while paused+releasing still exits 3 (fence, not RUN_PAUSED bypass)', () => {
  const { root, runId, expect } = seedPausedReleasingDesktop();
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', 'wrong-owner', '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 3);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'a fenced-out reset must not mutate spawn_style');
});

// Round-10 review fix: CLI-level proof of the released/terminal fences. A released lease with a matching
// owner/generation must still exit 3 (LEASE_FENCED — invariant #2), and a terminal run must exit 1
// (RUN_TERMINAL — invariant #4); neither may mutate spawn_style.
test('CLI spawn-style reset-desktop on a RELEASED lease exits 3 (fence) — no mutation', () => {
  const { root, runId, expect } = seedDesktopWith({ leaseState: 'released' });
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 3);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'a released-lease reset must not mutate spawn_style');
});

test('CLI spawn-style reset-desktop on a COMPLETED (terminal) run exits 1 (RUN_TERMINAL) — no mutation', () => {
  const { root, runId, expect } = seedDesktopWith({ status: 'completed' });
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 1);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'a terminal-run reset must not mutate spawn_style');
});

test('CLI spawn-style reset-desktop during a healthy in-flight handoff (running+releasing) exits 1 (HANDOFF_IN_FLIGHT) — no mutation', () => {
  const { root, runId, expect } = seedDesktopWith({ status: 'running', leaseState: 'releasing', handoffPhase: 'emitted' });
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'reset-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 1);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop', 'reset during an in-flight handoff must not mutate spawn_style');
});

// ── CLI: spawn-style offer-desktop | confirm-desktop | decline-desktop ───────

// confirm-desktop's CLI wrapper doesn't take a --platform flag (it reads process.platform, unlike
// the lib-level confirmDesktop tests above which inject platform:'darwin') — the round-3
// PLATFORM_UNSUPPORTED guard (spawn-optin.mjs confirmDesktop check ②) makes this exit 1 on any host
// other than macOS/Windows (e.g. a Linux CI runner). Skip rather than weaken: the lib-level tests
// already prove the guard's behavior on every platform via injection (Finding 2, round-5 review).
// Round-7 review fix, Finding 2: gated on `desktopProbeVerified` (an ACTUAL positive probe result), not
// just platform — a darwin/win32 host without a verified Claude Desktop install (clean CI) also skips,
// since confirm-desktop's real (uninjected) desktopProbe would report HANDLER_UNVERIFIED there too.
test('CLI spawn-style offer-desktop → confirm-desktop happy path (exit 0, spawn_style=desktop)', { skip: !desktopProbeVerified }, () => {
  const { root, runId, expect } = seedFreshRun();
  withCurrentPointer(root, runId);
  const outOffer = execFileSync('node', [CLI, 'spawn-style', 'offer-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--nonce', 'n1', '--now', String(T0), '--project-root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(outOffer).ok, true);
  const outConfirm = execFileSync('node', [CLI, 'spawn-style', 'confirm-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--nonce', 'n1', '--now', String(T0 + 1000), '--project-root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(outConfirm).ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
});

test('CLI spawn-style decline-desktop clears pending (exit 0)', () => {
  const { root, runId, expect } = seedFreshRun();
  withCurrentPointer(root, runId);
  execFileSync('node', [CLI, 'spawn-style', 'offer-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--nonce', 'n1', '--project-root', root], { encoding: 'utf8' });
  execFileSync('node', [CLI, 'spawn-style', 'decline-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined);
});

test('CLI spawn-style confirm-desktop with no pending exits 1 (rejection, not fence)', () => {
  const { root, runId, expect } = seedFreshRun();
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'confirm-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--nonce', 'n1', '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 1);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('CLI spawn-style confirm-desktop wrong generation exits 3', () => {
  const { root, runId, expect } = seedFreshRun();
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'confirm-desktop', '--owner', expect.owner, '--generation', '99', '--nonce', 'n1', '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('CLI spawn-style missing --owner/--generation exits 3', () => {
  const { root, runId } = seedFreshRun();
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'offer-desktop', '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('CLI spawn-style unknown verb exits 2 (with a valid fence)', () => {
  const { root, runId, expect } = seedFreshRun();
  withCurrentPointer(root, runId);
  let code = 0;
  try {
    execFileSync('node', [CLI, 'spawn-style', 'bogus-verb', '--owner', expect.owner, '--generation', String(expect.generation), '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; }
  assert.equal(code, 2);
});

// ── CLI --ttl-sec flag (offer-desktop) ────────────────────────────────────────

test('CLI spawn-style offer-desktop --ttl-sec notanumber exits 1 (INVALID_TTL_SEC)', () => {
  const { root, runId, expect } = seedFreshRun();
  withCurrentPointer(root, runId);
  let code = 0, stderr = '';
  try {
    execFileSync('node', [CLI, 'spawn-style', 'offer-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--ttl-sec', 'notanumber', '--project-root', root], { encoding: 'utf8' });
  } catch (e) { code = e.status; stderr = String(e.stderr || ''); }
  assert.equal(code, 1);
  assert.match(stderr, /INVALID_TTL_SEC/);
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined, 'a rejected --ttl-sec must not persist a pending nonce');
});

// Same host-dependence as the happy-path test above: this test's confirm-desktop call also hits the
// process.platform-read PLATFORM_UNSUPPORTED guard on a non-macOS/Windows CI runner (Finding 2, round-5
// review) AND the real desktopProbe (round-7 review Finding 2) — gated on `desktopProbeVerified` too.
test('CLI spawn-style offer-desktop --ttl-sec 120 succeeds and the persisted expiry reflects 120s (not the 600s default)', { skip: !desktopProbeVerified }, () => {
  const { root, runId, expect } = seedFreshRun();
  withCurrentPointer(root, runId);
  const out = execFileSync('node', [CLI, 'spawn-style', 'offer-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--nonce', 'n1', '--ttl-sec', '120', '--now', String(T0), '--project-root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).ok, true);
  const pending = readState(root, runId).data.autonomy.spawn_style_optin_pending;
  assert.equal(pending.nonce, 'n1');
  assert.equal(Date.parse(pending.expires_at), T0 + 120 * 1000, 'expiry must reflect the --ttl-sec 120 override, not the 600s default');
  // a confirm within the 120s window still succeeds (end-to-end proof the threaded ttlSec is usable).
  const outConfirm = execFileSync('node', [CLI, 'spawn-style', 'confirm-desktop', '--owner', expect.owner, '--generation', String(expect.generation), '--nonce', 'n1', '--now', String(T0 + 60000), '--project-root', root], { encoding: 'utf8' });
  assert.equal(JSON.parse(outConfirm).ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
});

// ── generic `state patch` must NOT be usable for spawn_style (dedicated fenced path only) ──

test('state patch autonomy.spawn_style is FIELD_FORBIDDEN (classifyPatch does not whitelist it)', async () => {
  const { classifyPatch } = await import('../scripts/lib/state.mjs');
  assert.equal(classifyPatch('autonomy.spawn_style', 'desktop'), 'forbid');
});
