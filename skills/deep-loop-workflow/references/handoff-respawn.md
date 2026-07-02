# Handoff / Respawn 호출 규약

세션 전환(handoff)과 자율 재시작(respawn) 흐름을 정의한다. §9 참조.

## Handoff 호출자 3종

1. **마일스톤 도달** — `milestone_predicate` 통과 시 `/deep-loop-continue`가 자동 emit
2. **per_session_turn_cap 소진** — budget 게이트가 `handoff` action을 반환
3. **사람 수동 요청** — `/deep-loop-handoff`로 언제든 emit 가능

## §0.5 세션 model/effort refresh (handoff emit / respawn 전 항상)

handoff를 emit하거나 respawn하기 전에, 살아있는 세션이 자기 model/effort를 durable state에 갱신한다 — 자식이 부모와 같은 model/effort로 열리도록(self-healing). `intent:'lease'`라 handoff가 이미 emit되어 lease가 `releasing`이어도 통과한다:

```bash
CLAUDE_EFFORT_VAL=$(node -e "process.stdout.write(process.env.CLAUDE_EFFORT||'')")
SP_ARGS=(session-profile set --model "<이 세션의 모델 ID>" --owner <run_id> --generation <n>)
[ -n "$CLAUDE_EFFORT_VAL" ] && SP_ARGS+=(--effort "$CLAUDE_EFFORT_VAL")   # 빈 effort 생략(INVALID_EFFORT 방지)
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" "${SP_ARGS[@]}"
```

- 관측된 값만 플래그로 포함(빈 effort 생략). 값이 그대로면 no-op(이벤트 안 쌓임). observation 실패 시 건너뛴다(기존 state로 진행).
- `lease.handoff_phase`가 `emitted`/`spawned`이면(PreCompact 안전망이 이미 emit) business write는 releasing carve-out으로 fence되므로, 정상 tick 작업을 건너뛰고 곧장 respawn 분기로 간다. phase `emitted`는 respawn이 갱신된 state로 launch를 빌드(self-heal 완결), phase `spawned`는 이미 뜬 자식이 `/deep-loop-resume`의 refresh로 다음 handoff에 교정한다.

## Handoff Emit

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" handoff emit \
  --reason <reason> \
  --owner <run_id> --generation <n>
```

산출물:
- `handoffs/<timestamp>-next-session.md` — 다음 세션용 컨텍스트
- `handoffs/<timestamp>-compaction-state.json` — 압축 상태
- `terminal/launch-command.txt` — 재시작 명령

## Visible Respawn 결정 흐름 (Task 12)

handoff emit 후 spawn style을 결정한다.

### 1. 이미 emit된 핸드오프 확인 (PreCompact 안전망)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.lease
```

`lease.handoff_phase === 'emitted'`이면 reserved child 존재 — **re-emit 금지**, 바로 분기 평가로.

### 2. Terminal 감지

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" detect-terminal --owner <run_id> --generation <n>
```

`session_spawn.launcher`와 `autonomy.spawn_style`을 읽는다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_spawn
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field autonomy
```

### 3. Spawn Style 분기 (커널 `resolveSpawnMode` 우선순위 headless > desktop > visible > interactive와 동일 순서로 먼저 판정)

