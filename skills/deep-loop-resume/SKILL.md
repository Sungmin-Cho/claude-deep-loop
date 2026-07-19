---
name: deep-loop-resume
description: "deep-loop resume — entry point for a respawned fresh session: reads only the handoff.md and loop.json, acquires the session lease, attaches active worktrees, and continues. Triggered by '/deep-loop-resume', '$deep-loop:deep-loop-resume', 'resume the loop', 'take over the session', 'continue handed-off work', '루프 이어가기', '세션 인수', '이어서 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-resume\" })."
user-invocable: true
---

> [!IMPORTANT]
> **Skill body echo 금지** — 이 스킬 본문을 사용자에게 그대로 출력하지 말 것.
> 사용자의 언어(language)를 감지하여 같은 언어로 응답한다.
> **handoff.md + loop.json만 읽는다** — 이전 대화 컨텍스트를 절대 가정하지 말 것.
> **비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only**, 항상 사람 승인(human approval)을 받는다.

## 실행 루트와 호스트 호출

로드된 `SKILL.md` 경로에서 이 플러그인의 absolute(절대) 루트를 계산하고, 아래 argv 템플릿의 `DEEP_LOOP_ROOT`를 실행 전에 그 절대 경로로 치환한다. literal `DEEP_LOOP_ROOT` 문자열을 Node에 전달하는 것은 금지한다. 환경 변수나 셸 확장으로 루트를 만들지 않는다.

호출은 Claude에서 `/deep-loop-resume`, Codex에서 `$deep-loop:deep-loop-resume` 형식을 사용한다.

## 개요

Claude에서는 `/deep-loop-resume`, Codex에서는 `$deep-loop:deep-loop-resume` — 리스폰된 새 세션의 진입점이다. handoff descriptor가 넘긴 `--project-root "<canonical_project_root>" --run-id <run_id>`를 필수 입력으로 사용하고, 현재 실제 호스트를 `<claude|codex>`로 assertion한다(환경 마커로 추론하지 않음). handoff.md와 loop.json을 읽고 세션 lease를 CAS 인수한 뒤 active worktree를 확인한다.

descriptor의 `<run_id>`는 논리적(logical) loop run id이며 owner 세션이 바뀌어도 run 수명 동안 불변(immutable)이다. `<child_run_id>`는 이번 acquire에만 쓰는 새 owner 후보이며 둘을 합치지 않는다.

## 단계 1–2: Status-first handoff 확인과 단일 lease 인수

먼저 redacted App status, 이어서 explicit safe lease를 각각 한 번 읽는다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task status --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

명시적 lease projection에서는 `state`, `owner_run_id`, `generation`, `handoff_phase`, `handoff_transport`, `handoff_attempt_id`, `handoff_child_run_id`, `handoff_idempotency_key`, `resume_policy`, `expires_at`만 사용한다. App status만으로 cleared binding이나 released state를 추론하지 않는다. status `owner_run_id`, `generation`, and `handoff_phase` must exact-equal the explicit lease. Handoff 문서 읽기, stdin probe, mutation보다 이 상관 검증이 먼저다. Mismatch는 zero mutation으로 argumentless status와 lease의 bounded read-only sequence를 처음부터 한 번 restart하고, 두 번째 mismatch는 manual recovery다. 이후 exact-attempt status도 성공한 같은 lease triple과 일치해야 하며, 불일치하면 전체 bounded sequence를 restart한다. 모든 acquire는 이 correlated pair의 generation만 사용한다.

STATUS_LEASE_MISMATCH_TRANSCRIPT_V1={"status":{"owner_run_id":"P","generation":1,"handoff_phase":"idle","recovery_pending":"A"},"lease":{"owner_run_id":"P","generation":2,"handoff_phase":"idle"},"decision":"zero-acquire-restart"}

Cleared binding은 `handoff_transport=null`, `handoff_attempt_id=null`, `handoff_child_run_id=null`, `handoff_idempotency_key=null`, `resume_policy=null`, `expires_at=null` 전부를 뜻한다.

