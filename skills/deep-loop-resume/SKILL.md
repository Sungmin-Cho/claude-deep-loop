---
name: deep-loop-resume
description: "deep-loop resume — entry point for a respawned fresh session: reads only the handoff.md and loop.json, acquires the session lease, attaches active worktrees, and continues. Triggered by '/deep-loop-resume', 'resume the loop', 'take over the session', 'continue handed-off work', '루프 이어가기', '세션 인수', '이어서 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-resume\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **handoff.md + loop.json만 읽는다** — 이전 대화 컨텍스트를 절대 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.

## 개요

`/deep-loop-resume` — 리스폰된(respawned) 새 세션의 진입점. handoff.md와 loop.json을 읽고, 세션 lease를 CAS 인수하고, active worktree를 확인한다.

## 단계 1: Handoff 문서 읽기

이전 대화 컨텍스트를 **가정하지 않는다**. 항상 handoff 문서에서 시작한다.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.sessions
```

마지막 세션 항목의 `handoff_rel` 또는 `handoff_path`에서 handoff.md 경로를 확인한다 (런 디렉터리 기준).
`.deep-loop/runs/<parent_run_id>/<handoff_rel>` 경로로 handoff.md를 Read한다.

## 단계 2: Lease 인수 (CAS)

handoff에서 `child_run_id`와 현재 `generation`을 확인한다.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" lease acquire --owner <child_run_id> --generation <new_generation> --expect-generation <current_generation>
```

- **반환 JSON의 `ok:true`를 확인한 후에만 진행한다.** `reason:'run-terminal'`(exit 3)이면 run이 이미 종결(completed/stopped)된 것 — 인수를 중단하고 사람에게 보고한다(v1.6 terminal guard).
- 성공 시: 이 세션이 새 owner. `generation`이 +1 증가.
- 실패(다른 세션이 이미 인수): 에러 보고 후 종료.

## 단계 2.5: 세션 model/effort refresh (acquire 직후)

lease를 인수해 이 세션이 owner가 된 직후, 자기 실제 model/effort를 durable state에 갱신한다 — 부모가 `--model`/`--effort`로 정확히 띄웠어도, desktop transport(URL은 flag 못 실음)나 사람의 `/model` 변경으로 이 세션의 실제 값이 state와 다를 수 있으므로:

```bash
CLAUDE_EFFORT_VAL=$(node -e "process.stdout.write(process.env.CLAUDE_EFFORT||'')")
SP_ARGS=(session-profile set --model "<이 세션의 모델 ID>" --owner <child_run_id> --generation <new_generation>)
[ -n "$CLAUDE_EFFORT_VAL" ] && SP_ARGS+=(--effort "$CLAUDE_EFFORT_VAL")   # 빈 effort는 생략
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" "${SP_ARGS[@]}"
```

acquire가 owner를 이 세션으로 바꾸고 generation을 올리며 paused run을 running으로 되돌리므로, 이 setter는 새 owner/generation + `intent:'lease'`로 통과한다. 실패(예: 여전히 paused)하면 best-effort로 건너뛰고 다음 `/deep-loop-continue` §0.5가 갱신한다.

## 단계 3: Active Worktree 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field workstreams
```

각 active workstream의 worktree 경로 무결성을 확인한다. 경로 소실 시 조용히 재생성하지 않는다 — `needs-human`으로 표시하고 사람에게 보고한다.

## 단계 3.5: Worktree 진입 위임

resume은 특정 worktree에 미리 진입하지 않는다. per-action worktree 진입은 `/deep-loop-continue` §1.5(`action.workstream_id` 기반)에 위임한다 — `max_parallel` 환경에서 여러 active workstream이 존재할 때 잘못된 worktree로 라우팅되는 것을 방지한다.

resume이 단계 4에서 `/deep-loop-continue`를 호출하면, continue가 `action.workstream_id`를 기준으로 올바른 worktree에 자동 진입한다.

## 단계 4: 진행

이어서 진행(`resume`)한다:

```
/deep-loop-continue
```

다음 action을 `next-action --json`으로 읽고 계속한다.

## 사람 탈출 수단: recover --confirm

`preserve-paused` 상태이거나 respawn 게이트가 차단된 run이 stuck(교착 상태)이면 사람이 직접 복구할 수 있다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" recover --confirm --owner <run_id> --generation <n>
```

이 명령은 stale handoff 상태를 정리하여 새 `lease acquire`(CAS 인수)가 가능하도록 한다. 커널이 un-pause를 처리하며, 다음 세션에서 `/deep-loop-resume`으로 lease를 인수한다.

> 이 명령은 사람이 실행한다 — autonomous tick이 스스로 `recover --confirm`을 발행하지 않는다.
