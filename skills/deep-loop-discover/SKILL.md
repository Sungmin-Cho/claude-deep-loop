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

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-discover`, Codex에서 `$deep-loop:deep-loop-discover` 형식을 사용한다.

## 개요

`/deep-loop-discover` — 저장소, git 상태, sibling artifact, 기존 loop 상태를 스캔해 후보 작업 항목을 발견(discover)하고 영속한다.

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. mutation fence는 아래 fresh lease read에서 분리해 얻는다.

## 단계 1: 현재 Loop 상태 확인

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" comprehension status --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 새로 읽는다. 이후 state patch는 이 current fence와 불변 `<run_id>`를 함께 쓴다.

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
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state patch --field discovered_items --value '<json_array>' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

## 단계 5: 다음 단계 안내

후보 목록을 요약 출력하고 `/deep-loop-triage`로 분류를 권장한다.
