**English** | [한국어](./README.ko.md)

# deep-loop

**Durable orchestration plugin for Claude Code** — coordinates multi-session, cross-plugin engineering work with a strict 2-plane architecture, budget enforcement, and proposal-only safety invariants.

## Overview

deep-loop is a standalone Claude Code plugin that runs durable "loops" — structured sequences of discovery, triage, make, review, and integrate across multiple LLM sessions. It can operate independently or as the orchestration layer on top of the deep-suite (deep-work, deep-review, deep-wiki, deep-memory).

All irreversible external actions (push/PR/merge/publish/delete) are **proposal-only** in v1 — every such action requires **human approval** before execution. deep-loop itself never auto-pushes or auto-merges.

## Architecture: 2-Plane Design

deep-loop enforces a strict **2-plane separation** (spec §1):

### Control Plane (Kernel)
The kernel (`scripts/lib/`) manages all state, leases, budgets, and integrity:
- **State machine** (`state.mjs`, `lease.mjs`) — content-hash-anchored `loop.json`, generation-fenced leases
- **Budget engine** (`budget.mjs`) — turn/token/wallclock hard caps, fail-closed on unmeasurable usage
- **Circuit breaker** (`breaker.mjs`) — auto-trips on repeated failures, requires human reset
- **Integrity** (`integrity.mjs`) — append-only event log with chain + head anchors, tamper-detect
- **Handoff/respawn** (`handoff.mjs`, `respawn.mjs`) — stateful session handoff with idempotency keys
- **Execution plane CLI** (`deep-loop.mjs`) — the only mutation path for skills; all mutating commands require `--owner/--generation` lease fence

### Execution Plane (Skills / SKILL.md)
Skills are **read-only** with respect to raw state files. They read state only through the CLI (`state get`, `next-action`, `adapter resolve`, etc.) and write only through kernel CLI subcommands (`state patch`, `budget record`, `comprehension ack`, etc.). Skills never write `loop.json`, `event-log.jsonl`, or `.loop.hash` directly.

```
Skill (LLM) ──read──▶ state get / next-action / adapter resolve
Skill (LLM) ──write──▶ state patch / budget record / comprehension ack / episode new / etc.
                           │
                           ▼ (lock + fence + integrity.appendAnchored)
                        loop.json + event-log.jsonl (kernel-owned)
```

## Commands (10 Skills)

| Command | Description |
|---------|-------------|
| `/deep-loop` | **Entry point** — starts a durable orchestration run, detects sibling plugins, matches a recipe/protocol, decomposes the goal into workstreams |
| `/deep-loop-discover` | Discovery phase — populates `discovered_items`, maps them to workstreams |
| `/deep-loop-triage` | Triage phase — prioritizes workstreams, assigns protocols, confirms with human |
| `/deep-loop-continue` | Main tick — advances the current workstream: dispatch maker → await → read artifacts → dispatch checker |
| `/deep-loop-handoff` | Emits a clean handoff for the next session (writes compaction-state + handoff doc) |
| `/deep-loop-resume` | Resumes an interrupted run from a handoff document |
| `/deep-loop-status` | Read-only status report — current run state, budget, active workstreams, comprehension debt |
| `/deep-loop-ack` | Human review acknowledgement — marks an episode as human-reviewed, reducing comprehension debt |
| `/deep-loop-finish` | Finalizes a run — verifies all episodes settled, writes final-report, transitions status |

> Note: `/deep-loop-workflow` is an internal non-user-invocable skill used by `/deep-loop-continue` and other skills.

## Kernel CLI: `insights` (Hill-Climbing)

deep-loop mines its own run history into deterministic insights via a 3-verb kernel subcommand
(`scripts/lib/insights.mjs`, spec §6):

> Note: `--now` is accepted by most kernel CLI subcommands, not just `insights emit` (e.g. `next-action`, `tick`, `respawn`, `budget check`, `recover`, `session-profile set`, `finish`). Accepted forms are epoch ms or ISO-8601 (date-only is interpreted as UTC midnight; datetimes require a `Z`/`±HH:MM` designator). Across all of them, a malformed, value-less, or out-of-range (`±8.64e15`) value produces a common `INVALID_NOW` message on stderr and exit 1; omitting `--now` falls back to `Date.now()`.

