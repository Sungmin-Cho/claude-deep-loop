---
name: deep-loop-continue
description: "deep-loop main tick — advances the kernel-returned next action in the current Workstream owner conversation, using native compact in place and handing off only at an exact terminal Workstream boundary. Triggered by '/deep-loop-continue', 'continue the loop', 'advance the loop', 'next tick', '루프 진행', '루프 계속', '다음 tick', '계속 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-continue\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> **maker/checker 분리 유지** — 같은 세션이 동일 workstream의 maker와 checker를 겸하지 않는다.
> 스킬은 durable state를 **읽기만** 하며, 모든 변경은 public kernel CLI로만 요청한다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-continue`, Codex에서 `$deep-loop:deep-loop-continue` 형식을 사용한다.

## 개요

`/deep-loop-continue` — 커널의 `next-action`을 한 단계 수행한다. 열린
Workstream affinity는 현재 owner conversation에 계속 남는다. 새 owner는
커널이 정확한 terminal Workstream boundary를 `handoff` action으로 반환한
뒤에만 준비한다.

## 0. Run ID / Generation 확보

handoff descriptor 또는 current run이 제공한 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. lease owner가 세션마다 바뀌어도 이 값을 다시 대입하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

현재 세션이 `owner_run_id`인지 확인한다. 아니면 Claude는 `/deep-loop-resume`, Codex는 `$deep-loop:deep-loop-resume`으로 lease를 인수해야 한다.

`<owner_run_id> = lease.owner_run_id`, `<generation> = lease.generation`. 여기서 `lease`는 방금 읽은 `session_chain.lease`다. 즉 `<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 매 tick 새로 읽고, `<run_id>`는 절대 재바인딩하지 않는다.

## 0.5. 세션 model/effort refresh

§0에서 lease를 확보한 직후, 게이트/디스패치 이전에 현재 세션의
model/effort를 public kernel route로 갱신한다. 스킬이 상태 파일을 직접
쓰지 않는다.

현재 호스트가 알려 준 model과 effort를 직접 관측한다. 둘 다 있으면 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못했으면 `--effort`를 넣지 않은 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

- **빈 값 금지**: `--model`/`--effort`는 관측된 것만 포함한다(`CLAUDE_EFFORT`가 비면 `--effort` 생략). 모델도 관측 못 하고 effort도 비면 이 단계 전체를 건너뛴다(state 그대로 진행 — 무해).
- 값이 그대로면 no-op이다. 관측값이 없으면 이 단계를 건너뛴다.
- handoff가 진행 중이어도 다음 분기를 추측하지 않는다. 항상 §1의 새
  `next-action` 응답만 따른다.

## 1. 게이트 검사 (항상 먼저)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" next-action --json --project-root "<canonical_project_root>" --run-id <run_id>
```

`action.type`이 유일한 routing authority다.

- `await_human`: `action.reason`과 커널 진단을 그대로 보고하고
  `/deep-loop-status`를 안내한 뒤 멈춘다. 이 autonomous tick은 recovery,
  budget relief, breaker reset, 또는 attended approval을 실행하지 않는다.
- `handoff`: §4의 exact-boundary 경로만 수행한다.
- 그 밖의 action: 현재 owner conversation에서 계속 수행한다.

## 1.5. Action-keyed Worktree 진입 (maker/checker dispatch 전)

`action.workstream_id`가 존재하는 action에만 이 단계를 실행한다. 이는 `dispatch_maker`, `dispatch_checker`, `fix_episode`, `await_result`(진행 중인 maker/checker 폴링 시 워크트리 경로가 필요)를 포함한다.
`workstream_id`가 없는 action 타입(`finish`, `handoff`, `await_human`, `discover`)은 이 단계를 건너뛴다.

§1에서 실행한 `next-action --json` 결과의 `action.workstream_id`를 읽는다. 그 ID를 기준으로:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
```

workstream 목록에서 `id === action.workstream_id`인 항목의 `worktree` 경로를 확인한다. **경로 절대화(FIX C/FIX I/FIX O):** 기록된 `worktree` 값이 상대 경로이면(FIX N 이후 항상 루트-상대), state에서 project root를 읽어 절대화한다.

