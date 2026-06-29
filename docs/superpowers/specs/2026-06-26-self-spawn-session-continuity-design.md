# 설계 — deep-loop "Self-spawning session continuity" (환경 무관 자동 가시 새-세션 인수)

작성일: 2026-06-26
선행: Plan 1+2+3 머지본(`main`), 핸드오프 `docs/handoff/2026-06-25-self-spawn-session-continuity-handoff.md`, 리서치 `docs/research/2026-06-25-self-spawn-terminal-spawn-mechanisms.md`.
상태: brainstorming 승인 완료 → 이 문서는 writing-plans의 입력.

> **source of truth 규칙:** 이 문서 + 위 선행 파일 + `git log` + repo 코드. 이전 대화 컨텍스트를 가정하지 말라.

---

## 0. 목표 · 스코프 · 확정된 결정

**목표:** OS·터미널 무관하게, 이전 세션의 claude가 **새 가시(visible) claude 세션**을 자동으로 열어 작업을 이어간다. 새 세션은 사용자가 지켜보고 중간 개입 가능해야 하며, 헤드리스 전용이 아니다.

**핵심 제약(확정):** 에이전트의 Bash 도구는 TTY 없는 샌드박스 서브프로세스에서 실행된다(실측 `isTTY===undefined`). 따라서 `claude -n …`을 그냥 실행하면 헤드리스 자식일 뿐이다. 가시 세션은 **터미널 앱/멀티플렉서가 TTY 표면을 열어 그 안에서 claude를 실행**해야만 생긴다. 리서치 결론: 단일 OS-무관 API는 없다 → **detect-then-dispatch 테이블 + explicit-socket + fail-closed 폴백**.

**v1 스코프 (사용자 확정):**
- 자동 가시 spawn 구현 launcher: **cmux**(사용자 실제 환경), **macOS Terminal.app + iTerm2**, **Windows Terminal + PowerShell**.
- 그 외(tmux·screen·WezTerm·kitty·VS Code/Cursor 등) → **폴백**(needs-human). detect 테이블은 확장 가능하게 설계.
- **폴백 = needs-human 제시만**(launch-command.txt + paused). `claude --bg`는 v1 미포함(후속 과제).

**브레인스토밍 확정 결정:**
1. 아키텍처 = **Approach A**: 커널 `visibleSpawn` spawnFn(`headlessSpawn`과 1:1 대칭), 모든 spawn은 `respawn`(게이트+CAS+handshake) 경유.
2. launcher 명령은 **argv 형태**로 생성·실행(셸 재파싱 레이어 제거; `root`는 별도 토큰).
3. `session_spawn`은 **spawn하는 세션이 매번 재감지**해 갱신(init 세션과 터미널이 다를 수 있음).
4. capability probe는 **비침습만**(소켓 ping / `which` / `osascript id`) — throwaway 창 안 띄움.
5. PreCompact hook은 v1에서 **emit-only 유지**(가시 spawn은 다음 continue/resume이 수행) — 단 headless 플래그는 새 규칙 따름(아래 결정 13).

**Codex 2-way 리뷰 Round 1 반영 (수정 결정):**
6. **`non-tty`를 unattended 신호로 쓰지 않는다** (🔴 unanimous). 커널 CLI는 attended(cmux) 세션에서도 항상 non-tty 서브프로세스라 attended/unattended를 구분 못 한다. unattended = 명시 driver 마커(`driver:cron|loop`/`--unattended`)만, attended/visible 가능성은 `session_spawn.launcher != none`로 판정. `initrun`의 `unattended_detect`에서 `non-tty`를 **제거**한다.
7. **visible respawn은 launcher exit 0만으로 성공 처리하지 않는다** (🟡). visibleSpawn 후 **bounded child-readiness handshake**로 자식의 lease acquire(generation+1)를 짧은 deadline 동안 확인한 뒤 성공 확정; 미확인 → 실패모드 B 롤백 → paused. (lease가 releasing이므로 wait-for-acquire는 deadlock 없음.)
8. **PowerShell injection 차단** (🟡 → R2에서 보강). (R1) `-EncodedCommand`. (R2-E 보강) -EncodedCommand만으로는 불충분 — decode 후 PS가 재파싱하므로 inner 스크립트의 동적 값에 **`psq()`(PS 단일따옴표 escape `'`→`''`) 필수**.
9. **폴백은 `status='paused'`** + needs-human "이유"는 handoff.md/`triage.needs_human`에 기록 (🟡). `needs-human`은 status enum이 아님(`running/paused/completed/stopped`만 허용) — 새 enum 도입하지 않음.

**Codex 2-way 리뷰 Round 2 반영 (fail-closed 강화):**
10. **감지는 fail-closed + positive host 신호 요구** (🔴 R2-F/G). launcher는 "현재 세션이 그 터미널에 호스팅됨"의 positive 증거가 있을 때만 선택("항상 reachable" 기본 launcher 없음). **강신호(CMUX_*) probe 실패 시 다른 launcher로 강등하지 않고 `none`(fail-closed)**.
11. **cmux는 `CMUX_BUNDLED_CLI_PATH` 사용** (🔴 R2-F). probe·bin 모두 bare `cmux`가 아닌 env 제공 바이너리 경로를 쓰고 `session_spawn.launcher_bin`에 영속.
12. **precedence fail-closed** (🟡 R2-G). unattended=명시 마커만→headless / launcher≠none(positive)→visible / else→paused. **마커 빠진 cron이 미측정 visible로 새지 않음.**
13. **PreCompact headless 계산에서 `input.tty === false` 제거** (🟡 R2-H). `precompact-handoff.mjs`도 명시 마커(`input.unattended`/`spawn_style`)로만 headless 판정 — compaction 시 visible 세션이 headless로 새지 않게.

**Codex 2-way 리뷰 Round 3 반영 (correctness):**
14. **POSIX 셸 문자열 root는 `q()` 의무 + headless는 bash 제거** (🔴 R3-I, unanimous). osascript inner `cd <q(root)>`; headless는 `spawnSync('claude',args,{cwd:root})`. POSIX 이스케이프 테스트.
15. **no-launcher 폴백은 fenced `pause`로 paused 도달** (🔴 R3-J). `state patch`는 status default-deny → 전용 fenced `deep-loop pause`(pauseRun + fence)로 `status='paused'`+`pause_reason`. handoff emit만으로 끝내 lease를 emitted/releasing에 stranded시키지 않음.
16. **visible은 명시 attended assertion 필요** (🔴 R3-K). positive launcher 단독 불충분 — continue/handoff 스킬이 `--attended` 전달, driver는 안 줌. **→ KK(42)로 정정:** `--attended`는 markerless를 **막는 보안경계가 아니라** best-effort 선언이다(skill이 mint 가능). markerless의 진짜 차단은 hard 천장 + headless-invocation 감지. ("markerless→paused"는 cron이 --attended를 안 줄 때의 best-effort 동작.)
17. **respawn mode는 `spawn_style==='visible'` 게이트** (🟡 R3-L). 레거시 'interactive'/'headless' 런은 launcher 있어도 visible 안 됨.
18. **cmux는 caller surface(`CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID`) 요구 + 명령 로컬 실측** (🟡 R3-M). 소켓만 상속된 비-cmux 프로세스는 fail-closed. `ping`/`new-workspace` 인자는 cmux.app CLI로 검증, plan에 contract-test.

**Codex 2-way 리뷰 Round 4 반영 (일관성/보안):**
19. **entry에 `bin:'bash'`/`-c` 일절 없음** (🔴 R4-N). headless = `{bin:'claude',argv,cwd:root}`; defaultRun `(bin,argv,{timeout,cwd})`. §5 반환형·§6 모두 정리(이전 잔존 bash 참조 제거).
20. **cmux는 절대 `CMUX_BUNDLED_CLI_PATH`만** (🔴 R4-O). 없으면 fail-closed none(bare 'cmux' PATH 폴백 ❌ — PATH hijack/오작동 차단). ladder·command 테이블 동일.
21. **명시 `spawn_style==='headless'` opt-in 보존** (🟡 R4-P). 마커 없어도 headless로 라우팅(precedence §1.1 + respawn mode). 레거시 headless 핸드오프/precompact 회귀 방지.
22. **cmux `--command` 동적값도 escape/검증** (🟡 R4-Q). resumePrompt의 `<parentRunId>`(ULID)·`<handoffRel>`(통제 경로)도 일관 처리 + cmux escape 테스트.

**Codex 2-way 리뷰 Round 5 반영 (최종):**
23. **cmux `--command`는 전체 q() ❌, 동적 *인자만* q()** (🔴 R5-R, unanimous — R4-Q의 모호성 정정). `claude -n <q(inner)> <q(resumePrompt)>` 형태 + shell-parse contract test로 claude argv 검증.
24. **macOS는 `$TMUX`/`$STY` 시 Darwin 분기 전에 fail-closed** (🔴 R5-S, unanimous). 멀티플렉서 안에선 TERM_PROGRAM이 stale → iterm2/terminal-app 오라우팅 방지(none, reason='multiplexer-v1-unsupported'). macOS TERM_PROGRAM은 best-available host 신호(surface-id env 부재), spoofing은 --attended 게이트 + 사용자 override로 bound.

