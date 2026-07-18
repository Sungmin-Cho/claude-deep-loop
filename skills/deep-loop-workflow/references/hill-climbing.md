# Hill-Climbing 프로토콜 (하네스 자율 개선 환류)

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

deep-loop이 축적한 트레이스(event-log·review verdict·sibling artifact)를 커널이 결정론으로 마이닝하고(`lib/insights.mjs`), 그 신호로 하네스 개선안을 자율 생성 → 적대 검증(checker) → PR 준비까지 무인 수행하는 환류 고리. 사람 게이트는 기존 것(PR 머지, init 확인, comprehension ack)만 유지하고 새 게이트를 추가하지 않으며, **실행 중 run의 자기 게이트 수정(runtime self-modification)과 게이트-크리티컬 파일의 자율 편집은 금지**한다. 이 문서는 harness-hill-climb run의 maker/checker가 지켜야 할 계약을 정의한다 — 문서 자신도 Tier 2(자율 편집 금지, human-proposal만)다(§8.1).

## Lease identity

hill-climb run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. fenced mutation 직전에 current lease를 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 얻는다. read-only insights 명령은 불변 `<run_id>`만 쓰고, mutation은 current fence와 logical run id를 분리해 전달한다.

## 1. 후보 → 판단 (spec §5)

candidates는 **개선 후보 신호**다. 어떤 파일을 어떻게 고칠지의 판단은 LLM(design/plan maker) 몫 — 커널은 후보를 계산만 한다. 각 candidate 항목: `{ id, metric, value, threshold, min_runs, scope, target_hints[], target_tier, note }`. `target_tier ∈ {1, 2}` — Tier 2 대상 후보는 자율 diff가 아니라 **human-proposal 섹션**(§3)으로만 다뤄진다.

`fix_cycles` 정의: 커널은 maker당 터미널 checker를 최대 1개 바인딩하고(`review.mjs dispatchReview`의 `!makerReviewed` 필터), REQUEST_CHANGES는 *새 fix maker*를 만든다. 수렴 난이도는 **(ws,point)당 fix_cycles = 해당 (ws,point)에 기록된 REQUEST_CHANGES verdict 수**로 잰다.

| id | 조건 | min_runs | target_hints (tier) |
|---|---|---|---|
| `fix_cycles_high:<point>` | 해당 point의 (ws,point)당 평균 fix_cycles ≥ 1.0 | 1 | recipe 힌트(T1) / point 지침·review-strategy.md(T2 — human-proposal) + init 환류(max_review_rounds) |
| `breaker_trip` | tripped ≥ 1 | 1 | trip 사유 연관 recipe(T1)/제어 스킬(T2) |
| `respawn_failure` | respawn-failed + respawn-timeout ≥ 1 | 1 | respawn/handoff 지침(T2) |
| `bootstrap_ack_friction` | ack_before_first_dispatch == true | 1 | init·continue 부트스트랩 안내(T2), init 환류(debt_threshold) |
| `budget_overrun` | 소진율 ≥ soft_stop_ratio | 1 | recipe 힌트(T1) + init 환류(budget) |
| `pause_frequency` | run-paused ≥ 2 | 1 | 사유 연관 recipe(T1) / 스킬 지침(T2 — human-proposal) |
| `abandoned_episodes` | abandoned ≥ 1 (episode-abandon) | 1 | 해당 kind 연관 recipe(T1) / 스킬 지침(T2 — human-proposal) |
| `fix_convergence_slow:<point>` | 3+ runs에서 point 평균 fix_cycles 추세 비감소 | 3 | 프로세스 지침 (cross-run 전용) |
| `integrity_failure` | 집계 규약(2단 읽기) 검증 실패 터미널 run 존재 | 1 | **편집 대상 아님** — needs-human 조사 신호로만 표기 |

임계값은 `insights.mjs` 상수(`CANDIDATE_RULES`)로 고정 — v1에서 설정화하지 않는다(YAGNI).

