# Handoff — deep-loop Plan 3 (Execution plane + 패키징 + 등록) 작업 인수인계

작성일: 2026-06-24
작성 세션 산출: **Plan 2(오케스트레이션 기계)** 설계·리뷰·구현·재리뷰 완료
대상: **새 세션에서 Plan 3을 이어서 진행하는 작업자(사람 또는 에이전트)**

> **source of truth 규칙 (deep-loop 자체 철학과 동일):** 이 문서와 아래 참조 파일들을 source of truth로 사용하라. **이전 대화 컨텍스트를 가정하지 말라.** 모든 사실은 repo의 파일과 `git log`에 있다.

---

## 0. 30초 요약

`deep-loop`은 Addy Osmani의 **Loop Engineering**을 deep-suite 위의 **cross-plugin 오케스트레이션 control plane**으로 구현하는 독립 Claude Code/Codex 플러그인이다. 2-plane 아키텍처(결정론적 Node Control plane + LLM Execution plane).
- **Plan 1(결정론적 커널 하부)** = 완료·머지됨 (state/integrity/budget/breaker/comprehension/schema/envelope/slug/detect/recipes/initrun).
- **Plan 2(오케스트레이션 기계)** = **완료**: lease·workspace·episode·review·adapters·next-action·handoff·respawn + CLI. Codex 2-way 리뷰 루프로 설계(6라운드 APPROVE)·구현(16라운드 APPROVE) 검증. **175 테스트 green, `npm run preflight` PASS.**
- **당신의 일 = Plan 3**: **Execution plane(스킬 10개) + PreCompact hook 실배선 + headless spawn 드라이버 + recipes/automation + README/CHANGELOG + marketplace 등록**을 같은 방식으로 설계→리뷰→구현→재리뷰.

작업 위치: `/Users/sungmin/Dev/claude-plugins/deep-loop`. **Plan 1+2는 `main`에 있다(이 PR 머지 후).** 새 worktree를 `main`에서 만들어 시작하라.

---

## 1. 반드시 먼저 읽을 참조 파일 (우선순위 순)

1. **설계 스펙** `docs/superpowers/specs/2026-06-24-deep-loop-design.md` — 전체 v1 아키텍처. Plan 3이 구현할 부분: **§3(10개 사용자 스킬), §1.1(커널↔Execution 계약 — 커널은 스킬을 호출 안 함, Execution LLM이 dispatch), §6(어댑터 4-verb를 LLM이 수행), §7(리뷰 전략 확인 질문), §9(자율 handoff/respawn 호출자 3종 — Continue Decide / PreCompact hook / 수동), §10(sibling dispatch/read 계약), §11(설치 감지+graceful degradation), §12(end-of-work finish), §13(marketplace 등록), §2(hooks PreCompact 1개), §16(버전 로드맵).**
2. **Plan 2 플랜 + 구현 리뷰 로그** `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan2-orchestration.md`, `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan2-impl-review-log.md` — Plan 3 플랜의 형식·세분화·TDD 스타일 모범 + 어떤 결함이 잡혔는지(같은 함정 회피).
3. **Plan 1 플랜 + 리뷰 로그** `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan1-kernel.md` 외 — 커널 형식 참고.
4. **이전 handoff** `docs/handoff/2026-06-24-plan2-kernel-orchestration-handoff.md` — Plan 2 인수인계(프로세스/리뷰 하네스의 출처).

---

## 2. 현재 repo 상태 (Plan 1+2 완료)

`main`(이 PR 머지 후) 기준. `npm test` = **175 green**, `npm run preflight` = PASS, 외부 의존성 0. Node>=20, type:module.

```
deep-loop/
  scripts/
    deep-loop.mjs   # CLI 디스패처. subcommand: validate, detect-plugins, recipe-match, init-run,
                    #   lease(acquire|release|check), next-action, tick, episode(new|record),
                    #   workstream(new|set|terminal), review(dispatch|record), handoff(emit), respawn
    lib/
      # Plan 1: state integrity budget breaker comprehension schema envelope slug detect recipes initrun log
      # Plan 2: lease workspace episode review adapters next-action handoff respawn
  protocols/{deep-work,superpowers,standalone}.json   # 4-verb 선언적 어댑터
  recipes/*.json (6개)
  schemas/loop-run.schema.json
  tests/*.test.mjs (23개 파일, 175 테스트)
  docs/{research,superpowers/{specs,plans},handoff}/...
```

