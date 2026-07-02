import { randomUUID } from 'node:crypto';
import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';

// Task 7 — durable, nonce-bound desktop opt-in (offer/confirm/decline). Each function is a single
// appendAnchored transaction: fence check FIRST (LEASE_FENCED never swallowed — fail loud), then
// domain validation, all evaluated in-lock against a fresh read of state — so a stale pre-read can
// never race a concurrent transition (spec Plan R1 🟡P1-3 / R3 🟡P3-3 / R4 🔴P4-1).
//
// Threat-model note (Plan R3 P3-2): the kernel cannot cryptographically distinguish a human calling
// `confirm-desktop` from an agent that just received the nonce — the same cooperative-but-fallible
// boundary as `breaker reset --confirm` / `episode abandon --confirm` (spec §1.2). The nonce adds
// init-bound, single-use, TTL'd, in-lock source-state gating on top — a bug-guard against accidental
// mis-transition, not a security boundary against a malicious execution plane (v1 non-goal, spec §9).

function assertFenceShape(expect, who) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isInteger(expect.generation)) {
    throw new Error(`FENCE_REQUIRED: ${who}`);
  }
}

// offerDesktop({ expect, now, ttlSec=600, nonce }) → { ok, nonce } | { ok:false, reason:'INVALID_TTL_SEC' }
// Sets loop.autonomy.spawn_style_optin_pending = { nonce, expires_at }. Unconditional on the current
// spawn_style (offering is harmless; confirmDesktop is where the source-state gate lives) — fenced only.
//
// The expiry Date must be computed AND validated BEFORE entering appendAnchored (never inside mutate):
// appendAnchored appends the event first and only updates loop.json's event_log_head + writes state
// afterward (see integrity.mjs appendAnchored) — a throw from Date math inside mutate (a digits-but
// -out-of-range --ttl-sec/--now overflowing Date's ~±8.64e15ms range passes the CLI's `/^\d+$/` integer
// check yet yields `RangeError: Invalid time value`) would leave the just-appended event ahead of the
// persisted anchor → LOG_TAMPERED on every subsequent op. Fail closed BEFORE any append instead.
export function offerDesktop(root, runId, { expect, now = Date.now(), ttlSec = 600, nonce } = {}) {
  assertFenceShape(expect, 'offerDesktop');
  const expiresAtMs = now + ttlSec * 1000;
  if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: 'INVALID_TTL_SEC' };
  let expiresAt;
  try { expiresAt = new Date(expiresAtMs).toISOString(); }
  catch { return { ok: false, reason: 'INVALID_TTL_SEC' }; }
  const issued = nonce ?? randomUUID();
  appendAnchored(root, runId, { type: 'spawn-style-desktop-offered', data: { nonce: issued } },
    (l) => {
      // ONLY assigns the pre-computed, already-validated expiresAt string — no Date math here.
      l.autonomy.spawn_style_optin_pending = { nonce: issued, expires_at: expiresAt };
    },
    (l) => {
      const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation });
      if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);
    });
  return { ok: true, nonce: issued };
}

// confirmDesktop({ expect, now, nonce, platform=process.platform }) → { ok:true } | { ok:false, reason }
// ALL validation happens inside the appendAnchored preCheck (in-lock), in order:
//   ① fence (leaseCheck result)              → LEASE_FENCED (rethrown, never swallowed)
//   ② platform ∈ {darwin,win32}              → else PLATFORM_UNSUPPORTED (cheap kernel-side guard —
//      Claude Desktop only ships for macOS/Windows; a buggy skill must not be able to durably set
//      spawn_style='desktop' on Linux even with a valid nonce + source state)
//   ③ pending nonce exists & matches          → else NONCE_INVALID
//   ④ not expired                             → else NONCE_EXPIRED
//   ⑤ current spawn_style ∈ {visible,interactive} (re-read in-lock, TOCTOU-safe) → else SOURCE_INVALID
// A throwing preCheck aborts appendAnchored with NO mutation and NO event appended.
// `platform` is injected (defaults to process.platform) purely for testability — never used for
// anything but this in-lock allowlist check.
export function confirmDesktop(root, runId, { expect, now = Date.now(), nonce, platform = process.platform } = {}) {
  assertFenceShape(expect, 'confirmDesktop');
  try {
    appendAnchored(root, runId, { type: 'spawn-style-desktop-confirmed', data: { nonce } },
      (l) => {
        l.autonomy.spawn_style = 'desktop';
        delete l.autonomy.spawn_style_optin_pending;
      },
      (l) => {
        const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation });
        if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);                                                        // ① fence
        if (platform !== 'darwin' && platform !== 'win32') throw new Error('PLATFORM_UNSUPPORTED: confirmDesktop');       // ② platform guard
        const p = l.autonomy?.spawn_style_optin_pending;
        if (!p || p.nonce !== nonce) throw new Error('NONCE_INVALID: confirmDesktop');                                    // ③ nonce
        if (Date.parse(p.expires_at) <= now) throw new Error('NONCE_EXPIRED: confirmDesktop');                            // ④ expiry
        const cur = l.autonomy?.spawn_style;
        if (cur !== 'visible' && cur !== 'interactive') throw new Error('SOURCE_INVALID: confirmDesktop');               // ⑤ source-state (in-lock)
      });
  } catch (e) {
    const msg = String(e?.message || e);
    // Only the 4 known domain-validation reasons are translated to a rejection return.
    // LEASE_FENCED and any unknown error (integrity/lock/IO/schema) are rethrown fail-loud — never swallowed.
    if (/^(NONCE_INVALID|NONCE_EXPIRED|SOURCE_INVALID|PLATFORM_UNSUPPORTED):/.test(msg)) return { ok: false, reason: msg.split(':')[0] };
    throw e;
  }
  return { ok: true };
}

// declineDesktop({ expect, now }) → { ok:true }
// Fenced clear of any pending opt-in. Idempotent — a no-op (still appends the event) if nothing is pending.
export function declineDesktop(root, runId, { expect, now = Date.now() } = {}) {
  assertFenceShape(expect, 'declineDesktop');
  appendAnchored(root, runId, { type: 'spawn-style-desktop-declined', data: {} },
    (l) => {
      delete l.autonomy.spawn_style_optin_pending;
    },
    (l) => {
      const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation });
      if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);
    });
  return { ok: true };
}
