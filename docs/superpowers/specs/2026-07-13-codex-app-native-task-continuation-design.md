# 설계 — Codex App native task continuation

작성일: 2026-07-13
운영 계약: `docs/handoff/2026-07-13-codex-app-native-task-continuation-goal-handoff.md`
상태: 사용자 자율 판단 위임으로 brainstorming 설계 선택 승인; Opus/xhigh 수렴 리뷰 전
기준: `main@c38a96137f8f4f0099c35e893860930e8ee4cf73`, deep-loop `1.8.2`

> source of truth: 이 문서 + 운영 계약 + 현재 저장소 + `git log`. 이전 대화 컨텍스트를 가정하지 말라.

---

## 0. 목표와 확정 결정

Codex App에서 실행 중인 attended deep-loop run이 세션 경계에 도달하면, 현재 App의 공개 task 도구만 사용해 다음 task를 만들고 durable handoff를 이어간다.

- canonical project root에서 실행 중이면 exact local project를 골라 `create_thread`로 **fresh task**를 만든다.
- recorded active workstream의 exact conventional worktree에서 실행 중이면 `fork_thread(same-directory)` 후 `send_message_to_thread`로 **completed history를 상속한 task**를 만든다.
- 다음 child는 durable launch confirmation 뒤에만 lease를 획득한다.
- 표면, capability, 동의, 경로, project match, receipt가 하나라도 불명확하면 자동 task 생성을 하지 않고 preserve-pause/manual로 닫는다.
- kernel은 App 도구를 호출하지 않는다. execution-plane skill이 kernel descriptor를 읽어 App 도구를 호출하고 receipt만 kernel에 확인한다.
- PreCompact hook과 unattended/headless driver는 App 도구를 절대 호출하지 않는다.

### 선택한 접근

기존 handoff lease에 `codex-app` transport와 attempt를 결합하고, App 전용 상태 전이를 별도 모듈과 CLI로 제공한다.

1. host surface와 per-run consent를 bounded state로 기록한다.
2. App 전용 prepare가 기존 reserve/emit 골격을 재사용하면서 **emit 트랜잭션부터** transport/attempt를 결합한다.
3. respawn gate를 통과한 뒤 `emitted → spawned`를 외부 호출 전에 durable CAS하고, actionable descriptor를 딱 한 번 반환한다.
4. execution plane이 공개 App 도구를 호출한다.
5. exact receipt를 confirm한 뒤 child의 App 전용 acquire만 허용한다.
6. parent는 bounded readiness를 기다리고, timeout은 reservation을 보존해 늦은 exact child를 허용한다.

### 제외한 접근

- `respawn()` 안에서 App 도구 호출: kernel이 skill/host 함수를 호출하게 되어 2-plane 경계를 깨고, `fork + message`의 부분 성공을 안전하게 표현하지 못한다.
- skill-only 상태기계: prepare 직후 crash나 응답 유실 시 이중 task 생성 방지가 불가능하다.
- 기존 generic acquire/respawn에 선택적 플래그만 추가: 현재 reserved child는 `emitted`에서도 acquire할 수 있고 legacy respawn/headless가 모든 `spawned` handoff를 자기 것으로 취급하므로 confirmation 우회가 생긴다.
- App private URL/SQLite/internal API: 공개 host contract가 아니며 portability와 감사 가능성을 깨므로 금지한다.

---

## 1. 신뢰 경계와 불변식

1. **2-plane:** kernel은 descriptor/state만 만든다. `list_projects`, `create_thread`, `fork_thread`, `send_message_to_thread` 호출은 skill만 수행한다.
2. **fence:** 모든 mutating App CLI는 `--owner --generation`을 요구하고 lock 안에서 다시 확인한다. 잘못된 child/runtime/surface/attempt도 exit 3, 무변경이다.
3. **anchored:** initial consent/surface는 validated genesis state에 포함하고, 그 뒤 revoke, emit binding, prepare, confirm, fail/pause, acquire는 event와 state를 하나의 `appendAnchored` 트랜잭션으로 커밋한다.
4. **at-most-once launch:** prepare가 `spawned`를 먼저 커밋한 뒤 descriptor를 한 번만 반환한다. 같은 attempt 재진입은 `do_not_call: true`; 외부 호출 여부가 불명확하면 자동 재시도하지 않는다.
5. **confirmation-first:** App-bound handoff는 generic `acquireLease`로 획득할 수 없다. durable `confirmed` receipt를 검증하는 App 전용 acquire만 성공한다.
6. **transport isolation:** legacy respawn/headless/driver는 `handoff_transport === 'codex-app'`를 phase 처리보다 먼저 거부한다. App 경로도 legacy transport를 거부한다.
7. **exact paths:** raw prefix 비교를 하지 않는다. App host가 제공한 calling-task cwd, immutable session record, kernel의 actual `process.cwd()`, 선택한 root/worktree가 모두 같은 filesystem directory여야 한다.
8. **opaque IDs:** App thread/project ID 형식을 추측하지 않는다. bounded opaque value로만 검증·저장하고 path, shell command/argv, model/thinking 값에 사용하지 않는다.
   Raw thread ID는 실행 직후의 필수 host task-tool call/receipt, shell interpolation이 없는 structured stdin 전달, root-contained state receipt field에만 둔다. Raw project ID는 `list_projects` host 결과와 bounded prepare stdin, 최초 `do_not_call=false` prepared action의 local-project target, 그 직후의 직접 `create_thread` call, root-contained state field에만 둔다. 앞서 열거한 ephemeral host-tool/structured-stdin/최초 action 지점 외에는 두 ID를 event, 이후 kernel stdout·stderr/log/report, CLI state-read/skill transcript에 다시 출력하지 않고 attempt와 digest/masked form만 기록한다.
9. **no model override:** App 호출에서 `model`과 `thinking`은 사용자가 그 task에 대해 별도로 명시하지 않는 한 생략한다. run의 model/effort를 App tool 인자로 자동 변환하지 않는다.
10. **proposal-only release:** push/PR/merge/publish/delete/deep-suite sync는 기존 별도 인간 승인 경계를 유지한다.
11. **terminal one-way:** completed/stopped run은 App 전이로 paused/running으로 강등·부활하지 않는다. fence를 먼저 판정한 뒤 terminal을 거부한다.
12. **containment/zero deps:** runtime kernel write는 기존 예외를 제외하고 `<project-root>/.deep-loop/` 아래이며, Node 20+/ESM/외부 npm dependency 0을 유지한다.

---

## 2. Host surface와 capability

### 2.1 데이터 모델

각 session entry에 다음을 한 번만 기록한다. run-level `runtime`은 기존대로 immutable이다.

```json
{
  "host_surface": {
    "kind": "codex-app",
    "source": "codex-app-tool-provenance",
    "capabilities": [
      "list-projects",
      "create-thread-local",
      "fork-thread-same-directory",
      "send-message-to-thread",
      "structured-process-stdin"
    ],
    "structured_stdin_mode": "pty-raw-noecho",
    "host_task_cwd": "/canonical/app-task/cwd",
    "host_task_cwd_source": "app-task-context",
    "kernel_cwd_at_observation": "/same/canonical/cwd",
    "observed_at": "2026-07-13T00:00:00.000Z"
  }
}
```

`kind` enum:

- `claude-code`
- `claude-desktop`
- `codex-cli`
- `codex-app`

관측이 불가능하거나 신호가 충돌하면 `host_surface=null`로 남기고 manual로 처리한다. 허용 enum에 추측성 `unknown` 값을 추가하지 않는다.

Runtime correlation:

- `runtime=claude`: `claude-code|claude-desktop|null`만 허용
- `runtime=codex`: `codex-cli|codex-app|null`만 허용

Bounded source correlation:

| surface | allowed `source` | allowed `host_task_cwd_source` |
|---|---|---|
| `claude-code` | `claude-cli-entrypoint` | `direct-cli-cwd` |
| `claude-desktop` | `claude-desktop-local-agent` | `desktop-code-context` |
| `codex-cli` | `codex-cli-host` | `direct-cli-cwd` |
| `codex-app` | `codex-app-host-context` or `codex-app-tool-provenance` | `app-task-context` |

Kernel은 이 allowlist/correlation을 검증한다. source와 host task cwd/source는 execution-plane observation input이고, `kernel_cwd_at_observation`은 CLI가 `process.cwd()`에서 직접 계산한다. incompatible pair, arbitrary source string, source 없는 non-null surface는 거부한다. `structured_stdin_mode`는 `pipe-open-noecho|pty-raw-noecho|null`만 허용하고, `structured-process-stdin` capability가 있으면 non-null, 없으면 null이어야 한다. Auto-capable App observation은 host task cwd/source가 required다. Positive surface지만 safe structured input이 없는 manual observation은 cwd/source를 둘 다 null로 둘 수 있고, 그 session에서는 auto route가 영구 불가하다. null surface는 source/capabilities/mode/cwd-source도 null/empty이며 manual이다.

Child session은 emit 시 `host_surface=null`, `expected_host_surface='codex-app'`로 예약되고, exact acquire에서 한 번 `codex-app`으로 고정된다. 이미 관측된 session surface의 변경은 거부한다.

### 2.2 판정 규칙

- `codex-app`: execution plane이 현재 host의 first-party App provenance와 callable App contract를 양성 관측했을 때만. `CODEX_THREAD_ID`, 설치 경로, 프로세스 이름, 단순 tool-name 문자열은 durable 권위가 아니다.
- partial App capabilities: surface는 `codex-app`이지만 continuation은 manual. `codex-cli`로 강등하지 않는다.
- `codex-cli`: runtime이 Codex이고 App host provenance를 양성 관측하지 못한 non-App invocation일 때. lazy resolution이 가능한 host는 resolution을 먼저 시도한다.
- `claude-desktop`: installed Desktop host가 local agent를 시작할 때 명시적으로 주입하는 `CLAUDE_CODE_ENTRYPOINT=local-agent` + `CLAUDE_CODE_IS_COWORK=1`과 execution-plane Desktop host assertion이 모두 일치할 때 기록한다. 설치된 Claude Code 2.1.207도 `local-agent`를 별도 local-agent product entrypoint로 분류한다.
- `claude-code`: installed Claude Code 2.1.207의 direct CLI 초기화가 entrypoint 부재를 `cli`로 materialize하고, execution-plane direct Code host assertion과 일치할 때 기록한다.
- conflict/partial Claude signal: surface null/manual. Desktop handler 설치 여부만으로는 Desktop current surface가 아니다.

Claude surface는 App 자동화 권한을 부여하지 않는다. 따라서 spoof 가능한 environment marker 단독으로 자동 외부 action을 열지 않으며, ambiguity는 모두 manual이다.

### 2.3 capability contract

자동 continuation의 최소 capability set:

- root/create: `list-projects` + `create-thread-local` + `structured-process-stdin`
- worktree/fork: `fork-thread-same-directory` + `send-message-to-thread` + `structured-process-stdin`

`request_user_input`, thread environment variables, browser/일반 terminal availability는 App provenance로 사용하지 않는다. `structured-process-stdin`은 Codex host가 static long-running process handle과 shell interpolation 없는 structured stdin write를 둘 다 callable하게 제공하고, 아래 live no-echo handshake probe까지 통과했을 때만 별도 route capability다. Host tool timeout/no-return은 capability 존재와 분리된 invocation failure다.

Structured stdin adapter protocol:

1. Execution plane은 host의 actual process/write tools로 read-only `host-surface stdin-probe --stdin-mode <allowlisted> --probe-stdin`을 시작한다. `pipe-open-noecho`는 non-PTY open pipe, `pty-raw-noecho`는 PTY를 요구한다. 비밀이 아닌 probe에서만 이 고정 순서로 mode를 시도할 수 있다.
2. Kernel reader는 data handler와 non-configurable `APP_STDIN_READ_TIMEOUT_MS=30_000`을 먼저 설치한다. PTY mode에서는 `process.stdin.isTTY`, callable `setRawMode`, `setRawMode(true)` 성공을 모두 확인한 **뒤에만** non-secret exact `DEEP_LOOP_STDIN_READY:v1:<purpose>:<binding>:<mode>` token을 출력한다. Pipe mode도 stdin이 아직 readable/open이고 handler가 준비된 뒤에만 같은 token을 출력한다. Binding은 `init-run preflight`이면 process-local random nonce, full `init-run`이면 proposed attempt+previous-current+expected request/observation digest, post-init prepare/observe면 owner+generation, confirm/fail/acquire면 exact handoff attempt를 포함한다.
3. Execution plane은 동일 process handle의 exact READY token을 관측하기 전에는 어떤 host-derived value도 write하지 않는다. Probe에서는 고정 비밀이 아닌 bounded canary 한 줄만 보내고, final output의 digest/length success와 전체 tool output에 canary echo가 0개임을 확인한다.
4. Capability를 기록한 뒤에도 full `init-run`/observe/prepare/confirm/fail/acquire **각 process invocation**이 자기 purpose와 attempt/run binding의 READY를 다시 출력해야 한다. Execution plane은 exact READY 뒤 한 번만 bounded line을 쓰며, reader는 완료/timeout/exit에서 raw mode를 복구한다. `init-run prepare`는 host raw value를 받지 않는 read-only argv/query라 stdin handshake가 없고, `init-run preflight`는 별도 nonce binding을 사용한다.
5. READY 부재·불일치, pipe closed, raw-mode 실패, early write, write failure/no-return, input echo, timeout은 capability 부재 또는 invocation failure다. Raw 값으로 다른 mode를 시험하거나 here-doc/env/temp/argv fallback하지 않는다. Consent 질문 전 live probe 실패만 enum-only manual로 분기한다. Full init을 시작한 뒤의 실패는 §6.0 exact attempt reconciliation/abort, observe 실패는 surface 미관측 manual, prepared 이후 실패는 preserve/sweep/manual recovery로 닫는다.

