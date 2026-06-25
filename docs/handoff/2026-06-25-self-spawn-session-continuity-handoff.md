# Handoff — deep-loop "Self-spawning session continuity" (환경 무관 자동 새-세션 인수) 작업 인수인계

작성일: 2026-06-25
선행 상태: **Plan 1+2+3 완료·머지됨** (`main` = `cbadd2b`, deep-suite marketplace 등록 완료).
대상: **새 세션에서 이 기능을 설계·구현하는 작업자(사람 또는 에이전트)**

> **source of truth 규칙 (deep-loop 철학과 동일):** 이 문서 + 아래 §1 참조 파일 + `git log`를 source of truth로 사용하라. **이전 대화 컨텍스트를 가정하지 말라.** 모든 사실은 repo와 코드에 있다.

---

## 0. 30초 요약

deep-loop의 자율 핸드오프(§9)는 "이전 세션이 깨끗한 handoff를 남기고, 새 세션이 이어받는다"는 구조다. **현재 머지된 v1은 두 경로만 있다: (a) 헤드리스 `claude -p` 서브프로세스(무인, 비가시·개입불가), (b) `terminal/launch-command.txt`를 사람에게 제시(사람이 직접 실행).**

**이 작업의 목표 (사용자 요구사항):**
> **OS·터미널 환경에 무관하게, "이전 세션의 claude"가 "새 claude 세션"을 자동으로 열어 작업을 이어가는 구조.** 새 세션은 **가시적**이어야 하고(사용자가 진행을 지켜보고 중간에 개입 가능), 헤드리스 전용이 아니어야 한다.

사용자가 제안한 흐름:
1. **deep-loop 실행 시 현재 세션의 OS/터미널 환경을 확인**한다.
2. **환경이 확인되면 "새 세션 여는 방법"을 결정하고 저장**한다(loop.json에 영속).
3. **작업 중 새 세션이 필요하면, 저장된 환경에 따라 새 가시 세션을 열어 작업을 이어간다.**

**왜 지금 구조로는 안 되나 (이번 세션에서 확정된 핵심 제약):** Claude Code 에이전트는 자기 도구(Bash 등)를 **TTY가 없는 샌드박스 서브프로세스**에서 실행한다. 따라서 에이전트가 단순히 `claude -n …`을 Bash로 실행하면 **자식 서브프로세스**가 될 뿐, 사용자가 보고 입력할 수 있는 **가시적 인터랙티브 세션이 아니다**(사실상 헤드리스와 동일). **가시적 새 세션은 터미널 앱/멀티플렉서가 TTY 표면(새 창/탭/pane)을 열어 그 안에서 claude를 실행해야만** 생긴다 — 이건 환경 특화 동작이다. 이 작업의 본질은 **"환경 감지 → 환경별 가시-세션 spawn 방법 → 그 방법으로 자동 spawn"**을 일반화하는 것이다.

작업 위치: `/Users/sungmin/Dev/claude-plugins/deep-loop` (`main`이 Plan 1+2+3 머지본). 이 handoff 자체는 `docs/self-spawn-handoff` 브랜치에 있다 — `main`에서 새 worktree를 만들어 시작하라.

---

## 1. 반드시 먼저 읽을 참조 (우선순위 순)

1. **이 handoff 전체.**
2. **설계 스펙** `docs/superpowers/specs/2026-06-24-deep-loop-design.md` — 특히 **§9(자율 핸드오프/respawn), §9.1(세션 lease/fencing 상태기계), §1.1(커널↔Execution 계약), §16(버전 로드맵 — v1 autonomy 상한)**.
3. **현재 핸드오프/스폰 구현 (이 작업이 바꿀 코드):**
   - `scripts/lib/handoff.mjs` — `buildLaunchCommand({root,parentRunId,childRunId,handoffRel,headless})` (launch 명령 변형 생성), `emitHandoff(...)` (handoff.md/compaction-state/launch-command.txt 방출 + lease 상태전이).
   - `scripts/lib/respawn.mjs` — `respawn(root,runId,{childRunId,key,handoffRel,headless,now,spawnFn})` (게이트 + emitted→spawned CAS + spawnFn 호출 + 실패 롤백), `respawnGate` (budget→breaker→max_sessions→wallclock→auto_handoff), `defaultSpawn`(미주입 시 `SPAWN_NOT_WIRED` throw).
   - `scripts/lib/spawn-driver.mjs` — `headlessSpawn(cmd,{run})` (동기 `spawnSync('bash',['-c',cmd])`, usage 파싱, fail-closed), `parseUsage`, `defaultRun`.
   - `scripts/hooks-impl/drive-headless.mjs` — cron 드라이버: pending handoff 감지 → `respawn(...,spawnFn=headlessSpawn)`로 측정 resume + cost 기록.
   - `scripts/hooks-impl/precompact-handoff.mjs` — PreCompact hook: **emit-only** + post-emit `respawnGate` → gate-blocked면 `pauseRun`.
   - `scripts/lib/initrun.mjs` — `autonomy.{spawn_style:'interactive', auto_handoff, unattended_detect:['non-tty','driver:cron|loop','--unattended']}`, `budget.{unattended_requires_headless, on_unmeasurable_usage:'fail-closed'}`. loop.json 초기 형태.
   - `skills/deep-loop-resume/SKILL.md`, `skills/deep-loop-handoff/SKILL.md`, `skills/deep-loop-workflow/references/handoff-respawn.md` — 인수/handoff 스킬 지침.
   - `schemas/loop-run.schema.json` — loop.json 스키마(새 환경 필드 추가 시 검증).
