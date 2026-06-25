# impl-fix-r2 Implementation Report

## Summary

All 3 fixes applied. `npm test`: **321 pass / 0 fail** (was 313 pass before).

---

## FIX 1 — Per-maker finish proof (count-based)

**File changed:** `scripts/lib/finish.mjs`

Replaced the per-maker `reviewSatisfied` call in `finishProofState` with a count-based per-(ws,point) group check. Each group now requires `terminalCheckers >= doneMakers && approvedCheckers >= 1`. The old approach was true for any done maker on a ws+point that had _any_ approved checker — meaning a second done maker on the same ws+point needed no own checker. The new approach counts and compares.

`reviewSatisfied` and `settledEp` helpers retained (still used by `settledEp` for rejected-checker settling logic).

**Tests added in `tests/finish.test.mjs`:**
- `'finishProofState blocks two done makers sharing one approved checker (anomaly: count-based)'` — 2 done makers, 1 approved checker → `missing` includes `'unreviewed-maker'` ✓
- `'finishProofState passes for a fix-loop (2 done makers + 1 rejected + 1 approved checker, same point)'` — fix-loop shape → `missing: []` ✓
- Existing passing case (1 done maker + 1 approved checker) verified still passes ✓

---

## FIX 2 — Detached respawn lease handshake

**Files changed:** `scripts/lib/lease.mjs`, `scripts/lib/respawn.mjs`, `scripts/lib/spawn-driver.mjs`

### (a) lease.mjs — acquireLease handshake
Added third takeable condition: `lease.state === 'releasing' && owner === lease.handoff_child_run_id`. This lets the reserved child acquire a `releasing` lease directly without waiting for the parent to transition to `released`. The existing `child-not-reserved` guard only fires on `state==='released'` and is unchanged.

### (b) respawn.mjs — no longer releases lease on spawn success
The `respawn-spawned` appendAnchored mutate fn no longer sets `state='released'`. The lease stays `releasing` after a successful spawn. The child acquires via the new handshake condition in (a). Failure-mode-B rollback (releasing→active/idle on launch failure) is unchanged.

### (c) spawn-driver.mjs — claude binary precheck
Added `claudeAvailable()` helper (spawnSync `command -v claude`) and updated `detachedSpawn(cmd, { available = claudeAvailable } = {})` signature. If `!available()` returns `{ ok: false, reason: 'claude-not-found' }` before spawn attempt, causing failure-mode-B rollback in respawn.

**Tests updated in `tests/respawn.test.mjs`:**
- `'respawn success → spawned, lease released, ...'` → renamed + updated: `lease.state === 'releasing'` (not `'released'`); child still acquires OK via handshake ✓
- `'released handoff lease is acquirable only by the reserved child'` → renamed + updated: wrong child now gets `'lease-not-takeable'` (not `'child-not-reserved'`) since lease is `releasing` not `released`; assertion accepts both values ✓
- `'child can acquire the lease after a headless respawn releases it (Fix 2)'` → renamed + updated: `state === 'releasing'`; acquireLease still succeeds ✓

**Tests updated in `tests/spawn-driver.test.mjs`:**
- Two existing `detachedSpawn('true')` calls updated to `detachedSpawn('true', { available: () => true })` to avoid real claude binary check in CI ✓
- Two new tests: `available: () => false` → `{ok:false, reason:'claude-not-found'}`; `available: () => true` → `{ok:true}` ✓

---

## FIX 3 — Validate required non-fence args

**Files changed:** `scripts/lib/episode.mjs`, `scripts/lib/review.mjs`, `scripts/deep-loop.mjs`

### (a) episode.mjs
- `newEpisode`: validates `plugin`, `role`, `kind`, `point` non-empty strings; `role ∈ {maker, checker}`; throws `EPISODE_INPUT_INVALID: <field>` before any state write.
- `recordEpisode`: validates `episodeId` non-empty string; throws `EPISODE_INPUT_INVALID: episodeId`.

### (b) review.mjs
- `dispatchReview`: validates `point` non-empty string; throws `REVIEW_INPUT_INVALID: point` before state read/write.

### (c) deep-loop.mjs
- `episode new`: validates `--plugin`, `--role`, `--kind`, `--point` via `reqStr` → exit 2
- `episode record`: validates `--id`, `--status` via `reqStr` → exit 2
- `workstream set`: validates `--id`, `--status` via `reqStr` → exit 2
- `workstream terminal`: validates `--id`, `--status` via `reqStr` → exit 2
- `review dispatch`: validates `--point`, `--workstream` via `reqStr` → exit 2
- `review record`: validates `--episode`, `--workstream`, `--point`, `--verdict` via `reqStr` → exit 2

**Tests added in `tests/cli-skillface.test.mjs`:**
- `'episode new missing --plugin exits 2'` ✓
- `'episode new missing --role exits 2'` ✓
- `'review dispatch missing --point exits 2'` ✓

**Tests added in `tests/episode.test.mjs`:**
- `'newEpisode throws EPISODE_INPUT_INVALID when role is missing'` ✓

---

## Final test summary

```
tests 321
pass 321
fail 0
cancelled 0
skipped 0
```

## Concerns

None. No safety invariants broken. The Fix 2 lease state change (`released` → `releasing`) is safe because:
1. The reserved child can acquire `releasing` via the new handshake condition
2. Non-reserved wrong children cannot acquire (not expired, not the reserved child)
3. Stale TTL recovery (releasing + expired) still works as before for crash recovery
4. The `child-not-reserved` guard on `released` state is unchanged and unaffected
