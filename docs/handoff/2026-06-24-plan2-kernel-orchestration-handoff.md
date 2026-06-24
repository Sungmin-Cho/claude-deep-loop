# Handoff — deep-loop Plan 2 (오케스트레이션 기계) 작업 인수인계

작성일: 2026-06-24
작성 세션 산출: Plan 1 (커널 기반) 설계·리뷰·구현·재리뷰 완료
대상: **새 세션에서 Plan 2를 이어서 진행하는 작업자(사람 또는 에이전트)**

> **source of truth 규칙 (deep-loop 자체 철학과 동일):** 이 문서와 아래 참조 파일들을 source of truth로 사용하라. **이전 대화 컨텍스트를 가정하지 말라.** 모든 사실은 repo의 파일과 `git log`에 있다.

---

## 0. 30초 요약

`deep-loop`은 Addy Osmani의 **Loop Engineering**을 deep-suite 위의 **cross-plugin 오케스트레이션 control plane**으로 구현하는 독립 Claude Code/Codex 플러그인이다. 2-plane 아키텍처(결정론적 Node Control plane + LLM Execution plane). **Plan 1(결정론적 커널 하부)은 완성·검증됨**(62 테스트 green, Codex 3라운드 APPROVE). 당신의 일은 **Plan 2(오케스트레이션 기계: lease·workspace·episode·review·handoff·respawn·next-action·adapters)**를 같은 방식으로 설계→리뷰→구현→재리뷰하는 것이다.

작업 위치: `/Users/sungmin/Dev/claude-plugins/deep-loop`, 브랜치 `feat/deep-loop-v1`.

---

## 1. 반드시 먼저 읽을 참조 파일 (우선순위 순)

1. **설계 스펙** `docs/superpowers/specs/2026-06-24-deep-loop-design.md` — 전체 v1 아키텍처. Plan 2가 구현할 부분: **§4(커널 CLI 계약 — lease/next-action/handoff/respawn/tick 명령), §5(loop.json 스키마 — lease/workstreams/event_log_head 등), §6(프로토콜 어댑터 4-verb), §8/§8.1(multi-workstream + fan-in), §9/§9.1(자율 respawn + 세션 lease 프로토콜)**. §1.1·§1.2(커널은 LLM 스킬을 호출하지 않음 + 위협 모델)는 Plan 2 전반의 불변 제약.
2. **Plan 1 (완료된 플랜)** `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan1-kernel.md` — Plan 2 플랜을 쓸 때 **형식·세분화·TDD 스타일의 모범**으로 삼아라.
3. **리뷰 로그** `docs/superpowers/specs/2026-06-24-deep-loop-design.review-log.md`, `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan1-impl-review-log.md` — 어떤 종류의 결함이 잡혔는지(강제 가능성·lease fencing·예산·무결성). 같은 함정을 피하라.
4. 연구 문서 `docs/research/*.md` — 철학적 배경(간극·충실 구현 방향).

---

## 2. 현재 repo 상태 (Plan 1 완료)

브랜치 `feat/deep-loop-v1`, `main` 대비 21 커밋. `npm test` = **62/62 green**, `npm run preflight` = PASS, 워킹트리 클린. 외부 의존성 0.

```
deep-loop/
  package.json (.type=module, node>=20, test/validate/preflight scripts)
  .claude-plugin/plugin.json  .codex-plugin/plugin.json
  schemas/loop-run.schema.json        # 자체 검증기용 (required/enums/episode_status/workstream_status)
  scripts/
    deep-loop.mjs                      # CLI 디스패처. 현재 subcommand: validate, detect-plugins, recipe-match, init-run
    lib/
      envelope.mjs slug.mjs schema.mjs log.mjs       # 유틸/검증/M3
      state.mjs integrity.mjs detect.mjs recipes.mjs # 상태·무결성·감지·recipe
      budget.mjs breaker.mjs comprehension.mjs        # 안전 게이트
      initrun.mjs                                     # buildInitialLoop + initRun
  recipes/*.json (6개)
  tests/*.test.mjs (13개 파일, 62 테스트)
  docs/{research,superpowers/specs,superpowers/plans,handoff}/...
```

**아직 없음(= Plan 2가 만들 것):** `scripts/lib/{lease,workspace,episode,review,handoff,respawn,next-action,adapters}.mjs`, `protocols/{deep-work,superpowers,standalone}.json`, `recipes/automation/*.yml`, 그리고 이들의 CLI subcommand 연결 + 테스트.

---

## 3. Plan 1이 노출하는 인터페이스 (Plan 2가 소비 — 정확한 시그니처)

새 코드는 이 시그니처에 의존하라. **직접 loop.json을 쓰지 말고 반드시 이 함수들을 거쳐라**(2-plane 경계).