**unattended** (커널 `isHeadlessInvocation(env)` 마커 전용 — `DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS`/드라이버 entrypoint 휴리스틱; **non-tty는 신호가 아니다**. **가장 먼저 판정** — desktop/visible보다 우선): 드라이버가 처리. tty 유무만으로는 이 분기에 들어가지 않는다 — Claude Desktop Code 탭처럼 사람이 지켜보는 non-tty GUI 세션은 마커가 없으면 아래 desktop/visible/else 분기로 흐른다(§init의 "attended" 정의와 동일 기준). **이 마커가 하나라도 있으면 durable `autonomy.spawn_style`이 `desktop`이든 `visible`이든 무조건 이 분기가 우선한다** — desktop opt-in한 run이라도 현재 호출이 headless라면(예: drive-headless 사이클 도중) 아래 desktop 분기로 새지 않는다(커널 `resolveSpawnMode`의 headless-preempts-desktop, 불변식 #6). **스킬은 여기서 `respawn`을 직접 호출하지 않는다** — drive-headless 래퍼 없이 직접 호출하면 측정 usage가 계상되지 않아 예산/fail-closed 모델이 깨진다.

**desktop** (`spawn_style==='desktop'` — init 시 opt-in한 Claude Desktop 딥링크 재시작, `launcher===none`이어도 유효. **위 unattended 마커가 없을 때만** 해당):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n> --attended
```

visible과 동일한 명령 — 커널이 검증된 desktop 엔트리(`open -a`/직접 실행)로 자동 재시작한다. 선택은 init에서 확정된 durable 값이라 재질문하지 않는다.

핸들러 프로브가 (앱 삭제/이동, 서명 변경 등으로) 실패하면 `desktopProbe` unavailable → `buildLaunchCommand`가 unavailable entry를 반환 → 아래 `else`(preserve-pause) 분기로 흐른다. `spawn_style`은 opt-in 시점에 이미 라이브 프로브로 검증된 뒤에만 durable하게 저장되므로(round-6 리뷰 수정, `confirmDesktop`의 `HANDLER_UNVERIFIED` 가드) 이 실패는 어디까지나 "이후에 깨진" 경우다 — 반복되는 preserve-pause에서 벗어나려면 사람이 `spawn-style reset-desktop`으로 `desktop → visible` 복구 후 재확인해야 한다(아래 "사람 탈출 수단" 참고).

**visible** (`spawn_style=visible` + `launcher≠none`):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n> --attended
```

커널이 자동으로 새 세션을 시작한다. 스킬이 직접 `claude -p`를 실행하지 않는다(§9).

**else** (`launcher=none` / visible 아님 / legacy interactive — 예: desktop opt-in을 거절/억제한 attended non-tty 세션):

respawn을 통해 게이트를 먼저 평가한다 — unfenced pause 전에 항상 respawn 경유 필수(Codex r6 CRITICAL):

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
  > **R6-plan 필수**: `handoff emit`이 lease를 `releasing`으로 전환했으므로 `--owner`/`--generation` fence가 반드시 필요하다. Unfenced `pause`는 exit 3(LEASE_FENCED)으로 실패 → run이 un-paused 상태로 남음 → stale takeover 위험.

  `terminal/launch-command.txt` 내용을 사람에게 제시한다.

- **그 외** (`fenced` 등): 보고만 하고 pause 하지 않는다.

## Interactive vs Headless

### Interactive (사람 개입)

`terminal/launch-command.txt` 내용을 사람에게 제시한다 — 사람이 직접 새 세션을 시작한다.
respawn은 드라이버만 수행한다 (스킬이 직접 spawn하지 않음).

### Headless / 미감시 자율

커널 `isHeadlessInvocation(env)`가 참(`DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS` set, 또는 드라이버 entrypoint 휴리스틱)이거나 `autonomy.spawn_style==='headless'`이면 headless 강제 — **non-tty는 신호가 아니다**(resolveSpawnMode, `scripts/lib/respawn.mjs`).
드라이버(`drive-headless.mjs`)가 `claude -p --output-format json --permission-mode acceptEdits`로 spawn한다.

미감시 자율은 **headless 강제** — `headlessSpawn`이 timeout + usage 파싱으로 하드 강제한다.

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

**Interactive tick**은 best-effort로 `budget record --turns <n> --owner <run_id> --generation <n>` 자기보고. `DEEP_LOOP_UNATTENDED` set 시 자기보고를 생략한다 — drive-headless가 측정 usage를 권위있게 기록하므로 이중계상 방지.

## Resume 흐름

새 세션 시작 시 `/deep-loop-resume`:
1. `handoffs/<latest>-next-session.md` + `state get` 읽기(이전 대화 가정 금지)
2. `lease acquire`로 세션 lease CAS 인수 — reserved child acquire가 run을 un-pause한다(커널 처리, Task 8)
3. active workstream worktree 경로 무결성 확인(existsSync → 소실 시 needs-human)
3.5. worktree **진입은 `/deep-loop-continue`가 next-action의 `action.workstream_id` 기준으로 수행**한다(resume은 특정 worktree로 미리 진입하지 않음 — 다중 병렬 오진입 방지). 커널 `rootOf` 상향탐색이 cwd 무관하게 원본 root를 자동 해석하므로 `--project-root`는 불필요
4. `/deep-loop-continue`로 진행

## 사람 탈출 수단: recover --confirm

`preserve-paused` 또는 게이트 차단으로 stuck된 run을 사람이 복구한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" recover --confirm --owner <run_id> --generation <n>
```

stale handoff 상태를 정리하여 새 `lease acquire`가 가능하도록 한다. 이후 `/deep-loop-resume`으로 인수.
autonomous tick이 스스로 `recover --confirm`을 발행하지 않는다.

**desktop opt-in 전용 복구 (round-6 part c):** `recover --confirm`은 handoff/lease 상태만 정리할 뿐 `autonomy.spawn_style`은 건드리지 않는다(generic `state patch`는 `autonomy.spawn_style`을 forbid — classifyPatch). 확인됐던 desktop 핸들러가 이후 깨져 매 handoff가 `HANDLER_UNVERIFIED`(prospectively, 위 desktop 분기 참고)로 preserve-pause를 반복하면, 사람이 별도로:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" spawn-style reset-desktop --owner <run_id> --generation <n>
```

로 `desktop → visible`을 fenced 전이시킨 뒤(`desktop`이 아니면 exit 1 `SOURCE_INVALID`), 다시 opt-in 절차(§2-5-1)를 밟아 재확인할 수 있다.
