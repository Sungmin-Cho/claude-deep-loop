---
name: deep-loop
description: "Loop Engineering control plane entry — starts a durable cross-plugin orchestration run over the deep-suite. Detects siblings, matches a recipe/protocol, asks the review strategy, decomposes the goal into workstreams, creates the run, and prints the next command. Triggered by '/deep-loop \"<goal>\"', 'start a loop', 'loop engineering', 'orchestrate this work', '루프 시작', '딥루프 시작', '루프 엔지니어링', cross-platform Skill({ skill: \"deep-loop:deep-loop\", args: \"<goal>\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어를 감지하여 같은 언어(language)로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인을 받는다.
> **maker/checker 분리 유지** — 같은 세션이 동일 workstream의 maker와 checker를 겸하지 않는다.

## 개요

`/deep-loop "<goal>"` — deep-suite 전체를 아우르는 내구성 있는 크로스-플러그인 오케스트레이션 run을 시작한다. loop engineering 진입점.

## 단계 1: 기존 Run 감지

먼저 진행 중인 run이 있는지 확인한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field status
```

- 결과가 `running`이면 `/deep-loop-status`로 현황을 보여주고 이어가기 또는 새 run 시작 중 선택을 요청한다.
- `null` 또는 파일 없음이면 새 run을 시작한다.

## 단계 2: Run 시작

### 2-1. Sibling 플러그인 감지

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" detect-plugins
```

감지된 플러그인 목록을 확인한다(deep-work, deep-review, deep-wiki, deep-memory 등).

### 2-2. Recipe + Protocol 결정

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" recipe-match --goal "<goal>"
```

반환된 `recipe_id`와 `protocol`을 사용자에게 제안한다. 최종 확정은 사람이 한다(`recipe_override_auth=user-only`).

### 2-3. 리뷰 전략 확인

리뷰 전략을 결정한다(§7). 자세한 흐름은 `Read("../deep-loop-workflow/references/review-strategy.md")`를 참조:

- **deep-review 감지 시**: 기본 추천 `deep-review:deep-review-loop --contract --codex`(cross-model)
- **미감지 시**: codex 2-way / 서브에이전트 checker / standalone 중 선택 → 사용자 확정

결과를 `review` JSON으로 조립:
```json
{
  "points": ["design", "plan", "implementation"],
  "reviewer": "subagent-checker",
  "mode": "cross-model",
  "flags": [],
  "converge": true,
  "max_review_rounds": 5,
  "require_human_ack": false
}
```

### 2-4. Workstream 분해

큰 goal이면 N개 workstream(각각 하나의 PR)을 제안하고 사람 확인을 받는다("[이대로/조정/단일 PR로]"). 작은 작업이면 1 workstream 자동 결정.

### 2-5. Run 생성 (`init-run`)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" init-run \
  --goal "<goal>" \
  --protocol <protocol> \
  --recipe <recipe_id> \
  --review '<review_json>'
```

`--recipe`는 `recipe-match`가 반환한 recipe **id 문자열**(예: `robust-implementation`)이다 — JSON이 아님.
`run_id`를 받아 저장한다. 이후 모든 mutating CLI는 `--owner <run_id> --generation 1`.

### 2-6. Workstream 생성

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" workstream new \
  --title "<workstream title>" \
  --branch "<branch-name>" \
  --worktree "<worktree-path>" \
  --owner <run_id> --generation 1
```

의존 관계가 있으면 `--depends-on '<["ws-id-1"]>'`도 추가.

### 2-7. 첫 번째 Episode 생성

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode new \
  --plugin <maker_plugin> \
  --role maker \
  --kind implementation \
  --point design \
  --workstream <workstream_id> \
  --artifacts '["path/to/expected-output.md"]' \
  --owner <run_id> --generation 1
```

`--artifacts`는 필수다 — maker `done` 전이는 비어있지 않은 `expected_artifacts`와 실제 파일 존재를 요구한다.
expected 경로는 `adapter resolve`의 `read.path` 또는 계획된 산출물에서 도출한다.

## 단계 3: 완료 메시지

run_id와 workstream 요약을 출력하고 다음 명령을 안내한다:

```
/deep-loop-continue
```

이후 각 tick마다 `/deep-loop-continue`를 호출해 루프를 진행한다.