| Subcommand | Role | Fence | Exit |
|---|---|---|---|
| `insights [--run <id>] [--json]` | Computes metrics + candidates. **Default = spec §4 aggregation across all runs**; `--run` narrows `per_run` only (candidates/aggregates stay fleet-wide). **Read-only** | Not required | 0 / 1 (invalid run id) / 2 (usage) |
| `insights emit --owner <run_id> --generation <n>` | Emits an envelope via the 3-step order (tmp atomic write → `appendAnchored` `insights-emitted` event → tmp→final atomic rename) | **Required** (invariant #2) | 0 / 1 (invalid `--now` / lib error) / 3 (fence) / 2 (usage) |
| `insights latest [--json]` | Returns the **verified** latest insights. **Read-only** — skills (`/deep-loop` init, `/deep-loop-finish`) use only this command, never parse `.deep-loop/insights/*.json` directly | Not required | 0 / 2 (usage) |

The payload (`insights_schema_version` stays `1` — these are additive fields) also carries two trust-labels: `suspicious_active` — a subset of `excluded_active` flagging non-terminal, non-paused runs whose lease is `released`, or `releasing` with an expired/missing TTL (a dead-lease signal, not an extra exclusion) — and `post_finish_mutated` — terminal runs whose `finish` event is followed by a non-exempt event (the run stays in the aggregates; only the label is added). `insights emit`'s stdout JSON returns both label arrays at the top level too, so stdout-only consumers see them without parsing the envelope. `insights latest` additionally trusts a run only when exactly one non-auto-floor-cost event follows the `insights-emitted` event the artifact is bound to (by path + sha256), and that event is `finish` — any other event(s) after the anchor, or none at all, cause a fail-soft skip to the next candidate file. Consumers that surface insights candidates to a human (e.g. `/deep-loop-finish`'s candidate block) should display `suspicious_active` / `post_finish_mutated` alongside candidates whenever either array is non-empty.

## Safety Invariants

1. **proposal-only / human approval** — push, PR, merge, publish, delete are never executed automatically. v1 always surfaces a proposal and waits for human confirmation.
2. **Lease fencing** — every mutating kernel CLI requires matching `--owner` (run_id) and `--generation`. Stale sessions are rejected before any state change.
3. **Fail-closed on unmeasurable usage** — unattended (headless) sessions that cannot measure turns/tokens are rejected, not silently passed. The `drive-headless.mjs` driver enforces this.
4. **Circuit breaker** — 3 consecutive REQUEST_CHANGES latch the breaker; a human must explicitly run `breaker reset --confirm --owner <run_id> --generation <n>` (lease-fenced, human-only) to resume. (`/deep-loop-ack` is unrelated — it reduces comprehension debt.)
5. **Terminal states via proof only** — episode `done`/`approved`/`rejected`, workstream `merged`/`abandoned` can only be set through verified proof artifacts, not direct state patch. **Exception: episode `abandoned` is a human-gated (`--confirm`) escape for stranded episodes, not proof-derived.**
6. **No writes outside `.deep-loop/`** — all kernel writes go under `<project-root>/.deep-loop/`. External writes (deep-memory store, wiki) are delegated to those plugins' own skills.

## Installation

```bash
# Recommended — install from the Deep Suite marketplace:
/plugin marketplace add Sungmin-Cho/claude-deep-suite
/plugin install deep-loop@claude-deep-suite
```

Standalone (without the rest of the suite):

- **Skills directory (permanent):** clone this repo into `~/.claude/skills/deep-loop/`; it loads as `deep-loop@skills-dir` on the next session.
- **Session only:** `claude --plugin-dir /path/to/claude-deep-loop`

Requirements: Node >= 20, no external npm dependencies.

## Standalone Operation

deep-loop is designed for **standalone** use — it does not require any other deep-suite plugin. When operating without siblings:

- Protocol defaults to `standalone` if no sibling plugins are detected (`detect-plugins` returns empty)
- Skills gracefully degrade: maker/checker dispatch uses `standalone` adapters
- All safety invariants, budget enforcement, and handoff mechanics work identically

