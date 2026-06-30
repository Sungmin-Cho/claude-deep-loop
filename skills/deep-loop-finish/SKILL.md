---
name: deep-loop-finish
description: "deep-loop finish — end-of-work: writes the final report, then transitions the run to completed (proof-gated) or stopped, and delegates to deep-memory / deep-wiki when installed. Triggered by '/deep-loop-finish', 'finish the loop', 'wrap up', 'end the run', '루프 종료', '작업 마무리', '런 종료', cross-platform Skill({ skill: \"deep-loop:deep-loop-finish\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **loop.json + handoff 파일이 source of truth** — 이전 대화 컨텍스트를 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.
> **artifacts 삭제 ❌** — 생성된 artifact 파일을 절대 삭제하거나 덮어쓰지 않는다.

## 개요

`/deep-loop-finish` — 작업 종료: final report 작성 → proof-gated `completed` 전이 (또는 `stopped`) → deep-memory / deep-wiki 위임.

## 단계 1: Final Report 작성

> [!IMPORTANT]
> cwd가 worktree 안일 때 상대 경로는 worktree 하위에 파일을 생성해 `finishRun`의 존재 확인을 실패시킨다. **반드시 `project.root`-앵커된 절대 경로를 사용한다.**

**먼저 project root를 상태에서 읽는다:**

```
PROJECT_ROOT=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field project.root)
```

`<project-root>/.deep-loop/runs/<run_id>/final-report.md`에 **절대 경로**로 final report를 작성한다:

```
Write({ file_path: "<project-root>/.deep-loop/runs/<run_id>/final-report.md", content: report })
```

여기서 `<project-root>`는 위에서 읽은 `PROJECT_ROOT` 값(절대 경로)으로 대체한다.

report 내용:
- **목표 & 결과**: 달성된 goal 요약
- **생성/변경 파일**: repo/파일 목록
- **사용 명령 & 원칙**: 핵심 CLI 호출 기록
- **Maker-Checker 흐름**: episode별 maker/checker 결과
- **Worktree 사용 현황**: 브랜치 & 병합 상태
  - `merged`/`abandoned` worktree 정리 제안: native `ExitWorktree` 우선, 없으면 `git worktree remove` — proposal-only(자동 삭제 ❌, 사람 승인)
  - reconcile audit: `$ORIG_ROOT/.claude/worktrees/`(및 `.worktrees/`) 밑에서 기록에 없는(어떤 workstream에도 매핑 안 된) 디렉터리를 고아 후보로 surface(proposal-only); root-밖 native worktree는 audit 대상 아님(Step 1a가 애초에 생성 안 함)
- **Heartbeat & 검증 결과**: budget 소비, comprehension debt
- **통합 여부**: PR/브랜치 병합 상태(proposal-only — 실제 push는 사람이)
- **남은 TODO**: 미완료 항목 목록
- **사용 예시**: 다음 run을 위한 명령 예시
- **다음 명령**: 이어서 할 작업 제안
- **사람 검증 체크리스트**: 사람이 확인해야 할 항목

## 단계 2: Proof 확인

`completed` 전이 전에 proof를 확인한다:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field episodes
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field workstreams
```

proof 요건:
- 모든 episode settled (`done`/`approved`)
- `active_workstreams` 비어있음
- 모든 workstream 터미널 상태 (`ready`/`merged`/`abandoned`)
- final-report.md 존재
- 모든 done maker episode에 독립 reviewer 승인

## 단계 3: Run 종료

### completed (proof 충족 시)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" finish --status completed --report final-report.md --proof '{}' --owner <run_id> --generation <n>
```

`FINISH_PROOF_UNMET` 에러 시 무엇이 빠졌는지 보고하고 사람이 결정하도록 한다.

### stopped (사람 명시 중단)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" finish --status stopped --proof '{"human_reason":"사람이 명시적으로 중단 요청"}' --owner <run_id> --generation <n>
```

## 단계 4: Deep-memory 위임 (감지 시)

deep-memory 플러그인이 설치된 경우:

```javascript
Skill({ skill: "deep-memory:deep-memory-harvest" })
```

핵심 결정 사항을 `deep-memory-save`로 저장한다.
**deep-loop이 `~/.deep-memory`를 직접 쓰지 않는다** — deep-memory 자체 스킬에 위임한다.

## 단계 5: Deep-wiki 위임 (감지 시)

deep-wiki 플러그인이 설치된 경우:

```javascript
Skill({ skill: "deep-wiki:wiki-ingest", args: "<project-root>/.deep-loop/runs/<run_id>/final-report.md" })
```

`<project-root>`는 단계 1에서 읽은 `PROJECT_ROOT` 절대 경로 값이다.

미감지 시 스킵하고 명시적으로 로그에 기록한다.
