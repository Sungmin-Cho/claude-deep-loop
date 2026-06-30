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
  "require_human_ack": false
}
```

### 2-4. Workstream 분해

큰 goal이면 N개 workstream(각각 하나의 PR)을 제안하고 사람 확인을 받는다("[이대로/조정/단일 PR로]"). 작은 작업이면 1 workstream 자동 결정.

### 2-5. Run 생성 (`init-run`)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" init-run \
  --goal "<goal>" \
  --protocol <protocol> \
  --recipe <recipe_id> \
  --review '<review_json>'
```

`--recipe`는 `recipe-match`가 반환한 recipe **id 문자열**(예: `robust-implementation`)이다 — JSON이 아님.
`run_id`를 받아 저장한다. 이후 모든 mutating CLI는 `--owner <run_id> --generation 1`.

### 2-6. Workstream 생성

각 `workstream new` 호출 **직전**, 아래 절차로 worktree를 먼저 생성(eager)한 뒤 실제 path/branch를 기록한다.

**어떤 worktree 전환보다 먼저 두 값을 캡처한다:**
```bash
ORIG_ROOT=$(git rev-parse --show-toplevel)   # 격리 진입 전 원본 repo root
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

생성 후 **실제** path + branch를 캡처 → Step 2.

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

생성 후 **실제** path + branch를 캡처 → Step 2.

#### §0.5 원본 root·base 캡처 + cwd 분리 + artifact 경로 규칙

- **ORIG_ROOT/BASE_REF 캡처(sibling git 경로 구성용):** 어떤 worktree 전환보다 먼저 `$ORIG_ROOT`(격리 진입 전 `git rev-parse --show-toplevel`)와 `$BASE_REF`(의도한 base commit)를 캡처한다(위 캡처 블록 참조). 이 값이 sibling git 폴백의 절대경로·명시 base 인자가 된다.
- **cwd 분리:** maker/checker 파일 편집은 해당 worktree 안에서(분리) 수행한다. 커널 상태 호출은 `rootOf` 상향탐색이 cwd에서 root를 자동 해석(`--project-root` 불필요).
- **artifact 경로는 ORIG_ROOT-상대로 기록:** episode artifact를 `.claude/worktrees/<slug>/…` 형태(ORIG_ROOT 기준 상대)로 기록해야 `episode.mjs` containment(절대경로·`..` 금지)를 통과한다. worktree가 root 밑에 있어야 이 경로가 성립한다.
- **worktree 기록 경로 규율(FIX A):** `workstream new`에 기록하는 worktree 경로는 반드시 `$ORIG_ROOT/.claude/worktrees/<slug>` (또는 `.worktrees/<slug>`) 형태여야 한다. 커널 `findRoot`는 이 두 컨벤션 경로에서만 run을 상향탐색으로 해석한다. 비컨벤션 경로를 기록하면 worktree 안에서 실행한 커널 호출이 run을 찾지 못해 root 해석이 실패하는 discipline violation이다.

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

캡처한 실제 값으로 기록한다(`--project-root` 불필요 — 커널 `rootOf`가 cwd 상향탐색으로 root를 자동 해석):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" workstream new \
  --title "<workstream title>" \
  --branch "<actual-branch>" \
  --worktree "<actual-path>" \
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
| 다중 run · 모든 ws | 전부 git `$ORIG_ROOT/.claude/worktrees/<slug>` `-b worktree-<slug>` (Step 1b; native 미사용) |
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
  --artifacts '["path/to/expected-output.md"]' \
  --owner <run_id> --generation 1
```

`--artifacts`는 필수다 — maker `done` 전이는 비어있지 않은 `expected_artifacts`와 실제 파일 존재를 요구한다.
expected 경로는 `adapter resolve`의 `read.path` 또는 계획된 산출물에서 도출한다.

## 단계 3: 완료 메시지

run_id와 workstream 요약을 출력하고 다음 명령을 안내한다:

```
/deep-loop-continue
```

이후 각 tick마다 `/deep-loop-continue`를 호출해 루프를 진행한다.