4. **Plan 3 구현 리뷰 로그** `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan3-impl-review-log.md` — respawn/handoff/headless 라이프사이클이 Codex 8라운드로 다듬어진 이력(같은 함정 회피). **특히: lease handshake(reserved child가 releasing lease를 직접 acquire), per-maker proof, headless fail-closed, driveHeadless가 canonical respawn 재사용.**

---

## 2. 현재 상태 — 무엇이 있고 무엇이 없나

`main`(`cbadd2b`) 기준. `npm run preflight` = validate + **327 tests green**, 의존성 0, Node≥20, type:module.

**있음 (재사용/수정 대상):**
- `buildLaunchCommand`가 이미 5개 변형을 만든다: `interactive`(`cd … && claude -n deep-loop-<id> "…resume"`), `headless`(`claude -p … --output-format json --permission-mode acceptEdits`), `macos`(osascript→Terminal.app), `windows`(wt.exe→Windows Terminal), `tmux`(tmux new-window). **단, 이 변형들은 정적 문자열일 뿐 — 환경 감지·자동 선택·실제 spawn은 안 한다.**
- `respawn`은 `spawnFn` 주입점이 있다. `defaultSpawn`은 throw. 현재 주입자는 `drive-headless.mjs`(headlessSpawn)뿐.
- lease 상태기계(§9.1)는 reserved→emitted→spawned→acquired + reserved-child handshake가 완성됨. **새 spawn 경로도 반드시 이 게이트+CAS+handshake를 통과해야 한다(우회 금지).**

**없음 (이 작업이 만들 것):**
- **터미널/OS 환경 감지** (`detect.mjs`는 sibling plugin 감지만 — 터미널 env 감지 0).
- **환경별 "가시 세션 열기" 방법 결정 + loop.json 영속**.
- **에이전트가 직접 가시 새 세션을 spawn하는 경로**(현재는 headless 서브프로세스 또는 사람이 명령 실행).
- 환경 미확정 시 안전 폴백.

---

## 3. 이번 세션에서 확정된 기술 사실 (재발견 금지)

1. **TTY 제약 (가장 중요):** 에이전트가 Bash로 `claude -n …`을 실행 = 현재 세션의 **자식 서브프로세스**(stdin이 TTY 아님) → 가시·인터랙티브 세션이 **아님**. 가시 세션은 **터미널 앱/멀티플렉서가 TTY 표면을 열어** 그 안에서 claude를 실행해야만 생긴다.
2. **`claude` CLI 플래그 (검증됨, v2.1.191):**
   - `-n, --name <name>` — 세션 **표시 이름**만 설정(여는 메커니즘 아님). `claude -n deep-loop-<id> "…"`는 *이름 붙은 인터랙티브* 세션.
   - `-p, --print` — 비인터랙티브(헤드리스).
   - `-r, --resume [id]` / `--session-id <uuid>` — 세션 재개/지정(uuid 필요). `--fork-session` — 재개 시 새 세션 id.
   - `--bg, --background` — 백그라운드 에이전트로 시작하고 즉시 반환(`claude agents`로 관리). **헤드리스 가시성 대안 후보 — 조사 대상.**
