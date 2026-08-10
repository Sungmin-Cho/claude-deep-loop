@AGENTS.md

# deep-loop — Claude Code notes

`AGENTS.md` above is the whole guide, shared by both hosts. Only what is specific
to Claude Code lives here.

## Hook events

`DEEP_LOOP_ROOT/hooks/hooks.json` binds Claude Code's **PreCompact**, **PostCompact**, and
**SessionStart** events to `DEEP_LOOP_ROOT/scripts/hooks-impl/precompact-handoff.mjs`,
`DEEP_LOOP_ROOT/scripts/hooks-impl/postcompact-observe.mjs`, and
`DEEP_LOOP_ROOT/scripts/hooks-impl/sessionstart-restore.mjs`. Codex support remains host-version-dependent.
Their bounded, non-spawning contract is invariant 7 — it applies wherever the code runs, and
it is stated once, in `AGENTS.md`.

## Dispatch

Where the Execution plane dispatches a descriptor as a subagent, that is the
`Skill()` tool here. The measured headless path on this host is bounded
`claude -p` JSON; the approved Codex path is shell-free `codex exec --json`.
Both are described in `AGENTS.md` §Architecture, because a change to either
affects the same kernel contract.

## Commit trailer

```text
Co-Authored-By: Claude Opus <noreply@anthropic.com>
```

Model name only, **no version or variant**, so the line does not drift as sessions
change model.
