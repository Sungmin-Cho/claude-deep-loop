import { validate } from './schema.mjs';
import {
  captureReconciledRootRecoverySnapshot,
  withReconciledRootRecoveryLock,
} from './state.mjs';
import {
  canonicalProjectRoot,
  classifyProjectRootBinding,
  projectRootDigest,
} from './project-root.mjs';
import { commitProjectRootRebindUnderLock } from './integrity.mjs';

const ROOT_DIGEST = /^[0-9a-f]{64}$/;

function canonicalCandidate(candidateRoot) {
  try {
    return canonicalProjectRoot(candidateRoot);
  } catch (error) {
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate project root', { cause: error });
  }
}

function assertRecoveryState(loop, runId) {
  if (!loop || typeof loop !== 'object' || loop.run_id !== runId) {
    throw new Error('STATE_INVALID: loop.run_id mismatch');
  }
  const stateValidation = validate(loop);
  if (!stateValidation.ok) throw new Error(`STATE_INVALID: ${stateValidation.errors.join('; ')}`);
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
  const { data: loop } = captureReconciledRootRecoverySnapshot(candidateCanonical, runId);
  return diagnosis(candidateCanonical, runId, loop);
}

export function rebindProjectRoot(candidateRoot, runId, {
  actor,
  confirm,
  expectedStoredRootDigest,
  fence,
  now,
} = {}) {
  const lockedRoot = canonicalCandidate(candidateRoot);
  return withReconciledRootRecoveryLock(lockedRoot, runId, (_guard, { data: loop }) => {
    const candidateCanonical = canonicalCandidate(candidateRoot);
    if (candidateCanonical !== lockedRoot) {
      throw new Error('PROJECT_ROOT_UNRESOLVABLE: candidate root identity changed');
    }

    const lease = assertRecoveryState(loop, runId);
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
    if (!fence || typeof fence.owner !== 'string' || fence.owner.length === 0
      || !Number.isSafeInteger(fence.generation) || fence.generation < 0) {
      throw new Error('FENCE_REQUIRED: root rebind requires owner and generation');
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
    });
  });
}
