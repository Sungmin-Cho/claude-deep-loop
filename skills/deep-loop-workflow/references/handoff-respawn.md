# Handoff / Respawn 호출 규약

## 실행 루트

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

세션 전환(handoff)과 자율 재시작(respawn) 흐름을 정의한다. §9 참조.

## Lease identity

descriptor/current run의 `<run_id>`는 논리적(logical) loop run id이며 run 수명 동안 불변(immutable)이다. handoff/respawn mutation 직전 current lease를 새로 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`에서 얻는다. 이후 fenced 명령은 current owner/generation과 불변 logical run id를 함께 전달하며, `<run_id>`를 owner로 재사용하지 않는다.

## Handoff 호출자 3종

1. **마일스톤 도달** — `milestone_predicate` 통과 시 `/deep-loop-continue`가 자동 emit
2. **per_session_turn_cap 소진** — budget 게이트가 `handoff` action을 반환
3. **사람 수동 요청** — `/deep-loop-handoff`로 언제든 emit 가능

## §0.5 세션 model/effort refresh (handoff emit / respawn 전 항상)

handoff를 emit하거나 respawn하기 전에, 살아있는 세션이 자기 model/effort를 durable state에 갱신한다 — 자식이 부모와 같은 model/effort로 열리도록(self-healing). `intent:'lease'`라 handoff가 이미 emit되어 lease가 `releasing`이어도 통과한다:

현재 호스트가 알려 준 model과 effort를 직접 관측한다. 둘 다 있으면 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못했으면 `--effort`를 넣지 않은 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

- 관측된 값만 플래그로 포함(빈 effort 생략). 값이 그대로면 no-op(이벤트 안 쌓임). observation 실패 시 건너뛴다(기존 state로 진행).
- `lease.handoff_phase`가 `emitted`/`spawned`이면(PreCompact 안전망이 이미 emit) business write는 releasing carve-out으로 fence되므로, 정상 tick 작업을 건너뛰고 곧장 respawn 분기로 간다. phase `emitted`는 respawn이 갱신된 state로 launch를 빌드(self-heal 완결), phase `spawned`는 이미 뜬 자식이 `/deep-loop-resume`의 refresh로 다음 handoff에 교정한다.

## Windows launcher 승인 preflight (Handoff Emit 전에, handoff_phase=idle인 경우만)

launcher 승인은 `intent:recover` fence를 사용하므로 `handoff emit`이 lease를 `releasing`으로 바꾸기 **전에** 끝내야 한다. 이미 `emitted`/`spawned`이면 승인을 시도하지 말고 수동 fallback/respawn 분기로 간다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_spawn --project-root "<canonical_project_root>" --run-id <run_id>
```

