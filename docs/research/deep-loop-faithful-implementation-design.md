# deep-loop: Loop Engineering 충실 구현 설계

작성일: 2026-06-24
선행 문서:
- `docs/research/deep-loop-loop-engineering-prompt.md` (v0.1 설계/프롬프트)
- `docs/research/deep-loop-vs-loop-engineering-analysis.md` (교차 분석 — 간극 §4, 강점 §3)
원문 철학: Addy Osmani, **Loop Engineering**[^addy-loop]

[^addy-loop]: Addy Osmani, "Loop Engineering", 2026-06-07, https://addyosmani.com/blog/loop-engineering/

> 이 문서의 목표: 교차 분석이 식별한 **6개 간극(§4-1 ~ §4-6)을 메우고, 4개 강점(§3)을 보존·확장**하여 deep-loop을 *원문 의미의 autonomous loop*로 진화시키되, Osmani가 가장 경계한 **cognitive surrender를 구조적으로 차단**한다. 핵심 명제는 두 절반 모두를 충족하는 것이다 — **"Build the loop" + "stay the engineer."**

---

## 0. 설계 원칙 (North Star)

| # | 원칙 | 출처 |
|---|---|---|
| P1 | **루프는 사람을 사이클 사이에서 제거하되, 결과 검증에서는 제거하지 않는다** | 원문 thesis + 3대 책임 |
| P2 | **자동화가 강해질수록 stay-the-engineer 게이트는 약해지지 않고 강해진다** | §4-1, cognitive surrender |
| P3 | **모든 "행동(acting)"은 되돌릴 수 있거나, 사람 승인을 거치거나, 사전 정책으로 명시 허용된 것뿐이다** | §4-3 |
| P4 | **상태(state)가 척추다. 자동화·비용·행동·미검토 변경 모두 외부 상태에 기록된다** | §3-1, F |
| P5 | **바퀴를 재발명하지 않는다. heartbeat·stop-condition·sub-agent split은 native `/goal`·`/loop`에 위임한다** | §4-6 |
| P6 | **deep-loop의 고유 가치는 두 가지로 좁힌다: ① cross-plugin orchestration, ② durable triage/verification substrate** | §4-2 |

---

## 1. 강점 보존 (§3을 깨지 않는다)

진화 과정에서 다음 4가지는 **불변(invariant)으로 고정**한다. 어떤 자동화도 이를 우회할 수 없다.

1. **External state는 source of truth.** `loop.json` + `event-log.jsonl` + handoff. 새 필드(cost, parallel episodes, connector actions, comprehension ledger)를 추가하되 스키마 하위호환을 지킨다.
2. **Maker/checker plugin-episode 분리.** maker(deep-work) 결과는 컨텍스트를 공유하지 않는 checker(deep-review) episode가 검증하기 전엔 결코 "done"이 아니다.
3. **사람 책임의 게이트화.** proof 없이는 completed 없음, final-report + human review checklist는 자동화 모드에서도 *필수*.
4. **7단계 루프 모델.** Discover → Triage → Dispatch → Isolate → Verify → Record → Decide. 자동화는 이 단계들을 *연결*할 뿐 *생략*하지 않는다.

---

## 2. 간극별 충실 구현 설계

### 2-1. 간극 §4-1 — 진짜 heartbeat: native `/goal`·`/loop` 위에 얹기 (P5)

**문제:** v0.1은 manual heartbeat라 원문의 "사람 제거" 정의를 충족하지 못한다.

**설계:** deep-loop을 heartbeat 엔진으로 *재구현하지 않고*, 세 가지 native/외부 드라이버에 *위임*한다.

```text
드라이버 A — native /goal (권장 기본값)
  /goal "deep-loop run <run-id>의 termination.proofs가 모두 충족될 때까지"
    매 사이클: node scripts/deep-loop.mjs tick --run-id <id>
    /goal이 stop-condition 평가 + maker/checker sub-agent split을 제공 (§2-5와 정렬)

드라이버 B — native /loop <interval>
  /loop 30m "node scripts/deep-loop.mjs tick --run-id <id> --mode discover-triage"
    간격 기반. 발견·분류만 자동, dispatch는 정책에 따름.

드라이버 C — 외부 스케줄러 (cron / GitHub Actions)
  recipes/automation/*.yml 템플릿 제공.
    cron: 0 9 * * *  →  deep-loop tick (morning triage)
```

