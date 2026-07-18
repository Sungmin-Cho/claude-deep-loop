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

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-continue`, Codex에서 `$deep-loop:deep-loop-continue` 형식을 사용한다.

## 개요

`/deep-loop-continue` — 루프를 한 단계 진행(tick)한다. 게이트 검사 → next-action 읽기 → dispatch/record → Decide → 필요 시 handoff+respawn.

## 0. Run ID / Generation 확보

handoff descriptor 또는 current run이 제공한 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. lease owner가 세션마다 바뀌어도 이 값을 다시 대입하지 않는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

현재 세션이 `owner_run_id`인지 확인한다. 아니면 Claude는 `/deep-loop-resume`, Codex는 `$deep-loop:deep-loop-resume`으로 lease를 인수해야 한다.

`<owner_run_id> = lease.owner_run_id`, `<generation> = lease.generation`. 여기서 `lease`는 방금 읽은 `session_chain.lease`다. 즉 `<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 매 tick 새로 읽고, `<run_id>`는 절대 재바인딩하지 않는다.

## 0.5. 세션 model/effort refresh (respawn 전 항상)

§0에서 lease를 확보한 직후, 게이트/디스패치 이전에 현재 세션의 model/effort를 durable state에 갱신한다(self-healing). 이래야 이 tick이 띄울 자식이 최신 model/effort로 열린다.

현재 호스트가 알려 준 model과 effort를 직접 관측한다. 둘 다 있으면 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못했으면 `--effort`를 넣지 않은 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

- **빈 값 금지**: `--model`/`--effort`는 관측된 것만 포함한다(`CLAUDE_EFFORT`가 비면 `--effort` 생략). 모델도 관측 못 하고 effort도 비면 이 단계 전체를 건너뛴다(state 그대로 진행 — 무해).
- setter는 `intent:'lease'`라 handoff가 이미 emit되어 lease가 `releasing`이어도 통과한다. 값이 그대로면 no-op(이벤트 안 쌓임).
- **in-flight handoff 조기 분기**: §0에서 읽은 `lease.handoff_phase`가 `emitted` 또는 `spawned`이면(reserved child 존재 — PreCompact 안전망이 이미 emit한 상태), §1.5/§2/§3의 business write는 releasing carve-out으로 fence되므로 **건너뛰고 곧장 §4c(respawn)로 이동**한다. (phase `emitted`이면 respawn이 위 refresh된 state로 launch를 빌드 → 자식이 최신값으로 뜬다. phase `spawned`이면 자식은 이미 떠 있고, 그 자식이 `/deep-loop-resume`에서 자기 값을 refresh해 다음 handoff에 반영한다.)

## 1. 게이트 검사 (항상 먼저)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" next-action --json --project-root "<canonical_project_root>" --run-id <run_id>
```

- `gate.allowed === false` 또는 `action.type ∈ {handoff, await_human}`이면:
  - **budget 소진**: `handoff emit --owner <owner_run_id> --generation <n>` 실행 후 사람에게 재시작 안내.
  - **breaker tripped**: `/deep-loop-status`로 상태 확인 후 사람이 `breaker reset --confirm --owner <owner_run_id> --generation <n>` 실행 필요 — **autonomous tick은 스스로 `--confirm`을 주지 않는다.**
  - **await_human**: 사람 입력 요청 후 종료.

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

이 tick을 시작할 때 `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`을 만족하는 `interactive-<uuid>` 형태의 `<accounting_request_id>`를 한 번 생성하고 tick context에 보존한다.
응답 유실을 포함한 같은 self-report 재시도에는 반드시 같은 값을 재사용하고 다음 tick에는 새 값을 사용한다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" budget record --turns <n> --request-id <accounting_request_id> --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

**`DEEP_LOOP_UNATTENDED` set 시 자기보고를 생략** — drive-headless 드라이버가 측정 usage를 권위있게 기록하므로 이중계상 방지.

self-report는 best-effort 보정일 뿐이다 — 커널이 각 business mutation마다 최소 floor(1 turn)를 자동 계상하므로 미보고여도 예산·per_session_turn_cap이 mutation 수에 비례해 진행하고, `max_wallclock_sec`가 self-report 무관 hard bound다. 명시 `budget record`는 그 tick의 floor를 대체한다(max 규칙, 이중계상 없음).

## 4. Decide (마일스톤 / Turn Cap)

마일스톤(`milestone_predicate`) 통과 또는 `per_session_turn_cap` 도달 시 **visible respawn 결정 흐름**을 실행한다. 아니면 다음 episode 안내 후 종료.

### 4a. 이미 emit된 핸드오프 확인 (PreCompact 안전망)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`lease.handoff_phase === 'emitted'`이면 reserved child가 이미 존재한다 — **re-emit 금지**, 4c로 바로 이동.

### 4a.5. Windows launcher 승인 preflight (handoff emit 전에, handoff_phase=idle인 경우만)

launcher 승인은 `intent:recover` fence를 사용하므로 `handoff emit`이 lease를 `releasing`으로 바꾸기 **전에** 끝내야 한다. 이미 `emitted`/`spawned`이면 승인을 시도하지 말고 4c의 수동 fallback/respawn 분기로 간다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_spawn --project-root "<canonical_project_root>" --run-id <run_id>
```

