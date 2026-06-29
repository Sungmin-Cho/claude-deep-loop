# Handoff — deep-loop "Self-spawning session continuity" **구현(implementation) 인수인계**

작성일: 2026-06-28
선행 상태: **설계 스펙 + 구현 플랜 작성·리뷰 수렴 완료** (codex-only 2-way 리뷰 spec 14R + plan 7R). 코드는 **아직 0줄** — 이번 인수자의 일은 플랜을 SDD로 구현하는 것.
대상: **새 세션에서 이 기능을 구현하는 작업자(사람 또는 에이전트)**
작업 위치: worktree `worktree-self-spawn-session-continuity` (`main` `8285135`에서 분기). 이 핸드오프/스펙/플랜은 이 브랜치에 커밋되어 있다.

> **source of truth 규칙 (deep-loop 철학):** 이 문서 + 아래 §1 참조(플랜·스펙·리서치) + `git log` + repo 코드를 source of truth로 사용하라. **이전 대화 컨텍스트를 가정하지 말라.** 모든 사실은 repo와 코드에 있다.

---

## 0. 30초 요약

deep-loop에 **OS·터미널 무관 자동 가시(visible) 새-세션 인수** 기능을 추가한다 — 이전 세션의 claude가 감지된 터미널 launcher로 **사용자가 지켜보고 개입 가능한 새 claude 세션**을 자동으로 열어 작업을 이어간다(헤드리스 전용 ❌, 못 찾으면 needs-human 폴백).

**설계는 끝났다.** `docs/superpowers/specs/2026-06-26-self-spawn-session-continuity-design.md`(결정 §0 1-49)가 무엇을·왜, `docs/superpowers/plans/2026-06-27-deep-loop-self-spawn-session-continuity.md`(13개 bite-sized TDD 태스크)가 어떻게. 둘 다 **codex-only 2-way 적대적 리뷰로 수렴**(spec 14라운드, plan 7라운드; `.deep-review/reports`에 전 라운드 로그). **이번 일 = 플랜의 Task 1→13을 SDD로 구현하고, 결과를 다시 codex 2-way 리뷰 루프로 검증하는 것.**

**아키텍처 한 줄:** 커널 `visibleSpawn(entry)` spawnFn을 기존 `headlessSpawn`과 1:1 대칭으로 추가하고, 모든 spawn을 canonical `respawn`(게이트→CAS→handshake) 경유시킨다. 신규 순수 `detect-terminal.mjs`가 launcher를 fail-closed로 식별, `buildLaunchCommand`가 launcher별 `{bin,argv,display,cwd?}` argv entry 생성(셸 재파싱 제거), `pause`(preserve/rollback)·`recover`(사람 escape)·`detect-terminal`이 신규 lease-fenced CLI.

---

## 1. 반드시 먼저 읽을 참조 (우선순위 순)

1. **이 handoff 전체.**
2. **구현 플랜** `docs/superpowers/plans/2026-06-27-deep-loop-self-spawn-session-continuity.md` — Global Constraints + File Structure + Task 1~13(각 태스크는 실제 테스트 코드 + 구현 스케치 + 정확한 파일 경로 + green-per-commit). **이게 작업 지시서다.**
3. **설계 스펙** `docs/superpowers/specs/2026-06-26-self-spawn-session-continuity-design.md` — §0 결정 1-49(리뷰로 다듬어진 의사결정 changelog; 후속 결정이 선행을 정정한 경우 cross-ref 있음), §1(spawn_style+precedence), §3(detect 우선순위 ladder), §7(respawn 배선+CLI), §8(lease/budget), §9(에러/폴백 표), §12(보존 불변식).
4. **리서치** `docs/research/2026-06-25-self-spawn-terminal-spawn-mechanisms.md` — 환경별 spawn 메커니즘 인용 비교(왜 이 형태인지).
5. **리뷰 로그** `.deep-review/reports/*-review.md` + `responses/*` — 같은 함정 회피용. 특히 plan 리뷰 P-R1~R7(테스트/구현 정합 버그가 어떻게 잡혔는지).
6. **기존 코드 (수정 대상)** — `scripts/lib/{handoff,respawn,spawn-driver,state,lease,initrun,detect}.mjs`, `scripts/deep-loop.mjs`, `scripts/hooks-impl/{drive-headless,precompact-handoff}.mjs`, `schemas/loop-run.schema.json`, `skills/deep-loop-{continue,handoff,resume}/SKILL.md`, `tests/*.test.mjs`. **Plan 1·2·3 구현(특히 lease 상태기계 §9.1)을 먼저 이해하라** — 이 기능은 그 위에 얹힌다.

