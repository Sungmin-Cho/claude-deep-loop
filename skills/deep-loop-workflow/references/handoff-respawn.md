# Handoff / Respawn 호출 규약

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

세션 전환(handoff)과 자율 재시작(respawn) 흐름을 정의한다. §9 참조.

## Lease identity

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. handoff/respawn mutation 직전 current lease를 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 얻는다. 이후 fenced 명령은 current owner/generation과 불변 logical run id를 함께 전달하며, `<run_id>`를 owner로 재사용하지 않는다.

## Handoff 호출자 3종

1. **마일스톤 도달** — `milestone_predicate` 통과 시 `/deep-loop-continue`가 자동 emit
2. **per_session_turn_cap 소진** — budget 게이트가 `handoff` action을 반환. 단, cap 소진 트리거는 `rotate-per-unit` 전용이다 — `compact-in-place`는 실제 작업 action의 `advice:'compact'`를 표시하고 작업을 계속한다.
3. **사람 수동 요청** — `/deep-loop-handoff`로 언제든 emit 가능

## §0.5 세션 model/effort refresh (handoff emit / respawn 전 항상)

handoff를 emit하거나 respawn하기 전에, 살아있는 세션이 자기 model/effort를 durable state에 갱신한다 — 자식이 부모와 같은 model/effort로 열리도록(self-healing). `intent:'lease'`라 handoff가 이미 emit되어 lease가 `releasing`이어도 통과한다:

현재 호스트가 알려 준 model과 effort를 직접 관측한다. 둘 다 있으면 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못했으면 `--effort`를 넣지 않은 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

- 관측된 값만 플래그로 포함(빈 effort 생략). 값이 그대로면 no-op(이벤트 안 쌓임). observation 실패 시 건너뛴다(기존 state로 진행).
- `lease.handoff_phase`가 `emitted`/`spawned`이면(PreCompact 안전망이 이미 emit) business write는 releasing carve-out으로 fence되므로, 정상 tick 작업을 건너뛰고 곧장 respawn 분기로 간다. phase `emitted`는 respawn이 갱신된 state로 launch를 빌드(self-heal 완결), phase `spawned`는 이미 뜬 자식이 `/deep-loop-resume`의 refresh로 다음 handoff에 교정한다.

## Windows launcher 승인 preflight (Handoff Emit 전에, handoff_phase=idle인 경우만)

launcher 승인은 `intent:recover` fence를 사용하므로 `handoff emit`이 lease를 `releasing`으로 바꾸기 **전에** 끝내야 한다. 이미 `emitted`/`spawned`이면 승인을 시도하지 말고 수동 fallback/respawn 분기로 간다.

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

## Handoff Emit

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --reason "<reason>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

산출물:
- `handoffs/<timestamp>-next-session.md` — 다음 세션용 컨텍스트
- `handoffs/<timestamp>-compaction-state.json` — 압축 상태
- `terminal/launch-command.txt` — 재시작 명령

## Visible Respawn 결정 흐름 (Task 12)

handoff emit 후 spawn style을 결정한다.

### 1. 이미 emit된 핸드오프 확인 (PreCompact 안전망)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`lease.handoff_phase === 'emitted'`이면 reserved child 존재 — **re-emit 금지**, 바로 분기 평가로.

