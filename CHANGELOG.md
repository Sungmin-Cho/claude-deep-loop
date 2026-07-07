# Changelog

All notable changes to deep-loop are documented in this file.

> Note: the `[1.1.0]`/`[1.2.0]` entries pre-date this changelog file (a known lag between
> `plugin.json.version` and the changelog); this release does not retro-fill them.

## [1.4.0] — 2026-07-07

Autonomous hill-climbing feedback loop — the kernel mines its own run history into deterministic
insights, and those insights flow back into `/deep-loop-finish`'s proposal and `/deep-loop`'s init
step, closing the loop between *running* deep-loop and *improving* deep-loop.

### Added
- **`insights` kernel subcommand, 3 verbs** (`lib/insights.mjs`) — `insights [--run <id>] [--json]`
  computes deterministic per-run metrics and improvement candidates (read-only, no fence) via the
  spec's two-phase read: terminal-only runs get a verified aggregation pass, non-terminal runs are
  excluded, and the owning run also gets a `self_snapshot`. `insights emit --owner --generation`
  anchors a computed payload in three ordered steps — tmp atomic write → `appendAnchored`
  `insights-emitted` event → tmp→final atomic rename — lease-fenced per invariant #2. `insights
  latest [--json]` returns only a payload that passes envelope + schema-version + path-binding +
  sha256 verification against its anchored event, scanning ULID-descending and skipping (fail-soft)
  any file that doesn't verify; read-only, no fence. Skills never parse `.deep-loop/insights/*.json`
  directly — `insights latest` is the only trusted read path.
- **`harness-hill-climb` recipe** (`recipes/harness-hill-climb.json`) + `recipes/hillclimb-ledger.json`
  (empty-array seed) — a `flow: [insights, standalone:maker, deep-review:checker, ship-proposal,
  archive]` recipe triggered by "hill-climb" / "harness" / "하네스 개선" / "루프 개선" / "환류"; the
  `validate` subcommand now also validates the ledger's shape.
- **Finish/init feedback integration** — `/deep-loop-finish` emits insights and proposes the next
  hill-climb command from the returned candidates (proposal only, never auto-starts); `/deep-loop`
  init reads `insights latest` (§2-2.5) and surfaces any pending candidate at run start.
- **`references/hill-climbing.md`** — the maker/checker protocol reference for hill-climb runs: the
  Tier-1 (`recipes/*.json` + `recipes/automation/*.yml` only, autonomous-editable) vs Tier-2
  (everything else, human-proposal only) boundary, the (a)–(f) evidence contract, and the ledger's
  pure-append invariant (no diff/edit/delete/reorder of existing entries).
- **Gate-critical marker regression tests** (`tests/skills.test.mjs`) — deletion-only guards across
  the 7 gate-relevant `SKILL.md` files, pinning the presence of budget/breaker/comprehension/
  `--confirm`/fence tokens so a rewrite can't silently drop language a safety gate depends on.

### Fixed (review hardening beyond plan)
- **Honest `breaker.trips` semantics** — `insights.mjs` now reports `trips` as an end-of-run 0/1
  latch instead of a miscounted boolean-as-count, and drops the dead `run-paused` "consecutive"
  fallback branch the kernel never actually populates.
- **`loop_sha256` single verified read** — `computeInsights` derives the hash from the
  already-verified `readState` result instead of a second, TOCTOU-vulnerable re-read.
- **`latestInsights` chain verification** — path-binding now also runs `verifyLog`/`verifyHead`
  against the referenced run's event log before trusting it, closing a gap where a tampered but
  path-matching event could otherwise pass.

## [1.3.0] — 2026-07-07

Audit hardening of the four human-in-the-loop / resource gates. The canonical version is
`.claude-plugin/plugin.json` (the two other manifests are independent lines, out of scope).

### Security / Fixed
- **Human vs machine comprehension review (#1)** — `comprehension ack` is now recorded through the
  tamper-evident event-log (`appendAnchored`) and separates `actor=human` (releases the debt gate, requires
  `--confirm`, enforced in-lib) from `actor=agent` (accrues to a new `episodes_agent_reviewed` counter that
  `computeDebt` ignores). A checker APPROVE routes to the agent counter unconditionally — no config lets a
  machine review satisfy the human-oversight gate. A headless invocation asserting `actor=human` is fail-closed
  (a `comprehension-ack-rejected` event is appended, no counter bump).
- **Checker evidence for passing verdicts (#2)** — a passing `review record` (APPROVE/CONCERN) now requires a
  real review-report file contained (realpath, symlink-escape safe) under the project root, symmetric with the
  maker's done-needs-artifacts contract; the review-outcome event records the report path + sha256 hash. Inline
  findings are auxiliary only; REQUEST_CHANGES stays lightweight.
- **Kernel-boundary cost floor (#3)** — every business mutation is charged a minimum floor (1 turn) via a paired
  cost event in the same anchor, so under-reporting / omitting `budget record` can no longer neutralize the turns
  budget or per_session_turn_cap. `recordCost` absorbs the tick floor (max-rule, no double count). The previously
  non-anchored `setWorkstreamStatus` / `state patch` paths are now anchored (`workstream-status` / `state-patch`
  events) and floor-charged.
- **`finish --status stopped` gate (#4)** — `stopped` (which bypasses completed-proof) now requires `--confirm`,
  matching the sibling human-only ops (abandon / recover / breaker reset).
- **`.gitignore` (#6)** — widen from `.claude/worktrees/` to the whole `.claude/` so hook capture files are never
  exposed to `git add`.

### Changed
- `require_human_ack` default → `true` (honesty signal; the human/agent counter split is the real enforcement).
- CLI: `comprehension ack --actor/--confirm`, `review record --report/--findings`, `finish --status stopped --confirm`
  (fail-closed additions). Bundled skills synced in lockstep.

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
