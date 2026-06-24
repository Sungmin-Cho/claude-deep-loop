# Plan 2 (orchestration) 구현 리뷰 로그 — Codex-only 2-way 루프

작성일: 2026-06-24
대상: Plan 2 구현(`scripts/lib/{lease,workspace,episode,review,adapters,next-action,handoff,respawn}.mjs` + `scripts/deep-loop.mjs` CLI + `protocols/*.json` + tests)
리뷰어: Codex (`codex-cli 0.137.0`), read-only 소스 리뷰, 구조화 출력(verdict/findings) 스키마.
방법: Plan 문서가 Codex APPROVE로 수렴한 뒤 SDD(haiku/sonnet implementer)로 구현(9개 모듈, 123 green) → 구현 결과를 동일 Codex 2-way 루프로 재검증.

## 수렴 추이

| 라운드 | verdict | 🔴 | 🟡 | 핵심 |
|---|---|---|---|---|
| 1 | REQUEST_CHANGES | 3 | 3 | CLI가 checker terminal/ workstream terminal을 자가증명 우회, episode plugin path-traversal, debt가 정상 리뷰 차단, CLI respawn no-op, parseFlags 강제변환 |
| 2 | REQUEST_CHANGES | 2 | 1 | checker verdict replay(임의 ws/point), terminal 다운그레이드, episode done이 임의 기존 파일 수용 |
| 3 | REQUEST_CHANGES | 3 | 1 | lease 펜싱/replay/terminal 가드가 lock-비원자적, 수렴 버그(superseded rejected checker), 제출 artifact 미검증 |
| 4 | REQUEST_CHANGES | 3 | 0 | generation 펜싱이 멀티-lock 첫 mutation에만(review/respawn/handoff 후속 lock 누락) |
| 5 | REQUEST_CHANGES | 1 | 2 | respawn gate-blocked write 미펜싱, finish 수렴 미완, lease owner 미검증 |
| 6 | CONCERN | 0 | 2 | circuit breaker latch 누락, workstream 입력 미검증 |
| 7 | REQUEST_CHANGES | 1 | 0 | recordEpisode 비-터미널 null artifacts/proof → mutate throw로 event_log_head stale |
| 8 | CONCERN | 0 | 1 | respawn이 childRunId를 예약 child에 미바인딩 |
| 9 | REQUEST_CHANGES | 1 | 0 | acquireLease가 released lease를 비예약 child에 허용(대칭 보완) |
| 10 | REQUEST_CHANGES | 1 | 0 | recordReviewOutcome 멀티-lock half-commit |
| 11 | REQUEST_CHANGES | 1 | 0 | emitHandoff·respawn event+lease 분리로 half-commit |
| 12 | REQUEST_CHANGES | 2 | 0 | appendAnchored가 truncation launder, runId path-traversal |
| 13 | REQUEST_CHANGES | 1 | 0 | fence가 mutator에서 선택적(우회 경로 잔존) |
| 14 | CONCERN | 0 | 1 | dispatchReview가 phantom workstream 수용 |
| 15 | CONCERN | 0 | 1 | newEpisode가 phantom workstream 수용(대칭 보완) |
| 16 | **APPROVE** | 0 | 0 | 자연 수렴 |

총 **23 critical + 13 should-fix** 반영. 최종: `npm test` 175 green, `npm run preflight` PASS, 워킹트리 클린.

## 확립된 무결성/오케스트레이션 불변식 (구현에서 강제)

1. **단일 anchored append**: `integrity.appendAnchored(root,runId,{type,data},mutate,preCheck)`가 유일한 이벤트 기록 경로. `preCheck(loop)`는 lock 내 fresh loop에서 append **이전에** 실행 → throw해도 `event_log_head` 앵커가 stale되지 않음. append 전 `verifyLog`+`verifyHead`로 truncation/위변조 fail-stop(launder 방지).
2. **모든 커널 mutator의 generation 펜싱은 필수(fail-closed)**: `newWorkstream/setWorkstreamStatus/recordWorkstreamTerminal/newEpisode/recordEpisode/dispatchReview/recordReviewOutcome/emitHandoff`는 `fence/expect` 없으면 `FENCE_REQUIRED` throw하고, leaseCheck를 **변경 lock 내부에서** 수행. CLI가 `requireLease` 검증값으로 fence를 구성·전달.
3. **이벤트+상태/lease 변경은 단일 원자 트랜잭션**: review outcome(checker terminal+breaker+review_points+comprehension), handoff emit(session push+superseded_by+reserved→emitted/releasing/TTL), respawn 성공(spawned+release), respawn 실패(failed+rollback) 모두 한 `appendAnchored`로 all-or-nothing(half-commit 불가).
4. **터미널은 proof 파생, monotonic**: episode done=artifacts 존재+커버+경로안전, approved/rejected=verdict(review record 경유만), workstream ready=`review_points_done`가 `review.points` 커버(자가증명 boolean 불가), merged=사람 승인(merge_commit+human_approved), abandoned=reason. 터미널→비터미널 다운그레이드 및 터미널→터미널(ready→merged 외) 금지.
5. **lease 모델**: active 소유자는 시간 fence 안 됨(generation이 stale parent 펜싱); takeover는 released 또는 releasing+expired만; 예약 child만 released handoff lease 인수(stale TTL 후 복구 허용); generation 단조 증가. circuit breaker는 임계에서 latch(사람 reset 전용).
6. **경로 안전**: `runDir`가 unsafe runId(`..`/slash/빈값) 거부, episode plugin은 slug화+containment, expected/submitted artifacts는 절대경로·`..`·root탈출 거부. project root 밖 쓰기 0.
7. **2-plane/§1.1**: next-action·adapters는 디스크립터만 반환(스킬 직접 호출 안 함). respawn만 주입 가능한 `spawnFn`으로 프로세스 spawn(기본 `defaultSpawn`은 미배선 — Plan 3 드라이버가 주입).
8. **withLock 비재진입**: 어떤 mutator도 lock 내부에서 다른 lock-잡는 함수 호출 안 함(순차 또는 단일 appendAnchored).

## Plan 3에서 다룰 잔여(범위 밖)

- Execution plane 스킬 10개(`/deep-loop`, `-continue`, `-resume`, `-handoff`, `-finish` 등) + `deep-loop-workflow` references.
- PreCompact hook 실배선(`precompact-handoff.mjs`)이 `handoff emit`+`respawn`을 호출하는 글루(동시 드라이버) — 이때 본 plan의 원자적 펜싱이 실제 동시성에서 검증됨.
- headless 실제 `child_process` `spawnFn` 구현(현재 `defaultSpawn`은 명시적 미배선 경계).
- recipes/automation 템플릿, README/CHANGELOG, marketplace 등록.
