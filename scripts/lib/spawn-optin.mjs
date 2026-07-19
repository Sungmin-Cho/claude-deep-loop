import { randomUUID } from 'node:crypto';
import { appendAnchored, directMutationOptions,
  intentField } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { defaultDesktopProbe } from './desktop-target.mjs';

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
  const recovered = appendAnchored(root, runId, { type: 'spawn-style-desktop-offered', data: { nonce: issued } },
    (l) => {
      // ONLY assigns the pre-computed, already-validated expiresAt string — no Date math here.
      l.autonomy.spawn_style_optin_pending = { nonce: issued, expires_at: expiresAt };
    },
    (l) => {
      const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation });
      if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);
    }, directMutationOptions('desktop-offer', expect,
      { now, ttlSec, nonce: issued, expiresAt }, 'LEASE_FENCED: offerDesktop', {
        onRecovered: loop => {
          const pending = loop.autonomy?.spawn_style_optin_pending;
          if (pending?.nonce !== issued || pending.expires_at !== expiresAt) {
            throw new Error('DESKTOP_OFFER_RESPONSE_PROJECTION_CHANGED');
          }
          return { ok: true, nonce: issued };
        },
      }));
  if (recovered !== undefined) return recovered;
  return { ok: true, nonce: issued };
}

// confirmDesktop({ expect, now, nonce, platform=process.platform, desktopProbe=defaultDesktopProbe })
//   → { ok:true } | { ok:false, reason }
// Round-6 review fix (both codex reviewers, 2/2): a durable `desktop` opt-in must NEVER be persistable
// unless the handler that will actually be invoked on every future handoff verifies RIGHT NOW — otherwise
// a placeholder verifier (e.g. ALLOW_WIN_PUBLISHERS, still a TBD Subject string pending real-Windows
// confirmation — see desktop-target.mjs) can durably set spawn_style='desktop', after which every
// respawn resolves desktop, the handler fails verification, and preserve-pause repeats forever with no
// downgrade (generic `state patch` forbids autonomy.spawn_style — see classifyPatch).
//
// The probe is a READ-ONLY host call (no lock needed for it) — it is invoked ONCE, BEFORE
// appendAnchored/the lock is taken (same pre-appendAnchored-validation shape as offerDesktop's ttlSec
// check above), and its already-computed result is captured and re-checked INSIDE the in-lock preCheck
// as the final guard — so a failing probe still means NO mutation and NO event appended (no half-commit),
// consistent with every other rejection path here.
//
// ALL validation happens inside the appendAnchored preCheck (in-lock), in order:
//   ① fence (leaseCheck result)              → LEASE_FENCED (rethrown, never swallowed)
//   ② platform ∈ {darwin,win32}              → else PLATFORM_UNSUPPORTED (cheap kernel-side guard —
//      Claude Desktop only ships for macOS/Windows; a buggy skill must not be able to durably set
//      spawn_style='desktop' on Linux even with a valid nonce + source state)
//   ③ pending nonce exists & matches          → else NONCE_INVALID
//   ④ not expired                             → else NONCE_EXPIRED
//   ⑤ current spawn_style ∈ {visible,interactive} (re-read in-lock, TOCTOU-safe) → else SOURCE_INVALID
//   ⑥ desktopProbe({ platform }) returned { ok:true, ... } (pre-computed above) → else HANDLER_UNVERIFIED
// A throwing preCheck aborts appendAnchored with NO mutation and NO event appended.
// `platform` and `desktopProbe` are injected (default to process.platform / defaultDesktopProbe) purely
// for testability — production callers never pass them, so real runtime behavior always probes the real
// handler on this host.
export function confirmDesktop(root, runId, { expect, now = Date.now(), nonce, platform = process.platform, desktopProbe = defaultDesktopProbe } = {}) {
  assertFenceShape(expect, 'confirmDesktop');
  let probeResult;
  try { probeResult = desktopProbe({ platform }); } catch { probeResult = { ok: false, reason: 'probe-error' }; }
  try {
    const recovered = appendAnchored(root, runId, { type: 'spawn-style-desktop-confirmed', data: { nonce } },
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
        if (!probeResult || probeResult.ok !== true) throw new Error('HANDLER_UNVERIFIED: confirmDesktop');              // ⑥ live handler probe (pre-computed, read-only)
      }, directMutationOptions('desktop-confirm', expect, { now, nonce, platform,
        probe_digest: intentField('desktop-confirm-probe', probeResult) },
      'LEASE_FENCED: confirmDesktop', { onRecovered: loop => {
        if (loop.autonomy?.spawn_style !== 'desktop'
            || loop.autonomy?.spawn_style_optin_pending !== undefined) {
          throw new Error('DESKTOP_CONFIRM_RESPONSE_PROJECTION_CHANGED');
        }
        return { ok: true };
      } }));
    if (recovered !== undefined) return recovered;
  } catch (e) {
    const msg = String(e?.message || e);
    // Only the 5 known domain-validation reasons are translated to a rejection return.
    // LEASE_FENCED and any unknown error (integrity/lock/IO/schema) are rethrown fail-loud — never swallowed.
    if (/^(NONCE_INVALID|NONCE_EXPIRED|SOURCE_INVALID|PLATFORM_UNSUPPORTED|HANDLER_UNVERIFIED):/.test(msg)) return { ok: false, reason: msg.split(':')[0] };
    throw e;
  }
  return { ok: true };
}