**Codex 2-way 리뷰 Round 6 반영 (lease 정합):**
25. **`pause`는 releasing-safe 특권 전이** (🔴 R6-T). handoff emit이 lease를 releasing으로 옮기고 `leaseCheck`가 business write를 거부하므로, pause는 `intent='lease'`로 status=paused+pause_reason+lease 롤백을 단일 트랜잭션 — 일반 fenced pause면 stranded.
26. **child-readiness는 빠른 자식 acquire를 성공으로** (🟡 R6-U). 자식이 respawn-spawned 기록 전 acquire(gen+1, owner=예약child)하면 fenced 아니라 성공. 예약child 아닌 gen 변화만 진짜 fence.
27. **powershell/macOS-terminal은 best-effort tier** (🟡 R6-V). `where`/`TERM_PROGRAM`은 host 확증이 약하므로 강한-host(cmux/wt)와 tier 분리(launcher 선택용). **→ KK(42) 참조:** 안전 bound는 `--attended`가 아니라 §1(하드 천장+headless-invocation 감지); powershell은 추가로 opt-in(R9-CC/34).

**Codex 2-way 리뷰 Round 7 반영 (pause 모드 분리):**
28. **`pause` 2모드 — preserve vs rollback** (🔴 R7-W; general review는 무발견). no-launcher needs-human은 **preserve**(releasing+예약 child 유지 → 사람이 launch-command로 수동 resume 가능); failed 자동 spawn/timeout만 **rollback**(자식 resume 금지). R6-T의 "롤백"은 rollback 모드에만 — preserve에 롤백하면 수동 resume 불가(R7-W). no-launcher→수동-resume 왕복 회귀테스트.

**Codex 2-way 리뷰 Round 8 반영:**
29. **preserve는 `expires_at=null`로 무기한 human-gated** (🔴 R8-X). 안 하면 stale TTL(900s) 후 `releasing && expired`로 누구나 탈취 → 수동 게이트 우회. null이면 예약 child만 acquire.
30. **darwin probe는 stdout/에러로 판정** (🟡 R8-Y). `is running`은 exit0+stdout=false 가능 → false-positive. `id of application`(미설치 에러) 또는 stdout `true` 파싱.
31. **win32 powershell을 실제 선택**(none 아님) (🟡 R8-Z). best-effort launcher로 선택하고 안전은 §1 --attended 게이트가 담당. (R6-V 표현이 powershell을 unreachable로 만든 것 정정.)
32. **module map pauseRun preserve/rollback 정합** (🟡 R8-AA).

**Codex 2-way 리뷰 Round 9 반영 (pause/recovery 완결):**
33. **preserve-paused에 사람-승인 `recover --confirm` escape** (🔴 R9-BB; plan review R1 정정). expires_at=null이 자동 takeover를 막으므로(R8-X) launch-command 분실 시 영구 stuck 가능 → 사람만(`--confirm`, breaker reset 패턴) 예약 필드 clear + lease released + `status='paused'('recovered:awaiting-resume')`(stopped 아님 — fresh acquire가 unpause). 자동화 불가. → pause/recovery 4-case 완결: 정상 resume(예약child)·rollback(failed spawn)·stale-takeover 차단(expires_at=null)·사람 escape(recover).
34. **powershell auto-visible은 opt-in only** (🟡 R9-CC). `where`는 host 신호 아님 → `autonomy.allow_powershell_visible`(기본 false) 또는 사용자 override일 때만 auto. 없으면 none→needs-human(launch-command.txt엔 powershell display 유지 → 수동 실행 가능). wt가 Windows 기본.

**Codex 2-way 리뷰 Round 10 반영 (사실 교정):**
35. **child-readiness 조건은 실제 lease 스키마로** (🔴 R10-DD, **2/2 unanimous**). `state==='acquired'`는 오류(state∈active/releasing/released; acquired는 handoff_phase) → 올바른 조건 `state==='active' && handoff_phase==='acquired' && owner===reservedChild && generation===시작+1`. 안 그러면 성공한 자식 인수를 false timeout/실패로 오판.
36. **gate-blocked 핸드오프 처리** (🔴 R10-EE → **R12-LL로 정정**). R10-EE는 preserve를 적용했으나, preserve는 resumable 예약 child를 남겨 launch-command가 하드 게이트를 우회함(R12-LL) → **gate-blocked는 `pause --mode rollback`**(예약 child 무효화) + `pause_reason='gate:<which>'`, 재개는 `recover --confirm`(사람, 게이트 인지)만. (preserve는 no-launcher needs-human 전용.)
37. **continue는 기존 emitted 핸드오프(PreCompact) 재사용** (🟡 R10-FF). 이미 `handoff_phase='emitted'`면 새 emit(다른 트리거→handoff-in-flight 표류) 대신 기존 reserved child를 respawn/pause → post-compaction 가시 spawn 완성.

**Codex 2-way 리뷰 Round 11 반영 (driver/fence 봉인):**
38. **preserve 핸드오프는 headless driver 불가시** (🔴 R11-GG). preserve(no-launcher needs-human)에 `resume_policy='human'` 영속 + `driveHeadless`가 그걸 skip → cron이 조용히 headless 실행 못 함(fail-closed 계약을 driver로부터도 봉인). (gate-blocked는 preserve가 아니라 rollback이므로 별개 — 결정 43.)
39. **detect-terminal은 releasing-safe** (🟡 R11-HH). PreCompact 후 releasing 중에도 `session_spawn`만 갱신하는 narrow 전이라 `lease-releasing-carveout`에 안 걸림(FF 재사용 경로가 fenced로 표류 방지).
40. **respawn CLI는 `--owner/--generation` lease fence** (🔴 R11-II). 실제 mutating(visibleSpawn/phase)이므로 불변식대로 in-lock fence — stale caller 차단.
41. **detectTerminal opt-in은 명시 인자** (🟡 R11-JJ). `allowPowershellVisible`를 CLI가 주입(순수 detector가 state 안 읽음).

**Codex 2-way 리뷰 Round 12 반영 (attended 신뢰경계·하드게이트·복구):**
42. **attended는 보안경계가 아니라 best-effort 선언; 진짜 강제는 hard 천장** (🔴 R12-KK). TTY 없는 서브프로세스는 "사람 지켜봄"을 증명 불가 → `opts.attended`는 skill이 mint 가능(순환). 따라서 `max_sessions`+`wallclock`(커널, 전 경로) + `per_session_turn_cap` + **headless-invocation 감지**(claude -p 등, fail-closed)로 bound. `--attended`를 markerless 차단 보안게이트로 과대주장 금지.
43. **gate-blocked는 rollback + recover-only** (🔴 R12-LL). 하드 게이트 차단 시 resumable 예약 child를 남기면 launch-command가 게이트 우회 → rollback(예약 child 무효화) + `recover --confirm`(사람·게이트 인지)만 재개.
44. **recover는 예약 lease 필드를 clear** (🟡 R12-MM). `handoff_child_run_id`/`key`/`expires_at` 정상화 안 하면 acquireLease가 비예약 owner 거부해 escape도 stuck.
45. **반복 launch 실패는 fail-closed paused** (🟡 R12-NN). verified launcher가 launch 시점 실패(소켓 소실 등) 시 rollback 후 active로 두면 무한 재시도 → pause(needs-human)로 동일 launcher 반복 실패 차단.

**Codex 2-way 리뷰 Round 13 반영:**
46. **paused 런은 mutation 거부(부모 fence 무효화)** (🔴 R13-OO). gate-blocked rollback이 lease를 부모로 돌려주면 부모 fence가 유효해 게이트 무시하고 계속 mutate 가능 → **mutation 게이트가 `status==='paused'`면 거부**(recover/resume-handshake만 허용) 또는 generation bump. (consistency: PP=skill flow가 `respawn --owner/--generation` fence 전달; QQ=gate-blocked를 preserve/resume_policy='human'에서 제거(rollback 전용) — §7-GG/§11 정정.)

**Codex 2-way 리뷰 Round 14 반영 (수렴):**
47. **preserve-resume는 paused를 clear** (🔴 R14-RR). reserved child가 preserve-paused를 인수할 때 acquire와 동일 트랜잭션에서 `status='running'`+`pause_reason`/`resume_policy` clear — 안 하면 R13-OO와 충돌해 폴백 무용. (general review PASS.)
48. **KK=A 잔여 우려는 accepted-risk** (R14 finding 2). adversarial은 visible-default를 계속 반대하나 **사용자가 A로 확정**(자동 가시 목표). headless-invocation 감지를 concrete plan 과제(§14-5)로 강화해 점진적 fully-fail-closed. hard 천장이 진짜 바운드(§9 철학).
49. **recover --confirm은 기존 breaker-reset 관례** (R14 finding 3). 새 결함 아님 — `breaker reset --confirm`과 동일 human-approval 패턴. cryptographic 비강제 한계 공유, v2에서 proposal-only/out-of-band 강화.

