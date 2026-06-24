# deep-loop v1 설계 스펙

작성일: 2026-06-24
상태: 승인됨 (brainstorming → spec)
선행 문서:
- `docs/research/deep-loop-loop-engineering-prompt.md` (초기 v0.1 구상)
- `docs/research/deep-loop-vs-loop-engineering-analysis.md` (간극/강점 분석)
- `docs/research/deep-loop-faithful-implementation-design.md` (충실 구현 방향)
철학: Addy Osmani, **Loop Engineering**[^addy] — "Build the loop. But build it like someone who intends to **stay the engineer**."

[^addy]: https://addyosmani.com/blog/loop-engineering/

---

## 0. 목표 (한 줄)

Loop Engineering 철학 — *작은 시스템이 다음 일을 발견·분배·실행요청·검증·기록·결정하고, 사람을 사이클 사이에서 제거하되 검증에서는 제거하지 않는다* — 을 **deep-suite 위의 cross-plugin 오케스트레이션 control plane**으로 실현하는 독립 Claude Code/Codex 플러그인 `deep-loop`.

핵심 차별점 (요구사항):
1. 설계 확정 시 loop engineering대로 진행하되, 설계가 불명확하면 명료화한다. 프로토콜은 superpowers / deep-work를 참고하되 더 나은 하네스를 구성할 수 있으면 그렇게 한다.
2. context window가 차거나 마일스톤 통과 시 **사람 개입 없이 새 세션으로 자동 인수**하여 작업을 잇는다.
3. 작업 종료 시 deep-memory에 기록하고 deep-wiki로 정리한다 (각 플러그인 미설치 시 스킵).
4. deep-suite marketplace에 포함되되, 명시적 연동이 아니면 **독립 동작**한다. 런타임에 superpowers 프로토콜이든 deep-suite 프로토콜이든 선택 가능.

---

## 1. 아키텍처 — 2-plane 엄격 분리

```
┌──────────────────────── EXECUTION PLANE (LLM) ────────────────────────┐
│ skills/ (SKILL.md)        판단: Discover · Triage · Decompose · Decide │
│ protocol adapters         deep-work / superpowers / standalone        │
│   │ 오직 커널 CLI로만 상태 변경 (loop.json 직접 쓰기 금지)             │
└───┼────────────────────────────────────────────────────────────────────┘
    │  node scripts/deep-loop.mjs <subcommand>   (CLI 계약 = 유일한 경계)
┌───▼──────────────────── CONTROL PLANE (Node, 결정론) ──────────────────┐
│ scripts/deep-loop.mjs + scripts/lib/*.mjs                              │
│ state(lock)·budget·breaker·comprehension·schema·handoff·respawn·workspace│
│   → 안전 게이트가 협조적 CLI 경로 내 단일 변경 경계에 박힘 (한계 §1.2)  │
└────────────────────────────────────────────────────────────────────────┘
    │ writes (atomic temp+rename, M3 envelope)
 .deep-loop/runs/<run-id>/  loop.json · event-log.jsonl · episodes/ · handoffs/
```

**불변식 (아키텍처 결정):** Execution plane은 상태를 **읽고**, 변경은 Control plane CLI를 통하는 것을 **규약**으로 한다. 협조적 에이전트 하에서 예산·circuit breaker·comprehension·respawn 게이트는 단일 통로로 일관 적용된다. 단 이는 *적대자에 대한 봉인*이 아니라 *협조적 에이전트에 대한 단일 변경 통로 + drift 탐지*다 (한계·위협 모델은 §1.2).

**엔진 = 하이브리드:** 안전·정확성이 중요한 부분(loop.json lock-safe 변경, 예산 JSONL 집계, breaker, 스키마 검증, handoff/respawn 기계장치)은 결정론적 Node. 판단(discover/triage/decompose/decide/protocol routing)은 LLM SKILL.

### 1.1 커널↔Execution 계약 — 커널은 LLM 스킬을 호출하지 않는다 (cross-model 리뷰 정정)

Claude Code에서 **스킬은 LLM-facing 지시문이지 Node가 호출 가능한 함수가 아니다.** 따라서 Control plane 커널은 sibling 스킬(`deep-work:...`)을 직접 dispatch하거나 결과를 폴링하지 **못한다.** 계약:
- 커널 subcommand는 **상태를 변경/검증하고 `next_action` 디스크립터 + 게이트 판정(allowed/blocked+reason)을 반환**한다. 판단·dispatch는 하지 않는다.
- **Execution plane LLM**(현재 실행 중인 스킬, 예: `/deep-loop-continue`)이 `next_action`을 읽고 **실제 dispatch를 수행**한다 — `Skill()` 도구로 sibling을 invoke하거나, 사용자/headless 드라이버에게 명령을 제시.
- **Headless 자율 모드**에서만 커널이 실제 **subprocess**(`claude -p --plugin-dir … --output-schema … --permission-mode … <timeout>`)를 spawn해 Execution 스킬을 돌린다. Node가 에이전트를 "실행"하는 유일한 지점이며 함수 호출이 아니라 프로세스 경계다.

→ `tick --mode advance|full`은 스스로 Discover/Triage/Decide를 수행하지 않는다. (a) 인터랙티브: `next_action` 반환 → LLM 실행, (b) headless: `claude -p` 프로세스 spawn → 그 안에서 스킬 실행.

### 1.2 위협 모델 & 강제 가능성 (정직한 한계 — Codex 라운드2 🔴1)

**위협 모델 = 협조적이지만 fallible한 에이전트.** Execution LLM은 우리가 *오케스트레이션하는 대상*이지 *방어해야 할 적대자*가 아니다. 현실적 실패 양상은 drift·환각·지름길·부분쓰기·세션 간 불일치이지, "모든 무결성 anchor를 일관되게 위조하는 의도적 공격"이 아니다.

