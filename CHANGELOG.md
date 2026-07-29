# Changelog

All notable changes to deep-loop are documented in this file.

> Note: the `[1.1.0]`/`[1.2.0]` entries pre-date this changelog file (a known lag between
> `plugin.json.version` and the changelog); this release does not retro-fill them.

## [1.13.1] — 2026-07-29

### Fixed

- **부모 디렉터리가 사라진 `replace-unlinked` 를 fail-stop 한다** (`replace-unlinked parent missing`).
  `replace-intent` marker 는 대상 파일이 디스크에 있을 때만 기록되므로 그 시점에 부모 디렉터리도
  존재했고, publisher 는 leaf 파일만 unlink 하며 디렉터리는 지우지 않는다. 따라서 부모가 사라진
  `replace-unlinked` 는 publisher 가 만들 수 없는 상태다. 그것을 분류가 그대로 통과시키면 발행이
  `ensureStrictDirectory` 로 디렉터리를 되만들어 이번 manifest 의 target 만 복원하고, 같은 디렉터리에
  있던 **매니페스트 밖 파일들은 조용히 유실**된 채 publication 이 성공을 보고한다. 1.13.0 의 완료-frontier
  규칙은 이 vector 가 미완 target **뒤에** 올 때는 이미 거부했다(`replace-intent` 가 진행 증거이므로);
  남아 있던 공백은 그것이 **첫 target** 일 때였다. 외부 간섭이나 파일시스템 유실 없이는 도달하지 않는
  탐지 공백이며, 발행되는 artifact 자체는 이전에도 바이트 검증됐다.

## [1.13.0] — 2026-07-29

### Added

- **acquire↔resume public 계약.** `lease acquire` 계열의 **모든** 반환 객체가 `proceed` / `consumed` /
  `replayed` 세 필드를 항상 싣는다. `proceed`는 단일 파생 규칙(`ok === true && reason === 'acquired'`)이라
  경로별 분기가 없고, 멱등 `already-owned`는 `ok:true`이면서 `proceed:false`다 — 이전에는 소비자가
  "인수에 성공했는가"와 "진행해도 되는가"를 구분할 방법이 없었다. 소비자는 **`proceed`만** 보고 진행을
  판단하고, `replayed`는 관측·감사용이다.
- **소비 영수증 `session_chain.lease.acquisition_receipt`.** 모든 성공 acquire가 남긴다(예약 없는 인수도
  `takeover_kind: 'released-takeover'`로 기록하며, 그 경우 응답의 `consumed`는 `null`이다). 영수증은
  응답 `consumed`의 상위집합이므로 replay 응답 구성이 필드 복사이고 파생 규칙이 없다. lease에 두므로
  세션 엔트리가 없는 fresh owner도 대상이다.
- **`lease acquire --attempt-id <token>`** (optional, `^[A-Za-z0-9_-]{8,128}$`, 위반 시 exit 1).
  응답을 잃고 살아 있는 호출자가 **같은 값으로 재호출**하면 커널이 `{proceed:true, replayed:true}`를
  재발급한다 — 사람 개입 없이 진행 권한을 회복한다. **호출 전에 durable하게 남기는 것이 규약**이며
  (생성 → 영속화 → acquire), 호출 후 기록은 amnesiac 창을 남기므로 금지한다. replay는 무변이다.
- **`resume-command`의 acquired 브랜치.** 소비 이후에도 예약이 정확히 한 번 소비됐음을 검증할 수 있다
  (영수증 파생, read-only). 첫 줄은 **비실행 마커**라 레거시 소비자가 `already-owned`를 성공으로
  오인할 표면을 만들지 않는다. 일반 재획득·stale 영수증은 절대 consumed로 표출되지 않는다.
