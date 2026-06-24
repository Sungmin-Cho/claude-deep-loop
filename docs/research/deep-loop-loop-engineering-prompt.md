# deep-loop 플러그인 설계 분석 및 Claude Code 구현 프롬프트

작성일: 2026-06-24  
대상: `claude-deep-suite` 생태계에 추가할 독립 플러그인 `deep-loop`  
참고 철학: Addy Osmani, **Loop Engineering**[^addy-loop]

[^addy-loop]: Addy Osmani, “Loop Engineering”, 2026-06-07, https://addyosmani.com/blog/loop-engineering/

---

## 1. 결론 요약

`deep-loop`는 **독립 플러그인으로 만드는 것이 타당하다.**

단, 중요한 전제가 있다.  
`deep-loop`는 단순히 Claude Code 세션을 반복 실행하거나, context window가 찰 때 다음 세션으로 넘겨주는 “handoff helper”가 아니어야 한다.

`deep-loop`의 올바른 정체성은 다음과 같다.

```text
deep-loop = deep-suite plugin router
          + durable loop state
          + triage inbox
          + maker/checker separation
          + session handoff coordinator
          + future automation heartbeat surface
```

즉, `deep-loop`는 `deep-work`, `deep-review`, `deep-docs`, `deep-wiki`, `deep-evolve`, `deep-dashboard`, `deep-memory` 같은 기존 플러그인을 재구현하는 플러그인이 아니라, **목표를 기준으로 어떤 플러그인을 어떤 순서로 사용할지 결정하고, 각 실행 단위를 episode로 만들고, 산출물을 읽고, 다음 행동을 결정하는 control plane**이어야 한다.

---

## 2. 기존 deep-loop 구상의 장점

기존 구상은 이미 다음 요소를 잘 포함하고 있었다.

| 요소 | 기존 구상 반영 여부 | 평가 |
|---|---:|---|
| Durable state | `.deep-loop/runs/<run-id>/loop.json` | 좋음 |
| Handoff 문서 | `handoffs/<timestamp>-next-session.md` | 좋음 |
| Plugin routing | deep-work/deep-review/deep-docs/deep-evolve 등 라우팅 | 좋음 |
| Recipe 시스템 | robust-implementation, autonomous-evolution 등 | 좋음 |
| 실제 플러그인 재구현 금지 | deep-work/deep-review 등을 episode로 호출 | 좋음 |
| 새 프론트 세션 연결 | launch command 생성 | 좋음 |
| 안전한 기본값 | 자동 push/publish/터미널 실행 금지 | 좋음 |

따라서 기존 프롬프트는 “deep-suite용 durable handoff coordinator”로는 꽤 좋았다.

---

## 3. Loop Engineering 철학 기준으로 부족했던 점

Addy Osmani의 Loop Engineering 글에서 loop는 단순 반복이 아니라, 다음과 같은 구성요소를 가진 작은 시스템으로 설명된다.

1. **Automation heartbeat**  
   주기적으로 discovery와 triage를 수행하는 자동화 또는 heartbeat가 있어야 한다.

2. **Worktree isolation**  
   여러 agent나 episode가 동시에 작업할 때 같은 checkout에서 충돌하지 않도록 worktree 격리가 필요하다.

3. **Skills**  
   매번 프로젝트 지식을 다시 설명하지 않도록 `SKILL.md` 같은 외부 지식 단위를 사용해야 한다.

4. **Plugins/connectors**  
   파일시스템뿐 아니라 실제 개발 도구, issue tracker, CI, 문서, 메모리 등으로 연결될 수 있어야 한다.

5. **Sub-agents / maker-checker split**  
   구현자와 검증자를 분리해야 한다. 만든 agent가 자기 결과를 직접 승인하는 구조는 취약하다.

6. **External memory/state**  
   대화 컨텍스트가 아니라 repo 안의 파일, markdown, board, database 같은 외부 상태가 source of truth가 되어야 한다.

7. **Human remains the engineer**  
   loop는 사용자를 제거하는 자동화가 아니라, 사용자가 더 높은 레버리지로 검증하고 판단하게 하는 시스템이어야 한다.

기존 프롬프트는 3, 4, 6은 잘 반영했지만, 1, 2, 5, 7이 약했다.

---

## 4. 철학적 정합성 평가

| 기준 | 기존 프롬프트 | 개선 방향 |
|---|---|---|
| Prompting → loop 설계 | 부분적으로 부합 | `discover → triage → dispatch → verify → record → decide` 명시 |
| Automation heartbeat | 약함 | `/deep-loop-discover`, `/deep-loop-triage` 추가 |
| Worktree isolation | 옵션 수준 | episode request마다 worktree recommendation 포함 |
| Skills/plugins 활용 | 강함 | 유지 |
| Connectors/MCP 확장성 | 약함 | v0.2+ placeholder와 docs 추가 |
| Maker/checker 분리 | 암묵적 | episode role에 maker/checker 명시 |
| External state | 강함 | 유지 |
| Human review | 안전 정책 수준 | human review checklist와 final-report에 명시 |
| Cost/token awareness | 약함 | `--max-cost` placeholder 추가 |
| Comprehension debt 대응 | 약함 | final-report와 human checklist 추가 |