따라서 deep-loop의 무결성 계층은 **drift/사고/부분손상 탐지 + fail-stop**을 목표로 한다(암호학적 tamper-evidence가 아님):
- `event-log.jsonl`: append-only + per-event 스키마 검증 + 단조 증가 시퀀스 + 라인 체크섬. `budget.spent`는 로그 합산으로만 재계산, 합산≠저장값이면 fail-stop.
- 터미널 상태(episode `done`/`approved`, workstream `merged`, review `pass`)는 **커널이 proof artifact에서 파생**. **모든 mutating CLI 명령**(state patch만이 아니라 `episode record`/`workstream set`/`event append` 등)이 터미널-status·proof 규칙을 강제한다.
- `loop.json`은 매 변경 시 content hash를 envelope에 기록, 다음 읽기에서 검증 → 우발적/외부 직접 수정 탐지.
- 탐지 시 `status=paused` + needs-human.

**명시적 한계:** 무결성 anchor(체크섬·해시·시퀀스)는 Execution LLM이 쓸 수 있는 같은 파일시스템에 있으므로, **의도적으로 anchor까지 일관 위조하는 적대적 에이전트는 막지 못한다.** 그런 위협 모델이 필요하면 OS 강제 append-only 로그 또는 에이전트가 접근 못 하는 비밀키 MAC/외부 ledger가 필요하며, 이는 v1 범위 밖(v0.3+ 옵션)이다. v1은 "협조적 에이전트의 실수/drift를 탐지해 멈춘다"가 정직한 보장 수준이다.

---

## 2. 레포 구조

```
deep-loop/
  .claude-plugin/plugin.json        # deep-goal 형태 미러 (name/version/description/author/repository{type,url}/license/category/keywords)
  .codex-plugin/plugin.json         # 위 + skills:"./skills/" + interface 블록(displayName/short/long/category/capabilities/defaultPrompt)
  hooks/
    hooks.json                      # PreCompact 1개만
    scripts/precompact-handoff.sh   # → scripts/hooks-impl/precompact-handoff.mjs
  skills/
    deep-loop/SKILL.md              # 진입 (user-invocable:true, self-contained)
    deep-loop-workflow/SKILL.md     # 비공개(user-invocable:false), 무거운 로직 + references/*.md
    deep-loop-discover/SKILL.md
    deep-loop-triage/SKILL.md
    deep-loop-continue/SKILL.md     # 메인 tick
    deep-loop-handoff/SKILL.md
    deep-loop-resume/SKILL.md       # respawn된 새 세션 진입점
    deep-loop-status/SKILL.md
    deep-loop-ack/SKILL.md          # comprehension ledger
    deep-loop-finish/SKILL.md       # final-report + memory + wiki
  scripts/
    deep-loop.mjs                   # 커널 CLI 디스패처
    lib/
      state.mjs schema.mjs integrity.mjs budget.mjs breaker.mjs comprehension.mjs
      episode.mjs handoff.mjs respawn.mjs lease.mjs workspace.mjs adapters.mjs
      next-action.mjs detect.mjs envelope.mjs recipes.mjs review.mjs slug.mjs log.mjs
    hooks-impl/precompact-handoff.mjs
    verify-plugin.sh verify-selftest.sh
  recipes/
    robust-implementation.json autonomous-evolution.json ship-and-document.json
    review-fix-loop.json context-handoff-only.json triage-and-discovery.json
    automation/cron-morning-triage.yml github-actions-loop.yml
  protocols/
    deep-work.json superpowers.json standalone.json   # 선언적 어댑터 명세
  schemas/loop-run.schema.json
  tests/*.test.mjs
  docs/ README.md README.ko.md LICENSE package.json CHANGELOG.md
```

Node >= 20, `type: module`, 의존성 최소(YAML parser 회피 — durable state는 JSON). Bash 3.2 호환 hooks(`set -Eeuo pipefail`, `declare -A`/`${var,,}` 금지).

---

## 3. 명령어 (10개 사용자 스킬)

| 명령 | 역할 |
|---|---|
| `/deep-loop "goal"` | run 시작: detect→recipe/protocol→**리뷰 전략 질문(§7)**→**workstream 분해(§8)**→state 생성→첫 episode→다음 명령 출력 |
| `/deep-loop-discover` | 수동 heartbeat: repo/git/sibling artifact/기존 state에서 할 일 발견 |
| `/deep-loop-triage` | 후보를 actionable/needs_human/blocked/archived 분류 |
| `/deep-loop-continue` | **메인 tick**: 게이트검사→dispatch→isolate→verify→record→decide→필요 시 handoff+respawn |
| `/deep-loop-handoff` | 수동 handoff(+선택 respawn) — escape hatch |
| `/deep-loop-resume` | respawn된 새 세션 진입점: handoff.md+loop.json만 읽고 이어감 |
| `/deep-loop-status` | 상태·예산·debt·breaker·human-review·세션체인·workstream 표시 |
| `/deep-loop-ack` | 사람 검토 완료 표시 → comprehension debt 감소 |
| `/deep-loop-finish` | final-report → memory save → wiki ingest (설치 시) |

스킬 frontmatter: `name`, `description`(트리거 구문 포함, 한국어 구문 포함), `user-invocable`. 각 SKILL.md는 사용자 언어 감지·동일 언어 출력, 실패 시 fail-safe 복구, destructive/auto-push/auto-publish 금지, loop.json+handoff를 source of truth로, maker/checker 분리 유지 지침 포함.

---

## 4. Control plane 커널 CLI 계약

`node scripts/deep-loop.mjs <subcommand> [--json] [--no-color] [--project-root <p>] [--run-id <id>]`