- **`pause --now`** (optional) — 다른 verb와 같은 결정론적 시간 주입.
- **conformance fixture `tests/fixtures/acquire-resume-conformance.json`** — 6개 ordering
  (raw-first / wrapper-first / duplicate / stale-invocation / lost-ack / principal-death)을
  public CLI + 원시 파일 op만으로 재생하는 zero-dep 선언. 외부 소비자가 자기 transport 아래에서
  같은 seed·steps를 재생해 `{exit, ok, reason, proceed}`와 `final`을 대조할 수 있다.
  **재생 규칙:** `now_binding`대로 `$T0`/`$T1`/`$T2`를 **재생 시점 기준 상대 오프셋**으로 바인딩한다 —
  recovery safety 판정이 lock 안에서 실제 clock을 샘플하며 주입할 수 없어, 절대 시각에 고정하면 재생
  시점에 따라 결과가 갈린다.

### Fixed

- **2세대 이상 boundary handoff가 동작한다.** boundary emit의 writer들이 lineage/topology에 논리
  `run_id`를 기록하는데 검증자들은 전부 **현재 owner**(이번 boundary에서 superseded되는 세션)를
  요구했다. 1세대에서만 두 값이 우연히 같아 동작했고, 2세대 emit은 publication topology 검증에서
  반드시 거부되며 prepared 저널이 남았다. 이제 lineage는 `expect.owner`에 바인딩되고 **라우팅
  정체성(논리 `run_id`)은 불변**이다 — run 디렉터리, `--run-id`, descriptor의 `parentRunId`,
  M3 envelope 체계는 그대로다. 1세대 기록·검증은 바이트 동일하다.

### Changed

- `deep-loop-resume` / `handoff-respawn` / `deep-loop-workflow` 문언이 **`proceed:true` 뒤에만
  승격**하도록 바뀌었고, attempt id 사전 영속화 규약과 `Status: consumed` 처리(같은-attempt replay
  예외 포함), 위임-전 사전 acquire 오용 시 fenced preserve-pause 복구를 명시한다.

### Known limitations

- **§6 수정 이전 binary로 2세대 boundary emit을 시도해 stranded prepared journal이 남은 run**은 이후
  모든 reconciled read/mutation이 fail-stop한다. 이 릴리스는 그런 run에 대한 **커널 복구 경로도 승인된
  수동 절차도 제공하지 않는다** — 안전한 절차가 커널이 제공하지 않는 프리미티브(유지 가능한 maintenance
  lock)를 요구하기 때문이다. 이 저장소의 run 중 boundary handoff를 수행한 것은 0개이므로 현재 그런 run은
  없고, 수정 이후에는 새로 발생하지 않는다. 발생 시 해당 run을 폐기하거나 사례별로 사람이 판단한다.
- **affinity recovery / root recovery 경로는 `--attempt-id`를 받지 않는다.** 두 경로의 duplicate는
  멱등이 아니어서 replay 분기가 없다. 다만 duplicate 응답은 서로 다르다 — `recovery acquire`는
  `LEASE_FENCED: generation-mismatch`(exit 3), `root recovery acquire`는 영수증 증명이 먼저 실패해
  `ROOT_OPERATION_PROOF_INVALID`(**exit 1**, fence가 아니므로 exit-3 경로가 아니다)다. 그 두 경로에서 응답이 유실되면
  `resume-command`의 `Recovery: consumed` **사후 관측**만 가능하고 이는 진행 권한의 재발급이 아니다 —
  사람 개입이 필요하다.

## [1.12.0] — 2026-07-26

### Fixed

- **workstream-session 신규 run 전면 차단 해소.** `computeDebt`가 부채를 **정착된(`done`) maker**
  기준으로 산출한다. 이전에는 `episode new`가 `episodes_total`을 즉시 올려, 첫 maker가 만들어지는 순간
  `debt_ratio = 1.0`이 되어 **그 maker 자신의 dispatch가 막혔다** — 차단 원인이 차단 대상 자신인
  자기참조였다. `debt_ratio`의 의미가 바뀐다: pending/in_progress episode는 더 이상 부채가 아니다.
  durable 카운터(`episodes_total` / `episodes_human_reviewed`)는 감사 원본으로 남으며 이 판정에
  쓰이지 않는다.
- **커널이 지시한 remedy가 거부되던 데드락 2종.** (1) orphan maker의 `episode abandon --confirm`이
  미바인딩 owner scope에서 거부되던 것, (2) 정착된 maker의 human ack이 owner의 workstream 밖이라는
  이유로 거부되던 것 — 게이트는 run 전역인데 remedy만 scope에 갇혀 있었다.
