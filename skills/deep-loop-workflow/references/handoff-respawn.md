# Handoff / Respawn 호출 규약

세션 전환(handoff)과 자율 재시작(respawn) 흐름을 정의한다. §9 참조.

## Handoff 호출자 3종

1. **마일스톤 도달** — `milestone_predicate` 통과 시 `/deep-loop-continue`가 자동 emit
2. **per_session_turn_cap 소진** — budget 게이트가 `handoff` action을 반환
3. **사람 수동 요청** — `/deep-loop-handoff`로 언제든 emit 가능

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

## Interactive vs Headless

### Interactive (사람 개입)

`terminal/launch-command.txt` 내용을 사람에게 제시한다 — 사람이 직접 새 세션을 시작한다.
respawn은 드라이버만 수행한다 (스킬이 직접 spawn하지 않음).

### Headless / 미감시 자율

`DEEP_LOOP_UNATTENDED` 환경 변수가 set되거나 `auto_handoff=true`이고 non-tty이면 headless 강제.
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
2. `lease acquire`로 세션 lease CAS 인수
3. active workstream worktree 경로 무결성 확인
4. `/deep-loop-continue`로 진행