| subcommand | 역할 | 게이트 |
|---|---|---|
| `init-run --goal --protocol --recipe --review <json>` | run 생성, `.deep-loop/runs/<id>/`, loop.json, `.deep-loop/current` | — |
| `detect-plugins` | sibling/superpowers/codex 설치 감지 → JSON | — |
| `recipe-match --goal` | 키워드로 recipe+protocol 결정론 매칭 (LLM은 **제안만**, 확정 변경은 사람 — `recipe_override_auth=user-only`, Codex r2 🟡4) | — |
| `state get [--field <path>]` | loop.json 읽기 | — |
| `state patch --field <path> --value <json>` | **화이트리스트 필드만** 변경 + 스키마 검증 | 필드 allowlist |
| `event append --type --data <json>` | event-log.jsonl atomic append | — |
| `budget record --turns N --tokens N` / `budget check` | 집계 / {ok, tier_after, reason} | — |
| `breaker check` / `breaker trip --reason` | 서킷브레이커 상태/발동 | — |
| `comprehension status` / `comprehension ack --episode <id>` | 이해부채 조회 / 검토표시 | — |
| `episode new --plugin --role --kind --point --workstream` | episode scaffold + request.md 골격 | — |
| `episode record --id --status --artifacts <json>` | 결과 기록 | — |
| `workstream new --title --branch --worktree` / `workstream set --id --status` | workstream 생성/상태 | — |
| `review dispatch --point <design\|plan\|implementation> --workstream <id>` | §7 리뷰 설정대로 checker episode 생성 | — |
| `handoff emit [--reason]` | handoff.md + compaction-state.json + launch-command.txt(전 OS), 세션 superseded, run_id 체인 증가 | — |
| `respawn [--headless]` | **새 세션 실행** | **budget+breaker+max-sessions 통과 필수** |
| `finish --status completed\|stopped` | final-report.md, status 전환 | completed는 proof 검증 |
| `validate` | loop.json 스키마 검증 | — |
| `next-action` | 현재 상태에서 다음 할 일 + 게이트 판정 반환 (**dispatch 안 함**, §1.1) | — |
| `lease acquire\|release\|check --owner <run_id> --generation <n>` | 세션 lease CAS (§9.1 fencing) | atomic |
| `tick --mode discover\|triage\|advance\|full` | headless 드라이버 전용: `claude -p` subprocess spawn해 Execution 스킬 실행(§1.1), 또는 `next-action` 반환. **스스로 판단 안 함** | tier 상한 |

**state-patch 화이트리스트 (안전 핵심) — 정정 (Codex 🔴1):**
- 스킬이 patch 가능 (**비-터미널 진행 상태만**): `discovered_items`, `triage.*`, `episodes[].status ∈ {pending,in_progress,blocked}`, `episodes[].result_*`(증거 첨부 필수), `decisions`, `active_workstreams`, `workstreams[].status ∈ {planned,in_progress,in_review,parked}` (parked=비-터미널 set-aside), `workstreams[].depends_on`
- **커널 전용 (스킬 변경 불가):**
  - **터미널 상태**: `episodes[].status ∈ {done,approved,rejected}`, `workstreams[].status ∈ {ready,merged,abandoned}`, review pass — **커널이 proof artifact(receipt/verdict)에서만 파생**. 스킬은 "done"을 직접 쓰지 못함
  - `review.*` — **init 후 immutable** (리뷰 게이트 무력화 방지). 변경은 사람 명시 `--reconfigure-review`로만
  - `budget.spent` / `budget.tokens_spent` — event-log 비용 이벤트에서만 재계산
  - `autonomy.tier` **상향** — 시작 플래그/사람만 (스킬은 하향만 가능)
  - `circuit_breaker.tripped = false` — 사람/외부 신호로만 해제
  - `session_chain.*`(lease 포함), `schema_version`, `termination.proofs`, `workstreams[].worktree`/`branch`/`base_commit`

→ "예산 다 썼다는 표시를 지우고 계속" 같은 LLM 우회를 코드로 불가능하게 만든다.

모든 deep-loop 산출물(loop.json 제외 receipt/handoff/compaction-state)은 **M3 envelope**(`producer:"deep-loop"`, ULID `run_id`, `parent_run_id` 체인, `provenance.source_artifacts`)로 감싸 deep-suite 상호운용성 유지. envelope 헬퍼는 deep-work `hooks/scripts/envelope.js`를 레퍼런스로 미러.

---

## 5. `loop.json` 스키마 (v0.2.0)