Windows에서 reason이 `windows-terminal-unverified` 또는 `powershell-unverified`이면 PATH·고정 경로를 추측하지 말고 사람이 제공한 절대 `.exe` 하나로 read-only 진단한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" launcher-executable diagnose --kind <wt|powershell> --path "<human_supplied_absolute_exe>" --project-root "<canonical_project_root>" --run-id <run_id>
```

반환된 `canonical_path`와 lowercase `sha256`을 그대로 보여 주고 `AskUserQuestion`으로 명시적 사람 승인을 받는다. `--confirm` 자동 생성/auto-confirm은 금지한다. 사람이 동일 path/SHA를 확인한 경우에만 실행한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" launcher-executable approve --kind <wt|powershell> --path "<same_absolute_exe>" --canonical-path "<diagnosed_canonical_path>" --sha256 "<diagnosed_lowercase_sha256>" --actor human --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

경로 미제공, 진단 실패, 승인 거절이면 durable 상태를 바꾸지 않고 수동 fallback을 유지한다. 스킬은 상태 파일을 직접 쓰지 않는다.

## Handoff Emit (legacy/non-App only)

Before this generic command, the caller must perform App route selection before generic emit. An eligible attended Codex App run skips this section, follows the App handoff protocol below, and treats it as a terminal branch. Do not continue to generic `handoff emit` or any `respawn`. Only App-ineligible, manual, headless, or non-App runs use this generic emit.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --reason "<reason>" --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

산출물:
- `handoffs/<timestamp>-next-session.md` — 다음 세션용 컨텍스트
- `handoffs/<timestamp>-compaction-state.json` — 압축 상태
- `terminal/launch-command.txt` — 재시작 명령

### Attended Codex App handoff protocol

This branch is valid only for durable `runtime=codex`, parent `host_surface=codex-app` whose
kernel-owned `observed_generation` exactly equals the current lease generation,
`auto/human-confirmed` consent, a complete recorded route capability set, and a current attended App
host assertion. The prepare mutation re-derives the same generation-bound authority under lock.
A stale positive surface may only reach the human preserve-pause path; it cannot call an App tool.
PreCompact and headless never enter this branch.

1. Before any App task tool call, run this command from the actual current task cwd:
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit --reason "<reason>" --trigger "<trigger>" --owner <owner_run_id> --generation <generation> --app-intent --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   `--app-intent` is a boolean only: never put route, target cwd, workstream, attempt, project ID, or host payload in argv. The kernel derives root versus one recorded active worktree from fresh durable parent state plus `process.cwd()`, rechecks App surface/source/capabilities/stdin mode/auto consent in the final emit transaction, and generates or exact-reuses the App attempt. Generic emit remains legacy and cannot be upgraded.

   If and only if this command fails with `APP_EMIT_AUTHORITY_FENCED`, make zero discovery or App
   tool calls and read safe status. The stale-origin fallback is allowed only when status proves the
   same logical run/owner/generation, `handoff_phase=idle`, no current App attempt, no
   `recovery_pending`, and `manual_recovery=false`; any reservation, emitted child, terminal state,
   foreign fence, corrupt read, or ambiguous result stops for manual diagnosis. With that exact
   proof, run the same reason and trigger through generic `handoff emit`—the identical command above
   with only `--app-intent` removed. Require its direct result to contain
   `appOriginFallback=true`, then require safe status to show the same generic emitted child with
   `resume_policy=human` before running:
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <generation> --mode preserve --reason "app-authority-unconfirmed:<reason>" --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   The kernel sets human policy in the generic emit transaction, so a concurrent driver is fenced
   even before the pause commits. If the generic emit or pause result is lost, reconcile only by safe
   status; never emit again. This stale-origin fallback makes zero `list_projects` calls, zero `app-task prepare` calls, zero public App tool calls, and zero `respawn` calls, then presents
   manual `$deep-loop:deep-loop-resume` guidance.
2. From the safe emit result/argumentless safe status obtain only `<emitted_attempt_id>`, then immediately run:
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task status --attempt <emitted_attempt_id> --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   Before any discovery or task call, verify emitted attempt/owner/generation/route: `logical_run_id=<run_id>`, `owner_run_id=<owner_run_id>`, `generation=<generation>`, `handoff_phase=emitted`, `current.attempt_id=<emitted_attempt_id>`, `current.phase=emitted`, and `current.route` matches the kernel-produced root `create` or exact active-worktree `fork` route. Missing/mismatched fields stop for manual recovery. This redacted check never reads whole sessions or raw IDs.
3. Root route only after step 2: call `list_projects` exactly once through a bounded timeout/no-return wrapper. The current App may expose the logical tool result as an already-decoded value, canonical JSON wire text, or one already-decoded transport envelope. The sole transport envelope is a realm-safe non-Proxy plain own-data object with exact keys `contentItems` and `success`, `success === true`, and `contentItems` as a canonical dense one-element plain array. Its sole item is a realm-safe non-Proxy plain own-data object with exact keys `type` and `text`, `type === "inputText"`, and string `text`. The envelope is transport only, not a logical receipt layer: require `text` itself to be canonical JSON, then decode that logical JSON exactly once. An envelope with an accessor, Proxy, custom prototype, symbol, extra/missing key/item, false success, wrong type, non-JSON text, or non-canonical text is invalid; a top-level JSON string encoding the transport envelope is also invalid rather than a second transport decode. For direct canonical JSON wire text and transport `text`, enforce the 1,048,576-byte cap before parsing, reject BOM or leading/trailing whitespace, require `JSON.stringify(JSON.parse(raw)) === raw`, decode exactly one logical layer, and reject a decoded string with a whitespace/BOM-prefixed JSON object/array marker. An already-decoded App value may originate in a different V8 realm: do not require its prototype object to be reference-equal to the controller realm's `Object.prototype` or `Array.prototype`. Accept only null/local prototypes or foreign built-in prototypes whose complete own-key order, descriptors, native members, parent chain, and intrinsic constructor backlink are equivalent to the controller realm built-ins; this realm-safe check must not read receipt property values. Then require the decoded v1 receipt to be a non-Proxy plain/null-prototype top-level data object with exactly `schemaVersion` and `projects`, require `schemaVersion === 1`, and require `projects` to be a non-Proxy canonical dense plain-array data-property array. Every project row must be a non-Proxy plain/null-prototype own-enumerable-data-property object with at most 16 scalar fields and own string `projectId`, `projectKind`, and `path`; Proxy, symbol, accessor, inherited/custom-prototype, sparse/custom/subclass array, nested extra value, non-finite number, or exceeded bound is invalid. Build a bounded project projection containing only those three fields, with at most 256 entries and at most the structured-input byte cap. A bare array makes discovery unavailable. A non-canonical/double-encoded/malformed wire value, malformed transport envelope, extra or missing logical envelope key, unsupported schema version, discovery throw/timeout/no-return, invalid entry, exceeded bound, or unsafe projection does the same; do not retry and do not call `app-task fail` while the attempt is still `emitted`. Worktree fork/manual routes: `list_projects` call count is 0.
4. Start the fixed prepare process:
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task prepare --owner <owner_run_id> --generation <generation> --stdin-mode <pipe-open-noecho|pty-raw-noecho> --app-host-input-stdin --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   Match the full exact `DEEP_LOOP_STDIN_READY:v1:app-prepare:<owner_run_id>.<generation>:<mode>` line. On successful root discovery send `{ "host_task_cwd": <current_host_task_cwd>, "projects": <bounded_projection> }`; on discovery unavailable send only `{ "host_task_cwd": <current_host_task_cwd> }` and omit the `projects` field. The latter must return `manual-preserve`, keep the child phase `emitted`, set human resume policy, and authorize zero App task actions. Send exactly one bounded JSON line through structured process input in either case. If the prepare process result is lost, boundedly poll that original process handle and make zero App task tool calls while it is live or unknown. Once exit is proven, read redacted exact-attempt status. Only a still-`emitted` attempt with `manual_recovery=false`, exact owner/generation, `handoff_phase=emitted`, and a live deadline may run the same prepare binding and byte-identical input once. An `emitted` projection with `manual_recovery=true` is the durable `manual-preserve` outcome: perform zero prepare retries, zero App task tool calls, and zero automatic sweep, then present manual recovery immediately. Only a `prepared` attempt with `manual_recovery=false` may run that exact re-entry to obtain `already-prepared` with `do_not_call=true`, then must make zero external App actions and wait for its strict deadline. For either an expired `emitted` attempt or an expired `prepared` attempt with `manual_recovery=false`, run exactly:
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task sweep-unconfirmed --owner <owner_run_id> --generation <generation> --attempt <attempt_id> --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   No new prepare or host action is allowed, and a lost sweep result is reconciled only by redacted exact-attempt status. Any phase/policy/fence mismatch stops without another mutating process.
5. `do_not_call=true` means stop without any App tool call. Only a directly observed first exact `do_not_call=false` result authorizes one action; a lost actionable prepare response is never reconstructed from status or retried at the host-tool boundary.
6. For `action.tool=create_thread`, pass `action.prompt` and `action.target` directly to `create_thread`.
   Omit model and thinking. Success requires exactly one own root `threadId` string that passes the bounded opaque receipt validator. The only second ID-shaped field allowed is an optional own root `hostId`; when present, it is validated independently with the same bounded opaque rules, is non-authoritative metadata, and is discarded immediately after validation. The returned execution-plane projection contains only `threadId`. Missing/multiple/nested/plural/alternate ID, another shape, `clientThreadId`, an invalid `hostId`, a control byte, or a UTF-8 value over 512 bytes is `invalid-host-receipt` failure.
   Before strict receipt validation, apply the same bounded canonical-JSON and realm-safe plain-data adapter from step 3; decoded values and already-decoded values then use the identical validator. Non-canonical, malformed, BOM/whitespace-prefixed, oversized, double-encoded object/array text, or a non-equivalent foreign/custom prototype is `invalid-host-receipt`, not a reason to retry.
7. For `action.tool=fork_thread`, call `fork_thread` once with `environment.type=same-directory`. Before `send_message_to_thread`, apply step 6's wire adapter and pass the complete decoded fork result through the same strict recursive receipt validator, with the create-only `hostId` allowance disabled: the root must have a plain/null prototype; every traversed property must be an own enumerable data property; symbol, accessor, custom-prototype, function, non-finite/bigint/symbol value, or cyclic shapes fail; case-insensitive keys ending in `id|ids|identifier|identifiers` count as ID-shaped fields; and exactly one such field must exist as the own root `threadId` whose bounded opaque UTF-8 value is at most 512 bytes. Receipt traversal is fail-closed at maximum depth 32, maximum total nodes 1024, and maximum container entries 256; check array length before allocating or enumerating expected indices. Missing/multiple/nested/plural/alternate/control/surrogate/oversize/bounds-exceeded fork IDs are `invalid-host-receipt`; make zero message calls. Only after this validation, retain the fork ID in memory and call `send_message_to_thread` once for that same child with `action.followup.prompt`.
   Omit model and thinking. Apply the wire adapter once to the send result too. A decoded null/undefined/string/finite-number/boolean send receipt, or a recursively valid plain object/exact plain array with zero ID-shaped fields, is success. An array must have the local `Array.prototype` or an equivalent foreign intrinsic Array prototype accepted by step 3's descriptor, parent-chain, and constructor-backlink checks. Array index descriptors must be canonical dense own data descriptors with `enumerable=true,writable=true,configurable=true`, and the canonical `length` data descriptor has `enumerable=false,writable=true,configurable=false`; custom key, symbol, accessor, hole, frozen/non-writable index, or subclass prototype fails. If a send receipt has an ID-shaped field, it must have exactly one own root `threadId`, pass the same bounded opaque validator, and byte-equal the fork ID. Any non-canonical/double-encoded object/array wire text, nested, plural, alternate, multiple, accessor, symbol, custom-prototype, cyclic, or mismatched send ID is `message-unconfirmed` with the already-known fork receipt and never authorizes a resend. Function, custom-array, and bounds-exceeded send receipts are the same `message-unconfirmed` failure.
8. After create success or fork plus message success, start:
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task confirm --owner <owner_run_id> --generation <generation> --attempt <attempt_id> --stdin-mode <pipe-open-noecho|pty-raw-noecho> --receipt-stdin --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   For confirm, send the raw UTF-8 opaque ID itself, at most 512 bytes, followed by exactly one LF through structured process input. Match the full exact `DEEP_LOOP_STDIN_READY:v1:app-confirm:<attempt_id>:<mode>` line before sending; JSON, quotes, or an object are forbidden. A 513-byte value must fail closed. Never put the ID in argv, environment, temp files, logs, or reports. If the confirm process result is lost, boundedly poll only that original process handle; while liveness is unknown, stop. After exit is proven, read redacted exact-attempt status and run the exact confirm command again with the same raw receipt and mode—never another create/fork/send call. A committed first confirm returns the write-free `already-confirmed` (or exact acquired completion); an uncommitted live-deadline confirm performs the one commit. A different receipt, expired first confirm, or a second lost result stops for status/manual diagnosis.
9. Start the await mutation:
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task await --owner <owner_run_id> --generation <generation> --attempt <attempt_id> --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   Only exact child acquisition is success.

Timeout, no-return, dynamic error, malformed receipt, or uncertain completion is failure and does not authorize a host-tool retry. These commands are valid only after `do_not_call=false` changed the attempt to `prepared`; discovery failure follows step 3 instead.

- With no usable receipt, run:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task fail --owner <owner_run_id> --generation <generation> --attempt <attempt_id> --code <host-call-timeout|host-call-no-return|host-call-failed|invalid-host-receipt> --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  This ordinary fail form has no stdin flags, emits no READY, and consumes no receipt bytes. Do not start a second failure process if its result is lost; poll that handle and use redacted exact-attempt status.
- For fork message uncertainty with the already-known fork receipt, start:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task fail --owner <owner_run_id> --generation <generation> --attempt <attempt_id> --code message-unconfirmed --stdin-mode <pipe-open-noecho|pty-raw-noecho> --receipt-stdin --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  For message-unconfirmed, send the known raw UTF-8 opaque ID itself, at most 512 bytes, followed by exactly one LF. Match the full exact `DEEP_LOOP_STDIN_READY:v1:app-fail:<attempt_id>:<mode>` line before sending; JSON, quotes, or an object are forbidden. A 513-byte value must fail closed. Never resend the message.

Do not resend, archive, delete, rename, pin, open a private URL, launch Claude, or launch a bare Codex executable.

## Visible Respawn 결정 흐름 (Task 12)

handoff emit 후 spawn style을 결정한다.

### 1. 이미 emit된 핸드오프 확인 (PreCompact 안전망)

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

`lease.handoff_phase === 'emitted'`이면 reserved child 존재 — **re-emit 금지**, 바로 분기 평가로.

### 2. Terminal 감지

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" detect-terminal --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

`session_spawn.launcher`와 `autonomy.spawn_style`을 읽는다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_spawn --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field autonomy --project-root "<canonical_project_root>" --run-id <run_id>
```