---

## 5. 수정된 deep-loop 핵심 루프

수정된 `deep-loop`의 기본 루프는 다음과 같다.

```text
Discover
  → repo 상태, 기존 deep-suite artifact, CI/test/docs/review 흔적을 읽어 할 일 후보를 찾는다.

Triage
  → 후보를 actionable / needs-human / blocked / archived 로 분류한다.

Dispatch
  → deep-work, deep-review, deep-docs, deep-evolve 등 적절한 플러그인 episode를 만든다.

Isolate
  → 파일 수정 가능성이 있거나 병렬 실행 가능성이 있는 episode에는 worktree 전략을 제안한다.

Verify
  → maker episode 뒤에는 checker episode를 요구한다.
  → 구현은 deep-work, 검증은 deep-review처럼 분리한다.

Record
  → loop.json, event-log.jsonl, request.md, result.md, verification.md, handoff.md에 기록한다.

Decide
  → artifact와 검증 결과를 읽고 다음 episode, 재시도, 사용자 판단, 종료 중 하나를 선택한다.
```

---

## 6. deep-loop와 기존 플러그인의 경계

| 플러그인 | 책임 | deep-loop와의 관계 |
|---|---|---|
| `deep-work` | 구현, 리팩터링, 버그 수정, TDD, phase gate | maker episode로 호출 |
| `deep-review` | 독립 검증, 리뷰, verdict | checker episode로 호출 |
| `deep-evolve` | metric/fitness 기반 실험 루프 | optimization episode로 호출 |
| `deep-docs` | 문서 정합성, doc gardening | docs episode로 호출 |
| `deep-wiki` | 지식 저장, wiki ingest | archive episode로 호출 |
| `deep-memory` | cross-project memory | harvest/brief episode로 호출 |
| `deep-dashboard` | harnessability, suite telemetry | diagnostic episode로 호출 |
| `deep-goal` | `/goal` condition compiler | deep-loop와 경쟁하지 않음. deep-goal은 compiler, deep-loop는 coordinator |

---

## 7. v0.1 MVP 범위

v0.1에서 구현할 핵심은 “완전 자동화”가 아니다.  
핵심은 **durable loop state + manual heartbeat + triage inbox + recipe routing + maker/checker episode + handoff 생성**이다.

### v0.1 필수 기능

```text
/deep-loop "goal"
/deep-loop-discover
/deep-loop-triage
/deep-loop-continue
/deep-loop-handoff
/deep-loop-status
/deep-loop-finish
```

### v0.1에서 하지 않을 것

```text
- 실제 새 터미널 자동 실행
- 실제 sibling plugin 자동 실행
- git push
- PR 생성
- npm publish
- destructive command
- unattended full automation
- connector/MCP 직접 연동
- dashboard ingestion
- full M3 envelope integration
```

---

## 8. 권장 산출물 구조

```text
.deep-loop/
  current
  runs/
    <run-id>/
      loop.json
      plan.md
      triage-inbox.md
      event-log.jsonl
      episodes/
        001-<plugin-or-action>/
          request.md
          result.md
          expected-artifacts.json
          verification.md
          worktree-recommendation.md
      handoffs/
        <timestamp>-next-session.md
      terminal/
        launch-command.txt
      final-report.md
```

---

## 9. Claude Code에 넘길 최종 프롬프트

아래 프롬프트를 Claude Code 새 세션에 그대로 붙여넣으면 된다.  
권장 실행 위치는 `claude-deep-suite`, `claude-deep-work`, `claude-deep-goal` 등 sibling repo들이 있는 상위 폴더다.

````text
너는 Claude Code 플러그인 아키텍트이자 deep-suite maintainer다.

목표:
새로운 독립 플러그인 `deep-loop`를 설계하고 v0.1 MVP를 구현해줘.

핵심 철학:
이 플러그인은 Addy Osmani가 말한 “Loop Engineering” 철학을 따른다.

`deep-loop`는 단순 반복 실행기나 timer loop가 아니다.
`deep-loop`는 사용자가 매번 다음 프롬프트를 직접 쓰는 구조를 줄이고, 작은 시스템이 다음 일을 발견하고, 나누고, 실행 요청을 만들고, 검증하고, 기록하고, 다음 행동을 결정하게 하는 durable execution loop다.

단, 이 플러그인은 사용자를 제거하는 자동화가 아니다.
사용자는 여전히 엔지니어이며, deep-loop는 사용자가 더 잘 검증하고 더 적은 반복 지시로 일할 수 있게 하는 control plane이다.

deep-loop의 기본 루프 모델:
1. Discover
   - 목표, 현재 repo 상태, 기존 deep-suite artifact, CI/test/docs/review 흔적을 읽어 할 일을 찾는다.
   - v0.1에서는 완전한 자동 스케줄 실행은 하지 않지만, 수동 heartbeat 명령으로 discovery를 수행할 수 있어야 한다.