```jsonc
{
  "schema_version": "0.2.0",
  "run_id": "01J...ULID",
  "goal": "...", "status": "running",              // running|paused|completed|stopped
  "created_at": "...Z", "updated_at": "...Z",
  "project": { "root", "git": true, "branch", "head", "dirty": false },

  "routing": { "protocol": "deep-work", "selected_by": "auto" },   // auto|user|fallback
  "recipe":  { "id": "robust-implementation", "name", "reason" },
  "plugins_detected": { "deep-work": true, "deep-review": true, "codex": true, "...": false },

  "review": {                                       // §7 리뷰 전략
    "points": ["design","plan","implementation"],   // 기본 3개 전부 ON
    "reviewer": "deep-review-loop",                 // | codex-cross | subagent-checker | standalone
    "mode": "cross-model",                          // 사용자 선호 기본값
    "flags": ["--contract","--codex"],
    "converge": true, "max_review_rounds": 5,
    "require_human_ack": false        // true면 deep-review APPROVE만으로는 comprehension 카운트 ❌, /deep-loop-ack 필요
  },

  "autonomy": {
    "driver": "continue",                           // manual|continue|goal|loop|cron
    "tier": "recommend",                            // read-only|recommend|act-reversible|act-gated
    "auto_handoff": true,
    "spawn_style": "interactive",                   // interactive|headless
    "max_unreviewed_episodes": 3, "max_parallel": 2, "max_sessions": 8,
    "milestone_predicate": ["workstream_status_change","review_point_passed","per_session_turn_cap_reached"],  // §9 milestone 정의 (Codex 🟡7)
    "recipe_override_auth": "user-only",            // LLM은 recipe/protocol 제안만, 확정 변경은 사람 (Codex 🟡7)
    "unattended_detect": ["non-tty","driver:cron|loop","--unattended"]  // 이 중 하나면 unattended → headless 강제 (Codex r3 ℹ️2)
  },

  "budget": {
    "unit": "turns", "total": 200, "spent": 0,
    "tokens_total": 4000000, "tokens_spent": 0,     // 토큰 하드캡 (Codex 🔴4)
    "per_session_turn_cap": 40,                     // interactive: best-effort 선제 트리거 / headless: 프로세스 하드 한계
    "max_wallclock_sec": 86400,                     // run 전체 벽시계 천장 (커널이 respawn에서 강제, Codex r2 🔴2)
    "soft_stop_ratio": 0.8, "hard_stop_ratio": 1.0,
    "enforcement": "best-effort-interactive",       // interactive=best-effort(사람 감시) / headless=hard
    "unattended_requires_headless": true,           // auto_handoff + 미감시 → headless 강제 (하드캡/fail-closed)
    "on_unmeasurable_usage": "fail-closed",
    "on_exhaust": "pause-and-handoff"
  },

  "comprehension": {
    "episodes_total": 0, "episodes_human_reviewed": 0,
    "unreviewed_diff_lines": 0, "debt_ratio": 0, "debt_threshold": 0.5
  },
  "circuit_breaker": { "consecutive_request_changes": 0, "tripped": false, "trip_reason": null },

  "session_chain": {                                // §9.1 lease/fencing (Codex 🔴2)
    "parent_run_id": null,
    "lease": { "owner_run_id": "01J...", "generation": 1, "acquired_at": "...Z",
               "expires_at": "...Z", "state": "active",          // active|releasing|released
               "handoff_idempotency_key": null,                  // 트리거당 1개 (Decide·PreCompact 공유 → 이중 spawn 방지)
               "handoff_phase": "idle" },                         // idle|reserved|emitted|spawned|acquired (§9.1 상태기계, Codex r3 ℹ️3)
    "stale_lease_ttl_sec": 900,
    "sessions": [ { "run_id": "01J...", "started_at": "...", "ended_at": null, "turns": 0,
                    "outcome": null, "superseded_by": null } ]   // outcome: took_over|failed_launch|completed
  },

  "workspace_policy": "recommend",                  // none|recommend|required
  "workstreams": [ {
    "id": "ws-01-auth-core", "title": "Auth core",
    "status": "in_progress",                        // planned|in_progress|in_review|ready|merged|parked|abandoned
    "branch": "deep-loop/auth-core", "worktree": ".worktrees/dl/auth-core",
    "base_commit": "abc123", "dirty_on_handoff": false,
    "pr": { "intended": true, "state": "none", "url": null },   // none|draft|open|merged
    "episodes": ["001-deep-work","002-deep-review"], "review_points_done": ["design","plan"],
    "depends_on": []                                // §8.1 fan-in 의존 그래프 (Codex r2 🟡4)
  } ],
  "active_workstreams": ["ws-01-auth-core"],        // 동시 작업 ≤ max_parallel

  "discovered_items": [],
  "triage": { "actionable": [], "needs_human": [], "blocked": [], "archived": [] },
  "episodes": [ {
    "id": "001-deep-work", "plugin": "deep-work", "role": "maker", "kind": "implementation",
    "point": "implementation", "workstream_id": "ws-01-auth-core",
    "status": "pending",   // 스킬 patch: pending|in_progress|blocked / 커널 파생(터미널): done|approved|rejected (Codex 🟡7)
    "request_path": "...", "expected_artifacts": [ "..." ],
    "verification": { "checker_episode_required": true, "checker_plugin": "deep-review",
                      "review_point": "implementation", "proof_required": [ "..." ] },
    "worktree": { "recommended": true, "reason": "..." }
  } ],
  "current_episode": "001-deep-work",

  "connectors": { "enabled": [], "pre_authorized": [] },   // v0.3 예약, 스키마만 존재
  "termination": {
    "max_episodes_policy": "derived",   // 고정 8 금지 (Codex 🟡7). = Σ_workstreams (review.points 수 × (1+max_review_rounds) + maker 1)
    "max_episodes": 24,                 // 위 정책으로 산출된 상한(예시값)
    "proofs": [ "implementation artifacts exist",
    "independent review verdict approve or accepted concern", "final report exists",
    "human verification checklist written" ] }
}
```

**`comprehension.episodes_human_reviewed` 카운트 기준 (모호성 제거):** 한 episode는 다음 중 하나가 만족될 때 "human-reviewed"로 카운트된다 — (a) 사용자가 `/deep-loop-ack`로 해당 episode/diff를 명시 승인, 또는 (b) 해당 episode에 대해 deep-review **APPROVE** verdict가 기록됨(설정으로 끌 수 있음, 기본 ON). checker의 자동 APPROVE만으로 충분치 않다고 보려면 `review.require_human_ack=true`로 (a)만 인정. `debt_ratio = 1 - episodes_human_reviewed/episodes_total`.

---

## 6. Execution plane — 프로토콜 어댑터

`protocols/*.json`(선언) + `lib/adapters.mjs`(라우팅). 4-verb 인터페이스로 정규화:

```
dispatch(episodeBrief) → handle       maker 작업 시작
awaitResult(handle)    → resultRef     프로토콜 종료 상태까지 폴링
checker(resultRef)     → verdict       §7 review 설정대로 독립 검증
readArtifacts(resultRef) → {receipt, proofs}   공통 receipt 형태로 정규화
```