> **핵심 결정 KK (사용자 확정: A) — visible=default 유지(best-effort 안전):** 핸드오프 원래 목표("자동 가시 기본값")를 살린다. attended는 보안경계가 아니라 best-effort 선언(§1 KK note)이고, 진짜 강제는 deep-loop §9 철학대로 **커널 하드 천장(max_sessions/wallclock, 전 경로)+per_session_turn_cap+headless-invocation 감지(fail-closed)**. adversarial이 visible-default를 계속 우려하나, 사용자 결정은 A(자동 가시 유지). **C 병행:** plan/구현 단계에서 `claude -p`/비대화형 진입의 concrete Claude-Code 신호(§14-5)를 확정해 headless-invocation 감지를 강화 → A가 점진적으로 fully fail-closed가 된다. (B=visible opt-in은 목표 변경이라 미채택.)

---

## 1. `spawn_style` 의미 (enum 확장)

기존 `{interactive, headless}`에 **`visible` 추가, 새 기본값**:

| spawn_style | 의미 | spawn 주체 | 예산 측정 |
|---|---|---|---|
| **`visible`** (신규 기본) | 감지된 launcher로 에이전트가 가시 세션 자동 spawn | 커널 `visibleSpawn` | best-effort(사람 감시)+`per_session_turn_cap` |
| `interactive` (기존, 폴백) | `launch-command.txt`를 사람이 직접 실행 | 사람 | — |
| `headless` (기존, opt-in/무인) | `claude -p` 서브프로세스 | 커널 `headlessSpawn`(드라이버) | timeout+usage, **fail-closed** |

**우선순위(respawn 게이트 통과 후):**
1. **unattended**(`autonomy.unattended_detect`: `driver:cron|loop` / `--unattended` / **headless-invocation 감지** — `claude -p` 등 비대화형 진입을 Claude Code env로 positive 감지(R12-KK; 정확 신호는 §14, 미확정 시 fail-closed=headless)) **OR `spawn_style==='headless'`**(R4-P) → `budget.unattended_requires_headless`로 **headless measured**. ⚠️ `non-tty`는 신호에서 제거(§0 결정 6).
2. **visible** = `spawn_style==='visible'`(R3-L) AND `session_spawn.launcher ≠ none`(positive host 신호+probe, §3) AND **unattended 아님**(§1: 마커/headless-invocation 없음) AND attended 선언(opts.attended).
3. 그 외(`spawn_style==='interactive'` 레거시 / launcher=none) → handoff emit + **`pause --mode preserve`**(`status='paused'`, `pause_reason='needs-human:…'`, releasing+예약 child 유지로 수동 resume, launch-command.txt). **조용한 headless ❌.**

> **⚠️ attended 신뢰 경계 — 정직한 한계(R12-KK):** TTY 없는 샌드박스 서브프로세스에서 "사람이 지켜봄"을 **암호학적으로 증명할 수 없다**. `opts.attended`는 보안 경계가 아니라 **best-effort 선언**이다(skill이 자동화에 의해 호출되면 그 bit를 mint할 수 있음). 따라서 본 설계의 **진짜 강제(hard enforcement)는 deep-loop 기존 §9 철학 그대로 = 커널이 강제하는 `max_sessions` + `wallclock` 천장**(모든 경로 — visible/headless 공통 적용)이며, intra-session은 `per_session_turn_cap`(self-report) + (진짜 attended면) 사람 + (best-effort). markerless 자동화가 skill 경로로 들어와도 **hard 천장으로 바운드**되고, **headless-invocation 감지(§1)** 가 `claude -p` 자동화를 positive하게 headless로 돌린다(미확정 시 fail-closed). 즉 "unattended must be headless"는 (a) 명시 마커 (b) headless-invocation 감지 (c) 못 미더우면 hard 천장 — 3중으로 bound. **`--attended`를 "markerless cron을 막는 보안 게이트"로 과대주장하지 않는다.**

레거시 런(`spawn_style: interactive|headless`)은 그대로 동작(하위호환).

---

## 2. 모듈 맵 + 데이터 흐름

```
신규  scripts/lib/detect-terminal.mjs   (env,platform,run,now) → launcher descriptor  [순수+주입 probe]
변경  scripts/lib/handoff.mjs           buildLaunchCommand → launcher-aware {bin,argv,display} entries
변경  scripts/lib/spawn-driver.mjs      visibleSpawn(entry,{launcher,run}) 추가 + defaultRun (bin,argv) 일반화
변경  scripts/lib/respawn.mjs           session_spawn.launcher 로 entry 선택 (게이트/CAS/handshake/실패모드 무변경)
변경  scripts/lib/initrun.mjs           autonomy.spawn_style 기본 'visible' + session_spawn 초기 블록 + unattended_detect 에서 'non-tty' 제거(§0 결정 6)
변경  scripts/deep-loop.mjs             신규 subcommand detect-terminal(releasing-safe, opt-in 주입) + `pause`(releasing-safe, preserve[resume_policy=human]/rollback) + `recover --confirm`(사람-승인 escape, R9-BB) + respawn 핸들러(--owner/--generation fence, R11-II; visibleSpawn 주입)
변경  scripts/hooks-impl/drive-headless.mjs   pending 핸드오프 스캔 시 resume_policy==='human' skip(R11-GG — preserve/needs-human을 headless로 안 집어감)
변경  scripts/lib/state.mjs             pauseRun 에 fence(owner/generation) + releasing-safe + **2모드: preserve(lease releasing+예약child 유지, expires_at=null) / rollback(부모 복귀)** (R3-J/R6-T/R7-W/R8-X)
변경  schemas/loop-run.schema.json      session_spawn 블록 + spawn_style enum 'visible'
변경  scripts/hooks-impl/precompact-handoff.mjs   headless 계산에서 input.tty===false 제거(R2-H)
변경  skills/deep-loop-{continue,handoff}/SKILL.md + references/handoff-respawn.md  visible 결정 흐름
```

**데이터 흐름 (2-plane):**
```
[Execution plane: continue/handoff SKILL]  (상태는 읽기만, 변경은 CLI로만)
  1. state get → autonomy.spawn_style
  2. deep-loop detect-terminal --owner --generation   ← 커널이 자기 env 재감지 → session_spawn 영속(이벤트+상태 1트랜잭션)
  3. session_spawn.launcher 분기:
       visible(spawn_style=visible+launcher≠none) → deep-loop handoff … → deep-loop respawn --owner <o> --generation <g> --attended(lease 읽어 fence 전달, R11-II)
       unattended(마커) / spawn_style=headless           → headless 드라이버 경로(기존, measured)
       그 외(launcher=none / attended 미assert / 레거시 interactive) → deep-loop handoff … + `pause --mode preserve`(needs-human, 수동 resume 가능)
        │
        ▼
[Control plane: lib/respawn.respawn()]
   게이트(budget→breaker→max_sessions→wallclock→auto_handoff) → emitted→spawned CAS
   → entry=cmds[launcher] → spawnFn(entry)=visibleSpawn(런처 호출, 즉시 반환=launch issued)
   → bounded child-readiness handshake(§8): 자식이 /deep-loop-resume 에서 releasing lease를 acquire(generation+1)할 때까지 deadline 동안 poll
   → 확인(또는 빠른 자식 선acquire) → 성공 / **timeout → preserve(예약 child 유지, late acquire 안전)** / **launch 실패·gate-blocked → rollback(자식 무효화)**
```

---

## 3. `detect-terminal.mjs` — 감지 + 우선순위 + probe

**시그니처(순수 + 주입 probe):** `detectTerminal({ env = process.env, platform = process.platform, run = defaultRun, now, allowPowershellVisible = false }) → descriptor`. **opt-in은 명시 인자(R11-JJ)** — 순수 detector가 `autonomy.allow_powershell_visible`(state)를 직접 읽지 않고 호출자(CLI)가 주입. 시그널 판독은 순수, capability probe만 `run` 주입(테스트 stub). probe는 전부 **비침습**.

**fail-closed 원칙(Codex R2-F/G):** launcher는 **"현재 spawn 세션이 그 터미널에 호스팅됨"의 positive 증거가 있을 때만** 선택한다. "항상 reachable한 기본 launcher"는 없다 — positive 신호 부재 → `none`. **강신호가 있는데 probe가 실패하면 다른 launcher로 강등하지 않고 `none`(fail-closed)** — 엉뚱한 표면에 세션을 열지 않기 위함.