```
// state.mjs  — lock-safe 상태 + 화이트리스트
runDir(root, runId): string                       // <root>/.deep-loop/runs/<runId>
readState(root, runId): { data, hash }            // .loop.hash 없거나 불일치 시 throw STATE_TAMPERED
writeState(root, runId, data): void               // schema 검증 후 atomic write + .loop.hash 갱신
patch(root, runId, field, value): void            // classifyPatch 화이트리스트만; 위반 시 throw FIELD_FORBIDDEN
classifyPatch(field, value): 'allow'|'forbid'     // default-deny
withLock(root, runId, fn, {ttlMs,retries,backoffMs}?): T   // 비재진입! 중첩 호출 금지. stale TTL 회수.
WHITELIST: Set<string>

// integrity.mjs — append-only 이벤트 로그 + 앵커
appendAnchored(root, runId, {type,data}, mutate?): void   // ★ 유일한 앵커-유지 append 경로.
                                                          //   mutate(loop, spent) 로 호출자별 상태변경. lock 내부.
appendEvent(root, runId, {type,data}): void       // 저수준(raw). reconcile 상태를 건드리면 안 됨 — 직접 쓰지 말 것.
verifyLog(root, runId): {ok, errors}              // 시퀀스+체크섬 체인
verifyHead(root, runId, expected): {ok, errors}   // event_log_head 앵커 vs 실제 tail (truncation 탐지)
lastLogHead(root, runId): {seq, checksum}
recomputeSpent(root, runId): {turns, tokens}      // cost 이벤트 합산 (음수/비유한 → throw LOG_CORRUPT)
validCost(d): boolean

// budget.mjs
checkBudget(loop, {now,sessionStart,measurable}?): {ok, reason, tier_after}  // sessionStart 생략 시 created_at에서 파생
recordCost(root, runId, {turns,tokens}): void     // appendAnchored 경유; 음수/비유한 → throw INVALID_COST
reconcileBudget(root, runId): {turns, tokens}     // verifyLog+verifyHead+spent 대조; 불일치 시 throw BUDGET_TAMPERED

// breaker.mjs
checkBreaker(loop): {tripped, reason}             // tripped flag 또는 consecutive_request_changes>=3
tripBreaker(root, runId, reason): void            // status=paused로
recordReviewVerdict(root, runId, verdict): void   // REQUEST_CHANGES면 카운터++, else 0

// comprehension.mjs
computeDebt(loop): {debt_ratio, blocked}          // blocked면 새 maker fan-out 중단
ack(root, runId, episodeId): void
recordReviewed(root, runId, episodeId, source): void   // 'deep-review-approve'는 require_human_ack=false일 때만 카운트

// detect.mjs / recipes.mjs / initrun.mjs / envelope.mjs / slug.mjs
detectPlugins(root, home?): {[name]: boolean}
matchRecipe(goal, detected): {recipe, protocol, reason}
buildInitialLoop({goal,protocol,recipe,detected,review,now,runId,git}): object
initRun(root, {goal,protocol,recipe,review,detected,now,git}): {runId, loop}
ulid(now?, rnd?), atomicWrite(path,contents), contentHash(str), wrap({...}), unwrap(obj,{producer,artifact_kind})
slugify(text,maxWords?), runIdSlug(goal,now?)
```

**loop.json 핵심 필드(이미 buildInitialLoop가 생성):** `session_chain.lease{owner_run_id,generation,expires_at,state,handoff_idempotency_key,handoff_phase}`, `event_log_head{seq,checksum}`, `workstreams[]`, `active_workstreams`, `autonomy{tier,auto_handoff,spawn_style,max_sessions,...}`, `budget{...,max_wallclock_sec,unattended_requires_headless}`, `review{points,reviewer,mode,flags,...}`. → Plan 2의 lease/workspace/respawn 로직은 이 필드들을 채우고 전이시킨다.

---

## 4. Plan 2가 만들 것 (스펙 매핑)

| 모듈/파일 | 스펙 | 핵심 |
|---|---|---|
| `lib/lease.mjs` | §9.1 | lease CAS(acquire/release/check), generation 펜싱, `handoff_idempotency_key` 결정론 파생 + 단계기계(reserved→emitted→spawned→acquired), 부모 carve-out |
| `lib/workspace.mjs` | §8 | workstream 생성/상태전이, worktree/branch 추적, `depends_on`, active_workstreams ≤ max_parallel |
| `lib/episode.mjs` | §4·§5 | episode scaffold(request.md 골격)/record, **터미널 상태는 커널이 proof에서 파생**(스킬 patch 불가) |
| `lib/review.mjs` | §7 | review dispatch 설정(design/plan/impl checker episode 생성), deep-review 유/무 분기 |
| `lib/handoff.mjs` | §9 | handoff.md + compaction-state.json(M3) + launch-command.txt(전 OS), 멱등키 예약(CAS), session_chain append |
| `lib/respawn.mjs` | §9 | 게이트 순서(budget→breaker→max_sessions→wallclock→auto_handoff) 통과 시 `claude -n`/`claude -p` spawn, 실패 시 lease 부모 롤백 |
| `lib/next-action.mjs` | §1.1·§4 | 현재 상태에서 다음 행동 디스크립터 + 게이트 판정 반환(**dispatch 안 함**) |
| `lib/adapters.mjs` + `protocols/*.json` | §6 | 4-verb(dispatch/awaitResult/checker/readArtifacts) 정규화, deep-work/superpowers/standalone 바인딩. **커널은 sibling 스킬을 직접 호출하지 않음** — next_action 반환 |
| CLI 연결 | §4 | `deep-loop.mjs`에 `lease`, `next-action`, `handoff emit`, `respawn`, `tick`, `episode new/record`, `workstream new/set`, `review dispatch` subcommand 추가 |