현재 App adapter의 read-only canary probe는 plain pipe session이 생성돼도 stdin write가 closed로 실패하고, 기본 PTY는 입력을 echo하며, Node가 `setRawMode(true)`를 성공시킨 뒤 READY를 낸 PTY만 echo 0으로 성공함을 확인했다. 따라서 현재 양성 mode는 `pty-raw-noecho`이며, 이 관측은 구현 후 동일 kernel probe로 다시 검증한다. 다른 host/OS는 선언만으로 mode를 추측하지 않는다.

### 2.4 session surface materialization

- 최초 session surface/capability/host-provided task cwd는 init 전에 execution plane이 live stdin probe로 관측하고, read-only `init-run preflight`의 READY 뒤 같은 observation을 전달해 kernel process cwd와 same-directory임을 확인한다. 동의 뒤 full `init-run`은 preflight observation digest와 exact request digest를 모두 재계산한 뒤에만 같은 observation을 validated genesis state에 넣는다.
- Probe가 실패해도 positive surface/callable task-tool enums 자체를 버리거나 `codex-cli`로 강등하지 않는다. 이 경우 raw/path data 없는 enum-only static init form으로 allowlisted surface/source/capabilities와 `manual/default-manual`만 기록하고 host task cwd/source/mode는 null로 둔다. Enum 값은 host 문자열을 그대로 삽입하지 않고 skill이 known literal allowlist로 투영하며, 이 session은 observe-once이므로 나중에 auto로 승격되지 않는다.
- manual/legacy resume으로 새 owner가 lease를 획득한 뒤 skill은 live stdin probe를 먼저 시도한다. 성공하면 static argv의 전용 `host-surface observe --owner --generation --runtime <allowlisted> --stdin-mode <allowlisted> --observation-stdin`을 호출해 READY 뒤 bounded stdin JSON으로 surface/source/capabilities/mode/host task cwd/cwd-source를 전달한다. 실패하면 별도 enum-only `host-surface observe --manual-enums ...` form으로 allowlisted surface/source/capability literals만 기록한다. 두 form 모두 kernel actual `process.cwd()`를 직접 기록하며, full form은 전달 cwd와 filesystem identity가 같은지도 검증한다. 이 명령은 current owner session entry가 null일 때만 anchored하게 materialize하고 exact same observation은 no-op, 변경/partial→full upgrade는 fence다.
- observation 전 crash/불명확성은 session surface null/manual이다. App 자동화는 recorded parent session이 exact `codex-app`이고 필요한 capabilities가 이미 완전할 때만 가능하다.
- App 전용 acquire는 confirmation 검증과 child surface materialization을 같은 transaction에서 수행한다.
- generic `state patch`나 prepare 입력으로 surface/capability를 승격할 수 없다.

---

## 3. Per-run consent

`autonomy.app_task_continuation`:

```json
{
  "mode": "manual",
  "authority": "default-manual",
  "confirmed_at": null,
  "revoked_at": null
}
```

- legacy/absent field는 정확히 `manual/default-manual`로 해석한다.
- Init 전 순서는 **positive App provenance/task-tool observation → live no-echo stdin probe → read-only `init-run preflight`가 same-file host/kernel cwd를 포함한 non-consent genesis guards + 최소 한 complete App route capability set 확인 → consent 질문 → request-bound prepare → full init**으로 고정한다. Preflight는 exact observation digest를 반환하고, full init은 같은 observation과 `--expected-preflight-digest`를 받아 다시 계산·비교한다. 이 조건이 모두 양성인 첫 auto-capable Codex App run만 정확히 한 번 묻는다: 이 run에서 deep-loop가 세션 경계마다 App의 native task를 자동 생성해도 되는가.
- partial task tools, probe/READY/no-echo/preflight 실패, cwd/source mismatch, complete route set 부재는 질문 호출 0회이며 enum-only `manual/default-manual`로 init한다. 질문 뒤 명시적 승인까지 받았다면 full init 실패를 enum-only/manual로 silent downgrade하지 않고 §6.0 exact init reconciliation으로만 처리한다.
- 명시적 동의만 `auto/human-confirmed`를 init state에 기록한다. 거절, 취소, 무응답, 모호한 답, 질문 도구 부재는 manual이다.
- 이 명시적 답이 App host contract가 요구하는 새/background task 생성 요청의 authority다. 동의 문구에는 root create와 worktree fork/message를 모두 구체적으로 적는다.
- Genesis builder/schema는 `auto/human-confirmed`를 runtime=`codex`, surface=`codex-app`, allowed positive surface/cwd source pair, same-file host/kernel cwd, live-probed structured stdin mode, 그리고 최소 하나의 complete App route capability set이 모두 있을 때만 허용한다. wrong runtime/surface/source/cwd/capability/mode 조합은 silent manual coercion이 아니라 init 거부다.
- 일반 구현 승인, `/goal`, unattended 지시를 미래 run의 per-run App consent로 전용하지 않는다.
- 동의는 새 run에 상속하지 않는다.
- `app-task revoke`는 fenced/anchored하게 `auto → manual`만 허용한다. revoke 뒤 자동 재승격은 없고, 같은 run에서 다시 auto로 바꾸는 CLI도 제공하지 않는다.
- revoke 판정은 owner/generation/runtime fence와 terminal guard가 먼저다. 그 뒤 `mode=manual`, `revoked_at` non-null인 exact same revoke retry는 event/write 없는 `already-revoked`; 처음부터 `manual/default-manual`인 run은 `not-auto` 무변경이다. 첫 revoke만 timestamp와 attempt abandonment를 anchored commit한다.
- revoke는 terminal을 되살리지 않는 narrow consent/lease intent로 active 또는 parent-owned releasing/paused state에서 실행 가능하다. owner/generation을 먼저 판정하고 terminal은 항상 거부한다.
- 이미 emitted/prepared/confirmed됐지만 아직 acquire되지 않은 attempt가 있으면 revoke의 **같은 anchored transaction**에서 child phase를 `abandoned`, failure code를 `consent-revoked`로 만들고 reservation을 human-preserve pause한다. confirm/acquire도 fresh consent와 non-abandoned phase를 in-lock에서 재검사하므로 이후 인수는 불가능하다.
- descriptor 반환과 revoke가 경합하면 외부 task가 만들어질 가능성은 남지만, receipt confirm과 lease acquire는 차단된다. 자동 archive/delete는 하지 않고 사람이 정리한다. 이미 child가 acquire해 parent fence가 바뀌었으면 stale parent revoke는 exit 3이며, current owner의 revoke는 이후 handoff만 manual로 만든다.

질문 문구는 user-facing skill 문서에 단일 출처로 두고, 범위(현재 run), 빈도(세션 경계), 사용 도구(create/fork/message), 취소 방법을 명시한다.

---

## 4. 경로와 transport 선택

Kernel은 `rootOf()`로 접은 outer root, App host가 execution plane에 제공한 **calling task cwd**, shell/kernel의 actual `process.cwd()`를 서로 다른 값으로 취급한다. `fork_thread(same-directory)`가 보존하는 authority는 shell workdir가 아니라 calling task cwd다. 따라서 parent의 production `init-run preflight`/full init, observe, handoff prepare는 다음 directory authority가 해당 단계에서 모두 같지 않으면 manual/fence다. Genesis preflight/full init에는 아직 recorded session이 없으므로 host task cwd와 kernel cwd를 먼저 exact 비교하고, full init이 그 값을 immutable recorded session cwd로 만든다.

```text
recorded session.host_task_cwd
current host-context task cwd claim
kernel process.cwd()
```

그 동일 directory가 create에서는 canonical project root, fork에서는 selected active-workstream worktree와도 같아야 한다. 단순히 shell tool에 `workdir`를 지정한 사실은 App task cwd 증거가 아니다.

Child acquire 전에는 child session의 immutable observation이 아직 없으므로 첫 항목을 durable `continuation.target_cwd + host_task_cwd_digest`로 대체한다. current child App task cwd claim과 kernel cwd가 그 authority 및 selected root/worktree와 same-file일 때만 acquire transaction이 child session observation을 최초 materialize한다.

### 4.1 native path identity

- 존재하는 directory는 `realpath.native`와 `stat`으로 canonicalize/identify한다.
- POSIX는 canonical string byte equality와 filesystem object identity를 모두 확인한다.
- Windows는 separator/drive/case normalization을 후보 판정에만 사용하고, 최종 exact match는 existing directory의 filesystem identity(`dev+ino` 등 주입된 `sameFile`)로 확인한다. case-sensitive Windows directory에서 case-fold만으로 같다고 판정하지 않는다.
- `..`, symlink escape, raw prefix, descendant match, missing path는 거부한다.
- UNC는 Node가 realpath/stat으로 canonicalize한 existing directory만 비교한다. stable object identity를 얻을 수 없거나 resolve/case semantics가 모호하면 manual이다.
- helper는 `platform`, `realpath`, `stat`, `sameFile`, `exists`를 주입 가능하게 해 Linux/macOS/Windows fixture로 순수 테스트한다.

### 4.2 create route

다음을 모두 만족할 때만 `create`:

1. recorded/current host task cwd와 kernel cwd가 same-directory이고 그 directory가 project root와 같음
2. `list_projects` 결과 중 `projectKind === 'local'`
3. non-empty `path`가 native canonicalize 가능
4. canonical path가 root와 exact match
5. exact match가 정확히 하나
6. `projectId`가 bounded opaque validation 통과
7. root/create capability set 완전

path 없는 local project, remote project, worktree-kind project, 0개/2개 이상 exact match는 manual이다. 최초 prepared descriptor의 일회성 action target은 `{type:'project', projectId, environment:{type:'local'}}`이고 model/thinking은 생략한다. Raw `projectId`는 이 `do_not_call=false` 응답에서만 kernel stdout에 나타날 수 있으며 재진입/status/state-get/event에는 나타나지 않는다.

`list_projects` 결과 입력은 기존 bounded-input 계층으로 최대 byte 수/entry 수를 제한하고, `projectId/projectKind/path`만 allowlist projection한다. full host result와 unrelated projects는 state/event/log에 저장하지 않는다.

### 4.3 fork route

다음을 모두 만족할 때만 `fork`:

1. canonical cwd가 root 자체가 아님
2. convention `.claude/worktrees/<slug>` 또는 `.worktrees/<slug>`의 exact root
3. `active_workstreams`에 포함된 ID 중 해당 worktree를 가리키는 record가 정확히 하나
4. workstream status가 `in_progress|in_review`
5. recorded path가 기존 strict containment/symlink 검증 통과
6. worktree/fork capability set 완전

Descriptor는 calling thread ID를 읽지 않고 `fork_thread({environment:{type:'same-directory'}})`를 사용한다. 성공 뒤 exact child thread에 `send_message_to_thread`로 follow-up prompt를 보낸다. context mode는 `inherited-completed-history`; active turn과 unfinished response는 상속되지 않는다는 사실을 prompt와 문서에 명시한다.

### 4.4 precedence와 uncertainty

root exact match가 create보다 우선한다. root가 아니면 exact active worktree만 fork 후보이다. descendant, 다른 worktree, unrecorded convention worktree, 중복 record, path/capability mismatch는 자동 route가 아니라 `manual:<bounded-reason>`이다.

---

## 5. Durable state

새 run genesis에는 response-loss reconciliation용 block을 둔다.

```json
{
  "initialization": {
    "attempt_id": "same-as-run-id",
    "request_digest": "sha256-canonical-normalized-genesis-request",
    "previous_current_digest": "sha256-or-NONE",
    "host_observation_digest": "sha256-or-NONE"
  }
}
```

