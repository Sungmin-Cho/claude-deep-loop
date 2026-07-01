// Task 7: opt-in nonce — offer/confirm/decline (fenced, appendAnchored) — TDD RED→GREEN
// Hand-built seeds (no initRun) per task hygiene — matches pause.test.mjs / recover.test.mjs convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readState, writeState, runDir } from '../scripts/lib/state.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import { offerDesktop, confirmDesktop, declineDesktop } from '../scripts/lib/spawn-optin.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
const OWNER = 'SPAWNOPTIN01';
const GEN = 1;
const T0 = Date.parse('2026-07-01T00:00:00.000Z');

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
  if (spawn_style) data.autonomy.spawn_style = spawn_style;
  writeState(root, runId, data);
  return { root, runId, expect: { owner: OWNER, generation: GEN } };
}

// test seam: simulate a concurrent, legitimate kernel-transition changing spawn_style out-of-band
// (a real appendAnchored transaction, distinct from the opt-in path under test).
function forceSpawnStyle(root, runId, style) {
  appendAnchored(root, runId, { type: 'test-force-spawn-style', data: { style } }, (l) => { l.autonomy.spawn_style = style; });
}

function withCurrentPointer(root, runId) {
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId);
}

// ── lib: offerDesktop / confirmDesktop / declineDesktop ──────────────────────

test('confirm without pending nonce is rejected', () => {
  const { root, runId, expect } = seedFreshRun();
  const r = confirmDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
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
  assert.equal(confirmDesktop(root, runId, { expect, now: T0 + 1000, nonce: 'n1' }).ok, true);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'desktop');
  assert.equal(readState(root, runId).data.autonomy.spawn_style_optin_pending, undefined, 'pending cleared on confirm');
  // reuse rejected — nonce is single-use
  const r2 = confirmDesktop(root, runId, { expect, now: T0 + 2000, nonce: 'n1' });
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
  assert.equal(confirmDesktop(root, runId, { expect, now: T0 + 2000, nonce: 'n1' }).ok, false);
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('expired nonce is rejected', () => {
  const { root, runId, expect } = seedFreshRun();
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1', ttlSec: 600 });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 600001, nonce: 'n1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NONCE_EXPIRED');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'visible');
});

test('confirm rejected when spawn_style not in {visible,interactive} (headless)', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'headless' });
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SOURCE_INVALID');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'headless');
});

test('confirm accepted when spawn_style=interactive', () => {
  const { root, runId, expect } = seedFreshRun({ spawn_style: 'interactive' });
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1' });
  assert.equal(r.ok, true);
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
  assert.throws(() => confirmDesktop(root, runId, { expect: { owner: 'wrong', generation: 1 }, now: T0, nonce: 'n1' }), /LEASE_FENCED/);
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
  assert.throws(() => confirmDesktop(root, runId, { now: T0, nonce: 'n1' }), /FENCE_REQUIRED/);
  assert.throws(() => offerDesktop(root, runId, { now: T0, nonce: 'n1' }), /FENCE_REQUIRED/);
  assert.throws(() => declineDesktop(root, runId, { now: T0 }), /FENCE_REQUIRED/);
});

test('confirm rechecks source state IN-LOCK (stale pre-read cannot overwrite a concurrent transition)', () => {
  const { root, runId, expect } = seedFreshRun();                 // visible
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  forceSpawnStyle(root, runId, 'headless');                       // concurrent legit transition (test seam)
  const r = confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SOURCE_INVALID');
  assert.equal(readState(root, runId).data.autonomy.spawn_style, 'headless');   // not overwritten to desktop
});

test('confirmDesktop appends exactly one event on success; rejections append none', () => {
  const { root, runId, expect } = seedFreshRun();
  confirmDesktop(root, runId, { expect, now: T0, nonce: 'n1' });                       // rejected: no pending
  const afterReject = readState(root, runId).data.event_log_head;
  assert.equal(afterReject.seq, 0, 'a rejected confirm must append NO event');
  offerDesktop(root, runId, { expect, now: T0, nonce: 'n1' });
  confirmDesktop(root, runId, { expect, now: T0 + 1, nonce: 'n1' });                   // accepted
  const afterAccept = readState(root, runId).data.event_log_head;
  assert.equal(afterAccept.seq, 2, 'offer + confirm each append exactly one event');
});

// ── CLI: spawn-style offer-desktop | confirm-desktop | decline-desktop ───────

test('CLI spawn-style offer-desktop → confirm-desktop happy path (exit 0, spawn_style=desktop)', () => {
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

test('CLI spawn-style offer-desktop --ttl-sec 120 succeeds and the persisted expiry reflects 120s (not the 600s default)', () => {
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