Windows에서 reason이 `windows-terminal-unverified` 또는 `powershell-unverified`이면 PATH·고정 경로를 추측하지 말고, 사람이 제공한 절대 `.exe` 하나를 실행하지 않는 read-only 진단에 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" launcher-executable diagnose --kind <wt|powershell> --path "<human_supplied_absolute_exe>" --project-root "<canonical_project_root>" --run-id <run_id>
```

반환된 `canonical_path`와 lowercase `sha256`을 그대로 보여 주고 `AskUserQuestion`으로 명시적 사람 승인을 받는다. `--confirm` 자동 생성/auto-confirm은 금지한다. 사람이 동일 path/SHA를 확인한 경우에만 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" launcher-executable approve --kind <wt|powershell> --path "<same_absolute_exe>" --canonical-path "<diagnosed_canonical_path>" --sha256 "<diagnosed_lowercase_sha256>" --actor human --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

경로 미제공, 진단 실패, 승인 거절이면 durable 상태를 바꾸지 않고 수동 fallback을 유지한다. 스킬은 상태 파일을 직접 쓰지 않는다.

### 4b. 핸드오프 Emit (handoff_phase=idle인 경우)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

### 4c. Terminal 감지 및 Spawn Style 결정

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`session_spawn`과 `autonomy`를 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_spawn --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field autonomy --project-root "<canonical_project_root>" --run-id <run_id>
```

**분기 (커널 `resolveSpawnMode` 우선순위 headless > desktop > visible > interactive와 동일 순서로 먼저 판정):**

> **현재 Codex transport 경계:** 승인된 native runtime이 있으면 measured headless continuation을 사용할 수 있다. macOS/Linux에서는 그 승인 runtime과 양성 감지된 absolute `cmux` executable + exact socket이 있을 때 visible continuation이 활성화되고, macOS에서는 고정 `/usr/bin/osascript`로 양성 검증된 **선택된** iTerm2 또는 Terminal.app만 활성화된다. 네이티브 Windows에서는 승인된 runtime + WT/PowerShell launcher identity가 있을 때 shell-free visible continuation이 활성화된다. 승인 runtime이 없으면 `runtime-identity-unavailable`, launcher 증적이 없거나 바뀌면 launcher identity 오류로 CAS 전 preserve-pause하며, 지원되지 않는 visible 경로는 `codex-transport-not-activated`로 닫힌다. 어떤 경우에도 Claude process로 대체하지 않는다. **Codex App의 자동 새 task 생성은 지원하지 않으므로 수동 App resume을 유지한다.**

**1. unattended** (커널 `isHeadlessInvocation(env)` 마커 전용 — non-tty 아님. **가장 먼저 판정** — desktop/visible보다 우선):

**판단 기준은 오직 커널의 `isHeadlessInvocation(env)`뿐이다** — `DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS` 또는 드라이버 entrypoint 휴리스틱(`CLAUDE_CODE_ENTRYPOINT`가 sdk*/print/headless/non-interactive) 중 하나가 참일 때만 unattended로 판정한다. **tty 유무는 신호가 아니다** — Claude Desktop Code 탭은 사람이 지켜보는 GUI이지만 tty가 없다(§init의 "attended" 정의와 동일 기준). **이 마커가 하나라도 있으면 durable `autonomy.spawn_style`이 `desktop`이든 `visible`이든 무조건 이 분기가 우선한다** — desktop opt-in한 run이라도 현재 호출이 headless라면(예: drive-headless 사이클 도중) 아래 desktop 분기로 새지 않는다(커널 `resolveSpawnMode`의 headless-preempts-desktop, 불변식 #6). 마커가 하나도 없으면 아래 desktop 또는 visible/else 분기로 진행한다(non-tty만으로 여기서 멈추지 않는다).

드라이버(`drive-headless.mjs`)가 respawn을 처리한다 — **이 스킬은 여기서 `respawn`을 직접 호출하지 않는다** (직접 호출하면 drive-headless 래퍼 없이 측정 usage가 계상되지 않아 예산/fail-closed 모델이 깨진다).

**2. desktop** (`spawn_style==='desktop'` — init 시 opt-in한 Claude Desktop 딥링크 재시작, `session_spawn.launcher`가 `none`이어도 유효. **위 unattended 마커가 없을 때만** 해당):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

visible과 동일한 명령이다 — 커널이 검증된 desktop 엔트리(`open -a`/직접 실행)를 골라 자동으로 재시작한다. 사람이 이미 init에서 확정한 선택이므로 재질문하지 않는다.

**3. visible** (`spawn_style=visible` + `launcher≠none`):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

커널이 자동으로 새 세션을 시작한다. 이 스킬은 직접 `claude -p`나 `codex exec --json`을 실행하지 않는다(§9).

**4. else** (`launcher=none` / visible 아님 / legacy interactive):

respawn을 통해 게이트를 먼저 평가한다 — unfenced pause 전에 항상 respawn 경유 필수:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

respawn의 `outcome`에 따라 분기:

- **`gate-blocked`**: respawn이 이미 rollback + `status=paused` 처리 완료. 다시 pause 하지 않는다.
  사람에게 게이트 해소 후 수동 재개를 안내한다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
  ```

- **`no-launcher`**: 게이트 통과 — 이제 preserve-pause가 적합. fence flag 필수(R6-plan):
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "needs-human:<reason>" --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  > **R6-plan 필수**: `handoff emit`이 lease를 `releasing` 상태로 전환했으므로 `--owner`/`--generation` fence가 반드시 필요하다. Unfenced `pause`는 exit 3(LEASE_FENCED)으로 실패하여 run이 un-paused 상태로 남는다 → stale takeover 위험.

  `terminal/launch-command.txt` 내용을 사람에게 제시한다. 다음 세션에서 Claude는 `/deep-loop-resume`, Codex는 `$deep-loop:deep-loop-resume`을 실행한다.

- **그 외** (`fenced` 등): 보고만 하고 pause 하지 않는다.
