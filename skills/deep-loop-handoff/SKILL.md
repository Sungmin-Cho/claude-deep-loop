---
name: deep-loop-handoff
description: "deep-loop manual handoff — escape hatch to emit a clean handoff (and optionally respawn) without waiting for a milestone. Triggered by '/deep-loop-handoff', 'hand off now', 'emit handoff', 'pass to a fresh session', '핸드오프', '인수인계', '새 세션으로 넘기기', cross-platform Skill({ skill: \"deep-loop:deep-loop-handoff\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.

## 개요

`/deep-loop-handoff` — 마일스톤 없이 언제든 깔끔한 handoff(인수인계)를 emit하고, 선택적으로 respawn한다.

## 단계 1: 현재 Lease 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.lease
```

`owner_run_id`와 `generation`을 확인한다.

## 단계 2: Handoff Emit

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" handoff emit --owner <run_id> --generation <n>
```

산출물:
- `handoffs/<timestamp>-next-session.md` — 다음 세션용 컨텍스트
- `handoffs/<timestamp>-compaction-state.json` — 압축 상태
- `terminal/launch-command.txt` — 재시작 명령

## 단계 3: Respawn 또는 사람 제시

### Interactive (사람 개입)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.latest_handoff.launch_command_path
```

`terminal/launch-command.txt` 내용을 사람에게 제시한다. 사람이 직접 새 세션을 시작한다.

자동 spawn은 **드라이버만 수행**한다 — 이 스킬은 직접 `claude -p`를 실행하지 않는다(§9).

### Headless / 미감시 자율

`DEEP_LOOP_UNATTENDED` set 시 드라이버(`drive-headless.mjs`)가 respawn을 자동으로 처리한다.

### Respawn 게이트 차단 시

respawn 게이트(budget/breaker/sessions/wallclock)가 차단하면 `status=paused`로 기록되고 수동 resume을 안내한다.

## 다음 세션

새 세션에서 `/deep-loop-resume`을 실행해 handoff.md를 읽고 lease를 인수한다.
