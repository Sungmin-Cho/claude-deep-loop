import { validate } from './schema.mjs';
import { readStateForRootRecovery, withLock } from './state.mjs';
import {
  canonicalProjectRoot,
  classifyProjectRootBinding,
  projectRootDigest,
} from './project-root.mjs';
import { commitProjectRootRebindUnderLock, mutationIntentDigest, readLines,
  verifyRunSnapshot, withVerifiedMutationLock } from './integrity.mjs';

const ROOT_DIGEST = /^[0-9a-f]{64}$/;

function canonicalCandidate(candidateRoot) {
  try {
    return canonicalProjectRoot(candidateRoot);
  } catch (error) {
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate project root', { cause: error });
  }
}

function assertRecoveryState(loop, runId, { validateSchema = true } = {}) {
  if (!loop || typeof loop !== 'object' || loop.run_id !== runId) {
    throw new Error('STATE_INVALID: loop.run_id mismatch');
  }
  if (validateSchema) {
    const stateValidation = validate(loop);
    if (!stateValidation.ok) throw new Error(`STATE_INVALID: ${stateValidation.errors.join('; ')}`);
  }
  if (!loop.project || typeof loop.project !== 'object') throw new Error('STATE_INVALID: project missing');
  const lease = loop.session_chain?.lease;
  if (!lease || typeof lease.owner_run_id !== 'string' || lease.owner_run_id.length === 0
    || !Number.isSafeInteger(lease.generation) || lease.generation < 0) {
    throw new Error('STATE_INVALID: lease owner/generation missing');
  }
  return lease;
}

function diagnosis(candidateRoot, runId, loop) {
  const lease = assertRecoveryState(loop, runId);
  const binding = classifyProjectRootBinding(candidateRoot, loop.project.root);
  return {
    mismatch_class: binding.mismatch_class,
    rebind_allowed: binding.mismatch_class === 'unresolvable',
    stored_root_digest: projectRootDigest(loop.project.root),
    owner: lease.owner_run_id,
    generation: lease.generation,
  };
}

export function diagnoseProjectRoot(candidateRoot, runId) {
  const candidateCanonical = canonicalCandidate(candidateRoot);
  return withLock(candidateCanonical, runId, () => {
    const { data: loop } = readStateForRootRecovery(candidateCanonical, runId);
    if (!loop || typeof loop !== 'object' || loop.run_id !== runId) {
      throw new Error('RUN_SNAPSHOT_INVALID: run_id mismatch');
    }
    let verified;
    try {
      verified = verifyRunSnapshot(loop, readLines(candidateCanonical, runId));
    } catch (error) {
      throw new Error(`RUN_SNAPSHOT_INVALID: ${String(error?.message || error)}`,
        { cause: error });
    }
    if (!verified.ok) {
      throw new Error(`RUN_SNAPSHOT_INVALID: ${verified.errors.join('; ')}`);
    }
    return diagnosis(candidateCanonical, runId, loop);
  });
}

export function rebindProjectRoot(candidateRoot, runId, {
  actor,
  confirm,
  expectedStoredRootDigest,
  fence,
  now,
} = {}) {
  const lockedRoot = canonicalCandidate(candidateRoot);
  if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
    || !Number.isSafeInteger(fence.generation) || fence.generation < 1) {
    throw new Error('FENCE_REQUIRED: root rebind requires owner and generation');
  }
  const callerBinding = { owner: fence.owner, generation: fence.generation };
  const intentDigest = mutationIntentDigest('project-root-rebind', callerBinding, {
    actor, confirm: confirm === true, expected_stored_root_digest: expectedStoredRootDigest,
    candidate_root: lockedRoot, now: now ?? null,
  });
  return withVerifiedMutationLock(lockedRoot, runId, { callerBinding, intentDigest,
    fenceError: 'PROJECT_ROOT_RECOVERY_FENCED', allowUnboundRoot: true }, mutation => {
    if (mutation.recovered) {
      mutation.readVerifiedState();
      return { ok: true };
    }
    const candidateCanonical = canonicalCandidate(candidateRoot);
    if (candidateCanonical !== lockedRoot) {
      throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed');
    }

    const { data: loop, hash: baseStateHash } = readStateForRootRecovery(lockedRoot, runId);
    const lease = assertRecoveryState(loop, runId, { validateSchema: false });
    const binding = classifyProjectRootBinding(candidateCanonical, loop.project.root);
    if (binding.mismatch_class === 'fenced') {
      throw new Error('PROJECT_ROOT_FENCED: stored project root still resolves');
    }
    if (binding.mismatch_class !== 'unresolvable') {
      throw new Error('PROJECT_ROOT_REBIND_NOT_ALLOWED: project root already matches');
    }

    if (actor !== 'human') throw new Error('INVALID_ACTOR: root rebind requires actor human');
    if (confirm !== true) throw new Error('CONFIRM_REQUIRED: root rebind requires confirmation');
    if (!ROOT_DIGEST.test(expectedStoredRootDigest || '')
      || expectedStoredRootDigest !== projectRootDigest(loop.project.root)) {
      throw new Error('INVALID_STORED_ROOT_DIGEST: exact stored lexical root digest required');
    }
    if (lease.owner_run_id !== fence.owner || lease.generation !== fence.generation) {
      throw new Error('LEASE_FENCED: owner/generation mismatch');
    }

    const finalBinding = classifyProjectRootBinding(candidateCanonical, loop.project.root);
    if (finalBinding.mismatch_class === 'fenced') {
      throw new Error('PROJECT_ROOT_FENCED: stored project root still resolves');
    }
    if (finalBinding.mismatch_class !== 'unresolvable') {
      throw new Error('PROJECT_ROOT_REBIND_NOT_ALLOWED: project root already matches');
    }

    return commitProjectRootRebindUnderLock(lockedRoot, runId, loop, {
      oldRootDigest: expectedStoredRootDigest,
      newRoot: candidateCanonical,
      now,
      baseStateHash,
      callerBinding,
      intentDigest,
    });
  });
}
