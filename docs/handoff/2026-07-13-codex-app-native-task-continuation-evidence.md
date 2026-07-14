# Evidence — Codex App native task continuation

> Started: 2026-07-13T23:35:16+09:00
>
> Operating contract: `docs/handoff/2026-07-13-codex-app-native-task-continuation-goal-handoff.md`
>
> Implementation worktree: `/Users/sungmin/Dev/claude-plugins/deep-loop/.claude/worktrees/codex-app-native-task-continuation`

This is the durable evidence log for the gated implementation and release of Codex App native task continuation. A quality gate is not passed by green tests alone. The user's latest reviewer instruction on 2026-07-15 supersedes only the operating handoff's Opus/xhigh reviewer selection: each new gate must use Codex-only `gpt-5.6-sol` at `high`, naturally converge, and be followed by an independent main-agent check. Historical Opus receipts remain evidence only for their exact old target bytes.

## Gate 0 — bootstrap, isolation, baseline

Status: PASS

- Original checkout: `/Users/sungmin/Dev/claude-plugins/deep-loop`
- Original branch: `main`
- Fetched `origin/main`: `c38a96137f8f4f0099c35e893860930e8ee4cf73`
- Branch base / pre-bootstrap HEAD: `c38a96137f8f4f0099c35e893860930e8ee4cf73`
- Implementation branch: `codex/codex-app-native-task-continuation`
- Plugin version: `1.8.2`
- Node: `v26.0.0` (repository minimum: Node 20)
- Original checkout status before worktree creation: `main...origin/main` plus user-owned untracked `.deep-memory/`; it was not read, modified, staged, or deleted.
- Worktree isolation: the original checkout was a normal checkout; no current-thread native worktree-enter tool was available, so the approved git worktree fallback created the project-internal ignored path above.
- Bootstrap handoff source and worktree copy SHA-256: `6c6be9c1e313e77bdbd0855d285caa1ee87563c4ae8e94b05f57cf5eaaf45af9`; `cmp` succeeded.
- Setup: `npm install` reported up to date, audited 1 package, 0 vulnerabilities.
- Baseline verification: `npm run preflight` exited 0.
  - `npm run validate`: PASS (`ok`)
  - `node --test`: 1,463 tests, 1,463 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo
  - Test duration reported by Node: 34,282.955 ms

Main-agent judgment: the fetched remote base, version, test count, and user-owned untracked state match the handoff baseline. There is no baseline failure or drift to resolve, so Gate 1 research/design may begin after this bootstrap evidence is committed.

## Gate 1 — research and design

Status: REVIEW INVALIDATED — replacement review pending

Design target: `docs/superpowers/specs/2026-07-13-codex-app-native-task-continuation-design.md`

### Repository and kernel evidence

- Runtime is currently run-level `claude|codex`; there is no durable host-surface axis (`scripts/lib/runtime.mjs`).
- `emitHandoff` already commits child-session creation, parent supersession, and `reserved→emitted/releasing` in one `appendAnchored` transaction (`scripts/lib/handoff.mjs:187-211`).
- Current `acquireLease` lets the reserved child acquire a releasing lease without checking handoff phase, host surface, App attempt, or launch confirmation (`scripts/lib/lease.mjs:43-98`). Therefore an App binding added only after emit would be bypassable; the design binds transport and attempt in the final emit transaction and uses a dedicated confirmed acquire.
- Existing respawn performs the hard gates in the required order and advances `emitted→spawned` before external launch, but its spawned re-entry is transport-agnostic (`scripts/lib/respawn.mjs:84-101,266-307`). Headless re-entry is also transport-agnostic (`scripts/lib/headless-host.mjs:1084-1111`). The design requires an early App-transport guard in both paths.
- Generic handoff phase/acquire helpers use direct locked state writes. App metadata transitions therefore use dedicated anchored APIs rather than extending those writes with unanchored event-relevant state (`scripts/lib/lease.mjs:43-98,149-176`; `scripts/lib/integrity.mjs:96-151`).
- `rootOf()` may fold a conventional worktree cwd to the outer run root; App routing must separately bind the actual invocation cwd (`scripts/deep-loop.mjs:103-107`; `scripts/lib/state.mjs:12-32`).
- Recorded worktrees are already constrained to `.claude/worktrees/` or `.worktrees/`, realpath checked, and stored root-relative (`scripts/lib/workspace.mjs:23-69`). The design reuses this authority and requires exactly one active record whose canonical worktree equals the calling cwd.
- `session_spawn.surface` already means terminal surface (`workspace|window|tab`). The new product-host axis is named `host_surface`, not an overload of that field (`scripts/lib/detect-terminal.mjs`).
- The current validator performs manual semantic checks and does not generically enforce all nested JSON Schema properties. App correlation/length/opaque-ID rules must be implemented in `schema.mjs`, not only the declarative schema (`scripts/lib/schema.mjs:164-207`).
- Current Codex App runtime descriptor is intentionally manual with reason `codex-transport-not-activated` (`scripts/lib/runtime-descriptor.mjs:157-189`); legacy absence/manual behavior remains unchanged.