**우선순위 ladder (v1, positive host signal):**
```
1. cmux host 신호 = **절대경로 `CMUX_BUNDLED_CLI_PATH` 존재**(R4-O — 이게 없으면 bare 'cmux' 폴백 ❌ → 바로 none/reason='cmux-no-bundled-bin'; PATH hijack 차단)
     AND **caller surface 존재**(`CMUX_WORKSPACE_ID` || `CMUX_SURFACE_ID`, R3-M — 없으면 소켓만 상속된 비-cmux 프로세스 → new-workspace가 엉뚱한 곳)
     cmux_bin = CMUX_BUNDLED_CLI_PATH (절대경로, 검증됨)
     probe: `<cmux_bin> ping` exit 0 → launcher=cmux (launcher_bin=cmux_bin, surface=CMUX_WORKSPACE_ID 컨텍스트)
            ping 실패 / caller surface 없음 / bundled bin 없음 → launcher='none', reason='cmux-socket-denied'|'cmux-no-surface'|'cmux-no-bundled-bin'  # FAIL-CLOSED, 강등 금지
1.5 **$TMUX || $STY 존재(cmux 아닌 멀티플렉서) → launcher='none', reason='multiplexer-v1-unsupported'** (R5-S)
     # tmux/screen는 v1 launcher 아님 + 그 안에선 TERM_PROGRAM이 stale(iTerm.app/Apple_Terminal로 남음) → Darwin 분기로 가면 오라우팅.
     # Darwin TERM_PROGRAM 신뢰 전에 fail-closed.
2. platform === 'darwin' (그리고 $TMUX/$STY 없음)
     TERM_PROGRAM === 'iTerm.app'      → 후보 iterm2. probe: `osascript -e 'id of application "iTerm"'` (미설치 시 **에러 exit≠0**) → exit 0이면 iterm2 / 아니면 none
     TERM_PROGRAM === 'Apple_Terminal' → 후보 terminal-app. probe: `osascript -e 'id of application "Terminal"'` → exit 0이면 terminal-app / 아니면 none. ⚠️ **`is running`류는 exit 0이라도 stdout `false`일 수 있으므로 exit code만 보면 false-positive(R8-Y)** → `id of application`(미설치 시 에러)을 쓰거나 stdout `true`를 명시 파싱.
     (darwin terminal host 신호 없음/미인식 TERM_PROGRAM → none)   # terminal-app "항상" 아님(R2-G)
     # ⚠️ macOS는 surface-id env가 없어 TERM_PROGRAM이 best-available host 신호(R5 medium). TERM_PROGRAM은 iterm2 vs terminal-app **선택**에 쓰는 신호일 뿐 보안경계 아님 — spoof/오판의 진짜 bound는 §1 KK(하드 천장+headless-invocation 감지), 멀티플렉서 stale은 위 1.5로 차단, 사용자 명시 override 허용.
3. platform === 'win32' (그리고 $TMUX/$STY 없음)
     WT_SESSION 존재 → probe `where wt.exe` ok → **launcher=wt** (강한 host 신호, Windows 기본 auto)
     아니면 (WT_SESSION 없음): **사용자 명시 opt-in 있으면** `where powershell` ok → launcher=powershell, **opt-in 없으면 none**(reason='powershell-needs-optin') (R9-CC)
     # ⚠️ R9-CC: `where powershell`은 설치만 증명 — raw PowerShell엔 **host 신호가 전무**(macOS TERM_PROGRAM조차 없는 셈). --attended는 execution-plane이 주는 assertion이라, host 신호 0 + --attended만으로 auto visible은 fail-closed 위반. 따라서 powershell auto-visible은 **control-plane이 검증하는 명시 user override**(`autonomy.allow_powershell_visible=true` 또는 `session_spawn.launcher` 사용자 고정)일 때만. 없으면 none → needs-human(단 launch-command.txt에는 powershell display 유지 → 사람이 수동 실행 가능, "powershell 지원"은 충족). wt가 Windows 기본.
4. 그 외(linux/미매치/positive 신호 없음) → launcher='none'
```
`none` → 호출자 fail-close(§1): unattended 마커/`spawn_style==='headless'`면 headless measured, 아니면 paused needs-human.

**launcher 신뢰 tier(R5/R6/R9 종합; 안전 bound는 §1 KK가 SSOT):** (a) **강한 host 신호** = cmux(CMUX_SOCKET+surface+bundled-bin), wt(WT_SESSION) — env가 "이 세션이 그 터미널에 있음"을 확증. (b) **best-effort host** = iterm2/terminal-app — TERM_PROGRAM은 그 터미널이 **설정한** 신호(약하나 실재, launcher 선택용). (c) **opt-in only** = powershell — `where`는 host 신호가 아예 아님(설치만 증명) → auto-visible은 **control-plane 검증 명시 override**일 때만(R9-CC). **이 tier는 어느 launcher를 고를지에만 영향** — visible vs paused/headless의 안전 판정은 §1 precedence(KK: 하드 천장+headless-invocation 감지가 진짜 강제; `--attended`는 best-effort 선언)가 단일 출처. 멀티플렉서 stale은 1.5로 차단.

**descriptor 형태 (= `session_spawn` 영속):**
```jsonc
{
  "platform": "darwin",
  "launcher": "cmux",            // cmux|iterm2|terminal-app|wt|powershell|none
  "launcher_bin": "/Applications/cmux.app/Contents/Resources/bin/cmux",  // cmux=CMUX_BUNDLED_CLI_PATH (R2-F); 그 외 launcher 바이너리/null
  "surface": "workspace",        // cmux=workspace, darwin=window, wt=tab, powershell=window
  "reachable": true,             // 비침습 probe 통과 = verified
  "visible": true,               // launcher!==none
  "signals": { "term_program":"ghostty", "cmux_socket": true, "wt_session": false, "tmux": false, "sty": false },
  "probe": { "cmd": "<cmux_bin> ping", "code": 0 },
  "reason": null,                // launcher=none 일 때 사유(예: 'cmux-socket-denied' | 'no-host-signal')
  "fallback": "launch-command-file",
  "detected_at": "<iso, 주입 now>"
}
```
**verified 정책:** `reachable===true`(비침습 probe 통과) ⇒ verified. throwaway 창 침습 probe 안 함. **강신호 probe 실패 → 강등 금지, `none`+reason(fail-closed, R2-F).** positive host 신호 없음 → `none`+reason='no-host-signal'.

---

## 4. `session_spawn` 영속 + 스키마

- **schema:** `autonomy.spawn_style` enum에 `'visible'`. 신규 `autonomy.child_ready_timeout_sec`(int, 기본 ~75; visible child-readiness handshake 상한). 신규 `autonomy.allow_powershell_visible`(bool, 기본 false; R9-CC opt-in). 신규 `session_spawn` 객체(전부 optional/additive → 레거시 런 검증 통과): `platform·launcher(enum)·surface·reachable·visible·signals·probe·fallback·detected_at`. **status enum은 불변**(`running/paused/completed/stopped`) — `needs-human`은 status가 아니라 paused의 "이유"로만 기록(Codex R1-D).
- **initrun:** `autonomy.spawn_style:'visible'` + `autonomy.unattended_detect`에서 `'non-tty'` 제거(`['driver:cron|loop','--unattended']`만, §0 결정 6) + `child_ready_timeout_sec` 기본값. `session_spawn`은 init 세션 env로 1차 `detectTerminal` 결과 영속(이후 spawn 세션이 재감지로 갱신).
- **classifyPatch:** 변경 없음 — `session_spawn`은 전용 `detect-terminal`, `status`/`pause_reason`은 전용 fenced `pause`(pauseRun)가 쓰므로 generic `state patch` 화이트리스트 대상 아님(default-deny 유지, R3-J). `pause_reason`은 pauseRun이 이미 쓰는 필드(state.mjs) — 스키마 additive 허용.
- **cmux 명령 검증(R3-M):** `cmux ping`(연결 probe), `cmux new-workspace --cwd <p> --command <text> --focus <bool>`는 **로컬 cmux CLI(cmux.app 번들)로 실측 확인**. plan에 cmux CLI contract preflight/contract-test 포함(버전 드리프트 대비).

---

## 5. `buildLaunchCommand` 확장 (launcher별 entry)

**핵심: argv 형태로 셸 파싱 제거.** 각 entry = `{ bin, argv[], display, cwd? }`(R4-N). `visibleSpawn`/`headlessSpawn` 모두 `spawnSync(bin, argv, {cwd})`(셸 경유 ❌). 가변값 `root`는 자체 argv 토큰(또는 headless의 `cwd` 옵션)이라 공백/특수문자 안전. `display`는 사람용 `launch-command.txt` 전용.

공통: `inner명 = deep-loop-<childRunId>`, `resumePrompt = "Read .deep-loop/runs/<parent>/<handoffRel> first; then run /deep-loop-resume"`. `childRunId`(ULID)·`handoffRel`(통제 경로) 안전 검증(§12).

