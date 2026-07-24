# Workstream Boundary Handoff / Respawn 호출 규약

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고,
아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다.
literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경
변수나 셸 확장으로 루트를 만들지 않는다.

이 execution-plane reference는 durable state를 읽기만 한다. 상태와 event,
scope, transaction artifact 변경은 public kernel CLI만 수행한다.

## Identity

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 불변이다.
continuity mutation 직전 current lease를 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`와 `<generation>`은 각각 방금 읽은
`session_chain.lease.owner_run_id`와 `session_chain.lease.generation`이다.
`<run_id>`를 owner로 재사용하지 않는다.

## Kernel-driven continuity

모든 decision은 fresh `next-action`에서 시작한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" next-action --json --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field autonomy.continuation_policy --project-root "<canonical_project_root>" --run-id <run_id>
```

- action에 열린 affinity의 `workstream_id`가 있으면 현재 owner conversation에
  남는다.
- `action.advice === 'compact'`이면 `/deep-loop-compact prepare` 또는
  `$deep-loop:deep-loop-compact prepare`가 출력하는 host native `/compact`
  명령을 사용한다. prepare/restore는 같은 conversation과 lease를 유지한다.
- `action.type === 'await_human'`이면 exact reason을 보고하고 멈춘다.
- `continuation_policy === 'workstream-session'`에서는 오직
  `action.type === 'handoff'`,
  `action.reason === 'workstream-terminal'`, `action.boundary_event`가 모두
  있는 경우에만 fresh owner를 준비한다.
- migrated `compact-in-place` 또는 `rotate-per-unit`에서는 fresh action이
  `action.type === 'handoff'`, `action.reason === 'per_session_turn_cap'`,
  boundary 없음인 경우에만 legacy compatibility handoff를 준비한다.

surface milestone, turn cap, launcher, tty, spawn style로 affinity closure나
handoff를 추론하지 않는다.

## Exact boundary publication

public `next-action --json`은 boundary를
`<boundary_seq>:<boundary_checksum>` 문자열로 렌더한다. 그
`action.boundary_event` 문자열을 분해하거나 다시 만들지 않고 그대로
`--boundary-event` 값으로 전달한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --boundary-event <boundary_seq>:<boundary_checksum> --reason "workstream-terminal" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

## Migrated policy compatibility

`continuation_policy`가 migrated `compact-in-place` 또는 `rotate-per-unit`이고,
fresh kernel action이 `action.type === 'handoff'`,
`action.reason === 'per_session_turn_cap'`이며 `action.boundary_event`가 없을
때만 다음 public route를 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --reason "per_session_turn_cap" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

이는 기존 run 호환성 전용이다. 새 run의 policy를 바꾸거나 launcher, tty,
turn count, spawn style로 continuity를 추론하지 않는다.

커널이 root digest/epoch, owner fence, exact terminal event, budget, breaker,
finish 상태를 in-lock으로 재검증한다. 스킬은 다른 boundary를 구성하지 않는다.

## Attended continuation

attended mode는 launcher heuristic에서 respawn하지 않는다. 먼저 커널이
검증한 exact resume command를 읽고, **출력 bytes를 바꾸지 않고 출력**한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

그 다음 parent fence로 preserve-pause한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "needs-human:workstream-terminal" --project-root "<canonical_project_root>" --run-id <run_id>
```

사람은 출력된 Claude `/deep-loop-resume` 또는 Codex
`$deep-loop:deep-loop-resume` 명령을 새 conversation에서 그대로 실행한다.

## Unattended continuation

unattended continuation은 measured `drive-headless` host가 소유한다. execution
skill은 직접 respawn하지 않으며 headless driver에 yield한다. Claude measured
JSON과 approved Codex incremental JSONL은 각각 자기 runtime 안에서만
계상하며 cross-runtime fallback은 없다.
durable state에 저장된 **immutable runtime**이 해당 **trusted measured driver**
실행 파일을 선택하며, execution plane은 다른 runtime으로 바꾸거나 추론하지
않는 **no cross-runtime fallback** 계약을 지킨다.

지원되지 않는 Codex transport는 `codex-transport-not-activated`, 승인 runtime
부재는 `runtime-identity-unavailable`로 fail closed한다. native Windows,
macOS/Linux `cmux`, macOS iTerm2/Terminal.app launcher identity도 커널의
exact descriptor로만 소비한다. Codex App 새 task는 수동이다.

## Resume acquisition

normal boundary handoff의 새 conversation은 descriptor가 준 root/run/runtime과
exact child identity만 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" lease acquire --owner <child_run_id> --generation <current_generation> --runtime <claude|codex> --project-root "<canonical_project_root>" --run-id <run_id>
```

recovery reservation이면 generic acquisition을 시도하지 않는다.
`resume-command`가 출력한 `recovery acquire --capsule ...` 또는
`root recovery acquire --capsule ...` 한 줄을 그대로 실행한다. 자세한
root digest/epoch와 capsule 검증은 `/deep-loop-resume`의 distinct recovery
branches를 따른다.

Worktree entry는 acquire 뒤 `/deep-loop-continue`가 새
`action.workstream_id` 기준으로 수행한다.