`attempt_id === run_id`이며 read-only `init-run prepare`가 동의 결과를 포함한 exact immutable init args를 받은 뒤 kernel에서 생성한다. 이 query는 attempt, current snapshot digest, expected request digest를 반환한다. Request digest는 저장될 canonical genesis projection 전체를 결합한다: runtime, goal, resolved protocol/recipe/review, model/effort, canonical root, canonical `plugins_detected`, normalized git head/branch/dirty projection, `detected_at`만 제거한 normalized `session_spawn`, consent와 full observation digest 또는 enum-only surface/source/capability profile이다. Map ordering, injected probe function identity, raw env, PID, raw host receipt, `created_at|updated_at|detected_at` 같은 clock-derived 값만 제외하고, injected env/platform/run의 **저장 결과**가 달라지면 digest도 달라진다. Prepare와 commit은 각각 이 projection을 독립 계산하므로 plugin/git/session-spawn drift는 pre-write request mismatch다. Full init READY는 attempt/previous-current/expected request/observation digest binding을 재출력하고, payload와 실제 cwd에서 두 digest를 다시 계산해 byte-exact인지 확인한다. Legacy fixture/state에는 block이 없어도 유효하지만 `initRun`을 포함한 모든 production new-run writer는 block이 required다. Generic patch 대상이 아니고 reconciliation status는 caller가 expected previous-current와 request digest를 모두 제시해야만 success outcome을 반환하되 digest/raw genesis 자체는 출력하지 않는다.

Current-pointer commit의 crash reservation은 root-scoped `<root>/.deep-loop/init-pending.json`에 둔다.

```json
{
  "version": 1,
  "attempt_id": "same-as-run-id",
  "request_digest": "sha256-hex",
  "previous_current_digest": "sha256-or-NONE"
}
```

이 파일은 single pending genesis만 표현하며 raw goal/path/host value를 담지 않는다. Commit lock 안에서 current CAS보다 먼저 atomic write하고, exact state와 current가 모두 완결된 뒤에만 제거한다. Lock stale takeover가 이 reservation을 지우거나 다른 attempt로 교체하지 않는다. Crash 뒤에는 exact attempt+request recovery만 진행할 수 있다. 이미 target current/state가 strict-valid한 completed reservation만 다음 commit이 검증 후 정리할 수 있다. 따라서 A가 pending/state를 쓰고 current 전 crash한 동안 같은 previous-current를 본 B는 state를 만들지 못한다.

Lease additive fields:

```json
{
  "handoff_transport": "codex-app",
  "handoff_attempt_id": "01...",
  "resume_policy": "app"
}
```

- enum: `codex-app` 또는 `null`; field absence는 legacy transport로 해석한다.
- rollback/recover/terminal cleanup은 두 값을 clear한다.

Codex App child session additive block:

```json
{
  "continuation": {
    "transport": "codex-app",
    "attempt_id": "01...",
    "route": "create",
    "context_mode": "fresh",
    "phase": "prepared",
    "expected_runtime": "codex",
    "expected_host_surface": "codex-app",
    "target_cwd": "/canonical/path",
    "host_task_cwd_digest": "sha256-hex",
    "workstream_id": null,
    "project_id": "opaque-or-null",
    "descriptor_digest": "sha256-hex",
    "emitted_at": "...",
    "prepare_deadline": "...",
    "prepared_at": "...",
    "confirmation_deadline": "...",
    "confirmed_at": null,
    "acquired_at": null,
    "acquired_generation": null,
    "thread_id": null,
    "unconfirmed_thread_id": null,
    "failure_code": null
  }
}
```

`route=create|fork`; `context_mode=fresh|inherited-completed-history`; `phase=emitted|prepared|confirmed|acquired|failed|abandoned`.

Schema validator에 correlation을 직접 추가한다. 현재 validator가 JSON Schema의 nested `properties`를 일반적으로 실행하지 않으므로 선언 파일만 바꾸지 않는다.

- live App continuation phase가 emitted/prepared/confirmed이거나 failed/abandoned-human-preserve이면 lease transport/attempt와 child continuation attempt가 exact match
- active App attempt의 lease `resume_policy=app`; human preserve 뒤에는 `human`; binding cleanup 때 null
- create는 workstream_id null, context fresh; project_id는 emitted 단계에서는 null일 수 있고 prepared 이상에서 required
- fork는 project_id null, workstream_id required, context inherited-completed-history
- confirmed/acquired는 thread_id와 해당 timestamps required; acquired는 positive safe-integer `acquired_generation`도 required
- emitted 이상에는 `emitted_at`과 fixed `prepare_deadline` required. Kernel의 non-configurable `APP_PREPARE_TIMEOUT_MS=300_000` 상수를 final emit transaction에서 한 번 적용하고 재진입으로 연장하지 않는다.
- prepared 이상에는 fixed `confirmation_deadline` required. Kernel의 non-configurable `APP_CONFIRMATION_TIMEOUT_MS=120_000` 상수를 prepare claim에서 한 번 적용하고 재진입으로 연장하지 않는다.
- state validator는 strict instant와 safe-integer arithmetic으로 `prepare_deadline = emitted_at + APP_PREPARE_TIMEOUT_MS`, `confirmation_deadline = prepared_at + APP_CONFIRMATION_TIMEOUT_MS`를 exact 검증한다. 상수는 state/config/generic patch 입력이 아니다.
- cross-log semantic verifier는 exact attempt/child를 가진 `handoff-emitted`, `app-task-prepared`, `app-task-confirmed`, `app-task-acquired` event의 `ts`가 각각 state의 `emitted_at`, `prepared_at`, `confirmed_at`, `acquired_at`과 byte-exact인지 검증한다. `validate(loopJson)` 단독으로 event log를 볼 수 있다고 가정하지 않는다.
- failed는 bounded failure_code required
- `unconfirmed_thread_id`는 fork route의 `message-unconfirmed` failure에서만 허용하고 confirmed `thread_id`와 혼용하지 않음
- non-App/legacy session에는 continuation block이 없어도 유효
- timestamp는 기존 strict instant parser 사용
- capabilities는 allowlist, unique, bounded count; `structured-process-stdin`과 `structured_stdin_mode` correlation은 모든 session observation에서 exact
- opaque ID: non-empty, UTF-8 512 bytes 이하, C0/C1 control 없음; trim/format parse/normalization 없음
- failure/detail: raw host error를 저장하지 않고 bounded enum과 256-byte 이하 sanitized summary만 허용

Phase-aware audit correlation:

- `acquired`: lease transport/attempt binding은 clear된다. 각 acquired continuation은 **자기** `app-task-acquired` event, session `started_at`, attempt/child/acquired timestamp/acquired_generation과 일치해야 하며 현재 lease에 무조건 재결합하지 않는다.
- `acquired_generation === lease.generation`인 acquired provenance는 current acquisition이다. 이때만 session `run_id === lease.owner_run_id`와 `lease.acquired_at === continuation.acquired_at`을 요구한다. Lease phase가 `active/acquired`일 필요는 없고, 이후 정상 `active/idle`, 다음 handoff의 pre-emit `active/reserved`, emitted/spawned `releasing`, rollback의 `active/idle`, recover의 `released/idle`, terminal cleanup에서도 유효하다.
- current owner에게 outgoing **live App binding**이 이미 final emit된 경우에만 parent `superseded_by`가 exact reserved child와 일치해야 한다. Pre-emit `reserved`에는 child session/link가 아직 없어도 되고, gate/host rollback·recover·terminal cleanup으로 live binding이 제거된 뒤에는 `superseded_by=null` 복원이 유효하다.
- `acquired_generation < lease.generation`이면 그 block은 historical App-acquire provenance다. Session run ID가 현재 owner와 다를 수도 있고, released lease를 **같은 owner ID**가 generic acquire한 경우 같을 수도 있다. 정상 handoff라면 `superseded_by`가 exact later child를 가리키지만, rollback/recover/explicit release 뒤 kernel-authorized generic fresh/same-owner acquire가 generation을 전진시킨 경우 null도 유효하다. 자기 acquire event/timestamp/generation은 그대로 검증하되 현재 lease `acquired_at`과 비교하거나 current App binding으로 해석하지 않는다. `acquired_generation > lease.generation`은 항상 invalid다.
- definitive `app-task fail`과 sweep은 final phase `failed`를 보존한다. Gate/pre-action rollback, revoke, recover가 취소한 non-terminal attempt, terminal cleanup은 `abandoned`다. Revoke 또는 uncertainty의 human-preserve failed/abandoned attempt는 recover 전까지 exact live binding을 유지한다. Recover는 `failed` phase/failure_code를 보존한 채 binding만 clear하고, 아직 non-terminal인 attempt만 `abandoned`로 바꾼다.
- 과거 acquired/failed/abandoned attempt가 session chain에 남아 있다는 이유로 현재 lease와 다시 결합하지 않는다. `emitted|prepared|confirmed` 또는 human-preserve failure 중 정확히 하나의 live attempt만 허용한다.

Generic `state patch` allowlist에는 이 필드를 추가하지 않는다.

---

## 6. 상태기계와 CLI

CLI namespace:

```text
deep-loop app-task revoke
deep-loop app-task prepare
deep-loop app-task confirm
deep-loop app-task fail
deep-loop app-task sweep-unconfirmed
deep-loop app-task status
deep-loop app-task await
deep-loop app-task acquire
deep-loop init-run preflight
deep-loop init-run prepare
deep-loop init-run status
deep-loop init-run [existing one-shot form or fixed-attempt full/enum form]
deep-loop host-surface stdin-probe
deep-loop host-surface observe
```

`app-task` subcommand 중 `status [--attempt <id>]`만 read-only다. Status attempt를 생략하면 current App attempt뿐 아니라 `has_app_history`를 safe-discovery하고, 주면 exact attempt를 고른다. 두 형태 모두 phase/readiness/manual-recovery code, non-secret owner run ID/generation, handoff rel과 redacted session summary(run ID/lifecycle/attempt/route/phase/failure code only)만 반환하고 raw `thread_id`, `unconfirmed_thread_id`, project ID, descriptor/host response/cwd는 출력하지 않는다. Live attempt가 없고 recover된 App history만 있어도 safe summary를 반환한다. `app-task consent` setter는 존재하지 않는다.

`host-surface stdin-probe`는 run/state를 읽거나 쓰지 않는 capability probe다. `init-run preflight`, `init-run prepare`, `init-run status`도 pre-lease read-only query이며 lock directory, `.deep-loop`, temp file, pending record를 생성·삭제하지 않고 stale lock cleanup도 하지 않는다. Preflight는 nonce-bound READY 뒤 full observation을 받아 non-consent eligibility와 observation digest만 반환한다. Prepare는 동의 결과까지 확정된 immutable init args와 expected observation digest 또는 enum-only profile을 normalize하고, stable current/pending snapshot에서 proposed `attempt_id`, `previous_current_digest`, `expected_request_digest`를 반환한다. Exact same request의 **incomplete** pending reservation은 그 existing attempt를 recovery binding으로 돌려줄 수 있고, state+current가 strict-valid한 completed pending은 read-only로 logically absent 취급해 current target을 새 previous snapshot으로 삼을 수 있다. Foreign incomplete/malformed pending은 conflict다. Status reconciliation은 `--attempt <id> --expected-current-digest <digest> --expected-request-digest <digest>`가 required이고 §6.0 stable read로 exact match 여부를 내부 비교한다. 이 세 query의 filesystem before/after snapshot은 byte-identical이어야 한다.

첫 질문 결과의 full commit은 기존 public command 이름을 유지한 `init-run --init-attempt <id> --expected-current-digest <digest> --expected-request-digest <digest> --expected-preflight-digest <digest> --stdin-mode <allowlisted> --app-host-input-stdin --app-continuation manual|auto --app-consent-authority default-manual|human-confirmed`이다. Stdin JSON은 preflight와 동일한 surface/source/capabilities/structured-stdin mode/host task cwd/cwd-source를 담고 kernel이 actual cwd와 observation/request digest를 다시 계산한다. Full process는 §2.3 READY와 §6.0 fixed binding을 먼저 출력한다. Probe/preflight 실패 시에는 full form을 전혀 시도하지 않고 raw/path-free enum-only fixed-attempt form만 허용하며 consent는 manual/default-manual로 강제한다. `auto/human-confirmed` correlation은 §3 strict genesis guard를 따른다.

