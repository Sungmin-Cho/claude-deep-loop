# Handoff — Codex App native task continuation 구현·출시

> **작성일:** 2026-07-13  
> **대상:** Codex App의 native goal로 이 기능을 처음부터 끝까지 구현·출시할 새 작업 세션  
> **상태:** 사용자와 product design 합의 완료. 구현 코드는 아직 0줄이다.  
> **source of truth:** 이 문서 + 현재 repo + `git log` + `CLAUDE.md` + 실제 host tool contract. 이전 대화 컨텍스트를 가정하지 않는다.

---

## 0. Native goal에 그대로 넣을 시작 계약

Codex App에서 새 native goal을 만들 때 아래 목표만 넣는다. 별도 token budget은 지정하지 않는다.

```text
Implement, verify, review, and ship the Codex App native task-continuation feature for deep-loop exactly as specified in /Users/sungmin/Dev/claude-plugins/deep-loop/docs/handoff/2026-07-13-codex-app-native-task-continuation-goal-handoff.md. Treat that handoff as the operating contract and read it, CLAUDE.md, the current repo, and git log before acting. Follow the superpowers protocol; create and work only in a new isolated worktree; keep Claude Code, Claude Desktop, Codex CLI, Codex App, POSIX, and native Windows behavior fail-closed and backward compatible. At every quality gate, obtain a naturally converged deep-review-loop verdict from Opus only at xhigh effort, then independently verify the evidence before advancing. Never treat max-reached, degraded review, missing effort evidence, or green tests alone as gate passage. Keep push, PR creation, merge, post-merge deep-suite sync/push, and deletion/cleanup behind their separately required human approvals. Do not mark the native goal complete until the deep-loop PR is merged, the merged SHA is re-pinned in both deep-suite marketplace manifests and pushed with approval, release cleanup is complete with approval, and deep-wiki:wiki-ingest has succeeded with durable evidence.
```

### Native goal 체크포인트

1. worktree + baseline 증거
2. host-surface research + 승인된 design spec
3. bite-sized TDD implementation plan
4. kernel/state-machine 구현
5. Execution-plane App transport 구현
6. 전체 회귀 + 네 host surface smoke/evidence
7. release-ready branch + PR
8. merged deep-loop SHA + deep-suite re-pin/push
9. 승인된 branch/worktree 정리
10. `deep-wiki:wiki-ingest` 완료

Native goal의 `complete`는 체크포인트 10까지 모두 충족된 뒤에만 허용한다. 사람 승인을 기다리는 동안 완료로 표시하지 않는다. 한 승인 대기 자체는 실패가 아니며, 실제로 진행 불가능한 상태를 과장해 blocked로 만들지 않는다.

---

## 1. 달성할 결과

### 1.1 제품 결과

deep-loop이 Codex App에서 handoff를 만들 때 현재의 수동 새 task 절차 대신 App-native task 도구를 안전하게 사용할 수 있어야 한다.

- 현재 calling task의 cwd와 run의 canonical project root가 같고 그 root가 Codex App의 저장 project path와 정확히 같으면 `create_thread`의 local project target을 사용한다. 이 경로는 대화 이력을 상속하지 않는 fresh task다.
- 현재 calling task의 cwd가 run root 내부 `.claude/worktrees/<slug>` 또는 `.worktrees/<slug>`이며 active workstream의 recorded worktree와 정확히 결합돼 있으면 `fork_thread(same-directory)`를 사용한다. 이 경로는 정확한 worktree/cwd를 보존하지만 완료된 대화 이력을 상속하므로 **fresh task라고 부르지 않는다**.
- fork가 성공하면 활성 turn은 복사되지 않으므로 `send_message_to_thread`로 self-contained handoff prompt를 전달한다.
- child는 parent가 durable launch confirmation을 커밋한 뒤에만 lease를 인수한다.
- 도구·경로·동의·fence·launch confirmation·readiness 중 어느 하나라도 불명확하면 기존 `preserve-pause + manual resume`으로 fail-closed한다.
- Claude Code, Claude Desktop Code, Codex CLI의 기존 transport는 그대로 유지한다. Codex App 경로가 다른 runtime을 대신하거나 교차 fallback하지 않는다.
- App-native create/fork는 attended Execution plane에서만 실행한다. PreCompact hook과 unattended Node driver는 host task tool을 호출할 수 없으므로 기존 emit/preserve 안전망을 유지한다.

### 1.2 최초 실행 동의 UX

사용자가 opt-in flag를 외워서 넣게 하지 않는다. Codex App에서 한 run을 처음 시작할 때, App task capability가 양성 감지된 경우 `init-run` 전에 정확히 한 번 묻는다.

권장 문구:

> 이 run에서 handoff 시 별도 Codex task를 자동 생성하도록 허용할까요? 생성된 task는 App sidebar에 표시되며 사용자가 소유합니다. 승인하면 이 run의 이후 handoff에서는 다시 묻지 않으며, 언제든 수동 모드로 철회할 수 있습니다.

- **승인:** 해당 run에만 `human-confirmed` 자동 continuation 권한을 기록한다.
- **거절:** `manual`을 기록하고 기존 manual resume을 사용한다.
- **질문 도구 부재·응답 불명확·취소:** 거절과 같은 `manual`이다.
- **새 run:** 이전 선택을 상속하지 않고 다시 묻는다.
- **비-App surface:** 이 질문을 하지 않는다.
- **철회:** 전용 lease-fenced kernel CLI를 통해 `manual`로만 내릴 수 있다. 자동 재승격은 금지한다.

이 문서를 승인한 것은 **기능 구현 승인**이다. 이후 각 실제 deep-loop run에서 App task를 자동 생성해도 된다는 영구 동의가 아니다.

### 1.3 Definition of Done

다음 항목이 전부 참이어야 한다.