### Current host and App contract evidence

- Current task exposes first-party Codex App provenance with callable `list_projects`, `create_thread`, `fork_thread`, and `send_message_to_thread` contracts. This is positive App-host evidence for the current session; environment variables and process paths are not adopted as durable authority.
- Read-only `list_projects` returned a local project whose `projectId` and `path` both exactly identify `/Users/sungmin/Dev/claude-plugins/deep-loop`. Optional/missing project paths, non-local projects, and duplicate exact matches are excluded by design.
- `create_thread` local project target is `{type:'project', projectId, environment:{type:'local'}}`. Read-only inspection of the currently installed App implementation indicates a local result carrying `threadId`, but its exposed declaration is `Promise<unknown>` rather than a stable public success schema. Therefore a bounded opaque `threadId` parser is fail-closed/provisional until approved smoke verifies the actual receipt. A worktree/client-thread-only result is intentionally not used.
- `fork_thread` uses `{type:'same-directory'}` without scraping or passing a source thread ID. It inherits completed history only; the active turn and unfinished response are not copied.
- `send_message_to_thread` also exposes `Promise<unknown>` without a guaranteed ID echo. The current installed implementation appears to return the target thread ID, but the design relies only on successful host-tool completion as the dispatch receipt; if an ID is present it must exactly match the forked thread. Model/thinking are omitted so host defaults/current child settings remain authoritative.
- Host failures are text/dynamic and may timeout or return no receipt. Raw host errors are not durable; they map to bounded internal codes and no automatic retry.
- `fork_thread(same-directory)` preserves the calling App task directory, not an arbitrary shell tool workdir. The design therefore records the host-provided task cwd and requires it, kernel `process.cwd()`, and the selected root/worktree to identify the same filesystem directory before any task call.
- Claude Desktop bundle inspection showed that its local-agent launch injects `CLAUDE_CODE_ENTRYPOINT=local-agent` and `CLAUDE_CODE_IS_COWORK=1`. The installed Claude Code 2.1.207 binary independently materializes an unset direct invocation entrypoint as `cli`, preserves `local-agent`, maps `cli/default` to `claude_code_cli`, and maps `local-agent` to `claude_code_local_agent`. Combined with execution-plane host assertion, this is the positive current-surface discriminator required by the operating contract. Conflicts remain null/manual; the environment values alone never enable Codex App automation.
- Current installed Claude CLI: `/Users/sungmin/.local/bin/claude`, version `2.1.207`; help supports `--model opus --effort xhigh`.
- Current Codex App process adapter was probed read-only with non-secret canaries. A non-PTY long-running process returned a session handle but `write_stdin` failed with `stdin is closed`; a default PTY echoed the canary in tool output; a PTY whose Node reader successfully called `process.stdin.setRawMode(true)` before emitting `READY` accepted the canary with zero echo and returned only its byte count. The design therefore records `pty-raw-noecho` only after a live canary handshake and requires every real input process to emit an exact no-echo READY before any host-derived value is written. No credential, task ID, project ID, or durable state was used or changed by this probe.
- Coupled Codex personal install/restart research matches the existing README contract: copy/place the candidate at `~/.codex/plugins/deep-loop`, bind `~/.agents/plugins/marketplace.json` with `source.path: "./.codex/plugins/deep-loop"`, select it under Work or Codex → Plugins, restart the App, then start a new task. On this machine the enabled install is currently cached `deep-loop@claude-deep-suite` 1.8.1 and the personal coupled path/file do not exist, so the future smoke requires an exact creation/backup/recovery proposal and separate approval; no install or restart was performed during Gate 1.

### Design selection and approval record

- Selected: transport-bound App attempt on the existing handoff lease, with a dedicated `app-task` state machine and CLI.
- Rejected: kernel invocation of App tools (2-plane violation), skill-only state (no durable at-most-once), and generic optional acquire flags (confirmation bypass/transport collision).
- User instruction on 2026-07-13: make the optimal judgment and continue autonomously to completion. This delegates design choice/approval; irreversible push/PR/merge and post-merge sync remain separately approval-gated by the operating contract.
- Main-agent design disposition for Claude surface evidence: the independent first-party launcher/classifier evidence above resolves direct Code vs Desktop local-agent. Conflicting/unsupported observations remain null/manual; Claude surfaces cannot enable Codex App automation.