| verb | deep-work 어댑터 | superpowers 어댑터 | standalone 어댑터 |
|---|---|---|---|
| dispatch | `deep-work:deep-work-orchestrator` | `superpowers:writing-plans`→`subagent-driven-development` | 직접 도구 사용 |
| awaitResult | state file `current_phase=idle` 폴링 | per-task report 파일 | 인라인 |
| checker | §7 설정 (deep-review-loop / codex / 서브에이전트) | 동일 | 동일 |
| readArtifacts | `session-receipt.json` | task report + git log | 최소 receipt |

**중요 (§1.1, Codex 🔴3):** 이 4-verb는 **Execution plane LLM이 수행**한다 — `dispatch`는 LLM이 `Skill()`로 sibling을 invoke하거나 headless `claude -p`를 spawn하는 것이고, 커널은 어댑터 결과(receipt 경로)를 *기록*만 한다. `awaitResult` 폴링도 LLM/드라이버가 수행하고 커널은 상태만 검증한다. **커널이 sibling 스킬을 직접 함수처럼 호출하지 않는다.**

**프로토콜 선택:** `loop.json.routing.protocol`. 기본 = goal/recipe 키워드로 자동 감지(`recipe-match`), 사용자 `--protocol=superpowers` 명시 시 override, 둘 다 없으면 standalone 폴백. **리뷰 전략은 프로토콜과 직교** (checker가 `loop.json.review`를 읽음). `tier×protocol` 모순 조합 가드(예: `read-only`+superpowers는 writing-plans까지만, implementer dispatch 금지).

---

## 7. 리뷰 전략 (§A — run 시작 시 확인)

**리뷰 지점 = 설계 / 플랜 / 구현 3단계, 기본 전부 ON.** 각 지점에서 maker 산출물을 독립 checker episode가 검증.

| 지점 | maker 산출물 | checker |
|---|---|---|
| design | brainstorm/spec | 설계 리뷰 |
| plan | plan.md | 플랜 리뷰 |
| implementation | 코드+receipt | 코드 리뷰 |

**deep-review 있을 때 — 확인 질문:** 리뷰 지점(기본 3개) + 리뷰어 모드. 기본 추천 = `deep-review:deep-review-loop --contract --codex` (cross-model, 사용자 선호). REQUEST_CHANGES → fix episode 생성 후 재리뷰(수렴, `max_review_rounds`).

**deep-review 없을 때 — LLM 제안 → 확인:** cross-model 선호를 살림 → codex 플러그인 감지 시 Codex 2-way 교차 리뷰 추천 / 독립 Claude 서브에이전트 checker(maker 컨텍스트 비공유) / standalone 단일 모델.

`checker` verb가 이 설정을 읽어 dispatch하고 verdict(APPROVE/REQUEST_CHANGES)를 결정론 파싱해 Decide.

---

## 8. Multi-workstream 모델 (큰 작업 = 여러 PR)

큰 goal은 **workstream** 단위로 분해된다. 각 workstream = 하나의 **branch + worktree + 결국 1 PR** 경계.

**판단 vs 결정론 경계:**

| 결정 | 주체 | 시점 |
|---|---|---|
| goal을 몇 개 workstream/PR로 쪼갤지, 경계는 어디인지 | **LLM 판단** (큰 작업은 사람 확인) | Plan/Decompose |
| 작은 작업이면 1 workstream, 질문 없음 | LLM 판단 (자동) | 〃 |
| 각 workstream worktree/branch **생성·추적** | 결정론 (커널) | 분해 확정 후 |
| respawn 시 **모든 workstream worktree 인수** | 결정론 (고아화 절대 ❌) | 세션 전환 |

- workstream 내부: maker→checker→fix 순차 (각자 design/plan/impl 리뷰 게이트)
- workstream 간: 서로 다른 worktree라 **작업 디렉터리 경합은 0** (단 **머지 충돌·공유 API drift·순서 의존·통합 테스트 실패는 별개** — §8.1 fan-in 모델로 처리, Codex 🟡6). `max_parallel` + 미검토-episode breaker로 사람 리뷰 대역폭에 throttle
- 큰 분해 시 사람 확인: "N개 workstream(=PR)으로 제안: [...] [이대로/조정/단일 PR로]"

**worktree 연속성 (respawn):** 새 세션은 **항상** 이전 세션의 active worktree들을 그대로 인수한다. LLM이 매번 "이어받을까 새로 만들까" 판단하지 않는다 — fresh worktree를 만들면 진행 중인 미커밋 작업이 고아가 되기 때문. worktree는 디스크의 실제 디렉터리라 세션과 무관하게 보존되므로, 인수 = 새 세션이 같은 경로에서 작업을 잇는 것. 경로 소실 시 조용히 재생성하지 않고 **fail-safe → needs-human**.

**PR 생성 (정정 — 안전, Codex 🟡5):** draft PR 포함 **모든 외부 행동은 v1에서 proposal-only**. workstream이 `ready`가 되면 deep-loop은 PR을 *제안*하고 사람이 승인·생성. 자동 reversible 행동(draft PR 등)은 **v0.3 connector 레이어로 이관**(§16).

### 8.1 Fan-in / 통합 모델 (worktree는 머지 충돌을 막지 못한다 — Codex 🟡6)

병렬 workstream이 수렴할 때:
- `workstreams[].depends_on[]` — 선언적 의존 그래프. 의존 workstream은 선행 머지 후 진행.
- **base 동기화**: 각 worktree는 주기적으로 integration base(main 또는 통합 브랜치)로 rebase/sync. drift 감지 → needs-human.
- **통합 게이트**: 마지막에 통합 브랜치에서 cross-workstream 테스트 1회. **공유 계약(API/스키마) 변경 감지 시 자동 진행 중단 → 사람 에스컬레이션.**
- 머지 순서 = 의존 그래프 위상정렬. 충돌 시 needs-human.

