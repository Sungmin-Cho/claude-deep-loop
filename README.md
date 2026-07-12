**English** | [한국어](./README.ko.md)

# deep-loop

**Durable orchestration plugin for Claude Code and Codex** — coordinates multi-session, cross-plugin engineering work with a strict 2-plane architecture, budget enforcement, and proposal-only safety invariants.

## Overview

deep-loop is a standalone Claude Code / Codex plugin that runs durable "loops" — structured sequences of discovery, triage, make, review, and integrate across multiple LLM sessions. It can operate independently or as the orchestration layer on top of the deep-suite (deep-work, deep-review, deep-wiki, deep-memory).

**Proposal-only** means push, PR, merge, publish, delete, and marketplace/deep-suite sync all require separate **human approval** before execution. Installation does not imply that this repository has been released or synchronized to either marketplace.

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

## Commands (9 User Skills)

| Claude Code | Codex CLI / App | Description |
|---|---|---|
| `/deep-loop` | `$deep-loop:deep-loop` | **Entry point** — starts a durable orchestration run, detects sibling plugins, matches a recipe/protocol, decomposes the goal into workstreams |
| `/deep-loop-discover` | `$deep-loop:deep-loop-discover` | Discovery phase — populates `discovered_items`, maps them to workstreams |
| `/deep-loop-triage` | `$deep-loop:deep-loop-triage` | Triage phase — prioritizes workstreams, assigns protocols, confirms with human |
| `/deep-loop-continue` | `$deep-loop:deep-loop-continue` | Main tick — advances the current workstream: dispatch maker → await → read artifacts → dispatch checker |
| `/deep-loop-handoff` | `$deep-loop:deep-loop-handoff` | Emits a clean handoff for the next session |
| `/deep-loop-resume` | `$deep-loop:deep-loop-resume` | Resumes an interrupted run from a handoff document |
| `/deep-loop-status` | `$deep-loop:deep-loop-status` | Read-only status report — state, budget, workstreams, and comprehension debt |
| `/deep-loop-ack` | `$deep-loop:deep-loop-ack` | Marks a human-reviewed episode and reduces comprehension debt |
| `/deep-loop-finish` | `$deep-loop:deep-loop-finish` | Verifies settled episodes, writes the final report, and finishes the run |

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

1. **proposal-only / human approval** — push, PR, merge, publish, delete, and marketplace/deep-suite sync are never executed automatically. v1 always surfaces a proposal and waits for human confirmation.
2. **Lease fencing** — every mutating kernel CLI requires matching `--owner` (run_id) and `--generation`. Stale sessions are rejected before any state change.
3. **Fail-closed on unmeasurable usage** — unattended (headless) sessions that cannot measure turns/tokens are rejected, not silently passed. The `drive-headless.mjs` driver enforces this.
4. **Circuit breaker** — 3 consecutive REQUEST_CHANGES latch the breaker; a human must explicitly run `breaker reset --confirm --owner <run_id> --generation <n>` (lease-fenced, human-only) to resume. (`/deep-loop-ack` is unrelated — it reduces comprehension debt.)
5. **Terminal states via proof only** — episode `done`/`approved`/`rejected`, workstream `merged`/`abandoned` can only be set through verified proof artifacts, not direct state patch. **Exception: episode `abandoned` is a human-gated (`--confirm`) escape for stranded episodes, not proof-derived.**
6. **No writes outside `.deep-loop/`** — all kernel writes go under `<project-root>/.deep-loop/`. External writes (deep-memory store, wiki) are delegated to those plugins' own skills.

## Installation and Discovery

The marketplace entries may be synchronized only after merge and separate approval. Until then, use the local-repository paths below; do not infer that v1.8.0 has already been published.

| Surface | Local installation and discovery | After a local plugin change |
|---|---|---|
| Claude Code | Use `claude --plugin-dir /absolute/path/to/deep-loop`. Only after the separately approved post-merge registry sync, use `/plugin marketplace add Sungmin-Cho/claude-deep-suite` and `/plugin install deep-loop@claude-deep-suite`. | Start a new session. |
| Codex CLI | Complete both coupled local-install steps below, then open `/plugins`. | Start a new task/session and verify it in `/plugins`. |
| Codex App | Complete the same coupled install. In the ChatGPT desktop app, select **Work or Codex**, open **Plugins**, and select deep-loop. | **Restart the App**, then start a new task. |