- **복구/호환 상태의 review scope 판정을 방어적으로 강화했다.** 미바인딩 owner가 남아 있는 상태에서는
  checker 라이프사이클이 target maker의 workstream을 기준으로 scope를 판정한다. 이는 정상 handoff가
  미리뷰 `done` maker를 남긴 채 이 상태로 전이한다는 보장이 아니며, review import는 계속 준비된
  claim의 lease owner/generation 일치를 강제한다.
- **`comprehension-debt` action이 실제 ack 대상을 싣는다** — `blocking_episode_ids`. 기존
  `episode_id`는 debt 때문에 *막힌* episode였고 그것을 ack해도 게이트가 풀리지 않아, remedy가
  descriptor에서 발견 불가능했다.
- **workstream 없는 maker의 `done` 기록을 거부한다**(`WORKSTREAM_REQUIRED`). 그 상태는 remedy가 없는
  `unbound-proof-episode` dead-end를 만든다 — `abandonEpisode`는 done을 거부하고 ack은 라우팅을
  바꾸지 못한다. 신규 발생을 차단하며, 기존 사례의 복구는 백로그다.
- **`done` 전이 시 선행 리뷰 크레딧을 무효화한다.** maker가 정착되기 전에 기록된
  `human_reviewed` / `agent_reviewed`는 아직 존재하지 않던 diff에 대한 것이므로 지워지고 카운터가
  감산된다.

### Changed

- Execution plane 4개 스킬이 새 게이트 의미에 맞춰졌다. `deep-loop-discover`는 `>=` 경계와
  settled-maker 기준을 명시하고, `deep-loop-ack`은 `human_reviewed`가 **`true`가 아닌**(속성 부재
  포함) done maker를 대상으로 하며, `deep-loop-status`는 실시간 게이트 값과 durable 카운터를 각각
  `comprehension status`와 `state get --field comprehension`에서 읽고, `deep-loop-continue`는
  `action.blocking_episode_ids`를 remedy로 제시한다.
- `CLAUDE.md` 불변식 8에 게이트 발화 조건(정착된 미리뷰 maker 존재)이 명시됐다.

### Migration

- **v1.12.0 이전에 시작된 run**에서, maker가 `done`이 되기 **전에** 기록된 사람 ack은 그 maker의 실제
  산출물에 대한 검토가 아닐 수 있다. 이번 릴리스는 **이후의** done 전이부터 그 크레딧을 무효화하므로,
  업그레이드 시점에 이미 `done`인 에피소드의 크레딧은 그대로 남는다. 해당 run에서는 `done` maker를
  한 번 재검토할 것을 권한다. 선-ack과 정상 ack을 구분하는 정보는 event-log 순서에만 있고
  `computeDebt`도 마이그레이션도 그것을 보지 못하므로, 자동 정리는 백로그로 남겼다. 이 고지는
  `workstream-session` run에도 해당한다.
- 기존 플러그인 캐시를 쓰는 세션은 재설치/캐시 갱신 전까지 계속 이전 동작을 만난다.

## [1.11.0] — 2026-07-24

Workstream-scoped session continuity release. New runs keep one Workstream in one session across
context compaction and rotate only after a proof-derived Workstream terminal boundary.

### Added
- **First-class compact continuation** — `/deep-loop-compact` and
  `$deep-loop:deep-loop-compact` checkpoint and restore the current Workstream on Claude Code and
  Codex without changing lease ownership or creating a new session.
- **Compact-source restore hook** — `SessionStart` restores bounded checkpoint context only for the
  `compact` source; `PreCompact` remains shell-free, emit-only, and best-effort.
- **Durable Workstream session scopes** — schema `0.4.0` records open/closed affinity, exact terminal
  event identity, boundary handoff topology, and project-root recovery capsules.

### Changed
- New runs require `workstream-session`; older `0.2.0` and `0.3.0` state migrates to an explicit
  legacy policy and cannot silently gain the new rotation semantics.
