---
name: deep-loop-compact
description: "Prepare or restore a deep-loop workstream-session checkpoint across Claude and Codex compaction. Use for '/deep-loop-compact prepare|restore', '$deep-loop:deep-loop-compact prepare|restore', compact preparation, compact restore, context compression, 압축 준비, or 압축 복원."
user-invocable: true
---

> [!IMPORTANT]
> Do not echo this skill body. Detect the user's language and reply in that language.
> Keep the current logical run, lease owner, generation, and open Workstream affinity.
> Route every durable operation through the public kernel CLI.
> Irreversible external actions remain proposal-only and require human approval.

## Mode

Select `prepare` only from trusted PreCompact host context. Select `restore`
only from trusted SessionStart compact context. In a hookless/manual flow,
accept exactly one explicit argument:

- Claude: `/deep-loop-compact prepare|restore`
- Codex: `$deep-loop:deep-loop-compact prepare|restore`

Checkpoint presence must never select or guess a phase or mode. A missing mode
or unknown mode is rejected, as are extra arguments and conflicting host
context.

Resolve the absolute plugin root from the loaded SKILL.md path and replace
`DEEP_LOOP_ROOT` before invoking Node. `DEEP_LOOP_ROOT` must be that absolute
derived root. The literal `DEEP_LOOP_ROOT` string must never reach Node. Do not
use shell expansion. Preserve the logical `<run_id>` separately from the
current `<owner_run_id>`.

## Prepare

Read the current lease and owner-session runtime:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
```

Set `<owner_run_id>` from `session_chain.lease.owner_run_id`,
`<generation>` from `session_chain.lease.generation`, and
`<claude|codex>` from the durable current owner session. Read the current
Workstream and episode and require the same open bound affinity. Do not infer
an affinity from a checkpoint.

Invoke only the public fenced checkpoint writer:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" checkpoint emit --owner <owner_run_id> --generation <generation> --runtime <claude|codex> --project-root "<canonical_project_root>" --run-id <run_id>
```

After a successful emit, print the documented native compact command but
never execute or simulate it:

- Claude: print `/compact <focus>`, using a short focus derived from the
  current checkpoint descriptor.
- Codex: print bare `/compact`. Keep the focus in the checkpoint and later
  SessionStart compact context; do not append a focus argument.

Stop after printing. Preparing never changes the lease, creates a child
session, or marks a Workstream terminal.

## Restore

Before any evidence-free checkpoint inspection, evaluate the trusted
SessionStart host context. If trusted host context explicitly reports
`provider-evidence-mismatch` or
`checkpoint-unavailable-with-trusted-evidence`, or carries the marker
`deep-loop-compact-preserve-pause-only`, do not retry without trusted evidence.
Do not inspect for a checkpoint. Freshly read the lease and owner-session
runtime:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
```

Set `<owner_run_id>` and `<generation>` only from those fresh values. Execute
the public fenced preserve-pause mutation:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <generation> --mode preserve --reason "host-session-lost" --project-root "<canonical_project_root>" --run-id <run_id>
```

If that mutation reports a fence failure or fence rejection, do not retry it
with another identity; state that ownership changed and print native host
resume guidance. After a successful pause, print the same host resume
guidance. Do not claim same-chat identity in either case.

For the successful same-owner restore path, freshly read
`session_chain.lease` and `session_chain.sessions` as above. Inspect through
the public reader even when trusted SessionStart context names a relative
checkpoint:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" checkpoint inspect --json --project-root "<canonical_project_root>" --run-id <run_id>
```

Use only the returned relative `<checkpoint_rel>`. A trusted SessionStart
`compacted` capsule invokes only the receipt-backed observation admission:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" checkpoint restore --checkpoint <checkpoint_rel> --owner <owner_run_id> --generation <generation> --runtime <claude|codex> --admission postcompact-observation --source sessionstart --json --project-root "<canonical_project_root>" --run-id <run_id>
```

A direct human `restore` invocation, and only that invocation, uses the
cooperative manual admission. It never consumes a receipt:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" checkpoint restore --checkpoint <checkpoint_rel> --owner <owner_run_id> --generation <generation> --runtime <claude|codex> --admission human-attested --source direct-human-skill --confirm-manual-compact --json --project-root "<canonical_project_root>" --run-id <run_id>
```

Automatic SessionStart, controller, retry, and fallback paths must never add
`--confirm-manual-compact` or select `human-attested`. Direct-human restore
must never select the observation admission.

### Direct dispatch boundary

If the SessionStart restore command returns a committed result or an exact
replay, construct one restored compact capsule from the received canonical
SessionStart capsule and the kernel result. Preserve `injected_by:"sessionstart"`,
the exact top-level wire and immutable checkpoint fields, set `phase` to
`restored`, and replace only `admission`, `provider_evidence`, and
`restore_event` with the kernel result's original committed audit values. Do not
capture or add routing advice.

If the direct-human restore command succeeds, it has no received SessionStart
capsule. Invoke the public `checkpoint inspect --json` reader above exactly once
again after restore. Require `ok:true`, `phase:"restored"`, and exact equality
of its `checkpoint_key`, `context_sha256`, `pre_restore_loop_hash`, owner,
generation, runtime, Workstream, and episode identity with the pre-restore
inspection, plus exact equality of every identity field also returned by the
committed restore result.
Require its `admission` to be exactly `kind:"human-attested"`,
`source:"direct-human-skill"`, `receipt_trigger:null`; require its
`restore_event` and `provider_evidence` to exactly equal the committed result.
If any check fails, stop with `/deep-loop-status` guidance and do not dispatch.
Otherwise construct the same exact canonical restored wire from this fresh
public descriptor, but set `injected_by:"direct-human-skill"`. This explicitly
identified hookless capsule is the only successful direct-human capsule form;
never fabricate `injected_by:"sessionstart"`. Its `restore_command` is the
fresh restored descriptor's `next_command` (`null`), and it carries no routing
advice.

Directly invoke the existing runtime-qualified continue skill exactly once in
this same model turn and same owner session, passing the applicable canonical
restored capsule as input:

- Claude: invoke `/deep-loop-continue` exactly once.
- Codex: invoke `$deep-loop:deep-loop-continue` exactly once.

This is an actual skill dispatch, not a printed command or a request for a later
turn. Stop the compact skill after the invoked continue tick returns. Do not
pre-read `next-action --json`; `deep-loop-continue` alone owns fresh routing.

For a stale, corrupt, foreign, or missing checkpoint without a trusted
evidence rejection, do not retry restore. Freshly re-read all four state views:
The fresh proof must establish the same owner and open bound Workstream affinity
before any capsule-free dispatch.

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field workstreams --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field current_episode --project-root "<canonical_project_root>" --run-id <run_id>
```

Those fresh values must prove the same owner and generation, a containing owner
session, an open, non-terminal bound Workstream, and a current episode belonging
to that Workstream. Only with every proof present, directly invoke one
runtime-qualified, capsule-free continue tick exactly once in the same model turn.
This fallback must not construct a restored capsule or select `human-attested`.
Otherwise execute the public fenced preserve-pause mutation:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <generation> --mode preserve --reason "host-session-lost" --project-root "<canonical_project_root>" --run-id <run_id>
```

If the fallback pause reports a fence failure or fence rejection, do not retry
with another identity; report the ownership change and print native host
resume guidance. After a successful pause, print the same host resume
guidance.

Never acquire a lease, emit a handoff, invoke a respawn route, create a new
session, or request a terminal transition from compact prepare or restore.