---

## 2. 현재 상태 — 무엇이 있고 무엇이 없나

`main`(`8285135`) + 이 브랜치 기준. `npm test` = **327 tests green**(코드 미변경 — 이번 세션은 설계/플랜만), 의존성 0, Node≥20, type:module.

**있음:**
- 완성·수렴된 **스펙(§0 1-49)** + **플랜(13 태스크)** + **리서치**.
- 기존 lease 상태기계(reserved→emitted→spawned→acquired + handshake), `respawn`(게이트+CAS+spawnFn 주입점, `defaultSpawn`은 throw), `headlessSpawn`(measured, fail-closed), `buildLaunchCommand`(현재는 정적 문자열 5종), `pauseRun`(현재 fence 없는 단순형), `acquireLease`, `respawnGate`.

**없음 (이번 작업이 만들 것 = 플랜 Task 1~13):**
- `detect-terminal.mjs`(순수 fail-closed launcher 감지) + CLI subcommand(releasing-safe, fenced).
- `buildLaunchCommand`의 launcher-aware `{bin,argv,display,cwd?}` argv entry(cmux/iterm2/terminal-app/wt/powershell/headless) + q/escApple/psq 이스케이프.
- `visibleSpawn` + `defaultRun(bin,argv,{cwd})` 일반화.
- `pauseRun` 2모드(preserve/rollback) + fence + **공통 preCheck의 paused-rejects-mutation**, `recoverRun --confirm`.
- `respawn` mode-gate(spawn_style/attended/launcher) + bounded child-readiness(timeout=preserve / launch-fail·gate-blocked=rollback) + CLI `--owner/--generation` fence.
- `acquireLease` preserve/recover-resume unpause.
- `drive-headless`(resume_policy='headless'만), `precompact-handoff`(tty 제거 + isHeadlessInvocation + resume_policy 영속).
- schema(session_spawn 블록, spawn_style enum +'visible', autonomy 필드, launcher_socket, resume_policy/pause_reason).
- skills(continue/handoff/resume 가시 결정 흐름, 읽기/CLI만).

---

## 3. 따라야 할 프로세스 (검증됨)

1. **이 worktree에서 작업** (이미 `worktree-self-spawn-session-continuity`). `npm test`로 327 green 베이스라인 확인.
2. **`superpowers:subagent-driven-development`로 플랜 구현** — 태스크당 fresh subagent + 2-stage 리뷰, 또는 `superpowers:executing-plans`(배치+체크포인트). **플랜의 태스크 순서(1→13)를 지켜라** — 의존 순서다(특히 Task 4가 entry-shape 원자 마이그레이션이라 consumer 동반).
3. **TDD 엄수:** 각 태스크 = failing test 작성 → 옳은 이유로 fail 확인 → 최소 구현 → pass → commit. **green-per-commit**(매 커밋 후 `npm test` green). 커밋 trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
4. **결정론:** time/env/exec 의존 함수는 `now`/`env`/`platform`/`run`/`spawnFn` 주입(테스트는 고정값). 실제 터미널 안 띄움 — 주입 runner로 argv/상태만 검증.
5. **구현 완료 후 codex-only 2-way 리뷰 루프** (`deep-review:deep-review-loop` codex-only, 또는 `node {codex-companion} review/adversarial-review --scope working-tree`) → APPROVE/수렴. 각 finding은 `superpowers:receiving-review`로 검증 후 수락/반박. (이번 설계처럼 KK=A 같은 사용자 결정은 비패치.)
6. **`npm run preflight`** (validate + 전체 `node --test`) green.
7. PR + (사용자 승인 시) merge + deep-suite **SHA re-pin**(marketplace.json ×2 + preflight). 패치는 `integration/deep-suite.patch.md`.