2. Triage
   - 발견한 일을 중요도/위험도/검증 가능성/필요 플러그인 기준으로 분류한다.
   - 처리 가능한 것은 episode로 만들고, 애매하거나 위험한 것은 triage inbox에 남긴다.

3. Dispatch
   - deep-work, deep-review, deep-docs, deep-wiki, deep-evolve, deep-dashboard, deep-memory 같은 sibling plugin 중 어떤 것을 사용할지 결정한다.
   - deep-loop는 절대 이 플러그인들의 핵심 기능을 재구현하지 않는다.
   - 대신 해당 플러그인에 넘길 request.md, suggested command, expected artifacts를 만든다.

4. Isolate
   - 병렬 또는 독립 작업이 필요한 episode는 worktree 격리를 전제로 설계한다.
   - v0.1에서는 자동 worktree 생성은 기본 실행하지 않아도 되지만, episode request에는 권장 worktree 전략과 안전한 명령 예시를 포함한다.
   - 동일 checkout에서 동시에 여러 agent가 같은 파일을 수정하게 하는 설계를 피한다.

5. Verify
   - maker와 checker를 분리한다.
   - 구현은 deep-work에 맡기고, 검증은 deep-review 또는 별도 checker episode에 맡긴다.
   - “done”은 claim일 뿐 proof가 아니므로, 각 episode는 proof command 또는 proof artifact를 요구해야 한다.

6. Record
   - 모든 결정, episode, artifact, 다음 행동을 대화 컨텍스트가 아니라 repo 안의 durable state에 기록한다.
   - source of truth는 `.deep-loop/runs/<run-id>/loop.json`, `event-log.jsonl`, episode request/result, handoff 문서다.
   - 이전 대화 기억에 의존하지 않는다.

7. Decide
   - artifact와 검증 결과를 읽고 다음 episode를 만들지, 재시도할지, 사용자 검토가 필요한지, 종료할지 결정한다.
   - 위험한 경우에는 자동 진행하지 않고 triage inbox 또는 handoff에 “사용자 판단 필요”로 남긴다.

핵심 정의:
deep-loop = deep-suite plugin router + durable loop state + triage inbox + maker/checker separation + session handoff coordinator.

중요한 경계:
- deep-work를 재구현하지 말 것. 구현/리팩터/버그 수정은 deep-work episode로 라우팅한다.
- deep-evolve를 재구현하지 말 것. metric improvement / coverage / optimization은 deep-evolve episode로 라우팅한다.
- deep-review를 재구현하지 말 것. 독립 검증은 deep-review episode로 라우팅한다.
- deep-docs를 재구현하지 말 것. 문서 정합성은 deep-docs episode로 라우팅한다.
- deep-wiki/deep-memory를 재구현하지 말 것. 지식 보존은 archive episode로 요청한다.
- deep-dashboard를 재구현하지 말 것. harnessability/effectiveness 진단은 dashboard episode로 요청한다.
- deep-goal과 역할을 구분할 것. deep-goal은 goal condition compiler이고, deep-loop는 execution loop coordinator다.
- native `/loop`, `/goal`과 혼동하지 않도록 README와 skill 설명에서 명확히 구분할 것.
- v0.1에서는 hooks를 두지 말 것. 사용자 명시 호출 기반으로만 동작한다.
- v0.1에서는 실제 자동 터미널 실행, git push, PR 생성, publish, destructive command를 하지 않는다.
- v0.1에서는 launch command와 scheduling recipe만 생성하고 실제 실행은 사용자가 선택하게 한다.
- 기본 출력 언어는 사용자의 언어를 따른다. 한국어 사용자의 경우 한국어로 출력한다.

작업 범위:
새 repo `claude-deep-loop`를 만든다. 이미 존재하면 기존 내용을 분석하고 이어서 수정한다.

권장 실행 위치:
`claude-deep-suite`, `claude-deep-work`, `claude-deep-goal` 등 sibling repo들이 있는 상위 폴더에서 실행한다고 가정한다.

탐색:
먼저 현재 작업 디렉터리와 sibling repo를 확인해라.

확인할 수 있으면 다음 repo들을 참고해라:
- claude-deep-suite
- claude-deep-work
- claude-deep-goal
- claude-deep-review
- claude-deep-evolve
- claude-deep-docs
- claude-deep-wiki
- claude-deep-dashboard
- claude-deep-memory

특히 다음 구조/패턴을 참고하라:
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- `skills/<skill>/SKILL.md`
- `README.md`, `README.ko.md`
- package.json scripts
- suite marketplace 구조
- suite-extensions sidecar 구조
- deep-goal의 recipe 개념
- deep-work의 session artifact / receipt / status 개념
- deep-review의 maker/checker 분리 철학
- deep-evolve의 fitness loop와 worktree/experiment 개념
- deep-dashboard의 artifact aggregation 개념
- deep-memory의 durable memory 개념

