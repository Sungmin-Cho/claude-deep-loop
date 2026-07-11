# deep-loop — Codex Project Guide

Loop Engineering control plane over the deep-suite: a 2-plane plugin (deterministic Node control plane + LLM execution plane) that discovers work, routes it to sibling `deep-*` plugins as maker/checker episodes, keeps durable lock-safe loop state, and hands off to fresh sessions autonomously.

To check the current version: `node -e "console.log(require('./.claude-plugin/plugin.json').version)"`. Node ≥ 20, `type: module`, zero external dependencies.

> Full working guide (architecture, invariants, conventions): `CLAUDE.md`. Authoritative design: `docs/superpowers/specs/2026-06-24-deep-loop-design.md`. User docs: `README.md` / `README.ko.md`. Source of truth is the repo + `git log` + those docs — do not assume prior conversation context.

## Runtime Surfaces

- Claude Code manifest: `.claude-plugin/plugin.json` · Codex manifest: `.codex-plugin/plugin.json`
- Control plane (Node, the only state-change boundary): `scripts/deep-loop.mjs` (CLI) + `scripts/lib/*.mjs` (22 modules)
- Execution plane (skills): `skills/deep-loop/SKILL.md` (entry) + 9 more + `skills/deep-loop-workflow/references/*.md`
- Hook + headless: `hooks/hooks.json` (static shell-free Node bootstrap) → `scripts/hooks-impl/precompact-handoff.mjs`; unattended driver: `scripts/hooks-impl/drive-headless.mjs`
- Declarative: `protocols/*.json` · `recipes/*.json` (+ `automation/*.yml`) · `schemas/loop-run.schema.json`
- Durable state (runtime, git-ignored): `<project-root>/.deep-loop/runs/<run-id>/`

## Verification

```bash
npm run preflight   # = npm run validate (schema + builder self-test) && npm test (node --test tests/*.test.mjs)
```
Must pass before release. No external deps. Time-sensitive tests inject a fixed `now` (no `Date.now()` flakes). The PreCompact hook uses a static shell-free Node bootstrap.

## Non-negotiable invariants (see CLAUDE.md for detail)

- 2-plane boundary: skills **read** state, mutate **only** via the kernel CLI; the kernel never calls skills as functions.
- Every mutating CLI is lease-fenced (`--owner --generation`) checked in-lock; exit 3 = fence only / 2 = usage / 1 = invalid.
- Event + state change = one `appendAnchored` transaction; terminal states proof-derived (per-maker review via `target_maker`); `finish completed` is proof-gated.
- Irreversible external actions (push/merge/publish/delete) are proposal-only, always human-approved.
- Unattended autonomy forces headless + measured **fail-closed**; respawn gate budget→breaker→max_sessions→wallclock→auto_handoff; breaker latches (human reset).
- No writes outside `<project-root>/.deep-loop/` (final-report + finish's deep-memory/deep-wiki delegation excepted).

## Release: post-merge deep-suite sync (required)

After this repo's PR merges, set the `deep-loop` `sha` to the merged `main` commit in deep-suite's `.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json`, then run deep-suite `npm run preflight`. Patch pre-written: `integration/deep-suite.patch.md`. Registration adds discoverability only — deep-loop runs standalone.
