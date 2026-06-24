# deep-loop ↔ Loop Engineering 교차 분석

작성일: 2026-06-24
대상 문서: `docs/research/deep-loop-loop-engineering-prompt.md` (deep-loop v0.1 설계/프롬프트)
원문 철학: Addy Osmani, **Loop Engineering**[^addy-loop]

[^addy-loop]: Addy Osmani, "Loop Engineering", 2026-06-07, https://addyosmani.com/blog/loop-engineering/

> 이 문서는 deep-loop 설계 문서를 Loop Engineering 원문과 1:1로 대조해, 무엇이 충실히 반영되었고 무엇이 비어 있는지를 평가한다. 후속 개선 설계는 `deep-loop-faithful-implementation-design.md`에 있다.

---

## 0. 한 줄 결론

deep-loop 설계 문서는 Loop Engineering의 **구성요소(primitives)와 윤리적 경고**는 충실하게, 때로는 원문보다 더 엄격하게 반영했다. 그러나 원문의 **핵심 명제(autonomy thesis)** — "사람을 사이클 사이에서 제거한다" — 는 v0.1에서 의도적으로 비워두었다.

즉 **v0.1은 아직 "loop"가 아니라 "loop를 얹을 durable 기반(substrate) + manual control plane"이다.** 이것은 결함이 아니라 안전 우선 스코핑이지만, 문서 일부의 framing이 이 사실을 약간 과대 포장한다.

---

## 1. 원문 Loop Engineering 요지

원문의 정의는 단호하다.

> "Loop engineering is replacing yourself as **the person who prompts the agent**. You design the system that does it instead."

prompt engineering → context engineering → **loop engineering**으로의 이동이고, 결정적 차이는 **사람이 사이클 사이에 개입하지 않는 자동 heartbeat**다. Boris Cherny의 "My job is to write loops", Peter Steinberger의 "You should be designing loops that prompt your agents"가 thesis quote다.

원문이 제시한 빌딩 블록은 **5 + 1**이다.

| | 구성요소 | 원문에서의 의미 |
|---|---|---|
| A | **Automations (heartbeat)** | 스케줄로 도는 자동 트리거. discovery·triage를 사람 없이 시작 |
| B | **Worktrees** | 병렬 agent 충돌 방지. *단, 병목은 도구가 아니라 사람의 리뷰 대역폭* |
| C | **Skills** | `SKILL.md`로 의도를 1회 코드화 → "intent debt" 제거 |
| D | **Plugins & Connectors** | **MCP 기반 외부 환경 통합**(issue tracker, DB, Slack). 루프가 *보고*가 아니라 *행동*(PR 열기, 티켓 갱신)하게 함 |
| E | **Sub-agents (maker-checker)** | 만든 모델이 "자기 숙제를 채점"하지 못하게 분리 |
| F | **External state/memory** | "the agent forgets, the repo doesn't" — 대화 밖 영속 상태가 척추 |

그리고 **사람이 끝까지 지는 3가지 책임**: ① 검증(verification), ② comprehension debt(이해 부채), ③ cognitive surrender(인지적 항복). 원문의 마지막 문장이 전체를 요약한다.

> "Build the loop. But build it like someone who intends to **stay the engineer**, not just the person who presses go."

---

## 2. 구성요소 1:1 매핑

설계 문서 §3은 원문의 5+1을 7개로 재진술했고, 매핑 자체는 정확하다. 다만 **"반영 충실도"는 항목마다 크게 다르다.**

| 원문 | deep-loop v0.1 구현 | 충실도 | 비고 |
|---|---|---|---|
| A. Automations(자동 heartbeat) | `/deep-loop-discover` = **manual** heartbeat, hooks 없음, 자동 스케줄 없음 | ⚠️ 명목상만 | 원문의 핵심을 v0.2로 연기 |
| B. Worktrees | episode request에 *권장*만, 자동 생성 안 함 | ◐ 부분 | v0.1은 순차·수동이라 **실제 병렬 충돌이 발생하지 않음** → 권장이 선제적·이론적 |
| C. Skills | 7개 `SKILL.md` 제공 | ✅ 충실 | 단, "automation이 skill을 호출"하는 연결고리는 빠짐(A에 종속) |
| D. Plugins & Connectors | sibling deep-* **플러그인 라우팅**은 강함 / 외부 **MCP connector는 placeholder**만 | ◐ 의미가 어긋남(§4-2) | |
| E. Maker-checker | deep-work(maker) ↔ deep-review(checker) **episode 단위로 격상** | ✅✅ 우수 | 원문보다 한 단계 위 레이어로 재해석 |
| F. External state | `loop.json` + `event-log.jsonl` + handoff, **정식 schema**까지 | ✅✅ 원문 초과 | 가장 강한 정합 |
| 사람 책임(검증/이해부채/항복) | final-report + human checklist + proof-required + maker/checker | ✅✅ 구체적 운영화 | 원문은 "경고", deep-loop은 "구조" |