- 사용자 동의가 없는 App run은 task를 만들지 않는다.
- 승인된 exact-root App run은 `create_thread(local)`로 이어지고 reserved child가 lease를 획득한다.
- 승인된 internal-worktree App run은 `fork_thread(same-directory)` + follow-up prompt로 이어지고 동일 worktree에서 reserved child가 lease를 획득한다.
- fork 경로의 inherited-history 성격이 state, handoff, docs에서 정직하게 표시된다.
- partially available App tools, project mismatch, ambiguous project match, tool failure, message failure, parent crash, confirmation failure, child timeout은 중복 task 생성 없이 fail-closed한다.
- App 외 모든 기존 transport와 runtime trust boundary가 회귀하지 않는다.
- POSIX와 native Windows의 pure/CLI tests 및 repository CI가 통과한다.
- Claude Code, Claude Desktop, Codex CLI, Codex App에 대한 실제 또는 명시적으로 승인된 대체 증거가 남는다. 증거가 없으면 “완벽 호환”을 주장하지 않는다.
- `npm run preflight`가 release candidate와 merge 후 main에서 모두 통과한다.
- deep-loop release metadata가 일치하고 PR이 merge된다.
- deep-suite의 두 marketplace manifest가 merged deep-loop main SHA로 re-pin되고 deep-suite preflight 후 push된다.
- branch/worktree 정리가 별도 승인 후 완료된다.
- 최종 `deep-wiki:wiki-ingest`가 성공하고 생성/갱신된 wiki 증거를 기록한다.

---

## 2. 시작점과 현재 사실

이 문서 작성 시점의 baseline:

- repo: `/Users/sungmin/Dev/claude-plugins/deep-loop`
- remote: `https://github.com/Sungmin-Cho/claude-deep-loop.git`
- branch/SHA: `main` / `c38a96137f8f4f0099c35e893860930e8ee4cf73`
- version: `1.8.2`
- Node: `v26.0.0` 관측, repo 요구사항은 Node `>=20`
- `npm run preflight`: PASS, 2026-07-13 baseline에서 1463 tests pass
- deep-suite 두 manifest의 deep-loop pin: 둘 다 baseline SHA `c38a96137f8f4f0099c35e893860930e8ee4cf73`
- main worktree에는 사용자 소유 untracked `.deep-memory/`가 있다. 읽기·수정·삭제·stage하지 않는다.
- repo `.gitignore`는 새 `docs/` 파일을 기본 ignore한다. 이 bootstrap handoff도 현재 checkout에서는 의도적으로 untracked이므로 native goal은 위 absolute path로 먼저 읽고, Gate 0에서 exact copy를 implementation worktree에 materialize한 뒤 branch의 docs commit에 `git add -f`로 포함해야 한다. 원본 checkout에서 직접 commit하지 않는다.

중요한 drift:

- project guide가 언급한 `docs/superpowers/specs/2026-07-10-codex-windows-compatibility-design.md`는 이 baseline의 `main`과 `git log --all`에 없다. 존재한다고 가정하거나 가짜 내용을 복원하지 않는다.
- 이 기능의 새 design spec은 아래에 지정한 새 경로로 작성한다.

현재 코드가 보장하는 사실:

- `autonomy.session_runtime`은 `claude|codex`만 구분하며 host surface는 구분하지 않는다.
- Codex App descriptor는 의도적으로 manual/fail-closed이고 `codex-transport-not-activated`를 반환한다.
- README는 “no automated app-native task creation”과 “App smoke pending external evidence”를 명시한다.
- handoff/respawn은 이미 reserved → emitted → spawned → acquired lease 상태기계, idempotency key, bounded readiness, rollback/preserve 실패 경로를 가진다.
- kernel은 host skill/tool을 함수처럼 호출하지 않으며, Execution plane이 descriptor를 해석해 host capability를 호출한다.

현재 Codex App host tool contract:

- `create_thread`
  - 사용자가 새/background task를 명시적으로 요청한 경우에만 사용한다.
  - project-scoped 생성 전 `list_projects`가 필요하다.
  - project target은 `local` 또는 새 App-managed `worktree` 환경을 선택한다.
  - model/thinking은 사용자가 특정 값을 명시적으로 요청하지 않았다면 생략한다.
- `fork_thread`
  - `same-directory` fork는 즉시 child thread id를 반환한다.
  - 완료된 대화 이력만 복사하며 active turn과 unfinished response는 복사하지 않는다.
  - 일이 계속되어야 하면 child에 후속 prompt를 보내야 한다.
- `send_message_to_thread`
  - 기존 thread에 background follow-up을 전달한다.
  - model/thinking을 생략하면 기존 thread 설정을 유지한다.

Tool contract는 제품 외부 API다. 구현 시 실제 노출된 설명을 다시 읽고 drift를 design spec에 기록한다. 현재 문서의 snapshot만 믿고 오래된 schema를 하드코딩하지 않는다.

---

## 3. 승인된 설계

### 3.1 runtime과 host surface를 분리한다

`runtime`과 `surface`는 다른 축이다.

| runtime | surface | 의미 |
|---|---|---|
| `claude` | `claude-code` | Claude Code CLI/TUI host |
| `claude` | `claude-desktop` | Claude Desktop의 Code surface |
| `codex` | `codex-cli` | Codex CLI task |
| `codex` | `codex-app` | Codex App task tools가 노출된 task |

host surface는 run 전체에 고정하지 않는다. 한 run이 manual resume을 통해 다른 surface로 이동할 수 있으므로 **session-chain의 각 session에 관측된 surface와 근거를 기록**한다. immutable runtime fence는 그대로 유지한다.

감지 원칙:

1. Execution plane만 현재 host context와 callable tool capability를 관측한다.
2. kernel은 관측값을 allowlist 검증하고 기록할 뿐 host env나 App tool registry를 직접 읽지 않는다.
3. Codex App surface는 host context 또는 App-provenance tool의 양성 증거로만 판정한다. 이름 문자열이나 홈 디렉터리 존재만으로 App이라고 추론하지 않는다.
4. surface 판정과 continuation capability 판정을 분리한다. App surface여도 `{list_projects, create_thread}` 또는 `{fork_thread, send_message_to_thread}` 중 현재 root에 필요한 완전한 set이 없으면 manual이다.
5. Codex runtime이며 App surface 양성 증거가 없으면 `codex-cli`다. partial App tool이 보이면 임의로 CLI로 강등하지 말고 App/manual로 기록한다.
6. Claude Desktop과 Claude Code의 구분은 실제 host에서 관측 가능한 양성 signal을 research gate에서 확정한다. 설치된 Desktop handler의 존재만으로 “현재 세션이 Desktop”이라고 판정하면 안 된다.
7. exact Claude surface를 신뢰성 있게 관측할 수 없다면 임의 heuristic을 만들지 않는다. design gate를 통과시키지 말고 사용자에게 증거 한계를 보고한다.

권장 durable shape는 design review에서 정확히 고정하되 다음 의미를 보존해야 한다.

- run-level consent: `manual|auto`, `human-confirmed|default-manual`, confirmed timestamp
- per-session surface: allowlisted surface, source, bounded capability facts
- per-child App attempt: transport, attempt id, confirmation phase, inherited-context 여부, bounded failure reason

generic `state patch`로 위 필드를 바꾸는 것은 금지한다.

### 3.2 transport 선택은 정확한 경로 증거로 결정한다

| 조건 | 선택 | 이유 |
|---|---|---|
| runtime=`codex`, surface=`codex-app`, consent=`auto`, calling cwd=run canonical root, `list_projects`의 단 하나의 local project canonical path=run canonical root | `create_thread` + `environment: local` | 진짜 fresh task이며 cwd가 정확함 |
| runtime=`codex`, surface=`codex-app`, consent=`auto`, calling cwd가 run root 내부 convention worktree이고 active workstream의 recorded path와 정확히 일치 | `fork_thread` + `same-directory` | outer run의 `.deep-loop` state와 gitignored worktree cwd를 함께 보존 |
| project match가 0개/복수, root가 project 밖, calling task cwd가 run root와 다름, 필요한 App tool 일부 부재 | manual preserve | 잘못된 checkout에서 재개하는 것보다 안전함 |
| consent=`manual` 또는 surface가 App 아님 | 기존 transport | 기존 동작 보존 |

금지:

- App `worktree` target으로 새 worktree를 만들고 gitignored `.deep-loop` state가 따라올 것이라 가정하지 않는다.
- `create_thread(local)`을 만든 뒤 prompt만으로 다른 worktree에 이동시키는 우회는 사용하지 않는다.
- root 비교에 raw string prefix만 사용하지 않는다. canonical path, platform case semantics, convention containment를 기존 workspace/root helper와 정합시킨다.
- worktree cwd에서 `findRoot`가 outer run root를 반환하는 현재 계약을 보존한다. `project_root`와 `execution_cwd/worktree`를 하나의 값으로 합치지 않는다.
- fork를 fresh context라고 광고하지 않는다.

### 3.3 App-native launch는 prepare → external call → confirm → acquire 순서다

App tool은 kernel 밖의 외부 실행이므로 기존 respawn의 CAS/idempotency/readiness 의미를 재사용하되, kernel이 App tool을 호출하지 않게 한다.

```text
parent owns active lease
  -> handoff emit: reserve child, lease=releasing, phase=emitted
  -> app-task prepare: gates + consent + exact descriptor check, CAS phase=spawned
  -> Execution plane:
       exact root  -> create_thread(local, initial self-contained prompt)
       worktree    -> fork_thread(same-directory), then send_message_to_thread(prompt)
  -> app-task confirm: exact attempt/thread receipt committed under parent fence
  -> child polls read-only app-task status until confirmed
  -> child lease acquire: exact reserved child + runtime + surface + attempt
  -> parent bounded readiness observes acquired child
```

필수 상태기계 속성:

- `prepare`는 gate 순서 `budget → breaker → max_sessions → wallclock → auto_handoff`를 보존한다.
- `prepare`는 동일 handoff key/attempt에 idempotent하고, 다른 attempt의 중복 spawn을 거부한다.
- `prepare` 이후 external call을 재시도해 task를 중복 생성하지 않는다.
- App attempt로 claim된 `spawned` handoff를 기존 visible/headless respawn 또는 headless driver가 다시 claim하거나 성공으로 오해하지 않는다. transport binding이 모든 re-entry 분기보다 먼저 적용돼야 한다.
- child prompt는 launch confirmation 전 lease acquire를 시도하지 않는다.
- `confirm`은 parent owner/generation fence를 mutate와 같은 lock 안에서 재검사한다.
- 동일 thread receipt 재확인은 no-op, 다른 thread id로의 confirm은 conflict다.
- thread id는 opaque data다. path, shell, command, skill id로 해석하지 않는다. control character와 과도한 길이를 거부한다.
- child acquire는 reserved child, generation, runtime, surface, attempt가 모두 일치해야 한다.
- parent는 기존 bounded readiness로 정확한 child acquisition을 확인한다. tool success나 thread id 반환만으로 성공을 선언하지 않는다.

실패 의미:

| 실패 시점 | 상태 처리 |
|---|---|
| prepare 전 capability/root/consent/gate 실패 | task 호출 없음; gate failure는 기존 rollback, capability/root/manual은 preserve |
| create/fork 호출 실패 | 단일 anchored 실패 전이; child invalidation/parent pause. 중복 재호출 금지 |
| fork 성공 후 follow-up 전송 실패 | 생성된 thread id를 bounded audit evidence로 남기고 fail-closed pause; archive/delete는 제안만 |
| external 성공 후 confirm 실패/parent crash | child는 confirm을 기다리다 bounded stop; 다음 tick은 re-spawn하지 않고 `app-launch-unconfirmed` preserve |
| confirm 후 child timeout | 예약 child와 receipt를 보존한 human-recovery pause; 늦은 exact child acquire 정책은 design에서 기존 timeout semantics와 정합시킬 것 |
| wrong child/runtime/surface/attempt acquire | exit 3 fence, mutation 없음 |

event와 state 변경은 각 kernel 전이마다 하나의 `appendAnchored` transaction이어야 한다. 외부 tool 호출과 파일 transaction을 원자화할 수 있다고 주장하지 않는다. 대신 prepare/confirm protocol로 crash window를 명시하고 복구 가능하게 만든다.

### 3.4 self-contained child prompt

create의 initial prompt와 fork의 follow-up prompt는 같은 builder에서 생성하며 다음만 포함한다.

- canonical project root
- exact execution cwd와 active-workstream worktree binding(create면 root, fork면 convention worktree)
- logical run id
- reserved child run id
- expected generation
- immutable runtime=`codex`
- asserted surface=`codex-app`
- App attempt id
- exact handoff relative path
- `$deep-loop:deep-loop-resume`
- “launch confirmation을 read-only로 확인한 뒤 lease를 acquire하라”는 순서
- “이전 대화보다 handoff와 loop state가 우선”이라는 source-of-truth 규칙
- fork일 때 `context_mode=inherited-completed-history`, create일 때 `context_mode=fresh`

prompt에 secret, tool output 전문, arbitrary user text, raw shell program을 넣지 않는다. root/run/relative path validation은 기존 descriptor 안전 규칙과 동등 이상이어야 한다.

### 3.5 model/effort 처리

- `create_thread`에는 사용자가 해당 model/thinking을 명시적으로 요청한 증거가 없으면 두 필드를 생략한다. current parent profile만으로 새 task model을 강제하지 않는다.
- `fork_thread`와 `send_message_to_thread`에도 model/thinking override를 넣지 않는다.
- 새 task가 lease를 획득한 뒤 현재 세션 profile을 기존 `session-profile set` 경로로 self-refresh한다.
- tool이 지원하는 model 목록을 repo schema에 복사하지 않는다.
- model/effort drift는 문서와 state에 정직하게 기록하며 다른 runtime으로 fallback하지 않는다.

### 3.6 human approval 경계

run 최초 질문의 `auto` 동의는 그 run의 App-native continuation만 허용한다. 다음은 포함하지 않는다.

- plugin local-install 변경
- branch push
- PR 생성
- merge
- release publish
- deep-suite marketplace re-pin/sync/push
- thread archive/delete
- local/remote branch 삭제
- worktree 삭제

위 행동은 `CLAUDE.md`대로 각각 필요한 시점에 정확한 대상과 변경을 보여주고 별도 승인을 받는다.

---

## 4. 절대 불변식

1. **2-plane:** skills는 state를 직접 쓰지 않는다. App tools는 Execution plane만 호출하고 kernel은 descriptor/state transition만 담당한다.
2. **lease fence:** 모든 mutating CLI는 `--owner --generation`을 요구하고 in-lock에서 재검사한다. exit 3=fence, 2=usage, 1=invalid 계약을 보존한다.
3. **anchored transaction:** event + state는 하나의 `appendAnchored` transaction이다. raw `appendEvent` 또는 직접 `loop.json` write 금지.
4. **proof terminal:** task/thread id 반환은 child acquisition proof가 아니다. terminal state는 기존 checker/workstream proof를 그대로 요구한다.
5. **no double spawn:** spawned/confirmed/unconfirmed attempt를 보고 외부 App task를 다시 만들지 않는다.
6. **fail-closed autonomy:** unattended는 headless/measured 경로를 유지한다. App-native task 생성은 attended Codex App capability에서만 가능하다.
7. **runtime isolation:** Codex App 실패를 Claude process, Codex CLI process, private URL/deeplink로 대체하지 않는다.
8. **path containment:** App project match와 worktree 선택은 canonical root 및 project-internal convention 경로만 허용한다.
9. **external actions:** push/PR/merge/publish/delete/deep-suite sync는 proposal-only + 별도 사람 승인이다.
10. **write containment:** kernel write는 `<project-root>/.deep-loop/` 아래다. 외부 wiki write는 마지막에 deep-wiki skill로 위임한다.
11. **determinism:** time/platform/path/tool result는 주입한다. test에서 실제 thread를 만들지 않는다.
12. **zero deps:** Node >=20, ESM, 외부 npm dependency 추가 금지.
13. **backward compatibility:** legacy run에서 새 필드 부재는 기존 manual behavior로 안전하게 해석한다.
14. **honest freshness:** create만 fresh, fork는 inherited completed history다.
15. **hook honesty:** PreCompact/hook/cron Node 경로는 App task를 생성했다고 주장하지 않는다. attended skill이 다시 실행되지 않으면 manual preserve가 최종 안전망이다.

---

## 5. Superpowers 실행 프로토콜

### Gate 0 — goal bootstrap, worktree, baseline

1. 이 문서와 `CLAUDE.md`를 완독한다.
2. `git status --short --branch`, `git rev-parse HEAD`, `git log`, manifest version을 확인한다.
3. 사용자 소유 변경을 보존한다. baseline main의 `.deep-memory/`는 건드리지 않는다.
4. `superpowers:using-git-worktrees`를 사용해 새 worktree를 만든다.
   - 권장 branch: `codex/codex-app-native-task-continuation`
   - 권장 path: `<canonical-root>/.claude/worktrees/codex-app-native-task-continuation`
   - native worktree capability가 있으면 우선하고, 없을 때만 안전한 git fallback을 쓴다.
   - 분기 base는 작업 시작 시점의 최신 승인된 `origin/main`. 이 문서의 baseline과 달라졌으면 diff를 조사하고 문서를 무음 수정하지 않는다.
