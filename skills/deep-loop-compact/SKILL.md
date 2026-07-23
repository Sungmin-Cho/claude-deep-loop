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

Read the current lease and current owner-session runtime again:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.lease --project-root "<canonical_project_root>" --run-id <run_id>
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" state get --field session_chain.sessions --project-root "<canonical_project_root>" --run-id <run_id>
```

Inspect through the public reader even when trusted SessionStart context names
a relative checkpoint:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" checkpoint inspect --json --project-root "<canonical_project_root>" --run-id <run_id>
```

Use only the returned relative `<checkpoint_rel>`, then invoke the public
fenced restore validator:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" checkpoint restore --checkpoint <checkpoint_rel> --owner <owner_run_id> --generation <generation> --runtime <claude|codex> --json --project-root "<canonical_project_root>" --run-id <run_id>
```

On success, continue in the same owner session. Claude invokes
`/deep-loop-continue`; Codex invokes `$deep-loop:deep-loop-continue`.

If trusted host context explicitly reports
`provider-evidence-mismatch` or
`checkpoint-unavailable-with-trusted-evidence`, do not retry without trusted evidence
and do not claim same-chat identity. Print the exact fenced
preserve-pause command below and host resume guidance; execution requires the
current owner session and is never implicit. Set `<pause_reason>` to exactly
`host-session-lost` before invocation:

```text
node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" pause --owner <owner_run_id> --generation <generation> --mode preserve --reason "<pause_reason>" --project-root "<canonical_project_root>" --run-id <run_id>
```

For a stale, corrupt, foreign, or missing checkpoint without a trusted
evidence rejection, freshly re-read `session_chain.lease`,
`session_chain.sessions`, the owner scope, current Workstream, and current
episode. State-derived continuation is allowed only when those fresh values
prove the same owner, generation, and open bound Workstream affinity. Then
delegate to the same runtime-specific continue command above. Otherwise print
the same fenced preserve-pause command and native host resume guidance.

Never acquire a lease, emit a handoff, invoke a respawn route, create a new
session, or request a terminal transition from compact prepare or restore.
