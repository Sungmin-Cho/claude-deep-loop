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

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-handoff`, Codex에서 `$deep-loop:deep-loop-handoff` 형식을 사용한다.

## 개요

`/deep-loop-handoff` — 마일스톤 없이 언제든 깔끔한 handoff(인수인계)를 emit하고, 선택적으로 respawn한다.

## 단계 1: 현재 Lease 확인

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. 세션 소유권과 별개로 유지한다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

방금 읽은 lease에서 `<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`으로 새로 설정한다. 이후 fenced 명령은 current owner/generation과 불변 `<run_id>`를 함께 전달한다.

`owner_run_id`와 `generation`을 확인한다.

## 단계 1.4: 세션 model/effort refresh (emit/respawn 전 항상)

emit·respawn 이전에 현재 세션의 model/effort를 durable state에 갱신해, 새 세션이 부모와 같은 model/effort로 열리도록 한다(self-healing). `intent:'lease'`라 이미 emit된(releasing) handoff에서도 통과한다:

현재 호스트가 알려 준 model과 effort를 직접 관측한다. 둘 다 있으면 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못했으면 `--effort`를 넣지 않은 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

값이 그대로면 no-op(이벤트 안 쌓임). 관측 실패(model·effort 둘 다) 시 이 단계를 건너뛴다(기존 state로 진행). 이후 emit/respawn이 갱신된 state를 읽는다.

## 단계 1.5: Worktree 진입 불필요

handoff emit과 respawn은 커널 상태 조작이다. descriptor의 canonical project root와 logical run id를 모든 명령에 명시하므로 cwd와 무관하게 동일 run을 찾는다. handoff descriptor도 project root 기준 경로로 기록된다.

maker/checker 파일 작업은 handoff에서 일어나지 않으므로, worktree 진입 없이 단계 2로 진행한다.

## 단계 1.6: Windows launcher 승인 preflight (handoff emit 전에, handoff_phase=idle인 경우만)

launcher 승인은 `intent:recover` fence를 사용하므로 `handoff emit`이 lease를 `releasing`으로 바꾸기 **전에** 끝내야 한다. 단계 1에서 이미 `emitted`/`spawned`를 확인했다면 승인을 시도하지 말고 단계 3의 수동 fallback/respawn 분기로 간다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_spawn --project-root "<canonical_project_root>" --run-id <run_id>
```

Windows에서 reason이 `windows-terminal-unverified` 또는 `powershell-unverified`이면 PATH·고정 경로를 추측하지 말고 사람이 제공한 절대 `.exe` 하나로 read-only 진단한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" launcher-executable diagnose --kind <wt|powershell> --path "<human_supplied_absolute_exe>" --project-root "<canonical_project_root>" --run-id <run_id>
```

반환된 `canonical_path`와 lowercase `sha256`을 그대로 보여 주고 `AskUserQuestion`으로 명시적 사람 승인을 받는다. `--confirm` 자동 생성/auto-confirm은 금지한다. 사람이 동일 path/SHA를 확인한 경우에만 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" launcher-executable approve --kind <wt|powershell> --path "<same_absolute_exe>" --canonical-path "<diagnosed_canonical_path>" --sha256 "<diagnosed_lowercase_sha256>" --actor human --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

경로 미제공, 진단 실패, 승인 거절이면 durable 상태를 바꾸지 않고 수동 fallback을 유지한다. 스킬은 상태 파일을 직접 쓰지 않는다.

## 단계 2: Handoff Emit (handoff_phase=idle인 경우)

이미 emit된 핸드오프가 있으면 re-emit을 건너뛴다. 먼저 확인:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`lease.handoff_phase === 'emitted'`이면 **re-emit 금지**, 단계 3으로 바로 이동.

`handoff_phase=idle`인 경우에만 emit:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

산출물:
- `handoffs/<timestamp>-next-session.md` — 다음 세션용 컨텍스트
- `handoffs/<timestamp>-compaction-state.json` — 압축 상태
- `terminal/launch-command.txt` — 재시작 명령

## 단계 3: Terminal 감지 및 Spawn Style 결정

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

### Unattended (커널 `isHeadlessInvocation(env)` 마커 전용 — non-tty 아님. **가장 먼저 판정** — Desktop/Visible보다 우선)

**판단 기준은 오직 커널의 `isHeadlessInvocation(env)`뿐이다** — `DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS` 또는 드라이버 entrypoint 휴리스틱(`CLAUDE_CODE_ENTRYPOINT`가 sdk*/print/headless/non-interactive) 중 하나가 참일 때만 unattended로 판정한다. **tty 유무는 신호가 아니다** — Claude Desktop Code 탭은 사람이 지켜보는 GUI이지만 tty가 없다(§init의 "attended" 정의와 동일 기준). **이 마커가 하나라도 있으면 durable `autonomy.spawn_style`이 `desktop`이든 `visible`이든 무조건 이 분기가 우선한다** — desktop opt-in한 run이라도 현재 호출이 headless라면(예: drive-headless 사이클 도중) 아래 Desktop 분기로 새지 않는다(커널 `resolveSpawnMode`의 headless-preempts-desktop, 불변식 #6). 마커가 하나도 없으면 아래 Desktop/Visible/Else 분기로 진행한다(non-tty만으로 여기서 멈추지 않는다).

드라이버(`drive-headless.mjs`)가 immutable runtime에 맞는 trusted executable을 선택하고 measured respawn을 자동으로 처리한다 — **이 스킬은 여기서 `respawn`을 직접 호출하지 않는다** (직접 호출하면 drive-headless 래퍼 없이 측정 usage가 계상되지 않아 예산/fail-closed 모델이 깨진다). 다른 runtime으로 교차 fallback하지 않는다.

### Desktop (`spawn_style==='desktop'` — init 시 opt-in한 Claude Desktop 딥링크 재시작. **위 Unattended 마커가 없을 때만** 해당)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

visible과 동일하게 처리한다 — `session_spawn.launcher`가 `none`이어도 커널이 검증된 desktop 엔트리로 자동 재시작한다. init에서 이미 확정한 선택이므로 재질문하지 않는다.

### Visible (spawn_style=visible + launcher≠none)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

커널이 자동으로 새 세션을 시작한다. 이 스킬은 직접 `claude -p`나 `codex exec --json`을 실행하지 않는다(§9).

### Else (launcher=none / visible 아님 / legacy interactive)

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

  `terminal/launch-command.txt` 내용을 사람에게 제시한다. 사람이 직접 새 세션을 시작한다.

- **그 외** (`fenced` 등): 보고만 하고 pause 하지 않는다.

## 다음 세션

새 세션에서 Claude는 `/deep-loop-resume`, Codex는 `$deep-loop:deep-loop-resume`을 실행해 handoff.md를 읽고 lease를 인수한다.