When sibling plugins (deep-work, deep-review, deep-wiki, deep-memory) are present, deep-loop automatically detects them and uses their specialized skills as adapters.

## Unattended (Headless) Automation

For cron or CI use, deep-loop includes `scripts/hooks-impl/drive-headless.mjs`:

```bash
# Run one tick headlessly (fail-closed: exits 1 if usage unmeasurable)
DEEP_LOOP_UNATTENDED=1 node scripts/hooks-impl/drive-headless.mjs

# See recipes/automation/ for cron and GitHub Actions templates
```

The headless driver wraps `claude -p` with timeout + usage measurement. If usage cannot be measured (no `num_turns`/tokens in output), it **fails closed** — never silently continuing past budget.

## deep-suite Integration

When used within the deep-suite, deep-loop acts as the orchestration backbone:

- **deep-work** — maker/checker adapter for implementation workstreams
- **deep-review** — checker adapter for code review workstreams  
- **deep-wiki** — writer adapter for documentation workstreams
- **deep-memory** — called by `/deep-loop-finish` to archive run artifacts

The `adapter resolve` CLI returns normalized 4-verb descriptors (dispatch/await/read/checker_via) for each protocol, letting skills dispatch the right sibling without hardcoding adapter logic.

## Visible Session Continuity (Self-Spawn)

When `autonomy.spawn_style` is `'visible'` and deep-loop detects a supported terminal multiplexer at run-init, it can spawn the next session in a new visible window automatically:

| Launcher | Detection signal | New session target |
|----------|-----------------|-------------------|
| cmux | `CMUX_BUNDLED_CLI_PATH` + `CMUX_SOCKET_PATH` + surface ID | new cmux workspace via socket |
| iTerm2 | `TERM_PROGRAM=iTerm.app` + osascript probe | new iTerm window |
| Terminal.app | `TERM_PROGRAM=Apple_Terminal` + osascript probe | new Terminal window |
| Windows Terminal | `WT_SESSION` + `wt.exe` probe | new WT tab |
| desktop | (user opt-in) Claude Desktop Code tab | opens a verified Claude Desktop handler via `claude://code/new` deeplink — **semi-automatic**: user confirms folder + presses Enter. macOS (path + bundle-id + codesign TeamIdentifier) and, since v1.7.0, **Windows** (traditional-installer exact paths + MSIX path pattern with a pinned publisher-id hash, plus an Authenticode signer thumbprint **pinned from a real Windows 11 observation**). On Windows the offer appears only when the live probe verifies the installed handler; after the pinned leaf cert rotates (NotAfter ~2026-10-21) dispatch returns to deterministic fail-closed until a newly observed thumbprint is re-pinned — guessed pins are never used. |

The spawn is **attended-only**: the parent session must have been launched interactively (`--attended` flag set by the skill). If the parent is headless (`DEEP_LOOP_UNATTENDED=1`, `spawn_style='headless'`, or a headless-entrypoint is detected), visible spawn is bypassed and the headless path is taken instead.

**OS-agnostic fallback**: If no launcher is detected (`launcher='none'`), or the session is not attended, `respawn` returns `{ok:false, outcome:'no-launcher'}`. The skill then calls `pauseRun({mode:'preserve'})`, keeping the reserved child in the handoff. A human opens a new terminal and runs `/deep-loop-resume`, or the reserved child session starts later and acquires the still-releasing lease — either path unpauses the run automatically. The handoff document and `launch-command.txt` always provide a copy-paste command for manual use.

**Gate order**: budget → breaker → max_sessions → wallclock → auto_handoff. A gate failure triggers `rollbackAndPause` (lease rolled back, child invalidated). A launch command failure also rolls back. A readiness timeout uses `preservePause` (child kept, late acquire still succeeds).

## PreCompact Hook

deep-loop registers a `PreCompact` hook that emits a clean handoff before Claude Code compacts context. In unattended mode, it also triggers a headless respawn. The hook never blocks compaction (always exits 0).

```json
// hooks/hooks.json
{ "hooks": { "PreCompact": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/precompact-handoff.sh" }] }] } }
```

## License

MIT — see LICENSE.
