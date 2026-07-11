---
name: deep-loop
description: "Loop Engineering control plane entry — starts a durable cross-plugin orchestration run over the deep-suite. Detects siblings, matches a recipe/protocol, asks the review strategy, decomposes the goal into workstreams, creates the run, and prints the next command. Triggered by '/deep-loop \"<goal>\"', 'start a loop', 'loop engineering', 'orchestrate this work', '루프 시작', '딥루프 시작', '루프 엔지니어링', cross-platform Skill({ skill: \"deep-loop:deep-loop\", args: \"<goal>\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어를 감지하여 같은 언어(language)로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인을 받는다.
> **maker/checker 분리 유지** — 같은 세션이 동일 workstream의 maker와 checker를 겸하지 않는다.

## 개요

`/deep-loop "<goal>"` — deep-suite 전체를 아우르는 내구성 있는 크로스-플러그인 오케스트레이션 run을 시작한다. loop engineering 진입점.

## 단계 1: 기존 Run 감지

먼저 진행 중인 run이 있는지 확인한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field status
```

- 결과가 `running`이면 `/deep-loop-status`로 현황을 보여주고 이어가기 또는 새 run 시작 중 선택을 요청한다.
- `null` 또는 파일 없음이면 새 run을 시작한다.

## 단계 2: Run 시작

### 2-1. Sibling 플러그인 감지

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" detect-plugins
```

감지된 플러그인 목록을 확인한다(deep-work, deep-review, deep-wiki, deep-memory 등).
`detect-plugins`는 각 sibling을 `installed`(어느 런타임 캐시에든 설치 — best-effort union, 마켓플레이스/직접 git 레이아웃 모두 매니페스트 `name`으로 감지) / `initialized`(프로젝트·홈 마커) / `present`(installed‖initialized)로 구분 감지한다. 리뷰/recipe 전략 분기는 `present`를 본다(설치-but-미초기화 sibling 누락 방지). 실제 dispatch는 Execution-plane LLM이 수행하며 그 시점에 호출 가능 여부를 확인한다(2-plane).

### 2-2. Recipe + Protocol 결정

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" recipe-match --goal "<goal>"
```

반환된 `recipe_id`와 `protocol`을 사용자에게 제안한다. 최종 확정은 사람이 한다(`recipe_override_auth=user-only`).

### 2-2.5. Hill-Climb Insights 환류 (읽기 전용, 무마찰)

과거 run들의 결정론 마이닝 결과를 조회한다 — **검증된** 최신 insights만 커널이 반환하며, 스킬은 파일을 직접 읽거나 파싱하지 않는다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" insights latest --json
```

- `null`이면 그냥 스킵한다 — 표시할 것이 없으므로 무마찰로 다음 단계로 진행한다.
- 결과가 있으면(candidates/aggregates 포함) 아래 §2-3의 리뷰 전략 질문 **설명**에 기존 문서화 기본값과 **나란히, 별도 옵션으로** 제안을 표시한다:
  - 각 제안에는 반드시 **인용 지표를 병기**한다(예: "max_review_rounds 7 — 근거: 직전 run implementation fix_cycles 평균 2.0").
  - 제안을 **preselect하지 않는다** — 어떤 옵션도 기본 선택 상태로 두지 않는다.
  - 무응답/엔터 경로로 제안이 채택되게 하지 않는다.
  - 어떤 값도 **자동 적용 ❌** — 확정은 항상 사람이다(`recipe_override_auth=user-only`, AskUserQuestion을 거치는 구조로 보장).
  - 반환 envelope.payload의 `suspicious_active` / `post_finish_mutated` 배열이 비어있지 않으면 제안·요약에 해당 run 목록을 ⚠️ 주의로 함께 표기한다 — 후보/제안 유무와 무관하게(라벨만 있는 경우에도 출력).
  - 이 표시 규칙은 prose-only 규율이다(자동 테스트 대상 아님) — 신뢰 원천은 커널의 `insights latest` 검증이지 스킬의 표시 방식이 아니다.

### 2-3. 리뷰 전략 확인

리뷰 전략을 결정한다(§7). 자세한 흐름은 `Read("../deep-loop-workflow/references/review-strategy.md")`를 참조:

- **deep-review 감지 시**: 기본 추천 `deep-review:deep-review-loop --contract --codex`(cross-model)
- **미감지 시**: codex 2-way / 서브에이전트 checker / standalone 중 선택 → 사용자 확정

결과를 `review` JSON으로 조립:
```json
{
  "points": ["design", "plan", "implementation"],
  "reviewer": "subagent-checker",
  "mode": "cross-model",
  "flags": [],
  "converge": true,
  "max_review_rounds": 5,
  "require_human_ack": true
}
```

### 2-4. Workstream 분해

큰 goal이면 N개 workstream(각각 하나의 PR)을 제안하고 사람 확인을 받는다("[이대로/조정/단일 PR로]"). 작은 작업이면 1 workstream 자동 결정.

### 2-4.5. 세션 model/effort 관측 (자동, 무프롬프트)

먼저 현재 실행 호스트를 **직접** 판정해 `<claude|codex>`에 `claude` 또는 `codex`를 넣는다. 환경 변수 마커는 권위가 아니며, Claude에서는 slash skill, Codex에서는 qualified dollar skill로 실제 실행 중인 호스트를 기준으로 assertion한다. 이 runtime 값은 run 생성 후 변경하지 않는다.

respawn이 자식 세션을 부모와 같은 model/effort로 띄우도록, init 시 현재 세션 값을 캡처한다(이 값이 durable "init seed" — 첫 handoff가 PreCompact/headless여도 fallback이 된다):

```bash
CLAUDE_EFFORT_VAL=$(node -e "process.stdout.write(process.env.CLAUDE_EFFORT||'')")
# CLAUDE_MODEL = 이 세션의 정확한 모델 ID (세션 컨텍스트가 알려준 값, 예: claude-opus-4-8[1m])
```

- effort는 `$CLAUDE_EFFORT` env에서 읽는다(비어 있으면 그 항목만 최소 확인 — model은 컨텍스트로 거의 항상 알 수 있음). 정상 경로에선 아무것도 묻지 않는다(무프롬프트).
- 관측된 값만 아래 `init-run`에 플래그로 덧붙인다(값 없는 `--model`/`--effort`는 커널이 usage exit 2로 거부하므로, 관측 못 한 항목은 플래그 자체를 생략한다). 무효 effort는 커널이 exit 1로 거부.

### 2-5. Run 생성 (`init-run`)

관측된 model/effort를 플래그로 덧붙인다(둘 다 관측된 경우):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" init-run \
  --runtime <claude|codex> \
  --goal "<goal>" \
  --protocol <protocol> \
  --recipe <recipe_id> \
  --review '<review_json>' \
  --model "<CLAUDE_MODEL>" --effort "<CLAUDE_EFFORT_VAL>"
```

`--recipe`는 `recipe-match`가 반환한 recipe **id 문자열**(예: `robust-implementation`)이다 — JSON이 아님.
`--model`/`--effort`는 §2-4.5에서 관측한 값(관측된 것만; effort가 비면 `--effort` 생략, 둘 다 못 하면 둘 다 생략 → 커널 기본값). 이 값이 `autonomy.session_model`/`session_effort`로 seed된다.
`run_id`를 받아 저장한다. 이후 모든 mutating CLI는 `--owner <run_id> --generation 1`.

### 2-5-1. Desktop 딥링크 재시작 opt-in 제안 (선택적, 최초 1회)

`init-run` 직후, 이번 run에서 **딱 한 번만** 실행한다(선택은 durable — 이후 handoff/continue에서 재질문하지 않는다).
이 절차는 asserted runtime이 `claude`일 때만 수행한다. `codex`이면 Codex App 자동 task 생성 URL을 추측하지 않고 handoff의 수동 `$deep-loop:deep-loop-resume` descriptor를 사용한다.

터미널 상태를 감지한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" detect-terminal --owner <run_id> --generation 1
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field session_spawn
```

`session_spawn.launcher === 'none'` **AND** 현재 세션이 attended **AND** `process.platform ∈ {darwin, win32}`(Claude Desktop이 존재하는 플랫폼)일 때만 아래 제안을 진행한다. 그 외(런처 정상 감지 · unattended · 미지원 플랫폼)에는 **아무것도 묻지 않는다** — 기존 happy path 무마찰이며, `decline-desktop` 호출조차 생략한다.

