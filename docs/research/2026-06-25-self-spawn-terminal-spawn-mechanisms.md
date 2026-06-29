# Research — 환경 무관 가시 터미널 세션 self-spawn 메커니즘

작성일: 2026-06-25
대상 작업: deep-loop "Self-spawning session continuity" (핸드오프 `docs/handoff/2026-06-25-self-spawn-session-continuity-handoff.md` §6)
입력처: 이 리포트는 plan `2026-06-25-deep-loop-self-spawn-session-continuity.md`의 §4(환경별 spawn 템플릿 표) + 폴백 정책의 입력이다.

> **연구 질문:** LLM 코딩 에이전트(Claude Code / Codex CLI)가 OS·터미널 에뮬레이터·멀티플렉서에 무관하게, 사용자가 지켜보고 개입할 수 있는 **새 인터랙티브(가시) 터미널 세션**을 자기 자신(TTY 없는 샌드박스 서브프로세스)에서 프로그램적으로 여는(spawn) 신뢰성 있는 방법은 무엇인가?

방법론: (A) **로컬 실측** — 현재 사용자 머신(cmux/Ghostty/macOS)에서 직접 측정·CLI 조사. (B) **웹 deep-research** — 6각도 fan-out 웹서치 → 25개 1차 출처 fetch → 118개 주장 추출 → 25개 적대적 검증(2/3 refute = kill) → 24 confirmed / 1 killed → 12개로 합성. cmux는 (A)로 확정했으므로 (B)는 공개·이식 가능 메커니즘에 집중.

---

## 0. 한 줄 결론

**OS/터미널 무관한 단일 spawn API는 존재하지 않는다.** 신뢰성은 **(1) 실제 멀티플렉서/터미널을 식별하는 detect-then-dispatch 테이블 + (2) explicit-socket 요구(컨트롤링-터미널 폴백은 샌드박스에서 무효) + (3) fail-closed 폴백**에서 나온다. 가장 이식성·검증성이 높은 것은 멀티플렉서(tmux/screen — 단 attach된 클라이언트 필요)와 터미널별 control socket/CLI(WezTerm은 pane-id 반환, kitty는 RC 사전활성+명시 socket 필요, Windows Terminal `wt.exe`, iTerm2/Terminal.app AppleScript)다. **detached 기법(setsid/nohup/disown/Node detached)은 가시 세션을 만들지 못한다 — 헤드리스 생존 경로 전용.** VS Code/Cursor는 외부에서 통합 터미널을 여는 CLI가 없어 **hard miss → OS 터미널 폴백**.

---

## 1. 로컬 실측 그라운딩 (사용자 머신, web으로 재발견 불가)

현재 작업 환경에서 직접 측정 (Bash 도구 = 에이전트 샌드박스):

| 신호 | 측정값 | 의미 |
|---|---|---|
| `process.stdout.isTTY` / `stdin.isTTY` | **`undefined`** (둘 다) | **TTY 제약 직접 실증.** 에이전트 Bash는 non-TTY 샌드박스 → `claude -n …`을 그냥 실행하면 헤드리스 자식일 뿐. |
| `TERM_PROGRAM` | `ghostty` | **실제 환경은 cmux** — TERM_PROGRAM 비신뢰의 실증(아래 §3). |
| `TERM_PROGRAM_VERSION` | `1.3.2-HEAD-+f78189a` | (ghostty 버전) |
| `$TMUX` / `$STY` | 빈 값 | 현재 멀티플렉서는 tmux/screen 아님 |
| `CMUX_*` env | `CMUX_SOCKET_PATH=~/.local/state/cmux/cmux.sock`, `CMUX_BUNDLED_CLI_PATH`, `CMUX_BUNDLE_ID=com.cmuxterm.app`, `CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID`, `CMUX_PORT=9300`, `CMUX_AGENT_LAUNCH_*` | **cmux 감지·spawn의 신뢰 신호.** (`CMUX_SOCKET_PASSWORD`는 미설정, `CMUX_SOCKET`도 빈 값 → `CMUX_SOCKET_PATH` 사용) |
| launcher 존재 | `tmux`(/opt/homebrew/bin), `ghostty`, `osascript`, `cmux` 있음 / `wezterm`, `kitty`, `setsid` **없음** | macOS는 `setsid` 기본 미존재 확인 |
| `cmux capabilities` (rpc) | **응답 성공** | **에이전트 샌드박스에서 cmux Unix 소켓 접근 가능** — 가시 spawn 실현성 확인 |

