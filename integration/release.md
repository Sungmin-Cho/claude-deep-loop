# Release — post-merge deep-suite sync

Release-time procedure only. `AGENTS.md` §Release links here so the steps are not resident
in every session; the approval gate itself is invariant 5 in `AGENTS.md`, which applies
whether or not this file has been read.

Only after this repo's PR merges **and a separate post-merge sync approval is granted**:
set the `deep-loop` entry `sha` to the merged `main` commit in the deep-suite registry
(`.claude-plugin/marketplace.json` + `.agents/plugins/marketplace.json`), then run
deep-suite `npm run preflight`, which regenerates the README tables — never edit inside
the auto-generated markers.

The patch is pre-written at `DEEP_LOOP_ROOT/integration/deep-suite.patch.md`. It is a proposal, not
evidence that distribution has already been synchronized or released. Registration adds
discoverability only; deep-loop runs standalone with no sibling installed.
