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

## 단계 1.5: Active Worktree 진입

handoff 파일 작업이 올바른 격리 공간에서 일어나도록, **handoff emit 전에** active workstream의 worktree로 진입한다.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field workstreams
```

active workstream의 `worktree` 경로를 읽는다. native attach 도구(`EnterWorktree` 등)가 있으면 그것으로 진입하고, 없으면 `cd`로 전환한다. 커널 상태(`rootOf` 상향탐색)는 cwd 이동 후에도 원본 root를 자동 해석하므로 `--project-root`는 불필요하다.

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

**분기:**

### Visible (spawn_style=visible + launcher≠none)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" respawn --owner <run_id> --generation <n> --attended
```

커널이 자동으로 새 세션을 시작한다. 이 스킬은 직접 `claude -p`를 실행하지 않는다(§9).

### Unattended (드라이버 마커 / DEEP_LOOP_UNATTENDED / non-tty)

드라이버(`drive-headless.mjs`)가 respawn을 자동으로 처리한다.

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