기존 플러그인의 내부 구현을 복사-붙여넣기하지 말고, deep-loop의 책임에 맞게 최소 구현하라.

필수 산출물:
`claude-deep-loop` repo에 최소한 아래 파일을 만들어라.

  README.md
  README.ko.md
  LICENSE
  package.json
  .claude-plugin/plugin.json
  .codex-plugin/plugin.json

  skills/deep-loop/SKILL.md
  skills/deep-loop-discover/SKILL.md
  skills/deep-loop-triage/SKILL.md
  skills/deep-loop-continue/SKILL.md
  skills/deep-loop-handoff/SKILL.md
  skills/deep-loop-status/SKILL.md
  skills/deep-loop-finish/SKILL.md

  scripts/deep-loop.mjs
  scripts/lib/state.mjs
  scripts/lib/recipes.mjs
  scripts/lib/detect.mjs
  scripts/lib/artifacts.mjs
  scripts/lib/handoff.mjs
  scripts/lib/triage.mjs
  scripts/lib/worktree.mjs
  scripts/lib/slug.mjs
  scripts/lib/log.mjs

  recipes/robust-implementation.json
  recipes/autonomous-evolution.json
  recipes/ship-and-document.json
  recipes/review-fix-loop.json
  recipes/context-handoff-only.json
  recipes/triage-and-discovery.json

  schemas/loop-run.schema.json
  tests/deep-loop.test.mjs

가능하면 추가:
  CHANGELOG.md
  docs/architecture.md
  docs/loop-engineering-principles.md
  docs/integration-with-deep-suite.md
  examples/loop-run-example.md
  examples/handoff-example.md

Node 버전:
- Node >= 20
- package type은 module
- 의존성은 최대한 추가하지 말 것
- YAML parser 의존성을 피하기 위해 v0.1 durable state는 JSON으로 구현한다.
- 사람이 읽기 좋은 Markdown handoff/report도 함께 생성한다.

명령어 설계:
v0.1에서 사용자-facing skill은 아래를 제공한다.

1. `/deep-loop "goal"`
   - 새 loop run 생성
   - goal 분석
   - recipe 선택
   - `.deep-loop/runs/<run-id>/` 생성
   - `loop.json` 생성
   - `plan.md` 생성
   - `triage-inbox.md` 생성
   - 첫 episode request 생성
   - 다음 실행 명령 출력

2. `/deep-loop-discover`
   - active run 또는 새 run의 discovery heartbeat를 수행한다.
   - repo 상태, git status, 최근 deep-suite artifacts, 기존 `.deep-loop` state를 읽는다.
   - 발견한 후보 작업을 `triage-inbox.md`와 `loop.json.discovered_items`에 기록한다.
   - v0.1에서는 외부 issue tracker나 Slack 등 connector를 직접 호출하지 않는다.
   - 대신 connectors/MCP 확장을 위한 placeholder 구조를 만든다.

3. `/deep-loop-triage`
   - discovered items를 actionable / needs-human / blocked / archive 로 분류한다.
   - actionable item은 episode 후보로 만든다.
   - needs-human item은 사용자 판단 필요로 남긴다.
   - 위험하거나 불확실한 항목은 자동 실행하지 않는다.

4. `/deep-loop-continue`
   - 현재 active run 읽기
   - 현재 episode 상태 확인
   - 알려진 플러그인 artifacts를 찾아 요약
   - maker/checker 분리 기준으로 다음 단계 결정
   - 다음 episode를 생성하거나 완료 판단
   - 새 handoff/update 출력

5. `/deep-loop-handoff`
   - 새 Claude Code 프론트 세션에서 이어갈 수 있는 문서 생성
   - `.deep-loop/runs/<run-id>/handoffs/<timestamp>-next-session.md`
   - `.deep-loop/runs/<run-id>/terminal/launch-command.txt`
   - 실제 터미널 실행은 기본적으로 하지 않는다.

6. `/deep-loop-status`
   - active run 상태 출력
   - goal, recipe, current episode, completed episodes, pending episodes, triage inbox, known artifacts, next action 표시
   - human review required 항목을 강조한다.

7. `/deep-loop-finish`
   - run을 completed 또는 stopped 상태로 종료
   - `final-report.md` 생성
   - artifacts는 삭제하지 않는다.
   - “사용자가 직접 검증해야 할 항목”을 final-report에 명확히 남긴다.

script 요구사항:
`scripts/deep-loop.mjs`는 다음 subcommand를 지원한다.

  node scripts/deep-loop.mjs start "<goal>"
  node scripts/deep-loop.mjs discover
  node scripts/deep-loop.mjs triage
  node scripts/deep-loop.mjs continue
  node scripts/deep-loop.mjs status
  node scripts/deep-loop.mjs handoff
  node scripts/deep-loop.mjs finish
  node scripts/deep-loop.mjs validate

