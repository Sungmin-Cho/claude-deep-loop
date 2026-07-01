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

## 1.5. Action-keyed Worktree 진입 (maker/checker dispatch 전)

`action.workstream_id`가 존재하는 action에만 이 단계를 실행한다. 이는 `dispatch_maker`, `dispatch_checker`, `fix_episode`, `await_result`(진행 중인 maker/checker 폴링 시 워크트리 경로가 필요)를 포함한다.
`workstream_id`가 없는 action 타입(`finish`, `handoff`, `await_human`, `discover`)은 이 단계를 건너뛴다.

§1에서 실행한 `next-action --json` 결과의 `action.workstream_id`를 읽는다. 그 ID를 기준으로:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field workstreams
```

workstream 목록에서 `id === action.workstream_id`인 항목의 `worktree` 경로를 확인한다. **경로 절대화(FIX C/FIX I/FIX O):** 기록된 `worktree` 값이 상대 경로이면(FIX N 이후 항상 루트-상대), state에서 project root를 읽어 절대화한다.

> `state get --field project.root`는 JSON-인코딩된 문자열(예: `"/repo"`)을 출력한다 — 따옴표를 제거해야 올바른 경로가 된다.

```
PROJECT_ROOT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field project.root \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")))')
```

`$PROJECT_ROOT/<recorded-worktree>` 형태로 절대화한다. 이미 절대 경로이면 그대로 사용한다(`$ORIG_ROOT` 쉘 변수는 fresh/resumed 세션에서 정의되지 않으므로 사용하지 않는다). native attach 도구(`EnterWorktree` 등)가 있으면 그것으로 진입하고, 없으면 절대 경로를 사용해 `cd`로 전환한다. 커널 상태(`rootOf` 상향탐색)는 cwd 이동과 무관하게 원본 root를 자동 해석하므로 `--project-root`는 불필요하다.

> **artifact 경로 규칙(project-root 기준 상대, 기록된 worktree 경로 접두):** `episode new`·`episode record` 의 artifact 인자는 반드시 project root 기준 상대 경로, **기록된 worktree 경로(루트 기준 상대) 접두** 형태로 지정한다 — `<recorded-worktree-relative-to-root>/path/to/file` (예: `.claude/worktrees/<ws-slug>/path/to/file` 또는 `.worktrees/<ws-slug>/path/to/file`). §1.5에서 cwd가 worktree 안으로 이동했더라도 containment 검증은 항상 project root 기준이므로, 이 규칙을 어기면 artifact proof가 실패한다.

`max_parallel` 환경에서 여러 active workstream이 있어도, 항상 `action.workstream_id`가 지정하는 workstream의 worktree만 진입한다 — 임의 active workstream이 아님.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode record --id <episode_id> --status done --artifacts '[".claude/worktrees/<ws-slug>/path/to/artifact"]' --proof '{}' --owner <run_id> --generation <n>
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode new --plugin <maker_plugin> --role maker --kind fix --point <point> --workstream <workstream_id> --artifacts '[".claude/worktrees/<ws-slug>/path/to/fix-output"]' --owner <run_id> --generation <n>
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

마일스톤(`milestone_predicate`) 통과 또는 `per_session_turn_cap` 도달 시 **visible respawn 결정 흐름**을 실행한다. 아니면 다음 episode 안내 후 종료.

### 4a. 이미 emit된 핸드오프 확인 (PreCompact 안전망)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.lease
```

`lease.handoff_phase === 'emitted'`이면 reserved child가 이미 존재한다 — **re-emit 금지**, 4c로 바로 이동.

### 4b. 핸드오프 Emit (handoff_phase=idle인 경우)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" handoff emit --owner <run_id> --generation <n>
```

### 4c. Terminal 감지 및 Spawn Style 결정

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" detect-terminal --owner <run_id> --generation <n>
```

`session_spawn`과 `autonomy`를 읽는다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_spawn
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field autonomy
```

**분기:**

**1. visible** (`spawn_style=visible` + `launcher≠none`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n> --attended
```

커널이 자동으로 새 세션을 시작한다. 이 스킬은 직접 `claude -p`를 실행하지 않는다(§9).

**1b. desktop** (`spawn_style==='desktop'` — init 시 opt-in한 Claude Desktop 딥링크 재시작, `session_spawn.launcher`가 `none`이어도 유효):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n> --attended
```

visible과 동일한 명령이다 — 커널이 검증된 desktop 엔트리(`open -a`/직접 실행)를 골라 자동으로 재시작한다. 사람이 이미 init에서 확정한 선택이므로 재질문하지 않는다.

**2. unattended** (명시적 드라이버 마커 / `DEEP_LOOP_UNATTENDED` set / non-tty):

드라이버(`drive-headless.mjs`)가 respawn을 처리한다 — 이 스킬은 아무것도 실행하지 않는다.

**3. else** (`launcher=none` / visible 아님 / legacy interactive):

respawn을 통해 게이트를 먼저 평가한다 — unfenced pause 전에 항상 respawn 경유 필수:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n>
```

respawn의 `outcome`에 따라 분기:

- **`gate-blocked`**: respawn이 이미 rollback + `status=paused` 처리 완료. 다시 pause 하지 않는다.
  사람에게 게이트 해소 후 수동 재개를 안내한다:
  ```
  deep-loop recover --confirm --owner <run_id> --generation <n>
  ```

- **`no-launcher`**: 게이트 통과 — 이제 preserve-pause가 적합. fence flag 필수(R6-plan):
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" pause --owner <run_id> --generation <n> --mode preserve --reason needs-human:<reason>
  ```
  > **R6-plan 필수**: `handoff emit`이 lease를 `releasing` 상태로 전환했으므로 `--owner`/`--generation` fence가 반드시 필요하다. Unfenced `pause`는 exit 3(LEASE_FENCED)으로 실패하여 run이 un-paused 상태로 남는다 → stale takeover 위험.

  `terminal/launch-command.txt` 내용을 사람에게 제시한다. 다음 세션에서 `/deep-loop-resume`을 실행한다.

- **그 외** (`fenced` 등): 보고만 하고 pause 하지 않는다.
