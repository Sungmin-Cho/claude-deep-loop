[English](./README.md) | **한국어**

# deep-loop

**Claude Code용 내구성 있는 오케스트레이션 플러그인** — 엄격한 2-plane 아키텍처, 예산 강제, proposal-only 안전 불변식으로 멀티세션·크로스플러그인 엔지니어링 작업을 조율합니다.

## 개요

deep-loop는 독립 실행 가능한(standalone/독립) Claude Code 플러그인으로, 내구성 있는 "루프"를 실행합니다 — 여러 LLM 세션에 걸친 발견(discovery), 트리아지(triage), 제작(make), 리뷰(review), 통합(integrate)의 구조화된 순서입니다. deep-suite(deep-work, deep-review, deep-wiki, deep-memory) 없이도 독립 동작하며, 있으면 오케스트레이션 레이어로 활용됩니다.

모든 비가역 외부 행동(push/PR/merge/publish/delete)은 v1에서 **proposal-only** — 모든 행동에 **사람 승인(human approval)**이 필요합니다. deep-loop는 자동 push·자동 merge를 절대 실행하지 않습니다.

## 아키텍처: 2-plane 설계

deep-loop는 엄격한 **2-plane 분리**(spec §1)를 강제합니다:

### Control Plane (커널)
커널(`scripts/lib/`)이 모든 상태·리스·예산·무결성을 관리합니다:
- **상태 기계** (`state.mjs`, `lease.mjs`) — 컨텐츠-해시 앵커 `loop.json`, generation-fenced 리스
- **예산 엔진** (`budget.mjs`) — turn/token/wallclock 하드캡, 측정불가 시 fail-closed
- **서킷 브레이커** (`breaker.mjs`) — 반복 실패 시 자동 트립, 사람 리셋 필요
- **무결성** (`integrity.mjs`) — 체인+헤드 앵커 추가전용 이벤트 로그, 변조 탐지
- **핸드오프/리스폰** (`handoff.mjs`, `respawn.mjs`) — 멱등성 키가 있는 상태 있는 세션 핸드오프

### Execution Plane (스킬 / SKILL.md)
스킬은 raw 상태 파일에 대해 **읽기 전용**입니다. CLI를 통해서만 상태를 읽고(`state get`, `next-action` 등), 커널 CLI 서브커맨드를 통해서만 씁니다(`state patch`, `budget record` 등).

## 명령어 (10개 스킬)

| 명령어 | 설명 |
|--------|------|
| `/deep-loop` | **진입점** — 내구성 있는 오케스트레이션 run 시작, 플러그인 감지, 레시피/프로토콜 매칭, 워크스트림 분해 |
| `/deep-loop-discover` | 발견 단계 — `discovered_items` 채우기, 워크스트림 매핑 |
| `/deep-loop-triage` | 트리아지 단계 — 워크스트림 우선순위 결정, 프로토콜 할당, 사람 확인 |
| `/deep-loop-continue` | 메인 틱 — 현재 워크스트림 진행: maker dispatch → 대기 → 아티팩트 읽기 → checker dispatch |
| `/deep-loop-handoff` | 다음 세션을 위한 clean handoff 방출(compaction-state + handoff 문서 작성) |
| `/deep-loop-resume` | handoff 문서에서 중단된 run 재개 |
| `/deep-loop-status` | 읽기 전용 상태 리포트 — 현재 run 상태, 예산, 활성 워크스트림, comprehension debt |
| `/deep-loop-ack` | 사람 리뷰 확인 — 에피소드를 human-reviewed로 표시, comprehension debt 감소 |
| `/deep-loop-finish` | Run 마무리 — 모든 에피소드 settled 확인, final-report 작성, 상태 전이 |

> 참고: `/deep-loop-workflow`는 `/deep-loop-continue` 등이 내부적으로 사용하는 비공개(user-invocable:false) 스킬입니다.

## 안전 불변식

1. **proposal-only / 사람 승인** — push, PR, merge, publish, delete는 자동 실행 안 함. v1은 항상 proposal을 제시하고 사람 확인 대기.
2. **리스 펜싱** — 모든 mutating 커널 CLI는 매칭되는 `--owner`(run_id)와 `--generation` 필요. 잘못된 세션은 상태 변경 전 거부.
3. **측정불가 사용량 fail-closed** — 무인(headless) 세션에서 turn/token 측정 불가 시 조용히 진행 않고 거부. `drive-headless.mjs` 드라이버가 강제.
4. **서킷 브레이커** — 반복 실패 시 브레이커 트립; 사람이 명시적으로 리셋해야 재개.
5. **proof 경유 터미널 상태** — 에피소드 `done`/`approved`/`rejected`, 워크스트림 `merged`/`abandoned`는 검증된 proof 아티팩트를 통해서만 설정 가능. **예외: episode `abandoned`는 사람 게이트(`--confirm`) escape 터미널 — proof 불필요, review point 충족으로 치지 않으며 두 종료 경로에서 settled로 취급.**
6. **`.deep-loop/` 외부 쓰기 금지** — 모든 커널 쓰기는 `<project-root>/.deep-loop/` 하위에만.