**신규 서브커맨드 `tick`** — 한 사이클을 원자적으로 실행한다. `--mode`로 자동 범위를 제한한다.

```text
node scripts/deep-loop.mjs tick --run-id <id> [--mode <scope>]

  --mode discover-only       : Discover만
  --mode discover-triage     : Discover → Triage (기본, 읽기/분류만, 행동 없음)
  --mode advance             : Triage → Dispatch → Verify → Record → Decide
  --mode full                : 위 전체 (autonomy tier가 허용할 때만)

tick은 항상:
  1) loop.json을 lock 후 읽고
  2) budget gate(§2-5)와 circuit breaker(§3)를 먼저 확인하고
  3) 허용 범위 내에서만 단계를 진행하고
  4) 모든 결정/비용/행동을 event-log.jsonl에 append하고
  5) 다음 tick이 읽을 상태로 lock 해제한다.
```

> **stay-the-engineer 게이트:** `tick`의 자동 진행 범위는 `loop.json.autonomy.tier`(§4)가 상한을 정한다. 자동화 드라이버가 아무리 자주 깨워도, tier가 `read-only`면 `advance`/`full`은 거부되고 needs-human으로 적재된다.

---

### 2-2. 간극 §4-2 — "plugins"를 두 축으로 분리 (P6)

**문제:** 원문의 "Plugins & Connectors"(외부 MCP 환경 통합)와 deep-loop의 "plugin router"(intra-suite 오케스트레이션)가 한 단어로 뭉개져 line 76의 과대평가를 낳았다.

**설계:** 아키텍처에서 두 레이어를 *이름부터* 분리한다.

```text
Layer 1 — Plugin Router  (deep-loop 고유 기여, 원문에 없음)
  대상: sibling deep-* 플러그인 (deep-work, deep-review, deep-docs, ...)
  방식: episode request.md + recipe routing
  성격: intra-suite orchestration / control plane

Layer 2 — Connector Layer  (원문 D의 실제 의미, §2-3에서 구현)
  대상: 외부 환경 (issue tracker, CI, Slack, DB) via MCP
  방식: connectors/<name>.mjs 어댑터 + capability 선언
  성격: environment integration / acting surface
```

`loop.json`과 README는 두 레이어를 별도 절로 문서화한다. "deep-loop은 Layer 1에 강하고, Layer 2는 v0.3에서 단계 도입"이라고 정직하게 명시한다 (분석 §6-1 수정사항 반영).

---

### 2-3. 간극 §4-3 — 보고하는 루프 → 행동하는 루프 (안전하게) (P3)

**문제:** v0.1은 report-only라 원문이 강조한 "acting loop"의 레버리지가 없다.

**설계:** Connector Layer(§2-2)에 **capability tier로 단계 게이팅된 acting**을 도입한다. 모든 acting은 3단 안전 파이프라인을 통과한다.

```text
acting 파이프라인 (모든 외부 행동 공통):
  ① plan      : connector가 의도된 행동을 dry-run preview로 생성
                 (예: "PR 제목/본문/대상 브랜치", "티켓 코멘트 본문")
  ② authorize : 아래 중 하나를 만족해야 실행
                 - human이 승인 (대화형 모드)
                 - loop.json.policy.pre_authorized 에 명시 허용된 행동 클래스
                   (예: "linear:comment" 허용, "git:push" 금지)
  ③ execute   : 실행 후 결과 + 되돌리기 정보를 event-log에 기록
```

**capability tier (loop.json.autonomy.tier):**

| tier | 자동 허용 범위 | 외부 acting |
|---|---|---|
| `read-only` (기본) | Discover, Triage | 없음. 발견·분류·기록만 |
| `recommend` | + Dispatch(request.md 생성), Verify, Record | 없음. episode 요청·검증 기록만 |
| `act-reversible` | + 되돌릴 수 있는 행동 자동 실행 | 코멘트/라벨/draft PR/티켓 갱신 등 reversible만 |
| `act-gated` | + 비가역 행동은 건건이 human authorize | push/merge/publish는 **항상** 사람 승인 |

