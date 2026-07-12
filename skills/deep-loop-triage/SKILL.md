---
name: deep-loop-triage
description: "deep-loop triage — classifies discovered candidates into actionable / needs_human / blocked / archived. Triggered by '/deep-loop-triage', 'triage work', 'classify candidates', '작업 분류', '후보 분류', '트리아지', cross-platform Skill({ skill: \"deep-loop:deep-loop-triage\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-triage`, Codex에서 `$deep-loop:deep-loop-triage` 형식을 사용한다.

## 개요

`/deep-loop-triage` — discovered 후보를 `actionable / needs_human / blocked / archived`로 분류(triage)한다.

## 단계 0: Lease identity 확인

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. 저장 전에 current lease를 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 새로 읽는다. 분류 저장은 이 current fence와 불변 `<run_id>`를 함께 전달한다.

## 단계 1: 후보 읽기

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field discovered_items --project-root "<canonical_project_root>" --run-id <run_id>
```

## 단계 2: 분류 기준

각 항목을 다음 기준으로 분류한다:

- **actionable**: 현재 세션이 자율적으로 진행 가능. 명확한 목표, 필요한 artifact 접근 가능.
- **needs_human**: 사람 결정 또는 승인 필요. 비가역적 외부 행동, 미명확 요구사항.
- **blocked**: 다른 작업 완료 대기. 의존성 미충족.
- **archived**: 더 이상 관련 없음. 중복, 해결됨, 범위 밖.

## 단계 3: 분류 결과 저장

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state patch --field triage.actionable --value '["item-001"]' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state patch --field triage.needs_human --value '["item-002"]' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state patch --field triage.blocked --value '[]' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state patch --field triage.archived --value '[]' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

## 단계 4: 다음 단계 안내

- **actionable** 항목이 있으면: `/deep-loop "<goal>"` 또는 `episode new`로 워크스트림 분해를 안내한다.
- **needs_human** 항목이 있으면: 사람에게 결정 요청 목록을 제시한다.
- **blocked** 항목이 있으면: 의존 항목 완료 후 재확인을 안내한다.
