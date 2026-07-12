import { realpathSync } from 'node:fs';
import { contentHash } from './envelope.mjs';

function realpathOf(deps = {}) {
  const realpath = deps.realpathSync || realpathSync.native || realpathSync;
  if (typeof realpath !== 'function') throw new Error('PROJECT_ROOT_UNRESOLVABLE: realpath unavailable');
  return realpath;
}

export function canonicalProjectRoot(value, deps = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('PROJECT_ROOT_UNRESOLVABLE: project root must be a non-empty string');
  }
  try {
    return realpathOf(deps)(value);
  } catch (error) {
    if (String(error?.message || error).startsWith('PROJECT_ROOT_UNRESOLVABLE:')) throw error;
    throw new Error(`PROJECT_ROOT_UNRESOLVABLE: ${value}`, { cause: error });
  }
}

export function projectRootDigest(storedRoot) {
  return contentHash(typeof storedRoot === 'string' ? storedRoot : '');
}

export function classifyProjectRootBinding(candidateRoot, storedRoot, deps = {}) {
  const candidateCanonical = canonicalProjectRoot(candidateRoot, deps);
  let storedCanonical;
  try {
    storedCanonical = canonicalProjectRoot(storedRoot, deps);
  } catch (error) {
    if (!String(error?.message || error).startsWith('PROJECT_ROOT_UNRESOLVABLE:')) throw error;
    return {
      ok: false,
      mismatch_class: 'unresolvable',
      candidate_root: candidateCanonical,
      stored_root: null,
    };
  }
  if (candidateCanonical === storedCanonical) {
    return {
      ok: true,
      mismatch_class: 'match',
      candidate_root: candidateCanonical,
      stored_root: storedCanonical,
    };
  }
  return {
    ok: false,
    mismatch_class: 'fenced',
    candidate_root: candidateCanonical,
    stored_root: storedCanonical,
  };
}

export function assertProjectRootBinding(candidateRoot, loop, deps = {}) {
  const storedRoot = loop?.project?.root;
  const result = classifyProjectRootBinding(candidateRoot, storedRoot, deps);
  if (result.ok) return result;
  if (result.mismatch_class === 'fenced') {
    throw new Error(`PROJECT_ROOT_FENCED: candidate ${result.candidate_root} != stored ${result.stored_root}`);
  }
  throw new Error(`PROJECT_ROOT_UNRESOLVABLE: stored project root ${String(storedRoot)}`);
}
