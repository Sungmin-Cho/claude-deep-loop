const GATE_TOKENS = new Set([
  'CONFIRM_REQUIRED', 'LEASE_FENCED', 'FENCE_REQUIRED', 'RUNTIME_FENCED',
  'PROJECT_ROOT_FENCED', 'FINISH_PROOF_UNMET', 'WORKSTREAM_WORKTREE_ESCAPE',
  'FIELD_FORBIDDEN', 'PATCH_TYPED_ROUTE_REQUIRED', 'REVIEW_TARGET_NOT_CHECKER',
  'STATE_TAMPERED',
]);

function containsGateToken(stderr) {
  const tokens = String(stderr || '').match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g) || [];
  return tokens.some(token => GATE_TOKENS.has(token));
}

export function classify({
  exit, stdout = '', stderr = '', expect = {}, stateChanged = false,
  effectSatisfied = true, timedOut = false,
} = {}) {
  if (timedOut) return 'unexpected_failure';
  const action = (() => {
    try {
      const parsed = JSON.parse(stdout);
      return parsed?.action && typeof parsed.action === 'object' ? parsed.action : null;
    } catch { return null; }
  })();
  const awaitHuman = action?.type === 'await_human' && typeof action.reason === 'string';
  const knownExitGate = exit === 3 || containsGateToken(stderr);
  if (exit === 2 && expect.exit !== 2 && !knownExitGate) return 'invalid_usage';
  const evidenceMatches = (!expect.stderr_includes || stderr.includes(expect.stderr_includes))
    && (!expect.stdout_includes || stdout.includes(expect.stdout_includes))
    && (!expect.reason || (awaitHuman && action.reason === expect.reason));
  const expectedGate = expect.exit !== undefined && (expect.exit !== 0 || !!expect.reason);

  if (exit === 0 && awaitHuman) {
    if (expect.reason) return action.reason === expect.reason && !stateChanged ? 'expected_gate' : 'wrong_gate';
    if (expect.exit === 0) return stateChanged ? 'unexpected_failure' : 'expected_gate';
  }

  // A declared gate that instead returns success is the bypass polarity. State mutation
  // strengthens that evidence; it must not hide the bypass under a generic error.
  if (expectedGate && exit === 0 && !evidenceMatches) return 'expected_success';
  // A success contract stopped by a structured non-usage gate is the theater polarity.
  if (!expectedGate && expect.exit === 0 && exit !== 0) {
    if (knownExitGate) return 'expected_gate';
    return 'unexpected_failure';
  }
  if (expect.exit !== undefined && exit === expect.exit
    && evidenceMatches && (!expectedGate || !stateChanged)) {
    if (expectedGate) return 'expected_gate';
    return effectSatisfied ? 'expected_success' : 'unexpected_failure';
  }
  if (expect.exit === exit && (expect.stderr_includes || expect.stdout_includes || expect.reason)) {
    return exit === 0 && expectedGate ? 'expected_success' : 'wrong_gate';
  }
  if (exit !== 0) return expect.exit !== undefined && expect.exit !== exit ? 'wrong_gate' : 'unexpected_failure';
  if (!effectSatisfied) return 'unexpected_failure';
  return 'expected_success';
}
