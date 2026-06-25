---
name: deep-loop-ack
description: "deep-loop acknowledge — marks an episode/diff as human-reviewed, reducing comprehension debt so the loop can fan out new work. Triggered by '/deep-loop-ack', 'ack the review', 'mark reviewed', 'I reviewed it', '검토 완료', '리뷰 확인', '이해 표시', cross-platform Skill({ skill: \"deep-loop:deep-loop-ack\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.

## 개요

`/deep-loop-ack` — 사람이 검토(ack)한 episode를 표시해 comprehension debt를 줄인다. debt가 줄면 루프가 새 작업을 fan-out할 수 있다.

## 단계 1: 미검토 Episode 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" comprehension status
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field episodes
```

`human_reviewed: false`인 episode 목록을 확인한다.

## 단계 2: 검토 표시

사람이 검토한 episode ID를 받아:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" comprehension ack --episode <episode_id> --owner <run_id> --generation <n>
```

- 성공 시 `{ ok: true, debt_ratio }` 반환.
- 이미 검토된 episode는 멱등 처리됨(카운트 중복 증가 없음).
- 존재하지 않는 episode ID는 거부(오버카운트 방지).

## 단계 3: 결과 보고

갱신된 `debt_ratio`를 출력한다.

- `require_human_ack=true` 설정이면 이 스킬만 comprehension 카운트를 인정한다(deep-review APPROVE 자동 카운트 안 함).
- debt_ratio가 임계치 이하이면 `/deep-loop-continue`로 fan-out을 재개할 수 있음을 안내한다.