5. original checkout의 absolute bootstrap handoff를 읽어 implementation worktree의 동일 relative path에 exact content로 materialize한다. 두 파일을 비교하고, branch의 첫 docs commit에서 ignored handoff를 명시적으로 `git add -f`한다. 이 단계도 worktree 안에서 수행하며 original checkout의 index/branch를 바꾸지 않는다.
6. 새 worktree에서 `npm run preflight`를 실행한다.
7. baseline failure면 구현하지 말고 원인을 분리한다.

Gate 0 산출물은 baseline SHA/version/status/preflight를 evidence log에 기록한 것이다.

### Gate 1 — research + design

`superpowers:brainstorming`을 사용한다. 코드 작성 금지.

작성 파일:

- `docs/superpowers/specs/2026-07-13-codex-app-native-task-continuation-design.md`
- `docs/handoff/2026-07-13-codex-app-native-task-continuation-evidence.md`

research에서 반드시 검증할 것:

- 현재 `create_thread`, `fork_thread`, `list_projects`, `send_message_to_thread` tool contract
- actual tool return shape와 failure shape
- current-thread cwd/worktree identity를 양성 증거로 얻는 방법
- Claude Code와 Claude Desktop current surface를 구분하는 실제 양성 signal
- Codex CLI와 Codex App capability 차이
- active turn 미복사와 fork inherited history의 실제 동작
- current state-machine의 CAS/readiness/recovery 재사용 지점
- project path comparison의 POSIX/Windows semantics
- App local plugin install + restart를 통한 release-candidate smoke 방법
- milestone/turn-cap attended handoff와 PreCompact emit-only 경계

research 결과를 design으로 정리해 사용자에게 제시하고 승인을 받는다. 이 문서와 달라질 필요가 있으면 trade-off를 별도로 명시한다. 무음 범위 확장 금지.

**Gate 1 통과:** design spec이 아래 §6의 Opus-only/xhigh review에서 자연 수렴하고 main agent가 사실·코드와 대조해 다음 단계가 안전하다고 판단한다.

### Gate 2 — implementation plan

`superpowers:writing-plans`를 사용해 다음 파일을 작성한다.

- `docs/superpowers/plans/2026-07-13-codex-app-native-task-continuation.md`

plan은 아래 §7의 작업을 실제 line/file 기준으로 세분화한다. 각 task는 다음 순서를 가진다.

1. failing test 작성
2. 옳은 이유로 RED 확인
3. 최소 구현
4. targeted test GREEN
5. 관련 회귀 test GREEN
6. diff 검토
7. focused commit

placeholder pseudo-code, 존재하지 않는 helper, 검증하지 않은 CLI flag를 넣지 않는다.

**Gate 2 통과:** plan이 Opus-only/xhigh review에서 자연 수렴하고 main agent가 spec/현재 코드와 대조한다.

### Gate 3 — kernel/state-machine implementation

plan 순서대로 `superpowers:test-driven-development`와 `superpowers:subagent-driven-development` 또는 승인된 동등 실행을 사용한다. subagent를 쓰면 모든 prompt에 exact worktree cwd와 operating contract를 넣고 main branch를 수정하지 못하게 한다.

kernel/schema/CLI slice를 끝낼 때마다 targeted tests + review gate를 통과한다. 여러 slice를 한 번에 쌓아 마지막에만 리뷰하지 않는다.

### Gate 4 — Execution-plane App transport

skills가 capability를 감지하고 host tool을 호출하되 state는 kernel CLI로만 바꾸는지 검증한다. static skill boundary tests와 mocked descriptor/state-machine integration tests가 필수다.

### Gate 5 — cross-surface regression + real smoke

자동 tests, CI, 실제 host smoke를 evidence log에 모은다. local plugin 설치나 App restart가 필요하면 변경 대상을 먼저 보여주고 승인을 받는다.

### Gate 6 — release candidate

README/README.ko/manifest/version/tests를 lockstep 갱신한다. baseline이 그대로면 target은 기능 추가 minor인 `1.9.0`이다. 작업 시작 전 main version이 달라졌으면 충돌 없는 next minor를 제안하고 승인 없이 추측하지 않는다.

`npm run preflight`, final whole-branch review, diff/status audit를 통과해야 push 제안을 할 수 있다.

### Gate 7 — deep-loop push, PR, merge

각 외부 행동 전에 별도 승인을 요청한다.

1. branch push 승인
2. PR 생성 승인
3. CI/리뷰 확인 후 merge 승인

merge 후 `origin/main`의 실제 40-char SHA를 회수하고 merge된 main에서 preflight를 다시 실행한다. PR URL, merge SHA, preflight 결과를 evidence에 기록한다.

### Gate 8 — deep-suite re-pin and push

별도 post-merge sync 승인을 받기 전에는 deep-suite를 수정하지 않는다.

대상 repo:

- `/Users/sungmin/Dev/claude-plugins/deep-suite`

필수 변경:

- `.claude-plugin/marketplace.json`의 `deep-loop.source.sha`
- `.agents/plugins/marketplace.json`의 `deep-loop.source.sha`

두 값을 Gate 7의 merged deep-loop main SHA와 정확히 같게 만든다. 다른 plugin entry나 generated README marker를 수동 수정하지 않는다.

deep-suite에서도 isolated branch/worktree를 선호하고, preflight 후 Opus-only/xhigh review를 통과한다. 그 뒤 정확한 diff/commit/target branch를 보여주고 push 승인을 받는다. branch protection 때문에 marketplace main 반영에 PR/merge가 필요하면 별도 승인을 받아 끝까지 반영한다. 단순히 feature branch를 push한 것을 “re-pin 완료”라고 부르지 않는다.