3. **현재 작업 환경(예시 — 사용자 머신):** `TERM_PROGRAM=ghostty`, tmux 아님, `claude` 바이너리가 **cmux.app 번들**. 즉 사용자는 **cmux**(Ghostty 기반 에이전트 세션 멀티플렉서)를 쓴다.
   - **cmux CLI** (`/Applications/cmux.app/Contents/Resources/bin/cmux`, Unix 소켓 제어): `cmux open <path> [--workspace|--surface|--pane|--window] [--focus]`, **`cmux claude-teams [claude-args…]`**(claude 세션 spawn), `cmux codex-teams`, `cmux docs api` 등. → **에이전트가 cmux CLI로 새 가시 surface에서 claude 세션을 띄울 수 있다** = 사용자 의도의 핵심 메커니즘.
   - **Ghostty CLI**: `ghostty -e <command>`(새 터미널에서 명령 실행), `ghostty +new-window`.
4. **환경별 가시-세션 spawn 메커니즘 후보 (조사·구현 대상):**
   | 환경 | 메커니즘 |
   |---|---|
   | cmux | `cmux open …`/`cmux claude-teams …` (Unix 소켓 CLI) |
   | tmux | `tmux new-window`/`split-window '<cmd>'` (같은 터미널, 새 pane — 가시·개입 최적) |
   | GNU screen | `screen -X screen <cmd>` |
   | Ghostty | `ghostty -e <cmd>` / `+new-window` |
   | macOS Terminal.app / iTerm2 | `osascript`(AppleScript do script) |
   | Windows Terminal | `wt.exe -d <root> <cmd>` |
   | WezTerm / Kitty | `wezterm cli spawn`, `kitty @ launch` |
   | 미상/폴백 | launch-command.txt 제시 + 사람 실행(현행), 또는 `--bg` 백그라운드 |
5. **감지 신호:** `process.platform`(darwin/linux/win32), `$TERM_PROGRAM`(ghostty/iTerm.app/Apple_Terminal/WezTerm/vscode…), `$TMUX`/`$STY`(멀티플렉서), cmux 소켓(`$CMUX_SOCKET_PASSWORD`/cmux.app 존재), `$WT_SESSION`(Windows Terminal), TTY 여부(`process.stdout.isTTY`), `which <launcher>`.

---

## 4. 제안 설계 (사용자 3단계 + 구체화)

목표: 환경 무관하게 **에이전트가 가시 새 세션을 자동 spawn**. 단 기존 안전 불변식(§5)을 절대 깨지 않는다.

### 4.1 환경 감지 + 영속 (단계 1·2)
- 신규 `scripts/lib/detect-terminal.mjs` (또는 `detect.mjs` 확장): platform + TERM_PROGRAM + 멀티플렉서(tmux/screen/cmux) + Windows Terminal 등 신호로 **환경 식별** + 사용 가능한 **launcher** 결정(`which`/소켓/앱 존재 확인).
- `init-run`(또는 첫 tick) 시 결과를 loop.json의 새 블록 `session_spawn`에 영속. 예:
  ```jsonc
  "session_spawn": {
    "platform": "darwin", "term_program": "ghostty", "multiplexer": "cmux",
    "launcher": "cmux",                    // cmux|tmux|screen|ghostty|terminal-app|iterm2|wt|wezterm|kitty|none
    "spawn_template": "cmux open <ROOT> --pane --focus -- <CMD>",   // 결정론 템플릿(검증된 형태)
    "visible": true, "verified": false,   // 4.4 검증 게이트 통과 시 true
    "fallback": "launch-command-file"      // launcher 미상/검증 실패 시
  }
  ```
  (정확한 필드/스키마는 plan에서 확정 — `schemas/loop-run.schema.json` 갱신 필요.)
- **autonomy 의미 재정의:** `spawn_style`에 **`visible`(또는 `auto-visible`)** 도입 — 에이전트가 환경 launcher로 가시 세션을 자동 spawn. 기존 `interactive`(사람이 명령 실행)·`headless`(무인 서브프로세스)는 폴백/opt-in으로 유지. 사용자 의도의 기본값은 **visible**.

### 4.2 가시 세션 spawn (단계 3)
- `buildLaunchCommand`를 **환경 인지**로 확장: `session_spawn.launcher`에 맞는 변형을 골라 `claude -n deep-loop-<childId> "Read .deep-loop/runs/<parent>/<handoffRel> first; then run /deep-loop-resume"`를 **가시 표면에서** 실행하는 명령을 생성.
- 신규 `spawnFn` (예: `spawn-driver.mjs`의 `visibleSpawn(cmd, {launcher})` 또는 신규 모듈): 환경 launcher를 통해 새 가시 세션을 띄운다. **fire-and-forget이되 launch 성공/실패는 관측**(런처 종료코드)해 `respawn`의 실패모드 B(롤백) 또는 성공 경로를 정확히 타게 한다.
- `respawn`에 이 `visibleSpawn`을 주입하는 호출자: `/deep-loop-continue`의 Decide 단계 + `/deep-loop-handoff` + PreCompact(가시 환경이면). **반드시 `respawn`을 경유**(게이트+CAS+handshake 재사용 — Plan 3 구현리뷰 round 6의 교훈).