옵션:
  --project-root <path>
  --run-id <id>
  --recipe <id>
  --max-episodes <n>
  --max-cost <token-or-money-budget-placeholder>
  --worktree-policy <none|recommend|required>
  --json
  --no-color

v0.1에서는 실제 sibling plugin command를 자동 실행하지 않는다.
대신 episode request.md에 실행 지시를 만든다.

state 구조:
프로젝트 루트 기준으로 아래를 생성한다.

  .deep-loop/
    current
    runs/
      <run-id>/
        loop.json
        plan.md
        triage-inbox.md
        event-log.jsonl
        episodes/
          001-<plugin-or-action>/
            request.md
            result.md
            expected-artifacts.json
            verification.md
            worktree-recommendation.md
          002-<plugin-or-action>/
            request.md
            result.md
            expected-artifacts.json
            verification.md
            worktree-recommendation.md
        handoffs/
          <timestamp>-next-session.md
        terminal/
          launch-command.txt
        final-report.md

`loop.json` 예시 구조:

{
  "schema_version": "0.1.0",
  "run_id": "20260623-154200-add-auth-flow",
  "goal": "Implement auth, review it, update docs, and archive decisions",
  "status": "running",
  "created_at": "ISO timestamp",
  "updated_at": "ISO timestamp",
  "project": {
    "root": "/absolute/path",
    "git": true,
    "branch": "current branch",
    "head": "commit sha or null",
    "dirty": false
  },
  "loop_principles": {
    "heartbeat": "manual-v0.1",
    "state_is_source_of_truth": true,
    "maker_checker_split": true,
    "human_review_required": true,
    "worktree_isolation_policy": "recommend"
  },
  "recipe": {
    "id": "robust-implementation",
    "name": "Robust Implementation",
    "reason": "goal includes implementation + review + docs"
  },
  "plugins_detected": {
    "deep-work": true,
    "deep-review": true,
    "deep-docs": true,
    "deep-wiki": true,
    "deep-evolve": false,
    "deep-dashboard": true,
    "deep-memory": false
  },
  "discovered_items": [],
  "triage": {
    "actionable": [],
    "needs_human": [],
    "blocked": [],
    "archived": []
  },
  "episodes": [
    {
      "id": "001-deep-work",
      "plugin": "deep-work",
      "role": "maker",
      "kind": "implementation",
      "status": "pending",
      "request_path": ".deep-loop/runs/.../episodes/001-deep-work/request.md",
      "expected_artifacts": [
        ".deep-work/<session>/session-receipt.json",
        ".deep-work/<session>/report.md"
      ],
      "verification": {
        "checker_episode_required": true,
        "checker_plugin": "deep-review",
        "proof_required": [
          "tests pass",
          "session receipt exists"
        ]
      },
      "worktree": {
        "recommended": true,
        "reason": "implementation may modify project files"
      }
    }
  ],
  "current_episode": "001-deep-work",
  "termination": {
    "max_episodes": 8,
    "proofs": [
      "implementation artifacts exist",
      "independent review verdict is approve or acceptable concern",
      "docs scan completed if docs recipe selected",
      "final report exists",
      "human verification checklist is written"
    ]
  }
}

Recipe 요구사항:
`recipes/*.json`은 사람이 읽기 쉬우면서 script가 읽을 수 있어야 한다.

필수 recipe:

1. robust-implementation
   Trigger:
   - feature, implement, bug, refactor, fix, build, 구현, 수정, 리팩터링, 버그
   Flow:
   - discover repo state
   - deep-work implementation episode as maker
   - deep-review verification episode as checker
   - deep-docs scan/garden recommendation
   - deep-wiki or deep-memory archive recommendation
   Expected artifacts:
   - `.deep-work/<session>/session-receipt.json`
   - `.deep-review/reports/*.md`
   - `.deep-docs/last-scan.json`

2. autonomous-evolution
   Trigger:
   - optimize, improve, coverage, performance, mutation, fitness, 성능, 최적화, 커버리지
   Flow:
   - deep-dashboard optional harnessability
   - deep-evolve experiment episode
   - deep-review verification episode
   - deep-wiki/deep-memory archive

3. ship-and-document
   Trigger:
   - docs, README, CLAUDE.md, AGENTS.md, architecture, 문서
   Flow:
   - deep-docs scan/garden
   - deep-review optional if code changed
   - deep-wiki ingest

4. review-fix-loop
   Trigger:
   - review, reviewer, requested changes, PR comments, 리뷰 대응
   Flow:
   - deep-review collect/respond
   - deep-work or manual fix request
   - deep-review verify

5. context-handoff-only
   Trigger:
   - handoff, continue, context, session, 이어서, 인수인계
   Flow:
   - create state summary
   - create handoff only
   - no plugin execution episode by default

6. triage-and-discovery
   Trigger:
   - triage, find work, discover, daily check, CI, issue, 정리, 점검
   Flow:
   - discover current repo signals
   - write triage inbox
   - create actionable episodes only after user confirmation or continue command

Episode request 요구사항:
각 episode request.md는 다음을 포함한다.