design maker는 후보를 읽을 때 항상 **읽기 전용** CLI만 쓴다(fence 불필요):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" insights --json --project-root "<canonical_project_root>" --run-id <run_id>
```

`--run <id>`로 `per_run`만 한정할 수 있다 (후보/집계는 전 run 대상). `.deep-loop/insights/`를 직접 읽거나 파싱하지 않는다 — 검증된 최신 결과가 필요하면 `insights latest --json`(아래 §4)만 사용한다.

## 2. run 흐름 (spec §7)

recipe `harness-hill-climb`:

```jsonc
{
  "id": "harness-hill-climb",
  "name": "Harness Hill-Climb",
  "triggers": ["hill-climb","hill climbing","하네스 개선","루프 개선","환류"],
  "protocol_hint": "standalone",
  "flow": ["insights","standalone:maker","deep-review:checker","ship-proposal","archive"],
  "expected_artifacts": [".deep-loop/insights/*.json", "harness diff (Tier 1)", "recipes/hillclimb-ledger.json", ".deep-review/reports/*.md"]
}
```

run 수명주기 (모든 단계가 기존 deep-loop 기계장치 재사용 — hill-climb run 자신도 budget·breaker·lease·리뷰 게이트 아래에서 돌고, 자신의 트레이스가 다음 마이닝 대상이 된다):

1. 시작: 사람이 Claude에서는 `/deep-loop "<goal>"`, Codex에서는 `$deep-loop:deep-loop "<goal>"`를 호출한다(recipe-match → harness-hill-climb) — 직전 finish의 제안 명령을 그대로 쓰는 경우 포함.
2. design maker: `insights --json` 조회 → 후보 선정(+이전 ledger 항목의 falsification 대조 → 성립 시 revert 후보) + 개선 방향 문서(worktree) → checker.
3. plan maker: 파일별 편집 계획(Tier 판정 포함) → checker.
4. implementation maker: worktree에서 **Tier 1** 파일 편집 + **ledger append**(§3) + Tier 2 대상은 human-proposal 섹션 작성 + `npm run preflight` 통과 + proof 기록 → checker.
5. workstream `ready` → **PR 제안**(proposal-only) → 사람 머지.

각 maker episode는 일반 워크플로우와 동일하게 fence를 반드시 지킨다. 예:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode new --plugin standalone --role maker --kind implementation --point implementation --workstream <workstream_id> --artifacts '[".claude/worktrees/<ws-slug>/recipes/hillclimb-ledger.json"]' --task "<bounded_episode_task>" --request-id <episode_request_id> --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

## 3. 증거 계약 + 2계층 화이트리스트 + ledger (spec §8)

### 3.1 2계층 화이트리스트 (게이트 준수 prose는 자율 편집 대상이 아니다)

- **Tier 1 — 자율 편집 허용:** `recipes/*.json`(ledger 포함), `recipes/automation/*.yml`. **이상 전부 — SKILL.md는 하나도 포함되지 않는다.** status/triage 스킬도 human-only escape hatch 안내·proposal-only 선언 등 하드 불변식을 지탱하는 prose를 담으므로 Tier 2다. 커널의 `--confirm`/lease 검사는 플래그 확인일 뿐 "사람인지"는 prose 경계라는 점을 존중한다. Tier 1 = 선언적 recipe/automation 자산만.
- **Tier 2 — 자율 편집 금지 (human-proposal만):** 그 외 전부 = **`skills/**` 전체**(게이트 보유 제어 스킬 `deep-loop`·`continue`·`handoff`·`resume`·`ack`·`discover`·`finish`·`workflow`는 물론, human-only escape hatch 안내를 담는 `status`·`triage`까지) + **references 전부**: `review-strategy.md`, `handoff-respawn.md`, `adapters.md`(`--tier` 전달·`guard.ok===false` 중단 지시를 담는 게이트 준수 prose), **`hill-climbing.md`(이 문서 자신 — hill-climb 자신의 checker 계약 문서; 자기 심사 기준의 자율 편집 차단)** — 및 기존 제외(scripts/, hooks/, schemas/, tests/의 게이트 단언). Tier 2 개선 아이디어는 hill-climb run의 **human-proposal 섹션**(최종 리포트 내 제안 텍스트)으로만 산출되고, 적용은 사람이 일반 개발로 수행한다.

이 구분으로 마커 테스트가 의미 반전을 못 잡는 급소가 원천 제거된다 — 게이트 준수 prose는 애초에 자율 편집 범위 밖이다.

### 3.2 게이트-크리티컬 마커 테스트의 정직한 위상

`tests/skills.test.mjs`는 게이트 보유 제어 스킬에 필수 마커(continue의 dispatch 전 budget·breaker·comprehension 검사 지시, `breaker reset`의 human-only `confirm` 플래그 문구, proposal-only 선언 등)가 위치-독립으로 존재함을 단언한다. **이 테스트가 결정론적으로 잡는 것은 마커 삭제뿐이다** — 마커를 보존한 의미 약화는 checker 계약 (e)(LLM 판단)와 사람 머지가 담당한다. 이 테스트의 역할은 (a) 모든 PR(사람 실수 포함)의 삭제-회귀 방어, (b) 향후 Tier 완화 시의 선행 방벽이다.

### 3.3 ledger — `recipes/hillclimb-ledger.json` (Tier 1, append-only 배열)

`recordEpisode`는 proof의 `result_*` 키만 durable하게 남기므로, 증거 계약의 durable 사본은 **git으로 머지되는 ledger 파일**에 둔다. implementation maker가 항목을 append한다:

```json
{
  "date": "2026-07-07",
  "insights_ref": ".deep-loop/insights/<ulid>-insights.json",
  "insights_sha256": "<sha>",
  "candidates_addressed": ["bootstrap_ack_friction", "fix_cycles_high:implementation"],
  "changes": ["recipes/robust-implementation.json", "recipes/automation/cron-morning-triage.yml"],
  "human_proposals": ["deep-loop-continue 부트스트랩 안내 개선(T2 — 사람 적용)", "deep-loop-status 표시 개선(T2 — 사람 적용)"],
  "falsification": "이 변경 적용 후 3개 run 내 bootstrap_ack_friction이 계속 true면 실패로 판정하고 revert를 제안한다"
}
```

`episode record` 호출의 proof 필드에는 요약 + ledger 경로를 인용한다(참고용 — durable 근거는 ledger). ledger 파일 자체가 Tier 1 편집 대상이므로, **ledger의 append-only는 다음 3중으로 지킨다**:

1. checker 계약 (f)가 **diff 수준**에서 순수 append(기존 항목 라인 불변 — **수정** 금지·**삭제** 금지·**재배열** 금지)를 요구하고 위반 시 REQUEST_CHANGES.
2. 사람 머지 리뷰.
3. **최종 durable 근거는 ledger 파일이 아니라 git history다** — 설령 어떤 PR이 과거 항목을 지웠더라도 `git log -p recipes/hillclimb-ledger.json`으로 전 항목이 복원 가능하며, falsification 사후 판정 절차는 이를 명시적 폴백으로 갖는다.

**falsification 사후 판정 절차:** 다음 hill-climb run의 design maker가 머지된 ledger(diff가 의심되면 `git log -p recipes/hillclimb-ledger.json`로 전 항목을 재구성)의 이전 항목과 최신 insights 지표(`insights latest --json`)를 대조해, 반증 조건이 성립한 항목은 revert 후보로 올린다. 이는 자기 교정 고리다 — 근거가 ledger 파일이 아니라 git에 있으므로, ledger가 손상되거나 worktree/run이 삭제되어도 무관하게 폴백이 성립한다.

### 3.4 checker 계약 (deep-review `--contract` + 본 문서) — 하나라도 실패 시 REQUEST_CHANGES

**계약 소스는 tracked 파일이다:** `skills/deep-loop-workflow/references/contracts/HILLCLIMB-001.yaml` (deep-review contract-schema 파리티 — `slice`/`title`/`status`/`criteria`). `.deep-review/`는 gitignored라 fresh checkout에는 계약이 없다 — hill-climb run의 리뷰 dispatch 전에 tracked 소스를 **workstream worktree의** `<worktree>/.deep-review/contracts/HILLCLIMB-001.yaml`로 **그대로 복사(materialize)** 한다(checker는 worktree를 cwd로 deep-review를 실행하고 deep-review는 cwd의 `.deep-review/`를 읽는다 — 게이트 위치 = 소비처). 커널 `dispatchReview`는 hill-climb recipe run에서 다음을 전부 fail-closed로 강제한다(모두 checker episode 생성 전 throw):

- reviewer가 `deep-review-loop`이고 flags에 **정확히 1회의 bare `--contract`**(selector 금지 — deep-review 파서는 `SLICE-NNN`만 selector로 소비하므로 HILLCLIMB-001을 명시 지정할 수 없고, `=` 형태·중복·타-slice는 전부 우회 경로)가 있어야 한다 — 아니면 `REVIEW_CONTRACT_UNENFORCEABLE`(subagent/codex-cross/standalone은 계약 파일을 읽지 않으므로 계약 미강제 APPROVE가 된다). bare `--contract`는 모든 active 계약을 로드하므로 worktree contracts 디렉터리에는 HILLCLIMB-001.yaml **외 다른 계약 yaml이 없어야** 한다(커널이 dispatch·record 양쪽에서 유일성 검증).
- worktree-local 계약 사본이 존재하고 tracked 소스와 **byte-identical**이어야 한다 — 아니면 `REVIEW_CONTRACT_MISSING`(`status: active` 문자열만으론 stale/변조 사본 — 예: criteria 비움 — 이 통과한다; 계약은 run-불변이므로 "그대로 복사"가 곧 판정 기준). 검증된 계약 identity(slice·path·sha256)는 checker episode에 durable 기록되고, `review record`의 passing verdict는 **같은 파일을 record 시점에 재검증**한다 — dispatch~record 사이 삭제/변조(deep-review는 무-contract를 조용히 skip)로 나온 APPROVE는 `REVIEW_CONTRACT_MISSING`으로 거부된다.
- 통과 시 `evidence`(커널-검증 `latestInsights`의 경로·emit_ulid·producer run·sha256·후보 — 부재 시 `null`)를 디스크립터와 **checker episode의 anchored `request_markdown`에 durable 기록**하며 별도 request pathname은 만들지 않는다. 스킬은 이 evidence를 checker 리뷰 요청 본문에 그대로 포함하고, checker는 maker 인용(ledger `insights_ref`/`insights_sha256`, design/plan은 문서 인용)과 대조해 mismatch를 criterion (a) 위반으로 판정한다. run-특정 값은 계약 파일이 아니라 이 evidence로 전달한다 — 계약 파일은 run-불변.

**phase 적용성:** (a)(b)(c)(e)는 모든 review point(design/plan/implementation)에 적용하되 design/plan에서는 문서 수준으로 적용한다. **(d)(f)는 implementation checker 전용**이다 — diff/ledger가 존재하지 않는 design/plan phase에 일괄 적용하면 구조적으로 승인 불가가 된다(첫 실사용 run r5 W 실측).

- (a) 인용 지표가 `insights latest` 검증을 통과한 insights 파일에 실존하는지
- (b) 변경이 인용 후보를 실제로 겨냥하는지
- (c) 반증 조건이 관측 가능한 미래 신호인지
- (d) **[implementation 전용]** **diff가 Tier 1 안인지** (Tier 2 파일 diff 발견 = 즉시 REQUEST_CHANGES)
- (e) 변경이 어떤 파일의 안전 게이트 준수 지시문도 삭제·약화하지 않는지 (Tier 1 내 파일에도 적용 — 벨트 앤 서스펜더)
- (f) **[implementation 전용]** ledger 항목이 append되었고 schema에 맞으며, **ledger diff가 순수 append인지 — 기존 항목의 수정·삭제·재배열이 diff에 보이면 즉시 REQUEST_CHANGES**

**방벽 요약:** ① Tier 2 자율 편집 원천 금지(구조적) ② 마커 테스트(삭제 결정론 방어) ③ checker 계약 (d)(e)(f) ④ 사람 머지. auto-merge가 없으므로 최종 방벽은 항상 사람이다 — "stay the engineer" 철학과 일치한다.

## 4. CLI 계약 요약 (spec §6)

| subcommand | 역할 | fence | 예시 |
|---|---|---|---|
| `insights [--run <id>] [--json]` | 지표+후보 계산·출력. 읽기 전용 | 불필요 | `insights --json` |
| `insights emit --owner <owner_run_id> --generation <n>` | envelope 발행 + `insights-emitted` 이벤트(3단계 순서: tmp write → appendAnchored → rename) | **필수** | 아래 canonical argv 명령 |
| `insights latest [--json]` | **검증된** 최신 insights 반환. 스킬(초기화·종료)은 이 명령만 사용, 직접 파일 파싱 금지 | 불필요 | `insights latest --json` |

`insights emit`은 유일한 mutation 표면이다 — `appendAnchored`(preCheck 내부 leaseCheck)로 이벤트를 기록한다(raw `appendEvent` 금지, 불변식 #3). `insights`/`insights latest` 호출은 `.deep-loop/insights/`를 스킬이 직접 읽거나 파싱하는 것을 대체한다 — 신뢰 원천은 파일이 아니라 anchored 이벤트다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" insights emit --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

## 5. §9 표시 규칙 요약 (finish/init 통합)

**`/deep-loop-finish`** (final-report 작성 후, memory/wiki 단계 이전):
1. `insights emit --owner <owner_run_id> --generation <n>` 실행.
2. `candidates.length > 0`이면 최종 메시지에 후보 요약과 runtime별 호출을 출력한다: Claude `/deep-loop "하네스 개선"`, Codex `$deep-loop:deep-loop "하네스 개선"`. goal은 이 고정 문구 그대로 쓴다 — 후보 id 상세(예: `fix_cycles_high:implementation`)는 명령 문자열 밖(메시지 본문 또는 `insights`/`insights latest` CLI 출력)에서만 표기한다(candidate id의 "fix"/"implement" 같은 substring이 다른 recipe 트리거와 충돌해 recipe-match를 비결정적으로 오라우팅할 수 있으므로). **자동 시작 ❌**.
   - 발행된 envelope.payload의 `suspicious_active` / `post_finish_mutated` 배열이 비어있지 않으면 제안 블록·최종 메시지에 해당 run 목록을 ⚠️ 주의로 함께 표기한다 — 후보/제안 유무와 무관하게(라벨만 있는 경우에도 출력; prose-only 규율).
3. emit 실패는 **비치명** — finish는 계속 진행하고 실패를 로그·리포트에 명시한다.

**`/deep-loop` (init)** — §2-2와 §2-3 사이:
1. `insights latest --json` 호출(커널이 검증 전부 수행 — 스킬은 파일을 직접 파싱하지 않는다). `null`이면 스킵 — 무마찰.
2. **표시 규칙:** 후보·집계에서 파생한 제안은 AskUserQuestion에서 **기존 문서화 기본값과 나란히, 별도 옵션으로** 표시하고, 각 제안에 인용 지표를 병기한다(예: "max_review_rounds 7 — 근거: 직전 run implementation fix_cycles 평균 2.0"). 제안을 preselect하지 않으며, 무응답 경로로 채택되게 하지 않는다. 어떤 값도 자동 적용 ❌. 이 표시 규칙은 prose-only 규율이다(자동 테스트 없음); user-only 확정은 init이 항상 AskUserQuestion을 거치는 구조로 보장된다.
3. 반환 envelope.payload의 `suspicious_active` / `post_finish_mutated` 배열이 비어있지 않으면 제안·요약에 해당 run 목록을 ⚠️ 주의로 함께 표기한다 — 후보/제안 유무와 무관하게(라벨만 있는 경우에도 출력; 위와 동일한 prose-only 규율).
`<episode_request_id>`는 이 hill-climb maker 생성 전에 한 번 정하고 response-loss retry에는
그대로 재사용한다. 다음 intentional maker만 새 ID를 사용한다.
