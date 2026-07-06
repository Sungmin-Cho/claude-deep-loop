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
> **이 스킬은 사람 검토(human ack)의 진입점** — comprehension 게이트(사람 감독)를 해제하는 유일한 경로다. 따라서 `--actor human --confirm`을 쓴다. **autonomous/headless tick은 이 커맨드를 사람으로 발행하지 않는다** — 커널이 headless 마커를 감지하면 `comprehension-ack-rejected`를 event-log에 남기고 fail-closed 거부한다(사후 감사 대상).

## 개요

`/deep-loop-ack` — 사람이 검토(ack)한 episode를 사람 자격으로 표시해 comprehension debt를 줄인다. debt가 줄면 루프가 새 작업을 fan-out할 수 있다. checker의 기계 리뷰(APPROVE)는 agent 카운터(`episodes_agent_reviewed`)로만 계상되어 debt를 **줄이지 않는다** — 사람 검토(이 스킬)만 게이트를 연다.

## 단계 1: 미검토 Episode 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" comprehension status
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field episodes
```

`human_reviewed: false`인 episode 목록을 확인한다.

## 단계 2: 검토 표시

사람이 검토한 episode ID를 받아 (**사람 검토이므로 `--actor human --confirm` 필수**):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" comprehension ack --episode <episode_id> --actor human --confirm --owner <run_id> --generation <n>
```

- 성공 시 `{ ok: true, debt_ratio }` 반환.
- **maker episode만 ack 대상** — checker 등 비-maker episode를 ack하면 `ACK_NOT_MAKER`(exit 1)로 거부된다(comprehension debt 분모는 maker만 세므로).
- `--confirm` 누락 시 `CONFIRM_REQUIRED`(exit 2). headless 세션이 `--actor human`을 주장하면 `ACK_REJECTED`(exit 2)로 거부되고 `comprehension-ack-rejected`가 event-log에 남는다.
- 이미 검토된 episode는 멱등 처리됨(카운트 중복 증가 없음).
- 존재하지 않는 episode ID는 거부(오버카운트 방지).
- 자동/기계 ack가 필요하면 `--actor agent`(기본값) — 단 이는 `episodes_agent_reviewed`로만 계상되어 **comprehension 게이트를 해제하지 않는다**.

## 단계 3: 결과 보고

갱신된 `debt_ratio`를 출력한다.

- comprehension 게이트(사람 검토)는 `--actor human`만 해제한다. checker의 기계 리뷰(APPROVE)와 `--actor agent` ack는 별도 agent 카운터로만 계상되어 debt를 줄이지 않는다(`require_human_ack`는 정직 신호로 true default이나, human/agent 카운터 분리가 실질 강제다).
- debt_ratio가 임계치 이하이면 `/deep-loop-continue`로 fan-out을 재개할 수 있음을 안내한다.