**"attended"의 정의(중요 — TTY 유무가 아니다):** 커널의 `isHeadlessInvocation(env)`가 `false`인 것, 즉 명시적 unattended/headless 마커(`DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS`/드라이버 entrypoint 휴리스틱)가 하나도 없는 세션을 attended로 판단한다. **non-tty라는 이유만으로 unattended로 취급하지 않는다** — Claude Desktop의 Code 탭은 사람이 지켜보는 GUI이지만 tty가 없으므로, tty 존재를 기준으로 삼으면 정확히 이 desktop 대상 환경에서 opt-in 제안이 억제되는 버그가 된다. 판단이 애매하면(마커도 없고 tty도 없는 등) fail-open하여 attended로 간주하고 제안한다 — 사람은 언제든 "아니오"로 거절할 수 있으므로 과소-제안보다 과다-제안이 안전하다.

**위 게이트를 통과했더라도, 핸들러가 지금 실제로 검증되지 않으면 제안 자체를 하지 않는다(round-6 리뷰 수정 — 코덱스 리뷰어 2/2):**

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" spawn-style probe-desktop
```

이 subcommand는 **read-only**다(상태 변경 없음, fence/owner/generation 불필요, run이 없어도 호출 가능). `{ ok: true, ... }`를 반환할 때만 아래 AskUserQuestion 제안을 진행한다. `{ ok: false, reason: ... }`이면 **조용히 건너뛴다** — AskUserQuestion도, `decline-desktop` 호출도 하지 않는다(기존 수동 `/deep-loop-resume` 흐름 유지). Windows에서는 v1.7.0부터 `ALLOW_WIN_PUBLISHERS`에 실기 관측 서명자 thumbprint가 pin되어(desktop-target.mjs — 2026-07-09 Windows 11 관측, MSIX 경로 패턴 포함) 정상 설치에서 `probe-desktop`이 `ok:true`를 반환할 수 있다. 단 leaf 인증서 로테이션(NotAfter 2026-10-21경) 이후에는 재-pin 전까지 `ok:false`(publisher-not-allowed)로 **fail-closed 복귀**한다 — 그 상태에서는 Windows 사용자에게 "켤 수 있다"고 묻는 것이 다시 원천 차단된다(관측 없는 추측성 pin은 금지). `confirmDesktop` 커널 자체도 동일한 라이브 프로브를 재확인하므로(guarantee (a)), 설령 스킬이 이 사전 게이트를 건너뛰더라도 durable 전이는 프로브가 실패하는 한 발생할 수 없다 — 이 스킬 단계는 순수 UX 최적화(불필요한 질문 방지)이며 안전장치의 유일한 층이 아니다.

게이트를 통과하면 커널에 단명 pending nonce를 기록한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" spawn-style offer-desktop --owner <run_id> --generation 1
```

반환된 `nonce`를 받아 `AskUserQuestion`으로 사람에게 묻는다:

> "터미널 런처가 감지되지 않았습니다. Claude Desktop에서 실행 중이면 딥링크 자동 재시작(반자동: 폴더 확인+Enter 필요)을 켤까요?"

- **예**:
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" spawn-style confirm-desktop --owner <run_id> --generation 1 --nonce <nonce>
  ```
  `autonomy.spawn_style`이 `desktop`으로 전이한다(`visible`/`interactive`에서만 유효한 전이 — `exit 3`=fence, `exit 1`=거부). **`confirmDesktop` 커널은 이 전이 직전에 다시 한번 라이브 핸들러 프로브를 실행한다** — 위의 사전 `probe-desktop` 게이트와 이 순간 사이에 핸들러가 사라지는(앱 삭제 등) TOCTOU 경합이 있어도, 프로브가 실패하면 `exit 1` `{ ok:false, reason:'HANDLER_UNVERIFIED' }`이고 **아무것도 저장되지 않는다**(durable 전이 없음).
- **아니오** (또는 미지원 플랫폼/프로브 실패라 애초에 제안하지 않은 경우는 호출 불필요):
  ```
  node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" spawn-style decline-desktop --owner <run_id> --generation 1
  ```
  pending nonce를 clear하고 기존 수동 `/deep-loop-resume` 흐름을 유지한다.

이 선택은 `autonomy.spawn_style`에 durable하게 저장된다 — `/deep-loop-continue`·`/deep-loop-handoff`가 이후 매 handoff마다 `spawn_style==='desktop'`이면 자동으로 `respawn --attended`를 호출하므로, 이 opt-in을 다시 묻지 않는다.

**복구 경로(round-6 part c):** 과거에 확인되었던 핸들러가 이후 깨진 경우(앱 삭제/이동, 서명 변경 등) — `spawn_style`이 이미 `desktop`으로 durable하게 저장된 뒤라 매 handoff가 프로브 실패 → preserve-pause를 반복하게 된다. 사람이 다음으로 복구한다:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" spawn-style reset-desktop --owner <run_id> --generation <n>
```
`spawn_style`을 `desktop → visible`로 되돌린다(fenced; `desktop`이 아닐 때는 `exit 1` `SOURCE_INVALID`, fence 불일치는 `exit 3`). 이후 위 opt-in 절차를 다시 밟아 재확인할 수 있다.