Acquire payload는 parent의 recorded capability를 복사하지 않는다. Child live probe 뒤 child task의 current callable public tools를 새로 관측하고 다음 exact contract로 투영한다.

    APP_OBSERVATION_CONTRACT_V1={"tool_to_kernel":{"list_projects":"list-projects","create_thread(local)":"create-thread-local","fork_thread(same-directory)":"fork-thread-same-directory","send_message_to_thread":"send-message-to-thread","structured_input":"structured-process-stdin"},"raw_template":{"kind":"codex-app","source":"codex-app-tool-provenance","capabilities":[],"structured_stdin_mode":null,"host_task_cwd":null,"host_task_cwd_source":"app-task-context"}}

`raw_template`의 `capabilities`, `structured_stdin_mode`, `host_task_cwd`만 child current observation으로 채운 exact six-key line을 사용한다. `structured_input`은 child probe success 뒤에만 `structured-process-stdin`으로 투영한다. `kernel_cwd_at_observation`, `observed_generation`, `observed_at`, raw project/thread ID는 보내지 않는다.

- recovery_pending outranks every other candidate. Exact `recovered:awaiting-resume`와 실제 handoff document correlation이 모두 있어야 generic `lease acquire` 후보가 된다. Safe status의 `recovery_pending`이 non-null이고, status가 `paused`, newest unstarted `abandoned_recover` session, 그 session의 durable `recovery_binding`과 current lease owner/generation의 동일성을 이미 증명해야 한다. Explicit lease는 exact `state=released`, `handoff_phase=idle`, cleared binding이어야 한다. Root-contained `handoff_rel`을 실제로 읽어 handoff document의 logical run과 projected child가 일치해야 한다. Document는 lease owner/generation authority가 아니다. `transport=codex-app`이면 terminal phase/attempt가 present descriptor와도 일치하고, `transport=generic`이면 둘 다 null이어야 한다. Descriptor is absent이면 child/path는 `recovery_pending`에서만 얻고 같은 document correlation을 수행한 뒤 generic `lease acquire` 후보가 된다. Old failed/abandoned App row alone은 never authority다.
- The current generic binding outranks historical App. `generic_current`는 exact `state=releasing` live shape 또는 exact `state=released` current-owner shape만 generic `lease acquire` 후보로 만든다. `recovery_pending=null` 뒤 `generic_current={run_id,handoff_rel}`가 non-null이어야 하고 다음 세 lease shape 중 정확히 하나여야 한다. Live reservation은 `state=releasing`, `handoff_phase=emitted|spawned`, null transport/attempt, bounded non-null child/key, `generic_current.run_id=handoff_child_run_id`, non-null root-contained document와 logical-run/child equality를 요구한다. Normally released current owner는 `running`, `state=released`, `handoff_phase=acquired|idle`, cleared binding, `owner_run_id=generic_current.run_id`을 요구한다. 이 normally released current owner는 `handoff_rel=null`이어도 generic `lease acquire` 후보를 유지한다. Audited recovered current owner는 `paused`, exact `recovered:awaiting-resume`, `state=released`, `handoff_phase=idle`, cleared binding과 같은 owner equality를 요구한다. 두 current-owner shape에서는 initial/current parent나 definitive App failure 뒤 release/reacquire처럼 `handoff_rel=null`도 유효하고, non-null path는 root/document correlation을 통과해야 한다. Descriptor가 있으면 logical run, child, non-null handoff path가 generic current/document와 모두 일치해야 하며 current lease를 대체하지 않는다. Descriptor is absent이면 `generic_current`의 non-null path만 authority로 쓰고 같은 document correlation을 수행한 뒤 generic `lease acquire` 후보가 된다. `recovery_pending`과 generic current는 상호 배타다.
- `has_app_history=true`: must not query `session_chain.sessions`. Prompt attempt가 있으면 exact status를 읽는다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task status --attempt <attempt_id> --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  Logical run, descriptor child, attempt, route, handoff path와 correlated lease triple을 비교한다. `prepared`는 bounded wait한다. Explicit lease projection을 우선해 exact phase를 판단하고 summary `manual_recovery` flag만으로 권한을 만들지 않는다. Exact `confirmed` with `manual_recovery=true` remains acquirable only for `app-child-timeout-awaiting`. 먼저 child live probe를 실행한다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface stdin-probe --project-root "<canonical_project_root>" --stdin-mode <pipe-open-noecho|pty-raw-noecho> --probe-stdin
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" app-task acquire --owner <child_run_id> --generation <parent_generation> --runtime codex --attempt <attempt_id> --stdin-mode <pipe-open-noecho|pty-raw-noecho> --observation-stdin --project-root "<canonical_project_root>" --run-id <run_id>
  ```
  Probe의 full-line anchored `DEEP_LOOP_STDIN_READY:v1:stdin-probe:<32_hex_process_nonce>:<mode>`/no-echo success 뒤 acquire의 exact `DEEP_LOOP_STDIN_READY:v1:app-acquire:<attempt_id>:<mode>`를 match하고 child-current six-key observation 한 줄만 보낸다. 성공 응답의 owner/generation으로 승격해 단계 2.5로 간다.
- `current.phase=acquired`: redacted status is a candidate only. Acquire 응답이 유실됐을 때 original acquire process handle을 보존해 boundedly poll하고, live/unknown 동안 새 process를 시작하지 않는다. Exit is proven 뒤 동일 runtime/cwd/mode와 byte-identical child observation으로 READY-gated acquire를 반복해 kernel `already-acquired`만 성공으로 받아 fenced `session-profile set`으로 간다. Original-handle reconciliation이 없으면 App acquire를 쓰지 않고 아래 cleared/released historical rule만 평가한다.
- A failed/abandoned row with `handoff_transport=codex-app`, non-null App attempt/child binding, 또는 `handoff_phase=emitted|spawned`는 human preserve이며 never acquires. `manual_recovery=true` alone도 completed recovery proof가 아니다. Cleared binding인 terminal App row는 audit-only다. Failed/abandoned 뒤 `recovery_pending` alone이 exact same-call proof를 제공하지 않으면 acquire 금지다. Lease `released/idle`과 old `current.run_id`만으로 이후 generic owner/recovery를 되살리지 않는다.
- Historical `current.phase=acquired`는 `recovery_pending=null`, `generic_current=null`, explicit lease의 `state=released`, `handoff_phase=acquired|idle`, cleared binding, `owner_run_id=current.run_id`을 모두 요구한다. Descriptor가 있으면 descriptor child가 `current.run_id`과 같아야 한다. Descriptor가 없으면 `current.handoff_rel`이 root-contained이고 history에 same run/attempt/path row가 정확히 하나이며 실제 handoff document가 logical run과 child를 반복해야 한다. Active/releasing, terminal, later generic owner, next reservation, descriptor/history mismatch는 모두 중단하며 이 owner-correlated released shape만 generic `lease acquire` 후보다.
- `has_app_history=false`: 이 branch만 legacy sessions를 읽는다:
  ```
  node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
  ```

Exactly one recovery-pending, current-generic, owner-correlated acquired-history, or history-free 후보만 다음 single generic acquire를 실행한다.

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" lease acquire --owner <child_run_id> --generation <new_generation> --expect-generation <current_generation> --runtime <claude|codex> --project-root "<canonical_project_root>" --run-id <run_id>
```