> **불변식:** `git push`, `merge`, `npm publish`, 파일 삭제, 권한 변경은 어떤 tier에서도 자동 실행되지 않는다(P3). pre_authorized로도 허용 불가 — 항상 ②에서 human authorize. 이는 시스템 프롬프트의 "explicit permission required" 카테고리와 정렬한다.

---

### 2-4. 간극 §4-4 — 병렬 worktree를 실제로 가동 (P1)

**문제:** v0.1은 순차·수동이라 worktree 권장이 막을 충돌이 없다.

**설계:** `tick --mode advance|full`에서 **독립 episode를 fan-out**할 때 worktree를 *자동 생성*하고, fan-in에서 통합한다. native subagent의 `isolation: worktree`를 우선 활용한다.

```text
fan-out 조건: triage된 actionable item들이
  - 서로 다른 파일/모듈을 건드리고 (detect.mjs가 겹침 추정)
  - 각각 독립 maker episode가 될 수 있을 때

실행:
  for each independent episode:
    git worktree add .deep-loop/worktrees/<episode-id>   (또는 subagent isolation:worktree)
    episode 실행 → result + receipt
  fan-in:
    각 maker episode마다 독립 checker episode(§2-6)
    통합 충돌 시 needs-human으로 적재
```

> **stay-the-engineer 게이트 (원문 핵심 통찰):** 병목은 worktree 수가 아니라 **사람의 리뷰 대역폭**이다. 따라서 `loop.json.autonomy.max_unreviewed_episodes`를 둔다. 미검토(사람이 final review 안 한) episode가 이 한도에 도달하면, 병렬도와 무관하게 **새 maker fan-out을 멈추고** review queue로 사람을 부른다. 자동화가 "사람이 못 따라잡는 속도로 코드를 쌓는" 실패 모드를 구조적으로 차단한다.

---

### 2-5. 간극 §4-5 — 실제 token/budget gate (P4)

**문제:** `--max-cost`가 placeholder뿐. 자동화가 켜지면 비용이 지수적으로 샐 수 있다 (원문의 가장 구체적 경고).

**설계:** budget을 1급 상태로 만들고, `tick`이 매 사이클 *진입 시점*에 검사한다.

```jsonc
// loop.json.budget (신규)
"budget": {
  "currency": "usd|tokens",
  "total": 20.0,                 // 사용자가 설정한 상한
  "spent": 7.3,                  // 누적 (event-log 합산과 일치)
  "per_episode_estimate": 0.8,   // recipe별 추정
  "soft_stop_ratio": 0.8,        // 80% 도달 시 경고 + recommend tier로 강등
  "hard_stop_ratio": 1.0,        // 100% 도달 시 자동 pause + handoff
  "on_exhaust": "pause-and-handoff"
}
```

```text
tick 진입 검사 순서:
  if spent >= total * hard_stop_ratio:
      status = "paused"; write handoff; emit budget-exhausted event; STOP
  if spent + per_episode_estimate > total:
      tier 강등 (act-* → recommend); 남은 일은 needs-human
  if spent >= total * soft_stop_ratio:
      final-report에 "예산 80% 소진" 경고 누적
```

모든 episode 종료 시 실제 사용량을 `event-log.jsonl`에 `{type:"cost", episode, amount}`로 append → `spent`는 항상 로그 합산으로 재계산 가능(감사성).

---

### 2-6. 간극 §4-6 — `/goal` 내부 maker/checker split과 정렬 (P5, P6)

**문제:** `/goal`이 이미 stop-condition + sub-agent split을 제공하는데 deep-loop이 옆에 서 있다.

**설계:** 두 레벨의 maker/checker를 *정렬*한다.

```text
Level A — plugin-episode 레벨 (deep-loop 고유, §3-2 강점 유지)
  deep-work(maker) episode  →  deep-review(checker) episode
  컨텍스트 비공유. 플러그인 경계가 곧 격리.

Level B — sub-agent 레벨 (native /goal에 위임)
  /goal이 stop-condition을 평가할 때 내부적으로
  explorer → implementer → verifier split을 돌린다.
  deep-loop은 termination.proofs를 /goal이 읽을 수 있는
  검증 가능한 stop-condition으로 컴파일해 넘긴다.

정렬 규칙:
  - deep-loop.termination.proofs  →  /goal stop-condition으로 변환 (deep-goal 플러그인 재사용 가능)
  - Level A checker의 verdict가 Level B verifier의 1차 증거가 된다
  - 어느 레벨에서도 maker가 자기 결과를 최종 승인하지 못한다
```