### Gate 9 — cleanup + wiki

deep-loop merge와 deep-suite pin 반영이 모두 확인된 뒤에만 cleanup을 제안한다.

- local implementation worktree 삭제
- merged local branch 삭제
- 필요 시 remote branch 삭제
- deep-suite sync worktree/branch 삭제

삭제 대상 전체를 나열하고 별도 승인을 받은 뒤 수행한다. 사용자 소유 untracked/dirty 파일이 있으면 삭제하지 않는다.

모든 release/cleanup이 끝난 뒤 `$deep-wiki:wiki-ingest`를 실행한다. ingest source에는 최소한 다음을 포함한다.

- 이 handoff
- 승인된 design spec과 plan
- gate evidence log와 review report 경로
- deep-loop PR URL/merge SHA/release version
- cross-surface smoke 결과와 알려진 제한
- deep-suite pin commit/SHA/preflight
- cleanup 결과

wiki ingest 전에 release가 끝났다고 가정하지 않는다. ingest 결과 page id/path/title을 evidence log와 native goal final report에 기록한다.

---

## 6. 모든 quality gate의 deep-review 계약

사용자 요구는 **Opus only, xhigh**다.

호출 규칙:

- Claude host: `/deep-review-loop --no-codex --no-agy --max=5 --contract`
- Codex host 표기: `$deep-review:deep-review-loop --no-codex --no-agy --max=5 --contract`
- 실제 `SLICE-NNN` contract가 이미 존재하는 구현 slice에서만 `--contract SLICE-NNN`을 사용한다. arbitrary file path나 임의의 gate-contract placeholder를 인자로 넘기지 않는다.
- `--ultracode`, `--codex`, `--codex-only`, `--no-opus`를 사용하지 않는다.
- `--max=5` 도달은 성공이 아니다. 자연 수렴만 성공이다.

### xhigh 증거 주의

현재 설치된 deep-review 1.12.3의 non-Claude bridge helper는 `--model`은 받지만 `--effort` option을 노출하지 않는다. 반면 현재 Claude CLI는 `--effort`를 지원한다. 따라서 Codex에서 bridge를 평범하게 호출한 것만으로 **xhigh를 증명했다고 간주하면 안 된다**.

각 gate는 다음 중 하나의 검증 가능한 방식으로 실행한다.

1. `claude --model opus --effort xhigh`로 시작한 Claude Code session에서 `deep-review-loop`를 실행하고 session/launcher evidence를 남긴다.
2. 이미 Opus/xhigh임이 host context로 검증된 Claude session에서 실행한다.

둘 다 불가능하면 gate를 멈추고 사용자에게 보고한다. deep-loop 작업 범위를 넘어 deep-review plugin을 무음 수정하지 않는다.

### gate pass 조건

모두 충족해야 한다.

- report의 실제 reviewer가 Opus 하나뿐이다.
- effort=xhigh의 실행 증거가 있다.
- verdict=`APPROVE`.
- Critical/Red=0.
- Warning/Yellow=0.
- loop termination=`converged`이며 `max_reached`, timeout, reviewer failure, degraded가 아니다.
- Info finding은 main agent가 코드/계약과 대조해 disposition을 기록했다.
- review 뒤 대상 artifact가 바뀌었다면 이전 receipt를 재사용하지 않고 다시 리뷰한다.
- main agent가 review에 맹목적으로 복종하지 않고 tests, code, spec을 직접 확인해 다음 단계 진행 판단을 기록한다.

각 gate receipt를 `docs/handoff/2026-07-13-codex-app-native-task-continuation-evidence.md`에 다음 필드로 남긴다.

```text
gate:
artifact/scope:
base/head or content hash:
invocation:
reviewer actual:
model/effort evidence:
verdict:
red/yellow/info:
termination:
report path:
verification commands:
main-agent judgment:
```

human approval gate는 deep-review로 대체되지 않는다. 반대로 사람 승인이 review 실패를 덮어쓰지도 않는다.

---

## 7. Implementation plan이 반드시 포함할 TDD slices

아래 파일 목록은 현재 baseline에 근거한 예상 변경 surface다. Gate 1 design이 더 작은 경계를 증명하면 줄일 수 있지만, 누락을 무음 처리하면 안 된다.

### Slice A — host surface model과 schema

예상 파일:

- Create: `scripts/lib/host-surface.mjs`
- Modify: `scripts/lib/runtime.mjs`
- Modify: `scripts/lib/initrun.mjs`
- Modify: `scripts/lib/lease.mjs`
- Modify: `scripts/lib/schema.mjs`
- Modify: `schemas/loop-run.schema.json`
- Create: `tests/host-surface.test.mjs`
- Modify: `tests/initrun.test.mjs`
- Modify: `tests/runtime.test.mjs`
- Modify: `tests/schema.test.mjs`

필수 tests:

- runtime/surface 조합 allowlist
- per-session surface 기록과 legacy absence
- wrong runtime/surface fence
- App capability가 없을 때 codex-cli/manual
- ambiguous/unknown signal fail-closed
- Claude Desktop current-surface signal을 host evidence 없이 추론하지 않음

### Slice B — first-run consent와 revoke

예상 파일:

- Create: `scripts/lib/app-task-continuation.mjs`
- Modify: `scripts/deep-loop.mjs`
- Modify: `scripts/lib/initrun.mjs`
- Modify: `scripts/lib/schema.mjs`
- Modify: `schemas/loop-run.schema.json`
- Create: `tests/app-task-continuation.test.mjs`
- Modify: `tests/orch-cli.test.mjs`
- Modify: `tests/skills.test.mjs`

필수 tests:

- App surface에서 init 전 질문 descriptor/branch 존재
- 승인/거절/취소 의미
- 새 run이 consent를 상속하지 않음
- generic patch 금지
- auto→manual revoke만 허용, lease-fenced, anchored, idempotent
- manual→auto setter 금지. 다시 자동화를 원하면 새 run을 시작해 최초 질문에서 승인
- non-App에서 질문 없음

### Slice C — App attempt state machine

예상 파일:

- Modify: `scripts/lib/app-task-continuation.mjs`
- Modify: `scripts/lib/handoff.mjs`
- Modify: `scripts/lib/respawn.mjs` 또는 reviewed shared failure helper
- Modify: `scripts/lib/lease.mjs`
- Modify: `scripts/deep-loop.mjs`
- Modify: `scripts/lib/schema.mjs`
- Modify: `schemas/loop-run.schema.json`
- Modify: `tests/app-task-continuation.test.mjs`
- Modify: `tests/handoff.test.mjs`
- Modify: `tests/respawn.test.mjs`
- Modify: `tests/terminal-cli.test.mjs`

필수 tests:

- prepare gate order와 in-lock parent fence
- emitted→spawned CAS 한 번만
- exact idempotency key/attempt binding
- confirm exact retry no-op / conflicting thread id reject
- child waits for confirmation
- acquire exact child/runtime/surface/attempt only
- create/fork/message/confirm/readiness 각 실패의 rollback vs preserve 의미
- parent crash after CAS에서 no re-spawn
- late child, wrong child, concurrent parent/child race
- terminal/paused/released state가 강등·부활하지 않음
- event+state one transaction

### Slice D — descriptor와 Execution-plane tool routing

예상 파일:

- Modify: `scripts/lib/runtime-descriptor.mjs`
- Modify: `skills/deep-loop/SKILL.md`
- Modify: `skills/deep-loop-continue/SKILL.md`
- Modify: `skills/deep-loop-handoff/SKILL.md`
- Modify: `skills/deep-loop-resume/SKILL.md`
- Modify: `skills/deep-loop-workflow/references/handoff-respawn.md`
- Modify: `skills/deep-loop-workflow/references/adapters.md` if capability routing changes
- Modify: `tests/runtime-descriptor.test.mjs`
- Modify: `tests/skills.test.mjs`

필수 tests:

- exact project match → create descriptor
- internal worktree + exact calling cwd → same-directory fork descriptor
- fork follow-up required
- active turn에 의존하지 않는 self-contained prompt
- create=fresh / fork=inherited marker
- model/thinking omission by default
- partial tool capability/manual fallback
- App-bound spawned attempt를 기존 visible/headless respawn이 claim하지 않음
- PreCompact/hook/headless driver가 App tool을 호출하지 않고 emit/preserve 계약을 유지
- no private URL/deeplink, no Claude process, no bare Codex executable fallback
- skills have no direct durable-state writes and every mutating CLI line is fenced

### Slice E — integration, docs, release metadata

예상 파일:

- Create: `tests/codex-app-task-continuation-integration.test.mjs`
- Modify: `tests/codex-isolation-integration.test.mjs`
- Modify: `tests/scaffold.test.mjs`
- Modify: `tests/docs.test.mjs`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `CLAUDE.md` only if architecture contract truly changes
- Modify: `.claude-plugin/plugin.json`
- Modify: `.codex-plugin/plugin.json`
- Modify: `package.json`
- Update: `integration/deep-suite.patch.md` only if its instructions are stale after the implementation

필수 tests:

- full create happy path with fake host response + lease acquisition
- full fork/message happy path + inherited marker
- first-run denial → no tool action
- ambiguous project/partial tools/tool error → preserve/manual
- duplicate tick → no duplicate external action descriptor
- legacy Claude/Codex CLI descriptors byte/semantic compatibility where promised
- native Windows path/case fixtures
- release metadata exact version parity
- README manual-only/App-smoke-pending 문구를 실제 증거에 맞게 갱신

### Commit discipline

- 각 commit은 한 slice 또는 한 명확한 fix만 담는다.
- 매 commit 전에 targeted tests와 `git diff --check`를 실행한다.
- gate-critical slice 뒤에는 full preflight를 실행한다.
- reviewer fix는 finding과 test를 함께 커밋한다.
- user-owned 파일을 stage하지 않는다.
- release bump는 기능 증거와 final review 뒤 별도 commit으로 한다.
- repo가 요구하는 Co-Authored-By trailer를 현재 `CLAUDE.md`에서 다시 확인해 정확히 사용한다.

---

## 8. 검증 매트릭스

### 8.1 자동 검증

최소 명령:

```text
node --test tests/host-surface.test.mjs tests/app-task-continuation.test.mjs
node --test tests/runtime-descriptor.test.mjs tests/handoff.test.mjs tests/respawn.test.mjs tests/lease.test.mjs
node --test tests/skills.test.mjs tests/schema.test.mjs tests/orch-cli.test.mjs tests/terminal-cli.test.mjs
node --test tests/codex-app-task-continuation-integration.test.mjs tests/codex-isolation-integration.test.mjs
npm run preflight
git diff --check
```

파일명이 Gate 2 plan에서 정당하게 달라지면 실제 파일명으로 갱신한다. 존재하지 않는 test command를 성공 증거로 기록하지 않는다.

CI에서는 현재 repository의 OS/Node matrix가 실제로 실행됐는지 확인한다. workflow 파일 존재만으로 Windows evidence를 주장하지 않는다.

### 8.2 host surface matrix