---

## 3. 잘 맞고, 오히려 더 나은 부분 (강점)

1. **External state가 원문을 초과 구현.** 원문은 "markdown 파일이나 Linear board" 수준으로 말했는데, deep-loop은 `loop.json` 스키마 + append-only `event-log.jsonl` + handoff 문서로 *source of truth*를 형식화했다. "the repo remembers, the agent forgets"를 가장 충실히 실현한 부분이다.

2. **Maker/checker를 sub-agent에서 plugin-episode로 격상.** 원문의 maker-checker는 한 도구 실행 안의 sub-agent(explorer→implementer→verifier)였다. deep-loop은 이를 **독립 플러그인 episode**(deep-work=maker, deep-review=checker)로 끌어올려, 검증자가 구현자의 컨텍스트를 공유하지 않게 만든다. 원문 정신("자기 숙제 채점 금지")을 더 강하게 보장하는 적응이다.

3. **사람 책임을 "경고"가 아니라 "게이트"로 구조화.** 원문이 산문으로 경고한 verification·comprehension debt를, deep-loop은 `final-report.md` + human review checklist + "done은 claim, proof가 아니다" 규칙 + proof artifact 없이는 completed 금지로 **강제**한다. 윤리적 경고를 코드 레벨 invariant로 번역했다.

4. **루프 모델 자체는 충실한 superset.** 원문의 discover→distribute→validate→record→determine을 deep-loop은 **Discover→Triage→Dispatch→Isolate→Verify→Record→Decide**로 Triage·Isolate를 명시 단계로 추가했다. 구조적으로 1:1 + α.

---

## 4. 간극·긴장·과장 (비판적 평가)

### 4-1. v0.1은 아직 "loop"가 아니다 — manual heartbeat의 역설

원문의 정의 자체가 *"사람을 사이클 사이에서 제거"*다. 그런데 deep-loop v0.1은:

- 자동 스케줄 ✗ → `/deep-loop-discover`를 **사람이** 친다
- sibling plugin 자동 실행 ✗ → `request.md`만 생성, **사람이** 실행한다
- 자동 터미널 실행 ✗, hooks ✗

→ 매 사이클마다 사람이 버튼을 누른다. **원문 thesis 기준으로는 v0.1이 "loop"의 정의를 충족하지 않는다.** 설계 문서 §1은 deep-loop이 "단순 handoff helper가 아니어야 한다"고 선언하지만, v0.1의 실제 동작은 *durable state를 갖춘 정교한 handoff coordinator + triage inbox*에 가깝다. 문서가 비판한 바로 그 범주("handoff helper")와 v0.1의 거리는, 문서의 자기 인식보다 가깝다.

> **재구성:** v0.1의 정직한 정체성은 *"autonomous loop"가 아니라 "loop substrate + manual control plane"*. 자동 heartbeat는 명백히 v0.2의 일이다. §1의 "future automation heartbeat surface"라는 표현이 이미 이 분리를 암시하지만, 더 앞에 명시하는 게 정확하다. (결함이 아니라 합당한 MVP 결정 — framing의 문제)

### 4-2. "Plugins"의 의미 어긋남 — §3 line 76의 과대평가

원문의 **D. Plugins & Connectors는 "MCP로 외부 환경에 연결"**(issue tracker, DB, Slack)이 본질이다. 그런데 deep-loop은 "plugins"를 **sibling deep-suite 플러그인 오케스트레이션**으로 해석한다. 이 둘은 다른 개념이다.

- deep-loop은 *intra-suite 플러그인 라우팅*에 강하다 — 그런데 이건 **원문에 없는 novel extension**이다. (원문은 "plugin = skill+connector 번들을 팀에 배포"라고만 함.) control-plane-over-a-plugin-suite는 deep-loop의 독창적 기여이지 원문 반영이 아니다.
- 원문이 실제로 말한 *외부 connector*는 deep-loop v0.1에서 placeholder로 전부 연기됐다.

따라서 설계 문서 §3 line 76의 *"기존 프롬프트는 ... 4(plugins/connectors)는 잘 반영했다"*는 **부정확**하다. §4 표가 같은 항목을 "Connectors/MCP: 약함"으로 적은 것과 **문서 내부에서 모순**된다. 정확히는 *플러그인 라우팅 강함 + 외부 connector 약함*으로 쪼개야 한다.

### 4-3. 보고만 하는 루프 vs 행동하는 루프