### 2-6. Workstream 생성

각 `workstream new` 호출 **직전**, 아래 절차로 worktree를 먼저 생성(eager)한 뒤 실제 path/branch를 기록한다.

**어떤 worktree 전환보다 먼저 두 값을 캡처한다:**
```bash
# linked worktree에서 --show-toplevel은 연결된 worktree를 반환 — project root ❌
ORIG_ROOT=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)   # main repo root
BASE_REF=$(git rev-parse HEAD)               # 의도한 base commit
```

#### Step 0 — 기존 격리 감지 및 재사용 결정

현재 세션이 이미 linked worktree 안인지 확인한다(`git rev-parse --git-dir` ≠ `--git-common-dir`; submodule 가드: `--show-superproject-working-tree`가 경로를 반환하면 일반 repo로 취급).

**이미 격리 상태이면** 적격성을 먼저 검증한다:
- **(a) clean** — 무관한 미커밋 변경 없음
- **(b) base** — 의도한 base commit 기반
- **(c) 소유** — 이 run 전용 브랜치/경로

세 조건 충족 **+ 사용자 확인** 시에만 첫 workstream을 재사용(실제 path/branch 캡처 → Step 2). 부적격 또는 미확인이면 git 생성(Step 1b) 또는 human selection 중단.

**비격리 상태이면:**
- **단일 workstream run → native 우선(Step 1a)**
- **다중 workstream run → 모든 ws를 전부 git(Step 1b)**, 세션은 ORIG_ROOT 유지

#### Step 1a — native (단일 workstream run 전용)

> 적용 범위: 단일 workstream run의 비격리 케이스. 다중은 Step 1b.

`EnterWorktree`(Claude Code), `/worktree`, `--worktree` 플래그 등 플랫폼 native worktree 도구가 있으면 ws 슬러그를 넘겨 격리 작업공간을 생성한다. Claude Code 컨벤션 경로: `<root>/.claude/worktrees/<slug>`, 브랜치 `worktree-<slug>`.

**Containment(생성 전 보장이 유일 경로):**
- ① native 호출 **전에** 그 도구가 `$ORIG_ROOT/.claude/worktrees/` 밑에 worktree를 생성할 것이 **보장**되는지 확인한다. Claude Code `EnterWorktree`는 알려진 동작이므로 사용 가능; 보장 불가하면 처음부터 **Step 1b(git 폴백)**으로 전환.
- ② 보장했는데도 native가 root 밖에 생성했다면 **즉시 fail-closed STOP(needs-human)** — 사후 audit 의존 ❌.

생성 후 **실제** path + branch를 캡처 → Step 2. **기록 전 변환 필수:** 캡처한 절대 경로가 `$ORIG_ROOT/.claude/worktrees/` 밑이면 `$ORIG_ROOT` 접두를 제거해 루트-상대(`.claude/worktrees/<slug>`) 형태로 변환한 뒤 Step 2에서 `--worktree`로 기록한다.

#### Step 1b — git (다중 workstream run의 모든 worktree, 또는 단일 run의 native 부재/폴백)

순서가 중요하다. 안전 검증을 먼저 수행한 **뒤에만** 생성 명령을 실행한다.

① **`git check-ignore` 검증(proposal-only, 생성 전 필수):**
```bash
git check-ignore -q .claude/worktrees/
```
gitignore되어 있으면 통과. **ignore 안 됐으면 `.gitignore`를 자동 편집·커밋하지 않는다** — 사람에게 해당 한 줄 추가를 **제안(proposal-only)**하고 **승인 시에만** 진행, 미승인이면 fail-closed 중단. 이 repo는 `.claude/worktrees/`가 이미 gitignore되어 무수정 통과.

