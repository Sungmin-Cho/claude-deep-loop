---
name: deep-loop-resume
description: "deep-loop resume — validates a kernel-published boundary, affinity-recovery capsule, or project-root relocation descriptor, acquires only through its exact route, and delegates worktree entry to continue. Triggered by '/deep-loop-resume', '$deep-loop:deep-loop-resume', 'resume the loop', 'take over the session', 'continue handed-off work', '루프 이어가기', '세션 인수', '이어서 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-resume\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> 이전 conversation이나 stale artifact path를 가정하지 않는다.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> 스킬은 durable state를 **읽기만** 하며, 모든 변경은 public kernel CLI로만 요청한다.

## 실행 루트와 입력

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고,
아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다.
literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경
변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-resume`, Codex에서
`$deep-loop:deep-loop-resume` 형식을 사용한다. descriptor가 준
`--project-root "<canonical_project_root>" --run-id <run_id>`를 그대로
사용한다. `<run_id>`는 논리적(logical) loop run id이며 불변(immutable)이다.

## 단계 1: Kernel descriptor 분류

현재 root/run에 대해 exact, read-only resume descriptor를 다시 요청한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

출력의 첫 줄과 `Recovery:`, `Lease:` metadata를 바꾸거나 재구성하지 않는다.
커널 오류, malformed topology, root digest/epoch mismatch이면 인수를 중단한다.

## Boundary handoff

첫 줄이 현재 runtime의 `/deep-loop-resume` 또는
`$deep-loop:deep-loop-resume` descriptor이고 `Recovery:` 줄이 없을 때만
normal boundary branch다. fresh state에서 exact child와 generation을 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
```

`handoff_child_run_id`, `handoff_boundary_event`, project root digest/binding
generation, child `parent_boundary_event`, `project_root_digest`, and
`project_binding_generation`이 서로 일치하는지 확인한다. `<child_run_id>`는
exact reserved child, `<current_generation>`은 fresh lease generation,
`<new_generation>`은 아래 CAS 성공 응답이 반환한 generation이어야 한다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" lease acquire --owner <child_run_id> --generation <current_generation> --runtime <claude|codex> --project-root "<canonical_project_root>" --run-id <run_id>
```

`ok:true` 뒤에만 `<owner_run_id> = <child_run_id>`,
`<generation> = <new_generation>`으로 승격한다. arbitrary owner나 plain
timeout takeover를 시도하지 않는다.

## Affinity recovery capsule

`Recovery: kind=affinity-supersession`이면 ordinary acquisition을 하지 않는다.
`resume-command`의 첫 줄은 `recovery acquire --capsule ...`이며, exact returned
command를 그대로 실행해야 한다.

실행 전 fresh session/lease metadata의 `recovery_rel`, `recovery_sha256`,
`recovery_project_root_digest`, `recovery_project_binding_generation`,
child id, current generation, runtime이 descriptor의 capsule/root
digest/binding generation과 모두 일치해야 한다. capsule을 편집하거나 path를
다시 만들지 않는다. 불일치하면 사람에게 보고하고 멈춘다.

## Project-root relocation recovery

current root access가 `PROJECT_ROOT_FENCED`/`PROJECT_ROOT_UNRESOLVABLE`이거나
사람이 candidate root를 명시한 경우에만 read-only diagnosis를 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" root diagnose --candidate-project-root "<candidate_project_root>" --run-id <run_id>
```

`action`, `current_root_digest`, `current_binding_generation`, `fence`,
`topology`를 모두 표시한다. `action:'wait'`이면 기다리고,
`action:'already-rebound'`이면 command를 만들지 않는다.
`action:'rebind'|'relocation-recovery'`이면 사람이 exact diagnosis와
preserve-pause reason을 확인하고 명시적으로 승인한 뒤에만 diagnosis의
exact returned command를 그대로 실행한다. stale root, epoch, digest, owner,
generation, 또는 artifact path를 손으로 수정하지 않는다.

relocation recovery publication 뒤 `resume-command`를 다시 실행한다.
`Recovery: kind=project-root`인 첫 줄은
`root recovery acquire --capsule ...`이며, 그 exact returned command만
실행한다. descriptor의 capsule rel, SHA-256, candidate root digest,
`current_binding_generation`, child, runtime, lease generation이 fresh
state와 일치하지 않으면 중단한다. generic acquisition은 금지한다.

## 단계 2.5: 세션 model/effort refresh (성공한 acquire 직후)

성공한 branch가 새 owner를 만들었을 때 실제 host model/effort를 public
kernel route로 갱신한다. 둘 다 관측한 경우:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못한 경우:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

관측값이 없거나 setter가 fence되면 추측하지 않는다.

## 단계 3: Active Worktree 무결성 확인

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
```

active workstream의 recorded relative worktree가 canonical project root 안에
존재하고 symlink/reparse escape가 아닌지 확인한다. 소실 시 재생성하지 않고
`needs-human`으로 보고한다.

## 단계 3.5: Worktree 진입 위임

resume은 특정 worktree에 미리 진입하지 않는다. per-action worktree 진입은
`/deep-loop-continue`가 fresh `action.workstream_id` 기준으로 수행하도록
위임한다.

## 단계 4: 진행

Claude에서는 `/deep-loop-continue`, Codex에서는
`$deep-loop:deep-loop-continue`를 invoke한다.