---

## 9. 자율 핸드오프 / respawn (요구사항 #2)

compaction 의존을 폐기하고 **clean-handoff respawn**을 채택 — 오염된 트랜스크립트 요약 대신, 큐레이션된 handoff+loop.json만 읽는 fresh 세션이 이어간다 ("the agent forgets, the repo doesn't").

**handoff/respawn 로직은 커널 단일 구현, 호출자 3종:**
1. `/deep-loop-continue`의 Decide 단계 (자동, 주 경로): 마일스톤 통과 또는 `per_session_turn_cap` 도달 시 *깨끗한 상태에서* handoff+respawn
2. PreCompact hook (자동, 안전망): context 급증 시 compaction 직전 비상 handoff+respawn
3. `/deep-loop-handoff` 스킬 (수동, escape hatch)

**`/deep-loop-continue` 1 tick:**
```
1. budget check + breaker check + comprehension status   ← 커널, 항상 먼저
   └ 막히면 → handoff emit + status=paused → 사람 호출, 종료
2. 현재 episode 판정:
   - maker pending  → adapter.dispatch (또는 request.md 생성 후 사람/드라이버 실행)
   - maker done     → review point면 adapter.checker dispatch
   - checker verdict → APPROVE: 다음 / REQUEST_CHANGES: fix episode(+breaker++)
3. record (episode record, event append)
4. Decide: 마일스톤 통과 or per_session_turn_cap 도달?
   └ 예 → 선제 handoff emit + respawn (깨끗한 상태)
   └ 아니오 → 다음 episode 안내
```

**handoff emit 산출:** `handoffs/<ts>-next-session.md`(goal·recipe·protocol·완료/현재 episode·workstreams·triage·known artifacts·git·human review checklist·정확한 다음 프롬프트·"이전 대화 가정 금지") + `compaction-state.json`(M3) + `terminal/launch-command.txt`(전 OS) + `session_chain`에 새 ULID append + 이전 세션 `superseded_by` 마킹.

**respawn 게이트 순서 (통과 못 하면 paused):**
```
budget.spent < hard_stop?  →  breaker.tripped==false?  →  sessions < max_sessions?  →  auto_handoff?
   →  실행: spawn_style=interactive → claude -n / headless → claude -p
   →  실패 시: handoff만 남기고 사람 수동 resume 안내
```
**respawn은 acting tier로 게이팅하지 않는다.** respawn은 세션 연속(같은 작업을 새 세션에서 이어 *생각*)이지 외부 세계 변경이 아니다. 따라서 `read-only` run도 자율 respawn 가능하다. acting tier(`read-only`..`act-gated`)는 **오직 외부 행동**(push/PR/publish/merge/delete 등)만 게이팅한다. respawn 게이트 = `auto_handoff` 플래그 + budget + breaker + max_sessions 카운터.

**새 세션 진입 (예시, macOS):**
```bash
osascript -e 'tell application "Terminal" to do script "cd <root> && claude -n deep-loop-<run-id> \"Read .deep-loop/runs/<run-id>/handoffs/<ts>-next-session.md first; then run /deep-loop-resume\""'
```
(Windows `wt.exe`, `tmux`, headless `claude -p` 변형 포함.) 새 세션은 `/deep-loop-resume`으로 진입 → handoff.md+loop.json만 읽고 active worktree(들) attach. 동시 접근은 "superseded 필드"가 아니라 **세션 lease 프로토콜(§9.1)**로 막는다.

**예산 강제 수준 (정정, Codex 🔴4 / r2 🔴2):** 총 자율 spend의 하드 바운드를 다음과 같이 *분해*한다 — 한 군데서 못 막으면 다른 군데서 막는다:
- **respawn 천장 (커널 강제):** respawn은 커널 명령이므로, 매 respawn 게이트에서 `sessions < max_sessions` **그리고** `wallclock < max_wallclock_sec`를 커널이 강제한다. 둘 중 하나 초과 → spawn 거부 + paused. 따라서 **총 세션 수·총 시간은 LLM과 무관하게 하드 바운드.**
- **intra-session (인터랙티브):** 한 세션 *내부* burn은 deep-loop이 직접 바운드하지 않음을 **정직히 명시**. 대신 (a) Claude Code 자체 컨텍스트 한계 + (b) 사람 감시(인터랙티브는 사람이 새 터미널을 봄)가 바운드. `per_session_turn_cap`은 self-report 선제 트리거(best-effort).
- **미감시(unattended) 자율:** `auto_handoff=true`인데 사람이 안 보는 운용은 **headless(`claude -p`) 강제**(`unattended_requires_headless`). headless는 프로세스 timeout + usage 파싱으로 intra-session까지 하드 강제하고 **측정 불가 시 fail-closed(pause)**. → 진짜 무인 장기 실행은 headless 필수.

### 9.1 세션 lease / fencing 프로토콜 (Codex 🔴2)

"superseded 마킹"만으로는 실행 중인 프로세스를 펜싱하지 못한다(Continue↔PreCompact 경쟁, 이중 spawn, 자식이 부모 종료 전 시작, launch 실패 후 chain 오염). 따라서:
- **lease CAS**: `session_chain.lease = {owner_run_id, generation, expires_at, state}`. **읽기를 제외한 모든 커널 mutating write**는 `owner_run_id == self && generation` 확인 후에만 수행(불일치 → 거부). 획득은 lockfile + atomic rename으로 CAS.
- **handoff 단계 상태기계 (멱등키 선예약, Codex r2 🟡3):** 멱등키는 트리거 입력에서 **결정론적으로 파생**(`hash(run_id, owner_generation, trigger_reason)`)하고, handoff emit *이전에* CAS로 예약한다. 단계: `reserved → emitted → spawned → acquired`.
  - Decide와 PreCompact가 같은 키를 파생 → 먼저 `reserved`에 CAS 성공한 쪽만 진행, 다른 쪽은 no-op. **same-generation 부모 이중 호출도 reserve CAS에서 1회로 봉인.**
  - 자식이 lease를 잡으면 `acquired`. 같은 키 재진입은 현재 단계를 보고 멱등 처리(이미 spawned면 재-spawn 안 함).