The Codex personal install is one coupled operation, not alternatives: first copy/place this repository at the official current personal plugin directory `~/.codex/plugins/deep-loop`; then add or update its entry in the local personal marketplace `~/.agents/plugins/marketplace.json` with `source.path` set to `"./.codex/plugins/deep-loop"`. Both steps are required. In the ChatGPT desktop app: select **Work or Codex**, then open **Plugins**.

On Windows the coupled locations are `%USERPROFILE%\.codex\plugins\deep-loop` and `%USERPROFILE%\.agents\plugins\marketplace.json`, whose entry must point `source.path` at the former directory. Requirements: Node >= 20 and no external npm dependencies.

Codex App install/discovery and in-task skill execution are supported by the plugin contract. There is **no automated app-native task creation** and **no private app-native task-creation URL or deep link**. For continuation, open a new task at the recorded project root and invoke `$deep-loop:deep-loop-resume`; the durable lease keeps the run paused until that manual step. **App smoke pending external evidence**: lifecycle support is implemented, but an App-specific smoke has not been run in this repository.

## Supported Surfaces

| Surface | Interactive skills | Visible continuation | Headless continuation | PreCompact safety net |
|---|---|---|---|---|
| Claude Code, macOS/Linux | Full | Supported terminal/verified Claude Desktop transports | Measured `claude -p` | Exact-definition-trusted direct Node hook |
| Claude Code, native Windows | Full | Trusted Windows Terminal/PowerShell launcher | Trusted native `claude.exe`; otherwise fail-closed | Exact-definition-trusted direct Node hook |
| Codex CLI, macOS/Linux | Full | Terminal launch using the trusted runtime | Isolated `codex exec --json` | Exact-definition-trusted direct Node hook |
| Codex CLI, native Windows | Full | Trusted Windows Terminal/PowerShell launcher | Isolated trusted `codex.exe`; otherwise fail-closed | Exact-definition-trusted direct Node hook |
| Codex App | Install/discovery and in-task execution | Manual new task only | Optional isolated `codex exec` driver | Lifecycle supported; App smoke pending external evidence |

**Codex POSIX visible authority:** macOS/Linux automatic visible continuation requires the durable human-approved Codex runtime identity. `cmux` is runnable only when detection bound the same absolute bundled executable to the exact socket with a successful ping. On macOS, the fixed `/usr/bin/osascript` may launch only the positively detected iTerm2 or Terminal.app entry; finding that system binary alone never activates both launchers. Missing runtime approval returns `runtime-identity-unavailable`, identity or launcher drift fails closed around the spawned CAS, and no path substitutes a bare `codex` or a Claude process.

Native Windows means the Node control plane runs directly on win32 and the documented native commands use **PowerShell**; Windows Terminal and PowerShell remain separate approved launcher kinds. **WSL follows Linux behavior and is not native Windows**; a WSL executable or path is not authority for a native-Windows spawn. **Native Windows CI: pending external evidence** until the repository's Windows job actually runs after an approved push.

## Executable Trust and Native Windows Launchers

Automatic continuation never trusts command lookup alone. Runtime executable diagnosis/approval applies to the selected runtime on every supported OS; launcher executable approval is the additional native-Windows WT/PowerShell boundary. Substitute the installed plugin's canonical absolute root for `<absolute-deep-loop-root>` and run exactly one read-only diagnosis for the selected identity:

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" runtime-executable diagnose --runtime <claude|codex> --path "<human-supplied-absolute-exe>"
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable diagnose --kind <wt|powershell> --path "<human-supplied-absolute-exe>"
```

Show the returned **canonical absolute path** (`canonical_path`) and **lowercase SHA-256** (`sha256`) to the user. Only after the user confirms that exact identity may the matching fenced approval run:

```text
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" runtime-executable approve --runtime <claude|codex> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
node "<absolute-deep-loop-root>/scripts/deep-loop.mjs" launcher-executable approve --kind <wt|powershell> --path "<same-absolute-exe>" --canonical-path "<diagnosed-canonical-path>" --sha256 "<diagnosed-lowercase-sha256>" --actor human --confirm --owner <owner_run_id> --generation <generation> --project-root "<canonical-project-root>" --run-id <run_id>
```

Run only the line for the identity being approved. Identity drift fails closed and preserves or restores the pause; it never falls back to another executable or runtime.

The runtime/launcher Authenticode signer policy is **pending Windows observation** and is distinct from the already-observed **Claude Desktop handler pin** used only for the verified `claude://code/new` handler. There is **no bare PATH authority**, no shim (`.cmd`, `.ps1`, or wrapper) authority, and no bare `wt.exe` authority. A signer policy, path candidate, or `where.exe`/`Get-Command` result never substitutes for the explicit canonical identity contract.