**아직 없음(= Plan 3가 만들 것):** `skills/deep-loop*/SKILL.md` (10개) + `skills/deep-loop-workflow/references/*.md`, `hooks/hooks.json` + `hooks/scripts/precompact-handoff.{sh,mjs}`, `recipes/automation/*.yml`, headless `spawnFn` 실구현, `README.md`/`README.ko.md`/`CHANGELOG.md`, marketplace 등록 파일들.

---

## 3. Plan 2가 노출하는 인터페이스 (Plan 3가 소비 — 정확한 시그니처)

**Execution plane 스킬은 상태를 읽고, 변경은 오직 CLI subcommand로만 한다(2-plane 경계, §1.1). 직접 loop.json 쓰기 금지. 커널은 스킬을 호출하지 않으니, 스킬이 `next-action`을 읽고 dispatch를 수행한다.**

### CLI 계약 (`node scripts/deep-loop.mjs <sub> --project-root <p> --run-id <id> ...`)
모든 **변경(mutating)** 명령은 `--owner <run_id> --generation <n>`(lease fence)을 요구한다 — 불일치/누락 시 `LEASE_FENCED`/`FENCE_REQUIRED`로 거부(종료코드 3).
```
init-run --goal --protocol --recipe --review <json>     # run 생성
detect-plugins                                          # sibling 감지 JSON
recipe-match --goal                                     # recipe+protocol 매칭
validate [--run-id]                                     # 스키마+해시 검증
next-action [--json]                                    # 다음 행동 디스크립터(dispatch 안 함)
tick --mode discover|triage|advance|full                # next-action 반환(스스로 판단 안 함)
lease acquire|release|check --owner --generation [--expect-generation]
episode new --plugin --role --kind --point [--workstream] [--artifacts <json>] --owner --generation
episode record --id --status --artifacts <json> --proof <json> --owner --generation   # approved/rejected는 거부 → review record 사용
workstream new --title --branch --worktree [--depends-on <json>] --owner --generation
workstream set --id --status --owner --generation       # 비-터미널만
workstream terminal --id --status --proof <json> --owner --generation   # ready/merged/abandoned (proof 파생)
review dispatch --point --workstream --owner --generation
review record --episode --workstream --point --verdict [--source] --owner --generation
handoff emit [--reason] [--trigger] [--headless] --owner --generation
respawn [--dry-run]                                      # 게이트 평가만; 실제 spawn은 driver-provided spawnFn (= Plan 3)
```

### lib 함수 (스킬이 직접 import하지 않음 — CLI 경유. 단 Plan 3의 headless 드라이버/hook glue는 import 가능)
```
lease.mjs:    deriveIdempotencyKey · leaseCheck(loop,{owner,generation,intent}) · acquireLease(root,runId,{owner,expectGeneration,now})
              releaseLease · reserveHandoff(...,{trigger,now,expect}) · advanceHandoffPhase(...,{key,toPhase,now,expect}) · rollbackHandoff
workspace.mjs:newWorkstream(...,{...,fence}) · setWorkstreamStatus(...,{fence}) · recordWorkstreamTerminal(...,{status,proof,fence})
              inheritWorkstreams(root,runId)→{inherited,missing} · integrationOrder(loop)→{order,cycle,missing}
episode.mjs:  newEpisode(...,{...,fence})→{id,requestPath} · recordEpisode(...,{status,artifacts,proof,fence})
review.mjs:   resolveReviewer(loop,detected) · parseVerdict(text) · dispatchReview(...,{point,workstreamId,detected,fence}) · recordReviewOutcome(...,{episodeId,verdict,source,fence})
adapters.mjs: loadProtocol(name) · resolveAdapter(name)→{dispatch,awaitResult,checker,readArtifacts} · guardTierProtocol(tier,protocol,verb)
next-action.mjs: nextAction(loop,{now})→{gate,action,next_command}   # action.type ∈ discover|dispatch_maker|dispatch_checker|fix_episode|await_result|await_human|handoff|finish
handoff.mjs:  buildLaunchCommand({root,parentRunId,childRunId,handoffRel,headless}) · emitHandoff(root,runId,{reason,trigger,now,headless,expect})→{ok,childRunId,key,handoffRel,...}
respawn.mjs:  respawnGate(loop,{now})→{ok,blocked_by,reason} · respawn(root,runId,{childRunId,key,handoffRel,headless,now,spawnFn})→{ok,outcome,reason,childRunId}
```
**respawn의 `spawnFn`이 Plan 3의 핵심 미배선 지점**: `defaultSpawn`은 `SPAWN_NOT_WIRED` throw. headless 자율 모드(§9)는 Plan 3가 `child_process`로 `claude -p ...`를 spawn하는 `spawnFn`을 주입해야 한다. interactive는 `buildLaunchCommand`의 명령을 사람/터미널에 제시.

