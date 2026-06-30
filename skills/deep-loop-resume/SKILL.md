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

- 성공 시: 이 세션이 새 owner. `generation`이 +1 증가.
- 실패(다른 세션이 이미 인수): 에러 보고 후 종료.

## 단계 3: Active Worktree 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field workstreams
```

각 active workstream의 worktree 경로 무결성을 확인한다. 경로 소실 시 조용히 재생성하지 않는다 — `needs-human`으로 표시하고 사람에게 보고한다.

## 단계 3.5: Active Worktree 진입

경로 무결성 확인(단계 3) 통과 후, active workstream의 worktree로 진입한다. native attach 도구(`EnterWorktree` 등)가 있으면 그것으로 진입하고, 없으면 `cd`로 전환한다. 커널 상태(`rootOf` 상향탐색)는 cwd 이동 후에도 원본 root를 자동 해석하므로 `--project-root`는 불필요하다.

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
