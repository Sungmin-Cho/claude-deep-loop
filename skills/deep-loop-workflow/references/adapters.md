# 어댑터(Adapter) 4-verb 수행 절차

프로토콜 어댑터(adapter)는 4-verb로 maker dispatch부터 checker 호출까지 전 과정을 정의한다.
**Execution LLM이** 직접 수행하며, 커널은 verb를 실행하지 않는다(§1.1 — 커널은 디스크립터를 반환하고 dispatch는 Execution LLM이 수행).

## 1. dispatch — Maker 스킬 Invoke

### 디스크립터 획득

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" adapter resolve --protocol <protocol> --task "<brief>" --tier <gate.tier_after>
```

`--tier`는 **반드시** `next-action`의 `gate.tier_after` 값을 전달해야 한다. 빠지면 guard가 `no-tier` no-op라 read-only run이 implementer를 dispatch할 수 있다.

반환 형태 (예시):
```
{
  dispatch.kind = "skill",
  dispatch.skill = "deep-work:deep-work-orchestrator",
  dispatch.then = "superpowers:subagent-driven-development",
  await.kind = "poll_file",
  await.path = ".deep-work/<task>/session-receipt.json",
  read.path = ".deep-work/<task>/session-receipt.json",
  checker_via = "review dispatch CLI (kernel derives checker episode)",
  guard.ok = true
}
```

### Guard 확인

- `guard.ok === false`이면 **dispatch 중단** → `await_human`(tier × protocol 모순) 보고.
- `guard.ok === true`이면 진행.

### Invoke (runtime별)

- `dispatch.kind === 'skill'`이면 descriptor의 qualified skill id와 args를 그대로 사용한다.
  - Claude: `Skill({ skill: descriptor.skill, args: descriptor.args })`
  - Codex: `$<descriptor.skill>` 뒤에 `descriptor.args`를 전달한다(qualified dollar invocation).
- **read-only tier**: `guard.planning_only === true`이면 `dispatch.skill`(planning)만 실행하고, `dispatch.then`(implementer)은 null이라 건너뛴다.
- `kind === 'inline'`이면 직접 도구 사용.

## 2. awaitResult — 완료 폴링

디스크립터의 `await.kind`가 `poll_file`이면 해당 경로를 `done_when` 조건 만족까지 폴링(LLM/드라이버 수행).

deep-work 예시: `.deep-work/<task>/session-receipt.json`의 `current_phase=idle`.

## 3. checker — Review Dispatch/Record

### Review Episode 생성

`--independent-subagent`는 현재 runtime에 fresh `code-reviewer` subagent를 만드는 cooperative capability가 **실제로 있을 때만** 전달한다. 그 capability가 없으면 이 flag를 전달하지 않는다(특히 Codex CLI 존재만으로 capability를 추정하지 않음). 이 assertion이 있을 때만 legacy `standalone` reviewer가 `agent` descriptor로 upgrade될 수 있다.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" review dispatch --point <review_point> --workstream <workstream_id> [--independent-subagent] --owner <run_id> --generation <n>
```

반환된 `checkerEpisodeId`와 checker 스킬 디스크립터를 저장한다.

### Checker descriptor routing

- `checker.kind === 'skill'`: `requires_independent_session === true`를 확인하고 **독립 fresh session**에서 실행한다. Claude는 `Skill({ skill: checker.skill, args: checker.args })`, Codex는 `$<checker.skill>`에 `checker.args`를 전달한다. 같은 maker task의 inline 실행은 proof가 아니다.
- `checker.kind === 'agent'`: 현재 runtime의 cooperative subagent 기능으로 **fresh `code-reviewer` subagent**를 spawn한다(`agent_role` 확인). 실행 plane에 그 기능이 실제 없으면 inline으로 대체하거나 proof를 만들지 말고 `needs-human`으로 보고한다.
- `checker.kind === 'blocked'`: `needs_human === true`와 reason을 `needs-human`으로 보고하고 dispatch를 중단한다. checker를 invoke하거나 APPROVE/CONCERN **proof를 기록하지 않는다**.

### Verdict 기록

APPROVE/CONCERN(통과)은 실재하는 리뷰 리포트 파일을 `--report`로 첨부해야 한다 — **리뷰 대상 workstream의 worktree(`.claude/worktrees/<slug>/…`) 하위 경로**여야 하며(무관한 root 파일 재사용 차단), 없거나 밖이면 `REVIEW_NO_EVIDENCE`. 커널이 리포트 경로+content hash를 event-log에 남긴다. REQUEST_CHANGES는 `--report` 없이 통과:
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" review record --episode <checkerEpisodeId> --workstream <workstream_id> --point <review_point> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --report <review-report-path> --owner <run_id> --generation <n>
```

커널이 verdict에서 터미널 상태·breaker·comprehension을 자동으로 파생한다.

## 4. readArtifacts — 산출물 Receipt 확인

`read.path`(path_template이 `<task>`로 채워진)와 `read.producer`로 receipt를 확인한다.
불일치 시 throw 금지 → `null` 반환 + 경고 출력.

## Expected Artifacts 도출

`episode new`의 `--artifacts` 인자에 전달할 expected 경로는:
- `adapter resolve`의 `read.path`(receipt 경로)
- 또는 protocol의 계획된 산출물 경로

항상 비어있지 않은 배열이어야 한다 — maker `done` 전이는 expected_artifacts 존재와 실제 파일을 요구한다.