- **부모 펜싱 + carve-out:** 부모는 `emitted` 직후 `lease.state=releasing`. 이후 부모는 **업무 상태 write를 거부**하되, **예외로 `lease release` / launch-failure 롤백** 두 전이만 허용(자기 lease 관리). 자식은 부모 lease가 `released`거나 `expires_at` 경과(stale TTL=900s) 전까지 acquire 대기.
- **세대 토큰**: 자식 acquire 시 `generation+1`. 늦게 깨어난 부모/중복 자식은 generation 불일치로 자동 무력화.
- **실패 모드 단일 출처 (두 경우 구분):**
  - **(A) respawn 게이트 차단**(budget/breaker/max-sessions/wallclock 초과): spawn 시도 안 함 → handoff만 남기고 `status=paused`, 사람 수동 resume. (멱등키 `emitted`에서 멈춤)
  - **(B) spawn 시도 후 launch 실패**: 자식 entry `outcome=failed_launch` 기록 + **lease를 부모로 롤백**(`releasing→active`, 멱등키 해제) → 부모가 계속하거나 paused. chain이 "인수한 적 없는 세션"을 기술하지 않게 함.

**PreCompact hook:** `hooks.json` PreCompact → `precompact-handoff.mjs` → 동일 `handoff emit(+respawn)`. 주 경로가 `per_session_turn_cap`(컨텍스트 한계보다 훨씬 낮게)이라 보통 compaction 전에 선제 전환됨. hook은 급증 대비 안전망.

---

## 10. Sibling dispatch / read 계약 (스캔 검증)

| sibling | dispatch | 읽어서 검증 | 식별 가드 |
|---|---|---|---|
| deep-work | `deep-work:deep-work-orchestrator "<task>" [--team --tdd=strict --no-branch]` | `.deep-work/{TASK}/session-receipt.json`(`current_phase=idle`+`finished_at`, `slices.completed/total`, `quality_score`, `outcome`) | `producer=deep-work && artifact_kind=session-receipt` |
| deep-review | `deep-review:deep-review-loop --contract [--codex]` (직접 `/deep-review` 금지) | `.deep-review/reports/*.md` set-diff 새 verdict, `recurring-findings.json` | severity count 결정론 파싱, `--source=pr` 거부 |
| deep-docs | `deep-docs:deep-docs scan\|garden\|audit` | `.deep-docs/last-scan.json`(`documents[].issues`, `gaps`) | 10분 TTL + `git.head` 일치 |
| deep-evolve | `deep-evolve:deep-evolve "<goal>" \| resume <id>` | `.deep-evolve/evolve-receipt.json`(`score_delta`, `kept_count`), `evolve-insights.json` | `parent_run_id` 체인 |
| deep-dashboard | `deep-dashboard:deep-harnessability [--suite]` | `.deep-dashboard/harnessability-report.json`(`grade`, `dimensions`) | 24h 신선도 |
| deep-memory | `deep-memory:deep-memory-harvest` + MCP `deep_memory_save` | `~/.deep-memory/cards/...` | privacy=local, global 자동승격 ❌ |
| deep-wiki | `deep-wiki:wiki-ingest <report-path>` | `<wiki_root>/.wiki-meta/index.json`, `log.jsonl` | config 존재 확인 후 명시 ingest |

**공통 read 규칙:** 식별 가드 불일치 시 throw 금지 → null + stderr 경고 (레거시 비-envelope artifact 통과).

---

## 11. 설치 감지 + graceful degradation (`lib/detect.mjs`)

config/artifact 존재로 감지: deep-work `.claude/deep-work-profile.yaml` · deep-review `.deep-review/config.yaml` · deep-docs `.deep-docs/` · deep-evolve `.deep-evolve/session.yaml` · deep-dashboard `.deep-dashboard/` · deep-memory `~/.deep-memory/...` · deep-wiki `~/.claude/deep-wiki-config.yaml` · superpowers/codex 스킬 목록.

폴백: deep-review 없음 → standalone checker(codex 교차 또는 서브에이전트) · deep-wiki 없음 → ingest 스킵 · deep-memory 없음 → `/deep-memory-init` 안내 후 계속 · recipe 매칭은 감지 결과 기반(누락 sibling 자동 폴백). **deep-loop은 sibling이 하나도 없어도 standalone으로 동작 (요구사항 4 — 독립성).**

---

## 12. End-of-work — `/deep-loop-finish` (요구사항 #3)

```
1. finish → final-report.md (생성 repo/파일/명령/원칙반영/maker-checker/worktree/heartbeat/검증결과/통합여부/남은 TODO/사용 예시/다음 명령/사람 검증 체크리스트)
2. deep-memory 감지 → deep-memory-harvest + 핵심 결정 deep_memory_save (local)
3. deep-wiki 감지 → wiki-ingest <final-report.md>
4. 미감지 → 스킵, 로그 명시
5. artifacts 삭제 ❌, status=completed (proof 검증) | stopped (사람 명시)
```

---

## 13. Marketplace 등록 — build→push→register (요구사항 #4)