### 4.3 lease/가시성 정합 (Plan 3 교훈 적용)
- 새 가시 세션은 **비동기/독립 프로세스**(사용자가 지켜보는 별도 표면)다. 따라서 respawn은 reserved-child handshake로 lease를 넘기고(자식이 `releasing` lease를 acquire), 부모는 launch 성공만 확인 후 종료/대기. **동기 spawn으로 부모를 블록하지 말 것**(자식이 acquire 못 해 데드락 — Plan 3 impl round 1·2 참조).
- **비용 회계:** 가시 인터랙티브 세션은 usage를 부모가 측정하기 어렵다(별도 표면에서 사람과 상호작용). interactive 세션의 cost 자기보고(continue tick의 `budget record`)를 살리고, 헤드리스에서만 driver 측정 — 즉 **visible 모드는 best-effort 예산(사람 감시) + per_session_turn_cap 선제 핸드오프**, headless 모드만 측정 fail-closed. (spec §9 예산 강제 분해와 일치.)

### 4.4 환경 미확정/검증 폴백 (안전)
- launcher를 못 정하거나 spawn 검증(4.4) 실패 → **조용히 헤드리스로 전환 금지**(사용자 의도 위배). 대신 `launch-command.txt`를 사람에게 제시(현행 인터랙티브) + needs-human. 또는 사용자가 명시 opt-in한 경우에만 headless.
- (선택) 1회 **spawn 검증**: 감지 직후 무해한 가시 세션(예: 즉시 종료하는 `claude -n probe -p "ok"` 또는 빈 셸)을 launcher로 띄워 동작 확인 → `session_spawn.verified=true`. 검증 안 되면 폴백.

---

## 5. 절대 깨지 말 불변식 (Plan 1·2·3에서 확립)

1. **2-plane 경계 + §1.1:** 스킬은 상태를 **읽고**, 변경은 **CLI subcommand로만**. 커널은 sibling 스킬을 함수 호출하지 않는다. 새 spawn 경로도 동일.
2. **모든 변경 CLI는 lease fence(in-lock)**. 새 spawn은 `respawn`을 경유해 게이트(budget→breaker→max_sessions→wallclock→auto_handoff) + emitted→spawned CAS + handshake를 그대로 통과(우회/중복 spawn 금지).
3. **이벤트+상태 변경은 단일 `appendAnchored` 트랜잭션**. half-commit 금지. 새 `session_spawn` 영속도 fenced write(state patch 화이트리스트 또는 커널 경로).
4. **터미널 상태는 proof 파생.** finish completed는 per-maker bound-approved proof.
5. **비가역 외부 행동(push/merge/publish/delete)은 proposal-only, 사람 승인.** 새 세션 spawn은 "세션 연속"이라 외부세계 변경이 아님(§9 예외) — 단 **사용자 가시성 보장**이 이 작업의 추가 요구.
6. **respawn 게이트 + 미감시 정책.** visible 모드 도입 후에도: 진짜 무인(사람 없음)은 여전히 headless 측정 fail-closed가 안전. **visible은 "사람이 지켜보는 자율"** — 게이트는 유지하되 측정 강제는 best-effort(사람 감시가 바운드).
7. **worktree 연속성 결정론**(고아화 ❌). **project root 밖 쓰기 ❌**. `runId`/경로 안전.
8. **환경 특화 명령은 검증된 형태만** — 임의 셸 인젝션 금지(handoffRel/childId 이스케이프). cmux/wt/osascript 인자 따옴표 처리 주의.

---

## 6. deep-research 태스크 (이 작업에 포함 — 사용자 요청)

구현 전에 **deep-research 스킬**(`/deep-research` 또는 `Skill({skill:"deep-research"})`)로 다음을 조사하고 결과를 plan에 반영하라:

> **연구 질문: "LLM 에이전트(Claude Code/Codex)가 OS·터미널 에뮬레이터·멀티플렉서에 무관하게, 사용자가 지켜보고 개입할 수 있는 새 인터랙티브 터미널 세션을 자기 자신에서 프로그램적으로 여는(spawn) 신뢰성 있는 방법은 무엇인가?"**

