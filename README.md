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

## Safety Invariants

1. **proposal-only / human approval** — push, PR, merge, publish, delete are never executed automatically. v1 always surfaces a proposal and waits for human confirmation.
2. **Lease fencing** — every mutating kernel CLI requires matching `--owner` (run_id) and `--generation`. Stale sessions are rejected before any state change.
3. **Fail-closed on unmeasurable usage** — unattended (headless) sessions that cannot measure turns/tokens are rejected, not silently passed. The `drive-headless.mjs` driver enforces this.
4. **Circuit breaker** — repeated failures trip the breaker; human must explicitly run `/deep-loop-ack` or `breaker reset` to resume.
5. **Terminal states via proof only** — episode `done`/`approved`/`rejected`, workstream `merged`/`abandoned` can only be set through verified proof artifacts, not direct state patch.
6. **No writes outside `.deep-loop/`** — all kernel writes go under `<project-root>/.deep-loop/`. External writes (deep-memory store, wiki) are delegated to those plugins' own skills.

## Installation

```bash
# Install as a Claude Code plugin from the deep-suite or standalone:
claude plugin install https://github.com/Sungmin-Cho/claude-deep-loop.git

# Or clone locally and add to your project:
git clone https://github.com/Sungmin-Cho/claude-deep-loop.git ~/.claude/plugins/deep-loop
```

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

## PreCompact Hook

deep-loop registers a `PreCompact` hook that emits a clean handoff before Claude Code compacts context. In unattended mode, it also triggers a headless respawn. The hook never blocks compaction (always exits 0).

```json
// hooks/hooks.json
{ "hooks": { "PreCompact": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/precompact-handoff.sh" }] }] } }
```

## License

MIT — see LICENSE.
