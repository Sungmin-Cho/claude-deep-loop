# Plan 1 커널 구현 — Codex cross-model 리뷰 로그

대상: 구현된 커널 코드 (`scripts/lib/*.mjs`, `scripts/deep-loop.mjs`, `tests/*`)
방식: `codex exec -s read-only --output-schema` (구조화 verdict/findings), review↔respond 반복
결과: **3 라운드만에 APPROVE 수렴**. 최종 `npm test` 62/62, preflight PASS.

| 라운드 | verdict | 🔴 | 🟡 | ℹ️ |
|---|---|---:|---:|---:|
| 1 | REQUEST_CHANGES | 3 | 3 | 0 |
| 2 | CONCERN | 0 | 1 | 0 |
| 3 | **APPROVE** | 0 | 0 | 0 |

## 라운드 1 — 해결된 6건 (보안/무결성 계약의 실제 빈틈)
- 🔴1 `.loop.hash` anchor 삭제로 tamper 탐지 무력화 → `readState`가 hash 없으면 fail-closed
- 🔴2 음수 cost 이벤트로 `budget.spent` 낮춤 → `validCost`(유한·비음수) 거부 + `recomputeSpent` LOG_CORRUPT
- 🔴3 event-log suffix truncation 미탐지 → `event_log_head` 앵커(hash-보호 loop.json) + `verifyHead`
- 🟡4 `validate` CLI 스텁 → schema+builder self-test + readState(hash) + schema.validate, 실패 시 nonzero
- 🟡5 mkdir-lock backoff/stale 복구 없음 → Atomics.wait backoff + TTL 회수
- 🟡6 wallclock 기본 fail-closed 아님 → `created_at`에서 파생
- (추가) `setPath` prototype-pollution 가드

## 라운드 2 — 해결된 1건 (라운드1 수정이 만든 새 이슈)
- 🟡 `event_log_head`를 `recordCost`만 갱신 → 향후 비-cost `appendEvent`가 앵커 stale로 만들어 `reconcileBudget` 오탐. **`integrity.appendAnchored`를 단일 앵커-유지 append 경로로 도입**(append+앵커+optional mutate를 한 lock에서). recordCost가 위임. 회귀 테스트 추가.

## 라운드 3 — APPROVE
- appendAnchored가 단일 경로, recordCost 비중첩 lock, 순환 import 없음(state↛integrity), 회귀 테스트가 양방향 커버. findings 0.

## 평가
cross-model 리뷰가 transcription-correct한 코드에서도 **계약 수준의 보안 빈틈**(anchor 삭제, 음수 cost, truncation, 공허한 validate)을 잡아냈다. 플랜 리뷰(3R)와 구현 리뷰(3R)의 이중 게이트가 커널을 merge-ready 상태로 수렴시켰다.
