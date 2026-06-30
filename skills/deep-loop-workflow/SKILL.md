---
name: deep-loop-workflow
description: |
  deep-loop 비공개 코어 워크플로우 — 프로토콜 adapter 4-verb(dispatch/awaitResult/checker/readArtifacts) 수행법,
  리뷰 전략 조립, 자율 handoff/respawn 호출 규약을 정의한다. deep-loop 진입·continue 스킬이 references로 로드한다.
user-invocable: false
---

# deep-loop-workflow 비공개 워크플로우

이 스킬은 user-invocable이 아닌 **내부 참조** 문서다. deep-loop 진입·continue 스킬이 `Read()`로 로드한다.

사용자 언어(language)를 감지하여 같은 언어로 응답한다.

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
- 모든 mutating CLI는 `--owner <run_id> --generation <n>` fence 필수.
- `loop.json` · `event-log.jsonl` · `.loop.hash`는 커널만 쓴다 — 스킬은 절대 직접 쓰지 않는다.
