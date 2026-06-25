#!/usr/bin/env bash
# PreCompact hook — deep-loop clean-handoff safety net.
# Bash 3.2 compatible. Best-effort: never blocks compaction.
set -Eeuo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
IMPL="$PLUGIN_ROOT/scripts/hooks-impl/precompact-handoff.mjs"

# stdin(JSON)을 그대로 .mjs 로 파이프. 실패해도 compaction 을 막지 않도록 exit 0.
if [ -f "$IMPL" ]; then
  node "$IMPL" || true
fi
exit 0