Kernel `ok:true`만 수락한다. `run-terminal`, fence, takeability failure는 중단한다. 성공 뒤 `<owner_run_id> = <child_run_id>`, `<generation> = <new_generation>`으로 승격한다. Recovery-pending, current-generic, owner-correlated acquired-history, or history-free 모두 session profile 전에 fresh child surface를 materialize한다.

1. Current callable public tools를 새로 projection하고 parent observation을 복사하지 않는다. 다음 host-surface stdin-probe를 bounded no-echo로 시도한다.
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface stdin-probe --project-root "<canonical_project_root>" --stdin-mode <pipe-open-noecho|pty-raw-noecho> --probe-stdin
   ```
2. Probe success이면 READY-gated full observation을 한 번 실행한다. Exact owner/generation-bound READY line을 match한 뒤 현재 task cwd를 kernel process cwd와 같은 native directory로 식별하는 exact six-key JSON 한 줄만 보낸다.
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface observe --owner <child_run_id> --generation <new_generation> --runtime <claude|codex> --stdin-mode <pipe-open-noecho|pty-raw-noecho> --observation-stdin --project-root "<canonical_project_root>" --run-id <run_id>
   ```
3. Probe failure이면 enum-only observation을 정확히 한 번 실행하고 empty projection이면 `--capabilities` argv 두 token을 모두 생략한다. 이 form은 positive enums와 kernel cwd만 기록하고 host cwd/source-of-cwd/mode는 null로 남기므로 App continuation을 enable하지 않는다.
   ```
   node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" host-surface observe --owner <child_run_id> --generation <new_generation> --runtime <claude|codex> --manual-enums --host-surface <allowlisted_surface> --host-source <allowlisted_source> --capabilities <comma_separated_non_structured_allowlisted_capabilities> --project-root "<canonical_project_root>" --run-id <run_id>
   ```