> `state get --field project.root`는 JSON-인코딩된 문자열(예: `"/repo"`)을 출력한다 — 따옴표를 제거해야 올바른 경로가 된다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field project.root --project-root "<canonical_project_root>" --run-id <run_id>
```

반환 JSON 문자열을 `JSON.parse`로 해석해 따옴표가 제거된 절대 `project.root` 값을 얻고, 그 값과 `<recorded-worktree>`를 host path API로 결합한다. 셸 변수, 파이프라인, `cd` 명령은 사용하지 않는다. native attach 도구(`EnterWorktree` 등)가 있으면 그것으로 진입하고, 없으면 도구의 working-directory 옵션에 절대 worktree 경로를 전달한다. 이후 커널 명령도 descriptor-bound `--project-root`와 `--run-id`를 계속 명시한다.

> **artifact 경로 규칙(project-root 기준 상대, 기록된 worktree 경로 접두):** `episode new`·`episode record` 의 artifact 인자는 반드시 project root 기준 상대 경로, **기록된 worktree 경로(루트 기준 상대) 접두** 형태로 지정한다 — `<recorded-worktree-relative-to-root>/path/to/file` (예: `.claude/worktrees/<ws-slug>/path/to/file` 또는 `.worktrees/<ws-slug>/path/to/file`). §1.5에서 cwd가 worktree 안으로 이동했더라도 containment 검증은 항상 project root 기준이므로, 이 규칙을 어기면 artifact proof가 실패한다.

`max_parallel` 환경에서 여러 active workstream이 있어도, 항상 `action.workstream_id`가 지정하는 workstream의 worktree만 진입한다 — 임의 active workstream이 아님.

## 2. Action 분기 (next-action이 반환한 `action.type`대로, 스스로 판단 추가 금지)

### dispatch_maker

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" adapter resolve --protocol <protocol> --task "<brief>" --tier <gate.tier_after> --project-root "<canonical_project_root>" --run-id <run_id>
```

`guard.ok === false`이면 dispatch 중단 → `await_human` 안내.

진행 시 episode in_progress로 기록:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode record --id <episode_id> --status in_progress --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

sibling descriptor는 runtime별로 라우팅한다. Claude는 `Skill({ skill: dispatch.skill, args: dispatch.args })`, Codex는 qualified `$<dispatch.skill>`에 `dispatch.args`를 전달한다. 완료 후:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode record --id <episode_id> --status done --artifacts '[".claude/worktrees/<ws-slug>/path/to/artifact"]' --proof '{}' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### dispatch_checker

먼저 `references/adapters.md`의 **상호 배타 checker routing** Route A–D 중 실제 가능한 경로를 선택하되 아직 dispatch하지 않는다. Route D이면 `needs-human`으로 중단하며 계약 파일도 쓰지 않는다. Route A/B/C일 때만 아래 계약 준비를 수행한 뒤 선택한 경로로 dispatch한다.

먼저 recipe를 **상태에서** 읽는다(이전 대화 컨텍스트를 가정하지 말 것 — 이 값이 아래 분기의 유일한 근거다):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field recipe.id --project-root "<canonical_project_root>" --run-id <run_id>
```

**결과가 `"harness-hill-climb"`이면 dispatch 전에 checker 계약을 materialize한다** (P2 — 커널이 fail-closed로 강제; 전체 규약은 `Read("../deep-loop-workflow/references/hill-climbing.md")` §3.4):

§1.5에서 확정한 absolute worktree에 대해 host의 native path/file API로 `DEEP_LOOP_ROOT/skills/deep-loop-workflow/references/contracts/HILLCLIMB-001.yaml`을 `<absolute_worktree>/.deep-review/contracts/HILLCLIMB-001.yaml`로 복사한다. mkdir/copy **전** canonical worktree containment를 확인하고, `.deep-review`, `contracts`, 대상 파일 중 존재하는 경로 성분이 symlink/reparse-point이면 중단한다. POSIX `cp`/`mkdir` 셸 문법을 가정하지 말고 현재 host에서 안전한 파일 API를 사용한다.

tracked 소스를 **그대로 복사**한다(byte-identical — 커널이 대조; 수정본은 `REVIEW_CONTRACT_MISSING`으로 거부). 커널도 realpath containment + contracts 디렉터리 유일성(HILLCLIMB-001.yaml 외 다른 계약 yaml 금지 — bare `--contract`는 모든 active 계약을 로드하므로)을 fail-closed로 재검증한다. 계약-비소비 reviewer나 `--contract` 플래그 부재/명시 selector(`--contract SLICE-NNN` 등 — deep-review 파서는 SLICE-NNN만 selector로 소비하므로 HILLCLIMB-001을 지정할 수 없다)는 `REVIEW_CONTRACT_UNENFORCEABLE` — run의 review 설정을 사람과 함께 재구성해야 한다.

Route A/B/C 모두 hill-climb dispatch 응답의 `descriptor.evidence`(커널-검증 insights 경로·emit ULID·sha256·후보)를 fresh checker의 리뷰 요청 본문에 그대로 포함하여 maker 인용과 대조하게 한다. checker episode의 `request.md`에도 같은 evidence 사본이 durable 기록되며, Codex measured host는 anchored claim의 evidence/contract를 immutable prompt contract로 전달한다.

- **Route A — cooperative fresh subagent:** host에 fresh `code-reviewer`를 만드는 cooperative tool이 실제로 있을 때만 다음 명령을 실행한다. configured reviewer가 agent인데 이 capability가 없으면 Route D로 가며 dispatch하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --independent-subagent --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

  반환된 agent descriptor로 host tool을 통해 fresh reviewer를 spawn한다. inline 자기 리뷰는 proof가 아니다.

- **Route B — Codex unattended measured host:** 다음 명령을 정확히 한 번 실행하고 즉시 measured host에 yield한다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

  host가 claim, isolated read-only 두 번째 `codex exec`, import, accounting을 소유한다. 이 execution skill은 Route B에서 아래 `review record`를 실행하지 않는다.

- **Route C — interactive independent skill session:** reviewed worktree를 root로 하는 distinct fresh session/task가 실제 준비됐을 때만 flag 없는 위 dispatch를 실행한다. Claude fresh session은 `Skill({ skill: checker.skill, args: checker.args })`, Codex fresh task는 `$<checker.skill>`에 args를 전달한다. Codex 자동 task 생성은 지원하지 않으므로 사람이 수동 task 생성을 완료해야 한다. 같은 task의 `$<checker.skill>` 실행은 proof가 아니다.
- **Route D — no independent path:** `needs-human`으로 보고하고 dispatch/record/proof 생성을 모두 중단한다. pending checker를 만들지 않는다.

Route A 또는 Route C의 fresh checker가 리뷰 대상 worktree 아래 실제 contained report를 반환한 경우에만 원래 execution session이 다음 단계로 간다. 커널은 checker episode에서 workstream/point/target maker/source를 파생하므로 해당 caller flag를 전달하지 않는다. **APPROVE/CONCERN(통과)은 checker가 실제로 작성한 리뷰 리포트 파일을 `--report`로 첨부해야 한다 — 리뷰 대상 workstream의 worktree(`.claude/worktrees/<slug>/…`) 하위 경로**여야 하며(무관한 root 파일 재사용 차단), 없거나 밖이면 `REVIEW_NO_EVIDENCE`(exit 1). REQUEST_CHANGES도 fresh checker가 실제 반환한 verdict여야 한다:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" review record --episode <checker_episode_id> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --report "<review-report-path>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### fix_episode

fix maker episode 생성 후 dispatch:
```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" episode new --plugin <maker_plugin> --role maker --kind fix --point <point> --workstream <workstream_id> --artifacts '[".claude/worktrees/<ws-slug>/path/to/fix-output"]' --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
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
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" budget record --turns <n> --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

