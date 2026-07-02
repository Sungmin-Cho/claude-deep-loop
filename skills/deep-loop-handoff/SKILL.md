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

## 개요

`/deep-loop-handoff` — 마일스톤 없이 언제든 깔끔한 handoff(인수인계)를 emit하고, 선택적으로 respawn한다.

## 단계 1: 현재 Lease 확인

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.lease
```

`owner_run_id`와 `generation`을 확인한다.

## 단계 1.4: 세션 model/effort refresh (emit/respawn 전 항상)

emit·respawn 이전에 현재 세션의 model/effort를 durable state에 갱신해, 새 세션이 부모와 같은 model/effort로 열리도록 한다(self-healing). `intent:'lease'`라 이미 emit된(releasing) handoff에서도 통과한다:

```bash
CLAUDE_EFFORT_VAL=$(node -e "process.stdout.write(process.env.CLAUDE_EFFORT||'')")
# 관측된 값만 플래그로 넣는다(빈 effort는 커널이 INVALID_EFFORT로 거부하므로 생략).
SP_ARGS=(session-profile set --model "<이 세션의 모델 ID>" --owner <run_id> --generation <n>)
[ -n "$CLAUDE_EFFORT_VAL" ] && SP_ARGS+=(--effort "$CLAUDE_EFFORT_VAL")
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" "${SP_ARGS[@]}"
```

값이 그대로면 no-op(이벤트 안 쌓임). 관측 실패(model·effort 둘 다) 시 이 단계를 건너뛴다(기존 state로 진행). 이후 emit/respawn이 갱신된 state를 읽는다.

## 단계 1.5: Worktree 진입 불필요

handoff emit과 respawn은 커널 상태 조작이다. 커널 CLI는 `findRoot` 상향탐색으로 project root를 자동 해석하므로 cwd와 무관하게 올바른 경로를 찾는다. handoff descriptor도 project root 기준 경로로 기록된다.

maker/checker 파일 작업은 handoff에서 일어나지 않으므로, worktree 진입 없이 단계 2로 진행한다.

## 단계 2: Handoff Emit (handoff_phase=idle인 경우)

이미 emit된 핸드오프가 있으면 re-emit을 건너뛴다. 먼저 확인:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_chain.lease
```

`lease.handoff_phase === 'emitted'`이면 **re-emit 금지**, 단계 3으로 바로 이동.

`handoff_phase=idle`인 경우에만 emit:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" handoff emit --owner <run_id> --generation <n>
```

산출물:
- `handoffs/<timestamp>-next-session.md` — 다음 세션용 컨텍스트
- `handoffs/<timestamp>-compaction-state.json` — 압축 상태
- `terminal/launch-command.txt` — 재시작 명령

## 단계 3: Terminal 감지 및 Spawn Style 결정

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" detect-terminal --owner <run_id> --generation <n>
```

`session_spawn`과 `autonomy`를 읽는다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_spawn
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field autonomy
```

**분기 (커널 `resolveSpawnMode` 우선순위 headless > desktop > visible > interactive와 동일 순서로 먼저 판정):**

### Unattended (커널 `isHeadlessInvocation(env)` 마커 전용 — non-tty 아님. **가장 먼저 판정** — Desktop/Visible보다 우선)

**판단 기준은 오직 커널의 `isHeadlessInvocation(env)`뿐이다** — `DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS` 또는 드라이버 entrypoint 휴리스틱(`CLAUDE_CODE_ENTRYPOINT`가 sdk*/print/headless/non-interactive) 중 하나가 참일 때만 unattended로 판정한다. **tty 유무는 신호가 아니다** — Claude Desktop Code 탭은 사람이 지켜보는 GUI이지만 tty가 없다(§init의 "attended" 정의와 동일 기준). **이 마커가 하나라도 있으면 durable `autonomy.spawn_style`이 `desktop`이든 `visible`이든 무조건 이 분기가 우선한다** — desktop opt-in한 run이라도 현재 호출이 headless라면(예: drive-headless 사이클 도중) 아래 Desktop 분기로 새지 않는다(커널 `resolveSpawnMode`의 headless-preempts-desktop, 불변식 #6). 마커가 하나도 없으면 아래 Desktop/Visible/Else 분기로 진행한다(non-tty만으로 여기서 멈추지 않는다).

드라이버(`drive-headless.mjs`)가 respawn을 자동으로 처리한다 — **이 스킬은 여기서 `respawn`을 직접 호출하지 않는다** (직접 호출하면 drive-headless 래퍼 없이 측정 usage가 계상되지 않아 예산/fail-closed 모델이 깨진다).

### Desktop (`spawn_style==='desktop'` — init 시 opt-in한 Claude Desktop 딥링크 재시작. **위 Unattended 마커가 없을 때만** 해당)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n> --attended
```

visible과 동일하게 처리한다 — `session_spawn.launcher`가 `none`이어도 커널이 검증된 desktop 엔트리로 자동 재시작한다. init에서 이미 확정한 선택이므로 재질문하지 않는다.

### Visible (spawn_style=visible + launcher≠none)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n> --attended
```

커널이 자동으로 새 세션을 시작한다. 이 스킬은 직접 `claude -p`를 실행하지 않는다(§9).

### Else (launcher=none / visible 아님 / legacy interactive)

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

  `terminal/launch-command.txt` 내용을 사람에게 제시한다. 사람이 직접 새 세션을 시작한다.

- **그 외** (`fenced` 등): 보고만 하고 pause 하지 않는다.

## 다음 세션

새 세션에서 `/deep-loop-resume`을 실행해 handoff.md를 읽고 lease를 인수한다.
