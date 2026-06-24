# deep-loop v1 설계 스펙 — Codex cross-model 리뷰 로그

대상: `2026-06-24-deep-loop-design.md`
방식: `/deep-review-loop --codex-only` (Codex `codex exec`, read-only sandbox, 구조화 출력)
리뷰어: Codex (GPT) 단독 — cross-model 독립 검증
결과: **3 라운드만에 APPROVE 수렴**

| 라운드 | verdict | 🔴 | 🟡 | ℹ️ | 변화 |
|---|---|---:|---:|---:|---|
| 1 | REQUEST_CHANGES | 4 | 3 | 0 | 신규 |
| 2 | REQUEST_CHANGES | 2 | 3 | 0 | 감소 (criticals 4→2) |
| 3 | **APPROVE** | 0 | 0 | 5 | 자연 수렴 |

종료 사유: §3.A.1 자연 수렴 (verdict=APPROVE, 🔴/🟡=0/0).

## 라운드 1 — 해결된 7건
- 🔴1 2-plane 경계가 "주장"일 뿐 강제 안 됨 → §1.2 위협 모델 + 화이트리스트 강화
- 🔴2 respawn에 실제 lease/fencing 없음 → §9.1 lease 프로토콜
- 🔴3 커널이 LLM 스킬을 함수처럼 호출 불가 → §1.1 (next-action 반환, headless는 claude -p subprocess)
- 🔴4 인터랙티브 예산이 협조적이라 약함 → best-effort/hard 분리 + fail-closed
- 🟡5 외부 행동 정책 모순 → v1 전부 proposal-only
- 🟡6 worktree가 머지 충돌 0 아님 → §8.1 fan-in 모델
- 🟡7 enum 불일치·milestone 미정의·max_episodes 과소 → 정규화

## 라운드 2 — 해결된 5건
- 🔴1 무결성 anchor가 같은 FS에 있어 tamper-evident 아님 → **위협 모델을 "협조적-but-fallible 에이전트"로 정직히 스코핑** (drift 탐지, 적대자 방어 아님; v0.3+ MAC 옵션 명시)
- 🔴2 기본 interactive+auto_handoff의 세션 내 unbounded spend → respawn 천장(max_sessions + max_wallclock_sec 커널 강제) + 미감시는 headless 강제
- 🟡3 lease release/멱등 race → handoff 상태기계(reserved→emitted→spawned→acquired) 정밀화 + 실패 모드 단일화
- 🟡4 fan-in/status 스키마 불일치 → depends_on 추가, parked writer 지정, recipe override propose-only
- 🟡5 memory/wiki 쓰기 vs no-outside-root/no-MCP 모순 → sibling 스킬 위임 예외 명시

## 라운드 3 — APPROVE + info 5건 (블로커 아님)
- ℹ️1 다이어그램 "우회 불가" 문구 → "협조적 CLI 경로 내" 한정 (반영)
- ℹ️2 unattended 술어 구체화(non-tty/cron|loop/--unattended) (반영)
- ℹ️3 handoff phase를 명시 스키마 필드로 (반영: `lease.handoff_phase`)
- ℹ️4 스키마 정합 — 추가 변경 불필요
- ℹ️5 구현 시 sibling out-of-root 쓰기를 receipt에 명시 (구현 계획에 반영 예정)

## 평가
cross-model 리뷰가 Claude가 hand-wave한 3개 아키텍처 급소(강제 가능성·respawn fencing·커널의 스킬 호출 불가)를 정확히 짚었고, 정직한 스코핑과 구체 메커니즘으로 수렴. 스펙은 구현 계획에 진입할 수 있는 상태.