- Attended non-headless surfaces no longer open a new session by default. Visible launch remains an
  explicit, durable human approval, while unattended continuation keeps measured fail-closed gates.
- Windows durable writes use writable file handles for file flushes, tolerate only documented
  unsupported directory-flush errors, and canonicalize lock and journal paths consistently.
- Claude Code and Codex manifests, npm metadata, generated docs, schemas, and release integration
  guidance are synchronized at `1.11.0`.

## [1.10.0] — 2026-07-21

Per-runtime continuation policy release. The change applies to newly initialized runs; existing
`0.2.0` runs migrate in memory to the legacy `rotate-per-unit` behavior and persist schema `0.3.0`
on their next business mutation. There are no breaking CLI changes.

### Added
- **Runtime-specific attended continuation** — new runs persist
  `autonomy.continuation_policy`: Claude defaults to `compact-in-place`, keeping related work in the
  same session, while Codex defaults to milestone-bounded `rotate-per-unit`. Unattended invocations
  still preempt both policies through the measured, fail-closed headless path.
- **Compaction checkpoint and restore safety net** — attended Claude PreCompact writes bounded,
  freshness-bound checkpoints without changing `loop.json`; SessionStart(`compact`) injects a
  bounded restore, recovery, or rotation capsule. Hooks remain shell-free, emit-only, best-effort,
  and never spawn or block compaction/session start.
- **First-class manual continuation** — runtime-aware `resume-command`, durable handoff artifacts,
  and documented `/deep-loop-resume` / `$deep-loop:deep-loop-resume` paths remain authoritative when
  plugin lifecycle hooks are absent, unsupported by the host version, or not trusted.
- **Human-approved tmux launcher** — POSIX visible continuation can open a new tmux window only after
  canonical executable approval plus exact socket/server-PID verification, with identity checks on
  both sides of the spawned CAS and fail-closed rollback after a post-CAS drift.

### Changed
- `next-action` keeps the real work action for attended Claude at the per-session turn cap and adds
  compaction advice instead of replacing the action; milestone consumption prevents repeated
  rotation on the same terminal event.
- Codex bundled PreCompact/SessionStart hooks are documented as a trust-reviewed, host-version-
  dependent safety net with graceful absence; manual resume remains an officially supported path.
- Claude and Codex plugin manifests are versioned `1.10.0`; the durable run schema is independently
  versioned `0.3.0`.

### Rejected / Deferred
- **PostCompact hook** — deferred as observation-only value (YAGNI).
- **Mid-run continuation-policy switching** — explicit `/deep-loop-handoff` already covers an
  immediate rotation request.
- **`codex exec resume <id>` / `--last`** — conflicts with fresh-context handoff and lacks a robust
  non-interactive session-ID extraction contract.
- **Claude Agent SDK / Codex SDK** — rejected because external npm packages violate the
  zero-dependency invariant; documented `claude -p` and `codex exec` transports remain sufficient.
- **Additional launchers and an external supervisor** — deferred as out of scope and maintenance-
  heavy; the officially supported manual path covers unsupported terminals.

## [1.8.0] — 2026-07-12

Dual-runtime and native Windows compatibility release.

### Added
- **Claude Code + Codex execution surfaces** — the same plugin now exposes portable skills and
  invocation contracts for Claude Code, Codex CLI, and Codex App while preserving the deterministic
  kernel boundary and independent checker gates.
- **Native Windows runtime support** — process execution, runtime discovery, handoff descriptors,
  and respawn paths now support Windows directly, including fail-closed executable authority and
  explicit desktop continuation behavior.

### Changed
- Synchronized the Claude and Codex plugin manifests and npm package at release version `1.8.0`;
  the durable loop-state schema remains independently pinned at `0.2.0`.

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
  archive]` recipe triggered by "hill-climb" / "hill climbing" / "하네스 개선" / "루프 개선" / "환류"
  (a bare "harness" trigger was dropped in review — it misrouted ordinary goals); the `validate`
  subcommand now also validates the ledger's shape and every `recipes/*.json` (fail-closed).
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
