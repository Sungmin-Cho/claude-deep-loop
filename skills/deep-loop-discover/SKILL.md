---
name: deep-loop-discover
description: "deep-loop manual discovery heartbeat — surveys the repo, git state, sibling artifacts, and existing loop state to find candidate work items, then persists them. Triggered by '/deep-loop-discover', 'discover work', 'find next work', 'what should I do next', '할 일 발견', '작업 발견', '다음 할 일 찾기', cross-platform Skill({ skill: \"deep-loop:deep-loop-discover\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.

## 개요

`/deep-loop-discover` — 저장소, git 상태, sibling artifact, 기존 loop 상태를 스캔해 후보 작업 항목을 발견(discover)하고 영속한다.

## 단계 1: 현재 Loop 상태 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" comprehension status
```

comprehension debt(`debt_ratio`)가 임계치(보통 0.5)를 초과하면 새 fan-out 자제 — 사람 검토(`/deep-loop-ack --actor human`)를 먼저 요청한다. 기계 리뷰(checker APPROVE)는 debt를 줄이지 않으므로 사람 ack만 새 fan-out을 해제한다.

## 단계 2: 스캔

다음 영역을 조사한다:

- **저장소 상태**: git status, 미병합 브랜치, open PR, TODO/FIXME 주석
- **Sibling artifact**: deep-work 진행 상황(`.deep-work/`), deep-wiki 업데이트 필요 여부
- **기존 discovered_items**: 중복 발견 방지
- **워크스트림 상태**: `state get --field workstreams`로 blocked/pending 확인

## 단계 3: 후보 목록 조립

발견한 항목을 JSON 배열로 조립:
```json
[
  { "id": "item-001", "title": "Fix auth bug", "source": "git-status", "priority": "high" },
  { "id": "item-002", "title": "Update README", "source": "todo-scan", "priority": "low" }
]
```

## 단계 4: 영속

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state patch --field discovered_items --value '<json_array>' --owner <run_id> --generation <n>
```

## 단계 5: 다음 단계 안내

후보 목록을 요약 출력하고 `/deep-loop-triage`로 분류를 권장한다.