### Pre-Opus adversarial design audit

These checks were independent Codex subagent audits used to harden the design before the required native Opus/xhigh gate. They do not replace Gate 1, and no receipt was reused after its target changed.

- Early draft prefixes `568ff1…`, `20858…`, and `b15dc…` were rejected in sequence for failure-phase ambiguity, raw thread-ID argv exposure, revoke/state-read leakage, missing live PTY no-echo READY proof, consent-question ordering, mode authority, init response-loss, and respawn precedence. Each finding was dispositioned in the next draft; the shortened hashes are recorded as historical prefixes only, not as review receipts.
- Exact `44c82c93aaca4d1f7d1248ffaff8ca72dc04600c18865ba43c9ed51276bb5f20`: rejected. The three audits found that the new App init did not share the real public `init-run`/exported `initRun` writer, status did not prove the exact request, a purported read-only status acquired a writing lock, no pre-question kernel cwd guard existed, and a state-only crash allowed another genesis.
- Exact intermediate `129d9d2558aead14b38901336a964a31fa18b9880739ad13cad049a26eb38d05` and `adab60f71defbd60616607cb9f29c1d49bd73f382bd7493e3630e28e20901fad`: review attempts were explicitly aborted when main-agent consistency fixes changed the target. No verdict was claimed.
- Exact `ddb70d53fab63380974934a41d629aa8f5af2291f51a19428fbd066cc9b7caba`: rejected. The audits identified the real `loop.json`→`.loop.hash` two-file crash window, unsafe TTL-only root lock semantics, a missing post-pending `already-initialized` path, and omitted git/plugin/session-spawn request projections.
- Exact `fa60b9c5f466a1862d3cc3e8f18e638eab622a1c2ca2b60fb0b1455be418cfbf`: review was stopped after additional consistency findings on atomic-write temp debris, root-lock candidate lifecycle, and committed-attempt precedence in the presence of a later foreign pending reservation.
- Exact `1732657373ac7aee2459583479c95f4489351eb01ce6f570270a7034a6d243db`: rejected. State audit found that acquire response-loss could misread a later released/recovered lease as current acquisition and that the initial generic-release wording broke the existing valid terminal cleanup contract. Contract audit separately found a two-reclaimer ABA race in automatic stale-lock deletion.
- Exact intermediate `8736a917af41090e8d8ec2303546cfb8ab4304288d5deef337fe46801be0b067`: review was aborted after the main agent found and corrected a paused-guard wording inconsistency; no verdict was claimed.
- Exact semantic candidate `943e0cb4e93e376d43a735f7a895588c5692ead7980ca6a6b88250f7dc787a5a`: three independent full-document, read-only audits converged without modifying the target.
  - `design_state_review`: APPROVE; Red 0, Yellow 0, Info 0; natural convergence. Rechecked init/pending/hash publication, exact acquire response-loss projection, public release precedence, recover/terminal/historical provenance, and current code.
  - `design_host_review`: READY; Red 0, Yellow 0, Info 0; natural convergence. Rechecked App READY/PTY raw-noecho behavior, raw ID/argv boundaries, public init compatibility, state publication, and release/acquire changes.
  - `design_contract_review`: APPROVE; Red 0, Yellow 0, Info 0; natural convergence. Rechecked every prior finding, fixed-lock `stale-manual` fail-closed semantics, two-stale-observer safety, accepted limit, and handoff/current-code compatibility.
- Staging hygiene then removed exactly two ASCII spaces from each of design lines 3–5 so `git diff --check` would pass. This changed the exact target and invalidated the prior byte receipt even though it did not change meaning.
- Exact committed-review target `6326be15b332ab3892633705138a91a0c47516460a6feddc22abe6c784e22a41` (100,329 bytes): all three auditors independently verified that adding those exact six `0x20` bytes in memory reproduces `943e0cb4…` (100,335 bytes), with no insertion, substitution, or other deletion. Each reissued APPROVE/READY with Red 0, Yellow 0, Info 0 and natural convergence for the new exact target. The reviewers did not modify either file or the index.

