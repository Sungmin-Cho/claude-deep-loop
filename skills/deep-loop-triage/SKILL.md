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

## 개요

`/deep-loop-triage` — discovered 후보를 `actionable / needs_human / blocked / archived`로 분류(triage)한다.

## 단계 1: 후보 읽기

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field discovered_items
```

## 단계 2: 분류 기준

각 항목을 다음 기준으로 분류한다:

- **actionable**: 현재 세션이 자율적으로 진행 가능. 명확한 목표, 필요한 artifact 접근 가능.
- **needs_human**: 사람 결정 또는 승인 필요. 비가역적 외부 행동, 미명확 요구사항.
- **blocked**: 다른 작업 완료 대기. 의존성 미충족.
- **archived**: 더 이상 관련 없음. 중복, 해결됨, 범위 밖.

## 단계 3: 분류 결과 저장

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state patch --field triage.actionable --value '["item-001"]' --owner <run_id> --generation <n>
```

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state patch --field triage.needs_human --value '["item-002"]' --owner <run_id> --generation <n>
```

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state patch --field triage.blocked --value '[]' --owner <run_id> --generation <n>
```

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state patch --field triage.archived --value '[]' --owner <run_id> --generation <n>
```

## 단계 4: 다음 단계 안내

- **actionable** 항목이 있으면: `/deep-loop "<goal>"` 또는 `episode new`로 워크스트림 분해를 안내한다.
- **needs_human** 항목이 있으면: 사람에게 결정 요청 목록을 제시한다.
- **blocked** 항목이 있으면: 의존 항목 완료 후 재확인을 안내한다.
