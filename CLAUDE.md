# deep-loop — Claude Code Project Guide

Loop Engineering control plane over the deep-suite: a 2-plane Claude Code / Codex plugin that discovers work, routes it to sibling `deep-*` plugins as maker/checker episodes, keeps durable lock-safe loop state, and hands off to fresh sessions autonomously — keeping the human in the verification loop, never in the cycle between steps.

Version: `node -e "console.log(require('./.claude-plugin/plugin.json').version)"`. Node ≥ 20, `type: module`, **zero external dependencies**.

> This file guides agents working **on** the deep-loop codebase. User-facing usage is in `README.md` / `README.ko.md`; the authoritative v1 design is `docs/superpowers/specs/2026-06-24-deep-loop-design.md`; bite-sized plans + Codex review logs are in `docs/superpowers/plans/`. **Source of truth is the repo + `git log` + those docs — do not assume prior conversation context.**

## Architecture — 2-plane (strict)

```
EXECUTION PLANE (LLM)   skills/*/SKILL.md        judgment: discover · triage · decompose · decide · dispatch
        │  reads state (state get / next-action / validate) — mutates ONLY via the kernel CLI
        ▼
CONTROL PLANE (Node, deterministic)   scripts/deep-loop.mjs + scripts/lib/*.mjs
        │  state(lock) · budget · breaker · comprehension · schema · lease · handoff · respawn · review · finish
        ▼  atomic temp+rename, M3 envelope
   .deep-loop/runs/<run-id>/  loop.json · event-log.jsonl · episodes/ · handoffs/ · final-report.md
```

The kernel **never calls sibling skills as functions** — it returns descriptors (`next-action`, `adapter resolve`, `review dispatch`) and the Execution-plane LLM performs the dispatch (`Skill()` or, headless, a `claude -p` subprocess via `respawn`'s injected `spawnFn`).

## Repo map

- `scripts/deep-loop.mjs` — CLI dispatcher (the **only** state-change boundary). Subcommands: `validate · detect-plugins · recipe-match · init-run · state get/patch · next-action · tick · lease · workstream · episode · review · handoff · respawn · adapter resolve · budget · comprehension · breaker · finish`.
- `scripts/lib/*.mjs` (22 modules) — `state · integrity · budget · breaker · comprehension · schema · envelope · slug · detect · recipes · initrun · log · lease · workspace · episode · review · adapters · next-action · handoff · respawn · finish · spawn-driver`.
- `scripts/hooks-impl/{precompact-handoff,drive-headless}.mjs` — hook glue + headless cron driver (the only lib importers outside the kernel).
- `hooks/hooks.json` + `hooks/scripts/precompact-handoff.sh` — PreCompact safety-net (Bash 3.2).
- `skills/deep-loop*/SKILL.md` (10) + `skills/deep-loop-workflow/references/*.md` — Execution plane.
- `protocols/*.json` (deep-work/superpowers/standalone declarative adapters) · `recipes/*.json` (+ `automation/*.yml`) · `schemas/loop-run.schema.json`.
- `tests/*.test.mjs` (`node --test`) · `docs/` · `integration/deep-suite.patch.md`.

## Hard invariants — DO NOT break (enforced by code + Codex review)

1. **2-plane boundary.** Skills only **read** state; every mutation goes through a kernel CLI subcommand. A SKILL.md must never instruct a direct write to `loop.json` / `event-log.jsonl` / `.loop.hash` (writing `.deep-loop/runs/<id>/final-report.md` is allowed). `tests/skills.test.mjs` enforces this.
2. **Every mutating CLI is lease-fenced** (`--owner <run_id> --generation <n>`) and the fence is checked **inside the same lock/`preCheck`** that mutates state — not only as an outside precondition. Exit codes: **3 = fence only** (`LEASE_FENCED`/`FENCE_REQUIRED`), 2 = usage/unknown, 1 = invalid value.
3. **Event + state change = a single `integrity.appendAnchored(...)` transaction.** No half-commits; never call `appendEvent` raw (stales the `event_log_head` anchor). Integrity is detect-and-fail-stop, not prevention (cooperative-but-fallible threat model, spec §1.2).
4. **Terminal states are kernel-derived from proof only** — episode `done/approved/rejected`, workstream `ready/merged/abandoned`, review pass. Checker `approved/rejected` only via `review record`. `finish --status completed` requires per-maker review proof (checkers bind to a maker via `target_maker`; the latest done maker per `(ws,point)` must have a bound APPROVED checker) + report file under `runDir`.
5. **Irreversible external actions (push/merge/publish/delete) are proposal-only in v1** — always human-approved. No skill/hook/driver auto-executes them. `respawn`'s `claude` spawn is session continuity (allowed), not an external-world change.
6. **respawn gate order:** budget → breaker → max_sessions → wallclock → auto_handoff (not gated by acting tier). Unattended autonomy forces **headless**; the headless driver measures usage and **fails closed** (`pauseRun`) when usage is unmeasurable/timed-out. `driveHeadless` resumes handoffs through the canonical `respawn` (gate + `emitted→spawned` CAS).
7. **`withLock` is non-reentrant** — never take a lock inside a locked callback. Kernel durable writes are confined to `<root>/.deep-loop/`; `/deep-loop-finish` may delegate to deep-memory/deep-wiki's own skills. **Worktree-write carve-out:** Execution-plane worktree creation is allowed **only** under `<root>/.claude/worktrees/` (or `.worktrees/`, project-root-internal, gitignored) — root-escape is forbidden (enforced by kernel `newWorkstream` containment from Task 2); `.gitignore` changes are proposal-only; worktree removal is proposal-only; orphan audit required before removal. `runId` must be a single safe path segment.
8. **Circuit breaker latches** (human + lease-fenced `breaker reset --confirm`); comprehension debt blocks only new maker fan-out (`discover`), not fix/review/handoff/finish.

## Dev workflow

```bash
npm run preflight        # = npm run validate (schema + builder self-test) && npm test
npm test                 # node --test tests/*.test.mjs
node --test tests/<x>.test.mjs   # single file
```

- **Determinism:** time-sensitive code takes an injectable `now` (ms or ISO). Tests pass a fixed `now` — never rely on `Date.now()` in a test that also seeds a fixed `created_at` (that was the original `orch-cli` date-flake).
- **No external deps.** Durable state is JSON (no YAML parser). Hooks are Bash 3.2 (`set -Eeuo pipefail`; no `declare -A` / `${var,,}`).
- Add a failing test first; keep `npm test` green; one focused commit per change. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Conventions

- `state.classifyPatch` is the patch whitelist (default-deny); the CLI trusts it — never reimplement the allowlist.
- All deep-loop artifacts except `loop.json` (handoff / compaction-state / final-report) are wrapped in the M3 envelope (`producer:"deep-loop"`, ULID `run_id`, `parent_run_id` chain).
- Skills frontmatter is exactly `name` / `description` / `user-invocable`; `description` packs English + Korean trigger phrases; detect the user's language and respond in kind.

## Release — post-merge deep-suite sync (required)

After this repo's PR merges, set the `deep-loop` entry `sha` to the merged `main` commit in the deep-suite registry (`.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json`), then run deep-suite `npm run preflight` (regenerates README tables — never edit inside the auto-generated markers). The patch is pre-written at `integration/deep-suite.patch.md`. Registration adds discoverability only; deep-loop runs standalone with no sibling installed.