Main-agent judgment: all material pre-gate findings are represented in the final design and its explicit tests. In particular, all production genesis writers share one request/current transaction; genesis state publishes hash-first/state-last; the fixed authority lock has no unsafe automatic stale reclaim; exact response-loss status binds attempt, previous current, request, and observation; and App acquire/release idempotency preserves existing terminal cleanup behavior. The final exact design hash is `6326be15b332ab3892633705138a91a0c47516460a6feddc22abe6c784e22a41`; `git diff --check` passes. This is sufficient to commit the target for the required native Opus/xhigh Gate 1 review, not to pass Gate 1 itself.

### Official Gate 1 review receipt

- gate: Gate 1 — research and design
- artifact/scope: `docs/superpowers/specs/2026-07-13-codex-app-native-task-continuation-design.md` was the primary artifact; the operating handoff and this evidence log were context. No implementation code was in scope.
- base/head or content hash: base `c38a96137f8f4f0099c35e893860930e8ee4cf73`; reviewed head `4fd9c256fd07a65ffe6812081f9c692a039cdc7b`; exact design SHA-256 `6326be15b332ab3892633705138a91a0c47516460a6feddc22abe6c784e22a41`.
- invocation: native interactive Claude session `b64a75d8-1324-42e8-a2ec-5a737c1b5fc6` (`deep-loop-gate1-design-review`) launched as `/Users/sungmin/.local/bin/claude --session-id b64a75d8-1324-42e8-a2ec-5a737c1b5fc6 --name deep-loop-gate1-design-review --model opus --effort xhigh`, followed by `/deep-review-loop --no-codex --no-agy --max=5 --contract`.
- reviewer actual: one `deep-review:code-reviewer` reviewer, agent ID `a5693a65d86aa013d`; `N_planned = N_actual = 1`; Codex and agy were disabled.
- model/effort evidence: the native TUI banner showed `Opus 4.8 with xhigh effort · Claude Max`; both the parent and reviewer transcript records identify `message.model` as `claude-opus-4-8`. Xhigh is evidenced by the literal native launcher argument and TUI banner, not inferred from a bridge or wrapper.
- verdict: `APPROVE` (single-reviewer)
- red/yellow/info: `0 / 0 / 2`
- termination: §3.A.1 natural convergence after round 1 of 5. There was no max-round, degraded, timeout, reviewer failure, or orchestration-failure termination; the native session then exited normally with status 0.
- report path: `.deep-review/reports/2026-07-14-024859-review.md`, SHA-256 `f44ab5576c8046fc036fa05527ea409652cb24d48bdb892c521c0b218f245aec`.
- loop summary path: `.deep-review/responses/2026-07-14-024922-loop-summary.md`, SHA-256 `b6a3104f4db4749c94c67ab224b9f038f7702f4e5566d29026bea0216304e18c`.
- verification commands: `shasum -a 256` over the design, report, and loop summary; `jq -c 'select((.message.model? // "") != "") | {type,model:.message.model}'` over the parent and reviewer JSONL transcripts; `git status --short --branch`; and direct reads of the report, summary, cited current source, and final design.

### Gate 1 advisory dispositions

1. `architecture/scope` — **ACCEPTED AND TRACKED.** The genesis transaction rewrite is explicitly in scope because response-loss-safe stdin initialization and one public initialization writer require it. Gate 3A will remain an isolated strict-TDD slice centered on `scripts/lib/init-transaction.mjs` and `tests/init-transaction.test.mjs`, with legacy byte/semantic compatibility coverage. It will not be co-batched with App host transport work.
2. `doc-accuracy/verification-note` — **ACCEPTED AND GATE-5-BLOCKING.** The `create_thread` and `send_message_to_thread` success parsers remain provisional and fail closed. Fixture tests cannot close this contract; Gate 5 cannot claim a verified happy path without the separately approved real Codex App create/send smoke and its actual receipts.
3. conceptual continuity carve-out — **ACCEPTED.** Under the user's explicit instruction to make the optimal design judgment and proceed autonomously, consent-gated App task creation is classified as respawn-style continuation, not an irreversible external action. The per-run consent boundary remains mandatory. Archive/delete, push/PR/merge, publish, marketplace/deep-suite synchronization, personal plugin installation, App restart, and real smoke remain separately approval-gated where the operating contract requires them.

Main-agent judgment: I independently re-read the final report and loop summary, checked the cited current source and transcript model fields, and rehashed the exact design after the native review. The review's two advisory findings are accurate and fully dispositioned above; the conceptual carve-out is consistent with the operating contract and the user's delegated design judgment. The reviewed artifact remained byte-identical at `6326be15b332ab3892633705138a91a0c47516460a6feddc22abe6c784e22a41`. Gate 1 therefore passes and Gate 2 planning may begin.