이로써 deep-loop은 heartbeat·stop-condition을 재발명하지 않고, 자신의 고유 가치(cross-plugin routing + durable substrate)에 집중한다(P6).

---

## 3. cognitive surrender 차단 장치 (P2 — 자동화가 강해질수록 강해지는 게이트)

원문이 꼽은 최대 위험은 "루프를 *이해를 회피*하는 데 쓰는 것"이다. 자동화 tier가 올라갈수록 다음 장치가 *강제로* 켜진다.

### 3-1. Comprehension Ledger (이해 부채 측정)

```jsonc
// loop.json.comprehension (신규)
"comprehension": {
  "episodes_total": 12,
  "episodes_human_reviewed": 5,
  "unreviewed_diff_lines": 840,        // 사람이 안 읽은 변경 라인 누적
  "debt_ratio": 0.58,                  // 1 - reviewed/total
  "debt_threshold": 0.5                // 초과 시 새 maker fan-out 중단
}
```

`debt_ratio`가 임계치를 넘으면 — 아무리 budget·tier가 허용해도 — **새 구현 episode를 멈추고** "읽어야 할 변경" review queue를 final-report 상단에 올린다. *"smooth loop이 이해 부채를 가속한다"*는 원문 경고에 대한 직접 방어.

### 3-2. Circuit Breaker (자동 정지)

```text
다음 중 하나면 status="paused" + handoff 생성 + 사람 호출:
  - 연속 N회 checker REQUEST_CHANGES (maker가 헛돌고 있음)
  - budget hard_stop 도달 (§2-5)
  - comprehension debt 임계 초과 (§3-1)
  - max_unreviewed_episodes 도달 (§2-4)
  - 같은 파일에 M회 이상 반복 수정 (진동 감지)
  - connector acting 실패율 임계 초과
```

### 3-3. 자동화에서도 끌 수 없는 게이트

`act-gated` tier에서도 다음은 *항상* 사람을 거친다(자동화로 비활성화 불가):

- 비가역 행동(push/merge/publish/delete/권한변경)의 ② authorize
- final-report의 human verification checklist 작성
- run을 `completed`로 종료하기 위한 proof artifact 확인

---

## 4. 통합 상태 스키마 확장 (`loop.json` v0.2)

기존 v0.1 스키마에 하위호환으로 추가한다.

```jsonc
{
  "schema_version": "0.2.0",
  // ... v0.1 필드 전부 유지 ...

  "autonomy": {
    "driver": "goal|loop|cron|manual",   // §2-1
    "tier": "read-only|recommend|act-reversible|act-gated", // §2-3
    "max_unreviewed_episodes": 3,        // §2-4
    "max_parallel": 2                    // §2-4
  },
  "budget": { /* §2-5 */ },
  "comprehension": { /* §3-1 */ },
  "connectors": {                        // §2-2 Layer 2
    "enabled": [],                       // v0.2에서는 빈 배열(설계만), v0.3에서 활성
    "pre_authorized": []                 // 예: ["linear:comment", "github:draft-pr"]
  },
  "circuit_breaker": {                   // §3-2
    "consecutive_request_changes": 0,
    "tripped": false,
    "trip_reason": null
  }
}
```

`scripts/lib/`에 추가 모듈:

```text
scripts/lib/tick.mjs         # §2-1 한 사이클 오케스트레이션
scripts/lib/budget.mjs       # §2-5 예산 게이트 + 비용 집계
scripts/lib/comprehension.mjs# §3-1 이해 부채 원장
scripts/lib/breaker.mjs      # §3-2 서킷 브레이커
scripts/lib/autonomy.mjs     # §2-3 tier 권한 판정
connectors/                  # §2-2 Layer 2 어댑터 (인터페이스 + 예시 stub)
  README.md                  #   connector capability 계약 정의
  linear.example.mjs
  github.example.mjs
recipes/automation/          # §2-1 드라이버 C 템플릿
  cron-morning-triage.yml
  github-actions-loop.yml
```