```
1. deep-loop 빌드·테스트·preflight 통과 (독립 동작 검증)
2. GitHub push (사용자 승인 필수): https://github.com/Sungmin-Cho/claude-deep-loop.git
3. 40-char SHA 확보
4. deep-suite 3개 파일 lockstep 수정:
   .claude-plugin/marketplace.json   (source.sha=<SHA>)
   .agents/plugins/marketplace.json  (+policy{installation:AVAILABLE,authentication:ON_USE}, category, 순서 동일)
   .claude-plugin/suite-extensions.json (capabilities/artifacts.writes/reads/data_flow, hooks_active:["PreCompact"] — 비어있지 않으므로 hooks_intentionally_empty_reason 불필요)
5. deep-suite `npm run preflight` (README 테이블 자동재생성, 마커 내부 수정 ❌)
```
**SHA 핀닝 제약:** `check-pinned-plugin-paths.js`가 `gh api`로 레포를 SHA에서 fetch해 경로 검증 → **push 전엔 preflight 불가**. push 미승인 시 → `integration/deep-suite.patch.md`만 생성. 등록은 발견성만 추가, 의존성 아님.

---

## 14. 테스트 전략 (`node --test`, Control plane 집중)

1. `init-run` → state/current/loop.json/첫 episode 생성
2. `state patch` 화이트리스트 — 금지 필드(budget.spent, tier 상향, breaker 해제) 거부
3. `budget`/`breaker`/`comprehension` 게이트 임계 동작
4. `recipe-match` — 6 recipe goal별 recipe+protocol 매핑
5. `handoff emit` — md/compaction-state/launch-command + session_chain ULID append
6. `respawn` 게이트 — 예산초과/breaker/max-sessions 차단
7. workstream — N worktree 추적, respawn 시 전체 인수(고아 0), 경로소실 fail-safe
8. `detect-plugins` — sibling 없는 환경 안전
9. schema validation — loop.json ⊨ schema
10. git 없는 환경 fail-safe
11. `review dispatch` — deep-review 유/무에 따른 checker 분기
12. **respawn race (§9.1)** — Continue↔PreCompact 동시 트리거 시 멱등키로 spawn 1회, 이중 spawn 방지, stale lease(TTL 경과) 인수, launch 실패 시 lease 부모 롤백 + `outcome=failed_launch`
13. **integrity (§1.2)** — event-log 시퀀스/라인 체크섬 위변조 탐지 → fail-stop, `budget.spent` 합산≠저장값 탐지, loop.json content-hash 불일치 탐지
14. **lease CAS** — generation 불일치 write 거부, releasing 상태 부모 write 거부

`package.json`: `test: node --test tests/*.test.mjs`, `validate: node scripts/deep-loop.mjs validate`, `preflight: npm run validate && npm test`.

---

## 15. 안전 불변식 (자동화로 끌 수 없음)

- 비가역 외부 행동(push/merge/publish/delete/권한변경) → **항상 사람 승인**, `pre_authorized`로도 불가
- checker 없이 maker done 간주 ❌ · proof 없이 completed ❌ (stopped는 사람 명시 시만)
- deep-loop **자신의** 직접 쓰기는 project root 밖 ❌ (단 `--project-root` 내) · destructive command 제안 ❌
  - **예외 (Codex r2 🟡5):** deep-memory/deep-wiki는 `/deep-loop-finish`에서 **각 플러그인의 자체 스킬에 위임**해 자기 store(`~/.deep-memory`, `wiki_root`)에 기록 — deep-loop이 직접 쓰지 않음. 사람이 시작한 finish의 user-visible side-effect
- respawn은 budget+breaker+max-sessions 통과 시만 · comprehension debt 임계 초과 시 새 maker fan-out 중단
- worktree 연속성 결정론 (고아화 ❌) · handoff/loop.json이 source of truth, 이전 대화 가정 ❌
- **v1 외부 행동 전부 proposal-only** (draft PR 포함, Codex 🟡5). 자동 reversible 행동은 v0.3 connector 레이어에서만
- 상태 무결성은 코드로 *예방*이 아니라 *탐지*되며(§1.2), 탐지 시 fail-stop(paused)
- v1에서 **외부 third-party connector/MCP**(issue tracker·Slack 등) 직접 연동 ❌ (스키마만 예약, v0.3). intra-suite sibling 스킬 위임(deep-memory/deep-wiki)은 위 예외로 허용

---

## 16. 버전 로드맵

| 버전 | 내용 | autonomy 상한 | 외부 acting |
|---|---|---|---|
| **v1 (이 스펙)** | 2-plane 커널 + 10 스킬 + 3 어댑터 + 리뷰전략 + multi-workstream + 자율 respawn(인터랙티브 기본) + memory/wiki end-of-work + 등록 | `act-gated`(다이얼, 단 v1 외부행동은 proposal-only) | **전부 proposal-only** (자동 외부 행동 없음) |
| v0.3+ | connector/MCP 레이어 활성, dashboard ingestion, scheduled automation 확장 | 동일 | reversible 자동(3단 파이프라인) / 비가역 사람승인 |

---

## 17. 구현 순서

1. 스캐폴딩: plugin.json(2종), package.json, schema, 디렉터리
2. Control plane 커널: state→schema→budget→breaker→comprehension→episode→workspace→handoff→respawn→detect→recipes→review→envelope (단위테스트 동반)
3. `deep-loop.mjs` 디스패처 + CLI 계약
4. Execution plane 스킬 10개 + `deep-loop-workflow` references
5. 프로토콜 어댑터 3종 (`protocols/*.json` + `adapters.mjs`)
6. recipes 6종 + automation 템플릿
7. PreCompact hook
8. README/README.ko/CHANGELOG/docs
9. tests → `npm test` → `npm run preflight`
10. (사용자 승인 시) GitHub push → SHA → deep-suite 등록 → preflight / 또는 patch plan
11. 최종 보고 (한국어)
