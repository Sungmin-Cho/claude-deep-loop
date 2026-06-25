---
name: deep-loop-continue
description: "deep-loop main tick — advances the loop one step: checks budget/breaker/comprehension gates, reads next-action, dispatches the maker or checker, records the outcome, decides whether to hand off, and pre-emptively respawns at a milestone or per-session turn cap. Triggered by '/deep-loop-continue', 'continue the loop', 'advance the loop', 'next tick', '루프 진행', '루프 계속', '다음 tick', '계속 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-continue\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> **maker/checker 분리 유지** — 같은 세션이 동일 workstream의 maker와 checker를 겸하지 않는다.

## 개요

`/deep-loop-continue` — 루프를 한 단계 진행(tick)한다. 게이트 검사 → next-action 읽기 → dispatch/record → Decide → 필요 시 handoff+respawn.

## 0. Run ID / Generation 확보

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.lease
```

현재 세션이 `owner_run_id`인지 확인한다. 아니면 `/deep-loop-resume`으로 lease를 인수해야 한다.

`run_id` = `lease.owner_run_id`, `generation` = `lease.generation`.

## 1. 게이트 검사 (항상 먼저)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" next-action --json
```

- `gate.allowed === false` 또는 `action.type ∈ {handoff, await_human}`이면:
  - **budget 소진**: `handoff emit --owner <run_id> --generation <n>` 실행 후 사람에게 재시작 안내.
  - **breaker tripped**: `/deep-loop-status`로 상태 확인 후 사람이 `breaker reset --confirm --owner <run_id> --generation <n>` 실행 필요 — **autonomous tick은 스스로 `--confirm`을 주지 않는다.**
  - **await_human**: 사람 입력 요청 후 종료.

## 2. Action 분기 (next-action이 반환한 `action.type`대로, 스스로 판단 추가 금지)

### dispatch_maker

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" adapter resolve --protocol <protocol> --task "<brief>" --tier <gate.tier_after>
```

`guard.ok === false`이면 dispatch 중단 → `await_human` 안내.

진행 시 episode in_progress로 기록:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode record --id <episode_id> --status in_progress --owner <run_id> --generation <n>
```

sibling `Skill({ skill: dispatch.skill, args: dispatch.args })`으로 invoke. 완료 후:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode record --id <episode_id> --status done --artifacts '["path/to/artifact"]' --proof '{}' --owner <run_id> --generation <n>
```

### dispatch_checker

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --owner <run_id> --generation <n>
```

checker 스킬 invoke 후 verdict 기록:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" review record --episode <checker_episode_id> --workstream <workstream_id> --point <review_point> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --owner <run_id> --generation <n>
```

### fix_episode

fix maker episode 생성 후 dispatch:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode new --plugin <maker_plugin> --role maker --kind fix --point <point> --workstream <workstream_id> --artifacts '["path/to/fix-output"]' --owner <run_id> --generation <n>
```

### discover

`/deep-loop-discover` 안내 (또는 invoke).

### await_result

`adapter resolve`의 `await.path` 폴링.

### finish

`/deep-loop-finish` 안내.

## 3. 비용 기록

Interactive tick은 best-effort로 self-report:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" budget record --turns <n> --owner <run_id> --generation <n>
```

**`DEEP_LOOP_UNATTENDED` set 시 자기보고를 생략** — drive-headless 드라이버가 측정 usage를 권위있게 기록하므로 이중계상 방지.

## 4. Decide (마일스톤 / Turn Cap)

마일스톤(`milestone_predicate`) 통과 또는 `per_session_turn_cap` 도달 시:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" handoff emit --owner <run_id> --generation <n>
```

respawn은 드라이버 또는 사람이 수행한다. 아니면 다음 episode 안내 후 종료.