---

## 5. 버전 로드맵 (각 단계가 stay-the-engineer를 유지)

| 버전 | 추가되는 것 | autonomy 상한 | 외부 acting | 핵심 게이트 |
|---|---|---|---|---|
| **v0.1 (현재)** | substrate + manual control plane | manual | 없음 | proof-before-done, maker/checker |
| **v0.2** | `tick`, native `/goal`·`/loop`·cron 드라이버, budget gate, comprehension ledger, 병렬 worktree, circuit breaker | `recommend` | **없음** (읽기·분류·요청·검증만 자동) | budget·debt·breaker 3중 정지 |
| **v0.3** | Connector Layer 활성, capability tier acting | `act-gated` | reversible 자동 / 비가역 사람승인 | 3단 acting 파이프라인, 끌 수 없는 게이트(§3-3) |
| **v0.4+** | connector 생태계 확장, team distribution(plugin 번들), dashboard 통합 | `act-gated` | 동일 | 동일 |

> **핵심:** autonomy는 v0.2에서 "자동으로 *생각*하되 *행동*하지 않는" 단계를 먼저 통과한다. 즉 heartbeat(원문 thesis)는 v0.2에서 켜지지만, 외부 세계를 바꾸는 acting(원문 D)은 v0.3에서 안전 파이프라인과 함께 켜진다. 이렇게 *thesis와 위험을 분리해 단계 도입*한다.

---

## 6. 충실도 자가 점검 (이 설계 vs 원문 5+1)

| 원문 | v0.1 | 본 설계 적용 후 | 메커니즘 |
|---|---|---|---|
| A. Automations(heartbeat) | ⚠️ manual | ✅ `/goal`·`/loop`·cron 위임 | §2-1 `tick` |
| B. Worktrees | ◐ 권장만 | ✅ 병렬 자동 + 리뷰 대역폭 게이트 | §2-4 |
| C. Skills | ✅ | ✅ 유지 + automation이 호출 | §2-1 |
| D. Plugins & Connectors | ◐ 라우팅만 | ✅ 2-레이어 분리 + acting connector | §2-2, §2-3 |
| E. Maker-checker | ✅✅ | ✅✅ 2레벨 정렬 | §2-6 |
| F. External state | ✅✅ | ✅✅ + budget/debt/connector 기록 | §4 |
| 사람 책임(검증/부채/항복) | ✅✅ 게이트 | ✅✅✅ 자동화에서도 강화 | §3 |

원문의 마지막 문장에 대한 답:

> "Build the loop. But build it like someone who intends to stay the engineer."
>
> 본 설계는 **build the loop**(§2-1 heartbeat, §2-3 acting, §2-4 병렬)과 **stay the engineer**(§3 cognitive-surrender 차단, P2·P3 게이트)를 *같은 스키마 안에서* 강제 결합한다. autonomy tier가 올라갈수록 게이트가 약해지는 게 아니라 **강해지도록** 설계해, Osmani가 경고한 "downward spiral"을 구조적으로 막는다.

---

## 7. 다음 액션 (구현 시작점)

1. `loop.json` 스키마를 0.2.0으로 확장 (§4) — 하위호환 유지, schema 테스트 추가.
2. `scripts/lib/tick.mjs` + `autonomy.mjs` + `budget.mjs` 우선 구현 → v0.2의 "생각하되 행동 안 함" 루프 완성.
3. `recipes/automation/*.yml` + `/goal` 연동 문서 작성 (§2-1, §2-6).
4. `comprehension.mjs` + `breaker.mjs`로 cognitive-surrender 게이트 선구현 (§3) — *acting보다 먼저*.
5. Connector Layer는 인터페이스 계약(`connectors/README.md`)만 v0.2에서 확정, 실제 어댑터·acting은 v0.3.

> 원칙: **게이트를 먼저, 자동화를 그다음, acting을 마지막에.** 안전 장치가 비용·이해부채·병렬도를 막을 수 있게 된 *후에야* heartbeat를 켜고, heartbeat가 검증된 *후에야* 외부 acting을 연다.