| launcher | bin | argv | 표면 |
|---|---|---|---|
| **cmux** | `session_spawn.launcher_bin` (=**절대경로 `CMUX_BUNDLED_CLI_PATH`만**; 없으면 launcher=none, bare `cmux` 폴백 ❌ R4-O) | `['new-workspace','--cwd',ROOT,'--command', `claude -n <q(inner)> <q(resumePrompt)>`, '--focus','true']` | workspace |
| **iterm2** | `osascript` | `['-e',`tell application "iTerm" to create window with default profile command "<escApple(inner셸)>"` ]` | window |
| **terminal-app** | `osascript` | `['-e',`tell application "Terminal" to do script "<escApple(inner셸)>"` ]` | window |
| **wt** | `wt.exe` | `['-d',ROOT,'claude','-n','deep-loop-<child>','<resumePrompt>']` | tab |
| **powershell** | `powershell` | `['-Command',`Start-Process powershell -ArgumentList '-NoExit','-EncodedCommand','<B64>'`]` (B64 = base64(UTF-16LE) of inner PS, **모든 동적 값 PS-escape 적용**: `Set-Location -LiteralPath '<psq(root)>'; & claude -n '<psq(inner)>' '<psq(resumePrompt)>'`) | window |
| **headless**(기존) | `claude` | `['-p','<resumePrompt>','--output-format','json','--permission-mode','acceptEdits']`, **`cwd: root`** | — |
| interactive/none | — | (없음, `display`만) | — |

> **entry 형태(R4-N):** `{ bin, argv[], display, cwd? }`. headless = `{bin:'claude', argv:[...], cwd:root}` — **bash/`-c` 일절 없음**(셸 재파싱 0). 모든 spawnFn은 `spawnSync(bin, argv, {timeout, cwd})`. (headlessSpawn은 claude -p 의 JSON stdout에서 usage 파싱 — 동작 불변.)

- inner셸(osascript용) = `cd <q(root)> && claude -n <inner> "<resumePrompt>"` — **root는 반드시 `q()` 통과**(R3-I: osascript가 만든 셸 안에서 root는 별도 argv 토큰이 아니므로 `q()` 없이는 `'` 가 따옴표를 깸).
- **cmux `--command`(R4-Q + R5-R):** `--command` 값은 새 cmux 셸에 타이핑되는 **셸 명령 문자열**이다 → ⚠️ **전체를 `q()`로 감싸면 안 됨**(전체가 한 단어로 실행돼 claude 미기동, R5-R). 형태는 `claude -n <q(inner)> <q(resumePrompt)>` — **명령 골격은 셸 텍스트로 두고 동적 *인자만* `q()`**. root는 별도 `--cwd` 토큰(안전). resumePrompt의 동적 `<parentRunId>`(ULID)·`<handoffRel>`(tsName 통제 경로)도 `q()` + §12 charset 검증. cmux 전용 contract/escape 테스트(claude argv 정확 + quotes/backtick/semicolon/newline/space root). **셸 문자열에 들어가는 모든 동적 POSIX 값은 `q()`/검증 의무.**
- **이스케이프 헬퍼:** `q(path)`=POSIX 단일따옴표 wrap(`'`→`'\''`); `escApple(s)`=`\`→`\\` 후 `"`→`\"`(기존 handoff.mjs 패턴 일반화); **`psq(s)`=PowerShell 단일따옴표 escape(`'`→`''`)** (R2-E).
- **PowerShell injection 차단(Codex R1-C + R2-E):** **두 층 방어** — (1) inner PS 스크립트의 **모든 동적 값에 PowerShell 단일따옴표 escape `psq()`(`'`→`''`)** 적용 후 `'...'` 단일따옴표로 감쌈(PS 단일따옴표 안에서는 `'`만 특수 → doubling으로 완전 무해화; `;`·백틱·`$`·개행 모두 리터럴). claude는 `& claude '<...>' ...` 명시 호출. (2) 그 스크립트를 **`-EncodedCommand`(base64 UTF-16LE)** 로 전달 → outer argv 파서 우회. ⚠️ **-EncodedCommand만으로는 불충분**(decode 후 PS가 다시 파싱하므로 `psq()`가 필수, R2-E). 산출물 단위테스트: apostrophe/semicolon/newline/backtick/공백 포함 root를 **decode-and-assert**로 injection 0 검증. wt 우선, powershell은 wt 부재 시 폴백. (Windows 실행은 이 머신 실측 불가 → 인코딩·escape 정확성만 단위검증, 런타임은 후속 Windows 검증.)

**반환:** `{ cmux:{bin,argv,display}, iterm2:{…}, 'terminal-app':{…}, wt:{…}, powershell:{…}, headless:{bin:'claude',argv,cwd:root,display}, interactive:{display} }`. **어느 entry에도 `bin:'bash'`/`-c` 없음**(R4-N). `launch-command.txt`엔 모든 `display` 기록(사람 폴백·감사).

---

## 6. `visibleSpawn` + `defaultRun` 일반화 (spawn-driver.mjs)

```js
visibleSpawn(entry, { launcher, timeoutMs = 30_000, run = defaultRun }) → {ok:true} | {ok:false, reason}
```
- `run(entry.bin, entry.argv, {timeoutMs, cwd: entry.cwd})` → `spawnSync(bin, argv, {cwd})`(셸 ❌). 런처는 창을 연 뒤 즉시 반환 → 짧은 timeout, 자연 fire-and-forget.
- exit 0 → `{ok:true}` = **"launch issued"일 뿐 자식 세션 생성 증명이 아니다**(Codex R1-B). 런처 exit 0는 창/명령 dispatch 성공만 의미하고 inner `claude`는 PATH/셸 startup/따옴표/바이너리 오류로 그 뒤 실패할 수 있다. 따라서 **최종 성공은 respawn의 bounded child-readiness handshake(§8)가 자식 lease acquire를 확인한 뒤** 결정된다. (**usage 측정 안 함** — visible=best-effort). timeout → `{ok:false,reason:'launch-timeout'}`; exit≠0 → `{ok:false,reason:'launch-exit-<n>'}`; throw → `{ok:false,reason}`.
- spawnFn 계약(respawn): `{ok:false}`/throw → 실패모드 B 롤백.
- **`defaultRun` 일반화:** `(bin, argv, {timeoutMs, cwd})` → `spawnSync(bin, argv, {timeout, cwd})`. `headlessSpawn`도 `entry{bin:'claude', argv:[...], cwd:root}`(bash 없음, R4-N)를 받아 동일 `defaultRun` 사용 — claude -p JSON stdout에서 usage parse+fail-closed 그대로 유지(회귀 보장).

---

## 7. respawn 배선 + CLI

**lib/respawn.respawn() 변경(명령 선택 + spawnFn 동작만; 게이트/CAS/handshake/실패모드 무변경):**
```js
// R3-L: spawn_style==='visible' 게이트 — 레거시 'interactive'/'headless' 런은 launcher 가 있어도 visible 로 새지 않음.
// R3-K: attended 는 명시 assertion(opts.attended, continue/handoff 스킬이 전달) 이어야 — positive launcher 단독 불충분.
const mode = (headless || loop.autonomy?.spawn_style === 'headless') ? 'headless'   // R4-P: 명시 headless opt-in 보존
           : (loop.autonomy?.spawn_style === 'visible' && opts.attended === true
              && loop.session_spawn?.launcher && loop.session_spawn.launcher !== 'none'
                ? loop.session_spawn.launcher : 'interactive');
const entry = cmds[mode] ?? cmds.interactive;
// ... 기존 advanceHandoffPhase emitted→spawned CAS ...
const res = spawnFn(entry);   // visible=visibleSpawn, headless=headlessSpawn
```
- 방어 가드: visibleSpawn인데 entry에 argv 없음(launcher none/interactive) → `{ok:false, outcome:'no-launcher'}`. 정상 흐름에선 스킬이 launcher=none(또는 attended 미assert)이면 respawn-spawn을 호출하지 않고 **releasing-safe `pause`**(아래, R6-T)로 간다.
- **visible 경로 child-readiness(§8):** CAS emitted→spawned 후 visibleSpawn ok면, respawn은 `child_ready_timeout_sec` 동안 lease를 poll해 자식 acquire(generation+1)를 확인한 뒤에야 성공 확정. 미확인 → 실패모드 B 롤백. (headless 경로는 기존대로 spawnFn이 동기 측정하므로 별도 poll 불필요.)