---

## 4. 절대 깨지 말 불변식 (스펙 §12 + CLAUDE.md, 코드+리뷰 강제)

1. **2-plane:** 스킬은 상태 **읽기만**, 변경은 CLI subcommand로만(`detect-terminal`/`handoff`/`respawn`/`pause`/`recover`). 커널은 sibling 스킬 함수호출 ❌. `tests/skills.test.mjs` 강제.
2. **모든 mutating CLI는 lease fence(in-lock)** `--owner/--generation`을 mutate하는 같은 lock/preCheck 안에서 검사. 종료코드 **3=fence**, 2=usage, 1=invalid.
3. **이벤트+상태 = 단일 `appendAnchored` 트랜잭션.** `appendEvent` raw 호출 ❌. (respawn 실패/롤백도 한 트랜잭션 — 자식 메타데이터·부모 superseded_by·lease·status 모두 일관.)
4. **`status==='paused'` 런은 mutation 거부**(공통 preCheck; recover/resume-acquire/breaker-reset만 예외). emitHandoff/respawn/precompact 직접 경로도 포함.
5. **spawn은 반드시 `respawn` 경유**(게이트 budget→breaker→max_sessions→wallclock→auto_handoff + emitted→spawned CAS + handshake; 우회/이중 spawn ❌).
6. **fail-closed 감지:** launcher는 positive host 신호가 있을 때만; 강신호(CMUX_*) probe 실패 시 강등 ❌ → `none`. cmux는 절대 `CMUX_BUNDLED_CLI_PATH`(절대경로) + `CMUX_SOCKET_PATH` + caller surface 요구(bare/default 폴백 ❌).
7. **이스케이프:** argv 토큰 우선; 셸 문자열엔 `q()`(POSIX)/`escApple`(osascript)/`psq`(PowerShell `-EncodedCommand`). `display`(launch-command.txt, 사람 복사)도 `q()`. childRunId/parentRunId(ULID)/handoffRel/root 검증(`UNSAFE_SPAWN_ARG`).
8. **`withLock` 비-reentrant; project root 밖 쓰기 ❌; runId 단일 안전 경로.** 의존성 0; Bash 3.2 hook.
9. **비가역 외부 행동(push/merge/publish/delete)은 proposal-only, 사람 승인.** 세션 spawn은 §9 세션 연속 예외(외부세계 변경 아님).

---

## 5. 핵심 설계 결정 (구현 시 헷갈리기 쉬운 부분 — 리뷰로 다듬어짐)

- **KK=A (사용자 확정):** **visible이 기본값.** `--attended`는 보안 경계가 **아니라 best-effort 선언**(스킬이 mint 가능). 진짜 강제 = 커널 하드 천장(`max_sessions`+`wallclock`, 전 경로)+`per_session_turn_cap`+`isHeadlessInvocation`(confirmed-headless→headless regardless of launcher; indeterminate=accepted residual). adversarial 리뷰는 이를 계속 우려하나 **사용자 결정이므로 비패치**.
- **precedence:** unattended 마커/`spawn_style==='headless'`/isHeadlessInvocation → headless measured. spawn_style=visible + launcher≠none + --attended + not-unattended → visible. 그 외 → handoff emit + `pause --mode preserve`(needs-human). `non-tty`는 신호 ❌(커널 CLI는 항상 non-tty).
- **pause 2모드:** **preserve**(no-launcher needs-human: releasing+예약 child 유지, `expires_at=null`(stale takeover 차단), `resume_policy='human'`; 사람이 launch-command로 수동 resume → acquire가 unpause) / **rollback**(launch-fail·gate-blocked: lease 부모 복귀, 예약 child 무효화). **readiness TIMEOUT ≠ failure → PRESERVE**(visible 자식은 cold-start/auth/trust 대기 가능; 무효화하면 늦은 resume 고아화).
- **child-readiness 조건(정확 lease 필드):** `state==='active' && handoff_phase==='acquired' && owner_run_id===childRunId && generation===시작+1`. (`state==='acquired'`는 오류 — acquired는 handoff_phase.)
- **recover --confirm:** preserve-paused/gate-blocked의 사람 escape(breaker reset --confirm 관례). `status==='paused'` 검증(running/완료/중단 거부) + 예약 child outcome/부모 superseded_by 정리 + lease released + status는 paused('recovered:awaiting-resume') 유지 → fresh acquire가 unpause(stopped로 종료 ❌).
- **resume_policy 인코딩:** 'headless'(driver auto-resume) / 'human'(preserve, driveHeadless skip) / 'visible'(다음 continue가 처리, driver skip). `driveHeadless`는 `resume_policy==='headless'`만 resume(hook 종료 후 실행되므로 intent를 핸드오프에 영속해야 함).
- **max_sessions:** `respawnGate`는 `outcome==='failed_launch'` 세션 제외 카운트(반복 실패가 슬롯 phantom 점유 방지).
- **detect-terminal/pause는 releasing-safe:** handoff emit이 lease를 releasing으로 옮긴 뒤에도 거부되지 않게(session_spawn은 메타데이터; pause는 `intent='lease'` 특권 전이).