**cmux CLI 조사 (로컬):**
- `cmux open <path>` — 파일/디렉터리/URL 열기용 (새 에이전트 세션 아님).
- **`cmux claude-teams [claude-args…]`** — Claude Code를 agent-teams 모드로 런치. tmux 호환 env + **private tmux shim**(tmux window/pane 명령 → cmux workspace/split 번역)을 PATH 앞에 추가하고 claude로 나머지 인자 forward.
- **rpc 가시 surface 생성 메서드**: `surface.create`, `surface.split`, `surface.split_off`, `terminal.create`, `surface.respawn`, `window.create`, `pane.create`. `cmux rpc <method> [json-params]`로 호출. (정확한 파라미터 스키마는 plan 단계에서 `cli-contract.md` fetch로 확정.)
- 권위 문서: `https://raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md`, cmux skill `…/skills/cmux/SKILL.md`.

> **함의:** cmux는 사용자의 실제 기본 환경이고, 소켓이 샌드박스에서 닿으므로 **가시 self-spawn이 실현 가능**하다. 단 cmux 감지는 반드시 `CMUX_*` env로 해야 하며 `TERM_PROGRAM`(=ghostty)을 믿으면 오탐.

---

## 2. 환경별 가시-세션 spawn 메커니즘 (웹 검증, 1차 출처)

각 항목은 적대적 3-vote 검증 통과(별도 표기 없으면 3-0). **이스케이프 원칙(공통):** 가능하면 명령을 **개별 argv 토큰**으로 전달해 `sh -c` 재파싱 레이어를 우회한다(아래 tmux 주의 참조).

### 2.1 tmux — 최상위 이식 타깃 (confidence: high)
- **명령:** `tmux new-window -c <dir> <cmd…>` (alias `neww`) — 새 가시 window. `tmux split-window [-h|-v] -c <dir> <cmd…>` — pane(미지정 시 `-v` 세로 분할 기본).
- **가시성 조건:** 해당 tmux **세션에 attach된 클라이언트가 있어야** 보인다. detached 세션에 만든 window는 attach 전까지 invisible (→ §6 open question).
- 실측: `tmux -S <sock> new-window -c /tmp 'echo hello'` → exit 0, list-windows에 표시 (tmux 3.6a).
- **🔴 CRITICAL 이스케이프 주의:** shell-command를 **단일 문자열**로 주면 tmux가 `/bin/sh -c '<arg>'`로 재해석한다(따옴표·glob·var 확장 적용, 중첩 따옴표 취약). 반면 `new-window`/`new-session`/`split-window`/`respawn-window`/`respawn-pane`는 shell-command를 **여러 argv 인자로 직접 실행(`sh -c` 없이)**한다. → **claude + 인자를 별도 토큰으로 전달**하는 것이 안전(man page 명시: `tmux new-window vi ~/.tmux.conf`는 vi 직접 실행). trade-off: multi-arg 형은 shell 우회라 glob/var/pipe/tilde 미확장 — self-spawn에는 오히려 바람직(리터럴 argv).
- 출처: man7.org/tmux.1, manpages.ubuntu.com/focal/tmux.1, man.openbsd.org/tmux.1.

### 2.2 GNU screen (confidence: high)
- **명령:** `screen -X -S <session> screen <cmd…>` — `-X`는 실행 중 세션에 명령 전송, 내부 `screen [opts] [n] [cmd [args]]`는 cmd 주면 새 window에서 실행(없으면 shell). 다중 세션이면 `-S`로 disambiguate.
- 가시성 조건: tmux와 동일(attach된 display 필요).
- 출처: gnu.org/software/screen/manual/Screen-Command.html.