**deep-loop.mjs(CLI):**
- **신규 `detect-terminal --owner <id> --generation <n> [run-id]`:** in-lock fence + `reconcileBudget` → `detectTerminal({env,platform,run,now, allowPowershellVisible: loop.autonomy.allow_powershell_visible})` (R11-JJ: opt-in을 명시 인자로 주입 — 순수 detector가 hidden state 안 읽음) → `appendAnchored`(이벤트 `terminal-detected` + `session_spawn=descriptor`, 단일 트랜잭션). **releasing-safe(R11-HH):** PreCompact 후 lease가 releasing일 수 있으므로 detect-terminal write는 `session_spawn`만 갱신하는 **narrow releasing-safe 전이**(lease/business state 불변 → `lease-releasing-carveout`에 걸리지 않음). 출력=descriptor JSON. 종료코드 3=fence / 2=usage / 1=invalid.
- **신규 `pause --owner <id> --generation <n> --reason <r> [--mode preserve|rollback]` (R3-J + R6-T + R7-W):** **releasing-safe 특권 전이**(owner/generation fence; releasing 중 거부되는 일반 business write가 아니라 §9.1 self-lease 예외처럼 인식되는 전용 전이 — 일반 pause면 handoff emit→releasing 후 `lease-releasing-carveout`로 stranded, R6-T). 단일 anchored 트랜잭션에서 `status='paused'` + `pause_reason=<r>` 설정. **2모드(R7-W — 혼동 금지):**
  - **`preserve`(기본, no-launcher/attended-미assert needs-human):** lease를 **releasing + 예약 child 그대로 유지**(롤백 ❌) + **`expires_at=null`로 stale TTL 무력화(R8-X)** + **`resume_policy='human'` 영속(R11-GG)** — `driveHeadless`가 이 핸드오프를 headless로 집어가지 않게(아래). 이유: handoff emit가 expires_at(stale TTL 900s)을 설정해 두는데, `acquireLease`(lease.mjs:40)는 `releasing && expired`면 **누구나 탈취** 허용(크래시 복구용) → preserve를 그대로 두면 TTL 후 무관 resume/driver가 탈취해 **수동 게이트 우회**(R8-X). `expires_at=null`이면 `expired=false`(lease.mjs:39) → `takeable`이 `releasing && owner===handoff_child_run_id`(예약 child=사람의 launch-command)만 남아 **무기한 human-gated**, 오직 사람이 reserved-child로 재개. (status=paused는 실패모드 A처럼 releasing 중에도 privileged writeState로 설정, lease 나머지 불변.)
  - **`rollback`(failed 자동 spawn / child-readiness timeout):** 자식이 resume하면 안 되므로(자동 spawn 실패) lease를 **부모로 롤백**(releasing→active/idle, 실패모드 B). 이 경우엔 예약 child handoff를 무효화하는 게 올바름.
  ⚠️ R6-T의 "pause가 롤백"은 **rollback 모드에만** 해당 — no-launcher 수동 폴백에 롤백하면 사용자가 받은 launch-command가 acquire 못 함(R7-W). 종료코드 3=fence.
- **신규 `recover --owner <id> --generation <n> --confirm` (R9-BB + R10-EE + R12-MM):** preserve-paused/gate-blocked 런의 **사람-승인 escape hatch**. preserve는 `expires_at=null`+예약 child 유지라 자동 takeover가 막혀(R8-X) — launch-command 분실/예약 child 기동불가/게이트 차단이면 사람만 회수. `--confirm`(breaker reset 패턴)으로: **예약 필드를 명시 clear**(`handoff_child_run_id=null`, `handoff_idempotency_key=null`, `expires_at` 정상화)(R12-MM — 안 하면 acquireLease가 비예약 owner를 계속 거부해 escape도 stuck) → lease를 `released`로 풀고 **`status`는 `paused`(`pause_reason='recovered:awaiting-resume'`) 유지** — 새 세션의 `/deep-loop-resume`(fresh acquire)가 인수하며 unpause(→running)한다(plan review R1 정정: stopped로 종료하지 않음 — stopped+acquireable 모순 방지). gate-blocked면 `--confirm`이 게이트 override 인지(어떤 게이트인지 기록). **자동화 호출 금지** — 이는 deep-loop 기존 **`breaker reset --confirm`(핸드오프 §5/§8 불변식 8: human + lease-fenced)과 동일한 human-approval 관례**다(새 패턴 아님). `--confirm`을 서브프로세스가 cryptographic하게 증명할 수 없는 한계는 breaker reset과 공유(R14 finding) → **v2 강화**: execution-plane proposal-only 또는 out-of-band 사람 승인 primitive(현 v1은 기존 관례 준수). 종료코드 3=fence.
- **`respawn` 핸들러 변경:** **`--owner <id> --generation <n>` 요구(R11-II)** — non-dry-run에서 실제 mutating(visibleSpawn/phase 전이)이므로 다른 mutating CLI와 동일하게 in-lock lease fence 필수(stale caller가 visible launch 구동 차단; respawn() 내부 CAS/handshake가 같은 owner/generation으로 fence). `--attended` + `spawn_style==='visible'` + `session_spawn.launcher≠none` → **`spawnFn=visibleSpawn` 주입해 `respawn()` 실행**. unattended headless는 기존 드라이버 경로. 그 외는 spawn 안 함 → 스킬이 **releasing-safe `pause`** 호출. 종료코드 3=fence.
- **`driveHeadless` 변경(R11-GG):** pending 핸드오프 스캔 시 **`resume_policy==='human'`(no-launcher preserve/needs-human) 핸드오프는 skip** — headless로 집어가지 않음. headless 자동 resume은 spawn_style=headless / driver-emitted(headless 의도) 핸드오프만. (gate-blocked는 rollback이라 애초에 resumable 예약 child가 없음 — 결정 43.) preserve가 visible/needs-human 계약을 driver로부터도 봉인.

---

## 8. lease / budget 정합 (Plan 3 교훈)

- 가시 세션 = 별도 표면 독립 프로세스. CAS emitted→spawned(이중 spawn 차단, 외부 spawn **이전**) → visibleSpawn(런처 즉시 반환) → **bounded child-readiness handshake**(아래) → 자식이 `/deep-loop-resume`에서 releasing lease를 handshake acquire(generation+1).
- **bounded child-readiness handshake (Codex R1-B 반영):** visibleSpawn ok 후, respawn은 lease를 **짧은 deadline(예: ~60–90s, `child_ready_timeout_sec`) 동안 poll**해 자식이 lease를 인수했는지 확인한다.
  - **readiness 조건(R10-DD, 정확한 lease 스키마):** `lease.state === 'active' && lease.handoff_phase === 'acquired' && lease.owner_run_id === reservedChild && lease.generation === startGeneration + 1`. ⚠️ `state`는 `active|releasing|released`만이고 `acquired`는 **`handoff_phase` 값**이다 — `state==='acquired'`로 쓰면 poll이 영영 안 맞아 false timeout(R10-DD). acquireLease 후 = state:active + handoff_phase:acquired + generation+1.
  - 확인됨 → 성공(자식이 인수 완료). 부모는 종료.
  - **빠른 자식 레이스(R6-U):** 자식이 부모의 post-launch 기록(respawn-spawned append)보다 **먼저** lease를 acquire할 수 있다. 이때 generation이 이미 +1 / owner=예약 child면 — 현행 `respawn()`이 spawned-append 시 generation 변화를 `RESPAWN_FENCED`로 처리하던 것을 **성공(`already-acquired-by-child`)으로 재해석**한다. generation 변화가 **예약 child가 아닐 때만** 진짜 fence. (자식 acquire = 정상 성공 경로이지 실패가 아님.)
  - **deadline 초과(timeout) → PRESERVE, 롤백 ❌ (plan review R6 정정):** visible 자식은 timeout이 실패 증명이 아니다(cold start/auth/workspace-trust/사용자 프롬프트 대기 가능). 롤백해 예약을 무효화하면 **늦은 `/deep-loop-resume`가 고아화**된다. 따라서 timeout은 예약 child 유지 + `resume_policy='human'` + `expires_at=null` + `status='paused'('child-timeout-awaiting')` → **늦은 자식 acquire가 여전히 성공**(driveHeadless는 skip; 사람 recover로 폐기 가능). **반면 launch FAILURE(visibleSpawn `{ok:false}`, launcher exit≠0 — 자식이 시작도 못 함)와 gate-blocked는 rollback**(자식 무효화 + `pause_reason='launch-failed'|'gate:<which>'`).
  - **deadlock 없음:** lease는 이미 `releasing`이므로 부모의 wait-for-**acquire**는 자식의 acquire를 막지 않는다(자식이 releasing lease를 잡는 걸 기다릴 뿐). 이는 Plan 3 r1·2가 막은 wait-for-**finish**(부모가 lease 쥔 채 자식 완료 대기 → 데드락)와 **구분**된다. wait 상한이 있어 무한 블록도 아님.
  - attended이므로 사람이 새 창의 claude 기동 오류를 즉시 관측 가능(visible=best-effort 안전망의 일부).
- 예산: visible 측정 없음 → 사람 감시 + `per_session_turn_cap` 선제 핸드오프가 바운드. respawn 천장(max_sessions + wallclock)은 커널이 하드 강제 유지. **fail-closed 측정은 headless 전용**(spec §9 예산 강제 분해 일치).

---

## 9. 에러 / 폴백 (단일 출처, 조용한 강등 ❌)

