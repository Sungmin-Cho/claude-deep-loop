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

// offerDesktop({ expect, now, ttlSec=600, nonce }) → { ok, nonce }
// Sets loop.autonomy.spawn_style_optin_pending = { nonce, expires_at }. Unconditional on the current
// spawn_style (offering is harmless; confirmDesktop is where the source-state gate lives) — fenced only.
export function offerDesktop(root, runId, { expect, now = Date.now(), ttlSec = 600, nonce } = {}) {
  assertFenceShape(expect, 'offerDesktop');
  const issued = nonce ?? randomUUID();
  appendAnchored(root, runId, { type: 'spawn-style-desktop-offered', data: { nonce: issued } },
    (l) => {
      l.autonomy.spawn_style_optin_pending = { nonce: issued, expires_at: new Date(now + ttlSec * 1000).toISOString() };
    },
    (l) => {
      const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation });
      if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);
    });
  return { ok: true, nonce: issued };
}

// confirmDesktop({ expect, now, nonce }) → { ok:true } | { ok:false, reason }
// ALL validation happens inside the appendAnchored preCheck (in-lock), in order:
//   ① fence (leaseCheck result)              → LEASE_FENCED (rethrown, never swallowed)
//   ② pending nonce exists & matches          → else NONCE_INVALID
//   ③ not expired                             → else NONCE_EXPIRED
//   ④ current spawn_style ∈ {visible,interactive} (re-read in-lock, TOCTOU-safe) → else SOURCE_INVALID
// A throwing preCheck aborts appendAnchored with NO mutation and NO event appended.
export function confirmDesktop(root, runId, { expect, now = Date.now(), nonce } = {}) {
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
        const p = l.autonomy?.spawn_style_optin_pending;
        if (!p || p.nonce !== nonce) throw new Error('NONCE_INVALID: confirmDesktop');                                    // ② nonce
        if (Date.parse(p.expires_at) <= now) throw new Error('NONCE_EXPIRED: confirmDesktop');                            // ③ expiry
        const cur = l.autonomy?.spawn_style;
        if (cur !== 'visible' && cur !== 'interactive') throw new Error('SOURCE_INVALID: confirmDesktop');               // ④ source-state (in-lock)
      });
  } catch (e) {
    const msg = String(e?.message || e);
    // Only the 3 known domain-validation reasons are translated to a rejection return.
    // LEASE_FENCED and any unknown error (integrity/lock/IO/schema) are rethrown fail-loud — never swallowed.
    if (/^(NONCE_INVALID|NONCE_EXPIRED|SOURCE_INVALID):/.test(msg)) return { ok: false, reason: msg.split(':')[0] };
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