4. Same generation exact repeat는 write-free다. Identical facts at a later generation은 anchored re-attestation으로 `observed_generation`과 `observed_at`만 갱신한다. 성공 outcome은 `observed`, `reattested`, `already-observed`뿐이다. Changed 또는 partial-to-full observation은 fence되고 prior attestation을 보존한다. If both observe forms fail 또는 completion이 ambiguous하면 추가 observe를 호출하지 않는다. Prior `observed_generation`과 current lease generation mismatch는 stale manual-only history이며 null로 가장하지 않고 lease를 유지한다. Only after this observation attempt may `session-profile set` execute.

App acquire success는 surface를 atomically materialize했으므로 generic acquire/observe로 fall through하지 않고 단계 2.5로 간다.

## 단계 2.5: 세션 model/effort refresh (acquire 직후)

lease를 인수해 이 세션이 owner가 된 직후, 자기 실제 model/effort를 durable state에 갱신한다 — 부모가 `--model`/`--effort`로 정확히 띄웠어도, desktop transport(URL은 flag 못 실음)나 사람의 `/model` 변경으로 이 세션의 실제 값이 state와 다를 수 있으므로:

현재 호스트가 알려 준 model과 effort를 직접 관측한다. 둘 다 있으면 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --effort "<session_effort>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

effort를 관측하지 못했으면 `--effort`를 넣지 않은 다음 완전한 명령을 사용한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" session-profile set --model "<session_model>" --owner <owner_run_id> --generation <generation> --project-root "<canonical_project_root>" --run-id <run_id>
```

acquire가 owner를 이 세션으로 바꾸고 generation을 올리며 paused run을 running으로 되돌리므로, 이 setter는 새 owner/generation + `intent:'lease'`로 통과한다. 실패(예: 여전히 paused)하면 best-effort로 건너뛰고 다음 `/deep-loop-continue` §0.5가 갱신한다.

## 단계 3: Active Worktree 확인

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
```

각 active workstream의 worktree 경로 무결성을 확인한다. 경로 소실 시 조용히 재생성하지 않는다 — `needs-human`으로 표시하고 사람에게 보고한다.

## 단계 3.5: Worktree 진입 위임

resume은 특정 worktree에 미리 진입하지 않는다. per-action worktree 진입은 `/deep-loop-continue` §1.5(`action.workstream_id` 기반)에 위임한다 — `max_parallel` 환경에서 여러 active workstream이 존재할 때 잘못된 worktree로 라우팅되는 것을 방지한다.

resume이 단계 4에서 `/deep-loop-continue`를 호출하면, continue가 `action.workstream_id`를 기준으로 올바른 worktree에 자동 진입한다.

## 단계 4: 진행

이어서 진행(`resume`)한다:

Claude에서는 `/deep-loop-continue`, Codex에서는 `$deep-loop:deep-loop-continue`를 invoke한다.

다음 action을 `next-action --json`으로 읽고 계속한다.

## 사람 탈출 수단: recover --confirm

`preserve-paused` 상태이거나 respawn 게이트가 차단된 run이 stuck(교착 상태)이면 사람이 직접 복구할 수 있다:

recover 대상 descriptor/current run의 불변 `<run_id>`로 현재 lease를 먼저 읽고, `<owner_run_id>`는 `session_chain.lease.owner_run_id`, `<generation>`은 `session_chain.lease.generation`으로 새로 설정한다:

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
```

```
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" recover --confirm --owner <owner_run_id> --generation <n> --project-root "<canonical_project_root>" --run-id <run_id>
```

이 명령은 stale handoff 상태를 정리하여 새 `lease acquire`(CAS 인수)가 가능하도록 한다. 커널이 un-pause를 처리하며, 다음 세션에서 runtime에 맞는 `/deep-loop-resume` 또는 `$deep-loop:deep-loop-resume`으로 lease를 인수한다.

> 이 명령은 사람이 실행한다 — autonomous tick이 스스로 `recover --confirm`을 발행하지 않는다.