- Episode ID
- Original goal
- Focused task
- Role: maker / checker / recorder / triager
- Suggested plugin command
- Expected artifacts
- Worktree recommendation
- Proof required
- Return instruction:
  “After completing this episode, run `/deep-loop-continue`.”
- Prior context warning:
  “Do not assume prior chat context. Use this request and loop.json as source of truth.”

deep-work episode request.md 예시:

# Deep Loop Episode 001 — deep-work

## Goal
<사용자 목표>

## Role
Maker. Use deep-work for implementation. Do not bypass deep-work's own phase gates.

## Suggested command

```bash
/deep-work "<focused implementation task>"
```

## Worktree recommendation
Use an isolated worktree if this episode may modify files in parallel with other agents.

## Expected artifacts
- `.deep-work/<session>/session-receipt.json`
- `.deep-work/<session>/report.md`

## Required proof
- Relevant tests pass
- deep-work receipt exists
- Changed files are summarized

## Checker
A follow-up deep-review episode must verify this maker episode.

## Return to deep-loop
After completing the episode, run:

```bash
/deep-loop-continue
```

deep-review episode request.md 예시:

# Deep Loop Episode 002 — deep-review

## Goal
Verify the maker episode output independently.

## Role
Checker. Do not assume the implementation is correct.

## Suggested command

```bash
/deep-review --contract
```

## Expected artifacts
- `.deep-review/reports/*.md`

## Required proof
- Verdict is APPROVE, or concerns are explicitly accepted by the user
- Any REQUEST_CHANGES creates a new fix episode

handoff 문서 요구사항:
`/deep-loop-handoff`는 다음을 포함해야 한다.

- loop run id
- original goal
- current status
- selected recipe
- loop principles
- completed episodes
- current/next episode
- triage inbox summary
- known artifacts
- git branch / HEAD / dirty status
- worktree recommendation
- independent verification status
- human review checklist
- cost/budget notes if present
- exact next Claude Code prompt
- exact suggested command
- “이 문서와 loop.json을 source of truth로 사용하고, 이전 대화 컨텍스트를 가정하지 말라”는 문장

새 프론트 세션용 prompt 예시:

Read `.deep-loop/runs/<run-id>/handoffs/<timestamp>-next-session.md` first.
Treat that handoff and `.deep-loop/runs/<run-id>/loop.json` as the source of truth.
Do not assume any prior chat context.
Continue the current deep-loop episode.
Preserve maker/checker separation.
When the episode is complete, run or instruct `/deep-loop-continue`.

터미널 launch command:
v0.1에서는 실제 실행하지 말고 command만 생성한다.

Windows 예시:

```powershell
wt.exe -d "<project-root>" powershell -NoExit -Command "claude -n 'deep-loop-<run-id>' 'Read .deep-loop/runs/<run-id>/handoffs/<handoff>.md first. Continue the deep-loop run.'"
```

macOS Terminal 예시:

```bash
osascript -e 'tell application "Terminal" to do script "cd <project-root> && claude -n deep-loop-<run-id> \"Read .deep-loop/runs/<run-id>/handoffs/<handoff>.md first. Continue the deep-loop run.\""' 
```

tmux 예시:

```bash
tmux new-session -d -s deep-loop-<run-id> 'cd <project-root> && claude -n deep-loop-<run-id> "Read .deep-loop/runs/<run-id>/handoffs/<handoff>.md first. Continue the deep-loop run."'
```

Automation / heartbeat 설계:
v0.1에서는 자동 스케줄 실행을 구현하지 않는다.
하지만 README와 docs에는 다음을 명확히 문서화한다.

- `/deep-loop-discover`는 manual heartbeat다.
- 나중에 cron, GitHub Actions, Claude Code scheduled task, `/loop`, 또는 외부 automation에서 `/deep-loop-discover && /deep-loop-triage`를 주기적으로 호출할 수 있다.
- v0.1은 automation-ready state와 command를 제공하지만, unattended execution은 하지 않는다.
- unattended loop는 반드시 human review gate와 independent checker를 포함해야 한다.

안전 정책:
- v0.1에서 자동으로 새 Claude session을 실행하지 않는다.
- v0.1에서 자동으로 git commit하지 않는다.
- v0.1에서 자동으로 git push하지 않는다.
- v0.1에서 자동으로 PR을 만들지 않는다.
- v0.1에서 자동으로 npm publish하지 않는다.
- 사용자가 명시적으로 요청하지 않는 한 파일 삭제를 하지 않는다.
- `/deep-loop-finish`도 artifacts를 삭제하지 않는다.
- project root 밖에 쓰지 않는다. 단, 사용자가 명시한 `--project-root`가 있으면 그 안에서만 쓴다.
- destructive command를 episode request에 제안하지 않는다.
- checker 없이 maker episode를 완료로 간주하지 않는다.
- proof artifact 없이 loop를 completed로 종료하지 않는다. 단, 사용자가 명시적으로 stop한 경우 stopped 상태로 종료한다.
- 불확실하거나 위험한 판단은 triage inbox의 needs-human에 남긴다.