### 3. Spawn Style 분기 (커널 `resolveSpawnMode` 우선순위 headless > desktop > visible > interactive와 동일 순서로 먼저 판정)

**unattended** (커널 `isHeadlessInvocation(env)` 마커 전용 — `DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS`/드라이버 entrypoint 휴리스틱; **non-tty는 신호가 아니다**. **가장 먼저 판정** — desktop/visible보다 우선): 드라이버가 처리. tty 유무만으로는 이 분기에 들어가지 않는다 — Claude Desktop Code 탭처럼 사람이 지켜보는 non-tty GUI 세션은 마커가 없으면 아래 desktop/visible/else 분기로 흐른다(§init의 "attended" 정의와 동일 기준). **이 마커가 하나라도 있으면 durable `autonomy.spawn_style`이 `desktop`이든 `visible`이든 무조건 이 분기가 우선한다** — desktop opt-in한 run이라도 현재 호출이 headless라면(예: drive-headless 사이클 도중) 아래 desktop 분기로 새지 않는다(커널 `resolveSpawnMode`의 headless-preempts-desktop, 불변식 #6). **스킬은 여기서 `respawn`을 직접 호출하지 않는다** — drive-headless 래퍼 없이 직접 호출하면 측정 usage가 계상되지 않아 예산/fail-closed 모델이 깨진다.

> **현재 Codex transport 경계:** 승인된 native runtime이 있으면 measured `codex-jsonl` headless continuation을 사용할 수 있다. macOS/Linux에서는 그 승인 runtime과 양성 감지된 absolute `cmux` executable + exact socket이 있을 때 visible continuation이 활성화되고, macOS에서는 고정 `/usr/bin/osascript`로 양성 검증된 **선택된** iTerm2 또는 Terminal.app만 활성화된다. 네이티브 Windows에서는 승인된 runtime + WT/PowerShell launcher identity가 있을 때 shell-free visible continuation이 활성화된다. 승인 runtime이 없으면 `runtime-identity-unavailable`, launcher 증적이 없거나 바뀌면 launcher identity 오류로 CAS 전 preserve-pause하며, 지원되지 않는 visible 경로는 `codex-transport-not-activated`로 닫힌다. 어떤 경우에도 Claude transport로 대체하지 않는다. **Codex App 자동 task 생성은 eligible attended terminal branch에서만 지원하며, ineligible/manual/headless 경로는 수동 App resume을 제시한다.**

**desktop** (`spawn_style==='desktop'` — init 시 opt-in한 Claude Desktop 딥링크 재시작, `launcher===none`이어도 유효. **위 unattended 마커가 없을 때만** 해당):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

visible과 동일한 명령 — 커널이 검증된 desktop 엔트리(`open -a`/직접 실행)로 자동 재시작한다. 선택은 init에서 확정된 durable 값이라 재질문하지 않는다.

핸들러 프로브가 (앱 삭제/이동, 서명 변경 등으로) 실패하면 `desktopProbe` unavailable → `buildLaunchCommand`가 unavailable entry를 반환 → 아래 `else`(preserve-pause) 분기로 흐른다. `spawn_style`은 opt-in 시점에 이미 라이브 프로브로 검증된 뒤에만 durable하게 저장되므로(round-6 리뷰 수정, `confirmDesktop`의 `HANDLER_UNVERIFIED` 가드) 이 실패는 어디까지나 "이후에 깨진" 경우다 — 반복되는 preserve-pause에서 벗어나려면 사람이 `spawn-style reset-desktop`으로 `desktop → visible` 복구 후 재확인해야 한다(아래 "사람 탈출 수단" 참고).

**visible** (`spawn_style=visible` + `launcher≠none`):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --attended --project-root "<canonical_project_root>" --run-id <run_id>
```

커널이 자동으로 새 세션을 시작한다. 스킬이 직접 `claude -p`나 `codex exec --json`을 실행하지 않는다(§9).

**else** (`launcher=none` / visible 아님 / legacy interactive — 예: desktop opt-in을 거절/억제한 attended non-tty 세션):

respawn을 통해 게이트를 먼저 평가한다 — unfenced pause 전에 항상 respawn 경유 필수(Codex r6 CRITICAL):

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" respawn --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

respawn의 `outcome`에 따라 분기:

- **`gate-blocked`**: respawn이 이미 rollback + `status=paused` 처리 완료. 다시 pause 하지 않는다.
  사람에게 게이트 해소 후 수동 재개를 안내한다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
  ```

- **`no-launcher`**: 게이트 통과 — 이제 preserve-pause가 적합. fence flag 필수(R6-plan):
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <n> --mode preserve --reason "needs-human:<reason>" --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  > **R6-plan 필수**: `handoff emit`이 lease를 `releasing`으로 전환했으므로 `--owner`/`--generation` fence가 반드시 필요하다. Unfenced `pause`는 exit 3(LEASE_FENCED)으로 실패 → run이 un-paused 상태로 남음 → stale takeover 위험.

  `terminal/launch-command.txt` 내용을 사람에게 제시한다.

- **그 외** (`fenced` 등): 보고만 하고 pause 하지 않는다.

## Interactive vs Headless

### Interactive (사람 개입)

`terminal/launch-command.txt` 내용을 사람에게 제시한다 — 사람이 직접 새 세션을 시작한다.
respawn은 드라이버만 수행한다 (스킬이 직접 spawn하지 않음).

### Headless / 미감시 자율

커널 `isHeadlessInvocation(env)`가 참(`DEEP_LOOP_UNATTENDED`/`DEEP_LOOP_HEADLESS` set, 또는 드라이버 entrypoint 휴리스틱)이거나 `autonomy.spawn_style==='headless'`이면 headless 강제 — **non-tty는 신호가 아니다**(resolveSpawnMode, `scripts/lib/respawn.mjs`).
드라이버(`drive-headless.mjs`)는 run의 immutable runtime을 선택하고 그 runtime의 trusted(검증·승인된) executable만 사용한다. **Claude**는 bounded `claude -p --output-format json --permission-mode acceptEdits` JSON을 파싱하고, 승인된 **Codex**는 인증된 격리 `CODEX_HOME`과 shell-free `codex exec --json`의 incremental JSONL을 파싱해 각각 정확한 한 turn usage를 기록한다.

두 경로 모두 timeout/non-zero/측정불가 usage에서 fail-closed하며 다른 runtime으로 대체하지 않는다(**교차 런타임 fallback은 하지 않는다**). 미감시 자율은 **headless 강제**이고, Codex App의 자동 새 task 생성은 지원하지 않으므로 App 연속성은 수동 resume이다.

## Respawn 게이트 순서

respawn이 내부적으로 평가하는 순서:
1. `budget` — `checkBudget` 통과?
2. `breaker` — `checkBreaker.tripped === false`?
3. `sessions < max_sessions` — 세션 한도 미초과?
4. `wallclock < max_wallclock_sec` — 벽시계 한도 미초과?
5. `auto_handoff` — 자율 handoff 허용?

**게이트 차단 시**: `status=paused` 기록 후 stop. 스킬이 외부에서 게이트를 선검사하지 않는다 — canonical 평가는 respawn 내부에서 일어난다.

## 비용 회계 모델 (Codex r5 critical-2)

**진짜 무인 장기 실행**의 비용은 **drive-headless 드라이버**가 측정 usage를 `budget record`로 권위있게 커밋한다(단일 출처).

**PreCompact respawn**은 세션 연속을 위한 안전망이라 spawnFn의 measured usage를 기록하지 않고 버린다 — 인수한 **자식 세션이 자기 drive 사이클에서 자기 비용을 회계**한다(이중계상 방지).

**Interactive tick**은 시작 시 `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`을 만족하는 `interactive-<uuid>` 형태의 `<accounting_request_id>`를 한 번 만들고 tick context에 보존한 뒤 best-effort로 `budget record --turns <n> --request-id <accounting_request_id> --owner <owner_run_id> --generation <n>` 자기보고. 응답이 모호해 같은 tick을 재시도하면 같은 request ID를 재사용하고, 다음 tick에는 새 ID를 사용한다. `DEEP_LOOP_UNATTENDED` set 시 자기보고를 생략한다 — drive-headless가 측정 usage를 권위있게 기록하므로 이중계상 방지.

**커널 경계 자동 floor (#3)**: self-report와 무관하게, 커널은 각 business mutation(`episode new/record/abandon`·`review record/import`·`workstream new/set/terminal`·`state patch`·`comprehension ack`·`finish`)마다 최소 1 turn을 `appendAnchored`로 **자동 계상**한다(생략 불가). 명시 `budget record`는 그 tick의 floor를 **대체**한다(max 규칙 — 보고값과 floor 합 중 큰 값, 합산 아님). 따라서 self-report는 best-effort 보정일 뿐이고, **`max_wallclock_sec`(default 86400s)이 self-report와 무관한 authoritative hard bound**다. 예산 시맨틱 = best-effort self-report + 커널 자동 floor + wallclock hard bound.

## Resume 흐름

handoff descriptor가 제공한 `<canonical_project_root>`, logical `<run_id>`, 실제 `<claude|codex>` runtime assertion을 그대로 사용한다. ambient cwd/current pointer로 이 identity를 재추론하지 않는다.

새 세션 시작 시 Claude는 `/deep-loop-resume --project-root "<canonical_project_root>" --run-id <run_id>`, Codex는 `$deep-loop:deep-loop-resume --project-root "<canonical_project_root>" --run-id <run_id>`:
1. Handoff document보다 먼저 redacted App status와 explicit lease를 읽고 triple을 exact correlate한다.
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task status --project-root "<canonical_project_root>" --run-id <run_id>
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   Explicit lease에서는 `state`, `owner_run_id`, `generation`, `handoff_phase`, `handoff_transport`, `handoff_attempt_id`, `handoff_child_run_id`, `handoff_idempotency_key`, `resume_policy`, `expires_at`만 사용한다. App status만으로 released/cleared state를 추론하지 않는다. Document read, probe, mutation 전에 status owner/generation/phase가 lease와 exact-equal이어야 한다. Mismatch는 zero mutation으로 argumentless status→lease를 한 번 restart하고 두 번째 mismatch는 manual recovery다. Exact-attempt status도 같은 correlated triple을 요구한다.

   Cleared binding은 transport/attempt/child/key/policy/expiry 여섯 필드가 모두 null인 경우뿐이다. App history가 있으면 whole sessions를 읽지 않고, `has_app_history=false` branch만 `session_chain.sessions`를 읽는다.

   - `recovery_pending`이 모든 후보보다 우선한다. Status의 exact paused/newest-unstarted-abandoned-recover/recovery-binding proof와 explicit lease의 released/idle/cleared shape, root-contained handoff document의 logical-run/child correlation이 모두 필요하다. Descriptor가 없으면 recovery projection만 child/path authority다. Old failed/abandoned App history alone은 권한이 아니다.
   - `recovery_pending=null`일 때 current generic binding이 historical App보다 우선한다. Live releasing reservation, normally released current owner, audited recovered current owner 중 exact one shape만 허용한다. Current-owner shape는 `owner_run_id=generic_current.run_id`을 요구하고 `handoff_rel=null`도 허용하지만, non-null path는 실제 document correlation을 통과해야 한다. Descriptor는 current lease를 대체하지 않는다.
   - Prompt attempt가 있는 App history는 exact attempt status의 run/child/attempt/route/path와 correlated lease를 비교한다. `prepared`는 bounded wait한다. `confirmed`는 child live probe와 exact READY/no-echo 뒤 child-current six-key observation으로 `app-task acquire`한다. `manual_recovery=true`는 `app-child-timeout-awaiting`에서만 이 acquire를 유지한다.
     ```
     node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task status --attempt <attempt_id> --project-root "<canonical_project_root>" --run-id <run_id>
     node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface stdin-probe --project-root "<canonical_project_root>" --stdin-mode <pipe-open-noecho|pty-raw-noecho> --probe-stdin
     node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task acquire --owner <child_run_id> --generation <parent_generation> --runtime codex --attempt <attempt_id> --stdin-mode <pipe-open-noecho|pty-raw-noecho> --observation-stdin --project-root "<canonical_project_root>" --run-id <run_id>
     ```
   - `current.phase=acquired`는 candidate only다. Acquire 응답이 유실됐을 때 original acquire process handle을 보존해 boundedly poll하고, live/unknown 동안 새 process를 시작하지 않는다. Current acquired status/lease correlation과 exit is proven 뒤 original `--generation <parent_generation>`, 동일 runtime/cwd/mode, byte-identical child observation을 포함한 READY-gated original command를 반복해 `already-acquired`만 수락한다. Original-handle reconciliation이 없으면 App acquire를 쓰지 않는다. Failed/abandoned live App binding은 human-preserve이며, cleared terminal history도 same-call exact `recovery_pending` 없이는 acquire하지 않는다.
   - Historical acquired row는 recovery/current-generic이 모두 null이고 explicit lease가 released, acquired-or-idle, cleared, `owner_run_id=current.run_id`임을 증명하며 descriptor 또는 unique history/document correlation까지 통과할 때만 generic 후보가 된다.

   Generic 후보는 그 규칙이 유일하게 선택한 child/generation으로 다음 단일 CAS를 실행한다.
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" lease acquire --owner <child_run_id> --generation <new_generation> --expect-generation <current_generation> --runtime <claude|codex> --project-root "<canonical_project_root>" --run-id <run_id>
   ```

   Kernel `ok:true`만 성공이다. Terminal/fence/takeability failure는 중단한다. Acquire는 parent recorded capability를 복사하지 않고 child-current public tools를 이 exact contract로 새로 관측한다.

       APP_OBSERVATION_CONTRACT_V1={"tool_to_kernel":{"list_projects":"list-projects","create_thread(local)":"create-thread-local","fork_thread(same-directory)":"fork-thread-same-directory","send_message_to_thread":"send-message-to-thread","structured_input":"structured-process-stdin"},"raw_template":{"kind":"codex-app","source":"codex-app-tool-provenance","capabilities":[],"structured_stdin_mode":null,"host_task_cwd":null,"host_task_cwd_source":"app-task-context"}}

2. App acquire success는 child surface를 atomically materialize하고 generic acquire/observe로 fall through하지 않는다. Generic acquire success는 bounded no-echo stdin probe 후 full READY-gated observe 또는 enum-only observe를 정확히 한 번 시도한 뒤에만 session-profile을 갱신한다. Full form은 exact owner/generation-bound READY line을 match한 뒤 현재 task cwd를 kernel process cwd와 같은 native directory로 식별하는 exact six-key JSON 한 줄만 보낸다.
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface stdin-probe --project-root "<canonical_project_root>" --stdin-mode <pipe-open-noecho|pty-raw-noecho> --probe-stdin
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface observe --owner <child_run_id> --generation <new_generation> --runtime <claude|codex> --stdin-mode <pipe-open-noecho|pty-raw-noecho> --observation-stdin --project-root "<canonical_project_root>" --run-id <run_id>
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface observe --owner <child_run_id> --generation <new_generation> --runtime <claude|codex> --manual-enums --host-surface <allowlisted_surface> --host-source <allowlisted_source> --capabilities <comma_separated_non_structured_allowlisted_capabilities> --project-root "<canonical_project_root>" --run-id <run_id>
   ```
   Empty enum capability argv는 생략한다. Same-generation exact repeat는 write-free이고 later-generation identical facts는 `observed_generation`/`observed_at`만 anchored re-attest한다. 성공 outcome은 `observed`, `reattested`, `already-observed`뿐이다. Changed observation은 fence한다. Both forms fail/ambiguous이면 추가 observe 없이 prior mismatched generation을 stale manual-only로 보존하며 null authority로 만들지 않는다.
3. active workstream worktree 경로 무결성 확인(existsSync → 소실 시 needs-human)
3.5. per-action worktree **진입은 `/deep-loop-continue`가 next-action의 `action.workstream_id` 기준으로 수행**한다(resume은 특정 worktree로 미리 진입하지 않음 — 다중 병렬 오진입 방지).
4. Claude는 `/deep-loop-continue`, Codex는 `$deep-loop:deep-loop-continue`로 진행

## 사람 탈출 수단: recover --confirm

`preserve-paused` 또는 게이트 차단으로 stuck된 run을 사람이 복구한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

stale handoff 상태를 정리하여 새 `lease acquire`가 가능하도록 한다. 이후 runtime에 맞는 `/deep-loop-resume` 또는 `$deep-loop:deep-loop-resume`으로 인수.
autonomous tick이 스스로 `recover --confirm`을 발행하지 않는다.

**desktop opt-in 전용 복구 (round-6 part c):** `recover --confirm`은 handoff/lease 상태만 정리할 뿐 `autonomy.spawn_style`은 건드리지 않는다(generic `state patch`는 `autonomy.spawn_style`을 forbid — classifyPatch). 확인됐던 desktop 핸들러가 이후 깨져 매 handoff가 `HANDLER_UNVERIFIED`(prospectively, 위 desktop 분기 참고)로 preserve-pause를 반복하면, 사람이 별도로:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" spawn-style reset-desktop --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

로 `desktop → visible`을 fenced 전이시킨 뒤(`desktop`이 아니면 exit 1 `SOURCE_INVALID`), 다시 opt-in 절차(§2-5-1)를 밟아 재확인할 수 있다.