### 2. Terminal 감지

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`session_spawn.launcher`와 `autonomy.spawn_style`을 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_spawn --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field autonomy --project-root "<canonical_project_root>" --run-id <run_id>
```

### 3. Spawn Style 분기 (커널 `resolveSpawnMode` 우선순위 headless > desktop > visible > interactive와 동일 순서로 먼저 판정)

**unattended** (커널 `isHeadlessInvocation(env)` 마커 전용 — `DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS`/드라이버 entrypoint 휴리스틱; **non-tty는 신호가 아니다**. **가장 먼저 판정** — desktop/visible보다 우선): 드라이버가 처리. tty 유무만으로는 이 분기에 들어가지 않는다 — Claude Desktop Code 탭처럼 사람이 지켜보는 non-tty GUI 세션은 마커가 없으면 아래 desktop/visible/else 분기로 흐른다(§init의 "attended" 정의와 동일 기준). **이 마커가 하나라도 있으면 durable `autonomy.spawn_style`이 `desktop`이든 `visible`이든 무조건 이 분기가 우선한다** — desktop opt-in한 run이라도 현재 호출이 headless라면(예: drive-headless 사이클 도중) 아래 desktop 분기로 새지 않는다(커널 `resolveSpawnMode`의 headless-preempts-desktop, 불변식 #6). **스킬은 여기서 `respawn`을 직접 호출하지 않는다** — drive-headless 래퍼 없이 직접 호출하면 측정 usage가 계상되지 않아 예산/fail-closed 모델이 깨진다.

> **현재 Codex transport 경계:** 승인된 native runtime이 있으면 measured `codex-jsonl` headless continuation을 사용할 수 있다. macOS/Linux에서는 그 승인 runtime과 양성 감지된 absolute `cmux` executable + exact socket이 있을 때 visible continuation이 활성화되고, macOS에서는 고정 `/usr/bin/osascript`로 양성 검증된 **선택된** iTerm2 또는 Terminal.app만 활성화된다. 네이티브 Windows에서는 승인된 runtime + WT/PowerShell launcher identity가 있을 때 shell-free visible continuation이 활성화된다. 승인 runtime이 없으면 `runtime-identity-unavailable`, launcher 증적이 없거나 바뀌면 launcher identity 오류로 CAS 전 preserve-pause하며, 지원되지 않는 visible 경로는 `codex-transport-not-activated`로 닫힌다. 어떤 경우에도 Claude transport로 대체하지 않는다. **Codex App의 자동 새 task 생성은 지원하지 않으므로 수동 App resume을 제시한다.**

**desktop** (`spawn_style==='desktop'` — init 시 opt-in한 Claude Desktop 딥링크 재시작, `launcher===none`이어도 유효. **위 unattended 마커가 없을 때만** 해당):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

visible과 동일한 명령 — 커널이 검증된 desktop 엔트리(`open -a`/직접 실행)로 자동 재시작한다. 선택은 init에서 확정된 durable 값이라 재질문하지 않는다.

핸들러 프로브가 (앱 삭제/이동, 서명 변경 등으로) 실패하면 `desktopProbe` unavailable → `buildLaunchCommand`가 unavailable entry를 반환 → 아래 `else`(preserve-pause) 분기로 흐른다. `spawn_style`은 opt-in 시점에 이미 라이브 프로브로 검증된 뒤에만 durable하게 저장되므로(round-6 리뷰 수정, `confirmDesktop`의 `HANDLER_UNVERIFIED` 가드) 이 실패는 어디까지나 "이후에 깨진" 경우다 — 반복되는 preserve-pause에서 벗어나려면 사람이 `spawn-style reset-desktop`으로 `desktop → visible` 복구 후 재확인해야 한다(아래 "사람 탈출 수단" 참고).

**visible** (`spawn_style=visible` + `launcher≠none`):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

커널이 자동으로 새 세션을 시작한다. 스킬이 직접 `claude -p`나 `codex exec --json`을 실행하지 않는다(§9).

**else** (`launcher=none` / visible 아님 / legacy interactive — 예: desktop opt-in을 거절/억제한 attended non-tty 세션):

respawn을 통해 게이트를 먼저 평가한다 — unfenced pause 전에 항상 respawn 경유 필수(Codex r6 CRITICAL):

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
  > **R6-plan 필수**: `handoff emit`이 lease를 `releasing`으로 전환했으므로 `--owner`/`--generation` fence가 반드시 필요하다. Unfenced `pause`는 exit 3(LEASE_FENCED)으로 실패 → run이 un-paused 상태로 남음 → stale takeover 위험.

  `terminal/launch-command.txt` 내용을 사람에게 제시한다.

- **그 외** (`fenced` 등): 보고만 하고 pause 하지 않는다.

## Interactive vs Headless

### Interactive (사람 개입)

`terminal/launch-command.txt` 내용을 사람에게 제시한다 — 사람이 직접 새 세션을 시작한다.
respawn은 드라이버만 수행한다 (스킬이 직접 spawn하지 않음).

### Headless / 미감시 자율

커널 `isHeadlessInvocation(env)`가 참(`DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS` set, 또는 드라이버 entrypoint 휴리스틱)이거나 `autonomy.spawn_style==='headless'`이면 headless 강제 — **non-tty는 신호가 아니다**(resolveSpawnMode, `scripts/lib/respawn.mjs`).
드라이버(`drive-headless.mjs`)는 run의 immutable runtime을 선택하고 그 runtime의 trusted(검증·승인된) executable만 사용한다. **Claude**는 bounded `claude -p --output-format json --permission-mode acceptEdits` JSON을 파싱하고, 승인된 **Codex**는 인증된 격리 `CODEX_HOME`과 shell-free `codex exec --json`의 incremental JSONL을 파싱해 각각 정확한 한 turn usage를 기록한다.

두 경로 모두 timeout/non-zero/측정불가 usage에서 fail-closed하며 다른 runtime으로 대체하지 않는다(**교차 런타임 fallback은 하지 않는다**). 미감시 자율은 **headless 강제**이고, Codex App의 자동 새 task 생성은 지원하지 않으므로 App 연속성은 수동 resume이다.

## Respawn 게이트 순서

respawn이 내부적으로 평가하는 순서:
1. `budget` — `checkBudget` 통과?
2. `breaker` — `checkBreaker.tripped === false`?
3. `sessions < max_sessions` — 세션 한도 미초과?
4. `wallclock < max_wallclock_sec` — 벽시계 한도 미초과?
5. `auto_handoff` — 자율 handoff 허용?

**게이트 차단 시**: `status=paused` 기록 후 stop. 스킬이 외부에서 게이트를 선검사하지 않는다 — canonical 평가는 respawn 내부에서 일어난다.

## 비용 회계 모델 (Codex r5 critical-2)

**진짜 무인 장기 실행**의 비용은 **drive-headless 드라이버**가 측정 usage를 `budget record`로 권위있게 커밋한다(단일 출처).

**PreCompact respawn**은 세션 연속을 위한 안전망이라 spawnFn의 measured usage를 기록하지 않고 버린다 — 인수한 **자식 세션이 자기 drive 사이클에서 자기 비용을 회계**한다(이중계상 방지).

**Interactive tick**은 best-effort로 `budget record --turns <n> --owner <owner_run_id> --generation <n>` 자기보고. `DEEP_LOOP_UNATTENDED` set 시 자기보고를 생략한다 — drive-headless가 측정 usage를 권위있게 기록하므로 이중계상 방지.

**커널 경계 자동 floor (#3)**: self-report와 무관하게, 커널은 각 business mutation(`episode new/record/abandon`·`review record/import`·`workstream new/set/terminal`·`state patch`·`comprehension ack`·`finish`)마다 최소 1 turn을 `appendAnchored`로 **자동 계상**한다(생략 불가). 명시 `budget record`는 그 tick의 floor를 **대체**한다(max 규칙 — 보고값과 floor 합 중 큰 값, 합산 아님). 따라서 self-report는 best-effort 보정일 뿐이고, **`max_wallclock_sec`(default 86400s)이 self-report와 무관한 authoritative hard bound**다. 예산 시맨틱 = best-effort self-report + 커널 자동 floor + wallclock hard bound.

## Resume 흐름

handoff descriptor가 제공한 `<canonical_project_root>`, logical `<run_id>`, 실제 `<claude|codex>` runtime assertion을 그대로 사용한다. ambient cwd/current pointer로 이 identity를 재추론하지 않는다.

새 세션 시작 시 Claude는 `/deep-loop-resume --project-root "<canonical_project_root>" --run-id <run_id>`, Codex는 `$deep-loop:deep-loop-resume --project-root "<canonical_project_root>" --run-id <run_id>`:
1. `handoffs/<latest>-next-session.md` + 아래 explicit state를 읽는다(이전 대화 가정 금지).
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
   ```