// declineDesktop({ expect, now }) → { ok:true }
// Fenced clear of any pending opt-in. Idempotent — a no-op (still appends the event) if nothing is pending.
// Scoped to the PENDING-offer cancel path only (does not touch an already-confirmed spawn_style) — for
// downgrading an already-durable 'desktop' opt-in, see resetDesktop below.
export function declineDesktop(root, runId, { expect, now = Date.now() } = {}) {
  assertFenceShape(expect, 'declineDesktop');
  const recovered = appendAnchored(root, runId, { type: 'spawn-style-desktop-declined', data: {} },
    (l) => {
      delete l.autonomy.spawn_style_optin_pending;
    },
    (l) => {
      const lc = leaseCheck(l, { owner: expect.owner, generation: expect.generation });
      if (!lc.ok) throw new Error('LEASE_FENCED: ' + lc.reason);
    }, directMutationOptions('desktop-decline', expect, { now },
      'LEASE_FENCED: declineDesktop', { onRecovered: loop => {
        if (loop.autonomy?.spawn_style_optin_pending !== undefined) {
          throw new Error('DESKTOP_DECLINE_RESPONSE_PROJECTION_CHANGED');
        }
        return { ok: true };
      } }));
  if (recovered !== undefined) return recovered;
  return { ok: true };
}