| 상황 | 처리 |
|---|---|
| launcher=none / probe 실패 / attended 미assert | 스킬이 respawn-spawn 호출 안 함 → handoff emit + **`pause --mode preserve`**(`status='paused'`, `pause_reason='needs-human:<사유>'`; **releasing+예약 child 유지** → launch-command.txt의 `/deep-loop-resume`로 수동 재개 가능, R7-W) + launch-command.txt 제시. handoff emit만으로 끝내지 않음(stranded 방지, R6-T) |
| visible launch는 됐으나 자식이 deadline 내 lease acquire 실패 | child-readiness 타임아웃 → **`pause --mode rollback`**(`failed_launch`+lease 부모 복귀; 실패한 자식은 resume ❌, R7-W). 사람이 새 창 오류 관측 가능 |
| visible 게이트 차단(budget/breaker/max_sessions/wallclock) | **실패모드 A = `pause --mode rollback`(R12-LL, R10-EE 정정)**: spawn 안 함 + lease 부모로 롤백(예약 child **무효화**) + `status='paused'`, `pause_reason='gate:<which>'`. **예약 child를 남기지 않음**(launch-command 게이트 우회 ❌, R12-LL). **+ 부모 fence 무효화(R13-OO):** rollback이 부모로 lease를 돌려주면 부모의 owner/generation fence가 여전히 유효해 게이트 무시하고 계속 mutate 가능 → 이를 막기 위해 **paused 런은 mutation 거부**(mutation 게이트가 `status==='paused'`면 거부; recover/resume-handshake만 허용) 또는 generation bump로 부모 fence 무효화. 재개는 **`recover --confirm`(사람·게이트 인지)** 만. |
| visibleSpawn launch 실패(exit≠0/timeout; 예: 감지~spawn 사이 cmux 소켓 소실) | 실패모드 B: 자식 `outcome=failed_launch` + lease 부모 롤백 + respawn-failed → **이어서 `pause`로 needs-human 전이(R12-NN)**. run을 active로 두면 다음 tick이 같은 launcher 재감지→반복 실패하므로, rollback 후 **fail-closed paused**(사람이 환경 확인). 동일 launcher 반복 실패 차단 |
| unattended 감지 | `unattended_requires_headless` → headless 강제 fail-closed |

새 경로는 Plan 3의 실패모드 단일 출처 / lease handshake를 그대로 재사용(우회 금지).

---

## 10. 스킬 변경 (읽기/CLI만 — 2-plane)

- **`deep-loop-continue`(Decide)·`deep-loop-handoff`:** respawn 전 `detect-terminal` 호출(session_spawn 갱신) → launcher 읽기 → 분기: **visible**(spawn_style=visible + launcher≠none → `handoff` → **현재 lease를 읽어 `respawn --owner <o> --generation <g> --attended`**, R11-II 필수 fence; attended는 best-effort 선언이지 보안경계 아님, R12-KK) / **unattended**(명시 마커 → headless 드라이버) / **none·attended미assert·spawn_style≠visible**(handoff → **`deep-loop pause --mode preserve --reason needs-human:<…>`** — releasing+예약 child 유지로 수동 resume 가능, R7-W). 모두 CLI 경유, 상태 직접 쓰기 ❌. driver(drive-headless)는 `--attended` 안 줌 → 절대 visible 안 됨.
- **기존 emitted 핸드오프 재사용(R10-FF):** PreCompact는 v1에서 emit-only라 lease가 이미 `handoff_phase='emitted'`(트리거='pre-compact', 예약 child 존재)일 수 있다. continue/handoff는 emit *전에* 현재 lease를 읽어 — **이미 emitted면 새로 emit하지 않고**(다른 트리거로 emit하면 `handoff-in-flight`로 표류) **그 기존 reserved child를 respawn(visible)/pause(preserve)** 한다. `emitHandoff`는 멱등(이미 emit 시 `already-emitted`+childRunId 반환)이므로 그 childRunId로 이어간다. → PreCompact 후 다음 tick이 가시 spawn을 완성(post-compaction 표류 방지).
- **`deep-loop-resume`(R14-RR):** releasing lease handshake acquire는 기존 로직. **단 preserve-paused(`status='paused'`, `resume_policy='human'`)를 reserved child가 인수할 땐 — acquire와 같은 단일 트랜잭션에서 `status='running'` + `pause_reason`/`resume_policy` clear**. 안 하면 R13-OO(paused는 mutation 거부)와 충돌해 인수한 자식이 모든 business mutation에서 막혀 폴백이 무용지물. (acquire→running→clear가 한 anchored 트랜잭션; generation+1.) gate-blocked rollback은 reserved child가 없으니 이 경로 아님(recover 전용).
- **PreCompact hook (`precompact-handoff.mjs`, R2-H 반영):** emit-only는 유지(가시 spawn은 다음 continue/resume이 수행 — compaction 중 창 spawn 리스크 회피). **단 headless 플래그 계산에서 `|| input.tty === false`를 제거** — `headless = input.unattended === true || spawn_style === 'headless'`(명시 마커만), 새 "non-tty≠unattended" 규칙과 일치. visible attended 세션이 compaction 시 headless로 새지 않게 함. + tty-false 회귀테스트.
- `references/handoff-respawn.md` + `skills.test.mjs` 불변식 문구 갱신.

---

## 11. 테스트 전략 (실제 터미널 안 띄움 — 전부 주입 runner)