② **검증 통과 후** `$ORIG_ROOT`-앵커 절대경로 + 명시 base로 생성한다:
```bash
git worktree add -b worktree-<ws-slug> "$ORIG_ROOT/.claude/worktrees/<ws-slug>" "$BASE_REF"
```
다중 run에서 git을 사용하는 이유: cwd를 이동시키지 않아 ORIG_ROOT에 머문 채 N개를 생성할 수 있다(native cwd 이동/중첩 회피).

생성 후 **실제** path + branch를 캡처 → Step 2. **기록 시 루트-상대 변환 필수:** `$ORIG_ROOT` 접두를 제거해 `.claude/worktrees/<slug>` 형태로 `--worktree`를 지정한다(절대 경로 기록 금지 — artifact prefix가 절대 경로가 되면 `episode.mjs` containment 실패).

#### §0.5 원본 root·base 캡처 + cwd 분리 + artifact 경로 규칙

- **ORIG_ROOT/BASE_REF 캡처(sibling git 경로 구성용):** 어떤 worktree 전환보다 먼저 `$ORIG_ROOT`(main repo root — git-common-dir 기반 파생; linked worktree에서 `--show-toplevel`은 project root가 아닌 연결된 worktree를 반환하므로 `cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd` 사용)와 `$BASE_REF`(의도한 base commit)를 캡처한다(위 캡처 블록 참조). 이 값이 sibling git 폴백의 절대경로·명시 base 인자가 된다.
- **cwd 분리:** maker/checker 파일 편집은 해당 worktree 안에서(분리) 수행한다. 커널 상태 호출은 `rootOf` 상향탐색이 cwd에서 root를 자동 해석(`--project-root` 불필요).
- **artifact 경로는 ORIG_ROOT-상대로 기록:** episode artifact를 `.claude/worktrees/<slug>/…` 형태(ORIG_ROOT 기준 상대)로 기록해야 `episode.mjs` containment(절대경로·`..` 금지)를 통과한다. worktree가 root 밑에 있어야 이 경로가 성립한다.
- **worktree 기록 경로 규율(FIX A/FIX N):** git worktree **생성**은 `$ORIG_ROOT/.claude/worktrees/<slug>` 절대경로로 하되(git은 절대경로 필요), `workstream new`에 **기록**하는 worktree 값은 반드시 루트-상대(root-relative) 형태 `.claude/worktrees/<slug>` (또는 `.worktrees/<slug>`)여야 한다. native EnterWorktree 경로도 동일 — 캡처한 절대 경로를 `$ORIG_ROOT` 기준으로 잘라 루트-상대로 변환한 뒤 기록. 이유: artifact 경로는 `<recorded-worktree>/<artifact>`로 도출되는데, 기록된 worktree가 절대 경로이면 artifact prefix도 절대 경로가 되어 `episode.mjs` containment(`절대경로·.. 금지`)를 통과하지 못한다. 커널 `findRoot`는 이 두 컨벤션 경로에서만 run을 상향탐색으로 해석한다.

#### Step 1.5 — create↔record 정합 (고아 방지)