테스트 요구사항:
`npm test`가 통과해야 한다.

테스트는 최소한 다음을 검증한다.

1. start command
   - 임시 project root에서 실행
   - `.deep-loop/current` 생성
   - `.deep-loop/runs/<run-id>/loop.json` 생성
   - `plan.md` 생성
   - `triage-inbox.md` 생성
   - episode request 생성

2. discover command
   - repo 상태를 읽고 discovered_items 또는 discovery summary를 기록
   - git이 없는 환경에서도 안전하게 동작

3. triage command
   - discovered item을 actionable / needs_human / blocked / archived 중 하나로 분류
   - 위험하거나 불확실한 항목은 needs_human으로 남김

4. status command
   - active run 상태를 읽고 출력
   - `--json` 출력이 parse 가능

5. handoff command
   - handoff md 생성
   - launch-command.txt 생성
   - handoff에 next prompt 포함
   - human review checklist 포함

6. continue command
   - pending episode를 확인
   - known artifact가 없어도 안전하게 다음 안내를 출력
   - maker episode 후 checker episode가 필요하다는 구조를 유지
   - 깨진 state에서 fail-safe 메시지 출력

7. finish command
   - final-report.md 생성
   - loop.json status를 completed 또는 stopped로 변경
   - artifacts 삭제하지 않음
   - human verification checklist 포함

8. recipe selection
   - 구현 관련 goal은 robust-implementation
   - 최적화/커버리지 관련 goal은 autonomous-evolution
   - 문서 관련 goal은 ship-and-document
   - 리뷰 대응 관련 goal은 review-fix-loop
   - handoff 관련 goal은 context-handoff-only
   - triage/discovery 관련 goal은 triage-and-discovery

9. schema validation
   - loop.json이 schemas/loop-run.schema.json을 만족

문서 요구사항:
README.md와 README.ko.md에 반드시 포함할 것.

- deep-loop가 무엇인지
- Loop Engineering 철학 요약
- native `/loop`와 무엇이 다른지
- deep-goal과 무엇이 다른지
- deep-work/deep-review/deep-docs/deep-wiki/deep-evolve를 재구현하지 않고 라우팅한다는 점
- Discover → Triage → Dispatch → Isolate → Verify → Record → Decide 루프 설명
- maker/checker separation
- worktree isolation 원칙
- manual heartbeat와 future automation 계획
- 설치 방법
- Claude Code 사용 예시
- Codex 사용 예시
- v0.1 제한사항
- v0.2 계획:
  - `--open-terminal`
  - real artifact-aware decision 강화
  - worktree auto-create option
  - scheduled automation templates
  - connector/MCP integration
  - deep-dashboard integration
- 안전 정책
- 산출물 구조
- recipe 목록
- handoff 예시
- 사용자가 여전히 검증 책임을 가진다는 점
- comprehension debt를 줄이기 위한 final-report/human checklist의 목적

패키지 요구사항:
package.json에는 최소한 다음 script를 포함한다.

{
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "validate": "node scripts/deep-loop.mjs validate",
    "preflight": "npm run validate && npm test"
  }
}

Codex 호환성:
`.codex-plugin/plugin.json`에는 다음을 포함한다.
- name: deep-loop
- version: 0.1.0
- description
- repository
- license
- keywords
- skills: "./skills/"
- interface.displayName: "Deep Loop"
- interface.shortDescription
- interface.longDescription
- interface.category: "Coding" 또는 "Productivity" 중 더 적절한 값
- capabilities: ["Interactive", "Read", "Write"]

Claude Code plugin metadata:
`.claude-plugin/plugin.json`은 기존 deep-suite 플러그인들과 유사한 최소 schema를 따른다.
- name: deep-loop
- version: 0.1.0
- description
- author
- repository
- license
- keywords
- category

skill 파일 요구사항:
각 `SKILL.md`는 다음을 포함해야 한다.
- frontmatter: name, description, user-invocable: true
- Invocation 설명: Claude Code slash, Codex skill form
- 사용자의 언어를 감지해 동일 언어로 출력하라는 지침
- 이 skill이 어떤 script subcommand를 실행하거나 어떤 절차를 수행하는지
- 실패 시 안전한 복구 메시지
- destructive action 금지
- git push / publish 금지
- 자동 터미널 실행 금지, launch command 생성만 허용
- loop.json과 handoff 문서를 source of truth로 사용하라는 지침
- maker/checker separation을 유지하라는 지침

deep-suite 통합:
`claude-deep-loop` 구현과 테스트가 통과한 후, sibling repo `claude-deep-suite`가 있으면 통합 작업을 준비한다.

