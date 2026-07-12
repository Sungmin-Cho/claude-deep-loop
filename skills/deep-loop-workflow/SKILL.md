---
name: deep-loop-workflow
description: |
  deep-loop 비공개 코어 워크플로우 — 프로토콜 adapter 4-verb(dispatch/awaitResult/checker/readArtifacts) 수행법,
  리뷰 전략 조립, 자율 handoff/respawn 호출 규약을 정의한다. deep-loop 진입·continue 스킬이 references로 로드한다.
user-invocable: false
---

# deep-loop-workflow 비공개 워크플로우

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 모든 참조의 argv 템플릿에 있는 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

이 스킬은 user-invocable이 아닌 **내부 참조** 문서다. deep-loop 진입·continue 스킬이 `Read()`로 로드한다.

사용자 언어(language)를 감지하여 같은 언어로 응답한다.

## Lease identity vocabulary

`<run_id>`는 descriptor/current run이 정한 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. mutation 직전 `<owner_run_id>`는 fresh `session_chain.lease.owner_run_id`, `<generation>`은 fresh `session_chain.lease.generation`에서 읽는다. owner 세션이 바뀌어도 `<run_id>`를 재바인딩하지 않는다. 유일한 예외인 `lease acquire`는 예약된 `<child_run_id>`를 owner 인자로 쓰고 성공 후에만 그 값을 current `<owner_run_id>`로 승격한다.

## 어댑터(adapter) 4-verb 개요

프로토콜 어댑터는 4가지 verb로 구성된다. **Execution LLM이** 직접 수행하며, 커널은 호출하지 않는다(§1.1):

1. **dispatch** — maker 스킬을 invoke
2. **awaitResult** — maker 완료 폴링
3. **checker** — review dispatch/record
4. **readArtifacts** — 산출물 receipt 확인

각 verb의 상세 수행 방법은 `references/` 디렉터리 참조:

- **`references/adapters.md`** — 4-verb 수행 절차 (dispatch 디스크립터 해석, tier guard, checker 호출법)
- **`references/review-strategy.md`** — 리뷰 전략 확인 질문 흐름, `review` JSON 조립
- **`references/handoff-respawn.md`** — handoff emit, respawn 게이트, 비용 회계 모델

## 핵심 불변식

- 스킬은 상태를 **읽기만** — `state get`, `next-action`, `adapter resolve`, `budget check` 등 read-only CLI.
- **변경은 반드시 mutating CLI subcommand로만** (`state patch`, `episode new/record/abandon`, `review dispatch/record`, `handoff emit`, `budget record`, `comprehension ack`, `finish` 등).
- 모든 mutating CLI는 `--owner <owner_run_id> --generation <n> --run-id <run_id>` fence/identity 필수(`lease acquire`의 owner만 예약된 child 예외).
- `loop.json` · `event-log.jsonl` · `.loop.hash`는 커널만 쓴다 — 스킬은 절대 직접 쓰지 않는다.