## 설치

```bash
# 권장 — Deep Suite 마켓플레이스에서 설치:
/plugin marketplace add Sungmin-Cho/claude-deep-suite
/plugin install deep-loop@claude-deep-suite
```

독립 사용 (스위트의 나머지 없이):

- **skills 디렉토리 (영구):** 이 repo를 `~/.claude/skills/deep-loop/` 로 클론하면 다음 세션에 `deep-loop@skills-dir` 로 로드된다.
- **세션 한정:** `claude --plugin-dir /path/to/claude-deep-loop`

요구사항: Node >= 20, 외부 npm 의존성 없음.

## 독립 동작 (Standalone)

deep-loop는 **독립** 사용을 위해 설계되었습니다 — 다른 deep-suite 플러그인 없이도 동작합니다:

- sibling 플러그인 미감지 시 `standalone` 프로토콜 기본 사용
- 스킬은 graceful 저하: maker/checker dispatch가 `standalone` 어댑터 사용
- 모든 안전 불변식, 예산 강제, 핸드오프 메커니즘 동일 동작

sibling 플러그인(deep-work, deep-review, deep-wiki, deep-memory) 존재 시 자동 감지 후 전문 스킬을 어댑터로 사용합니다.

## 무인 자동화 (Headless)

cron 또는 CI 사용을 위해 `scripts/hooks-impl/drive-headless.mjs` 포함:

```bash
# 헤드리스로 1 틱 실행 (측정불가 시 fail-closed: exit 1)
DEEP_LOOP_UNATTENDED=1 node scripts/hooks-impl/drive-headless.mjs

# cron/GitHub Actions 템플릿은 recipes/automation/ 참조
```

## deep-suite 연동

deep-suite 내에서 사용 시, deep-loop는 오케스트레이션 백본으로 동작:

- **deep-work** — 구현 워크스트림용 maker/checker 어댑터
- **deep-review** — 코드리뷰 워크스트림용 checker 어댑터
- **deep-wiki** — 문서 워크스트림용 writer 어댑터
- **deep-memory** — `/deep-loop-finish`가 run 아티팩트 아카이브를 위임

## 가시적 세션 연속성 (Self-Spawn)

`autonomy.spawn_style`이 `'visible'`이고 run 초기화 시 지원되는 터미널 멀티플렉서가 감지되면, deep-loop는 다음 세션을 새로운 가시적 창에 자동으로 스폰할 수 있습니다:

| 런처 | 감지 신호 | 새 세션 대상 |
|------|-----------|-------------|
| cmux | `CMUX_BUNDLED_CLI_PATH` + `CMUX_SOCKET_PATH` + surface ID | 소켓을 통한 새 cmux workspace |
| iTerm2 | `TERM_PROGRAM=iTerm.app` + osascript 프로브 | 새 iTerm 창 |
| Terminal.app | `TERM_PROGRAM=Apple_Terminal` + osascript 프로브 | 새 Terminal 창 |
| Windows Terminal | `WT_SESSION` + `wt.exe` 프로브 | 새 WT 탭 |

스폰은 **attended 전용**: 부모 세션이 인터랙티브하게 시작된 경우만 (`--attended` 플래그). 부모가 headless(`DEEP_LOOP_UNATTENDED=1`, `spawn_style='headless'`, 또는 headless 진입점 감지)이면 가시적 스폰을 우회하고 headless 경로를 사용합니다.

**OS 무관 폴백**: 런처 미감지(`launcher='none'`) 또는 attended 아닌 경우, `respawn`은 `{ok:false, outcome:'no-launcher'}`를 반환합니다. 스킬은 `pauseRun({mode:'preserve'})`를 호출해 예약된 child를 핸드오프에 유지합니다. 이후 사람이 새 터미널을 열고 `/deep-loop-resume`을 실행하거나, 예약된 child 세션이 나중에 시작해 아직 releasing 상태인 lease를 인수하면 — 어느 경로든 run이 자동으로 일시정지 해제됩니다. 핸드오프 문서와 `launch-command.txt`는 항상 수동 복사-붙여넣기 명령을 제공합니다.

**게이트 순서**: budget → breaker → max_sessions → wallclock → auto_handoff. 게이트 실패 시 `rollbackAndPause`(lease 롤백, child 무효화). 실행 명령 실패도 롤백. 준비 타임아웃 시 `preservePause`(child 유지, 늦은 인수도 성공).

## PreCompact Hook

deep-loop는 Claude Code 컨텍스트 컴팩션 직전에 clean handoff를 방출하는 `PreCompact` hook을 등록합니다. 무인 모드에서는 headless respawn도 트리거합니다. hook은 컴팩션을 절대 막지 않습니다(항상 exit 0).

## 라이센스

MIT — LICENSE 참조.