단, 아래 조건을 지켜라.
- deep-loop repo commit이 없으면 suite marketplace에 placeholder SHA를 넣지 말 것.
- 가능하면 deep-loop repo에서 먼저 commit을 만들고 40-char commit SHA를 얻어라.
- GitHub remote는 `https://github.com/Sungmin-Cho/claude-deep-loop.git`로 가정하되, push는 하지 말 것.
- suite marketplace에는 local commit SHA를 pin할 수 있지만, push 전에는 실제 marketplace install이 되지 않는다는 점을 문서화하라.
- 불확실하면 suite repo에는 직접 반영하지 말고 `docs/deep-suite-integration-plan.md` 또는 `integration/deep-suite.patch.md`를 만들어라.

가능하면 suite repo에서 다음을 업데이트한다.
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `.claude-plugin/suite-extensions.json`
- README plugin table / README.ko plugin table, 단 자동 생성 스크립트가 있으면 그 스크립트를 사용하라.
- package validation이 있으면 `npm run preflight` 또는 가능한 검증 명령을 실행하라.

suite-extensions에 deep-loop를 추가할 때의 개념:

deep-loop capabilities:
- cross-plugin-orchestration
- durable-loop-state
- manual-heartbeat
- triage-inbox
- session-handoff
- recipe-routing
- artifact-aware-decision
- maker-checker-separation
- worktree-isolation-recommendation
- front-session-launch-command

deep-loop writes:
- `.deep-loop/<run>/loop.json`
- `.deep-loop/<run>/event-log.jsonl`
- `.deep-loop/<run>/triage-inbox.md`
- `.deep-loop/<run>/episodes/*/request.md`
- `.deep-loop/<run>/episodes/*/result.md`
- `.deep-loop/<run>/episodes/*/verification.md`
- `.deep-loop/<run>/handoffs/*.md`
- `.deep-loop/<run>/terminal/launch-command.txt`
- `.deep-loop/<run>/final-report.md`

deep-loop reads:
- `.deep-work/<session>/session-receipt.json`
- `.deep-work/<session>/report.md`
- `.deep-review/reports/*.md`
- `.deep-review/recurring-findings.json`
- `.deep-docs/last-scan.json`
- `.deep-evolve/<session>/evolve-receipt.json`
- `.deep-evolve/<session>/evolve-insights.json`
- `.deep-dashboard/harnessability-report.json`
- `.deep-memory/latest-brief.md`
- `<wiki_root>/.wiki-meta/index.json`

data_flow examples:
- deep-loop → deep-work via maker episode request
- deep-work → deep-loop via session-receipt
- deep-loop → deep-review via checker episode request
- deep-review → deep-loop via review verdict/report
- deep-loop → deep-docs via docs episode request
- deep-docs → deep-loop via last-scan
- deep-loop → deep-evolve via experiment episode request
- deep-evolve → deep-loop via evolve-receipt + insights
- deep-loop → deep-wiki via ingest request
- deep-loop → deep-dashboard via loop summary, future integration

구현 순서:
1. Repo 탐색
2. 기존 deep-suite plugin conventions 정리
3. Loop Engineering 원칙을 deep-loop architecture로 정리
4. deep-loop v0.1 architecture 작성
5. 파일 생성
6. scripts 구현
7. skills 구현
8. recipes 구현
9. README / README.ko 작성
10. tests 작성
11. npm test
12. npm run preflight
13. git status 확인
14. commit 생성. commit message 예:
    `feat: add deep-loop v0.1 loop-engineering runner`
15. suite 통합은 안전하게 진행하거나 patch plan 작성
16. 최종 보고

최종 보고 형식:
작업 완료 후 한국어로 다음을 보고해라.

- 생성/수정한 repo
- 생성한 주요 파일
- 구현한 명령어
- Loop Engineering 원칙을 어떻게 반영했는지
- maker/checker separation 반영 방식
- worktree isolation 반영 방식
- manual heartbeat / future automation 설계
- 테스트 결과
- deep-suite 통합 여부
- 남은 TODO
- 사용 예시
- 다음에 실행할 명령

중요:
중간에 scope가 커져도 v0.1 MVP를 우선 완료해라.
terminal auto-launch, real plugin execution, dashboard ingestion, connector/MCP integration, full automation scheduling, full M3 envelope integration은 v0.2+ TODO로 남겨도 된다.
동작하는 durable state + manual heartbeat + triage inbox + recipe routing + maker/checker episode + handoff 생성이 v0.1의 핵심이다.
````

---

## 10. 실행 예시

```bash
cd <deep-suite sibling repos가 있는 상위 폴더>
claude
```

Claude Code가 열리면 위 프롬프트를 그대로 붙여넣는다.

---

## 11. 최종 설계 판단

기존 구상은 충분히 좋은 출발점이었다.  
다만 Addy Osmani의 Loop Engineering 철학에 더 맞추려면 `deep-loop`를 단순한 handoff runner가 아니라 다음 구조로 정의해야 한다.

```text
Discover → Triage → Dispatch → Isolate → Verify → Record → Decide
```

이 구조를 따르면 `deep-loop`는 `deep-work`의 부속 기능이 아니라, `deep-suite` 전체를 장기 실행 가능한 agentic development system으로 묶는 상위 control plane이 된다.
