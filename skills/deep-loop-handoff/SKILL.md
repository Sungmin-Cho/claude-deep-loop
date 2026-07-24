---
name: deep-loop-handoff
description: "deep-loop boundary handoff — follows the kernel next-action and emits a fresh-owner handoff only for the exact first terminal Workstream boundary. Triggered by '/deep-loop-handoff', '$deep-loop:deep-loop-handoff', 'hand off at the boundary', 'emit handoff', '인수인계', '워크스트림 핸드오프', cross-platform Skill({ skill: \"deep-loop:deep-loop-handoff\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> 스킬은 durable state를 **읽기만** 하며, 모든 변경은 public kernel CLI로만 요청한다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고,
아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다.
literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경
변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-handoff`, Codex에서
`$deep-loop:deep-loop-handoff` 형식을 사용한다.

## 단계 1: 현재 identity와 kernel action

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run
수명 동안 불변(immutable)이다. 먼저 current lease를 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id> = session_chain.lease.owner_run_id`,
`<generation> = session_chain.lease.generation`으로 설정한다. 이어서 routing
authority를 한 번 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" next-action --json --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field autonomy.continuation_policy --project-root "<canonical_project_root>" --run-id <run_id>
```

단계 1.5의 worktree 진입은 불필요하다. 커널은 explicit project root와
logical run id로 run을 찾고, 이 스킬은 maker/checker 파일을 변경하지 않는다.

## 단계 2: Workstream boundary 판정

`action.type !== 'handoff'`이면 handoff를 emit하지 않는다.

- 열린 Workstream affinity가 있으면 현재 owner conversation에 남는다.
- `action.advice === 'compact'`이면 `/deep-loop-compact prepare` 또는
  `$deep-loop:deep-loop-compact prepare`를 사용해 host native `/compact`
  명령을 준비한다. compact는 같은 conversation과 lease를 유지한다.
- `action.type === 'await_human'`이면 `action.reason`을 그대로 보고하고
  `/deep-loop-status`를 안내한다.

`continuation_policy === 'workstream-session'`,
`action.type === 'handoff'`, `action.reason === 'workstream-terminal'`, 그리고
`action.boundary_event`가 모두 있을 때만 진행한다.
public `next-action --json`은 boundary를
`<boundary_seq>:<boundary_checksum>` 문자열로 렌더한다. 그
`action.boundary_event` 문자열을 분해하거나 다시 만들지 않고 그대로
`--boundary-event` 값으로 전달한다.
surface milestone, turn cap, launcher, 또는 spawn style로 boundary를 추론하지
않는다.

## 단계 3: Exact boundary emit

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --boundary-event <boundary_seq>:<boundary_checksum> --reason "workstream-terminal" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### Migrated policy compatibility

`continuation_policy`가 migrated `compact-in-place` 또는 `rotate-per-unit`이고
fresh action이 `action.type === 'handoff'`,
`action.reason === 'per_session_turn_cap'`이며 `action.boundary_event`가 없을
때만 다음 boundary-less legacy route를 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --reason "per_session_turn_cap" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

이 compatibility branch도 kernel action만 따른다. launcher, tty, turn count,
spawn style에서 handoff나 attended launch를 추론하지 않는다.

커널이 exact boundary, root digest/epoch, owner fence, budget, breaker, finish
상태를 다시 검증한다. 실패하면 recovery나 alternate boundary를 추측하지
않고 오류를 그대로 보고한다.

## 단계 4: Host continuation

unattended invocation이면 measured `drive-headless` host가 이후 gate와 spawn을
소유한다. 이 스킬은 respawn을 직접 호출하지 않고 yield한다.

attended invocation이면 현재 root/epoch/topology에 대해 커널이 검증한 exact
resume command를 얻고, **그 출력을 바꾸지 않고 먼저 출력**한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

그 다음 parent fence로 preserve-pause하고 종료한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "needs-human:workstream-terminal" --project-root "<canonical_project_root>" --run-id <run_id>
```

사람은 출력된 Claude `/deep-loop-resume` 또는 Codex
`$deep-loop:deep-loop-resume` 명령을 새 conversation에서 그대로 실행한다.
Codex App task 생성은 수동이다. `codex-transport-not-activated` 또는
`runtime-identity-unavailable`을 launcher 추측으로 우회하지 않는다. native
Windows, macOS/Linux `cmux`, macOS iTerm2/Terminal.app 모두 exact
kernel-returned guidance만 사용한다.
