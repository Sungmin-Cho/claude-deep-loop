# Handoff — deep-loop "Self-spawning session continuity" **머지·후속(post-implementation) 인수인계**

작성일: 2026-06-29
선행 상태: **구현 + 검증 완료.** 브랜치 `worktree-self-spawn-session-continuity` (main `8285135`에서 분기), main 대비 **25 commits**, `npm test` = **454 green**, `npm run preflight` green. PR 생성 단계.
대상: **이 작업을 머지하고 후속(deep-suite SHA re-pin + DEFER follow-up)을 처리하는 작업자(사람 또는 에이전트)**

> **source of truth 규칙 (deep-loop 철학):** 이 문서 + repo 코드 + `git log` + `docs/superpowers/{specs,plans}/2026-06-2*-self-spawn-*` + `.superpowers/sdd/progress.md`(SDD ledger, gitignored). **이전 대화 컨텍스트를 가정하지 말라.**

---

## 0. 30초 요약

deep-loop에 **OS·터미널 무관 자동 가시(visible) 새-세션 인수** 기능을 구현 완료했다 — 이전 세션 claude가 감지된 launcher로 사용자가 지켜보는 새 claude 세션을 자동으로 열어 작업을 이어간다(헤드리스 전용 ❌, 못 찾으면 needs-human 폴백).

- **구현:** `docs/superpowers/plans/2026-06-27-deep-loop-self-spawn-session-continuity.md`의 Task 1~13을 SDD+TDD(태스크당 fresh implementer + spec/quality 리뷰)로 green-per-commit 완료.
- **검증:** final whole-branch review(opus) "Ready to merge" + **codex-only 2-way 적대적 루프 7라운드** → 11개 실제 결함 수정 후 critical 0 수렴.
- **결과:** 327 baseline → **454 tests**, 24 feat/fix 커밋(+1 docs). 핵심 불변식(§4) 모두 유지.

---

## 1. 무엇이 됐나 (완료 상태)

신규/변경 (구현 13 커밋, `86dab47..40063d0`):
- NEW `scripts/lib/detect-terminal.mjs` — fail-closed positive-host-signal launcher 감지(cmux/iterm2/terminal-app/wt/powershell/none) + `detectAndPersist` CLI.
- `scripts/lib/handoff.mjs` — `buildLaunchCommand` → `{bin,argv,display,cwd?}` argv-entry 맵 + q/escApple(백슬래시 doubling)/psq + `launcher_socket` threading + `UNSAFE_SPAWN_ARG` 검증.
- `scripts/lib/spawn-driver.mjs` — `visibleSpawn`(additive) + `defaultRun(bin,argv,{cwd})` + `headlessSpawn` entry shape(측정 유지).
- `scripts/lib/state.mjs` — `pauseRun` 2모드(preserve/rollback) + RUN_PAUSED gate + terminal guard.
- `scripts/lib/recover.mjs` (NEW) — `recoverRun` + `recover --confirm` 사람-승인 escape.
- `scripts/lib/lease.mjs` — `acquireLease` preserve-resume unpause + terminal guard + `releaseLease` RUN_PAUSED gate.
- `scripts/lib/respawn.mjs` — `resolveSpawnMode`/`isHeadlessInvocation` + gate-before-mode + bounded child-readiness(`awaitChildReadiness`) + 2 atomic failure handler(`rollbackAndPause`/`preservePause`) + already-spawned 재진입 검증 + max_sessions excludes failed_launch.
- `scripts/hooks-impl/{drive-headless,precompact-handoff}.mjs` — resume_policy gate / tty 제거 + acquisition 검증 + fresh-fence recovery.
- `scripts/lib/initrun.mjs`·`schemas/loop-run.schema.json` — `spawn_style:'visible'` 기본, `session_spawn` 블록, autonomy 필드.
- `scripts/deep-loop.mjs` — `detect-terminal`/`pause`/`recover`/`respawn`(fenced) CLI.
- `skills/deep-loop-{continue,handoff,resume}/SKILL.md` + `references/handoff-respawn.md` — visible 결정 흐름(read+CLI only; no-launcher는 **always-respawn gate-first** 후 no-launcher일 때만 pause preserve).
- `README.md`/`README.ko.md`/`CHANGELOG.md` + `tests/self-spawn-integration.test.mjs`.

codex 2-way 수정 11 커밋 (`451f219..2fd202c`) — 상세는 `.superpowers/sdd/progress.md`. 핵심 가족: **gate-bypass + acquisition-verification**를 모든 spawn/handoff 경로(skill/CLI/driver/precompact/respawn × visible/headless/no-launcher)에서 닫음. (opus final이 첫 건을 Minor로 봤으나 codex가 high/critical로 정확히 escalate.)

---

## 2. 후속 1 — **머지 후 deep-suite SHA re-pin (필수, CLAUDE.md "Release")**

PR이 **main에 머지된 뒤**:
1. 머지된 `main` 커밋 SHA를 deep-suite 레지스트리의 `deep-loop` 엔트리 `sha`로 설정 — `.claude-plugin/marketplace.json` **및** `.agents/plugins/marketplace.json` (×2).
2. deep-suite `npm run preflight` 실행(README 표 자동 재생성 — auto-generated 마커 안쪽 수동편집 ❌).
3. 패치는 `integration/deep-suite.patch.md`에 사전 작성됨.
   (등록은 discoverability만 추가 — deep-loop은 sibling 없이 standalone 동작.)