// resetDesktop({ expect, now }) → { ok:true } | { ok:false, reason:'SOURCE_INVALID' }
// Round-6 review fix, part (c) — fenced HUMAN RECOVERY downgrade: desktop → visible. Because confirmDesktop
// now gates on a LIVE probe (guarantee (a) above), a handler that verified at confirm-time can still later
// stop verifying (app uninstalled/moved, code signature changed, etc.) — with generic `state patch`
// forbidding autonomy.spawn_style (see classifyPatch's default-deny), there was previously NO way back to
// 'visible' once durable. resetDesktop closes that gap: a single fenced appendAnchored transaction that
// transitions spawn_style back to 'visible' AND clears any stray pending nonce (defensive — normally none
// exists once spawn_style==='desktop', since confirmDesktop already clears it on success).
// Gated on cur==='desktop' (else SOURCE_INVALID, no mutation) — same in-lock TOCTOU-safe re-read pattern
// as confirmDesktop's ⑤ — so this cannot be misused to silently downgrade a headless/interactive run.
//
// Round-7 review fix, Finding 1: resetDesktop is the escape hatch for the EXACT stuck state a
// desktop-unavailable respawn leaves behind — respawn.mjs's preservePause sets status='paused' AND keeps
// lease.state='releasing' (handoff still 'emitted', child never acquired; see round-6 preserve-pause).
// The shared leaseCheck() (lease.mjs) has NO single intent that clears BOTH its RUN_PAUSED gate and its
// lease-releasing-carveout gate at once: 'recover'/'resume'/'breaker-reset' clear RUN_PAUSED but NOT the
// releasing-carveout, while 'lease'/'accounting' clear the releasing-carveout but NOT RUN_PAUSED. Routing
// through leaseCheck() here would leave the escape hatch fenced-out in precisely the state it exists to
// repair. Instead this uses recoverRun's (recover.mjs) bespoke in-lock fence PATTERN — an owner+generation
// check that deliberately skips leaseCheck's RUN_PAUSED gate and releasing-carveout — the SAME established
// "human recovery operation" pattern, not a new one.
//
// Round-10 review fix (codex review P2 + adversarial [medium]): recoverRun's owner+generation check is only
// SAFE because it ALSO gates on status==='paused' (recover.mjs:12 outside-lock + :24 in-lock) — a released
// lease on a paused recovering run is legitimate, and terminal runs are excluded by that same paused gate.
// This function had dropped BOTH protections while claiming to mirror recoverRun "exactly", so a stale
// former owner whose generation was still recorded could mutate spawn_style AFTER `lease release`
// (state==='released') or after the run settled (completed/stopped) — violating invariant #2 (lease-fence)
// and #4 (terminal states settled). The two guards below restore recoverRun's protections without
// requiring paused-only: reject 'released' (leaseCheck lease.mjs:17 parity — the escape hatch needs
// 'releasing', NOT 'released', so this does not fence out the state resetDesktop exists to repair) and
// reject terminal runs (pauseRun terminal guard state.mjs:176 parity). Healthy 'running'+'active' downgrade
// and the 'paused'+'releasing' escape hatch both remain allowed.
// Deliberately does NOT touch `status` or `lease.state`/`resume_policy`: downgrading spawn_style is the full
// scope of this op; unpausing (if the pause was desktop-caused) is left to the existing `recover` path /
// a fresh acquireLease, so a human can still audit before resuming.
export function resetDesktop(root, runId, { expect, now = Date.now() } = {}) {
  assertFenceShape(expect, 'resetDesktop');
  try {
    const recovered = appendAnchored(root, runId, { type: 'spawn-style-desktop-reset', data: {} },
      (l) => {
        l.autonomy.spawn_style = 'visible';
        delete l.autonomy.spawn_style_optin_pending;
      },
      (l) => {
        const lease = l.session_chain?.lease;
        if (!lease) throw new Error('LEASE_FENCED: no-lease');
        if (lease.owner_run_id !== expect.owner) throw new Error('LEASE_FENCED: owner-mismatch');
        if (lease.generation !== expect.generation) throw new Error('LEASE_FENCED: generation-mismatch');
        if (lease.state === 'released') throw new Error('LEASE_FENCED: lease-released');
        if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: resetDesktop');
        // Round-11 review fix (codex adversarial [high]): lease.state==='releasing' has TWO shapes and only
        // one is a legitimate reset target. emitHandoff (handoff.mjs:301) refuses to emit on a paused run, so
        // a HEALTHY in-flight handoff is status='running' + releasing + handoff_phase='emitted'|'spawned'
        // (child reserved, about to acquire) — NOT stuck. The escape hatch this op exists to repair is the
        // preservePause shape: status='paused' + releasing (child never acquired). Allowing reset on the
        // running+releasing window would flip spawn_style mid-handoff and could strand the emitted handoff
        // unpaused with no child. Gate on status: releasing is resettable ONLY when paused (the stuck state);
        // reject running+releasing. The healthy non-handoff downgrade (running + lease.state='active') is
        // unaffected — it never enters this branch.
        if (lease.state === 'releasing' && l.status !== 'paused') throw new Error('HANDOFF_IN_FLIGHT: resetDesktop');
        const cur = l.autonomy?.spawn_style;
        if (cur !== 'desktop') throw new Error('SOURCE_INVALID: resetDesktop');
      }, directMutationOptions('desktop-reset', expect, { now },
      'LEASE_FENCED: resetDesktop', { onRecovered: loop => {
        if (loop.autonomy?.spawn_style !== 'visible'
            || loop.autonomy?.spawn_style_optin_pending !== undefined) {
          throw new Error('DESKTOP_RESET_RESPONSE_PROJECTION_CHANGED');
        }
        return { ok: true };
      } }));
    if (recovered !== undefined) return recovered;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/^SOURCE_INVALID:/.test(msg)) return { ok: false, reason: 'SOURCE_INVALID' };
    if (/^RUN_TERMINAL:/.test(msg)) return { ok: false, reason: 'RUN_TERMINAL' };   // terminal run — settled; exit 1 (LEASE_FENCED still propagates → exit 3)
    if (/^HANDOFF_IN_FLIGHT:/.test(msg)) return { ok: false, reason: 'HANDOFF_IN_FLIGHT' };   // healthy in-flight handoff (running+releasing); exit 1
    throw e;
  }
  return { ok: true };
}