**`DEEP_LOOP_UNATTENDED` set 시 자기보고를 생략** — drive-headless 드라이버가 측정 usage를 권위있게 기록하므로 이중계상 방지.

self-report는 best-effort 보정일 뿐이다. 커널이 각 business mutation마다
최소 floor를 계상하고 wallclock hard bound를 적용한다.

## 3.5. Post-compact comprehension check

직전 `SessionStart(compact)` capsule을 받은 tick이면, capsule의
`run_id`/`generation`을 아래 lease 결과와 대조한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

capsule의 `episode`/`next_action`도 아래 current episode와 `next-action` 결과에 대조한다. 즉 스펙 §4.3의 `run_id`/`episode`/`next_action`/`generation` 4개 필드를 모두 확인한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field current_episode --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" next-action --json --project-root "<canonical_project_root>" --run-id <run_id>
```

불일치하면 checkpoint restore를 다시 추측하지 않는다. `/deep-loop-status`로
진단을 요청하고 현재 conversation에서 멈춘다.

## 4. Kernel action 이후 continuity

### Compact advice

`action.advice === 'compact'`이면 handoff하지 않는다. 현재 owner conversation에서
`/deep-loop-compact prepare` 또는 `$deep-loop:deep-loop-compact prepare`를
호출하고, 그 스킬이 출력한 host native `/compact` 명령을 사람에게 제시한다.
compact prepare/restore는 같은 conversation, 같은 lease, 같은 Workstream
affinity를 유지한다.

### Exact Workstream boundary handoff

`action.type === 'handoff'`이고 `action.reason === 'workstream-terminal'`이며
`action.boundary_event`가 있을 때만 handoff한다. public
`next-action --json`은 boundary를 이미
`<boundary_seq>:<boundary_checksum>` 문자열로 렌더한다. 그
`action.boundary_event` 문자열을 검증된 한 값으로 그대로 전달하고,
재구성하거나 이전 action의 값을 재사용하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --boundary-event <boundary_seq>:<boundary_checksum> --reason "workstream-terminal" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

unattended invocation이면 measured `drive-headless` host가 이후 gate와 spawn을
소유한다. 이 스킬은 respawn을 직접 호출하지 않고 즉시 yield한다.

attended invocation이면 커널의 현재 root/epoch/topology 검증을 거친 exact
resume command를 얻어 **그 출력을 바꾸지 않고 먼저 출력**한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" resume-command --project-root "<canonical_project_root>" --run-id <run_id>
```

그 다음 현재 parent fence로 preserve-pause하고 종료한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "needs-human:workstream-terminal" --project-root "<canonical_project_root>" --run-id <run_id>
```

사람은 출력된 Claude `/deep-loop-resume` 또는 Codex
`$deep-loop:deep-loop-resume` 명령을 새 conversation에서 그대로 실행한다.
지원되지 않는 Codex 자동 transport는 `codex-transport-not-activated`,
승인 runtime 부재는 `runtime-identity-unavailable`로 남으며, native Windows,
macOS/Linux `cmux`, macOS iTerm2/Terminal.app 어느 경우도 이 스킬이
surface heuristic으로 attended respawn하지 않는다. Codex App 새 task는 수동이다.