---

## 4. Plan 3가 만들 것 (스펙 매핑)

| 산출물 | 스펙 | 핵심 |
|---|---|---|
| `skills/deep-loop/SKILL.md` | §3 | 진입(user-invocable). run 시작: detect→recipe/protocol→**리뷰 전략 확인 질문(§7)**→workstream 분해(§8)→`init-run`→첫 episode→다음 명령 |
| `skills/deep-loop-workflow/SKILL.md` + `references/*.md` | §3 | 비공개 무거운 로직(어댑터 4-verb 수행법, dispatch/await/checker/readArtifacts를 `Skill()`/poll로) |
| `skills/deep-loop-{discover,triage,continue,handoff,resume,status,ack,finish}/SKILL.md` | §3·§9·§12 | discover/triage 판단, **continue=메인 tick**(게이트→`next-action` 읽고 dispatch→record→Decide→필요 시 `handoff emit`+`respawn`), resume(handoff.md+loop.json만 읽고 이어감), finish(final-report→memory→wiki) |
| `hooks/hooks.json` + `hooks/scripts/precompact-handoff.{sh,mjs}` | §2·§9 | PreCompact 1개 → `handoff emit`(+respawn). Bash 3.2 호환(`set -Eeuo pipefail`) |
| headless `spawnFn` 드라이버 | §9·§9.1 | `respawn`에 주입할 `child_process` 기반 `claude -p` spawn. 측정불가 시 fail-closed |
| `recipes/automation/{cron-morning-triage.yml,github-actions-loop.yml}` | §2 | 무인 자동화 템플릿 |
| README/README.ko/CHANGELOG/docs | §2 | 사용자 문서 |
| marketplace 등록 | §13 | build→push(사용자 승인)→SHA→deep-suite 3파일 lockstep→preflight (또는 patch plan) |

---

## 5. 따라야 할 프로세스 (Plan 2와 동일 — 검증됨)

1. **새 worktree를 `main`에서 생성** (`superpowers:using-git-worktrees`; EnterWorktree).
2. **`superpowers:writing-plans`로 Plan 3 작성** → `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan3-execution.md`. Plan 1·2와 동일 bite-sized TDD 형식. 스킬은 LLM-facing이라 TDD가 어려운 부분이 있으니, 결정론 글루(hook impl, headless spawnFn, recipes JSON)는 단위테스트, SKILL.md는 구조/트리거/언어 검증.
3. **Plan 3에 대해 Codex-only 2-way 리뷰 루프** (아래 §6 하네스) → APPROVE 수렴.
4. **`superpowers:subagent-driven-development`로 구현** (implementer는 sonnet, 게이트 = `npm test` green + 스킬 frontmatter 검증).
5. **구현 결과에 대해 Codex-only 2-way 리뷰 루프** → APPROVE 수렴.
6. PR + merge + (사용자 승인 시) marketplace 등록.

---

## 6. Codex 리뷰 하네스 (이번 세션에서 검증됨 — 그대로 재사용)