---

## 5. 따라야 할 프로세스 (이번 세션과 동일)

1. **`superpowers:writing-plans`로 Plan 2 작성** → `docs/superpowers/plans/2026-06-24-deep-loop-v1-plan2-orchestration.md`. Plan 1과 동일한 bite-sized TDD 형식. lease/respawn race·멱등성은 반드시 테스트로(§9.1).
2. **Plan 2에 대해 Codex-only 2-way 리뷰 루프** (아래 §6 하네스) → APPROVE 수렴까지.
3. **`superpowers:subagent-driven-development`로 구현** (implementer는 haiku, 게이트 = `npm test` green). 독립 모듈은 한 implementer가 순차 묶음 처리 가능, 의존 체인은 개별.
4. **구현 결과에 대해 Codex-only 2-way 리뷰 루프** → APPROVE 수렴.
5. Plan 3(Execution plane 스킬 + 패키징 + 등록)으로 동일 반복, 또는 그 시점에 다시 handoff.

---

## 6. Codex 리뷰 하네스 (이번 세션에서 검증된 패턴)

Codex CLI가 설치돼 있음(`codex exec`). cross-model 리뷰는 다음 패턴:

```bash
# 1) 구조화 출력 스키마 (verdict/summary/findings[severity,section,title,detail,recommendation])
#    — scratchpad에 review-schema.json로 저장 (이번 세션 것 재사용 가능)
# 2) 리뷰 프롬프트를 파일로 작성 (대상 파일 경로 + 무엇을 헌팅할지 명시)
cat review-prompt.txt | codex exec -s read-only --output-schema review-schema.json \
  --color never --skip-git-repo-check - > out.json
# 3) out.json 파싱: verdict가 REQUEST_CHANGES/CONCERN이면 findings 반영 후 재리뷰, APPROVE까지 반복.
```
review-schema.json 형식(이번 세션 사용본):
```json
{"type":"object","required":["verdict","summary","findings"],"properties":{
 "verdict":{"enum":["APPROVE","CONCERN","REQUEST_CHANGES"]},
 "summary":{"type":"string"},
 "findings":{"type":"array","items":{"type":"object",
   "required":["severity","section","title","detail","recommendation"],
   "properties":{"severity":{"enum":["critical","should-fix","info"]},
     "section":{"type":"string"},"title":{"type":"string"},
     "detail":{"type":"string"},"recommendation":{"type":"string"}}}}}}
```
주의: read-only 샌드박스에서 codex는 파일을 읽을 수 있지만 mkdtemp 등 쓰기는 막힘(소스-리뷰 기반 판정). 그래도 충분히 유효.

---

## 7. 절대 깨지 말 불변식 (Plan 1에서 확립, Codex가 강제 확인)

- **2-plane 경계:** Execution plane(스킬/어댑터)은 상태를 읽고, 변경은 커널 CLI/함수로만. 직접 loop.json 쓰기 금지.
- **커널은 LLM 스킬을 함수처럼 호출하지 않는다(§1.1):** next_action 반환 → Execution LLM이 dispatch. headless는 `claude -p` subprocess.
- **withLock는 비재진입:** lock 잡은 콜백 안에서 또 lock 잡는 함수 호출 금지(데드락). 이벤트 기록은 `appendAnchored` 단일 경로로.
- **터미널 상태는 커널 파생:** episode done/approved, workstream merged/ready 등은 proof artifact에서만. 스킬 patch 불가.
- **비가역 외부 행동(push/merge/publish/delete)은 어떤 tier에서도 항상 사람 승인.** v1 외부 행동은 전부 proposal-only.
- **respawn 게이트:** budget+breaker+max_sessions+wallclock 통과 + auto_handoff 시만. lease 멱등키로 이중 spawn 차단. acting tier로 게이팅하지 않음(세션 연속 ≠ 외부 행동).
- **무결성은 탐지+fail-stop(예방 아님), 협조적-fallible 에이전트 전제(§1.2).** event_log_head 앵커 유지.
- project root 밖 쓰기 금지(단 sibling 플러그인 위임 예외 — finish의 memory/wiki).

---

## 8. 시작 명령 (새 세션에 그대로)

```
cd /Users/sungmin/Dev/claude-plugins/deep-loop  (브랜치 feat/deep-loop-v1)
이 파일(docs/handoff/2026-06-24-plan2-kernel-orchestration-handoff.md)과 §1의 참조들을 읽어라.
이전 대화 컨텍스트를 가정하지 말라.
`npm test`로 62/62 green을 확인하라(현재 상태 기준선).
그다음: superpowers:writing-plans 로 Plan 2(오케스트레이션) 플랜을 작성하고,
Codex-only 2-way 리뷰 루프로 수렴시킨 뒤, SDD로 구현하고, 다시 Codex 리뷰 루프로 검증하라.
§7 불변식을 절대 깨지 말라.
```