현행 `deep-loop init-run --runtime ...` one-shot syntax와 exported `initRun(root, opts)`는 backward-compatible wrapper로 보존한다. 그러나 둘 다 내부에서 같은 request normalizer, read-only prepare, root pending reservation, root init lock, fixed-attempt commit, atomic current replacement primitive를 호출한다. App full/enum, Claude Code/Desktop, Codex CLI manual, legacy one-shot, direct programmatic caller를 포함한 **모든 production new-run/current writer**가 이 primitive 밖에서 run ID를 만들거나 state/current를 쓰는 것은 금지한다. Production skills는 surface와 무관하게 명시적 prepare→fixed-attempt commit/status flow로 이동해 attempt를 caller가 보존한다. One-shot/direct wrapper는 exact matching pending이 있으면 새 ULID를 만들지 않고 같은 request로 복구하며, 다른 pending/current는 fail-closed한다.

모든 post-init mutating command(`app-task revoke|prepare|confirm|fail|sweep-unconfirmed|await|acquire`, `host-surface observe`)는 `--owner --generation`을 요구하고 in-lock에서 재검사한다. Genesis `init-run` commit은 아직 lease가 없어 owner fence 범위 밖이지만 §6.0의 fixed attempt/request/current/pending fence와 shared root lock을 사용한다. manual→auto는 새 run init에서만 가능하다.

Generic `state get`도 App continuation의 exact opaque-ID keys인 `thread_id`, `unconfirmed_thread_id`, `project_id`를 recursive redacted projection으로 출력한다. Whole-state, parent field, exact sensitive leaf query 모두 raw value 대신 masked/digest marker를 반환하며 internal `readState`와 on-disk state는 바꾸지 않는다. `descriptor_digest`처럼 이미 one-way digest인 값은 그대로 출력할 수 있다. Raw ID를 다시 보여 주는 CLI escape flag는 제공하지 않는다.

모든 non-enum App host-derived string/array(host task cwd, normalized project list, child observation)와 full observation은 `--app-host-input-stdin`/`--observation-stdin`의 bounded one-line JSON으로만 kernel에 들어간다. Stdin 없는 manual form은 skill이 allowlist로 투영한 literal surface/source/capability enum만 argv로 전달하며 raw/path/mode/`structured-process-stdin`은 받을 수 없다. 그 밖의 argv에는 kernel-generated attempt/owner/generation, kernel-generated nonce와 fixed-format SHA-256 digest, allowlisted enum/mode만 남긴다. Digest/nonce는 strict grammar와 length를 검증하며 host raw value가 아니다. `confirm`과 optional fork-failure receipt도 raw ID argv를 받지 않는다. Static command는 각각 `app-task confirm --stdin-mode <allowlisted> --receipt-stdin ...`, `app-task fail --code message-unconfirmed --stdin-mode <allowlisted> --receipt-stdin ...`로 먼저 실행한다. Kernel reader가 raw/no-echo 전환과 bounded handler를 설치한 뒤 exact READY를 출력하고, execution plane이 그 token을 확인한 다음에만 host의 structured stdin tool로 raw UTF-8 ID와 단일 LF를 전달한다. Kernel은 host JSON/receipt 각각에 strict byte cap을 두고 receipt는 최대 513 bytes를 읽어 exactly one LF/one value, valid UTF-8, 기존 opaque bounds/control rules를 검사하며 raw 값을 stdout/stderr에 echo하지 않는다. §4.2의 최초 prepared action에 실리는 raw project target은 직접 host-tool data이지 shell argv가 아니며, 이것이 유일한 kernel-output 예외다. Here-doc, `printf`, env var, temp file, base64 argv, shell substitution fallback은 금지한다. Pre-question live probe/capability가 불명확하면 질문 없이 enum-only manual; full init invocation 불명확성은 §6.0; prepare/acquire 이후 불명확성은 preserve/sweep/manual recovery로 닫는다. 동일 receipt의 confirm/fail 재전달은 기존 idempotency/fence를 따른다.

Mode authority는 caller 선택 enum으로 끝나지 않는다. `init-run preflight`는 actual reader mode와 payload observation mode를 exact 비교하고 그 mode를 observation digest에 결합한다. Full init/observe/acquire는 `actual reader --stdin-mode === payload.structured_stdin_mode === transaction이 기록할 session mode`를 요구한다. Handoff prepare는 reader mode와 JSON mode가 recorded parent session mode와 모두 exact, confirm/fail receipt는 reader mode가 recorded parent mode와 exact여야 한다. 이 equality는 init에서는 state 생성 전, observe/prepare/confirm/fail/acquire에서는 owner/generation/runtime/terminal guard와 함께 fresh state의 in-lock precheck에서 검증한다. Mismatch는 init invalid 또는 post-init exit 3이며 event/state 무변경이다. `stdin-probe` READY도 requested mode와 actual reader mode를 exact 결합한다.

`$deep-loop:deep-loop-status`는 첫 조회로 argument 없는 `app-task status`를 사용한다. App attempt가 있으면 이 redacted 결과와 기존 budget/comprehension/breaker 및 allowlisted field별 state queries만 사용하고 generic unqualified `state get` 또는 whole `session_chain.sessions`를 호출하지 않는다. App attempt가 없어도 status skill은 `status`, `goal`, `routing.protocol`, `created_at`, `session_chain.lease`, `workstreams` 같은 기존 safe field를 각각 조회하며 전체 state dump를 만들지 않는다. 따라서 App phase/recover 절차를 표시하면서 tool transcript에도 raw receipt가 나오지 않는다.

### 6.0 genesis init handshake와 응답 유실

Full init은 ordinary `initRun`의 새 ULID 생성과 current write를 호출 뒤로 숨기지 않는다. App/non-App와 CLI/library surface가 모두 아래 한 protocol을 사용한다.

1. **질문 전 preflight:** execution plane은 live canary 성공 뒤 no-write `init-run preflight --stdin-mode <mode> --observation-stdin`을 시작한다. Kernel이 process-local nonce를 넣은 exact READY를 낸 뒤에만 bounded observation JSON을 전달한다. Kernel은 runtime/surface/source/capability/mode, actual cwd↔host task cwd same-file, complete route set을 검증해 `eligible`과 bounded reason, canonical `observation_digest`만 반환한다. Digest는 canonical observation facts와 kernel cwd identity를 결합하되 `observed_at` 같은 clock-derived 값은 제외한다. Raw cwd/host value는 출력하지 않는다. Full init은 이 digest를 권위로 믿지 않고 같은 observation에서 다시 계산하며, recorded `observed_at`은 commit process가 별도로 생성한다.
2. **질문 뒤 prepare:** 질문 결과 또는 처음부터 enum-only manual이라는 결정이 고정된 뒤 no-write `init-run prepare`를 호출한다. Prepare는 §5의 complete canonical genesis projection을 normalize하고 root/current/pending을 stable read해 `run_id === attempt_id`, `previous_current_digest`, `expected_request_digest`를 반환한다. Full profile의 request digest에는 expected observation digest가, enum-only/non-App profile에는 exact allowed surface/source/capability/consent enums가 들어간다. 이 binding은 commit과 모든 retry/status에 그대로 보존한다. Exact incomplete pending은 same request와 previous-current만 기존 attempt로 adopt하고, strict-valid completed pending은 logically absent로 보아 그 target current를 previous snapshot으로 사용한다. Foreign incomplete pending, malformed current/pending, read race는 새 attempt를 발급하지 않고 conflict/raced/indeterminate다. Preflight/prepare는 무쓰기이므로 응답 유실 시 같은 input으로 다시 조회할 수 있고, caller가 binding을 실제로 받은 뒤 full commit을 시작하기 전까지 생성된 proposed attempt는 durable authority가 아니다.
3. **full input 결합:** fixed-attempt full `init-run`은 attempt, previous-current, expected request, expected preflight digest를 먼저 validate한다. Stdin mode/handler 설치 뒤 READY에는 네 binding과 mode를 싣는다. READY 뒤 preflight와 byte-identical한 bounded observation을 한 번 받고 actual reader mode, payload mode, kernel cwd를 검증한 다음 observation digest와 normalized request digest를 다시 계산한다. 어느 expected digest와도 다르면 state/pending/lock write 전에 invalid로 끝난다. Enum-only form도 같은 request digest를 재계산하지만 stdin/observation digest는 `NONE`이다.
4. **single writer + owner-safe root lock:** `initRun(root, opts)`, existing one-shot `init-run`, fixed App full/enum form은 모두 `commitPreparedInit` 한 함수로 들어간다. 이 함수만 canonical root의 `.deep-loop/.init.lock`을 획득하고 state/current/pending을 쓸 수 있다. Default lock publication은 같은 directory의 strict-name unique candidate file에 bounded `{pid, nonce, acquired_at}`를 완전히 write/close한 뒤 Node builtin exclusive hard-link(`linkSync(candidate, fixedLock)`)로 authority를 한 번에 노출한다; filesystem이 이 reviewed atomic exclusive primitive를 지원하지 않으면 unsafe mkdir/mtime fallback 없이 `LOCK_UNSUPPORTED`로 fail-closed한다. Link 성공 직후와 EEXIST/unsupported/error 경로 모두 caller candidate name은 `finally`에서 unlink하고, hard crash로 남은 candidate는 authority가 아니다. 다음 **mutating lock acquisition**만 strict filename+valid owner record+TTL+definitively-dead PID를 만족하는 orphan **candidate**를 bounded sweep할 수 있으며 read-only preflight/prepare/status는 sweep하지 않는다. Fixed authority lock은 TTL/PID 상태와 무관하게 contender가 자동 unlink/rename/reclaim하지 않는다. Alive/unknown/invalid holder는 `LOCK_BUSY`, definitively dead holder는 bounded `LOCK_STALE_MANUAL` 진단이며 둘 다 무변경이다. `init-run status`는 stable owner-record read로 raw pid/nonce 없이 `lock_state=free|busy|stale-manual|invalid`만 표시할 수 있다. Hard-crash fixed lock 정리는 모든 관련 process를 중단한 뒤 exact artifact와 pending/status를 제시하고 **별도 사람 삭제 승인**을 받은 manual recovery뿐이며, unsafe automatic fallback은 없다. Fixed lock release는 exact nonce를 다시 읽어 자기 token일 때만 unlink하므로 normal release 뒤 publish된 새 lock을 old-token release가 지울 수 없다. Multiple stale observers도 fixed pathname을 쓰지 않으므로 reclaimer ABA가 없다. Root lock/current replacement clock, liveness, link, retry는 주입 가능하고 native Windows/POSIX에서 검증한다. 기존 per-run lock과 별개지만 production에서 `.deep-loop/current`를 쓰는 다른 경로는 허용하지 않는다.
5. **already-initialized before reservation, then durable reservation:** lock 안에서 current, exact target state, `init-pending.json`을 strict read한다. Pending 유무와 관계없이 current가 target이고 target state의 schema/hash/root/integrity 및 attempt/request/previous/observation이 caller binding과 exact하면 먼저 idempotent success를 판정한다. Own completed pending이 없으면 event/write 없는 `already-initialized`; own completed pending이면 그것만 제거한 `recovered-pending`; foreign pending은 건드리지 않고 already-initialized를 반환한다. 이 branch가 아니면, pending이 없고 current digest가 expected previous와 exact일 때만 pending reservation을 atomic write한다. Pending이 있으면 exact attempt+request+previous binding만 recovery를 계속할 수 있다. 다른 attempt는 current가 아직 previous 그대로여도 `INIT_PENDING_FENCED`이고 state를 만들지 않는다. Pending이 가리키는 다른 state/current가 이미 strict-valid committed인 경우에만 그 completed marker를 정리한 뒤, caller가 그 committed current를 자기 expected previous로 준비했다면 새 reservation을 만들 수 있다. Root-lock stale diagnostics/manual lock cleanup은 incomplete pending을 지우지 않으며, lock 제거 뒤에도 exact pending retry만 recovery할 수 있다.
6. **hash-first genesis publication + current completion:** exact reservation 아래 canonical genesis JSON bytes를 한 번 만들고 schema/root를 검증한 뒤, genesis 전용 publisher가 `.loop.hash`를 먼저 temp+rename하고 `loop.json`을 **마지막 commit marker**로 temp+rename한다. Existing `writeState`의 state-first two-write 순서를 genesis에 사용하지 않는다. 각 atomic write는 error 경로에서 자기 temp를 `finally` cleanup하고, hard crash로 strict `.tmp-<pid>-<time>-<nonce>` debris가 남을 수 있음을 protocol이 인정한다. Crash로 target `loop.json`이 아직 없으면 exact pending retry만 no-loop run directory의 absent/hash-only/strict temp-debris 조합을 non-authoritative staging으로 취급해 bounded temp cleanup, hash rewrite, state marker publish를 할 수 있다; unknown filename/symlink/non-regular entry는 conflict다. Read-only status는 temp debris를 지우지 않고 no-loop+exact-pending을 `pending`으로 본다. `loop.json`이 보이면 `.loop.hash`도 이미 있어야 하며 schema/hash/root/integrity와 exact attempt/request/previous/observation을 모두 strict 검증한다; loop-present + missing/stale hash는 correct publisher가 만들 수 없는 tamper/corrupt 상태라 자동 repair하지 않는다. Strict state 뒤 current가 previous이면 target run ID로 atomic replace하고, target이면 no-op, 그 밖이면 fence다. State와 current가 exact한 뒤 own pending을 제거한다. Crash windows는 `pending-only/no-loop(+temp)`, `pending+hash-only(+temp)`, `pending+strict-state(+temp)`, `pending+strict-state+current(+temp)`이며 모두 exact retry로만 복구된다. Pending 없는 new-format state/hash/temp staging이나 state-only는 corrupt/conflict이고 자동 채택하지 않는다.
7. **true read-only status:** `init-run status --attempt <id> --expected-current-digest <digest> --expected-request-digest <digest>`는 root lock을 획득하지 않는다. `current-before + pending-before → exact run state/hash/schema/integrity read → pending-after + current-after`를 수행하고 before/after bytes와 file identity가 모두 stable할 때만 판정한다. Exact target state+target current proof는 pending보다 먼저 판정하므로, caller와 무관한 later pending이 stable하게 존재해도 이 attempt에는 `committed`다. 그 branch가 아니면 exact pending 아래 no-loop absent/hash-only/temp-debris는 `pending`, strict state+previous current는 `state-only`; run과 자기 pending이 모두 없으면 `absent`, foreign pending/attempt/request/previous/current는 `conflict`다. Transient post-init state/hash 교체나 어느 snapshot 변화도 bounded retry 뒤 `raced`, loop-present missing/stale hash와 malformed/partial/IO ambiguity는 `indeterminate`다. Caller의 expected previous-current와 request가 target state 또는 자기 pending/state에 둘 다 exact할 때만 success-class outcome을 반환한다. 반환에는 `request_match: true`, `previous_current_match: true`와 safe consent/surface/mode summary만 있고 digest/raw genesis/host ID/path는 없다. Expected binding mismatch는 summary가 같아도 success가 아니다.
8. **response-loss policy:** READY/write/result no-return이면 같은 process handle을 먼저 bounded poll한 뒤 exact attempt+expected previous-current+expected request로 status한다. `committed`, `request_match:true`, `previous_current_match:true`만 성공이다. `pending|state-only`는 prior process 종료가 증명된 뒤 같은 binding+same full input의 exact retry만 허용한다. `absent`도 prior process 종료가 증명된 뒤에만 exact retry한다. `raced`는 bounded status poll만, `indeterminate|conflict` 또는 계속 실행 여부 불명은 stop/diagnose다. Retry success도 stored request/previous-current/observation proof를 재검증하는 idempotent commit 결과여야 한다.
9. Full init을 한 번이라도 시작한 뒤에는 enum-only manual init, 새 attempt, current overwrite로 fallback하지 않는다. 특히 `auto/human-confirmed` 승인 뒤 full init 실패/불확실성은 state를 만들지 않았다고 추측하거나 manual/default로 강등하지 않는다.
10. Enum-only manual init은 §3의 probe/preflight/complete-capability precheck가 실패해 질문을 하지 않은 경우에만 처음부터 선택한다. 이 form도 prepare→fixed commit→exact status를 사용하며 mode/cwd/structured capability는 null이다. Existing one-shot CLI/direct `initRun` wrapper는 내부 prepare에서 exact matching incomplete pending을 발견하면 그 attempt를 재사용해 recovery하고, foreign pending이면 실패한다. Production skills는 explicit attempt를 보존하므로 one-shot response shape에 의존하지 않는다.