---

## 3. 후속 2 — **DEFER된 findings (follow-up, merge-blocking 아님)**

모두 **headless-only + stale-TTL fail-safe 존재 + visible/KK=A 기본 경로 무영향**이라 v1 비차단으로 DEFER. (codex 2-way가 critical/high를 모두 닫은 뒤 남은 것.)

1. **[codex-r7 finding 2] respawn headless `spawned` 재진입 no-op** — spawned CAS 직후~측정 자식 실행 전 크래시 시, headless 재진입이 acquisition 미관측이어도 `already-spawned` 반환(autonomous fail-close 대신 stale-TTL takeover 의존). 라운드 5 fix가 verify+preserve를 **visible 재진입에만** 한정(headless first-entry는 동기 측정 가정). Follow-up: headless 재진입에도 acquisition-verify/preserve 확장, 또는 deadline 있는 `launching` 상태 추가.
2. **test-hygiene** — ~15개 테스트 seed + `validate` self-test가 `buildInitialLoop`/`initRun`을 env 주입 없이 호출 → live-cmux 머신에서 매 seed `cmux ping` subprocess(현재 무해: 454 green/빠름, CI Linux는 probe 없음). Follow-up: no-signal env 주입(또는 init-time detect를 init-run CLI로 이동).
3. 기타 Minor — schema `properties` 블록 inert(미강제), respawn readiness 성공분기가 `generation===start+1` 생략(benign, false-success 불가), wt resumePrompt `;` Windows 이스케이프(best-effort/KK=A), CLI respawn 핸들러 under-tested(`--dry-run`만 커밋).

---

## 4. 절대 깨지 말 불변식 (스펙 §12 + CLAUDE.md — 코드+codex로 강제)

1. **2-plane:** 스킬은 상태 읽기만, 변경은 CLI(`detect-terminal`/`handoff`/`respawn`/`pause`/`recover`)로만.
2. **모든 mutating CLI는 in-lock lease fence**(`--owner/--generation`). 종료코드 3=fence/2=usage/1=invalid.
3. **이벤트+상태 = 단일 `appendAnchored` 트랜잭션**(rollback/preserve 실패도 단일 — child/superseded_by/lease/status 일관).
4. **`status==='paused'` 런은 mutation 거부**(RUN_PAUSED; recover/resume-acquire/breaker-reset만 예외). **terminal(`completed`/`stopped`)은 pauseRun/acquire 거부**(demote 차단).
5. **spawn은 반드시 respawn 경유**(gate budget→breaker→max_sessions→wallclock→auto_handoff **먼저**, 그 다음 mode; emitted→spawned CAS + handshake). gate-blocked는 launcher 유무 무관 **rollback**(예약 child 무효화, R12-LL); no-launcher(gate 통과)만 **preserve**.
6. **fail-closed 감지:** cmux는 **절대경로** `CMUX_BUNDLED_CLI_PATH` + `CMUX_SOCKET_PATH` + caller surface 모두 요구(bare/default/PATH 폴백 ❌); 강신호 probe 실패 → none(강등 ❌).
7. **이스케이프:** argv 토큰 우선; q()/escApple(백슬래시 doubling)/psq(-EncodedCommand); 모든 `display`도 q(root). bash/`-c` ❌.
8. **headless 자율 연속성:** driveHeadless는 persisted `resume_policy==='headless'`만 resume; resume success는 **pre-respawn parent 대비 lease 이동(acquisition)** 증명 후에만 cost 기록/`resumed` 보고, 아니면 fresh-fence fail-closed.
9. **KK=A (사용자 확정):** visible 기본; `--attended`는 best-effort 선언(보안경계 ❌); 진짜 강제 = max_sessions/wallclock/per_session_turn_cap/isHeadlessInvocation(fail-closed). **번복 금지.**

---

## 5. 시작 명령 (새 세션에 그대로)

```
cd /Users/sungmin/Dev/claude-plugins/deep-loop (worktree-self-spawn-session-continuity 브랜치)
이 파일 + .superpowers/sdd/progress.md(SDD ledger) + git log 를 읽어라. 이전 대화 가정 ❌.
npm test = 454 green / npm run preflight green 확인.
PR이 아직 안 머지면: 리뷰 대응(받은 피드백은 superpowers:receiving-review 로 증거기반 검증 후 수락/반박).
PR 머지되면: §2(deep-suite SHA re-pin) 수행. 그 후 §3 DEFER follow-up(headless 재진입 acquisition + test-hygiene)을 별도 작업으로.
§4 불변식 절대 준수. KK=A 번복 ❌.
```

---

## 6. 한 줄 요약

self-spawn 세션 연속 기능 **구현+검증 완료**(SDD 13태스크 + opus final + codex 2-way 7R/11fix, 454 green). 남은 일: **PR 머지 → deep-suite SHA re-pin(§2) → DEFER follow-up(§3, headless 재진입 acquisition + test-hygiene)**. 불변식(§4)은 절대선, KK=A는 사용자 확정.