### 2.3 WezTerm — 검증성 최고 (confidence: high)
- **명령:** `wezterm cli spawn [OPTIONS] [PROG…]` — 기본 새 탭, `--new-window`로 새 창. `--cwd <dir>`. PROG는 `--` 뒤: `wezterm cli spawn --cwd <dir> -- bash -l`.
- **✅ 성공 시 새 pane-id를 stdout 출력** → launch를 프로그램적으로 관측 가능. GUI/mux 서버 없으면 socket 에러로 fast-fail → exit code로 성공/실패 구분.
- 전제: 실행 중 GUI/mux 서버.
- 출처: wezterm.org/cli/cli/spawn.html.

### 2.4 kitty — 전제 2개 (confidence: high)
- **명령:** `kitten @ launch [--type=window|tab|os-window] [--cwd <dir>] [--title T] [--keep-focus] program [args…]` (alias `kitty @ launch`). `--type=window`=현재 탭 새 window(기본), `os-window`=완전 별도 OS 창.
- **🔴 hard 전제 2개 (샌드박스에서 결정적):**
  1. **remote control 사전 활성화** — `allow_remote_control=yes` 또는 `remote_control_password`가 kitty.conf/`-o`에 있어야 함. 기본 **OFF**. 없으면 `kitty @` 무효.
  2. **연결 타깃 명시** — `--to <ADDRESS>` 또는 `KITTY_LISTEN_ON` env 필요. 3순위 폴백(컨트롤링 터미널)은 "이 프로세스가 kitty window 안에서 실행될 때만" 동작 → **TTY 없는 샌드박스 서브프로세스는 정의상 불가**.
- 출처: sw.kovidgoyal.net/kitty/launch/, .../remote-control/, man.archlinux.org/kitten-@.1.

### 2.5 Windows Terminal (confidence: high)
- **명령:** `wt.exe [options] [command ; ]` (alias `wt`). 기본 command=`new-tab`. 작업 디렉터리 `--startingDirectory, -d <dir>`(new-tab/split-pane 공통), 실행 명령은 `commandline` 인자(실행파일+옵션 인자). 템플릿 `wt.exe -d <dir> <cmd>` 유효.
- 이스케이프: PowerShell은 `;`에 backtick/`--%`, WSL은 `cmd.exe /c "wt.exe"` 필요. `windowingBehavior` 설정에 따라 새 창 vs 탭.
- 출처: learn.microsoft.com/windows/terminal/command-line-arguments (2025-11-10 기준 current).

### 2.6 macOS iTerm2 / Terminal.app (confidence: high)
- **iTerm2 (osascript):** 새 창/탭+명령 = `create window with default profile command "<cmd>"` / `create tab with default profile command "<cmd>"`. 기존 세션 주입 = `write text "<text>"` (`newline NO`로 자동실행 억제). **AppleScript 경로는 공식 Deprecated(Python API 권장)이나 동작함 → 폴백으로 적합.**
- **Terminal.app:** 대응 동사는 `do script "<cmd>"` — iTerm2의 `write text`와 혼동 금지.
- 이스케이프: osascript 내부 따옴표 처리 주의(이미 `handoff.mjs`의 macos 변형이 `"`→`\\"`).
- 출처: iterm2.com/documentation-scripting.html.

### 2.7 Ghostty — 외부 spawn 불확실 (confidence: medium, ⚠️ 유일 refute 항목)
- Ghostty는 new_window/new_tab/new_split를 **keybinding action으로만** 노출(config 파일). 외부 프로세스에서 트리거하는 `ghostty +action`이나 socket RPC는 **명확히 확립 불가**.
- ⚠️ "키바인드 외에 CLI/RC 없다"는 주장은 **0-3으로 refute**됨 — 즉 단일 페이지로 "부재"를 깨끗이 입증할 수 없었다는 뜻(있다는 게 아니라 **불확실**). → Ghostty는 self-spawn 저신뢰로 취급, **사용자의 실제 환경은 cmux 레이어로 처리**(로컬 확정: CMUX_SOCKET_PATH + surface.create/split + `cmux claude-teams`).
- 출처: ghostty.org/docs/config/keybind/reference.

