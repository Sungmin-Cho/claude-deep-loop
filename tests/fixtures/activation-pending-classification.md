# Activation-pending classification — live overlay

This tracked overlay resolves the pinned seed into the current execution surface. The seed remains immutable; this file owns post-design export deltas and the strengthened machine/human boundary.

- Seed SHA-256: `6f6202df0e365f0e68a4f1e81a0a6242d80b1cc493a7acde91d587fdaad7bf13`
- Reviewed design SHA-256: `b56b161c883eae957718b70fabc31bbec293ba4173e6404cac542aeea9abc61a`
- W1: every E2–E5/E7/E8 declaration body or initializer fails when `writeState`, `appendEvent`, or `appendAnchored` is directly called **or directly referenced**.
- W2: the W1 domain is the closed set E2, E3, E4, E5, E7, E8; no E subclass may be silently omitted.
- Machine boundary: guards 1–4, rule-B canonicalization, bidirectional/disjoint partition, direct/transitive call reachability, same-mutation-lock dominance, closed reason enum, and classification/reason/recalculation consistency.
- Machine boundary extension: `breaker.mjs#recordReviewVerdict`, `comprehension.mjs#ack`, and `state.mjs#patch` retain honest `conditional-dominates` leaseCheck evidence while a separate same-lock proof requires their absent-fence `ACTIVATION_PENDING` fallback to dominate every write.
- Human boundary: only non-static X/E reason semantics and the remaining seven live `conditional-dominates` L public wirings remain for the step-4 checker. A tracked file cannot authenticate observer independence.

<!-- F26-LIVE-JSON-BEGIN -->
{
  "schema_version": 1,
  "seed_sha256": "6f6202df0e365f0e68a4f1e81a0a6242d80b1cc493a7acde91d587fdaad7bf13",
  "design_sha256": "b56b161c883eae957718b70fabc31bbec293ba4173e6404cac542aeea9abc61a",
  "expected_counts": { "L": 28, "B": 7, "X": 34, "E2": 116, "E3": 12, "E4": 15, "E5": 1, "E7": 73, "E8": 26 },
  "base_x_reasons": {
    "safety-downgrade": ["attended-launch.mjs#revokeAttendedLaunch", "spawn-optin.mjs#resetDesktop"],
    "boot-observation": ["detect-terminal.mjs#detectAndPersist"],
    "pause-direction": ["breaker.mjs#tripBreaker", "respawn.mjs#rollbackAndPause", "state.mjs#pauseRun"],
    "human-only-recovery": ["recover.mjs#recoverBoundary", "recover.mjs#supersedeAffinity"],
    "structural-no-target": ["budget.mjs#settleTerminalCodexMakerCost", "initrun.mjs#initRun", "lease.mjs#advanceHandoffPhase", "lease.mjs#rollbackReservedEmit", "recover.mjs#recoverRun", "respawn.mjs#respawn"],
    "damage-repair": ["integrity.mjs#captureReconciledRootRecoverySnapshot", "integrity.mjs#captureReconciledRunSet", "integrity.mjs#captureReconciledRunSnapshot", "integrity.mjs#reconcileAnchoredPublicationLocked", "state.mjs#captureReconciledRootRecoverySnapshot", "state.mjs#captureReconciledRunSet", "state.mjs#captureReconciledRunSnapshot"],
    "acquire-chain": ["lease.mjs#acquireLease", "project-root-recovery.mjs#acquireRootRecovery", "project-root-recovery.mjs#rebindProjectRoot", "project-root-recovery.mjs#recoverRelocatedRoot", "recover.mjs#acquireRecovery"],
    "transitive": ["drive-headless.mjs#main", "headless-host.mjs#driveHeadless", "headless-host.mjs#driveHeadlessRun"],
    "treated-in-D2": ["budget.mjs#extendBudget"]
  },
  "add": [
    { "id": "activation-secret.mjs#activateStoredLease", "classification": "X", "reason": "enforcement-origin" },
    { "id": "headless-host.mjs#acquireHeadlessHostLock", "classification": "X", "reason": "damage-repair" },
    { "id": "lease.mjs#activateLease", "classification": "X", "reason": "enforcement-origin" },
    { "id": "lease.mjs#reapLease", "classification": "X", "reason": "enforcement-origin" },
    { "id": "preflight-receipt-journal.mjs#markCheckerImportUnconfirmed", "classification": "E4", "reason": "non-run-state-durable-write" },
    { "id": "review-import.mjs#locateCapturedImportedReviewArtifact", "classification": "E2", "reason": "no-run-state-write" },
    { "id": "review-import.mjs#verifyCapturedImportedReviewProof", "classification": "E2", "reason": "no-run-state-write" },
    { "id": "schema.mjs#CHECKER_PROCESS_PHASES", "classification": "E8", "reason": "non-callable-value" },
    { "id": "schema.mjs#CHECKER_PROCESS_REASON_CODES", "classification": "E8", "reason": "non-callable-value" },
    { "id": "schema.mjs#CHECKER_PROCESS_REASON_PHASES", "classification": "E8", "reason": "non-callable-value" },
    { "id": "schema.mjs#validCheckerProcessDiagnostic", "classification": "E2", "reason": "no-run-state-write" },
    { "id": "schema.mjs#validProcessStreamMetadata", "classification": "E2", "reason": "no-run-state-write" }
  ]
}
<!-- F26-LIVE-JSON-END -->