원문은 connector가 있어야 루프가 *"보고"를 넘어 "행동"(PR 열기, 티켓 갱신, Slack 알림)*한다고 강조한다. deep-loop v0.1은 push/PR/publish/connector를 전부 금지 → **구조적으로 report·recommend-only 루프**다. 안전상 타당하지만, 원문이 구분한 "acting loop"의 레버리지는 v0.1엔 없다는 점을 명시해야 한다.

### 4-4. Worktree isolation이 v0.1에선 공회전

원문: "병목은 도구가 아니라 사람의 리뷰 대역폭." 그런데 deep-loop v0.1은 episode를 **순차·수동**으로 dispatch하므로 *동시에 같은 checkout을 만지는 상황 자체가 발생하지 않는다.* 즉 worktree 권장은 막을 충돌이 아직 없는 **선제적·미래지향적 권장**이다. 실제 가치는 병렬 실행(v0.2)이 생겨야 발현된다.

### 4-5. Token cost는 가장 강한 경고인데 placeholder만

원문의 가장 구체적인 운영 경고는 토큰 비용("usage patterns can vary wildly", 지수적 누적)이다. deep-loop은 `--max-cost`를 **placeholder로만** 둔다 — 인지했으나 미구현. 자동화가 켜지는 v0.2에서 이게 빈 채로 남으면 위험하므로, 자동 heartbeat 도입 *이전*에 실제 budget gate가 들어가야 한다.

### 4-6. 네이티브 `/loop`·`/goal`과의 관계

원문은 Claude Code의 heartbeat 1차 도구로 `/loop`(간격)·`/goal`(stop-condition까지)을 직접 거명한다. 그리고 `/goal`은 **내부적으로 maker-checker split을 이미 구현**한다고 명시한다. deep-loop v0.1은 이걸 *활용하지 않고 옆에* 선다(line 747에서 "나중에 /loop에서 호출 가능"으로 연기).

자연스러운 질문: **deep-loop은 `/goal` 위에 얹는 recipe 레이어여야 하지 않나?** 실제 heartbeat·stop-condition·maker-checker를 `/goal`이 이미 준다면, deep-loop의 고유 가치는 *cross-plugin 라우팅 + durable triage substrate*로 더 좁고 선명하게 정의된다. (문서가 deep-goal 플러그인과의 경계는 명확히 했지만, native `/goal`을 *기반으로 삼는* 통합 경로는 v0.2 한 줄로만 남아 더 전면화할 여지가 있다.)

---

## 5. 종합 — "stay the engineer"는 우수, "build the loop"는 미완

원문의 마지막 문장은 두 절반이다: **"Build the loop"** + **"stay the engineer."**

- deep-loop v0.1은 **"stay the engineer" 절반**을 거의 모범적으로 구현했다 — 수동 게이트, human checklist, proof-before-done, maker/checker, 외부 상태. 원문이 *경고*로만 남긴 것을 *구조*로 강제한다.
- 반면 **"build the loop" 절반(자동 heartbeat·행동하는 connector·병렬 worktree)**은 v0.2+로 거의 전부 연기됐다.

이건 방어 가능한 제품 포지션이다 — Osmani 자신이 cognitive surrender를 가장 큰 위험으로 꼽았으니, 자동화보다 책임 구조를 먼저 까는 건 철학적으로 일관된다. 다만 **정확한 자기 규정**이 필요하다.

> deep-loop v0.1 = *"Loop Engineering의 안전·상태·검증 substrate를 먼저 세우고, autonomy는 그 위에 점진 추가하는 control plane."*

이렇게 규정하면 §1의 "올바른 정체성"과 v0.1 실제 범위 사이의 미세한 과장이 해소되고, 원문과의 관계도 정직해진다.

---

## 6. 설계 문서에 반영하면 좋을 구체 수정 3가지

1. **§3 line 76 수정** — "4(plugins/connectors)는 잘 반영"을 *"sibling 플러그인 라우팅은 강함 / 외부 MCP connector는 약함"*으로 분리해 §4 표와의 모순 제거.
2. **§1·§7에 v0.1 정체성 명시** — "v0.1은 manual control plane이며, 원문 의미의 autonomous loop는 v0.2 자동 heartbeat에서 완성"을 한 줄 추가.
3. **v0.2 우선순위 재배열** — 자동 heartbeat를 켜기 *전에* (a) 실제 token/budget gate와 (b) native `/goal` 기반 통합을 선행 조건으로 못 박기. 그래야 §4-5·§4-6의 위험이 자동화와 함께 폭발하지 않는다.

---

## 7. 다음 문서

이 분석이 식별한 6개 간극(§4)을 메우고 4개 강점(§3)을 살리는 진화 설계는
`docs/research/deep-loop-faithful-implementation-design.md`에 정리한다.