---

## 6. 미해결 질문 (구현 중 확정 — 스펙 §14)

1. **`isHeadlessInvocation`의 정확한 신호** — Claude Code가 `claude -p`/비대화형 진입을 노출하는 env(예: `CLAUDE_CODE_ENTRYPOINT`/print-mode). 구현 중 실측 확인. **미확인 시 fail-closed**(precedence의 pause 분기) + 하드 천장 의존. (KK=A 강화 = C 병행.)
2. **cmux CLI contract** — `cmux ping`/`new-workspace --cwd/--command/--focus`/`--socket`는 로컬 cmux.app(번들 CLI)로 실측됨. 버전 드리프트 대비 contract-test 추가.
3. **PowerShell Windows 런타임 검증** — `psq()`+`-EncodedCommand` 인코딩 정확성은 단위테스트로 고정, 실제 Windows 실행은 후속.
4. **`child_ready_timeout_sec` 기본값(60~90s) 튜닝** — 가시 세션 claude 콜드스타트 고려.

스코프 밖(스펙 §13): tmux/screen/wezterm/kitty/VS Code 자동 spawn, `claude --bg`, PreCompact 가시 spawn(emit-only 유지).

---

## 7. 시작 명령 (새 세션에 그대로)

```
cd /Users/sungmin/Dev/claude-plugins/deep-loop   (그 후 worktree-self-spawn-session-continuity 브랜치 체크아웃/worktree)
이 파일(docs/handoff/2026-06-28-self-spawn-implementation-handoff.md)과 §1 참조(plan + spec)를 읽어라.
이전 대화 컨텍스트를 가정하지 말라. `npm test`로 327 green 기준선을 확인하라.
superpowers:subagent-driven-development 로 docs/superpowers/plans/2026-06-27-deep-loop-self-spawn-session-continuity.md 의
Task 1→13 을 순서대로 TDD 구현하라(green-per-commit). 그 후 codex-only 2-way 리뷰 루프(§3-5)로 수렴시켜라.
§4 불변식을 절대 깨지 말라. 새 spawn은 반드시 respawn(게이트+CAS+handshake)을 경유한다.
KK=A(visible 기본값, --attended best-effort, 하드 천장이 진짜 바운드)는 사용자 확정 — 번복 금지.
목표: OS/터미널 무관하게 이전 세션 claude가 새 가시 claude 세션을 자동으로 열어 작업을 이어간다(헤드리스 전용 ❌).
```

---

## 8. 한 줄 요약

설계·플랜은 **수렴 완료**(spec 14R + plan 7R codex 2-way). 이번 일은 **플랜 Task 1~13을 SDD+TDD로 green-per-commit 구현**하고 **codex 2-way로 재검증**하는 것 — 새 코드는 없고, 부족한 건 구현뿐. `detect-terminal`(fail-closed) + `visibleSpawn`(respawn 경유) + `pause/recover`(preserve/rollback/timeout-preserve) + schema/skills 배선. **KK=A는 사용자 확정**, 불변식(§4)은 절대선.
