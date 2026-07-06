---
name: deep-loop-status
description: "deep-loop status — shows the current run's status, budget, comprehension debt, circuit breaker, pending human reviews, session chain, and workstreams. Read-only. Triggered by '/deep-loop-status', 'loop status', 'show the loop', 'where are we', '루프 상태', '상태 보기', '진행 상황', cross-platform Skill({ skill: \"deep-loop:deep-loop-status\" })."
user-invocable: true
---

사용자의 언어(language)를 감지하여 같은 언어로 응답한다.

## 개요

`/deep-loop-status` — 현재 run의 상태(status), 예산, comprehension debt, circuit breaker, 미검토 episode, session chain, workstream 표를 **읽기 전용**으로 표시한다.

## 조회 순서

### 1. 전체 Loop 상태

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get
```

`status`, `goal`, `protocol`, `created_at`을 출력한다.

### 2. 예산 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" budget check
```

`spent`(turns), `tokens_spent`, 남은 예산, `ok` 여부를 출력한다.

### 3. Comprehension Debt

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" comprehension status
```

`debt_ratio`, `episodes_total`, `episodes_human_reviewed`를 출력한다.

### 4. Circuit Breaker

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" breaker check
```

- `tripped: false`이면 정상.
- `tripped: true`이면 **사람이** 직접 reset해야 한다:
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" breaker reset --confirm --owner <run_id> --generation <n>
  ```
  (사람 + lease-owner 전용 경로 — autonomous tick은 `--confirm`을 자동으로 주지 않는다.)

### 5. Workstream 표

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field workstreams
```

각 workstream의 `id`, `title`, `status`, `review_points_done`을 표 형태로 출력한다.

### 6. 미검토 Episode

comprehension `episodes_human_reviewed`가 낮으면 미검토 episode 목록을 출력하고 `/deep-loop-ack --actor human`을 안내한다(사람 검토만 게이트를 해제하며, `episodes_agent_reviewed`는 기계 리뷰 계상으로 debt에 무관하다).

### 7. 막힌(stranded) non-terminal episode

`next-action`이 `await_human`을 반환하고 `reason`이 `orphan-maker-no-artifacts`(proof-impossible: `expected_artifacts: []`라 절대 `done`이 될 수 없는 maker)이거나, 기타 터미널에 도달하지 못한 채 막힌 episode일 때는 사람이 해당 episode를 abandon으로 정착(settle)시켜 finish를 풀어준다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode abandon --id <id> --reason "<why>" --confirm --owner <run_id> --generation <n>
```

(`--confirm` + lease fence(`--owner`/`--generation`)는 사람 전용 경로 — autonomous tick은 자동으로 주지 않는다. abandon 후 episode는 `abandoned`(settled)가 되어 finish 게이트가 풀린다.)

## 다음 명령 제안

상태에 따라 적절한 다음 명령을 제안한다:
- 정상 진행 중: `/deep-loop-continue`
- handoff 대기: `/deep-loop-resume`
- 완료 가능: `/deep-loop-finish`
- breaker tripped: `breaker reset --confirm --owner <run_id> --generation <n>` (사람 직접 실행)