```bash
# review-schema.json (codex 0.137.0은 strict 스키마 — 모든 object에 "additionalProperties": false 필수!)
cat review-prompt.txt | codex exec -s read-only --output-schema review-schema.json \
  --color never --skip-git-repo-check - > out.json
# out.json.verdict ∈ {APPROVE,CONCERN,REQUEST_CHANGES}; REQUEST_CHANGES/CONCERN이면 findings 반영 후 재리뷰, APPROVE까지.
```
review-schema.json (이번 세션 사용본 — **additionalProperties:false 추가됨**):
```json
{"type":"object","additionalProperties":false,"required":["verdict","summary","findings"],"properties":{
 "verdict":{"type":"string","enum":["APPROVE","CONCERN","REQUEST_CHANGES"]},
 "summary":{"type":"string"},
 "findings":{"type":"array","items":{"type":"object","additionalProperties":false,
   "required":["severity","section","title","detail","recommendation"],
   "properties":{"severity":{"type":"string","enum":["critical","should-fix","info"]},
     "section":{"type":"string"},"title":{"type":"string"},
     "detail":{"type":"string"},"recommendation":{"type":"string"}}}}}}
```
프롬프트엔 (a) 대상 파일 절대경로, (b) 스펙/불변식 경로, (c) 무엇을 헌팅할지(§7 불변식)를 명시. read-only 샌드박스라 codex는 파일 읽기만 — 소스 리뷰 기반 판정(충분히 유효). receiving-review 프로토콜대로 각 finding을 **기술 검증 후** 수락/반박. 리포트는 `.deep-review/reports/`, 루프 요약은 `.deep-review/responses/`에 저장하면 됨(gitignore 대상).

---

## 7. 절대 깨지 말 불변식 (Plan 1·2에서 확립, Codex가 강제 확인)

1. **2-plane 경계 + §1.1**: Execution plane(스킬)은 상태를 **읽고**, 변경은 **CLI subcommand로만**. 커널은 스킬을 함수로 호출 안 함 — 스킬이 `next-action`을 읽고 dispatch(`Skill()` invoke 또는 headless `claude -p`). respawn만 주입된 `spawnFn`으로 프로세스 spawn.
2. **모든 변경 CLI는 lease fence 필수**(`--owner --generation`) — 누락/불일치 거부. handoff/respawn 멀티-스텝은 generation 펜싱이 lock 내부에서 원자적.
3. **이벤트+상태 변경은 단일 `appendAnchored` 트랜잭션**(half-commit 불가). 무결성은 탐지+fail-stop(append 전 verifyLog/verifyHead — truncation launder 불가).
4. **터미널 상태는 proof 파생·monotonic**: episode done/approved/rejected, workstream ready/merged/abandoned는 커널이 proof에서만. 스킬이 직접 못 씀. checker approved/rejected는 `review record` 경유만(episode record로 우회 불가).
5. **비가역 외부 행동(push/merge/publish/delete)은 v1에서 전부 proposal-only**, 항상 사람 승인. workstream `merged`는 사람 승인 proof(merge_commit+human_approved) 필요.
6. **respawn 게이트 순서**: budget→breaker→max_sessions→wallclock→auto_handoff. acting tier로 게이팅하지 않음(세션 연속 ≠ 외부 행동). 미감시 자율은 headless 강제.
7. **worktree 연속성 결정론**(고아화 ❌, `inheritWorkstreams` 경로소실 시 fail-safe). handoff/loop.json이 source of truth, "이전 대화 가정 금지".
8. **project root 밖 쓰기 ❌** (단 finish의 deep-memory/deep-wiki sibling 위임 예외). `runId`는 안전한 단일 경로 세그먼트만.
9. circuit breaker는 임계(연속 REQUEST_CHANGES 3)에서 latch → 사람 reset 전용. comprehension debt 임계 초과 시 **새 maker fan-out**만 중단(현재 episode 진행·fix·리뷰는 허용).

---

## 8. 시작 명령 (새 세션에 그대로)

```
cd /Users/sungmin/Dev/claude-plugins/deep-loop   (Plan 1+2가 머지된 main)
이 파일(docs/handoff/2026-06-24-plan3-execution-plane-handoff.md)과 §1의 참조들을 읽어라.
이전 대화 컨텍스트를 가정하지 말라.
`npm test`로 175 green을 확인하라(현재 상태 기준선).
superpowers:using-git-worktrees 로 main에서 새 worktree를 만들고,
superpowers:writing-plans 로 Plan 3(Execution plane 스킬 + hook + headless spawn + recipes + 문서 + 등록) 플랜을 작성하고,
Codex-only 2-way 리뷰 루프(§6)로 수렴시킨 뒤, SDD로 구현하고, 다시 Codex 리뷰 루프로 검증하라.
§7 불변식을 절대 깨지 말라. CLI(§3)가 유일한 상태 변경 경계다.
```