### Gate 1 target invalidation — 2026-07-14

The official receipt above remains historical evidence for exact design SHA-256
`6326be15b332ab3892633705138a91a0c47516460a6feddc22abe6c784e22a41`, but it is no longer a current
gate pass. Subsequent plan self-audit found that a generic same-owner lease reacquire could advance
the lease generation while leaving a previously positive host surface able to authorize App work.
The design was therefore changed to add kernel-owned `observed_generation`, generation-bound
re-attestation, stale-surface human-only fallback, current-generation live-binding validation, and
host-observation event/state cross-log proof. Per the gate contract, any design-byte change
invalidates the prior receipt regardless of whether it strengthens the design. A fresh Codex-only
`gpt-5.6-sol`/high naturally converged review of the new exact hash is required before Gate 1 can return
to PASS; Gate 2's prior review, if any, is likewise unusable after the corresponding plan changes.
Continued pre-review audit also added a single verified-snapshot boundary, global finish/recovery
correlation, and a continuous generic/App lease-acquisition lineage so raw generation changes,
same-generation owner swaps, disconnected edges, and pre-proof acquire events cannot historicalize
live failure/recovery authority. These bytes are part of the same replacement Gate 1 target and have
no inherited approval from the historical receipt.

### Replacement Gate 1 candidate preparation — 2026-07-15

- review contract override: the user's latest instruction replaces the old Opus/xhigh reviewer choice
  with Codex-only `gpt-5.6-sol` at `high`. The deep-review-loop remains bounded at five Review rounds
  and passes only on natural `APPROVE` with Red 0 and Yellow 0. No global Codex configuration was
  changed.
- model/effort preflight: `/opt/homebrew/bin/codex exec --ephemeral --ignore-user-config
  --ignore-rules -s read-only -m gpt-5.6-sol -c 'model_reasoning_effort="high"' --json ...`
  exited 0 in thread `019f6131-6cd5-7373-8b7f-fa3c109d2cca` and returned exactly
  `MODEL_EFFORT_OK`. The live Codex App tool declarations independently list `gpt-5.6-sol` with
  supported efforts including `high`.
- target base/head before the review-target commit: base
  `c38a96137f8f4f0099c35e893860930e8ee4cf73`; current head
  `c2a5bc1a36514d370f855386a3b8afa4b2c80173`; branch
  `codex/codex-app-native-task-continuation`; ahead 3 and behind 0 relative to `origin/main`.
- exact Gate 1 design SHA-256: `02dcb8e896d5b31abab396e65b36cdee695703499dab19916ca4b4b5469382f3`.
- exact Gate 2 plan SHA-256 for audit context only (the plan is not part of the Gate 1 review target):
  `d7961afaaf2b4769b548f069394740c7323f65775ea713bbc5dbde519a690f00`.
- full repository verification: `npm run preflight` exited 0; validation returned `ok`; Node reported
  1,463 tests, 1,463 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo.
- executable plan validator: PASS with 45 tasks and exact fence counts `text=9`, `js=154`,
  `bash=61`, `diff=63`, `json=4`, `markdown=12`, `yaml=1`. `git diff --check` and the ignored
  plan's no-index whitespace check both passed.
- behavioral verifier probes: extracted `verifyAppEventCorrelation` accepted genesis, valid generic
  lineage, mixed generic-to-App lineage, current recovery, recovery followed by a real acquire, and
  exact finish. It rejected a raw numeric generation bump, same-generation owner swap, disconnected
  edge, missing App immediate parent, acquire-before-recovery laundering, and acquire after finish.
- live App contract revalidation: `list_projects` remains the discovery prerequisite for local
  `create_thread`; local/project work requires a local or worktree target; `fork_thread` defaults to
  same-directory and copies completed history only; `send_message_to_thread` preserves child settings
  when model/thinking are omitted. No task tool was called during this read-only contract check.
- pre-review main-agent audit: the design/plan now agree on one verified snapshot boundary, global
  finish/recovery correlation, exact generic/App lease-acquisition lineage, shared terminal fixture
  migration, and the Task 7B-before-7C writer ordering. Outstanding P0/P1 findings: 0. This prepares
  an exact review target; it does not pass Gate 1.

## Review receipt template

Each reviewed gate will add a receipt with all of these fields:

```text
gate:
artifact/scope:
base/head or content hash:
invocation:
reviewer actual:
model/effort evidence:
verdict:
red/yellow/info:
termination:
report path:
verification commands:
main-agent judgment:
```