### 6.1 prepare

Static command shape는 `app-task prepare --owner <parent> --generation <n> --stdin-mode <allowlisted> --app-host-input-stdin`이다. Kernel이 exact READY를 출력한 뒤에만 JSON을 write한다. Host-derived cwd/project data는 argv에 추가하지 않는다.

입력:

- run, owner, generation, trigger, reason
- `--app-host-input-stdin` JSON의 current host-context task cwd claim; kernel cwd는 CLI가 직접 읽어 recorded value와 대조
- 같은 bounded stdin JSON의 allowlist-projected normalized `list_projects` result(create 후보; fork에서는 absent)

순서:

1. durable runtime=`codex`, parent session surface=`codex-app`, consent=`auto/human-confirmed`, recorded capability 완전, recorded/current-host/kernel cwd와 route가 exact same-directory인지 검증한다.
2. handoff가 없으면 기존 reserve/emit을 재사용하되, final `handoff-emitted` anchored transaction에서 child continuation과 lease `handoff_transport/attempt`, `resume_policy=app`을 함께 기록한다. 이 transaction도 shared anchored clock API로 lock 획득 뒤 한 번 표본화한 `now`를 event `ts`, `emitted_at`, `prepare_deadline` 계산에 함께 쓴다. `reserved` 동안 lease는 active라 acquire 불가하고, `emitted`가 되는 순간부터 generic acquire가 App transport를 거부하므로 confirmation gap이 없다.
3. 동일 trigger의 이미 emitted App attempt는 exact binding일 때만 재사용한다. legacy/다른 attempt/다른 route는 conflict다.
4. pending child가 포함된 fresh state에서 gate를 기존 순서 `budget → breaker → max_sessions → wallclock → auto_handoff`로 평가한다. 이 순서는 현재 respawn의 max-session off-by-one 의미를 보존한다.
5. descriptor 권한을 커밋하기 직전에 `reconcileBudget`을 실행하고, prepare anchored transaction의 in-lock precheck에서 fresh state로 owner/generation, consent/surface/cwd/attempt, `now <= prepare_deadline`, 그리고 전체 gate를 같은 순서로 **다시** 평가한다. 이 권위 있는 `now`는 injectable `nowFn`을 **lock 획득 뒤** 호출해 표본화한다. 그 lock을 기다리는 동안 accounting write가 budget을 소진했거나 wallclock/prepare deadline이 지났으면 claim하지 않는다.
6. gate가 여전히 통과할 때만 같은 transaction에서 `emitted → spawned`, child `emitted → prepared`, descriptor digest/timestamp/fixed confirmation deadline을 함께 기록한다.
7. kernel은 self-contained descriptor를 JSON으로 딱 한 번 반환한다.

Revoke와의 선형화 지점은 step 6의 spawned/descriptor commit이다. App final emit과 step 6 prepare transaction은 각각 lock 안에서 fresh `auto/human-confirmed`, exact parent surface/capability/cwd, non-abandoned attempt, owner/generation을 다시 확인한다. Revoke가 reserve 뒤 final emit보다 먼저 이기면 emit은 거부되고 reservation을 rollback한다. Revoke가 emit 뒤 prepare보다 먼저 이기면 attempt가 abandoned라 descriptor commit이 거부된다. Step 6이 먼저 commit된 경우에만 actionable descriptor가 존재할 수 있고, 그 직후 revoke가 이기면 외부 task 생성 race는 가능하지만 confirm/acquire는 차단된다.

첫 성공:

```json
{
  "ok": true,
  "outcome": "prepared",
  "do_not_call": false,
  "attempt_id": "01...",
  "route": "create",
  "context_mode": "fresh",
  "action": { "tool": "create_thread", "target": {}, "prompt": "..." }
}
```

재진입:

```json
{
  "ok": true,
  "outcome": "already-prepared",
  "do_not_call": true,
  "attempt_id": "01..."
}
```

재진입 결과에는 actionable target/prompt를 다시 싣지 않는다. confirmation deadline 전 prepared 재진입은 mutation 없이 `already-prepared/do_not_call`; emitted attempt는 prepare deadline 안에서만 claim 가능하다. 각 deadline 이후에는 exact `sweep-unconfirmed` 전이만 허용한다. prepare commit 후 process가 죽으면 launch 여부를 알 수 없으므로 자동 재시도하지 않는다.

`sweep-unconfirmed`는 두 exact cases만 처리한다.

- `phase=emitted`, `now > prepare_deadline`, lease emitted/releasing → child `failed(app-prepare-unattended)` + human preserve pause
- `phase=prepared`, `now > confirmation_deadline`, lease spawned/releasing → child `failed(app-launch-unconfirmed)` + human preserve pause

둘 다 exact parent fence + transport + attempt + reserved child + matching phase/deadline을 lock 안에서 다시 확인하고 한 anchored transaction으로 `status=paused`, `resume_policy=human`, `expires_at=null`을 기록한다. Duplicate emit/prepare는 deadline을 연장하거나 조기 pause하지 않는다. continue/handoff execution plane과 headless driver는 expired App attempt를 발견하면 이 kernel 전이를 실행할 수 있지만 host task tool은 호출하지 않는다. `deep-loop-status`와 `app-task status`는 계속 read-only로 상태와 recover/manual 절차만 제시한다. 다음 process tick 자체가 전혀 없으면 state는 deadline-expired emitted/prepared로 남되 generic acquire/respawn이 계속 차단된다.

첫 confirm의 confirmation-deadline 판정, 두 sweep case, `await`의 readiness-timeout commit도 동일하게 각 anchored transaction의 lock 안에서 injectable `nowFn`을 호출한다. CLI 진입 전에 계산한 stale clock value로 authorize하지 않는다. 이미 confirmed/acquired인 exact idempotent no-op는 first-confirm deadline 판정보다 먼저 분기하지만 어떤 mutation도 하지 않는다.

이를 위해 `appendAnchored`는 additive `opts.nowFn` 계약을 가진다. `withLock` 획득과 fresh state/root binding 확인 뒤 gateway가 `nowFn`을 정확히 한 번 호출해 strict finite instant/ISO 값을 만들고, `preCheck(loop, clock)`, `appendEvent(..., now)`, optional paired cost event, `mutate(loop, spent, clock)`에 같은 표본을 전달한다. 기존 caller가 `nowFn`을 생략하면 현행 clock 동작을 보존한다. App transition은 이 API만 사용하며 자체 anchored gateway를 복제하지 않는다. `integrity.mjs`의 cross-log semantic verifier는 mutation 진입 시 기존 state/log correlation 및 별도 integrity audit에서 실행된다.

Gate 실패는 기존 `rollbackAndPause` 의미로 child reservation을 무효화하고 `gate:<name>`로 paused. consent/manual 또는 App route를 결합하기 전 capability/path ambiguity는 기존 legacy handoff를 emit하고 preserve-pause하여 manual resume artifact를 남긴다. 이미 PreCompact가 App-bound emit을 만든 뒤 discovery가 실패하면 attempt를 abandon하지 않고 App-unconfirmed preserve-pause하며 사람이 recover한 뒤 manual resume하도록 한다. 어느 경우도 actionable App descriptor를 반환하지 않는다.

### 6.2 외부 App 호출

Execution-plane의 유일한 action sequence:

```text
create: create_thread(prompt, local-project-target)
fork:   fork_thread(same-directory) → send_message_to_thread(child, prompt)
```

- prepare의 `do_not_call=false`인 exact 응답 직후 한 번만 실행한다.
- tool timeout/no-return/dynamic error를 성공으로 추정하지 않는다.
- 현재 공개 host declaration에서 `create_thread`와 `send_message_to_thread` success payload는 `Promise<unknown>`이고 stable receipt schema가 보장되지 않는다. `fork_thread(same-directory)`만 child `threadId` 반환을 명시한다. 따라서 아래 parser는 fail-closed adapter contract이며, create/send happy-path shape는 승인된 real smoke 전까지 provisional이다.
- create는 successful tool completion 결과에서 **현재 host가 실제로 제공한** single `threadId`가 bounded opaque validation을 통과할 때만 confirm 가능하다. field가 없거나 복수/다른 shape면 task가 생겼을 가능성이 있어도 `invalid-host-receipt`로 fail-closed하며 shape를 추측하지 않는다.
- fork는 documented same-directory result의 exact non-empty `threadId`를 authority로 쓴다.
- send는 host tool protocol의 successful completion을 dispatch receipt로 쓴다. payload에 thread ID가 존재하면 fork ID와 byte-exact 일치를 추가 검증하고, ID echo가 없다는 이유만으로 정상 dispatch를 실패시키지 않는다. explicit error/timeout/no-return은 failure다.
- worktree create의 `clientThreadId`는 이 기능에서 success가 아니다. root route는 local target만 허용한다.
- raw host response/error는 state에 저장하지 않는다.
- Host task call 뒤 confirm/fail receipt는 §6 CLI의 static `--receipt-stdin` process + exact READY 뒤 structured stdin 외 다른 경로로 전달하지 않는다. Raw thread ID가 포함된 host call/receipt와 structured stdin tool call, create의 raw project target을 포함한 최초 prepared action/direct host call만 필요한 ephemeral transcript 지점이고, 그 뒤 kernel output/read path는 모두 redacted다.