## Standalone Operation

deep-loop is designed for **standalone** use — it does not require any other deep-suite plugin. When operating without siblings:

- Protocol defaults to `standalone` if no sibling plugins are detected (`detect-plugins` returns empty)
- Skills gracefully degrade: maker/checker dispatch uses `standalone` adapters
- All safety invariants, budget enforcement, and handoff mechanics work identically

When sibling plugins (deep-work, deep-review, deep-wiki, deep-memory) are present, deep-loop automatically detects them and uses their specialized skills as adapters.

## Unattended (Headless) Automation

For cron or CI use, deep-loop includes `scripts/hooks-impl/drive-headless.mjs`. Set `DEEP_LOOP_UNATTENDED=1` in the host environment, then invoke Node directly:

```bash
# POSIX shell / WSL
DEEP_LOOP_UNATTENDED=1 node scripts/hooks-impl/drive-headless.mjs
```

```powershell
# Native Windows PowerShell
$env:DEEP_LOOP_UNATTENDED = '1'
node scripts/hooks-impl/drive-headless.mjs
```

For **Claude**, the headless driver parses bounded `claude -p --output-format json` output. For an approved **Codex** runtime, it uses an authenticated isolated `CODEX_HOME`, shell-free `codex exec --json`, and incremental JSONL parsing. Each path records exactly one measured turn; timeout, non-zero exit, malformed output, or unmeasurable usage **fails closed**. There is no cross-runtime fallback. The isolated Codex child disables plugins and hooks (as well as Apps and remote capabilities), so it executes the absolute resume skill workflow inline and relies on durable state plus measured process exit.

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
| Windows Terminal | `WT_SESSION` + approved canonical launcher identity | new WT tab through the exact approved executable |
| desktop | (user opt-in) Claude Desktop Code tab | opens a verified Claude Desktop handler via `claude://code/new` deeplink — **semi-automatic**: user confirms folder + presses Enter. macOS (path + bundle-id + codesign TeamIdentifier) and, since v1.7.0, **Windows** (traditional-installer exact paths + MSIX path pattern with a pinned publisher-id hash, plus an Authenticode signer thumbprint **pinned from a real Windows 11 observation**). On Windows the offer appears only when the live probe verifies the installed handler; after the pinned leaf cert rotates (NotAfter ~2026-10-21) dispatch returns to deterministic fail-closed until a newly observed thumbprint is re-pinned — guessed pins are never used. |

The spawn is **attended-only**: the parent session must have been launched interactively (`--attended` flag set by the skill). If the parent is headless (`DEEP_LOOP_UNATTENDED=1`, `spawn_style='headless'`, or a headless-entrypoint is detected), visible spawn is bypassed and the headless path is taken instead.

**OS-agnostic fallback**: If no launcher is detected (`launcher='none'`), or the session is not attended, `respawn` returns `{ok:false, outcome:'no-launcher'}`. The skill then calls `pauseRun({mode:'preserve'})`, keeping the reserved child in the handoff. A human opens a new terminal and runs `/deep-loop-resume` in Claude Code or `$deep-loop:deep-loop-resume` in Codex, or the reserved child session starts later and acquires the still-releasing lease — either path unpauses the run automatically. The handoff document and `launch-command.txt` always provide a runtime-correct copy-paste command for manual use.

**Gate order**: budget → breaker → max_sessions → wallclock → auto_handoff. A gate failure triggers `rollbackAndPause` (lease rolled back, child invalidated). A launch command failure also rolls back. A readiness timeout uses `preservePause` (child kept, late acquire still succeeds).

## PreCompact Hook

deep-loop registers a `PreCompact` hook that emits a clean handoff before context compaction. The **exact hook definition** in `hooks/hooks.json` must be trusted by the host. It is a direct shell-free Node, emit-only, best-effort safety net; unattended continuation is handled later by the measured `scripts/hooks-impl/drive-headless.mjs` driver. The hook never owns the run and never blocks compaction (always exits 0).

`hooks/hooks.json` uses a static, shell-free Node bootstrap that resolves `CLAUDE_PLUGIN_ROOT` (or `PLUGIN_ROOT`), imports `scripts/hooks-impl/precompact-handoff.mjs` through a file URL, and invokes its `main()` export. The bootstrap does not depend on a Bash wrapper or shell expansion.

A missing or untrusted hook reduces automation and falls back to the durable lease, pause, and manual resume path; it never weakens fencing or grants a second owner. The deliberately isolated Codex child disables plugins and hooks, so this fallback is also its expected continuity model.

## License

MIT — see LICENSE.
