# Changelog

All notable changes to deep-loop are documented in this file.

## [1.0.0] — 2026-07-01

### Finish-Path Robustness (kernel termination state machine)
- **Premature finish fixed** — `next-action` no longer recommends `finish` (and `finishProofState`/`finishRun` no longer accept `completed`) unless every declared `review.point` is satisfied by a **bound APPROVED** checker, every done maker is bound to an **existing workstream**, and the **latest** maker per `(workstream,point)` is the bound-approved one. `next-action` now reuses the canonical `finishProofState` gate (recommend ≡ enforce) via the shared `unsatisfiedReviewPoints` helper.
- **Stranded maker recovery** — new human-gated terminal `abandoned` + `episode abandon --id --reason --confirm` (lease-fenced); an orphan/proof-impossible maker (empty `expected_artifacts`, or in-progress) is surfaced to `await_human(orphan-maker-no-artifacts)` with the abandon recovery command; abandoned counts as settled in both termination paths, is excluded from comprehension counters, and is un-ackable.
- **Terminal immutability** — no resurrection of `done/approved/rejected/abandoned` via `episode record`, `review record` (terminal checker), or `state patch` (value→abandoned, terminal→non-terminal, and phantom/out-of-range/non-canonical/leading-zero index guards); `abandoned` is written **only** by `abandonEpisode`.
- **Review-convergence correctness** — order-aware episode comparator (`epOrder`, numeric with string fallback; correct past the 999→1000 id boundary); a single `rejectionResolved` predicate shared by `next-action` routing and `finishProofState.settledEp` (a rejected checker resolves only via a **newer** bound approval or a later done maker); `finishProofState` convergence uses `boundLatestApproved`.
- **Unbound checkers prevented at source** — `dispatchReview` throws `REVIEW_NO_ELIGIBLE_MAKER` when there is no done maker (no unbound checker is ever created); `recordReviewOutcome` rejects a verdict on an unbound checker; any legacy unbound rejected checker is treated as neutral (cannot block or strand).
- Schema `episode_status.kernel += abandoned`; handoff summary surfaces abandoned episodes; docs (`CLAUDE.md`/`README`/`README.ko`/finish skill) synced; 2-plane fence matcher covers `episode abandon`.
- Reviewed to convergence via a codex-only 2-way adversarial loop (spec 7 rounds, plan 4 rounds, implementation 6 rounds).

### Self-Spawning Session Continuity
- OS/terminal-agnostic automatic **visible** new-session handoff — the next session opens in a fresh visible window, keeping the human in the verification loop, not the cycle
- `detect-terminal.mjs` — fail-closed launcher detection (`cmux`, `iterm2`, `terminal-app`, Windows Terminal `wt`, `powershell`, else `none`); `detectAndPersist` records `session_spawn` at run-init
- `visibleSpawn` (spawn-driver) via `respawn` — gate → `emitted→spawned` CAS → bounded child-readiness in one anchored transaction; `buildLaunchCommand` emits per-launcher argv (cmux `--command` POSIX-tokenized, not q-wrapped, so the new session runs `claude`)
- `pauseRun` (preserve/rollback) + `recoverRun` (`recover --confirm`) human escape hatch; `acquireLease` auto-unpauses a preserved run on child takeover; `RUN_PAUSED` gate on all business mutators
- needs-human fallback when no launcher — `respawn` returns `{ok:false, outcome:'no-launcher'}`, never silently headless; visible spawn is attended-only, unattended forces the fail-closed headless path

## [0.1.0] — 2026-06-25 (v1)

Initial release of deep-loop v1, implemented across three plans.

### Plan 1 — Deterministic Kernel
- Content-hash-anchored state machine (`loop.json` + `.loop.hash`)
- Append-only event log with chain + head anchors; tamper-detect fail-stop
- Generation-fenced lease protocol (acquire/reserve/emit/spawn/release/rollback)
- Budget engine: turn/token/wallclock hard caps, `budget.on_unmeasurable_usage: "fail-closed"`
- Circuit breaker with human-only reset latch
- Comprehension debt tracking with idempotent `ack`
- Episode lifecycle (new → done/approved/rejected) with proof-artifact derivation
- Workstream management with dependency ordering and terminal-locked rewrites
- `initRun`, `readState`, `writeState`, `withLock` — all non-reentrant

### Plan 2 — Orchestration Machine
- `next-action` — pure gate evaluator (budget → breaker → sessions → wallclock → auto_handoff → action dispatch)
- `emitHandoff` — atomic child session push + lease reserved→emitted in one `appendAnchored` transaction
- `respawn` — spawn-or-rollback in one transaction; injected `spawnFn` for testability
- `respawnGate` — pure predicate; precompact hook calls respawn without pre-checking gate externally
- `review.mjs` — dispatch/record/settle for checker episodes
- `adapters.mjs` — 4-verb protocol descriptors (dispatch/await/read/checker_via) + tier guard
- Skill-facing CLI: `adapter resolve`, `state get/patch`, `budget record/check`, `comprehension ack/status`, `breaker reset`, `finish`, `episode new/record`, `workstream new/activate/record`, `review dispatch/record`
- All mutating CLI fenced with `--owner/--generation`; fence checked inside the lock (not outside)

### Plan 3 — Execution Plane + Automation + Docs
- 9 user-invocable skills: `/deep-loop`, `/deep-loop-discover`, `/deep-loop-triage`, `/deep-loop-continue`, `/deep-loop-handoff`, `/deep-loop-resume`, `/deep-loop-status`, `/deep-loop-ack`, `/deep-loop-finish` — plus 1 internal skill `deep-loop-workflow` (`user-invocable: false`)
- `spawn-driver.mjs` — `headlessSpawn` with timeout + `parseUsage`; fail-closed when usage unmeasurable (cost-only JSON rejected)
- `precompact-handoff.mjs` — PreCompact hook impl: emit + conditional headless respawn (best-effort, never blocks compaction)
- `hooks/hooks.json` + `hooks/scripts/precompact-handoff.sh` — Bash 3.2 compatible hook wiring
- `drive-headless.mjs` — unattended automation driver: fence-before-spawn, accounting carve-out for releasing lease
- `leaseCheck` accounting carve-out: `intent='accounting'` allowed during `releasing` (matching owner/generation only)
- `finish.mjs` — proof-gated run completion: all episodes settled + workstreams terminal + final-report
- Automation templates: `recipes/automation/cron-morning-triage.yml`, `recipes/automation/github-actions-loop.yml`
- User documentation: `README.md` (en), `README.ko.md` (ko), `CHANGELOG.md`
- `integration/deep-suite.patch.md` — marketplace registration patch plan (push-gated)

### Safety Invariants (all three plans)
- **proposal-only** — no auto-push, auto-merge, auto-publish, auto-delete in v1
- **2-plane separation** — skills read via CLI, write via kernel CLI only; no direct `loop.json` writes from skills
- **single-anchor transactions** — every event + state mutation in one `appendAnchored` call
- **fence-in-lock** — generation fence checked inside the same lock as the state change
- **fail-closed unmeasurable** — headless driver rejects sessions with no measurable turns/tokens
- **terminal via proof** — episode/workstream terminal states derived from verified artifacts only