### 6.3 confirm

`confirm --attempt <id> --stdin-mode <allowlisted> --receipt-stdin`은 static argv로 시작하고 exact purpose/attempt READY 뒤 structured stdin에서 받은 opaque receipt로 fresh state를 lock 안에서 확인한다. 판정 precedence는 다음과 같다.

- 이미 acquired인 exact attempt+thread receipt는 parent fence가 바뀌었어도 mutation 없는 `already-complete`; 이미 confirmed인 exact receipt는 deadline 경과 뒤에도 event/write 없는 `already-confirmed`다.
- 위 idempotent exact cases가 아니면 first confirm은 parent owner/generation fence, consent `auto/human-confirmed`, phase prepared, current time이 stored confirmation deadline 이내, exact attempt/child/route/runtime/surface/cwd를 모두 요구한다.
- fork는 execution plane이 message success까지 확인한 뒤에만 호출한다.
- anchored transaction에서 child phase `confirmed`, thread_id, confirmed_at을 기록한다.
- revoke/abandoned, deadline expiry(first confirm), 다른 thread ID, phase/transport/cwd mismatch는 exit 3 무변경.

Thread ID는 confirmation receipt일 뿐 task control authority가 아니다. 자동 archive/delete/rename/pin/추가 메시지는 하지 않는다.

### 6.4 child status/acquire

Resume prompt는 child에게 먼저 read-only `app-task status --attempt`를 호출하게 한다.

Resume skill은 **항상** argument 없는 redacted `app-task status`를 whole-session query보다 먼저 호출한다. Descriptor/prompt가 있으면 결합된 logical run ID, exact attempt, child ID, handoff relative path를 exact status와 대조한다. Descriptor가 없어도 `has_app_history=true`이면 redacted historical session/handoff summary로 recover/manual resume을 수행한다. 이 두 App-bearing branch에서는 `state get --field session_chain.sessions`를 호출하지 않는다. `has_app_history=false`인 진짜 legacy run만 기존 whole-session query를 유지한다. 따라서 raw receipt가 tool transcript에 나타나기 전에 branch가 결정된다.

- prepared/unconfirmed: bounded backoff로 기다리며 generic acquire를 호출하지 않는다.
- confirmed: child가 live no-echo canary probe를 먼저 통과한 뒤 static argv `app-task acquire --attempt <id> --owner <reserved-child> --generation <parent-generation> --runtime codex --stdin-mode <allowlisted> --observation-stdin`을 호출한다. Exact acquire READY를 관측한 뒤에만 child current surface/source/capabilities/mode/host-task-cwd/source를 bounded structured stdin JSON으로 전달한다. kernel은 actual process cwd도 독립 확인한다.
- failed/abandoned/manual/timeout: acquire하지 않고 상태를 사용자에게 제시한다.

App acquire는 하나의 anchored transaction에서 다음을 검증·변경한다.

- first-acquire mutation guard 전에 exact attempt/reserved child가 이미 `acquired`이고 **즉시 post-acquire current projection**이 모두 유지될 때만 parent generation이 이미 전진했어도 event/write 없는 `already-acquired`다. Required projection은 run `status=running`/pause_reason null, lease owner=child/generation=expected parent+1/state=`active`/handoff_phase=`acquired`, lease `resume_policy|handoff_transport|handoff_attempt_id|handoff_child_run_id|handoff_idempotency_key`가 모두 null, lease acquired_at=continuation acquired_at, continuation acquired_generation=lease generation, parent outcome=`took_over`, no newer outgoing binding, 그리고 clock field를 제외한 stored child observation/cwd/mode가 retry input과 exact인 상태다. 같은 acquire 응답 유실은 redacted exact status 또는 동일 structured observation 재전달로 이 branch에 수렴한다. Release/recover/pause/terminal/next reserve·emit처럼 projection이 전진한 상태와 다른 observation/cwd/runtime/surface/attempt는 already-acquired로 성공하지 않고 current status/fence를 반환한다.
- run non-terminal, exact parent generation
- releasing lease, phase spawned, transport codex-app
- exact reserved child와 attempt
- child continuation confirmed, consent가 여전히 auto/human-confirmed, exact runtime/surface/source/host-task-cwd-source/route binding; child capability input은 bounded/allowlisted current-session observation이며 parent capabilities를 상속하지 않고 acquire transport 자체에 필요한 `structured-process-stdin`을 포함함. 이후 handoff route capability가 partial이면 acquire는 성공해도 다음 continuation은 manual
- acquire 전 child session에는 observed cwd가 없으므로 durable `continuation.target_cwd + host_task_cwd_digest`를 expected authority로 사용하고, current host task cwd claim과 kernel cwd가 그 directory와 same-file인지 확인
- create는 cwd exact root; fork는 cwd exact recorded worktree
- lease generation +1, state active, handoff_phase acquired
- transport/attempt/child/idempotency-key lease binding clear, expires_at/resume_policy null
- child phase acquired + child가 관측한 host_surface/source/capabilities/task cwd materialization + started_at/acquired_at
- child continuation `acquired_generation=parent generation+1`; 같은 transaction의 lease generation과 일치
- paused 상태였다면 running으로 되돌리고 pause_reason/resume_policy clear
- parent outcome took_over

현재 generic `acquireLease`는 App transport가 있으면 `app-confirmation-required`로 거부한다. 이 guard는 reserved-child takeable 계산보다 앞에 둔다.

현재 public generic `releaseLease`도 owner/generation을 먼저 확인한다. 기존 paused guard는 그대로 우선해 human-preserve App failure를 포함한 paused run을 `RUN_PAUSED` 무변경으로 막는다. 그 뒤 **non-paused, non-terminal live App** transport/attempt binding(`emitted|prepared|confirmed`)이 있으면 `app-transport-owned`로 event/state write 없이 거부한다. 그렇지 않으면 parent가 spawned App lease를 `released`로 바꿔 전용 acquire의 releasing precondition을 깨뜨릴 수 있다. Terminal finalization은 먼저 같은 anchored cleanup에서 live attempt를 abandoned/cleared하므로, valid terminal + no live App binding의 기존 owner-confirmed release cleanup은 그대로 허용한다. Terminal인데 live binding이 남은 corrupt/legacy shape는 generic release로 부분 정리하지 않고 App-aware terminal cleanup/invalid로 fail-closed한다. App acquire가 binding을 clear한 뒤의 normal release와 audited App recover가 binding을 clear한 뒤의 generic release/re-acquire도 기존 동작을 보존한다.

### 6.5 await/readiness

Parent `app-task await`는 confirm 이후 bounded deadline 동안 다음 exact 조건만 성공으로 본다.

```text
lease.state=active
lease.handoff_phase=acquired
lease.owner_run_id=reserved child
lease.generation=parent generation+1
child.continuation.phase=acquired
child.continuation.attempt_id=expected attempt
```

빠른 child acquire로 parent fence가 바뀐 경우에도 exact child/attempt 조건이면 성공이다. 다른 owner/generation은 fence conflict다.

Readiness deadline 초과는 task 생성 실패 증명이 아니므로 reservation/attempt를 preserve하고 `status=paused`, `resume_policy=human`, `expires_at=null`, `pause_reason=app-child-timeout-awaiting`으로 anchored 전이한다. 이 timeout commit은 lock 안에서 exact transport + attempt + reserved child + consent auto + child phase confirmed + lease phase spawned를 다시 확인한다. 같은 generation에서 fail/revoke/recover가 attempt를 failed/abandoned/cleared했다면 mutation 없는 terminal outcome으로 끝내며 stale pause를 다시 쓰지 않는다. 늦은 exact confirmed child acquire는 허용한다. 사람은 기존 recover confirmation으로 attempt를 abandon하고 reservation을 폐기할 수 있다.

### 6.6 fail과 부분 성공

`app-task fail --attempt <id> --code <bounded> --owner <parent> --generation <n> [--stdin-mode <allowlisted> --receipt-stdin]`는 재시도 신호가 아니다. Optional stdin receipt는 `code=message-unconfirmed`에서만 허용하고 exact READY 뒤 한 줄을 받으며, fork route/attempt와 bounded opaque validation을 요구한다. 다른 code에서 stdin receipt가 제공되거나 기존 receipt와 충돌하면 exit 3 무변경이다. Raw receipt argv option은 존재하지 않는다.

| 상황 | durable 처리 |
|---|---|
| create/fork timeout, no-return, dynamic error | 단일 anchored phase=`failed`, child invalidation + parent rollback/pause, raw error 미저장; 자동 재시도 금지 |
| create success지만 malformed/missing threadId | phase=`failed`, code=`invalid-host-receipt`, child invalidation + parent rollback/pause |
| fork success, message failure/timeout/mismatched receipt | known thread_id는 bounded audit evidence로 저장, `message-unconfirmed`, preserve/manual; 재전송·archive/delete 금지 |
| confirm command response 유실 | 동일 receipt confirm 재호출 허용; commit됐으면 exact no-op, 아니면 최초 commit |
| confirmation 뒤 child timeout | confirmed reservation preserve; 늦은 child 허용 |
| wrong child/runtime/surface/cwd/attempt | exit 3, state/event 무변경 |
| revoke during emitted/prepared/confirmed | same transaction에서 attempt abandoned/non-acquirable + preserve/manual; 외부 task 조작 없음 |
| gate block before descriptor | phase=`abandoned`, rollback+paused; task 호출 없음 |

모든 fail/sweep/await timeout commit도 parent fence뿐 아니라 exact transport/attempt/child/phase를 in-lock 재검사한다. Definitive `app-task fail` rollback은 binding을 clear해도 continuation phase=`failed`와 failure_code를 보존한다. Sweep/message uncertainty의 human-preserve `failed`는 recover 전까지 binding을 유지하고, recover 뒤 failed 그대로 binding만 clear한다. Revoke, gate/pre-action rollback, recover 시점의 non-terminal attempt, terminal cleanup만 `abandoned`로 남긴다. Audit record는 삭제하지 않는다.

---

## 7. Resume prompt contract

Kernel이 prompt의 단일 builder다. create/fork 모두 다음 bounded 사실을 포함한다.

- canonical project root
- exact host task/target cwd
- logical loop run ID(outer `.deep-loop/runs/<run-id>` 식별자)와 parent session owner run ID, reserved child run ID를 서로 구별
- expected parent generation
- runtime `codex`, expected surface `codex-app`
- attempt ID와 route/context mode
- handoff relative path
- fork이면 exact active workstream ID와 recorded worktree path binding
- fresh create인지 completed-history fork인지
- active turn/unfinished response는 fork에도 상속되지 않는다는 경고
- **confirmation status를 먼저 읽고 confirmed 전 acquire하지 말 것**
- literal `$deep-loop:deep-loop-resume`를 실행해 이 protocol을 따를 것
- state를 직접 수정하지 않고 App 전용 CLI만 사용할 것
- source of truth는 handoff + loop state이며 이전 대화만 믿지 말 것
- acquire 성공 뒤 기존 `session-profile set` 경로로 현재 App task의 model/effort profile을 self-refresh할 것(model/thinking tool override와 별개)
- parent capability를 상속하지 말고 child App task의 current callable capability set을 직접 관측해 acquire input으로 보낼 것

Prompt는 project/thread ID나 raw host response를 포함하지 않는다. 모든 동적 값은 기존 bounded input 규칙을 통과하고, descriptor digest로 prepare state와 결합한다.

---

## 8. 기존 경로와 hook 격리

- `respawn()` precedence는 현행 계약을 보존해 **runtime/caller fence → terminal fast-return → App transport isolation → idempotency key/phase/external spawn**이다. Terminal보다 transport를 먼저 반환하지 않는다. Non-terminal에서 `handoff_transport=codex-app`이면 key/phase 처리 전에 `app-transport-owned`로 external spawn/CAS를 하지 않는다.
- `headless-host`와 `drive-headless`도 candidate scan과 spawned re-entry 전에 App transport/attempt를 분리한다. expired `emitted` 또는 `prepared` attempt에는 kernel-only `sweep-unconfirmed`를 실행할 수 있지만 App host tool은 호출하지 않고, 그 외 App attempt는 skip한다. `resume_policy=human`도 기존대로 skip한다.
- PreCompact는 emit-only 원칙을 유지한다. tool discovery/create/fork/message/confirm은 호출하지 않는다. 그러나 durable parent session이 `codex-app` surface, complete route capability, auto/human-confirmed consent를 이미 가지고 있고 recorded host task cwd와 hook process cwd가 same-directory이며 root/worktree route를 exact하게 결정할 수 있으면, **handoff emit 트랜잭션부터 App transport/attempt intent와 fixed prepare deadline을 결합**한다. 다음 attended skill tick이 host task cwd를 다시 증명하고 project discovery/gate를 수행해 deadline 안에 그 in-flight attempt를 prepare한다. attended tick이 오지 않으면 headless/kernel tick의 emitted sweep이 human-preserve하고, 아무 tick도 없으면 durable expired marker와 manual recovery artifact만 남는다; 어느 경우도 task를 만들었다고 주장하지 않는다. Generic emitted handoff의 사후 App 변환은 금지한다.
- legacy field absence, non-App surface, manual consent는 현재 Codex manual descriptor와 Claude visible/headless/desktop 동작을 그대로 유지한다.
- runtime/caller fence와 terminal guard는 모든 App mutating command에서도 이 순서로 먼저 적용한다.