조사 항목:
- 환경별 가시-세션 spawn 메커니즘 + **정확한 CLI/스크립트 형태**: tmux(`new-window`/`split-window`), GNU screen, **cmux**(소켓 API — `cmux docs api`로 스키마 확인), Ghostty(`-e`/`+new-window`), iTerm2/Terminal.app(AppleScript), Windows Terminal(`wt.exe`), WezTerm(`wezterm cli spawn`), Kitty(`kitty @ launch`), VS Code 통합 터미널.
- **감지 신호의 신뢰성**: `TERM_PROGRAM`/`$TMUX`/`$STY`/`$WT_SESSION`/cmux 소켓/`process.platform`/`isTTY` — 오탐·미탐 사례(예: tmux 안에서 TERM_PROGRAM이 비거나 stale).
- **에이전트 샌드박스에서 launcher 소켓/명령 접근 가능성**(권한/샌드박스 제약).
- `claude --bg`(백그라운드 에이전트) + `claude agents`가 "가시성+개입"을 어느 정도 대체하는지.
- **폴백 전략**(launcher 미상 시) + **detached 프로세스가 부모 종료 후에도 생존**시키는 표준 기법(`setsid`/`disown`/`nohup`/`spawn detached+unref`)과 그 한계.
- 각 메커니즘의 **OS 이식성·검증 가능성·실패 모드** 비교표.

산출물: cited 비교 리포트 → plan의 §4(환경별 spawn 템플릿 표) + 폴백 정책에 반영.

---

## 7. 따라야 할 프로세스 (Plan 1·2·3과 동일 — 검증됨)

1. **새 worktree를 `main`에서 생성** (`superpowers:using-git-worktrees`; `EnterWorktree`). baseline `npm test` green 확인.
2. **(사용자 요청 시) deep-research** (§6) 먼저 수행 → 결과를 plan 입력으로.
3. **`superpowers:writing-plans`로 plan 작성** → `docs/superpowers/plans/2026-06-25-deep-loop-self-spawn-session-continuity.md`. Plan 1·2·3과 동일 bite-sized TDD 형식. 결정론 글루(detect-terminal, visibleSpawn, buildLaunchCommand 확장, session_spawn 영속/스키마)는 단위테스트; 환경 특화 명령은 주입 가능한 runner로 테스트(실제 터미널 안 띄움).
4. **Codex-only 2-way 리뷰 루프** (`deep-review:deep-review-loop` codex-only, 또는 `codex exec -s read-only --output-schema`) → APPROVE 수렴. 각 finding은 receiving-review로 검증 후 수락/반박.
5. **`superpowers:subagent-driven-development`로 구현** (implementer sonnet, 게이트 = `npm test` green).
6. **구현 결과에 대해 Codex-only 2-way 리뷰 루프** → APPROVE.
7. PR + merge + (사용자 승인 시) deep-suite **SHA re-pin**(marketplace.json ×2 + `npm run preflight`). suite-extensions의 `artifacts`/`hooks_active`에 변화 있으면 갱신.

---

## 8. 시작 명령 (새 세션에 그대로)

```
cd /Users/sungmin/Dev/claude-plugins/deep-loop   (Plan 1+2+3 머지된 main)
이 파일(docs/handoff/2026-06-25-self-spawn-session-continuity-handoff.md)과 §1 참조를 읽어라.
이전 대화 컨텍스트를 가정하지 말라. `npm test`로 327 green 기준선을 확인하라.
superpowers:using-git-worktrees 로 main에서 새 worktree를 만들고,
(사용자 요청 시) deep-research(§6)로 환경별 가시-세션 spawn 방법을 조사한 뒤,
superpowers:writing-plans 로 plan을 작성하고, Codex-only 2-way 리뷰 루프(§7)로 수렴시키고,
SDD로 구현한 뒤 다시 Codex 리뷰 루프로 검증하라.
§5 불변식을 절대 깨지 말라. 새 spawn은 반드시 respawn(게이트+CAS+handshake)을 경유한다.
목표: OS/터미널 무관하게 이전 세션 claude가 새 **가시** claude 세션을 자동으로 열어 작업을 이어간다(헤드리스 전용 ❌).
```

---

## 9. 핵심 요약 (한 줄)

`buildLaunchCommand`는 이미 변형 문자열을 만든다 → 부족한 건 **(1) 터미널/OS 환경 감지·영속(`session_spawn`), (2) 환경별 가시-세션 launcher로 실제 spawn하는 `visibleSpawn` (respawn 경유), (3) 미상 시 안전 폴백.** 헤드리스는 무인 폴백/opt-in으로 강등하고, **기본은 사람이 지켜보는 가시 자율**로 만든다. 에이전트는 Bash 서브프로세스로 가시 세션을 못 만든다(TTY 제약) — **반드시 터미널 앱/멀티플렉서 launcher를 구동**해야 한다.