### 2.8 VS Code / Cursor — HARD MISS (confidence: high)
- `code` CLI에 임의 셸 명령 실행이나 새 통합 터미널 열기 플래그/서브커맨드 **없음**. 터미널 자동화(`workbench.action.terminal.sendSequence`/`newWithCwd`)는 VS Code 내부 command system(Command Palette/keybindings) 또는 in-editor 확장의 `terminal.sendText()`로만 — **외부 Bash 서브프로세스에서 도달 불가**. 새 통합 터미널 shell/env는 settings(`terminal.integrated.*`)로만 제어. `code -e <cmd>` 기능요청은 미구현(중복으로 close).
- → **`TERM_PROGRAM=vscode` 감지 시 in-editor spawn 금지, OS 터미널 폴백으로 라우팅.**
- 출처: code.visualstudio.com/docs/configure/command-line, /docs/terminal/advanced, /docs/supporting/troubleshoot-terminal-launch, github.com/microsoft/vscode/issues/190142.

---

## 3. 감지 신호 신뢰성 (confidence: medium, 합성)

**개별 신호는 모두 비신뢰** — 우선순위 ladder로 결합해야 한다. `TERM_PROGRAM`은 stale/spoofable로 악명(로컬 실증: cmux가 `TERM_PROGRAM=ghostty` 설정; tmux/screen 안에선 stale/빈 값). Claude Code 자체도 TERM_PROGRAM false-positive 이슈 있음(anthropics/claude-code #27868).

**권장 감지 우선순위 (멀티플렉서·라이브 소켓 우선, TERM_PROGRAM은 약한 마지막 힌트):**
1. `$TMUX` → tmux (라이브 멀티플렉서가 지배)
2. `$STY` → GNU screen
3. `CMUX_*` (+ 소켓 probe) → cmux
4. `$WT_SESSION` → Windows Terminal (win32)
5. `$KITTY_WINDOW_ID` + `$KITTY_LISTEN_ON` → kitty (둘 다 있어야 spawn 가능)
6. `$WEZTERM_PANE` + 라이브 `wezterm cli list` probe → WezTerm
7. `process.platform === 'darwin'` → iTerm2/Terminal.app (osascript) — TERM_PROGRAM은 둘 중 어느 앱인지 고르는 약한 힌트로만
8. `process.platform === 'win32'` → wt.exe
9. `TERM_PROGRAM` — 약한 마지막 힌트 (단독 신뢰 금지)
10. 그 외 → 폴백(§5)

**핵심 설계 규칙:** WezTerm/kitty는 spawn **시도 전에** 능력 probe(예: `wezterm cli list` 성공 / `KITTY_LISTEN_ON` 존재)로 **게이트 결정**을 내려 런타임 에러가 아니라 사전 판정으로 처리한다.

출처(합성): man7/tmux, kitty remote-control, wezterm spawn, MS Learn wt + 로컬 실증 전제(isTTY===undefined, TERM_PROGRAM=ghostty-but-cmux). 단일 출처가 ladder 전체를 나열하진 않음 — per-tool high-confidence 사실에서 도출한 설계 권고.

---

## 4. detached 프로세스 기법 — 헤드리스 생존 전용 (confidence: medium)

POSIX `setsid`(⚠️ macOS 기본 미존재 — 로컬 확인), `nohup`, shell `disown`, Node `child_process.spawn(cmd,args,{detached:true, stdio:'ignore'}).unref()` — 모두 부모/컨트롤링 터미널에서 **분리(detach)**한다. **바로 터미널에서 분리하기 때문에 자식은 가시 창이 없다.** launch 성공은 "프로세스 시작됨"으로만 관측 가능, "가시 세션 생성됨"으로는 절대 관측 불가.

> **결론:** 이 기법들은 **visibleSpawn에 부적합**하고, 헤드리스 드라이버의 **생존(survival) 경로**에만 쓴다. 가시성은 터미널 앱/멀티플렉서가 TTY 표면을 열어 그 안에서 claude를 실행해야만 생긴다. 출처: nodejs.org/api/child_process.html (detached+unref+stdio:ignore로 부모 독립 종료), github.com/tzvetkoff/setsid-macosx (macOS setsid 부재).

---

## 5. OS 이식성 / 검증성 / 실패모드 비교표

| 메커니즘 | 정확한 명령 | 전제 | 검증성(launch 관측) | 주요 실패모드 | OS | self-spawn 신뢰도 |
|---|---|---|---|---|---|---|
| **tmux** | `tmux new-window -c <dir> <argv…>` / `split-window` | tmux 서버 + **attach된 클라이언트**(가시성) | exit code; `list-windows` | attach 없으면 invisible; 단일문자열은 `sh -c` 재파싱 | 전부(tmux 설치 시) | **높음** |
| **GNU screen** | `screen -X -S <s> screen <argv…>` | 실행 중 세션 + attach | exit code | 다중세션 시 `-S` 필수; attach 없으면 invisible | 전부(screen 설치) | 높음 |
| **WezTerm** | `wezterm cli spawn --cwd <dir> -- <argv…>` | GUI/mux 서버 | **pane-id 출력** + exit code | 서버 없으면 socket-not-found fast-fail | 전부(wezterm) | **높음** |
| **kitty** | `kitten @ launch --type=window --cwd <dir> <argv…>` | **RC 사전활성 + KITTY_LISTEN_ON/--to** | exit code | RC off / 소켓 미지정 시 무효(샌드박스 컨트롤링-터미널 폴백 불가) | 전부(kitty) | 중간(전제 강함) |
| **Windows Terminal** | `wt.exe -d <dir> <cmd>` | wt 설치 | exit code | PowerShell `;`/WSL 이스케이프; 창 vs 탭은 설정 의존 | **win32** | 높음 |
| **iTerm2** | osascript `create window with default profile command "<cmd>"` | iTerm2 실행 | exit code(osascript) | AppleScript Deprecated(동작함); 따옴표 이스케이프 | **darwin** | 중간(폴백) |
| **Terminal.app** | osascript `do script "<cmd>"` | — | exit code | 따옴표 이스케이프 | **darwin** | 중간(폴백) |
| **cmux** (로컬) | `cmux claude-teams [args]` 또는 `cmux rpc surface.create …` | CMUX 소켓 도달(✅ 실측) | exit code / rpc 응답 | 소켓 미도달 | darwin(cmux) | **높음(실측)** |
| **Ghostty** | (신뢰 형태 없음) | — | — | 외부 spawn API 불확실 | — | **낮음** → cmux로 |
| **VS Code/Cursor** | (없음) | — | — | code CLI 미지원 | — | **불가** → OS 폴백 |
| detached(setsid/nohup/disown/Node) | — | — | "시작됨"만 | 가시 창 없음 | — | **N/A(헤드리스 전용)** |

---

## 6. 미해결/공백 (plan에서 처리)

1. **`claude --bg`/`--background` + `claude agents` (연구항목 #3) — 살아남은 검증 주장 없음(공백).** 백그라운드 에이전트가 "사용자 가시성+중간 개입"을 어디까지 대체하는지, 진행 관찰/attach 메커니즘이 무엇인지 미확정. (출처 후보 fetch됨: code.claude.com/docs/en/agent-view, claude.com/blog/agent-view-in-claude-code — plan 단계에서 직접 확인 권장.)
2. **tmux/screen no-attached-client:** spawn 시 attach된 클라이언트가 없으면 window는 attach까지 invisible. `buildLaunchCommand`가 attach 상태를 감지/자동 attach해야 하는가, 그리고 TTY 없는 서브프로세스에서 auto-attach가 가능한가?
3. **WezTerm/kitty 사전 probe 시퀀스:** spawn 시도 전 능력 판정(`wezterm cli list` / `KITTY_LISTEN_ON` 존재)으로 게이트 결정.
4. **Ghostty 외부 spawn:** keybind 외 CLI/IPC가 실제로 있는지(refute됨) — cmux shim이 Ghostty 계열의 유일 경로인지.

---

## 7. 설계 권고 (plan §4 입력)

1. **`buildLaunchCommand`를 환경 인지로 확장** — `session_spawn.launcher`에 맞는 변형 선택. 명령은 **개별 argv 토큰** 우선(tmux multi-arg; osascript/wt는 검증된 이스케이프 형태만).
2. **신규 `detect-terminal.mjs`** — §3 우선순위 ladder. `CMUX_*`/`$TMUX`/`$STY`/`$WT_SESSION`/`$KITTY_LISTEN_ON`/`$WEZTERM_PANE`/`process.platform` 우선, `TERM_PROGRAM`은 약한 힌트. launcher 결정 후 **사전 probe로 검증**(`verified` 플래그).
3. **신규 `visibleSpawn(cmd,{launcher})` spawnFn** — launcher로 가시 표면 열기. **반드시 `respawn` 경유**(게이트+CAS+handshake). launch 성공/실패는 런처 종료코드(WezTerm은 pane-id)로 관측해 respawn 실패모드 B(롤백)/성공 경로를 정확히 탐.
4. **detached 기법은 visibleSpawn에서 금지** — 헤드리스 생존 경로 전용.
5. **폴백 정책(안전):** launcher 미상/probe 실패 → **조용한 헤드리스 전환 금지**(사용자 의도 위배). `launch-command.txt` 제시 + needs-human, 또는 명시 opt-in 시에만 headless. VS Code/Cursor·Ghostty(비-cmux)는 OS 터미널 폴백.
6. **lease/비용 정합 (핸드오프 §4.3):** 가시 세션은 별도 표면의 독립 프로세스 → reserved-child handshake로 lease 인계, 부모는 launch 성공만 확인(동기 spawn으로 블록 금지). visible 모드 예산은 best-effort(사람 감시) + per_session_turn_cap 선제 핸드오프, 측정 fail-closed는 headless 전용.

---

## 8. 출처 (1차 우선)

**멀티플렉서:** man7.org/linux/man-pages/man1/tmux.1.html · manpages.ubuntu.com/focal/man1/tmux.1.html · man.openbsd.org/tmux.1 · gnu.org/software/screen/manual/html_node/Screen-Command.html
**터미널 에뮬레이터:** wezterm.org/cli/cli/spawn.html · sw.kovidgoyal.net/kitty/launch/ · sw.kovidgoyal.net/kitty/remote-control/ · learn.microsoft.com/en-us/windows/terminal/command-line-arguments · ghostty.org/docs/config/keybind/reference · iterm2.com/documentation-scripting.html
**VS Code:** code.visualstudio.com/docs/configure/command-line · /docs/terminal/advanced · /docs/supporting/troubleshoot-terminal-launch · github.com/microsoft/vscode/issues/190142
**감지:** github.com/anthropics/claude-code/issues/27868 · github.com/jonschlinkert/detect-terminal · raimue.blog/2013/01/30/tmux-update-environment/
**claude --bg:** code.claude.com/docs/en/agent-view · claude.com/blog/agent-view-in-claude-code · mindstudio.ai/blog/claude-code-bg-command-background-agent-sessions
**detached:** nodejs.org/api/child_process.html · github.com/tzvetkoff/setsid-macosx · sobyte.net/post/2022-04/linux-nohup-setsid-disown/ · venam.net/blog/unix/2017/06/04/daemons.html
**cmux (로컬):** raw.githubusercontent.com/manaflow-ai/cmux/main/docs/cli-contract.md · .../skills/cmux/SKILL.md

검증 통계: 6 angles · 25 sources fetched · 118 claims → 25 verified → 24 confirmed / 1 killed → 12 synthesized. 적대적 검증 대부분 3-0 만장일치.