2. 아래 runtime/root/run-bound `lease acquire`로 세션 lease를 CAS 인수한다 — reserved child acquire가 run을 un-pause한다(커널 처리, Task 8).
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" lease acquire --owner <child_run_id> --generation <new_generation> --expect-generation <current_generation> --runtime <claude|codex> --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   성공하면 `<owner_run_id> = <child_run_id>`, `<generation> = <new_generation>`으로 갱신하되 논리 `<run_id>`는 그대로 둔다.
3. active workstream worktree 경로 무결성 확인(existsSync → 소실 시 needs-human)
3.5. per-action worktree **진입은 `/deep-loop-continue`가 next-action의 `action.workstream_id` 기준으로 수행**한다(resume은 특정 worktree로 미리 진입하지 않음 — 다중 병렬 오진입 방지).
4. Claude는 `/deep-loop-continue`, Codex는 `$deep-loop:deep-loop-continue`로 진행

## 사람 탈출 수단: recover --confirm

`preserve-paused` 또는 게이트 차단으로 stuck된 run을 사람이 복구한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

stale handoff 상태를 정리하여 새 `lease acquire`가 가능하도록 한다. 이후 runtime에 맞는 `/deep-loop-resume` 또는 `$deep-loop:deep-loop-resume`으로 인수.
autonomous tick이 스스로 `recover --confirm`을 발행하지 않는다.

**desktop opt-in 전용 복구 (round-6 part c):** `recover --confirm`은 handoff/lease 상태만 정리할 뿐 `autonomy.spawn_style`은 건드리지 않는다(generic `state patch`는 `autonomy.spawn_style`을 forbid — classifyPatch). 확인됐던 desktop 핸들러가 이후 깨져 매 handoff가 `HANDLER_UNVERIFIED`(prospectively, 위 desktop 분기 참고)로 preserve-pause를 반복하면, 사람이 별도로:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" spawn-style reset-desktop --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

로 `desktop → visible`을 fenced 전이시킨 뒤(`desktop`이 아니면 exit 1 `SOURCE_INVALID`), 다시 opt-in 절차(§2-5-1)를 밟아 재확인할 수 있다.