이 격리는 App task 도구가 hook/unattended에서 조용히 호출되는 경로를 만들지 않는다.

---

## 9. 모듈과 변경 표면

신규:

- `scripts/lib/host-surface.mjs`: surface/capability correlation, native path identity, route selection 순수 함수
- `scripts/lib/init-transaction.mjs`: complete canonical genesis request/observation digest, no-write preflight/prepare/status, owner-token/liveness-safe root init lock, pending reservation, hash-first/state-last genesis publisher, fixed-attempt atomic-current commit
- `scripts/lib/app-task-continuation.mjs`: genesis consent validation, revoke, emit binding, prepare/confirm/fail/sweep/status/await/acquire anchored 상태기계
- `tests/host-surface.test.mjs`
- `tests/init-transaction.test.mjs`
- `tests/app-task-continuation.test.mjs`
- `tests/codex-app-task-continuation-integration.test.mjs`

변경:

- `scripts/deep-loop.mjs`: 기존 `init-run` one-shot 호환 + `preflight|prepare|status`/fixed full+enum dispatch, `app-task`, read-only `host-surface stdin-probe`, `host-surface observe` CLI dispatch, READY-before-read/raw-noecho restoration을 포함한 bounded stdin reader, generic `state get` App-receipt redaction, strict args/exit mapping
- `scripts/lib/runtime.mjs`: runtime/surface correlation guard
- `scripts/lib/initrun.mjs`: `buildInitialLoop` legacy fixture compatibility, caller-fixed initialization block/initial host surface/consent materialization, public `initRun`의 shared init-transaction compatibility wrapper
- `scripts/lib/handoff.mjs`: optional App continuation intent를 final emit transaction에 결합; prompt/descriptor builder wiring
- `scripts/lib/runtime-descriptor.mjs`: self-contained App create/fork resume prompt/descriptor; 기존 manual default 보존
- `scripts/lib/lease.mjs`: generic App acquire/release 거부, App acquire response-loss idempotency; rollback binding cleanup
- `scripts/lib/respawn.mjs`: App transport early guard
- `scripts/lib/headless-host.mjs`: App transport early skip
- `scripts/lib/recover.mjs`, `scripts/lib/state.mjs`: App attempt abandon/cleanup와 preserve correlation; root init transaction이 쓰는 cross-process lock 및 state/hash/current atomic filesystem primitives(다른 current writer는 없음)
- `scripts/lib/integrity.mjs`: lock-inside single clock sample을 event/state callback에 공유하는 additive `appendAnchored` API와 App state↔event timestamp/attempt cross-log verifier
- `scripts/lib/schema.mjs`와 `schemas/loop-run.schema.json`: nested correlation/manual validation
- `skills/deep-loop/SKILL.md`: init 전 surface/consent flow
- `skills/deep-loop-continue/SKILL.md`, `skills/deep-loop-handoff/SKILL.md`, `skills/deep-loop-resume/SKILL.md`: prepare/tool/confirm/acquire/surface-observe/session-profile-refresh flow; App-bearing resume은 descriptor 유무와 무관하게 redacted status/history를 사용하고 whole sessions discovery를 호출하지 않음
- `skills/deep-loop-status/SKILL.md`: redacted App status 우선 조회, App phase/manual recovery 표시, unqualified whole-state dump 제거
- `skills/deep-loop-discover/SKILL.md`: unqualified whole-state dump를 필요한 safe field별 조회(`lease`, `discovered_items`, `workstreams`)로 교체
- `skills/deep-loop-workflow/references/handoff-respawn.md`: host contracts, error matrix, no-retry rules
- `README.md`, `README.ko.md`, `CLAUDE.md`: 지원 범위·동의·revoke·smoke 상태
- CLI/runtime/schema/skill/hook 관련 기존 tests

Generic patch allowlist와 kernel-to-skill invocation boundary는 변경하지 않는다.

---

## 10. 검증 전략

### 10.1 순수/단위 테스트

- surface/runtime/stdin-mode correlation과 conflict→null/manual
- init ordering이 positive App/tool observation→live probe→no-write `init-run preflight`의 non-consent genesis guards/complete capability+observation digest→question→request-bound prepare→full init이고, eligible branch 질문 정확히 1회; partial/probe/READY/no-echo/preflight/cwd-source mismatch 실패 질문 0회 + enum-only manual. Preflight/full observation drift는 pre-write 거부, 승인 후 full-init 실패는 manual downgrade 0회
- init-only consent flags와 post-init `app-task consent` 부재; fenced observe-once surface CLI; probe 실패 enum-only manual genesis/observe와 partial→full upgrade fence
- auto genesis wrong runtime/surface/source/cwd/capability 조합 거부
- partial App capability 또는 live no-echo probe 실패는 enum-only App/manual(cwd/mode null)이고 CLI로 강등하지 않음; raw/path/mode/structured capability를 manual argv form에 넣으면 usage/invalid
- consent absent/decline/ambiguous/manual, explicit auto, revoke one-way, new run non-inheritance
- revoke first commit + exact response-loss retry `already-revoked` no event/write; default-manual `not-auto`; stale fence/terminal precedence
- host task cwd/recorded cwd/kernel cwd 3-way mismatch와 shell workdir spoof 거부
- POSIX exact/case-sensitive path, filesystem identity, symlink/descendant/prefix escape
- Windows separator/drive/case-sensitive-directory/sameFile fixtures와 UNC/identity failure
- project list 0/1/2 exact match, path absent, remote/worktree kind 거부
- active workstream exact match, duplicate/stale/status/path escape 거부
- opaque ID byte/control bounds, raw error normalization
- opaque thread ID quotes/space/`$`/backtick/backslash를 READY 이후 structured stdin으로 round-trip하고 command sentinel 미실행; raw thread ID argv/stdout/stderr/state-get output 0
- opaque project ID quotes/space/`$`/backtick/backslash는 최초 prepared action에서 direct `create_thread` tool arg로만 round-trip하고 command sentinel 미실행; 재진입/status/event/state-get에는 raw project ID 0개. Generic `state get` whole/parent/exact-leaf projection은 App `thread_id`/`unconfirmed_thread_id`/`project_id`를 모두 redacted하고 internal/on-disk state는 raw ID를 보존
- initialization attempt/request/previous-current/host-observation digest correlation, all production new-run writers required와 direct `buildInitialLoop` legacy fixture/state absence compatibility
- actual reader mode↔READY mode↔payload mode↔recorded session mode exact equality; preflight/full init mismatch pre-write invalid, post-init mismatch exit 3 no event/state
- request digest가 runtime/goal/resolved protocol+recipe/review/model/effort/root/canonical plugins_detected/git/session_spawn/consent/full observation 또는 enum profile을 구분하고 clock-derived timestamp만 제외함. Same attempt에 goal/protocol/recipe/review/model/effort/detected/git/session-spawn/source/capability/cwd/consent 중 하나를 바꾼 pending adoption/status/commit은 safe summary가 같아도 conflict
- fixed-attempt init fresh/already-initialized/recovered-pending/pending-only/hash-only/state-only recovery/different request·previous-current·observation/current conflict; exact expected-current+request status-first, A committed 뒤 later B pending 중 A commit/status는 동일 success precedence, still-running absent/pending no retry, known-exited absent exact retry, enum-only/new-attempt fallback 0회
- preflight/prepare/status 각각 pristine/existing root filesystem before/after byte snapshot이 동일하고 `.deep-loop`, lock/temp/pending/stale-delete write 0회. Status와 concurrent run state/hash/current mutation interleaving은 success 오판 없이 bounded `raced|indeterminate`
- App full/enum, existing Claude/Codex `init-run` one-shot, direct `initRun` child processes를 혼합 경합시켜 모두 같은 root lock/current CAS를 통과하고 current clobber가 없음
- root init lock candidate→exclusive-link publication, link success/EEXIST/unsupported/error candidate cleanup, hard-crash orphan candidate의 mutating-only dead-owner sweep, contention, owner-token release를 POSIX/Windows injected probe로 검증. Live/dead/unknown/PID-reused/invalid fixed holder 모두 automatic unlink 0; dead holder는 `LOCK_STALE_MANUAL` 무변경이고 두 stale contender interleaving도 새 lock 삭제/동시 writer 0. Exact owner release 뒤 새 publish 성공, old-token release가 새 lock unlink 0
- pending-write→hash temp/write/rename, hash→loop temp/write/rename commit marker, loop→current temp/write/rename, current→pending-delete 각 crash probe와 A pending/hash/state-only crash→same previous-current B commit 경합에서 B state 생성 0, exact A recovery 1, duplicate genesis/current clobber 0. No-loop+strict temp debris는 exact pending retry만 cleanup/recovery, unknown entry와 loop-present+missing/stale hash는 repair 없이 conflict
- state/schema correlation과 legacy absence compatibility
- non-configurable deadline constants, exact timestamp correlation, malformed/huge deadline schema rejection
- cross-log verifier가 attempt/child별 emit/prepare/confirm/acquire event `ts`와 state timestamp mismatch·누락·중복을 거부
- prompt context-mode/confirmation-first/self-contained contract
- prompt literal resume skill, logical/session/child IDs, workstream binding, acquire 후 session-profile refresh

### 10.2 상태기계/경합 테스트

- emit transaction부터 App transport/attempt가 결합됨
- final emit/prepare/confirm/acquire가 lock 뒤 `nowFn`을 정확히 한 번 표본화하고 event/state/deadline에 같은 instant를 사용; paired cost도 같은 표본이며 legacy caller clock 회귀 없음
- generic acquire가 emitted App attempt를 confirm 전/후 모두 거부
- generic release가 non-paused/non-terminal live App emitted/prepared/confirmed binding을 `app-transport-owned`, paused human-preserve binding을 기존 `RUN_PAUSED`로 각각 무변경 거부하고, App acquire/recover로 binding이 clear된 뒤 normal release/re-acquire는 기존대로 성공. 기존 completed/stopped + no-live-App terminal cleanup release의 exit 0/released regression test 보존; terminal live-binding fixture는 App-aware cleanup 전 generic partial release 0
- generic respawn/headless/driver가 App spawned re-entry를 소비하지 않음
- respawn precedence가 runtime/caller fence→terminal→App transport→key/phase이고 terminal App fixture도 기존 terminal outcome을 보존
- prepare first response actionable, repeated response do_not_call/no descriptor
- concurrent prepare에서 external action 권한이 정확히 하나
- reserve/final-emit/prepare-CAS 각 window의 revoke race; revoke가 먼저면 descriptor 0개, prepare commit이 먼저여도 confirm/acquire 차단
- outer gate 통과 뒤 same-generation accounting write로 budget 소진 시 in-lock gate 재검사가 descriptor를 막고 rollback/pause
- lock을 실제로 점유한 경쟁 probe에서 대기 중 wallclock/deadline 경과 시 prepare/confirm/sweep/readiness가 transaction 내부 `nowFn` 표본으로 fail-closed하고, CLI 진입 전 stale clock은 사용되지 않음
- prepare commit 직후 crash/no-return은 재-spawn 없음; fixed deadline 전 duplicate no-op와 deadline 후 exact sweep
- PreCompact/headless driver의 emitted prepare-deadline sweep과 prepared confirmation-deadline sweep
- create provisional receipt/fork documented receipt/send no-echo success와 모든 partial failure
- host-context/project/child-observation JSON과 receipt의 structured stdin process launch/write/no-return 실패, exact receipt retry, extra-line/oversize/invalid UTF-8 거부; here-doc/env/temp/base64/argv fallback 없음
- pipe-open/PTY-raw mode correlation, handler-before-READY ordering, wrong/missing/duplicate READY, READY 전 write, stdin closed, `setRawMode` 부재/throw, raw-mode restoration, timeout을 injected stream으로 검증. 실제 current host adapter canary에서 plain pipe write 실패/default PTY echo/PTY raw no-echo 결과를 evidence화하고, PTY raw/no-echo READY 뒤 actual receipt output에 echo 0을 검증
- confirm same receipt exact no-op, different receipt fence/no mutation
- child acquire before confirm 거부; confirm→acquire anchored success
- App acquire commit 응답 유실 뒤 exact status와 same observation retry는 exact `running + active/acquired + all live bindings null + matched acquired_at/generation` projection에서만 `already-acquired` event/write 0. Release, pause→recover, terminal cleanup, same-generation next reserve/emitted 및 다른 observation/cwd/runtime/surface/attempt interleaving은 no-op success 0/current status 또는 fence
- child acquire가 parent capability를 상속하지 않고 child-observed source/capabilities를 기록; capability drift는 다음 handoff를 manual로 만듦
- wrong child/generation/runtime/surface/cwd/attempt no mutation
- fast child race는 success, foreign generation은 fence
- readiness timeout exact-attempt precheck, same-generation fail/revoke/recover race, late child acquire
- recover/rollback/terminal cleanup correlation
- definitive app-task fail은 failed 보존, gate/pre-action/revoke/non-terminal recover/terminal은 abandoned, human-preserve failed recover는 failed+binding-clear라는 phase matrix
- App-acquired owner의 다음 reserve(pre-emit), gate rollback, create/fork/confirm failure rollback, recover(released/idle), terminal cleanup이 prior acquired provenance를 보존하면서 schema-valid
- App acquire → preserve/recover → generic fresh-owner acquire, explicit release → fresh-owner acquire, recover → same-owner generic re-acquire에서 old acquired_generation이 historical로 남고 current lease는 schema-valid
- 두 번 연속 App handoff/acquire에서 첫 acquired session이 superseded historical audit로 유효하고 둘째만 current lease owner가 됨; live lease binding 대 historical acquired/failed/abandoned phase-aware correlation
- revoke가 in-flight attempt를 abandoned로 만들고 confirm/acquire를 막는 race; no external cleanup
- event anchor chain remains valid after each transition

