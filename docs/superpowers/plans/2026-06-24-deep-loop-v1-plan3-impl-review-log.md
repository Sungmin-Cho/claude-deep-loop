# deep-loop Plan 3 — 구현 리뷰 로그 (Codex-only 2-way 루프)

작성일: 2026-06-25
대상: Plan 3 (Execution plane 스킬 + skill-facing CLI 완성 + PreCompact hook + headless spawn 드라이버 + automation + 문서 + marketplace 패치)
방식: **Codex-only 2-way 리뷰 루프** (`deep-review-loop` 프로토콜, codex 단독 리뷰어). `codex exec -s read-only --output-schema`로 verdict(APPROVE/CONCERN/REQUEST_CHANGES) + findings JSON 산출. 각 finding을 receiving-review 프로토콜대로 **실제 커널 코드와 대조 검증 후** 수락/반박.

브랜치 base: `25e10b1`(plan-loop-converged). 최종: `npm run preflight` = validate ok + **327 tests / 0 fail**, git clean.

---

## 1. 플랜 리뷰 루프 (8라운드 → APPROVE)

Plan 3 문서(`2026-06-24-deep-loop-v1-plan3-execution.md`)에 대한 Codex 리뷰.

| 라운드 | verdict | findings |
|---|---|---|
| 1 | REQUEST_CHANGES | 7 (1 critical) |
| 2 | REQUEST_CHANGES | 6 (1 critical) |
| 3 | REQUEST_CHANGES | 5 (1 critical) |
| 4 | REQUEST_CHANGES | 4 (1 critical) |
| 5 | REQUEST_CHANGES | 3 (1 critical) |
| 6 | REQUEST_CHANGES | 4 (1 critical) |
| 7 | REQUEST_CHANGES | 2 |
| 8 | **APPROVE** | 0 |

**합계 31 finding 전부 수락·반영.** 주요: finish proof-gate(빈 run 공허통과·per-maker 리뷰·report isFile/containment·fence-required), skill-facing CLI 완성(state get/patch·budget record·comprehension ack·breaker reset·finish·adapter resolve)의 in-lock fence + exit-code 분리(3=fence / 2=usage / 1=invalid), adapter 4-verb + read-only superpowers planning-only, headless fail-closed 드라이버 + `--output-format json` + 측정 usage 커밋 + pre-spawn fence 캡처 + accounting carve-out, PreCompact canonical gate-blocked 경로, boundary scanner(cp/mv/truncate/python/multi-line/shorthand, state 3파일로 한정), session-turn cap 배선, placeholder-아닌 실 TDD 테스트.

---

## 2. 구현 리뷰 루프 (8라운드 → APPROVE)

구현 결과(21 태스크, 커널/스킬/hook/드라이버/문서)에 대한 Codex 리뷰. 각 라운드 finding을 focused implementer(sonnet)로 수정 후 재검증.

| 라운드 | verdict | findings | 수정 커밋 |
|---|---|---|---|
| 1 | REQUEST_CHANGES | 4 (2 critical) | e2f1677 |
| 2 | REQUEST_CHANGES | 3 (2 critical) | 87d60f0 |
| 3 | REQUEST_CHANGES | 2 (1 critical) | 55f59e5 |
| 4 | REQUEST_CHANGES | 3 (2 critical) | c07f17e |
| 5 | REQUEST_CHANGES | 3 (2 critical) | 447d438 |
| 6 | REQUEST_CHANGES | 2 (2 critical) | bf669b2 |
| 7 | REQUEST_CHANGES | 1 (1 critical) | c0219eb |
| 8 | **APPROVE** | 0 | — |

**합계 18 finding(12 critical) 전부 수락·반영.** 주요 테마(대부분 자율 멀티세션 respawn/handoff 라이프사이클 — Plan-2 core가 Plan-3 headless 배선에 의해 노출):
- **멀티세션 respawn owner 식별**: respawn/emitHandoff가 `runId`(상태 디렉터리)와 `lease.owner_run_id`(현 세션 owner)를 혼동 → `parentOwner` 도입(1세대 이후 handoff/respawn fence 정상화).
- **동기 spawn 데드락 → lease handshake**: 동기 spawnFn이 child 종료까지 블록하는데 child는 lease `released` 필요 → reserved child가 `releasing` lease를 직접 acquire하는 handshake 추가.
- **per-maker finish proof**: point-level 카운트로는 한 checker가 여러 maker 커버/unbound approve 우회 → checker episode에 `target_maker` 바인딩 + 공유 `makerReviewed` predicate; finish convergence = (ws,point)별 **최신 done maker가 bound-approved**.
- **PreCompact emit-only**: 측정 fail-closed는 cron `driveHeadless`(headlessSpawn) 담당; PreCompact는 깨끗한 handoff만(sync=hook 블록 / detached=측정불가 우회 회피) + post-emit gate 재평가(max_sessions).
- **driveHeadless가 canonical respawn 재사용**: 직접 spawn 우회 제거 → respawnGate(budget/breaker/max_sessions/wallclock/auto_handoff) + emitted→spawned CAS(중복 launch 방지) 강제, usage 캡처 래퍼로 측정값 기록.
- **headless fail-closed pause**: resume child가 lease 인수 후 측정 실패(timeout/unmeasurable) 시 `state.pauseRun`으로 run 정지(spec §9 fail-closed).
- **comprehension**: `require_human_ack`를 source override로 우회 불가 + bound `target_maker`만 idempotent 카운트.
- **입력 검증**: newEpisode/dispatchReview lib + CLI 비-fence 인자 검증(malformed episode 차단).

---

## 3. 불변식 준수 (Codex 강제 확인)
2-plane 경계 · 모든 mutating CLI lease fence(in-lock) · 단일 `appendAnchored` 트랜잭션 · 터미널 상태 proof 파생(per-maker bound) · 비가역 외부행동 proposal-only · respawn 게이트 순서 + 미감시 headless 강제 + 측정불가 fail-closed · worktree 연속성 · root-밖-쓰기 금지(final-report 예외) · breaker latch(사람+lease reset).

## 4. 남은 단계 (사용자 승인 게이트)
PR + merge, GitHub push, deep-suite marketplace 등록(§13)은 **비가역 외부 행동**이라 사용자 명시 승인 필요. push 미승인 시 `integration/deep-suite.patch.md`(작성 완료)만 적용 보류.
