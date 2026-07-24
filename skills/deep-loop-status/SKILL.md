---
name: deep-loop-status
description: "deep-loop status — shows the current run's status, budget, comprehension debt, circuit breaker, pending human reviews, session chain, and workstreams. Read-only. Triggered by '/deep-loop-status', 'loop status', 'show the loop', 'where are we', '루프 상태', '상태 보기', '진행 상황', cross-platform Skill({ skill: \"deep-loop:deep-loop-status\" })."
user-invocable: true
---

사용자의 언어(language)를 감지하여 같은 언어로 응답한다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-status`, Codex에서 `$deep-loop:deep-loop-status` 형식을 사용한다.

## 개요

`/deep-loop-status` — 현재 run의 상태(status), 예산, comprehension debt, circuit breaker, 미검토 episode, session chain, workstream 표를 **읽기 전용**으로 표시한다.

status 조회 대상 descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. 아래 사람 전용 mutation을 제안하거나 실행하기 전에는 current lease를 새로 읽는다.
스킬의 autonomous 진단은 durable state를 **읽기만** 한다. 아래 mutation은
명시적 사람 확인 뒤 public kernel CLI로만 실행하며 상태 파일을 직접 쓰지 않는다.

## 조회 순서

### 1. 전체 Loop 상태

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`status`, `goal`, `protocol`, `created_at`, 적용 중인 continuation policy(`autonomy.continuation_policy`), `session_spawn.reason`(visible continuation 비활성 사유)을 출력한다.
`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 얻는다. read-only 조회에는 fence가 없고, 사람 전용 mutation만 이 current fence와 불변 `<run_id>`를 함께 쓴다.

### 2. 예산 확인

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" budget check --project-root "<canonical_project_root>" --run-id <run_id>
```

`spent`(turns), `tokens_spent`, 남은 예산, `ok` 여부를 출력한다.

### 3. Comprehension Debt

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" comprehension status --project-root "<canonical_project_root>" --run-id <run_id>
```

`debt_ratio`, `episodes_total`, `episodes_human_reviewed`를 출력한다.

### 4. Circuit Breaker

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" breaker check --project-root "<canonical_project_root>" --run-id <run_id>
```

- `tripped: false`이면 정상.
- `tripped: true`이면 **사람이** 직접 reset해야 한다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" breaker reset --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  (사람 + lease-owner 전용 경로 — autonomous tick은 `--confirm`을 자동으로 주지 않는다.)

### 5. Workstream 표

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
```

각 workstream의 `id`, `title`, `status`, `review_points_done`을 표 형태로 출력한다.

### 6. 미검토 Episode

comprehension `episodes_human_reviewed`가 낮으면 미검토 episode 목록을 출력하고 `/deep-loop-ack --actor human`을 안내한다(사람 검토만 게이트를 해제하며, `episodes_agent_reviewed`는 기계 리뷰 계상으로 debt에 무관하다).

### 7. 막힌(stranded) non-terminal episode

`next-action`이 `await_human`을 반환하고 `reason`이 `orphan-maker-no-artifacts`(proof-impossible: `expected_artifacts: []`라 절대 `done`이 될 수 없는 maker)이거나, 기타 터미널에 도달하지 못한 채 막힌 episode일 때는 사람이 해당 episode를 abandon으로 정착(settle)시켜 finish를 풀어준다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode abandon --id <id> --reason "<why>" --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

(`--confirm` + lease fence(`--owner`/`--generation`)는 사람 전용 경로 — autonomous tick은 자동으로 주지 않는다. abandon 후 episode는 `abandoned`(settled)가 되어 finish 게이트가 풀린다.)

## 다음 명령 제안

상태에 따라 적절한 다음 명령을 제안한다:
- 정상 진행 중: `/deep-loop-continue`
- handoff 대기: `/deep-loop-resume`
- 완료 가능: `/deep-loop-finish`
- breaker tripped: `breaker reset --confirm --owner <owner_run_id> --generation <n>` (사람 직접 실행)

## Human-only safety relief

`next-action`이 `await_human`을 반환하면 autonomous skill은 relief command를
실행하지 않는다. 사람이 현재 pause reason, fresh owner/generation, 요청한
positive delta를 확인한 경우에만 예산을 확장한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" budget extend --turns <positive_turn_delta> --reason "<human_confirmed_reason>" --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

breaker reset은 위 §4의 exact command를 사람이 직접 확인한 경우에만
실행한다. recovery reservation에서는 두 route 모두 exact child/capsule을
보존하며, autonomous tick은 실행하지 않는다.

## Human-only attended launch approval

interactive가 기본이다. 사람이 visible launch를 명시적으로 요청하고 fresh
lease와 executable/launcher diagnosis를 확인한 경우에만 다음 command를
제시하고 확인 후 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" attended-launch approve --style visible --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

desktop은 이 command의 style을 바꾸지 않고 전용 `spawn-style
offer-desktop`/`confirm-desktop` human flow를 사용한다. revoke도 사람이
명시적으로 확인한 경우에만 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" attended-launch revoke --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

continue/handoff skill은 승인 state에서 자동 respawn을 추론하지 않는다.

## Human-only lost-host affinity recovery

열린 Workstream의 original host conversation이 실제로 복구 불가능하다는
사람 확인 없이는 affinity를 supersede하지 않는다. 먼저 fresh lease,
owner scope, Workstream, episode, budget, breaker를 진단하고 original owner
fence로 exact preserve-pause reason을 기록한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "host-session-lost" --project-root "<canonical_project_root>" --run-id <run_id>
```

사람이 진단과 reason을 확인한 경우에만 다음 command를 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --supersede-affinity --reason "<human_confirmed_reason>" --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

커널 반환의 child id, `recovery_rel`, `recovery_sha256`, project root digest,
binding generation, current generation, runtime, `resume_command`를 그대로
표시한다. 이어서 read-only descriptor를 다시 열고 첫 줄이 같은 exact
`recovery acquire --capsule ...`인지 확인한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

사람은 반환된 exact command만 새 process에서 실행한다. plain acquisition,
capsule/path 편집, stale artifact 재사용은 금지한다.

## Human-only project-root relocation recovery

candidate root를 사람이 명시한 경우에만 read-only diagnosis를 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" root diagnose --candidate-project-root "<candidate_project_root>" --run-id <run_id>
```

`action`, blocker/topology, `current_root_digest`,
`current_binding_generation`, owner/generation fence를 모두 표시한다.
`wait`이면 멈추고 `already-rebound`이면 새 command를 만들지 않는다.
`rebind` 또는 `relocation-recovery`이면 사람이 exact diagnosis,
preserve-pause reason, root digest/epoch, fence를 확인한 뒤에만 kernel이
반환한 exact command를 실행한다. command의 `--confirm`, `--actor human`,
expected stored-root digest, expected binding generation을 바꾸지 않는다.

relocation recovery 뒤에는 `resume-command`를 다시 실행하고, returned
`root recovery acquire --capsule ...` command의 candidate root, capsule
SHA-256, binding generation, child, runtime, lease generation이 fresh state와
일치할 때만 그대로 실행한다. stale root-bound command나 locator를 손으로
고치지 않는다.
