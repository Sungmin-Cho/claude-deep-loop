# deep-loop — Agent Guide

Loop Engineering control plane over the deep-suite. A 2-plane Claude Code / Codex
plugin that discovers work, routes it to sibling `deep-*` plugins as maker/checker
episodes, keeps durable lock-safe loop state, and hands off to fresh sessions
autonomously — keeping the human in the verification loop, never in the cycle
between steps.

Both hosts read this file; it is the single source and carries no `@`-import of its
own, because Codex does not support them. It guides agents working **on** this
codebase. User-facing usage and the tracked compatibility/recovery contract live in
[`README.md`](README.md#compatibility-and-recovery-contract) / `README.ko.md`. The
repo, `git log` and those docs are the source of truth — do not assume prior
conversation context.

Read the current version, never hardcode it:
```bash
node -p "JSON.parse(require('node:fs').readFileSync('DEEP_LOOP_ROOT/.claude-plugin/plugin.json','utf8')).version"
```

Anchored, and a file read rather than a module load: unanchored it reports the
*analysed* project's version, and a plugin path inside a JS module specifier has no
safe spelling — nothing substitutes a documentation placeholder inside JS.
Node ≥ 20, `type: module`, **zero external dependencies**.

## Architecture — 2-plane, strict

```
EXECUTION PLANE (LLM)   skills/*/SKILL.md
        │  judgment: discover · triage · decompose · decide · dispatch
        │  reads state (state get / next-action / validate) — mutates ONLY via the kernel CLI
        ▼
CONTROL PLANE (Node, deterministic)   DEEP_LOOP_ROOT/scripts/deep-loop.mjs
                                      DEEP_LOOP_ROOT/scripts/lib/*.mjs
        │  state(lock) · budget · breaker · comprehension · schema · lease
        │  handoff · respawn · review · finish
        ▼  atomic temp+rename, M3 envelope
   .deep-loop/runs/<run-id>/  loop.json · event-log.jsonl · episodes/ · handoffs/ · final-report.md
```

The kernel **never calls sibling skills as functions**. It returns descriptors
(`next-action`, `adapter resolve`, `review dispatch`) and the Execution-plane LLM
performs the dispatch — `Skill()`, or a runtime-selected measured headless
subprocess: **Claude** uses bounded `claude -p` JSON, approved **Codex** uses
shell-free `codex exec --json` with incremental JSONL. There is no cross-runtime
fallback.

New runs use `workstream-session` with interactive same-conversation affinity until
the bound Workstream's first terminal event. Attended launch requires explicit
durable authorization; unattended invocations use the measured headless path and
never respawn mid-Workstream. `compact-in-place` and `rotate-per-unit` remain
migrated compatibility policies only.

## Repo map

- `DEEP_LOOP_ROOT/scripts/deep-loop.mjs` — CLI dispatcher and the **only** state-change boundary:
  validation, run lifecycle, fenced recovery, executable approval, review, accounting.
- `DEEP_LOOP_ROOT/scripts/lib/*.mjs` — deterministic kernel, portable path/write helpers, runtime
  descriptors, executable trust, isolated Codex transport, review import, durable
  receipts. `DEEP_LOOP_ROOT/scripts/lib/checkpoint.mjs` owns compact-checkpoint emission, retention
  and freshness selection.
- Hook and headless glue, spelled out rather than brace-expanded so each path stays
  greppable — `DEEP_LOOP_ROOT/tests/docs.test.mjs` checks these by literal, which is how a stale
  `.sh` wrapper reference was caught once:
  - `DEEP_LOOP_ROOT/scripts/hooks-impl/precompact-handoff.mjs` — PreCompact, emit-only.
  - `DEEP_LOOP_ROOT/scripts/hooks-impl/postcompact-observe.mjs` — PostCompact, bounded CLI-observe-only.
  - `DEEP_LOOP_ROOT/scripts/hooks-impl/sessionstart-restore.mjs` — SessionStart (`compact` source), read-only.
  - `DEEP_LOOP_ROOT/scripts/hooks-impl/drive-headless.mjs` — measured headless driver.
  - `DEEP_LOOP_ROOT/hooks/hooks.json` holds their static shell-free Node bootstraps.
- `skills/deep-loop*/SKILL.md` + `skills/deep-loop-workflow/references/*.md` — Execution plane.
- `protocols/*.json` · `recipes/*.json` (+ `recipes/automation/*.yml`) · `schemas/*.json` —
  declarative adapters, policies, durable/input schemas.
- Manifests: `DEEP_LOOP_ROOT/.claude-plugin/plugin.json` · `DEEP_LOOP_ROOT/.codex-plugin/plugin.json`.
- `DEEP_LOOP_ROOT/tests/*.test.mjs` (`node --test`) · `DEEP_LOOP_ROOT/integration/deep-suite.patch.md`.
- Durable state is runtime and git-ignored: `<project-root>/.deep-loop/runs/<run-id>/`.

## Hard invariants — DO NOT break

Enforced by code and by review. Each is load-bearing; none is a summary of another.

1. **2-plane boundary.** Skills only **read** state; every mutation goes through a
   kernel CLI subcommand. A `SKILL.md` must never instruct a direct write to
   `loop.json` / `event-log.jsonl` / `.loop.hash` — writing
   `.deep-loop/runs/<id>/final-report.md` is allowed. `DEEP_LOOP_ROOT/tests/skills.test.mjs`
   enforces this.
2. **Every mutating CLI is lease-fenced** (`--owner <run_id> --generation <n>`) and
   the fence is checked **inside the same lock/`preCheck` that mutates state**, not
   only as an outside precondition. Exit codes: **3 = fence only**
   (`LEASE_FENCED`/`FENCE_REQUIRED`, including established owner/generation cases,
   plus `RUNTIME_FENCED` and `PROJECT_ROOT_FENCED`), **2 = missing options / usage /
   unknown**, **1 = invalid values** (including `PROJECT_ROOT_UNRESOLVABLE`). This
   includes the public `checkpoint observe` ingress used by PostCompact.
3. **Event + state change = a single anchored transaction.** Business mutations use
   `integrity.appendAnchored(...)`. The fixed-shape budget writers (`recordCost` and
   the host-internal terminal Codex maker settlement) mirror its
   verify→append→anchor→reconcile sequence under one lock and expose no
   caller-selected event/mutation callback. Compact restore intents, observation
   receipts, and prune tombstones use their own fixed-shape locked publication and
   reconciliation paths; none is a caller-selected state/event callback. No half-commits, and no other raw
   `appendEvent` writes. Integrity is **detect-and-fail-stop, not prevention** — the
   threat model is cooperative-but-fallible.
4. **Terminal states are kernel-derived from proof only** — episode
   `done/approved/rejected`, workstream `ready/merged/abandoned`, review pass.
   *Exception:* episode `abandoned` is a human-gated (`episode abandon --confirm`)
   escape terminal — not proof-derived, does not count as review-point satisfaction,
   and is treated as settled by both termination paths. Checker `approved/rejected`
   only via the guarded `review record` or the bounded `review import --stdin`
   entrypoint; both derive workstream/point/target/source and share one in-lock proof
   commit. `review import` binds `reviewer_id` to the persisted checker `plugin`
   (`deep-review` or `subagent-checker`) and records `review_source: imported-stdin`;
   `review record` records `review_source: recorded-path`. Their CLI exit contract is
   **3** for `RUNTIME_FENCED`, `PROJECT_ROOT_FENCED` and established owner/generation
   fence cases, **1** for `PROJECT_ROOT_UNRESOLVABLE` or other invalid values, **2**
   for missing required options. `finish --status completed` requires per-maker review
   proof — checkers bind to a maker via `target_maker`, and the latest done maker per
   `(ws,point)` must have a bound APPROVED checker — plus a report file under `runDir`.
5. **Irreversible external actions are proposal-only in v1** — push/PR/merge/publish/
   delete, and marketplace/deep-suite sync. Always separately human-approved; no skill,
   hook or driver auto-executes them. `respawn`'s runtime-selected Claude/Codex spawn
   is session continuity, not an external-world change.
6. **respawn gate order:** budget → breaker → max_sessions → wallclock → auto_handoff,
   not gated by acting tier. The authoritative maker/checker gate samples a fresh
   injectable clock after preflight. Unattended autonomy forces **headless**, and the
   headless driver measures usage and **fails closed** (`pauseRun`) when usage is
   unmeasurable or times out. `driveHeadless` resumes handoffs through the canonical
   `respawn` (gate + `emitted→spawned` CAS). If an exact acquired Codex child
   kernel-finishes before its measured process result returns, only the host-internal,
   handoff/finish-bound, idempotent one-turn settlement may append that terminal cost;
   generic `leaseCheck`, `appendAnchored`, `budget record` and all CLI mutations remain
   terminal-rejected. That receipt is completion bookkeeping, so pre-finish insights
   remain a valid snapshot that intentionally excludes the final process measurement.
   Before an independent Codex checker child starts, the host verifies the selected
   deep-review manifest and skill bytes and publishes an immutable, run-owned capture
   under `checker-captures/`. The child reads only that capture. A byte-identical cache
   replacement is allowed after provenance is established, while source path, version,
   or content drift and any capture metadata/content drift fail closed. Post-process
   capture failure charges a measured checker turn exactly once and never imports it;
   pre-spawn failure has no checker cost.
7. **`withLock` is non-reentrant** — never take a lock inside a locked callback.
   Kernel durable writes are confined to `<root>/.deep-loop/`. The sole carve-out is
   `DEEP_LOOP_ROOT/scripts/lib/activation-secret.mjs`: the execution-child stored-activation client
   may write only its internally derived OS user-state `deep-loop/activation-secrets`
   directory. It accepts no caller path, never writes a raw token to project/kernel
   state or output, and fails closed on unsafe identity/permissions/ACL. It publishes
   only from `appendAnchored`'s owned-lock, post-eligibility/pre-append callback; an
   explicit fence or structured rejection therefore leaves no private-store residue.
   This is a cooperative-but-fallible execution-child contract, not physical-principal
   attestation: no local UID/PID/env/file mechanism distinguishes a malicious same-UID
   parent or replacement child. On Windows,
   trusted ambient `SystemRoot` must bind the exact
   `System32/WindowsPowerShell/v1.0/powershell.exe`; PATH resolution is forbidden.
   `/deep-loop-finish` may delegate to deep-memory's and deep-wiki's own skills.
   Compact hook glue never spawns: PreCompact is emit-only, PostCompact invokes only
   the bounded public `checkpoint observe` CLI, SessionStart emits restore context only,
   and every exception is best-effort and non-blocking.
   **Worktree carve-out:** Execution-plane worktree creation is allowed **only** under
   `<root>/.claude/worktrees/` (or `.worktrees/`) — project-root-internal and
   gitignored. Root escape is forbidden, enforced by kernel `newWorkstream`
   containment. `.gitignore` changes and worktree removal are proposal-only, and an
   orphan audit is required before removal. `runId` must be a single safe path segment.
8. **Circuit breaker latches** — human reset via lease-fenced `breaker reset --confirm`.
   Comprehension debt blocks only new maker fan-out (`discover`, and dispatching a new
   non-fix pending maker), and only while a settled (`done`) unreviewed maker exists.
   It never blocks fix, review, handoff or finish.

Terminal detection evaluates `$TMUX` **before** the native-Windows branch, deliberately:
the unrealistic `win32` + `$TMUX` combination then fails closed at the POSIX tmux
identity and platform checks and cannot authorize a spawn.

## Dev workflow

```bash
npm run preflight                # = npm run validate (schema + builder self-test) && npm test
npm test                         # node --test, portable built-in discovery
node --test tests/<x>.test.mjs   # single file
```

`npm run preflight` must pass before release.

- **Determinism:** time-sensitive code takes an injectable `now` (ms or ISO), and tests
  pass a fixed one. Never rely on `Date.now()` in a test that also seeds a fixed
  `created_at`.
- **No external deps.** Durable state is JSON — there is no YAML parser. The PreCompact,
  PostCompact, and SessionStart bootstraps are static, shell-free Node.
- Add a failing test first, keep `npm test` green, one focused commit per change.

## Conventions

- `state.classifyPatch` is the patch whitelist (default-deny). The CLI trusts it —
  never reimplement the allowlist.
- Every deep-loop artifact except `loop.json` — handoff, compaction-state,
  final-report — is wrapped in the M3 envelope (`producer:"deep-loop"`, ULID `run_id`,
  `parent_run_id` chain).
- Skill frontmatter is exactly `name` / `description` / `user-invocable`. `description`
  packs English and Korean trigger phrases; detect the user's language and respond in
  kind.

## Fixture evaluation

Run the offline fixture bank separately from preflight:
`npm run eval:fixture -- --out ./evals/results/local --now 2026-08-10T00:00:00Z`.

## Release — post-merge deep-suite sync

Only after this repo's PR merges **and a separate post-merge sync approval is granted**:
set the `deep-loop` entry `sha` to the merged `main` commit in the deep-suite registry
(`.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json`), then run
deep-suite `npm run preflight`, which regenerates the README tables — never edit inside
the auto-generated markers.

The patch is pre-written at `DEEP_LOOP_ROOT/integration/deep-suite.patch.md`. It is a proposal, not
evidence that distribution has already been synchronized or released. Registration adds
discoverability only; deep-loop runs standalone with no sibling installed.