실제 interleaving hazard는 passing unit test만으로 닫지 않고 작은 child-process/parallel probe로 at-most-once와 confirmation-before-acquire를 확인한다.

### 10.3 Execution-plane integration과 static boundary

`tests/codex-app-task-continuation-integration.test.mjs`는 fake host adapter를 사용해 skill 관측부터 kernel readiness까지 아래를 한 경계로 실행한다. 파일명이 Gate 2 plan에서 달라지면 더 작은 동등 경계를 line/file 근거로 정당화하고 이 문서를 갱신한다.

- non-secret canary live probe의 exact READY/no-echo success → `init-run preflight` nonce READY 뒤 capability/source/mode/task-cwd observation 전달 및 digest → consent → request-bound prepare → full `init-run` fixed-binding READY 뒤 same observation 전달/commit → fenced handoff prepare descriptor → fake `create_thread`, 또는 `fork_thread(same-directory)` + `send_message_to_thread` receipt → static confirm process의 exact purpose/attempt READY 뒤 fake structured stdin write → child live probe 후 observation도 static acquire process의 READY 뒤 JSON stdin으로 전달 → exact reserved child acquire → parent readiness success
- denial, partial capability, probe/READY/echo failure, ambiguous project, create/fork/send error, invalid receipt, duplicate tick, prepare/confirm crash window에서 fake host action count와 durable phase를 함께 검증
- create prompt에는 `fresh`, fork prompt/state에는 `inherited-completed-history`와 completed-history 경고가 존재
- skills/hooks/references의 static scan으로 durable state 직접 쓰기가 없고 모든 post-init mutating CLI line에 `--owner --generation`이 있다. Fence-free 예외는 shared pending/request/current fence를 쓰는 genesis `init-run` commit과 true read-only `init-run preflight|prepare|status`, `app-task status`, `host-surface stdin-probe`뿐임을 검증. 기존 public `init-run`/direct `initRun` 밖의 current writer도 0개이며, fixed-format kernel nonce/digest 외 host-derived argv가 0개
- 최초 prepared create action/direct host call 이후 `app-task status`의 current/history/exact-attempt 형태와 `$deep-loop-status` fake transcript 모두 raw thread/unconfirmed/project/descriptor/host/cwd payload가 0개이고, status skill에 unqualified `state get`/whole session array 조회가 없음
- 모든 skill/reference의 unqualified `state get` static scan은 0개. App acquire→continue/discover/status와 recover→descriptor-less manual resume fake transcript에 raw receipt 0개
- `$deep-loop:deep-loop-resume`와 `handoff-respawn.md`는 redacted status를 whole sessions보다 먼저 호출하고 `has_app_history=true`이면 whole sessions를 호출하지 않음; `has_app_history=false` legacy branch만 기존 query 유지
- private URL/deeplink, Claude process launch, bare Codex executable fallback이 App route에 없고 default model/thinking override도 없음을 검증
- PreCompact/hook/headless driver static+fake-host test에서 App create/fork/send tool 호출이 0회임을 검증

### 10.4 회귀/호환 및 surface 증거

- 기존 runtime descriptor manual test 유지
- legacy loop fixtures에 새 field가 없어도 validate/preflight 통과
- Claude visible/desktop/headless, Codex CLI/manual, PreCompact emit-only, drive-headless 회귀
- macOS/Linux/Windows CI matrix와 Node 20/22
- full `npm run preflight`

Gate 5 evidence log는 아래 네 surface를 각각 별도 행으로 기록한다.

| Surface | 필수 evidence |
|---|---|
| Claude Code | 실제 interactive/visible/headless/handoff/resume smoke 또는 사용자가 명시 승인한 fixture/CI 대체 증거; App 질문/호출 0회 |
| Claude Desktop Code | 실제 Desktop Code smoke 또는 사용자가 명시 승인한 source-correlation + fixture/CI 대체 증거; 기존 desktop transport 유지, Codex App tool 0회 |
| Codex CLI | 실제 trusted visible/measured-headless/manual continuation smoke 또는 사용자가 명시 승인한 fixture/CI 대체 증거; App 질문/호출 0회 |
| Codex App | 승인/거절 root create, internal-worktree fork+message, confirm/acquire/readiness 실제 smoke |

실제 접근할 수 없는 surface/OS는 fixture와 CI가 보인 범위 및 한계를 정확히 기록하고, 실제 smoke 또는 완벽 호환이라고 주장하지 않는다. 해당 surface의 **대체 증거 수용을 사용자에게 별도로 요청해 명시 승인을 받은 경우에만** DoD 행을 통과시킨다. 사용자 승인 없이 compatibility DoD를 낮추지 않는다.

### 10.5 실제 Codex App smoke

로컬 plugin 설치/restart와 App task 생성은 별도 승인 뒤 clean disposable run에서만 한다.

현재 확인한 coupled install 계약은 저장소를 `~/.codex/plugins/deep-loop`에 copy/place하고 `~/.agents/plugins/marketplace.json`의 local entry `source.path`를 `"./.codex/plugins/deep-loop"`에 결합한 뒤, ChatGPT desktop App의 Work or Codex → Plugins에서 선택하고 App을 restart해 새 task를 시작하는 것이다. 현재 머신은 marketplace cache의 `deep-loop@claude-deep-suite` 1.8.1을 사용하며 personal coupled path/marketplace file은 존재하지 않는다. 따라서 smoke 전에는 생성/교체할 두 경로, backup, exact diff, restart, 복구 절차를 먼저 제시하고 별도 승인을 받는다. 기존 cache나 marketplace pin을 제자리에서 덮어쓰지 않는다.

1. root exact create: fresh task, local project, self-contained prompt, confirm 후 acquire
2. recorded internal worktree exact fork: same-directory, completed-history note, follow-up message, confirm 후 acquire
3. capability/path/project/structured-stdin probe·READY·no-echo ambiguity: no task creation, preserve/manual
4. duplicate prepare/re-entry: 새 task 추가 생성 없음
5. revoke: 이후 자동 continuation 없음

생성 task ID는 로그에 bounded/masked하게만 기록하고, smoke cleanup/archive는 별도 명시 승인 없이는 하지 않는다.

---

## 11. Review와 release gates

각 design/plan/implementation/release gate는 운영 계약대로 native Claude CLI `--model opus --effort xhigh` 세션에서 다음 loop를 실행한다.

```text
/deep-review-loop --no-codex --no-agy --max=5 --contract
```

Pass는 실제 reviewer가 Opus이고, `APPROVE`, Red 0, Yellow 0, 자연 수렴일 때뿐이다. `max_reached`, degraded, timeout, reviewer failure는 pass가 아니다. 모든 Info finding은 코드/계약 근거로 disposition하고 main agent가 독립 확인한다. Review 뒤 target artifact가 한 byte라도 바뀌면 기존 receipt는 무효이며 새 Opus/xhigh loop가 필요하다. Final report/summary/target hash, launcher argv, session ID, reviewer model evidence, Info disposition, main-agent 판정을 evidence log에 남긴다.

구현 순서:

1. 이 설계 강제 추적/커밋 → Gate 1 Opus/xhigh 수렴 리뷰 + main-agent 판정
2. `superpowers:writing-plans`로 TDD slice plan 작성/커밋 → Gate 2 focused plan review + Opus/xhigh 수렴 + main-agent 판정
3. Gate 3A host-surface/schema/genesis-consent/revoke slice를 strict TDD로 구현 → targeted tests → focused diff commit → Opus/xhigh 수렴 + main-agent 판정
4. Gate 3B App attempt/lease/CLI/PreCompact/headless-isolation slice를 strict TDD로 구현 → targeted tests와 concurrency probes → focused diff commit → Opus/xhigh 수렴 + main-agent 판정
5. Gate 4 descriptor/execution-plane skill/profile-refresh/docs slice를 strict TDD로 구현 → skill/descriptor/CLI tests → focused diff commit → Opus/xhigh 수렴 + main-agent 판정
6. Gate 5 cross-surface focused tests + full preflight. 별도 승인 뒤 coupled local install/restart와 실제 App create/fork/decline smoke → evidence commit → Opus/xhigh 수렴 + main-agent 판정
7. Gate 6 README/README.ko/CLAUDE/manifest/package/scaffold를 기능 추가 minor `1.9.0`으로 lockstep 갱신하고 release commit 생성(시작 base version이 달라지면 추측하지 않고 다시 승인) → clean whole-branch `npm run preflight` → **post-bump 전체 branch** Opus/xhigh release-ready 수렴 리뷰 + main-agent 판정
8. exact diff/commits/test/review/smoke evidence를 제시하고 **branch push 승인**을 받아 push한다. 그 결과와 target을 다시 제시해 **별도 PR 생성 승인**을 받아 PR을 만든다. CI와 PR review를 확인한 뒤 **별도 merge 승인**을 받아 merge한다.
9. merged main에서 metadata parity와 `npm run preflight`를 재확인한다.
10. **별도 post-merge sync 수정 승인**을 받은 뒤 deep-suite isolated worktree에서 두 marketplace manifest만 merged deep-loop main SHA로 re-pin하고 preflight한다. diff를 Opus/xhigh로 자연 수렴 리뷰한 뒤 exact commit/target을 제시해 **별도 push 승인**을 받는다. branch protection상 PR/merge가 필요하면 각각 승인받아 main 반영까지 확인한다.
11. deep-loop/deep-suite 반영 확인 후 별도 cleanup 승인을 받아 branch/worktree 및 승인된 smoke task만 정리한다.
12. release/cleanup 완료 뒤 `deep-wiki:wiki-ingest`를 실행하고 page id/path/title을 evidence와 final report에 기록한다.

---

## 12. 비목표와 accepted limits

- Codex App private APIs, current-thread ID scraping, private DB 조작
- remote project, App-managed worktree create target, cross-project continuation
- arbitrary descendant cwd나 unrecorded worktree 자동화
- task archive/delete/rename/pin 자동화
- model/thinking 자동 override
- failed/uncertain host call 자동 재시도
- genesis process hard-crash로 남은 fixed root init lock의 자동 stale reclaim. 상태는 `stale-manual`로 보존하고, 모든 관련 process 중단 확인 + 별도 사람 삭제 승인 뒤 exact pending/status recovery만 허용
- Claude Desktop native task continuation
- unattended/headless App task creation

Host provenance와 human consent는 execution-plane observation/authority이고 kernel이 cryptographically 증명할 수 없다. 안전 경계는 그 claim만이 아니라 exact path/capability checks, durable at-most-once prepare, explicit receipt confirmation, App-only acquire, hard gates, and fail-closed manual fallback의 결합이다.
