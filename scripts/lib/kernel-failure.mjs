// unclassified: 'exit-1' (default, preserves inline catch fold) | 'rethrow' (fail-stop)
export function classifyKernelError(e) {
  const message = String(e?.message || e);
  if (/^(?:LEASE_FENCED|FENCE_REQUIRED|RUNTIME_FENCED|PROJECT_ROOT_FENCED|PROJECT_BINDING_FENCED)(?::|$)/.test(message)) {
    return { code: 3, message };
  }
  if (/^(?:INVALID_NOW|INVALID_RUNTIME(?:_STATE)?|PROJECT_ROOT_UNRESOLVABLE|PATH_TARGET_INVALID|WORKSTREAM_NOT_FOUND|RUN_DIR_ESCAPE|WORKSTREAM_WORKTREE_ESCAPE)(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  if (/^CHECKPOINT_[A-Z_]+(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  if (/^(?:INVALID_ACTOR|INVALID_GENERATION|INVALID_STORED_ROOT_DIGEST|PROJECT_ROOT_REBIND_NOT_ALLOWED|RUN_ID_INVALID|STATE_INVALID)(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  if (/^(?:RUNTIME_EXECUTABLE_|LAUNCHER_EXECUTABLE_|CODEX_HOME_)(?:[A-Z_]+)(?::|$)/.test(message)) {
    return { code: 1, message };
  }
  return null;
}

export function kernelFailure(cause, { extra = [], unclassified = 'exit-1' } = {}) {
  const message = String(cause?.message || cause);
  for (const [prefix, code] of extra) {
    if (message.startsWith(prefix)) return { code, message };
  }
  const classified = classifyKernelError(cause);
  if (classified) return { code: classified.code, message: classified.message };
  if (unclassified === 'rethrow') throw cause;
  return { code: 1, message };
}