| Surface | 반드시 확인할 것 |
|---|---|
| Claude Code | 기존 interactive/visible/headless/handoff/resume 회귀 없음; App 질문 없음 |
| Claude Desktop Code | 현재 surface 양성 감지; 기존 verified desktop transport 회귀 없음; Codex App tool 호출 없음 |
| Codex CLI | runtime=`codex`, surface=`codex-cli`; 기존 trusted visible/measured headless 경로; App 질문/호출 없음 |
| Codex App exact project root | 첫 질문 승인/거절; 승인 시 create_thread local; fresh marker; confirm 후 reserved child acquire |
| Codex App internal worktree | 첫 질문 승인; same-directory fork; follow-up prompt; inherited marker; exact worktree child acquire |

추가 lifecycle 확인:

- attended milestone/turn-cap handoff는 승인된 App transport를 실행할 수 있다.
- PreCompact가 먼저 handoff를 emit한 경우 다음 attended skill tick이 그 in-flight handoff를 안전하게 인수해 App launch를 준비할 수 있는지 검증한다.
- attended tick이 다시 오지 않으면 PreCompact만으로 App task가 생겼다고 주장하지 않으며 manual preserve 안내가 남는다.

### 8.3 실제 Codex App smoke

release candidate의 coupled local install을 App이 실제로 로드하게 하고 App을 restart한 뒤 새 task에서 수행한다. 사용자의 현재 개인 plugin 설치를 덮어쓰거나 marketplace를 바꾸기 전 정확한 diff/복구 계획을 보여주고 승인을 받는다.

smoke A — create:

1. saved project root와 canonical root가 같은 task에서 새 test run 시작
2. 최초 질문에 승인
3. handoff trigger
4. 정확히 하나의 새 fresh task 생성 확인
5. child가 confirmation 뒤 reserved lease acquire
6. parent가 bounded readiness success 기록

smoke B — fork:

1. project-internal implementation worktree task에서 새 test run 시작
2. 최초 질문에 승인
3. handoff trigger
4. same-directory fork 하나와 follow-up 전달 확인
5. inherited-completed-history marker 확인
6. child cwd/root와 lease acquire 확인

smoke C — decline/manual:

1. 새 run에서 최초 질문 거절
2. handoff가 App task를 만들지 않음
3. preserve-pause와 manual `$deep-loop:deep-loop-resume` 안내 확인

실제 smoke thread의 archive/delete는 자동 수행하지 않는다. smoke가 끝나면 대상 id를 나열하고 cleanup 승인을 받는다.

### 8.4 호환성 증거 한계

어떤 surface나 OS에 실제 접근할 수 없으면:

- 자동 fixture/CI가 커버하는 범위를 정확히 기록한다.
- 실제 smoke를 했다고 주장하지 않는다.
- “완벽 호환” 완료 조건을 충족하지 못했음을 사용자에게 알리고, 대체 증거 수용 여부를 묻는다.
- 사용자 승인 없이 DoD를 낮추지 않는다.

---

## 9. Release와 deep-suite sync 체크리스트

### deep-loop release-ready

- [ ] design/plan/implementation/final review receipts 모두 natural convergence
- [ ] Opus-only/xhigh 증거 모두 존재
- [ ] targeted tests green
- [ ] `npm run preflight` green
- [ ] 실제 App smoke evidence
- [ ] README.md/README.ko.md support matrix와 제한이 사실과 일치
- [ ] `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `package.json`, scaffold tests version 일치
- [ ] `git diff --check`
- [ ] user-owned/unrelated changes 미포함
- [ ] push 승인
- [ ] PR 생성 승인
- [ ] CI green
- [ ] merge 승인
- [ ] merged main SHA 회수 + merged-main preflight

### deep-suite re-pin

- [ ] separate post-merge sync 승인
- [ ] deep-suite clean/isolated worktree
- [ ] 두 manifest의 deep-loop SHA가 merged deep-loop SHA와 정확히 동일
- [ ] generated docs marker 수동 수정 없음
- [ ] deep-suite `npm run preflight` green
- [ ] deep-suite pin diff Opus-only/xhigh review natural convergence
- [ ] commit/target branch/push 승인
- [ ] push 완료 및 main 반영 확인

### cleanup + knowledge

- [ ] cleanup 대상 목록 제시
- [ ] deletion 승인
- [ ] deep-loop/deep-suite worktree와 merged branch 정리
- [ ] smoke thread archive/delete는 별도 승인 시에만
- [ ] `$deep-wiki:wiki-ingest` 실행
- [ ] wiki page evidence 기록
- [ ] native goal complete

---

## 10. 범위 밖

- Codex App private deep link/URL 발명
- App tool을 Node control plane에서 직접 호출
- Codex CLI에서 App tool이 있다고 추측
- App-managed 새 worktree로 gitignored run state 복사
- fork history를 삭제하거나 fresh라고 가장
- user consent의 global persistence
- per-handoff 승인 반복
- thread 자동 archive/delete
- deep-review plugin 자체 수정
- unrelated deep-loop refactor/style churn
- deep-suite의 다른 plugin entry 변경
- deep-memory update

---

## 11. 새 작업 세션의 첫 행동

1. native goal을 §0 문구로 시작한다.
2. 이 문서와 `CLAUDE.md`를 완독한다.
3. current main/remote/version/tool contract가 §2와 달라졌는지 확인한다.
4. 새 isolated worktree를 만든다.
5. baseline preflight를 실행한다.
6. `superpowers:brainstorming`으로 Gate 1 research/design을 수행한다.
7. Opus-only/xhigh deep-review-loop를 자연 수렴시킨다.
8. main agent가 직접 evidence를 검증한 뒤에만 plan으로 간다.

한 줄 목표:

> Codex App에서는 최초 run 질문으로 받은 한정 동의 아래 exact-root는 fresh create, internal worktree는 same-directory fork로 안전하게 handoff하고, 모든 불확실성은 기존 manual preserve로 닫으면서 네 host surface와 기존 2-plane/lease/proof/release 불변식을 끝까지 보존해 출시한다.