| 대상 | 테스트 |
|---|---|
| `detect-terminal.mjs` | 고정 env/platform + stub `run` → 각 분기(cmux reachable; **CMUX_* 강신호+probe 실패→`none`+reason fail-closed, 강등 ❌**(R2-F); **CMUX_* 있고 ping OK인데 caller surface(WORKSPACE_ID/SURFACE_ID) 없음→none+reason='cmux-no-surface'**(R3-M); cmux bin=`CMUX_BUNDLED_CLI_PATH`; darwin TERM_PROGRAM=iTerm.app→iterm2 / Apple_Terminal→terminal-app / **그 외 darwin→none**(R2-G); win WT_SESSION→wt; **positive 신호 없음→none**) |
| **unattended/attended 판정** | `non-tty`만으로는 unattended 아님(R1-A); `driver:cron|loop`/`--unattended`/headless-invocation 감지면 headless(KK); `--attended` 미선언이면 positive launcher 있어도 paused(R3-K); **markerless가 `--attended`를 mint해도 hard 천장(max_sessions/wallclock)으로 bound**(KK — attended는 보안경계 아님; headless-invocation 감지로 claude -p는 positive하게 headless) |
| `buildLaunchCommand` | launcher별 정확한 `{bin,argv,cwd?}` assert — root 공백, childId(ULID); **headless = `{bin:'claude',argv,cwd:root}` — 어떤 entry에도 `bin:'bash'`/`-c` 없음**(R4-N 회귀가드); **osascript inner `q(root)` — apostrophe/newline/semicolon/space root에서 injection 0**(R3-I); **cmux --command 동적값 escape — quotes/backtick/semicolon/newline root에서 injection 0**(R4-Q); **powershell `psq()`+-EncodedCommand decode-and-assert**(R2-E) |
| `visibleSpawn` | stub `run` → exit0=ok(=launch issued) / exit≠0·timeout·throw=fail |
| **respawn child-readiness** | readiness 조건 = **`state==='active' && handoff_phase==='acquired' && owner===reservedChild && generation===시작+1`**(R10-DD — `state==='acquired'`는 잘못, 실제 스키마로 검증); deadline 내 충족=성공 / 초과=실패모드 B rollback→paused(R1-B); deadlock 없음(releasing lease); **빠른 자식이 respawn-spawned append 전에 acquire → fenced 아니라 성공**(R6-U); 예약child 아닌 gen 변화만 진짜 fence |
| **respawn mode 게이트** | spawn_style≠'visible'면 launcher 있어도 visible 안 됨(R3-L); `--attended` 없으면 visible 안 됨(R3-K); **`spawn_style==='headless'`(마커 없어도)→headless 보존**(R4-P 회귀가드) |
| **cmux fail-closed bin** | `CMUX_BUNDLED_CLI_PATH` 없으면(소켓만 상속) launcher=none, bare 'cmux' 폴백 ❌(R4-O) |
| **cmux --command argv** | `--command`를 shell-parse했을 때 `claude`가 기대 argv로 실행됨(전체 q() ❌, R5-R contract test) |
| **macOS 멀티플렉서 fail-closed** | darwin에서 `$TMUX`/`$STY` 있으면 TERM_PROGRAM=iTerm.app여도 launcher=none(R5-S, stale 오라우팅 차단) |
| **CLI `pause`(releasing-safe, 2모드)** | **handoff emit(→releasing) 후에도** 거부 없이 `status='paused'`+`pause_reason` 도달(일반 business write면 `lease-releasing-carveout`로 stranded되는 negative test, R6-T); **`preserve`=lease releasing+예약 child 유지 / `rollback`=부모 복귀**(R7-W); fence(exit3) |
| **no-launcher→수동 resume 왕복** | no-launcher 폴백(`pause --mode preserve`) 후 생성된 launch-command의 `/deep-loop-resume`가 releasing lease를 handshake acquire 성공(R7-W 회귀가드 — 롤백이면 실패) |
| **preserve human-gate(stale TTL)** | `pause --mode preserve`(expires_at=null) 후 — **stale TTL 경과해도 비예약 owner는 acquire 불가**(lease-not-takeable), 예약 child만 acquire 성공(R8-X 회귀가드) |
| **recover escape(R9-BB)** | preserve-paused에서 launch-command 분실 가정 → 자동/비-confirm 회수는 거부, **`recover --confirm`(사람)만** 예약 필드 clear + lease `released` + `status='paused'('recovered:awaiting-resume')` → fresh acquire가 unpause(plan review R1: stopped 아님). 자동화는 불가 |
| **gate-blocked rollback(R12-LL)** | budget/breaker/max_sessions/wallclock 차단 → rollback(예약 child 무효화)+paused(`gate:<which>`); **launch-command로 재개 시도해도 acquire 불가**(게이트 우회 ❌), `recover --confirm`(사람)만 재개 |
| **headless-invocation 감지(R12-KK)** | `claude -p`/비대화형 진입을 unattended로 감지(positive)→headless measured; markerless 자동화가 skill 경로 들어와도 hard 천장(max_sessions/wallclock)으로 bound (attended는 보안경계 아님) |
| **recover 필드 clear(R12-MM)** | `recover --confirm` 후 handoff_child_run_id/key/expires_at 정상화 → 새 세션 acquire 가능(clear 안 하면 stuck 재현 negative test) |
| **반복 launch 실패→pause(R12-NN)** | launch 시점 실패 후 run이 active 아님(paused) → 다음 tick이 같은 launcher 재시도 안 함 |
| **paused는 mutation 거부(R13-OO)** | `status='paused'` 런에 mutating CLI 호출 → 거부(부모가 게이트 무시하고 계속 mutate 못 함); recover/resume-handshake만 허용 |
| **preserve→resume unpause(R14-RR)** | no-launcher preserve(paused) → reserved child `/deep-loop-resume` acquire가 같은 트랜잭션에서 status=running+pause_reason/resume_policy clear → 인수 후 business mutation 성공(unpause 누락 시 OO와 충돌해 막히는 negative test) |
| **precompact 핸드오프 재사용(R10-FF)** | lease가 이미 emitted(트리거 pre-compact)일 때 continue가 새 emit 안 하고 기존 reserved child로 respawn/pause(handoff-in-flight 표류 ❌); **detect-terminal이 releasing 중에도 fenced 안 됨**(R11-HH) |
| **preserve는 headless driver 불가시(R11-GG)** | no-launcher preserve(`resume_policy='human'`) 후 `driveHeadless` 실행 → **spawn/acquire 안 함**(skip). spawn_style=headless 핸드오프만 driver가 resume. (gate-blocked는 rollback이라 별도 — 위 행) |
| **respawn CLI lease fence(R11-II)** | `respawn` 핸들러는 `--owner/--generation` 없으면 거부(exit3); stale owner/generation도 fence — visible launch 무단 구동 차단 |
| **detectTerminal opt-in 인자(R11-JJ)** | allowPowershellVisible 인자로 주입 시에만 win32 powershell 선택; 미주입(기본 false)이면 none |
| **win/mac tier** | win32 WT_SESSION 없으면 powershell은 **opt-in(`allow_powershell_visible`) 있을 때만 선택, 없으면 none**(R9-CC; --attended만으론 부족); markerless(`--attended` 없음)→paused(R6-V); darwin terminal-app probe는 stdout/에러로 판정(`is running` exit0=false-positive 금지, R8-Y) |
| `defaultRun` 일반화 | headlessSpawn usage parse+fail-closed 회귀 green |
| CLI `detect-terminal` | fence(exit3), 이벤트+상태 단일 txn, 재감지 멱등 |
| `respawn` visible | fake spawnFn으로 entry 선택·lease releasing 유지·실패모드 B 롤백 |
| **precompact-handoff** | `input.tty===false`만으로는 headless 아님(visible 세션 보존); 명시 마커(`input.unattended`/`spawn_style='headless'`)일 때만 headless(R2-H 회귀가드) |
| schema/skills | `session_spawn`+enum validate, **status enum 불변(needs-human 미추가)**, SKILL 직접쓰기 0 |

determinism: now/env/run 전부 주입. 의존성 0, Node≥20, Bash 3.2 hook 유지. 기준선 327 tests green 유지 + 신규 테스트 추가.

---

## 12. 보존 불변식 (핸드오프 §5 매핑)

1. **2-plane + §1.1:** 스킬은 상태 읽기만, 변경은 CLI(`detect-terminal`/`handoff`/`respawn`/`pause`/`recover`)로만. 커널은 sibling 스킬 함수호출 안 함. ✔
2. **lease fence(in-lock):** `detect-terminal`(releasing-safe)·`pause`(preserve/rollback)·`recover`(--confirm)·`respawn`(--owner/--generation) 모두 owner/generation fenced. spawn은 respawn 경유(게이트+CAS+handshake, 우회 금지). **`status==='paused'` 런은 mutation 거부(R13-OO)** — recover/resume-handshake만 허용(gated 부모가 게이트 무시 계속 못 함). ✔
3. **이벤트+상태 = 단일 `appendAnchored`:** `terminal-detected`+session_spawn, respawn-spawned/failed 모두 단일 트랜잭션. ✔
4. **터미널 상태 proof 파생:** 변경 없음(finish completed는 per-maker proof 그대로). ✔
5. **비가역 외부 행동 proposal-only:** 세션 spawn은 §9 세션 연속 예외(외부세계 변경 아님). visible은 추가로 **사용자 가시성** 보장. ✔
6. **respawn 게이트 + 미감시 정책:** visible=사람 감시 자율(게이트 유지, 측정 best-effort). 진짜 무인은 headless fail-closed 유지. ✔
7. **worktree 연속성 / project root 밖 쓰기 ❌ / runId 안전:** 변경 없음. ✔
8. **환경 특화 명령은 검증된 형태만:** argv 토큰화 + `q`(POSIX)/`escApple`(osascript)/`psq`(PowerShell) 헬퍼 + headless `cwd` 옵션(bash 없음). childRunId(ULID)/handoffRel(통제 경로)/root 이스케이프·검증. ✔

---

## 13. 스코프 밖 / 후속 과제

- **launcher:** tmux·GNU screen·WezTerm·kitty·VS Code/Cursor 자동 spawn(detect 테이블 확장 지점만 마련, 동작은 needs-human 폴백).
- **`claude --bg` 폴백 티어** (리서치 공백 — 후속 조사+구현).
- **PowerShell 런타임 실검증**(Windows 머신) — v1은 `psq()`+base64 인코딩 정확성 단위테스트 고정, 런타임 best-effort.
- **PreCompact 가시 spawn**(v1 emit-only — 단 headless 플래그 tty 제거(R2-H)는 v1 포함).
- **tmux/screen no-attached-client 가시성**(리서치 openQuestion) — v1 launcher 아님이라 무관.

---

## 14. 미해결 질문 (plan/구현에서 확인)

1. `cmux new-workspace --command`가 새 workspace의 기본 셸에 텍스트+Enter를 보낸다 — claude 바이너리가 PATH에 있고 셸 시작 시 환경이 보장되는지(비대화형 vs 대화형 셸) 구현 시 확인.
2. `cmux new-workspace --focus true`가 사용자 포커스를 뺏는 UX — focus 기본값(true vs false) 최종 결정.
3. iTerm2 미설치 + TERM_PROGRAM=iTerm.app(드묾)일 때 probe 실패 → **fail-closed `none`(강등 ❌, R8-Y/R2-G)** → paused needs-human. (다른 launcher로 강등하지 않음.)
4. `child_ready_timeout_sec` 기본값(60~90s) 튜닝 — 가시 세션의 claude 콜드스타트 시간 고려해 plan/구현에서 확정.
5. **headless-invocation 감지의 정확한 신호(R12-KK)** — Claude Code가 `claude -p`/비대화형 진입을 노출하는 env(예: 진입점/print-mode 표시)를 plan에서 확인. 확인되면 unattended_detect에 추가(자동화→headless positive). 미확인이면 fail-closed(못 미더우면 headless) + hard 천장 의존. (attended를 보안경계로 못 쓰는 정직한 한계 — §1 KK note.)
6. **gate-blocked recover의 게이트 override 기록 형식**(R12-LL) — `recover --confirm`이 어떤 게이트를 override했는지 event/pause_reason에 남기는 형식 plan에서 확정.
4. CLI `respawn` 핸들러에서 visibleSpawn 주입 시 테스트 seam(직접 respawn() 단위테스트로 커버 vs CLI 통합 stub) — plan에서 확정.