**(a) 생성 직전 lease check 사전점검(read-only, `--project-root` 불필요):**

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" lease check --owner <run_id> --generation <n>
```

`ok:false`이면 생성하지 않고 fail-closed. (lease 유효성은 `lease check`로만 읽는다 — `state get`으로 lease 필드를 직접 읽으면 올바른 경로가 아니어서 동작하지 않는다.)

**(b) 멱등 재시도:** 대상 경로/브랜치가 이미 존재하면(이전 실패 잔재) Step 0 적격성 검증을 재적용해 재사용/감지한다.

**(c) record 실패 시 proposal-only 정리:** `workstream new` 실패 시 "worktree `<path>` 고아(orphan) — 정리(`ExitWorktree`/`git worktree remove`) 제안"을 surface(proposal-only, 자동 삭제 ❌).

**(d) reconcile audit(unattended 보강):** respawn/finish 시 `$ORIG_ROOT/.claude/worktrees/`(및 폴백 `.worktrees/`) 밑의 실제 디렉터리 중 active workstream에 매핑되지 않는 것을 고아 후보로 surface(proposal-only 정리 제안). root-밖 native 고아는 Step 1a①②가 처음부터 안 만드므로 audit 대상 아님.

**(e) 잔여 TOCTOU:** `lease check`와 `workstream new`의 `requireLease` 사이에 좁은 TOCTOU가 남는다. 고아는 gitignored `.claude/worktrees/` 밑이므로 repo를 오염시키지 않으며 (d) audit으로 발견된다.

**(f) 커널 2-phase는 명시적 후속:** 고아 원천 차단은 커널 2-phase 예약이 필요(v1 비-스코프 — 스코프 상향 시 TDD 동반).

#### Step 2 — 기록

캡처한 실제 값으로 기록한다(`--project-root` 불필요 — 커널 `rootOf`가 cwd 상향탐색으로 root를 자동 해석).

**`--worktree`는 반드시 루트-상대(root-relative) 경로**로 기록한다 — git이 `$ORIG_ROOT/.claude/worktrees/<slug>` 절대경로로 생성하더라도 기록 값은 `.claude/worktrees/<slug>` 형태다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" workstream new \
  --title "<workstream title>" \
  --branch "<actual-branch>" \
  --worktree ".claude/worktrees/<ws-slug>" \
  --owner <run_id> --generation 1
```

의존 관계가 있으면 `--depends-on '<["ws-id-1"]>'`도 추가.

#### 결정표

| 상황 | 동작 |
|------|------|
| 단일 run · 이미 격리 · 적격(clean·base·소유)+사용자 확인 | 현재 worktree 재사용 |
| 단일 run · 이미 격리 · 부적격/미확인 | 재사용 ❌ → git(Step 1b) 또는 human 중단 |
| 단일 run · 비격리 · native 있음 | `EnterWorktree` native 생성(Step 1a) |
| 단일 run · 비격리 · native 없음 | git 컨벤션 경로(Step 1b) |
| 다중 run · 모든 ws | 전부 git(Step 1b): 생성 `$ORIG_ROOT/.claude/worktrees/<slug>` — 기록 `.claude/worktrees/<slug>` (루트-상대, native 미사용) |
| gitignore 미설정 | proposal-only 제안 — 승인 시에만 진행, 자동 커밋 ❌ |
| native가 root 밖에 생성 | fail-closed STOP(needs-human) |

### 2-7. 첫 번째 Episode 생성

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" episode new \
  --plugin <maker_plugin> \
  --role maker \
  --kind implementation \
  --point design \
  --workstream <workstream_id> \
  --artifacts '[".claude/worktrees/<ws-slug>/expected-output.md"]' \
  --owner <run_id> --generation 1
```

`--artifacts`는 필수다 — maker `done` 전이는 비어있지 않은 `expected_artifacts`와 실제 파일 존재를 요구한다.
expected 경로는 `adapter resolve`의 `read.path`를 **변환(TRANSFORM)** 하여 도출한다: `adapter resolve`가 반환하는 `read.path`(예: `.deep-work/<task>/session-receipt.json`)는 UNPREFIXED 경로이므로 반드시 `<recorded-worktree-relative-to-root>/<adapter read.path>` 형태로 워크트리 접두(prefix)를 붙여야 한다(예: `.claude/worktrees/<ws-slug>/.deep-work/<task>/session-receipt.json`). 계획된 산출물도 동일하게 변환한다.

> **artifact 경로 규칙(기록된 worktree 경로(루트 기준 상대) 접두):** 최초 episode 생성(`episode new`)의 `--artifacts`(expected)와 완료 기록(`episode record`)의 `--artifacts`(submitted)는 반드시 동일한 project root 기준 상대 경로, **기록된 worktree 경로(루트 기준 상대) 접두** 형태로 지정해야 한다 — `<recorded-worktree-relative-to-root>/path/to/file` (예: `.claude/worktrees/<ws-slug>/path/to/file` 또는 `.worktrees/<ws-slug>/path/to/file`). 두 목록이 일치하지 않으면 커널의 coverage + existence 검사가 실패한다.

## 단계 3: 완료 메시지

run_id와 workstream 요약을 출력하고 다음 명령을 안내한다:

```
/deep-loop-continue
```

이후 각 tick마다 `/deep-loop-continue`를 호출해 루프를 진행한다.
